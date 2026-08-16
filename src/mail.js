// 邮箱模块(HTTP 协议):纯 HTTP 逆向 mail.com Web API，无需 IMAP。
// 流程：login(3-step) → sid+cookie → OAuth token(Basic auth) → Bearer token 访问邮件 API。
// 注意：mail.com 做 JA3/JA4 TLS 指纹检测。使用 undici Pool + Chrome 密码套件顺序绕过。

import { ctlsFetch, pickFingerprint, applyFp, UA } from './ctls.js';
import { MAIL_LOGIN_CONCURRENCY, MAIL_LOGIN_GAP_MS } from './config.js';
import {
  isPasswordChangePage,
  passwordChangePageCandidates,
  passwordChangeSubmitUrl,
} from './mail-password.js';

// mail.com 做 JA3/JA4 TLS 指纹检测。统一改用 CycleTLS(Chrome136 真实指纹)并走账号代理,
// 与 gpt.js 共用同一套指纹池(pickFingerprint)——同一账号的 mail.com 与 OpenAI 流量出自
// 同一代理 IP + 同一 Chrome 指纹。响应包装(status/headers.get/getSetCookie/text/json)由
// ctls.js 的 _wrapCtls 提供,与旧 chromeFetch 接口一致,上层调用无需改。
// opts.fp: 账号的 TLS 指纹(pickFingerprint(email)); opts.proxy: 账号绑定代理。
async function chromeFetch(url, opts = {}) {
  const fp = opts.fp || null;
  const hdrs = applyFp({ 'User-Agent': fp?.ua || UA, ...(opts.headers || {}) }, fp);
  return ctlsFetch(url, {
    method: opts.method || 'GET',
    headers: hdrs,
    body: opts.body || undefined,
    ja3: fp?.ja3,
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.forceHTTP1 ? { forceHTTP1: true } : {}),
    // mail.js 所有重定向均由上层代码手动处理(与原 undici maxRedirections=0 行为一致)
    redirect: opts.redirect === 'follow' ? 'follow' : 'manual',
  }, opts.proxy || null);
}

// 兼容旧调用:CycleTLS 无持久连接池,无需清理。保留空实现避免外部引用报错。
export function clearMailPoolCache() {}

const CLIENT_ID = 'mailcom_webmailermaillist_passport_live';
const CLIENT_SECRET = '*******';

const sessions = new Map();

// ── 代理轮转池（mail.com 登录分摊到多个出口 IP，避免单 IP 触发限流）──
let _loginProxies = [];
let _loginProxyIdx = 0;

export function setLoginProxyPool(proxies) {
  _loginProxies = (proxies || []).filter(Boolean);
  _loginProxyIdx = 0;
}

function _nextLoginProxy() {
  if (_loginProxies.length === 0) return null;
  const p = _loginProxies[_loginProxyIdx % _loginProxies.length];
  _loginProxyIdx++;
  return p;
}

