import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bakeTwoBoneTracks, solveTwoBoneIK } from '../src/animation/ik.ts';
import { drawFrame, parseArtwork, readMotion } from '../src/animation/model.ts';

function close(actual:number, expected:number) { assert.ok(Math.abs(actual-expected)<1e-7, `${actual} != ${expected}`); }

test('IK hits reachable targets, preserves bone lengths, and selects opposite elbow bends', () => {
  const pose={origin:[10,20] as [number,number],target:[18,26] as [number,number],upperLength:7,lowerLength:5};
  const a=solveTwoBoneIK({...pose,bend:'clockwise'});
  const b=solveTwoBoneIK({...pose,bend:'counterclockwise'});
  for(const result of [a,b]){
    assert.equal(result.reachable,true);
    close(result.end[0],18); close(result.end[1],26);
    close(Math.hypot(result.elbow[0]-10,result.elbow[1]-20),7);
    close(Math.hypot(result.end[0]-result.elbow[0],result.end[1]-result.elbow[1]),5);
  }
  assert.ok(a.lowerDegrees>0 && b.lowerDegrees<0);
  assert.notDeepEqual(a.elbow,b.elbow);
});

test('IK deterministically clamps near and far targets and the equal-length zero-distance fold', () => {
  const base={origin:[0,0] as [number,number],upperLength:8,lowerLength:5,bend:'clockwise' as const};
  const far=solveTwoBoneIK({...base,target:[18,0]});
  const near=solveTwoBoneIK({...base,target:[1,0]});
  assert.equal(far.reachable,false); close(far.end[0],13); close(far.end[1],0);
  assert.equal(near.reachable,false); close(near.end[0],3); close(near.end[1],0);
  const fold=solveTwoBoneIK({...base,target:[0,0],upperLength:5,restDegrees:90});
  assert.equal(fold.reachable,true); close(fold.elbow[0],0); close(fold.elbow[1],5); close(fold.end[0],0); close(fold.end[1],0);
  assert.throws(()=>solveTwoBoneIK({...base,target:[Number.NaN,0]}),{code:'VALIDATION'});
});

test('declared IK keys bake into compatible nested SVG rotation tracks without seam jumps', () => {
  const rig=bakeTwoBoneTracks({
    origin:[20,20],upperLength:8,lowerLength:5,upperGroup:'arm',lowerGroup:'forearm',
    bend:'clockwise',keys:[{time:0,target:[9.1,20.1]},{time:1,target:[9.1,19.9]},{time:2,target:[0,18],ease:'smooth'}],
  });
  assert.deepEqual(rig.clampedKeyTimes,[2]);
  assert.deepEqual(rig.tracks[1].pivot,[28,20]);
  assert.ok(Math.abs(rig.tracks[0].keys[0].value-rig.tracks[0].keys[1].value)<5);
  const drawing=parseArtwork('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g id="arm"><path d="M20 20L28 20"/><g id="forearm"><path d="M28 20L33 20"/></g></g></svg>');
  const motion=readMotion({duration:2,tracks:rig.tracks},drawing);
  assert.match(drawFrame(drawing,motion,1.4,64,64),/id="arm" transform="rotate\([^"]+20 20\)"/);
  assert.match(drawFrame(drawing,motion,1.4,64,64),/id="forearm" transform="rotate\([^"]+28 20\)"/);
});
