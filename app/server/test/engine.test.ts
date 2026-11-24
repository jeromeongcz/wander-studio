import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { Engine, EngineError } from '../src/engine.ts';
import type { Artifact } from '../src/engine.ts';
import { createProject, addScene } from '../src/pipeline.ts';
import { ulid, STATES } from '../../shared/src/index.ts';

const LANGS = ['en', 'tl', 'taglish'];
const FORMATS = ['vertical_9x16', 'horizontal_16x9', 'square_1x1'];

function setup() {
  const engine = new Engine(openDb());
  const projectId = createProject(engine, { name: 'T', languages: LANGS, formats: FORMATS });
  const s1 = addScene(engine, projectId, 'one');
  const s2 = addScene(engine, projectId, 'two');
  return { engine, projectId, s1, s2 };
}

/** Walk the graph in dependency order doing save -> submit -> user approve. */
function approveAll(engine: Engine, projectId: string) {
  const pending = engine.list(projectId);
  let guard = 0;
  while (pending.length && guard++ < 1000) {
    const a = pending.shift()!;
    const unmet = engine.upstreamDirect(a.id).some((u) => engine.get(u.id).state !== 'approved');
    if (unmet) {
      pending.push(a);
      continue;
    }
    engine.saveVersion(a.id, { label: a.label, v: 1 }, { actor: 'user' });
    engine.submitForReview(a.id);
    engine.approve(a.id, { actor: 'user' });
  }
  assert.equal(pending.length, 0, 'every artifact approved');
}

const stateMap = (engine: Engine, projectId: string) => new Map(engine.list(projectId).map((a) => [a.id, a.state] as const));
const labels = (engine: Engine, ids: string[]) => ids.map((i) => engine.get(i).label).sort();

function changedSince(engine: Engine, projectId: string, before: Map<string, string>): Artifact[] {
  return engine.list(projectId).filter((a) => before.get(a.id) !== a.state);
}

test('ULIDs are unique, 26 chars and sortable', () => {
  const ids = Array.from({ length: 2000 }, () => ulid());
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((i) => i.length === 26));
  assert.deepEqual([...ids].sort(), ids);
});

test('pipeline builds the expected graph, all not_started', () => {
  const { engine, projectId } = setup();
  const all = engine.list(projectId);
  // 3 fixed + 3 langs*(4 + 3 formats*2) + 2 scene assets
  assert.equal(all.length, 3 + 3 * (4 + 6) + 2);
  assert.ok(all.every((a) => a.state === 'not_started'));
  assert.ok(all.every((a) => STATES.includes(a.state)));
});

test('only the user can approve; AI/system actors are refused', () => {
  const { engine, projectId } = setup();
  const [research] = engine.list(projectId, { kind: 'research' });
  engine.saveVersion(research.id, { notes: 'x' });
  engine.submitForReview(research.id);
  for (const actor of ['ai', 'system'] as const) {
    assert.throws(() => engine.approve(research.id, { actor }), (e: EngineError) => e.code === 'USER_ONLY');
    assert.throws(() => engine.reject(research.id, { actor }), (e: EngineError) => e.code === 'USER_ONLY');
  }
  assert.equal(engine.get(research.id).state, 'awaiting_review');
  engine.approve(research.id, { actor: 'user' });
  assert.equal(engine.get(research.id).state, 'approved');
});

test('cannot approve while an upstream dependency is unapproved', () => {
  const { engine, projectId } = setup();
  const [base] = engine.list(projectId, { kind: 'script_base' });
  engine.saveVersion(base.id, { text: 'hi' });
  engine.submitForReview(base.id);
  assert.throws(() => engine.approve(base.id, { actor: 'user' }), (e: EngineError) => e.code === 'UNMET_DEPENDENCY');
});

test('invalid transitions are rejected', () => {
  const { engine, projectId } = setup();
  const [research] = engine.list(projectId, { kind: 'research' });
  assert.throws(() => engine.submitForReview(research.id), (e: EngineError) => e.code === 'NO_VERSION');
  engine.saveVersion(research.id, { a: 1 });
  assert.throws(() => engine.approve(research.id, { actor: 'user' }), (e: EngineError) => e.code === 'BAD_TRANSITION');
});

