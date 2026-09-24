
export const COMPONENT_KEYS = [
  'component_id',
  'id_core',
  'component_name',
  'type',
  'category',
  'subcategory',
  'default_unit',
  // Canonical item-master cost field (authoritative for component costing reads).
  'unitCost',
  'version',
  'notes',
  'updatedBy',
  'createdAt',
  'updatedAt'
] as const;

export const PRODUCT_KEYS = [
  'sku_id',
  'sku_name',
  'family',
  'category',
  'format',
  'default_unit',
  'unitProductionCost',
  'notes',
  'updatedBy',
  'createdAt',
  'updatedAt'
] as const;

export const BOM_KEYS = [
  'sku_id',
  'bomVariantId',
  'bomVariantName',
  'isDefaultVariant',
  'variantSortOrder',
  'component_id',
  'component_type',
  'line_kind',
  'ref_type',
  'ref_id',
  'qty_per_kg',
  'unit',
  'notes',
  'line_order',
  'updatedBy',
  'createdAt',
  'updatedAt'
] as const;

export const BATCH_MASTER_KEYS = [
  // Canonical row ID for batches_master.
  'batch_id',
  // Legacy mirror for backward compatibility during migration.
  'id',
  'batch_number',
  'batchType',
  'parentBulkBatchId',
  'productSku',
  'productName',
  'bomVariantId',
  'bomVariantName',
  'default_batch_kg',
  'time_per_kg',
  'plannedQuantity',
  'actualYield',
  'status',
  'location',
  'unitProductionCost',
  'qcNotes',
  'qcDisposition',
  'createdAt',
  'updatedAt'
] as const;

export const BATCH_EVENT_KEYS = [
  'batch_id',
  'stage_code',
  'status_after',
  'operator_name',
  'timestamp',
  'equipment_id',
  'notes',
  'updatedAt'
] as const;

export const BATCH_COST_KEYS = [
  'batch_id',
  'category',
  'amount',
  'description',
  'posted_at',
  'posted_by'
] as const;

export const BPR_SNAPSHOT_KEYS = [
  'snapshot_id',
  'batch_id',
  'snapshot_version',
  'created_at',
  'created_by',
  'payload_json',
  'stage_scope'
] as const;

export const PLANNING_REPORT_KEYS = [
  'report_id',
  'product_sku',
  'product_name',
  'batch_size',
  'total_cost',
  'cost_per_unit',
  'breakdown_json',
  'created_at',
  'created_by'
] as const;

export const CATEGORY_KEYS = [
  'id',
  'type',
  'category_code',
  'category_label',
  'createdAt',
  'updatedAt'
] as const;

export const RAW_COMPONENT_DISPLAY_NAME_KEYS = [
  'id',
  'type',
  'display_name',
  'id_core',
  'createdAt',
  'updatedAt'
] as const;

export const INVENTORY_TRANSACTION_KEYS = [
  'id',
  'type',
  'category',
  'itemId',
  'itemName',
  'quantity',
  'unit',
  'location',
  'supplier',
  'unitCost',
  'unitSalePrice',
  'batchNumber',
  'reason',
  'notes',
  'reference',
  'salesRep',
  'user',
  'updatedBy',
  'editReason',
  'sourceTab',
  'createdAt',
  'updatedAt'
] as const;

export const STOCK_BALANCE_KEYS = [
  'stock_balance_id',
  'category',
  'itemId',
  'itemName',
  'batchNumber',
  'location',
  'unit',
  'onHandQty',
  'availableQty',
  'lastLedgerTxnId',
  'sourceLedgerUpdatedAt',
  'updatedAt',
  'updatedBy',
  'schemaVersion'
] as const;

// Canonical contract for inventory_ledger writes only.
// Read schema intentionally remains broader for backward compatibility.
export const INVENTORY_LEDGER_WRITE_KEYS = [
  'id',
  'type',
  'category',
  'itemId',
  'itemName',
  'quantity',
  'unit',
  'location',
  'supplier',
  'unitCost',
  'unitSalePrice',
  'batchNumber',
  'reason',
  'notes',
  'reference',
  'salesRep',
  'user',
  'updatedBy',
  'editReason',
  'sourceTab',
  'createdAt',
  'updatedAt'
] as const;

