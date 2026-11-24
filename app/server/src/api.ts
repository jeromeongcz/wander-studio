import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { Engine, EngineError } from './engine.ts';
import { Studio } from './services.ts';
import { addLanguage, createProject, removeLanguage } from './pipeline.ts';
import { estimate, isPreset, PRESETS } from './studios/estimator.ts';
import { newResearchContent } from './studios/research.ts';
import { listCategories } from './studios/storyboard.ts';

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
    studio.assertLocales(languages);
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
    return estimate({ sections, lang: b.lang, preset: b.preset, targetSeconds: b.target_seconds, samples: studio.samples(b.lang), defaultWpm: studio.defaultWpm(b.lang) });
  });
  app.get('/calibration/:lang', async (req) => {
    const { lang } = req.params as { lang: string };
    return studio.wpm(lang);
  });
  app.post('/calibration/:lang', async (req, reply) => {
    const { lang } = req.params as { lang: string };
    const b = body(req);
    return reply.status(201).send(studio.addCalibration(lang, Number(b.words), Number(b.seconds)));
  });

  // ---- localization ----
  app.get('/locales', async () => studio.listLocales());
  app.post('/locales', async (req, reply) => {
    const b = body(req);
    return reply.status(201).send(studio.upsertLocale(String(b.code ?? ''), String(b.name ?? ''), String(b.bcp47 ?? ''), Number(b.default_wpm)));
  });
  app.post('/projects/:id/languages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const lang = String(body(req).lang ?? '');
    studio.assertLocales([lang]);
    addLanguage(engine, id, lang);
    return reply.status(201).send(engine.getProject(id));
  });
  app.delete('/projects/:id/languages/:lang', async (req) => {
    const { id, lang } = req.params as { id: string; lang: string };
    return { removedArtifacts: removeLanguage(engine, id, lang) };
  });
  app.post('/artifacts/:id/seed-from-base', async (req, reply) => reply.status(201).send(studio.seedFromBase((req.params as { id: string }).id)));
  app.get('/artifacts/:id/adaptation-prompt', async (req) => {
    const q = req.query as { notes?: string };
    return { prompt: studio.adaptationPrompt((req.params as { id: string }).id, q.notes) };
  });
  app.get('/artifacts/:id/compare', async (req) => studio.compare((req.params as { id: string }).id));
  app.get('/artifacts/:id/language-mix', async (req) => studio.languageMix((req.params as { id: string }).id));
  app.get('/artifacts/:id/tts-preview', async (req) => studio.ttsPreview((req.params as { id: string }).id));
  app.get('/projects/:id/lexicon/:lang', async (req) => {
    const { id, lang } = req.params as { id: string; lang: string };
    return studio.listLexicon(id, lang);
  });
  app.put('/projects/:id/lexicon/:lang', async (req) => {
    const { id, lang } = req.params as { id: string; lang: string };
    const b = body(req);
    return studio.setLexicon(id, lang, String(b.term ?? ''), String(b.respelling ?? ''));
  });
  app.delete('/lexicon/:entryId', async (req) => studio.deleteLexicon((req.params as { entryId: string }).entryId));

  // ---- storyboard ----
  app.get('/categories', async () => listCategories());
  app.get('/categories/:name/recommendations', async (req) => studio.recommendations((req.params as { name: string }).name));
  app.post('/artifacts/:id/seed-storyboard', async (req, reply) => {
    const s = body(req).scene_seconds;
    return reply.status(201).send(studio.seedStoryboard((req.params as { id: string }).id, typeof s === 'number' ? s : undefined));
  });
  app.get('/artifacts/:id/storyboard-prompt', async (req) => ({ prompt: studio.storyboardPrompt((req.params as { id: string }).id, (req.query as { notes?: string }).notes) }));
  app.get('/artifacts/:id/timeline/:lang', async (req) => {
    const { id, lang } = req.params as { id: string; lang: string };
    return studio.timeline(id, lang);
  });
  app.put('/scenes/:sceneId/timing/:lang', async (req) => {
    const { sceneId, lang } = req.params as { sceneId: string; lang: string };
    return studio.setSceneTiming(sceneId, lang, Number(body(req).audio_seconds));
  });

  return app;
}
