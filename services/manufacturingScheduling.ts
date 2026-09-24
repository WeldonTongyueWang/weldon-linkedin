import { BOMItem, CategoryMaster, Component, PlanningReport, Product, RawComponentLot } from '../types';
import { LedgerStockPosition } from './ledgerStock';
import {
  getBomLinesForSkuVariant,
  getDefaultBomVariantIdForSku,
  listBomVariantsForSku,
  normalizeBomVariantName,
  normalizeLineKindForSectioning,
} from './bomVariants';
import { SafetyStockProductRow } from './safetyStock';
import { formatBritishDate } from '../lib/dateFormatting';
import { formatFinishedProductInventoryLabel } from '../utils/finishedProductLabels';
import { formatRawComponentListLabel } from '../utils/rawComponentLabels';

export const MANUFACTURING_SCHEDULING_REPORT_TYPE = 'MANUFACTURING_SCHEDULING_V2';
export const MANUFACTURING_SCHEDULING_PRODUCT_SKU = 'MFG-SCHEDULING-V2';
export const MANUFACTURING_SCHEDULING_PRODUCT_NAME = 'Manufacturing Scheduling';
export const MANUFACTURING_SCHEDULING_WORKING_PLAN_ID = 'RPT-MFG-SCHED-WORKING-SHARED';
export const MANUFACTURING_SCHEDULING_HORIZON_WEEKS = 8;
export const MANUFACTURING_SCHEDULING_DEFAULT_BLEND_BATCH_SIZE_KG = 250;
export const MANUFACTURING_SCHEDULING_DEFAULT_LEAD_TIME_WEEKS = 3;
export const MANUFACTURING_SCHEDULING_DEFAULT_PRODUCTION_STAFF = 1;
export const MANUFACTURING_SCHEDULING_DEFAULT_BLEND_CAPACITY_PER_PERSON_WEEK = 500;
export const MANUFACTURING_SCHEDULING_DEFAULT_FILL_CAPACITY_PER_PERSON_WEEK = 500;

const FLOAT_EPSILON = 0.000001;
const CELL_KEY_SEPARATOR = '::';

export type ManufacturingSchedulingRecordKind = 'WORKING_PLAN' | 'SNAPSHOT';
export type ManufacturingSchedulingRecordStatus = 'ACTIVE' | 'SAVED' | 'DELETED';
export type ManufacturingSchedulingStage = 'BLEND' | 'FILL';
export type ManufacturingSchedulingFocusCategory =
  | 'COMMERCIAL_PRODUCT'
  | 'COMP_A'
  | 'SAMPLE'
  | 'COMMERCIAL_DISPENSING';
export type ManufacturingSchedulingMaterialGroup = 'INGREDIENT' | 'CONSUMABLE';
export type ManufacturingSchedulingShortageType = 'INTERNAL' | 'INGREDIENT' | 'CONSUMABLE';
export type ManufacturingSchedulingRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface ManufacturingSchedulingWeek {
  startDate: string;
  endDate: string;
}

export interface ManufacturingSchedulingPriceOption {
  key: string;
  unitPrice: number;
  deliveryDate: string;
  supplier: string;
  lotQty: number;
  lotUnit: string;
  label: string;
}

export interface ManufacturingSchedulingPlanProductInput {
  sku_id: string;
  sku_name?: string;
  horizon_target_qty?: number;
  is_selected?: boolean;
}

export interface ManufacturingSchedulingPlanCell {
  week_start: string;
  quantity_kg?: number;
  bom_variant_id?: string;
  bom_variant_name?: string;
  notes?: string;
}

export interface ManufacturingSchedulingPlanRow {
  row_id: string;
  parent_sku_id: string;
  parent_sku_name?: string;
  stage: ManufacturingSchedulingStage;
  output_sku_id: string;
  output_name?: string;
  cells: ManufacturingSchedulingPlanCell[];
}

export interface ManufacturingSchedulingProcurementSetting {
  component_id: string;
  selected_price_key?: string;
  manual_unit_price?: number;
  lead_time_weeks?: number;
}

export interface ManufacturingSchedulingPlanSummary {
  selected_product_count: number;
  total_blend_kg: number;
  total_fill_kg: number;
  shortage_count: number;
  procurement_spend: number;
}

export interface ManufacturingSchedulingPlanPayload {
  type: typeof MANUFACTURING_SCHEDULING_REPORT_TYPE;
  version: number;
  record_kind: ManufacturingSchedulingRecordKind;
  status: ManufacturingSchedulingRecordStatus;
  plan_name: string;
  horizon_start: string;
  horizon_end: string;
  week_starts: string[];
  assumptions: {
    default_blend_batch_size_kg: number;
    default_procurement_lead_time_weeks: number;
    production_staff_count: number;
    blend_capacity_kg_per_person_week: number;
    fill_capacity_kg_per_person_week: number;
  };
  product_inputs: ManufacturingSchedulingPlanProductInput[];
  schedule_rows: ManufacturingSchedulingPlanRow[];
  procurement_settings: ManufacturingSchedulingProcurementSetting[];
  summary?: ManufacturingSchedulingPlanSummary;
  source_snapshot_id?: string;
  updated_at?: string;
  updated_by?: string;
  saved_at?: string;
  saved_by?: string;
  deleted_at?: string;
  deleted_by?: string;
}

export interface ManufacturingSchedulingPlanRecord {
  report_id: string;
  product_name: string;
  created_at: string;
  created_by: string;
  record_kind: ManufacturingSchedulingRecordKind;
  status: ManufacturingSchedulingRecordStatus;
  payload: ManufacturingSchedulingPlanPayload;
}

export interface ManufacturingSchedulingPriorityRow {
  sku_id: string;
  sku_name: string;
  category: ManufacturingSchedulingFocusCategory;
  commercial_stock: number;
  blended_stock_reference: number;
  blended_reference_skus: string[];
  horizon_target_qty?: number;
  safety_stock_qty: number;
  priority_gap: number;
  unit: string;
  risk_level: SafetyStockProductRow['riskLevel'];
  is_selected: boolean;
  has_plan_activity: boolean;
}

export interface ManufacturingSchedulingInternalBalanceCell {
  weekStart: string;
  supply: number;
  demand: number;
  before: number;
  after: number;
}

export interface ManufacturingSchedulingInternalBalanceRow {
  sku_id: string;
  sku_name: string;
  current_stock: number;
  total_supply: number;
  total_demand: number;
  shortage_qty: number;
  cells: ManufacturingSchedulingInternalBalanceCell[];
}

export interface ManufacturingSchedulingScheduleCell {
  weekStart: string;
  quantityKg: number;
  bomVariantId: string;
  bomVariantName: string;
  beforeStock: number;
  afterStock: number;
}

