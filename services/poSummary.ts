import { InventoryTransaction, Product, ProductBatch, RawComponentLot } from '../types';
import { formatFinishedProductInventoryLabel } from '../utils/finishedProductLabels';

export type PoLineKind = 'paid' | 'sample';
export type PoOrderType = 'Paid' | 'Sample' | 'Mixed';

export interface PoSummaryLine {
  id: string;
  itemId: string;
  itemName: string;
  quantity: number;
  unit: string;
  lineKind: PoLineKind;
  unitCost: number;
  unitSalePrice: number;
  lineCost: number;
  lineRevenue: number;
  source: InventoryTransaction;
}

export interface PoSummaryRow {
  createdAt: string;
  reference: string;
  salesRep: string;
  orderType: PoOrderType;
  totalCost: number;
  totalRevenue: number;
  profit: number;
  profitMargin: number | null;
  warnings: string[];
  lines: PoSummaryLine[];
}

export interface PoSummaryDashboard {
  sampleCostTotal: number;
  paidRevenueTotal: number;
  overallProfit: number;
  revenueToSampleCost: number | null;
  sampleCostPctOfTotalCost: number | null;
  profitOverTotalCost: number | null;
  paidCostTotal: number;
  totalCost: number;
}

export interface PoSummaryModel {
  rows: PoSummaryRow[];
  dashboard: PoSummaryDashboard;
}

