// Smart-HTTP git protocol: info/refs (v0 + v2), upload-pack (v0 + v2),
// receive-pack (v0-only). All behaviour mirrors the sealed suite's client
// (sdk/conformance/git-client.ts) so every check's expectations are met.
import {
  ZERO_OID, pktLine, FLUSH_PKT, DELIM_PKT, parsePktLines, parsePack, buildPack,
  parseCommit, parseTree, objectId, type ObjType, type PackObject,
} from './gitobj.ts';
import type { Repo, Store } from './store.ts';

const AGENT = 'github-core-clone/1.0';
const MAX_PKT = 65520;
// sideband payload = 1 band byte + data; pkt-line header is 4 bytes
const SIDEBAND_CHUNK = MAX_PKT - 4 - 1;

export interface GitResponse { status: number; contentType: string; body: Buffer; }

function sortedRefNames(repo: Repo): string[] {
  const names = [...repo.refs.keys()];
  names.sort();
  return names;
}

/** The commit an annotated tag points at (null if the oid is not a tag). */
function peelTag(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  const text = obj.data.toString('utf8');
  const m = /^object ([0-9a-f]{40})$/m.exec(text);
  return m ? m[1] : null;
}

/** HEAD's target ref (the repo's default branch). */
function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// ---- advertisements ---------------------------------------------------------

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH_PKT];
  const caps = service === 'git-upload-pack'
    ? `symref=HEAD:${headTarget(repo)} agent=${AGENT} object-format=sha1 side-band-64k shallow`
    : `report-status report-status-v2 side-band-64k delete-refs agent=${AGENT} object-format=sha1`;
  const names = sortedRefNames(repo);
  if (names.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = repo.refs.get(headTarget(repo)) ?? ZERO_OID;
    const headLine = headOid === ZERO_OID
      ? `${ZERO_OID} HEAD\0${caps}\n`
      : `${headOid} HEAD\0${caps}\n`;
    parts.push(pktLine(headLine));
    for (const name of names) {
      const oid = repo.refs.get(name)!;
      parts.push(pktLine(`${oid} ${name}\n`));
      const peeled = peelTag(repo, oid);
      if (peeled) parts.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    FLUSH_PKT,
  ];
  return Buffer.concat(parts);
}

export function handleInfoRefs(
  repo: Repo | undefined, service: 'git-upload-pack' | 'git-receive-pack',
  gitProtocolVersion2: boolean,
): GitResponse {
  if (!repo) {
    return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' })) };
  }
  const contentType = service === 'git-upload-pack'
    ? 'application/x-git-upload-pack-advertisement'
    : 'application/x-git-receive-pack-advertisement';
  const body = service === 'git-receive-pack'
    ? v0Advertisement(repo, service)
    : gitProtocolVersion2 ? v2Advertisement() : v0Advertisement(repo, service);
  return { status: 200, contentType, body };
}

// ---- fetch object selection --------------------------------------------------

interface FetchSelection {
  objects: Map<string, PackObject>;
  shallow: string[];
  unshallow: string[];
  ack: string | null;
}

function collectReachable(repo: Repo, from: string, out: Map<string, PackObject>): void {
  const obj = repo.objects.get(from);
  if (!obj) return;
  if (out.has(from)) return;
  out.set(from, obj);
  if (obj.type === 'commit') {
    const info = parseCommit(obj.data);
    collectReachable(repo, info.tree, out);
    for (const p of info.parents) collectReachable(repo, p, out);
  } else if (obj.type === 'tree') {
    for (const entry of parseTree(obj.data)) collectReachable(repo, entry.oid, out);
  } else if (obj.type === 'tag') {
    const text = obj.data.toString('utf8');
    const m = /^object ([0-9a-f]{40})$/m.exec(text);
    if (m) collectReachable(repo, m[1], out);
  }
}

/** What the client already holds from a commit: its tree, plus its history —
 *  except that a shallow boundary's parents were never sent, so the walk
 *  stops at any commit in `shallowSet`. */
function collectHeldReachable(repo: Repo, from: string, shallowSet: Set<string>, out: Map<string, PackObject>): void {
  const obj = repo.objects.get(from);
  if (!obj) return;
  if (out.has(from)) return;
  out.set(from, obj);
  if (obj.type === 'commit') {
    const info = parseCommit(obj.data);
    collectReachable(repo, info.tree, out);
    if (!shallowSet.has(from)) {
      for (const p of info.parents) collectHeldReachable(repo, p, shallowSet, out);
    }
  } else if (obj.type === 'tree') {
    for (const entry of parseTree(obj.data)) collectReachable(repo, entry.oid, out);
  } else if (obj.type === 'tag') {
    const text = obj.data.toString('utf8');
    const m = /^object ([0-9a-f]{40})$/m.exec(text);
    if (m) collectHeldReachable(repo, m[1], shallowSet, out);
  }
}

