import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, lstat, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { EngineError } from '../engine.ts';
import type { JobCtx } from '../jobs.ts';
import { sha256File } from '../media.ts';
import type { TextLLMProvider } from '../providers/llm/types.ts';
import type { Studio } from '../services.ts';
import type { StoryboardContent } from '../studios/storyboard.ts';
import { FRAME } from '../research/sketch.ts';
import { bad, canonicalArtwork, drawFrame, drawingTarget, parseArtwork, readMotion, readRig } from './model.ts';
import { ANIMATED_SVG_PRESETS, animatedSvgRenderPreference, animatedSvgRenderCacheMatches, renderAnimatedSvg, renderAnimatedSvgFrame, type AnimatedSvgBackend } from './render.ts';
import { generateAnimatedArtwork, generateAnimatedScene, type GenerateAnimatedSceneOptions, type ImageReference } from './generate.ts';
import { buildAnimatedSketchPrompt } from './prompts.ts';
import { combineCharacterRigs, extractCharacter, placeCharacter, selectCharacterRig } from './character-rig.ts';
import { bindMotionClip, exportMotionClip } from './motion-clip.ts';
import { suggestDialogueCues } from './dialogue-timing.ts';
import { ANIMATED_OPTIONAL_STAGES, readAnimatedGenerationControls, readTimedMouthCues } from './generation-controls.ts';

