import type { UserRole } from '../types';

export type AppTabId = 'master' | 'inventory' | 'manufacturing';

export const SUBTAB_KEYS = {
  master: ['raw_components', 'finished_products'],
  inventory: ['overview', 'po_summary', 'history', 'goods_in', 'staging', 'product_in', 'dispatch'],
  manufacturing: ['alert_lines', 'safety_stock', 'budgeting', 'manufacturing_scheduling', 'costing'],
} as const;

/**
 * Every retained workflow is available in edit mode in this isolated public demo.
 * Authentication and role administration are deliberately outside its scope.
 */
export const canViewSubTab = (
  _role: UserRole | null,
  _tab: AppTabId,
  _subTab: string,
  _email?: string,
): boolean => true;

export const canEditSubTab = (
  _role: UserRole | null,
  _tab: AppTabId,
  _subTab: string,
  _email?: string,
): boolean => true;
