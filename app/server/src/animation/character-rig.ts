import { createHash } from 'node:crypto';
import { bad, drawingTarget, parseArtwork, readRig, type Drawing, type DrawingElement } from './model.ts';
import { extractApprovedGroupWithIds, replaceApprovedGroup } from './generate.ts';

interface RigJoint {id:string;target:string;parent?:string;pivot:[number,number];min?:number;max?:number}
interface CharacterRig {joints:RigJoint[]}
const emptyMotion = {duration:1,tracks:[]};
const joints = (value:unknown,drawing:Drawing) => (readRig(value,drawing,emptyMotion) as CharacterRig|undefined)?.joints ?? [];
function includes(root:DrawingElement,node:DrawingElement|undefined) {
  for(let at=node;at;at=at.parent)if(at===root)return true;
  return false;
}

export function selectCharacterRig(svg:string,rig:unknown,groupId:string):CharacterRig|undefined {
  const drawing=parseArtwork(svg),root=drawing.ids.get(groupId);
  if(!root||root.tag!=='g'||!drawingTarget(drawing,groupId))return bad('Choose a named drawable character group.');
  const subset=joints(rig,drawing).filter(j=>includes(root,drawing.ids.get(j.target)));
  if(!subset.length)return undefined;
  const included=new Set(subset.map(j=>j.id));
  return {joints:subset.map(j=>({...j,parent:j.parent&&included.has(j.parent)?j.parent:undefined}))};
}

/** Carry only the selected subtree's approved joints and remap both joint and SVG IDs. */
export function extractCharacter(svg:string,rig:unknown,groupId:string,targetId:string,placement?:string) {
  const selected=selectCharacterRig(svg,rig,groupId);
  const extracted=extractApprovedGroupWithIds(svg,groupId,targetId,placement);
  const prefix=createHash('sha256').update(svg).update(groupId).update(targetId).digest('hex').slice(0,14);
  const jointIds=new Map(selected?.joints.map((j,i)=>[j.id,`joint_${prefix}_${i+1}_${j.id.slice(0,40)}`]));
  const remapped=selected?.joints.map(j=>({...j,id:jointIds.get(j.id)!,target:extracted.ids.get(j.target)!,parent:j.parent?jointIds.get(j.parent):undefined}));
  return {layer:{target:extracted.target,svg:extracted.svg},rig:remapped?.length?{joints:remapped}:undefined};
}

export function placeCharacter(destinationSvg:string,destinationRig:unknown,sourceSvg:string,sourceRig:unknown,sourceGroupId:string,targetId:string) {
  const destination=parseArtwork(destinationSvg),placeholder=destination.ids.get(targetId);
  if(!placeholder||placeholder.tag!=='g'||!drawingTarget(destination,targetId))
    return bad('Choose an existing drawable group as the receiving placeholder.');
  const retained=joints(destinationRig,destination).filter(j=>!includes(placeholder,destination.ids.get(j.target)));
  const {layer,rig}=extractCharacter(sourceSvg,sourceRig,sourceGroupId,targetId,placeholder.attr.transform);
  const svg=replaceApprovedGroup(destinationSvg,layer);
  const combined=[...retained,...(rig?.joints??[])];
  const validated=combined.length?readRig({joints:combined},parseArtwork(svg),emptyMotion):undefined;
  return {svg,rig:validated};
}

export function combineCharacterRigs(rigs:(CharacterRig|undefined)[]):CharacterRig|undefined {
  const all=rigs.flatMap(r=>r?.joints??[]);
  return all.length?{joints:all}:undefined;
}
