
/**
 * HARD BOUNDARY: BUDGETING CHANGE REQUEST
 * 
 * AUTHORITY: Operational Budgeting Logic.
 * RULES:
 * 1. Logic must be read-only relative to inventory ledger.
 * 2. No direct inventory mutations allowed.
 */

import React, { useState, useMemo } from 'react';
import { Product, Component, BOMItem, InventoryTransaction, RawComponentLot, PlanningReport, CategoryMaster } from '../../types';
import { savePlanningReport } from '../../services/sheetsApi';
import { computeLedgerStockLevels } from '../../services/ledgerStock';
import { buildLatestComponentUnitCostMap } from '../../services/ledgerPricing';
import { getBomLinesForSkuVariant } from '../../services/bomVariants';
import { isArrivedRawLot, resolveRawLotLandedUnitPrice } from '../../services/rawLotWorkflow';
import { ShoppingCart, Loader2, Save, Coins } from 'lucide-react';
import { useAppDialog } from '../ui/AppDialogProvider';
import { useIsHandheldDevice } from '../../lib/useIsHandheldDevice';
import { isMutationGuardBlockedError } from '../../services/liveDataSync';
import { formatFinishedProductInventoryLabel } from '../../utils/finishedProductLabels';
import { formatRawComponentListLabel } from '../../utils/rawComponentLabels';

interface Props {
  currentUser: string;
  products: Product[];
  inventory: Component[];
  categories?: CategoryMaster[];
  bom: BOMItem[];
  transactions: InventoryTransaction[];
  rawComponentLots: RawComponentLot[];
  isReadOnly?: boolean;
}

