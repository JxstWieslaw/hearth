// Hearth HTTP server: static files from public/, JSON API under /api, SSE at /api/events.
// Node built-ins only. Exports createApp() so tests can run it on port 0.

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, rotateFairly, summarise } from './lib/store.mjs';
import * as validate from './lib/validate.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const MAX_BODY = 16 * 1024;
const PING_MS = 25_000;
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const notFound = (what = 'resource') => new HttpError(404, 'not_found', `That ${what} does not exist.`);

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function sendError(res, status, code, message) {
  if (status === 413) res.setHeader('Connection', 'close');
  sendJson(res, status, { error: { code, message } });
}

// Browser-origin guard. Hearth has no login, so the browser's own headers are the trust boundary:
// an attacker's web page cannot forge Host or Origin. The Host check stops DNS rebinding (a public
// hostname pointed at this LAN address); the Origin check stops cross-site requests from other
// pages the family happens to have open. Extra hostnames: HEARTH_ALLOWED_HOSTS=a.local,b.local
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const PRIVATE_IPV4 = /^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+)$/;
// On Vercel, the deployment's own hostnames arrive as system env vars; only those are added.
const EXTRA_HOSTS = new Set(
  [
    ...(process.env.HEARTH_ALLOWED_HOSTS || '').split(','),
    process.env.VERCEL_URL,
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
  ].map((h) => (h || '').trim().toLowerCase()).filter(Boolean),
);
const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function hostName(header = '') {
  const value = header.trim().toLowerCase();
  if (value.startsWith('[')) return value.replace(/\]:\d+$/, ']');
  return value.replace(/:\d+$/, '');
}

export function hostAllowed(hostHeader) {
  const host = hostName(hostHeader);
  return LOCAL_HOSTS.has(host) || EXTRA_HOSTS.has(host) || PRIVATE_IPV4.test(host);
}

export function originAllowed(headers) {
  const origin = headers.origin;
  if (!origin || origin === 'null') {
    const site = headers['sec-fetch-site'];
    return !site || site === 'same-origin' || site === 'none';
  }
  try {
    return new URL(origin).host.toLowerCase() === (headers.host || '').trim().toLowerCase();
  } catch {
    return false;
  }
}

function assertTrustedRequest(req) {
  if (!hostAllowed(req.headers.host)) {
    throw new HttpError(421, 'host_not_allowed', 'Hearth only answers to localhost or a home-network address.');
  }
  if (!MUTATING.has(req.method)) return;
  if (!originAllowed(req.headers)) {
    throw new HttpError(403, 'cross_site_request', 'Changes are only accepted from the Hearth page itself.');
  }
  // Required even on body-less changes (rotate, reset): a JSON content type makes every cross-site
  // attempt a CORS preflight, which this server never approves, so old browsers without Fetch
  // Metadata are covered too.
  if (!/^application[/]json(;|$)/i.test((req.headers['content-type'] || '').trim())) {
    throw new HttpError(415, 'unsupported_media_type', 'Send JSON with Content-Type: application/json.');
  }
}

function parseBody(text) {
  if (Buffer.byteLength(text) > MAX_BODY) throw new HttpError(413, 'payload_too_large', 'Request body must be 16 KB or smaller.');
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON.');
  }
}

