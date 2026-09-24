import { BatchRecord } from '../types';

export const FALLBACK_DEFAULT_BATCH_KG = 250;
export const FALLBACK_TIME_PER_KG = 0.02;

export interface SkuBatchDefaults {
  default_batch_kg: number;
  time_per_kg: number;
}

export interface BatchSkuDefaultsBuildResult {
  bySku: Record<string, SkuBatchDefaults>;
  conflicts: string[];
}

const toPositiveNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
};

const getRecordTimestamp = (record: BatchRecord): number => {
  const updatedTs = new Date(record.updatedAt || '').getTime();
  if (Number.isFinite(updatedTs) && updatedTs > 0) return updatedTs;
  const createdTs = new Date(record.createdAt || '').getTime();
  if (Number.isFinite(createdTs) && createdTs > 0) return createdTs;
  return 0;
};

/**
 * Resolves per-SKU defaults from batches_master.
 * Conflict rule: latest non-empty value per SKU is canonical.
 */
export const buildBatchSkuDefaults = (
  batchRecords: BatchRecord[],
  defaultBatchKgFallback = FALLBACK_DEFAULT_BATCH_KG,
  timePerKgFallback = FALLBACK_TIME_PER_KG
): BatchSkuDefaultsBuildResult => {
  const bySku: Record<string, SkuBatchDefaults> = {};
  const latestDefaultBatchTs: Record<string, number> = {};
  const latestTimePerKgTs: Record<string, number> = {};
  const defaultBatchValues = new Map<string, Set<number>>();
  const timePerKgValues = new Map<string, Set<number>>();

  batchRecords.forEach(record => {
    const sku = String(record.productSku || '').trim();
    if (!sku) return;

    const ts = getRecordTimestamp(record);
    const defaultBatchKg = toPositiveNumber((record as any).default_batch_kg);
    const timePerKg = toPositiveNumber((record as any).time_per_kg);

    if (!bySku[sku]) {
      bySku[sku] = {
        default_batch_kg: defaultBatchKgFallback,
        time_per_kg: timePerKgFallback
      };
      latestDefaultBatchTs[sku] = -1;
      latestTimePerKgTs[sku] = -1;
      defaultBatchValues.set(sku, new Set<number>());
      timePerKgValues.set(sku, new Set<number>());
    }

    if (defaultBatchKg !== null) {
      defaultBatchValues.get(sku)!.add(defaultBatchKg);
      if (ts >= latestDefaultBatchTs[sku]) {
        bySku[sku].default_batch_kg = defaultBatchKg;
        latestDefaultBatchTs[sku] = ts;
      }
    }

    if (timePerKg !== null) {
      timePerKgValues.get(sku)!.add(timePerKg);
      if (ts >= latestTimePerKgTs[sku]) {
        bySku[sku].time_per_kg = timePerKg;
        latestTimePerKgTs[sku] = ts;
      }
    }
  });

  const conflicts: string[] = [];
  Object.keys(bySku).forEach(sku => {
    const batchSet = defaultBatchValues.get(sku);
    const timeSet = timePerKgValues.get(sku);
    if (batchSet && batchSet.size > 1) {
      conflicts.push(`${sku}: default_batch_kg has ${batchSet.size} values (${Array.from(batchSet).join(', ')})`);
    }
    if (timeSet && timeSet.size > 1) {
      conflicts.push(`${sku}: time_per_kg has ${timeSet.size} values (${Array.from(timeSet).join(', ')})`);
    }
  });

  return { bySku, conflicts };
};

