import React, { useState } from 'react';
import './inventory-ui.css';
import '../mobile-ui.css';
import { 
  Component, 
  Product, 
  InventoryTransaction, 
  RawComponentLot, 
  BatchRecord, 
  IngredientBatch, 
  ProductBatch, 
  Supplier,
  UserRole,
  CategoryMaster,
  StockBalance
} from '../../types';
import { ProductReception } from './ProductReception';
import { ProductDispatch } from './ProductDispatch';
import { ComponentReception } from './ComponentReception';
import { ComponentDispatch } from './ComponentDispatch';
import { InventoryDashboard } from './InventoryDashboard';
import { POSummaryView } from './POSummaryView';
import { TransactionLogs } from './TransactionLogs';
import { LayoutGrid, Download, History, ArrowDownCircle, ArrowUpCircle, Package, FileSearch } from 'lucide-react';
import { canEditSubTab, canViewSubTab } from '../../config/accessControl';
import { getActiveRawComponents } from '../../services/rawComponentsService';

interface Props {
  currentUser: string;
  userRole: UserRole | null;
  inventory: Component[];
  products: Product[];
  categories: CategoryMaster[];
  documents?: any[];
  transactions: InventoryTransaction[];
  stockBalances?: StockBalance[];
  ingredientBatches: IngredientBatch[];
  rawComponentLots: RawComponentLot[];
  productBatches: ProductBatch[];
  suppliers: Supplier[];
  onTransaction: (tx: any, lotMetadata?: any) => Promise<InventoryTransaction | void> | InventoryTransaction | void;
  onEditTransaction: (id: string, updates: any, reason: string, user: string) => Promise<void> | void;
  onDeleteTransaction: (id: string) => Promise<void> | void;
  onEditProductInActivity?: (payload: any) => Promise<void> | void;
  onDeleteProductInActivity?: (tx: InventoryTransaction, linkedBatch?: ProductBatch | null) => Promise<void> | void;
  onCreateLot?: (lot: RawComponentLot) => Promise<void> | void;
  onUpdateLot?: (lotId: string, updates: Partial<RawComponentLot>, reason: string, user: string) => Promise<void> | void;
  onDeleteLot?: (lotId: string) => Promise<void>;
  onCreateBatch: (batch: Partial<BatchRecord>) => Promise<void> | void;
  onUpdateBatch?: (batch: BatchRecord) => Promise<void> | void;
  onDeleteBatch?: (id: string) => Promise<void> | void;
  onRenameBatchReference?: (oldId: string, newId: string, batch: BatchRecord, user: string) => Promise<void> | void;
  onReleaseBatch?: (batch: BatchRecord) => Promise<void> | void;
  onForceSync?: () => Promise<void> | void;
  onSubTabChange?: (subTab: 'dashboard' | 'po_summary' | 'logs' | 'comp_in' | 'comp_out' | 'prod_in' | 'prod_out') => void;
  onUpsertCompOutQuarantineMeta?: (payload: { docId: string; group: string; reason: string; note: string; user: string }) => Promise<void> | void;
  isReadOnly?: boolean;
  isTransactionDataReady?: boolean;
  isDashboardDataReady?: boolean;
  isStockBalanceDataReady?: boolean;
  hasRelevantPendingChanges?: boolean;
}

