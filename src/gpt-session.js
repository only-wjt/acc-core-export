// GPT session: access token, alive check, login, change password.
// Extracted from gpt.js (zero behavior change).
import crypto from 'node:crypto';
import {
  BASE, AUTH0, accountFp, extractCookies, mergeCookies, traceHeaders, buildSessionCookie,
  traceResp, randomProfile, uuid, netReason,
} from './gpt-shared.js';
import { ctlsFetch, applyFp, headers, browserHeaders } from './ctls.js';
import { setRealFp } from './fingerprint.js';
import { classifyAccountsCheckFailure } from './gpt-status.js';
import { extractSessionToken, extractRotatedSessionCookie } from './session-token.js';
import { getCfClearance } from './cf-solver.js';
import { buildSentinelToken, fetchSoToken } from './sentinel.js';

// RFC 6238 TOTP (SHA-1, 30s, 6 digits). secret = base32 (OpenAI authenticator).
export function totpCode(secret, atMs = Date.now()) {
  const s = String(secret || '').toUpperCase().replace(/[\s=-]+/g, '');
  if (!s) throw new Error('empty totp secret');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s) {
    const v = alphabet.indexOf(c);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  if (!bytes.length) throw new Error('invalid totp secret (base32)');
  const keyBuf = Buffer.from(bytes);
  const counter = Math.floor(atMs / 1000 / 30);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', keyBuf).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

/**
 * 用 session-token Cookie 换 accessToken。
 * opts.forceRefresh=true → GET /api/auth/session?refresh=true&reason=…（付款/改订阅后强制轮换，对齐 Java）
 * 返回可能含轮换后的 sessionToken（从 Set-Cookie 拼接）。
 */
export async function getAccessToken(sessionToken, proxy = null, fp = null, opts = {}) {
  const cookie = buildSessionCookie(sessionToken);
  const forceRefresh = opts.forceRefresh === true;
  const reason = String(opts.refreshReason || 'token_expired').slice(0, 64);
  const url = forceRefresh
    ? `${BASE}/api/auth/session?refresh=true&reason=${encodeURIComponent(reason)}`
    : `${BASE}/api/auth/session`;
  const reqHeaders = applyFp(browserHeaders({
    Cookie: cookie,
    Accept: 'application/json, text/plain, */*',
    Origin: BASE,
    Referer: `${BASE}/`,
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
  }), fp);
  // proxy 或强制刷新：走 CycleTLS（同一出口/JA3 + 可读 Set-Cookie）
  // 无 proxy 且非 force 时保留原生 fetch（历史行为，给本地/无代理检测用）
  let resp;
  if (proxy || forceRefresh || fp) {
    resp = await ctlsFetch(url, {
      headers: reqHeaders,
      ja3: fp?.ja3,
      timeoutMs: opts.timeoutMs || 30000,
    }, proxy);
  } else {
    resp = await fetch(url, { headers: reqHeaders });
  }
  if (!resp.ok) {
    // 消息串保持字节不变(被 preChargeProxyErr/register 正则消费),仅附加结构化字段供上层精确分类:
    // .status = HTTP 状态;.cfBlocked = 响应体像 Cloudflare 挑战页(HTML/CF 标记)。
    const bodyText = await resp.text().catch(() => '');
    const err = new Error(`session 接口返回 ${resp.status}`);
    err.status = resp.status;
    err.cfBlocked = /^\s*</.test(bodyText) || /cloudflare|cf-ray|just a moment|attention required|challenge-platform/i.test(bodyText);
    throw err;
  }
  let data = await resp.json().catch(() => ({}));
  // 普通 /session 偶发只回 cookie 不回 AT：再 force refresh 一次（CDK 预检常见）
  if (!data?.accessToken && !forceRefresh && (proxy || fp)) {
    try {
      const retry = await getAccessToken(sessionToken, proxy, fp, {
        ...opts,
        forceRefresh: true,
        refreshReason: opts.refreshReason || 'empty_access_token',
      });
      return retry;
    } catch {
      /* fall through to empty-AT error */
    }
  }
  if (!data?.accessToken) {
    const err = new Error('session 无 accessToken，token 可能已过期');
    err.code = 'session_token_expired';
    err.status = 401;
    throw err;
  }
  // sessionJson = /api/auth/session 的完整 JSON(含 user/expires/accessToken/authProvider),供导出整份交付。
  let nextSessionToken = String(sessionToken || '');
  let sessionRotated = false;
  try {
    const setCookies = resp.headers?.getSetCookie?.() || [];
    const rotated = extractRotatedSessionCookie(setCookies);
    if (rotated) {
      sessionRotated = rotated !== nextSessionToken;
      nextSessionToken = rotated;
    }
  } catch { /* ignore cookie parse */ }
  // 轮换后的新 JWE 常只出现在 JSON body，Set-Cookie 为空（upgrade_pro.refresh_access_token
  // 注释：「HAR: 新 JWE 在 body.sessionToken，不在 Set-Cookie」）。只看 Set-Cookie 会漏掉轮换，
  // 下一轮继续用旧 token → 401。这里补上 body 来源。
  if (!sessionRotated) {
    const bodyTok = String(data.sessionToken || data.session_token || '').trim();
    const looksJwe = bodyTok.startsWith('eyJ') && (bodyTok.match(/\./g) || []).length >= 4;
    if (looksJwe && bodyTok !== nextSessionToken) {
      nextSessionToken = bodyTok;
      sessionRotated = true;
    }
  }
  return {
    accessToken: data.accessToken,
    user: data.user,
    sessionJson: JSON.stringify(data),
    sessionToken: nextSessionToken,
    sessionRotated,
  };
}

/**
 * 付款 / 订阅变更后刷新凭证：强制 /api/auth/session?refresh=true，
 * 写回 account.sessionToken / account.accessToken（就地 mutate）。
 * AT-only（无 sessionToken）无法轮换，返回 skipped。
 */
export async function refreshAccountSession(account, {
  proxy = null,
  fp = null,
  log = () => {},
  reason = 'token_expired',
  requireRotated = false,
  attempts = 1,
} = {}) {
  const sessionToken = String(account?.sessionToken || '').trim();
  if (!sessionToken) {
    log(`[session_refresh] ${reason}: 无 sessionToken，跳过（AT-only 无法轮换）`);
    return {
      ok: false,
      skipped: true,
      rotated: false,
      reason: 'no_session_token',
      accessToken: String(account?.accessToken || ''),
    };
  }
  const tlsFp = fp || accountFp(account);
  const prevAt = String(account?.accessToken || '');
  const rounds = Math.max(1, Number(attempts) || 1);
  let lastErr = null;
  for (let i = 1; i <= rounds; i++) {
    try {
      const cookieNow = String(account.sessionToken || sessionToken).trim();
      const got = await getAccessToken(cookieNow, proxy, tlsFp, {
        forceRefresh: true,
        refreshReason: reason,
      });
      if (got.sessionToken && got.sessionToken !== cookieNow) {
        account.sessionToken = got.sessionToken;
      }
      if (got.accessToken) account.accessToken = got.accessToken;
      const rotated = !!got.accessToken && got.accessToken !== prevAt;
      const detail = rotated
        ? `${reason} accessToken 已轮换`
        : `${reason} 未发现新 accessToken，沿用当前`;
      log(`[session_refresh] ${detail}${got.sessionRotated ? ' (cookie 已轮换)' : ''}`
        + (i > 1 ? ` attempt=${i}` : ''));
      if (requireRotated && !rotated) {
        lastErr = new Error('session_refresh_not_rotated');
        if (i < rounds) {
          await new Promise((r) => setTimeout(r, 400 * i));
          continue;
        }
        return {
          ok: false,
          rotated: false,
          accessToken: got.accessToken,
          sessionToken: account.sessionToken,
          sessionJson: got.sessionJson,
          reason: 'not_rotated',
        };
      }
      return {
        ok: true,
        rotated,
        accessToken: got.accessToken,
        sessionToken: account.sessionToken,
        sessionJson: got.sessionJson,
      };
    } catch (e) {
      lastErr = e;
      log(`[session_refresh] ${reason} 失败(${i}/${rounds}): ${e.message}`);
      if (i < rounds) await new Promise((r) => setTimeout(r, 400 * i));
    }
  }
  return {
    ok: false,
    rotated: false,
    error: lastErr,
    accessToken: String(account?.accessToken || ''),
    reason: lastErr?.message || 'refresh_failed',
  };
}

export function isCredentialFailureMessage(message) {
  if (!message) return false;
  const n = String(message).toLowerCase();
  return n.includes('http 401')
    || n.includes('http 403')
    || n.includes('status 401')
    || n.includes('status 403')
    || n.includes('token_expired')
    || n.includes('access_token_expired')
    || n.includes('unauthorized')
    || n.includes('forbidden')
    || n.includes('鉴权失败')
    || n.includes('取消续费失败: 401')
    || n.includes('取消续费失败: 403');
}

// ───── 登录态检测 ─────


export async function checkAlive(account, log = () => {}, proxy = null) {
  if (!account.sessionToken) return { alive: false, reason: 'no_token', error: '无 sessionToken' };
  const fp = accountFp(account);
  let accessToken, sessionJson;
  try {
    ({ accessToken, sessionJson } = await getAccessToken(account.sessionToken, proxy, fp));
  } catch (e) {
    const msg = e.message || '';
    // 关键:/api/auth/session 的任何非2xx(403/401/0/5xx/CF)都是「边缘/代理/CF 拒绝」,不是 token 问题 ——
    // 该接口对真过期的 token 返回 200-空(→ '无 accessToken'),从不返回 401。所以只有 200-无-accessToken 才算真过期。
    if (e.status === 403 || e.cfBlocked) return { alive: false, reason: 'cf_blocked', error: 'CF/代理拦截(会话接口)' };
    if (e.status === 401) return { alive: false, reason: 'proxy_down', error: '会话接口401(代理/边缘拒绝,非token失效)' };
    const nr = netReason(msg);
    if (nr) return { alive: false, reason: nr, error: msg };
    if (e.status === 0 || e.status >= 500) return { alive: false, reason: 'network', error: msg };
    if (msg.includes('过期') || msg.includes('accessToken')) return { alive: false, reason: 'token_expired', error: 'token已过期(session无accessToken)' };
    return { alive: false, reason: 'error', error: msg };
  }
  try {
    const resp = await ctlsFetch(`${BASE}/backend-api/accounts/check/v4-2023-04-27`, {
      headers: applyFp(browserHeaders({ 'Authorization': `Bearer ${accessToken}`, Origin: BASE, Referer: `${BASE}/`, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }), fp), ja3: fp.ja3,
    }, proxy);
    if (resp.status === 401 || resp.status === 403) {
      // OpenAI distinguishes explicit server-side revocation from expiry in the JSON body. Preserve
      // that distinction; /api/auth/session can still be 200 while accounts/check rejects the token.
      const body = await resp.text().catch(() => '');
      return classifyAccountsCheckFailure(resp.status, body);
    }
    if (resp.status >= 500) return { alive: false, reason: 'network', error: `status ${resp.status}` };
    if (!resp.ok) return { alive: false, reason: 'error', error: `status ${resp.status}` };
    const chk = await resp.json();
    const accounts = chk?.accounts || {};
    const accountId = accounts.default?.account?.account_id || Object.values(accounts)[0]?.account?.account_id || null;
    const plan = JSON.stringify(chk).match(/"plan_type":"(\w+)"/)?.[1] || null;
    // 卖号 claim 用:附带新鲜 accessToken + /api/auth/session 完整 JSON(交付时作为 session 列)。
    return { alive: true, reason: 'ok', accountId, plan, accessToken, sessionJson };
  } catch (e) {
    return { alive: false, reason: netReason(e.message) || 'error', error: e.message };
  }
}


export async function login(account, {
  password,
  getOtp,
  totpSecret = null,
  getTotp = null,
  proxy = null,
  log = () => {},
  tokenProvider = null,
}) {
  const oaiDid = uuid();
  let fp = accountFp(account);
  // 2FA secret: explicit opt → account fields (totpSecret preferred; totp for batch import).
  const resolvedTotpSecret = totpSecret || account?.totpSecret || account?.totp || account?.twoFa || null;
  if (tokenProvider?.prepare) {
    const prepared = await tokenProvider.prepare(oaiDid, 'oauth_create_account');
    if (!prepared?.deviceIdMatched || !prepared?.token || !prepared?.so) throw new Error('登录 Sentinel 浏览器准备失败');
    if (prepared.fp) {
      setRealFp(account.email, prepared.fp);
      fp = accountFp(account);
    }
  }
  // 全部请求(含 chatgpt.com CSRF/signin)统一走 CycleTLS+代理:
  // 保证同一账号 auth.openai.com 与 chatgpt.com 流量出自同一代理 IP + Chrome TLS 指纹,
  // 消除"一半代理IP一半服务器IP"的风控信号。指纹按账号稳定分配(同账号每次同一"设备")
  const authFetch = async (url, opts = {}) =>
    traceResp('login', opts.method || 'GET', url,
      await ctlsFetch(url, { ...opts, headers: applyFp(browserHeaders(opts.headers || {}), fp), ja3: fp.ja3 }, proxy));

  let jar = '';
  // Sentinel 令牌头(login 遇 about_you 需补全建号时用;缺则 create_account registration_disallowed)
  const sentinelHdr = async (flow) => {
    try { const t = tokenProvider ? await tokenProvider.sentinel(oaiDid, flow) : await buildSentinelToken(oaiDid, { flow, fp, proxy }); if (!t) throw new Error('空 token'); return { 'openai-sentinel-token': t }; }
    catch (e) { throw new Error(`[sentinel] ${flow} 令牌失败: ${e.message}`); }
  };
  const soHdr = async (flow = 'oauth_create_account') => {
    try { const t = tokenProvider ? await tokenProvider.so(oaiDid, flow) : await fetchSoToken(oaiDid, { fp, proxy }); if (!t) throw new Error('空 token'); return { 'openai-sentinel-so-token': t }; }
    catch (e) { throw new Error(`[sentinel] so 令牌失败: ${e.message}`); }
  };

  // Step 1: 获取初始 CSRF token
  log('获取 CSRF token…');
  const csrfResp = await authFetch(`${BASE}/api/auth/csrf`, {
    headers: browserHeaders({ 'Referer': `${BASE}/auth/login` }),
    redirect: 'manual',
  });
  jar = mergeCookies(jar, extractCookies(csrfResp));
  const csrfData = await csrfResp.json();
  if (!csrfData.csrfToken) throw new Error('获取 csrfToken 失败');

  // Step 2: 预热 POST 获取 __Host-next-auth.csrf-token cookie
  log('建立 CSRF 会话…');
  const warmupResp = await authFetch(`${BASE}/api/auth/signin/openai`, {
    method: 'POST',
    headers: browserHeaders({
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': jar,
      'Origin': BASE,
      'Referer': `${BASE}/auth/login`,
    }),
    body: `callbackUrl=%2F&csrfToken=${encodeURIComponent(csrfData.csrfToken)}&json=true`,
    redirect: 'manual',
  });
  jar = mergeCookies(jar, extractCookies(warmupResp));

  // Step 3: 重新获取匹配的 csrfToken
  const csrfResp2 = await authFetch(`${BASE}/api/auth/csrf`, {
    headers: browserHeaders({ 'Cookie': jar, 'Referer': `${BASE}/auth/login` }),
    redirect: 'manual',
  });
  jar = mergeCookies(jar, extractCookies(csrfResp2));
  const csrfToken = (await csrfResp2.json()).csrfToken;
  if (!csrfToken) throw new Error('第二次获取 csrfToken 失败');

  // Step 4: signin with prompt=login & login_hint=邮箱
  log('发起登录认证…');
  const signinUrl = `${BASE}/api/auth/signin/openai?prompt=login&login_hint=${encodeURIComponent(account.email)}`;
  const signinResp = await authFetch(signinUrl, {
    method: 'POST',
    headers: browserHeaders({
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': jar,
      'Origin': BASE,
      'Referer': BASE,
    }),
    body: `callbackUrl=${encodeURIComponent(BASE + '/')}&csrfToken=${encodeURIComponent(csrfToken)}&json=true`,
    redirect: 'manual',
  });
  jar = mergeCookies(jar, extractCookies(signinResp));
  const signinJson = await signinResp.json().catch(() => null);
  let authorizeUrl = signinJson?.url;
  if (!authorizeUrl || authorizeUrl.includes('error') || authorizeUrl.includes('csrf=true')) {
    throw new Error(`获取 authorize URL 失败: ${JSON.stringify(signinJson)}`);
  }
  log(`[DEBUG] authorizeUrl=${authorizeUrl.slice(0, 120)}`);

  // Step 3: GET authorize → 302 → /log-in/password or /email-verification or /create-account
  log('跳转 authorize…');
  let cfJar = '';
  let authResp = await authFetch(authorizeUrl, {
    headers: headers({ 'Referer': BASE }),
    redirect: 'manual',
  });
  if (authResp.status === 403) {
    log('authorize 403，尝试 cf_clearance 重试…');
    cfJar = await getCfClearance(AUTH0, proxy, log);
    if (cfJar) {
      authResp = await authFetch(authorizeUrl, {
        headers: headers({ 'Referer': BASE, 'Cookie': cfJar }),
        redirect: 'manual',
      });
    }
  }
  let auth0Jar = mergeCookies(cfJar, extractCookies(authResp));
  let location = authResp.headers.get('location') || '';
  const landingPage = location;
  log(`[DEBUG] authorize status=${authResp.status} url=${authResp.url?.slice(0,80)} landing=${landingPage.slice(0, 80)}`);
  if (authResp.status === 403) throw new Error('authorize_403: Cloudflare拦截，请更换代理或稍后重试');
  if (authResp.status >= 400) throw new Error(`authorize失败(${authResp.status})`);

  // 跟踪302直到到达目标页面
  while (location && location !== '') {
    const nextUrl = location.startsWith('http') ? location : `${AUTH0}${location}`;
    log(`[DEBUG] redirect → ${nextUrl.slice(0, 120)}`);
    const step = await authFetch(nextUrl, {
      headers: headers({ 'Cookie': auth0Jar, 'Referer': AUTH0 }),
      redirect: 'manual',
    });
    auth0Jar = mergeCookies(auth0Jar, extractCookies(step));
    if (step.status >= 300 && step.status < 400) {
      location = step.headers.get('location') || '';
    } else {
      break;
    }
  }

  if (landingPage.includes('/create-account')) {
    throw new Error('OpenAI账号不存在(邮箱未注册)');
  }

  // 内嵌OTP提交逻辑(email-verification流程复用)
  const submitOtp = async () => {
    if (typeof getOtp !== 'function') throw new Error('需要邮箱 OTP 但未提供 getOtp');
    log('等待邮箱验证码…');
    let code = await getOtp();
    if (!code) {
      // OTP可能已过期，请求重发
      log('未收到OTP，请求重发…');
      const resendResp = await authFetch(`${AUTH0}/api/accounts/email-otp/resend`, {
        method: 'POST',
        headers: headers({
          'Content-Type': 'application/json', 'Accept': 'application/json',
          ...traceHeaders(), 'oai-device-id': oaiDid,
          'Cookie': auth0Jar, 'Origin': AUTH0, 'Referer': `${AUTH0}/email-verification`,
        }),
        body: JSON.stringify({}),
        redirect: 'manual',
      });
      auth0Jar = mergeCookies(auth0Jar, extractCookies(resendResp));
      log(`[DEBUG] resend OTP status=${resendResp.status}`);
      code = await getOtp();
      if (!code) throw new Error('没拿到邮箱验证码(检查关联 mail 账号)');
    }
    log(`提交验证码: ${code}`);
    const otpResp = await authFetch(`${AUTH0}/api/accounts/email-otp/validate`, {
      method: 'POST',
      headers: headers({
        'Content-Type': 'application/json', 'Accept': 'application/json',
        ...traceHeaders(), 'oai-device-id': oaiDid,
        'Cookie': auth0Jar, 'Origin': AUTH0, 'Referer': `${AUTH0}/email-verification`,
      }),
      body: JSON.stringify({ code }),
      redirect: 'manual',
    });
    auth0Jar = mergeCookies(auth0Jar, extractCookies(otpResp));
    const otpRaw = await otpResp.text().catch(() => '');
    let d = null;
    try { d = otpRaw ? JSON.parse(otpRaw) : null; } catch { d = null; }
    log(`[DEBUG] otp/validate status=${otpResp.status} continue_url=${d?.continue_url?.slice(0, 80)} body=${(otpRaw || '').slice(0, 220)}`);
    if (otpResp.status >= 400) {
      const _j = otpRaw || JSON.stringify(d);
      // 账号被删/停用:OpenAI 照常发了验证码,但验证码校验这一步才返回 "deleted or deactivated" → 直接判封号(不当验证码问题重试/超时)
      if (/account_deactivated|deactivated|deleted|suspended|do not have an account/i.test(_j)) throw new Error('account_deactivated: 账号已被 OpenAI 删除/停用(登录验证码校验返回,非验证码问题)');
      throw new Error(`OTP验证失败(${otpResp.status}): ${_j.slice(0, 300)}`);
    }
    return d;
  };

  // password/verify → page.type=mfa_challenge 时走 TOTP。
  // 协议(2026-07-30 抓包确认): POST /api/accounts/mfa/verify
  //   body = { type: "totp", id: <factor_id>, code: "123456" }
  // factor id 取 payload.factors[].id (factor_type=totp) 或 payload.factor_id。
  const submitMfaTotp = async (mfaData) => {
    const factors = mfaData?.page?.payload?.factors || [];
    const totpFactor = factors.find((f) => f?.factor_type === 'totp')
      || factors.find((f) => f?.id && f.id === mfaData?.page?.payload?.factor_id)
      || null;
    const factorId = totpFactor?.id || mfaData?.page?.payload?.factor_id || null;
    if (!factorId) throw new Error('mfa_challenge 无 totp factor id');
    const continueUrl = mfaData?.continue_url
      || `${AUTH0}/mfa-challenge/${factorId}`;
    const resolveCode = async () => {
      if (typeof getTotp === 'function') {
        const c = await getTotp();
        if (c) return String(c).replace(/\s+/g, '');
      }
      if (resolvedTotpSecret) return totpCode(resolvedTotpSecret);
      throw new Error('mfa_challenge 需要 TOTP(账号未存 2FA 密钥 totpSecret)');
    };
    // 时钟边界时重试一次(前后 30s 窗口)
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const code = await resolveCode();
      log(`提交 MFA TOTP(${attempt ? 'retry' : '1st'}): ${code} factor=${factorId.slice(0, 12)}…`);
      const mfaResp = await authFetch(`${AUTH0}/api/accounts/mfa/verify`, {
        method: 'POST',
        headers: headers({
          'Content-Type': 'application/json', 'Accept': 'application/json',
          ...traceHeaders(), 'oai-device-id': oaiDid,
          'Cookie': auth0Jar, 'Origin': AUTH0,
          'Referer': continueUrl.startsWith('http') ? continueUrl : `${AUTH0}${continueUrl}`,
        }),
        body: JSON.stringify({ type: 'totp', id: factorId, code }),
        redirect: 'manual',
      });
      auth0Jar = mergeCookies(auth0Jar, extractCookies(mfaResp));
      const mfaRaw = await mfaResp.text().catch(() => '');
      let d = null;
      try { d = mfaRaw ? JSON.parse(mfaRaw) : null; } catch { d = null; }
      log(`[DEBUG] mfa/verify status=${mfaResp.status} continue_url=${d?.continue_url?.slice(0, 80)} body=${(mfaRaw || '').slice(0, 220)}`);
      if (mfaResp.status < 400 && d?.continue_url) return d;
      const msg = d?.error?.message || mfaRaw || `status ${mfaResp.status}`;
      lastErr = new Error(`MFA TOTP 验证失败(${mfaResp.status}): ${String(msg).slice(0, 300)}`);
      // 错误码/文案像「验证码错」才重试；缺参/会话失效直接抛
      if (!/invalid|incorrect|code|totp|mfa/i.test(String(msg)) || /missing|session|expired/i.test(String(msg))) {
        throw lastErr;
      }
    }
    throw lastErr || new Error('MFA TOTP 验证失败');
  };

  let lastData = null;

  if (landingPage.includes('/email-verification')) {
    // 无密码账号: authorize已触发OTP发送，直接等待
    log('无密码账号，OTP已发送，等待邮箱验证码…');
    lastData = await submitOtp();
  } else {
    // /log-in/password 流程: 先试密码，密码错/无密码则OTP兜底
    // Step 4: 提交密码到 /api/accounts/password/verify
    log('提交密码…');
    const pwdResp = await authFetch(`${AUTH0}/api/accounts/password/verify`, {
      method: 'POST',
      headers: headers({
        'Content-Type': 'application/json', 'Accept': 'application/json',
        ...traceHeaders(), 'oai-device-id': oaiDid,
        'Cookie': auth0Jar, 'Origin': AUTH0, 'Referer': `${AUTH0}/log-in/password`,
      }),
      body: JSON.stringify({ password }),
      redirect: 'manual',
    });
    auth0Jar = mergeCookies(auth0Jar, extractCookies(pwdResp));
    const pwdData = await pwdResp.json().catch(() => null);
    log(`[DEBUG] password/verify status=${pwdResp.status} page=${pwdData?.page?.type} body=${JSON.stringify(pwdData)?.slice(0,200)}`);

    if (pwdResp.status === 409 || pwdResp.status >= 400) {
      // 密码错误/无效，走OTP兜底
      // 不再发起第二次 authorize（可能被CF拦截），直接用当前 auth0Jar（含login_session）触发 OTP
      log('密码验证失败，尝试OTP登录…');
      const auth0JarBefore2nd = auth0Jar; // 保存第一次authorize后的有效session
      // 先尝试 GET /email-otp/send（与register流程一致）
      let otpSendResp = await authFetch(`${AUTH0}/api/accounts/email-otp/send`, {
        headers: headers({
          ...traceHeaders(), 'oai-device-id': oaiDid,
          'Cookie': auth0JarBefore2nd, 'Referer': `${AUTH0}/log-in/password`,
        }),
        redirect: 'manual',
      });
      log(`[DEBUG] OTP send(GET) status=${otpSendResp.status}`);
      // 如果GET不行，降级到带login_session的authorize重试（如果cfJar有效）
      if (otpSendResp.status >= 400 && cfJar) {
        log('[DEBUG] OTP send失败，尝试带cfJar的第二次authorize…');
        const authResp2 = await authFetch(authorizeUrl, {
          headers: headers({ 'Referer': BASE, 'Cookie': mergeCookies(cfJar, auth0JarBefore2nd) }),
          redirect: 'manual',
        });
        log(`[DEBUG] OTP authorize2 status=${authResp2.status}`);
        if (authResp2.status < 400) {
          auth0Jar = mergeCookies(auth0JarBefore2nd, extractCookies(authResp2));
          let loc2 = authResp2.headers.get('location') || '';
          while (loc2) {
            const u = loc2.startsWith('http') ? loc2 : `${AUTH0}${loc2}`;
            const s = await authFetch(u, { headers: headers({ 'Cookie': auth0Jar, 'Referer': AUTH0 }), redirect: 'manual' });
            auth0Jar = mergeCookies(auth0Jar, extractCookies(s));
            if (s.status >= 300 && s.status < 400) loc2 = s.headers.get('location') || '';
            else break;
          }
          otpSendResp = await authFetch(`${AUTH0}/api/accounts/email-otp/resend`, {
            method: 'POST',
            headers: headers({
              'Content-Type': 'application/json', 'Accept': 'application/json',
              ...traceHeaders(), 'oai-device-id': oaiDid,
              'Cookie': auth0Jar, 'Origin': AUTH0, 'Referer': `${AUTH0}/email-verification`,
            }),
            body: JSON.stringify({}),
            redirect: 'manual',
          });
          log(`[DEBUG] OTP resend(POST) status=${otpSendResp.status}`);
        }
      }
      auth0Jar = mergeCookies(auth0Jar, extractCookies(otpSendResp));
      lastData = await submitOtp();
    } else if (pwdData?.page?.type === 'mfa_challenge') {
      lastData = await submitMfaTotp(pwdData);
    } else if (pwdData?.page?.type === 'email_otp_verification') {
      // 密码正确但还需要OTP二次验证
      lastData = await submitOtp();
    } else {
      lastData = pwdData;
    }
  }

  // about_you 补全: 部分账号验证通过后停在 profile 填写页(page.type=about_you 或
  // continue_url 指向 /create-account/about-you)，此时需 POST create_account 完成建号，
  // 否则拿不到 session-token。之前会误抛错降级到注册流程(C4)。
  const needsAboutYou = lastData?.page?.type === 'about_you'
    || (typeof lastData?.continue_url === 'string' && lastData.continue_url.includes('about-you'))
    || (!lastData?.continue_url && !!lastData);
  if (needsAboutYou) {
    log('检测到 about_you 页面，补全资料…');
    const createResp = await authFetch(`${AUTH0}/api/accounts/create_account`, {
      method: 'POST',
      headers: headers({
        'Content-Type': 'application/json', 'Accept': 'application/json',
        ...traceHeaders(), 'oai-device-id': oaiDid,
        ...await sentinelHdr('oauth_create_account'), ...await soHdr('oauth_create_account'),
        'Cookie': auth0Jar, 'Origin': AUTH0, 'Referer': `${AUTH0}/create-account/about-you`,
      }),
      body: JSON.stringify(randomProfile(account.email)),
      redirect: 'manual',
    });
    auth0Jar = mergeCookies(auth0Jar, extractCookies(createResp));
    const createData = await createResp.json().catch(() => null);
    log(`[DEBUG] about_you create_account status=${createResp.status} continue_url=${createData?.continue_url?.slice(0, 80)}`);
    if (createResp.status < 400 && createData?.continue_url) lastData = createData;
  }

  // Step 6: 跟踪回调链回到 chatgpt.com，拿 session-token
  log('跟踪回调链…');
  let redirectUrl = lastData?.continue_url || '';
  let finalCookies = jar;

  for (let i = 0; i < 10 && redirectUrl; i++) {
    const fullUrl = redirectUrl.startsWith('http') ? redirectUrl : `${AUTH0}${redirectUrl}`;
    const isAuth0 = fullUrl.includes('auth.openai.com');
    log(`[DEBUG] callback ${i}: ${fullUrl.slice(0, 120)}`);
    const rResp = await authFetch(fullUrl, {
      headers: headers({ 'Cookie': isAuth0 ? auth0Jar : finalCookies }),
      redirect: 'manual',
    });
    const newCookies = extractCookies(rResp);
    log(`[DEBUG] callback ${i} status=${rResp.status} cookies=${newCookies.slice(0, 200)}`);
    if (isAuth0) auth0Jar = mergeCookies(auth0Jar, newCookies);
    else finalCookies = mergeCookies(finalCookies, newCookies);

    if (rResp.status >= 300 && rResp.status < 400) {
      redirectUrl = rResp.headers.get('location') || '';
    } else {
      const body = await rResp.text().catch(() => '');
      try {
        const json = JSON.parse(body);
        if (json.continue_url) { redirectUrl = json.continue_url; continue; }
      } catch {}
      break;
    }
  }

  // session-token 可能是完整的或分片的(.0 .1 .2 ...)。缺段时直接失败，禁止
  // 把半截 token 当成成功结果落库或交付。
  const sessionToken = extractSessionToken(finalCookies);

  log('验证登录态…');
  const { accessToken, sessionJson } = await getAccessToken(sessionToken, proxy, fp);
  const chkResp = await authFetch(`${BASE}/backend-api/accounts/check/v4-2023-04-27`, {
    headers: browserHeaders({ 'Authorization': `Bearer ${accessToken}`, Origin: BASE, Referer: `${BASE}/`, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }),
  });
  const chk = await chkResp.json().catch(() => ({}));
  const accounts = chk?.accounts || {};
  const accountId = accounts.default?.account?.account_id || Object.values(accounts)[0]?.account?.account_id || null;

  log('登录完成 ✓');
  return { ok: true, sessionToken, accountId, accessToken, sessionJson, fp };
}


