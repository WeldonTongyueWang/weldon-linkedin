import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarRange,
  ChevronDown,
  ChevronRight,
  Clock3,
  Download,
  Loader2,
  Save,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  BOMItem,
  CategoryMaster,
  Component,
  InventoryTransaction,
  Product,
  ProductBatch,
  RawComponentLot,
} from '../../types';
import { computeLedgerStockLevels } from '../../services/ledgerStock';
import { getPlanningReports, savePlanningReport, updatePlanningReport } from '../../services/sheetsApi';
import {
  buildManufacturingSchedulingSnapshotReport,
  buildManufacturingSchedulingWeeks,
  calculateManufacturingScheduling,
  createEmptyManufacturingSchedulingPlan,
  createManufacturingSchedulingRowsForProduct,
  MANUFACTURING_SCHEDULING_DEFAULT_BLEND_CAPACITY_PER_PERSON_WEEK,
  hasManufacturingSchedulingPlanContent,
  MANUFACTURING_SCHEDULING_DEFAULT_BLEND_BATCH_SIZE_KG,
  MANUFACTURING_SCHEDULING_DEFAULT_FILL_CAPACITY_PER_PERSON_WEEK,
  MANUFACTURING_SCHEDULING_HORIZON_WEEKS,
  MANUFACTURING_SCHEDULING_DEFAULT_PRODUCTION_STAFF,
  MANUFACTURING_SCHEDULING_PRODUCT_NAME,
  ManufacturingSchedulingFocusCategory,
  ManufacturingSchedulingMaterialRow,
  ManufacturingSchedulingPlanPayload,
  ManufacturingSchedulingPlanRecord,
  ManufacturingSchedulingPlanSummary,
  ManufacturingSchedulingPlanRow,
  ManufacturingSchedulingPriorityRow,
  parseManufacturingSchedulingPlanRecord,
  rebaseManufacturingSchedulingPlan,
  resolveManufacturingSchedulingFocusCategory,
} from '../../services/manufacturingScheduling';
import { PRODUCT_CATEGORY_ORDER, resolveProductCategoryGroup } from '../../services/productCategoryGrouping';
import { buildSafetyStockModel } from '../../services/safetyStock';
import { listBomVariantsForSku } from '../../services/bomVariants';
import { useAppDialog } from '../ui/AppDialogProvider';
import { useIsHandheldDevice } from '../../lib/useIsHandheldDevice';
import { isMutationGuardBlockedError } from '../../services/liveDataSync';
import { formatFinishedProductInventoryLabel } from '../../utils/finishedProductLabels';

interface Props {
  currentUser: string;
  products: Product[];
  inventory: Component[];
  categories?: CategoryMaster[];
  bom: BOMItem[];
  transactions: InventoryTransaction[];
  rawComponentLots: RawComponentLot[];
  productBatches?: ProductBatch[];
  isReadOnly?: boolean;
}

interface PriorityDisplayGroup {
  categoryLabel: string;
  rows: ManufacturingSchedulingPriorityRow[];
}

const quantityFormatter = new Intl.NumberFormat('en-GB', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const currencyFormatter = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'GBP',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const weekFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
});

const snapshotFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const CATEGORY_LABELS: Record<ManufacturingSchedulingFocusCategory, string> = {
  COMMERCIAL_PRODUCT: 'Commercial Product',
  COMP_A: 'Comp A',
  SAMPLE: 'Sample',
  COMMERCIAL_DISPENSING: 'Commercial Dispensing',
};

const PRODUCT_CATEGORY_ORDER_INDEX = new Map<string, number>(
  PRODUCT_CATEGORY_ORDER.map((label, index) => [label, index])
);

const STAGE_LABELS = {
  BLEND: 'Blend',
  FILL: 'Fill',
} as const;

const STAGE_TONES = {
  BLEND: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  FILL: 'bg-indigo-50 text-indigo-700 border-indigo-100',
} as const;

const RISK_TONES = {
  Low: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  Medium: 'bg-amber-50 text-amber-700 border-amber-100',
  High: 'bg-rose-50 text-rose-700 border-rose-100',
} as const;

const formatQuantity = (value: number): string => quantityFormatter.format(Number(value || 0));

const formatCurrency = (value: number): string => currencyFormatter.format(Number(value || 0));

const parseLocalDate = (value: string): Date | null => {
  const dateOnlyMatch = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    const parsedDateOnly = new Date(Number(year), Number(month) - 1, Number(day));
    return Number.isNaN(parsedDateOnly.getTime()) ? null : parsedDateOnly;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const formatDateLabel = (value: string): string => {
  const parsed = parseLocalDate(value);
  if (!parsed) return value;
  return weekFormatter.format(parsed);
};

const formatSnapshotLabel = (value?: string): string => {
  const parsed = value ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) return 'Unknown time';
  return snapshotFormatter.format(parsed);
};

const readErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  return 'Unexpected error.';
};

const normalizeText = (value: unknown): string => String(value ?? '').trim().toLowerCase();

const isBlendedProduct = (product: Product): boolean => {
  const category = normalizeText(product.category);
  const format = normalizeText(product.format);
  return category.includes('blended') || category.includes('06') || format.includes('blended');
};

const buildPlanSummary = (
  payload: ManufacturingSchedulingPlanPayload,
  calculation: ReturnType<typeof calculateManufacturingScheduling>
): ManufacturingSchedulingPlanPayload => ({
  ...payload,
  summary: {
    selected_product_count: calculation.summary.selected_product_count,
    total_blend_kg: calculation.summary.total_blend_kg,
    total_fill_kg: calculation.summary.total_fill_kg,
    shortage_count:
      calculation.summary.ingredient_shortage_count
      + calculation.summary.consumable_shortage_count
      + calculation.summary.internal_shortage_count,
    procurement_spend: calculation.summary.total_procurement_spend,
  } satisfies ManufacturingSchedulingPlanSummary,
});

const buildPrintHtml = (
  payload: ManufacturingSchedulingPlanPayload,
  calculation: ReturnType<typeof calculateManufacturingScheduling>,
  weeks: ReturnType<typeof buildManufacturingSchedulingWeeks>
): string => {
  const selectedBlocks = calculation.scheduleBlocks
    .map((block) => {
      const weekCells = block.rows
        .map((row) => `
          <tr>
            <td>${STAGE_LABELS[row.stage]}</td>
            <td>${row.output_name}</td>
            <td>${formatQuantity(row.total_planned_kg)}</td>
            ${row.cells.map((cell) => `<td>${cell.quantityKg > 0 ? formatQuantity(cell.quantityKg) : ''}</td>`).join('')}
          </tr>
        `)
        .join('');
      return `
        <div class="product-block">
          <h3>${block.sku_name}</h3>
          <div class="meta">Target ${formatQuantity(block.horizon_target_qty || 0)} · Safety ${formatQuantity(block.safety_stock_qty)} · Commercial stock ${formatQuantity(block.commercial_stock)}</div>
          <table>
            <thead>
              <tr>
                <th>Stage</th>
                <th>Output</th>
                <th>Total kg</th>
                ${weeks.map((week) => `<th>${formatDateLabel(week.startDate)}</th>`).join('')}
              </tr>
            </thead>
            <tbody>${weekCells}</tbody>
          </table>
        </div>
      `;
    })
    .join('');

  const shortageRows = calculation.shortageRows
    .map((row) => `
      <tr>
        <td>${row.name}</td>
        <td>${row.shortage_type}</td>
        <td>${formatQuantity(row.shortage_qty)} ${row.unit}</td>
        <td>${row.order_by_date || '—'}</td>
        <td>${row.estimated_spend ? formatCurrency(row.estimated_spend) : '—'}</td>
      </tr>
    `)
    .join('');

  return `
    <html>
      <head>
        <title>${payload.plan_name}</title>
        <style>
          body { font-family: Arial, sans-serif; color: #0f172a; padding: 24px; }
          h1, h2, h3 { margin: 0 0 8px; }
          .meta { color: #475569; margin-bottom: 12px; }
          .summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 16px 0 24px; }
          .card { border: 1px solid #cbd5e1; border-radius: 12px; padding: 12px; }
          .card-label { font-size: 11px; text-transform: uppercase; color: #64748b; }
          .card-value { font-size: 22px; font-weight: 700; margin-top: 4px; }
          table { width: 100%; border-collapse: collapse; margin: 12px 0 24px; }
          th, td { border: 1px solid #cbd5e1; padding: 8px; text-align: left; font-size: 12px; }
          th { background: #f8fafc; }
          .product-block { margin-bottom: 24px; }
        </style>
      </head>
      <body>
        <h1>${payload.plan_name}</h1>
        <div class="meta">Saved plan export · ${formatSnapshotLabel(payload.updated_at || payload.saved_at)}</div>
        <div class="summary">
          <div class="card"><div class="card-label">Selected products</div><div class="card-value">${calculation.summary.selected_product_count}</div></div>
          <div class="card"><div class="card-label">Blend planned</div><div class="card-value">${formatQuantity(calculation.summary.total_blend_kg)}</div></div>
          <div class="card"><div class="card-label">Fill planned</div><div class="card-value">${formatQuantity(calculation.summary.total_fill_kg)}</div></div>
          <div class="card"><div class="card-label">Procurement spend</div><div class="card-value">${formatCurrency(calculation.summary.total_procurement_spend)}</div></div>
        </div>
        <h2>Weekly master schedule</h2>
        ${selectedBlocks || '<p>No products selected.</p>'}
        <h2>Shortages and procurement request</h2>
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Type</th>
              <th>Shortage</th>
              <th>Order by</th>
              <th>Estimated spend</th>
            </tr>
          </thead>
          <tbody>${shortageRows || '<tr><td colspan="5">No projected shortages.</td></tr>'}</tbody>
        </table>
      </body>
    </html>
  `;
};

