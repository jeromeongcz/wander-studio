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
