import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { buildApi } from '../src/api.ts';
import { DEFAULT_CINEMATIC, directionPrompt, validateCinematic } from '../src/studios/direction.ts';
import { buildScriptPrompt, parseScriptAnswer } from '../src/research/scriptwriter.ts';
import { draftScenes, validateStoryboardShape } from '../src/studios/storyboard.ts';
import { validateScriptShape } from '../src/studios/script.ts';
import { buildSketchPrompt } from '../src/research/sketch.ts';
import { newResearchContent } from '../src/studios/research.ts';

const brief = { topic: 'The moon serpent', facts: [], lang: 'en', langName: 'English', seconds: 20, scenes: 4, words: 40, formats: ['vertical_9x16'] };
const chosen = validateCinematic({ camera: 'suspenseful', style: 'folklore', transition: 'smooth', custom_text: 'Wide shots to establish places.' });

const section = (text: string, cinematic?: object) => ({ kind: 'main', text, visual: { setting: 'a shore', action: 'waves' }, ...(cinematic ? { cinematic } : {}) });
const answer = JSON.stringify({
  title: 'Serpent', visual_style: 'dark_folklore', characters: [],
  sections: [
    section('The moon rose over the sea.', { camera: { movement: 'slow_reveal', direction: 'up', intensity: 'medium' }, transition: { type: 'fade' }, look: { lighting: 'moonlight', effects: { fog: 0.4 } } }),
    section('Something moved below.', { camera: { movement: 'teleport' }, transition: { type: 'dissolve', duration: 99, intensity: 'strong' }, look: { atmosphere: 'uneasy', effects: { smoke: 0.5, grain: 9, brightness: 0.1 } } }),
    section('The village beat their drums.', { camera: { movement: 'handheld', rotation: 90, easing: 'ease_in' }, transition: { type: 'cut', sound: 'impact', direction: 'left' } }),
    section('The moon returned.'),
  ],
});

test('choices are validated; the defaults are automatic', () => {
  assert.deepEqual(validateCinematic(undefined), DEFAULT_CINEMATIC);
  for (const wrong of [{ camera: 'wild' }, { style: 'noir' }, { transition: 'x' }, { custom_text: 'a'.repeat(601) }]) assert.throws(() => validateCinematic(wrong));
});

test('the writer receives the chosen directions and the custom text', () => {
  const p = buildScriptPrompt({ ...brief, cinematic: chosen });
  for (const part of ['Camera: Suspenseful', 'Visual style: Folklore', 'Transitions: Cinematic smooth', 'Wide shots to establish places.', 'Philippine folklore', 'never narrated or captioned', '"cinematic"']) assert.ok(p.includes(part), part);
  assert.ok(!p.includes('"visual_style"'), 'a chosen style is not up to the writer');
  const auto = buildScriptPrompt(brief);
  assert.ok(auto.includes('"visual_style"') && auto.includes('choose ONE'));
  assert.ok(!directionPrompt(DEFAULT_CINEMATIC).join('\n').includes('Custom direction from'));
});

test('instructions are structured, checked, and kept out of the narration; unusable ones are listed, not guessed', () => {
  const dropped: string[] = [];
  const c = parseScriptAnswer(answer, { title: 't', lang: 'en', seconds: 20, cinematic: chosen }, dropped);
  assert.doesNotThrow(() => validateScriptShape(c));
  assert.deepEqual(c.sections[0].cinematic, { camera: { movement: 'slow_reveal', direction: 'up', intensity: 'medium' }, look: { lighting: 'moonlight', params: { fog: 0.4 }, style: 'folklore' } }, 'the first scene has no incoming transition; the person’s style wins');
  assert.equal(c.sections[1].cinematic!.camera, undefined);
  assert.deepEqual(c.sections[1].cinematic!.transition, { type: 'dissolve', intensity: 'strong' });
  assert.deepEqual(c.sections[1].cinematic!.look, { atmosphere: 'uneasy', style: 'folklore' });
  assert.deepEqual(c.sections[2].cinematic!.camera, { movement: 'handheld', easing: 'ease_in' });
  assert.deepEqual(c.sections[2].cinematic!.transition, { type: 'cut', sound: 'impact' });
  assert.equal(c.sections[3].cinematic, undefined);
  for (const part of ['teleport', 'duration', 'smoke', 'grain', 'brightness', 'rotation', 'direction']) assert.ok(dropped.some((d) => d.includes(part)), `${part} reported: ${dropped.join(' / ')}`);
  assert.deepEqual(c.sections.map((s) => s.text), ['The moon rose over the sea.', 'Something moved below.', 'The village beat their drums.', 'The moon returned.']);
  assert.deepEqual(c.cinematic_direction, chosen);
  // automatic style: the writer's one choice applies to every directed scene
  assert.equal(parseScriptAnswer(answer, { title: 't', lang: 'en', seconds: 20, cinematic: DEFAULT_CINEMATIC }).sections[0].cinematic!.look!.style, 'dark_folklore');
});

