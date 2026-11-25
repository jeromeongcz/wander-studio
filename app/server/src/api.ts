import Fastify from 'fastify';
import { createReadStream } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { ulid } from '../../shared/src/index.ts';
import { AUDIO_EXT, IMAGE_EXT, VIDEO_EXT } from './media.ts';
import { MIME } from './media.ts';
import type { AppConfig } from './config.ts';
import type { FastifyInstance } from 'fastify';
import { Engine, EngineError } from './engine.ts';
import { Studio } from './services.ts';
import { addFormat, addLanguage, createProject, removeFormat, removeLanguage } from './pipeline.ts';
import { estimate, isPreset, PRESETS } from './studios/estimator.ts';
import { newResearchContent } from './studios/research.ts';
import { listCategories, profileFor } from './studios/storyboard.ts';
import { I2V_PROVIDERS } from './providers/i2v.ts';

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
  MEDIA_INVALID: 422,
  LICENSE: 422,
  DUPLICATE_ASSET: 409,
  PROVIDER_ERROR: 502,
  TOOL_FAILED: 500,
  RENDER_INPUT: 422,
  RENDER_VERIFY: 500,
  DUPLICATE_PROJECT: 409,
  PREFLIGHT: 503,
  CANCELLED: 409,
  BUSY: 409,
  BATCH_PARTIAL: 500,
};

const body = (req: { body: unknown }): Record<string, any> => (req.body && typeof req.body === 'object' ? (req.body as Record<string, any>) : {});

/**
 * HTTP API. Every request here is a user action by definition: AI-originated content is
 * created by internal provider code calling the service layer with actor 'ai', never via
 * these routes, so approval can never be performed by a provider.
 */
