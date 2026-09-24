
/**
 * PROTECTED MASTER DATA BOUNDARY - RAW COMPONENT REGISTRY
 * 
 * Hard Rules:
 * 1) This file is READ-ONLY for all operational modules.
 * 2) Changes require a "MASTERDATA CHANGE REQUEST" protocol.
 * 3) This registry is the single source of truth for component naming and classification.
 */

import { ComponentType } from '../types';

export interface CategoryOption {
  code: string;
  label: string;
}

export interface RawTypeConfig {
  prefix: string;
  categoryOptions: CategoryOption[];
  subcategoryLabel: string;
  subcategoryOptions: string[];
  defaultUnitOptions: string[];
}

export interface NamingRule {
  prefix: string;
  structure: string;
  sequenceScope: 'PER_PREFIX' | 'GLOBAL' | 'FROM_FAMILY_DEFINITIONS' | 'FROM_CONSUMABLE_DEFINITIONS' | 'FIXED';
  abbrStrategy: 'FROM_NAME_3LETTER' | 'FROM_CODELIST' | 'FROM_FAMILY_DEFINITIONS' | 'FROM_KEYWORD_MAP' | 'FROM_CONSUMABLE_DEFINITIONS' | 'MAPPED';
  slugify: {
    uppercase: boolean;
    stripNonAlphanumeric: boolean;
  };
}

// Global SKU Prefix
export const SKU_PREFIX = 'PRT';

export const FAMILY_DEFINITIONS = [
  { code: '000', abbr: 'PLN', name: '00 Plain' },
  { code: '001', abbr: 'AUC', name: '01 AURORA COLA' },
  { code: '002', abbr: 'NEL', name: '02 NEON LIME' },
  { code: '003', abbr: 'ORO', name: '03 ORBIT ORANGE' },
  { code: '004', abbr: 'COB', name: '04 COMET BERRY' },
  { code: '005', abbr: 'LUL', name: '05 LUNAR LEMON' },
  { code: '006', abbr: 'POT', name: '06 POLAR TONIC' },
  { code: '007', abbr: 'SOC', name: '07 SOLAR CHERRY' },
  { code: '008', abbr: 'NOV', name: '08 NOVA VANILLA' },
];

export const CONSUMABLE_DEFINITIONS = [
  { code: '001', abbr: 'BAG', name: 'Storage Bag' },
  { code: '002', abbr: 'TAP', name: 'Paper Tape' },
  { code: '003', abbr: 'FLM', name: 'Clear Wrapping Film' },
  { code: '004', abbr: 'FOB', name: 'Barrier Foil' },
];

export const DISPENSING_CORE_MAP: Record<string, string> = {
  'Bottle': '001BOT',
  'Bottle Cap': '002BTH',
  'Measuring Scoop': '003SCP',
  'Funnel': '004FNL'
};

export const SECONDARY_PACKAGING_DISPLAY_NAMES = [
  'Shipping Carton',
  'Paper Mailer',
  'Reusable Crate',
  'Fibre Drum'
];

export const PALLET_LOGISTICS_CORE_MAP: Record<string, string> = {
  'Standard Pallet': '001PAL',
  'Pallet Pad': '002PDD'
};

