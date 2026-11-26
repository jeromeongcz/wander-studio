import { spawn } from 'node:child_process';
import { findTool } from '../../platform.ts';

const DEFAULT_HOST = 'http://localhost:11434';

let ollamaProc: ReturnType<typeof spawn> | null = null;

/** Resolve the ollama binary path. */
export function resolveOllamaBin(override?: string): string {
  if (override) return override;
  if (process.env.WANDER_OLLAMA_BIN) return process.env.WANDER_OLLAMA_BIN;
  return findTool('ollama');
}

/** Is an ollama serve process currently tracked by this app? */
export function ollamaProcessRunning(): boolean {
  return ollamaProc !== null && !ollamaProc.killed;
}

/** PID of the tracked ollama process, if any. */
export function ollamaProcPid(): number | undefined {
  return ollamaProc?.pid;
}

/** Start `ollama serve` as a child process. Returns when the process is spawned (not necessarily healthy yet). */
export function startOllama(host = DEFAULT_HOST, binOverride?: string): Promise<void> {
  if (ollamaProcessRunning()) return Promise.resolve();
  const bin = resolveOllamaBin(binOverride);
  const proc = spawn(bin, ['serve'], {
    env: { ...process.env, OLLAMA_HOST: host.replace(/^http:\/\//, '').replace(/\/+$/, '') },
    stdio: 'ignore',
    detached: false,
  });
  ollamaProc = proc;
  proc.unref();
  proc.on('exit', () => {
    if (ollamaProc === proc) ollamaProc = null;
  });
  proc.on('error', () => {
    if (ollamaProc === proc) ollamaProc = null;
  });
  return Promise.resolve();
}

/** Stop the tracked ollama serve process, if any. */
export function stopOllama(): void {
  if (ollamaProc && !ollamaProc.killed) {
    ollamaProc.kill('SIGTERM');
  }
  ollamaProc = null;
}
