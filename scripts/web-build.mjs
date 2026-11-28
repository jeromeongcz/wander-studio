import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireSupportedNode } from './runtime.mjs';

const webRoot = fileURLToPath(new URL('../app/web/', import.meta.url));
const require = createRequire(new URL('../app/web/package.json', import.meta.url));

function packageCommand(name, bin) {
  const manifest = require.resolve(name + '/package.json');
  const { bin: bins } = JSON.parse(readFileSync(manifest, 'utf8'));
  const script = typeof bins === 'string' ? bins : bins?.[bin];
  if (typeof script !== 'string') throw new Error('Missing tool entry');
  const path = resolve(dirname(manifest), script);
  if (!existsSync(path)) throw new Error('Tool entry does not exist');
  return path;
}

function run() {
  if (!requireSupportedNode()) return 1;
  const typecheck = process.argv.includes('--typecheck');
  let commands;
  try {
    commands = [[packageCommand('typescript', 'tsc'), '-p', 'tsconfig.json']];
    if (!typecheck) commands.push([packageCommand('vite', 'vite'), 'build']);
  } catch {
    console.error('Wander Studio could not find its local web build tools (TypeScript or Vite).');
    console.error('At the repository root run: npm ci --include=dev');
    console.error('Then retry your previous command. Do not install tsc globally.');
    return 1;
  }
  // Use the workspace's pinned tools directly, not platform-specific .bin shims.
  for (const command of commands) {
    const result = spawnSync(process.execPath, command, { cwd: webRoot, stdio: 'inherit', windowsHide: true });
    if (result.error) console.error(result.error.message);
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

process.exitCode = run();