export const NAMING_RULES: Record<ComponentType, NamingRule> = {
  'INGREDIENT': {
    prefix: 'IGD',
    structure: '<Prefix>-<Sequence><Abbr/Code>-<Category>-<Subcategory>-<Version>',
    sequenceScope: 'PER_PREFIX',
    abbrStrategy: 'FROM_NAME_3LETTER',
    slugify: { uppercase: true, stripNonAlphanumeric: true }
  },
  'PRIMARY_PACKAGING': {
    prefix: 'PRM',
    structure: '<Prefix>-<Sequence><Abbr/Code>-<Category>-<Subcategory>-<Version>',
    sequenceScope: 'FROM_FAMILY_DEFINITIONS',
    abbrStrategy: 'FROM_FAMILY_DEFINITIONS',
    slugify: { uppercase: true, stripNonAlphanumeric: true }
  },
  'SECONDARY_PACKAGING': {
    prefix: 'SEC',
    structure: '<Prefix>-<Sequence><Abbr/Code>-<Category>-<Subcategory>-<Version>',
    sequenceScope: 'PER_PREFIX',
    abbrStrategy: 'FROM_KEYWORD_MAP',
    slugify: { uppercase: true, stripNonAlphanumeric: true }
  },
  'CONSUMABLE': {
    prefix: 'CSB',
    structure: '<Prefix>-<Sequence><Abbr/Code>-<Category>-<Subcategory>-<Version>',
    sequenceScope: 'FROM_CONSUMABLE_DEFINITIONS',
    abbrStrategy: 'FROM_CONSUMABLE_DEFINITIONS',
    slugify: { uppercase: true, stripNonAlphanumeric: true }
  },
  'LABEL': {
    prefix: 'LBL',
    structure: '<Prefix>-<Sequence><Abbr/Code>-<Category>-<Subcategory>-<Version>',
    sequenceScope: 'FROM_FAMILY_DEFINITIONS',
    abbrStrategy: 'FROM_FAMILY_DEFINITIONS',
    slugify: { uppercase: true, stripNonAlphanumeric: true }
  },
  'DISPENSING': {
    prefix: 'DPS',
    structure: '<Prefix>-<Sequence><Abbr/Code>-<Category>-<Subcategory>-<Version>',
    sequenceScope: 'FIXED',
    abbrStrategy: 'MAPPED',
    slugify: { uppercase: true, stripNonAlphanumeric: true }
  },
  'PALLET_LOGISTICS': {
    prefix: 'PAL',
    structure: '<Prefix>-<Sequence><Abbr/Code>-<Category>-<Subcategory>-<Version>',
    sequenceScope: 'FIXED',
    abbrStrategy: 'MAPPED',
    slugify: { uppercase: true, stripNonAlphanumeric: true }
  },
  'PALLET': {
    prefix: 'PAL',
    structure: '<Prefix>-<Sequence><Abbr/Code>-<Category>-<Subcategory>-<Version>',
    sequenceScope: 'PER_PREFIX',
    abbrStrategy: 'FROM_KEYWORD_MAP',
    slugify: { uppercase: true, stripNonAlphanumeric: true }
  }
};

