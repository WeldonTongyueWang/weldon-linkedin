/**
 * HARD BOUNDARY: FINISHED PRODUCT CHANGE REQUEST
 *
 * AUTHORITY: Primary UI for Finished Product Master Data.
 * RULES:
 * 1. Only finished product master data may be created or edited.
 * 2. No raw component or inventory movement logic may be changed.
 * 3. SKU IDs are immutable once created.
 */

import React, { useState, useMemo } from 'react';
import { Product, BOMItem, ComponentType, Component } from '../../types';
import {
  Trash2,
  Archive,
  ListTodo,
  Plus,
  Search,
  Wand2,
  ShieldAlert,
  X,
  Edit3,
  Beaker,
  Save,
  Percent,
  RotateCcw,
  AlertTriangle,
  ChevronUp,
  ChevronDown,
  Loader2,
  Download,
  Info,
  BookOpen,
  Copy,
} from 'lucide-react';
import { FAMILY_DEFINITIONS } from '../../constants';
import {
  FinishedProductSkuCategoryOptions,
  buildFinishedProductSkuId,
} from '../../masterdata/finishedProductSkuRules';
import { RAW_COMPONENT_REGISTRY, CategoryOption } from '../../masterdata/rawComponentRegistry';
import {
  previewMasterIdRename,
  saveRecipeBatch,
  type MasterRenamePreviewResponse,
} from '../../services/sheetsApi';
import {
  BomVariantMeta,
  DEFAULT_BOM_VARIANT_ID,
  DEFAULT_BOM_VARIANT_NAME,
  getBomLinesForSkuVariant,
  isFormulationLine,
  listBomVariantsForSku,
  normalizeBomLine,
  normalizeBomVariantId,
  normalizeLineKindForSectioning,
} from '../../services/bomVariants';
import { useAppDialog } from '../ui/AppDialogProvider';
import { useIsHandheldDevice } from '../../lib/useIsHandheldDevice';
import { formatRawComponentListLabel } from '../../utils/rawComponentLabels';
import { formatFinishedProductInventoryLabel } from '../../utils/finishedProductLabels';

interface Props {
  currentUser: string;
  products: Product[];
  inventory: Component[];
  categories: any[]; // Used for label formatting
  bom: BOMItem[];
  setBom: React.Dispatch<React.SetStateAction<BOMItem[]>>;
  onPersistProduct?: (
    prod: Product,
    originalId?: string,
  ) => Promise<{ success: boolean; error?: string }>;
  onDeleteProduct?: (id: string) => Promise<void> | void;
  onPersistBom?: (bom: BOMItem) => void;
  isReadOnly?: boolean;
}

type ProductSubTab =
  | 'COMP_A'
  | 'BLENDED'
  | 'SACHET'
  | 'FINISHED'
  | 'DISPENSING'
  | 'SAMPLE'
  | 'ARCHIVED';
// Reordered tabs: Comp A, Blended, Sachet, Finished, Dispensing, Sample, Archived
const PRODUCT_SUB_TABS: ProductSubTab[] = [
  'COMP_A',
  'BLENDED',
  'SACHET',
  'FINISHED',
  'DISPENSING',
  'SAMPLE',
  'ARCHIVED',
];
const ITEM_TYPE_ORDER: ComponentType[] = [
  'INGREDIENT',
  'PRIMARY_PACKAGING',
  'SECONDARY_PACKAGING',
  'CONSUMABLE',
  'DISPENSING',
  'LABEL',
  'PALLET_LOGISTICS',
];

const DEFAULT_UNIT_OPTIONS = [
  'kg',
  'pcs',
  'Drum',
  'Bottle',
  'Pouch',
  'Sachet',
  'Box',
  'Pallet',
  'Bag',
];
const PRODUCT_PERSIST_KEYS = [
  'sku_id',
  'sku_name',
  'family',
  'category',
  'format',
  'default_unit',
  'notes',
  'createdAt',
  'updatedAt',
  'updatedBy',
] as const;
const PRODUCT_PERSIST_KEY_SET = new Set<string>(PRODUCT_PERSIST_KEYS);

// Local type to handle input strings for precision entry
type LocalRecipeLine = Partial<
  Omit<BOMItem, 'qty_per_kg'> & { qty_per_kg: string | number; localId: string }
>;
type RecipeVariantDraft = BomVariantMeta;

const FORMULATION_TOLERANCE = 0.0005;
const createLocalId = () => Math.random().toString(36).substring(2, 11);

