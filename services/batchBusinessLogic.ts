

import { 
  Component,
  BatchRecord, 
  BatchStageEvent, 
  InventoryTransaction, 
  BatchCostPosting, 
  BatchStatus,
  RawComponentLot
} from '../types';
import { computeLedgerStockLevels } from './ledgerStock';
import { resolveLedgerUnitCost } from './ledgerPricing';
import { syncBaseData } from './sheetsApi';

type ParsedBatchType = 'STANDARD' | 'DISPENSING';

export interface ParsedBatchId {
  type: ParsedBatchType | null;
  skuId: string;
  printedBatchNumber?: string;
  isLegacy: boolean;
}

const DISPENSING_PREFIX = 'DSP__';
const dispensingSequenceCache = new Map<string, number>();
const bottleSequenceCache = new Map<string, number>();

const normalizeBatchToken = (value: unknown): string => String(value ?? '').trim();

const formatDateAsYYYYMMDD = (value: Date): string => {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
};

export const buildStandardBatchId = (skuId: string, printedBatchNumber: string): string =>
  `${normalizeBatchToken(skuId)}::${normalizeBatchToken(printedBatchNumber)}`;

export const parseBatchId = (batchId: string): ParsedBatchId => {
  const normalized = normalizeBatchToken(batchId);
  if (!normalized) return { type: null, skuId: '', isLegacy: true };

  if (normalized.startsWith(DISPENSING_PREFIX)) {
    const match = normalized.match(/^DSP__(.+?)__(\d{8})__(\d{2})$/);
    return {
      type: 'DISPENSING',
      skuId: match?.[1] || '',
      isLegacy: false
    };
  }

  const separatorIndex = normalized.indexOf('::');
  if (separatorIndex > 0) {
    return {
      type: 'STANDARD',
      skuId: normalized.slice(0, separatorIndex),
      printedBatchNumber: normalized.slice(separatorIndex + 2),
      isLegacy: false
    };
  }

  return { type: null, skuId: '', isLegacy: true };
};

const extractDispensingSequence = (batchId: string, prefix: string): number => {
  if (!batchId.startsWith(prefix)) return 0;
  const suffix = batchId.slice(prefix.length);
  if (!/^\d{2}$/.test(suffix)) return 0;
  return Number(suffix) || 0;
};

export const generateDispensingBatchId = async (
  skuId: string,
  productionDate: Date
): Promise<string> => {
  const normalizedSku = normalizeBatchToken(skuId);
  if (!normalizedSku) throw new Error('SKU is required for dispensing batch generation.');

  const dateToken = formatDateAsYYYYMMDD(productionDate);
  const prefix = `${DISPENSING_PREFIX}${normalizedSku}__${dateToken}__`;

  if (dispensingSequenceCache.has(prefix)) {
    const next = (dispensingSequenceCache.get(prefix) || 0) + 1;
    dispensingSequenceCache.set(prefix, next);
    return `${prefix}${String(next).padStart(2, '0')}`;
  }

  const baseData = await syncBaseData();
  const rows = Array.isArray((baseData as any)?.batches) ? (baseData as any).batches : [];

  let maxSequence = 0;
  rows.forEach((row: any) => {
    const candidate = normalizeBatchToken(row?.batch_id ?? row?.id ?? row?.batch_number);
    const sequence = extractDispensingSequence(candidate, prefix);
    if (sequence > maxSequence) maxSequence = sequence;
  });

  const next = maxSequence + 1;
  dispensingSequenceCache.set(prefix, next);
  return `${prefix}${String(next).padStart(2, '0')}`;
};

const extractTrailingSequence = (batchId: string, prefix: string): number => {
  if (!batchId.startsWith(prefix)) return 0;
  const suffix = batchId.slice(prefix.length);
  if (!/^\d{2}$/.test(suffix)) return 0;
  return Number(suffix) || 0;
};

export const generateBottleBatchId = async (
  skuId: string,
  productionDate: Date
): Promise<string> => {
  const normalizedSku = normalizeBatchToken(skuId);
  if (!normalizedSku) throw new Error('SKU is required for bottle batch generation.');

  const dateToken = formatDateAsYYYYMMDD(productionDate);
  const prefix = `${normalizedSku}::${dateToken}__`;

  if (bottleSequenceCache.has(prefix)) {
    const next = (bottleSequenceCache.get(prefix) || 0) + 1;
    bottleSequenceCache.set(prefix, next);
    return `${prefix}${String(next).padStart(2, '0')}`;
  }

  const baseData = await syncBaseData();
  const rows = Array.isArray((baseData as any)?.batches) ? (baseData as any).batches : [];

  let maxSequence = 0;
  rows.forEach((row: any) => {
    const candidate = normalizeBatchToken(row?.batch_id ?? row?.id ?? row?.batch_number);
    const sequence = extractTrailingSequence(candidate, prefix);
    if (sequence > maxSequence) maxSequence = sequence;
  });

  const next = maxSequence + 1;
  bottleSequenceCache.set(prefix, next);
  return `${prefix}${String(next).padStart(2, '0')}`;
};

/**
 * Derives current batch status from the event timeline.
 * Preference: Most recent event > Master Record Status > 'preparation'
 */
export const deriveBatchStatus = (
  batch: BatchRecord, 
  events: BatchStageEvent[],
  transactions: InventoryTransaction[]
): BatchStatus | 'stock' => {
  const batchEvents = events
    .filter(e => e.batch_id === batch.id)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  let status: BatchStatus = batch.status || 'preparation';
  
  if (batchEvents.length > 0) {
    status = batchEvents[0].status_after;
  }

  // If released, check if it's still "In Stock"
  if (status === 'Released') {
    const stock = getBatchStockLevel(batch.id, transactions);
    if (stock > 0.001) return 'stock';
  }

  return status;
};

/**
 * Calculates current on-hand stock for a specific finished good batch 
 * by scanning the inventory ledger.
 */
export const getBatchStockLevel = (
  batchId: string, 
  transactions: InventoryTransaction[]
): number => {
  const sampleTx = transactions.find(tx => tx.category === 'PRODUCT' && tx.batchNumber === batchId && tx.itemId);
  if (!sampleTx) return 0;
  const levels = computeLedgerStockLevels(transactions.filter(tx => tx.category === 'PRODUCT'));
  return Number(levels[sampleTx.itemId]?.byBatch?.[batchId]?.onHand || 0);
};

/**
 * Aggregates all material costs (from ledger) and non-material costs (postings)
 * to find the total unit cost based on the engineering formula:
 * (Materials + Labour + Utilities + PPE + Water + Other) / Actual Yield
 */
export const calculateBatchUnitCost = (
  batch: BatchRecord,
  transactions: InventoryTransaction[],
  overheadPostings: BatchCostPosting[],
  rawComponentLots: RawComponentLot[] = [],
  itemMaster: Component[] = []
): number => {
  // 1. Raw Material Value (Tx where this batch was the reason for component usage)
  const materialCost = transactions
    .filter(tx => tx.reason?.includes(`Batch ${batch.id}`) && tx.category === 'COMPONENT')
    .reduce((acc, tx) => acc + (Number(tx.quantity) * resolveLedgerUnitCost(tx, { rawComponentLots, itemMaster })), 0);

  // 2. Overhead Costs (Labour, Energy, etc)
  const overheadCost = overheadPostings
    .filter(p => p.batch_id === batch.id)
    .reduce((acc, p) => acc + Number(p.amount), 0);

  const totalCost = materialCost + overheadCost;
  const yieldQty = batch.actualYield || batch.plannedQuantity || 1;

  return totalCost / yieldQty;
};
