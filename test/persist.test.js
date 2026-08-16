import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/persist.js';

test('disabled store writes nothing', async () => {
  const store = createStore({ dir: '' });
  assert.equal(store.enabled, false);
  assert.equal(await store.saveJob('session', { id: 'x' }), null);
  assert.deepEqual(await store.listRecent(), []);
});

test('saves a job summary without passwords and lists it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acc-persist-'));
  const store = createStore({ dir, now: () => Date.parse('2026-08-15T00:00:00Z') });
  const file = await store.saveJob('session', {
    id: '11111111-2222-3333-4444-555555555555',
    status: 'completed',
    createdAt: Date.parse('2026-08-15T00:00:00Z'),
    finishedAt: Date.parse('2026-08-15T00:01:00Z'),
    counts: { total: 1, success: 1 },
    sessions: ['{"accessToken":"x"}'],
    items: [{ email: 'a@example.com', status: 'success', subscriptionInfo: { plan: 'plus' }, gptPassword: 'should-not-write' }],
  });
  assert.ok(file);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.kind, 'session');
  assert.equal(saved.items[0].plan, 'plus');
  assert.doesNotMatch(JSON.stringify(saved), /should-not-write/);
  const recent = await store.listRecent();
  assert.equal(recent.length, 1);
  assert.equal(recent[0].id, '11111111-2222-3333-4444-555555555555');
});

test('regular users only list their own jobs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acc-persist-'));
  const store = createStore({ dir, now: () => Date.parse('2026-08-15T00:00:00Z') });
  await store.saveJob('session', { id: 'aaaaaaaa-1111-1111-1111-111111111111', status: 'completed', counts: {} }, { owner: 'alice' });
  await store.saveJob('session', { id: 'bbbbbbbb-2222-2222-2222-222222222222', status: 'completed', counts: {} }, { owner: 'bob' });
  const alice = await store.listRecent(20, { owner: 'alice', isAdmin: false });
  const admin = await store.listRecent(20, { owner: 'admin', isAdmin: true });
  assert.deepEqual(alice.map((item) => item.owner), ['alice']);
  assert.equal(admin.length, 2);
});
