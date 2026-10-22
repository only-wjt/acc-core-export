import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuth } from '../server/auth.js';

async function tempFile() {
  return join(await mkdtemp(join(tmpdir(), 'acc-auth-')), 'users.json');
}

test('loopback can start without a password', async () => {
  const auth = createAuth({ password: '', bindHost: '127.0.0.1', file: await tempFile() });
  assert.equal(auth.enabled, false);
  assert.equal(auth.authorized({ headers: {} }), true);
  assert.equal(auth.currentUser({ headers: {} }).role, 'admin');
});

test('non-loopback bind requires an admin account', async () => {
  assert.throws(() => createAuth({ password: '', bindHost: '0.0.0.0', file: join(tmpdir(), 'missing-users.json') }), /WORKBENCH_PASSWORD/);
});

test('admin and regular users see isolated identities', async () => {
  const auth = createAuth({ password: 'admin-secret', adminUsername: 'admin', bindHost: '0.0.0.0', file: await tempFile() });
  assert.equal(auth.login({ username: 'admin', password: 'wrong' }).ok, false);
  const admin = auth.login({ username: 'admin', password: 'admin-secret' });
  assert.equal(admin.ok, true);
  assert.equal(admin.user.role, 'admin');
  const created = auth.createUser({ username: 'alice', password: 'alice-pass', role: 'user' });
  assert.equal(created.ok, true);
  const alice = auth.login({ username: 'alice', password: 'alice-pass' });
  assert.equal(alice.user.role, 'user');
  assert.equal(auth.currentUser({ headers: { cookie: `acc_session=${alice.token}` } }).username, 'alice');
  assert.equal(auth.listUsers().length, 2);
});

test('concurrency is per user: admin at the ceiling, new users at 1', async () => {
  const auth = createAuth({ password: 'admin-secret', adminUsername: 'admin', bindHost: '0.0.0.0', file: await tempFile() });
  assert.equal(auth.concurrencyFor('admin'), auth.concurrencyLimit);
  assert.equal(auth.createUser({ username: 'bob', password: 'bob-pass' }).user.concurrency, 1);
  assert.equal(auth.createUser({ username: 'cara', password: 'cara-pass', concurrency: 999 }).user.concurrency, auth.concurrencyLimit);
  assert.equal(auth.createUser({ username: 'dan', password: 'dan-pass', concurrency: 0 }).ok, false);
  assert.equal(auth.updateUser('bob', { concurrency: 4 }).user.concurrency, 4);
  assert.equal(auth.concurrencyFor('bob'), 4);
  assert.equal(auth.updateUser('nobody', { concurrency: 2 }).ok, false);
});

test('user api rate cannot exceed the admin ceiling', async () => {
  const auth = createAuth({
    password: 'admin-secret',
    adminUsername: 'admin',
    bindHost: '0.0.0.0',
    file: await tempFile(),
    getRateCeiling: () => 60,
  });
  auth.createUser({ username: 'eve', password: 'eve-pass' });
  assert.equal(auth.rateLimitFor('eve'), 60);
  assert.equal(auth.updateUser('eve', { apiRateLimit: 20 }).user.apiRateLimit, 20);
  assert.equal(auth.rateLimitFor('eve'), 20);
  assert.equal(auth.updateUser('eve', { apiRateLimit: 80 }).ok, false);
  assert.equal(auth.updateUser('eve', { apiRateLimit: 0 }).ok, false);
  assert.equal(auth.updateUser('admin', { apiRateLimit: 200 }).ok, true);
  assert.equal(auth.rateLimitFor('admin'), 200);
});

test('public auth paths stay reachable before login', async () => {
  const auth = createAuth({ password: 'secret', bindHost: '0.0.0.0', file: await tempFile() });
  assert.equal(auth.isPublicPath('/api/meta'), true);
  assert.equal(auth.isPublicPath('/api/auth/login'), true);
  assert.equal(auth.isPublicPath('/api/jobs'), false);
});

test('repeated failures lock the account out, even with the right password', async () => {
  const auth = createAuth({ password: 'admin-secret', adminUsername: 'admin', bindHost: '0.0.0.0', file: await tempFile() });
  for (let i = 0; i < 5; i++) {
    assert.equal(auth.login({ username: 'admin', password: 'wrong', ip: '10.0.0.1' }).ok, false);
  }
  const locked = auth.login({ username: 'admin', password: 'admin-secret', ip: '10.0.0.1' });
  assert.equal(locked.ok, false);
  assert.equal(locked.locked, true);
  assert.ok(locked.retryAfterMs > 0);
});

test('failures from one source do not lock a different user out', async () => {
  const auth = createAuth({ password: 'admin-secret', adminUsername: 'admin', bindHost: '0.0.0.0', file: await tempFile() });
  auth.createUser({ username: 'alice', password: 'alice-pass' });
  for (let i = 0; i < 4; i++) auth.login({ username: 'nobody', password: 'x', ip: '10.0.0.2' });
  assert.equal(auth.login({ username: 'alice', password: 'alice-pass', ip: '10.0.0.3' }).ok, true);
});

test('a successful login clears the failure counter', async () => {
  const auth = createAuth({ password: 'admin-secret', adminUsername: 'admin', bindHost: '0.0.0.0', file: await tempFile() });
  for (let i = 0; i < 4; i++) auth.login({ username: 'admin', password: 'wrong', ip: '10.0.0.4' });
  assert.equal(auth.login({ username: 'admin', password: 'admin-secret', ip: '10.0.0.4' }).ok, true);
  // 清零后再错 4 次仍不应该锁
  for (let i = 0; i < 4; i++) auth.login({ username: 'admin', password: 'wrong', ip: '10.0.0.4' });
  assert.equal(auth.login({ username: 'admin', password: 'admin-secret', ip: '10.0.0.4' }).ok, true);
});

test('unknown usernames fail the same way as wrong passwords', async () => {
  const auth = createAuth({ password: 'admin-secret', adminUsername: 'admin', bindHost: '0.0.0.0', file: await tempFile() });
  const ghost = auth.login({ username: 'does-not-exist', password: 'x', ip: '10.0.0.5' });
  const wrong = auth.login({ username: 'admin', password: 'x', ip: '10.0.0.5' });
  assert.equal(ghost.ok, false);
  assert.equal(wrong.ok, false);
  assert.equal(ghost.error, wrong.error);
});
