import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApi } from '../src/api.ts';
import { openDb } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { ffmpegBinary, ffprobeBinary } from '../src/media.ts';
import { sceneClipArgs } from '../src/render/motion.ts';
import type { SceneClipSpec } from '../src/render/motion.ts';
import { newResearchContent } from '../src/studios/research.ts';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 640"><g id="room"><rect width="360" height="640" fill="#a32910"/></g><g id="hand"><rect x="15" y="70" width="64" height="160" fill="#ffc083"/></g></svg>';
const motion = {duration: 0.8, tracks: [{target:'hand', property:'translate', keys:[{time:0,value:[0,0]},{time:0.8,value:[240,0]}]}]};
const ffmpeg = (...args: string[]) => execFileSync(ffmpegBinary(), ['-v','error','-y','-threads','1', ...args], {stdio:['ignore','pipe','pipe']});
const probe = (video: string) => JSON.parse(execFileSync(ffprobeBinary(), ['-v','error','-show_streams','-show_format','-of','json',video], {encoding:'utf8'}));

test('authored video plays once, drops clip audio, and holds instead of looping over a longer slot', () => {
  const root = mkdtempSync(join(tmpdir(),'wander-authored-playout-'));
  try {
    const src = join(root,'source.mp4');
    const bakedPath = join(root,'baked.mp4');
    ffmpeg('-f','lavfi','-i','color=red:s=96x96:r=10:d=0.5','-f','lavfi','-i','color=blue:s=96x96:r=10:d=0.5','-f','lavfi','-i','sine=frequency=700:duration=1',
      '-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0[v]','-map','[v]','-map','2:a','-c:v','libx264','-threads','1','-c:a','aac',src);
    const spec: SceneClipSpec = {asset:{path:src,kind:'video',width:96,height:96,sha256:'fixture',animated:{camera_baked:true,duration_seconds:1}},
      focal:{x:0.5,y:0.5},camera:{movement:'zoom',direction:'in',intensity:'strong'},duration:1.6,width:96,height:96,fps:10};
    const args = sceneClipArgs(spec,bakedPath);
    assert.equal(args.includes('-stream_loop'),false);
    assert.doesNotMatch(args.join(' '),/zoompan/);
    assert.match(args.join(' '),/tpad=stop_mode=clone/);
    ffmpeg(...args);
    const streams = probe(bakedPath).streams;
    assert.equal(streams.length,1);
    assert.equal(streams[0].codec_type,'video');
    assert.equal(Number(streams[0].nb_frames),16);
    const pixel = ffmpeg('-ss','1.4','-i',bakedPath,'-frames:v','1','-vf','scale=1:1,format=rgb24','-f','rawvideo','-');
    assert.ok(pixel[2] > pixel[0] + 100,'the final hold stays blue rather than looping to red');

    const composited = join(root,'with-composition-camera.mp4');
    spec.asset.animated!.camera_baked = false;
    const move = sceneClipArgs(spec,composited);
    assert.match(move.join(' '),/zoompan=.*:d=1:/);
    ffmpeg(...move);
    assert.equal(Number(probe(composited).streams[0].nb_frames),16,'one output per moving source frame, then hold');
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});

test('mixed storyboard composes the approved still plus baked SVG clip, obeys narration timing and rejects stale SVG assets', {timeout:60_000}, async () => {
  const root = mkdtempSync(join(tmpdir(),'wander-mixed-'));
  const db = openDb();
  const engine = new Engine(db);
  const app = buildApi(engine,{root});
  type Method = 'GET' | 'POST' | 'PUT';
  const call = (method: Method,url: string,payload?: object) => app.inject({method,url,payload});
  const json = async (method: Method,url: string,payload?: object) => {
    const response = await call(method,url,payload);
    assert.ok(response.statusCode >= 200 && response.statusCode < 300,`${method} ${url}: ${response.statusCode} ${response.body.slice(0,1000)}`);
    return response.json();
  };
  const approve = async (id: string) => {
    await json('POST',`/artifacts/${id}/submit`);
    await json('POST',`/artifacts/${id}/approve`,{});
  };
  try {
    const projectId = (await json('POST','/projects',{name:'Mixed acceptance fixture',category:'History',languages:['en'],formats:['vertical_9x16']})).id as string;
    const artifact = (kind: string) => engine.list(projectId).find(a=>a.kind===kind)!.id;
    const research = newResearchContent('Fictional historical composition test');
    await json('PUT',`/artifacts/${artifact('research')}/content`,{content:{...research,sources:[{id:'fixture',url:'https://example.org/fixture'}],checklist:research.checklist.map(x=>({...x,done:true}))}});
    await approve(artifact('research'));
    const script = {title:'The letter',lang:'en',preset:'short_lt30',sections:[{id:'h',kind:'hook',text:'The letter lies on the table.'},{id:'m',kind:'main',text:'The hand reaches for the letter.'}]};
    await json('PUT',`/artifacts/${artifact('script_base')}/content`,{content:script});
    await approve(artifact('script_base'));
    await json('POST',`/artifacts/${artifact('script_lang')}/seed-from-base`);
    await approve(artifact('script_lang'));
    const board = artifact('storyboard');
    await json('POST',`/artifacts/${board}/seed-storyboard`,{scene_seconds:4});
    const original = (await json('GET',`/artifacts/${board}`)).content;
    const scenes = original.scenes.map((scene: Record<string, unknown>, index: number) => ({
      ...scene,title:index ? 'Moving hand':'Letter still',draft:false,target_duration:0.8,
      visual_description:index ? 'A hand moves toward the letter.':'The letter lies on a table.',
      camera:{movement:'pan',direction:'left_to_right',intensity:'subtle'},transition_in:'cut',
      animation_plan:{mode:index ? 'animated':'static',duration:0.8,beats:index ? [{start:0,end:0.8,actor:'hand',action:'Reach for the letter'}] : []},
    }));
    await json('PUT',`/artifacts/${board}/content`,{content:{...original,scenes}});
    await approve(board);
    await json('PUT',`/projects/${projectId}/animated-svg-settings`,{mode:'mixed'});
    const png = join(root,'still.png');
    ffmpeg('-f','lavfi','-i','color=blue:s=360x640:r=10:d=0.1','-frames:v','1','-threads','1',png);
    const still = await json('POST',`/projects/${projectId}/assets/import`,{path:png,name:'Blue still',type:'illustration',license:{type:'own',commercial_use:'yes'}});
    await json('POST',`/assets/${still.id}/approve`,{});
    await json('PUT',`/scenes/${scenes[0].scene_id}/assets`,{assets:[{asset_id:still.id}],primary_asset_id:still.id});
    await approve(engine.list(projectId,{kind:'scene_asset'}).find(a=>a.scene_id===scenes[0].scene_id)!.id);
    const route = `/artifacts/${board}/animated-svg/1`;
    const draft = await json('POST',route+'/import',{svg,animation:motion,scene:{cameraBaked:true}});
    await json('POST',route+'/approve',{revision:draft.revision});
    const renderJob = await json('POST',route+'/render',{revision:draft.revision,preset:'draft'});
    let job: {state?:string} = {};
    for (let attempt = 0; attempt < 400; attempt++) {
      job = await json('GET',`/jobs/${renderJob.job.id}`);
      if (job.state !== 'queued' && job.state !== 'running') break;
      await delay(50);
    }
    assert.equal(job.state,'succeeded',JSON.stringify(job));
    const attached = await json('POST',route+'/attach',{revision:draft.revision});
    await json('POST',`/assets/${attached.assetId}/approve`,{});
    await approve(engine.list(projectId,{kind:'scene_asset'}).find(a=>a.scene_id===scenes[1].scene_id)!.id);

    const narration = join(root,'narration.wav');
    ffmpeg('-f','lavfi','-i','sine=frequency=410:duration=2.4',narration);
    await json('POST',`/artifacts/${artifact('audio')}/narration/import`,{path:narration});
    await approve(artifact('audio'));
    const caption = artifact('caption');
    await json('POST',`/artifacts/${caption}/captions/align`,{method:'heuristic'});
    const cap = (await json('GET',`/artifacts/${caption}`)).content;
    const fonts = await json('GET','/fonts') as {family:string}[];
    const font = fonts.find(f=>f.family==='DejaVu Sans')?.family ?? fonts[0]?.family;
    assert.ok(font);
    await json('PUT',`/artifacts/${caption}/content`,{content:{...cap,style:{...cap.style,font_family:font}}});
    await approve(caption);

    const composition = artifact('composition');
    const built = `/artifacts/${composition}/build-timeline`;
    const { timeline } = await json('POST',built,{});
    const tl = timeline ?? (await json('GET',`/artifacts/${composition}`)).content;
    assert.deepEqual(tl.scenes.map((s: {asset:{kind:string; id:string}})=>[s.asset.kind,s.asset.id]),[['image',still.id],['video',attached.assetId]]);
    assert.equal(tl.scenes[0].camera.movement,'pan');
    assert.equal(tl.scenes[1].camera.movement,'static');
    assert.equal(tl.scenes[1].asset.animated.camera_baked,true);
    assert.ok(tl.scenes[1].duration > tl.scenes[1].asset.animated.duration_seconds);
    assert.equal(tl.audio.narration_total,2.4);
    assert.equal(tl.duration,2.8);
    await json('PUT',`/artifacts/${composition}/scenes/${scenes[1].scene_id}/override`,{
      camera:{movement:'zoom',direction:'in',intensity:'strong'},
    });
    const directions = await json('GET',`/artifacts/${composition}/directions`);
    assert.equal(directions.scenes[1].camera.source,'animated_clip');
    assert.equal(directions.scenes[1].camera.value.movement,'static');
    await approve(composition);
    const output = await json('POST',`/artifacts/${composition}/render`,{variants:['clean']});
    const info = probe(join(root,output.renders[0].rel_path));
    assert.equal(info.streams.filter((s:{codec_type:string})=>s.codec_type==='audio').length,1);
    assert.ok(Math.abs(Number(info.format.duration)-2.8)<0.06);

    const status = `/artifacts/${composition}/timeline-status`;
    await json('PUT',`/projects/${projectId}/animated-svg-settings`,{mode:'animated'});
    assert.equal((await json('GET',status)).stale,true);
    const wrongMode = await call('POST',built,{reopen:true});
    assert.match(wrongMode.json().error.message,/Letter still.*fresh attached Animated SVG clip/);
    await json('PUT',`/projects/${projectId}/animated-svg-settings`,{mode:'mixed'});
    assert.equal((await json('GET',status)).stale,false);

    const revision = await json('POST',route+'/import',{revision:draft.revision,svg,animation:motion});
    assert.notEqual(revision.revision,draft.revision);
    assert.equal((await json('GET',`/artifacts/${composition}/timeline-status`)).stale,false,
      'a separate draft does not invalidate the unchanged attached approved revision');
    await json('PUT',`/artifacts/${board}/content`,{reopen:true,content:{...original,scenes:scenes.map((s:Record<string,unknown>,i:number)=>i ? {...s,visual_description:'A different shot requiring a new render.'}:s)}});
    const stale = await call('POST',built,{reopen:true});
    assert.equal(stale.json().error.code,'STALE',stale.body);
  } finally {
    await app.close();
    db.close();
    rmSync(root,{recursive:true,force:true});
  }
});
