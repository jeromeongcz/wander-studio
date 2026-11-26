import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { TtsConfig } from './audio/tts.ts';

export interface AppConfig {
  /** Application root: holds projects/, shared_assets/ and cache/. */
  root: string;
  /** Override ffprobe binary (default: Homebrew ffmpeg-full, then PATH). */
  ffprobePath?: string;
  /** Injectable fetch for provider calls (tests mock this; production uses global fetch). */
  fetchFn?: typeof fetch;
  /** TTS binary overrides (Piper models, edge-tts path). Nothing is downloaded automatically. */
  tts?: Omit<TtsConfig, 'ffmpeg'>;
  /** Optional whisper.cpp alignment: binary and a model file YOU downloaded. */
  whisper?: { bin?: string; model?: string };
  /** Optional AI research bridge: path to the Claude Code command (default: found automatically). */
  llm?: { claudeBin?: string };
  /** Persisted global LLM provider selection (active provider id). */
  activeLLMProvider?: string | null;
  /** Fallback provider used only on explicit retry after the active provider fails. */
  fallbackLLMProvider?: string | null;
  /** When no provider is explicitly chosen, prefer a free/local one (Ollama) over Claude. */
  defaultToFreeFirst?: boolean;
  /** Ollama host override (default: http://localhost:11434). */
  ollamaHost?: string;
  /** OpenAI-compatible endpoint configuration. */
  openaiCompatible?: { baseUrl: string; apiKey?: string; model: string };
  /** OpenRouter free models configuration. */
  openrouter?: { apiKey?: string; model: string };
  /** Model selected for the active provider (Ollama / OpenAI-compatible / OpenRouter). */
  selectedLLMModel?: string | null;
  /** Directories scanned for caption fonts (TTF/OTF). */
  fontDirs?: string[];
  maxImportBytes: number;
  maxRemoteBytes: number;
}

export function defaultRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

export function resolveConfig(c: Partial<AppConfig> = {}): AppConfig {
  return { root: c.root ?? defaultRoot(), ffprobePath: c.ffprobePath, fetchFn: c.fetchFn, tts: c.tts, whisper: c.whisper, llm: c.llm, activeLLMProvider: c.activeLLMProvider ?? null, fallbackLLMProvider: c.fallbackLLMProvider ?? null, defaultToFreeFirst: c.defaultToFreeFirst ?? false, ollamaHost: c.ollamaHost, openaiCompatible: c.openaiCompatible, openrouter: c.openrouter, selectedLLMModel: c.selectedLLMModel ?? null, fontDirs: c.fontDirs, maxImportBytes: c.maxImportBytes ?? 2 * 1024 ** 3, maxRemoteBytes: c.maxRemoteBytes ?? 25 * 1024 ** 2 };
}
