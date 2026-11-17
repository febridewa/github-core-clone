// Git object model, packfiles, pkt-lines — pure functions, no I/O.
import { createHash } from 'node:crypto';
import { deflateSync as dz, inflateSync as iz } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export function objectId(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

export function objectRaw(type: ObjType, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'ascii'), data]);
}

export function parseObjectRaw(raw: Buffer): { type: ObjType; data: Buffer } {
  const nul = raw.indexOf(0);
  const header = raw.subarray(0, nul).toString('ascii');
  const [type, lenStr] = header.split(' ');
  const len = Number.parseInt(lenStr, 10);
  return { type: type as ObjType, data: Buffer.from(raw.subarray(nul + 1, nul + 1 + len)) };
}

// ---- commit / tree / tag builders & parsers --------------------------------

export function buildCommit(opts: {
  tree: string; parents: string[]; author: string; committer: string; message: string;
}): Buffer {
  const lines: string[] = [`tree ${opts.tree}`];
  for (const p of opts.parents) lines.push(`parent ${p}`);
  lines.push(`author ${opts.author}`, `committer ${opts.committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${opts.message}`, 'utf8');
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const sep = text.indexOf('\n\n');
  const head = sep >= 0 ? text.slice(0, sep) : text;
  const message = sep >= 0 ? text.slice(sep + 2) : '';
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  return info;
}

export interface TreeEntry { mode: string; name: string; oid: string; }

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = entries.slice().sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const mode = data.subarray(off, sp).toString('ascii');
    const nul = data.indexOf(0, sp + 1);
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

export function buildTag(opts: { object: string; type: ObjType; tag: string; tagger: string; message: string }): Buffer {
  return Buffer.from(
    `object ${opts.object}\ntype ${opts.type}\ntag ${opts.tag}\ntagger ${opts.tagger}\n\n${opts.message}`,
    'utf8',
  );
}

// ---- pkt-line ---------------------------------------------------------------

export function pktLine(data: Buffer | string): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  const header = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

export const FLUSH_PKT = Buffer.from('0000', 'ascii');
export const DELIM_PKT = Buffer.from('0001', 'ascii');
export const RESPONSE_END_PKT = Buffer.from('0002', 'ascii');

export type PktLine = { kind: 'data' | 'flush' | 'delim' | 'response-end'; data: Buffer };

export function parsePktLines(buf: Buffer): PktLine[] {
  const out: PktLine[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = Number.parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) { out.push({ kind: 'flush', data: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim', data: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 2) { out.push({ kind: 'response-end', data: Buffer.alloc(0) }); off += 4; continue; }
    if (off + len > buf.length) break;
    out.push({ kind: 'data', data: Buffer.from(buf.subarray(off + 4, off + len)) });
    off += len;
  }
  return out;
}

// ---- packfiles --------------------------------------------------------------

const TYPE_NUM: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readDeltaVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off]; off += 1;
      value |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return value;
  };
  readDeltaVarint(); // source size
  const targetSize = readDeltaVarint();
  const parts: Buffer[] = [];
  while (off < delta.length) {
    const op = delta[off]; off += 1;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      if (op & 0x01) { cpOff = delta[off]; off += 1; }
      if (op & 0x02) { cpOff |= delta[off] << 8; off += 1; }
      if (op & 0x04) { cpOff |= delta[off] << 16; off += 1; }
      if (op & 0x08) { cpOff |= delta[off] << 24; off += 1; }
      if (op & 0x10) { cpSize = delta[off]; off += 1; }
      if (op & 0x20) { cpSize |= delta[off] << 8; off += 1; }
      if (op & 0x40) { cpSize |= delta[off] << 16; off += 1; }
      if (cpSize === 0) cpSize = 0x10000;
      parts.push(base.subarray(cpOff, cpOff + cpSize));
    } else if (op !== 0) {
      parts.push(delta.subarray(off, off + op));
      off += op;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize) throw new Error('delta target size mismatch');
  return out;
}

export interface PackObject { type: ObjType; data: Buffer; }

