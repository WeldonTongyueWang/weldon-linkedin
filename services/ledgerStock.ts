import { InventoryTransaction, RawComponentLot, ProductBatch } from '../types';

export const UNBATCHED_KEY = 'No Batch';
const KNOWN_LOCATIONS = ['Riverside', 'Hilltop'] as const;
const FLOAT_EPSILON = 0.000001;

export interface LedgerQuantityState {
  onHand: number;
  available: number;
}

export interface LedgerStockPosition {
  totalOnHand: number;
  totalAvailable: number;
  byLocation: Record<string, LedgerQuantityState>;
  byBatch: Record<string, LedgerQuantityState>;
  byBatchLocation: Record<string, Record<string, LedgerQuantityState>>;
  // Backward compatibility fields (legacy callers).
  total: number;
  locations: Record<string, number>;
}

const normalizeText = (val: unknown): string => {
  if (val === undefined || val === null) return '';
  return String(val).trim();
};

const normalizeStatus = (val: unknown): string => normalizeText(val).toLowerCase();

const toNearZero = (value: number): number => (Math.abs(value) < FLOAT_EPSILON ? 0 : value);

const makeQuantityState = (): LedgerQuantityState => ({ onHand: 0, available: 0 });

const ensureLocationState = (target: Record<string, LedgerQuantityState>, location: string) => {
  if (!target[location]) target[location] = makeQuantityState();
};

const ensureBatchLocationState = (
  target: Record<string, Record<string, LedgerQuantityState>>,
  batch: string,
  location: string
) => {
  if (!target[batch]) target[batch] = {};
  ensureLocationState(target[batch], location);
};

const isBlockedReason = (reason: unknown): boolean => {
  const text = normalizeText(reason).toLowerCase();
  if (!text) return false;
  return (
    text.includes('reservation') ||
    text.includes('quarantine') ||
    text.includes('blocked') ||
    text.includes('on hold')
  );
};

const isRejectedStatus = (status?: string): boolean => {
  if (!status) return false;
  return status === 'rejected' || status === 'qc_rejected';
};

const createInitialByLocation = (allLocations: Set<string>): Record<string, LedgerQuantityState> => {
  const map: Record<string, LedgerQuantityState> = {};
  allLocations.forEach(location => {
    map[location] = makeQuantityState();
  });
  return map;
};

export const assertLedgerStockSnapshot = (
  levels: Record<string, LedgerStockPosition>,
  tag = 'stock-snapshot'
) => {
  const isDev = typeof import.meta !== 'undefined' && Boolean((import.meta as any).env?.DEV);
  if (!isDev) return;

  const issues: string[] = [];
  Object.entries(levels).forEach(([itemId, position]) => {
    const byLocation = Object.values(position.byLocation);
    const sumOnHand = byLocation.reduce((sum, loc) => sum + Number(loc.onHand || 0), 0);
    const sumAvailable = byLocation.reduce((sum, loc) => sum + Number(loc.available || 0), 0);

    if (Math.abs(sumOnHand - position.totalOnHand) > FLOAT_EPSILON) {
      issues.push(`${itemId}: onHand mismatch (${sumOnHand} vs ${position.totalOnHand})`);
    }
    if (Math.abs(sumAvailable - position.totalAvailable) > FLOAT_EPSILON) {
      issues.push(`${itemId}: available mismatch (${sumAvailable} vs ${position.totalAvailable})`);
    }
    if (position.totalAvailable - position.totalOnHand > FLOAT_EPSILON) {
      issues.push(`${itemId}: available exceeds onHand (${position.totalAvailable} > ${position.totalOnHand})`);
    }
  });

  if (issues.length > 0) {
    console.warn(`[LedgerStock assertion failed: ${tag}]`, issues);
  }
};

/**
 * Single source inventory truth from inventory_ledger:
 * - On-hand = physically present by item/location after all IN/OUT movements.
 * - Available = on-hand minus blocked/reserved holds.
 * - Excludes rejected batches/lots from both.
 */
