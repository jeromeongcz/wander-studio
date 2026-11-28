// Optional UI smoke: npm run build:web && node app/web/test/animated-svg-browser.mjs
// Set WANDER_TEST_CHROMIUM to a compatible browser executable when it is not on PATH.
// This uses a disposable loopback fixture, a new Chrome profile and no real providers/projects.
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
const root = fileURLToPath(new URL('../dist/ui/', import.meta.url));
const settings = { formats: ['vertical_9x16'] };
const artifacts = [['r', 'research'], ['sb','script_base'], ['sl','script_lang'], ['story','storyboard']].map(([id,kind]) => ({ id, kind, state:'approved', current_version_id:id+'v', label:kind, lang_code:id==='sl'?'en':null }));
const scene = {scene_id:'one',title:'A Lantern in the Woods',visual_description:'Warm lantern under layered foreground leaves',camera:{movement:'static'},sfx_cues:[],target_duration:5,script_segment_id:'s'};
const script = { title:'Test',lang:'en',sections:[{id:'s',text:'The trees groaned.',kind:'hook'}] };
const operations = [];
let record=null;
const jobs=[];
const vectors=[];
const placeholderPng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
const server=createServer(async (req,res)=>{
  const u=new URL(req.url,'http://localhost');
  const p=u.pathname;
  if(!p.startsWith('/api/')){
    const f=p.startsWith('/ui/')?p.slice(4):'index.html';
    try { const b=await readFile(root+'/'+f); res.setHeader('content-type',f.endsWith('.js')?'application/javascript':f.endsWith('.css')?'text/css':'text/html');res.end(b); } catch {res.statusCode=404;res.end();} return;
  }
  let body;
  if(req.method!=='GET') { const chunks=[];for await(const chunk of req)chunks.push(chunk); body=JSON.parse(Buffer.concat(chunks).toString()||'{}'); operations.push([p,body]); }
  let v={};
  if(p==='/api/projects/p')v={id:'p',name:'Review Smoke Test',settings,artifacts,languages:['en']};
  if(p==='/api/artifacts/r')v={content:{topic:'Test topic',claims:[]}};
  if(p==='/api/artifacts/sb')v={content:script};
  if(p==='/api/artifacts/story')v={content:{scenes:[scene]}};
  if(p==='/api/cinematic/options')v={cameras:[{id:'static',label:'Static'}],transitions:[],direction:{camera:[],style:[],transition:[]}};
  if(p==='/api/research/status')v={loggedIn:true};
  if(p==='/api/llm/active')v={active:'codex'};
  if(p==='/api/assets'||p==='/api/renders')v=[];
  if(p==='/api/animated-svg-library')v=vectors;
  if(p==='/api/artifacts/story/animated-svg/0/library'){
    v={id:'vec-'+(vectors.length+1),createdAt:'2026-11-27T12:00:00Z',...body};
    vectors.push(v);
  }
  if(p==='/api/projects/p/animated-svg-settings')settings.animatedSvg=body;
  if(p==='/api/artifacts/story/animated-svg')v=[record];
  if(p==='/api/artifacts/story/animated-svg/0/import')v=record={revision:'r1',state:'draft',duration:5,layers:['forest'],...body};
  if(p==='/api/artifacts/story/animated-svg/0/approve')v=record={...record,state:'approved'};
  if(p==='/api/artifacts/story/animated-svg/0/render'){
    record={...record,state:'rendered',video:{durationSeconds:5}};
    const job={id:'j1',state:'succeeded',progress:1,kind:'animated_svg_render',params:{sceneId:'one'}};
    jobs.push(job);v={job};
  }
  if(p==='/api/artifacts/story/animated-svg/0/attach')v=record={...record,state:'attached',assetId:'completed'};
  if(p==='/api/artifacts/story/animated-svg/0/generate'){
    const seq=jobs.length+1;
    record={...record,state:'draft',revision:'r'+seq};
    const job={id:'j'+seq,state:'succeeded',progress:1,kind:'animated_svg_generate',params:{sceneId:'one'}};
    jobs.push(job);v={job};
  }
  if(p==='/api/artifacts/story/animated-svg/0/preview'){res.setHeader('content-type','image/png');res.end(placeholderPng);return;}
  if(p.includes('notifications')||p.includes('presets')||p.includes('templates')||p.endsWith('/sketches'))v=[];
  if(p==='/api/jobs')v=jobs;
  res.setHeader('content-type','application/json');res.end(JSON.stringify(v));
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const addr='http://127.0.0.1:'+server.address().port;
const profile = await mkdtemp(join(tmpdir(), 'wander-ui-smoke-'));
const browser = spawn(process.env.WANDER_TEST_CHROMIUM || 'chromium', [
  '--headless', '--disable-dev-shm-usage', '--disable-background-networking',
  '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
  ...(process.env.WANDER_TEST_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
], { stdio: ['ignore', 'ignore', 'pipe'] });
let browserError = '';
browser.stderr.setEncoding('utf8').on('data', (s) => { browserError = (browserError + s).slice(-1024); });
browser.on('error', (e) => { browserError = e.message; });
const sleep=(n)=>new Promise(r=>setTimeout(r,n));
let ws;
try{
 let port;
 for(let i=0;i<50&&!port;i++) {try{port=(await readFile(profile+'/DevToolsActivePort','utf8')).split('\n')[0];}catch{await sleep(80);}}
 assert(port, `Unable to start Chromium (check WANDER_TEST_CHROMIUM): ${browserError}`);
 const tabs=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
 ws=new WebSocket(tabs[0].webSocketDebuggerUrl);await once(ws,'open');
 let id=0;const work=new Map();
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data); if(m.id&&work.has(m.id)){const resolve=work.get(m.id);work.delete(m.id);resolve(m);} });
 const cmd=(method,params={})=>new Promise((resolve, reject)=>{
   const i=++id;
   const timer=setTimeout(()=>{work.delete(i);reject(new Error('Browser timed out: '+method));},5000);
   work.set(i,(reply)=>{clearTimeout(timer);resolve(reply);});
   ws.send(JSON.stringify({id:i,method,params}));
 });
 const run=async expression=>{ const r=await cmd('Runtime.evaluate',{expression,returnByValue:true}); if(r.result?.exceptionDetails)throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value; };
 const wait=async expression=>{for(let i=0;i<50;i++){if(await run(expression))return;await sleep(120);}throw new Error('Timed out '+expression+'; DOM '+(await run("document.body?.innerText?.slice(0,1200)")));};
 await cmd('Page.navigate',{url:addr+'/#/p/p/script'});
 await wait("document.body?.innerText.includes('Illustration & Animation Quality')");
 await run("const m=[...document.querySelectorAll('label')].find(e=>e.textContent.includes('Visual generation mode')).querySelector('select');m.value='animated';m.dispatchEvent(new Event('change',{bubbles:true}))");
 await wait("[...document.querySelectorAll('button')].some(e=>e.textContent.includes('Save illustration settings'))");
 await run("[...document.querySelectorAll('button')].find(e=>e.textContent.includes('Save illustration settings')).click()");
 await wait("document.body?.innerText.includes('Animated SVG · Professional · 30 FPS')&&!document.body?.innerText.includes('Save illustration settings')");
 assert.equal(settings.animatedSvg.mode,'animated');
 await run("location.hash='#/p/p/storyboard'");
 await wait("[...document.querySelectorAll('button')].some(e=>e.textContent.includes('Animated SVG…'))");
 assert(await run("[...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='Custom SVG')"), 'existing static SVG action is present');
 const click=async label=>run(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)}).click()`);
 await click('Animated SVG…');
 await wait("document.body?.innerText.includes('Scene art direction')");
 await click('Import layered SVG + JSON…');
 function fill(name,value){return run(`{const el=document.querySelector('textarea[aria-label='+CSS.escape(${JSON.stringify(name)})+']');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));}`);}
 await fill('Layered SVG','<svg xmlns="http://www.w3.org/2000/svg"><g id="forest"/></svg>');
 await fill('Animation JSON','{"duration":5,"tracks":[]}');
 await click('Save as draft');
 await wait("document.body?.innerText.includes('Animated package saved as a draft.')");
 await click('Animation');
 await wait("[...document.querySelectorAll('button')].some(e=>e.textContent==='Approve previewed animation'&&!e.disabled)");
 await click('Approve previewed animation');
 await wait("!document.body?.innerText.includes('Approve previewed animation')");
 assert.equal(record.state,'approved');
 assert(operations.some(([p,b])=>p.endsWith('/approve')&&b.revision==='r1'));
 const pick=async (name,value)=>run(`{
   const select=[...document.querySelectorAll('label')].find(e=>e.querySelector('.field-l')?.textContent.trim()===${JSON.stringify(name)})?.querySelector('select');
   if (!select) throw new Error('Missing select: '+${JSON.stringify(name)});
   select.value=${JSON.stringify(value)};
   select.dispatchEvent(new Event('change',{bubbles:true}));
 }`);
 await click('Layers');
 await pick('Artwork group for library','forest');
 await pick('Library category','background');
 await click('Copy approved group to library');
 await wait("document.body?.innerText.includes('Approved layer copied to the local vector library.')");
 assert.deepEqual(vectors.map(({id,revision,name,kind,groupId})=>({id,revision,name,kind,groupId})),[{id:'vec-1',revision:'r1',name:'forest',kind:'background',groupId:'forest'}]);
 await click('Render');
 await click('Render MP4');
 await wait("[...document.querySelectorAll('button')].some(e=>e.textContent==='Use in composition'&&!e.disabled)");
 await click('Use in composition');
 await wait("document.body?.innerText.includes('In Asset Library')");
 assert(operations.some(([p,b])=>p.endsWith('/render')&&b.revision==='r1'&&b.preset==='balanced'));
 assert(operations.some(([p,b])=>p.endsWith('/attach')&&b.revision==='r1'&&b.reopen===false));
 await click('Artwork');
 await wait("document.querySelector('option[value=vec-1]') !== null");
 await pick('Library asset','vec-1');
 await run(`{
   const canvas=document.createElement('canvas');
   canvas.width=1200;canvas.height=800;
   const context=canvas.getContext('2d');
   context.fillStyle='darkslategray';context.fillRect(0,0,1200,800);
   canvas.toBlob((blob)=>{
     const input=document.querySelector('.animated-svg-studio input[type=file]');
     const dt=new DataTransfer();
     dt.items.add(new File([blob],'original-reference.png',{type:'image/png'}));
     input.files=dt.files;
     input.dispatchEvent(new Event('change',{bubbles:true}));
   },'image/png');
 }`);
 await wait("document.querySelector('.animated-reference img')?.naturalWidth===768");
 await run("window.confirmLog=[];window.confirm=(text)=>{window.confirmLog.push(text); return window.confirmLog.length===1;}");
 await click('Generate layered scene');
 await wait("window.confirmLog.length===2");
 assert(!operations.some(([p])=>p.endsWith('/generate')), 'do not transfer text/images when image consent declined');
 await run("window.confirmLog=[];window.confirm=(text)=>{window.confirmLog.push(text); return true;}");
 await click('Generate layered scene');
 await wait("document.querySelector('.animated-svg-studio .pill-warn')?.textContent==='draft'");
 let sent=operations.find(([p])=>p.endsWith('/generate'))?.[1];
 assert.equal(sent.revision,'r1');
 assert.equal(sent.consent,true);
 assert.equal(sent.expectedProvider,'codex');
 assert.equal(sent.visionConsent,true);
 assert.equal(sent.references[0].label,'original-reference.png');
 assert.equal(sent.references[0].mime,'image/jpeg');
 assert.deepEqual(sent.libraryReuse,{id:'vec-1',targetId:'forest'});
 assert(Buffer.from(sent.references[0].base64,'base64').length <= 200 * 1024);
 assert.equal(await run("window.confirmLog.length"),2);
 assert.equal(record.state,'draft');
 await click('Remove reference 1');
 await click('Layers');
 await wait("document.body?.innerText.includes('Refine selected artwork layers')");
 assert(await run("document.querySelector('a[download=\"scene.svg\"]') !== null"));
 await run("document.querySelector('.animated-refine input[type=checkbox]').click()");
 await run(`{
   const el=document.querySelector('.animated-refine textarea');
   Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'Soften rim light on the foreground.');
   el.dispatchEvent(new Event('input',{bubbles:true}));
 }`);
 await click('Refine selected layers');
 await wait("!document.querySelector('.animated-refine input[type=checkbox]').checked");
 sent=operations.filter(([p])=>p.endsWith('/generate')).at(-1)?.[1];
 assert.deepEqual(sent.targetLayerIds,['forest']);
 assert.equal(sent.brief,'Soften rim light on the foreground.');
 assert.equal(sent.revision,'r2');
 assert.equal(sent.visionConsent,undefined);
 assert.equal(sent.references,undefined);
 assert.equal(sent.libraryReuse,undefined);
 await run("location.hash='#/assets'");
 await wait("document.body?.innerText.includes('Animated vectors')");
 await click('Animated vectors');
 await wait("document.querySelector('.vector-library-card')?.textContent.includes('forest')");
 assert(await run("document.querySelector('.vector-library-card')?.textContent.includes('Background')"));
 if (process.env.WANDER_TEST_SCREENSHOT) {
   const screen=(await cmd('Page.captureScreenshot',{format:'png'})).result.data;
   await import('node:fs/promises').then(fs=>fs.writeFile(process.env.WANDER_TEST_SCREENSHOT,Buffer.from(screen,'base64')));
 }
 console.log('Chromium UI smoke: settings, static non-regression, package import, PNG review, approval, render/attach, image resizing and consent, targeted refinement, and approved vector library save/reuse passed.');
} finally { ws?.close(); browser.kill('SIGTERM'); server.close(); await sleep(300); await rm(profile,{recursive:true,force:true}).catch(()=>{});}
