import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { buildApi } from '../src/api.ts';
import { canonicalArtwork, drawFrame, parseArtwork, readMotion, readRig } from '../src/animation/model.ts';
import { openDb } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { LLMProviderRegistry } from '../src/providers/llm/registry.ts';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 640">
  <rect width="360" height="640" fill="#172932"/><path d="M0 396L360 396L360 640L0 640Z" fill="#344c4f"/>
  <g id="placement" transform="translate(80 160)"><g id="walker">
    <g id="rightArm"><path d="M8 60Q25 64 26 94L20 135Q14 144 7 133L10 98L0 75Z" fill="#4c7780"/></g>
    <g id="rightThigh"><path d="M-7 142Q10 133 20 145L16 197L-5 199Z" fill="#365858"/>
      <g id="rightShin"><path d="M-6 192L15 193L12 238L-2 238Z" fill="#4b6866"/>
        <g id="rightFoot"><path d="M-2 232L12 233Q18 238 25 237Q34 244 22 244L-4 244Z" fill="#171c21"/></g>
      </g>
    </g>
    <g id="leftThigh"><path d="M-13 142Q0 133 13 143L10 196L-9 197Z" fill="#62847b"/>
      <g id="leftShin"><path d="M-9 192L10 193L7 238L-5 238Z" fill="#78958a"/>
        <g id="leftFoot"><path d="M-5 232L7 233Q15 238 24 237Q34 244 22 244L-7 244Z" fill="#283137"/></g>
      </g>
    </g>
    <path d="M-20 61Q-6 49 13 57Q26 79 17 103L16 145Q0 152-21 144L-16 110Q-27 84-20 61Z" fill="#b78156"/>
    <path d="M-19 65Q-6 68 12 61L8 135L-13 143Z" fill="#cba276"/>
    <path d="M-7 53L-5 41L12 39L15 54Z" fill="#b18160"/>
    <path d="M-12 22Q-6 5 11 11Q22 16 20 30L29 38L23 41L19 51Q9 56-4 50Q-13 44-12 22Z" fill="#d4a278"/>
    <path d="M-14 22Q-7 5 10 8Q23 12 22 24Q14 20 6 26L-4 34L-12 38Z" fill="#27252b"/>
    <path d="M14 30L19 29L18 32Z" fill="#282c34"/>
    <g id="leftArm"><path d="M-19 60Q-4 57 1 71L-5 101L-7 128Q1 136-6 144Q-15 149-20 136L-21 104Q-26 82-19 60Z" fill="#d49b70"/></g>
  </g></g>
