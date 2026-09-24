/**
 * HARD BOUNDARY: COMP IN CHANGE REQUEST
 * 
 * AUTHORITY: Inventory Reception Logic (Goods In).
 * RULES:
 * 1. Must preserve auditability and prevent double-counting.
 * 2. No master data edits allowed from this view.
 * 3. All receipts must link to a valid PO or Supplier.
 */

import React, { useState, useMemo, useEffect } from 'react';
import { Component, Product, InventoryTransaction, Supplier, LocationName, RawComponentLot, ComponentType, CategoryMaster } from '../../types';
import { Truck, CheckCircle, ShieldCheck, Lock, Edit, Trash2, Loader2, AlertTriangle, History, X, Save, Calendar, Beaker, Box, CheckSquare, Undo2, SquareArrowRight, ChevronRight, ChevronDown } from 'lucide-react';
import { ActivityFilterBar } from './ActivityFilterBar';
import { SortableHeader } from './SortableHeader';
import { useAppDialog } from '../ui/AppDialogProvider';
import { formatBritishDate, formatBritishTime } from '../../lib/dateFormatting';
import { useIsHandheldDevice } from '../../lib/useIsHandheldDevice';
import { formatRawComponentInventoryLabel, formatRawComponentListLabel } from '../../utils/rawComponentLabels';
import { formatFinishedProductInventoryLabel } from '../../utils/finishedProductLabels';
import {
  createRawLotRecordId,
  getRawLotActivityTimestamp,
  getRawLotActivityUser,
  getRawLotDisplayQuantity,
  getRawLotRowId,
  getRawLotWorkflowStage,
  isArrivedRawLot,
  isPreArrivalRawLot,
  resolveRawLotLandedUnitPrice,
  withDerivedRawLotPricing,
} from '../../services/rawLotWorkflow';

interface Props {
  currentUser: string;
  inventory: Component[];
  products: Product[];
  categories?: CategoryMaster[];
  transactions: InventoryTransaction[];
  suppliers: Supplier[];
  rawComponentLots: RawComponentLot[];
  onTransaction: (
    tx: Omit<InventoryTransaction, 'id' | 'date' | 'itemName' | 'unit'> & { unit?: string },
    lotMetadata?: any
  ) => Promise<InventoryTransaction | void> | InventoryTransaction | void;
  onCreateLot?: (lot: RawComponentLot) => void;
  onUpdateLot?: (lotId: string, updates: Partial<RawComponentLot>, reason: string, user: string) => Promise<void> | void;
  onDeleteLot?: (lotId: string) => Promise<void>;
  onEditLotInit: (lot: RawComponentLot) => void;
  isReadOnly?: boolean;
}

const SAFE_UNITS = ['kg', 'g', 'L', 'ml', 'pcs', 'bag', 'box', 'drum', 'can', 'm', 'roll', 'unit'];
const UI_ITEM_CATEGORIES = [
  'consumables',
  'dispensing',
  'ingredients',
  'label',
  'primary packaging',
  'secondary packaging'
] as const;
type UiItemCategory = (typeof UI_ITEM_CATEGORIES)[number];