// ───── 修改GPT密码(已知当前密码) ─────
// 流程(HAR): signin(connection=password,post_login_password_reset=true,max_age=0)
//   → authorize → /log-in/password → password/verify(当前密码) → [mfa] → password/reset → callback
// 对齐 login：authorize 不把 chatgpt.com cookie 带给 auth.openai.com；Auth0 API 带 oai-device-id。

export async function changePassword(account, {
  currentPassword,
  newPassword,
  proxy = null,
  totpSecret = null,
  log = () => {},
}) {
  const oaiDid = uuid();
  const fp = accountFp(account);
  const authFetch = (url, opts = {}) =>
    ctlsFetch(url, { ...opts, headers: applyFp(opts.headers || {}, fp), ja3: fp.ja3 }, proxy);
  const resolvedTotp = totpSecret || account?.totpSecret || account?.totp || account?.twoFa || null;
  const auth0ApiHeaders = (extra = {}) => headers({
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: AUTH0,
    ...traceHeaders(),
    'oai-device-id': oaiDid,
    ...extra,
  });

  // chatgpt 侧 jar：若已有 session，seed 供 reauth 挂登录态（只用于 chatgpt.com，不送 auth0）
  let jar = '';
  if (account?.sessionToken) {
    try { jar = buildSessionCookie(account.sessionToken); } catch { jar = ''; }
  }

  log('获取 CSRF token…');
  const csrfResp0 = await authFetch(`${BASE}/api/auth/csrf`, {
    headers: browserHeaders({ Referer: BASE, ...(jar ? { Cookie: jar } : {}) }),
    redirect: 'manual',
  });
  jar = mergeCookies(jar, extractCookies(csrfResp0));
  const csrf0 = (await csrfResp0.json()).csrfToken;

  log('建立 CSRF 会话…');
  const warmupResp = await authFetch(`${BASE}/api/auth/signin/openai`, {
    method: 'POST',
    headers: browserHeaders({
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: jar, Origin: BASE, Referer: BASE,
    }),
    body: `callbackUrl=%2F&csrfToken=${encodeURIComponent(csrf0)}&json=true`,
    redirect: 'manual',
  });
  jar = mergeCookies(jar, extractCookies(warmupResp));

  const csrfResp = await authFetch(`${BASE}/api/auth/csrf`, {
    headers: browserHeaders({ Cookie: jar, Referer: BASE }),
    redirect: 'manual',
  });
  jar = mergeCookies(jar, extractCookies(csrfResp));
  const csrfToken = (await csrfResp.json()).csrfToken;
  if (!csrfToken) throw new Error('获取 csrfToken 失败');

  log('发起改密码认证…');
  const signinUrl = `${BASE}/api/auth/signin/openai?connection=password&login_hint=${encodeURIComponent(account.email)}&reauth=password&post_login_password_reset=true&max_age=0`;
  const signinResp = await authFetch(signinUrl, {
    method: 'POST',
    headers: browserHeaders({
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: jar, Origin: BASE, Referer: `${BASE}/#settings/Account`,
    }),
    body: `callbackUrl=${encodeURIComponent(BASE + '/#settings/Account')}&csrfToken=${encodeURIComponent(csrfToken)}&json=true`,
    redirect: 'manual',
  });
  jar = mergeCookies(jar, extractCookies(signinResp));
  const signinJson = await signinResp.json().catch(() => null);
  const authorizeUrl = signinJson?.url;
  if (!authorizeUrl || authorizeUrl.includes('error') || authorizeUrl.includes('csrf=true')) {
    throw new Error(`获取 authorize URL 失败: ${JSON.stringify(signinJson)}`);
  }
  log(`[DEBUG] authorizeUrl=${authorizeUrl.slice(0, 120)}`);

  // 与 login 一致：authorize 不携带 chatgpt jar，避免 ctls 跨域污染 Auth0 session
  log('跳转 authorize…');
  const authResp = await authFetch(authorizeUrl, {
    headers: headers({ Referer: BASE, ...traceHeaders(), 'oai-device-id': oaiDid }),
    redirect: 'manual',
  });
  let auth0Jar = extractCookies(authResp);
  let location = authResp.headers.get('location') || '';
  log(`[DEBUG] authorize status=${authResp.status} landing=${location.slice(0, 120)} ck_len=${auth0Jar.length}`);
  if (authResp.status === 429) {
    throw new Error('改密 authorize 429(限流)，请稍后/换代理重试');
  }
  if (!location && authResp.status >= 400) {
    throw new Error(`改密 authorize 失败(${authResp.status})`);
  }
  while (location) {
    const u = location.startsWith('http') ? location : `${AUTH0}${location}`;
    log(`[DEBUG] redirect → ${u.slice(0, 120)}`);
    const s = await authFetch(u, {
      headers: headers({ Cookie: auth0Jar, Referer: AUTH0, ...traceHeaders(), 'oai-device-id': oaiDid }),
      redirect: 'manual',
    });
    auth0Jar = mergeCookies(auth0Jar, extractCookies(s));
    if (s.status >= 300 && s.status < 400) location = s.headers.get('location') || '';
    else break;
  }
  if (!auth0Jar) throw new Error('改密 authorize 未拿到 auth0 cookie');

  log('验证当前密码…');
  const verifyResp = await authFetch(`${AUTH0}/api/accounts/password/verify`, {
    method: 'POST',
    headers: auth0ApiHeaders({
      Cookie: auth0Jar,
      Referer: `${AUTH0}/log-in/password`,
    }),
    body: JSON.stringify({ password: currentPassword }),
    redirect: 'manual',
  });
  auth0Jar = mergeCookies(auth0Jar, extractCookies(verifyResp));
  let verifyData = await verifyResp.json().catch(() => null);
  log(`[DEBUG] password/verify status=${verifyResp.status} page=${verifyData?.page?.type || ''}`);
  if (verifyResp.status >= 400) {
    throw new Error(`当前密码验证失败(${verifyResp.status}): ${JSON.stringify(verifyData).slice(0, 300)}`);
  }
  // 部分号开启 TOTP：password/verify 后落到 mfa_challenge，需先过 2FA 再 reset
  if (verifyData?.page?.type === 'mfa_challenge') {
    const factors = verifyData?.page?.payload?.factors || [];
    const totpFactor = factors.find((f) => f?.factor_type === 'totp')
      || factors.find((f) => f?.id && f.id === verifyData?.page?.payload?.factor_id)
      || null;
    const factorId = totpFactor?.id || verifyData?.page?.payload?.factor_id || null;
    if (!factorId) throw new Error('改密流程 mfa_challenge 无 totp factor id');
    if (!resolvedTotp) throw new Error('改密需要 TOTP(账号未存 totpSecret)');
    const code = totpCode(resolvedTotp);
    log(`改密前 MFA TOTP: ${code} factor=${String(factorId).slice(0, 12)}…`);
    const mfaResp = await authFetch(`${AUTH0}/api/accounts/mfa/verify`, {
      method: 'POST',
      headers: auth0ApiHeaders({
        Cookie: auth0Jar,
        Referer: `${AUTH0}/mfa-challenge/${factorId}`,
      }),
      body: JSON.stringify({ type: 'totp', id: factorId, code }),
      redirect: 'manual',
    });
    auth0Jar = mergeCookies(auth0Jar, extractCookies(mfaResp));
    const mfaData = await mfaResp.json().catch(() => null);
    log(`[DEBUG] 改密 mfa/verify status=${mfaResp.status} page=${mfaData?.page?.type || ''}`);
    if (mfaResp.status >= 400) {
      throw new Error(`改密 MFA 失败(${mfaResp.status}): ${JSON.stringify(mfaData).slice(0, 240)}`);
    }
    verifyData = mfaData || verifyData;
  }

  // 落到 reset 页时先 GET 一下，带上 continue_url 的 cookie
  const contAfterVerify = String(verifyData?.continue_url || '');
  if (contAfterVerify.includes('reset-password') || verifyData?.page?.type === 'reset_password_new_password') {
    const u = contAfterVerify.startsWith('http') ? contAfterVerify : `${AUTH0}${contAfterVerify || '/reset-password/new-password'}`;
    const s = await authFetch(u, {
      headers: headers({ Cookie: auth0Jar, Referer: AUTH0, ...traceHeaders(), 'oai-device-id': oaiDid }),
      redirect: 'manual',
    });
    auth0Jar = mergeCookies(auth0Jar, extractCookies(s));
    log(`[DEBUG] open reset page status=${s.status}`);
  }

  log('设置新密码…');
  const resetResp = await authFetch(`${AUTH0}/api/accounts/password/reset`, {
    method: 'POST',
    headers: auth0ApiHeaders({
      Cookie: auth0Jar,
      Referer: `${AUTH0}/reset-password/new-password`,
    }),
    body: JSON.stringify({ password: newPassword }),
    redirect: 'manual',
  });
  auth0Jar = mergeCookies(auth0Jar, extractCookies(resetResp));
  const resetData = await resetResp.json().catch(() => null);
  log(`[DEBUG] password/reset status=${resetResp.status} page=${resetData?.page?.type || ''}`);
  if (resetResp.status >= 400) {
    throw new Error(`修改密码失败(${resetResp.status}): ${JSON.stringify(resetData).slice(0, 300)}`);
  }
  // iCloud 等无邮箱接码：reset 后若要 email OTP，协议无法完成
  if (resetData?.page?.type === 'email_otp_verification'
    || String(resetData?.continue_url || '').includes('email-verification')) {
    const err = new Error('改密需要邮箱 OTP（iCloud 等无接码邮箱无法完成协议改密）');
    err.code = 'password_reset_needs_email_otp';
    throw err;
  }

  log('跟踪回调链…');
  let redirectUrl = resetData?.continue_url || '';
  let finalCookies = jar;
  for (let i = 0; i < 10 && redirectUrl; i++) {
    const fullUrl = redirectUrl.startsWith('http') ? redirectUrl : `${AUTH0}${redirectUrl}`;
    const isAuth0 = fullUrl.includes('auth.openai.com');
    const rResp = await authFetch(fullUrl, {
      headers: headers({ Cookie: isAuth0 ? auth0Jar : finalCookies }),
      redirect: 'manual',
    });
    const newCookies = extractCookies(rResp);
    if (isAuth0) auth0Jar = mergeCookies(auth0Jar, newCookies);
    else finalCookies = mergeCookies(finalCookies, newCookies);
    if (rResp.status >= 300 && rResp.status < 400) redirectUrl = rResp.headers.get('location') || '';
    else break;
  }

  log('密码修改完成 ✓');
  return { ok: true };
}


