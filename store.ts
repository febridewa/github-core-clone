// In-memory forge store: repos, git objects, issues, pulls, merges.
// Everything is deterministic: timestamps derive from a monotonically
// increasing sequence seeded at the scenario epoch; server commit times
// derive from a separate deterministic counter.
import {
  ZERO_OID, objectId, parseCommit, parseTree, buildTree, buildCommit,
  type CommitInfo, type ObjType, type PackObject,
} from './gitobj.ts';
import { buildUsers, SCENARIO_EPOCH_SEC } from './scenario.ts';

export interface Label { id: number; name: string; color: string; description: string; }
export interface Comment { id: number; issueNumber: number; body: string; user: string; createdAt: string; updatedAt: string; seq: number; }
export interface Issue {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: Label[]; comments: Comment[]; user: string;
  createdAt: string; updatedAt: string; seq: number;
}
export interface Pull {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  head: string; base: string; headSha: string; baseSha: string;
  merged: boolean; mergedAt: string | null; mergeCommitSha: string | null;
  user: string; createdAt: string; updatedAt: string; seq: number;
}
export interface Repo {
  id: number; owner: string; name: string; description: string; private: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, PackObject>;
  // Parsed commit headers, cached by oid (commit objects are immutable).
  commitCache: Map<string, CommitInfo>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
  createdSeq: number;
}

export const DEFAULT_LABELS: [string, string][] = [
  ['bug', 'd73a4a'], ['enhancement', 'a2eeef'], ['documentation', '0075ca'],
  ['question', 'd876e3'], ['good first issue', '7057ff'], ['help wanted', '008672'],
];

export const FORGE_AUTHOR = 'Forge <forge@example.invalid>';

export function isoFor(seq: number): string {
  return new Date((SCENARIO_EPOCH_SEC + seq) * 1000).toISOString();
}

export class Store {
  viewerLogin: string;
  viewerId: number;
  viewerName: string;
  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  nextIssueId = 10000;
  nextCommentId = 20000;
  nextLabelId = 30000;
  seq = 0;
  commitCounter = 0;
  requestCounter = 0;

  constructor() {
    const users = buildUsers();
    this.viewerLogin = users[0].login;
    this.viewerId = users[0].id;
    this.viewerName = users[0].name;
  }

  nextSeq(): number { this.seq += 1; return this.seq; }
  nextRequestId(): string { this.requestCounter += 1; return `req-${this.requestCounter}`; }

