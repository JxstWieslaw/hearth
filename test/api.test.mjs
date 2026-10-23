import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.mjs';
import { createApp } from '../server.mjs';
import { request as httpRequest } from 'node:http';

let dir;
let app;
let base;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hearth-api-'));
  const store = createStore({ file: join(dir, 'hearth.json') });
  app = createApp({ store, log: () => {} });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => {
  app.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

async function api(method, path, body, rawBody) {
  const res = await fetch(base + path, {
    method,
    headers: method === 'GET' ? {} : { 'content-type': 'application/json' },
    body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

const byName = (state, name) => state.members.find((m) => m.name === name);

test('GET /api/state returns the board shape', async () => {
  const { status, body } = await api('GET', '/api/state');
  assert.equal(status, 200);
  assert.equal(body.members.length, 5);
  assert.ok(Array.isArray(body.chores) && body.chores.length === 10);
  assert.ok(Array.isArray(body.shopping) && body.shopping.length === 6);
  assert.equal(typeof body.week.start, 'string');
  assert.deepEqual(Object.keys(body.week.points).sort(), body.members.map((m) => m.id).sort());
  assert.ok(body.week.fairness >= 0 && body.week.fairness <= 1);
  assert.equal(typeof body.updatedAt, 'string');
});

test('POST /api/chores creates a chore and rejects bad input', async () => {
  const { body: state } = await api('GET', '/api/state');
  const tapiwa = byName(state, 'Tapiwa');

  const ok = await api('POST', '/api/chores', { title: 'Mop the kitchen', assigneeId: tapiwa.id, points: 3, dueDay: 'Wed' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.title, 'Mop the kitchen');
  assert.equal(ok.body.status, 'todo');
  assert.equal(ok.body.doneBy, null);

  const noTitle = await api('POST', '/api/chores', { title: '  ', assigneeId: tapiwa.id, points: 3, dueDay: 'Wed' });
  assert.equal(noTitle.status, 400);
  assert.equal(noTitle.body.error.code, 'validation_failed');

  const badPoints = await api('POST', '/api/chores', { title: 'X', assigneeId: tapiwa.id, points: 11, dueDay: 'Wed' });
  assert.equal(badPoints.status, 400);

  const badMember = await api('POST', '/api/chores', { title: 'X', assigneeId: 'nobody', points: 2, dueDay: 'Wed' });
  assert.equal(badMember.status, 400);

  const badJson = await api('POST', '/api/chores', undefined, '{not json');
  assert.equal(badJson.status, 400);
  assert.equal(badJson.body.error.code, 'invalid_json');
});

test('PATCH chore done credits week points to the actor, todo clears them', async () => {
  const { body: before } = await api('GET', '/api/state');
  const tapiwa = byName(before, 'Tapiwa');
  const pointsBefore = before.week.points[tapiwa.id];

  const created = await api('POST', '/api/chores', { title: 'Fold laundry', assigneeId: tapiwa.id, points: 4, dueDay: 'Thu' });
  const done = await api('PATCH', `/api/chores/${created.body.id}`, { status: 'done', actorId: tapiwa.id });
  assert.equal(done.status, 200);
  assert.equal(done.body.status, 'done');
  assert.equal(done.body.doneBy, tapiwa.id);
  assert.ok(done.body.doneAt);

  const { body: after } = await api('GET', '/api/state');
  assert.equal(after.week.points[tapiwa.id], pointsBefore + 4);

  const undone = await api('PATCH', `/api/chores/${created.body.id}`, { status: 'todo', actorId: tapiwa.id });
  assert.equal(undone.body.doneBy, null);
  assert.equal(undone.body.doneAt, null);

  const noActor = await api('PATCH', `/api/chores/${created.body.id}`, { status: 'done' });
  assert.equal(noActor.status, 400);
});

test('POST /api/chores/rotate gives the biggest open chore to whoever has the least', async () => {
  const { body: before } = await api('GET', '/api/state');
  const lowest = before.members.reduce((best, m) => (before.week.points[m.id] < before.week.points[best.id] ? m : best));
  const todo = before.chores.filter((c) => c.status === 'todo');
  const biggest = todo.reduce((best, c) => (c.points > best.points ? c : best));

  const { status, body } = await api('POST', '/api/chores/rotate');
  assert.equal(status, 200);
  assert.ok(body.week && body.members.length === 5);
  const rotated = body.chores.find((c) => c.id === biggest.id);
  assert.equal(rotated.assigneeId, lowest.id);
  for (const c of body.chores.filter((c) => c.status === 'todo')) {
    assert.ok(body.members.some((m) => m.id === c.assigneeId));
  }
});

test('shopping: add, buy, un-buy, delete', async () => {
  const { body: state } = await api('GET', '/api/state');
  const rudo = byName(state, 'Rudo');

  const added = await api('POST', '/api/shopping', { name: 'Eggs', qty: '12', actorId: rudo.id });
  assert.equal(added.status, 201);
  assert.equal(added.body.status, 'needed');
  assert.equal(added.body.qty, '12');
  assert.equal(added.body.addedBy, rudo.id);

  const bought = await api('PATCH', `/api/shopping/${added.body.id}`, { status: 'bought', actorId: rudo.id });
  assert.equal(bought.status, 200);
  assert.equal(bought.body.boughtBy, rudo.id);
  assert.ok(bought.body.boughtAt);

  const needed = await api('PATCH', `/api/shopping/${added.body.id}`, { status: 'needed', actorId: rudo.id });
  assert.equal(needed.body.boughtBy, null);

  const missingName = await api('POST', '/api/shopping', { name: '', actorId: rudo.id });
  assert.equal(missingName.status, 400);

  const del = await api('DELETE', `/api/shopping/${added.body.id}`);
  assert.equal(del.status, 204);
  const gone = await api('PATCH', `/api/shopping/${added.body.id}`, { status: 'bought', actorId: rudo.id });
  assert.equal(gone.status, 404);
  assert.equal(gone.body.error.code, 'not_found');
});

test('unknown ids and routes return 404 JSON', async () => {
  const { body: state } = await api('GET', '/api/state');
  const chore = await api('PATCH', '/api/chores/does-not-exist', { status: 'done', actorId: state.members[0].id });
  assert.equal(chore.status, 404);
  assert.equal(chore.body.error.code, 'not_found');
  const del = await api('DELETE', '/api/chores/does-not-exist');
  assert.equal(del.status, 404);
  const route = await api('GET', '/api/nope');
  assert.equal(route.status, 404);
  assert.equal(typeof route.body.error.message, 'string');
});

test('oversized bodies are refused with 413', async () => {
  const big = JSON.stringify({ title: 'x'.repeat(20_000) });
  const res = await api('POST', '/api/chores', undefined, big);
  assert.equal(res.status, 413);
  assert.equal(res.body.error.code, 'payload_too_large');
});

test('GET /api/events streams an initial state event', async () => {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: controller.signal });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type').startsWith('text/event-stream'));
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  while (!/event: state\ndata: .*\n\n/s.test(buffered)) {
    const { value, done } = await reader.read();
    assert.ok(!done, 'stream closed before the first state frame');
    buffered += decoder.decode(value, { stream: true });
  }
  assert.ok(buffered.startsWith('retry: 2000\n\n'), `unexpected opening: ${buffered.slice(0, 40)}`);
  const text = buffered.slice(buffered.indexOf('event: state'));
  const json = JSON.parse(text.slice('event: state\ndata: '.length, text.indexOf('\n\n')));
  assert.equal(json.members.length, 5);
  controller.abort();
});

test('GET / serves the HTML shell and blocks traversal', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.ok(page.headers.get('content-type').startsWith('text/html'));
  assert.ok((await page.text()).includes('Hearth'));
  const sneaky = await fetch(`${base}/..%2F..%2Fpackage.json`);
  assert.equal(sneaky.status, 404);
  const reset = await api('POST', '/api/reset');
  assert.equal(reset.status, 200);
  assert.equal(reset.body.chores.length, 10);
});

// fetch() refuses to set Host, so these use node:http to send a raw header like a rebinding attacker would.
function rawGet(path, host) {
  return new Promise((resolve, reject) => {
    const { port } = app.server.address();
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers: { host } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('requests for a foreign Host are refused (DNS rebinding)', async () => {
  const foreign = await rawGet('/api/state', 'evil.example.com');
  assert.equal(foreign.status, 421);
  assert.equal(foreign.body.error.code, 'host_not_allowed');
  const lan = await rawGet('/api/state', '192.168.1.20:4317');
  assert.equal(lan.status, 200);
  const local = await rawGet('/api/state', 'localhost:4317');
  assert.equal(local.status, 200);
});

test('cross-site mutations are refused, same-origin ones pass (CSRF)', async () => {
  const state = await (await fetch(base + '/api/state')).json();
  const actorId = byName(state, 'Rudo').id;
  const payload = JSON.stringify({ name: 'Eggs', actorId });
  const cross = await fetch(base + '/api/shopping', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
    body: payload,
  });
  assert.equal(cross.status, 403);
  assert.equal((await cross.json()).error.code, 'cross_site_request');

  const same = await fetch(base + '/api/shopping', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: payload,
  });
  assert.equal(same.status, 201);

  const wrongType = await fetch(base + '/api/shopping', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: payload,
  });
  assert.equal(wrongType.status, 415);

  const read = await fetch(base + '/api/state', { headers: { origin: 'https://evil.example.com' } });
  assert.equal(read.status, 200, 'reads are not blocked by Origin; the data is not secret on the LAN');
});

test('body-less changes without a JSON content type are refused (old-browser CSRF)', async () => {
  const res = await fetch(base + '/api/reset', { method: 'POST' });
  assert.equal(res.status, 415);
  assert.equal((await res.json()).error.code, 'unsupported_media_type');
  const ok = await fetch(base + '/api/chores/rotate', { method: 'POST', headers: { 'content-type': 'application/json' } });
  assert.equal(ok.status, 200);
  const v6 = await rawGet('/api/state', '[::1]:4317');
  assert.equal(v6.status, 200);
});

test('live streams end after streamLimitMs so serverless limits never cut them mid-frame', async () => {
  const sdir = mkdtempSync(join(tmpdir(), 'hearth-limit-'));
  const limited = createApp({ store: createStore({ file: join(sdir, 'hearth.json') }), log: () => {}, streamLimitMs: 150 });
  await new Promise((resolve) => limited.server.listen(0, '127.0.0.1', resolve));
  const started = Date.now();
  const res = await fetch(`http://127.0.0.1:${limited.server.address().port}/api/events`);
  const text = await res.text(); // resolves only when the server ends the stream
  assert.ok(Date.now() - started < 3000, 'stream ended on its own');
  assert.match(text, /retry: 2000/);
  assert.match(text, /event: state/);
  limited.shutdown();
  rmSync(sdir, { recursive: true, force: true });
});

test('a body already read by the platform is used as-is', async () => {
  const sdir = mkdtempSync(join(tmpdir(), 'hearth-prebody-'));
  const app2 = createApp({ store: createStore({ file: join(sdir, 'hearth.json') }), log: () => {} });
  const { Readable } = await import('node:stream');
  const state = await (await fetch(base + '/api/state')).json();
  const req = Object.assign(Readable.from([]), {
    method: 'POST', url: '/api/shopping',
    headers: { host: 'localhost:4317', 'content-type': 'application/json' },
    body: { name: 'Rice', actorId: state.members[0].id },
  });
  // Member ids differ per store, so expect a 400 naming the member, proving the body was read.
  const out = await new Promise((resolve) => {
    const res = { statusCode: 0, headersSent: false, headers: {}, on() {}, setHeader() {},
      writeHead(code) { this.statusCode = code; return this; },
      end(body) { resolve({ status: this.statusCode, body: body ? JSON.parse(body) : null }); } };
    app2.handle(req, res);
  });
  assert.equal(out.status, 400);
  assert.equal(out.body.error.code, 'validation_failed');
  app2.shutdown();
  rmSync(sdir, { recursive: true, force: true });
});
