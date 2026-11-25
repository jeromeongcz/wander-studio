import { fileURLToPath } from 'node:url';
import { createReadStream, existsSync } from 'node:fs';
import { isInside } from './platform.ts';
import { join, dirname, extname, normalize, resolve } from 'node:path';
import { openDb } from './db.ts';
import { Engine } from './engine.ts';
import { buildApi } from './api.ts';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// WANDER_ROOT keeps data (projects, db, cache) somewhere other than the source tree, e.g. for demos.
const root = process.env.WANDER_ROOT ?? appRoot;
const dbPath = process.env.WANDER_DB ?? join(root, 'data', 'wander.db');
const port = Number(process.env.WANDER_PORT ?? 4317);

const app = buildApi(new Engine(openDb(dbPath)), { root });

// Serve the built web UI (app/web/dist) when it exists. API routes live at /api/* (and, for tools, at the root).
const dist = join(appRoot, 'app', 'web', 'dist', 'ui');
if (existsSync(join(dist, 'index.html'))) {
  const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };
  app.get('/', async (_req, reply) => reply.type(MIME['.html']).send(createReadStream(join(dist, 'index.html'))));
  app.get('/ui/*', async (req, reply) => {
    const rel = normalize((req.params as { '*': string })['*']);
    const file = resolve(dist, rel);
    if (rel.startsWith('..') || !isInside(dist, file) || !existsSync(file)) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    return reply.type(MIME[extname(file)] ?? 'application/octet-stream').send(createReadStream(file));
  });
}
// Bind to loopback only: this is a local-first app with no authentication.
await app.listen({ host: '127.0.0.1', port });
console.log(`Wander AI Director API on http://127.0.0.1:${port} (db: ${dbPath})`);
