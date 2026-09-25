import type {
  BOMItem,
  BatchRecord,
  CategoryMaster,
  Component,
  InventoryTransaction,
  LocationName,
  OpenPO,
  PlanningReport,
  Product,
  RawComponentDisplayNameMaster,
  RawComponentLot,
  Supplier,
} from '../types';

export interface DemoDatabase {
  schemaVersion: number;
  items: Component[];
  products: Product[];
  recipes: BOMItem[];
  categories: CategoryMaster[];
  rawComponentDisplayNames: RawComponentDisplayNameMaster[];
  transactions: InventoryTransaction[];
  rawComponentLots: RawComponentLot[];
  batches: BatchRecord[];
  documents: Record<string, unknown>[];
  planningReports: PlanningReport[];
}

export const DEMO_USER = 'Operations';

const isoDaysFromToday = (days: number, hour = 9): string => {
  const value = new Date();
  value.setHours(hour, 0, 0, 0);
  value.setDate(value.getDate() + days);
  return value.toISOString();
};

const dateDaysFromToday = (days: number): string => isoDaysFromToday(days).slice(0, 10);

const item = (
  component_id: string,
  component_name: string,
  type: Component['type'],
  category: string,
  subcategory: string,
  default_unit: string,
  unitCost: number,
  notes = 'Synthetic demo master-data record.',
): Component => ({
  component_id,
  component_name,
  type,
  category,
  subcategory,
  default_unit,
  unitCost,
  version: '01',
  notes,
  createdAt: isoDaysFromToday(-240),
  updatedAt: isoDaysFromToday(-3),
  updatedBy: DEMO_USER,
});

export const ELEMENT_IDS = {
  hydrogen: 'IGD-001HYD-01-KG-01',
  helium: 'IGD-002HEL-01-KG-01',
  lithium: 'IGD-003LIT-01-KG-01',
  beryllium: 'IGD-004BER-01-KG-01',
  boron: 'IGD-005BOR-01-KG-01',
  carbon: 'IGD-006CAR-01-KG-01',
  nitrogen: 'IGD-007NIT-01-KG-01',
  oxygen: 'IGD-008OXY-01-KG-01',
  neon: 'IGD-010NEO-01-KG-01',
  sodium: 'IGD-011SOD-01-KG-01',
  magnesium: 'IGD-012MAG-01-KG-01',
} as const;

export const COMPONENT_IDS = {
  can: 'PRM-001AUC-01-330ML-01',
  sachet: 'PRM-003ORO-04-25G-01',
  bottle: 'PRM-004COB-03-500ML-01',
  carton: 'SEC-001BOX-01-PCS-01',
  mailer: 'SEC-002MAI-02-PCS-01',
  tape: 'CSB-002TAP-03-ROLL-01',
  film: 'CSB-003FLM-06-ROLL-01',
  cap: 'DPS-002BTH-07-PCS-01',
  scoop: 'DPS-003SCP-09-PCS-01',
  auroraLabel: 'LBL-001AUC-01-PCS-01',
  cometLabel: 'LBL-004COB-02-PCS-01',
  pallet: 'PAL-001PAL-01-PCS-01',
} as const;

export const PRODUCT_IDS = {
  intermediate: 'PRT-001AUC-05-BASE-01',
  blended: 'PRT-002NEL-06-BULK-01',
  sachet: 'PRT-003ORO-01-SINGLESACHET-01',
  finished: 'PRT-001AUC-01-330ML-01',
  dispensing: 'PRT-004COB-03-500ML-01',
  sample: 'PRT-005LUL-02-SAMPLE-01',
  archived: 'PRT-006POT-01-250ML-01',
} as const;

