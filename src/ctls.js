// Shared protocol TLS layer. Registration prefers the JA3 and UA captured from the live Chrome
// context; defaults come from browser-profile.js（单源）。

import initCycleTLS from 'cycletls';
import { deviceProfile } from './fingerprint.js';
import { beginProtocolRequest } from './traffic-capture.js';
import {
  UA_WIN, SEC_CH_UA as PROFILE_SEC_CH_UA, JA3 as PROFILE_JA3, CHROME_FULL as PROFILE_CHROME_FULL,
  secChUaFullVersionList, quotedFullVersion,
} from './browser-profile.js';

// Fallback fingerprint — 单源 browser-profile（ACC Chrome150 采集）。
export const UA = UA_WIN;
export const SEC_CH_UA = PROFILE_SEC_CH_UA;

export function headers(extra = {}) {
  return { 'User-Agent': UA, 'Accept': '*/*', ...extra };
}

export function browserHeaders(extra = {}) {
  return headers({
    'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
    'sec-ch-ua': SEC_CH_UA,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    ...extra,
  });
}

// ───── CycleTLS: Chrome TLS 指纹 (JA3/JA4) ─────
// auth.openai.com / mail.com 均做 JA3/JA4 TLS 指纹检测。
// Node.js fetch 的 OpenSSL 指纹被识别为非浏览器 → 拦截。
// CycleTLS uses uTLS; browser-backed registration overrides JA3 with a live Chrome probe.

let _ctls = null;
let _ctlsShutdown = false;
// 模块加载时立即启动 CycleTLS Go 进程，避免首请求时 "WebSocket not connected"
const _ctlsReady = initCycleTLS().then(c => { _ctls = c; return c; }).catch(e => { console.error('[ctls] 初始化失败:', e.message); return null; });
async function _getCTLS() {
  if (_ctls) return _ctls;
  const c = await _ctlsReady;
  if (!c) throw new Error('CycleTLS 初始化失败');
  return c;
}

export async function shutdownCycleTLS() {
  if (_ctlsShutdown) return;
  _ctlsShutdown = true;
  const client = _ctls || await _ctlsReady;
  _ctls = null;
  if (client?.exit) await client.exit();
}

// JA3 / chromeFull：单源 browser-profile（JA4/H2 residual 见 RESIDUALS）
const _JA3 = PROFILE_JA3;
const _CHROME_FULL = PROFILE_CHROME_FULL;
const _major = String(_CHROME_FULL).split('.')[0];
const FP_POOL = [
  {
    ua: UA_WIN,
    platform: '"Windows"', arch: '"x86"', bitness: '"64"', platformVersion: '"15.0.0"',
    secChUa: SEC_CH_UA, ja3: _JA3,
  },
  {
    ua: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${_major}.0.0.0 Safari/537.36`,
    platform: '"macOS"', arch: '"arm"', bitness: '"64"', platformVersion: '"14.5.0"',
    secChUa: SEC_CH_UA, ja3: _JA3,
  },
  {
    ua: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${_major}.0.0.0 Safari/537.36`,
    platform: '"Linux"', arch: '"x86"', bitness: '"64"', platformVersion: '""',
    secChUa: SEC_CH_UA, ja3: _JA3,
  },
];

// 稳定指纹：委托给统一指纹模块 deviceProfile(按账号 email 程序化生成完整自洽指纹,
// 每号独立、同号稳定)。返回对象是 FP_POOL 条目的超集(含 ua/ja3/secChUa/platform/arch/
// bitness/platformVersion + screen/hardware/webgl/canvas/audio/timezone),applyFp 仅用前半部分。
export function pickFingerprint(key) {
  return deviceProfile(key);
}
// 旧的 3 条静态池保留兜底(deviceProfile 覆盖后不再直接使用)
export function _legacyPickFingerprint(key) {
  const s = String(key || 'default');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  return FP_POOL[h % FP_POOL.length];
}

