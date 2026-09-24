import { RawComponentLot } from '../types';

export type RawLotWorkflowStage = 'PRE_ARRIVAL' | 'QUARANTINE' | 'RELEASED' | 'REJECTED';

const normalizeText = (value: unknown): string => String(value ?? '').trim();

const toNumber = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

export const createRawLotRecordId = (): string =>
  `LOT-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

export const normalizeRawLotWorkflowStage = (value: unknown): RawLotWorkflowStage | '' => {
  const token = normalizeText(value).toUpperCase();
  if (token === 'PRE_ARRIVAL') return 'PRE_ARRIVAL';
  if (token === 'QUARANTINE') return 'QUARANTINE';
  if (token === 'RELEASED') return 'RELEASED';
  if (token === 'REJECTED') return 'REJECTED';
  return '';
};

export const getRawLotWorkflowStage = (lot: Partial<RawComponentLot>): RawLotWorkflowStage => {
  const explicit = normalizeRawLotWorkflowStage((lot as any)?.workflow_stage);
  if (explicit) return explicit;

  const qcStatus = normalizeText((lot as any)?.qcStatus).toLowerCase();
  if (qcStatus === 'rejected') return 'REJECTED';

  const hasArrivalSignals = Boolean(
    normalizeText((lot as any)?.qc_number) ||
    normalizeText((lot as any)?.deliveryDate) ||
    normalizeText((lot as any)?.location) ||
    (toNumber((lot as any)?.received_qty) || 0) > 0
  );

  return hasArrivalSignals ? 'QUARANTINE' : 'PRE_ARRIVAL';
};

export const isPreArrivalRawLot = (lot: Partial<RawComponentLot>): boolean =>
  getRawLotWorkflowStage(lot) === 'PRE_ARRIVAL';

export const isArrivedRawLot = (lot: Partial<RawComponentLot>): boolean =>
  getRawLotWorkflowStage(lot) !== 'PRE_ARRIVAL';

export const isRejectedRawLot = (lot: Partial<RawComponentLot>): boolean =>
  getRawLotWorkflowStage(lot) === 'REJECTED';

export const getRawLotRowId = (lot: Partial<RawComponentLot>): string =>
  normalizeText((lot as any)?.lot_record_id) ||
  normalizeText((lot as any)?.qc_number) ||
  normalizeText((lot as any)?.itemId);

export const getRawLotActivityTimestamp = (lot: Partial<RawComponentLot>): string =>
  normalizeText((lot as any)?.editedAt) ||
  normalizeText((lot as any)?.updatedAt) ||
  normalizeText((lot as any)?.deliveryDate) ||
  normalizeText((lot as any)?.registeredAt) ||
  normalizeText((lot as any)?.createdAt);

export const getRawLotActivityUser = (lot: Partial<RawComponentLot>): string =>
  normalizeText((lot as any)?.editedBy) ||
  normalizeText((lot as any)?.updatedBy) ||
  normalizeText((lot as any)?.registeredBy) ||
  normalizeText((lot as any)?.createdBy);

export const getRawLotDisplayQuantity = (lot: Partial<RawComponentLot>): number =>
  isPreArrivalRawLot(lot)
    ? Number(toNumber((lot as any)?.ordered_qty) || 0)
    : Number(toNumber((lot as any)?.received_qty) || 0);

export const resolveRawLotLandedUnitPrice = (lot: Partial<RawComponentLot>): number => {
  const planned = toNumber((lot as any)?.planned_unit_price);
  const current = toNumber((lot as any)?.unit_price);
  const shipping = toNumber((lot as any)?.shipping_cost) || 0;
  const qty = toNumber((lot as any)?.received_qty) || toNumber((lot as any)?.ordered_qty) || 0;

  if (planned !== undefined) {
    return qty > 0 ? planned + (shipping / qty) : planned;
  }
  return current || 0;
};

export const withDerivedRawLotPricing = <T extends Partial<RawComponentLot>>(lot: T): T & { unit_price: number } => {
  return {
    ...lot,
    unit_price: resolveRawLotLandedUnitPrice(lot),
  };
};
