import React, { useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, FileSearch } from 'lucide-react';
import { InventoryTransaction, Product, ProductBatch, RawComponentLot } from '../../types';
import { buildPoSummaryModel } from '../../services/poSummary';
import { ActivityFilterBar } from './ActivityFilterBar';
import { SortableHeader } from './SortableHeader';
import { formatBritishDate } from '../../lib/dateFormatting';

interface Props {
  transactions: InventoryTransaction[];
  products: Product[];
  productBatches: ProductBatch[];
  rawComponentLots: RawComponentLot[];
}

const asCurrency = (value: number): string =>
  `£${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const asPercent = (value: number | null): string =>
  value === null ? '—' : `${value.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;

const getDateOnlyValue = (value: string): string => {
  const source = String(value || '').trim();
  if (!source) return '';
  const matched = source.match(/^\d{4}-\d{2}-\d{2}/);
  if (matched) return matched[0];
  const t = new Date(source).getTime();
  if (!Number.isFinite(t)) return '';
  return new Date(t).toISOString().slice(0, 10);
};

const asBritishDate = (value: string): string => formatBritishDate(getDateOnlyValue(value), '—');

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

export const POSummaryView: React.FC<Props> = ({ transactions, products, productBatches, rawComponentLots }) => {
  const defaultDateRange = useMemo(() => getDefaultLast30DaysRange(), []);
  const model = useMemo(
    () => buildPoSummaryModel(transactions, products, productBatches, rawComponentLots),
    [transactions, products, productBatches, rawComponentLots]
  );
  const [selectedReference, setSelectedReference] = useState<string | null>(null);
  const [draftFromDate, setDraftFromDate] = useState(defaultDateRange.from);
  const [draftToDate, setDraftToDate] = useState(defaultDateRange.to);
  const [draftSalesRep, setDraftSalesRep] = useState('all');
  const [appliedFromDate, setAppliedFromDate] = useState(defaultDateRange.from);
  const [appliedToDate, setAppliedToDate] = useState(defaultDateRange.to);
  const [appliedSalesRep, setAppliedSalesRep] = useState('all');
  const [sortState, setSortState] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'createdAt', dir: 'desc' });
  const filterFieldClass = 'w-full h-11 border border-slate-300 rounded bg-white px-3 text-base sm:text-sm shadow-none';

  const salesRepOptions = useMemo(() => {
    const values = Array.from(new Set(model.rows.map(row => (row.salesRep || '').trim()).filter(Boolean)));
    values.sort((a, b) => a.localeCompare(b));
    return values;
  }, [model.rows]);

  const rowsForTable = useMemo(() => {
    const inRange = model.rows.filter(row => {
      const dateOnly = getDateOnlyValue(row.createdAt);
      if (appliedFromDate && (!dateOnly || dateOnly < appliedFromDate)) return false;
      if (appliedToDate && (!dateOnly || dateOnly > appliedToDate)) return false;
      if (appliedSalesRep !== 'all' && row.salesRep !== appliedSalesRep) return false;
      return true;
    });

    return [...inRange].sort((a, b) => {
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

      let base = 0;
      switch (sortState.key) {
        case 'createdAt':
          base = compareDate(a.createdAt, b.createdAt);
          break;
        case 'reference':
          base = compareText(a.reference, b.reference);
          break;
        case 'orderType':
          base = compareText(a.orderType, b.orderType);
          break;
        case 'totalCost':
          base = compareNumber(a.totalCost, b.totalCost);
          break;
        case 'totalRevenue':
          base = compareNumber(a.totalRevenue, b.totalRevenue);
          break;
        case 'profit':
          base = compareNumber(a.profit, b.profit);
          break;
        case 'profitMargin':
          base = compareNumber(a.profitMargin, b.profitMargin);
          break;
        case 'salesRep':
          base = compareText(a.salesRep, b.salesRep);
          break;
        default:
          base = compareDate(a.createdAt, b.createdAt);
          break;
      }

      if (base === 0) return compareText(a.reference, b.reference);
      return sortState.dir === 'asc' ? base : -base;
    });
  }, [model.rows, appliedFromDate, appliedToDate, appliedSalesRep, sortState]);

  const dashboardForView = useMemo(() => {
    let sampleCostTotal = 0;
    let paidRevenueTotal = 0;
    let paidCostTotal = 0;

    rowsForTable.forEach(row => {
      row.lines.forEach(line => {
        if (line.lineKind === 'sample') sampleCostTotal += line.lineCost;
        if (line.lineKind === 'paid') {
          paidRevenueTotal += line.lineRevenue;
          paidCostTotal += line.lineCost;
        }
      });
    });

    const totalCost = paidCostTotal + sampleCostTotal;
    const overallProfit = paidRevenueTotal - totalCost;
    return {
      sampleCostTotal,
      paidRevenueTotal,
      overallProfit,
      revenueToSampleCost: sampleCostTotal > 0 ? paidRevenueTotal / sampleCostTotal : null,
      sampleCostPctOfTotalCost: totalCost > 0 ? (sampleCostTotal / totalCost) * 100 : null,
      profitOverTotalCost: totalCost > 0 ? overallProfit / totalCost : null,
    };
  }, [rowsForTable]);

  const applyFilters = () => {
    setAppliedFromDate(draftFromDate);
    setAppliedToDate(draftToDate);
    setAppliedSalesRep(draftSalesRep);
  };

  const clearFilters = () => {
    setDraftFromDate('');
    setDraftToDate('');
    setDraftSalesRep('all');
    setAppliedFromDate('');
    setAppliedToDate('');
    setAppliedSalesRep('all');
  };

  const downloadCsv = () => {
    if (rowsForTable.length === 0) return;
    const headers = ['Created Date', 'PO Number', 'Order Type', 'Total Cost', 'Total Revenue', 'Profit', 'Profit Margin (%)', 'Sales Rep'];
    const lines = rowsForTable.map(row => [
      getDateOnlyValue(row.createdAt),
      row.reference,
      row.orderType,
      row.totalCost.toFixed(2),
      row.totalRevenue.toFixed(2),
      row.profit.toFixed(2),
      row.profitMargin === null ? '' : row.profitMargin.toFixed(2),
      row.salesRep,
    ]);
    const csv = [headers.join(','), ...lines.map(line => line.map(escapeCsv).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const datedRows = rowsForTable
      .map(row => getDateOnlyValue(row.createdAt))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    const rangeFrom = appliedFromDate || datedRows[0] || new Date().toISOString().slice(0, 10);
    const rangeTo = appliedToDate || datedRows[datedRows.length - 1] || rangeFrom;
    const fromSegment = getDateOnlyValue(rangeFrom).replaceAll('-', '');
    const toSegment = getDateOnlyValue(rangeTo).replaceAll('-', '');
    a.download = `po_summary_from_${fromSegment}_to_${toSegment}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const selectedRow =
    rowsForTable.find(row => row.reference === selectedReference) || (rowsForTable.length > 0 ? rowsForTable[0] : null);

  return (
    <div className="space-y-6 animate-in fade-in">
      <div className="flex md:grid md:grid-cols-2 xl:grid-cols-6 gap-3 overflow-x-auto md:overflow-visible">
        <div className="bg-white border border-amber-200 rounded-lg p-4 h-full flex flex-col min-w-[180px] md:min-w-0">
          <div className="text-[10px] font-bold tracking-widest uppercase text-amber-700 min-h-[2.5rem] leading-tight">Sample Cost</div>
          <div className="text-xl font-black text-amber-800">{asCurrency(dashboardForView.sampleCostTotal)}</div>
        </div>
        <div className="bg-white border border-emerald-200 rounded-lg p-4 h-full flex flex-col min-w-[180px] md:min-w-0">
          <div className="text-[10px] font-bold tracking-widest uppercase text-emerald-700 min-h-[2.5rem] leading-tight">Paid Revenue</div>
          <div className="text-xl font-black text-emerald-800">{asCurrency(dashboardForView.paidRevenueTotal)}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4 h-full flex flex-col min-w-[180px] md:min-w-0">
          <div className="text-[10px] font-bold tracking-widest uppercase text-slate-500 min-h-[2.5rem] leading-tight">Overall Profit</div>
          <div className={`text-xl font-black ${dashboardForView.overallProfit >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
            {asCurrency(dashboardForView.overallProfit)}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4 h-full flex flex-col min-w-[180px] md:min-w-0">
          <div className="text-[10px] font-bold tracking-widest uppercase text-slate-500 min-h-[2.5rem] leading-tight">Revenue ÷ Sample Cost</div>
          <div className="text-xl font-black text-slate-800">
            {dashboardForView.revenueToSampleCost === null ? '—' : `${dashboardForView.revenueToSampleCost.toFixed(2)}x`}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4 h-full flex flex-col min-w-[180px] md:min-w-0">
          <div className="text-[10px] font-bold tracking-widest uppercase text-slate-500 min-h-[2.5rem] leading-tight">Sample Cost % Total Cost</div>
          <div className="text-xl font-black text-slate-800">{asPercent(dashboardForView.sampleCostPctOfTotalCost)}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4 h-full flex flex-col min-w-[180px] md:min-w-0">
          <div className="text-[10px] font-bold tracking-widest uppercase text-slate-500 min-h-[2.5rem] leading-tight">Profit ÷ (Paid + Sample Cost)</div>
          <div className="text-xl font-black text-slate-800">
            {dashboardForView.profitOverTotalCost === null ? '—' : `${(dashboardForView.profitOverTotalCost * 100).toFixed(1)}%`}
          </div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden md:h-[460px] flex flex-col">
        <div className="px-4 sm:px-6 py-4 border-b border-slate-200 bg-slate-50 flex-shrink-0">
          <div>
            <h3 className="font-bold text-slate-800">PO Summary</h3>
            <p className="text-xs text-slate-500 mt-1">Grouped from product `OUT` ledger rows with `Paid` or `Sample` reasons.</p>
          </div>
          <ActivityFilterBar
            fromDate={draftFromDate}
            toDate={draftToDate}
            onChangeFrom={setDraftFromDate}
            onChangeTo={setDraftToDate}
            rightSideControls={(
              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Sales Rep</label>
                <div className="relative">
                  <select
                    value={draftSalesRep}
                    onChange={(e) => setDraftSalesRep(e.target.value)}
                    className={`${filterFieldClass} appearance-none pr-10`}
                  >
                    <option value="all">All</option>
                    {salesRepOptions.map(rep => (
                      <option key={rep} value={rep}>{rep}</option>
                    ))}
                  </select>
                  <ChevronDown className="w-4 h-4 text-slate-500 pointer-events-none absolute right-3 top-1/2 -translate-y-1/2" />
                </div>
              </div>
            )}
            onApply={applyFilters}
            onReset={clearFilters}
            onExport={downloadCsv}
            exportDisabled={rowsForTable.length === 0}
          />
        </div>

        <div className="md:hidden flex-1 min-h-0 overflow-y-auto">
          <div className="divide-y divide-slate-100">
            {rowsForTable.map(row => {
              const isSelected = selectedRow?.reference === row.reference;
              const hasWarnings = row.warnings.length > 0;
              return (
                <button
                  key={row.reference}
                  type="button"
                  onClick={() => setSelectedReference(row.reference)}
                  className={`w-full text-left p-4 transition-colors ${isSelected ? 'bg-indigo-50/60' : 'bg-white hover:bg-slate-50'}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-[11px] text-slate-500 font-mono">{asBritishDate(row.createdAt)}</div>
                      <div className="font-mono text-xs font-bold text-indigo-700 break-all">{row.reference}</div>
                    </div>
                    <span
                      className={`text-[10px] font-black uppercase px-2 py-0.5 rounded border ${
                        row.orderType === 'Paid'
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-100'
                          : row.orderType === 'Sample'
                            ? 'bg-amber-50 text-amber-700 border-amber-100'
                            : 'bg-orange-50 text-orange-700 border-orange-100'
                      }`}
                    >
                      {row.orderType}
                    </span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <div className="text-slate-400">Cost</div>
                      <div className="font-mono text-slate-700">{asCurrency(row.totalCost)}</div>
                    </div>
                    <div>
                      <div className="text-slate-400">Revenue</div>
                      <div className="font-mono text-slate-700">{asCurrency(row.totalRevenue)}</div>
                    </div>
                    <div>
                      <div className="text-slate-400">Profit</div>
                      <div className={`font-mono font-black ${row.profit >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{asCurrency(row.profit)}</div>
                    </div>
                    <div>
                      <div className="text-slate-400">Sales Rep</div>
                      <div className="text-slate-700 truncate">{row.salesRep || '—'}</div>
                    </div>
                  </div>
                  {hasWarnings && (
                    <div className="mt-2 inline-flex items-center text-[10px] font-bold text-orange-700 bg-orange-50 border border-orange-100 rounded px-1.5 py-0.5">
                      <AlertTriangle className="w-3 h-3 mr-1" />
                      Warning
                    </div>
                  )}
                </button>
              );
            })}
            {rowsForTable.length === 0 && (
              <div className="py-12 text-center text-slate-400 italic">
                No rows matched the selected date range.
              </div>
            )}
          </div>
        </div>

        <div className="hidden md:block overflow-x-auto overflow-y-auto flex-1 min-h-0">
          <table className="w-full text-sm text-left min-w-[980px]">
            <thead className="bg-white text-slate-500 font-bold uppercase text-[10px] tracking-widest border-b border-slate-200">
              <tr>
                <SortableHeader
                  className="px-6 py-3"
                  label="Created Date"
                  sortKey="createdAt"
                  activeSortKey={sortState.key}
                  sortDir={sortState.dir}
                  onChange={(key, dir) => setSortState({ key, dir })}
                />
                <SortableHeader
                  className="px-6 py-3"
                  label="PO Number"
                  sortKey="reference"
                  activeSortKey={sortState.key}
                  sortDir={sortState.dir}
                  onChange={(key, dir) => setSortState({ key, dir })}
                />
                <SortableHeader
                  className="px-6 py-3"
                  label="Order Type"
                  sortKey="orderType"
                  activeSortKey={sortState.key}
                  sortDir={sortState.dir}
                  onChange={(key, dir) => setSortState({ key, dir })}
                />
                <SortableHeader
                  className="px-6 py-3 text-right"
                  label="Total Cost"
                  sortKey="totalCost"
                  activeSortKey={sortState.key}
                  sortDir={sortState.dir}
                  onChange={(key, dir) => setSortState({ key, dir })}
                />
                <SortableHeader
                  className="px-6 py-3 text-right"
                  label="Total Revenue"
                  sortKey="totalRevenue"
                  activeSortKey={sortState.key}
                  sortDir={sortState.dir}
                  onChange={(key, dir) => setSortState({ key, dir })}
                />
                <SortableHeader
                  className="px-6 py-3 text-right"
                  label="Profit"
                  sortKey="profit"
                  activeSortKey={sortState.key}
                  sortDir={sortState.dir}
                  onChange={(key, dir) => setSortState({ key, dir })}
                />
                <SortableHeader
                  className="px-6 py-3 text-right"
                  label="Profit Margin"
                  sortKey="profitMargin"
                  activeSortKey={sortState.key}
                  sortDir={sortState.dir}
                  onChange={(key, dir) => setSortState({ key, dir })}
                />
                <SortableHeader
                  className="px-6 py-3"
                  label="Sales Rep"
                  sortKey="salesRep"
                  activeSortKey={sortState.key}
                  sortDir={sortState.dir}
                  onChange={(key, dir) => setSortState({ key, dir })}
                />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rowsForTable.map(row => {
                const isSelected = selectedRow?.reference === row.reference;
                const tone =
                  row.orderType === 'Sample'
                    ? 'bg-amber-50/40'
                    : row.orderType === 'Mixed'
                      ? 'bg-orange-50/30'
                      : '';
                const hasWarnings = row.warnings.length > 0;

                return (
                  <tr key={row.reference} className={`cursor-pointer hover:bg-slate-50 transition-colors ${tone} ${isSelected ? 'ring-1 ring-indigo-200' : ''}`}>
                    <td className="px-6 py-4 font-mono text-xs text-slate-600">
                      {asBritishDate(row.createdAt)}
                    </td>
                    <td
                      className="px-6 py-4 font-mono text-xs font-bold text-indigo-700 underline decoration-dotted break-all"
                      onClick={() => setSelectedReference(row.reference)}
                    >
                      {row.reference}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-[10px] font-black uppercase px-2 py-0.5 rounded border ${
                            row.orderType === 'Paid'
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-100'
                              : row.orderType === 'Sample'
                                ? 'bg-amber-50 text-amber-700 border-amber-100'
                                : 'bg-orange-50 text-orange-700 border-orange-100'
                          }`}
                        >
                          {row.orderType}
                        </span>
                        {hasWarnings && (
                          <span className="inline-flex items-center text-[10px] font-bold text-orange-700 bg-orange-50 border border-orange-100 rounded px-1.5 py-0.5">
                            <AlertTriangle className="w-3 h-3 mr-1" />
                            Warning
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-right font-mono text-xs text-slate-700">{asCurrency(row.totalCost)}</td>
                    <td className="px-6 py-4 text-right font-mono text-xs text-slate-700">{asCurrency(row.totalRevenue)}</td>
                    <td className={`px-6 py-4 text-right font-mono text-xs font-black ${row.profit >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                      {asCurrency(row.profit)}
                    </td>
                    <td className="px-6 py-4 text-right font-mono text-xs text-slate-700">{asPercent(row.profitMargin)}</td>
                    <td className="px-6 py-4 text-xs text-slate-700">{row.salesRep || '—'}</td>
                  </tr>
                );
              })}

              {rowsForTable.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-16 text-center text-slate-400 italic">
                    No rows matched the selected date range.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selectedRow && (
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="px-4 sm:px-6 py-4 border-b border-slate-200 bg-slate-50 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <h3 className="font-bold text-slate-800">PO Detail: <span className="font-mono text-indigo-700 break-all">{selectedRow.reference}</span></h3>
            <button
              onClick={() => setSelectedReference(prev => (prev === selectedRow.reference ? null : selectedRow.reference))}
              className="flex items-center text-xs font-bold text-slate-500 hover:text-slate-700 min-h-11"
            >
              {selectedReference === selectedRow.reference ? <ChevronDown className="w-4 h-4 mr-1" /> : <ChevronRight className="w-4 h-4 mr-1" />}
              {selectedReference === selectedRow.reference ? 'Collapse' : 'Expand'}
            </button>
          </div>

          {(selectedReference === selectedRow.reference || selectedReference === null) && (
            <div className="p-4 sm:p-6 space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="border border-slate-200 rounded-lg p-4">
                  <div className="text-[10px] font-bold tracking-widest uppercase text-slate-500">Total Cost</div>
                  <div className="text-lg font-black text-slate-800 mt-1">{asCurrency(selectedRow.totalCost)}</div>
                </div>
                <div className="border border-slate-200 rounded-lg p-4">
                  <div className="text-[10px] font-bold tracking-widest uppercase text-slate-500">Total Revenue</div>
                  <div className="text-lg font-black text-slate-800 mt-1">{asCurrency(selectedRow.totalRevenue)}</div>
                </div>
                <div className="border border-slate-200 rounded-lg p-4">
                  <div className="text-[10px] font-bold tracking-widest uppercase text-slate-500">Profit</div>
                  <div className={`text-lg font-black mt-1 ${selectedRow.profit >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{asCurrency(selectedRow.profit)}</div>
                </div>
              </div>

              {selectedRow.warnings.length > 0 && (
                <div className="border border-orange-200 bg-orange-50/60 rounded-lg p-3">
                  <div className="text-xs font-bold text-orange-800">Warnings</div>
                  <div className="text-xs text-orange-700 mt-1">{selectedRow.warnings.join(' | ')}</div>
                </div>
              )}

              <div className="md:hidden space-y-2">
                {selectedRow.lines.map(line => (
                  <div key={line.id} className="border border-slate-200 rounded-lg p-3">
                    <div className="font-semibold text-slate-700 break-words">{line.itemName}</div>
                    <div className="text-[10px] text-slate-400 break-all">{line.itemId}</div>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                      <div>Qty: <span className="font-mono">{line.quantity} {line.unit}</span></div>
                      <div>Unit Cost: <span className="font-mono">{asCurrency(line.unitCost)}</span></div>
                      <div>Sale: <span className="font-mono">{line.lineKind === 'paid' ? asCurrency(line.unitSalePrice) : '—'}</span></div>
                      <div>Line Cost: <span className="font-mono">{asCurrency(line.lineCost)}</span></div>
                      <div className="col-span-2">Revenue: <span className="font-mono">{asCurrency(line.lineRevenue)}</span></div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="hidden md:block overflow-x-auto border border-slate-200 rounded-lg">
                <table className="w-full text-xs text-left min-w-[760px]">
                  <thead className="bg-slate-50 text-slate-500 uppercase tracking-widest border-b border-slate-200">
                    <tr>
                      <th className="px-4 py-2">Item</th>
                      <th className="px-4 py-2 text-right">Qty</th>
                      <th className="px-4 py-2 text-right">Unit Cost</th>
                      <th className="px-4 py-2 text-right">Unit Sale Price</th>
                      <th className="px-4 py-2 text-right">Line Cost</th>
                      <th className="px-4 py-2 text-right">Line Revenue</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {selectedRow.lines.map(line => (
                      <tr key={line.id}>
                        <td className="px-4 py-2">
                          <div className="font-semibold text-slate-700">{line.itemName}</div>
                          <div className="text-[10px] text-slate-400">{line.itemId}</div>
                        </td>
                        <td className="px-4 py-2 text-right font-mono">{line.quantity} {line.unit}</td>
                        <td className="px-4 py-2 text-right font-mono">{asCurrency(line.unitCost)}</td>
                        <td className="px-4 py-2 text-right font-mono">
                          {line.lineKind === 'paid' ? asCurrency(line.unitSalePrice) : '—'}
                        </td>
                        <td className="px-4 py-2 text-right font-mono">{asCurrency(line.lineCost)}</td>
                        <td className="px-4 py-2 text-right font-mono">{asCurrency(line.lineRevenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {!selectedRow && rowsForTable.length === 0 && (
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-8 text-center text-slate-500">
          <FileSearch className="w-8 h-8 mx-auto mb-2 text-slate-400" />
          <div className="text-sm">PO detail view will appear when summary rows are available.</div>
        </div>
      )}
    </div>
  );
};