</svg>`;
const walk={root:'walker',left:{upper:'leftThigh',lower:'leftShin',foot:'leftFoot',hip:[0,150],thigh:45,shin:42},
  right:{upper:'rightThigh',lower:'rightShin',foot:'rightFoot',hip:[4,150],thigh:45,shin:42},
  groundY:230,start:.2,steps:4,stepSeconds:.55,stepLength:24,lift:11,bob:2,
  leftArm:{group:'leftArm',pivot:[-13,68]},rightArm:{group:'rightArm',pivot:[10,70]},armSwing:13};
const duration=2.6;
const art=parseArtwork(svg);
const move=()=>readMotion({duration,walk},art);
const angle=(frame:ReturnType<typeof parseArtwork>,group:string)=>Number(/rotate\(([-+\d.]+)/.exec(frame.ids.get(group)?.attr.transform??'')?.[1]);
const xy=(frame:ReturnType<typeof parseArtwork>)=>frame.ids.get('walker')!.attr.transform.match(/translate\(([-+\d.]+) ([-+\d.]+)\)/)!.slice(1).map(Number);

test('alternating support feet hold in world space between keys, with a level sole and counter-swinging arms',()=>{
  const original=canonicalArtwork(art), motion=move();
  assert.equal(motion.tracks.length,9);
  assert.deepEqual(readMotion(JSON.parse(JSON.stringify(motion)),art),motion);
  assert.ok(motion.tracks.every(track=>track.keys.length<=80));
  for(let step=0;step<walk.steps;step++){
    const corrected=step%2?'left':'right',leg=walk[corrected];
    const ankles:number[][]=[];
    for(let i=0;i<45;i++){
      const t=walk.start+walk.stepSeconds*(step+(i+.31)/45);
      const frame=parseArtwork(drawFrame(art,motion,t,360,640));
      const a=angle(frame,leg.upper),b=angle(frame,leg.lower),c=angle(frame,leg.foot),[x,y]=xy(frame);
      const u=(90+a)*Math.PI/180,l=(90+a+b)*Math.PI/180;
      assert.ok(Math.abs(a+b+c)<.001,'the sole stays level');
      ankles.push([x+80+leg.hip[0]+leg.thigh*Math.cos(u)+leg.shin*Math.cos(l), y+160+leg.hip[1]+leg.thigh*Math.sin(u)+leg.shin*Math.sin(l)]);
      assert.ok(Math.abs(angle(frame,'leftArm')+angle(frame,'rightArm'))<.001);
    }
    assert.ok(ankles.every(([x,y])=>Math.hypot(x-ankles[0][0],y-ankles[0][1])<.15),'the planted foot does not slide');
    assert.ok(ankles.every(([,y])=>Math.abs(y-(walk.groundY+160))<.15));
  }
  const first=parseArtwork(drawFrame(art,motion,0,360,640)),last=parseArtwork(drawFrame(art,motion,duration,360,640));
  assert.deepEqual(xy(first),[0,0]);assert.deepEqual(xy(last),[96,0]);
  assert.equal(canonicalArtwork(art),original);
});

test('invalid or competing walks fail closed and direction may reverse',()=>{
  const reverse=readMotion({duration,walk:{...walk,direction:'left'}},art);
  assert.deepEqual(xy(parseArtwork(drawFrame(art,reverse,duration,360,640))),[-96,0]);
  assert.throws(()=>readMotion({duration,walk:{...walk,steps:5}},art),/step count|whole walk/);
  assert.throws(()=>readMotion({duration,walk:{...walk,groundY:260}},art),/cannot reach/);
  assert.throws(()=>readMotion({duration,walk:{...walk,lift:100}},art),/below both hips/);
  assert.throws(()=>readMotion({duration,walk:{...walk,left:{...walk.left,foot:'rightFoot'}}},art),/nested/);
  const interference={target:'placement',property:'scale',keys:[{time:0,value:[1,1]},{time:1,value:[1.1,1.1]}]};
  assert.throws(()=>readMotion({duration,walk,tracks:[interference]},art),/another transform/);
  assert.throws(()=>readMotion({duration,walk:{...walk,stepSeconds:1}},art),/fit inside/);
  assert.throws(()=>readRig({joints:[{id:'wayward',target:'leftShin',pivot:[0,190]}]},art,move()),/approved rig joint/);
  assert.throws(()=>readRig({joints:[{id:'lockedLeg',target:'leftShin',pivot:[0,195],min:0,max:2}]},art,move()),/Rotation exceeds joint limits/);
});

test('Storyboard generates the bounded walk and exports a moving MP4 from unchanged artwork', {timeout:35_000}, async()=>{
  const root=await mkdtemp(join(tmpdir(),'wander-walk-'));
  const db=openDb(),engine=new Engine(db),registry=new LLMProviderRegistry(),app=buildApi(engine,{root},registry);
  let prompt='';
  registry.register({id:'walk-fixture',kind:'claude',name:'Fixture motion',
    terms:{freeTier:'local',requiresKey:false,commercialUse:'',privacy:''},
    async healthCheck(){return {ok:true,detail:'ready'};},
    async generateText(req){prompt=req.prompt;return JSON.stringify({animation:{duration,walk}});},
  });
  registry.setActive('walk-fixture');
  try{
    const project=(await app.inject({method:'POST',url:'/projects',payload:{name:'Walk fixture'}})).json();
    const settings=await app.inject({method:'PUT',url:`/projects/${project.id}/animated-svg-settings`,payload:{strategy:'single-pass',complexity:'advanced',visualReview:false,stages:{animationPreparation:false}}});
    assert.equal(settings.statusCode,200,settings.body);
    const board=engine.list(project.id,{kind:'storyboard'})[0];
    engine.saveVersion(board.id,{scenes:[{scene_id:'walking-scene',target_duration:duration,visual_description:'A side-profile character walks across the room.'}]});
    const route=`/artifacts/${board.id}/animated-svg/0`;
    const post=async(action:string,body:object)=>{
      const r=await app.inject({method:'POST',url:route+'/'+action,payload:body});assert.ok(r.statusCode>=200&&r.statusCode<300,r.body);return r.json();
    };
    const wait=async(id:string)=>{
      for(let i=0;i<320;i++){
        const state=(await app.inject({method:'GET',url:'/jobs/'+id})).json();
        if(state.state!=='queued'&&state.state!=='running')return state;
        await delay(25);
      }
      assert.fail('The animation job did not finish.');
    };
    const rig={joints:[{id:'hip',target:'leftThigh',pivot:[0,150]}, {id:'knee',target:'leftShin',parent:'hip',pivot:[0,195],min:0,max:95}]};
    const importResult=await post('import',{svg,artworkOnly:true,rig});
    await post('approve-artwork',{revision:importResult.revision});
    const {job:started}=await post('generate',{revision:importResult.revision,operation:'motion',consent:true,expectedProvider:'walk-fixture'});
    const generated=await wait(started.id);
    assert.equal(generated.state,'succeeded',JSON.stringify(generated));
    assert.match(prompt,/alternating feet/);
    const state=(await app.inject({method:'GET',url:`/artifacts/${board.id}/animated-svg`})).json()[0];
    assert.equal(state.svg,importResult.svg);
    assert.equal(state.artworkHash,importResult.artworkHash);
    assert.deepEqual(state.rig,rig);
    assert.equal(state.animation.tracks.length,9);
    const get=(path:string)=>app.inject({method:'GET',url:route+path});
    const before=await get('/preview?time=.2'),middle=await get('/preview?time=.58');
    assert.equal(before.statusCode,200);
    assert.equal(middle.statusCode,200);
    assert.ok(!before.rawPayload.equals(middle.rawPayload),'the rendered character changes pose');
    await post('approve',{revision:state.revision});
    const {job:render}=await post('render',{revision:state.revision,preset:'draft'});
    const result=await wait(render.id);
    assert.equal(result.state,'succeeded',JSON.stringify(result));
    assert.equal(result.result.video.frames,39);
    const output=await get('/video');
    assert.equal(output.headers['content-type'],'video/mp4');
    assert.equal(output.rawPayload.toString('ascii',4,8),'ftyp');
    if(process.env.WANDER_WALK_TEST_OUTPUT){
      const out=process.env.WANDER_WALK_TEST_OUTPUT;
      await mkdir(out,{recursive:true});
      await writeFile(join(out,'phase10-walk-fixture.mp4'),output.rawPayload);
      await writeFile(join(out,'phase10-walk-start.png'),before.rawPayload);
      await writeFile(join(out,'phase10-walk-mid.png'),middle.rawPayload);
    }
  }finally{await app.close();db.close();await rm(root,{recursive:true,force:true});}
});
