import { execFile, spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';
import { client, ndJsonStream, PROTOCOL_VERSION, type ClientApp, type ClientContext } from '@agentclientprotocol/sdk';
import { LLMProviderError, type TextLLMProvider } from './types.ts';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const adapter = require.resolve('@agentclientprotocol/codex-acp');
const bundledCodex = createRequire(adapter).resolve('@openai/codex/bin/codex.js');

async function withCodex<T>(
  app: ClientApp,
  options: { bin?: string; model?: string; signal: AbortSignal },
  run: (connection: ClientContext, cwd: string) => Promise<T>,
): Promise<T> {
  options.signal.throwIfAborted();
  const cwd = await mkdtemp(join(await realpath(tmpdir()), 'wander-codex-'));
  try {
    const env = { ...process.env };
    delete env.DEFAULT_AUTH_REQUEST;
    delete env.APP_SERVER_LOGS;
    delete env.MODEL_PROVIDER;
    if (options.bin) env.CODEX_PATH = options.bin;
    else delete env.CODEX_PATH;
    const child = spawn(process.execPath, [adapter], {
      cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: {
        ...env,
        NO_BROWSER: '1',
        INITIAL_AGENT_MODE: 'read-only',
        CODEX_CONFIG: JSON.stringify({
          model: options.model,
          sandbox_mode: 'read-only',
          approval_policy: 'never',
          web_search: 'disabled',
          hooks: {},
          mcp_servers: {},
          features: { shell_tool: false, unified_exec: false, hooks: false, apps: false, plugins: false, multi_agent: false, multi_agent_v2: false },
        }),
      },
    });
    const closed = new Promise<void>((resolve) => child.once('close', resolve));
    const failed = new Promise<never>((_, reject) => child.once('error', reject));
    const transport = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
    try {
      return await Promise.race([
        failed,
        app.connectWith(transport, async (connection) => {
          await connection.request('initialize', {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
            clientInfo: { name: 'wander-studio', title: 'Wander Studio', version: '1' },
          }, { cancellationSignal: options.signal, stopWaitingOnCancel: true });
          return run(connection, cwd);
        }),
      ]);
    } finally {
      child.stdin.destroy();
      const terminate = setTimeout(() => child.kill('SIGKILL'), 3_000);
      await closed;
      clearTimeout(terminate);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

export function codexProvider(bin = process.env.WANDER_CODEX_BIN): TextLLMProvider {
  return {
    id: 'codex',
    kind: 'codex',
    name: 'Codex',
    terms: {
      freeTier: 'Uses your Codex sign-in and its usage limits',
      requiresKey: false,
      commercialUse: 'Per your OpenAI plan terms',
      privacy: 'Generation prompts are sent to OpenAI',
    },
    async healthCheck() {
      try {
        await exec(bin || process.execPath, [...(bin ? [] : [bundledCodex]), 'login', 'status'], { timeout: 10_000 });
      } catch {
        return { ok: false, detail: 'Codex sign-in could not be verified. Run codex login in a terminal, then check again.' };
      }
      try {
        await withCodex(client(), { bin, signal: AbortSignal.timeout(10_000) }, async () => {});
        return { ok: true, detail: 'Codex ACP is ready and signed in' };
      } catch {
        return { ok: false, detail: 'Codex is signed in, but the ACP adapter could not start.' };
      }
    },
    async listModels() {
      const signal = AbortSignal.timeout(20_000);
      try {
        return await withCodex(client(), { bin, signal }, async (connection, cwd) => {
          const { configOptions } = await connection.request('session/new', { cwd, mcpServers: [] }, {
            cancellationSignal: signal,
            stopWaitingOnCancel: true,
          });
          const model = configOptions?.find((option) => option.category === 'model');
          if (model?.type !== 'select') throw new LLMProviderError('PROVIDER_ERROR', 'Codex ACP did not provide a model list');
          return model.options.flatMap((option) => 'options' in option ? option.options : [option])
            .map(({ value, name }) => ({ id: value, name }));
        });
      } catch (error) {
        if (error instanceof LLMProviderError) throw error;
        throw new LLMProviderError('PROVIDER_ERROR', 'Could not load Codex models. Check your Codex sign-in and try again.');
      }
    },
    async generateText({ prompt, model, signal, onChunk }) {
      const timeout = AbortSignal.timeout(8 * 60_000);
      const operation = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const options = { cancellationSignal: operation, stopWaitingOnCancel: true };
      let sessionId: string | undefined;
      let messageId: string | undefined;
      const chunks: string[] = [];
      const app = client()
        .onRequest('session/request_permission', () => ({ outcome: { outcome: 'cancelled' } }))
        .onNotification('session/update', ({ params }) => {
          const { update } = params;
          if (params.sessionId === sessionId && update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
            // The adapter also emits untagged configuration notices as text chunks.
            if (!update.messageId) return;
            if (messageId !== update.messageId) {
              messageId = update.messageId;
              chunks.length = 0;
            }
            chunks.push(update.content.text);
            onChunk?.(update.content.text);
          }
        });

      try {
        return await withCodex(app, { bin, model, signal: operation }, async (connection, cwd) => {
          ({ sessionId } = await connection.request('session/new', { cwd, mcpServers: [] }, options));
          const cancel = () => {
            if (sessionId) void connection.notify('session/cancel', { sessionId }).catch(() => {});
          };
          operation.throwIfAborted();
          operation.addEventListener('abort', cancel, { once: true });
          try {
            const result = await connection.request('session/prompt', {
              sessionId,
              prompt: [{ type: 'text', text: prompt }],
            }, options);
            const answer = chunks.join('');
            if (result.stopReason !== 'end_turn') throw new LLMProviderError('PROVIDER_ERROR', `Codex stopped early (${result.stopReason})`);
            if (!answer.trim()) throw new LLMProviderError('PROVIDER_ERROR', 'Codex returned an empty answer');
            return answer;
          } finally {
            operation.removeEventListener('abort', cancel);
          }
        });
      } catch (error) {
        if (signal?.aborted) throw new LLMProviderError('CANCELLED', 'Cancelled');
        if (timeout.aborted) throw new LLMProviderError('PROVIDER_ERROR', 'Codex took too long and was stopped');
        if (error instanceof LLMProviderError) throw error;
        throw new LLMProviderError('PROVIDER_ERROR', 'Codex ACP generation failed. Check Codex sign-in and ACP status in Settings.');
      }
    },
  };
}
