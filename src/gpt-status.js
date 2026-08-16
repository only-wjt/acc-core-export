export function classifyAccountsCheckFailure(status, body = '') {
  const text = String(body || '');
  let code = null;
  try { code = JSON.parse(text)?.error?.code || null; } catch {}
  if (['token_invalidated', 'token_revoked'].includes(code)
    || /"code"\s*:\s*"(?:token_invalidated|token_revoked)"/i.test(text)) {
    return { alive: false, reason: 'token_invalidated', error: 'OpenAI 已主动撤销认证 token，需重新登录确认账号状态' };
  }
  if (/deactivated|deleted|account_deactivated|suspended/i.test(text)) {
    return { alive: false, reason: 'banned', error: '账号已封号/停用' };
  }
  if (status === 403 && (/^\s*</.test(text) || /cloudflare|cf-ray|just a moment|challenge-platform/i.test(text))) {
    return { alive: false, reason: 'cf_blocked', error: 'CF拦截(403挑战页)' };
  }
  if (status === 401 || status === 403) {
    return { alive: false, reason: 'token_expired', error: `会话失效(${status})` };
  }
  return null;
}

// checkAlive also returns fresh credentials for internal export/storage. Batch progress is consumed
// by the browser UI, so it must only expose diagnostic fields.
export function publicAccountsCheckResult(result = {}) {
  const allowed = ['alive', 'reason', 'error', 'errorCode', 'errorLabel', 'accountId', 'plan'];
  return Object.fromEntries(allowed.filter((key) => result[key] !== undefined).map((key) => [key, result[key]]));
}

const TRANSIENT_REASONS = new Set(['cf_blocked', 'proxy_down', 'network']);

// Internal persistence keeps freshly refreshed credentials. HTTP status responses must still pass
// through publicAccountsCheckResult so bearer/session material never leaks into progress or UI APIs.
export function gptCheckPatch(result = {}, now = Date.now()) {
  if (result.alive) {
    return {
      status: 'ok', lastError: null, checkReason: 'online', lastCheckError: null,
      checkState: 'fresh', checkedAt: now,
      ...(result.accountId ? { accountId: result.accountId } : {}),
      ...(result.plan ? { plan: result.plan } : {}),
      ...(result.accessToken ? { accessToken: result.accessToken } : {}),
      ...(result.sessionJson ? { sessionJson: result.sessionJson } : {}),
    };
  }
  if (TRANSIENT_REASONS.has(result.reason)) {
    return { checkReason: result.reason, lastCheckError: result.error || null, checkState: 'stale', checkedAt: now };
  }
  return {
    status: 'error', lastError: result.error || null, checkReason: result.reason,
    lastCheckError: null, checkState: 'fresh', checkedAt: now,
  };
}
