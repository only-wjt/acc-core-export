import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiKeys } from '../server/api-keys.js';

async function tempFile() {
  return join(await mkdtemp(join(tmpdir(), 'acc-keys-')), 'api-keys.json');
}

const alice = { username: 'alice', role: 'user', concurrency: 2 };
const bob = { username: 'bob', role: 'user', concurrency: 1 };
const admin = { username: 'admin', role: 'admin', concurrency: 20 };

test('no keys means open API is disabled', async () => {
  const keys = createApiKeys({ file: await tempFile(), envKey: '' });
  assert.equal(keys.enabled, false);
  assert.equal(keys.authenticate({ headers: {} }), null);
});

test('OPENAPI_KEY bootstraps a usable secret owned by admin', async () => {
  const file = await tempFile();
  const keys = createApiKeys({ file, envKey: 'acc_env_secret_value' });
  assert.equal(keys.enabled, true);
  const hit = keys.authenticate({ headers: { authorization: 'Bearer acc_env_secret_value' } });
  assert.equal(hit.name, 'OPENAPI_KEY');
  assert.equal(hit.username, 'admin');
  assert.equal(hit.owner, 'apikey:env');
  assert.equal(keys.authenticate({ headers: { 'x-api-key': 'wrong' } }), null);
});

test('each user creates and only sees their own keys', async () => {
  const keys = createApiKeys({ file: await tempFile(), envKey: '' });
  const first = keys.create({ name: 'cdk', actor: alice });
  assert.equal(first.ok, true);
  assert.equal(first.item.owner, 'alice');
  assert.equal(first.item.concurrency, 2);
  assert.equal(keys.create({ name: 'cdk', actor: alice }).ok, false);
  assert.equal(keys.create({ name: 'cdk', actor: bob }).ok, true);
  assert.equal(keys.list(alice).length, 1);
  assert.equal(keys.list(bob).length, 1);
  assert.equal(keys.list(admin).length, 2);
  assert.equal(keys.revoke(first.item.id, bob).ok, false);
  assert.equal(keys.revoke(first.item.id, alice).ok, true);
});

test('key count is capped per user', async () => {
  const keys = createApiKeys({
    file: await tempFile(),
    envKey: '',
    getLimits: () => ({ maxKeysPerUser: 2, rateLimitPerMinute: 60 }),
  });
  assert.equal(keys.create({ name: 'one', actor: alice }).ok, true);
  assert.equal(keys.create({ name: 'two', actor: alice }).ok, true);
  const third = keys.create({ name: 'three', actor: alice });
  assert.equal(third.ok, false);
  assert.match(third.error, /最多 2/);
  assert.equal(keys.create({ name: 'one', actor: bob }).ok, true);
});

test('rate limit uses the user cap and cannot exceed the admin ceiling', async () => {
  const keys = createApiKeys({
    file: await tempFile(),
    envKey: '',
    getLimits: () => ({ maxKeysPerUser: 3, rateLimitPerMinute: 60 }),
    getUserRateLimit: () => 2,
  });
  const created = keys.create({ name: 'cdk', actor: alice });
  const identity = { username: 'alice', id: created.item.id };
  assert.equal(keys.consume(identity).ok, true);
  assert.equal(keys.consume(identity).ok, true);
  const blocked = keys.consume(identity);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.limit, 2);
  assert.equal(blocked.ceiling, 60);
});
