import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { buildApi } from '../src/api.ts';
import { openDb } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { LLMProviderRegistry } from '../src/providers/llm/registry.ts';
import type { TextLLMProvider } from '../src/providers/llm/types.ts';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1920"><rect width="1080" height="1920" fill="#182137"/><g id="lantern"><path d="M20 20L220 20L220 250Z" fill="#f9ac55"/></g></svg>';
const motion = {duration:4,tracks:[{target:'lantern',property:'rotate',pivot:[50,50],keys:[{time:0,value:0},{time:4,value:7}]}]};

test('the Storyboard keeps approved still SVG and artwork revisions while separately generating and reusing motion', {timeout:15_000}, async () => {
  const root=await mkdtemp(join(tmpdir(),'wander-staged-svg-'));
  const db=openDb(), engine=new Engine(db), registry=new LLMProviderRegistry(), prompts:string[]=[];
  const provider:TextLLMProvider={
    id:'capturing',kind:'claude',name:'Fixtures',terms:{freeTier:'local',requiresKey:false,commercialUse:'',privacy:''},
    async healthCheck(){return {ok:true,detail:'ready'};},
    async generateText({prompt}){
      prompts.push(prompt);
      if(prompt.startsWith('Wander Studio • Layered vector artwork\n'))return svg;
      if(prompt.startsWith('Wander Studio • Rig and motion\n'))return JSON.stringify({animation:motion});
      if(prompt.startsWith('Wander Studio • Targeted motion refinement\n'))return JSON.stringify({tracks:[{...motion.tracks[0],keys:[{time:0,value:0},{time:4,value:3}]}]});
      throw new Error(prompt.split('\n')[0]);
    },
  };
  registry.register(provider);registry.setActive(provider.id);
  const app=buildApi(engine,{root},registry);
  const call=(method:'GET'|'POST'|'PUT',url:string,payload?:object)=>app.inject({method,url,payload});
  const ok=async(method:'GET'|'POST'|'PUT',url:string,payload?:object)=>{
    const r=await call(method,url,payload);assert.ok(r.statusCode>=200&&r.statusCode<300,`${url}: ${r.statusCode} ${r.body.slice(0,900)}`);return r;
  };
  const request=async(path:string, payload:object)=>{
    const job=(await ok('POST',path+'/generate',{...payload,consent:true,expectedProvider:provider.id})).json().job;
    for(let i=0;i<130;i++){
      const status=(await ok('GET','/jobs/'+job.id)).json();
      if(status.state==='succeeded')return status.result;
      assert.ok(status.state==='running'||status.state==='queued',JSON.stringify(status));
      await delay(25);
    }
    assert.fail('Generation job did not reach a terminal state');
  };
  try{
    const {id:projectId}=(await ok('POST','/projects',{name:'Staged test',category:'History',languages:['en'],formats:['vertical_9x16']})).json();
    await ok('PUT','/projects/'+projectId+'/animated-svg-settings',{mode:'mixed',strategy:'single-pass',visualReview:false,reuseApproved:false,stages:{animationPreparation:false},reviewFallback:'skip'});
    assert.equal((engine.getProject(projectId).settings.animatedSvg as {reviewFallback:string}).reviewFallback,'skip');
    const storyboard=engine.list(projectId,{kind:'storyboard'})[0], sceneId='staged-scene-id';
    engine.saveVersion(storyboard.id,{scenes:[{scene_id:sceneId,title:'Lantern',script_segment_id:'intro',target_duration:4,
      visual_description:'Lantern in a doorway',visual_style:'archival sepia',asset_type:'illustration',camera:{movement:'static',intensity:'subtle'}}]});
    const visual=engine.createArtifact({projectId,kind:'scene_asset',sceneId,label:'Scene visual'});
    const route='/artifacts/'+storyboard.id, path=route+'/animated-svg/0';
    const staticPrompt=(await ok('GET',route+'/sketches/0/prompt')).json().prompt;
    const {asset_id:assetId}=(await ok('POST',route+'/sketches/0/custom-svg',{svg})).json();
    const blockedStill=await call('POST',path+'/from-still',{});
    assert.match(blockedStill.json().error.message,/Approve a still illustration/);
    await ok('POST','/assets/'+assetId+'/approve',{});
    engine.submitForReview(visual);engine.approve(visual,{actor:'user'});
    const source=db.prepare('SELECT * FROM storyboard_svg_sources WHERE asset_id=?').get(assetId);
    assert.equal(source?.source_hash,createHash('sha256').update(String(source?.svg)).digest('hex'));
    const copied=(await ok('POST',path+'/from-still',{})).json();
    assert.equal(copied.artworkSource.assetId,assetId);
    assert.equal(copied.artworkSource.sha256,source?.source_hash);
    const gate=await call('POST',path+'/generate',{operation:'motion',revision:copied.revision, consent:true});
    assert.match(gate.json().error.message,/Approve the exact artwork revision/);
    assert.equal(prompts.length,0);

    const generated=await request(path,{operation:'artwork',revision:copied.revision,brief:'Hatch the doorway in warm ink.'});
    assert.equal(prompts.length,1);
    assert.ok(prompts[0].startsWith('Wander Studio • Layered vector artwork\n'+staticPrompt));
    assert.match(prompts[0],/Hatch the doorway/);
    const current=async()=>(await ok('GET',route+'/animated-svg')).json()[0];
    const art=await current();
    assert.equal(art.revision,generated.revision);
    assert.equal(art.animation,undefined);
    const artworkPreview=await ok('GET',path+'/preview?artwork=1&revision='+art.revision);
    assert.equal(artworkPreview.headers['content-type'],'image/png');
    const duplicate=await Promise.all([0,1,2].map(()=>ok('GET',path+'/preview?artwork=1&revision='+art.revision)));
    assert.ok(duplicate.every(r=>r.rawPayload.equals(artworkPreview.rawPayload)));
    assert.equal((await call('GET',path+'/preview?time=not-a-time')).statusCode,422);
    assert.match((await call('POST',path+'/approve',{revision:art.revision})).json().error.message,/generate or import motion/);
    await ok('POST',path+'/approve-artwork',{revision:art.revision});

    await request(path,{operation:'motion',revision:art.revision,brief:'Swing the lantern once.'});
    const motionDraft=await current();
    assert.notEqual(motionDraft.revision,art.revision);
    assert.equal(motionDraft.artworkHash,art.artworkHash);
    assert.equal(motionDraft.artworkApproved,true);
    assert.equal(motionDraft.svg,art.svg);
    assert.equal(motionDraft.parentRevision,art.revision);
    assert.match(prompts[1],/Swing the lantern once/);
    await request(path,{operation:'refine-motion',revision:motionDraft.revision,brief:'Reduce rotation',targetLayerIds:['lantern']});
    const adjusted=await current();
    assert.equal(adjusted.svg,art.svg);
    assert.equal(adjusted.animation.tracks[0].keys.at(-1).value,3);
    await ok('POST',path+'/approve',{revision:adjusted.revision});
    const clip=(await ok('POST',path+'/motion-clip/export',{revision:adjusted.revision,roles:{light:'lantern'}})).json();
    assert.equal(clip.tracks[0].role,'light');
    assert.equal(clip.tracks[0].target,undefined);
    const entry=(await ok('POST',path+'/motion-clip/save',{revision:adjusted.revision,name:'Lantern swing',roles:{light:'lantern'}})).json();
    assert.equal((await ok('GET','/animated-motion-library')).json()[0].id,entry.id);
    assert.deepEqual((await ok('GET','/animated-motion-library/'+entry.id)).json(),clip);
    const rebound=(await ok('POST',path+'/motion-clip/bind',{revision:adjusted.revision,libraryClipId:entry.id,bindings:{light:{target:'lantern',pivot:[60,60]}}})).json();
    assert.equal(rebound.svg,art.svg);assert.equal(rebound.state,'draft');
    assert.deepEqual(rebound.animation.tracks[0].pivot,[60,60]);
    assert.equal((await ok('GET',path+'/package/scene.svg?revision='+copied.revision)).body,copied.svg);
    const list=(await ok('GET',path+'/history')).json();
    assert.equal(list.length,5);
    const restored=(await ok('POST',path+'/restore',{revision:rebound.revision,sourceRevision:copied.revision})).json();
    assert.equal(restored.svg,copied.svg);assert.equal(restored.state,'draft');assert.equal(restored.artworkApproved,false);
    assert.equal((await ok('GET',route+'/sketches/0/prompt')).json().prompt,staticPrompt);
    assert.equal((await ok('GET',route+'/sketches')).json()[0].asset_id,assetId);
  }finally{
    await app.close();db.close();await rm(root,{recursive:true,force:true});
  }
});

