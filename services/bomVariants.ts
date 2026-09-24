import { BOMItem } from '../types';

export const DEFAULT_BOM_VARIANT_ID = 'VAR-DEFAULT';
export const DEFAULT_BOM_VARIANT_NAME = 'Default';

const FORMULATION_COMPONENT_TYPES = new Set(['INGREDIENT', 'COMP_A_SKU', 'BLENDED_SKU']);
const SECTION_B_LINE_KINDS = new Set(['PACKAGING', 'CONSUMABLE']);

export interface BomVariantMeta {
  bomVariantId: string;
  bomVariantName: string;
  isDefaultVariant: boolean;
  variantSortOrder: number;
}

const normalizeSkuToken = (value: unknown): string =>
  String(value ?? '').trim().toLowerCase();

export const parseBooleanLike = (value: unknown, fallback = false): boolean => {
  if (typeof value === 'boolean') return value;
  const token = String(value ?? '').trim().toLowerCase();
  if (!token) return fallback;
  return ['1', 'true', 'yes', 'y'].includes(token);
};

export const normalizeBomVariantId = (value: unknown): string => {
  const token = String(value ?? '').trim();
  return token || DEFAULT_BOM_VARIANT_ID;
};

export const normalizeBomVariantName = (value: unknown, variantId?: string): string => {
  const token = String(value ?? '').trim();
  if (token) return token;
  return normalizeBomVariantId(variantId) === DEFAULT_BOM_VARIANT_ID
    ? DEFAULT_BOM_VARIANT_NAME
    : normalizeBomVariantId(variantId);
};

const toLineKindToken = (line: Partial<BOMItem>): string => {
  const rawLineKind = String(line.line_kind ?? '').trim().toUpperCase();
  if (rawLineKind) return rawLineKind;
  const componentType = String(line.component_type ?? '').trim().toUpperCase();
  if (FORMULATION_COMPONENT_TYPES.has(componentType)) return 'INGREDIENT';
  return 'PACKAGING';
};

export const normalizeLineKindForSectioning = (line: Partial<BOMItem>): string => {
  const token = toLineKindToken(line);
  if (token === 'INGREDIENT') return 'INGREDIENT';
  if (SECTION_B_LINE_KINDS.has(token)) return token;
  return FORMULATION_COMPONENT_TYPES.has(String(line.component_type ?? '').trim().toUpperCase())
    ? 'INGREDIENT'
    : 'PACKAGING';
};

export const isFormulationLine = (line: Partial<BOMItem>): boolean =>
  normalizeLineKindForSectioning(line) === 'INGREDIENT';

export const isPackagingLine = (line: Partial<BOMItem>): boolean =>
  !isFormulationLine(line);

export const normalizeBomLine = (line: BOMItem): BOMItem => {
  const bomVariantId = normalizeBomVariantId(line.bomVariantId);
  const normalizedLineKind = normalizeLineKindForSectioning(line);
  const inferredDefault = bomVariantId === DEFAULT_BOM_VARIANT_ID;
  const isDefaultVariant = parseBooleanLike(line.isDefaultVariant, inferredDefault);

  return {
    ...line,
    bomVariantId,
    bomVariantName: normalizeBomVariantName(line.bomVariantName, bomVariantId),
    isDefaultVariant,
    line_kind: normalizedLineKind,
    variantSortOrder: Number.isFinite(Number(line.variantSortOrder))
      ? Number(line.variantSortOrder)
      : undefined
  };
};

export const listBomVariantsForSku = (bom: BOMItem[], skuId: string): BomVariantMeta[] => {
  const rows = bom
    .filter(line => normalizeSkuToken(line.sku_id) === normalizeSkuToken(skuId))
    .map(normalizeBomLine);

  if (rows.length === 0) {
    return [{
      bomVariantId: DEFAULT_BOM_VARIANT_ID,
      bomVariantName: DEFAULT_BOM_VARIANT_NAME,
      isDefaultVariant: true,
      variantSortOrder: 1
    }];
  }

  const byVariant = new Map<string, BomVariantMeta>();
  rows.forEach((line, index) => {
    const variantId = normalizeBomVariantId(line.bomVariantId);
    const existing = byVariant.get(variantId);
    const sortOrder = Number.isFinite(Number(line.variantSortOrder))
      ? Number(line.variantSortOrder)
      : (existing?.variantSortOrder ?? index + 1);
    const next: BomVariantMeta = {
      bomVariantId: variantId,
      bomVariantName: normalizeBomVariantName(line.bomVariantName, variantId),
      isDefaultVariant: parseBooleanLike(line.isDefaultVariant, variantId === DEFAULT_BOM_VARIANT_ID),
      variantSortOrder: sortOrder
    };
    if (!existing) {
      byVariant.set(variantId, next);
      return;
    }
    byVariant.set(variantId, {
      ...existing,
      bomVariantName: existing.bomVariantName || next.bomVariantName,
      isDefaultVariant: existing.isDefaultVariant || next.isDefaultVariant,
      variantSortOrder: Number.isFinite(existing.variantSortOrder) ? existing.variantSortOrder : next.variantSortOrder
    });
  });

  const variants = Array.from(byVariant.values());
  const defaultVariant = variants.find(v => v.isDefaultVariant);
  if (!defaultVariant && variants.length > 0) {
    variants[0].isDefaultVariant = true;
  } else if (defaultVariant) {
    variants.forEach(v => {
      v.isDefaultVariant = v.bomVariantId === defaultVariant.bomVariantId;
    });
  }

  return variants.sort((a, b) => {
    const orderA = Number.isFinite(a.variantSortOrder) ? a.variantSortOrder : Number.MAX_SAFE_INTEGER;
    const orderB = Number.isFinite(b.variantSortOrder) ? b.variantSortOrder : Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) return orderA - orderB;
    return a.bomVariantName.localeCompare(b.bomVariantName);
  });
};

export const getDefaultBomVariantIdForSku = (bom: BOMItem[], skuId: string): string => {
  const variants = listBomVariantsForSku(bom, skuId);
  return variants.find(v => v.isDefaultVariant)?.bomVariantId || variants[0]?.bomVariantId || DEFAULT_BOM_VARIANT_ID;
};

export const getBomLinesForSkuVariant = (
  bom: BOMItem[],
  skuId: string,
  requestedVariantId?: string
): BOMItem[] => {
  const skuRows = bom
    .filter(line => normalizeSkuToken(line.sku_id) === normalizeSkuToken(skuId))
    .map(normalizeBomLine);

  if (skuRows.length === 0) return [];

  const requested = normalizeBomVariantId(requestedVariantId);
  const hasRequested = skuRows.some(line => normalizeBomVariantId(line.bomVariantId) === requested);
  const fallbackDefault = getDefaultBomVariantIdForSku(skuRows, skuId);
  const activeVariantId = hasRequested ? requested : fallbackDefault;

  return skuRows
    .filter(line => normalizeBomVariantId(line.bomVariantId) === activeVariantId)
    .sort((a, b) => Number(a.line_order || 0) - Number(b.line_order || 0));
};
