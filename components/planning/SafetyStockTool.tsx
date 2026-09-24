import React, { useMemo, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ChevronDown, ShieldCheck, X } from 'lucide-react';
import { InventoryTransaction, Product } from '../../types';
import {
  buildSafetyStockModel,
  SAFETY_STOCK_CATEGORY_ORDER,
  SafetyStockProductRow,
} from '../../services/safetyStock';
import { useIsHandheldDevice } from '../../lib/useIsHandheldDevice';

interface Props {
  products: Product[];
  transactions: InventoryTransaction[];
}

const LOOKBACK_OPTIONS = [4, 8, 12, 26, 52];
const filterFieldClass = 'w-full h-11 border border-slate-300 rounded bg-white px-3 text-base sm:text-sm shadow-none';

const formatMetric = (value: number, digits = 2): string =>
  value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

const formatSignedInteger = (value: number): string => `${value > 0 ? '+' : ''}${value.toLocaleString()}`;

const riskToneByLevel: Record<SafetyStockProductRow['riskLevel'], string> = {
  Low: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  Medium: 'bg-amber-50 text-amber-700 border-amber-100',
  High: 'bg-rose-50 text-rose-700 border-rose-100',
};

export const SafetyStockTool: React.FC<Props> = ({ products, transactions }) => {
  const isHandheldDevice = useIsHandheldDevice();
  const [lookbackWeeks, setLookbackWeeks] = useState(12);
  const [serviceFactorInput, setServiceFactorInput] = useState(2.05);
  const [defaultLeadTimeInput, setDefaultLeadTimeInput] = useState(6);
  const [serviceFactor, setServiceFactor] = useState(2.05);
  const [defaultLeadTimeWeeks, setDefaultLeadTimeWeeks] = useState(6);
  const [leadTimeOverrides, setLeadTimeOverrides] = useState<Record<string, number>>({});
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [collapsedCategories, setCollapsedCategories] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      SAFETY_STOCK_CATEGORY_ORDER.map((category) => [category, true])
    )
  );

  const model = useMemo(
    () => buildSafetyStockModel(transactions, products, {
      lookbackWeeks,
      serviceFactor,
      defaultLeadTimeWeeks,
      leadTimeOverrides,
    }),
    [defaultLeadTimeWeeks, leadTimeOverrides, lookbackWeeks, products, serviceFactor, transactions]
  );

  const groupedRows = useMemo(
    () =>
      SAFETY_STOCK_CATEGORY_ORDER.map((category) => ({
        category,
        rows: model.rows.filter((row) => row.category === category),
      })).filter((group) => group.rows.length > 0),
    [model.rows]
  );

  const selectedRow = useMemo(
    () => model.rows.find((row) => row.productId === selectedProductId) || null,
    [model.rows, selectedProductId]
  );

  React.useEffect(() => {
    if (selectedProductId && !selectedRow) setSelectedProductId(null);
  }, [selectedProductId, selectedRow]);

  const updateLeadTimeOverride = (productId: string, nextValue: number) => {
    setLeadTimeOverrides((current) => ({ ...current, [productId]: nextValue }));
  };

  const applyConfiguration = () => {
    setServiceFactor(serviceFactorInput);
    setDefaultLeadTimeWeeks(defaultLeadTimeInput);
  };

  const emptyStateMessage = 'No active finished-product master data rows matched the supported inventory category groups.';

  const toggleCategory = (category: string) => {
    setCollapsedCategories((current) => ({
      ...current,
      [category]: !current[category],
    }));
  };

  const mainLayoutClass = isHandheldDevice
    ? 'grid grid-cols-1 gap-8'
    : 'grid grid-cols-1 md:grid-cols-4 gap-8';
  const detailPanelClass = isHandheldDevice
    ? 'bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden'
    : 'md:col-span-3 bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden';

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-black text-slate-900">Products Safety Stock</h2>
        <p className="text-sm text-slate-600">
          Read-only planning view based on historical product demand from inventory_ledger. Safety stock is calculated as service factor x weekly demand standard deviation x square root of lead time.
        </p>
      </div>

      <div className={mainLayoutClass}>
        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm h-fit">
          <h3 className="font-bold text-slate-800 mb-4 flex items-center uppercase tracking-widest text-xs">
            <ShieldCheck className="w-4 h-4 mr-2 text-indigo-600" /> Configuration
          </h3>

          <div className="space-y-4">
            <div>
              <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Time Period</label>
              <div className="relative">
                <select
                  value={lookbackWeeks}
                  onChange={(event) => setLookbackWeeks(Number(event.target.value))}
                  className={`${filterFieldClass} appearance-none pr-10`}
                >
                  {LOOKBACK_OPTIONS.map((weeks) => (
                    <option key={weeks} value={weeks}>
                      Last {weeks} weeks
                    </option>
                  ))}
                </select>
                <ChevronDown className="w-4 h-4 text-slate-500 pointer-events-none absolute right-3 top-1/2 -translate-y-1/2" />
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Service Factor (Z)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                className={filterFieldClass}
                value={serviceFactorInput}
                onChange={(event) => setServiceFactorInput(Number(event.target.value))}
              />
              <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
                Higher values increase buffer stock. Common guide: 1.28 is about 90% service, 1.65 is about 95%, and 2.05 is about 98%.
              </p>
            </div>

            <div>
              <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Average Lead Time (Weeks)</label>
              <input
                type="number"
                min="0"
                step="0.1"
                className={filterFieldClass}
                value={defaultLeadTimeInput}
                onChange={(event) => setDefaultLeadTimeInput(Number(event.target.value))}
              />
              <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
                Default lead time is 2 weeks. You can adjust lead time per product row without writing anything back.
              </p>
            </div>

            <button
              type="button"
              onClick={applyConfiguration}
              className="w-full inline-flex min-h-11 items-center justify-center rounded bg-indigo-600 px-5 text-sm font-semibold text-white hover:bg-indigo-700"
            >
              Update
            </button>
          </div>
        </div>

        <div className={detailPanelClass}>
          <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex justify-between items-center gap-3">
            <div>
              <h3 className="font-bold text-slate-700 text-sm uppercase tracking-wide">Safety Stock Analysis</h3>
              <p className="text-xs text-slate-500 mt-1">
                Weekly demand over the last {model.lookbackWeeks} weeks ending {model.periodEnd}.
              </p>
            </div>
            <span className="bg-indigo-100 text-indigo-700 text-xs font-bold px-2 py-1 rounded whitespace-nowrap">
              {model.rows.length} Products
            </span>
          </div>

          {model.rows.length === 0 ? (
            <div className="p-12 text-center text-slate-400 italic">
              {emptyStateMessage}
            </div>
          ) : (
            <div className="overflow-x-hidden">
              <table className="w-full table-fixed text-xs text-left">
                <colgroup>
                  <col className="w-[10%]" />
                  <col className="w-[28%]" />
                  <col className="w-[14%]" />
                  <col className="w-[13%]" />
                  <col className="w-[11%]" />
                  <col className="w-[12%]" />
                  <col className="w-[12%]" />
                </colgroup>
                <thead className="bg-white text-slate-500 font-bold uppercase text-[10px] tracking-widest border-b border-slate-100">
                  <tr>
                    <th className="px-3 py-3">Risk</th>
                    <th className="px-3 py-3">Product</th>
                    <th className="px-3 py-3 text-right">Demand Metrics</th>
                    <th className="px-3 py-3 text-right">Lead Time</th>
                    <th className="px-3 py-3 text-right">Current Stock</th>
                    <th className="px-3 py-3 text-right">Safety Stock</th>
                    <th className="px-3 py-3 text-right">Difference</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {groupedRows.map((group) => (
                    <React.Fragment key={group.category}>
                      <tr className="bg-slate-50/80">
                        <td colSpan={7} className="px-3 py-2.5 text-sm font-black uppercase tracking-[0.16em] text-slate-500">
                          <button
                            type="button"
                            onClick={() => toggleCategory(group.category)}
                            className="flex w-full items-center justify-between gap-3 text-left"
                          >
                            <span>{group.category}</span>
                            <span className="inline-flex items-center gap-2 text-[10px] tracking-[0.12em] text-slate-400">
                              {group.rows.length}
                              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${collapsedCategories[group.category] ? '-rotate-90' : 'rotate-0'}`} />
                            </span>
                          </button>
                        </td>
                      </tr>
                      {!collapsedCategories[group.category] && group.rows.map((row) => {
                        const isSelected = selectedRow?.productId === row.productId;
                        return (
                          <tr
                            key={row.productId}
                            className={`cursor-pointer hover:bg-slate-50 ${isSelected ? 'bg-indigo-50/50' : 'bg-white'}`}
                            onClick={() => setSelectedProductId(row.productId)}
                          >
                            <td className="px-3 py-3">
                              <span className={`inline-flex items-center rounded border px-2 py-1 text-[10px] font-black uppercase ${riskToneByLevel[row.riskLevel]}`}>
                                {row.riskLevel}
                              </span>
                            </td>
                            <td className="px-3 py-3">
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setSelectedProductId(row.productId);
                                }}
                                title={row.productName}
                                className="block w-full truncate whitespace-nowrap text-left text-[13px] font-bold text-slate-700 hover:text-indigo-700 transition"
                              >
                                {row.productName}
                              </button>
                              <div title={row.productId} className="truncate whitespace-nowrap text-[10px] text-slate-400 font-mono">
                                {row.productId}
                              </div>
                            </td>
                            <td className="px-3 py-3 text-right">
                              <div className="font-mono text-[11px] text-slate-600">{formatMetric(row.averageWeeklyDemand)}</div>
                              <div className="text-[10px] text-slate-400">SD {formatMetric(row.stdDevWeeklyDemand)}</div>
                            </td>
                            <td className="px-3 py-3 text-right">
                              <input
                                type="number"
                                min="0"
                                step="0.5"
                                value={row.leadTimeWeeks}
                                onClick={(event) => event.stopPropagation()}
                                onChange={(event) => updateLeadTimeOverride(row.productId, Number(event.target.value))}
                                className="w-16 border border-slate-300 rounded-lg text-[13px] font-bold text-right text-slate-700 p-2 bg-white"
                              />
                            </td>
                            <td className="px-3 py-3 text-right font-mono text-[13px] font-bold text-slate-700">
                              {row.currentStockRounded.toLocaleString()}
                            </td>
                            <td className="px-3 py-3 text-right text-[13px] font-bold text-indigo-600 bg-indigo-50/30">
                              {row.safetyStockRounded.toLocaleString()}
                            </td>
                            <td className={`px-3 py-3 text-right font-mono text-[13px] font-bold ${row.stockDifference >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                              {formatSignedInteger(row.stockDifference)}
                            </td>
                          </tr>
                        );
                      })}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {selectedRow && (
        <SafetyStockDetailModal
          row={selectedRow}
          serviceFactor={serviceFactor}
          lookbackWeeks={lookbackWeeks}
          onClose={() => setSelectedProductId(null)}
        />
      )}
    </div>
  );
};

