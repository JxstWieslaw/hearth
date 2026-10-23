// Vercel entry point. vercel.json rewrites every /api/* path to this one function as
// /api/hearth?path=<rest>; we restore the original URL before handing the request to the same app
// the local server runs. State lives in this instance's memory, saved to its temp directory, so the
// hosted board is a demo: it starts from the seed whenever a fresh instance boots.

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.mjs';
import { createApp } from '../server.mjs';

const store = createStore({ file: join(tmpdir(), 'hearth.json') });

// End live streams before the function's 300 s limit; browsers reconnect within 2 s.
const { handle } = createApp({ store, streamLimitMs: 240_000 });

export function originalUrl(rawUrl) {
  const url = new URL(rawUrl, 'http://hearth.local');
  const path = url.searchParams.get('path');
  if (path === null) return rawUrl; // the platform already passed the original URL through
  url.searchParams.delete('path');
  return `/api/${path.replace(/^\/+/, '')}${url.search}`;
}

export default function handler(req, res) {
  req.url = originalUrl(req.url);
  return handle(req, res);
}