test('motion binding keeps a destination character rig and enforces its joint limits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wander-motion-rig-'));
  const db = openDb(), engine = new Engine(db), app = buildApi(engine, {root});
  try {
    const project = (await app.inject({method:'POST',url:'/projects',payload:{name:'Motion rig fixture'}})).json();
    const storyboard = engine.list(project.id,{kind:'storyboard'})[0];
    engine.saveVersion(storyboard.id,{scenes:[{scene_id:'destination-character',target_duration:2}]});
    const path = `/artifacts/${storyboard.id}/animated-svg`;
    const post = (action:string,payload:object)=>app.inject({method:'POST',url:path+'/0/'+action,payload});
    const character = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1920"><g id="arm"><path d="M0 0L80 10"/><g id="wrist"><path d="M80 10L100 30"/></g></g></svg>';
    const rig = {joints:[{id:'shoulder',target:'arm',pivot:[0,0]},{id:'hand',target:'wrist',parent:'shoulder',pivot:[80,10],min:-12,max:12}]};
    const makeKeys = (value:number)=>[{time:0,value:0},{time:2,value}];
    const imported = await post('import',{svg:character,rig,animation:{duration:2,tracks:[{target:'wrist',property:'rotate',pivot:[80,10],keys:makeKeys(5)}]}});
    assert.equal(imported.statusCode,200,imported.body);
    const initial = imported.json();
    const approved = await post('approve',{revision:initial.revision});
    assert.equal(approved.statusCode,200,approved.body);
    const bind = (angle:number)=>post('motion-clip/bind',{
      revision:initial.revision,
      bindings:{hand:{target:'wrist',pivot:[80,10]}},
      clip:{version:1,duration:2,tracks:[{role:'hand',property:'rotate',keys:makeKeys(angle)}]},
    });
    const invalid = await bind(20);
    assert.equal(invalid.statusCode,422,invalid.body);
    assert.match(invalid.json().error.message,/Rotation exceeds joint limits/);
    const active = (await app.inject({method:'GET',url:path})).json()[0];
    assert.equal(active.revision,initial.revision);
    assert.deepEqual(active.rig,rig);
    const valid = await bind(10);
    assert.equal(valid.statusCode,200,valid.body);
    const draft = valid.json();
    assert.equal(draft.state,'draft');
    assert.notEqual(draft.revision,initial.revision);
    assert.equal(draft.parentRevision,initial.revision);
    assert.equal(draft.svg,initial.svg);
    assert.equal(draft.artworkHash,initial.artworkHash);
    assert.equal(draft.artworkApproved,true);
    assert.deepEqual(draft.rig,rig);
    assert.equal(draft.animation.tracks[0].keys.at(-1).value,10);
  } finally {
    await app.close(); db.close(); await rm(root,{recursive:true,force:true});
  }
});

