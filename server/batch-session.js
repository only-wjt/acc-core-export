import { randomUUID } from 'node:crypto';
import { isRegionBlock } from './error-classify.js';

const DEFAULT_MAX_ACCOUNTS = 100;
const DEFAULT_RETENTION_MS = 30 * 60 * 1000;
const MAX_CONCURRENCY = 20;
const MAX_PROXIES = 50;

function publicError(error) {
  const message = String(error?.message || error || '未知错误')
    .replace(/\b\d{6}\b/g, '[验证码]')
    .replace(/(__Secure-next-auth\.session-token(?:\.\d+)?=)[^;\s]+/gi, '$1[已隐藏]')
    .replace(/(accessToken|sessionToken|password|cookie)\s*[:=]\s*[^\s,;]+/gi, '$1=[已隐藏]');
  return message.slice(0, 500);
}

// 把原始错误归类，便于操作者判断该换代理重试还是改输入。基于原文匹配后再脱敏展示。
function classifyError(error) {
  const text = String(error?.message || error || '');
  if (isRegionBlock(error)) return 'region';
  if (/(密码错误|密码不正确|wrong password|invalid[\s_-]*(login|password|credential)|凭据无效)/i.test(text)) return 'password';
  if (/(验证码|OTP|未取到.*码|邮件验证)/i.test(text)) return 'otp';
  if (/(429|rate[\s_-]*limit|too many|风控|频率|blocked|封禁|challenge|cloudflare|人机验证|访问被拒|mail_sms_locked|sms_locked|协助)/i.test(text)) return 'risk';
  if (/(代理|proxy|socks|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|tunnel|socket hang up|network|fetch failed|getaddrinfo|连接超时|无法连接)/i.test(text)) return 'proxy';
  if (/取消续费|will_renew/i.test(text)) return 'billing';
  if (/session/i.test(text)) return 'session';
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

export function parseAccounts(input, { maxAccounts = DEFAULT_MAX_ACCOUNTS } = {}) {
  const lines = String(input || '').split(/\r?\n/);
  const accounts = [];
  const errors = [];
  const seen = new Set();

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index].trim();
    if (!raw) continue;

    let email, gptPassword, mailPassword;

    // 优先尝试三段式格式：邮箱----GPT密码----邮箱密码
    if (raw.includes('----')) {
      const parts = raw.split('----').map((part) => part.trim());
      if (parts.length !== 3 || parts.some((part) => !part)) {
        errors.push({ line: index + 1, message: '三段式格式应为：邮箱----GPT密码----邮箱密码' });
        continue;
      }
      [email, gptPassword, mailPassword] = parts;
    } else {
      // 兼容两段式格式：邮箱:邮箱密码（纯OTP登录）
      const separator = raw.indexOf(':');
      if (separator <= 0 || separator === raw.length - 1) {
        errors.push({ line: index + 1, message: '格式应为：邮箱----GPT密码----邮箱密码 或 邮箱:邮箱密码' });
        continue;
      }
      email = raw.slice(0, separator).trim();
      mailPassword = raw.slice(separator + 1).trim();
      gptPassword = '';
      if (!email || !mailPassword) {
        errors.push({ line: index + 1, message: '格式应为：邮箱----GPT密码----邮箱密码 或 邮箱:邮箱密码' });
        continue;
      }
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
    accounts.push({ index: accounts.length, line: index + 1, email, gptPassword, mailPassword });
  }

  if (accounts.length > maxAccounts) {
    errors.push({ line: 0, message: `单次最多处理 ${maxAccounts} 个账号` });
  }
  if (!accounts.length && !errors.length) {
    errors.push({ line: 0, message: '请至少输入一个账号' });
  }

  return { accounts: accounts.slice(0, maxAccounts), errors };
}