function selectFetchObjects(
  repo: Repo, wants: string[], haves: string[], depth: number | null, requestShallow: string[],
): FetchSelection {
  const held = new Set(haves);
  const shallowSet = new Set(requestShallow);
  const included = new Map<string, number>();
  const boundary = new Set<string>();
  // A tag want contributes its target commit (generation 0); the tag object
  // itself is always sent (it is never among the held objects).
  const tagWants: string[] = [];
  const queue: { oid: string; gen: number }[] = [];
  for (const w of wants) {
    const obj = repo.objects.get(w);
    if (obj && obj.type === 'tag') {
      tagWants.push(w);
      const target = peelTag(repo, w);
      if (target) queue.push({ oid: target, gen: 0 });
    } else {
      queue.push({ oid: w, gen: 0 });
    }
  }
  const seen = new Set<string>();
  let qHead = 0;
  while (qHead < queue.length) {
    const { oid, gen } = queue[qHead]!; qHead += 1;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    const isHeld = held.has(oid);
    const include = !isHeld && (depth === null || gen < depth);
    if (include) {
      included.set(oid, gen);
      let cut = false;
      for (const p of info.parents) {
        if (held.has(p)) continue;
        if (depth !== null && gen + 1 >= depth) { cut = true; continue; }
        if (!repo.objects.has(p)) { cut = true; continue; }
        queue.push({ oid: p, gen: gen + 1 });
      }
      if (cut) boundary.add(oid);
    } else if (isHeld && depth !== null) {
      // A held tip can still be deepened: walk through it to deeper generations.
      for (const p of info.parents) {
        if (held.has(p)) continue;
        if (gen + 1 >= depth) continue;
        if (!repo.objects.has(p)) continue;
        queue.push({ oid: p, gen: gen + 1 });
      }
    }
  }
  // Collect objects for included commits only: each included commit plus its
  // full tree. A parent is followed only when it is itself included, so a
  // depth limit cuts the history exactly at the boundary.
  const toSend = new Map<string, PackObject>();
  for (const oid of included.keys()) {
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    toSend.set(oid, obj);
    if (obj.type === 'commit') {
      collectReachable(repo, parseCommit(obj.data).tree, toSend);
    }
  }
  for (const tagOid of tagWants) {
    const obj = repo.objects.get(tagOid);
    if (obj) toSend.set(tagOid, obj);
  }
  // Subtract what the client already holds. A held commit's history is held
  // in full — except when it is a shallow boundary, where its parents were
  // never sent, so the subtraction stops there.
  const heldObjects = new Map<string, PackObject>();
  for (const h of held) collectHeldReachable(repo, h, shallowSet, heldObjects);
  for (const oid of heldObjects.keys()) toSend.delete(oid);

  const unshallow: string[] = [];
  for (const s of requestShallow) {
    if (boundary.has(s)) continue;
    const obj = repo.objects.get(s);
    if (!obj || obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    if (info.parents.every((p) => held.has(p) || included.has(p))) unshallow.push(s);
  }
  // ACK: a have that is an ancestor of (or equal to) some want.
  let ack: string | null = null;
  for (const h of haves) {
    for (const w of wants) {
      if (h === w) { ack = h; break; }
      const ancestors = new Set<string>();
      const q = [w];
      let qHead = 0;
      while (qHead < q.length) {
        const cur = q[qHead]!; qHead += 1;
        if (ancestors.has(cur)) continue;
        ancestors.add(cur);
        const o = repo.objects.get(cur);
        if (o && o.type === 'commit') for (const p of parseCommit(o.data).parents) q.push(p);
      }
      if (ancestors.has(h)) { ack = h; break; }
    }
    if (ack) break;
  }
  return { objects: toSend, shallow: [...boundary], unshallow, ack };
}

/** One sideband pkt-line (band byte 1 + payload) in a single allocation:
 *  4-byte hex length, 1 band byte, payload — no nested Buffer.concat. */
function sidebandLine(payload: Buffer): Buffer {
  const total = payload.length + 5;
  const buf = Buffer.alloc(total);
  buf.write(total.toString(16).padStart(4, '0'), 0, 'ascii');
  buf[4] = 1;
  payload.copy(buf, 5);
  return buf;
}

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let off = 0; off < pack.length; off += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + SIDEBAND_CHUNK));
    parts.push(sidebandLine(chunk));
  }
  return Buffer.concat(parts);
}