// ───── 关闭 TOTP MFA（ChatGPT Settings in-house）─────
// 协议(2026-07-30 逆向 + 单号实证):
//   1) 近期 re-login（password + TOTP）满足 recent_auth_required
//   2) GET  /backend-api/accounts/mfa_info → native_default_factor_id / factors.totp[]
//   3) POST /backend-api/accounts/mfa/user/disable_in_house  body { factor_id }
//   4) 以 mfa_info.mfa_enabled / mfa_enabled_v2 为准（旧 session 的 me.mfa_flag_enabled 可能残留 amr）
//
// 成功: { ok, alreadyDisabled?, factorId, sessionToken?, accountId?, mfaInfo, message, fp? }

export async function disableMfa(account, {
  password = null,
  totpSecret = null,
  getOtp = null,
  proxy = null,
  log = () => {},
  reLogin = true,
  tokenProvider = null,
} = {}) {
  const secret = totpSecret || account.totpSecret || account.totp || account.twoFa || null;
  const pwd = password || account.gptPassword || null;
  let sessionToken = account.sessionToken || null;
  let accountId = account.accountId || null;
  let loginFp = null;

  if (reLogin) {
    if (!pwd) throw new Error('disableMfa 需要 password（或账号 gptPassword）以 re-login');
    if (!secret && typeof getOtp !== 'function') {
      throw new Error('disableMfa re-login 需要 totpSecret（或 getOtp）');
    }
    log('re-login 以满足 recent_auth…');
    const res = await login(account, {
      password: pwd,
      totpSecret: secret,
      getOtp: getOtp || (async () => {
        throw new Error('需要邮箱 OTP 但未提供 getOtp');
      }),
      proxy,
      tokenProvider,
      log,
    });
    sessionToken = res.sessionToken;
    accountId = res.accountId || accountId;
    loginFp = res.fp || null;
  }
  if (!sessionToken) throw new Error('disableMfa 无 sessionToken（请 reLogin 或先登录）');

  const fp = loginFp ? accountFp({ ...account, fp: loginFp, email: account.email }) : accountFp(account);
  const authFetch = (url, opts = {}) => ctlsFetch(url, {
    ...opts,
    headers: applyFp(browserHeaders(opts.headers || {}), fp),
    ja3: fp.ja3,
  }, proxy);

  const cookie = buildSessionCookie(sessionToken);
  const { accessToken } = await getAccessToken(sessionToken, proxy, fp);
  const oaiDid = uuid();
  const apiHeaders = (extra = {}) => browserHeaders({
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    Cookie: cookie,
    Origin: BASE,
    Referer: `${BASE}/#settings/Security?disable_mfa=true`,
    'oai-device-id': oaiDid,
    ...traceHeaders(),
    ...extra,
  });

  async function getMfaInfo() {
    const r = await authFetch(`${BASE}/backend-api/accounts/mfa_info`, {
      headers: apiHeaders(),
    });
    const t = await r.text();
    let j = null;
    try { j = JSON.parse(t); } catch { /* raw */ }
    if (!r.ok) {
      const err = new Error(`mfa_info ${r.status}: ${t.slice(0, 200)}`);
      err.status = r.status;
      err.body = j || t;
      throw err;
    }
    return j;
  }

  function pickFactorId(info) {
    if (info?.native_default_factor_id) return info.native_default_factor_id;
    const f = info?.factors;
    if (!f) return null;
    if (Array.isArray(f)) {
      return (f.find((x) => x?.factor_type === 'totp' || x?.type === 'totp') || f[0])?.id || null;
    }
    if (typeof f === 'object') {
      const totpList = f.totp || f.TOTP;
      if (Array.isArray(totpList) && totpList[0]?.id) return totpList[0].id;
      for (const v of Object.values(f)) {
        if (Array.isArray(v) && v[0]?.id) return v[0].id;
      }
    }
    return null;
  }

  log('查询 mfa_info…');
  let info = await getMfaInfo();
  const enabled = !!(info?.mfa_enabled_v2 ?? info?.mfa_enabled);
  if (!enabled) {
    log('MFA 已关闭');
    return {
      ok: true,
      alreadyDisabled: true,
      factorId: null,
      sessionToken,
      accountId,
      mfaInfo: info,
      message: 'already_disabled',
      fp: loginFp,
    };
  }

  const factorId = pickFactorId(info);
  if (!factorId) throw new Error('mfa_info 无 factor_id（无法 disable_in_house）');

  log(`disable_in_house factor=${String(factorId).slice(0, 12)}…`);
  const disR = await authFetch(`${BASE}/backend-api/accounts/mfa/user/disable_in_house`, {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ factor_id: factorId }),
  });
  const disT = await disR.text();
  let disJ = null;
  try { disJ = JSON.parse(disT); } catch { /* raw */ }
  if (!disR.ok) {
    let code = disJ?.error?.code || null;
    if (!code && typeof disJ?.detail === 'string') {
      try { code = JSON.parse(disJ.detail)?.error?.code || null; } catch { /* */ }
    }
    const err = new Error(`disable_in_house ${disR.status}: ${disT.slice(0, 250)}`);
    err.status = disR.status;
    err.code = code;
    err.body = disJ || disT;
    throw err;
  }

  info = await getMfaInfo();
  const stillOn = !!(info?.mfa_enabled_v2 ?? info?.mfa_enabled);
  if (stillOn) {
    throw new Error(`disable 返回成功但 mfa_info 仍 enabled: ${JSON.stringify(info).slice(0, 200)}`);
  }
  log('MFA 已关闭 ✓');
  return {
    ok: true,
    alreadyDisabled: false,
    factorId,
    sessionToken,
    accountId,
    mfaInfo: info,
    message: disJ?.message || 'Factor disabled',
    disableResponse: disJ,
    fp: loginFp,
  };
}

