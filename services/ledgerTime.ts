import { InventoryTransaction } from '../types';

const toOptionalString = (value: unknown): string | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  return String(value).trim();
};

// Canonical ledger time semantics:
// createdAt = business event time; updatedAt = audit only.
export const resolveLedgerEventTime = (tx: Partial<InventoryTransaction>): string => {
  const createdAt = toOptionalString(tx.createdAt);
  const updatedAt = toOptionalString(tx.updatedAt);
  return createdAt || updatedAt || '';
};

// Canonical ledger time semantics:
// createdAt = business event time; updatedAt = audit only.
export const resolveLedgerAuditTime = (tx: Partial<InventoryTransaction>): string => {
  const updatedAt = toOptionalString(tx.updatedAt);
  return updatedAt || resolveLedgerEventTime(tx);
};

export const normalizeLedgerTransactionTimes = (tx: InventoryTransaction): InventoryTransaction => {
  const eventTime = resolveLedgerEventTime(tx);
  const auditTime = resolveLedgerAuditTime(tx);

  const normalized: InventoryTransaction = {
    ...tx,
    createdAt: eventTime || undefined,
    updatedAt: auditTime || undefined,
  } as InventoryTransaction;

  // Legacy fields are retired from canonical in-memory records after migration.
  delete (normalized as any).date;
  delete (normalized as any).pricePerUnit;

  return normalized;
};