const buildItems = (): Component[] => [
  item(ELEMENT_IDS.hydrogen, 'Hydrogen', 'INGREDIENT', '01 - Ambient storage', 'kg', 'kg', 1.22),
  item(ELEMENT_IDS.helium, 'Helium', 'INGREDIENT', '01 - Ambient storage', 'kg', 'kg', 2.18),
  item(ELEMENT_IDS.lithium, 'Lithium', 'INGREDIENT', '02 - Process laboratory', 'kg', 'kg', 5.4),
  item(ELEMENT_IDS.beryllium, 'Beryllium', 'INGREDIENT', '02 - Process laboratory', 'kg', 'kg', 8.1),
  item(ELEMENT_IDS.boron, 'Boron', 'INGREDIENT', '01 - Ambient storage', 'kg', 'kg', 3.65),
  item(ELEMENT_IDS.carbon, 'Carbon', 'INGREDIENT', '01 - Ambient storage', 'kg', 'kg', 2.72),
  item(ELEMENT_IDS.nitrogen, 'Nitrogen', 'INGREDIENT', '01 - Ambient storage', 'kg', 'kg', 1.84),
  item(ELEMENT_IDS.oxygen, 'Oxygen', 'INGREDIENT', '01 - Ambient storage', 'kg', 'kg', 0.91),
  item(ELEMENT_IDS.neon, 'Neon', 'INGREDIENT', '03 - Temperature controlled', 'kg', 'kg', 6.25),
  item(ELEMENT_IDS.sodium, 'Sodium', 'INGREDIENT', '03 - Temperature controlled', 'kg', 'kg', 4.15),
  item(ELEMENT_IDS.magnesium, 'Magnesium', 'INGREDIENT', 'Archived - ingredient', 'kg', 'kg', 4.8),
  item(COMPONENT_IDS.can, 'Aurora 330ml Can', 'PRIMARY_PACKAGING', '01 - Aluminium can', '330ml', 'pcs', 0.16),
  item(COMPONENT_IDS.sachet, 'Orbit 25g Sachet', 'PRIMARY_PACKAGING', '04 - Paper sachet', '25g', 'pcs', 0.08),
  item(COMPONENT_IDS.bottle, 'Comet 500ml Bottle', 'PRIMARY_PACKAGING', '03 - Recycled PET bottle', '500ml', 'pcs', 0.28),
  item(COMPONENT_IDS.carton, 'Shipping Carton', 'SECONDARY_PACKAGING', '01 - Shipping carton', '12 units', 'pcs', 0.72),
  item(COMPONENT_IDS.mailer, 'Paper Mailer', 'SECONDARY_PACKAGING', '02 - Paper mailer', '1 unit', 'pcs', 0.34),
  item(COMPONENT_IDS.tape, 'Paper Tape', 'CONSUMABLE', '03 - Reinforced paper tape', '50m', 'roll', 2.4),
  item(COMPONENT_IDS.film, 'Clear Wrapping Film', 'CONSUMABLE', '06 - Recycled film', '100m', 'roll', 4.6),
  item(COMPONENT_IDS.cap, 'Bottle Cap', 'DISPENSING', '07 - Flip cap', 'standard', 'pcs', 0.09),
  item(COMPONENT_IDS.scoop, 'Measuring Scoop', 'DISPENSING', '09 - Recycled scoop', '10ml', 'pcs', 0.12),
  item(COMPONENT_IDS.auroraLabel, 'Aurora Product Label', 'LABEL', '01 - Product label', '330ml', 'pcs', 0.04),
  item(COMPONENT_IDS.cometLabel, 'Comet Bottle Label', 'LABEL', '02 - Bottle label', '500ml', 'pcs', 0.05),
  item(COMPONENT_IDS.pallet, 'Standard Pallet', 'PALLET_LOGISTICS', '01 - Timber pallet', 'standard', 'pcs', 8.5),
];

const product = (
  sku_id: string,
  sku_name: string,
  family: string,
  category: string,
  format: string,
  unitProductionCost: number,
): Product => ({
  sku_id,
  sku_name,
  family,
  category,
  format,
  default_unit: 'kg',
  unitProductionCost,
  notes: 'Fictional product for the public demonstration.',
  createdAt: isoDaysFromToday(-220),
  updatedAt: isoDaysFromToday(-5),
  updatedBy: DEMO_USER,
});

