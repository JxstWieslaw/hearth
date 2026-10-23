// Hearth frontend: load state once, then re-render everything from each SSE "state" event.

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const ACTOR_KEY = 'hearth.actor';

const $ = (sel) => document.querySelector(sel);
const els = {
  live: $('#live'),
  liveLabel: $('#live-label'),
  members: $('#members'),
  whoHint: $('#who-hint'),
  chores: $('#chores'),
  choresSub: $('#chores-sub'),
  choreForm: $('#chore-form'),
  choreAssignee: $('#chore-assignee'),
  choreDay: $('#chore-day'),
  rotate: $('#rotate'),
  shopping: $('#shopping'),
  shoppingForm: $('#shopping-form'),
  fairness: $('#fairness'),
  toasts: $('#toasts'),
};

let state = null;
let actorId = loadActor();
const busy = new Set();

function loadActor() {
  try { return localStorage.getItem(ACTOR_KEY); } catch { return null; }
}
function saveActor(id) {
  try {
    if (id) localStorage.setItem(ACTOR_KEY, id);
    else localStorage.removeItem(ACTOR_KEY);
  } catch { /* private mode: selection lives for this page only */ }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const member = (id) => state?.members.find((m) => m.id === id) || null;
const todayName = () => DAYS[(new Date().getDay() + 6) % 7];

function memberChip(id, extra = '') {
  const m = member(id);
  if (!m) return '<span class="chip chip--sm">Unassigned</span>';
  return `<span class="chip chip--sm ${extra}" style="--c:${esc(m.color)}"><span class="chip__emoji" aria-hidden="true">${esc(m.emoji)}</span>${esc(m.name)}</span>`;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    // Every change is sent as JSON, even when it has no fields: the server requires it, which
    // forces browsers to preflight cross-site attempts and keeps the no-login board safe.
    headers: method === 'GET' ? undefined : { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message || `The server replied with ${res.status}.`);
  return data;
}

function toast(message, kind = 'error') {
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.textContent = message;
  els.toasts.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function requireActor() {
  if (actorId && member(actorId)) return actorId;
  toast('Pick who you are first');
  return null;
}

async function act(key, button, fn) {
  if (busy.has(key)) return;
  busy.add(key);
  if (button) button.disabled = true;
  try {
    await fn();
  } catch (err) {
    toast(err.message || 'Something went wrong.');
  } finally {
    busy.delete(key);
    if (button) button.disabled = false;
    // The SSE state event usually arrives before the HTTP reply, so the fresh button was drawn
    // disabled while this key was still busy. Re-render now that it is free.
    if (state) render();
  }
}

/* Rendering */

function render() {
  if (!state) return;
  if (actorId && !member(actorId)) { actorId = null; saveActor(null); }
  renderMembers();
  renderChores();
  renderShopping();
  renderFairness();
}

function renderMembers() {
  els.members.innerHTML = state.members.map((m) => `
    <button type="button" class="chip" data-member="${esc(m.id)}" aria-pressed="${m.id === actorId}" style="--c:${esc(m.color)}">
      <span class="chip__emoji" aria-hidden="true">${esc(m.emoji)}</span>${esc(m.name)}
    </button>`).join('');
  const me = member(actorId);
  els.whoHint.textContent = me ? `Ticking things off as ${me.name}${me.label !== me.name ? ` (${me.label})` : ''}` : 'Pick who you are to tick things off';

  const options = state.members.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
  if (els.choreAssignee.innerHTML !== options) {
    const prev = els.choreAssignee.value;
    els.choreAssignee.innerHTML = options;
    els.choreAssignee.value = member(prev) ? prev : (actorId || state.members[0].id);
  }
  if (!els.choreDay.children.length) {
    els.choreDay.innerHTML = DAYS.map((d) => `<option value="${d}">${d}</option>`).join('');
    els.choreDay.value = todayName();
  }
}

function renderChores() {
  const chores = state.chores;
  const done = chores.filter((c) => c.status === 'done').length;
  els.choresSub.textContent = chores.length ? `${done} of ${chores.length} done` : '';
  els.rotate.disabled = busy.has('rotate') || chores.every((c) => c.status !== 'todo');

  if (!chores.length) {
    els.chores.innerHTML = '<p class="empty">Nothing on the board. Enjoy the quiet.</p>';
    return;
  }
  const today = todayName();
  els.chores.innerHTML = DAYS.map((day) => {
    const rows = chores.filter((c) => c.dueDay === day);
    if (!rows.length) return '';
    return `
      <section class="day ${day === today ? 'is-today' : ''}">
        <h3 class="day__name">${day}</h3>
        <ul class="rows">${rows.map(choreRow).join('')}</ul>
      </section>`;
  }).join('');
}

function choreRow(c) {
  const isDone = c.status === 'done';
  const key = `chore:${c.id}`;
  const credit = isDone && c.doneBy && c.doneBy !== c.assigneeId ? ` <span class="item__by">done by ${esc(member(c.doneBy)?.name || 'someone')}</span>` : '';
  return `
    <li class="chore ${isDone ? 'is-done' : ''}">
      <div class="chore__main">
        <span class="chore__title">${esc(c.title)}</span>
        ${memberChip(c.assigneeId)}${credit}
      </div>
      <span class="pts" aria-label="${c.points} points">${c.points} pt${c.points === 1 ? '' : 's'}</span>
      <div class="chore__actions">
        <button type="button" class="btn btn--sm ${isDone ? 'btn--undo' : 'btn--done'}" data-toggle="${esc(c.id)}" ${busy.has(key) ? 'disabled' : ''}>${isDone ? 'Undo' : 'Done'}</button>
        <button type="button" class="btn--icon" data-remove-chore="${esc(c.id)}" aria-label="Remove ${esc(c.title)}" title="Remove">×</button>
      </div>
    </li>`;
}

function renderShopping() {
  const needed = state.shopping.filter((i) => i.status === 'needed');
  const bought = state.shopping.filter((i) => i.status === 'bought');
  const row = (i) => `
    <li class="item ${i.status === 'bought' ? 'is-bought' : ''}">
      <div>
        <span class="item__name">${esc(i.name)}</span>${i.qty ? `<span class="item__qty">${esc(i.qty)}</span>` : ''}
        <span class="item__by">${i.status === 'bought' ? `got by ${esc(member(i.boughtBy)?.name || 'someone')}` : `added by ${esc(member(i.addedBy)?.name || 'someone')}`}</span>
      </div>
      <button type="button" class="btn btn--sm ${i.status === 'bought' ? 'btn--undo' : 'btn--done'}" data-item="${esc(i.id)}" data-next="${i.status === 'bought' ? 'needed' : 'bought'}" ${busy.has(`item:${i.id}`) ? 'disabled' : ''}>${i.status === 'bought' ? 'Undo' : 'Got it'}</button>
      <button type="button" class="btn--icon" data-remove-item="${esc(i.id)}" aria-label="Remove ${esc(i.name)}" title="Remove">×</button>
    </li>`;

  const open = els.shopping.querySelector('details')?.open ?? false;
  els.shopping.innerHTML = `
    ${needed.length ? `<ul class="rows">${needed.map(row).join('')}</ul>` : '<p class="empty">Cupboards are full. Nothing needed.</p>'}
    ${bought.length ? `<details class="bought" ${open ? 'open' : ''}><summary>Bought this week (${bought.length})</summary><ul class="rows">${bought.map(row).join('')}</ul></details>` : ''}`;
}

function renderFairness() {
  const points = state.week.points;
  const max = Math.max(0, ...Object.values(points));
  const leaders = max > 0 ? state.members.filter((m) => points[m.id] === max) : [];
  const idle = state.members.filter((m) => points[m.id] === 0);

  let nudge;
  if (max === 0) nudge = 'A fresh week. Nobody has scored yet.';
  else if (idle.length) nudge = `${listNames(idle.map((m) => m.name))} could use a hand to get going.`;
  else if (state.week.fairness >= 0.75) nudge = 'Nicely shared. Keep it up, everyone.';
  else nudge = `${listNames(leaders.map((m) => m.name))} ${leaders.length > 1 ? 'are' : 'is'} carrying a lot this week.`;

  els.fairness.innerHTML = `
    <div class="score">
      <span class="score__num">${state.week.fairness.toFixed(2)}</span>
      <span class="score__how">lowest ÷ highest points this week</span>
    </div>
    <p class="nudge">${esc(nudge)}</p>
    <div class="bars">${state.members.map((m) => {
      const p = points[m.id] || 0;
      const width = max ? Math.round((p / max) * 100) : 0;
      return `
        <div class="bar ${p === 0 ? 'is-zero' : ''}" style="--c:${esc(m.color)}">
          <div class="bar__row">
            <span class="bar__name"><span aria-hidden="true">${esc(m.emoji)}</span>${esc(m.name)}${leaders.some((l) => l.id === m.id) ? ' <span class="bar__lead">Leading</span>' : ''}</span>
            <span class="bar__pts">${p} pt${p === 1 ? '' : 's'}</span>
          </div>
          <div class="bar__track" role="img" aria-label="${esc(m.name)}: ${p} points"><div class="bar__fill" style="width:${width}%"></div></div>
        </div>`;
    }).join('')}</div>`;
}

function listNames(names) {
  if (names.length <= 1) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/* Events */

els.members.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-member]');
  if (!btn) return;
  actorId = btn.dataset.member === actorId ? null : btn.dataset.member;
  saveActor(actorId);
  render();
});

