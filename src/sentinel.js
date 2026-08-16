// ⚠️【封存 2026-07-02】配合纯协议注册(gpt.js register / registerViaCodex)使用。OpenAI 已封禁纯协议
// 建号,此模块暂无实际作用,保留待用。详见 gpt.js register() 顶部封存说明。
//
// OpenAI Sentinel(反机器人)令牌生成 —— 纯算法,无需浏览器。
// 移植自参考项目 GPT-team/get_tokens.py 的 SentinelTokenGenerator / build_sentinel_token。
// 建号流程(authorize/continue、user/register、create_account 等)需在请求头带
// openai-sentinel-token,否则 OpenAI 返回 registration_disallowed。
//
// 令牌结构: JSON 字符串 {"p":<proof>,"t":"","c":<challenge_token>,"id":<deviceId>,"flow":<flow>}
//   p = requirements token 或 解出的 proof-of-work token
//   c = 从 sentinel/req 拿到的 challenge token
// PoW: 找到 data 使 fnv1a32(seed+data) 的十六进制前缀 <= difficulty。

import { ctlsFetch, applyFp, UA as DEFAULT_UA } from './ctls.js';

const SENTINEL_BASE = 'https://sentinel.openai.com';
const SDK_URL = `${SENTINEL_BASE}/sentinel/20260124ceb8/sdk.js`;
const MAX_ATTEMPTS = 500_000;

// FNV-1a 32-bit + 三轮 xorshift 混淆(与参考实现逐位一致)。JS 用 Math.imul 做 32 位乘法。
function fnv1a32(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h ^= h >>> 16; h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 3266489909) >>> 0;
  h ^= h >>> 16; h = h >>> 0;
  return h.toString(16).padStart(8, '0');
}

function b64(obj) {
  // JSON.stringify 默认无空格,等价于 python json.dumps(separators=(",",":"))
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

function nowGmtString() {
  // "Wed Jul 02 2026 09:06:54 GMT+0000 (Coordinated Universal Time)"
  const d = new Date();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()} `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

function makeConfig(ua, sid) {
  const perfNow = 1000 + Math.random() * 49000;
  const timeOrigin = Date.now() - perfNow;
  return [
    '1920x1080', nowGmtString(), 4294705152, Math.random(), ua,
    SDK_URL,
    null, null, 'en-US', 'en-US,en', Math.random(),
    'vendorSub-undefined', 'location', 'Object',
    perfNow, sid, '', [4, 8, 12, 16][Math.floor(Math.random() * 4)], timeOrigin,
  ];
}

function uuid() {
  return (globalThis.crypto?.randomUUID?.())
    || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.floor(Math.random() * 16), v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
}

// 无 challenge 时的兜底 requirements token
function generateRequirementsToken(ua, sid) {
  const cfg = makeConfig(ua, sid);
  cfg[3] = 1;
  cfg[9] = Math.round(5 + Math.random() * 45);
  return 'gAAAAAC' + b64(cfg);
}

// 解 proof-of-work:遍历直到 fnv1a32(seed+data) 前缀 <= difficulty
function solvePow(seed, difficulty, ua, sid) {
  const diff = difficulty || '0';
  const cfg = makeConfig(ua, sid);
  const start = Date.now();
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    cfg[3] = i;
    cfg[9] = Date.now() - start;
    const data = b64(cfg);
    const hash = fnv1a32(seed + data);
    if (hash.slice(0, diff.length) <= diff) return 'gAAAAAB' + data + '~S';
  }
  return 'gAAAAAB' + b64(String(null));
}

// 拉取 challenge。codex_register(最新可用实现)发 p="" 即可拿到 token,不需要解 PoW。
async function fetchChallenge(deviceId, flow, ua, fp, proxy, pValue = '') {
  const body = JSON.stringify({ p: pValue, id: deviceId, flow });
  try {
    const resp = await ctlsFetch(`${SENTINEL_BASE}/backend-api/sentinel/req`, {
      method: 'POST',
      headers: applyFp({
        'Content-Type': 'text/plain;charset=UTF-8',
        'Referer': `${SENTINEL_BASE}/backend-api/sentinel/frame.html`,
        'Origin': SENTINEL_BASE,
        'Accept': '*/*',
      }, fp),
      body,
      ja3: fp?.ja3,
      redirect: 'manual',
      timeoutMs: 20000,
    }, proxy);
    if (resp.status === 200) {
      const data = await resp.json().catch(() => null);
      return (data && typeof data === 'object') ? data : null;
    }
  } catch { /* 忽略,走兜底 */ }
  return null;
}

// openai-sentinel-token 头(JSON 包装),用于 authorize/continue、user/register、email-otp/validate。
// 照搬 codex_register:c=从 sentinel/req 拿到的原始 token,p 留空。
export async function buildSentinelToken(deviceId, { flow = 'authorize_continue', fp = null, proxy = null } = {}) {
  const ua = fp?.ua || DEFAULT_UA;
  const sid = uuid();
  const challenge = await fetchChallenge(deviceId, flow, ua, fp, proxy, '');
  const c = challenge?.token || '';
  // OpenAI 已开始强制 proof-of-work:challenge 带 proofofwork.required 时必须解出,
  // 否则 user/register 返回 account_creation_failed。p="" 只在不要求 PoW 时够用。
  const pow = challenge?.proofofwork || {};
  let p = '';
  if (pow && pow.required && pow.seed) {
    p = solvePow(pow.seed, pow.difficulty || '0', ua, sid);
  }
  return JSON.stringify({ p, t: '', c, id: deviceId, flow });
}

// openai-sentinel-so-token 头(原始 token,不包 JSON),create_account 专用。
// 关键:新版 OpenAI 建号要求此 SO(sign-up)令牌,来自 flow=oauth_create_account;
// 缺它 → account_creation_failed / registration_disallowed。照搬 codex_register。
export async function fetchSoToken(deviceId, { fp = null, proxy = null } = {}) {
  const ua = fp?.ua || DEFAULT_UA;
  const challenge = await fetchChallenge(deviceId, 'oauth_create_account', ua, fp, proxy, '');
  return challenge?.token || null;
}

export { fnv1a32 }; // 供测试
