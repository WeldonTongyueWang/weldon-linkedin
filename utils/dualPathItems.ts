import { InventoryTransaction } from '../types';
import { resolveLedgerEventTime } from '../services/ledgerTime';

export const DUAL_PATH_SYSTEM_IDS = ['DPS-003SCP', 'DPS-004FNL'] as const;
export const DUAL_PATH_FORMAT_KEYWORDS = ['single sachet'] as const;
export const DUAL_PATH_DUPLICATE_WINDOW_MS = 30 * 60 * 1000;

const QTY_EPSILON = 0.000001;

const normalizeUpper = (value: unknown): string => String(value || '').trim().toUpperCase();
const normalizeLower = (value: unknown): string => String(value || '').trim().toLowerCase();

export const isDualPathSystemId = (itemId: unknown): boolean => {
  const normalized = normalizeUpper(itemId);
  if (!normalized) return false;
  return DUAL_PATH_SYSTEM_IDS.some((systemId) => normalized === systemId || normalized.startsWith(`${systemId}-`));
};

export const isDualPathFormat = (format: unknown): boolean => {
  const normalized = normalizeLower(format);
  if (!normalized) return false;
  return DUAL_PATH_FORMAT_KEYWORDS.some((keyword) => normalized.includes(keyword));
};

export const isDualPathItem = (itemId: unknown, format?: unknown): boolean =>
  isDualPathSystemId(itemId) || isDualPathFormat(format);

interface DualPathDuplicateLookupInput {
  transactions: InventoryTransaction[];
  itemId: string;
  batchNumber: string;
  quantity: number;
  eventTimeMs?: number;
  windowMs?: number;
}

export const findDualPathDuplicateEvent = ({
  transactions,
  itemId,
  batchNumber,
  quantity,
  eventTimeMs = Date.now(),
  windowMs = DUAL_PATH_DUPLICATE_WINDOW_MS
}: DualPathDuplicateLookupInput): InventoryTransaction | null => {
  const normalizedItemId = normalizeUpper(itemId);
  const normalizedBatch = normalizeUpper(batchNumber);
  if (!normalizedItemId || !normalizedBatch || !Number.isFinite(quantity) || quantity <= 0) return null;

  for (const tx of transactions) {
    if (tx.type !== 'OUT') continue;
    if (normalizeUpper(tx.itemId) !== normalizedItemId) continue;
    if (normalizeUpper(tx.batchNumber) !== normalizedBatch) continue;
    if (Math.abs(Number(tx.quantity || 0) - quantity) > QTY_EPSILON) continue;

    const txEvent = resolveLedgerEventTime(tx);
    const txTimeMs = txEvent ? new Date(txEvent).getTime() : NaN;
    if (!Number.isFinite(txTimeMs)) continue;
    if (Math.abs(eventTimeMs - txTimeMs) > windowMs) continue;

    return tx;
  }

  return null;
};
