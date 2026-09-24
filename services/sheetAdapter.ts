
import { normalizeHeader } from './sheetsSchema';

/**
 * Universal adapter for local tabular data mapping.
 */

// Fields that are identifiers/references and must remain strings even if fully numeric.
const STRING_IDENTITY_KEYS = new Set<string>([
  'id',
  'id_core',
  'itemId',
  'component_id',
  'sku_id',
  'productSku',
  'batch_id',
  'batchNumber',
  'batch_number',
  'mfgBatch',
  'ref_id',
  'report_id',
  'snapshot_id',
  'log_id',
  'entity_id',
  'equipment_id',
  'reference'
]);
const BOOLEAN_KEYS = new Set<string>(['isDefaultVariant']);

function isIdentityKey(key: string): boolean {
  if (!key) return false;
  if (STRING_IDENTITY_KEYS.has(key)) return true;
  // Keep *_id fields stable as strings across all datasets.
  return /(^id$|_id$|Id$)/.test(key);
}

function parseValueByKey(canonicalKey: string, rawValue: any): any {
  if (rawValue === "" || rawValue === null || rawValue === undefined) {
    return null;
  }
  if (typeof rawValue !== 'string') return rawValue;

  const trimmed = rawValue.trim();
  if (isIdentityKey(canonicalKey)) return trimmed;
  if (BOOLEAN_KEYS.has(canonicalKey)) {
    const token = trimmed.toLowerCase();
    if (!token) return null;
    if (['true', 'yes', 'y', '1'].includes(token)) return true;
    if (['false', 'no', 'n', '0'].includes(token)) return false;
    return rawValue;
  }

  // Auto-detect numbers: avoid parsing leading-zero strings as numbers unless it's just '0'
  if (trimmed !== '' && !isNaN(Number(trimmed)) && (!trimmed.startsWith('0') || trimmed === '0' || trimmed.includes('.'))) {
    return Number(trimmed);
  }
  return rawValue;
}

let hasWarnedDeprecatedMasterStockFields = false;

function warnDeprecatedMasterStockFieldsIfPresent(item: any, contextKeys: readonly string[]) {
  if (hasWarnedDeprecatedMasterStockFields) return;
  if (!item || typeof item !== 'object') return;
  const isComponentContext = contextKeys.some(k => String(k) === 'component_id');
  if (!isComponentContext) return;

  const hasDeprecatedStockField =
    Object.prototype.hasOwnProperty.call(item, 'on_hand_qty') ||
    Object.prototype.hasOwnProperty.call(item, 'stock_by_location');

  if (hasDeprecatedStockField) {
    hasWarnedDeprecatedMasterStockFields = true;
    console.warn('Deprecated master stock fields are not used; stock derives from inventory_ledger.');
  }
}

/**
 * Parses raw grid data (headers + rows) into a list of typed objects.
 * Useful for processing imported tabular data that has not been pre-mapped.
 */
export function parseGridToObjects<T>(headers: string[], rows: any[][], contextKeys: readonly string[]): T[] {
  const keyMap = headers.map(h => normalizeHeader(h, contextKeys));
  
  return rows.map(row => {
    const obj: any = {};
    row.forEach((cell, i) => {
      const canonicalKey = keyMap[i];
      if (!canonicalKey) return;
      obj[canonicalKey] = parseValueByKey(canonicalKey, cell);
    });

    warnDeprecatedMasterStockFieldsIfPresent(obj, contextKeys);
    
    return obj as T;
  });
}

/**
 * Normalizes an array of objects where keys might be raw column headers or alias strings.
 * Ensures the resulting objects strictly use canonical keys defined in the schema.
 */
export function normalizeObjects<T>(data: any[], contextKeys: readonly string[]): T[] {
  if (!Array.isArray(data)) return [];
  
  return data.map(item => {
    if (!item) return null;
    const normalized: any = {};
    const rawKeys = Object.keys(item);

    warnDeprecatedMasterStockFieldsIfPresent(item, contextKeys);
    
    // Map existing data to canonical keys
    contextKeys.forEach(canonicalKey => {
      // Find ALL raw keys that map to this canonical key (direct match or alias)
      const candidates = rawKeys.filter(rk => 
        rk === canonicalKey || normalizeHeader(rk, contextKeys) === canonicalKey
      );

      // Value Selection Priority:
      // 1. First non-empty value found among candidates
      // 2. Fallback to first candidate's value if all are empty
      let value = null;
      
      for (const key of candidates) {
        const v = item[key];
        if (v !== null && v !== undefined && v !== "") {
          value = v;
          break;
        }
      }
      
      if (value === null && candidates.length > 0) {
        value = item[candidates[0]];
      }

      value = parseValueByKey(canonicalKey, value);

      normalized[canonicalKey] = value;
    });
    
    // Preserve common metadata fields not explicitly in some schemas.
    ['createdAt', 'updatedAt'].forEach(f => {
      if (item[f] !== undefined && normalized[f] === undefined) {
        normalized[f] = item[f];
      }
    });
    
    return normalized as T;
  }).filter(Boolean) as T[];
}

/**
 * Converts a typed object back into a row array that matches the provided headers order.
 * Ensures data is serialized according to the current visual column order.
 */
export function objectToRow(obj: any, headers: string[], contextKeys: readonly string[]): any[] {
  return headers.map(header => {
    const canonicalKey = normalizeHeader(header, contextKeys);
    const value = obj[canonicalKey];
    
    if (value === null || value === undefined) return "";
    if (typeof value === 'object') return JSON.stringify(value);
    return value;
  });
}
