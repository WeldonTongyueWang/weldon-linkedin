/**
 * HARD BOUNDARY: COMP OUT CHANGE REQUEST
 * 
 * AUTHORITY: Inventory Dispatch Logic (Staging/Transfer).
 * RULES:
 * 1. All deductions must be reversible or compensatable.
 * 2. No master data edits allowed.
 * 3. Dispatch must be validated against available batch stock.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { CategoryMaster, Component, InventoryTransaction, LocationName, Product, ComponentType, RawComponentLot, ProductBatch } from '../../types';
import { CheckCircle, AlertTriangle, ArrowRight, XCircle, Package, History, Lock, Info, Loader2, Edit, Save, X, ArrowRightLeft, MapPin, Download, Truck, ShoppingCart, ArrowUpRight, ArrowDownLeft, Layers, ChevronDown, ChevronRight } from 'lucide-react';
import { createDocument } from '../../services/sheetsApi';
import { computeLedgerStockLevels, UNBATCHED_KEY } from '../../services/ledgerStock';
import { resolveLedgerEventTime } from '../../services/ledgerTime';
import { ActivityFilterBar } from './ActivityFilterBar';
import { SortableHeader } from './SortableHeader';
import { useAppDialog } from '../ui/AppDialogProvider';
import { useIsHandheldDevice } from '../../lib/useIsHandheldDevice';
import { formatBritishDateTime } from '../../lib/dateFormatting';
import { formatRawComponentListLabel, stripLeadingCode } from '../../utils/rawComponentLabels';
import { formatFinishedProductInventoryLabel } from '../../utils/finishedProductLabels';
import {
  DUAL_PATH_DUPLICATE_WINDOW_MS,
  findDualPathDuplicateEvent,
  isDualPathItem
} from '../../utils/dualPathItems';

const UI_ITEM_CATEGORIES = [
  'consumables',
  'dispensing',
  'ingredients',
  'intermediates',
  'comp a',
  'single sachet',
  'label',
  'primary packaging',
  'secondary packaging'
] as const;
type UiItemCategory = (typeof UI_ITEM_CATEGORIES)[number];
const UI_ITEM_CATEGORY_LABELS: Record<UiItemCategory, string> = {
  consumables: 'Consumables',
  dispensing: 'Dispensing',
  ingredients: 'Ingredients',
  intermediates: 'Intermediates',
  'comp a': 'Comp A',
  'single sachet': 'Single Sachet',
  label: 'Label',
  'primary packaging': 'Primary Packaging',
  'secondary packaging': 'Secondary Packaging'
};

interface Props {
  inventory: Component[];
  categories?: CategoryMaster[];
  products: Product[];
  documents?: any[];
  transactions: InventoryTransaction[];
  rawComponentLots?: RawComponentLot[];
  productBatches?: ProductBatch[];
  currentUser: string;
  onTransaction: (
    tx: Omit<InventoryTransaction, 'id' | 'date' | 'unit'> & { unit?: string }
  ) => Promise<InventoryTransaction | void> | InventoryTransaction | void;
  onEditTransaction: (txId: string, updates: Partial<InventoryTransaction>, reason: string, user: string) => Promise<void> | void;
  onDeleteTransaction: (txId: string, skipConfirmation?: boolean) => Promise<void> | void;
  onUpsertQuarantineMeta?: (payload: { docId: string; group: string; reason: string; note: string; user: string }) => Promise<void> | void;
  isReadOnly?: boolean;
}

const normalizeSearchText = (value: unknown): string =>
  String(value ?? '').toLowerCase().trim();

const matchesSearch = (fields: Array<unknown>, query: string): boolean => {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return true;
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const normalizedFields = fields.map(normalizeSearchText);
  return tokens.every((token) => normalizedFields.some((field) => field.includes(token)));
};

const getDateOnlyValue = (value: string): string => {
  const source = String(value || '').trim();
  if (!source) return '';
  const matched = source.match(/^\d{4}-\d{2}-\d{2}/);
  if (matched) return matched[0];
  const timestamp = new Date(source).getTime();
  if (!Number.isFinite(timestamp)) return '';
  return new Date(timestamp).toISOString().slice(0, 10);
};

const getDefaultLast60DaysRange = (): { from: string; to: string } => {
  const toDate = new Date();
  const fromDate = new Date(toDate);
  fromDate.setDate(fromDate.getDate() - 59);
  return {
    from: fromDate.toISOString().slice(0, 10),
    to: toDate.toISOString().slice(0, 10),
  };
};

const escapeCsv = (value: string | number): string => {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
};

const useDebouncedValue = (value: string, delayMs: number): string => {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeoutId = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timeoutId);
  }, [value, delayMs]);
  return debounced;
};

type CompOutStatusFilter = 'all' | 'unreleased' | 'released';
type CompOutGroupSortMode = 'latest_desc' | 'latest_asc' | 'qty_desc' | 'qty_asc' | 'item_asc' | 'item_desc';
type CompOutRowSortKey = 'date' | 'batch' | 'item' | 'qty';
type CompOutMode = 'USAGE' | 'TRANSFER' | 'MANUAL';

const COMP_OUT_MANUAL_ADJUSTMENT_REASON = 'Manual Adjustment';
const COMP_OUT_MANUAL_ADJUSTMENT_NOTE = 'Manual adjustment';
const QUANTITY_EPSILON = 0.000001;

interface CompOutGroupEntry {
  group: string;
  items: InventoryTransaction[];
  latestActivityTs: number;
  totalQty: number;
  firstItemName: string;
}

interface CompOutBatchOption {
  batch: string;
  displayBatch: string;
  qty: number;
}

const getOppositeLocation = (location: LocationName): LocationName =>
  location === 'Riverside' ? 'Hilltop' : 'Riverside';

const buildTransferReason = (sourceLocation: LocationName): string =>
  `Transfer to ${getOppositeLocation(sourceLocation)}`;

const buildTransferNote = (sourceLocation: LocationName): string =>
  `Inter-site transfer: ${sourceLocation} to ${getOppositeLocation(sourceLocation)}`;

const parseTransferDestination = (reason: string | undefined): LocationName | null => {
  const match = String(reason || '').trim().match(/^transfer to\s+(.+)$/i);
  if (!match) return null;
  const candidate = String(match[1] || '').trim();
  return candidate === 'Riverside' || candidate === 'Hilltop' ? candidate : null;
};

const buildLegacyTransferGroupName = (tx: InventoryTransaction): string => {
  const dateSegment = getDateOnlyValue(resolveLedgerEventTime(tx) || '').replaceAll('-', '') || 'TRANSFER';
  const destination = parseTransferDestination(tx.reason) || getOppositeLocation(tx.location);
  return `${dateSegment} ${tx.location} to ${destination} Transfer`;
};

const normalizeCompOutReasonForSelector = (tx: InventoryTransaction): string => {
  if (tx.sourceTab === 'Transfer') return 'Transfer';
  const rawReason = String(tx.reason || '').trim();
  const rawNotes = String(tx.notes || '').trim();
  const rawReference = String(tx.reference || '').trim();
  if (
    /^manual\b/i.test(rawReason) ||
    /^manual adjustment\b/i.test(rawNotes) ||
    /manual adjustment/i.test(rawReference)
  ) {
    return COMP_OUT_MANUAL_ADJUSTMENT_REASON;
  }
  if (/^transfer\b/i.test(rawReason)) return 'Transfer';
  if (/^waste\b/i.test(rawReason)) return 'Waste';
  if (/^sampling\b/i.test(rawReason)) return 'Sampling';
  return 'Production';
};

const resolveCompOutReleaseReason = (
  tx: InventoryTransaction,
  selectedReason: string
): string => {
  if (tx.sourceTab === 'Transfer' && selectedReason === 'Transfer') {
    return buildTransferReason(tx.location);
  }
  return selectedReason;
};

const isManualAdjustmentReason = (reason: string | undefined): boolean =>
  String(reason || '').trim() === COMP_OUT_MANUAL_ADJUSTMENT_REASON;

const isLegacyTransferQuarantineTx = (tx: InventoryTransaction): boolean =>
  tx.type === 'OUT' &&
  tx.sourceTab === 'Transfer' &&
  /^transfer to\s+/i.test(String(tx.reason || '').trim()) &&
  !String(tx.reference || '').trim();

const getActionErrorMessage = (error: unknown, fallback: string): string => {
  const message = error instanceof Error ? error.message : String(error || '').trim();
  return message ? `${fallback}\n\nReason: ${message}` : fallback;
};

const isCompOutUnreleased = (tx: InventoryTransaction): boolean =>
  tx.reason === 'RESERVATION' || isLegacyTransferQuarantineTx(tx);

const resolveCompOutGroupName = (tx: InventoryTransaction): string => {
  const reference = String(tx.reference || '').trim();
  if (reference) return reference;
  if (tx.sourceTab === 'Transfer' && /^transfer to\s+/i.test(String(tx.reason || '').trim())) {
    return buildLegacyTransferGroupName(tx);
  }
  return 'Main Dispatch';
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const ComponentDispatch: React.FC<Props> = ({ 
  inventory, categories = [], products, documents = [], transactions, rawComponentLots = [], productBatches = [], currentUser, onTransaction, onEditTransaction, onDeleteTransaction, onUpsertQuarantineMeta, isReadOnly
}) => {
  const isHandheldDevice = useIsHandheldDevice();
  const appDialog = useAppDialog();
  const defaultActivityDateRange = useMemo(() => getDefaultLast60DaysRange(), []);
  const getTodayCompactDate = () => new Date().toLocaleDateString('en-CA').replace(/-/g, '');
  const getDefaultDispatchName = () => `${getTodayCompactDate()} Main Dispatch`;
  const getDefaultTransferDispatchName = (source: LocationName, destination: LocationName) =>
    `${getTodayCompactDate()} ${source} to ${destination} Transfer`;
  const getDefaultManualAdjustmentName = () => `${getTodayCompactDate()} Manual Adjustment`;
  const [activeTab, setActiveTab] = useState<CompOutMode>('USAGE');
  
  const [compOut, setCompOut] = useState({ 
    itemId: '', 
    quantity: 0, 
    batchId: '', 
    category: 'COMPONENT' as InventoryTransaction['category'],
    location: 'Riverside' as LocationName,
    destination: 'Hilltop' as LocationName, 
    unit: '' 
  });
  const [compOutQuantityInput, setCompOutQuantityInput] = useState<string>('');
  const [selectedCompOutCategory, setSelectedCompOutCategory] = useState<UiItemCategory | ''>('');
  const [activityDraftFromDate, setActivityDraftFromDate] = useState(defaultActivityDateRange.from);
  const [activityDraftToDate, setActivityDraftToDate] = useState(defaultActivityDateRange.to);
  const [activityDraftStatus, setActivityDraftStatus] = useState<CompOutStatusFilter>('all');
  const [activityDraftSearchInput, setActivityDraftSearchInput] = useState('');
  const debouncedActivityDraftSearch = useDebouncedValue(activityDraftSearchInput, 300);
  const [activityAppliedFromDate, setActivityAppliedFromDate] = useState(defaultActivityDateRange.from);
  const [activityAppliedToDate, setActivityAppliedToDate] = useState(defaultActivityDateRange.to);
  const [activityAppliedStatus, setActivityAppliedStatus] = useState<CompOutStatusFilter>('all');
  const [activityAppliedSearchQuery, setActivityAppliedSearchQuery] = useState('');
  const activityFilterGridClass = isHandheldDevice
    ? 'grid grid-cols-1 gap-2'
    : 'grid grid-cols-1 md:grid-cols-3 gap-2';
  const [groupSortMode, setGroupSortMode] = useState<CompOutGroupSortMode>('latest_desc');
  const [rowSortState, setRowSortState] = useState<{ key: CompOutRowSortKey; dir: 'asc' | 'desc' }>({
    key: 'date',
    dir: 'asc',
  });
  const filterFieldClass = 'w-full h-11 border border-slate-300 rounded bg-white px-3 text-base sm:text-sm shadow-none';

  const [dispatchRef, setDispatchRef] = useState<string>(() => getDefaultDispatchName());
  const [isDispatchRefAuto, setIsDispatchRefAuto] = useState(true);
  const [allowExistingDispatchRef, setAllowExistingDispatchRef] = useState(false);
  const [groupInputs, setGroupInputs] = useState<Record<string, { reason: string, note: string }>>({});
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const dispatchRefInputRef = useRef<HTMLInputElement | null>(null);
  const quarantineNameClickTimerRef = useRef<number | null>(null);
  
  const [isReserving, setIsReserving] = useState(false);
  const [processingTxId, setProcessingTxId] = useState<string | null>(null);
  const [isModalActionLoading, setIsModalActionLoading] = useState(false);
  const [updatingActiveGroupKey, setUpdatingActiveGroupKey] = useState<string | null>(null);
  const [renamingActiveGroupKey, setRenamingActiveGroupKey] = useState<string | null>(null);

  const [editingTxId, setEditingTxId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{
      itemId: string;
      batchNumber: string;
      quantity: number;
      unit: string;
  } | null>(null);
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  const [modalConfig, setModalConfig] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    type: 'info' | 'warning' | 'danger';
    onConfirm?: () => Promise<void> | void;
    showCancel?: boolean;
  } | null>(null);

  // Helper to resolve display name dynamically from master data
  const resolveItemDisplay = (itemId: string, fallbackName?: string) => {
      const comp = inventory.find(c => c.component_id === itemId);
      if (comp) return formatRawComponentListLabel(comp, categories);
      const prod = products.find(p => p.sku_id === itemId);
      if (prod) return formatFinishedProductInventoryLabel(prod);
      return fallbackName || itemId;
  };

  const transferDestination = getOppositeLocation(compOut.location);

  useEffect(() => {
      if (!isDispatchRefAuto) return;
      if (activeTab === 'TRANSFER') {
          setDispatchRef(getDefaultTransferDispatchName(compOut.location, transferDestination));
          return;
      }
      if (activeTab === 'MANUAL') {
          setDispatchRef(getDefaultManualAdjustmentName());
          return;
      }
      setDispatchRef(getDefaultDispatchName());
  }, [activeTab, compOut.location, transferDestination, isDispatchRefAuto]);

  useEffect(() => {
      return () => {
          if (quarantineNameClickTimerRef.current !== null) {
              window.clearTimeout(quarantineNameClickTimerRef.current);
          }
      };
  }, []);

  const buildQuarantineMetaDocId = (group: string) =>
    `DOC-COMP-OUT-QMETA-${String(group || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'UNTITLED'}`;

  const quarantineMetadataByGroup = useMemo(() => {
      const map = new Map<string, { docId: string; reason: string; note: string }>();
      documents.forEach((doc) => {
          const docType = String(doc?.doc_type || '').trim().toUpperCase();
          if (docType !== 'COMP_OUT_QUARANTINE_META') return;
          const group = String(doc?.quarantine_group || doc?.reference_id || '').trim();
          if (!group) return;
          map.set(group, {
              docId: String(doc?.doc_id || buildQuarantineMetaDocId(group)).trim(),
              reason: String(doc?.quarantine_reason || '').trim(),
              note: String(doc?.quarantine_note || '').trim(),
          });
      });
      return map;
  }, [documents]);

  const getQuarantineMetaDocIdForGroup = (group: string): string =>
      quarantineMetadataByGroup.get(group)?.docId || buildQuarantineMetaDocId(group);

  const componentStockLevels = useMemo(
    () => computeLedgerStockLevels(transactions.filter(tx => tx.category === 'COMPONENT'), rawComponentLots, []),
    [transactions, rawComponentLots]
  );

  const productStockLevels = useMemo(
    () => computeLedgerStockLevels(transactions.filter(tx => tx.category === 'PRODUCT'), [], productBatches),
    [transactions, productBatches]
  );

  const sharedStockLevels = useMemo(
    () => computeLedgerStockLevels(transactions, rawComponentLots, productBatches),
    [transactions, rawComponentLots, productBatches]
  );

  const dualPathFormatBySku = useMemo(() => {
      const map = new Map<string, string>();
      products.forEach((product) => {
          map.set(String(product.sku_id || '').trim().toUpperCase(), String(product.format || ''));
      });
      return map;
  }, [products]);

  const getDualPathFormat = (itemId: string): string =>
      dualPathFormatBySku.get(String(itemId || '').trim().toUpperCase()) || '';

  const resolveStockLevelsForItem = (
      itemId: string,
      category: InventoryTransaction['category'] | undefined,
  ) => {
      if (isDualPathItem(itemId, getDualPathFormat(itemId))) return sharedStockLevels;
      return category === 'PRODUCT' ? productStockLevels : componentStockLevels;
  };

  // Calculate global stock levels to filter dropdown
  const stockMap = useMemo(() => {
    const map: Record<string, number> = {};
    inventory.forEach(item => {
      const levels = resolveStockLevelsForItem(item.component_id, 'COMPONENT');
      map[`COMPONENT:${item.component_id}`] = Number(levels[item.component_id]?.totalAvailable || 0);
    });
    products.forEach(product => {
      const levels = resolveStockLevelsForItem(product.sku_id, 'PRODUCT');
      map[`PRODUCT:${product.sku_id}`] = Number(levels[product.sku_id]?.totalAvailable || 0);
    });
    return map;
  }, [inventory, products, componentStockLevels, productStockLevels, sharedStockLevels, dualPathFormatBySku]);

  const compOptions = useMemo(() => {
    const resolveGroupLabel = (type: Component['type']): string => {
      const groupMap: Partial<Record<Component['type'], string>> = {
        CONSUMABLE: 'Consumables',
        DISPENSING: 'Dispensing',
        INGREDIENT: 'Ingredients',
        LABEL: 'Label',
        PALLET_LOGISTICS: 'Pallet Logistics',
        PALLET: 'Pallet Logistics',
        PRIMARY_PACKAGING: 'Primary Packaging',
        SECONDARY_PACKAGING: 'Secondary Packaging'
      };
      return groupMap[type] || type.replace('_', ' ');
    };

    const resolveUiCategory = (type: Component['type']): UiItemCategory | '' => {
      switch (type) {
        case 'CONSUMABLE':
          return 'consumables';
        case 'DISPENSING':
          return 'dispensing';
        case 'INGREDIENT':
          return 'ingredients';
        case 'LABEL':
          return 'label';
        case 'PRIMARY_PACKAGING':
          return 'primary packaging';
        case 'SECONDARY_PACKAGING':
          return 'secondary packaging';
        default:
          return '';
      }
    };

    const groupOrder: Record<string, number> = {
      Consumables: 1,
      Dispensing: 2,
      Ingredients: 3,
      Intermediates: 4,
      'Comp A': 5,
      'Single Sachet': 6,
      Label: 7,
      'Pallet Logistics': 8,
      'Primary Packaging': 9,
      'Secondary Packaging': 10
    };

    const rawItems = inventory
        .filter(i => activeTab === 'MANUAL' || (stockMap[`COMPONENT:${i.component_id}`] || 0) > 0.0001)
        .map(i => ({
            id: i.component_id,
            name: formatRawComponentListLabel(i, categories),
            unit: i.default_unit || "unit",
            group: resolveGroupLabel(i.type),
            uiCategory: resolveUiCategory(i.type),
            category: 'COMPONENT' as InventoryTransaction['category'],
            note: i.notes || ""
        }));

    const hasSelectableProductStock = (product: Product): boolean =>
      activeTab === 'MANUAL' || (stockMap[`PRODUCT:${product.sku_id}`] || 0) > 0.0001;
    const normalizedProductName = (product: Product): string => String(product.sku_name || '').toLowerCase();

    const productItemsByCategory = products
      .filter(hasSelectableProductStock)
      .map((product) => {
        const normalizedName = normalizedProductName(product);
        const isCompA = normalizedName.includes('comp a') || normalizedName.includes('compa');
        const isSingleSachet = normalizedName.includes('single sachet');
        const normalizedFormat = String(product.format || '').toLowerCase();
        const isIntermediate = !isCompA && !isSingleSachet && normalizedFormat.includes('blended');

        let uiCategory: UiItemCategory | null = null;
        let group: string = '';
        if (isCompA) {
          uiCategory = 'comp a';
          group = 'Comp A';
        } else if (isSingleSachet) {
          uiCategory = 'single sachet';
          group = 'Single Sachet';
        } else if (isIntermediate) {
          uiCategory = 'intermediates';
          group = 'Intermediates';
        }
        if (!uiCategory) return null;

        return {
          id: product.sku_id,
          name: stripLeadingCode(formatFinishedProductInventoryLabel(product)) || product.sku_id || "Unnamed Product",
          unit: product.default_unit || "kg",
          group,
          uiCategory,
          category: 'PRODUCT' as InventoryTransaction['category'],
          note: product.notes || ""
        };
      })
      .filter((option): option is NonNullable<typeof option> => option !== null);

    return [...rawItems, ...productItemsByCategory].sort((a, b) => {
      const groupDelta = (groupOrder[a.group] || 99) - (groupOrder[b.group] || 99);
      if (groupDelta !== 0) return groupDelta;
      return (a.name || "").localeCompare(b.name || "");
    });
  }, [inventory, products, stockMap, activeTab]);

  const groupedOptions = useMemo(() => {
    const filtered = selectedCompOutCategory
      ? compOptions.filter(opt => opt.uiCategory === selectedCompOutCategory)
      : [];
    const groups: Record<string, typeof filtered> = {};
    filtered.forEach(opt => {
      if (!groups[opt.group]) groups[opt.group] = [];
      groups[opt.group].push(opt);
    });
    return groups;
  }, [compOptions, selectedCompOutCategory]);

  const availableBatches = useMemo(() => {
      if (!compOut.itemId) return [];
      const levels = resolveStockLevelsForItem(compOut.itemId, compOut.category);
      const position = levels[compOut.itemId];
      const normalizeBatchKey = (value: unknown): string => String(value ?? '').trim().toLowerCase();
      const resolveProductBatchIdentity = (batchRecord: ProductBatch): string =>
          String((batchRecord as any).batch_id || batchRecord.id || batchRecord.batch_number || '').trim();
      const resolveBatchDisplay = (batch: string): string => {
          const trimmedBatch = String(batch || '').trim();
          if (compOut.category !== 'PRODUCT') return trimmedBatch;
          const matchedBatch = productBatches.find((batchRecord) =>
              normalizeBatchKey(batchRecord.sku_id) === normalizeBatchKey(compOut.itemId) &&
              (
                normalizeBatchKey(resolveProductBatchIdentity(batchRecord)) === normalizeBatchKey(trimmedBatch) ||
                normalizeBatchKey(batchRecord.batch_number) === normalizeBatchKey(trimmedBatch)
              )
          );
          if (matchedBatch?.batch_number) return String(matchedBatch.batch_number).trim();
          const parts = trimmedBatch.split('::').map((part) => part.trim()).filter(Boolean);
          return parts.length >= 2 ? parts[1] : trimmedBatch;
      };
      const batchMap = new Map<string, CompOutBatchOption>();
      const addBatchOption = (batch: string, qty: number, displayBatch?: string) => {
          const canonicalBatch = String(batch || '').trim();
          if (!canonicalBatch) return;
          const existing = batchMap.get(canonicalBatch);
          const nextQty = Number(qty || 0);
          if (existing) {
              existing.qty = Math.max(existing.qty, nextQty);
              if (!existing.displayBatch && displayBatch) existing.displayBatch = displayBatch;
              return;
          }
          batchMap.set(canonicalBatch, {
              batch: canonicalBatch,
              displayBatch: String(displayBatch || resolveBatchDisplay(canonicalBatch) || canonicalBatch).trim(),
              qty: nextQty,
          });
      };
      if (position) {
          Object.entries(position.byBatch).forEach(([batch]) => {
              if (batch === UNBATCHED_KEY) return;
              addBatchOption(batch, Number(position.byBatchLocation?.[batch]?.[compOut.location]?.available || 0));
          });
      }
      const mergedByDisplay = new Map<string, CompOutBatchOption>();
      Array.from(batchMap.values())
          .filter((row) => activeTab === 'MANUAL' || row.qty > 0.0001)
          .forEach((row) => {
              const displayKey = normalizeBatchKey(row.displayBatch);
              const existing = mergedByDisplay.get(displayKey);
              if (!existing) {
                  mergedByDisplay.set(displayKey, row);
                  return;
              }
              const rowIsCanonical = row.batch.includes('::');
              const existingIsCanonical = existing.batch.includes('::');
              if (
                (existing.qty <= 0 && row.qty > 0) ||
                (!existingIsCanonical && rowIsCanonical && row.qty >= existing.qty)
              ) {
                  mergedByDisplay.set(displayKey, row);
              }
          });
      return Array.from(mergedByDisplay.values())
          .sort((a,b) => a.displayBatch.localeCompare(b.displayBatch, undefined, { sensitivity: 'base' }));
  }, [compOut.itemId, compOut.location, compOut.category, componentStockLevels, productStockLevels, sharedStockLevels, dualPathFormatBySku, activeTab, rawComponentLots, productBatches]);

  const editBatchOptions = useMemo(() => {
      if (!editForm?.itemId) return [];
      const originalTx = transactions.find(t => t.id === editingTxId);
      const levels = resolveStockLevelsForItem(editForm.itemId, originalTx?.category);
      const position = levels[editForm.itemId];
      if (!position) return [];

      const batchMap: Record<string, number> = {};
      Object.entries(position.byBatch).forEach(([batch]) => {
          if (batch === UNBATCHED_KEY) return;
          const location = String(originalTx?.location || '').trim();
          const locationState = location ? position.byBatchLocation?.[batch]?.[location] : undefined;
          const batchState = position.byBatch?.[batch];
          batchMap[batch] = Number((locationState || batchState)?.available || 0);
      });
      if (
          originalTx &&
          originalTx.itemId === editForm.itemId &&
          originalTx.batchNumber
      ) {
          batchMap[originalTx.batchNumber] = (batchMap[originalTx.batchNumber] || 0) + Number(originalTx.quantity);
      }
      return Object.entries(batchMap)
          .filter(([_, qty]) => qty > 0.0001)
          .map(([batch, qty]) => ({ batch, qty }))
          .sort((a,b) => a.qty - b.qty);
  }, [editForm?.itemId, transactions, editingTxId, componentStockLevels, productStockLevels, sharedStockLevels, dualPathFormatBySku]);

  const dispatchOutTransactions = useMemo(() => {
      const isCompOutSource = (tx: InventoryTransaction): boolean =>
          tx.sourceTab === 'Component Out' ||
          tx.sourceTab === 'Transfer' ||
          (tx.category === 'PRODUCT' && tx.sourceTab === 'Staging');
      return transactions.filter((tx) =>
          tx.type === 'OUT' &&
          isCompOutSource(tx) &&
          (tx.category === 'COMPONENT' || tx.category === 'PRODUCT')
      );
  }, [transactions]);

  const filteredDispatchTransactions = useMemo(() => {
      return dispatchOutTransactions.filter((tx) => {
          const eventDate = resolveLedgerEventTime(tx);
          const dateOnly = getDateOnlyValue(eventDate);
          if (activityAppliedFromDate && (!dateOnly || dateOnly < activityAppliedFromDate)) return false;
          if (activityAppliedToDate && (!dateOnly || dateOnly > activityAppliedToDate)) return false;

          const status = isCompOutUnreleased(tx) ? 'unreleased' : 'released';
          if (activityAppliedStatus !== 'all' && status !== activityAppliedStatus) return false;

          const reason = status === 'unreleased'
              ? normalizeCompOutReasonForSelector(tx)
              : String(tx.reason || '').trim();

          return matchesSearch(
            [
              resolveCompOutGroupName(tx),
              tx.batchNumber || '',
              resolveItemDisplay(tx.itemId, tx.itemName),
              tx.itemId || '',
              tx.supplier || '',
              tx.updatedBy || tx.user || '',
              reason,
              tx.notes || '',
              status,
            ],
            activityAppliedSearchQuery
          );
      });
  }, [
    dispatchOutTransactions,
    activityAppliedFromDate,
    activityAppliedToDate,
    activityAppliedStatus,
    activityAppliedSearchQuery,
    inventory,
    products,
  ]);

  const sortedGroupEntries = (entries: CompOutGroupEntry[]): CompOutGroupEntry[] => {
      const next = [...entries];
      next.sort((left, right) => {
          let base = 0;
          switch (groupSortMode) {
            case 'latest_asc':
              base = left.latestActivityTs - right.latestActivityTs;
              break;
            case 'latest_desc':
              base = right.latestActivityTs - left.latestActivityTs;
              break;
            case 'qty_asc':
              base = left.totalQty - right.totalQty;
              break;
            case 'qty_desc':
              base = right.totalQty - left.totalQty;
              break;
            case 'item_desc':
              base = right.firstItemName.localeCompare(left.firstItemName, undefined, { sensitivity: 'base' });
              break;
            case 'item_asc':
            default:
              base = left.firstItemName.localeCompare(right.firstItemName, undefined, { sensitivity: 'base' });
              break;
          }
          if (base !== 0) return base;
          return left.group.localeCompare(right.group, undefined, { sensitivity: 'base' });
      });
      return next;
  };

  const sortGroupRows = (items: InventoryTransaction[]): InventoryTransaction[] => {
      const indexed = items.map((tx, index) => ({ tx, index }));
      indexed.sort((left, right) => {
          let base = 0;
          switch (rowSortState.key) {
            case 'batch':
              base = String(left.tx.batchNumber || '').localeCompare(String(right.tx.batchNumber || ''), undefined, { sensitivity: 'base' });
              break;
            case 'item':
              base = resolveItemDisplay(left.tx.itemId, left.tx.itemName).localeCompare(
                resolveItemDisplay(right.tx.itemId, right.tx.itemName),
                undefined,
                { sensitivity: 'base' }
              );
              break;
            case 'qty':
              base = Number(left.tx.quantity || 0) - Number(right.tx.quantity || 0);
              break;
            case 'date':
            default: {
              const leftTs = new Date(resolveLedgerEventTime(left.tx)).getTime();
              const rightTs = new Date(resolveLedgerEventTime(right.tx)).getTime();
              const leftValue = Number.isFinite(leftTs) ? leftTs : 0;
              const rightValue = Number.isFinite(rightTs) ? rightTs : 0;
              base = leftValue - rightValue;
              break;
            }
          }
          if (base === 0) return left.index - right.index;
          return rowSortState.dir === 'asc' ? base : -base;
      });
      return indexed.map((entry) => entry.tx);
  };

  const buildGroupedEntries = (rows: InventoryTransaction[]): CompOutGroupEntry[] => {
      const groups = new Map<string, InventoryTransaction[]>();
      rows.forEach((tx) => {
          const group = resolveCompOutGroupName(tx);
          if (!groups.has(group)) groups.set(group, []);
          groups.get(group)!.push(tx);
      });

      const entries: CompOutGroupEntry[] = [];
      groups.forEach((items, group) => {
          const sortedItems = sortGroupRows(items);
          const latestActivityTs = Math.max(
            ...sortedItems.map((tx) => {
              const ts = new Date(resolveLedgerEventTime(tx)).getTime();
              return Number.isFinite(ts) ? ts : 0;
            })
          );
          const totalQty = sortedItems.reduce((sum, tx) => sum + Number(tx.quantity || 0), 0);
          const firstItemName = [...new Set(items.map((tx) => resolveItemDisplay(tx.itemId, tx.itemName)))]
            .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }))[0] || '';
          entries.push({ group, items: sortedItems, latestActivityTs, totalQty, firstItemName });
      });
      return sortedGroupEntries(entries);
  };

  const reservedGroupEntries = useMemo(() => {
      return buildGroupedEntries(filteredDispatchTransactions.filter((tx) => isCompOutUnreleased(tx)));
  }, [filteredDispatchTransactions, rowSortState, groupSortMode, inventory, products]);

  const historyGroupEntries = useMemo(() => {
      return buildGroupedEntries(
        filteredDispatchTransactions.filter((tx) => !isCompOutUnreleased(tx))
      );
  }, [filteredDispatchTransactions, rowSortState, groupSortMode, inventory, products]);

  const groupedReservedItems = useMemo<Record<string, InventoryTransaction[]>>(() => {
      const groups: Record<string, InventoryTransaction[]> = {};
      reservedGroupEntries.forEach((entry) => {
        groups[entry.group] = entry.items;
      });
      return groups;
  }, [reservedGroupEntries]);

  const groupedActivityHistory = useMemo<Record<string, InventoryTransaction[]>>(() => {
      const groups: Record<string, InventoryTransaction[]> = {};
      historyGroupEntries.forEach((entry) => {
        groups[entry.group] = entry.items;
      });
      return groups;
  }, [historyGroupEntries]);

  const activeQuarantineNames = useMemo(() => {
      const names = new Set<string>();
      reservedGroupEntries.forEach((entry) => {
          const groupName = String(entry.group || '').trim();
          if (groupName) names.add(groupName);
      });
      return names;
  }, [reservedGroupEntries]);

  const releasedQuarantineNames = useMemo(() => {
      const names = new Set<string>();
      historyGroupEntries.forEach((entry) => {
          const groupName = String(entry.group || '').trim();
          if (groupName) names.add(groupName);
      });
      return names;
  }, [historyGroupEntries]);

  const hasReservedItems = reservedGroupEntries.length > 0;
  const hasHistoryItems = historyGroupEntries.length > 0;
  const parsedCompOutQuantity = Number(compOutQuantityInput);
  const hasValidCompOutQuantity = compOutQuantityInput.trim() !== '' && Number.isFinite(parsedCompOutQuantity);
  const canSubmitCompOutQuantity = hasValidCompOutQuantity && (
      activeTab === 'MANUAL'
        ? Math.abs(parsedCompOutQuantity) >= 0.001
        : parsedCompOutQuantity >= 0.001
  );

  const deriveGroupStateFromItems = (items: InventoryTransaction[] | undefined) => {
      if (!items || items.length === 0) return null;
      const firstTx = items[0];
      return {
          reason: normalizeCompOutReasonForSelector(firstTx),
          note: firstTx.notes || (firstTx.sourceTab === 'Transfer' ? buildTransferNote(firstTx.location) : '')
      };
  };

  const getGroupState = (group: string) => {
      const localState = groupInputs[group];
      if (localState) return localState;
      const persistedMeta = quarantineMetadataByGroup.get(group);
      if (persistedMeta) {
          return {
              reason: persistedMeta.reason || 'Production',
              note: persistedMeta.note || ''
          };
      }
      const derivedReservedState = deriveGroupStateFromItems(groupedReservedItems[group]);
      if (derivedReservedState) return derivedReservedState;
      const derivedHistoryState = deriveGroupStateFromItems(groupedActivityHistory[group]);
      if (derivedHistoryState) return derivedHistoryState;
      return { reason: 'Production', note: '' };
  };
  
  const updateGroupState = (group: string, field: 'reason'|'note', val: string) => {
      setGroupInputs(prev => ({ ...prev, [group]: { ...getGroupState(group), [field]: val } }));
  };

  const resolveQuarantineReferenceName = (fallbackName: string) => {
      const trimmedName = dispatchRef.trim() || fallbackName;
      if (!trimmedName || allowExistingDispatchRef || activeQuarantineNames.has(trimmedName)) {
          return { name: trimmedName, adjusted: false, duplicate: false };
      }
      if (!releasedQuarantineNames.has(trimmedName)) {
          return { name: trimmedName, adjusted: false, duplicate: false };
      }
      const suffixPattern = new RegExp(`^${escapeRegExp(trimmedName)}\\s(\\d{2})$`, 'i');
      let nextSuffix = 2;
      releasedQuarantineNames.forEach((name) => {
          const match = name.match(suffixPattern);
          if (!match) return;
          const parsed = Number(match[1]);
          if (Number.isFinite(parsed)) nextSuffix = Math.max(nextSuffix, parsed + 1);
      });
      return {
          originalName: trimmedName,
          name: `${trimmedName} ${String(nextSuffix).padStart(2, '0')}`,
          adjusted: true,
          duplicate: true
      };
  };

  const prepareQuarantineReferenceName = async (fallbackName: string) => {
      const resolved = resolveQuarantineReferenceName(fallbackName);
      if (!resolved.duplicate || !resolved.adjusted) {
          return resolved.name;
      }
      const shouldCreateNewName = await appDialog.confirm({
          title: 'Duplicate Quarantine Name',
          message: `Quarantine name "${resolved.originalName}" already exists. Create a new name as "${resolved.name}" instead?`,
          tone: 'warning',
          confirmLabel: 'Create the new name',
          cancelLabel: 'Cancel creating the new name'
      });
      if (!shouldCreateNewName) {
          return resolved.originalName || fallbackName;
      }
      setDispatchRef(resolved.name);
      setIsDispatchRefAuto(false);
      return resolved.name;
  };

  const executeReserve = async () => {
    if (isReadOnly) return;
    if (!canSubmitCompOutQuantity) return;
    const dualPathFormat = dualPathFormatBySku.get(String(compOut.itemId || '').trim().toUpperCase());
    if (isDualPathItem(compOut.itemId, dualPathFormat)) {
        const duplicateTx = findDualPathDuplicateEvent({
            transactions,
            itemId: compOut.itemId,
            batchNumber: compOut.batchId,
            quantity: parsedCompOutQuantity,
            windowMs: DUAL_PATH_DUPLICATE_WINDOW_MS
        });
        if (duplicateTx) {
            const duplicateTime = resolveLedgerEventTime(duplicateTx);
            const displayTime = duplicateTime ? formatBritishDateTime(duplicateTime) : 'recently';
            const windowMinutes = Math.floor(DUAL_PATH_DUPLICATE_WINDOW_MS / 60000);
            const shouldContinue = await appDialog.confirm({
                title: 'Duplicate warning',
                message: `Matching OUT event already exists (${compOut.itemId}, batch ${compOut.batchId}, qty ${parsedCompOutQuantity}) within the last ${windowMinutes} minutes at ${displayTime}. Continue registering anyway?`,
                tone: 'warning',
                confirmLabel: 'Continue',
                cancelLabel: 'Cancel'
            });
            if (!shouldContinue) return;
        }
    }
    setIsReserving(true);
    if (modalConfig?.isOpen) setIsModalActionLoading(true);
    try {
        const isManualAdjustment = activeTab === 'MANUAL';
        const referenceName = await prepareQuarantineReferenceName(
          isManualAdjustment ? `${getTodayCompactDate()} Manual Adjustment` : `${getTodayCompactDate()} Main Dispatch`
        );
        await onTransaction({
            type: 'OUT',
            category: compOut.category,
            itemId: compOut.itemId,
            quantity: parsedCompOutQuantity,
            unit: compOut.unit,
            reason: 'RESERVATION', 
            reference: referenceName,
            location: compOut.location,
            batchNumber: compOut.batchId,
            notes: isManualAdjustment ? COMP_OUT_MANUAL_ADJUSTMENT_NOTE : undefined,
            sourceTab: isManualAdjustment ? 'Component Out' : (compOut.category === 'PRODUCT' ? 'Staging' : 'Component Out'),
            user: currentUser
        });
        setCompOut({ ...compOut, itemId: '', quantity: 0, batchId: '', unit: '', category: 'COMPONENT' });
        setCompOutQuantityInput('');
        setModalConfig(null);
    } catch (error) {
      console.error("Reserve failed", error);
      await appDialog.alert({ message: "Failed to reserve item.", tone: 'danger' });
    }
    finally { setIsReserving(false); setIsModalActionLoading(false); }
  };

  const handleReserve = () => {
    if (isReadOnly) return;
    if (!compOut.itemId || !canSubmitCompOutQuantity || !compOut.batchId) {
        setModalConfig({ isOpen: true, title: 'Missing Info', message: 'Select Item, Batch, and Quantity.', type: 'info', showCancel: false, onConfirm: () => setModalConfig(null) });
        return;
    }
    const selectedBatchData = availableBatches.find(b => b.batch === compOut.batchId);
    if (selectedBatchData && parsedCompOutQuantity > selectedBatchData.qty) {
        setModalConfig({
            isOpen: true,
            title: 'Insufficient Stock',
            message: `You cannot reserve ${parsedCompOutQuantity.toLocaleString()} ${compOut.unit || ''}. Only ${selectedBatchData.qty.toLocaleString(undefined, { maximumFractionDigits: 3 })} ${compOut.unit || ''} is left for this batch at ${compOut.location}.`,
            type: 'warning',
            showCancel: false,
            onConfirm: () => setModalConfig(null)
        });
        return;
    }
    executeReserve();
  };

  const handleTransfer = async () => {
      if (isReadOnly) return;
      if (!compOut.itemId || !canSubmitCompOutQuantity || !compOut.batchId) return;
      const selectedBatchData = availableBatches.find(b => b.batch === compOut.batchId);
      if (selectedBatchData && parsedCompOutQuantity > selectedBatchData.qty) {
          setModalConfig({
              isOpen: true,
              title: 'Insufficient Stock',
              message: `You cannot transfer ${parsedCompOutQuantity.toLocaleString()} ${compOut.unit || ''}. Only ${selectedBatchData.qty.toLocaleString(undefined, { maximumFractionDigits: 3 })} ${compOut.unit || ''} is left for this batch at ${compOut.location}.`,
              type: 'warning',
              showCancel: false,
              onConfirm: () => setModalConfig(null)
          });
          return;
      }
      setIsReserving(true);
      try {
          const category = compOut.category;
          const referenceName = await prepareQuarantineReferenceName(
            `${getTodayCompactDate()} ${compOut.location} to ${transferDestination} Transfer`
          );
          const transferNote = `Inter-site transfer: ${compOut.location} to ${transferDestination}`;
          await onTransaction({
              type: 'OUT',
              category,
              itemId: compOut.itemId,
              quantity: parsedCompOutQuantity,
              unit: compOut.unit,
              batchNumber: compOut.batchId,
              location: compOut.location,
              reason: 'RESERVATION',
              reference: referenceName,
              notes: transferNote,
              sourceTab: 'Transfer',
              user: currentUser
          });
          await onTransaction({
              type: 'IN',
              category,
              itemId: compOut.itemId,
              quantity: parsedCompOutQuantity,
              unit: compOut.unit,
              batchNumber: compOut.batchId,
              location: transferDestination,
              reason: `Transfer from ${compOut.location}`,
              reference: referenceName,
              notes: transferNote,
              sourceTab: 'Transfer',
              user: currentUser
          });
          setCompOut({ ...compOut, itemId: '', quantity: 0, batchId: '', unit: '', category: 'COMPONENT' });
          setCompOutQuantityInput('');
      } catch (e) { console.error("Transfer failed", e); }
      finally { setIsReserving(false); }
  };

  const handleConfirmUsage = async (txId: string, group: string) => {
      if (isReadOnly) return;
      const { reason, note } = getGroupState(group);
      setProcessingTxId(txId);
      try {
          const tx = transactions.find((item) => item.id === txId);
          if (tx?.category === 'PRODUCT' && tx.sourceTab === 'Staging') {
              await onEditTransaction(txId, { reason: 'STAGING_CONSUMPTION', notes: note, sourceTab: 'Staging' }, "Confirmed Usage", currentUser);
          } else if (tx) {
              await onEditTransaction(
                txId,
                {
                  reason: resolveCompOutReleaseReason(tx, reason),
                  notes: note,
                  reference: String(tx.reference || '').trim() || resolveCompOutGroupName(tx)
                },
                "Confirmed Usage",
                currentUser
              );
          } else {
              await onEditTransaction(txId, { reason, notes: note }, "Confirmed Usage", currentUser);
          }
          await appDialog.alert({
              title: 'Release successful',
              message: 'Item released from active quarantine.',
              tone: 'success'
          });
      }
      catch (error) {
          console.error("Confirm failed", error);
          await appDialog.alert({
              title: 'Release failed',
              message: getActionErrorMessage(error, 'Item could not be released from active quarantine.'),
              tone: 'danger'
          });
      } finally { setProcessingTxId(null); }
  };

  const getTransferLinkedTxIds = (items: InventoryTransaction[]): string[] => {
      const ids = new Set<string>();
      items.forEach((tx) => {
          if (!tx?.id) return;
          ids.add(tx.id);
          if (tx.sourceTab !== 'Transfer') return;
          transactions.forEach((candidate) => {
              if (
                  candidate.id &&
                  candidate.id !== tx.id &&
                  candidate.sourceTab === 'Transfer' &&
                  candidate.category === tx.category &&
                  candidate.itemId === tx.itemId &&
                  String(candidate.batchNumber || '') === String(tx.batchNumber || '') &&
                  Math.abs(Number(candidate.quantity || 0) - Number(tx.quantity || 0)) < 0.000001 &&
                  String(candidate.reference || '') === String(tx.reference || '') &&
                  candidate.type !== tx.type
              ) {
                  ids.add(candidate.id);
              }
          });
      });
      return [...ids];
  };

  const handlePutBack = (txId: string) => {
      if (isReadOnly) return;
      setModalConfig({
          isOpen: true, title: 'Return?', message: 'Return to inventory?', type: 'danger', showCancel: true,
          onConfirm: async () => {
              setIsModalActionLoading(true);
              try {
                  const targetTx = transactions.find((tx) => tx.id === txId);
                  const idsToDelete = targetTx ? getTransferLinkedTxIds([targetTx]) : [txId];
                  for (const id of idsToDelete) {
                      await onDeleteTransaction(id, true);
                  }
                  setModalConfig(null);
                  await appDialog.alert({
                      title: 'Return successful',
                      message: 'Item returned to inventory.',
                      tone: 'success'
                  });
              }
              catch (e) {
                  console.error(e);
                  setModalConfig(null);
                  await appDialog.alert({
                      title: 'Return failed',
                      message: getActionErrorMessage(e, 'Item could not be returned to inventory.'),
                      tone: 'danger'
                  });
              } finally { setIsModalActionLoading(false); }
          }
      });
  };

  const handleBatchRelease = async (group: string, items: InventoryTransaction[]) => {
      if (isReadOnly) return;
      if (items.length === 0) return;
      const { reason, note } = getGroupState(group);
      setModalConfig({
          isOpen: true, title: 'Release Group?', message: `Release ${items.length} items in "${group}" as "${reason}"?`, type: 'info', showCancel: true,
          onConfirm: async () => {
              setIsModalActionLoading(true);
              let successCount = 0;
              try {
                  for (const tx of items) {
                      if (tx.category === 'PRODUCT' && tx.sourceTab === 'Staging') {
                          await onEditTransaction(tx.id, { reason: 'STAGING_CONSUMPTION', notes: note, sourceTab: 'Staging' }, "Batch Release", currentUser);
                      } else {
                          await onEditTransaction(
                            tx.id,
                            {
                              reason: resolveCompOutReleaseReason(tx, reason),
                              notes: note,
                              reference: String(tx.reference || '').trim() || resolveCompOutGroupName(tx)
                            },
                            "Batch Release",
                            currentUser
                          );
                      }
                      successCount += 1;
                  }
                  updateGroupState(group, 'note', ''); 
                  setModalConfig(null);
                  await appDialog.alert({
                      title: 'Release successful',
                      message: `Released ${successCount} item${successCount === 1 ? '' : 's'} from "${group}".`,
                      tone: 'success'
                  });
              } catch (e) {
                  console.error(e);
                  setModalConfig(null);
                  await appDialog.alert({
                      title: 'Release failed',
                      message: getActionErrorMessage(
                          e,
                          successCount > 0
                              ? `Release stopped after ${successCount} of ${items.length} items in "${group}".`
                              : `No items were released from "${group}".`
                      ),
                      tone: 'danger'
                  });
              } finally { setIsModalActionLoading(false); }
          }
      });
  };

  const handleBatchPutBack = async (group: string, items: InventoryTransaction[]) => {
      if (isReadOnly) return;
      if (items.length === 0) return;
      setModalConfig({
          isOpen: true, title: 'Return Group?', message: `Return ${items.length} items from "${group}" to inventory?`, type: 'danger', showCancel: true,
          onConfirm: async () => {
              setIsModalActionLoading(true);
              let successCount = 0;
              try {
                  const idsToDelete = getTransferLinkedTxIds(items);
                  for (const id of idsToDelete) {
                      await onDeleteTransaction(id, true);
                      successCount += 1;
                  }
                  setModalConfig(null);
                  await appDialog.alert({
                      title: 'Return successful',
                      message: `Returned ${items.length} item${items.length === 1 ? '' : 's'} from "${group}" to inventory.`,
                      tone: 'success'
                  });
              } catch (e) {
                  console.error(e);
                  setModalConfig(null);
                  await appDialog.alert({
                      title: 'Return failed',
                      message: getActionErrorMessage(
                          e,
                          successCount > 0
                              ? `Return stopped after ${successCount} ledger update${successCount === 1 ? '' : 's'} for "${group}".`
                              : `No items were returned from "${group}".`
                      ),
                      tone: 'danger'
                  });
              } finally { setIsModalActionLoading(false); }
          }
      });
  };

  const handleUpdateActiveGroup = async (group: string, items: InventoryTransaction[]) => {
      if (isReadOnly || items.length === 0) return;
      const { reason, note } = getGroupState(group);
      setUpdatingActiveGroupKey(group);
      try {
          if (onUpsertQuarantineMeta) {
              await onUpsertQuarantineMeta({
                  docId: buildQuarantineMetaDocId(group),
                  group,
                  reason,
                  note,
                  user: currentUser
              });
          } else {
              for (const tx of items) {
                  await onEditTransaction(
                      tx.id,
                      { editReason: reason, notes: note },
                      "Quarantine Details Update",
                      currentUser
                  );
              }
          }
          await appDialog.alert({
              title: 'OK successful',
              message: `Updated active quarantine details for "${group}".`,
              tone: 'success'
          });
      } catch (e) {
          console.error(e);
          await appDialog.alert({
              title: 'OK failed',
              message: getActionErrorMessage(e, `Active quarantine details for "${group}" could not be updated.`),
              tone: 'danger'
          });
      } finally {
          setUpdatingActiveGroupKey(null);
      }
  };

  const handleDownloadDispatchList = async (group: string, items: InventoryTransaction[]) => {
      if (items.length === 0) return;
      const { reason, note } = getGroupState(group);
      setIsModalActionLoading(true);
      try {
          const timestamp = new Date();
          const docId = `DOC-DSP-${timestamp.getTime()}`;
          const doc = new jsPDF();
          const generatedAt = formatBritishDateTime(timestamp);
          doc.setFontSize(14);
          doc.text('Dispatch Manifest', 14, 18);
          doc.setFontSize(10);
          doc.text(`Group: ${group}`, 14, 25);
          doc.text(`Reason: ${reason}`, 14, 31);
          doc.text(`Generated: ${generatedAt}`, 14, 37);
          if (note) {
              doc.text(`Note: ${note}`, 14, 43);
          }
          autoTable(doc, {
              startY: note ? 49 : 43,
              head: [['QC Number', 'Item', 'Reserved Qty', 'Unit', 'Location']],
              body: items.map((tx) => [
                  tx.batchNumber || '-',
                  resolveItemDisplay(tx.itemId, tx.itemName),
                  Number(tx.quantity || 0).toString(),
                  tx.unit || '-',
                  tx.location || '-'
              ]),
              styles: { fontSize: 9 },
              headStyles: { fillColor: [30, 41, 59] }
          });
          doc.save(`dispatch_manifest_${group.replace(/[^a-z0-9_-]+/gi, '_')}_${timestamp.toISOString().slice(0, 10)}.pdf`);
          await createDocument({ 
              doc_id: docId, 
              doc_type: 'Dispatch Manifest', 
              reference_id: reason, 
              content_summary: `Generated PDF manifest for ${items.length} items${note ? ` (${note})` : ''}`, 
              location: compOut.location, 
              created_by: currentUser 
          });
      } catch (e) { console.error(e); } finally { setIsModalActionLoading(false); }
  };

  const handleEditClick = (tx: InventoryTransaction) => {
      if (isReadOnly) return;
      setEditingTxId(tx.id);
      setEditForm({ itemId: tx.itemId, batchNumber: tx.batchNumber || '', quantity: tx.quantity, unit: tx.unit });
  };

  const getEditableReservationLimit = (
      originalTx: InventoryTransaction,
      nextForm: NonNullable<typeof editForm>
  ): number => {
      const levels = resolveStockLevelsForItem(nextForm.itemId, originalTx.category);
      const position = levels[nextForm.itemId];
      const batch = String(nextForm.batchNumber || '').trim();
      if (!position || !batch) return 0;

      const location = String(originalTx.location || '').trim();
      const locationState = location ? position.byBatchLocation?.[batch]?.[location] : undefined;
      const batchState = position.byBatch?.[batch];
      let available = Number((locationState || batchState)?.available || 0);

      if (
          originalTx.itemId === nextForm.itemId &&
          String(originalTx.batchNumber || '').trim() === batch &&
          Number(originalTx.quantity || 0) > 0
      ) {
          available += Number(originalTx.quantity || 0);
      }

      return Math.max(0, available);
  };

  const handleSaveEdit = async () => {
      if (isReadOnly) return;
      if (!editingTxId || !editForm) return;
      const originalTx = transactions.find(t => t.id === editingTxId);
      const nextQuantity = Number(editForm.quantity);
      if (!Number.isFinite(nextQuantity)) {
          await appDialog.alert({
              title: 'Invalid quantity',
              message: 'Please enter a valid quantity before saving.',
              tone: 'warning'
          });
          return;
      }
      if (originalTx && nextQuantity > 0) {
          const editableLimit = getEditableReservationLimit(originalTx, editForm);
          if (nextQuantity - editableLimit > QUANTITY_EPSILON) {
              await appDialog.alert({
                  title: 'Quantity too high',
                  message: `You cannot reserve ${nextQuantity.toLocaleString()} ${editForm.unit || ''}. Only ${editableLimit.toLocaleString(undefined, { maximumFractionDigits: 3 })} ${editForm.unit || ''} is left for this batch at ${originalTx.location || 'this location'}.`,
                  tone: 'warning'
              });
              return;
          }
      }
      setIsSavingEdit(true);
      try {
          const itemName = compOptions.find(c => c.id === editForm.itemId)?.name || editForm.itemId;
          await onEditTransaction(editingTxId, { itemId: editForm.itemId, itemName, batchNumber: editForm.batchNumber, quantity: nextQuantity, unit: editForm.unit }, "Correction", currentUser);
          setEditingTxId(null); setEditForm(null);
          await appDialog.alert({
              title: 'OK successful',
              message: 'Quarantine item updated.',
              tone: 'success'
          });
      } catch (e) {
          console.error(e);
          await appDialog.alert({
              title: 'OK failed',
              message: getActionErrorMessage(e, 'Quarantine item could not be updated.'),
              tone: 'danger'
          });
      } finally { setIsSavingEdit(false); }
  };

  const formatGroupTotals = (items: InventoryTransaction[]) => {
      const totalsByUnit: Record<string, number> = {};
      items.forEach(item => {
          const unit = item.unit || '-';
          totalsByUnit[unit] = (totalsByUnit[unit] || 0) + Number(item.quantity || 0);
      });
      return Object.entries(totalsByUnit)
          .map(([unit, qty]) => `${qty.toLocaleString(undefined, { maximumFractionDigits: 3 })} ${unit}`)
          .join(' + ');
  };

  const toggleGroupExpanded = (key: string) => {
      setExpandedGroups(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const handleUseQuarantineName = (group: string) => {
      const trimmedGroup = group.trim();
      const nextGroupState = getGroupState(group);
      const shouldUseTransferTab = /^inter-site transfer\s*:/i.test(String(nextGroupState.note || '').trim());
      const shouldUseManualTab =
          isManualAdjustmentReason(nextGroupState.reason) ||
          /manual adjustment/i.test(String(nextGroupState.note || '')) ||
          /manual adjustment/i.test(trimmedGroup);
      setDispatchRef(trimmedGroup || getDefaultDispatchName());
      setIsDispatchRefAuto(false);
      setAllowExistingDispatchRef(true);
      setActiveTab(shouldUseTransferTab ? 'TRANSFER' : shouldUseManualTab ? 'MANUAL' : 'USAGE');
      if (dispatchRefInputRef.current) {
          dispatchRefInputRef.current.focus();
          dispatchRefInputRef.current.select();
      }
  };

  const handleRenameActiveQuarantineGroup = async (group: string, items: InventoryTransaction[]) => {
      if (isReadOnly || items.length === 0) return;
      const trimmedGroup = group.trim();
      const nextNameInput = await appDialog.prompt({
          title: 'Rename Quarantine',
          message: `Enter the new quarantine name for "${trimmedGroup}". This updates the active ledger rows and quarantine details in local demo storage.`,
          inputLabel: 'Quarantine Name',
          defaultValue: trimmedGroup,
          required: true,
          confirmLabel: 'Rename',
          cancelLabel: 'Cancel',
          tone: 'info'
      });
      const nextName = String(nextNameInput || '').trim();
      if (!nextName || nextName === trimmedGroup) return;

      const isExistingActiveName = activeQuarantineNames.has(nextName);
      if (isExistingActiveName) {
          const shouldMerge = await appDialog.confirm({
              title: 'Merge Quarantine Groups?',
              message: `An active quarantine named "${nextName}" already exists. Renaming "${trimmedGroup}" to this name will merge the groups.`,
              tone: 'warning',
              confirmLabel: 'Merge groups',
              cancelLabel: 'Cancel'
          });
          if (!shouldMerge) return;
      }

      const existingState = getGroupState(group);
      const idsToRename = getTransferLinkedTxIds(items);
      const uniqueIds = Array.from(new Set(idsToRename));
      setRenamingActiveGroupKey(group);
      try {
          let renamedCount = 0;
          for (const txId of uniqueIds) {
              await onEditTransaction(
                  txId,
                  { reference: nextName },
                  "Quarantine Rename",
                  currentUser
              );
              renamedCount += 1;
          }

          if (onUpsertQuarantineMeta) {
              await onUpsertQuarantineMeta({
                  docId: getQuarantineMetaDocIdForGroup(group),
                  group: nextName,
                  reason: existingState.reason,
                  note: existingState.note,
                  user: currentUser
              });
          }

          setGroupInputs((prev) => {
              const next = { ...prev };
              const state = next[group] || existingState;
              delete next[group];
              next[nextName] = state;
              return next;
          });
          setExpandedGroups((prev) => {
              const next = { ...prev };
              if (next[`active:${group}`]) {
                  delete next[`active:${group}`];
                  next[`active:${nextName}`] = true;
              }
              return next;
          });
          if (dispatchRef.trim() === trimmedGroup) {
              setDispatchRef(nextName);
              setIsDispatchRefAuto(false);
              setAllowExistingDispatchRef(true);
          }
          await appDialog.alert({
              title: 'Rename successful',
              message: `Renamed "${trimmedGroup}" to "${nextName}" across ${renamedCount} ledger row${renamedCount === 1 ? '' : 's'}.`,
              tone: 'success'
          });
      } catch (error) {
          console.error(error);
          await appDialog.alert({
              title: 'Rename failed',
              message: getActionErrorMessage(error, `Could not rename "${trimmedGroup}". Please refresh and check the active quarantine group before trying again.`),
              tone: 'danger'
          });
      } finally {
          setRenamingActiveGroupKey(null);
      }
  };

  const handleQuarantineNameClick = (group: string, items: InventoryTransaction[]) => {
      if (quarantineNameClickTimerRef.current !== null) {
          window.clearTimeout(quarantineNameClickTimerRef.current);
      }
      quarantineNameClickTimerRef.current = window.setTimeout(() => {
          quarantineNameClickTimerRef.current = null;
          void handleRenameActiveQuarantineGroup(group, items);
      }, 220);
  };

  const handleQuarantineNameDoubleClick = (group: string) => {
      if (quarantineNameClickTimerRef.current !== null) {
          window.clearTimeout(quarantineNameClickTimerRef.current);
          quarantineNameClickTimerRef.current = null;
      }
      handleUseQuarantineName(group);
  };

  const handleUpdateHistoryGroup = async (group: string, items: InventoryTransaction[]) => {
      if (isReadOnly || items.length === 0) return;
      const { reason, note } = getGroupState(group);
      setModalConfig({
          isOpen: true,
          title: 'Update History Group?',
          message: `Update ${items.length} items in "${group}" to reason "${reason}"?`,
          type: 'info',
          showCancel: true,
          onConfirm: async () => {
              setIsModalActionLoading(true);
              try {
                  for (const tx of items) {
                      await onEditTransaction(
                          tx.id,
                          {
                            reason: resolveCompOutReleaseReason(tx, reason),
                            notes: note,
                            reference: String(tx.reference || '').trim() || resolveCompOutGroupName(tx)
                          },
                          "History Correction",
                          currentUser
                      );
                  }
                  if (onUpsertQuarantineMeta) {
                      await onUpsertQuarantineMeta({
                          docId: buildQuarantineMetaDocId(group),
                          group,
                          reason,
                          note,
                          user: currentUser
                      });
                  }
                  setModalConfig(null);
              } catch (e) {
                  console.error(e);
              } finally {
                  setIsModalActionLoading(false);
              }
          }
      });
  };

  const handleReverseHistoryGroupToReservation = async (group: string, items: InventoryTransaction[]) => {
      if (isReadOnly || items.length === 0) return;
      const { reason, note } = getGroupState(group);
      setModalConfig({
          isOpen: true,
          title: 'Move Back To Quarantine?',
          message: `Change ${items.length} items in "${group}" back to Unreleased / Active Quarantine?`,
          type: 'warning',
          showCancel: true,
          onConfirm: async () => {
              setIsModalActionLoading(true);
              try {
                  for (const tx of items) {
                      await onEditTransaction(
                          tx.id,
                          {
                              reason: 'RESERVATION',
                              sourceTab: isManualAdjustmentReason(reason)
                                  ? 'Component Out'
                                  : tx.category === 'PRODUCT'
                                    ? 'Staging'
                                    : (tx.sourceTab || 'Component Out'),
                          },
                          "Reverse To Quarantine",
                          currentUser
                      );
                  }
                  if (onUpsertQuarantineMeta) {
                      await onUpsertQuarantineMeta({
                          docId: buildQuarantineMetaDocId(group),
                          group,
                          reason,
                          note,
                          user: currentUser
                      });
                  }
                  setModalConfig(null);
              } catch (e) {
                  console.error(e);
              } finally {
                  setIsModalActionLoading(false);
              }
          }
      });
  };

  const applyActivityFilters = () => {
      setActivityAppliedFromDate(activityDraftFromDate);
      setActivityAppliedToDate(activityDraftToDate);
      setActivityAppliedStatus(activityDraftStatus);
      setActivityAppliedSearchQuery(debouncedActivityDraftSearch.trim());
  };

  const resetActivityFilters = () => {
      setActivityDraftFromDate(defaultActivityDateRange.from);
      setActivityDraftToDate(defaultActivityDateRange.to);
      setActivityDraftStatus('all');
      setActivityDraftSearchInput('');
      setActivityAppliedFromDate(defaultActivityDateRange.from);
      setActivityAppliedToDate(defaultActivityDateRange.to);
      setActivityAppliedStatus('all');
      setActivityAppliedSearchQuery('');
      setGroupSortMode('latest_desc');
      setRowSortState({ key: 'date', dir: 'desc' });
  };

  const handleRowSortChange = (sortKey: string, sortDir: 'asc' | 'desc') => {
      setRowSortState({ key: sortKey as CompOutRowSortKey, dir: sortDir });
  };

  const downloadCompOutCsv = () => {
      const rows = [
        ...reservedGroupEntries.flatMap((entry) =>
          entry.items.map((tx) => ({
            status: 'Unreleased',
            group: entry.group,
            tx,
          }))
        ),
        ...historyGroupEntries.flatMap((entry) =>
          entry.items.map((tx) => ({
            status: 'Released',
            group: entry.group,
            tx,
          }))
        ),
      ];
      if (rows.length === 0) return;

      const headers = ['Quarantine Name', 'Status', 'QC Number', 'Item', 'Item ID', 'Qty', 'Unit', 'Location', 'Reason', 'Note'];
      const lines = rows.map((row) => {
          const reason = isCompOutUnreleased(row.tx)
            ? normalizeCompOutReasonForSelector(row.tx)
            : (row.tx.reason || '');
          return [
            row.group,
            row.status,
            row.tx.batchNumber || '—',
            resolveItemDisplay(row.tx.itemId, row.tx.itemName),
            row.tx.itemId || '—',
            Number(row.tx.quantity || 0).toString(),
            row.tx.unit || '—',
            row.tx.location || '—',
            reason || '—',
            row.tx.notes || '—',
          ];
      });
      const csv = [headers.join(','), ...lines.map((line) => line.map(escapeCsv).join(','))].join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const fromSegment = getDateOnlyValue(activityAppliedFromDate || defaultActivityDateRange.from).replaceAll('-', '');
      const toSegment = getDateOnlyValue(activityAppliedToDate || defaultActivityDateRange.to).replaceAll('-', '');
      a.download = `comp_out_from_${fromSegment}_to_${toSegment}.csv`;
      a.click();
      URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-8 animate-in fade-in">
        
        {/* Top Control Panel */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="flex border-b border-slate-200 bg-slate-50">
                <button 
                    onClick={() => setActiveTab('USAGE')}
                    className={`flex-1 py-4 text-sm font-bold flex items-center justify-center transition-all ${activeTab === 'USAGE' ? 'bg-white text-orange-600 border-b-2 border-orange-500 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                    <Lock className="w-4 h-4 mr-2" /> Stage for Production
                </button>
                <div className="w-px bg-slate-200"></div>
                <button 
                    onClick={() => setActiveTab('TRANSFER')}
                    className={`flex-1 py-4 text-sm font-bold flex items-center justify-center transition-all ${activeTab === 'TRANSFER' ? 'bg-white text-blue-600 border-b-2 border-blue-500 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                    <ArrowRightLeft className="w-4 h-4 mr-2" /> Inter-Site Transfer
                </button>
                <div className="w-px bg-slate-200"></div>
                <button
                    onClick={() => setActiveTab('MANUAL')}
                    className={`flex-1 py-4 text-sm font-bold flex items-center justify-center transition-all ${activeTab === 'MANUAL' ? 'bg-white text-amber-600 border-b-2 border-amber-500 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                    <Edit className="w-4 h-4 mr-2" /> Manual Adjustment
                </button>
            </div>

            <div className="p-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {(activeTab === 'USAGE' || activeTab === 'TRANSFER' || activeTab === 'MANUAL') && (
                        <div className="md:col-span-2">
                            <label className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider flex items-center">
                                <Layers className="w-3 h-3 mr-1" /> Quarantine Name
                            </label>
                            <input 
                                ref={dispatchRefInputRef}
                                type="text" 
                                className="w-full border-slate-300 rounded-lg text-sm shadow-sm py-2.5 font-bold text-indigo-700 bg-indigo-50"
                                value={dispatchRef}
                                onChange={e => {
                                    setDispatchRef(e.target.value);
                                    setIsDispatchRefAuto(false);
                                    setAllowExistingDispatchRef(false);
                                }}
                                onFocus={(e) => e.currentTarget.select()}
                                disabled={isReadOnly}
                                placeholder="e.g. US order blended product reservation"
                            />
                            <p className="text-[11px] text-slate-500 mt-1">
                                Editable full name, including date. Single-click an active quarantine name below to rename it, or double-click to add more items to that quarantine. Suggested format: <span className="font-mono">YYYYMMDD</span> + label.
                            </p>
                        </div>
                    )}

                    <div>
                        <label className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Item Category</label>
                        <select
                            className="w-full border-slate-300 rounded-lg text-sm shadow-sm font-medium text-slate-700 py-2.5 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                            value={selectedCompOutCategory}
                            onChange={e => {
                                const nextCategory = e.target.value as UiItemCategory | '';
                                setSelectedCompOutCategory(nextCategory);
                                setCompOut(prev => ({ ...prev, itemId: '', batchId: '', unit: '', category: 'COMPONENT' }));
                            }}
                            disabled={isReadOnly}
                        >
                            <option value="">-- Select Category --</option>
                            {UI_ITEM_CATEGORIES.map(category => (
                                <option key={category} value={category}>{UI_ITEM_CATEGORY_LABELS[category]}</option>
                            ))}
                        </select>
                    </div>

                    <div>
                        <label className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Item</label>
                        <select 
                            className="w-full border-slate-300 rounded-lg text-sm shadow-sm font-medium text-slate-700 py-2.5 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                            value={compOut.itemId}
                            onChange={e => {
                                const item = compOptions.find(o => o.id === e.target.value);
                                setCompOut({
                                    ...compOut,
                                    itemId: e.target.value,
                                    unit: item?.unit || 'unit',
                                    category: item?.category || 'COMPONENT',
                                    batchId: ''
                                });
                            }}
                            disabled={!selectedCompOutCategory || isReadOnly}
                        >
                            <option value="">{selectedCompOutCategory ? '-- Select Item --' : 'Select category first'}</option>
                            {Object.entries(groupedOptions).map(([group, opts]) => (
                                <optgroup key={group} label={group.toUpperCase()} className="text-indigo-600 font-bold">
                                    {(opts as any[]).map(o => (
                                        <option key={o.id} value={o.id} className="text-slate-700 font-medium">
                                            [{o.id}] {o.name}{o.note ? ` — ${o.note}` : ''}
                                        </option>
                                    ))}
                                </optgroup>
                            ))}
                        </select>
                    </div>

                    <div className={activeTab !== 'TRANSFER' ? 'md:col-span-2' : undefined}>
                        <label className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Source Location</label>
                        {activeTab === 'TRANSFER' ? (
                            <button
                                type="button"
                                onClick={() => setCompOut({
                                    ...compOut,
                                    location: getOppositeLocation(compOut.location),
                                    destination: compOut.location,
                                    batchId: ''
                                })}
                                disabled={isReadOnly}
                                className="w-full border border-slate-300 rounded-lg text-sm shadow-sm py-2.5 px-3 font-bold text-slate-700 bg-white hover:bg-slate-50 transition text-left disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                <div className="flex items-center justify-between gap-3">
                                    <span>{compOut.location}</span>
                                    <span className="text-[11px] uppercase tracking-wider text-blue-600 font-extrabold">Click to swap</span>
                                </div>
                            </button>
                        ) : (
                            <select 
                                className="w-full border-slate-300 rounded-lg text-sm shadow-sm py-2.5 font-bold text-slate-700"
                                value={compOut.location}
                                onChange={e => setCompOut({...compOut, location: e.target.value as LocationName, destination: getOppositeLocation(e.target.value as LocationName), batchId: ''})}
                                disabled={isReadOnly}
                            >
                                <option value="Riverside">Riverside</option>
                                <option value="Hilltop">Hilltop</option>
                            </select>
                        )}
                    </div>

                    {activeTab === 'TRANSFER' && (
                        <div>
                            <label className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Destination</label>
                            <div className="w-full border border-indigo-200 rounded-lg text-sm shadow-sm py-2.5 px-3 font-bold text-indigo-700 bg-indigo-50">
                                {transferDestination}
                            </div>
                        </div>
                    )}

                    {activeTab !== 'TRANSFER' && (
                        <>
                            <div>
                                <label className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Source Batch</label>
                                <select 
                                    className="w-full border-slate-300 rounded-lg text-sm shadow-sm py-2.5 font-mono"
                                    value={compOut.batchId}
                                    onChange={e => setCompOut({...compOut, batchId: e.target.value})}
                                    disabled={!compOut.itemId || isReadOnly}
                                >
                                    <option value="">-- Select Batch --</option>
                                    {availableBatches.map(b => (
                                        <option key={b.batch} value={b.batch}>
                                            {b.displayBatch} — {b.qty.toLocaleString()} available
                                        </option>
                                    ))}
                                </select>
                            </div>

                            <div>
                                <label className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Quantity</label>
                                <div className="flex">
                                    <input 
                                        type="number" 
                                        className="w-full border-slate-300 rounded-l-lg text-sm shadow-sm py-2.5 font-bold"
                                        value={compOutQuantityInput}
                                        onChange={e => setCompOutQuantityInput(e.target.value)}
                                        placeholder={activeTab === 'MANUAL' ? '0.00 or -0.00' : '0.00'}
                                        step="0.001"
                                        min={activeTab === 'MANUAL' ? undefined : '0.001'}
                                        disabled={isReadOnly}
                                    />
                                    <span className="bg-slate-100 border border-l-0 border-slate-300 rounded-r-lg px-4 py-2 text-xs text-slate-600 font-bold flex items-center min-w-[3rem] justify-center">
                                        {compOut.unit || '-'}
                                    </span>
                                </div>
                                {activeTab === 'MANUAL' && (
                                    <p className="text-[11px] text-slate-500 mt-1">
                                        Use a negative quantity when the warehouse has more stock than the system.
                                    </p>
                                )}
                            </div>
                        </>
                    )}

                    {activeTab === 'TRANSFER' && (
                        <>
                            <div>
                                <label className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Source Batch</label>
                                <select 
                                    className="w-full border-slate-300 rounded-lg text-sm shadow-sm py-2.5 font-mono"
                                    value={compOut.batchId}
                                    onChange={e => setCompOut({...compOut, batchId: e.target.value})}
                                    disabled={!compOut.itemId || isReadOnly}
                                >
                                    <option value="">-- Select Batch --</option>
                                    {availableBatches.map(b => (
                                        <option key={b.batch} value={b.batch}>
                                            {b.displayBatch} — {b.qty.toLocaleString()} available
                                        </option>
                                    ))}
                                </select>
                            </div>

                            <div>
                                <label className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Quantity</label>
                                <div className="flex">
                                    <input 
                                        type="number" 
                                        className="w-full border-slate-300 rounded-l-lg text-sm shadow-sm py-2.5 font-bold"
                                        value={compOutQuantityInput}
                                        onChange={e => setCompOutQuantityInput(e.target.value)}
                                        placeholder="0.00"
                                        step="0.001"
                                        min="0.001"
                                        disabled={isReadOnly}
                                    />
                                    <span className="bg-slate-100 border border-l-0 border-slate-300 rounded-r-lg px-4 py-2 text-xs text-slate-600 font-bold flex items-center min-w-[3rem] justify-center">
                                        {compOut.unit || '-'}
                                    </span>
                                </div>
                            </div>
                        </>
                    )}

                    <div className="md:col-span-2 flex items-end">
                        {activeTab !== 'TRANSFER' ? (
                            <button 
                                onClick={handleReserve}
                                disabled={!compOut.itemId || !compOut.batchId || !canSubmitCompOutQuantity || isReserving || isReadOnly}
                                className={`w-full text-white py-3 rounded-lg font-bold shadow-md transition flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed ${activeTab === 'MANUAL' ? 'bg-amber-600 hover:bg-amber-700' : 'bg-orange-600 hover:bg-orange-700'}`}
                            >
                                {isReserving ? (
                                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Processing...</>
                                ) : activeTab === 'MANUAL' ? (
                                    <><Edit className="w-4 h-4 mr-2" /> Move Adjustment to Quarantine</>
                                ) : (
                                    <><Lock className="w-4 h-4 mr-2" /> Move to Quarantine</>
                                )}
                            </button>
                        ) : (
                            <button 
                                onClick={handleTransfer}
                                disabled={!compOut.itemId || !compOut.batchId || !canSubmitCompOutQuantity || isReserving || isReadOnly}
                                className="w-full bg-blue-600 text-white py-3 rounded-lg font-bold shadow-md hover:bg-blue-700 transition flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {isReserving ? (
                                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Transferring...</>
                                ) : (
                                    <><ArrowRightLeft className="w-4 h-4 mr-2" /> Transfer Stock</>
                                )}
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>

        {/* Quarantine Groups */}
        {(activeTab === 'USAGE' || activeTab === 'MANUAL' || hasReservedItems || hasHistoryItems) && (
            <div className="space-y-6">
                <div className="bg-white border border-slate-200 rounded-xl shadow-sm px-5 py-4">
                    <h3 className="text-sm font-bold text-slate-700 uppercase tracking-wider flex items-center">
                        <History className="w-4 h-4 mr-2" /> Comp Out Activity
                    </h3>
                    <ActivityFilterBar
                        fromDate={activityDraftFromDate}
                        toDate={activityDraftToDate}
                        onChangeFrom={setActivityDraftFromDate}
                        onChangeTo={setActivityDraftToDate}
                        rightSideControls={
                            <div className={activityFilterGridClass}>
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Status</label>
                                    <select
                                        value={activityDraftStatus}
                                        onChange={(event) => setActivityDraftStatus(event.target.value as CompOutStatusFilter)}
                                        className={filterFieldClass}
                                    >
                                        <option value="all">All</option>
                                        <option value="unreleased">Unreleased</option>
                                        <option value="released">Released</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Sort Groups</label>
                                    <select
                                        value={groupSortMode}
                                        onChange={(event) => setGroupSortMode(event.target.value as CompOutGroupSortMode)}
                                        className={filterFieldClass}
                                    >
                                        <option value="latest_desc">Latest Activity (Newest)</option>
                                        <option value="latest_asc">Latest Activity (Oldest)</option>
                                        <option value="qty_desc">Total Qty (High-Low)</option>
                                        <option value="qty_asc">Total Qty (Low-High)</option>
                                        <option value="item_asc">Item Name (A-Z)</option>
                                        <option value="item_desc">Item Name (Z-A)</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Search</label>
                                    <input
                                        type="text"
                                        value={activityDraftSearchInput}
                                        onChange={(event) => setActivityDraftSearchInput(event.target.value)}
                                        placeholder="Item, QC, user, reason..."
                                        className={filterFieldClass}
                                    />
                                </div>
                            </div>
                        }
                        onApply={applyActivityFilters}
                        onReset={resetActivityFilters}
                        onExport={downloadCompOutCsv}
                        exportDisabled={!hasReservedItems && !hasHistoryItems}
                    />
                </div>
                <div className="space-y-4">
                    <h3 className="text-sm font-bold text-orange-800 uppercase tracking-wider flex items-center">
                        <AlertTriangle className="w-4 h-4 mr-2" /> Unreleased / Active Quarantine
                    </h3>
                    {reservedGroupEntries.map(({ group, items }) => {
                        const expandedKey = `active:${group}`;
                        const isExpanded = !!expandedGroups[expandedKey];
                        const isSelectedForDispatch = dispatchRef.trim() === group;
                        return (
                            <div key={expandedKey} className="bg-white border border-orange-200 rounded-xl shadow-sm overflow-hidden">
                                <button
                                    onClick={() => toggleGroupExpanded(expandedKey)}
                                    className="w-full bg-orange-50 px-5 py-4 border-b border-orange-200 text-left hover:bg-orange-100/70 transition"
                                >
                                    <div className="flex justify-between items-center gap-4">
                                        <div className="flex items-start gap-3 min-w-0">
                                            {isExpanded ? <ChevronDown className="w-4 h-4 text-orange-700 mt-0.5" /> : <ChevronRight className="w-4 h-4 text-orange-700 mt-0.5" />}
                                            <div className="min-w-0">
                                                <div className="text-xs text-orange-700 font-bold uppercase tracking-wider">Quarantine Name</div>
                                                <div className="flex items-center gap-2">
                                                    <div
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleQuarantineNameClick(group, items);
                                                        }}
                                                        onDoubleClick={(e) => {
                                                            e.stopPropagation();
                                                            handleQuarantineNameDoubleClick(group);
                                                        }}
                                                        className={`text-sm font-bold truncate text-left transition ${isSelectedForDispatch ? 'text-emerald-700' : 'text-orange-900 hover:text-orange-700'} select-text`}
                                                        title="Single-click to rename, double-click to add more items to this quarantine"
                                                        aria-label="Rename or add more items to this active quarantine"
                                                    >
                                                        {renamingActiveGroupKey === group ? 'Renaming...' : group}
                                                    </div>
                                                    {isSelectedForDispatch && (
                                                        <span className="text-[11px] font-bold text-emerald-700 whitespace-nowrap">selected for stage</span>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                        <div className="text-right shrink-0">
                                            <div className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border border-amber-200 bg-amber-50 text-amber-700 mb-1">
                                                Unreleased
                                            </div>
                                            <div className="text-xs font-bold text-orange-700">{items.length} Items</div>
                                            <div className="text-xs text-orange-700">Total Reserved: {formatGroupTotals(items)}</div>
                                        </div>
                                    </div>
                                </button>

                                {isExpanded && (
                                    <>
                                        <div className="px-5 py-4 bg-orange-50/40 border-b border-orange-100">
                                            <div className="flex flex-col sm:flex-row gap-4 items-end">
                                                <div className="w-full sm:w-52">
                                                    <label className="block text-xs font-bold text-orange-800 mb-1 uppercase">Reason</label>
                                                    <select 
                                                        className="w-full border-orange-200 text-sm py-2 rounded-lg focus:ring-orange-500 bg-white font-bold text-orange-700"
                                                        value={getGroupState(group).reason}
                                                        onChange={(e) => updateGroupState(group, 'reason', e.target.value)}
                                                        disabled={isReadOnly}
                                                    >
                                                        <option value="Production">Production</option>
                                                        <option value="Waste">Waste / Spillage</option>
                                                        <option value="Sampling">Sampling</option>
                                                        <option value="Transfer">Transfer Out</option>
                                                        <option value={COMP_OUT_MANUAL_ADJUSTMENT_REASON}>Manual Adjustment</option>
                                                    </select>
                                                </div>
                                                <div className="flex-1 w-full">
                                                    <label className="block text-xs font-bold text-orange-800 mb-1 uppercase">Reason Note</label>
                                                    <input 
                                                        type="text" 
                                                        className="w-full border-orange-200 rounded-lg text-sm py-2 focus:ring-orange-500 placeholder:text-orange-300"
                                                        placeholder="Optional note for this group..."
                                                        value={getGroupState(group).note}
                                                        onChange={e => updateGroupState(group, 'note', e.target.value)}
                                                        disabled={isReadOnly}
                                                    />
                                                </div>
                                                <div className="flex gap-2 w-full sm:w-auto">
                                                    {!isReadOnly && (
                                                        <button
                                                            onClick={() => handleUpdateActiveGroup(group, items)}
                                                            disabled={items.length === 0 || updatingActiveGroupKey === group}
                                                            className="px-3 py-2 bg-white border-2 border-orange-300 text-orange-700 text-[11px] font-extrabold uppercase tracking-[0.08em] rounded-full hover:bg-orange-50 transition flex items-center disabled:opacity-50 disabled:cursor-not-allowed"
                                                        >
                                                            {updatingActiveGroupKey === group ? (
                                                                <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> OK</>
                                                            ) : (
                                                                'OK'
                                                            )}
                                                        </button>
                                                    )}
                                                    <button onClick={() => handleDownloadDispatchList(group, items)} disabled={items.length === 0} className="px-4 py-2 bg-slate-800 text-white text-xs font-bold uppercase tracking-wider rounded-lg hover:bg-slate-900 transition flex items-center"><Download className="w-4 h-4 mr-1" /> PDF</button>
                                                    {!isReadOnly && (
                                                        <>
                                                            <button onClick={() => handleBatchRelease(group, items)} disabled={items.length === 0} className="px-4 py-2 bg-green-600 text-white text-xs font-bold uppercase tracking-wider rounded-lg hover:bg-green-700 transition flex items-center"><CheckCircle className="w-4 h-4 mr-1" /> Release</button>
                                                            <button onClick={() => handleBatchPutBack(group, items)} disabled={items.length === 0} className="px-4 py-2 bg-white border border-red-200 text-red-600 text-xs font-bold uppercase tracking-wider rounded-lg hover:bg-red-50 transition flex items-center"><XCircle className="w-4 h-4 mr-1" /> Return</button>
                                                        </>
                                                    )}
                                                </div>
                                            </div>
                                        </div>

                                        <div className="mobile-scroll-hint px-4 pt-3">Swipe sideways to review the full quarantine group table.</div>
                                        <div className="mobile-table-region overflow-x-auto">
                                            <table className="w-full min-w-[760px] text-sm text-left">
                                                <thead className="bg-white text-slate-500 font-bold uppercase text-xs tracking-wider border-b border-orange-100">
                                                    <tr>
                                                        <SortableHeader
                                                            label="QC Number"
                                                            sortKey="batch"
                                                            activeSortKey={rowSortState.key}
                                                            sortDir={rowSortState.dir}
                                                            onChange={handleRowSortChange}
                                                            className="px-6 py-3 w-[30%]"
                                                        />
                                                        <SortableHeader
                                                            label="Item"
                                                            sortKey="item"
                                                            activeSortKey={rowSortState.key}
                                                            sortDir={rowSortState.dir}
                                                            onChange={handleRowSortChange}
                                                            className="px-6 py-3 w-[30%]"
                                                        />
                                                        <SortableHeader
                                                            label="Reserved"
                                                            sortKey="qty"
                                                            activeSortKey={rowSortState.key}
                                                            sortDir={rowSortState.dir}
                                                            onChange={handleRowSortChange}
                                                            className="px-6 py-3 w-[15%] text-right"
                                                        />
                                                        <th className="px-6 py-3 w-[25%] text-right">Actions</th>
                                                    </tr>
                                                </thead>
                                                <tbody className="divide-y divide-orange-50 bg-orange-50/10">
                                                    {items.map(tx => {
                                                        const isEditing = editingTxId === tx.id;
                                                        if (isEditing && editForm) {
                                                            return (
                                                                <tr key={tx.id} className="bg-white">
                                                                    <td className="px-6 py-3 align-top">
                                                                        <select className="w-full border-indigo-300 rounded text-xs py-1.5" value={editForm.batchNumber} onChange={e => setEditForm({...editForm, batchNumber: e.target.value})}>
                                                                            {editBatchOptions.map(b => <option key={b.batch} value={b.batch}>{b.batch} ({b.qty})</option>)}
                                                                        </select>
                                                                    </td>
                                                                    <td className="px-6 py-3 align-top"><div className="text-xs font-bold text-slate-500">{editForm.itemId}</div></td>
                                                                    <td className="px-6 py-3 text-right align-top"><input type="number" className="w-20 border-indigo-300 rounded text-xs py-1.5 text-right font-bold" value={editForm.quantity} onChange={e => setEditForm({...editForm, quantity: Number(e.target.value)})} /></td>
                                                                    <td className="px-6 py-3 text-right space-x-2">
                                                                        <button
                                                                            onClick={handleSaveEdit}
                                                                            disabled={isSavingEdit}
                                                                            className="text-xs font-bold text-indigo-600 inline-flex items-center disabled:opacity-60 disabled:cursor-not-allowed"
                                                                        >
                                                                            {isSavingEdit ? (
                                                                                <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> OK</>
                                                                            ) : (
                                                                                'OK'
                                                                            )}
                                                                        </button>
                                                                        <button
                                                                            onClick={() => setEditingTxId(null)}
                                                                            disabled={isSavingEdit}
                                                                            className="text-xs font-bold text-slate-400 disabled:opacity-60 disabled:cursor-not-allowed"
                                                                        >
                                                                            Cancel
                                                                        </button>
                                                                    </td>
                                                                </tr>
                                                            );
                                                        }
                                                        return (
                                                            <tr key={tx.id} className="hover:bg-orange-50 transition-colors">
                                                                <td className="px-6 py-3">
                                                                    <div className="font-mono text-xs font-bold text-slate-700">{tx.batchNumber}</div>
                                                                    <div className="text-[10px] text-slate-400 flex items-center mt-0.5"><MapPin className="w-3 h-3 mr-1"/> {tx.location}</div>
                                                                </td>
                                                                <td className="px-6 py-3">
                                                                    <div className="font-bold text-slate-800">{resolveItemDisplay(tx.itemId, tx.itemName)}</div>
                                                                    <div className="text-[10px] text-slate-400 font-mono">{tx.itemId}</div>
                                                                </td>
                                                                <td className="px-6 py-3 text-right font-mono font-bold text-orange-600">{tx.quantity} {tx.unit}</td>
                                                                <td className="px-6 py-3 text-right flex justify-end space-x-2">
                                                                    {!isReadOnly && (
                                                                        <>
                                                                            <button onClick={() => handleEditClick(tx)} className="p-1.5 text-indigo-600 hover:bg-indigo-50 rounded transition"><Edit className="w-4 h-4" /></button>
                                                                            <button onClick={() => handleConfirmUsage(tx.id, group)} className="p-1.5 text-green-600 hover:bg-green-50 rounded transition"><CheckCircle className="w-4 h-4" /></button>
                                                                            <button onClick={() => handlePutBack(tx.id)} className="p-1.5 text-red-500 hover:bg-red-50 rounded transition"><XCircle className="w-4 h-4" /></button>
                                                                        </>
                                                                    )}
                                                                </td>
                                                            </tr>
                                                        );
                                                    })}
                                                </tbody>
                                            </table>
                                        </div>
                                    </>
                                )}
                            </div>
                        );
                    })}
                    {reservedGroupEntries.length === 0 && (
                        <div className="bg-white border border-slate-200 rounded-xl px-5 py-6 text-sm text-slate-500">
                            No active quarantine groups.
                        </div>
                    )}
                </div>

                <div className="space-y-4">
                    <h3 className="text-sm font-bold text-slate-700 uppercase tracking-wider flex items-center">
                        <History className="w-4 h-4 mr-2" /> Activity History
                    </h3>
                    <div className="max-h-none md:max-h-[60vh] overflow-y-visible md:overflow-y-auto pr-0 md:pr-1 space-y-3">
                        {historyGroupEntries.map(({ group, items }) => {
                            const expandedKey = `history:${group}`;
                            const isExpanded = !!expandedGroups[expandedKey];
                            return (
                                <div key={expandedKey} className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
                                    <button
                                        onClick={() => toggleGroupExpanded(expandedKey)}
                                        className="w-full bg-slate-50 px-5 py-4 border-b border-slate-200 text-left hover:bg-slate-100 transition"
                                    >
                                        <div className="flex justify-between items-center gap-4">
                                            <div className="flex items-start gap-3 min-w-0">
                                                {isExpanded ? <ChevronDown className="w-4 h-4 text-slate-700 mt-0.5" /> : <ChevronRight className="w-4 h-4 text-slate-700 mt-0.5" />}
                                                <div className="min-w-0">
                                                <div className="text-xs text-slate-600 font-bold uppercase tracking-wider">Quarantine Name</div>
                                                <div className="flex items-center gap-2">
                                                    <div className="text-sm font-bold text-slate-800 truncate select-text">{group}</div>
                                                </div>
                                            </div>
                                            </div>
                                            <div className="text-right shrink-0">
                                                <div className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border border-emerald-200 bg-emerald-50 text-emerald-700 mb-1">
                                                    Released
                                                </div>
                                                <div className="text-xs font-bold text-slate-700">{items.length} Items</div>
                                                <div className="text-xs text-slate-600">Total: {formatGroupTotals(items)}</div>
                                            </div>
                                        </div>
                                    </button>

                                    {isExpanded && (
                                        <>
                                            <div className="px-5 py-4 bg-slate-50/60 border-b border-slate-200">
                                                <div className="flex flex-col sm:flex-row gap-4 items-end">
                                                    <div className="w-full sm:w-52">
                                                        <label className="block text-xs font-bold text-slate-600 mb-1 uppercase">Reason</label>
                                                        <select
                                                            className="w-full border-slate-300 text-sm py-2 rounded-lg focus:ring-slate-500 bg-white font-bold text-slate-700"
                                                            value={getGroupState(group).reason}
                                                            onChange={(e) => updateGroupState(group, 'reason', e.target.value)}
                                                            disabled={isReadOnly}
                                                        >
                                                            <option value="Production">Production</option>
                                                            <option value="Waste">Waste / Spillage</option>
                                                            <option value="Sampling">Sampling</option>
                                                            <option value="Transfer">Transfer Out</option>
                                                            <option value={COMP_OUT_MANUAL_ADJUSTMENT_REASON}>Manual Adjustment</option>
                                                        </select>
                                                    </div>
                                                    <div className="flex-1 w-full">
                                                        <label className="block text-xs font-bold text-slate-600 mb-1 uppercase">Reason Note</label>
                                                        <input
                                                            type="text"
                                                            className="w-full border-slate-300 rounded-lg text-sm py-2 focus:ring-slate-500"
                                                            placeholder="Optional note for this group..."
                                                            value={getGroupState(group).note}
                                                            onChange={e => updateGroupState(group, 'note', e.target.value)}
                                                            disabled={isReadOnly}
                                                        />
                                                    </div>
                                                    <div className="flex gap-2 w-full sm:w-auto">
                                                        <button onClick={() => handleDownloadDispatchList(group, items)} disabled={items.length === 0} className="px-4 py-2 bg-slate-800 text-white text-xs font-bold uppercase tracking-wider rounded-lg hover:bg-slate-900 transition flex items-center"><Download className="w-4 h-4 mr-1" /> PDF</button>
                                                        {!isReadOnly && <button onClick={() => handleUpdateHistoryGroup(group, items)} disabled={items.length === 0} className="px-4 py-2 bg-blue-600 text-white text-xs font-bold uppercase tracking-wider rounded-lg hover:bg-blue-700 transition flex items-center"><Save className="w-4 h-4 mr-1" /> Update</button>}
                                                        {!isReadOnly && <button onClick={() => handleReverseHistoryGroupToReservation(group, items)} disabled={items.length === 0} className="px-4 py-2 bg-amber-500 text-white text-xs font-bold uppercase tracking-wider rounded-lg hover:bg-amber-600 transition flex items-center"><ArrowDownLeft className="w-4 h-4 mr-1" /> Re-Quarantine</button>}
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="mobile-scroll-hint px-4 pt-3">Swipe sideways to review the released group table.</div>
                                            <div className="mobile-table-region overflow-x-auto">
                                                <table className="w-full min-w-[760px] text-sm text-left">
                                                    <thead className="bg-white text-slate-500 font-bold uppercase text-xs tracking-wider border-b border-slate-200">
                                                        <tr>
                                                            <SortableHeader
                                                                label="QC Number"
                                                                sortKey="batch"
                                                                activeSortKey={rowSortState.key}
                                                                sortDir={rowSortState.dir}
                                                                onChange={handleRowSortChange}
                                                                className="px-6 py-3 w-[30%]"
                                                            />
                                                            <SortableHeader
                                                                label="Item"
                                                                sortKey="item"
                                                                activeSortKey={rowSortState.key}
                                                                sortDir={rowSortState.dir}
                                                                onChange={handleRowSortChange}
                                                                className="px-6 py-3 w-[30%]"
                                                            />
                                                            <SortableHeader
                                                                label="Qty"
                                                                sortKey="qty"
                                                                activeSortKey={rowSortState.key}
                                                                sortDir={rowSortState.dir}
                                                                onChange={handleRowSortChange}
                                                                className="px-6 py-3 w-[15%] text-right"
                                                            />
                                                            <th className="px-6 py-3 w-[25%] text-right">Actions</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody className="divide-y divide-slate-100 bg-white">
                                                        {items.map(tx => {
                                                            const isEditing = editingTxId === tx.id;
                                                            if (isEditing && editForm) {
                                                                return (
                                                                    <tr key={tx.id} className="bg-white">
                                                                        <td className="px-6 py-3 align-top">
                                                                            <select className="w-full border-indigo-300 rounded text-xs py-1.5" value={editForm.batchNumber} onChange={e => setEditForm({...editForm, batchNumber: e.target.value})}>
                                                                                {editBatchOptions.map(b => <option key={b.batch} value={b.batch}>{b.batch} ({b.qty})</option>)}
                                                                            </select>
                                                                        </td>
                                                                        <td className="px-6 py-3 align-top"><div className="text-xs font-bold text-slate-500">{editForm.itemId}</div></td>
                                                                        <td className="px-6 py-3 text-right align-top"><input type="number" className="w-20 border-indigo-300 rounded text-xs py-1.5 text-right font-bold" value={editForm.quantity} onChange={e => setEditForm({...editForm, quantity: Number(e.target.value)})} /></td>
                                                                        <td className="px-6 py-3 text-right space-x-2">
                                                                            <button
                                                                                onClick={handleSaveEdit}
                                                                                disabled={isSavingEdit}
                                                                                className="text-xs font-bold text-indigo-600 inline-flex items-center disabled:opacity-60 disabled:cursor-not-allowed"
                                                                            >
                                                                                {isSavingEdit ? (
                                                                                    <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> OK</>
                                                                                ) : (
                                                                                    'OK'
                                                                                )}
                                                                            </button>
                                                                            <button
                                                                                onClick={() => setEditingTxId(null)}
                                                                                disabled={isSavingEdit}
                                                                                className="text-xs font-bold text-slate-400 disabled:opacity-60 disabled:cursor-not-allowed"
                                                                            >
                                                                                Cancel
                                                                            </button>
                                                                        </td>
                                                                    </tr>
                                                                );
                                                            }
                                                            return (
                                                                <tr key={tx.id} className="hover:bg-slate-50 transition-colors">
                                                                    <td className="px-6 py-3">
                                                                        <div className="font-mono text-xs font-bold text-slate-700">{tx.batchNumber}</div>
                                                                        <div className="text-[10px] text-slate-400 flex items-center mt-0.5"><MapPin className="w-3 h-3 mr-1"/> {tx.location}</div>
                                                                    </td>
                                                                    <td className="px-6 py-3">
                                                                        <div className="font-bold text-slate-800">{resolveItemDisplay(tx.itemId, tx.itemName)}</div>
                                                                        <div className="text-[10px] text-slate-400 font-mono">{tx.itemId}</div>
                                                                    </td>
                                                                    <td className="px-6 py-3 text-right font-mono font-bold text-slate-700">{tx.quantity} {tx.unit}</td>
                                                                    <td className="px-6 py-3 text-right flex justify-end space-x-2">
                                                                        {!isReadOnly && <button onClick={() => handleEditClick(tx)} className="p-1.5 text-indigo-600 hover:bg-indigo-50 rounded transition"><Edit className="w-4 h-4" /></button>}
                                                                    </td>
                                                                </tr>
                                                            );
                                                        })}
                                                    </tbody>
                                                </table>
                                            </div>
                                        </>
                                    )}
                                </div>
                            );
                        })}
                        {historyGroupEntries.length === 0 && (
                            <div className="bg-white border border-slate-200 rounded-xl px-5 py-6 text-sm text-slate-500">
                                No activity history yet.
                            </div>
                        )}
                    </div>
                </div>
            </div>
        )}

        {/* Modal */}
        {modalConfig && modalConfig.isOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 animate-in fade-in">
                <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6 border border-slate-200">
                    <div className="flex items-center mb-4 text-slate-800">
                        <AlertTriangle className={`w-6 h-6 mr-3 ${modalConfig.type === 'danger' ? 'text-red-600' : 'text-orange-600'}`} />
                        <h3 className="text-lg font-bold">{modalConfig.title}</h3>
                    </div>
                    <p className="text-sm text-slate-600 mb-6 font-medium">{modalConfig.message}</p>
                    <div className="flex justify-end gap-3">
                        {modalConfig.showCancel && <button onClick={() => setModalConfig(null)} className="px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-100 rounded-lg transition">Cancel</button>}
                        <button onClick={modalConfig.onConfirm || (() => setModalConfig(null))} disabled={isModalActionLoading} className={`px-4 py-2 text-sm font-bold text-white rounded-lg shadow-sm transition flex items-center ${modalConfig.type === 'danger' ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'}`}>
                            {isModalActionLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Confirm
                        </button>
                    </div>
                </div>
            </div>
        )}
    </div>
  );
};
