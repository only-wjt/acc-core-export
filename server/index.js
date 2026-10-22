import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as gpt from '../src/gpt-session.js';
import * as mail from '../src/mail.js';
import { getSubscriptionInfo, cancelRenewal } from '../src/gpt-subscription.js';
import { shutdownCycleTLS } from '../src/ctls.js';
import { createBatchManager } from './batch-session.js';
import { createCheckManager } from './batch-check.js';
import { createPasswordManager } from './batch-password.js';
import { createAuth } from './auth.js';
import { createStore } from './persist.js';
import { createAdminSettings } from './admin-settings.js';
import { createApiKeys } from './api-keys.js';
import { createOpenApi } from './openapi.js';
import { authorizeCodexAccount } from '../src/codex-oauth.js';
import { getOpenApiDocs } from './openapi-spec.js';
import { createProxyChecker } from '../src/proxy-check.js';
import { parseProxyPool } from './batch-session.js';
import { createLogger, summarizeJob } from './logger.js';
import { createRuntimeKeeper } from './runtime-snapshot.js';
import { createSub2Sidecar } from './sub2api-sidecar.js';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 3780;
const MAX_BODY_BYTES = 1024 * 1024;
const root = resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const store = createStore();
const adminSettings = createAdminSettings();
const auth = createAuth({
  bindHost: HOST,
  getRateCeiling: () => adminSettings.get().apiRateLimit,
});
const apiKeys = createApiKeys({
  getLimits: () => {
    const settings = adminSettings.get();
    return { maxKeysPerUser: settings.maxApiKeys, rateLimitPerMinute: settings.apiRateLimit };
  },
  getUserRateLimit: (username) => auth.rateLimitFor(username),
});
const proxyChecker = createProxyChecker();
const logger = createLogger();
const jobOwners = new Map();

// 任务结束时先打一条结构化摘要（失败原因分类 → 降载信号），再落盘。
function recordJob(kind, job) {
  const summary = summarizeJob(kind, job);
  const skewed = (summary.categories.proxy || 0) + (summary.categories.region || 0) + (summary.categories.risk || 0);
  const level = summary.failed > 0 && skewed >= Math.max(1, Math.ceil(summary.failed / 2)) ? 'warn' : 'info';
  logger[level](`批量任务完成 ${kind}`, summary);
  void store.clearRuntime(kind, job.id).catch(() => {});
  return store.saveJob(kind, job, { owner: jobOwners.get(job.id) || 'local' });
}
const manager = createBatchManager({
  login: gpt.login,
  waitForOTP: mail.waitForOTP,
  getAccessToken: gpt.getAccessToken,
  getSubscriptionInfo,
  cancelRenewal,
  onFinish: (job) => recordJob('session', job),
});
const checkManager = createCheckManager({
  checkAlive: gpt.checkAlive,
  onFinish: (job) => recordJob('check', job),
});
const passwordManager = createPasswordManager({
  addPassword: gpt.addPassword,
  waitForOTP: mail.waitForOTP,
  onFinish: (job) => recordJob('password', job),
});
const openApi = createOpenApi({
  apiKeys,
  manager,
  checkManager,
  passwordManager,
  jobOwners,
  adminSettings,
  gpt,
  mail,
  authorizeCodex: authorizeCodexAccount,
});

// toSub2 作为一个受管子进程托管：配置走 adminSettings 回调，管理员在设置页改完立即生效，
// 不需要重启本进程。见 server/sub2api-sidecar.js
const sub2 = createSub2Sidecar({
  logger,
  getConfig: () => {
    const settings = adminSettings.get();
    return {
      enabled: settings.sub2Enabled,
      rootDir: settings.sub2Root,
      port: settings.sub2Port,
    };
  },
});

// 运行中任务快照与重启恢复，见 server/runtime-snapshot.js
const runtimeKeeper = createRuntimeKeeper({
  store,
  managers: { session: manager, check: checkManager, password: passwordManager },
  jobOwners,
  logger,
});

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function securityHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    ...extra,
  };
}

function redirect(res, location) {
  res.writeHead(302, securityHeaders({ Location: location }));
  res.end();
}

function json(res, status, data) {
  res.writeHead(status, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8' }));
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('请求内容过大');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    const error = new Error('JSON 格式无效');
    error.status = 400;
    throw error;
  }
}

