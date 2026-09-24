import React, { useEffect, useState, useMemo, useRef } from 'react';
import { Product, InventoryTransaction, ProductBatch, BatchRecord, LocationName, BatchQcDisposition } from '../../types';
import { Package, Plus, CheckCircle, Loader2, AlertTriangle, Factory, Lock, Edit, Trash2, ArrowRight, X, PoundSterling } from 'lucide-react';
import { resolveLedgerEventTime } from '../../services/ledgerTime';
import { ActivityFilterBar } from './ActivityFilterBar';
import { SortableHeader } from './SortableHeader';
import { useIsHandheldDevice } from '../../lib/useIsHandheldDevice';
import { formatBritishDate, formatBritishDateTime, formatBritishTime } from '../../lib/dateFormatting';
import {
  buildStandardBatchId,
  generateBottleBatchId,
  parseBatchId
} from '../../services/batchBusinessLogic';
import {
  formatFinishedProductInventoryLabel,
} from '../../utils/finishedProductLabels';
import { compareProductsByInventoryTypeOrder } from '../../services/productCategoryGrouping';

interface Props {
  products: Product[];
  productBatches: ProductBatch[];
  transactions: InventoryTransaction[];
  currentUser: string;
  onTransaction: (tx: any, lotMetadata?: any) => Promise<InventoryTransaction | void> | InventoryTransaction | void;
  onEditTransaction?: (id: string, updates: any, reason: string, user: string) => Promise<void> | void;
  onDeleteTransaction?: (id: string) => Promise<void> | void;
  onEditProductInActivity?: (payload: any) => Promise<void> | void;
  onDeleteProductInActivity?: (tx: InventoryTransaction, linkedBatch?: ProductBatch | null) => Promise<void> | void;
  onCreateBatch: (batch: Partial<BatchRecord>) => Promise<void> | void;
  onUpdateBatch?: (batch: BatchRecord) => Promise<void> | void;
  onDeleteBatch?: (id: string) => Promise<void> | void;
  onRenameBatchReference?: (oldId: string, newId: string, batch: BatchRecord, user: string) => Promise<void> | void;
  onReleaseBatch?: (batch: BatchRecord) => Promise<void> | void;
  isReadOnly?: boolean;
}

const normalizeStatus = (status: string | undefined): string => {
  if (!status) return 'on hold';
  return status.trim().toLowerCase().replace(/[\s_-]+/g, '_');
};

const QC_DISPOSITIONS: BatchQcDisposition[] = ['standard', 'rework_pending', 'final_rejected', 'reconciled_release'];

const normalizeQcDisposition = (value: unknown): BatchQcDisposition => {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return QC_DISPOSITIONS.includes(normalized as BatchQcDisposition)
    ? normalized as BatchQcDisposition
    : 'standard';
};

const getDefaultDispositionForStatus = (status: string, previous?: unknown): BatchQcDisposition => {
  const normalizedStatus = normalizeStatus(status);
  const previousDisposition = normalizeQcDisposition(previous);
  if (normalizedStatus === 'qc_rejected') {
    return previousDisposition === 'final_rejected' || previousDisposition === 'rework_pending'
      ? previousDisposition
      : 'rework_pending';
  }
  if (normalizedStatus === 'qc_passed' && previousDisposition === 'reconciled_release') return 'reconciled_release';
  if (normalizedStatus === 'released' && previousDisposition === 'reconciled_release') return 'reconciled_release';
  return 'standard';
};

const formatQcDispositionLabel = (value: unknown): string => {
  const normalized = normalizeQcDisposition(value);
  if (normalized === 'rework_pending') return 'Rework pending';
  if (normalized === 'final_rejected') return 'Final rejected';
  if (normalized === 'reconciled_release') return 'Reconciled release';
  return 'Standard';
};

const isReleasedStatus = (status: unknown): boolean => normalizeStatus(String(status || '')) === 'released';

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

const normalizeIdentityKey = (value: unknown): string => String(value ?? '').trim().toLowerCase();
const BULK_BATCH_MARKERS = ['BLENDEDBULK', 'COMPONENTA'];
const PACK_DEFAULT_MARKERS = ['FINISHED', 'SACHET', 'SAMPLE'];
type ProductInBatchType = 'BULK' | 'PACK' | 'TERMINAL';

