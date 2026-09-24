import { getTypeConfig } from '../masterdata/rawComponentRegistry';
import { Component, ComponentType } from '../types';

const normalizeCategory = (category: unknown): string =>
  String(category ?? '').trim().toLowerCase();

const TYPE_LABELS: Record<ComponentType, string> = {
  INGREDIENT: 'Ingredient',
  PRIMARY_PACKAGING: 'Primary Packaging',
  SECONDARY_PACKAGING: 'Secondary Packaging',
  CONSUMABLE: 'Consumable',
  DISPENSING: 'Dispensing',
  LABEL: 'Label',
  PALLET_LOGISTICS: 'Pallet Logistics',
  PALLET: 'Pallet',
};

export const isArchivedRawComponent = (component: Pick<Component, 'category'> | null | undefined): boolean =>
  normalizeCategory(component?.category).includes('archived');

export const getActiveRawComponents = (components: Component[]): Component[] =>
  components.filter((component) => !isArchivedRawComponent(component));

export const getArchivedRawComponents = (components: Component[]): Component[] =>
  components.filter((component) => isArchivedRawComponent(component));

export const getArchivedRawComponentCategory = (type: ComponentType): string =>
  `Archived ${TYPE_LABELS[type] || 'Raw Component'}`;

export const getDefaultRawComponentCategory = (type: ComponentType): string =>
  getTypeConfig(type)?.categoryOptions?.[0]?.code || '01';
