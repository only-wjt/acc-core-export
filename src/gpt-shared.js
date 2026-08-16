// Shared GPT protocol utilities (structure extract from gpt.js, zero behavior change).
import { pickFingerprint } from './ctls.js';
import { setRealFp } from './fingerprint.js';
import { defaultPaymentConfig, normalizePaymentConfig, paymentPlan } from './payment-config.js';
import { normalizePaymentPlan } from './payment-state.js';

export const BASE = 'https://chatgpt.com';
export const AUTH0 = 'https://auth.openai.com';

// 取账号指纹:先把该号注册时持久化的真实指纹(account.fp)载回缓存,再取 → 支付/检测/3DS 与注册用同一份
export function accountFp(account) {
  if (account && account.fp && account.email) setRealFp(account.email, account.fp);
  return pickFingerprint(account && account.email);
}

// 接口响应全量追踪(设 GPT_TRACE=1 开启)
const GPT_TRACE = process.env.GPT_TRACE === '1';
export async function traceResp(tag, method, url, resp) {
  if (!GPT_TRACE) return resp;
  try {
    const loc = resp.headers.get('location') || '';
    const sc = (resp.headers.getSetCookie?.() || []).map((c) => c.split('=')[0]).join(',');
    let body = '';
    try { body = ((await resp.text()) || '').replace(/\s+/g, ' ').slice(0, 500); } catch { body = '<非文本>'; }
    console.log(`[TRACE ${tag}] ${method} ${url.slice(0, 130)} → ${resp.status}${loc ? ` loc=${loc.slice(0, 100)}` : ''} setCookie=[${sc}] body=${body}`);
  } catch { /* 追踪失败不影响主流程 */ }
  return resp;
}

// 充值默认区域/币种：菲律宾(PHP 定价更低)
export const DEFAULT_REGION = { country: 'PH', currency: 'PHP' };

export const PLAN = { PRO: 'chatgptpro', PLUS: 'chatgptplusplan', PRO_LITE: 'chatgptprolite' };

let paymentConfigProvider = async () => defaultPaymentConfig();

export function setPaymentConfigProvider(provider) {
  if (typeof provider === 'function') paymentConfigProvider = provider;
}

export async function resolvePaymentPricing(plan, opts = {}) {
  const config = normalizePaymentConfig(opts.paymentConfig || await paymentConfigProvider());
  const pricing = paymentPlan(config, plan);
  if (!pricing.enabled) {
    const error = new Error(`${pricing.label} 当前暂停支付`);
    error.code = 'plan_disabled';
    throw error;
  }
  return { config, pricing };
}

export async function emitPaymentState(opts, state) {
  if (typeof opts?.onPaymentState === 'function') await opts.onPaymentState(state);
}

export function apiPlanName(plan) {
  const normalized = normalizePaymentPlan(plan);
  if (normalized === 'pro') return PLAN.PRO;
  if (normalized === 'prolite') return PLAN.PRO_LITE;
  return PLAN.PLUS;
}

const FIRST_NAMES = ['James','Mary','Robert','Patricia','John','Jennifer','Michael','Linda','David','Elizabeth','William','Barbara','Richard','Susan','Joseph','Jessica','Thomas','Sarah','Charles','Karen','Daniel','Lisa','Matthew','Betty','Anthony','Margaret','Mark','Sandra','Donald','Ashley','Steven','Dorothy','Paul','Kimberly','Andrew','Emily','Joshua','Donna','Kenneth','Michelle','Kevin','Carol','Brian','Amanda','George','Melissa','Timothy','Deborah','Ronald','Stephanie','Edward','Rebecca','Jason','Sharon','Jeffrey','Laura','Ryan','Cynthia','Jacob','Kathleen','Gary','Amy','Nicholas','Angela','Eric','Shirley','Jonathan','Anna','Stephen','Brenda','Larry','Pamela','Justin','Emma','Scott','Nicole','Brandon','Helen','Benjamin','Samantha','Samuel','Katherine','Raymond','Christine','Gregory','Debra','Frank','Rachel','Alexander','Carolyn','Patrick','Janet','Jack','Catherine','Dennis','Maria','Jerry','Heather','Tyler','Diane'];
const LAST_NAMES = ['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez','Hernandez','Lopez','Gonzalez','Wilson','Anderson','Thomas','Taylor','Moore','Jackson','Martin','Lee','Perez','Thompson','White','Harris','Sanchez','Clark','Ramirez','Lewis','Robinson','Walker','Young','Allen','King','Wright','Scott','Torres','Nguyen','Hill','Flores','Green','Adams','Nelson','Baker','Hall','Rivera','Campbell','Mitchell','Carter','Roberts'];

export function randomProfile(emailHint) {
  const first = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
  const last = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
  const year = 1985 + Math.floor(Math.random() * 15);
  const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, '0');
  const day = String(1 + Math.floor(Math.random() * 28)).padStart(2, '0');
  return { name: `${first} ${last}`, birthdate: `${year}-${month}-${day}` };
}

export function extractCookies(resp) {
  return (resp.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
}

export function mergeCookies(...parts) {
  const map = new Map();
  for (const part of parts) {
    if (!part) continue;
    for (const seg of part.split('; ')) {
      const [k] = seg.split('=');
      if (k) map.set(k.trim(), seg);
    }
  }
  return [...map.values()].join('; ');
}

export function uuid() {
  return (globalThis.crypto?.randomUUID?.() || (Date.now() + '-' + Math.random().toString(16).slice(2)));
}

// guid/muid/sid 真实格式:带横线 uuid + 6hex
export function stripeId() {
  return uuid() + Math.random().toString(16).slice(2, 8);
}

export function traceHeaders() {
  const tid = (globalThis.crypto?.randomUUID?.() || uuid()).replace(/-/g, '');
  const parentNum = Math.floor(Math.random() * 9e18 + 1e18);
  const parentHex = parentNum.toString(16).padStart(16, '0');
  const traceNum = BigInt('0x' + tid.slice(0, 16)).toString();
  return {
    'traceparent': `00-${tid}-${parentHex}-01`,
    'tracestate': 'dd=s:1;o:rum',
    'x-datadog-origin': 'rum',
    'x-datadog-sampling-priority': '1',
    'x-datadog-trace-id': traceNum,
    'x-datadog-parent-id': String(parentNum),
  };
}

export function buildSessionCookie(sessionToken) {
  // 与 session-token.js / Java 一致：NextAuth 分片 3933（勿用 3800，避免与浏览器不一致）
  const MAX = Number(process.env.SESSION_COOKIE_CHUNK_LENGTH) || 3933;
  if (sessionToken.length <= MAX) return `__Secure-next-auth.session-token=${sessionToken}`;
  const parts = [];
  for (let i = 0, idx = 0; i < sessionToken.length; i += MAX, idx++) {
    parts.push(`__Secure-next-auth.session-token.${idx}=${sessionToken.slice(i, i + MAX)}`);
  }
  return parts.join('; ');
}

// 把传输层错误消息归类为 proxy_down / network,否则 null
export function netReason(msg = '') {
  if (/proxy|tunnel|ECONNREFUSED|ECONNRESET|EPIPE|socket|forcibly closed|connection reset|reset by peer/i.test(msg)) return 'proxy_down';
  if (/fetch failed|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|context deadline|aborted|timeout|超时|network/i.test(msg)) return 'network';
  return null;
}