// 把指纹(UA/平台/Client Hints)覆盖进一个 headers 对象。只改指纹相关字段,其余保留。
export function applyFp(h, fp) {
  if (!fp) return h;
  const out = { ...h, 'User-Agent': fp.ua };
  // 仅当原本就带浏览器指纹头时才补齐,避免给纯 API 调用塞入不该有的头
  if ('sec-ch-ua' in out || 'sec-ch-ua-platform' in out) {
    const full = String(fp.chromeFull || _CHROME_FULL).replace(/^"|"$/g, '');
    out['sec-ch-ua'] = fp.secChUa;
    out['sec-ch-ua-mobile'] = '?0';
    out['sec-ch-ua-platform'] = fp.platform;
    out['sec-ch-ua-arch'] = fp.arch;
    out['sec-ch-ua-bitness'] = fp.bitness;
    out['sec-ch-ua-full-version'] = quotedFullVersion(full);
    out['sec-ch-ua-platform-version'] = fp.platformVersion;
    out['sec-ch-ua-model'] = fp.model != null ? fp.model : '""';
    out['sec-ch-ua-full-version-list'] = secChUaFullVersionList(full);
  }
  return out;
}

function _proxyUrl(proxy) {
  if (!proxy) return undefined;
  if (typeof proxy === 'string') return proxy;              // 已是完整 URL(http:// 或 socks5://)
  const scheme = proxy.protocol || proxy.scheme || 'http';  // socks5 代理需 socks5://,默认 http
  const auth = proxy.username ? `${proxy.username}:${proxy.password}@` : '';
  return `${scheme}://${auth}${proxy.host}:${proxy.port}`;
}

function _wrapCtls(resp) {
  const h = resp.headers || {};
  // 构建小写 key 映射，兼容 CycleTLS 返回 "Location" / "Set-Cookie" 等大写形式
  const lh = {};
  for (const k of Object.keys(h)) lh[k.toLowerCase()] = h[k];
  return {
    status: resp.status,
    ok: resp.status >= 200 && resp.status < 300,
    url: resp.finalUrl || '',
    headers: {
      get(k) {
        const v = lh[k.toLowerCase()];
        return Array.isArray(v) ? v[0] : (v ?? null);
      },
      getSetCookie() {
        const v = lh['set-cookie'];
        if (!v) return [];
        return Array.isArray(v) ? v : [v];
      },
    },
    json: () => resp.json(),
    text: () => resp.text(),
  };
}

export async function ctlsFetch(url, opts = {}, proxy = null) {
  const capture = beginProtocolRequest(url, opts);
  let ctls = await _getCTLS();
  const method = (opts.method || 'GET').toLowerCase();
  let body;
  if (opts.body != null) {
    body = typeof opts.body === 'string' ? opts.body
      : opts.body instanceof URLSearchParams ? opts.body.toString()
      : JSON.stringify(opts.body);
  }
  const ctlsOpts = {
    headers: opts.headers || {},
    ja3: opts.ja3 || _JA3,  // 允许按账号指纹覆盖(见 pickFingerprint)
    userAgent: (opts.headers || {})['User-Agent'] || UA,
    disableRedirect: opts.redirect === 'manual',
    // 显式超时(秒)。CycleTLS 默认偏短,重端点(如 mail.com passwordChange)走慢代理会
    // "context deadline exceeded" 408。默认 30s,调用方可用 opts.timeoutMs 覆盖。
    timeout: Math.ceil((opts.timeoutMs || 30000) / 1000),
    // CycleTLS 在 HTTP/2 上发送"带请求体的 POST"到部分服务端(如 account-lxa.mail.com)
    // 会卡死: "reset err: stop request body writer and cancel StreamID:1" → 请求体流写不完 →
    // 服务端收不到完整请求 → 超时。强制 HTTP/1.1 可绕过(TLS JA3 指纹不变,仅 ALPN 变 http/1.1)。
    // 仅对确认受影响的调用开启(见 mail.js changePassword),避免改动 OpenAI/Stripe 的 H2 指纹。
    ...(opts.forceHTTP1 ? { forceHTTP1: true } : {}),
    ...(proxy ? { proxy: _proxyUrl(proxy) } : {}),
    ...(body !== undefined ? { body } : {}),
  };
  let r;
  try {
    r = await ctls[method](url, ctlsOpts);
  } catch (e) {
    if (e.message === 'WebSocket server not connected') {
      // Go子进程已死，重新初始化后重试一次
      console.log('[ctls] WebSocket断开，重新初始化...');
      _ctls = null;
      _ctlsShutdown = false;
      ctls = await initCycleTLS().then(c => { _ctls = c; return c; });
      try { r = await ctls[method](url, ctlsOpts); }
      catch (retryError) { capture?.failure(retryError); throw retryError; }
    } else {
      capture?.failure(e);
      throw e;
    }
  }
  capture?.response(r.status, r.headers || {});
  return _wrapCtls(r);
}
