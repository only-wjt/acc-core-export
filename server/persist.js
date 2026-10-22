import { mkdir, writeFile, readFile, readdir, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

const ARCHIVE_RE = /^(session|check|password)-.*\.json$/;

// 文件名形如 kind-2026-08-15T16-03-34-768Z-xxxxxxxx.json（ISO 时间戳里的 : 和 . 被换成了 -）。
// 还原成毫秒，供按天清理用；解析失败返回 null，不影响按数量清理。
function stampToMs(name) {
  const match = name.match(/^(?:session|check|password)-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-/);
  if (!match) return null;
  const ms = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  return Number.isNaN(ms) ? null : ms;
}

export function createStore({
  dir = process.env.PERSIST_DIR || '',
  now = () => Date.now(),
  maxFiles = Number(process.env.PERSIST_MAX_FILES) || 1000,
  maxAgeDays = Number(process.env.PERSIST_MAX_AGE_DAYS) || 0,
} = {}) {
  const enabled = Boolean(String(dir || '').trim());
  const root = enabled ? resolve(dir) : '';
  const maxAgeMs = maxAgeDays > 0 ? maxAgeDays * 86400000 : 0;

  async function ensure() {
    if (!enabled) return;
    await mkdir(root, { recursive: true });
  }

  // 落盘后清理旧归档：文件名按 ISO 时间戳升序即最旧在前。只靠文件名排序，不读文件内容，保证清理开销很低。
  async function prune() {
    if (!enabled || (maxFiles <= 0 && maxAgeMs <= 0)) return;
    const names = (await readdir(root).catch(() => []))
      .filter((name) => ARCHIVE_RE.test(name))
      .sort();
    const doomed = new Set();
    if (maxAgeMs > 0) {
      const cutoff = now() - maxAgeMs;
      for (const name of names) {
        const ms = stampToMs(name);
        if (ms !== null && ms < cutoff) doomed.add(name);
      }
    }
    if (maxFiles > 0 && names.length > maxFiles) {
      for (let i = 0; i < names.length - maxFiles; i++) doomed.add(names[i]);
    }
    for (const name of doomed) {
      await unlink(resolve(root, name)).catch(() => {});
    }
    return doomed.size;
  }

  async function saveJob(kind, job, { owner = 'local' } = {}) {
    if (!enabled || !job?.id) return null;
    await ensure();
    const stamp = new Date(job.finishedAt || now()).toISOString().replace(/[:.]/g, '-');
    const file = resolve(root, `${kind}-${stamp}-${job.id.slice(0, 8)}.json`);
    const payload = {
      kind,
      id: job.id,
      owner,
      status: job.status,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      counts: job.counts,
      sessions: kind === 'password' ? [] : (job.sessions || []),
      items: (job.items || []).map((item) => ({
        email: item.email,
        status: item.status,
        plan: item.plan || item.subscriptionInfo?.plan || '',
        error: item.error || '',
        reason: item.reason || '',
      })),
    };
    await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await prune().catch(() => {});
    return file;
  }

  async function listRecent(limit = 20, { owner, isAdmin = false } = {}) {
    if (!enabled) return [];
    await ensure();
    const names = (await readdir(root).catch(() => []))
      .filter((name) => /^(session|check|password)-.*\.json$/.test(name))
      .sort()
      .reverse();
    const rows = [];
    for (const name of names) {
      if (rows.length >= limit) break;
      try {
        const data = JSON.parse(await readFile(resolve(root, name), 'utf8'));
        if (!isAdmin && owner && data.owner && data.owner !== owner) continue;
        rows.push({
          file: name,
          kind: data.kind,
          id: data.id,
          owner: data.owner || '',
          status: data.status,
          createdAt: data.createdAt,
          finishedAt: data.finishedAt,
          counts: data.counts,
        });
      } catch {
        /* skip broken files */
      }
    }
    return rows;
  }

  // 归档文件名带 ISO 时间戳，按名字倒序就是按时间倒序
  async function search({
    owner, isAdmin = false, kind = '', q = '', page = 1, pageSize = 20,
  } = {}) {
    const size = Math.max(1, Math.min(100, Number(pageSize) || 20));
    if (!enabled) return { items: [], total: 0, page: 1, pageSize: size, owners: [] };
    await ensure();
    const names = (await readdir(root).catch(() => []))
      .filter((name) => /^(session|check|password)-.*\.json$/.test(name))
      .sort()
      .reverse();

    const needle = String(q || '').trim().toLowerCase();
    const owners = new Set();
    const matched = [];
    for (const name of names) {
      if (kind && !name.startsWith(`${kind}-`)) continue;
      let data;
      try {
        data = JSON.parse(await readFile(resolve(root, name), 'utf8'));
      } catch {
        continue;
      }
      if (!isAdmin && owner && data.owner && data.owner !== owner) continue;
      if (data.owner) owners.add(data.owner);
      const emails = (data.items || []).map((item) => item.email).filter(Boolean);
      if (needle && ![name, data.owner || '', data.id || '', ...emails].join(' ').toLowerCase().includes(needle)) {
        continue;
      }
      matched.push({
        file: name,
        kind: data.kind,
        id: data.id,
        owner: data.owner || '',
        status: data.status,
        createdAt: data.createdAt,
        finishedAt: data.finishedAt,
        counts: data.counts,
        accounts: emails.length,
      });
    }

    const current = Math.max(1, Number(page) || 1);
    const start = (current - 1) * size;
    return {
      items: matched.slice(start, start + size),
      total: matched.length,
      page: current,
      pageSize: size,
      owners: [...owners].sort(),
    };
  }

  async function readJob(file, { owner, isAdmin = false } = {}) {
    if (!enabled) return null;
    if (!/^(session|check|password)-[\w.-]+\.json$/.test(String(file || ''))) return null;
    try {
      const data = JSON.parse(await readFile(resolve(root, file), 'utf8'));
      if (!isAdmin && owner && data.owner && data.owner !== owner) return null;
      return { ...data, file };
    } catch {
      return null;
    }
  }

  return { enabled, dir: root, saveJob, listRecent, search, readJob, prune };
}
