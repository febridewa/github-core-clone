// HTTP server: routes /healthz, /mcp, /api/graphql, /api/v3/* and the
// smart-HTTP git paths /{owner}/{repo}.git/*. Every reply carries a
// non-empty X-GitHub-Request-Id. Bodies are capped at 50 MiB.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleUploadPack, handleReceivePack } from './gitproto.ts';

const MAX_BODY = 50 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function headersObject(req: IncomingMessage): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) out[k.toLowerCase()] = v;
  return out;
}

function send(res: ServerResponse, status: number, headers: Record<string, string>, body: Buffer): void {
  res.writeHead(status, { ...headers, 'Content-Length': String(body.length) });
  res.end(body);
}

export function createApp(store?: Store, expectedToken?: string | null) {
  const theStore = store ?? new Store();
  const expectedTokenValue = expectedToken === undefined ? (process.env.MAKEFUN_SHOP_TOKEN ?? null) : expectedToken;
  const server = createServer(async (req, res) => {
    const requestId = theStore.nextRequestId();
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const method = req.method ?? 'GET';
      const headers = headersObject(req);
      const host = req.headers.host ?? 'localhost';
      const proto = (req.headers['x-forwarded-proto'] as string) ?? 'http';
      const origin = `${proto}://${host}`;
      const withId = (extra: Record<string, string>): Record<string, string> => ({
        'X-GitHub-Request-Id': requestId, ...extra,
      });

      if (path === '/healthz') {
        send(res, 200, withId({ 'Content-Type': 'application/json' }), Buffer.from(JSON.stringify({ ok: true })));
        return;
      }

      if (path === '/mcp') {
        const body = (method === 'POST') ? await readBody(req) : Buffer.alloc(0);
        const out = handleMcp(theStore, expectedTokenValue, method, headers, body);
        send(res, out.status, withId(out.headers), out.body);
        return;
      }

      if (path === '/api/graphql') {
        if (method !== 'POST') {
          send(res, 404, withId({ 'Content-Type': 'application/json' }), Buffer.from(JSON.stringify({ message: 'Not Found' })));
          return;
        }
        const auth = headers['authorization'];
        const token = Array.isArray(auth) ? auth[0] : auth;
        const authed = token !== undefined && token.startsWith('Bearer ') && token.slice(7) !== '' &&
          (expectedTokenValue === null || token.slice(7) === expectedTokenValue);
        if (!authed) {
          send(res, 401, withId({ 'Content-Type': 'application/json' }), Buffer.from(JSON.stringify({ message: 'Requires authentication' })));
          return;
        }
        const body = await readBody(req);
        const out = handleGraphQL(theStore, body);
        send(res, out.status, withId({ 'Content-Type': 'application/json' }), out.body);
        return;
      }

      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        const segments = path === '/api/v3' ? [] : path.slice('/api/v3/'.length).split('/').filter((s) => s !== '');
        const body = (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')
          ? await readBody(req) : Buffer.alloc(0);
        const out = handleRest(theStore, expectedTokenValue, method, segments, url.searchParams, headers, body, origin);
        send(res, out.status, out.headers, out.body);
        return;
      }

      // Smart HTTP: /{owner}/{repo}.git/info/refs | /git-upload-pack | /git-receive-pack
      const gitMatch = /^\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\.git(\/.*)$/.exec(path);
      if (gitMatch) {
        const [, owner, repoName, suffix] = gitMatch;
        // Auth: the forge's one bearer <redacted> every git request carries.
        const auth = headers['authorization'];
        const token = Array.isArray(auth) ? auth[0] : auth;
        const authed = token !== undefined && token.startsWith('Bearer ') && token.slice(7) !== '' &&
          (expectedTokenValue === null || token.slice(7) === expectedTokenValue);
        if (!authed) {
          send(res, 401, withId({ 'Content-Type': 'application/json' }), Buffer.from(JSON.stringify({ message: 'Requires authentication' })));
          return;
        }
        const repo = owner === theStore.viewerLogin ? theStore.getRepo(owner, repoName) : undefined;
        const gitProtocolV2 = (headers['git-protocol'] ?? '') === 'version=2';
        if (suffix === '/info/refs' && method === 'GET') {
          const service = url.searchParams.get('service');
          if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
            send(res, 400, withId({ 'Content-Type': 'application/json' }), Buffer.from(JSON.stringify({ message: 'Bad Request' })));
            return;
          }
          const out = handleInfoRefs(repo, service, gitProtocolV2);
          send(res, out.status, withId({ 'Content-Type': out.contentType }), out.body);
          return;
        }
        if (suffix === '/git-upload-pack' && method === 'POST') {
          const body = await readBody(req);
          const out = handleUploadPack(repo, body, gitProtocolV2);
          send(res, out.status, withId({ 'Content-Type': out.contentType }), out.body);
          return;
        }
        if (suffix === '/git-receive-pack' && method === 'POST') {
          const body = await readBody(req);
          const out = handleReceivePack(repo, body);
          send(res, out.status, withId({ 'Content-Type': out.contentType }), out.body);
          return;
        }
        send(res, 404, withId({ 'Content-Type': 'application/json' }), Buffer.from(JSON.stringify({ message: 'Not Found' })));
        return;
      }

      send(res, 404, withId({ 'Content-Type': 'application/json' }), Buffer.from(JSON.stringify({ message: 'Not Found' })));
    } catch (err) {
      // Never kill the server on a bad request: answer 400 and keep serving.
      try {
        send(res, 400, { 'Content-Type': 'application/json', 'X-GitHub-Request-Id': requestId }, Buffer.from(JSON.stringify({ message: 'Bad Request' })));
      } catch {
        // the socket is already gone; nothing to do
      }
      void err;
    }
  });
  return server;
}