const buildProducts = (): Product[] => [
  product(PRODUCT_IDS.intermediate, 'Aurora Base', '01 AURORA COLA', 'Intermediate', 'Component A', 1.82),
  product(PRODUCT_IDS.blended, 'Neon Lime Blend', '02 NEON LIME', 'Blended', 'Bulk blend', 1.56),
  product(PRODUCT_IDS.sachet, 'Orbit Orange Single Sachet', '03 ORBIT ORANGE', 'Commercial Product', 'Single Sachet 25g', 2.04),
  product(PRODUCT_IDS.finished, 'Aurora Cola 330ml', '01 AURORA COLA', 'Commercial Product', '330ml can', 1.76),
  product(PRODUCT_IDS.dispensing, 'Comet Berry Dispenser', '04 COMET BERRY', 'Commercial Dispensing', '500ml bottle', 2.24),
  product(PRODUCT_IDS.sample, 'Lunar Lemon Sample', '05 LUNAR LEMON', 'Sample Product', '50ml sample', 1.38),
  product(PRODUCT_IDS.archived, 'Polar Tonic Classic', '06 POLAR TONIC', 'Archived Commercial Product', '250ml bottle', 1.9),
];

type Ratio = [componentId: string, quantity: number];

const formula = (
  skuId: string,
  ratios: Ratio[],
  packaging: Ratio[] = [],
  variantId = 'DEFAULT',
  variantName = 'Standard',
  isDefaultVariant = true,
): BOMItem[] => [
  ...ratios.map(([componentId, ratio], index) => ({
    sku_id: skuId,
    bomVariantId: variantId,
    bomVariantName: variantName,
    isDefaultVariant,
    variantSortOrder: isDefaultVariant ? 0 : 1,
    component_id: componentId,
    qty_per_kg: ratio,
    unit: 'kg',
    line_kind: 'INGREDIENT',
    component_type: 'INGREDIENT' as const,
    notes: 'Synthetic demo formulation — not for manufacturing.',
    line_order: index + 1,
    updatedBy: DEMO_USER,
    createdAt: isoDaysFromToday(-180),
    updatedAt: isoDaysFromToday(-4),
  })),
  ...packaging.map(([componentId, ratio], index) => ({
    sku_id: skuId,
    bomVariantId: variantId,
    bomVariantName: variantName,
    isDefaultVariant,
    variantSortOrder: isDefaultVariant ? 0 : 1,
    component_id: componentId,
    qty_per_kg: ratio,
    unit: 'pcs',
    line_kind: 'PACKAGING',
    component_type: 'PRIMARY_PACKAGING' as const,
    notes: 'Synthetic packaging allowance.',
    line_order: ratios.length + index + 1,
    updatedBy: DEMO_USER,
    createdAt: isoDaysFromToday(-180),
    updatedAt: isoDaysFromToday(-4),
  })),
];

const buildRecipes = (): BOMItem[] => [
  ...formula(PRODUCT_IDS.intermediate, [
    [ELEMENT_IDS.hydrogen, 0.35], [ELEMENT_IDS.carbon, 0.25], [ELEMENT_IDS.oxygen, 0.2],
    [ELEMENT_IDS.nitrogen, 0.1], [ELEMENT_IDS.neon, 0.1],
  ]),
  ...formula(PRODUCT_IDS.blended, [
    [ELEMENT_IDS.oxygen, 0.4], [ELEMENT_IDS.hydrogen, 0.25], [ELEMENT_IDS.carbon, 0.15],
    [ELEMENT_IDS.sodium, 0.1], [ELEMENT_IDS.neon, 0.1],
  ]),
  ...formula(PRODUCT_IDS.sachet, [
    [ELEMENT_IDS.carbon, 0.3], [ELEMENT_IDS.nitrogen, 0.25], [ELEMENT_IDS.oxygen, 0.25],
    [ELEMENT_IDS.lithium, 0.1], [ELEMENT_IDS.helium, 0.1],
  ], [[COMPONENT_IDS.sachet, 40], [COMPONENT_IDS.carton, 1]]),
  ...formula(PRODUCT_IDS.finished, [
    [ELEMENT_IDS.oxygen, 0.45], [ELEMENT_IDS.hydrogen, 0.25], [ELEMENT_IDS.carbon, 0.15],
    [ELEMENT_IDS.nitrogen, 0.1], [ELEMENT_IDS.sodium, 0.05],
  ], [[COMPONENT_IDS.can, 3], [COMPONENT_IDS.auroraLabel, 3], [COMPONENT_IDS.carton, 0.25]]),
  ...formula(PRODUCT_IDS.finished, [
    [ELEMENT_IDS.oxygen, 0.4], [ELEMENT_IDS.hydrogen, 0.3], [ELEMENT_IDS.carbon, 0.15],
    [ELEMENT_IDS.nitrogen, 0.1], [ELEMENT_IDS.neon, 0.05],
  ], [[COMPONENT_IDS.can, 3], [COMPONENT_IDS.auroraLabel, 3], [COMPONENT_IDS.carton, 0.25]], 'LIGHT', 'Light', false),
  ...formula(PRODUCT_IDS.dispensing, [
    [ELEMENT_IDS.oxygen, 0.4], [ELEMENT_IDS.hydrogen, 0.3], [ELEMENT_IDS.neon, 0.15],
    [ELEMENT_IDS.carbon, 0.1], [ELEMENT_IDS.helium, 0.05],
  ], [[COMPONENT_IDS.bottle, 2], [COMPONENT_IDS.cap, 2], [COMPONENT_IDS.cometLabel, 2]]),
  ...formula(PRODUCT_IDS.sample, [
    [ELEMENT_IDS.oxygen, 0.5], [ELEMENT_IDS.hydrogen, 0.2], [ELEMENT_IDS.carbon, 0.15],
    [ELEMENT_IDS.nitrogen, 0.1], [ELEMENT_IDS.neon, 0.05],
  ], [[COMPONENT_IDS.bottle, 1], [COMPONENT_IDS.cometLabel, 1]]),
];