// ───── 开启 / 绑定 TOTP MFA（ChatGPT Settings → Authenticator）─────
// 协议(2026-08-09 副2 单号实证 a_chan810@mail.com):
//   1) re-login（password + 邮箱 OTP 或已有 TOTP）满足 recent_auth
//   2) POST /backend-api/accounts/mfa/user/request_mfa_token_in_house → { state_token }
//   3) GET  auth.openai.com/totp_enroll?origin_app_name=ChatGPT&mfa_token=<state_token>  (拉 auth0 cookie)
//   4) POST auth.openai.com/api/mfa/public/enroll
//        body { factor_type: "totp", token: <state_token> }
//        → { secret, email, session_id, factor: { id, factor_type } }
//   5) POST auth.openai.com/api/mfa/public/activate_enrollment
//        body { factor_type: "totp", code: <totp>, token: <state_token> }
//   6) GET  /backend-api/accounts/mfa_info → mfa_enabled / mfa_enabled_v2 === true
//
// 成功: { ok, alreadyEnabled?, totpSecret, factorId, sessionToken?, accountId?, mfaInfo, message, fp? }
export async function enableMfa(account, {
  password = null,
  totpSecret = null,
  getOtp = null,
  proxy = null,
  log = () => {},
  reLogin = true,
  tokenProvider = null,
} = {}) {
  const existingSecret = totpSecret || account.totpSecret || account.totp || account.twoFa || null;
  const pwd = password || account.gptPassword || null;
  let sessionToken = account.sessionToken || null;
  let accountId = account.accountId || null;
  let loginFp = null;

  if (reLogin) {
    if (!pwd) throw new Error('enableMfa 需要 password（或账号 gptPassword）以 re-login');
    if (!existingSecret && typeof getOtp !== 'function') {
      throw new Error('enableMfa re-login 需要 getOtp（邮箱 OTP）或已有 totpSecret');
    }
    log('re-login 以满足 recent_auth…');
    const res = await login(account, {
      password: pwd,
      totpSecret: existingSecret,
      getOtp: getOtp || (async () => {
        throw new Error('需要邮箱 OTP 但未提供 getOtp');
      }),
      proxy,
      tokenProvider,
      log,
    });
    sessionToken = res.sessionToken;
    accountId = res.accountId || accountId;
    loginFp = res.fp || null;
  }
  if (!sessionToken) throw new Error('enableMfa 无 sessionToken（请 reLogin 或先登录）');

  const fp = loginFp ? accountFp({ ...account, fp: loginFp, email: account.email }) : accountFp(account);
  const authFetch = (url, opts = {}) => ctlsFetch(url, {
    ...opts,
    headers: applyFp(browserHeaders(opts.headers || {}), fp),
    ja3: fp.ja3,
  }, proxy);

  const cookie = buildSessionCookie(sessionToken);
  const { accessToken } = await getAccessToken(sessionToken, proxy, fp);
  const oaiDid = uuid();
  const apiHeaders = (extra = {}) => browserHeaders({
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    Cookie: cookie,
    Origin: BASE,
    Referer: `${BASE}/#settings/Security`,
    'oai-device-id': oaiDid,
    ...traceHeaders(),
    ...extra,
  });

  async function getMfaInfo() {
    const r = await authFetch(`${BASE}/backend-api/accounts/mfa_info`, {
      headers: apiHeaders(),
    });
    const t = await r.text();
    let j = null;
    try { j = JSON.parse(t); } catch { /* raw */ }
    if (!r.ok) {
      const err = new Error(`mfa_info ${r.status}: ${t.slice(0, 200)}`);
      err.status = r.status;
      err.body = j || t;
      throw err;
    }
    return j;
  }

  log('查询 mfa_info…');
  let info = await getMfaInfo();
  const alreadyOn = !!(info?.mfa_enabled_v2 ?? info?.mfa_enabled);
  if (alreadyOn) {
    const existing = existingSecret || null;
    log('MFA 已开启');
    return {
      ok: true,
      alreadyEnabled: true,
      totpSecret: existing,
      factorId: info?.native_default_factor_id || info?.factors?.totp?.[0]?.id || null,
      sessionToken,
      accountId,
      mfaInfo: info,
      message: existing ? 'already_enabled' : 'already_enabled_but_no_local_secret',
      fp: loginFp,
    };
  }

  log('request_mfa_token_in_house…');
  const tokR = await authFetch(`${BASE}/backend-api/accounts/mfa/user/request_mfa_token_in_house`, {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({}),
  });
  const tokT = await tokR.text();
  let tokJ = null;
  try { tokJ = JSON.parse(tokT); } catch { /* raw */ }
  if (!tokR.ok) {
    const err = new Error(`request_mfa_token_in_house ${tokR.status}: ${tokT.slice(0, 250)}`);
    err.status = tokR.status;
    err.body = tokJ || tokT;
    throw err;
  }
  let stateToken = tokJ?.state_token || tokJ?.mfa_token || tokJ?.token || null;
  if (!stateToken && typeof tokJ?.detail === 'string') {
    try { stateToken = JSON.parse(tokJ.detail)?.state_token || null; } catch { /* */ }
  }
  if (!stateToken) throw new Error(`request_mfa_token_in_house 无 state_token: ${tokT.slice(0, 200)}`);

  // 打开 totp_enroll 页，合并 auth0 cookie（部分环境直接 enroll 也会 200，但 hop 更稳）
  let auth0Jar = cookie;
  const enrollPage = `${AUTH0}/totp_enroll?${new URLSearchParams({
    origin_app_name: 'ChatGPT',
    mfa_token: stateToken,
  })}`;
  let pageUrl = enrollPage;
  try {
    let r = await authFetch(enrollPage, {
      headers: browserHeaders({ Cookie: auth0Jar, Referer: BASE }),
      redirect: 'manual',
    });
    auth0Jar = mergeCookies(auth0Jar, extractCookies(r));
    let loc = r.headers.get('location') || '';
    for (let i = 0; i < 8; i++) {
      if (r.status >= 300 && r.status < 400 && loc) {
        const u = loc.startsWith('http') ? loc : `${AUTH0}${loc}`;
        r = await authFetch(u, {
          headers: browserHeaders({ Cookie: auth0Jar, Referer: AUTH0 }),
          redirect: 'manual',
        });
        auth0Jar = mergeCookies(auth0Jar, extractCookies(r));
        loc = r.headers.get('location') || '';
        pageUrl = u;
        continue;
      }
      await r.text().catch(() => '');
      break;
    }
  } catch (e) {
    log(`totp_enroll page warn: ${e.message}`);
  }

  async function auth0Api(method, p, body) {
    const rr = await authFetch(`${AUTH0}${p}`, {
      method,
      headers: browserHeaders({
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Cookie: auth0Jar,
        Origin: AUTH0,
        Referer: pageUrl || enrollPage,
        'oai-device-id': oaiDid,
        ...traceHeaders(),
      }),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    auth0Jar = mergeCookies(auth0Jar, extractCookies(rr));
    const text = await rr.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* raw */ }
    return { status: rr.status, ok: rr.ok, json, text };
  }

  log('public/enroll totp…');
  const enroll = await auth0Api('POST', '/api/mfa/public/enroll', {
    factor_type: 'totp',
    token: stateToken,
  });
  if (!enroll.ok) {
    const err = new Error(`mfa/public/enroll ${enroll.status}: ${enroll.text.slice(0, 250)}`);
    err.status = enroll.status;
    err.body = enroll.json || enroll.text;
    throw err;
  }
  const secret = String(enroll.json?.secret || '').replace(/\s+/g, '').toUpperCase();
  if (!secret || secret.length < 16) {
    throw new Error(`enroll 未返回 secret: ${JSON.stringify(enroll.json).slice(0, 200)}`);
  }
  const factorId = enroll.json?.factor?.id || enroll.json?.factor_id || enroll.json?.id || null;
  log(`enroll secret_len=${secret.length} factor=${String(factorId || '').slice(0, 12)}…`);

  const code = totpCode(secret);
  log(`activate_enrollment code…`);
  const act = await auth0Api('POST', '/api/mfa/public/activate_enrollment', {
    factor_type: 'totp',
    code,
    token: stateToken,
  });
  if (!act.ok) {
    // 跨 30s 边界时重试一次新 code
    if (/invalid|code|totp/i.test(act.text || '')) {
      await new Promise((x) => setTimeout(x, 1500));
      const code2 = totpCode(secret);
      const act2 = await auth0Api('POST', '/api/mfa/public/activate_enrollment', {
        factor_type: 'totp',
        code: code2,
        token: stateToken,
      });
      if (!act2.ok) {
        const err = new Error(`activate_enrollment ${act2.status}: ${act2.text.slice(0, 250)}`);
        err.status = act2.status;
        err.body = act2.json || act2.text;
        throw err;
      }
    } else {
      const err = new Error(`activate_enrollment ${act.status}: ${act.text.slice(0, 250)}`);
      err.status = act.status;
      err.body = act.json || act.text;
      throw err;
    }
  }

  info = await getMfaInfo();
  const enabled = !!(info?.mfa_enabled_v2 ?? info?.mfa_enabled);
  if (!enabled) {
    throw new Error(`activate 成功但 mfa_info 仍未 enabled: ${JSON.stringify(info).slice(0, 200)}`);
  }
  log('MFA 已开启 ✓');
  return {
    ok: true,
    alreadyEnabled: false,
    totpSecret: secret,
    factorId: factorId || info?.native_default_factor_id || info?.factors?.totp?.[0]?.id || null,
    sessionToken,
    accountId,
    mfaInfo: info,
    message: 'enrolled',
    enrollResponse: enroll.json,
    fp: loginFp,
  };
}


// ───── 注册全流程(纯 HTTP) ─────
// 兼容多种流程:
//   A) authorize → /create-account  → 提交邮箱 → OTP → 设密码 → about_you → callback
//   B) authorize → /log-in/password → 密码验证 → OTP → create_account → callback
//   C) authorize → /email-verification → OTP → create_account → callback

// ✅【解封 2026-07-04】0702 的封禁真因已定位:是 ext-passkey-client-capabilities=00001 让 OpenAI 走
// 旧「密码流」(/create-account/password → user/register)—— 该流已被封 account_creation_failed。
// 0704 抓包对照发现:真浏览器用 =11111 → OpenAI 改给「无密码流」(/email-verification → OTP →
// create_account{name,birthdate},无 user/register)→ 成功建号。故本函数默认 passwordless=true(=11111),
// 无密码建号,号无 GPT 密码(登录靠 OTP)。00001 密码流保留但默认不走(passwordless=false 时才用,失败会
// 被 routes 的 _regPasswordlessMode 兜底翻回无密码)。sentinel/so-token 生成本就正确(见 memory),非阻塞点。
// 全局粘滞注册模式(进程内共享,双向)。分发点 = authorize 的 302 落地页,由我们发的 ext-passkey-client-capabilities
// 决定(11111→无密码/email-verification;00001→密码/create-account/password);两条流代码都完整、都收敛到同一 create_account。
// 策略(用户拍板):默认无密码优先。每个号只跑「当前全局模式」这一条流程;仅当它「非硬拦截(registration_disallowed/
// 封号/CF403/已停止)、非网络类(交批量换代理)」地失败时,才翻转全局模式(后续号全走另一条)并把当前号用新模式重试一次;
// 直到新模式也这样失败再翻回——双向粘滞。避免每号来回跑两条:只有触发翻转的那个号会多试一次,后续号直接走新模式。
let _preferPasswordless = true;