export const InventoryManagerView: React.FC<Props> = ({
  currentUser,
  userRole,
  inventory,
  products,
  categories,
  documents = [],
  transactions,
  stockBalances = [],
  ingredientBatches,
  rawComponentLots,
  productBatches,
  suppliers,
  onTransaction,
  onEditTransaction,
  onDeleteTransaction,
  onEditProductInActivity,
  onDeleteProductInActivity,
  onCreateLot,
  onUpdateLot,
  onDeleteLot,
  onCreateBatch,
  onUpdateBatch,
  onDeleteBatch,
  onRenameBatchReference,
  onReleaseBatch,
  onForceSync,
  onSubTabChange,
  onUpsertCompOutQuarantineMeta,
  isReadOnly,
  isTransactionDataReady = true,
  isDashboardDataReady = true,
  isStockBalanceDataReady = true,
  hasRelevantPendingChanges = false,
}) => {
  const [subTab, setSubTab] = useState<'dashboard' | 'po_summary' | 'logs' | 'comp_in' | 'comp_out' | 'prod_in' | 'prod_out'>('dashboard');
  const [editingLot, setEditingLot] = useState<RawComponentLot | null>(null);
  const activeInventory = React.useMemo(() => getActiveRawComponents(inventory), [inventory]);
  const activeInventoryIds = React.useMemo(
    () => new Set(activeInventory.map((item) => String(item.component_id || '').trim().toLowerCase()).filter(Boolean)),
    [activeInventory]
  );
  const inventoryTransactions = React.useMemo(
    () => transactions.filter((tx) => tx.category !== 'COMPONENT' || activeInventoryIds.has(String(tx.itemId || '').trim().toLowerCase())),
    [transactions, activeInventoryIds]
  );
  const inventoryStockBalances = React.useMemo(
    () => stockBalances.filter((row) => row.category !== 'COMPONENT' || activeInventoryIds.has(String(row.itemId || '').trim().toLowerCase())),
    [stockBalances, activeInventoryIds]
  );
  const inventoryRawComponentLots = React.useMemo(
    () => rawComponentLots.filter((lot) => activeInventoryIds.has(String(lot.itemId || '').trim().toLowerCase())),
    [rawComponentLots, activeInventoryIds]
  );

  const handleEditLotInit = (lot: RawComponentLot) => {
      console.log("Edit requested for lot", lot.qc_number);
      setEditingLot(lot);
  };

  const tabs = [
    { id: 'dashboard', key: 'overview', label: 'Overview', icon: LayoutGrid },
    { id: 'po_summary', key: 'po_summary', label: 'PO Summary', icon: FileSearch },
    { id: 'logs', key: 'history', label: 'History', icon: History },
    { id: 'divider' }, // Visual separator
    { id: 'comp_in', key: 'goods_in', label: 'Comp In', icon: ArrowDownCircle },
    { id: 'comp_out', key: 'staging', label: 'Comp Out', icon: ArrowUpCircle },
    { id: 'divider' },
    { id: 'prod_in', key: 'product_in', label: 'Product In', icon: Package },
    { id: 'prod_out', key: 'dispatch', label: 'Product Out', icon: Download },
  ] as const;

  const visibleTabs = tabs.filter(tab => tab.id === 'divider' || canViewSubTab(userRole, 'inventory', (tab as any).key, currentUser));
  const hasAccess = visibleTabs.some(tab => tab.id !== 'divider');
  const activeTabMeta = tabs.find(tab => tab.id !== 'divider' && tab.id === subTab) as any;
  const activeSubTabReadOnly = activeTabMeta ? !canEditSubTab(userRole, 'inventory', activeTabMeta.key, currentUser) : true;

  React.useEffect(() => {
    if (!hasAccess) return;
    const activeVisible = visibleTabs.some(tab => tab.id === subTab);
    if (!activeVisible) {
      const firstVisible = visibleTabs.find(tab => tab.id !== 'divider') as any;
      if (firstVisible) setSubTab(firstVisible.id);
    }
  }, [hasAccess, subTab, visibleTabs]);

  React.useEffect(() => {
    onSubTabChange?.(subTab);
  }, [onSubTabChange, subTab]);

  const showDeferredLedgerPlaceholder =
    !isTransactionDataReady &&
    (subTab === 'po_summary' || subTab === 'logs');
  const showDeferredDashboardPlaceholder =
    !isDashboardDataReady && subTab === 'dashboard';

  return (
    <div className="inventory-ui space-y-4 sm:space-y-6 animate-in fade-in duration-500">
      
      {/* Navigation Tabs */}
      <div className="mobile-tab-strip sticky top-0 z-20 flex border-b border-slate-200 bg-slate-100/95 backdrop-blur overflow-x-auto whitespace-nowrap">
        {visibleTabs.map((tab, idx) => {
          if (tab.id === 'divider') {
            return null;
          }
          const Icon = tab.icon!;
          const isActive = subTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setSubTab(tab.id as any)}
              className={`inventory-subtab-button flex shrink-0 items-center px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                isActive
                  ? 'border-indigo-600 text-indigo-600'
                  : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
              }`}
            >
              <Icon className={`w-4 h-4 mr-2 ${isActive ? 'text-indigo-600' : 'text-slate-400'}`} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Content Area */}
      <div className="min-h-0 md:min-h-[600px] pb-2">
        {!hasAccess && (
          <div className="h-full flex items-center justify-center text-slate-400 italic">No access to Inventory subtabs.</div>
        )}

        {hasAccess && showDeferredLedgerPlaceholder && (
          <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
            Inventory summary data is loading from local demo storage. You can keep navigating while the ledger records are prepared.
          </div>
        )}

        {hasAccess && showDeferredDashboardPlaceholder && (
          <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
            Inventory summary data is refreshing. Existing local data remains visible while the latest snapshot is prepared.
          </div>
        )}

        {hasAccess && hasRelevantPendingChanges && !showDeferredLedgerPlaceholder && !showDeferredDashboardPlaceholder && (
          <div className="mb-3 rounded border border-amber-200 bg-amber-50 px-4 py-2 text-xs font-medium text-amber-900">
            Refresh available. Current values remain stable until you refresh; edits will refresh first.
          </div>
        )}

        {hasAccess && !showDeferredLedgerPlaceholder && !showDeferredDashboardPlaceholder && subTab === 'dashboard' && (
            <InventoryDashboard 
              inventory={activeInventory} 
              categories={categories}
              products={products}
              transactions={inventoryTransactions} 
              stockBalances={inventoryStockBalances}
              productBatches={productBatches}
              rawComponentLots={inventoryRawComponentLots}
              isTransactionDataReady={isTransactionDataReady}
              isStockBalanceDataReady={isStockBalanceDataReady}
              onForceSync={onForceSync}
              onUpdateBatch={onUpdateBatch}
            />
        )}

        {hasAccess && !showDeferredLedgerPlaceholder && subTab === 'logs' && (
            <TransactionLogs 
                transactions={inventoryTransactions} 
                rawComponentLots={inventoryRawComponentLots} 
                productBatches={productBatches}
                products={products}
                inventory={activeInventory}
                categories={categories}
                currentUser={currentUser} 
                onEditInit={() => {}} 
                onDeleteTransaction={onDeleteTransaction}
                isReadOnly={isReadOnly || activeSubTabReadOnly}
            />
        )}

        {hasAccess && !showDeferredLedgerPlaceholder && subTab === 'po_summary' && (
            <POSummaryView
              transactions={inventoryTransactions}
              products={products}
              productBatches={productBatches}
              rawComponentLots={inventoryRawComponentLots}
            />
        )}

        {hasAccess && subTab === 'comp_in' && (
            <ComponentReception 
                currentUser={currentUser}
                inventory={activeInventory}
                products={products}
                categories={categories}
                transactions={inventoryTransactions}
                suppliers={suppliers}
                rawComponentLots={inventoryRawComponentLots}
                onTransaction={onTransaction}
                onCreateLot={onCreateLot}
                onUpdateLot={onUpdateLot}
                onDeleteLot={onDeleteLot}
                onEditLotInit={handleEditLotInit}
                isReadOnly={isReadOnly || activeSubTabReadOnly}
            />
        )}

        {hasAccess && subTab === 'comp_out' && (
            <ComponentDispatch 
                inventory={activeInventory}
                categories={categories}
                products={products}
                documents={documents}
                transactions={inventoryTransactions}
                rawComponentLots={inventoryRawComponentLots}
                productBatches={productBatches}
                currentUser={currentUser}
                onTransaction={onTransaction}
                onEditTransaction={onEditTransaction}
                onDeleteTransaction={onDeleteTransaction}
                onUpsertQuarantineMeta={onUpsertCompOutQuarantineMeta}
                isReadOnly={isReadOnly || activeSubTabReadOnly}
            />
        )}

        {hasAccess && subTab === 'prod_in' && (
            <ProductReception 
                products={products} 
                productBatches={productBatches} 
                transactions={transactions}
                currentUser={currentUser} 
                onTransaction={onTransaction}
                onEditTransaction={onEditTransaction}
                onDeleteTransaction={onDeleteTransaction}
                onEditProductInActivity={onEditProductInActivity}
                onDeleteProductInActivity={onDeleteProductInActivity}
                onCreateBatch={onCreateBatch}
                onUpdateBatch={onUpdateBatch}
                onDeleteBatch={onDeleteBatch}
                onRenameBatchReference={onRenameBatchReference}
                onReleaseBatch={onReleaseBatch}
                isReadOnly={isReadOnly || activeSubTabReadOnly}
            />
        )}

        {hasAccess && subTab === 'prod_out' && (
            <ProductDispatch 
                inventory={activeInventory}
                categories={categories}
                products={products} 
                transactions={inventoryTransactions}
                rawComponentLots={inventoryRawComponentLots}
                productBatches={productBatches}
                currentUser={currentUser} 
                onTransaction={onTransaction} 
                onEditTransaction={onEditTransaction}
                onDeleteTransaction={onDeleteTransaction}
                onForceSync={onForceSync}
                isReadOnly={isReadOnly || activeSubTabReadOnly}
            />
        )}
      </div>
    </div>
  );
};
