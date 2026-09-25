import type { UserRole } from '../types';

export type AppTabId = 'master' | 'inventory' | 'manufacturing' | 'settings';

export const SUBTAB_KEYS = {
  master: ['raw_components', 'finished_products'],
  inventory: ['overview', 'po_summary', 'history', 'goods_in', 'staging', 'product_in', 'dispatch'],
  manufacturing: ['alert_lines', 'safety_stock', 'budgeting', 'manufacturing_scheduling', 'costing'],
  settings: ['main'],
} as const;

/**
 * Every retained workflow is available in edit mode in this isolated public demo.
 * Settings shows illustrative department profiles; authentication and enforcement
 * remain deliberately outside the public demo's scope.
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
