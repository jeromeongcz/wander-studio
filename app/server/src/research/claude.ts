import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineError } from '../engine.ts';
import { findTool } from '../platform.ts';

export interface ClaudeStatus {
  installed: boolean;
  loggedIn: boolean;
  bin: string;
  detail: string;
  fix?: string;
}

export function resolveClaudeBin(override?: string): string {
  if (override) return override;
  if (process.env.WANDER_CLAUDE_BIN) return process.env.WANDER_CLAUDE_BIN;
  // on Windows this finds claude.exe; a .cmd shim cannot be started without a shell, which is never used here
  return findTool('claude');
}

const SIGN_IN = 'Open a terminal and run: claude auth login   (then come back and check again)';

function exec(bin: string, args: string[], opts: { input?: string; cwd?: string; timeout: number; signal?: AbortSignal }): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { cwd: opts.cwd, timeout: opts.timeout, maxBuffer: 32 * 1024 * 1024, signal: opts.signal }, (err, stdout, stderr) => {
      if (opts.signal?.aborted) return reject(new EngineError('CANCELLED', 'Cancelled'));
      const e = err as (NodeJS.ErrnoException & { code?: string | number; killed?: boolean }) | null;
      if (e && e.code === 'ENOENT') return reject(new EngineError('PROVIDER_ERROR', `Claude Code was not found at "${bin}"`));
      if (e?.killed) return reject(new EngineError('PROVIDER_ERROR', 'Claude Code took too long and was stopped'));
      // a non-zero exit still carries a JSON error message on stdout, so hand it back for the caller to read
      resolve({ stdout: String(stdout), stderr: String(stderr), code: e ? (typeof e.code === 'number' ? e.code : 1) : 0 });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/**
 * Bridge to the Claude Code command on this machine. It is started with ONLY the web search and web fetch tools,
 * in an empty temporary folder, with no MCP servers or slash commands, so it cannot read your files or run commands.
 * It uses your own Claude sign-in and plan. Only the prompt you can see is sent.
 */
export class ClaudeBridge {
  bin: string;
  constructor(bin?: string) {
    this.bin = resolveClaudeBin(bin);
  }

  async status(): Promise<ClaudeStatus> {
    try {
      const r = await exec(this.bin, ['auth', 'status'], { timeout: 20_000 });
      const j = JSON.parse(r.stdout) as { loggedIn?: boolean };
      return j.loggedIn
        ? { installed: true, loggedIn: true, bin: this.bin, detail: 'Claude Code is installed and signed in' }
        : { installed: true, loggedIn: false, bin: this.bin, detail: 'Claude Code is installed but not signed in', fix: SIGN_IN };
    } catch (e) {
      const msg = (e as Error).message;
      if (/not found/.test(msg)) return { installed: false, loggedIn: false, bin: this.bin, detail: 'Claude Code was not found on this computer', fix: 'Install Claude Code, then sign in with: claude auth login' };
      return { installed: true, loggedIn: false, bin: this.bin, detail: `Could not read Claude Code's sign-in status: ${msg}`, fix: SIGN_IN };
    }
  }

  /** Ask one research question and return the answer text. */
  async ask(prompt: string, opts: { signal?: AbortSignal; timeoutMs?: number; noTools?: boolean } = {}): Promise<string> {
    const cwd = await mkdtemp(join(tmpdir(), 'wander-claude-'));
    try {
      // research gets the two web tools; writing gets no tools at all
      const tools = opts.noTools ? ['--tools', ''] : ['--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch,WebFetch'];
      const args = ['-p', '--output-format', 'json', ...tools, '--permission-mode', 'dontAsk', '--no-session-persistence', '--disable-slash-commands', '--strict-mcp-config'];
      const r = await exec(this.bin, args, { input: prompt, cwd, timeout: opts.timeoutMs ?? 8 * 60_000, signal: opts.signal });
      let j: { is_error?: boolean; result?: unknown } | null = null;
      try {
        j = JSON.parse(r.stdout);
      } catch {
        /* not JSON */
      }
      if (!j) throw new EngineError('PROVIDER_ERROR', `Claude Code returned something unreadable${r.stderr ? `: ${r.stderr.trim().slice(0, 200)}` : ''}`);
      const text = typeof j.result === 'string' ? j.result : '';
      if (j.is_error || r.code) {
        const auth = /authenticat|OAuth|sign in|log in|login/i.test(text);
        throw new EngineError('PROVIDER_ERROR', auth ? `Claude Code is not signed in: ${text}. ${SIGN_IN}` : `Claude Code reported an error: ${text.slice(0, 300) || 'unknown error'}`);
      }
      if (!text.trim()) throw new EngineError('PROVIDER_ERROR', 'Claude Code returned an empty answer');
      return text;
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  }
}