export const animatedSvgDefaults = {mode:'static',quality:'professional',style:'dark-folklore',fps:30,complexity:'standard',character:true,environment:true,dialogue:false,camera:true,detail:70,strategy:'multi-pass',advancedShading:true,visualReview:true,reuseApproved:true,customDirection:''} as const;
const styles = 'archival-sepia dark-folklore cinematic-25d professional-cartoon anime folklore graphic-novel watercolor documentary motion-graphics minimalist historical-graphic-novel cinematic-anime painterly-storybook engraved-horror custom'.split(' ');
export function readSettings(o: Record<string,unknown> = {}) {
  const options = (k:keyof typeof animatedSvgDefaults, allowed:readonly unknown[]) => {
    const v=o[k]??animatedSvgDefaults[k];if(!allowed.includes(v))return bad('Invalid animation '+k+'.');return v;
  };
  const flag = (k:keyof typeof animatedSvgDefaults) => options(k,[true,false]) as boolean;
  const detail=o.detail??70;
  if(typeof detail!=='number'||!Number.isInteger(detail)||detail<0||detail>100)return bad('Detail must be from 0 to 100.');
  return {...readAnimatedGenerationControls(o),mode:options('mode',['static','animated','mixed']) as 'static'|'animated'|'mixed',quality:options('quality',['draft','standard','professional','studio']) as 'draft'|'standard'|'professional'|'studio',style:options('style',styles) as string,fps:options('fps',[24,30,60]) as 24|30|60,complexity:options('complexity',['basic','standard','advanced']) as 'basic'|'standard'|'advanced',character:flag('character'),environment:flag('environment'),dialogue:flag('dialogue'),camera:flag('camera'),detail,strategy:options('strategy',['single-pass','multi-pass']) as 'single-pass'|'multi-pass',advancedShading:flag('advancedShading'),visualReview:flag('visualReview'),reuseApproved:flag('reuseApproved'),customDirection:str(o.customDirection,2000)};
}
function str(v:unknown,max:number){if(v===undefined||v===null)return '';if(typeof v!=='string'||v.length>max)return bad('Animation text exceeds its allowed length.');return v.trim();}
function json(v:unknown,limit:number){if(v===undefined||v===null)return undefined;const x=JSON.stringify(v);if(x.length>limit)return bad('Animation metadata exceeds its allowed size.');return JSON.parse(x) as unknown;}
const generationOperations=['scene','artwork','motion','refine-motion'] as const;
type GenerationOperation=(typeof generationOperations)[number];
type ArtworkSource={kind:'still';assetId:string;sha256:string}|{kind:'animated';revision:string;sha256:string};
type Draft = {svg:string;animation?:ReturnType<typeof readMotion>;rig?:unknown;scene?:unknown;passes?:unknown;provider?:string};
type CapturedPrompts = Partial<Record<'baseArtwork'|'motion',string>>;
type VerifiedOutput = {token:string;sha256:string;bytes:number};
type Stored = Draft & {verifiedOutput?:VerifiedOutput;cameraBaked?:boolean;artworkHash?:string;artworkApproved?:boolean;artworkSource?:ArtworkSource;parentRevision?:string;prompts?:CapturedPrompts;sourceFingerprint?:string; revision:string;state:'draft'|'approved'|'rendered'|'attached';duration:number;layers:string[];assetId?:string;video?:{width:number;height:number;fps:number;frames:number;durationSeconds:number;backend?:AnimatedSvgBackend}};
type LibraryItem={id:string;revision:string;name:string;kind:string;groupId:string;createdAt:string;svg:string;rig_json:string|null};
type Key = ReturnType<AnimatedSvgStudio['locate']>;
export class AnimatedSvgStudio {
  private s:Studio;
  private referenceBatches=new Map<string,{provider:TextLLMProvider;model?:string;images:ImageReference[];settings:ReturnType<typeof readSettings>}>();
  private verifiedFiles=new Map<string,{stamp:string;confirmed:Promise<string>}>();
  private previews=new Map<string,{bytes:Buffer;until:number}>();
  private cueAnalysisActive=false;
  private previewsInFlight=new Map<string,Promise<Buffer>>();
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
      const {prompts,verifiedOutput:_privateOutput,...metadata}=entry;
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
    const db=this.s.engine.db, serialized=JSON.stringify(e);
    db.exec('SAVEPOINT wander_animated_revision');
    try {
      db.prepare('INSERT INTO animated_svg_revisions(storyboard_id,scene_id,revision,package_json) VALUES (?,?,?,?) ON CONFLICT(storyboard_id,scene_id,revision) DO UPDATE SET package_json=excluded.package_json')
        .run(k.a.id,k.sceneId,e.revision,serialized);
      db.prepare('INSERT INTO animated_svg_scenes(storyboard_id,scene_id,package_json) VALUES(?,?,?) ON CONFLICT(storyboard_id,scene_id) DO UPDATE SET package_json=excluded.package_json')
        .run(k.a.id,k.sceneId,serialized);
      db.exec('RELEASE wander_animated_revision');
    }catch(e){db.exec('ROLLBACK TO wander_animated_revision; RELEASE wander_animated_revision');throw e;}
    return e;
  }
  private revision(k:Key,revision:string):Stored{
    const row=this.s.engine.db.prepare('SELECT package_json FROM animated_svg_revisions WHERE storyboard_id=? AND scene_id=? AND revision=?')
      .get(k.a.id,k.sceneId,revision) as {package_json:string}|undefined;
    if(!row)throw new EngineError('NOT_FOUND','That scene revision was not found.');
    return JSON.parse(row.package_json);
  }
  history(id:string,i:number){
    const k=this.locate(id,i),current=this.get(k)?.revision;
    const rows=this.s.engine.db.prepare("SELECT revision,saved_at,json_extract(package_json,'$.state') AS state,json_extract(package_json,'$.parentRevision') AS parentRevision,json_extract(package_json,'$.artworkHash') AS artworkHash,json_type(package_json,'$.video')='object' AS hasVideo FROM animated_svg_revisions WHERE storyboard_id=? AND scene_id=? ORDER BY rowid DESC LIMIT 50").all(id,k.sceneId);
    return rows.map(row=>({...row,current:row.revision===current}));
  }
  private fingerprint(k:Key){const {scene_id:_,order_index:__,...scene}=k.scene;return createHash('sha256').update(JSON.stringify({format:k.format,scene})).digest('hex');}
  private current(k:Key,e:Stored){
    if(e.sourceFingerprint&&e.sourceFingerprint!==this.fingerprint(k))throw new EngineError('STALE','Storyboard direction changed. Edit or reimport the animation as a new draft before using it.');
  }
  private savePackage(k:Key,b:Record<string,unknown>,internal:{passes?:unknown;provider?:string;prompts?:CapturedPrompts;artworkOnly?:boolean;artworkApproved?:boolean;artworkSource?:ArtworkSource}={}) {
    const previous=this.check(k,b.revision,true);
    const d=parseArtwork(b.svg), svg=canonicalArtwork(d);
    const animation=internal.artworkOnly?undefined:readMotion(b.animation,d), rig=readRig(b.rig,d,animation??{duration:1,tracks:[]});
    const layers=[...d.ids].filter(([,el])=>el.tag==='g').map(([id])=>id);
    return this.put(k,{svg,animation,rig,scene:json(b.scene,64_000),passes:json(internal.passes,36_000),provider:internal.provider,prompts:internal.prompts,
      sourceFingerprint:this.fingerprint(k),revision:randomUUID(),parentRevision:previous?.revision,state:'draft',duration:animation?.duration??Math.min(60,Math.max(0.1,k.scene.target_duration??5)),layers,
      artworkHash:createHash('sha256').update(svg).digest('hex'),artworkApproved:internal.artworkApproved??false,artworkSource:internal.artworkSource});
  }
  import(id:string,i:number,b:Record<string,unknown>,internal?:{passes?:unknown;provider?:string;prompts?:CapturedPrompts;artworkSource?:ArtworkSource}) {
    return this.savePackage(this.locate(id,i),b,{...internal,artworkOnly:b.artworkOnly===true});
  }
  restoreRevision(id:string,i:number,b:Record<string,unknown>){
    const k=this.locate(id,i);
    if(typeof b.sourceRevision!=='string')return bad('Choose a previously saved revision.');
    const source=this.revision(k,b.sourceRevision);
    return this.savePackage(k,{svg:source.svg,animation:source.animation,rig:source.rig,scene:source.scene,revision:b.revision},
      {artworkOnly:!source.animation,provider:source.provider,artworkSource:{kind:'animated',revision:source.revision,sha256:source.artworkHash??createHash('sha256').update(source.svg).digest('hex')}});
  }
  copyApprovedStill(id:string,i:number,revision:unknown){
    const k=this.locate(id,i);this.check(k,revision,true);
    const art=this.s.engine.list(k.project.id,{kind:'scene_asset'}).find(x=>x.scene_id===k.sceneId);
    const primary=art&&this.s.engine.getContent(art.id) as {primary_asset_id?:string}|null|undefined;
    if(art?.state!=='approved'||!primary?.primary_asset_id)return bad('Approve a still illustration for this scene first.');
    const asset=this.s.assets.get(primary.primary_asset_id);
    if(asset.project_id!==k.project.id||asset.type!=='illustration'||asset.approval_status!=='approved')return bad('The approved primary asset is not a project still illustration.');
    const src=this.s.engine.db.prepare('SELECT svg,source_hash FROM storyboard_svg_sources WHERE asset_id=?').get(asset.id) as {svg:string;source_hash:string}|undefined;
    if(!src)throw new EngineError('NOT_FOUND','This still has no saved editable SVG. Import the original SVG or draw it again before copying.');
    if(createHash('sha256').update(src.svg).digest('hex')!==src.source_hash)return bad('The retained still source did not match its recorded hash.');
    return this.savePackage(k,{svg:src.svg,revision},{artworkOnly:true,artworkSource:{kind:'still',assetId:asset.id,sha256:src.source_hash}});
  }
  exportClip(id:string,i:number,b:Record<string,unknown>){
    const k=this.locate(id,i),e=this.check(k,b.revision)!;
    this.current(k,e);
    if(!e.animation||e.state==='draft')return bad('Approve the motion before exporting a reusable clip.');
    const drawing=parseArtwork(e.svg);
    return exportMotionClip(readMotion(e.animation,drawing),drawing,b.roles);
  }
  motionLibrary(){
    return this.s.engine.db.prepare('SELECT id,name,source_revision,created_at FROM animated_motion_library ORDER BY rowid DESC LIMIT 200').all();
  }
  motionLibraryClip(id:string){
    const row=this.s.engine.db.prepare('SELECT clip_json FROM animated_motion_library WHERE id=?').get(id) as {clip_json:string}|undefined;
    if(!row)throw new EngineError('NOT_FOUND','That reusable motion was not found.');
    return JSON.parse(row.clip_json) as unknown;
  }
  saveMotionClip(id:string,i:number,b:Record<string,unknown>){
    const clip=this.exportClip(id,i,b),name=str(b.name,100);
    if(!name)return bad('Name the reusable motion preset.');
    const count=this.s.engine.db.prepare('SELECT COUNT(*) AS n FROM animated_motion_library').get() as {n:number};
    if(count.n>=200)return bad('The reusable motion library is full. Export the motion as JSON instead.');
    const entry={id:randomUUID(),name,source_revision:b.revision as string};
    this.s.engine.db.prepare('INSERT INTO animated_motion_library(id,name,source_revision,clip_json) VALUES (?,?,?,?)')
      .run(entry.id,entry.name,entry.source_revision,JSON.stringify(clip));
    return entry;
  }
  bindClip(id:string,i:number,b:Record<string,unknown>){
    const k=this.locate(id,i),e=this.check(k,b.revision)!;
    this.current(k,e);
    if(!e.artworkApproved)return bad('Approve the destination artwork before binding motion.');
    const drawing=parseArtwork(e.svg);
    if(b.translationScale!==undefined&&typeof b.translationScale!=='number')return bad('Translation scale must be a number.');
    const animation=bindMotionClip(typeof b.libraryClipId==='string'?this.motionLibraryClip(b.libraryClipId):b.clip,drawing,{bindings:b.bindings,duration:Math.min(60,Math.max(0.1,k.scene.target_duration??5)),translationScale:b.translationScale});
    return this.savePackage(k,{svg:e.svg,animation,rig:e.rig,revision:e.revision,scene:{artwork:(e.scene as {artwork?:unknown}|undefined)?.artwork??(e.animation?undefined:e.scene),reusedMotion:true}},{artworkApproved:true,prompts:{baseArtwork:e.prompts?.baseArtwork},
      artworkSource:e.artworkSource?.kind==='still'?e.artworkSource:{kind:'animated',revision:e.revision,sha256:e.artworkHash??createHash('sha256').update(e.svg).digest('hex')}});
  }
  approveArtwork(id:string,i:number,revision:unknown){
    const k=this.locate(id,i),e=this.check(k,revision)!;
    this.current(k,e);
    if(e.artworkApproved)return e;
    if(!e.layers.length)return bad('Add named, drawable groups before approving artwork for motion.');
    return this.put(k,{...e,artworkApproved:true});
  }
  reuse(id:string,i:number,b:Record<string,unknown>){
    const k=this.locate(id,i);this.check(k,b.revision,true);
    if(typeof b.fromIndex!=='number'||b.fromIndex===i)return bad('Choose another approved scene.');
    const source=this.get(this.locate(id,b.fromIndex));
    if(!source?.animation||source.state==='draft')return bad('The source scene must have approved motion.');
    return this.import(id,i,{svg:source.svg,animation:source.animation,rig:source.rig,scene:{reusedFrom:source.revision,metadata:source.scene},revision:b.revision},{provider:source.provider});
  }
  approve(id:string,i:number,revision:unknown){
    const k=this.locate(id,i),e=this.check(k,revision)!;
    this.current(k,e);
    if(!e.animation)return bad('Approve the artwork, then generate or import motion before approving the animation.');
    if(e.state!=='draft')return e;
    return this.put(k,{...e,artworkApproved:true,state:'approved'});
  }
  private unbusy(projectId:string){
    const row=this.s.engine.db.prepare("SELECT 1 FROM jobs WHERE project_id=? AND kind IN ('animated_svg_generate','animated_svg_render') AND state IN ('queued','running') LIMIT 1").get(projectId);
    if(row)throw new EngineError('BUSY','An animation job is already running for this project.');
  }
  start(id:string,i:number,b:Record<string,unknown>,kind:'animated_svg_generate'|'animated_svg_render'){
    const k=this.locate(id,i), e=this.check(k,b.revision,kind==='animated_svg_generate');
    this.unbusy(k.project.id);
    if(kind==='animated_svg_generate'){
      const operation=b.operation??'scene';
      if(typeof operation!=='string'||!generationOperations.includes(operation as GenerationOperation))return bad('Unknown illustration generation operation.');
      if(operation==='motion'||operation==='refine-motion'){
        if(!e||!e.artworkApproved)return bad('Approve the exact artwork revision before generating or refining motion.');
        this.current(k,e);
        if(operation==='refine-motion'&&(!e.animation||b.targetLayerIds===undefined))return bad('Select motion targets in a scene with saved animation.');
      }
      if(b.consent!==true)return bad('Confirm the selected provider may receive the scene and reference notes.');
      const provider=this.s.llm.active();
      if(!provider)throw new EngineError('PROVIDER_ERROR','Choose an AI provider in Settings first.');
      if(b.expectedProvider!==undefined&&b.expectedProvider!==provider.id)throw new EngineError('STALE','The active provider changed. Review its name and confirm again.');
      const model=this.s.config.videoModels?.storyboard??this.s.config.selectedLLMModel??undefined;
      const targetLayerIds=b.targetLayerIds;
      const artworkStrategy=b.artworkStrategy;
      if(artworkStrategy!==undefined&&(
        operation!=='artwork'||targetLayerIds!==undefined||
        (artworkStrategy!=='single-pass'&&artworkStrategy!=='multi-pass')
      ))return bad('Choose Single pass or Multi-pass only when drawing new layered artwork.');
      if(targetLayerIds!==undefined&&operation==='motion')return bad('Use targeted motion refinement to select layers.');
      if(targetLayerIds!==undefined){
        if(!e||!Array.isArray(targetLayerIds)||!targetLayerIds.length||targetLayerIds.length>6||new Set(targetLayerIds).size!==targetLayerIds.length)
          return bad('Select up to six distinct named targets in the current artwork.');
        const d=operation==='refine-motion'?parseArtwork(e.svg):undefined;
        if(!targetLayerIds.every(x=>typeof x==='string'&&(d?drawingTarget(d,x):e.layers.includes(x))))
          return bad('Select up to six named drawable targets in the current artwork.');
      }
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
      const legacyVision=b.visionConsent===true;
      const analyzeVision=legacyVision||b.referenceVisionConsent===true, reviewVision=artworkStrategy!=='single-pass'&&(legacyVision||b.reviewVisionConsent===true);
      if(images.length&&!analyzeVision)return bad('Confirm that reference images may be sent to the selected provider.');
      if((analyzeVision||reviewVision)&&typeof provider.generateVision!=='function')return bad('This provider has no image-capable adapter. Use the reference notes or select a supported vision model.');
      if((analyzeVision||reviewVision)&&b.expectedProvider!==provider.id)return bad('Confirm image use for the currently selected provider.');
      const brief=str(b.brief,5000),referenceNotes=str(b.referenceNotes,3000);
      const referenceBatch=randomUUID();
      if(this.referenceBatches.size>=12)throw new EngineError('BUSY','Generation queue is full.');
      if((operation==='motion'||operation==='refine-motion')&&(reuseLayer||libraryReuse||images.length))return bad('Motion-only generation cannot replace artwork or analyze new image references.');
      const projectSettings=readSettings(k.project.settings.animatedSvg as Record<string,unknown>|undefined);
      // An explicit single-pass job draws once. Separately consented reference-image analysis may still run.
      const settings=artworkStrategy===undefined?projectSettings:{
        ...projectSettings,strategy:artworkStrategy as 'single-pass'|'multi-pass',
        ...(artworkStrategy==='single-pass'?{
          visualReview:false,
          stages:{...projectSettings.stages,...Object.fromEntries(ANIMATED_OPTIONAL_STAGES
            .filter(stage=>stage!=='referenceAnalysis').map(stage=>[stage,false]))},
        }:{}),
      };
      const dialogueCues=readTimedMouthCues(b.dialogueCues,Math.min(60,Math.max(0.1,k.scene.target_duration??5)));
      if(dialogueCues?.length&&(operation!=='motion'||!settings.dialogue))return bad('Enable dialogue and request motion before supplying timed mouth cues.');
      this.referenceBatches.set(referenceBatch,{provider,model,images,settings});
      setTimeout(()=>this.referenceBatches.delete(referenceBatch),60*60*1000).unref();
      return {job:this.s.jobs.enqueue(kind,{projectId:k.project.id,artifactId:id,params:{id,i,sceneId:k.sceneId,storyboardVersion:k.a.current_version_id,revision:e?.revision,provider:provider.id,brief,referenceNotes,targetLayerIds,reuseLayer,libraryReuse,analyzeVision,reviewVision,operation,artworkStrategy,dialogueCues,referenceBatch}})};
    }
    if(e)this.current(k,e);
    if(e?.state==='attached')return bad('Save a new draft to render a replacement for an attached clip.');
    if(!e?.animation||(e.state!=='approved'&&e.state!=='rendered'))return bad('Approve the animation first.');
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
  private filename(k:Key,e:Stored){
    const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
    const token=e.verifiedOutput?.token;
    if(!uuid.test(e.revision)||token!==undefined&&!uuid.test(token))return bad('Invalid stored render identifier.');
    return join(this.dir(k),e.revision+(token?'-'+token:'')+'.mp4');
  }
  private async verifiedClip(k:Key,e:Stored,requireDigest=false){
    const path=this.filename(k,e);
    const file=await lstat(path).catch(()=>undefined);
    if(!file?.isFile()||!file.size)throw new EngineError('NOT_FOUND','The rendered clip is missing. Render this revision again.');
    const expected=e.verifiedOutput;
    if(!expected){
      if(requireDigest)throw new EngineError('RENDER_VERIFY','Run a fresh render to verify this older clip.');
      return {path,bytes:file.size};
    }
    const damaged=()=>new EngineError('RENDER_VERIFY','The rendered clip changed on disk. Render this revision again before using it.');
    if(file.size!==expected.bytes)throw damaged();
    const identify=(f:typeof file)=>[f.dev,f.ino,f.size,f.mtimeMs,f.ctimeMs,expected.sha256].join(':');
    const stamp=identify(file);
    let record=this.verifiedFiles.get(path);
    if(record?.stamp!==stamp){
      const confirmed=sha256File(path).then(async digest=>{
        const after=await lstat(path);
        if(!after.isFile()||identify(after)!==stamp)throw damaged();
        return digest;
      });
      record={stamp,confirmed};
      if(this.verifiedFiles.size>=16)this.verifiedFiles.delete(this.verifiedFiles.keys().next().value!);
      this.verifiedFiles.set(path,record);
    }
    let sha:string;
    try{sha=await record.confirmed;}catch{
      if(this.verifiedFiles.get(path)===record)this.verifiedFiles.delete(path);
      throw damaged();
    }
    if(sha!==expected.sha256)throw damaged();
    return {path,bytes:file.size};
  }
  private async raster(svg:string,w:number,h:number,signal?:AbortSignal){
    const dir=join(this.s.config.root,'cache');await mkdir(dir,{recursive:true});const temp=await mkdtemp(join(dir,'svg-preview-'));
    try{
      const outputPath=join(temp,'preview.png');
      await renderAnimatedSvgFrame({svg,outputPath,width:w,height:h,assertSafeSvg:parseArtwork,ffprobeOverride:this.s.config.ffprobePath,signal});
      return await readFile(outputPath);
    }finally{await rm(temp,{recursive:true,force:true});}
  }
  private dims(k:Key,edge:number){const even=(n:number)=>Math.round(n/2)*2;const max=(edge===2160?3840:Infinity),r=Math.min(edge/Math.min(k.size.w,k.size.h),max/Math.max(k.size.w,k.size.h));return {width:even(k.size.w*r),height:even(k.size.h*r)};}
  async preview(id:string,i:number,t:number,revision?:string,artworkOnly=false,historical=false){
    const k=this.locate(id,i),e=revision?(historical?this.revision(k,revision):this.check(k,revision)):this.get(k);
    if(!e)throw new EngineError('NOT_FOUND','No animated artwork for this scene.');
    if(!Number.isFinite(t))return bad('Use a finite preview time.');
    const {width,height}=this.dims(k,360),backend=animatedSvgRenderPreference();
    const time=artworkOnly?0:Math.max(0,Math.min(e.duration,t));
    const key=[e.revision,width,height,backend,artworkOnly,time].join(':');
    const now=Date.now(),cached=this.previews.get(key),pending=this.previewsInFlight.get(key);
    if(cached&&cached.until>now)return cached.bytes;
    if(pending)return pending;
    if(this.previewsInFlight.size>=3)throw new EngineError('BUSY','Other frames are previewing; retry shortly.');
    const d=parseArtwork(e.svg),m=e.animation&&!artworkOnly?readMotion(e.animation,d):{duration:e.duration,tracks:[]};
    const run=this.raster(drawFrame(d,m,time,width,height),width,height).then(bytes=>{
      for(const [entry,old] of this.previews)if(old.until<=Date.now())this.previews.delete(entry);
      if(bytes.byteLength<=1_000_000){
        if(this.previews.size>=8)this.previews.delete(this.previews.keys().next().value!);
        this.previews.set(key,{bytes,until:Date.now()+12_000});
      }
      return bytes;
    }).finally(()=>this.previewsInFlight.delete(key));
    this.previewsInFlight.set(key,run);
    return run;
  }
  async dialogueTiming(id:string,i:number,wav:unknown,recognizer:unknown){
    const k=this.locate(id,i);
    if(!readSettings(k.project.settings.animatedSvg as Record<string,unknown>|undefined).dialogue)
      return bad('Enable dialogue in the project settings first.');
    if(this.cueAnalysisActive)throw new EngineError('BUSY','Finish the current local dialogue analysis first.');
    this.cueAnalysisActive=true;
    try {
      return await suggestDialogueCues(wav,Math.min(60,Math.max(.1,k.scene.target_duration??5)),recognizer??'phonetic');
    }finally{this.cueAnalysisActive=false;}
  }
  capturedPrompt(id:string,i:number,revision:unknown,stage:keyof CapturedPrompts){
    const prompt=this.check(this.locate(id,i),revision)?.prompts?.[stage];
    if(!prompt)throw new EngineError('NOT_FOUND','This revision does not have a captured prompt for that stage.');
    return {prompt};
  }
  async generate(ctx:JobCtx) {
    const p=ctx.params,k=this.jobKey(ctx),e=this.check(k,p.revision,true);
    const operation=(p.operation??'scene') as GenerationOperation;
    const pinned=this.referenceBatches.get(p.referenceBatch);
    this.referenceBatches.delete(p.referenceBatch);
    if(!pinned)return bad('Provider selection expired. Choose Generate again to confirm the current provider.');
    const {provider,model,images,settings}=pinned;
    const artOnly=operation==='artwork'||(operation==='scene'&&!!e&&!e.animation);
    const baseArtworkPrompt=buildAnimatedSketchPrompt(k.scene,{
      size:k.size,category:k.project.category??undefined,number:k.index+1,total:k.total,
      styleNotes:k.styleNotes,captionSpace:k.project.settings.reserve_caption_space===true,
    });
    const additionalArt=artOnly&&!p.targetLayerIds&&p.brief&&p.brief!==k.scene.visual_description.trim()?p.brief:undefined;
    const stageDefaults=artOnly&&settings.strategy==='multi-pass'?{artDirection:true,renderedReview:settings.visualReview,targetedCorrections:true}:{};
    const reusable=settings.reuseApproved?this.list(k.a.id).filter((v,i)=>i!==k.index&&v&&v.state!=='draft').slice(0,6):[];
    const vision = provider.generateVision?.bind(provider);
    const reuse=reusable.map(x=>({id:x!.revision,version:x!.revision,kind:'background',notes:'Approved scene layers: '+x!.layers.join(', '),layers:undefined as {target:string;svg:string}[]|undefined}));
    const characterRigs:ReturnType<typeof extractCharacter>['rig'][]=[];
    if(p.reuseLayer){
      const r=p.reuseLayer,source=this.get(this.locate(p.id,r.fromIndex));
      if(!source||source.state==='draft'||source.revision!==r.revision)throw new EngineError('STALE','The selected approved reuse source changed.');
      const {layer,rig}=extractCharacter(source.svg,source.rig,r.sourceGroupId,r.targetId);
      reuse.unshift({id:source.revision,version:source.revision,kind:'background',notes:'Use the approved locked group at the named placeholder.',layers:[layer]});
      characterRigs.push(rig);
    }
    if(p.libraryReuse){
      const asset=this.libraryItem(p.libraryReuse.id);
      const {layer,rig}=extractCharacter(asset.svg,this.libraryRig(asset),asset.groupId,p.libraryReuse.targetId);
      reuse.unshift({id:asset.id,version:asset.revision,kind:asset.kind,notes:'Explicitly selected immutable library artwork',layers:[layer]});
      characterRigs.push(rig);
    }
    const reusedRig=combineCharacterRigs(characterRigs);
    const motionOperation=operation==='motion'||operation==='refine-motion';
    const prompts:CapturedPrompts=motionOperation?{baseArtwork:e?.prompts?.baseArtwork}:{};
    const opts:GenerateAnimatedSceneOptions={
      provider,model,settings:{...settings,reuseApproved:settings.reuseApproved||!!p.reuseLayer||!!p.libraryReuse,stages:{...stageDefaults,...settings.stages}},
      baseArtworkPrompt:additionalArt?baseArtworkPrompt+'\nAdditional scene artwork direction: '+additionalArt:baseArtworkPrompt,
      dialogueCues:p.dialogueCues,
      scene:{id:k.sceneId,visualDescription:[k.scene.visual_description,p.brief].filter(Boolean).join('\n'),duration:Math.min(60,Math.max(0.1,k.scene.target_duration??5)),width:k.size.w,height:k.size.h,context:k.scene.animation_plan?JSON.stringify(k.scene.animation_plan):undefined},
      referenceNotes:p.referenceNotes,
      reuse,images,
      ...(vision&&(p.analyzeVision||p.vision)?{analyzeReferences:({images:refs,prompt,signal})=>vision({model,prompt,images:refs.map(x=>x.bytes),signal})}:{}),
      ...(vision&&(p.reviewVision||p.vision)?{visionReview:({image,prompt,signal})=>vision({model,prompt,images:[image],signal})}:{}),
      ...(operation==='motion'&&e?{motionOnly:{svg:e.svg,scene:e.scene,rig:e.rig}}:{}),
      ...(operation==='refine-motion'&&e?{refineMotion:{svg:e.svg,animation:e.animation,rig:e.rig,scene:e.scene,targetLayerIds:p.targetLayerIds,notes:p.brief}}:{}),
      ...(!motionOperation&&e&&p.targetLayerIds?{refine:{svg:e.svg,animation:e.animation,rig:e.rig,scene:e.scene,targetLayerIds:p.targetLayerIds,notes:p.brief}}:{}),
      signal:ctx.signal,
      onPromptRequest:(stage,prompt)=>{if(Buffer.byteLength(prompt,'utf8')<=128_000)prompts[stage]=prompt;},
      onProgress:(fraction,message)=>ctx.progress(fraction,message),
      validateArtwork:parseArtwork,
      validate:(v)=>{const d=parseArtwork(v.svg);const m=readMotion(v.animation,d);readRig(reusedRig??v.rig,d,m);},
      rasterizePreview:(svg,signal)=>{const d=parseArtwork(svg);const {width,height}=this.dims(k,360);return this.raster(drawFrame(d,{duration:1,tracks:[]},0,width,height),width,height,signal);},
    };
    this.check(k,p.revision,true);
    if(motionOperation&&(!e?.artworkApproved))return bad('This artwork revision has not been approved.');
    const generated=artOnly?await generateAnimatedArtwork(opts):await generateAnimatedScene(opts);
    this.jobKey(ctx);
    if(ctx.signal.aborted)throw new EngineError('CANCELLED','Animation generation cancelled.');
    if(motionOperation&&generated.svg!==e?.svg)throw new EngineError('PROVIDER_ERROR','A motion-only request attempted to change artwork.');
    const metadata:Record<string,unknown>={metadata:'scene' in generated?generated.scene:undefined,artPlan:generated.artPlan,review:generated.review,finalReview:generated.finalReview,referenceAnalysis:generated.referenceAnalysis,reused:generated.reused,preparation:generated.preparation};
    if(motionOperation){
      const prior=e?.scene as {artwork?:unknown;metadata?:unknown;characterPlacements?:unknown}|undefined;
      metadata.characterPlacements=prior?.characterPlacements;
      metadata.artwork=prior?.artwork??(e?.animation?undefined:prior);
      if(operation==='refine-motion')metadata.metadata=prior?.metadata??prior;
    }
    const saved=this.savePackage(k,{...generated,rig:reusedRig??((motionOperation||p.targetLayerIds)?e?.rig:undefined)??('rig' in generated?generated.rig:undefined),revision:p.revision,scene:metadata},{passes:generated.passes,provider:provider.id,prompts,artworkOnly:artOnly,artworkApproved:motionOperation,
      artworkSource:motionOperation&&e?.artworkHash?(e.artworkSource?.kind==='still'?e.artworkSource:{kind:'animated',revision:e.revision,sha256:e.artworkHash}):e&&p.targetLayerIds&&e.artworkHash?{kind:'animated',revision:e.revision,sha256:e.artworkHash}:undefined});
    return {revision:saved.revision,state:saved.state};
  }
  async render(ctx:JobCtx){
    const p=ctx.params,k=this.jobKey(ctx),e=this.check(k,p.revision)!;
    this.current(k,e);
    if(!e.animation||e.state==='draft'||e.state==='attached')return bad('Approve an unattached animation first.');
    const d=parseArtwork(e.svg), m=readMotion(e.animation,d);
    if(typeof p.preset!=='string'||!Object.hasOwn(ANIMATED_SVG_PRESETS,p.preset))return bad('Unknown render preset.');
    const preset=ANIMATED_SVG_PRESETS[p.preset as keyof typeof ANIMATED_SVG_PRESETS],{width,height}=this.dims(k,preset.shortEdge);
    const fps=p.preset==='ultra'?readSettings(k.project.settings.animatedSvg as Record<string,unknown>|undefined).fps:preset.fps;
    const backend=animatedSvgRenderPreference();
    if(e.video?.width===width&&e.video.height===height&&e.video.fps===fps&&animatedSvgRenderCacheMatches(e.video.backend,backend)&&await this.verifiedClip(k,e,true).then(()=>true,()=>false)){ctx.progress(1,'Using existing verified render');return {revision:e.revision,video:e.video};}
    await mkdir(this.dir(k),{recursive:true});
    const cache=join(this.s.config.root,'cache');await mkdir(cache,{recursive:true});
    const staging=await mkdtemp(join(cache,'animated-svg-'));
    let candidate:string|undefined;
    try{
      const temporary=join(staging,'scene.mp4');
      let lastBucket=-1,lastStage='';
      const {outputPath:_,...video}=await renderAnimatedSvg({outputPath:temporary,width,height,fps,durationSeconds:m.duration,backend,
        onBackend:(name)=>ctx.progress(.01,`Preparing ${name} animation frames`),frameAt:(t)=>drawFrame(d,m,t,width,height),
        assertSafeSvg:parseArtwork,ffprobeOverride:this.s.config.ffprobePath,signal:ctx.signal,onProgress:p=>{
          const part=p.completed/Math.max(1,p.total);
          const raw=p.stage==='frames'?.02+.76*part:p.stage==='encoding'?.79+.17*part:.98;
          const bucket=Math.floor(raw*50);
          if(p.stage===lastStage&&bucket<=lastBucket)return;
          lastStage=p.stage;lastBucket=bucket;
          ctx.progress(raw,p.stage==='frames'?'Preparing animation frames':p.stage==='encoding'?'Encoding MP4':'Verifying output');
        }});
      const [sha,file]=await Promise.all([sha256File(temporary),lstat(temporary)]);
      this.jobKey(ctx);
      const fresh=this.check(k,p.revision)!;
      if(ctx.signal.aborted)throw new EngineError('CANCELLED','Animation render cancelled.');
      const verifiedOutput={token:randomUUID(),sha256:sha,bytes:file.size};
      const next={...fresh,verifiedOutput,video,state:'rendered' as const};
      candidate=this.filename(k,next);
      await rename(temporary,candidate);
      this.jobKey(ctx);
      const latest=this.check(k,p.revision)!;
      if(latest.state==='attached')throw new EngineError('STALE','This revision was already attached. Its render was not replaced.');
      if(ctx.signal.aborted)throw new EngineError('CANCELLED','Animation render cancelled.');
      this.put(k,next);
      candidate=undefined; // the database now owns the new file
      if(fresh.video){
        const prior=this.filename(k,fresh);
        this.verifiedFiles.delete(prior);
        void rm(prior,{force:true}).catch(()=>{});
      }
      return {revision:fresh.revision,video};
    }catch(error){
      if(candidate)await rm(candidate,{force:true}).catch(()=>{});
      throw error;
    }finally{await rm(staging,{recursive:true,force:true});}
  }
  private libraryItem(id:string):LibraryItem{
    const row=this.s.engine.db.prepare('SELECT * FROM animated_svg_library WHERE id=?').get(id);
    if(!row)throw new EngineError('NOT_FOUND','Reusable vector layer not found.');
    return row as unknown as LibraryItem;
  }
  private libraryRig(asset:LibraryItem):unknown{
    return asset.rig_json?JSON.parse(asset.rig_json):undefined;
  }
  library(){
    return this.s.engine.db.prepare('SELECT id,revision,name,kind,groupId,createdAt,rig_json IS NOT NULL AS hasRig FROM animated_svg_library ORDER BY createdAt DESC LIMIT 200').all()
      .map(row=>({...row,hasRig:!!row.hasRig}));
  }
  placeLibraryCharacter(id:string,i:number,b:Record<string,unknown>){
    const k=this.locate(id,i),e=this.check(k,b.revision)!;
    this.current(k,e);
    if(typeof b.libraryId!=='string'||typeof b.targetId!=='string')return bad('Choose a saved character and a receiving group.');
    const asset=this.libraryItem(b.libraryId);
    if(asset.kind!=='character'||!asset.rig_json)return bad('Choose a saved character with a rig.');
    const placed=placeCharacter(e.svg,e.rig,asset.svg,this.libraryRig(asset),asset.groupId,b.targetId);
    const previous=e.scene as {artwork?:unknown;characterPlacements?:unknown[]}|undefined;
    const placements=Array.isArray(previous?.characterPlacements)?previous.characterPlacements.slice(-19):[];
    return this.savePackage(k,{...placed,revision:e.revision,scene:{artwork:previous?.artwork,characterPlacements:[...placements,{libraryId:asset.id,sourceRevision:asset.revision,targetId:b.targetId}]}},
      {artworkOnly:true,artworkSource:{kind:'animated',revision:e.revision,sha256:e.artworkHash??createHash('sha256').update(e.svg).digest('hex')}});
  }
  promote(id:string,i:number,b:Record<string,unknown>){
    const k=this.locate(id,i),e=this.check(k,b.revision)!;
    this.current(k,e);
    if(e.state==='draft'&&!e.artworkApproved)return bad('Approve artwork before adding a reusable layer.');
    const name=str(b.name,120);
    if(!name||typeof b.groupId!=='string'||!e.layers.includes(b.groupId)||typeof b.kind!=='string'||!['character','background','prop','environment','effect'].includes(b.kind))return bad('Name the approved layer and select its type.');
    const count=(this.s.engine.db.prepare('SELECT COUNT(*) AS n FROM animated_svg_library').get() as {n:number}).n;
    if(count>=200)return bad('The reusable vector library is full.');
    const duplicate=this.s.engine.db.prepare('SELECT id,revision,name,kind,groupId,createdAt,rig_json IS NOT NULL AS hasRig FROM animated_svg_library WHERE revision=? AND groupId=?').get(e.revision,b.groupId);
    if(duplicate)return {...duplicate,hasRig:!!duplicate.hasRig};
    const rig=selectCharacterRig(e.svg,b.kind==='character'?e.rig:undefined,b.groupId);
    const entry={id:randomUUID(),revision:e.revision,name,kind:b.kind,groupId:b.groupId,createdAt:new Date().toISOString(),hasRig:!!rig};
    this.s.engine.db.prepare('INSERT INTO animated_svg_library(id,revision,name,kind,groupId,createdAt,svg,rig_json) VALUES (?,?,?,?,?,?,?,?)')
      .run(entry.id,entry.revision,entry.name,entry.kind,entry.groupId,entry.createdAt,e.svg,rig?JSON.stringify(rig):null);
    return entry;
  }
  part(id:string,i:number,name:string,revision?:string){
    const k=this.locate(id,i),e=revision?this.revision(k,revision):this.get(k);
    if(!e)throw new EngineError('NOT_FOUND','No package for this scene.');
    const data:Record<string,unknown>={'animation.json':e.animation,'rig.json':e.rig,'scene.json':{id:k.sceneId,revision:e.revision,duration:e.duration,state:e.state,provider:e.provider,artworkHash:e.artworkHash,artworkApproved:e.artworkApproved,artworkSource:e.artworkSource,parentRevision:e.parentRevision,metadata:e.scene,passes:e.passes,layers:e.layers,video:e.video}};
    if(name==='scene.svg')return {mime:'image/svg+xml',bytes:Buffer.from(canonicalArtwork(parseArtwork(e.svg)))};
    if(!Object.hasOwn(data,name)||data[name]===undefined)throw new EngineError('NOT_FOUND','This package file is unavailable.');
    return {mime:'application/json',bytes:Buffer.from(JSON.stringify(data[name],null,2))};
  }
  async video(id:string,i:number,revision?:string,historical=false){
    const k=this.locate(id,i),e=revision?(historical?this.revision(k,revision):this.check(k,revision)):this.get(k);
    if(!e?.video)throw new EngineError('NOT_FOUND','Render a video first.');
    return this.verifiedClip(k,e);
  }
  async attach(id:string,i:number,b:Record<string,unknown>){
    const k=this.locate(id,i),e=this.check(k,b.revision)!;
    this.current(k,e);
    if(k.a.state!=='approved')return bad('Approve the storyboard before attaching the clip.');
    if(!e.video)return bad('Render the approved animation before attaching it.');
    this.unbusy(k.project.id);
    const art=this.s.engine.list(k.project.id,{kind:'scene_asset'}).find(a=>a.scene_id===k.sceneId);
    if(!art)throw new EngineError('NOT_FOUND','Scene asset artifact not found.');
    if(art.state==='approved'&&b.reopen!==true)throw new EngineError('PROTECTED','Reopen the approved scene asset in Visuals before replacing it.');
    const sceneMeta=e.scene as {cameraBaked?:unknown;metadata?:{cameraBaked?:unknown}}|undefined;
    const cameraBaked=sceneMeta?.metadata?.cameraBaked===true||sceneMeta?.cameraBaked===true;
    const sourceFingerprint=e.sourceFingerprint??this.fingerprint(k);
    const attachment={camera_baked:cameraBaked,source_fingerprint:sourceFingerprint,duration_seconds:e.video.durationSeconds};
    const original=e.artworkSource?.kind==='still'?e.artworkSource.assetId:undefined;
    let assetId:string;
    try{
      const {path}=await this.verifiedClip(k,e);
      const asset=await this.s.assets.importLocal(k.project.id,path,{type:'motion_graphic',name:'Animated SVG: scene '+(i+1),license:{type:e.provider?'ai-generated':'other',commercial_use:'unknown',notes:'Approved animated scene. Verify rights to imported artwork and provider outputs before commercial use.'},provider:e.provider??'animated-svg-import',tags:['animated-svg'],params:{scene_id:k.sceneId,revision:e.revision,animated_svg:attachment,...(original?{source_asset_id:original}:{})}});
      assetId=asset.id;
    }catch(err){
      const x=err as EngineError;
      if(x.code!=='DUPLICATE_ASSET'||typeof (x.details as any)?.existing_id!=='string')throw err;
      assetId=(x.details as any).existing_id;
      const existing=this.s.assets.get(assetId);
      const meta=existing.params.animated_svg as {camera_baked?:unknown;source_fingerprint?:unknown}|undefined;
      if(existing.params.scene_id!==k.sceneId||meta?.source_fingerprint!==sourceFingerprint||meta.camera_baked!==cameraBaked)
        throw new EngineError('DUPLICATE_ASSET','Identical video already exists with a different scene or provenance. Render this scene with a different preset or revision.');
    }
    const fresh=this.check(k,b.revision)!;
    this.current(this.locate(id,i),fresh);
    if(fresh.verifiedOutput?.token!==e.verifiedOutput?.token)throw new EngineError('STALE','The render changed before attachment. Review the latest clip.');
    this.unbusy(k.project.id);
    if(this.locate(id,i).a.current_version_id!==k.a.current_version_id)throw new EngineError('STALE','Storyboard changed before attachment.');
    this.s.setSceneAssets(k.sceneId,[{asset_id:assetId,role:'primary'}],assetId,{reopen:b.reopen===true});
    return this.put(k,{...fresh,assetId,cameraBaked,state:'attached'});
  }
}
