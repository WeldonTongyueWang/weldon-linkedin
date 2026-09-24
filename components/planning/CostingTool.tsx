
/**
 * HARD BOUNDARY: COSTING CHANGE REQUEST
 * 
 * AUTHORITY: Exploratory Costing Logic.
 * RULES:
 * 1. Logic must be read-only relative to inventory ledger.
 * 2. No direct inventory mutations allowed.
 */

import React, { useState, useMemo } from 'react';
import { Product, Component, BOMItem, InventoryTransaction, RawComponentLot, PlanningReport, BatchRecord, CategoryMaster } from '../../types';
import { savePlanningReport } from '../../services/sheetsApi';
import { buildLatestComponentUnitCostMap } from '../../services/ledgerPricing';
import { buildBatchSkuDefaults, FALLBACK_TIME_PER_KG } from '../../services/batchSkuDefaults';
import { getBomLinesForSkuVariant } from '../../services/bomVariants';
import { isArrivedRawLot, resolveRawLotLandedUnitPrice } from '../../services/rawLotWorkflow';
import { Wrench, Loader2, Save } from 'lucide-react';
import { useAppDialog } from '../ui/AppDialogProvider';
import { useIsHandheldDevice } from '../../lib/useIsHandheldDevice';
import { isMutationGuardBlockedError } from '../../services/liveDataSync';
import { formatFinishedProductInventoryLabel } from '../../utils/finishedProductLabels';
import { formatRawComponentListLabel } from '../../utils/rawComponentLabels';
import { formatBritishDate } from '../../lib/dateFormatting';

interface Props {
  currentUser: string;
  products: Product[];
  inventory: Component[];
  categories?: CategoryMaster[];
  bom: BOMItem[];
  transactions: InventoryTransaction[];
  rawComponentLots: RawComponentLot[];
  batchRecords?: BatchRecord[];
  isReadOnly?: boolean;
}