function validHost(req) {
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  const extra = String(process.env.ALLOWED_HOSTS || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || extra.includes(host);
}

function publicError(error) {
  return String(error?.message || error || '未知错误')
    .replace(/(__Secure-next-auth\.session-token(?:\.\d+)?=)[^;\s]+/gi, '$1[已隐藏]')
    .replace(/(accessToken|sessionToken|password|cookie)\s*[:=]\s*[^\s,;]+/gi, '$1=[已隐藏]')
    .slice(0, 400);
}

async function serveStatic(pathname, res) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    json(res, 403, { error: '禁止访问' });
    return;
  }

  try {
    const body = await readFile(target);
    res.writeHead(200, securityHeaders({
      'Content-Type': contentTypes[extname(target)] || 'application/octet-stream',
    }));
    res.end(body);
  } catch (error) {
    json(res, error.code === 'ENOENT' ? 404 : 500, { error: error.code === 'ENOENT' ? '页面不存在' : '读取页面失败' });
  }
}

// 任务只对创建者和管理员可见，否则拿到别人的任务 id 就能看别人的号
function ownsJob(req, id) {
  const user = auth.currentUser(req);
  if (!user) return false;
  if (user.role === 'admin') return true;
  return jobOwners.get(id) === user.username;
}

function resolveJobConcurrency(req, body) {
  const user = auth.currentUser(req);
  const quota = auth.concurrencyFor(user?.username);
  const requested = Number(body?.concurrency);
  const canOverride = user?.role === 'admin' && Number.isInteger(requested) && requested > 0;
  return Math.max(1, Math.min(auth.concurrencyLimit, canOverride ? requested : quota));
}

function handleJobRoutes(kind, req, url, res, body) {
  const routes = {
    session: { prefix: '/api/jobs', mgr: manager, abort: true },
    check: { prefix: '/api/checks', mgr: checkManager, abort: false },
    password: { prefix: '/api/passwords', mgr: passwordManager, abort: true },
  };
  const route = routes[kind];
  if (!route) return false;
  const { prefix, mgr } = route;
  const user = auth.currentUser(req);
  const match = url.pathname.match(new RegExp(`^${prefix}/([0-9a-f-]+)(?:/(cancel-renewal|subscription|cancel|retry|abort))?$`, 'i'));
  if (req.method === 'POST' && url.pathname === prefix) {
    // 代理池只认管理员配置；并发数按创建者的账号配额，普通用户传了也不算
    const settings = adminSettings.get();
    const result = mgr.create({
      ...(body || {}),
      proxies: settings.proxyText,
      concurrency: resolveJobConcurrency(req, body),
    });
    if (result.ok) jobOwners.set(result.job.id, user?.username || 'local');
    json(res, result.ok ? 202 : 400, result.ok ? result.job : { errors: result.errors });
    return true;
  }
  if (!match) return false;
  if (!ownsJob(req, match[1])) {
    json(res, 404, { error: '任务不存在或已清理' });
    return true;
  }
  if (req.method === 'GET' && !match[2]) {
    const job = mgr.get(match[1]);
    json(res, job ? 200 : 404, job || { error: '任务不存在或已清理' });
    return true;
  }
  if (req.method === 'POST' && match[2] === 'cancel') {
    const job = mgr.cancel(match[1]);
    json(res, job ? 200 : 404, job || { error: '任务不存在或已清理' });
    return true;
  }
  if (route.abort && req.method === 'POST' && match[2] === 'abort') {
    const result = mgr.abort(match[1], body || {});
    if (!result.ok) {
      json(res, result.status || 400, { error: result.error });
      return true;
    }
    json(res, 202, result.job);
    return true;
  }
  if (req.method === 'POST' && match[2] === 'retry') {
    const patch = { ...(body || {}) };
    if (Number.isInteger(Number(body?.concurrency)) && Number(body.concurrency) > 0) {
      patch.concurrency = resolveJobConcurrency(req, body);
    } else {
      delete patch.concurrency;
    }
    const result = mgr.retry(match[1], patch);
    if (!result.ok) {
      json(res, result.status || 400, { error: result.error });
      return true;
    }
    json(res, 202, result.job);
    return true;
  }
  if (kind === 'session' && req.method === 'POST' && match[2] === 'subscription') {
    const result = mgr.querySubscription(match[1], body || {});
    if (!result.ok) {
      json(res, result.status || 400, { error: result.error });
      return true;
    }
    json(res, 202, result.job);
    return true;
  }
  if (kind === 'session' && req.method === 'POST' && match[2] === 'cancel-renewal') {
    const result = mgr.cancelRenewalNow(match[1], body || {});
    if (!result.ok) {
      json(res, result.status || 400, { error: result.error });
      return true;
    }
    json(res, 202, result.job);
    return true;
  }
  return false;
}