test('visual change: only compositions and renders go needs_revision; everything else stays approved', () => {
  const { engine, projectId, s1 } = setup();
  approveAll(engine, projectId);
  const before = stateMap(engine, projectId);
  const r = engine.saveVersion(s1.assetArtifactId, { img: 'new.png' }, { reopen: true });
  assert.ok(r.changed);
  const changed = changedSince(engine, projectId, before);
  const kinds = new Set(changed.map((a) => a.kind));
  // the edited asset itself is in_progress, downstream is needs_revision
  assert.deepEqual([...kinds].sort(), ['composition', 'final_render', 'scene_asset']);
  assert.equal(engine.get(s1.assetArtifactId).state, 'in_progress');
  assert.equal(changed.filter((a) => a.kind === 'composition').length, 9);
  assert.equal(changed.filter((a) => a.kind === 'final_render').length, 9);
  for (const k of ['research', 'script_base', 'script_lang', 'storyboard', 'audio', 'caption', 'subtitle_export'] as const) {
    assert.ok(engine.list(projectId, { kind: k }).every((a) => a.state === 'approved'), `${k} still approved`);
  }
});

test('narration change (Tagalog): only Tagalog audio/captions/exports/compositions/renders invalidated', () => {
  const { engine, projectId } = setup();
  approveAll(engine, projectId);
  const before = stateMap(engine, projectId);
  const [tlAudio] = engine.list(projectId, { kind: 'audio', lang_code: 'tl' });
  engine.saveVersion(tlAudio.id, { file: 'tl2.wav' }, { reopen: true });
  const changed = changedSince(engine, projectId, before);
  assert.ok(changed.every((a) => a.lang_code === 'tl'), 'only tl artifacts changed');
  assert.deepEqual(
    [...new Set(changed.map((a) => a.kind))].sort(),
    ['audio', 'caption', 'composition', 'final_render', 'subtitle_export'],
  );
  for (const l of ['en', 'taglish']) {
    assert.ok(engine.list(projectId).filter((a) => a.lang_code === l).every((a) => a.state === 'approved'));
  }
  // script (tl) itself untouched
  assert.equal(engine.list(projectId, { kind: 'script_lang', lang_code: 'tl' })[0].state, 'approved');
});

test('caption edit: captions/exports/compositions/renders for that language only; audio and visuals stay approved', () => {
  const { engine, projectId } = setup();
  approveAll(engine, projectId);
  const before = stateMap(engine, projectId);
  const [cap] = engine.list(projectId, { kind: 'caption', lang_code: 'taglish' });
  engine.saveVersion(cap.id, { lines: ['changed'] }, { reopen: true });
  const changed = changedSince(engine, projectId, before);
  assert.ok(changed.every((a) => a.lang_code === 'taglish'));
  assert.deepEqual([...new Set(changed.map((a) => a.kind))].sort(), ['caption', 'composition', 'final_render', 'subtitle_export']);
  assert.equal(engine.list(projectId, { kind: 'audio', lang_code: 'taglish' })[0].state, 'approved');
  assert.ok(engine.list(projectId, { kind: 'scene_asset' }).every((a) => a.state === 'approved'));
});

test('approved work is protected from silent overwrite', () => {
  const { engine, projectId } = setup();
  approveAll(engine, projectId);
  const [research] = engine.list(projectId, { kind: 'research' });
  assert.throws(() => engine.saveVersion(research.id, { notes: 'sneaky' }), (e: EngineError) => e.code === 'PROTECTED');
  assert.equal(engine.get(research.id).state, 'approved');
  assert.equal(engine.versions(research.id).length, 1);
  // and nothing downstream was invalidated by the refused write
  assert.ok(engine.list(projectId).every((a) => a.state === 'approved'));
});

test('unchanged content is a no-op and does not invalidate downstream', () => {
  const { engine, projectId } = setup();
  approveAll(engine, projectId);
  const [research] = engine.list(projectId, { kind: 'research' });
  const r = engine.saveVersion(research.id, { label: 'Research', v: 1 }, { reopen: true });
  assert.equal(r.changed, false);
  assert.ok(engine.list(projectId).every((a) => a.state === 'approved'));
});