const makeVariantIdFromName = (name: string): string => {
  const token = String(name || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return token ? `VAR-${token}` : `VAR-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
};

const buildPersistableProductPayload = (source: Partial<Product>): Product => ({
  sku_id: source.sku_id || '',
  sku_name: source.sku_name || '',
  family: source.family || '',
  category: source.category || '',
  format: source.format || '',
  default_unit: source.default_unit || 'kg',
  notes: source.notes,
  createdAt: source.createdAt,
  updatedAt: source.updatedAt,
  updatedBy: source.updatedBy,
});

const warnUnexpectedProductPersistKeys = (payload: Record<string, unknown>, action: string) => {
  const unexpected = Object.keys(payload).filter((key) => !PRODUCT_PERSIST_KEY_SET.has(key));
  if (unexpected.length > 0) {
    console.warn(`[FinishedProductsView] Unexpected ${action} product payload keys:`, unexpected);
  }
};

const stripLeadingCode = (val: string | number | undefined | null): string => {
  if (val === undefined || val === null || val === '') return '';
  let str = String(val).trim();
  str = str.replace(/^\s*\d{1,2}\s*[-–]\s*/, '');
  str = str.replace(/^\s*\d+\s+/, '');
  return str.trim();
};

const normalizeSkuIdForConflictCheck = (value: string | undefined | null): string =>
  String(value || '')
    .trim()
    .toLowerCase();

const formatRenamePreviewMessage = (preview: MasterRenamePreviewResponse): string => {
  const countLines = Object.entries(preview.counts || {})
    .filter(([key, value]) => key !== 'totalAffected' && Number(value || 0) > 0)
    .map(([key, value]) => `${key}: ${Number(value || 0)}`);
  const effectLines = (preview.effects || []).map((effect) => `- ${effect}`);
  return [
    `${preview.oldId} -> ${preview.newId}`,
    '',
    `Estimated affected records: ${Number(preview.counts?.totalAffected || 0)}`,
    ...(countLines.length > 0 ? ['', ...countLines] : []),
    ...(effectLines.length > 0 ? ['', ...effectLines] : []),
  ].join('\n');
};

const FINISHED_SKU_STRUCTURE = 'PRT-FFFAAA-CC-FORMAT-VV';
const skuVersionToNumber = (value: string | undefined | null): number => {
  const parsed = parseInt(String(value || '').replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};
const skuVersionToString = (value: number): string => {
  if (!Number.isFinite(value) || value < 1) return '01';
  return value.toString().padStart(2, '0');
};
const parseSkuSegments = (
  skuId: string | undefined,
): {
  familySegment: string;
  categoryCode: string;
  formatSegment: string;
  versionSegment: string;
} | null => {
  const segments = String(skuId || '')
    .trim()
    .split('-');
  if (segments.length < 5) return null;
  return {
    familySegment: segments[1] || '',
    categoryCode: segments[2] || '',
    formatSegment: segments[3] || '',
    versionSegment: segments[4] || '',
  };
};

export const FinishedProductsView: React.FC<Props> = ({
  currentUser,
  products,
  inventory,
  bom,
  setBom,
  onPersistProduct,
  onDeleteProduct,
  categories,
  isReadOnly,
}) => {
  const isHandheldDevice = useIsHandheldDevice();
  const appDialog = useAppDialog();
  const [activeProductSubTab, setActiveProductSubTab] = useState<ProductSubTab>('COMP_A');
  const [productSearch, setProductSearch] = useState('');
  const [productSortField, setProductSortField] = useState<'name' | 'id'>('id');
  const [productSortDir, setProductSortDir] = useState<'asc' | 'desc'>('asc');

  const [productActionError, setProductActionError] = useState<string | null>(null);

  // Editing State
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [originalEditingSkuId, setOriginalEditingSkuId] = useState<string | null>(null);
  const [duplicateSourceSkuId, setDuplicateSourceSkuId] = useState<string | null>(null);

  const [editingRecipeSku, setEditingRecipeSku] = useState<string | null>(null);
  const [localRecipe, setLocalRecipe] = useState<LocalRecipeLine[]>([]);
  const [recipeVariants, setRecipeVariants] = useState<RecipeVariantDraft[]>([]);
  const [selectedBomVariantId, setSelectedBomVariantId] = useState<string>(DEFAULT_BOM_VARIANT_ID);

  // Loading States
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [restoringProductId, setRestoringProductId] = useState<string | null>(null);
  const [isNamingRulesOpen, setIsNamingRulesOpen] = useState(false);
  const [isPreviewingRename, setIsPreviewingRename] = useState(false);

  // Deletion State
  const [deleteModal, setDeleteModal] = useState<{
    isOpen: boolean;
    mode: 'SOFT_ARCHIVE' | 'HARD_DELETE';
    id: string | null;
    name: string;
  }>({
    isOpen: false,
    mode: 'SOFT_ARCHIVE',
    id: null,
    name: '',
  });

  const [newProduct, setNewProduct] = useState<
    Partial<Product> & { categoryCode?: string; versionStr?: string }
  >({
    sku_id: '',
    sku_name: '',
    family: FAMILY_DEFINITIONS[0].name,
    format: '',
    category: 'Commercial Product',
    categoryCode: '01',
    versionStr: '01',
    default_unit: 'kg', // Ensures a default is always set for new SKUs
    notes: '',
  });

  const constructedSkuName = useMemo(() => {
    if (!newProduct.family || !newProduct.format) return '';
    return `${stripLeadingCode(newProduct.family)} ${newProduct.format}`;
  }, [newProduct.family, newProduct.format]);

  const duplicateProduct = useMemo(() => {
    if (!constructedSkuName) return null;
    const search = constructedSkuName.trim().toLowerCase();
    return products.find((p) => (p.sku_name || '').trim().toLowerCase() === search);
  }, [constructedSkuName, products]);
  const newSkuIdConflict = useMemo(() => {
    const normalized = normalizeSkuIdForConflictCheck(newProduct.sku_id);
    if (!normalized) return null;
    return products.find((p) => normalizeSkuIdForConflictCheck(p.sku_id) === normalized) || null;
  }, [newProduct.sku_id, products]);

  const recipeMetadata = useMemo(() => {
    if (!editingRecipeSku) return { segment: null, isReadOnly: false, ruleType: 'FINISHED' };
    const p = products.find((prod) => prod.sku_id === editingRecipeSku);
    if (!p) return { segment: null, isReadOnly: false, ruleType: 'FINISHED' };

    const category = (p.category || '').toLowerCase();
    const format = (p.format || '').toLowerCase();
    const isArchived = category.includes('archived');

    // Derive Rule Type for BOM Restrictions
    let ruleType = 'FINISHED';
    if (category.includes('intermediate') || (isArchived && format.includes('component a')))
      ruleType = 'COMP_A';
    else if (category.includes('blended') || (isArchived && format.includes('blended')))
      ruleType = 'BLENDED';
    else if (category.includes('sample') || (isArchived && format.includes('sample')))
      ruleType = 'SAMPLE';
    else ruleType = 'FINISHED'; // Covers Commercial Product, Dispensing, etc.

    let segment: ProductSubTab = 'FINISHED';
    if (isArchived) segment = 'ARCHIVED';
    else segment = activeProductSubTab;

    return { segment, isReadOnly: segment === 'ARCHIVED' || isReadOnly, ruleType };
  }, [editingRecipeSku, products, activeProductSubTab, isReadOnly]);

  const splitRecipe = useMemo(() => {
    const ingredients = localRecipe.filter((l) => isFormulationLine(l as BOMItem));
    const consumables = localRecipe.filter((l) => !isFormulationLine(l as BOMItem));

    const coreIngredientTotal = ingredients.reduce((sum, l) => {
      const type = l.component_type || '';
      const isCore = ['INGREDIENT', 'COMP_A_SKU', 'BLENDED_SKU'].includes(type);
      // Ensure we cast to number for calculation, handling string inputs
      return isCore ? sum + Number(l.qty_per_kg || 0) : sum;
    }, 0);

    return { ingredients, consumables, coreIngredientTotal };
  }, [localRecipe]);
  const activeRecipeVariant = useMemo(
    () =>
      recipeVariants.find((v) => v.bomVariantId === selectedBomVariantId) ||
      recipeVariants[0] ||
      null,
    [recipeVariants, selectedBomVariantId],
  );

  const filteredProducts = useMemo(() => {
    let result = [...products];

    result = result.filter((p) => {
      const category = (p.category || '').toLowerCase();
      const skuName = (p.sku_name || '').toLowerCase();
      const isArchived = category.includes('archived');
      const isSingleSachet = skuName.includes('single sachet');

      // 1. Handling Archive Tab
      if (activeProductSubTab === 'ARCHIVED') {
        return isArchived;
      }
      if (isArchived) {
        return false;
      }

      // 1b. UI-only grouping: non-archived items named "Single Sachet" live in Sachet tab.
      if (isSingleSachet) {
        return activeProductSubTab === 'SACHET';
      }

      if (activeProductSubTab === 'SACHET') {
        return false;
      }

      // 2. Strict Category Matching based on updated codes
      // Comp A -> Intermediate (05)
      if (activeProductSubTab === 'COMP_A') {
        return category.includes('intermediate') || category.includes('05');
      }

      // Blended -> Blended (06)
      if (activeProductSubTab === 'BLENDED') {
        return category.includes('blended') || category.includes('06');
      }

      // Finished -> Commercial Product (01)
      if (activeProductSubTab === 'FINISHED') {
        return category === 'commercial product' || category.includes('01');
      }

      // Dispensing -> Commercial Dispensing (03)
      if (activeProductSubTab === 'DISPENSING') {
        return category === 'commercial dispensing' || category.includes('03');
      }

      // Sample -> Sample Product (02) + Sample Dispensing (04)
      if (activeProductSubTab === 'SAMPLE') {
        return category.includes('sample') || category.includes('02') || category.includes('04');
      }

      return false;
    });

    if (productSearch) {
      const q = productSearch.toLowerCase();
      result = result.filter(
        (p) =>
          (p.sku_name || '').toLowerCase().includes(q) ||
          (p.sku_id || '').toLowerCase().includes(q) ||
          (p.family || '').toLowerCase().includes(q),
      );
    }

    result.sort((a, b) => {
      const valA = productSortField === 'name' ? a.sku_name || '' : a.sku_id || '';
      const valB = productSortField === 'name' ? b.sku_name || '' : b.sku_id || '';
      const cmp = valA.localeCompare(valB);
      return productSortDir === 'asc' ? cmp : -cmp;
    });

    return result;
  }, [products, activeProductSubTab, productSearch, productSortField, productSortDir]);

  const toggleProductSort = (field: 'name' | 'id') => {
    if (productSortField === field) {
      setProductSortDir(productSortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setProductSortField(field);
      setProductSortDir('asc');
    }
  };

  const handleSuggestSkuId = async () => {
    if (isReadOnly) return;
    const famDef = FAMILY_DEFINITIONS.find((f) => f.name === newProduct.family);
    if (!famDef) {
      await appDialog.alert({
        message: 'Please select a product family first to generate an ID.',
        tone: 'warning',
      });
      return;
    }

    const normalizedExisting = new Set(
      products.map((p) => normalizeSkuIdForConflictCheck(p.sku_id)),
    );
    let nextVersion = Math.max(1, skuVersionToNumber(newProduct.versionStr || '01'));
    let suggestedId = '';

    while (!suggestedId) {
      const candidate = buildFinishedProductSkuId({
        familyCode: famDef.code,
        familyAbbr: famDef.abbr,
        categoryCode: newProduct.categoryCode || '01',
        formatVariant: newProduct.format || 'Standard',
        version: skuVersionToString(nextVersion),
      });
      if (!normalizedExisting.has(normalizeSkuIdForConflictCheck(candidate))) {
        suggestedId = candidate;
      } else {
        nextVersion += 1;
      }
    }

    setNewProduct((prev) => ({
      ...prev,
      sku_id: suggestedId,
      versionStr: skuVersionToString(nextVersion),
    }));
    setProductActionError(null);
  };

  const handleAddProduct = async () => {
    if (isReadOnly) return;
    if (!newProduct.sku_id || !newProduct.format) {
      await appDialog.alert({
        message: 'SKU ID and Format/Variant are required.',
        tone: 'warning',
      });
      return;
    }
    if (newSkuIdConflict) {
      await appDialog.alert({
        message: `SKU ID ${newProduct.sku_id} already exists. Please choose a unique ID.`,
        tone: 'warning',
      });
      return;
    }

    setProductActionError(null);

    const finalProduct = buildPersistableProductPayload({
      sku_id: newProduct.sku_id,
      sku_name: `${stripLeadingCode(newProduct.family)} ${newProduct.format}`,
      family: newProduct.family || FAMILY_DEFINITIONS[0].name,
      category: newProduct.category || 'Commercial Product',
      format: newProduct.format,
      default_unit: newProduct.default_unit || 'kg',
      notes: newProduct.notes,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      updatedBy: currentUser,
    });
    warnUnexpectedProductPersistKeys(finalProduct as unknown as Record<string, unknown>, 'create');

    if (onPersistProduct) {
      setIsSaving(true);
      try {
        const result = await onPersistProduct(finalProduct);
        if (result.success) {
          setNewProduct({
            sku_id: '',
            sku_name: '',
            family: FAMILY_DEFINITIONS[0].name,
            format: '',
            category: 'Commercial Product',
            categoryCode: '01',
            versionStr: '01',
            default_unit: 'kg',
            notes: '',
          });
        } else {
          setProductActionError(result.error || 'An error occurred while saving the product.');
        }
      } catch (e: any) {
        setProductActionError(e.message || 'An unexpected error occurred.');
      } finally {
        setIsSaving(false);
      }
    }
  };

  const handleEditProductInit = (p: Product) => {
    if (isReadOnly) return;
    setEditingProduct({ ...p });
    setOriginalEditingSkuId(p.sku_id);
    setDuplicateSourceSkuId(null);
    setProductActionError(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleDuplicateProductInit = async (p: Product) => {
    if (isReadOnly) return;
    const sourceSegments = parseSkuSegments(p.sku_id);
    if (!sourceSegments) {
      await appDialog.alert({
        message: 'Unable to duplicate: source SKU format is invalid.',
        tone: 'warning',
      });
      return;
    }

    const famDef = FAMILY_DEFINITIONS.find((f) => f.name === p.family);
    const familyCode = famDef?.code || sourceSegments.familySegment.substring(0, 3);
    const familyAbbr = famDef?.abbr || sourceSegments.familySegment.substring(3);
    const categoryCode = sourceSegments.categoryCode;
    const formatVariant = p.format || sourceSegments.formatSegment;

    const matchingVersions = products
      .map((product) => parseSkuSegments(product.sku_id))
      .filter(
        (segments): segments is NonNullable<typeof segments> =>
          segments !== null &&
          segments.familySegment === sourceSegments.familySegment &&
          segments.categoryCode === categoryCode &&
          segments.formatSegment === sourceSegments.formatSegment,
      )
      .map((segments) => skuVersionToNumber(segments.versionSegment));

    const maxVersion = Math.max(
      skuVersionToNumber(sourceSegments.versionSegment),
      ...matchingVersions,
    );
    const nextVersion = skuVersionToString(maxVersion + 1);
    const nextSkuId = buildFinishedProductSkuId({
      familyCode,
      familyAbbr,
      categoryCode,
      formatVariant,
      version: nextVersion,
    });

    setEditingProduct({
      ...p,
      sku_id: nextSkuId,
    });
    setOriginalEditingSkuId(null);
    setDuplicateSourceSkuId(p.sku_id);
    setProductActionError(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const cancelProductEdit = () => {
    setEditingProduct(null);
    setOriginalEditingSkuId(null);
    setDuplicateSourceSkuId(null);
    setProductActionError(null);
  };

  const editIdConflict = useMemo(() => {
    if (!editingProduct) return false;
    const normalizedEditedId = normalizeSkuIdForConflictCheck(editingProduct.sku_id);
    const editingCreatedAt = String(editingProduct.createdAt || '').trim();
    const normalizedOriginalId = normalizeSkuIdForConflictCheck(originalEditingSkuId);

    // Duplicate mode (or any create-from-edit flow) must still enforce uniqueness.
    if (!originalEditingSkuId) {
      return products.some((p) => normalizeSkuIdForConflictCheck(p.sku_id) === normalizedEditedId);
    }

    // If user changed ID (after trim/case normalization), check for duplicate against other rows.
    if (normalizedEditedId !== normalizedOriginalId) {
      const matchingProducts = products.filter(
        (p) => normalizeSkuIdForConflictCheck(p.sku_id) === normalizedEditedId,
      );
      if (matchingProducts.length === 0) return false;

      if (matchingProducts.length === 1) {
        const onlyMatch = matchingProducts[0];
        const candidateCreatedAt = String(onlyMatch.createdAt || '').trim();
        const originalStillExists = products.some(
          (p) => normalizeSkuIdForConflictCheck(p.sku_id) === normalizedOriginalId,
        );

        // Exclude self-match after rename settles in local state.
        if (!originalStillExists) return false;

        // Also exclude when both rows can be positively identified as the same record.
        if (editingCreatedAt && candidateCreatedAt && candidateCreatedAt === editingCreatedAt) {
          return false;
        }
      }

      return true;
    }
    return false;
  }, [editingProduct?.sku_id, originalEditingSkuId, products]);
  const showEditIdConflict = !isSaving && editIdConflict;
  const skuRenamePending = Boolean(
    editingProduct &&
    !duplicateSourceSkuId &&
    originalEditingSkuId &&
    normalizeSkuIdForConflictCheck(editingProduct.sku_id) !==
      normalizeSkuIdForConflictCheck(originalEditingSkuId),
  );

  const requestRenamePreview = async () => {
    if (!editingProduct || !originalEditingSkuId || !skuRenamePending) return null;
    setIsPreviewingRename(true);
    try {
      return await previewMasterIdRename({
        entityType: 'PRODUCT',
        oldId: originalEditingSkuId,
        newId: editingProduct.sku_id,
      });
    } finally {
      setIsPreviewingRename(false);
    }
  };

  const handlePreviewRenameImpact = async () => {
    if (!skuRenamePending) return;
    try {
      const preview = await requestRenamePreview();
      if (!preview) return;
      await appDialog.alert({
        title: 'Rename Impact Preview',
        message: formatRenamePreviewMessage(preview),
        tone: 'warning',
      });
    } catch (error: any) {
      await appDialog.alert({
        message: error?.message || 'Failed to preview SKU rename impact.',
        tone: 'danger',
      });
    }
  };

  const handleUpdateProduct = async () => {
    if (!editingProduct || isReadOnly) return;
    if (!String(editingProduct.sku_id || '').trim()) {
      await appDialog.alert({ message: 'SKU ID cannot be empty.', tone: 'warning' });
      return;
    }
    if (editIdConflict) {
      await appDialog.alert({
        message: 'Duplicate SKU ID detected. Please choose a unique ID.',
        tone: 'warning',
      });
      return;
    }
    if (skuRenamePending) {
      let preview: MasterRenamePreviewResponse | null = null;
      try {
        preview = await requestRenamePreview();
      } catch (error: any) {
        await appDialog.alert({
          message: error?.message || 'Failed to preview SKU rename impact.',
          tone: 'danger',
        });
        return;
      }
      const confirmed = await appDialog.confirm({
        title: 'Rename Live SKU?',
        message: preview
          ? formatRenamePreviewMessage(preview)
          : `This will rename SKU ${originalEditingSkuId} to ${editingProduct.sku_id}. Continue?`,
        tone: 'warning',
        confirmLabel: 'Rename SKU',
        cancelLabel: 'Cancel',
      });
      if (!confirmed) return;
    }

    if (onPersistProduct) {
      setIsSaving(true);
      try {
        const isDuplicateMode = Boolean(duplicateSourceSkuId);
        const timestamp = new Date().toISOString();
        const updatePayload = buildPersistableProductPayload({
          ...editingProduct,
          createdAt: isDuplicateMode ? timestamp : editingProduct.createdAt,
          updatedAt: timestamp,
          updatedBy: currentUser,
        });
        warnUnexpectedProductPersistKeys(
          updatePayload as unknown as Record<string, unknown>,
          'update',
        );

        const result = await onPersistProduct(
          updatePayload,
          isDuplicateMode ? undefined : originalEditingSkuId || editingProduct.sku_id,
        );

        if (result.success) {
          setEditingProduct(null);
          setOriginalEditingSkuId(null);
          setDuplicateSourceSkuId(null);
        } else {
          await appDialog.alert({
            message: result.error || 'Failed to update product.',
            tone: 'danger',
          });
        }
      } catch (e: any) {
        await appDialog.alert({
          message: e.message || 'Failed to update product.',
          tone: 'danger',
        });
      } finally {
        setIsSaving(false);
      }
    }
  };

  const handleArchiveProduct = async (id: string, restore: boolean) => {
    if (isReadOnly) return;
    const product = products.find((p) => p.sku_id === id);
    if (!product || !onPersistProduct) return;

    const newCategory = restore ? 'Commercial Product' : 'Archived Product';

    const updatedProduct = buildPersistableProductPayload({
      ...product,
      category: newCategory,
      updatedAt: new Date().toISOString(),
      updatedBy: currentUser,
    });
    warnUnexpectedProductPersistKeys(
      updatedProduct as unknown as Record<string, unknown>,
      'archive',
    );

    if (restore) {
      setRestoringProductId(id);
    } else {
      setIsDeleting(true);
    }
    try {
      const result = await onPersistProduct(updatedProduct, id);
      if (!result.success) {
        await appDialog.alert({ message: 'Failed to update status.', tone: 'danger' });
      }
    } catch (e: any) {
      await appDialog.alert({ message: 'Failed to update status: ' + e.message, tone: 'danger' });
    } finally {
      if (restore) {
        setRestoringProductId(null);
      } else {
        setIsDeleting(false);
      }
    }
  };

  const initiateDelete = (id: string, name: string) => {
    if (isReadOnly) return;
    const mode = activeProductSubTab === 'ARCHIVED' ? 'HARD_DELETE' : 'SOFT_ARCHIVE';
    setDeleteModal({
      isOpen: true,
      mode,
      id,
      name,
    });
  };

  const performDelete = async () => {
    if (!deleteModal.id || isReadOnly) return;

    setIsDeleting(true);
    try {
      if (deleteModal.mode === 'HARD_DELETE') {
        if (onDeleteProduct) await onDeleteProduct(deleteModal.id);
      } else {
        await handleArchiveProduct(deleteModal.id, false);
      }
      setDeleteModal({ isOpen: false, mode: 'SOFT_ARCHIVE', id: null, name: '' });
    } catch (e: any) {
      await appDialog.alert({ message: 'Action failed: ' + e.message, tone: 'danger' });
    } finally {
      setIsDeleting(false);
    }
  };

  // Recipe logic ...
  const closeRecipeModal = () => {
    setEditingRecipeSku(null);
    setLocalRecipe([]);
    setRecipeVariants([]);
    setSelectedBomVariantId(DEFAULT_BOM_VARIANT_ID);
  };

  const normalizeVariantDrafts = (variants: RecipeVariantDraft[]): RecipeVariantDraft[] => {
    const cleaned = variants
      .map((variant, idx) => ({
        bomVariantId: normalizeBomVariantId(variant.bomVariantId),
        bomVariantName:
          String(variant.bomVariantName || '').trim() ||
          (normalizeBomVariantId(variant.bomVariantId) === DEFAULT_BOM_VARIANT_ID
            ? DEFAULT_BOM_VARIANT_NAME
            : normalizeBomVariantId(variant.bomVariantId)),
        isDefaultVariant: Boolean(variant.isDefaultVariant),
        variantSortOrder: Number.isFinite(Number(variant.variantSortOrder))
          ? Number(variant.variantSortOrder)
          : idx + 1,
      }))
      .sort((a, b) => Number(a.variantSortOrder) - Number(b.variantSortOrder));

    if (cleaned.length === 0) {
      return [
        {
          bomVariantId: DEFAULT_BOM_VARIANT_ID,
          bomVariantName: DEFAULT_BOM_VARIANT_NAME,
          isDefaultVariant: true,
          variantSortOrder: 1,
        },
      ];
    }

    const defaultId =
      cleaned.find((v) => v.isDefaultVariant)?.bomVariantId || cleaned[0].bomVariantId;
    return cleaned.map((variant, idx) => ({
      ...variant,
      isDefaultVariant: variant.bomVariantId === defaultId,
      variantSortOrder: idx + 1,
    }));
  };

  const toLocalRecipeLine = (line: BOMItem): LocalRecipeLine => {
    const normalized = normalizeBomLine(line);
    const cleanId = String(normalized.component_id || '').trim();
    const cleanIdLower = cleanId.toLowerCase();
    let type = normalized.component_type;

    if (!type) {
      const comp = inventory.find(
        (i) => String(i.component_id).trim().toLowerCase() === cleanIdLower,
      );
      if (comp) {
        type = comp.type;
      } else {
        const prod = products.find((p) => String(p.sku_id).trim().toLowerCase() === cleanIdLower);
        if (prod) {
          const fmt = (prod.format || '').toLowerCase();
          if (fmt.includes('component a')) type = 'COMP_A_SKU' as any;
          else if (fmt.includes('blended')) type = 'BLENDED_SKU' as any;
          else type = 'COMP_A_SKU' as any;
        }
      }
    }

    return {
      ...normalized,
      localId: createLocalId(),
      component_id: cleanId,
      component_type: type,
      line_kind: normalizeLineKindForSectioning(normalized),
      qty_per_kg: normalized.qty_per_kg,
    };
  };

  const setVariantLinesForSku = (skuId: string, variantId: string, sourceBom: BOMItem[] = bom) => {
    const rows = getBomLinesForSkuVariant(sourceBom, skuId, variantId).map(toLocalRecipeLine);
    setLocalRecipe(rows);
  };

  const handleOpenRecipe = (sku_id: string) => {
    const variants = normalizeVariantDrafts(listBomVariantsForSku(bom, sku_id));
    const defaultVariantId =
      variants.find((v) => v.isDefaultVariant)?.bomVariantId || variants[0].bomVariantId;
    setEditingRecipeSku(sku_id);
    setRecipeVariants(variants);
    setSelectedBomVariantId(defaultVariantId);
    setVariantLinesForSku(sku_id, defaultVariantId);
  };

  const handleSwitchRecipeVariant = (variantId: string) => {
    if (!editingRecipeSku) return;
    setSelectedBomVariantId(variantId);
    setVariantLinesForSku(editingRecipeSku, variantId);
  };

  const buildUniqueVariantId = (seedName: string): string => {
    const existing = new Set(recipeVariants.map((v) => normalizeBomVariantId(v.bomVariantId)));
    const base = makeVariantIdFromName(seedName);
    if (!existing.has(base)) return base;
    let counter = 2;
    while (existing.has(`${base}-${counter}`)) counter++;
    return `${base}-${counter}`;
  };

  const handleCreateVariant = async () => {
    if (!editingRecipeSku || recipeMetadata.isReadOnly) return;
    const variantName = await appDialog.prompt({
      title: 'New BOM Variant',
      message: 'Name for new BOM variant:',
      defaultValue: '',
      inputLabel: 'Variant name',
      confirmLabel: 'Create',
      required: true,
    });
    if (!variantName) return;

    const newVariantId = buildUniqueVariantId(variantName);
    const defaultVariantId =
      recipeVariants.find((v) => v.isDefaultVariant)?.bomVariantId || DEFAULT_BOM_VARIANT_ID;
    const defaultPackaging = getBomLinesForSkuVariant(bom, editingRecipeSku, defaultVariantId)
      .map(normalizeBomLine)
      .filter((line) => !isFormulationLine(line))
      .map(
        (line) =>
          ({
            ...line,
            bomVariantId: newVariantId,
            bomVariantName: variantName,
            isDefaultVariant: false,
            localId: createLocalId(),
          }) as LocalRecipeLine,
      );

    const updatedVariants = normalizeVariantDrafts([
      ...recipeVariants,
      {
        bomVariantId: newVariantId,
        bomVariantName: variantName,
        isDefaultVariant: false,
        variantSortOrder: recipeVariants.length + 1,
      },
    ]);

    setRecipeVariants(updatedVariants);
    setSelectedBomVariantId(newVariantId);
    setLocalRecipe(defaultPackaging);
  };

  const handleDuplicateVariant = async () => {
    if (!editingRecipeSku || recipeMetadata.isReadOnly) return;
    const sourceVariant = recipeVariants.find((v) => v.bomVariantId === selectedBomVariantId);
    if (!sourceVariant) return;
    const variantName = await appDialog.prompt({
      title: 'Duplicate BOM Variant',
      message: 'Name for duplicated variant:',
      defaultValue: `${sourceVariant.bomVariantName} Copy`,
      inputLabel: 'Variant name',
      confirmLabel: 'Duplicate',
      required: true,
    });
    if (!variantName) return;

    const newVariantId = buildUniqueVariantId(variantName);
    const duplicated = localRecipe.map((line) => ({
      ...line,
      localId: createLocalId(),
      bomVariantId: newVariantId,
      bomVariantName: variantName,
      isDefaultVariant: false,
    }));

    const updatedVariants = normalizeVariantDrafts([
      ...recipeVariants,
      {
        bomVariantId: newVariantId,
        bomVariantName: variantName,
        isDefaultVariant: false,
        variantSortOrder: recipeVariants.length + 1,
      },
    ]);

    setRecipeVariants(updatedVariants);
    setSelectedBomVariantId(newVariantId);
    setLocalRecipe(duplicated);
  };

  const handleRenameVariant = async () => {
    if (recipeMetadata.isReadOnly) return;
    const active = recipeVariants.find((v) => v.bomVariantId === selectedBomVariantId);
    if (!active) return;
    const nextName = await appDialog.prompt({
      title: 'Rename BOM Variant',
      message: 'Rename BOM variant:',
      defaultValue: active.bomVariantName,
      inputLabel: 'Variant name',
      confirmLabel: 'Rename',
      required: true,
    });
    if (!nextName) return;
    const updatedVariants = normalizeVariantDrafts(
      recipeVariants.map((variant) =>
        variant.bomVariantId === selectedBomVariantId
          ? { ...variant, bomVariantName: nextName }
          : variant,
      ),
    );
    setRecipeVariants(updatedVariants);
    setLocalRecipe(localRecipe.map((line) => ({ ...line, bomVariantName: nextName })));
  };

  const handleSetDefaultVariant = () => {
    if (recipeMetadata.isReadOnly) return;
    const updatedVariants = normalizeVariantDrafts(
      recipeVariants.map((variant) => ({
        ...variant,
        isDefaultVariant: variant.bomVariantId === selectedBomVariantId,
      })),
    );
    setRecipeVariants(updatedVariants);
  };

  const handleDeleteVariant = async () => {
    if (!editingRecipeSku || recipeMetadata.isReadOnly) return;
    const activeVariant = recipeVariants.find((v) => v.bomVariantId === selectedBomVariantId);
    if (!activeVariant) return;
    const confirmed = await appDialog.confirm({
      title: 'Delete BOM Variant?',
      message: `Delete BOM variant "${activeVariant.bomVariantName}" and all its lines?`,
      tone: 'danger',
      confirmLabel: 'Delete Variant',
    });
    if (!confirmed) return;

    const remainingVariants = recipeVariants.filter((v) => v.bomVariantId !== selectedBomVariantId);
    const normalizedRemaining = normalizeVariantDrafts(remainingVariants);

    setIsSaving(true);
    try {
      await saveRecipeBatch(editingRecipeSku, [], currentUser, {
        bomVariantId: activeVariant.bomVariantId,
        bomVariantName: activeVariant.bomVariantName,
        isDefaultVariant: false,
        variantSortOrder: activeVariant.variantSortOrder,
        variantMeta: normalizedRemaining,
      });

      setBom((prev) => {
        const metaByVariant = new Map(
          normalizedRemaining.map((variant) => [variant.bomVariantId, variant]),
        );
        return prev
          .map(normalizeBomLine)
          .filter(
            (row) =>
              !(
                row.sku_id === editingRecipeSku &&
                normalizeBomVariantId(row.bomVariantId) === activeVariant.bomVariantId
              ),
          )
          .map((row) => {
            if (row.sku_id !== editingRecipeSku) return row;
            const meta = metaByVariant.get(normalizeBomVariantId(row.bomVariantId));
            if (!meta) return row;
            return normalizeBomLine({
              ...row,
              bomVariantId: meta.bomVariantId,
              bomVariantName: meta.bomVariantName,
              isDefaultVariant: meta.isDefaultVariant,
              variantSortOrder: meta.variantSortOrder,
            } as BOMItem);
          });
      });

      const nextVariantId =
        normalizedRemaining.find((v) => v.isDefaultVariant)?.bomVariantId ||
        normalizedRemaining[0]?.bomVariantId ||
        DEFAULT_BOM_VARIANT_ID;
      setRecipeVariants(normalizedRemaining);
      setSelectedBomVariantId(nextVariantId);
      setVariantLinesForSku(
        editingRecipeSku,
        nextVariantId,
        bom.filter(
          (line) =>
            !(
              line.sku_id === editingRecipeSku &&
              normalizeBomVariantId(line.bomVariantId) === activeVariant.bomVariantId
            ),
        ),
      );
    } catch (e: any) {
      await appDialog.alert({ message: e.message || 'Failed to delete variant.', tone: 'danger' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleAddRecipeLine = (section: 'FORMULATION' | 'PACKAGING') => {
    if (isReadOnly) return;
    setLocalRecipe([
      ...localRecipe,
      {
        localId: createLocalId(),
        component_id: '',
        qty_per_kg: 0,
        unit: section === 'FORMULATION' ? 'kg' : 'pcs',
        component_type: (section === 'FORMULATION'
          ? 'INGREDIENT'
          : 'PRIMARY_PACKAGING') as ComponentType,
        line_kind: section === 'FORMULATION' ? 'INGREDIENT' : 'PACKAGING',
      },
    ]);
  };

  const handleUpdateRecipeLine = (localId: string, field: string, val: any) => {
    if (isReadOnly) return;
    const updated = localRecipe.map((line) => {
      if (line.localId !== localId) return line;

      const newLine = { ...line, [field]: val };

      if (field === 'component_id') {
        const actualId = String(val).trim();
        const actualIdLower = actualId.toLowerCase();

        const comp = inventory.find(
          (i) => String(i.component_id).trim().toLowerCase() === actualIdLower,
        );
        const prod = products.find((p) => String(p.sku_id).trim().toLowerCase() === actualIdLower);

        if (comp) {
          newLine.unit = comp.default_unit;
          if (comp.type === 'INGREDIENT') {
            newLine.component_type = 'INGREDIENT';
            newLine.line_kind = 'INGREDIENT';
          } else {
            newLine.component_type = comp.type;
            newLine.line_kind = 'PACKAGING';
          }
        } else if (prod) {
          newLine.unit = 'kg';
          newLine.line_kind = 'INGREDIENT';
          const fmt = (prod.format || '').toLowerCase();
          if (fmt.includes('component a')) newLine.component_type = 'COMP_A_SKU' as any;
          else if (fmt.includes('blended')) newLine.component_type = 'BLENDED_SKU' as any;
          else newLine.component_type = 'OTHER_RAW_COMPONENT' as any;
        }
      }

      return newLine;
    });
    setLocalRecipe(updated);
  };

  const handleRemoveRecipeLine = (localId: string) => {
    if (isReadOnly) return;
    setLocalRecipe(localRecipe.filter((l) => l.localId !== localId));
  };

  const handleSaveRecipe = async () => {
    if (!editingRecipeSku || recipeMetadata.isReadOnly) return;

    const selectedVariant = recipeVariants.find((v) => v.bomVariantId === selectedBomVariantId);
    if (!selectedVariant) {
      await appDialog.alert({ message: 'Please select a BOM variant.', tone: 'warning' });
      return;
    }

    const invalid = localRecipe.some(
      (l) => !l.component_id || l.qty_per_kg === undefined || l.qty_per_kg === '',
    );
    if (invalid) {
      await appDialog.alert({
        message: 'Please ensure all lines have a component and valid quantity selected.',
        tone: 'warning',
      });
      return;
    }

    const payload = localRecipe.map((l) => ({
      sku_id: editingRecipeSku,
      bomVariantId: selectedVariant.bomVariantId,
      bomVariantName: selectedVariant.bomVariantName,
      isDefaultVariant: selectedVariant.isDefaultVariant,
      variantSortOrder: selectedVariant.variantSortOrder,
      component_id: String(l.component_id || '').trim(),
      component_type: l.component_type,
      line_kind: normalizeLineKindForSectioning(l as BOMItem),
      qty_per_kg: Number(l.qty_per_kg),
      unit: l.unit,
      notes: l.notes,
    }));

    const seen = new Set<string>();
    for (let i = 0; i < payload.length; i++) {
      const line = payload[i];
      const duplicateKey = `${String(line.component_id || '').toLowerCase()}::${line.line_kind}`;
      if (seen.has(duplicateKey)) {
        await appDialog.alert({
          message: `Duplicate component detected in the same section: ${line.component_id}`,
          tone: 'warning',
        });
        return;
      }
      seen.add(duplicateKey);
    }

    const formulationSum = payload
      .filter((line) => line.line_kind === 'INGREDIENT')
      .reduce((sum, line) => sum + Number(line.qty_per_kg || 0), 0);
    if (
      payload.some((line) => line.line_kind === 'INGREDIENT') &&
      Math.abs(formulationSum - 1) > FORMULATION_TOLERANCE
    ) {
      await appDialog.alert({
        message: `Formulation total must equal 1.0000 (current: ${formulationSum.toFixed(4)}).`,
        tone: 'warning',
      });
      return;
    }

    const normalizedVariants = normalizeVariantDrafts(recipeVariants);

    setIsSaving(true);
    try {
      const result = await saveRecipeBatch(editingRecipeSku, payload, currentUser, {
        bomVariantId: selectedVariant.bomVariantId,
        bomVariantName: selectedVariant.bomVariantName,
        isDefaultVariant: selectedVariant.isDefaultVariant,
        variantSortOrder: selectedVariant.variantSortOrder,
        variantMeta: normalizedVariants,
      });

      if (result.success) {
        const timestamp = new Date().toISOString();
        const metaByVariant = new Map(
          normalizedVariants.map((variant) => [variant.bomVariantId, variant]),
        );
        setBom((prev) => {
          const remaining = prev
            .map(normalizeBomLine)
            .filter(
              (row) =>
                !(
                  row.sku_id === editingRecipeSku &&
                  normalizeBomVariantId(row.bomVariantId) === selectedVariant.bomVariantId
                ),
            );

          const newLines = payload.map((line, idx) =>
            normalizeBomLine({
              ...line,
              line_order: idx + 1,
              updatedBy: currentUser,
              createdAt: timestamp,
              updatedAt: timestamp,
            } as BOMItem),
          );

          return [...remaining, ...newLines].map((row) => {
            if (row.sku_id !== editingRecipeSku) return row;
            const meta = metaByVariant.get(normalizeBomVariantId(row.bomVariantId));
            if (!meta) return row;
            return normalizeBomLine({
              ...row,
              bomVariantId: meta.bomVariantId,
              bomVariantName: meta.bomVariantName,
              isDefaultVariant: meta.isDefaultVariant,
              variantSortOrder: meta.variantSortOrder,
            } as BOMItem);
          });
        });
        closeRecipeModal();
      }
    } catch (e: any) {
      await appDialog.alert({ message: e.message || 'Failed to save recipe.', tone: 'danger' });
    } finally {
      setIsSaving(false);
    }
  };

  const formatComponentListLabel = (item: Component): string =>
    formatRawComponentListLabel(item, categories);

  const resolveReferenceName = (id: string, type: string) => {
    const cleanId = String(id).trim();
    if (!cleanId || cleanId === 'undefined') return 'No Component Selected';

    const cleanIdLower = cleanId.toLowerCase();

    // 1. Check Inventory (Ingredients/Consumables)
    const c = inventory.find(
      (comp) => String(comp.component_id).trim().toLowerCase() === cleanIdLower,
    );
    if (c) return formatComponentListLabel(c);

    // 2. Check Products (Intermediates)
    const p = products.find((prod) => String(prod.sku_id).trim().toLowerCase() === cleanIdLower);
    if (p) return formatFinishedProductInventoryLabel(p);

    return `Missing Item (ID: ${id})`;
  };

  const mainLayoutClass = isHandheldDevice
    ? 'grid grid-cols-1 gap-8 animate-in fade-in h-full min-h-0 items-stretch'
    : 'grid grid-cols-1 md:grid-cols-3 gap-8 animate-in fade-in h-full min-h-0 items-stretch';
  const quickActionGridClass = isHandheldDevice
    ? 'grid grid-cols-1 gap-4 items-end'
    : 'grid grid-cols-1 md:grid-cols-[1fr_auto] gap-4 items-end';
  const detailPanelClass = isHandheldDevice
    ? 'space-y-4 flex flex-col min-h-0'
    : 'md:col-span-2 space-y-4 flex flex-col min-h-0';

  return (
    <div className={mainLayoutClass}>
      {/* Delete / Archive Modal */}
      {deleteModal.isOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in">
          <div className="bg-white rounded-xl shadow-2xl max-md w-full p-8 border border-slate-200">
            <div
              className={`flex items-center mb-6 ${deleteModal.mode === 'SOFT_ARCHIVE' ? 'text-amber-600' : 'text-red-600'}`}
            >
              {deleteModal.mode === 'SOFT_ARCHIVE' ? (
                <Archive className="w-8 h-8 mr-3" />
              ) : (
                <AlertTriangle className="w-8 h-8 mr-3" />
              )}
              <h2 className="text-xl font-bold">
                {deleteModal.mode === 'SOFT_ARCHIVE' ? 'Archive Product?' : 'Delete Forever?'}
              </h2>
            </div>
            <p className="text-slate-600 mb-8 leading-relaxed">
              {deleteModal.mode === 'SOFT_ARCHIVE'
                ? `Move ${deleteModal.name} to the Archives? It will no longer appear in operational lists but data is preserved.`
                : `Permanently delete ${deleteModal.name}? This action is irreversible and will remove the record from this browser's demo data.`}
            </p>
            <div className="flex justify-end space-x-3 pt-4 border-t border-slate-100">
              <button
                onClick={() => setDeleteModal({ ...deleteModal, isOpen: false })}
                disabled={isDeleting}
                className="px-5 py-2.5 bg-slate-100 text-slate-600 rounded-md font-bold hover:bg-slate-200 transition disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={performDelete}
                disabled={isDeleting}
                className={`px-5 py-2.5 text-white rounded-md font-bold shadow-md transition disabled:opacity-50 flex items-center ${deleteModal.mode === 'SOFT_ARCHIVE' ? 'bg-amber-600 hover:bg-amber-700' : 'bg-red-600 hover:bg-red-700'}`}
              >
                {isDeleting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {deleteModal.mode === 'SOFT_ARCHIVE' ? 'Move to Archive' : 'Delete Forever'}
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
              <button onClick={() => setIsNamingRulesOpen(false)}>
                <X className="w-5 h-5 text-slate-400 hover:text-slate-600" />
              </button>
            </div>
            <div className="overflow-y-auto space-y-6 pr-2 scrollbar-thin scrollbar-thumb-slate-200">
              <div className="bg-amber-50 border border-amber-200 p-3 rounded-md text-xs text-amber-800 leading-relaxed">
                All finished-product SKUs follow a strict 5-segment pattern to keep family,
                category, format, and version traceable.
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-black text-indigo-600 uppercase tracking-widest bg-indigo-50 px-2 py-0.5 rounded">
                    SKU Structure
                  </span>
                  <span className="font-mono text-[9px] text-slate-400 uppercase">
                    Static Prefix: PRT
                  </span>
                </div>
                <div className="bg-slate-50 p-3 rounded border border-slate-100 font-mono text-[11px] text-slate-500 overflow-x-auto whitespace-nowrap">
                  {FINISHED_SKU_STRUCTURE}
                </div>
                <div className="grid grid-cols-2 gap-6">
                  <div className="space-y-1">
                    <div className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">
                      Segment Definitions
                    </div>
                    <div className="text-[10px] text-slate-500 border-l-2 border-slate-100 pl-2">
                      <span className="font-bold text-slate-700">FFFAAA</span>: family code + family
                      abbreviation
                    </div>
                    <div className="text-[10px] text-slate-500 border-l-2 border-slate-100 pl-2">
                      <span className="font-bold text-slate-700">CC</span>: category code
                    </div>
                    <div className="text-[10px] text-slate-500 border-l-2 border-slate-100 pl-2">
                      <span className="font-bold text-slate-700">FORMAT</span>: uppercase
                      alphanumeric format/variant
                    </div>
                    <div className="text-[10px] text-slate-500 border-l-2 border-slate-100 pl-2">
                      <span className="font-bold text-slate-700">VV</span>: 2-digit version
                    </div>
                  </div>
                  <div>
                    <div className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">
                      ID Sample
                    </div>
                    <div className="text-[11px] font-mono text-indigo-600 font-bold bg-indigo-50/30 p-2 rounded border border-indigo-100/50">
                      PRT-004COB-01-330ML-01
                    </div>
                    <p className="text-[9px] text-slate-400 mt-2 italic">
                      Example: Family 004COB, Category 01, Format 330ML, Version 01
                    </p>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-[10px] font-black text-indigo-600 uppercase tracking-widest bg-indigo-50 px-2 py-0.5 rounded inline-block">
                  Category Mappings
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {FinishedProductSkuCategoryOptions.map((opt) => (
                    <div
                      key={opt.code}
                      className="text-[10px] text-slate-500 border-l-2 border-slate-100 pl-2"
                    >
                      <span className="font-bold text-slate-700">{opt.code}</span>: {opt.label}
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-[10px] font-black text-indigo-600 uppercase tracking-widest bg-indigo-50 px-2 py-0.5 rounded inline-block">
                  Family Code Source
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {FAMILY_DEFINITIONS.slice(0, 8).map((f) => (
                    <div
                      key={`${f.code}-${f.abbr}`}
                      className="text-[10px] text-slate-500 border-l-2 border-slate-100 pl-2"
                    >
                      <span className="font-bold text-slate-700">
                        {f.code}
                        {f.abbr}
                      </span>
                      : {stripLeadingCode(f.name)}
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="mt-6 pt-4 border-t border-slate-100 flex justify-end">
              <button
                onClick={() => setIsNamingRulesOpen(false)}
                className="px-5 py-2 bg-slate-900 text-white rounded-md text-xs font-bold hover:bg-slate-800 transition"
              >
                Understood
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Recipe Modal */}
      {editingRecipeSku && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in">
          <div className="bg-white rounded-xl shadow-2xl max-w-6xl w-full p-10 border border-slate-200 max-h-[90vh] flex flex-col overflow-hidden text-base">
            <div className="flex justify-between items-center mb-8 border-b border-slate-100 pb-6 flex-shrink-0">
              <div className="flex items-center space-x-6">
                <div>
                  <h3 className="text-2xl font-black text-slate-800 flex items-center tracking-tight">
                    <ListTodo className="w-7 h-7 mr-3 text-indigo-600" /> Define Recipe (BOM)
                  </h3>
                  <p className="text-sm text-slate-400 font-mono mt-2 uppercase tracking-tight font-bold">
                    Product SKU ID:{' '}
                    <span className="text-slate-600 bg-slate-100 px-2 py-0.5 rounded">
                      {editingRecipeSku}
                    </span>
                  </p>
                </div>
                {recipeMetadata.segment && (
                  <div
                    className={`px-3 py-1.5 rounded-md text-[11px] font-black uppercase tracking-widest ${recipeMetadata.isReadOnly ? 'bg-amber-100 text-amber-700 border border-amber-200' : 'bg-indigo-50 text-indigo-700 border border-indigo-100'}`}
                  >
                    {recipeMetadata.segment.replace('_', ' ')}{' '}
                    {recipeMetadata.isReadOnly && '• LOCKED'}
                  </div>
                )}
              </div>
              <button
                onClick={closeRecipeModal}
                className="p-2.5 hover:bg-slate-50 rounded-full transition group"
              >
                <X className="w-8 h-8 text-slate-300 group-hover:text-slate-500" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto pr-4 space-y-12 scrollbar-thin scrollbar-thumb-slate-200">
              {recipeMetadata.isReadOnly && (
                <div className="p-5 bg-amber-50 border border-amber-200 rounded-xl flex items-center text-amber-800 text-sm font-bold shadow-sm">
                  <ShieldAlert className="w-5 h-5 mr-3 text-amber-600" /> This product is archived
                  or view-only. Recipe modification is locked.
                </div>
              )}

              <div className="p-4 border border-slate-200 rounded-xl bg-slate-50/60">
                <div className={quickActionGridClass}>
                  <div>
                    <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">
                      BOM Variant
                    </label>
                    <select
                      disabled={recipeMetadata.isReadOnly}
                      value={selectedBomVariantId}
                      onChange={(e) => handleSwitchRecipeVariant(e.target.value)}
                      className="w-full border-slate-300 rounded-lg text-sm shadow-sm bg-white py-2.5 focus:ring-2 focus:ring-indigo-500"
                    >
                      {recipeVariants.map((variant) => (
                        <option key={variant.bomVariantId} value={variant.bomVariantId}>
                          {variant.bomVariantName}
                          {variant.isDefaultVariant ? ' (Default)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      disabled={recipeMetadata.isReadOnly}
                      onClick={handleCreateVariant}
                      className="px-3 py-2 bg-white border border-slate-200 text-slate-700 rounded-lg text-xs font-black uppercase tracking-widest hover:bg-slate-100 disabled:opacity-50"
                    >
                      <Plus className="w-3.5 h-3.5 inline mr-1.5" /> New Variant
                    </button>
                    <button
                      disabled={recipeMetadata.isReadOnly}
                      onClick={handleDuplicateVariant}
                      className="px-3 py-2 bg-white border border-slate-200 text-slate-700 rounded-lg text-xs font-black uppercase tracking-widest hover:bg-slate-100 disabled:opacity-50"
                    >
                      <Copy className="w-3.5 h-3.5 inline mr-1.5" /> Duplicate
                    </button>
                    <button
                      disabled={recipeMetadata.isReadOnly || !activeRecipeVariant}
                      onClick={handleRenameVariant}
                      className="px-3 py-2 bg-white border border-slate-200 text-slate-700 rounded-lg text-xs font-black uppercase tracking-widest hover:bg-slate-100 disabled:opacity-50"
                    >
                      Rename
                    </button>
                    <button
                      disabled={recipeMetadata.isReadOnly || !activeRecipeVariant}
                      onClick={handleSetDefaultVariant}
                      className="px-3 py-2 bg-white border border-slate-200 text-slate-700 rounded-lg text-xs font-black uppercase tracking-widest hover:bg-slate-100 disabled:opacity-50"
                    >
                      Set Default
                    </button>
                    <button
                      disabled={recipeMetadata.isReadOnly || !activeRecipeVariant}
                      onClick={handleDeleteVariant}
                      className="px-3 py-2 bg-red-50 border border-red-200 text-red-700 rounded-lg text-xs font-black uppercase tracking-widest hover:bg-red-100 disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </div>
                </div>
                {activeRecipeVariant && (
                  <div className="mt-3 text-[11px] text-slate-500 font-semibold">
                    Active Variant ID:{' '}
                    <span className="font-mono text-slate-700">
                      {activeRecipeVariant.bomVariantId}
                    </span>
                  </div>
                )}
              </div>

              <div className="space-y-6">
                <div className="flex justify-between items-end border-b-2 border-indigo-100 pb-3">
                  <h4 className="text-base font-black text-indigo-700 uppercase tracking-widest flex items-center">
                    <Beaker className="w-5 h-5 mr-2" /> 1. Formulation Table (per kg)
                  </h4>
                  <div className="text-xs text-slate-400 font-bold uppercase tracking-wider">
                    Plan-ready Core Total:{' '}
                    <span className="text-indigo-600 font-mono text-sm bg-indigo-50 px-2 py-0.5 rounded ml-1">
                      {splitRecipe.coreIngredientTotal.toFixed(4)} kg
                    </span>
                  </div>
                </div>

                <div className="border border-slate-200 rounded-xl overflow-hidden shadow-md">
                  <table className="w-full text-left border-collapse">
                    <thead className="bg-slate-50 text-xs font-black text-slate-500 uppercase tracking-widest border-b border-slate-200">
                      <tr>
                        <th className="px-6 py-4 w-[38%]">Component Selection</th>
                        <th className="px-6 py-4 w-[16%] text-right">Dosage (Qty / kg)</th>
                        <th className="px-6 py-4 w-[10%] text-center">Unit</th>
                        <th className="px-6 py-4 w-[10%] text-right">
                          <Percent className="w-3.5 h-3.5 inline mr-1 opacity-60" /> %
                        </th>
                        <th className="px-6 py-4 w-[21%]">Process Notes</th>
                        <th className="px-6 py-4 w-[5%] text-right"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {splitRecipe.ingredients.map((line) => {
                        const cid = line.component_id || '';
                        const type = line.component_type || '';
                        const isCore = ['INGREDIENT', 'COMP_A_SKU', 'BLENDED_SKU'].includes(type);
                        const percentage =
                          isCore && splitRecipe.coreIngredientTotal > 0
                            ? (Number(line.qty_per_kg || 0) / splitRecipe.coreIngredientTotal) * 100
                            : 0;

                        return (
                          <tr
                            key={line.localId}
                            className={`hover:bg-slate-50/50 transition-colors ${recipeMetadata.isReadOnly ? 'opacity-75' : ''}`}
                          >
                            <td className="px-6 py-5">
                              <select
                                disabled={recipeMetadata.isReadOnly}
                                className="w-full border-slate-300 rounded-lg text-sm shadow-sm bg-white disabled:bg-slate-50 py-3 focus:ring-2 focus:ring-indigo-500 transition-all font-medium text-slate-700"
                                value={cid}
                                onChange={(e) =>
                                  handleUpdateRecipeLine(
                                    line.localId!,
                                    'component_id',
                                    e.target.value,
                                  )
                                }
                              >
                                <option value="">-- Choose Component --</option>
                                {recipeMetadata.ruleType !== 'COMP_A' && (
                                  <optgroup label="INTERMEDIATE PRODUCTS">
                                    {products
                                      .filter((p) => {
                                        const fmt = (p.format || '').toLowerCase();
                                        const isCompA = fmt.includes('component a');
                                        const isBlended = fmt.includes('blended');

                                        if (recipeMetadata.ruleType === 'BLENDED') return isCompA;
                                        if (recipeMetadata.ruleType === 'SAMPLE') return isBlended;
                                        if (recipeMetadata.ruleType === 'FINISHED')
                                          return isCompA || isBlended;
                                        return false;
                                      })
                                      .sort((a, b) =>
                                        (a.sku_name || '').localeCompare(b.sku_name || ''),
                                      )
                                        .map((p) => (
                                        <option key={p.sku_id} value={String(p.sku_id).trim()}>
                                          {formatFinishedProductInventoryLabel(p)}
                                        </option>
                                      ))}
                                  </optgroup>
                                )}
                                {recipeMetadata.ruleType !== 'SAMPLE' &&
                                  ITEM_TYPE_ORDER.filter((t) => t === 'INGREDIENT').map((type) => (
                                    <optgroup key={type} label={type.replace('_', ' ')}>
                                      {inventory
                                        .filter((i) => i.type === type)
                                        .sort((a, b) =>
                                          formatComponentListLabel(a).localeCompare(
                                            formatComponentListLabel(b),
                                          ),
                                        )
                                        .map((i) => (
                                          <option
                                            key={i.component_id}
                                            value={String(i.component_id).trim()}
                                          >
                                            {formatComponentListLabel(i)} — {i.component_id}
                                            {i.notes ? ` — ${i.notes}` : ''}
                                          </option>
                                        ))}
                                    </optgroup>
                                  ))}
                              </select>
                              {cid && (
                                <div className="mt-1.5 text-xs font-bold text-indigo-400 tracking-tight pl-1">
                                  Linked: {resolveReferenceName(cid, type)}
                                </div>
                              )}
                            </td>
                            <td className="px-6 py-5">
                              <input
                                disabled={recipeMetadata.isReadOnly}
                                type="number"
                                step="0.0001"
                                className="w-full border-slate-300 rounded-lg text-sm shadow-sm text-right font-mono py-3 focus:ring-2 focus:ring-indigo-500 transition-all font-bold text-slate-800"
                                value={line.qty_per_kg ?? ''}
                                onChange={(e) =>
                                  handleUpdateRecipeLine(
                                    line.localId!,
                                    'qty_per_kg',
                                    e.target.value,
                                  )
                                }
                              />
                            </td>
                            <td className="px-6 py-5 text-center text-xs font-black text-slate-500 bg-slate-50/50 uppercase tracking-tighter">
                              {line.unit || '—'}
                            </td>
                            <td
                              className={`px-6 py-5 text-right text-sm font-mono tracking-tighter ${isCore ? 'text-indigo-600 font-black' : 'text-slate-300 italic font-medium'}`}
                            >
                              {isCore ? `${percentage.toFixed(4)}%` : 'n/a'}
                            </td>
                            <td className="px-6 py-5">
                              <input
                                disabled={recipeMetadata.isReadOnly}
                                type="text"
                                className="w-full border-slate-300 rounded-lg text-xs shadow-sm py-3 placeholder:text-slate-300"
                                placeholder="Process notes..."
                                value={line.notes || ''}
                                onChange={(e) =>
                                  handleUpdateRecipeLine(line.localId!, 'notes', e.target.value)
                                }
                              />
                            </td>
                            <td className="px-6 py-5 text-right">
                              <button
                                disabled={recipeMetadata.isReadOnly}
                                onClick={() => handleRemoveRecipeLine(line.localId!)}
                                className="p-2 text-slate-300 hover:text-red-600 hover:bg-red-50 rounded-full transition-all disabled:opacity-0"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {!recipeMetadata.isReadOnly && (
                    <button
                      onClick={() => handleAddRecipeLine('FORMULATION')}
                      className="w-full py-5 bg-slate-50 text-xs font-black text-slate-400 uppercase tracking-widest hover:bg-indigo-50 hover:text-indigo-600 transition-all border-t border-slate-100 flex items-center justify-center group"
                    >
                      <Plus className="w-4 h-4 mr-2 group-hover:scale-110 transition-transform" />{' '}
                      Add Formulation Line
                    </button>
                  )}
                </div>
              </div>

              <div className="space-y-6">
                <div className="flex items-end border-b-2 border-amber-100 pb-3">
                  <h4 className="text-base font-black text-amber-700 uppercase tracking-widest flex items-center">
                    <Archive className="w-5 h-5 mr-2" /> 2. Packaging & Consumables (per kg/unit )
                  </h4>
                </div>

                <div className="border border-slate-200 rounded-xl overflow-hidden shadow-md">
                  <table className="w-full text-left border-collapse">
                    <thead className="bg-slate-50 text-xs font-black text-slate-500 uppercase tracking-widest border-b border-slate-200">
                      <tr>
                        <th className="px-6 py-4 w-[38%]">Selection</th>
                        <th className="px-6 py-4 w-[16%] text-right">Quantity</th>
                        <th className="px-6 py-4 w-[10%] text-center">Unit</th>
                        <th className="px-6 py-4 w-[31%]">Process Notes</th>
                        <th className="px-6 py-4 w-[5%] text-right"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {splitRecipe.consumables.map((line) => {
                        const cid = line.component_id || '';
                        const type = line.component_type || '';
                        return (
                          <tr
                            key={line.localId}
                            className={`hover:bg-slate-50/50 transition-colors ${recipeMetadata.isReadOnly ? 'opacity-75' : ''}`}
                          >
                            <td className="px-6 py-5">
                              <select
                                disabled={recipeMetadata.isReadOnly}
                                className="w-full border-slate-300 rounded-lg text-sm shadow-sm bg-white disabled:bg-slate-50 py-3 focus:ring-2 focus:ring-amber-500 transition-all font-medium text-slate-700"
                                value={cid}
                                onChange={(e) =>
                                  handleUpdateRecipeLine(
                                    line.localId!,
                                    'component_id',
                                    e.target.value,
                                  )
                                }
                              >
                                <option value="">-- Choose Consumable --</option>
                                {ITEM_TYPE_ORDER.map((type) => (
                                  <optgroup key={type} label={type.replace('_', ' ')}>
                                    {inventory
                                      .filter((i) => i.type === type)
                                      .sort((a, b) =>
                                        formatComponentListLabel(a).localeCompare(
                                          formatComponentListLabel(b),
                                        ),
                                      )
                                      .map((i) => (
                                        <option
                                          key={i.component_id}
                                          value={String(i.component_id).trim()}
                                        >
                                          {formatComponentListLabel(i)} — {i.component_id}
                                          {i.notes ? ` — ${i.notes}` : ''}
                                        </option>
                                      ))}
                                  </optgroup>
                                ))}
                              </select>
                              {cid && (
                                <div className="mt-1.5 text-xs font-bold text-amber-500 tracking-tight pl-1">
                                  Linked: {resolveReferenceName(cid, type)}
                                </div>
                              )}
                            </td>
                            <td className="px-6 py-5">
                              <input
                                disabled={recipeMetadata.isReadOnly}
                                type="number"
                                step="0.0001"
                                className="w-full border-slate-300 rounded-lg text-sm shadow-sm text-right font-mono py-3 focus:ring-2 focus:ring-amber-500 transition-all font-bold text-slate-800"
                                value={line.qty_per_kg ?? ''}
                                onChange={(e) =>
                                  handleUpdateRecipeLine(
                                    line.localId!,
                                    'qty_per_kg',
                                    e.target.value,
                                  )
                                }
                              />
                            </td>
                            <td className="px-6 py-5 text-center text-xs font-black text-slate-500 bg-slate-50/50 uppercase tracking-tighter">
                              {line.unit || '—'}
                            </td>
                            <td className="px-6 py-5">
                              <input
                                disabled={recipeMetadata.isReadOnly}
                                type="text"
                                className="w-full border-slate-300 rounded-lg text-xs shadow-sm py-3 placeholder:text-slate-300"
                                placeholder="Process notes..."
                                value={line.notes || ''}
                                onChange={(e) =>
                                  handleUpdateRecipeLine(line.localId!, 'notes', e.target.value)
                                }
                              />
                            </td>
                            <td className="px-6 py-5 text-right">
                              <button
                                disabled={recipeMetadata.isReadOnly}
                                onClick={() => handleRemoveRecipeLine(line.localId!)}
                                className="p-2 text-slate-300 hover:text-red-600 hover:bg-red-50 rounded-full transition-all disabled:opacity-0"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {!recipeMetadata.isReadOnly && (
                    <button
                      onClick={() => handleAddRecipeLine('PACKAGING')}
                      className="w-full py-5 bg-slate-50 text-xs font-black text-slate-400 uppercase tracking-widest hover:bg-amber-50 hover:text-amber-600 transition-all border-t border-slate-100 flex items-center justify-center group"
                    >
                      <Plus className="w-4 h-4 mr-2 group-hover:scale-110 transition-transform" />{' '}
                      Add Consumable Line
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="pt-8 border-t border-slate-100 flex justify-between items-center flex-shrink-0">
              <div className="text-xs text-slate-400 font-bold uppercase tracking-widest flex items-center bg-slate-50 px-4 py-2 rounded-lg">
                <ShieldAlert className="w-4 h-4 mr-2 text-amber-500" /> Reference-Only Integrity
                Enforced
              </div>
              <div className="flex space-x-4">
                <button
                  onClick={closeRecipeModal}
                  disabled={isSaving}
                  className="px-8 py-3 bg-white border border-slate-200 text-slate-600 rounded-xl font-black uppercase tracking-widest hover:bg-slate-50 transition-all shadow-sm disabled:opacity-50"
                >
                  {recipeMetadata.isReadOnly ? 'Close' : 'Cancel'}
                </button>
                {!recipeMetadata.isReadOnly && (
                  <button
                    onClick={handleSaveRecipe}
                    disabled={isSaving}
                    className="px-10 py-3 bg-indigo-600 text-white rounded-xl font-black uppercase tracking-widest shadow-xl hover:bg-indigo-700 transition-all transform hover:-translate-y-0.5 flex items-center disabled:opacity-70 disabled:cursor-not-allowed disabled:transform-none"
                  >
                    {isSaving ? (
                      <>
                        <Loader2 className="w-5 h-5 mr-2 animate-spin" /> Committing...
                      </>
                    ) : (
                      <>
                        <Save className="w-5 h-5 mr-2" /> Commit Recipe
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-6 flex flex-col">
        <div className="bg-slate-50 p-6 rounded-lg border border-slate-200 flex-1">
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-bold text-slate-800 flex items-center uppercase tracking-tighter">
              {editingProduct ? (
                <Edit3 className="w-4 h-4 mr-2 text-indigo-600" />
              ) : (
                <Plus className="w-4 h-4 mr-2 text-indigo-600" />
              )}
              {editingProduct
                ? duplicateSourceSkuId
                  ? 'Duplicate SKU'
                  : 'Edit SKU'
                : 'Register SKU'}
            </h3>
            {editingProduct && (
              <button
                onClick={cancelProductEdit}
                disabled={isSaving}
                className="text-[10px] font-black text-red-600 uppercase hover:underline disabled:opacity-50"
              >
                Cancel Edit
              </button>
            )}
          </div>
          <div className="space-y-4">
            {productActionError && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-md flex items-start text-xs text-red-700 animate-in slide-in-from-top-1">
                <ShieldAlert className="w-4 h-4 mr-2 flex-shrink-0" />
                <span>{productActionError}</span>
              </div>
            )}

            {editingProduct ? (
              <>
                <div>
                  <label className="block text-[10px] font-black text-slate-500 mb-1 uppercase tracking-widest">
                    SKU ID
                  </label>
                  <input
                    className={`w-full border rounded-md text-sm font-mono shadow-sm disabled:bg-slate-100 ${showEditIdConflict ? 'border-red-300 bg-red-50 text-red-900' : 'border-slate-300 bg-white'}`}
                    value={editingProduct.sku_id}
                    onChange={(e) =>
                      setEditingProduct({ ...editingProduct, sku_id: e.target.value })
                    }
                    disabled={isReadOnly}
                  />
                  {showEditIdConflict && (
                    <div className="text-[10px] text-red-600 font-bold mt-1 flex items-center">
                      <AlertTriangle className="w-3 h-3 mr-1" /> ID Conflict: This SKU already
                      exists.
                    </div>
                  )}
                  {skuRenamePending && !showEditIdConflict && (
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <div className="text-[10px] text-amber-700 font-bold flex items-center">
                        <AlertTriangle className="w-3 h-3 mr-1" /> Saving will rename this SKU
                        across linked records.
                      </div>
                      <button
                        type="button"
                        onClick={() => void handlePreviewRenameImpact()}
                        disabled={isPreviewingRename || isSaving}
                        className="text-[10px] font-bold text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
                      >
                        {isPreviewingRename ? 'Previewing...' : 'Preview Impact'}
                      </button>
                    </div>
                  )}
                </div>
                <div>
                  <label className="block text-[10px] font-black text-slate-500 mb-1 uppercase tracking-widest">
                    Display Name
                  </label>
                  <input
                    className="w-full border-slate-300 rounded-md text-sm shadow-sm disabled:bg-slate-100"
                    value={editingProduct.sku_name}
                    onChange={(e) =>
                      setEditingProduct({ ...editingProduct, sku_name: e.target.value })
                    }
                    disabled={isReadOnly}
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-black text-slate-500 mb-1 uppercase tracking-widest">
                    Category
                  </label>
                  <select
                    className="w-full border-slate-300 rounded-md text-sm shadow-sm disabled:bg-slate-100"
                    value={editingProduct.category}
                    onChange={(e) =>
                      setEditingProduct({ ...editingProduct, category: e.target.value })
                    }
                    disabled={isReadOnly}
                  >
                    {FinishedProductSkuCategoryOptions.map((c) => (
                      <option key={c.code} value={c.label}>
                        {c.label}
                      </option>
                    ))}
                    <option value="Archived Product">Archived Product</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-black text-slate-500 mb-1 uppercase tracking-widest">
                    Format / Variant
                  </label>
                  <input
                    className="w-full border-slate-300 rounded-md text-sm shadow-sm disabled:bg-slate-100"
                    value={editingProduct.format}
                    onChange={(e) =>
                      setEditingProduct({ ...editingProduct, format: e.target.value })
                    }
                    disabled={isReadOnly}
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-black text-slate-500 mb-1 uppercase tracking-widest">
                    Default Unit
                  </label>
                  <select
                    className="w-full border-slate-300 rounded-md text-sm shadow-sm font-bold text-indigo-600 disabled:bg-slate-100"
                    value={editingProduct.default_unit}
                    onChange={(e) =>
                      setEditingProduct({ ...editingProduct, default_unit: e.target.value })
                    }
                    disabled={isReadOnly}
                  >
                    {DEFAULT_UNIT_OPTIONS.map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-black text-slate-500 mb-1 uppercase tracking-widest">
                    Notes (Optional)
                  </label>
                  <textarea
                    className="w-full border-slate-300 rounded-md text-sm shadow-sm h-16 resize-none disabled:bg-slate-100"
                    placeholder="Special manufacturing notes..."
                    value={editingProduct.notes || ''}
                    onChange={(e) =>
                      setEditingProduct({ ...editingProduct, notes: e.target.value })
                    }
                    disabled={isReadOnly}
                  />
                </div>
                {!isReadOnly && (
                  <button
                    onClick={handleUpdateProduct}
                    disabled={isSaving || showEditIdConflict}
                    className="w-full py-3 bg-indigo-600 text-white rounded-md text-sm font-bold shadow-md hover:bg-indigo-700 transition disabled:opacity-50 flex items-center justify-center"
                  >
                    {isSaving ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <Save className="w-4 h-4 mr-2" />
                    )}
                    {duplicateSourceSkuId ? 'Create New Version' : 'Save Changes'}
                  </button>
                )}
              </>
            ) : (
              <>
                <div>
                  <label className="block text-[10px] font-black text-slate-500 mb-1 uppercase tracking-widest">
                    Product Family
                  </label>
                  <select
                    className="w-full border-slate-300 rounded-md text-sm shadow-sm disabled:bg-slate-100"
                    value={newProduct.family}
                    onChange={(e) => setNewProduct({ ...newProduct, family: e.target.value })}
                    disabled={isReadOnly}
                  >
                    {FAMILY_DEFINITIONS.map((f) => (
                      <option key={f.code} value={f.name}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-black text-slate-500 mb-1 uppercase tracking-widest">
                    Format / Variant
                  </label>
                  <input
                    className="w-full border-slate-300 rounded-md text-sm shadow-sm disabled:bg-slate-100"
                    placeholder="e.g. 1kg Refill Pouch"
                    value={newProduct.format}
                    onChange={(e) => setNewProduct({ ...newProduct, format: e.target.value })}
                    disabled={isReadOnly}
                  />
                </div>

                {duplicateProduct && !isSaving && (
                  <div className="mt-2 p-3 bg-amber-50 border border-amber-200 rounded-md flex items-start text-xs text-amber-800 animate-in slide-in-from-top-1">
                    <AlertTriangle className="w-4 h-4 mr-2 flex-shrink-0 mt-0.5" />
                    <div>
                      <div className="font-bold">Duplicate Name Detected</div>
                      <div className="mt-1">
                        "{duplicateProduct.sku_name}" already exists as{' '}
                        <span className="font-mono font-bold">{duplicateProduct.sku_id}</span>.
                      </div>
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-[10px] font-black text-slate-500 mb-1 uppercase tracking-widest">
                    SKU Category (ID Code)
                  </label>
                  <select
                    className="w-full border-slate-300 rounded-md text-sm shadow-sm disabled:bg-slate-100"
                    value={newProduct.categoryCode}
                    onChange={(e) => {
                      const cat = FinishedProductSkuCategoryOptions.find(
                        (c) => c.code === e.target.value,
                      );
                      setNewProduct({
                        ...newProduct,
                        categoryCode: e.target.value,
                        category: cat?.label || 'Commercial Product',
                      });
                    }}
                    disabled={isReadOnly}
                  >
                    {FinishedProductSkuCategoryOptions.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.label} ({c.code})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-black text-slate-500 mb-1 uppercase tracking-widest">
                    Default Unit
                  </label>
                  <select
                    className="w-full border-slate-300 rounded-md text-sm shadow-sm font-bold text-indigo-600 disabled:bg-slate-100"
                    value={newProduct.default_unit}
                    onChange={(e) => setNewProduct({ ...newProduct, default_unit: e.target.value })}
                    disabled={isReadOnly}
                  >
                    {DEFAULT_UNIT_OPTIONS.map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[10px] font-black text-slate-500 mb-1 uppercase tracking-widest">
                      Version
                    </label>
                    <input
                      className="w-full border-slate-300 rounded-md text-sm shadow-sm font-mono disabled:bg-slate-100"
                      placeholder="01"
                      value={newProduct.versionStr}
                      onChange={(e) =>
                        setNewProduct({
                          ...newProduct,
                          versionStr: e.target.value.replace(/[^0-9]/g, '').slice(0, 2),
                        })
                      }
                      disabled={isReadOnly}
                    />
                  </div>
                  <div className="flex items-end">
                    <button
                      onClick={handleSuggestSkuId}
                      disabled={isReadOnly}
                      className="w-full py-2 bg-indigo-100 text-indigo-600 rounded-md text-[10px] font-bold hover:bg-indigo-200 transition flex items-center justify-center uppercase disabled:opacity-50"
                    >
                      <Wand2 className="w-3 h-3 mr-1" /> Suggest ID
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] font-black text-slate-500 mb-1 uppercase tracking-widest">
                    Notes (Optional)
                  </label>
                  <textarea
                    className="w-full border-slate-300 rounded-md text-sm shadow-sm h-16 resize-none disabled:bg-slate-100"
                    placeholder="Special manufacturing notes..."
                    value={newProduct.notes}
                    onChange={(e) => setNewProduct({ ...newProduct, notes: e.target.value })}
                    disabled={isReadOnly}
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest">
                    Final SKU ID
                  </label>
                  <input
                    className={`w-full rounded-md text-sm shadow-sm font-mono ${newSkuIdConflict ? 'border-red-300 bg-red-50 text-red-900' : 'border-slate-300 bg-indigo-50/30 border-indigo-100'}`}
                    placeholder="PRT-..."
                    value={newProduct.sku_id}
                    onChange={(e) => setNewProduct({ ...newProduct, sku_id: e.target.value })}
                    disabled={isReadOnly}
                  />
                  {newSkuIdConflict && !isSaving && (
                    <div className="mt-1 flex items-center text-[10px] font-bold text-red-600">
                      <AlertTriangle className="w-3 h-3 mr-1" /> This SKU ID already exists.
                    </div>
                  )}
                </div>
                <button
                  onClick={handleAddProduct}
                  disabled={
                    isReadOnly ||
                    !newProduct.sku_id ||
                    !newProduct.format ||
                    isSaving ||
                    !!newSkuIdConflict
                  }
                  className="w-full py-3 bg-indigo-600 text-white rounded-md text-sm font-bold shadow-md hover:bg-indigo-700 transition disabled:opacity-50 flex items-center justify-center"
                >
                  {isSaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                  Register SKU
                </button>
              </>
            )}
          </div>
        </div>
      </div>
      <div className={detailPanelClass}>
        <div className="flex flex-col space-y-4 mb-2">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2 sm:gap-4">
              <h3 className="font-bold text-slate-800">Master SKU List</h3>
              <button
                onClick={() => setIsNamingRulesOpen(true)}
                className="flex items-center text-[10px] font-bold text-slate-400 hover:text-indigo-600 transition uppercase tracking-widest"
              >
                <Info className="w-3 h-3 mr-1" /> View Standards
              </button>
              <button
                onClick={() => {
                  if (filteredProducts.length === 0) {
                    void appDialog.alert({ message: 'No products to export.', tone: 'warning' });
                    return;
                  }

                  const headers = [
                    'Category',
                    'SKU ID',
                    'Product Name',
                    'BOM Variant ID',
                    'BOM Variant Name',
                    'Line Type',
                    'Component ID',
                    'Component Name',
                    'Qty (per Unit)',
                    'Unit',
                    'Percentage',
                  ];

                  const rows: (string | number)[][] = [];

                  filteredProducts.forEach((prod) => {
                    const prodBOM = bom.filter((b) => b.sku_id === prod.sku_id);

                    let coreTotal = 0;
                    const mappedLines = prodBOM.map((line) => {
                      let type = line.component_type;
                      const cleanId = String(line.component_id || '')
                        .trim()
                        .toLowerCase();

                      if (!type) {
                        const comp = inventory.find(
                          (i) => String(i.component_id).trim().toLowerCase() === cleanId,
                        );
                        if (comp) type = comp.type;
                        else {
                          const p = products.find(
                            (p) => String(p.sku_id).trim().toLowerCase() === cleanId,
                          );
                          if (p) {
                            const fmt = (p.format || '').toLowerCase();
                            if (fmt.includes('component a')) type = 'COMP_A_SKU' as any;
                            else if (fmt.includes('blended')) type = 'BLENDED_SKU' as any;
                            else type = 'COMP_A_SKU' as any;
                          }
                        }
                      }
                      return { ...line, resolvedType: type };
                    });

                    mappedLines.forEach((line) => {
                      const type = line.resolvedType || '';
                      const isCore = ['INGREDIENT', 'COMP_A_SKU', 'BLENDED_SKU'].includes(type);
                      if (isCore) coreTotal += Number(line.qty_per_kg || 0);
                    });

                    mappedLines.forEach((line) => {
                      const cleanId = String(line.component_id || '').trim();
                      let compName = 'Unknown';

                      const comp = inventory.find(
                        (i) =>
                          String(i.component_id).trim().toLowerCase() === cleanId.toLowerCase(),
                      );
                      if (comp) {
                        compName = formatComponentListLabel(comp);
                      } else {
                        const p = products.find(
                          (p) => String(p.sku_id).trim().toLowerCase() === cleanId.toLowerCase(),
                        );
                        if (p) compName = formatFinishedProductInventoryLabel(p);
                      }

                      const type = line.resolvedType || '';
                      const isCore = ['INGREDIENT', 'COMP_A_SKU', 'BLENDED_SKU'].includes(type);

                      let pct = '';
                      const qty = Number(line.qty_per_kg || 0);

                      if (isCore && coreTotal > 0) {
                        pct = ((qty / coreTotal) * 100).toFixed(4) + '%';
                      }

                      rows.push([
                        prod.category || '',
                        prod.sku_id,
                        prod.sku_name,
                        normalizeBomVariantId(line.bomVariantId),
                        line.bomVariantName ||
                          (normalizeBomVariantId(line.bomVariantId) === DEFAULT_BOM_VARIANT_ID
                            ? DEFAULT_BOM_VARIANT_NAME
                            : normalizeBomVariantId(line.bomVariantId)),
                        isCore ? 'Ingredient' : 'Packaging/Consumable',
                        cleanId,
                        compName,
                        qty,
                        line.unit || '',
                        pct,
                      ]);
                    });
                  });

                  const csvContent =
                    'data:text/csv;charset=utf-8,' +
                    [
                      headers.join(','),
                      ...rows.map((row) =>
                        row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','),
                      ),
                    ].join('\n');

                  const link = document.createElement('a');
                  link.setAttribute('href', encodeURI(csvContent));
                  link.setAttribute(
                    'download',
                    `weldon_bom_export_${new Date().toISOString().slice(0, 10)}.csv`,
                  );
                  document.body.appendChild(link);
                  link.click();
                  document.body.removeChild(link);
                }}
                className="text-xs flex items-center bg-white border border-slate-300 px-2 py-1 rounded hover:bg-slate-50 transition text-slate-600 font-bold"
                title="Download BOM CSV"
              >
                <Download className="w-3 h-3 mr-1" /> Export BOM
              </button>
            </div>
            <div className="relative w-full sm:w-auto">
              <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
              <input
                type="text"
                className="pl-9 pr-4 py-2 border-slate-200 rounded-full text-xs w-full sm:w-48 shadow-sm focus:border-indigo-500 outline-none"
                placeholder="Filter..."
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2 border-b border-slate-100 pb-4">
            {PRODUCT_SUB_TABS.map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveProductSubTab(tab)}
                className={`px-3 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all ${
                  activeProductSubTab === tab
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                }`}
              >
                {tab.replace('_', ' ')}
              </button>
            ))}
          </div>
        </div>
        <div className="border border-slate-200 rounded-lg shadow-sm min-h-[20rem] md:h-[560px] overflow-hidden">
          <div className="mobile-scroll-hint px-4 pt-3">
            Swipe sideways to see the full product table.
          </div>
          <div className="mobile-table-region h-full overflow-x-auto overflow-y-visible md:overflow-y-auto">
            <table className="w-full min-w-[820px] text-sm text-left">
              <thead className="sticky top-0 z-10 bg-slate-50 text-slate-500 font-bold uppercase text-[10px] tracking-widest border-b border-slate-200">
                <tr>
                  <th
                    className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors select-none"
                    onClick={() => toggleProductSort('name')}
                  >
                    <div className="flex items-center">
                      Product / Family
                      {productSortField === 'name' &&
                        (productSortDir === 'asc' ? (
                          <ChevronUp className="w-3 h-3 ml-1" />
                        ) : (
                          <ChevronDown className="w-3 h-3 ml-1" />
                        ))}
                    </div>
                  </th>
                  <th
                    className="px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors select-none"
                    onClick={() => toggleProductSort('id')}
                  >
                    <div className="flex items-center">
                      SKU ID
                      {productSortField === 'id' &&
                        (productSortDir === 'asc' ? (
                          <ChevronUp className="w-3 h-3 ml-1" />
                        ) : (
                          <ChevronDown className="w-3 h-3 ml-1" />
                        ))}
                    </div>
                  </th>
                  <th className="px-4 py-3">Default Unit</th>
                  <th className="px-4 py-3 text-right w-[160px]">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredProducts.map((p) => {
                  const skuRecipe = bom.filter((b) => b.sku_id === p.sku_id);
                  const isRestoringThisProduct = restoringProductId === p.sku_id;
                  return (
                    <React.Fragment key={p.sku_id}>
                      <tr
                        className={`transition-colors group ${isRestoringThisProduct ? 'bg-green-50/60 animate-pulse' : 'hover:bg-slate-50/50'}`}
                      >
                        <td className="px-4 py-3">
                          <div
                            onClick={() => {
                              if (!isRestoringThisProduct) handleOpenRecipe(p.sku_id);
                            }}
                            className={`font-semibold transition-colors ${isRestoringThisProduct ? 'text-green-700 cursor-wait' : 'text-slate-700 cursor-pointer hover:text-indigo-600'}`}
                          >
                            {stripLeadingCode(formatFinishedProductInventoryLabel(p))}
                          </div>
                          <div className="text-[10px] text-slate-400 uppercase tracking-widest font-bold flex items-center">
                            {stripLeadingCode(p.family)}
                            {isRestoringThisProduct && (
                              <span className="ml-2 px-1.5 py-0.5 bg-green-100 text-green-700 rounded flex items-center font-medium normal-case">
                                <Loader2 className="w-3 h-3 mr-1 animate-spin" /> Restoring
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-400">
                          {p.sku_id}
                          <div className="mt-1">
                            {skuRecipe.length > 0 ? (
                              <span className="text-[9px] font-black text-green-600 bg-green-50 px-1.5 py-0.5 rounded border border-green-100 uppercase tracking-widest">
                                Recipe Defined ({skuRecipe.length})
                              </span>
                            ) : (
                              <span className="text-[9px] font-black text-slate-300 border border-slate-100 px-1.5 py-0.5 rounded uppercase tracking-widest">
                                No Recipe
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-xs font-bold text-slate-600">
                          {p.default_unit}
                        </td>
                        <td className="px-4 py-3 text-right align-top">
                          <div className="flex justify-end items-start gap-1 whitespace-nowrap min-w-[140px]">
                            {activeProductSubTab === 'ARCHIVED' ? (
                              <>
                                {!isReadOnly && (
                                  <button
                                    onClick={() => handleArchiveProduct(p.sku_id, true)}
                                    title={
                                      isRestoringThisProduct
                                        ? 'Restoring Product...'
                                        : 'Restore Product'
                                    }
                                    disabled={isRestoringThisProduct}
                                    className="p-2 text-slate-300 hover:text-green-600 hover:bg-green-50 rounded-full transition disabled:opacity-60 disabled:cursor-not-allowed"
                                  >
                                    {isRestoringThisProduct ? (
                                      <Loader2 className="w-4 h-4 animate-spin text-green-600" />
                                    ) : (
                                      <RotateCcw className="w-4 h-4" />
                                    )}
                                  </button>
                                )}
                                <button
                                  onClick={() => handleOpenRecipe(p.sku_id)}
                                  disabled={isRestoringThisProduct}
                                  title="View Archived Recipe"
                                  className="p-2 text-slate-300 hover:text-indigo-600 hover:bg-indigo-50 rounded-full transition disabled:opacity-60 disabled:cursor-not-allowed"
                                >
                                  <ListTodo className="w-4 h-4" />
                                </button>
                                {!isReadOnly && (
                                  <button
                                    onClick={() => handleDuplicateProductInit(p)}
                                    disabled={isRestoringThisProduct}
                                    title="Duplicate as New Version"
                                    className="p-2 text-slate-300 hover:text-indigo-600 hover:bg-indigo-50 rounded-full transition disabled:opacity-60 disabled:cursor-not-allowed"
                                  >
                                    <Copy className="w-4 h-4" />
                                  </button>
                                )}
                                {!isReadOnly && (
                                  <button
                                    onClick={() => initiateDelete(p.sku_id, p.sku_name)}
                                    disabled={isRestoringThisProduct}
                                    title="Permanently Delete"
                                    className="p-2 text-slate-300 hover:text-red-600 hover:bg-red-50 rounded-full transition disabled:opacity-60 disabled:cursor-not-allowed"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                )}
                              </>
                            ) : (
                              <>
                                <button
                                  onClick={() => handleOpenRecipe(p.sku_id)}
                                  title="Define Recipe"
                                  className="p-2 text-slate-300 hover:text-indigo-600 hover:bg-indigo-50 rounded-full transition"
                                >
                                  <ListTodo className="w-4 h-4" />
                                </button>
                                {!isReadOnly && (
                                  <>
                                    <button
                                      onClick={() => handleEditProductInit(p)}
                                      title="Edit Product"
                                      className="p-2 text-slate-300 hover:text-indigo-600 hover:bg-indigo-50 rounded-full transition"
                                    >
                                      <Edit3 className="w-4 h-4" />
                                    </button>
                                    <button
                                      onClick={() => handleDuplicateProductInit(p)}
                                      title="Duplicate as New Version"
                                      className="p-2 text-slate-300 hover:text-indigo-600 hover:bg-indigo-50 rounded-full transition"
                                    >
                                      <Copy className="w-4 h-4" />
                                    </button>
                                    <button
                                      onClick={() => initiateDelete(p.sku_id, p.sku_name)}
                                      title="Archive Product"
                                      className="p-2 text-slate-300 hover:text-amber-600 hover:bg-amber-50 rounded-full transition"
                                    >
                                      <Archive className="w-4 h-4" />
                                    </button>
                                  </>
                                )}
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    </React.Fragment>
                  );
                })}
                {filteredProducts.length === 0 && (
                  <tr>
                    <td colSpan={3} className="py-20 text-center text-slate-400 italic">
                      No products found for this selection.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};
