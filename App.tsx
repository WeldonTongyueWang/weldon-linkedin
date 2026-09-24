import React, {
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { RotateCcw } from 'lucide-react';

import { Layout } from './components/Layout';
import { MasterDataView } from './components/MasterDataView';
import { InventoryManagerView } from './components/inventory/InventoryManagerView';
import { ManufacturingPlanningView } from './components/ManufacturingPlanningView';
import { useAppDialog } from './components/ui/AppDialogProvider';
import {
  DEMO_OPEN_POS,
  DEMO_SUPPLIERS,
  DEMO_USER,
} from './data/fixtures';
import {
  getDemoSnapshot,
  reloadDemoStore,
  resetDemoStore,
  subscribeDemoStore,
  updateDemoStore,
} from './services/demoStore';
import { computeLedgerStockLevels } from './services/ledgerStock';
import {
  getRawLotRowId,
  isArrivedRawLot,
  resolveRawLotLandedUnitPrice,
  withDerivedRawLotPricing,
} from './services/rawLotWorkflow';
import {
  getArchivedRawComponentCategory,
  getDefaultRawComponentCategory,
} from './services/rawComponentsService';
import { formatFinishedProductInventoryLabel } from './utils/finishedProductLabels';
import { formatRawComponentListLabel } from './utils/rawComponentLabels';
import type {
  AppSettings,
  BatchRecord,
  BOMItem,
  CategoryMaster,
  Component,
  IngredientBatch,
  InventoryTransaction,
  Product,
  ProductBatch,
  RawComponentDisplayNameMaster,
  RawComponentLot,
  UserRole,
} from './types';

type AppTab = 'master' | 'inventory' | 'manufacturing';

const APP_TABS: AppTab[] = ['master', 'inventory', 'manufacturing'];
const DEMO_ROLE: UserRole = 'ADMIN';

const normalizeText = (value: unknown): string => String(value ?? '').trim();
const normalizeKey = (value: unknown): string => normalizeText(value).toLowerCase();
const sameIdentity = (left: unknown, right: unknown): boolean =>
  normalizeKey(left) === normalizeKey(right);

const resolveBatchIdentity = (batch: Partial<BatchRecord> | null | undefined): string => {
  if (!batch) return '';
  return normalizeText(batch.batch_id || batch.id || batch.batch_number);
};

const normalizeBatch = (batch: BatchRecord): BatchRecord => {
  const identity = resolveBatchIdentity(batch);
  return { ...batch, id: identity, batch_id: identity || undefined };
};

const createRecordId = (prefix: string): string => {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid
    ? `${prefix}-${uuid}`
    : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
};

const buildLotLedgerNotes = (lot: Partial<RawComponentLot>): string =>
  [
    normalizeText(lot.procurementNotes)
      ? `Procurement: ${normalizeText(lot.procurementNotes)}`
      : '',
    normalizeText(lot.qcNotes) ? `QC: ${normalizeText(lot.qcNotes)}` : '',
  ]
    .filter(Boolean)
    .join(' | ');

const resolveCollectionUpdate = <T,>(
  current: T[],
  update: SetStateAction<T[]>,
): T[] => (typeof update === 'function' ? (update as (value: T[]) => T[])(current) : update);

const App: React.FC = () => {
  const appDialog = useAppDialog();
  const database = useSyncExternalStore(
    subscribeDemoStore,
    getDemoSnapshot,
    getDemoSnapshot,
  );
  const [activeTab, setActiveTab] = useState<AppTab>('inventory');
  const [isRefreshing, setIsRefreshing] = useState(false);

  const setInventory = useCallback<Dispatch<SetStateAction<Component[]>>>((next) => {
    updateDemoStore((draft) => {
      draft.items = resolveCollectionUpdate(draft.items, next);
    });
  }, []);

  const setProducts = useCallback<Dispatch<SetStateAction<Product[]>>>((next) => {
    updateDemoStore((draft) => {
      draft.products = resolveCollectionUpdate(draft.products, next);
    });
  }, []);

  const setBom = useCallback<Dispatch<SetStateAction<BOMItem[]>>>((next) => {
    updateDemoStore((draft) => {
      draft.recipes = resolveCollectionUpdate(draft.recipes, next);
    });
  }, []);

  const productBatches = useMemo<ProductBatch[]>(
    () =>
      database.batches.map((record) => {
        const identity = resolveBatchIdentity(record);
        return {
          id: identity,
          batch_id: identity || undefined,
          sku_id: record.productSku,
          bomVariantId: record.bomVariantId,
          bomVariantName: record.bomVariantName,
          batch_number:
            record.batch_number ||
            (identity.includes('::') ? identity.slice(identity.indexOf('::') + 2) : identity),
          batchType: record.batchType,
          parentBulkBatchId: record.parentBulkBatchId,
          qty_remaining: Number(record.actualYield || 0),
          unit_cost: Number(record.unitProductionCost || 0),
          date_produced: record.updatedAt || record.createdAt || '',
          location: record.location,
          status: record.status,
          plannedQuantity: Number(record.plannedQuantity || 0),
          actualYield: record.actualYield,
          qcDocRef: record.qcDocRef,
          qcNotes: record.qcNotes,
          qcDisposition: record.qcDisposition,
        };
      }),
    [database.batches],
  );

  const ledgerStockLevels = useMemo(
    () => computeLedgerStockLevels(database.transactions, database.rawComponentLots, productBatches),
    [database.rawComponentLots, database.transactions, productBatches],
  );

  const ingredientBatches = useMemo<IngredientBatch[]>(
    () =>
      database.rawComponentLots
        .filter(
          (lot) =>
            isArrivedRawLot(lot) &&
            Boolean(normalizeText(lot.qc_number)) &&
            Boolean(normalizeText(lot.location)),
        )
        .map((lot) => ({
          id: lot.qc_number,
          component_id: lot.itemId,
          qc_number: lot.qc_number,
          qty_remaining: Number(
            ledgerStockLevels[lot.itemId]?.byBatch[lot.qc_number]?.available || 0,
          ),
          date_received: lot.deliveryDate,
          location: lot.location as IngredientBatch['location'],
        }))
        .filter((batch) => batch.qty_remaining > 0),
    [database.rawComponentLots, ledgerStockLevels],
  );

  const appSettings = useMemo<AppSettings>(
    () => ({
      targetDaysOfCover: 30,
      capacityHoursPerShift: 8,
      weights: { urgency: 0.6, priority: 0.4 },
      currentUser: DEMO_USER,
    }),
    [],
  );

  const handleForceSync = useCallback(async () => {
    setIsRefreshing(true);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 180));
    reloadDemoStore();
    setIsRefreshing(false);
  }, []);

  const handleResetDemo = useCallback(async () => {
    const confirmed = await appDialog.confirm({
      title: 'Reset demo data?',
      message:
        'This replaces your browser-local edits with the original synthetic fixture data.',
      tone: 'warning',
      confirmLabel: 'Reset demo',
      cancelLabel: 'Keep my edits',
    });
    if (!confirmed) return;
    resetDemoStore();
    await appDialog.alert({
      title: 'Demo reset',
      message: 'The synthetic fixture data has been restored.',
      tone: 'success',
    });
  }, [appDialog]);

  const handleTransaction = useCallback(
    async (payload: Partial<InventoryTransaction>, lotMetadata?: Partial<RawComponentLot>) => {
      const timestamp = new Date().toISOString();
      const transaction: InventoryTransaction = {
        ...(payload as InventoryTransaction),
        id: normalizeText(payload.id) || createRecordId('TXN'),
        createdAt: normalizeText(payload.createdAt) || timestamp,
        updatedAt: timestamp,
        user: normalizeText(payload.user) || DEMO_USER,
        updatedBy: normalizeText(payload.updatedBy) || DEMO_USER,
      };
      delete (transaction as { date?: string }).date;

      updateDemoStore((draft) => {
        draft.transactions = [transaction, ...draft.transactions.filter((row) => row.id !== transaction.id)];

        if (lotMetadata && normalizeText(transaction.batchNumber)) {
          const nextLot = withDerivedRawLotPricing({
            ...lotMetadata,
            lot_record_id:
              normalizeText(lotMetadata.lot_record_id) ||
              createRecordId('LOT'),
            qc_number: normalizeText(transaction.batchNumber),
            itemId: normalizeText(transaction.itemId),
            workflow_stage: lotMetadata.workflow_stage || 'RELEASED',
            editedAt: timestamp,
            updatedAt: timestamp,
            updatedBy: DEMO_USER,
          }) as RawComponentLot;
          const lotId = getRawLotRowId(nextLot);
          const index = draft.rawComponentLots.findIndex(
            (lot) =>
              sameIdentity(getRawLotRowId(lot), lotId) ||
              sameIdentity(lot.qc_number, nextLot.qc_number),
          );
          if (index >= 0) {
            draft.rawComponentLots[index] = {
              ...draft.rawComponentLots[index],
              ...nextLot,
            };
          } else {
            draft.rawComponentLots.unshift(nextLot);
          }
        }
      });

      return transaction;
    },
    [],
  );

  const handleEditTransaction = useCallback(
    async (id: string, updates: Partial<InventoryTransaction>, reason: string, user: string) => {
      updateDemoStore((draft) => {
        draft.transactions = draft.transactions.map((transaction) =>
          transaction.id === id
            ? {
                ...transaction,
                ...updates,
                updatedAt: new Date().toISOString(),
                updatedBy: user || DEMO_USER,
                editReason: reason,
              }
            : transaction,
        );
      });
    },
    [],
  );

  const handleDeleteTransaction = useCallback(async (id: string) => {
    updateDemoStore((draft) => {
      draft.transactions = draft.transactions.filter((transaction) => transaction.id !== id);
    });
  }, []);

  const handleCreateLot = useCallback(async (lot: RawComponentLot) => {
    const timestamp = new Date().toISOString();
    const nextLot = withDerivedRawLotPricing({
      ...lot,
      lot_record_id: normalizeText(lot.lot_record_id) || createRecordId('LOT'),
      createdAt: normalizeText(lot.createdAt) || timestamp,
      updatedAt: timestamp,
      createdBy: normalizeText(lot.createdBy) || DEMO_USER,
      updatedBy: DEMO_USER,
    }) as RawComponentLot;
    updateDemoStore((draft) => {
      draft.rawComponentLots.unshift(nextLot);
    });
  }, []);

  const handleUpdateLot = useCallback(
    async (lotId: string, updates: Partial<RawComponentLot>, reason: string, user: string) => {
      const timestamp = new Date().toISOString();
      updateDemoStore((draft) => {
        const lotIndex = draft.rawComponentLots.findIndex(
          (lot) =>
            sameIdentity(getRawLotRowId(lot), lotId) || sameIdentity(lot.qc_number, lotId),
        );
        if (lotIndex < 0) throw new Error(`Lot ${lotId} was not found.`);

        const previousLot = draft.rawComponentLots[lotIndex];
        const nextLot = withDerivedRawLotPricing({
          ...previousLot,
          ...updates,
          editedAt: timestamp,
          editedBy: user || DEMO_USER,
          updatedAt: timestamp,
          updatedBy: user || DEMO_USER,
        }) as RawComponentLot;
        draft.rawComponentLots[lotIndex] = nextLot;

        const oldBatch = normalizeText(previousLot.qc_number);
        const newBatch = normalizeText(nextLot.qc_number) || oldBatch;
        const linkedIndex = draft.transactions.findIndex(
          (transaction) =>
            transaction.category === 'COMPONENT' &&
            transaction.type === 'IN' &&
            (sameIdentity(transaction.batchNumber, oldBatch) ||
              sameIdentity(transaction.batchNumber, newBatch)),
        );
        if (linkedIndex >= 0) {
          const linked = draft.transactions[linkedIndex];
          const component = draft.items.find((item) => item.component_id === nextLot.itemId);
          const product = draft.products.find((item) => item.sku_id === nextLot.itemId);
          draft.transactions[linkedIndex] = {
            ...linked,
            itemId: nextLot.itemId || linked.itemId,
            itemName: component
              ? formatRawComponentListLabel(component, draft.categories)
              : product
                ? formatFinishedProductInventoryLabel(product)
                : linked.itemName,
            quantity: Number(nextLot.received_qty || 0),
            unit: nextLot.unit || linked.unit,
            location: nextLot.location || linked.location,
            batchNumber: newBatch || linked.batchNumber,
            unitCost: resolveRawLotLandedUnitPrice(nextLot),
            supplier: nextLot.supplier,
            reference: nextLot.procurementRef,
            notes: buildLotLedgerNotes(nextLot),
            editReason: reason || 'Linked lot edit',
            updatedAt: timestamp,
            updatedBy: user || DEMO_USER,
          };
        }
      });
    },
    [],
  );

  const handleDeleteLot = useCallback(async (lotId: string) => {
    updateDemoStore((draft) => {
      draft.rawComponentLots = draft.rawComponentLots.filter(
        (lot) =>
          !sameIdentity(getRawLotRowId(lot), lotId) && !sameIdentity(lot.qc_number, lotId),
      );
    });
  }, []);

  const handleCreateBatch = useCallback(async (batch: Partial<BatchRecord>) => {
    const identity = resolveBatchIdentity(batch);
    if (!identity) throw new Error('Batch ID is required.');
    const timestamp = new Date().toISOString();
    const nextBatch = normalizeBatch({
      ...batch,
      id: identity,
      batch_id: identity,
      createdAt: normalizeText(batch.createdAt) || timestamp,
      updatedAt: timestamp,
    } as BatchRecord);
    updateDemoStore((draft) => {
      if (draft.batches.some((row) => sameIdentity(resolveBatchIdentity(row), identity))) {
        throw new Error(`Batch ${identity} already exists.`);
      }
      draft.batches.unshift(nextBatch);
    });
  }, []);

  const handleUpdateBatch = useCallback(async (batch: BatchRecord) => {
    const identity = resolveBatchIdentity(batch);
    if (!identity) throw new Error('Batch ID is required.');
    updateDemoStore((draft) => {
      const index = draft.batches.findIndex((row) =>
        sameIdentity(resolveBatchIdentity(row), identity),
      );
      const nextBatch = normalizeBatch({
        ...(index >= 0 ? draft.batches[index] : {}),
        ...batch,
        id: identity,
        batch_id: identity,
        updatedAt: new Date().toISOString(),
      } as BatchRecord);
      if (index >= 0) draft.batches[index] = nextBatch;
      else draft.batches.unshift(nextBatch);
    });
  }, []);

  const handleDeleteBatch = useCallback(async (id: string) => {
    updateDemoStore((draft) => {
      draft.batches = draft.batches.filter(
        (batch) => !sameIdentity(resolveBatchIdentity(batch), id),
      );
    });
  }, []);

  const handleRenameBatchReference = useCallback(
    async (oldId: string, newId: string, batch: BatchRecord) => {
      const currentId = normalizeText(oldId);
      const nextId = normalizeText(newId) || currentId;
      if (!currentId || !nextId) throw new Error('Batch ID is required.');

      updateDemoStore((draft) => {
        const index = draft.batches.findIndex((row) =>
          sameIdentity(resolveBatchIdentity(row), currentId),
        );
        const nextBatch = normalizeBatch({
          ...(index >= 0 ? draft.batches[index] : {}),
          ...batch,
          id: nextId,
          batch_id: nextId,
          updatedAt: new Date().toISOString(),
        } as BatchRecord);
        if (index >= 0) draft.batches[index] = nextBatch;
        else draft.batches.unshift(nextBatch);

        if (!sameIdentity(currentId, nextId)) {
          draft.batches = draft.batches.map((row) =>
            sameIdentity(row.parentBulkBatchId, currentId)
              ? { ...row, parentBulkBatchId: nextId }
              : row,
          );
          draft.transactions = draft.transactions.map((transaction) =>
            transaction.category === 'PRODUCT' &&
            sameIdentity(transaction.batchNumber, currentId)
              ? { ...transaction, batchNumber: nextId, updatedAt: new Date().toISOString() }
              : transaction,
          );
        }
      });
    },
    [],
  );

  const handleReleaseBatch = useCallback(async (batch: BatchRecord) => {
    await handleUpdateBatch({
      ...batch,
      id: resolveBatchIdentity(batch),
      batch_id: resolveBatchIdentity(batch),
      status: 'Released',
      updatedAt: new Date().toISOString(),
    });
  }, [handleUpdateBatch]);

  const handleEditProductInActivity = useCallback(
    async (payload: {
      transactionId: string;
      originalBatchId: string;
      nextBatchId: string;
      batch: BatchRecord;
      ledgerUpdates: Partial<InventoryTransaction>;
      user: string;
    }) => {
      const originalBatchId = normalizeText(payload.originalBatchId);
      const nextBatchId = normalizeText(payload.nextBatchId) || originalBatchId;
      if (!payload.transactionId || !originalBatchId || !nextBatchId) {
        throw new Error('Transaction and batch IDs are required.');
      }

      updateDemoStore((draft) => {
        const batchIndex = draft.batches.findIndex((row) =>
          sameIdentity(resolveBatchIdentity(row), originalBatchId),
        );
        if (batchIndex < 0) throw new Error(`Batch ${originalBatchId} was not found.`);
        const nextBatch = normalizeBatch({
          ...draft.batches[batchIndex],
          ...payload.batch,
          id: nextBatchId,
          batch_id: nextBatchId,
          updatedAt: new Date().toISOString(),
        });
        draft.batches[batchIndex] = nextBatch;
        draft.batches = draft.batches.map((row) =>
          sameIdentity(row.parentBulkBatchId, originalBatchId)
            ? { ...row, parentBulkBatchId: nextBatchId }
            : row,
        );
        draft.transactions = draft.transactions.map((transaction) => {
          if (transaction.id === payload.transactionId) {
            return {
              ...transaction,
              ...payload.ledgerUpdates,
              batchNumber: nextBatchId,
              editReason: 'Product In recent activity edit',
              updatedAt: new Date().toISOString(),
              updatedBy: payload.user || DEMO_USER,
            };
          }
          return transaction.category === 'PRODUCT' &&
            sameIdentity(transaction.batchNumber, originalBatchId)
            ? { ...transaction, batchNumber: nextBatchId }
            : transaction;
        });
      });
    },
    [],
  );

  const handleDeleteProductInActivity = useCallback(
    async (transaction: InventoryTransaction, linkedBatch?: ProductBatch | null) => {
      const batchId = normalizeText(
        linkedBatch?.batch_id || linkedBatch?.id || transaction.batchNumber,
      );
      updateDemoStore((draft) => {
        draft.transactions = draft.transactions.filter((row) => row.id !== transaction.id);
        if (batchId) {
          draft.batches = draft.batches.filter(
            (row) => !sameIdentity(resolveBatchIdentity(row), batchId),
          );
        }
      });
    },
    [],
  );

  const handlePersistItem = useCallback(
    async (item: Component, originalId?: string): Promise<{ success: boolean; error?: string }> => {
      try {
        const itemId = normalizeText(item.component_id);
        if (!itemId) return { success: false, error: 'Component ID is required.' };
        updateDemoStore((draft) => {
          const oldId = normalizeText(originalId);
          const existingWithNewId = draft.items.find(
            (row) => sameIdentity(row.component_id, itemId) && !sameIdentity(row.component_id, oldId),
          );
          if (oldId && !sameIdentity(oldId, itemId) && existingWithNewId) {
            throw new Error(`Component ID ${itemId} already exists.`);
          }

          const timestamp = new Date().toISOString();
          const persistedItem: Component = {
            ...item,
            component_id: itemId,
            updatedAt: timestamp,
            updatedBy: DEMO_USER,
            createdAt: item.createdAt || timestamp,
          };
          const lookupId = oldId || itemId;
          const index = draft.items.findIndex((row) => sameIdentity(row.component_id, lookupId));
          if (index >= 0) draft.items[index] = persistedItem;
          else draft.items.push(persistedItem);

          if (oldId && !sameIdentity(oldId, itemId)) {
            const itemName = formatRawComponentListLabel(persistedItem, draft.categories);
            draft.recipes = draft.recipes.map((line) => ({
              ...line,
              component_id: sameIdentity(line.component_id, oldId)
                ? itemId
                : line.component_id,
              ref_id: sameIdentity(line.ref_id, oldId) ? itemId : line.ref_id,
            }));
            draft.transactions = draft.transactions.map((transaction) =>
              transaction.category === 'COMPONENT' && sameIdentity(transaction.itemId, oldId)
                ? { ...transaction, itemId, itemName }
                : transaction,
            );
            draft.rawComponentLots = draft.rawComponentLots.map((lot) =>
              sameIdentity(lot.itemId, oldId) ? { ...lot, itemId } : lot,
            );
          }
        });
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    [],
  );

  const handleArchiveItem = useCallback(async (id: string, restore = false) => {
    updateDemoStore((draft) => {
      draft.items = draft.items.map((item) =>
        sameIdentity(item.component_id, id)
          ? {
              ...item,
              category: restore
                ? getDefaultRawComponentCategory(item.type)
                : getArchivedRawComponentCategory(item.type),
              updatedAt: new Date().toISOString(),
              updatedBy: DEMO_USER,
            }
          : item,
      );
    });
  }, []);

  const handlePersistProduct = useCallback(
    async (product: Product, originalId?: string): Promise<{ success: boolean; error?: string }> => {
      try {
        const productId = normalizeText(product.sku_id);
        if (!productId) return { success: false, error: 'Product SKU is required.' };
        updateDemoStore((draft) => {
          const oldId = normalizeText(originalId);
          const existingWithNewId = draft.products.find(
            (row) => sameIdentity(row.sku_id, productId) && !sameIdentity(row.sku_id, oldId),
          );
          if (oldId && !sameIdentity(oldId, productId) && existingWithNewId) {
            throw new Error(`Product SKU ${productId} already exists.`);
          }

          const timestamp = new Date().toISOString();
          const persistedProduct: Product = {
            ...product,
            sku_id: productId,
            updatedAt: timestamp,
            updatedBy: DEMO_USER,
            createdAt: product.createdAt || timestamp,
          };
          const lookupId = oldId || productId;
          const index = draft.products.findIndex((row) => sameIdentity(row.sku_id, lookupId));
          if (index >= 0) draft.products[index] = persistedProduct;
          else draft.products.push(persistedProduct);

          if (oldId && !sameIdentity(oldId, productId)) {
            const productName = formatFinishedProductInventoryLabel(persistedProduct);
            draft.recipes = draft.recipes.map((line) => ({
              ...line,
              sku_id: sameIdentity(line.sku_id, oldId) ? productId : line.sku_id,
              component_id: sameIdentity(line.component_id, oldId)
                ? productId
                : line.component_id,
              ref_id: sameIdentity(line.ref_id, oldId) ? productId : line.ref_id,
            }));
            draft.batches = draft.batches.map((batch) =>
              sameIdentity(batch.productSku, oldId)
                ? { ...batch, productSku: productId, productName }
                : batch,
            );
            draft.transactions = draft.transactions.map((transaction) =>
              transaction.category === 'PRODUCT' && sameIdentity(transaction.itemId, oldId)
                ? { ...transaction, itemId: productId, itemName: productName }
                : transaction,
            );
          }
        });
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    [],
  );

  const handleDeleteProduct = useCallback(async (id: string) => {
    updateDemoStore((draft) => {
      draft.products = draft.products.filter((product) => !sameIdentity(product.sku_id, id));
      draft.recipes = draft.recipes.filter((line) => !sameIdentity(line.sku_id, id));
    });
  }, []);

  const handleAddCategory = useCallback(async (category: Partial<CategoryMaster>) => {
    const type = category.type;
    const code = normalizeText(category.category_code);
    const label = normalizeText(category.category_label);
    if (!type || !code || !label) throw new Error('Type, category code and label are required.');
    updateDemoStore((draft) => {
      if (
        draft.categories.some(
          (row) => row.type === type && sameIdentity(row.category_code, code),
        )
      ) {
        throw new Error(`Category ${type} ${code} already exists.`);
      }
      const timestamp = new Date().toISOString();
      draft.categories.push({
        ...category,
        id: category.id || createRecordId('CAT'),
        type,
        category_code: code,
        category_label: label,
        createdAt: category.createdAt || timestamp,
        updatedAt: timestamp,
        updatedBy: DEMO_USER,
      });
    });
  }, []);

  const handleDeleteCategory = useCallback(async (category: Partial<CategoryMaster>) => {
    updateDemoStore((draft) => {
      draft.categories = draft.categories.filter((row) =>
        category.id
          ? !sameIdentity(row.id, category.id)
          : !(
              row.type === category.type &&
              sameIdentity(row.category_code, category.category_code)
            ),
      );
    });
  }, []);

  const handleAddRawComponentDisplayName = useCallback(
    async (row: RawComponentDisplayNameMaster) => {
      updateDemoStore((draft) => {
        if (draft.rawComponentDisplayNames.some((entry) => sameIdentity(entry.id, row.id))) {
          throw new Error(`Display-name record ${row.id} already exists.`);
        }
        const timestamp = new Date().toISOString();
        draft.rawComponentDisplayNames.push({
          ...row,
          createdAt: row.createdAt || timestamp,
          updatedAt: timestamp,
          updatedBy: DEMO_USER,
        });
      });
    },
    [],
  );

  const handleDeleteRawComponentDisplayName = useCallback(async (id: string) => {
    updateDemoStore((draft) => {
      draft.rawComponentDisplayNames = draft.rawComponentDisplayNames.filter(
        (row) => !sameIdentity(row.id, id),
      );
    });
  }, []);

  const handleUpsertQuarantineMeta = useCallback(
    async (payload: {
      docId: string;
      group: string;
      reason: string;
      note: string;
      user: string;
    }) => {
      updateDemoStore((draft) => {
        const timestamp = new Date().toISOString();
        const record = {
          doc_id: payload.docId,
          doc_type: 'COMP_OUT_QUARANTINE_META',
          reference_id: payload.group,
          content_summary: `Reason: ${payload.reason || 'Production'} | Note: ${payload.note || ''}`,
          quarantine_group: payload.group,
          quarantine_reason: payload.reason,
          quarantine_note: payload.note,
          updatedBy: payload.user || DEMO_USER,
          updatedAt: timestamp,
        };
        const index = draft.documents.findIndex((document) =>
          sameIdentity(document.doc_id, payload.docId),
        );
        if (index >= 0) draft.documents[index] = { ...draft.documents[index], ...record };
        else draft.documents.unshift({ ...record, createdAt: timestamp });
      });
    },
    [],
  );

  const renderActiveView = () => {
    if (activeTab === 'master') {
      return (
        <MasterDataView
          currentUser={DEMO_USER}
          userRole={DEMO_ROLE}
          inventory={database.items}
          setInventory={setInventory}
          products={database.products}
          setProducts={setProducts}
          bom={database.recipes}
          setBom={setBom}
          categories={database.categories}
          rawComponentDisplayNames={database.rawComponentDisplayNames}
          onPersistItem={handlePersistItem}
          onArchiveItem={handleArchiveItem}
          onPersistProduct={handlePersistProduct}
          onDeleteProduct={handleDeleteProduct}
          onPersistBom={() => undefined}
          onAddCategory={handleAddCategory}
          onDeleteCategory={handleDeleteCategory}
          onAddRawComponentDisplayName={handleAddRawComponentDisplayName}
          onDeleteRawComponentDisplayName={handleDeleteRawComponentDisplayName}
          isReadOnly={false}
        />
      );
    }

    if (activeTab === 'manufacturing') {
      return (
        <ManufacturingPlanningView
          currentUser={DEMO_USER}
          userRole={DEMO_ROLE}
          products={database.products}
          inventory={database.items}
          categories={database.categories}
          bom={database.recipes}
          transactions={database.transactions}
          suppliers={DEMO_SUPPLIERS}
          openPos={DEMO_OPEN_POS}
          rawComponentLots={database.rawComponentLots}
          productBatches={productBatches}
          batchRecords={database.batches}
          isReadOnly={false}
          settings={appSettings}
        />
      );
    }

    return (
      <InventoryManagerView
        currentUser={DEMO_USER}
        userRole={DEMO_ROLE}
        inventory={database.items}
        products={database.products}
        categories={database.categories}
        documents={database.documents}
        transactions={database.transactions}
        stockBalances={[]}
        ingredientBatches={ingredientBatches}
        rawComponentLots={database.rawComponentLots}
        productBatches={productBatches}
        suppliers={DEMO_SUPPLIERS}
        onTransaction={handleTransaction}
        onEditTransaction={handleEditTransaction}
        onDeleteTransaction={handleDeleteTransaction}
        onEditProductInActivity={handleEditProductInActivity}
        onDeleteProductInActivity={handleDeleteProductInActivity}
        onCreateLot={handleCreateLot}
        onUpdateLot={handleUpdateLot}
        onDeleteLot={handleDeleteLot}
        onCreateBatch={handleCreateBatch}
        onUpdateBatch={handleUpdateBatch}
        onDeleteBatch={handleDeleteBatch}
        onRenameBatchReference={handleRenameBatchReference}
        onReleaseBatch={handleReleaseBatch}
        onForceSync={handleForceSync}
        onUpsertCompOutQuarantineMeta={handleUpsertQuarantineMeta}
        isReadOnly={false}
        isTransactionDataReady
        isDashboardDataReady
        isStockBalanceDataReady
        hasRelevantPendingChanges={false}
      />
    );
  };

  return (
    <Layout
      activeTab={activeTab}
      onTabChange={(tab) => {
        if (APP_TABS.includes(tab as AppTab)) setActiveTab(tab as AppTab);
      }}
      allowedTabs={APP_TABS}
      isSyncing={isRefreshing}
      onForceSync={handleForceSync}
      currentUser={DEMO_USER}
      syncStatusText={isRefreshing ? 'Refreshing' : 'Saved locally'}
      syncStatusTone={isRefreshing ? 'neutral' : 'success'}
    >
      <div className="mb-4 flex flex-col gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-950 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <p>
          Public demo mode: all records are synthetic and changes stay in this browser.
        </p>
        <button
          type="button"
          onClick={handleResetDemo}
          className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-lg border border-blue-300 bg-white px-3 py-2 text-xs font-bold text-blue-800 transition hover:bg-blue-100"
        >
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          Reset demo data
        </button>
      </div>
      {renderActiveView()}
    </Layout>
  );
};

export default App;
