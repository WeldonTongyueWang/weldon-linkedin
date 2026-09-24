/**
 * HARD BOUNDARY: RAW COMPONENT CHANGE REQUEST
 * 
 * AUTHORITY: Primary UI for Raw Component Master Data.
 * RULES:
 * 1. Only raw-component master data may be created or edited.
 * 2. No finished product, inventory movement, or batch logic may be changed.
 * 3. Schema changes must be backward compatible.
 */

import React, { useState, useMemo, useEffect } from 'react';
import { Component, ComponentType, CategoryMaster, Product, BOMItem, RawComponentDisplayNameMaster } from '../../types';
import { Archive, Plus, Search, ShieldAlert, Info, X, Edit3, CheckCircle, Zap, Lock, BookOpen, ChevronUp, ChevronDown, AlertTriangle, Loader2, Copy, RotateCcw, Trash2 } from 'lucide-react';
import { generateComponentId, validateCore, extractCoreFromComponentId, buildComponentIdWithCore } from '../../utils/componentIdRules';
import { getTypeConfig, formatCategoryDisplay, RAW_COMPONENT_REGISTRY, NAMING_RULES, CONSUMABLE_DEFINITIONS, DISPENSING_CORE_MAP, PALLET_LOGISTICS_CORE_MAP, SECONDARY_PACKAGING_DISPLAY_NAMES } from '../../masterdata/rawComponentRegistry';
import { FAMILY_DEFINITIONS } from '../../constants';
import { isArchivedRawComponent } from '../../services/rawComponentsService';
import { useAppDialog } from '../ui/AppDialogProvider';
import { useIsHandheldDevice } from '../../lib/useIsHandheldDevice';
import { previewMasterIdRename, type MasterRenamePreviewResponse } from '../../services/sheetsApi';
import { formatRawComponentListLabel, stripLeadingCode } from '../../utils/rawComponentLabels';

interface Props {
  currentUser: string;
  inventory: Component[];
  categories: CategoryMaster[];
  bom: BOMItem[]; // Needed for delete checks
  products: Product[]; // Needed for delete checks (parent names)
  rawComponentDisplayNames: RawComponentDisplayNameMaster[];
  onPersistItem?: (item: Component, originalId?: string) => Promise<{success: boolean, error?: string}>;
  onArchiveItem?: (id: string, restore?: boolean) => Promise<void> | void;
  onAddCategory?: (cat: Partial<CategoryMaster>) => Promise<void> | void;
  onDeleteCategory?: (cat: Partial<CategoryMaster>) => Promise<void> | void;
  onAddRawComponentDisplayName?: (row: RawComponentDisplayNameMaster) => Promise<void> | void;
  onDeleteRawComponentDisplayName?: (id: string) => Promise<void> | void;
  isReadOnly?: boolean;
}

const ITEM_TYPE_ORDER: ComponentType[] = [
  'INGREDIENT', 
  'PRIMARY_PACKAGING', 
  'SECONDARY_PACKAGING', 
  'CONSUMABLE', 
  'DISPENSING', 
  'LABEL', 
  'PALLET_LOGISTICS'
];
type RawComponentsTab = ComponentType | 'ARCHIVED';
const RAW_COMPONENT_TABS: RawComponentsTab[] = [...ITEM_TYPE_ORDER, 'ARCHIVED'];

const VERSION_OPTIONS = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"];
const PALLET_LOGISTICS_DISPLAY_NAMES = ['Standard Pallet', 'Pallet Pad'];
const DISPENSING_DISPLAY_NAMES = ['Bottle', 'Bottle Cap', 'Measuring Scoop', 'Funnel'];
const MANAGED_DISPLAY_NAME_TYPES = new Set<ComponentType>([
  'SECONDARY_PACKAGING',
  'CONSUMABLE',
  'DISPENSING',
  'PALLET_LOGISTICS'
]);

const cleanName = (name: string | undefined) => {
  if (!name) return "";
  return String(name).trim();
};

const toVersionString = (versionNumber: number): string => {
  if (!Number.isFinite(versionNumber) || versionNumber < 1) return '01';
  return versionNumber.toString().padStart(2, '0');
};