export interface ManufacturingSchedulingScheduleStageRow {
  row_id: string;
  stage: ManufacturingSchedulingStage;
  output_sku_id: string;
  output_name: string;
  current_stock: number;
  total_planned_kg: number;
  cells: ManufacturingSchedulingScheduleCell[];
}

export interface ManufacturingSchedulingScheduleBlock {
  sku_id: string;
  sku_name: string;
  category: ManufacturingSchedulingFocusCategory;
  horizon_target_qty?: number;
  safety_stock_qty: number;
  commercial_stock: number;
  blended_stock_reference: number;
  blend_reference_skus: string[];
  rows: ManufacturingSchedulingScheduleStageRow[];
  warnings: string[];
}

export interface ManufacturingSchedulingMaterialCell {
  weekStart: string;
  required: number;
  before: number;
  after: number;
  risk: ManufacturingSchedulingRiskLevel;
}

export interface ManufacturingSchedulingMaterialRow {
  component_id: string;
  component_name: string;
  material_group: ManufacturingSchedulingMaterialGroup;
  unit: string;
  on_hand: number;
  total_required: number;
  shortage_qty: number;
  remaining_after_plan: number;
  selected_unit_price: number;
  estimated_spend: number;
  suggested_buy_qty: number;
  lead_time_weeks: number;
  order_by_date?: string;
  order_by_week?: string;
  price_options: ManufacturingSchedulingPriceOption[];
  requires_manual_price: boolean;
  cells: ManufacturingSchedulingMaterialCell[];
}

export interface ManufacturingSchedulingShortageRow {
  id: string;
  name: string;
  shortage_type: ManufacturingSchedulingShortageType;
  unit: string;
  current_qty: number;
  required_qty: number;
  shortage_qty: number;
  action: string;
  order_by_date?: string;
  estimated_spend?: number;
}

export interface ManufacturingSchedulingSummary {
  selected_product_count: number;
  total_blend_kg: number;
  total_fill_kg: number;
  ingredient_required: number;
  consumable_required: number;
  ingredient_shortage_count: number;
  consumable_shortage_count: number;
  internal_shortage_count: number;
  total_procurement_spend: number;
}

export interface ManufacturingSchedulingResult {
  priorityRows: ManufacturingSchedulingPriorityRow[];
  scheduleBlocks: ManufacturingSchedulingScheduleBlock[];
  materialRows: ManufacturingSchedulingMaterialRow[];
  shortageRows: ManufacturingSchedulingShortageRow[];
  internalBalanceRows: ManufacturingSchedulingInternalBalanceRow[];
  summary: ManufacturingSchedulingSummary;
}

interface ManufacturingSchedulingCalculationArgs {
  products: Product[];
  inventory: Component[];
  categories?: CategoryMaster[];
  bom: BOMItem[];
  rawComponentLots: RawComponentLot[];
  weeks: ManufacturingSchedulingWeek[];
  stockLevels: Record<string, LedgerStockPosition>;
  safetyStockBySkuId: Map<string, SafetyStockProductRow>;
  payload: ManufacturingSchedulingPlanPayload;
}

interface InternalDemandAccumulator {
  sku_id: string;
  sku_name: string;
  weekly_supply: Record<string, number>;
  weekly_demand: Record<string, number>;
}

interface MaterialDemandAccumulator {
  component_id: string;
  component_name: string;
  material_group: ManufacturingSchedulingMaterialGroup;
  unit: string;
  weekly_required: Record<string, number>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const normalizeText = (value: unknown): string => String(value ?? '').trim();

const normalizeLowerText = (value: unknown): string => normalizeText(value).toLowerCase();

const roundQty = (value: number): number => {
  const numeric = Number(value) || 0;
  if (Math.abs(numeric) < FLOAT_EPSILON) return 0;
  return Number(numeric.toFixed(3));
};

const toNonNegativeNumber = (value: unknown): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return roundQty(numeric);
};

const toOptionalNonNegativeNumber = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  if (numeric < 0) return 0;
  return roundQty(numeric);
};

