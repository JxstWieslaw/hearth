// Hand-rolled validators. Each returns { ok: true, value } or { ok: false, message }.
// Messages are plain English because they are shown to family members in a toast.

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const CHORE_STATUSES = ['todo', 'done'];
export const SHOPPING_STATUSES = ['needed', 'bought'];

export function str(v, { min = 0, max = Infinity, label = 'Text' } = {}) {
  if (typeof v !== 'string') return { ok: false, message: `${label} must be text.` };
  const value = v.trim();
  if (value.length < min) {
    return { ok: false, message: min === 1 ? `${label} is required.` : `${label} must be at least ${min} characters.` };
  }
  if (value.length > max) return { ok: false, message: `${label} must be ${max} characters or fewer.` };
  return { ok: true, value };
}

export function oneOf(v, allowed, { label = 'Value' } = {}) {
  if (!allowed.includes(v)) return { ok: false, message: `${label} must be one of: ${allowed.join(', ')}.` };
  return { ok: true, value: v };
}

export function int(v, { min = -Infinity, max = Infinity, label = 'Number' } = {}) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n)) return { ok: false, message: `${label} must be a whole number.` };
  if (n < min || n > max) return { ok: false, message: `${label} must be between ${min} and ${max}.` };
  return { ok: true, value: n };
}

function memberId(v, memberIds, label) {
  if (typeof v !== 'string' || !memberIds.includes(v)) {
    return { ok: false, message: `${label} must be a member of the household.` };
  }
  return { ok: true, value: v };
}

function isObject(body) {
  return body !== null && typeof body === 'object' && !Array.isArray(body);
}

export function choreCreate(body, memberIds) {
  if (!isObject(body)) return { ok: false, message: 'Send a JSON object.' };
  const title = str(body.title, { min: 1, max: 60, label: 'Title' });
  if (!title.ok) return title;
  const assignee = memberId(body.assigneeId, memberIds, 'Assignee');
  if (!assignee.ok) return assignee;
  const points = int(body.points, { min: 1, max: 10, label: 'Points' });
  if (!points.ok) return points;
  const dueDay = oneOf(body.dueDay, DAYS, { label: 'Day' });
  if (!dueDay.ok) return dueDay;
  return { ok: true, value: { title: title.value, assigneeId: assignee.value, points: points.value, dueDay: dueDay.value } };
}

export function chorePatch(body, memberIds) {
  if (!isObject(body)) return { ok: false, message: 'Send a JSON object.' };
  const actor = memberId(body.actorId, memberIds, 'Actor');
  if (!actor.ok) return actor;
  const value = { actorId: actor.value };
  if (body.status !== undefined) {
    const status = oneOf(body.status, CHORE_STATUSES, { label: 'Status' });
    if (!status.ok) return status;
    value.status = status.value;
  }
  if (body.assigneeId !== undefined) {
    const assignee = memberId(body.assigneeId, memberIds, 'Assignee');
    if (!assignee.ok) return assignee;
    value.assigneeId = assignee.value;
  }
  if (value.status === undefined && value.assigneeId === undefined) {
    return { ok: false, message: 'Nothing to change: send a status or an assignee.' };
  }
  return { ok: true, value };
}

export function shoppingCreate(body, memberIds) {
  if (!isObject(body)) return { ok: false, message: 'Send a JSON object.' };
  const name = str(body.name, { min: 1, max: 60, label: 'Item name' });
  if (!name.ok) return name;
  const actor = memberId(body.actorId, memberIds, 'Actor');
  if (!actor.ok) return actor;
  let qty = null;
  if (body.qty !== undefined && body.qty !== null) {
    const q = str(body.qty, { min: 0, max: 20, label: 'Quantity' });
    if (!q.ok) return q;
    qty = q.value === '' ? null : q.value;
  }
  return { ok: true, value: { name: name.value, qty, actorId: actor.value } };
}

export function shoppingPatch(body, memberIds) {
  if (!isObject(body)) return { ok: false, message: 'Send a JSON object.' };
  const actor = memberId(body.actorId, memberIds, 'Actor');
  if (!actor.ok) return actor;
  const status = oneOf(body.status, SHOPPING_STATUSES, { label: 'Status' });
  if (!status.ok) return status;
  return { ok: true, value: { status: status.value, actorId: actor.value } };
}
