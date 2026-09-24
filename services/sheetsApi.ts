import { DEMO_USER } from '../data/fixtures';
import type {
  BOMItem,
  BatchCostPosting,
  BatchRecord,
  BatchStageEvent,
  CategoryMaster,
  Component,
  InventoryTransaction,
  PlanningReport,
  Product,
  RawComponentDisplayNameMaster,
  RawComponentLot,
} from '../types';
import type { BomVariantMeta } from './bomVariants';
import { getDemoSnapshot, updateDemoStore } from './demoStore';

let activeUser = DEMO_USER;
let sequence = 0;

const now = (): string => new Date().toISOString();
const token = (prefix: string): string => {
  sequence += 1;
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().slice(0, 8)
    : `${Date.now().toString(36)}-${sequence.toString(36)}`;
  return `${prefix}-${random}`.toUpperCase();
};

const requireText = (value: unknown, label: string): string => {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
};

const clone = <T,>(value: T): T => {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
};

const getDocumentId = (row: Record<string, unknown>): string =>
  String(row.doc_id ?? row.id ?? '').trim();

const batchIdentity = (row: Partial<BatchRecord>): string =>
  String(row.batch_id ?? row.id ?? row.batch_number ?? '').trim();

const lotIdentity = (row: Partial<RawComponentLot>): string =>
  String(row.lot_record_id ?? row.qc_number ?? '').trim();

const lineMatchesId = (line: BOMItem, id: string): boolean =>
  line.component_id === id || line.ref_id === id;

export const setApiUserContext = (email: string | null | undefined): void => {
  activeUser = String(email || DEMO_USER).trim().toLowerCase() || DEMO_USER;
};

// Retained as a harmless compatibility hook for the original UI shell.
export const setApiClientContext = (_clientId: string | null | undefined): void => {};

const baseSnapshot = () => {
  const state = getDemoSnapshot();
  return {
    items: clone(state.items),
    products: clone(state.products),
    batches: clone(state.batches),
    categories: clone(state.categories),
    raw_component_display_names: clone(state.rawComponentDisplayNames),
    documents: clone(state.documents),
    batch_events: clone(
      state.documents.filter((row) => row.doc_type === 'BATCH_EVENT').map((row) => row.payload),
    ),
  };
};

const transactionSnapshot = () => {
  const state = getDemoSnapshot();
  return {
    transactions: clone(state.transactions),
    raw_component_lot: clone(state.rawComponentLots),
    batch_costs: clone(
      state.documents.filter((row) => row.doc_type === 'BATCH_COST').map((row) => row.payload),
    ),
  };
};

export const syncBaseData = async (_options?: { fresh?: boolean }) => baseSnapshot();

export const syncBomData = async (_options?: { fresh?: boolean }) => ({
  recipes: clone(getDemoSnapshot().recipes),
});

export const syncTransactionData = async (_options?: { fresh?: boolean }) => transactionSnapshot();

export const syncStockBalanceData = async (_options?: { fresh?: boolean }) => ({ stock_balances: [] });

export const syncBootstrapData = async (_options?: { fresh?: boolean }) => ({
  ...baseSnapshot(),
  recipes: clone(getDemoSnapshot().recipes),
  ...transactionSnapshot(),
  stock_balances: [],
});

export const syncAllData = syncBootstrapData;

export const syncLedgerPage = async (options: {
  limit?: number;
  cursor?: string;
  itemId?: string;
  category?: string;
  location?: string;
  startDate?: string;
  endDate?: string;
} = {}) => {
  const limit = Math.max(1, Math.min(500, Number(options.limit) || 100));
  const offset = Math.max(0, Number(options.cursor) || 0);
  const rows = getDemoSnapshot().transactions.filter((row) => {
    if (options.itemId && row.itemId !== options.itemId) return false;
    if (options.category && row.category !== options.category) return false;
    if (options.location && row.location !== options.location) return false;
    const eventTime = String(row.createdAt || row.date || '');
    if (options.startDate && eventTime < options.startDate) return false;
    if (options.endDate && eventTime > `${options.endDate}T23:59:59.999Z`) return false;
    return true;
  });
  const page = rows.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    rows: clone(page),
    nextCursor: nextOffset < rows.length ? String(nextOffset) : undefined,
    count: page.length,
    meta: { total: rows.length },
  };
};

