import type { EngineError } from '../../engine.ts';

export type LLMKind = 'claude' | 'ollama' | 'openai-compatible';

export interface LLMProviderTerms {
  freeTier: string;
  requiresKey: boolean;
  commercialUse: string;
  privacy: string;
  termsUrl?: string;
}

/** Last-known health result for a provider, shown in Settings. */
export interface LLMHealthStatus {
  ok: boolean;
  detail: string;
  latencyMs?: number;
  lastError?: string;
  checkedAt?: string;
}

export interface BaseLLMProvider {
  id: string;
  kind: LLMKind;
  name: string;
  terms: LLMProviderTerms;
  healthCheck(): Promise<LLMHealthStatus>;
  listModels?(): Promise<Array<{ id: string; name: string }>>;
  pullModel?(args: { model: string; onProgress?: (p: { status: string; completed?: number; total?: number; percent?: number }) => void }): Promise<void>;
}

/** Result of a streaming text generation. Each chunk is a piece of the answer. */
export interface LLMStreamResult {
  /** Full accumulated text so far (for UI progress display). */
  text: string;
  /** True when this is the final chunk. */
  done: boolean;
}

export interface TextLLMProvider extends BaseLLMProvider {
  generateText(args: {
    prompt: string;
    model?: string;
    temperature?: number;
    tools?: string;        // Claude-only: comma-separated tool names; '' or omitted = no tools
    signal?: AbortSignal;
    onChunk?: (chunk: string) => void; // streaming callback
  }): Promise<string>;
}

export type LLMProvider = BaseLLMProvider | TextLLMProvider;

/** Thrown when the active LLM provider cannot perform a text generation. */
export class LLMProviderError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'LLMProviderError';
    this.code = code;
  }
}

/** Persisted global LLM settings. */
export interface LLMSettings {
  activeProvider: string | null;
  fallbackProvider: string | null;
  ollamaHost?: string;
  defaultToFreeFirst?: boolean;
  openaiCompatible?: { baseUrl: string; apiKey?: string; model: string };
  selectedModel?: string;        // model id for the active provider (Ollama / OpenAI-compatible)
}
