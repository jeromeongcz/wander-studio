import { EngineError } from '../engine.ts';
import type { LicenseRecord, LicenseType } from '../license.ts';
import type { StockResult, StockSearchProvider } from './types.ts';

const API = 'https://api.openverse.org/v1/images/';
const UA = 'WanderAIDirector/0.1 (local app)';
const CODE_MAP: Record<string, LicenseType> = {
  cc0: 'cc0', pdm: 'public-domain', by: 'cc-by', 'by-sa': 'cc-by-sa', 'by-nc': 'cc-by-nc', 'by-nd': 'cc-by-nd', 'by-nc-sa': 'cc-by-nc-sa', 'by-nc-nd': 'cc-by-nc-nd',
};

export function mapOpenverseLicense(r: Record<string, any>): LicenseRecord {
  const code = String(r.license ?? '').toLowerCase();
  const type = CODE_MAP[code] ?? 'other';
  const label = type === 'other' ? `license "${code || 'unknown'}"` : `CC ${code.toUpperCase()}${r.license_version ? ` ${r.license_version}` : ''}`;
  const by = r.creator ? ` by ${r.creator}` : '';
  return {
    type,
    attribution_text: typeof r.attribution === 'string' && r.attribution ? r.attribution : `"${r.title ?? 'Untitled'}"${by} is licensed under ${label}.${r.foreign_landing_url ? ` ${r.foreign_landing_url}` : ''}`,
    source_url: r.foreign_landing_url ?? r.url,
    author: r.creator ?? undefined,
    commercial_use: type === 'other' ? 'unknown' : code.includes('nc') ? 'no' : 'yes',
    derivatives_allowed: type === 'other' ? undefined : !code.includes('nd'),
    notes: type === 'other' ? `Openverse reported license "${code}"; verify manually` : undefined,
  };
}

function toResult(r: Record<string, any>): StockResult {
  return {
    id: String(r.id), title: r.title ?? '', creator: r.creator ?? undefined, creator_url: r.creator_url ?? undefined, thumbnail_url: r.thumbnail ?? undefined,
    download_url: String(r.url), landing_url: r.foreign_landing_url ?? undefined, width: r.width ?? undefined, height: r.height ?? undefined, license: mapOpenverseLicense(r),
  };
}

export function openverse(fetchFn: typeof fetch = fetch): StockSearchProvider {
  const get = async (url: string) => {
    let res: Response;
    try {
      res = await fetchFn(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
    } catch (e) {
      throw new EngineError('PROVIDER_ERROR', `Could not reach Openverse: ${(e as Error).message}`);
    }
    if (!res.ok) throw new EngineError('PROVIDER_ERROR', `Openverse returned HTTP ${res.status}`);
    return (await res.json()) as any;
  };
  return {
    id: 'openverse',
    kind: 'stock_search',
    name: 'Openverse (openly licensed images)',
    terms: {
      freeTier: 'Free anonymous API, rate-limited; no key required',
      requiresKey: false,
      commercialUse: 'Per-image Creative Commons / public-domain licenses. Searches default to commercial-use + modification-allowed licenses; always check attribution.',
      privacy: 'Only your search text and the result id are sent to api.openverse.org; no project data. Image files come from third-party hosts.',
      termsUrl: 'https://docs.openverse.org/api/guides/terms_of_service.html',
    },
    async healthCheck() {
      try {
        await get(`${API}?q=test&page_size=1`);
        return { ok: true, detail: 'Openverse API reachable' };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    },
    async search({ query, page = 1, includeRestricted = false }) {
      if (!query.trim()) throw new EngineError('VALIDATION', 'query is required');
      const u = new URL(API);
      u.searchParams.set('q', query.trim());
      u.searchParams.set('page', String(Math.max(1, Math.floor(page))));
      u.searchParams.set('page_size', '20');
      u.searchParams.set('mature', 'false');
      if (!includeRestricted) u.searchParams.set('license_type', 'commercial,modification');
      const j = await get(u.toString());
      return (j.results ?? []).map(toResult);
    },
    async fetchResult(id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new EngineError('VALIDATION', 'Invalid Openverse result id');
      return toResult(await get(`${API}${id}/`));
    },
  };
}
