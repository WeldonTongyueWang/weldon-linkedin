
/**
 * PROTECTED MASTER DATA BOUNDARY - FINISHED PRODUCT SKU RULES
 * 
 * Hard Rules:
 * 1) This file is READ-ONLY for all operational modules.
 * 2) Changes require a "MASTERDATA CHANGE REQUEST" protocol.
 */

import { FAMILY_DEFINITIONS, SKU_PREFIX } from './rawComponentRegistry';

/**
 * Valid Category Codes for Finished Products
 */
export const FinishedProductSkuCategoryOptions = [
  { code: '01', label: 'Commercial Product' },
  { code: '02', label: 'Sample Product' },
  { code: '03', label: 'Commercial Dispensing' },
  { code: '04', label: 'Sample Dispensing' },
  { code: '05', label: 'Intermediate' },
  { code: '06', label: 'Blended' }
];

/**
 * Enforces a 2-digit numeric version string (e.g., "01").
 */
export const normalizeVersion = (version: string | undefined): string => {
  if (!version) return "01";
  const v = version.replace(/[^0-9]/g, '');
  return v.padStart(2, '0');
};

/**
 * Normalizes format/variant strings for URL-safe and ID-safe usage.
 * Removes spaces and special characters.
 */
export const normalizeFormatVariant = (formatVariant: string | undefined): string => {
  if (!formatVariant || formatVariant.trim() === "") return "STD";
  return formatVariant.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
};

export interface FinishedProductSkuInput {
  familyCode: string;
  familyAbbr: string;
  categoryCode: string;
  formatVariant: string;
  version?: string;
}

/**
 * Assembles a Finished Product SKU ID following the canonical pattern.
 */
export const buildFinishedProductSkuId = (input: FinishedProductSkuInput): string => {
  const fam = `${input.familyCode.padStart(3, '0')}${input.familyAbbr.toUpperCase()}`;
  const cat = input.categoryCode.padStart(2, '0');
  const variant = normalizeFormatVariant(input.formatVariant);
  const ver = normalizeVersion(input.version);
  
  return `${SKU_PREFIX}-${fam}-${cat}-${variant}-${ver}`;
};

/**
 * Suggests a new unique SKU ID by checking existing IDs and incrementing versions if needed.
 * Updated to be case-insensitive to prevent duplicate IDs like "...-01" vs "...-01 ".
 */
export const suggestFinishedProductSkuId = (
  input: Omit<FinishedProductSkuInput, 'version'>, 
  existingIds: string[]
): string => {
  let verNum = 1;
  
  // Create a normalized set of existing IDs for fast, case-insensitive lookup
  const normalizedExisting = new Set(existingIds.map(id => id.trim().toUpperCase()));

  while (true) {
    const candidateVer = verNum.toString().padStart(2, '0');
    const candidateId = buildFinishedProductSkuId({ ...input, version: candidateVer });
    
    if (!normalizedExisting.has(candidateId.toUpperCase())) {
      return candidateId;
    }
    verNum++;
  }
};
