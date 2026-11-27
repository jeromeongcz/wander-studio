import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { SaxesParser } from 'saxes';
import { EngineError } from '../engine.ts';

// Use GSAP only for trusted, seekable numeric/color interpolation. No timers, DOM, or generated JavaScript.
const { gsap } = createRequire(import.meta.url)('gsap') as typeof import('gsap');
const easing = { linear: gsap.parseEase('none'), easeIn: gsap.parseEase('power1.in'), easeOut: gsap.parseEase('power1.out'), smooth: (t:number) => t*t*(3-2*t) } as const;
const textTags = new Set(['title','desc','text','tspan','textPath']);
export const bad = (message: string): never => { throw new EngineError('VALIDATION', message); };
const NS = 'http://www.w3.org/2000/svg';
const tags = new Set('svg g path rect circle ellipse line polyline polygon defs use symbol marker title desc text tspan textPath linearGradient radialGradient stop clipPath mask pattern filter feGaussianBlur feOffset feMerge feMergeNode feBlend feColorMatrix feFlood feComposite feTurbulence feDisplacementMap feDropShadow feComponentTransfer feFuncR feFuncG feFuncB feFuncA feMorphology feTile feDiffuseLighting feSpecularLighting feDistantLight fePointLight feSpotLight'.split(' '));
const attrs = new Set('id width height viewBox preserveAspectRatio d x y x1 y1 x2 y2 cx cy fx fy rx ry r points transform opacity fill fill-rule fill-opacity stroke stroke-width stroke-opacity stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit clip-path clip-rule mask filter color vector-effect gradientUnits gradientTransform spreadMethod offset stop-color stop-opacity clipPathUnits maskUnits maskContentUnits patternUnits patternContentUnits patternTransform filterUnits primitiveUnits in in2 result stdDeviation dx dy mode type values value operator k1 k2 k3 k4 baseFrequency numOctaves seed scale xChannelSelector yChannelSelector flood-color flood-opacity tableValues slope intercept amplitude exponent radius color-interpolation-filters href xlink:href display visibility font-family font-size font-weight font-style font-variant font-stretch letter-spacing word-spacing text-anchor dominant-baseline alignment-baseline baseline-shift textLength lengthAdjust startOffset method spacing rotate style marker-start marker-mid marker-end markerWidth markerHeight markerUnits refX refY orient paint-order surfaceScale diffuseConstant kernelUnitLength specularConstant specularExponent lighting-color azimuth elevation z pointsAtX pointsAtY pointsAtZ limitingConeAngle'.split(' '));
// Convert a bounded subset of inline presentation declarations to attributes. Never pass CSS rules to a renderer.
const paintRefs = new Set(['fill','stroke','clip-path','mask','filter','marker-start','marker-mid','marker-end']);
const styleAttrs = new Set('display visibility opacity fill fill-rule fill-opacity stroke stroke-width stroke-opacity stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit clip-path clip-rule mask filter color vector-effect stop-color stop-opacity flood-color flood-opacity color-interpolation-filters font-family font-size font-weight font-style font-variant font-stretch letter-spacing word-spacing text-anchor dominant-baseline alignment-baseline baseline-shift marker-start marker-mid marker-end paint-order lighting-color'.split(' '));
function styleDeclarations(value:string): [string,string][] {
  if(value.length>2200||/[\\{}!<>@]/.test(value)||value.includes('/*'))return bad('Unsupported SVG inline styling.');
  const p=value.split(';').map((v)=>v.trim()).filter(Boolean);
  if(p.length>24)return bad('Too many inline SVG style declarations.');
  return p.map((pair)=>{
    const i=pair.indexOf(':'); const key=pair.slice(0,i).trim().toLowerCase(); const val=pair.slice(i+1).trim();
    if(i<1||!styleAttrs.has(key)||!val||val.length>180||!/^[-+%,.()#'" a-zA-Z0-9]+$/.test(val))return bad('Unsupported SVG inline style: '+key+'.');
    return [key,val];
  });
}
const idRx = /^[A-Za-z_][A-Za-z0-9_.:-]{0,95}$/;
const escape = (v: string) => v.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
type El = {tag:string; attr:Record<string,string>; children:(El|string)[]; parent?:El};
export type Drawing = {root:El; ids:Map<string,El>; size:[number,number]};
export function parseArtwork(svg: unknown): Drawing {
  if (typeof svg !== 'string' || !svg.trim() || Buffer.byteLength(svg)>600_000) return bad('Artwork must be one SVG under 600 KB.');
  if (/<!DOCTYPE|<!ENTITY/i.test(svg)) return bad('SVG declarations are not allowed.');
  const ids = new Map<string,El>(); const stack:El[]=[]; const refs: [El,string][]=[]; let root:El|undefined; let count=0; let textLength=0;
  const p = new SaxesParser({xmlns:true});
  p.on('error',()=>bad('Invalid SVG XML.'));
  p.on('processinginstruction',()=>bad('SVG processing instructions are not allowed.'));
  p.on('opentag',(el)=>{
    if (el.uri!==NS || !tags.has(el.local) || el.prefix || (stack.length>48) || ++count>8000) return bad('Unsupported SVG element or drawing complexity: '+el.local+'.');
    const parent=stack.at(-1);
    if ((!parent && el.local!=='svg') || el.local==='svg' && parent) return bad('Use one root SVG.');
    const node:El={tag:el.local,attr:Object.create(null),children:[],parent};
    let inline: [string,string][] = [];
    const attribute=(k:string,v:string)=>{
      if(v.length>50_000 || /[\\<>\x00-\x08]|(?:https?|file|data|javascript)\s*:|@import/i.test(v))return bad('External SVG resources are not allowed.');
      if(k==='numOctaves' && (!/^\d$/.test(v)||Number(v)>4))return bad('SVG texture complexity exceeds the limit.');
      if(k==='stdDeviation' && (!/^\d+(?:\.\d+)?(?: \d+(?:\.\d+)?)?$/.test(v)||v.split(' ').some(x=>Number(x)>45)))return bad('SVG blur exceeds the limit.');
      if(k==='id'){if(!idRx.test(v)||ids.has(v))return bad('SVG layer IDs must be valid and unique.');ids.set(v,node);}
      if(k==='href'){
        if(!['use','linearGradient','radialGradient','pattern','textPath'].includes(node.tag) || !v.startsWith('#') || !idRx.test(v.slice(1)))return bad('Only internal SVG references are allowed.');
        refs.push([node,v.slice(1)]);
      }
      if(/url\s*\(/i.test(v)){
        const ref=/^url\(#([A-Za-z_][A-Za-z0-9_.:-]{0,95})\)$/.exec(v);
        if(!ref||!paintRefs.has(k))return bad('Unsupported SVG paint reference.');
        refs.push([node,ref[1]]);
      }
      if(k==='display' && !['inline','none'].includes(v) || k==='visibility' && !['visible','hidden'].includes(v))return bad('Unsupported SVG visibility setting.');
      node.attr[k]=v;
    };
    for(const a of Object.values(el.attributes)){
      if(a.name==='xmlns' && !parent && a.value===NS)continue;
      if(a.name==='xmlns:xlink' && !parent && a.value==='http://www.w3.org/1999/xlink')continue;
      if(!attrs.has(a.name) || a.name==='xlink:href' && a.uri!=='http://www.w3.org/1999/xlink')return bad('Unsupported SVG attribute: '+a.name+'.');
      const k=a.name==='xlink:href'?'href':a.name; const v=a.value.trim();
      if(k==='style')inline=styleDeclarations(v);else attribute(k,v);
    }
    for(const [k,v] of inline)attribute(k,v);
    if(parent)parent.children.push(node);else root=node; stack.push(node);
  });
  p.on('closetag',()=>{stack.pop();});
  p.on('text',(s)=>{
    const el=stack.at(-1);
    if(el && textTags.has(el.tag)){
      textLength+=s.length;
      if(s.length>1500||textLength>10_000)return bad('SVG lettering exceeds the text limit.');
      el.children.push(s);
    } else if(s.trim())return bad('Only named SVG text elements can contain text.');
  });
  p.on('cdata',()=>bad('SVG CDATA is not allowed.')); p.write(svg).close();
  if(!root)return bad('Missing SVG.');
  const box=(root.attr.viewBox??'').split(/[ ,]+/).map(Number);
  if(box.length!==4||!box.every(Number.isFinite)||Math.abs(box[0])>10000||Math.abs(box[1])>10000||box.slice(2).some(v=>v<16||v>10000))return bad('Include a valid SVG viewBox (16–10000 unit canvas).');
  const edges=new Map<El,El[]>();
  for(const [node,id] of refs){const target=ids.get(id);if(!target)return bad('Missing internal SVG reference: '+id+'.');if(node.tag==='textPath'&&target.tag!=='path')return bad('Text paths must reference a path.');edges.set(node,[...(edges.get(node)??[]),target]);}
  const seen=new Set<El>(); const active=new Set<El>(); const memo=new Map<El,number>();
  function budget(el:El):number{
    if(active.has(el))return bad('Cyclic SVG references are not allowed.');
    if(seen.has(el))return memo.get(el)!;
    active.add(el);
    let n=1;
    for(const c of [...el.children.filter((x):x is El=>typeof x!=='string'),...(edges.get(el)??[])]){n+=budget(c);if(n>120_000)return bad('SVG expanded complexity exceeds the limit.');}
    active.delete(el);seen.add(el);memo.set(el,n);return n;
  }
  budget(root);
  return {root,ids,size:[box[2],box[3]]};
}
const record=(v:unknown):Record<string,any>=>v!==null && typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:bad('Expected a JSON object.');
const number=(v:unknown,min:number,max:number):number=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max?v:bad('Invalid animation number.');
const pair=(v:unknown,min:number,max:number):[number,number]=>Array.isArray(v)&&v.length===2?[number(v[0],min,max),number(v[1],min,max)]:bad('Expected [x,y].');
type MotionValue=number|[number,number]|string;
function pathParts(s:unknown){
  if(typeof s!=='string'||s.length>3500||!/^M/.test(s))return bad('Path deformation needs a bounded absolute SVG path.');
  const tokens=s.match(/[MLCQZ]|[+-]?(?:\d+(?:\.\d*)?|\.\d+)/g)??[];
  const flatten=s.replace(/[ ,\t\n\r]/g,'');
  if(tokens.join('')!==flatten)return bad('Path deformation supports absolute M, L, C, Q, Z only.');
  let expected=0;
  const parts=tokens.map(token=>{
    if(/^[MLCQZ]$/.test(token)){
      if(expected!==0)return bad('Each deformation command needs its coordinates.');
      expected=({M:2,L:2,C:6,Q:4,Z:0} as Record<string,number>)[token];return token;
    }
    if(--expected<0)return bad('Repeat each path command explicitly.');
    return number(Number(token),-10000,10000);
  });
  if(expected!==0||parts.length>600)return bad('Unsupported path deformation topology.');
  return parts;
}
type MotionTrack={id?:string;target:string;property:'translate'|'rotate'|'scale'|'opacity'|'path'|'fill'|'stroke'|'visibility';pivot?:[number,number];keys:{time:number;value:MotionValue;ease?:string}[]};
export type Motion={duration:number;tracks:MotionTrack[]};
export function readMotion(input:unknown,d:Drawing):Motion {
  const o=record(input),duration=number(o.duration,0.1,60); const seen=new Set<string>(); const trackIds=new Set<string>();
  if(!Array.isArray(o.tracks)||o.tracks.length<1||o.tracks.length>80)return bad('Use 1–80 animation tracks.');
  const tracks=o.tracks.map((t:unknown):MotionTrack=>{
    const {id,target,property,pivot,keys}=record(t);
    if(typeof target!=='string'||!d.ids.has(target)||!['g','path','rect','circle','ellipse','use','polygon','polyline','line','text','tspan','textPath'].includes(d.ids.get(target)!.tag))return bad('Animation target is not a drawing layer.');
    if(!['translate','rotate','scale','opacity','path','fill','stroke','visibility'].includes(property)||property==='path'&&d.ids.get(target)?.tag!=='path'||seen.has(target+' '+property))return bad('Unsupported or duplicate motion track.');seen.add(target+' '+property);
    const stableId=id===undefined?'track-'+createHash('sha256').update(target+' '+property).digest('hex').slice(0,24):id;
    if(typeof stableId!=='string'||!idRx.test(stableId)||trackIds.has(stableId))return bad('Motion track IDs must be valid and unique.');
    trackIds.add(stableId);
    if(!Array.isArray(keys)||keys.length<2||keys.length>80)return bad('Use 2–80 keyframes per track.');
    let prev=-1;let previousTopology:string|undefined;
    const checked=keys.map((k:unknown)=>{
      const {time,value,ease}=record(k);const stamp=number(time,0,duration);if(stamp<=prev)return bad('Keyframes must be in strictly increasing order.');prev=stamp;
      if(ease!==undefined&&!['linear','smooth','easeIn','easeOut','step'].includes(ease))return bad('Unknown easing.');
      if(property==='path'){
        const parts=pathParts(value);const topology=parts.map((x)=>typeof x==='number'?'#':x).join('');
        if(previousTopology!==undefined&&previousTopology!==topology)return bad('All deformed path keys need identical topology.');
        previousTopology=topology;
        return {time:stamp,value:parts.join(' '),ease};
      }
      if(property==='fill'||property==='stroke'){
        if(typeof value!=='string'||!/^#[0-9a-fA-F]{6}$/.test(value))return bad('Color keyframes need a six-digit hex color.');
        return {time:stamp,value:value.toLowerCase(),ease};
      }
      if(property==='visibility'){
        if(value!=='hidden'&&value!=='visible')return bad('Visibility keys must be visible or hidden.');
        return {time:stamp,value,ease:'step'};
      }
      return {time:stamp,value:property==='translate'?pair(value,-10000,10000):property==='scale'?pair(value,0.001,5):property==='opacity'?number(value,0,1):number(value,-720,720),ease};
    });
    return {id:stableId,target,property,keys:checked,pivot:pivot===undefined?undefined:pair(pivot,-10000,10000)};
  });
  return {duration,tracks};
}
export function readRig(input:unknown,d:Drawing,m:Motion):unknown {
  if(input===undefined||input===null)return undefined;
  const {joints}=record(input);
  if(!Array.isArray(joints)||!joints.length||joints.length>64)return bad('Use 1–64 rig joints.');
  const mapped=new Map<string,any>();
  const result=joints.map((j:unknown)=>{
    const {id,target,parent,pivot,min,max}=record(j);
    if(typeof id!=='string'||!idRx.test(id)||mapped.has(id)||typeof target!=='string'||d.ids.get(target)?.tag!=='g')return bad('Rig joint target must be a named SVG group.');
    const v={id,target,parent,pivot:pair(pivot,-10000,10000),min:min===undefined?undefined:number(min,-720,720),max:max===undefined?undefined:number(max,-720,720)};
    if((v.min??-720)>(v.max??720))return bad('Invalid rig joint limits.');
    const track=m.tracks.find(t=>t.target===v.target&&t.property==='rotate');
    if(track && (track.keys.some(k=>Number(k.value)<(v.min??-720)||Number(k.value)>(v.max??720))))return bad('Rotation exceeds joint limits.');
    if(track&&!track.pivot)track.pivot=v.pivot;
    mapped.set(id,v);return v;
  });
  for(const j of result){
    if(j.parent===undefined)continue;
    const p=mapped.get(j.parent); if(!p||j.parent===j.id)return bad('Invalid rig parent.');
    let n=d.ids.get(j.target)?.parent;while(n&&n!==d.ids.get(p.target))n=n.parent;
    if(!n)return bad('Rig parent must contain its child group.');
  }
  return {joints:result};
}
function value(t:MotionTrack,sec:number):MotionValue {
  const i=t.keys.findIndex(k=>k.time>=sec);
  if(i===0)return t.keys[0].value;
  if(i<0)return t.keys.at(-1)!.value;
  const a=t.keys[i-1],b=t.keys[i];const f=(sec-a.time)/(b.time-a.time);
  if(b.ease==='step')return f<1?a.value:b.value;
  const sample = (easing[b.ease as keyof typeof easing] ?? easing.linear)(f);
  const lerp=(x:number,y:number)=>gsap.utils.interpolate(x,y,sample);
  if(typeof a.value==='string'&&typeof b.value==='string'){
    if(t.property==='fill'||t.property==='stroke')return gsap.utils.interpolate(a.value,b.value,sample);
    if(t.property!=='path')return f<1?a.value:b.value;
    const y=pathParts(b.value);return pathParts(a.value).map((x,i)=>typeof x==='string'?x:fmt(lerp(x,y[i] as number))).join(' ');}
  return Array.isArray(a.value)&&Array.isArray(b.value)?[lerp(a.value[0],b.value[0]),lerp(a.value[1],b.value[1])]:lerp(a.value as number,b.value as number);
}
const fmt=(x:number)=>Number(x.toFixed(4));
export function drawFrame(d:Drawing,m:Motion,sec:number,w:number,h:number,options?:{hiddenTargets?:readonly string[]}):string {
  const changed=new Map<string,Record<string,string>>();const motions=new Map<string,Partial<Record<MotionTrack['property'],string>>>();
  const at=Math.min(m.duration,Math.max(0,Number.isFinite(sec)?sec:0));
  for(const t of m.tracks){
    const v=value(t,at);const p=t.pivot??[0,0];const cur=motions.get(t.target)??{};
    cur[t.property]=typeof v==='string'?v:typeof v==='number'?(t.property==='opacity'?String(fmt(v)):`rotate(${fmt(v)} ${p.join(' ')})`):t.property==='translate'?`translate(${v.map(fmt).join(' ')})`:`translate(${p.join(' ')}) scale(${v.map(fmt).join(' ')}) translate(${-p[0]} ${-p[1]})`;
    motions.set(t.target,cur);
  }
  for(const [id,a] of motions){
    const old=d.ids.get(id)!.attr;const transforms=[old.transform,a.translate,a.rotate,a.scale].filter(Boolean).join(' ');
    changed.set(id,{...(transforms?{transform:transforms}:{}),...(a.opacity===undefined?{}:{opacity:a.opacity}),...(a.path===undefined?{}:{d:a.path}),
      ...(a.fill===undefined?{}:{fill:a.fill}),...(a.stroke===undefined?{}:{stroke:a.stroke}),
      ...(a.visibility===undefined?{}:{display:a.visibility==='hidden'?'none':'inline',visibility:a.visibility})});
  }
  for(const id of options?.hiddenTargets??[]){
    if(d.ids.has(id))changed.set(id,{...changed.get(id),display:'none',visibility:'hidden'});
  }
  return serial(d.root,{width:String(w),height:String(h),xmlns:NS},changed);
}
function serial(el:El,extra:Record<string,string>,changed:Map<string,Record<string,string>>):string{
  const props={...el.attr,...changed.get(el.attr.id),...extra};
  return `<${el.tag}${Object.entries(props).map(([k,v])=>` ${k}="${escape(v)}"`).join('')}>${el.children.map(v=>typeof v==='string'?escape(v):serial(v,{},changed)).join('')}</${el.tag}>`;
}
export function canonicalArtwork(d:Drawing):string{return serial(d.root,{xmlns:NS},new Map());}
