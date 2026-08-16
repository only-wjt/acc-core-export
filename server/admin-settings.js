import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseProxyPool } from './batch-session.js';

// 代理池属于「管理员统一配置」，单独存一份文件，重启后继续生效。
// 并发数按用户配额，存在 users.json 里，不再放这里。
export const CONCURRENCY_LIMIT = 20;

function settingsPath() {
  if (process.env.SETTINGS_FILE) return resolve(process.env.SETTINGS_FILE);
  const dir = process.env.PERSIST_DIR || process.env.DATA_DIR || 'data';
  return resolve(dir, 'settings.json');
}

export function createAdminSettings({ file = settingsPath() } = {}) {
  let state = { proxies: [] };

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    state = {
      proxies: Array.isArray(parsed.proxies) ? parsed.proxies.filter((item) => typeof item === 'string') : [],
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
      file,
    };
  }

  function update({ proxies } = {}) {
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

    if (errors.length) return { ok: false, errors };

    state = next;
    const saved = persist();
    if (!saved) notes.push('配置已生效，但写入磁盘失败，重启后会丢失');
    return { ok: true, settings: get(), notes };
  }

  return { get, update };
}
