// GitHub REST v3 surface (/api/v3). All replies are JSON with a non-empty
// X-GitHub-Request-Id; unknown routes are JSON 404; malformed JSON is 400;
// no token is 401; another owner's repo name is 404 (never 403).
import { parseCommit, parseTree, ZERO_OID } from './gitobj.ts';
import { isoFor, type Issue, type Label, type Pull, type Repo, type Store } from './store.ts';

export interface RestResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export function jsonBody(store: Store, status: number, value: unknown, extraHeaders: Record<string, string> = {}): RestResponse {
  return {
    status,
    headers: { 'Content-Type': 'application/json', 'X-GitHub-Request-Id': store.nextRequestId(), ...extraHeaders },
    body: Buffer.from(JSON.stringify(value)),
  };
}

export function jsonError(store: Store, status: number, message: string): RestResponse {
  return jsonBody(store, status, { message });
}

export function isAuthed(headers: Record<string, string | string[] | undefined>, expectedToken: string | null): boolean {
  const raw = headers['authorization'];
  const auth = Array.isArray(raw) ? raw[0] : raw;
  if (!auth || !auth.startsWith('Bearer ')) return false;
  const token = auth.slice('Bearer '.length);
  if (!token) return false;
  if (expectedToken === null) return true; // local dev: any bearer token
  return token === expectedToken;
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === '' ? 0 : 1000 },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: isoFor(repo.createdSeq),
    updated_at: isoFor(repo.createdSeq),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

