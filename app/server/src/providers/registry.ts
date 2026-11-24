import { manualImport, manualPrompt } from './manual.ts';
import { openverse } from './openverse.ts';
import type { ImagePromptProvider, Provider, StockSearchProvider } from './types.ts';
import { EngineError } from '../engine.ts';

/**
 * Providers are always selected explicitly by id. There is no automatic fallback chain, so a free
 * provider can never be silently replaced by a paid one.
 */
export class ProviderRegistry {
  private providers = new Map<string, Provider>();
  constructor(fetchFn?: typeof fetch) {
    for (const p of [manualImport, manualPrompt, openverse(fetchFn)]) this.providers.set(p.id, p);
  }
  list(): Provider[] {
    return [...this.providers.values()];
  }
  get(id: string): Provider {
    const p = this.providers.get(id);
    if (!p) throw new EngineError('NOT_FOUND', `Unknown provider ${id}`);
    return p;
  }
  stock(id: string): StockSearchProvider {
    const p = this.get(id);
    if (p.kind !== 'stock_search') throw new EngineError('VALIDATION', `${id} is not a stock search provider`);
    return p as StockSearchProvider;
  }
  imagePrompt(id: string): ImagePromptProvider {
    const p = this.get(id);
    if (p.kind !== 'image_prompt') throw new EngineError('VALIDATION', `${id} is not an image prompt provider`);
    return p as ImagePromptProvider;
  }
}
