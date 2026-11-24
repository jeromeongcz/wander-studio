import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { openDb } from './db.ts';
import { Engine } from './engine.ts';
import { buildApi } from './api.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dbPath = process.env.WANDER_DB ?? join(root, 'data', 'wander.db');
const port = Number(process.env.WANDER_PORT ?? 4317);

const app = buildApi(new Engine(openDb(dbPath)));
// Bind to loopback only: this is a local-first app with no authentication.
await app.listen({ host: '127.0.0.1', port });
console.log(`Wander AI Director API on http://127.0.0.1:${port} (db: ${dbPath})`);
