import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originalUrl } from '../api/hearth.mjs';

test('the Vercel rewrite is undone before routing', () => {
  assert.equal(originalUrl('/api/hearth?path=state'), '/api/state');
  assert.equal(originalUrl('/api/hearth?path=chores/rotate'), '/api/chores/rotate');
  assert.equal(originalUrl('/api/hearth?path=chores%2Fabc-123'), '/api/chores/abc-123');
  assert.equal(originalUrl('/api/hearth?path=shopping&x=1'), '/api/shopping?x=1');
  assert.equal(originalUrl('/api/chores/rotate'), '/api/chores/rotate');
});
