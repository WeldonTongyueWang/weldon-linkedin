export type PermissionLevel = 'use' | 'view' | 'none';

export type AccessSectionId = 'master' | 'inventory' | 'manufacturing';

export type AccessFeatureId =
  | 'raw_components'
  | 'finished_products'
  | 'overview'
  | 'po_summary'
  | 'history'
  | 'comp_in'
  | 'comp_out'
  | 'product_in'
  | 'product_out'
  | 'alerting'
  | 'safety_stock'
  | 'budgeting'
  | 'scheduling'
  | 'costing';

export type DepartmentFunctionId =
  | 'operations'
  | 'quality'
  | 'research_development'
  | 'process_engineer'
  | 'mechanical_engineer'
  | 'inventory'
  | 'procurement'
  | 'finance';

export interface AccessFeatureDefinition {
  id: AccessFeatureId;
  label: string;
}

export interface AccessSectionDefinition {
  id: AccessSectionId;
  label: string;
  features: readonly AccessFeatureDefinition[];
}

export interface DepartmentAccessProfile {
  id: DepartmentFunctionId;
  displayName: string;
  permissions: Readonly<Record<AccessFeatureId, PermissionLevel>>;
  canReleaseQuarantine: boolean;
}

export const ACCESS_SECTIONS: readonly AccessSectionDefinition[] = [
  {
    id: 'master',
    label: 'Master Data',
    features: [
      { id: 'raw_components', label: 'Raw Components' },
      { id: 'finished_products', label: 'Finished Products' },
    ],
  },
  {
    id: 'inventory',
    label: 'Inventory Manager',
    features: [
      { id: 'overview', label: 'Overview' },
      { id: 'po_summary', label: 'PO Summary' },
      { id: 'history', label: 'History' },
      { id: 'comp_in', label: 'Comp In' },
      { id: 'comp_out', label: 'Comp Out' },
      { id: 'product_in', label: 'Product In' },
      { id: 'product_out', label: 'Product Out' },
    ],
  },
  {
    id: 'manufacturing',
    label: 'Manufacturing Planning',
    features: [
      { id: 'alerting', label: 'Alerting' },
      { id: 'safety_stock', label: 'Safety Stock' },
      { id: 'budgeting', label: 'Budgeting (Long term)' },
      { id: 'scheduling', label: 'Scheduling (Mid Term)' },
      { id: 'costing', label: 'Costing (Exploratory)' },
    ],
  },
] as const;

const ACCESS_FEATURE_IDS = ACCESS_SECTIONS.flatMap((section) =>
  section.features.map((feature) => feature.id),
);

const createProfile = (
  id: DepartmentFunctionId,
  displayName: string,
  use: readonly AccessFeatureId[],
  view: readonly AccessFeatureId[],
  canReleaseQuarantine = false,
): DepartmentAccessProfile => {
  const useSet = new Set<AccessFeatureId>(use);
  const viewSet = new Set<AccessFeatureId>(view);
  const permissions = Object.fromEntries(
    ACCESS_FEATURE_IDS.map((featureId) => [
      featureId,
      useSet.has(featureId) ? 'use' : viewSet.has(featureId) ? 'view' : 'none',
    ]),
  ) as Record<AccessFeatureId, PermissionLevel>;

  return { id, displayName, permissions, canReleaseQuarantine };
};

export const DEPARTMENT_ACCESS_PROFILES: readonly DepartmentAccessProfile[] = [
  createProfile(
    'operations',
    'Operations',
    ['comp_out', 'product_in', 'product_out', 'scheduling'],
    [
      'raw_components',
      'finished_products',
      'overview',
      'history',
      'comp_in',
      'alerting',
      'safety_stock',
    ],
  ),
  createProfile(
    'quality',
    'Quality',
    ['comp_in', 'product_in'],
    [
      'raw_components',
      'finished_products',
      'overview',
      'history',
      'comp_out',
      'product_out',
      'alerting',
      'scheduling',
    ],
    true,
  ),
  createProfile(
    'research_development',
    'R&D',
    ['raw_components', 'finished_products', 'costing'],
    [
      'overview',
      'history',
      'comp_in',
      'product_in',
      'alerting',
      'safety_stock',
      'budgeting',
      'scheduling',
    ],
  ),
  createProfile(
    'process_engineer',
    'Process Engineer',
    ['finished_products', 'scheduling', 'costing'],
    [
      'raw_components',
      'overview',
      'history',
      'comp_out',
      'product_in',
      'alerting',
      'safety_stock',
      'budgeting',
    ],
  ),
  createProfile(
    'mechanical_engineer',
    'Mechanical Engineer',
    [],
    [
      'raw_components',
      'finished_products',
      'overview',
      'history',
      'comp_out',
      'product_in',
      'alerting',
      'scheduling',
    ],
  ),
  createProfile(
    'inventory',
    'Inventory',
    ['overview', 'history', 'comp_in', 'comp_out', 'product_in', 'product_out'],
    [
      'raw_components',
      'finished_products',
      'po_summary',
      'alerting',
      'safety_stock',
      'scheduling',
    ],
    true,
  ),
  createProfile(
    'procurement',
    'Procurement',
    ['raw_components', 'comp_in', 'alerting', 'budgeting', 'scheduling'],
    [
      'finished_products',
      'overview',
      'po_summary',
      'history',
      'safety_stock',
      'costing',
    ],
  ),
  createProfile(
    'finance',
    'Finance',
    ['budgeting', 'costing'],
    [
      'raw_components',
      'finished_products',
      'overview',
      'po_summary',
      'history',
      'safety_stock',
      'scheduling',
    ],
  ),
] as const;

/**
 * A section is marked Use when any of its workflows can be used, View when
 * at least one can be viewed, and None when the function has no access there.
 */
export const getSectionPermission = (
  profile: DepartmentAccessProfile,
  section: AccessSectionDefinition,
): PermissionLevel => {
  const permissions = section.features.map((feature) => profile.permissions[feature.id]);
  if (permissions.includes('use')) return 'use';
  if (permissions.includes('view')) return 'view';
  return 'none';
};
