import { bad, drawingTarget, readMotion, type Drawing, type Motion, type MotionTrack } from './model.ts';

type ClipTrack = Omit<MotionTrack,'id'|'target'|'pivot'> & {role:string};
export interface ReusableMotionClip {
  version:1;
  duration:number;
  tracks:ClipTrack[];
}
const roleFormat=/^[a-zA-Z_][a-zA-Z0-9_-]{0,47}$/;
const asObject=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:bad('Expected a reusable motion object.');
const checked=(v:unknown,min:number,max:number,label:string):number=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max?v:bad('Invalid reusable motion '+label+'.');

export function exportMotionClip(motion:Motion,drawing:Drawing,roleMap:unknown):ReusableMotionClip {
  const pairs=Object.entries(asObject(roleMap));
  if(!pairs.length||pairs.length>24)return bad('Choose 1–24 reusable motion roles.');
  const roles=new Map<string,string>();
  for(const [role,target] of pairs){
    if(!roleFormat.test(role)||typeof target!=='string'||roles.has(target)||!drawingTarget(drawing,target))return bad('Motion roles must name distinct drawable targets.');
    roles.set(target,role);
  }
  const checkedMotion=readMotion(motion,drawing);
  const tracks:ClipTrack[]=[];
  for(const t of checkedMotion.tracks){
    const role=roles.get(t.target); if(!role)continue;
    // Path keys contain source geometry. They cannot safely follow artwork to
    // a different drawing, so protect the destination from accidental redraw.
    if(t.property==='path')continue;
    tracks.push({role,property:t.property,keys:t.keys});
  }
  const included=new Set(tracks.map(t=>t.role));
  if(pairs.some(([role])=>!included.has(role)))return bad('Each role needs reusable motion. Path deformation is artwork-specific.');
  return {version:1,duration:checkedMotion.duration,tracks};
}

export function bindMotionClip(input:unknown,drawing:Drawing,options:{bindings:unknown;duration:number;translationScale?:number}):Motion {
  const {version,duration,tracks}=asObject(input);
  if(version!==1||!Array.isArray(tracks)||!tracks.length||tracks.length>80)return bad('Unsupported reusable motion clip.');
  const original=checked(duration,0.1,60,'source duration');
  const targetDuration=checked(options.duration,0.1,60,'destination duration');
  const translationScale=checked(options.translationScale??1,0.05,20,'translation scale');
  const entries=Object.entries(asObject(options.bindings));
  if(!entries.length||entries.length>24)return bad('Choose 1–24 destination motion roles.');
  const bound=new Map<string,{target:string;pivot?:unknown}>(), targets=new Set<string>();
  for(const [role,value] of entries){
    const {target,pivot}=asObject(value);
    if(!roleFormat.test(role)||typeof target!=='string'||targets.has(target)||!drawingTarget(drawing,target))return bad('Bind roles to distinct drawable destination targets.');
    bound.set(role,{target,pivot});targets.add(target);
  }
  const used=new Set<string>();
  const remapped=tracks.map((entry:unknown)=>{
    const {role,property,keys}=asObject(entry);
    const target=typeof role==='string'?bound.get(role):undefined;
    if(!target||typeof role!=='string'||property==='path')return bad('A reusable motion role is missing, or the clip would replace artwork geometry.');
    used.add(role);
    if((property==='rotate'||property==='scale')&&target.pivot===undefined)return bad('Rotation and scale need an explicit destination-local pivot.');
    if(!Array.isArray(keys)||keys.length<2||keys.length>80)return bad('Use 2–80 reusable motion keys.');
    return {target:target.target,property,pivot:target.pivot,keys:keys.map((key:unknown)=>{
      const {time,value,ease}=asObject(key);
      return {
        time:checked(time,0,original,'key time')/original*targetDuration,
        value:property==='translate'&&Array.isArray(value)?value.map(x=>checked(x,-10000,10000,'translation')*translationScale):value,
        ease,
      };
    })};
  });
  if(used.size!==bound.size)return bad('The reusable motion clip does not use every supplied role.');
  return readMotion({duration:targetDuration,tracks:remapped},drawing);
}
