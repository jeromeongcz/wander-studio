import { isPrivateHost } from '../assets.ts';

export type LinkStatus = 'reachable' | 'unclear' | 'dead' | 'unchecked';
export interface LinkResult {
  status: LinkStatus;
  note: string;
}

const UA = 'WanderAIDirector/0.1 (link check)';

async function checkOne(url: string, fetchFn: typeof fetch): Promise<LinkResult> {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    let u: URL;
    try {
      u = new URL(current);
    } catch {
      return { status: 'dead', note: 'not a valid address' };
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { status: 'dead', note: 'not a web address' };
    // Addresses come from AI output, so never let one point this machine at its own or a private network.
    if (isPrivateHost(u.hostname) || u.username || u.password) return { status: 'dead', note: 'points at a private or local address' };
    let res: Response;
    try {
      res = await fetchFn(current, { method: 'GET', redirect: 'manual', headers: { 'user-agent': UA, accept: 'text/html,*/*;q=0.5' }, signal: AbortSignal.timeout(8000) });
    } catch (e) {
      const code = (e as { cause?: { code?: string } }).cause?.code;
      if (code === 'ENOTFOUND' || code === 'ERR_INVALID_URL') return { status: 'dead', note: 'domain not found' };
      return { status: 'unclear', note: (e as Error).name === 'TimeoutError' ? 'timed out' : 'could not connect' };
    }
    res.body?.cancel().catch(() => {}); // headers are enough; do not download the page
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location')!, current).toString();
      continue;
    }
    if (res.status >= 200 && res.status < 300) return { status: 'reachable', note: `HTTP ${res.status}` };
    if (res.status === 404 || res.status === 410) return { status: 'dead', note: `HTTP ${res.status}: page not found` };
    return { status: 'unclear', note: `HTTP ${res.status}: the site may block automated checks` };
  }
  return { status: 'unclear', note: 'too many redirects' };
}

/**
 * Check that each cited page exists. "Reachable" only means the address answers: it does not prove the page
 * says what the fact claims, so the person still has to read the source. Dead links are a strong sign of a made-up citation.
 */
export async function checkLinks(urls: string[], fetchFn: typeof fetch = fetch, concurrency = 5): Promise<Map<string, LinkResult>> {
  const unique = [...new Set(urls)];
  const out = new Map<string, LinkResult>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, unique.length) }, async () => {
      while (next < unique.length) {
        const u = unique[next++];
        out.set(u, await checkOne(u, fetchFn));
      }
    }),
  );
  return out;
}
