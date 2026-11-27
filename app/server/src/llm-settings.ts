import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { defaultRoot } from './config.ts';
import type { LLMSettings } from './providers/llm/types.ts';

const SETTINGS_FILE = join(defaultRoot(), 'data', 'llm-settings.json');

const DEFAULTS: LLMSettings = {
  activeProvider: null,
  fallbackProvider: null,
  defaultToFreeFirst: false,
};

/** Read persisted LLM settings, returning defaults when the file is missing or invalid. */
export async function readLLMSettings(): Promise<LLMSettings> {
  if (!existsSync(SETTINGS_FILE)) return { ...DEFAULTS };
  try {
    const raw = await readFile(SETTINGS_FILE, 'utf8');
    const j = JSON.parse(raw) as Partial<LLMSettings>;
    return { ...DEFAULTS, ...j };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Persist LLM settings to disk, merging over any existing file so unrelated fields (like the OpenRouter key) are never dropped. */
export async function writeLLMSettings(settings: LLMSettings): Promise<void> {
  await mkdir(join(defaultRoot(), 'data'), { recursive: true });
  const existing = await readLLMSettings();
  const clean = Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined)) as Partial<LLMSettings>;
  const merged: LLMSettings = { ...existing, ...clean };
  await writeFile(SETTINGS_FILE, JSON.stringify(merged, null, 2), 'utf8');
}