const parseVersionNumber = (value: string | number | undefined | null): number => {
  const digits = String(value ?? '').replace(/[^0-9]/g, '');
  const parsed = parseInt(digits || '0', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const formatRenamePreviewMessage = (preview: MasterRenamePreviewResponse): string => {
  const countLines = Object.entries(preview.counts || {})
    .filter(([key, value]) => key !== 'totalAffected' && Number(value || 0) > 0)
    .map(([key, value]) => `${key}: ${Number(value || 0)}`);
  const effectLines = (preview.effects || []).map(effect => `- ${effect}`);
  return [
    `${preview.oldId} -> ${preview.newId}`,
    '',
    `Estimated affected records: ${Number(preview.counts?.totalAffected || 0)}`,
    ...(countLines.length > 0 ? ['', ...countLines] : []),
    ...(effectLines.length > 0 ? ['', ...effectLines] : []),
  ].join('\n');
};

export const RawComponentsView: React.FC<Props> = ({ 
  currentUser, inventory, categories, bom, products, rawComponentDisplayNames,
  onPersistItem, onArchiveItem, onAddCategory, onDeleteCategory, onAddRawComponentDisplayName, onDeleteRawComponentDisplayName, isReadOnly
}) => {
  const isHandheldDevice = useIsHandheldDevice();
  const appDialog = useAppDialog();
  const [activeItemType, setActiveItemType] = useState<ComponentType>('INGREDIENT');
  const [activeListTab, setActiveListTab] = useState<RawComponentsTab>('INGREDIENT');
  const [itemSearch, setItemSearch] = useState('');
  const [itemSortField, setItemSortField] = useState<'name' | 'id'>('name');
  const [itemSortDir, setItemSortDir] = useState<'asc' | 'desc'>('asc');

  const [isAddingCategory, setIsAddingCategory] = useState(false);
  const [isManagingDisplayNames, setIsManagingDisplayNames] = useState(false);
  const [isNamingRulesOpen, setIsNamingRulesOpen] = useState(false);
  const [newCategoryLabel, setNewCategoryLabel] = useState('');
  const [newDisplayNameLabel, setNewDisplayNameLabel] = useState('');
  const [newDisplayNameCore, setNewDisplayNameCore] = useState('');
  const [itemActionError, setItemActionError] = useState<string | null>(null);
  const [isCreatingCategory, setIsCreatingCategory] = useState(false);
  const [deletingCategoryKey, setDeletingCategoryKey] = useState<string | null>(null);
  
  const [editingId, setEditingId] = useState<string | null>(null);
  const [duplicateSourceId, setDuplicateSourceId] = useState<string | null>(null);
  const [isEditingCore, setIsEditingCore] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [isPreviewingRename, setIsPreviewingRename] = useState(false);

  const [deleteModal, setDeleteModal] = useState<{ 
    isOpen: boolean, 
    id: string | null, 
    name: string,
    parents: string[]
  }>({ 
    isOpen: false, 
    id: null, 
    name: '',
    parents: []
  });

  // Merge categories
  const mergedCategoryOptions = useMemo(() => {
    const staticConfig = getTypeConfig(activeItemType);
    const staticOptions = staticConfig?.categoryOptions || [];
    const dynamicOptions = categories
      .filter(c => c.type === activeItemType)
      .map(c => ({ code: c.category_code, label: c.category_label }));
    
    const seen = new Set(staticOptions.map(o => o.code));
    const uniqueDynamic = dynamicOptions.filter(o => !seen.has(o.code));

    return [...staticOptions, ...uniqueDynamic].sort((a, b) => {
      const aCode = parseInt(String(a.code || ''), 10);
      const bCode = parseInt(String(b.code || ''), 10);
      if (Number.isNaN(aCode) || Number.isNaN(bCode)) {
        return String(a.code || '').localeCompare(String(b.code || ''));
      }
      return aCode - bCode;
    });
  }, [activeItemType, categories]);

  const dynamicCategoryRows = useMemo(
    () => categories
      .filter(c => c.type === activeItemType)
      .slice()
      .sort((a, b) => {
        const aCode = parseInt(String(a.category_code || ''), 10);
        const bCode = parseInt(String(b.category_code || ''), 10);
        if (Number.isNaN(aCode) || Number.isNaN(bCode)) {
          return String(a.category_code || '').localeCompare(String(b.category_code || ''));
        }
        return aCode - bCode;
      }),
    [activeItemType, categories]
  );

  const managedDisplayNamesEnabled = MANAGED_DISPLAY_NAME_TYPES.has(activeItemType);
  const dynamicDisplayNameRows = useMemo(
    () => rawComponentDisplayNames
      .filter(row => row.type === activeItemType && String(row.display_name || '').trim() !== ''),
    [activeItemType, rawComponentDisplayNames]
  );

  const displayNameOptions = useMemo(() => {
    const staticNames = activeItemType === 'SECONDARY_PACKAGING'
      ? SECONDARY_PACKAGING_DISPLAY_NAMES
      : activeItemType === 'CONSUMABLE'
        ? CONSUMABLE_DEFINITIONS.map(c => c.name)
        : activeItemType === 'DISPENSING'
          ? DISPENSING_DISPLAY_NAMES
          : activeItemType === 'PALLET_LOGISTICS'
            ? PALLET_LOGISTICS_DISPLAY_NAMES
            : [];
    const allNames = [...staticNames, ...dynamicDisplayNameRows.map(row => row.display_name)];
    return Array.from(new Set(allNames.map(name => String(name || '').trim()).filter(Boolean)));
  }, [activeItemType, dynamicDisplayNameRows]);

  const typeConfig = useMemo(() => {
      const config = getTypeConfig(activeItemType);
      if (!config) return undefined;
      return { ...config, categoryOptions: mergedCategoryOptions };
  }, [activeItemType, mergedCategoryOptions]);

  const [newItem, setNewItem] = useState({ 
    component_id: '', 
    id_core: '',
    component_name: '', 
    subcategory: '', 
    default_unit: 'kg',
    type: 'INGREDIENT' as ComponentType, 
    category: '01', 
    version: '01', 
    notes: '',
    createdAt: ''
  });

  const coreValidation = useMemo(() => {
    if (!isEditingCore || !newItem.id_core) return { ok: true };
    return validateCore(newItem.id_core);
  }, [isEditingCore, newItem.id_core]);

  const idConflict = useMemo(() => {
    if (!newItem.component_id) return null;
    const match = inventory.find(i => 
      i.component_id === newItem.component_id && i.component_id !== editingId
    );
    return match ? match : null;
  }, [newItem.component_id, inventory, editingId]);
  const componentRenamePending = Boolean(
    editingId &&
    !duplicateSourceId &&
    String(newItem.component_id || '').trim() &&
    String(editingId || '').trim().toLowerCase() !== String(newItem.component_id || '').trim().toLowerCase()
  );

  const exactNameMatch = useMemo(() => {
    if (!newItem.component_name) return null;
    const currentInput = cleanName(newItem.component_name).toLowerCase();
    return inventory.find(i => 
      i.type === activeItemType && 
      (!editingId || i.component_id !== editingId) &&
      cleanName(i.component_name).toLowerCase() === currentInput
    );
  }, [newItem.component_name, inventory, activeItemType, editingId]);

  const similarNames = useMemo(() => {
    const currentInput = cleanName(newItem.component_name).toLowerCase();
    if (!currentInput || currentInput.length < 3) return [];
    
    return inventory.filter(item => {
      if (editingId && item.component_id === editingId) return false;
      // Exclude exact match from similar list
      if (exactNameMatch && item.component_id === exactNameMatch.component_id) return false;

      const itemName = (item.component_name || "").toLowerCase();
      return itemName.includes(currentInput) || currentInput.includes(itemName);
    });
  }, [newItem.component_name, inventory, editingId, exactNameMatch]);

  // Suggestion Effect
  useEffect(() => {
    const cleanedName = cleanName(newItem.component_name);

    if (editingId && !isEditingCore && newItem.id_core) {
      try {
        const suggested = buildComponentIdWithCore({
          type: activeItemType,
          name: cleanedName,
          categoryCode: newItem.category,
          subcategory: newItem.subcategory,
          version: newItem.version,
          id_core: newItem.id_core
        });
        
        if (newItem.component_id !== suggested) {
          setNewItem(prev => ({ ...prev, component_id: suggested }));
        }
      } catch (e) { }
      return;
    }

    if (!editingId && !isEditingCore && (!cleanedName || cleanedName.length < 2)) {
      if (newItem.component_id !== '') setNewItem(prev => ({ ...prev, component_id: '' }));
      return;
    }

    try {
      let suggested = "";
      if (isEditingCore && newItem.id_core) {
        suggested = buildComponentIdWithCore({
          type: activeItemType,
          name: cleanedName,
          categoryCode: newItem.category,
          subcategory: newItem.subcategory,
          version: newItem.version,
          id_core: newItem.id_core
        });
      } else {
        suggested = generateComponentId({
          type: activeItemType,
          name: cleanedName,
          categoryCode: newItem.category,
          subcategory: newItem.subcategory,
          version: newItem.version,
          id_core: newItem.id_core 
        }, inventory);
      }
      
      if (newItem.component_id !== suggested) {
        setNewItem(prev => ({ ...prev, component_id: suggested }));
      }
    } catch (e) { }
  }, [newItem.component_name, activeItemType, newItem.category, newItem.subcategory, newItem.version, newItem.id_core, inventory, isEditingCore, editingId]);

  // Reset form on type change
  useEffect(() => {
    if (typeConfig && !editingId) {
      setNewItem(prev => ({
        ...prev,
        type: activeItemType,
        subcategory: (activeItemType === 'DISPENSING' || activeItemType === 'LABEL' || activeItemType === 'PALLET_LOGISTICS') ? '' : (typeConfig.subcategoryOptions[0] || 'unit'),
        default_unit: typeConfig.defaultUnitOptions[0] || 'pcs',
        category: typeConfig.categoryOptions[0]?.code || '01',
        component_id: '',
        id_core: '',
        component_name: '',
        createdAt: ''
      }));
      setIsEditingCore(false);
      setItemActionError(null);
    }
  }, [activeItemType, typeConfig, editingId]);

  const processedInventory = useMemo(() => {
    let result = inventory.filter(i => {
      if (activeListTab === 'ARCHIVED') return isArchivedRawComponent(i);
      return i.type === activeListTab && !isArchivedRawComponent(i);
    });
    if (itemSearch) { 
      const q = itemSearch.toLowerCase(); 
      result = result.filter(i => 
        (i.component_name || "").toLowerCase().includes(q) || 
        (i.component_id || "").toLowerCase().includes(q)
      ); 
    }
    
    result.sort((a, b) => {
      const valA = itemSortField === 'name' ? (a.component_name || "") : (a.component_id || "");
      const valB = itemSortField === 'name' ? (b.component_name || "") : (b.component_id || "");
      const cmp = valA.localeCompare(valB);
      return itemSortDir === 'asc' ? cmp : -cmp;
    });

    return result;
  }, [inventory, activeListTab, itemSearch, itemSortField, itemSortDir]);

  const toggleItemSort = (field: 'name' | 'id') => {
    if (itemSortField === field) {
      setItemSortDir(itemSortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setItemSortField(field);
      setItemSortDir('asc');
    }
  };

  const handleEditItem = (item: Component) => {
    if (isReadOnly) return;
    const core = item.id_core || extractCoreFromComponentId(item.component_id, item.type) || '';
    setEditingId(item.component_id);
    setDuplicateSourceId(null);
    setActiveItemType(item.type);
    setActiveListTab(item.type);
    setIsEditingCore(false);
    setItemActionError(null);
    setNewItem({
      component_id: item.component_id,
      id_core: core,
      component_name: item.component_name,
      type: item.type,
      category: item.category || '01',
      subcategory: item.subcategory,
      default_unit: item.default_unit || 'kg',
      version: item.version || '01',
      notes: item.notes || '',
      createdAt: item.createdAt || ''
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDuplicateSourceId(null);
    setIsEditingCore(false);
    setItemActionError(null);
    setNewItem({ 
      component_id: '', 
      id_core: '',
      component_name: '', 
      subcategory: (activeItemType === 'DISPENSING' || activeItemType === 'LABEL' || activeItemType === 'PALLET_LOGISTICS') ? '' : (typeConfig?.subcategoryOptions[0] || 'unit'), 
      default_unit: typeConfig?.defaultUnitOptions[0] || 'kg',
      type: activeItemType, 
      category: typeConfig?.categoryOptions[0]?.code || '01', 
      version: '01', 
      notes: '',
      createdAt: ''
    });
  };

  const handleDuplicateItem = (item: Component) => {
    if (isReadOnly) return;
    const core = item.id_core || extractCoreFromComponentId(item.component_id, item.type) || '';

    const relatedItems = inventory.filter(existing => {
      if (existing.type !== item.type) return false;
      const existingCore = existing.id_core || extractCoreFromComponentId(existing.component_id, existing.type) || '';
      return existingCore && core ? existingCore === core : existing.component_id === item.component_id;
    });

    const maxExistingVersion = relatedItems.reduce((maxVersion, existing) => {
      const existingVersion = parseVersionNumber(existing.version);
      return Math.max(maxVersion, existingVersion);
    }, parseVersionNumber(item.version));

    const nextVersion = toVersionString(maxExistingVersion + 1);
    const nextId = core
      ? buildComponentIdWithCore({
          type: item.type,
          name: cleanName(item.component_name),
          categoryCode: item.category || '01',
          subcategory: item.subcategory || '',
          version: nextVersion,
          id_core: core
        })
      : generateComponentId({
          type: item.type,
          name: cleanName(item.component_name),
          categoryCode: item.category || '01',
          subcategory: item.subcategory || '',
          version: nextVersion
        }, inventory);

    setActiveItemType(item.type);
    setActiveListTab(item.type);
    setEditingId(item.component_id);
    setDuplicateSourceId(item.component_id);
    setIsEditingCore(false);
    setItemActionError(null);
    setNewItem({
      component_id: nextId,
      id_core: core,
      component_name: item.component_name || '',
      type: item.type,
      category: item.category || '01',
      subcategory: item.subcategory || '',
      default_unit: item.default_unit || 'kg',
      version: nextVersion,
      notes: item.notes || '',
      createdAt: ''
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSaveItem = async () => {
    if (isReadOnly) return;
    if (!coreValidation.ok || idConflict || ((activeItemType === 'LABEL' || activeItemType === 'PALLET_LOGISTICS') && (!newItem.component_name || !newItem.subcategory))) return;

    const cleanedName = cleanName(newItem.component_name);
    if (!cleanedName) {
      await appDialog.alert({ message: "Display Name is required.", tone: 'warning' });
      return;
    }

    if (!newItem.component_id) {
      await appDialog.alert({ message: "Component ID is required.", tone: 'warning' });
      return;
    }

    const core = newItem.id_core || extractCoreFromComponentId(newItem.component_id, activeItemType) || '';
    const timestamp = new Date().toISOString();
    const isDuplicateMode = Boolean(duplicateSourceId);
    const itemToSave: Component = { 
      component_id: newItem.component_id, 
      id_core: core,
      component_name: cleanedName, 
      type: activeItemType, 
      subcategory: newItem.subcategory, 
      default_unit: newItem.default_unit,
      category: newItem.category, 
      version: newItem.version, 
      notes: newItem.notes, 
      updatedBy: currentUser,
      updatedAt: timestamp,
      createdAt: editingId && !isDuplicateMode ? newItem.createdAt : timestamp
    };

    if (onPersistItem) {
      setIsSaving(true);
      try {
        if (componentRenamePending && editingId) {
          let preview: MasterRenamePreviewResponse | null = null;
          try {
            setIsPreviewingRename(true);
            preview = await previewMasterIdRename({
              entityType: 'COMPONENT',
              oldId: editingId,
              newId: itemToSave.component_id,
            });
          } finally {
            setIsPreviewingRename(false);
          }
          const confirmed = await appDialog.confirm({
            title: 'Rename Live Component ID?',
            message: preview ? formatRenamePreviewMessage(preview) : `${editingId} -> ${itemToSave.component_id}`,
            tone: 'warning',
            confirmLabel: 'Rename Component',
            cancelLabel: 'Cancel',
          });
          if (!confirmed) {
            setIsSaving(false);
            return;
          }
        }
        const result = await onPersistItem(itemToSave, editingId && !isDuplicateMode ? editingId : undefined);
        if (result.success) {
          cancelEdit();
        } else {
          setItemActionError(result.error || "Failed to save component.");
        }
      } catch (e: any) {
        setItemActionError(e.message || "An unexpected error occurred.");
      } finally {
        setIsSaving(false);
      }
    }
  };

  const handlePreviewRenameImpact = async () => {
    if (!componentRenamePending || !editingId) return;
    setIsPreviewingRename(true);
    try {
      const preview = await previewMasterIdRename({
        entityType: 'COMPONENT',
        oldId: editingId,
        newId: newItem.component_id,
      });
      await appDialog.alert({
        title: 'Rename Impact Preview',
        message: formatRenamePreviewMessage(preview),
        tone: 'warning',
      });
    } catch (error: any) {
      await appDialog.alert({ message: error?.message || 'Failed to preview component rename impact.', tone: 'danger' });
    } finally {
      setIsPreviewingRename(false);
    }
  };

  const handleCreateCategory = async () => {
      if (isReadOnly) return;
      if (!newCategoryLabel.trim() || !onAddCategory) return;
      const label = newCategoryLabel.trim();
      const isDuplicate = mergedCategoryOptions.some(o => o.label.toLowerCase() === label.toLowerCase());
      if (isDuplicate) {
          await appDialog.alert({ message: "A category with this label already exists for this component type.", tone: 'warning' });
          return;
      }
      const existingCodes = new Set(
        mergedCategoryOptions
        .map(o => parseInt(String(o.code), 10))
        .filter(n => !isNaN(n) && n >= 1 && n <= 99)
      );
      const nextCodeInt = Array.from({ length: 99 }, (_, index) => index + 1)
        .find(code => !existingCodes.has(code));
      if (!nextCodeInt) {
          await appDialog.alert({ message: "No more 2-digit category codes are available for this component type.", tone: 'warning' });
          return;
      }
      const nextCode = nextCodeInt.toString().padStart(2, '0');
      try {
        setIsCreatingCategory(true);
        await onAddCategory({
          id: `CAT-${activeItemType}-${nextCode}-${Date.now()}`,
          type: activeItemType,
          category_code: nextCode,
          category_label: label,
          updatedBy: currentUser
        });
        setNewCategoryLabel('');
        setIsAddingCategory(false);
      } catch (error: any) {
        await appDialog.alert({ message: error?.message || 'Failed to add category.', tone: 'danger' });
      } finally {
        setIsCreatingCategory(false);
      }
  };

  const handleDeleteCategory = async (category: CategoryMaster) => {
    if (isReadOnly || !onDeleteCategory) return;
    const confirmed = await appDialog.confirm({
      title: 'Delete Category',
      message: `Delete category ${formatCategoryDisplay({ code: category.category_code, label: category.category_label })}?`,
      tone: 'warning',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
    });
    if (!confirmed) return;
    try {
      setDeletingCategoryKey(`${category.type}-${category.category_code}-${category.id || 'legacy'}`);
      await onDeleteCategory(category);
    } catch (error: any) {
      await appDialog.alert({ message: error?.message || 'Failed to delete category.', tone: 'danger' });
    } finally {
      setDeletingCategoryKey(null);
    }
  };

  const resolveSelectedDisplayNameCore = (type: ComponentType, displayName: string): string => {
    const normalizedName = String(displayName || '').trim();
    if (!normalizedName) return '';

    const dynamicMatch = dynamicDisplayNameRows.find(
      row => String(row.display_name || '').trim().toLowerCase() === normalizedName.toLowerCase()
    );
    if (dynamicMatch?.id_core) return String(dynamicMatch.id_core).trim().toUpperCase();

    if (type === 'CONSUMABLE') {
      const staticMatch = CONSUMABLE_DEFINITIONS.find(c => c.name === normalizedName);
      return staticMatch ? `${staticMatch.code}${staticMatch.abbr}` : '';
    }
    if (type === 'DISPENSING') return DISPENSING_CORE_MAP[normalizedName] || '';
    if (type === 'PALLET_LOGISTICS') return PALLET_LOGISTICS_CORE_MAP[normalizedName] || '';
    return '';
  };

  const handleCreateDisplayName = async () => {
    if (isReadOnly || !managedDisplayNamesEnabled || !onAddRawComponentDisplayName) return;
    const label = String(newDisplayNameLabel || '').trim();
    const idCore = String(newDisplayNameCore || '').trim().toUpperCase();
    if (!label) return;

    const duplicate = displayNameOptions.some(name => name.toLowerCase() === label.toLowerCase());
    if (duplicate) {
      await appDialog.alert({ message: 'This display name already exists for the selected component type.', tone: 'warning' });
      return;
    }
    if (idCore && !validateCore(idCore).ok) {
      await appDialog.alert({ message: validateCore(idCore).reason || 'Invalid core.', tone: 'warning' });
      return;
    }

    try {
      await onAddRawComponentDisplayName({
        id: `DNAME-${activeItemType}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        type: activeItemType,
        display_name: label,
        id_core: idCore || undefined,
        updatedBy: currentUser,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      setNewDisplayNameLabel('');
      setNewDisplayNameCore('');
    } catch (error: any) {
      await appDialog.alert({ message: error?.message || 'Failed to add display name.', tone: 'danger' });
    }
  };

  const handleDeleteDisplayName = async (row: RawComponentDisplayNameMaster) => {
    if (isReadOnly || !onDeleteRawComponentDisplayName) return;
    const confirmed = await appDialog.confirm({
      title: 'Delete Display Name',
      message: `Delete display name "${row.display_name}"?`,
      tone: 'warning',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
    });
    if (!confirmed) return;
    try {
      await onDeleteRawComponentDisplayName(row.id);
      if (String(newItem.component_name || '').trim().toLowerCase() === String(row.display_name || '').trim().toLowerCase()) {
        setNewItem(prev => ({ ...prev, component_name: '', component_id: '', id_core: '' }));
      }
    } catch (error: any) {
      await appDialog.alert({ message: error?.message || 'Failed to delete display name.', tone: 'danger' });
    }
  };

  const initiateArchive = (id: string, name: string) => {
    if (isReadOnly) return;
    const references = bom.filter(b => b.component_id === id);
    
    const parentIds = Array.from(new Set(references.map(b => b.sku_id)));
    const parentDisplayNames = parentIds.map(pid => {
      const prod = products.find(p => p.sku_id === pid);
      return prod ? `${prod.sku_name} (${pid})` : pid;
    });

    setDeleteModal({
      isOpen: true,
      id,
      name,
      parents: parentDisplayNames
    });
  };

  const performArchive = async () => {
    if (!deleteModal.id || isReadOnly) return;
    if (onArchiveItem) {
      setIsDeleting(true);
      try {
        await onArchiveItem(deleteModal.id, false);
        if (editingId === deleteModal.id) cancelEdit();
        setDeleteModal({ isOpen: false, id: null, name: '', parents: [] });
      } catch (e) {
        console.error("Archive failed", e);
        await appDialog.alert({ message: "Failed to archive item. Please check connection.", tone: 'danger' });
      } finally {
        setIsDeleting(false);
      }
    } else {
      setDeleteModal({ isOpen: false, id: null, name: '', parents: [] });
    }
  };

  const handleRestore = async (id: string) => {
    if (!onArchiveItem || isReadOnly) return;
    setRestoringId(id);
    try {
      await onArchiveItem(id, true);
    } catch (e) {
      console.error("Restore failed", e);
      await appDialog.alert({ message: "Failed to restore item. Please check connection.", tone: 'danger' });
    } finally {
      setRestoringId(null);
    }
  };

  const isSaveDisabled = isReadOnly || !newItem.component_id || !newItem.component_name || !coreValidation.ok || !!idConflict || ((activeItemType === 'LABEL' || activeItemType === 'PALLET_LOGISTICS') && !newItem.subcategory);
  const mainLayoutClass = isHandheldDevice
    ? 'grid grid-cols-1 gap-8 animate-in fade-in h-full min-h-0 items-stretch'
    : 'grid grid-cols-1 md:grid-cols-3 gap-8 animate-in fade-in h-full min-h-0 items-stretch';
  const detailPanelClass = isHandheldDevice
    ? 'space-y-4 flex flex-col min-h-0'
    : 'md:col-span-2 space-y-4 flex flex-col min-h-0';

  return (
    <div className={mainLayoutClass}>
        {/* Delete Modal */}
        {deleteModal.isOpen && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in">
                <div className="bg-white rounded-xl shadow-2xl max-md w-full p-8 border border-slate-200">
                    <div className="flex items-center mb-6 text-amber-600">
                        <Archive className="w-8 h-8 mr-3" />
                        <h2 className="text-xl font-bold">Archive Component?</h2>
                    </div>
                    <p className="text-slate-600 mb-4 leading-relaxed">
                        Move <strong>{deleteModal.name}</strong> to the archives? It will no longer appear in active component lists or inventory operations, but its local demo record will be preserved.
                    </p>
                    {deleteModal.parents.length > 0 && (
                        <div className="bg-amber-50 rounded-lg p-4 border border-amber-100 mb-8">
                            <div className="flex items-center text-amber-800 text-xs font-bold uppercase mb-2">
                                <Info className="w-3 h-3 mr-1" /> Referenced by {deleteModal.parents.length} products
                            </div>
                            <p className="text-sm text-amber-900 mb-3">
                                Existing BOMs will keep their links to this component, so update those recipes if it should no longer be used.
                            </p>
                            <ul className="text-sm text-amber-900 space-y-1">
                                {deleteModal.parents.slice(0, 3).map((p, idx) => (
                                    <li key={idx} className="flex items-center">
                                        <span className="w-1.5 h-1.5 bg-amber-400 rounded-full mr-2"></span>
                                        {p}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                    <div className="flex justify-end space-x-3 pt-4 border-t border-slate-100">
                        <button 
                            onClick={() => setDeleteModal({ ...deleteModal, isOpen: false })} 
                            disabled={isDeleting}
                            className="px-5 py-2.5 bg-slate-100 text-slate-600 rounded-md font-bold hover:bg-slate-200 transition disabled:opacity-50"
                        >
                            Cancel
                        </button>
                        <button 
                            onClick={performArchive} 
                            disabled={isDeleting}
                            className="px-5 py-2.5 bg-amber-600 text-white rounded-md font-bold shadow-md hover:bg-amber-700 transition disabled:opacity-50 flex items-center"
                        >
                            {isDeleting ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Archiving...</> : 'Move to Archive'}
                        </button>
                    </div>
                </div>
            </div>
        )}

        {/* Naming Rules Modal */}
        {isNamingRulesOpen && (
            <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in">
                <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full p-6 border border-slate-200 overflow-hidden flex flex-col max-h-[90vh]">
                    <div className="flex justify-between items-center mb-4 pb-4 border-b border-slate-100">
                        <h3 className="font-bold text-slate-800 flex items-center uppercase tracking-tighter">
                            <BookOpen className="w-5 h-5 mr-2 text-indigo-600" /> System Naming Standards
                        </h3>
                        <button onClick={() => setIsNamingRulesOpen(false)}><X className="w-5 h-5 text-slate-400 hover:text-slate-600" /></button>
                    </div>
                    <div className="overflow-y-auto space-y-6 pr-2 scrollbar-thin scrollbar-thumb-slate-200">
                        <div className="bg-amber-50 border border-amber-200 p-3 rounded-md text-xs text-amber-800 leading-relaxed">
                            All component IDs are generated using a strict 5-segment structure to ensure traceability across the facility.
                        </div>
                        {ITEM_TYPE_ORDER.map(type => {
                            const rule = NAMING_RULES[type];
                            const config = RAW_COMPONENT_REGISTRY[type];
                            if (!rule || !config) return null;
                            return (
                                <div key={type} className="space-y-2 group">
                                <div className="flex items-center justify-between">
                                    <span className="text-[10px] font-black text-indigo-600 uppercase tracking-widest bg-indigo-50 px-2 py-0.5 rounded">{type.replace('_', ' ')}</span>
                                    <span className="font-mono text-[9px] text-slate-400 uppercase">Static Prefix: {rule.prefix}</span>
                                </div>
                                <div className="bg-slate-50 p-3 rounded border border-slate-100 font-mono text-[11px] text-slate-500 overflow-x-auto whitespace-nowrap">
                                    {rule.structure}
                                </div>
                                <div className="grid grid-cols-2 gap-6">
                                    <div>
                                    <div className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Category Mappings</div>
                                    <div className="space-y-1">
                                        {config.categoryOptions.map(opt => (
                                        <div key={opt.code} className="text-[10px] text-slate-500 border-l-2 border-slate-100 pl-2">
                                            <span className="font-bold text-slate-700">{opt.code}</span>: {opt.label}
                                        </div>
                                        ))}
                                    </div>
                                    </div>
                                    <div>
                                    <div className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">ID Sample</div>
                                    <div className="text-[11px] font-mono text-indigo-600 font-bold bg-indigo-50/30 p-2 rounded border border-indigo-100/50">
                                        {rule.prefix}-001{rule.abbrStrategy === 'FROM_KEYWORD_MAP' ? 'GEN' : 'ABC'}-01-KG-01
                                    </div>
                                    <p className="text-[9px] text-slate-400 mt-2 italic">Strategy: {rule.abbrStrategy.replace(/_/g, ' ')}</p>
                                    </div>
                                </div>
                                </div>
                            );
                        })}
                    </div>
                    <div className="mt-6 pt-4 border-t border-slate-100 flex justify-end">
                        <button onClick={() => setIsNamingRulesOpen(false)} className="px-5 py-2 bg-slate-900 text-white rounded-md text-xs font-bold hover:bg-slate-800 transition">Understood</button>
                    </div>
                </div>
            </div>
        )}

        {/* Manage Category Modal */}
        {isAddingCategory && (
            <div className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in">
                <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-6 border border-slate-200">
                    <div className="flex justify-between items-center mb-4">
                        <h3 className="font-bold text-slate-800">Manage Category for {activeItemType}</h3>
                        <button onClick={() => setIsAddingCategory(false)}><X className="w-5 h-5 text-slate-400 hover:text-slate-600" /></button>
                    </div>
                    <div className="space-y-4">
                        <div>
                            <label className="block text-xs font-bold text-slate-500 mb-1 uppercase">Category Label</label>
                            <input type="text" className="w-full border-slate-300 rounded-md text-sm shadow-sm" placeholder="e.g. Special Film" value={newCategoryLabel} onChange={e => setNewCategoryLabel(e.target.value)} onKeyDown={e => e.key === 'Enter' && void handleCreateCategory()} autoFocus />
                        </div>
                        <button onClick={() => void handleCreateCategory()} disabled={isCreatingCategory} className="w-full py-2.5 bg-indigo-600 text-white rounded-md font-bold hover:bg-indigo-700 transition disabled:opacity-50 flex items-center justify-center">
                            {isCreatingCategory ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Adding Category...</> : 'Add Category'}
                        </button>
                        <div className="border-t border-slate-200 pt-4">
                            <div className="text-xs font-bold text-slate-500 mb-2 uppercase">Custom Categories</div>
                            <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                                {dynamicCategoryRows.length === 0 && (
                                    <div className="text-sm text-slate-400 italic">No custom categories yet.</div>
                                )}
                                {dynamicCategoryRows.map(row => {
                                    const rowKey = `${row.type}-${row.category_code}-${row.id || 'legacy'}`;
                                    const isDeletingThisCategory = deletingCategoryKey === rowKey;
                                    return (
                                    <div key={rowKey} className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-2">
                                        <div className="text-sm text-slate-700">{formatCategoryDisplay({ code: row.category_code, label: row.category_label })}</div>
                                        <button onClick={() => void handleDeleteCategory(row)} disabled={isDeletingThisCategory} className="inline-flex items-center text-xs font-bold text-red-600 hover:text-red-700 disabled:opacity-50">
                                            {isDeletingThisCategory ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Trash2 className="w-3.5 h-3.5 mr-1" />} {isDeletingThisCategory ? 'Deleting...' : 'Delete'}
                                        </button>
                                    </div>
                                )})}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        )}

        {isManagingDisplayNames && (
            <div className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in">
                <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-6 border border-slate-200">
                    <div className="flex justify-between items-center mb-4">
                        <h3 className="font-bold text-slate-800">Manage Display Names for {activeItemType}</h3>
                        <button onClick={() => setIsManagingDisplayNames(false)}><X className="w-5 h-5 text-slate-400 hover:text-slate-600" /></button>
                    </div>
                    <div className="space-y-4">
                        <div>
                            <label className="block text-xs font-bold text-slate-500 mb-1 uppercase">Display Name</label>
                            <input type="text" className="w-full border-slate-300 rounded-md text-sm shadow-sm" placeholder="e.g. Bucket Lid" value={newDisplayNameLabel} onChange={e => setNewDisplayNameLabel(e.target.value)} />
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-slate-500 mb-1 uppercase">Core Segment (Optional)</label>
                            <input type="text" className="w-full border-slate-300 rounded-md text-sm shadow-sm font-mono uppercase" placeholder="e.g. 001BKT" value={newDisplayNameCore} onChange={e => setNewDisplayNameCore(e.target.value.toUpperCase())} />
                        </div>
                        <button onClick={handleCreateDisplayName} className="w-full py-2.5 bg-indigo-600 text-white rounded-md font-bold hover:bg-indigo-700 transition">Add Display Name</button>
                        <div className="border-t border-slate-200 pt-4">
                            <div className="text-xs font-bold text-slate-500 mb-2 uppercase">Built-In Display Names</div>
                            <div className="flex flex-wrap gap-2 mb-4">
                                {displayNameOptions
                                  .filter(name => !dynamicDisplayNameRows.some(row => row.display_name === name))
                                  .map(name => (
                                    <span key={name} className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{name}</span>
                                  ))}
                            </div>
                            <div className="text-xs font-bold text-slate-500 mb-2 uppercase">Custom Display Names</div>
                            <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                                {dynamicDisplayNameRows.length === 0 && (
                                    <div className="text-sm text-slate-400 italic">No custom display names yet.</div>
                                )}
                                {dynamicDisplayNameRows.map(row => (
                                    <div key={row.id} className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-2">
                                        <div>
                                            <div className="text-sm text-slate-700">{row.display_name}</div>
                                            {row.id_core && <div className="text-[11px] font-mono text-slate-400">{row.id_core}</div>}
                                        </div>
                                        <button onClick={() => handleDeleteDisplayName(row)} className="inline-flex items-center text-xs font-bold text-red-600 hover:text-red-700">
                                            <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        )}

        {/* Editor Column */}
        <div className="space-y-6 flex flex-col">
            <div className="bg-slate-50 p-6 rounded-lg border border-slate-200 flex-1">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="font-bold text-slate-800 flex items-center uppercase tracking-tighter">
                        {editingId ? <Edit3 className="w-4 h-4 mr-2 text-indigo-600" /> : <Plus className="w-4 h-4 mr-2 text-indigo-600" />}
                        {editingId ? 'Edit Component' : 'New Component'}
                    </h3>
                    {editingId && (
                        <button onClick={cancelEdit} className="text-[10px] font-black text-red-600 uppercase hover:underline">Cancel Edit</button>
                    )}
                </div>
                
                <div className="space-y-4">
                    {itemActionError && (
                        <div className="p-3 bg-red-50 border border-red-200 rounded-md flex items-start text-xs text-red-700 animate-in slide-in-from-top-1">
                            <ShieldAlert className="w-4 h-4 mr-2 flex-shrink-0" />
                            <span>{itemActionError}</span>
                        </div>
                    )}

                    <div>
                        <label className="block text-[10px] font-black text-slate-500 mb-1 uppercase tracking-widest">Component Type</label>
                        <select 
                            className="w-full border-slate-300 rounded-md text-sm shadow-sm disabled:bg-slate-100" 
                            value={activeItemType} 
                            disabled={!!editingId || isReadOnly}
                            onChange={e => {
                                const type = e.target.value as ComponentType;
                                setActiveItemType(type);
                            }}
                        >
                            {ITEM_TYPE_ORDER.map(t => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
                        </select>
                    </div>

                    <div>
                        <div className="flex justify-between items-end mb-1">
                            <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest">Display Name *</label>
                            {managedDisplayNamesEnabled && !isReadOnly && (
                                <button onClick={() => setIsManagingDisplayNames(true)} className="text-[9px] font-bold text-indigo-600 hover:text-indigo-800 transition flex items-center"><Plus className="w-2 h-2 mr-0.5" /> Manage Display Names</button>
                            )}
                        </div>
                        {activeItemType === 'PRIMARY_PACKAGING' ? (
                            <select
                                className="w-full border-slate-300 rounded-md text-sm shadow-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                                value={newItem.component_name}
                                onChange={e => setNewItem({...newItem, component_name: e.target.value})}
                                disabled={isReadOnly}
                            >
                                <option value="">-- Select Product Family --</option>
                                {FAMILY_DEFINITIONS.map(f => (
                                <option key={f.code} value={f.name}>{f.name}</option>
                                ))}
                            </select>
                        ) : activeItemType === 'SECONDARY_PACKAGING' ? (
                            <select
                                className="w-full border-slate-300 rounded-md text-sm shadow-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                                value={newItem.component_name}
                                onChange={e => {
                                const val = e.target.value;
                                setNewItem({...newItem, component_name: val, id_core: resolveSelectedDisplayNameCore(activeItemType, val)});
                                }}
                                disabled={isReadOnly}
                            >
                                <option value="">-- Select Secondary Type --</option>
                                {displayNameOptions.map(name => (
                                <option key={name} value={name}>{name}</option>
                                ))}
                            </select>
                        ) : activeItemType === 'CONSUMABLE' ? (
                            <select
                                className="w-full border-slate-300 rounded-md text-sm shadow-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                                value={newItem.component_name}
                                onChange={e => {
                                const val = e.target.value;
                                setNewItem({
                                    ...newItem, 
                                    component_name: val, 
                                    id_core: resolveSelectedDisplayNameCore(activeItemType, val)
                                });
                                }}
                                disabled={isReadOnly}
                            >
                                <option value="">-- Select Consumable Type --</option>
                                {displayNameOptions.map(name => (
                                <option key={name} value={name}>{name}</option>
                                ))}
                            </select>
                        ) : activeItemType === 'DISPENSING' ? (
                            <select
                                className="w-full border-slate-300 rounded-md text-sm shadow-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                                value={newItem.component_name}
                                onChange={e => {
                                const val = e.target.value;
                                setNewItem({
                                    ...newItem,
                                    component_name: val,
                                    id_core: resolveSelectedDisplayNameCore(activeItemType, val)
                                });
                                }}
                                disabled={isReadOnly}
                            >
                                <option value="">-- Select Dispensing Type --</option>
                                {displayNameOptions.map(name => (
                                <option key={name} value={name}>{name}</option>
                                ))}
                            </select>
                        ) : activeItemType === 'LABEL' ? (
                            <select
                                className="w-full border-slate-300 rounded-md text-sm shadow-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                                value={newItem.component_name}
                                onChange={e => setNewItem({...newItem, component_name: e.target.value})}
                                disabled={isReadOnly}
                            >
                                <option value="">-- Select Product Family --</option>
                                {FAMILY_DEFINITIONS.map(f => (
                                <option key={f.code} value={f.name}>{f.name}</option>
                                ))}
                            </select>
                        ) : activeItemType === 'PALLET_LOGISTICS' ? (
                            <select
                                className="w-full border-slate-300 rounded-md text-sm shadow-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                                value={newItem.component_name}
                                onChange={e => {
                                const val = e.target.value;
                                setNewItem({
                                    ...newItem,
                                    component_name: val,
                                    id_core: resolveSelectedDisplayNameCore(activeItemType, val)
                                });
                                }}
                                disabled={isReadOnly}
                            >
                                <option value="">-- Select Pallet Type --</option>
                                {displayNameOptions.map(name => (
                                <option key={name} value={name}>{name}</option>
                                ))}
                            </select>
                        ) : (
                            <input 
                                className="w-full border-slate-300 rounded-md text-sm shadow-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500" 
                                placeholder="e.g. Bacteria" 
                                value={newItem.component_name} 
                                onChange={e => setNewItem({...newItem, component_name: e.target.value})}
                                disabled={isReadOnly}
                            />
                        )}
                        
                        {exactNameMatch && !isSaving && (
                          <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded-md">
                            <div className="flex items-center text-[9px] font-black text-amber-700 uppercase mb-1">
                              <AlertTriangle className="w-3 h-3 mr-1" /> Duplicate Name
                            </div>
                            <div className="text-[9px] text-amber-800">
                              Exact match found: <span className="font-mono">{exactNameMatch.component_id}</span>
                            </div>
                          </div>
                        )}

                        {similarNames.length > 0 && !isSaving && (
                            <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded-md">
                                <div className="flex items-center text-[9px] font-black text-amber-700 uppercase mb-1">
                                <AlertTriangle className="w-3 h-3 mr-1" /> Similar Names Found
                                </div>
                                <div className="text-[9px] text-amber-800 space-y-1">
                                {similarNames.map(match => (
                                    <div key={match.component_id} className="flex justify-between">
                                    <span>{match.component_name}</span>
                                    <span className="font-mono opacity-60">{match.component_id}</span>
                                    </div>
                                ))}
                                </div>
                                <div className="mt-1 text-[8px] text-amber-600 italic">You can still proceed if using a different version.</div>
                            </div>
                        )}
                    </div>

                    <div>
                        <div className="flex justify-between items-end mb-1">
                            <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest">Category</label>
                            {!editingId && !isReadOnly && (
                                <button onClick={() => setIsAddingCategory(true)} className="text-[9px] font-bold text-indigo-600 hover:text-indigo-800 transition flex items-center"><Plus className="w-2 h-2 mr-0.5" /> Manage Category</button>
                            )}
                        </div>
                        <select 
                            className="w-full border-slate-300 rounded-md text-sm shadow-sm" 
                            value={newItem.category} 
                            onChange={e => setNewItem({...newItem, category: e.target.value})}
                            disabled={isReadOnly}
                        >
                            {typeConfig?.categoryOptions.map(opt => (
                                <option key={opt.code} value={opt.code}>{formatCategoryDisplay(opt)}</option>
                            ))}
                        </select>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-[10px] font-black text-slate-500 mb-1 uppercase tracking-widest">{typeConfig?.subcategoryLabel || 'Subcategory'}</label>
                            {['SECONDARY_PACKAGING', 'CONSUMABLE', 'DISPENSING', 'LABEL', 'PALLET_LOGISTICS'].includes(activeItemType) ? (
                                <input 
                                type="text"
                                className="w-full border-slate-300 rounded-md text-sm shadow-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500" 
                                placeholder={activeItemType === 'CONSUMABLE' ? 'e.g. 500m' : (['DISPENSING', 'LABEL', 'PALLET_LOGISTICS'].includes(activeItemType) ? 'e.g. 500ml' : 'e.g. 15x10x5cm')}
                                value={newItem.subcategory} 
                                onChange={e => setNewItem({...newItem, subcategory: e.target.value})}
                                disabled={isReadOnly}
                                />
                            ) : (
                                <select 
                                className="w-full border-slate-300 rounded-md text-sm shadow-sm" 
                                value={newItem.subcategory} 
                                onChange={e => setNewItem({...newItem, subcategory: e.target.value})}
                                disabled={isReadOnly}
                                >
                                {typeConfig?.subcategoryOptions.map(opt => (
                                    <option key={opt} value={opt}>{opt}</option>
                                ))}
                                </select>
                            )}
                        </div>
                        <div>
                            <label className="block text-[10px] font-black text-slate-500 mb-1 uppercase tracking-widest">Default Unit</label>
                            <select 
                                className="w-full border-slate-300 rounded-md text-sm shadow-sm" 
                                value={newItem.default_unit} 
                                onChange={e => setNewItem({...newItem, default_unit: e.target.value})}
                                disabled={isReadOnly}
                            >
                                {typeConfig?.defaultUnitOptions.map(opt => (
                                <option key={opt} value={opt}>{opt}</option>
                                ))}
                            </select>
                        </div>
                    </div>

                    <div>
                        <label className="block text-[10px] font-black text-slate-500 mb-1 uppercase tracking-widest">Version</label>
                        <select 
                            className="w-full border-slate-300 rounded-md text-sm shadow-sm" 
                            value={newItem.version} 
                            onChange={e => setNewItem({...newItem, version: toVersionString(parseVersionNumber(e.target.value) || 1)})}
                            disabled={isReadOnly}
                        >
                            {Array.from(new Set([...VERSION_OPTIONS, newItem.version]))
                              .sort((a, b) => parseVersionNumber(a) - parseVersionNumber(b))
                              .map(v => <option key={v} value={v}>{v}</option>)}
                        </select>
                    </div>

                    <div>
                        <label className="block text-[10px] font-black text-slate-500 mb-1 uppercase tracking-widest">Notes (Optional)</label>
                        <textarea 
                            className="w-full border-slate-300 rounded-md text-sm shadow-sm h-16 resize-none" 
                            placeholder="Storage or QC instructions..." 
                            value={newItem.notes} 
                            onChange={e => setNewItem({...newItem, notes: e.target.value})}
                            disabled={isReadOnly}
                        />
                    </div>

                    <div className="space-y-1">
                        <div className="flex justify-between items-center">
                            <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest">Component ID</label>
                            <div className="flex items-center space-x-2">
                                <button 
                                    onClick={() => {
                                    if (!isEditingCore && !newItem.id_core) {
                                        const currentCore = extractCoreFromComponentId(newItem.component_id, activeItemType);
                                        if (currentCore) setNewItem(prev => ({ ...prev, id_core: currentCore }));
                                    }
                                    setIsEditingCore(!isEditingCore);
                                    }}
                                    disabled={isReadOnly}
                                    className={`text-[9px] font-bold text-indigo-600 uppercase hover:underline ${isReadOnly ? 'opacity-50 cursor-not-allowed' : ''}`}
                                >
                                    {isEditingCore ? 'Lock core' : 'Edit core'}
                                </button>
                                {editingId ? (
                                    <span className="flex items-center text-[9px] font-bold text-slate-400 uppercase tracking-wider"><Lock className="w-2.5 h-2.5 mr-1" /> Read Only</span>
                                ) : (
                                    <span className="flex items-center text-[9px] font-bold text-indigo-500 uppercase tracking-wider animate-pulse"><Zap className="w-2.5 h-2.5 mr-1" /> Auto-Suggesting</span>
                                )}
                            </div>
                        </div>

                        {isEditingCore && !isReadOnly && (
                            <div className="mb-2 p-2 bg-indigo-50 border border-indigo-100 rounded flex flex-col gap-1 animate-in slide-in-from-top-1">
                                <div className="flex items-center gap-2">
                                    <span className="text-[10px] font-bold text-indigo-400 uppercase whitespace-nowrap">Core segment:</span>
                                    <input 
                                        className={`flex-1 border rounded text-xs font-mono py-1 px-2 uppercase shadow-inner ${!coreValidation.ok ? 'border-red-300 bg-red-50' : 'border-slate-200 bg-white'}`}
                                        placeholder="e.g. 001BAG"
                                        value={newItem.id_core}
                                        onChange={e => {
                                        const val = e.target.value.toUpperCase();
                                        if (val.length <= 12) {
                                            setNewItem({...newItem, id_core: val});
                                        }
                                        }}
                                    />
                                </div>
                                {!coreValidation.ok && (
                                    <div className="flex items-center text-[9px] font-bold text-red-600 uppercase px-1">
                                    <AlertTriangle className="w-2.5 h-2.5 mr-1" /> {coreValidation.reason}
                                    </div>
                                )}
                            </div>
                        )}

                        <input 
                            className={`w-full border-slate-300 rounded-md text-sm shadow-sm font-mono ${editingId || isReadOnly ? 'bg-slate-100 text-slate-500' : 'bg-indigo-50/30 border-indigo-100'}`}
                            placeholder="IGD-..." 
                            value={newItem.component_id} 
                            readOnly={true}
                        />
                        {idConflict && !isSaving && (
                            <div className="mt-1 flex items-center text-[9px] font-black text-red-600 bg-red-50 p-1.5 rounded border border-red-100 animate-pulse">
                                <ShieldAlert className="w-3 h-3 mr-1" /> ID Conflict: {newItem.component_id} already exists as "{idConflict.component_name}".
                            </div>
                        )}
                        {componentRenamePending && !idConflict && !isSaving && (
                            <div className="mt-1 flex items-center justify-between gap-2">
                                <div className="flex items-center text-[9px] font-black text-amber-700 bg-amber-50 p-1.5 rounded border border-amber-100">
                                    <AlertTriangle className="w-3 h-3 mr-1" /> Saving will rename this component ID across linked records.
                                </div>
                                <button
                                    type="button"
                                    onClick={() => void handlePreviewRenameImpact()}
                                    disabled={isPreviewingRename}
                                    className="text-[10px] font-bold text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
                                >
                                    {isPreviewingRename ? 'Previewing...' : 'Preview Impact'}
                                </button>
                            </div>
                        )}
                        <p className="text-[9px] text-slate-400 mt-1 italic">Segments other than core are driven by dropdown selections.</p>
                    </div>

                    <button 
                        onClick={handleSaveItem} 
                        disabled={isSaveDisabled || isSaving}
                        className="w-full py-3 bg-indigo-600 text-white rounded-md text-sm font-bold shadow-md hover:bg-indigo-700 transition disabled:opacity-50 flex items-center justify-center"
                    >
                        {isSaving ? (
                            <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Processing...</>
                        ) : (
                            editingId ? 'Save Changes' : 'Create Component'
                        )}
                    </button>
                </div>
            </div>
        </div>

        {/* List Column */}
        <div className={detailPanelClass}>
            <div className="flex flex-col space-y-4 mb-2">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap items-center gap-2 sm:gap-4">
                    <h3 className="font-bold text-slate-800">Master Component Registry</h3>
                    <button 
                        onClick={() => setIsNamingRulesOpen(true)}
                        className="flex items-center text-[10px] font-bold text-slate-400 hover:text-indigo-600 transition uppercase tracking-widest"
                    >
                        <Info className="w-3 h-3 mr-1" /> View Standards
                    </button>
                </div>
                <div className="relative w-full sm:w-auto">
                <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
                <input type="text" className="pl-9 pr-4 py-2 border-slate-200 rounded-full text-xs w-full sm:w-48 shadow-sm focus:border-indigo-500 outline-none" placeholder="Filter list..." value={itemSearch} onChange={e => setItemSearch(e.target.value)} />
                </div>
            </div>
            <div className="flex flex-wrap gap-2 border-b border-slate-100 pb-4">
                {RAW_COMPONENT_TABS.map(type => (
                <button
                    key={type}
                    onClick={() => {
                      if (type === 'ARCHIVED') {
                        setActiveListTab('ARCHIVED');
                        return;
                      }
                      setActiveItemType(type);
                      setActiveListTab(type);
                    }}
                    className={`px-3 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all ${
                    activeListTab === type 
                        ? 'bg-indigo-600 text-white shadow-sm' 
                        : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                    }`}
                >
                    {type.replace('_', ' ')}
                </button>
                ))}
            </div>
            </div>

            <div className="border border-slate-200 rounded-lg shadow-sm min-h-[20rem] md:h-[560px] overflow-hidden">
            <div className="mobile-scroll-hint px-4 pt-3">Swipe sideways to see the full registry table.</div>
            <div className="mobile-table-region h-full overflow-x-auto overflow-y-visible md:overflow-y-auto">
            <table className="w-full min-w-[760px] text-sm text-left">
                <thead className="sticky top-0 z-10 bg-slate-50 text-slate-500 font-bold uppercase text-[10px] tracking-widest border-b border-slate-200">
                    <tr>
                    <th 
                        className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors select-none"
                        onClick={() => toggleItemSort('name')}
                    >
                        <div className="flex items-center">
                        Item Details
                        {itemSortField === 'name' && (itemSortDir === 'asc' ? <ChevronUp className="w-3 h-3 ml-1" /> : <ChevronDown className="w-3 h-3 ml-1" />)}
                        </div>
                    </th>
                    <th 
                        className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors select-none"
                        onClick={() => toggleItemSort('id')}
                    >
                        <div className="flex items-center">
                        ID
                        {itemSortField === 'id' && (itemSortDir === 'asc' ? <ChevronUp className="w-3 h-3 ml-1" /> : <ChevronDown className="w-3 h-3 ml-1" />)}
                        </div>
                    </th>
                    <th className="px-4 py-3">Default Unit</th>
                    <th className="px-4 py-3 text-right w-[140px]">Actions</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                    {processedInventory.map(item => (
                    <tr key={item.component_id} className="hover:bg-slate-50/50 transition-colors group">
                        <td className="px-4 py-3">
                        <div className="font-semibold text-slate-700">{formatRawComponentListLabel(item, categories)}</div>
                        <div className="text-[10px] text-slate-400 font-mono flex items-center">
                            CAT {item.category} • {item.subcategory} • v{item.version}
                        </div>
                        {item.notes && (
                            <div className="text-[10px] text-slate-500 mt-1 italic border-l-2 border-slate-100 pl-2 max-w-xs truncate" title={item.notes}>
                            {item.notes}
                            </div>
                        )}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-400">{item.component_id}</td>
                        <td className="px-4 py-3 text-xs font-bold text-slate-600">{item.default_unit}</td>
                        <td className="px-4 py-3 align-top">
                        {!isReadOnly && (
                            <div className="flex justify-end items-start gap-1 whitespace-nowrap min-w-[120px]">
                                {activeListTab === 'ARCHIVED' ? (
                                    <button
                                        onClick={() => void handleRestore(item.component_id)}
                                        title={restoringId === item.component_id ? "Restoring Component..." : "Restore Component"}
                                        disabled={restoringId === item.component_id}
                                        className="p-2 text-slate-300 hover:text-green-600 hover:bg-green-50 rounded-full transition disabled:opacity-60 disabled:cursor-not-allowed"
                                    >
                                        {restoringId === item.component_id ? <Loader2 className="w-4 h-4 animate-spin text-green-600" /> : <RotateCcw className="w-4 h-4" />}
                                    </button>
                                ) : (
                                    <>
                                        <button onClick={() => handleEditItem(item)} title="Edit Record" className="p-2 text-slate-300 hover:text-indigo-600 hover:bg-indigo-50 rounded-full transition"><Edit3 className="w-4 h-4" /></button>
                                        <button onClick={() => handleDuplicateItem(item)} title="Duplicate as New Version" className="p-2 text-slate-300 hover:text-indigo-600 hover:bg-indigo-50 rounded-full transition"><Copy className="w-4 h-4" /></button>
                                        <button onClick={() => initiateArchive(item.component_id, item.component_name)} title="Archive Component" className="p-2 text-slate-300 hover:text-amber-600 hover:bg-amber-50 rounded-full transition"><Archive className="w-4 h-4" /></button>
                                    </>
                                )}
                            </div>
                        )}
                        </td>
                    </tr>
                    ))}
                    {processedInventory.length === 0 && (
                    <tr><td colSpan={4} className="py-20 text-center text-slate-400 italic">{activeListTab === 'ARCHIVED' ? 'No archived components found.' : 'No components found for this selection.'}</td></tr>
                    )}
                </tbody>
            </table>
            </div>
            </div>
        </div>
    </div>
  );
};
