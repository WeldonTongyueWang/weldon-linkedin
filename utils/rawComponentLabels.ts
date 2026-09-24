import { RAW_COMPONENT_REGISTRY } from '../masterdata/rawComponentRegistry';
import { CategoryMaster, Component, ComponentType } from '../types';

const normalizePart = (value: unknown): string => String(value ?? '').trim();
const isNumericCode = (value: string): boolean => /^[0-9]+$/.test(value.trim());

export const stripLeadingCode = (value: string | number | undefined | null): string => {
  if (value === undefined || value === null || value === '') return '';
  let text = String(value).trim();
  text = text.replace(/^\s*\d{1,2}\s*[-–]\s*/, '');
  text = text.replace(/^\s*\d+\s+/, '');
  return text.trim();
};

const removeTrailingStandaloneNumber = (value: string): string => value.replace(/\s+\d+$/, '').trim();

const joinUniqueParts = (...parts: Array<string | undefined | null>): string => {
  const values: string[] = [];
  const seen = new Set<string>();

  for (const part of parts) {
    const normalized = normalizePart(part);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(normalized);
  }

  return values.join(' ').trim();
};

export const resolveRawComponentCategoryLabel = (
  type: ComponentType,
  categoryValue: string | number | undefined,
  categories: CategoryMaster[] = [],
): string => {
  if (categoryValue === undefined || categoryValue === null || categoryValue === '') return '';

  const value = String(categoryValue).trim();
  const config = RAW_COMPONENT_REGISTRY[type];
  if (!config) return stripLeadingCode(value);

  const staticOption = config.categoryOptions.find(
    (option) => option.code === value || parseInt(option.code, 10).toString() === value,
  );
  if (staticOption) return staticOption.label;

  const dynamicOption = categories.find(
    (category) =>
      category.type === type &&
      (category.category_code === value || parseInt(category.category_code, 10).toString() === value),
  );
  if (dynamicOption) return dynamicOption.category_label;

  const cleanedValue = stripLeadingCode(value);
  return isNumericCode(cleanedValue) ? '' : cleanedValue;
};

export const formatRawComponentListLabel = (
  item: Component,
  categories: CategoryMaster[] = [],
): string => {
  const name = stripLeadingCode(item.component_name || '');
  const categoryLabel = stripLeadingCode(
    resolveRawComponentCategoryLabel(item.type, item.category, categories),
  );
  const subcategory = normalizePart(item.subcategory);

  switch (item.type) {
    case 'PRIMARY_PACKAGING':
      return (
        joinUniqueParts(removeTrailingStandaloneNumber(name), subcategory, categoryLabel) ||
        item.component_id
      );
    case 'SECONDARY_PACKAGING':
      return joinUniqueParts(categoryLabel, subcategory, name) || item.component_id;
    case 'DISPENSING':
      return joinUniqueParts(name, categoryLabel, subcategory) || item.component_id;
    case 'CONSUMABLE':
      return joinUniqueParts(name, subcategory) || item.component_id;
    case 'LABEL':
      return joinUniqueParts(name, subcategory) || item.component_id;
    case 'PALLET_LOGISTICS':
      return joinUniqueParts(name, categoryLabel, subcategory) || item.component_id;
    default:
      return name || item.component_id;
  }
};

export const formatRawComponentInventoryLabel = (
  item: Component,
  categories: CategoryMaster[] = [],
): string => {
  const baseLabel = formatRawComponentListLabel(item, categories);
  return item.notes ? `${baseLabel} — ${item.notes}` : baseLabel;
};