export function parseProxyPool(input, { maxProxies = MAX_PROXIES } = {}) {
  const proxies = [];
  const errors = [];
  const seen = new Set();
  const lines = String(input || '').split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index].trim();
    if (!raw) continue;
    if (proxies.length >= maxProxies) {
      errors.push({ line: 0, message: `代理池最多 ${maxProxies} 条` });
      break;
    }

    try {
      const withoutFragment = raw.split('#', 1)[0].trim();
      if (!withoutFragment) continue; // 整行都是 # 注释
      const normalizedInput = withoutFragment.replace(/^socks:\/\//i, 'socks5://');
      const parsed = new URL(normalizedInput);
      if (!['http:', 'https:', 'socks4:', 'socks5:', 'socks5h:'].includes(parsed.protocol) || !parsed.hostname || !parsed.port) {
        throw new Error('unsupported');
      }

      // 处理 Base64 编码的凭据：socks5://BASE64(user:pass)@host:port
      let finalUsername = parsed.username;
      let finalPassword = parsed.password;
      if (parsed.username && !parsed.password && /^[A-Za-z0-9+/]+=*$/.test(decodeURIComponent(parsed.username))) {
        try {
          const decoded = Buffer.from(decodeURIComponent(parsed.username), 'base64').toString('utf8');
          const colonIndex = decoded.indexOf(':');
          if (colonIndex > 0) {
            finalUsername = decoded.slice(0, colonIndex);
            finalPassword = decoded.slice(colonIndex + 1);
          }
        } catch {
          // Base64 解码失败，保持原样
        }
      }

      const auth = finalUsername
        ? `${finalUsername}${finalPassword ? `:${finalPassword}` : ''}@`
        : '';
      const normalized = `${parsed.protocol}//${auth}${parsed.hostname}:${parsed.port}`;
      if (!seen.has(normalized)) {
        seen.add(normalized);
        proxies.push(normalized);
      }
    } catch {
      errors.push({ line: index + 1, message: '代理格式无效' });
    }
  }

  return { proxies, errors };
}

function mapStage(message) {
  const text = String(message || '');
  if (/邮箱验证码|OTP/i.test(text)) return '等待邮箱验证码';
  if (/提交密码/i.test(text)) return '验证 GPT 密码';
  if (/回调链/i.test(text)) return '生成 Session';
  if (/验证登录态/i.test(text)) return '验证 Session';
  if (/取消续费|cancel-renewal|pre_cancel/i.test(text)) return '取消自动续费';
  if (/Cloudflare|authorize/i.test(text)) return '建立认证会话';
  if (/CSRF|登录认证/i.test(text)) return '连接 ChatGPT';
  if (/登录完成/i.test(text)) return '完成';
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

function publicCancelRenewal(result) {
  if (!result || typeof result !== 'object') return null;
  const {
    accessToken, sessionToken, sessionJson, user, ...safe
  } = result;
  return safe;
}

function mergeCancelIntoSubscription(item) {
  if (!item.cancelRenewal) return;
  item.subscriptionInfo = item.subscriptionInfo || {};
  item.subscriptionInfo.cancelRenewal = publicCancelRenewal(item.cancelRenewal);
  if (item.cancelRenewal.ok && item.cancelRenewal.willRenew !== true && !item.cancelRenewal.skipped) {
    item.subscriptionInfo.autoRenew = false;
  }
  if (item.cancelRenewal.ok === false && item.cancelRenewal.error) {
    const warning = `取消自动续费失败：${item.cancelRenewal.error}`;
    const warnings = item.subscriptionInfo.warnings || [];
    if (!warnings.includes(warning)) item.subscriptionInfo.warnings = [...warnings, warning];
  }
}

function applyCancelResult(item, cancelled) {
  item.cancelRenewal = publicCancelRenewal(cancelled);
  if (cancelled?.sessionToken) item.sessionToken = cancelled.sessionToken;
  if (item.sessionData && (cancelled?.accessToken || cancelled?.sessionJson || cancelled?.sessionToken)) {
    item.sessionData = {
      ...item.sessionData,
      accessToken: cancelled.accessToken || item.sessionData.accessToken,
      sessionToken: cancelled.sessionToken || item.sessionToken,
      sessionJson: cancelled.sessionJson || item.sessionData.sessionJson,
      user: cancelled.user || item.sessionData.user,
    };
  }
  if (cancelled?.accountId) item.accountId = cancelled.accountId;
  mergeCancelIntoSubscription(item);
}

function serializeItem(item) {
  return {
    index: item.index,
    email: item.email,
    accountDisplay: item.accountDisplay,
    subscriptionInfo: item.subscriptionInfo || null,
    cancelRenewal: publicCancelRenewal(item.cancelRenewal),
    billingStatus: item.billingStatus || 'idle',
    billingAction: item.billingAction || '',
    billingError: item.billingError || '',
    status: item.status,
    stage: item.stage,
    error: item.error,
    errorCategory: item.errorCategory || '',
    retryCount: item.retryCount || 0,
    canRetry: isRetryable(item),
    canAbort: item.status === 'running' && !item.abortRequested,
    aborting: item.status === 'running' && Boolean(item.abortRequested),
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
      success: items.filter((item) => item.status === 'success').length,
      failed: items.filter((item) => item.status === 'failed').length,
      cancelled: items.filter((item) => item.status === 'cancelled').length,
    },
    items,
    sessions: job.items
      .filter((item) => item.status === 'success' && item.sessionData?.sessionJson)
      .sort((a, b) => a.index - b.index)
      .map((item) => item.sessionData.sessionJson),
  };
}

