import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CONCURRENCY_LIMIT } from './admin-settings.js';

const DEFAULT_CONCURRENCY = 4;
const KEY_PREFIX = 'acc_';

function keysPath() {
  if (process.env.API_KEYS_FILE) return resolve(process.env.API_KEYS_FILE);
  const dir = process.env.PERSIST_DIR || process.env.DATA_DIR || 'data';
  return resolve(dir, 'api-keys.json');
}

function hashKey(raw, salt = randomBytes(16)) {
  const saltHex = Buffer.isBuffer(salt) ? salt.toString('hex') : String(salt);
  return {
    salt: saltHex,
    hash: createHash('sha256').update(`${saltHex}:${raw}`).digest('hex'),
  };
}

function verifyKey(raw, saltHex, hashHex) {
  const got = Buffer.from(hashKey(raw, saltHex).hash, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

function normalizeConcurrency(value, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return { ok: false, value: fallback };
  return { ok: true, value: Math.min(CONCURRENCY_LIMIT, number) };
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function publicKey(entry) {
  return {
    id: entry.id,
    name: entry.name,
    owner: entry.owner || 'admin',
    prefix: entry.prefix,
    concurrency: entry.concurrency,
    createdAt: entry.createdAt || null,
    lastUsedAt: entry.lastUsedAt || null,
    source: entry.source || 'manual',
  };
}

function newSecret() {
  return `${KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
}

function extractSecret(req) {
  const header = String(req.headers?.authorization || '');
  const bearer = header.match(/^Bearer\s+(\S+)/i);
  if (bearer) return bearer[1];
  const apiKey = req.headers?.['x-api-key'];
  return apiKey ? String(apiKey).trim() : '';
}

export function createApiKeys({
  file = keysPath(),
  envKey = process.env.OPENAPI_KEY || '',
  now = () => Date.now(),
  getLimits = () => ({
    maxKeysPerUser: boundedInt(process.env.OPENAPI_MAX_KEYS, 3, 1, 20),
    rateLimitPerMinute: boundedInt(process.env.OPENAPI_RATE_LIMIT, 60, 1, 6000),
  }),
  getUserRateLimit = (username, ceiling) => ceiling,
} = {}) {
  let keys = [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    keys = Array.isArray(parsed.keys) ? parsed.keys : [];
  } catch {
    keys = [];
  }

  function persist() {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ keys }, null, 2)}\n`, 'utf8');
  }

  const bootstrap = String(envKey || '').trim();
  if (bootstrap) {
    const hashed = hashKey(bootstrap);
    const existing = keys.find((entry) => entry.id === 'env');
    if (existing) {
      existing.salt = hashed.salt;
      existing.hash = hashed.hash;
      existing.prefix = bootstrap.slice(0, 12);
      existing.source = 'env';
      existing.owner = existing.owner || 'admin';
    } else {
      keys.push({
        id: 'env',
        name: 'OPENAPI_KEY',
        owner: 'admin',
        prefix: bootstrap.slice(0, 12),
        concurrency: DEFAULT_CONCURRENCY,
        createdAt: now(),
        lastUsedAt: null,
        source: 'env',
        ...hashed,
      });
    }
    persist();
  }

  for (const entry of keys) {
    if (!entry.owner) entry.owner = entry.source === 'env' ? 'admin' : 'admin';
  }

  function limits() {
    const raw = getLimits() || {};
    return {
      maxKeysPerUser: boundedInt(raw.maxKeysPerUser, 3, 1, 20),
      rateLimitPerMinute: boundedInt(raw.rateLimitPerMinute, 60, 1, 6000),
    };
  }

  function canAccess(entry, actor) {
    if (!entry || !actor) return false;
    return actor.role === 'admin' || entry.owner === actor.username;
  }

  function list(actor) {
    const rows = keys.map(publicKey);
    if (!actor || actor.role === 'admin') return rows;
    return rows.filter((item) => item.owner === actor.username);
  }

  function create({ name, concurrency, actor } = {}) {
    const owner = actor?.username || 'local';
    const label = String(name || '').trim();
    if (!label || label.length < 2) return { ok: false, error: '名称至少 2 个字符' };
    if (keys.some((entry) => entry.owner === owner && entry.name === label)) {
      return { ok: false, error: '你已经有同名密钥' };
    }
    const cap = limits().maxKeysPerUser;
    if (keys.filter((entry) => entry.owner === owner).length >= cap) {
      return { ok: false, error: `每名用户最多 ${cap} 把密钥` };
    }
    const concurrencyCap = actor?.role === 'admin' ? CONCURRENCY_LIMIT : Math.max(1, Number(actor?.concurrency) || 1);
    const fallback = actor?.role === 'admin' ? Math.min(DEFAULT_CONCURRENCY, concurrencyCap) : concurrencyCap;
    const quota = normalizeConcurrency(concurrency === undefined ? fallback : concurrency, fallback);
    if (!quota.ok || quota.value > concurrencyCap) {
      return { ok: false, error: `并发数必须是 1 到 ${concurrencyCap} 之间的整数` };
    }
    const secret = newSecret();
    const entry = {
      id: randomBytes(8).toString('hex'),
      name: label,
      owner,
      prefix: secret.slice(0, 12),
      concurrency: quota.value,
      createdAt: now(),
      lastUsedAt: null,
      source: 'manual',
      ...hashKey(secret),
    };
    keys.push(entry);
    persist();
    return { ok: true, key: secret, item: publicKey(entry) };
  }

  function update(id, { concurrency } = {}, actor) {
    const entry = keys.find((item) => item.id === id);
    if (!canAccess(entry, actor)) return { ok: false, error: '密钥不存在' };
    if (concurrency === undefined) return { ok: false, error: '没有需要修改的内容' };
    const cap = actor?.role === 'admin' ? CONCURRENCY_LIMIT : Math.max(1, Number(actor?.concurrency) || 1);
    const quota = normalizeConcurrency(concurrency, null);
    if (!quota.ok || quota.value > cap) {
      return { ok: false, error: `并发数必须是 1 到 ${cap} 之间的整数` };
    }
    entry.concurrency = quota.value;
    persist();
    return { ok: true, item: publicKey(entry) };
  }

  function revoke(id, actor) {
    const index = keys.findIndex((item) => item.id === id);
    if (index < 0 || !canAccess(keys[index], actor)) return { ok: false, error: '密钥不存在' };
    keys.splice(index, 1);
    persist();
    return { ok: true };
  }

  let lastUsedSavedAt = 0;

  function authenticate(req) {
    const secret = extractSecret(req);
    if (!secret) return null;
    const entry = keys.find((item) => verifyKey(secret, item.salt, item.hash));
    if (!entry) return null;
    entry.lastUsedAt = now();
    if (entry.lastUsedAt - lastUsedSavedAt > 60_000) {
      lastUsedSavedAt = entry.lastUsedAt;
      persist();
    }
    return {
      id: entry.id,
      name: entry.name,
      concurrency: entry.concurrency,
      username: entry.owner || 'admin',
      owner: `apikey:${entry.id}`,
    };
  }

  const hits = new Map();

  function consume(identity) {
    const ceiling = limits().rateLimitPerMinute;
    const username = identity?.username || identity?.id || 'local';
    const requested = Number(getUserRateLimit(username, ceiling));
    const limit = Math.max(1, Math.min(ceiling, Number.isInteger(requested) ? requested : ceiling));
    const windowMs = 60_000;
    const stamp = now();
    const bucket = `user:${username}`;
    const recent = (hits.get(bucket) || []).filter((item) => stamp - item < windowMs);
    if (recent.length >= limit) {
      const retryAfter = Math.max(1, Math.ceil((recent[0] + windowMs - stamp) / 1000));
      return { ok: false, limit, remaining: 0, retryAfter, ceiling };
    }
    recent.push(stamp);
    hits.set(bucket, recent);
    return { ok: true, limit, remaining: limit - recent.length, retryAfter: 0, ceiling };
  }

  return {
    get enabled() { return keys.length > 0; },
    file,
    concurrencyLimit: CONCURRENCY_LIMIT,
    defaultConcurrency: DEFAULT_CONCURRENCY,
    limits,
    list,
    create,
    update,
    revoke,
    authenticate,
    consume,
  };
}