els.chores.addEventListener('click', (e) => {
  const toggle = e.target.closest('[data-toggle]');
  if (toggle) {
    const actor = requireActor();
    if (!actor) return;
    const chore = state.chores.find((c) => c.id === toggle.dataset.toggle);
    const next = chore?.status === 'done' ? 'todo' : 'done';
    return act(`chore:${chore.id}`, toggle, () => api('PATCH', `/api/chores/${chore.id}`, { status: next, actorId: actor }));
  }
  const remove = e.target.closest('[data-remove-chore]');
  if (remove) {
    if (!requireActor()) return;
    const id = remove.dataset.removeChore;
    return act(`remove:${id}`, remove, () => api('DELETE', `/api/chores/${id}`));
  }
});

els.shopping.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-item]');
  if (btn) {
    const actor = requireActor();
    if (!actor) return;
    const id = btn.dataset.item;
    return act(`item:${id}`, btn, () => api('PATCH', `/api/shopping/${id}`, { status: btn.dataset.next, actorId: actor }));
  }
  const remove = e.target.closest('[data-remove-item]');
  if (remove) {
    if (!requireActor()) return;
    const id = remove.dataset.removeItem;
    return act(`remove:${id}`, remove, () => api('DELETE', `/api/shopping/${id}`));
  }
});