export const BudgetingTool: React.FC<Props> = ({ 
  currentUser, products, inventory, categories = [], bom, transactions, rawComponentLots, isReadOnly 
}) => {
  const isHandheldDevice = useIsHandheldDevice();
  const appDialog = useAppDialog();
  const [budgetSku, setBudgetSku] = useState('');
  const [budgetQty, setBudgetQty] = useState(100);
  const [buyQtyOverrides, setBuyQtyOverrides] = useState<Record<string, number>>({});
  const [isSavingReport, setIsSavingReport] = useState(false);

  const costMap = useMemo(() => {
      return buildLatestComponentUnitCostMap(transactions, rawComponentLots);
  }, [transactions, rawComponentLots]);

  const stockMap = useMemo(() => {
      const levels = computeLedgerStockLevels(transactions, rawComponentLots);
      const map: Record<string, number> = {};
      inventory.forEach(item => {
          map[item.component_id] = Number(levels[item.component_id]?.totalAvailable || 0);
      });
      return map;
  }, [transactions, rawComponentLots, inventory]);

  const budgetReport = useMemo(() => {
      if (!budgetSku) return null;
      const recipe = getBomLinesForSkuVariant(bom, budgetSku);
      
      const rows = recipe.map(b => {
          const comp = inventory.find(i => i.component_id === b.component_id);
          const required = b.qty_per_kg * budgetQty;
          const stock = stockMap[b.component_id] || 0;
          const shortfall = Math.max(0, required - stock);
          
          let price = 0;
          const lots = rawComponentLots
              .filter(l => isArrivedRawLot(l) && l.itemId === b.component_id && resolveRawLotLandedUnitPrice(l) > 0)
              .sort((a,b) => new Date(b.deliveryDate || 0).getTime() - new Date(a.deliveryDate || 0).getTime());
          if (lots.length > 0) price = resolveRawLotLandedUnitPrice(lots[0]);
          else price = costMap[b.component_id] || 0;

          const manualOrder = buyQtyOverrides[b.component_id];
          const toBuy = manualOrder !== undefined ? manualOrder : shortfall;
          const cost = toBuy * price;

          return {
              id: b.component_id,
              name: comp ? formatRawComponentListLabel(comp, categories) : b.component_id,
              required,
              stock,
              shortfall,
              toBuy,
              unit: b.unit,
              unitPrice: price,
              totalCost: cost
          };
      });

      const totalBudget = rows.reduce((acc, r) => acc + r.totalCost, 0);
      return { rows, totalBudget };
  }, [budgetSku, budgetQty, buyQtyOverrides, bom, stockMap, costMap, rawComponentLots, inventory]);

  const handleSaveBudgetReport = async () => {
      if (isReadOnly || isSavingReport || !budgetReport) return;
      setIsSavingReport(true);
      const product = products.find(p => p.sku_id === budgetSku);
      const report: PlanningReport = {
          report_id: `RPT-BUDGET-${Date.now()}`,
          product_sku: budgetSku,
          product_name: product ? formatFinishedProductInventoryLabel(product) : budgetSku,
          batch_size: budgetQty,
          total_cost: budgetReport.totalBudget,
          cost_per_unit: budgetQty > 0 ? budgetReport.totalBudget / budgetQty : 0,
          breakdown_json: JSON.stringify({
              type: 'BUDGETING',
              rows: budgetReport.rows,
              totalBudget: budgetReport.totalBudget
          }),
          created_at: new Date().toISOString(),
          created_by: currentUser
      };
      try {
        await savePlanningReport(report);
        await appDialog.alert({ message: "Budget saved!", tone: 'success' });
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
  const detailPanelClass = isHandheldDevice ? '' : 'md:col-span-2';

  return (
    <div className="space-y-6">
        <div>
            <h2 className="text-xl font-black text-slate-900">Budgeting (Long term)</h2>
            <p className="text-sm text-slate-600">Estimate future purchasing needs and procurement budget across a longer planning horizon.</p>
        </div>

        <div className={mainLayoutClass}>
        <div className="space-y-6">
            <div className="bg-slate-50 p-6 rounded-xl border border-slate-200">
                <h4 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-4 flex items-center">
                    <ShoppingCart className="w-3 h-3 mr-2" /> Plan Details
                </h4>
                <div className="mb-4">
                    <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Select Product *</label>
                    <select 
                        className="w-full border-slate-300 rounded-lg text-sm shadow-sm py-2 font-bold text-slate-700" 
                        value={budgetSku} 
                        onChange={e => { setBudgetSku(e.target.value); setBuyQtyOverrides({}); }}
                    >
                        <option value="">-- Choose Product --</option>
                        {products.map(p => <option key={p.sku_id} value={p.sku_id}>{formatFinishedProductInventoryLabel(p)}</option>)}
                    </select>
                </div>
                <div className="mb-4">
                    <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Planned Quantity</label>
                    <div className="flex items-center">
                        <input type="number" className="flex-1 border-slate-300 rounded-l-lg text-sm py-2 font-bold" value={budgetQty} onChange={e => setBudgetQty(Number(e.target.value))} />
                        <span className="bg-white border border-l-0 border-slate-300 rounded-r-lg px-3 py-2 text-xs font-bold text-slate-500">
                            {products.find(p => p.sku_id === budgetSku)?.default_unit || 'kg'}
                        </span>
                    </div>
                </div>
                <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                    <div className="text-[10px] font-black text-green-700 uppercase tracking-widest mb-1">Total Procurement Budget</div>
                    <div className="text-3xl font-black text-green-800">£{budgetReport?.totalBudget.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2}) || '0.00'}</div>
                </div>
            </div>
            
            <button 
                onClick={handleSaveBudgetReport}
                disabled={isSavingReport || !budgetSku}
                className="w-full py-4 bg-green-600 text-white rounded-xl font-bold uppercase tracking-widest shadow-lg hover:bg-green-700 transition flex items-center justify-center disabled:opacity-50"
            >
                {isSavingReport ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                Save Budget Plan
            </button>
        </div>

        <div className={detailPanelClass}>
            {budgetReport ? (
                <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                    <div className="overflow-x-auto">
                    <table className="w-full min-w-[680px] text-sm text-left">
                        <thead className="bg-slate-50 text-slate-500 font-bold uppercase text-[10px] tracking-widest border-b border-slate-200">
                            <tr>
                                <th className="px-4 py-3">Component</th>
                                <th className="px-4 py-3 text-right">Required</th>
                                <th className="px-4 py-3 text-right">Stock</th>
                                <th className="px-4 py-3 text-right bg-orange-50 text-orange-800">To Buy</th>
                                <th className="px-4 py-3 text-right">Est. Cost</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {budgetReport.rows.map((row) => (
                                <tr key={row.id} className="hover:bg-slate-50">
                                    <td className="px-4 py-3 font-bold text-slate-700 text-xs">{row.name}</td>
                                    <td className="px-4 py-3 text-right text-xs font-mono">{row.required.toFixed(2)} {row.unit}</td>
                                    <td className="px-4 py-3 text-right text-xs font-mono text-slate-500">{row.stock.toFixed(2)}</td>
                                    <td className={`px-4 py-3 text-right bg-orange-50/50 ${row.toBuy > 0 ? 'text-red-600 font-bold' : 'text-green-600'}`}>
                                        <div className="flex justify-end items-center">
                                            <input 
                                                type="number"
                                                className={`w-20 text-right border rounded text-xs py-1 px-1 font-bold ${row.toBuy > 0 ? 'border-red-200 bg-red-50 text-red-700' : 'border-slate-200 bg-white text-slate-400'}`}
                                                value={row.toBuy}
                                                onChange={e => setBuyQtyOverrides({...buyQtyOverrides, [row.id]: Number(e.target.value)})}
                                            />
                                        </div>
                                    </td>
                                    <td className="px-4 py-3 text-right font-bold text-slate-700 text-xs">
                                        {row.totalCost > 0 ? `£${row.totalCost.toFixed(2)}` : '-'}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    </div>
                </div>
            ) : (
                <div className="h-full flex flex-col items-center justify-center text-slate-400 border-2 border-dashed border-slate-200 rounded-xl min-h-[400px]">
                    <Coins className="w-12 h-12 mb-4 text-slate-300" />
                    <p>Select a product to calculate budget.</p>
                </div>
            )}
        </div>
        </div>
    </div>
  );
};
