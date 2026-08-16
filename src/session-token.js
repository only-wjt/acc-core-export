const COOKIE_NAME = '__Secure-next-auth.session-token';
const COOKIE_RE = /^__Secure-next-auth\.session-token(?:\.(\d+))?$/;
// NextAuth 单片上限约 4096；浏览器抓包分片长度 3933（card-key-portal-java gpt8.1）
export const SESSION_COOKIE_CHUNK_LENGTH = 3933;

function cookieEntries(input) {
  if (typeof input === 'string') {
    return input.split(/;\s*/).map((part) => {
      const at = part.indexOf('=');
      return at > 0 ? { name: part.slice(0, at).trim(), value: part.slice(at + 1) } : null;
    }).filter(Boolean);
  }
  if (Array.isArray(input)) {
    return input.map((cookie) => {
      if (!cookie || typeof cookie !== 'object') return null;
      return { name: String(cookie.name || '').trim(), value: String(cookie.value || '') };
    }).filter((cookie) => cookie.name);
  }
  return [];
}

// Only return complete candidates. A missing middle chunk must never be silently
// joined into a shorter token and sent to a buyer or persisted as a new session.
export function sessionTokenCandidates(input) {
  let direct = '';
  const chunks = new Map();
  for (const { name, value } of cookieEntries(input)) {
    const match = name.match(COOKIE_RE);
    if (!match) continue;
    if (match[1] === undefined) direct = value;
    else chunks.set(Number(match[1]), value);
  }

  const candidates = [];
  if (chunks.size > 0) {
    const indexes = [...chunks.keys()].sort((a, b) => a - b);
    const contiguous = indexes[0] === 0 && indexes.every((index, position) => index === position);
    if (contiguous) candidates.push(indexes.map((index) => chunks.get(index)).join(''));
  }
  if (direct) candidates.push(direct);
  return [...new Set(candidates.filter(Boolean))];
}

export function extractSessionToken(input) {
  const token = sessionTokenCandidates(input)[0];
  if (!token) {
    const error = new Error('未获取到完整 session-token（Cookie 分片缺失）');
    error.code = 'session_token_incomplete';
    throw error;
  }
  return token;
}

/**
 * 从 /api/auth/session 的 Set-Cookie 列表拼出轮换后的 session-token（支持 .0/.1 分片）。
 * 对齐 Java SessionCookieExchangeService.extractRotatedSessionCookie。
 */
export function extractRotatedSessionCookie(setCookieHeaders) {
  if (!setCookieHeaders || !setCookieHeaders.length) return '';
  const entries = [];
  for (const header of setCookieHeaders) {
    if (header == null || header === '') continue;
    const pair = String(header).split(';', 2)[0].trim();
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name && value) entries.push({ name, value });
  }
  try {
    return extractSessionToken(entries);
  } catch {
    return '';
  }
}

export { COOKIE_NAME };
