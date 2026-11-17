// MCP (Model Context Protocol) over Streamable HTTP at POST /mcp.
// Modern era (2026-07-28) preferred: server/discover with supportedVersions,
// no protocol-level session; legacy initialize handshake also answered.
// Every POST is answered by one JSON body. No Authorization header -> 401.
// Non-JSON body -> HTTP 400 with JSON-RPC -32700.
import { isoFor, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { jsonBody as restJsonBody } from './rest.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue in a repository by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_repos',
    description: 'List repositories owned by the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner }, private: repo.private, description: repo.description,
    default_branch: repo.defaultBranch, created_at: isoFor(repo.createdSeq),
  };
}

function issueJson(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id, number: issue.number, title: issue.title, body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
    created_at: issue.createdAt, updated_at: issue.updatedAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(pull: Pull, repo: Repo): Record<string, unknown> {
  return {
    id: pull.id, number: pull.number, title: pull.title, body: pull.body,
    state: pull.state, merged: pull.merged, merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: pull.headSha },
    base: { ref: pull.base, sha: pull.baseSha },
    created_at: pull.createdAt, updated_at: pull.updatedAt,
  };
}

type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent: unknown; isError?: boolean };

function okResult(obj: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj };
}

function errResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolResult {
  const owner = typeof args.owner === 'string' ? args.owner : store.viewerLogin;
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  const getRepo = (): Repo | undefined =>
    owner === store.viewerLogin ? store.getRepo(owner, repoName) : undefined;

  switch (name) {
    case 'create_repo': {
      const repoNameArg = typeof args.name === 'string' ? args.name : '';
      if (!repoNameArg) return errResult('Missing required argument: name');
      if (store.getRepo(store.viewerLogin, repoNameArg)) return errResult(`Repository ${repoNameArg} already exists`);
      const repo = store.createRepo(
        store.viewerLogin, repoNameArg,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      return okResult(repoJson(store, repo));
    }
    case 'get_repo': {
      const repo = getRepo();
      if (!repo) return errResult(`Repository ${owner}/${repoName} not found`);
      return okResult(repoJson(store, repo));
    }
    case 'list_repos': {
      const list = [...store.repos.values()]
        .filter((r) => r.owner === store.viewerLogin)
        .map((r) => repoJson(store, r));
      return okResult({ repositories: list });
    }
    case 'create_issue': {
      const repo = getRepo();
      if (!repo) return errResult(`Repository ${owner}/${repoName} not found`);
      const title = typeof args.title === 'string' ? args.title : '';
      if (!title) return errResult('Missing required argument: title');
      const seq = store.nextSeq();
      const number = repo.nextNumber++;
      const issue: Issue = {
        id: store.nextIssueId++, number, title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open', labels: [], comments: [], user: store.viewerLogin,
        createdAt: isoFor(seq), updatedAt: isoFor(seq), seq,
      };
      repo.issues.set(number, issue);
      return okResult(issueJson(issue, repo));
    }
    case 'list_issues': {
      const repo = getRepo();
      if (!repo) return errResult(`Repository ${owner}/${repoName} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => a.seq - b.seq);
      return okResult({ issues: list.map((i) => issueJson(i, repo)) });
    }
    case 'get_issue': {
      const repo = getRepo();
      if (!repo) return errResult(`Repository ${owner}/${repoName} not found`);
      const number = Number(args.issue_number);
      const issue = repo.issues.get(number);
      if (!issue) return errResult(`Issue #${number} not found`);
      return okResult(issueJson(issue, repo));
    }
    case 'create_pull_request': {
      const repo = getRepo();
      if (!repo) return errResult(`Repository ${owner}/${repoName} not found`);
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : repo.defaultBranch;
      if (!title || !head) return errResult('Missing required arguments: title, head');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return errResult('Head or base branch does not exist');
      const existing = [...repo.pulls.values()].find((p) => p.state === 'open' && p.head === head && p.base === base);
      if (existing) return errResult('A pull request already exists for this head branch');
      const seq = store.nextSeq();
      const number = repo.nextNumber++;
      const pull: Pull = {
        id: store.nextIssueId++, number, title, body: '',
        state: 'open', head, base, headSha, baseSha, merged: false, mergedAt: null,
        mergeCommitSha: null, user: store.viewerLogin,
        createdAt: isoFor(seq), updatedAt: isoFor(seq), seq,
      };
      repo.pulls.set(number, pull);
      return okResult(pullJson(pull, repo));
    }
    case 'merge_pull_request': {
      const repo = getRepo();
      if (!repo) return errResult(`Repository ${owner}/${repoName} not found`);
      const number = Number(args.pull_number);
      const pull = repo.pulls.get(number);
      if (!pull) return errResult(`Pull request #${number} not found`);
      if (pull.state !== 'open') return errResult('Pull request is not open');
      const commitOid = store.mergePull(repo, pull, 'merge');
      if (!commitOid) return errResult('Merge conflict');
      return okResult({ merged: true, sha: commitOid, number: pull.number, state: pull.state, merge_commit_sha: commitOid });
    }
    default:
      return errResult(`Unknown tool: ${name}`);
  }
}

function rpcResult(id: unknown, result: unknown, protocolVersion?: string): Record<string, unknown> {
  const res: Record<string, unknown> = { jsonrpc: '2.0', id, result };
  if (protocolVersion) {
    res._meta = { 'io.modelcontextprotocol/protocolVersion': protocolVersion, protocolVersion };
  }
  return res;
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function declaredVersion(req: Record<string, unknown>): string {
  const params = (req.params ?? {}) as Record<string, unknown>;
  const meta = (params._meta ?? {}) as Record<string, unknown>;
  const v = meta['io.modelcontextprotocol/protocolVersion'] ?? meta.protocolVersion ?? params.protocolVersion;
  return typeof v === 'string' && SUPPORTED_VERSIONS.includes(v) ? v : SUPPORTED_VERSIONS[0];
}

export function handleMcp(
  store: Store,
  expectedToken: string | null,
  method: string,
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
): { status: number; headers: Record<string, string>; body: Buffer } {
  const jsonHeaders = { 'Content-Type': 'application/json' };
  if (method === 'DELETE') {
    return { status: 200, headers: jsonHeaders, body: Buffer.alloc(0) };
  }
  if (method !== 'POST') {
    return { status: 405, headers: jsonHeaders, body: Buffer.from(JSON.stringify({ message: 'Method Not Allowed' })) };
  }
  // Auth: a tools/call (or any POST) with no Authorization header -> 401.
  const raw = headers['authorization'];
  const auth = Array.isArray(raw) ? raw[0] : raw;
  if (!auth || !auth.startsWith('Bearer ') || auth.slice('Bearer '.length) === '') {
    return { status: 401, headers: jsonHeaders, body: Buffer.from(JSON.stringify(rpcError(null, -32000, 'Unauthorized'))) };
  }
  if (expectedToken !== null && auth.slice('Bearer '.length) !== expectedToken) {
    return { status: 401, headers: jsonHeaders, body: Buffer.from(JSON.stringify(rpcError(null, -32000, 'Unauthorized'))) };
  }

  let req: Record<string, unknown>;
  try {
    req = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
  } catch {
    return { status: 400, headers: jsonHeaders, body: Buffer.from(JSON.stringify(rpcError(null, -32700, 'Parse error'))) };
  }
  if (req === null || typeof req !== 'object' || Array.isArray(req) || typeof req.method !== 'string') {
    return { status: 400, headers: jsonHeaders, body: Buffer.from(JSON.stringify(rpcError(null, -32700, 'Parse error'))) };
  }
  const id = req.id ?? null;
  const isNotification = req.id === undefined;
  const version = declaredVersion(req);
  const params = (req.params ?? {}) as Record<string, unknown>;

  // Notifications get an empty 202.
  if (isNotification) {
    return { status: 202, headers: jsonHeaders, body: Buffer.alloc(0) };
  }

  switch (req.method) {
    case 'server/discover': {
      const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
      const result = {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      };
      return { status: 200, headers: jsonHeaders, body: Buffer.from(JSON.stringify(rpcResult(id, result, version))) };
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : version;
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
      const result = {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      };
      return { status: 200, headers: jsonHeaders, body: Buffer.from(JSON.stringify(rpcResult(id, result, negotiated))) };
    }
    case 'ping': {
      return { status: 200, headers: jsonHeaders, body: Buffer.from(JSON.stringify(rpcResult(id, {}, version))) };
    }
    case 'tools/list': {
      // The same array every time (byte-for-byte idempotent).
      return { status: 200, headers: jsonHeaders, body: Buffer.from(JSON.stringify(rpcResult(id, { tools: TOOLS }, version))) };
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
      const tool = TOOLS.find((t) => t.name === toolName);
      if (!tool) {
        return { status: 200, headers: jsonHeaders, body: Buffer.from(JSON.stringify(rpcError(id, -32602, `Unknown tool: ${toolName}`))) };
      }
      // Missing required arguments -> isError:true (or -32602).
      for (const required of tool.inputSchema.required) {
        if (toolArgs[required] === undefined || toolArgs[required] === null || toolArgs[required] === '') {
          const result = errResult(`Missing required argument: ${required}`);
          return { status: 200, headers: jsonHeaders, body: Buffer.from(JSON.stringify(rpcResult(id, result, version))) };
        }
      }
      const result = callTool(store, toolName, toolArgs);
      return { status: 200, headers: jsonHeaders, body: Buffer.from(JSON.stringify(rpcResult(id, result, version))) };
    }
    default: {
      return { status: 200, headers: jsonHeaders, body: Buffer.from(JSON.stringify(rpcError(id, -32601, `Method not found: ${req.method}`))) };
    }
  }
}

export { restJsonBody };
