import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { extractApprovedGroup, generateAnimatedArtwork, generateAnimatedScene, professionalIllustrationGuidance, readAnimatedGenerationControls } from '../src/animation/generate.ts';
import type { AnimatedCandidate, GenerateAnimatedSceneOptions } from '../src/animation/generate.ts';
import { buildAnimatedSketchPrompt, buildBaseArtworkPrompt, generationRequestPrompt } from '../src/animation/prompts.ts';
import { buildSketchPrompt } from '../src/research/sketch.ts';
import type { Scene } from '../src/studios/storyboard.ts';

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
  assert.equal(result.review?.artworkSha256, createHash('sha256').update(svg.replace(forestOriginal, forestReusable)).digest('hex'));
  assert.equal(result.finalReview?.artworkSha256, createHash('sha256').update(result.svg).digest('hex'));
  assert.equal(result.finalReview?.previewSha256, createHash('sha256').update(Uint8Array.of(137, 80, 78, 71)).digest('hex'));
  assert.match(f.prompts[0], /organic balete roots/i);
  assert.match(f.prompts.at(-1)!, /staggered keys/);
  assert.equal(result.svg, svg.replace(forestOriginal, forestReusable).replace(/<g id="traveler">.*?<\/g>/, travelerRefined));
  assert.deepEqual(result.rig, rig);
  assert.equal(f.validated.length, 1);
});

test('layered artwork retries omitted planned groups and reports repeated omissions accurately', async () => {
  const incomplete = svg.replace(/\s*<g id="watcher">.*?<\/g>/s, '');
  const setup = (repair: boolean) => {
    const f = fake({ 'Art direction': plan, 'Layered vector artwork': incomplete, 'Rig and motion': JSON.stringify({ animation, rig, scene }) }, {
      settings: { quality: 'standard', visualReview: false },
    });
    let artworkCalls = 0;
    const original = f.opts.provider.generateText;
    f.opts.provider.generateText = async (args) => {
      const response = await original(args);
      if (args.prompt.startsWith('Wander Studio • Layered vector artwork')) {
        artworkCalls++;
        return repair && artworkCalls === 2 ? svg : response;
      }
      return response;
    };
    return { f, calls: () => artworkCalls };
  };
  const fixed = setup(true);
  const artwork = await generateAnimatedScene(fixed.f.opts);
  assert.equal(artwork.svg, svg);
  assert.equal(fixed.calls(), 2);
  assert.match(fixed.f.prompts[2], /omitted these required planned groups: watcher/);

  const broken = setup(false);
  await assert.rejects(generateAnimatedScene(broken.f.opts), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'ANIMATION_MISSING_LAYERS');
    assert.match((error as Error).message, /watcher/);
    return true;
  });
  assert.equal(broken.calls(), 2);
});

