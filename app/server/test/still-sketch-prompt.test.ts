import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSketchPrompt } from '../src/research/sketch.ts';
import type { Scene } from '../src/studios/storyboard.ts';

const scene = { visual_style: 'archival sepia', visual_description: 'Two handmade date slips beside a clothbound notebook.', look: { shot: 'Overhead close-up', lighting: 'Warm light from the left' } } as Scene;
const variants = [
  { size: { w: 1080, h: 1920 }, number: 1, total: 4, category: 'History' },
  { size: { w: 1920, h: 1080 }, number: 2, total: 4, category: 'Folklore', captionSpace: true, styleNotes: 'Oxblood ink' },
];
test('v2 still prompt remains byte-for-byte unchanged, including optional visual direction and captions', () => {
  const expected = JSON.parse(readFileSync(new URL('./fixtures/still-sketch-prompts.v2.json', import.meta.url), 'utf8'));
  assert.deepEqual(variants.map(options => buildSketchPrompt(scene, options)), expected);
});