const buildCategories = (): CategoryMaster[] => [
  ['INGREDIENT', '01', 'Ambient storage'],
  ['INGREDIENT', '02', 'Process laboratory'],
  ['INGREDIENT', '03', 'Temperature controlled'],
  ['PRIMARY_PACKAGING', '01', 'Aluminium can'],
  ['PRIMARY_PACKAGING', '03', 'Recycled PET bottle'],
  ['PRIMARY_PACKAGING', '04', 'Paper sachet'],
  ['SECONDARY_PACKAGING', '01', 'Shipping carton'],
  ['SECONDARY_PACKAGING', '02', 'Paper mailer'],
  ['CONSUMABLE', '03', 'Reinforced paper tape'],
  ['CONSUMABLE', '06', 'Recycled film'],
  ['DISPENSING', '07', 'Flip cap'],
  ['DISPENSING', '09', 'Recycled scoop'],
  ['LABEL', '01', 'Product label'],
  ['LABEL', '02', 'Bottle label'],
  ['PALLET_LOGISTICS', '01', 'Timber pallet'],
].map(([type, category_code, category_label], index) => ({
  id: `CAT-${String(index + 1).padStart(3, '0')}`,
  type: type as CategoryMaster['type'],
  category_code,
  category_label,
  updatedBy: DEMO_USER,
  createdAt: isoDaysFromToday(-250),
  updatedAt: isoDaysFromToday(-5),
}));

const buildDisplayNames = (): RawComponentDisplayNameMaster[] => ([
  { id: 'NAME-001', type: 'SECONDARY_PACKAGING', display_name: 'Shipping Carton', id_core: '001BOX' },
  { id: 'NAME-002', type: 'SECONDARY_PACKAGING', display_name: 'Paper Mailer', id_core: '002MAI' },
  { id: 'NAME-003', type: 'CONSUMABLE', display_name: 'Paper Tape', id_core: '002TAP' },
  { id: 'NAME-004', type: 'CONSUMABLE', display_name: 'Clear Wrapping Film', id_core: '003FLM' },
  { id: 'NAME-005', type: 'DISPENSING', display_name: 'Bottle Cap', id_core: '002BTH' },
  { id: 'NAME-006', type: 'DISPENSING', display_name: 'Measuring Scoop', id_core: '003SCP' },
  { id: 'NAME-007', type: 'PALLET_LOGISTICS', display_name: 'Standard Pallet', id_core: '001PAL' },
] as Array<Pick<RawComponentDisplayNameMaster, 'id' | 'type' | 'display_name' | 'id_core'>>)
  .map((row) => ({ ...row, updatedBy: DEMO_USER, createdAt: isoDaysFromToday(-200), updatedAt: isoDaysFromToday(-4) }));

