import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { TimedMouthCue } from './prompt-directives.ts';
import { readTimedMouthCues } from './generation-controls.ts';
import { EngineError } from '../engine.ts';

export const MAX_DIALOGUE_WAV_BYTES = 12 * 1024 * 1024;
const shapeNames: Readonly<Record<string, string>> = Object.freeze({
  A:'closed', B:'narrow', C:'medium', D:'open', E:'round', F:'pucker', G:'bite', H:'tongue', X:'rest',
});
const exec = promisify(execFile);
const validation = (message: string) => new EngineError('VALIDATION', message);
type Recognizer = 'pocketSphinx' | 'phonetic';

export function parseDialogueSuggestions(raw: string, sceneSeconds: number): TimedMouthCue[] {
  if (typeof sceneSeconds !== 'number' || !Number.isFinite(sceneSeconds) || sceneSeconds < .1 || sceneSeconds > 60)
    throw validation('Dialogue needs a scene duration from 0.1 to 60 seconds.');
  let data: { metadata?: { duration?: unknown }; mouthCues?: unknown };
  try { data = JSON.parse(raw); } catch { throw validation('The local recognizer did not return valid timing JSON.'); }
  const duration = data?.metadata?.duration, values = data?.mouthCues;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > sceneSeconds + .02)
    throw validation('Trim the WAV excerpt to fit this scene. Wander will not rescale dialogue timing.');
  if (!Array.isArray(values) || values.length > 3000) throw validation('The local recognizer returned invalid cue data.');
  const cues: TimedMouthCue[] = [];
  let previousEnd = 0;
  for (const entry of values) {
    const {start,end,value} = (entry ?? {}) as {start?:unknown;end?:unknown;value?:unknown};
    if (typeof value !== 'string' || !Object.hasOwn(shapeNames,value) || typeof start !== 'number' || typeof end !== 'number'
      || !Number.isFinite(start) || !Number.isFinite(end) || start < previousEnd || end <= start || end > duration + .02)
      throw validation('The local recognizer returned malformed or overlapping cues.');
    previousEnd = end;
    const shape = shapeNames[value], clippedEnd = Math.min(end,sceneSeconds);
    if (shape === 'rest' || start >= clippedEnd) continue;
    const last = cues.at(-1);
    if (last?.end === start && last.shape === shape) last.end = clippedEnd;
    else cues.push({start,end:clippedEnd,shape});
  }
  if (!cues.length) throw validation('No speech timing was found in this WAV excerpt.');
  if (cues.length > 38) throw validation('This excerpt produced more than 38 mouth cues. Use a shorter speaking beat or enter a shorter cue list manually.');
  return readTimedMouthCues(cues, sceneSeconds) ?? [];
}

export async function suggestDialogueCues(wav: unknown, sceneSeconds: number, recognizer: unknown, command = process.env.WANDER_RHUBARB_BIN ?? 'rhubarb') {
  if (recognizer !== 'pocketSphinx' && recognizer !== 'phonetic') throw validation('Select an English or multilingual recognizer.');
  if (!Buffer.isBuffer(wav) || wav.byteLength < 44 || wav.byteLength > MAX_DIALOGUE_WAV_BYTES
    || wav.toString('ascii',0,4) !== 'RIFF' || wav.toString('ascii',8,12) !== 'WAVE')
    throw validation('Upload a scene WAV file no larger than 12 MB.');
  const folder = await mkdtemp(join(tmpdir(),'wander-motion-dialogue-'));
  const source = join(folder,'scene.wav');
  try {
    await writeFile(source,wav,{mode:0o600});
    let stdout: string;
    try {
      ({stdout} = await exec(command,['--quiet','--recognizer',recognizer as Recognizer,'--exportFormat','json',source],
        {cwd:folder,encoding:'utf8',windowsHide:true,timeout:50_000,maxBuffer:1024*1024}));
    } catch (error) {
      if ((error as {code?:unknown}).code === 'ENOENT')
        throw validation('The local Rhubarb Lip Sync executable was not found. Install it or set WANDER_RHUBARB_BIN; manual cues still work.');
      throw validation('Local audio analysis did not finish. Verify the WAV plays in your editor or use a shorter excerpt.');
    }
    return {cues:parseDialogueSuggestions(stdout,sceneSeconds),method:'local-audio-estimate' as const};
  } finally { await rm(folder,{recursive:true,force:true}).catch(()=>{}); }
}
