import assert from 'node:assert/strict';
import test from 'node:test';
import { extractApprovedGroup, generateAnimatedScene, professionalIllustrationGuidance } from '../src/animation/generate.ts';
import type { AnimatedCandidate, GenerateAnimatedSceneOptions } from '../src/animation/generate.ts';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="640" viewBox="0 0 360 640">
  <g id="forest"><path fill="#303739" d="M0 640C71 472 57 220 128 16L180 0C100 265 129 504 85 640Z"/></g>
  <g id="watcher"><path fill="#577a70" d="M148 498Q148 436 175 405Q196 384 213 429L233 503Z"/></g>
  <g id="traveler"><path fill="#92664f" d="M67 632Q59 523 105 487Q144 476 179 633Z"/></g>
</svg>`;
const forestOriginal = '<g id="forest"><path fill="#303739" d="M0 640C71 472 57 220 128 16L180 0C100 265 129 504 85 640Z"/></g>';
const forestReusable = '<g id="forest"><path d="M0 640C100 533 81 166 142 0L180 0C119 267 127 518 91 640Z" fill="#20312f" /></g>';
const travelerRefined = '<g id="traveler"><path fill="#b38360" d="M67 632Q59 523 105 487Q145 479 179 633Z"/><path d="M87 566Q107 531 136 540" fill="none" stroke="#d09e77"/></g>';
const plan = JSON.stringify({ staging: 'Keep a low warm light on the traveler.', layers: [{ id: 'forest', role: 'background' }, { id: 'traveler', role: 'character' }, { id: 'watcher', role: 'creature' }] });
const animation = { duration: 10, tracks: [{ target: 'traveler', property: 'rotate', pivot: [104, 510], keys: [{ time: 0, value: 0 }, { time: 6, value: -3 }, { time: 10, value: 0 }] }] };
const rig = { joints: [{ id: 'body', target: 'traveler', pivot: [104, 510], min: -18, max: 18 }] };
const scene = { title: 'Balete approach', cameraBaked: false };
const review = { notes: [{ category: 'lighting', observation: 'The face blends into the coat.', fixes: 'Arc a warm reflected edge under the cheek.', targets: ['traveler'] }] };
function fake(answers: Record<string, string>, extras: Partial<GenerateAnimatedSceneOptions> = {}) {
  const marks: string[] = [];
  const prompts: string[] = [];
  const validated: AnimatedCandidate[] = [];
  const opts: GenerateAnimatedSceneOptions = {
    provider: {
      id: 'codex', async generateText(args) {
        assert.equal(args.tools, '');
        prompts.push(args.prompt);
        const label = args.prompt.split('\n', 1)[0].split(' • ')[1];
        marks.push(label);
        const answer = answers[label];
        assert.equal(typeof answer, 'string', `unexpected provider stage: ${label}`);
        return answer;
      },
    },
    scene: { visualDescription: 'An anxious traveler by a gnarled balete tree, before the reveal.', width: 360, height: 640, duration: 10 },
    settings: { quality: 'professional', style: 'dark-folklore' },
    validateArtwork: (value) => { assert.match(value, /^<svg/); },
    validate: (candidate) => { assert.deepEqual(candidate.animation, animation); validated.push(candidate); },
    ...extras,
  };
  return { opts, marks, prompts, validated };
}

test('professional generation validates and renders artwork, reviews by true vision, preserves approved reusable art, then choreographs', async () => {
  let images = 0;
  const f = fake({ 'Art direction': plan, 'Layered vector artwork': svg, 'Targeted vector refinement': JSON.stringify({ patches: [{ id: 'traveler', svg: travelerRefined }] }), 'Rig and motion': JSON.stringify({ animation, rig, scene }) }, {
    reuse: [{ id: 'location-balete', version: 'approved-r3', kind: 'background', layers: [{ target: 'forest', svg: forestReusable }] }],
    rasterizePreview: async (imageSvg) => {
      f.marks.push('rasterize');
      assert.ok(imageSvg.includes(forestReusable));
      return Uint8Array.of(137, 80, 78, 71);
    },
    visionReview: async ({ image, prompt }) => {
      f.marks.push('vision');
      assert.deepEqual([...image], [137, 80, 78, 71]);
      assert.match(prompt, /Do not score file size or path count/);
      images++;
      return JSON.stringify(images === 1 ? review : { notes: [] });
    },
  });
  const result = await generateAnimatedScene(f.opts);
  assert.deepEqual(f.marks, ['Art direction', 'Layered vector artwork', 'rasterize', 'vision', 'Targeted vector refinement', 'rasterize', 'vision', 'Rig and motion']);
  assert.deepEqual(result.reused, [{ id: 'location-balete', version: 'approved-r3' }]);
  assert.equal(result.review?.method, 'rendered');
  assert.equal(result.finalReview?.method, 'rendered');
  assert.match(f.prompts[0], /organic balete roots/i);
  assert.match(f.prompts.at(-1)!, /staggered keys/);
  assert.equal(result.svg, svg.replace(forestOriginal, forestReusable).replace(/<g id="traveler">.*?<\/g>/, travelerRefined));
  assert.deepEqual(result.rig, rig);
  assert.equal(f.validated.length, 1);
});

test('draft is exactly one configured-provider request and never implies visual approval', async () => {
  const f = fake({ 'Quick draft': JSON.stringify({ svg, animation, rig, scene }) }, { settings: { quality: 'draft', style: 'cinematic-anime', dialogue: false } });
  const result = await generateAnimatedScene(f.opts);
  assert.deepEqual(f.marks, ['Quick draft']);
  assert.deepEqual(result.passes.map((p) => p.status), ['complete', 'skipped']);
  assert.equal(result.review, undefined);
  assert.match(f.prompts[0], /"dialogue":false/);
});

test('a text provider reviews source only and leaves an honest local preview record', async () => {
  const f = fake({ 'Art direction': plan, 'Layered vector artwork': svg, 'SVG source art critique': JSON.stringify({ notes: [] }), 'Rig and motion': JSON.stringify({ animation, rig, scene }) }, {
    settings: { quality: 'standard', style: 'dark-folklore' },
    rasterizePreview: async () => Uint8Array.of(137, 80, 78, 71),
  });
  // No target refinements on this particular plan: use a background-only plan to test method only.
  f.opts.provider.generateText = new Proxy(f.opts.provider.generateText, { apply(target, self, args) {
    if (args[0].prompt.startsWith('Wander Studio • Art direction')) return Promise.resolve(JSON.stringify({ layers: [{ id: 'forest', role: 'background' }] }));
    return Reflect.apply(target, self, args);
  } });
  const result = await generateAnimatedScene(f.opts);
  assert.equal(result.review?.method, 'source-only');
  assert.ok(result.passes.some((p) => p.name === 'preview-render' && /cannot view/.test(p.note!)));
  assert.ok(result.passes.some((p) => p.name === 'targeted-refinement' && p.status === 'skipped'));
});

test('targeted refinement changes just selected group and preserves existing timing and rig', async () => {
  const f = fake({ 'Targeted vector refinement': JSON.stringify({ patches: [{ id: 'traveler', svg: travelerRefined }] }) }, {
    settings: { quality: 'professional', visualReview: false }, refine: { svg, notes: 'Improve reflected light, do not redraw the location.', targetLayerIds: ['traveler'], animation, rig, scene },
  });
  const result = await generateAnimatedScene(f.opts);
  assert.deepEqual(f.marks, ['Targeted vector refinement']);
  assert.equal(result.svg, svg.replace(/<g id="traveler">.*?<\/g>/, travelerRefined));
  assert.deepEqual(result.animation, animation);
  assert.deepEqual(result.rig, rig);
  assert.match(f.prompts[0], /Improve reflected light/);
});

test('approved reusable groups cannot be refined; model edits outside named scope are rejected', async () => {
  const f = fake({}, { settings: { visualReview: false }, reuse: [{ id: 'forest', version: '1', kind: 'background', layers: [{ target: 'forest', svg: forestOriginal }] }], refine: { svg, notes: 'replace', targetLayerIds: ['forest'], animation } });
  await assert.rejects(generateAnimatedScene(f.opts), /unlocked groups/);
  assert.deepEqual(f.marks, []);
  const f2 = fake({ 'Targeted vector refinement': JSON.stringify({ patches: [{ id: 'forest', svg: forestReusable }] }) }, { settings: { visualReview: false }, refine: { svg, notes: 'sharpen', targetLayerIds: ['traveler'], animation } });
  await assert.rejects(generateAnimatedScene(f2.opts), /unauthorized/);
  assert.equal(f2.validated.length, 0);
});

test('live image data must stay with an explicitly image-capable adapter, or use typed notes', async () => {
  const images = [{ label: 'test palette', mime: 'image/png' as const, bytes: Uint8Array.of(137, 80, 78, 71) }];
  const f = fake({ 'Quick draft': JSON.stringify({ svg, animation }) }, { settings: { quality: 'draft' }, images });
  await assert.rejects(generateAnimatedScene(f.opts), /accepts only text/);
  assert.equal(f.marks.length, 0);
  const withNotes = await generateAnimatedScene({ ...f.opts, referenceNotes: 'Edge lit by muted amber' });
  assert.equal(withNotes.referenceAnalysis, 'text');
  assert.match(f.prompts.at(-1)!, /Edge lit by muted amber/);
  assert.doesNotMatch(f.prompts.at(-1)!, /test palette/);
  const withVision = await generateAnimatedScene({ ...f.opts, analyzeReferences: async (args) => {
    assert.equal(args.images, images);
    return 'Use the supplied ochre and charcoal light reference';
  } });
  assert.equal(withVision.referenceAnalysis, 'vision');
  assert.match(f.prompts.at(-1)!, /ochre and charcoal/);
});

test('reject artwork before any local rasterization or review and stop cancelled jobs before provider calls', async () => {
  const f = fake({ 'Art direction': plan, 'Layered vector artwork': svg }, { validateArtwork: () => { throw new Error('invalid artistic SVG'); }, rasterizePreview: async () => { throw new Error('should never render invalid art'); } });
  await assert.rejects(generateAnimatedScene(f.opts), /invalid artistic SVG/);
  assert.deepEqual(f.marks, ['Art direction', 'Layered vector artwork']);
  const c = new AbortController();
  c.abort();
  const cancelled = fake({}, { signal: c.signal });
  await assert.rejects(generateAnimatedScene(cancelled.opts), /cancelled/);
  assert.deepEqual(cancelled.marks, []);
  assert.match(professionalIllustrationGuidance('engraved-horror'), /crosshatching/i);
});

test('reuse extraction carries only local dependencies, styles and stable collision-free group IDs', () => {
  const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">' +
    '<defs><linearGradient id="a"><stop stop-color="#223840"/></linearGradient><linearGradient id="b" href="#a"/><radialGradient id="unused"><stop stop-color="#ffa000"/></radialGradient></defs>' +
    '<g stroke="#121a20"><g id="balete"><path id="branches" d="M0 11Q8 40 26 29" fill="url(#b)"/></g></g><g id="traveler"><rect width="14" height="12"/></g></svg>';
  const next = extractApprovedGroup(source, 'balete', 'reused-woods');
  assert.deepEqual(next, extractApprovedGroup(source, 'balete', 'reused-woods'));
  assert.equal(next.target, 'reused-woods');
  assert.match(next.svg, /^<g id="reused-woods" stroke="#121a20"><defs>/);
  assert.match(next.svg, /href="#asset_[a-f0-9]{14}_\d+_a"/);
  assert.match(next.svg, /fill="url\(#asset_[a-f0-9]{14}_\d+_b\)"/);
  assert.match(next.svg, /M0 11Q8 40 26 29/);
  assert.doesNotMatch(next.svg, /unused|traveler/);
  assert.throws(() => extractApprovedGroup(source, 'branches', 'not-a-group'), /named SVG group/);
});
