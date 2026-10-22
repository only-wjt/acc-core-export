import { randomUUID } from 'node:crypto';
import { parseProxyPool } from './batch-session.js';

const DEFAULT_MAX_ACCOUNTS = 200;
const DEFAULT_RETENTION_MS = 30 * 60 * 1000;
const MAX_CONCURRENCY = 20;

function publicError(error) {
  return String(error?.message || error || '未知错误')
    .replace(/(__Secure-next-auth\.session-token(?:\.\d+)?=)[^;\s]+/gi, '$1[已隐藏]')
    .replace(/(accessToken|sessionToken|password|cookie)\s*[:=]\s*[^\s,;]+/gi, '$1=[已隐藏]')
    .slice(0, 300);
}

function extractSessionValue(raw) {
  const text = String(raw || '').trim();
  if (!text) return { email: '', sessionToken: '' };
  if (text.startsWith('{')) {
    try {
      const json = JSON.parse(text);
      return {
        email: String(json.email || json.user?.email || json.user?.emailAddress || '').trim(),
        sessionToken: String(json.sessionToken || json.session_token || json.session || '').trim(),
      };
    } catch {
      return { email: '', sessionToken: '' };
    }
  }
  return { email: '', sessionToken: text };
}

// 验活输入：每行 `邮箱----sessionToken`、单独 token，或取 Session 复制出来的整段 JSON。
export function parseSessionInputs(input, { maxAccounts = DEFAULT_MAX_ACCOUNTS } = {}) {
  const text = String(input || '').trim();
  const asOne = extractSessionValue(text);
  const lines = asOne.sessionToken && text.startsWith('{')
    ? [text]
    : String(input || '').split(/\r?\n/);
  const accounts = [];
  const errors = [];
  const seen = new Set();

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index].trim();
    if (!raw) continue;

    let email = '';
    let sessionToken = raw;
    if (raw.includes('----')) {
      const parts = raw.split('----').map((part) => part.trim());
      const tail = extractSessionValue(parts.slice(1).join('----'));
      sessionToken = tail.sessionToken || parts[parts.length - 1];
      email = /^\S+@\S+\.\S+$/.test(parts[0]) ? parts[0] : (tail.email || '');
    } else {
      const parsed = extractSessionValue(raw);
      sessionToken = parsed.sessionToken;
      email = parsed.email;
    }

    if (!sessionToken || sessionToken.length < 20 || sessionToken.startsWith('{')) {
      errors.push({ line: index + 1, message: 'sessionToken 无效（每行应为 邮箱----token、单独 token，或 session JSON）' });
      continue;
    }
    const key = sessionToken.slice(0, 64);
    if (seen.has(key)) {
      errors.push({ line: index + 1, message: 'sessionToken 重复' });
      continue;
    }
    seen.add(key);
    accounts.push({ index: accounts.length, line: index + 1, email, sessionToken });
  }

  if (accounts.length > maxAccounts) {
    errors.push({ line: 0, message: `单次最多校验 ${maxAccounts} 个` });
  }
  if (!accounts.length && !errors.length) {
    errors.push({ line: 0, message: '请至少输入一个 sessionToken' });
  }
  return { accounts: accounts.slice(0, maxAccounts), errors };
}

function serializeItem(item) {
  return {
    index: item.index,
    email: item.email || '',
    status: item.status,
    alive: item.alive ?? null,
    reason: item.reason || '',
    plan: item.plan || '',
    error: item.error || '',
    retryCount: item.retryCount || 0,
    canRetry: item.status === 'done' && item.alive === false,
    durationMs: item.startedAt ? (item.finishedAt || Date.now()) - item.startedAt : 0,
  };
}

function serializeJob(job) {
  const items = job.items.map(serializeItem);
  return {
    id: job.id,
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
      alive: items.filter((item) => item.alive === true).length,
      dead: items.filter((item) => item.status === 'done' && item.alive === false).length,
      cancelled: items.filter((item) => item.status === 'cancelled').length,
    },
    items,
  };
}