const MaterialImpactTable: React.FC<{
  title: string;
  description: string;
  rows: ManufacturingSchedulingMaterialRow[];
  onLeadTimeChange: (componentId: string, nextValue: string) => void;
}> = ({ title, description, rows, onLeadTimeChange }) => {
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white">
        <div className="px-5 py-4 border-b border-slate-200">
          <h4 className="text-base font-black text-slate-900">{title}</h4>
          <p className="text-sm text-slate-500">{description}</p>
        </div>
        <div className="h-32 flex items-center justify-center text-slate-400 px-5">No rows in this section for the current plan.</div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-200">
        <h4 className="text-base font-black text-slate-900">{title}</h4>
        <p className="text-sm text-slate-500">{description}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-[920px] w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <th className="px-4 py-3 text-left text-[10px] font-black uppercase tracking-widest text-slate-500">Material</th>
              <th className="px-4 py-3 text-right text-[10px] font-black uppercase tracking-widest text-slate-500">On hand</th>
              <th className="px-4 py-3 text-right text-[10px] font-black uppercase tracking-widest text-slate-500">Required</th>
              <th className="px-4 py-3 text-right text-[10px] font-black uppercase tracking-widest text-slate-500">Remaining</th>
              <th className="px-4 py-3 text-right text-[10px] font-black uppercase tracking-widest text-slate-500">Shortage</th>
              <th className="px-4 py-3 text-right text-[10px] font-black uppercase tracking-widest text-slate-500">Lead time (weeks)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <tr key={row.component_id} className="hover:bg-slate-50">
                <td className="px-4 py-3">
                  <div className="font-bold text-slate-900">{row.component_name}</div>
                  <div className="text-xs text-slate-500">{row.component_id} • {row.unit}</div>
                </td>
                <td className="px-4 py-3 text-right font-mono text-slate-700">{formatQuantity(row.on_hand)}</td>
                <td className="px-4 py-3 text-right font-mono text-slate-700">{formatQuantity(row.total_required)}</td>
                <td className={`px-4 py-3 text-right font-mono ${row.remaining_after_plan < 0 ? 'text-rose-700 font-bold' : 'text-slate-700'}`}>
                  {formatQuantity(row.remaining_after_plan)}
                </td>
                <td className={`px-4 py-3 text-right font-mono ${row.shortage_qty > 0 ? 'text-rose-700 font-bold' : 'text-slate-700'}`}>
                  {formatQuantity(row.shortage_qty)}
                </td>
                <td className="px-4 py-3 text-right">
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={row.lead_time_weeks}
                    onChange={(event) => onLeadTimeChange(row.component_id, event.target.value)}
                    className="w-20 rounded-lg border border-slate-300 bg-white px-2 py-2 text-right text-sm font-bold text-slate-700"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export const ManufacturingSchedulingTool: React.FC<Props> = ({
  currentUser,
  products,
  inventory,
  categories = [],
  bom,
  transactions,
  rawComponentLots,
  productBatches = [],
  isReadOnly,
}) => {
  const isHandheldDevice = useIsHandheldDevice();
  const appDialog = useAppDialog();
  const weeks = useMemo(
    () => buildManufacturingSchedulingWeeks(new Date(), MANUFACTURING_SCHEDULING_HORIZON_WEEKS),
    []
  );

  const [workingReport, setWorkingReport] = useState<ManufacturingSchedulingPlanRecord | null>(null);
  const [draftPayload, setDraftPayload] = useState<ManufacturingSchedulingPlanPayload>(() => createEmptyManufacturingSchedulingPlan(weeks, MANUFACTURING_SCHEDULING_PRODUCT_NAME));
  const [snapshotRecords, setSnapshotRecords] = useState<ManufacturingSchedulingPlanRecord[]>([]);
  const [pickerSkuId, setPickerSkuId] = useState('');
  const [loadedFromSnapshotId, setLoadedFromSnapshotId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSavingWorking, setIsSavingWorking] = useState(false);
  const [recordActionId, setRecordActionId] = useState<string | null>(null);
  const [collapsedPriorityGroups, setCollapsedPriorityGroups] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(PRODUCT_CATEGORY_ORDER.map((category) => [category, true]))
  );
  const [blendedReferenceExpanded, setBlendedReferenceExpanded] = useState(false);

  const stockLevels = useMemo(
    () => computeLedgerStockLevels(transactions, rawComponentLots, productBatches),
    [transactions, rawComponentLots, productBatches]
  );

  const productsById = useMemo(() => new Map(products.map((product) => [product.sku_id, product])), [products]);

  const safetyStockModel = useMemo(
    () =>
      buildSafetyStockModel(transactions, products, {
        lookbackWeeks: 12,
        serviceFactor: 2.05,
        defaultLeadTimeWeeks: 6,
      }),
    [transactions, products]
  );

  const safetyStockBySkuId = useMemo(
    () => new Map(safetyStockModel.rows.map((row) => [row.productId, row])),
    [safetyStockModel.rows]
  );

  const calculation = useMemo(
    () =>
      calculateManufacturingScheduling({
        products,
        inventory,
        categories,
        bom,
        rawComponentLots,
        weeks,
        stockLevels,
        safetyStockBySkuId,
        payload: draftPayload,
      }),
    [products, inventory, categories, bom, rawComponentLots, weeks, stockLevels, safetyStockBySkuId, draftPayload]
  );

  const payloadForSave = useMemo(
    () => buildPlanSummary(draftPayload, calculation),
    [draftPayload, calculation]
  );

  const resolvePriorityDisplayCategory = (row: ManufacturingSchedulingPriorityRow): string => {
    const product = productsById.get(row.sku_id);
    if (!product) return CATEGORY_LABELS[row.category];
    return resolveProductCategoryGroup(product);
  };

  const priorityGroups = useMemo(
    () => {
      const grouped = new Map<string, ManufacturingSchedulingPriorityRow[]>();

      calculation.priorityRows.forEach((row) => {
        const categoryLabel = resolvePriorityDisplayCategory(row);
        if (!grouped.has(categoryLabel)) grouped.set(categoryLabel, []);
        grouped.get(categoryLabel)!.push(row);
      });

      return Array.from(grouped.entries())
        .map<PriorityDisplayGroup>(([categoryLabel, rows]) => ({
          categoryLabel,
          rows: [...rows].sort((left, right) => left.sku_name.localeCompare(right.sku_name)),
        }))
        .sort((left, right) => {
          const leftIndex = PRODUCT_CATEGORY_ORDER_INDEX.get(left.categoryLabel);
          const rightIndex = PRODUCT_CATEGORY_ORDER_INDEX.get(right.categoryLabel);
          if (leftIndex !== undefined || rightIndex !== undefined) {
            if (leftIndex === undefined) return 1;
            if (rightIndex === undefined) return -1;
            if (leftIndex !== rightIndex) return leftIndex - rightIndex;
          }
          return left.categoryLabel.localeCompare(right.categoryLabel);
        });
    },
    [calculation.priorityRows, productsById]
  );

  const blendedReferenceRows = useMemo(
    () =>
      products
        .filter((product) => isBlendedProduct(product))
        .map((product) => ({
          sku_id: product.sku_id,
          sku_name: formatFinishedProductInventoryLabel(product),
          commercial_stock: Number(stockLevels[product.sku_id]?.totalOnHand || 0),
          horizon_target_qty: draftPayload.product_inputs.find((entry) => entry.sku_id === product.sku_id)?.horizon_target_qty,
          safety_stock_qty: Number(safetyStockBySkuId.get(product.sku_id)?.safetyStockRounded || 0),
          priority_gap: Math.max(
            0,
            Number(draftPayload.product_inputs.find((entry) => entry.sku_id === product.sku_id)?.horizon_target_qty || 0)
              + Number(safetyStockBySkuId.get(product.sku_id)?.safetyStockRounded || 0)
              - Number(stockLevels[product.sku_id]?.totalOnHand || 0)
          ),
          risk_level:
            safetyStockBySkuId.get(product.sku_id)?.riskLevel
            || (Number(stockLevels[product.sku_id]?.totalOnHand || 0) < Number(safetyStockBySkuId.get(product.sku_id)?.safetyStockRounded || 0) ? 'High' : 'Low'),
          has_plan_activity: draftPayload.schedule_rows
            .filter((row) => row.parent_sku_id === product.sku_id)
            .some((row) => row.cells.some((cell) => Number(cell.quantity_kg || 0) > 0)),
          unit: product.default_unit || 'kg',
        }))
        .sort((left, right) => left.sku_name.localeCompare(right.sku_name)),
    [products, stockLevels, safetyStockBySkuId, draftPayload.product_inputs, draftPayload.schedule_rows]
  );

  const quickAddGroups = useMemo(
    () =>
      priorityGroups
        .map((group) => ({
          categoryLabel: group.categoryLabel,
          rows: group.rows.filter((row) => !row.is_selected),
        }))
        .filter((group) => group.rows.length > 0),
    [priorityGroups]
  );

  const selectorGroups = useMemo(
    () => {
      const groupByLabel = new Map(priorityGroups.map((group) => [group.categoryLabel, group]));
      const orderedLabels: string[] = PRODUCT_CATEGORY_ORDER.filter((categoryLabel) =>
        categoryLabel === 'Blended'
          ? blendedReferenceRows.length > 0
          : groupByLabel.has(categoryLabel)
      );
      const remainingLabels = Array.from(groupByLabel.keys())
        .filter((categoryLabel) => !orderedLabels.includes(categoryLabel))
        .sort((left, right) => left.localeCompare(right));

      return [...orderedLabels, ...remainingLabels].map((categoryLabel) => ({
        categoryLabel,
        rows: groupByLabel.get(categoryLabel)?.rows ?? [],
      }));
    },
    [priorityGroups, blendedReferenceRows]
  );

  const variantOptionsBySku = useMemo(() => {
    const skuIds = Array.from(new Set(draftPayload.schedule_rows.map((row) => row.output_sku_id)));
    return new Map(
      skuIds.map((skuId) => [skuId, listBomVariantsForSku(bom, skuId)])
    );
  }, [bom, draftPayload.schedule_rows]);

  const normalizeDraft = (next: ManufacturingSchedulingPlanPayload) =>
    rebaseManufacturingSchedulingPlan(next, weeks, bom);

  const updateDraft = (updater: (current: ManufacturingSchedulingPlanPayload) => ManufacturingSchedulingPlanPayload) => {
    setDraftPayload((current) => normalizeDraft(updater(current)));
  };

  const loadPlanRecords = async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const reports = await getPlanningReports();
      const parsed = reports
        .map((report) => parseManufacturingSchedulingPlanRecord(report, weeks, bom))
        .filter((report): report is ManufacturingSchedulingPlanRecord => Boolean(report));

      const working = parsed.find((record) => record.record_kind === 'WORKING_PLAN' && record.status !== 'DELETED') || null;
      const snapshots = parsed
        .filter((record) => record.record_kind === 'SNAPSHOT' && record.status !== 'DELETED')
        .sort((left, right) => {
          const leftTime = new Date(left.payload.saved_at || left.created_at).getTime();
          const rightTime = new Date(right.payload.saved_at || right.created_at).getTime();
          return rightTime - leftTime;
        });

      const latestPlan = snapshots[0] || working;
      setWorkingReport(latestPlan);
      setSnapshotRecords(snapshots);
      setDraftPayload(latestPlan ? normalizeDraft(latestPlan.payload) : createEmptyManufacturingSchedulingPlan(weeks, MANUFACTURING_SCHEDULING_PRODUCT_NAME));
      setLoadedFromSnapshotId(null);
    } catch (error) {
      console.error('Failed to load manufacturing scheduling plans:', error);
      setLoadError(readErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadPlanRecords();
  }, []);

  const upsertProductInput = (
    current: ManufacturingSchedulingPlanPayload,
    skuId: string,
    updater: (existing?: ManufacturingSchedulingPlanPayload['product_inputs'][number]) => ManufacturingSchedulingPlanPayload['product_inputs'][number] | null
  ) => {
    const nextInputs = [...current.product_inputs];
    const existingIndex = nextInputs.findIndex((entry) => entry.sku_id === skuId);
    const existing = existingIndex >= 0 ? nextInputs[existingIndex] : undefined;
    const nextEntry = updater(existing);
    if (!nextEntry) {
      if (existingIndex >= 0) nextInputs.splice(existingIndex, 1);
      return nextInputs;
    }
    if (existingIndex >= 0) nextInputs[existingIndex] = nextEntry;
    else nextInputs.push(nextEntry);
    return nextInputs;
  };

  const ensureRowsForProduct = (current: ManufacturingSchedulingPlanPayload, product: Product) => {
    const existingIds = new Set(current.schedule_rows.filter((row) => row.parent_sku_id === product.sku_id).map((row) => row.row_id));
    const nextRows = createManufacturingSchedulingRowsForProduct(product, bom, weeks, productsById)
      .filter((row) => !existingIds.has(row.row_id));
    if (nextRows.length === 0) return current;
    return {
      ...current,
      schedule_rows: [...current.schedule_rows, ...nextRows],
    };
  };

  const handleTargetChange = (skuId: string, nextValue: string) => {
    const product = productsById.get(skuId);
    updateDraft((current) => ({
      ...current,
      product_inputs: upsertProductInput(current, skuId, (existing) => {
        const numeric = nextValue === '' ? undefined : Number(nextValue);
        const horizonTarget = Number.isFinite(numeric as number) && Number(numeric) >= 0 ? Number(numeric) : undefined;
        if (!existing?.is_selected && horizonTarget === undefined) return null;
        return {
          sku_id: skuId,
          sku_name: product ? formatFinishedProductInventoryLabel(product) : existing?.sku_name,
          horizon_target_qty: horizonTarget,
          is_selected: existing?.is_selected || false,
        };
      }),
    }));
  };

  const handleSelectProduct = (skuId: string) => {
    const product = productsById.get(skuId);
    if (!product) return;
    updateDraft((current) => {
      const withInput = {
        ...current,
        product_inputs: upsertProductInput(current, skuId, (existing) => ({
          sku_id: skuId,
          sku_name: formatFinishedProductInventoryLabel(product),
          horizon_target_qty: existing?.horizon_target_qty,
          is_selected: true,
        })),
      };
      return ensureRowsForProduct(withInput, product);
    });
  };

  const handleRemoveProduct = async (skuId: string) => {
    const rowsWithPlan = draftPayload.schedule_rows
      .filter((row) => row.parent_sku_id === skuId)
      .some((row) => row.cells.some((cell) => Number(cell.quantity_kg || 0) > 0));
    if (rowsWithPlan) {
      const confirmed = await appDialog.confirm({
        title: 'Remove Product From Plan?',
        message: 'Removing this product clears its current blend / fill schedule from the plan.',
        tone: 'warning',
        confirmLabel: 'Remove product',
      });
      if (!confirmed) return;
    }

    updateDraft((current) => ({
      ...current,
      product_inputs: upsertProductInput(current, skuId, (existing) => {
        if (!existing?.horizon_target_qty) return null;
        return {
          ...existing,
          is_selected: false,
        };
      }),
      schedule_rows: current.schedule_rows.filter((row) => row.parent_sku_id !== skuId),
    }));
  };

  const handleQuickAdd = () => {
    if (!pickerSkuId) return;
    handleSelectProduct(pickerSkuId);
    setPickerSkuId('');
  };

  const handleSelectGapProducts = () => {
    calculation.priorityRows
      .filter((row) => row.priority_gap > 0 && !row.is_selected)
      .forEach((row) => handleSelectProduct(row.sku_id));
  };

  const handleSelectAllPriorityProducts = () => {
    calculation.priorityRows
      .filter((row) => !row.is_selected)
      .forEach((row) => handleSelectProduct(row.sku_id));
  };

  const handleClearSelection = async () => {
    const hasPlannedRows = draftPayload.schedule_rows.some((row) => row.cells.some((cell) => Number(cell.quantity_kg || 0) > 0));
    if (hasPlannedRows) {
      const confirmed = await appDialog.confirm({
        title: 'Clear Selected Products?',
        message: 'This removes all selected products and their current weekly schedule from the plan.',
        tone: 'warning',
        confirmLabel: 'Clear selection',
      });
      if (!confirmed) return;
    }
    updateDraft((current) => ({
      ...current,
      product_inputs: current.product_inputs
        .map((entry) => ({
          ...entry,
          is_selected: false,
        }))
        .filter((entry) => entry.horizon_target_qty !== undefined),
      schedule_rows: [],
    }));
  };

  const handleCellQuantityChange = (rowId: string, weekStart: string, nextValue: string) => {
    updateDraft((current) => ({
      ...current,
      schedule_rows: current.schedule_rows.map((row) => {
        if (row.row_id !== rowId) return row;
        return {
          ...row,
          cells: row.cells.map((cell) => {
            if (cell.week_start !== weekStart) return cell;
            const numeric = nextValue === '' ? undefined : Number(nextValue);
            return {
              ...cell,
              quantity_kg: Number.isFinite(numeric as number) && Number(numeric) >= 0 ? Number(numeric) : undefined,
            };
          }),
        };
      }),
    }));
  };

  const handleCellVariantChange = (rowId: string, weekStart: string, variantId: string) => {
    const row = draftPayload.schedule_rows.find((entry) => entry.row_id === rowId);
    if (!row) return;
    const variantName = variantOptionsBySku.get(row.output_sku_id)?.find((option) => option.bomVariantId === variantId)?.bomVariantName || variantId;
    updateDraft((current) => ({
      ...current,
      schedule_rows: current.schedule_rows.map((entry) => {
        if (entry.row_id !== rowId) return entry;
        return {
          ...entry,
          cells: entry.cells.map((cell) => {
            if (cell.week_start !== weekStart) return cell;
            return {
              ...cell,
              bom_variant_id: variantId,
              bom_variant_name: variantName,
            };
          }),
        };
      }),
    }));
  };

  const handleLeadTimeChange = (componentId: string, nextValue: string) => {
    updateDraft((current) => {
      const nextSettings = [...current.procurement_settings];
      const existingIndex = nextSettings.findIndex((entry) => entry.component_id === componentId);
      const existing = existingIndex >= 0 ? nextSettings[existingIndex] : undefined;
      const numeric = nextValue === '' ? undefined : Number(nextValue);
      const nextEntry = {
        component_id: componentId,
        selected_price_key: existing?.selected_price_key,
        manual_unit_price: existing?.manual_unit_price,
        lead_time_weeks: Number.isFinite(numeric as number) && Number(numeric) > 0 ? Number(numeric) : undefined,
      };
      if (existingIndex >= 0) nextSettings[existingIndex] = nextEntry;
      else nextSettings.push(nextEntry);
      return {
        ...current,
        procurement_settings: nextSettings,
      };
    });
  };

  const handlePriceSelectionChange = (componentId: string, nextValue: string) => {
    updateDraft((current) => {
      const nextSettings = [...current.procurement_settings];
      const existingIndex = nextSettings.findIndex((entry) => entry.component_id === componentId);
      const existing = existingIndex >= 0 ? nextSettings[existingIndex] : undefined;
      const nextEntry = {
        component_id: componentId,
        selected_price_key: nextValue || undefined,
        manual_unit_price: existing?.manual_unit_price,
        lead_time_weeks: existing?.lead_time_weeks,
      };
      if (existingIndex >= 0) nextSettings[existingIndex] = nextEntry;
      else nextSettings.push(nextEntry);
      return {
        ...current,
        procurement_settings: nextSettings,
      };
    });
  };

  const handleManualUnitPriceChange = (componentId: string, nextValue: string) => {
    updateDraft((current) => {
      const nextSettings = [...current.procurement_settings];
      const existingIndex = nextSettings.findIndex((entry) => entry.component_id === componentId);
      const existing = existingIndex >= 0 ? nextSettings[existingIndex] : undefined;
      const numeric = nextValue === '' ? undefined : Number(nextValue);
      const nextEntry = {
        component_id: componentId,
        selected_price_key: existing?.selected_price_key,
        manual_unit_price: Number.isFinite(numeric as number) && Number(numeric) >= 0 ? Number(numeric) : undefined,
        lead_time_weeks: existing?.lead_time_weeks,
      };
      if (existingIndex >= 0) nextSettings[existingIndex] = nextEntry;
      else nextSettings.push(nextEntry);
      return {
        ...current,
        procurement_settings: nextSettings,
      };
    });
  };

  const handleAssumptionChange = (
    field: 'production_staff_count' | 'blend_capacity_kg_per_person_week' | 'fill_capacity_kg_per_person_week',
    nextValue: string
  ) => {
    updateDraft((current) => {
      const numeric = nextValue === '' ? undefined : Number(nextValue);
      const nextNumeric = Number.isFinite(numeric as number) && Number(numeric) >= 0 ? Number(numeric) : undefined;
      return {
        ...current,
        assumptions: {
          ...current.assumptions,
          [field]:
            nextNumeric
            ?? (field === 'production_staff_count'
              ? MANUFACTURING_SCHEDULING_DEFAULT_PRODUCTION_STAFF
              : field === 'blend_capacity_kg_per_person_week'
                ? MANUFACTURING_SCHEDULING_DEFAULT_BLEND_CAPACITY_PER_PERSON_WEEK
                : MANUFACTURING_SCHEDULING_DEFAULT_FILL_CAPACITY_PER_PERSON_WEEK),
        },
      };
    });
  };

  const handleSaveWorkingPlan = async () => {
    if (isReadOnly || isSavingWorking) return;
    const planTitle = await appDialog.prompt({
      title: 'Save Plan',
      message: 'Enter a title for this plan.',
      inputLabel: 'Plan title',
      defaultValue: draftPayload.plan_name || workingReport?.product_name || MANUFACTURING_SCHEDULING_PRODUCT_NAME,
      placeholder: 'Manufacturing Scheduling',
      confirmLabel: 'Save plan',
      required: true,
    });
    if (planTitle === null) return;
    const nextPlanName = planTitle.trim();
    if (!nextPlanName) return;

    setIsSavingWorking(true);
    try {
      const nextPayload = buildPlanSummary(
        normalizeDraft({
          ...draftPayload,
          plan_name: nextPlanName,
        }),
        calculation
      );
      setDraftPayload(nextPayload);

      const historyReport = buildManufacturingSchedulingSnapshotReport(nextPayload, currentUser);
      await savePlanningReport(historyReport);
      const savedRecord = parseManufacturingSchedulingPlanRecord(historyReport, weeks, bom);
      if (savedRecord) {
        setWorkingReport(savedRecord);
        setSnapshotRecords((current) => [savedRecord, ...current].sort((left, right) => {
          const leftTime = new Date(left.payload.saved_at || left.created_at).getTime();
          const rightTime = new Date(right.payload.saved_at || right.created_at).getTime();
          return rightTime - leftTime;
        }));
        setDraftPayload(normalizeDraft(savedRecord.payload));
        setLoadedFromSnapshotId(savedRecord.report_id);
      }
      await appDialog.alert({ message: 'Plan saved in this browser.', tone: 'success' });
    } catch (error) {
      if (isMutationGuardBlockedError(error)) return;
      console.error('Failed to save manufacturing plan:', error);
      await appDialog.alert({ message: `Failed to save plan. ${readErrorMessage(error)}`, tone: 'danger' });
    } finally {
      setIsSavingWorking(false);
    }
  };

  const handleLoadSnapshot = async (snapshot: ManufacturingSchedulingPlanRecord) => {
    const confirmed = await appDialog.confirm({
      title: 'Open Saved Plan?',
      message: 'This replaces the current screen state with the selected saved plan.',
      tone: 'warning',
      confirmLabel: 'Open plan',
    });
    if (!confirmed) return;

    setDraftPayload(normalizeDraft({
      ...snapshot.payload,
      record_kind: 'WORKING_PLAN',
      status: 'ACTIVE',
      source_snapshot_id: snapshot.report_id,
    }));
    setLoadedFromSnapshotId(snapshot.report_id);
  };

  const handleDeleteSnapshot = async (snapshot: ManufacturingSchedulingPlanRecord) => {
    if (recordActionId || isReadOnly) return;
    const confirmed = await appDialog.confirm({
      title: 'Delete Snapshot?',
      message: 'This hides the saved plan while retaining its local audit record. It will no longer appear in the app.',
      tone: 'warning',
      confirmLabel: 'Delete snapshot',
    });
    if (!confirmed) return;

    setRecordActionId(snapshot.report_id);
    try {
      const timestamp = new Date().toISOString();
      const nextPayload = {
        ...snapshot.payload,
        status: 'DELETED' as const,
        deleted_at: timestamp,
        deleted_by: currentUser,
      };
      await updatePlanningReport(snapshot.report_id, {
        breakdown_json: JSON.stringify(nextPayload),
      });
      await loadPlanRecords();
      await appDialog.alert({ message: 'Saved plan deleted from the active list.', tone: 'success' });
    } catch (error) {
      if (isMutationGuardBlockedError(error)) return;
      console.error('Failed to delete manufacturing snapshot:', error);
      await appDialog.alert({ message: `Failed to delete saved plan. ${readErrorMessage(error)}`, tone: 'danger' });
    } finally {
      setRecordActionId(null);
    }
  };

  const handleDownloadPdf = () => {
    if (typeof window === 'undefined') return;
    const printWindow = window.open('', '_blank', 'noopener,noreferrer,width=1200,height=900');
    if (!printWindow) return;
    printWindow.document.write(buildPrintHtml(payloadForSave, calculation, weeks));
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  };

  const handleDownloadSavedPlan = (snapshot: ManufacturingSchedulingPlanRecord) => {
    if (typeof window === 'undefined') return;
    const planPayload = normalizeDraft(snapshot.payload);
    const planCalculation = calculateManufacturingScheduling({
      products,
      inventory,
      categories,
      bom,
      rawComponentLots,
      weeks,
      stockLevels,
      safetyStockBySkuId,
      payload: planPayload,
    });
    const printWindow = window.open('', '_blank', 'noopener,noreferrer,width=1200,height=900');
    if (!printWindow) return;
    printWindow.document.write(buildPrintHtml(planPayload, planCalculation, weeks));
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  };

  const validationMessages = useMemo(() => {
    const messages: string[] = [];
    if (calculation.scheduleBlocks.length === 0) {
      messages.push('Select one or more products to build the plan.');
    }
    const materialsMissingPrice = calculation.materialRows.filter((row) => row.shortage_qty > 0 && row.requires_manual_price && row.selected_unit_price <= 0);
    if (materialsMissingPrice.length > 0) {
      messages.push(`Enter manual unit prices for: ${materialsMissingPrice.map((row) => row.component_name).join(', ')}.`);
    }
    return messages;
  }, [calculation.materialRows, calculation.scheduleBlocks.length]);

  const currentSnapshotName = loadedFromSnapshotId
    ? snapshotRecords.find((snapshot) => snapshot.report_id === loadedFromSnapshotId)?.product_name
    : null;
  const recentSnapshotOptions = useMemo(() => snapshotRecords.slice(0, 5), [snapshotRecords]);
  const capacitySummary = useMemo(() => {
    const weeklyBlend = new Map<string, number>();
    const weeklyFill = new Map<string, number>();
    draftPayload.schedule_rows.forEach((row) => {
      row.cells.forEach((cell) => {
        const qty = Number(cell.quantity_kg || 0);
        if (qty <= 0) return;
        if (row.stage === 'BLEND') {
          weeklyBlend.set(cell.week_start, (weeklyBlend.get(cell.week_start) || 0) + qty);
        } else {
          weeklyFill.set(cell.week_start, (weeklyFill.get(cell.week_start) || 0) + qty);
        }
      });
    });
    const maxBlendLoad = Math.max(0, ...Array.from(weeklyBlend.values()));
    const maxFillLoad = Math.max(0, ...Array.from(weeklyFill.values()));
    const staffCount = Number(draftPayload.assumptions.production_staff_count || MANUFACTURING_SCHEDULING_DEFAULT_PRODUCTION_STAFF);
    const blendCapacity = Number(draftPayload.assumptions.blend_capacity_kg_per_person_week || MANUFACTURING_SCHEDULING_DEFAULT_BLEND_CAPACITY_PER_PERSON_WEEK) * staffCount;
    const fillCapacity = Number(draftPayload.assumptions.fill_capacity_kg_per_person_week || MANUFACTURING_SCHEDULING_DEFAULT_FILL_CAPACITY_PER_PERSON_WEEK) * staffCount;
    const weeklyRows = weeks.map((week) => {
      const blendLoad = Number(weeklyBlend.get(week.startDate) || 0);
      const fillLoad = Number(weeklyFill.get(week.startDate) || 0);
      const blendUsageRatio = blendCapacity > 0 ? blendLoad / blendCapacity : (blendLoad > 0 ? Number.POSITIVE_INFINITY : 0);
      const fillUsageRatio = fillCapacity > 0 ? fillLoad / fillCapacity : (fillLoad > 0 ? Number.POSITIVE_INFINITY : 0);
      const combinedUsageRatio = blendUsageRatio + fillUsageRatio;
      return {
        weekStart: week.startDate,
        blendLoad,
        fillLoad,
        blendCapacity,
        fillCapacity,
        blendUsageRatio,
        fillUsageRatio,
        combinedUsageRatio,
        feasible: combinedUsageRatio <= 1,
      };
    });
    const maxCombinedUsageRatio = Math.max(0, ...weeklyRows.map((row) => row.combinedUsageRatio));
    return {
      staffCount,
      blendCapacity,
      fillCapacity,
      maxBlendLoad,
      maxFillLoad,
      maxCombinedUsageRatio,
      feasible: maxCombinedUsageRatio <= 1,
      weeklyRows,
    };
  }, [draftPayload.assumptions, draftPayload.schedule_rows, weeks]);

  if (products.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-slate-400 border-2 border-dashed border-slate-200 rounded-xl min-h-[400px]">
        <CalendarRange className="w-12 h-12 mb-4 text-slate-300" />
        <p>No finished products available for scheduling.</p>
      </div>
    );
  }

  const summaryHeaderLayoutClass = isHandheldDevice
    ? 'flex flex-col gap-5'
    : 'flex flex-col lg:flex-row lg:items-start lg:justify-between gap-5';
  const quickAddHeaderLayoutClass = isHandheldDevice
    ? 'flex flex-col gap-3'
    : 'flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3';
  const quickAddControlsClass = isHandheldDevice
    ? 'flex flex-col sm:flex-row gap-3 w-full'
    : 'flex flex-col sm:flex-row gap-3 w-full lg:w-auto lg:min-w-[540px]';
  const savedPlansGridClass = isHandheldDevice
    ? 'p-4 sm:p-6 grid grid-cols-1 gap-4'
    : 'p-4 sm:p-6 grid grid-cols-1 lg:grid-cols-2 gap-4';

  return (
    <div className="space-y-6">
      <section className="bg-white border border-slate-200 rounded-xl shadow-sm px-4 sm:px-6 py-4">
        <div className={summaryHeaderLayoutClass}>
          <div className="space-y-2 min-w-0">
            <div className="inline-flex items-center gap-2 rounded-full bg-indigo-50 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-indigo-700">
              <CalendarRange className="w-3.5 h-3.5" />
              Scheduling (Mid Term)
            </div>
            <div>
              <h3 className="text-lg font-black text-slate-900">{draftPayload.plan_name || MANUFACTURING_SCHEDULING_PRODUCT_NAME}</h3>
              <p className="mt-1 text-sm text-slate-600 max-w-4xl">
                Plans are saved in this browser. This is a simulation, so the page does not write inventory ledger movements.
              </p>
              <p className="mt-1 text-sm text-slate-600 max-w-4xl">
                Weeks run from <span className="font-semibold">{formatDateLabel(weeks[0]?.startDate || '')}</span> to{' '}
                <span className="font-semibold">{formatDateLabel(weeks[weeks.length - 1]?.startDate || '')}</span>. Blend and fill are planned together, with a default blend helper of {MANUFACTURING_SCHEDULING_DEFAULT_BLEND_BATCH_SIZE_KG}kg.
              </p>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                <span>
                  Latest saved plan:{' '}
                  {workingReport
                    ? formatSnapshotLabel(workingReport.payload.updated_at || workingReport.created_at)
                    : 'Not saved yet'}
                </span>
                {currentSnapshotName && <span>Opened plan: {currentSnapshotName}</span>}
              </div>
            </div>
          </div>

          <div className="w-full xl:w-[420px] xl:ml-auto space-y-3">
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Staff</label>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={draftPayload.assumptions.production_staff_count ?? MANUFACTURING_SCHEDULING_DEFAULT_PRODUCTION_STAFF}
                  onChange={(event) => handleAssumptionChange('production_staff_count', event.target.value)}
                  className="w-full h-10 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700"
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Blend kg/person/week</label>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={draftPayload.assumptions.blend_capacity_kg_per_person_week ?? MANUFACTURING_SCHEDULING_DEFAULT_BLEND_CAPACITY_PER_PERSON_WEEK}
                  onChange={(event) => handleAssumptionChange('blend_capacity_kg_per_person_week', event.target.value)}
                  className="w-full h-10 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700"
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Fill kg/person/week</label>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={draftPayload.assumptions.fill_capacity_kg_per_person_week ?? MANUFACTURING_SCHEDULING_DEFAULT_FILL_CAPACITY_PER_PERSON_WEEK}
                  onChange={(event) => handleAssumptionChange('fill_capacity_kg_per_person_week', event.target.value)}
                  className="w-full h-10 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700"
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <span className={`inline-flex items-center rounded-full px-3 py-1 font-medium ${capacitySummary.feasible ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
                Peak team load {Math.round(capacitySummary.maxCombinedUsageRatio * 100)}%
              </span>
            </div>
            <div className="flex items-center gap-2">
              <select
                value=""
                onChange={(event) => {
                  const snapshot = recentSnapshotOptions.find((item) => item.report_id === event.target.value);
                  if (snapshot) void handleLoadSnapshot(snapshot);
                }}
                disabled={recentSnapshotOptions.length === 0 || isSavingWorking || isLoading}
                className="min-w-0 flex-1 h-10 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 disabled:bg-slate-100 disabled:text-slate-400"
              >
                <option value="">{recentSnapshotOptions.length > 0 ? 'Recent plans' : 'No recent plans'}</option>
                {recentSnapshotOptions.map((snapshot) => (
                  <option key={snapshot.report_id} value={snapshot.report_id}>
                    {snapshot.product_name} · {formatSnapshotLabel(snapshot.payload.saved_at || snapshot.created_at)}
                  </option>
                ))}
              </select>
              <button
                onClick={handleSaveWorkingPlan}
                disabled={Boolean(isReadOnly) || isSavingWorking}
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-indigo-300 bg-indigo-600 text-white transition hover:bg-indigo-700 disabled:opacity-50"
                title="Save plan"
              >
                {isSavingWorking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          <span className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 font-medium text-slate-600"><strong className="mr-1 text-slate-900">{calculation.summary.selected_product_count}</strong> selected</span>
          <span className="inline-flex items-center rounded-full bg-emerald-50 px-3 py-1 font-medium text-emerald-700"><strong className="mr-1">{formatQuantity(calculation.summary.total_blend_kg)}</strong> blend kg</span>
          <span className="inline-flex items-center rounded-full bg-indigo-50 px-3 py-1 font-medium text-indigo-700"><strong className="mr-1">{formatQuantity(calculation.summary.total_fill_kg)}</strong> fill kg</span>
          <span className={`inline-flex items-center rounded-full px-3 py-1 font-medium ${calculation.shortageRows.length > 0 ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700'}`}><strong className="mr-1">{calculation.shortageRows.length}</strong> shortages</span>
          <span className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 font-medium text-slate-600"><strong className="mr-1 text-slate-900">{formatCurrency(calculation.summary.total_procurement_spend)}</strong> requested</span>
        </div>

        {loadError && (
          <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            Failed to load saved plans. {loadError}
          </div>
        )}

        {validationMessages.length > 0 && (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <div className="space-y-1">
                {validationMessages.map((message) => (
                  <p key={message}>{message}</p>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 space-y-4">
          <div>
            <h4 className="text-base font-black text-slate-900">Product priority selector</h4>
            <p className="text-sm text-slate-500">
              Prioritise commercial products, Comp A, samples, and commercial dispensings. If no target is entered, safety stock becomes the planning reference.
            </p>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-4">
            <div className={quickAddHeaderLayoutClass}>
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-black uppercase tracking-widest text-slate-500">Quick add</div>
                <p className="text-sm text-slate-600 mt-1">Add a product directly into the shared plan.</p>
              </div>
              <div className={quickAddControlsClass}>
                <select
                  value={pickerSkuId}
                  onChange={(event) => setPickerSkuId(event.target.value)}
                  className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-700 shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                >
                  <option value="">Select product to add</option>
                  {quickAddGroups.map((group) => (
                    <optgroup key={group.categoryLabel} label={group.categoryLabel}>
                      {group.rows.map((row) => (
                        <option key={row.sku_id} value={row.sku_id}>
                          {row.sku_name} ({row.sku_id})
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleQuickAdd}
                  disabled={!pickerSkuId}
                  className="inline-flex items-center justify-center rounded-xl bg-indigo-600 px-4 py-3 text-sm font-bold text-white transition hover:bg-indigo-700 disabled:opacity-50"
                >
                  Add product
                </button>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleSelectGapProducts}
                className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-700 transition hover:bg-slate-100"
              >
                Select gaps
              </button>
              <button
                type="button"
                onClick={handleSelectAllPriorityProducts}
                className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-700 transition hover:bg-slate-100"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={() => void handleClearSelection()}
                className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-700 transition hover:bg-slate-100"
              >
                Clear selection
              </button>
            </div>

            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
              <div className="overflow-x-auto">
                <table className="min-w-[920px] w-full text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="px-3 py-2.5 text-left text-[9px] font-black uppercase tracking-widest text-slate-500">Product</th>
                      <th className="px-3 py-2.5 text-right text-[9px] font-black uppercase tracking-widest text-slate-500">Commercial stock</th>
                      <th className="px-3 py-2.5 text-right text-[9px] font-black uppercase tracking-widest text-slate-500">Horizon target</th>
                      <th className="px-3 py-2.5 text-right text-[9px] font-black uppercase tracking-widest text-slate-500">Safety stock</th>
                      <th className="px-3 py-2.5 text-right text-[9px] font-black uppercase tracking-widest text-slate-500">Priority gap</th>
                      <th className="px-3 py-2.5 text-right text-[9px] font-black uppercase tracking-widest text-slate-500">Action</th>
                    </tr>
                  </thead>
                    <tbody className="divide-y divide-slate-100">
                      {selectorGroups.map((group) => (
                        <React.Fragment key={group.categoryLabel}>
                        <tr className="bg-slate-50/80">
                          <td colSpan={6} className="px-0">
                            <button
                              type="button"
                              onClick={() => {
                                if (group.categoryLabel === 'Blended') {
                                  setBlendedReferenceExpanded((current) => !current);
                                  return;
                                }
                                setCollapsedPriorityGroups((current) => ({
                                  ...current,
                                  [group.categoryLabel]: !current[group.categoryLabel],
                                }));
                              }}
                              className="w-full flex items-center justify-between px-3 py-2 text-left"
                            >
                              <span className="text-[9px] font-black uppercase tracking-[0.2em] text-slate-500">
                                {group.categoryLabel}
                              </span>
                              <span className="inline-flex items-center gap-2 text-[11px] font-bold text-slate-500">
                                {group.categoryLabel === 'Blended' ? blendedReferenceRows.length : group.rows.length} rows
                                {(group.categoryLabel === 'Blended' ? blendedReferenceExpanded : !collapsedPriorityGroups[group.categoryLabel])
                                  ? <ChevronDown className="w-4 h-4" />
                                  : <ChevronRight className="w-4 h-4" />}
                              </span>
                            </button>
                          </td>
                        </tr>
                        {group.categoryLabel === 'Blended' && blendedReferenceExpanded && blendedReferenceRows.map((row) => (
                          <tr key={row.sku_id} className="bg-white">
                            <td className="px-3 py-2.5">
                              <div className="flex flex-col items-start gap-1">
                                <div className="font-semibold text-slate-900">{row.sku_name}</div>
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[9px] font-black uppercase ${RISK_TONES[row.risk_level]}`}>
                                    {row.risk_level}
                                  </span>
                                  {row.has_plan_activity && (
                                    <span className="inline-flex items-center rounded-full bg-sky-100 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest text-sky-700">
                                      In plan
                                    </span>
                                  )}
                                </div>
                                <div className="text-[9px] text-slate-400 font-mono">{row.sku_id}</div>
                              </div>
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono font-semibold text-slate-700">
                              {formatQuantity(row.commercial_stock)} {row.unit}
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono text-slate-700">
                              {row.horizon_target_qty !== undefined ? formatQuantity(row.horizon_target_qty) : '—'}
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono text-indigo-700">
                              {formatQuantity(row.safety_stock_qty)}
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono text-rose-700">
                              {formatQuantity(row.priority_gap)}
                            </td>
                            <td className="px-3 py-2.5 text-right text-slate-300">—</td>
                          </tr>
                        ))}
                        {group.categoryLabel !== 'Blended' && !collapsedPriorityGroups[group.categoryLabel] && group.rows.map((row) => (
                          <tr key={row.sku_id} className={row.is_selected ? 'bg-indigo-50/40' : 'bg-white'}>
                            <td className="px-3 py-2.5">
                              <div className="flex flex-col items-start gap-1">
                                <div className="font-semibold text-slate-900">{row.sku_name}</div>
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[9px] font-black uppercase ${RISK_TONES[row.risk_level]}`}>
                                    {row.risk_level}
                                  </span>
                                  {row.has_plan_activity && (
                                    <span className="inline-flex items-center rounded-full bg-sky-100 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest text-sky-700">
                                      In plan
                                    </span>
                                  )}
                                </div>
                                <div className="text-[9px] text-slate-400 font-mono">{row.sku_id}</div>
                              </div>
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono font-semibold text-slate-700">
                              {formatQuantity(row.commercial_stock)} {row.unit}
                            </td>
                            <td className="px-3 py-2.5 text-right">
                              <input
                                type="number"
                                min="0"
                                step="1"
                                value={row.horizon_target_qty ?? ''}
                                onChange={(event) => handleTargetChange(row.sku_id, event.target.value)}
                                disabled={isReadOnly}
                                className="w-20 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-right text-xs font-semibold text-slate-700"
                                placeholder={String(row.safety_stock_qty || '')}
                              />
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono text-indigo-700">
                              {formatQuantity(row.safety_stock_qty)}
                            </td>
                            <td className={`px-3 py-2.5 text-right font-mono font-semibold ${row.priority_gap > 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                              {row.priority_gap > 0 ? '+' : ''}{formatQuantity(row.priority_gap)}
                            </td>
                            <td className="px-3 py-2.5 text-right">
                              {row.is_selected ? (
                                <button
                                  type="button"
                                  onClick={() => void handleRemoveProduct(row.sku_id)}
                                  className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-bold text-slate-700 transition hover:bg-slate-100"
                                >
                                  Remove
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => handleSelectProduct(row.sku_id)}
                                  className="inline-flex items-center justify-center rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-bold text-white transition hover:bg-indigo-700"
                                >
                                  Select
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {calculation.priorityRows.filter((row) => row.is_selected).length === 0 ? (
                <div className="text-sm text-slate-500">No products selected yet.</div>
              ) : (
                calculation.priorityRows
                  .filter((row) => row.is_selected)
                  .map((row) => (
                    <span
                      key={row.sku_id}
                      className="inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700"
                    >
                      <span>{row.sku_name}</span>
                      <button
                        type="button"
                        onClick={() => void handleRemoveProduct(row.sku_id)}
                        className="inline-flex h-5 w-5 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                        aria-label={`Remove ${row.sku_name}`}
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </span>
                  ))
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200">
          <h4 className="text-base font-black text-slate-900">Weekly master schedule</h4>
          <p className="text-sm text-slate-500">
            Blend and fill are planned in the same horizon. Scheduled blend is immediately available for fill in the same week or later.
          </p>
        </div>

        {calculation.scheduleBlocks.length === 0 ? (
          <div className="h-48 flex items-center justify-center text-slate-400 px-5 text-center">
            Select one or more products above to start the shared weekly plan.
          </div>
        ) : (
          <div>
            <div className="overflow-x-auto">
              <table className="min-w-[1720px] w-full text-left">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-500 min-w-[280px]">Product / Stage</th>
                    <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-500 min-w-[160px]">Output</th>
                    <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-500 text-right min-w-[120px]">Current stock</th>
                    <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-500 text-right min-w-[120px]">Planned total</th>
                    {weeks.map((week) => (
                      <th key={week.startDate} className="px-3 py-3 text-[10px] font-black uppercase tracking-widest text-slate-500 min-w-[170px] border-l border-slate-200">
                        <div className="flex items-center gap-2">
                          <Clock3 className="w-3 h-3" />
                          Week of {formatDateLabel(week.startDate)}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {calculation.scheduleBlocks.map((block) => (
                    <React.Fragment key={block.sku_id}>
                      <tr className="bg-slate-50/80">
                        <td colSpan={4 + weeks.length} className="px-4 py-3">
                          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
                            <div>
                              <div className="font-black text-slate-900">{block.sku_name}</div>
                              <div className="text-xs text-slate-500">
                                {CATEGORY_LABELS[block.category]} • Target {formatQuantity(block.horizon_target_qty || 0)} • Safety {formatQuantity(block.safety_stock_qty)} • Commercial stock {formatQuantity(block.commercial_stock)}
                                {block.category !== 'COMP_A' && ` • Blended ref ${formatQuantity(block.blended_stock_reference)}`}
                              </div>
                            </div>
                            {block.warnings.length > 0 && (
                              <div className="flex flex-wrap gap-2">
                                {block.warnings.map((warning) => (
                                  <span key={warning} className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-bold text-amber-800">
                                    {warning}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                      {block.rows.map((row) => (
                        <tr key={row.row_id} className="align-top">
                          <td className="px-4 py-4">
                            <div className="space-y-2">
                              <span className={`inline-flex items-center rounded border px-2 py-1 text-[10px] font-black uppercase ${STAGE_TONES[row.stage]}`}>
                                {STAGE_LABELS[row.stage]}
                              </span>
                              <div className="text-xs text-slate-500">
                                {row.stage === 'BLEND'
                                  ? `Default helper ${MANUFACTURING_SCHEDULING_DEFAULT_BLEND_BATCH_SIZE_KG}kg, step 1kg`
                                  : 'Packaging / consumables are taken from fill'}
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-4">
                            <div className="font-bold text-slate-900">{row.output_name}</div>
                            <div className="text-xs text-slate-500 font-mono">{row.output_sku_id}</div>
                          </td>
                          <td className="px-4 py-4 text-right">
                            <div className="font-black text-slate-900">{formatQuantity(row.current_stock)}</div>
                            <div className="text-xs text-slate-500">kg</div>
                          </td>
                          <td className="px-4 py-4 text-right">
                            <div className="font-black text-indigo-700">{formatQuantity(row.total_planned_kg)}</div>
                            <div className="text-xs text-slate-500">Across selected weeks</div>
                          </td>
                          {row.cells.map((cell) => {
                            const variantOptions = variantOptionsBySku.get(row.output_sku_id) || [];
                            const endNegative = cell.afterStock < 0;
                            const hasQuantity = cell.quantityKg > 0;
                            return (
                              <td key={`${row.row_id}-${cell.weekStart}`} className="px-3 py-3 border-l border-slate-100">
                                <div className={`rounded-xl border p-2.5 space-y-2 ${endNegative ? 'border-rose-200 bg-rose-50/70' : hasQuantity ? 'border-indigo-200 bg-indigo-50/60' : 'border-slate-200 bg-slate-50/70'}`}>
                                  <input
                                    type="number"
                                    min="0"
                                    step="1"
                                    value={cell.quantityKg > 0 ? cell.quantityKg : ''}
                                    onChange={(event) => handleCellQuantityChange(row.row_id, cell.weekStart, event.target.value)}
                                    disabled={isReadOnly}
                                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-800 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-100"
                                    placeholder={row.stage === 'BLEND' ? String(MANUFACTURING_SCHEDULING_DEFAULT_BLEND_BATCH_SIZE_KG) : '0'}
                                  />
                                  <select
                                    value={cell.bomVariantId}
                                    onChange={(event) => handleCellVariantChange(row.row_id, cell.weekStart, event.target.value)}
                                    disabled={isReadOnly}
                                    className="w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs font-semibold text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-100"
                                  >
                                    {variantOptions.map((option) => (
                                      <option key={option.bomVariantId} value={option.bomVariantId}>
                                        {option.bomVariantName}
                                      </option>
                                    ))}
                                  </select>
                                  <div className="grid grid-cols-2 gap-2 text-[11px]">
                                    <div className="rounded-lg bg-white/70 px-2 py-1 text-slate-600">
                                      <div className="uppercase tracking-widest text-[9px] font-black text-slate-400">Before</div>
                                      <div className="font-bold">{formatQuantity(cell.beforeStock)}</div>
                                    </div>
                                    <div className={`rounded-lg px-2 py-1 ${endNegative ? 'bg-rose-100 text-rose-700' : 'bg-white/70 text-slate-600'}`}>
                                      <div className="uppercase tracking-widest text-[9px] font-black text-slate-400">After</div>
                                      <div className="font-bold">{formatQuantity(cell.afterStock)}</div>
                                    </div>
                                  </div>
                                </div>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </React.Fragment>
                  ))}
                  <tr className="bg-slate-50/80 border-t-2 border-slate-200">
                    <td colSpan={4} className="px-4 py-3 align-top">
                      <div className="font-black text-slate-900">Feasibility check</div>
                      <div className="text-xs text-slate-500">Combined weekly operator load from blend and fill</div>
                    </td>
                    {capacitySummary.weeklyRows.map((row) => (
                      <td key={`combined-feasibility-${row.weekStart}`} className="px-3 py-3 border-l border-slate-200 align-top">
                        <div className={`rounded-xl border px-3 py-3 ${row.feasible ? 'border-emerald-200 bg-emerald-50/70' : 'border-rose-200 bg-rose-50/80'}`}>
                          <div className="text-[9px] font-black uppercase tracking-widest text-slate-500">Team load</div>
                          <div className="mt-1 text-sm font-black text-slate-900">
                            {Math.round(row.combinedUsageRatio * 100)}%
                          </div>
                          <div className="mt-1 text-[10px] text-slate-500">
                            B {formatQuantity(row.blendLoad)} / {formatQuantity(row.blendCapacity)}
                          </div>
                          <div className="text-[10px] text-slate-500">
                            F {formatQuantity(row.fillLoad)} / {formatQuantity(row.fillCapacity)}
                          </div>
                          <div className={`mt-1 text-[11px] font-bold ${row.feasible ? 'text-emerald-700' : 'text-rose-700'}`}>
                            {row.feasible ? 'Feasible' : 'Over capacity'}
                          </div>
                        </div>
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <MaterialImpactTable
        title="Ingredients impact from blend"
        description="Only blend rows consume ingredient lines from the selected recipe versions."
        rows={calculation.materialRows.filter((row) => row.material_group === 'INGREDIENT')}
        onLeadTimeChange={handleLeadTimeChange}
      />

      <MaterialImpactTable
        title="Consumables impact from fill"
        description="Only fill rows consume consumable and packaging lines from the selected recipe versions."
        rows={calculation.materialRows.filter((row) => row.material_group === 'CONSUMABLE')}
        onLeadTimeChange={handleLeadTimeChange}
      />

      <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200">
          <h4 className="text-base font-black text-slate-900">Projected shortages and procurement request</h4>
          <p className="text-sm text-slate-500">
            Choose a historical unit price by delivery date when available. If there is no price history, enter a manual unit price. Lead time can be adjusted for each material.
          </p>
        </div>

        {calculation.shortageRows.length === 0 ? (
          <div className="h-40 flex items-center justify-center text-slate-400 px-5">No projected shortages for the current plan.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-[1220px] w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-4 py-3 text-left text-[10px] font-black uppercase tracking-widest text-slate-500">Item</th>
                  <th className="px-4 py-3 text-left text-[10px] font-black uppercase tracking-widest text-slate-500">Type</th>
                  <th className="px-4 py-3 text-right text-[10px] font-black uppercase tracking-widest text-slate-500">Shortage</th>
                  <th className="px-4 py-3 text-left text-[10px] font-black uppercase tracking-widest text-slate-500">Unit price</th>
                  <th className="px-4 py-3 text-right text-[10px] font-black uppercase tracking-widest text-slate-500">Lead time (weeks)</th>
                  <th className="px-4 py-3 text-right text-[10px] font-black uppercase tracking-widest text-slate-500">Order by</th>
                  <th className="px-4 py-3 text-right text-[10px] font-black uppercase tracking-widest text-slate-500">Estimated spend</th>
                  <th className="px-4 py-3 text-left text-[10px] font-black uppercase tracking-widest text-slate-500">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {calculation.shortageRows.map((shortage) => {
                  const materialRow = calculation.materialRows.find((row) => row.component_id === shortage.id.replace('material::', ''));
                  return (
                    <tr key={shortage.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <div className="font-bold text-slate-900">{shortage.name}</div>
                        {materialRow && <div className="text-xs text-slate-500">{materialRow.component_id}</div>}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-widest ${
                          shortage.shortage_type === 'INTERNAL'
                            ? 'bg-violet-100 text-violet-700'
                            : shortage.shortage_type === 'INGREDIENT'
                              ? 'bg-emerald-100 text-emerald-700'
                              : 'bg-amber-100 text-amber-700'
                        }`}>
                          {shortage.shortage_type}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono font-bold text-rose-700">
                        {formatQuantity(shortage.shortage_qty)} {shortage.unit}
                      </td>
                      <td className="px-4 py-3">
                        {!materialRow ? (
                          <span className="text-xs text-slate-400">Internal planning item</span>
                        ) : materialRow.price_options.length > 0 ? (
                          <select
                            value={materialRow.price_options.find((option) => option.unitPrice === materialRow.selected_unit_price)?.key || materialRow.price_options[0]?.key || ''}
                            onChange={(event) => handlePriceSelectionChange(materialRow.component_id, event.target.value)}
                            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700"
                          >
                            {materialRow.price_options.map((option) => (
                              <option key={option.key} value={option.key}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type="number"
                            min="0"
                            step="0.0001"
                            value={materialRow.selected_unit_price > 0 ? materialRow.selected_unit_price : ''}
                            onChange={(event) => handleManualUnitPriceChange(materialRow.component_id, event.target.value)}
                            className="w-32 rounded-lg border border-slate-300 bg-white px-3 py-2 text-right text-sm font-bold text-slate-700"
                            placeholder="Manual price"
                          />
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {materialRow ? (
                          <input
                            type="number"
                            min="1"
                            step="1"
                            value={materialRow.lead_time_weeks}
                            onChange={(event) => handleLeadTimeChange(materialRow.component_id, event.target.value)}
                            className="w-20 rounded-lg border border-slate-300 bg-white px-2 py-2 text-right text-sm font-bold text-slate-700"
                          />
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-slate-700">
                        {shortage.order_by_date || '—'}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-slate-700">
                        {shortage.estimated_spend ? formatCurrency(shortage.estimated_spend) : '—'}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{shortage.action}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        <div className="px-4 sm:px-6 py-4 border-b border-slate-100 bg-white">
          <h4 className="font-bold text-slate-800 text-sm uppercase tracking-wider">Saved plans</h4>
          <p className="text-sm text-slate-500">
            Saved plans remain in this browser. Open any recent version when you want to continue from an older plan.
          </p>
        </div>

        {snapshotRecords.length === 0 ? (
          <div className="h-32 flex items-center justify-center text-slate-400">No saved plans yet.</div>
        ) : (
          <div className={savedPlansGridClass}>
            {snapshotRecords.map((snapshot) => (
              <div key={snapshot.report_id} className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                      Saved plan
                    </span>
                    <span className="text-xs text-slate-500 font-mono">{snapshot.report_id}</span>
                  </div>
                  <h5 className="font-bold text-slate-900 text-lg">{snapshot.product_name}</h5>
                  <p className="text-sm text-slate-500">
                    Saved by <span className="font-semibold text-slate-700">{snapshot.payload.saved_by || snapshot.created_by || 'Unknown user'}</span> on{' '}
                    <span className="font-semibold text-slate-700">{formatSnapshotLabel(snapshot.payload.saved_at || snapshot.created_at)}</span>
                  </p>
                </div>

                <div className="mt-3 flex flex-wrap gap-2 text-xs">
                  <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-1 font-medium text-slate-600"><strong className="mr-1 text-slate-900">{snapshot.payload.summary?.selected_product_count || 0}</strong> products</span>
                  <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-1 font-medium text-emerald-700"><strong className="mr-1">{formatQuantity(snapshot.payload.summary?.total_blend_kg || 0)}</strong> blend</span>
                  <span className="inline-flex items-center rounded-full bg-indigo-50 px-2.5 py-1 font-medium text-indigo-700"><strong className="mr-1">{formatQuantity(snapshot.payload.summary?.total_fill_kg || 0)}</strong> fill</span>
                  <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-1 font-medium text-slate-600"><strong className="mr-1 text-slate-900">{formatCurrency(snapshot.payload.summary?.procurement_spend || 0)}</strong> procurement</span>
                </div>

                <div className="flex flex-wrap gap-2 mt-4">
                  <button
                    type="button"
                    onClick={() => void handleLoadSnapshot(snapshot)}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-indigo-300 bg-indigo-600 text-white transition hover:bg-indigo-700"
                    title="Open plan"
                  >
                    <Upload className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDownloadSavedPlan(snapshot)}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-700 transition hover:bg-slate-100"
                    title="Download plan"
                  >
                    <Download className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDeleteSnapshot(snapshot)}
                    disabled={recordActionId === snapshot.report_id || Boolean(isReadOnly)}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-700 transition hover:bg-slate-100 disabled:opacity-50"
                    title="Delete plan"
                  >
                    {recordActionId === snapshot.report_id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
