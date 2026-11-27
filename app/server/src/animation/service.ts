import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { EngineError } from '../engine.ts';
import type { JobCtx } from '../jobs.ts';
import type { TextLLMProvider } from '../providers/llm/types.ts';
import type { Studio } from '../services.ts';
import type { StoryboardContent } from '../studios/storyboard.ts';
import { FRAME } from '../research/sketch.ts';
import { bad, canonicalArtwork, drawFrame, parseArtwork, readMotion, readRig } from './model.ts';
import { ANIMATED_SVG_PRESETS, renderAnimatedSvg, renderAnimatedSvgFrame } from './render.ts';
import { extractApprovedGroup, generateAnimatedScene, type ImageReference } from './generate.ts';
import { buildAnimatedSketchPrompt } from './prompts.ts';

export const animatedSvgDefaults = {mode:'static',quality:'professional',style:'dark-folklore',fps:30,complexity:'standard',character:true,environment:true,dialogue:false,camera:true,detail:70,strategy:'multi-pass',advancedShading:true,visualReview:true,reuseApproved:true,customDirection:''} as const;
const styles = 'dark-folklore cinematic-25d professional-cartoon anime folklore graphic-novel watercolor documentary motion-graphics minimalist historical-graphic-novel cinematic-anime painterly-storybook engraved-horror custom'.split(' ');
export function readSettings(o: Record<string,unknown> = {}) {
  const options = (k:keyof typeof animatedSvgDefaults, allowed:readonly unknown[]) => {
    const v=o[k]??animatedSvgDefaults[k];if(!allowed.includes(v))return bad('Invalid animation '+k+'.');return v;
  };
  const flag = (k:keyof typeof animatedSvgDefaults) => options(k,[true,false]) as boolean;
  const detail=o.detail??70;
  if(typeof detail!=='number'||!Number.isInteger(detail)||detail<0||detail>100)return bad('Detail must be from 0 to 100.');
  return {mode:options('mode',['static','animated','mixed']) as 'static'|'animated'|'mixed',quality:options('quality',['draft','standard','professional','studio']) as 'draft'|'standard'|'professional'|'studio',style:options('style',styles) as string,fps:options('fps',[24,30,60]) as 24|30|60,complexity:options('complexity',['basic','standard','advanced']) as 'basic'|'standard'|'advanced',character:flag('character'),environment:flag('environment'),dialogue:flag('dialogue'),camera:flag('camera'),detail,strategy:options('strategy',['single-pass','multi-pass']) as 'single-pass'|'multi-pass',advancedShading:flag('advancedShading'),visualReview:flag('visualReview'),reuseApproved:flag('reuseApproved'),customDirection:str(o.customDirection,2000)};
}
function str(v:unknown,max:number){if(v===undefined||v===null)return '';if(typeof v!=='string'||v.length>max)return bad('Animation text exceeds its allowed length.');return v.trim();}
function json(v:unknown,limit:number){if(v===undefined||v===null)return undefined;const x=JSON.stringify(v);if(x.length>limit)return bad('Animation metadata exceeds its allowed size.');return JSON.parse(x) as unknown;}
type Draft = {svg:string;animation:ReturnType<typeof readMotion>;rig?:unknown;scene?:unknown;passes?:unknown;provider?:string};
type CapturedPrompts = Partial<Record<'baseArtwork'|'motion',string>>;
type Stored = Draft & {prompts?:CapturedPrompts;sourceFingerprint?:string; revision:string;state:'draft'|'approved'|'rendered'|'attached';duration:number;layers:string[];assetId?:string;video?:{width:number;height:number;fps:number;frames:number;durationSeconds:number}};
type LibraryItem={id:string;revision:string;name:string;kind:string;groupId:string;createdAt:string;svg:string};
type Key = ReturnType<AnimatedSvgStudio['locate']>;
export class AnimatedSvgStudio {
  private s:Studio;
  private referenceBatches=new Map<string,{provider:TextLLMProvider;model?:string;images:ImageReference[]}>();
  constructor(studio:Studio){this.s=studio;}
  settings(projectId:string,b:Record<string,unknown>){
    const p=this.s.engine.getProject(projectId);const settings=readSettings(b);
    this.s.engine.db.prepare('UPDATE projects SET settings_json=? WHERE id=?').run(JSON.stringify({...p.settings,animatedSvg:settings}),p.id);return settings;
  }
  locate(id:string,index:number){
    const a=this.s.engine.get(id);
    if(a.kind!=='storyboard')throw new EngineError('NOT_FOUND','Storyboard not found.');
    const c=this.s.engine.getContent(a.id) as StoryboardContent|null;
    const scene=Number.isInteger(index)&&index>=0?c?.scenes[index]:undefined;
    if(!scene?.scene_id)throw new EngineError('NOT_FOUND','Save the storyboard scene first.');
    const project=this.s.engine.getProject(a.project_id);
    const format=(project.settings.formats as string[]|undefined)?.[0]??'vertical_9x16';
    return {a,scene,sceneId:scene.scene_id,project,format,index,size:FRAME[format]??FRAME.vertical_9x16,total:c!.scenes.length,styleNotes:c!.style_notes};
  }
  private get(k:Key):Stored|null {
    const row=this.s.engine.db.prepare('SELECT package_json FROM animated_svg_scenes WHERE storyboard_id=? AND scene_id=?').get(k.a.id,k.sceneId) as {package_json:string}|undefined;
    return row?JSON.parse(row.package_json) as Stored:null;
  }
  list(id:string){
    const a=this.s.engine.get(id);if(a.kind!=='storyboard')throw new EngineError('NOT_FOUND','Storyboard not found.');
    const c=this.s.engine.getContent(id) as StoryboardContent|null;
    return (c?.scenes??[]).map((_,i)=>{
      const entry=this.get(this.locate(id,i));
      if(!entry)return null;
      const {prompts,...metadata}=entry;
      return {...metadata,hasArtworkPrompt:!!prompts?.baseArtwork,hasMotionPrompt:!!prompts?.motion};
    });
  }
  private check(k:Key,revision:unknown,initial=false) {
    const now=this.locate(k.a.id,k.index);
    if(now.sceneId!==k.sceneId)throw new EngineError('STALE','The scene moved. Refresh the storyboard.');
    const entry=this.get(k);
    if(!entry && initial && (revision===undefined||revision===null||revision===''))return null;
    if(!entry || revision!==entry.revision)throw new EngineError('STALE','This animation changed. Refresh it first.');
    return entry;
  }
  private put(k:Key,e:Stored){
    this.s.engine.db.prepare('INSERT INTO animated_svg_scenes(storyboard_id,scene_id,package_json) VALUES(?,?,?) ON CONFLICT(storyboard_id,scene_id) DO UPDATE SET package_json=excluded.package_json').run(k.a.id,k.sceneId,JSON.stringify(e));return e;
  }
  private fingerprint(k:Key){const {scene_id:_,order_index:__,...scene}=k.scene;return createHash('sha256').update(JSON.stringify({format:k.format,scene})).digest('hex');}
  private current(k:Key,e:Stored){
    if(e.sourceFingerprint&&e.sourceFingerprint!==this.fingerprint(k))throw new EngineError('STALE','Storyboard direction changed. Edit or reimport the animation as a new draft before using it.');
  }
  import(id:string,i:number,b:Record<string,unknown>, internal?:{passes?:unknown;provider?:string;prompts?:CapturedPrompts}) {
    const k=this.locate(id,i);this.check(k,b.revision,true);
    const d=parseArtwork(b.svg), animation=readMotion(b.animation,d), rig=readRig(b.rig,d,animation);
    const layers=[...d.ids].filter(([,el])=>el.tag==='g').map(([id])=>id);
    return this.put(k,{svg:canonicalArtwork(d),animation,rig,scene:json(b.scene,64_000),passes:json(internal?.passes,36_000),provider:internal?.provider,prompts:internal?.prompts,sourceFingerprint:this.fingerprint(k),revision:randomUUID(),state:'draft',duration:animation.duration,layers});
  }
  reuse(id:string,i:number,b:Record<string,unknown>){
    const k=this.locate(id,i);this.check(k,b.revision,true);
    if(typeof b.fromIndex!=='number'||b.fromIndex===i)return bad('Choose another approved scene.');
    const source=this.get(this.locate(id,b.fromIndex));
    if(!source||source.state==='draft')return bad('The source scene must be approved.');
    return this.import(id,i,{svg:source.svg,animation:source.animation,rig:source.rig,scene:{reusedFrom:source.revision,metadata:source.scene},revision:b.revision},{provider:source.provider});
  }
  approve(id:string,i:number,revision:unknown){
    const k=this.locate(id,i),e=this.check(k,revision)!;
    this.current(k,e);
    if(e.state!=='draft')return e;
    return this.put(k,{...e,state:'approved'});
  }
  private unbusy(projectId:string){
    const row=this.s.engine.db.prepare("SELECT 1 FROM jobs WHERE project_id=? AND kind IN ('animated_svg_generate','animated_svg_render') AND state IN ('queued','running') LIMIT 1").get(projectId);
    if(row)throw new EngineError('BUSY','An animation job is already running for this project.');
  }
  start(id:string,i:number,b:Record<string,unknown>,kind:'animated_svg_generate'|'animated_svg_render'){
    const k=this.locate(id,i), e=this.check(k,b.revision,kind==='animated_svg_generate');
    this.unbusy(k.project.id);
    if(kind==='animated_svg_generate'){
      if(b.consent!==true)return bad('Confirm the selected provider may receive the scene and reference notes.');
      const provider=this.s.llm.active();
      if(!provider)throw new EngineError('PROVIDER_ERROR','Choose an AI provider in Settings first.');
      if(b.expectedProvider!==undefined&&b.expectedProvider!==provider.id)throw new EngineError('STALE','The active provider changed. Review its name and confirm again.');
      const model=this.s.config.videoModels?.storyboard??this.s.config.selectedLLMModel??undefined;
      const targetLayerIds=b.targetLayerIds;
      if(targetLayerIds!==undefined&&(!e||!Array.isArray(targetLayerIds)||!targetLayerIds.length||targetLayerIds.length>6||!targetLayerIds.every(x=>typeof x==='string'&&e.layers.includes(x))))return bad('Select up to six named layers in the current draft or artwork.');
      const reuseLayer=typeof b.reuseLayer==='object'&&b.reuseLayer&&!Array.isArray(b.reuseLayer)?b.reuseLayer as Record<string,unknown>:undefined;
      if(reuseLayer){
        if(typeof reuseLayer.fromIndex!=='number'||reuseLayer.fromIndex===i||typeof reuseLayer.sourceGroupId!=='string'||typeof reuseLayer.targetId!=='string')return bad('Choose a named group from an approved previous scene.');
        const source=this.get(this.locate(id,reuseLayer.fromIndex));
        if(!source||source.state==='draft'||!source.layers.includes(reuseLayer.sourceGroupId))return bad('This group is not in approved source artwork.');
        reuseLayer.revision=source.revision;
      }
      const libraryReuse=typeof b.libraryReuse==='object'&&b.libraryReuse&&!Array.isArray(b.libraryReuse)?b.libraryReuse as Record<string,unknown>:undefined;
      if(libraryReuse){
        if(typeof libraryReuse.id!=='string'||typeof libraryReuse.targetId!=='string')return bad('Choose a reusable vector layer and placeholder.');
        this.libraryItem(libraryReuse.id);
      }
      const images=this.images(b.references);
      const vision=b.visionConsent===true;
      if(images.length&&!vision)return bad('Confirm that reference images may be sent to the selected provider.');
      if(vision&&typeof provider.generateVision!=='function')return bad('This provider has no image-capable adapter. Use the reference notes or select a supported vision model.');
      if(vision&&b.expectedProvider!==provider.id)return bad('Confirm image use for the currently selected provider.');
      const brief=str(b.brief,5000),referenceNotes=str(b.referenceNotes,3000);
      const referenceBatch=randomUUID();
      if(this.referenceBatches.size>=12)throw new EngineError('BUSY','Generation queue is full.');
      this.referenceBatches.set(referenceBatch,{provider,model,images});
      setTimeout(()=>this.referenceBatches.delete(referenceBatch),60*60*1000).unref();
      return {job:this.s.jobs.enqueue(kind,{projectId:k.project.id,artifactId:id,params:{id,i,sceneId:k.sceneId,storyboardVersion:k.a.current_version_id,revision:e?.revision,provider:provider.id,brief,referenceNotes,targetLayerIds,reuseLayer,libraryReuse,vision,referenceBatch}})};
    }
    if(e)this.current(k,e);
    if(e?.state==='attached')return bad('Save a new draft to render a replacement for an attached clip.');
    if(e?.state!=='approved'&&e?.state!=='rendered')return bad('Approve the animation first.');
    if(typeof b.preset!=='string'||!Object.hasOwn(ANIMATED_SVG_PRESETS,b.preset))return bad('Unknown render preset.');
    return {job:this.s.jobs.enqueue(kind,{projectId:k.project.id,artifactId:id,params:{id,i,sceneId:k.sceneId,storyboardVersion:k.a.current_version_id,revision:e.revision,preset:b.preset}})};
  }
  private images(input:unknown):ImageReference[]{
    if(input===undefined)return [];
    if(!Array.isArray(input)||input.length>2)return bad('Provide at most two reference images.');
    return input.map((o:unknown)=>{
      if(!o||typeof o!=='object')return bad('Invalid reference image.');
      const {mime,base64,label}=o as Record<string,unknown>;
      if(typeof base64!=='string'||base64.length>273_068||!(/^[A-Za-z0-9+/]+={0,2}$/).test(base64)||base64.length%4!==0)return bad('Invalid or oversized image payload.');
      const bytes=Buffer.from(base64,'base64');
      const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
      const jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
      const webp=bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
      if(bytes.length>200*1024||!((mime==='image/png'&&png)||(mime==='image/jpeg'&&jpeg)||(mime==='image/webp'&&webp)))return bad('Use PNG, JPEG or WebP references no larger than 200 KB.');
      return {mime:mime as ImageReference['mime'],bytes,label:str(label,100)};
    });
  }
  private jobKey(ctx:JobCtx) {
    const p=ctx.params,k=this.locate(p.id,p.i);
    if(k.project.id!==ctx.job.project_id||k.a.id!==ctx.job.artifact_id||k.sceneId!==p.sceneId||k.a.current_version_id!==p.storyboardVersion)
      throw new EngineError('STALE','Storyboard changed since this job was queued.');
    return k;
  }
  private dir(k:Key){return join(this.s.config.root,'projects','proj_'+k.project.id,'animated-svg');}
  private filename(k:Key,e:Stored){if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(e.revision))return bad('Invalid stored scene revision.');return join(this.dir(k),e.revision+'.mp4');}
  private async raster(svg:string,w:number,h:number,signal?:AbortSignal){
    const dir=join(this.s.config.root,'cache');await mkdir(dir,{recursive:true});const temp=await mkdtemp(join(dir,'svg-preview-'));
    try{
      const outputPath=join(temp,'preview.png');
      await renderAnimatedSvgFrame({svg,outputPath,width:w,height:h,assertSafeSvg:parseArtwork,ffprobeOverride:this.s.config.ffprobePath,signal});
      return await readFile(outputPath);
    }finally{await rm(temp,{recursive:true,force:true});}
  }
  private dims(k:Key,edge:number){const even=(n:number)=>Math.round(n/2)*2;const max=(edge===2160?3840:Infinity),r=Math.min(edge/Math.min(k.size.w,k.size.h),max/Math.max(k.size.w,k.size.h));return {width:even(k.size.w*r),height:even(k.size.h*r)};}
  async preview(id:string,i:number,t:number,revision?:string){
    const k=this.locate(id,i),e=revision?this.check(k,revision):this.get(k);
    if(!e)throw new EngineError('NOT_FOUND','No animated artwork for this scene.');
    const d=parseArtwork(e.svg), m=readMotion(e.animation,d), {width,height}=this.dims(k,360);
    return this.raster(drawFrame(d,m,t,width,height),width,height);
  }
  capturedPrompt(id:string,i:number,revision:unknown,stage:keyof CapturedPrompts){
    const prompt=this.check(this.locate(id,i),revision)?.prompts?.[stage];
    if(!prompt)throw new EngineError('NOT_FOUND','This revision does not have a captured prompt for that stage.');
    return {prompt};
  }
  async generate(ctx:JobCtx) {
    const p=ctx.params,k=this.jobKey(ctx),e=this.check(k,p.revision,true);
    const settings=readSettings(k.project.settings.animatedSvg as Record<string,unknown>|undefined);
    const pinned=this.referenceBatches.get(p.referenceBatch);
    this.referenceBatches.delete(p.referenceBatch);
    if(!pinned)return bad('Provider selection expired. Choose Generate again to confirm the current provider.');
    const {provider,model,images}=pinned;
    const reusable=settings.reuseApproved?this.list(k.a.id).filter((v,i)=>i!==k.index&&v&&v.state!=='draft').slice(0,6):[];
    const vision = p.vision && provider.generateVision ? provider.generateVision.bind(provider) : undefined;
    const reuse=reusable.map(x=>({id:x!.revision,version:x!.revision,kind:'background',notes:'Approved scene layers: '+x!.layers.join(', '),layers:undefined as {target:string;svg:string}[]|undefined}));
    if(p.reuseLayer){
      const r=p.reuseLayer,source=this.get(this.locate(p.id,r.fromIndex));
      if(!source||source.state==='draft'||source.revision!==r.revision)throw new EngineError('STALE','The selected approved reuse source changed.');
      reuse.unshift({id:source.revision,version:source.revision,kind:'background',notes:'Use the approved locked group at the named placeholder.',layers:[extractApprovedGroup(source.svg,r.sourceGroupId,r.targetId)]});
    }
    if(p.libraryReuse){
      const asset=this.libraryItem(p.libraryReuse.id);
      reuse.unshift({id:asset.id,version:asset.revision,kind:asset.kind,notes:'Explicitly selected immutable library artwork',layers:[extractApprovedGroup(asset.svg,asset.groupId,p.libraryReuse.targetId)]});
    }
    const prompts:CapturedPrompts={};
    const generated=await generateAnimatedScene({
      provider,model,settings,
      baseArtworkPrompt:buildAnimatedSketchPrompt(k.scene,{
        size:k.size,category:k.project.category??undefined,number:k.index+1,total:k.total,
        styleNotes:k.styleNotes,captionSpace:k.project.settings.reserve_caption_space===true,
      }),
      scene:{id:k.sceneId,visualDescription:[k.scene.visual_description,p.brief].filter(Boolean).join('\n'),duration:Math.min(60,Math.max(0.1,k.scene.target_duration??5)),width:k.size.w,height:k.size.h,context:k.scene.animation_plan?JSON.stringify(k.scene.animation_plan):undefined},
      referenceNotes:p.referenceNotes,
      reuse,images,
      ...(vision?{
        analyzeReferences:({images:refs,prompt,signal})=>vision({model,prompt,images:refs.map(x=>x.bytes),signal}),
        visionReview:({image,prompt,signal})=>vision({model,prompt,images:[image],signal}),
      }:{}),
      ...(e&&p.targetLayerIds?{refine:{svg:e.svg,animation:e.animation,rig:e.rig,scene:e.scene,targetLayerIds:p.targetLayerIds,notes:p.brief}}:{}),
      signal:ctx.signal,
      onPromptRequest:(stage,prompt)=>{if(Buffer.byteLength(prompt,'utf8')<=128_000)prompts[stage]=prompt;},
      onProgress:(fraction,message)=>ctx.progress(fraction,message),
      validateArtwork:parseArtwork,
      validate:(v)=>{const d=parseArtwork(v.svg);const m=readMotion(v.animation,d);readRig(v.rig,d,m);},
      rasterizePreview:(svg,signal)=>{const d=parseArtwork(svg);const {width,height}=this.dims(k,360);return this.raster(drawFrame(d,{duration:1,tracks:[]},0,width,height),width,height,signal);},
    });
    this.jobKey(ctx);
    if(ctx.signal.aborted)throw new EngineError('CANCELLED','Animation generation cancelled.');
    const saved=this.import(p.id,p.i,{...generated,revision:p.revision,scene:{metadata:generated.scene,artPlan:generated.artPlan,review:generated.review,finalReview:generated.finalReview,referenceAnalysis:generated.referenceAnalysis,reused:generated.reused}},{passes:generated.passes,provider:provider.id,prompts});
    return {revision:saved.revision,state:saved.state};
  }
  async render(ctx:JobCtx){
    const p=ctx.params,k=this.jobKey(ctx),e=this.check(k,p.revision)!;
    this.current(k,e);
    if(e.state==='draft'||e.state==='attached')return bad('Approve an unattached animation first.');
    const d=parseArtwork(e.svg), m=readMotion(e.animation,d);
    if(typeof p.preset!=='string'||!Object.hasOwn(ANIMATED_SVG_PRESETS,p.preset))return bad('Unknown render preset.');
    const preset=ANIMATED_SVG_PRESETS[p.preset as keyof typeof ANIMATED_SVG_PRESETS],{width,height}=this.dims(k,preset.shortEdge);
    const outputPath=this.filename(k,e); const fps=p.preset==='ultra'?readSettings(k.project.settings.animatedSvg as Record<string,unknown>|undefined).fps:preset.fps;
    if(e.video?.width===width&&e.video.height===height&&e.video.fps===fps&&await stat(outputPath).then(x=>x.isFile()).catch(()=>false)){ctx.progress(1,'Using existing verified render');return {revision:e.revision,video:e.video};}
    await mkdir(this.dir(k),{recursive:true});
    const cache=join(this.s.config.root,'cache');await mkdir(cache,{recursive:true});
    const staging=await mkdtemp(join(cache,'animated-svg-'));
    try{
      const {outputPath:_,...video}=await renderAnimatedSvg({outputPath:join(staging,'scene.mp4'),width,height,fps,durationSeconds:m.duration,frameAt:(t)=>drawFrame(d,m,t,width,height),assertSafeSvg:parseArtwork,ffprobeOverride:this.s.config.ffprobePath,signal:ctx.signal,onProgress:(p)=>ctx.progress(p.stage==='verifying'?0.98:Math.min(.97,p.completed/Math.max(1,p.total)),p.stage==='frames'?'Preparing animation frames':p.stage==='encoding'?'Encoding MP4':'Verifying output')});
      this.jobKey(ctx);
      const fresh=this.check(k,p.revision)!;
      if(ctx.signal.aborted)throw new EngineError('CANCELLED','Animation render cancelled.');
      await rename(join(staging,'scene.mp4'),outputPath);
      this.put(k,{...fresh,video,state:'rendered'});
      return {revision:fresh.revision,video};
    }finally{await rm(staging,{recursive:true,force:true});}
  }
  private libraryItem(id:string):LibraryItem{
    const row=this.s.engine.db.prepare('SELECT * FROM animated_svg_library WHERE id=?').get(id);
    if(!row)throw new EngineError('NOT_FOUND','Reusable vector layer not found.');
    return row as unknown as LibraryItem;
  }
  library(){
    return this.s.engine.db.prepare('SELECT id,revision,name,kind,groupId,createdAt FROM animated_svg_library ORDER BY createdAt DESC LIMIT 200').all();
  }
  promote(id:string,i:number,b:Record<string,unknown>){
    const k=this.locate(id,i),e=this.check(k,b.revision)!;
    this.current(k,e);
    if(e.state==='draft')return bad('Approve artwork before adding a reusable layer.');
    const name=str(b.name,120);
    if(!name||typeof b.groupId!=='string'||!e.layers.includes(b.groupId)||typeof b.kind!=='string'||!['character','background','prop','environment','effect'].includes(b.kind))return bad('Name the approved layer and select its type.');
    const count=(this.s.engine.db.prepare('SELECT COUNT(*) AS n FROM animated_svg_library').get() as {n:number}).n;
    if(count>=200)return bad('The reusable vector library is full.');
    const duplicate=this.s.engine.db.prepare('SELECT id,revision,name,kind,groupId,createdAt FROM animated_svg_library WHERE revision=? AND groupId=?').get(e.revision,b.groupId);
    if(duplicate)return duplicate;
    const entry={id:randomUUID(),revision:e.revision,name,kind:b.kind,groupId:b.groupId,createdAt:new Date().toISOString()};
    this.s.engine.db.prepare('INSERT INTO animated_svg_library(id,revision,name,kind,groupId,createdAt,svg) VALUES (?,?,?,?,?,?,?)').run(entry.id,entry.revision,entry.name,entry.kind,entry.groupId,entry.createdAt,e.svg);
    return entry;
  }
  part(id:string,i:number,name:string,revision?:string){
    const k=this.locate(id,i),e=revision?this.check(k,revision):this.get(k);
    if(!e)throw new EngineError('NOT_FOUND','No package for this scene.');
    const data:Record<string,unknown>={'animation.json':e.animation,'rig.json':e.rig,'scene.json':{id:k.sceneId,revision:e.revision,duration:e.duration,state:e.state,provider:e.provider,metadata:e.scene,passes:e.passes,layers:e.layers,video:e.video}};
    if(name==='scene.svg')return {mime:'image/svg+xml',bytes:Buffer.from(canonicalArtwork(parseArtwork(e.svg)))};
    if(!Object.hasOwn(data,name)||data[name]===undefined)throw new EngineError('NOT_FOUND','This package file is unavailable.');
    return {mime:'application/json',bytes:Buffer.from(JSON.stringify(data[name],null,2))};
  }
  async video(id:string,i:number,revision?:string){
    const k=this.locate(id,i),e=revision?this.check(k,revision):this.get(k);
    if(!e?.video)throw new EngineError('NOT_FOUND','Render a video first.');
    const path=this.filename(k,e);try{return {path,bytes:(await stat(path)).size};}catch{throw new EngineError('NOT_FOUND','Render file no longer exists.');}
  }
  async attach(id:string,i:number,b:Record<string,unknown>){
    const k=this.locate(id,i),e=this.check(k,b.revision)!;
    this.current(k,e);
    if(k.a.state!=='approved')return bad('Approve the storyboard before attaching the clip.');
    if(!e.video)return bad('Render the approved animation before attaching it.');
    const art=this.s.engine.list(k.project.id,{kind:'scene_asset'}).find(a=>a.scene_id===k.sceneId);
    if(!art)throw new EngineError('NOT_FOUND','Scene asset artifact not found.');
    if(art.state==='approved'&&b.reopen!==true)throw new EngineError('PROTECTED','Reopen the approved scene asset in Visuals before replacing it.');
    let assetId:string;
    try{
      const asset=await this.s.assets.importLocal(k.project.id,this.filename(k,e),{type:'motion_graphic',name:'Animated SVG: scene '+(i+1),license:{type:e.provider?'ai-generated':'other',commercial_use:'unknown',notes:'Approved animated scene. Verify rights to imported artwork and provider outputs before commercial use.'},provider:e.provider??'animated-svg-import',tags:['animated-svg'],params:{scene_id:k.sceneId,revision:e.revision}});
      assetId=asset.id;
    }catch(err){
      const x=err as EngineError;
      if(x.code!=='DUPLICATE_ASSET'||typeof (x.details as any)?.existing_id!=='string')throw err;
      assetId=(x.details as any).existing_id;
    }
    const fresh=this.check(k,b.revision)!;
    this.current(this.locate(id,i),fresh);
    if(this.locate(id,i).a.current_version_id!==k.a.current_version_id)throw new EngineError('STALE','Storyboard changed before attachment.');
    this.s.setSceneAssets(k.sceneId,[{asset_id:assetId,role:'primary'}],assetId,{reopen:b.reopen===true});
    return this.put(k,{...fresh,assetId,state:'attached'});
  }
}
