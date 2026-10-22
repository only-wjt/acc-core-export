import test from 'node:test';
import assert from 'node:assert/strict';
import { createBatchManager, parseAccounts, parseProxyPool } from '../server/batch-session.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDone(manager, id) {
  for (let i = 0; i < 100; i++) {
    const job = manager.get(id);
    if (job?.status !== 'running') return job;
    await wait(5);
  }
  throw new Error('任务测试超时');
}

async function waitForBilling(manager, id) {
  for (let i = 0; i < 100; i++) {
    const job = manager.get(id);
    if (job && !job.items.some((item) => item.billingStatus === 'running')) return job;
    await wait(5);
  }
  throw new Error('套餐操作测试超时');
}

test('parseAccounts accepts email:password and passwords containing colons', () => {
  const result = parseAccounts('a@example.com:mail:a\r\n\r\nb@example.com:mail-b');
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.accounts.map((item) => [item.email, item.mailPassword]), [
    ['a@example.com', 'mail:a'],
    ['b@example.com', 'mail-b'],
  ]);
});

test('parseAccounts reports malformed and duplicate rows', () => {
  const result = parseAccounts(['broken-row', 'a@example.com:mail', 'A@example.com:mail2'].join('\n'));
  assert.equal(result.accounts.length, 1);
  assert.deepEqual(result.errors.map((item) => item.message), ['格式应为：邮箱----GPT密码----邮箱密码 或 邮箱:邮箱密码', '邮箱重复']);
});

test('parseProxyPool normalizes socks links, strips fragments, and deduplicates', () => {
  const result = parseProxyPool([
    'socks://user@host.example:1080#remark',
    'socks5://user@host.example:1080',
    'http://u:p@proxy.example:8080',
  ].join('\n'));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.proxies, [
    'socks5://user@host.example:1080',
    'http://u:p@proxy.example:8080',
  ]);
});

test('manager uses empty GPT password, fixed assigned proxy, and preserves session order', async () => {
  const calls = [];
  const manager = createBatchManager({
    waitForOTP: async (email, password, options) => {
      calls.push({ type: 'otp', email, password, proxy: options.proxy });
      return '123456';
    },
    getAccessToken: async (token) => ({ accessToken: `access-${token}`, sessionJson: JSON.stringify({ accessToken: `access-${token}` }) }),
    getSubscriptionInfo: async ({ email }) => ({ plan: email.startsWith('first') ? 'plus' : 'free', active: email.startsWith('first') }),
    login: async (account, options) => {
      calls.push({ type: 'login', email: account.email, password: options.password, proxy: options.proxy });
      await options.getOtp();
      if (account.email.startsWith('bad')) throw new Error('bad password 123456 cookie=secret');
      await wait(account.email.startsWith('first') ? 15 : 1);
      return { sessionToken: `session-${account.email}` };
    },
  });

  const created = manager.create({
    concurrency: 2,
    proxies: 'socks://user@proxy.example:1080#label',
    input: ['first@example.com:mail1', 'bad@example.com:mail2', 'third@example.com:mail3'].join('\n'),
  });
  const job = await waitForDone(manager, created.job.id);

  assert.equal(job.counts.success, 2);
  assert.equal(job.items[0].subscriptionInfo, null);
  assert.equal(job.items[0].cancelRenewal, null);
  assert.deepEqual(job.sessions.map(JSON.parse).map((value) => value.accessToken), [
    'access-session-first@example.com',
    'access-session-third@example.com',
  ]);
  assert.ok(calls.filter((call) => call.type === 'login').every((call) => call.password === ''));
  for (const email of ['first@example.com', 'bad@example.com', 'third@example.com']) {
    const accountCalls = calls.filter((call) => call.email === email);
    assert.ok(accountCalls.every((call) => call.proxy === 'socks5://user@proxy.example:1080'));
  }
  assert.doesNotMatch(JSON.stringify(job.items.map(({ accountDisplay, ...item }) => item)), /mail1|mail2|mail3|user@proxy|cookie=secret/);
});

