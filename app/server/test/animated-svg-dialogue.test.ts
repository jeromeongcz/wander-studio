import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildApi } from '../src/api.ts';
import { openDb } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { parseDialogueSuggestions } from '../src/animation/dialogue-timing.ts';

const result = (mouthCues: unknown[], duration=1) => JSON.stringify({metadata:{duration,soundFile:'/never/return/this/path.wav'},mouthCues});
const sample = [{start:0,end:.1,value:'X'},{start:.1,end:.24,value:'A'},{start:.24,end:.32,value:'A'},{start:.32,end:.73,value:'D'},{start:.73,end:1,value:'X'}];
test('local mouth timing preserves spoken offsets, filters rest, and rejects malformed or overlong timing', () => {
  assert.deepEqual(parseDialogueSuggestions(result(sample),1),[{start:.1,end:.32,shape:'closed'},{start:.32,end:.73,shape:'open'}]);
  assert.throws(()=>parseDialogueSuggestions(result(sample),.75),/Trim the WAV/);
  assert.throws(()=>parseDialogueSuggestions(result([{start:0,end:1,value:'Y'}]),1),/malformed/);
  assert.throws(()=>parseDialogueSuggestions(result([{start:0,end:.5,value:'D'},{start:.4,end:1,value:'F'}]),1),/overlapping/);
  assert.throws(()=>parseDialogueSuggestions(result([{start:0,end:1,value:'X'}]),1),/No speech timing/);
  const many=Array.from({length:39},(_,i)=>({start:i/50,end:(i+1)/50,value:i%2?'D':'A'}));
  assert.throws(()=>parseDialogueSuggestions(result(many),1),/more than 38/);
});

test('Storyboard estimates WAV cues locally and returns only editable timing', {skip:process.platform==='win32'}, async () => {
  const directory=await mkdtemp(join(tmpdir(),'wander-dialogue-test-'));
  const bin=join(directory,'recognizer'), config=process.env.WANDER_RHUBARB_BIN;
  const code=`#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
if(args.join(' ').indexOf('--recognizer phonetic --exportFormat json')<0||fs.readFileSync(args.at(-1)).toString('ascii',8,12)!=='WAVE')process.exit(10);
process.stdout.write(${JSON.stringify(result(sample))});
`;
  await writeFile(bin,code,{mode:0o755});
  process.env.WANDER_RHUBARB_BIN=bin;
  const db=openDb(),engine=new Engine(db),app=buildApi(engine,{root:directory});
  try {
    const project=(await app.inject({method:'POST',url:'/projects',payload:{name:'Mouth timing fixture'}})).json().id;
    const storyboard=engine.list(project,{kind:'storyboard'})[0];
    engine.saveVersion(storyboard.id,{scenes:[{scene_id:'safe-scene',target_duration:1}]});
    const send=(body:Buffer,recognizer='phonetic')=>app.inject({method:'POST',url:`/artifacts/${storyboard.id}/animated-svg/0/dialogue-cues?recognizer=${recognizer}`,headers:{'content-type':'application/octet-stream'},payload:body});
    const wav=Buffer.alloc(44);
    wav.write('RIFF');wav.write('WAVE',8);
    assert.match((await send(wav)).json().error.message,/Enable dialogue/);
    const enabled=await app.inject({method:'PUT',url:`/projects/${project}/animated-svg-settings`,payload:{dialogue:true}});
    assert.equal(enabled.statusCode,200,enabled.body);
    const good=await send(wav);
    assert.equal(good.statusCode,200,good.body);
    assert.equal(good.headers['cache-control'],'no-store');
    assert.deepEqual(good.json(),{method:'local-audio-estimate',cues:[{start:.1,end:.32,shape:'closed'},{start:.32,end:.73,shape:'open'}]});
    assert.match((await send(Buffer.alloc(44))).json().error.message,/scene WAV file/);
    assert.match((await send(wav,'arbitrary')).json().error.message,/recognizer/);
  } finally {
    if(config===undefined)delete process.env.WANDER_RHUBARB_BIN;else process.env.WANDER_RHUBARB_BIN=config;
    await app.close();db.close();await rm(directory,{recursive:true,force:true});
  }
});