function isTokenExpired(session) {
  if (!session.tokenTime || !session.expiresIn) return true;
  return Date.now() - session.tokenTime > (session.expiresIn - 60) * 1000;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// mail.com 每步登录超时:健康住宅代理 <3s 完成;12s 给足冗余,又比默认 30s 快失败 ~2.5x → 死代理不再静默挂满。env 可调。
const LOGIN_STEP_TIMEOUT_MS = Number(process.env.MAIL_LOGIN_STEP_TIMEOUT_MS) || 12000;
// 每步计时日志:一眼看出 mail 登录卡在哪一步、哪步最耗时。
async function timedStep(tag, fn) {
  const t0 = Date.now();
  try { return await fn(); }
  finally { console.log(`[mail] ${tag} ${((Date.now() - t0) / 1000).toFixed(2)}s`); }
}

async function doLogin(email, password, proxy, fp = null) {
  const form = new URLSearchParams({
    service: 'mailint',
    uasServiceID: 'mc_starter_mailcom',
    successURL: 'https://$(clientName)-$(dataCenter).mail.com/login',
    loginFailedURL: 'https://www.mail.com/logout/?ls=wd',
    loginErrorURL: 'https://www.mail.com/logout/?ls=te',
    edition: 'us',
    lang: 'en',
    usertype: 'standard',
    username: email,
    password: password,
  });

  // Step 1: POST credentials → 303 redirect to navigator
  const step1 = await timedStep(`#${email} login`, () => chromeFetch('https://login.mail.com/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    redirect: 'manual',
    proxy, fp, timeoutMs: LOGIN_STEP_TIMEOUT_MS,
  }));

  if (step1.status !== 303) {
    const body = await step1.text().catch(() => '');
    // mail.com 风控：直连/脏 IP 常返回 403 {"message":"blocked"} —— 不是坏密，换住宅代理可救
    if (step1.status === 403 && /"message"\s*:\s*"blocked"|blocked/i.test(body)) {
      throw new Error('mail_blocked: login.mail.com 403 blocked(出口IP被拒,换代理重试)');
    }
    if (step1.status === 429 || /rate.?limit|too many/i.test(body)) {
      throw new Error(`mail_rate_limited: login 限流(${step1.status})`);
    }
    if (step1.status === 302 && /assistance|support\.mail\.com/i.test(body + (step1.headers.get('location') || ''))) {
      throw new Error('mail_sms_locked: mail.com 账户协助/风控页(assistance,需人工)');
    }
    throw new Error(`Login failed: status ${step1.status}${body ? ` ${body.slice(0, 150)}` : ''}`);
  }

  const location = step1.headers.get('location');
  if (location && location.includes('interception-lxa.mail.com')) {
    throw new Error('mail_sms_locked: 账号触发手机验证(mail.com安全拦截)');
  }
  if (location && /support\.mail\.com|assistance/i.test(location)) {
    throw new Error('mail_sms_locked: mail.com 账户协助/风控页(需人工)');
  }
  if (!location || !location.includes('navigator-lxa.mail.com')) {
    // ls=wd 才是真坏密
    if (location && /[?&]ls=wd\b/i.test(location)) {
      throw new Error('bad_password: 密码错误(登录被拒 ls=wd)');
    }
    throw new Error(`Login failed: unexpected redirect target ${location || ''}`);
  }

  // Step 2: GET /login on navigator → 200 HTML with FeatureDetection JSON
  const step2 = await timedStep(`#${email} navigator`, () => chromeFetch(location, {
    headers: {},
    redirect: 'manual',
    proxy, fp, timeoutMs: LOGIN_STEP_TIMEOUT_MS,
  }));

  const html = await step2.text();
  const fdMatch = html.match(/FeatureDetection\((\{.*?\})\)/s);
  if (!fdMatch) throw new Error('Login failed: no FeatureDetection in navigator page');
  const redirectUrl = JSON.parse(fdMatch[1]).redirectUrl;
  if (!redirectUrl) throw new Error('Login failed: no redirectUrl in FeatureDetection');

  // Step 3: GET /halogin → 302 with sid + navigator cookie
  const step1Cookies = (step1.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  const step3 = await timedStep(`#${email} halogin`, () => chromeFetch(`https://navigator-lxa.mail.com${redirectUrl}`, {
    headers: { 'Cookie': step1Cookies },
    redirect: 'manual',
    proxy, fp, timeoutMs: LOGIN_STEP_TIMEOUT_MS,
  }));

  if (step3.status !== 302) {
    throw new Error(`halogin failed: status ${step3.status}`);
  }

  const haloginLoc = step3.headers.get('location') || '';
  const sidMatch = haloginLoc.match(/sid=([a-f0-9]+)/);
  if (!sidMatch) throw new Error('Failed to extract sid from halogin redirect');

  const cookies = step3.headers.getSetCookie?.() || [];
  const navCookie = cookies.find(c => c.startsWith('navigator='))?.split(';')[0] || '';
  if (!navCookie) throw new Error('Failed to get navigator cookie');

  return { sid: sidMatch[1], navCookie, step1Cookies };
}

async function getToken(sid, navCookie, scope = 'mail_mailbox_r', proxy, fp = null) {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const resp = await timedStep(`#${String(sid).slice(0, 6)} token`, () => chromeFetch(
    `https://oauthbridge.navigator-lxa.mail.com/navigator/oauth2/token?sid=${sid}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basic}`,
        'Cookie': navCookie,
        'Origin': 'https://webmailer.mail.com',
        'x-ui-app': 'mailcom.webmailer.mail-list/6.0.0',
      },
      body: `grant_type=urn:mam:oauth:grant-type:spa&scope=${encodeURIComponent(scope)}`,
      proxy, fp, timeoutMs: LOGIN_STEP_TIMEOUT_MS,
    }
  ));

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OAuth token request failed: ${resp.status} ${text}`);
  }

  return resp.json();
}

function proxyKey(p) {
  return p ? `${p.host}:${p.port}:${p.username}` : 'direct';
}

// 登录限流:login.mail.com 对高并发自动化登录敏感(会在 halogin 步静默拒绝/转人工验证),
// 限制同时只有 LOGIN_CONCURRENCY 个登录在飞行,且两次登录启动间隔不少于 LOGIN_MIN_GAP_MS。
// 并发/间隔来自中央配置(默认 15 并发、0 间隔)。每号独立 IP+指纹 → 不再一刀切 2。
const LOGIN_CONCURRENCY = MAIL_LOGIN_CONCURRENCY;
const LOGIN_MIN_GAP_MS = MAIL_LOGIN_GAP_MS;
let _loginActive = 0;
let _lastLoginStart = 0;
// 事件驱动的等待队列:槽位一释放就立即 resolve 下一个等待者(不再每 200ms 轮询探槽);
// 最小间隔用一次性 setTimeout 精确调度,而非忙等。
const _loginWaiters = [];
let _gapTimer = null;
function _tryAdmitLogin() {
  if (_loginActive >= LOGIN_CONCURRENCY || _loginWaiters.length === 0) return;
  const wait = _lastLoginStart + LOGIN_MIN_GAP_MS - Date.now();
  if (wait > 0) { if (!_gapTimer) _gapTimer = setTimeout(() => { _gapTimer = null; _tryAdmitLogin(); }, wait); return; }
  const next = _loginWaiters.shift();
  _loginActive++;
  _lastLoginStart = Date.now();
  next();
  if (_loginWaiters.length) _tryAdmitLogin();
}
function acquireLoginSlot() {
  return new Promise(res => { _loginWaiters.push(res); _tryAdmitLogin(); });
}
function releaseLoginSlot() {
  _loginActive--;
  _tryAdmitLogin();  // 释放即唤醒下一个,零延迟
}

async function getSession(email, password, proxy) {
  // 未指定代理时，从轮转池自动分配
  if (proxy == null) proxy = _nextLoginProxy();
  const fp = pickFingerprint(email);
  const key = email.toLowerCase();
  let session = sessions.get(key);

  // Invalidate cache if password or proxy changed (e.g. after batch changePassword,
  // or a different worker/IP picked up this account)
  if (session && (session.password !== password || session.proxyKey !== proxyKey(proxy))) {
    sessions.delete(key);
    session = null;
  }

  if (session && !isTokenExpired(session)) {
    return session;
  }

  if (session && session.sid && session.navCookie) {
    try {
      const tokenResp = await getToken(session.sid, session.navCookie, undefined, proxy, fp);
      session.accessToken = tokenResp.access_token;
      session.expiresIn = tokenResp.expires_in;
      session.tokenTime = Date.now();
      session.ssoCreatedAt = Date.now();
      sessions.set(key, session);
      return session;
    } catch {
      // sid expired, re-login
    }
  }

  let loginResult;
  await acquireLoginSlot();
  try {
    try {
      loginResult = await doLogin(email, password, proxy, fp);
    } catch (e) {
      // 失败是即时确定信号:短暂退避(清微限流)后立即重试,不再固定死等 1.5s。
      await sleep(Number(process.env.MAIL_LOGIN_RETRY_MS) || 400);
      loginResult = await doLogin(email, password, proxy, fp);
    }
  } finally {
    releaseLoginSlot();
  }
  const { sid, navCookie, step1Cookies } = loginResult;
  const tokenResp = await getToken(sid, navCookie, undefined, proxy, fp);
  session = {
    sid,
    navCookie,
    step1Cookies,
    ssoCreatedAt: Date.now(),
    password,
    proxyKey: proxyKey(proxy),
    accessToken: tokenResp.access_token,
    expiresIn: tokenResp.expires_in,
    tokenTime: Date.now(),
  };
  sessions.set(key, session);
  return session;
}

// 导出登录 session（sid + navCookie + .mail.com SSO cookies），供访问 account-lxa.mail.com 使用。
// 批量初始化在 loginResult() 中刚完成过同一套三步登录；短时间内直接复用这份 SSO
// 会话，避免改密前再次提交账号密码。缓存过旧或代理/密码不一致时才重新登录。
export async function getLoginSession(email, password, proxy) {
  const cached = sessions.get(email.toLowerCase());
  const reusable = cached
    && cached.password === password
    && cached.proxyKey === proxyKey(proxy)
    && cached.sid
    && cached.navCookie
    && cached.step1Cookies
    && Date.now() - cached.ssoCreatedAt < 5 * 60 * 1000;
  if (reusable) {
    return {
      sid: cached.sid,
      navCookie: cached.navCookie,
      step1Cookies: cached.step1Cookies,
    };
  }

  const fp = pickFingerprint(email);
  await acquireLoginSlot();
  try {
    return await doLogin(email, password, proxy, fp);
  } finally {
    releaseLoginSlot();
  }
}

export async function isAlive(email, password, proxy) {
  try {
    await getSession(email, password, proxy);
    return true;
  } catch {
    return false;
  }
}

// 完整登录 + 分类结果(供批量:据 reason 决定「换代理重试 / 试原密码 / 标记短信锁」)。
// 与 isAlive 同样跑完整 getSession(建立会话供后续改密/取OTP复用),但不吞错 —— 返回 reason。
// reason: online / sms_locked / bad_password / proxy_net(瞬时,换代理可救)/ error(其它,如异常跳转)
export async function loginResult(email, password, proxy) {
  if (!password) return { ok: false, reason: 'bad_password', error: '无密码' };
  try {
    await getSession(email, password, proxy);
    return { ok: true, reason: 'online' };
  } catch (e) {
    const m = String(e?.message || e || '');
    if (/sms|手机验证|安全拦截|interception|mail_sms_locked/i.test(m)) return { ok: false, reason: 'sms_locked', error: m };
    if (/mail_blocked|403 blocked|出口IP被拒|mail_rate_limited|rate_limited/i.test(m)) return { ok: false, reason: 'proxy_net', error: m };
    if (/status 0|proxy|tunnel|ECONN|socket|forcibly|reset|ETIMEDOUT|timeout|超时|deadline|EAI_AGAIN|ENETUNREACH|ERR_EMPTY|ERR_CONNECTION|fetch failed/i.test(m)) return { ok: false, reason: 'proxy_net', error: m };
    if (/ls=wd|密码错|bad_password|credential/i.test(m)) return { ok: false, reason: 'bad_password', error: m };
    return { ok: false, reason: 'error', error: m };
  }
}

// 轻量在线检测:只打第 1 步登录 POST,看 303 跳转目标即可判定 —— 不必跑完整 4 请求登录(省 3/4)。
// mail.com 没有"在线"这种概念,只能靠登录 POST 的跳转目标推断:
//   navigator-lxa=登录成功  interception-lxa=SMS锁  ?ls=wd=密码错  ?ls=te=登录错误
// 返回 { alive, reason, error }。
// reason: online / bad_password / sms_locked / login_error / rate_limited / proxy_down / network / no_password / error
// 注意:SMS 锁偶发在 halogin 才触发;需要确定性时用 loginResult / checkAlive({deep:true})。
export async function checkMailAlive(email, password, proxy = null) {
  if (!password) return { alive: false, reason: 'no_password', error: '无密码' };
  if (proxy == null) proxy = _nextLoginProxy();
  const fp = pickFingerprint(email);
  const form = new URLSearchParams({
    service: 'mailint', uasServiceID: 'mc_starter_mailcom',
    successURL: 'https://$(clientName)-$(dataCenter).mail.com/login',
    loginFailedURL: 'https://www.mail.com/logout/?ls=wd',
    loginErrorURL: 'https://www.mail.com/logout/?ls=te',
    edition: 'us', lang: 'en', usertype: 'standard', username: email, password,
  });
  await acquireLoginSlot(); // mail.com 对突发登录敏感,检测也要节流(否则批量检测会触发 SMS 锁)
  try {
    const r = await timedStep(`#${email} check`, () => chromeFetch('https://login.mail.com/login', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(), redirect: 'manual', proxy, fp, timeoutMs: LOGIN_STEP_TIMEOUT_MS,
    }));
    const loc = r.headers.get('location') || '';
    if (r.status === 303 || (r.status >= 300 && r.status < 400 && loc)) {
      if (loc.includes('navigator-lxa')) return { alive: true, reason: 'online' };
      if (loc.includes('interception-lxa') || /interception|sms|phone.?verif/i.test(loc)) {
        return { alive: false, reason: 'sms_locked', error: 'SMS安全锁(需手动解锁,非死号)' };
      }
      if (/support\.mail\.com|assistance/i.test(loc)) {
        return { alive: false, reason: 'sms_locked', error: 'mail.com 账户协助/风控页(需人工,非坏密)' };
      }
      // ls=wd 密码错;有时挂在 query 任意位置
      if (/[?&]ls=wd\b/i.test(loc) || loc.includes('ls=wd')) {
        return { alive: false, reason: 'bad_password', error: '密码错误(登录被拒 ls=wd)' };
      }
      if (/[?&]ls=te\b/i.test(loc) || loc.includes('ls=te')) {
        return { alive: false, reason: 'login_error', error: '登录错误(ls=te)' };
      }
      // 明确注销/失败页也当凭据问题
      if (/logout|loginFailed|unauthorized/i.test(loc) && !loc.includes('navigator-lxa')) {
        return { alive: false, reason: 'bad_password', error: `登录失败跳转: ${loc.slice(0, 80)}` };
      }
      return { alive: false, reason: 'error', error: `未知跳转: ${loc.slice(0, 80)}` };
    }
    const body = await r.text().catch(() => '');
    // 403 blocked = 出口 IP 风控，瞬时；切勿标 bad_password 误杀
    if (r.status === 403 && /"message"\s*:\s*"blocked"|blocked/i.test(body)) {
      return { alive: false, reason: 'rate_limited', error: 'mail.com 403 blocked(出口被拒,换代理)' };
    }
    if (r.status === 401 || r.status === 403) {
      if (/interception|sms|phone/i.test(body)) {
        return { alive: false, reason: 'sms_locked', error: `SMS/安全拦截(${r.status})` };
      }
      // 无 ls=wd 证据时，401/403 更可能是边缘拦截而非坏密
      return { alive: false, reason: 'rate_limited', error: `登录被拒(${r.status}) ${body.slice(0, 80)}` };
    }
    if (r.status === 429 || /too many|rate limit/i.test(body)) {
      return { alive: false, reason: 'rate_limited', error: `限流(${r.status})` };
    }
    if (/^\s*</.test(body) && /(captcha|blocked|challenge|verify you|just a moment|cf-ray)/i.test(body)) {
      return { alive: false, reason: 'rate_limited', error: `拦截页(${r.status})` };
    }
    if (r.status === 0 || r.status >= 500) {
      return { alive: false, reason: 'network', error: `登录返回 ${r.status}` };
    }
    return { alive: false, reason: 'network', error: `登录返回 ${r.status}` };
  } catch (e) {
    const m = e.message || '';
    if (/proxy|tunnel|ECONNREFUSED|ECONNRESET|EPIPE|socket|forcibly closed|reset|connection|ETIMEDOUT|timeout|超时/i.test(m)) {
      return { alive: false, reason: 'proxy_down', error: m };
    }
    return { alive: false, reason: 'network', error: m };
  } finally {
    releaseLoginSlot();
  }
}

