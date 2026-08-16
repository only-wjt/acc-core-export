import { getOpenApiDocs } from './openapi-spec.js';

function accountsToInput(accounts) {
  if (!Array.isArray(accounts) || !accounts.length) return '';
  return accounts.map((item) => {
    const email = String(item?.email || '').trim();
    const gptPassword = String(item?.gptPassword || item?.password || '').trim();
    const mailPassword = String(item?.mailPassword || item?.emailPassword || '').trim();
    if (gptPassword && mailPassword) return `${email}----${gptPassword}----${mailPassword}`;
    if (mailPassword) return `${email}:${mailPassword}`;
    return email;
  }).join('\n');
}

function checksToInput(items) {
  if (!Array.isArray(items) || !items.length) return '';
  return items.map((item) => {
    const email = String(item?.email || '').trim();
    const sessionToken = String(item?.sessionToken || item?.session || '').trim();
    if (email && sessionToken) return `${email}----${sessionToken}`;
    return sessionToken || email;
  }).join('\n');
}

function presentSessionJob(job) {
  if (!job) return null;
  let cursor = 0;
  const items = (job.items || []).map((item) => {
    const row = {
      email: item.email,
      status: item.status,
      stage: item.stage || '',
      error: item.error || '',
      errorCategory: item.errorCategory || '',
      subscriptionInfo: item.subscriptionInfo || null,
      sessionJson: null,
    };
    if (item.status === 'success') {
      row.sessionJson = job.sessions?.[cursor] || null;
      cursor += 1;
    }
    return row;
  });
  return {
    id: job.id,
    kind: 'session',
    status: job.status,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    concurrency: job.concurrency,
    counts: job.counts,
    items,
  };
}

function presentCheckJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    kind: 'check',
    status: job.status,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    concurrency: job.concurrency,
    counts: job.counts,
    items: (job.items || []).map((item) => ({
      email: item.email || '',
      status: item.status,
      alive: item.alive ?? null,
      reason: item.reason || '',
      plan: item.plan || '',
      error: item.error || '',
    })),
  };
}

