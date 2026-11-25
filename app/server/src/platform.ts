// Everything that differs between macOS, Windows and Linux. Functions take the platform as an argument where it matters,
// so the Windows rules can be tested on any machine.
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

export type Platform = NodeJS.Platform;

/** True when `p` is inside `dir` (not `dir` itself). Works with either path separator. */
export function isInside(dir: string, p: string): boolean {
  const rel = relative(resolve(dir), resolve(p));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export const exeName = (name: string, platform: Platform = process.platform) => (platform === 'win32' && !/\.exe$/i.test(name) ? `${name}.exe` : name);

/** A command-line tool in the usual install places, else its bare name so the PATH decides. */
export function findTool(name: string, platform: Platform = process.platform, home: string = homedir(), exists: (p: string) => boolean = existsSync): string {
  const dirs = [join(home, '.local', 'bin'), ...(platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin'])];
  for (const d of dirs) {
    const p = join(d, exeName(name, platform));
    if (exists(p)) return p;
  }
  return name;
}

/** The command that says whether a tool is on the PATH. */
export const pathLookup = (platform: Platform = process.platform) => (platform === 'win32' ? 'where' : '/usr/bin/which');

/** The ffmpeg that sits beside a given ffprobe. */
export function ffmpegBeside(ffprobe: string): string {
  return /[\\/]/.test(ffprobe) ? ffprobe.replace(/ffprobe(\.exe)?$/i, 'ffmpeg$1') : 'ffmpeg';
}

/** Quote a file path used as an option value inside an ffmpeg filter graph. A Windows drive colon must be escaped. */
export function filterPath(p: string): string {
  const windows = /^[a-zA-Z]:[\\/]/.test(p);
  const value = windows ? p.replace(/\\/g, '/').replace(/:/g, '\\:') : p;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Where installed fonts live. `recursive` folders keep fonts in subfolders. */
export function systemFontDirs(platform: Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  if (platform === 'win32') return [join(env.WINDIR ?? env.SystemRoot ?? 'C:\\Windows', 'Fonts'), join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts')];
  if (platform === 'darwin') return ['/System/Library/Fonts/Supplemental', '/Library/Fonts', join(home, 'Library', 'Fonts')];
  return ['/usr/share/fonts', '/usr/local/share/fonts', join(home, '.local', 'share', 'fonts'), join(home, '.fonts')];
}

const names = new Map<string, string | null>();
/**
 * The full name stored inside a .ttf or .otf file (for example "Arial Black" for ariblk.ttf), or null if it cannot
 * be read. Windows file names do not match font names, so the name has to come from the file.
 */
export function fontFullName(path: string): string | null {
  const known = names.get(path);
  if (known !== undefined) return known;
  let found: string | null = null;
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const read = (at: number, length: number) => {
      const b = Buffer.alloc(length);
      if (readSync(fd!, b, 0, length, at) !== length) throw new Error('short font file');
      return b;
    };
    const tables = Math.min(read(4, 2).readUInt16BE(0), 200);
    const directory = read(12, tables * 16);
    for (let i = 0; i < tables && !found; i++) {
      if (directory.toString('latin1', i * 16, i * 16 + 4) !== 'name') continue;
      const table = read(directory.readUInt32BE(i * 16 + 8), Math.min(directory.readUInt32BE(i * 16 + 12), 200_000));
      const count = table.readUInt16BE(2);
      const strings = table.readUInt16BE(4);
      let fallback: string | null = null;
      for (let r = 0; r < count; r++) {
        const at = 6 + r * 12;
        const [platformId, nameId, length, offset] = [table.readUInt16BE(at), table.readUInt16BE(at + 6), table.readUInt16BE(at + 8), table.readUInt16BE(at + 10)];
        if (nameId !== 4) continue;
        const raw = table.subarray(strings + offset, strings + offset + length);
        if (platformId === 3) {
          const text = Buffer.from(raw).swap16().toString('utf16le');
          // prefer US English; keep any Windows name as a fallback
          if (table.readUInt16BE(at + 4) === 0x409) { found = text; break; }
          fallback ??= text;
        } else if (platformId === 1) fallback ??= raw.toString('latin1');
      }
      found ??= fallback;
    }
  } catch {
    found = null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  names.set(path, found);
  return found;
}

/** How to turn a drawing (SVG) into a PNG here: the first command that works wins. */
export function rasterCommands(svg: string, png: string, ffmpeg: string, platform: Platform = process.platform): { bin: string; args: string[] }[] {
  if (platform === 'darwin') return [{ bin: '/usr/bin/sips', args: ['-s', 'format', 'png', svg, '--out', png] }];
  return [
    // FFmpeg builds with librsvg (for example the "full" Windows builds) read SVG directly
    { bin: ffmpeg, args: ['-hide_banner', '-nostats', '-loglevel', 'error', '-y', '-i', svg, '-frames:v', '1', png] },
    { bin: exeName('rsvg-convert', platform), args: ['-o', png, svg] },
  ];
}
