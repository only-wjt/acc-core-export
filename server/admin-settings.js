import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseProxyPool } from './batch-session.js';

// 代理池属于「管理员统一配置」，单独存一份文件，重启后继续生效。
// 并发数按用户配额，存在 users.json 里，不再放这里。
export const CONCURRENCY_LIMIT = 20;

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

const DEFAULT_MAX_API_KEYS = boundedInt(process.env.OPENAPI_MAX_KEYS, 3, 1, 20);
const DEFAULT_API_RATE_LIMIT = boundedInt(process.env.OPENAPI_RATE_LIMIT, 60, 1, 6000);

function settingsPath() {
  if (process.env.SETTINGS_FILE) return resolve(process.env.SETTINGS_FILE);
  const dir = process.env.PERSIST_DIR || process.env.DATA_DIR || 'data';
  return resolve(dir, 'settings.json');
}

export function createAdminSettings({ file = settingsPath() } = {}) {
  let state = {
    proxies: [],
    maxApiKeys: DEFAULT_MAX_API_KEYS,
    apiRateLimit: DEFAULT_API_RATE_LIMIT,
  };

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    state = {
      proxies: Array.isArray(parsed.proxies) ? parsed.proxies.filter((item) => typeof item === 'string') : [],
      maxApiKeys: boundedInt(parsed.maxApiKeys, DEFAULT_MAX_API_KEYS, 1, 20),
      apiRateLimit: boundedInt(parsed.apiRateLimit, DEFAULT_API_RATE_LIMIT, 1, 6000),
    };
  } catch {
    /* 没有配置文件就用默认值 */
  }

  function persist() {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  function get() {
    return {
      proxies: [...state.proxies],
      proxyText: state.proxies.join('\n'),
      proxyCount: state.proxies.length,
      concurrencyLimit: CONCURRENCY_LIMIT,
      maxApiKeys: state.maxApiKeys,
      apiRateLimit: state.apiRateLimit,
      file,
    };
  }

  function update({ proxies, maxApiKeys, apiRateLimit } = {}) {
    const errors = [];
    const notes = [];
    const next = { ...state };

    if (proxies !== undefined) {
      const parsed = parseProxyPool(typeof proxies === 'string' ? proxies : (proxies || []).join('\n'));
      if (parsed.errors.length) {
        for (const error of parsed.errors) {
          errors.push(error.line ? { line: error.line, message: error.message } : { message: error.message });
        }
      }
      next.proxies = parsed.proxies;
    }

    if (maxApiKeys !== undefined) {
      const value = boundedInt(maxApiKeys, NaN, 1, 20);
      if (!Number.isInteger(value)) errors.push({ message: '每名用户密钥数量必须是 1 到 20 的整数' });
      else next.maxApiKeys = value;
    }

    if (apiRateLimit !== undefined) {
      const value = boundedInt(apiRateLimit, NaN, 1, 6000);
      if (!Number.isInteger(value)) errors.push({ message: '每名用户最大请求次数必须是 1 到 6000 的整数' });
      else next.apiRateLimit = value;
    }

    if (errors.length) return { ok: false, errors };

    state = next;
    const saved = persist();
    if (!saved) notes.push('配置已生效，但写入磁盘失败，重启后会丢失');
    return { ok: true, settings: get(), notes };
  }

  return { get, update };
}