const toNumber = (value: unknown): number => {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const normalize = (value: unknown): string => String(value ?? '').trim().toLowerCase();

const resolveLineKind = (tx: InventoryTransaction): PoLineKind | null => {
  const reason = normalize(tx.reason);
  if (reason === 'dispatch: paid') return 'paid';
  if (reason === 'dispatch: sample') return 'sample';
  if (reason === 'dispatch: internal') return 'sample';
  if (reason === 'dispatch: others') return 'sample';

  return null;
};

const resolveReference = (tx: InventoryTransaction): string => {
  const ref = String(tx.reference || '').trim();
  return ref || 'UNREFERENCED';
};

const resolveLedgerCreatedAt = (tx: InventoryTransaction): string => {
  return String(tx.createdAt || '').trim();
};

const resolveLedgerSalesRep = (tx: InventoryTransaction): string => {
  const value = (tx as any).SalesRep ?? (tx as any).salesRep ?? (tx as any).sales_rep ?? '';
  return String(value || '').trim();
};

const uniqueValueMapByItemId = (
  rows: InventoryTransaction[],
  resolver: (tx: InventoryTransaction) => number
): Record<string, number> => {
  const valuesByItem: Record<string, Set<number>> = {};
  rows.forEach(tx => {
    const itemId = String(tx.itemId || '').trim();
    if (!itemId) return;
    const n = resolver(tx);
    if (!Number.isFinite(n) || n <= 0) return;
    if (!valuesByItem[itemId]) valuesByItem[itemId] = new Set<number>();
    valuesByItem[itemId].add(n);
  });

  const map: Record<string, number> = {};
  Object.entries(valuesByItem).forEach(([itemId, set]) => {
    if (set.size === 1) map[itemId] = Array.from(set)[0];
  });
  return map;
};

const resolveBatchMasterUnitCost = (
  tx: InventoryTransaction,
  productBatches: ProductBatch[]
): number => {
  const sku = normalize(tx.itemId);
  const batch = normalize(tx.batchNumber);
  if (!sku || !batch) return 0;

  const match = productBatches.find(row => {
    const rowSku = normalize(row.sku_id);
    if (rowSku !== sku) return false;

    const byBatchNumber = normalize(row.batch_number) === batch;
    const byId = normalize(row.id) === batch;
    const byLegacyBatchId = normalize((row as any).batch_id) === batch;
    return byBatchNumber || byId || byLegacyBatchId;
  });

  return toNumber(match?.unit_cost);
};

const matchesSystemId = (ledgerItemId: string, lotItemId: string): boolean => {
  const a = normalize(ledgerItemId);
  const b = normalize(lotItemId);
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}-`) || b.startsWith(`${a}-`);
};

const resolveRawLotUnitCost = (
  tx: InventoryTransaction,
  rawComponentLots: RawComponentLot[]
): number => {
  const batch = normalize(tx.batchNumber);
  const itemId = String(tx.itemId || '').trim();
  if (!batch || !itemId) return 0;

  const match = rawComponentLots.find(lot =>
    normalize(lot.qc_number) === batch && matchesSystemId(itemId, lot.itemId)
  );

  return toNumber(match?.unit_price);
};

const resolveLedgerUnitSalePrice = (tx: InventoryTransaction): number => {
  return toNumber(tx.unitSalePrice);
};

export const buildPoSummaryModel = (
  transactions: InventoryTransaction[],
  products: Product[] = [],
  productBatches: ProductBatch[] = [],
  rawComponentLots: RawComponentLot[] = []
): PoSummaryModel => {
  const productNameMap: Record<string, string> = {};
  products.forEach(p => {
    productNameMap[p.sku_id] = formatFinishedProductInventoryLabel(p);
  });

  const filtered = transactions.filter(tx => {
    if (normalize(tx.type) !== 'out') return false;
    if (normalize(tx.category) !== 'product') return false;
    if (String(tx.reference || '').trim().length === 0) return false;
    return resolveLineKind(tx) !== null;
  });

  // ID-based fallback: only used when a product itemId has exactly one unique batch-master cost.
  const unitCostByUniqueItemId = uniqueValueMapByItemId(filtered, tx => (
    resolveBatchMasterUnitCost(tx, productBatches) || resolveRawLotUnitCost(tx, rawComponentLots)
  ));
  const grouped = new Map<string, PoSummaryLine[]>();

  filtered.forEach(tx => {
    const lineKind = resolveLineKind(tx);
    if (!lineKind) return;

    const quantity = toNumber(tx.quantity);
    const itemId = String(tx.itemId || '').trim();
    const unitCost =
      resolveBatchMasterUnitCost(tx, productBatches) ||
      resolveRawLotUnitCost(tx, rawComponentLots) ||
      unitCostByUniqueItemId[itemId] ||
      0;
    const unitSalePrice = resolveLedgerUnitSalePrice(tx);
    const lineCost = unitCost * quantity;
    const lineRevenue = lineKind === 'paid' ? unitSalePrice * quantity : 0;

    const line: PoSummaryLine = {
      id: tx.id,
      itemId: tx.itemId,
      itemName: productNameMap[tx.itemId] || tx.itemName || tx.itemId,
      quantity,
      unit: tx.unit || 'kg',
      lineKind,
      unitCost,
      unitSalePrice,
      lineCost,
      lineRevenue,
      source: tx,
    };

    const ref = resolveReference(tx);
    const existing = grouped.get(ref) || [];
    existing.push(line);
    grouped.set(ref, existing);
  });

  const rows: PoSummaryRow[] = Array.from(grouped.entries()).map(([reference, lines]) => {
    let totalCost = 0;
    let totalRevenue = 0;
    let paidCount = 0;
    let sampleCount = 0;
    let missingUnitCost = 0;
    let missingUnitSalePrice = 0;
    const salesRepSet = new Set<string>();
    let createdAt = '';
    let createdAtMs = Number.POSITIVE_INFINITY;

    lines.forEach(line => {
      totalCost += line.lineCost;
      totalRevenue += line.lineRevenue;
      if (line.lineKind === 'paid') paidCount += 1;
      if (line.lineKind === 'sample') sampleCount += 1;
      if (line.unitCost <= 0) missingUnitCost += 1;
      if (line.lineKind === 'paid' && line.unitSalePrice <= 0) missingUnitSalePrice += 1;
      const salesRep = resolveLedgerSalesRep(line.source);
      if (salesRep) salesRepSet.add(salesRep);
      const rowCreatedAt = resolveLedgerCreatedAt(line.source);
      const t = rowCreatedAt ? new Date(rowCreatedAt).getTime() : Number.NaN;
      if (Number.isFinite(t) && t < createdAtMs) {
        createdAtMs = t;
        createdAt = rowCreatedAt;
      }
    });

    const profit = totalRevenue - totalCost;
    const profitMargin = totalRevenue > 0 ? (profit / totalRevenue) * 100 : null;
    const orderType: PoOrderType =
      paidCount > 0 && sampleCount > 0 ? 'Mixed' : paidCount > 0 ? 'Paid' : 'Sample';

    const warnings: string[] = [];
    if (orderType === 'Mixed') warnings.push('Mixed PO');
    if (missingUnitCost > 0) warnings.push(`${missingUnitCost} line(s) missing unit cost`);
    if (missingUnitSalePrice > 0) warnings.push(`${missingUnitSalePrice} paid line(s) missing sale price`);

    return {
      createdAt,
      reference,
      salesRep: salesRepSet.size === 0 ? '—' : salesRepSet.size === 1 ? Array.from(salesRepSet)[0] : 'Multiple',
      orderType,
      totalCost,
      totalRevenue,
      profit,
      profitMargin,
      warnings,
      lines,
    };
  });

  rows.sort((a, b) => a.reference.localeCompare(b.reference));

  let sampleCostTotal = 0;
  let paidRevenueTotal = 0;
  let paidCostTotal = 0;

  rows.forEach(row => {
    row.lines.forEach(line => {
      if (line.lineKind === 'sample') sampleCostTotal += line.lineCost;
      if (line.lineKind === 'paid') {
        paidRevenueTotal += line.lineRevenue;
        paidCostTotal += line.lineCost;
      }
    });
  });

  const totalCost = paidCostTotal + sampleCostTotal;
  const overallProfit = paidRevenueTotal - totalCost;

  return {
    rows,
    dashboard: {
      sampleCostTotal,
      paidRevenueTotal,
      overallProfit,
      revenueToSampleCost: sampleCostTotal > 0 ? paidRevenueTotal / sampleCostTotal : null,
      sampleCostPctOfTotalCost: totalCost > 0 ? (sampleCostTotal / totalCost) * 100 : null,
      profitOverTotalCost: totalCost > 0 ? overallProfit / totalCost : null,
      paidCostTotal,
      totalCost,
    },
  };
};
