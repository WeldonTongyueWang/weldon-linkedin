/**
 * HARD BOUNDARY: PRODUCT OUT CHANGE REQUEST
 *
 * AUTHORITY: Finished Good Dispatch (Sales/Transfer).
 * RULES:
 * 1. Must not allow silent stock reduction.
 * 2. No master data edits allowed.
 * 3. Validates against available finished goods batch stock.
 */

import React, { useEffect, useState, useMemo, useRef } from 'react';
import {
  CategoryMaster,
  Component,
  ComponentType,
  Product,
  InventoryTransaction,
  LocationName,
  ProductBatch,
  RawComponentLot,
} from '../../types';
// Added MapPin to imports to fix "Cannot find name 'MapPin'" error
import {
  Truck,
  ArrowRightLeft,
  Plus,
  Trash2,
  CheckCircle,
  ShoppingCart,
  AlertCircle,
  User,
  CreditCard,
  Tag,
  Loader2,
  Edit2,
  History,
  ChevronRight,
  ChevronDown,
  Box,
  MapPin,
  AlertTriangle,
  RotateCcw,
} from 'lucide-react';
import { useIsHandheldDevice } from '../../lib/useIsHandheldDevice';
import { formatBritishDate, formatBritishDateTime } from '../../lib/dateFormatting';
import { computeLedgerStockLevels, UNBATCHED_KEY } from '../../services/ledgerStock';
import { resolveLedgerUnitCost, resolveLedgerUnitSalePrice } from '../../services/ledgerPricing';
import { resolveLedgerEventTime } from '../../services/ledgerTime';
import { parseBatchId } from '../../services/batchBusinessLogic';
import { updateLedgerTxn, deleteLedgerTxn } from '../../services/sheetsApi';
import { ActivityFilterBar } from './ActivityFilterBar';
import { SortableHeader } from './SortableHeader';
import {
  DUAL_PATH_DUPLICATE_WINDOW_MS,
  DUAL_PATH_SYSTEM_IDS,
  findDualPathDuplicateEvent,
  isDualPathItem,
  isDualPathSystemId,
} from '../../utils/dualPathItems';
import { useAppDialog } from '../ui/AppDialogProvider';
import { formatRawComponentListLabel, stripLeadingCode } from '../../utils/rawComponentLabels';
import { formatFinishedProductInventoryLabel } from '../../utils/finishedProductLabels';
import {
  INVENTORY_PRODUCT_TYPE_ORDER,
  resolveInventoryProductTypeOrder,
} from '../../services/productCategoryGrouping';

interface Props {
  inventory: Component[];
  categories?: CategoryMaster[];
  products: Product[];
  transactions: InventoryTransaction[];
  rawComponentLots: RawComponentLot[];
  productBatches: ProductBatch[];
  currentUser: string;
  onTransaction: (
    tx: Omit<InventoryTransaction, 'id' | 'date' | 'itemName' | 'unit'> & { unit?: string },
  ) => Promise<InventoryTransaction | void> | InventoryTransaction | void;
  onEditTransaction?: (
    id: string,
    updates: Partial<InventoryTransaction>,
    reason: string,
    user: string,
  ) => Promise<void> | void;
  onDeleteTransaction?: (id: string) => Promise<void> | void;
  onForceSync?: () => Promise<void> | void;
  isReadOnly?: boolean;
}

type DispatchMode = 'PO_SHIP' | 'TRANSFER' | 'MANUAL';

const getOppositeLocation = (location: LocationName): LocationName =>
  location === 'Riverside' ? 'Hilltop' : 'Riverside';
type OrderType = 'Paid' | 'Sample' | 'Internal' | 'Others';
type HistorySortKey =
  | 'createdAt'
  | 'recipientType'
  | 'salesRep'
  | 'itemsCount'
  | 'totalCost'
  | 'totalPrice'
  | 'revenue';

interface StagedItem {
  id: string;
  stagedAt: string;
  itemId: string;
  itemName: string;
  quantity: number;
  unit: string;
  batchNumber: string;
  displayBatchNumber: string;
  location: LocationName;
  destination?: LocationName;
  reason: string;
  reference: string;
  orderType: OrderType;
  recipient: string;
  salesRep: string;
  price: number;
  productionCost: number;
  dispatchMode: DispatchMode;
}

interface AvailableBatchOption {
  batch: string;
  displayBatch: string;
  qty: number;
  displayQty?: number;
  resolutionError?: string;
}

interface StagedGroup {
  key: string;
  reference: string;
  orderType: string;
  recipient: string;
  salesRep: string;
  items: StagedItem[];
}

interface DispatchHistoryGroup {
  key: string;
  reference: string;
  createdAt: string;
  recipient: string;
  salesRep: string;
  orderType: string;
  totalCost: number;
  totalPrice: number;
  revenue: number;
  itemsCount: number;
  isTransfer: boolean;
  isVoided: boolean;
  hasReversedItems: boolean;
  cancelReason?: string;
  items: InventoryTransaction[];
  allTransactions: InventoryTransaction[];
}

interface HistoryDraftLine {
  txId: string;
  quantity: number;
  price: number | string;
  note: string;
}

interface HistoryEditDraft {
  key: string;
  reference: string;
  recipient: string;
  salesRep: string;
  orderType: string;
  lines: HistoryDraftLine[];
}

interface StagedEditDraft {
  itemId: string;
  quantity: number;
  price: number | string;
  batchNumber: string;
}

interface StagedGroupEditDraft {
  originalKey: string;
  itemIds: string[];
  reference: string;
  orderType: OrderType;
  recipient: string;
  salesRep: string;
}

interface DispatchNameHistory {
  recipients: string[];
  salesReps: string[];
  recipientMap: Map<string, string>;
  salesRepMap: Map<string, string>;
}

interface EditableDispatchProductOption {
  id: string;
  name: string;
  unit: string;
  format?: string;
}

interface DispatchModalConfig {
  isOpen: boolean;
  title: string;
  message: string;
  isDangerous: boolean;
  showCancel?: boolean;
  confirmLabel?: string;
  onConfirm: () => Promise<void> | void;
}

const DISPATCH_ADJUSTMENT_REASON = 'DISPATCH_ADJUSTMENT';
const DISPATCH_VOID_REASON = 'DISPATCH_VOID';
const TARGET_TX_META_KEY = 'TARGET_TX_ID';
const DISPATCH_STAGED_REASON = 'DISPATCH_STAGED';
const DISPATCH_STAGED_CANCELLED_REASON = 'DISPATCH_STAGED_CANCELLED';
const DISPATCH_RELEASED_REASON = 'DISPATCH';
const DISPATCHED_TRANSFER_REASON = 'DISPATCHED: transfer';
const DISPATCHED_MANUAL_REASON = 'DISPATCHED: manual';
const RECIPIENT_DATALIST_ID = 'product-dispatch-recipient-suggestions';
const SALES_REP_DATALIST_ID = 'product-dispatch-sales-rep-suggestions';
const ORDER_TYPE_OPTIONS: OrderType[] = ['Paid', 'Sample', 'Internal', 'Others'];
const resolvePoDispatchReason = (orderType: OrderType): string =>
  `DISPATCH: ${String(orderType || 'Others')
    .trim()
    .toLowerCase()}`;
const DUAL_PATH_SYSTEM_ID_SET = new Set(DUAL_PATH_SYSTEM_IDS);
const DISPENSING_GROUP_NAME = '00 Dispensing';
const DISPENSING_PRODUCT_TYPE_ORDER = INVENTORY_PRODUCT_TYPE_ORDER.indexOf('Commercial Dispensing');
const STAGING_SOURCE_TAB = 'Staging';
const DISPATCH_SOURCE_TAB = 'Dispatch';
const DISPATCH_STAGING_SOURCE_TAB = 'Dispatch';
const escapeCsv = (value: string | number): string => {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
};
const resolveSourceTabForDispatch = (
  skuId: string,
  context: 'staging' | 'dispatch',
  format?: string,
): string => {
  if (isDualPathItem(skuId, format)) {
    return context === 'staging' ? STAGING_SOURCE_TAB : DISPATCH_SOURCE_TAB;
  }
  return DISPATCH_STAGING_SOURCE_TAB;
};

const formatInventoryItemName = (item: Component, categories: CategoryMaster[] = []): string =>
  formatRawComponentListLabel(item, categories);

const sanitizePipeValue = (value: string): string =>
  String(value || '')
    .replace(/\|/g, '/')
    .trim();

const buildDispatchNotes = (
  recipient: string,
  orderType: string,
  salesRep: string,
  extras: string[] = [],
) => {
  return [
    `Recipient: ${sanitizePipeValue(recipient || 'N/A')}`,
    `Order Type: ${sanitizePipeValue(orderType || 'Manual')}`,
    `Sales Rep: ${sanitizePipeValue(salesRep || '')}`,
    ...extras.filter(Boolean).map((part) => sanitizePipeValue(part)),
  ].join(' | ');
};

const getDateOnlyValue = (value: string): string => {
  const source = String(value || '').trim();
  if (!source) return '';
  const matched = source.match(/^\d{4}-\d{2}-\d{2}/);
  if (matched) return matched[0];
  const t = new Date(source).getTime();
  if (!Number.isFinite(t)) return '';
  return new Date(t).toISOString().slice(0, 10);
};

const getDefaultLast30DaysRange = (): { from: string; to: string } => {
  const toDate = new Date();
  const fromDate = new Date(toDate);
  fromDate.setDate(fromDate.getDate() - 29);
  return {
    from: fromDate.toISOString().slice(0, 10),
    to: toDate.toISOString().slice(0, 10),
  };
};

const getDisplaySalesRep = (value: string): string => String(value || '').trim() || 'Unknown';
const normalizeSearchText = (value: unknown): string =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
const normalizeDispatchNameKey = (value: unknown): string =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
const normalizeHistoryGroupNotes = (value: unknown): string =>
  String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
const matchesSearch = (fields: Array<unknown>, query: string): boolean => {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return true;
  return fields.some((field) => normalizeSearchText(field).includes(normalizedQuery));
};

const rankNameSuggestions = (values: string[], query: string): string[] => {
  const normalizedQuery = normalizeDispatchNameKey(query);
  if (!normalizedQuery) return values.slice(0, 8);

  const startsWithMatches: string[] = [];
  const containsMatches: string[] = [];
  values.forEach((value) => {
    const normalizedValue = normalizeDispatchNameKey(value);
    if (!normalizedValue) return;
    if (normalizedValue.startsWith(normalizedQuery)) {
      startsWithMatches.push(value);
      return;
    }
    if (normalizedValue.includes(normalizedQuery)) {
      containsMatches.push(value);
    }
  });

  return [...startsWithMatches, ...containsMatches].slice(0, 8);
};

const getDispatchNameSuggestions = (
  history: DispatchNameHistory,
  field: 'recipient' | 'salesRep',
  query: string,
): string[] =>
  rankNameSuggestions(field === 'recipient' ? history.recipients : history.salesReps, query);

const getCanonicalDispatchName = (
  history: DispatchNameHistory,
  field: 'recipient' | 'salesRep',
  value: string,
): string | undefined =>
  (field === 'recipient' ? history.recipientMap : history.salesRepMap).get(
    normalizeDispatchNameKey(value),
  );