const releasedLot = (
  index: number,
  itemId: string,
  quantity: number,
  unitPrice: number,
  location: RawComponentLot['location'],
): RawComponentLot => ({
  lot_record_id: `LOT-ELEMENT-${String(index).padStart(3, '0')}`,
  qc_number: `QC-DEMO-${String(index).padStart(4, '0')}`,
  workflow_stage: 'RELEASED',
  itemId,
  ordered_qty: quantity,
  received_qty: quantity,
  unit: 'kg',
  planned_unit_price: unitPrice,
  unit_price: unitPrice,
  shipping_cost: 20,
  location,
  supplier: index % 2 ? 'Demo Supplier Alpha' : 'Demo Supplier Beta',
  procurementRef: `PO-DEMO-${1200 + index}`,
  procurementNotes: 'Synthetic delivery record.',
  paidDate: dateDaysFromToday(-75),
  expectedDeliveryDate: dateDaysFromToday(-70),
  deliveryDate: dateDaysFromToday(-68 + index),
  mfgBatch: `MFG-DEMO-${index}`,
  mfgDate: dateDaysFromToday(-120),
  expDate: dateDaysFromToday(500),
  qcStatus: 'QC passed',
  qcNotes: 'Released for demonstration purposes.',
  coaStored: 'Yes',
  sdsStored: 'Yes',
  tdsStored: 'Yes',
  manufacturer: 'Demo Manufacturer One',
  checkMaterial: 'Pass',
  checkCorrectItem: 'Pass',
  checkCorrectQuantity: 'Pass',
  registeredAt: isoDaysFromToday(-68 + index),
  registeredBy: DEMO_USER,
  createdAt: isoDaysFromToday(-68 + index),
  updatedAt: isoDaysFromToday(-60 + index),
  updatedBy: DEMO_USER,
});

const lotQuantities: Array<[string, number, number, LocationName]> = [
  [ELEMENT_IDS.hydrogen, 900, 1.22, 'Riverside'],
  [ELEMENT_IDS.helium, 140, 2.18, 'Hilltop'],
  [ELEMENT_IDS.lithium, 85, 5.4, 'Riverside'],
  [ELEMENT_IDS.beryllium, 60, 8.1, 'Hilltop'],
  [ELEMENT_IDS.boron, 95, 3.65, 'Riverside'],
  [ELEMENT_IDS.carbon, 520, 2.72, 'Riverside'],
  [ELEMENT_IDS.nitrogen, 720, 1.84, 'Hilltop'],
  [ELEMENT_IDS.oxygen, 1250, 0.91, 'Hilltop'],
  [ELEMENT_IDS.neon, 310, 6.25, 'Riverside'],
  [ELEMENT_IDS.sodium, 190, 4.15, 'Hilltop'],
];

const buildRawLots = (): RawComponentLot[] => [
  ...lotQuantities.map(([itemId, qty, price, location], index) => releasedLot(index + 1, itemId, qty, price, location)),
  {
    ...releasedLot(90, ELEMENT_IDS.carbon, 120, 2.8, 'Riverside'),
    lot_record_id: 'LOT-DEMO-QUARANTINE',
    qc_number: 'QC-DEMO-QUARANTINE',
    workflow_stage: 'QUARANTINE',
    qcStatus: 'Pending',
    qcNotes: 'Awaiting synthetic review.',
    deliveryDate: dateDaysFromToday(-1),
    registeredAt: isoDaysFromToday(-2),
    createdAt: isoDaysFromToday(-2),
    updatedAt: isoDaysFromToday(-1),
  },
  {
    ...releasedLot(91, ELEMENT_IDS.oxygen, 75, 0.88, ''),
    lot_record_id: 'LOT-DEMO-PREARRIVAL',
    qc_number: '',
    workflow_stage: 'PRE_ARRIVAL',
    received_qty: 0,
    qcStatus: 'Pending',
    expectedDeliveryDate: dateDaysFromToday(9),
    deliveryDate: '',
    registeredAt: isoDaysFromToday(-4),
    createdAt: isoDaysFromToday(-4),
    updatedAt: isoDaysFromToday(-2),
  },
  {
    ...releasedLot(92, ELEMENT_IDS.boron, 25, 3.7, 'Hilltop'),
    lot_record_id: 'LOT-DEMO-REJECTED',
    qc_number: 'QC-DEMO-REJECTED',
    workflow_stage: 'REJECTED',
    qcStatus: 'Rejected',
    qcNotes: 'Rejected synthetic example.',
    registeredAt: isoDaysFromToday(-13),
    createdAt: isoDaysFromToday(-13),
    updatedAt: isoDaysFromToday(-12),
  },
];

