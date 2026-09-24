
/**
 * PROTECTED MASTER DATA BOUNDARY - COMPONENT ID LOGIC
 * 
 * Hard Rules:
 * 1) This file is READ-ONLY for all operational modules.
 * 2) Changes require a "MASTERDATA CHANGE REQUEST" protocol.
 * 3) Implements the authoritative segment logic for Raw Component IDs.
 */

import { ComponentType, Component } from '../types';
import { NAMING_RULES, FAMILY_DEFINITIONS, CONSUMABLE_DEFINITIONS, DISPENSING_CORE_MAP, PALLET_LOGISTICS_CORE_MAP } from '../masterdata/rawComponentRegistry';

export interface ComponentIdInput {
  type: ComponentType;
  name: string;
  categoryCode: string; // e.g. "01"
  subcategory: string;   // e.g. "kg" or "250g" (formerly unitOrSize)
  version: string;      // e.g. "1.0" or "01"
  id_core?: string;     // Optional override: <Sequence><Abbr/Code> e.g. "001BCT"
}

/**
 * Normalizes component name for matching/lookup.
 * Strips leading numbers (e.g., "32 "), trims, and collapses whitespace.
 */
export function normalizeComponentName(name: string | number | undefined | null): string {
  if (!name) return "";
  const str = String(name);
  // Strip leading numbers followed by optional space
  let clean = str.replace(/^\d+\s*/, '');
  // Collapse whitespace and trim
  clean = clean.replace(/\s+/g, ' ').trim();
  return clean.toLowerCase();
}

/**
 * Validates a core segment.
 * Rules: uppercase A–Z0–9 only; length between 4 and 12; must start with 3 digits (sequence)
 */
export function validateCore(core: string | number | undefined | null): { ok: boolean; reason?: string } {
  if (core === undefined || core === null || core === "") return { ok: false, reason: "Core is required." };
  const clean = String(core).trim().toUpperCase();
  if (clean.length < 4 || clean.length > 12) {
    return { ok: false, reason: "Core length must be between 4 and 12 characters." };
  }
  if (!/^\d{3}/.test(clean)) {
    return { ok: false, reason: "Core must start with a 3-digit sequence (e.g., 001)." };
  }
  if (!/^[A-Z0-9]+$/.test(clean)) {
    return { ok: false, reason: "Core must contain only alphanumeric characters (A-Z, 0-9)." };
  }
  return { ok: true };
}

/**
 * Strategy: FROM_NAME_3LETTER
 * Extracts abbreviation from name (first 3 letters)
 */
const getName3LetterAbbr = (name: string): string => {
  const str = String(name);
  const clean = str.replace(/[^a-zA-Z]/g, '').toUpperCase();
  if (clean.length < 3) return clean.padEnd(3, 'X');
  return clean.substring(0, 3);
};

/**
 * Strategy: FROM_FAMILY_DEFINITIONS
 * Matches name against product family definitions. 
 * Supports partial matching to account for stripped numeric prefixes.
 */
const getFamilyAbbr = (name: string): string | null => {
  const cleanInput = String(name).toUpperCase();
  const match = FAMILY_DEFINITIONS.find(f => {
    const cleanFamName = f.name.replace(/^\d+\s*/, '').toUpperCase();
    return cleanInput.includes(cleanFamName) || cleanFamName.includes(cleanInput) || cleanInput === f.abbr.toUpperCase();
  });
  return match ? match.abbr : null;
};

/**
 * Strategy: FROM_FAMILY_DEFINITIONS
 * Matches name against product family definitions to get the code
 */
const getFamilyCode = (name: string): string | null => {
  const cleanInput = String(name).toUpperCase();
  const match = FAMILY_DEFINITIONS.find(f => {
    const cleanFamName = f.name.replace(/^\d+\s*/, '').toUpperCase();
    return cleanInput.includes(cleanFamName) || cleanFamName.includes(cleanInput);
  });
  return match ? match.code : null;
};

/**
 * Strategy: FROM_CONSUMABLE_DEFINITIONS
 */