test('manager respects concurrency limit', async () => {
  let active = 0;
  let peak = 0;
  const manager = createBatchManager({
    waitForOTP: async () => '123456',
    getAccessToken: async (token) => ({ accessToken: `access-${token}`, sessionJson: JSON.stringify({ token }) }),
    login: async (account) => {
      active++;
      peak = Math.max(peak, active);
      await wait(15);
      active--;
      return { sessionToken: `session-${account.email}` };
    },
  });

  const input = Array.from({ length: 6 }, (_, index) => `user${index}@example.com:mail${index}`).join('\n');
  const created = manager.create({ input, concurrency: 2 });
  await waitForDone(manager, created.job.id);
  assert.equal(peak, 2);
});

test('cancel prevents pending work and discards running results', async () => {
  const manager = createBatchManager({
    waitForOTP: async () => '123456',
    getAccessToken: async (token) => ({ accessToken: `access-${token}`, sessionJson: JSON.stringify({ token }) }),
    login: async (account) => {
      await wait(30);
      return { sessionToken: `session-${account.email}` };
    },
  });

  const created = manager.create({ concurrency: 1, input: 'a@example.com:mail1\nb@example.com:mail2' });
  await wait(5);
  manager.cancel(created.job.id);
  const job = await waitForDone(manager, created.job.id);
  assert.equal(job.status, 'cancelled');
  assert.equal(job.counts.cancelled, 2);
  assert.deepEqual(job.sessions, []);
});

test('abort stops one running account without touching other successes', async () => {
  let allowSlow = false;
  const manager = createBatchManager({
    waitForOTP: async (_email, _password, options) => {
      for (let i = 0; i < 40; i++) {
        if (options.aborted?.()) return null;
        await wait(5);
      }
      return '123456';
    },
    getAccessToken: async (token) => ({ accessToken: `access-${token}`, sessionJson: JSON.stringify({ token }) }),
    login: async (account, options) => {
      if (account.email.startsWith('slow') && !allowSlow) {
        await options.getOtp();
        throw new Error('should have aborted');
      }
      return { sessionToken: `session-${account.email}` };
    },
  });

  const created = manager.create({
    concurrency: 2,
    input: 'ok@example.com:mail1\nslow@example.com:mail2',
  });
  await wait(8);
  const aborted = manager.abort(created.job.id, { index: 1 });
  assert.equal(aborted.ok, true);
  assert.equal(aborted.job.items[1].aborting, true);
  assert.equal(aborted.job.items[1].canAbort, false);

  const job = await waitForDone(manager, created.job.id);
  assert.equal(job.status, 'completed');
  assert.equal(job.items[0].status, 'success');
  assert.equal(job.items[1].status, 'cancelled');
  assert.equal(job.items[1].canRetry, true);
  assert.equal(job.sessions.length, 1);

  const successAbort = manager.abort(created.job.id, { index: 0 });
  assert.equal(successAbort.ok, false);
  assert.equal(successAbort.status, 409);

  allowSlow = true;
  const retried = manager.retry(created.job.id, { index: 1 });
  assert.equal(retried.ok, true);
  const after = await waitForDone(manager, created.job.id);
  assert.equal(after.items[1].status, 'success');
  assert.equal(after.items[1].retryCount, 1);
  assert.equal(after.sessions.length, 2);
});