export const addLedgerTxn = async (
  input: Partial<InventoryTransaction>,
): Promise<InventoryTransaction> => {
  const timestamp = now();
  const row: InventoryTransaction = {
    id: String(input.id || token('TX')),
    type: input.type || 'IN',
    category: input.category || 'COMPONENT',
    itemId: requireText(input.itemId, 'Item ID'),
    itemName: input.itemName,
    quantity: Number(input.quantity) || 0,
    unit: String(input.unit || 'kg'),
    location: input.location || 'Riverside',
    ...input,
    createdAt: input.createdAt || timestamp,
    updatedAt: timestamp,
    user: input.user || activeUser,
    updatedBy: input.updatedBy || activeUser,
  };
  updateDemoStore((draft) => {
    if (draft.transactions.some((candidate) => candidate.id === row.id)) {
      throw new Error(`Transaction ${row.id} already exists.`);
    }
    draft.transactions.unshift(row);
  });
  return clone(row);
};

export const updateLedgerTxn = async (
  id: string,
  updates: Partial<InventoryTransaction>,
): Promise<InventoryTransaction> => {
  const targetId = requireText(id, 'Transaction ID');
  let persisted: InventoryTransaction | null = null;
  updateDemoStore((draft) => {
    const index = draft.transactions.findIndex((row) => row.id === targetId);
    if (index < 0) throw new Error(`Transaction ${targetId} was not found.`);
    persisted = {
      ...draft.transactions[index],
      ...updates,
      id: targetId,
      updatedAt: now(),
      updatedBy: updates.updatedBy || activeUser,
    };
    draft.transactions[index] = persisted;
  });
  return clone(persisted as unknown as InventoryTransaction);
};

export const deleteLedgerTxn = async (id: string) => {
  const targetId = requireText(id, 'Transaction ID');
  let deletedCount = 0;
  updateDemoStore((draft) => {
    const before = draft.transactions.length;
    draft.transactions = draft.transactions.filter((row) => row.id !== targetId);
    deletedCount = before - draft.transactions.length;
  });
  if (!deletedCount) throw new Error(`Transaction ${targetId} was not found.`);
  return { success: true, deletedCount };
};

export const addRawComponentLot = async (
  input: Partial<RawComponentLot>,
): Promise<RawComponentLot> => {
  const timestamp = now();
  const row: RawComponentLot = {
    qc_number: String(input.qc_number || ''),
    itemId: requireText(input.itemId, 'Item ID'),
    received_qty: Number(input.received_qty) || 0,
    unit: String(input.unit || 'kg'),
    unit_price: Number(input.unit_price) || 0,
    location: input.location || '',
    supplier: String(input.supplier || ''),
    deliveryDate: String(input.deliveryDate || ''),
    mfgBatch: String(input.mfgBatch || ''),
    mfgDate: String(input.mfgDate || ''),
    expDate: String(input.expDate || ''),
    qcStatus: String(input.qcStatus || 'Pending'),
    qcNotes: String(input.qcNotes || ''),
    coaStored: input.coaStored || 'No',
    sdsStored: input.sdsStored || 'No',
    tdsStored: input.tdsStored || 'No',
    ...input,
    lot_record_id: String(input.lot_record_id || token('LOT')),
    createdAt: input.createdAt || timestamp,
    updatedAt: timestamp,
    createdBy: input.createdBy || activeUser,
    updatedBy: input.updatedBy || activeUser,
  };
  updateDemoStore((draft) => {
    const identity = lotIdentity(row);
    if (draft.rawComponentLots.some((candidate) => lotIdentity(candidate) === identity)) {
      throw new Error(`Raw-component lot ${identity} already exists.`);
    }
    draft.rawComponentLots.unshift(row);
  });
  return clone(row);
};

