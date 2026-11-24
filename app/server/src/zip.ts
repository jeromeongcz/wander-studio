import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { crc32, createDeflateRaw, createInflateRaw } from 'node:zlib';
import { extname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, Writable } from 'node:stream';
import { EngineError } from './engine.ts';

// Minimal dependency-free ZIP (no zip64): enough for portable project archives up to 4 GB per file.
const STORE_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp3', '.m4a', '.aac', '.ogg', '.flac', '.zip']);
const U32 = 0xffffffff;

function dosTime(d: Date) {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

export interface ZipEntry {
  name: string;
  method: 0 | 8;
  crc: number;
  csize: number;
  usize: number;
  offset: number;
}

export class ZipWriter {
  private out;
  private offset = 0;
  private entries: ZipEntry[] = [];
  constructor(path: string) {
    this.out = createWriteStream(path);
  }
  private write(buf: Buffer): Promise<void> {
    this.offset += buf.length;
    return new Promise((res, rej) => this.out.write(buf, (e) => (e ? rej(e) : res())));
  }
  private async header(name: string, method: number, mtime: Date) {
    const nameBuf = Buffer.from(name, 'utf8');
    const { time, date } = dosTime(mtime);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x0808, 6); // data descriptor + UTF-8 names
    h.writeUInt16LE(method, 8);
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(date, 12);
    h.writeUInt16LE(nameBuf.length, 26);
    const start = this.offset;
    await this.write(Buffer.concat([h, nameBuf]));
    return start;
  }
  private async finishEntry(name: string, method: 0 | 8, start: number, crc: number, csize: number, usize: number) {
    if (csize > U32 || usize > U32) throw new EngineError('VALIDATION', `"${name}" is too large for a non-zip64 archive`);
    const d = Buffer.alloc(16);
    d.writeUInt32LE(0x08074b50, 0);
    d.writeUInt32LE(crc >>> 0, 4);
    d.writeUInt32LE(csize, 8);
    d.writeUInt32LE(usize, 12);
    await this.write(d);
    this.entries.push({ name, method, crc: crc >>> 0, csize, usize, offset: start });
  }
  async addBuffer(name: string, data: Buffer) {
    const start = await this.header(name, 0, new Date());
    await this.write(data);
    await this.finishEntry(name, 0, start, crc32(data), data.length, data.length);
  }
  async addFile(name: string, path: string) {
    const st = await stat(path);
    const method = STORE_EXT.has(extname(path).toLowerCase()) ? 0 : 8;
    const start = await this.header(name, method, st.mtime);
    let crc = 0;
    let usize = 0;
    let csize = 0;
    const self = this;
    const counter = new Transform({
      transform(chunk: Buffer, _e, cb) {
        crc = crc32(chunk, crc);
        usize += chunk.length;
        cb(null, chunk);
      },
    });
    const sink = new Writable({
      write(chunk: Buffer, _e, cb) {
        csize += chunk.length;
        self.write(chunk).then(() => cb(), cb);
      },
    });
    await pipeline(createReadStream(path), counter, ...(method === 8 ? [createDeflateRaw({ level: 6 })] : []), sink);
    await this.finishEntry(name, method as 0 | 8, start, crc, csize, usize);
  }
  async finish() {
    if (this.entries.length > 0xffff) throw new EngineError('VALIDATION', 'Too many files for a non-zip64 archive');
    const cdStart = this.offset;
    for (const e of this.entries) {
      const nameBuf = Buffer.from(e.name, 'utf8');
      const c = Buffer.alloc(46);
      const { time, date } = dosTime(new Date());
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(0x0808, 8);
      c.writeUInt16LE(e.method, 10);
      c.writeUInt16LE(time, 12);
      c.writeUInt16LE(date, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.csize, 20);
      c.writeUInt32LE(e.usize, 24);
      c.writeUInt16LE(nameBuf.length, 28);
      c.writeUInt32LE(e.offset, 42);
      await this.write(Buffer.concat([c, nameBuf]));
    }
    const cdSize = this.offset - cdStart;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(cdSize, 12);
    end.writeUInt32LE(cdStart, 16);
    await this.write(end);
    await new Promise<void>((res, rej) => this.out.end((e: Error | null | undefined) => (e ? rej(e) : res())));
    return this.entries.length;
  }
}

/** Read the central directory. Rejects anything that is not a plain, non-encrypted zip. */
export async function readZipEntries(path: string): Promise<ZipEntry[]> {
  const fh = await open(path, 'r');
  try {
    const size = (await fh.stat()).size;
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new EngineError('VALIDATION', 'Not a zip archive (no end-of-directory record)');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset + cdSize > size) throw new EngineError('VALIDATION', 'Corrupt zip directory');
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const entries: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new EngineError('VALIDATION', 'Corrupt zip directory entry');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      if (flags & 1) throw new EngineError('VALIDATION', 'Encrypted zips are not supported');
      if (method !== 0 && method !== 8) throw new EngineError('VALIDATION', `Unsupported zip compression method ${method}`);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      entries.push({ name: cd.subarray(p + 46, p + 46 + nameLen).toString('utf8'), method: method as 0 | 8, crc: cd.readUInt32LE(p + 16), csize: cd.readUInt32LE(p + 20), usize: cd.readUInt32LE(p + 24), offset: cd.readUInt32LE(p + 42) });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await fh.close();
  }
}

/** Extract one entry into a writable, verifying size and CRC-32 as it streams. */
export async function extractEntry(zipPath: string, e: ZipEntry, sink: Writable, maxBytes = Number.MAX_SAFE_INTEGER): Promise<void> {
  const fh = await open(zipPath, 'r');
  let dataStart: number;
  try {
    const lh = Buffer.alloc(30);
    await fh.read(lh, 0, 30, e.offset);
    if (lh.readUInt32LE(0) !== 0x04034b50) throw new EngineError('VALIDATION', `Corrupt local header for ${e.name}`);
    dataStart = e.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  } finally {
    await fh.close();
  }
  let crc = 0;
  let size = 0;
  const check = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes || size > e.usize) return cb(new EngineError('VALIDATION', `${e.name} is larger than declared`));
      crc = crc32(chunk, crc);
      cb(null, chunk);
    },
    flush(cb) {
      if (size !== e.usize || (crc >>> 0) !== e.crc) cb(new EngineError('VALIDATION', `${e.name} failed its integrity check`));
      else cb();
    },
  });
  const src = createReadStream(zipPath, { start: dataStart, end: dataStart + e.csize - 1 });
  if (e.csize === 0) {
    await pipeline(check, sink).catch((x) => { throw x; });
    return;
  }
  await pipeline(src, ...(e.method === 8 ? [createInflateRaw()] : []), check, sink);
}

export async function extractToBuffer(zipPath: string, e: ZipEntry, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await extractEntry(zipPath, e, new Writable({ write(c, _e, cb) { chunks.push(c); cb(); } }), maxBytes);
  return Buffer.concat(chunks);
}