test('retry reruns only the failed account, keeps proxy, and preserves other results', async () => {
  let failOnce = true;
  const proxiesUsed = [];
  const manager = createBatchManager({
    waitForOTP: async () => '123456',
    getAccessToken: async (token) => ({ accessToken: `access-${token}`, sessionJson: JSON.stringify({ token }) }),
    login: async (account, options) => {
      proxiesUsed.push({ email: account.email, proxy: options.proxy });
      if (account.email.startsWith('bad') && failOnce) {
        failOnce = false;
        throw new Error('temporary fail');
      }
      return { sessionToken: `session-${account.email}` };
    },
  });

  const created = manager.create({
    concurrency: 2,
    proxies: 'http://u:p@proxy.example:8080',
    input: 'ok@example.com:mail1\nbad@example.com:mail2',
  });
  const done = await waitForDone(manager, created.job.id);
  assert.equal(done.counts.success, 1);
  assert.equal(done.counts.failed, 1);
  assert.equal(done.items[1].canRetry, true);
  assert.equal(done.items[0].canRetry, true);
  assert.equal(done.items[1].error, 'temporary fail');

  const retried = manager.retry(created.job.id, { index: 1 });
  assert.equal(retried.ok, true);
  assert.ok(['pending', 'running'].includes(retried.job.items[1].status));
  assert.equal(retried.job.items[0].status, 'success');
  const after = await waitForDone(manager, created.job.id);
  assert.equal(after.status, 'completed');
  assert.equal(after.counts.success, 2);
  assert.equal(after.counts.failed, 0);
  assert.equal(after.items[1].retryCount, 1);
  assert.equal(after.items[0].status, 'success');
  assert.equal(after.sessions.length, 2);
  const badProxies = proxiesUsed.filter((call) => call.email === 'bad@example.com').map((call) => call.proxy);
  assert.deepEqual(badProxies, ['http://u:p@proxy.example:8080', 'http://u:p@proxy.example:8080']);
  assert.doesNotMatch(JSON.stringify(after.items.map(({ accountDisplay, ...item }) => item)), /mail1|mail2|u:p@proxy/);
});

test('retry is rejected for running accounts but allowed for successful ones', async () => {
  let logins = 0;
  const manager = createBatchManager({
    waitForOTP: async () => '123456',
    getAccessToken: async (token) => ({ accessToken: `access-${token}`, sessionJson: JSON.stringify({ token }) }),
    login: async (account) => {
      logins++;
      await wait(30);
      return { sessionToken: `session-${account.email}-${logins}` };
    },
  });

  const created = manager.create({ concurrency: 1, input: 'ok@example.com:mail1' });
  await wait(5);
  const running = manager.retry(created.job.id, { index: 0 });
  assert.equal(running.ok, false);
  assert.equal(running.status, 409);

  const done = await waitForDone(manager, created.job.id);
  assert.equal(done.items[0].status, 'success');
  assert.equal(done.items[0].canRetry, true);
  const firstSession = done.sessions[0];
  const successRetry = manager.retry(created.job.id, { index: 0 });
  assert.equal(successRetry.ok, true);
  const after = await waitForDone(manager, created.job.id);
  assert.equal(after.items[0].status, 'success');
  assert.equal(after.items[0].retryCount, 1);
  assert.ok(after.sessions[0]);
  assert.notEqual(after.sessions[0], firstSession);
  assert.equal(logins, 2);
});

test('retry({ indexes }) reruns only the selected accounts', async () => {
  const attempts = new Map();
  const manager = createBatchManager({
    waitForOTP: async () => '123456',
    getAccessToken: async (token) => ({ accessToken: `access-${token}`, sessionJson: JSON.stringify({ token }) }),
    login: async (account) => {
      const count = (attempts.get(account.email) || 0) + 1;
      attempts.set(account.email, count);
      if (account.email.startsWith('bad') && count === 1) throw new Error('fail');
      return { sessionToken: `session-${account.email}` };
    },
  });

  const created = manager.create({
    concurrency: 3,
    input: 'bad0@example.com:m0\nok@example.com:m1\nbad2@example.com:m2',
  });
  const done = await waitForDone(manager, created.job.id);
  assert.equal(done.items[0].status, 'failed');
  assert.equal(done.items[1].status, 'success');
  assert.equal(done.items[2].status, 'failed');

  const retried = manager.retry(created.job.id, { indexes: [0, 99, 2] });
  assert.equal(retried.ok, true);
  const after = await waitForDone(manager, created.job.id);
  assert.equal(after.items[0].status, 'success');
  assert.equal(after.items[0].retryCount, 1);
  assert.equal(after.items[1].status, 'success');
  assert.equal(after.items[1].retryCount || 0, 0);
  assert.equal(after.items[2].status, 'success');
  assert.equal(after.items[2].retryCount, 1);
  assert.equal(attempts.get('ok@example.com'), 1);

  const none = manager.retry(created.job.id, { indexes: [99] });
  assert.equal(none.ok, false);
  assert.equal(none.status, 400);
  assert.equal(none.error, '没有可重试的账号');
});

