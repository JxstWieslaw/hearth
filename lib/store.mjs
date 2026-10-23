// In-memory state with an atomic JSON file behind it. Every mutation persists and
// notifies subscribers (the SSE fan-out in server.mjs). Pure helpers are exported
// so fairness maths can be unit-tested without a server.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const DAY_MS = 24 * 60 * 60 * 1000;

// Week runs Monday 00:00 local to Sunday 23:59 local.
export function weekStart(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const sinceMonday = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - sinceMonday);
  return d;
}

// { [memberId]: points } for chores done this week, credited to doneBy. Everyone starts at 0.
export function weekPoints(state, now = new Date()) {
  const start = weekStart(now).getTime();
  const end = start + 7 * DAY_MS;
  const points = {};
  for (const m of state.members) points[m.id] = 0;
  for (const c of state.chores) {
    if (c.status !== 'done' || !c.doneAt || !c.doneBy) continue;
    const t = Date.parse(c.doneAt);
    if (Number.isNaN(t) || t < start || t >= end) continue;
    if (!(c.doneBy in points)) continue;
    points[c.doneBy] += c.points;
  }
  return points;
}

// lowest / highest week points. 1 when all equal (or all zero), 0 when someone has 0 and someone has more.
export function fairness(points) {
  const values = Object.values(points);
  if (values.length === 0) return 1;
  const max = Math.max(...values);
  if (max === 0) return 1;
  return Math.round((Math.min(...values) / max) * 100) / 100;
}

// Hand out every todo chore (biggest first) to whoever has the lowest running total.
// Ties: fewest chores handed out in this pass, then seed order. Pure: returns a new state.
export function rotateFairly(state, now = new Date()) {
  const totals = weekPoints(state, now);
  const handed = Object.fromEntries(state.members.map((m) => [m.id, 0]));
  const todo = state.chores
    .filter((c) => c.status === 'todo')
    .sort((a, b) => b.points - a.points || String(a.createdAt).localeCompare(String(b.createdAt)));

  const assignment = new Map();
  for (const chore of todo) {
    let best = null;
    for (const m of state.members) {
      if (best === null) { best = m; continue; }
      const diff = totals[m.id] - totals[best.id];
      if (diff < 0 || (diff === 0 && handed[m.id] < handed[best.id])) best = m;
    }
    if (!best) break;
    assignment.set(chore.id, best.id);
    totals[best.id] += chore.points;
    handed[best.id] += 1;
  }

  return {
    ...state,
    chores: state.chores.map((c) => (assignment.has(c.id) ? { ...c, assigneeId: assignment.get(c.id) } : c)),
  };
}

export function summarise(state, now = new Date()) {
  const points = weekPoints(state, now);
  return {
    members: state.members,
    chores: state.chores,
    shopping: state.shopping,
    week: { start: weekStart(now).toISOString(), points, fairness: fairness(points) },
    updatedAt: state.updatedAt,
  };
}