els.rotate.addEventListener('click', () => {
  if (!requireActor()) return;
  if (!window.confirm("Rotate fairly? Open chores move to whoever has done the least this week.")) return;
  act('rotate', els.rotate, async () => {
    await api('POST', '/api/chores/rotate');
    toast('Chores rotated', 'info');
  });
});

els.choreForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!requireActor()) return;
  const form = new FormData(els.choreForm);
  const payload = {
    title: form.get('title'),
    assigneeId: form.get('assigneeId'),
    points: Number(form.get('points')),
    dueDay: form.get('dueDay'),
  };
  act('chore-form', $('#chore-submit'), async () => {
    await api('POST', '/api/chores', payload);
    els.choreForm.querySelector('[name=title]').value = '';
    els.choreForm.querySelector('[name=title]').focus();
  });
});

els.shoppingForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const actor = requireActor();
  if (!actor) return;
  const form = new FormData(els.shoppingForm);
  const payload = { name: form.get('name'), qty: form.get('qty') || undefined, actorId: actor };
  act('shopping-form', $('#shopping-submit'), async () => {
    await api('POST', '/api/shopping', payload);
    els.shoppingForm.reset();
    els.shoppingForm.querySelector('[name=name]').focus();
  });
});

/* Live stream */

function setLive(status) {
  els.live.className = `live is-${status}`;
  els.liveLabel.textContent = status === 'live' ? 'Live' : status === 'connecting' ? 'Connecting…' : 'Reconnecting…';
}

function connect() {
  const source = new EventSource('/api/events');
  source.addEventListener('open', () => setLive('live'));
  source.addEventListener('error', () => {
    setLive('reconnecting');
    // EventSource retries dropped connections itself, but gives up for good on an HTTP error.
    if (source.readyState === EventSource.CLOSED) setTimeout(connect, 3000);
  });
  source.addEventListener('state', (event) => {
    try {
      state = JSON.parse(event.data);
      render();
    } catch {
      toast('Could not read the latest board. Refresh to retry.');
    }
  });
}

// On the public internet (not localhost or a home-network address), say plainly that it is a demo.
if (!/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/.test(location.hostname)) {
  document.getElementById('demo-note').hidden = false;
}

api('GET', '/api/state')
  .then((s) => { state = s; render(); })
  .catch((err) => toast(err.message))
  .finally(connect);