export async function listMail(email, password, { page = 0, size = 50, folder = 'INBOX', proxy } = {}) {
  const session = await getSession(email, password, proxy);
  const fp = pickFingerprint(email);
  const offset = page * size;
  const url = `https://maillist.mail.com/Mailbox/Mail?folderTypeOrId=${folder}&offset=${offset}&amount=${size}&orderBy=INTERNALDATE+DESC`;

  const body = {
    aditionContext: { brand: 'mailcom', category: 'mail', section: '3c/folder', tagid: 'inline', layoutclass: 'b' },
    deviceContext: { app: { name: 'browser' }, deviceclass: 'b' },
    adBlocker: false,
    mailboxContext: { currentPage: page + 1, visibleMessages: size },
  };

  const makeMaillistReq = (token) => chromeFetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.1and1.mms.unified-maillist-v1+json; charset=utf-8',
      'Content-Type': 'application/vnd.1and1.mms.inboxadrequest-v1+json; charset=utf-8',
      'Authorization': `Bearer ${token}`,
      'x-ui-app': 'mailcom.webmailer.mail-list/6.0.0',
      'Origin': 'https://webmailer.mail.com',
    },
    body: JSON.stringify(body),
    proxy, fp,
  });

  let resp = await makeMaillistReq(session.accessToken);
  if (resp.status === 401) {
    sessions.delete(email.toLowerCase());
    const fresh = await getSession(email, password, proxy);
    resp = await makeMaillistReq(fresh.accessToken);
  }
  if (!resp.ok) throw new Error(`Maillist API failed: ${resp.status}`);
  const data = await resp.json();

  const mails = (data.mailListElements || [])
    .filter(m => m.type !== 'ad')
    .map(m => {
      const rd = m.rawData || {};
      const attr = rd.attribute || {};
      const hdr = rd.mailHeader || {};
      return {
        id: attr.mailIdentifier || '',
        subject: hdr.subject || '(无主题)',
        from: hdr.from || '',
        date: attr.internalDate || null,
        unread: !attr.read,
      };
    });

  return {
    totalCount: data.totalMails ?? mails.length,
    unreadCount: data.unreadMails ?? 0,
    mails,
  };
}

