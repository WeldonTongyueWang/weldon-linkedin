import React, { useEffect, useMemo, useState } from 'react';
import { InventoryTransaction, RawComponentLot, Component, ComponentType, ProductBatch, LocationName, Product, CategoryMaster } from '../../types';
import { Filter } from 'lucide-react';
import { resolveLedgerEventTime } from '../../services/ledgerTime';
import { ActivityFilterBar } from './ActivityFilterBar';
import { SortableHeader } from './SortableHeader';
import { getRawLotActivityTimestamp, isArrivedRawLot } from '../../services/rawLotWorkflow';
import { formatBritishDate, formatBritishTime } from '../../lib/dateFormatting';
import { useIsHandheldDevice } from '../../lib/useIsHandheldDevice';
import { formatRawComponentListLabel } from '../../utils/rawComponentLabels';
import { formatFinishedProductInventoryLabel } from '../../utils/finishedProductLabels';

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

const normalizeSearchText = (value: unknown): string =>
  String(value ?? '').toLowerCase().trim();

const normalizeBatchToken = (value: unknown): string =>
  String(value ?? '').trim().toLowerCase();

const normalizeStockKeyPart = (value: unknown): string =>
  String(value ?? '').trim().toLowerCase();

const toNearZero = (value: number): number => (Math.abs(value) < 0.000001 ? 0 : value);

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

const useDebouncedValue = (value: string, delayMs: number): string => {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeoutId = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timeoutId);
  }, [value, delayMs]);
  return debounced;
};

type ItemTypeFilter = 'all' | 'COMPONENT' | 'PRODUCT';
type SortKey = 'timestamp' | 'item' | 'user' | 'change' | 'stockAfter';

interface HistorySourceRow {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  type: 'IN' | 'OUT';
  category: 'COMPONENT' | 'PRODUCT';
  itemId: string;
  itemName?: string;
  quantity: number;
  unit?: string;
  batchNumber?: string;
  reason?: string;
  notes?: string;
  user?: string;
  location?: LocationName;
  eventKind: 'LEDGER' | 'REGISTRATION' | 'REJECTION';
  displayStatus: string | null;
  supplier?: string;
}

interface AuditRow {
  id: string;
  timestamp: string;
  eventLabel: string;
  eventKind: HistorySourceRow['eventKind'];
  category: HistorySourceRow['category'];
  itemName: string;
  itemId: string;
  batchOrQc: string;
  location: string;
  supplier: string;
  changeValue: number;
  changeText: string;
  stockAfter: number | null;
  stockAfterText: string;
  qcStatus: string;
  user: string;
  reason: string;
  notes: string;
  unit: string;
}

interface Props {
  transactions: InventoryTransaction[];
  rawComponentLots: RawComponentLot[];
  productBatches: ProductBatch[];
  products: Product[];
  inventory: Component[];
  categories?: CategoryMaster[];
  currentUser: string;
  onEditInit: (tx: InventoryTransaction) => void;
  onDeleteTransaction?: (txId: string) => void;
  isReadOnly?: boolean;
}