test('re-approval flow after invalidation, and non-destructive version history/restore', () => {
  const { engine, projectId } = setup();
  approveAll(engine, projectId);
  const [script] = engine.list(projectId, { kind: 'script_lang', lang_code: 'en' });
  const v1 = engine.versions(script.id)[0];
  engine.saveVersion(script.id, { label: 'Script (en)', v: 2 }, { reopen: true });
  const [audio] = engine.list(projectId, { kind: 'audio', lang_code: 'en' });
  assert.equal(engine.get(audio.id).state, 'needs_revision');
  // cannot approve audio until the script is re-approved
  engine.startWork(audio.id);
  engine.saveVersion(audio.id, { file: 'again.wav' });
  engine.submitForReview(audio.id);
  assert.throws(() => engine.approve(audio.id, { actor: 'user' }), (e: EngineError) => e.code === 'UNMET_DEPENDENCY');
  engine.submitForReview(script.id);
  engine.approve(script.id, { actor: 'user' });
  engine.approve(audio.id, { actor: 'user' });
  // history keeps both versions; restore creates a new version rather than deleting
  assert.equal(engine.versions(script.id).length, 2);
  engine.restoreVersion(script.id, v1.id);
  const vs = engine.versions(script.id);
  assert.equal(vs.length, 3);
  assert.equal(vs[2].content_json, v1.content_json);
  assert.ok(vs[0].approved_at, 'original approved version preserved');
});

test('dependency cycles are rejected', () => {
  const { engine, projectId } = setup();
  const [research] = engine.list(projectId, { kind: 'research' });
  const [render] = engine.list(projectId, { kind: 'final_render', lang_code: 'en', format: 'square_1x1' });
  assert.throws(() => engine.addDependency(research.id, render.id), (e: EngineError) => e.code === 'CYCLE');
  assert.throws(() => engine.addDependency(research.id, research.id), (e: EngineError) => e.code === 'CYCLE');
});

test('failure isolation: failing a job touches only that artifact', () => {
  const { engine, projectId } = setup();
  approveAll(engine, projectId);
  const [tlAudio] = engine.list(projectId, { kind: 'audio', lang_code: 'tl' });
  engine.saveVersion(tlAudio.id, { file: 'x' }, { reopen: true });
  const before = stateMap(engine, projectId);
  engine.fail(tlAudio.id, 'TTS provider offline');
  assert.equal(engine.get(tlAudio.id).state, 'failed');
  assert.equal(engine.get(tlAudio.id).last_error, 'TTS provider offline');
  const changed = changedSince(engine, projectId, before);
  assert.deepEqual(changed.map((a) => a.id), [tlAudio.id]);
});

test('adding a scene after approval invalidates compositions only', () => {
  const { engine, projectId } = setup();
  approveAll(engine, projectId);
  addScene(engine, projectId, 'late');
  assert.ok(engine.list(projectId, { kind: 'composition' }).every((a) => a.state !== 'approved'));
  assert.ok(engine.list(projectId, { kind: 'script_lang' }).every((a) => a.state === 'approved'));
});

test('state persists across reopening a file database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wander-'));
  try {
    const path = join(dir, 'wander.db');
    const e1 = new Engine(openDb(path));
    const p = createProject(e1, { name: 'P', languages: ['en'], formats: ['vertical_9x16'] });
    const [r] = e1.list(p, { kind: 'research' });
    e1.saveVersion(r.id, { n: 1 });
    e1.db.close();
    const e2 = new Engine(openDb(path));
    assert.equal(e2.get(r.id).state, 'in_progress');
    assert.equal(e2.versions(r.id).length, 1);
    e2.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('content with undefined fields is stored as valid JSON and hashes like its defined-only twin', () => {
  const { engine, projectId } = setup();
  const [research] = engine.list(projectId, { kind: 'research' });
  engine.saveVersion(research.id, { a: 1, b: undefined });
  assert.deepEqual(engine.getContent(research.id), { a: 1 });
  assert.equal(engine.saveVersion(research.id, { a: 1 }).changed, false);
});