const getConsumableAbbr = (name: string): string | null => {
  const str = String(name).toUpperCase();
  const match = CONSUMABLE_DEFINITIONS.find(c => 
    str.includes(c.name.toUpperCase()) || 
    str.includes(c.abbr.toUpperCase())
  );
  return match ? match.abbr : null;
};

/**
 * Strategy: FROM_CONSUMABLE_DEFINITIONS
 */
const getConsumableCode = (name: string): string | null => {
  const str = String(name).toUpperCase();
  const match = CONSUMABLE_DEFINITIONS.find(c => 
    str.includes(c.name.toUpperCase()) || 
    str.includes(c.abbr.toUpperCase())
  );
  return match ? match.code : null;
};

/**
 * Strategy: FROM_KEYWORD_MAP
 * Maps specific keywords to fixed codes
 */
const getKeywordCode = (name: string): string => {
  const n = String(name).toUpperCase();
  if (n.includes('PAPER MAILER')) return 'AIR';
  if (n.includes('DRUM') || n.includes('BARREL')) return 'DRB';
  if (n.includes('BUCKET')) return 'BKT';
  if (n.includes('ENVELOPE') || n.includes('EVP')) return 'EVP';
  if (n.includes('BOX')) return 'BOX';
  if (n.includes('BOTTLE')) return 'BOT';
  if (n.includes('SCOOP')) return 'SCP';
  if (n.includes('FUNNEL')) return 'FNL';
  if (n.includes('PLASTIC') || n.includes('PP')) return 'PPD';
  if (n.includes('PALLET') || n.includes('PAL')) return 'PAL';
  return 'GEN';
};

/**
 * Standard slugification helper respecting rule configuration
 */
const applySlugify = (str: string, config: { uppercase: boolean, stripNonAlphanumeric: boolean }) => {
  let result = String(str);
  if (config.stripNonAlphanumeric) {
    result = result.replace(/[^a-zA-Z0-9]/g, '');
  }
  if (config.uppercase) {
    result = result.toUpperCase();
  }
  return result;
};

/**
 * Extracts core from a formatted component_id.
 * Backward-compatible with legacy consumable IDs where category digits were appended to the core segment.
 */
export function extractCoreFromComponentId(id: string, type: ComponentType): string | null {
  if (!id) return null;
  const segments = String(id).split('-');
  if (segments.length < 2) return null;
  const core = segments[1];
  
  // Legacy consumable format: CSB-001BAG01-S210X310MM-01 -> stored core segment is 001BAG01. Pure core is 001BAG.
  if (type === 'CONSUMABLE' && core.length >= 8 && /\d{2}$/.test(core)) {
      return core.substring(0, core.length - 2);
  }
  
  return core;
}

/**
 * Builds a Component ID using a provided core while preserving the standard
 * segment structure: <Prefix>-<Sequence><Abbr/Code>-<Category>-<Subcategory>-<Version>.
 */
export function buildComponentIdWithCore(input: ComponentIdInput): string {
  const rule = NAMING_RULES[input.type];
  if (!rule) throw new Error(`No naming rule for ${input.type}`);
  if (!input.id_core) throw new Error("id_core is required for buildComponentIdWithCore");

  const prefix = rule.prefix;
  const cat = String(input.categoryCode).padStart(2, '0');
  const sizeOrUnit = applySlugify(input.subcategory, rule.slugify);
  const ver = String(input.version).replace(/[^0-9]/g, '').padStart(2, '0');

  return `${prefix}-${input.id_core}-${cat}-${sizeOrUnit}-${ver}`;
}

/**
 * Generates a unique, standardized component_id based on centralized naming rules.
 * Implements core reuse logic: if an item with same type and normalized name exists, reuse its core.
 */
