import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { canonicalArtwork, drawFrame, parseArtwork, readMotion, readRig } from '../src/animation/model.ts';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><g id="coat"><path d="M1 1Q8 12 11 8Z"/></g></svg>';
test('canonical artwork and bounded motion interpolate and round-trip without scene clocks', () => {
  const d=parseArtwork(svg);
  assert.equal(canonicalArtwork(parseArtwork(canonicalArtwork(d))),canonicalArtwork(d));
  const m=readMotion({duration:2,tracks:[{target:'coat',property:'translate',keys:[{time:0,value:[0,1]},{time:2,value:[8,3],ease:'smooth'}]}]},d);
  assert.match(drawFrame(d,m,1,32,32),/translate\(4 2\)/);
  assert.doesNotThrow(()=>parseArtwork(drawFrame(d,m,1,32,32)));
});
test('unsupported features and invalid timeline/rig contracts fail closed', () => {
  assert.throws(()=>parseArtwork(svg.replace('<path','<animate')));
  assert.throws(()=>parseArtwork(svg.replace('<path','<path style="position:absolute"')));
  const d=parseArtwork(svg);
  assert.throws(()=>readMotion({duration:2,tracks:[{target:'missing',property:'translate',keys:[]}]},d));
  assert.throws(()=>readMotion({duration:2,tracks:[{target:'coat',property:'rotate',keys:[{time:1,value:0},{time:0,value:0}]}]},d));
  assert.throws(()=>readRig({joints:[{id:'coat',target:'coat',parent:'coat',pivot:[2,3]}]},d,{duration:1,tracks:[]}));
});
test('refined Balete reference validates with complete safe layers, animation, and rig',()=>{
  const text=(name:string)=>readFileSync(new URL('../../../docs/animated-svg/reference/'+name,import.meta.url),'utf8');
  const d=parseArtwork(text('balete-watcher.svg'));
  const m=readMotion(JSON.parse(text('animation.json')),d);readRig(JSON.parse(text('rig.json')),d,m);
  assert.equal(m.duration,10);assert.ok(m.tracks.length>=50);
  assert.notEqual(drawFrame(d,m,0,360,640),drawFrame(d,m,5.6,360,640));
});

test('path deformation keeps compatible organic shapes and step keys hold',()=>{
  const d=parseArtwork(svg.replace('<path','<path id="lip"'));
  const m=readMotion({duration:2,tracks:[
    {target:'lip',property:'path',keys:[{time:0,value:'M 0 0 Q 2 4 4 0 Z'},{time:2,value:'M 0 0 Q 2 8 4 0 Z',ease:'smooth'}]},
    {target:'coat',property:'opacity',keys:[{time:0,value:0},{time:1,value:1,ease:'step'},{time:2,value:1}]},
  ]},d);
  assert.match(drawFrame(d,m,0.5,32,32),/id="coat" opacity="0"/);
  assert.match(drawFrame(d,m,1,32,32),/d="M 0 0 Q 2 6 4 0 Z"/);
  assert.throws(()=>readMotion({duration:1,tracks:[{target:'lip',property:'path',keys:[{time:0,value:'M 0 0 L 4 0 Z'},{time:1,value:'M 0 0 Q 2 4 4 0 Z'}]}]},d));
});

test('lets safe still-compatible lettering and local presentation styles round-trip', () => {
  const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><path id="arc" d="M0 0 Q20 20 40 0"/></defs><text style="font-size:12px; fill:#aabbcc"><textPath href="#arc">Gabii <tspan style="font-weight:600">sa</tspan> balete</textPath></text></svg>';
  const canonical=canonicalArtwork(parseArtwork(svg));
  assert.match(canonical, /font-size="12px" fill="#aabbcc"/);
  assert.match(canonical, /Gabii <tspan font-weight="600">sa<\/tspan> balete/);
  assert.doesNotMatch(canonical, / style="/);
  assert.throws(()=>parseArtwork(svg.replace('href="#arc"','href="poster.svg#arc"')));
  assert.throws(()=>parseArtwork(svg.replace('font-size:12px; fill:#aabbcc','font-size:inherit; background:#000')));
});

test('seekable GSAP color, easing and visibility tracks are stable and layer hiding is preview-only', () => {
  const d=parseArtwork('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path id="coat" d="M0 0 Q16 22 29 0 Z"/></svg>');
  const m=readMotion({duration:2,tracks:[
    {id:'coat-color',target:'coat',property:'fill',keys:[{time:0,value:'#000000'},{time:2,value:'#ffffff'}]},
    {target:'coat',property:'rotate',keys:[{time:0,value:0},{time:2,value:32,ease:'easeIn'}]},
    {target:'coat',property:'visibility',keys:[{time:0,value:'visible'},{time:2,value:'hidden'}]},
  ]},d);
  const halfway=drawFrame(d,m,1,64,64);
  assert.match(halfway,/fill="rgba\(128,128,128,1\)"/);
  assert.match(halfway,/rotate\(8 0 0\)/);
  assert.match(halfway,/display="inline"/);
  assert.match(drawFrame(d,m,2,64,64),/display="none"/);
  assert.match(drawFrame(d,m,1,64,64,{hiddenTargets:['coat']}),/display="none"/);
  assert.equal(drawFrame(d,m,1,64,64),halfway);
  assert.equal(readMotion(m,d).tracks[1].id,m.tracks[1].id);
  assert.doesNotThrow(()=>parseArtwork(halfway));
});