export const CostingTool: React.FC<Props> = ({ 
  currentUser, products, inventory, categories = [], bom, transactions, rawComponentLots, batchRecords = [], isReadOnly 
}) => {
  const isHandheldDevice = useIsHandheldDevice();
  const appDialog = useAppDialog();
  type PriceOption = { key: string; label: string; price: number };
  type CostingLine = {
      id: string;
      name: string;
      qty: number;
      unit: string;
      unitPrice: number;
      priceSource: string;
      priceOptions: PriceOption[];
  };

  const [costingSku, setCostingSku] = useState('');
  const [costingBatchSize, setCostingBatchSize] = useState(100);
  const [costingLines, setCostingLines] = useState<CostingLine[]>([]);
  const [manualComponentId, setManualComponentId] = useState('');
  const [costingOverheads, setCostingOverheads] = useState({
      labourRate: 15,
      labourCount: 1,
      labourHours: 2,
      electricityConsumption: 5,
      electricityPrice: 0.35,
      waterConsumption: 100,
      waterPrice: 0.005
  });
  const [isSavingReport, setIsSavingReport] = useState(false);

  const costingMode = costingSku ? 'REGISTERED' : 'MANUAL';

  const costMap = useMemo(() => {
      return buildLatestComponentUnitCostMap(transactions, rawComponentLots);
  }, [transactions, rawComponentLots]);
  const skuDefaults = useMemo(() => buildBatchSkuDefaults(batchRecords).bySku, [batchRecords]);

  const selectableComponents = useMemo(() => {
      const allowedTypes = new Set([
          'INGREDIENT',
          'CONSUMABLE',
          'PRIMARY_PACKAGING',
          'SECONDARY_PACKAGING',
          'LABEL',
          'DISPENSING'
      ]);
      return inventory
          .filter(c => allowedTypes.has(c.type))
          .sort((a, b) => formatRawComponentListLabel(a, categories).localeCompare(formatRawComponentListLabel(b, categories)));
  }, [inventory, categories]);

  const buildPriceOptions = (componentId: string): PriceOption[] => {
      const byLot = rawComponentLots
          .filter(l => isArrivedRawLot(l) && l.itemId === componentId && resolveRawLotLandedUnitPrice(l) > 0)
          .sort((a, b) => {
              const aTs = new Date(a.deliveryDate || a.updatedAt || a.createdAt || 0).getTime();
              const bTs = new Date(b.deliveryDate || b.updatedAt || b.createdAt || 0).getTime();
              return bTs - aTs;
          })
          .slice(0, 8)
          .map((lot, idx) => ({
              key: `lot-${lot.qc_number || idx}`,
              label: `${formatBritishDate(lot.deliveryDate, 'No date')} · ${lot.qc_number || 'No lot'} · £${resolveRawLotLandedUnitPrice(lot).toFixed(4)}`,
              price: resolveRawLotLandedUnitPrice(lot)
          }));

      const fallback = costMap[componentId];
      if (byLot.length === 0 && fallback > 0) {
          return [{ key: 'fallback-ledger', label: `Latest ledger price · £${fallback.toFixed(4)}`, price: fallback }];
      }
      return byLot;
  };

  const buildCostingLine = (componentId: string, qty: number): CostingLine => {
      const comp = inventory.find(i => i.component_id === componentId);
      const priceOptions = buildPriceOptions(componentId);
      const preferred = priceOptions[0];
      return {
          id: componentId,
          name: comp ? formatRawComponentListLabel(comp, categories) : componentId,
          qty,
          unit: comp?.default_unit || 'unit',
          unitPrice: preferred?.price || 0,
          priceSource: preferred?.key || 'manual',
          priceOptions
      };
  };

  const handleLoadCostingBOM = (skuId: string) => {
      setCostingSku(skuId);
      if (!skuId) {
          setCostingLines([]);
          return;
      }
      const product = products.find(p => p.sku_id === skuId);
      const recipe = getBomLinesForSkuVariant(bom, skuId);
      
      const lines = recipe.map(b => {
          const line = buildCostingLine(b.component_id, b.qty_per_kg * costingBatchSize);
          return { ...line, unit: b.unit || line.unit };
      });
      setCostingLines(lines);
      
      if (product) {
          const labourRatePerKg = skuDefaults[product.sku_id]?.time_per_kg || FALLBACK_TIME_PER_KG;
          setCostingOverheads(prev => ({
              ...prev, 
              labourHours: labourRatePerKg * costingBatchSize
          }));
      }
  };

  const handleAddManualLine = () => {
      if (!manualComponentId) return;
      setCostingLines(prev => {
          if (prev.some(line => line.id === manualComponentId)) return prev;
          return [...prev, buildCostingLine(manualComponentId, 1)];
      });
      setManualComponentId('');
  };

  const handleUpdateCostingLine = (index: number, field: string, val: number) => {
      const updated = [...costingLines];
      updated[index] = { ...updated[index], [field]: val };
      setCostingLines(updated);
  };

  const handleUpdateCostingLinePriceSource = (index: number, sourceKey: string) => {
      const updated = [...costingLines];
      const line = updated[index];
      if (!line) return;
      const option = line.priceOptions.find(opt => opt.key === sourceKey);
      if (!option) {
          updated[index] = { ...line, priceSource: 'manual' };
      } else {
          updated[index] = { ...line, priceSource: option.key, unitPrice: option.price };
      }
      setCostingLines(updated);
  };

  const handleRemoveCostingLine = (index: number) => {
      setCostingLines(prev => prev.filter((_, i) => i !== index));
  };

  const costingTotals = useMemo(() => {
      const materials = costingLines.reduce((sum, line) => sum + (line.qty * line.unitPrice), 0);
      const labour = costingOverheads.labourRate * costingOverheads.labourCount * costingOverheads.labourHours;
      const utilities = (costingOverheads.electricityConsumption * costingOverheads.electricityPrice) + (costingOverheads.waterConsumption * costingOverheads.waterPrice);
      return { materials, labour, utilities, total: materials + labour + utilities };
  }, [costingLines, costingOverheads]);

  const handleSaveCostingReport = async () => {
      if (isReadOnly || isSavingReport) return;
      setIsSavingReport(true);
      const product = products.find(p => p.sku_id === costingSku);
      const report: PlanningReport = {
          report_id: `RPT-COST-${Date.now()}`,
          product_sku: costingSku || 'MANUAL-ESTIMATE',
          product_name: product ? formatFinishedProductInventoryLabel(product) : 'Manual Estimate',
          batch_size: costingBatchSize,
          total_cost: costingTotals.total,
          cost_per_unit: costingTotals.total / costingBatchSize,
          breakdown_json: JSON.stringify({
              type: 'COSTING',
              lines: costingLines,
              overheads: costingOverheads,
              totals: costingTotals
          }),
          created_at: new Date().toISOString(),
          created_by: currentUser
      };
      try {
        await savePlanningReport(report);
        await appDialog.alert({ message: "Costing saved!", tone: 'success' });
      } catch (e) {
        if (isMutationGuardBlockedError(e)) return;
        console.error(e);
        await appDialog.alert({ message: "Failed to save.", tone: 'danger' });
      }
      finally { setIsSavingReport(false); }
  };

  const mainLayoutClass = isHandheldDevice
    ? 'grid grid-cols-1 gap-8'
    : 'grid grid-cols-1 md:grid-cols-3 gap-8';
  const detailPanelClass = isHandheldDevice ? 'space-y-6' : 'md:col-span-2 space-y-6';

  return (
    <div className="space-y-6">
        <div>
            <h2 className="text-xl font-black text-slate-900">Costing (Exploratory)</h2>
            <p className="text-sm text-slate-600">Explore what-if cost scenarios for new formats, variants, and batch assumptions.</p>
        </div>

        <div className={mainLayoutClass}>
        {/* Config */}
        <div className="space-y-6">
            <div className="bg-slate-50 p-6 rounded-xl border border-slate-200">
                <h4 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-4 flex items-center">
                    <Wrench className="w-3 h-3 mr-2" /> Parameters
                </h4>
                <div className="mb-4">
                    <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Load BOM (Optional)</label>
                    <select 
                        className="w-full border-slate-300 rounded-lg text-sm shadow-sm py-2" 
                        value={costingSku} 
                        onChange={e => handleLoadCostingBOM(e.target.value)}
                    >
                        <option value="">-- Manual Entry --</option>
                        {products.map(p => <option key={p.sku_id} value={p.sku_id}>{formatFinishedProductInventoryLabel(p)}</option>)}
                    </select>
                </div>
                <div className="mb-4">
                    <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Batch Size (kg)</label>
                    <input type="number" className="w-full border-slate-300 rounded text-sm py-2" value={costingBatchSize} onChange={e => setCostingBatchSize(Number(e.target.value))} />
                </div>
                
                <div className="border-t border-slate-200 pt-4 space-y-3">
                    <div className="flex justify-between items-center">
                        <label className="text-[10px] font-bold text-slate-500 uppercase">Labour Rate (£/hr)</label>
                        <input type="number" className="w-20 text-right border-slate-300 rounded text-xs py-1" value={costingOverheads.labourRate} onChange={e => setCostingOverheads({...costingOverheads, labourRate: Number(e.target.value)})} />
                    </div>
                    <div className="flex justify-between items-center">
                        <label className="text-[10px] font-bold text-slate-500 uppercase">No. of Labours</label>
                        <input type="number" className="w-20 text-right border-slate-300 rounded text-xs py-1" value={costingOverheads.labourCount} onChange={e => setCostingOverheads({...costingOverheads, labourCount: Number(e.target.value)})} />
                    </div>
                    <div className="flex justify-between items-center">
                        <label className="text-[10px] font-bold text-slate-500 uppercase">Working Hours</label>
                        <input type="number" className="w-20 text-right border-slate-300 rounded text-xs py-1" value={costingOverheads.labourHours} onChange={e => setCostingOverheads({...costingOverheads, labourHours: Number(e.target.value)})} />
                    </div>
                    <div className="flex justify-between items-center">
                        <label className="text-[10px] font-bold text-slate-500 uppercase">Electricity (kWh)</label>
                        <input type="number" className="w-20 text-right border-slate-300 rounded text-xs py-1" value={costingOverheads.electricityConsumption} onChange={e => setCostingOverheads({...costingOverheads, electricityConsumption: Number(e.target.value)})} />
                    </div>
                    <div className="flex justify-between items-center">
                        <label className="text-[10px] font-bold text-slate-500 uppercase">Electricity Price (£/kWh)</label>
                        <input type="number" className="w-20 text-right border-slate-300 rounded text-xs py-1" value={costingOverheads.electricityPrice} onChange={e => setCostingOverheads({...costingOverheads, electricityPrice: Number(e.target.value)})} />
                    </div>
                    <div className="flex justify-between items-center">
                        <label className="text-[10px] font-bold text-slate-500 uppercase">Water (L)</label>
                        <input type="number" className="w-20 text-right border-slate-300 rounded text-xs py-1" value={costingOverheads.waterConsumption} onChange={e => setCostingOverheads({...costingOverheads, waterConsumption: Number(e.target.value)})} />
                    </div>
                    <div className="flex justify-between items-center">
                        <label className="text-[10px] font-bold text-slate-500 uppercase">Water Price (£/L)</label>
                        <input type="number" className="w-20 text-right border-slate-300 rounded text-xs py-1" value={costingOverheads.waterPrice} onChange={e => setCostingOverheads({...costingOverheads, waterPrice: Number(e.target.value)})} />
                    </div>
                    <div className="flex justify-between items-center">
                        <label className="text-[10px] font-bold text-slate-500 uppercase">Utility Cost</label>
                        <div className="text-xs font-mono font-bold">£{costingTotals.utilities.toFixed(2)}</div>
                    </div>
                </div>
            </div>

            <button 
                onClick={handleSaveCostingReport}
                disabled={isSavingReport || costingLines.length === 0}
                className="w-full py-4 bg-indigo-600 text-white rounded-xl font-bold uppercase tracking-widest shadow-lg hover:bg-indigo-700 transition flex items-center justify-center disabled:opacity-50"
            >
                {isSavingReport ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />} Save Estimate
            </button>
        </div>

        {/* Worksheet */}
        <div className={detailPanelClass}>
            {costingMode === 'MANUAL' && (
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 flex items-center gap-2">
                    <select
                        className="flex-1 border-slate-300 rounded text-sm py-2"
                        value={manualComponentId}
                        onChange={e => setManualComponentId(e.target.value)}
                    >
                        <option value="">Select component to add</option>
                        {selectableComponents.map(c => (
                            <option key={c.component_id} value={c.component_id}>
                                {formatRawComponentListLabel(c, categories)} ({c.default_unit})
                            </option>
                        ))}
                    </select>
                    <button
                        type="button"
                        className="px-4 py-2 text-xs font-bold uppercase tracking-wider rounded bg-indigo-600 text-white disabled:opacity-50"
                        onClick={handleAddManualLine}
                        disabled={!manualComponentId}
                    >
                        Add Line
                    </button>
                </div>
            )}
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm text-left">
                    <thead className="bg-slate-50 text-slate-500 font-bold uppercase text-[10px] tracking-widest border-b border-slate-200">
                        <tr>
                            <th className="px-4 py-3">Component</th>
                            <th className="px-4 py-3 text-right">Qty</th>
                            <th className="px-4 py-3 text-right">Price Source</th>
                            <th className="px-4 py-3 text-right">Unit Price</th>
                            <th className="px-4 py-3 text-right">Total</th>
                            <th className="px-4 py-3 text-right">Action</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {costingLines.map((line, idx) => (
                            <tr key={idx} className="hover:bg-slate-50">
                                <td className="px-4 py-3 font-bold text-slate-700 text-xs">{line.name}</td>
                                <td className="px-4 py-3 text-right">
                                    <input 
                                        type="number" 
                                        className="w-20 text-right border-slate-200 rounded text-xs py-1 bg-slate-50 focus:bg-white focus:border-indigo-500 font-mono"
                                        value={line.qty}
                                        onChange={e => handleUpdateCostingLine(idx, 'qty', Number(e.target.value))}
                                    />
                                    <span className="text-[10px] text-slate-400 ml-1">{line.unit}</span>
                                </td>
                                <td className="px-4 py-3 text-right">
                                    <select
                                        className="w-56 max-w-full text-right border-slate-200 rounded text-xs py-1 bg-slate-50 focus:bg-white focus:border-indigo-500"
                                        value={line.priceSource}
                                        onChange={e => handleUpdateCostingLinePriceSource(idx, e.target.value)}
                                    >
                                        <option value="manual">Manual price</option>
                                        {line.priceOptions.map(opt => (
                                            <option key={opt.key} value={opt.key}>{opt.label}</option>
                                        ))}
                                    </select>
                                </td>
                                <td className="px-4 py-3 text-right">
                                    <input 
                                        type="number" 
                                        className="w-20 text-right border-slate-200 rounded text-xs py-1 bg-slate-50 focus:bg-white focus:border-indigo-500 font-mono"
                                        value={line.unitPrice}
                                        onChange={e => {
                                            handleUpdateCostingLinePriceSource(idx, 'manual');
                                            handleUpdateCostingLine(idx, 'unitPrice', Number(e.target.value));
                                        }}
                                    />
                                </td>
                                <td className="px-4 py-3 text-right font-bold text-slate-700 text-xs">
                                    £{(line.qty * line.unitPrice).toFixed(2)}
                                </td>
                                <td className="px-4 py-3 text-right">
                                    <button
                                        type="button"
                                        onClick={() => handleRemoveCostingLine(idx)}
                                        className="text-[10px] font-bold uppercase tracking-wide text-rose-600 hover:text-rose-700"
                                    >
                                        Remove
                                    </button>
                                </td>
                            </tr>
                        ))}
                        {costingLines.length === 0 && (
                            <tr><td colSpan={6} className="py-12 text-center text-slate-400 italic">No lines. Load a BOM or add items.</td></tr>
                        )}
                    </tbody>
                </table>
                </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
                <div className="p-4 bg-slate-50 rounded-lg border border-slate-200 text-center">
                    <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Materials</div>
                    <div className="text-xl font-black text-slate-700">£{costingTotals.materials.toFixed(2)}</div>
                </div>
                <div className="p-4 bg-slate-50 rounded-lg border border-slate-200 text-center">
                    <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Overheads</div>
                    <div className="text-xl font-black text-slate-700">£{(costingTotals.labour + costingTotals.utilities).toFixed(2)}</div>
                </div>
                <div className="p-4 bg-indigo-50 rounded-lg border border-indigo-200 text-center">
                    <div className="text-[10px] font-black text-indigo-400 uppercase tracking-widest">Total / Unit</div>
                    <div className="text-xl font-black text-indigo-700">£{(costingTotals.total / (costingBatchSize || 1)).toFixed(2)}</div>
                </div>
            </div>
        </div>
        </div>
    </div>
  );
};