const tx = (
  id: string,
  days: number,
  input: Omit<InventoryTransaction, 'id' | 'createdAt' | 'updatedAt'>,
): InventoryTransaction => ({
  id,
  ...input,
  createdAt: isoDaysFromToday(days),
  updatedAt: isoDaysFromToday(days),
});

const buildTransactions = (items: Component[], products: Product[], lots: RawComponentLot[]): InventoryTransaction[] => {
  const byItem = new Map(items.map((row) => [row.component_id, row]));
  const byProduct = new Map(products.map((row) => [row.sku_id, row]));
  const ledger: InventoryTransaction[] = [];

  lotQuantities.forEach(([itemId, qty, price, location], index) => {
    const lot = lots[index];
    const label = byItem.get(itemId)?.component_name || itemId;
    ledger.push(tx(`TX-COMP-IN-${index + 1}`, -68 + index, {
      type: 'IN', category: 'COMPONENT', itemId, itemName: label, quantity: qty, unit: 'kg', location,
      batchNumber: lot.qc_number, supplier: lot.supplier, unitCost: price, reference: lot.procurementRef,
      reason: 'GOODS_IN', sourceTab: 'Goods In', user: DEMO_USER,
    }));
    [150, 90, 45, 18].forEach((daysAgo, usageIndex) => {
      const usage =
        itemId === ELEMENT_IDS.helium && usageIndex === 3
          ? 100
          : Math.max(2, Math.round(qty * (0.018 + usageIndex * 0.006)));
      ledger.push(tx(`TX-COMP-OUT-${index + 1}-${usageIndex + 1}`, -daysAgo, {
        type: 'OUT', category: 'COMPONENT', itemId, itemName: label, quantity: usage, unit: 'kg', location,
        batchNumber: lot.qc_number, unitCost: price, reference: `BATCH-DEMO-${index + 1}-${usageIndex + 1}`,
        reason: 'PRODUCTION', sourceTab: 'Component Out', user: DEMO_USER,
      }));
    });
  });

  const packagingReceipts: Array<[string, number, string, number]> = [
    [COMPONENT_IDS.can, 8000, 'pcs', 0.16], [COMPONENT_IDS.sachet, 5000, 'pcs', 0.08],
    [COMPONENT_IDS.bottle, 2200, 'pcs', 0.28], [COMPONENT_IDS.carton, 1200, 'pcs', 0.72],
    [COMPONENT_IDS.mailer, 900, 'pcs', 0.34], [COMPONENT_IDS.tape, 80, 'roll', 2.4],
    [COMPONENT_IDS.film, 65, 'roll', 4.6], [COMPONENT_IDS.cap, 2500, 'pcs', 0.09],
    [COMPONENT_IDS.scoop, 1800, 'pcs', 0.12], [COMPONENT_IDS.auroraLabel, 7500, 'pcs', 0.04],
    [COMPONENT_IDS.cometLabel, 2100, 'pcs', 0.05], [COMPONENT_IDS.pallet, 35, 'pcs', 8.5],
  ];
  packagingReceipts.forEach(([itemId, qty, unit, unitCost], index) => {
    ledger.push(tx(`TX-PACK-IN-${index + 1}`, -55 + index, {
      type: 'IN', category: 'COMPONENT', itemId, itemName: byItem.get(itemId)?.component_name,
      quantity: qty, unit, location: index % 2 ? 'Hilltop' : 'Riverside', batchNumber: `PKG-DEMO-${index + 1}`,
      supplier: 'Demo Supplier Packaging', unitCost, reference: `PO-PACK-${1300 + index}`,
      reason: 'GOODS_IN', sourceTab: 'Goods In', user: DEMO_USER,
    }));
  });

  const batches: Array<[string, string, number, number, InventoryTransaction['location']]> = [
    [PRODUCT_IDS.finished, `${PRODUCT_IDS.finished}::AUR-260901`, 600, 1.76, 'Riverside'],
    [PRODUCT_IDS.dispensing, `${PRODUCT_IDS.dispensing}::COM-260905`, 420, 2.24, 'Hilltop'],
    [PRODUCT_IDS.sachet, `${PRODUCT_IDS.sachet}::ORB-260910`, 280, 2.04, 'Riverside'],
    [PRODUCT_IDS.sample, `${PRODUCT_IDS.sample}::LUN-260912`, 90, 1.38, 'Hilltop'],
  ];
  batches.forEach(([sku, batch, qty, unitCost, location], index) => {
    if (index === 2) return; // QC-passed fixture remains in quarantine until the demo user releases it.
    ledger.push(tx(`TX-PROD-IN-${index + 1}`, -22 + index * 3, {
      type: 'IN', category: 'PRODUCT', itemId: sku, itemName: byProduct.get(sku)?.sku_name,
      quantity: qty, unit: 'kg', location, batchNumber: batch, unitCost, reference: `PROD-${index + 1}`,
      reason: 'QC Release', sourceTab: 'Product Reception', user: DEMO_USER,
    }));
  });
  ledger.push(
    tx('TX-PROD-OUT-1', -6, {
      type: 'OUT', category: 'PRODUCT', itemId: PRODUCT_IDS.finished, itemName: byProduct.get(PRODUCT_IDS.finished)?.sku_name,
      quantity: 125, unit: 'kg', location: 'Riverside', batchNumber: batches[0][1], unitCost: 1.76,
      unitSalePrice: 3.2, salesRep: 'Demo Representative', reference: 'ORDER-DEMO-1001',
      reason: 'Dispatch: Paid', sourceTab: 'Product dispatch', user: DEMO_USER,
    }),
    tx('TX-PROD-SAMPLE-1', -4, {
      type: 'OUT', category: 'PRODUCT', itemId: PRODUCT_IDS.sample, itemName: byProduct.get(PRODUCT_IDS.sample)?.sku_name,
      quantity: 15, unit: 'kg', location: 'Hilltop', batchNumber: batches[3][1], unitCost: 1.38,
      unitSalePrice: 0, salesRep: 'Demo Representative', reference: 'ORDER-DEMO-1001',
      reason: 'Dispatch: Sample', sourceTab: 'Product dispatch', user: DEMO_USER,
    }),
    tx('TX-PROD-RESERVE-1', -2, {
      type: 'OUT', category: 'PRODUCT', itemId: PRODUCT_IDS.dispensing, itemName: byProduct.get(PRODUCT_IDS.dispensing)?.sku_name,
      quantity: 55, unit: 'kg', location: 'Hilltop', batchNumber: batches[1][1], unitCost: 2.24,
      unitSalePrice: 4.1, salesRep: 'Demo Representative', reference: 'ORDER-DEMO-1002',
      reason: 'RESERVATION', sourceTab: 'Staging', notes: 'Demo Customer Alpha', user: DEMO_USER,
    }),
  );
  return ledger.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
};

