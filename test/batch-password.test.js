import test from 'node:test';
import assert from 'node:assert/strict';
import { createPasswordManager, parseMailAccounts } from '../server/batch-password.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TOKEN_A = 'eyJaaaaaaaaaaaaaaaaaaaa';
const TOKEN_B = 'eyJbbbbbbbbbbbbbbbbbbbb';
const TOKEN_C = 'eyJcccccccccccccccccccc';

async function waitForDone(manager, id) {
  for (let i = 0; i < 100; i++) {
    const job = manager.get(id);
    if (job?.status !== 'running') return job;
    await wait(5);
  }
  throw new Error('任务测试超时');
}

test('parseMailAccounts accepts email:mail, email----mail, and optional session', () => {
  const result = parseMailAccounts([
    'plain@mail.com:mailOnly',
    `a@mail.com----mail-pass:with:colon----${TOKEN_A}`,
    `b@mail.com:mailB----${TOKEN_B}`,
    `c@mail.com----mailC----${JSON.stringify({ sessionToken: TOKEN_C })}`,
  ].join('\n'));
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.accounts.map((item) => [item.email, item.mailPassword, item.sessionToken]), [
    ['plain@mail.com', 'mailOnly', ''],
    ['a@mail.com', 'mail-pass:with:colon', TOKEN_A],
    ['b@mail.com', 'mailB', TOKEN_B],
    ['c@mail.com', 'mailC', TOKEN_C],
  ]);
});

test('parseMailAccounts rejects duplicates', () => {
  const result = parseMailAccounts([
    'b@mail.com:mail',
    'b@mail.com----other',
  ].join('\n'));
  assert.deepEqual(result.errors.map((item) => item.message), [
    '邮箱重复',
  ]);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].email, 'b@mail.com');
});

test('password manager accepts email:mail without session', async () => {
  const manager = createPasswordManager({
    waitForOTP: async () => '123456',
    addPassword: async (account, options) => {
      assert.equal(account.sessionToken, '');
      const code = await options.getOtp();
      assert.equal(code, '123456');
      return { ok: true, newPassword: options.newPassword };
    },
    generatePassword: () => 'NoSessPw1234',
  });
  const created = manager.create({
    input: 'plain@mail.com:mailbox',
    concurrency: 1,
    newPassword: 'NoSessPw1234',
  });
  assert.equal(created.ok, true);
  const job = await waitForDone(manager, created.job.id);
  assert.equal(job.counts.success, 1);
  assert.deepEqual(job.results, ['plain@mail.com----NoSessPw1234----mailbox']);
});

test('password manager adds a password via mail OTP and returns copy lines', async () => {
  const calls = [];
  const manager = createPasswordManager({
    waitForOTP: async (email, password, options) => {
      calls.push({ type: 'otp', email, password, proxy: options.proxy });
      return '123456';
    },
    addPassword: async (account, options) => {
      calls.push({
        type: 'add',
        email: account.email,
        sessionToken: account.sessionToken,
        password: options.newPassword,
        proxy: options.proxy,
      });
      const code = await options.getOtp();
      assert.equal(code, '123456');
      return { ok: true, newPassword: options.newPassword };
    },
    generatePassword: () => 'GeneratedPw12',
  });

  const created = manager.create({
    input: `one@mail.com----mailbox----${TOKEN_A}\nbad@mail.com:mailbox----${TOKEN_B}`,
    proxies: 'socks5://127.0.0.1:1080',
    concurrency: 2,
    newPassword: 'UnifiedPw12',
  });
  assert.equal(created.ok, true);
  const job = await waitForDone(manager, created.job.id);
  assert.equal(job.kind, 'password');
  assert.equal(job.counts.success, 2);
  assert.deepEqual(job.results, [
    'one@mail.com----UnifiedPw12----mailbox',
    'bad@mail.com----UnifiedPw12----mailbox',
  ]);
  assert.ok(calls.filter((call) => call.type === 'add').every((call) => call.password === 'UnifiedPw12'));
  assert.deepEqual(calls.filter((call) => call.type === 'add').map((call) => call.sessionToken), [TOKEN_A, TOKEN_B]);
  assert.ok(calls.filter((call) => call.type === 'otp').every((call) => call.proxy === 'socks5://127.0.0.1:1080'));
});

test('password manager reports failures, retries, and hides secrets in errors', async () => {
  let failAttempts = 0;
  const manager = createPasswordManager({
    waitForOTP: async () => '654321',
    addPassword: async (account) => {
      if (account.email.startsWith('fail')) {
        failAttempts += 1;
        if (failAttempts === 1) {
          throw new Error('OTP timeout cookie=secret 123456');
        }
      }
      return { ok: true, newPassword: 'RetryPw1234' };
    },
    generatePassword: () => 'RetryPw1234',
  });

  const created = manager.create({
    input: `ok@mail.com----mail----${TOKEN_A}\nfail@mail.com----mail----${TOKEN_B}`,
    concurrency: 1,
  });
  const job = await waitForDone(manager, created.job.id);
  assert.equal(job.counts.success, 1);
  assert.equal(job.counts.failed, 1);
  assert.equal(job.items[1].canRetry, true);
  assert.equal(job.items[1].errorCategory, 'otp');
  assert.doesNotMatch(job.items[1].error, /secret|123456|654321/);

  const retried = manager.retry(created.job.id, { failed: true });
  assert.equal(retried.ok, true);
  const after = await waitForDone(manager, created.job.id);
  assert.equal(after.counts.success, 2);
  assert.equal(after.items[1].retryCount, 1);
  assert.equal(after.results.length, 2);
});

test('password manager classifies csrf handshake failures as proxy', async () => {
  const manager = createPasswordManager({
    waitForOTP: async () => '000000',
    addPassword: async () => {
      throw new Error('获取 csrfToken 失败');
    },
    generatePassword: () => 'GeneratedPw12',
  });
  const created = manager.create({
    input: `dead@mail.com----mail----${TOKEN_A}`,
    concurrency: 1,
  });
  const job = await waitForDone(manager, created.job.id);
  assert.equal(job.counts.failed, 1);
  assert.equal(job.items[0].errorCategory, 'proxy');
  assert.match(job.items[0].error, /csrfToken/);
});

test('password manager classifies change_password_ineligible', async () => {
  const manager = createPasswordManager({
    waitForOTP: async () => '000000',
    addPassword: async () => {
      throw new Error('该账号不允许设置 GPT 密码（change_password_ineligible）。无密码号不能走改密重置，社交登录或企业号也不能补密码。');
    },
    generatePassword: () => 'GeneratedPw12',
  });
  const created = manager.create({
    input: `skip@mail.com----mail----${TOKEN_A}`,
    concurrency: 1,
  });
  const job = await waitForDone(manager, created.job.id);
  assert.equal(job.items[0].errorCategory, 'ineligible');
});

test('password manager rejects a too-short shared password', () => {
  const manager = createPasswordManager({
    waitForOTP: async () => '000000',
    addPassword: async () => ({ ok: true, newPassword: 'x' }),
  });
  const created = manager.create({
    input: `a@mail.com----mail----${TOKEN_A}`,
    newPassword: 'short',
  });
  assert.equal(created.ok, false);
  assert.match(created.errors[0].message, /至少 8 位/);
});