export function buildApi(engine: Engine, config: Partial<AppConfig> = {}): FastifyInstance {
  const studio = new Studio(engine, config);
  const assets = studio.assets;
  // The UI calls /api/...; strip the prefix so every route works with or without it.
  const app = Fastify({ logger: false, rewriteUrl: (req) => (req.url?.startsWith('/api/') ? req.url.slice(4) : (req.url ?? '/')) });

  // The API has no login, so it must only answer the local UI. This blocks DNS-rebinding (wrong Host)
  // and other websites making your browser call it (cross-origin Origin on state-changing requests).
  const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
  app.addHook('onRequest', async (req, reply) => {
    if (!LOCAL.test(String(req.headers.host ?? ''))) return reply.status(403).send({ error: { code: 'FORBIDDEN_HOST', message: 'This app only answers on localhost' } });
    const origin = req.headers.origin;
    if (origin && req.method !== 'GET' && req.method !== 'HEAD') {
      let host = '';
      try {
        host = new URL(String(origin)).host;
      } catch {
        /* invalid origin */
      }
      if (host !== req.headers.host) return reply.status(403).send({ error: { code: 'FORBIDDEN_ORIGIN', message: 'Cross-origin requests are not allowed' } });
    }
  });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 512 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof EngineError) {
      return reply.status(STATUS[err.code] ?? 400).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.status(status).send({ error: { code: status === 500 ? 'INTERNAL' : 'BAD_REQUEST', message: status === 500 && !process.env.WANDER_DEBUG ? 'Internal error' : (err as Error).message } });
  });

  app.get('/health', async () => ({ ok: true }));

  // ---- uploads (the browser cannot give the server a local path) ----
  const uploadsDir = () => join(studio.config.root, 'cache', 'uploads');
  const isUpload = (p: unknown) => typeof p === 'string' && p.startsWith(uploadsDir() + '/');
  /** Imports accept an uploaded temp file; it is always removed afterwards, success or failure. */
  const withUpload = async <T>(path: unknown, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } finally {
      if (isUpload(path)) await unlink(path as string).catch(() => {});
    }
  };
  app.post('/uploads', async (req, reply) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new EngineError('VALIDATION', 'Send the file bytes as application/octet-stream');
    const name = basename(decodeURIComponent(String(req.headers['x-filename'] ?? 'upload.bin'))).replace(/[^\w.-]+/g, '_').slice(-80) || 'upload.bin';
    const ext = extname(name).toLowerCase();
    if (![...IMAGE_EXT, ...VIDEO_EXT, ...AUDIO_EXT].includes(ext)) throw new EngineError('VALIDATION', `Unsupported file type "${ext || 'none'}"`);
    await mkdir(uploadsDir(), { recursive: true });
    const path = join(uploadsDir(), `${ulid()}_${name}`);
    await writeFile(path, req.body);
    return reply.status(201).send({ path, bytes: req.body.length, name });
  });

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
  // ---- notifications: derived from current state, nothing is stored or sent anywhere ----
  app.get('/notifications', async () => {
    const day = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const out: { id: string; kind: 'review' | 'revision' | 'job_failed' | 'research'; tone: 'warn' | 'bad' | 'good'; title: string; detail: string; at: string; project_id?: string; artifact_kind?: string }[] = [];
    const db = engine.db;
    const arts = db.prepare("SELECT a.id, a.project_id, a.kind, a.label, a.state, a.updated_at, p.name AS project FROM artifacts a JOIN projects p ON p.id = a.project_id WHERE a.state IN ('awaiting_review','needs_revision','rejected','failed') ORDER BY a.updated_at DESC LIMIT 40").all() as any[];
    for (const a of arts) {
      const review = a.state === 'awaiting_review';
      out.push({ id: `${review ? 'review' : 'revision'}:${a.id}:${a.state}`, kind: review ? 'review' : 'revision', tone: review ? 'warn' : 'bad', title: review ? `${a.label} is waiting for your approval` : `${a.label} needs attention`, detail: a.project, at: a.updated_at, project_id: a.project_id, artifact_kind: a.kind });
    }
    const jobs = db.prepare("SELECT j.id, j.kind, j.updated_at, p.name AS project, j.project_id FROM jobs j JOIN projects p ON p.id = j.project_id WHERE j.state = 'failed' AND j.updated_at > ? ORDER BY j.updated_at DESC LIMIT 10").all(day) as any[];
    for (const j of jobs) out.push({ id: `job:${j.id}`, kind: 'job_failed', tone: 'bad', title: `${String(j.kind).replace(/_/g, ' ')} failed`, detail: j.project, at: j.updated_at, project_id: j.project_id });
    const batches = db.prepare("SELECT id, state, message, requested_count, focus, category, COALESCE(finished_at, created_at) AS at FROM topic_batches WHERE project_id IS NULL AND state IN ('done','partial','failed') AND COALESCE(finished_at, created_at) > ? ORDER BY id DESC LIMIT 10").all(day) as any[];
    for (const b of batches) out.push({ id: `research:${b.id}`, kind: 'research', tone: b.state === 'failed' ? 'bad' : 'good', title: b.state === 'failed' ? 'Topic research failed' : b.state === 'partial' ? 'Topic research finished with fewer topics' : 'Topic research is ready to review', detail: b.focus || b.category || 'Research Studio', at: b.at });
    return out.sort((x, y) => (x.at < y.at ? 1 : -1)).slice(0, 30);
  });

  // ---- topic research ----
  app.get('/research/status', async () => studio.research.status());
  app.get('/projects/:id/research/topics', async (req) => studio.research.list((req.params as { id: string }).id));
  app.post('/projects/:id/research/prompt', async (req) => ({ prompt: studio.research.prompt((req.params as { id: string }).id, { count: body(req).count, focus: body(req).focus, notes: body(req).notes }) }));
  app.post('/projects/:id/research/batches', async (req, reply) => reply.status(202).send(studio.research.startBatch((req.params as { id: string }).id, { count: body(req).count, focus: body(req).focus, notes: body(req).notes })));
  app.post('/projects/:id/research/import', async (req, reply) => reply.status(201).send(await studio.research.importText((req.params as { id: string }).id, body(req).text, { focus: body(req).focus })));
  // Research Studio: research without a project
  app.get('/studio/research', async () => studio.research.list(null));
  app.post('/studio/research/prompt', async (req) => ({ prompt: studio.research.prompt(null, { count: body(req).count, focus: body(req).focus, notes: body(req).notes, category: body(req).category }) }));
  app.post('/studio/research/batches', async (req, reply) => reply.status(202).send(studio.research.startStudioBatch({ count: body(req).count, focus: body(req).focus, notes: body(req).notes, category: body(req).category })));
  app.post('/studio/research/batches/:id/cancel', async (req) => studio.research.cancelStudioBatch((req.params as { id: string }).id));
  app.post('/studio/research/import', async (req, reply) => reply.status(201).send(await studio.research.importText(null, body(req).text, { focus: body(req).focus, category: body(req).category })));
  app.post('/topic-ideas/:id/approve', async (req) => studio.research.approveIdea((req.params as { id: string }).id));
  app.post('/topic-ideas/:id/dismiss', async (req) => studio.research.setStatus((req.params as { id: string }).id, 'dismissed'));
  app.post('/topic-ideas/:id/restore', async (req) => studio.research.setStatus((req.params as { id: string }).id, 'new'));
  app.post('/topic-ideas/:id/use', async (req) => studio.research.useIdea((req.params as { id: string }).id, { reopen: body(req).reopen === true }));
  app.post('/topic-ideas/:id/new-project', async (req, reply) => reply.status(201).send(studio.research.projectFromIdea((req.params as { id: string }).id, { languages: Array.isArray(body(req).languages) ? (body(req).languages as string[]) : undefined, formats: Array.isArray(body(req).formats) ? (body(req).formats as string[]) : undefined })));
  app.get('/projects/:id/deletion-preview', async (req) => studio.deletionPreview((req.params as { id: string }).id));
  app.post('/projects/:id/delete', async (req) => studio.deleteProject((req.params as { id: string }).id, body(req).confirm_name));
  app.patch('/projects/:id', async (req) => {
    const b = body(req);
    return engine.updateProject((req.params as { id: string }).id, { name: b.name, category: b.category });
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
    studio.approve((req.params as { id: string }).id, body(req).note);
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
  app.post('/projects/:id/formats', async (req, reply) => {
    const { id } = req.params as { id: string };
    addFormat(engine, id, String(body(req).format ?? ''));
    return reply.status(201).send(engine.getProject(id));
  });
  app.delete('/projects/:id/formats/:format', async (req) => {
    const { id, format } = req.params as { id: string; format: string };
    removeFormat(engine, id, format);
    return engine.getProject(id);
  });
  // ---- script writing: draft only; the person reviews and approves ----
  app.post('/artifacts/:id/script/generate', async (req) => studio.writer.generate((req.params as { id: string }).id, { seconds: body(req).seconds, scenes: body(req).scenes, notes: body(req).notes as string | undefined, reopen: body(req).reopen === true }));
  app.post('/artifacts/:id/script/prompt', async (req) => ({ prompt: studio.writer.prompt((req.params as { id: string }).id, { seconds: body(req).seconds, scenes: body(req).scenes, notes: body(req).notes as string | undefined }) }));
  app.post('/artifacts/:id/script/import', async (req) => studio.writer.importText((req.params as { id: string }).id, { text: body(req).text, seconds: body(req).seconds, scenes: body(req).scenes, reopen: body(req).reopen === true }));
  // ---- storyboard sketch pictures: drawn as a background job, approved by the person in Visuals ----
  app.get('/artifacts/:id/sketches', async (req) => studio.sketches.list((req.params as { id: string }).id));
  app.post('/artifacts/:id/sketches', async (req, reply) => reply.status(202).send(studio.sketches.start((req.params as { id: string }).id, { indexes: body(req).indexes, reopen: body(req).reopen === true })));
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
  app.get('/categories', async () => {
    // the six built-in topics, then any custom category already used by a project, so a custom one is not lost after it is typed once
    const base = listCategories();
    const known = new Set(base.map((c) => c.name.toLowerCase()));
    const rows = studio.engine.db.prepare("SELECT DISTINCT category FROM projects WHERE category IS NOT NULL AND TRIM(category) != '' ORDER BY category").all() as { category: string }[];
    const custom = rows.filter((r) => !known.has(r.category.toLowerCase())).map((r) => ({ name: r.category, profile: profileFor(r.category), custom: true }));
    return [...base, ...custom];
  });
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

  // ---- providers ----
  app.get('/providers', async () => assets.providers.list().map((p) => ({ id: p.id, kind: p.kind, name: p.name, terms: p.terms })));
  app.post('/providers/:id/health', async (req) => assets.providers.get((req.params as { id: string }).id).healthCheck());
  app.get('/providers/:id/search', async (req) => {
    const q = req.query as { q?: string; page?: string; restricted?: string };
    return assets.providers.stock((req.params as { id: string }).id).search({ query: q.q ?? '', page: Number(q.page ?? 1), includeRestricted: q.restricted === 'true' });
  });

  // ---- assets ----
  app.post('/projects/:id/assets/import', async (req, reply) => {
    const b = body(req);
    if (typeof b.path !== 'string') throw new EngineError('VALIDATION', 'path is required');
    const a = await withUpload(b.path, () => assets.importLocal((req.params as { id: string }).id, b.path, { type: b.type, name: b.name, license: b.license, prompt: b.prompt, provider: typeof b.provider === 'string' ? b.provider : undefined, params: b.params, tags: b.tags }));
    return reply.status(201).send(a);
  });
  app.post('/projects/:id/assets/import-remote', async (req, reply) => {
    const b = body(req);
    return reply.status(201).send(await assets.importRemote((req.params as { id: string }).id, String(b.provider ?? ''), String(b.result_id ?? ''), b.type));
  });
  app.post('/projects/:id/assets/reuse', async (req, reply) => reply.status(201).send(await assets.reuse(String(body(req).asset_id ?? ''), (req.params as { id: string }).id)));
  app.get('/projects/:id/assets', async (req) => {
    const q = req.query as { type?: string; status?: string };
    return assets.list({ projectId: (req.params as { id: string }).id, type: q.type, status: q.status });
  });
  // every asset across all projects and the shared library, for the Asset Library page
  app.get('/assets', async (req) => {
    const q = req.query as { type?: string; status?: string };
    const names = new Map(engine.listProjects().map((p) => [p.id, p.name]));
    return assets.list({ type: q.type, status: q.status }).map((a) => ({ ...a, project_name: a.project_id ? (names.get(a.project_id) ?? null) : null }));
  });
  app.get('/library', async (req) => assets.list({ shared: true, type: (req.query as { type?: string }).type }));
  app.get('/assets/:id', async (req) => {
    const a = assets.get((req.params as { id: string }).id);
    return { ...a, used_by: assets.usage(a).map((u) => ({ id: u.id, label: u.label, state: u.state })) };
  });
  app.patch('/assets/:id', async (req) => {
    const b = body(req);
    return assets.update((req.params as { id: string }).id, { name: b.name, type: b.type, focal: b.focal, license: b.license, tags: b.tags, prompt: b.prompt }, { reopen: b.reopen === true });
  });
  app.post('/assets/:id/approve', async (req) => assets.approve((req.params as { id: string }).id));
  app.post('/assets/:id/reject', async (req) => assets.reject((req.params as { id: string }).id));
  app.post('/assets/:id/promote', async (req, reply) => reply.status(201).send(await assets.promote((req.params as { id: string }).id)));
  app.delete('/assets/:id', async (req) => {
    await assets.remove((req.params as { id: string }).id);
    return { ok: true };
  });
  app.get('/assets/:id/file', async (req, reply) => {
    const a = assets.get((req.params as { id: string }).id);
    return reply.type(MIME[a.rel_path.slice(a.rel_path.lastIndexOf('.')).toLowerCase()] ?? 'application/octet-stream').send(createReadStream(assets.absPath(a)));
  });
  app.put('/scenes/:sceneId/assets', async (req) => {
    const b = body(req);
    return studio.setSceneAssets((req.params as { sceneId: string }).sceneId, b.assets, String(b.primary_asset_id ?? ''), { reopen: b.reopen === true });
  });
  app.get('/scenes/:sceneId/image-prompt', async (req) => studio.sceneImagePrompt((req.params as { sceneId: string }).sceneId, (req.query as { provider?: string }).provider));

  // ---- audio: voices, narration, mix ----
  app.get('/tts/providers', async () =>
    Promise.all(studio.audio.tts.list().map(async (p) => ({ id: p.id, name: p.name, languages: p.languages, terms: p.terms, status: await p.available() }))),
  );
  app.get('/tts/providers/:id/voices', async (req) => studio.audio.tts.get((req.params as { id: string }).id).voices());
  app.post('/artifacts/:id/narration/synthesize', async (req) => {
    const b = body(req);
    return studio.synthesizeNarration((req.params as { id: string }).id, { voice: b.voice, sectionIds: b.section_ids, reopen: b.reopen === true });
  });
  app.post('/artifacts/:id/narration/import', async (req) => {
    const b = body(req);
    if (typeof b.path !== 'string') throw new EngineError('VALIDATION', 'path is required');
    return withUpload(b.path, () => studio.importNarration((req.params as { id: string }).id, { path: b.path, sectionIds: b.section_ids, name: b.name, license: b.license, reopen: b.reopen === true }));
  });
  app.put('/artifacts/:id/mix', async (req) => studio.setMix((req.params as { id: string }).id, body(req).mix, { reopen: body(req).reopen === true }));
  app.post('/projects/:id/audio/import', async (req, reply) => {
    const b = body(req);
    if (typeof b.path !== 'string') throw new EngineError('VALIDATION', 'path is required');
    return reply.status(201).send(await withUpload(b.path, () => studio.audio.importClip((req.params as { id: string }).id, b.path, { kind: b.kind, lang: b.lang, name: b.name, license: b.license, provider: typeof b.provider === 'string' ? b.provider : undefined })));
  });
  app.get('/projects/:id/audio', async (req) => {
    const q = req.query as { kind?: string; lang?: string };
    return studio.audio.list((req.params as { id: string }).id, q);
  });
  app.get('/audio/:id/peaks', async (req) => studio.audio.peaks((req.params as { id: string }).id, Number((req.query as { buckets?: string }).buckets ?? 200)));
  app.get('/audio/:id/file', async (req, reply) => {
    const c = studio.audio.get((req.params as { id: string }).id);
    const ext = c.rel_path.slice(c.rel_path.lastIndexOf('.')).toLowerCase();
    return reply.type({ '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.ogg': 'audio/ogg' }[ext] ?? 'application/octet-stream').send(createReadStream(studio.audio.absPath(c)));
  });
  app.delete('/audio/:id', async (req) => {
    await studio.audio.remove((req.params as { id: string }).id);
    return { ok: true };
  });

  // ---- captions ----
  app.get('/alignment/whisper', async () => studio.whisperStatus());
  app.post('/artifacts/:id/captions/align', async (req) => {
    const b = body(req);
    return studio.alignCaptions((req.params as { id: string }).id, { method: b.method, reopen: b.reopen === true });
  });
  app.post('/artifacts/:id/captions/export', async (req) => studio.exportSubtitles((req.params as { id: string }).id));
  app.get('/fonts', async () => studio.render.listFonts());

  // ---- composition and rendering ----
  app.get('/artifacts/:id/timeline-status', async (req) => {
    const id = (req.params as { id: string }).id;
    const content = studio.engine.getContent(id) as { version?: number; duration?: number; scenes?: unknown[]; captions?: { enabled?: boolean }; format?: unknown } | null;
    const has = !!content && content.version === 1;
    return { has_timeline: has, stale: has ? studio.render.isStale(id) : true, duration: has ? content!.duration : null, scenes: has ? content!.scenes?.length : 0, captions: has ? !!content!.captions?.enabled : false };
  });
  app.post('/artifacts/:id/build-timeline', async (req) => studio.buildComposition((req.params as { id: string }).id, { reopen: body(req).reopen === true, effects: typeof body(req).effects === 'string' ? (body(req).effects as string) : undefined }));
  app.put('/artifacts/:id/scenes/:sceneId/override', async (req) => {
    const { id, sceneId } = req.params as { id: string; sceneId: string };
    const b = body(req);
    return studio.setSceneOverride(id, sceneId, { crop: b.crop, caption_y_pct: b.caption_y_pct }, { reopen: b.reopen === true });
  });
  app.get('/artifacts/:id/preview-frame', async (req, reply) => {
    const q = req.query as { t?: string; captions?: string };
    return reply.type('image/png').send(await studio.render.previewFrame((req.params as { id: string }).id, Number(q.t ?? 0), q.captions !== 'false'));
  });
  app.post('/artifacts/:id/render', async (req, reply) => {
    const b = body(req);
    const variants = Array.isArray(b.variants) && b.variants.length ? b.variants : ['captioned', 'clean'];
    return reply.status(201).send(await studio.renderComposition((req.params as { id: string }).id, variants, { reopen: b.reopen === true }));
  });
  app.get('/projects/:id/renders', async (req) => studio.render.listRenders((req.params as { id: string }).id, req.query as { lang?: string; format?: string }));
  // every finished video across all projects, newest first, for the Asset Library
  app.get('/renders', async () => {
    const names = new Map(engine.listProjects().map((p) => [p.id, p.name]));
    return engine.listProjects().flatMap((p) => studio.render.listRenders(p.id)).map((r) => ({ ...r, project_name: names.get(r.project_id) ?? null })).sort((a, b) => (a.id < b.id ? 1 : -1));
  });
  app.get('/renders/:id/file', async (req, reply) => {
    const r = studio.render.getRender((req.params as { id: string }).id);
    return reply.type('video/mp4').send(createReadStream(join(studio.config.root, r.rel_path)));
  });

  // ---- publishing ----
  app.get('/projects/:id/license-manifest', async (req) => {
    const m = studio.publish.licenseManifest((req.params as { id: string }).id);
    return { ...m, credits_text: studio.publish.creditsText(m) };
  });
  app.get('/projects/:id/kit/:lang', async (req) => {
    const { id, lang } = req.params as { id: string; lang: string };
    const k = studio.publish.getKit(id, lang);
    if (!k) throw new EngineError('NOT_FOUND', 'No kit yet; generate one first');
    return k;
  });
  app.post('/projects/:id/kit/:lang/generate', async (req, reply) => {
    const { id, lang } = req.params as { id: string; lang: string };
    return reply.status(201).send(await studio.publish.generateKit(id, lang));
  });
  app.put('/projects/:id/kit/:lang', async (req) => {
    const { id, lang } = req.params as { id: string; lang: string };
    return studio.publish.saveKit(id, lang, body(req).content);
  });
  app.get('/projects/:id/kit/:lang/prompt', async (req) => {
    const { id, lang } = req.params as { id: string; lang: string };
    return { prompt: studio.publish.kitPrompt(id, lang) };
  });
  app.post('/projects/:id/thumbnails', async (req, reply) => {
    const b = body(req);
    return reply.status(201).send(await studio.publish.createThumbnail((req.params as { id: string }).id, { lang: String(b.lang ?? ''), sceneId: b.scene_id, assetId: b.asset_id, text: b.text, size: b.size }));
  });
  app.get('/projects/:id/thumbnails', async (req) => studio.publish.listThumbnails((req.params as { id: string }).id, (req.query as { lang?: string }).lang));
  app.get('/thumbnails/:id/file', async (req, reply) => {
    const t = studio.engine.db.prepare('SELECT rel_path FROM thumbnails WHERE id = ?').get((req.params as { id: string }).id) as { rel_path: string } | undefined;
    if (!t) throw new EngineError('NOT_FOUND', 'Thumbnail not found');
    return reply.type('image/jpeg').send(createReadStream(join(studio.config.root, t.rel_path)));
  });
  app.post('/projects/:id/export', async (req, reply) => {
    const b = body(req);
    return reply.status(201).send(await studio.publish.exportPackage((req.params as { id: string }).id, { langs: b.langs, variants: b.variants, archive: b.archive === true }));
  });
  app.post('/projects/:id/archive', async (req, reply) => reply.status(201).send(await studio.archive.create((req.params as { id: string }).id, typeof body(req).path === 'string' ? body(req).path : undefined)));
  app.post('/archive/restore', async (req, reply) => {
    const b = body(req);
    if (typeof b.path !== 'string') throw new EngineError('VALIDATION', 'path is required');
    return reply.status(201).send(await studio.archive.restore(b.path, { asCopy: b.as_copy === true }));
  });

  // ---- operations: preflight, jobs, cache ----
  app.get('/preflight', async () => studio.preflight());
  app.get('/jobs', async (req) => {
    const q = req.query as { project_id?: string; state?: string };
    return studio.jobs.list(q.project_id, q.state);
  });
  app.post('/jobs', async (req, reply) => {
    const b = body(req);
    if (typeof b.project_id !== 'string' || typeof b.kind !== 'string') throw new EngineError('VALIDATION', 'project_id and kind are required');
    return reply.status(202).send(studio.jobs.enqueue(b.kind, { projectId: b.project_id, artifactId: b.artifact_id, params: b.params }));
  });
  app.get('/jobs/:id', async (req) => studio.jobs.get((req.params as { id: string }).id));
  app.post('/jobs/:id/cancel', async (req) => studio.jobs.cancel((req.params as { id: string }).id));
  app.post('/jobs/:id/retry', async (req, reply) => reply.status(202).send(studio.jobs.retry((req.params as { id: string }).id)));
  app.get('/cache', async () => studio.cache.stats());
  app.post('/cache/prune', async (req) => {
    const b = body(req);
    return studio.cache.prune({ olderThanDays: b.older_than_days, maxBytes: b.max_bytes });
  });

  // ---- templates and motion clips ----
  app.get('/templates', async (req) => studio.templates.list((req.query as { kind?: string }).kind));
  app.post('/templates', async (req, reply) => {
    const b = body(req);
    return reply.status(201).send(studio.templates.create(String(b.kind ?? ''), String(b.name ?? ''), b.content));
  });
  app.delete('/templates/:id', async (req) => {
    studio.templates.remove((req.params as { id: string }).id);
    return { ok: true };
  });
  app.post('/artifacts/:id/apply-caption-style', async (req) => studio.applyCaptionStyle((req.params as { id: string }).id, String(body(req).template_id ?? ''), { reopen: body(req).reopen === true }));
  app.post('/artifacts/:id/apply-script-outline', async (req) => {
    const b = body(req);
    return studio.applyScriptOutline((req.params as { id: string }).id, String(b.template_id ?? ''), { title: String(b.title ?? 'Untitled'), lang: String(b.lang ?? 'en'), preset: String(b.preset ?? 'short_lt30') });
  });
  app.get('/providers/image-to-video', async () =>
    Promise.all(I2V_PROVIDERS.map(async (p) => ({ id: p.id, name: p.name, requirements: p.requirements, terms: p.terms, status: await p.available() }))),
  );
  app.post('/projects/:id/assets/motion-clip', async (req, reply) => {
    const b = body(req);
    return reply.status(201).send(await studio.assets.makeMotionClip((req.params as { id: string }).id, String(b.asset_id ?? ''), { motionPrompt: String(b.motion_prompt ?? ''), seconds: Number(b.seconds), width: b.width, height: b.height, fps: b.fps, name: b.name, provider: b.provider }));
  });

  return app;
}
