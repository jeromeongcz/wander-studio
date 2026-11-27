import { EngineError } from '../engine.ts';
import type { AnimatedGenerationSettings } from './generate.ts';

type Beat = {start:number;end:number;actor:string;action:string;expression?:string};
export type SceneAnimationPlan = {
  mode:'animated'|'static';duration:number;setting:string;background:string;characters:string;body:string;expression:string;props:string;
  environment:string;lighting:string;camera:string;transition:string;continuity:string;beats:Beat[];
};
export function readSceneAnimation(v:unknown):SceneAnimationPlan {
  const invalid=(msg:string):never=>{throw new EngineError('VALIDATION',msg);};
  if(!v || typeof v!=='object'||Array.isArray(v))return invalid('The scene animation plan must be an object.');
  const o=v as Record<string,unknown>;
  const text=(x:unknown,max=480)=>typeof x==='string'?x.trim().slice(0,max):'';
  const duration=o.duration;
  if(typeof duration!=='number'||!Number.isFinite(duration)||duration<0.1||duration>60)return invalid('Scene animation duration must be between 0.1 and 60 seconds.');
  if(o.mode!=='animated'&&o.mode!=='static')return invalid('Scene animation mode must be animated or static.');
  if(!Array.isArray(o.beats)||o.beats.length>24||o.mode==='animated'&&!o.beats.length)return invalid('An animated scene needs at least one timed beat (maximum 24).');
  let last=0;
  const beats=o.beats.map((b:unknown)=>{
    if(!b||typeof b!=='object'||Array.isArray(b))return invalid('Invalid animation beat.');
    const {start,end,actor,action,expression}=b as Record<string,unknown>;
    if(typeof start!=='number'||typeof end!=='number'||!Number.isFinite(start)||!Number.isFinite(end)||start<last||end<=start||end>duration||!text(action))return invalid('An animation beat is invalid or outside its scene.');
    last=start;
    return {start,end,actor:text(actor,80),action:text(action),expression:text(expression,160)||undefined};
  });
  return {mode:o.mode,duration,setting:text(o.setting),background:text(o.background),characters:text(o.characters),body:text(o.body),expression:text(o.expression),props:text(o.props),environment:text(o.environment),lighting:text(o.lighting),camera:text(o.camera),transition:text(o.transition),continuity:text(o.continuity),beats};
}
export function animationPlanPrompt(s:AnimatedGenerationSettings|undefined):string[]{
  if(!s||s.mode==='static')return [];
  return [
    `Plan every section's animation using ${s.style} visual direction, ${s.quality} artwork quality, ${s.complexity} complexity and ${s.fps} fps. ${s.mode==='mixed'?'Choose static or animated individually by storytelling need.':'Choose animated for every section.'}`,
    'Include stable characters, background, prop and repeatable pose IDs in continuity for scenes sharing assets. Preserve film direction, position, wardrobe, lighting and state between cuts.',
    `Enabled: characters=${s.character}, environment=${s.environment}, dialogue shape cues=${s.dialogue}, camera=${s.camera}. Do not add motion in a disabled category. Dialogue timing is visual guidance, never extra narration.`,
    'Add this object to each section as animation_plan, outside text; every action has relative start/end seconds inside duration. Use anticipation, holds, follow-through and motivated environmental movement where useful.',
    'animation_plan = {"mode":"animated|static","duration":4,"setting":"","background":"","characters":"","body":"","expression":"","props":"","environment":"","lighting":"","camera":"","transition":"","continuity":"","beats":[{"start":0,"end":1,"actor":"","action":"","expression":""}]}. For a static scene, use an empty beats array.',
  ];
}
