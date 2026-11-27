import type { LLMProvider, TextLLMProvider, LLMSettings, LLMHealthStatus } from './types.ts';
import { EngineError } from '../../engine.ts';

/**
 * Holds every registered LLM provider and tracks the one globally active selection,
 * plus an optional fallback provider used only when the user explicitly retries with it.
 * Health status (ok/detail/latency/lastError) is cached per provider for the Settings UI.
 */
export class LLMProviderRegistry {
  private providers = new Map<string, LLMProvider>();
  private activeId: string | null = null;
  private fallbackId: string | null = null;
  private health = new Map<string, LLMHealthStatus>();
  private defaults: Partial<LLMSettings> = {};

  register(provider: LLMProvider): void {
    this.providers.set(provider.id, provider);
  }

  replace(id: string, provider: LLMProvider): void {
    this.providers.set(id, provider);
  }

  list(): LLMProvider[] {
    return [...this.providers.values()];
  }

  get(id: string): LLMProvider {
    const p = this.providers.get(id);
    if (!p) throw new Error(`Unknown LLM provider "${id}"`);
    return p;
  }

  text(id: string): TextLLMProvider {
    const p = this.get(id);
    if (!('generateText' in p)) throw new Error(`Provider "${id}" does not support text generation`);
    return p as TextLLMProvider;
  }

  active(): TextLLMProvider | null {
    if (!this.activeId) return null;
    const p = this.providers.get(this.activeId);
    if (!p || !('generateText' in p)) return null;
    return p as TextLLMProvider;
  }

  activeIdOrNull(): string | null {
    return this.activeId;
  }

  fallback(): TextLLMProvider | null {
    if (!this.fallbackId) return null;
    const p = this.providers.get(this.fallbackId);
    if (!p || !('generateText' in p)) return null;
    return p as TextLLMProvider;
  }

  fallbackIdOrNull(): string | null {
    return this.fallbackId;
  }

  setActive(id: string | null): void {
    if (id !== null) {
      const p = this.providers.get(id);
      if (!p) throw new EngineError('NOT_FOUND', `Unknown LLM provider "${id}"`);
      if (!('generateText' in p)) throw new EngineError('NOT_FOUND', `Provider "${id}" does not support text generation`);
    }
    this.activeId = id;
  }

  setFallback(id: string | null): void {
    if (id !== null) {
      const p = this.providers.get(id);
      if (!p) throw new EngineError('NOT_FOUND', `Unknown LLM provider "${id}"`);
      if (!('generateText' in p)) throw new EngineError('NOT_FOUND', `Provider "${id}" does not support text generation`);
    }
    this.fallbackId = id;
  }

  /** Apply persisted settings. Returns the provider id that was activated (or null). */
  applySettings(settings: Partial<LLMSettings>): string | null {
    this.defaults = { ...this.defaults, ...settings };
    if (settings.activeProvider !== undefined) {
      try { this.setActive(settings.activeProvider); } catch { /* unknown provider in saved settings; leave unset */ }
    }
    if (settings.fallbackProvider !== undefined) {
      try { this.setFallback(settings.fallbackProvider); } catch { /* unknown fallback; ignore */ }
    }
    return this.activeId;
  }

  setHealth(id: string, status: LLMHealthStatus): void {
    this.health.set(id, status);
  }

  healthStatus(id: string): LLMHealthStatus | undefined {
    return this.health.get(id);
  }

  allHealth(): Array<{ id: string; ok: boolean; detail: string; latencyMs?: number; lastError?: string }> {
    return [...this.providers.keys()].map((id) => {
      const h = this.health.get(id);
      return { id, ok: h?.ok ?? false, detail: h?.detail ?? 'not checked', latencyMs: h?.latencyMs, lastError: h?.lastError };
    });
  }

  /** Generate text with the active provider, falling back to the configured fallback only on explicit error. */
  async generateText(args: {
    prompt: string;
    model?: string;
    temperature?: number;
    tools?: string;
    signal?: AbortSignal;
    onChunk?: (chunk: string) => void;
  }): Promise<string> {
    const active = this.active();
    if (!active) throw new Error('No AI provider selected. Choose one in Settings → AI Provider.');
    try {
      return await active.generateText({ ...args });
    } catch (e) {
      const fb = this.fallback();
      if (fb) {
        // Record the failure on the active provider so Settings can show it.
        try {
          const h = await active.healthCheck();
          this.setHealth(active.id, { ok: false, detail: h.detail, lastError: (e as Error).message, checkedAt: new Date().toISOString() });
        } catch { /* health check itself failed; ignore */ }
        return fb.generateText({ ...args });
      }
      throw e;
    }
  }
}
