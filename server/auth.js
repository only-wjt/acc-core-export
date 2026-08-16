import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CONCURRENCY_LIMIT } from './admin-settings.js';

const COOKIE = 'acc_session';
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function usersPath() {
  if (process.env.USERS_FILE) return resolve(process.env.USERS_FILE);
  const dir = process.env.PERSIST_DIR || process.env.DATA_DIR || 'data';
  return resolve(dir, 'users.json');
}

function hashPassword(password, salt = randomBytes(16)) {
  return {
    salt: salt.toString('hex'),
    hash: scryptSync(String(password), salt, 32).toString('hex'),
  };
}

function verifyPassword(password, saltHex, hashHex) {
  const got = scryptSync(String(password || ''), Buffer.from(saltHex, 'hex'), 32);
  const expected = Buffer.from(hashHex, 'hex');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

// 并发数按账号分配：管理员不限速，普通用户默认只给 1
function defaultConcurrency(role) {
  return role === 'admin' ? CONCURRENCY_LIMIT : 1;
}

function normalizeConcurrency(value, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return { ok: false, value: fallback };
  return { ok: true, value: Math.min(CONCURRENCY_LIMIT, number) };
}

function userConcurrency(user) {
  return normalizeConcurrency(user.concurrency, defaultConcurrency(user.role)).value;
}

function boundedRate(value, ceiling) {
  const cap = Math.max(1, Number(ceiling) || 60);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return { ok: false, value: cap };
  return { ok: true, value: Math.min(cap, parsed) };
}

function publicUser(user, ceiling = 60) {
  const concurrency = userConcurrency(user);
  const rate = boundedRate(user.apiRateLimit, ceiling);
  return {
    username: user.username,
    role: user.role,
    concurrency,
    apiRateLimit: rate.value,
    createdAt: user.createdAt || null,
  };
}

export function createAuth({
  password = process.env.WORKBENCH_ADMIN_PASSWORD || process.env.WORKBENCH_PASSWORD || '',
  adminUsername = process.env.WORKBENCH_ADMIN_USER || 'admin',
  bindHost = process.env.HOST || '127.0.0.1',
  file = usersPath(),
  ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(),
  getRateCeiling = () => Number(process.env.OPENAPI_RATE_LIMIT) || 60,
} = {}) {
  const adminName = normalizeUsername(adminUsername) || 'admin';
  let users = [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    users = Array.isArray(parsed.users) ? parsed.users : [];
  } catch {
    users = [];
  }

  let dirty = false;

  if (String(password || '').trim()) {
    const existing = users.find((user) => user.username === adminName);
    const hashed = hashPassword(password);
    if (existing) {
      existing.salt = hashed.salt;
      existing.hash = hashed.hash;
      existing.role = 'admin';
    } else {
      users.push({ username: adminName, role: 'admin', createdAt: now(), concurrency: CONCURRENCY_LIMIT, ...hashed });
    }
    dirty = true;
  }

  // 老记录里没有 concurrency 字段，读到就按角色补齐后写回
  for (const user of users) {
    const normalized = normalizeConcurrency(user.concurrency, defaultConcurrency(user.role));
    if (user.concurrency !== normalized.value) {
      user.concurrency = normalized.value;
      dirty = true;
    }
  }

  if (dirty && users.length) persist();

  const enabled = users.length > 0;
  if (!enabled && !isLoopbackHost(bindHost)) {
    throw new Error('绑定非本机地址时必须设置 WORKBENCH_PASSWORD，并创建管理员账号');
  }

  function ceiling() {
    const raw = Number(getRateCeiling());
    return Number.isInteger(raw) && raw > 0 ? Math.min(6000, raw) : 60;
  }

  function rateCapFor(user) {
    return user?.role === 'admin' ? 6000 : ceiling();
  }

  function present(user) {
    return publicUser(user, rateCapFor(user));
  }

  const sessions = new Map();

  function persist() {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ users }, null, 2)}\n`, 'utf8');
  }

  function parseCookie(req) {
    const raw = String(req.headers?.cookie || '');
    const match = raw.match(/(?:^|;\s*)acc_session=([a-f0-9]+)/i);
    return match?.[1] || '';
  }

  // 并发配额实时从用户表读，管理员改完不用等对方重新登录
  function concurrencyFor(username) {
    if (!enabled) return CONCURRENCY_LIMIT;
    const user = users.find((entry) => entry.username === normalizeUsername(username));
    return user ? userConcurrency(user) : 1;
  }

  function rateLimitFor(username) {
    if (!enabled) return ceiling();
    const user = users.find((entry) => entry.username === normalizeUsername(username));
    if (!user) return ceiling();
    return boundedRate(user.apiRateLimit, rateCapFor(user)).value;
  }

  function currentUser(req) {
    if (!enabled) {
      return { username: 'local', role: 'admin', concurrency: CONCURRENCY_LIMIT, apiRateLimit: ceiling() };
    }
    const token = parseCookie(req);
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= now()) {
      sessions.delete(token);
      return null;
    }
    return {
      username: session.username,
      role: session.role,
      concurrency: concurrencyFor(session.username),
      apiRateLimit: rateLimitFor(session.username),
    };
  }

  function authorized(req) {
    return Boolean(currentUser(req));
  }

  function login({ username, password: candidate } = {}) {
    if (!enabled) return { ok: true, skipped: true, user: { username: 'local', role: 'admin' } };
    const name = normalizeUsername(username) || adminName;
    const user = users.find((entry) => entry.username === name);
    if (!user || !verifyPassword(candidate, user.salt, user.hash)) {
      return { ok: false, error: '用户名或口令错误' };
    }
    const token = randomBytes(32).toString('hex');
    sessions.set(token, { username: user.username, role: user.role, expiresAt: now() + ttlMs });
    return { ok: true, token, maxAge: Math.floor(ttlMs / 1000), user: present(user) };
  }

  function logout(req) {
    const token = parseCookie(req);
    if (token) sessions.delete(token);
  }

  function listUsers() {
    return users.map(present);
  }

  function createUser({ username, password: candidate, role = 'user', concurrency, apiRateLimit } = {}) {
    const name = normalizeUsername(username);
    if (!name || name.length < 2) return { ok: false, error: '用户名至少 2 个字符' };
    if (!candidate || String(candidate).length < 4) return { ok: false, error: '口令至少 4 位' };
    if (!['admin', 'user'].includes(role)) return { ok: false, error: '角色只能是 admin 或 user' };
    if (users.some((user) => user.username === name)) return { ok: false, error: '用户名已存在' };
    const quota = normalizeConcurrency(concurrency === undefined ? 1 : concurrency, null);
    if (!quota.ok) return { ok: false, error: `并发数必须是 1 到 ${CONCURRENCY_LIMIT} 之间的整数` };
    const cap = role === 'admin' ? 6000 : ceiling();
    const rate = apiRateLimit === undefined ? { ok: true, value: Math.min(ceiling(), cap) } : boundedRate(apiRateLimit, cap);
    if (apiRateLimit !== undefined && (!Number.isInteger(Number(apiRateLimit)) || Number(apiRateLimit) < 1 || Number(apiRateLimit) > cap)) {
      return { ok: false, error: role === 'admin'
        ? '管理员每分钟请求数必须是 1 到 6000 的整数'
        : `每分钟请求数必须是 1 到 ${cap} 的整数` };
    }
    const user = {
      username: name,
      role,
      createdAt: now(),
      concurrency: quota.value,
      apiRateLimit: rate.value,
      ...hashPassword(candidate),
    };
    users.push(user);
    persist();
    return { ok: true, user: present(user) };
  }

  function applyRateLimit(user, apiRateLimit) {
    const cap = rateCapFor(user);
    const parsed = Number(apiRateLimit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return { ok: false, error: `每分钟请求数必须是 1 到 ${cap} 的整数` };
    }
    if (parsed > cap) {
      return { ok: false, error: user.role === 'admin'
        ? '管理员自己的请求数上限是 6000 次/分钟'
        : `不能超过通用设置的每用户上限 ${cap} 次/分钟` };
    }
    user.apiRateLimit = parsed;
    return { ok: true };
  }

  function updateUser(username, { concurrency, apiRateLimit } = {}) {
    const name = normalizeUsername(username);
    const user = users.find((entry) => entry.username === name);
    if (!user) return { ok: false, error: '用户不存在' };
    if (concurrency === undefined && apiRateLimit === undefined) return { ok: false, error: '没有需要修改的内容' };
    if (concurrency !== undefined) {
      const quota = normalizeConcurrency(concurrency, null);
      if (!quota.ok) return { ok: false, error: `并发数必须是 1 到 ${CONCURRENCY_LIMIT} 之间的整数` };
      user.concurrency = quota.value;
    }
    if (apiRateLimit !== undefined) {
      const rate = applyRateLimit(user, apiRateLimit);
      if (!rate.ok) return rate;
    }
    persist();
    return { ok: true, user: present(user) };
  }

  function deleteUser(username, actor) {
    const name = normalizeUsername(username);
    if (name === actor) return { ok: false, error: '不能删除当前登录账号' };
    const index = users.findIndex((user) => user.username === name);
    if (index < 0) return { ok: false, error: '用户不存在' };
    if (users[index].role === 'admin' && users.filter((user) => user.role === 'admin').length === 1) {
      return { ok: false, error: '不能删除最后一个管理员' };
    }
    users.splice(index, 1);
    for (const [token, session] of sessions) {
      if (session.username === name) sessions.delete(token);
    }
    persist();
    return { ok: true };
  }

  function cookieHeader(token, maxAge) {
    const parts = [
      `${COOKIE}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${maxAge}`,
    ];
    if (process.env.SECURE_COOKIE === '1') parts.push('Secure');
    return parts.join('; ');
  }

  function clearCookieHeader() {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  }

  function isPublicPath(pathname) {
    return pathname === '/api/meta'
      || pathname === '/api/auth/login'
      || pathname === '/api/auth/status';
  }

  return {
    enabled,
    file,
    concurrencyLimit: CONCURRENCY_LIMIT,
    authorized,
    currentUser,
    concurrencyFor,
    rateLimitFor,
    login,
    logout,
    listUsers,
    createUser,
    updateUser,
    deleteUser,
    cookieHeader,
    clearCookieHeader,
    isPublicPath,
  };
}