export const computeLedgerStockLevels = (
  transactions: InventoryTransaction[],
  rawComponentLots: RawComponentLot[] = [],
  productBatches: ProductBatch[] = []
): Record<string, LedgerStockPosition> => {
  const levels: Record<string, LedgerStockPosition> = {};

  const compStatus = new Map<string, string>();
  rawComponentLots.forEach(lot => compStatus.set(normalizeText(lot.qc_number), normalizeStatus(lot.qcStatus)));

  const prodStatus = new Map<string, string>();
  productBatches.forEach(batch => prodStatus.set(normalizeText(batch.batch_number), normalizeStatus(batch.status)));

  const allLocations = new Set<string>(KNOWN_LOCATIONS);
  transactions.forEach(tx => {
    const location = normalizeText(tx.location);
    if (location) allLocations.add(location);
  });
  rawComponentLots.forEach(lot => {
    const location = normalizeText(lot.location);
    if (location) allLocations.add(location);
  });
  productBatches.forEach(batch => {
    const location = normalizeText(batch.location);
    if (location) allLocations.add(location);
  });

  transactions.forEach(tx => {
    const itemId = normalizeText(tx.itemId);
    if (!itemId) return;

    const batchRaw = normalizeText(tx.batchNumber);
    const batch = batchRaw || UNBATCHED_KEY;
    if (batchRaw) {
      const status = tx.category === 'COMPONENT' ? compStatus.get(batchRaw) : prodStatus.get(batchRaw);
      if (isRejectedStatus(status)) return;
    }

    if (!levels[itemId]) {
      levels[itemId] = {
        totalOnHand: 0,
        totalAvailable: 0,
        byLocation: createInitialByLocation(allLocations),
        byBatch: {},
        byBatchLocation: {},
        total: 0,
        locations: {}
      };
    }

    const qty = Number(tx.quantity) || 0;
    const blocked = isBlockedReason(tx.reason);
    let onHandDelta = 0;
    let availableDelta = 0;

    if (tx.type === 'IN') {
      onHandDelta = qty;
      availableDelta = blocked ? 0 : qty;
    } else {
      // Requested behavior: blocked OUT reasons also reduce on-hand.
      onHandDelta = -qty;
      availableDelta = -qty;
    }

    const position = levels[itemId];
    position.totalOnHand += onHandDelta;
    position.totalAvailable += availableDelta;

    const locationKey = normalizeText(tx.location) || 'UNSPECIFIED';
    ensureLocationState(position.byLocation, locationKey);
    position.byLocation[locationKey].onHand += onHandDelta;
    position.byLocation[locationKey].available += availableDelta;

    if (!position.byBatch[batch]) position.byBatch[batch] = makeQuantityState();
    position.byBatch[batch].onHand += onHandDelta;
    position.byBatch[batch].available += availableDelta;

    ensureBatchLocationState(position.byBatchLocation, batch, locationKey);
    position.byBatchLocation[batch][locationKey].onHand += onHandDelta;
    position.byBatchLocation[batch][locationKey].available += availableDelta;
  });

  Object.values(levels).forEach(position => {
    position.totalOnHand = toNearZero(position.totalOnHand);
    position.totalAvailable = toNearZero(position.totalAvailable);

    Object.values(position.byLocation).forEach(loc => {
      loc.onHand = toNearZero(loc.onHand);
      loc.available = toNearZero(loc.available);
    });

    Object.values(position.byBatch).forEach(batch => {
      batch.onHand = toNearZero(batch.onHand);
      batch.available = toNearZero(batch.available);
    });

    Object.values(position.byBatchLocation).forEach(locationMap => {
      Object.values(locationMap).forEach(state => {
        state.onHand = toNearZero(state.onHand);
        state.available = toNearZero(state.available);
      });
    });

    // Legacy aliases point to availability for backward compatibility.
    position.total = position.totalAvailable;
    position.locations = Object.fromEntries(
      Object.entries(position.byLocation).map(([location, state]) => [location, state.available])
    );
  });

  assertLedgerStockSnapshot(levels);
  return levels;
};
