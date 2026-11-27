import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const sources=new URL('../../../scripts/',import.meta.url);
const script=(name:string)=>new URL(name,sources);
const run=(path:string,args:string[]=[])=>spawnSync(process.execPath,[path,...args],{encoding:'utf8',windowsHide:true});

test('Wander requires Node 22.18+ in the 22 line or Node 24+',async()=>{
  const runtime=await import(script('runtime.mjs').href) as {supportedNode:(version:string)=>boolean};
  for(const version of ['v22.18.0','v22.26.9','v24.0.0','26.4.3']) assert.equal(runtime.supportedNode(version),true,version);
  for(const version of ['v22.12.0','v22.17.1','v23.9.0','v20.19.0','v24.0.0-rc.1','unknown']) assert.equal(runtime.supportedNode(version),false,version);
});

test('workspace web build resolves pinned commands in folders with spaces without npm shell shims',async()=>{
  const root=await mkdtemp(join(tmpdir(),'wander web tools '));
  try{
    const scripts=join(root,'scripts'), web=join(root,'app','web');
    await mkdir(scripts,{recursive:true});await mkdir(web,{recursive:true});
    await writeFile(join(web,'package.json'),JSON.stringify({name:'test-wander-web'}));
    for(const name of ['runtime.mjs','web-build.mjs'])await copyFile(script(name),join(scripts,name));
    const entry=join(scripts,'web-build.mjs');
    const clean=run(entry);
    assert.equal(clean.status,1);
    assert.match(clean.stderr,/npm ci --include=dev/);
    for(const [name,bin] of [['typescript','tsc'],['vite','vite']]){
      const dir=join(root,'node_modules',name);
      await mkdir(dir,{recursive:true});
      await writeFile(join(dir,'package.json'),JSON.stringify({name,bin:{[bin]:'./cli.cjs'}}));
      await writeFile(join(dir,'cli.cjs'),`const path=require('node:path'); if(!process.cwd().endsWith(path.join('app','web')))process.exit(19); console.log(${JSON.stringify(bin)}, ...process.argv.slice(2));`);
    }
    const build=run(entry);
    assert.equal(build.status,0,build.stderr);
    assert.match(build.stdout,/tsc -p tsconfig.json/);
    assert.match(build.stdout,/vite build/);
    const typecheck=run(entry,['--typecheck']);
    assert.equal(typecheck.status,0,typecheck.stderr);
    assert.match(typecheck.stdout,/tsc -p tsconfig.json/);
    assert.doesNotMatch(typecheck.stdout,/vite build/);
    await writeFile(join(root,'node_modules','typescript','cli.cjs'),'process.exitCode=7;');
    assert.equal(run(entry).status,7);
  }finally{await rm(root,{recursive:true,force:true});}
});
