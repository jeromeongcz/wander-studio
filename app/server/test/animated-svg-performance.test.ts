import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateAnimatedScene } from '../src/animation/generate.ts';
import { bindMotionClip, exportMotionClip } from '../src/animation/motion-clip.ts';
import { canonicalArtwork, drawFrame, parseArtwork, readMotion, readRig } from '../src/animation/model.ts';

const source='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><g id="definition"><path d="M2 2L5 6"/></g></defs><g id="arm"><path d="M20 20L28 20"/><g id="forearm"><path d="M28 20L33 20"/></g></g><g id="face"><g id="mouthRest"><path d="M8 8L13 8"/></g><g id="mouthOpen"><path d="M8 8Q10 15 13 8Z"/></g><g id="mouthRound"><path d="M8 8Q10 15 13 8Q12 5 8 8Z"/></g></g><g id="lantern"><path id="flame" d="M20 10L25 20Z"/></g></svg>';
const drawing=parseArtwork(source);
const ik={upperGroup:'arm',lowerGroup:'forearm',origin:[20,20],upperLength:8,lowerLength:5,bend:'clockwise',keys:[
  {time:0,target:[33,20]},{time:1,target:[28,26],ease:'smooth'},{time:3,target:[26,27]},
]};
const visemes={groups:{rest:'mouthRest',open:'mouthOpen',round:'mouthRound'},cues:[
  {start:0.5,end:1,shape:'open'},{start:1,end:1.5,shape:'round'},{start:2,end:2.5,shape:'round'},
]};
const cycle={target:'lantern',property:'opacity',from:.6,to:1,start:1,end:3,period:1,ease:'smooth'};
const isVisible=(frame:string,group:string)=>new RegExp(`id="${group}"[^>]+display="inline"`).test(frame);

test('advanced motion, dialogue shapes and ambient loops compile to canonical tracks and seek deterministically',()=>{
  const original=canonicalArtwork(drawing);
  const motion=readMotion({duration:3,ik:[ik],visemes,cycles:[cycle]},drawing);
  assert.equal(motion.tracks.length,6);
  assert.deepEqual(readMotion(motion,drawing),motion);
  const frame=(t:number)=>drawFrame(drawing,motion,t,64,64);
  assert.match(frame(1),/id="forearm" transform="rotate\([^"]+28 20\)"/);
  assert.match(frame(1.5),/id="lantern" opacity="1"/);
  assert.match(frame(2),/id="lantern" opacity="0.6"/);
  assert.match(frame(0),/id="lantern" opacity="0.6"/);
  assert.ok(isVisible(frame(0),'mouthRest'));
  assert.ok(isVisible(frame(0.5),'mouthOpen'));
  assert.equal(isVisible(frame(1),'mouthOpen'),false);
  assert.ok(isVisible(frame(1),'mouthRound'));
  assert.ok(isVisible(frame(1.5),'mouthRest'));
  assert.ok(isVisible(frame(3),'mouthRest'));
  assert.equal(frame(1),frame(1));
  assert.equal(canonicalArtwork(drawing),original);
  assert.doesNotThrow(()=>parseArtwork(frame(1.75)));
});