test('the draft storyboard copies the instructions and marks them as generated', () => {
  const base = parseScriptAnswer(answer, { title: 't', lang: 'en', seconds: 20, cinematic: chosen });
  const sb = draftScenes(base, 'Mythology and Folklore', { samples: [] });
  assert.doesNotThrow(() => validateStoryboardShape(sb));
  assert.equal(sb.scenes[0].camera.movement, 'slow_reveal');
  assert.deepEqual(sb.scenes[0].origin, { camera: 'ai', look: 'ai' });
  assert.deepEqual([sb.scenes[1].transition_in, sb.scenes[1].transition_settings], ['dissolve', { intensity: 'strong' }]);
  assert.deepEqual([sb.scenes[2].transition_in, sb.scenes[2].transition_settings], ['cut', { sound: 'impact' }]);
  // gaps are filled from the chosen direction, without repeating a movement back to back
  assert.ok(['slow_reveal', 'tracking', 'static', 'dramatic_push_in', 'handheld'].includes(sb.scenes[1].camera.movement));
  assert.ok(sb.scenes.every((s, i) => !i || s.camera.movement !== sb.scenes[i - 1].camera.movement));
  assert.ok(buildSketchPrompt(sb.scenes[0], { size: { w: 1080, h: 1920 }, number: 1, total: 4 }).includes('Lighting: moonlight'));
});

test('a script without Cinematic Direction drafts exactly as before', () => {
  const plain = { title: 't', lang: 'en', preset: 'short_lt30' as const, sections: [{ id: 'a', kind: 'hook' as const, text: 'Hello there.' }, { id: 'b', kind: 'cta' as const, text: 'Follow.' }] };
  const sb = draftScenes(plain, 'Geography', { samples: [] });
  assert.ok(sb.scenes.every((s) => !s.look && !s.origin && !s.transition_settings && ['zoom', 'pan', 'ken_burns', 'static'].includes(s.camera.movement)));
  assert.ok(!buildSketchPrompt(sb.scenes[0], { size: { w: 1080, h: 1920 }, number: 1, total: 2 }).includes('Visual direction'));
});

test('saving the direction changes no approval; applying it to a storyboard keeps the person’s own settings', async () => {
  const engine = new Engine(openDb());
  const app = buildApi(engine);
  const call = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, payload: payload as any });
    return { status: r.statusCode, json: r.body ? JSON.parse(r.body) : null };
  };
  const ok = async (p: ReturnType<typeof call>) => {
    const r = await p;
    assert.ok(r.status < 300, JSON.stringify(r.json));
    return r.json;
  };
  const p = await ok(call('POST', '/projects', { name: 'Serpent', languages: ['en'], formats: ['vertical_9x16'] }));
  const art = (kind: string) => engine.list(p.id, { kind: kind as never })[0];
  const research = { ...newResearchContent('Serpent'), sources: [{ id: 's1', url: 'https://example.org' }], checklist: newResearchContent('x').checklist.map((k) => ({ ...k, done: true })) };
  await ok(call('PUT', `/artifacts/${art('research').id}/content`, { content: research }));
  await ok(call('POST', `/artifacts/${art('research').id}/submit`));
  await ok(call('POST', `/artifacts/${art('research').id}/approve`, {}));
  await ok(call('PUT', `/projects/${p.id}/cinematic`, chosen));
  assert.equal(art('research').state, 'approved');
  assert.deepEqual((await ok(call('GET', `/projects/${p.id}`))).settings.cinematic, chosen);
  assert.deepEqual((await ok(call('GET', `/projects/${p.id}`))).settings.formats, ['vertical_9x16'], 'other settings are kept');
  assert.equal((await call('PUT', `/projects/${p.id}/cinematic`, { camera: 'wild' })).status, 422);
  const asked = await ok(call('POST', `/artifacts/${art('script_base').id}/script/prompt`, { seconds: 20, scenes: 4 }));
  assert.ok(asked.prompt.includes('Camera: Suspenseful'));
  const imported = await ok(call('POST', `/artifacts/${art('script_base').id}/script/import`, { text: answer, seconds: 20, scenes: 4 }));
  assert.equal(imported.directed, 3);
  assert.ok(imported.dropped.length > 0);
  assert.equal(art('script_base').state, 'in_progress', 'generated work is never approved');
  await ok(call('POST', `/artifacts/${art('script_base').id}/submit`));
  await ok(call('POST', `/artifacts/${art('script_base').id}/approve`, {}));
  await ok(call('POST', `/artifacts/${art('storyboard').id}/seed-storyboard`, {}));
  const read = async () => (await ok(call('GET', `/artifacts/${art('storyboard').id}`))).content;
  // the person changes one camera, then something else drifts from the script
  const sb = await read();
  sb.scenes[0].camera = { movement: 'static' };
  await ok(call('PUT', `/artifacts/${art('storyboard').id}/content`, { content: sb }));
  const script = (await ok(call('GET', `/artifacts/${art('script_base').id}`))).content;
  script.sections[0].cinematic.camera = { movement: 'orbit' };
  script.sections[2].cinematic.camera = { movement: 'crane_up' };
  await ok(call('PUT', `/artifacts/${art('script_base').id}/content`, { content: script, reopen: true }));
  await ok(call('POST', `/artifacts/${art('script_base').id}/submit`));
  await ok(call('POST', `/artifacts/${art('script_base').id}/approve`, {}));
  const applied = await ok(call('POST', `/artifacts/${art('storyboard').id}/apply-directions`, {}));
  assert.equal(applied.kept, 1);
  const after = await read();
  assert.equal(after.scenes[0].camera.movement, 'static');
  assert.deepEqual([after.scenes[2].camera.movement, after.scenes[2].origin.camera], ['crane_up', 'ai']);
  assert.equal(after.scenes[0].visual_description, sb.scenes[0].visual_description);
  await ok(call('POST', `/artifacts/${art('storyboard').id}/submit`));
  await ok(call('POST', `/artifacts/${art('storyboard').id}/approve`, {}));
  // an approved storyboard is only changed after reopening it
  after.scenes[2].camera = { movement: 'tracking' };
  assert.equal((await call('PUT', `/artifacts/${art('storyboard').id}/content`, { content: after })).status, 409);
});
