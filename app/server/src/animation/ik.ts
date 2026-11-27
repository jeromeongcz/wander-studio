import { EngineError } from '../engine.ts';

const bad = (message:string):never => { throw new EngineError('VALIDATION',message); };

type Point = [number, number];
type Bend = 'clockwise' | 'counterclockwise';
type Ease = 'linear' | 'smooth' | 'easeIn' | 'easeOut' | 'step';

interface TwoBonePose {
  origin: Point;
  target: Point;
  upperLength: number;
  lowerLength: number;
  bend: Bend;
  /** Rest direction of the unposed artwork's upper and lower bones; positive is clockwise in SVG. */
  restDegrees?: number;
}

interface TwoBoneSolution {
  elbow: Point;
  end: Point;
  /** Rotation deltas for the upper group and nested lower group. SVG rotations are clockwise. */
  upperDegrees: number;
  lowerDegrees: number;
  reachable: boolean;
}

function scalar(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return bad('Invalid IK '+label+'.');
  return value;
}

function point(value: unknown, label: string): Point {
  if (!Array.isArray(value) || value.length !== 2) return bad('IK '+label+' must be [x,y].');
  return [scalar(value[0], -10000, 10000, label), scalar(value[1], -10000, 10000, label)];
}

const upTo = (n:number, lo:number, hi:number) => Math.max(lo, Math.min(hi, n));
const rad = (degrees:number) => degrees*Math.PI/180;
const deg = (radians:number) => radians*180/Math.PI;
const addPolar = (p:Point, length:number, angle:number):Point => [p[0]+length*Math.cos(angle), p[1]+length*Math.sin(angle)];

/**
 * Deterministic planar two-bone solve using the law of cosines.
 * Lengths are preserved; unreachable targets clamp to the nearest annulus boundary.
 * A zero-distance equal-length fold uses the declared rest direction instead of an unstable division.
 */
export function solveTwoBoneIK(pose: TwoBonePose): TwoBoneSolution {
  const start = point(pose.origin,'origin');
  const target = point(pose.target,'target');
  const upper = scalar(pose.upperLength,0.01,10000,'upper length');
  const lower = scalar(pose.lowerLength,0.01,10000,'lower length');
  const rest = scalar(pose.restDegrees??0,-720,720,'rest direction');
  if (pose.bend!=='clockwise'&&pose.bend!=='counterclockwise') return bad('IK bend direction is required.');
  const sign = pose.bend==='clockwise'?1:-1;
  const [x,y] = [target[0]-start[0],target[1]-start[1]];
  const distance = Math.hypot(x,y);
  const min = Math.abs(upper-lower), max = upper+lower;
  const reach = upTo(distance,min,max);
  const aim = distance>1e-9?Math.atan2(y,x):rad(rest);
  const bendAngle = Math.acos(upTo((reach*reach-upper*upper-lower*lower)/(2*upper*lower),-1,1))*sign;
  const upperAngle = reach<1e-9?aim:aim-Math.atan2(lower*Math.sin(bendAngle),upper+lower*Math.cos(bendAngle));
  const elbow = addPolar(start,upper,upperAngle);
  const end = addPolar(elbow,lower,upperAngle+bendAngle);
  return {elbow,end,upperDegrees:deg(upperAngle)-rest,lowerDegrees:deg(bendAngle),reachable:distance>=min-1e-8&&distance<=max+1e-8};
}

export interface TwoBoneBake extends Omit<TwoBonePose, 'target'> {
  upperGroup: string;
  lowerGroup: string;
  keys: {time: number; target: Point; ease?: Ease}[];
}

function continuousAngle(angle:number,previous:number|undefined):number {
  if(previous===undefined)return ((angle+180)%360+360)%360-180;
  return angle+360*Math.round((previous-angle)/360);
}

/**
 * Resolve declared target keyframes to two ordinary rotation tracks. The lower SVG group must be nested
 * inside the upper group; its rest pivot is calculated in the upper group's unposed coordinate system.
 * No runtime IK metadata or provider-authored code is needed to replay the resulting animation.
 */
export function bakeTwoBoneTracks(spec: TwoBoneBake) {
  const id = /^[A-Za-z_][A-Za-z0-9_.:-]{0,95}$/;
  if (typeof spec.upperGroup!=='string'||typeof spec.lowerGroup!=='string'||!id.test(spec.upperGroup) || !id.test(spec.lowerGroup) || spec.upperGroup===spec.lowerGroup) return bad('IK bones need two distinct SVG group IDs.');
  if (!Array.isArray(spec.keys) || spec.keys.length<2 || spec.keys.length>80) return bad('Use 2–80 IK target keys.');
  const origin = point(spec.origin,'origin');
  const rest = scalar(spec.restDegrees??0,-720,720,'rest direction');
  const upperLength = scalar(spec.upperLength,0.01,10000,'upper length');
  const pivot = point(addPolar(origin,upperLength,rad(rest)),'lower pivot');
  let since = -1; let previous: number|undefined;
  const sampled = spec.keys.map((key)=>{
    const time = scalar(key.time,0,60,'key time');
    if (time<=since) return bad('IK target keys must be in strictly increasing order.');
    since=time;
    const ease=key.ease;
    if(ease!==undefined&&!['linear','smooth','easeIn','easeOut','step'].includes(ease))return bad('Invalid IK key easing.');
    const solution=solveTwoBoneIK({...spec,target:key.target});
    const upper=continuousAngle(solution.upperDegrees,previous);
    previous=scalar(upper,-720,720,'upper rotation');
    return {time,ease,upper,lower:solution.lowerDegrees,reachable:solution.reachable};
  });
  return {
    tracks:[
      {target:spec.upperGroup,property:'rotate' as const,pivot:origin,keys:sampled.map((k)=>({time:k.time,value:k.upper,ease:k.ease}))},
      {target:spec.lowerGroup,property:'rotate' as const,pivot,keys:sampled.map((k)=>({time:k.time,value:k.lower,ease:k.ease}))},
    ],
    clampedKeyTimes:sampled.filter((k)=>!k.reachable).map((k)=>k.time),
  };
}