// 用户管理：管理员增删改查用户，以及任意登录用户查看/更新自己（/api/me）。
function handleUserRoutes(req, url, res, body) {
  if (req.method === 'GET' && url.pathname === '/api/users') {
    if (auth.currentUser(req)?.role !== 'admin') {
      json(res, 403, { error: '仅管理员可查看用户' });
      return true;
    }
    json(res, 200, {
      users: auth.listUsers(),
      concurrencyLimit: auth.concurrencyLimit,
      rateLimitCeiling: adminSettings.get().apiRateLimit,
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/users') {
    if (auth.currentUser(req)?.role !== 'admin') {
      json(res, 403, { error: '仅管理员可创建用户' });
      return true;
    }
    const result = auth.createUser(body);
    json(res, result.ok ? 201 : 400, result.ok ? result.user : { error: result.error });
    return true;
  }

  const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && req.method === 'PUT') {
    if (auth.currentUser(req)?.role !== 'admin') {
      json(res, 403, { error: '仅管理员可修改用户' });
      return true;
    }
    const result = auth.updateUser(decodeURIComponent(userMatch[1]), {
      concurrency: body?.concurrency,
      apiRateLimit: body?.apiRateLimit,
    });
    json(res, result.ok ? 200 : 400, result.ok ? result.user : { error: result.error });
    return true;
  }

  if (userMatch && req.method === 'DELETE') {
    const actor = auth.currentUser(req);
    if (actor?.role !== 'admin') {
      json(res, 403, { error: '仅管理员可删除用户' });
      return true;
    }
    const result = auth.deleteUser(decodeURIComponent(userMatch[1]), actor.username);
    json(res, result.ok ? 200 : 400, result.ok ? { ok: true } : { error: result.error });
    return true;
  }

  if (url.pathname === '/api/me' && (req.method === 'GET' || req.method === 'PUT')) {
    const actor = auth.currentUser(req);
    if (!actor) {
      json(res, 401, { error: '请先登录' });
      return true;
    }
    if (req.method === 'GET') {
      json(res, 200, { user: actor, rateLimitCeiling: adminSettings.get().apiRateLimit });
      return true;
    }
    const result = auth.updateUser(actor.username, { apiRateLimit: body?.apiRateLimit });
    json(res, result.ok ? 200 : 400, result.ok
      ? { user: result.user, rateLimitCeiling: adminSettings.get().apiRateLimit }
      : { error: result.error });
    return true;
  }

  return false;
}

// 单账号即时操作：TOTP、邮箱收信/取码/找链接、2FA 增删、改密。
// 都在全局鉴权之后、属于已登录用户的即时调用，逻辑与各端点一一对应。
async function handleAccountOps(req, url, res, body) {
  if (req.method !== 'POST') return false;

  if (url.pathname === '/api/totp') {
    try {
      const code = gpt.totpCode(body.totpSecret);
      const remainingMs = 30000 - (Date.now() % 30000);
      json(res, 200, { code, remainingMs });
    } catch (error) {
      json(res, 400, { error: publicError(error) });
    }
    return true;
  }

  if (url.pathname === '/api/mail/list') {
    if (!body.email || !body.password) {
      json(res, 400, { error: '请填写邮箱和密码' });
      return true;
    }
    const result = await mail.listMail(body.email, body.password, { proxy: body.proxy || null, size: 30 });
    json(res, 200, result);
    return true;
  }

  if (url.pathname === '/api/mail/otp') {
    if (!body.email || !body.password) {
      json(res, 400, { error: '请填写邮箱和密码' });
      return true;
    }
    const found = body.wait
      ? { code: await mail.waitForOTP(body.email, body.password, { proxy: body.proxy || null, maxMs: 60000 }) }
      : await mail.findOTP(body.email, body.password, { proxy: body.proxy || null });
    json(res, 200, found || { code: null });
    return true;
  }

  if (url.pathname === '/api/mail/link') {
    if (!body.email || !body.password || !body.pattern) {
      json(res, 400, { error: '请填写邮箱、密码和链接匹配规则' });
      return true;
    }
    const found = await mail.findLink(body.email, body.password, {
      pattern: body.pattern,
      proxy: body.proxy || null,
    });
    json(res, 200, found || { link: null });
    return true;
  }

  if (url.pathname === '/api/mfa/enable') {
    const result = await gpt.enableMfa(
      { email: body.email, gptPassword: body.gptPassword, sessionToken: body.sessionToken },
      {
        password: body.gptPassword,
        totpSecret: body.totpSecret || null,
        getOtp: body.mailPassword
          ? () => mail.waitForOTP(body.email, body.mailPassword, { proxy: body.proxy || null, maxMs: 180000 })
          : undefined,
        proxy: body.proxy || null,
      },
    );
    json(res, 200, { ok: true, totpSecret: result.totpSecret || result.secret || null, message: result.message || '已开启 2FA' });
    return true;
  }

  if (url.pathname === '/api/mfa/disable') {
    const result = await gpt.disableMfa(
      { email: body.email, gptPassword: body.gptPassword, totpSecret: body.totpSecret, sessionToken: body.sessionToken },
      { password: body.gptPassword, totpSecret: body.totpSecret, proxy: body.proxy || null },
    );
    json(res, 200, { ok: true, alreadyDisabled: result.alreadyDisabled || false, message: result.message || '已关闭 2FA' });
    return true;
  }

  if (url.pathname === '/api/password/gpt') {
    const getOtp = body.mailPassword
      ? () => mail.waitForOTP(body.email, body.mailPassword, { proxy: body.proxy || null, maxMs: 180000 })
      : undefined;
    const result = await gpt.changePassword(
      { email: body.email, gptPassword: body.gptPassword, totpSecret: body.totpSecret, sessionToken: body.sessionToken },
      {
        currentPassword: body.gptPassword,
        newPassword: body.newPassword,
        totpSecret: body.totpSecret || null,
        getOtp,
        proxy: body.proxy || null,
      },
    );
    json(res, 200, { ok: Boolean(result?.ok), message: 'GPT 密码已修改' });
    return true;
  }

  if (url.pathname === '/api/password/gpt-add') {
    if (!body.email || !body.mailPassword) {
      json(res, 400, { error: '请填写邮箱和邮箱密码' });
      return true;
    }
    const newPassword = body.newPassword
      ? gpt.assertGptPassword(body.newPassword)
      : gpt.generateGptPassword();
    const result = await gpt.addPassword(
      { email: body.email, totpSecret: body.totpSecret, sessionToken: body.sessionToken },
      {
        newPassword,
        totpSecret: body.totpSecret || null,
        getOtp: () => mail.waitForOTP(body.email, body.mailPassword, { proxy: body.proxy || null, maxMs: 180000 }),
        proxy: body.proxy || null,
      },
    );
    json(res, 200, {
      ok: Boolean(result?.ok),
      newPassword: result.newPassword || newPassword,
      line: `${body.email}----${result.newPassword || newPassword}----${body.mailPassword}`,
      message: '已添加 GPT 密码',
    });
    return true;
  }

  if (url.pathname === '/api/password/mail') {
    await mail.changePassword(body.email, body.password, body.newPassword, body.proxy || null);
    json(res, 200, { ok: true, message: '邮箱密码已修改' });
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  const isOpenApi = url.pathname.startsWith('/openapi/');
  if (!isOpenApi && !validHost(req)) {
    json(res, 403, { error: '仅允许本机或 ALLOWED_HOSTS 访问' });
    return;
  }

  try {
    const needsBody = req.method === 'POST' || req.method === 'PUT';
    const body = needsBody && (url.pathname.startsWith('/api/') || isOpenApi) ? await readJson(req) : {};

    if (isOpenApi) {
      await openApi.handle(req, res, url, body);
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/api/health')) {
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/meta') {
      json(res, 200, {
        authRequired: auth.enabled,
        persistEnabled: store.enabled,
        openApiEnabled: apiKeys.enabled,
        host: HOST,
        port: PORT,
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/auth/status') {
      const user = auth.currentUser(req);
      json(res, 200, { authRequired: auth.enabled, authorized: Boolean(user), user });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const result = auth.login({ username: body.username, password: body.password });
      if (!result.ok) {
        json(res, 401, { error: result.error });
        return;
      }
      const headers = result.token
        ? securityHeaders({
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': auth.cookieHeader(result.token, result.maxAge),
        })
        : securityHeaders({ 'Content-Type': 'application/json; charset=utf-8' });
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true, user: result.user }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      auth.logout(req);
      res.writeHead(200, securityHeaders({
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': auth.clearCookieHeader(),
      }));
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (auth.enabled && url.pathname.startsWith('/api/') && !auth.isPublicPath(url.pathname) && !auth.authorized(req)) {
      json(res, 401, { error: '请先登录' });
      return;
    }

    // toSub2 的接口一律管理员专属：token 能直接驱动那个进程跑账号任务，普通用户不能碰。
    if (url.pathname === '/api/sub2' || url.pathname.startsWith('/api/sub2/')) {
      if (auth.currentUser(req)?.role !== 'admin') {
        json(res, 403, { error: '仅管理员可使用 toSub2' });
        return;
      }
      // console token 只在服务端用于代发请求，绝不下发浏览器——拿到它就能直接操纵子进程。
      const publicState = ({ token, ...rest }) => rest;
      if (req.method === 'GET' && url.pathname === '/api/sub2/status') {
        json(res, 200, publicState(sub2.status()));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/sub2/start') {
        const state = await sub2.start();
        json(res, state.error ? 502 : 200, publicState(state));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/sub2/stop') {
        await sub2.stop();
        json(res, 200, publicState(sub2.status()));
        return;
      }
      // /api/sub2/api/jobs => toSub2 的 /api/jobs；只透传 JSON 接口，不碰它的 SPA
      if (url.pathname.startsWith('/api/sub2/api/') && (req.method === 'GET' || req.method === 'POST')) {
        const subPath = url.pathname.slice('/api/sub2/api/'.length) + url.search;
        try {
          await sub2.ensureReady();
        } catch (error) {
          json(res, 503, { error: publicError(error) });
          return;
        }
        await sub2.proxy(req, res, subPath, req.method === 'POST' ? body : undefined);
        return;
      }
      json(res, 404, { error: '接口不存在' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/history') {
      const user = auth.currentUser(req);
      const kind = url.searchParams.get('kind') || '';
      const result = await store.search({
        owner: user?.username,
        isAdmin: user?.role === 'admin',
        kind: ['session', 'check', 'password'].includes(kind) ? kind : '',
        q: url.searchParams.get('q') || '',
        page: Number(url.searchParams.get('page')) || 1,
        pageSize: Number(url.searchParams.get('pageSize')) || 20,
      });
      json(res, 200, { ...result, persistEnabled: store.enabled });
      return;
    }

    const historyMatch = url.pathname.match(/^\/api\/history\/([\w.-]+)$/);
    if (historyMatch && req.method === 'GET') {
      const user = auth.currentUser(req);
      const detail = await store.readJob(historyMatch[1], {
        owner: user?.username,
        isAdmin: user?.role === 'admin',
      });
      json(res, detail ? 200 : 404, detail || { error: '归档不存在或无权查看' });
      return;
    }

    if (url.pathname === '/api/settings') {
      if (auth.currentUser(req)?.role !== 'admin') {
        json(res, 403, { error: '仅管理员可查看或修改运行配置' });
        return;
      }
      if (req.method === 'GET') {
        json(res, 200, adminSettings.get());
        return;
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const result = adminSettings.update(body || {});
        json(res, result.ok ? 200 : 400, result.ok
          ? { settings: result.settings, notes: result.notes }
          : { errors: result.errors });
        return;
      }
      json(res, 405, { error: '请求方法不支持' });
      return;
    }

    // 代理预检：逐条查出口 IP/国家，标出落在不支持地区（如香港）的代理。
    // 直接回答"香港代理为什么连不上 ChatGPT"——出口在 HK 的会被标为 supported:false。
    if (req.method === 'POST' && url.pathname === '/api/proxy/preflight') {
      if (auth.currentUser(req)?.role !== 'admin') {
        json(res, 403, { error: '仅管理员可检测代理' });
        return;
      }
      const source = typeof body?.proxies === 'string' && body.proxies.trim()
        ? body.proxies
        : adminSettings.get().proxyText;
      const { proxies, errors } = parseProxyPool(source || '');
      if (errors.length) {
        json(res, 400, { errors });
        return;
      }
      if (!proxies.length) {
        json(res, 400, { error: '代理池为空，请先在设置里配置代理' });
        return;
      }
      const results = await proxyChecker.checkProxies(proxies, { concurrency: 5 });
      json(res, 200, {
        results,
        summary: {
          total: results.length,
          unsupported: results.filter((item) => item.supported === false).length,
          dead: results.filter((item) => !item.ok).length,
        },
      });
      return;
    }

    if (handleUserRoutes(req, url, res, body)) return;

    if (req.method === 'GET' && url.pathname === '/api/openapi/docs') {
      json(res, 200, getOpenApiDocs(apiKeys.limits()));
      return;
    }

    if (url.pathname === '/api/apikeys' || url.pathname.startsWith('/api/apikeys/')) {
      const actor = auth.currentUser(req);
      if (!actor) {
        json(res, 401, { error: '请先登录' });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/apikeys') {
        json(res, 200, {
          keys: apiKeys.list(actor),
          ...apiKeys.limits(),
          myRateLimit: actor.apiRateLimit,
          concurrencyLimit: actor.role === 'admin' ? apiKeys.concurrencyLimit : actor.concurrency,
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/apikeys') {
        const result = apiKeys.create({ ...body, actor });
        json(res, result.ok ? 201 : 400, result.ok ? result : { error: result.error });
        return;
      }
      const keyMatch = url.pathname.match(/^\/api\/apikeys\/([^/]+)$/);
      if (keyMatch && req.method === 'PUT') {
        const result = apiKeys.update(decodeURIComponent(keyMatch[1]), { concurrency: body?.concurrency }, actor);
        json(res, result.ok ? 200 : 400, result.ok ? result.item : { error: result.error });
        return;
      }
      if (keyMatch && req.method === 'DELETE') {
        const result = apiKeys.revoke(decodeURIComponent(keyMatch[1]), actor);
        json(res, result.ok ? 200 : 400, result.ok ? { ok: true } : { error: result.error });
        return;
      }
      json(res, 405, { error: '请求方法不支持' });
      return;
    }

    if (handleJobRoutes('session', req, url, res, body)) return;
    if (handleJobRoutes('check', req, url, res, body)) return;
    if (handleJobRoutes('password', req, url, res, body)) return;

    if (await handleAccountOps(req, url, res, body)) return;

    if (url.pathname.startsWith('/api/')) {
      json(res, 404, { error: '接口不存在' });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      json(res, 405, { error: '请求方法不支持' });
      return;
    }

    // 登录是独立页面：没登录进不了工作台，登录过也不用再看登录页
    const isLoginPage = url.pathname === '/login' || url.pathname === '/login.html';
    const isWorkspacePage = url.pathname === '/' || url.pathname === '/index.html';
    if (isLoginPage) {
      if (!auth.enabled || auth.authorized(req)) {
        redirect(res, '/');
        return;
      }
      await serveStatic('/login.html', res);
      return;
    }
    if (isWorkspacePage && auth.enabled && !auth.authorized(req)) {
      redirect(res, '/login');
      return;
    }

    await serveStatic(url.pathname, res);
  } catch (error) {
    json(res, error.status || 500, { error: error.status ? error.message : publicError(error) });
  }
});

server.listen(PORT, HOST, () => {
  const authHint = auth.enabled ? '已启用口令登录' : '本机模式，未启用口令';
  const persistHint = store.enabled ? `结果目录 ${store.dir}` : '不落盘';
  logger.info(`Session 工作台已启动：http://${HOST}:${PORT}（${authHint}；${persistHint}）`);

  // 先把上次遗留的快照归档，再开始定时写新的。
  void runtimeKeeper.recover().catch((error) => logger.error('恢复中断任务失败', { error: String(error?.message || error) }));
  runtimeKeeper.start();
});

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  runtimeKeeper.stop();
  // 子进程不跟着父进程走：不显式停掉，它会一直占着端口变成孤儿。
  await sub2.stop().catch(() => {});
  // 退出前再存一次，尽量留住正在跑的进度
  await runtimeKeeper.snapshotRunning().catch(() => {});
  server.close();
  await shutdownCycleTLS().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', close);
process.on('SIGTERM', close);
