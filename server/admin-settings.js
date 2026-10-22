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
const DEFAULT_SUB2_ROOT = process.env.TOSUB2_ROOT || '';
const DEFAULT_SUB2_PORT = boundedInt(process.env.TOSUB2_PORT, 4399, 1024, 65535);

// 设置页来的值可能是 true / 'true' / 1，统一收敛成布尔；认不出来的按原样丢弃。
function toBool(value) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return undefined;
}

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
    // toSub2 是外部开源工具，默认关闭：没装的人不该被一个必报错的开关打扰。
    sub2Enabled: false,
    sub2Root: DEFAULT_SUB2_ROOT,
    sub2Port: DEFAULT_SUB2_PORT,
  };

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    state = {
      proxies: Array.isArray(parsed.proxies) ? parsed.proxies.filter((item) => typeof item === 'string') : [],
      maxApiKeys: boundedInt(parsed.maxApiKeys, DEFAULT_MAX_API_KEYS, 1, 20),
      apiRateLimit: boundedInt(parsed.apiRateLimit, DEFAULT_API_RATE_LIMIT, 1, 6000),
      sub2Enabled: toBool(parsed.sub2Enabled) ?? false,
      sub2Root: typeof parsed.sub2Root === 'string' ? parsed.sub2Root : DEFAULT_SUB2_ROOT,
      sub2Port: boundedInt(parsed.sub2Port, DEFAULT_SUB2_PORT, 1024, 65535),
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
      sub2Enabled: state.sub2Enabled,
      sub2Root: state.sub2Root,
      sub2Port: state.sub2Port,
      file,
    };
  }

  function update({ proxies, maxApiKeys, apiRateLimit, sub2Enabled, sub2Root, sub2Port } = {}) {
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

    if (sub2Enabled !== undefined) {
      const value = toBool(sub2Enabled);
      if (value === undefined) errors.push({ message: 'toSub2 开关必须是布尔值' });
      else next.sub2Enabled = value;
    }

    if (sub2Root !== undefined) {
      // 空串表示「还没配」，不当作错误：默认就是关着的，配了路径再打开开关。
      if (typeof sub2Root !== 'string') errors.push({ message: 'toSub2 目录必须是字符串' });
      else next.sub2Root = sub2Root.trim();
    }

    if (sub2Port !== undefined) {
      if (!Number.isInteger(Number(sub2Port)) || Number(sub2Port) < 1024 || Number(sub2Port) > 65535) {
        errors.push({ message: 'toSub2 端口必须是 1024 到 65535 的整数' });
      } else next.sub2Port = Number(sub2Port);
    }

    if (errors.length) return { ok: false, errors };

    state = next;
    const saved = persist();
    if (!saved) notes.push('配置已生效，但写入磁盘失败，重启后会丢失');
    return { ok: true, settings: get(), notes };
  }

  return { get, update };
}
