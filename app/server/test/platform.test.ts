import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { exeName, ffmpegBeside, filterPath, findTool, fontFullName, isInside, pathLookup, rasterCommands, systemFontDirs } from '../src/platform.ts';

test('containment works with the local separator and refuses escapes', () => {
  const root = join(sep, 'app', 'data');
  assert.ok(isInside(root, join(root, 'a', 'b.png')));
  for (const bad of [root, join(root, '..', 'secret'), join(root + '-other', 'x'), join(sep, 'etc', 'passwd')]) assert.ok(!isInside(root, bad), bad);
});

test('Windows tool names and places', () => {
  assert.equal(exeName('claude', 'win32'), 'claude.exe');
  assert.equal(exeName('claude.exe', 'win32'), 'claude.exe');
  assert.equal(exeName('claude', 'darwin'), 'claude');
  assert.equal(pathLookup('win32'), 'where');
  assert.equal(pathLookup('linux'), '/usr/bin/which');
  const home = join(sep, 'Users', 'me');
  assert.equal(findTool('edge-tts', 'win32', home, (p) => p.endsWith('edge-tts.exe')), join(home, '.local', 'bin', 'edge-tts.exe'));
  assert.equal(findTool('edge-tts', 'win32', home, () => false), 'edge-tts', 'otherwise the PATH decides');
  assert.equal(ffmpegBeside('C:\\ffmpeg\\bin\\ffprobe.exe'), 'C:\\ffmpeg\\bin\\ffmpeg.exe');
  assert.equal(ffmpegBeside('/opt/x/ffprobe'), '/opt/x/ffmpeg');
  assert.equal(ffmpegBeside('ffprobe'), 'ffmpeg');
});

test('filter paths: a Windows drive colon is escaped and backslashes become slashes; other paths are only quoted', () => {
  assert.equal(filterPath('C:\\Users\\me\\cache\\a.ass'), "'C\\:/Users/me/cache/a.ass'");
  assert.equal(filterPath('/tmp/a b.ass'), "'/tmp/a b.ass'");
  assert.equal(filterPath("/tmp/it's.ass"), "'/tmp/it'\\''s.ass'");
});

test('fonts and pictures per platform', () => {
  assert.match(systemFontDirs('win32', { WINDIR: 'C:\\Windows', LOCALAPPDATA: 'C:\\L' }, 'C:\\H')[0], /Windows.Fonts$/);
  assert.ok(systemFontDirs('darwin', {}, '/Users/me').includes('/Library/Fonts'));
  assert.deepEqual(rasterCommands('a.svg', 'a.png', 'ffmpeg', 'darwin').map((c) => c.bin), ['ffmpeg', 'rsvg-convert', '/usr/bin/sips'], 'librsvg first, sips only as the last resort');
  assert.deepEqual(rasterCommands('a.svg', 'a.png', 'ffmpeg', 'win32').map((c) => c.bin), ['ffmpeg', 'rsvg-convert.exe']);
  assert.equal(fontFullName('/no/such/font.ttf'), null);
});

test('the name stored inside a real font file can be read', { skip: !existsSync('/System/Library/Fonts/Supplemental/Arial Black.ttf') }, () => {
  assert.equal(fontFullName('/System/Library/Fonts/Supplemental/Arial Black.ttf'), 'Arial Black');
  assert.equal(fontFullName('/System/Library/Fonts/Supplemental/Arial Bold.ttf'), 'Arial Bold');
});