export const updateRawComponentLot = async (
  id: string,
  updates: Partial<RawComponentLot>,
): Promise<RawComponentLot> => {
  const targetId = requireText(id, 'Lot ID');
  let persisted: RawComponentLot | null = null;
  updateDemoStore((draft) => {
    const index = draft.rawComponentLots.findIndex(
      (row) => lotIdentity(row) === targetId || row.qc_number === targetId,
    );
    if (index < 0) throw new Error(`Raw-component lot ${targetId} was not found.`);
    persisted = {
      ...draft.rawComponentLots[index],
      ...updates,
      updatedAt: now(),
      updatedBy: updates.updatedBy || activeUser,
    };
    draft.rawComponentLots[index] = persisted;
  });
  return clone(persisted as unknown as RawComponentLot);
};

export const deleteRawComponentLot = async (id: string) => {
  const targetId = requireText(id, 'Lot ID');
  let deletedCount = 0;
  updateDemoStore((draft) => {
    const before = draft.rawComponentLots.length;
    draft.rawComponentLots = draft.rawComponentLots.filter(
      (row) => lotIdentity(row) !== targetId && row.qc_number !== targetId,
    );
    deletedCount = before - draft.rawComponentLots.length;
  });
  if (!deletedCount) throw new Error(`Raw-component lot ${targetId} was not found.`);
  return { success: true, deletedCount };
};

const buildBatch = (input: Partial<BatchRecord>, existing?: BatchRecord): BatchRecord => {
  const identity = requireText(batchIdentity(input) || batchIdentity(existing || {}), 'Batch ID');
  const timestamp = now();
  return {
    ...existing,
    ...input,
    id: identity,
    batch_id: identity,
    productSku: requireText(input.productSku ?? existing?.productSku, 'Product SKU'),
    productName: String(input.productName ?? existing?.productName ?? ''),
    plannedQuantity: Number(input.plannedQuantity ?? existing?.plannedQuantity) || 0,
    status: input.status ?? existing?.status ?? 'preparation',
    location: input.location ?? existing?.location ?? 'Riverside',
    unitProductionCost: Number(input.unitProductionCost ?? existing?.unitProductionCost) || 0,
    createdAt: input.createdAt || existing?.createdAt || timestamp,
    updatedAt: timestamp,
  };
};

export const createBatch = async (input: Partial<BatchRecord>): Promise<BatchRecord> => {
  const row = buildBatch(input);
  updateDemoStore((draft) => {
    if (draft.batches.some((candidate) => batchIdentity(candidate) === row.id)) {
      throw new Error(`Batch ${row.id} already exists.`);
    }
    draft.batches.unshift(row);
  });
  return clone(row);
};

export const updateBatch = async (
  id: string,
  updates: Partial<BatchRecord>,
): Promise<BatchRecord> => {
  const targetId = requireText(id, 'Batch ID');
  let persisted: BatchRecord | null = null;
  updateDemoStore((draft) => {
    const index = draft.batches.findIndex(
      (row) => batchIdentity(row) === targetId || row.batch_number === targetId,
    );
    if (index < 0) throw new Error(`Batch ${targetId} was not found.`);
    const requestedIdentity = batchIdentity(updates) || targetId;
    if (
      requestedIdentity !== targetId &&
      draft.batches.some((row, rowIndex) => rowIndex !== index && batchIdentity(row) === requestedIdentity)
    ) {
      throw new Error(`Batch ${requestedIdentity} already exists.`);
    }
    persisted = buildBatch({ ...updates, id: requestedIdentity, batch_id: requestedIdentity }, draft.batches[index]);
    draft.batches[index] = persisted;
  });
  return clone(persisted as unknown as BatchRecord);
};

export const deleteBatch = async (id: string) => {
  const targetId = requireText(id, 'Batch ID');
  let deletedCount = 0;
  updateDemoStore((draft) => {
    const before = draft.batches.length;
    draft.batches = draft.batches.filter(
      (row) => batchIdentity(row) !== targetId && row.batch_number !== targetId,
    );
    deletedCount = before - draft.batches.length;
  });
  if (!deletedCount) throw new Error(`Batch ${targetId} was not found.`);
  return { success: true, deletedCount };
};

