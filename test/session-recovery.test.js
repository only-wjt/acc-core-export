import test from 'node:test';
import assert from 'node:assert/strict';
import { addWithSessionFallback, isSessionHandshakeError } from '../src/session-recovery.js';

const TOKEN_OLD = 'eyJoldsessiontokenvalue';
const TOKEN_NEW = 'eyJnewsessiontokenvalue';

test('isSessionHandshakeError matches expired session, not csrf, otp or 429', () => {
  assert.equal(isSessionHandshakeError(new Error('获取 csrfToken 失败')), false);
  assert.equal(isSessionHandshakeError(new Error('session 无 accessToken')), true);
  assert.equal(isSessionHandshakeError(new Error('获取 authorize URL 失败: {"url":"...csrf=true"}')), true);
  assert.equal(isSessionHandshakeError(new Error('没拿到邮箱验证码')), false);
  assert.equal(isSessionHandshakeError(new Error('改密 authorize 429(限流)')), false);
});

test('addWithSessionFallback uses a live session and does not login', async () => {
  const calls = [];
  const result = await addWithSessionFallback({
    email: 'a@mail.com',
    sessionToken: TOKEN_OLD,
    newPassword: 'NewPw1234',
    checkAlive: async (account) => {
      calls.push({ type: 'check', token: account.sessionToken });
      return { alive: true };
    },
    login: async () => {
      calls.push({ type: 'login' });
      return { sessionToken: TOKEN_NEW };
    },
    addPassword: async (account) => {
      calls.push({ type: 'add', token: account.sessionToken });
      return { ok: true, newPassword: 'NewPw1234' };
    },
    getOtp: async () => '123456',
  });
  assert.equal(result.ok, true);
  assert.equal(result.relogin, false);
  assert.equal(result.sessionToken, TOKEN_OLD);
  assert.deepEqual(calls.map((item) => item.type), ['check', 'add']);
});

test('addWithSessionFallback relogins when session is dead', async () => {
  const calls = [];
  const result = await addWithSessionFallback({
    email: 'a@mail.com',
    sessionToken: TOKEN_OLD,
    newPassword: 'NewPw1234',
    checkAlive: async () => {
      calls.push({ type: 'check' });
      return { alive: false, reason: 'token_expired' };
    },
    login: async (account, options) => {
      calls.push({ type: 'login', email: account.email });
      const code = await options.getOtp();
      assert.equal(code, '123456');
      return { sessionToken: TOKEN_NEW };
    },
    addPassword: async (account) => {
      calls.push({ type: 'add', token: account.sessionToken });
      return { ok: true, newPassword: 'NewPw1234' };
    },
    getOtp: async () => '123456',
  });
  assert.equal(result.relogin, true);
  assert.equal(result.sessionToken, TOKEN_NEW);
  assert.deepEqual(calls, [
    { type: 'check' },
    { type: 'login', email: 'a@mail.com' },
    { type: 'add', token: TOKEN_NEW },
  ]);
});

test('addWithSessionFallback does not relogin after csrf failure on a live session', async () => {
  await assert.rejects(
    () => addWithSessionFallback({
      email: 'a@mail.com',
      sessionToken: TOKEN_OLD,
      checkAlive: async () => ({ alive: true }),
      login: async () => ({ sessionToken: TOKEN_NEW }),
      addPassword: async () => {
        throw new Error('获取 csrfToken 失败(403:被拦截)');
      },
      getOtp: async () => '000000',
    }),
    /获取 csrfToken 失败/,
  );
});

test('addWithSessionFallback wraps login failure after a dead session', async () => {
  await assert.rejects(
    () => addWithSessionFallback({
      email: 'a@mail.com',
      sessionToken: TOKEN_OLD,
      checkAlive: async () => ({ alive: false, reason: 'token_expired' }),
      login: async () => {
        throw new Error('获取 csrfToken 失败(403:被拦截)');
      },
      addPassword: async () => ({ ok: true }),
      getOtp: async () => '000000',
    }),
    /重新登录失败：获取 csrfToken 失败/,
  );
});

test('addWithSessionFallback does not relogin on OTP failure', async () => {
  await assert.rejects(
    () => addWithSessionFallback({
      email: 'a@mail.com',
      sessionToken: TOKEN_OLD,
      checkAlive: async () => ({ alive: true }),
      login: async () => ({ sessionToken: TOKEN_NEW }),
      addPassword: async () => {
        throw new Error('没拿到邮箱验证码(检查关联 mail 账号)');
      },
      getOtp: async () => '',
    }),
    /没拿到邮箱验证码/,
  );
});