test('draft uses one direct artwork call and a separate motion call, with no implied visual approval', async () => {
  const f = fake({ 'Layered vector artwork': svg, 'Rig and motion': JSON.stringify({ animation, rig, scene }) }, { settings: { quality: 'draft', style: 'cinematic-anime', dialogue: false } });
  const result = await generateAnimatedScene(f.opts);
  assert.deepEqual(f.marks, ['Layered vector artwork', 'Rig and motion']);
  assert.ok(result.passes.some((p) => p.name === 'art-review' && p.status === 'skipped'));
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
  assert.equal(result.review?.artworkSha256, createHash('sha256').update(result.svg).digest('hex'));
  assert.ok(!Object.hasOwn(result.review!, 'previewSha256'));
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
  const f = fake({ 'Layered vector artwork': svg, 'Rig and motion': JSON.stringify({ animation }) }, { settings: { quality: 'draft' }, images });
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

const sceneForPrompt: Scene = {
  title: 'The Lantern', script_segment_id: 's1', target_duration: 10, asset_type: 'illustration',
  visual_description: 'A lantern catches the bark on a Philippine balete in a foggy glade.', camera: {movement: 'static'},
};
const promptOptions = {number: 1, total: 1, size: {w: 360, h: 640}, category: 'Dark Folklore Horror', captionSpace: true, styleNotes: 'Ink and shadow'};

test('direct animated artwork uses the exact shipped still prompt plus layered instructions, then stops before motion', async () => {
  const original = buildSketchPrompt(sceneForPrompt, promptOptions);
  const animated = buildAnimatedSketchPrompt(sceneForPrompt, promptOptions);
  assert.ok(animated.startsWith(`${original}\n\nLayered artwork preparation`));
  assert.match(animated, /Style with presentation attributes or style/);
  assert.match(animated, /stable, descriptive IDs/);
  assert.match(animated, /lower fifth quiet|bottom fifth/);
  assert.doesNotMatch(original, /Layered artwork preparation/);
  const f = fake({ 'Layered vector artwork': svg }, {baseArtworkPrompt: animated, settings: {quality: 'professional', strategy: 'multi-pass'}});
  const artwork = await generateAnimatedArtwork(f.opts);
  assert.deepEqual(f.marks, ['Layered vector artwork']);
  assert.equal(f.prompts[0], generationRequestPrompt('Layered vector artwork', buildBaseArtworkPrompt({baseArtworkPrompt: animated})));
  assert.equal(artwork.svg, svg);
  assert.ok(!Object.hasOwn(artwork, 'animation'));
});

test('opt-in quality passes have independent order and no effect when not selected', async () => {
  const empty = JSON.stringify({patches:[]});
  const f = fake({
    'Art direction': plan, 'Composition direction': JSON.stringify({framing:'Frame the raised lantern in a profile at hand height.'}),
    'Layered vector artwork': svg, 'Anatomy refinement': empty, 'Environment and material refinement': empty, 'Lighting refinement': empty, 'Texture refinement': empty,
  }, {stages:{artDirection:true,composition:true,anatomy:true,environmentMaterials:true,lighting:true,texture:true}});
  const result = await generateAnimatedArtwork(f.opts);
  assert.deepEqual(f.marks, ['Art direction', 'Composition direction', 'Layered vector artwork', 'Anatomy refinement', 'Environment and material refinement', 'Lighting refinement', 'Texture refinement']);
  assert.equal(result.composition?.framing, 'Frame the raised lantern in a profile at hand height.');
  assert.match(f.prompts[2], /Additional composition guidance/);
  assert.equal(result.svg, svg);
  assert.ok(!Object.hasOwn(result, 'animation'));
});

test('motion generation can use existing artwork with a separately selected preparation stage', async () => {
  const prep = {targets:[{id:'traveler',role:'figure',pivot:[104,510],purpose:'Weight-bearing lean'}], beats:[{start:1,end:2,actor:'traveler',action:'Brace for a sound'}]};
  const f = fake({'Animation preparation':JSON.stringify(prep), 'Rig and motion':JSON.stringify({animation,rig,scene})}, {
    motionOnly:{svg,scene}, stages:{animationPreparation:true},
  });
  const result = await generateAnimatedScene(f.opts);
  assert.deepEqual(f.marks, ['Animation preparation','Rig and motion']);
  assert.equal(result.svg, svg);
  assert.equal(result.preparation?.targets[0].id, 'traveler');
  assert.match(f.prompts[1], /Brace for a sound/);
  assert.match(f.prompts[1], /destination key sets easing: step/);
});

test('targeted motion edits preserve drawable bytes, rig, selected track identity and unrelated tracks', async () => {
  const selected = {...animation.tracks[0], id: 'draft-traveler-turn'};
  const unselected = {id: 'watcher-opacity', target:'watcher', property:'opacity', keys:[{time:0,value:0}, {time:10,value:1}]};
  const before = {duration:10,tracks:[selected,unselected]};
  const proposed = {...selected, id:'new-model-id', keys:[{time:0,value:0}, {time:10,value:2}]};
  const f = fake({'Targeted motion refinement':JSON.stringify({tracks:[proposed]})}, {
    refineMotion:{svg, animation:before, rig, scene, notes:'Make the glance less abrupt.', targetLayerIds:['traveler']},
    validate:(c) => assert.deepEqual(c.animation, {duration:10,tracks:[{...proposed,id:selected.id},unselected]}),
  });
  const result = await generateAnimatedScene(f.opts);
  assert.deepEqual(f.marks, ['Targeted motion refinement']);
  assert.equal(result.svg, svg);
  assert.equal(result.rig, rig);
  assert.equal(result.scene, scene);
  assert.match(f.prompts[0], /Make the glance less abrupt/);
  assert.doesNotMatch(f.prompts[0], /watcher-opacity/);
  const outside = fake({'Targeted motion refinement': JSON.stringify({tracks:[unselected]})}, {
    refineMotion:{svg, animation:before, rig, notes:'Try outside scope.', targetLayerIds:['traveler']},
  });
  await assert.rejects(generateAnimatedScene(outside.opts), /unauthorized/);
  assert.equal(outside.validated.length, 0);
});

test('artwork-only targeted corrections do not call a motion provider, even if existing motion is supplied', async () => {
  const f = fake({'Targeted vector refinement':JSON.stringify({patches:[{id:'traveler',svg:travelerRefined}]})}, {
    refine:{svg, animation, rig, notes:'Define the lantern edge.', targetLayerIds:['traveler']},
  });
  const result = await generateAnimatedArtwork(f.opts);
  assert.deepEqual(f.marks,['Targeted vector refinement']);
  assert.ok(result.svg.includes(travelerRefined));
  assert.ok(!Object.hasOwn(result,'animation'));
});

test('revision and per-stage budget controls are bounded, optional and reliably enforced', async () => {
  assert.deepEqual(readAnimatedGenerationControls({quality:'professional'}), {});
  assert.deepEqual(readAnimatedGenerationControls({reviewFallback:'skip'}), {reviewFallback:'skip'});
  assert.throws(() => readAnimatedGenerationControls({reviewFallback:'assume-visual'}), /source-only or skip/);
  assert.throws(() => readAnimatedGenerationControls({stages:{notAStage:true}}), /Invalid animated SVG stage/);
  assert.throws(() => readAnimatedGenerationControls({maxRevisions:4}), /0 to 3/);
  assert.throws(() => readAnimatedGenerationControls({stageBudgets:{baseArtwork:{timeoutMs:2}}}), /100 to 480000/);
  const f = fake({'Layered vector artwork':svg}, {stageBudgets:{baseArtwork:{maxOutputBytes:10}}});
  await assert.rejects(generateAnimatedArtwork(f.opts), /configured output budget/);
  let sent: AbortSignal | undefined;
  const timeout = fake({}, {stageBudgets:{baseArtwork:{timeoutMs:100}}, provider:{id:'codex',generateText:async ({signal}) => {sent = signal; return new Promise<string>(() => {});}}});
  await assert.rejects(generateAnimatedArtwork(timeout.opts), /configured time budget/);
  assert.equal(sent?.aborted,true);
  const current = fake({'Art direction':plan,'Layered vector artwork':svg,'SVG source art critique':JSON.stringify(review),'Rig and motion':JSON.stringify({animation,rig,scene})}, {maxRevisions:0});
  await generateAnimatedScene(current.opts);
  assert.ok(!current.marks.includes('Targeted vector refinement'));
});

test('targeted corrections can be enabled by themselves and the revision limit caps repeated critiques', async () => {
  const patch1 = JSON.stringify({patches:[{id:'traveler',svg:travelerRefined}]});
  const direct = fake({'Layered vector artwork':svg, 'Targeted vector refinement':patch1}, {stages:{targetedCorrections:true}});
  const refined = await generateAnimatedArtwork(direct.opts);
  assert.deepEqual(direct.marks,['Layered vector artwork','Targeted vector refinement']);
  assert.ok(refined.svg.includes(travelerRefined));
  let round = 0;
  const revise: GenerateAnimatedSceneOptions['provider'] = {id:'codex', async generateText({prompt}) {
    if (prompt.startsWith('Wander Studio • Layered vector artwork')) return svg;
    if (prompt.startsWith('Wander Studio • Targeted vector refinement')) {
      round++;
      return JSON.stringify({patches:[{id:'traveler',svg:travelerRefined.replace('#b38360', round === 1 ? '#b58360' : '#b88360')}]});
    }
    throw new Error('Unexpected provider request');
  }};
  const f = fake({}, {
    provider:revise, stages:{renderedReview:true,targetedCorrections:true}, maxRevisions:2,
    rasterizePreview:async () => Uint8Array.of(137,80,78,71), visionReview:async () => JSON.stringify(review),
  });
  const result = await generateAnimatedArtwork(f.opts);
  assert.equal(round, 2);
  assert.equal(result.finalReview?.method, 'rendered');
  assert.equal(result.passes.filter((p) => p.name === 'targeted-refinement').length, 2);
});

test('optional review can continue with explicit source evidence after a preview renderer fails', async () => {
  const f = fake({'Layered vector artwork':svg, 'SVG source art critique':JSON.stringify({notes:[]}), 'Rig and motion':JSON.stringify({animation})}, {
    settings:{strategy:'single-pass', stages:{renderedReview:true, targetedCorrections:true}},
    rasterizePreview:async () => { throw new Error('Renderer unavailable'); },
    visionReview:async () => { assert.fail('No valid preview was available'); },
  });
  const result = await generateAnimatedScene(f.opts);
  assert.equal(result.review?.method, 'source-only');
  assert.equal(result.svg, svg, 'no review defects means no automatic redraw');
  assert.deepEqual(f.marks, ['Layered vector artwork', 'SVG source art critique', 'Rig and motion']);
  assert.ok(result.passes.some(p=>p.name==='preview-render'&&p.status==='failed'));
});

test('skip fallback does not send art source for review or silently claim approval', async () => {
  const f = fake({'Layered vector artwork':svg, 'Rig and motion':JSON.stringify({animation})}, {
    settings:{strategy:'single-pass', stages:{renderedReview:true, targetedCorrections:true}, reviewFallback:'skip'},
    rasterizePreview:async () => Uint8Array.of(137,80,78,71),
    visionReview:async () => { throw Object.assign(new Error('No vision'), {code:'VISION_UNSUPPORTED'}); },
  });
  const result = await generateAnimatedScene(f.opts);
  assert.deepEqual(f.marks, ['Layered vector artwork', 'Rig and motion']);
  assert.equal(result.review, undefined);
  assert.ok(result.passes.some(p=>p.name==='art-review'&&p.status==='skipped'&&p.note?.includes('Pixel review was unavailable')));
});

test('failed optional refinement and critique preserve the SVG, but aborts stop the whole job', async () => {
  const f = fake({'Layered vector artwork':svg, 'Lighting refinement':JSON.stringify({patches:[{id:'unauthorized',svg: travelerRefined}]}), 'SVG source art critique':'not JSON', 'Rig and motion':JSON.stringify({animation})}, {
    settings:{strategy:'single-pass', stages:{lighting:true, renderedReview:true}},
  });
  const result = await generateAnimatedScene(f.opts);
  assert.equal(result.svg, svg);
  assert.equal(result.review, undefined);
  assert.ok(result.passes.some(p=>p.name==='lighting'&&p.status==='failed'));
  assert.ok(result.passes.some(p=>p.name==='art-review'&&p.status==='failed'));
  const controller = new AbortController();
  const c = fake({'Layered vector artwork':svg}, {
    settings:{strategy:'single-pass', stages:{renderedReview:true}},
    signal:controller.signal,
    rasterizePreview:async () => { controller.abort(); throw new Error('renderer stopped'); },
  });
  await assert.rejects(generateAnimatedScene(c.opts), {code:'CANCELLED'});
  assert.deepEqual(c.marks,['Layered vector artwork']);
});

test('advanced motion instructions are scoped to enabled categories and do not invent lip sync timing', async () => {
  const options = {motionOnly:{svg},settings:{complexity:'advanced' as const, character:true, environment:false, dialogue:true}};
  const noCues = fake({'Rig and motion':JSON.stringify({animation})}, options);
  await generateAnimatedScene(noCues.opts);
  assert.match(noCues.prompts[0], /Optional animation\.ik/);
  assert.doesNotMatch(noCues.prompts[0], /Optional animation\.cycles/);
  assert.match(noCues.prompts[0], /No verified timed mouth cues/);
  const unsupported = fake({'Rig and motion':JSON.stringify({animation:{...animation,visemes:{groups:{rest:'rest',open:'open'},cues:[{start:1,end:2,shape:'open'}]}}})}, options);
  await assert.rejects(generateAnimatedScene(unsupported.opts), /without verified dialogue timing/);
  const changedCues = fake({'Rig and motion':JSON.stringify({animation:{...animation,visemes:{groups:{rest:'rest',open:'open'},cues:[{start:3,end:4,shape:'open'}]}}})}, {...options,dialogueCues:[{start:1,end:2,shape:'open'}]});
  await assert.rejects(generateAnimatedScene(changedCues.opts), /preserve the supplied mouth timing exactly/);
  const invalidTiming = fake({}, {...options,dialogueCues:[{start:1,end:2,shape:'open'},{start:1.5,end:3,shape:'open'}]});
  await assert.rejects(generateAnimatedScene(invalidTiming.opts), /non-overlapping/);
  assert.deepEqual(invalidTiming.marks, []);
});

test('a stale vision callback cannot send another review request after its deadline', async () => {
  let finishVision: (() => void) | undefined;
  const unresolved = new Promise<string>((_, reject) => {
    finishVision = () => reject(Object.assign(new Error('Unsupported'), {code:'VISION_UNSUPPORTED'}));
  });
  const f = fake({'Layered vector artwork':svg, 'Rig and motion':JSON.stringify({animation})}, {
    settings:{strategy:'single-pass', stages:{renderedReview:true}, stageBudgets:{renderedReview:{timeoutMs:100}}},
    rasterizePreview:async () => Uint8Array.of(137,80,78,71),
    visionReview:async () => unresolved,
  });
  const result = await generateAnimatedScene(f.opts);
  assert.ok(result.passes.some(p=>p.name==='art-review'&&p.status==='failed'));
  finishVision!();
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.deepEqual(f.marks, ['Layered vector artwork', 'Rig and motion']);
});
