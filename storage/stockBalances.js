export const STOCK_BALANCE_ENTITY = "stock_balances";
export const STOCK_BALANCE_UNBATCHED_KEY = "No Batch";
export const STOCK_BALANCE_UNSPECIFIED_LOCATION = "UNSPECIFIED";
export const STOCK_BALANCE_EPSILON = 0.000001;

export const STOCK_BALANCE_HEADERS = [
  "stock_balance_id",
  "category",
  "itemId",
  "itemName",
  "batchNumber",
  "location",
  "unit",
  "onHandQty",
  "availableQty",
  "lastLedgerTxnId",
  "sourceLedgerUpdatedAt",
  "updatedAt",
  "updatedBy",
  "schemaVersion",
];

export const normalizeStockBalanceToken = (value) => String(value ?? "").trim();

const normalizeStatusKey = (value) =>
  normalizeStockBalanceToken(value).toLowerCase().replace(/[\s_-]+/g, "_");

export const normalizeStockBalanceCategory = (value) => normalizeStockBalanceToken(value).toUpperCase();
const normalizeCategory = normalizeStockBalanceCategory;

const toNumber = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

const nearZero = (value) => (Math.abs(value) < STOCK_BALANCE_EPSILON ? 0 : value);

const eventTimeMs = (row) => {
  const timestamp = new Date(row?.updatedAt || row?.createdAt || row?.date || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const isRejectedStatus = (status) => {
  const normalized = normalizeStatusKey(status);
  return normalized === "rejected" || normalized === "qc_rejected";
};

export const isStockBalanceBlockedReason = (reason) => {
  const text = normalizeStockBalanceToken(reason).toLowerCase();
  if (!text) return false;
  return (
    text.includes("reservation") ||
    text.includes("quarantine") ||
    text.includes("blocked") ||
    text.includes("on hold")
  );
};

const setIfNewer = (target, row, keys) => {
  const previousTime = eventTimeMs(target.__sourceRow);
  const nextTime = eventTimeMs(row);
  if (target.__sourceRow && previousTime > nextTime) return;
  keys.forEach((key) => {
    const value = normalizeStockBalanceToken(row?.[key]);
    if (value) target[key] = value;
  });
  target.__sourceRow = row;
};

const addLookupAlias = (lookup, id, value) => {
  const key = normalizeStockBalanceToken(id);
  const text = normalizeStockBalanceToken(value);
  if (key && text && !lookup.has(key)) lookup.set(key, text);
};

const buildMasterLookup = (rows, idKeys, valueKeys) => {
  const lookup = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    idKeys.forEach((idKey) => {
      valueKeys.forEach((valueKey) => addLookupAlias(lookup, row?.[idKey], row?.[valueKey]));
    });
  });
  return lookup;
};

export const resolveStockBalanceId = ({ category, itemId, batchNumber, location }) =>
  [
    normalizeCategory(category),
    normalizeStockBalanceToken(itemId),
    normalizeStockBalanceToken(batchNumber) || STOCK_BALANCE_UNBATCHED_KEY,
    normalizeStockBalanceToken(location) || STOCK_BALANCE_UNSPECIFIED_LOCATION,
  ].join("::");

export const resolveStockBalanceIdFromLedgerRow = (row) => {
  const itemId = normalizeStockBalanceToken(row?.itemId);
  const category = normalizeCategory(row?.category);
  if (!itemId || (category !== "COMPONENT" && category !== "PRODUCT")) return "";
  return resolveStockBalanceId({
    category,
    itemId,
    batchNumber: row?.batchNumber,
    location: row?.location,
  });
};

export const getRawLotStockBalanceBatchKeys = (row) => [
  row?.qc_number,
  row?.lot_record_id,
].map(normalizeStockBalanceToken).filter(Boolean);

export const getProductBatchStockBalanceBatchKeys = (row) => [
  row?.batch_number,
  row?.batch_id,
  row?.id,
].map(normalizeStockBalanceToken).filter(Boolean);

