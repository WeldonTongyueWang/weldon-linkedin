import { InventoryTransaction, Product } from '../types';
import { computeLedgerStockLevels } from './ledgerStock';
import { resolveLedgerEventTime } from './ledgerTime';
import { PRODUCT_CATEGORY_ORDER, ProductCategoryGroup, resolveProductCategoryGroup } from './productCategoryGrouping';
import { formatFinishedProductInventoryLabel } from '../utils/finishedProductLabels';

export type SafetyStockCategory = ProductCategoryGroup;
export type SafetyStockRiskLevel = 'Low' | 'Medium' | 'High';

export interface SafetyStockHistoryPoint {
  weekStart: string;
  weekLabel: string;
  demand: number;
  actualStock: number;
}

export interface SafetyStockProductRow {
  productId: string;
  productName: string;
  category: SafetyStockCategory;
  currentStock: number;
  currentStockRounded: number;
  averageWeeklyDemand: number;
  stdDevWeeklyDemand: number;
  leadTimeWeeks: number;
  safetyStock: number;
  safetyStockRounded: number;
  stockDifference: number;
  riskLevel: SafetyStockRiskLevel;
  totalDemand: number;
  weeksWithDemand: number;
  weeklyDemandHistory: SafetyStockHistoryPoint[];
}

export interface SafetyStockModel {
  rows: SafetyStockProductRow[];
  lookbackWeeks: number;
  periodStart: string;
  periodEnd: string;
  matchedTransactionCount: number;
}

export interface BuildSafetyStockOptions {
  lookbackWeeks: number;
  serviceFactor: number;
  defaultLeadTimeWeeks: number;
  leadTimeOverrides?: Record<string, number>;
  now?: Date;
}

export const SAFETY_STOCK_CATEGORY_ORDER: SafetyStockCategory[] = [...PRODUCT_CATEGORY_ORDER];

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const normalize = (value: unknown): string => String(value ?? '').trim().toLowerCase();

const toNumber = (value: unknown, fallback = 0): number => {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const toPositiveNumber = (value: unknown, fallback = 0): number => {
  const n = toNumber(value, fallback);
  return n >= 0 ? n : fallback;
};

const isBlockedReason = (reason: unknown): boolean => {
  const text = normalize(reason);
  if (!text) return false;
  return (
    text.includes('reservation') ||
    text.includes('quarantine') ||
    text.includes('blocked') ||
    text.includes('on hold')
  );
};

const isEligibleDemandReason = (reason: unknown): boolean => {
  const normalizedReason = normalize(reason);
  if (!normalizedReason) return false;
  return (
    normalizedReason === 'reservation' ||
    normalizedReason === 'dispatch_staged' ||
    normalizedReason.includes('dispatch:')
  );
};

const resolvePlanningCategory = (product: Product): SafetyStockCategory | null => {
  const category = normalize(product.category);
  if (!product.sku_id || category.includes('archived')) return null;
  return resolveProductCategoryGroup(product);
};

const parseEventDate = (tx: InventoryTransaction): Date | null => {
  const raw = resolveLedgerEventTime(tx);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
};

const getUtcWeekStart = (value: Date): Date => {
  const start = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  const day = start.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  start.setUTCDate(start.getUTCDate() + diff);
  start.setUTCHours(0, 0, 0, 0);
  return start;
};

const addUtcWeeks = (value: Date, weeks: number): Date => {
  const next = new Date(value.getTime());
  next.setUTCDate(next.getUTCDate() + (weeks * 7));
  return next;
};

const toIsoDate = (value: Date): string => value.toISOString().slice(0, 10);

const formatWeekLabel = (weekStartIso: string): string => {
  const value = new Date(weekStartIso);
  return `${String(value.getUTCDate()).padStart(2, '0')} ${MONTH_NAMES[value.getUTCMonth()]}`;
};

const calculateSampleStdDev = (values: number[]): number => {
  if (values.length <= 1) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1);
  return Math.sqrt(Math.max(variance, 0));
};

const calculateSafetyStock = (serviceFactor: number, stdDevWeeklyDemand: number, leadTimeWeeks: number): number => {
  const safeServiceFactor = Math.max(0, toNumber(serviceFactor, 0));
  const safeLeadTimeWeeks = Math.max(0, toNumber(leadTimeWeeks, 0));
  return safeServiceFactor * stdDevWeeklyDemand * Math.sqrt(safeLeadTimeWeeks);
};

const roundUpToInteger = (value: number): number => Math.ceil(Math.max(0, value));

const resolveRiskLevel = (stockDifference: number, leadTimeWeeks: number): SafetyStockRiskLevel => {
  const shortfall = Math.max(0, -stockDifference);
  if (shortfall <= 0) return 'Low';

  const leadTimeRiskScore = shortfall * Math.max(1, leadTimeWeeks);
  if (leadTimeWeeks >= 4 || leadTimeRiskScore >= 20) return 'High';
  return 'Medium';
};

const resolveAvailableStockDelta = (tx: InventoryTransaction): number => {
  const qty = toNumber(tx.quantity, 0);
  if (normalize(tx.type) === 'in') return isBlockedReason(tx.reason) ? 0 : qty;
  return -qty;
};