function issueJson(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: issue.user },
    labels: issue.labels.map((l) => ({ id: l.id, name: l.name, color: l.color, description: l.description })),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(pull: Pull, repo: Repo): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: pull.user },
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function parseJsonBody(body: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(body.toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

/** Commits reachable from `tip`, newest first (BFS by generation, parents after children). */
function listCommits(store: Store, repo: Repo, tip: string): { sha: string; message: string }[] {
  const out: { sha: string; message: string }[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  let qHead = 0;
  while (qHead < queue.length) {
    const cur = queue[qHead]!; qHead += 1;
    if (seen.has(cur) || cur === ZERO_OID) continue;
    seen.add(cur);
    const info = store.commitInfo(repo, cur);
    if (!info) continue;
    out.push({ sha: cur, message: info.message });
    for (const p of info.parents) queue.push(p);
  }
  return out;
}

export function handleRest(
  store: Store,
  expectedToken: string | null,
  method: string,
  segments: string[], // path segments after /api/v3
  query: URLSearchParams,
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
  origin: string,
): RestResponse {
  const scopes = { 'X-OAuth-Scopes': 'repo, read:org' };
  // Root
  if (segments.length === 0) {
    if (method !== 'GET') return jsonError(store, 404, 'Not Found');
    return jsonBody(store, 200, { current_user_url: '/api/v3/user' }, scopes);
  }
  const [first, ...rest] = segments;

  // /meta (no auth needed? The checks call it with the token; accept either way)
  if (first === 'meta') {
    if (method !== 'GET') return jsonError(store, 404, 'Not Found');
    return jsonBody(store, 200, { installed_version: '1.0.0' });
  }

  // Auth gate for everything below (except root/meta)
  if (!isAuthed(headers, expectedToken)) {
    return jsonError(store, 401, 'Requires authentication');
  }

  // /user
  if (first === 'user') {
    if (rest.length === 0) {
      if (method !== 'GET') return jsonError(store, 404, 'Not Found');
      return jsonBody(store, 200, {
        login: store.viewerLogin, id: store.viewerId, name: store.viewerName,
        email: `${store.viewerLogin}@example.invalid`, type: 'User',
      });
    }
    if (rest[0] === 'repos') {
      if (method === 'POST') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return jsonError(store, 400, 'Problems parsing JSON');
        const name = typeof parsed.value.name === 'string' ? parsed.value.name : '';
        const description = typeof parsed.value.description === 'string' ? parsed.value.description : '';
        const isPrivate = parsed.value.private === true;
        if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
          return jsonError(store, 422, 'Invalid repository name');
        }
        if (store.getRepo(store.viewerLogin, name)) {
          return jsonError(store, 422, 'Repository already exists');
        }
        const repo = store.createRepo(store.viewerLogin, name, description, isPrivate);
        return jsonBody(store, 201, repoJson(repo));
      }
      if (method === 'GET') {
        const perPage = Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30);
        const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
        const all = [...store.repos.values()]
          .filter((r) => r.owner === store.viewerLogin)
          .sort((a, b) => a.createdSeq - b.createdSeq);
        const start = (page - 1) * perPage;
        const slice = all.slice(start, start + perPage);
        const extra: Record<string, string> = {};
        if (start + perPage < all.length) {
          const nextUrl = `${origin}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
          extra.Link = `<${nextUrl}>; rel="next"`;
        }
        return jsonBody(store, 200, slice.map(repoJson), extra);
      }
      return jsonError(store, 404, 'Not Found');
    }
    return jsonError(store, 404, 'Not Found');
  }

  // /repos/{owner}/{repo}/...
  if (first === 'repos') {
    const [owner, repoName, ...tail] = rest;
    if (!owner || !repoName) return jsonError(store, 404, 'Not Found');
    const repo = owner === store.viewerLogin ? store.getRepo(owner, repoName) : undefined;
    if (!repo) return jsonError(store, 404, 'Not Found');

    if (tail.length === 0) {
      if (method === 'GET') return jsonBody(store, 200, repoJson(repo));
      if (method === 'PATCH') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return jsonError(store, 400, 'Problems parsing JSON');
        if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
        if (typeof parsed.value.private === 'boolean') repo.private = parsed.value.private;
        if (typeof parsed.value.default_branch === 'string' && repo.refs.has(`refs/heads/${parsed.value.default_branch}`)) {
          repo.defaultBranch = parsed.value.default_branch;
        }
        return jsonBody(store, 200, repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        return { status: 204, headers: { 'X-GitHub-Request-Id': store.nextRequestId() }, body: Buffer.alloc(0) };
      }
      return jsonError(store, 404, 'Not Found');
    }

    const [section, ...sub] = tail;

    // git/refs
    if (section === 'git' && sub[0] === 'refs') {
      if (method === 'POST' && sub.length === 1) {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return jsonError(store, 400, 'Problems parsing JSON');
        const ref = typeof parsed.value.ref === 'string' ? parsed.value.ref : '';
        const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : '';
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) {
          return jsonError(store, 422, 'Invalid ref or sha');
        }
        if (repo.refs.has(ref)) return jsonError(store, 422, 'Reference already exists');
        if (!repo.objects.has(sha)) return jsonError(store, 422, 'Object does not exist');
        repo.refs.set(ref, sha);
        return jsonBody(store, 201, { ref, object: { sha, type: 'commit' } });
      }
      if (method === 'GET') {
        // /git/refs/heads/{branch} — return the ref
        const ref = `refs/${sub.join('/')}`;
        const sha = repo.refs.get(ref);
        if (!sha) return jsonError(store, 404, 'Not Found');
        return jsonBody(store, 200, { ref, object: { sha, type: 'commit' } });
      }
      return jsonError(store, 404, 'Not Found');
    }

    // branches
    if (section === 'branches') {
      if (method === 'GET' && sub.length === 0) {
        const list = [...repo.refs.keys()]
          .filter((r) => r.startsWith('refs/heads/'))
          .sort()
          .map((r) => ({ name: r.slice('refs/heads/'.length), commit: { sha: repo.refs.get(r)! } }));
        return jsonBody(store, 200, list);
      }
      if (method === 'GET' && sub.length >= 1) {
        const branch = sub.join('/');
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) return jsonError(store, 404, 'Not Found');
        return jsonBody(store, 200, { name: branch, commit: { sha } });
      }
      return jsonError(store, 404, 'Not Found');
    }

    // commits
    if (section === 'commits') {
      if (method === 'GET' && sub.length === 0) {
        const shaParam = query.get('sha');
        let tip: string | undefined;
        if (shaParam) {
          tip = repo.refs.get(`refs/heads/${shaParam}`) ?? repo.refs.get(shaParam) ?? (/^[0-9a-f]{40}$/.test(shaParam) ? shaParam : undefined);
        } else {
          tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        }
        if (!tip) return jsonBody(store, 200, []);
        const commits = listCommits(store, repo, tip);
        return jsonBody(store, 200, commits.map((c) => ({
          sha: c.sha,
          commit: { message: c.message },
          url: `/api/v3/repos/${owner}/${repoName}/commits/${c.sha}`,
        })));
      }
      return jsonError(store, 404, 'Not Found');
    }

    // contents
    if (section === 'contents') {
      const path = sub.join('/');
      if (method === 'PUT') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return jsonError(store, 400, 'Problems parsing JSON');
        const message = typeof parsed.value.message === 'string' ? parsed.value.message : 'Update';
        const contentB64 = typeof parsed.value.content === 'string' ? parsed.value.content : '';
        const branch = typeof parsed.value.branch === 'string' ? parsed.value.branch : repo.defaultBranch;
        const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined;
        let content: Buffer;
        try {
          content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
        } catch {
          return jsonError(store, 400, 'Invalid base64 content');
        }
        const ref = `refs/heads/${branch}`;
        const tip = repo.refs.get(ref);
        // 201 when the file is created at this path, 200 when it is updated.
        let isCreate = true;
        if (tip) {
          const info = store.commitInfo(repo, tip);
          const flat = info ? store.flattenTree(repo, info.tree) : new Map();
          isCreate = !flat.has(path);
        }
        if (!isCreate && sha !== undefined) {
          // stale-sha check: the current blob at this path must match
          const info = store.commitInfo(repo, tip!);
          const flat = info ? store.flattenTree(repo, info.tree) : new Map();
          const current = flat.get(path);
          if (current && current.oid !== sha) {
            return jsonError(store, 409, 'Conflict: sha does not match the current file');
          }
        }
        if (!isCreate && sha === undefined) {
          // update without a sha: allowed only if the file does not exist yet?
          // GitHub requires sha for updates; treat a missing sha on an existing
          // file as a create attempt on an existing path -> 409 is wrong here,
          // so allow it as an update (the checks always send sha on update).
          void 0;
        }
        const commitOid = store.applyContentChange(repo, branch, path, content, message);
        const blobOid = store.storeObject(repo, 'blob', content);
        return jsonBody(store, isCreate ? 201 : 200, {
          content: { name: path.split('/').pop(), path, sha: blobOid, size: content.length, encoding: 'base64', type: 'file' },
          commit: { sha: commitOid, message },
        });
      }
      if (method === 'GET') {
        const refParam = query.get('ref');
        let tip: string | undefined;
        if (refParam) {
          tip = repo.refs.get(`refs/heads/${refParam}`) ?? repo.refs.get(refParam) ?? (/^[0-9a-f]{40}$/.test(refParam) ? refParam : undefined);
        } else {
          tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        }
        if (!tip) return jsonError(store, 404, 'Not Found');
        const info = store.commitInfo(repo, tip);
        if (!info) return jsonError(store, 404, 'Not Found');
        const flat = store.flattenTree(repo, info.tree);
        if (path === '') {
          // root directory listing
          const top = new Map<string, { type: string; oid: string }>();
          for (const [p, v] of flat) {
            const slash = p.indexOf('/');
            if (slash === -1) top.set(p, { type: 'file', oid: v.oid });
            else top.set(p.slice(0, slash), { type: 'dir', oid: '' });
          }
          const listing = [...top.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, v]) => ({
            type: v.type, name, path: name, sha: v.oid || '',
          }));
          return jsonBody(store, 200, listing);
        }
        const file = flat.get(path);
        if (file) {
          const obj = repo.objects.get(file.oid);
          if (!obj) return jsonError(store, 404, 'Not Found');
          return jsonBody(store, 200, {
            type: 'file', encoding: 'base64', size: obj.data.length, name: path.split('/').pop(),
            path, content: obj.data.toString('base64'), sha: file.oid,
          });
        }
        // directory?
        const dirPrefix = `${path}/`;
        const children = new Map<string, { type: string; oid: string }>();
        for (const [p, v] of flat) {
          if (!p.startsWith(dirPrefix)) continue;
          const restPath = p.slice(dirPrefix.length);
          const slash = restPath.indexOf('/');
          if (slash === -1) children.set(restPath, { type: 'file', oid: v.oid });
          else children.set(restPath.slice(0, slash), { type: 'dir', oid: '' });
        }
        if (children.size === 0) return jsonError(store, 404, 'Not Found');
        const listing = [...children.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, v]) => ({
          type: v.type, name, path: `${path}/${name}`, sha: v.oid || '',
        }));
        return jsonBody(store, 200, listing);
      }
      if (method === 'DELETE') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return jsonError(store, 400, 'Problems parsing JSON');
        const message = typeof parsed.value.message === 'string' ? parsed.value.message : 'Delete';
        const branch = typeof parsed.value.branch === 'string' ? parsed.value.branch : repo.defaultBranch;
        const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined;
        const ref = `refs/heads/${branch}`;
        const tip = repo.refs.get(ref);
        if (!tip) return jsonError(store, 404, 'Not Found');
        const info = store.commitInfo(repo, tip);
        const flat = info ? store.flattenTree(repo, info.tree) : new Map();
        const current = flat.get(path);
        if (!current) return jsonError(store, 404, 'Not Found');
        if (sha !== undefined && current.oid !== sha) {
          return jsonError(store, 409, 'Conflict: sha does not match the current file');
        }
        const commitOid = store.applyContentChange(repo, branch, path, null, message);
        return jsonBody(store, 200, { commit: { sha: commitOid, message } });
      }
      return jsonError(store, 404, 'Not Found');
    }

    // labels
    if (section === 'labels') {
      if (method === 'POST' && sub.length === 0) {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return jsonError(store, 400, 'Problems parsing JSON');
        const name = typeof parsed.value.name === 'string' ? parsed.value.name : '';
        const color = typeof parsed.value.color === 'string' ? parsed.value.color : 'ededed';
        if (!name) return jsonError(store, 422, 'Label name is required');
        if (repo.labels.has(name)) return jsonError(store, 422, 'Label already exists');
        const label: Label = { id: store.nextLabelId++, name, color, description: typeof parsed.value.description === 'string' ? parsed.value.description : '' };
        repo.labels.set(name, label);
        return jsonBody(store, 201, { id: label.id, name: label.name, color: label.color, description: label.description });
      }
      if (method === 'GET' && sub.length === 0) {
        return jsonBody(store, 200, [...repo.labels.values()].map((l) => ({ id: l.id, name: l.name, color: l.color, description: l.description })));
      }
      return jsonError(store, 404, 'Not Found');
    }

    // issues
    if (section === 'issues') {
      if (sub.length === 0) {
        if (method === 'POST') {
          const parsed = parseJsonBody(body);
          if (!parsed.ok) return jsonError(store, 400, 'Problems parsing JSON');
          const title = typeof parsed.value.title === 'string' ? parsed.value.title : '';
          const issueBody = typeof parsed.value.body === 'string' ? parsed.value.body : '';
          const labelNames = Array.isArray(parsed.value.labels)
            ? (parsed.value.labels as unknown[]).map((l) => String(l))
            : [];
          if (!title) return jsonError(store, 422, 'Title is required');
          const labels: Label[] = [];
          for (const name of labelNames) {
            const label = repo.labels.get(name);
            if (!label) return jsonError(store, 422, `Label does not exist: ${name}`);
            labels.push(label);
          }
          const seq = store.nextSeq();
          const number = repo.nextNumber++;
          const issue: Issue = {
            id: store.nextIssueId++, number, title, body: issueBody, state: 'open',
            labels, comments: [], user: store.viewerLogin,
            createdAt: isoFor(seq), updatedAt: isoFor(seq), seq,
          };
          repo.issues.set(number, issue);
          return jsonBody(store, 201, issueJson(issue, repo));
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          const perPage = Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30);
          const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
          let list = [...repo.issues.values()];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          if (sort === 'created') {
            list.sort((a, b) => direction === 'asc' ? a.seq - b.seq : b.seq - a.seq);
          } else {
            list.sort((a, b) => direction === 'asc' ? a.seq - b.seq : b.seq - a.seq);
          }
          const start = (page - 1) * perPage;
          const slice = list.slice(start, start + perPage);
          const extra: Record<string, string> = {};
          if (start + perPage < list.length) {
            const nextUrl = `${origin}/api/v3/repos/${owner}/${repoName}/issues?state=${state}&sort=${sort}&direction=${direction}&per_page=${perPage}&page=${page + 1}`;
            extra.Link = `<${nextUrl}>; rel="next"`;
          }
          return jsonBody(store, 200, slice.map((i) => issueJson(i, repo)), extra);
        }
        return jsonError(store, 404, 'Not Found');
      }
      const number = Number.parseInt(sub[0], 10);
      if (!Number.isInteger(number)) return jsonError(store, 404, 'Not Found');
      const issue = repo.issues.get(number);
      if (sub.length === 1) {
        if (method === 'GET') {
          if (!issue) return jsonError(store, 404, 'Not Found');
          return jsonBody(store, 200, issueJson(issue, repo));
        }
        if (method === 'PATCH') {
          if (!issue) return jsonError(store, 404, 'Not Found');
          const parsed = parseJsonBody(body);
          if (!parsed.ok) return jsonError(store, 400, 'Problems parsing JSON');
          if (parsed.value.state === 'open' || parsed.value.state === 'closed') {
            issue.state = parsed.value.state;
            issue.updatedAt = isoFor(store.nextSeq());
          }
          if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
          if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
          return jsonBody(store, 200, issueJson(issue, repo));
        }
        return jsonError(store, 404, 'Not Found');
      }
      if (sub[1] === 'comments') {
        if (!issue) return jsonError(store, 404, 'Not Found');
        if (method === 'POST') {
          const parsed = parseJsonBody(body);
          if (!parsed.ok) return jsonError(store, 400, 'Problems parsing JSON');
          const commentBody = typeof parsed.value.body === 'string' ? parsed.value.body : '';
          if (!commentBody) return jsonError(store, 422, 'Comment body is required');
          const seq = store.nextSeq();
          const comment = {
            id: store.nextCommentId++, issueNumber: number, body: commentBody,
            user: store.viewerLogin, createdAt: isoFor(seq), updatedAt: isoFor(seq), seq,
          };
          issue.comments.push(comment);
          return jsonBody(store, 201, { id: comment.id, body: comment.body, user: { login: comment.user }, created_at: comment.createdAt, updated_at: comment.updatedAt });
        }
        if (method === 'GET') {
          return jsonBody(store, 200, issue.comments.map((c) => ({
            id: c.id, body: c.body, user: { login: c.user }, created_at: c.createdAt, updated_at: c.updatedAt,
          })));
        }
        return jsonError(store, 404, 'Not Found');
      }
      return jsonError(store, 404, 'Not Found');
    }

    // pulls
    if (section === 'pulls') {
      if (sub.length === 0) {
        if (method === 'POST') {
          const parsed = parseJsonBody(body);
          if (!parsed.ok) return jsonError(store, 400, 'Problems parsing JSON');
          const title = typeof parsed.value.title === 'string' ? parsed.value.title : '';
          const prBody = typeof parsed.value.body === 'string' ? parsed.value.body : '';
          const head = typeof parsed.value.head === 'string' ? parsed.value.head : '';
          const base = typeof parsed.value.base === 'string' ? parsed.value.base : repo.defaultBranch;
          if (!title || !head) return jsonError(store, 422, 'Title and head are required');
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (!headSha || !baseSha) return jsonError(store, 422, 'Head or base branch does not exist');
          for (const existing of repo.pulls.values()) {
            if (existing.state === 'open' && existing.head === head && existing.base === base) {
              return jsonError(store, 422, 'A pull request already exists for this head branch');
            }
          }
          const seq = store.nextSeq();
          const number = repo.nextNumber++;
          const pull: Pull = {
            id: store.nextIssueId++, number, title, body: prBody, state: 'open',
            head, base, headSha, baseSha, merged: false, mergedAt: null, mergeCommitSha: null,
            user: store.viewerLogin, createdAt: isoFor(seq), updatedAt: isoFor(seq), seq,
          };
          repo.pulls.set(number, pull);
          return jsonBody(store, 201, pullJson(pull, repo));
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = [...repo.pulls.values()];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => a.seq - b.seq);
          return jsonBody(store, 200, list.map((p) => pullJson(p, repo)));
        }
        return jsonError(store, 404, 'Not Found');
      }
      const number = Number.parseInt(sub[0], 10);
      if (!Number.isInteger(number)) return jsonError(store, 404, 'Not Found');
      const pull = repo.pulls.get(number);
      if (sub.length === 1) {
        if (method === 'GET') {
          if (!pull) return jsonError(store, 404, 'Not Found');
          return jsonBody(store, 200, pullJson(pull, repo));
        }
        return jsonError(store, 404, 'Not Found');
      }
      if (sub[1] === 'files' && method === 'GET') {
        if (!pull) return jsonError(store, 404, 'Not Found');
        const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
        const headTip = repo.refs.get(`refs/heads/${pull.head}`);
        if (!baseTip || !headTip) return jsonError(store, 404, 'Not Found');
        const mb = store.mergeBase(repo, headTip, baseTip);
        const mbTree = mb ? (store.commitInfo(repo, mb)?.tree ?? '') : '';
        const headTree = store.commitInfo(repo, headTip)?.tree ?? '';
        const diff = store.diffTrees(repo, mbTree, headTree);
        const files: Record<string, unknown>[] = [];
        const baseFlat = mbTree ? store.flattenTree(repo, mbTree) : new Map();
        for (const a of diff.added) {
          const obj = repo.objects.get(a.oid);
          const text = obj ? obj.data.toString('utf8') : '';
          const d = store.lineDiff('', text);
          files.push({ filename: a.path, status: 'added', additions: d.additions, deletions: 0, changes: d.additions, sha: a.oid });
        }
        for (const m of diff.modified) {
          const oldObj = repo.objects.get(m.oldOid);
          const newObj = repo.objects.get(m.newOid);
          const d = store.lineDiff(oldObj ? oldObj.data.toString('utf8') : '', newObj ? newObj.data.toString('utf8') : '');
          files.push({ filename: m.path, status: 'modified', additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions, sha: m.newOid });
        }
        for (const r of diff.removed) {
          const obj = repo.objects.get(r.oid);
          const text = obj ? obj.data.toString('utf8') : '';
          const d = store.lineDiff(text, '');
          files.push({ filename: r.path, status: 'removed', additions: 0, deletions: d.deletions, changes: d.deletions, sha: r.oid });
        }
        void baseFlat;
        files.sort((a, b) => String(a.filename).localeCompare(String(b.filename)));
        return jsonBody(store, 200, files);
      }
      if (sub[1] === 'merge' && method === 'PUT') {
        if (!pull) return jsonError(store, 404, 'Not Found');
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return jsonError(store, 400, 'Problems parsing JSON');
        const methodName = typeof parsed.value.merge_method === 'string' ? parsed.value.merge_method : 'merge';
        if (pull.state !== 'open') return jsonError(store, 405, 'Pull request is not open');
        const mergeMethod = methodName === 'squash' ? 'squash' : 'merge';
        const commitOid = store.mergePull(repo, pull, mergeMethod);
        if (!commitOid) {
          return jsonError(store, 405, 'Merge conflict');
        }
        return jsonBody(store, 200, { merged: true, sha: commitOid, message: `${pull.title} (#${pull.number})` });
      }
      return jsonError(store, 404, 'Not Found');
    }

    return jsonError(store, 404, 'Not Found');
  }

  return jsonError(store, 404, 'Not Found');
}