export function createOpenApi({
  apiKeys,
  manager,
  checkManager,
  jobOwners,
  adminSettings,
  gpt,
  mail,
  corsOrigin = process.env.OPENAPI_CORS || '*',
} = {}) {
  function headers(extra = {}) {
    return {
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Api-Key',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    };
  }

  function send(res, status, data, extra = {}) {
    res.writeHead(status, headers({ 'Content-Type': 'application/json; charset=utf-8', ...extra }));
    res.end(JSON.stringify(data));
  }

  function rateHeaders(limit) {
    if (!limit) return {};
    return {
      'X-RateLimit-Limit': String(limit.limit),
      'X-RateLimit-Remaining': String(limit.remaining),
    };
  }

  function preflight(res) {
    res.writeHead(204, headers());
    res.end();
  }

  function client(req) {
    return apiKeys.authenticate(req);
  }

  function owns(req, id) {
    const key = client(req);
    return Boolean(key && jobOwners.get(id) === key.owner);
  }

  function createSessionJob(req, body) {
    const key = client(req);
    const input = String(body?.input || '').trim() || accountsToInput(body?.accounts);
    const result = manager.create({
      input,
      proxies: adminSettings.get().proxyText,
      concurrency: Math.max(1, Math.min(apiKeys.concurrencyLimit, key.concurrency)),
    });
    if (result.ok) jobOwners.set(result.job.id, key.owner);
    return result.ok
      ? { status: 202, data: presentSessionJob(result.job) }
      : { status: 400, data: { error: '请求无效', errors: result.errors } };
  }

  function createCheckJob(req, body) {
    const key = client(req);
    const input = String(body?.input || '').trim() || checksToInput(body?.items || body?.accounts);
    const result = checkManager.create({
      input,
      proxies: adminSettings.get().proxyText,
      concurrency: Math.max(1, Math.min(apiKeys.concurrencyLimit, key.concurrency)),
    });
    if (result.ok) jobOwners.set(result.job.id, key.owner);
    return result.ok
      ? { status: 202, data: presentCheckJob(result.job) }
      : { status: 400, data: { error: '请求无效', errors: result.errors } };
  }

  async function handle(req, res, url, body) {
    if (req.method === 'OPTIONS') {
      preflight(res);
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/openapi/v1/health') {
      send(res, 200, { ok: true, authRequired: apiKeys.enabled });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/openapi/v1/docs') {
      send(res, 200, getOpenApiDocs(apiKeys.limits()));
      return true;
    }

    if (!apiKeys.enabled) {
      send(res, 503, { error: '还没有可用的 API 密钥。请登录工作台「开放 API」页创建自己的密钥' });
      return true;
    }

    const key = client(req);
    if (!key) {
      send(res, 401, { error: '缺少或无效的 API Key。请使用 Authorization: Bearer <key> 或 X-Api-Key' });
      return true;
    }

    const quota = apiKeys.consume(key);
    if (!quota.ok) {
      send(res, 429, { error: '请求过于频繁', retryAfter: quota.retryAfter }, {
        'Retry-After': String(quota.retryAfter),
        ...rateHeaders(quota),
      });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/openapi/v1/me') {
      send(res, 200, {
        name: key.name,
        owner: key.username,
        concurrency: key.concurrency,
        rateLimitPerMinute: quota.limit,
        rateLimitCeiling: quota.ceiling,
        maxKeysPerUser: apiKeys.limits().maxKeysPerUser,
      }, rateHeaders(quota));
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/openapi/v1/sessions') {
      const result = createSessionJob(req, body);
      send(res, result.status, result.data);
      return true;
    }

    const sessionMatch = url.pathname.match(/^\/openapi\/v1\/sessions\/([0-9a-f-]+)(?:\/(cancel))?$/i);
    if (sessionMatch) {
      if (!owns(req, sessionMatch[1])) {
        send(res, 404, { error: '任务不存在或无权查看' });
        return true;
      }
      if (req.method === 'GET' && !sessionMatch[2]) {
        const job = manager.get(sessionMatch[1]);
        send(res, job ? 200 : 404, job ? presentSessionJob(job) : { error: '任务不存在或已清理' });
        return true;
      }
      if (req.method === 'POST' && sessionMatch[2] === 'cancel') {
        const job = manager.cancel(sessionMatch[1]);
        send(res, job ? 200 : 404, job ? presentSessionJob(job) : { error: '任务不存在或已清理' });
        return true;
      }
    }

    if (req.method === 'POST' && url.pathname === '/openapi/v1/checks') {
      const result = createCheckJob(req, body);
      send(res, result.status, result.data);
      return true;
    }

    const checkMatch = url.pathname.match(/^\/openapi\/v1\/checks\/([0-9a-f-]+)(?:\/(cancel))?$/i);
    if (checkMatch) {
      if (!owns(req, checkMatch[1])) {
        send(res, 404, { error: '任务不存在或无权查看' });
        return true;
      }
      if (req.method === 'GET' && !checkMatch[2]) {
        const job = checkManager.get(checkMatch[1]);
        send(res, job ? 200 : 404, job ? presentCheckJob(job) : { error: '任务不存在或已清理' });
        return true;
      }
      if (req.method === 'POST' && checkMatch[2] === 'cancel') {
        const job = checkManager.cancel(checkMatch[1]);
        send(res, job ? 200 : 404, job ? presentCheckJob(job) : { error: '任务不存在或已清理' });
        return true;
      }
    }

    if (req.method === 'POST' && url.pathname === '/openapi/v1/totp') {
      try {
        const code = gpt.totpCode(body.totpSecret);
        send(res, 200, { code, remainingMs: 30000 - (Date.now() % 30000) });
      } catch (error) {
        send(res, 400, { error: error.message || 'TOTP 无效' });
      }
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/openapi/v1/mail/otp') {
      if (!body.email || !body.password) {
        send(res, 400, { error: '请填写 email 和 password' });
        return true;
      }
      const found = body.wait
        ? { code: await mail.waitForOTP(body.email, body.password, { proxy: body.proxy || null, maxMs: 60000 }) }
        : await mail.findOTP(body.email, body.password, { proxy: body.proxy || null });
      send(res, 200, found || { code: null });
      return true;
    }

    send(res, 404, { error: '接口不存在' });
    return true;
  }

  return { handle, headers };
}