test('success row retry calls login again to re-fetch session', async () => {
  const logins = [];
  const manager = createBatchManager({
    waitForOTP: async () => '123456',
    getAccessToken: async (token) => ({ accessToken: `access-${token}`, sessionJson: JSON.stringify({ token }) }),
    login: async (account) => {
      logins.push(account.email);
      return { sessionToken: `session-${account.email}-${logins.length}` };
    },
  });

  const created = manager.create({ input: 'ok@example.com:mail1' });
  const done = await waitForDone(manager, created.job.id);
  assert.equal(done.items[0].status, 'success');
  assert.equal(done.items[0].canRetry, true);
  const firstSession = done.sessions[0];

  const retried = manager.retry(created.job.id, { index: 0 });
  assert.equal(retried.ok, true);
  const after = await waitForDone(manager, created.job.id);
  assert.equal(after.items[0].status, 'success');
  assert.equal(after.items[0].retryCount, 1);
  assert.deepEqual(logins, ['ok@example.com', 'ok@example.com']);
  assert.notEqual(after.sessions[0], firstSession);
  assert.doesNotMatch(JSON.stringify(after.items.map(({ accountDisplay, ...item }) => item)), /mail1|u:p@proxy/);
});

test('retry can run a failed row while other accounts are still processing', async () => {
  let badAttempts = 0;
  const manager = createBatchManager({
    waitForOTP: async () => '123456',
    getAccessToken: async (token) => ({ accessToken: `access-${token}`, sessionJson: JSON.stringify({ token }) }),
    login: async (account) => {
      if (account.email.startsWith('slow')) {
        await wait(40);
        return { sessionToken: `session-${account.email}` };
      }
      badAttempts++;
      if (badAttempts === 1) throw new Error('fail once');
      return { sessionToken: `session-${account.email}` };
    },
  });

  const created = manager.create({
    concurrency: 2,
    input: 'bad@example.com:m1\nslow@example.com:m2',
  });

  let snapshot;
  for (let i = 0; i < 50; i++) {
    snapshot = manager.get(created.job.id);
    if (snapshot.items[0].status === 'failed' && snapshot.items[1].status === 'running') break;
    await wait(5);
  }
  assert.equal(snapshot.items[0].status, 'failed');
  assert.equal(snapshot.items[1].status, 'running');

  const retried = manager.retry(created.job.id, { index: 0 });
  assert.equal(retried.ok, true);
  const after = await waitForDone(manager, created.job.id);
  assert.equal(after.counts.success, 2);
  assert.equal(after.items[0].retryCount, 1);
  assert.equal(after.items[1].status, 'success');
});

test('retry all failed does not exceed concurrency while others are still running', async () => {
  let active = 0;
  let peak = 0;
  const manager = createBatchManager({
    waitForOTP: async () => '123456',
    getAccessToken: async (token) => ({ accessToken: `access-${token}`, sessionJson: JSON.stringify({ token }) }),
    login: async (account) => {
      active++;
      peak = Math.max(peak, active);
      if (account.email.startsWith('slow')) {
        await wait(50);
        active--;
        return { sessionToken: `session-${account.email}` };
      }
      await wait(5);
      active--;
      throw new Error('fail once');
    },
  });

  const created = manager.create({
    concurrency: 2,
    input: 'bad1@example.com:m1\nbad2@example.com:m2\nslow1@example.com:m3\nslow2@example.com:m4',
  });

  for (let i = 0; i < 80; i++) {
    const snapshot = manager.get(created.job.id);
    const failed = snapshot.items.filter((item) => item.status === 'failed').length;
    const running = snapshot.items.filter((item) => item.status === 'running').length;
    if (failed >= 2 && running >= 1) break;
    await wait(5);
  }

  const retried = manager.retry(created.job.id, { failed: true, concurrency: 2 });
  assert.equal(retried.ok, true);
  assert.equal(retried.job.concurrency, 2);
  await waitForDone(manager, created.job.id);
  assert.ok(peak <= 2, `peak concurrency was ${peak}`);
});

