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
  assert.throws(()=>parseArtwork(svg.replace('<path','<path style="fill:red"')));
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
