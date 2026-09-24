
export type LocationName = 'Riverside' | 'Hilltop';

export type ComponentType = 
  | 'INGREDIENT' 
  | 'PRIMARY_PACKAGING' 
  | 'SECONDARY_PACKAGING' 
  | 'CONSUMABLE' 
  | 'DISPENSING' 
  | 'LABEL' 
  | 'PALLET_LOGISTICS'
  | 'PALLET';

export interface Component {
  component_id: string;
  component_name: string;
  type: ComponentType;
  category: string;
  subcategory: string;
  default_unit: string;
  unitCost?: number;
  version: string;
  notes: string;
  id_core?: string;
  updatedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Product {
  sku_id: string;
  sku_name: string;
  family: string;
  category: string;
  format: string;
  default_unit: string;
  unitProductionCost?: number | null;
  notes?: string;
  createdAt?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface BOMItem {
  sku_id: string;
  bomVariantId?: string;
  bomVariantName?: string;
  isDefaultVariant?: boolean | string;
  variantSortOrder?: number;
  component_id: string;
  qty_per_kg: number;
  unit: string;
  line_kind?: 'INGREDIENT' | 'CONSUMABLE' | 'PACKAGING' | string;
  component_type?: ComponentType | 'COMP_A_SKU' | 'BLENDED_SKU' | 'OTHER_RAW_COMPONENT';
  ref_type?: string;
  ref_id?: string;
  notes?: string;
  line_order?: number;
  updatedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface OpenPO {
  component_id: string;
  incoming_qty: number;
}

export interface Supplier {
  component_id: string;
  supplier_name: string;
  lead_time_days: number;
  moq: number;
  pack_size: number;
}

export interface Demand {
  sku_id: string;
  qty_required: number;
  due_date: string;
  priority: 'High' | 'Medium' | 'Low';
}

export interface ProductionPlanItem {
  id: string;
  sku_id: string;
  bomVariantId?: string;
  bomVariantName?: string;
  quantity_kg: number;
}

export interface ComponentRequirement {
  component_id: string;
  required_qty: number;
  on_hand: number;
  incoming: number;
  deficit: number;
  limiting: boolean;
  unit: string;
}

export interface FeasibilityResult {
  feasible: boolean;
  limiting_component: string | null;
  max_producible_ratio: number;
  requirements: ComponentRequirement[];
}

export interface PlanAllocation {
    planItemId: string;
    productSku: string;
    productName: string;
    bomVariantId?: string;
    bomVariantName?: string;
    qtyRequired: number;
}

export interface PlanningRequirement {
    component_id: string;
    component_name: string;
    category: string;
    unit: string;
    total_required: number;
    start_stock: number;
    end_stock: number;
    shortage: number;
    unit_cost: number;
    total_cost: number;
    allocations: PlanAllocation[];
}

export interface PlanningResult {
    feasible: boolean;
    limiting_factor: string | null;
    total_cost: number;
    requirements: PlanningRequirement[];
}

export interface ReorderSuggestion {
  component_id: string;
  current_coverage: number;
  suggested_order_qty: number;
  reason: string;
  supplier: string;
  risk_level: 'High' | 'Medium' | 'Low';
  latest_order_date: string;
  days_until_stockout: number;
}

export interface ScoredDemandItem extends Demand {
  score: number;
  score_breakdown: string;
  feasible: boolean;
  limiting_factor?: string;
  capacity_cost: number;
  status: 'Selected' | 'Skipped (Capacity)' | 'Skipped (Material)';
}

export interface IngredientBatch {
  id: string;
  component_id: string;
  qc_number: string;
  qty_remaining: number;
  date_received: string;
  location: LocationName;
}

export interface ProductBatch {
  id: string;
  batch_id?: string;
  sku_id: string;
  bomVariantId?: string;
  bomVariantName?: string;
  batch_number: string;
  batchType?: 'BULK' | 'PACK' | 'TERMINAL';
  parentBulkBatchId?: string;
  qty_remaining: number;
  unit_cost: number;
  date_produced: string;
  location: LocationName;
  status: string;
  plannedQuantity: number;
  actualYield?: number;
  qcDocRef?: string;
  qcNotes?: string;
  qcDisposition?: BatchQcDisposition | string;
}

export interface BPRItem {
    component_id: string;
    component_name: string;
    required_qty: number;
    unit: string;
    allocated_batches: {
        batchId: string;
        qcNumber: string;
        location: LocationName;
        qtyAllocated: number;
    }[];
    shortage: number;
}

export interface BatchProductionRecord {
    product_sku: string;
    batch_size: number;
    items: BPRItem[];
    is_fully_allocated: boolean;
}

export interface CategoryMaster {
  id?: string;
  type: ComponentType;
  category_code: string;
  category_label: string;
  updatedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface RawComponentDisplayNameMaster {
  id: string;
  type: ComponentType;
  display_name: string;
  id_core?: string;
  updatedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface InventoryTransaction {
  id: string;
  // Legacy field for old rows only. Canonical business event time is createdAt.
  date?: string;
  type: 'IN' | 'OUT';
  category: 'COMPONENT' | 'PRODUCT';
  itemId: string;
  itemName?: string;
  quantity: number;
  unit: string;
  location: LocationName;
  supplier?: string;
  unitCost?: number;
  unitSalePrice?: number;
  pricePerUnit?: number;
  batchNumber?: string;
  reason?: string;
  notes?: string;
  reference?: string;
  salesRep?: string;
  user?: string;
  updatedBy?: string;
  editReason?: string;
  sourceTab?: string;
  updatedAt?: string;
  createdAt?: string;
}

export interface StockBalance {
  stock_balance_id: string;
  category: 'COMPONENT' | 'PRODUCT' | string;
  itemId: string;
  itemName?: string;
  batchNumber: string;
  location: string;
  unit?: string;
  onHandQty: number;
  availableQty: number;
  lastLedgerTxnId?: string;
  sourceLedgerUpdatedAt?: string;
  updatedAt?: string;
  updatedBy?: string;
  schemaVersion?: number;
}

export interface RawComponentLot {
  lot_record_id?: string;
  qc_number: string;
  workflow_stage?: 'PRE_ARRIVAL' | 'QUARANTINE' | 'RELEASED' | 'REJECTED';
  itemId: string;
  ordered_qty?: number;
  received_qty: number;
  unit: string;
  planned_unit_price?: number;
  unit_price: number;
  shipping_cost?: number;
  location: LocationName | '';
  supplier: string;
  procurementRef?: string;
  procurementNotes?: string;
  paidDate?: string;
  expectedDeliveryDate?: string;
  deliveryDate: string;
  mfgBatch: string;
  mfgDate: string;
  expDate: string;
  qcStatus: string;
  qcNotes: string;
  coaStored: 'Yes' | 'No';
  sdsStored: 'Yes' | 'No';
  tdsStored: 'Yes' | 'No';
  history?: string;
  registeredAt?: string;
  registeredBy?: string;
  editedAt?: string;
  editedBy?: string;
  createdAt?: string;
  updatedAt?: string;
  createdBy?: string;
  updatedBy?: string;
  ph?: string;
  titration?: string;
  appearance?: string;
  lodMoisture?: string;
  cfu?: string;
  manufacturer?: string;
  checkMaterial?: 'Pass' | 'Fail' | 'N/A';
  checkPrinting?: 'Pass' | 'Fail' | 'N/A';
  checkSize?: 'Pass' | 'Fail' | 'N/A';
  checkCorrectItem?: 'Pass' | 'Fail' | 'N/A';
  checkCorrectQuantity?: 'Pass' | 'Fail' | 'N/A';
}

export type BatchStatus = 'preparation' | 'blending' | 'QC_in_progress' | 'QC_passed' | 'QC_rejected' | 'filling_packaging' | 'finished_QC' | 'Released' | 'Archived' | 'QUARANTINE' | 'On hold';
export type BatchQcDisposition = 'standard' | 'rework_pending' | 'final_rejected' | 'reconciled_release';

export interface BatchRecord {
  id: string;
  batch_id?: string;
  batch_number?: string;
  batchType?: 'BULK' | 'PACK' | 'TERMINAL';
  parentBulkBatchId?: string;
  productSku: string;
  productName: string;
  bomVariantId?: string;
  bomVariantName?: string;
  default_batch_kg?: number;
  time_per_kg?: number;
  plannedQuantity: number;
  actualYield?: number;
  status: BatchStatus;
  location: LocationName;
  unitProductionCost: number;
  qcDocRef?: string;
  qcNotes?: string;
  qcDisposition?: BatchQcDisposition;
  createdAt?: string;
  updatedAt?: string;
}

export interface BatchStageEvent {
  id: string;
  batch_id: string;
  stage_code: string;
  status_after: BatchStatus;
  operator_name: string;
  timestamp: string;
  equipment_id?: string;
  notes?: string;
  updatedAt?: string;
  createdAt?: string;
}

export type BatchCostCategory = 'LABOUR' | 'ENERGY' | 'WATER' | 'PPE' | 'OTHER';

export interface BatchCostPosting {
  batch_id: string;
  category: BatchCostCategory;
  amount: number;
  description: string;
  posted_at: string;
  posted_by: string;
}

export interface Operator {
  id: string;
  name: string;
  role: string;
}

export interface MaterialPreparationSheet {
    id?: string;
    batchId: string;
    data: any;
}

export interface BPRSnapshot {
  snapshot_id?: string;
  batch_id: string;
  snapshot_version: number;
  created_at: string;
  created_by: string;
  payload_json: string;
  stage_scope: string;
}

// New Interface for Cost Calculator Persistence
export interface PlanningReport {
  report_id: string;
  product_sku: string;
  product_name: string;
  batch_size: number;
  total_cost: number;
  cost_per_unit: number;
  breakdown_json: string;
  created_at: string;
  created_by: string;
}

export interface QCParameter {
  id: string;
  label: string;
  target: string;
  type: 'text' | 'number' | 'choice';
  options?: string[];
}

export interface QCTemplate {
  id: string;
  name: string;
  parameters: QCParameter[];
}

export interface AppSettings {
  targetDaysOfCover: number;
  capacityHoursPerShift: number;
  weights: { urgency: number; priority: number };
  currentUser: string;
}

// Keep in sync with role identifiers in config/accessControl.ts.
export type UserRole =
  | 'ADMIN'
  | 'FULFILMENT'
  | 'MANUFACTURING_MANAGER'
  | 'QC'
  | 'INVENTORY_MANAGER'
  | 'WHOLE_VIEWER'
  | 'PRODUCT_LEADER'
  | 'INVENTORY_VIEWER';

export type AuditLogCategory = 'MASTER_DATA' | 'INVENTORY' | 'SECURITY' | 'BATCH' | 'SYSTEM';
export type AuditLogAction = 'CREATE' | 'UPDATE' | 'DELETE' | 'OVERRIDE' | 'RELEASE' | 'ARCHIVE' | 'LOGIN' | 'CONFIG_CHANGE';

export interface AuditLogEntry {
  log_id?: string;
  timestamp?: string;
  actor: string;
  category: AuditLogCategory;
  action_type: AuditLogAction;
  entity_id: string;
  details: string;
  diff_payload?: string; // JSON string of {old: ..., new: ...}
}