export const TransactionLogs: React.FC<Props> = ({
  transactions, rawComponentLots, productBatches, products, inventory, categories = [], currentUser, onEditInit, onDeleteTransaction, isReadOnly
}) => {
  const isHandheldDevice = useIsHandheldDevice();
  const defaultDateRange = useMemo(() => getDefaultLast30DaysRange(), []);
  const [draftFromDate, setDraftFromDate] = useState(defaultDateRange.from);
  const [draftToDate, setDraftToDate] = useState(defaultDateRange.to);
  const [draftItemType, setDraftItemType] = useState<ItemTypeFilter>('all');
  const [draftSearchInput, setDraftSearchInput] = useState('');
  const debouncedDraftSearchInput = useDebouncedValue(draftSearchInput, 300);

  const [appliedFromDate, setAppliedFromDate] = useState(defaultDateRange.from);
  const [appliedToDate, setAppliedToDate] = useState(defaultDateRange.to);
  const [appliedItemType, setAppliedItemType] = useState<ItemTypeFilter>('all');
  const [appliedSearchQuery, setAppliedSearchQuery] = useState('');
  const [sortState, setSortState] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'timestamp', dir: 'desc' });
  const filterFieldClass = 'w-full h-11 border border-slate-300 rounded bg-white px-3 text-base sm:text-sm shadow-none';
  const supplementalFiltersClass = isHandheldDevice
    ? 'grid grid-cols-1 gap-2'
    : 'grid grid-cols-1 lg:grid-cols-2 gap-2';

  const componentLotsByQcNumber = useMemo(() => {
    const map = new Map<string, RawComponentLot>();
    rawComponentLots.forEach((lot) => {
      map.set(String(lot.qc_number || '').trim(), lot);
    });
    return map;
  }, [rawComponentLots]);

  const productBatchStatusBySkuAndToken = useMemo(() => {
    const map = new Map<string, string>();
    productBatches.forEach((batch) => {
      const sku = normalizeBatchToken(batch.sku_id);
      if (!sku) return;
      const tokens = [
        normalizeBatchToken(batch.batch_number),
        normalizeBatchToken(batch.batch_id),
        normalizeBatchToken(batch.id),
      ].filter(Boolean);
      tokens.forEach((token) => {
        map.set(`${sku}::${token}`, String(batch.status || ''));
      });
    });
    return map;
  }, [productBatches]);

  const resolveItemName = (tx: Partial<InventoryTransaction>): string => {
    let item = inventory.find((i) => i.component_id === tx.itemId);
    if (!item && tx.itemName) {
      const searchName = tx.itemName.trim().toLowerCase();
      item = inventory.find((i) => (i.component_name || '').trim().toLowerCase() === searchName);
    }
    if (item) {
      const formatted = formatRawComponentListLabel(item, categories);
      return item.notes ? `${formatted} - ${item.notes}` : formatted;
    }
    return tx.itemName || 'Unknown Item';
  };

  const resolveProductDisplayName = (tx: Partial<InventoryTransaction>): string => {
    const product = products.find((p) => String(p.sku_id || '').trim() === String(tx.itemId || '').trim());
    if (product) return formatFinishedProductInventoryLabel(product);
    return tx.itemName || tx.itemId || 'Unknown Item';
  };

  const getHistoryRowKey = (tx: HistorySourceRow, index: number): string =>
    `${String(tx.id || 'history-row')}::${index}`;

  const integratedHistory = useMemo<HistorySourceRow[]>(() => {
    const baseTxs: HistorySourceRow[] = transactions.map((t) => ({
      ...t,
      eventKind: 'LEDGER',
      displayStatus: null,
    }));

    const componentRegistrations: HistorySourceRow[] = rawComponentLots
      .filter((lot) => isArrivedRawLot(lot) && String(lot.qc_number || '').trim() !== '')
      .map((lot) => ({
      id: `REG-C-${lot.qc_number}`,
      createdAt: lot.deliveryDate || lot.editedAt || lot.updatedAt || lot.createdAt || new Date().toISOString(),
      updatedAt: getRawLotActivityTimestamp(lot) || lot.deliveryDate,
      type: 'IN',
      category: 'COMPONENT',
      itemId: lot.itemId,
      itemName: '',
      quantity: lot.received_qty,
      unit: lot.unit,
      batchNumber: lot.qc_number,
      reason: `GOODS IN: Received from ${lot.supplier || 'Unknown'}`,
      user: lot.createdBy || 'System',
      eventKind: 'REGISTRATION',
      displayStatus: lot.qcStatus,
      location: lot.location as LocationName,
      supplier: lot.supplier || '',
      notes: '',
    }));

    const componentRejections: HistorySourceRow[] = rawComponentLots
      .filter((lot) =>
        isArrivedRawLot(lot) &&
        (lot.qcStatus || '').toLowerCase() === 'rejected' &&
        !transactions.some((tx) => tx.batchNumber === lot.qc_number && tx.reason === 'Rejected')
      )
      .map((lot) => ({
        id: `REJ-C-${lot.qc_number}`,
        createdAt: getRawLotActivityTimestamp(lot) || lot.deliveryDate || new Date().toISOString(),
        updatedAt: getRawLotActivityTimestamp(lot) || lot.deliveryDate,
        type: 'OUT',
        category: 'COMPONENT',
        itemId: lot.itemId,
        itemName: '',
        quantity: lot.received_qty,
        unit: lot.unit,
        batchNumber: lot.qc_number,
        reason: `QC REJECTED: ${lot.qcNotes || 'No notes'}`,
        user: lot.updatedBy || lot.createdBy || 'QC',
        eventKind: 'REJECTION',
        displayStatus: 'Rejected',
        location: lot.location as LocationName,
        supplier: lot.supplier || '',
        notes: lot.qcNotes || '',
      }));

    return [...baseTxs, ...componentRegistrations, ...componentRejections].sort(
      (a, b) => new Date(resolveLedgerEventTime(b)).getTime() - new Date(resolveLedgerEventTime(a)).getTime()
    );
  }, [transactions, rawComponentLots]);

  const stockAfterByHistoryId = useMemo(() => {
    const balances = new Map<string, number>();
    const stockAfter = new Map<string, number | null>();

    const chronologicalRows = integratedHistory
      .map((tx, index) => ({ tx, index }))
      .sort((a, b) => {
        const aTime = new Date(resolveLedgerEventTime(a.tx) || a.tx.createdAt || '').getTime();
        const bTime = new Date(resolveLedgerEventTime(b.tx) || b.tx.createdAt || '').getTime();
        const aValid = Number.isFinite(aTime);
        const bValid = Number.isFinite(bTime);
        if (aValid && bValid && aTime !== bTime) return aTime - bTime;
        if (aValid !== bValid) return aValid ? -1 : 1;
        return a.index - b.index;
      });

    chronologicalRows.forEach(({ tx, index }) => {
      const itemId = normalizeStockKeyPart(tx.itemId);
      const batch = normalizeStockKeyPart(tx.batchNumber);
      const location = normalizeStockKeyPart(tx.location) || 'unspecified';
      const rowKey = getHistoryRowKey(tx, index);

      if (!itemId || !batch) {
        stockAfter.set(rowKey, null);
        return;
      }

      const balanceKey = [
        normalizeStockKeyPart(tx.category),
        itemId,
        batch,
        location,
      ].join('::');
      const quantity = Number(tx.quantity || 0);
      const signedChange = tx.eventKind === 'REGISTRATION' ? 0 : (tx.type === 'IN' ? quantity : -quantity);
      const nextBalance = toNearZero(Number(balances.get(balanceKey) || 0) + signedChange);

      balances.set(balanceKey, nextBalance);
      stockAfter.set(rowKey, nextBalance);
    });

    return stockAfter;
  }, [integratedHistory]);

  const auditRows = useMemo<AuditRow[]>(() => {
    return integratedHistory.map((tx, index) => {
      const timestamp = String(resolveLedgerEventTime(tx) || tx.createdAt || '');
      const batchOrQc = String(tx.batchNumber || '').trim();
      const supplier = tx.supplier || (tx.category === 'COMPONENT' && batchOrQc ? componentLotsByQcNumber.get(batchOrQc)?.supplier || '' : '');
      const statusFromLot = tx.category === 'COMPONENT' && batchOrQc ? componentLotsByQcNumber.get(batchOrQc)?.qcStatus || '' : '';
      const statusFromProductBatch = tx.category === 'PRODUCT' && batchOrQc
        ? productBatchStatusBySkuAndToken.get(
            `${normalizeBatchToken(tx.itemId)}::${normalizeBatchToken(batchOrQc)}`
          ) || ''
        : '';
      const qcStatus = String(tx.displayStatus || statusFromLot || statusFromProductBatch || '').trim();
      const itemName = tx.category === 'COMPONENT' ? resolveItemName(tx) : resolveProductDisplayName(tx);
      const unit = tx.unit || 'unit';
      const quantity = Number(tx.quantity || 0);
      const signedChange = tx.eventKind === 'REGISTRATION' ? 0 : (tx.type === 'IN' ? quantity : -quantity);
      const changeText = tx.eventKind === 'REGISTRATION'
        ? '—'
        : `${signedChange >= 0 ? '+' : ''}${signedChange.toLocaleString()} ${unit}`;
      const stockAfter = stockAfterByHistoryId.get(getHistoryRowKey(tx, index)) ?? null;
      const stockAfterText = stockAfter === null
        ? '—'
        : `${stockAfter.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit}`;
      const eventLabel = tx.eventKind === 'REGISTRATION'
        ? 'Initial Registration'
        : tx.eventKind === 'REJECTION'
          ? 'Quality Rejection'
          : tx.type === 'IN'
            ? 'Ledger In'
            : 'Ledger Out';

      return {
        id: String(tx.id || ''),
        timestamp,
        eventLabel,
        eventKind: tx.eventKind,
        category: tx.category,
        itemName,
        itemId: String(tx.itemId || ''),
        batchOrQc,
        location: String(tx.location || ''),
        supplier: String(supplier || ''),
        changeValue: signedChange,
        changeText,
        stockAfter,
        stockAfterText,
        qcStatus,
        user: String(tx.user || currentUser || 'System'),
        reason: String(tx.reason || ''),
        notes: String(tx.notes || ''),
        unit,
      };
    });
  }, [integratedHistory, componentLotsByQcNumber, productBatchStatusBySkuAndToken, currentUser, resolveItemName, resolveProductDisplayName, stockAfterByHistoryId]);

  const filteredRows = useMemo(() => {
    return auditRows.filter((row) => {
      const dateOnly = getDateOnlyValue(row.timestamp);
      if (appliedFromDate && (!dateOnly || dateOnly < appliedFromDate)) return false;
      if (appliedToDate && (!dateOnly || dateOnly > appliedToDate)) return false;
      if (appliedItemType !== 'all' && row.category !== appliedItemType) return false;

      return matchesSearch(
        [
          row.itemName,
          row.batchOrQc,
          row.supplier,
          row.user,
          row.eventLabel,
          row.reason,
          row.notes,
        ],
        appliedSearchQuery
      );
    });
  }, [auditRows, appliedFromDate, appliedToDate, appliedItemType, appliedSearchQuery]);

  const sortedRows = useMemo(() => {
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
    const compareNumber = (left: number | null, right: number | null): number => {
      const l = left === null ? Number.NEGATIVE_INFINITY : left;
      const r = right === null ? Number.NEGATIVE_INFINITY : right;
      return l - r;
    };

    const indexed = filteredRows.map((row, index) => ({ row, index }));
    indexed.sort((a, b) => {
      let base = 0;
      switch (sortState.key) {
        case 'timestamp':
          base = compareDate(a.row.timestamp, b.row.timestamp);
          break;
        case 'item':
          base = compareText(a.row.itemName, b.row.itemName);
          break;
        case 'user':
          base = compareText(a.row.user, b.row.user);
          break;
        case 'change':
          base = compareNumber(a.row.changeValue, b.row.changeValue);
          break;
        case 'stockAfter':
          base = compareNumber(a.row.stockAfter, b.row.stockAfter);
          break;
        default:
          base = compareDate(a.row.timestamp, b.row.timestamp);
          break;
      }
      if (base === 0) return a.index - b.index;
      return sortState.dir === 'asc' ? base : -base;
    });
    return indexed.map((entry) => entry.row);
  }, [filteredRows, sortState]);

  const applyFilters = () => {
    const normalizedSearch = (debouncedDraftSearchInput || draftSearchInput).trim();
    setAppliedFromDate(draftFromDate);
    setAppliedToDate(draftToDate);
    setAppliedItemType(draftItemType);
    setAppliedSearchQuery(normalizedSearch);
  };

  const resetFilters = () => {
    setDraftFromDate(defaultDateRange.from);
    setDraftToDate(defaultDateRange.to);
    setDraftItemType('all');
    setDraftSearchInput('');
    setAppliedFromDate(defaultDateRange.from);
    setAppliedToDate(defaultDateRange.to);
    setAppliedItemType('all');
    setAppliedSearchQuery('');
    setSortState({ key: 'timestamp', dir: 'desc' });
  };

  const downloadTxCsv = () => {
    if (sortedRows.length === 0) return;
    const headers = ['Timestamp', 'Event', 'Item', 'Change', 'Stock After', 'QC / Status', 'User', 'Reason'];
    const rows = sortedRows.map((row) => [
      new Date(row.timestamp).toISOString(),
      row.eventLabel,
      row.itemName,
      row.changeText,
      row.stockAfterText,
      row.qcStatus || '—',
      row.user,
      row.reason,
    ]);
    const csv = [headers.join(','), ...rows.map((line) => line.map(escapeCsv).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const datedRows = sortedRows
      .map((row) => getDateOnlyValue(row.timestamp))
      .filter(Boolean)
      .sort((aValue, bValue) => aValue.localeCompare(bValue));
    const rangeFrom = appliedFromDate || datedRows[0] || defaultDateRange.from;
    const rangeTo = appliedToDate || datedRows[datedRows.length - 1] || rangeFrom;
    const fromSegment = getDateOnlyValue(rangeFrom).replaceAll('-', '');
    const toSegment = getDateOnlyValue(rangeTo).replaceAll('-', '');
    a.download = `audit_logs_from_${fromSegment}_to_${toSegment}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="animate-in fade-in space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden min-h-[22rem] md:h-[calc(100vh-18rem)] md:min-h-[720px] flex flex-col">
        <div className="px-4 sm:px-6 py-4 border-b border-slate-200 bg-slate-50 flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-50 rounded-lg text-indigo-600">
              <Filter className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-slate-800">Operational Audit Logs</h3>
              <p className="text-xs text-slate-500">Lifecycle tracking for inventory events and status changes.</p>
            </div>
          </div>
          <ActivityFilterBar
            fromDate={draftFromDate}
            toDate={draftToDate}
            onChangeFrom={setDraftFromDate}
            onChangeTo={setDraftToDate}
            rightSideControls={(
              <div className={supplementalFiltersClass}>
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Item Type</label>
                  <select
                    value={draftItemType}
                    onChange={(event) => setDraftItemType(event.target.value as ItemTypeFilter)}
                    className={`${filterFieldClass} appearance-none`}
                  >
                    <option value="all">All</option>
                    <option value="COMPONENT">Components</option>
                    <option value="PRODUCT">Products</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Global Search</label>
                  <input
                    type="text"
                    value={draftSearchInput}
                    onChange={(event) => setDraftSearchInput(event.target.value)}
                    placeholder="Item, batch/QC, supplier, user, event, reason..."
                    className={filterFieldClass}
                  />
                </div>
              </div>
            )}
            onApply={applyFilters}
            onReset={resetFilters}
            onExport={downloadTxCsv}
            exportDisabled={sortedRows.length === 0}
          />
        </div>

        <div className="mobile-scroll-hint px-4 pt-3">Swipe sideways to review all audit columns.</div>
        <div className="mobile-table-region overflow-x-auto overflow-y-visible md:overflow-y-auto flex-1 min-h-0">
          <table className="w-full text-sm text-left min-w-[1150px]">
            <thead className="sticky top-0 z-10 bg-white text-slate-500 font-bold uppercase text-[10px] tracking-widest border-b border-slate-200">
              <tr>
                <SortableHeader
                  className="px-6 py-3"
                  label="Timestamp"
                  sortKey="timestamp"
                  activeSortKey={sortState.key}
                  sortDir={sortState.dir}
                  onChange={(key, dir) => setSortState({ key: key as SortKey, dir })}
                />
                <th className="px-6 py-3">Event</th>
                <SortableHeader
                  className="px-6 py-3"
                  label="Item"
                  sortKey="item"
                  activeSortKey={sortState.key}
                  sortDir={sortState.dir}
                  onChange={(key, dir) => setSortState({ key: key as SortKey, dir })}
                />
                <SortableHeader
                  className="px-6 py-3 text-right"
                  label="Change"
                  sortKey="change"
                  activeSortKey={sortState.key}
                  sortDir={sortState.dir}
                  onChange={(key, dir) => setSortState({ key: key as SortKey, dir })}
                />
                <SortableHeader
                  className="px-6 py-3 text-right"
                  label="Stock After"
                  sortKey="stockAfter"
                  activeSortKey={sortState.key}
                  sortDir={sortState.dir}
                  onChange={(key, dir) => setSortState({ key: key as SortKey, dir })}
                />
                <th className="px-6 py-3">QC / Status</th>
                <SortableHeader
                  className="px-6 py-3"
                  label="User"
                  sortKey="user"
                  activeSortKey={sortState.key}
                  sortDir={sortState.dir}
                  onChange={(key, dir) => setSortState({ key: key as SortKey, dir })}
                />
                <th className="px-6 py-3">Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sortedRows.map((row) => {
                const eventTone = row.eventKind === 'REGISTRATION'
                  ? 'bg-indigo-50 text-indigo-700 border-indigo-100'
                  : row.eventKind === 'REJECTION'
                    ? 'bg-red-50 text-red-700 border-red-100'
                    : row.changeValue >= 0
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-100'
                      : 'bg-amber-50 text-amber-700 border-amber-100';
                const statusTone = (row.qcStatus || '').toLowerCase().includes('reject')
                  ? 'bg-red-50 text-red-700 border-red-100'
                  : (row.qcStatus || '').toLowerCase().includes('pass') || (row.qcStatus || '').toLowerCase().includes('released')
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-100'
                    : 'bg-slate-100 text-slate-600 border-slate-200';
                const detailTooltip = [
                  `Record ID: ${row.id || '—'}`,
                  `Category: ${row.category}`,
                  `Item ID: ${row.itemId || '—'}`,
                  `Batch/QC: ${row.batchOrQc || '—'}`,
                  `Location: ${row.location || '—'}`,
                  `Supplier: ${row.supplier || '—'}`,
                ].join(' | ');

                return (
                  <tr key={`${row.id}-${row.timestamp}`} className="hover:bg-slate-50 transition-colors">
                    <td className="px-6 py-4">
                      <div className="text-slate-700 font-medium">{formatBritishDate(row.timestamp)}</div>
                      <div className="text-xs text-slate-400 font-mono">{formatBritishTime(row.timestamp)}</div>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded border ${eventTone}`}>
                        {row.eventLabel}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="font-semibold text-slate-800 max-w-[280px] truncate" title={row.itemName}>{row.itemName}</div>
                      <div className="text-[10px] text-slate-400 font-mono max-w-[340px] truncate" title={detailTooltip}>
                        {row.batchOrQc || '—'} • {row.location || '—'}
                      </div>
                    </td>
                    <td className={`px-6 py-4 text-right font-mono text-xs font-black ${row.changeValue >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                      {row.changeText}
                    </td>
                    <td className="px-6 py-4 text-right font-mono text-xs text-slate-700">{row.stockAfterText}</td>
                    <td className="px-6 py-4">
                      {row.qcStatus ? (
                        <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded border ${statusTone}`}>
                          {row.qcStatus.replaceAll('_', ' ')}
                        </span>
                      ) : (
                        <span className="text-[10px] text-slate-400 italic">—</span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-xs text-slate-700">{row.user || 'System'}</td>
                    <td className="px-6 py-4 text-xs text-slate-500 max-w-[300px] truncate" title={[row.reason, row.notes].filter(Boolean).join(' | ')}>
                      {row.reason || '—'}
                    </td>
                  </tr>
                );
              })}

              {sortedRows.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-16 text-center text-slate-400 italic">
                    No history found for the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