// The Moyo family, Harare.
export function seedState(now = new Date()) {
  const iso = (hoursAgo) => new Date(now.getTime() - hoursAgo * 60 * 60 * 1000).toISOString();
  const mk = (name, label, role, emoji, color) => ({ id: randomUUID(), name, label, role, emoji, color });
  const tendai = mk('Tendai', 'Dad', 'parent', '\u{1F468}\u{1F3FE}', '#2F6B4F');
  const rudo = mk('Rudo', 'Mum', 'parent', '\u{1F469}\u{1F3FE}', '#B5542D');
  const anesu = mk('Anesu', 'Anesu', 'child', '\u{1F467}\u{1F3FE}', '#7A4FB5');
  const chiedza = mk('Chiedza', 'Chiedza', 'child', '\u{1F467}\u{1F3FE}', '#D08A1E');
  const tapiwa = mk('Tapiwa', 'Tapiwa', 'child', '\u{1F466}\u{1F3FE}', '#2D6FB5');

  // Keep doneAt inside the current week even on a Monday morning: clamp to after week start.
  const doneAt = (hoursAgo) => {
    const t = Math.max(now.getTime() - hoursAgo * 60 * 60 * 1000, weekStart(now).getTime() + 60 * 1000);
    return new Date(t).toISOString();
  };

  const chore = (title, who, points, dueDay, done = null) => ({
    id: randomUUID(),
    title,
    assigneeId: who.id,
    points,
    dueDay,
    status: done ? 'done' : 'todo',
    doneBy: done ? who.id : null,
    doneAt: done ? doneAt(done) : null,
    createdAt: iso(72),
  });

  const item = (name, who, qty = null, boughtBy = null) => ({
    id: randomUUID(),
    name,
    qty,
    addedBy: who.id,
    status: boughtBy ? 'bought' : 'needed',
    boughtBy: boughtBy ? boughtBy.id : null,
    createdAt: iso(30),
    boughtAt: boughtBy ? iso(5) : null,
  });

  return {
    members: [tendai, rudo, anesu, chiedza, tapiwa],
    chores: [
      chore('Take out the bins', tapiwa, 2, 'Tue', 6),
      chore('Wash the dishes', anesu, 3, 'Mon', 4),
      chore('Sweep the yard', chiedza, 3, 'Sat'),
      chore('Feed Simba the dog', tapiwa, 1, 'Mon'),
      chore('Cook Sunday lunch', rudo, 5, 'Sun'),
      chore('Laundry', tendai, 4, 'Sat'),
      chore('Water the garden', chiedza, 2, 'Thu'),
      chore('Tidy the living room', anesu, 2, 'Fri'),
      chore('School-run roster check', tendai, 2, 'Wed'),
      chore('Clean the bathroom', rudo, 4, 'Fri', 2),
    ],
    shopping: [
      item('Milk 2L', rudo),
      item('Bread', anesu, '2 loaves'),
      item('Cooking oil', tendai),
      item('Sugar', chiedza),
      item('Toilet paper', rudo),
      item('Mazoe orange crush', tapiwa, null, tapiwa),
    ],
    updatedAt: now.toISOString(),
  };
}

function isValidState(s) {
  return (
    s !== null && typeof s === 'object' &&
    Array.isArray(s.members) && s.members.length > 0 &&
    Array.isArray(s.chores) && Array.isArray(s.shopping) &&
    typeof s.updatedAt === 'string'
  );
}

export function createStore({ file = null, seed = seedState } = {}) {
  const listeners = new Set();
  let state = load();

  function persist(s) {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, file); // atomic replace on the same volume
  }

  // Never overwrite a family's data silently: keep the bad file beside the new one.
  function quarantine(reason) {
    const kept = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try { renameSync(file, kept); } catch (err) { console.error(`[store] could not set aside ${file}: ${err.message}`); }
    console.error(`[store] ${file} ${reason}; kept as ${kept}; starting from the demo seed`);
  }

  function load() {
    if (file && existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (isValidState(parsed)) return parsed;
        quarantine('is not a Hearth state file');
      } catch (err) {
        quarantine(`could not be read (${err.message})`);
      }
    }
    const fresh = seed();
    persist(fresh);
    return fresh;
  }

  function notify() {
    for (const fn of listeners) {
      try { fn(state); } catch (err) { console.error('[store] listener failed', err); }
    }
  }

  return {
    getState: () => state,
    // fn receives a deep clone; it may mutate it in place or return a new state.
    mutate(fn) {
      const draft = structuredClone(state);
      const result = fn(draft);
      const next = result === undefined ? draft : result;
      next.updatedAt = new Date().toISOString();
      persist(next); // write first: if the disk refuses, memory and file stay in agreement
      state = next;
      notify();
      return state;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    reset() {
      const fresh = seed();
      persist(fresh);
      state = fresh;
      notify();
      return state;
    },
    flush: () => persist(state),
  };
}
