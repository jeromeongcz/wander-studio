import { EngineError } from './engine.ts';

export const LICENSE_TYPES = ['own', 'cc0', 'public-domain', 'cc-by', 'cc-by-sa', 'cc-by-nc', 'cc-by-nd', 'cc-by-nc-sa', 'cc-by-nc-nd', 'stock-licensed', 'ai-generated', 'other', 'unknown'] as const;
export type LicenseType = (typeof LICENSE_TYPES)[number];

export interface LicenseRecord {
  type: LicenseType;
  attribution_text?: string;
  source_url?: string;
  author?: string;
  commercial_use: 'yes' | 'no' | 'unknown';
  derivatives_allowed?: boolean;
  notes?: string;
}

const bad = (m: string, d?: unknown) => new EngineError('VALIDATION', m, d);
const ATTRIBUTION_REQUIRED = new Set<LicenseType>(['cc-by', 'cc-by-sa', 'cc-by-nc', 'cc-by-nd', 'cc-by-nc-sa', 'cc-by-nc-nd']);

export function validateLicenseShape(x: unknown): LicenseRecord {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw bad('license must be an object');
  const l = x as Record<string, unknown>;
  if (!LICENSE_TYPES.includes(l.type as LicenseType)) throw bad(`license.type must be one of ${LICENSE_TYPES.join(', ')}`);
  if (!['yes', 'no', 'unknown'].includes(l.commercial_use as string)) throw bad('license.commercial_use must be yes, no or unknown');
  for (const k of ['attribution_text', 'source_url', 'author', 'notes'] as const) if (l[k] !== undefined && typeof l[k] !== 'string') throw bad(`license.${k} must be a string`);
  if (l.derivatives_allowed !== undefined && typeof l.derivatives_allowed !== 'boolean') throw bad('license.derivatives_allowed must be boolean');
  return l as unknown as LicenseRecord;
}

/** Rules a license must satisfy before an asset can be approved. Returns non-blocking warnings. */
export function licenseApprovalCheck(l: LicenseRecord): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (l.type === 'unknown') errors.push('License is unknown; record where this asset comes from and what its license allows');
  if (ATTRIBUTION_REQUIRED.has(l.type) && !l.attribution_text?.trim()) errors.push('This license requires attribution text');
  if ((l.type === 'stock-licensed' || l.type === 'other') && !l.source_url?.trim() && !l.notes?.trim()) errors.push('Record a source URL or notes describing the license terms');
  if (l.commercial_use === 'no') warnings.push('Non-commercial license: not suitable for monetized videos');
  if (l.commercial_use === 'unknown' && l.type !== 'unknown') warnings.push('Commercial use is not recorded');
  if (l.derivatives_allowed === false) warnings.push('No-derivatives license: cropping, zooming and captions over the image may not be allowed');
  if (ATTRIBUTION_REQUIRED.has(l.type)) warnings.push('Attribution must be included in the video description');
  return { errors, warnings };
}