  repoKey(owner: string, name: string): string { return `${owner}/${name}`; }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      owner, name, description, private: isPrivate,
      defaultBranch: 'main',
      refs: new Map(), objects: new Map(), commitCache: new Map(),
      labels: new Map(), issues: new Map(), pulls: new Map(),
      nextNumber: 1, createdSeq: this.nextSeq(),
    };
    // Labels are created only through POST /labels; the suite's fixture
    // expects creating 'bug' to answer 201, so no labels are pre-seeded.
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  storeObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = objectId(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): PackObject | undefined {
    return repo.objects.get(oid);
  }

  commitInfo(repo: Repo, oid: string) {
    const cached = repo.commitCache.get(oid);
    if (cached !== undefined) return cached;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') return null;
    const info = parseCommit(obj.data);
    repo.commitCache.set(oid, info);
    return info;
  }

  // ---- trees ---------------------------------------------------------------

  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return out;
    for (const entry of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') {
        for (const [p, v] of this.flattenTree(repo, entry.oid, path)) out.set(p, v);
      } else {
        out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    }
    return out;
  }

  buildTreeFromEntries(repo: Repo, entries: Map<string, { mode: string; oid: string }>): string {
    // Group by first path segment; recurse into directories.
    const buildLevel = (paths: Map<string, { mode: string; oid: string }>): string => {
      const levelEntries: { mode: string; name: string; oid: string }[] = [];
      const dirs = new Map<string, Map<string, { mode: string; oid: string }>>();
      for (const [path, v] of paths) {
        const slash = path.indexOf('/');
        if (slash === -1) {
          levelEntries.push({ mode: v.mode, name: path, oid: v.oid });
        } else {
          const dir = path.slice(0, slash);
          const rest = path.slice(slash + 1);
          if (!dirs.has(dir)) dirs.set(dir, new Map());
          dirs.get(dir)!.set(rest, v);
        }
      }
      for (const [dir, sub] of dirs) {
        levelEntries.push({ mode: '40000', name: dir, oid: buildLevel(sub) });
      }
      const data = buildTree(levelEntries);
      return this.storeObject(repo, 'tree', data);
    };
    return buildLevel(entries);
  }

  // ---- ancestry ------------------------------------------------------------

  ancestors(repo: Repo, oid: string): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [oid];
    let qHead = 0;
    while (qHead < queue.length) {
      const cur = queue[qHead]!; qHead += 1;
      if (seen.has(cur) || cur === ZERO_OID) continue;
      seen.add(cur);
      const info = this.commitInfo(repo, cur);
      if (info) for (const p of info.parents) queue.push(p);
    }
    return seen;
  }

  isAncestor(repo: Repo, maybeAncestor: string, oid: string): boolean {
    if (maybeAncestor === ZERO_OID) return true;
    if (maybeAncestor === oid) return true;
    // BFS from oid toward maybeAncestor with early exit: a fast-forward push
    // finds its old tip in 1-2 steps instead of walking the whole history.
    const seen = new Set<string>();
    const queue: string[] = [oid];
    let qHead = 0;
    while (qHead < queue.length) {
      const cur = queue[qHead]!; qHead += 1;
      if (seen.has(cur) || cur === ZERO_OID) continue;
      seen.add(cur);
      if (cur === maybeAncestor) return true;
      const info = this.commitInfo(repo, cur);
      if (info) for (const p of info.parents) queue.push(p);
    }
    return false;
  }

  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = this.ancestors(repo, a);
    const queue: string[] = [b];
    const seen = new Set<string>();
    let qHead = 0;
    while (qHead < queue.length) {
      const cur = queue[qHead]!; qHead += 1;
      if (seen.has(cur) || cur === ZERO_OID) continue;
      seen.add(cur);
      if (ancestorsA.has(cur)) return cur;
      const info = this.commitInfo(repo, cur);
      if (info) for (const p of info.parents) queue.push(p);
    }
    return null;
  }

  // ---- server commits ------------------------------------------------------

  createServerCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
    this.commitCounter += 1;
    const ts = 1700000000 + this.commitCounter;
    const ident = `${FORGE_AUTHOR} ${ts} +0000`;
    const data = buildCommit({ tree: treeOid, parents, author: ident, committer: ident, message });
    return this.storeObject(repo, 'commit', data);
  }

  /** Apply a content change on a branch; returns the new commit oid. */
  applyContentChange(repo: Repo, branch: string, path: string, content: Buffer | null, message: string): string {
    const ref = `refs/heads/${branch}`;
    let tip = repo.refs.get(ref);
    if (!tip && branch !== repo.defaultBranch) {
      // GitHub creates a new branch from the default branch tip.
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    }
    let parents: string[] = [];
    let flat = new Map<string, { mode: string; oid: string }>();
    if (tip && tip !== ZERO_OID) {
      const info = this.commitInfo(repo, tip);
      if (info) {
        parents = [tip];
        flat = this.flattenTree(repo, info.tree);
      }
    }
    if (content === null) flat.delete(path);
    else flat.set(path, { mode: '100644', oid: this.storeObject(repo, 'blob', content) });
    const newTree = this.buildTreeFromEntries(repo, flat);
    const commitOid = this.createServerCommit(repo, newTree, parents, message);
    repo.refs.set(ref, commitOid);
    return commitOid;
  }

  // ---- diffs & merges ------------------------------------------------------

  diffTrees(repo: Repo, baseTreeOid: string, headTreeOid: string): {
    added: { path: string; oid: string }[];
    removed: { path: string; oid: string }[];
    modified: { path: string; oldOid: string; newOid: string }[];
  } {
    const base = this.flattenTree(repo, baseTreeOid);
    const head = this.flattenTree(repo, headTreeOid);
    const added: { path: string; oid: string }[] = [];
    const removed: { path: string; oid: string }[] = [];
    const modified: { path: string; oldOid: string; newOid: string }[] = [];
    for (const [path, v] of head) {
      const b = base.get(path);
      if (!b) added.push({ path, oid: v.oid });
      else if (b.oid !== v.oid) modified.push({ path, oldOid: b.oid, newOid: v.oid });
    }
    for (const [path, v] of base) {
      if (!head.has(path)) removed.push({ path, oid: v.oid });
    }
    return { added, removed, modified };
  }

  lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
    const a = oldText.split('\n');
    const b = newText.split('\n');
    // drop the trailing empty element from a trailing newline on both sides
    if (a.length > 0 && a[a.length - 1] === '') a.pop();
    if (b.length > 0 && b[b.length - 1] === '') b.pop();
    if (a.length > 2000 || b.length > 2000) {
      return { additions: b.length, deletions: a.length };
    }
    // LCS length via two rows
    let prev = new Array<number>(b.length + 1).fill(0);
    let cur = new Array<number>(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i += 1) {
      for (let j = 1; j <= b.length; j += 1) {
        cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      }
      [prev, cur] = [cur, prev];
    }
    const lcs = prev[b.length];
    return { additions: b.length - lcs, deletions: a.length - lcs };
  }

  /** Three-way merge result without writing anything (used for mergeable too). */
  computeMerge(repo: Repo, pull: Pull, method: 'squash' | 'merge'): {
    ok: boolean; conflict: boolean; treeOid?: string; message?: string;
  } {
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    if (!headTip || !baseTip) return { ok: false, conflict: false };
    const headInfo = this.commitInfo(repo, headTip);
    const baseInfo = this.commitInfo(repo, baseTip);
    if (!headInfo || !baseInfo) return { ok: false, conflict: false };
    const mb = this.mergeBase(repo, headTip, baseTip);
    const mbTree = mb ? (this.commitInfo(repo, mb)?.tree ?? '') : '';
    const mbFlat = mbTree ? this.flattenTree(repo, mbTree) : new Map();
    const headFlat = this.flattenTree(repo, headInfo.tree);
    const baseFlat = this.flattenTree(repo, baseInfo.tree);
    const result = new Map(baseFlat);
    const paths = new Set([...mbFlat.keys(), ...headFlat.keys()]);
    for (const path of paths) {
      const mbVal = mbFlat.get(path);
      const headVal = headFlat.get(path);
      const baseVal = baseFlat.get(path);
      const headChanged = (headVal?.oid ?? null) !== (mbVal?.oid ?? null);
      if (!headChanged) continue;
      const baseChanged = (baseVal?.oid ?? null) !== (mbVal?.oid ?? null);
      if (!baseChanged) {
        if (headVal) result.set(path, headVal);
        else result.delete(path);
      } else if ((headVal?.oid ?? null) === (baseVal?.oid ?? null)) {
        // both changed to the same thing — keep it
      } else {
        return { ok: false, conflict: true };
      }
    }
    const treeOid = this.buildTreeFromEntries(repo, result);
    const message = method === 'squash'
      ? `${pull.title} (#${pull.number})`
      : `Merge pull request #${pull.number} from ${repo.owner}/${pull.head}`;
    return { ok: true, conflict: false, treeOid, message };
  }

  mergePull(repo: Repo, pull: Pull, method: 'squash' | 'merge'): string | null {
    const res = this.computeMerge(repo, pull, method);
    if (!res.ok || !res.treeOid || !res.message) return null;
    const headTip = repo.refs.get(`refs/heads/${pull.head}`)!;
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`)!;
    const parents = method === 'squash' ? [baseTip] : [baseTip, headTip];
    const commitOid = this.createServerCommit(repo, res.treeOid, parents, res.message);
    repo.refs.set(`refs/heads/${pull.base}`, commitOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = isoFor(this.nextSeq());
    pull.mergeCommitSha = commitOid;
    pull.updatedAt = pull.mergedAt;
    return commitOid;
  }

  mergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    if (!headTip || !baseTip) return 'UNKNOWN';
    const res = this.computeMerge(repo, pull, 'merge');
    if (res.conflict) return 'CONFLICTING';
    if (!res.ok) return 'UNKNOWN';
    return 'MERGEABLE';
  }

  // ---- global ids (GraphQL node) -------------------------------------------

  globalId(kind: string, repoId: number, number?: number): string {
    const raw = number === undefined
      ? `github-core-clone:${kind}:${repoId}`
      : `github-core-clone:${kind}:${repoId}:${number}`;
    return Buffer.from(raw, 'utf8').toString('base64url');
  }

  decodeGlobalId(id: string): { kind: string; repoId: number; number?: number } | null {
    try {
      const raw = Buffer.from(id, 'base64url').toString('utf8');
      const parts = raw.split(':');
      if (parts.length < 3 || parts[0] !== 'github-core-clone') return null;
      const kind = parts[1];
      const repoId = Number.parseInt(parts[2], 10);
      if (!Number.isFinite(repoId)) return null;
      if (parts.length >= 4) {
        const number = Number.parseInt(parts[3], 10);
        return { kind, repoId, number };
      }
      return { kind, repoId };
    } catch {
      return null;
    }
  }

  findRepoById(repoId: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === repoId) return repo;
    return undefined;
  }
}