export const resolveAffectedStockBalanceIds = ({
  entityName,
  before = null,
  after = null,
  transactions = [],
} = {}) => {
  const ids = new Set();
  const normalizedEntity = normalizeStockBalanceToken(entityName);
  const addLedgerId = (row) => {
    const id = resolveStockBalanceIdFromLedgerRow(row);
    if (id) ids.add(id);
  };

  if (normalizedEntity === "inventory_ledger") {
    addLedgerId(before);
    addLedgerId(after);
    return ids;
  }

  if (normalizedEntity === "items_master" || normalizedEntity === "products_master") {
    const category = normalizedEntity === "items_master" ? "COMPONENT" : "PRODUCT";
    const masterIds = new Set();
    [before, after].forEach((row) => {
      const id = normalizedEntity === "items_master"
        ? normalizeStockBalanceToken(row?.component_id || row?.id)
        : normalizeStockBalanceToken(row?.sku_id || row?.id);
      if (id) masterIds.add(id);
    });
    (Array.isArray(transactions) ? transactions : []).forEach((tx) => {
      if (normalizeCategory(tx?.category) !== category) return;
      if (masterIds.has(normalizeStockBalanceToken(tx?.itemId))) addLedgerId(tx);
    });
    return ids;
  }

  const batchKeys = new Set();
  if (normalizedEntity === "raw_component_lot") {
    [...getRawLotStockBalanceBatchKeys(before), ...getRawLotStockBalanceBatchKeys(after)]
      .forEach((key) => batchKeys.add(key));
    (Array.isArray(transactions) ? transactions : []).forEach((tx) => {
      if (normalizeCategory(tx?.category) !== "COMPONENT") return;
      if (batchKeys.has(normalizeStockBalanceToken(tx?.batchNumber))) addLedgerId(tx);
    });
    return ids;
  }

  if (normalizedEntity === "batches_master") {
    [...getProductBatchStockBalanceBatchKeys(before), ...getProductBatchStockBalanceBatchKeys(after)]
      .forEach((key) => batchKeys.add(key));
    (Array.isArray(transactions) ? transactions : []).forEach((tx) => {
      if (normalizeCategory(tx?.category) !== "PRODUCT") return;
      if (batchKeys.has(normalizeStockBalanceToken(tx?.batchNumber))) addLedgerId(tx);
    });
  }

  return ids;
};

export const buildStockBalanceRows = ({
  transactions = [],
  rawComponentLots = [],
  productBatches = [],
  itemsMaster = [],
  productsMaster = [],
  updatedBy = "system",
  updatedAt = new Date().toISOString(),
  schemaVersion = 3.6,
} = {}) => {
  const productNameById = buildMasterLookup(
    productsMaster,
    ["sku_id", "id"],
    ["sku_name", "itemName", "name"],
  );
  const productUnitById = buildMasterLookup(
    productsMaster,
    ["sku_id", "id"],
    ["default_unit", "unit"],
  );
  const componentNameById = buildMasterLookup(
    itemsMaster,
    ["component_id", "id"],
    ["component_name", "itemName", "name"],
  );
  const componentUnitById = buildMasterLookup(
    itemsMaster,
    ["component_id", "id"],
    ["default_unit", "unit"],
  );

  const componentStatusByBatch = new Map();
  rawComponentLots.forEach((lot) => {
    const batch = normalizeStockBalanceToken(lot?.qc_number || lot?.lot_record_id);
    if (batch) componentStatusByBatch.set(batch, normalizeStatusKey(lot?.qcStatus));
  });

  const productStatusByBatch = new Map();
  productBatches.forEach((batch) => {
    const keys = [
      batch?.batch_number,
      batch?.batch_id,
      batch?.id,
    ].map(normalizeStockBalanceToken).filter(Boolean);
    keys.forEach((key) => productStatusByBatch.set(key, normalizeStatusKey(batch?.status)));
  });

  const balances = new Map();

  transactions.forEach((tx) => {
    const itemId = normalizeStockBalanceToken(tx?.itemId);
    if (!itemId) return;

    const category = normalizeCategory(tx?.category);
    if (category !== "COMPONENT" && category !== "PRODUCT") return;

    const batchNumber = normalizeStockBalanceToken(tx?.batchNumber) || STOCK_BALANCE_UNBATCHED_KEY;
    const location = normalizeStockBalanceToken(tx?.location) || STOCK_BALANCE_UNSPECIFIED_LOCATION;
    const status = category === "COMPONENT"
      ? componentStatusByBatch.get(batchNumber)
      : productStatusByBatch.get(batchNumber);
    if (isRejectedStatus(status)) return;

    const id = resolveStockBalanceId({ category, itemId, batchNumber, location });
    if (!balances.has(id)) {
      balances.set(id, {
        stock_balance_id: id,
        category,
        itemId,
        itemName: "",
        batchNumber,
        location,
        unit: "",
        onHandQty: 0,
        availableQty: 0,
        lastLedgerTxnId: "",
        sourceLedgerUpdatedAt: "",
        updatedAt,
        updatedBy,
        schemaVersion,
        __sourceRow: null,
        __sourceTime: 0,
      });
    }

    const balance = balances.get(id);
    const masterName = category === "PRODUCT" ? productNameById.get(itemId) : componentNameById.get(itemId);
    const masterUnit = category === "PRODUCT" ? productUnitById.get(itemId) : componentUnitById.get(itemId);
    if (!balance.itemName && masterName) balance.itemName = masterName;
    if (!balance.unit && masterUnit) balance.unit = masterUnit;

    const qty = toNumber(tx?.quantity);
    const type = normalizeCategory(tx?.type);
    const blocked = isStockBalanceBlockedReason(tx?.reason);
    const onHandDelta = type === "IN" ? qty : -qty;
    const availableDelta = type === "IN" ? (blocked ? 0 : qty) : -qty;
    balance.onHandQty += onHandDelta;
    balance.availableQty += availableDelta;

    setIfNewer(balance, tx, ["itemName", "unit"]);
    if (masterName) balance.itemName = masterName;
    if (masterUnit) balance.unit = masterUnit;
    const sourceTime = eventTimeMs(tx);
    if (sourceTime >= balance.__sourceTime) {
      balance.__sourceTime = sourceTime;
      balance.lastLedgerTxnId = normalizeStockBalanceToken(tx?.id || tx?.txnId || tx?.txn_id);
      balance.sourceLedgerUpdatedAt = normalizeStockBalanceToken(tx?.updatedAt || tx?.createdAt || tx?.date);
    }
  });

  return Array.from(balances.values())
    .map(({ __sourceRow, __sourceTime, ...row }) => ({
      ...row,
      onHandQty: nearZero(row.onHandQty),
      availableQty: nearZero(row.availableQty),
    }))
    .filter((row) => Math.abs(row.onHandQty) > STOCK_BALANCE_EPSILON || Math.abs(row.availableQty) > STOCK_BALANCE_EPSILON)
    .sort((left, right) => left.stock_balance_id.localeCompare(right.stock_balance_id));
};