export function generateComponentId(input: ComponentIdInput, existingItems: Component[]): string {
  const rule = NAMING_RULES[input.type];
  if (!rule) {
    throw new Error(`No naming rule defined for component type: ${input.type}`);
  }

  const prefix = rule.prefix;
  const existingIds = existingItems.map(i => i.component_id);
  
  // --- CORE REUSE LOGIC ---
  // Search for matches based on normalized name and same type.
  // We prioritize previously stored id_core for stability.
  const normalizedNew = normalizeComponentName(input.name);
  const matches = existingItems
    .filter(i => i.type === input.type && normalizeComponentName(i.component_name) === normalizedNew)
    .sort((a, b) => {
        const dateA = new Date(a.updatedAt || a.createdAt || 0).getTime();
        const dateB = new Date(b.updatedAt || b.createdAt || 0).getTime();
        return dateB - dateA; // Newest first
    });

  const bestMatch = matches[0];
  if (bestMatch && !input.id_core) {
    const foundCore = bestMatch.id_core || extractCoreFromComponentId(bestMatch.component_id, bestMatch.type);
    if (foundCore) {
        // Reuse the found core to generate the suggestion
        return buildComponentIdWithCore({ ...input, id_core: foundCore });
    }
  }

  // --- FIXED CORE MAPPING (DISPENSING & PALLET_LOGISTICS) ---
  if (!input.id_core) {
    if (input.type === 'DISPENSING') {
      const mappedCore = DISPENSING_CORE_MAP[input.name];
      if (mappedCore) return buildComponentIdWithCore({ ...input, id_core: mappedCore });
    } else if (input.type === 'PALLET_LOGISTICS') {
      const mappedCore = PALLET_LOGISTICS_CORE_MAP[input.name];
      if (mappedCore) return buildComponentIdWithCore({ ...input, id_core: mappedCore });
    }
  }

  let currentSeq = '';
  let currentAbbr = '';

  // 1. Resolve Abbreviation
  if (input.id_core && String(input.id_core).length > 3) {
    currentAbbr = String(input.id_core).substring(3);
  } else {
    // If we had matches but for some reason didn't resolve full core, extract abbr
    if (bestMatch) {
      const extracted = extractCoreFromComponentId(bestMatch.component_id, bestMatch.type);
      currentAbbr = extracted && extracted.length > 3 ? extracted.substring(3) : '';
    }

    // Fallback to strategy
    if (!currentAbbr) {
      switch (rule.abbrStrategy) {
        case 'FROM_FAMILY_DEFINITIONS':
          currentAbbr = getFamilyAbbr(input.name) || getName3LetterAbbr(input.name);
          break;
        case 'FROM_CONSUMABLE_DEFINITIONS':
          currentAbbr = getConsumableAbbr(input.name) || getName3LetterAbbr(input.name);
          break;
        case 'FROM_KEYWORD_MAP':
          currentAbbr = getKeywordCode(input.name);
          break;
        case 'FROM_NAME_3LETTER':
        default:
          currentAbbr = getName3LetterAbbr(input.name);
          break;
      }
    }
  }

  // 2. Resolve Sequence
  if (input.id_core && String(input.id_core).length >= 3) {
    const candidateSeq = String(input.id_core).substring(0, 3);
    const testId = buildComponentIdWithCore({ ...input, id_core: String(input.id_core) });

    if (!existingIds.includes(testId)) {
      currentSeq = candidateSeq;
    }
  }

  // Fallback to standard sequencing
  if (!currentSeq) {
    if (rule.sequenceScope === 'FROM_FAMILY_DEFINITIONS') {
      currentSeq = getFamilyCode(input.name) || '000';
    } else if (rule.sequenceScope === 'FROM_FAMILY_DEFINITIONS' as any) { // Type check safety
      currentSeq = getFamilyCode(input.name) || '000';
    } else if (rule.sequenceScope === 'FROM_CONSUMABLE_DEFINITIONS') {
      currentSeq = getConsumableCode(input.name) || '000';
    } else {
      let maxSeq = -1;
      const seqRegex = rule.sequenceScope === 'PER_PREFIX' 
        ? new RegExp(`^${prefix}-(\\d{3})`) 
        : new RegExp(`^[A-Z]{3}-(\\d{3})`);

      existingIds.forEach(id => {
        const match = String(id).match(seqRegex);
        if (match) {
          const seqNum = parseInt(match[1], 10);
          if (seqNum > maxSeq) maxSeq = seqNum;
        }
      });
      currentSeq = (maxSeq + 1).toString().padStart(3, '0');
    }
  }

  // 3. Assemble
  return buildComponentIdWithCore({ ...input, id_core: `${currentSeq}${currentAbbr}` });
}
