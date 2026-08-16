import test from 'node:test';
import assert from 'node:assert/strict';
import { createCheckManager, parseSessionInputs } from '../server/batch-check.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDone(manager, id) {
  for (let i = 0; i < 100; i++) {
    const job = manager.get(id);
    if (job?.status !== 'running') return job;
    await wait(5);
  }
  throw new Error('任务测试超时');
}

test('parseSessionInputs accepts email----token and bare tokens', () => {
  const result = parseSessionInputs('a@example.com----eyJaaaaaaaaaaaaaaaaaaaa\neyJbbbbbbbbbbbbbbbbbbbb');
  assert.equal(result.errors.length, 0);
  assert.equal(result.accounts.length, 2);
  assert.equal(result.accounts[0].email, 'a@example.com');
  assert.equal(result.accounts[1].email, '');
});

test('check manager reports alive and dead rows without leaking tokens', async () => {
  const manager = createCheckManager({
    checkAlive: async (account) => {
      if (String(account.sessionToken).includes('dead')) {
        return { alive: false, reason: 'token_expired', error: 'token已过期' };
      }
      return { alive: true, reason: 'ok', plan: 'plus', accountId: 'acc_1' };
    },
  });

  const created = manager.create({
    input: 'ok@example.com----eyJaaaaaaaaaaaaaaaaalive\nbad@example.com----eyJbbbbbbbbbbbbbbbbdead',
    concurrency: 2,
  });
  const job = await waitForDone(manager, created.job.id);
  assert.equal(job.counts.alive, 1);
  assert.equal(job.counts.dead, 1);
  assert.equal(job.items[0].plan, 'plus');
  assert.equal(job.items[1].reason, 'token_expired');
  assert.equal(job.items[1].canRetry, true);
  assert.doesNotMatch(JSON.stringify(job), /eyJ/);
});

test('retry reruns only dead accounts', async () => {
  let deadAttempts = 0;
  const manager = createCheckManager({
    checkAlive: async (account) => {
      if (String(account.sessionToken).includes('dead')) {
        deadAttempts++;
        if (deadAttempts === 1) return { alive: false, reason: 'network', error: 'timeout' };
      }
      return { alive: true, reason: 'ok', plan: 'free' };
    },
  });

  const created = manager.create({
    input: 'ok@example.com----eyJaaaaaaaaaaaaaaaaalive\nbad@example.com----eyJbbbbbbbbbbbbbbbbdead',
  });
  await waitForDone(manager, created.job.id);
  const retried = manager.retry(created.job.id, { failed: true });
  assert.equal(retried.ok, true);
  const after = await waitForDone(manager, created.job.id);
  assert.equal(after.counts.alive, 2);
  assert.equal(after.items[1].retryCount, 1);
});

test('retry({ indexes }) reruns only selected dead rows', async () => {
  const attempts = [];
  const manager = createCheckManager({
    checkAlive: async (account) => {
      attempts.push(account.email);
      if (String(account.sessionToken).includes('dead')) {
        return { alive: false, reason: 'token_expired' };
      }
      return { alive: true, reason: 'ok', plan: 'plus' };
    },
  });

  const created = manager.create({
    input: [
      'ok@example.com----eyJaaaaaaaaaaaaaaaaalive',
      'dead1@example.com----eyJbbbbbbbbbbbbbbbbdead1',
      'dead2@example.com----eyJccccccccccccccccdead2',
    ].join('\n'),
  });
  await waitForDone(manager, created.job.id);
  attempts.length = 0;

  const retried = manager.retry(created.job.id, { indexes: [0, 2] });
  assert.equal(retried.ok, true);
  const after = await waitForDone(manager, created.job.id);
  assert.equal(after.items[0].retryCount || 0, 0);
  assert.equal(after.items[1].retryCount || 0, 0);
  assert.equal(after.items[2].retryCount, 1);
  assert.deepEqual(attempts, ['dead2@example.com']);

  const none = manager.retry(created.job.id, { indexes: [0] });
  assert.equal(none.ok, false);
  assert.equal(none.status, 400);
  assert.equal(none.error, '没有可重试的账号');
});