export function createCheckManager({
  checkAlive,
  retentionMs = DEFAULT_RETENTION_MS,
  maxAccounts = DEFAULT_MAX_ACCOUNTS,
  now = () => Date.now(),
  onFinish = null,
} = {}) {
  if (typeof checkAlive !== 'function') throw new TypeError('checkAlive 必须是函数');

  const jobs = new Map();

  function cleanup() {
    const cutoff = now() - retentionMs;
    for (const [id, job] of jobs) {
      if (job.finishedAt && job.finishedAt < cutoff) jobs.delete(id);
    }
  }

  function pickProxy(proxies) {
    if (!proxies?.length) return null;
    return proxies[Math.floor(Math.random() * proxies.length)];
  }

  function maybeFinishJob(job) {
    if (job.items.some((item) => item.status === 'running' || item.status === 'pending')) return;
    job.status = job.cancelRequested ? 'cancelled' : 'completed';
    job.finishedAt = now();
    if (typeof onFinish === 'function') {
      void Promise.resolve(onFinish(serializeJob(job))).catch(() => {});
    }
  }

  async function runItem(job, item) {
    if (job.cancelRequested) {
      item.status = 'cancelled';
      item.finishedAt = now();
      return;
    }
    item.status = 'running';
    item.startedAt = now();
    try {
      const result = await checkAlive({ email: item.email, sessionToken: item.sessionToken }, () => {}, item.proxy);
      item.status = 'done';
      item.alive = Boolean(result?.alive);
      item.reason = result?.reason || (item.alive ? 'ok' : 'error');
      item.plan = result?.plan || '';
      item.error = item.alive ? '' : publicError(result?.error || item.reason);
    } catch (error) {
      item.status = 'done';
      item.alive = false;
      item.reason = 'error';
      item.error = publicError(error);
    } finally {
      item.finishedAt = now();
    }
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

  function create({ input, proxies = '', concurrency = 5 } = {}) {
    cleanup();
    const parsed = parseSessionInputs(input, { maxAccounts });
    const parsedProxies = parseProxyPool(proxies);
    const errors = [...parsed.errors, ...parsedProxies.errors.map((error) => ({ ...error, field: 'proxies' }))];
    if (errors.length) return { ok: false, errors };

    const normalizedConcurrency = Math.max(1, Math.min(MAX_CONCURRENCY, Number(concurrency) || 5));
    const job = {
      id: randomUUID(),
      status: 'running',
      cancelRequested: false,
      createdAt: now(),
      finishedAt: null,
      concurrency: normalizedConcurrency,
      proxies: parsedProxies.proxies,
      items: parsed.accounts.map((account) => ({
        ...account,
        proxy: pickProxy(parsedProxies.proxies),
        status: 'pending',
        alive: null,
        reason: '',
        plan: '',
        error: '',
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
        item.finishedAt = now();
      }
    }
    return serializeJob(job);
  }

  function retry(id, { index, failed, indexes, concurrency } = {}) {
    cleanup();
    const job = jobs.get(id);
    if (!job) return { ok: false, status: 404, error: '任务不存在或已清理' };

    const isRetryable = (item) => item.status === 'done' && item.alive === false;
    let targets;
    if (failed === true) {
      targets = job.items.filter(isRetryable);
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
      if (!isRetryable(item)) return { ok: false, status: 400, error: '仅失败账号可重试' };
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
    for (const item of targets) {
      item.retryCount = (item.retryCount || 0) + 1;
      item.status = 'pending';
      item.alive = null;
      item.reason = '';
      item.error = '';
      item.proxy = pickProxy(job.proxies);
      item.startedAt = null;
      item.finishedAt = null;
    }
    void runItems(job, targets);
    return { ok: true, job: serializeJob(job) };
  }

  return { create, get, cancel, retry, cleanup };
}