test('invalid IK placement, mouth intervals, duplicate properties and cycle bounds fail validation',()=>{
  for(const input of [
    {ik:[{...ik,lowerGroup:'mouthOpen'}]},
    {ik:[{...ik,lowerGroup:'definition'}]},
    {ik:[{...ik,keys:[{time:0,target:[33,20]},null]}]},
    {ik:[ik],tracks:[{target:'arm',property:'rotate',keys:[{time:0,value:0},{time:1,value:0}]}]},
    {visemes:{...visemes,groups:{rest:'mouthRest',open:'mouthOpen',wrong:'lantern'}}},
    {visemes:{...visemes,cues:[{start:0,end:1,shape:'open'},{start:0.5,end:1.5,shape:'round'}]}},
    {visemes:{...visemes,cues:Array.from({length:39},(_,i)=>({start:(i+0.25)/10,end:(i+0.75)/10,shape:'open'}))}},
    {cycles:[{...cycle,period:5}]},
    {cycles:[{...cycle,period:0.1,start:0,end:5}]},
    {cycles:[{...cycle,property:'path'}]},
  ])assert.throws(()=>readMotion({duration:5,...input},drawing),{code:'VALIDATION'});
  const transformed=parseArtwork(source.replace('id="forearm"','id="forearm" transform="translate(2 0)"'));
  assert.throws(()=>readMotion({duration:3,ik:[ik]},transformed),{code:'VALIDATION'});
  const motion=readMotion({duration:3,ik:[ik]},drawing);
  assert.throws(()=>readRig({joints:[{id:'elbow',target:'forearm',pivot:[28,20],min:-5,max:5}]},drawing,motion),{code:'VALIDATION'});
});

test('reusable role motion binds to new art without replacing source geometry or pivots',()=>{
  const motion=readMotion({duration:3,ik:[ik],tracks:[
    {target:'lantern',property:'translate',keys:[{time:0,value:[0,0]},{time:3,value:[6,5]}]},
  ]},drawing);
  const clip=exportMotionClip(motion,drawing,{elbow:'forearm',light:'lantern'});
  assert.equal(clip.tracks.some(t=>'target' in t||'pivot' in t),false);
  const other=parseArtwork('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g id="sleeve"><path d="M8 11L23 19Z"/></g><g id="hook"><path d="M20 30L33 14Z"/></g></svg>');
  const before=canonicalArtwork(other);
  const options={duration:6,translationScale:0.5,bindings:{elbow:{target:'sleeve',pivot:[8,11]},light:{target:'hook'}}};
  const rebound=bindMotionClip(clip,other,options);
  assert.equal(rebound.duration,6);
  assert.deepEqual(rebound.tracks.find(t=>t.target==='sleeve')?.pivot,[8,11]);
  assert.deepEqual(rebound.tracks.find(t=>t.target==='hook')?.keys.at(-1)?.value,[3,2.5]);
  assert.match(drawFrame(other,rebound,6,64,64),/d="M8 11L23 19Z"/);
  assert.equal(canonicalArtwork(other),before);
  assert.throws(()=>bindMotionClip(clip,other,{...options,bindings:{elbow:{target:'sleeve'},light:{target:'hook'}}}),{code:'VALIDATION'});
  assert.throws(()=>bindMotionClip({...clip,tracks:[{...clip.tracks[0],property:'path'}]},other,options),{code:'VALIDATION'});
});

test('the animated provider workflow accepts declarative movement and keeps its authored illustration',async()=>{
  const requested:string[]=[];
  const outcome=await generateAnimatedScene({
    provider:{id:'performance-fixture',async generateText({prompt}){
      const stage=prompt.split('\n',1)[0];
      requested.push(stage);
      if(stage.endsWith('Layered vector artwork'))return source;
      if(stage.endsWith('Rig and motion'))return JSON.stringify({animation:{duration:3,ik:[ik],visemes,cycles:[cycle]}});
      throw new Error('Unexpected generation stage '+stage);
    }},
    scene:{width:64,height:64,duration:3,visualDescription:'A storyteller gestures by a lantern.'},
    settings:{strategy:'single-pass',visualReview:false,complexity:'advanced',dialogue:true},
    dialogueCues:visemes.cues,
    validateArtwork:parseArtwork,
    validate(candidate){
      const approved=parseArtwork(candidate.svg);
      readRig(candidate.rig,approved,readMotion(candidate.animation,approved));
    },
  });
  assert.deepEqual(requested,['Wander Studio • Layered vector artwork','Wander Studio • Rig and motion']);
  const art=parseArtwork(outcome.svg);
  const compiled=readMotion(outcome.animation,art);
  assert.equal(canonicalArtwork(art),canonicalArtwork(drawing));
  assert.ok(isVisible(drawFrame(art,compiled,1.25,64,64),'mouthRound'));
});