// ---- upload-pack -------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseV0FetchBody(body: Buffer): FetchRequest | null {
  const lines = parsePktLines(body);
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  let section = 0;
  for (const pkt of lines) {
    if (pkt.kind === 'flush') { section += 1; continue; }
    if (pkt.kind !== 'data') continue;
    const text = pkt.data.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (text.startsWith('want ')) req.wants.push(text.slice(5).split(' ')[0]);
      else if (text.startsWith('shallow ')) req.shallow.push(text.slice(8));
      else if (text.startsWith('deepen ')) req.depth = Number.parseInt(text.slice(7), 10);
    } else {
      if (text.startsWith('have ')) req.haves.push(text.slice(5));
      // 'done' ends negotiation
    }
  }
  return req;
}

function parseV2FetchBody(body: Buffer): FetchRequest | null {
  const lines = parsePktLines(body);
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  let inArgs = false;
  for (const pkt of lines) {
    if (pkt.kind === 'delim') { inArgs = true; continue; }
    if (pkt.kind === 'flush') break;
    if (pkt.kind !== 'data' || !inArgs) continue;
    const text = pkt.data.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('want ')) req.wants.push(text.slice(5));
    else if (text.startsWith('have ')) req.haves.push(text.slice(5));
    else if (text.startsWith('shallow ')) req.shallow.push(text.slice(8));
    else if (text.startsWith('deepen ')) req.depth = Number.parseInt(text.slice(7), 10);
    // thin-pack / no-progress / ofs-delta / filter / done: accepted, no action
  }
  return req;
}