test('a saved rigged character stays consistent and independently animatable across two storyboard scenes', {timeout:40_000}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'wander-character-continuity-'));
  const db = openDb(), engine = new Engine(db), libraryProvider = new LLMProviderRegistry();
  const app = buildApi(engine, {root}, libraryProvider);
  let target = '', degrees = 20, sent = '';
  const provider:TextLLMProvider={
    id:'motion-fixture',kind:'claude',name:'Fixture motion',
    terms:{freeTier:'local',requiresKey:false,commercialUse:'',privacy:''},
    async healthCheck(){return {ok:true,detail:'ready'};},
    async generateText({prompt}){
      if(prompt.startsWith('Wander Studio • Layered vector artwork\n'))return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1920"><g id="provider_slot"><path d="M0 0L10 10"/></g></svg>';
      assert.match(prompt,/Rig and motion/);sent=prompt;
      return JSON.stringify({animation:{duration:2,tracks:[{target,property:'rotate',pivot:[20,16],keys:[{time:0,value:0},{time:2,value:degrees}]}]},
        rig:{joints:[{id:'attempted_replacement',target,pivot:[20,16],min:-180,max:180}]}});
    },
  };
  libraryProvider.register(provider);libraryProvider.setActive(provider.id);
  try {
    const project = (await app.inject({method:'POST',url:'/projects',payload:{name:'Character continuity fixture'}})).json();
    const settings=await app.inject({method:'PUT',url:`/projects/${project.id}/animated-svg-settings`,payload:{strategy:'single-pass',visualReview:false,reuseApproved:false,stages:{animationPreparation:false}}});
    assert.equal(settings.statusCode,200,settings.body);
    const storyboard = engine.list(project.id,{kind:'storyboard'})[0];
    engine.saveVersion(storyboard.id,{scenes:[
      {scene_id:'first-character-scene',target_duration:2,visual_description:'A character in a workshop'},
      {scene_id:'second-character-scene',target_duration:2,visual_description:'The same character outside'},
    ]});
    const path = `/artifacts/${storyboard.id}/animated-svg`;
    const post = (i:number,action:string,payload:object)=>app.inject({method:'POST',url:`${path}/${i}/${action}`,payload});
    const ok=async(i:number,action:string,payload:object)=>{
      const res=await post(i,action,payload);assert.ok(res.statusCode>=200&&res.statusCode<300,res.body);return res.json();
    };
    const sections=async()=>(await app.inject({method:'GET',url:path})).json();
    const draw = (inside:string)=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1920">${inside}</svg>`;
    const character = draw('<defs><linearGradient id="coat"><stop offset="0" stop-color="#f81c24"/><stop offset="1" stop-color="#291733"/></linearGradient></defs><g id="figure"><path d="M10 10L140 10L140 180L10 180Z" fill="url(#coat)"/><g id="wrist"><path d="M20 16L150 40L140 90Z" fill="#ffbb80"/></g></g><g id="outside"><path d="M0 0L20 10"/></g>');
    const rig = {joints:[
      {id:'root',target:'figure',pivot:[0,0]},
      {id:'hand',target:'wrist',parent:'root',pivot:[20,16],min:-12,max:12},
      {id:'in_other_layer',target:'outside',pivot:[0,0]},
    ]};
    const setA=await ok(0,'import',{svg:character,artworkOnly:true,rig});
    await ok(0,'approve-artwork',{revision:setA.revision});
    const entry=await ok(0,'library',{revision:setA.revision,name:'Workshop character',kind:'character',groupId:'figure'});
    assert.equal(entry.hasRig,true);
    const entries=(await app.inject({method:'GET',url:'/animated-svg-library'})).json();
    assert.equal(entries[0].hasRig,true);
    const clip = {version:1,duration:2,tracks:[{role:'hand',property:'rotate',keys:[{time:0,value:0},{time:2,value:10}]}]};
    const movedA=await ok(0,'motion-clip/bind',{revision:setA.revision,clip,bindings:{hand:{target:'wrist',pivot:[20,16]}}});
    await ok(0,'approve',{revision:movedA.revision});

    const destination=draw('<g id="stand"><path d="M0 0L300 20L20 500Z" fill="#063482"/></g><g id="placeholder" transform="translate(240 40)"><path d="M0 0L40 0L30 60Z" fill="#fe02fe"/></g>');
    const setB=await ok(1,'import',{svg:destination,artworkOnly:true,rig:{joints:[{id:'stand_joint',target:'stand',pivot:[0,0]}]}});
    const missing=await post(1,'library/place-character',{revision:setB.revision,libraryId:entry.id,targetId:'missing'});
    assert.equal(missing.statusCode,422,missing.body);
    assert.equal((await sections())[1].revision,setB.revision);
    const placed=await ok(1,'library/place-character',{revision:setB.revision,libraryId:entry.id,targetId:'placeholder'});
    assert.equal(placed.artworkApproved,false);
    assert.equal(placed.animation,undefined);
    assert.equal(placed.parentRevision,setB.revision);
    assert.match(placed.svg,/id="placeholder" transform="translate\(240 40\)"/);
    assert.match(placed.svg,/fill="#063482"/);
    assert.match(placed.svg,/stop-color="#f81c24"/);
    assert.match(placed.svg,/fill="url\(#asset_/);
    assert.doesNotMatch(placed.svg,/#fe02fe/);
    assert.ok(placed.rig.joints.some((j:{id:string})=>j.id==='stand_joint'));
    assert.ok(!placed.rig.joints.some((j:{id:string})=>j.id.includes('in_other_layer')));
    const wrist=placed.rig.joints.find((j:{min?:number})=>j.min===-12);
    const parent=placed.rig.joints.find((j:{target:string})=>j.target==='placeholder');
    assert.notEqual(wrist.target,'wrist');
    assert.equal(wrist.max,12);
    assert.equal(wrist.parent,parent.id);
    assert.deepEqual(wrist.pivot,[20,16]);
    assert.equal((await sections())[0].revision,movedA.revision);

    await ok(1,'approve-artwork',{revision:placed.revision});
    target=wrist.target;
    const waitJob=async(job:{id:string})=>{
      for(let i=0;i<240;i++){
        const m=(await app.inject({method:'GET',url:'/jobs/'+job.id})).json();
        if(m.state!=='running'&&m.state!=='queued')return m;
        await delay(25);
      }
      assert.fail('Motion job did not reach a terminal state');
    };
    const runJob=async(operation:object)=>waitJob((await ok(1,'generate',{...operation,consent:true,expectedProvider:provider.id})).job);
    const askMotion=()=>runJob({revision:placed.revision,operation:'motion'});
    const outside=await askMotion();
    assert.equal(outside.state,'failed');
    assert.match(outside.error.message,/Rotation exceeds joint limits/);
    assert.equal((await sections())[1].revision,placed.revision);
    degrees=10;
    const inside=await askMotion();
    assert.equal(inside.state,'succeeded',JSON.stringify(inside));
    assert.match(sent,/Approved rig:/);
    const movedB=(await sections())[1];
    assert.deepEqual(movedB.rig,placed.rig);
    assert.equal(movedB.svg,placed.svg);
    assert.equal(movedB.artworkHash,placed.artworkHash);
    await ok(1,'approve',{revision:movedB.revision});
    for(const [i,revision] of [[0,movedA.revision],[1,movedB.revision]]){
      const get=(time:number)=>app.inject({method:'GET',url:`${path}/${i}/preview?revision=${revision}&time=${time}`});
      const before=await get(0),after=await get(2);
      assert.equal(before.statusCode,200,before.body.slice(0,300));
      assert.equal(after.statusCode,200,after.body.slice(0,300));
      assert.equal(before.headers['content-type'],'image/png');
      assert.ok(!before.rawPayload.equals(after.rawPayload),'the same wrist motion renders in each scene');
    }
    for(const [i,revision] of [[0,movedA.revision],[1,movedB.revision]] as const){
      const rendered=await waitJob((await ok(i,'render',{revision,preset:'draft'})).job);
      assert.equal(rendered.state,'succeeded',JSON.stringify(rendered));
      assert.equal(rendered.result.video.frames,30);
      const mp4=await app.inject({method:'GET',url:`${path}/${i}/video?revision=${revision}`});
      assert.equal(mp4.headers['content-type'],'video/mp4');
      assert.equal(mp4.rawPayload.toString('ascii',4,8),'ftyp');
    }
    const reusedDuringArt=await runJob({revision:movedB.revision,operation:'artwork',libraryReuse:{id:entry.id,targetId:'provider_slot'}});
    assert.equal(reusedDuringArt.state,'succeeded',JSON.stringify(reusedDuringArt));
    const nextArt=(await sections())[1];
    assert.match(nextArt.svg,/#f81c24/);
    assert.ok(nextArt.rig.joints.some((j:{target:string})=>j.target==='provider_slot'));
    assert.ok(nextArt.rig.joints.some((j:{min?:number})=>j.min===-12));
  } finally {
    await app.close();db.close();await rm(root,{recursive:true,force:true});
  }
});
