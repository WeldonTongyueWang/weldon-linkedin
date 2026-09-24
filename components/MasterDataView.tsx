
/**
 * PROTECTED MASTER DATA BOUNDARY - MASTER DATA VIEW
 * 
 * Hard Rules:
 * 1) This view is the ONLY authoritative UI for creating/modifying Master Data.
 * 2) Logic within this file is PROTECTED. Modifications require "MASTERDATA CHANGE REQUEST".
 * 3) No auto-derivation of master data from other modules is permitted.
 */

import React, { useState, useMemo } from 'react';
import { Component, Product, BOMItem, CategoryMaster, RawComponentDisplayNameMaster, UserRole } from '../types';
import { Package, Beaker, Lock } from 'lucide-react';
import { normalizeObjects } from '../services/sheetAdapter';
import { COMPONENT_KEYS, PRODUCT_KEYS } from '../services/sheetsSchema';
import './mobile-ui.css';
import { RawComponentsView } from './master/RawComponentsView';
import { FinishedProductsView } from './master/FinishedProductsView';
import { canEditSubTab, canViewSubTab } from '../config/accessControl';

interface Props {
  currentUser: string;
  userRole: UserRole | null;
  inventory: Component[];
  setInventory: React.Dispatch<React.SetStateAction<Component[]>>;
  products: Product[];
  setProducts: React.Dispatch<React.SetStateAction<Product[]>>;
  bom: BOMItem[];
  setBom: React.Dispatch<React.SetStateAction<BOMItem[]>>;
  onPersistItem?: (item: Component, originalId?: string) => Promise<{success: boolean, error?: string}>;
  onArchiveItem?: (id: string, restore?: boolean) => Promise<void> | void;
  onPersistProduct?: (prod: Product, originalId?: string) => Promise<{success: boolean, error?: string}>;
  onDeleteProduct?: (id: string) => Promise<void> | void;
  onPersistBom?: (bom: BOMItem) => void;
  categories: CategoryMaster[];
  rawComponentDisplayNames: RawComponentDisplayNameMaster[];
  onAddCategory?: (cat: Partial<CategoryMaster>) => Promise<void> | void;
  onDeleteCategory?: (cat: Partial<CategoryMaster>) => Promise<void> | void;
  onAddRawComponentDisplayName?: (row: RawComponentDisplayNameMaster) => Promise<void> | void;
  onDeleteRawComponentDisplayName?: (id: string) => Promise<void> | void;
  isReadOnly?: boolean;
}

export const MasterDataView: React.FC<Props> = ({ 
  currentUser,
  userRole,
  inventory: rawInventory, 
  products: rawProducts, 
  bom, setBom,
  onPersistItem, onArchiveItem, onPersistProduct, onDeleteProduct, onPersistBom,
  categories, rawComponentDisplayNames, onAddCategory, onDeleteCategory, onAddRawComponentDisplayName, onDeleteRawComponentDisplayName,
  isReadOnly
}) => {
  const [activeSection, setActiveSection] = useState<'items' | 'products'>('items');

  const inventory = useMemo(() => normalizeObjects<Component>(rawInventory, COMPONENT_KEYS), [rawInventory]);
  
  // Normalized products with legacy schema fallback
  // Keep 'default_unit' populated when an imported fixture uses split unit columns.
  // but hasn't backfilled the new 'default_unit' column from 'packaging_type'.
  const products = useMemo(() => {
    const normalized = normalizeObjects<Product>(rawProducts, PRODUCT_KEYS);
    return normalized.map((p, i) => {
        const raw = rawProducts[i] as any;
        if (p && !p.default_unit && raw) {
            // Fallback to legacy fields if the canonical field is empty
            const legacyVal = raw.packaging_type || raw.packaging || raw.uom;
            if (legacyVal) return { ...p, default_unit: legacyVal };
        }
        return p;
    });
  }, [rawProducts]);

  const sections = [
    { id: 'items', key: 'raw_components', label: 'Raw Components', icon: Package },
    { id: 'products', key: 'finished_products', label: 'Finished Products', icon: Beaker },
  ] as const;

  const visibleSections = sections.filter(sec => canViewSubTab(userRole, 'master', sec.key, currentUser));
  const activeSectionMeta = visibleSections.find(sec => sec.id === activeSection) || visibleSections[0];
  const sectionReadOnly = activeSectionMeta ? !canEditSubTab(userRole, 'master', activeSectionMeta.key, currentUser) : true;

  React.useEffect(() => {
    if (!activeSectionMeta && visibleSections.length > 0) {
      setActiveSection(visibleSections[0].id);
    } else if (activeSectionMeta && activeSectionMeta.id !== activeSection) {
      setActiveSection(activeSectionMeta.id);
    }
  }, [activeSection, activeSectionMeta, visibleSections]);

  return (
    <div className="h-auto md:h-full min-h-0 flex flex-col gap-4 sm:gap-6">
      <div className="sticky top-0 z-20 bg-slate-100/95 backdrop-blur border-b border-slate-200 flex flex-col gap-3 pb-2 sm:flex-row sm:items-center sm:justify-between sm:pb-0 flex-shrink-0">
        <div className="mobile-tab-strip flex overflow-x-auto whitespace-nowrap">
          {visibleSections.map((sec) => {
            const Icon = sec.icon;
            const isActive = activeSection === sec.id;
            return (
              <button
                key={sec.id}
                onClick={() => setActiveSection(sec.id)}
                className={`flex shrink-0 items-center px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                  isActive 
                    ? 'border-indigo-600 text-indigo-600' 
                    : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
                }`}
              >
                <Icon className="w-4 h-4 mr-2" />
                {sec.label}
              </button>
            );
          })}
        </div>
        {(isReadOnly || sectionReadOnly) && (
            <div className="self-end sm:self-auto bg-slate-100 text-slate-500 px-3 py-1 rounded-full text-xs font-bold flex items-center">
                <Lock className="w-3 h-3 mr-1" /> View Only
            </div>
        )}
      </div>

      <div className="bg-white p-4 sm:p-6 rounded-lg shadow-sm border border-slate-200 flex-1 min-h-0 flex flex-col overflow-visible md:overflow-hidden">
        {visibleSections.length === 0 && (
          <div className="h-full flex items-center justify-center text-slate-400 italic">No access to Master Data subtabs.</div>
        )}

        {activeSectionMeta?.id === 'items' && (
          <div className="flex-1 min-h-0 overflow-visible md:overflow-hidden">
            <RawComponentsView 
              currentUser={currentUser}
              inventory={inventory}
              categories={categories}
              rawComponentDisplayNames={rawComponentDisplayNames}
              bom={bom}
              products={products}
              onPersistItem={onPersistItem}
              onArchiveItem={onArchiveItem}
              onAddCategory={onAddCategory}
              onDeleteCategory={onDeleteCategory}
              onAddRawComponentDisplayName={onAddRawComponentDisplayName}
              onDeleteRawComponentDisplayName={onDeleteRawComponentDisplayName}
              isReadOnly={isReadOnly || sectionReadOnly}
            />
          </div>
        )}

        {activeSectionMeta?.id === 'products' && (
          <div className="flex-1 min-h-0 overflow-visible md:overflow-hidden">
            <FinishedProductsView 
              currentUser={currentUser}
              products={products}
              inventory={inventory}
              categories={categories}
              bom={bom}
              setBom={setBom}
              onPersistProduct={onPersistProduct}
              onDeleteProduct={onDeleteProduct}
              onPersistBom={onPersistBom}
              isReadOnly={isReadOnly || sectionReadOnly}
            />
          </div>
        )}
      </div>
    </div>
  );
}
