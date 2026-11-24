import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { Engine, EngineError } from './engine.ts';
import { Studio } from './services.ts';
import { createProject } from './pipeline.ts';
import { estimate, isPreset, PRESETS, resolveWpm } from './studios/estimator.ts';
import { newResearchContent } from './studios/research.ts';

const STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  VALIDATION: 422,
  NOT_READY: 422,
  AI_CANNOT_VERIFY: 403,
  USER_ONLY: 403,
  PROTECTED: 409,
  UNMET_DEPENDENCY: 409,
  BAD_TRANSITION: 409,
  CYCLE: 409,
  NO_VERSION: 409,
};

const body = (req: { body: unknown }): Record<string, any> => (req.body && typeof req.body === 'object' ? (req.body as Record<string, any>) : {});

/**
 * HTTP API. Every request here is a user action by definition: AI-originated content is
 * created by internal provider code calling the service layer with actor 'ai', never via
 * these routes, so approval can never be performed by a provider.
 */
export function buildApi(engine: Engine): FastifyInstance {
  const studio = new Studio(engine);
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof EngineError) {
      return reply.status(STATUS[err.code] ?? 400).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.status(status).send({ error: { code: status === 500 ? 'INTERNAL' : 'BAD_REQUEST', message: status === 500 ? 'Internal error' : (err as Error).message } });
  });

  app.get('/health', async () => ({ ok: true }));

  // ---- projects ----
  app.get('/projects', async () => engine.listProjects());
  app.post('/projects', async (req, reply) => {
    const b = body(req);
    if (typeof b.name !== 'string' || !b.name.trim()) throw new EngineError('VALIDATION', 'name is required');
    const languages = Array.isArray(b.languages) && b.languages.length ? (b.languages as string[]) : ['en'];
    const formats = Array.isArray(b.formats) && b.formats.length ? (b.formats as string[]) : ['vertical_9x16'];
    const id = createProject(engine, { name: b.name.trim(), category: b.category, languages, formats });
    // Seed research with the fact-verification checklist (still not_started until the user saves).
    const [research] = engine.list(id, { kind: 'research' });
    return reply.status(201).send({ id, researchArtifactId: research.id, researchTemplate: newResearchContent(b.topic ?? b.name, b.category) });
  });
  app.get('/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    return { ...engine.getProject(id), artifacts: engine.list(id) };
  });

  // ---- artifacts ----
  app.get('/artifacts/:id', async (req) => {
    const { id } = req.params as { id: string };
    const a = engine.get(id);
    return { ...a, content: engine.getContent(id), upstream: engine.upstreamDirect(id).map((u) => ({ id: u.id, label: u.label, state: u.state })) };
  });
  app.put('/artifacts/:id/content', async (req) => {
    const { id } = req.params as { id: string };
    const b = body(req);
    return studio.save(id, b.content, { actor: 'user', reopen: b.reopen === true });
  });
  app.post('/artifacts/:id/submit', async (req) => studio.submit((req.params as { id: string }).id, 'user'));
  app.post('/artifacts/:id/approve', async (req) => {
    engine.approve((req.params as { id: string }).id, { actor: 'user', note: body(req).note });
    return { ok: true };
  });
  app.post('/artifacts/:id/reject', async (req) => {
    engine.reject((req.params as { id: string }).id, { actor: 'user', note: body(req).note });
    return { ok: true };
  });
  app.post('/artifacts/:id/request-revision', async (req) => {
    engine.requestRevision((req.params as { id: string }).id, body(req).note);
    return { ok: true };
  });
  app.get('/artifacts/:id/history', async (req) => {
    const { id } = req.params as { id: string };
    return { versions: engine.versions(id), events: engine.events(id) };
  });
  app.post('/artifacts/:id/restore', async (req) => {
    const b = body(req);
    if (typeof b.versionId !== 'string') throw new EngineError('VALIDATION', 'versionId is required');
    return engine.restoreVersion((req.params as { id: string }).id, b.versionId, { actor: 'user' });
  });

  // ---- scripting helpers ----
  app.get('/script-presets', async () => Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, min: p.min, max: Number.isFinite(p.max) ? p.max : null })));
  app.post('/estimate', async (req) => {
    const b = body(req);
    if (typeof b.lang !== 'string') throw new EngineError('VALIDATION', 'lang is required');
    const sections = Array.isArray(b.sections) ? b.sections : typeof b.text === 'string' ? [{ text: b.text }] : null;
    if (!sections) throw new EngineError('VALIDATION', 'Provide sections[] or text');
    if (b.preset !== undefined && !isPreset(b.preset)) throw new EngineError('VALIDATION', 'Unknown preset');
    return estimate({ sections, lang: b.lang, preset: b.preset, targetSeconds: b.target_seconds, samples: studio.samples(b.lang) });
  });
  app.get('/calibration/:lang', async (req) => {
    const { lang } = req.params as { lang: string };
    return resolveWpm(lang, studio.samples(lang));
  });
  app.post('/calibration/:lang', async (req, reply) => {
    const { lang } = req.params as { lang: string };
    const b = body(req);
    return reply.status(201).send(studio.addCalibration(lang, Number(b.words), Number(b.seconds)));
  });

  return app;
}