interface SafetyStockDetailModalProps {
  row: SafetyStockProductRow;
  serviceFactor: number;
  lookbackWeeks: number;
  onClose: () => void;
}

const SafetyStockDetailModal: React.FC<SafetyStockDetailModalProps> = ({
  row,
  serviceFactor,
  lookbackWeeks,
  onClose,
}) => (
  <div
    className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 animate-in fade-in"
    onClick={onClose}
  >
    <div
      className="w-full max-w-5xl bg-white border border-slate-200 rounded-2xl shadow-2xl overflow-hidden"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="px-6 py-4 border-b border-slate-200 bg-slate-50 flex items-start justify-between gap-4">
        <div>
          <div className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">{row.category}</div>
          <h3 className="text-xl font-black text-slate-900 mt-1">{row.productName}</h3>
          <p className="text-xs text-slate-500 mt-1">
            Historical weekly demand for the last {lookbackWeeks} weeks with the current safety stock reference line.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:text-slate-700 hover:bg-slate-50 transition"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-6 space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
          <SummaryCard label="Current Stock" value={row.currentStockRounded.toLocaleString()} />
          <SummaryCard label="Safety Stock" value={row.safetyStockRounded.toLocaleString()} accent />
          <SummaryCard label="Difference" value={formatSignedInteger(row.stockDifference)} />
          <SummaryCard label="Risk Level" value={row.riskLevel} />
          <SummaryCard label="Avg / Week" value={formatMetric(row.averageWeeklyDemand)} />
          <SummaryCard label="Std Dev" value={formatMetric(row.stdDevWeeklyDemand)} />
          <SummaryCard label="Lead Time" value={`${formatMetric(row.leadTimeWeeks, 1)} wks`} />
          <SummaryCard label="Service Factor" value={formatMetric(serviceFactor, 2)} />
        </div>

        <div className="h-[320px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={row.weeklyDemandHistory} margin={{ top: 20, right: 24, left: 4, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <Legend verticalAlign="top" height={36} />
              <XAxis dataKey="weekLabel" tick={{ fontSize: 11, fill: '#64748b' }} minTickGap={16} />
              <YAxis tick={{ fontSize: 11, fill: '#64748b' }} allowDecimals={false} />
              <Tooltip
                formatter={(value: number, name: string) => [formatMetric(Number(value)), name]}
                labelFormatter={(label) => `Week of ${label}`}
                contentStyle={{ borderRadius: '12px', borderColor: '#cbd5e1' }}
              />
              <ReferenceLine
                y={row.safetyStockRounded}
                stroke="#4f46e5"
                strokeDasharray="6 4"
                label={{ value: 'Safety stock', position: 'insideTopRight', fill: '#4f46e5', fontSize: 11 }}
              />
              <Line
                type="monotone"
                dataKey="demand"
                stroke="#0f172a"
                strokeWidth={2}
                dot={{ r: 3, fill: '#0f172a' }}
                activeDot={{ r: 5 }}
                name="Actual demand"
              />
              <Line
                type="monotone"
                dataKey={() => row.currentStockRounded}
                stroke="#0ea5e9"
                strokeWidth={2}
                dot={false}
                name="Current stock"
              />
              <Line
                type="monotone"
                dataKey="actualStock"
                stroke="#f97316"
                strokeWidth={2}
                dot={{ r: 2, fill: '#f97316' }}
                activeDot={{ r: 4 }}
                name="Actual stock"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-xl p-4">
          Total demand in view: <span className="font-bold text-slate-700">{formatMetric(row.totalDemand)}</span>. Weeks with demand: <span className="font-bold text-slate-700">{row.weeksWithDemand}</span> of <span className="font-bold text-slate-700">{row.weeklyDemandHistory.length}</span>.
        </div>
      </div>
    </div>
  </div>
);

interface SummaryCardProps {
  label: string;
  value: string;
  accent?: boolean;
}

const SummaryCard: React.FC<SummaryCardProps> = ({ label, value, accent = false }) => (
  <div className={`rounded-xl border p-4 ${accent ? 'bg-indigo-50 border-indigo-200' : 'bg-white border-slate-200'}`}>
    <div className={`text-[10px] font-bold tracking-widest uppercase ${accent ? 'text-indigo-700' : 'text-slate-500'}`}>
      {label}
    </div>
    <div className={`text-xl font-black mt-1 ${accent ? 'text-indigo-700' : 'text-slate-800'}`}>{value}</div>
  </div>
);