export const AUDIT_LOG_KEYS = [
  'log_id',
  'timestamp',
  'actor',
  'category',
  'action_type',
  'entity_id',
  'details',
  'diff_payload'
] as const;

export const COLUMN_ALIASES: Record<string, string[]> = {
  // Transaction/Batches ID policy:
  // - Keep "id" for record identity.
  // - Map "batch_id" to batchNumber (not id) to avoid semantic collision.
  'id': ['txn_id', 'txnid', 'txnId', 'transaction_id', 'transactionid', 'record_id', 'ledger_id'],
  'productSku': ['product_sku', 'sku', 'product', 'product_id'],
  'batchType': ['batch_type'],
  'parentBulkBatchId': ['parent_bulk_batch_id', 'parent_bulk_id', 'bulk_parent_batch_id'],
  'productName': ['product_name', 'name', 'sku_name', 'product_label'],
  'plannedQuantity': ['planned_qty', 'planned_quantity', 'target_qty', 'plan_qty'],
  'actualYield': ['actual_yield', 'yield', 'qty_actual', 'actual_qty'],
  'status': ['current_status', 'batch_status', 'state'],
  'unitProductionCost': ['unit_production_cost', 'unit_cost', 'cost_per_kg', 'unit_cost_per_kg'],
  'qty_actual': ['qty', 'actual qty', 'dosage'],
  'posted_at': ['date', 'timestamp', 'posted_on', 'posting_date'],
  'createdAt': ['created_at', 'created_on', 'event_time', 'event_timestamp'],
  'itemId': ['item_id', 'sku', 'component_id', 'component', 'material_id'],
  'itemName': ['item_name', 'name', 'description', 'component_name', 'material_name'],
  'batchNumber': [
    'batch_number', 'batch', 'qc_number', 'lot_number', 
    'qc', 'qc_#', 'qc #', 'qc id', 'lot', 'lot #', 'lot_#', 'batch #', 'batch_#',
    'batch_no', 'lot_no', 'qc_no', 'batch_id', 'batchid'
  ],
  'unitCost': ['unit_cost', 'cost_per_unit', 'material_cost', 'cost_price'],
  'unitSalePrice': ['unit_sale_price', 'sale_price', 'sales_price', 'dispatch_price'],
  'salesRep': ['sales rep', 'sales_rep', 'Sales Rep', 'salesrep'],
  // Legacy transitional field: retained for old rows only.
  'pricePerUnit': ['price', 'cost', 'unit_price', 'price_per_unit'],
  'subcategory': ['unit', 'size', 'variant'],
  'default_unit': ['default_uom', 'uom', 'packaging_type', 'packaging', 'u_o_m'],
  'supplier': ['supplier_name', 'vendor', 'source', 'supplier_code'],
  'bomVariantId': ['bom_variant_id', 'variant_id', 'bom_variant', 'recipe_variant_id'],
  'bomVariantName': ['bom_variant_name', 'variant_name', 'recipe_variant_name'],
  'isDefaultVariant': ['is_default_variant', 'default_variant', 'variant_default', 'is_default'],
  'variantSortOrder': ['variant_sort_order', 'variant_order', 'sort_order', 'variant_seq']
};

function toComparableToken(value: string): string {
  return value
    .toString()
    .trim()
    // Convert camelCase/PascalCase to snake_case boundaries first.
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/\./g, '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '_');
}

export function normalizeHeader(header: string, contextKeys: readonly string[]): string {
  if (!header) return '';

  const cleanHeader = toComparableToken(header);

  // Match canonical keys even if schema key is camelCase and header is snake_case (or vice versa).
  const directContextMatch = contextKeys.find(key => toComparableToken(key) === cleanHeader);
  if (directContextMatch) return directContextMatch;

  for (const [canonical, aliases] of Object.entries(COLUMN_ALIASES)) {
    if (contextKeys.includes(canonical as any)) {
      if (toComparableToken(canonical) === cleanHeader) return canonical;
      const matchFound = aliases.some(alias => toComparableToken(alias) === cleanHeader);
      if (matchFound) return canonical;
    }
  }
  return cleanHeader;
}