const buildBatches = (): BatchRecord[] => [
  {
    id: `${PRODUCT_IDS.finished}::AUR-260901`, batch_id: `${PRODUCT_IDS.finished}::AUR-260901`, batch_number: 'AUR-260901',
    batchType: 'PACK', productSku: PRODUCT_IDS.finished, productName: 'Aurora Cola 330ml', bomVariantId: 'DEFAULT',
    bomVariantName: 'Standard', plannedQuantity: 620, actualYield: 600, status: 'Released', location: 'Riverside',
    unitProductionCost: 1.76, qcDisposition: 'standard', createdAt: isoDaysFromToday(-24), updatedAt: isoDaysFromToday(-22),
  },
  {
    id: `${PRODUCT_IDS.dispensing}::COM-260905`, batch_id: `${PRODUCT_IDS.dispensing}::COM-260905`, batch_number: 'COM-260905',
    batchType: 'PACK', productSku: PRODUCT_IDS.dispensing, productName: 'Comet Berry Dispenser', bomVariantId: 'DEFAULT',
    bomVariantName: 'Standard', plannedQuantity: 430, actualYield: 420, status: 'Released', location: 'Hilltop',
    unitProductionCost: 2.24, qcDisposition: 'standard', createdAt: isoDaysFromToday(-20), updatedAt: isoDaysFromToday(-19),
  },
  {
    id: `${PRODUCT_IDS.sachet}::ORB-260910`, batch_id: `${PRODUCT_IDS.sachet}::ORB-260910`, batch_number: 'ORB-260910',
    batchType: 'PACK', productSku: PRODUCT_IDS.sachet, productName: 'Orbit Orange Single Sachet', bomVariantId: 'DEFAULT',
    bomVariantName: 'Standard', plannedQuantity: 300, actualYield: 280, status: 'QC_passed', location: 'Riverside',
    unitProductionCost: 2.04, qcDisposition: 'standard', createdAt: isoDaysFromToday(-16), updatedAt: isoDaysFromToday(-15),
  },
  {
    id: `${PRODUCT_IDS.sample}::LUN-260912`, batch_id: `${PRODUCT_IDS.sample}::LUN-260912`, batch_number: 'LUN-260912',
    batchType: 'PACK', productSku: PRODUCT_IDS.sample, productName: 'Lunar Lemon Sample', bomVariantId: 'DEFAULT',
    bomVariantName: 'Standard', plannedQuantity: 100, actualYield: 90, status: 'Released', location: 'Hilltop',
    unitProductionCost: 1.38, qcDisposition: 'standard', createdAt: isoDaysFromToday(-11), updatedAt: isoDaysFromToday(-10),
  },
  {
    id: `${PRODUCT_IDS.blended}::NEO-260920`, batch_id: `${PRODUCT_IDS.blended}::NEO-260920`, batch_number: 'NEO-260920',
    batchType: 'BULK', productSku: PRODUCT_IDS.blended, productName: 'Neon Lime Blend', bomVariantId: 'DEFAULT',
    bomVariantName: 'Standard', plannedQuantity: 500, actualYield: 0, status: 'QC_rejected', location: 'Riverside',
    unitProductionCost: 1.56, qcDisposition: 'final_rejected', createdAt: isoDaysFromToday(-5), updatedAt: isoDaysFromToday(-3),
  },
  {
    id: `${PRODUCT_IDS.intermediate}::AUR-260922`, batch_id: `${PRODUCT_IDS.intermediate}::AUR-260922`, batch_number: 'AUR-260922',
    batchType: 'BULK', productSku: PRODUCT_IDS.intermediate, productName: 'Aurora Base', bomVariantId: 'DEFAULT',
    bomVariantName: 'Standard', plannedQuantity: 260, actualYield: 250, status: 'On hold', location: 'Hilltop',
    unitProductionCost: 1.82, qcDisposition: 'rework_pending', createdAt: isoDaysFromToday(-3), updatedAt: isoDaysFromToday(-2),
  },
];

