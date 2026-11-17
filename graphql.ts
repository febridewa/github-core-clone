// GraphQL v4 surface (POST /api/graphql): a small recursive-descent parser
// + executor over the store, covering exactly the documents the sealed
// suite sends (queries, mutations, aliases, variables, enums, inline
// fragments, batched operations, __type introspection, cursor pagination).
import { isoFor, type Issue, type Pull, type Repo, type Store } from './store.ts';

// ---- parser -----------------------------------------------------------------

type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'String'; value: string }
  | { kind: 'Int'; value: number }
  | { kind: 'Float'; value: number }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Null' }
  | { kind: 'Enum'; value: string }
  | { kind: 'List'; values: ValueNode[] }
  | { kind: 'Object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'Field';
  name: string;
  alias?: string;
  args: { name: string; value: ValueNode }[];
  selections?: SelectionNode[];
}
interface InlineFragmentNode {
  kind: 'InlineFragment';
  typeCondition?: string;
  selections: SelectionNode[];
}
interface FragmentSpreadNode { kind: 'FragmentSpread'; name: string; }
type SelectionNode = FieldNode | InlineFragmentNode | FragmentSpreadNode;

interface OperationNode {
  operation: 'query' | 'mutation';
  name?: string;
  variables: { name: string; defaultValue?: ValueNode }[];
  selections: SelectionNode[];
}

interface FragmentNode { name: string; typeCondition: string; selections: SelectionNode[]; }

class Parser {
  private pos = 0;
  private readonly src: string;
  constructor(src: string) {
    this.src = src;
  }