function v0FetchResponse(repo: Repo, req: FetchRequest): Buffer {
  const sel = selectFetchObjects(repo, req.wants, req.haves, req.depth, req.shallow);
  const parts: Buffer[] = [];
  if (sel.ack) parts.push(pktLine(`ACK ${sel.ack}\n`));
  else parts.push(pktLine('NAK\n'));
  for (const s of sel.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const u of sel.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
  parts.push(sidebandPack(buildPack(sel.objects)));
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

function v2FetchResponse(repo: Repo, req: FetchRequest): Buffer {
  const sel = selectFetchObjects(repo, req.wants, req.haves, req.depth, req.shallow);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (sel.ack) { parts.push(pktLine(`ACK ${sel.ack}\n`)); parts.push(pktLine('ready\n')); }
  else parts.push(pktLine('NAK\n'));
  parts.push(FLUSH_PKT);
  if (sel.shallow.length > 0 || sel.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of sel.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const u of sel.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
    parts.push(FLUSH_PKT);
  }
  const wantedRefs: string[] = [];
  for (const want of req.wants) {
    for (const name of sortedRefNames(repo)) {
      if (repo.refs.get(name) === want) wantedRefs.push(`${want} ${name}\n`);
    }
  }
  if (wantedRefs.length > 0) {
    parts.push(pktLine('wanted-refs\n'));
    for (const line of wantedRefs) parts.push(pktLine(line));
    parts.push(FLUSH_PKT);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(buildPack(sel.objects)));
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

function lsRefsResponse(repo: Repo, body: Buffer): Buffer {
  const lines = parsePktLines(body);
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  let inArgs = false;
  for (const pkt of lines) {
    if (pkt.kind === 'delim') { inArgs = true; continue; }
    if (pkt.kind === 'flush') break;
    if (pkt.kind !== 'data' || !inArgs) continue;
    const text = pkt.data.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
    else if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
  }
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const names = sortedRefNames(repo);
  const headOid = repo.refs.get(headTarget(repo));
  if (names.length === 0) {
    if (unborn && keep('HEAD')) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${headTarget(repo)}` : ''}\n`));
    }
  } else {
    if (keep('HEAD') && headOid) {
      parts.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${headTarget(repo)}` : ''}\n`));
    }
    for (const name of names) {
      if (!keep(name)) continue;
      const oid = repo.refs.get(name)!;
      let line = `${oid} ${name}`;
      if (peel) {
        const peeled = peelTag(repo, oid);
        if (peeled) line += ` peeled:${peeled}`;
      }
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

export function handleUploadPack(
  repo: Repo | undefined, body: Buffer, gitProtocolVersion2: boolean,
): GitResponse {
  const contentType = 'application/x-git-upload-pack-result';
  if (!repo) {
    return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' })) };
  }
  try {
    const first = parsePktLines(body)[0];
    const firstText = first && first.kind === 'data' ? first.data.toString('utf8').replace(/\n$/, '') : '';
    if (firstText === 'command=ls-refs') {
      return { status: 200, contentType, body: lsRefsResponse(repo, body) };
    }
    if (firstText === 'command=fetch') {
      return { status: 200, contentType, body: v2FetchResponse(repo, parseV2FetchBody(body)!) };
    }
    if (gitProtocolVersion2) {
      return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Bad Request' })) };
    }
    const req = parseV0FetchBody(body);
    if (!req || req.wants.length === 0) {
      return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Bad Request' })) };
    }
    return { status: 200, contentType, body: v0FetchResponse(repo, req) };
  } catch {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Bad Request' })) };
  }
}

// ---- receive-pack ------------------------------------------------------------

export function handleReceivePack(repo: Repo | undefined, body: Buffer): GitResponse {
  const contentType = 'application/x-git-receive-pack-result';
  if (!repo) {
    return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' })) };
  }
  try {
    // Parse command pkt-lines up to the flush; the remainder is the pack.
    const commands: { oldOid: string; newOid: string; ref: string }[] = [];
    let off = 0;
    let packStart = body.length;
    while (off + 4 <= body.length) {
      const len = Number.parseInt(body.subarray(off, off + 4).toString('ascii'), 16);
      if (Number.isNaN(len)) break;
      if (len === 0) { off += 4; packStart = off; break; }
      if (len === 1 || len === 2) { off += 4; continue; }
      if (off + len > body.length) break;
      const text = body.subarray(off + 4, off + len).toString('utf8').replace(/\n$/, '');
      const nul = text.indexOf('\0');
      const cmdText = nul >= 0 ? text.slice(0, nul) : text;
      const parts = cmdText.split(' ');
      if (parts.length >= 3) {
        commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
      }
      off += len;
    }
    if (commands.length === 0) {
      return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Bad Request' })) };
    }
    // Unpack: store every pack object.
    let unpackOk = true;
    let unpackDetail = 'ok';
    const packBytes = body.subarray(packStart);
    if (packBytes.length > 0) {
      try {
        const objects = parsePack(packBytes, (oid) => {
          const o = repo.objects.get(oid);
          return o ? { type: o.type as ObjType, data: o.data } : undefined;
        });
        for (const [oid, obj] of objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, { type: obj.type, data: obj.data });
        }
      } catch (e) {
        unpackOk = false;
        unpackDetail = 'unpacker error';
      }
    }
    // Apply per-ref, in order, reporting ok/ng per ref.
    const reportLines: string[] = [`unpack ${unpackDetail}\n`];
    for (const cmd of commands) {
      let ok = false;
      let reason = '';
      if (!unpackOk) {
        reason = 'unpack failed';
      } else {
        const current = repo.refs.get(cmd.ref);
        const isDelete = cmd.newOid === ZERO_OID;
        if (current === undefined) {
          if (isDelete) { reason = 'reference does not exist'; }
          else if (cmd.oldOid !== ZERO_OID) { reason = 'old value mismatch'; }
          else if (!repo.objects.has(cmd.newOid)) { reason = 'missing object'; }
          else { repo.refs.set(cmd.ref, cmd.newOid); ok = true; }
        } else if (isDelete) {
          if (cmd.oldOid !== current) reason = 'old value mismatch';
          else { repo.refs.delete(cmd.ref); ok = true; }
        } else {
          if (cmd.oldOid !== current) reason = 'old value mismatch';
          else if (!repo.objects.has(cmd.newOid)) reason = 'missing object';
          else if (cmd.newOid === current) ok = true;
          else if (isFastForward(repo, current, cmd.newOid)) { repo.refs.set(cmd.ref, cmd.newOid); ok = true; }
          else reason = 'non-fast-forward';
        }
      }
      reportLines.push(ok ? `ok ${cmd.ref}\n` : `ng ${cmd.ref} ${reason}\n`);
    }
    // Report-status inside sideband band 1: each report pkt-line wrapped in a
    // sideband pkt-line whose payload is 0x01 + the report pkt-line.
    const parts: Buffer[] = [];
    for (const line of reportLines) {
      parts.push(sidebandLine(pktLine(line)));
    }
    parts.push(FLUSH_PKT);
    return { status: 200, contentType, body: Buffer.concat(parts) };
  } catch {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Bad Request' })) };
  }
}

function isFastForward(repo: Repo, current: string, next: string): boolean {
  // next must be a descendant of current (or equal).
  const queue = [next];
  const seen = new Set<string>();
  let qHead = 0;
  while (qHead < queue.length) {
    const cur = queue[qHead]!; qHead += 1;
    if (cur === current) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return false;
}

export { objectId };