const mapComponentTypeToUiCategory = (type: ComponentType): UiItemCategory | '' => {
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
const normalizeId = (value: unknown): string => String(value ?? '').trim().toLowerCase();
const getTodayInputValue = (): string => new Date().toISOString().slice(0, 10);

// Default state for new items (minimized for streamlined entry)
const createInitialIntakeState = () => ({
    itemId: '',
    quantity: '',
    supplier: '',
    plannedPrice: '',
    shippingCost: '',
    paidDate: getTodayInputValue(),
    expectedDeliveryDate: '',
    procurementRef: '',
    unit: '',
});

const normalizeSearchText = (value: unknown): string =>
  String(value ?? '').toLowerCase().trim();

const getDateOnlyValue = (value: string): string => {
  const source = String(value || '').trim();
  if (!source) return '';
  const matched = source.match(/^\d{4}-\d{2}-\d{2}/);
  if (matched) return matched[0];
  const t = new Date(source).getTime();
  if (!Number.isFinite(t)) return '';
  return new Date(t).toISOString().slice(0, 10);
};

const normalizeRawLotDateFields = <T extends Partial<RawComponentLot>>(lot: T): T => ({
  ...lot,
  paidDate: getDateOnlyValue(String(lot.paidDate || '')),
  expectedDeliveryDate: getDateOnlyValue(String(lot.expectedDeliveryDate || '')),
  deliveryDate: getDateOnlyValue(String(lot.deliveryDate || '')),
  mfgDate: getDateOnlyValue(String(lot.mfgDate || '')),
  expDate: getDateOnlyValue(String(lot.expDate || '')),
}) as T;

const getDefaultLast30DaysRange = (): { from: string; to: string } => {
  const toDate = new Date();
  const fromDate = new Date(toDate);
  fromDate.setDate(fromDate.getDate() - 29);
  return {
    from: fromDate.toISOString().slice(0, 10),
    to: toDate.toISOString().slice(0, 10),
  };
};

const matchesSearch = (fields: Array<unknown>, query: string): boolean => {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return true;
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const normalizedFields = fields.map(normalizeSearchText);
  return tokens.every((token) => normalizedFields.some((field) => field.includes(token)));
};

const escapeCsv = (value: string | number): string => {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
};

type RecentActivitySortKey = 'date' | 'item' | 'supplier' | 'qty' | 'unitCost' | 'qc' | 'user';

export const ComponentReception: React.FC<Props> = ({
  currentUser, inventory, products, categories = [], transactions, suppliers, rawComponentLots,
  onTransaction, onCreateLot, onUpdateLot, onDeleteLot, onEditLotInit, isReadOnly
}) => {
  const appDialog = useAppDialog();
  const isHandheldDevice = useIsHandheldDevice();
  const defaultRecentActivityDateRange = useMemo(() => getDefaultLast30DaysRange(), []);
  // Intake Form State
  const [compIn, setCompIn] = useState(createInitialIntakeState);
  const [selectedCompInCategory, setSelectedCompInCategory] = useState<UiItemCategory | ''>('');
  const [isReceiving, setIsReceiving] = useState(false);
  
  // Local Edit Modal State
  const [editingLot, setEditingLot] = useState<RawComponentLot | null>(null);
  const [editForm, setEditForm] = useState<Partial<RawComponentLot>>({});
  const [editItemCategory, setEditItemCategory] = useState<UiItemCategory | ''>('');
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  // Deletion State
  const [deleteConfirmLot, setDeleteConfirmLot] = useState<RawComponentLot | null>(null);
  const [isProcessingDelete, setIsProcessingDelete] = useState(false);

  // Arrival / Move To Quarantine State
  const [moveToQuarantineLot, setMoveToQuarantineLot] = useState<RawComponentLot | null>(null);
  const [moveToQuarantineLocation, setMoveToQuarantineLocation] = useState<LocationName>('Riverside');
  const [isProcessingMoveToQuarantine, setIsProcessingMoveToQuarantine] = useState(false);

  // Return To Pre-Arrival State
  const [returnToPreArrivalLot, setReturnToPreArrivalLot] = useState<RawComponentLot | null>(null);
  const [isProcessingReturnToPreArrival, setIsProcessingReturnToPreArrival] = useState(false);
  const [expandedPreArrivalIds, setExpandedPreArrivalIds] = useState<Set<string>>(new Set());
  
  // Release State
  const [releaseConfirmLot, setReleaseConfirmLot] = useState<RawComponentLot | null>(null);
  const [isProcessingRelease, setIsProcessingRelease] = useState(false);
  const [isProcessingBulkRelease, setIsProcessingBulkRelease] = useState(false);
  const [recentActivityDraftFromDate, setRecentActivityDraftFromDate] = useState(defaultRecentActivityDateRange.from);
  const [recentActivityDraftToDate, setRecentActivityDraftToDate] = useState(defaultRecentActivityDateRange.to);
  const [recentActivityDraftSupplier, setRecentActivityDraftSupplier] = useState('all');
  const [recentActivityDraftSearchQuery, setRecentActivityDraftSearchQuery] = useState('');
  const [recentActivityAppliedFromDate, setRecentActivityAppliedFromDate] = useState(defaultRecentActivityDateRange.from);
  const [recentActivityAppliedToDate, setRecentActivityAppliedToDate] = useState(defaultRecentActivityDateRange.to);
  const [recentActivityAppliedSupplier, setRecentActivityAppliedSupplier] = useState('all');
  const [recentActivityAppliedSearchQuery, setRecentActivityAppliedSearchQuery] = useState('');
  const [recentActivitySortState, setRecentActivitySortState] = useState<{ key: RecentActivitySortKey; dir: 'asc' | 'desc' }>({
    key: 'date',
    dir: 'desc',
  });
  const filterFieldClass = 'w-full h-11 border border-slate-300 rounded bg-white px-3 text-base sm:text-sm shadow-none';
  const topRowLayoutClass = isHandheldDevice
    ? 'grid grid-cols-1 gap-6 lg:gap-8'
    : 'grid grid-cols-1 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] gap-6 lg:gap-8';
  const activityFilterLayoutClass = isHandheldDevice
    ? 'grid grid-cols-1 gap-2'
    : 'grid grid-cols-1 lg:grid-cols-2 gap-2';

  // --- Derived Data ---

  const selectedCompInUnit = useMemo(() => {
    if (!compIn.itemId) return '';
    const item = inventory.find(i => i.component_id === compIn.itemId);
    return item?.default_unit || '';
  }, [compIn.itemId, inventory]);

  const preArrivalLots = useMemo(() => {
      return rawComponentLots
        .filter((lot) => isPreArrivalRawLot(lot))
        .sort(
          (a, b) =>
            new Date(getRawLotActivityTimestamp(b) || 0).getTime() -
            new Date(getRawLotActivityTimestamp(a) || 0).getTime()
        );
  }, [rawComponentLots]);

  const togglePreArrivalExpanded = (lotId: string) => {
      setExpandedPreArrivalIds((prev) => {
          const next = new Set(prev);
          if (next.has(lotId)) {
              next.delete(lotId);
          } else {
              next.add(lotId);
          }
          return next;
      });
  };

  const quarantineLots = useMemo(() => {
      return rawComponentLots.filter(lot => {
          if (!isArrivedRawLot(lot)) return false;
          if (getRawLotWorkflowStage(lot) === 'RELEASED') return false;
          const hasInTx = transactions.some(tx => tx.batchNumber === lot.qc_number && tx.type === 'IN');
          if (hasInTx) return false;
          const statusLower = (lot.qcStatus || '').trim().toLowerCase();
          return statusLower !== 'rejected';
      });
  }, [rawComponentLots, transactions]);

  const releasableQuarantineLots = useMemo(() => {
      return quarantineLots.filter((lot) => (lot.qcStatus || '').trim().toLowerCase() === 'qc passed');
  }, [quarantineLots]);

  const latestLotByItemId = useMemo(() => {
      const byItemId = new Map<string, RawComponentLot>();
      const getLotTime = (lot: RawComponentLot): number => {
          const ts = new Date(getRawLotActivityTimestamp(lot) || '').getTime();
          return Number.isFinite(ts) ? ts : Number.NEGATIVE_INFINITY;
      };

      rawComponentLots.forEach((lot) => {
          if (!isArrivedRawLot(lot)) return;
          const key = normalizeId(lot.itemId);
          if (!key) return;
          const existing = byItemId.get(key);
          if (!existing || getLotTime(lot) >= getLotTime(existing)) {
              byItemId.set(key, lot);
          }
      });

      return byItemId;
  }, [rawComponentLots]);

  const recentQcActivity = useMemo(() => {
      // Activity reflects the complete local lot history, sorted newest first.
      return [...rawComponentLots].sort(
        (a, b) =>
          new Date(getRawLotActivityTimestamp(b) || 0).getTime() -
          new Date(getRawLotActivityTimestamp(a) || 0).getTime()
      );
  }, [rawComponentLots]);

  const componentLabelById = useMemo(() => {
      const byId: Record<string, string> = {};
      inventory.forEach((item) => {
          byId[item.component_id] = formatRawComponentListLabel(item, categories);
      });
      return byId;
  }, [inventory, categories]);

  const componentOverviewLabelById = useMemo(() => {
      const byId: Record<string, string> = {};
      inventory.forEach((item) => {
          byId[item.component_id] = formatRawComponentInventoryLabel(item, categories);
      });
      return byId;
  }, [inventory, categories]);

  const componentCategoryPrefixById = useMemo(() => {
      const byId: Record<string, string> = {};
      inventory.forEach((item) => {
          const uiCategory = mapComponentTypeToUiCategory(item.type);
          byId[item.component_id] = uiCategory || '';
      });
      return byId;
  }, [inventory]);

  const recentActivitySupplierOptions = useMemo(() => {
      const names = new Set<string>();
      recentQcActivity.forEach((lot) => {
          const supplier = String(lot.supplier || '').trim();
          if (supplier) names.add(supplier);
      });
      return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [recentQcActivity]);

  const filteredRecentQcActivity = useMemo(() => {
      return recentQcActivity.filter((lot) => {
          const eventDate = String(getRawLotActivityTimestamp(lot) || '');
          const dateOnly = getDateOnlyValue(eventDate);
          if (recentActivityAppliedFromDate && (!dateOnly || dateOnly < recentActivityAppliedFromDate)) return false;
          if (recentActivityAppliedToDate && (!dateOnly || dateOnly > recentActivityAppliedToDate)) return false;
          if (recentActivityAppliedSupplier !== 'all' && String(lot.supplier || '') !== recentActivityAppliedSupplier) return false;

          const itemName = componentOverviewLabelById[lot.itemId] || lot.itemId || '';
          const qcNumber = lot.qc_number || '';
          const supplier = lot.supplier || '';
          const updatedBy = getRawLotActivityUser(lot) || '';
          const qcStatus = isPreArrivalRawLot(lot) ? 'On the way' : (lot.qcStatus || '');
          const notes = lot.qcNotes || lot.procurementNotes || '';
          return matchesSearch(
            [itemName, qcNumber, supplier, updatedBy, qcStatus, notes, lot.procurementRef || '', lot.expectedDeliveryDate || ''],
            recentActivityAppliedSearchQuery
          );
      });
  }, [
    recentQcActivity,
    componentOverviewLabelById,
    recentActivityAppliedFromDate,
    recentActivityAppliedToDate,
    recentActivityAppliedSupplier,
    recentActivityAppliedSearchQuery,
  ]);

  const sortedRecentQcActivity = useMemo(() => {
      const compareDate = (left: RawComponentLot, right: RawComponentLot): number => {
          const tl = new Date(getRawLotActivityTimestamp(left) || '').getTime();
          const tr = new Date(getRawLotActivityTimestamp(right) || '').getTime();
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

      const indexed = filteredRecentQcActivity.map((lot, index) => ({ lot, index }));
      indexed.sort((a, b) => {
          let base = 0;
          switch (recentActivitySortState.key) {
              case 'date':
                  base = compareDate(a.lot, b.lot);
                  break;
              case 'item':
                  base = compareText(
                    componentOverviewLabelById[a.lot.itemId] || a.lot.itemId,
                    componentOverviewLabelById[b.lot.itemId] || b.lot.itemId
                  );
                  break;
              case 'supplier':
                  base = compareText(a.lot.supplier || '', b.lot.supplier || '');
                  break;
              case 'qty':
                  base = compareNumber(getRawLotDisplayQuantity(a.lot), getRawLotDisplayQuantity(b.lot));
                  break;
              case 'unitCost':
                  base = compareNumber(resolveRawLotLandedUnitPrice(a.lot), resolveRawLotLandedUnitPrice(b.lot));
                  break;
              case 'qc':
                  base = compareText(
                    isPreArrivalRawLot(a.lot) ? 'On the way' : (a.lot.qcStatus || ''),
                    isPreArrivalRawLot(b.lot) ? 'On the way' : (b.lot.qcStatus || '')
                  );
                  break;
              case 'user':
                  base = compareText(getRawLotActivityUser(a.lot) || '', getRawLotActivityUser(b.lot) || '');
                  break;
              default:
                  base = compareDate(a.lot, b.lot);
                  break;
          }
          if (base === 0) return a.index - b.index;
          return recentActivitySortState.dir === 'asc' ? base : -base;
      });
      return indexed.map((entry) => entry.lot);
  }, [filteredRecentQcActivity, recentActivitySortState, componentOverviewLabelById]);

  const compInOptions = useMemo(() => {
    return inventory.map(i => ({
        id: i.component_id,
        name: formatRawComponentListLabel(i, categories),
        unit: i.default_unit || "unit",
        group: i.type.replace('_', ' '),
        uiCategory: mapComponentTypeToUiCategory(i.type),
        note: i.notes || ""
    })).sort((a,b) => (a.group || "").localeCompare(b.group || "") || (a.name || "").localeCompare(b.name || ""));
  }, [inventory, categories]);

  const filteredCompInOptions = useMemo(() => {
    if (!selectedCompInCategory) return [];
    return compInOptions.filter(opt => opt.uiCategory === selectedCompInCategory);
  }, [compInOptions, selectedCompInCategory]);

  const editItemOptions = useMemo(() => {
    if (!editItemCategory) return [];
    return compInOptions.filter(opt => opt.uiCategory === editItemCategory);
  }, [compInOptions, editItemCategory]);

  const groupedCompInOptions = useMemo(() => {
    const groups: Record<string, typeof filteredCompInOptions> = {};
    filteredCompInOptions.forEach(opt => {
      if (!groups[opt.group]) groups[opt.group] = [];
      groups[opt.group].push(opt);
    });
    return groups;
  }, [filteredCompInOptions]);

  useEffect(() => {
    if (!compIn.itemId) return;
    const stillVisible = filteredCompInOptions.some(opt => opt.id === compIn.itemId);
    if (!stillVisible) {
      setCompIn(prev => ({ ...prev, itemId: '', unit: '' }));
    }
  }, [filteredCompInOptions, compIn.itemId]);

  const buildDerivedQCNumber = (itemId: string): string => {
    if (!itemId) return "";
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const base = `${itemId}-${dateStr}`;

    // Check both Transactions and Unreleased Lots to prevent collision on new items
    const existingInTx = transactions.filter(t => 
      t.itemId === itemId && 
      t.batchNumber && 
      t.batchNumber.startsWith(base)
    ).map(t => t.batchNumber!);

    const existingInLots = rawComponentLots.filter(l => 
        l.itemId === itemId && 
        l.qc_number && 
        l.qc_number.startsWith(base)
    ).map(l => l.qc_number);

    const allMatches = new Set([...existingInTx, ...existingInLots]);
    const seq = (allMatches.size + 1).toString().padStart(2, '0');
    return `${base}${seq}`;
  };

  const resolveQCCollision = (requestedQC: string) => {
    const fromTx = transactions.map(t => t.batchNumber).filter(Boolean) as string[];
    const fromLots = rawComponentLots.map(l => l.qc_number).filter(Boolean) as string[];
    const allExisting = new Set([...fromTx, ...fromLots]);

    if (!allExisting.has(requestedQC)) return requestedQC;
    let counter = 2;
    while (allExisting.has(`${requestedQC}-${counter}`)) {
      counter++;
    }
    return `${requestedQC}-${counter}`;
  };

  const uniqueSuppliersList = useMemo(() => {
    const names = new Set<string>();
    suppliers.forEach(s => names.add(s.supplier_name));
    transactions.forEach(t => { if (t.supplier) names.add(t.supplier); });
    rawComponentLots.forEach(l => { if (l.supplier) names.add(l.supplier); });
    return Array.from(names).filter(Boolean).sort();
  }, [suppliers, transactions, rawComponentLots]);

  // --- Handlers ---

  const handleCompIn = async () => {
    if (isReadOnly) return;
    const parsedQty = Number(compIn.quantity);
    const quantityMissingOrInvalid = compIn.quantity === '' || Number.isNaN(parsedQty);
    if (!compIn.itemId || quantityMissingOrInvalid || parsedQty < 0) {
        await appDialog.alert({ message: "Please select an item and enter a valid quantity (0 or greater).", tone: 'warning' });
        return;
    }
    
    if (!onCreateLot) {
        await appDialog.alert({ message: "System Error: Create Lot function not available.", tone: 'danger' });
        return;
    }

    setIsReceiving(true);

    const timestamp = new Date().toISOString();
    const newLot = withDerivedRawLotPricing({
        lot_record_id: createRawLotRecordId(),
        qc_number: '',
        workflow_stage: 'PRE_ARRIVAL',
        itemId: compIn.itemId,
        ordered_qty: Number(compIn.quantity),
        received_qty: 0,
        unit: compIn.unit || selectedCompInUnit || 'unit',
        planned_unit_price: Number(compIn.plannedPrice || 0),
        unit_price: 0,
        shipping_cost: Number(compIn.shippingCost || 0),
        location: '',
        supplier: compIn.supplier,
        procurementRef: compIn.procurementRef,
        procurementNotes: '',
        paidDate: compIn.paidDate,
        expectedDeliveryDate: compIn.expectedDeliveryDate,
        deliveryDate: '',
        qcStatus: '',
        manufacturer: '',
        mfgBatch: '',
        mfgDate: '',
        expDate: '',
        tdsStored: 'No',
        sdsStored: 'No',
        coaStored: 'No',
        qcNotes: '',
        ph: '',
        titration: '',
        appearance: '',
        lodMoisture: '',
        cfu: '',
        checkMaterial: 'N/A',
        checkPrinting: 'N/A',
        checkSize: 'N/A',
        checkCorrectItem: 'N/A',
        checkCorrectQuantity: 'N/A',
        history: '',
        registeredAt: timestamp,
        registeredBy: currentUser,
        editedAt: timestamp,
        editedBy: currentUser,
        createdAt: timestamp,
        updatedAt: timestamp,
        createdBy: currentUser,
        updatedBy: currentUser
    });

    try {
        await onCreateLot(newLot);
        setCompIn(createInitialIntakeState());
    } catch (e) {
        console.error("Pre-arrival registration failed", e);
        await appDialog.alert({ message: "Failed to register pre-arrival item.", tone: 'danger' });
    } finally {
        setIsReceiving(false);
    }
  };

  const handleOpenEdit = (lot: RawComponentLot) => {
      setEditingLot(lot);
      setEditForm({ ...lot });
      setEditItemCategory((componentCategoryPrefixById[lot.itemId] as UiItemCategory | undefined) || '');
  };

  const buildLedgerNotesFromLot = (lot: Partial<RawComponentLot>): string => {
      const parts = [
        String(lot.procurementNotes || '').trim() ? `Procurement: ${String(lot.procurementNotes || '').trim()}` : '',
        String(lot.qcNotes || '').trim() ? `QC: ${String(lot.qcNotes || '').trim()}` : '',
      ].filter(Boolean);
      return parts.join(' | ');
  };

  const resolveWorkflowStageForSave = (lot: RawComponentLot, draft: Partial<RawComponentLot>): RawComponentLot['workflow_stage'] => {
      const explicitStage = draft.workflow_stage || lot.workflow_stage;
      if (explicitStage === 'PRE_ARRIVAL') return 'PRE_ARRIVAL';
      if (explicitStage === 'RELEASED') return 'RELEASED';
      const qcStatus = String(draft.qcStatus ?? lot.qcStatus ?? '').trim().toLowerCase();
      if (qcStatus === 'rejected') return 'REJECTED';
      return 'QUARANTINE';
  };

  const getLotUpdateRequestId = (lot: Partial<RawComponentLot>): string =>
      String(lot.qc_number || '').trim() || getRawLotRowId(lot);

  const handleSaveEdit = async () => {
      if (!editingLot || !onUpdateLot) return;
      setIsSavingEdit(true);
      try {
          if (!String(editForm.itemId || '').trim()) {
              await appDialog.alert({ message: "Please select an item before saving this lot.", tone: 'warning' });
              return;
          }
          // Calculate History Diff
          const changes: string[] = [];
          (Object.keys(editForm) as (keyof RawComponentLot)[]).forEach(k => {
              // Skip ignored fields
              if ([
                'updatedAt', 'updatedBy', 'createdAt', 'createdBy', 'history',
                'qc_number', 'lot_record_id', 'registeredAt', 'registeredBy',
                'editedAt', 'editedBy', 'unit_price'
              ].includes(k)) return;
              
              const newVal = editForm[k];
              const oldVal = editingLot[k];
              
              // Loose equality check to handle potential type mismatches (string vs number)
              if (newVal != oldVal) {
                  const n = newVal === undefined || newVal === null ? '' : String(newVal);
                  const o = oldVal === undefined || oldVal === null ? '' : String(oldVal);
                  if (n !== o) {
                      changes.push(`${k}: ${o || '""'} -> ${n}`);
                  }
              }
          });

          const timestampIso = new Date().toISOString();
          const finalUpdates = withDerivedRawLotPricing(normalizeRawLotDateFields({
            ...editingLot,
            ...editForm,
            lot_record_id: editingLot.lot_record_id || getRawLotRowId(editingLot),
            workflow_stage: resolveWorkflowStageForSave(editingLot, editForm),
            editedAt: timestampIso,
            editedBy: currentUser,
            updatedBy: currentUser,
          }));
          
          if (changes.length > 0) {
              const timestamp = timestampIso.slice(0, 16).replace('T', ' ');
              const historyEntry = `[${timestamp}] ${currentUser}: ${changes.join('; ')}`;
              const existingHistory = editingLot.history || '';
              finalUpdates.history = existingHistory ? `${existingHistory}\n${historyEntry}` : historyEntry;
          }

          await onUpdateLot(getLotUpdateRequestId(editingLot), finalUpdates, "QC Amendment", currentUser);
          setEditingLot(null);
          setEditForm({});
      } catch (e) {
          console.error("Update failed", e);
          await appDialog.alert({ message: "Failed to update QC details.", tone: 'danger' });
      } finally {
          setIsSavingEdit(false);
      }
  };

  const handleDeleteWithDelay = async (lotId: string) => {
      if (isReadOnly) return;
      if (!lotId || !onDeleteLot) return;
      await onDeleteLot(lotId);
  };

  const handleRequestDelete = (lot: RawComponentLot) => {
      if (isReadOnly) return;
      if (!onDeleteLot) return;
      setDeleteConfirmLot(lot);
  };

  const handleConfirmDelete = async () => {
      if (deleteConfirmLot) {
          setIsProcessingDelete(true);
          try {
              await handleDeleteWithDelay(getRawLotRowId(deleteConfirmLot));
              setDeleteConfirmLot(null);
              setEditingLot(null); // Close edit modal if open
          } catch (e) {
              console.error("Delete failed:", e);
              await appDialog.alert({ message: "Failed to delete this component-in record.", tone: 'danger' });
          } finally {
              setIsProcessingDelete(false);
          }
      }
  };

  const handleRequestMoveToQuarantine = (lot: RawComponentLot) => {
      if (isReadOnly || !onUpdateLot || !isPreArrivalRawLot(lot)) return;
      setMoveToQuarantineLot(lot);
      setMoveToQuarantineLocation('Riverside');
  };

  const handleConfirmMoveToQuarantine = async () => {
      if (!moveToQuarantineLot || !onUpdateLot) return;
      setIsProcessingMoveToQuarantine(true);
      try {
          const timestamp = new Date().toISOString();
          const deliveryDate = timestamp.split('T')[0];
          const finalQC = resolveQCCollision(buildDerivedQCNumber(moveToQuarantineLot.itemId));
          const defaultUnitPrice = Number(moveToQuarantineLot.unit_price ?? moveToQuarantineLot.planned_unit_price ?? 0);
          const quantityDefault = Number(moveToQuarantineLot.ordered_qty || 0);
          const nextLot = withDerivedRawLotPricing(normalizeRawLotDateFields({
              ...moveToQuarantineLot,
              workflow_stage: 'QUARANTINE',
              qc_number: finalQC,
              location: moveToQuarantineLocation,
              deliveryDate,
              received_qty: quantityDefault,
              unit_price: defaultUnitPrice,
              qcStatus: 'On hold',
              editedAt: timestamp,
              editedBy: currentUser,
              updatedBy: currentUser,
          }));
          const historyEntry = `[${timestamp.slice(0, 16).replace('T', ' ')}] ${currentUser}: workflow_stage: PRE_ARRIVAL -> QUARANTINE; qc_number: "" -> ${finalQC}; deliveryDate: "" -> ${deliveryDate}; location: "" -> ${moveToQuarantineLocation}; received_qty: 0 -> ${quantityDefault}`;
          const existingHistory = moveToQuarantineLot.history || '';
          nextLot.history = existingHistory ? `${existingHistory}\n${historyEntry}` : historyEntry;
          await onUpdateLot(getLotUpdateRequestId(moveToQuarantineLot), nextLot, 'Move To Quarantine', currentUser);
          setMoveToQuarantineLot(null);
          setEditingLot(null);
      } catch (e) {
          console.error('Move to quarantine failed', e);
          await appDialog.alert({ message: 'Failed to move item into QC quarantine.', tone: 'danger' });
      } finally {
          setIsProcessingMoveToQuarantine(false);
      }
  };

  const handleRequestReturnToPreArrival = (lot: RawComponentLot) => {
      if (isReadOnly || !onUpdateLot || isPreArrivalRawLot(lot)) return;
      setReturnToPreArrivalLot(lot);
  };

  const handleConfirmReturnToPreArrival = async () => {
      if (!returnToPreArrivalLot || !onUpdateLot) return;
      setIsProcessingReturnToPreArrival(true);
      try {
          const timestamp = new Date().toISOString();
          const nextLot = withDerivedRawLotPricing(normalizeRawLotDateFields({
              ...returnToPreArrivalLot,
              workflow_stage: 'PRE_ARRIVAL',
              qc_number: '',
              location: '',
              deliveryDate: '',
              received_qty: 0,
              qcStatus: '',
              qcNotes: '',
              manufacturer: '',
              mfgBatch: '',
              mfgDate: '',
              expDate: '',
              ph: '',
              titration: '',
              appearance: '',
              lodMoisture: '',
              cfu: '',
              checkMaterial: 'N/A',
              checkPrinting: 'N/A',
              checkSize: 'N/A',
              checkCorrectItem: 'N/A',
              checkCorrectQuantity: 'N/A',
              editedAt: timestamp,
              editedBy: currentUser,
              updatedBy: currentUser,
          }));
          const historyEntry = `[${timestamp.slice(0, 16).replace('T', ' ')}] ${currentUser}: workflow_stage: ${returnToPreArrivalLot.workflow_stage || 'QUARANTINE'} -> PRE_ARRIVAL; qc_number: ${returnToPreArrivalLot.qc_number || '""'} -> ""; deliveryDate: ${returnToPreArrivalLot.deliveryDate || '""'} -> ""; location: ${returnToPreArrivalLot.location || '""'} -> ""; received_qty: ${returnToPreArrivalLot.received_qty || 0} -> 0`;
          const existingHistory = returnToPreArrivalLot.history || '';
          nextLot.history = existingHistory ? `${existingHistory}\n${historyEntry}` : historyEntry;
          await onUpdateLot(getLotUpdateRequestId(returnToPreArrivalLot), nextLot, 'Move Back To Pre-Arrival', currentUser);
          setReturnToPreArrivalLot(null);
      } catch (e) {
          console.error('Move back to pre-arrival failed', e);
          await appDialog.alert({ message: 'Failed to move item back to the Pre-Arrival Procurement Box.', tone: 'danger' });
      } finally {
          setIsProcessingReturnToPreArrival(false);
      }
  };

  const handleRequestRelease = async (lot: RawComponentLot) => {
      if (isReadOnly) return;
      if (!lot.qc_number) return;
      const currentStatus = (lot.qcStatus || '').trim().toLowerCase();
      // Allow release if manually set to QC passed OR if user forces it (though UI should guide to pass first)
      if (currentStatus !== 'qc passed') {
          const confirmed = await appDialog.confirm({
            title: 'Release Without QC Pass?',
            message: "This lot is not marked as 'QC Passed'. Release anyway?",
            tone: 'warning',
            confirmLabel: 'Release Anyway',
          });
          if (!confirmed) return;
      }
      setReleaseConfirmLot(lot);
  };

  const releaseLotToInventory = async (lot: RawComponentLot): Promise<boolean> => {
      try {
          const normalizedItemId = normalizeId(lot.itemId);
          const matchedComponent = inventory.find(i => normalizeId(i.component_id) === normalizedItemId);
          const matchedProduct = products.find(p => normalizeId(p.sku_id) === normalizedItemId);
          const canonicalItemId = String(matchedComponent?.component_id || matchedProduct?.sku_id || lot.itemId || '').trim();
          const canonicalBatch = String(lot.qc_number || '').trim();
          const canonicalUnit = String(lot.unit || matchedComponent?.default_unit || 'unit').trim();
          const itemName = matchedComponent ? formatRawComponentListLabel(matchedComponent, categories) : (matchedProduct ? formatFinishedProductInventoryLabel(matchedProduct) : canonicalItemId);
          const category = matchedComponent ? 'COMPONENT' as const : (matchedProduct ? 'PRODUCT' as const : 'COMPONENT' as const);

          if (!canonicalItemId || !canonicalBatch) {
              await appDialog.alert({ message: "Release blocked: lot is missing item ID or QC number.", tone: 'danger' });
              return false;
          }

          const txPayload = {
              type: 'IN' as const,
              category,
              itemId: canonicalItemId,
              itemName,
              quantity: Number(lot.received_qty),
              unit: canonicalUnit,
              supplier: String(lot.supplier || '').trim(),
              unitCost: resolveRawLotLandedUnitPrice(lot),
              batchNumber: canonicalBatch,
              reason: 'QC Release',
              notes: buildLedgerNotesFromLot(lot),
              reference: String(lot.procurementRef || '').trim(),
              location: lot.location as LocationName,
              sourceTab: 'Goods In',
              user: currentUser
          };
          await onTransaction(txPayload, {
            ...lot,
            workflow_stage: 'RELEASED',
            qcStatus: 'QC passed',
            editedAt: new Date().toISOString(),
            editedBy: currentUser,
            updatedBy: currentUser
          });
          return true;
      } catch (e) {
          console.error("Release failed", e);
          await appDialog.alert({ message: "Release failed: could not write to inventory ledger.", tone: 'danger' });
          return false;
      }
  };

  const handleConfirmRelease = async () => {
      if (!releaseConfirmLot) return;
      setIsProcessingRelease(true);
      try {
          const didRelease = await releaseLotToInventory(releaseConfirmLot);
          if (!didRelease) return;
          setReleaseConfirmLot(null);
          setEditingLot(null);
      } finally { setIsProcessingRelease(false); }
  };

  const handleReleaseAll = async () => {
      if (isReadOnly || releasableQuarantineLots.length === 0 || isProcessingRelease || isProcessingBulkRelease) return;
      const confirmed = await appDialog.confirm({
        title: 'Release All QC Passed Lots?',
        message: `Are you sure you want to release all ${releasableQuarantineLots.length} QC passed items?`,
        tone: 'warning',
        confirmLabel: 'Release All',
      });
      if (!confirmed) return;
      setIsProcessingBulkRelease(true);
      try {
          let successCount = 0;
          const failedQcNumbers: string[] = [];
          for (const lot of releasableQuarantineLots) {
              const didRelease = await releaseLotToInventory(lot);
              if (didRelease) {
                  successCount += 1;
              } else {
                  failedQcNumbers.push(String(lot.qc_number || '').trim() || '(unknown)');
              }
          }
          if (failedQcNumbers.length > 0) {
              await appDialog.alert({
                  title: 'Release All Summary',
                  message: `Release all completed with partial success.\n\nReleased: ${successCount}\nFailed: ${failedQcNumbers.length}\nQC: ${failedQcNumbers.join(', ')}`,
                  tone: 'warning',
              });
          }
      } finally {
          setIsProcessingBulkRelease(false);
      }
  };

  const applyRecentActivityFilters = () => {
      setRecentActivityAppliedFromDate(recentActivityDraftFromDate);
      setRecentActivityAppliedToDate(recentActivityDraftToDate);
      setRecentActivityAppliedSupplier(recentActivityDraftSupplier);
      setRecentActivityAppliedSearchQuery(recentActivityDraftSearchQuery.trim());
  };

  const resetRecentActivityFilters = () => {
      setRecentActivityDraftFromDate(defaultRecentActivityDateRange.from);
      setRecentActivityDraftToDate(defaultRecentActivityDateRange.to);
      setRecentActivityDraftSupplier('all');
      setRecentActivityDraftSearchQuery('');
      setRecentActivityAppliedFromDate(defaultRecentActivityDateRange.from);
      setRecentActivityAppliedToDate(defaultRecentActivityDateRange.to);
      setRecentActivityAppliedSupplier('all');
      setRecentActivityAppliedSearchQuery('');
      setRecentActivitySortState({ key: 'date', dir: 'desc' });
  };

  const downloadRecentActivityCsv = () => {
      if (sortedRecentQcActivity.length === 0) return;
      const headers = ['Date', 'Item', 'Stage', 'QC Number', 'Supplier', 'Qty', 'Landed Unit Cost', 'Status', 'User'];
      const rows = sortedRecentQcActivity.map((lot) => {
          const itemName = componentOverviewLabelById[lot.itemId] || lot.itemId || '';
          const dateValue = String(getRawLotActivityTimestamp(lot) || '');
          const displayQty = getRawLotDisplayQuantity(lot);
          const qtyText = `${displayQty} ${lot.unit || ''}`.trim();
          const unitCostText = resolveRawLotLandedUnitPrice(lot).toFixed(2);
          const stageLabel = isPreArrivalRawLot(lot) ? 'PRE_ARRIVAL' : getRawLotWorkflowStage(lot);
          return [
              getDateOnlyValue(dateValue),
              itemName,
              stageLabel,
              lot.qc_number || '',
              lot.supplier || '—',
              qtyText,
              unitCostText,
              isPreArrivalRawLot(lot) ? 'On the way' : (lot.qcStatus || '—'),
              getRawLotActivityUser(lot) || 'System',
          ];
      });
      const csv = [headers.join(','), ...rows.map((line) => line.map(escapeCsv).join(','))].join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const datedRows = sortedRecentQcActivity
          .map((lot) => getDateOnlyValue(String(getRawLotActivityTimestamp(lot) || '')))
          .filter(Boolean)
          .sort((aValue, bValue) => aValue.localeCompare(bValue));
      const rangeFrom = recentActivityAppliedFromDate || datedRows[0] || defaultRecentActivityDateRange.from;
      const rangeTo = recentActivityAppliedToDate || datedRows[datedRows.length - 1] || rangeFrom;
      const fromSegment = getDateOnlyValue(rangeFrom).replaceAll('-', '');
      const toSegment = getDateOnlyValue(rangeTo).replaceAll('-', '');
      a.download = `comp_in_from_${fromSegment}_to_${toSegment}.csv`;
      a.click();
      URL.revokeObjectURL(url);
  };

  // Determine item type for rendering appropriate QC sections
  const getItemType = (itemId: string) => {
      const item = inventory.find(i => i.component_id === itemId);
      return item ? item.type : null;
  };

  return (
    <div className="flex flex-col gap-8 animate-in fade-in">
        
        {/* Top Row: Pre-arrival registration, pre-arrival queue, and quarantine */}
        <div className={topRowLayoutClass}>
            <div className="flex flex-col gap-6">
                <div className="bg-white p-4 sm:p-6 rounded-xl border border-slate-200 shadow-sm flex flex-col">
                    <div className="flex justify-between items-center mb-6 border-b border-slate-100 pb-4 flex-shrink-0">
                        <h3 className="font-bold text-slate-800 flex items-center">
                            <Truck className="w-5 h-5 mr-2 text-indigo-600" /> Pre-Arrival Registration
                        </h3>
                    </div>

                    <div className="space-y-5">
                        <div>
                            <label className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Item Category</label>
                            <select
                                className="w-full border-slate-300 rounded-lg text-sm shadow-sm font-medium text-slate-700 py-2.5 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                                value={selectedCompInCategory}
                                onChange={e => {
                                    const nextCategory = e.target.value as UiItemCategory | '';
                                    setSelectedCompInCategory(nextCategory);
                                    setCompIn(prev => ({ ...prev, itemId: '', unit: '' }));
                                }}
                                disabled={isReadOnly}
                            >
                                <option value="">-- Select Category --</option>
                                {UI_ITEM_CATEGORIES.map(category => (
                                    <option key={category} value={category}>{category}</option>
                                ))}
                            </select>
                        </div>

                        <div>
                            <label className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Item</label>
                            <select
                                className="w-full border-slate-300 rounded-lg text-sm shadow-sm font-medium text-slate-700 py-2.5 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                                value={compIn.itemId}
                                onChange={e => {
                                    const nextItemId = e.target.value;
                                    const item = compInOptions.find(o => o.id === nextItemId);
                                    const latestLot = latestLotByItemId.get(normalizeId(nextItemId));
                                    const autoSupplier = String(latestLot?.supplier || '').trim();
                                    const autoPrice = latestLot ? String(resolveRawLotLandedUnitPrice(latestLot) || '') : '';
                                    setCompIn(prev => ({
                                        ...prev,
                                        itemId: nextItemId,
                                        unit: item?.unit || 'unit',
                                        supplier: autoSupplier,
                                        plannedPrice: autoPrice,
                                    }));
                                }}
                                disabled={!selectedCompInCategory || isReadOnly}
                            >
                                <option value="">{selectedCompInCategory ? '-- Select Component --' : 'Select category first'}</option>
                                {Object.entries(groupedCompInOptions).map(([group, opts]) => (
                                    <optgroup key={group} label={group.toUpperCase()} className="text-indigo-600 font-bold">
                                        {(opts as typeof compInOptions).map(o => (
                                            <option key={o.id} value={o.id} className="text-slate-700 font-medium">
                                                [{o.id}] {o.name}{o.note ? ` — ${o.note}` : ''}
                                            </option>
                                        ))}
                                    </optgroup>
                                ))}
                            </select>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Purchase Order Number</label>
                                <input
                                    type="text"
                                    className="w-full border-slate-300 rounded-lg text-sm shadow-sm py-2.5"
                                    placeholder="Stored as procurementRef"
                                    value={compIn.procurementRef}
                                    onChange={e => setCompIn({...compIn, procurementRef: e.target.value})}
                                    disabled={isReadOnly}
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Supplier</label>
                                <input
                                    type="text"
                                    className="w-full border-slate-300 rounded-lg text-sm shadow-sm py-2.5"
                                    placeholder="Supplier Name"
                                    value={compIn.supplier}
                                    onChange={e => setCompIn({...compIn, supplier: e.target.value})}
                                    list="supplier-options"
                                    disabled={isReadOnly}
                                />
                                <datalist id="supplier-options">
                                    {uniqueSuppliersList.map(s => <option key={s} value={s} />)}
                                </datalist>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Quantity</label>
                                <input type="number" step="0.0001" className="w-full border-slate-300 rounded-lg text-sm shadow-sm py-2.5 font-bold" placeholder="0.00" value={compIn.quantity} onChange={e => setCompIn({...compIn, quantity: e.target.value})} disabled={isReadOnly}/>
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Unit</label>
                                <select className="w-full border-slate-300 rounded-lg text-sm shadow-sm font-bold text-indigo-600 py-2.5" value={compIn.unit} onChange={e => setCompIn({...compIn, unit: e.target.value})} disabled={isReadOnly}>
                                    <option value="">-- Unit --</option>
                                    {selectedCompInUnit && !SAFE_UNITS.includes(selectedCompInUnit) && (
                                        <option key={selectedCompInUnit} value={selectedCompInUnit}>{selectedCompInUnit}</option>
                                    )}
                                    {SAFE_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                                </select>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Planned Unit Price (£)</label>
                                <input type="number" step="0.0001" className="w-full border-slate-300 rounded-lg text-sm shadow-sm py-2.5" placeholder="0.00" value={compIn.plannedPrice} onChange={e => setCompIn({...compIn, plannedPrice: e.target.value})} disabled={isReadOnly}/>
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Shipping Cost (£)</label>
                                <input type="number" step="0.0001" className="w-full border-slate-300 rounded-lg text-sm shadow-sm py-2.5" placeholder="Optional" value={compIn.shippingCost} onChange={e => setCompIn({...compIn, shippingCost: e.target.value})} disabled={isReadOnly}/>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Paid Date</label>
                                <input type="date" className="w-full border-slate-300 rounded-lg text-sm shadow-sm py-2.5" value={compIn.paidDate} onChange={e => setCompIn({...compIn, paidDate: e.target.value})} disabled={isReadOnly}/>
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-slate-500 mb-1.5 uppercase tracking-wider">Expected Delivery Date</label>
                                <input type="date" className="w-full border-slate-300 rounded-lg text-sm shadow-sm py-2.5" value={compIn.expectedDeliveryDate} onChange={e => setCompIn({...compIn, expectedDeliveryDate: e.target.value})} disabled={isReadOnly}/>
                            </div>
                        </div>

                        <div className="pt-4 border-t border-slate-100">
                            <button
                                onClick={handleCompIn}
                                disabled={isReceiving || isReadOnly}
                                className="w-full bg-indigo-600 text-white py-3.5 rounded-lg font-bold shadow-md hover:bg-indigo-700 transition flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {isReceiving ? (
                                    <><Loader2 className="w-5 h-5 mr-2 animate-spin" /> Registering...</>
                                ) : (
                                    <><Truck className="w-5 h-5 mr-2" /> Register Pre-Arrival</>
                                )}
                            </button>
                            <p className="text-[10px] text-slate-400 mt-2 text-center">
                                This creates an on-the-way procurement record. QC will move it into quarantine when goods arrive.
                            </p>
                        </div>
                    </div>
                </div>

                <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden flex flex-col">
                    <div className="bg-slate-50 px-4 sm:px-6 py-4 border-b border-slate-200 flex justify-between items-center flex-shrink-0">
                        <h4 className="text-slate-700 font-bold text-sm uppercase tracking-wider flex items-center">
                            <Truck className="w-4 h-4 mr-2 text-slate-500" /> Pre-Arrival Procurement Box
                        </h4>
                        <span className="text-[10px] font-bold text-slate-600 bg-white px-2 py-0.5 rounded border border-slate-200 shadow-sm">
                            {preArrivalLots.length} On The Way
                        </span>
                    </div>

                    <div className="bg-white">
                        <table className="w-full text-sm text-left table-fixed">
                            <thead className="bg-white text-slate-500 font-bold uppercase text-[10px] tracking-wider border-b border-slate-100">
                                <tr>
                                    <th className="px-4 sm:px-6 py-3">Details</th>
                                    <th className="px-4 sm:px-6 py-3 text-right w-[13rem]">Action</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 bg-slate-50/40">
                                {preArrivalLots.map((lot) => {
                                    const itemName = componentLabelById[lot.itemId] || lot.itemId;
                                    const categoryPrefix = componentCategoryPrefixById[lot.itemId];
                                    const displayLabel = [categoryPrefix, itemName].filter(Boolean).join(' • ');
                                    const displayQty = getRawLotDisplayQuantity(lot);
                                    const lotId = getRawLotRowId(lot);
                                    const isExpanded = expandedPreArrivalIds.has(lotId);
                                    return (
                                        <tr key={lotId} className="hover:bg-slate-50 transition-colors">
                                            <td className="px-4 sm:px-6 py-3 align-top min-w-0">
                                                <button
                                                    type="button"
                                                    onClick={() => togglePreArrivalExpanded(lotId)}
                                                    className="w-full flex items-center gap-2 text-left min-w-0"
                                                    aria-expanded={isExpanded}
                                                    aria-controls={`pre-arrival-details-${lotId}`}
                                                >
                                                    <span className="text-slate-400 flex-shrink-0">
                                                        {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                                                    </span>
                                                    <span
                                                        className="block min-w-0 text-[clamp(11px,1.35vw,15px)] font-semibold text-slate-700 leading-snug break-words line-clamp-2"
                                                        title={displayLabel}
                                                    >
                                                        {displayLabel}
                                                    </span>
                                                </button>
                                                {isExpanded && (
                                                    <div id={`pre-arrival-details-${lotId}`} className="mt-2 pl-6 space-y-1">
                                                        <div className="text-[11px] text-slate-500 break-all">
                                                            PO: <span className="font-mono text-slate-600">{lot.procurementRef || '—'}</span>
                                                        </div>
                                                        <div className="text-[11px] text-slate-500 leading-snug break-words">
                                                            Supplier: <span className="text-slate-600">{lot.supplier || 'Supplier not set'}</span>
                                                        </div>
                                                        <div className="text-[11px] text-slate-500 leading-snug">
                                                            Quantity: <span className="font-mono text-slate-600">{displayQty.toLocaleString()} {lot.unit || ''}</span>
                                                        </div>
                                                        <div className="text-[11px] text-slate-500 leading-snug">
                                                            Paid: <span className="font-mono text-slate-600">{getDateOnlyValue(lot.paidDate || '') || '—'}</span>
                                                        </div>
                                                        <div className="text-[11px] text-slate-500 leading-snug">
                                                            Expected: <span className="font-mono text-slate-600">{getDateOnlyValue(lot.expectedDeliveryDate || '') || '—'}</span>
                                                        </div>
                                                    </div>
                                                )}
                                            </td>
                                            <td className="px-4 sm:px-6 py-3 text-right align-middle w-[13rem]">
                                                {!isReadOnly && (
                                                    <div className="flex justify-end items-center gap-2 flex-wrap">
                                                        <button
                                                            onClick={() => handleRequestDelete(lot)}
                                                            className="p-1.5 bg-white border border-red-200 text-red-600 rounded-lg hover:bg-red-600 hover:text-white transition shadow-sm"
                                                            title="Delete Pre-Arrival Record"
                                                        >
                                                            <Trash2 className="w-4 h-4" />
                                                        </button>
                                                        <button
                                                            onClick={() => handleOpenEdit(lot)}
                                                            className="p-1.5 bg-white border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-700 hover:text-white transition shadow-sm"
                                                            title="Edit Pre-Arrival Record"
                                                        >
                                                            <Edit className="w-4 h-4" />
                                                        </button>
                                                        <button
                                                            onClick={() => handleRequestMoveToQuarantine(lot)}
                                                            className="p-1.5 bg-white border border-orange-200 text-orange-600 rounded-lg hover:bg-orange-600 hover:text-white transition shadow-sm"
                                                            title="Move to QC Quarantine"
                                                        >
                                                            <SquareArrowRight className="w-4 h-4" />
                                                        </button>
                                                    </div>
                                                )}
                                            </td>
                                        </tr>
                                    );
                                })}
                                {preArrivalLots.length === 0 && (
                                    <tr>
                                        <td colSpan={2} className="py-10 text-center text-slate-400 italic">
                                            No pre-arrival records yet.
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            <div className="bg-white border border-orange-200 rounded-xl shadow-sm overflow-hidden flex flex-col">
                <div className="bg-orange-50 px-4 sm:px-6 py-4 border-b border-orange-200 flex justify-between items-center flex-shrink-0">
                    <h4 className="text-orange-900 font-bold text-sm uppercase tracking-wider flex items-center">
                        <Lock className="w-4 h-4 mr-2" /> QC Quarantine Box
                    </h4>
                    <span className="text-[10px] font-bold text-orange-600 bg-white px-2 py-0.5 rounded border border-orange-200 shadow-sm">
                        {quarantineLots.length} Items Pending
                    </span>
                </div>

                <div className="mobile-scroll-hint px-4 pt-3">Swipe sideways to manage QC details and release-ready lots.</div>
                <div className="mobile-table-region overflow-x-auto md:overflow-visible bg-white">
                    <table className="w-full min-w-[720px] md:min-w-full md:table-fixed text-sm text-left relative">
                        <colgroup>
                            <col className="md:w-[54%]" />
                            <col className="md:w-[20%]" />
                            <col className="md:w-[30%]" />
                        </colgroup>
                        <thead className="bg-white text-orange-400 font-bold uppercase text-[10px] tracking-wider border-b border-orange-100 sticky top-0 z-10 shadow-sm">
                            <tr>
                                <th className="px-4 sm:px-6 py-3 bg-orange-50/90 backdrop-blur-sm">Item Details</th>
                                <th className="px-4 sm:px-6 py-3 bg-orange-50/90 backdrop-blur-sm w-40">Status</th>
                                <th className="px-4 sm:px-6 py-3 bg-orange-50/90 backdrop-blur-sm text-right">Edit</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-orange-50 bg-orange-50/10">
                            {quarantineLots.map((lot, idx) => {
                                const itemName = componentLabelById[lot.itemId] || lot.itemId;
                                const statusLower = (lot.qcStatus || '').trim().toLowerCase();
                                const canRelease = statusLower === 'qc passed';

                                let statusClass = 'bg-orange-100 text-orange-700 border-orange-200';
                                if (canRelease) statusClass = 'bg-green-100 text-green-700 border-green-200';
                                else if (statusLower === 'rejected') statusClass = 'bg-red-100 text-red-700 border-red-200';

                                return (
                                    <tr key={getRawLotRowId(lot) || idx} className="hover:bg-orange-50/50 transition-colors group">
                                        <td className="px-4 sm:px-6 py-3 min-w-0">
                                            <div className="font-bold text-slate-700 break-words md:truncate" title={itemName}>{itemName}</div>
                                            <div className="text-[10px] text-slate-400 font-mono break-all">{lot.qc_number}</div>
                                            <div className="text-[10px] text-slate-500 mt-0.5 break-words">
                                                <span>{lot.supplier || 'Supplier not set'}</span>
                                                <span className="mx-1.5 text-slate-300">|</span>
                                                <span className="font-mono">
                                                    {Number.isFinite(Number(lot.received_qty)) ? Number(lot.received_qty).toLocaleString() : '—'} {lot.unit || ''}
                                                </span>
                                            </div>
                                        </td>
                                        <td className="px-3 sm:px-6 py-3 w-40 md:w-auto">
                                            {isReadOnly ? (
                                                <span className={`inline-flex min-w-[9.5rem] lg:min-w-[8.25rem] xl:min-w-[7.5rem] md:w-full md:justify-center px-2 py-1 rounded-full text-[10px] font-bold uppercase whitespace-nowrap ${statusClass}`}>
                                                    {lot.qcStatus}
                                                </span>
                                            ) : (
                                                <select
                                                    className={`w-full min-w-[9.5rem] lg:min-w-[8.25rem] xl:min-w-[7.5rem] md:min-w-0 text-xs font-bold uppercase rounded-md border py-1 pl-2 pr-8 cursor-pointer focus:ring-2 focus:ring-indigo-500 outline-none whitespace-nowrap ${statusClass}`}
                                                    value={lot.qcStatus || 'On hold'}
                                                    onChange={(e) => {
                                                        if (onUpdateLot) {
                                                            const nextStatus = e.target.value;
                                                            onUpdateLot(
                                                                getLotUpdateRequestId(lot),
                                                                {
                                                                    qcStatus: nextStatus,
                                                                    workflow_stage: nextStatus === 'Rejected' ? 'REJECTED' : 'QUARANTINE',
                                                                },
                                                                "Quick Status Change",
                                                                currentUser
                                                            );
                                                        }
                                                    }}
                                                >
                                                    <option value="On hold">On hold</option>
                                                    <option value="QC passed">QC passed</option>
                                                    <option value="Rejected">Rejected</option>
                                                </select>
                                            )}
                                        </td>
                                        <td className="px-3 sm:px-6 py-3 text-right md:w-[10rem] xl:w-[9.5rem]">
                                            {!isReadOnly && (
                                                <div className="flex justify-end items-center gap-1.5 whitespace-nowrap">
                                                    <button
                                                        onClick={() => handleRequestReturnToPreArrival(lot)}
                                                        className="p-1.5 text-slate-400 hover:text-orange-600 hover:bg-orange-50 rounded transition"
                                                        title="Move Back to Pre-Arrival"
                                                    >
                                                        <Undo2 className="w-4 h-4" />
                                                    </button>
                                                    <button
                                                        onClick={() => handleOpenEdit(lot)}
                                                        className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition"
                                                        title="Edit / QC Check"
                                                    >
                                                        <Edit className="w-4 h-4" />
                                                    </button>
                                                    <button
                                                        onClick={() => handleRequestRelease(lot)}
                                                        className={`p-1.5 rounded transition ${
                                                            canRelease
                                                            ? 'text-green-600 hover:bg-green-50'
                                                            : 'text-slate-300 opacity-50 cursor-not-allowed'
                                                        }`}
                                                        title="Release to Inventory"
                                                    >
                                                        <CheckCircle className="w-4 h-4" />
                                                    </button>
                                                </div>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                            {quarantineLots.length === 0 && (
                                <tr>
                                    <td colSpan={3} className="py-12 text-center text-slate-400 italic">
                                        <ShieldCheck className="w-8 h-8 mx-auto mb-2 opacity-20" />
                                        Box is empty. Move an arriving item into quarantine to start QC.
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
                            disabled={releasableQuarantineLots.length === 0 || isProcessingRelease || isProcessingBulkRelease}
                            className="px-4 py-2 text-sm font-bold text-white bg-green-600 hover:bg-green-700 rounded-lg shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                        >
                            {isProcessingBulkRelease && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                            Release All
                        </button>
                    </div>
                )}
            </div>
        </div>

        {/* Bottom Row: Recent Activity */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden min-h-[18rem] md:h-[420px] flex flex-col">
            <div className="bg-slate-50 px-4 sm:px-6 py-4 border-b border-slate-200 flex-shrink-0">
                <h4 className="text-slate-600 font-bold text-xs uppercase tracking-wider flex items-center">
                    <History className="w-4 h-4 mr-2" /> Recent Activity
                </h4>
                <ActivityFilterBar
                    fromDate={recentActivityDraftFromDate}
                    toDate={recentActivityDraftToDate}
                    onChangeFrom={setRecentActivityDraftFromDate}
                    onChangeTo={setRecentActivityDraftToDate}
                    rightSideControls={(
                        <div className={activityFilterLayoutClass}>
                            <div>
                                <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Supplier</label>
                                <select
                                    value={recentActivityDraftSupplier}
                                    onChange={(e) => setRecentActivityDraftSupplier(e.target.value)}
                                    className={`${filterFieldClass} appearance-none`}
                                >
                                    <option value="all">All</option>
                                    {recentActivitySupplierOptions.map((supplier) => (
                                        <option key={supplier} value={supplier}>{supplier}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Global Search</label>
                                <input
                                    type="text"
                                    value={recentActivityDraftSearchQuery}
                                    onChange={(e) => setRecentActivityDraftSearchQuery(e.target.value)}
                                    placeholder="Item, QC #, PO #, supplier, user, QC, notes..."
                                    className={filterFieldClass}
                                />
                            </div>
                        </div>
                    )}
                    onApply={applyRecentActivityFilters}
                    onReset={resetRecentActivityFilters}
                    onExport={downloadRecentActivityCsv}
                    exportDisabled={sortedRecentQcActivity.length === 0}
                />
            </div>
            <div className="mobile-table-region overflow-x-auto overflow-y-visible md:overflow-y-auto flex-1 min-h-0">
                <table className="w-full table-fixed text-sm text-left">
                    <thead className="sticky top-0 z-10 bg-white text-slate-500 font-bold uppercase text-[10px] tracking-widest border-b border-slate-200">
                        <tr>
                            <SortableHeader
                                className="w-[16%] px-4 py-3"
                                label="Date"
                                sortKey="date"
                                activeSortKey={recentActivitySortState.key}
                                sortDir={recentActivitySortState.dir}
                                onChange={(key, dir) => setRecentActivitySortState({ key: key as RecentActivitySortKey, dir })}
                            />
                            <SortableHeader
                                className="w-[29%] px-4 py-3"
                                label="Item"
                                sortKey="item"
                                activeSortKey={recentActivitySortState.key}
                                sortDir={recentActivitySortState.dir}
                                onChange={(key, dir) => setRecentActivitySortState({ key: key as RecentActivitySortKey, dir })}
                            />
                            <SortableHeader
                                className="w-[11%] px-4 py-3 text-right"
                                label="Qty"
                                sortKey="qty"
                                activeSortKey={recentActivitySortState.key}
                                sortDir={recentActivitySortState.dir}
                                onChange={(key, dir) => setRecentActivitySortState({ key: key as RecentActivitySortKey, dir })}
                            />
                            <SortableHeader
                                className="w-[12%] px-4 py-3 text-right"
                                label="Unit Cost"
                                sortKey="unitCost"
                                activeSortKey={recentActivitySortState.key}
                                sortDir={recentActivitySortState.dir}
                                onChange={(key, dir) => setRecentActivitySortState({ key: key as RecentActivitySortKey, dir })}
                            />
                            <SortableHeader
                                className="w-[12%] px-4 py-3"
                                label="QC"
                                sortKey="qc"
                                activeSortKey={recentActivitySortState.key}
                                sortDir={recentActivitySortState.dir}
                                onChange={(key, dir) => setRecentActivitySortState({ key: key as RecentActivitySortKey, dir })}
                            />
                            <SortableHeader
                                className="w-[12%] px-4 py-3"
                                label="User"
                                sortKey="user"
                                activeSortKey={recentActivitySortState.key}
                                sortDir={recentActivitySortState.dir}
                                onChange={(key, dir) => setRecentActivitySortState({ key: key as RecentActivitySortKey, dir })}
                            />
                            <th className="w-[8%] px-4 py-3 text-center">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {sortedRecentQcActivity.map(lot => {
                            const displayName = componentOverviewLabelById[lot.itemId] || lot.itemId;
                            const supplier = lot.supplier || '—';
                            const quantity = `${getRawLotDisplayQuantity(lot)} ${lot.unit || ''}`.trim();
                            const unitPrice = resolveRawLotLandedUnitPrice(lot).toFixed(2);
                            const isPreArrival = isPreArrivalRawLot(lot);
                            const statusLabel = isPreArrival ? 'On the way' : (lot.qcStatus || 'On hold');
                            const statusLower = String(statusLabel).trim().toLowerCase();
                            const qcTone = isPreArrival
                                ? 'bg-slate-100 text-slate-600 border-slate-200'
                                : statusLower.includes('pass')
                                ? 'bg-emerald-50 text-emerald-700 border-emerald-100'
                                : (statusLower.includes('reject') || statusLower.includes('fail'))
                                    ? 'bg-red-50 text-red-700 border-red-100'
                                    : 'bg-amber-50 text-amber-700 border-amber-100';
                            return (
                                <tr key={getRawLotRowId(lot)} className={`${isPreArrival ? 'bg-slate-50/80' : 'bg-white'} hover:bg-slate-50 transition-colors`}>
                                    <td className="px-4 py-3 align-top">
                                        <div className="text-slate-700 font-medium whitespace-nowrap">{formatBritishDate(getRawLotActivityTimestamp(lot) || Date.now())}</div>
                                        <div className="text-xs text-slate-400 font-mono whitespace-nowrap">{formatBritishTime(getRawLotActivityTimestamp(lot) || Date.now())}</div>
                                    </td>
                                    <td className="px-4 py-3 align-top">
                                        <div className="font-medium text-slate-700 break-words leading-snug" title={displayName}>{displayName}</div>
                                        {lot.qc_number && (
                                            <div className="mt-1 text-[11px] text-slate-500 leading-snug break-words" title={`QC ${lot.qc_number}`}>
                                                <span className="font-mono text-slate-600">{lot.qc_number}</span>
                                            </div>
                                        )}
                                        {lot.procurementRef && (
                                            <div className="text-[11px] text-slate-500 leading-snug break-words">
                                                PO: <span className="font-mono text-slate-600">{lot.procurementRef}</span>
                                            </div>
                                        )}
                                        <div className="text-[11px] text-slate-500 leading-snug break-words" title={supplier}>
                                            {supplier}
                                        </div>
                                    </td>
                                    <td className="px-4 py-3 text-right font-mono text-xs text-slate-600 align-top whitespace-nowrap">{quantity}</td>
                                    <td className="px-4 py-3 text-right font-mono text-xs text-slate-600 align-top whitespace-nowrap">{unitPrice}</td>
                                    <td className="px-4 py-3 align-top">
                                        <span className={`inline-flex max-w-full text-[10px] font-black uppercase px-2 py-0.5 rounded border ${qcTone}`}>
                                            {statusLabel}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3 text-xs text-slate-500 align-top break-words">
                                        {getRawLotActivityUser(lot) || 'System'}
                                    </td>
                                    <td className="px-4 py-3 text-center align-top">
                                        {!isReadOnly && (
                                            <div className="flex justify-center gap-1">
                                                <button
                                                    onClick={() => handleOpenEdit(lot)}
                                                    className="p-1.5 text-slate-400 hover:text-indigo-600 transition disabled:opacity-50 disabled:cursor-not-allowed"
                                                    title={isPreArrival ? 'Edit Pre-Arrival Record' : 'Edit / QC Check'}
                                                    aria-label={`Edit ${lot.qc_number || getRawLotRowId(lot)}`}
                                                >
                                                    <Edit className="w-4 h-4" />
                                                </button>
                                                <button
                                                    onClick={() => handleRequestDelete(lot)}
                                                    disabled={!onDeleteLot || isProcessingDelete}
                                                    className="p-1.5 text-slate-400 hover:text-red-600 transition disabled:opacity-50 disabled:cursor-not-allowed"
                                                    title="Delete Entry"
                                                    aria-label={`Delete ${lot.qc_number || getRawLotRowId(lot)}`}
                                                >
                                                    {isProcessingDelete && deleteConfirmLot && getRawLotRowId(deleteConfirmLot) === getRawLotRowId(lot)
                                                        ? <Loader2 className="w-4 h-4 animate-spin" />
                                                        : <Trash2 className="w-4 h-4" />}
                                                </button>
                                            </div>
                                        )}
                                    </td>
                                </tr>
                            );
                        })}
                        {sortedRecentQcActivity.length === 0 && (
                            <tr><td colSpan={7} className="py-8 text-center text-slate-400 italic">No recent activity matches your filters.</td></tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>

        {/* --- EDIT MODAL (The QC Workstation) --- */}
        {editingLot && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-0 sm:p-4 animate-in fade-in">
                <div className="bg-white rounded-none sm:rounded-2xl shadow-2xl max-w-4xl w-full h-[100dvh] sm:h-auto sm:max-h-[90vh] flex flex-col overflow-hidden border border-slate-200">
                    {/* Modal Header */}
                    <div className="px-4 sm:px-8 py-5 sm:py-6 bg-slate-50 border-b border-slate-200 flex justify-between items-start flex-shrink-0">
                        <div>
                            <div className="flex items-center space-x-3 mb-1">
                                <h3 className="text-xl font-bold text-slate-800">QC & Lot Management</h3>
                                <span className="px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded text-[10px] font-bold uppercase tracking-wider">
                                    {isPreArrivalRawLot(editingLot) ? 'On the way' : editingLot.qc_number}
                                </span>
                            </div>
                            <p className="text-sm text-slate-500 font-medium">
                                {componentLabelById[String(editForm.itemId || editingLot.itemId)] || String(editForm.itemId || editingLot.itemId)}
                            </p>
                        </div>
                        <button onClick={() => setEditingLot(null)} className="p-2 text-slate-400 hover:text-slate-600 rounded-full hover:bg-slate-200 transition">
                            <X className="w-6 h-6" />
                        </button>
                    </div>

                    {/* Modal Body (Scrollable) */}
                    <div className="flex-1 overflow-y-auto p-4 sm:p-8 space-y-8 bg-white">
                        <div className="space-y-4">
                            <h4 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center border-b border-slate-100 pb-2">
                                <Truck className="w-4 h-4 mr-2" /> Procurement Details
                            </h4>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Item Category</label>
                                    <select
                                        className="w-full border-slate-300 rounded-lg text-sm py-2"
                                        value={editItemCategory}
                                        onChange={(e) => {
                                            const nextCategory = e.target.value as UiItemCategory | '';
                                            setEditItemCategory(nextCategory);
                                            setEditForm((prev) => ({ ...prev, itemId: '', unit: '' }));
                                        }}
                                        disabled={isReadOnly}
                                    >
                                        <option value="">-- Select Category --</option>
                                        {UI_ITEM_CATEGORIES.map((category) => (
                                            <option key={category} value={category}>
                                                {category}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                <div className="md:col-span-2">
                                    <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Item Name</label>
                                    <select
                                        className="w-full border-slate-300 rounded-lg text-sm py-2"
                                        value={String(editForm.itemId || '')}
                                        onChange={(e) => {
                                            const nextItemId = e.target.value;
                                            const selectedItem = editItemOptions.find((option) => option.id === nextItemId);
                                            setEditForm((prev) => ({
                                                ...prev,
                                                itemId: nextItemId,
                                                unit: selectedItem?.unit || prev.unit || '',
                                            }));
                                        }}
                                        disabled={!editItemCategory || isReadOnly}
                                    >
                                        <option value="">{editItemCategory ? '-- Select Component --' : 'Select category first'}</option>
                                        {editItemOptions.map((option) => (
                                            <option key={option.id} value={option.id}>
                                                {option.name}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Purchase Order Number</label>
                                    <input className="w-full border-slate-300 rounded-lg text-sm py-2 font-mono" value={editForm.procurementRef || ''} onChange={e => setEditForm({...editForm, procurementRef: e.target.value})} />
                                </div>
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Supplier</label>
                                    <input className="w-full border-slate-300 rounded-lg text-sm py-2" value={editForm.supplier || ''} onChange={e => setEditForm({...editForm, supplier: e.target.value})} />
                                </div>
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Ordered Quantity</label>
                                    <div className="flex items-center gap-2">
                                        <input type="number" className="w-full border-slate-300 rounded-lg text-sm py-2 font-bold" value={editForm.ordered_qty ?? 0} onChange={e => setEditForm({...editForm, ordered_qty: Number(e.target.value)})} />
                                        <span className="text-xs font-bold text-slate-500">{editForm.unit || editingLot.unit}</span>
                                    </div>
                                </div>
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Planned Unit Price (£)</label>
                                    <input type="number" step="0.0001" className="w-full border-slate-300 rounded-lg text-sm py-2 font-bold" value={editForm.planned_unit_price ?? ''} onChange={e => setEditForm({...editForm, planned_unit_price: e.target.value === '' ? 0 : Number(e.target.value)})} />
                                </div>
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Shipping Cost (£)</label>
                                    <input type="number" step="0.0001" className="w-full border-slate-300 rounded-lg text-sm py-2 font-bold" value={editForm.shipping_cost ?? ''} onChange={e => setEditForm({...editForm, shipping_cost: e.target.value === '' ? 0 : Number(e.target.value)})} />
                                </div>
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Actual Unit Price (£)</label>
                                    <input type="text" className="w-full border-slate-200 bg-slate-50 rounded-lg text-sm py-2 font-bold text-slate-600" value={resolveRawLotLandedUnitPrice({ ...editingLot, ...editForm }).toFixed(4)} readOnly />
                                </div>
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Paid Date</label>
                                    <input type="date" className="w-full border-slate-300 rounded-lg text-sm py-2" value={getDateOnlyValue(String(editForm.paidDate || ''))} onChange={e => setEditForm({...editForm, paidDate: e.target.value})} />
                                </div>
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Expected Delivery Date</label>
                                    <input type="date" className="w-full border-slate-300 rounded-lg text-sm py-2" value={getDateOnlyValue(String(editForm.expectedDeliveryDate || ''))} onChange={e => setEditForm({...editForm, expectedDeliveryDate: e.target.value})} />
                                </div>
                                <div className="hidden md:block" aria-hidden="true" />
                                <div className="md:col-span-3">
                                    <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Procurement Notes</label>
                                    <textarea className="w-full border-slate-300 rounded-lg text-sm py-2 h-20 resize-none" value={editForm.procurementNotes || ''} onChange={e => setEditForm({...editForm, procurementNotes: e.target.value})} />
                                </div>
                            </div>
                        </div>

                        {!isPreArrivalRawLot(editingLot) && (
                            <div className="space-y-4">
                                <h4 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center border-b border-slate-100 pb-2">
                                    <Calendar className="w-4 h-4 mr-2" /> Traceability & Origin
                                </h4>
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                                    <div>
                                        <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Manufacturer</label>
                                        <input className="w-full border-slate-300 rounded-lg text-sm py-2" value={editForm.manufacturer || ''} onChange={e => setEditForm({...editForm, manufacturer: e.target.value})} />
                                    </div>
                                    <div>
                                        <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Batch Number (Mfg)</label>
                                        <input className="w-full border-slate-300 rounded-lg text-sm py-2 font-mono" value={editForm.mfgBatch || ''} onChange={e => setEditForm({...editForm, mfgBatch: e.target.value})} placeholder="e.g. B-2023-XYZ" />
                                    </div>
                                    <div className="hidden md:block" aria-hidden="true" />
                                    <div>
                                        <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Mfg Date</label>
                                        <input type="date" className="w-full border-slate-300 rounded-lg text-sm py-2" value={editForm.mfgDate || ''} onChange={e => setEditForm({...editForm, mfgDate: e.target.value})} />
                                    </div>
                                    <div>
                                        <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Expiry Date</label>
                                        <input type="date" className="w-full border-slate-300 rounded-lg text-sm py-2" value={editForm.expDate || ''} onChange={e => setEditForm({...editForm, expDate: e.target.value})} />
                                    </div>
                                    <div className="hidden md:block" aria-hidden="true" />
                                    <div>
                                        <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Delivery Date</label>
                                        <input type="date" className="w-full border-slate-300 rounded-lg text-sm py-2" value={getDateOnlyValue(String(editForm.deliveryDate || ''))} onChange={e => setEditForm({...editForm, deliveryDate: e.target.value})} />
                                    </div>
                                    <div>
                                        <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Received Quantity</label>
                                        <div className="flex items-center gap-2">
                                            <input type="number" className="w-full border-slate-300 rounded-lg text-sm py-2 font-bold" value={editForm.received_qty} onChange={e => setEditForm({...editForm, received_qty: Number(e.target.value)})} />
                                            <span className="text-xs font-bold text-slate-500">{editForm.unit || editingLot.unit}</span>
                                        </div>
                                    </div>
                                    <div>
                                        <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Location</label>
                                        <select className="w-full border-slate-300 rounded-lg text-sm py-2" value={editForm.location || ''} onChange={e => setEditForm({...editForm, location: e.target.value as LocationName | ''})}>
                                            <option value="">-- Select Location --</option>
                                            <option value="Riverside">Riverside</option>
                                            <option value="Hilltop">Hilltop</option>
                                        </select>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* CONDITIONAL SECTIONS BASED ON TYPE */}
                        {!isPreArrivalRawLot(editingLot) && (() => {
                            const itemType = getItemType(String(editForm.itemId || editingLot.itemId));
                            return (
                                <>
                                    {/* Section 2: QC Parameters & Docs (INGREDIENT ONLY) */}
                                    {itemType === 'INGREDIENT' && (
                                        <div className="space-y-4">
                                            <h4 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center border-b border-slate-100 pb-2">
                                                <Beaker className="w-4 h-4 mr-2" /> QC Parameters & Docs
                                            </h4>
                                            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                                                <div className="space-y-4">
                                                    <label className="block text-[10px] font-bold text-slate-500 uppercase">Documents on File?</label>
                                                    <div className="flex flex-col gap-2">
                                                        {['TDS', 'SDS', 'CoA'].map(doc => (
                                                            <div key={doc} className="flex items-center justify-between bg-slate-50 p-2 rounded border border-slate-200">
                                                                <span className="text-xs font-bold text-slate-700">{doc}</span>
                                                                <select 
                                                                    className="text-xs border-slate-300 rounded py-1 px-2"
                                                                    value={(editForm as any)[`${doc.toLowerCase()}Stored`] || 'No'}
                                                                    onChange={e => setEditForm({...editForm, [`${doc.toLowerCase()}Stored`]: e.target.value})}
                                                                >
                                                                    <option value="Yes">Yes</option>
                                                                    <option value="No">No</option>
                                                                </select>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                                <div className="md:col-span-3 grid grid-cols-2 gap-4">
                                                    <div>
                                                        <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Appearance</label>
                                                        <input className="w-full border-slate-300 rounded-lg text-sm py-2" placeholder="Visual check..." value={editForm.appearance || ''} onChange={e => setEditForm({...editForm, appearance: e.target.value})} />
                                                    </div>
                                                    <div>
                                                        <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">pH</label>
                                                        <input className="w-full border-slate-300 rounded-lg text-sm py-2" placeholder="e.g. 7.0" value={editForm.ph || ''} onChange={e => setEditForm({...editForm, ph: e.target.value})} />
                                                    </div>
                                                    <div>
                                                        <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Moisture / LOD</label>
                                                        <input className="w-full border-slate-300 rounded-lg text-sm py-2" placeholder="e.g. < 1%" value={editForm.lodMoisture || ''} onChange={e => setEditForm({...editForm, lodMoisture: e.target.value})} />
                                                    </div>
                                                    <div>
                                                        <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Micro / CFU</label>
                                                        <input className="w-full border-slate-300 rounded-lg text-sm py-2" placeholder="e.g. < 100" value={editForm.cfu || ''} onChange={e => setEditForm({...editForm, cfu: e.target.value})} />
                                                    </div>
                                                    <div>
                                                        <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Titration</label>
                                                        <input className="w-full border-slate-300 rounded-lg text-sm py-2" placeholder="Result..." value={editForm.titration || ''} onChange={e => setEditForm({...editForm, titration: e.target.value})} />
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {/* Section 2.5: Packaging Checks (PRIMARY PACKAGING & LABEL ONLY) */}
                                    {(itemType === 'PRIMARY_PACKAGING' || itemType === 'LABEL') && (
                                        <div className="space-y-4">
                                            <h4 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center border-b border-slate-100 pb-2">
                                                <Box className="w-4 h-4 mr-2" /> Visual & Packaging Checks
                                            </h4>
                                            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                                                <div>
                                                    <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Material Check</label>
                                                    <select 
                                                        className="w-full border-slate-300 rounded-lg text-sm py-2"
                                                        value={editForm.checkMaterial || 'N/A'}
                                                        onChange={e => setEditForm({...editForm, checkMaterial: e.target.value as any})}
                                                    >
                                                        <option value="N/A">N/A</option>
                                                        <option value="Pass">Pass</option>
                                                        <option value="Fail">Fail</option>
                                                    </select>
                                                </div>
                                                <div>
                                                    <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Printing Check</label>
                                                    <select 
                                                        className="w-full border-slate-300 rounded-lg text-sm py-2"
                                                        value={editForm.checkPrinting || 'N/A'}
                                                        onChange={e => setEditForm({...editForm, checkPrinting: e.target.value as any})}
                                                    >
                                                        <option value="N/A">N/A</option>
                                                        <option value="Pass">Pass</option>
                                                        <option value="Fail">Fail</option>
                                                    </select>
                                                </div>
                                                <div>
                                                    <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Size Check</label>
                                                    <select 
                                                        className="w-full border-slate-300 rounded-lg text-sm py-2"
                                                        value={editForm.checkSize || 'N/A'}
                                                        onChange={e => setEditForm({...editForm, checkSize: e.target.value as any})}
                                                    >
                                                        <option value="N/A">N/A</option>
                                                        <option value="Pass">Pass</option>
                                                        <option value="Fail">Fail</option>
                                                    </select>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {/* Section 2.6: General Item Verification (CONSUMABLE, DISPENSING, SECONDARY, PALLET) */}
                                    {['CONSUMABLE', 'DISPENSING', 'SECONDARY_PACKAGING', 'PALLET', 'PALLET_LOGISTICS'].includes(itemType || '') && (
                                        <div className="space-y-4">
                                            <h4 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center border-b border-slate-100 pb-2">
                                                <CheckSquare className="w-4 h-4 mr-2" /> Item Verification
                                            </h4>
                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                                <div>
                                                    <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Correct Item?</label>
                                                    <select 
                                                        className="w-full border-slate-300 rounded-lg text-sm py-2"
                                                        value={editForm.checkCorrectItem || 'N/A'}
                                                        onChange={e => setEditForm({...editForm, checkCorrectItem: e.target.value as any})}
                                                    >
                                                        <option value="N/A">N/A</option>
                                                        <option value="Pass">Pass</option>
                                                        <option value="Fail">Fail</option>
                                                    </select>
                                                </div>
                                                <div>
                                                    <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Correct Quantity?</label>
                                                    <select 
                                                        className="w-full border-slate-300 rounded-lg text-sm py-2"
                                                        value={editForm.checkCorrectQuantity || 'N/A'}
                                                        onChange={e => setEditForm({...editForm, checkCorrectQuantity: e.target.value as any})}
                                                    >
                                                        <option value="N/A">N/A</option>
                                                        <option value="Pass">Pass</option>
                                                        <option value="Fail">Fail</option>
                                                    </select>
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </>
                            );
                        })()}

                        {/* Section 3: Status & Notes */}
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                            {!isPreArrivalRawLot(editingLot) && (
                                <div>
                                    <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">QC Status</label>
                                    <select 
                                        className="w-full border-slate-300 rounded-lg text-sm py-2 font-bold"
                                        value={editForm.qcStatus || 'On hold'}
                                        onChange={e => setEditForm({...editForm, qcStatus: e.target.value})}
                                    >
                                        <option value="On hold">On Hold (Quarantine)</option>
                                        <option value="QC passed">QC Passed (Release Ready)</option>
                                        <option value="Rejected">Rejected</option>
                                    </select>
                                </div>
                            )}
                            {!isPreArrivalRawLot(editingLot) && (
                                <div className="md:col-span-3">
                                    <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">QC Notes</label>
                                    <textarea className="w-full border-slate-300 rounded-lg text-sm py-2 h-20 resize-none" placeholder="Observations, damage reports, etc..." value={editForm.qcNotes || ''} onChange={e => setEditForm({...editForm, qcNotes: e.target.value})} />
                                </div>
                            )}
                            {editingLot.history && (
                                <div className="md:col-span-3">
                                    <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Audit History</label>
                                    <div className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-[10px] font-mono text-slate-600 h-24 overflow-y-auto whitespace-pre-wrap">
                                        {editingLot.history}
                                    </div>
                                </div>
                            )}
                        </div>

                    </div>

                    {/* Modal Footer */}
                    <div className="px-4 sm:px-8 py-4 sm:py-5 bg-slate-50 border-t border-slate-200 flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-center flex-shrink-0">
                        <div className="flex flex-col sm:flex-row gap-3">
                            <button onClick={() => handleRequestDelete(editingLot)} disabled={!onDeleteLot || isProcessingDelete} className="w-full sm:w-auto px-4 py-2.5 border border-red-200 text-red-600 rounded-lg font-bold text-xs uppercase hover:bg-red-50 transition flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed">
                                <Trash2 className="w-4 h-4 mr-2" /> Delete Record
                            </button>
                        </div>
                        <div className="flex flex-col-reverse sm:flex-row gap-3">
                            <button onClick={() => setEditingLot(null)} className="w-full sm:w-auto px-6 py-2.5 text-slate-500 font-bold hover:text-slate-700">Cancel</button>
                            <button onClick={handleSaveEdit} disabled={isSavingEdit} className="w-full sm:w-auto px-8 py-2.5 bg-indigo-600 text-white rounded-lg font-bold shadow-md hover:bg-indigo-700 transition flex items-center justify-center">
                                {isSavingEdit ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                                Update Changes
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        )}

        {/* Confirmation Modals (Delete / Release) */}
        {deleteConfirmLot && (
            <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 animate-in fade-in">
                <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6 border border-slate-200">
                    <div className="flex items-center text-red-600 mb-4">
                        <AlertTriangle className="w-6 h-6 mr-3" />
                        <h3 className="text-lg font-bold text-slate-800">Delete Component In Record?</h3>
                    </div>
                    <p className="text-sm text-slate-600 mb-6">
                        Permanently remove <span className="font-mono font-bold bg-slate-100 px-1 rounded">{deleteConfirmLot.qc_number || deleteConfirmLot.procurementRef || getRawLotRowId(deleteConfirmLot)}</span> from Component In? This cannot be undone.
                    </p>
                    <div className="flex justify-end gap-3">
                        <button onClick={() => setDeleteConfirmLot(null)} className="px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-100 rounded-lg transition">Cancel</button>
                        <button onClick={handleConfirmDelete} disabled={isProcessingDelete} className="px-4 py-2 text-sm font-bold text-white bg-red-600 hover:bg-red-700 rounded-lg shadow-sm transition flex items-center">
                            {isProcessingDelete && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Delete
                        </button>
                    </div>
                </div>
            </div>
        )}

        {moveToQuarantineLot && (
            <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 animate-in fade-in">
                <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6 border border-slate-200">
                    <div className="flex items-center text-orange-600 mb-4">
                        <Lock className="w-6 h-6 mr-3" />
                        <h3 className="text-lg font-bold text-slate-800">Move To Quarantine</h3>
                    </div>
                    <p className="text-sm text-slate-600 mb-4">
                        This will generate the QC number, set today as the delivery date, and create the quarantine-ready lot record.
                    </p>
                    <div className="mb-6">
                        <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Location</label>
                        <select
                            value={moveToQuarantineLocation}
                            onChange={(e) => setMoveToQuarantineLocation(e.target.value as LocationName)}
                            className="w-full border-slate-300 rounded-lg text-sm shadow-sm py-2.5"
                        >
                            <option value="Riverside">Riverside</option>
                            <option value="Hilltop">Hilltop</option>
                        </select>
                    </div>
                    <div className="flex justify-end gap-3">
                        <button onClick={() => setMoveToQuarantineLot(null)} className="px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-100 rounded-lg transition">Cancel</button>
                        <button onClick={handleConfirmMoveToQuarantine} disabled={isProcessingMoveToQuarantine} className="px-4 py-2 text-sm font-bold text-white bg-orange-600 hover:bg-orange-700 rounded-lg shadow-sm transition flex items-center">
                            {isProcessingMoveToQuarantine && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Confirm
                        </button>
                    </div>
                </div>
            </div>
        )}

        {returnToPreArrivalLot && (
            <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 animate-in fade-in">
                <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6 border border-slate-200">
                    <div className="flex items-center text-orange-600 mb-4">
                        <Undo2 className="w-6 h-6 mr-3" />
                        <h3 className="text-lg font-bold text-slate-800">Move Back To Pre-Arrival?</h3>
                    </div>
                    <p className="text-sm text-slate-600 mb-6">
                        Move <span className="font-mono font-bold bg-slate-100 px-1 rounded">{returnToPreArrivalLot.qc_number || getRawLotRowId(returnToPreArrivalLot)}</span> back to the Pre-Arrival Procurement Box? This will clear delivery, quarantine, and QC-specific fields.
                    </p>
                    <div className="flex justify-end gap-3">
                        <button onClick={() => setReturnToPreArrivalLot(null)} className="px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-100 rounded-lg transition">Cancel</button>
                        <button onClick={handleConfirmReturnToPreArrival} disabled={isProcessingReturnToPreArrival} className="px-4 py-2 text-sm font-bold text-white bg-orange-600 hover:bg-orange-700 rounded-lg shadow-sm transition flex items-center">
                            {isProcessingReturnToPreArrival && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Confirm
                        </button>
                    </div>
                </div>
            </div>
        )}

        {releaseConfirmLot && (
            <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 animate-in fade-in">
                <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6 border border-slate-200">
                    <div className="flex items-center text-green-600 mb-4">
                        <CheckCircle className="w-6 h-6 mr-3" />
                        <h3 className="text-lg font-bold text-slate-800">Release Stock?</h3>
                    </div>
                    <p className="text-sm text-slate-600 mb-6">
                        Add <strong>{releaseConfirmLot.received_qty} {releaseConfirmLot.unit}</strong> of <span className="font-mono font-bold bg-slate-100 px-1 rounded">{releaseConfirmLot.qc_number}</span> to active inventory?
                    </p>
                    <div className="flex justify-end gap-3">
                        <button onClick={() => setReleaseConfirmLot(null)} className="px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-100 rounded-lg transition">Cancel</button>
                        <button onClick={handleConfirmRelease} disabled={isProcessingRelease} className="px-4 py-2 text-sm font-bold text-white bg-green-600 hover:bg-green-700 rounded-lg shadow-sm transition flex items-center">
                            {isProcessingRelease && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Confirm
                        </button>
                    </div>
                </div>
            </div>
        )}
    </div>
  );
};