test('retry all failed accounts without wiping successful sessions', async () => {
  const attempts = new Map();
  const manager = createBatchManager({
    waitForOTP: async () => '123456',
    getAccessToken: async (token) => ({ accessToken: `access-${token}`, sessionJson: JSON.stringify({ token }) }),
    login: async (account) => {
      const count = (attempts.get(account.email) || 0) + 1;
      attempts.set(account.email, count);
      if (account.email.startsWith('bad') && count === 1) throw new Error(`fail ${account.email}`);
      return { sessionToken: `session-${account.email}` };
    },
  });

  const created = manager.create({
    concurrency: 3,
    input: 'ok@example.com:mail1\nbad1@example.com:mail2\nbad2@example.com:mail3',
  });
  const done = await waitForDone(manager, created.job.id);
  assert.equal(done.counts.success, 1);
  assert.equal(done.counts.failed, 2);

  const retried = manager.retry(created.job.id, { failed: true });
  assert.equal(retried.ok, true);
  const after = await waitForDone(manager, created.job.id);
  assert.equal(after.counts.success, 3);
  assert.equal(after.counts.failed, 0);
  assert.equal(after.items[0].retryCount || 0, 0);
  assert.equal(after.items[1].retryCount, 1);
  assert.equal(after.items[2].retryCount, 1);
  assert.equal(after.sessions.length, 3);
});

test('failed rows expose an error category for the operator', async () => {
  const manager = createBatchManager({
    waitForOTP: async () => '123456',
    getAccessToken: async (token) => ({ accessToken: `access-${token}`, sessionJson: JSON.stringify({ token }) }),
    login: async (account) => {
      if (account.email.startsWith('pwd')) throw new Error('wrong password');
      if (account.email.startsWith('otp')) throw new Error('未取到邮箱验证码');
      if (account.email.startsWith('net')) throw new Error('proxy ETIMEDOUT');
      throw new Error('unexpected');
    },
  });

  const created = manager.create({
    input: 'pwd@example.com:m1\notp@example.com:m2\nnet@example.com:m3',
  });
  const job = await waitForDone(manager, created.job.id);
  assert.equal(job.items[0].errorCategory, 'password');
  assert.equal(job.items[1].errorCategory, 'otp');
  assert.equal(job.items[2].errorCategory, 'proxy');
});

test('mail risk control retries once on another proxy', async () => {
  const otpProxies = [];
  const manager = createBatchManager({
    waitForOTP: async (_email, _password, options) => {
      otpProxies.push(options.proxy);
      if (options.proxy.includes(':8080')) {
        throw new Error('mail_sms_locked: mail.com 账户协助/风控页(需人工)');
      }
      return '123456';
    },
    getAccessToken: async (token) => ({ accessToken: `access-${token}`, sessionJson: JSON.stringify({ token }) }),
    login: async (account, options) => {
      await options.getOtp();
      return { sessionToken: `session-${account.email}` };
    },
  });

  const created = manager.create({
    concurrency: 1,
    proxies: 'http://u:p@proxy.example:8080\nhttp://u:p@proxy.example:8081',
    input: 'a@example.com:mail1',
  });
  const job = await waitForDone(manager, created.job.id);
  assert.equal(job.items[0].status, 'success');
  assert.deepEqual(otpProxies, [
    'http://u:p@proxy.example:8080',
    'http://u:p@proxy.example:8081',
  ]);
  assert.equal(job.items[0].errorCategory, '');
});

