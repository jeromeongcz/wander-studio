import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { buildApi } from '../src/api.ts';
import { openDb } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { LLMProviderRegistry } from '../src/providers/llm/registry.ts';
import type { TextLLMProvider } from '../src/providers/llm/types.ts';

for (const strategy of ['single-pass', 'multi-pass'] as const) {
  test(`Storyboard copies the exact provider artwork request after ${strategy} generation`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'wander-storyboard-prompt-'));
    const db = openDb();
    const engine = new Engine(db);
    const registry = new LLMProviderRegistry();
    const requests: string[] = [];
    const provider: TextLLMProvider = {
      id: 'capturing-provider', kind: 'claude', name: 'Capturing provider',
      terms: { freeTier: 'local fixture', requiresKey: false, commercialUse: '', privacy: 'no network' },
      async healthCheck() { return { ok: true, detail: 'Ready' }; },
      async generateText({ prompt, tools }) {
        assert.equal(tools, '');
        requests.push(prompt);
        if (prompt.startsWith('Wander Studio • Art direction\n')) {
          return JSON.stringify({ staging: 'Place the lantern beyond the doorframe.', layers: [{ id: 'lantern', role: 'prop' }] });
        }
        if (prompt.startsWith('Wander Studio • Layered vector artwork\n')) {
          return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080"><g id="lantern"><path d="M80 80L100 80L100 115Z" fill="#f8d997"/></g></svg>';
        }
        if (prompt.startsWith('Wander Studio • Targeted vector refinement\n')) {
          return JSON.stringify({ patches: [{ id: 'lantern', svg: '<g id="lantern"><path d="M80 80L100 80L100 115Z" fill="#edbf68"/></g>' }] });
        }
        if (prompt.startsWith('Wander Studio • Rig and motion\n')) {
          return JSON.stringify({ animation: { duration: 4, tracks: [{ target: 'lantern', property: 'rotate', pivot: [90, 80], keys: [{ time: 0, value: 0 }, { time: 4, value: 2 }] }] } });
        }
        throw new Error('Unexpected generation stage: ' + prompt.split('\n')[0]);
      },
    };
    registry.register(provider);
    registry.setActive(provider.id);
    const app = buildApi(engine, { root }, registry);
    try {
      const created = await app.inject({ method: 'POST', url: '/projects', payload: {
        name: 'Prompt fidelity fixture', languages: ['en'], category: 'History', formats: ['horizontal_16x9'],
      } });
      assert.equal(created.statusCode, 201, created.body);
      const projectId = created.json<{id: string}>().id;
      db.prepare('UPDATE projects SET settings_json = ? WHERE id = ?').run(JSON.stringify({
        ...engine.getProject(projectId).settings, reserve_caption_space: true,
        animatedSvg: { mode: 'animated', strategy, visualReview: false, reuseApproved: false },
      }), projectId);
      const storyboard = engine.list(projectId).find(a => a.kind === 'storyboard');
      assert.ok(storyboard);
      engine.saveVersion(storyboard.id, {
        style_notes: 'Sepia woodcut on warm paper',
        scenes: [{
          scene_id: 'prompt-fidelity-fixture', title: 'Lantern in Tondo', script_segment_id: 'intro',
          target_duration: 4, visual_description: 'A brass lantern hangs above a Tondo alley.',
          visual_style: 'archival sepia', asset_type: 'image', camera: { movement: 'static', intensity: 'subtle' },
          look: { lighting: 'Light cuts across the alley from the left.' },
        }],
      });
      const route = '/artifacts/' + storyboard.id;
      const still = await app.inject({ method: 'GET', url: route + '/sketches/0/prompt' });
      assert.equal(still.statusCode, 200, still.body);
      const stillPrompt = still.json<{prompt: string}>().prompt;
      assert.match(stillPrompt, /1920x1080/);
      assert.match(stillPrompt, /Sepia woodcut on warm paper/);
      assert.match(stillPrompt, /Subtitles will be laid over the bottom fifth/);

      const generation = await app.inject({
        method: 'POST', url: route + '/animated-svg/0/generate',
        payload: { consent: true, expectedProvider: provider.id, brief: 'Keep the lantern separate for a subtle swing.' },
      });
      assert.equal(generation.statusCode, 202, generation.body);
      const jobId = generation.json<{job: {id: string}}>().job.id;
      const getJob = async () => (await app.inject({ method: 'GET', url: '/jobs/' + jobId })).json<{state: string; error?: unknown}>();
      let job = await getJob();
      for (let tries = 0; tries < 100 && (job.state === 'queued' || job.state === 'running'); tries++) {
        await delay(25);
        job = await getJob();
      }
      assert.equal(job.state, 'succeeded', JSON.stringify(job));
      const artworkCues = requests.filter(prompt => prompt.startsWith('Wander Studio • Layered vector artwork\n'));
      assert.equal(artworkCues.length, 1);
      const artworkRequest = artworkCues[0];
      const requestCount = requests.length;
      const prefix = 'Wander Studio • Layered vector artwork\n' + stillPrompt + '\n\n';
      assert.equal(artworkRequest.slice(0, prefix.length), prefix);
      assert.match(artworkRequest.slice(prefix.length), /Layered artwork preparation/);
      assert.match(artworkRequest.slice(prefix.length), /subtle swing/);
      if (strategy === 'multi-pass') assert.match(artworkRequest, /Place the lantern beyond the doorframe/);
      assert.ok(requests.at(-1)!.startsWith('Wander Studio • Rig and motion\n'));

      const records = (await app.inject({ method: 'GET', url: route + '/animated-svg' }))
        .json<Array<{revision: string; hasArtworkPrompt: boolean; hasMotionPrompt: boolean; prompts?: unknown}>>();
      assert.equal(records[0].hasArtworkPrompt, true);
      assert.equal(records[0].hasMotionPrompt, true);
      assert.equal(records[0].prompts, undefined);
      const promptUrl = route + '/animated-svg/0/prompt/artwork?revision=';
      const copied = await app.inject({ method: 'GET', url: promptUrl + records[0].revision });
      assert.equal(copied.statusCode, 200, copied.body);
      assert.equal(copied.headers['cache-control'], 'no-store');
      assert.equal(copied.json<{prompt: string}>().prompt, artworkRequest);
      const motionCopy = await app.inject({ method: 'GET', url: promptUrl.replace('/artwork?', '/motion?') + records[0].revision });
      assert.equal(motionCopy.statusCode, 200, motionCopy.body);
      assert.equal(motionCopy.json<{prompt: string}>().prompt, requests.at(-1));
      const stale = await app.inject({ method: 'GET', url: promptUrl + 'previous-revision' });
      assert.equal(stale.statusCode, 400, stale.body);
      assert.equal(stale.json<{error: {code: string}}>().error.code, 'STALE');
      assert.equal(requests.length, requestCount, 'copying makes no provider requests');
      const stillAfter = await app.inject({ method: 'GET', url: route + '/sketches/0/prompt' });
      assert.equal(stillAfter.json<{prompt: string}>().prompt, stillPrompt);

      const projectSettings = engine.getProject(projectId).settings;
      const savedSettings = {
        ...projectSettings,
        animatedSvg: {...projectSettings.animatedSvg, ...(strategy === 'multi-pass' ? {
          stages: {artDirection: true, anatomy: true, renderedReview: true, targetedCorrections: true},
        } : {})},
      };
      db.prepare('UPDATE projects SET settings_json = ? WHERE id = ?').run(JSON.stringify(savedSettings), projectId);
      const drawUrl = route + '/animated-svg/0/generate';
      const draw = {operation: 'artwork', consent: true, expectedProvider: provider.id, revision: records[0].revision};
      for (const payload of [
        {...draw, artworkStrategy: 'unknown'},
        {...draw, operation: 'scene', artworkStrategy: 'single-pass'},
        {...draw, targetLayerIds: ['lantern'], artworkStrategy: 'multi-pass'},
      ]) {
        const rejected = await app.inject({method: 'POST', url: drawUrl, payload});
        assert.equal(rejected.statusCode, 422, rejected.body);
      }
      assert.equal(requests.length, requestCount, 'invalid choices do not call the provider');

      const artworkStrategy = strategy === 'multi-pass' ? 'single-pass' : 'multi-pass';
      const override = await app.inject({method: 'POST', url: drawUrl, payload: {
        ...draw, artworkStrategy, ...(artworkStrategy === 'single-pass' ? {reviewVisionConsent: true} : {}),
      }});
      assert.equal(override.statusCode, 202, override.body);
      const overrideId = override.json<{job: {id: string}}>().job.id;
      for (let tries = 0; tries < 100; tries++) {
        job = (await app.inject({method: 'GET', url: '/jobs/' + overrideId})).json<{state: string; error?: unknown}>();
        if (job.state !== 'queued' && job.state !== 'running') break;
        await delay(25);
      }
      assert.equal(job.state, 'succeeded', JSON.stringify(job));
      const overrideCalls = requests.slice(requestCount).map(prompt => prompt.split('\n')[0]);
      assert.deepEqual(overrideCalls, artworkStrategy === 'single-pass'
        ? ['Wander Studio • Layered vector artwork']
        : ['Wander Studio • Art direction', 'Wander Studio • Layered vector artwork', 'Wander Studio • Targeted vector refinement']);
      assert.deepEqual(engine.getProject(projectId).settings, savedSettings, 'scene job does not change Script settings');
      const layered = (await app.inject({method: 'GET', url: route + '/animated-svg'})).json<Array<{animation?: unknown; hasArtworkPrompt: boolean}>>();
      assert.equal(layered[0].hasArtworkPrompt, true);
      assert.equal(layered[0].animation, undefined);
      const stillAfterOverride = await app.inject({method: 'GET', url: route + '/sketches/0/prompt'});
      assert.equal(stillAfterOverride.json<{prompt: string}>().prompt, stillPrompt);

    } finally {
      await app.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