function readJson(req) {
  // A hosting platform may have read the body already (Vercel's Node helpers do); use it if so.
  if (req.body !== undefined) {
    const b = req.body;
    const text = Buffer.isBuffer(b) ? b.toString('utf8') : typeof b === 'string' ? b : b === null ? '' : JSON.stringify(b);
    return Promise.resolve().then(() => parseBody(text));
  }
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on('data', (chunk) => {
      if (overflow) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        overflow = true;
        reject(new HttpError(413, 'payload_too_large', 'Request body must be 16 KB or smaller.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (overflow) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') return resolvePromise({});
      try {
        resolvePromise(JSON.parse(text));
      } catch {
        reject(new HttpError(400, 'invalid_json', 'Request body must be valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function checked(result) {
  if (!result.ok) throw new HttpError(400, 'validation_failed', result.message);
  return result.value;
}

// streamLimitMs: end each live stream after this long so a serverless time limit never cuts it
// mid-frame; the browser's EventSource reconnects on its own and receives the full state again.
export function createApp({ store, log = console.log, streamLimitMs = 0 } = {}) {
  const sseClients = new Set();

  const frame = (state) => `event: state\ndata: ${JSON.stringify(summarise(state))}\n\n`;
  const unsubscribe = store.subscribe((state) => {
    const payload = frame(state);
    for (const res of sseClients) res.write(payload);
  });
  const ping = setInterval(() => {
    for (const res of sseClients) res.write(': ping\n\n');
  }, PING_MS);
  ping.unref();

  const memberIds = () => store.getState().members.map((m) => m.id);

  function openEvents(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    res.write(frame(store.getState()));
    sseClients.add(res);
    const limit = streamLimitMs > 0 ? setTimeout(() => res.end(), streamLimitMs) : null;
    req.on('close', () => {
      if (limit) clearTimeout(limit);
      sseClients.delete(res);
    });
  }

  async function handleChores(method, id, req, res) {
    if (id === null) {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST to add a chore.');
      const input = checked(validate.choreCreate(await readJson(req), memberIds()));
      const chore = {
        id: randomUUID(),
        ...input,
        status: 'todo',
        doneBy: null,
        doneAt: null,
        createdAt: new Date().toISOString(),
      };
      store.mutate((s) => { s.chores.push(chore); });
      return sendJson(res, 201, chore);
    }
    if (id === 'rotate') {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST to rotate chores.');
      const state = store.mutate((s) => rotateFairly(s));
      return sendJson(res, 200, summarise(state));
    }
    const exists = store.getState().chores.some((c) => c.id === id);
    if (!exists) throw notFound('chore');
    if (method === 'DELETE') {
      store.mutate((s) => { s.chores = s.chores.filter((c) => c.id !== id); });
      res.writeHead(204);
      return res.end();
    }
    if (method === 'PATCH') {
      const input = checked(validate.chorePatch(await readJson(req), memberIds()));
      let updated = null;
      store.mutate((s) => {
        const chore = s.chores.find((c) => c.id === id);
        if (!chore) throw notFound('chore'); // deleted while the body was arriving
        if (input.assigneeId !== undefined) chore.assigneeId = input.assigneeId;
        if (input.status === 'done') {
          chore.status = 'done';
          chore.doneBy = input.actorId;
          chore.doneAt = new Date().toISOString();
        } else if (input.status === 'todo') {
          chore.status = 'todo';
          chore.doneBy = null;
          chore.doneAt = null;
        }
        updated = chore;
      });
      return sendJson(res, 200, updated);
    }
    throw new HttpError(405, 'method_not_allowed', 'Use PATCH or DELETE on a chore.');
  }

  async function handleShopping(method, id, req, res) {
    if (id === null) {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST to add an item.');
      const input = checked(validate.shoppingCreate(await readJson(req), memberIds()));
      const item = {
        id: randomUUID(),
        name: input.name,
        qty: input.qty,
        addedBy: input.actorId,
        status: 'needed',
        boughtBy: null,
        createdAt: new Date().toISOString(),
        boughtAt: null,
      };
      store.mutate((s) => { s.shopping.push(item); });
      return sendJson(res, 201, item);
    }
    const exists = store.getState().shopping.some((i) => i.id === id);
    if (!exists) throw notFound('shopping item');
    if (method === 'DELETE') {
      store.mutate((s) => { s.shopping = s.shopping.filter((i) => i.id !== id); });
      res.writeHead(204);
      return res.end();
    }
    if (method === 'PATCH') {
      const input = checked(validate.shoppingPatch(await readJson(req), memberIds()));
      let updated = null;
      store.mutate((s) => {
        const item = s.shopping.find((i) => i.id === id);
        if (!item) throw notFound('shopping item'); // deleted while the body was arriving
        item.status = input.status;
        item.boughtBy = input.status === 'bought' ? input.actorId : null;
        item.boughtAt = input.status === 'bought' ? new Date().toISOString() : null;
        updated = item;
      });
      return sendJson(res, 200, updated);
    }
    throw new HttpError(405, 'method_not_allowed', 'Use PATCH or DELETE on a shopping item.');
  }

  async function handleApi(method, pathname, req, res) {
    if (pathname === '/api/state' && method === 'GET') return sendJson(res, 200, summarise(store.getState()));
    if (pathname === '/api/events' && method === 'GET') return openEvents(req, res);
    if (pathname === '/api/reset' && method === 'POST') return sendJson(res, 200, summarise(store.reset()));

    const parts = pathname.split('/').filter(Boolean); // ['api', 'chores', id?]
    if (parts.length >= 2 && parts.length <= 3) {
      const id = parts.length === 3 ? decodeURIComponent(parts[2]) : null;
      if (parts[1] === 'chores') return handleChores(method, id, req, res);
      if (parts[1] === 'shopping') return handleShopping(method, id, req, res);
    }
    throw new HttpError(404, 'not_found', 'No such API route.');
  }

  async function serveStatic(method, pathname, res) {
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'Only GET is allowed here.');
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const abs = normalize(join(PUBLIC_DIR, rel));
    if (!abs.startsWith(PUBLIC_DIR + sep)) throw notFound('page');
    const type = CONTENT_TYPES[extname(abs).toLowerCase()];
    if (!type) throw notFound('page');
    let data;
    try {
      data = await readFile(abs);
    } catch {
      throw notFound('page');
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
    res.end(method === 'HEAD' ? undefined : data);
  }

  const server = createServer(async (req, res) => {
    const started = Date.now();
    res.on('close', () => log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`));
    try {
      assertTrustedRequest(req);
      const url = new URL(req.url, 'http://hearth.local');
      if (url.pathname.startsWith('/api/')) await handleApi(req.method, url.pathname, req, res);
      else await serveStatic(req.method, url.pathname, res);
    } catch (err) {
      if (res.headersSent) { res.end(); return; }
      if (err instanceof HttpError) return sendError(res, err.status, err.code, err.message);
      if (err instanceof URIError) return sendError(res, 400, 'bad_request', 'That URL could not be decoded.');
      console.error(err);
      sendError(res, 500, 'internal_error', 'Something went wrong on the server.');
    }
  });

  function shutdown() {
    clearInterval(ping);
    unsubscribe();
    for (const res of sseClients) res.end();
    sseClients.clear();
    server.close();
    server.closeAllConnections();
  }

  // handle: the plain (req, res) listener, for platforms that call a function instead of a server.
  const handle = server.listeners('request')[0];
  return { server, shutdown, handle };
}

const isMain = process.argv[1] &&
  resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isMain) {
  const HOST = process.env.HOST || '127.0.0.1';
  const PORT = Number(process.env.PORT || 4317);
  const store = createStore({ file: join(ROOT, 'data', 'hearth.json') });
  const { server, shutdown } = createApp({ store });

  server.listen(PORT, HOST, () => {
    console.log(`Hearth is listening on http://${HOST}:${PORT}`);
    if (HOST === '0.0.0.0') console.log('Phones on the home Wi-Fi can open http://<this-computer-ip>:' + PORT);
  });

  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, closing Hearth`);
    shutdown();
    store.flush();
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}