test('cancelled accounts keep credentials and can be retried', async () => {
  const manager = createBatchManager({
    waitForOTP: async () => '123456',
    getAccessToken: async (token) => ({ accessToken: `access-${token}`, sessionJson: JSON.stringify({ token }) }),
    login: async (account) => {
      await wait(30);
      return { sessionToken: `session-${account.email}` };
    },
  });

  const created = manager.create({ concurrency: 1, input: 'a@example.com:mail1\nb@example.com:mail2' });
  await wait(5);
  manager.cancel(created.job.id);
  const cancelled = await waitForDone(manager, created.job.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.items[1].status, 'cancelled');
  assert.equal(cancelled.items[1].canRetry, true);

  const retried = manager.retry(created.job.id, { index: 1 });
  assert.equal(retried.ok, true);
  const after = await waitForDone(manager, created.job.id);
  assert.equal(after.items[1].status, 'success');
  assert.equal(after.items[1].retryCount, 1);
});

test('retry reassigns a proxy from the current pool', async () => {
  const proxiesUsed = [];
  const manager = createBatchManager({
    waitForOTP: async () => '123456',
    getAccessToken: async (token) => ({ accessToken: `access-${token}`, sessionJson: JSON.stringify({ token }) }),
    login: async (account, options) => {
      proxiesUsed.push(options.proxy);
      if (proxiesUsed.length === 1) throw new Error('temporary fail');
      return { sessionToken: `session-${account.email}` };
    },
  });

  const created = manager.create({
    concurrency: 1,
    proxies: 'http://a@proxy.example:8080\nhttp://b@proxy.example:8081',
    input: 'bad@example.com:mail1',
  });
  await waitForDone(manager, created.job.id);
  const retried = manager.retry(created.job.id, { index: 0 });
  assert.equal(retried.ok, true);
  const after = await waitForDone(manager, created.job.id);
  assert.equal(after.counts.success, 1);
  assert.equal(proxiesUsed.length, 2);
  assert.ok(proxiesUsed.every((proxy) => [
    'http://a@proxy.example:8080',
    'http://b@proxy.example:8081',
  ].includes(proxy)));
});

test('getAccessToken errors surface as the row error reason', async () => {
  const manager = createBatchManager({
    waitForOTP: async () => '123456',
    getAccessToken: async () => {
      throw new Error('session 接口返回 403');
    },
    login: async (account) => ({ sessionToken: `session-${account.email}` }),
  });

  const created = manager.create({ input: 'a@example.com:mail1' });
  const job = await waitForDone(manager, created.job.id);
  assert.equal(job.items[0].status, 'failed');
  assert.equal(job.items[0].error, 'session 接口返回 403');
  assert.equal(job.items[0].canRetry, true);
});

test('session success does not auto query plan or cancel renewal', async () => {
  let queried = false;
  let cancelled = false;
  const manager = createBatchManager({
    waitForOTP: async () => '123456',
    getAccessToken: async (token) => ({ accessToken: `access-${token}`, sessionJson: JSON.stringify({ token }) }),
    getSubscriptionInfo: async () => {
      queried = true;
      return { plan: 'plus', autoRenew: true };
    },
    cancelRenewal: async () => {
      cancelled = true;
      return { ok: true, willRenew: false };
    },
    login: async (account) => ({ sessionToken: `session-${account.email}` }),
  });
  const created = manager.create({ input: 'a@example.com:mail1' });
  const job = await waitForDone(manager, created.job.id);
  assert.equal(job.items[0].status, 'success');
  assert.equal(queried, false);
  assert.equal(cancelled, false);
  assert.equal(job.items[0].subscriptionInfo, null);
  assert.equal(job.items[0].cancelRenewal, null);
});

