import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TextLLMProvider, LLMProviderTerms, LLMHealthStatus } from './types.ts';
import { LLMProviderError } from './types.ts';

const SIGN_IN = 'Open a terminal and run: claude auth login   (then come back and check again)';

export function resolveClaudeBin(override?: string): string {
  if (override) return override;
  if (process.env.WANDER_CLAUDE_BIN) return process.env.WANDER_CLAUDE_BIN;
  return require('../../platform.ts').findTool('claude');
}

function exec(bin: string, args: string[], opts: { input?: string; cwd?: string; timeout: number; signal?: AbortSignal }): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { cwd: opts.cwd, timeout: opts.timeout, maxBuffer: 32 * 1024 * 1024, signal: opts.signal }, (err, stdout, stderr) => {
      if (opts.signal?.aborted) return reject(new LLMProviderError('CANCELLED', 'Cancelled'));
      const e = err as (NodeJS.ErrnoException & { code?: string | number; killed?: boolean }) | null;
      if (e && e.code === 'ENOENT') return reject(new LLMProviderError('PROVIDER_ERROR', `Claude Code was not found at "${bin}"`));
      if (e?.killed) return reject(new LLMProviderError('PROVIDER_ERROR', 'Claude Code took too long and was stopped'));
      resolve({ stdout: String(stdout), stderr: String(stderr), code: e ? (typeof e.code === 'number' ? e.code : 1) : 0 });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** Wraps the Claude Code command as a text LLM provider. Uses your own Claude sign-in and plan. */
export function claudeProvider(binOverride?: string): TextLLMProvider {
  const bin = resolveClaudeBin(binOverride);
  const terms: LLMProviderTerms = {
    freeTier: 'Claude plan you already pay for; no extra charge from this app',
    requiresKey: false,
    commercialUse: 'Per your Anthropic plan terms',
    privacy: 'Only the prompt text is sent to Claude Code; no project data or files',
    termsUrl: 'https://www.anthropic.com/terms',
  };

  async function status(): Promise<LLMHealthStatus> {
    const start = Date.now();
    try {
      const r = await exec(bin, ['auth', 'status'], { timeout: 20_000 });
      const j = JSON.parse(r.stdout) as { loggedIn?: boolean };
      if (j.loggedIn) {
        return { ok: true, detail: 'Claude Code is installed and signed in', latencyMs: Date.now() - start, checkedAt: new Date().toISOString() };
      }
      return { ok: false, detail: 'Claude Code is installed but not signed in', latencyMs: Date.now() - start, lastError: SIGN_IN, checkedAt: new Date().toISOString() };
    } catch (e) {
      const msg = (e as Error).message;
      if (/not found/.test(msg)) {
        return { ok: false, detail: 'Claude Code was not found on this computer', latencyMs: Date.now() - start, lastError: 'Install Claude Code, then sign in with: claude auth login', checkedAt: new Date().toISOString() };
      }
      return { ok: false, detail: `Could not read Claude Code's sign-in status: ${msg}`, latencyMs: Date.now() - start, lastError: msg, checkedAt: new Date().toISOString() };
    }
  }

  return {
    id: 'claude',
    kind: 'claude',
    name: 'Claude Code (your sign-in)',
    terms,
    async healthCheck() {
      return status();
    },
    async generateText({ prompt, model, temperature, tools, signal, onChunk }) {
      const st = await status();
      if (!st.ok) throw new LLMProviderError('PROVIDER_ERROR', `${st.detail}. ${st.lastError ?? ''}`.trim());
      const cwd = await mkdtemp(join(tmpdir(), 'wander-claude-'));
      try {
        const args = [
          '-p',
          '--output-format', 'json',
          ...(model ? ['--model', model] : []),
          ...(temperature !== undefined ? ['--temperature', String(temperature)] : []),
          '--tools', tools ?? '',
          ...(tools ? ['--allowedTools', tools] : []),
          '--permission-mode', 'dontAsk',
          '--no-session-persistence',
          '--disable-slash-commands',
          '--strict-mcp-config',
        ];
        const r = await exec(bin, args, { input: prompt, cwd, timeout: 8 * 60_000, signal });
        let j: { is_error?: boolean; result?: unknown } | null = null;
        try { j = JSON.parse(r.stdout); } catch { /* not JSON */ }
        if (!j) throw new LLMProviderError('PROVIDER_ERROR', `Claude Code returned something unreadable${r.stderr ? `: ${r.stderr.trim().slice(0, 200)}` : ''}`);
        const text = typeof j.result === 'string' ? j.result : '';
        if (j.is_error || r.code) {
          const auth = /authenticat|OAuth|sign in|log in|login/i.test(text);
          throw new LLMProviderError('PROVIDER_ERROR', auth ? `Claude Code is not signed in: ${text}. ${SIGN_IN}` : `Claude Code reported an error: ${text.slice(0, 300) || 'unknown error'}`);
        }
        if (!text.trim()) throw new LLMProviderError('PROVIDER_ERROR', 'Claude Code returned an empty answer');
        if (onChunk) onChunk(text);
        return text;
      } finally {
        await rm(cwd, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
