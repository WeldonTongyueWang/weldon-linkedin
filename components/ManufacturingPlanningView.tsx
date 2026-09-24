
import React, { useState } from 'react';
import { Product, Component, BOMItem, InventoryTransaction, Supplier, OpenPO, RawComponentLot, AppSettings, UserRole, ProductBatch, BatchRecord, CategoryMaster } from '../types';
import { Wallet, AlertTriangle, Wrench, CalendarRange, ShieldCheck } from 'lucide-react';
import { CostingTool } from './planning/CostingTool';
import { BudgetingTool } from './planning/BudgetingTool';
import { AlertLinesTool } from './planning/AlertLinesTool';
import { SafetyStockTool } from './planning/SafetyStockTool';
import { ManufacturingSchedulingTool } from './planning/ManufacturingSchedulingTool';
import { canEditSubTab, canViewSubTab } from '../config/accessControl';

interface Props {
  currentUser: string;
  userRole: UserRole | null;
  products: Product[];
  inventory: Component[];
  categories?: CategoryMaster[];
  bom: BOMItem[];
  transactions: InventoryTransaction[];
  suppliers: Supplier[];
  openPos: OpenPO[];
  rawComponentLots?: RawComponentLot[];
  productBatches?: ProductBatch[];
  batchRecords?: BatchRecord[];
  isReadOnly?: boolean;
  settings?: AppSettings;
}

type ToolMode = 'ALERT_LINES' | 'SAFETY_STOCK' | 'BUDGETING' | 'MANUFACTURING_SCHEDULING' | 'COSTING';

export const ManufacturingPlanningView: React.FC<Props> = ({ 
  currentUser, userRole, products, inventory, categories = [], bom, transactions, suppliers, isReadOnly, rawComponentLots = [], productBatches = [], batchRecords = [], openPos, settings: _settings
}) => {
  const [activeTool, setActiveTool] = useState<ToolMode>('ALERT_LINES');

  const tools = [
    { id: 'ALERT_LINES' as const, key: 'alert_lines', label: 'Alerting', icon: AlertTriangle },
    { id: 'SAFETY_STOCK' as const, key: 'safety_stock', label: 'Safety Stock', icon: ShieldCheck },
    { id: 'BUDGETING' as const, key: 'budgeting', label: 'Budgeting (Long term)', icon: Wallet },
    { id: 'MANUFACTURING_SCHEDULING' as const, key: 'manufacturing_scheduling', label: 'Scheduling (Mid Term)', icon: CalendarRange },
    { id: 'COSTING' as const, key: 'costing', label: 'Costing (Exploratory)', icon: Wrench },
  ];

  const visibleTools = tools.filter(tool => canViewSubTab(userRole, 'manufacturing', tool.key, currentUser));
  const activeToolMeta = visibleTools.find(tool => tool.id === activeTool) || visibleTools[0];
  const activeToolReadOnly = activeToolMeta ? !canEditSubTab(userRole, 'manufacturing', activeToolMeta.key, currentUser) : true;

  React.useEffect(() => {
    if (!activeToolMeta && visibleTools.length > 0) {
      setActiveTool(visibleTools[0].id);
    } else if (activeToolMeta && activeToolMeta.id !== activeTool) {
      setActiveTool(activeToolMeta.id);
    }
  }, [activeTool, activeToolMeta, visibleTools]);

  return (
    <div className="space-y-6 animate-in fade-in">
      
      {/* Tool Navigation */}
      <div className="sticky top-0 z-20 flex border-b border-slate-200 bg-slate-100/95 backdrop-blur overflow-x-auto whitespace-nowrap">
        {visibleTools.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTool === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTool(tab.id as ToolMode)}
              className={`flex shrink-0 items-center px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                isActive 
                  ? 'border-indigo-600 text-indigo-600' 
                  : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
              }`}
            >
              <Icon className="w-4 h-4 mr-2" />
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="bg-white p-4 sm:p-6 md:p-8 rounded-xl shadow-sm border border-slate-200 min-h-0 md:min-h-[600px]">
        
        {visibleTools.length === 0 && (
          <div className="h-full flex items-center justify-center text-slate-400 italic min-h-[400px]">No access to Manufacturing subtabs.</div>
        )}

        {/* --- TOOL 1: ALERT LINES --- */}
        {activeToolMeta?.id === 'ALERT_LINES' && (
            <AlertLinesTool 
                currentUser={currentUser}
                inventory={inventory}
                categories={categories}
                transactions={transactions}
                rawComponentLots={rawComponentLots}
                suppliers={suppliers}
                isReadOnly={isReadOnly || activeToolReadOnly}
            />
        )}

        {/* --- TOOL 2: SAFETY STOCK --- */}
        {activeToolMeta?.id === 'SAFETY_STOCK' && (
            <SafetyStockTool
                products={products}
                transactions={transactions}
            />
        )}

        {/* --- TOOL 3: BUDGETING --- */}
        {activeToolMeta?.id === 'BUDGETING' && (
            <BudgetingTool 
                currentUser={currentUser}
                products={products}
                inventory={inventory}
                categories={categories}
                bom={bom}
                transactions={transactions}
                rawComponentLots={rawComponentLots}
                isReadOnly={isReadOnly || activeToolReadOnly}
            />
        )}

        {/* --- TOOL 4: MANUFACTURING SCHEDULING --- */}
        {activeToolMeta?.id === 'MANUFACTURING_SCHEDULING' && (
            <ManufacturingSchedulingTool
                currentUser={currentUser}
                products={products}
                transactions={transactions}
                inventory={inventory}
                categories={categories}
                bom={bom}
                rawComponentLots={rawComponentLots}
                productBatches={productBatches}
                isReadOnly={isReadOnly || activeToolReadOnly}
            />
        )}

        {/* --- TOOL 5: COSTING --- */}
        {activeToolMeta?.id === 'COSTING' && (
            <CostingTool 
                currentUser={currentUser}
                products={products}
                inventory={inventory}
                categories={categories}
                bom={bom}
                transactions={transactions}
                rawComponentLots={rawComponentLots}
                batchRecords={batchRecords}
                isReadOnly={isReadOnly || activeToolReadOnly}
            />
        )}

      </div>
    </div>
  );
};