test('querySubscription writes plan without failing the session row', async () => {
  const manager = createBatchManager({
    waitForOTP: async () => '123456',
    getAccessToken: async (token) => ({
      accessToken: `access-${token}`,
      sessionJson: JSON.stringify({ accessToken: `access-${token}` }),
      sessionToken: token,
    }),
    getSubscriptionInfo: async ({ email }, proxy) => ({ plan: 'plus', autoRenew: true, email, proxy }),
    login: async (account, options) => ({ sessionToken: `session-${account.email}`, accountId: 'acc-1' }),
  });
  const created = manager.create({
    input: 'plus@example.com:mail1',
    proxies: 'http://u:p@proxy.example:8080',
  });
  await waitForDone(manager, created.job.id);
  const queried = manager.querySubscription(created.job.id, { index: 0 });
  assert.equal(queried.ok, true);
  assert.equal(queried.job.items[0].billingStatus, 'running');
  const job = await waitForBilling(manager, created.job.id);
  assert.equal(job.items[0].status, 'success');
  assert.equal(job.items[0].subscriptionInfo.plan, 'plus');
  assert.equal(job.items[0].billingStatus, 'ok');
});

test('cancelRenewalNow rotates session json and does not fail the row on error', async () => {
  const calls = [];
  let shouldFail = false;
  const manager = createBatchManager({
    waitForOTP: async () => '123456',
    getAccessToken: async (token) => ({
      accessToken: `access-${token}`,
      sessionJson: JSON.stringify({ accessToken: `access-${token}` }),
      sessionToken: token,
    }),
    cancelRenewal: async (creds, proxy) => {
      calls.push({ email: creds.email, accessToken: creds.accessToken, proxy });
      if (shouldFail) throw new Error('取消续费失败: 500 boom');
      return {
        ok: true,
        willRenew: false,
        accountId: 'acc-1',
        accessToken: 'access-rotated',
        sessionToken: 'session-rotated',
        sessionJson: JSON.stringify({ accessToken: 'access-rotated', sessionToken: 'session-rotated' }),
      };
    },
    login: async (account) => ({ sessionToken: `session-${account.email}`, accountId: 'acc-1' }),
  });

  const created = manager.create({
    input: 'plus@example.com:mail1',
    proxies: 'http://u:p@proxy.example:8080',
  });
  await waitForDone(manager, created.job.id);
  const cancelled = manager.cancelRenewalNow(created.job.id, { all: true });
  assert.equal(cancelled.ok, true);
  const job = await waitForBilling(manager, created.job.id);
  assert.equal(job.items[0].status, 'success');
  assert.equal(job.items[0].cancelRenewal.ok, true);
  assert.equal(job.items[0].subscriptionInfo.autoRenew, false);
  assert.equal(JSON.parse(job.sessions[0]).sessionToken, 'session-rotated');
  assert.equal(calls[0].email, 'plus@example.com');
  assert.equal(calls[0].proxy, 'http://u:p@proxy.example:8080');
  assert.doesNotMatch(JSON.stringify(job.items[0].cancelRenewal), /access-rotated|session-rotated/);

  shouldFail = true;
  const failed = manager.cancelRenewalNow(created.job.id, { index: 0 });
  assert.equal(failed.ok, true);
  const after = await waitForBilling(manager, created.job.id);
  assert.equal(after.items[0].status, 'success');
  assert.equal(after.items[0].cancelRenewal.ok, false);
  assert.match(after.items[0].subscriptionInfo.warnings.join(''), /取消自动续费失败/);
});

test('explicit cancelRenewal:true still auto-cancels after login', async () => {
  let cancelled = false;
  const manager = createBatchManager({
    waitForOTP: async () => '123456',
    getAccessToken: async (token) => ({ accessToken: `access-${token}`, sessionJson: JSON.stringify({ token }) }),
    cancelRenewal: async () => {
      cancelled = true;
      return { ok: true, willRenew: false };
    },
    login: async (account) => ({ sessionToken: `session-${account.email}` }),
  });
  const created = manager.create({ input: 'a@example.com:mail1', cancelRenewal: true });
  const job = await waitForDone(manager, created.job.id);
  assert.equal(job.items[0].status, 'success');
  assert.equal(cancelled, true);
  assert.equal(job.items[0].cancelRenewal.ok, true);
});
