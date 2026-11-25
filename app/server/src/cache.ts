import { existsSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { isInside } from './platform.ts';
import { join, resolve } from 'node:path';
import type { AppConfig } from './config.ts';

interface F {
  path: string;
  bytes: number;
  mtime: number;
  tmp: boolean;
}

const PRUNABLE = ['scene_clips', 'mix', 'ass', 'preview', 'uploads'];

/** Scene clips, mixes and caption scripts are rebuildable, so pruning them only costs re-render time. Nothing outside cache/ is ever touched. */
export class CacheService {
  config: AppConfig;
  constructor(config: AppConfig) {
    this.config = config;
  }
  private get dir() {
    return resolve(this.config.root, 'cache');
  }

  private async files(sub: string): Promise<F[]> {
    const base = join(this.dir, sub);
    if (!existsSync(base)) return [];
    const out: F[] = [];
    for (const e of await readdir(base, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      const p = join(base, e.name);
      const s = await stat(p);
      out.push({ path: p, bytes: s.size, mtime: s.mtimeMs, tmp: /\.(tmp\.\w+|partial)$/.test(e.name) });
    }
    return out;
  }

  async stats() {
    const dirs = [];
    let total = 0;
    for (const d of PRUNABLE) {
      const f = await this.files(d);
      const bytes = f.reduce((n, x) => n + x.bytes, 0);
      total += bytes;
      dirs.push({ name: d, files: f.length, bytes });
    }
    return { total_bytes: total, dirs };
  }

  async prune(opts: { olderThanDays?: number; maxBytes?: number } = {}) {
    const cutoff = opts.olderThanDays !== undefined ? Date.now() - opts.olderThanDays * 86_400_000 : null;
    const all: F[] = [];
    for (const d of PRUNABLE) all.push(...(await this.files(d)));
    const doomed = new Set<F>();
    for (const f of all) {
      if (f.tmp && Date.now() - f.mtime > 3_600_000) doomed.add(f); // abandoned partial output
      else if (cutoff !== null && f.mtime < cutoff) doomed.add(f);
    }
    if (opts.maxBytes !== undefined) {
      let size = all.filter((f) => !doomed.has(f)).reduce((n, f) => n + f.bytes, 0);
      for (const f of all.filter((x) => !doomed.has(x)).sort((a, b) => a.mtime - b.mtime)) {
        if (size <= opts.maxBytes) break;
        doomed.add(f);
        size -= f.bytes;
      }
    }
    let freed = 0;
    for (const f of doomed) {
      if (!isInside(this.dir, f.path)) continue; // defence in depth
      await rm(f.path, { force: true });
      freed += f.bytes;
    }
    return { removed_files: doomed.size, freed_bytes: freed };
  }
}