export const addBatchEvent = async (
  event: Omit<BatchStageEvent, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<BatchStageEvent> => {
  const timestamp = now();
  const row: BatchStageEvent = { ...event, id: token('EVT'), createdAt: timestamp, updatedAt: timestamp };
  updateDemoStore((draft) => {
    draft.documents.push({ doc_id: row.id, doc_type: 'BATCH_EVENT', payload: row });
  });
  return clone(row);
};

export const addBatchCost = async (
  cost: Omit<BatchCostPosting, 'posted_at'>,
): Promise<BatchCostPosting> => {
  const row: BatchCostPosting = { ...cost, posted_at: now() };
  updateDemoStore((draft) => {
    draft.documents.push({ doc_id: token('COST'), doc_type: 'BATCH_COST', payload: row });
  });
  return clone(row);
};

export const upsertItemsMaster = async (input: Component): Promise<Component> => {
  const timestamp = now();
  const id = requireText(input.component_id, 'Component ID');
  const row = { ...input, component_id: id, createdAt: input.createdAt || timestamp, updatedAt: timestamp, updatedBy: input.updatedBy || activeUser };
  updateDemoStore((draft) => {
    const index = draft.items.findIndex((candidate) => candidate.component_id === id);
    if (index < 0) draft.items.push(row);
    else draft.items[index] = { ...draft.items[index], ...row };
  });
  return clone(row);
};

export const updateItemsMaster = async (id: string, input: Component): Promise<Component> => {
  const targetId = requireText(id, 'Component ID');
  let persisted: Component | null = null;
  updateDemoStore((draft) => {
    const index = draft.items.findIndex((row) => row.component_id === targetId);
    if (index < 0) throw new Error(`Component ${targetId} was not found.`);
    persisted = {
      ...draft.items[index],
      ...input,
      component_id: input.component_id || targetId,
      updatedAt: now(),
      updatedBy: input.updatedBy || activeUser,
    };
    draft.items[index] = persisted;
  });
  return clone(persisted as unknown as Component);
};

export const deleteItemsMaster = async (id: string) => {
  const targetId = requireText(id, 'Component ID');
  let deletedCount = 0;
  updateDemoStore((draft) => {
    const before = draft.items.length;
    draft.items = draft.items.filter((row) => row.component_id !== targetId);
    deletedCount = before - draft.items.length;
    draft.recipes = draft.recipes.filter((row) => !lineMatchesId(row, targetId));
  });
  if (!deletedCount) throw new Error(`Component ${targetId} was not found.`);
  return { success: true, deletedCount };
};

export const createProduct = async (input: Product): Promise<Product> => {
  const timestamp = now();
  const id = requireText(input.sku_id, 'Product SKU');
  const row = { ...input, sku_id: id, createdAt: input.createdAt || timestamp, updatedAt: timestamp, updatedBy: input.updatedBy || activeUser };
  updateDemoStore((draft) => {
    if (draft.products.some((candidate) => candidate.sku_id === id)) {
      throw new Error(`Product ${id} already exists.`);
    }
    draft.products.push(row);
  });
  return clone(row);
};

export const updateProduct = async (id: string, input: Product): Promise<Product> => {
  const targetId = requireText(id, 'Product SKU');
  let persisted: Product | null = null;
  updateDemoStore((draft) => {
    const index = draft.products.findIndex((row) => row.sku_id === targetId);
    if (index < 0) throw new Error(`Product ${targetId} was not found.`);
    persisted = {
      ...draft.products[index],
      ...input,
      sku_id: input.sku_id || targetId,
      updatedAt: now(),
      updatedBy: input.updatedBy || activeUser,
    };
    draft.products[index] = persisted;
  });
  return clone(persisted as unknown as Product);
};

export const deleteProduct = async (id: string) => {
  const targetId = requireText(id, 'Product SKU');
  let deletedCount = 0;
  updateDemoStore((draft) => {
    const before = draft.products.length;
    draft.products = draft.products.filter((row) => row.sku_id !== targetId);
    deletedCount = before - draft.products.length;
    draft.recipes = draft.recipes.filter((row) => row.sku_id !== targetId);
  });
  if (!deletedCount) throw new Error(`Product ${targetId} was not found.`);
  return { success: true, deletedCount };
};

export const createCategory = async (input: Partial<CategoryMaster>): Promise<CategoryMaster> => {
  const timestamp = now();
  const row: CategoryMaster = {
    id: String(input.id || token('CAT')),
    type: input.type || 'INGREDIENT',
    category_code: requireText(input.category_code, 'Category code'),
    category_label: requireText(input.category_label, 'Category label'),
    ...input,
    updatedBy: input.updatedBy || activeUser,
    createdAt: input.createdAt || timestamp,
    updatedAt: timestamp,
  };
  updateDemoStore((draft) => {
    const duplicate = draft.categories.some(
      (candidate) => candidate.type === row.type && candidate.category_code === row.category_code,
    );
    if (duplicate) throw new Error(`Category ${row.type} ${row.category_code} already exists.`);
    draft.categories.push(row);
  });
  return clone(row);
};

export const updateCategory = async (
  id: string,
  updates: Partial<CategoryMaster>,
): Promise<CategoryMaster> => {
  const targetId = requireText(id, 'Category ID');
  let persisted: CategoryMaster | null = null;
  updateDemoStore((draft) => {
    const index = draft.categories.findIndex((row) => row.id === targetId);
    if (index < 0) throw new Error(`Category ${targetId} was not found.`);
    persisted = { ...draft.categories[index], ...updates, id: targetId, updatedAt: now(), updatedBy: updates.updatedBy || activeUser };
    draft.categories[index] = persisted;
  });
  return clone(persisted as unknown as CategoryMaster);
};

export const deleteCategoryById = async (id: string) => {
  const targetId = requireText(id, 'Category ID');
  let deletedCount = 0;
  updateDemoStore((draft) => {
    const before = draft.categories.length;
    draft.categories = draft.categories.filter((row) => row.id !== targetId);
    deletedCount = before - draft.categories.length;
  });
  if (!deletedCount) throw new Error(`Category ${targetId} was not found.`);
  return { success: true, deletedCount };
};

export const deleteCategoryByKey = async (payload: { type: string; category_code: string }) => {
  const type = requireText(payload.type, 'Component type');
  const code = requireText(payload.category_code, 'Category code');
  let deletedCount = 0;
  updateDemoStore((draft) => {
    const before = draft.categories.length;
    draft.categories = draft.categories.filter(
      (row) => !(row.type === type && row.category_code === code),
    );
    deletedCount = before - draft.categories.length;
  });
  if (!deletedCount) throw new Error(`Category ${type} ${code} was not found.`);
  return { success: true, deletedCount };
};

export const createRawComponentDisplayName = async (
  input: RawComponentDisplayNameMaster,
): Promise<RawComponentDisplayNameMaster> => {
  const timestamp = now();
  const row = {
    ...input,
    id: String(input.id || token('NAME')),
    createdAt: input.createdAt || timestamp,
    updatedAt: timestamp,
    updatedBy: input.updatedBy || activeUser,
  };
  updateDemoStore((draft) => {
    if (draft.rawComponentDisplayNames.some((candidate) => candidate.id === row.id)) {
      throw new Error(`Display name ${row.id} already exists.`);
    }
    draft.rawComponentDisplayNames.push(row);
  });
  return clone(row);
};

export const updateRawComponentDisplayName = async (
  id: string,
  updates: Partial<RawComponentDisplayNameMaster>,
): Promise<RawComponentDisplayNameMaster> => {
  const targetId = requireText(id, 'Display-name ID');
  let persisted: RawComponentDisplayNameMaster | null = null;
  updateDemoStore((draft) => {
    const index = draft.rawComponentDisplayNames.findIndex((row) => row.id === targetId);
    if (index < 0) throw new Error(`Display name ${targetId} was not found.`);
    persisted = {
      ...draft.rawComponentDisplayNames[index],
      ...updates,
      id: targetId,
      updatedAt: now(),
      updatedBy: updates.updatedBy || activeUser,
    };
    draft.rawComponentDisplayNames[index] = persisted;
  });
  return clone(persisted as unknown as RawComponentDisplayNameMaster);
};

export const deleteRawComponentDisplayName = async (id: string) => {
  const targetId = requireText(id, 'Display-name ID');
  let deletedCount = 0;
  updateDemoStore((draft) => {
    const before = draft.rawComponentDisplayNames.length;
    draft.rawComponentDisplayNames = draft.rawComponentDisplayNames.filter((row) => row.id !== targetId);
    deletedCount = before - draft.rawComponentDisplayNames.length;
  });
  if (!deletedCount) throw new Error(`Display name ${targetId} was not found.`);
  return { success: true, deletedCount };
};

export type MasterRenameEntityType = 'PRODUCT' | 'COMPONENT';

export interface MasterRenamePayload {
  entityType: MasterRenameEntityType;
  oldId: string;
  newId: string;
  record: Partial<Product> | Partial<Component>;
  user?: string;
}

export interface MasterRenamePreviewResponse {
  success: boolean;
  entityType: MasterRenameEntityType;
  oldId: string;
  newId: string;
  counts: Record<string, number>;
  effects?: string[];
}

export const previewMasterIdRename = async (
  payload: Pick<MasterRenamePayload, 'entityType' | 'oldId' | 'newId'>,
): Promise<MasterRenamePreviewResponse> => {
  const oldId = requireText(payload.oldId, 'Current ID');
  const newId = requireText(payload.newId, 'New ID');
  const state = getDemoSnapshot();
  const counts: Record<string, number> = {};
  const effects: string[] = [];

  if (payload.entityType === 'COMPONENT') {
    counts.masterRecords = state.items.filter((row) => row.component_id === oldId).length;
    counts.formulationLines = state.recipes.filter((row) => lineMatchesId(row, oldId)).length;
    counts.inventoryTransactions = state.transactions.filter(
      (row) => row.category === 'COMPONENT' && row.itemId === oldId,
    ).length;
    counts.rawComponentLots = state.rawComponentLots.filter((row) => row.itemId === oldId).length;
    effects.push('Component references in formulations, lots, and inventory activity will be updated.');
  } else {
    counts.masterRecords = state.products.filter((row) => row.sku_id === oldId).length;
    counts.formulationLines = state.recipes.filter(
      (row) => row.sku_id === oldId || lineMatchesId(row, oldId),
    ).length;
    counts.inventoryTransactions = state.transactions.filter(
      (row) => row.category === 'PRODUCT' && row.itemId === oldId,
    ).length;
    counts.batchRecords = state.batches.filter((row) => row.productSku === oldId).length;
    effects.push('Product references in formulations, batches, and inventory activity will be updated.');
  }
  counts.totalAffected = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return { success: true, entityType: payload.entityType, oldId, newId, counts, effects };
};

export const renameMasterId = async (payload: MasterRenamePayload) => {
  const oldId = requireText(payload.oldId, 'Current ID');
  const newId = requireText(payload.newId, 'New ID');
  if (oldId === newId) throw new Error('The new ID must be different from the current ID.');
  const preview = await previewMasterIdRename({ entityType: payload.entityType, oldId, newId });

  updateDemoStore((draft) => {
    if (payload.entityType === 'COMPONENT') {
      const index = draft.items.findIndex((row) => row.component_id === oldId);
      if (index < 0) throw new Error(`Component ${oldId} was not found.`);
      if (draft.items.some((row) => row.component_id === newId)) {
        throw new Error(`Component ${newId} already exists.`);
      }
      const input = payload.record as Partial<Component>;
      const renamed: Component = {
        ...draft.items[index],
        ...input,
        component_id: newId,
        updatedAt: now(),
        updatedBy: payload.user || activeUser,
      };
      draft.items[index] = renamed;
      draft.recipes = draft.recipes.map((line) => ({
        ...line,
        component_id: line.component_id === oldId ? newId : line.component_id,
        ref_id: line.ref_id === oldId ? newId : line.ref_id,
      }));
      draft.transactions = draft.transactions.map((row) =>
        row.category === 'COMPONENT' && row.itemId === oldId
          ? { ...row, itemId: newId, itemName: renamed.component_name || row.itemName, updatedAt: now() }
          : row,
      );
      draft.rawComponentLots = draft.rawComponentLots.map((row) =>
        row.itemId === oldId ? { ...row, itemId: newId, updatedAt: now() } : row,
      );
      return;
    }

    const index = draft.products.findIndex((row) => row.sku_id === oldId);
    if (index < 0) throw new Error(`Product ${oldId} was not found.`);
    if (draft.products.some((row) => row.sku_id === newId)) {
      throw new Error(`Product ${newId} already exists.`);
    }
    const input = payload.record as Partial<Product>;
    const renamed: Product = {
      ...draft.products[index],
      ...input,
      sku_id: newId,
      updatedAt: now(),
      updatedBy: payload.user || activeUser,
    };
    draft.products[index] = renamed;
    draft.recipes = draft.recipes.map((line) => ({
      ...line,
      sku_id: line.sku_id === oldId ? newId : line.sku_id,
      component_id: line.component_id === oldId ? newId : line.component_id,
      ref_id: line.ref_id === oldId ? newId : line.ref_id,
    }));
    draft.transactions = draft.transactions.map((row) =>
      row.category === 'PRODUCT' && row.itemId === oldId
        ? { ...row, itemId: newId, itemName: renamed.sku_name || row.itemName, updatedAt: now() }
        : row,
    );
    draft.batches = draft.batches.map((row) =>
      row.productSku === oldId
        ? { ...row, productSku: newId, productName: renamed.sku_name || row.productName, updatedAt: now() }
        : row,
    );
  });
  return { ...preview, record: clone(payload.record) };
};

export interface BatchReferenceRenamePayload {
  oldId: string;
  newId: string;
  record: Partial<BatchRecord>;
  user?: string;
}

export const renameBatchReference = async (payload: BatchReferenceRenamePayload) => {
  const oldId = requireText(payload.oldId, 'Current batch ID');
  const newId = requireText(payload.newId, 'New batch ID');
  let renamed: BatchRecord | null = null;
  let transactionCount = 0;
  updateDemoStore((draft) => {
    const index = draft.batches.findIndex((row) => batchIdentity(row) === oldId);
    if (index < 0) throw new Error(`Batch ${oldId} was not found.`);
    if (oldId !== newId && draft.batches.some((row) => batchIdentity(row) === newId)) {
      throw new Error(`Batch ${newId} already exists.`);
    }
    renamed = buildBatch({ ...payload.record, id: newId, batch_id: newId }, draft.batches[index]);
    draft.batches[index] = renamed;
    draft.batches = draft.batches.map((row) =>
      row.parentBulkBatchId === oldId ? { ...row, parentBulkBatchId: newId, updatedAt: now() } : row,
    );
    draft.transactions = draft.transactions.map((row) => {
      if (row.batchNumber !== oldId) return row;
      transactionCount += 1;
      return { ...row, batchNumber: newId, updatedAt: now(), updatedBy: payload.user || activeUser };
    });
    draft.documents = draft.documents.map((row) =>
      row.reference_id === oldId ? { ...row, reference_id: newId, updatedAt: now() } : row,
    );
  });
  return { success: true, oldId, newId, transactionCount, batch: clone(renamed as unknown as BatchRecord) };
};

export const createDocument = async (input: Record<string, unknown>) => {
  const timestamp = now();
  const id = String(input.doc_id || input.id || token('DOC'));
  const row = { ...input, doc_id: id, createdAt: input.createdAt || timestamp, updatedAt: timestamp, updatedBy: input.updatedBy || activeUser };
  updateDemoStore((draft) => {
    if (draft.documents.some((candidate) => getDocumentId(candidate) === id)) {
      throw new Error(`Document ${id} already exists.`);
    }
    draft.documents.unshift(row);
  });
  return clone(row);
};

export const updateDocument = async (id: string, updates: Record<string, unknown>) => {
  const targetId = requireText(id, 'Document ID');
  let persisted: Record<string, unknown> | null = null;
  updateDemoStore((draft) => {
    const index = draft.documents.findIndex((row) => getDocumentId(row) === targetId);
    if (index < 0) throw new Error(`Document ${targetId} was not found.`);
    persisted = { ...draft.documents[index], ...updates, doc_id: targetId, updatedAt: now(), updatedBy: updates.updatedBy || activeUser };
    draft.documents[index] = persisted;
  });
  return clone(persisted as unknown as Record<string, unknown>);
};

export interface SaveRecipeBatchOptions {
  bomVariantId?: string;
  bomVariantName?: string;
  isDefaultVariant?: boolean;
  variantSortOrder?: number;
  variantMeta?: BomVariantMeta[];
}

export const saveRecipeBatch = async (
  skuId: string,
  bomLines: Partial<BOMItem>[],
  user: string,
  options: SaveRecipeBatchOptions = {},
) => {
  const productSku = requireText(skuId, 'Product SKU');
  const variantId = String(options.bomVariantId || bomLines[0]?.bomVariantId || 'VAR-DEFAULT').trim();
  const timestamp = now();
  const metaById = new Map((options.variantMeta || []).map((meta) => [meta.bomVariantId, meta]));
  const selectedMeta = metaById.get(variantId);
  const normalizedLines = bomLines.map((line, index): BOMItem => ({
    ...line,
    sku_id: productSku,
    component_id: requireText(line.component_id, 'Recipe component ID'),
    qty_per_kg: Number(line.qty_per_kg) || 0,
    unit: String(line.unit || 'kg'),
    bomVariantId: variantId,
    bomVariantName: options.bomVariantName || selectedMeta?.bomVariantName || line.bomVariantName || variantId,
    isDefaultVariant: options.isDefaultVariant ?? selectedMeta?.isDefaultVariant ?? line.isDefaultVariant ?? false,
    variantSortOrder: options.variantSortOrder ?? selectedMeta?.variantSortOrder ?? line.variantSortOrder ?? 0,
    line_order: Number(line.line_order) || index + 1,
    createdAt: line.createdAt || timestamp,
    updatedAt: timestamp,
    updatedBy: user || activeUser,
  }));

  updateDemoStore((draft) => {
    const retained = draft.recipes.filter(
      (line) => !(line.sku_id === productSku && String(line.bomVariantId || 'VAR-DEFAULT') === variantId),
    );
    draft.recipes = [...retained, ...normalizedLines].map((line) => {
      if (line.sku_id !== productSku) return line;
      const meta = metaById.get(String(line.bomVariantId || 'VAR-DEFAULT'));
      if (!meta) return line;
      return {
        ...line,
        bomVariantName: meta.bomVariantName,
        isDefaultVariant: meta.isDefaultVariant,
        variantSortOrder: meta.variantSortOrder,
        updatedAt: timestamp,
        updatedBy: user || activeUser,
      };
    });
  });
  return { success: true, count: normalizedLines.length, bomVariantId: variantId };
};

export const getPlanningReports = async (): Promise<PlanningReport[]> =>
  clone(getDemoSnapshot().planningReports);

export const savePlanningReport = async (input: PlanningReport): Promise<PlanningReport> => {
  const timestamp = now();
  const id = String(input.report_id || token('REPORT'));
  const row: PlanningReport = {
    ...input,
    report_id: id,
    created_at: input.created_at || timestamp,
    created_by: input.created_by || activeUser,
  };
  updateDemoStore((draft) => {
    const index = draft.planningReports.findIndex((candidate) => candidate.report_id === id);
    if (index < 0) draft.planningReports.unshift(row);
    else draft.planningReports[index] = row;
  });
  return clone(row);
};

export const updatePlanningReport = async (
  id: string,
  updates: Partial<PlanningReport>,
): Promise<PlanningReport> => {
  const targetId = requireText(id, 'Planning report ID');
  let persisted: PlanningReport | null = null;
  updateDemoStore((draft) => {
    const index = draft.planningReports.findIndex((row) => row.report_id === targetId);
    if (index < 0) throw new Error(`Planning report ${targetId} was not found.`);
    persisted = { ...draft.planningReports[index], ...updates, report_id: targetId };
    draft.planningReports[index] = persisted;
  });
  return clone(persisted as unknown as PlanningReport);
};