export const buildSafetyStockModel = (
  transactions: InventoryTransaction[],
  products: Product[],
  options: BuildSafetyStockOptions
): SafetyStockModel => {
  const lookbackWeeks = Math.max(1, Math.round(toPositiveNumber(options.lookbackWeeks, 12)));
  const serviceFactor = toPositiveNumber(options.serviceFactor, 1.65);
  const defaultLeadTimeWeeks = toPositiveNumber(options.defaultLeadTimeWeeks, 2);
  const leadTimeOverrides = options.leadTimeOverrides || {};
  const now = options.now || new Date();
  const stockLevels = computeLedgerStockLevels(transactions);

  const endWeekStart = getUtcWeekStart(now);
  const startWeekStart = addUtcWeeks(endWeekStart, -(lookbackWeeks - 1));
  const weekStarts = Array.from({ length: lookbackWeeks }, (_, index) => addUtcWeeks(startWeekStart, index));
  const weekKeys = weekStarts.map(toIsoDate);
  const weekKeySet = new Set(weekKeys);

  const productsById = new Map<string, Product>();
  const categoryByProductId = new Map<string, SafetyStockCategory>();
  products.forEach((product) => {
    const productId = String(product.sku_id || '').trim();
    const category = resolvePlanningCategory(product);
    if (!productId || !category) return;
    productsById.set(productId.toLowerCase(), product);
    categoryByProductId.set(productId.toLowerCase(), category);
  });

  const stockEventsByProduct = new Map<string, { time: number; delta: number }[]>();
  transactions.forEach((tx) => {
    if (normalize(tx.category) !== 'product') return;

    const productId = String(tx.itemId || '').trim().toLowerCase();
    if (!productId || !productsById.has(productId)) return;

    const eventDate = parseEventDate(tx);
    if (!eventDate) return;

    const events = stockEventsByProduct.get(productId) || [];
    events.push({
      time: eventDate.getTime(),
      delta: resolveAvailableStockDelta(tx),
    });
    stockEventsByProduct.set(productId, events);
  });
  stockEventsByProduct.forEach((events) => {
    events.sort((left, right) => left.time - right.time);
  });

  const demandByProductWeek = new Map<string, Map<string, number>>();
  let matchedTransactionCount = 0;

  transactions.forEach((tx) => {
    if (normalize(tx.type) !== 'out') return;
    if (normalize(tx.category) !== 'product') return;
    if (!isEligibleDemandReason(tx.reason)) return;

    const productId = String(tx.itemId || '').trim().toLowerCase();
    if (!productId || !productsById.has(productId) || !categoryByProductId.has(productId)) return;

    const eventDate = parseEventDate(tx);
    if (!eventDate) return;

    const weekKey = toIsoDate(getUtcWeekStart(eventDate));
    if (!weekKeySet.has(weekKey)) return;

    const quantity = Math.abs(toNumber(tx.quantity, 0));
    if (quantity <= 0) return;

    matchedTransactionCount += 1;
    const byWeek = demandByProductWeek.get(productId) || new Map<string, number>();
    byWeek.set(weekKey, (byWeek.get(weekKey) || 0) + quantity);
    demandByProductWeek.set(productId, byWeek);
  });

  const rows: SafetyStockProductRow[] = Array.from(productsById.entries())
    .map(([productId, product]) => {
      const weeklyTotals = demandByProductWeek.get(productId) || new Map<string, number>();
      const category = categoryByProductId.get(productId);
      if (!product || !category) return null;

      const productStockEvents = stockEventsByProduct.get(productId) || [];
      let runningStock = 0;
      let stockEventIndex = 0;
      const weeklyDemandHistory = weekKeys.map((weekKey) => {
        const weekEndTime = addUtcWeeks(new Date(weekKey), 1).getTime();
        while (stockEventIndex < productStockEvents.length && productStockEvents[stockEventIndex].time < weekEndTime) {
          runningStock += productStockEvents[stockEventIndex].delta;
          stockEventIndex += 1;
        }

        return {
          weekStart: weekKey,
          weekLabel: formatWeekLabel(weekKey),
          demand: weeklyTotals.get(weekKey) || 0,
          actualStock: roundUpToInteger(runningStock),
        };
      });
      const weeklyValues = weeklyDemandHistory.map((entry) => entry.demand);
      const totalDemand = weeklyValues.reduce((sum, value) => sum + value, 0);
      const averageWeeklyDemand = totalDemand / weeklyValues.length;
      const stdDevWeeklyDemand = calculateSampleStdDev(weeklyValues);
      const leadTimeWeeks = toPositiveNumber(leadTimeOverrides[product.sku_id], defaultLeadTimeWeeks);
      const safetyStock = calculateSafetyStock(serviceFactor, stdDevWeeklyDemand, leadTimeWeeks);
      const currentStock = Number(stockLevels[product.sku_id]?.totalAvailable || 0);
      const safetyStockRounded = roundUpToInteger(safetyStock);
      const currentStockRounded = roundUpToInteger(currentStock);
      const stockDifference = currentStockRounded - safetyStockRounded;
      const riskLevel = resolveRiskLevel(stockDifference, leadTimeWeeks);

      return {
        productId: product.sku_id,
        productName: formatFinishedProductInventoryLabel(product),
        category,
        currentStock,
        currentStockRounded,
        averageWeeklyDemand,
        stdDevWeeklyDemand,
        leadTimeWeeks,
        safetyStock,
        safetyStockRounded,
        stockDifference,
        riskLevel,
        totalDemand,
        weeksWithDemand: weeklyValues.filter((value) => value > 0).length,
        weeklyDemandHistory,
      };
    })
    .filter((row): row is SafetyStockProductRow => Boolean(row))
    .sort((left, right) => {
      const categoryDelta =
        SAFETY_STOCK_CATEGORY_ORDER.indexOf(left.category) - SAFETY_STOCK_CATEGORY_ORDER.indexOf(right.category);
      if (categoryDelta !== 0) return categoryDelta;
      return left.productName.localeCompare(right.productName, undefined, { sensitivity: 'base' });
    });

  return {
    rows,
    lookbackWeeks,
    periodStart: weekKeys[0] || toIsoDate(startWeekStart),
    periodEnd: toIsoDate(now),
    matchedTransactionCount,
  };
};
