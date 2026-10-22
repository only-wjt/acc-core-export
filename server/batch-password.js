import { randomInt, randomUUID } from 'node:crypto';
import { isSessionHandshakeError } from '../src/session-recovery.js';
import { parseProxyPool } from './batch-session.js';
import { isRegionBlock } from './error-classify.js';

function generatePassword(length = 14) {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const all = `${upper}${lower}${digits}`;
  const pick = (alphabet) => alphabet[randomInt(alphabet.length)];
  const size = Math.max(8, Math.min(64, Number(length) || 14));
  const chars = [pick(upper), pick(lower), pick(digits)];
  for (let i = chars.length; i < size; i++) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

function assertPassword(value) {
  const password = String(value || '');
  if (password.length < 8) throw new Error('GPT 密码至少 8 位');
  if (password.length > 128) throw new Error('GPT 密码过长');
  return password;
}

const DEFAULT_MAX_ACCOUNTS = 100;
const DEFAULT_RETENTION_MS = 30 * 60 * 1000;
const MAX_CONCURRENCY = 20;

function publicError(error) {
  const message = String(error?.message || error || '未知错误')
    .replace(/\b\d{6}\b/g, '[验证码]')
    .replace(/(__Secure-next-auth\.session-token(?:\.\d+)?=)[^;\s]+/gi, '$1[已隐藏]')
    .replace(/(accessToken|sessionToken|password|cookie)\s*[:=]\s*[^\s,;]+/gi, '$1=[已隐藏]');
  return message.slice(0, 500);
}

function classifyError(error) {
  const text = String(error?.message || error || '');
  if (isRegionBlock(error)) return 'region';
  if (/(密码错误|密码不正确|wrong password|invalid[\s_-]*(login|password|credential)|凭据无效)/i.test(text)) return 'password';
  if (/(验证码|OTP|未取到.*码|邮件验证)/i.test(text)) return 'otp';
  if (/change_password_ineligible|不允许设置 GPT 密码|不允许走设置内改密|社交登录或企业号无法补密码/i.test(text)) return 'ineligible';
  if (/csrfToken/i.test(text)) return /被拦截|cloudflare|challenge|403/i.test(text) ? 'risk' : 'proxy';
  if (isSessionHandshakeError(error) || /(session 无 accessToken|token 可能已过期|session_token|未获取到完整 session)/i.test(text)) return 'session';
  if (/(429|rate[\s_-]*limit|too many|风控|频率|blocked|封禁|challenge|cloudflare|人机验证|访问被拒|mail_sms_locked|sms_locked|协助)/i.test(text)) return 'risk';
  if (/(代理|proxy|socks|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|tunnel|socket hang up|network|fetch failed|getaddrinfo|连接超时|无法连接)/i.test(text)) return 'proxy';
  if (/(账号不存在|未注册|create-account)/i.test(text)) return 'unknown';
  return 'unknown';
}

function isRotatableMailError(error) {
  return /(mail_sms_locked|sms_locked|mail_blocked|出口IP被拒|mail_rate_limited)/i.test(String(error?.message || error || ''));
}

function pickProxy(proxies, { avoid, state } = {}) {
  if (!proxies || !proxies.length) return null;
  const pool = avoid && proxies.length > 1
    ? proxies.filter((item) => item !== avoid)
    : proxies;
  if (state) {
    state.cursor = Number(state.cursor) || 0;
    const proxy = pool[state.cursor % pool.length];
    state.cursor += 1;
    return proxy;
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

function extractSessionToken(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (text.startsWith('{')) {
    try {
      const json = JSON.parse(text);
      return String(json.sessionToken || json.session_token || json.session || '').trim();
    } catch {
      return '';
    }
  }
  return text;
}

function isSessionValue(raw) {
  return extractSessionToken(raw).length >= 20;
}

function splitMailLine(raw) {
  const formatError = { error: '格式应为：邮箱:邮箱密码 或 邮箱----邮箱密码，可选再加 ----session' };

  if (!raw.includes('----') && raw.includes('@') && raw.includes(':')) {
    const index = raw.indexOf(':');
    const email = raw.slice(0, index).trim();
    const mailPassword = raw.slice(index + 1).trim();
    if (email && mailPassword) return { email, mailPassword, sessionToken: '' };
    return formatError;
  }

  if (!raw.includes('----')) return formatError;
  const parts = raw.split('----').map((part) => part.trim()).filter(Boolean);

  if (parts.length >= 1 && parts[0].includes('@') && parts[0].includes(':')) {
    const index = parts[0].indexOf(':');
    const email = parts[0].slice(0, index).trim();
    const mailPassword = parts[0].slice(index + 1).trim();
    const sessionRaw = parts.slice(1).join('----');
    if (email && mailPassword) {
      return { email, mailPassword, sessionToken: isSessionValue(sessionRaw) ? extractSessionToken(sessionRaw) : '' };
    }
  }

  if (parts.length >= 2 && /^\S+@\S+\.\S+$/.test(parts[0])) {
    if (parts.length === 2) {
      return { email: parts[0], mailPassword: parts[1], sessionToken: '' };
    }
    for (let index = parts.length - 1; index >= 2; index--) {
      const tail = parts.slice(index).join('----');
      if (!isSessionValue(tail)) continue;
      const mailPassword = parts.slice(1, index).join('----');
      if (mailPassword) {
        return { email: parts[0], mailPassword, sessionToken: extractSessionToken(tail) };
      }
    }
    return { email: parts[0], mailPassword: parts.slice(1).join('----'), sessionToken: '' };
  }

  return formatError;
}

export function parseMailAccounts(input, { maxAccounts = DEFAULT_MAX_ACCOUNTS } = {}) {
  const lines = String(input || '').split(/\r?\n/);
  const accounts = [];
  const errors = [];
  const seen = new Set();

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index].trim();
    if (!raw) continue;

    const parsed = splitMailLine(raw);
    if (parsed.error) {
      errors.push({ line: index + 1, message: parsed.error });
      continue;
    }

    const email = String(parsed.email || '').trim();
    const mailPassword = String(parsed.mailPassword || '').trim();
    const sessionToken = String(parsed.sessionToken || '').trim();
    if (!email || !mailPassword) {
      errors.push({ line: index + 1, message: '格式应为：邮箱:邮箱密码 或 邮箱----邮箱密码' });
      continue;
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      errors.push({ line: index + 1, message: '邮箱格式无效' });
      continue;
    }

    const key = email.toLowerCase();
    if (seen.has(key)) {
      errors.push({ line: index + 1, message: '邮箱重复' });
      continue;
    }

    seen.add(key);
    accounts.push({ index: accounts.length, line: index + 1, email, mailPassword, sessionToken });
  }

  if (accounts.length > maxAccounts) {
    errors.push({ line: 0, message: `单次最多处理 ${maxAccounts} 个账号` });
  }
  if (!accounts.length && !errors.length) {
    errors.push({ line: 0, message: '请至少输入一个账号' });
  }

  return { accounts: accounts.slice(0, maxAccounts), errors };
}

function mapStage(message) {
  const text = String(message || '');
  if (/添加 GPT 密码|忘记密码|设置内添加|申请设密授权/i.test(text)) return '开始添加';
  if (/等待邮箱验证码|未收到OTP|提交验证码/i.test(text)) return '等待邮箱验证码';
  if (/先用邮箱验证码登录/i.test(text)) return '登录获取 Session';
  if (/验证当前密码|邮箱 OTP 验证/i.test(text)) return '验证身份';
  if (/设置新密码/i.test(text)) return '设置 GPT 密码';
  if (/authorize|改密码认证/i.test(text)) return '建立认证会话';
  if (/CSRF/i.test(text)) return '连接 ChatGPT';
  if (/密码修改完成/i.test(text)) return '完成';
  return null;
}

function hasRetryCredentials(item) {
  return Boolean(item?.mailPassword);
}

function isRetryable(item) {
  return hasRetryCredentials(item) && item.status !== 'running' && item.status !== 'pending';
}

function isFailedRetryable(item) {
  return (item.status === 'failed' || item.status === 'cancelled') && hasRetryCredentials(item);
}

function serializeItem(item) {
  return {
    index: item.index,
    email: item.email,
    accountDisplay: item.accountDisplay,
    status: item.status,
    stage: item.stage,
    error: item.error,
    errorCategory: item.errorCategory || '',
    retryCount: item.retryCount || 0,
    canRetry: isRetryable(item),
    canAbort: item.status === 'running' && !item.abortRequested,
    aborting: item.status === 'running' && Boolean(item.abortRequested),
    durationMs: item.startedAt ? (item.finishedAt || Date.now()) - item.startedAt : 0,
    resultLine: item.status === 'success' ? item.resultLine || '' : '',
  };
}

function serializeJob(job) {
  const items = job.items.map(serializeItem);
  return {
    id: job.id,
    kind: 'password',
    status: job.status,
    cancelRequested: job.cancelRequested,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    concurrency: job.concurrency,
    proxyCount: job.proxies ? job.proxies.length : 0,
    counts: {
      total: items.length,
      pending: items.filter((item) => item.status === 'pending').length,
      running: items.filter((item) => item.status === 'running').length,
      success: items.filter((item) => item.status === 'success').length,
      failed: items.filter((item) => item.status === 'failed').length,
      cancelled: items.filter((item) => item.status === 'cancelled').length,
    },
    items,
    results: job.items
      .filter((item) => item.status === 'success' && item.resultLine)
      .sort((a, b) => a.index - b.index)
      .map((item) => item.resultLine),
  };
}

export function createPasswordManager({
  addPassword,
  waitForOTP,
  generatePassword: makePassword = generatePassword,
  retentionMs = DEFAULT_RETENTION_MS,
  maxAccounts = DEFAULT_MAX_ACCOUNTS,
  now = () => Date.now(),
  onFinish = null,
} = {}) {
  if (typeof addPassword !== 'function' || typeof waitForOTP !== 'function') {
    throw new TypeError('addPassword 和 waitForOTP 必须是函数');
  }

  const jobs = new Map();

  function maybeFinishJob(job) {
    const inFlight = job.items.some((item) => item.status === 'running' || item.status === 'pending');
    if (inFlight) return;
    job.status = job.cancelRequested ? 'cancelled' : 'completed';
    job.finishedAt = now();
    if (typeof onFinish === 'function') {
      void Promise.resolve(onFinish(serializeJob(job))).catch(() => {});
    }
  }

  function resetItemForRetry(item, proxies) {
    item.retryCount = (item.retryCount || 0) + 1;
    item.status = 'pending';
    item.stage = '等待重试';
    item.error = '';
    item.errorCategory = '';
    item.proxy = pickProxy(proxies, { avoid: item.proxy });
    item.resultLine = '';
    item.abortRequested = false;
    item.startedAt = null;
    item.finishedAt = null;
  }

  function cleanup() {
    const cutoff = now() - retentionMs;
    for (const [id, job] of jobs) {
      if (job.finishedAt && job.finishedAt < cutoff) jobs.delete(id);
    }
  }

  function itemStopped(job, item) {
    return job.cancelRequested || item.abortRequested;
  }

  async function runItem(job, item) {
    if (itemStopped(job, item)) {
      item.status = 'cancelled';
      item.stage = '已取消';
      item.abortRequested = false;
      item.finishedAt = now();
      return;
    }

    item.status = 'running';
    item.stage = '连接 ChatGPT';
    item.startedAt = now();

    const runAdd = () => addPassword(
      { email: item.email, sessionToken: item.sessionToken },
      {
        newPassword: item.newPassword,
        proxy: item.proxy,
        getOtp: async () => {
          item.stage = '等待邮箱验证码';
          if (itemStopped(job, item)) {
            const error = new Error('已终止');
            error.aborted = true;
            throw error;
          }
          const code = await waitForOTP(item.email, item.mailPassword, {
            proxy: item.proxy,
            maxMs: 180000,
            aborted: () => itemStopped(job, item),
          });
          if (itemStopped(job, item)) {
            const error = new Error('已终止');
            error.aborted = true;
            throw error;
          }
          return code;
        },
        log: (message) => {
          if (itemStopped(job, item)) return;
          const stage = mapStage(message);
          if (stage) item.stage = stage;
        },
      },
    );

    try {
      let result;
      try {
        result = await runAdd();
      } catch (error) {
        if (itemStopped(job, item) || !isRotatableMailError(error) || (job.proxies || []).length < 2) throw error;
        const switched = pickProxy(job.proxies, { avoid: item.proxy, state: job.proxyState });
        if (!switched || switched === item.proxy) throw error;
        item.proxy = switched;
        item.stage = '更换代理后重试';
        result = await runAdd();
      }

      if (itemStopped(job, item)) {
        item.status = 'cancelled';
        item.stage = '已取消';
        item.resultLine = '';
      } else if (!result?.ok) {
        throw new Error('添加密码未成功');
      } else {
        const password = result.newPassword || item.newPassword;
        item.newPassword = password;
        if (result.sessionToken) item.sessionToken = result.sessionToken;
        item.resultLine = `${item.email}----${password}----${item.mailPassword}`;
        item.accountDisplay = item.resultLine;
        item.status = 'success';
        item.stage = '完成';
      }
    } catch (error) {
      const aborted = itemStopped(job, item) || error?.aborted;
      item.status = aborted ? 'cancelled' : 'failed';
      item.stage = aborted ? '已取消' : '失败';
      item.error = aborted ? '' : publicError(error);
      item.errorCategory = aborted ? '' : classifyError(error);
      item.abortRequested = false;
    } finally {
      item.abortRequested = false;
      item.finishedAt = now();
    }
  }

  function pumpRunSlots(job) {
    job.runWaiters = job.runWaiters || [];
    job.activeRunners = job.activeRunners || 0;
    while (job.activeRunners < job.concurrency && job.runWaiters.length) {
      job.activeRunners += 1;
      job.runWaiters.shift()();
    }
  }

  function acquireRunSlot(job) {
    return new Promise((resolve) => {
      job.runWaiters = job.runWaiters || [];
      job.runWaiters.push(resolve);
      pumpRunSlots(job);
    });
  }

  function releaseRunSlot(job) {
    job.activeRunners = Math.max(0, (job.activeRunners || 1) - 1);
    pumpRunSlots(job);
  }

  async function runItems(job, items) {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(job.concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const item = items[cursor++];
        await acquireRunSlot(job);
        try {
          await runItem(job, item);
        } finally {
          releaseRunSlot(job);
        }
      }
    });
    await Promise.all(workers);
    maybeFinishJob(job);
  }

  function create({ input, newPassword = '', proxies = '', concurrency = 2 } = {}) {
    cleanup();
    const parsed = parseMailAccounts(input, { maxAccounts });
    const parsedProxies = parseProxyPool(proxies);
    const errors = [...parsed.errors, ...parsedProxies.errors.map((error) => ({ ...error, field: 'proxies' }))];
    const shared = String(newPassword || '').trim();
    if (shared) {
      try {
        assertPassword(shared);
      } catch (error) {
        errors.push({ line: 0, message: publicError(error) });
      }
    }
    if (errors.length) return { ok: false, errors };

    const normalizedConcurrency = Math.max(1, Math.min(MAX_CONCURRENCY, Number(concurrency) || 2));
    const proxyState = { cursor: 0 };
    const job = {
      id: randomUUID(),
      status: 'running',
      cancelRequested: false,
      createdAt: now(),
      finishedAt: null,
      concurrency: normalizedConcurrency,
      proxies: parsedProxies.proxies,
      proxyState,
      items: parsed.accounts.map((account) => ({
        ...account,
        newPassword: shared || makePassword(),
        accountDisplay: `${account.email}:${account.mailPassword}`,
        proxy: pickProxy(parsedProxies.proxies, { state: proxyState }),
        status: 'pending',
        stage: '等待开始',
        error: '',
        resultLine: '',
        abortRequested: false,
        startedAt: null,
        finishedAt: null,
      })),
    };

    jobs.set(job.id, job);
    void runItems(job, job.items);
    return { ok: true, job: serializeJob(job) };
  }

  function get(id) {
    cleanup();
    const job = jobs.get(id);
    return job ? serializeJob(job) : null;
  }

  // 供定时快照使用：只返回仍在跑的任务，序列化后立刻脱离内部可变对象。
  function listRunning() {
    cleanup();
    return [...jobs.values()]
      .filter((job) => job.status === 'running')
      .map(serializeJob);
  }

  function cancel(id) {
    const job = jobs.get(id);
    if (!job) return null;
    job.cancelRequested = true;
    for (const item of job.items) {
      if (item.status === 'pending') {
        item.status = 'cancelled';
        item.stage = '已取消';
        item.finishedAt = now();
      }
    }
    return serializeJob(job);
  }

  function abort(id, { index } = {}) {
    cleanup();
    const job = jobs.get(id);
    if (!job) return { ok: false, status: 404, error: '任务不存在或已清理' };
    if (!Number.isInteger(index) || index < 0) {
      return { ok: false, status: 400, error: '请指定要终止的账号' };
    }
    const item = job.items.find((entry) => entry.index === index);
    if (!item) return { ok: false, status: 404, error: '账号不存在' };
    if (item.status !== 'running') return { ok: false, status: 409, error: '该账号当前不在处理中' };
    item.abortRequested = true;
    item.stage = '正在终止';
    return { ok: true, job: serializeJob(job) };
  }

  function retry(id, { index, failed, indexes, concurrency } = {}) {
    cleanup();
    const job = jobs.get(id);
    if (!job) return { ok: false, status: 404, error: '任务不存在或已清理' };

    let targets;
    if (failed === true) {
      targets = job.items.filter(isFailedRetryable);
      if (!targets.length) return { ok: false, status: 400, error: '没有可重试的账号' };
    } else if (Array.isArray(indexes)) {
      const seen = new Set();
      targets = [];
      for (const raw of indexes) {
        if (!Number.isInteger(raw) || raw < 0 || seen.has(raw)) continue;
        seen.add(raw);
        const item = job.items.find((entry) => entry.index === raw);
        if (item && isRetryable(item)) targets.push(item);
      }
      if (!targets.length) return { ok: false, status: 400, error: '没有可重试的账号' };
    } else if (Number.isInteger(index) && index >= 0) {
      const item = job.items.find((entry) => entry.index === index);
      if (!item) return { ok: false, status: 404, error: '账号不存在' };
      if (item.status === 'running' || item.status === 'pending') return { ok: false, status: 409, error: '该账号正在处理中' };
      if (!isRetryable(item)) return { ok: false, status: 400, error: '该账号无法重试' };
      targets = [item];
    } else {
      return { ok: false, status: 400, error: '请指定要重试的账号' };
    }

    if (job.finishedAt) job.cancelRequested = false;
    job.status = 'running';
    job.finishedAt = null;
    const requestedConcurrency = Number(concurrency);
    if (Number.isInteger(requestedConcurrency) && requestedConcurrency > 0) {
      job.concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, requestedConcurrency));
    }
    for (const item of targets) resetItemForRetry(item, job.proxies);
    void runItems(job, targets);
    return { ok: true, job: serializeJob(job) };
  }

  return { create, get, cancel, abort, retry, cleanup };
}
