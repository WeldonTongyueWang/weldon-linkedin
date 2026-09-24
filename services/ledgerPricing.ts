import { Component, InventoryTransaction, ProductBatch, RawComponentLot } from '../types';
import { resolveLedgerEventTime } from './ledgerTime';

interface LedgerPricingContext {
  rawComponentLots?: RawComponentLot[];
  productBatches?: ProductBatch[];
  itemMaster?: Component[];
}

const toNumber = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

const normalizeKey = (value: unknown): string => String(value ?? '').trim().toLowerCase();
const warnCache = new Set<string>();
const isDev = (): boolean =>
  typeof import.meta !== 'undefined' && Boolean((import.meta as any).env?.DEV);

const warnOnce = (key: string, message: string): void => {
  if (!isDev() || warnCache.has(key)) return;
  warnCache.add(key);
  console.warn(message);
};

const resolveItemMasterCost = (
  tx: InventoryTransaction,
  itemMaster: Component[]
): number | undefined => {
  const itemId = normalizeKey(tx.itemId);
  if (!itemId) return undefined;
  const item = itemMaster.find(row => normalizeKey((row as any).component_id) === itemId);
  if (!item) return undefined;

  const candidateKeys = [
    'unitCost',
    'unit_cost',
    'cost_per_unit',
    'material_cost',
    'cost_price'
  ];

  for (const key of candidateKeys) {
    const resolved = toNumber((item as any)[key]);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
};

const findRawLotUnitCost = (
  tx: InventoryTransaction,
  rawComponentLots: RawComponentLot[]
): number | undefined => {
  const batch = normalizeKey(tx.batchNumber);
  const itemId = normalizeKey(tx.itemId);
  if (!batch || !itemId) return undefined;

  const match = rawComponentLots.find(lot =>
    normalizeKey(lot.qc_number) === batch && normalizeKey(lot.itemId) === itemId
  );

  return toNumber(match?.unit_price);
};

const findProductBatchUnitCost = (
  tx: InventoryTransaction,
  productBatches: ProductBatch[]
): number | undefined => {
  const batch = normalizeKey(tx.batchNumber);
  const itemId = normalizeKey(tx.itemId);
  if (!batch || !itemId) return undefined;

  const byId = productBatches.find(record =>
    normalizeKey(record.id) === batch && normalizeKey(record.sku_id) === itemId
  );
  if (byId) return toNumber(byId.unit_cost);

  const byBatchNumber = productBatches.find(record =>
    normalizeKey(record.batch_number) === batch && normalizeKey(record.sku_id) === itemId
  );
  if (byBatchNumber) return toNumber(byBatchNumber.unit_cost);

  const byLegacyBatchId = productBatches.find(record =>
    normalizeKey((record as any).batch_id) === batch && normalizeKey(record.sku_id) === itemId
  );
  if (byLegacyBatchId) {
    warnOnce(
      `legacy-batch-id:${itemId}:${batch}`,
      `[Ledger Batch Lookup] Using legacy batches_master.batch_id fallback for sku '${tx.itemId}' and batch '${tx.batchNumber}'.`
    );
    return toNumber(byLegacyBatchId.unit_cost);
  }

  return undefined;
};

// Canonical valuation/costing price source. Never use unitSalePrice in stock valuation.
export const resolveLedgerUnitCost = (
  tx: InventoryTransaction,
  context: LedgerPricingContext = {}
): number => {
  if (tx.category === 'COMPONENT') {
    // Canonical source: raw_component_lot.unit_price
    const rawLotCost = findRawLotUnitCost(tx, context.rawComponentLots || []);
    if (rawLotCost !== undefined) return rawLotCost;
    return 0;
  }

  if (tx.category === 'PRODUCT') {
    // Canonical source: batches_master.unitProductionCost
    const batchCost = findProductBatchUnitCost(tx, context.productBatches || []);
    if (batchCost !== undefined) return batchCost;
    return 0;
  }

  return 0;
};

// Canonical revenue price source. Never infer revenue from unitCost.
export const resolveLedgerUnitSalePrice = (tx: InventoryTransaction): number => {
  const explicit = toNumber(tx.unitSalePrice);
  if (explicit !== undefined) return explicit;
  return 0;
};

export const buildLatestComponentUnitCostMap = (
  transactions: InventoryTransaction[],
  rawComponentLots: RawComponentLot[] = [],
  itemMaster: Component[] = []
): Record<string, number> => {
  const costs: Record<string, number> = {};
  const sorted = [...transactions].sort(
    (a, b) => new Date(resolveLedgerEventTime(a)).getTime() - new Date(resolveLedgerEventTime(b)).getTime()
  );

  sorted.forEach(tx => {
    if (tx.type !== 'IN' || tx.category !== 'COMPONENT') return;
    const cost = resolveLedgerUnitCost(tx, { rawComponentLots, itemMaster });
    if (cost > 0) costs[tx.itemId] = cost;
  });

  return costs;
};