export function createBatchManager({
  login,
  waitForOTP,
  getAccessToken,
  getSubscriptionInfo = async () => null,
  cancelRenewal = null,
  retentionMs = DEFAULT_RETENTION_MS,
  maxAccounts = DEFAULT_MAX_ACCOUNTS,
  now = () => Date.now(),
  onFinish = null,
} = {}) {
  if (typeof login !== 'function' || typeof waitForOTP !== 'function' || typeof getAccessToken !== 'function') {
    throw new TypeError('login、waitForOTP 和 getAccessToken 必须是函数');
  }

  const jobs = new Map();

  async function getSessionData(sessionToken, proxy) {
    const result = await getAccessToken(sessionToken, proxy);
    if (!result?.sessionJson || !result?.accessToken) {
      throw new Error('获取完整 Session 数据失败');
    }
    return result;
  }

  function clearSecrets(item) {
    item.gptPassword = '';
    item.mailPassword = '';
    item.proxy = null;
  }

  function maybeFinishJob(job) {
    const inFlight = job.items.some((item) => item.status === 'running' || item.status === 'pending');
    if (inFlight) return;
    job.status = job.cancelRequested ? 'cancelled' : 'completed';
    job.finishedAt = now();
    if (typeof onFinish === 'function') {
      void Promise.resolve(onFinish(serializeJob(job))).catch(() => {});
    }
  }

  // 失败多半是代理不可用，重试时重新抽一条，避免一直撞同一条死代理。
  function resetItemForRetry(item, proxies) {
    item.retryCount = (item.retryCount || 0) + 1;
    item.status = 'pending';
    item.stage = '等待重试';
    item.error = '';
    item.errorCategory = '';
    item.proxy = pickProxy(proxies, { avoid: item.proxy });
    item.sessionToken = '';
    item.sessionData = undefined;
    item.subscriptionInfo = null;
    item.cancelRenewal = null;
    item.billingStatus = 'idle';
    item.billingAction = '';
    item.billingError = '';
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

    const runLogin = () => login(
      { email: item.email, gptPassword: item.gptPassword },
      {
        password: item.gptPassword,
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
        result = await runLogin();
      } catch (error) {
        if (itemStopped(job, item) || !isRotatableMailError(error) || (job.proxies || []).length < 2) throw error;
        const switched = pickProxy(job.proxies, { avoid: item.proxy, state: job.proxyState });
        if (!switched || switched === item.proxy) throw error;
        item.proxy = switched;
        item.stage = '更换代理后重试登录';
        result = await runLogin();
      }

      if (itemStopped(job, item)) {
        item.status = 'cancelled';
        item.stage = '已取消';
        item.sessionToken = '';
        item.sessionData = undefined;
      } else if (!result?.sessionToken) {
        throw new Error('登录成功但未返回 session');
      } else {
        item.stage = '获取完整 Session 数据';
        const sessionData = await getSessionData(result.sessionToken, item.proxy);
        if (itemStopped(job, item)) {
          item.status = 'cancelled';
          item.stage = '已取消';
          item.sessionToken = '';
          item.sessionData = undefined;
        } else {
          item.sessionToken = sessionData.sessionToken || result.sessionToken;
          item.sessionData = sessionData;
          item.accountId = result.accountId || sessionData.user?.accountId || null;
          if (job.cancelRenewal && typeof cancelRenewal === 'function') {
            item.stage = '取消自动续费';
            try {
              const cancelled = await cancelRenewal({
                email: item.email,
                sessionToken: item.sessionToken,
                accessToken: sessionData.accessToken,
                accountId: item.accountId,
                sessionJson: sessionData.sessionJson,
              }, item.proxy);
              applyCancelResult(item, cancelled);
            } catch (error) {
              item.cancelRenewal = { ok: false, error: publicError(error) };
              mergeCancelIntoSubscription(item);
            }
          }
          if (itemStopped(job, item)) {
            item.status = 'cancelled';
            item.stage = '已取消';
            item.sessionToken = '';
            item.sessionData = undefined;
          } else {
            item.status = 'success';
            item.stage = '完成';
          }
        }
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
      // 成功后也保留凭据，便于 Session 过期后再次登录
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

  async function runJob(job) {
    await runItems(job, job.items);
  }

  function create({ input, proxies = '', concurrency = 2, cancelRenewal: cancelRenewalEnabled } = {}) {
    cleanup();
    const parsed = parseAccounts(input, { maxAccounts });
    const parsedProxies = parseProxyPool(proxies);
    const errors = [...parsed.errors, ...parsedProxies.errors.map((error) => ({ ...error, field: 'proxies' }))];
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
      cancelRenewal: cancelRenewalEnabled === true,
      proxies: parsedProxies.proxies,
      proxyState,
      items: parsed.accounts.map((account) => ({
        ...account,
        accountDisplay: account.gptPassword
          ? `${account.email}----${account.gptPassword}----${account.mailPassword}`
          : `${account.email}:${account.mailPassword}`,
        proxy: pickProxy(parsedProxies.proxies, { state: proxyState }),
        status: 'pending',
        stage: '等待开始',
        error: '',
        sessionToken: '',
        abortRequested: false,
        startedAt: null,
        finishedAt: null,
      })),
    };

    jobs.set(job.id, job);
    void runJob(job);
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
      if (item.status === 'running' || item.status === 'pending') {
        return { ok: false, status: 409, error: '该账号正在处理中' };
      }
      if (!isRetryable(item)) {
        return { ok: false, status: 400, error: '该账号当前不可重试' };
      }
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

  function resolveBillingTargets(job, { index, indexes, all } = {}) {
    const eligible = (item) => item.status === 'success' && item.sessionData;
    if (all === true) {
      const targets = job.items.filter((item) => eligible(item) && item.billingStatus !== 'running');
      if (!targets.length) {
        const busy = job.items.some((item) => eligible(item) && item.billingStatus === 'running');
        return { ok: false, status: busy ? 409 : 400, error: busy ? '已有套餐操作进行中' : '没有可操作的成功账号' };
      }
      return { ok: true, targets };
    }
    if (Array.isArray(indexes)) {
      const seen = new Set();
      const targets = [];
      for (const raw of indexes) {
        if (!Number.isInteger(raw) || raw < 0 || seen.has(raw)) continue;
        seen.add(raw);
        const item = job.items.find((entry) => entry.index === raw);
        if (item && eligible(item) && item.billingStatus !== 'running') targets.push(item);
      }
      if (!targets.length) return { ok: false, status: 400, error: '没有可操作的成功账号' };
      return { ok: true, targets };
    }
    if (Number.isInteger(index) && index >= 0) {
      const item = job.items.find((entry) => entry.index === index);
      if (!item) return { ok: false, status: 404, error: '账号不存在' };
      if (!eligible(item)) return { ok: false, status: 400, error: '该账号还没有可用 Session' };
      if (item.billingStatus === 'running') return { ok: false, status: 409, error: '该账号正在处理套餐操作' };
      return { ok: true, targets: [item] };
    }
    return { ok: false, status: 400, error: '请指定要操作的账号' };
  }

  async function runBillingItem(item, action) {
    item.billingStatus = 'running';
    item.billingAction = action;
    item.billingError = '';
    const sessionData = item.sessionData;
    try {
      if (action === 'query') {
        item.subscriptionInfo = await getSubscriptionInfo({
          email: item.email,
          accessToken: sessionData.accessToken,
          accountId: item.accountId || item.cancelRenewal?.accountId || sessionData.user?.accountId || null,
          sessionJson: sessionData.sessionJson,
        }, item.proxy) || { warnings: ['套餐信息暂不可用'] };
        mergeCancelIntoSubscription(item);
      } else {
        if (typeof cancelRenewal !== 'function') throw new Error('未配置取消续费能力');
        const cancelled = await cancelRenewal({
          email: item.email,
          sessionToken: item.sessionToken || sessionData.sessionToken,
          accessToken: sessionData.accessToken,
          accountId: item.accountId || sessionData.user?.accountId || null,
          sessionJson: sessionData.sessionJson,
        }, item.proxy);
        applyCancelResult(item, cancelled);
      }
      item.billingStatus = 'ok';
    } catch (error) {
      item.billingStatus = 'error';
      item.billingError = publicError(error);
      if (action === 'cancel') {
        item.cancelRenewal = { ok: false, error: item.billingError };
        mergeCancelIntoSubscription(item);
      } else {
        item.subscriptionInfo = {
          ...(item.subscriptionInfo || {}),
          warnings: [`套餐查询失败：${item.billingError}`],
        };
        mergeCancelIntoSubscription(item);
      }
    }
  }

  async function runBilling(job, targets, action) {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(job.concurrency, targets.length) }, async () => {
      while (cursor < targets.length) {
        const item = targets[cursor++];
        await runBillingItem(item, action);
      }
    });
    await Promise.all(workers);
  }

  function querySubscription(id, opts = {}) {
    cleanup();
    const job = jobs.get(id);
    if (!job) return { ok: false, status: 404, error: '任务不存在或已清理' };
    const resolved = resolveBillingTargets(job, opts);
    if (!resolved.ok) return resolved;
    for (const item of resolved.targets) {
      item.billingStatus = 'running';
      item.billingAction = 'query';
      item.billingError = '';
    }
    void runBilling(job, resolved.targets, 'query');
    return { ok: true, job: serializeJob(job) };
  }

  function cancelRenewalNow(id, opts = {}) {
    cleanup();
    const job = jobs.get(id);
    if (!job) return { ok: false, status: 404, error: '任务不存在或已清理' };
    const resolved = resolveBillingTargets(job, opts);
    if (!resolved.ok) return resolved;
    for (const item of resolved.targets) {
      item.billingStatus = 'running';
      item.billingAction = 'cancel';
      item.billingError = '';
    }
    void runBilling(job, resolved.targets, 'cancel');
    return { ok: true, job: serializeJob(job) };
  }

  return { create, get, cancel, abort, retry, querySubscription, cancelRenewalNow, cleanup };
}
