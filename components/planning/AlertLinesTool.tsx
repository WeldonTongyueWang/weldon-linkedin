/**
 * HARD BOUNDARY: ALERTING CHANGE REQUEST
 *
 * AUTHORITY: Planning Alert Logic.
 * RULES:
 * 1. Logic must be read-only relative to inventory ledger.
 * 2. Only alert checklist metadata may persist via planning_reports; no stock writes.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { CategoryMaster, Component, InventoryTransaction, PlanningReport, RawComponentLot, Supplier } from '../../types';
import { isArchivedRawComponent } from '../../services/rawComponentsService';
import { computeLedgerStockLevels } from '../../services/ledgerStock';
import { resolveLedgerEventTime } from '../../services/ledgerTime';
import { getPlanningReports, savePlanningReport, updatePlanningReport } from '../../services/sheetsApi';
import { getRawLotWorkflowStage } from '../../services/rawLotWorkflow';
import { AlertTriangle, AlertCircle, Clock, CheckCircle, Loader2, RefreshCw, X, EyeOff, Undo2, ChevronDown, ChevronRight } from 'lucide-react';
import { useAppDialog } from '../ui/AppDialogProvider';
import { useIsHandheldDevice } from '../../lib/useIsHandheldDevice';
import { formatBritishDate } from '../../lib/dateFormatting';
import { isMutationGuardBlockedError } from '../../services/liveDataSync';
import { formatRawComponentInventoryLabel } from '../../utils/rawComponentLabels';

const ALERT_PO_RAISED_TYPE = 'ALERT_PO_RAISED';
const ALERT_PO_RAISED_REPORT_NAME = 'Stock Alert PO Raised';
const ALERT_IGNORED_TYPE = 'ALERT_IGNORED_ITEM';
const ALERT_IGNORED_REPORT_NAME = 'Stock Alert Ignored Item';

type AlertPoRaisedStatus = 'OPEN' | 'CLEARED';
type AlertIgnoredStatus = 'IGNORED' | 'ACTIVE';

interface AlertPoRaisedPayload {
  type: typeof ALERT_PO_RAISED_TYPE;
  status: AlertPoRaisedStatus;
  component_id: string;
  component_name: string;
  ordered_qty: number;
  updated_at: string;
  updated_by: string;
}

interface AlertPoRaisedRecord extends AlertPoRaisedPayload {
  report_id: string;
  created_at: string;
}

interface AlertIgnoredPayload {
  type: typeof ALERT_IGNORED_TYPE;
  status: AlertIgnoredStatus;
  component_id: string;
  component_name: string;
  updated_at: string;
  updated_by: string;
}

interface AlertIgnoredRecord extends AlertIgnoredPayload {
  report_id: string;
  created_at: string;
}

interface AlertSuggestionRow {
  component_id: string;
  component_name: string;
  current_stock: number;
  daily_usage: number;
  days_until_stockout: number;
  suggested_order_qty: number;
  supplier_names: string[];
  latest_order_date: string;
  risk_level: 'High' | 'Medium';
}

interface PreArrivalSummary {
  ordered_qty: number;
  expected_date: string;
  mode: 'PRE_ARRIVAL' | 'ON_HOLD';
}

interface AlertStatusDisplay {
  tone: 'slate' | 'emerald' | 'amber';
  label: string;
  detail: string;
  quantity: number;
  mode: 'SHOULD_RAISE' | 'RAISED' | 'ARRIVING';
}

interface ComponentDemandStats {
  total30: number;
  total90: number;
  total180: number;
  avg30: number;
  avg90: number;
  avg180: number;
  effectiveDailyUsage: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEMAND_WINDOWS_DAYS = [30, 90, 180] as const;
const LONG_WINDOW_DEMAND_WEIGHT = 0.5;

const normalizeText = (val: unknown): string => {
  if (val === undefined || val === null) return '';
  return String(val).trim();
};

const normalizeComponentKey = (value: unknown): string => normalizeText(value).toLowerCase();

const normalizeStatusKey = (value: unknown): string =>
  normalizeText(value).toLowerCase().replace(/[\s_-]+/g, '_');

const isOnHoldRawLot = (lot: Partial<RawComponentLot>): boolean =>
  normalizeStatusKey((lot as any)?.qcStatus) === 'on_hold';

const isQcPassedRawLot = (lot: Partial<RawComponentLot>): boolean =>
  normalizeStatusKey((lot as any)?.qcStatus) === 'qc_passed';

const normalizePoRaisedQuantity = (value: unknown): number => {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;
  return Math.ceil(quantity);
};

const formatAlertDate = (value: unknown): string => {
  const rawValue = normalizeText(value);
  if (!rawValue) return '';

  return formatBritishDate(rawValue, rawValue);
};

const toDateStamp = (value: string): number => {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
};

const toFiniteTimestamp = (value: unknown): number => {
  const rawValue = normalizeText(value);
  if (!rawValue) return 0;
  const parsed = new Date(rawValue).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};

const getRawLotAuditTimestamp = (lot: Partial<RawComponentLot>): number =>
  Math.max(
    toFiniteTimestamp((lot as any).editedAt),
    toFiniteTimestamp((lot as any).updatedAt),
    toFiniteTimestamp((lot as any).registeredAt),
    toFiniteTimestamp((lot as any).deliveryDate),
    toFiniteTimestamp((lot as any).createdAt),
  );

const readErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : 'Unknown error';
};

const parseReportPayload = <T extends object>(report: PlanningReport): Partial<T> => {
  const rawPayload = (report as any)?.breakdown_json ?? (report as any)?.breakdownJson;
  if (typeof rawPayload === 'string') {
    try {
      return rawPayload ? JSON.parse(rawPayload) : {};
    } catch {
      return {};
    }
  }
  if (rawPayload && typeof rawPayload === 'object') {
    return rawPayload as Partial<T>;
  }
  return {};
};

const resolveReportTime = (updatedAt: string, createdAt: string): number => {
  const timestamp = new Date(updatedAt || createdAt || '').getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const shouldClearPoRaisedRecordForQcPassed = (
  record: AlertPoRaisedRecord | undefined,
  latestQcPassedAtByComponent: Map<string, number>
): boolean => {
  if (!record || record.status !== 'OPEN' || Number(record.ordered_qty || 0) <= 0) return false;

  const componentKey = normalizeComponentKey(record.component_id);
  const latestQcPassedAt = latestQcPassedAtByComponent.get(componentKey) || 0;
  if (latestQcPassedAt <= 0) return false;

  const recordTime = resolveReportTime(record.updated_at, record.created_at);
  return recordTime > 0 && latestQcPassedAt >= recordTime;
};

const buildAlertReportId = (prefix: string, componentId: string): string => {
  const componentKey = normalizeText(componentId)
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toUpperCase();

  return `${prefix}-${componentKey || 'ITEM'}-${Date.now()}`;
};

const parseAlertPoRaisedReport = (report: PlanningReport): AlertPoRaisedRecord | null => {
  const payloadSource = parseReportPayload<AlertPoRaisedPayload>(report);
  if (normalizeText(payloadSource.type).toUpperCase() !== ALERT_PO_RAISED_TYPE) return null;

  const componentId = normalizeText(
    payloadSource.component_id ||
    (report as any).product_sku ||
    (report as any).productSku
  );
  if (!componentId) return null;

  const orderedQty = normalizePoRaisedQuantity(
    payloadSource.ordered_qty ??
    (report as any).batch_size ??
    (report as any).batchSize
  );
  const createdAt = normalizeText((report as any).created_at || (report as any).createdAt);

  return {
    report_id: normalizeText((report as any).report_id || (report as any).reportId),
    created_at: createdAt,
    type: ALERT_PO_RAISED_TYPE,
    status: normalizeText(payloadSource.status).toUpperCase() === 'CLEARED' || orderedQty <= 0 ? 'CLEARED' : 'OPEN',
    component_id: componentId,
    component_name: normalizeText(
      payloadSource.component_name ||
      String((report as any).product_name || (report as any).productName || '').replace(`${ALERT_PO_RAISED_REPORT_NAME} - `, '')
    ),
    ordered_qty: orderedQty,
    updated_at: normalizeText(payloadSource.updated_at || (report as any).updatedAt || createdAt),
    updated_by: normalizeText(payloadSource.updated_by || (report as any).created_by || (report as any).createdBy),
  };
};

const parseAlertIgnoredReport = (report: PlanningReport): AlertIgnoredRecord | null => {
  const payloadSource = parseReportPayload<AlertIgnoredPayload>(report);
  if (normalizeText(payloadSource.type).toUpperCase() !== ALERT_IGNORED_TYPE) return null;

  const componentId = normalizeText(
    payloadSource.component_id ||
    (report as any).product_sku ||
    (report as any).productSku
  );
  if (!componentId) return null;

  const createdAt = normalizeText((report as any).created_at || (report as any).createdAt);

  return {
    report_id: normalizeText((report as any).report_id || (report as any).reportId),
    created_at: createdAt,
    type: ALERT_IGNORED_TYPE,
    status: normalizeText(payloadSource.status).toUpperCase() === 'IGNORED' ? 'IGNORED' : 'ACTIVE',
    component_id: componentId,
    component_name: normalizeText(
      payloadSource.component_name ||
      String((report as any).product_name || (report as any).productName || '').replace(`${ALERT_IGNORED_REPORT_NAME} - `, '')
    ),
    updated_at: normalizeText(payloadSource.updated_at || (report as any).updatedAt || createdAt),
    updated_by: normalizeText(payloadSource.updated_by || (report as any).created_by || (report as any).createdBy),
  };
};

const setSavingFlag = (
  setSavingComponentIds: React.Dispatch<React.SetStateAction<Record<string, boolean>>>,
  componentId: string,
  isSaving: boolean
) => {
  setSavingComponentIds((prev) => {
    if (isSaving) return { ...prev, [componentId]: true };
    const next = { ...prev };
    delete next[componentId];
    return next;
  });
};

const persistPoRaisedRecord = async ({
  currentUser,
  componentId,
  componentName,
  orderedQty,
  existingRecord,
  setPoRaisedByComponent,
  setPoRaisedDrafts,
  setSavingComponentIds,
}: {
  currentUser: string;
  componentId: string;
  componentName: string;
  orderedQty: number;
  existingRecord?: AlertPoRaisedRecord;
  setPoRaisedByComponent: React.Dispatch<React.SetStateAction<Record<string, AlertPoRaisedRecord>>>;
  setPoRaisedDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setSavingComponentIds: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
}) => {
  const normalizedQty = normalizePoRaisedQuantity(orderedQty);
  const now = new Date().toISOString();
  const reportId = existingRecord?.report_id || buildAlertReportId('RPT-ALERT-PO', componentId);
  const componentKey = normalizeComponentKey(componentId);
  const payload: AlertPoRaisedPayload = {
    type: ALERT_PO_RAISED_TYPE,
    status: normalizedQty > 0 ? 'OPEN' : 'CLEARED',
    component_id: componentId,
    component_name: componentName,
    ordered_qty: normalizedQty,
    updated_at: now,
    updated_by: currentUser,
  };
  const report: PlanningReport = {
    report_id: reportId,
    product_sku: componentId,
    product_name: `${ALERT_PO_RAISED_REPORT_NAME} - ${componentName}`,
    batch_size: normalizedQty,
    total_cost: 0,
    cost_per_unit: 0,
    breakdown_json: JSON.stringify(payload),
    created_at: existingRecord?.created_at || now,
    created_by: currentUser,
  };

  setSavingFlag(setSavingComponentIds, componentId, true);
  try {
    if (existingRecord?.report_id) {
      await updatePlanningReport(existingRecord.report_id, {
        product_sku: report.product_sku,
        product_name: report.product_name,
        batch_size: report.batch_size,
        total_cost: report.total_cost,
        cost_per_unit: report.cost_per_unit,
        breakdown_json: report.breakdown_json,
      });
    } else {
      await savePlanningReport(report);
    }

    const nextRecord: AlertPoRaisedRecord = {
      report_id: reportId,
      created_at: existingRecord?.created_at || now,
      ...payload,
    };

    setPoRaisedByComponent((prev) => ({
      ...prev,
      [componentKey]: nextRecord,
    }));
    setPoRaisedDrafts((prev) => ({
      ...prev,
      [componentId]: normalizedQty > 0 ? String(normalizedQty) : '',
    }));
  } finally {
    setSavingFlag(setSavingComponentIds, componentId, false);
  }
};

const persistIgnoredRecord = async ({
  currentUser,
  componentId,
  componentName,
  nextStatus,
  existingRecord,
  setIgnoredByComponent,
  setSavingComponentIds,
}: {
  currentUser: string;
  componentId: string;
  componentName: string;
  nextStatus: AlertIgnoredStatus;
  existingRecord?: AlertIgnoredRecord;
  setIgnoredByComponent: React.Dispatch<React.SetStateAction<Record<string, AlertIgnoredRecord>>>;
  setSavingComponentIds: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
}) => {
  const now = new Date().toISOString();
  const reportId = existingRecord?.report_id || buildAlertReportId('RPT-ALERT-IGN', componentId);
  const componentKey = normalizeComponentKey(componentId);
  const payload: AlertIgnoredPayload = {
    type: ALERT_IGNORED_TYPE,
    status: nextStatus,
    component_id: componentId,
    component_name: componentName,
    updated_at: now,
    updated_by: currentUser,
  };
  const report: PlanningReport = {
    report_id: reportId,
    product_sku: componentId,
    product_name: `${ALERT_IGNORED_REPORT_NAME} - ${componentName}`,
    batch_size: 0,
    total_cost: 0,
    cost_per_unit: 0,
    breakdown_json: JSON.stringify(payload),
    created_at: existingRecord?.created_at || now,
    created_by: currentUser,
  };

  setSavingFlag(setSavingComponentIds, componentId, true);
  try {
    if (existingRecord?.report_id) {
      await updatePlanningReport(existingRecord.report_id, {
        product_sku: report.product_sku,
        product_name: report.product_name,
        batch_size: report.batch_size,
        total_cost: report.total_cost,
        cost_per_unit: report.cost_per_unit,
        breakdown_json: report.breakdown_json,
      });
    } else {
      await savePlanningReport(report);
    }

    const nextRecord: AlertIgnoredRecord = {
      report_id: reportId,
      created_at: existingRecord?.created_at || now,
      ...payload,
    };

    setIgnoredByComponent((prev) => ({
      ...prev,
      [componentKey]: nextRecord,
    }));
  } finally {
    setSavingFlag(setSavingComponentIds, componentId, false);
  }
};

interface Props {
  currentUser: string;
  inventory: Component[];
  categories?: CategoryMaster[];
  transactions: InventoryTransaction[];
  rawComponentLots?: RawComponentLot[];
  suppliers: Supplier[];
  isReadOnly?: boolean;
}

export const AlertLinesTool: React.FC<Props> = ({
  currentUser,
  inventory,
  categories = [],
  transactions,
  rawComponentLots = [],
  suppliers,
  isReadOnly = false,
}) => {
  const isHandheldDevice = useIsHandheldDevice();
  const appDialog = useAppDialog();
  const [targetDays, setTargetDays] = useState(30);
  const [poRaisedByComponent, setPoRaisedByComponent] = useState<Record<string, AlertPoRaisedRecord>>({});
  const [ignoredByComponent, setIgnoredByComponent] = useState<Record<string, AlertIgnoredRecord>>({});
  const [poRaisedDrafts, setPoRaisedDrafts] = useState<Record<string, string>>({});
  const [isLoadingMetadata, setIsLoadingMetadata] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [savingComponentIds, setSavingComponentIds] = useState<Record<string, boolean>>({});
  const [isIgnoredOpen, setIsIgnoredOpen] = useState(false);

  const stockLevels = useMemo(
    () => computeLedgerStockLevels(transactions, rawComponentLots),
    [transactions, rawComponentLots]
  );

  const preArrivalLotsByComponent = useMemo(() => {
    const map = new Map<string, PreArrivalSummary>();

    rawComponentLots.forEach((lot) => {
      const workflowStage = getRawLotWorkflowStage(lot);
      const isPreArrival = workflowStage === 'PRE_ARRIVAL';
      const isOnHold = isOnHoldRawLot(lot);
      if (!isPreArrival && !isOnHold) return;

      const componentKey = normalizeComponentKey(lot.itemId);
      if (!componentKey) return;

      const orderedQty = normalizePoRaisedQuantity(isPreArrival ? lot.ordered_qty : (lot.received_qty || lot.ordered_qty));
      if (orderedQty <= 0) return;

      const expectedDate = formatAlertDate(lot.expectedDeliveryDate || lot.deliveryDate);
      const existing = map.get(componentKey);
      const nextOrderedQty = (existing?.ordered_qty || 0) + orderedQty;
      const nextExpectedDate =
        toDateStamp(expectedDate) < toDateStamp(existing?.expected_date || '')
          ? expectedDate
          : (existing?.expected_date || expectedDate);

      map.set(componentKey, {
        ordered_qty: nextOrderedQty,
        expected_date: nextExpectedDate,
        mode: existing?.mode === 'PRE_ARRIVAL' || isPreArrival ? 'PRE_ARRIVAL' : 'ON_HOLD',
      });
    });

    return map;
  }, [rawComponentLots]);

  const latestQcPassedAtByComponent = useMemo(() => {
    const map = new Map<string, number>();
    rawComponentLots.forEach((lot) => {
      if (!isQcPassedRawLot(lot)) return;
      const componentKey = normalizeComponentKey(lot.itemId);
      if (!componentKey) return;
      const latestTimestamp = Math.max(map.get(componentKey) || 0, getRawLotAuditTimestamp(lot));
      map.set(componentKey, latestTimestamp);
    });
    return map;
  }, [rawComponentLots]);

  const lotSuppliersByComponent = useMemo(() => {
    const map = new Map<string, string[]>();

    rawComponentLots.forEach((lot) => {
      const itemId = normalizeComponentKey(lot.itemId);
      const supplierName = normalizeText(lot.supplier);
      if (!itemId || !supplierName) return;

      const existing = map.get(itemId) || [];
      if (!existing.includes(supplierName)) existing.push(supplierName);
      map.set(itemId, existing);
    });

    return map;
  }, [rawComponentLots]);

  const demandStatsByComponent = useMemo(() => {
    const totals: Record<string, Pick<ComponentDemandStats, 'total30' | 'total90' | 'total180'>> = {};
    const now = new Date();

    transactions.forEach((transaction) => {
      if (transaction.type !== 'OUT' || transaction.category !== 'COMPONENT') return;

      const eventTimestamp = new Date(resolveLedgerEventTime(transaction)).getTime();
      if (!Number.isFinite(eventTimestamp)) return;

      const ageDays = Math.max(0, (now.getTime() - eventTimestamp) / MS_PER_DAY);
      if (ageDays > DEMAND_WINDOWS_DAYS[2]) return;

      const itemId = normalizeText(transaction.itemId);
      const quantity = Number(transaction.quantity) || 0;
      if (!itemId || quantity <= 0) return;

      if (!totals[itemId]) totals[itemId] = { total30: 0, total90: 0, total180: 0 };
      if (ageDays <= DEMAND_WINDOWS_DAYS[0]) totals[itemId].total30 += quantity;
      if (ageDays <= DEMAND_WINDOWS_DAYS[1]) totals[itemId].total90 += quantity;
      totals[itemId].total180 += quantity;
    });

    const stats: Record<string, ComponentDemandStats> = {};
    Object.entries(totals).forEach(([itemId, total]) => {
      const avg30 = total.total30 / DEMAND_WINDOWS_DAYS[0];
      const avg90 = total.total90 / DEMAND_WINDOWS_DAYS[1];
      const avg180 = total.total180 / DEMAND_WINDOWS_DAYS[2];
      stats[itemId] = {
        ...total,
        avg30,
        avg90,
        avg180,
        effectiveDailyUsage: Math.max(avg30, avg90, avg180 * LONG_WINDOW_DEMAND_WEIGHT),
      };
    });

    return stats;
  }, [transactions]);

  const alertSuggestions = useMemo(() => {
    const today = new Date();

    return inventory
      .map((component): AlertSuggestionRow | null => {
        if (isArchivedRawComponent(component)) return null;

        const componentKey = normalizeComponentKey(component.component_id);
        const demandStats = demandStatsByComponent[component.component_id];
        const avgDailyUsage = Number(demandStats?.effectiveDailyUsage || 0);
        const availableStock = Number(stockLevels[component.component_id]?.totalAvailable || 0);
        const daysUntilStockout = avgDailyUsage > 0
          ? (availableStock > 0 ? availableStock / avgDailyUsage : 0)
          : Number.POSITIVE_INFINITY;

        const supplier = suppliers.find((row) => row.component_id === component.component_id);
        const leadTime = Number(supplier?.lead_time_days || 7);
        const dynamicMinimumStock = avgDailyUsage > 0 ? avgDailyUsage * Math.min(targetDays, Math.max(leadTime, 7)) : 0;
        const hasHistoricalDemand = Number(demandStats?.total180 || 0) > 0;
        const poRaisedRecord = poRaisedByComponent[componentKey];
        const hasOpenPoRaised =
          !shouldClearPoRaisedRecordForQcPassed(poRaisedRecord, latestQcPassedAtByComponent) &&
          poRaisedRecord?.status === 'OPEN' &&
          Number(poRaisedRecord.ordered_qty || 0) > 0;
        const shouldAlert =
          (avgDailyUsage > 0 && daysUntilStockout < targetDays) ||
          (avgDailyUsage > 0 && availableStock <= dynamicMinimumStock) ||
          (availableStock <= 0 && hasHistoricalDemand) ||
          hasOpenPoRaised;

        if (!shouldAlert) return null;

        const recordedSuppliers = lotSuppliersByComponent.get(normalizeComponentKey(component.component_id)) || [];
        const fallbackSuppliers = suppliers
          .filter((row) => normalizeComponentKey(row.component_id) === normalizeComponentKey(component.component_id))
          .map((row) => normalizeText(row.supplier_name))
          .filter(Boolean);
        const supplierNames = (recordedSuppliers.length > 0 ? recordedSuppliers : fallbackSuppliers)
          .filter((name, index, all) => all.indexOf(name) === index);

        const targetStockQty = avgDailyUsage > 0
          ? targetDays * avgDailyUsage
          : normalizePoRaisedQuantity(poRaisedRecord?.ordered_qty);
        let suggestedOrderQty = Math.max(targetStockQty - availableStock, 0);
        if (supplier) {
          if (suggestedOrderQty < supplier.moq) suggestedOrderQty = supplier.moq;
          if (supplier.pack_size > 0) {
            suggestedOrderQty = Math.ceil(suggestedOrderQty / supplier.pack_size) * supplier.pack_size;
          }
        }

        const stockoutDate = Number.isFinite(daysUntilStockout)
          ? new Date(today.getTime() + (daysUntilStockout * MS_PER_DAY))
          : today;
        const latestOrderDate = new Date(stockoutDate.getTime() - (leadTime * MS_PER_DAY));
        const daysUntilOrder = (latestOrderDate.getTime() - today.getTime()) / MS_PER_DAY;

        return {
          component_id: component.component_id,
          component_name: formatRawComponentInventoryLabel(component, categories),
          current_stock: availableStock,
          daily_usage: avgDailyUsage,
          days_until_stockout: daysUntilStockout,
          suggested_order_qty: Math.ceil(suggestedOrderQty),
          supplier_names: supplierNames,
          latest_order_date: latestOrderDate.toISOString().split('T')[0],
          risk_level: availableStock <= dynamicMinimumStock || daysUntilOrder <= 2 ? 'High' : 'Medium',
        };
      })
      .filter((item): item is AlertSuggestionRow => Boolean(item))
      .sort((left, right) => left.days_until_stockout - right.days_until_stockout);
  }, [categories, demandStatsByComponent, inventory, latestQcPassedAtByComponent, lotSuppliersByComponent, poRaisedByComponent, stockLevels, suppliers, targetDays]);

  const activeAlertSuggestions = useMemo(
    () => alertSuggestions.filter((suggestion) => ignoredByComponent[normalizeComponentKey(suggestion.component_id)]?.status !== 'IGNORED'),
    [alertSuggestions, ignoredByComponent]
  );

  const ignoredAlertSuggestions = useMemo(
    () => alertSuggestions.filter((suggestion) => ignoredByComponent[normalizeComponentKey(suggestion.component_id)]?.status === 'IGNORED'),
    [alertSuggestions, ignoredByComponent]
  );

  const getStatusDisplay = (
    componentId: string,
    latestOrderDate: string
  ): AlertStatusDisplay => {
    const componentKey = normalizeComponentKey(componentId);
    const preArrivalSummary = preArrivalLotsByComponent.get(componentKey);
    if (preArrivalSummary && preArrivalSummary.ordered_qty > 0) {
      return {
        tone: 'emerald',
        label: preArrivalSummary.mode === 'ON_HOLD' ? 'On hold' : 'Arriving on',
        detail: formatAlertDate(preArrivalSummary.expected_date) || 'TBC',
        quantity: preArrivalSummary.ordered_qty,
        mode: 'ARRIVING',
      };
    }

    const poRaisedRecord = poRaisedByComponent[componentKey];
    if (shouldClearPoRaisedRecordForQcPassed(poRaisedRecord, latestQcPassedAtByComponent)) {
      return {
        tone: 'slate',
        label: 'Should have been raised',
        detail: formatAlertDate(latestOrderDate) || 'TBC',
        quantity: 0,
        mode: 'SHOULD_RAISE',
      };
    }

    if (poRaisedRecord?.status === 'OPEN' && Number(poRaisedRecord.ordered_qty || 0) > 0) {
      return {
        tone: 'amber',
        label: 'Raised on',
        detail: formatAlertDate(poRaisedRecord.updated_at) || 'TBC',
        quantity: normalizePoRaisedQuantity(poRaisedRecord.ordered_qty),
        mode: 'RAISED',
      };
    }

    return {
      tone: 'slate',
      label: 'Should have been raised',
      detail: formatAlertDate(latestOrderDate) || 'TBC',
      quantity: 0,
      mode: 'SHOULD_RAISE',
    };
  };

  useEffect(() => {
    let cancelled = false;

    const loadAlertMetadata = async () => {
      setIsLoadingMetadata(true);
      setMetadataError(null);
      try {
        const reports = await getPlanningReports();
        if (cancelled) return;

        const nextPoRaisedByComponent: Record<string, AlertPoRaisedRecord> = {};
        const nextIgnoredByComponent: Record<string, AlertIgnoredRecord> = {};

        reports.forEach((report) => {
          const poRaisedRecord = parseAlertPoRaisedReport(report);
          if (poRaisedRecord) {
            const componentKey = normalizeComponentKey(poRaisedRecord.component_id);
            const existing = nextPoRaisedByComponent[componentKey];
            if (!existing || resolveReportTime(poRaisedRecord.updated_at, poRaisedRecord.created_at) >= resolveReportTime(existing.updated_at, existing.created_at)) {
              nextPoRaisedByComponent[componentKey] = poRaisedRecord;
            }
          }

          const ignoredRecord = parseAlertIgnoredReport(report);
          if (ignoredRecord) {
            const componentKey = normalizeComponentKey(ignoredRecord.component_id);
            const existing = nextIgnoredByComponent[componentKey];
            if (!existing || resolveReportTime(ignoredRecord.updated_at, ignoredRecord.created_at) >= resolveReportTime(existing.updated_at, existing.created_at)) {
              nextIgnoredByComponent[componentKey] = ignoredRecord;
            }
          }
        });

        setPoRaisedByComponent(nextPoRaisedByComponent);
        setIgnoredByComponent(nextIgnoredByComponent);
      } catch (error) {
        if (cancelled) return;
        console.error('Failed to load stock alert metadata:', error);
        setMetadataError(readErrorMessage(error));
      } finally {
        if (!cancelled) setIsLoadingMetadata(false);
      }
    };

    void loadAlertMetadata();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (isReadOnly || latestQcPassedAtByComponent.size === 0) return;

    const recordsToClear = Object.values(poRaisedByComponent).filter((record) =>
      shouldClearPoRaisedRecordForQcPassed(record, latestQcPassedAtByComponent)
    );

    if (recordsToClear.length === 0) return;

    let cancelled = false;

    const clearReleasedPoRaisedRecords = async () => {
      for (const record of recordsToClear) {
        if (cancelled) return;
        try {
          await persistPoRaisedRecord({
            currentUser,
            componentId: record.component_id,
            componentName: record.component_name || record.component_id,
            orderedQty: 0,
            existingRecord: record,
            setPoRaisedByComponent,
            setPoRaisedDrafts,
            setSavingComponentIds,
          });
        } catch (error) {
          if (isMutationGuardBlockedError(error)) return;
          console.error(`Failed to clear released PO raised record for ${record.component_id}:`, error);
        }
      }
    };

    void clearReleasedPoRaisedRecords();

    return () => {
      cancelled = true;
    };
  }, [currentUser, isReadOnly, latestQcPassedAtByComponent, poRaisedByComponent]);

  const handleSavePoRaised = async (componentId: string, componentName: string) => {
    const draftValue = poRaisedDrafts[componentId];
    const existingRecord = poRaisedByComponent[normalizeComponentKey(componentId)];
    const nextQty = normalizePoRaisedQuantity(
      draftValue !== undefined && draftValue !== ''
        ? draftValue
        : existingRecord?.ordered_qty
    );

    if (nextQty <= 0) {
      await appDialog.alert({ message: 'Enter the ordered quantity first, then click PO raised.', tone: 'warning' });
      return;
    }

    try {
      await persistPoRaisedRecord({
        currentUser,
        componentId,
        componentName,
        orderedQty: nextQty,
        existingRecord,
        setPoRaisedByComponent,
        setPoRaisedDrafts,
        setSavingComponentIds,
      });
    } catch (error) {
      if (isMutationGuardBlockedError(error)) return;
      console.error(`Failed to save PO raised quantity for ${componentId}:`, error);
      await appDialog.alert({ message: `Failed to save PO raised quantity. ${readErrorMessage(error)}`, tone: 'danger' });
    }
  };

  const handleUpdatePoRaised = async (componentId: string, componentName: string) => {
    const existingRecord = poRaisedByComponent[normalizeComponentKey(componentId)];
    if (!existingRecord || existingRecord.status !== 'OPEN') {
      await appDialog.alert({ message: 'Use PO raised first to create the local planning record.', tone: 'warning' });
      return;
    }

    const draftValue = poRaisedDrafts[componentId];
    const nextQty = normalizePoRaisedQuantity(
      draftValue !== undefined && draftValue !== ''
        ? draftValue
        : existingRecord.ordered_qty
    );

    if (nextQty <= 0) {
      await appDialog.alert({ message: 'Enter the updated quantity first, then click the update button.', tone: 'warning' });
      return;
    }

    try {
      await persistPoRaisedRecord({
        currentUser,
        componentId,
        componentName,
        orderedQty: nextQty,
        existingRecord,
        setPoRaisedByComponent,
        setPoRaisedDrafts,
        setSavingComponentIds,
      });
    } catch (error) {
      if (isMutationGuardBlockedError(error)) return;
      console.error(`Failed to update PO raised quantity for ${componentId}:`, error);
      await appDialog.alert({ message: `Failed to update PO raised quantity. ${readErrorMessage(error)}`, tone: 'danger' });
    }
  };

  const handleClearPoRaised = async (componentId: string, componentName: string) => {
    try {
      await persistPoRaisedRecord({
        currentUser,
        componentId,
        componentName,
        orderedQty: 0,
        existingRecord: poRaisedByComponent[normalizeComponentKey(componentId)],
        setPoRaisedByComponent,
        setPoRaisedDrafts,
        setSavingComponentIds,
      });
    } catch (error) {
      if (isMutationGuardBlockedError(error)) return;
      console.error(`Failed to clear PO raised quantity for ${componentId}:`, error);
      await appDialog.alert({ message: `Failed to clear PO raised quantity. ${readErrorMessage(error)}`, tone: 'danger' });
    }
  };

  const handleSetIgnored = async (componentId: string, componentName: string, nextIgnored: boolean) => {
    try {
      await persistIgnoredRecord({
        currentUser,
        componentId,
        componentName,
        nextStatus: nextIgnored ? 'IGNORED' : 'ACTIVE',
        existingRecord: ignoredByComponent[normalizeComponentKey(componentId)],
        setIgnoredByComponent,
        setSavingComponentIds,
      });
    } catch (error) {
      if (isMutationGuardBlockedError(error)) return;
      console.error(`Failed to update ignored state for ${componentId}:`, error);
      await appDialog.alert({ message: `Failed to update ignored state. ${readErrorMessage(error)}`, tone: 'danger' });
    }
  };

  const mainLayoutClass = isHandheldDevice
    ? 'grid grid-cols-1 gap-8'
    : 'grid grid-cols-1 md:grid-cols-4 gap-8';
  const detailPanelClass = isHandheldDevice ? 'space-y-6' : 'md:col-span-3 space-y-6';

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-black text-slate-900">Raw Component Alerting</h2>
        <p className="text-sm text-slate-600">
          This report uses inventory-ledger calculations only. Available stock is derived from component ledger movements, and suggested order quantity tops stock back up to the target days of cover.
        </p>
      </div>

      <div className={mainLayoutClass}>
        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm h-fit">
          <h3 className="font-bold text-slate-800 mb-4 flex items-center uppercase tracking-widest text-xs">
            <AlertTriangle className="w-4 h-4 mr-2 text-indigo-600" /> Configuration
          </h3>
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-2">Target Days of Cover</label>
            <input
              type="number"
              className="w-full border-slate-300 rounded-lg text-sm font-bold text-indigo-600 p-2.5"
              value={targetDays}
              onChange={(event) => setTargetDays(Number(event.target.value))}
            />
            <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
              Daily usage blends recent and historical component `OUT` ledger transactions. Suggested order quantity = (`target days` x `daily usage`) - `ledger available stock`, then rounded to supplier MOQ and pack size where available.
            </p>
          </div>
        </div>

        <div className={detailPanelClass}>
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex justify-between items-center">
              <div>
                <h3 className="font-bold text-slate-700 text-sm uppercase tracking-wide">Stock Alert Report</h3>
                {!isReadOnly && <div className="text-[10px] text-slate-400 mt-1">Use Ignore and Restore to manage what stays in view.</div>}
              </div>
              <span className="bg-red-100 text-red-700 text-xs font-bold px-2 py-1 rounded">{activeAlertSuggestions.length} Items Critical</span>
            </div>
            {(isLoadingMetadata || metadataError) && (
              <div className={`px-6 py-3 text-xs border-b ${metadataError ? 'bg-amber-50 text-amber-700 border-amber-100' : 'bg-slate-50 text-slate-500 border-slate-200'}`}>
                {metadataError ? `Alert metadata could not be loaded. ${metadataError}` : 'Loading alert metadata...'}
              </div>
            )}

            {alertSuggestions.length === 0 ? (
              <div className="p-12 text-center text-slate-400 italic">
                <CheckCircle className="w-12 h-12 mx-auto mb-3 text-green-200" />
                No items below alert threshold.
              </div>
            ) : activeAlertSuggestions.length === 0 ? (
              <div className="p-12 text-center text-slate-400 italic">
                <CheckCircle className="w-12 h-12 mx-auto mb-3 text-slate-200" />
                All current alerts are in Ignored.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full table-fixed text-sm text-left">
                  <colgroup>
                    <col className="w-[11%]" />
                    <col className="w-[29%]" />
                    <col className="w-[21%]" />
                    <col className="w-[11%]" />
                    <col className="w-[28%]" />
                  </colgroup>
                  <thead className="bg-white text-slate-500 font-bold uppercase text-[10px] tracking-[0.22em] border-b border-slate-100">
                    <tr>
                      <th className="px-5 py-2.5">Risk Level</th>
                      <th className="px-5 py-2.5">Raw Component</th>
                      <th className="px-5 py-2.5">Stock Summary</th>
                      <th className="px-5 py-2.5 text-right">Suggested Order</th>
                      <th className="px-5 py-2.5">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {activeAlertSuggestions.map((suggestion) => {
                      const componentKey = normalizeComponentKey(suggestion.component_id);
                      const preArrivalSummary = preArrivalLotsByComponent.get(componentKey);
                      const poRaisedRecord = poRaisedByComponent[componentKey];
                      const statusDisplay = getStatusDisplay(suggestion.component_id, suggestion.latest_order_date);
                      const hasManualRaised = poRaisedRecord?.status === 'OPEN' && Number(poRaisedRecord?.ordered_qty || 0) > 0;
                      const hasPreArrival = Boolean(preArrivalSummary && preArrivalSummary.ordered_qty > 0);
                      const poRaisedDraft = poRaisedDrafts[suggestion.component_id];
                      const poRaisedInputValue = poRaisedDraft ?? (hasManualRaised ? String(normalizePoRaisedQuantity(poRaisedRecord?.ordered_qty)) : '');
                      const isSavingRow = Boolean(savingComponentIds[suggestion.component_id]);

                      return (
                        <tr
                          key={suggestion.component_id}
                          className={statusDisplay.mode === 'ARRIVING' ? 'bg-emerald-50/40 hover:bg-emerald-50/60' : 'hover:bg-slate-50'}
                        >
                          <td className="px-5 py-2.5 align-middle">
                            <div className="flex flex-col items-start gap-1.5">
                              {suggestion.risk_level === 'High' ? (
                                <span className="text-[10px] font-black bg-red-100 text-red-700 px-2 py-1 rounded-full inline-flex w-fit items-center leading-none"><AlertCircle className="w-3 h-3 mr-1" /> HIGH</span>
                              ) : (
                                <span className="text-[10px] font-black bg-orange-100 text-orange-700 px-2 py-1 rounded-full inline-flex w-fit items-center leading-none"><Clock className="w-3 h-3 mr-1" /> MED</span>
                              )}
                              <div className="flex items-center gap-1">
                                {!isReadOnly && (
                                  <button
                                    type="button"
                                    title="Ignore item"
                                    aria-label="Ignore item"
                                    className="inline-flex items-center justify-center w-7 h-7 text-slate-500 border border-slate-200 rounded-full hover:bg-slate-50"
                                    onClick={() => void handleSetIgnored(suggestion.component_id, suggestion.component_name, true)}
                                  >
                                    <EyeOff className="w-3 h-3" />
                                  </button>
                                )}
                                {statusDisplay.mode !== 'SHOULD_RAISE' && (
                                  <div
                                    title="Action logged"
                                    aria-label="Action logged"
                                    className="inline-flex items-center justify-center w-7 h-7 text-emerald-700 bg-emerald-100 border border-emerald-200 rounded-full"
                                  >
                                    <CheckCircle className="w-3 h-3" />
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="px-5 py-2.5 align-middle">
                            <div className="w-full max-w-full space-y-1">
                              <div
                                className="font-bold text-[13px] leading-[1.2] text-slate-700 break-words"
                                title={suggestion.component_name}
                                style={{
                                  display: '-webkit-box',
                                  WebkitLineClamp: 2,
                                  WebkitBoxOrient: 'vertical',
                                  overflow: 'hidden',
                                }}
                              >
                                {suggestion.component_name}
                              </div>
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[9px] leading-none">
                                <div
                                  className="text-slate-400 font-mono whitespace-nowrap overflow-hidden text-ellipsis max-w-[150px]"
                                  title={suggestion.component_id}
                                >
                                  {suggestion.component_id}
                                </div>
                                <div className="text-slate-300">•</div>
                                <div
                                  className="text-slate-400 whitespace-nowrap overflow-hidden text-ellipsis max-w-[72px]"
                                  title={suggestion.supplier_names.length > 0 ? suggestion.supplier_names.join(', ') : 'No supplier recorded'}
                                >
                                  {suggestion.supplier_names.length > 0 ? suggestion.supplier_names.join(', ') : 'No supplier recorded'}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="px-5 py-2.5 align-middle">
                            <div className="grid grid-cols-3 gap-1.5 rounded-xl bg-slate-50/80 border border-slate-200 px-2.5 py-1.5 min-w-[180px]">
                              <div className="flex flex-col items-center justify-center gap-1 text-center min-h-[72px]">
                                <div className="text-[8px] font-bold uppercase tracking-[0.16em] text-slate-400">Ledger</div>
                                <div className="font-mono text-[12px] leading-none text-slate-700">{suggestion.current_stock.toFixed(1)}</div>
                                <div className="text-[8px] uppercase tracking-[0.12em] text-transparent">/ day</div>
                              </div>
                              <div className="flex flex-col items-center justify-center gap-1 text-center border-x border-slate-200 min-h-[72px]">
                                <div className="text-[8px] font-bold uppercase tracking-[0.16em] text-slate-400">Usage</div>
                                <div className="font-mono text-[12px] leading-none text-slate-700">{suggestion.daily_usage.toFixed(2)}</div>
                                <div className="text-[8px] text-slate-400 uppercase tracking-[0.12em]">/ day</div>
                              </div>
                              <div className="flex flex-col items-center justify-center gap-1 text-center min-h-[72px]">
                                <div className="text-[8px] font-bold uppercase tracking-[0.16em] text-slate-400">Days</div>
                                <div className="font-mono text-[12px] leading-none text-slate-700">{suggestion.days_until_stockout.toFixed(1)}</div>
                                <div className="text-[8px] text-slate-400 uppercase tracking-[0.12em]">left</div>
                              </div>
                            </div>
                          </td>
                          <td className="px-5 py-2.5 text-right align-middle font-bold text-[14px] text-indigo-600 bg-indigo-50/25">+{suggestion.suggested_order_qty}</td>
                          <td className="px-5 py-2.5 align-middle">
                            <div className="space-y-1 min-w-[175px]">
                              <div className={`text-xs font-bold ${
                                statusDisplay.tone === 'emerald'
                                  ? 'text-emerald-700'
                                  : statusDisplay.tone === 'amber'
                                    ? 'text-amber-700'
                                    : 'text-slate-500'
                              }`}>
                                {statusDisplay.label}
                              </div>
                              <div className="text-[10px] text-slate-400">{statusDisplay.detail}</div>
                              {statusDisplay.quantity > 0 && (
                                <div className="text-[10px] font-semibold text-slate-600">{statusDisplay.quantity} ordered</div>
                              )}
                              {!isReadOnly && !hasPreArrival && (
                                <div className="pt-1 space-y-1">
                                  <div className="flex items-center gap-1">
                                    <input
                                      type="number"
                                      min={0}
                                      step={1}
                                      className="w-16 border-slate-300 rounded-lg text-[11px] font-semibold text-slate-700 px-2 py-1.5 disabled:bg-slate-100 disabled:text-slate-400"
                                      value={poRaisedInputValue}
                                      placeholder=""
                                      disabled={isSavingRow}
                                      onChange={(event) => setPoRaisedDrafts((prev) => ({
                                        ...prev,
                                        [suggestion.component_id]: event.target.value,
                                      }))}
                                      onKeyDown={(event) => {
                                        if (event.key === 'Enter') {
                                          event.preventDefault();
                                          void handleSavePoRaised(suggestion.component_id, suggestion.component_name);
                                        }
                                      }}
                                    />
                                    <button
                                      type="button"
                                      className="px-2 py-1.5 rounded-lg bg-emerald-600 text-white text-[9px] font-bold uppercase tracking-wide disabled:bg-slate-300 leading-none"
                                      disabled={isSavingRow}
                                      onClick={() => void handleSavePoRaised(suggestion.component_id, suggestion.component_name)}
                                    >
                                      PO raised
                                    </button>
                                    <button
                                      type="button"
                                      title="Update PO raised quantity"
                                      aria-label="Update PO raised quantity"
                                      className="p-1.5 rounded-lg border border-slate-300 text-slate-600 disabled:bg-slate-100 disabled:text-slate-300"
                                      disabled={isSavingRow || !hasManualRaised}
                                      onClick={() => void handleUpdatePoRaised(suggestion.component_id, suggestion.component_name)}
                                    >
                                      <RefreshCw className="w-3.5 h-3.5" />
                                    </button>
                                    {hasManualRaised && (
                                      <button
                                        type="button"
                                        title="Clear PO raised quantity"
                                        aria-label="Clear PO raised quantity"
                                        className="p-1.5 rounded-lg border border-slate-300 text-slate-600 disabled:bg-slate-100 disabled:text-slate-300"
                                        disabled={isSavingRow}
                                        onClick={() => void handleClearPoRaised(suggestion.component_id, suggestion.component_name)}
                                      >
                                        <X className="w-3.5 h-3.5" />
                                      </button>
                                    )}
                                    {isSavingRow && <Loader2 className="w-3.5 h-3.5 text-slate-400 animate-spin" />}
                                  </div>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex justify-between items-center gap-4">
              <button
                type="button"
                className="flex items-center gap-2 text-left"
                onClick={() => setIsIgnoredOpen((prev) => !prev)}
              >
                {isIgnoredOpen ? (
                  <ChevronDown className="w-4 h-4 text-slate-500" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-slate-500" />
                )}
                <div>
                  <h3 className="font-bold text-slate-700 text-sm uppercase tracking-wide">Ignored</h3>
                  <div className="text-[10px] text-slate-400 mt-1">Items moved here are hidden from the top report, but stay shared and reversible.</div>
                </div>
              </button>
              <span className="bg-slate-200 text-slate-700 text-xs font-bold px-2 py-1 rounded">{ignoredAlertSuggestions.length} Items</span>
            </div>
            {!isIgnoredOpen ? (
              <div className="px-6 py-4 text-xs text-slate-400">Ignored items are folded by default.</div>
            ) : ignoredAlertSuggestions.length === 0 ? (
              <div className="p-8 text-center text-slate-400 italic">
                Drop items here to stop monitoring them in the main report.
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {ignoredAlertSuggestions.map((suggestion) => {
                  const ignoredRecord = ignoredByComponent[normalizeComponentKey(suggestion.component_id)];
                  const isSavingIgnored = Boolean(savingComponentIds[suggestion.component_id]);
                  return (
                    <div
                      key={suggestion.component_id}
                      className="px-6 py-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between hover:bg-slate-50"
                    >
                      <div>
                        <div className="font-bold text-slate-800">{suggestion.component_name}</div>
                        <div className="text-[10px] text-slate-400 font-mono">{suggestion.component_id}</div>
                        <div className="text-[10px] text-slate-400">
                          {suggestion.supplier_names.length > 0 ? suggestion.supplier_names.join(', ') : 'No supplier recorded'}
                        </div>
                        <div className="text-[10px] text-slate-400 mt-1">
                          Ignored on {formatAlertDate(ignoredRecord?.updated_at)}. Order by {formatAlertDate(suggestion.latest_order_date)}.
                        </div>
                      </div>
                      {!isReadOnly && (
                        <button
                          type="button"
                          className="inline-flex items-center justify-center gap-1 px-3 py-2 rounded-lg border border-slate-300 text-slate-700 text-xs font-bold uppercase tracking-wide hover:bg-white disabled:bg-slate-100 disabled:text-slate-300"
                          disabled={isSavingIgnored}
                          onClick={() => void handleSetIgnored(suggestion.component_id, suggestion.component_name, false)}
                        >
                          <Undo2 className="w-3.5 h-3.5" />
                          Restore
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