export const DEMO_SUPPLIERS: Supplier[] = Object.values(ELEMENT_IDS).flatMap((componentId, index) => [
  {
    component_id: componentId,
    supplier_name: index % 2 ? 'Demo Supplier Alpha' : 'Demo Supplier Beta',
    lead_time_days: 7 + (index % 4) * 3,
    moq: 50,
    pack_size: 25,
  },
]);

export const DEMO_OPEN_POS: OpenPO[] = [
  { component_id: ELEMENT_IDS.oxygen, incoming_qty: 75 },
  { component_id: ELEMENT_IDS.carbon, incoming_qty: 120 },
];

export const createDemoDatabase = (): DemoDatabase => {
  const items = buildItems();
  const products = buildProducts();
  const rawComponentLots = buildRawLots();
  return {
    schemaVersion: 2,
    items,
    products,
    recipes: buildRecipes(),
    categories: buildCategories(),
    rawComponentDisplayNames: buildDisplayNames(),
    transactions: buildTransactions(items, products, rawComponentLots),
    rawComponentLots,
    batches: buildBatches(),
    documents: [
      {
        doc_id: 'DOC-DEMO-MANIFEST-01',
        doc_type: 'DISPATCH_MANIFEST',
        reference_id: 'ORDER-DEMO-1001',
        content_summary: 'Synthetic dispatch manifest.',
        createdAt: isoDaysFromToday(-6),
        updatedAt: isoDaysFromToday(-6),
        updatedBy: DEMO_USER,
      },
      {
        doc_id: 'DOC-DEMO-QUARANTINE-01',
        doc_type: 'COMP_OUT_QUARANTINE_META',
        reference_id: 'DEMO-HOLD',
        quarantine_group: 'DEMO-HOLD',
        quarantine_reason: 'Training example',
        quarantine_note: 'Synthetic quarantine details.',
        createdAt: isoDaysFromToday(-2),
        updatedAt: isoDaysFromToday(-2),
        updatedBy: DEMO_USER,
      },
    ],
    planningReports: [],
  };
};