export const ProductDispatch: React.FC<Props> = ({
  inventory,
  categories = [],
  products,
  transactions,
  rawComponentLots,
  productBatches,
  currentUser,
  onTransaction,
  onEditTransaction,
  onDeleteTransaction,
  onForceSync,
  isReadOnly,
}) => {
  const isHandheldDevice = useIsHandheldDevice();
  const appDialog = useAppDialog();
  const defaultHistoryDateRange = useMemo(() => getDefaultLast30DaysRange(), []);
  const [mode, setMode] = useState<DispatchMode>('PO_SHIP');
  const [staging, setStaging] = useState<StagedItem[]>([]);
  const [expandedStagingGroups, setExpandedStagingGroups] = useState<Record<string, boolean>>({});
  const [releasingGroupKeys, setReleasingGroupKeys] = useState<Record<string, boolean>>({});
  const [isDispatchingAll, setIsDispatchingAll] = useState(false);
  const [editingStagedId, setEditingStagedId] = useState<string | null>(null);
  const [stagedEditDraft, setStagedEditDraft] = useState<StagedEditDraft | null>(null);
  const [stagedGroupEditDraft, setStagedGroupEditDraft] = useState<StagedGroupEditDraft | null>(
    null,
  );
  const [isSavingStagedGroup, setIsSavingStagedGroup] = useState(false);
  const [activeStagedNameDropdown, setActiveStagedNameDropdown] = useState<
    'recipient' | 'salesRep' | null
  >(null);
  const [stagedNameDropdownWasTyped, setStagedNameDropdownWasTyped] = useState(false);
  const stagedGroupSaveInProgressRef = useRef(false);
  const stagedRowsFromLedgerRef = useRef<StagedItem[]>([]);
  const [expandedHistoryRef, setExpandedHistoryRef] = useState<string | null>(null);
  const [editingHistoryRef, setEditingHistoryRef] = useState<string | null>(null);
  const [historyEditDraft, setHistoryEditDraft] = useState<HistoryEditDraft | null>(null);
  const [isHistoryActionLoading, setIsHistoryActionLoading] = useState(false);
  const [returningHistoryKey, setReturningHistoryKey] = useState<string | null>(null);
  const [historyDraftFromDate, setHistoryDraftFromDate] = useState(defaultHistoryDateRange.from);
  const [historyDraftToDate, setHistoryDraftToDate] = useState(defaultHistoryDateRange.to);
  const [historyAppliedFromDate, setHistoryAppliedFromDate] = useState(
    defaultHistoryDateRange.from,
  );
  const [historyAppliedToDate, setHistoryAppliedToDate] = useState(defaultHistoryDateRange.to);
  const [historyDraftSearchQuery, setHistoryDraftSearchQuery] = useState('');
  const [historyAppliedSearchQuery, setHistoryAppliedSearchQuery] = useState('');
  const [historySortState, setHistorySortState] = useState<{
    key: HistorySortKey;
    dir: 'asc' | 'desc';
  }>({
    key: 'createdAt',
    dir: 'desc',
  });
  const [isAddingToStaging, setIsAddingToStaging] = useState(false);
  const [savingStagedIds, setSavingStagedIds] = useState<Record<string, boolean>>({});
  const [modalConfig, setModalConfig] = useState<DispatchModalConfig | null>(null);
  const [isModalActionLoading, setIsModalActionLoading] = useState(false);

  const persistLedgerUpdate = async (
    id: string,
    updates: Partial<InventoryTransaction>,
    reason: string,
  ) => {
    if (onEditTransaction) {
      await onEditTransaction(id, updates, reason, currentUser);
      return;
    }
    await updateLedgerTxn(id, {
      ...updates,
      updatedBy: currentUser,
      editReason: reason,
      updatedAt: new Date().toISOString(),
    });
  };

  const persistLedgerUpdateWithoutLocalOptimism = async (
    id: string,
    updates: Partial<InventoryTransaction>,
    reason: string,
  ) => {
    await updateLedgerTxn(id, {
      ...updates,
      updatedBy: currentUser,
      editReason: reason,
      updatedAt: new Date().toISOString(),
    });
  };

  const [formSku, setFormSku] = useState('');
  const [formBatch, setFormBatch] = useState('');
  const [formQty, setFormQty] = useState<number>(0);
  const [formLocation, setFormLocation] = useState<LocationName>('Riverside');
  const [formDestination, setFormDestination] = useState<LocationName>('Hilltop');
  const [formReason, setFormReason] = useState('Sales');
  const [formManualNote, setFormManualNote] = useState('');
  const [formRef, setFormRef] = useState('');
  const [formOrderType, setFormOrderType] = useState<OrderType>('Paid');
  const [formRecipient, setFormRecipient] = useState('');
  const [formSalesRep, setFormSalesRep] = useState('');
  const [formPrice, setFormPrice] = useState<string>('');
  const dispatchReferenceInputRef = useRef<HTMLInputElement | null>(null);
  const transferDestination = getOppositeLocation(formLocation);

  const openInfoModal = (message: string, title = 'Notice', isDangerous = false) => {
    setModalConfig({
      isOpen: true,
      title,
      message,
      isDangerous,
      showCancel: false,
      confirmLabel: 'OK',
      onConfirm: () => setModalConfig(null),
    });
  };

  const normalizeBatchKey = (value: unknown): string =>
    String(value ?? '')
      .trim()
      .toLowerCase();
  const normalizeStagingPart = (value: unknown): string =>
    String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  const parseDecimalInput = (value: unknown): number => {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) return 0;
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? numeric : 0;
  };
  const buildStagingKey = (
    reference: string,
    orderType: string,
    recipient: string,
    salesRep: string,
  ): string =>
    `${normalizeStagingPart(reference)}||${normalizeStagingPart(orderType)}||${normalizeStagingPart(recipient)}||${normalizeStagingPart(salesRep)}`;
  const getStagingKeyForItem = (
    item: Pick<StagedItem, 'reference' | 'orderType' | 'recipient' | 'salesRep'>,
  ): string =>
    buildStagingKey(
      item.reference || '',
      item.orderType || '',
      item.recipient || '',
      item.salesRep || '',
    );

  const parseRecipient = (notes: string | undefined, fallback: string): string => {
    const recipientMatch = notes?.match(/Recipient: (.*?) \|/);
    return recipientMatch ? recipientMatch[1] : fallback;
  };

  const parseOrderType = (notes: string | undefined, fallback: string): string => {
    const typeMatch = notes?.match(/Order Type: (.*?)( \| |$)/);
    return typeMatch ? typeMatch[1] : fallback;
  };

  const parseSalesRep = (notes: string | undefined, fallback: string): string => {
    const salesRepMatch = notes?.match(/Sales Rep: (.*?)( \| |$)/);
    return salesRepMatch ? salesRepMatch[1] : fallback;
  };

  const parseLineNote = (notes: string | undefined): string => {
    const noteMatch = notes?.match(/\| Note: (.*?)( \| |$)/);
    if (noteMatch) return noteMatch[1];
    const metaMatch = notes?.match(/LINE_NOTE=([^|]+)/);
    return metaMatch ? metaMatch[1].trim() : '';
  };

  const parseStageMeta = (notes: string | undefined, key: string): string => {
    const match = notes?.match(new RegExp(`${key}=([^|]+)`));
    return match ? match[1].trim() : '';
  };

  const parseAdjustmentTargetTxId = (notes: string | undefined): string | null => {
    const targetMatch = notes?.match(new RegExp(`${TARGET_TX_META_KEY}=([^|]+)`));
    if (targetMatch) return targetMatch[1].trim();
    const legacyMatch = notes?.match(/ADJUSTMENT_OF:([^|]+)/);
    if (legacyMatch) return legacyMatch[1].trim();
    const legacyVoidTx = notes?.match(/VOID_OF_TX:([^|]+)/);
    return legacyVoidTx ? legacyVoidTx[1].trim() : null;
  };

  const parseAdjustmentKind = (notes: string | undefined): 'APPLY' | 'REVERSE' | null => {
    const match = notes?.match(/ADJ_KIND=([^|]+)/);
    const kind = String(match?.[1] || '')
      .trim()
      .toUpperCase();
    if (kind === 'APPLY' || kind === 'REVERSE') return kind;
    return null;
  };

  const parseVoidReference = (notes: string | undefined): string | null => {
    const match = notes?.match(/VOID_OF_REF:([^|]+)/);
    return match ? match[1].trim() : null;
  };

  const parseVoidReason = (notes: string | undefined): string => {
    const match = notes?.match(/VOID_REASON=([^|]+)/);
    return match ? match[1].trim() : '';
  };

  const dispatchNameHistory = useMemo<DispatchNameHistory>(() => {
    const recipientMap = new Map<string, string>();
    const salesRepMap = new Map<string, string>();

    transactions
      .filter((tx) => tx.category === 'PRODUCT' && tx.type === 'OUT')
      .sort(
        (a, b) =>
          new Date(resolveLedgerEventTime(b)).getTime() -
          new Date(resolveLedgerEventTime(a)).getTime(),
      )
      .forEach((tx) => {
        const recipient = parseRecipient(tx.notes, '');
        const salesRep = String(tx.salesRep || '').trim() || parseSalesRep(tx.notes, '');

        const recipientKey = normalizeDispatchNameKey(recipient);
        if (recipientKey && !recipientMap.has(recipientKey)) {
          recipientMap.set(recipientKey, recipient.trim());
        }

        const salesRepKey = normalizeDispatchNameKey(salesRep);
        if (salesRepKey && !salesRepMap.has(salesRepKey)) {
          salesRepMap.set(salesRepKey, salesRep.trim());
        }
      });

    return {
      recipients: Array.from(recipientMap.values()),
      salesReps: Array.from(salesRepMap.values()),
      recipientMap,
      salesRepMap,
    };
  }, [transactions]);

  const recipientSuggestions = useMemo(
    () => getDispatchNameSuggestions(dispatchNameHistory, 'recipient', formRecipient),
    [dispatchNameHistory, formRecipient],
  );

  const salesRepSuggestions = useMemo(
    () => getDispatchNameSuggestions(dispatchNameHistory, 'salesRep', formSalesRep),
    [dispatchNameHistory, formSalesRep],
  );

  const stagedRecipientSuggestions = useMemo(
    () =>
      getDispatchNameSuggestions(
        dispatchNameHistory,
        'recipient',
        activeStagedNameDropdown === 'recipient' && !stagedNameDropdownWasTyped
          ? ''
          : stagedGroupEditDraft?.recipient || '',
      ),
    [
      activeStagedNameDropdown,
      dispatchNameHistory,
      stagedGroupEditDraft?.recipient,
      stagedNameDropdownWasTyped,
    ],
  );

  const stagedSalesRepSuggestions = useMemo(
    () =>
      getDispatchNameSuggestions(
        dispatchNameHistory,
        'salesRep',
        activeStagedNameDropdown === 'salesRep' && !stagedNameDropdownWasTyped
          ? ''
          : stagedGroupEditDraft?.salesRep || '',
      ),
    [
      activeStagedNameDropdown,
      dispatchNameHistory,
      stagedGroupEditDraft?.salesRep,
      stagedNameDropdownWasTyped,
    ],
  );

  const canonicalizeRecipientInput = () => {
    const canonical = getCanonicalDispatchName(dispatchNameHistory, 'recipient', formRecipient);
    if (canonical && canonical !== formRecipient) setFormRecipient(canonical);
  };

  const canonicalizeSalesRepInput = () => {
    const canonical = getCanonicalDispatchName(dispatchNameHistory, 'salesRep', formSalesRep);
    if (canonical && canonical !== formSalesRep) setFormSalesRep(canonical);
  };

  const handleUseStagedDispatchDetails = (
    group: Pick<StagedGroup, 'reference' | 'orderType' | 'recipient' | 'salesRep'>,
  ) => {
    setMode('PO_SHIP');
    setFormRef(group.reference || '');
    setFormOrderType((group.orderType as OrderType) || 'Paid');
    setFormRecipient(group.recipient || '');
    setFormSalesRep(group.salesRep || '');

    window.setTimeout(() => {
      if (dispatchReferenceInputRef.current) {
        dispatchReferenceInputRef.current.focus();
        dispatchReferenceInputRef.current.select();
      }
    }, 0);
  };

  const parseTransferDestination = (
    reason: string | undefined,
    notes?: string | undefined,
  ): LocationName | null => {
    const stagedDestination = parseStageMeta(notes, 'STAGE_DEST').toLowerCase();
    if (stagedDestination === 'riverside') return 'Riverside';
    if (stagedDestination === 'hilltop') return 'Hilltop';
    const match = String(reason || '').match(/transfer to\s+(.+)$/i);
    if (!match) return null;
    const value = match[1].trim().toLowerCase();
    if (value === 'riverside') return 'Riverside';
    if (value === 'hilltop') return 'Hilltop';
    return null;
  };

  const resolveBatchIdentity = (batch: ProductBatch | undefined | null): string => {
    if (!batch) return '';
    return String((batch as any).batch_id ?? batch.id ?? '').trim();
  };

  const resolveBatchRecordByReference = (
    skuId: string,
    batchReference: string,
  ): ProductBatch | null => {
    const normalizedSku = normalizeBatchKey(skuId);
    const normalizedReference = normalizeBatchKey(batchReference);
    if (!normalizedSku || !normalizedReference) return null;

    const exactMatch = productBatches.find(
      (batch) =>
        normalizeBatchKey(batch.sku_id) === normalizedSku &&
        normalizeBatchKey(resolveBatchIdentity(batch)) === normalizedReference,
    );
    if (exactMatch) return exactMatch;

    const parsed = parseBatchId(batchReference);
    if (parsed.type) return null;

    const legacyMatches = productBatches.filter(
      (batch) =>
        normalizeBatchKey(batch.sku_id) === normalizedSku &&
        normalizeBatchKey(batch.batch_number) === normalizedReference,
    );
    if (legacyMatches.length > 1) {
      throw new Error('Legacy batch reference cannot be uniquely resolved.');
    }
    return legacyMatches[0] || null;
  };

  const resolveBatchForDispatch = (
    skuId: string,
    batchReference: string,
  ): {
    canonicalBatchId: string;
    displayBatch: string;
  } => {
    const normalizedReference = String(batchReference || '').trim();
    if (!normalizedReference) {
      return { canonicalBatchId: '', displayBatch: '' };
    }

    const parsed = parseBatchId(normalizedReference);
    if (parsed.type === 'STANDARD') {
      return {
        canonicalBatchId: normalizedReference,
        displayBatch: parsed.printedBatchNumber || normalizedReference,
      };
    }
    if (parsed.type === 'DISPENSING') {
      return {
        canonicalBatchId: normalizedReference,
        displayBatch: normalizedReference,
      };
    }

    const matched = resolveBatchRecordByReference(skuId, normalizedReference);
    if (!matched) {
      return {
        canonicalBatchId: normalizedReference,
        displayBatch: normalizedReference,
      };
    }

    const canonical = resolveBatchIdentity(matched) || normalizedReference;
    return {
      canonicalBatchId: canonical,
      displayBatch: matched.batch_number || canonical,
    };
  };

  const ledgerStockLevels = useMemo(
    () => computeLedgerStockLevels(transactions, [], productBatches),
    [transactions, productBatches],
  );

  const productStockMap = useMemo(() => {
    const map: Record<string, number> = {};
    products.forEach((product) => {
      map[product.sku_id] = Number(ledgerStockLevels[product.sku_id]?.totalAvailable || 0);
    });
    return map;
  }, [products, ledgerStockLevels]);

  const selectedDefaultUnit = useMemo(() => {
    if (!formSku) return 'kg';
    const productUnit = products.find((p) => p.sku_id === formSku)?.default_unit;
    if (productUnit) return productUnit;
    const itemUnit = inventory.find((i) => i.component_id === formSku)?.default_unit;
    return itemUnit || 'kg';
  }, [formSku, products, inventory]);

  const dualPathFormatBySku = useMemo(() => {
    const map = new Map<string, string>();
    products.forEach((product) => {
      map.set(
        String(product.sku_id || '')
          .trim()
          .toUpperCase(),
        String(product.format || ''),
      );
    });
    return map;
  }, [products]);

  const resolveDualPathFormat = (skuId: string): string =>
    dualPathFormatBySku.get(
      String(skuId || '')
        .trim()
        .toUpperCase(),
    ) || '';

  const stagedSkuDisplayMap = useMemo(() => {
    const map = new Map<string, string>();
    products.forEach((product) => {
      const key = String(product.sku_id || '')
        .trim()
        .toUpperCase();
      if (!key) return;
      const displayName = formatFinishedProductInventoryLabel(product);
      if (displayName) map.set(key, displayName);
    });
    return map;
  }, [products]);

  const stagedInventoryDisplayMap = useMemo(() => {
    const map = new Map<string, string>();
    inventory.forEach((item) => {
      const key = String(item.component_id || '')
        .trim()
        .toUpperCase();
      if (!key) return;
      const displayName = formatInventoryItemName(item, categories);
      if (displayName) map.set(key, displayName);
    });
    rawComponentLots.forEach((lot) => {
      const key = String(lot.itemId || '')
        .trim()
        .toUpperCase();
      if (!key || map.has(key)) return;
      const inventoryItem = inventory.find(
        (item) =>
          String(item.component_id || '')
            .trim()
            .toUpperCase() === key,
      );
      if (!inventoryItem) return;
      const displayName = formatInventoryItemName(inventoryItem, categories);
      if (displayName) map.set(key, displayName);
    });
    return map;
  }, [inventory, rawComponentLots]);

  const resolveDispatchItemDisplayName = (item: { itemId: string; itemName?: string }): string => {
    const key = String(item.itemId || '')
      .trim()
      .toUpperCase();
    return (
      stagedSkuDisplayMap.get(key) ||
      stagedInventoryDisplayMap.get(key) ||
      item.itemName ||
      item.itemId
    );
  };

  const resolveStagedItemDisplayName = (item: Pick<StagedItem, 'itemId' | 'itemName'>): string =>
    resolveDispatchItemDisplayName(item);

  const resolveEditableProductOption = (
    itemId: string,
    fallback?: Partial<Pick<StagedItem, 'itemName' | 'unit'>>,
  ): EditableDispatchProductOption => {
    const normalizedId = String(itemId || '').trim();
    const product = products.find((entry) => String(entry.sku_id || '').trim() === normalizedId);
    const inventoryItem = inventory.find(
      (entry) => String(entry.component_id || '').trim() === normalizedId,
    );
    const latestLot = rawComponentLots.find(
      (lot) => String(lot.itemId || '').trim() === normalizedId,
    );
    const latestTx = transactions.find(
      (tx) => tx.category === 'PRODUCT' && String(tx.itemId || '').trim() === normalizedId,
    );
    const name =
      (product ? formatFinishedProductInventoryLabel(product) : '') ||
      (inventoryItem ? formatInventoryItemName(inventoryItem, categories) : '') ||
      fallback?.itemName ||
      latestTx?.itemName ||
      normalizedId;
    return {
      id: normalizedId,
      name,
      unit:
        product?.default_unit ||
        inventoryItem?.default_unit ||
        fallback?.unit ||
        latestTx?.unit ||
        latestLot?.unit ||
        'kg',
      format: product?.format || '',
    };
  };

  const editableDispatchProductOptions = useMemo<EditableDispatchProductOption[]>(() => {
    const map = new Map<string, EditableDispatchProductOption>();
    const addOption = (
      id: string,
      fallback?: Partial<Pick<StagedItem, 'itemName' | 'unit'>>,
      requireStock = true,
    ) => {
      const normalizedId = String(id || '').trim();
      if (!normalizedId || map.has(normalizedId)) return;
      const stock = Number(ledgerStockLevels[normalizedId]?.totalAvailable || 0);
      if (requireStock && stock <= 0.0001) return;
      map.set(normalizedId, resolveEditableProductOption(normalizedId, fallback));
    };

    products
      .filter(
        (product) =>
          isDualPathSystemId(product.sku_id) ||
          !String(product.category || '')
            .toLowerCase()
            .includes('archived'),
      )
      .forEach((product) => addOption(product.sku_id));

    rawComponentLots
      .filter((lot) => isDualPathSystemId(String(lot.itemId || '').trim()))
      .forEach((lot) => addOption(lot.itemId, { unit: lot.unit }));

    return Array.from(map.values()).sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
  }, [products, inventory, categories, rawComponentLots, transactions, ledgerStockLevels]);

  const getEditableProductsForStagedItem = (item: StagedItem): EditableDispatchProductOption[] => {
    const options = [...editableDispatchProductOptions];
    if (!options.some((option) => option.id === item.itemId)) {
      options.unshift(resolveEditableProductOption(item.itemId, item));
    }
    return options;
  };

  const groupedProductOptions = useMemo(() => {
    const groups: Record<
      string,
      Array<{ id: string; name: string; sortKey: string; typeOrder: number }>
    > = {};
    const seenIds = new Set<string>();
    const latestProductTxById = new Map<string, InventoryTransaction>();
    transactions
      .filter((tx) => tx.category === 'PRODUCT')
      .sort(
        (a, b) =>
          new Date(resolveLedgerEventTime(b)).getTime() -
          new Date(resolveLedgerEventTime(a)).getTime(),
      )
      .forEach((tx) => {
        const id = String(tx.itemId || '').trim();
        if (!id || latestProductTxById.has(id)) return;
        latestProductTxById.set(id, tx);
      });
    products
      .filter(
        (p) => isDualPathSystemId(p.sku_id) || !p.category?.toLowerCase().includes('archived'),
      )
      .filter((p) => mode === 'MANUAL' || (productStockMap[p.sku_id] || 0) > 0.0001)
      .forEach((p) => {
        const family = isDualPathSystemId(p.sku_id) ? DISPENSING_GROUP_NAME : p.family || 'Other';
        if (!groups[family]) groups[family] = [];
        const stock = productStockMap[p.sku_id] || 0;
        groups[family].push({
          id: p.sku_id,
          name: `${formatFinishedProductInventoryLabel(p)} (Stock: ${stock.toLocaleString()} ${p.default_unit || 'kg'})`,
          sortKey: p.sku_name || '',
          typeOrder: resolveInventoryProductTypeOrder(p),
        });
        seenIds.add(
          String(p.sku_id || '')
            .trim()
            .toUpperCase(),
        );
      });

    const syntheticDispensing = Array.from(DUAL_PATH_SYSTEM_ID_SET)
      .filter((id) => !seenIds.has(id))
      .filter((id) => Number(ledgerStockLevels[id]?.totalAvailable || 0) > 0.0001)
      .map((id) => {
        const stock = Number(ledgerStockLevels[id]?.totalAvailable || 0);
        return {
          id,
          name: `${id} [${id}] (Stock: ${stock.toLocaleString()} kg)`,
          sortKey: id,
          typeOrder: DISPENSING_PRODUCT_TYPE_ORDER,
        };
      });
    const rawLotDispensingIds = Array.from(
      new Set(
        rawComponentLots
          .map((lot) => String(lot.itemId || '').trim())
          .filter((id) => !!id && isDualPathSystemId(id)),
      ),
    )
      .filter((id) => !seenIds.has(id.toUpperCase()))
      .filter((id) => Number(ledgerStockLevels[id]?.totalAvailable || 0) > 0.0001)
      .map((id) => {
        const stock = Number(ledgerStockLevels[id]?.totalAvailable || 0);
        const tx = latestProductTxById.get(id);
        const inventoryItem = inventory.find(
          (item) => String(item.component_id || '').trim() === id,
        );
        const inventoryName = inventoryItem
          ? formatInventoryItemName(inventoryItem, categories)
          : '';
        const lotUnit =
          rawComponentLots.find((lot) => String(lot.itemId || '').trim() === id)?.unit || 'kg';
        const unit = tx?.unit || lotUnit;
        const name = inventoryName || tx?.itemName || id;
        return {
          id,
          name: `${name} [${id}] (Stock: ${stock.toLocaleString()} ${unit})`,
          sortKey: name,
          typeOrder: DISPENSING_PRODUCT_TYPE_ORDER,
        };
      });
    if (syntheticDispensing.length > 0) {
      if (!groups[DISPENSING_GROUP_NAME]) groups[DISPENSING_GROUP_NAME] = [];
      groups[DISPENSING_GROUP_NAME].push(...syntheticDispensing);
    }
    if (rawLotDispensingIds.length > 0) {
      if (!groups[DISPENSING_GROUP_NAME]) groups[DISPENSING_GROUP_NAME] = [];
      groups[DISPENSING_GROUP_NAME].push(...rawLotDispensingIds);
    }

    return Object.entries(groups)
      .map(([name, items]) => ({
        name,
        items: items.sort(
          (a, b) =>
            a.typeOrder - b.typeOrder ||
            a.sortKey.localeCompare(b.sortKey) ||
            a.id.localeCompare(b.id),
        ),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [
    inventory,
    products,
    transactions,
    rawComponentLots,
    productStockMap,
    ledgerStockLevels,
    mode,
  ]);

  const stagedGroups = useMemo<StagedGroup[]>(() => {
    const orderedKeys: string[] = [];
    const map: Record<string, StagedGroup> = {};
    staging.forEach((item) => {
      const key = getStagingKeyForItem(item);
      if (!map[key]) {
        orderedKeys.push(key);
        map[key] = {
          key,
          reference: item.reference || '',
          orderType: item.orderType || '',
          recipient: item.recipient || '',
          salesRep: item.salesRep || '',
          items: [],
        };
      }
      map[key].items.push(item);
    });
    return orderedKeys.map((key) => ({
      ...map[key],
      items: [...map[key].items].sort((a, b) => {
        const aTime = new Date(a.stagedAt || 0).getTime();
        const bTime = new Date(b.stagedAt || 0).getTime();
        return aTime - bTime;
      }),
    }));
  }, [staging]);

  const stagedRowsFromLedger = useMemo<StagedItem[]>(() => {
    return transactions
      .filter(
        (tx) =>
          tx.category === 'PRODUCT' &&
          tx.type === 'OUT' &&
          (tx.sourceTab === DISPATCH_STAGING_SOURCE_TAB || tx.sourceTab === STAGING_SOURCE_TAB) &&
          tx.reason === DISPATCH_STAGED_REASON,
      )
      .map((tx) => {
        const stageMode = parseStageMeta(tx.notes, 'STAGE_MODE') as DispatchMode;
        const stageReason = parseStageMeta(tx.notes, 'STAGE_REASON');
        const stageDest = parseStageMeta(tx.notes, 'STAGE_DEST');
        const orderType = (parseOrderType(tx.notes, 'Paid') as OrderType) || 'Paid';
        const recipient = parseRecipient(tx.notes, '');
        const salesRep = String(tx.salesRep || '').trim() || parseSalesRep(tx.notes, '');
        let displayBatchNumber = String(tx.batchNumber || '');
        try {
          displayBatchNumber =
            resolveBatchForDispatch(tx.itemId, String(tx.batchNumber || '')).displayBatch ||
            displayBatchNumber;
        } catch {
          displayBatchNumber = String(tx.batchNumber || '');
        }
        const productionCost = resolveLedgerUnitCost(tx, { productBatches });
        return {
          id: String(tx.id || ''),
          stagedAt: resolveLedgerEventTime(tx),
          itemId: tx.itemId,
          itemName: tx.itemName || tx.itemId,
          quantity: Number(tx.quantity || 0),
          unit: tx.unit || 'kg',
          batchNumber: String(tx.batchNumber || ''),
          displayBatchNumber,
          location: tx.location as LocationName,
          destination:
            stageDest === 'Riverside' || stageDest === 'Hilltop'
              ? (stageDest as LocationName)
              : undefined,
          reason: stageReason || tx.reason || '',
          reference: tx.reference || '',
          orderType,
          recipient,
          salesRep,
          price: resolveLedgerUnitSalePrice(tx),
          productionCost,
          dispatchMode: stageMode || 'PO_SHIP',
        } as StagedItem;
      });
  }, [transactions, productBatches]);

  useEffect(() => {
    stagedRowsFromLedgerRef.current = stagedRowsFromLedger;
    if (!stagedGroupSaveInProgressRef.current) {
      setStaging(stagedRowsFromLedger);
    }
  }, [stagedRowsFromLedger]);

  const getAvailableBatches = (
    skuId: string,
    location: string,
    includeKnownBatches = false,
  ): AvailableBatchOption[] => {
    if (!skuId) return [];
    const position = ledgerStockLevels[skuId];
    if (!position && !includeKnownBatches) return [];
    const isDualPathSku = isDualPathItem(skuId, resolveDualPathFormat(skuId));

    const aggregated = new Map<string, AvailableBatchOption>();
    if (isDualPathSku && position) {
      rawComponentLots
        .filter(
          (lot) =>
            String(lot.itemId || '').trim() === skuId && String(lot.qc_number || '').trim() !== '',
        )
        .forEach((lot) => {
          const qc = String(lot.qc_number || '').trim();
          const qty = Number(position.byBatchLocation?.[qc]?.[location]?.available || 0);
          if (qty <= 0.001) return;
          aggregated.set(qc, { batch: qc, displayBatch: qc, qty });
        });
    }
    Object.entries(position?.byBatchLocation || {}).forEach(([batchReference, locationMap]) => {
      if (batchReference === UNBATCHED_KEY) return;
      const qty = Number(locationMap?.[location]?.available || 0);
      if (qty <= 0.001) return;
      if (isDualPathSku && aggregated.has(batchReference)) return;

      if (isDualPathSku) {
        aggregated.set(batchReference, {
          batch: batchReference,
          displayBatch: batchReference,
          qty,
        });
        return;
      }

      try {
        const resolved = resolveBatchForDispatch(skuId, batchReference);
        const stableBatchReference = String(batchReference || '').trim();
        if (!stableBatchReference) return;
        const existing = aggregated.get(stableBatchReference);
        if (!existing) {
          aggregated.set(stableBatchReference, {
            batch: stableBatchReference,
            displayBatch: resolved.displayBatch || stableBatchReference,
            qty,
          });
        } else {
          existing.qty += qty;
          aggregated.set(stableBatchReference, existing);
        }
      } catch (error) {
        const key = `__legacy__${batchReference}`;
        aggregated.set(key, {
          batch: key,
          displayBatch: batchReference,
          qty,
          resolutionError:
            error instanceof Error
              ? error.message
              : 'Legacy batch reference cannot be uniquely resolved.',
        });
      }
    });

    if (includeKnownBatches && !isDualPathSku) {
      productBatches
        .filter(
          (batch) =>
            normalizeBatchKey(batch.sku_id) === normalizeBatchKey(skuId) &&
            normalizeBatchKey(batch.location) === normalizeBatchKey(location) &&
            !['rejected', 'qc_rejected'].includes(normalizeBatchKey(batch.status)),
        )
        .forEach((batch) => {
          const stableBatchReference =
            resolveBatchIdentity(batch) || String(batch.batch_number || '').trim();
          if (!stableBatchReference || aggregated.has(stableBatchReference)) return;
          aggregated.set(stableBatchReference, {
            batch: stableBatchReference,
            displayBatch: batch.batch_number || stableBatchReference,
            qty: 0,
          });
        });
    }

    return Array.from(aggregated.values())
      .filter(({ qty }) => includeKnownBatches || qty > 0.001)
      .sort((a, b) => a.qty - b.qty);
  };

  const getEditableBatchesForStagedItem = (item: StagedItem): AvailableBatchOption[] => {
    const availableBatches = getAvailableBatches(item.itemId, item.location);
    const currentBatchKey = String(item.batchNumber || '').trim();
    if (!currentBatchKey) return availableBatches;

    const currentQty = Number(item.quantity || 0);
    const currentBatch = availableBatches.find((batch) => batch.batch === currentBatchKey);
    if (currentBatch) {
      return availableBatches.map((batch) =>
        batch.batch === currentBatchKey
          ? {
              ...batch,
              displayQty: Number(batch.qty || 0),
              qty: Number(batch.qty || 0) + currentQty,
            }
          : batch,
      );
    }

    return [
      {
        batch: currentBatchKey,
        displayBatch: item.displayBatchNumber || currentBatchKey,
        displayQty: 0,
        qty: currentQty,
      },
      ...availableBatches,
    ];
  };

  const availableBatchesForForm = useMemo(
    () => getAvailableBatches(formSku, formLocation, mode === 'MANUAL' && formQty < 0),
    [formSku, formLocation, mode, formQty, ledgerStockLevels, productBatches, rawComponentLots],
  );

  const canAddToStaging = useMemo(() => {
    const parsedFormPrice = parseDecimalInput(formPrice);
    const isManualAdjustment = mode === 'MANUAL';
    const isManualIncrease = isManualAdjustment && formQty < 0;
    if (!formSku || formQty === 0) return false;
    if (!isManualAdjustment && formQty < 0) return false;
    if (mode === 'PO_SHIP' && (!formBatch || !formRecipient)) return false;
    if (mode === 'PO_SHIP' && formOrderType === 'Paid' && !String(formPrice).trim()) return false;
    if (mode === 'PO_SHIP' && formOrderType === 'Paid' && parsedFormPrice < 0) return false;
    if (mode === 'MANUAL') {
      if (!formBatch) return false;
      if (!formManualNote || formManualNote.trim().length === 0) return false;
    }
    if (mode === 'TRANSFER') {
      if (!formBatch) return false;
    }
    const batchData = availableBatchesForForm.find((b) => b.batch === formBatch);
    if (!batchData) return false;
    if (!isManualIncrease && batchData.qty < formQty) return false;
    return true;
  }, [
    formSku,
    formQty,
    mode,
    formBatch,
    formManualNote,
    formLocation,
    availableBatchesForForm,
    formRecipient,
    formOrderType,
    formPrice,
  ]);

  const handleAddToStaging = async () => {
    if (!canAddToStaging) return;
    setIsAddingToStaging(true);
    try {
      const product = products.find((p) => p.sku_id === formSku);
      const latestMatchingLot = rawComponentLots.find(
        (lot) => String(lot.itemId || '').trim() === formSku,
      );
      const latestTx = transactions.find(
        (tx) => tx.category === 'PRODUCT' && tx.itemId === formSku,
      );
      const inventoryItem = inventory.find(
        (item) => String(item.component_id || '').trim() === formSku,
      );

      const selectedBatch = availableBatchesForForm.find((option) => option.batch === formBatch);
      if (!selectedBatch) return;
      if (selectedBatch.resolutionError) {
        openInfoModal(selectedBatch.resolutionError, 'Error', true);
        return;
      }

      let batchMasterRecord: ProductBatch | null = null;
      try {
        batchMasterRecord = resolveBatchRecordByReference(formSku, selectedBatch.batch);
      } catch (error) {
        openInfoModal(
          error instanceof Error
            ? error.message
            : 'Legacy batch reference cannot be uniquely resolved.',
          'Error',
          true,
        );
        return;
      }
      const prodCost = batchMasterRecord?.unit_cost || 0;

      const resolvedOrderType: OrderType =
        mode === 'PO_SHIP' ? formOrderType : mode === 'TRANSFER' ? 'Internal' : 'Others';
      const resolvedRecipient = mode === 'PO_SHIP' ? formRecipient : '';
      const resolvedSalesRep = mode === 'PO_SHIP' ? formSalesRep : '';
      const parsedFormPrice = parseDecimalInput(formPrice);
      const stagedReference =
        mode === 'TRANSFER' ? 'Transfer' : mode === 'MANUAL' ? 'Manual/Adj' : formRef;
      const stagedReasonText =
        mode === 'TRANSFER'
          ? `Transfer to ${transferDestination}`
          : mode === 'MANUAL'
            ? formManualNote
            : `${resolvedOrderType}: ${formReason}`;
      const stagedNotes = buildDispatchNotes(
        resolvedRecipient,
        resolvedOrderType,
        resolvedSalesRep,
        [
          `STAGE_MODE=${mode}`,
          mode === 'TRANSFER' ? `STAGE_DEST=${transferDestination}` : '',
          `STAGE_REASON=${stagedReasonText}`,
        ],
      );

      const item: StagedItem = {
        id: '',
        stagedAt: new Date().toISOString(),
        itemId: formSku,
        itemName:
          (product ? formatFinishedProductInventoryLabel(product) : '') ||
          (inventoryItem ? formatInventoryItemName(inventoryItem, categories) : '') ||
          latestTx?.itemName ||
          formSku,
        quantity: formQty,
        unit: selectedDefaultUnit || latestTx?.unit || latestMatchingLot?.unit || 'kg',
        batchNumber: selectedBatch.batch,
        displayBatchNumber: selectedBatch.displayBatch,
        location: formLocation,
        destination: mode === 'TRANSFER' ? transferDestination : undefined,
        reason: stagedReasonText,
        reference: stagedReference,
        orderType: resolvedOrderType,
        recipient: resolvedRecipient,
        salesRep: resolvedSalesRep,
        price: resolvedOrderType === 'Paid' ? parsedFormPrice : 0,
        productionCost: prodCost,
        dispatchMode: mode,
      };
      if (isDualPathItem(item.itemId, product?.format)) {
        const duplicateTx = findDualPathDuplicateEvent({
          transactions,
          itemId: item.itemId,
          batchNumber: item.batchNumber,
          quantity: Number(item.quantity || 0),
          windowMs: DUAL_PATH_DUPLICATE_WINDOW_MS,
        });
        if (duplicateTx) {
          const duplicateTime = resolveLedgerEventTime(duplicateTx);
          const displayTime = duplicateTime ? formatBritishDateTime(duplicateTime) : 'recently';
          const windowMinutes = Math.floor(DUAL_PATH_DUPLICATE_WINDOW_MS / 60000);
          const shouldContinue = await appDialog.confirm({
            title: 'Duplicate warning',
            message: `Matching OUT event already exists (${item.itemId}, batch ${item.batchNumber}, qty ${item.quantity}) within the last ${windowMinutes} minutes at ${displayTime}. Continue registering anyway?`,
            tone: 'warning',
            confirmLabel: 'Continue',
            cancelLabel: 'Cancel',
          });
          if (!shouldContinue) return;
        }
      }
      const groupKey = getStagingKeyForItem(item);
      await onTransaction({
        type: 'OUT',
        category: 'PRODUCT',
        itemId: item.itemId,
        quantity: item.quantity,
        unit: item.unit,
        location: item.location,
        batchNumber: item.batchNumber,
        reason: DISPATCH_STAGED_REASON,
        reference: item.reference,
        unitSalePrice: item.orderType === 'Paid' ? item.price : 0,
        salesRep: item.salesRep || undefined,
        notes: stagedNotes,
        user: currentUser,
        sourceTab: resolveSourceTabForDispatch(item.itemId, 'staging', product?.format),
      });
      setExpandedStagingGroups((prev) => ({ ...prev, [groupKey]: false }));
      setFormQty(0);
      setFormBatch('');
      setFormPrice('');
      openInfoModal('Added to staging.', 'Success');
    } catch (error) {
      console.error(error);
      openInfoModal('Failed to add staged item.', 'Error', true);
    } finally {
      setIsAddingToStaging(false);
    }
  };

  const handleStartStagedEdit = (item: StagedItem) => {
    setEditingStagedId(item.id);
    setStagedEditDraft({
      itemId: item.itemId,
      quantity: Number(item.quantity || 0),
      price: item.price >= 0 ? String(item.price) : '',
      batchNumber: String(item.batchNumber || ''),
    });
  };

  const handleUpdateStagedField = (field: keyof StagedEditDraft, val: number | string) => {
    setStagedEditDraft((prev) => (prev ? { ...prev, [field]: val } : prev));
  };

  const handleUpdateStagedBatch = (nextBatchReference: string) => {
    setStagedEditDraft((prev) => (prev ? { ...prev, batchNumber: nextBatchReference } : prev));
  };

  const handleUpdateStagedItem = (stagedItem: StagedItem, nextItemId: string) => {
    const normalizedNextItemId = String(nextItemId || '').trim();
    if (!normalizedNextItemId) return;
    const quantity = Number(stagedEditDraft?.quantity ?? stagedItem.quantity ?? 0);
    const includeKnownBatches = stagedItem.dispatchMode === 'MANUAL' && quantity < 0;
    const nextBatchOptions =
      normalizedNextItemId === stagedItem.itemId
        ? getEditableBatchesForStagedItem(stagedItem)
        : getAvailableBatches(normalizedNextItemId, stagedItem.location, includeKnownBatches);
    setStagedEditDraft((prev) =>
      prev
        ? {
            ...prev,
            itemId: normalizedNextItemId,
            batchNumber: nextBatchOptions[0]?.batch || '',
          }
        : prev,
    );
  };

  const handleSaveStagedEdit = async (stagedItem: StagedItem) => {
    if (!stagedEditDraft) return;
    const nextItemId = String(stagedEditDraft.itemId || stagedItem.itemId || '').trim();
    const nextQuantity = Number(stagedEditDraft.quantity || 0);
    const nextPrice = parseDecimalInput(stagedEditDraft.price);
    const nextBatchReference = String(stagedEditDraft.batchNumber || '').trim();
    const isManualAdjustment = stagedItem.dispatchMode === 'MANUAL';
    const isManualIncrease = isManualAdjustment && nextQuantity < 0;
    if (!nextItemId) {
      openInfoModal('Product is required.', 'Error', true);
      return;
    }
    if (nextQuantity === 0 || (!isManualAdjustment && nextQuantity < 0)) {
      openInfoModal(
        isManualAdjustment
          ? 'Quantity cannot be zero. Use a positive number to remove stock or a negative number to increase logged stock.'
          : 'Quantity must be greater than zero.',
        'Error',
        true,
      );
      return;
    }
    if (!nextBatchReference) {
      openInfoModal('Batch is required.', 'Error', true);
      return;
    }
    const editableBatches =
      nextItemId === stagedItem.itemId
        ? getEditableBatchesForStagedItem(stagedItem)
        : getAvailableBatches(nextItemId, stagedItem.location, isManualIncrease);
    const nextBatch = editableBatches.find((entry) => entry.batch === nextBatchReference);
    if (!nextBatch) {
      openInfoModal('Selected batch is no longer available for this staged line.', 'Error', true);
      return;
    }
    if (nextBatch.resolutionError) {
      openInfoModal(nextBatch.resolutionError, 'Error', true);
      return;
    }
    if (!isManualIncrease && nextQuantity > Number(nextBatch.qty || 0) + 0.000001) {
      openInfoModal(
        `Insufficient stock for ${resolveStagedItemDisplayName(stagedItem)} (${nextBatch.displayBatch}).`,
        'Error',
        true,
      );
      return;
    }
    let nextCost = stagedItem.productionCost;
    try {
      const resolved = resolveBatchRecordByReference(nextItemId, nextBatch.batch);
      if (resolved) nextCost = resolved.unit_cost || nextCost;
    } catch {
      nextCost = stagedItem.productionCost;
    }
    const nextProduct = resolveEditableProductOption(nextItemId, stagedItem);
    const nextItem: StagedItem = {
      ...stagedItem,
      itemId: nextItemId,
      itemName: nextProduct.name,
      unit: nextProduct.unit,
      quantity: nextQuantity,
      price: stagedItem.orderType === 'Paid' ? nextPrice : 0,
      batchNumber: nextBatch.batch,
      displayBatchNumber: nextBatch.displayBatch,
      productionCost: nextCost,
    };
    const updatedNotes = buildDispatchNotes(
      nextItem.recipient,
      nextItem.orderType,
      nextItem.salesRep,
      [
        `STAGE_MODE=${nextItem.dispatchMode}`,
        nextItem.dispatchMode === 'TRANSFER' && nextItem.destination
          ? `STAGE_DEST=${nextItem.destination}`
          : '',
        `STAGE_REASON=${nextItem.reason}`,
      ],
    );
    setStaging((prev) => prev.map((entry) => (entry.id === stagedItem.id ? nextItem : entry)));
    setSavingStagedIds((prev) => ({ ...prev, [stagedItem.id]: true }));
    try {
      await persistLedgerUpdate(
        stagedItem.id,
        {
          type: 'OUT',
          category: 'PRODUCT',
          itemId: nextItem.itemId,
          itemName: nextItem.itemName,
          quantity: nextItem.quantity,
          unit: nextItem.unit,
          batchNumber: nextItem.batchNumber,
          unitSalePrice: nextItem.orderType === 'Paid' ? Number(nextItem.price || 0) : 0,
          salesRep: nextItem.salesRep || undefined,
          notes: updatedNotes,
          sourceTab: resolveSourceTabForDispatch(nextItem.itemId, 'staging', nextProduct.format),
        },
        'Staged dispatch edit',
      );
      setEditingStagedId(null);
      setStagedEditDraft(null);
    } catch (error) {
      console.error(error);
      const reason = error instanceof Error ? error.message : 'Failed to persist staged update.';
      openInfoModal(reason, 'Error', true);
    } finally {
      setSavingStagedIds((prev) => {
        const next = { ...prev };
        delete next[stagedItem.id];
        return next;
      });
    }
  };

  const handleStartStagedGroupEdit = (group: StagedGroup) => {
    setEditingStagedId(null);
    setStagedEditDraft(null);
    setActiveStagedNameDropdown(null);
    setStagedNameDropdownWasTyped(false);
    setStagedGroupEditDraft({
      originalKey: group.key,
      itemIds: group.items.map((item) => item.id),
      reference: group.reference || '',
      orderType: (group.orderType as OrderType) || 'Paid',
      recipient: group.recipient || '',
      salesRep: group.salesRep || '',
    });
  };

  const handleUpdateStagedGroupDraft = (
    field: keyof Pick<StagedGroupEditDraft, 'reference' | 'orderType' | 'recipient' | 'salesRep'>,
    value: string,
  ) => {
    setStagedGroupEditDraft((prev) =>
      prev
        ? {
            ...prev,
            [field]: field === 'orderType' ? (value as OrderType) : value,
          }
        : prev,
    );
  };

  const openStagedNameDropdown = (field: 'recipient' | 'salesRep') => {
    setActiveStagedNameDropdown(field);
    setStagedNameDropdownWasTyped(false);
  };

  const closeStagedNameDropdown = (field: 'recipient' | 'salesRep') => {
    window.setTimeout(() => {
      setActiveStagedNameDropdown((prev) => (prev === field ? null : prev));
    }, 120);
  };

  const handleUpdateStagedNameDraft = (field: 'recipient' | 'salesRep', value: string) => {
    setStagedNameDropdownWasTyped(true);
    handleUpdateStagedGroupDraft(field, value);
  };

  const handleChooseStagedName = (field: 'recipient' | 'salesRep', value: string) => {
    handleUpdateStagedGroupDraft(field, value);
    setActiveStagedNameDropdown(null);
    setStagedNameDropdownWasTyped(false);
  };

  const canonicalizeStagedGroupName = (field: 'recipient' | 'salesRep') => {
    setStagedGroupEditDraft((prev) => {
      if (!prev) return prev;
      const canonical = getCanonicalDispatchName(dispatchNameHistory, field, prev[field]);
      return canonical && canonical !== prev[field] ? { ...prev, [field]: canonical } : prev;
    });
  };

  const renderStagedNameDropdown = (field: 'recipient' | 'salesRep', suggestions: string[]) => {
    if (activeStagedNameDropdown !== field || !stagedGroupEditDraft || suggestions.length === 0) {
      return null;
    }
    return (
      <div className="absolute z-50 left-0 right-0 top-full mt-2 max-h-64 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg">
        {suggestions.map((name) => (
          <button
            key={name}
            type="button"
            onMouseDown={(event) => {
              event.preventDefault();
              handleChooseStagedName(field, name);
            }}
            className="block w-full px-3 py-2 text-left text-xs font-semibold text-slate-800 hover:bg-indigo-50 focus:bg-indigo-50"
          >
            {name}
          </button>
        ))}
      </div>
    );
  };

  const handleSaveStagedGroupEdit = async () => {
    if (!stagedGroupEditDraft || isSavingStagedGroup) return;
    const nextReference = stagedGroupEditDraft.reference.trim();
    const nextRecipient = stagedGroupEditDraft.recipient.trim();
    const nextSalesRep = stagedGroupEditDraft.salesRep.trim();
    if (!nextRecipient) {
      openInfoModal('Recipient is required for PO dispatch.', 'Error', true);
      return;
    }

    const itemIdSet = new Set(stagedGroupEditDraft.itemIds);
    const touchedRows = staging
      .filter((item) => itemIdSet.has(item.id))
      .map((item) => {
        const reasonParts = String(item.reason || '').split(':');
        const reasonTail = reasonParts.length > 1 ? reasonParts.slice(1).join(':').trim() : 'Sales';
        return {
          ...item,
          reference: nextReference,
          orderType: stagedGroupEditDraft.orderType,
          recipient: nextRecipient,
          salesRep: nextSalesRep,
          reason: `${stagedGroupEditDraft.orderType}: ${reasonTail}`,
          price: stagedGroupEditDraft.orderType === 'Paid' ? item.price : 0,
        };
      });
    if (touchedRows.length === 0) {
      openInfoModal('This staged order is no longer available.', 'Error', true);
      setStagedGroupEditDraft(null);
      return;
    }

    setIsSavingStagedGroup(true);
    stagedGroupSaveInProgressRef.current = true;
    try {
      for (const row of touchedRows) {
        const updatedNotes = buildDispatchNotes(row.recipient, row.orderType, row.salesRep, [
          `STAGE_MODE=${row.dispatchMode}`,
          row.dispatchMode === 'TRANSFER' && row.destination ? `STAGE_DEST=${row.destination}` : '',
          `STAGE_REASON=${row.reason}`,
        ]);
        await persistLedgerUpdate(
          row.id,
          {
            type: 'OUT',
            category: 'PRODUCT',
            reference: row.reference,
            unitSalePrice: row.orderType === 'Paid' ? Number(row.price || 0) : 0,
            salesRep: row.salesRep || undefined,
            notes: updatedNotes,
          },
          'Staged dispatch header edit',
        );
      }

      setStaging((prev) =>
        prev.map((item) => touchedRows.find((row) => row.id === item.id) || item),
      );
      const nextGroupKey = getStagingKeyForItem(touchedRows[0]);
      setExpandedStagingGroups((prev) => {
        const next = { ...prev };
        delete next[stagedGroupEditDraft.originalKey];
        next[nextGroupKey] = true;
        return next;
      });
      setStagedGroupEditDraft(null);
    } catch (error) {
      console.error(error);
      setStaging(stagedRowsFromLedgerRef.current);
      const reason =
        error instanceof Error ? error.message : 'Failed to persist staged order update.';
      openInfoModal(reason, 'Error', true);
    } finally {
      stagedGroupSaveInProgressRef.current = false;
      setIsSavingStagedGroup(false);
    }
  };

  const handleRemoveStaged = (id: string) => {
    const before = staging;
    setStaging((prev) => prev.filter((i) => i.id !== id));
    const deleteCall = onDeleteTransaction
      ? Promise.resolve(onDeleteTransaction(id))
      : deleteLedgerTxn(id);
    void deleteCall.catch(async (error) => {
      console.error(error);
      try {
        await updateLedgerTxn(id, {
          reason: DISPATCH_STAGED_CANCELLED_REASON,
          updatedBy: currentUser,
          updatedAt: new Date().toISOString(),
        });
      } catch (softDeleteError) {
        console.error(softDeleteError);
        setStaging(before);
        openInfoModal('Failed to remove staged item.', 'Error', true);
      }
    });
  };

  const validateStagedGroupBeforeCommit = (group: StagedGroup): string | null => {
    if (!group || group.items.length === 0) return 'No staged lines selected.';

    const demandByBatch = new Map<string, number>();
    for (const item of group.items) {
      const isManualAdjustment = item.dispatchMode === 'MANUAL';
      const isManualIncrease = isManualAdjustment && item.quantity < 0;
      if (item.quantity === 0 || (!isManualAdjustment && item.quantity < 0)) {
        return isManualAdjustment
          ? `Quantity cannot be zero for ${item.itemName}. Use a positive number to remove stock or a negative number to increase logged stock.`
          : `Quantity must be greater than zero for ${item.itemName}.`;
      }
      if (!item.batchNumber) return `Batch is required for ${item.itemName}.`;
      if (item.dispatchMode === 'PO_SHIP') {
        if (!String(group.recipient || '').trim()) return 'Recipient is required for PO dispatch.';
        if (group.orderType === 'Paid' && item.price < 0)
          return `Paid line price cannot be negative for ${item.itemName}.`;
      }
      const batchOptions = getAvailableBatches(item.itemId, item.location);
      const selected = batchOptions.find((entry) => entry.batch === item.batchNumber);
      if (!selected) return `Selected batch is no longer available for ${item.itemName}.`;
      if (selected.resolutionError) return selected.resolutionError;
      if (isManualIncrease) continue;

      const stockKey = `${item.itemId}||${item.location}||${item.batchNumber}`;
      const nextQty = (demandByBatch.get(stockKey) || 0) + Number(item.quantity || 0);
      if (nextQty > selected.qty + 0.000001) {
        return `Insufficient stock for ${item.itemName} (${selected.displayBatch}).`;
      }
      demandByBatch.set(stockKey, nextQty);
    }
    return null;
  };

  const handleCommit = async (
    groupKey: string,
    options?: { skipPostSync?: boolean },
  ): Promise<boolean> => {
    if (staging.length === 0 || isReadOnly) return false;
    const targetGroup = stagedGroups.find((group) => group.key === groupKey);
    if (!targetGroup || targetGroup.items.length === 0) return false;
    setReleasingGroupKeys((prev) => ({ ...prev, [groupKey]: true }));
    try {
      for (const item of targetGroup.items) {
        const orderType =
          item.dispatchMode === 'PO_SHIP' ? (targetGroup.orderType as OrderType) : item.orderType;
        const recipient = item.dispatchMode === 'PO_SHIP' ? targetGroup.recipient : item.recipient;
        const salesRep = item.dispatchMode === 'PO_SHIP' ? targetGroup.salesRep : item.salesRep;
        const isTransfer = item.dispatchMode === 'TRANSFER';
        const isManual = item.dispatchMode === 'MANUAL';
        const isTransferOrManual = isTransfer || isManual;
        const releasedReason = isTransfer
          ? DISPATCHED_TRANSFER_REASON
          : isManual
            ? DISPATCHED_MANUAL_REASON
            : resolvePoDispatchReason(orderType);
        const releasedNotes = isTransfer
          ? `STAGE_DEST=${item.destination || ''}`
          : isManual
            ? ''
            : buildDispatchNotes(recipient, orderType, salesRep);
        const releasedReference = isTransferOrManual ? releasedReason : targetGroup.reference;
        await updateLedgerTxn(item.id, {
          reason: releasedReason,
          notes: releasedNotes,
          reference: releasedReference,
          unitSalePrice: orderType === 'Paid' ? item.price : 0,
          salesRep: salesRep || undefined,
          sourceTab: DISPATCH_SOURCE_TAB,
          updatedBy: currentUser,
          updatedAt: new Date().toISOString(),
        });

        if (item.dispatchMode === 'TRANSFER' && item.destination) {
          await onTransaction({
            type: 'IN',
            category: 'PRODUCT',
            itemId: item.itemId,
            quantity: item.quantity,
            unit: item.unit,
            location: item.destination,
            batchNumber: item.batchNumber,
            reason: releasedReason,
            reference: releasedReference,
            notes: releasedNotes,
            salesRep: salesRep || undefined,
            user: currentUser,
            updatedBy: currentUser,
            sourceTab: 'Product Dispatch',
          });
        }
      }
      setStaging((prev) => prev.filter((item) => getStagingKeyForItem(item) !== targetGroup.key));
      if (!options?.skipPostSync && onForceSync) {
        try {
          await onForceSync();
        } catch (syncError) {
          console.warn(
            '[Dispatch Refresh Warning] Dispatch saved, but the local view did not refresh.',
            syncError,
          );
        }
      }
      openInfoModal('Dispatch confirmed.', 'Success');
      return true;
    } catch (e) {
      console.error(e);
      openInfoModal('Failed to process dispatch.', 'Error', true);
      return false;
    } finally {
      setReleasingGroupKeys((prev) => {
        const next = { ...prev };
        delete next[groupKey];
        return next;
      });
    }
  };

  const handleDispatchAll = async () => {
    if (isReadOnly || stagedGroups.length === 0 || isDispatchingAll) return;
    const totalItems = staging.length;
    setModalConfig({
      isOpen: true,
      title: 'Confirm Dispatch',
      message: `Are you sure you want to dispatch all ${totalItems} items?`,
      isDangerous: false,
      confirmLabel: 'Confirm',
      onConfirm: async () => {
        setModalConfig(null);
        setIsDispatchingAll(true);
        let didDispatchAny = false;
        try {
          const groupKeys = stagedGroups.map((group) => group.key);
          for (const groupKey of groupKeys) {
            const didDispatch = await handleCommit(groupKey, { skipPostSync: true });
            if (didDispatch) didDispatchAny = true;
            if (!didDispatch) break;
          }
          if (didDispatchAny && onForceSync) {
            try {
              await onForceSync();
            } catch (syncError) {
              console.warn(
                '[Dispatch Refresh Warning] Dispatch-all saved, but the local view did not refresh.',
                syncError,
              );
            }
          }
        } finally {
          setIsDispatchingAll(false);
        }
      },
    });
  };

  // Activity History Logic
  const productDispatchTransactions = useMemo(
    () =>
      transactions.filter(
        (t) =>
          t.category === 'PRODUCT' &&
          String(t.reason || '')
            .toLowerCase()
            .includes('dispatch') &&
          t.reason !== DISPATCH_STAGED_REASON &&
          t.reason !== DISPATCH_STAGED_CANCELLED_REASON,
      ),
    [transactions],
  );

  const dispatchReversalState = useMemo(() => {
    const reversedTargetIds = new Set<string>();
    const voidedTargetIds = new Set<string>();
    const voidReasonsByTargetId = new Map<string, string[]>();

    productDispatchTransactions.forEach((tx) => {
      const targetId = parseAdjustmentTargetTxId(tx.notes);
      const adjustmentKind = parseAdjustmentKind(tx.notes);
      const isReversalEntry =
        tx.reason === DISPATCH_VOID_REASON ||
        (tx.reason === DISPATCH_ADJUSTMENT_REASON && adjustmentKind !== 'APPLY');
      if (tx.type === 'IN' && targetId && isReversalEntry) {
        reversedTargetIds.add(targetId);
        if (tx.reason === DISPATCH_VOID_REASON) {
          voidedTargetIds.add(targetId);
          const reason = String(tx.editReason || '').trim() || parseVoidReason(tx.notes);
          if (reason) {
            const existing = voidReasonsByTargetId.get(targetId) || [];
            existing.push(reason);
            voidReasonsByTargetId.set(targetId, existing);
          }
        }
      }
    });

    return { reversedTargetIds, voidedTargetIds, voidReasonsByTargetId };
  }, [productDispatchTransactions]);

  const activityHistory = useMemo<DispatchHistoryGroup[]>(() => {
    const productTx = productDispatchTransactions;
    const { reversedTargetIds, voidedTargetIds, voidReasonsByTargetId } = dispatchReversalState;

    const groupedOutTx: Record<string, { reference: string; rows: InventoryTransaction[] }> = {};
    productTx.forEach((tx) => {
      if (tx.type !== 'OUT') return;
      if (tx.reason === DISPATCH_VOID_REASON) return;
      const ref = tx.reference || 'N/A';
      const noteKey = normalizeHistoryGroupNotes(tx.notes) || 'NO_NOTES';
      const reasonLower = String(tx.reason || '').toLowerCase();
      const isTransferOrManual = reasonLower.includes('transfer') || reasonLower.includes('manual');
      // Paid/Sample/Internal group by PO + notes; transfer/manual also remain split by event time.
      const eventTime = String(resolveLedgerEventTime(tx) || '');
      const createdGroupKey = eventTime ? eventTime.slice(0, 19) : 'NO_TIME';
      const compositeKey = isTransferOrManual
        ? `${ref}__${noteKey}__${createdGroupKey}`
        : `${ref}__${noteKey}`;
      if (!groupedOutTx[compositeKey]) {
        groupedOutTx[compositeKey] = { reference: ref, rows: [] };
      }
      groupedOutTx[compositeKey].rows.push(tx);
    });

    const history: DispatchHistoryGroup[] = Object.entries(groupedOutTx).map(
      ([groupKey, group]) => {
        const reference = group.reference;
        const orderedOuts = [...group.rows].sort(
          (a, b) =>
            new Date(resolveLedgerEventTime(a)).getTime() -
            new Date(resolveLedgerEventTime(b)).getTime(),
        );
        const effectiveOutMap = new Map<string, InventoryTransaction>();
        orderedOuts.forEach((tx) => {
          const txId = String(tx.id || '');
          const targetId = parseAdjustmentTargetTxId(tx.notes);
          const adjustmentKind = parseAdjustmentKind(tx.notes);

          if (tx.reason === DISPATCH_ADJUSTMENT_REASON) {
            if (adjustmentKind === 'REVERSE') return;
            if (adjustmentKind === 'APPLY' && targetId) {
              effectiveOutMap.set(targetId, tx);
              return;
            }
          }

          if (!reversedTargetIds.has(txId)) {
            effectiveOutMap.set(txId, tx);
          }
        });
        const effectiveOuts = Array.from(effectiveOutMap.values()).sort(
          (a, b) =>
            new Date(resolveLedgerEventTime(a)).getTime() -
            new Date(resolveLedgerEventTime(b)).getTime(),
        );
        const hasVoidEntry = orderedOuts.some((tx) => voidedTargetIds.has(String(tx.id || '')));
        const cancelReason = hasVoidEntry
          ? Array.from(
              new Set(
                orderedOuts.flatMap((tx) => voidReasonsByTargetId.get(String(tx.id || '')) || []),
              ),
            ).join(' | ')
          : '';
        const hasReversedItems = orderedOuts.some((tx) =>
          reversedTargetIds.has(String(tx.id || '')),
        );
        const displayOuts = hasVoidEntry ? orderedOuts : effectiveOuts;
        const metadataSource = [...displayOuts].reverse()[0] || orderedOuts[orderedOuts.length - 1];
        const recipient = parseRecipient(metadataSource?.notes, metadataSource?.reason || 'N/A');
        const salesRep =
          String(metadataSource?.salesRep || '').trim() || parseSalesRep(metadataSource?.notes, '');
        const reasonLower = String(metadataSource?.reason || '').toLowerCase();
        const orderType = reasonLower.includes('transfer')
          ? 'Transfer'
          : reasonLower.includes('manual')
            ? 'Manual'
            : parseOrderType(metadataSource?.notes, 'Manual');
        const isTransfer =
          displayOuts.length > 0
            ? displayOuts.every((tx) =>
                String(tx.reason || '')
                  .toLowerCase()
                  .includes('transfer'),
              )
            : orderType === 'Transfer';

        let totalCost = 0;
        let totalPrice = 0;

        displayOuts.forEach((effectiveTx) => {
          let batchInfo: ProductBatch | null = null;
          try {
            batchInfo = resolveBatchRecordByReference(
              effectiveTx.itemId,
              String(effectiveTx.batchNumber || ''),
            );
          } catch {
            batchInfo = null;
          }
          const unitCost = batchInfo?.unit_cost || 0;
          const lineCost = unitCost * effectiveTx.quantity;
          const linePrice = resolveLedgerUnitSalePrice(effectiveTx) * effectiveTx.quantity;
          totalCost += lineCost;
          if (!isTransfer) totalPrice += linePrice;
        });

        const firstOut = orderedOuts[0];
        return {
          key: groupKey,
          reference,
          createdAt: firstOut ? resolveLedgerEventTime(firstOut) : '',
          recipient,
          salesRep,
          orderType,
          totalCost: hasVoidEntry ? 0 : totalCost,
          totalPrice: hasVoidEntry ? 0 : totalPrice,
          revenue: hasVoidEntry ? 0 : isTransfer ? 0 : totalPrice - totalCost,
          itemsCount: displayOuts.length,
          isTransfer,
          isVoided: hasVoidEntry,
          hasReversedItems,
          cancelReason: cancelReason || undefined,
          items: displayOuts,
          allTransactions: orderedOuts,
        };
      },
    );

    return history;
  }, [dispatchReversalState, productBatches, productDispatchTransactions]);

  const filteredActivityHistory = useMemo<DispatchHistoryGroup[]>(() => {
    return activityHistory.filter((group) => {
      const dateOnly = getDateOnlyValue(group.createdAt);
      if (historyAppliedFromDate && (!dateOnly || dateOnly < historyAppliedFromDate)) return false;
      if (historyAppliedToDate && (!dateOnly || dateOnly > historyAppliedToDate)) return false;
      if (
        !matchesSearch(
          [
            group.reference,
            group.recipient,
            group.salesRep,
            group.orderType,
            group.cancelReason,
            ...group.items.flatMap((tx) => [
              tx.itemId,
              tx.itemName,
              tx.batchNumber,
              tx.reason,
              tx.notes,
              tx.user,
              tx.updatedBy,
            ]),
          ],
          historyAppliedSearchQuery,
        )
      ) {
        return false;
      }
      return true;
    });
  }, [activityHistory, historyAppliedFromDate, historyAppliedToDate, historyAppliedSearchQuery]);

  const sortedActivityHistory = useMemo<DispatchHistoryGroup[]>(() => {
    const compareDate = (left: string, right: string): number => {
      const tl = new Date(left || '').getTime();
      const tr = new Date(right || '').getTime();
      const leftValid = Number.isFinite(tl);
      const rightValid = Number.isFinite(tr);
      if (!leftValid && !rightValid) return 0;
      if (!leftValid) return 1;
      if (!rightValid) return -1;
      return tl - tr;
    };
    const compareText = (left: string, right: string): number =>
      String(left || '').localeCompare(String(right || ''), undefined, { sensitivity: 'base' });
    const compareNumber = (left: number, right: number): number => left - right;

    const indexed = filteredActivityHistory.map((group, index) => ({ group, index }));
    indexed.sort((a, b) => {
      let base = 0;
      switch (historySortState.key) {
        case 'createdAt':
          base = compareDate(a.group.createdAt, b.group.createdAt);
          break;
        case 'recipientType':
          base = compareText(
            `${a.group.recipient || ''} ${a.group.orderType || ''}`,
            `${b.group.recipient || ''} ${b.group.orderType || ''}`,
          );
          break;
        case 'salesRep':
          base = compareText(
            getDisplaySalesRep(a.group.salesRep),
            getDisplaySalesRep(b.group.salesRep),
          );
          break;
        case 'itemsCount':
          base = compareNumber(a.group.itemsCount, b.group.itemsCount);
          break;
        case 'totalCost':
          base = compareNumber(a.group.totalCost, b.group.totalCost);
          break;
        case 'totalPrice':
          base = compareNumber(a.group.totalPrice, b.group.totalPrice);
          break;
        case 'revenue':
          base = compareNumber(a.group.revenue, b.group.revenue);
          break;
        default:
          base = compareDate(a.group.createdAt, b.group.createdAt);
          break;
      }
      if (base === 0) return a.index - b.index;
      return historySortState.dir === 'asc' ? base : -base;
    });
    return indexed.map((entry) => entry.group);
  }, [filteredActivityHistory, historySortState]);

  const applyHistoryFilters = () => {
    setHistoryAppliedFromDate(historyDraftFromDate);
    setHistoryAppliedToDate(historyDraftToDate);
    setHistoryAppliedSearchQuery(historyDraftSearchQuery.trim());
  };

  const resetHistoryFilters = () => {
    setHistoryDraftFromDate(defaultHistoryDateRange.from);
    setHistoryDraftToDate(defaultHistoryDateRange.to);
    setHistoryAppliedFromDate(defaultHistoryDateRange.from);
    setHistoryAppliedToDate(defaultHistoryDateRange.to);
    setHistoryDraftSearchQuery('');
    setHistoryAppliedSearchQuery('');
  };

  const handleStartHistoryEdit = (group: DispatchHistoryGroup) => {
    if (group.isVoided) {
      openInfoModal('Deleted dispatch entries cannot be edited.', 'Edit blocked', true);
      return;
    }
    if (group.hasReversedItems) {
      openInfoModal(
        'This dispatch has already been reversed by an adjustment or delete, so it cannot be edited again.',
        'Edit blocked',
        true,
      );
      return;
    }
    setEditingHistoryRef(group.key);
    setExpandedHistoryRef(group.key);
    setHistoryEditDraft({
      key: group.key,
      reference: group.reference,
      recipient: group.recipient,
      salesRep: group.salesRep,
      orderType: group.orderType,
      lines: group.items.map((tx) => ({
        txId: tx.id,
        quantity: tx.quantity,
        price: String(resolveLedgerUnitSalePrice(tx)),
        note: parseLineNote(tx.notes),
      })),
    });
  };

  const handleUpdateHistoryDraftLine = (txId: string, updates: Partial<HistoryDraftLine>) => {
    setHistoryEditDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        lines: prev.lines.map((line) => (line.txId === txId ? { ...line, ...updates } : line)),
      };
    });
  };

  const handleCancelHistoryEdit = () => {
    setEditingHistoryRef(null);
    setHistoryEditDraft(null);
  };

  const handleSaveHistoryEdit = async (group: DispatchHistoryGroup) => {
    if (!historyEditDraft || historyEditDraft.key !== group.key || isReadOnly) return;
    if (group.isVoided) {
      openInfoModal('Deleted dispatch entries cannot be edited.', 'Edit blocked', true);
      return;
    }
    if (group.hasReversedItems) {
      openInfoModal(
        'This dispatch has already been reversed by an adjustment or delete, so it cannot be edited again.',
        'Edit blocked',
        true,
      );
      return;
    }
    const editReason = await appDialog.prompt({
      title: 'Adjustment Reason',
      message: 'Enter adjustment reason (required):',
      defaultValue: 'Dispatch correction',
      inputLabel: 'Reason',
      confirmLabel: 'Continue',
      required: true,
    });
    if (!editReason || !editReason.trim()) return;
    setModalConfig({
      isOpen: true,
      title: 'Confirm Adjustment',
      message: `Apply dispatch adjustment for ${group.reference}?`,
      isDangerous: false,
      confirmLabel: 'Confirm',
      onConfirm: async () => {
        setModalConfig(null);
        setIsHistoryActionLoading(true);
        try {
          let changeCount = 0;
          const nextRecipient = historyEditDraft.recipient.trim() || group.recipient;
          const nextOrderType = historyEditDraft.orderType.trim() || group.orderType;
          const nextSalesRep = historyEditDraft.salesRep.trim() || group.salesRep || '';

          for (const tx of group.items) {
            const draftLine = historyEditDraft.lines.find((line) => line.txId === tx.id);
            if (!draftLine) continue;

            const previousQty = Number(tx.quantity || 0);
            const previousPrice = resolveLedgerUnitSalePrice(tx);
            const previousNote = parseLineNote(tx.notes);
            const nextQty = Number(draftLine.quantity || 0);
            const nextPrice = parseDecimalInput(draftLine.price);
            const nextNote = String(draftLine.note || '').trim();
            const isManualAdjustment =
              String(group.orderType || '').toLowerCase() === 'manual' ||
              String(tx.reason || '')
                .toLowerCase()
                .includes('manual');
            if (nextQty === 0 || (!isManualAdjustment && nextQty < 0)) {
              throw new Error(
                isManualAdjustment
                  ? 'Adjusted quantity cannot be zero. Use a positive number to remove stock or a negative number to increase logged stock.'
                  : 'Adjusted quantity must be greater than zero.',
              );
            }
            if (nextPrice < 0) throw new Error('Adjusted price cannot be negative.');

            const metadataChanged =
              nextRecipient !== group.recipient || nextOrderType !== group.orderType;
            const lineChanged =
              Math.abs(nextQty - previousQty) > 0.000001 ||
              Math.abs(nextPrice - previousPrice) > 0.000001 ||
              nextNote !== previousNote ||
              metadataChanged;
            if (!lineChanged) continue;

            changeCount += 1;
            const destination = parseTransferDestination(tx.reason, tx.notes);
            const reversalNotes = buildDispatchNotes(nextRecipient, nextOrderType, nextSalesRep, [
              `ADJ_KIND=REVERSE`,
              `${TARGET_TX_META_KEY}=${tx.id}`,
              `EDIT_REASON=${editReason}`,
            ]);
            const adjustedNotes = buildDispatchNotes(nextRecipient, nextOrderType, nextSalesRep, [
              nextNote ? `LINE_NOTE=${nextNote}` : '',
              `ADJ_KIND=APPLY`,
              `${TARGET_TX_META_KEY}=${tx.id}`,
              `EDIT_REASON=${editReason}`,
            ]);

            await onTransaction({
              type: 'IN',
              category: 'PRODUCT',
              itemId: tx.itemId,
              quantity: previousQty,
              unit: tx.unit,
              location: tx.location,
              batchNumber: tx.batchNumber,
              reason: DISPATCH_ADJUSTMENT_REASON,
              reference: group.reference,
              salesRep: nextSalesRep || undefined,
              notes: reversalNotes,
              user: currentUser,
              updatedBy: currentUser,
              editReason,
              sourceTab: 'Product Dispatch',
            });

            if (destination) {
              await onTransaction({
                type: 'OUT',
                category: 'PRODUCT',
                itemId: tx.itemId,
                quantity: previousQty,
                unit: tx.unit,
                location: destination,
                batchNumber: tx.batchNumber,
                reason: DISPATCH_ADJUSTMENT_REASON,
                reference: group.reference,
                salesRep: nextSalesRep || undefined,
                notes: reversalNotes,
                user: currentUser,
                updatedBy: currentUser,
                editReason,
                sourceTab: 'Product Dispatch',
              });
              await onTransaction({
                type: 'OUT',
                category: 'PRODUCT',
                itemId: tx.itemId,
                quantity: nextQty,
                unit: tx.unit,
                location: tx.location,
                batchNumber: tx.batchNumber,
                reason: DISPATCH_ADJUSTMENT_REASON,
                reference: group.reference,
                salesRep: nextSalesRep || undefined,
                notes: adjustedNotes,
                user: currentUser,
                updatedBy: currentUser,
                editReason,
                sourceTab: 'Product Dispatch',
              });
              await onTransaction({
                type: 'IN',
                category: 'PRODUCT',
                itemId: tx.itemId,
                quantity: nextQty,
                unit: tx.unit,
                location: destination,
                batchNumber: tx.batchNumber,
                reason: DISPATCH_ADJUSTMENT_REASON,
                reference: group.reference,
                salesRep: nextSalesRep || undefined,
                notes: adjustedNotes,
                user: currentUser,
                updatedBy: currentUser,
                editReason,
                sourceTab: 'Product Dispatch',
              });
            } else {
              await onTransaction({
                type: 'OUT',
                category: 'PRODUCT',
                itemId: tx.itemId,
                quantity: nextQty,
                unit: tx.unit,
                location: tx.location,
                batchNumber: tx.batchNumber,
                reason: DISPATCH_ADJUSTMENT_REASON,
                reference: group.reference,
                unitSalePrice:
                  nextOrderType === 'Paid' ? (nextPrice > 0 ? nextPrice : undefined) : 0,
                salesRep: nextSalesRep || undefined,
                notes: adjustedNotes,
                user: currentUser,
                updatedBy: currentUser,
                editReason,
                sourceTab: 'Product Dispatch',
              });
            }
          }

          if (changeCount === 0) {
            openInfoModal('No dispatch changes detected.');
          } else {
            openInfoModal('Dispatch adjustments saved.', 'Success');
          }
          handleCancelHistoryEdit();
        } catch (error) {
          console.error(error);
          openInfoModal(
            error instanceof Error ? error.message : 'Failed to apply dispatch adjustments.',
            'Error',
            true,
          );
        } finally {
          setIsHistoryActionLoading(false);
        }
      },
    });
  };

  const handleVoidHistoryGroup = async (group: DispatchHistoryGroup) => {
    if (isReadOnly) return;
    if (group.isVoided) {
      openInfoModal('This dispatch group is already deleted.', 'Delete blocked', true);
      return;
    }
    if (group.hasReversedItems) {
      openInfoModal(
        'This dispatch has already been reversed by an adjustment or delete, so it cannot be deleted again.',
        'Delete blocked',
        true,
      );
      return;
    }
    if (group.items.length === 0) return;
    const voidReason = await appDialog.prompt({
      title: 'Delete Reason',
      message: 'Enter delete reason (required):',
      defaultValue: 'Dispatch delete',
      inputLabel: 'Reason',
      confirmLabel: 'Continue',
      required: true,
    });
    if (!voidReason || !voidReason.trim()) return;
    setModalConfig({
      isOpen: true,
      title: 'Confirm Delete',
      message: `Delete dispatch group ${group.reference}? This will post reversal entries.`,
      isDangerous: true,
      confirmLabel: 'Confirm',
      onConfirm: async () => {
        setModalConfig(null);
        setIsHistoryActionLoading(true);
        try {
          for (const tx of group.items) {
            const destination = parseTransferDestination(tx.reason, tx.notes);
            const voidNotes = buildDispatchNotes(group.recipient, group.orderType, group.salesRep, [
              `VOID_REASON=${voidReason}`,
              `VOID_OF_REF:${group.reference}`,
              `${TARGET_TX_META_KEY}=${tx.id}`,
            ]);
            await onTransaction({
              type: 'IN',
              category: 'PRODUCT',
              itemId: tx.itemId,
              quantity: tx.quantity,
              unit: tx.unit,
              location: tx.location,
              batchNumber: tx.batchNumber,
              reason: DISPATCH_VOID_REASON,
              reference: group.reference,
              salesRep: group.salesRep || undefined,
              notes: voidNotes,
              user: currentUser,
              updatedBy: currentUser,
              editReason: voidReason,
              sourceTab: 'Product Dispatch',
            });
            if (destination) {
              await onTransaction({
                type: 'OUT',
                category: 'PRODUCT',
                itemId: tx.itemId,
                quantity: tx.quantity,
                unit: tx.unit,
                location: destination,
                batchNumber: tx.batchNumber,
                reason: DISPATCH_VOID_REASON,
                reference: group.reference,
                salesRep: group.salesRep || undefined,
                notes: voidNotes,
                user: currentUser,
                updatedBy: currentUser,
                editReason: voidReason,
                sourceTab: 'Product Dispatch',
              });
            }
          }
          openInfoModal('Dispatch group deleted via reversal entries.', 'Success');
        } catch (error) {
          console.error(error);
          openInfoModal('Failed to delete dispatch group.', 'Error', true);
        } finally {
          setIsHistoryActionLoading(false);
        }
      },
    });
  };

  const handleReturnHistoryGroupToStaging = async (group: DispatchHistoryGroup) => {
    if (isReadOnly) return;
    if (group.isVoided) {
      openInfoModal(
        'Deleted dispatch entries cannot be returned to staging.',
        'Return blocked',
        true,
      );
      return;
    }
    if (group.hasReversedItems) {
      openInfoModal(
        'This dispatch has already been adjusted or reversed, so it cannot be returned to staging.',
        'Return blocked',
        true,
      );
      return;
    }
    if (group.isTransfer) {
      openInfoModal(
        'Transfer dispatches create a paired inbound row, so return-to-staging is only available for PO dispatch groups.',
        'Return blocked',
        true,
      );
      return;
    }
    if (group.items.length === 0) return;

    const returnReason = await appDialog.prompt({
      title: 'Return to Staging',
      message: 'Enter the reason for returning this dispatch group to staging:',
      defaultValue: 'Correct product or batch',
      inputLabel: 'Reason',
      confirmLabel: 'Continue',
      required: true,
    });
    if (!returnReason || !returnReason.trim()) return;

    const trimmedReason = returnReason.trim();
    setModalConfig({
      isOpen: true,
      title: 'Confirm Return to Staging',
      message: `Return dispatch group ${group.reference} to staging for editing?`,
      isDangerous: false,
      confirmLabel: 'Return',
      onConfirm: async () => {
        setModalConfig(null);
        setIsHistoryActionLoading(true);
        setReturningHistoryKey(group.key);
        try {
          const normalizedOrderType = ORDER_TYPE_OPTIONS.includes(group.orderType as OrderType)
            ? (group.orderType as OrderType)
            : 'Others';
          const stagedReasonText = `${normalizedOrderType}: ${trimmedReason}`;
          for (const tx of group.items) {
            const productFormat = resolveDualPathFormat(tx.itemId);
            const stagedNotes = buildDispatchNotes(
              group.recipient,
              normalizedOrderType,
              group.salesRep,
              [
                'STAGE_MODE=PO_SHIP',
                `STAGE_REASON=${stagedReasonText}`,
                `RETURNED_FROM_DISPATCH=${tx.id}`,
                `RETURN_REASON=${trimmedReason}`,
              ],
            );
            await persistLedgerUpdateWithoutLocalOptimism(
              tx.id,
              {
                type: 'OUT',
                category: 'PRODUCT',
                reason: DISPATCH_STAGED_REASON,
                reference: group.reference,
                notes: stagedNotes,
                unitSalePrice: normalizedOrderType === 'Paid' ? resolveLedgerUnitSalePrice(tx) : 0,
                salesRep: group.salesRep || undefined,
                sourceTab: resolveSourceTabForDispatch(tx.itemId, 'staging', productFormat),
              },
              `Returned dispatch to staging: ${trimmedReason}`,
            );
          }
          setExpandedHistoryRef(null);
          handleCancelHistoryEdit();
          if (onForceSync) {
            try {
              await onForceSync();
            } catch (syncError) {
              console.warn(
                '[Dispatch Refresh Warning] Dispatch returned to staging, but the local view did not refresh.',
                syncError,
              );
            }
          }
          openInfoModal('Dispatch group returned to staging.', 'Success');
        } catch (error) {
          console.error(error);
          openInfoModal(
            error instanceof Error ? error.message : 'Failed to return dispatch group to staging.',
            'Error',
            true,
          );
        } finally {
          setReturningHistoryKey(null);
          setIsHistoryActionLoading(false);
        }
      },
    });
  };

  const downloadHistoryCSV = () => {
    if (sortedActivityHistory.length === 0) return;
    const headers = [
      'Row Type',
      'PO Reference',
      'Date',
      'Recipient',
      'Sales Rep',
      'Order Type',
      'Items',
      'Total Production Cost (£)',
      'Total Sales Price (£)',
      'Revenue (£)',
      'Status',
      'SKU',
      'Product Name',
      'Batch',
      'Location',
      'Quantity',
      'Unit',
      'Line Production Cost (£)',
      'Line Sales Price (£)',
      'Line Revenue (£)',
      'Notes',
    ];
    const rows: Array<Array<string | number>> = [];

    sortedActivityHistory.forEach((group) => {
      rows.push([
        'Summary',
        group.reference,
        getDateOnlyValue(group.createdAt),
        group.recipient,
        getDisplaySalesRep(group.salesRep),
        group.orderType,
        group.itemsCount,
        group.totalCost.toFixed(2),
        group.totalPrice.toFixed(2),
        group.revenue.toFixed(2),
        group.isVoided ? 'Deleted' : 'Active',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        group.cancelReason || '',
      ]);

      group.items.forEach((tx) => {
        let batchInfo: ProductBatch | null = null;
        try {
          batchInfo = resolveBatchRecordByReference(tx.itemId, String(tx.batchNumber || ''));
        } catch {
          batchInfo = null;
        }
        const unitCost = batchInfo?.unit_cost || 0;
        const lineCost = group.isVoided ? 0 : unitCost * tx.quantity;
        const unitSalePrice =
          group.isTransfer || group.isVoided ? 0 : resolveLedgerUnitSalePrice(tx);
        const lineSalesPrice = unitSalePrice * tx.quantity;
        const lineRevenue = group.isTransfer || group.isVoided ? 0 : lineSalesPrice - lineCost;
        let batchLabel = tx.batchNumber || 'N/A';
        try {
          batchLabel =
            resolveBatchForDispatch(tx.itemId, String(tx.batchNumber || '')).displayBatch ||
            batchLabel;
        } catch {
          batchLabel = tx.batchNumber || 'N/A';
        }

        rows.push([
          'Detail',
          group.reference,
          getDateOnlyValue(resolveLedgerEventTime(tx)),
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          group.isVoided ? 'Deleted' : 'Active',
          tx.itemId,
          resolveDispatchItemDisplayName({ itemId: tx.itemId, itemName: tx.itemName }),
          batchLabel,
          tx.location,
          tx.quantity,
          tx.unit,
          lineCost.toFixed(2),
          lineSalesPrice.toFixed(2),
          lineRevenue.toFixed(2),
          tx.notes || '',
        ]);
      });
    });

    const csv = [headers.join(','), ...rows.map((line) => line.map(escapeCsv).join(','))].join(
      '\n',
    );
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const datedRows = sortedActivityHistory
      .map((h) => getDateOnlyValue(h.createdAt))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    const rangeFrom = historyAppliedFromDate || datedRows[0] || defaultHistoryDateRange.from;
    const rangeTo = historyAppliedToDate || datedRows[datedRows.length - 1] || rangeFrom;
    const fromSegment = getDateOnlyValue(rangeFrom).replaceAll('-', '');
    const toSegment = getDateOnlyValue(rangeTo).replaceAll('-', '');
    link.href = url;
    link.setAttribute('download', `product_out_from_${fromSegment}_to_${toSegment}.csv`);
    link.click();
    URL.revokeObjectURL(url);
  };

  const renderAddToStagingButton = () => (
    <button
      onClick={handleAddToStaging}
      disabled={!canAddToStaging || isReadOnly || isAddingToStaging}
      className="w-full py-3 bg-indigo-600 text-white rounded-lg font-bold shadow-sm hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
    >
      {isAddingToStaging ? (
        <>
          <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Adding...
        </>
      ) : (
        <>
          <Plus className="w-4 h-4 mr-2" /> Add to Staging
        </>
      )}
    </button>
  );

  const panelHeightClass = mode === 'PO_SHIP' ? 'md:max-h-[920px]' : 'md:max-h-[760px]';
  const mainLayoutClass = isHandheldDevice
    ? 'grid grid-cols-1 gap-6 lg:gap-8 items-stretch'
    : 'grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8 items-stretch';
  const stagingPanelClass = isHandheldDevice
    ? `${panelHeightClass} bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden flex flex-col min-h-0`
    : `${panelHeightClass} md:col-span-2 bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden flex flex-col min-h-0`;

  return (
    <div className="space-y-8 animate-in fade-in">
      {/* Main Work Area */}
      <div className={mainLayoutClass}>
        {/* Left: Control Panel */}
        <div
          className={`${panelHeightClass} bg-white p-4 sm:p-6 rounded-xl border border-slate-200 shadow-sm flex flex-col min-h-0 overflow-hidden`}
        >
          <div className="mb-6 border-b border-slate-100 pb-4">
            <h3 className="text-lg font-bold text-slate-800 flex items-center">
              <Truck className="w-5 h-5 mr-2 text-indigo-600" /> Dispatch Center
            </h3>
            <div className="grid grid-cols-3 gap-2 mt-4">
              <button
                onClick={() => setMode('PO_SHIP')}
                className={`flex-1 py-2 text-xs font-bold rounded border ${mode === 'PO_SHIP' ? 'bg-indigo-50 border-indigo-200 text-indigo-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}
              >
                PO Shipment
              </button>
              <button
                onClick={() => setMode('TRANSFER')}
                className={`flex-1 py-2 text-xs font-bold rounded border ${mode === 'TRANSFER' ? 'bg-blue-50 border-blue-200 text-blue-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}
              >
                Transfer
              </button>
              <button
                onClick={() => setMode('MANUAL')}
                className={`flex-1 py-2 text-xs font-bold rounded border ${mode === 'MANUAL' ? 'bg-orange-50 border-orange-200 text-orange-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}
              >
                Manual/Adj
              </button>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-visible md:overflow-y-auto pr-0 md:pr-1 space-y-4">
            <div>
              <label className="block text-xs font-bold text-slate-500 mb-1">Product</label>
              <select
                className="w-full border-slate-300 rounded text-sm py-2"
                value={formSku}
                onChange={(e) => {
                  setFormSku(e.target.value);
                  setFormBatch('');
                }}
                disabled={isReadOnly}
              >
                <option value="">-- Select Product --</option>
                {groupedProductOptions.map((group) => (
                  <optgroup key={group.name} label={group.name}>
                    {group.items.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>

            {mode === 'TRANSFER' ? (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-bold text-slate-500 mb-1">Source</label>
                  <button
                    type="button"
                    disabled={isReadOnly}
                    onClick={() => {
                      const nextLocation = getOppositeLocation(formLocation);
                      setFormLocation(nextLocation);
                      setFormDestination(formLocation);
                      setFormBatch('');
                    }}
                    className="w-full rounded border border-slate-300 py-2 px-3 text-sm font-bold text-slate-700 bg-white hover:bg-slate-50 transition text-left disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span>{formLocation}</span>
                      <span className="text-[11px] uppercase tracking-wider text-blue-600 font-extrabold">
                        Click to swap
                      </span>
                    </div>
                  </button>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-500 mb-1">Destination</label>
                  <div className="w-full rounded border border-blue-200 bg-blue-50 py-2 px-3 text-sm font-bold text-blue-700">
                    {transferDestination}
                  </div>
                </div>
              </div>
            ) : (
              <div>
                <label className="block text-xs font-bold text-slate-500 mb-1">Source</label>
                <select
                  className="w-full border-slate-300 rounded text-sm py-2"
                  value={formLocation}
                  onChange={(e) => {
                    setFormLocation(e.target.value as LocationName);
                    setFormBatch('');
                  }}
                  disabled={isReadOnly}
                >
                  <option value="Riverside">Riverside</option>
                  <option value="Hilltop">Hilltop</option>
                </select>
              </div>
            )}

            <div>
              <label className="block text-xs font-bold text-slate-500 mb-1">Batch Selection</label>
              <select
                className="w-full border-slate-300 rounded text-sm py-2 font-mono"
                value={formBatch}
                onChange={(e) => setFormBatch(e.target.value)}
                disabled={!formSku || isReadOnly}
              >
                <option value="">-- Select Batch --</option>
                {availableBatchesForForm.map((b) => (
                  <option key={b.batch} value={b.batch}>
                    {b.resolutionError
                      ? `${b.displayBatch} (Resolution Error)`
                      : `${b.displayBatch} (${b.qty} ${selectedDefaultUnit})`}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-500 mb-1">Quantity</label>
              <input
                type="number"
                step="any"
                className="w-full border-slate-300 rounded text-sm py-2 font-bold"
                value={formQty || ''}
                onChange={(e) => setFormQty(Number(e.target.value))}
                disabled={isReadOnly}
              />
              <div className="mt-1 text-[11px] text-slate-500">Unit: {selectedDefaultUnit}</div>
              {mode === 'MANUAL' && formQty < 0 && (
                <div className="mt-2 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800">
                  Negative quantity increases logged stock. This will add{' '}
                  {Math.abs(formQty).toLocaleString()} {selectedDefaultUnit} to {formLocation}
                  because the warehouse count is higher than the system count.
                </div>
              )}
            </div>

            {mode === 'PO_SHIP' && (
              <div className="space-y-4 pt-2 border-t border-slate-100">
                <div>
                  <label className="block text-xs font-bold text-slate-500 mb-1">
                    Reference (PO/Order #)
                  </label>
                  <input
                    ref={dispatchReferenceInputRef}
                    className="w-full border-slate-300 rounded text-sm py-2"
                    value={formRef}
                    onChange={(e) => setFormRef(e.target.value)}
                    onFocus={(e) => e.currentTarget.select()}
                    disabled={isReadOnly}
                    placeholder="Order Reference"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-500 mb-1">Order Type</label>
                  <select
                    className="w-full border-slate-300 rounded text-sm py-2"
                    value={formOrderType}
                    onChange={(e) => setFormOrderType(e.target.value as OrderType)}
                    disabled={isReadOnly}
                  >
                    {ORDER_TYPE_OPTIONS.map((orderType) => (
                      <option key={orderType} value={orderType}>
                        {orderType}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-500 mb-1">
                    Recipient Name
                  </label>
                  <div className="relative">
                    <User className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
                    <input
                      className="w-full border-slate-300 rounded text-sm py-2 pl-9"
                      list={RECIPIENT_DATALIST_ID}
                      value={formRecipient}
                      onChange={(e) => setFormRecipient(e.target.value)}
                      onBlur={canonicalizeRecipientInput}
                      disabled={isReadOnly}
                      placeholder="Customer or Site Name"
                    />
                  </div>
                  <datalist id={RECIPIENT_DATALIST_ID}>
                    {recipientSuggestions.map((name) => (
                      <option key={name} value={name} />
                    ))}
                  </datalist>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-500 mb-1">Sales Rep</label>
                  <input
                    className="w-full border-slate-300 rounded text-sm py-2"
                    list={SALES_REP_DATALIST_ID}
                    value={formSalesRep}
                    onChange={(e) => setFormSalesRep(e.target.value)}
                    onBlur={canonicalizeSalesRepInput}
                    disabled={isReadOnly}
                    placeholder="Sales Representative"
                  />
                  <datalist id={SALES_REP_DATALIST_ID}>
                    {salesRepSuggestions.map((name) => (
                      <option key={name} value={name} />
                    ))}
                  </datalist>
                </div>
                {formOrderType === 'Paid' && (
                  <div>
                    <label className="block text-xs font-bold text-slate-500 mb-1">
                      Sales Price (£)
                    </label>
                    <div className="relative">
                      <CreditCard className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
                      <input
                        type="number"
                        step="0.0001"
                        className="w-full border-slate-300 rounded text-sm py-2 pl-9 font-bold text-green-700"
                        inputMode="decimal"
                        value={formPrice}
                        onChange={(e) => setFormPrice(e.target.value)}
                        disabled={isReadOnly}
                        placeholder="0.0000"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {mode === 'MANUAL' && (
              <div>
                <label className="block text-xs font-bold text-slate-500 mb-1">Reason Note</label>
                <input
                  className="w-full border-slate-300 rounded text-sm py-2"
                  value={formManualNote}
                  onChange={(e) => setFormManualNote(e.target.value)}
                  placeholder="Why is this stock being adjusted?"
                  disabled={isReadOnly}
                />
              </div>
            )}

            <div className="pt-3 mt-1 border-t border-slate-100">
              <div className="rounded-xl border border-indigo-100 bg-indigo-50/40 p-3">
                {renderAddToStagingButton()}
              </div>
            </div>
          </div>
        </div>

        {/* Right: Staging Area */}
        <div className={stagingPanelClass}>
          <div className="bg-slate-50 px-4 sm:px-6 py-4 border-b border-slate-200 flex justify-between items-center gap-3 flex-shrink-0">
            <h4 className="font-bold text-slate-700 flex items-center">
              <ShoppingCart className="w-5 h-5 mr-2 text-slate-500" /> Staged for Dispatch
            </h4>
            <span className="bg-white border border-slate-200 px-3 py-1 rounded text-xs font-bold text-slate-600">
              {stagedGroups.length} POs / {staging.length} Items
            </span>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-4 space-y-4">
            {stagedGroups.map((group) => {
              const isExpanded = expandedStagingGroups[group.key] ?? false;
              const isReleasing = Boolean(releasingGroupKeys[group.key]);
              const isPoShipGroup = group.items.every((item) => item.dispatchMode === 'PO_SHIP');
              const isEditingGroup =
                stagedGroupEditDraft?.originalKey === group.key &&
                stagedGroupEditDraft.itemIds.some((id) =>
                  group.items.some((item) => item.id === id),
                );
              const displayedGroupDetails = isEditingGroup
                ? stagedGroupEditDraft
                : {
                    reference: group.reference,
                    orderType: group.orderType as OrderType,
                    recipient: group.recipient,
                    salesRep: group.salesRep,
                  };
              const isPaidGroup =
                String(group.orderType || '')
                  .trim()
                  .toLowerCase() === 'paid';
              const paidGroupTotalSales = group.items.reduce(
                (sum, item) => sum + Number(item.quantity || 0) * Number(item.price || 0),
                0,
              );
              return (
                <div key={group.key} className="border rounded-xl overflow-hidden border-slate-200">
                  <div className="px-4 py-3 border-b flex items-center justify-between gap-3 bg-slate-50 border-slate-200">
                    <div className="flex items-center gap-3 min-w-0">
                      <button
                        onClick={() =>
                          setExpandedStagingGroups((prev) => ({
                            ...prev,
                            [group.key]: !isExpanded,
                          }))
                        }
                        className="text-slate-500 hover:text-slate-700"
                      >
                        {isExpanded ? (
                          <ChevronDown className="w-4 h-4" />
                        ) : (
                          <ChevronRight className="w-4 h-4" />
                        )}
                      </button>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <div
                            onClick={(e) => e.stopPropagation()}
                            onDoubleClick={(e) => {
                              e.stopPropagation();
                              handleUseStagedDispatchDetails(group);
                            }}
                            className="font-mono text-xs font-bold text-slate-800 truncate cursor-text hover:text-indigo-700 transition select-text"
                            title="Double-click to use this staged dispatch header in Dispatch Center"
                            aria-label="Use this staged dispatch header in Dispatch Center"
                          >
                            {group.reference || 'N/A'}
                          </div>
                          {isPaidGroup && (
                            <span className="text-[10px] font-black text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-0.5 whitespace-nowrap">
                              Sales: £
                              {paidGroupTotalSales.toLocaleString(undefined, {
                                minimumFractionDigits: 2,
                              })}
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-slate-500 truncate">
                          {group.orderType || 'Manual'} • {group.recipient || 'N/A'} •{' '}
                          {group.salesRep || ''}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold text-slate-600 bg-white border border-slate-200 rounded px-2 py-1">
                        {group.items.length} Items
                      </span>
                      <button
                        onClick={() => void handleCommit(group.key)}
                        disabled={
                          isReadOnly ||
                          isReleasing ||
                          isSavingStagedGroup ||
                          isEditingGroup ||
                          group.items.length === 0
                        }
                        title="Release this PO"
                        className="w-8 h-8 rounded-full bg-green-600 text-white flex items-center justify-center shadow hover:bg-green-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isReleasing ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <CheckCircle className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <>
                      <div className="px-4 py-3 border-b border-slate-100 bg-white grid grid-cols-1 md:grid-cols-[repeat(4,minmax(0,1fr))_72px] gap-3 items-center">
                        <input
                          className="w-full border-slate-300 rounded text-xs py-2 disabled:bg-slate-50 disabled:text-slate-700"
                          value={displayedGroupDetails.reference}
                          onChange={(e) =>
                            handleUpdateStagedGroupDraft('reference', e.target.value)
                          }
                          disabled={!isEditingGroup || isSavingStagedGroup}
                          placeholder="PO Reference"
                          aria-label="PO Reference"
                        />
                        <select
                          className="w-full border-slate-300 rounded text-xs py-2 disabled:bg-slate-50 disabled:text-slate-700"
                          value={displayedGroupDetails.orderType || 'Paid'}
                          onChange={(e) =>
                            handleUpdateStagedGroupDraft('orderType', e.target.value)
                          }
                          disabled={!isEditingGroup || isSavingStagedGroup}
                          aria-label="Order Type"
                        >
                          {ORDER_TYPE_OPTIONS.map((orderType) => (
                            <option key={orderType} value={orderType}>
                              {orderType}
                            </option>
                          ))}
                        </select>
                        <div className="relative min-w-0">
                          <input
                            className="w-full border-slate-300 rounded text-xs py-2 pr-8 disabled:bg-slate-50 disabled:text-slate-700"
                            value={displayedGroupDetails.recipient}
                            onFocus={() => openStagedNameDropdown('recipient')}
                            onChange={(e) =>
                              handleUpdateStagedNameDraft('recipient', e.target.value)
                            }
                            onBlur={() => {
                              canonicalizeStagedGroupName('recipient');
                              closeStagedNameDropdown('recipient');
                            }}
                            disabled={!isEditingGroup || isSavingStagedGroup}
                            placeholder="Recipient Name"
                            aria-label="Recipient Name"
                          />
                          {isEditingGroup && !isSavingStagedGroup && (
                            <button
                              type="button"
                              onMouseDown={(event) => {
                                event.preventDefault();
                                openStagedNameDropdown('recipient');
                              }}
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-700 hover:text-indigo-600"
                              aria-label="Show recipient history"
                            >
                              <ChevronDown className="w-4 h-4" />
                            </button>
                          )}
                          {renderStagedNameDropdown('recipient', stagedRecipientSuggestions)}
                        </div>
                        <div className="relative min-w-0">
                          <input
                            className="w-full border-slate-300 rounded text-xs py-2 pr-8 disabled:bg-slate-50 disabled:text-slate-700"
                            value={displayedGroupDetails.salesRep}
                            onFocus={() => openStagedNameDropdown('salesRep')}
                            onChange={(e) =>
                              handleUpdateStagedNameDraft('salesRep', e.target.value)
                            }
                            onBlur={() => {
                              canonicalizeStagedGroupName('salesRep');
                              closeStagedNameDropdown('salesRep');
                            }}
                            disabled={!isEditingGroup || isSavingStagedGroup}
                            placeholder="Sales Rep"
                            aria-label="Sales Rep"
                          />
                          {isEditingGroup && !isSavingStagedGroup && (
                            <button
                              type="button"
                              onMouseDown={(event) => {
                                event.preventDefault();
                                openStagedNameDropdown('salesRep');
                              }}
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-700 hover:text-indigo-600"
                              aria-label="Show sales rep history"
                            >
                              <ChevronDown className="w-4 h-4" />
                            </button>
                          )}
                          {renderStagedNameDropdown('salesRep', stagedSalesRepSuggestions)}
                        </div>
                        <div className="flex justify-end">
                          {isPoShipGroup && !isReadOnly && (
                            <button
                              onClick={() => {
                                if (isEditingGroup) {
                                  void handleSaveStagedGroupEdit();
                                  return;
                                }
                                handleStartStagedGroupEdit(group);
                              }}
                              disabled={isSavingStagedGroup}
                              className={`p-1.5 rounded transition disabled:cursor-not-allowed disabled:opacity-70 ${
                                isEditingGroup
                                  ? 'text-indigo-600 bg-indigo-50'
                                  : 'text-slate-400 hover:text-indigo-600 hover:bg-indigo-50'
                              }`}
                              title={
                                isSavingStagedGroup
                                  ? 'Saving order details...'
                                  : isEditingGroup
                                    ? 'Save order details'
                                    : 'Edit order details'
                              }
                              aria-label={
                                isEditingGroup ? 'Save order details' : 'Edit order details'
                              }
                            >
                              {isSavingStagedGroup && isEditingGroup ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : isEditingGroup ? (
                                <CheckCircle className="w-4 h-4" />
                              ) : (
                                <Edit2 className="w-4 h-4" />
                              )}
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="mobile-scroll-hint px-4 pt-3">
                        Swipe sideways to review staged line details.
                      </div>
                      <div className="mobile-table-region overflow-x-auto md:overflow-x-hidden">
                        <table className="w-full min-w-[820px] md:min-w-0 md:table-fixed text-sm text-left">
                          <thead className="bg-white text-slate-500 font-bold border-b border-slate-100 text-xs uppercase">
                            <tr>
                              <th className="px-4 py-3 md:w-[30%]">Item / Batch</th>
                              <th className="px-4 py-3 md:w-[24%]">Details</th>
                              <th className="px-4 py-3 text-right md:w-[11%]">Cost</th>
                              <th className="px-4 py-3 text-right md:w-[11%]">Price</th>
                              <th className="px-4 py-3 text-right md:w-[12%]">Qty</th>
                              <th className="px-4 py-3 text-right md:w-[12%]">Action</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-50">
                            {group.items.map((item) => {
                              const isEditing = editingStagedId === item.id;
                              const isSaving = Boolean(savingStagedIds[item.id]);
                              const currentItemId =
                                isEditing && stagedEditDraft ? stagedEditDraft.itemId : item.itemId;
                              const itemOptions = getEditableProductsForStagedItem(item);
                              const batchOptions =
                                currentItemId === item.itemId
                                  ? getEditableBatchesForStagedItem(item)
                                  : getAvailableBatches(
                                      currentItemId,
                                      item.location,
                                      item.dispatchMode === 'MANUAL' &&
                                        Number(stagedEditDraft?.quantity ?? item.quantity) < 0,
                                    );
                              const currentQuantity =
                                isEditing && stagedEditDraft
                                  ? stagedEditDraft.quantity
                                  : item.quantity;
                              const currentPrice =
                                isEditing && stagedEditDraft ? stagedEditDraft.price : item.price;
                              const currentBatch =
                                isEditing && stagedEditDraft
                                  ? stagedEditDraft.batchNumber
                                  : item.batchNumber;
                              return (
                                <tr
                                  key={item.id}
                                  className={`hover:bg-slate-50 transition-colors ${isEditing ? 'bg-indigo-50/30' : ''}`}
                                >
                                  <td className="px-4 py-3 min-w-0">
                                    {isEditing ? (
                                      <div className="space-y-1">
                                        <select
                                          className="w-full border-indigo-200 rounded text-xs py-1 font-semibold"
                                          value={currentItemId}
                                          onChange={(e) =>
                                            handleUpdateStagedItem(item, e.target.value)
                                          }
                                          disabled={isSaving}
                                        >
                                          {itemOptions.map((option) => (
                                            <option key={option.id} value={option.id}>
                                              {option.name}
                                            </option>
                                          ))}
                                        </select>
                                        <select
                                          className="w-full border-indigo-200 rounded text-xs py-1 font-mono"
                                          value={currentBatch}
                                          onChange={(e) => handleUpdateStagedBatch(e.target.value)}
                                          disabled={isSaving || batchOptions.length === 0}
                                        >
                                          {batchOptions.length === 0 ? (
                                            <option value="">No available batches</option>
                                          ) : (
                                            batchOptions.map((batch) => {
                                              const selectedOption =
                                                itemOptions.find(
                                                  (option) => option.id === currentItemId,
                                                ) || resolveEditableProductOption(currentItemId);
                                            return (
                                              <option key={batch.batch} value={batch.batch}>
                                                  {batch.displayBatch} (
                                                  {batch.displayQty ?? batch.qty}{' '}
                                                  {selectedOption.unit})
                                                </option>
                                            );
                                          })
                                          )}
                                        </select>
                                      </div>
                                    ) : (
                                      <div className="space-y-1 min-w-0">
                                        <div className="font-bold text-slate-800 leading-snug break-words">
                                          {resolveStagedItemDisplayName(item)}
                                        </div>
                                        <div className="text-[11px] text-slate-500 font-mono leading-snug break-all">
                                          {item.displayBatchNumber || (
                                            <span className="text-red-500 font-bold inline-flex items-center">
                                              <AlertCircle className="w-3 h-3 mr-1" /> Missing Batch
                                            </span>
                                          )}
                                        </div>
                                        <div className="text-[11px] text-slate-500 leading-snug flex items-center gap-1.5 min-w-0">
                                          <span className="truncate">{item.location}</span>
                                          {item.destination && (
                                            <>
                                              <ArrowRightLeft className="w-3 h-3 shrink-0 text-slate-400" />
                                              <span className="truncate">{item.destination}</span>
                                            </>
                                          )}
                                        </div>
                                      </div>
                                    )}
                                  </td>
                                  <td className="px-4 py-3 min-w-0">
                                    <div className="flex items-center gap-1.5 mb-0.5">
                                      <Tag className="w-3 h-3 text-indigo-400" />
                                      <span
                                        className={`text-[10px] font-black uppercase px-1.5 rounded ${item.orderType === 'Paid' ? 'bg-green-50 text-green-700 border border-green-100' : 'bg-slate-100 text-slate-600'}`}
                                      >
                                        {item.orderType}
                                      </span>
                                    </div>
                                    <div className="text-xs font-medium text-slate-600 truncate max-w-[140px]">
                                      {item.recipient || item.reason}
                                    </div>
                                    <div className="text-[10px] text-slate-400 truncate">
                                      {item.reference}
                                    </div>
                                  </td>
                                  <td className="px-4 py-3 text-right text-xs font-mono text-slate-500">
                                    £{item.productionCost.toFixed(2)}
                                  </td>
                                  <td className="px-4 py-3 text-right">
                                    {item.orderType === 'Paid' ? (
                                      isEditing ? (
                                        <div className="relative inline-block">
                                          <CreditCard className="w-3 h-3 absolute left-2 top-2 text-green-500" />
                                          <input
                                            type="number"
                                            step="0.0001"
                                            className="w-24 border-green-200 bg-white rounded text-right text-xs py-1 pl-6 font-bold text-green-700 focus:ring-1 focus:ring-green-400"
                                            inputMode="decimal"
                                            value={currentPrice || ''}
                                            onChange={(e) =>
                                              handleUpdateStagedField('price', e.target.value)
                                            }
                                            disabled={isSaving}
                                          />
                                        </div>
                                      ) : (
                                        <span className="font-bold text-green-700">
                                          £{item.price.toFixed(2)}
                                        </span>
                                      )
                                    ) : (
                                      <span className="text-[10px] text-slate-300 italic">N/A</span>
                                    )}
                                  </td>
                                  <td className="px-4 py-3 text-right">
                                    {isEditing ? (
                                      <input
                                        type="number"
                                        step="any"
                                        className="w-20 border-indigo-200 bg-white rounded text-right text-xs py-1 px-2 font-bold text-slate-800"
                                        value={currentQuantity || ''}
                                        onChange={(e) =>
                                          handleUpdateStagedField(
                                            'quantity',
                                            Number(e.target.value),
                                          )
                                        }
                                        disabled={isSaving}
                                      />
                                    ) : (
                                      <span className="font-mono font-bold text-slate-700">
                                        {item.quantity} {item.unit}
                                      </span>
                                    )}
                                  </td>
                                  <td className="px-4 py-3 text-right">
                                    <div className="flex justify-end gap-1">
                                      <button
                                        onClick={() => {
                                          if (isEditing) {
                                            void handleSaveStagedEdit(item);
                                            return;
                                          }
                                          handleStartStagedEdit(item);
                                        }}
                                        disabled={isSaving || isSavingStagedGroup}
                                        className={`p-1.5 rounded transition disabled:cursor-not-allowed disabled:opacity-70 ${isEditing ? 'text-indigo-600 bg-indigo-50' : 'text-slate-300 hover:text-indigo-600 hover:bg-indigo-50'}`}
                                        title={
                                          isSaving
                                            ? 'Saving changes...'
                                            : isEditing
                                              ? 'Confirm changes'
                                              : 'Edit staged line'
                                        }
                                      >
                                        {isSaving ? (
                                          <Loader2 className="w-4 h-4 animate-spin" />
                                        ) : isEditing ? (
                                          <CheckCircle className="w-4 h-4" />
                                        ) : (
                                          <Edit2 className="w-4 h-4" />
                                        )}
                                      </button>
                                      <button
                                        onClick={() => handleRemoveStaged(item.id)}
                                        disabled={isSaving || isSavingStagedGroup}
                                        className="p-1.5 text-slate-300 hover:text-red-600 hover:bg-red-50 rounded transition disabled:cursor-not-allowed disabled:opacity-50"
                                      >
                                        <Trash2 className="w-4 h-4" />
                                      </button>
                                    </div>
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
            {stagedGroups.length === 0 && (
              <div className="py-20 text-center text-slate-400 italic">
                No items staged. Select product and batch to begin.
              </div>
            )}
          </div>
          {!isReadOnly && (
            <div className="px-6 py-3 border-t border-slate-200 bg-white flex justify-end">
              <button
                onClick={() => void handleDispatchAll()}
                disabled={
                  stagedGroups.length === 0 ||
                  isDispatchingAll ||
                  Object.keys(releasingGroupKeys).length > 0
                }
                className="px-4 py-2 text-sm font-bold text-white bg-green-600 hover:bg-green-700 rounded-lg shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
              >
                {isDispatchingAll && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Dispatch All
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Activity History Table */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden min-h-[18rem] md:h-[420px] flex flex-col">
        <div className="bg-slate-50 px-4 sm:px-6 py-4 border-b border-slate-200 flex-shrink-0">
          <h4 className="font-bold text-slate-800 flex items-center">
            <History className="w-5 h-5 mr-2 text-indigo-600" /> Dispatch History (Grouped by PO +
            Notes)
          </h4>
          <ActivityFilterBar
            fromDate={historyDraftFromDate}
            toDate={historyDraftToDate}
            onChangeFrom={setHistoryDraftFromDate}
            onChangeTo={setHistoryDraftToDate}
            rightSideControls={
              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">
                  Search
                </label>
                <input
                  type="text"
                  value={historyDraftSearchQuery}
                  onChange={(event) => setHistoryDraftSearchQuery(event.target.value)}
                  placeholder="PO, recipient, sales rep, item, batch..."
                  className="w-full h-11 border border-slate-300 rounded bg-white px-3 text-base sm:text-sm shadow-none"
                />
              </div>
            }
            onApply={applyHistoryFilters}
            onReset={resetHistoryFilters}
            onExport={downloadHistoryCSV}
            exportDisabled={sortedActivityHistory.length === 0}
          />
        </div>

        <div className="mobile-scroll-hint px-4 pt-3">
          Swipe sideways to review all dispatch history columns.
        </div>
        <div className="mobile-table-region overflow-x-auto overflow-y-visible md:overflow-y-auto flex-1 min-h-0">
          <table className="w-full min-w-[1120px] text-sm text-left">
            <thead className="sticky top-0 z-10 bg-white text-slate-500 font-bold uppercase text-[10px] tracking-widest border-b border-slate-200">
              <tr>
                <SortableHeader
                  className="px-6 py-3"
                  label="PO Reference / Date"
                  sortKey="createdAt"
                  activeSortKey={historySortState.key}
                  sortDir={historySortState.dir}
                  onChange={(key, dir) => setHistorySortState({ key: key as HistorySortKey, dir })}
                />
                <SortableHeader
                  className="px-6 py-3"
                  label="Recipient & Type"
                  sortKey="recipientType"
                  activeSortKey={historySortState.key}
                  sortDir={historySortState.dir}
                  onChange={(key, dir) => setHistorySortState({ key: key as HistorySortKey, dir })}
                />
                <SortableHeader
                  className="px-6 py-3"
                  label="Sales Rep"
                  sortKey="salesRep"
                  activeSortKey={historySortState.key}
                  sortDir={historySortState.dir}
                  onChange={(key, dir) => setHistorySortState({ key: key as HistorySortKey, dir })}
                />
                <SortableHeader
                  className="px-6 py-3 text-right"
                  label="Items"
                  sortKey="itemsCount"
                  activeSortKey={historySortState.key}
                  sortDir={historySortState.dir}
                  onChange={(key, dir) => setHistorySortState({ key: key as HistorySortKey, dir })}
                />
                <SortableHeader
                  className="px-6 py-3 text-right"
                  label="Total Cost"
                  sortKey="totalCost"
                  activeSortKey={historySortState.key}
                  sortDir={historySortState.dir}
                  onChange={(key, dir) => setHistorySortState({ key: key as HistorySortKey, dir })}
                />
                <SortableHeader
                  className="px-6 py-3 text-right"
                  label="Total Sales"
                  sortKey="totalPrice"
                  activeSortKey={historySortState.key}
                  sortDir={historySortState.dir}
                  onChange={(key, dir) => setHistorySortState({ key: key as HistorySortKey, dir })}
                />
                <SortableHeader
                  className="px-6 py-3 text-right"
                  label="Revenue"
                  sortKey="revenue"
                  activeSortKey={historySortState.key}
                  sortDir={historySortState.dir}
                  onChange={(key, dir) => setHistorySortState({ key: key as HistorySortKey, dir })}
                />
                <th className="px-6 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sortedActivityHistory.map((group) => {
                const isExpanded = expandedHistoryRef === group.key;
                const isEditingHistory =
                  editingHistoryRef === group.key && historyEditDraft?.key === group.key;
                const isCancelled = group.isVoided;
                const isActionLocked = group.isVoided || group.hasReversedItems;
                const isReturningHistory = returningHistoryKey === group.key;
                const isReturnActionLocked = isActionLocked || group.isTransfer;
                const lockedActionTitle = group.isVoided
                  ? 'Already deleted'
                  : group.hasReversedItems
                    ? 'Already adjusted or reversed'
                    : '';
                const returnActionTitle = group.isTransfer
                  ? 'Transfer dispatches cannot be returned to staging'
                  : isReturnActionLocked
                    ? lockedActionTitle || 'Dispatch group cannot be returned to staging'
                    : 'Return dispatch group to staging';
                const referenceLabel = isCancelled
                  ? `${group.reference} (deleted)`
                  : group.reference;
                const rowClassName = isCancelled
                  ? 'bg-slate-50/80 transition-colors cursor-pointer'
                  : 'hover:bg-slate-50 transition-colors cursor-pointer';
                return (
                  <React.Fragment key={group.key}>
                    <tr
                      onClick={() => setExpandedHistoryRef(isExpanded ? null : group.key)}
                      className={rowClassName}
                    >
                      <td className="px-6 py-4">
                        <div className="flex items-center">
                          {isExpanded ? (
                            <ChevronDown className="w-4 h-4 mr-2 text-slate-400" />
                          ) : (
                            <ChevronRight className="w-4 h-4 mr-2 text-slate-400" />
                          )}
                          <div>
                            <div
                              className={`font-mono text-xs font-bold ${isCancelled ? 'text-slate-400' : 'text-slate-800'}`}
                            >
                              {referenceLabel}
                            </div>
                            <div className="text-[10px] text-slate-400 mt-1">
                              {formatBritishDate(group.createdAt)}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div
                          className={`text-xs font-semibold ${isCancelled ? 'text-slate-400' : 'text-slate-700'}`}
                        >
                          {group.recipient}
                        </div>
                        <div className="flex items-center gap-1 mt-1">
                          <span
                            className={`text-[10px] font-black uppercase px-2 py-0.5 rounded border ${
                              isCancelled
                                ? 'bg-slate-100 text-slate-500 border-slate-200'
                                : group.isTransfer
                                  ? 'bg-blue-50 text-blue-700 border-blue-100'
                                  : group.orderType === 'Paid'
                                    ? 'bg-emerald-50 text-emerald-700 border-emerald-100'
                                    : group.orderType === 'Sample'
                                      ? 'bg-amber-50 text-amber-700 border-amber-100'
                                      : 'bg-slate-100 text-slate-600 border-slate-200'
                            }`}
                          >
                            {group.orderType}
                          </span>
                          {group.isVoided && (
                            <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded bg-red-50 text-red-700 border border-red-100">
                              DELETED
                            </span>
                          )}
                          {!group.isVoided && group.hasReversedItems && (
                            <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200">
                              ADJUSTED
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div
                          className={`text-xs ${isCancelled ? 'text-slate-400' : 'text-slate-700'}`}
                        >
                          {getDisplaySalesRep(group.salesRep)}
                        </div>
                      </td>
                      <td
                        className={`px-6 py-4 text-right font-bold ${isCancelled ? 'text-slate-400' : 'text-slate-600'}`}
                      >
                        {group.itemsCount}
                      </td>
                      <td
                        className={`px-6 py-4 text-right font-mono text-xs ${isCancelled ? 'text-slate-400' : 'text-slate-500'}`}
                      >
                        £{group.totalCost.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </td>
                      <td
                        className={`px-6 py-4 text-right font-mono text-xs font-bold ${isCancelled ? 'text-slate-400' : 'text-slate-800'}`}
                      >
                        £{group.totalPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </td>
                      <td
                        className={`px-6 py-4 text-right font-mono text-xs font-black ${isCancelled ? 'text-slate-400' : group.revenue >= 0 ? 'text-green-600' : 'text-red-600'}`}
                      >
                        £{group.revenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex justify-end gap-1">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (isEditingHistory) {
                                handleCancelHistoryEdit();
                              } else {
                                handleStartHistoryEdit(group);
                              }
                            }}
                            disabled={isReadOnly || isActionLocked || isHistoryActionLoading}
                            className="p-1.5 rounded text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 disabled:opacity-40"
                            title={
                              isActionLocked
                                ? lockedActionTitle || 'Dispatch group cannot be edited'
                                : 'Edit dispatch group'
                            }
                          >
                            <Edit2 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleReturnHistoryGroupToStaging(group);
                            }}
                            disabled={isReadOnly || isReturnActionLocked || isHistoryActionLoading}
                            className="p-1.5 rounded text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 disabled:opacity-40"
                            title={returnActionTitle}
                            aria-label="Return dispatch group to staging"
                          >
                            {isReturningHistory ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <RotateCcw className="w-4 h-4" />
                            )}
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleVoidHistoryGroup(group);
                            }}
                            disabled={isReadOnly || isActionLocked || isHistoryActionLoading}
                            className="p-1.5 rounded text-slate-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-40"
                            title={isActionLocked ? lockedActionTitle : 'Delete dispatch group'}
                          >
                            {isHistoryActionLoading && isEditingHistory ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Trash2 className="w-4 h-4" />
                            )}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="bg-slate-50/50">
                        <td colSpan={8} className="px-6 py-4">
                          <div className="bg-white border border-slate-200 rounded-lg shadow-inner overflow-hidden">
                            {isEditingHistory && historyEditDraft && (
                              <div className="px-4 py-3 border-b border-slate-100 bg-indigo-50/40">
                                <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
                                  <input
                                    className="border-indigo-200 rounded text-xs py-2"
                                    value={historyEditDraft.recipient}
                                    onChange={(e) =>
                                      setHistoryEditDraft((prev) =>
                                        prev ? { ...prev, recipient: e.target.value } : prev,
                                      )
                                    }
                                    disabled={isReadOnly || isHistoryActionLoading}
                                    placeholder="Recipient"
                                  />
                                  <select
                                    className="border-indigo-200 rounded text-xs py-2"
                                    value={historyEditDraft.orderType}
                                    onChange={(e) =>
                                      setHistoryEditDraft((prev) =>
                                        prev ? { ...prev, orderType: e.target.value } : prev,
                                      )
                                    }
                                    disabled={isReadOnly || isHistoryActionLoading}
                                  >
                                    <option value="Paid">Paid</option>
                                    <option value="Sample">Sample</option>
                                    <option value="Internal">Internal</option>
                                    <option value="Others">Others</option>
                                    <option value="Transfer">Transfer</option>
                                  </select>
                                  <button
                                    onClick={() => void handleSaveHistoryEdit(group)}
                                    disabled={
                                      isReadOnly || isActionLocked || isHistoryActionLoading
                                    }
                                    className="px-4 py-2 bg-indigo-600 text-white text-xs font-bold rounded hover:bg-indigo-700 disabled:opacity-50 flex items-center justify-center"
                                  >
                                    {isHistoryActionLoading ? (
                                      <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                                    ) : (
                                      <CheckCircle className="w-3 h-3 mr-1" />
                                    )}
                                    Save Adjustment
                                  </button>
                                  <button
                                    onClick={handleCancelHistoryEdit}
                                    disabled={isHistoryActionLoading}
                                    className="px-4 py-2 bg-white border border-slate-200 text-slate-600 text-xs font-bold rounded hover:bg-slate-50"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}
                            {group.isVoided && (
                              <div className="px-4 py-3 border-b border-red-100 bg-red-50/60 text-xs text-red-800">
                                <div className="flex items-start gap-2">
                                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 text-red-600" />
                                  <div>
                                    <span className="font-bold">Delete reason:</span>{' '}
                                    <span>{group.cancelReason || 'No reason recorded.'}</span>
                                  </div>
                                </div>
                              </div>
                            )}
                            <table className="w-full min-w-[720px] text-[11px]">
                              <thead className="bg-slate-50 text-slate-400 font-bold uppercase border-b border-slate-100">
                                <tr>
                                  <th className="px-4 py-2">Product / Batch</th>
                                  <th className="px-4 py-2">Location</th>
                                  <th className="px-4 py-2 text-right">Quantity</th>
                                  <th className="px-4 py-2 text-right">Line Price</th>
                                  <th className="px-4 py-2">Notes</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-50">
                                {group.items.map((tx, idx) => {
                                  const unitSalePrice = resolveLedgerUnitSalePrice(tx);
                                  const draftLine = historyEditDraft?.lines.find(
                                    (line) => line.txId === tx.id,
                                  );
                                  let batchLabel = tx.batchNumber || 'N/A';
                                  try {
                                    batchLabel =
                                      resolveBatchForDispatch(
                                        tx.itemId,
                                        String(tx.batchNumber || ''),
                                      ).displayBatch || batchLabel;
                                  } catch {
                                    batchLabel = tx.batchNumber || 'N/A';
                                  }
                                  return (
                                    <tr key={tx.id || idx}>
                                      <td className="px-4 py-2">
                                        <div className="font-bold text-slate-700 flex items-center">
                                          <Box className="w-3 h-3 mr-1 text-slate-400" />
                                          {resolveDispatchItemDisplayName({
                                            itemId: tx.itemId,
                                            itemName: tx.itemName,
                                          })}
                                        </div>
                                        <div className="text-[9px] font-mono text-slate-400 uppercase">
                                          Batch: {batchLabel}
                                        </div>
                                      </td>
                                      <td className="px-4 py-2 text-slate-600">
                                        <div className="flex items-center">
                                          <MapPin className="w-2 h-2 mr-1" /> {tx.location}
                                        </div>
                                      </td>
                                      <td className="px-4 py-2 text-right font-mono font-bold text-slate-700">
                                        {isEditingHistory ? (
                                          <input
                                            type="number"
                                            step="any"
                                            className="w-24 border-indigo-200 rounded text-right text-[11px] py-1 px-2 font-mono font-bold text-slate-700"
                                            value={draftLine?.quantity ?? tx.quantity}
                                            onChange={(e) =>
                                              handleUpdateHistoryDraftLine(tx.id, {
                                                quantity: Number(e.target.value),
                                              })
                                            }
                                          />
                                        ) : (
                                          <>
                                            {tx.quantity} {tx.unit}
                                          </>
                                        )}
                                      </td>
                                      <td className="px-4 py-2 text-right font-mono text-slate-600">
                                        {isEditingHistory ? (
                                          <input
                                            type="number"
                                            step="0.0001"
                                            className="w-24 border-indigo-200 rounded text-right text-[11px] py-1 px-2 font-mono font-bold text-slate-700"
                                            inputMode="decimal"
                                            value={draftLine?.price ?? unitSalePrice}
                                            onChange={(e) =>
                                              handleUpdateHistoryDraftLine(tx.id, {
                                                price: e.target.value,
                                              })
                                            }
                                            disabled={group.isTransfer}
                                          />
                                        ) : unitSalePrice >= 0 ? (
                                          `£${(unitSalePrice * tx.quantity).toFixed(2)}`
                                        ) : (
                                          '—'
                                        )}
                                      </td>
                                      <td
                                        className="px-4 py-2 text-slate-400 italic truncate max-w-[200px]"
                                        title={tx.notes}
                                      >
                                        {isEditingHistory ? (
                                          <input
                                            className="w-full border-indigo-200 rounded text-[11px] py-1 px-2 text-slate-700"
                                            value={draftLine?.note ?? parseLineNote(tx.notes)}
                                            onChange={(e) =>
                                              handleUpdateHistoryDraftLine(tx.id, {
                                                note: e.target.value,
                                              })
                                            }
                                          />
                                        ) : (
                                          tx.notes || '—'
                                        )}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
              {sortedActivityHistory.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-slate-400 italic">
                    No dispatch records found in ledger.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {modalConfig && modalConfig.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 animate-in fade-in">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6 border border-slate-200">
            <div
              className={`flex items-center mb-4 ${modalConfig.isDangerous ? 'text-red-600' : 'text-green-600'}`}
            >
              {modalConfig.isDangerous ? (
                <AlertTriangle className="w-6 h-6 mr-3" />
              ) : (
                <CheckCircle className="w-6 h-6 mr-3" />
              )}
              <h3 className="text-lg font-bold">{modalConfig.title}</h3>
            </div>
            <p className="text-sm text-slate-600 mb-6 font-medium leading-relaxed">
              {modalConfig.message}
            </p>
            <div className="flex justify-end gap-3">
              {modalConfig.showCancel !== false && (
                <button
                  onClick={() => setModalConfig(null)}
                  className="px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-100 rounded-lg transition"
                >
                  Cancel
                </button>
              )}
              <button
                onClick={async () => {
                  setIsModalActionLoading(true);
                  try {
                    await modalConfig.onConfirm();
                  } finally {
                    setIsModalActionLoading(false);
                  }
                }}
                disabled={isModalActionLoading}
                className={`px-4 py-2 text-sm font-bold text-white rounded-lg shadow-sm transition flex items-center ${modalConfig.isDangerous ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700'}`}
              >
                {isModalActionLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {modalConfig.confirmLabel || 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
