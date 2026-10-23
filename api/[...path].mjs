// Vercel entry point: every /api/* request lands here and is handed to the same app the local
// server runs. State lives in this function instance's memory, saved to the instance's temp
// directory, so the hosted board is a demo: it starts from the seed whenever a fresh instance boots.

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.mjs';
import { createApp } from '../server.mjs';

const store = createStore({ file: join(tmpdir(), 'hearth.json') });

// End live streams before the function's 300 s limit; browsers reconnect within 2 s.
const { handle } = createApp({ store, streamLimitMs: 240_000 });

export default function handler(req, res) {
  return handle(req, res);
}