export async function getBody(email, password, mailId, proxy) {
  const session = await getSession(email, password, proxy);
  const fp = pickFingerprint(email);
  const url = `https://mailcom.mailbody-ui.de/Mail/${mailId}/Body/html?target_origin=${encodeURIComponent('https://webmailer.mail.com')}`;

  const makeBodyReq = (token) => chromeFetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'text/html, */*',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Bearer ${token}`,
      'x-ui-app': 'mailcom.webmailer.mail-body/3.0.0',
      'Origin': 'https://webmailer.mail.com',
    },
    body: '',
    proxy, fp,
  });

  let resp = await makeBodyReq(session.accessToken);
  if (resp.status === 401) {
    sessions.delete(email.toLowerCase());
    const fresh = await getSession(email, password, proxy);
    resp = await makeBodyReq(fresh.accessToken);
  }
  if (!resp.ok) throw new Error(`Mail body API failed: ${resp.status}`);
  return resp.text();
}

export async function findOTP(email, password, { maxAge = 10 * 60 * 1000, pattern, proxy } = {}) {
  const otpRe = pattern ? new RegExp(pattern) : /\b(\d{6})\b/;
  const now = Date.now();
  // OpenAI 的 OTP 主题不含数字("Your temporary ChatGPT verification/login code"),码只在正文 → 必须读 getBody。
  // 只从「验证码邮件」(主题含 code/验证码)取码,跳过 "New sign-in" 等通知(它们正文里也有 6 位数,会取错)。
  const isCodeMail = (m) => /verification code|login code|verification|passcode|one-time|验证码|\bcode\b/i.test(m.subject || '');
  let otpBodyFailed = false; // 见到验证码邮件但正文读取失败(多半代理)→ 别静默返回 null 造成"假超时"
  const candidates = [];

  for (const folder of ['INBOX', 'SPAM']) {
    const { mails } = await listMail(email, password, { page: 0, size: 20, folder, proxy });
    for (const m of mails) {
      if (m.date && now - new Date(m.date).getTime() > maxAge) break;
      const subjectMatch = otpRe.exec(m.subject || '');
      if (subjectMatch) return { code: subjectMatch[1] || subjectMatch[0], mailId: m.id, source: 'subject', folder };
      if (isCodeMail(m)) candidates.push({ m, folder }); // 收集验证码邮件(新→旧)
    }
  }
  // 逐个读验证码邮件正文取码;读不到正文=代理问题 → 抛「proxy」类错让 getOtp 换代理重读,而不是假超时。
  for (const { m, folder } of candidates) {
    try {
      const html = await getBody(email, password, m.id, proxy);
      const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
      const bodyMatch = otpRe.exec(text);
      if (bodyMatch) return { code: bodyMatch[1] || bodyMatch[0], mailId: m.id, source: 'body', folder };
    } catch (e) { otpBodyFailed = true; }
  }
  if (otpBodyFailed) throw new Error('proxy: OTP邮件已到但正文读取失败(换代理重读)');
  return null;
}

// 从最近邮件正文抠一个匹配 pattern 的 URL(供 Claude magic-link 等)。
export async function findLink(email, password, { pattern, maxAge = 10 * 60 * 1000, proxy } = {}) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  const now = Date.now();
  // INBOX + 垃圾箱常见别名（mail.com 多为 SPAM）
  for (const folder of ['INBOX', 'SPAM', 'JUNK', 'Junk', 'Bulk']) {
    let mails;
    try {
      ({ mails } = await listMail(email, password, { page: 0, size: 20, folder, proxy }));
    } catch {
      continue; // 文件夹不存在则跳过
    }
    for (const m of mails || []) {
      if (m.date && now - new Date(m.date).getTime() > maxAge) break;
      // 主题/摘要里有时直接带 magic-link
      const subj = `${m.subject || ''} ${m.snippet || m.preview || ''}`;
      const subjHit = re.exec(String(subj).replace(/&amp;/g, '&'));
      if (subjHit) return { link: subjHit[0], mailId: m.id, folder, source: 'subject' };
      try {
        const html = await getBody(email, password, m.id, proxy);
        const txt = String(html).replace(/=\r?\n/g, '').replace(/&amp;/g, '&');
        const mm = re.exec(txt);
        if (mm) return { link: mm[0], mailId: m.id, folder, source: 'body' };
      } catch { /* 读正文失败跳过 */ }
    }
  }
  return null;
}

// 自适应等待 OTP:邮箱无推送通道,只能轮询 —— 但把"最多白等"从 5s 压到 ~1s。
// 首 15s 每 1s(OTP 通常此窗口内到达)、之后每 2.5s;OTP 一到立即返回其 code 字符串。
// isNew(found) 去重旧码(found={code,mailId,...});aborted() 支持任务停止时提前退出。
const OTP_FAST_MS = Number(process.env.OTP_FAST_MS) || 1000;
const OTP_SLOW_MS = Number(process.env.OTP_SLOW_MS) || 2500;
export async function waitForOTP(email, password, { proxy = null, maxMs = 300000, isNew = () => true, aborted = () => false } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (aborted()) return null;
    const f = await findOTP(email, password, { proxy }).catch(() => null);
    if (f?.code && isNew(f)) return f.code;
    await sleep(Date.now() - t0 < 15000 ? OTP_FAST_MS : OTP_SLOW_MS);
  }
  return null;
}

// 修改 mail.com 账号密码（纯 HTTP，逆向自 portalbridge.com邮箱修改密码.har + 实测抓包）
// 正确流程: getLoginSession(sid+navCookie+SSO cookies)
//   → GET navigator-lxa.mail.com/navigator/jump/to/ciss?sid=X (SSO 跳转,关键端点!)
//   → 跟随跳转到 account-lxa.mail.com/ciss/myAccountOverview (途中拿到 JSESSIONID)
//   → 直接调用 /ciss/security/edit/passwordChange，并读取动态 Wicket form action
//   → POST 提交 username+当前密码+新密码x2
// 关键发现: 直接访问 account-lxa 会因缺少 JSESSIONID 而显示 Wicket "OOOOPS" 错误，
// 必须通过 navigator/jump/to/ciss 这个 SSO 端点才能正确建立 session。
export async function changePassword(email, password, newPassword, proxy) {
  const fp = pickFingerprint(email);
  async function followRedirects(startUrl, cookies, maxHops = 6) {
    let url = startUrl;
    let cookieStr = cookies;
    for (let i = 0; i < maxHops; i++) {
      const resp = await chromeFetch(url, { headers: { Cookie: cookieStr }, redirect: 'manual', proxy, fp });
      const newCookies = (resp.headers.getSetCookie?.() || []).map(c => c.split(';')[0]);
      if (newCookies.length) cookieStr = cookieStr ? `${cookieStr}; ${newCookies.join('; ')}` : newCookies.join('; ');
      const loc = resp.headers.get('location');
      if (!loc) return { html: await resp.text(), url, cookies: cookieStr, status: resp.status };
      url = loc.startsWith('http') ? loc : new URL(loc, url).href;
    }
    throw new Error('密码修改失败: 重定向次数过多');
  }

  // Step 1: 登录获取 sid + navCookie + .mail.com SSO cookies
  const { sid, navCookie, step1Cookies } = await getLoginSession(email, password, proxy);
  let cookies = [navCookie, step1Cookies].filter(Boolean).join('; ');

  // Step 2: 走 navigator SSO 跳转端点（关键! 直接访问 account-lxa 会话无效）
  const jumpResult = await followRedirects(`https://navigator-lxa.mail.com/navigator/jump/to/ciss?sid=${sid}`, cookies);
  cookies = jumpResult.cookies;

  // Step 3: 直接打开固定改密端点。旧版概览页的 Wicket listener 仅作兼容回退，
  // 不再因为 changePasswordLink 的 HTML 结构变化而整号失败。
  let pwdPageResult = null;
  const pageErrors = [];
  for (const candidate of passwordChangePageCandidates(jumpResult.html, jumpResult.url)) {
    try {
      const result = await followRedirects(candidate, cookies, 3);
      cookies = result.cookies;
      if (result.status >= 200 && result.status < 300 && isPasswordChangePage(result.html, result.url)) {
        pwdPageResult = result;
        break;
      }
      pageErrors.push(`${result.status}:${new URL(result.url).pathname}`);
    } catch (error) {
      pageErrors.push(String(error?.message || error).slice(0, 80));
    }
  }
  if (!pwdPageResult) {
    throw new Error(`无法打开修改密码接口${pageErrors.length ? `(${pageErrors.join('; ')})` : ''}`);
  }

  // Step 4: 使用页面返回的真实 Wicket form action 提交；仅在旧页面缺 action 时
  // 才按已抓包的 pageId-1.-form 规则兼容生成。
  const formBody = new URLSearchParams({
    'editPanel:username': email,
    'editPanel:currentPasswordPanel:topWrapper:inputWrapper:input': password,
    'editPanel:newPasswordFieldPanel:topWrapper:inputWrapper:input': newPassword,
    'editPanel:retypeNewPasswordFieldPanel:topWrapper:inputWrapper:input': newPassword,
  });
  const submitUrl = passwordChangeSubmitUrl(pwdPageResult.html, pwdPageResult.url);
  const submitResp = await chromeFetch(submitUrl, {
    method: 'POST',
    headers: { Cookie: cookies, 'Content-Type': 'application/x-www-form-urlencoded', Referer: pwdPageResult.url },
    body: formBody.toString(),
    redirect: 'manual',
    proxy, fp,
    // account-lxa 在 body 上传途中就早早返回 302,CycleTLS 的 HTTP/2 栈会 abort 这个带 body 的
    // POST("stop request body writer and cancel StreamID:1")→ 一直挂到超时。强制 HTTP/1.1 绕过
    // (curl/curl_cffi 无此问题;参考项目同样按请求显式设 http_version)。JA3 指纹不变,仅 ALPN 变。
    forceHTTP1: true,
    timeoutMs: 20000,
  });
  const submitLoc = submitResp.headers.get('location') || '';
  if (!submitLoc.includes('passwordChangedSuccessfully=true')) {
    const body = await submitResp.text().catch(() => '');
    throw new Error(`密码修改失败(${submitResp.status}): ${submitLoc || body.slice(0, 200)}`);
  }
  // 旧密码会话在服务端可能仍暂时有效，但不能继续给取信流程复用；下一次访问必须
  // 用新密码建立干净会话。
  sessions.delete(email.toLowerCase());
  return { ok: true };
}

// 批量注册开始前调用：并发预热所有 mail 账号的 Bearer session，
// 让后续 findOTP 调用直接命中缓存而无需重新登录。
// accounts: [{email, password}, ...]
export async function prewarmSessions(accounts) {
  if (!accounts?.length) return;
  await Promise.allSettled(
    accounts.map(a => getSession(a.email, a.password || a.mailPassword).catch(() => {}))
  );
}