/** Adler-32 checksum (the zlib stream trailer). */
function adler32(buf: Buffer): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < buf.length; i += 1) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Inflate a zlib stream starting at buf[0] and report exactly how many bytes it consumed.
 *  Node's inflateSync ignores trailing bytes and throws on truncation, so one call
 *  yields the decompressed data; the stream's end is then located by scanning for
 *  the Adler-32 trailer (big-endian, the last 4 bytes of the stream) and verified
 *  by re-inflating the exact slice — a false-positive match is detected because
 *  the truncated slice fails to inflate. Two inflateSync calls per object instead
 *  of a ~15-call binary search. */
function inflateWithLength(buf: Buffer): { data: Buffer; consumed: number } {
  let data: Buffer;
  try {
    data = iz(buf);
  } catch {
    throw new Error('cannot inflate pack object');
  }
  const adler = adler32(data);
  const needle = Buffer.alloc(4);
  needle.writeUInt32BE(adler, 0);
  let pos = 2; // skip the 2-byte zlib header
  for (;;) {
    const idx = buf.indexOf(needle, pos);
    if (idx === -1) throw new Error('cannot find zlib stream end');
    const end = idx + 4;
    try {
      const check = iz(buf.subarray(0, end));
      if (check.equals(data)) return { data, consumed: end };
    } catch {
      // false-positive Adler match inside the deflate data; keep scanning
    }
    pos = idx + 1;
  }
}

export function parsePack(
  buf: Buffer,
  resolveExternal?: (oid: string) => PackObject | undefined,
): Map<string, PackObject> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const byOffset = new Map<number, PackObject>();
  const objects = new Map<string, PackObject>();
  const deltas: { offset: number; baseOid?: string; baseOffset?: number; delta: Buffer }[] = [];
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const start = off;
    let byte = buf[off]; off += 1;
    const typeNum = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[off]; off += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeNum === 6) {
      // OFS_DELTA: negative offset from this object's start
      let b2 = buf[off]; off += 1;
      let baseOff = b2 & 0x7f;
      while (b2 & 0x80) {
        b2 = buf[off]; off += 1;
        baseOff = ((baseOff + 1) << 7) | (b2 & 0x7f);
      }
      const inflated = inflateWithLength(buf.subarray(off));
      off += inflated.consumed;
      deltas.push({ offset: start, baseOffset: start - baseOff, delta: inflated.data });
      continue;
    }
    if (typeNum === 7) {
      // REF_DELTA: base by oid
      const baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
      const inflated = inflateWithLength(buf.subarray(off));
      off += inflated.consumed;
      deltas.push({ offset: start, baseOid, delta: inflated.data });
      continue;
    }
    const type = TYPE_NUM[typeNum];
    if (!type) throw new Error(`unknown pack object type ${typeNum}`);
    const inflated = inflateWithLength(buf.subarray(off));
    off += inflated.consumed;
    if (inflated.data.length !== size) throw new Error('pack object size mismatch');
    const oid = objectId(type, inflated.data);
    const obj: PackObject = { type, data: inflated.data };
    byOffset.set(start, obj);
    objects.set(oid, obj);
  }
  // Resolve deltas (bases appear before their deltas in a well-formed pack).
  for (const d of deltas) {
    let base: PackObject | undefined;
    if (d.baseOffset !== undefined) base = byOffset.get(d.baseOffset);
    else if (d.baseOid !== undefined) base = objects.get(d.baseOid) ?? resolveExternal?.(d.baseOid);
    if (!base) throw new Error('delta base not found in pack');
    const data = applyDelta(base.data, d.delta);
    const oid = objectId(base.type, data);
    const obj: PackObject = { type: base.type, data };
    byOffset.set(d.offset, obj);
    objects.set(oid, obj);
  }
  return objects;
}

export function buildPack(objects: Map<string, PackObject>): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.size, 8);
  const parts: Buffer[] = [header];
  for (const obj of objects.values()) {
    const typeCode = TYPE_CODE[obj.type];
    const data = obj.data;
    const size = data.length;
    const headerBytes: number[] = [];
    let remaining = size >>> 4;
    let first = (typeCode << 4) | (size & 0x0f);
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let b = remaining & 0x7f;
      remaining >>>= 7;
      if (remaining > 0) b |= 0x80;
      headerBytes.push(b);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(dz(data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
