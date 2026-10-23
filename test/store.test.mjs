import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, fairness, rotateFairly, seedState, weekPoints, weekStart } from '../lib/store.mjs';

const byName = (state, name) => state.members.find((m) => m.name === name);

test('seed credits this week\'s points to whoever did the chore', () => {
  const state = seedState();
  const points = weekPoints(state);
  assert.equal(points[byName(state, 'Anesu').id], 3);
  assert.equal(points[byName(state, 'Tapiwa').id], 2);
  assert.equal(points[byName(state, 'Rudo').id], 4);
  assert.equal(points[byName(state, 'Tendai').id], 0);
  assert.equal(points[byName(state, 'Chiedza').id], 0);
  assert.equal(fairness(points), 0);
  assert.equal(fairness({ a: 0, b: 0 }), 1);
  assert.equal(fairness({ a: 3, b: 5 }), 0.6);
});

test('weekPoints ignores chores done before Monday', () => {
  const state = seedState();
  const lastWeek = new Date(weekStart().getTime() - 60 * 60 * 1000).toISOString();
  const stale = { ...state, chores: state.chores.map((c) => (c.status === 'done' ? { ...c, doneAt: lastWeek } : c)) };
  assert.deepEqual(Object.values(weekPoints(stale)), [0, 0, 0, 0, 0]);
});

test('rotateFairly is pure and spreads work greedily by running total', () => {
  const now = new Date();
  const members = [
    { id: 'A', name: 'A' },
    { id: 'B', name: 'B' },
    { id: 'C', name: 'C' },
  ];
  const done = (id, who, points) => ({ id, title: id, assigneeId: who, points, dueDay: 'Mon', status: 'done', doneBy: who, doneAt: now.toISOString(), createdAt: '2026-01-01T00:00:00.000Z' });
  const todo = (id, points) => ({ id, title: id, assigneeId: 'A', points, dueDay: 'Mon', status: 'todo', doneBy: null, doneAt: null, createdAt: '2026-01-01T00:00:00.000Z' });
  const state = {
    members,
    chores: [done('d1', 'B', 5), done('d2', 'C', 2), todo('t5', 5), todo('t3', 3), todo('t2', 2), todo('t1', 1)],
    shopping: [],
    updatedAt: now.toISOString(),
  };
  const snapshot = structuredClone(state);
  const next = rotateFairly(state, now);
  assert.deepEqual(state, snapshot, 'input must not be mutated');
  const who = Object.fromEntries(next.chores.map((c) => [c.id, c.assigneeId]));
  // Running totals start A=0, B=5, C=2. 5->A (5), 3->C (5), 2->B (fewest handed), 1->A (seed order).
  assert.deepEqual({ t5: who.t5, t3: who.t3, t2: who.t2, t1: who.t1 }, { t5: 'A', t3: 'C', t2: 'B', t1: 'A' });
  assert.equal(who.d1, 'B', 'done chores keep their assignee');
});

test('store persists atomically and reloads the same state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hearth-store-'));
  const file = join(dir, 'hearth.json');
  try {
    const store = createStore({ file });
    assert.ok(existsSync(file), 'seed is written on boot');
    const seen = [];
    store.subscribe((s) => seen.push(s.chores.length));
    store.mutate((s) => {
      s.chores.push({ id: 'x', title: 'Test', assigneeId: s.members[0].id, points: 1, dueDay: 'Mon', status: 'todo', doneBy: null, doneAt: null, createdAt: new Date().toISOString() });
    });
    assert.deepEqual(seen, [11]);
    assert.ok(!existsSync(`${file}.tmp`), 'tmp file is renamed away');

    const reloaded = createStore({ file });
    assert.deepEqual(reloaded.getState(), store.getState());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
