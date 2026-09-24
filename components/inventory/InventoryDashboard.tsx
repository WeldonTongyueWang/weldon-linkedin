import React, { useState, useMemo } from 'react';
import { CategoryMaster, Component, InventoryTransaction, LocationName, ComponentType, Product, ProductBatch, RawComponentLot, StockBalance } from '../../types';
import { Package, MapPin, Layers, ChevronRight, ChevronDown, ArrowUpDown, Beaker, Download, AlertTriangle, ShoppingCart, PauseCircle, Check, RotateCcw } from 'lucide-react';
import { RAW_COMPONENT_REGISTRY } from '../../masterdata/rawComponentRegistry';
import { computeLedgerStockLevels, UNBATCHED_KEY, LedgerStockPosition } from '../../services/ledgerStock';
import { stockBalanceRowsToLedgerStockLevels } from '../../storage/stockBalances.js';
import { buildLatestComponentUnitCostMap, resolveLedgerUnitCost } from '../../services/ledgerPricing';
import { PRODUCT_CATEGORY_ORDER, resolveProductCategoryGroup } from '../../services/productCategoryGrouping';
import { formatRawComponentInventoryLabel, formatRawComponentListLabel } from '../../utils/rawComponentLabels';
import {
  formatFinishedProductInventoryLabel,
} from '../../utils/finishedProductLabels';

const normalizeText = (val: unknown): string => {
  if (val === undefined || val === null) return "";
  return String(val).trim();
};

const normalizeSearchText = (value: unknown): string =>
  normalizeText(value).toLowerCase().replace(/\s+/g, ' ');

const matchesSearch = (fields: Array<unknown>, query: string): boolean => {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return true;
  return fields.some((field) => normalizeSearchText(field).includes(normalizedQuery));
};

const getDateOnlyValue = (source: unknown): string => {
  const raw = normalizeText(source);
  if (!raw) return '';
  const timestamp = new Date(raw).getTime();
  if (!Number.isFinite(timestamp)) {
    const matched = raw.match(/\d{4}-\d{2}-\d{2}/);
    return matched ? matched[0] : '';
  }
  return new Date(timestamp).toISOString().slice(0, 10);
};

const filterFieldClass = 'w-full h-11 border border-slate-300 rounded bg-white px-3 text-base sm:text-sm shadow-none';

const formatInventoryCheckQuantity = (value: number): string => {
  const roundedOneDecimal = Math.round(Number(value || 0) * 10) / 10;
  return Number.isInteger(roundedOneDecimal)
      ? String(roundedOneDecimal)
      : roundedOneDecimal.toFixed(1);
};

const PRODUCT_CATEGORY_ORDER_INDEX = new Map<string, number>(
  PRODUCT_CATEGORY_ORDER.map((label, index) => [label, index])
);

const normalizeStatusKey = (val: unknown): string =>
  normalizeText(val).toLowerCase().replace(/[\s_-]+/g, '_');

const isArchivedProduct = (product: Product): boolean =>
  normalizeText(product.category).toLowerCase().includes('archived');

const isRejectedStatus = (val: unknown): boolean => {
  const normalized = normalizeStatusKey(val);
  return normalized === 'rejected' || normalized === 'qc_rejected';
};

const normalizeQcDisposition = (val: unknown): string =>
  normalizeText(val).toLowerCase().replace(/[\s-]+/g, '_') || 'standard';

const isOnHoldStatus = (val: unknown): boolean => {
  const normalized = normalizeStatusKey(val);
  return normalized === 'on_hold';
};

interface Props {
  inventory: Component[];
  categories?: CategoryMaster[];
  products: Product[];
  transactions: InventoryTransaction[];
  stockBalances?: StockBalance[];
  productBatches: ProductBatch[];
  rawComponentLots: RawComponentLot[];
  isTransactionDataReady?: boolean;
  isStockBalanceDataReady?: boolean;
  onForceSync?: () => Promise<void> | void;
  onUpdateBatch?: (batch: any) => Promise<void> | void;
}

interface ReservedLedgerRow {
  txId: string;
  reference: string;
  itemId: string;
  itemName: string;
  category: 'COMPONENT' | 'PRODUCT';
  batchNumber: string;
  quantity: number;
  unit: string;
  unitCost: number;
  value: number;
  reason: string;
  time: number;
}

interface ReservedLedgerGroup {
  key: string;
  reference: string;
  items: ReservedLedgerRow[];
  totalQty: number;
  totalValue: number;
  latestTime: number;
}

interface OnHoldRow {
  id: string;
  groupKey: 'raw_component_lot' | 'batches_master';
  groupLabel: string;
  itemId: string;
  itemName: string;
  category: 'COMPONENT' | 'PRODUCT';
  batchNumber: string;
  quantity: number;
  unit: string;
  unitCost: number;
  value: number;
  status: string;
}

interface OnHoldGroup {
  key: 'raw_component_lot' | 'batches_master';
  label: string;
  items: OnHoldRow[];
  totalQty: number;
  totalValue: number;
}