export const stockBalanceRowsToLedgerStockLevels = (rows = []) => {
  const levels = {};
  rows.forEach((row) => {
    const itemId = normalizeStockBalanceToken(row?.itemId);
    if (!itemId) return;
    const batch = normalizeStockBalanceToken(row?.batchNumber) || STOCK_BALANCE_UNBATCHED_KEY;
    const location = normalizeStockBalanceToken(row?.location) || STOCK_BALANCE_UNSPECIFIED_LOCATION;
    const onHand = toNumber(row?.onHandQty);
    const available = toNumber(row?.availableQty);

    if (!levels[itemId]) {
      levels[itemId] = {
        totalOnHand: 0,
        totalAvailable: 0,
        byLocation: {},
        byBatch: {},
        byBatchLocation: {},
        total: 0,
        locations: {},
      };
    }

    const position = levels[itemId];
    position.totalOnHand += onHand;
    position.totalAvailable += available;
    if (!position.byLocation[location]) position.byLocation[location] = { onHand: 0, available: 0 };
    position.byLocation[location].onHand += onHand;
    position.byLocation[location].available += available;
    if (!position.byBatch[batch]) position.byBatch[batch] = { onHand: 0, available: 0 };
    position.byBatch[batch].onHand += onHand;
    position.byBatch[batch].available += available;
    if (!position.byBatchLocation[batch]) position.byBatchLocation[batch] = {};
    if (!position.byBatchLocation[batch][location]) {
      position.byBatchLocation[batch][location] = { onHand: 0, available: 0 };
    }
    position.byBatchLocation[batch][location].onHand += onHand;
    position.byBatchLocation[batch][location].available += available;
  });

  Object.values(levels).forEach((position) => {
    position.totalOnHand = nearZero(position.totalOnHand);
    position.totalAvailable = nearZero(position.totalAvailable);
    position.total = position.totalAvailable;
    position.locations = Object.fromEntries(
      Object.entries(position.byLocation).map(([location, state]) => [location, nearZero(state.available)]),
    );
  });

  return levels;
};