export const RAW_COMPONENT_REGISTRY: Record<ComponentType, RawTypeConfig> = {
  'INGREDIENT': {
    prefix: 'IGD',
    categoryOptions: [
      { code: '01', label: 'Ambient storage' },
      { code: '02', label: 'Process laboratory' },
      { code: '03', label: 'Temperature controlled' }
    ],
    subcategoryLabel: 'subcategory',
    subcategoryOptions: ['kg', 'L', 'g', 'ml'],
    defaultUnitOptions: ['kg', 'g', 'L', 'ml']
  },
  'PRIMARY_PACKAGING': {
    prefix: 'PRM',
    categoryOptions: [
      { code: '01', label: 'Aluminium can' },
      { code: '02', label: 'Glass bottle' },
      { code: '03', label: 'Recycled PET bottle' },
      { code: '04', label: 'Paper sachet' },
      { code: '05', label: 'Standard Film Roll' },
      { code: '06', label: 'Paper Bag' }
    ],
    subcategoryLabel: 'subcategory',
    subcategoryOptions: ['5g', '25g', '100g', '250g', '500g', '1kg', '25kg', '3L', '20L', '30L', '200L', '70 x 180mm', '120 x 180mm'],
    defaultUnitOptions: ['pcs', 'roll', 'box']
  },
  'SECONDARY_PACKAGING': {
    prefix: 'SEC',
    categoryOptions: [
      { code: '01', label: 'Shipping carton' },
      { code: '02', label: 'Paper mailer' },
      { code: '03', label: 'Reusable crate' },
      { code: '04', label: 'Recycled plastic tote' },
      { code: '05', label: 'Fibre drum' }
    ],
    subcategoryLabel: 'subcategory',
    subcategoryOptions: ['pcs', 'unit'],
    defaultUnitOptions: ['pcs']
  },
  'CONSUMABLE': {
    prefix: 'CSB',
    categoryOptions: [
      { code: '01', label: 'Heavy-duty storage bag' },
      { code: '02', label: 'Standard storage bag' },
      { code: '03', label: 'Reinforced paper tape' },
      { code: '04', label: 'Plain paper tape' },
      { code: '05', label: 'Clear packing tape' },
      { code: '06', label: 'Recycled film' },
      { code: '07', label: 'Lightweight paper' },
      { code: '08', label: 'Heavyweight paper' },
      { code: '09', label: 'Barrier foil' }
    ],
    subcategoryLabel: 'subcategory',
    subcategoryOptions: ['pcs', 'm', 'roll'],
    defaultUnitOptions: ['pcs', 'm', 'roll']
  },
  'DISPENSING': {
    prefix: 'DPS',
    categoryOptions: [
      { code: '01', label: 'Clear bottle' },
      { code: '02', label: 'Recycled clear bottle' },
      { code: '03', label: 'Opaque bottle' },
      { code: '04', label: 'Recycled opaque bottle' },
      { code: '05', label: 'Foaming Trigger' },
      { code: '06', label: 'Standard Trigger' },
      { code: '07', label: 'Flip cap' },
      { code: '08', label: 'Fibre insert' },
      { code: '09', label: 'Recycled scoop' },
      { code: '10', label: 'Standard scoop' },
      { code: '11', label: 'Cardboard Funnel' }
    ],
    subcategoryLabel: 'subcategory',
    subcategoryOptions: ['pcs', 'unit'],
    defaultUnitOptions: ['pcs', 'unit']
  },
  'LABEL': {
    prefix: 'LBL',
    categoryOptions: [
      { code: '01', label: 'Product label' },
      { code: '02', label: 'Bottle label' },
      { code: '03', label: 'Sample label' },
      { code: '04', label: 'Tub label' }
    ],
    subcategoryLabel: 'subcategory',
    subcategoryOptions: ['pcs', 'roll'],
    defaultUnitOptions: ['pcs', 'roll']
  },
  'PALLET_LOGISTICS': {
    prefix: 'PAL',
    categoryOptions: [
      { code: '01', label: 'Timber pallet' },
      { code: '02', label: 'Cardboard pallet' },
      { code: '03', label: 'Recycled plastic pallet' },
      { code: '04', label: 'Standard plastic pallet' }
    ],
    subcategoryLabel: 'subcategory',
    subcategoryOptions: ['pcs', 'unit'],
    defaultUnitOptions: ['pcs', 'unit']
  },
  // Mapping existing PALLET type if encountered
  'PALLET': {
    prefix: 'PAL',
    categoryOptions: [
      { code: '01', label: 'Timber pallet' },
      { code: '02', label: 'Cardboard pallet' },
      { code: '03', label: 'Recycled plastic pallet' },
      { code: '04', label: 'Standard plastic pallet' }
    ],
    subcategoryLabel: 'subcategory',
    subcategoryOptions: ['pcs', 'unit'],
    defaultUnitOptions: ['pcs', 'unit']
  }
};

/**
 * Retrieves the configuration for a specific component type.
 */
export const getTypeConfig = (type: ComponentType): RawTypeConfig | undefined => {
  return RAW_COMPONENT_REGISTRY[type];
};

/**
 * Formats a category option for display (e.g., "01 - storage room").
 */
export const formatCategoryDisplay = (option: CategoryOption): string => {
  return `${option.code} - ${option.label}`;
};
