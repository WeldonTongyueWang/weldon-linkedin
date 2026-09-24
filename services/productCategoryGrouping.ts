import { Product } from '../types';

export const PRODUCT_CATEGORY_ORDER = [
  'Comp A',
  'Blended',
  'Commercial Dispensing',
  'Commercial Product',
  'Single Sachet',
  'sample',
] as const;

export type ProductCategoryGroup = typeof PRODUCT_CATEGORY_ORDER[number] | string;

export const INVENTORY_PRODUCT_TYPE_ORDER = [
  'Blended',
  'Commercial Product',
  'Single Sachet',
  'sample',
  'Commercial Dispensing',
  'Comp A',
] as const;

const INVENTORY_PRODUCT_TYPE_ORDER_INDEX = new Map<string, number>(
  INVENTORY_PRODUCT_TYPE_ORDER.map((label, index) => [label, index])
);

const stripLeadingCode = (val: string | number | undefined | null): string => {
  if (val === undefined || val === null || val === '') return '';
  let str = String(val).trim();
  str = str.replace(/^\s*\d{1,2}\s*[-–]\s*/, '');
  str = str.replace(/^\s*\d+\s+/, '');
  return str.trim();
};

const normalizeCategoryFingerprint = (value: unknown): string =>
  String(value ?? '').trim().toLowerCase();

const isSingleSachetProduct = (product: Product): boolean => {
  const fields = [product.sku_name, product.format, product.notes];
  return fields.some((value) => normalizeCategoryFingerprint(value).includes('single sachet'));
};

export const resolveProductCategoryGroup = (product: Product): ProductCategoryGroup => {
  const category = normalizeCategoryFingerprint(product.category);
  if (!category || category.includes('archived')) return stripLeadingCode(product.category || 'Other');

  if (isSingleSachetProduct(product)) return 'Single Sachet';
  if (category.includes('intermediate') || category.includes('05')) return 'Comp A';
  if (category.includes('blended') || category.includes('06')) return 'Blended';
  if (category === 'commercial dispensing' || category.includes('03')) return 'Commercial Dispensing';
  if (category === 'commercial product' || category.includes('01')) return 'Commercial Product';
  if (category.includes('sample') || category.includes('02') || category.includes('04')) return 'sample';
  return stripLeadingCode(product.category || 'Other');
};

export const resolveInventoryProductTypeOrder = (product: Product): number => {
  const group = resolveProductCategoryGroup(product);
  return INVENTORY_PRODUCT_TYPE_ORDER_INDEX.get(group) ?? INVENTORY_PRODUCT_TYPE_ORDER.length;
};

const normalizeSortText = (value: unknown): string =>
  String(value ?? '').trim().toLowerCase();

export const compareProductsByInventoryTypeOrder = (left: Product, right: Product): number => {
  const typeDelta = resolveInventoryProductTypeOrder(left) - resolveInventoryProductTypeOrder(right);
  if (typeDelta !== 0) return typeDelta;

  const nameDelta = normalizeSortText(left.sku_name).localeCompare(normalizeSortText(right.sku_name));
  if (nameDelta !== 0) return nameDelta;

  return normalizeSortText(left.sku_id).localeCompare(normalizeSortText(right.sku_id));
};