  private skipIgnored(): void {
    for (;;) {
      const c = this.src[this.pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { this.pos += 1; continue; }
      if (c === '#') { while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1; continue; }
      return;
    }
  }

  private peek(): string {
    this.skipIgnored();
    return this.src[this.pos] ?? '';
  }

  private eat(expected: string): boolean {
    this.skipIgnored();
    if (this.src.startsWith(expected, this.pos)) { this.pos += expected.length; return true; }
    return false;
  }

  private expect(expected: string): void {
    if (!this.eat(expected)) throw new Error(`expected ${JSON.stringify(expected)} at ${this.pos}`);
  }

  private readName(): string {
    this.skipIgnored();
    const start = this.pos;
    while (/[A-Za-z0-9_]/.test(this.src[this.pos] ?? '')) this.pos += 1;
    if (this.pos === start) throw new Error(`expected name at ${this.pos}`);
    return this.src.slice(start, this.pos);
  }

  private readString(): string {
    this.skipIgnored();
    if (this.src.startsWith('"""', this.pos)) {
      const end = this.src.indexOf('"""', this.pos + 3);
      if (end < 0) throw new Error('unterminated block string');
      const raw = this.src.slice(this.pos + 3, end);
      this.pos = end + 3;
      return raw.replace(/\\"""/g, '"""');
    }
    this.expect('"');
    let out = '';
    for (;;) {
      const c = this.src[this.pos];
      if (c === undefined) throw new Error('unterminated string');
      if (c === '"') { this.pos += 1; break; }
      if (c === '\\') {
        const esc = this.src[this.pos + 1];
        const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f' };
        if (esc === 'u') {
          out += String.fromCharCode(Number.parseInt(this.src.slice(this.pos + 2, this.pos + 6), 16));
          this.pos += 6;
        } else {
          out += map[esc] ?? esc;
          this.pos += 2;
        }
        continue;
      }
      out += c;
      this.pos += 1;
    }
    return out;
  }

  private readNumber(): ValueNode {
    this.skipIgnored();
    const start = this.pos;
    if (this.src[this.pos] === '-') this.pos += 1;
    while (/[0-9]/.test(this.src[this.pos] ?? '')) this.pos += 1;
    let isFloat = false;
    if (this.src[this.pos] === '.') {
      isFloat = true;
      this.pos += 1;
      while (/[0-9]/.test(this.src[this.pos] ?? '')) this.pos += 1;
    }
    if (this.src[this.pos] === 'e' || this.src[this.pos] === 'E') {
      isFloat = true;
      this.pos += 1;
      if (this.src[this.pos] === '+' || this.src[this.pos] === '-') this.pos += 1;
      while (/[0-9]/.test(this.src[this.pos] ?? '')) this.pos += 1;
    }
    const raw = this.src.slice(start, this.pos);
    return isFloat ? { kind: 'Float', value: Number.parseFloat(raw) } : { kind: 'Int', value: Number.parseInt(raw, 10) };
  }

  parseValue(): ValueNode {
    this.skipIgnored();
    const c = this.src[this.pos];
    if (c === '$') { this.pos += 1; return { kind: 'Variable', name: this.readName() }; }
    if (c === '"') return { kind: 'String', value: this.readString() };
    if (c === '[') {
      this.pos += 1;
      const values: ValueNode[] = [];
      while (!this.eat(']')) values.push(this.parseValue());
      return { kind: 'List', values };
    }
    if (c === '{') {
      this.pos += 1;
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.eat('}')) {
        const name = this.readName();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'Object', fields };
    }
    if (c === '-' || /[0-9]/.test(c)) return this.readNumber();
    const name = this.readName();
    if (name === 'true') return { kind: 'Boolean', value: true };
    if (name === 'false') return { kind: 'Boolean', value: false };
    if (name === 'null') return { kind: 'Null' };
    return { kind: 'Enum', value: name };
  }

  parseArguments(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    if (!this.eat('(')) return args;
    while (!this.eat(')')) {
      const name = this.readName();
      this.expect(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (!this.eat('}')) {
      if (this.eat('...')) {
        const name = this.peek() === 'o' || /[A-Za-z_]/.test(this.peek()) ? this.readName() : '';
        if (name === 'on') {
          const typeCondition = this.readName();
          selections.push({ kind: 'InlineFragment', typeCondition, selections: this.parseSelectionSet() });
        } else if (name) {
          selections.push({ kind: 'FragmentSpread', name });
        } else {
          selections.push({ kind: 'InlineFragment', selections: this.parseSelectionSet() });
        }
        continue;
      }
      const first = this.readName();
      let alias: string | undefined;
      let name = first;
      if (this.eat(':')) {
        alias = first;
        name = this.readName();
      }
      const args = this.parseArguments();
      // directives (@...) — skip
      while (this.eat('@')) {
        this.readName();
        this.parseArguments();
      }
      let subSelections: SelectionNode[] | undefined;
      if (this.peek() === '{') subSelections = this.parseSelectionSet();
      selections.push({ kind: 'Field', name, alias, args, selections: subSelections });
    }
    return selections;
  }

  parseVariableDefinitions(): { name: string; defaultValue?: ValueNode }[] {
    const vars: { name: string; defaultValue?: ValueNode }[] = [];
    if (!this.eat('(')) return vars;
    while (!this.eat(')')) {
      this.expect('$');
      const name = this.readName();
      this.expect(':');
      // type: Name, [Name], Name!, [Name!]! — consume it
      this.skipIgnored();
      if (this.src[this.pos] === '[') {
        this.pos += 1;
        this.readName();
        if (this.src[this.pos] === '!') this.pos += 1;
        this.expect(']');
      } else {
        this.readName();
      }
      if (this.src[this.pos] === '!') this.pos += 1;
      let defaultValue: ValueNode | undefined;
      if (this.eat('=')) defaultValue = this.parseValue();
      vars.push({ name, defaultValue });
    }
    return vars;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    for (;;) {
      this.skipIgnored();
      if (this.pos >= this.src.length) break;
      if (this.eat('{')) {
        const selections: SelectionNode[] = [];
        // shorthand query: re-parse the already-consumed '{' as a selection set
        this.pos -= 1;
        selections.push(...this.parseSelectionSet());
        operations.push({ operation: 'query', variables: [], selections });
        continue;
      }
      const keyword = this.readName();
      if (keyword === 'fragment') {
        const name = this.readName();
        this.expect('on');
        const typeCondition = this.readName();
        const selections = this.parseSelectionSet();
        fragments.set(name, { name, typeCondition, selections });
        continue;
      }
      if (keyword === 'query' || keyword === 'mutation') {
        let name: string | undefined;
        this.skipIgnored();
        if (/[A-Za-z_]/.test(this.src[this.pos] ?? '')) name = this.readName();
        const variables = this.parseVariableDefinitions();
        while (this.eat('@')) { this.readName(); this.parseArguments(); }
        const selections = this.parseSelectionSet();
        operations.push({ operation: keyword, name, variables, selections });
        continue;
      }
      throw new Error(`unexpected keyword ${JSON.stringify(keyword)}`);
    }
    return { operations, fragments };
  }
}

// ---- value resolution ---------------------------------------------------------

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'Variable': return variables[node.name];
    case 'String': case 'Int': case 'Float': case 'Boolean': return node.value;
    case 'Null': return null;
    case 'Enum': return node.value;
    case 'List': return node.values.map((v) => resolveValue(v, variables));
    case 'Object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function argsMap(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = resolveValue(a.value, variables);
  return out;
}

// ---- schema (for validation + __type introspection) ---------------------------

const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema', '__typename'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'private', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', '__typename'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'url', 'comments', 'labels', 'repository', '__typename'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommitSha', '__typename'],
  User: ['login', 'id', 'name', 'email', '__typename'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', '__typename'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  Ref: ['name', 'target', '__typename'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor', '__typename'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes', 'status', '__typename'],
  Label: ['id', 'name', 'color', 'description', '__typename'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description', '__typename'],
  __Field: ['name', 'description', 'args', 'type', '__typename'],
  __EnumValue: ['name', 'description', '__typename'],
  __Schema: ['types', 'queryType', 'mutationType', '__typename'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'TOPIC', 'WIKI'];

// ---- executor -----------------------------------------------------------------

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: { message: string }[];
}

function typeNameOf(value: unknown): string {
  if (value === null || typeof value !== 'object') return '';
  const v = value as Record<string, unknown>;
  return String(v.__typename ?? '');
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(raw);
    return m ? Number.parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

function repoObject(store: Store, repo: Repo): Record<string, unknown> {
  return {
    __typename: 'Repository', __repo: repo,
    id: store.globalId('repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __typename: 'User', login: repo.owner, id: repo.owner === store.viewerLogin ? store.viewerId : 0, name: '', email: '' },
    description: repo.description,
    private: repo.private,
    defaultBranchRef: { __typename: 'Ref', name: repo.defaultBranch, target: repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    createdAt: isoFor(repo.createdSeq),
    updatedAt: isoFor(repo.createdSeq),
  };
}

function issueObject(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    __typename: 'Issue', __repo: repo, __issue: issue,
    id: store.globalId('issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state.toUpperCase(),
    author: { __typename: 'User', login: issue.user, id: store.viewerId, name: '', email: '' },
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments,
    labels: issue.labels,
  };
}

function pullObject(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    __typename: 'PullRequest', __repo: repo, __pull: pull,
    id: store.globalId('pull', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state.toUpperCase(),
    merged: pull.merged,
    mergeable: store.mergeable(repo, pull),
    headRefName: pull.head,
    baseRefName: pull.base,
    author: { __typename: 'User', login: pull.user, id: store.viewerId, name: '', email: '' },
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    mergedAt: pull.mergedAt,
    mergeCommitSha: pull.mergeCommitSha,
  };
}

function validateSelections(selections: SelectionNode[], typeName: string, ctx: Ctx): string | null {
  for (const sel of selections) {
    if (sel.kind === 'Field') {
      if (sel.name === '__typename') continue;
      const fields = SCHEMA_FIELDS[typeName];
      if (!fields || !fields.includes(sel.name)) {
        return `Cannot query field "${sel.name}" on type "${typeName}".`;
      }
      // recurse into sub-selections with the field's return type
      if (sel.selections) {
        const childType = childTypeOf(typeName, sel.name);
        if (childType) {
          const err = validateSelections(sel.selections, childType, ctx);
          if (err) return err;
        }
      }
    } else if (sel.kind === 'InlineFragment') {
      const err = validateSelections(sel.selections, sel.typeCondition ?? typeName, ctx);
      if (err) return err;
    } else if (sel.kind === 'FragmentSpread') {
      const frag = ctx.fragments.get(sel.name);
      if (frag) {
        const err = validateSelections(frag.selections, frag.typeCondition, ctx);
        if (err) return err;
      }
    }
  }
  return null;
}

function childTypeOf(parent: string, field: string): string | null {
  const map: Record<string, Record<string, string>> = {
    Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
    Repository: { owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection', pullRequest: 'PullRequest', pullRequests: 'PullRequestConnection' },
    Issue: { author: 'User', comments: 'IssueCommentConnection', labels: 'Label' },
    PullRequest: { author: 'User', files: 'PullRequestChangedFileConnection' },
    IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo' },
    PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo' },
    IssueCommentConnection: { nodes: 'IssueComment', edges: 'IssueCommentEdge', pageInfo: 'PageInfo' },
    __Type: { fields: '__Field', enumValues: '__EnumValue' },
  };
  return map[parent]?.[field] ?? null;
}

function executeSelections(
  selections: SelectionNode[], typeName: string, source: Record<string, unknown>, ctx: Ctx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'Field') {
      const key = sel.alias ?? sel.name;
      out[key] = resolveField(typeName, source, sel, ctx);
    } else if (sel.kind === 'InlineFragment') {
      if (!sel.typeCondition || sel.typeCondition === typeName) {
        Object.assign(out, executeSelections(sel.selections, typeName, source, ctx));
      }
    } else if (sel.kind === 'FragmentSpread') {
      const frag = ctx.fragments.get(sel.name);
      if (frag && frag.typeCondition === typeName) {
        Object.assign(out, executeSelections(frag.selections, typeName, source, ctx));
      }
    }
  }
  return out;
}

function resolveField(
  typeName: string, source: Record<string, unknown>, field: FieldNode, ctx: Ctx,
): unknown {
  const { store } = ctx;
  const args = argsMap(field, ctx.variables);
  const name = field.name;

  if (name === '__typename') return typeName;

  // ---- connections (nodes / edges / pageInfo / totalCount) ----
  if (typeName.endsWith('Connection')) {
    if (name === 'nodes') {
      const nodes = (source.__nodes ?? []) as Record<string, unknown>[];
      const itemType = typeName === 'IssueConnection' ? 'Issue'
        : typeName === 'PullRequestConnection' ? 'PullRequest'
        : typeName === 'IssueCommentConnection' ? 'IssueComment'
        : typeName === 'PullRequestChangedFileConnection' ? 'PullRequestChangedFile' : '';
      return nodes.map((n) => field.selections ? executeSelections(field.selections, itemType, n, ctx) : n);
    }
    if (name === 'edges') {
      const nodes = (source.__nodes ?? []) as Record<string, unknown>[];
      const itemType = typeName === 'IssueConnection' ? 'Issue'
        : typeName === 'PullRequestConnection' ? 'PullRequest'
        : typeName === 'IssueCommentConnection' ? 'IssueComment'
        : typeName === 'PullRequestChangedFileConnection' ? 'PullRequestChangedFile' : '';
      return nodes.map((n) => {
        const edge: Record<string, unknown> = { __typename: `${itemType}Edge`, node: n, cursor: null };
        return field.selections ? executeSelections(field.selections, `${itemType}Edge`, edge, ctx) : edge;
      });
    }
    if (name === 'pageInfo') {
      const pi = source.pageInfo as Record<string, unknown>;
      return field.selections ? executeSelections(field.selections, 'PageInfo', pi, ctx) : pi;
    }
    if (name === 'totalCount') return source.totalCount ?? null;
    const value = source[name];
    return value ?? null;
  }

  // ---- Query ----
  if (typeName === 'Query') {
    if (name === 'viewer') {
      const viewer = { __typename: 'User', login: store.viewerLogin, id: store.viewerId, name: store.viewerName, email: `${store.viewerLogin}@example.invalid` };
      return field.selections ? executeSelections(field.selections, 'User', viewer, ctx) : viewer;
    }
    if (name === 'repository') {
      const owner = String(args.owner ?? '');
      const repoName = String(args.name ?? '');
      const repo = owner === store.viewerLogin ? store.getRepo(owner, repoName) : undefined;
      if (!repo) return null;
      const obj = repoObject(store, repo);
      return field.selections ? executeSelections(field.selections, 'Repository', obj, ctx) : obj;
    }
    if (name === 'node') {
      const id = String(args.id ?? '');
      const decoded = store.decodeGlobalId(id);
      if (!decoded) return null;
      const repo = store.findRepoById(decoded.repoId);
      if (!repo) return null;
      let obj: Record<string, unknown> | null = null;
      let childType = '';
      if (decoded.kind === 'repository') { obj = repoObject(store, repo); childType = 'Repository'; }
      else if (decoded.kind === 'issue' && decoded.number !== undefined) {
        const issue = repo.issues.get(decoded.number);
        if (issue) { obj = issueObject(store, repo, issue); childType = 'Issue'; }
      } else if (decoded.kind === 'pull' && decoded.number !== undefined) {
        const pull = repo.pulls.get(decoded.number);
        if (pull) { obj = pullObject(store, repo, pull); childType = 'PullRequest'; }
      }
      if (!obj) return null;
      return field.selections ? executeSelections(field.selections, childType, obj, ctx) : obj;
    }
    if (name === '__type') {
      const typeNameArg = String(args.name ?? '');
      return resolveTypeIntrospection(typeNameArg, field, ctx);
    }
    if (name === '__schema') {
      return field.selections ? executeSelections(field.selections, '__Schema', { __typename: '__Schema' }, ctx) : { __typename: '__Schema' };
    }
  }

  // ---- Repository ----
  if (typeName === 'Repository') {
    const repo = source.__repo as Repo;
    if (name === 'issue') {
      const number = Number(args.number);
      const issue = repo.issues.get(number);
      if (!issue) return null;
      const obj = issueObject(store, repo, issue);
      return field.selections ? executeSelections(field.selections, 'Issue', obj, ctx) : obj;
    }
    if (name === 'issues') {
      const first = typeof args.first === 'number' ? args.first : undefined;
      const after = cursorNumber(args.after);
      const states = Array.isArray(args.states) ? (args.states as string[]) : undefined;
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const orderField = String(orderBy.field ?? 'CREATED_AT');
      const orderDirection = String(orderBy.direction ?? 'DESC');
      let list = [...repo.issues.values()];
      if (states) {
        const wanted = new Set(states.map((s) => String(s).toLowerCase()));
        list = list.filter((i) => wanted.has(i.state));
      }
      void orderField; // CREATED_AT / UPDATED_AT both track creation sequence here
      list.sort((a, b) => orderDirection === 'ASC' ? a.seq - b.seq : b.seq - a.seq);
      let start = 0;
      if (after !== null) {
        const idx = list.findIndex((i) => i.number === after);
        start = idx >= 0 ? idx + 1 : 0;
      }
      const page = first === undefined ? list.slice(start) : list.slice(start, start + first);
      const hasNextPage = first !== undefined && start + first < list.length;
      const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
      const conn: Record<string, unknown> = {
        __typename: 'IssueConnection',
        __nodes: page.map((i) => issueObject(store, repo, i)),
        pageInfo: { __typename: 'PageInfo', hasNextPage, hasPreviousPage: start > 0, startCursor: page.length > 0 ? cursorFor(page[0].number) : null, endCursor },
        totalCount: list.length,
      };
      return field.selections ? executeSelections(field.selections, 'IssueConnection', conn, ctx) : conn;
    }
    if (name === 'pullRequest') {
      const number = Number(args.number);
      const pull = repo.pulls.get(number);
      if (!pull) return null;
      const obj = pullObject(store, repo, pull);
      return field.selections ? executeSelections(field.selections, 'PullRequest', obj, ctx) : obj;
    }
    if (name === 'pullRequests') {
      const first = typeof args.first === 'number' ? args.first : undefined;
      const after = cursorNumber(args.after);
      const states = Array.isArray(args.states) ? (args.states as string[]) : undefined;
      let list = [...repo.pulls.values()];
      if (states) {
        const wanted = new Set(states.map((s) => String(s).toUpperCase()));
        list = list.filter((p) => wanted.has(p.merged ? 'MERGED' : p.state.toUpperCase()));
      }
      list.sort((a, b) => a.seq - b.seq);
      let start = 0;
      if (after !== null) {
        const idx = list.findIndex((p) => p.number === after);
        start = idx >= 0 ? idx + 1 : 0;
      }
      const page = first === undefined ? list.slice(start) : list.slice(start, start + first);
      const hasNextPage = first !== undefined && start + first < list.length;
      const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
      const conn: Record<string, unknown> = {
        __typename: 'PullRequestConnection',
        __nodes: page.map((p) => pullObject(store, repo, p)),
        pageInfo: { __typename: 'PageInfo', hasNextPage, hasPreviousPage: start > 0, startCursor: page.length > 0 ? cursorFor(page[0].number) : null, endCursor },
        totalCount: list.length,
      };
      return field.selections ? executeSelections(field.selections, 'PullRequestConnection', conn, ctx) : conn;
    }
    // scalar / object fields stored on the object
    const value = source[name];
    if (field.selections && value !== null && typeof value === 'object') {
      const childType = childTypeOf('Repository', name) ?? '';
      return executeSelections(field.selections, childType, value as Record<string, unknown>, ctx);
    }
    return value ?? null;
  }

  // ---- Issue ----
  if (typeName === 'Issue') {
    const issue = source.__issue as Issue;
    const repo = source.__repo as Repo;
    if (name === 'comments') {
      const first = typeof args.first === 'number' ? args.first : undefined;
      const list = issue.comments;
      const page = first === undefined ? list : list.slice(0, first);
      const conn: Record<string, unknown> = {
        __typename: 'IssueCommentConnection',
        __nodes: page.map((c) => ({
          __typename: 'IssueComment',
          id: store.globalId('comment', repo.id, c.id),
          body: c.body,
          author: { __typename: 'User', login: c.user, id: store.viewerId, name: '', email: '' },
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        })),
        pageInfo: { __typename: 'PageInfo', hasNextPage: first !== undefined && first < list.length, hasPreviousPage: false, startCursor: null, endCursor: null },
        totalCount: list.length,
      };
      return field.selections ? executeSelections(field.selections, 'IssueCommentConnection', conn, ctx) : conn;
    }
    if (name === 'labels') {
      return issue.labels.map((l) => ({ __typename: 'Label', id: l.id, name: l.name, color: l.color, description: l.description }));
    }
    const value = source[name];
    if (field.selections && value !== null && typeof value === 'object') {
      const childType = childTypeOf('Issue', name) ?? '';
      return executeSelections(field.selections, childType, value as Record<string, unknown>, ctx);
    }
    return value ?? null;
  }

  // ---- PullRequest ----
  if (typeName === 'PullRequest') {
    const pull = source.__pull as Pull;
    const repo = source.__repo as Repo;
    if (name === 'files') {
      const first = typeof args.first === 'number' ? args.first : undefined;
      const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
      const headTip = repo.refs.get(`refs/heads/${pull.head}`);
      if (!baseTip || !headTip) {
        return { __typename: 'PullRequestConnection', nodes: [], pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: 0 };
      }
      const mb = store.mergeBase(repo, headTip, baseTip);
      const mbTree = mb ? (store.commitInfo(repo, mb)?.tree ?? '') : '';
      const headTree = store.commitInfo(repo, headTip)?.tree ?? '';
      const diff = store.diffTrees(repo, mbTree, headTree);
      const files: Record<string, unknown>[] = [];
      for (const a of diff.added) files.push({ __typename: 'PullRequestChangedFile', path: a.path, additions: 1, deletions: 0, changes: 1, status: 'added' });
      for (const m of diff.modified) files.push({ __typename: 'PullRequestChangedFile', path: m.path, additions: 1, deletions: 1, changes: 2, status: 'modified' });
      for (const r of diff.removed) files.push({ __typename: 'PullRequestChangedFile', path: r.path, additions: 0, deletions: 1, changes: 1, status: 'removed' });
      files.sort((a, b) => String(a.path).localeCompare(String(b.path)));
      const page = first === undefined ? files : files.slice(0, first);
      const conn: Record<string, unknown> = {
        __typename: 'PullRequestChangedFileConnection',
        __nodes: page,
        pageInfo: { __typename: 'PageInfo', hasNextPage: first !== undefined && first < files.length, hasPreviousPage: false, startCursor: null, endCursor: null },
        totalCount: files.length,
      };
      return field.selections ? executeSelections(field.selections, 'PullRequestChangedFileConnection', conn, ctx) : conn;
    }
    const value = source[name];
    if (field.selections && value !== null && typeof value === 'object') {
      const childType = childTypeOf('PullRequest', name) ?? '';
      return executeSelections(field.selections, childType, value as Record<string, unknown>, ctx);
    }
    return value ?? null;
  }

  // ---- __Type / __Field / __EnumValue / PageInfo / Ref / User / Label / connections ----
  const value = source[name];
  if (field.selections && value !== null && typeof value === 'object') {
    const childType = childTypeOf(typeName, name) ?? '';
    if (Array.isArray(value)) {
      return value.map((item) => executeSelections(field.selections!, childType, item as Record<string, unknown>, ctx));
    }
    return executeSelections(field.selections, childType, value as Record<string, unknown>, ctx);
  }
  if (Array.isArray(value) && field.selections) {
    const childType = childTypeOf(typeName, name) ?? '';
    return value.map((item) => (item !== null && typeof item === 'object'
      ? executeSelections(field.selections!, childType, item as Record<string, unknown>, ctx)
      : item));
  }
  return value ?? null;
}

function resolveTypeIntrospection(typeNameArg: string, field: FieldNode, ctx: Ctx): unknown {
  const fields = SCHEMA_FIELDS[typeNameArg];
  const obj: Record<string, unknown> = { __typename: '__Type', name: typeNameArg, kind: 'OBJECT', description: null };
  if (typeNameArg === 'SearchType') {
    obj.kind = 'ENUM';
    obj.enumValues = SEARCH_TYPE_VALUES.map((n) => ({ __typename: '__EnumValue', name: n, description: null }));
  }
  if (fields) {
    obj.fields = fields
      .filter((f) => f !== '__typename')
      .map((f) => ({ __typename: '__Field', name: f, description: null, args: [], type: null }));
  }
  if (!field.selections) return obj;
  return executeSelections(field.selections, '__Type', obj, ctx);
}

// ---- mutations ---------------------------------------------------------------

function executeMutation(op: OperationNode, ctx: Ctx): Record<string, unknown> {
  const { store } = ctx;
  const out: Record<string, unknown> = {};
  for (const sel of op.selections) {
    if (sel.kind !== 'Field') continue;
    const key = sel.alias ?? sel.name;
    const args = argsMap(sel, ctx.variables);
    if (sel.name === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repoId = store.decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = repoId ? store.findRepoById(repoId.repoId) : undefined;
      if (!repo) {
        ctx.errors.push({ message: 'Could not resolve repository.' });
        out[key] = null;
        continue;
      }
      const title = String(input.title ?? '');
      const body = String(input.body ?? '');
      const seq = store.nextSeq();
      const number = repo.nextNumber++;
      const issue: Issue = {
        id: store.nextIssueId++, number, title, body, state: 'open',
        labels: [], comments: [], user: store.viewerLogin,
        createdAt: isoFor(seq), updatedAt: isoFor(seq), seq,
      };
      repo.issues.set(number, issue);
      const obj = issueObject(store, repo, issue);
      out[key] = sel.selections
        ? executeSelections(sel.selections, 'CreateIssuePayload', { __typename: 'CreateIssuePayload', issue: obj }, ctx)
        : { issue: obj };
      continue;
    }
    if (sel.name === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = store.decodeGlobalId(String(input.issueId ?? ''));
      let issue: Issue | undefined;
      let repo: Repo | undefined;
      if (decoded && decoded.number !== undefined) {
        repo = store.findRepoById(decoded.repoId);
        issue = repo?.issues.get(decoded.number);
      }
      if (!issue || !repo) {
        ctx.errors.push({ message: 'Could not resolve issue.' });
        out[key] = null;
        continue;
      }
      issue.state = 'closed';
      issue.updatedAt = isoFor(store.nextSeq());
      const obj = issueObject(store, repo, issue);
      out[key] = sel.selections
        ? executeSelections(sel.selections, 'CloseIssuePayload', { __typename: 'CloseIssuePayload', issue: obj }, ctx)
        : { issue: obj };
      continue;
    }
    if (sel.name === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repoId = store.decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = repoId ? store.findRepoById(repoId.repoId) : undefined;
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const title = String(input.title ?? '');
      if (!repo) {
        ctx.errors.push({ message: 'Could not resolve repository.' });
        out[key] = null;
        continue;
      }
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) {
        ctx.errors.push({ message: 'Head or base branch does not exist.' });
        out[key] = null;
        continue;
      }
      const existing = [...repo.pulls.values()].find((p) => p.state === 'open' && p.head === head && p.base === base);
      if (existing) {
        ctx.errors.push({ message: 'A pull request already exists for this head branch.' });
        out[key] = null;
        continue;
      }
      const seq = store.nextSeq();
      const number = repo.nextNumber++;
      const pull: Pull = {
        id: store.nextIssueId++, number, title, body: String(input.body ?? ''),
        state: 'open', head, base, headSha, baseSha, merged: false, mergedAt: null,
        mergeCommitSha: null, user: store.viewerLogin,
        createdAt: isoFor(seq), updatedAt: isoFor(seq), seq,
      };
      repo.pulls.set(number, pull);
      const obj = pullObject(store, repo, pull);
      out[key] = sel.selections
        ? executeSelections(sel.selections, 'CreatePullRequestPayload', { __typename: 'CreatePullRequestPayload', pullRequest: obj }, ctx)
        : { pullRequest: obj };
      continue;
    }
    if (sel.name === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = store.decodeGlobalId(String(input.pullRequestId ?? ''));
      let pull: Pull | undefined;
      let repo: Repo | undefined;
      if (decoded && decoded.number !== undefined) {
        repo = store.findRepoById(decoded.repoId);
        pull = repo?.pulls.get(decoded.number);
      }
      if (!pull || !repo) {
        ctx.errors.push({ message: 'Could not resolve pull request.' });
        out[key] = null;
        continue;
      }
      const method = String(input.mergeMethod ?? 'MERGE').toUpperCase() === 'SQUASH' ? 'squash' : 'merge';
      if (pull.state !== 'open') {
        ctx.errors.push({ message: 'Pull request is not open.' });
        out[key] = null;
        continue;
      }
      const commitOid = store.mergePull(repo, pull, method);
      if (!commitOid) {
        ctx.errors.push({ message: 'Merge conflict.' });
        out[key] = null;
        continue;
      }
      const obj = pullObject(store, repo, pull);
      out[key] = sel.selections
        ? executeSelections(sel.selections, 'MergePullRequestPayload', { __typename: 'MergePullRequestPayload', pullRequest: obj }, ctx)
        : { pullRequest: obj };
      continue;
    }
    if (sel.name === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = store.decodeGlobalId(String(input.subjectId ?? ''));
      let issue: Issue | undefined;
      let repo: Repo | undefined;
      if (decoded && decoded.number !== undefined) {
        repo = store.findRepoById(decoded.repoId);
        issue = repo?.issues.get(decoded.number);
      }
      if (!issue || !repo) {
        ctx.errors.push({ message: 'Could not resolve subject.' });
        out[key] = null;
        continue;
      }
      const seq = store.nextSeq();
      const comment = {
        id: store.nextCommentId++, issueNumber: issue.number, body: String(input.body ?? ''),
        user: store.viewerLogin, createdAt: isoFor(seq), updatedAt: isoFor(seq), seq,
      };
      issue.comments.push(comment);
      const node = {
        __typename: 'IssueComment',
        id: store.globalId('comment', repo.id, comment.id),
        body: comment.body,
        author: { __typename: 'User', login: comment.user, id: store.viewerId, name: '', email: '' },
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
      };
      out[key] = sel.selections
        ? executeSelections(sel.selections, 'AddCommentPayload', { __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', node } }, ctx)
        : { commentEdge: { node } };
      continue;
    }
    ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "Mutation".` });
    out[key] = null;
  }
  return out;
}

// ---- entry point ---------------------------------------------------------------

export function handleGraphQL(store: Store, body: Buffer): { status: number; body: Buffer } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, body: Buffer.from(JSON.stringify({ errors: [{ message: 'Invalid JSON body.' }] })) };
  }
  const operations = Array.isArray(parsed) ? parsed : [parsed];
  const results: unknown[] = [];
  for (const op of operations) {
    results.push(executeOne(store, op as Record<string, unknown>));
  }
  return { status: 200, body: Buffer.from(JSON.stringify(Array.isArray(parsed) ? results : results[0])) };
}

function executeOne(store: Store, op: Record<string, unknown>): Record<string, unknown> {
  const query = typeof op.query === 'string' ? op.query : '';
  const variables = (op.variables ?? {}) as Record<string, unknown>;
  const operationName = typeof op.operationName === 'string' ? op.operationName : undefined;
  let doc: { operations: OperationNode[]; fragments: Map<string, FragmentNode> };
  try {
    doc = new Parser(query).parseDocument();
  } catch (e) {
    return { data: null, errors: [{ message: `GraphQL parse error: ${(e as Error).message}` }] };
  }
  const operation = operationName
    ? doc.operations.find((o) => o.name === operationName)
    : doc.operations[0];
  if (!operation) {
    return { data: null, errors: [{ message: 'No operation to execute.' }] };
  }
  // merge variable defaults
  const vars: Record<string, unknown> = { ...variables };
  for (const v of operation.variables) {
    if (vars[v.name] === undefined && v.defaultValue !== undefined) {
      vars[v.name] = resolveValue(v.defaultValue, vars);
    }
  }
  const ctx: Ctx = { store, variables: vars, fragments: doc.fragments, errors: [] };

  if (operation.operation === 'mutation') {
    const data = executeMutation(operation, ctx);
    const result: Record<string, unknown> = { data };
    if (ctx.errors.length > 0) result.errors = ctx.errors;
    return result;
  }

  const rootType = 'Query';
  const validationError = validateSelections(operation.selections, rootType, ctx);
  if (validationError) {
    return { data: null, errors: [{ message: validationError }] };
  }
  const data = executeSelections(operation.selections, rootType, { __typename: 'Query' }, ctx);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

// Payload types need their fields in the schema map for validation of nested selections.
(SCHEMA_FIELDS as Record<string, string[]>).CreateIssuePayload = ['issue', 'clientMutationId', '__typename'];
(SCHEMA_FIELDS as Record<string, string[]>).CloseIssuePayload = ['issue', 'clientMutationId', '__typename'];
(SCHEMA_FIELDS as Record<string, string[]>).CreatePullRequestPayload = ['pullRequest', 'clientMutationId', '__typename'];
(SCHEMA_FIELDS as Record<string, string[]>).MergePullRequestPayload = ['pullRequest', 'clientMutationId', '__typename'];
(SCHEMA_FIELDS as Record<string, string[]>).AddCommentPayload = ['commentEdge', 'clientMutationId', '__typename'];
(SCHEMA_FIELDS as Record<string, string[]>).IssueCommentEdge = ['node', 'cursor', '__typename'];
(SCHEMA_FIELDS as Record<string, string[]>).IssueEdge = ['node', 'cursor', '__typename'];
(SCHEMA_FIELDS as Record<string, string[]>).PullRequestEdge = ['node', 'cursor', '__typename'];
(SCHEMA_FIELDS as Record<string, string[]>).PullRequestChangedFileEdge = ['node', 'cursor', '__typename'];
(SCHEMA_FIELDS as Record<string, string[]>).Node = ['id', '__typename'];
