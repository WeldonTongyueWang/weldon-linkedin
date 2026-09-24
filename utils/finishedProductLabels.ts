import { Product } from '../types';

type ProductLabelSource = Pick<Product, 'sku_id' | 'sku_name' | 'notes'>;

const normalizePart = (value: unknown): string => String(value ?? '').trim();

export const formatFinishedProductListLabel = (
  product: Pick<ProductLabelSource, 'sku_id' | 'sku_name'>,
): string => {
  const skuId = normalizePart(product.sku_id);
  const name = normalizePart(product.sku_name);

  return name || skuId;
};

export const formatFinishedProductInventoryLabel = (product: ProductLabelSource): string => {
  const baseLabel = formatFinishedProductListLabel(product);
  const notes = normalizePart(product.notes);
  return notes ? `${baseLabel} - ${notes}` : baseLabel;
};

export const resolveFinishedProductDisplayName = (
  products: Array<Pick<ProductLabelSource, 'sku_id' | 'sku_name' | 'notes'>>,
  skuId: string | undefined | null,
  fallback?: string,
): string => {
  const key = normalizePart(skuId);
  const normalizedKey = key.toUpperCase();
  const product = products.find((item) => normalizePart(item.sku_id).toUpperCase() === normalizedKey);

  if (product) return formatFinishedProductInventoryLabel(product);
  return normalizePart(fallback) || key;
};