const formatBatchTimestamp = (date: Date): string => {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}${hh}${min}${ss}`;
};

const makeTimestampedBatchId = (productSku: string, batchNumber: string, timestamp: string): string =>
  `${String(productSku || '').trim()}::${String(batchNumber || '').trim()}::${timestamp}`;

const extractEditableBatchNumber = (batchReference: string, fallback = ''): string => {
  const normalized = String(batchReference || '').trim();
  if (!normalized) return fallback;
  const parts = normalized.split('::');
  if (parts.length >= 3) return parts[1] || fallback;
  const parsed = parseBatchId(normalized);
  if (parsed.type === 'STANDARD') return parsed.printedBatchNumber || fallback;
  return fallback || normalized;
};

const deriveEditedBatchId = (currentBatchId: string, itemId: string, batchNumber: string): string => {
  const normalizedCurrent = String(currentBatchId || '').trim();
  const parts = normalizedCurrent.split('::');
  if (parts.length >= 3) {
    return [String(itemId || '').trim(), String(batchNumber || '').trim(), parts[parts.length - 1]].join('::');
  }
  return buildStandardBatchId(itemId, batchNumber);
};

const inferDefaultBatchType = (product: Product | undefined): ProductInBatchType => {
  const fingerprint = [
    product?.sku_id,
    product?.sku_name,
    product?.category,
    product?.family,
    product?.notes
  ]
    .filter(Boolean)
    .join(' ')
    .toUpperCase();
  if (BULK_BATCH_MARKERS.some((marker) => fingerprint.includes(marker))) return 'BULK';
  if (PACK_DEFAULT_MARKERS.some((marker) => fingerprint.includes(marker))) return 'PACK';
  return 'TERMINAL';
};

const normalizeBatchType = (value: unknown, fallback: ProductInBatchType): ProductInBatchType => {
  const token = String(value || '').trim().toUpperCase();
  if (token === 'BULK' || token === 'PACK' || token === 'TERMINAL') return token;
  if (token === 'STANDALONE') return 'TERMINAL';
  return fallback;
};

const resolveProductBatchIdentity = (batch: ProductBatch | undefined | null): string => {
  if (!batch) return '';
  const explicit = String((batch as any).batch_id ?? batch.id ?? '').trim();
  if (explicit) return explicit;
  return buildStandardBatchId(batch.sku_id, batch.batch_number || '');
};

const findProductReleaseTxn = (
  transactions: InventoryTransaction[],
  skuId: string,
  batchId: string
): InventoryTransaction | null =>
  transactions.find((tx) =>
    String(tx.type || '').trim().toUpperCase() === 'IN' &&
    String(tx.category || '').trim().toUpperCase() === 'PRODUCT' &&
    String(tx.reason || '').trim().toUpperCase() === 'QC RELEASE' &&
    String(tx.itemId || '').trim() === String(skuId || '').trim() &&
    String(tx.batchNumber || '').trim() === String(batchId || '').trim()
  ) || null;

const isBottleSku = (product: Product | undefined): boolean =>
  String(product?.sku_id || '').toUpperCase().includes('BOTTLE');

const resolveBatchRecordByLedgerReference = (
  productBatches: ProductBatch[],
  skuId: string,
  batchReference: string
): ProductBatch | null => {
  const normalizedSku = normalizeIdentityKey(skuId);
  const normalizedReference = normalizeIdentityKey(batchReference);
  if (!normalizedSku || !normalizedReference) return null;

  const exactMatch = productBatches.find((batch) =>
    normalizeIdentityKey(batch.sku_id) === normalizedSku &&
    normalizeIdentityKey(resolveProductBatchIdentity(batch)) === normalizedReference
  );
  if (exactMatch) return exactMatch;

  const parsed = parseBatchId(batchReference);
  if (parsed.type === 'STANDARD') {
    const printedParts = String(parsed.printedBatchNumber || '').split('::').filter(Boolean);
    const printedBatchNumber = printedParts[0] || '';
    const terminalTimestamp = printedParts.length >= 2 ? printedParts[printedParts.length - 1] : '';
    const standardMatches = productBatches.filter((batch) => {
      if (normalizeIdentityKey(batch.sku_id) !== normalizedSku) return false;
      const identity = normalizeIdentityKey(resolveProductBatchIdentity(batch));
      const batchNumber = normalizeIdentityKey(batch.batch_number);
      const printedKey = normalizeIdentityKey(printedBatchNumber);
      const timestampKey = normalizeIdentityKey(terminalTimestamp);
      if (printedKey && batchNumber === printedKey) {
        return !timestampKey || identity.endsWith(`::${printedKey}::${timestampKey}`);
      }
      return Boolean(printedKey && timestampKey && identity.endsWith(`::${printedKey}::${timestampKey}`));
    });
    if (standardMatches.length === 1) return standardMatches[0];
    return null;
  }
  if (parsed.type) return null;

  const legacyMatches = productBatches.filter((batch) =>
    normalizeIdentityKey(batch.sku_id) === normalizedSku &&
    normalizeIdentityKey(batch.batch_number) === normalizedReference
  );

  if (legacyMatches.length > 1) {
    throw new Error('Legacy batch reference cannot be uniquely resolved.');
  }

  return legacyMatches[0] || null;
};

const resolveBatchDisplayValue = (
  productBatches: ProductBatch[],
  skuId: string,
  batchReference: string
): string => {
  const normalizedReference = String(batchReference || '').trim();
  if (!normalizedReference) return '';

  const parsed = parseBatchId(normalizedReference);
  if (parsed.type === 'STANDARD') {
    return parsed.printedBatchNumber || normalizedReference;
  }

  try {
    const matched = resolveBatchRecordByLedgerReference(productBatches, skuId, normalizedReference);
    if (matched?.batch_number) return matched.batch_number;
  } catch {
    return normalizedReference;
  }

  return normalizedReference;
};

const resolveBottleDeclarationDisplay = (batchId: string): string => {
  const normalized = String(batchId || '').trim();
  if (!normalized) return '';
  const parsed = parseBatchId(normalized);
  if (parsed.type === 'STANDARD' && parsed.printedBatchNumber) {
    const firstToken = parsed.printedBatchNumber.split('::')[0];
    if (/^\d{8}__\d+$/.test(firstToken)) return firstToken;
    return parsed.printedBatchNumber;
  }
  const match = normalized.match(/(?:^|::)(\d{8}__\d+)(?=$|::)/);
  return match?.[1] || normalized;
};

const isBottleBatchForSku = (batchNumber: string, skuId: string): boolean => {
  const parsed = parseBatchId(String(batchNumber || '').trim());
  return (
    parsed.type === 'STANDARD' &&
    normalizeIdentityKey(parsed.skuId) === normalizeIdentityKey(skuId) &&
    /^\d{8}__\d+$/.test(String(parsed.printedBatchNumber || '').split('::')[0] || '')
  );
};

const parseUnitCostValue = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
};

const formatUnitCostInput = (value: number | null): string => {
  if (value === null) return '';
  return String(value);
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

const getDefaultLast30DaysRange = (): { from: string; to: string } => {
  const toDate = new Date();
  const fromDate = new Date(toDate);
  fromDate.setDate(fromDate.getDate() - 29);
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

type ProductInRecentActivitySortKey =
  | 'date'
  | 'product'
  | 'batchNumber'
  | 'batchType'
  | 'qty'
  | 'unitProductionCost'
  | 'user';

interface ProductInRecentActivityRow {
  tx: InventoryTransaction | null;
  batch: ProductBatch;
  stableIndex: number;
  eventDate: string;
  eventDateOnly: string;
  eventTimestamp: number;
  productName: string;
  batchNumber: string;
  batchReference: string;
  batchType: string;
  qtyDisplay: string;
  batchQty: number;
  ledgerQty: number | null;
  hasQuantityMismatch: boolean;
  unitCost: number;
  user: string;
  notes: string;
  qcStatus: string;
  qcDisposition: BatchQcDisposition;
  releaseKind: 'none' | 'standard' | 'reconciled';
}

const resolveBatchRecordTimestamp = (batch: ProductBatch): number => {
  const candidates = [
    (batch as any).updatedAt,
    (batch as any).createdAt,
    batch.date_produced
  ];
  for (const candidate of candidates) {
    const raw = String(candidate || '').trim();
    if (!raw) continue;
    const parsed = new Date(raw).getTime();
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
};

export const ProductReception: React.FC<Props> = ({
  products, productBatches, transactions, currentUser,
  onTransaction, onEditTransaction, onDeleteTransaction, onEditProductInActivity, onDeleteProductInActivity,
  onCreateBatch, onUpdateBatch, onDeleteBatch, onRenameBatchReference, onReleaseBatch, isReadOnly
}) => {
  const isHandheldDevice = useIsHandheldDevice();
  const defaultRecentActivityDateRange = useMemo(() => getDefaultLast30DaysRange(), []);
  const initialProdInState = {
    itemId: '',
    batchType: 'TERMINAL' as ProductInBatchType,
    batchNumber: '',
    quantity: '',
    location: 'Riverside' as LocationName,
    reason: 'Production Output',
    unit: '',
    unitCost: '',
    qcStatus: 'On hold',
    qcNotes: '',
    qcDisposition: 'standard' as BatchQcDisposition
  };
  const [prodIn, setProdIn] = useState({
    ...initialProdInState
  });
  
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [processingBatchId, setProcessingBatchId] = useState<string | null>(null);
  const [editingBatchId, setEditingBatchId] = useState<string | null>(null);
  const [editingRecentActivityTxId, setEditingRecentActivityTxId] = useState<string | null>(null);
  const [recentActivitySyncState, setRecentActivitySyncState] = useState<{ txId: string; mode: 'edit' | 'delete' } | null>(null);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [isBatchManuallyEdited, setIsBatchManuallyEdited] = useState(false);
  const [isUnitCostManuallyEdited, setIsUnitCostManuallyEdited] = useState(false);
  const [isGeneratingBottleBatch, setIsGeneratingBottleBatch] = useState(false);
  const [recentActivityDraftFromDate, setRecentActivityDraftFromDate] = useState(defaultRecentActivityDateRange.from);
  const [recentActivityDraftToDate, setRecentActivityDraftToDate] = useState(defaultRecentActivityDateRange.to);
  const [recentActivityDraftBatchType, setRecentActivityDraftBatchType] = useState('all');
  const [recentActivityDraftSearchInput, setRecentActivityDraftSearchInput] = useState('');
  const debouncedRecentActivityDraftSearch = useDebouncedValue(recentActivityDraftSearchInput, 300);
  const [recentActivityAppliedFromDate, setRecentActivityAppliedFromDate] = useState(defaultRecentActivityDateRange.from);
  const [recentActivityAppliedToDate, setRecentActivityAppliedToDate] = useState(defaultRecentActivityDateRange.to);
  const [recentActivityAppliedBatchType, setRecentActivityAppliedBatchType] = useState('all');
  const [recentActivityAppliedSearchQuery, setRecentActivityAppliedSearchQuery] = useState('');
  const [recentActivitySortState, setRecentActivitySortState] = useState<{ key: ProductInRecentActivitySortKey; dir: 'asc' | 'desc' }>({
    key: 'date',
    dir: 'desc',
  });
  const filterFieldClass = 'w-full h-11 border border-slate-300 rounded bg-white px-3 text-base sm:text-sm shadow-none';
  const topRowLayoutClass = isHandheldDevice
    ? 'grid grid-cols-1 gap-6 lg:gap-8 flex-shrink-0'
    : 'grid grid-cols-1 md:grid-cols-2 gap-6 lg:gap-8 flex-shrink-0';
  const activityFilterLayoutClass = isHandheldDevice
    ? 'grid grid-cols-1 gap-2'
    : 'grid grid-cols-1 md:grid-cols-2 gap-2';
  const [isProcessingBulkRelease, setIsProcessingBulkRelease] = useState(false);
  const createSeedRef = useRef<{ key: string; createdAt: string; timestamp: string } | null>(null);
  const releasedEditConfirmedRef = useRef(false);

  // Custom Modal State for Confirmation (bypass window.confirm sandbox restrictions)
  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    isDangerous: boolean;
    showCancel?: boolean;
    confirmLabel?: string;
    onConfirm: () => Promise<void> | void;
  } | null>(null);
  const [qcStatusModal, setQcStatusModal] = useState<{
    batch: ProductBatch;
    nextStatus: string;
    note: string;
    disposition: BatchQcDisposition;
    title: string;
    message: string;
    requireDisposition: boolean;
  } | null>(null);

  const openInfoModal = (message: string, title = 'Notice', isDangerous = false) => {
    setConfirmModal({
      isOpen: true,
      title,
      message,
      isDangerous,
      showCancel: false,
      confirmLabel: 'OK',
      onConfirm: () => setConfirmModal(null)
    });
  };

  const groupedProducts = useMemo(() => {
    const groups: Record<string, Product[]> = {};
    products.forEach(p => {
      if (p.category?.toLowerCase().includes('archived')) return;
      
      const family = p.family || 'Other';
      if (!groups[family]) groups[family] = [];
      groups[family].push(p);
    });
    return Object.entries(groups).map(([name, items]) => ({
      name,
      items: items.sort(compareProductsByInventoryTypeOrder)
    })).sort((a,b) => a.name.localeCompare(b.name));
  }, [products]);

  const selectedProduct = useMemo(() => 
    products.find(p => p.sku_id === prodIn.itemId), 
  [prodIn.itemId, products]);
  const isEditingDeclaration = Boolean(editingBatchId);
  const isEditingRecentActivity = Boolean(editingRecentActivityTxId);
  const isRecentActivitySyncing = Boolean(recentActivitySyncState);
  const editingBatch = useMemo(
    () =>
      editingBatchId
        ? productBatches.find(
            (batch) =>
              normalizeIdentityKey(resolveProductBatchIdentity(batch)) === normalizeIdentityKey(editingBatchId)
          ) || null
        : null,
    [editingBatchId, productBatches]
  );

  const defaultBatchTypeBySku = useMemo(() => {
    const bySku: Record<string, { batchType: ProductInBatchType; ts: number }> = {};
    productBatches.forEach((batch) => {
      const sku = normalizeIdentityKey(batch.sku_id);
      if (!sku) return;
      const normalizedType = normalizeBatchType((batch as any).batchType, 'TERMINAL');
      const hasExplicitType = ['BULK', 'PACK', 'TERMINAL', 'STANDALONE'].includes(String((batch as any).batchType || '').trim().toUpperCase());
      if (!hasExplicitType) return;
      const ts = resolveBatchRecordTimestamp(batch);
      const previous = bySku[sku];
      if (!previous || ts >= previous.ts) {
        bySku[sku] = { batchType: normalizedType, ts };
      }
    });
    const resolved: Record<string, ProductInBatchType> = {};
    Object.entries(bySku).forEach(([sku, value]) => {
      resolved[sku] = value.batchType;
    });
    return resolved;
  }, [productBatches]);

  const resetCreateSeed = () => {
    createSeedRef.current = null;
  };

  const getCreateSeed = (key: string) => {
    if (createSeedRef.current && createSeedRef.current.key === key) {
      return createSeedRef.current;
    }
    const createdAtDate = new Date();
    const next = {
      key,
      createdAt: createdAtDate.toISOString(),
      timestamp: formatBatchTimestamp(createdAtDate)
    };
    createSeedRef.current = next;
    return next;
  };

  const defaultUnitCostFromMaster = useMemo(
    () => parseUnitCostValue(selectedProduct?.unitProductionCost),
    [selectedProduct?.unitProductionCost]
  );

  const isBottleProduct = useMemo(
    () => isBottleSku(selectedProduct),
    [selectedProduct]
  );

  const generatedPrintedBatchNumber = useMemo(() => {
    if (!prodIn.itemId) return '';
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yy = String(now.getFullYear() % 100).padStart(2, '0');

    const usedControls = productBatches
      .filter(b => b.sku_id === prodIn.itemId)
      .map(b => (b.batch_number || '').trim())
      .map((batch) => {
        const match = batch.match(new RegExp(`^${dd}\\s${yy}(\\d{2})\\s${mm}$`));
        return match ? Number(match[1]) : 0;
      });

    const nextControl = String((Math.max(0, ...usedControls) + 1) % 100).padStart(2, '0');
    return `${dd} ${yy}${nextControl} ${mm}`;
  }, [prodIn.itemId, productBatches, selectedProduct?.sku_id]);

  useEffect(() => {
    if (!prodIn.itemId) {
      setIsGeneratingBottleBatch(false);
      return;
    }

    if (isBottleProduct) {
      if (isEditingDeclaration || isBottleBatchForSku(prodIn.batchNumber, prodIn.itemId)) {
        setIsGeneratingBottleBatch(false);
        return;
      }

      let cancelled = false;
      const activeSku = prodIn.itemId;
      setIsGeneratingBottleBatch(true);

      generateBottleBatchId(activeSku, new Date())
        .then((batchId) => {
          if (cancelled) return;
          setProdIn((prev) => {
            if (prev.itemId !== activeSku) return prev;
            if (prev.batchNumber === batchId) return prev;
            resetCreateSeed();
            return { ...prev, batchNumber: batchId };
          });
          setIsBatchManuallyEdited(false);
        })
        .catch((error) => {
          if (cancelled) return;
          console.error(error);
          openInfoModal('Failed to generate bottle batch ID.', 'Error', true);
        })
        .finally(() => {
          if (!cancelled) setIsGeneratingBottleBatch(false);
        });

      return () => {
        cancelled = true;
      };
    }

    setIsGeneratingBottleBatch(false);
    if (isEditingDeclaration && String(prodIn.batchNumber || '').trim()) return;
    if (!generatedPrintedBatchNumber || isBatchManuallyEdited) return;
    setProdIn(prev =>
      prev.batchNumber === generatedPrintedBatchNumber
        ? prev
        : (() => {
            resetCreateSeed();
            return { ...prev, batchNumber: generatedPrintedBatchNumber };
          })()
    );
  }, [prodIn.itemId, prodIn.batchNumber, generatedPrintedBatchNumber, isBatchManuallyEdited, isBottleProduct, isEditingDeclaration]);

  useEffect(() => {
    if (!prodIn.itemId || isUnitCostManuallyEdited) return;
    const nextDefault = formatUnitCostInput(defaultUnitCostFromMaster);
    setProdIn((prev) => {
      if (prev.itemId !== prodIn.itemId) return prev;
      if (prev.unitCost === nextDefault) return prev;
      return { ...prev, unitCost: nextDefault };
    });
  }, [prodIn.itemId, defaultUnitCostFromMaster, isUnitCostManuallyEdited]);

  const findBulkByBatchNumber = (batchNumber: string): ProductBatch | null => {
    const normalizedBatchNumber = normalizeIdentityKey(batchNumber);
    if (!normalizedBatchNumber) return null;

    const matches = productBatches.filter((batch) => {
      const identity = resolveProductBatchIdentity(batch);
      const rowBatchType = String((batch as any).batchType || '').trim().toUpperCase();
      return (
        rowBatchType === 'BULK' &&
        Boolean(identity) &&
        normalizeIdentityKey(batch.batch_number) === normalizedBatchNumber
      );
    });

    return matches.length === 1 ? matches[0] : null;
  };

  const quarantineBatches = useMemo(() => {
      return productBatches.filter(b => {
          const status = normalizeStatus(b.status);
          const disposition = normalizeQcDisposition((b as any).qcDisposition);
          // Strict filtering to ensure released, archived, and terminal final-rejected items exit the active queue.
          return (
            status !== 'released' &&
            status !== 'archived' &&
            status !== 'released_to_stock' &&
            !(status === 'qc_rejected' && disposition === 'final_rejected')
          );
      });
  }, [productBatches]);
  const releasableBatches = useMemo(
      () => quarantineBatches.filter((batch) => normalizeStatus(batch.status) === 'qc_passed'),
      [quarantineBatches]
  );

  const productNameById = useMemo(() => {
      const byId: Record<string, string> = {};
      products.forEach((p) => {
          byId[p.sku_id] = formatFinishedProductInventoryLabel(p);
      });
      return byId;
  }, [products]);

  const recentActivityRows = useMemo<ProductInRecentActivityRow[]>(() => {
      return productBatches
        .filter((batch) => {
          const status = normalizeStatus(batch.status);
          return status === 'qc_passed' || status === 'qc_rejected' || status === 'released';
        })
        .map((batch, stableIndex) => {
          const batchId = resolveProductBatchIdentity(batch);
          const tx = findProductReleaseTxn(transactions, batch.sku_id, batchId);
          const eventDate = tx
            ? resolveLedgerEventTime(tx)
            : String((batch as any).updatedAt || batch.date_produced || (batch as any).createdAt || '');
          const eventTimestamp = new Date(eventDate).getTime();
          const productForFallback = products.find(p => p.sku_id === batch.sku_id);
          const rawBatchType = String(
            (batch as any)?.batchType ||
            (isBottleBatchForSku(batchId, batch.sku_id) ? inferDefaultBatchType(productForFallback) : '')
          ).trim().toUpperCase();
          const normalizedBatchType =
            rawBatchType === 'BULK' || rawBatchType === 'PACK' || rawBatchType === 'TERMINAL'
              ? rawBatchType
              : rawBatchType === 'STANDALONE'
                ? 'TERMINAL'
                : '';
          const batchQty = Number(batch.actualYield ?? batch.plannedQuantity ?? batch.qty_remaining ?? 0) || 0;
          const ledgerQty = tx ? (Number(tx.quantity) || 0) : null;
          const qty = ledgerQty ?? batchQty;
          const unit = productForFallback?.default_unit || tx?.unit || 'kg';
          const quantityText = `${qty.toLocaleString()} ${unit}`.trim();
          const hasQuantityMismatch = ledgerQty !== null && Math.abs(ledgerQty - batchQty) > 0.000001;
          const disposition = normalizeQcDisposition((batch as any).qcDisposition);
          const isReconciledRelease = normalizeStatus(batch.status) === 'released' && disposition === 'reconciled_release';

          return {
              tx,
              batch,
              stableIndex,
              eventDate,
              eventDateOnly: getDateOnlyValue(eventDate),
              eventTimestamp: Number.isFinite(eventTimestamp) ? eventTimestamp : 0,
              productName: productNameById[batch.sku_id] || productForFallback?.sku_name || batch.sku_id || 'Unknown Product',
              batchNumber: batch.batch_number || '-',
              batchReference: batchId,
              batchType: normalizedBatchType,
              qtyDisplay: quantityText,
              batchQty,
              ledgerQty,
              hasQuantityMismatch,
              unitCost: parseUnitCostValue(batch.unit_cost) ?? parseUnitCostValue(tx?.unitCost) ?? 0,
              user: String(tx?.user || tx?.updatedBy || (batch as any).updatedBy || 'System'),
              notes: String((batch as any).qcNotes || tx?.notes || '').trim(),
              qcStatus: batch.status || 'On hold',
              qcDisposition: disposition,
              releaseKind: isReconciledRelease ? 'reconciled' : tx ? 'standard' : 'none',
          };
      });
  }, [productNameById, productBatches, products, transactions]);

  const recentActivityBatchTypeOptions = useMemo(() => {
      const options = new Set<string>();
      productBatches.forEach((batch) => {
          const rawBatchType = String((batch as any).batchType || '').trim().toUpperCase();
          if (rawBatchType) options.add(rawBatchType);
      });
      recentActivityRows.forEach((row) => {
          if (row.batchType) options.add(row.batchType);
      });
      return Array.from(options).sort((a, b) => a.localeCompare(b));
  }, [productBatches, recentActivityRows]);

  const filteredRecentActivity = useMemo(() => {
      return recentActivityRows.filter((row) => {
          if (recentActivityAppliedFromDate && (!row.eventDateOnly || row.eventDateOnly < recentActivityAppliedFromDate)) return false;
          if (recentActivityAppliedToDate && (!row.eventDateOnly || row.eventDateOnly > recentActivityAppliedToDate)) return false;
          if (recentActivityAppliedBatchType !== 'all' && row.batchType !== recentActivityAppliedBatchType) return false;
          return matchesSearch(
            [
              row.productName,
              row.batchNumber,
              row.batchReference,
              row.batchType,
              row.user,
              row.notes,
              row.qtyDisplay,
              row.qcStatus,
              formatQcDispositionLabel(row.qcDisposition),
            ],
            recentActivityAppliedSearchQuery
          );
      });
  }, [
    recentActivityRows,
    recentActivityAppliedFromDate,
    recentActivityAppliedToDate,
    recentActivityAppliedBatchType,
    recentActivityAppliedSearchQuery,
  ]);

  const sortedRecentActivity = useMemo(() => {
      const compareText = (left: string, right: string): number =>
          String(left || '').localeCompare(String(right || ''), undefined, { sensitivity: 'base' });
      const compareNumber = (left: number, right: number): number => left - right;

      const indexed = filteredRecentActivity.map((row) => row);
      indexed.sort((left, right) => {
          let base = 0;
          switch (recentActivitySortState.key) {
            case 'date':
              base = compareNumber(left.eventTimestamp, right.eventTimestamp);
              break;
            case 'product':
              base = compareText(left.productName, right.productName);
              break;
            case 'batchNumber':
              base = compareText(left.batchNumber, right.batchNumber);
              break;
            case 'batchType':
              base = compareText(left.batchType, right.batchType);
              break;
            case 'qty':
              base = compareNumber(
                left.ledgerQty ?? left.batchQty,
                right.ledgerQty ?? right.batchQty
              );
              break;
            case 'unitProductionCost':
              base = compareNumber(left.unitCost, right.unitCost);
              break;
            case 'user':
              base = compareText(left.user, right.user);
              break;
            default:
              base = compareNumber(left.eventTimestamp, right.eventTimestamp);
              break;
          }
          if (base === 0) return left.stableIndex - right.stableIndex;
          return recentActivitySortState.dir === 'asc' ? base : -base;
      });
      return indexed;
  }, [filteredRecentActivity, recentActivitySortState]);

  const unitCostHistory = useMemo(() => {
    const normalizedSku = normalizeIdentityKey(prodIn.itemId);
    if (!normalizedSku) return [];

    const history = transactions
      .filter((tx) =>
        tx.category === 'PRODUCT' &&
        tx.type === 'IN' &&
        normalizeIdentityKey(tx.itemId) === normalizedSku
      )
      .sort((a, b) => new Date(resolveLedgerEventTime(b)).getTime() - new Date(resolveLedgerEventTime(a)).getTime())
      .map((tx) => {
        const directCost = parseUnitCostValue(tx.unitCost);
        if (directCost !== null) return directCost;
        try {
          const relatedBatch = resolveBatchRecordByLedgerReference(
            productBatches,
            tx.itemId,
            String(tx.batchNumber || '')
          );
          return parseUnitCostValue(relatedBatch?.unit_cost);
        } catch {
          return null;
        }
      })
      .filter((cost): cost is number => cost !== null);

    const seen = new Set<string>();
    return history.filter((cost) => {
      const key = Number(cost.toFixed(6)).toString();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [prodIn.itemId, transactions, productBatches]);

  const isUnitCostLookupPending = useMemo(
    () => Boolean(prodIn.itemId) && products.length === 0,
    [prodIn.itemId, products.length]
  );

  const handleBlur = (field: string) => {
    setTouched(prev => ({ ...prev, [field]: true }));
  };

  const errors = useMemo(() => {
    const errs: Record<string, string> = {};
    if (!prodIn.itemId) errs.itemId = "Required";
    if (!prodIn.batchNumber) errs.batchNumber = "Required";
    if (!prodIn.quantity || Number(prodIn.quantity) <= 0) errs.quantity = "Invalid quantity";
    const nextStatus = normalizeStatus(prodIn.qcStatus);
    const previousStatus = normalizeStatus(editingBatch?.status);
    const note = String(prodIn.qcNotes || '').trim();
    if (nextStatus === 'qc_rejected' && !note) errs.qcNotes = "QC note required";
    if (previousStatus === 'qc_rejected' && nextStatus === 'qc_passed' && !note) {
      errs.qcNotes = "Reconciliation note required";
    }
    return errs;
  }, [prodIn, editingBatch?.status]);

  const handleSubmit = async () => {
    if (isReadOnly) return;
    if (isEditingDeclaration && !onUpdateBatch && !onRenameBatchReference && !onEditProductInActivity) {
      openInfoModal('Update capability is unavailable.', 'Error', true);
      return;
    }
    setTouched({ itemId: true, batchNumber: true, quantity: true, qcNotes: true });
    if (Object.keys(errors).length > 0) return;
    if (
      isEditingDeclaration &&
      editingBatch &&
      isReleasedStatus(editingBatch.status) &&
      normalizeStatus(prodIn.qcStatus) !== 'released' &&
      !releasedEditConfirmedRef.current
    ) {
      setConfirmModal({
        isOpen: true,
        title: 'Confirm Released Batch Change',
        message: `Changing Batch ${editingBatch.batch_number} away from Released will remove its QC Release ledger row and reduce stock. Continue?`,
        isDangerous: true,
        confirmLabel: 'Continue',
        onConfirm: () => {
          releasedEditConfirmedRef.current = true;
          setConfirmModal(null);
          void handleSubmit();
        }
      });
      return;
    }

    const userBatchNumber = String(prodIn.batchNumber || '').trim();
    const batchNumberForMaster = isBottleProduct
      ? resolveBottleDeclarationDisplay(userBatchNumber)
      : userBatchNumber;
    const canonicalBaseBatchId = buildStandardBatchId(prodIn.itemId, batchNumberForMaster);
    const batchType = prodIn.batchType as ProductInBatchType;

    const isDuplicateBulk = batchType === 'BULK' && productBatches.some((batch) => {
      const identity = resolveProductBatchIdentity(batch);
      if (
        isEditingDeclaration &&
        normalizeIdentityKey(identity) === normalizeIdentityKey(editingBatchId)
      ) {
        return false;
      }
      return normalizeIdentityKey(identity) === normalizeIdentityKey(canonicalBaseBatchId);
    });
    if (isDuplicateBulk) {
      openInfoModal(
        'Bulk batch already exists for this SKU and batch number. Bulk batches must be unique.',
        'Duplicate BULK batch',
        true
      );
      return;
    }

    let parentBulkBatchId = '';
    if (batchType === 'PACK') {
      const normalizedBatchNumber = normalizeIdentityKey(batchNumberForMaster);
      const bulkMatches = productBatches.filter((batch) => {
        const rowBatchType = String((batch as any).batchType || '').trim().toUpperCase();
        return (
          rowBatchType === 'BULK' &&
          normalizeIdentityKey(batch.batch_number) === normalizedBatchNumber
        );
      });

      if (bulkMatches.length === 0) {
        openInfoModal(
          'No BULK batch found for this batch number. Please create the BULK batch first.',
          'Missing BULK parent',
          true
        );
        return;
      }
      if (bulkMatches.length > 1) {
        openInfoModal(
          'Multiple BULK batches found for this batch number. Please resolve duplicates.',
          'Data inconsistency',
          true
        );
        return;
      }

      const parentBulk = findBulkByBatchNumber(batchNumberForMaster);
      const parentIdentity = resolveProductBatchIdentity(parentBulk);
      if (!parentIdentity) {
        openInfoModal(
          'No BULK batch found for this batch number. Please create the BULK batch first.',
          'Missing BULK parent',
          true
        );
        return;
      }
      parentBulkBatchId = parentIdentity;
    }

    const submissionKey = `${prodIn.itemId}::${batchNumberForMaster}::${batchType}`;
    const createSeed = getCreateSeed(submissionKey);
    const batchId = batchType === 'BULK'
      ? canonicalBaseBatchId
      : makeTimestampedBatchId(prodIn.itemId, batchNumberForMaster, createSeed.timestamp);

    const submittedUnitCost = parseUnitCostValue(prodIn.unitCost);
    const declaredQuantity = Number(prodIn.quantity);
    const finalUnitCost =
      submittedUnitCost ??
      defaultUnitCostFromMaster ??
      0;
    const nextQcStatus = prodIn.qcStatus as BatchRecord['status'];
    const nextQcDisposition =
      normalizeStatus(editingBatch?.status) === 'qc_rejected' && normalizeStatus(nextQcStatus) === 'qc_passed'
        ? 'reconciled_release'
        : getDefaultDispositionForStatus(nextQcStatus, prodIn.qcDisposition);

    if (
      isEditingDeclaration &&
      editingBatch &&
      normalizeIdentityKey(editingBatch.sku_id) !== normalizeIdentityKey(prodIn.itemId)
    ) {
      openInfoModal(
        'Changing the product SKU for an existing batch is not supported here. Please create a new batch instead.',
        'SKU change blocked',
        true
      );
      return;
    }

    const nextBatchId =
      isEditingDeclaration && editingBatchId
        ? deriveEditedBatchId(editingBatchId, prodIn.itemId, batchNumberForMaster)
        : batchId;
    const selectedProductLabel = selectedProduct
      ? formatFinishedProductInventoryLabel(selectedProduct)
      : prodIn.itemId;

    const batchPayload = ({
      id: nextBatchId,
      batch_id: nextBatchId,
      batch_number: batchNumberForMaster,
      productSku: prodIn.itemId,
      productName: selectedProductLabel,
      location: prodIn.location,
      plannedQuantity: declaredQuantity,
      actualYield: declaredQuantity,
      unitProductionCost: finalUnitCost,
      status: nextQcStatus,
      qcNotes: String(prodIn.qcNotes || '').trim(),
      qcDisposition: nextQcDisposition,
      batchType,
      parentBulkBatchId: batchType === 'PACK' ? parentBulkBatchId : ''
    } as any);

    const resetForm = () => {
      resetCreateSeed();
      setEditingBatchId(null);
      setEditingRecentActivityTxId(null);
      setProdIn({ ...initialProdInState });
      setIsBatchManuallyEdited(false);
      setIsUnitCostManuallyEdited(false);
      setTouched({});
    };

    setIsSubmitting(true);
    try {
      if (isEditingDeclaration && editingBatchId) {
        if (editingBatch && isReleasedStatus(editingBatch.status) && normalizeStatus(nextQcStatus) !== 'released') {
          const releaseTxn = findProductReleaseTxn(transactions, editingBatch.sku_id, editingBatchId);
          if (releaseTxn && !onDeleteTransaction) {
            throw new Error('Cannot change a released batch because the release ledger row cannot be removed.');
          }
          if (releaseTxn && onDeleteTransaction) {
            await onDeleteTransaction(releaseTxn.id);
          }
        }
        if (isEditingRecentActivity && editingRecentActivityTxId) {
          if (!onEditProductInActivity) {
            openInfoModal('Recent activity edit capability is unavailable.', 'Error', true);
            return;
          }
          setRecentActivitySyncState({ txId: editingRecentActivityTxId, mode: 'edit' });
          await onEditProductInActivity({
            transactionId: editingRecentActivityTxId,
            originalBatchId: editingBatchId,
            nextBatchId,
            batch: batchPayload,
            ledgerUpdates: {
              itemId: prodIn.itemId,
              itemName: selectedProductLabel,
              quantity: declaredQuantity,
              unit: prodIn.unit || selectedProduct?.default_unit || 'kg',
              location: prodIn.location,
              unitCost: finalUnitCost,
            },
            user: currentUser,
          });
        } else if (!normalizeIdentityKey(nextBatchId) || normalizeIdentityKey(nextBatchId) === normalizeIdentityKey(editingBatchId)) {
          if (onUpdateBatch) {
            await onUpdateBatch(batchPayload);
          } else if (onRenameBatchReference) {
            await onRenameBatchReference(editingBatchId, editingBatchId, batchPayload, currentUser);
          } else {
            openInfoModal('Update capability is unavailable.', 'Error', true);
            return;
          }
        } else {
          if (!onRenameBatchReference) {
            openInfoModal('Batch rename capability is unavailable.', 'Error', true);
            return;
          }
          await onRenameBatchReference(editingBatchId, nextBatchId, batchPayload, currentUser);
        }
      } else {
        await onCreateBatch(({
          id: batchId,
          batch_id: batchId,
          batch_number: batchNumberForMaster,
          productSku: prodIn.itemId,
          productName: selectedProductLabel,
          location: prodIn.location,
          plannedQuantity: declaredQuantity,
          actualYield: declaredQuantity,
          unitProductionCost: finalUnitCost,
          status: nextQcStatus,
          qcNotes: String(prodIn.qcNotes || '').trim(),
          qcDisposition: nextQcDisposition,
          createdAt: createSeed.createdAt,
          batchType,
          ...(batchType === 'PACK' ? { parentBulkBatchId } : {})
        } as any));
      }
      resetForm();
      releasedEditConfirmedRef.current = false;
    } catch (e: any) {
      console.error(e);
      const reason = e?.message ? `\n\n${String(e.message)}` : '';
      openInfoModal(`Failed to save declaration.${reason}`, 'Error', true);
    } finally {
      setRecentActivitySyncState(null);
      setIsSubmitting(false);
      releasedEditConfirmedRef.current = false;
    }
  };

  const commitBatchStatusChange = async (
    batch: ProductBatch,
    newStatus: string,
    options: { note?: string; disposition?: BatchQcDisposition } = {}
  ) => {
      if (isReadOnly || !onUpdateBatch) return;
      const batchId = resolveProductBatchIdentity(batch);
      setProcessingBatchId(batchId || batch.id);
      try {
          const product = products.find(p => p.sku_id === batch.sku_id);
          if (isReleasedStatus(batch.status) && normalizeStatus(newStatus) !== 'released') {
              const releaseTxn = findProductReleaseTxn(transactions, batch.sku_id, batchId);
              if (releaseTxn && !onDeleteTransaction) {
                  throw new Error('Cannot change a released batch because the release ledger row cannot be removed.');
              }
              if (releaseTxn && onDeleteTransaction) {
                  await onDeleteTransaction(releaseTxn.id);
              }
          }
          const nextDisposition =
            options.disposition ||
            getDefaultDispositionForStatus(newStatus, (batch as any).qcDisposition);
          await onUpdateBatch(({
              id: batchId,
              batch_id: batchId,
              productSku: batch.sku_id,
              productName: product ? formatFinishedProductInventoryLabel(product) : batch.sku_id,
              location: batch.location,
              unitProductionCost: batch.unit_cost,
              status: newStatus as any,
              qcNotes: options.note !== undefined ? options.note : String((batch as any).qcNotes || ''),
              qcDisposition: nextDisposition
          } as any));
      } catch (e) { console.error(e); openInfoModal("Status update failed.", 'Error', true); }
      finally { setProcessingBatchId(null); }
  };

  const openQcStatusModal = (batch: ProductBatch, nextStatus: string) => {
      const currentStatus = normalizeStatus(batch.status);
      const normalizedNext = normalizeStatus(nextStatus);
      const isReconciledPass = currentStatus === 'qc_rejected' && normalizedNext === 'qc_passed';
      const isRejected = normalizedNext === 'qc_rejected';
      setQcStatusModal({
          batch,
          nextStatus,
          note: String((batch as any).qcNotes || ''),
          disposition: isRejected
            ? getDefaultDispositionForStatus(nextStatus, (batch as any).qcDisposition)
            : isReconciledPass
              ? 'reconciled_release'
              : getDefaultDispositionForStatus(nextStatus, (batch as any).qcDisposition),
          title: isReconciledPass ? 'Reconciliation Note Required' : 'QC Rejection Note Required',
          message: isReconciledPass
            ? 'Add the note explaining why this rejected batch can now pass QC.'
            : 'Add the QC note and choose whether this rejection is final or still recoverable.',
          requireDisposition: isRejected,
      });
  };

  const handleStatusChange = async (batch: ProductBatch, newStatus: string) => {
      if (isReadOnly || !onUpdateBatch) return;
      const currentStatus = normalizeStatus(batch.status);
      const nextStatus = normalizeStatus(newStatus);
      const runChange = () => {
          if (nextStatus === 'qc_rejected' || (currentStatus === 'qc_rejected' && nextStatus === 'qc_passed')) {
              openQcStatusModal(batch, newStatus);
              return;
          }
          void commitBatchStatusChange(batch, newStatus, {
              disposition: nextStatus === 'on_hold' ? 'standard' : getDefaultDispositionForStatus(newStatus, (batch as any).qcDisposition)
          });
      };

      if (isReleasedStatus(batch.status) && nextStatus !== 'released') {
          setConfirmModal({
              isOpen: true,
              title: 'Confirm Released Batch Change',
              message: `Changing Batch ${batch.batch_number} away from Released will remove its QC Release ledger row and reduce stock. Continue?`,
              isDangerous: true,
              confirmLabel: 'Continue',
              onConfirm: () => {
                  setConfirmModal(null);
                  runChange();
              }
          });
          return;
      }

      runChange();
  };

  const releaseBatchToInventory = async (batch: ProductBatch): Promise<boolean> => {
      if (isReadOnly || !onReleaseBatch || !onTransaction) return false;
      const currentStatus = normalizeStatus(batch.status);
      if (currentStatus !== 'qc_passed') {
          openInfoModal("Only batches with status 'QC passed' can be released to inventory.", 'Release blocked', true);
          return false;
      }
      setProcessingBatchId(batch.id);
      try {
          const item = products.find(p => p.sku_id === batch.sku_id);
          const qty = batch.actualYield || batch.plannedQuantity || 0;
          const batchId = resolveProductBatchIdentity(batch);
          const existingReleaseTxn = findProductReleaseTxn(transactions, batch.sku_id, batchId);
          let createdReleaseTxnId = '';
          try {
              if (!existingReleaseTxn) {
                  const releasedUnitCost = parseUnitCostValue(batch.unit_cost) ?? 0;
                  const createdReleaseTxn = await onTransaction({
                      type: 'IN',
	                      category: 'PRODUCT',
	                      itemId: batch.sku_id,
	                      itemName: item ? formatFinishedProductInventoryLabel(item) : batch.sku_id,
                      quantity: qty,
                      unit: item?.default_unit || 'kg',
                      unitCost: releasedUnitCost,
                      batchNumber: batchId,
                      location: batch.location,
                      reason: 'QC Release',
                      user: currentUser,
                      sourceTab: 'Product Reception'
                  });
                  createdReleaseTxnId = String((createdReleaseTxn as InventoryTransaction | undefined)?.id || '').trim();
              }

              await onReleaseBatch(({
                  id: batchId,
	                  batch_id: batchId,
	                  productSku: batch.sku_id,
	                  productName: item ? formatFinishedProductInventoryLabel(item) : batch.sku_id,
                  location: batch.location,
                  unitProductionCost: batch.unit_cost,
                  status: 'Released',
                  qcNotes: String((batch as any).qcNotes || ''),
                  qcDisposition: normalizeQcDisposition((batch as any).qcDisposition)
              } as any));
          } catch (releaseError) {
              if (createdReleaseTxnId && onDeleteTransaction) {
                  try {
                      await onDeleteTransaction(createdReleaseTxnId);
                  } catch (rollbackError: any) {
                      console.error("Ledger rollback after release failure also failed:", rollbackError);
                      const rollbackReason = rollbackError?.message ? `\n\nRollback reason: ${String(rollbackError.message)}` : '';
                      openInfoModal(
                        `The inventory ledger was saved for this batch, but the batch status update failed and the automatic ledger rollback did not complete. Please refresh and correct this record before continuing.${rollbackReason}`,
                        'Integrity warning',
                        true
                      );
                      return false;
                  }
              }
              throw releaseError;
          }
          return true;
      } catch (e: any) {
          console.error(e);
          const reason = e?.message ? `\n\nReason: ${String(e.message)}` : '';
          openInfoModal(`Release failed.${reason}`, 'Error', true);
          return false;
      } finally {
          setProcessingBatchId(null);
      }
  };

  const handleRelease = async (batch: ProductBatch, e?: React.MouseEvent) => {
      if (e) {
          e.stopPropagation();
          e.preventDefault();
      }
      
      if (isReadOnly || !onReleaseBatch || !onTransaction) return;
      const currentStatus = normalizeStatus(batch.status);
      if (currentStatus !== 'qc_passed') {
          openInfoModal("Only batches with status 'QC passed' can be released to inventory.", 'Release blocked', true);
          return;
      }
      
      setConfirmModal({
        isOpen: true,
        title: "Confirm Release",
        message: `Release Batch ${batch.batch_number} to active inventory? This will add stock to the ledger.`,
        isDangerous: false,
        onConfirm: async () => {
            setConfirmModal(null);
            await releaseBatchToInventory(batch);
        }
      });
  };

  const handleReleaseAll = async () => {
      if (isReadOnly || releasableBatches.length === 0 || isProcessingBulkRelease || Boolean(processingBatchId)) return;
      setConfirmModal({
        isOpen: true,
        title: "Confirm Bulk Release",
        message: `Are you sure you want to release all ${releasableBatches.length} items?`,
        isDangerous: false,
        confirmLabel: 'Confirm',
        onConfirm: async () => {
          setConfirmModal(null);
          setIsProcessingBulkRelease(true);
          try {
              for (const batch of releasableBatches) {
                  const didRelease = await releaseBatchToInventory(batch);
                  if (!didRelease) break;
              }
          } finally {
              setIsProcessingBulkRelease(false);
          }
        }
      });
  };

  const handleDelete = async (batch: ProductBatch, e?: React.MouseEvent) => {
      if (e) {
          e.stopPropagation();
          e.preventDefault();
      }

      if (isReadOnly) return;

      if (!onDeleteBatch) {
          openInfoModal("Error: Delete capability is not available (function missing).", 'Error', true);
          return;
      }
      
      setConfirmModal({
        isOpen: true,
        title: "Confirm Deletion",
        message: `Are you sure you want to PERMANENTLY DELETE Batch ${batch.batch_number} from the system? This action cannot be undone.`,
        isDangerous: true,
        onConfirm: async () => {
            setConfirmModal(null);
            setProcessingBatchId(batch.id);
            try {
                await onDeleteBatch(batch.id);
            } catch (err) { 
                console.error("Delete handler error:", err); 
                openInfoModal("Delete operation encountered an error.", 'Error', true);
            } finally { 
                setProcessingBatchId(null); 
            }
        }
      });
  };

  const loadForEdit = (batch: ProductBatch) => {
      if (isReadOnly) return;
      setEditingBatchId(resolveProductBatchIdentity(batch) || batch.id);
      setEditingRecentActivityTxId(null);
      setIsBatchManuallyEdited(true);
      setIsUnitCostManuallyEdited(true);
      resetCreateSeed();
      const fallbackType = inferDefaultBatchType(products.find(p => p.sku_id === batch.sku_id));
      setProdIn({
          itemId: batch.sku_id,
          batchType: normalizeBatchType((batch as any).batchType, fallbackType),
          batchNumber: batch.batch_number,
          quantity: (batch.actualYield || batch.plannedQuantity || 0).toString(),
          location: batch.location,
          reason: 'Production Output',
          unit: '',
          unitCost: batch.unit_cost.toString(),
          qcStatus: batch.status || 'On hold',
          qcNotes: String((batch as any).qcNotes || ''),
          qcDisposition: normalizeQcDisposition((batch as any).qcDisposition)
      });
  };

  const loadBatchActivityForEdit = (batch: ProductBatch) => {
      loadForEdit(batch);
      setEditingRecentActivityTxId(null);
      window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // --- RECENT ACTIVITY ACTIONS ---
  const handleEditTx = (tx: InventoryTransaction) => {
      if (isReadOnly) return;
      let productBatchInfo: ProductBatch | null = null;
      try {
        productBatchInfo = resolveBatchRecordByLedgerReference(
          productBatches,
          tx.itemId,
          String(tx.batchNumber || '')
        );
      } catch (error) {
        console.error(error);
        openInfoModal('Legacy batch reference cannot be uniquely resolved.', 'Error', true);
        return;
      }

      const parsed = parseBatchId(String(tx.batchNumber || ''));
      if (!productBatchInfo) {
        openInfoModal('No matching batch record found in batches_master for this transaction.', 'Cannot edit', true);
        return;
      }
      const batchIdentity = resolveProductBatchIdentity(productBatchInfo);
      if (!batchIdentity) {
        openInfoModal('Batch record is missing a valid batch ID.', 'Cannot edit', true);
        return;
      }
      const editableBatchNumber =
        productBatchInfo?.batch_number ||
        extractEditableBatchNumber(String(tx.batchNumber || ''), String(tx.batchNumber || ''));
      setEditingBatchId(batchIdentity);
      setEditingRecentActivityTxId(tx.id);
      resetCreateSeed();
      const fallbackType = inferDefaultBatchType(products.find(p => p.sku_id === tx.itemId));
      setProdIn({
          itemId: tx.itemId,
          batchType: normalizeBatchType((productBatchInfo as any)?.batchType, fallbackType),
          batchNumber: editableBatchNumber,
          quantity: tx.quantity.toString(),
          location: tx.location,
          reason: tx.reason || 'Production Output',
          unit: tx.unit,
          unitCost: (productBatchInfo?.unit_cost || 0).toString(),
          qcStatus: productBatchInfo?.status || 'On hold',
          qcNotes: String((productBatchInfo as any)?.qcNotes || ''),
          qcDisposition: normalizeQcDisposition((productBatchInfo as any)?.qcDisposition)
      });
      setIsBatchManuallyEdited(parsed.type !== 'DISPENSING');
      setIsUnitCostManuallyEdited(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleDeleteTx = (tx: InventoryTransaction) => {
      if (isReadOnly || (!onDeleteProductInActivity && !onDeleteTransaction)) return;
      setConfirmModal({
          isOpen: true,
          title: "Delete Ledger Entry",
          message: `Are you sure you want to delete this transaction for ${tx.itemName || tx.itemId}? This will reduce recorded stock.`,
          isDangerous: true,
          onConfirm: async () => {
              setConfirmModal(null);
              try {
                  let linkedBatch: ProductBatch | null = null;
                  try {
                    linkedBatch = resolveBatchRecordByLedgerReference(
                      productBatches,
                      tx.itemId,
                      String(tx.batchNumber || '')
                    );
                  } catch (error) {
                    console.error(error);
                  }

                  if (onDeleteProductInActivity) {
                    setRecentActivitySyncState({ txId: tx.id, mode: 'delete' });
                    await onDeleteProductInActivity(tx, linkedBatch);
                  } else if (onDeleteTransaction) {
                    setRecentActivitySyncState({ txId: tx.id, mode: 'delete' });
                    await onDeleteTransaction(tx.id);
                  }
              } catch (e) {
                  console.error(e);
                  openInfoModal("Delete failed.", 'Error', true);
              } finally {
                  setRecentActivitySyncState(null);
              }
          }
      });
  };

  const applyRecentActivityFilters = () => {
      setRecentActivityAppliedFromDate(recentActivityDraftFromDate);
      setRecentActivityAppliedToDate(recentActivityDraftToDate);
      setRecentActivityAppliedBatchType(recentActivityDraftBatchType);
      setRecentActivityAppliedSearchQuery(debouncedRecentActivityDraftSearch.trim());
  };

  const resetRecentActivityFilters = () => {
      setRecentActivityDraftFromDate(defaultRecentActivityDateRange.from);
      setRecentActivityDraftToDate(defaultRecentActivityDateRange.to);
      setRecentActivityDraftBatchType('all');
      setRecentActivityDraftSearchInput('');
      setRecentActivityAppliedFromDate(defaultRecentActivityDateRange.from);
      setRecentActivityAppliedToDate(defaultRecentActivityDateRange.to);
      setRecentActivityAppliedBatchType('all');
      setRecentActivityAppliedSearchQuery('');
      setRecentActivitySortState({ key: 'date', dir: 'desc' });
  };

  const handleRecentActivitySortChange = (sortKey: string, sortDir: 'asc' | 'desc') => {
      setRecentActivitySortState({ key: sortKey as ProductInRecentActivitySortKey, dir: sortDir });
  };

  const downloadRecentActivityCsv = () => {
      if (sortedRecentActivity.length === 0) return;
      const headers = ['Date', 'Product', 'Batch Number', 'Batch Type', 'Quantity', 'Unit Production Cost', 'QC Condition', 'QC Disposition', 'User', 'Notes'];
      const rows = sortedRecentActivity.map((row) => [
          formatBritishDateTime(row.eventDate),
          row.productName,
          row.batchNumber,
          row.batchType || '—',
          row.qtyDisplay,
          row.unitCost.toFixed(2),
          row.qcStatus || '—',
          formatQcDispositionLabel(row.qcDisposition),
          row.user || '—',
          row.notes || '—',
      ]);
      const csv = [headers.join(','), ...rows.map((line) => line.map(escapeCsv).join(','))].join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const fromSegment = getDateOnlyValue(recentActivityAppliedFromDate || defaultRecentActivityDateRange.from).replaceAll('-', '');
      const toSegment = getDateOnlyValue(recentActivityAppliedToDate || defaultRecentActivityDateRange.to).replaceAll('-', '');
      a.download = `product_in_from_${fromSegment}_to_${toSegment}.csv`;
      a.click();
      URL.revokeObjectURL(url);
  };

  const getBatchTypeBadgeClass = (batchType: string): string => {
      const normalized = String(batchType || '').trim().toUpperCase();
      if (normalized === 'BULK') return 'bg-indigo-50 text-indigo-700 border-indigo-200';
      if (normalized === 'PACK') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
      if (normalized === 'TERMINAL' || normalized === 'STANDALONE') return 'bg-amber-50 text-amber-700 border-amber-200';
      return 'bg-slate-100 text-slate-600 border-slate-200';
  };

  const getQcActivityClass = (row: ProductInRecentActivityRow): string => {
      const status = normalizeStatus(row.qcStatus);
      if (status === 'released' && row.qcDisposition === 'reconciled_release') return 'bg-purple-50/70 hover:bg-purple-50';
      if (status === 'released') return 'bg-green-50/60 hover:bg-green-50';
      if (status === 'qc_passed') return 'bg-emerald-50/50 hover:bg-emerald-50';
      if (status === 'qc_rejected' && row.qcDisposition === 'final_rejected') return 'bg-red-50/70 hover:bg-red-50';
      if (status === 'qc_rejected') return 'bg-amber-50/70 hover:bg-amber-50';
      return 'hover:bg-slate-50';
  };

  const getQcStatusBadgeClass = (row: ProductInRecentActivityRow): string => {
      const status = normalizeStatus(row.qcStatus);
      if (status === 'released' && row.qcDisposition === 'reconciled_release') return 'bg-purple-100 text-purple-700 border-purple-200';
      if (status === 'released') return 'bg-green-100 text-green-700 border-green-200';
      if (status === 'qc_passed') return 'bg-emerald-100 text-emerald-700 border-emerald-200';
      if (status === 'qc_rejected' && row.qcDisposition === 'final_rejected') return 'bg-red-100 text-red-700 border-red-200';
      if (status === 'qc_rejected') return 'bg-amber-100 text-amber-700 border-amber-200';
      return 'bg-slate-100 text-slate-600 border-slate-200';
  };

  return (
    <div className="space-y-8 animate-in fade-in relative h-full min-h-0 flex flex-col">
        {/* Custom Confirmation Modal */}
        {confirmModal && confirmModal.isOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 animate-in fade-in">
                <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6 border border-slate-200">
                    <div className={`flex items-center mb-4 ${confirmModal.isDangerous ? 'text-red-600' : 'text-green-600'}`}>
                        {confirmModal.isDangerous ? <AlertTriangle className="w-6 h-6 mr-3" /> : <CheckCircle className="w-6 h-6 mr-3" />}
                        <h3 className="text-lg font-bold">{confirmModal.title}</h3>
                    </div>
                    <p className="text-sm text-slate-600 mb-6 font-medium leading-relaxed">
                        {confirmModal.message}
                    </p>
                    <div className="flex justify-end gap-3">
                        {confirmModal.showCancel !== false && (
                            <button 
                                onClick={() => setConfirmModal(null)} 
                                className="px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-100 rounded-lg transition"
                            >
                                Cancel
                            </button>
                        )}
                        <button 
                            onClick={() => void confirmModal.onConfirm()}
                            disabled={!!processingBatchId || isProcessingBulkRelease}
                            className={`px-4 py-2 text-sm font-bold text-white rounded-lg shadow-sm transition flex items-center ${confirmModal.isDangerous ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700'}`}
                        >
                            {(processingBatchId || isProcessingBulkRelease) ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                            {confirmModal.confirmLabel || 'Confirm'}
                        </button>
                    </div>
                </div>
            </div>
        )}
        {qcStatusModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 animate-in fade-in">
                <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full p-6 border border-slate-200">
                    <div className="flex items-center mb-4 text-amber-700">
                        <AlertTriangle className="w-6 h-6 mr-3" />
                        <h3 className="text-lg font-bold">{qcStatusModal.title}</h3>
                    </div>
                    <p className="text-sm text-slate-600 mb-4 font-medium leading-relaxed">
                        {qcStatusModal.message}
                    </p>
                    {qcStatusModal.requireDisposition && (
                        <div className="mb-4">
                            <label className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Rejected Outcome</label>
                            <select
                                value={qcStatusModal.disposition}
                                onChange={(event) => setQcStatusModal(prev => prev ? { ...prev, disposition: event.target.value as BatchQcDisposition } : prev)}
                                className="w-full border-slate-300 rounded-lg text-sm shadow-sm py-2.5"
                            >
                                <option value="rework_pending">Needs reconciliation / rework pending</option>
                                <option value="final_rejected">Cannot be reconciled</option>
                            </select>
                        </div>
                    )}
                    <div>
                        <label className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">QC Note</label>
                        <textarea
                            value={qcStatusModal.note}
                            onChange={(event) => setQcStatusModal(prev => prev ? { ...prev, note: event.target.value } : prev)}
                            rows={4}
                            className="w-full border-slate-300 rounded-lg text-sm shadow-sm"
                            placeholder="Describe what happened to this batch..."
                        />
                    </div>
                    <div className="flex justify-end gap-3 mt-6">
                        <button
                            onClick={() => setQcStatusModal(null)}
                            className="px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-100 rounded-lg transition"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={() => {
                                const note = qcStatusModal.note.trim();
                                if (!note) {
                                    openInfoModal('QC note is required for this status change.', 'QC note required', true);
                                    return;
                                }
                                const payload = qcStatusModal;
                                setQcStatusModal(null);
                                void commitBatchStatusChange(payload.batch, payload.nextStatus, {
                                    note,
                                    disposition: payload.disposition,
                                });
                            }}
                            className="px-4 py-2 text-sm font-bold text-white rounded-lg shadow-sm transition flex items-center bg-amber-600 hover:bg-amber-700"
                        >
                            Save QC Update
                        </button>
                    </div>
                </div>
            </div>
        )}

        <div className={topRowLayoutClass}>
            
            {/* Left: Production Declaration */}
            <div className="bg-white p-4 sm:p-6 rounded-xl border border-slate-200 shadow-sm min-h-[20rem] md:h-[600px] flex flex-col overflow-hidden">
                <h3 className="font-bold text-slate-800 mb-6 flex items-center uppercase tracking-wider text-sm flex-shrink-0">
                    <Factory className="w-5 h-5 mr-2 text-indigo-600" /> Production Declaration
                </h3>

                <div className="space-y-5 flex-1 overflow-y-visible md:overflow-y-auto pr-0 md:pr-1">
                    <div>
                        <label className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Product</label>
                        <select 
                            className={`w-full border rounded-lg text-sm shadow-sm font-medium text-slate-700 py-2.5 ${touched.itemId && errors.itemId ? 'border-red-300 focus:ring-red-200' : 'border-slate-300 focus:ring-indigo-500'}`}
                            value={prodIn.itemId}
                            onChange={e => {
                                const nextItemId = e.target.value;
                                const nextProduct = products.find(p => p.sku_id === nextItemId);
                                const fallbackType = inferDefaultBatchType(nextProduct);
                                const historyType = defaultBatchTypeBySku[normalizeIdentityKey(nextItemId)];
                                const nextIsBottleProduct = isBottleSku(nextProduct);
                                setIsBatchManuallyEdited(false);
                                if (!nextItemId) setIsUnitCostManuallyEdited(false);
                                resetCreateSeed();
                                setProdIn(prev => ({
                                  ...prev,
                                  itemId: nextItemId,
                                  batchType: nextItemId ? (historyType || fallbackType) : 'TERMINAL',
                                  batchNumber: nextIsBottleProduct ? '' : prev.batchNumber,
                                  qcStatus: 'On hold',
                                  qcNotes: '',
                                  qcDisposition: 'standard'
                                }));
                            }}
                            onBlur={() => handleBlur('itemId')}
                            disabled={isReadOnly}
                        >
                            <option value="">-- Select Product --</option>
                            {groupedProducts.map(g => (
                                <optgroup key={g.name} label={g.name}>
                                    {g.items.map(p => (
                                        <option key={p.sku_id} value={p.sku_id}>
                                            {formatFinishedProductInventoryLabel(p)}
                                        </option>
                                    ))}
                                </optgroup>
                            ))}
                        </select>
                        {touched.itemId && errors.itemId && <p className="text-xs text-red-500 mt-1">{errors.itemId}</p>}
                    </div>

                    <div>
                        <label className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Batch Type</label>
                        <select
                            className="w-full border-slate-300 rounded-lg text-sm shadow-sm py-2.5"
                            value={prodIn.batchType}
                            onChange={e => {
                                resetCreateSeed();
                                setProdIn(prev => ({
                                  ...prev,
                                  batchType: normalizeBatchType(e.target.value, 'TERMINAL')
                                }));
                            }}
                            disabled={isReadOnly}
                        >
                            <option value="BULK">BULK</option>
                            <option value="PACK">PACK</option>
                            <option value="TERMINAL">Terminal</option>
                        </select>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Batch Number</label>
                            <input 
                                type="text"
                                className={`w-full border rounded-lg text-sm shadow-sm py-2.5 font-mono ${touched.batchNumber && errors.batchNumber ? 'border-red-300 focus:ring-red-200' : 'border-slate-300 focus:ring-indigo-500'}`}
                                placeholder="e.g. 23 1001 12"
                                value={isBottleProduct ? resolveBottleDeclarationDisplay(prodIn.batchNumber) : prodIn.batchNumber}
                                onChange={e => {
                                    if (isBottleProduct) return;
                                    setIsBatchManuallyEdited(true);
                                    resetCreateSeed();
                                    setProdIn({...prodIn, batchNumber: e.target.value});
                                }}
                                onBlur={() => handleBlur('batchNumber')}
                                disabled={isReadOnly || isBottleProduct || isGeneratingBottleBatch}
                            />
                            {isBottleProduct && (
                                <p className="text-[10px] text-slate-500 mt-1">Batch number auto-generated for bottle products.</p>
                            )}
                            {touched.batchNumber && errors.batchNumber && <p className="text-xs text-red-500 mt-1">{errors.batchNumber}</p>}
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Location</label>
                            <select 
                                className="w-full border-slate-300 rounded-lg text-sm shadow-sm py-2.5"
                                value={prodIn.location}
                                onChange={e => setProdIn({...prodIn, location: e.target.value as LocationName})}
                                disabled={isReadOnly}
                            >
                                <option value="Riverside">Riverside</option>
                                <option value="Hilltop">Hilltop</option>
                            </select>
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Quantity</label>
                            <div className="flex">
                                <input 
                                    type="number"
                                    className={`w-full border rounded-l-lg text-sm shadow-sm py-2.5 font-bold ${touched.quantity && errors.quantity ? 'border-red-300 focus:ring-red-200' : 'border-slate-300 focus:ring-indigo-500'}`}
                                placeholder="0.00"
                                value={prodIn.quantity}
                                onChange={e => setProdIn({...prodIn, quantity: e.target.value})}
                                onBlur={() => handleBlur('quantity')}
                                disabled={isReadOnly}
                            />
                                <span className="bg-slate-100 border border-l-0 border-slate-300 rounded-r-lg px-3 py-2 text-xs font-bold text-slate-500 flex items-center justify-center min-w-[3rem]">
                                    {selectedProduct?.default_unit || 'kg'}
                                </span>
                            </div>
                            {touched.quantity && errors.quantity && <p className="text-xs text-red-500 mt-1">{errors.quantity}</p>}
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Unit Cost (£)</label>
                            <input 
                                type="number"
                                className="w-full border-slate-300 rounded-lg text-sm shadow-sm py-2.5"
                                placeholder="0.00"
                                value={prodIn.unitCost}
                                onChange={e => {
                                    setIsUnitCostManuallyEdited(true);
                                    setProdIn({...prodIn, unitCost: e.target.value});
                                }}
                                disabled={isReadOnly}
                            />
                            {isUnitCostLookupPending && (
                                <p className="text-[10px] text-slate-500 mt-1">Loading default unit cost...</p>
                            )}
                            {prodIn.itemId && !isUnitCostLookupPending && (
                                <div className="mt-1.5">
                                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Unit Costs</p>
                                    {unitCostHistory.length === 0 ? (
                                        <p className="text-[10px] text-slate-400 mt-1">No unit cost history for this SKU.</p>
                                    ) : (
                                        <div className="mt-1 flex flex-wrap gap-1">
                                            {unitCostHistory.map((cost, index) => (
                                                <button
                                                    key={`${cost}-${index}`}
                                                    type="button"
                                                    onClick={() => {
                                                        if (isReadOnly) return;
                                                        setIsUnitCostManuallyEdited(true);
                                                        setProdIn((prev) => ({ ...prev, unitCost: cost.toString() }));
                                                    }}
                                                    disabled={isReadOnly}
                                                    className="text-[10px] font-mono px-2 py-0.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-60"
                                                >
                                                    £{cost.toFixed(2)}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">QC condition</label>
                            <select
                                className="w-full border-slate-300 rounded-lg text-sm shadow-sm py-2.5"
                                value={prodIn.qcStatus}
                                onChange={(event) => {
                                    const nextStatus = event.target.value;
                                    const nextDisposition =
                                      normalizeStatus(editingBatch?.status) === 'qc_rejected' && normalizeStatus(nextStatus) === 'qc_passed'
                                        ? 'reconciled_release'
                                        : getDefaultDispositionForStatus(nextStatus, prodIn.qcDisposition);
                                    setProdIn(prev => ({
                                      ...prev,
                                      qcStatus: nextStatus,
                                      qcDisposition: nextDisposition
                                    }));
                                }}
                                disabled={isReadOnly}
                            >
                                <option value="On hold">On hold</option>
                                <option value="QC_passed">QC passed</option>
                                <option value="QC_rejected">QC rejected</option>
                                {editingBatch && isReleasedStatus(editingBatch.status) && (
                                    <option value="Released">Released</option>
                                )}
                            </select>
                        </div>
                        {normalizeStatus(prodIn.qcStatus) === 'qc_rejected' && (
                            <div>
                                <label className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Rejected Outcome</label>
                                <select
                                    className="w-full border-slate-300 rounded-lg text-sm shadow-sm py-2.5"
                                    value={prodIn.qcDisposition}
                                    onChange={(event) => setProdIn(prev => ({ ...prev, qcDisposition: event.target.value as BatchQcDisposition }))}
                                    disabled={isReadOnly}
                                >
                                    <option value="rework_pending">Needs reconciliation / rework pending</option>
                                    <option value="final_rejected">Cannot be reconciled</option>
                                </select>
                            </div>
                        )}
                    </div>

                    <div>
                        <label className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">QC note</label>
                        <textarea
                            className={`w-full border rounded-lg text-sm shadow-sm ${touched.qcNotes && errors.qcNotes ? 'border-red-300 focus:ring-red-200' : 'border-slate-300 focus:ring-indigo-500'}`}
                            rows={3}
                            placeholder="Record rejection, reconciliation, or QC context..."
                            value={prodIn.qcNotes}
                            onChange={(event) => setProdIn(prev => ({ ...prev, qcNotes: event.target.value }))}
                            onBlur={() => handleBlur('qcNotes')}
                            disabled={isReadOnly}
                        />
                        {touched.qcNotes && errors.qcNotes && <p className="text-xs text-red-500 mt-1">{errors.qcNotes}</p>}
                    </div>

                    <button 
                        onClick={handleSubmit}
                        disabled={isSubmitting || isReadOnly || (isRecentActivitySyncing && !isEditingRecentActivity)}
                        className="w-full text-white py-3.5 rounded-lg font-bold shadow-md transition flex items-center justify-center disabled:opacity-50 mt-4 flex-shrink-0 bg-indigo-600 hover:bg-indigo-700"
                    >
                        {isSubmitting ? (
                            <><Loader2 className="w-5 h-5 mr-2 animate-spin" /> {isEditingRecentActivity ? 'Saving...' : 'Processing...'}</>
                        ) : isEditingDeclaration ? (
                            <><Edit className="w-5 h-5 mr-2" /> Update</>
                        ) : (
                            <><Plus className="w-5 h-5 mr-2" /> Declare Output</>
                        )}
                    </button>
                    {isEditingDeclaration && (
                        <button
                            type="button"
                            onClick={() => {
                                resetCreateSeed();
                                setEditingBatchId(null);
                                setEditingRecentActivityTxId(null);
                                setProdIn({ ...initialProdInState });
                                setIsBatchManuallyEdited(false);
                                setIsUnitCostManuallyEdited(false);
                                setTouched({});
                            }}
                            disabled={isSubmitting || isReadOnly}
                            className="w-full text-slate-600 py-2 rounded-lg font-bold border border-slate-300 transition flex items-center justify-center disabled:opacity-50 hover:bg-slate-50"
                        >
                            <X className="w-4 h-4 mr-2" /> Cancel Edit
                        </button>
                    )}
                </div>
            </div>

            {/* Right: Quarantine Box */}
            <div className="bg-white border border-orange-200 rounded-xl shadow-sm overflow-hidden flex flex-col min-h-[20rem] md:h-[600px]">
                <div className="bg-orange-50 px-4 sm:px-6 py-4 border-b border-orange-200 flex justify-between items-center gap-3 flex-shrink-0">
                    <h4 className="font-bold text-slate-800 mb-0 flex items-center uppercase tracking-wider text-sm">
                        <Lock className="w-4 h-4 mr-2 text-orange-600" /> Quarantine Box
                    </h4>
                    <span className="text-xs font-bold bg-white text-orange-600 px-3 py-1 rounded border border-orange-200">
                        {quarantineBatches.length} Pending
                    </span>
                </div>
                
                <div className="mobile-scroll-hint px-4 pt-3">Swipe sideways to manage quarantine status and actions.</div>
                <div className="mobile-table-region overflow-auto flex-1">
                    <table className="w-full min-w-[720px] md:min-w-full md:table-fixed text-sm text-left">
                        <colgroup>
                            <col className="md:w-[48%]" />
                            <col className="md:w-[28%]" />
                            <col className="md:w-[24%]" />
                        </colgroup>
                        <thead className="bg-white text-orange-400 font-bold uppercase text-[10px] tracking-wider border-b border-orange-100 sticky top-0 z-10">
                            <tr>
                                <th className="px-4 py-3 bg-orange-50/90 backdrop-blur-sm">Product Name</th>
                                <th className="px-4 py-3 bg-orange-50/90 backdrop-blur-sm">Status</th>
                                <th className="px-4 py-3 bg-orange-50/90 backdrop-blur-sm text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-orange-50 bg-orange-50/10">
                            {quarantineBatches.map(batch => {
                                const masterProd = products.find(p => p.sku_id === batch.sku_id);
                                const prodName = masterProd ? formatFinishedProductInventoryLabel(masterProd) : batch.sku_id || "Unknown Product";
                                const displayUnit = masterProd?.default_unit || 'kg';
                                const displayQty = batch.actualYield ?? batch.plannedQuantity ?? 0;
                                const isProcessing = processingBatchId === batch.id;
                                const normStatus = normalizeStatus(batch.status);
                                const isReady = normStatus === 'qc_passed';
                                
                                let statusClass = 'bg-orange-100 text-orange-700 border-orange-200';
                                if (normStatus === 'qc_passed') statusClass = 'bg-green-100 text-green-700 border-green-200';
                                else if (normStatus === 'qc_rejected') statusClass = 'bg-red-100 text-red-700 border-red-200';

                                return (
                                    <tr key={batch.id} className="hover:bg-orange-50/50 transition-colors">
                                        <td className="px-4 py-3 min-w-0">
                                            <div className="font-bold text-slate-700 md:truncate" title={prodName}>{prodName}</div>
                                            <div className="text-[10px] text-slate-400 font-mono flex items-center md:truncate" title={`${batch.batch_number} • ${displayQty}${displayUnit}`}>
                                                {batch.batch_number} • {displayQty}{displayUnit}
                                            </div>
                                        </td>
                                        <td className="px-3 md:px-4 py-3">
                                            {isReadOnly ? (
                                                <span className={`inline-flex w-full justify-center md:w-auto px-2 py-1 rounded-full text-[10px] font-bold uppercase border ${statusClass}`}>
                                                    {(batch.status || 'on hold').replace(/[\s_-]+/g, ' ')}
                                                </span>
                                            ) : (
                                                <select
                                                    className={`w-full min-w-[8.25rem] md:min-w-0 text-[10px] font-bold uppercase rounded-md border py-1 pl-2 pr-6 cursor-pointer focus:ring-2 focus:ring-indigo-500 outline-none ${statusClass}`}
                                                    value={batch.status || 'On hold'}
                                                    onChange={(e) => handleStatusChange(batch, e.target.value)}
                                                    disabled={isProcessing}
                                                >
                                                    <option value="On hold">On hold</option>
                                                    <option value="QC_passed">QC passed</option>
                                                    <option value="QC_rejected">QC rejected</option>
                                                </select>
                                            )}
                                        </td>
                                        <td className="px-3 md:px-4 py-3 text-right">
                                            <div className="flex justify-end gap-1 md:gap-0.5">
                                                <button 
                                                    onClick={(e) => handleDelete(batch, e)}
                                                    disabled={isProcessing || isReadOnly}
                                                    className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition" 
                                                    title="Delete Record"
                                                >
                                                    <Trash2 className="w-4 h-4" />
                                                </button>
                                                <button 
                                                    onClick={() => loadForEdit(batch)}
                                                    disabled={isProcessing || isReadOnly}
                                                    className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition" 
                                                    title="Edit"
                                                >
                                                    <Edit className="w-4 h-4" />
                                                </button>
                                                <button 
                                                    onClick={(e) => handleRelease(batch, e)}
                                                    disabled={!isReady || isProcessing || isReadOnly}
                                                    className={`p-1.5 rounded transition ${isReady ? 'text-green-600 hover:bg-green-50' : 'text-slate-300 opacity-50 cursor-not-allowed'}`} 
                                                    title={isReady ? "Release to Inventory" : "Status must be 'QC passed'"}
                                                >
                                                    {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                            {quarantineBatches.length === 0 && (
                                <tr>
                                    <td colSpan={3} className="py-12 text-center text-slate-400 italic">
                                        Quarantine is empty.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
                {!isReadOnly && (
                    <div className="px-6 py-3 border-t border-orange-200 bg-white flex justify-end">
                        <button
                            onClick={() => void handleReleaseAll()}
                            disabled={releasableBatches.length === 0 || isProcessingBulkRelease || Boolean(processingBatchId)}
                            className="px-4 py-2 text-sm font-bold text-white bg-green-600 hover:bg-green-700 rounded-lg shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                        >
                            {isProcessingBulkRelease && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                            Release All
                        </button>
                    </div>
                )}
            </div>
        </div>

        {/* Bottom: Recent Activity */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden min-h-[18rem] md:h-[480px] flex flex-col">
            <div className="bg-slate-50 px-4 sm:px-6 py-3 border-b border-slate-200 flex-shrink-0">
                <h4 className="text-slate-600 font-bold text-xs uppercase tracking-wider flex items-center">
                    <ArrowRight className="w-4 h-4 mr-2" /> Recent Activity
                </h4>
                {isRecentActivitySyncing && (
                    <div className="mt-2 inline-flex items-center rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-[11px] font-semibold text-indigo-700">
                        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                        Saving activity update...
                    </div>
                )}
                <ActivityFilterBar
                    fromDate={recentActivityDraftFromDate}
                    toDate={recentActivityDraftToDate}
                    onChangeFrom={setRecentActivityDraftFromDate}
                    onChangeTo={setRecentActivityDraftToDate}
                    rightSideControls={
                        <div className={activityFilterLayoutClass}>
                            <div>
                                <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Batch Type</label>
                                <select
                                    value={recentActivityDraftBatchType}
                                    onChange={(event) => setRecentActivityDraftBatchType(event.target.value)}
                                    className={filterFieldClass}
                                >
                                    <option value="all">All</option>
                                    {recentActivityBatchTypeOptions.map((option) => (
                                        <option key={option} value={option}>
                                            {option}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Search</label>
                                <input
                                    type="text"
                                    value={recentActivityDraftSearchInput}
                                    onChange={(event) => setRecentActivityDraftSearchInput(event.target.value)}
                                    placeholder="Product, batch, user, notes..."
                                    className={filterFieldClass}
                                />
                            </div>
                        </div>
                    }
                    onApply={applyRecentActivityFilters}
                    onReset={resetRecentActivityFilters}
                    onExport={downloadRecentActivityCsv}
                    exportDisabled={sortedRecentActivity.length === 0}
                />
            </div>
            <div className="mobile-table-region overflow-x-auto overflow-y-visible md:overflow-y-auto flex-1 min-h-0">
                <table className="w-full table-fixed text-sm text-left">
                    <thead className="bg-white text-slate-500 font-bold border-b border-slate-100 text-xs uppercase tracking-wider sticky top-0 z-10">
                        <tr>
                            <SortableHeader
                                label="Date"
                                sortKey="date"
                                activeSortKey={recentActivitySortState.key}
                                sortDir={recentActivitySortState.dir}
                                onChange={handleRecentActivitySortChange}
                                className="w-[16%] px-4 py-3 bg-white"
                            />
                            <SortableHeader
                                label="Product"
                                sortKey="product"
                                activeSortKey={recentActivitySortState.key}
                                sortDir={recentActivitySortState.dir}
                                onChange={handleRecentActivitySortChange}
                                className="w-[24%] px-4 py-3 bg-white"
                            />
                            <SortableHeader
                                label="Batch Type"
                                sortKey="batchType"
                                activeSortKey={recentActivitySortState.key}
                                sortDir={recentActivitySortState.dir}
                                onChange={handleRecentActivitySortChange}
                                className="w-[10%] px-4 py-3 bg-white"
                            />
                            <SortableHeader
                                label="Quantity"
                                sortKey="qty"
                                activeSortKey={recentActivitySortState.key}
                                sortDir={recentActivitySortState.dir}
                                onChange={handleRecentActivitySortChange}
                                className="w-[10%] px-4 py-3 text-right bg-white"
                            />
                            <SortableHeader
                                label="Unit Production Cost"
                                sortKey="unitProductionCost"
                                activeSortKey={recentActivitySortState.key}
                                sortDir={recentActivitySortState.dir}
                                onChange={handleRecentActivitySortChange}
                                className="w-[13%] px-4 py-3 text-right bg-white"
                            />
                            <th className="w-[12%] px-4 py-3 bg-white">QC Condition</th>
                            <SortableHeader
                                label="User"
                                sortKey="user"
                                activeSortKey={recentActivitySortState.key}
                                sortDir={recentActivitySortState.dir}
                                onChange={handleRecentActivitySortChange}
                                className="w-[10%] px-4 py-3 bg-white"
                            />
                            <th className="w-[9%] px-4 py-3 bg-white">Notes</th>
                            <th className="w-[8%] px-4 py-3 text-center">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {sortedRecentActivity.map((row) => {
                            const tx = row.tx;
                            const rowKey = tx?.id || resolveProductBatchIdentity(row.batch) || row.batch.id;
                            const isSyncingThisRow = recentActivitySyncState?.txId === rowKey;
                            const isEditingThisRow = isSyncingThisRow && recentActivitySyncState?.mode === 'edit';
                            const isDeletingThisRow = isSyncingThisRow && recentActivitySyncState?.mode === 'delete';
                            const tooltip = row.qcDisposition === 'reconciled_release' && row.notes ? row.notes : undefined;
                            return (
                                <tr key={rowKey} title={tooltip} className={`transition-colors ${isSyncingThisRow ? 'bg-indigo-50/60' : getQcActivityClass(row)}`}>
                                    <td className="px-4 py-3 text-slate-500 text-xs align-top">
                                        <div className="whitespace-nowrap">{formatBritishDate(row.eventDate)}</div>
                                        <div className="whitespace-nowrap">{formatBritishTime(row.eventDate)}</div>
                                    </td>
                                    <td className="px-4 py-3 align-top">
                                        <span className="block font-bold text-slate-700 break-words leading-snug" title={row.productName}>
                                            {row.productName}
                                        </span>
                                        <span className="mt-1 block font-mono text-[11px] text-indigo-600 break-words leading-snug" title={row.batchNumber || '-'}>
                                            {row.batchNumber || '-'}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3 align-top">
                                        <span
                                            className={`inline-flex max-w-full px-2 py-1 rounded-full text-[10px] font-bold uppercase border ${getBatchTypeBadgeClass(row.batchType)}`}
                                            title={row.batchType || 'Unknown'}
                                        >
                                            {row.batchType || '—'}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3 text-right font-mono font-bold text-green-600 align-top whitespace-nowrap">
                                        <div>{row.qtyDisplay}</div>
                                        {row.hasQuantityMismatch && (
                                            <div className="mt-1 flex items-center justify-end text-[10px] font-semibold text-amber-700">
                                                <AlertTriangle className="mr-1 h-3 w-3" />
                                                Batch {row.batchQty.toLocaleString()}
                                            </div>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 text-right font-mono text-xs text-slate-600 align-top">
                                        <div className="flex items-center justify-end whitespace-nowrap">
                                        <PoundSterling className="w-3 h-3 mr-0.5 opacity-40" /> {row.unitCost.toFixed(2)}
                                        </div>
                                    </td>
                                    <td className="px-4 py-3 align-top">
                                        <span className={`inline-flex max-w-full px-2 py-1 rounded-full text-[10px] font-bold uppercase border ${getQcStatusBadgeClass(row)}`}>
                                            {normalizeStatus(row.qcStatus).replace(/_/g, ' ')}
                                        </span>
                                        {row.qcDisposition !== 'standard' && (
                                            <div className="mt-1 text-[10px] font-semibold text-slate-500">
                                                {formatQcDispositionLabel(row.qcDisposition)}
                                            </div>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 text-xs text-slate-400 align-top break-words">{row.user}</td>
                                    <td className="px-4 py-3 text-xs text-slate-500 align-top">
                                        <span className="block break-words leading-snug" title={row.notes || '—'}>
                                            {row.notes || '—'}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3 text-center align-top">
                                        <div className="flex justify-center gap-1">
                                            <button 
                                                onClick={() => {
                                                    if (tx) {
                                                        handleEditTx(tx);
                                                    } else {
                                                        loadBatchActivityForEdit(row.batch);
                                                    }
                                                }}
                                                disabled={isReadOnly || isRecentActivitySyncing}
                                                className="p-1.5 text-slate-400 hover:text-indigo-600 transition disabled:opacity-50 disabled:cursor-not-allowed"
                                                title={!tx ? "Edit batch declaration only" : isEditingThisRow ? "Saving edit..." : "Edit Entry"}
                                            >
                                                {isEditingThisRow ? <Loader2 className="w-4 h-4 animate-spin" /> : <Edit className="w-4 h-4" />}
                                            </button>
                                            <button 
                                                onClick={() => tx && handleDeleteTx(tx)}
                                                disabled={!tx || isReadOnly || isRecentActivitySyncing}
                                                className="p-1.5 text-slate-400 hover:text-red-600 transition disabled:opacity-50 disabled:cursor-not-allowed"
                                                title={!tx ? "No release ledger entry to delete" : isDeletingThisRow ? "Deleting..." : "Delete Entry"}
                                            >
                                                {isDeletingThisRow ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                        {sortedRecentActivity.length === 0 && (
                            <tr><td colSpan={9} className="py-8 text-center text-slate-400 italic">No recent QC activity.</td></tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    </div>
  );
};