export const InventoryDashboard: React.FC<Props> = ({
  inventory,
  categories = [],
  products,
  transactions,
  stockBalances = [],
  productBatches,
  rawComponentLots,
  isTransactionDataReady = true,
  isStockBalanceDataReady = true,
  onForceSync,
  onUpdateBatch,
}) => {
  const todayDate = new Date().toISOString().slice(0, 10);
  const [viewType, setViewType] = useState<'COMPONENT' | 'PRODUCT'>('COMPONENT');
  const [dashLocation, setDashLocation] = useState<'ALL' | 'Riverside' | 'Hilltop'>('ALL');
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({});
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});
  const [expandedReserved, setExpandedReserved] = useState(false);
  const [expandedReservedGroups, setExpandedReservedGroups] = useState<Record<string, boolean>>({});
  const [expandedOnHold, setExpandedOnHold] = useState(false);
  const [expandedOnHoldGroups, setExpandedOnHoldGroups] = useState<Record<string, boolean>>({});
  const [expandedRejected, setExpandedRejected] = useState(false);
  const [draftOverviewToDate, setDraftOverviewToDate] = useState(todayDate);
  const [appliedOverviewToDate, setAppliedOverviewToDate] = useState(todayDate);
  const [draftOverviewSearchQuery, setDraftOverviewSearchQuery] = useState('');
  const [appliedOverviewSearchQuery, setAppliedOverviewSearchQuery] = useState('');
  const [sortKey, setSortKey] = useState<'name' | 'qty' | 'value'>('name');

  const filteredTransactionsForOverview = useMemo(() => {
    return transactions.filter((tx) => {
      if (!appliedOverviewToDate) return true;
      const dateOnly = getDateOnlyValue(tx.createdAt || tx.updatedAt || tx.date);
      return Boolean(dateOnly) && dateOnly <= appliedOverviewToDate;
    });
  }, [transactions, appliedOverviewToDate]);

  const filteredRawComponentLotsForOverview = useMemo(() => {
    return rawComponentLots.filter((lot) => {
      if (!appliedOverviewToDate) return true;
      const dateOnly = getDateOnlyValue(lot.updatedAt || lot.createdAt || lot.deliveryDate);
      return Boolean(dateOnly) && dateOnly <= appliedOverviewToDate;
    });
  }, [rawComponentLots, appliedOverviewToDate]);

  const filteredProductBatchesForOverview = useMemo(() => {
    return productBatches.filter((batch) => {
      if (!appliedOverviewToDate) return true;
      const dateOnly = getDateOnlyValue((batch as any).updatedAt || (batch as any).createdAt || batch.date_produced);
      return Boolean(dateOnly) && dateOnly <= appliedOverviewToDate;
    });
  }, [productBatches, appliedOverviewToDate]);

  // --- DERIVE STOCK LEVELS FROM LEDGER ---
  // Note: Only released items exist in the transactions array as 'IN' ledger records.
  const shouldUseStockBalanceRows =
    stockBalances.length > 0 &&
    appliedOverviewToDate === todayDate;
  const showHistoricalLedgerSyncPrompt = appliedOverviewToDate !== todayDate && !isTransactionDataReady;
  const showCurrentSummarySyncNote = appliedOverviewToDate === todayDate && !isStockBalanceDataReady && !isTransactionDataReady;
  const ledgerStockLevels = useMemo<Record<string, LedgerStockPosition>>(
    () => shouldUseStockBalanceRows
      ? stockBalanceRowsToLedgerStockLevels(stockBalances) as Record<string, LedgerStockPosition>
      : computeLedgerStockLevels(filteredTransactionsForOverview, filteredRawComponentLotsForOverview, filteredProductBatchesForOverview),
    [shouldUseStockBalanceRows, stockBalances, filteredTransactionsForOverview, filteredRawComponentLotsForOverview, filteredProductBatchesForOverview]
  );

  const latestIngredientPrices = useMemo(() => {
    return buildLatestComponentUnitCostMap(filteredTransactionsForOverview, filteredRawComponentLotsForOverview, inventory);
  }, [filteredTransactionsForOverview, filteredRawComponentLotsForOverview, inventory]);

  const itemBatchUnitPrices = useMemo(() => {
    const stats: Record<string, Record<string, { inQty: number; inValue: number }>> = {};
    filteredTransactionsForOverview.forEach(t => {
      if (t.type !== 'IN') return;
      if (t.category !== 'COMPONENT' && t.category !== 'PRODUCT') return;
      if (!t.itemId) return;
      const unitCost = resolveLedgerUnitCost(t, { rawComponentLots: filteredRawComponentLotsForOverview, productBatches: filteredProductBatchesForOverview, itemMaster: inventory });
      if (unitCost <= 0) return;

      const batchKey = normalizeText(t.batchNumber) || UNBATCHED_KEY;
      if (!stats[t.itemId]) stats[t.itemId] = {};
      if (!stats[t.itemId][batchKey]) stats[t.itemId][batchKey] = { inQty: 0, inValue: 0 };

      const qty = Number(t.quantity) || 0;
      stats[t.itemId][batchKey].inQty += qty;
      stats[t.itemId][batchKey].inValue += qty * unitCost;
    });

    const prices: Record<string, Record<string, number>> = {};
    Object.entries(stats).forEach(([itemId, byBatch]) => {
      prices[itemId] = {};
      Object.entries(byBatch).forEach(([batch, values]) => {
        prices[itemId][batch] = values.inQty > 0 ? (values.inValue / values.inQty) : 0;
      });
    });
    return prices;
  }, [filteredTransactionsForOverview, filteredRawComponentLotsForOverview, filteredProductBatchesForOverview, inventory]);

  const combinedDashData = useMemo<any[]>(() => {
    // 1. Map Ingredients
    const components = inventory.map(item => {
        const ledgerData = ledgerStockLevels[item.component_id];
        const batchPrices = itemBatchUnitPrices[item.component_id] || {};
        const fallbackPrice = latestIngredientPrices[item.component_id] || 0;
        
        const ngQty = ledgerData?.byLocation?.Riverside?.onHand || 0;
        const mgQty = ledgerData?.byLocation?.Hilltop?.onHand || 0;
        const totalQty = ledgerData?.totalOnHand || 0;
        const batches = Object.keys(ledgerData?.byBatch || {});

        const computeBatchValue = (location: 'ALL' | 'Riverside' | 'Hilltop') => {
            let total = 0;
            batches.forEach(batch => {
                const qty = location === 'ALL'
                    ? Number(ledgerData?.byBatch?.[batch]?.onHand || 0)
                    : Number(ledgerData?.byBatchLocation?.[batch]?.[location]?.onHand || 0);
                if (Math.abs(qty) < 0.000001) return;
                const unitPrice = batchPrices[batch] ?? fallbackPrice;
                total += qty * unitPrice;
            });
            return total;
        };

        const ngValue = computeBatchValue('Riverside');
        const mgValue = computeBatchValue('Hilltop');
        const totalValue = computeBatchValue('ALL');
        const avgUnitPrice = Math.abs(totalQty) > 0.000001 ? (totalValue / totalQty) : 0;

        const displayName = formatRawComponentInventoryLabel(item, categories);

        return {
            id: item.component_id,
            name: displayName || item.component_id || "Unnamed Component",
            unit: item.default_unit || "unit",
            type: item.type, 
            price: avgUnitPrice,
            kind: 'COMPONENT',
            Riverside: { qty: ngQty, value: ngValue },
            Hilltop: { qty: mgQty, value: mgValue },
            ALL: { qty: totalQty, value: totalValue }
        };
    });

    // 2. Map Products
    const finishedGoods = products.filter((prod) => !isArchivedProduct(prod)).map(prod => {
        const ledgerData = ledgerStockLevels[prod.sku_id];
        const batchPrices = itemBatchUnitPrices[prod.sku_id] || {};
        const productCategoryGroup = resolveProductCategoryGroup(prod);
        
        const ngQty = ledgerData?.byLocation?.Riverside?.onHand || 0;
        const mgQty = ledgerData?.byLocation?.Hilltop?.onHand || 0;
        const totalQty = ledgerData?.totalOnHand || 0;
        const batches = Object.keys(ledgerData?.byBatch || {});

        const computeBatchValue = (location: 'ALL' | 'Riverside' | 'Hilltop') => {
            let total = 0;
            batches.forEach(batch => {
                const qty = location === 'ALL'
                    ? Number(ledgerData?.byBatch?.[batch]?.onHand || 0)
                    : Number(ledgerData?.byBatchLocation?.[batch]?.[location]?.onHand || 0);
                if (Math.abs(qty) < 0.000001) return;
                const unitPrice = batchPrices[batch] || 0;
                total += qty * unitPrice;
            });
            return total;
        };

        const ngValue = computeBatchValue('Riverside');
        const mgValue = computeBatchValue('Hilltop');
        const totalValue = computeBatchValue('ALL');
        const weightedUnitPrice = Math.abs(totalQty) > 0.000001 ? (totalValue / totalQty) : 0;

        return {
            id: prod.sku_id,
            name: formatFinishedProductInventoryLabel(prod),
            unit: prod.default_unit || "unit",
            type: productCategoryGroup || "Finished Good", // Grouping Key
            price: weightedUnitPrice,
            kind: 'PRODUCT',
            Riverside: { qty: ngQty, value: ngValue },
            Hilltop: { qty: mgQty, value: mgValue },
            ALL: { qty: totalQty, value: totalValue }
        };
    });

    return [
      ...components.filter(i => Math.abs(i.ALL.qty) > 0.001),
      ...finishedGoods
    ];
  }, [inventory, products, latestIngredientPrices, ledgerStockLevels, itemBatchUnitPrices]);

  const viewTypeDashData = useMemo(() => {
      return combinedDashData.filter(item => item.kind === viewType);
  }, [combinedDashData, viewType]);

  const filteredDashData = useMemo(() => {
      return viewTypeDashData.filter((item) =>
          matchesSearch(
              [
                  item.name,
                  item.id,
                  item.type,
                  item.unit,
                  ...Object.keys(ledgerStockLevels[item.id]?.byBatch || {})
              ],
              appliedOverviewSearchQuery
          )
      );
  }, [viewTypeDashData, ledgerStockLevels, appliedOverviewSearchQuery]);

  const summary = useMemo(() => {
      const sum = { Riverside: 0, Hilltop: 0, ALL: 0 };
      filteredDashData.forEach(i => {
          sum.Riverside += i.Riverside.value;
          sum.Hilltop += i.Hilltop.value;
          sum.ALL += i.ALL.value;
      });
      return sum;
  }, [filteredDashData]);

  const reservedGroups = useMemo<ReservedLedgerGroup[]>(() => {
      const reservedReasons = new Set(['RESERVATION', 'DISPATCH_STAGED']);
      const componentById = new Map(
          inventory.map((item) => [normalizeText(item.component_id).toLowerCase(), item])
      );
      const productById = new Map(
          products.map((product) => [normalizeText(product.sku_id).toLowerCase(), product])
      );

      const rows: ReservedLedgerRow[] = transactions
          .filter((tx) =>
              tx.type === 'OUT' &&
              (tx.category === 'COMPONENT' || tx.category === 'PRODUCT') &&
              reservedReasons.has(normalizeText(tx.reason).toUpperCase())
          )
          .map((tx) => {
              const quantity = Number(tx.quantity) || 0;
          const unitCost = resolveLedgerUnitCost(tx, { rawComponentLots: filteredRawComponentLotsForOverview, productBatches: filteredProductBatchesForOverview, itemMaster: inventory });
              const itemKey = normalizeText(tx.itemId).toLowerCase();
              const matchedComponent = componentById.get(itemKey);
              const matchedProduct = productById.get(itemKey);
              const fallbackName = tx.category === 'COMPONENT'
                  ? (matchedComponent ? formatRawComponentListLabel(matchedComponent, categories) : tx.itemId)
                  : (matchedProduct ? formatFinishedProductInventoryLabel(matchedProduct) : tx.itemId);
              const createdTimeRaw = normalizeText(tx.createdAt || tx.updatedAt || tx.date);
              const parsedTime = createdTimeRaw ? new Date(createdTimeRaw).getTime() : 0;
              const safeTime = Number.isFinite(parsedTime) ? parsedTime : 0;

              return {
                  txId: normalizeText(tx.id) || `${normalizeText(tx.itemId)}-${normalizeText(tx.batchNumber)}-${quantity}`,
                  reference: normalizeText(tx.reference) || 'Unreferenced',
                  itemId: tx.itemId,
                  itemName: fallbackName || normalizeText(tx.itemName) || tx.itemId,
                  category: tx.category,
                  batchNumber: normalizeText(tx.batchNumber) || UNBATCHED_KEY,
                  quantity,
                  unit: normalizeText(tx.unit) || (tx.category === 'PRODUCT' ? 'kg' : 'unit'),
                  unitCost,
                  value: quantity * unitCost,
                  reason: normalizeText(tx.reason).toUpperCase(),
                  time: safeTime
              };
          });

      const grouped = new Map<string, ReservedLedgerGroup>();
      rows.forEach((row) => {
          const groupKey = row.reference.toLowerCase();
          if (!grouped.has(groupKey)) {
              grouped.set(groupKey, {
                  key: groupKey,
                  reference: row.reference,
                  items: [],
                  totalQty: 0,
                  totalValue: 0,
                  latestTime: row.time
              });
          }
          const group = grouped.get(groupKey)!;
          group.items.push(row);
          group.totalQty += row.quantity;
          group.totalValue += row.value;
          if (row.time > group.latestTime) group.latestTime = row.time;
      });

      return Array.from(grouped.values())
          .map((group) => ({
              ...group,
              items: [...group.items].sort((a, b) => b.time - a.time)
          }))
          .sort((a, b) => b.latestTime - a.latestTime);
  }, [filteredTransactionsForOverview, filteredRawComponentLotsForOverview, filteredProductBatchesForOverview, inventory, products]);

  const reservedSummary = useMemo(() => {
      const totalValue = reservedGroups.reduce((sum, group) => sum + group.totalValue, 0);
      const totalQty = reservedGroups.reduce((sum, group) => sum + group.totalQty, 0);
      const groupCount = reservedGroups.length;
      const itemCount = reservedGroups.reduce((sum, group) => sum + group.items.length, 0);
      return { totalValue, totalQty, groupCount, itemCount };
  }, [reservedGroups]);

  const filteredReservedGroups = useMemo(() => {
      return reservedGroups
          .map((group) => ({
              ...group,
              items: group.items.filter((row) =>
                  matchesSearch(
                      [
                          group.reference,
                          row.reference,
                          row.itemName,
                          row.itemId,
                          row.batchNumber,
                          row.reason,
                          row.category,
                          row.unit
                      ],
                      appliedOverviewSearchQuery
                  )
              )
          }))
          .filter((group) => group.items.length > 0)
          .map((group) => ({
              ...group,
              totalQty: group.items.reduce((sum, row) => sum + row.quantity, 0),
              totalValue: group.items.reduce((sum, row) => sum + row.value, 0),
              latestTime: group.items.reduce((latest, row) => Math.max(latest, row.time), 0)
          }));
  }, [reservedGroups, appliedOverviewSearchQuery]);

  const filteredReservedSummary = useMemo(() => {
      const groupCount = filteredReservedGroups.length;
      const itemCount = filteredReservedGroups.reduce((sum, group) => sum + group.items.length, 0);
      return { groupCount, itemCount };
  }, [filteredReservedGroups]);

  const onHoldGroups = useMemo<OnHoldGroup[]>(() => {
      const componentById = new Map(
          inventory.map((item) => [normalizeText(item.component_id).toLowerCase(), item])
      );
      const productBySku = new Map(
          products.map((prod) => [normalizeText(prod.sku_id).toLowerCase(), prod])
      );

      const componentRows: OnHoldRow[] = filteredRawComponentLotsForOverview
          .filter((lot) => isOnHoldStatus(lot.qcStatus))
          .map((lot) => {
              const itemId = normalizeText(lot.itemId);
              const matchedItem = componentById.get(itemId.toLowerCase());
              const quantity = Number((lot as any).qty_remaining ?? lot.received_qty) || 0;
              const unitCost = Number(lot.unit_price) || 0;
              return {
                  id: normalizeText(lot.qc_number) || `${itemId}-${quantity}-${unitCost}`,
                  groupKey: 'raw_component_lot',
                  groupLabel: 'Raw Component Lots',
                  itemId,
                  itemName: matchedItem ? formatRawComponentListLabel(matchedItem, categories) : (itemId || 'Unknown Component'),
                  category: 'COMPONENT',
                  batchNumber: normalizeText(lot.qc_number) || '—',
                  quantity,
                  unit: normalizeText(lot.unit) || 'unit',
                  unitCost,
                  value: quantity * unitCost,
                  status: 'ON_HOLD'
              };
          });

      const productRows: OnHoldRow[] = filteredProductBatchesForOverview
          .filter((batch) => isOnHoldStatus((batch as any).status))
          .map((batch) => {
              const skuId = normalizeText(batch.sku_id);
              const matchedProduct = productBySku.get(skuId.toLowerCase());
              const quantity = Number(
                  (batch as any).qty_remaining ?? (batch as any).actualYield ?? (batch as any).plannedQuantity ?? 0
              ) || 0;
              const unitCost = Number((batch as any).unit_cost ?? (batch as any).unitProductionCost ?? 0) || 0;
              return {
                  id: normalizeText(batch.batch_number) || normalizeText(batch.id) || `${skuId}-${quantity}-${unitCost}`,
                  groupKey: 'batches_master',
                  groupLabel: 'Product Batches',
                  itemId: skuId,
                  itemName: matchedProduct ? formatFinishedProductInventoryLabel(matchedProduct) : skuId || 'Unknown Product',
                  category: 'PRODUCT',
                  batchNumber: normalizeText(batch.batch_number) || normalizeText(batch.id) || '—',
                  quantity,
                  unit: normalizeText(matchedProduct?.default_unit) || 'kg',
                  unitCost,
                  value: quantity * unitCost,
                  status: 'ON_HOLD'
              };
          });

      const allRows = [...componentRows, ...productRows];
      const grouped = new Map<'raw_component_lot' | 'batches_master', OnHoldGroup>();

      allRows.forEach((row) => {
          if (!grouped.has(row.groupKey)) {
              grouped.set(row.groupKey, {
                  key: row.groupKey,
                  label: row.groupLabel,
                  items: [],
                  totalQty: 0,
                  totalValue: 0
              });
          }
          const group = grouped.get(row.groupKey)!;
          group.items.push(row);
          group.totalQty += row.quantity;
          group.totalValue += row.value;
      });

      const orderedKeys: Array<'raw_component_lot' | 'batches_master'> = ['raw_component_lot', 'batches_master'];
      return orderedKeys
          .map((key) => grouped.get(key))
          .filter((group): group is OnHoldGroup => Boolean(group))
          .map((group) => ({
              ...group,
              items: [...group.items].sort((a, b) => {
                  const byItem = a.itemName.localeCompare(b.itemName);
                  if (byItem !== 0) return byItem;
                  return a.batchNumber.localeCompare(b.batchNumber);
              })
          }));
  }, [filteredRawComponentLotsForOverview, filteredProductBatchesForOverview, inventory, products]);

  const onHoldSummary = useMemo(() => {
      const totalValue = onHoldGroups.reduce((sum, group) => sum + group.totalValue, 0);
      const totalQty = onHoldGroups.reduce((sum, group) => sum + group.totalQty, 0);
      const groupCount = onHoldGroups.length;
      const itemCount = onHoldGroups.reduce((sum, group) => sum + group.items.length, 0);
      return { totalValue, totalQty, groupCount, itemCount };
  }, [onHoldGroups]);

  const filteredOnHoldGroups = useMemo(() => {
      return onHoldGroups
          .map((group) => ({
              ...group,
              items: group.items.filter((row) =>
                  matchesSearch(
                      [
                          group.label,
                          row.itemName,
                          row.itemId,
                          row.batchNumber,
                          row.status,
                          row.category,
                          row.unit
                      ],
                      appliedOverviewSearchQuery
                  )
              )
          }))
          .filter((group) => group.items.length > 0)
          .map((group) => ({
              ...group,
              totalQty: group.items.reduce((sum, row) => sum + row.quantity, 0),
              totalValue: group.items.reduce((sum, row) => sum + row.value, 0)
          }));
  }, [onHoldGroups, appliedOverviewSearchQuery]);

  const filteredOnHoldSummary = useMemo(() => {
      const groupCount = filteredOnHoldGroups.length;
      const itemCount = filteredOnHoldGroups.reduce((sum, group) => sum + group.items.length, 0);
      return { groupCount, itemCount };
  }, [filteredOnHoldGroups]);

  const applyOverviewFilters = () => {
      setAppliedOverviewToDate(draftOverviewToDate);
      setAppliedOverviewSearchQuery(draftOverviewSearchQuery.trim());
  };

  const resetOverviewFilters = () => {
      setDraftOverviewToDate(todayDate);
      setAppliedOverviewToDate(todayDate);
      setDraftOverviewSearchQuery('');
      setAppliedOverviewSearchQuery('');
  };

  const rejectedRawRows = useMemo(() => {
      const itemById = new Map(
          inventory.map(item => [normalizeText(item.component_id).toLowerCase(), item])
      );
      return rawComponentLots
          .filter(lot => isRejectedStatus(lot.qcStatus))
          .map(lot => {
              const qty = Number(lot.received_qty) || 0;
              const unitPrice = Number(lot.unit_price) || 0;
              const matchedItem = itemById.get(normalizeText(lot.itemId).toLowerCase());
              const componentName = matchedItem ? formatRawComponentListLabel(matchedItem, categories) : (lot.itemId || 'Unknown Component');
              const notes = normalizeText((lot as any).qcNotes || (lot as any).notes || (lot as any).rejectionReason);
              return {
                  id: normalizeText(lot.qc_number) || `${normalizeText(lot.itemId)}-${qty}-${unitPrice}`,
                  qcNumber: normalizeText(lot.qc_number) || '—',
                  componentName,
                  quantity: qty,
                  unit: normalizeText(lot.unit) || 'unit',
                  unitPrice,
                  totalValue: qty * unitPrice,
                  notes: notes || '—'
              };
          })
          .sort((a, b) => a.qcNumber.localeCompare(b.qcNumber));
  }, [rawComponentLots, inventory]);

  const rejectedProductRows = useMemo(() => {
      const productBySku = new Map(
          products.map(prod => [normalizeText(prod.sku_id).toLowerCase(), prod])
      );
      return productBatches
          .filter(batch => isRejectedStatus((batch as any).status) && normalizeQcDisposition((batch as any).qcDisposition) === 'final_rejected')
          .map(batch => {
              const quantity = Number(
                  (batch as any).actualYield ?? (batch as any).plannedQuantity ?? (batch as any).qty_remaining ?? 0
              ) || 0;
              const unitCost = Number((batch as any).unit_cost ?? (batch as any).unitProductionCost ?? 0) || 0;
              const matchedProduct = productBySku.get(normalizeText(batch.sku_id).toLowerCase());
              const notes = normalizeText((batch as any).notes || (batch as any).rejectionReason || (batch as any).qcNotes);
              return {
                  id: normalizeText(batch.batch_number) || normalizeText(batch.id),
                  batch,
                  batchNumber: normalizeText(batch.batch_number) || '—',
                  productName: matchedProduct ? formatFinishedProductInventoryLabel(matchedProduct) : batch.sku_id || 'Unknown Product',
                  quantity,
                  unit: normalizeText(matchedProduct?.default_unit) || 'kg',
                  unitProductionCost: unitCost,
                  totalValue: quantity * unitCost,
                  notes: notes || '—'
              };
          })
          .sort((a, b) => a.batchNumber.localeCompare(b.batchNumber));
  }, [productBatches, products]);

  const rejectedSummary = useMemo(() => {
      const rows = viewType === 'COMPONENT' ? rejectedRawRows : rejectedProductRows;
      const totalValue = rows.reduce((sum, row) => sum + row.totalValue, 0);
      return { totalValue, count: rows.length };
  }, [viewType, rejectedRawRows, rejectedProductRows]);

  const returnRejectedProductToProductIn = async (batch: ProductBatch) => {
      if (!onUpdateBatch) return;
      const batchId = normalizeText((batch as any).batch_id || batch.id);
      const matchedProduct = products.find(prod => normalizeText(prod.sku_id).toLowerCase() === normalizeText(batch.sku_id).toLowerCase());
      await onUpdateBatch({
          id: batchId,
          batch_id: batchId,
          batch_number: batch.batch_number,
          batchType: (batch as any).batchType,
          parentBulkBatchId: (batch as any).parentBulkBatchId,
          productSku: batch.sku_id,
          productName: matchedProduct ? formatFinishedProductInventoryLabel(matchedProduct) : batch.sku_id,
          plannedQuantity: Number((batch as any).plannedQuantity ?? batch.qty_remaining ?? 0) || 0,
          actualYield: Number((batch as any).actualYield ?? batch.qty_remaining ?? 0) || 0,
          status: 'On hold',
          location: batch.location,
          unitProductionCost: Number((batch as any).unit_cost ?? 0) || 0,
          qcNotes: normalizeText((batch as any).qcNotes),
          qcDisposition: 'standard',
      });
  };

  // --- HIERARCHICAL DATA PREP ---

  // 1. Calculate Batches per Item based on current location filter
  const itemBatchDetails = useMemo(() => {
      const result: Record<string, { batch: string, qty: number; unitPrice: number }[]> = {};
      Object.entries(ledgerStockLevels).forEach(([itemId, position]) => {
          const batchRows = Object.entries(position.byBatch).map(([batch, qtyState]) => {
              const qty = dashLocation === 'ALL'
                ? Number(qtyState.onHand || 0)
                : Number(position.byBatchLocation?.[batch]?.[dashLocation]?.onHand || 0);
              const unitPrice = itemBatchUnitPrices[itemId]?.[batch] || 0;
              return { batch, qty, unitPrice };
          }).filter(row => Math.abs(row.qty) > 0.001)
            .sort((a, b) => b.qty - a.qty);

          if (batchRows.length > 0) result[itemId] = batchRows;
      });

      return result;
  }, [dashLocation, ledgerStockLevels, itemBatchUnitPrices]);

  const reservedQtyByComponentBatch = useMemo<Record<string, Record<string, number>>>(() => {
      const reservedReasons = new Set(['RESERVATION', 'DISPATCH_STAGED']);
      const result: Record<string, Record<string, number>> = {};

      filteredTransactionsForOverview.forEach((tx) => {
          if (
              tx.type !== 'OUT' ||
              tx.category !== 'COMPONENT' ||
              !reservedReasons.has(normalizeText(tx.reason).toUpperCase())
          ) {
              return;
          }

          const itemId = normalizeText(tx.itemId);
          if (!itemId) return;

          const batch = normalizeText(tx.batchNumber) || UNBATCHED_KEY;
          const quantity = Number(tx.quantity) || 0;
          if (Math.abs(quantity) < 0.000001) return;

          if (!result[itemId]) result[itemId] = {};
          result[itemId][batch] = (result[itemId][batch] || 0) + quantity;
      });

      return result;
  }, [filteredTransactionsForOverview]);

  const reservedQtyByProductBatch = useMemo<Record<string, Record<string, number>>>(() => {
      const reservedReasons = new Set(['RESERVATION', 'DISPATCH_STAGED']);
      const result: Record<string, Record<string, number>> = {};

      filteredTransactionsForOverview.forEach((tx) => {
          if (
              tx.type !== 'OUT' ||
              tx.category !== 'PRODUCT' ||
              !reservedReasons.has(normalizeText(tx.reason).toUpperCase())
          ) {
              return;
          }

          const itemId = normalizeText(tx.itemId);
          if (!itemId) return;

          const batch = normalizeText(tx.batchNumber) || UNBATCHED_KEY;
          const quantity = Number(tx.quantity) || 0;
          if (Math.abs(quantity) < 0.000001) return;

          if (!result[itemId]) result[itemId] = {};
          result[itemId][batch] = (result[itemId][batch] || 0) + quantity;
      });

      return result;
  }, [filteredTransactionsForOverview]);

  const onHoldQtyByComponentBatch = useMemo<Record<string, Record<string, number>>>(() => {
      const result: Record<string, Record<string, number>> = {};

      filteredRawComponentLotsForOverview
          .filter((lot) => isOnHoldStatus(lot.qcStatus))
          .forEach((lot) => {
              const itemId = normalizeText(lot.itemId);
              if (!itemId) return;

              const batchNumber = normalizeText(lot.qc_number) || UNBATCHED_KEY;
              const quantity = Number((lot as any).qty_remaining ?? lot.received_qty) || 0;
              if (Math.abs(quantity) < 0.000001) return;

              if (!result[itemId]) result[itemId] = {};
              result[itemId][batchNumber] = (result[itemId][batchNumber] || 0) + quantity;
          });

      return result;
  }, [filteredRawComponentLotsForOverview]);

  const onHoldQtyByProductBatch = useMemo<Record<string, Record<string, number>>>(() => {
      const result: Record<string, Record<string, number>> = {};

      filteredProductBatchesForOverview
          .filter((batch) => isOnHoldStatus((batch as any).status))
          .forEach((batch) => {
              const skuId = normalizeText(batch.sku_id);
              if (!skuId) return;

              const batchNumber = normalizeText(batch.batch_number) || normalizeText(batch.id) || UNBATCHED_KEY;
              const quantity = Number(
                  (batch as any).qty_remaining ?? (batch as any).actualYield ?? (batch as any).plannedQuantity ?? 0
              ) || 0;
              if (Math.abs(quantity) < 0.000001) return;

              if (!result[skuId]) result[skuId] = {};
              result[skuId][batchNumber] = (result[skuId][batchNumber] || 0) + quantity;
          });

      return result;
  }, [filteredProductBatchesForOverview]);

  const mergeBatchQtyMaps = (...maps: Array<Record<string, number> | undefined>): Record<string, number> => {
      const merged: Record<string, number> = {};
      maps.forEach((map) => {
          Object.entries(map || {}).forEach(([batchKey, qty]) => {
              merged[batchKey] = Number(merged[batchKey] || 0) + Number(qty || 0);
          });
      });
      return merged;
  };

  const mergeBatchQtyMapsForItems = (
      ...maps: Array<Record<string, Record<string, number>>>
  ): Record<string, Record<string, number>> => {
      const merged: Record<string, Record<string, number>> = {};
      maps.forEach((map) => {
          Object.entries(map).forEach(([itemId, byBatch]) => {
              if (!merged[itemId]) merged[itemId] = {};
              Object.entries(byBatch).forEach(([batchKey, qty]) => {
                  merged[itemId][batchKey] = Number(merged[itemId][batchKey] || 0) + Number(qty || 0);
              });
          });
      });
      return merged;
  };

  const getInventoryCheckHoldMap = (itemId: string): Record<string, number> => {
      if (viewType === 'COMPONENT') {
          return mergeBatchQtyMaps(reservedQtyByComponentBatch[itemId], onHoldQtyByComponentBatch[itemId]);
      }
      return mergeBatchQtyMaps(reservedQtyByProductBatch[itemId], onHoldQtyByProductBatch[itemId]);
  };

  const getInventoryCheckHoldQty = (itemId: string, batch?: string): number => {
      const batchMap = getInventoryCheckHoldMap(itemId);
      if (!batchMap) return 0;
      if (batch) return Number(batchMap[batch] || 0);
      return Object.values(batchMap).reduce((sum, qty) => sum + Number(qty || 0), 0);
  };

  // 2. Group items by Category
  const groupedItems = useMemo(() => {
      const groups: Record<string, typeof combinedDashData> = {};
      
      filteredDashData.forEach(item => {
          const cat = item.type || 'OTHER';
          if (!groups[cat]) groups[cat] = [];
          groups[cat].push(item);
      });

      // Sort within categories
      Object.keys(groups).forEach(cat => {
          groups[cat].sort((a, b) => {
              const valA = a[dashLocation];
              const valB = b[dashLocation];
              
              if (sortKey === 'qty') return valB.qty - valA.qty;
              if (sortKey === 'value') return valB.value - valA.value;
              return a.name.localeCompare(b.name);
          });
      });
      
      return groups;
  }, [filteredDashData, dashLocation, sortKey]);

  const orderedLedgerCategories = useMemo(() => {
      const categories = Object.keys(groupedItems);
      if (viewType !== 'PRODUCT') return categories.sort();
      return categories.sort((a, b) => {
          const aIndex = PRODUCT_CATEGORY_ORDER_INDEX.get(a);
          const bIndex = PRODUCT_CATEGORY_ORDER_INDEX.get(b);
          if (aIndex !== undefined && bIndex !== undefined) return aIndex - bIndex;
          if (aIndex !== undefined) return -1;
          if (bIndex !== undefined) return 1;
          return a.localeCompare(b);
      });
  }, [groupedItems, viewType]);

  const orderedLedgerItems = useMemo(
      () => orderedLedgerCategories.flatMap((cat) => groupedItems[cat] || []),
      [orderedLedgerCategories, groupedItems]
  );

  // Handlers
  const toggleCategory = (cat: string) => {
      setExpandedCategories(prev => ({ ...prev, [cat]: !prev[cat] }));
  };

  const toggleItem = (itemId: string) => {
      setExpandedItems(prev => ({ ...prev, [itemId]: !prev[itemId] }));
  };

  const toggleReservedGroup = (groupKey: string) => {
      setExpandedReservedGroups((prev) => ({ ...prev, [groupKey]: !prev[groupKey] }));
  };

  const toggleOnHoldGroup = (groupKey: string) => {
      setExpandedOnHoldGroups((prev) => ({ ...prev, [groupKey]: !prev[groupKey] }));
  };

  const downloadRowsAsCsv = (filename: string, headers: string[], rows: Array<Array<string | number>>) => {
      const csvString = [
          headers.join(','),
          ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      ].join('\n');

      const blob = new Blob(["\uFEFF" + csvString], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.setAttribute("href", url);
      link.setAttribute("download", filename);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
  };

  const downloadCSV = () => {
      const timestamp = new Date().toISOString().slice(0, 10);
      const downloadDate = timestamp;
      const dataThroughDate = appliedOverviewToDate || timestamp;
      const theme = viewType === 'COMPONENT' ? 'raw_components' : 'products';
      const locationTag = dashLocation === 'ALL' ? 'consolidated' : dashLocation.toLowerCase();
      const filename = `${timestamp}_${locationTag}_${theme}.csv`;

      const headers = [
          "Date Downloaded", 
          "Data Through Date",
          "Location",
          "Category", 
          "Item ID", 
          "Item Name", 
          "Quantity (Total)", 
          "Unit", 
          "Avg Unit Price", 
          "Total Value"
      ];
      
      const rows = orderedLedgerItems.map(item => {
          const loc = item[dashLocation];
          const avgUnitPrice = Math.abs(loc.qty) > 0.000001 ? (loc.value / loc.qty) : 0;
          return [
          downloadDate,
          dataThroughDate,
          dashLocation === 'ALL' ? 'Consolidated' : dashLocation,
          item.type || 'Uncategorized',
          item.id,
          item.name,
          loc.qty,
          item.unit,
          avgUnitPrice,
          loc.value
      ];
      });
      downloadRowsAsCsv(filename, headers, rows);
  };

  const downloadInventoryCheckCSV = () => {
      const now = new Date();
      const downloadDate = now.toISOString().slice(0, 10);
      const dataThroughDate = appliedOverviewToDate || downloadDate;
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      const filename = viewType === 'COMPONENT'
          ? `${yyyy}${mm}${dd} raw components inventory check.csv`
          : `${yyyy}${mm}${dd} finished products inventory check.csv`;

      const headers = [
          'Date Downloaded',
          'Data Through Date',
          'Category',
          'Item / Product Name',
          'QC Number / Batch Number',
          'Riverside Quantity',
          'Hilltop Quantity',
          'Total Quantity',
          'Reserved/Onhold',
          'Summary Quantity'
      ];

      const categoryLabel = viewType === 'COMPONENT' ? 'Raw Component' : 'Finished Product';
      const exportedItemIds = new Set(orderedLedgerItems.map((item) => item.id));
      const heldQtyByItemBatch = viewType === 'COMPONENT'
          ? mergeBatchQtyMapsForItems(reservedQtyByComponentBatch, onHoldQtyByComponentBatch)
          : mergeBatchQtyMapsForItems(reservedQtyByProductBatch, onHoldQtyByProductBatch);
      const extraHeldItems = Object.keys(heldQtyByItemBatch)
          .filter((itemId) => !exportedItemIds.has(itemId))
          .map((itemId) => {
              if (viewType === 'COMPONENT') {
                  const matchedItem = inventory.find((item) => item.component_id === itemId);
                  return {
                      id: itemId,
                      name: matchedItem ? formatRawComponentInventoryLabel(matchedItem, categories) : itemId,
                      unit: matchedItem?.default_unit || 'unit',
                      type: matchedItem?.type || 'Uncategorized',
                      kind: 'COMPONENT',
                      Riverside: { qty: 0, value: 0 },
                      Hilltop: { qty: 0, value: 0 },
                      ALL: { qty: 0, value: 0 }
                  };
              }

              const matchedProduct = products.find((product) => product.sku_id === itemId);
              return {
                  id: itemId,
                  name: matchedProduct ? formatFinishedProductInventoryLabel(matchedProduct) : itemId,
                  unit: matchedProduct?.default_unit || 'unit',
                  type: matchedProduct ? resolveProductCategoryGroup(matchedProduct) : 'Finished Good',
                  kind: 'PRODUCT',
                  Riverside: { qty: 0, value: 0 },
                  Hilltop: { qty: 0, value: 0 },
                  ALL: { qty: 0, value: 0 }
              };
          })
          .filter((item) =>
              matchesSearch(
                  [
                      item.name,
                      item.id,
                      item.type,
                      item.unit,
                      ...Object.keys(heldQtyByItemBatch[item.id] || {})
                  ],
                  appliedOverviewSearchQuery
              )
          );
      const inventoryCheckItems = [...orderedLedgerItems, ...extraHeldItems];

      const rows = inventoryCheckItems.flatMap(item => {
          const ngSummaryQty = Number(item?.Riverside?.qty || 0);
          const mgSummaryQty = Number(item?.Hilltop?.qty || 0);
          const totalSummaryQty = Number(item?.ALL?.qty || 0);
          const position = ledgerStockLevels[item.id];
          const batchRows = itemBatchDetails[item.id] || [];
          const holdOnlyBatches = Object.keys(getInventoryCheckHoldMap(item.id)).filter(
              (batch) => !batchRows.some((row) => row.batch === batch)
          );

          if (batchRows.length === 0 && holdOnlyBatches.length === 0) {
              const holdQty = getInventoryCheckHoldQty(item.id);
              return [[
                  downloadDate,
                  dataThroughDate,
                  categoryLabel,
                  item.name,
                  '',
                  formatInventoryCheckQuantity(ngSummaryQty),
                  formatInventoryCheckQuantity(mgSummaryQty),
                  formatInventoryCheckQuantity(totalSummaryQty),
                  formatInventoryCheckQuantity(holdQty),
                  formatInventoryCheckQuantity(totalSummaryQty + holdQty)
              ]];
          }

          const ledgerRows = batchRows.map(row => {
              const totalQty = Number(position?.byBatch?.[row.batch]?.onHand || 0);
              const holdQty = getInventoryCheckHoldQty(item.id, row.batch);
              return [
              downloadDate,
              dataThroughDate,
              categoryLabel,
              item.name,
              row.batch,
              formatInventoryCheckQuantity(Number(position?.byBatchLocation?.[row.batch]?.Riverside?.onHand || 0)),
              formatInventoryCheckQuantity(Number(position?.byBatchLocation?.[row.batch]?.Hilltop?.onHand || 0)),
              formatInventoryCheckQuantity(totalQty),
              formatInventoryCheckQuantity(holdQty),
              formatInventoryCheckQuantity(totalQty + holdQty)
          ];
          });

          const holdOnlyRows = holdOnlyBatches.map((batch) => {
              const holdQty = getInventoryCheckHoldQty(item.id, batch);
              return [
                  downloadDate,
                  dataThroughDate,
                  categoryLabel,
                  item.name,
                  batch,
                  '0',
                  '0',
                  '0',
                  formatInventoryCheckQuantity(holdQty),
                  formatInventoryCheckQuantity(holdQty)
              ];
          });

          return [...ledgerRows, ...holdOnlyRows];
      });

      downloadRowsAsCsv(filename, headers, rows);
  };

  const downloadReservedCSV = () => {
      const dateToken = new Date().toISOString().slice(0, 10);
      const downloadDate = dateToken;
      const dataThroughDate = appliedOverviewToDate || dateToken;
      const filename = `${dateToken} Reserved.csv`;
      const headers = [
          'Date Downloaded',
          'Data Through Date',
          'Reference',
          'Item ID',
          'Item Name',
          'Type',
          'Batch/QC',
          'Quantity',
          'Unit',
          'Unit Price/Cost',
          'Value',
          'Reason'
      ];
      const rows = filteredReservedGroups.flatMap((group) =>
          group.items.map((row) => [
              downloadDate,
              dataThroughDate,
              group.reference,
              row.itemId,
              row.itemName,
              row.category,
              row.batchNumber,
              row.quantity,
              row.unit,
              row.unitCost,
              row.value,
              row.reason
          ])
      );
      downloadRowsAsCsv(filename, headers, rows);
  };

  const downloadOnHoldCSV = () => {
      const dateToken = new Date().toISOString().slice(0, 10);
      const downloadDate = dateToken;
      const dataThroughDate = appliedOverviewToDate || dateToken;
      const filename = `${dateToken} On hold.csv`;
      const headers = [
          'Date Downloaded',
          'Data Through Date',
          'Source',
          'Item ID',
          'Item Name',
          'Type',
          'Batch/QC',
          'Quantity',
          'Unit',
          'Unit Price/Cost',
          'Value',
          'Status'
      ];
      const rows = filteredOnHoldGroups.flatMap((group) =>
          group.items.map((row) => [
              downloadDate,
              dataThroughDate,
              group.label,
              row.itemId,
              row.itemName,
              row.category,
              row.batchNumber,
              row.quantity,
              row.unit,
              row.unitCost,
              row.value,
              row.status
          ])
      );
      downloadRowsAsCsv(filename, headers, rows);
  };

  const formatPrice = (price: number) => {
    if (!Number.isFinite(price) || Math.abs(price) < 0.000001) return '—';
    return `£${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  return (
    <div className="space-y-6 animate-in fade-in">
        {/* View Switch */}
        <div className="mobile-tab-strip sticky top-0 z-10 flex border-b border-slate-200 bg-slate-100/95 backdrop-blur overflow-x-auto whitespace-nowrap">
            <button 
                onClick={() => setViewType('COMPONENT')}
                className={`inventory-subtab-button flex shrink-0 items-center px-4 py-3 text-sm font-medium border-b-2 transition-colors ${viewType === 'COMPONENT' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'}`}
            >
                <Package className="w-4 h-4 mr-2" /> Raw Components
            </button>
            <button 
                onClick={() => setViewType('PRODUCT')}
                className={`inventory-subtab-button flex shrink-0 items-center px-4 py-3 text-sm font-medium border-b-2 transition-colors ${viewType === 'PRODUCT' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'}`}
            >
                <Beaker className="w-4 h-4 mr-2" /> Finished Products
            </button>
        </div>

        {/* Header Cards */}
        <div className="mobile-card-carousel flex md:grid md:grid-cols-4 gap-3 md:gap-6 overflow-x-auto md:overflow-visible pb-1 md:pb-0">
            {/* Riverside Card */}
            <div 
                onClick={() => setDashLocation('Riverside')}
                className={`cursor-pointer shrink-0 snap-start p-4 md:p-6 rounded-xl border transition-all duration-200 shadow-sm min-w-[180px] md:min-w-0 ${
                    dashLocation === 'Riverside' 
                    ? 'bg-indigo-50 border-indigo-200 ring-2 ring-indigo-500/20' 
                    : 'bg-white border-slate-200 hover:border-indigo-300'
                }`}
            >
                <div className="flex justify-between items-start mb-2">
                    <div className="text-xs font-bold text-slate-500 uppercase tracking-wider">Riverside</div>
                    <MapPin className={`w-4 h-4 ${dashLocation === 'Riverside' ? 'text-indigo-600' : 'text-slate-300'}`} />
                </div>
                <div className="text-2xl font-bold text-slate-800">£{(summary.Riverside || 0).toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0})}</div>
                <div className="text-xs text-slate-400 mt-1">Total Valuation</div>
            </div>

            {/* Hilltop Card */}
            <div 
                onClick={() => setDashLocation('Hilltop')}
                className={`cursor-pointer shrink-0 snap-start p-4 md:p-6 rounded-xl border transition-all duration-200 shadow-sm min-w-[180px] md:min-w-0 ${
                    dashLocation === 'Hilltop' 
                    ? 'bg-indigo-50 border-indigo-200 ring-2 ring-indigo-500/20' 
                    : 'bg-white border-slate-200 hover:border-indigo-300'
                }`}
            >
                <div className="flex justify-between items-start mb-2">
                    <div className="text-xs font-bold text-slate-500 uppercase tracking-wider">Hilltop</div>
                    <MapPin className={`w-4 h-4 ${dashLocation === 'Hilltop' ? 'text-indigo-600' : 'text-slate-300'}`} />
                </div>
                <div className="text-2xl font-bold text-slate-800">£{(summary.Hilltop || 0).toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0})}</div>
                <div className="text-xs text-slate-400 mt-1">Total Valuation</div>
            </div>

            {/* Total Card */}
            <div 
                onClick={() => setDashLocation('ALL')}
                className={`cursor-pointer shrink-0 snap-start p-4 md:p-6 rounded-xl border transition-all duration-200 shadow-sm min-w-[180px] md:min-w-0 ${
                    dashLocation === 'ALL' 
                    ? 'bg-green-50 border-green-200 ring-2 ring-green-500/20' 
                    : 'bg-white border-slate-200 hover:border-green-300'
                }`}
            >
                <div className="flex justify-between items-start mb-2">
                    <div className="text-xs font-bold text-slate-500 uppercase tracking-wider">Consolidated</div>
                    <Layers className={`w-4 h-4 ${dashLocation === 'ALL' ? 'text-green-600' : 'text-slate-300'}`} />
                </div>
                <div className="text-2xl font-bold text-slate-800">£{(summary.ALL || 0).toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0})}</div>
                <div className="text-xs text-slate-400 mt-1">Total Valuation</div>
            </div>

            {/* Rejected Card */}
            <div
                onClick={() => setExpandedRejected(prev => !prev)}
                className={`cursor-pointer shrink-0 snap-start p-4 md:p-6 rounded-xl border transition-all duration-200 shadow-sm min-w-[180px] md:min-w-0 ${
                    expandedRejected
                    ? 'bg-amber-50 border-amber-300 ring-2 ring-amber-500/20'
                    : 'bg-amber-50/40 border-amber-200 hover:border-amber-300'
                }`}
            >
                <div className="flex justify-between items-start mb-2">
                    <div className="text-xs font-bold text-amber-800 uppercase tracking-wider">Rejected</div>
                    <AlertTriangle className={`w-4 h-4 ${expandedRejected ? 'text-amber-700' : 'text-amber-400'}`} />
                </div>
                <div className="text-2xl font-bold text-amber-900">£{(rejectedSummary.totalValue || 0).toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0})}</div>
                <div className="text-xs text-amber-700/80 mt-1">
                    {rejectedSummary.count} {viewType === 'COMPONENT' ? 'rejected lots' : 'rejected batches'}
                </div>
            </div>
        </div>

        {expandedRejected && (
            <div className="bg-amber-50/50 border border-amber-200 rounded-xl shadow-sm overflow-hidden">
                <div className="px-6 py-4 border-b border-amber-200 flex items-center justify-between">
                    <h3 className="font-bold text-amber-900 text-sm uppercase tracking-wider">
                        {viewType === 'COMPONENT' ? 'Rejected Raw Components' : 'Rejected Finished Products'}
                    </h3>
                    <span className="text-xs font-medium text-amber-800 bg-amber-100 px-3 py-1 rounded-full">
                        Total: <strong>£{(rejectedSummary.totalValue || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
                    </span>
                </div>

                <div className="md:hidden divide-y divide-amber-100">
                    {viewType === 'COMPONENT' ? (
                        rejectedRawRows.length > 0 ? rejectedRawRows.map(row => (
                            <div key={row.id} className="p-4 bg-amber-50/40">
                                <div className="flex items-start justify-between gap-2">
                                    <div>
                                        <div className="text-[10px] uppercase font-bold text-amber-700">QC Number</div>
                                        <div className="font-mono text-xs text-amber-900 break-all">{row.qcNumber}</div>
                                    </div>
                                    <div className="text-right">
                                        <div className="text-[10px] uppercase font-bold text-amber-700">Value</div>
                                        <div className="font-semibold text-amber-900">£{row.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                                    </div>
                                </div>
                                <div className="mt-2 text-sm text-slate-700 break-words">{row.componentName}</div>
                                <div className="mt-2 text-xs text-slate-600">{row.quantity.toLocaleString()} {row.unit} at {formatPrice(row.unitPrice)}</div>
                                <div className="mt-2 text-xs text-slate-500 break-words">{row.notes}</div>
                            </div>
                        )) : (
                            <div className="px-6 py-8 text-center text-amber-800 italic">No rejected items</div>
                        )
                    ) : (
                        rejectedProductRows.length > 0 ? rejectedProductRows.map(row => (
                            <div key={row.id} className="p-4 bg-amber-50/40">
                                <div className="flex items-start justify-between gap-2">
                                    <div>
                                        <div className="text-[10px] uppercase font-bold text-amber-700">Batch Number</div>
                                        <div className="font-mono text-xs text-amber-900 break-all">{row.batchNumber}</div>
                                    </div>
                                    <div className="text-right">
                                        <div className="text-[10px] uppercase font-bold text-amber-700">Value</div>
                                        <div className="font-semibold text-amber-900">£{row.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                                    </div>
                                </div>
                                <div className="mt-2 text-sm text-slate-700 break-words">{row.productName}</div>
                                <div className="mt-2 text-xs text-slate-600">{row.quantity.toLocaleString()} {row.unit} at {formatPrice(row.unitProductionCost)}</div>
                                <div className="mt-2 text-xs text-slate-500 break-words">{row.notes}</div>
                                {onUpdateBatch && (
                                    <button
                                        type="button"
                                        onClick={() => void returnRejectedProductToProductIn(row.batch)}
                                        className="mt-3 inline-flex items-center rounded border border-amber-300 bg-white px-3 py-1.5 text-xs font-bold text-amber-800 hover:bg-amber-100"
                                    >
                                        <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Return to Product In
                                    </button>
                                )}
                            </div>
                        )) : (
                            <div className="px-6 py-8 text-center text-amber-800 italic">No rejected items</div>
                        )
                    )}
                </div>

                <div className="hidden md:block overflow-x-auto">
                    {viewType === 'COMPONENT' ? (
                        <table className="w-full text-sm text-left">
                            <thead className="bg-amber-100/60 text-amber-900 font-bold uppercase text-xs tracking-wider border-b border-amber-200">
                                <tr>
                                    <th className="px-6 py-3">QC Number</th>
                                    <th className="px-6 py-3">Component</th>
                                    <th className="px-6 py-3 text-right">Quantity</th>
                                    <th className="px-6 py-3 text-right">Unit Price</th>
                                    <th className="px-6 py-3 text-right">Total Value</th>
                                    <th className="px-6 py-3">Notes</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-amber-100">
                                {rejectedRawRows.length > 0 ? rejectedRawRows.map(row => (
                                    <tr key={row.id} className="hover:bg-amber-50/60">
                                        <td className="px-6 py-3 font-mono text-xs text-amber-900">{row.qcNumber}</td>
                                        <td className="px-6 py-3 text-slate-700">{row.componentName}</td>
                                        <td className="px-6 py-3 text-right font-medium text-slate-700">{row.quantity.toLocaleString()} {row.unit}</td>
                                        <td className="px-6 py-3 text-right text-slate-700">{formatPrice(row.unitPrice)}</td>
                                        <td className="px-6 py-3 text-right font-semibold text-amber-900">£{row.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                                        <td className="px-6 py-3 text-slate-600">{row.notes}</td>
                                    </tr>
                                )) : (
                                    <tr><td colSpan={6} className="px-6 py-8 text-center text-amber-800 italic">No rejected items</td></tr>
                                )}
                            </tbody>
                        </table>
                    ) : (
                        <table className="w-full text-sm text-left">
                            <thead className="bg-amber-100/60 text-amber-900 font-bold uppercase text-xs tracking-wider border-b border-amber-200">
                                <tr>
                                    <th className="px-6 py-3">Batch Number</th>
                                    <th className="px-6 py-3">Product</th>
                                    <th className="px-6 py-3 text-right">Quantity</th>
                                    <th className="px-6 py-3 text-right">Unit Production Cost</th>
                                    <th className="px-6 py-3 text-right">Total Value</th>
                                    <th className="px-6 py-3">Notes</th>
                                    <th className="px-6 py-3 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-amber-100">
                                {rejectedProductRows.length > 0 ? rejectedProductRows.map(row => (
                                    <tr key={row.id} className="hover:bg-amber-50/60">
                                        <td className="px-6 py-3 font-mono text-xs text-amber-900">{row.batchNumber}</td>
                                        <td className="px-6 py-3 text-slate-700">{row.productName}</td>
                                        <td className="px-6 py-3 text-right font-medium text-slate-700">{row.quantity.toLocaleString()} {row.unit}</td>
                                        <td className="px-6 py-3 text-right text-slate-700">{formatPrice(row.unitProductionCost)}</td>
                                        <td className="px-6 py-3 text-right font-semibold text-amber-900">£{row.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                                        <td className="px-6 py-3 text-slate-600">{row.notes}</td>
                                        <td className="px-6 py-3 text-right">
                                            {onUpdateBatch ? (
                                                <button
                                                    type="button"
                                                    onClick={() => void returnRejectedProductToProductIn(row.batch)}
                                                    className="inline-flex items-center rounded border border-amber-300 bg-white px-3 py-1.5 text-xs font-bold text-amber-800 hover:bg-amber-100"
                                                >
                                                    <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Return
                                                </button>
                                            ) : '—'}
                                        </td>
                                    </tr>
                                )) : (
                                    <tr><td colSpan={7} className="px-6 py-8 text-center text-amber-800 italic">No rejected items</td></tr>
                                )}
                            </tbody>
                        </table>
                    )}
                </div>
            </div>
        )}

        <div className="bg-white border border-slate-200 rounded-xl shadow-sm px-4 sm:px-6 py-4">
            <div className="flex flex-wrap items-end gap-2">
                <div className="w-full sm:w-[210px]">
                    <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">To</label>
                    <input
                        type="date"
                        value={draftOverviewToDate}
                        onChange={(event) => setDraftOverviewToDate(event.target.value)}
                        className={filterFieldClass}
                    />
                </div>
                <div className="w-full sm:min-w-[260px] sm:flex-1">
                    <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Global Search</label>
                    <input
                        type="text"
                        value={draftOverviewSearchQuery}
                        onChange={(event) => setDraftOverviewSearchQuery(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                                event.preventDefault();
                                applyOverviewFilters();
                            }
                        }}
                        placeholder="Item, batch/QC, reason..."
                        className={filterFieldClass}
                    />
                </div>
                <div className="ml-auto flex w-full sm:w-auto items-center justify-end gap-2">
                    <button
                        type="button"
                        onClick={applyOverviewFilters}
                        title="Confirm"
                        aria-label="Confirm overview filters"
                        className="inline-flex min-h-11 px-5 whitespace-nowrap items-center justify-center border border-indigo-300 rounded bg-indigo-600 text-white hover:bg-indigo-700 text-sm font-semibold"
                    >
                        <Check className="w-4 h-4 mr-1.5" />
                        Apply
                    </button>
                    <button
                        type="button"
                        onClick={resetOverviewFilters}
                        title="Reset filters"
                        aria-label="Clear overview filters and show all current data"
                        className="inline-flex w-11 min-h-11 items-center justify-center border border-slate-300 rounded bg-white text-slate-700 hover:bg-slate-50"
                    >
                        <RotateCcw className="w-4 h-4" />
                    </button>
                </div>
            </div>
        </div>

        {(showHistoricalLedgerSyncPrompt || showCurrentSummarySyncNote) && (
            <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                        {showHistoricalLedgerSyncPrompt
                            ? 'Historical inventory views need the local ledger to finish loading.'
                            : 'Inventory summary data is still loading.'}
                        {' '}Current values remain stable while the latest data loads.
                    </div>
                    {onForceSync && (
                        <button
                            type="button"
                            onClick={() => void onForceSync()}
                            className="inline-flex min-h-9 items-center justify-center rounded border border-amber-300 bg-white px-3 text-xs font-semibold text-amber-900 hover:bg-amber-100"
                        >
                            Refresh now
                        </button>
                    )}
                </div>
            </div>
        )}

        {/* Hierarchical Table Card */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <div className="px-4 sm:px-6 py-4 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-white">
                <div className="flex items-center">
                    {viewType === 'COMPONENT' ? <Package className="w-5 h-5 mr-2 text-indigo-600" /> : <Beaker className="w-5 h-5 mr-2 text-indigo-600" />}
                    <h3 className="font-bold text-slate-800 text-sm uppercase tracking-wider">Inventory Ledger</h3>
                </div>
                
                <div className="w-full sm:w-[430px] sm:ml-auto flex items-center justify-end gap-2 sm:gap-3 overflow-x-auto whitespace-nowrap">
                    <button 
                        onClick={downloadCSV}
                        className="h-9 w-9 flex shrink-0 items-center justify-center bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition text-slate-600 shadow-sm"
                        aria-label="Export inventory ledger CSV"
                        title="Export CSV"
                    >
                        <Download className="w-4 h-4" />
                    </button>
                    <span className="text-xs font-medium text-slate-500 bg-slate-100 px-3 py-2 rounded-full shrink-0">
                        Location: <strong className="text-slate-700">{dashLocation === 'ALL' ? 'All Sites' : dashLocation}</strong>
                    </span>
                </div>
            </div>

            <div className="md:hidden divide-y divide-slate-100">
                {orderedLedgerCategories.map(cat => {
                    const items = groupedItems[cat];
                    const isExpanded = !!expandedCategories[cat];
                    return (
                        <div key={cat} className="bg-white">
                            <button
                                type="button"
                                onClick={() => toggleCategory(cat)}
                                className="w-full px-4 py-3 flex items-center justify-between text-left bg-slate-50"
                            >
                                <span className="font-bold text-slate-700 uppercase tracking-wide text-xs">
                                    {cat.replace(/_/g, ' ')} <span className="text-slate-400 font-normal normal-case">({items.length})</span>
                                </span>
                                {isExpanded ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
                            </button>

                            {isExpanded && (
                                <div className="space-y-2 p-3">
                                    {items.map(item => {
                                        const locData = item[dashLocation];
                                        const itemBatches = itemBatchDetails[item.id] || [];
                                        const isItemExpanded = !!expandedItems[item.id];
                                        return (
                                            <div key={item.id} className="border border-slate-200 rounded-lg overflow-hidden">
                                                <button
                                                    type="button"
                                                    onClick={() => toggleItem(item.id)}
                                                    className="w-full p-3 text-left bg-white hover:bg-slate-50"
                                                >
                                                    <div className="flex items-start justify-between gap-2">
                                                        <div className="min-w-0">
                                                            <div className="font-semibold text-slate-900 break-words">{item.name}</div>
                                                            <div className="text-[10px] text-slate-400 font-mono break-all mt-0.5">{item.id}</div>
                                                        </div>
                                                        {isItemExpanded ? <ChevronDown className="w-4 h-4 text-indigo-400 shrink-0" /> : <ChevronRight className="w-4 h-4 text-slate-300 shrink-0" />}
                                                    </div>
                                                    <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                                                        <div>
                                                            <div className="text-slate-400">Qty</div>
                                                            <div className={`font-mono font-semibold ${locData.qty < 0 ? 'text-red-600' : 'text-slate-900'}`}>{locData.qty.toLocaleString()} {item.unit}</div>
                                                        </div>
                                                        <div>
                                                            <div className="text-slate-400">Unit Price</div>
                                                            <div className="font-semibold text-slate-900">{formatPrice(Math.abs(locData.qty) > 0.000001 ? (locData.value / locData.qty) : 0)}</div>
                                                        </div>
                                                        <div>
                                                            <div className="text-slate-400">Value</div>
                                                            <div className="font-semibold text-slate-900">£{(locData.value || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                                                        </div>
                                                    </div>
                                                </button>

                                                {isItemExpanded && (
                                                    <div className="border-t border-slate-200 bg-slate-50/70 p-3 space-y-2">
                                                        {itemBatches.length > 0 ? itemBatches.map(b => {
                                                            const batchValue = (b.qty || 0) * (b.unitPrice || 0);
                                                            return (
                                                                <div key={b.batch} className="rounded border border-slate-200 bg-white p-2">
                                                                    <div className="flex items-center justify-between gap-2">
                                                                        <span className="inline-flex items-center rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">{viewType === 'PRODUCT' ? 'BATCH' : 'QC'}</span>
                                                                        <span className="font-mono text-xs text-slate-600 break-all">{b.batch}</span>
                                                                    </div>
                                                                    <div className="mt-1 text-xs text-slate-600">
                                                                        {b.qty.toLocaleString()} {item.unit} at {formatPrice(b.unitPrice)} | £{batchValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                                                                    </div>
                                                                </div>
                                                            );
                                                        }) : (
                                                            <div className="text-xs text-slate-400 italic">No specific batch details available.</div>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    );
                })}
                {orderedLedgerCategories.length === 0 && (
                    <div className="py-12 text-center text-slate-400 italic">No inventory recorded in ledger.</div>
                )}
            </div>

            <div className="hidden md:block overflow-x-auto">
                <table className="w-full min-w-[980px] text-sm text-left table-fixed">
                    <colgroup>
                        <col className="w-[56%]" />
                        <col className="w-[14%]" />
                        <col className="w-[15%]" />
                        <col className="w-[15%]" />
                    </colgroup>
                    <thead className="bg-slate-50 text-slate-500 font-bold uppercase text-xs tracking-wider border-b border-slate-200">
                        <tr>
                            <th className="px-6 py-3 cursor-pointer hover:bg-slate-100" onClick={() => setSortKey('name')}>
                                <div className="flex items-center">Category / Item <ArrowUpDown className="w-3 h-3 ml-1 opacity-50" /></div>
                            </th>
                            <th className="px-6 py-3 text-right cursor-pointer hover:bg-slate-100" onClick={() => setSortKey('qty')}>
                                <div className="flex items-center justify-end">Quantity <ArrowUpDown className="w-3 h-3 ml-1 opacity-50" /></div>
                            </th>
                            <th className="px-6 py-3 text-right">
                                <div className="flex items-center justify-end">Unit Price</div>
                            </th>
                            <th className="px-6 py-3 text-right cursor-pointer hover:bg-slate-100" onClick={() => setSortKey('value')}>
                                <div className="flex items-center justify-end">Value <ArrowUpDown className="w-3 h-3 ml-1 opacity-50" /></div>
                            </th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {orderedLedgerCategories.map(cat => {
                            const items = groupedItems[cat];
                            const isExpanded = !!expandedCategories[cat];
                            
                            // Category Summary Stats
                            const catQty = items.reduce((s, i) => s + i[dashLocation].qty, 0);
                            const catVal = items.reduce((s, i) => s + i[dashLocation].value, 0);
                            const catUnitPrice = Math.abs(catQty) > 0.000001 ? (catVal / catQty) : 0;

                            return (
                                <React.Fragment key={cat}>
                                    {/* Level 1: Category Header */}
                                    <tr 
                                        onClick={() => toggleCategory(cat)}
                                        className="bg-slate-50 hover:bg-slate-100 cursor-pointer transition-colors border-l-4 border-l-transparent hover:border-l-indigo-500"
                                    >
                                        <td className="px-6 py-3 font-bold text-slate-700 flex items-center uppercase tracking-wide text-xs">
                                            {isExpanded ? <ChevronDown className="w-4 h-4 mr-2 text-slate-400" /> : <ChevronRight className="w-4 h-4 mr-2 text-slate-400" />}
                                            {cat.replace(/_/g, ' ')} <span className="ml-2 text-slate-400 font-normal normal-case">({items.length} items)</span>
                                        </td>
                                        <td className="px-6 py-3 text-right text-slate-500 font-mono text-xs">
                                            —
                                        </td>
                                        <td className="px-6 py-3 text-right text-slate-600 font-medium text-xs">
                                            {formatPrice(catUnitPrice)}
                                        </td>
                                        <td className="px-6 py-3 text-right font-bold text-slate-700 text-xs">
                                            £{catVal.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0})}
                                        </td>
                                    </tr>

                                    {/* Level 2: Items */}
                                    {isExpanded && items.map(item => {
                                        const locData = item[dashLocation];
                                        const itemBatches = itemBatchDetails[item.id] || [];
                                        const isItemExpanded = !!expandedItems[item.id];

                                        return (
                                            <React.Fragment key={item.id}>
                                                <tr 
                                                    onClick={() => toggleItem(item.id)}
                                                    className={`cursor-pointer transition-colors border-b border-slate-100 ${isItemExpanded ? 'bg-white' : 'hover:bg-slate-50'}`}
                                                >
                                                    <td className="px-6 py-3 pl-12 relative">
                                                        <div className="flex items-start">
                                                            {isItemExpanded ? <ChevronDown className="w-3 h-3 mr-2 text-indigo-400 mt-1" /> : <ChevronRight className="w-3 h-3 mr-2 text-slate-300 mt-1" />}
                                                            <div className="min-w-0">
                                                                <div className="font-semibold text-slate-900 break-words">{item.name}</div>
                                                                <div className="text-[10px] text-slate-400 font-mono break-all">{item.id}</div>
                                                            </div>
                                                        </div>
                                                    </td>
                                                    <td className={`px-6 py-3 text-right font-mono font-semibold ${locData.qty < 0 ? 'text-red-600' : 'text-slate-900'}`}>
                                                        {locData.qty.toLocaleString()} <span className="text-xs text-slate-400 font-bold ml-1">{item.unit}</span>
                                                    </td>
                                                    <td className="px-6 py-3 text-right font-semibold text-slate-900">
                                                        {formatPrice(Math.abs(locData.qty) > 0.000001 ? (locData.value / locData.qty) : 0)}
                                                    </td>
                                                    <td className="px-6 py-3 text-right font-semibold text-slate-900">
                                                        £{(locData.value || 0).toLocaleString(undefined, {minimumFractionDigits: 2})}
                                                    </td>
                                                </tr>

                                                {/* Level 3: QC / Batch Numbers aligned to parent columns */}
                                                {isItemExpanded && (
                                                    itemBatches.length > 0 ? (
                                                        itemBatches.map(b => {
                                                            const batchValue = (b.qty || 0) * (b.unitPrice || 0);
                                                            return (
                                                                <tr key={b.batch} className="bg-slate-50/80 hover:bg-slate-100/80">
                                                                    <td className="px-6 py-2 pl-20 border-l-2 border-slate-300">
                                                                        <div className="flex items-center gap-2">
                                                                            <span className="inline-flex items-center rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">{viewType === 'PRODUCT' ? 'BATCH' : 'QC'}</span>
                                                                            <div className="font-mono text-xs text-slate-600 break-all">{b.batch}</div>
                                                                        </div>
                                                                    </td>
                                                                    <td className="px-6 py-2 text-right font-mono text-slate-600">
                                                                        {b.qty.toLocaleString()} <span className="text-xs text-slate-400 font-bold ml-1">{item.unit}</span>
                                                                    </td>
                                                                    <td className="px-6 py-2 text-right font-medium text-slate-600">
                                                                        {formatPrice(b.unitPrice)}
                                                                    </td>
                                                                    <td className="px-6 py-2 text-right font-medium text-slate-600">
                                                                        £{batchValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                                                                    </td>
                                                                </tr>
                                                            );
                                                        })
                                                    ) : (
                                                        <tr className="bg-indigo-50/10">
                                                            <td className="px-6 py-2 pl-20 text-xs text-slate-400 italic">No specific batch details available.</td>
                                                            <td className="px-6 py-2 text-right text-slate-300">—</td>
                                                            <td className="px-6 py-2 text-right text-slate-300">—</td>
                                                            <td className="px-6 py-2 text-right text-slate-300">—</td>
                                                        </tr>
                                                    )
                                                )}
                                            </React.Fragment>
                                        );
                                    })}
                                </React.Fragment>
                            );
                        })}
                        {orderedLedgerCategories.length === 0 && (
                            <tr><td colSpan={4} className="py-20 text-center text-slate-400 italic">No inventory recorded in ledger.</td></tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>

        <div className="border-t border-slate-300 pt-4">
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                Reserved and On Hold values are independent of the Raw/Finished and Riverside/Hilltop/Consolidated filters above, but they follow the overview date and search filter.
            </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <div className="px-4 sm:px-6 py-4 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-white">
                <button
                    type="button"
                    onClick={() => setExpandedReserved((prev) => !prev)}
                    className="flex items-center min-w-0 text-left"
                >
                    <ShoppingCart className="w-5 h-5 mr-2 text-indigo-600 shrink-0" />
                    <div className="min-w-0">
                        <h3 className="font-bold text-slate-800 text-sm uppercase tracking-wider">Reserved</h3>
                        <div className="text-xs text-slate-500 mt-0.5">
                            {appliedOverviewSearchQuery
                                ? `${filteredReservedSummary.groupCount} of ${reservedSummary.groupCount} groups / ${filteredReservedSummary.itemCount} of ${reservedSummary.itemCount} items`
                                : `${reservedSummary.groupCount} groups / ${reservedSummary.itemCount} items`}
                        </div>
                    </div>
                </button>
                <div className="w-full sm:w-[430px] sm:ml-auto flex items-center justify-end gap-2 sm:gap-3 overflow-x-auto whitespace-nowrap">
                    <button
                        onClick={downloadReservedCSV}
                        className="h-9 w-9 flex shrink-0 items-center justify-center bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition text-slate-600 shadow-sm"
                        aria-label="Export reserved CSV"
                        title="Export CSV"
                    >
                        <Download className="w-4 h-4" />
                    </button>
                    <span className="text-xs font-medium text-slate-500 bg-slate-100 px-3 py-2 rounded-full shrink-0">
                        Total Value: <strong className="text-slate-700">£{reservedSummary.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
                    </span>
                    <button
                        type="button"
                        onClick={() => setExpandedReserved((prev) => !prev)}
                        className="shrink-0 p-2 rounded-md hover:bg-slate-100 text-slate-400"
                        aria-label="Toggle reserved details"
                    >
                        {expandedReserved ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </button>
                </div>
            </div>

            {expandedReserved && (
                <>
                <div className="mobile-scroll-hint px-4 pt-3">Swipe sideways to review reserved totals and drill-down details.</div>
                <div className="mobile-table-region overflow-x-auto">
                    <table className="w-full min-w-[980px] text-sm text-left table-fixed">
                        <colgroup>
                            <col className="w-[56%]" />
                            <col className="w-[14%]" />
                            <col className="w-[15%]" />
                            <col className="w-[15%]" />
                        </colgroup>
                        <thead className="bg-slate-50 text-slate-500 font-bold uppercase text-xs tracking-wider border-b border-slate-200">
                            <tr>
                                <th className="px-6 py-3">Reference / Item</th>
                                <th className="px-6 py-3 text-right">Quantity</th>
                                <th className="px-6 py-3 text-right">Unit Price</th>
                                <th className="px-6 py-3 text-right">Value</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {reservedGroups.length === 0 ? (
                                <tr><td colSpan={4} className="px-6 py-8 text-center text-slate-400 italic">No reserved ledger entries.</td></tr>
                            ) : filteredReservedGroups.length === 0 ? (
                                <tr><td colSpan={4} className="px-6 py-8 text-center text-slate-400 italic">No reserved entries match this search.</td></tr>
                            ) : (
                                filteredReservedGroups.map((group) => {
                                    const isExpanded = !!expandedReservedGroups[group.key];
                                    const groupUnitPrice = Math.abs(group.totalQty) > 0.000001 ? (group.totalValue / group.totalQty) : 0;
                                    return (
                                        <React.Fragment key={group.key}>
                                            <tr
                                                onClick={() => toggleReservedGroup(group.key)}
                                                className={`cursor-pointer transition-colors border-l-4 ${isExpanded ? 'bg-slate-100 border-l-indigo-500' : 'bg-slate-50 hover:bg-slate-100 border-l-transparent hover:border-l-indigo-500'}`}
                                            >
                                                <td className="px-6 py-3 font-bold text-slate-700">
                                                    <div className="flex items-center">
                                                        {isExpanded ? <ChevronDown className="w-4 h-4 mr-2 text-slate-400" /> : <ChevronRight className="w-4 h-4 mr-2 text-slate-400" />}
                                                        <span className="text-slate-900 break-words">{group.reference}</span>
                                                        <span className="ml-2 text-slate-400 font-normal normal-case">({group.items.length} items)</span>
                                                    </div>
                                                </td>
                                                <td className="px-6 py-3 text-right font-mono font-semibold text-slate-900">
                                                    {group.totalQty.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 3 })}
                                                </td>
                                                <td className="px-6 py-3 text-right font-semibold text-slate-900">
                                                    {formatPrice(groupUnitPrice)}
                                                </td>
                                                <td className="px-6 py-3 text-right font-semibold text-slate-900">
                                                    £{group.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                                </td>
                                            </tr>
                                            {isExpanded && (
                                                <tr className="bg-white">
                                                    <td colSpan={4} className="px-6 py-3">
                                                        <div className="mobile-table-region overflow-x-auto border border-slate-200 rounded-lg">
                                                            <table className="w-full min-w-[880px] text-sm text-left">
                                                                <thead className="bg-slate-50 text-slate-500 font-bold uppercase text-xs tracking-wider border-b border-slate-200">
                                                                    <tr>
                                                                        <th className="px-4 py-3">Item</th>
                                                                        <th className="px-4 py-3">Type</th>
                                                                        <th className="px-4 py-3">Batch / QC</th>
                                                                        <th className="px-4 py-3 text-right">Quantity</th>
                                                                        <th className="px-4 py-3">Unit</th>
                                                                        <th className="px-4 py-3 text-right">Unit Price / Cost</th>
                                                                        <th className="px-4 py-3 text-right">Value</th>
                                                                        <th className="px-4 py-3">Reason</th>
                                                                    </tr>
                                                                </thead>
                                                                <tbody className="divide-y divide-slate-100">
                                                                    {group.items.map((row) => (
                                                                        <tr key={row.txId}>
                                                                            <td className="px-4 py-3 text-slate-800">
                                                                                <div className="font-medium">{row.itemName}</div>
                                                                                <div className="font-mono text-[10px] text-slate-400 mt-0.5">{row.itemId}</div>
                                                                            </td>
                                                                            <td className="px-4 py-3 text-slate-600">{row.category === 'PRODUCT' ? 'Product' : 'Component'}</td>
                                                                            <td className="px-4 py-3 font-mono text-xs text-slate-600">{row.batchNumber}</td>
                                                                            <td className="px-4 py-3 text-right font-medium text-slate-700">
                                                                                {row.quantity.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 3 })}
                                                                            </td>
                                                                            <td className="px-4 py-3 text-slate-600">{row.unit}</td>
                                                                            <td className="px-4 py-3 text-right text-slate-700">{formatPrice(row.unitCost)}</td>
                                                                            <td className="px-4 py-3 text-right font-semibold text-slate-900">
                                                                                £{row.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                                                            </td>
                                                                            <td className="px-4 py-3 text-slate-600">{row.reason}</td>
                                                                        </tr>
                                                                    ))}
                                                                </tbody>
                                                            </table>
                                                        </div>
                                                    </td>
                                                </tr>
                                            )}
                                        </React.Fragment>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>
                </>
            )}
        </div>

        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <div className="px-4 sm:px-6 py-4 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-white">
                <button
                    type="button"
                    onClick={() => setExpandedOnHold((prev) => !prev)}
                    className="flex items-center min-w-0 text-left"
                >
                    <PauseCircle className="w-5 h-5 mr-2 text-indigo-600 shrink-0" />
                    <div className="min-w-0">
                        <h3 className="font-bold text-slate-800 text-sm uppercase tracking-wider">On Hold</h3>
                        <div className="text-xs text-slate-500 mt-0.5">
                            {appliedOverviewSearchQuery
                                ? `${filteredOnHoldSummary.groupCount} of ${onHoldSummary.groupCount} groups / ${filteredOnHoldSummary.itemCount} of ${onHoldSummary.itemCount} items`
                                : `${onHoldSummary.groupCount} groups / ${onHoldSummary.itemCount} items`}
                        </div>
                    </div>
                </button>
                <div className="w-full sm:w-[430px] sm:ml-auto flex items-center justify-end gap-2 sm:gap-3 overflow-x-auto whitespace-nowrap">
                    <button
                        onClick={downloadOnHoldCSV}
                        className="h-9 w-9 flex shrink-0 items-center justify-center bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition text-slate-600 shadow-sm"
                        aria-label="Export on hold CSV"
                        title="Export CSV"
                    >
                        <Download className="w-4 h-4" />
                    </button>
                    <span className="text-xs font-medium text-slate-500 bg-slate-100 px-3 py-2 rounded-full shrink-0">
                        Total Value: <strong className="text-slate-700">£{onHoldSummary.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
                    </span>
                    <button
                        type="button"
                        onClick={() => setExpandedOnHold((prev) => !prev)}
                        className="shrink-0 p-2 rounded-md hover:bg-slate-100 text-slate-400"
                        aria-label="Toggle on hold details"
                    >
                        {expandedOnHold ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </button>
                </div>
            </div>

            {expandedOnHold && (
                <>
                <div className="mobile-scroll-hint px-4 pt-3">Swipe sideways to review on-hold totals and drill-down details.</div>
                <div className="mobile-table-region overflow-x-auto">
                    <table className="w-full min-w-[980px] text-sm text-left table-fixed">
                        <colgroup>
                            <col className="w-[56%]" />
                            <col className="w-[14%]" />
                            <col className="w-[15%]" />
                            <col className="w-[15%]" />
                        </colgroup>
                        <thead className="bg-slate-50 text-slate-500 font-bold uppercase text-xs tracking-wider border-b border-slate-200">
                            <tr>
                                <th className="px-6 py-3">Category / Item</th>
                                <th className="px-6 py-3 text-right">Quantity</th>
                                <th className="px-6 py-3 text-right">Unit Price</th>
                                <th className="px-6 py-3 text-right">Value</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {onHoldGroups.length === 0 ? (
                                <tr><td colSpan={4} className="px-6 py-8 text-center text-slate-400 italic">No on hold records.</td></tr>
                            ) : filteredOnHoldGroups.length === 0 ? (
                                <tr><td colSpan={4} className="px-6 py-8 text-center text-slate-400 italic">No on hold records match this search.</td></tr>
                            ) : (
                                filteredOnHoldGroups.map((group) => {
                                    const isExpanded = !!expandedOnHoldGroups[group.key];
                                    const groupUnitPrice = Math.abs(group.totalQty) > 0.000001 ? (group.totalValue / group.totalQty) : 0;
                                    return (
                                        <React.Fragment key={group.key}>
                                            <tr
                                                onClick={() => toggleOnHoldGroup(group.key)}
                                                className={`cursor-pointer transition-colors border-l-4 ${isExpanded ? 'bg-slate-100 border-l-indigo-500' : 'bg-slate-50 hover:bg-slate-100 border-l-transparent hover:border-l-indigo-500'}`}
                                            >
                                                <td className="px-6 py-3 font-bold text-slate-700">
                                                    <div className="flex items-center">
                                                        {isExpanded ? <ChevronDown className="w-4 h-4 mr-2 text-slate-400" /> : <ChevronRight className="w-4 h-4 mr-2 text-slate-400" />}
                                                        <span className="text-slate-900 break-words">{group.label}</span>
                                                        <span className="ml-2 text-slate-400 font-normal normal-case">({group.items.length} items)</span>
                                                    </div>
                                                </td>
                                                <td className="px-6 py-3 text-right font-mono font-semibold text-slate-900">
                                                    {group.totalQty.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 3 })}
                                                </td>
                                                <td className="px-6 py-3 text-right font-semibold text-slate-900">
                                                    {formatPrice(groupUnitPrice)}
                                                </td>
                                                <td className="px-6 py-3 text-right font-semibold text-slate-900">
                                                    £{group.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                                </td>
                                            </tr>
                                            {isExpanded && (
                                                <tr className="bg-white">
                                                    <td colSpan={4} className="px-6 py-3">
                                                        <div className="mobile-table-region overflow-x-auto border border-slate-200 rounded-lg">
                                                            <table className="w-full min-w-[880px] text-sm text-left">
                                                                <thead className="bg-slate-50 text-slate-500 font-bold uppercase text-xs tracking-wider border-b border-slate-200">
                                                                    <tr>
                                                                        <th className="px-4 py-3">Item</th>
                                                                        <th className="px-4 py-3">Type</th>
                                                                        <th className="px-4 py-3">Batch / QC</th>
                                                                        <th className="px-4 py-3 text-right">Quantity</th>
                                                                        <th className="px-4 py-3">Unit</th>
                                                                        <th className="px-4 py-3 text-right">Unit Price / Cost</th>
                                                                        <th className="px-4 py-3 text-right">Value</th>
                                                                        <th className="px-4 py-3">Status</th>
                                                                    </tr>
                                                                </thead>
                                                                <tbody className="divide-y divide-slate-100">
                                                                    {group.items.map((row) => (
                                                                        <tr key={row.id}>
                                                                            <td className="px-4 py-3 text-slate-800">
                                                                                <div className="font-medium">{row.itemName}</div>
                                                                                <div className="font-mono text-[10px] text-slate-400 mt-0.5">{row.itemId}</div>
                                                                            </td>
                                                                            <td className="px-4 py-3 text-slate-600">{row.category === 'PRODUCT' ? 'Product' : 'Component'}</td>
                                                                            <td className="px-4 py-3 font-mono text-xs text-slate-600">{row.batchNumber}</td>
                                                                            <td className="px-4 py-3 text-right font-medium text-slate-700">
                                                                                {row.quantity.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 3 })}
                                                                            </td>
                                                                            <td className="px-4 py-3 text-slate-600">{row.unit}</td>
                                                                            <td className="px-4 py-3 text-right text-slate-700">{formatPrice(row.unitCost)}</td>
                                                                            <td className="px-4 py-3 text-right font-semibold text-slate-900">
                                                                                £{row.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                                                            </td>
                                                                            <td className="px-4 py-3 text-slate-600">{row.status}</td>
                                                                        </tr>
                                                                    ))}
                                                                </tbody>
                                                            </table>
                                                        </div>
                                                    </td>
                                                </tr>
                                            )}
                                        </React.Fragment>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>
                </>
            )}
        </div>

        <div className="flex justify-end">
            <button
                onClick={downloadInventoryCheckCSV}
                className="text-xs flex items-center bg-emerald-50 border border-emerald-300 px-3 py-2 rounded-md hover:bg-emerald-100 transition text-emerald-800 font-semibold shadow-sm"
                title="Download inventory checking CSV"
            >
                <Download className="w-3.5 h-3.5 mr-2" />
                Inventory Check CSV
            </button>
        </div>
    </div>
  );
};