const formatLocalDate = (value: Date): string => {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const parseLocalDate = (value: string): Date | null => {
  const raw = normalizeText(value);
  if (!raw) return null;
  const dateOnlyMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    const parsedDateOnly = new Date(Number(year), Number(month) - 1, Number(day));
    return Number.isNaN(parsedDateOnly.getTime()) ? null : parsedDateOnly;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const addDays = (value: string, days: number): string | undefined => {
  const parsed = parseLocalDate(value);
  if (!parsed) return undefined;
  parsed.setDate(parsed.getDate() + days);
  return formatLocalDate(parsed);
};

const compactCells = (cells: ManufacturingSchedulingPlanCell[]): ManufacturingSchedulingPlanCell[] =>
  cells
    .filter((cell) => {
      const quantity = toNonNegativeNumber(cell.quantity_kg);
      return quantity > 0 || Boolean(normalizeText(cell.bom_variant_id));
    })
    .map((cell) => ({
      week_start: normalizeText(cell.week_start),
      quantity_kg: toOptionalNonNegativeNumber(cell.quantity_kg),
      bom_variant_id: normalizeText(cell.bom_variant_id) || undefined,
      bom_variant_name: normalizeText(cell.bom_variant_name) || undefined,
      notes: normalizeText(cell.notes) || undefined,
    }));

const sortByDateDesc = (left: string, right: string): number => {
  const leftTime = parseLocalDate(left)?.getTime() || 0;
  const rightTime = parseLocalDate(right)?.getTime() || 0;
  return rightTime - leftTime;
};

export const makeManufacturingSchedulingCellKey = (rowId: string, weekStart: string): string =>
  `${normalizeText(rowId)}${CELL_KEY_SEPARATOR}${normalizeText(weekStart)}`;

export const buildManufacturingSchedulingWeeks = (
  fromDate: Date = new Date(),
  horizonWeeks = MANUFACTURING_SCHEDULING_HORIZON_WEEKS
): ManufacturingSchedulingWeek[] => {
  const base = new Date(fromDate);
  base.setHours(0, 0, 0, 0);

  const day = base.getDay();
  const daysUntilNextMonday = day === 0 ? 1 : 8 - day;
  base.setDate(base.getDate() + daysUntilNextMonday);

  return Array.from({ length: horizonWeeks }, (_, index) => {
    const start = new Date(base);
    start.setDate(base.getDate() + (index * 7));
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return {
      startDate: formatLocalDate(start),
      endDate: formatLocalDate(end),
    };
  });
};

export const createEmptyManufacturingSchedulingPlan = (
  weeks: ManufacturingSchedulingWeek[],
  planName = 'Shared working plan'
): ManufacturingSchedulingPlanPayload => ({
  type: MANUFACTURING_SCHEDULING_REPORT_TYPE,
  version: 2,
  record_kind: 'WORKING_PLAN',
  status: 'ACTIVE',
  plan_name: planName,
  horizon_start: weeks[0]?.startDate || '',
  horizon_end: weeks[weeks.length - 1]?.endDate || '',
  week_starts: weeks.map((week) => week.startDate),
  assumptions: {
    default_blend_batch_size_kg: MANUFACTURING_SCHEDULING_DEFAULT_BLEND_BATCH_SIZE_KG,
    default_procurement_lead_time_weeks: MANUFACTURING_SCHEDULING_DEFAULT_LEAD_TIME_WEEKS,
    production_staff_count: MANUFACTURING_SCHEDULING_DEFAULT_PRODUCTION_STAFF,
    blend_capacity_kg_per_person_week: MANUFACTURING_SCHEDULING_DEFAULT_BLEND_CAPACITY_PER_PERSON_WEEK,
    fill_capacity_kg_per_person_week: MANUFACTURING_SCHEDULING_DEFAULT_FILL_CAPACITY_PER_PERSON_WEEK,
  },
  product_inputs: [],
  schedule_rows: [],
  procurement_settings: [],
});

const normalizePlanCell = (cell: ManufacturingSchedulingPlanCell): ManufacturingSchedulingPlanCell => ({
  week_start: normalizeText(cell.week_start),
  quantity_kg: toOptionalNonNegativeNumber(cell.quantity_kg),
  bom_variant_id: normalizeText(cell.bom_variant_id) || undefined,
  bom_variant_name: normalizeText(cell.bom_variant_name) || undefined,
  notes: normalizeText(cell.notes) || undefined,
});

const normalizePlanRow = (row: ManufacturingSchedulingPlanRow): ManufacturingSchedulingPlanRow | null => {
  const rowId = normalizeText(row.row_id);
  const parentSkuId = normalizeText(row.parent_sku_id);
  const outputSkuId = normalizeText(row.output_sku_id);
  const stage = normalizeText(row.stage).toUpperCase() === 'FILL' ? 'FILL' : 'BLEND';
  if (!rowId || !parentSkuId || !outputSkuId) return null;
  return {
    row_id: rowId,
    parent_sku_id: parentSkuId,
    parent_sku_name: normalizeText(row.parent_sku_name) || undefined,
    stage,
    output_sku_id: outputSkuId,
    output_name: normalizeText(row.output_name) || undefined,
    cells: Array.isArray(row.cells) ? row.cells.map(normalizePlanCell) : [],
  };
};

const normalizeProductInput = (
  input: ManufacturingSchedulingPlanProductInput
): ManufacturingSchedulingPlanProductInput | null => {
  const skuId = normalizeText(input.sku_id);
  if (!skuId) return null;
  return {
    sku_id: skuId,
    sku_name: normalizeText(input.sku_name) || undefined,
    horizon_target_qty: toOptionalNonNegativeNumber(input.horizon_target_qty),
    is_selected: Boolean(input.is_selected),
  };
};

const normalizeProcurementSetting = (
  setting: ManufacturingSchedulingProcurementSetting
): ManufacturingSchedulingProcurementSetting | null => {
  const componentId = normalizeText(setting.component_id);
  if (!componentId) return null;
  return {
    component_id: componentId,
    selected_price_key: normalizeText(setting.selected_price_key) || undefined,
    manual_unit_price: toOptionalNonNegativeNumber(setting.manual_unit_price),
    lead_time_weeks: toOptionalNonNegativeNumber(setting.lead_time_weeks),
  };
};

export const rebaseManufacturingSchedulingPlan = (
  payload: ManufacturingSchedulingPlanPayload,
  weeks: ManufacturingSchedulingWeek[],
  bom: BOMItem[]
): ManufacturingSchedulingPlanPayload => {
  const weekMap = new Map((payload.schedule_rows || []).flatMap((row) => (row.cells || []).map((cell) => [makeManufacturingSchedulingCellKey(row.row_id, cell.week_start), cell])));
  const rebasedRows = (payload.schedule_rows || [])
    .map((row) => normalizePlanRow(row))
    .filter((row): row is ManufacturingSchedulingPlanRow => Boolean(row))
    .map((row) => {
      const variants = listBomVariantsForSku(bom, row.output_sku_id);
      const defaultVariantId = variants[0]?.bomVariantId || getDefaultBomVariantIdForSku(bom, row.output_sku_id);
      const defaultVariantName = variants.find((variant) => variant.bomVariantId === defaultVariantId)?.bomVariantName
        || normalizeBomVariantName(undefined, defaultVariantId);
      return {
        ...row,
        cells: weeks.map((week) => {
          const current = weekMap.get(makeManufacturingSchedulingCellKey(row.row_id, week.startDate));
          return {
            week_start: week.startDate,
            quantity_kg: toOptionalNonNegativeNumber(current?.quantity_kg),
            bom_variant_id: normalizeText(current?.bom_variant_id) || defaultVariantId,
            bom_variant_name: normalizeText(current?.bom_variant_name) || defaultVariantName,
            notes: normalizeText(current?.notes) || undefined,
          };
        }),
      };
    });

  return {
    ...payload,
    type: MANUFACTURING_SCHEDULING_REPORT_TYPE,
    version: 2,
    horizon_start: weeks[0]?.startDate || '',
    horizon_end: weeks[weeks.length - 1]?.endDate || '',
    week_starts: weeks.map((week) => week.startDate),
    assumptions: {
      default_blend_batch_size_kg: toOptionalNonNegativeNumber(payload.assumptions?.default_blend_batch_size_kg)
        || MANUFACTURING_SCHEDULING_DEFAULT_BLEND_BATCH_SIZE_KG,
      default_procurement_lead_time_weeks: toOptionalNonNegativeNumber(payload.assumptions?.default_procurement_lead_time_weeks)
        || MANUFACTURING_SCHEDULING_DEFAULT_LEAD_TIME_WEEKS,
      production_staff_count: toOptionalNonNegativeNumber(payload.assumptions?.production_staff_count)
        || MANUFACTURING_SCHEDULING_DEFAULT_PRODUCTION_STAFF,
      blend_capacity_kg_per_person_week: toOptionalNonNegativeNumber(payload.assumptions?.blend_capacity_kg_per_person_week)
        || MANUFACTURING_SCHEDULING_DEFAULT_BLEND_CAPACITY_PER_PERSON_WEEK,
      fill_capacity_kg_per_person_week: toOptionalNonNegativeNumber(payload.assumptions?.fill_capacity_kg_per_person_week)
        || MANUFACTURING_SCHEDULING_DEFAULT_FILL_CAPACITY_PER_PERSON_WEEK,
    },
    product_inputs: (payload.product_inputs || [])
      .map(normalizeProductInput)
      .filter((row): row is ManufacturingSchedulingPlanProductInput => Boolean(row)),
    schedule_rows: rebasedRows,
    procurement_settings: (payload.procurement_settings || [])
      .map(normalizeProcurementSetting)
      .filter((row): row is ManufacturingSchedulingProcurementSetting => Boolean(row)),
  };
};

export const parseManufacturingSchedulingPlanRecord = (
  report: PlanningReport,
  weeks: ManufacturingSchedulingWeek[],
  bom: BOMItem[]
): ManufacturingSchedulingPlanRecord | null => {
  const rawPayload = (report as any)?.breakdown_json;
  const payloadSource = typeof rawPayload === 'string'
    ? (() => {
        try {
          return JSON.parse(rawPayload);
        } catch {
          return null;
        }
      })()
    : rawPayload;

  if (!isRecord(payloadSource)) return null;
  if (normalizeText(payloadSource.type) !== MANUFACTURING_SCHEDULING_REPORT_TYPE) return null;

  const recordKind = normalizeText(payloadSource.record_kind).toUpperCase() === 'SNAPSHOT'
    ? 'SNAPSHOT'
    : 'WORKING_PLAN';
  const rawStatus = normalizeText(payloadSource.status).toUpperCase();
  const status: ManufacturingSchedulingRecordStatus =
    rawStatus === 'DELETED' ? 'DELETED' : recordKind === 'WORKING_PLAN' ? 'ACTIVE' : 'SAVED';

  const payload = rebaseManufacturingSchedulingPlan({
    type: MANUFACTURING_SCHEDULING_REPORT_TYPE,
    version: Number(payloadSource.version || 2),
    record_kind: recordKind,
    status,
    plan_name: normalizeText(payloadSource.plan_name) || normalizeText(report.product_name) || 'Shared working plan',
    horizon_start: normalizeText(payloadSource.horizon_start),
    horizon_end: normalizeText(payloadSource.horizon_end),
    week_starts: Array.isArray(payloadSource.week_starts)
      ? payloadSource.week_starts.map((week) => normalizeText(week)).filter(Boolean)
      : [],
    assumptions: {
      default_blend_batch_size_kg: toOptionalNonNegativeNumber((payloadSource.assumptions as any)?.default_blend_batch_size_kg)
        || MANUFACTURING_SCHEDULING_DEFAULT_BLEND_BATCH_SIZE_KG,
      default_procurement_lead_time_weeks: toOptionalNonNegativeNumber((payloadSource.assumptions as any)?.default_procurement_lead_time_weeks)
        || MANUFACTURING_SCHEDULING_DEFAULT_LEAD_TIME_WEEKS,
      production_staff_count: toOptionalNonNegativeNumber((payloadSource.assumptions as any)?.production_staff_count)
        || MANUFACTURING_SCHEDULING_DEFAULT_PRODUCTION_STAFF,
      blend_capacity_kg_per_person_week: toOptionalNonNegativeNumber((payloadSource.assumptions as any)?.blend_capacity_kg_per_person_week)
        || MANUFACTURING_SCHEDULING_DEFAULT_BLEND_CAPACITY_PER_PERSON_WEEK,
      fill_capacity_kg_per_person_week: toOptionalNonNegativeNumber((payloadSource.assumptions as any)?.fill_capacity_kg_per_person_week)
        || MANUFACTURING_SCHEDULING_DEFAULT_FILL_CAPACITY_PER_PERSON_WEEK,
    },
    product_inputs: Array.isArray(payloadSource.product_inputs)
      ? payloadSource.product_inputs
        .map((entry) => normalizeProductInput(entry as ManufacturingSchedulingPlanProductInput))
        .filter((entry): entry is ManufacturingSchedulingPlanProductInput => Boolean(entry))
      : [],
    schedule_rows: Array.isArray(payloadSource.schedule_rows)
      ? payloadSource.schedule_rows
        .map((entry) => normalizePlanRow(entry as ManufacturingSchedulingPlanRow))
        .filter((entry): entry is ManufacturingSchedulingPlanRow => Boolean(entry))
      : [],
    procurement_settings: Array.isArray(payloadSource.procurement_settings)
      ? payloadSource.procurement_settings
        .map((entry) => normalizeProcurementSetting(entry as ManufacturingSchedulingProcurementSetting))
        .filter((entry): entry is ManufacturingSchedulingProcurementSetting => Boolean(entry))
      : [],
    summary: isRecord(payloadSource.summary)
      ? {
          selected_product_count: Number((payloadSource.summary as any).selected_product_count || 0),
          total_blend_kg: roundQty(Number((payloadSource.summary as any).total_blend_kg || 0)),
          total_fill_kg: roundQty(Number((payloadSource.summary as any).total_fill_kg || 0)),
          shortage_count: Number((payloadSource.summary as any).shortage_count || 0),
          procurement_spend: roundQty(Number((payloadSource.summary as any).procurement_spend || 0)),
        }
      : undefined,
    source_snapshot_id: normalizeText(payloadSource.source_snapshot_id) || undefined,
    updated_at: normalizeText(payloadSource.updated_at) || undefined,
    updated_by: normalizeText(payloadSource.updated_by) || undefined,
    saved_at: normalizeText(payloadSource.saved_at) || undefined,
    saved_by: normalizeText(payloadSource.saved_by) || undefined,
    deleted_at: normalizeText(payloadSource.deleted_at) || undefined,
    deleted_by: normalizeText(payloadSource.deleted_by) || undefined,
  }, weeks, bom);

  return {
    report_id: normalizeText(report.report_id),
    product_name: normalizeText(report.product_name) || payload.plan_name,
    created_at: normalizeText(report.created_at),
    created_by: normalizeText(report.created_by),
    record_kind: payload.record_kind,
    status: payload.status,
    payload,
  };
};

export const buildManufacturingSchedulingWorkingReport = (
  payload: ManufacturingSchedulingPlanPayload,
  currentUser: string,
  existing?: PlanningReport
): PlanningReport => {
  const timestamp = new Date().toISOString();
  const nextPayload: ManufacturingSchedulingPlanPayload = {
    ...payload,
    type: MANUFACTURING_SCHEDULING_REPORT_TYPE,
    version: 2,
    record_kind: 'WORKING_PLAN',
    status: 'ACTIVE',
    updated_at: timestamp,
    updated_by: currentUser,
  };
  const totalFill = roundQty((nextPayload.summary?.total_fill_kg || 0));
  const totalCost = roundQty((nextPayload.summary?.procurement_spend || 0));
  return {
    report_id: existing?.report_id || MANUFACTURING_SCHEDULING_WORKING_PLAN_ID,
    product_sku: MANUFACTURING_SCHEDULING_PRODUCT_SKU,
    product_name: nextPayload.plan_name || 'Shared working plan',
    batch_size: totalFill,
    total_cost: totalCost,
    cost_per_unit: totalFill > 0 ? roundQty(totalCost / totalFill) : 0,
    breakdown_json: JSON.stringify({
      ...nextPayload,
      schedule_rows: nextPayload.schedule_rows.map((row) => ({
        ...row,
        cells: compactCells(row.cells),
      })),
    }),
    created_at: existing?.created_at || timestamp,
    created_by: existing?.created_by || currentUser,
  };
};

export const buildManufacturingSchedulingSnapshotReport = (
  payload: ManufacturingSchedulingPlanPayload,
  currentUser: string
): PlanningReport => {
  const timestamp = new Date().toISOString();
  const totalFill = roundQty(payload.summary?.total_fill_kg || 0);
  const totalCost = roundQty(payload.summary?.procurement_spend || 0);
  const snapshotPayload: ManufacturingSchedulingPlanPayload = {
    ...payload,
    type: MANUFACTURING_SCHEDULING_REPORT_TYPE,
    version: 2,
    record_kind: 'SNAPSHOT',
    status: 'SAVED',
    saved_at: timestamp,
    saved_by: currentUser,
  };
  return {
    report_id: `RPT-SCHED-SNAPSHOT-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    product_sku: MANUFACTURING_SCHEDULING_PRODUCT_SKU,
    product_name: `${payload.plan_name || MANUFACTURING_SCHEDULING_PRODUCT_NAME} · ${timestamp.slice(0, 16).replace('T', ' ')}`,
    batch_size: totalFill,
    total_cost: totalCost,
    cost_per_unit: totalFill > 0 ? roundQty(totalCost / totalFill) : 0,
    breakdown_json: JSON.stringify({
      ...snapshotPayload,
      schedule_rows: snapshotPayload.schedule_rows.map((row) => ({
        ...row,
        cells: compactCells(row.cells),
      })),
    }),
    created_at: timestamp,
    created_by: currentUser,
  };
};

export const resolveManufacturingSchedulingFocusCategory = (
  product: Product
): ManufacturingSchedulingFocusCategory | null => {
  const category = normalizeLowerText(product.category);
  const format = normalizeLowerText(product.format);
  const name = normalizeLowerText(product.sku_name);

  if (category.includes('commercial dispensing') || category.includes('03') || format.includes('dispensing')) {
    return 'COMMERCIAL_DISPENSING';
  }
  if (category.includes('sample') || category.includes('02') || category.includes('04') || format.includes('sample')) {
    return 'SAMPLE';
  }
  if (name.includes('comp a') || format.includes('component a') || category.includes('intermediate') || category.includes('05')) {
    return 'COMP_A';
  }
  if (category.includes('commercial product') || category.includes('01')) {
    return 'COMMERCIAL_PRODUCT';
  }
  return null;
};

export const resolveManufacturingSchedulingLinkedSkuIds = (
  bom: BOMItem[],
  skuId: string,
  requestedVariantId?: string
): string[] => {
  const variantId = normalizeText(requestedVariantId) || getDefaultBomVariantIdForSku(bom, skuId);
  const lines = getBomLinesForSkuVariant(bom, skuId, variantId);
  const seen = new Set<string>();
  return lines
    .filter((line) => normalizeLineKindForSectioning(line) === 'INGREDIENT')
    .filter((line) => ['BLENDED_SKU', 'COMP_A_SKU'].includes(normalizeText(line.component_type).toUpperCase()))
    .map((line) => normalizeText(line.component_id))
    .filter((componentId) => {
      if (!componentId || seen.has(componentId)) return false;
      seen.add(componentId);
      return true;
    });
};

export const createManufacturingSchedulingRowsForProduct = (
  product: Product,
  bom: BOMItem[],
  weeks: ManufacturingSchedulingWeek[],
  productsById?: Map<string, Product>
): ManufacturingSchedulingPlanRow[] => {
  const category = resolveManufacturingSchedulingFocusCategory(product);
  if (!category) return [];

  const makeCells = (skuId: string) => {
    const variants = listBomVariantsForSku(bom, skuId);
    const defaultVariantId = variants[0]?.bomVariantId || getDefaultBomVariantIdForSku(bom, skuId);
    const defaultVariantName = variants.find((variant) => variant.bomVariantId === defaultVariantId)?.bomVariantName
      || normalizeBomVariantName(undefined, defaultVariantId);
    return weeks.map((week) => ({
      week_start: week.startDate,
      quantity_kg: undefined,
      bom_variant_id: defaultVariantId,
      bom_variant_name: defaultVariantName,
    }));
  };

  if (category === 'COMP_A') {
    const productLabel = formatFinishedProductInventoryLabel(product);
    return [{
      row_id: `${product.sku_id}::BLEND`,
      parent_sku_id: product.sku_id,
      parent_sku_name: productLabel,
      stage: 'BLEND',
      output_sku_id: product.sku_id,
      output_name: productLabel,
      cells: makeCells(product.sku_id),
    }];
  }

  const linkedSkuId = resolveManufacturingSchedulingLinkedSkuIds(bom, product.sku_id)[0];
  const linkedProduct = linkedSkuId ? productsById?.get(linkedSkuId) : undefined;
  const productLabel = formatFinishedProductInventoryLabel(product);
  const rows: ManufacturingSchedulingPlanRow[] = [];
  if (linkedSkuId) {
    rows.push({
      row_id: `${product.sku_id}::BLEND`,
      parent_sku_id: product.sku_id,
      parent_sku_name: productLabel,
      stage: 'BLEND',
      output_sku_id: linkedSkuId,
      output_name: linkedProduct ? formatFinishedProductInventoryLabel(linkedProduct) : linkedSkuId,
      cells: makeCells(linkedSkuId),
    });
  }
  rows.push({
    row_id: `${product.sku_id}::FILL`,
    parent_sku_id: product.sku_id,
    parent_sku_name: productLabel,
    stage: 'FILL',
    output_sku_id: product.sku_id,
    output_name: productLabel,
    cells: makeCells(product.sku_id),
  });
  return rows;
};

const resolvePriceDate = (lot: RawComponentLot): string => {
  return normalizeText(lot.deliveryDate)
    || normalizeText(lot.expectedDeliveryDate)
    || normalizeText(lot.paidDate)
    || normalizeText(lot.updatedAt)
    || normalizeText(lot.createdAt);
};

const buildPriceOptionsByComponent = (
  rawComponentLots: RawComponentLot[]
): Map<string, ManufacturingSchedulingPriceOption[]> => {
  const grouped = new Map<string, Map<string, ManufacturingSchedulingPriceOption>>();

  rawComponentLots.forEach((lot) => {
    const componentId = normalizeText(lot.itemId);
    const unitPrice = toNonNegativeNumber(lot.unit_price);
    if (!componentId || unitPrice <= 0) return;

    const deliveryDate = resolvePriceDate(lot) || '';
    const priceKey = unitPrice.toFixed(4);
    if (!grouped.has(componentId)) grouped.set(componentId, new Map());
    const byPrice = grouped.get(componentId)!;
    const existing = byPrice.get(priceKey);
    if (existing && sortByDateDesc(existing.deliveryDate, deliveryDate) <= 0) return;

    const lotQty = toNonNegativeNumber((lot as any).ordered_qty ?? (lot as any).received_qty);
    const lotUnit = normalizeText(lot.unit) || 'kg';
    byPrice.set(priceKey, {
      key: `${componentId}::${priceKey}`,
      unitPrice,
      deliveryDate,
      supplier: normalizeText(lot.supplier) || 'Unknown supplier',
      lotQty,
      lotUnit,
      label: `${formatBritishDate(deliveryDate, 'Undated')} · ${unitPrice.toFixed(2)} / ${lotUnit}${lotQty > 0 ? ` · Lot ${lotQty}` : ''}`,
    });
  });

  const result = new Map<string, ManufacturingSchedulingPriceOption[]>();
  grouped.forEach((byPrice, componentId) => {
    const options = Array.from(byPrice.values()).sort((left, right) => sortByDateDesc(left.deliveryDate, right.deliveryDate));
    result.set(componentId, options);
  });
  return result;
};

const getStockOnHand = (stockLevels: Record<string, LedgerStockPosition>, itemId: string): number =>
  roundQty(Number(stockLevels[itemId]?.totalOnHand || 0));

const getStockAvailable = (stockLevels: Record<string, LedgerStockPosition>, itemId: string): number =>
  roundQty(Number(stockLevels[itemId]?.totalAvailable || 0));

const resolveRisk = (before: number, after: number, required: number): ManufacturingSchedulingRiskLevel => {
  if (after < 0) return 'HIGH';
  const lowThreshold = Math.max(required, before * 0.1);
  if (required > 0 && after <= lowThreshold) return 'MEDIUM';
  return 'LOW';
};

const getPlanInputMap = (payload: ManufacturingSchedulingPlanPayload) =>
  new Map(payload.product_inputs.map((entry) => [entry.sku_id, entry]));

const getRowMap = (payload: ManufacturingSchedulingPlanPayload) =>
  new Map(payload.schedule_rows.map((entry) => [entry.row_id, entry]));

const getProcurementSettingsMap = (payload: ManufacturingSchedulingPlanPayload) =>
  new Map(payload.procurement_settings.map((entry) => [entry.component_id, entry]));

export const hasManufacturingSchedulingPlanContent = (payload: ManufacturingSchedulingPlanPayload): boolean => {
  const hasTarget = payload.product_inputs.some((entry) => toNonNegativeNumber(entry.horizon_target_qty) > 0);
  const hasSelection = payload.product_inputs.some((entry) => Boolean(entry.is_selected));
  const hasSchedule = payload.schedule_rows.some((row) => row.cells.some((cell) => toNonNegativeNumber(cell.quantity_kg) > 0));
  return hasTarget || hasSelection || hasSchedule;
};

export const calculateManufacturingScheduling = ({
  products,
  inventory,
  categories = [],
  bom,
  rawComponentLots,
  weeks,
  stockLevels,
  safetyStockBySkuId,
  payload,
}: ManufacturingSchedulingCalculationArgs): ManufacturingSchedulingResult => {
  const productsById = new Map(products.map((product) => [product.sku_id, product]));
  const componentsById = new Map(inventory.map((component) => [component.component_id, component]));
  const productInputMap = getPlanInputMap(payload);
  const procurementSettingsMap = getProcurementSettingsMap(payload);
  const priceOptionsByComponent = buildPriceOptionsByComponent(rawComponentLots);

  const priorityRows = products
    .map<ManufacturingSchedulingPriorityRow | null>((product) => {
      const category = resolveManufacturingSchedulingFocusCategory(product);
      if (!category) return null;

      const input = productInputMap.get(product.sku_id);
      const linkedBlendSkuIds = category === 'COMP_A'
        ? []
        : resolveManufacturingSchedulingLinkedSkuIds(bom, product.sku_id);
      const commercialStock = getStockOnHand(stockLevels, product.sku_id);
      const blendedReferenceStock = linkedBlendSkuIds.reduce((sum, skuId) => sum + getStockOnHand(stockLevels, skuId), 0);
      const safetyStockQty = roundQty(Number(safetyStockBySkuId.get(product.sku_id)?.safetyStockRounded || 0));
      const targetQty = toOptionalNonNegativeNumber(input?.horizon_target_qty);
      const priorityGap = roundQty((targetQty || 0) + safetyStockQty - commercialStock);
      return {
        sku_id: product.sku_id,
        sku_name: formatFinishedProductInventoryLabel(product),
        category,
        commercial_stock: commercialStock,
        blended_stock_reference: roundQty(blendedReferenceStock),
        blended_reference_skus: linkedBlendSkuIds,
        horizon_target_qty: targetQty,
        safety_stock_qty: safetyStockQty,
        priority_gap: targetQty !== undefined ? priorityGap : roundQty(safetyStockQty - commercialStock),
        unit: normalizeText(product.default_unit) || 'kg',
        risk_level: safetyStockBySkuId.get(product.sku_id)?.riskLevel || (commercialStock < safetyStockQty ? 'High' : 'Low'),
        is_selected: Boolean(input?.is_selected),
        has_plan_activity: payload.schedule_rows
          .filter((row) => row.parent_sku_id === product.sku_id)
          .some((row) => row.cells.some((cell) => toNonNegativeNumber(cell.quantity_kg) > 0)),
      } satisfies ManufacturingSchedulingPriorityRow;
    })
    .filter((row): row is ManufacturingSchedulingPriorityRow => row !== null)
    .sort((left, right) => {
      if (left.is_selected !== right.is_selected) return left.is_selected ? -1 : 1;
      if (left.priority_gap !== right.priority_gap) return right.priority_gap - left.priority_gap;
      return left.sku_name.localeCompare(right.sku_name);
    });

  const internalBalanceMap = new Map<string, InternalDemandAccumulator>();
  const getInternalAccumulator = (skuId: string) => {
    const normalized = normalizeText(skuId);
    const product = productsById.get(normalized);
    const existing = internalBalanceMap.get(normalized);
    if (existing) return existing;
    const created: InternalDemandAccumulator = {
      sku_id: normalized,
      sku_name: product ? formatFinishedProductInventoryLabel(product) : normalized,
      weekly_supply: {},
      weekly_demand: {},
    };
    internalBalanceMap.set(normalized, created);
    return created;
  };

  const materialDemandMap = new Map<string, MaterialDemandAccumulator>();
  const getMaterialAccumulator = (
    componentId: string,
    materialGroup: ManufacturingSchedulingMaterialGroup,
    fallbackUnit: string
  ) => {
    const normalized = normalizeText(componentId);
    const existing = materialDemandMap.get(normalized);
    if (existing) return existing;
    const component = componentsById.get(normalized);
    const created: MaterialDemandAccumulator = {
      component_id: normalized,
      component_name: component ? formatRawComponentListLabel(component, categories) : normalized,
      material_group: materialGroup,
      unit: normalizeText(component?.default_unit) || fallbackUnit || 'kg',
      weekly_required: {},
    };
    materialDemandMap.set(normalized, created);
    return created;
  };

  const rowMap = getRowMap(payload);
  const selectedProducts = priorityRows.filter((row) => row.is_selected);
  const selectedProductOrder = new Map(selectedProducts.map((row, index) => [row.sku_id, index]));

  payload.schedule_rows.forEach((row) => {
    const normalizedRow = rowMap.get(row.row_id);
    if (!normalizedRow) return;
    normalizedRow.cells.forEach((cell) => {
      const quantityKg = toNonNegativeNumber(cell.quantity_kg);
      if (quantityKg <= 0) return;
      const variantId = normalizeText(cell.bom_variant_id) || getDefaultBomVariantIdForSku(bom, normalizedRow.output_sku_id);
      const bomLines = getBomLinesForSkuVariant(bom, normalizedRow.output_sku_id, variantId);
      const outputBalance = getInternalAccumulator(normalizedRow.output_sku_id);
      outputBalance.weekly_supply[cell.week_start] = roundQty((outputBalance.weekly_supply[cell.week_start] || 0) + quantityKg);

      if (normalizedRow.stage === 'BLEND') {
        bomLines
          .filter((line) => normalizeLineKindForSectioning(line) === 'INGREDIENT')
          .forEach((line) => {
            const requiredQty = roundQty(quantityKg * Number(line.qty_per_kg || 0));
            if (requiredQty <= 0) return;
            const referencedProduct = productsById.get(normalizeText(line.component_id));
            if (referencedProduct) {
              const internalDemand = getInternalAccumulator(referencedProduct.sku_id);
              internalDemand.weekly_demand[cell.week_start] = roundQty((internalDemand.weekly_demand[cell.week_start] || 0) + requiredQty);
              return;
            }
            if (!componentsById.has(normalizeText(line.component_id))) return;
            const material = getMaterialAccumulator(line.component_id, 'INGREDIENT', normalizeText(line.unit) || 'kg');
            material.weekly_required[cell.week_start] = roundQty((material.weekly_required[cell.week_start] || 0) + requiredQty);
          });
      } else {
        bomLines
          .filter((line) => normalizeLineKindForSectioning(line) === 'INGREDIENT')
          .forEach((line) => {
            const requiredQty = roundQty(quantityKg * Number(line.qty_per_kg || 0));
            if (requiredQty <= 0) return;
            const referencedProduct = productsById.get(normalizeText(line.component_id));
            if (!referencedProduct) return;
            const internalDemand = getInternalAccumulator(referencedProduct.sku_id);
            internalDemand.weekly_demand[cell.week_start] = roundQty((internalDemand.weekly_demand[cell.week_start] || 0) + requiredQty);
          });

        bomLines
          .filter((line) => normalizeLineKindForSectioning(line) !== 'INGREDIENT')
          .forEach((line) => {
            const requiredQty = roundQty(quantityKg * Number(line.qty_per_kg || 0));
            if (requiredQty <= 0) return;
            if (!componentsById.has(normalizeText(line.component_id))) return;
            const material = getMaterialAccumulator(line.component_id, 'CONSUMABLE', normalizeText(line.unit) || 'unit');
            material.weekly_required[cell.week_start] = roundQty((material.weekly_required[cell.week_start] || 0) + requiredQty);
          });
      }
    });
  });

  const internalBalanceRows = Array.from(internalBalanceMap.values())
    .map<ManufacturingSchedulingInternalBalanceRow>((row) => {
      let running = getStockOnHand(stockLevels, row.sku_id);
      let lowest = running;
      const cells = weeks.map((week) => {
        const supply = roundQty(Number(row.weekly_supply[week.startDate] || 0));
        const demand = roundQty(Number(row.weekly_demand[week.startDate] || 0));
        const before = running;
        const after = roundQty(before + supply - demand);
        running = after;
        lowest = Math.min(lowest, after);
        return {
          weekStart: week.startDate,
          supply,
          demand,
          before,
          after,
        };
      });
      return {
        sku_id: row.sku_id,
        sku_name: row.sku_name,
        current_stock: getStockOnHand(stockLevels, row.sku_id),
        total_supply: roundQty(cells.reduce((sum, cell) => sum + cell.supply, 0)),
        total_demand: roundQty(cells.reduce((sum, cell) => sum + cell.demand, 0)),
        shortage_qty: lowest < 0 ? roundQty(Math.abs(lowest)) : 0,
        cells,
      };
    })
    .sort((left, right) => {
      if (left.shortage_qty !== right.shortage_qty) return right.shortage_qty - left.shortage_qty;
      return left.sku_name.localeCompare(right.sku_name);
    });

  const internalBalanceBySkuId = new Map(internalBalanceRows.map((row) => [row.sku_id, row]));

  const scheduleBlocks = selectedProducts
    .map<ManufacturingSchedulingScheduleBlock>((priorityRow) => {
      const rows = payload.schedule_rows
        .filter((row) => row.parent_sku_id === priorityRow.sku_id)
        .map<ManufacturingSchedulingScheduleStageRow>((row) => {
          const outputBalance = internalBalanceBySkuId.get(row.output_sku_id);
          const variants = listBomVariantsForSku(bom, row.output_sku_id);
          const cells = weeks.map((week) => {
            const rawCell = row.cells.find((cell) => cell.week_start === week.startDate);
            const defaultVariantId = variants[0]?.bomVariantId || getDefaultBomVariantIdForSku(bom, row.output_sku_id);
            const activeVariantId = normalizeText(rawCell?.bom_variant_id) || defaultVariantId;
            const activeVariantName = variants.find((variant) => variant.bomVariantId === activeVariantId)?.bomVariantName
              || normalizeText(rawCell?.bom_variant_name)
              || normalizeBomVariantName(undefined, activeVariantId);
            const balanceCell = outputBalance?.cells.find((cell) => cell.weekStart === week.startDate);
            return {
              weekStart: week.startDate,
              quantityKg: toNonNegativeNumber(rawCell?.quantity_kg),
              bomVariantId: activeVariantId,
              bomVariantName: activeVariantName,
              beforeStock: balanceCell?.before || getStockOnHand(stockLevels, row.output_sku_id),
              afterStock: balanceCell?.after || getStockOnHand(stockLevels, row.output_sku_id),
            };
          });
          return {
            row_id: row.row_id,
            stage: row.stage,
            output_sku_id: row.output_sku_id,
            output_name: row.output_name || (productsById.get(row.output_sku_id) ? formatFinishedProductInventoryLabel(productsById.get(row.output_sku_id)!) : row.output_sku_id),
            current_stock: getStockOnHand(stockLevels, row.output_sku_id),
            total_planned_kg: roundQty(cells.reduce((sum, cell) => sum + cell.quantityKg, 0)),
            cells,
          };
        });

      const warnings: string[] = [];
      if (priorityRow.category !== 'COMP_A' && rows.every((row) => row.stage !== 'BLEND')) {
        warnings.push('No linked blend route is available yet from recipes for this product.');
      }

      const relatedInternalShortages = rows
        .map((row) => internalBalanceBySkuId.get(row.output_sku_id))
        .filter((row): row is ManufacturingSchedulingInternalBalanceRow => Boolean(row))
        .filter((row) => row.shortage_qty > 0);
      relatedInternalShortages.forEach((row) => {
        warnings.push(`${row.sku_name} is short by ${row.shortage_qty.toFixed(1)} kg across the horizon.`);
      });

      return {
        sku_id: priorityRow.sku_id,
        sku_name: priorityRow.sku_name,
        category: priorityRow.category,
        horizon_target_qty: priorityRow.horizon_target_qty,
        safety_stock_qty: priorityRow.safety_stock_qty,
        commercial_stock: priorityRow.commercial_stock,
        blended_stock_reference: priorityRow.blended_stock_reference,
        blend_reference_skus: priorityRow.blended_reference_skus,
        rows,
        warnings,
      };
    })
    .sort((left, right) => (selectedProductOrder.get(left.sku_id) || 0) - (selectedProductOrder.get(right.sku_id) || 0));

  const materialRows = Array.from(materialDemandMap.values())
    .map<ManufacturingSchedulingMaterialRow>((material) => {
      const onHand = getStockAvailable(stockLevels, material.component_id);
      let running = onHand;
      let lowest = running;
      const cells = weeks.map((week) => {
        const required = roundQty(Number(material.weekly_required[week.startDate] || 0));
        const before = running;
        const after = roundQty(before - required);
        running = after;
        lowest = Math.min(lowest, after);
        return {
          weekStart: week.startDate,
          required,
          before,
          after,
          risk: resolveRisk(before, after, required),
        };
      });

      const shortageQty = lowest < 0 ? roundQty(Math.abs(lowest)) : 0;
      const setting = procurementSettingsMap.get(material.component_id);
      const priceOptions = priceOptionsByComponent.get(material.component_id) || [];
      const selectedOption = priceOptions.find((option) => option.key === setting?.selected_price_key) || priceOptions[0];
      const selectedUnitPrice = selectedOption?.unitPrice
        || toNonNegativeNumber(setting?.manual_unit_price)
        || 0;
      const requiresManualPrice = priceOptions.length === 0;
      const leadTimeWeeks = toNonNegativeNumber(setting?.lead_time_weeks)
        || payload.assumptions.default_procurement_lead_time_weeks
        || MANUFACTURING_SCHEDULING_DEFAULT_LEAD_TIME_WEEKS;
      const firstNegativeCell = cells.find((cell) => cell.after < 0);
      const orderByDate = firstNegativeCell
        ? addDays(firstNegativeCell.weekStart, -7 * leadTimeWeeks)
        : undefined;
      return {
        component_id: material.component_id,
        component_name: material.component_name,
        material_group: material.material_group,
        unit: material.unit,
        on_hand: onHand,
        total_required: roundQty(cells.reduce((sum, cell) => sum + cell.required, 0)),
        shortage_qty: shortageQty,
        remaining_after_plan: roundQty(running),
        selected_unit_price: selectedUnitPrice,
        estimated_spend: shortageQty > 0 && selectedUnitPrice > 0 ? roundQty(shortageQty * selectedUnitPrice) : 0,
        suggested_buy_qty: shortageQty,
        lead_time_weeks: leadTimeWeeks,
        order_by_date: orderByDate,
        order_by_week: firstNegativeCell?.weekStart,
        price_options: priceOptions,
        requires_manual_price: requiresManualPrice,
        cells,
      };
    })
    .sort((left, right) => {
      if (left.shortage_qty !== right.shortage_qty) return right.shortage_qty - left.shortage_qty;
      return left.component_name.localeCompare(right.component_name);
    });

  const shortageRows: ManufacturingSchedulingShortageRow[] = [
    ...internalBalanceRows
      .filter((row) => row.shortage_qty > 0)
      .map((row) => ({
        id: `internal::${row.sku_id}`,
        name: row.sku_name,
        shortage_type: 'INTERNAL' as const,
        unit: 'kg',
        current_qty: row.current_stock,
        required_qty: row.total_demand,
        shortage_qty: row.shortage_qty,
        action: 'Blend more or move linked internal stock into the plan.',
      })),
    ...materialRows
      .filter((row) => row.shortage_qty > 0)
      .map((row) => ({
        id: `material::${row.component_id}`,
        name: row.component_name,
        shortage_type: row.material_group,
        unit: row.unit,
        current_qty: row.on_hand,
        required_qty: row.total_required,
        shortage_qty: row.shortage_qty,
        action: row.requires_manual_price && row.selected_unit_price <= 0
          ? 'Enter a manual unit price, then plan the purchase request.'
          : 'Raise a procurement request before the required week.',
        order_by_date: row.order_by_date,
        estimated_spend: row.estimated_spend || undefined,
      })),
  ].sort((left, right) => {
    if (left.shortage_qty !== right.shortage_qty) return right.shortage_qty - left.shortage_qty;
    return left.name.localeCompare(right.name);
  });

  const ingredientRows = materialRows.filter((row) => row.material_group === 'INGREDIENT');
  const consumableRows = materialRows.filter((row) => row.material_group === 'CONSUMABLE');

  return {
    priorityRows,
    scheduleBlocks,
    materialRows,
    shortageRows,
    internalBalanceRows,
    summary: {
      selected_product_count: selectedProducts.length,
      total_blend_kg: roundQty(payload.schedule_rows
        .filter((row) => row.stage === 'BLEND')
        .reduce((sum, row) => sum + row.cells.reduce((rowSum, cell) => rowSum + toNonNegativeNumber(cell.quantity_kg), 0), 0)),
      total_fill_kg: roundQty(payload.schedule_rows
        .filter((row) => row.stage === 'FILL')
        .reduce((sum, row) => sum + row.cells.reduce((rowSum, cell) => rowSum + toNonNegativeNumber(cell.quantity_kg), 0), 0)),
      ingredient_required: roundQty(ingredientRows.reduce((sum, row) => sum + row.total_required, 0)),
      consumable_required: roundQty(consumableRows.reduce((sum, row) => sum + row.total_required, 0)),
      ingredient_shortage_count: ingredientRows.filter((row) => row.shortage_qty > 0).length,
      consumable_shortage_count: consumableRows.filter((row) => row.shortage_qty > 0).length,
      internal_shortage_count: internalBalanceRows.filter((row) => row.shortage_qty > 0).length,
      total_procurement_spend: roundQty(materialRows.reduce((sum, row) => sum + row.estimated_spend, 0)),
    },
  };
};
