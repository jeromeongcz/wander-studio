import { createHash } from 'node:crypto';
import { EngineError } from '../engine.ts';
import { solveTwoBoneIK } from './ik.ts';
import type { Drawing, DrawingElement, MotionTrack } from './model.ts';

type Point=[number,number];
type Leg={upper:string;lower:string;foot:string;hip:Point;thigh:number;shin:number;pivot:Point;ankle:Point;seedX:number;stepSign:1|-1};
type Arm={group:string;pivot:Point};
const fail=(message:string):never=>{throw new EngineError('VALIDATION',message);};
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:fail('The walk specification must be an object.');
const num=(v:unknown,min:number,max:number,label:string)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max?v:fail('Invalid walk '+label+'.');
const point=(v:unknown,label:string):Point=>Array.isArray(v)&&v.length===2?[num(v[0],-10000,10000,label),num(v[1],-10000,10000,label)]:fail('Walk '+label+' must be [x,y].');
const smooth=(t:number)=>t*t*(3-2*t);
const rad=(d:number)=>d*Math.PI/180;
const lerp=(a:number,b:number,t:number)=>a+(b-a)*t;

export function bakeWalk(value:unknown,d:Drawing,duration:number):{tracks:MotionTrack[];protectedTransforms:Set<string>} {
  const protectedTransforms=new Set<string>();
  if(value===undefined)return {tracks:[],protectedTransforms};
  const spec=object(value);
  const start=num(spec.start??0,0,duration,'start');
  const stepSeconds=num(spec.stepSeconds,.2,4,'step duration');
  const steps=num(spec.steps,1,4,'step count');
  if(!Number.isInteger(steps))return fail('Use 1 to 4 whole walk steps.');
  const end=start+stepSeconds*steps;
  if(end>duration+1e-8)return fail('The walk steps must fit inside the scene.');
  const direction=spec.direction??'right';
  if(direction!=='left'&&direction!=='right')return fail('Choose left or right for the walk.');
  const sign=direction==='right'?1:-1;
  const stride=num(spec.stepLength,.1,900,'step length'), ground=num(spec.groundY,-10000,10000,'ground Y');
  const lift=num(spec.lift,0.1,200,'foot lift'), bob=num(spec.bob??0,0,100,'body rise');
  const swing=num(spec.armSwing??14,0,50,'arm swing');
  const used=new Set<string>();
  const group=(id:unknown)=>{
    if(typeof id!=='string')return fail('Walk joints need named SVG groups.');
    const el=d.ids.get(id);
    if(!el||el.tag!=='g'||used.has(id))return fail('Walk joints need distinct named SVG groups.');
    used.add(id);
    return {id,el};
  };
  const body=group(spec.root);
  // Static scene placement remains outside the generated movement, so a saved character
  // placed by a scene's translate/scale keeps its pose in its local drawing coordinates.
  for(let parent=body.el.parent;parent;parent=parent.parent){
    if(parent!==d.root&&parent.tag!=='g')return fail('The walk root must be under drawable SVG groups.');
    if(parent.attr.id)protectedTransforms.add(parent.attr.id);
  }
  function path(el:DrawingElement,parent:DrawingElement){
    if(el===parent||!contains(parent,el))return fail('Walk joints must be nested inside their declared parent.');
    for(let at:DrawingElement|undefined=el;at&&at!==parent;at=at.parent){
      if(at.tag!=='g'||at.attr.transform)return fail('Walk joints need an untransformed chain of SVG groups.');
      if(at.attr.id)protectedTransforms.add(at.attr.id);
      if(at.parent===parent)return;
    }
    return fail('Walk joints must be nested inside their declared parent.');
  }
  function contains(a:DrawingElement,b:DrawingElement){
    for(let el:DrawingElement|undefined=b;el;el=el.parent)if(el===a)return true;
    return false;
  }
  protectedTransforms.add(body.id);
  if(d.root.attr.id)protectedTransforms.add(d.root.attr.id);
  const upperGroups:DrawingElement[]=[];
  const leg=(v:unknown,index:number):Leg=>{
    const o=object(v),upper=group(o.upper),lower=group(o.lower),foot=group(o.foot);
    path(upper.el,body.el);path(lower.el,upper.el);path(foot.el,lower.el);upperGroups.push(upper.el);
    const hip=point(o.hip,'hip'), thigh=num(o.thigh,1,2000,'thigh length'), shin=num(o.shin,1,2000,'shin length');
    const pivot=point([hip[0],hip[1]+thigh],'knee');
    const ankle=point([hip[0],hip[1]+thigh+shin],'rest ankle');
    return {upper:upper.id,lower:lower.id,foot:foot.id,hip,thigh,shin,pivot,ankle,
      seedX:hip[0]+sign*stride*(index===0?-.5:.5),stepSign:sign};
  };
  const legs=[leg(spec.left,0),leg(spec.right,1)];
  if(legs.some(l=>ground-lift<=l.hip[1]+1))
    return fail('For a walk, ground and raised feet must stay below both hips. Reduce foot lift.');
  if(contains(upperGroups[0],upperGroups[1])||contains(upperGroups[1],upperGroups[0]))
    return fail('Walk legs must be separate branches of the body.');
  const arms:({arm:Arm;side:number})[]=[];
  const armElements:DrawingElement[]=[];
  for(const [side,key] of [[1,'leftArm'],[-1,'rightArm']] as const){
    if(spec[key]===undefined)continue;
    const v=object(spec[key]),el=group(v.group);path(el.el,body.el);
    if([...upperGroups,...armElements].some(other=>contains(other,el.el)||contains(el.el,other)))
      return fail('Walk arms must be separate branches from other limbs.');
    armElements.push(el.el);
    arms.push({arm:{group:el.id,pivot:point(v.pivot,'arm pivot')},side});
  }

  function sample(progress:number){
    const i=Math.min(steps-1,Math.floor(progress)), f=progress-i;
    const active=i%2;
    const easedEdge=(x:number)=>{const fraction=x/.18;return .18*fraction*fraction*(2-fraction);};
    const travel=progress<.18?easedEdge(progress):progress>steps-.18?steps-easedEdge(steps-progress):progress;
    const rise=f===0||f===1?0:Math.sin(Math.PI*f)**2;
    const translation:Point=[sign*stride*travel||0,-bob*rise||0];
    const plantedWorld:Point[]=[];
    const poses=legs.map((leg,k)=>{
      const previous=i-1-((i-1-k+2)%2);
      const prior=previous<0?leg.seedX:leg.hip[0]+sign*stride*(previous+1.5);
      const landing=leg.hip[0]+sign*stride*(i+1.5);
      const walking=k===active;
      const world:Point=[walking?lerp(prior,landing,smooth(f)):prior,ground-(walking?lift*rise:0)];
      plantedWorld.push(world);
      const result=solveTwoBoneIK({origin:leg.hip,target:[world[0]-translation[0],world[1]-translation[1]],
        upperLength:leg.thigh,lowerLength:leg.shin,restDegrees:90,bend:leg.stepSign===1?'clockwise':'counterclockwise'});
      if(!result.reachable)return fail('A walk foot cannot reach its target. Shorten the step, reduce lift or body rise, or raise the ground.');
      return [result.upperDegrees||0,result.lowerDegrees||0,-(result.upperDegrees+result.lowerDegrees)||0];
    });
    return {translation,poses,plantedWorld,active,armSwing:swing*Math.cos(Math.PI*progress)*sign};
  }
  const perStep=18, count=steps*perStep;
  const samples=Array.from({length:count+1},(_,i)=>sample(i/perStep));
  // Linear baked rotations have tiny between-key error. Verify support-foot position at
  // subframes across the actual exported track interpolation and fail when a rig is too close to singular.
  for(let k=0;k<count;k++)for(const f of [.25,.5,.75]){
    const a=samples[k],b=samples[k+1],base=sample((k+f)/perStep);
    const j=1-base.active,leg=legs[j],u=rad(90+lerp(a.poses[j][0],b.poses[j][0],f));
    const l=u+rad(lerp(a.poses[j][1],b.poses[j][1],f));
    const x=leg.hip[0]+lerp(a.translation[0],b.translation[0],f)+leg.thigh*Math.cos(u)+leg.shin*Math.cos(l);
    const y=leg.hip[1]+lerp(a.translation[1],b.translation[1],f)+leg.thigh*Math.sin(u)+leg.shin*Math.sin(l);
    const goal=base.plantedWorld[j];
    if(Math.hypot(x-goal[0],y-goal[1])>Math.min(.25,(leg.thigh+leg.shin)*.0025))
      return fail('The walk cannot hold its planted foot accurately. Shorten the step or choose a less extended rest pose.');
  }
  function tracksFor(target:string,property:'translate'|'rotate',get:(frame:typeof samples[number])=>Point|number,pivot?:Point):MotionTrack{
    const keys=samples.map((frame,i)=>({time:i===count?Math.min(end,duration):start+stepSeconds*i/perStep,value:get(frame)}));
    if(start>0)keys.unshift({time:0,value:get(samples[0])});
    if(end<duration-1e-8)keys.push({time:duration,value:get(samples[count])});
    const id='walk-v1-'+createHash('sha256').update(target+' '+property).digest('hex').slice(0,22);
    return {id,target,property,pivot,keys};
  }
  const tracks:MotionTrack[]=[tracksFor(body.id,'translate',s=>s.translation)];
  for(const [i,l] of legs.entries()){
    tracks.push(tracksFor(l.upper,'rotate',s=>s.poses[i][0],l.hip),
      tracksFor(l.lower,'rotate',s=>s.poses[i][1],l.pivot),tracksFor(l.foot,'rotate',s=>s.poses[i][2],l.ankle));
  }
  for(const {arm,side} of arms)tracks.push(tracksFor(arm.group,'rotate',s=>s.armSwing*side||0,arm.pivot));
  return {tracks,protectedTransforms};
}
