import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { buildApi } from '../src/api.ts';
import { openDb } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { LLMProviderRegistry } from '../src/providers/llm/registry.ts';

test('a restarted Storyboard rejects a corrupt clip, retries locally, and never resends interrupted AI work', {timeout:35_000}, async()=>{
  const root=await mkdtemp(join(tmpdir(),'wander-recovery-'));
  const filename=join(root,'fixture.db');
  const priorRenderer=process.env.WANDER_ANIMATION_RENDERER;
  process.env.WANDER_ANIMATION_RENDERER='librsvg';
  let db=openDb(filename),engine=new Engine(db),app=buildApi(engine,{root}),generations=0;
  const call=(method:'GET'|'POST',url:string,payload?:object)=>app.inject({method,url,payload});
  const json=async(method:'GET'|'POST',url:string,payload?:object)=>{
    const r=await call(method,url,payload);assert.ok(r.statusCode>=200&&r.statusCode<300,`${url}: ${r.statusCode} ${r.body.slice(0,650)}`);return r.json();
  };
  const wait=async(id:string)=>{
    for(let i=0;i<350;i++){
      const job=await json('GET','/jobs/'+id);
      if(job.state!=='queued'&&job.state!=='running')return job;
      await delay(30);
    }
    assert.fail('Render job did not reach a terminal state');
  };
  try{
    db.exec(`CREATE TABLE progress_writes(n INTEGER NOT NULL); INSERT INTO progress_writes VALUES (0);
      CREATE TRIGGER track_recovery_progress AFTER UPDATE OF progress ON jobs
        WHEN new.kind='animated_svg_render' BEGIN UPDATE progress_writes SET n=n+1; END;`);
    const project=await json('POST','/projects',{name:'Recover animation',formats:['vertical_9x16']});
    const board=engine.list(project.id,{kind:'storyboard'})[0];
    engine.saveVersion(board.id,{scenes:[{scene_id:'recover-clip',title:'Verify',target_duration:4,visual_description:'A moving fixture'}]});
    const url=`/artifacts/${board.id}/animated-svg/0`;
    const {revision}=await json('POST',url+'/import',{
      svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 640"><rect width="360" height="640" fill="#274149"/><g id="actor"><path d="M10 50L100 55L100 110Z" fill="#ce9768"/></g></svg>',
      animation:{duration:4,tracks:[{target:'actor',property:'translate',keys:[{time:0,value:[0,0]},{time:4,value:[100,20]}]}]},
    });
    await json('POST',url+'/approve',{revision});
    const previews=await Promise.all(Array.from({length:12},()=>call('GET',url+'/preview?revision='+revision+'&time=1')));
    assert.ok(previews.every(r=>r.statusCode===200&&r.rawPayload.equals(previews[0].rawPayload)));
    const first=await wait((await json('POST',url+'/render',{revision,preset:'draft'})).job.id);
    assert.equal(first.state,'succeeded',JSON.stringify(first));
    assert.equal(first.result.video.frames,60);
    const writes=Number(db.prepare('SELECT n FROM progress_writes').get()?.n);
    assert.ok(writes>2&&writes<=54,'progress writes are bounded rather than written for every frame: '+writes);
    const video=await call('GET',url+'/video');
    assert.equal(video.statusCode,200,video.body.slice(0,200));
    const mediaDir=join(root,'projects','proj_'+project.id,'animated-svg');
    const entries=await readdir(mediaDir);
    assert.equal(entries.length,1);
    const source=join(mediaDir,entries[0]);
    assert.deepEqual(await readFile(source),video.rawPayload);
    db.exec(`CREATE TRIGGER reject_candidate BEFORE UPDATE OF package_json ON animated_svg_scenes
      BEGIN SELECT RAISE(ABORT,'simulated checkpoint failure'); END;`);
    const failCommit=await wait((await json('POST',url+'/render',{revision,preset:'preview'})).job.id);
    assert.equal(failCommit.state,'failed',JSON.stringify(failCommit));
    assert.deepEqual((await call('GET',url+'/video')).rawPayload,video.rawPayload);
    assert.deepEqual(await readdir(mediaDir),entries,'failed checkpoint leaves no published candidate');
    db.exec('DROP TRIGGER reject_candidate;');

    // Record the exact persisted state left by an interrupted process; close the first
    // database, then let a fresh app instance recover it from disk.
    await app.close();
    const insert=db.prepare(`INSERT INTO jobs(id,project_id,artifact_id,kind,state,params_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`);
    const now=new Date().toISOString();
    insert.run('fixture-interrupted-render',project.id,board.id,'animated_svg_render','running',JSON.stringify(first.params),now,now);
    const stoppedProvider={...first.params,provider:'consent-fixture',referenceBatch:'lost-after-process-exit'};
    insert.run('fixture-queued-ai',project.id,board.id,'animated_svg_generate','queued',JSON.stringify(stoppedProvider),now,now);
    db.close();
    const times=await stat(source);
    const corrupt=Buffer.from(video.rawPayload);corrupt[corrupt.length-15]^=0xff;
    await writeFile(source,corrupt);await utimes(source,times.atime,times.mtime);
    const registry=new LLMProviderRegistry();
    registry.register({id:'consent-fixture',kind:'claude',name:'Should not be called',
      terms:{freeTier:'local',requiresKey:false,commercialUse:'',privacy:''},async healthCheck(){return {ok:true,detail:'ready'};},
      async generateText(){generations++;throw new Error('Interrupted provider work must not be resent');}});
    registry.setActive('consent-fixture');
    db=openDb(filename);engine=new Engine(db);app=buildApi(engine,{root},registry);
    const stopped=await json('GET','/jobs/fixture-interrupted-render');
    assert.equal(stopped.state,'failed');assert.equal(stopped.error.code,'INTERRUPTED');assert.equal(stopped.result,null);
    const expired=await wait('fixture-queued-ai');
    assert.equal(expired.state,'failed');assert.match(expired.error.message,/Provider selection expired/);
    const resend=await call('POST','/jobs/fixture-queued-ai/retry',{});
    assert.equal(resend.statusCode,422);assert.match(resend.json().error.message,/confirm the provider/);
    assert.equal(generations,0);
    const refused=await call('GET',url+'/video');
    assert.equal(refused.statusCode,500);assert.equal(refused.json().error.code,'RENDER_VERIFY');
    const repair=await wait((await json('POST','/jobs/fixture-interrupted-render/retry',{})).id);
    assert.equal(repair.state,'succeeded',JSON.stringify(repair));
    const recovered=await call('GET',url+'/video');
    assert.equal(recovered.statusCode,200,recovered.body.slice(0,200));
    assert.equal(recovered.rawPayload.toString('ascii',4,8),'ftyp');
    assert.ok(!recovered.rawPayload.equals(corrupt));
    const cache=await wait((await json('POST',url+'/render',{revision,preset:'draft'})).job.id);
    assert.equal(cache.state,'succeeded');
    assert.deepEqual(cache.result.video,repair.result.video);
    assert.equal(generations,0);
  }finally{
    if(priorRenderer===undefined)delete process.env.WANDER_ANIMATION_RENDERER;else process.env.WANDER_ANIMATION_RENDERER=priorRenderer;
    await app.close().catch(()=>{});try{db.close();}catch{}await rm(root,{recursive:true,force:true});
  }
});
