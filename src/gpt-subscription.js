import crypto from 'node:crypto';
import { BASE, accountFp } from './gpt-shared.js';
import { applyFp, browserHeaders, ctlsFetch } from './ctls.js';

const REQUEST_TIMEOUT_MS = 15000;
const CANCEL_TIMEOUT_MS = 30000;
const CANCEL_PATH = '/backend-api/subscriptions/cancel';
const SUBS_PATH = '/backend-api/subscriptions';
const CHECK_PATH = '/backend-api/accounts/check/v4-2023-04-27';
const CHECK_URL = `${BASE}${CHECK_PATH}?timezone_offset_min=0`;
const OAI_CLIENT_VERSION = process.env.OAI_CLIENT_VERSION || 'prod-3410020faf93d4c3977132397e1d459857a86a7c';
const OAI_CLIENT_BUILD = process.env.OAI_CLIENT_BUILD || '8848688';
const OAI_CANCEL_LANGUAGE = process.env.OAI_CANCEL_LANGUAGE || process.env.OAI_LANGUAGE || 'en-US';
const SEND_ACCOUNT_HEADER = process.env.OAI_CANCEL_ACCOUNT_HEADER !== '0';

function firstValue(source, paths) {
  for (const path of paths) {
    let value = source;
    for (const key of path.split('.')) value = value?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function timestamp(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function amount(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizePlan(value) {
  const plan = String(value || '').toLowerCase();
  if (plan.includes('prolite')) return 'prolite';
  if (plan.includes('pro')) return 'pro';
  if (plan.includes('plus')) return 'plus';
  if (plan.includes('team') || plan.includes('business')) return 'business';
  if (plan.includes('guest') || plan.includes('free')) return 'free';
  return plan || 'free';
}

function unwrapSubscription(subscription) {
  if (Array.isArray(subscription)) return subscription[0] || {};
  if (Array.isArray(subscription?.subscriptions)) return subscription.subscriptions[0] || {};
  return subscription && typeof subscription === 'object' ? subscription : {};
}

function inferPeriodStart(periodEnd, billingPeriod) {
  if (!periodEnd) return null;
  const end = new Date(periodEnd);
  if (!Number.isFinite(end.getTime())) return null;
  const period = String(billingPeriod || 'monthly').toLowerCase();
  if (period === 'year' || period === 'yearly') end.setUTCFullYear(end.getUTCFullYear() - 1);
  else end.setUTCMonth(end.getUTCMonth() - 1);
  return end.getTime();
}

function defaultAccountSlice(accountCheck) {
  const accounts = accountCheck?.accounts;
  if (accounts && typeof accounts === 'object') {
    return accounts.default || Object.values(accounts)[0] || {};
  }
  return accountCheck || {};
}

function findCollection(source, names) {
  if (!source || typeof source !== 'object') return [];
  for (const name of names) {
    const value = source[name];
    if (Array.isArray(value)) return value;
    if (Array.isArray(value?.data)) return value.data;
  }
  for (const value of Object.values(source)) {
    const found = findCollection(value, names);
    if (found.length) return found;
  }
  return [];
}

function paymentMethod(source) {
  const methods = findCollection(source, ['payment_methods', 'paymentMethods', 'payment_method_details']);
  const transactions = findCollection(source, ['transactions']);
  const transactionMethod = transactions.map((entry) => (
    entry?.payment_method || entry?.paymentMethod || entry?.payment_method_details || entry?.card
  )).find(Boolean);
  const candidate = methods[0] || transactionMethod || firstValue(source, [
    'payment_method', 'paymentMethod', 'default_payment_method',
    'subscription.payment_method', 'subscription.default_payment_method',
  ]);
  const card = candidate?.card || candidate?.payment_method_details?.card || candidate;
  const last4 = firstValue(card, ['last4', 'last_four', 'lastFour']);
  if (!last4) return null;
  return {
    brand: String(firstValue(card, ['brand', 'network']) || '').toUpperCase() || null,
    last4: String(last4).slice(-4),
    expMonth: Number(firstValue(card, ['exp_month', 'expMonth'])) || null,
    expYear: Number(firstValue(card, ['exp_year', 'expYear'])) || null,
  };
}

export function normalizeSubscriptionInfo({ session = {}, profile = {}, accountCheck = {}, subscription = {}, transactions = {}, invoices = {}, paymentMethods = {}, now = Date.now() } = {}) {
  const accountSlice = defaultAccountSlice(accountCheck);
  const entitlement = accountSlice.entitlement || {};
  const lastActive = accountSlice.last_active_subscription || {};
  const checkAccount = accountSlice.account || {};
  subscription = unwrapSubscription(subscription);
  const combined = { session, profile, accountCheck, subscription, transactions, invoices, paymentMethods, entitlement, lastActive, checkAccount };
  const transactionList = findCollection(combined, ['transactions']);
  const invoiceList = findCollection(combined, ['invoices']);
  const paidInvoice = transactionList.find((entry) => entry?.type === 'invoice' && /paid|succeeded|complete/i.test(entry?.status || ''))
    || invoiceList.find((invoice) => invoice?.paid === true || /paid|succeeded|complete/i.test(invoice?.status || invoice?.payment_status || ''))
    || transactionList[0]
    || invoiceList[0]
    || null;
  const periodEnd = timestamp(firstValue(combined, [
    'subscription.active_until', 'subscription.current_period_end', 'subscription.currentPeriodEnd',
    'subscription.renewal_at', 'subscription.expires_at', 'entitlement.expires_at', 'entitlement.renews_at',
    'entitlement.cancels_at', 'profile.chatgpt_subscription_active_until', 'profile.subscription_active_until',
    'session.account.expires_at',
  ]));
  const periodStart = timestamp(firstValue(combined, [
    'subscription.current_period_start', 'subscription.currentPeriodStart', 'subscription.active_start',
    'subscription.started_at', 'subscription.starts_at', 'subscription.start_at',
    'entitlement.starts_at', 'entitlement.started_at', 'entitlement.active_start',
  ])) || timestamp(firstValue(paidInvoice, [
    'period_start', 'periodStart', 'current_period_start', 'created_at', 'created',
  ]));
  const status = String(firstValue(combined, ['subscription.status', 'subscription.subscription_status']) || '').toLowerCase() || null;
  const plan = normalizePlan(firstValue(combined, [
    'subscription.plan_type', 'subscription.plan', 'checkAccount.plan_type', 'entitlement.subscription_plan',
    'transactions.transactions.0.product.plan', 'session.account.planType', 'accountCheck.plan_type', 'accountCheck.plan',
  ]));
  const cancelAtPeriodEnd = firstValue(combined, ['subscription.cancel_at_period_end', 'subscription.cancelAtPeriodEnd']);
  const autoRenewValue = firstValue(combined, [
    'subscription.will_renew', 'subscription.auto_renew', 'subscription.autoRenew', 'lastActive.will_renew',
  ]);
  const autoRenew = autoRenewValue != null ? Boolean(autoRenewValue)
    : cancelAtPeriodEnd != null ? !Boolean(cancelAtPeriodEnd)
      : entitlement.cancels_at ? false
        : entitlement.has_active_subscription && (entitlement.renews_at || entitlement.expires_at) ? true
          : null;
  const active = entitlement.has_active_subscription != null
    ? Boolean(entitlement.has_active_subscription)
    : status ? /active|trialing|past_due/.test(status) : !['free', 'guest'].includes(plan);
  const lastPaymentAt = timestamp(firstValue(paidInvoice, ['paid_at', 'status_transitions.paid_at', 'created', 'created_at']));
  const lastPaymentAmount = amount(firstValue(paidInvoice, ['amount_paid', 'paid_amount', 'total', 'amount']));
  const currency = String(firstValue(paidInvoice, ['currency']) || firstValue(combined, ['entitlement.billing_currency']) || '').toUpperCase() || null;
  const billingApplicable = !['free', 'guest'].includes(plan) || Boolean(checkAccount.has_previously_paid_subscription);

  return {
    plan,
    status: status || (active ? 'active' : plan),
    active,
    periodStart: periodStart || inferPeriodStart(periodEnd, firstValue(combined, ['entitlement.billing_period', 'subscription.billing_period'])),
    periodEnd,
    remainingMs: periodEnd ? Math.max(0, periodEnd - now) : null,
    autoRenew: ['free', 'guest'].includes(plan) ? null : autoRenew,
    lastPaymentAt,
    lastPaymentAmount,
    currency,
    paymentMethod: paymentMethod(combined),
    invoiceUrl: firstValue(paidInvoice, ['invoice_url', 'invoiceUrl', 'hosted_invoice_url']),
    billingPeriod: firstValue(combined, ['entitlement.billing_period', 'subscription.billing_period']) || null,
    previouslyPaid: checkAccount.has_previously_paid_subscription == null ? null : Boolean(checkAccount.has_previously_paid_subscription),
    billingApplicable,
    profile: {
      name: firstValue(combined, ['profile.name', 'session.user.name']),
      country: firstValue(combined, ['profile.country']),
      region: firstValue(combined, ['profile.region']),
      regionCode: firstValue(combined, ['profile.region_code', 'profile.regionCode']),
      createdAt: timestamp(firstValue(combined, ['profile.created', 'profile.created_at'])),
      mfaEnabled: firstValue(combined, ['profile.mfa_flag_enabled', 'profile.mfa']),
      emailDomainType: firstValue(combined, ['profile.email_domain_type']),
      personalOrgId: firstValue(combined, ['profile.orgs.data.0.id']),
    },
    warnings: [],
  };
}

async function fetchJson(url, headers, proxy, fp) {
  const response = await ctlsFetch(url, {
    headers: applyFp(browserHeaders(headers), fp),
    ja3: fp.ja3,
    timeoutMs: REQUEST_TIMEOUT_MS,
  }, proxy);
  if (!response.ok) {
    const error = new Error(`订阅接口返回 ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json().catch(() => ({}));
}

export async function getSubscriptionInfo({ email, accessToken, accountId, sessionJson }, proxy = null) {
  const fp = accountFp({ email });
  const session = typeof sessionJson === 'string' ? JSON.parse(sessionJson) : (sessionJson || {});
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Origin: BASE,
    Referer: `${BASE}/`,
    Accept: 'application/json, text/plain, */*',
    ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
  };
  const warnings = [];
  const read = async (label, paths) => {
    for (const path of paths) {
      try {
        return await fetchJson(`${BASE}${path}`, headers, proxy, fp);
      } catch (error) {
        if (error.status !== 404) {
          warnings.push(`${label}不可用(${error.status || '网络错误'})`);
          return {};
        }
      }
    }
    warnings.push(`${label}未提供`);
    return {};
  };

  const [profile, accountCheck, subscription, transactions, invoices, paymentMethods] = await Promise.all([
    read('账号资料', ['/backend-api/me']),
    read('账号状态', ['/backend-api/accounts/check/v4-2023-04-27']),
    read('订阅信息', [
      ...(accountId ? [`/backend-api/subscriptions?account_id=${encodeURIComponent(accountId)}`] : []),
      '/backend-api/subscriptions',
      '/backend-api/billing/subscription',
    ]),
    accountId
      ? read('交易记录', [`/backend-api/payments/transaction-history?account_id=${encodeURIComponent(accountId)}&limit=10`])
      : Promise.resolve({}),
    read('账单信息', ['/backend-api/billing/invoices', '/backend-api/invoices']),
    read('支付方式', ['/backend-api/billing/payment_methods', '/backend-api/payment_methods']),
  ]);
  const info = normalizeSubscriptionInfo({ session, profile, accountCheck, subscription, transactions, invoices, paymentMethods });
  info.warnings.push(...warnings);
  return info;
}

export function chatgptAccountIdFromAccessToken(accessToken) {
  try {
    const parts = String(accessToken || '').split('.');
    if (parts.length < 2) return '';
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const auth = payload['https://api.openai.com/auth'] || payload.auth || {};
    if (!auth || typeof auth !== 'object') return String(payload.chatgpt_account_id || '').trim();
    return String(auth.chatgpt_account_id || auth.account_id || payload.chatgpt_account_id || '').trim();
  } catch {
    return '';
  }
}

export function stableOaiId(label, seed) {
  const digest = crypto.createHash('sha1').update(`${label}${seed || 'default'}`).digest();
  const bytes = Buffer.from(digest);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function cancelRenewalHeaders({
  accessToken,
  accountId = '',
  deviceId = '',
  sessionId = '',
  targetPath = CANCEL_PATH,
  mutation = false,
} = {}) {
  const lang = OAI_CANCEL_LANGUAGE;
  const acceptLang = String(lang).startsWith('zh')
    ? 'zh-CN,zh;q=0.9,en;q=0.8'
    : 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7';
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: '*/*',
    'Accept-Language': acceptLang,
    Origin: BASE,
    Referer: `${BASE}/`,
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    'oai-client-version': OAI_CLIENT_VERSION,
    'oai-client-build-number': OAI_CLIENT_BUILD,
    'oai-device-id': deviceId || crypto.randomUUID(),
    'oai-session-id': sessionId || crypto.randomUUID(),
    'oai-language': lang,
    'x-openai-target-path': targetPath,
    'x-openai-target-route': targetPath,
  };
  if (mutation) headers['Content-Type'] = 'application/json';
  if (accountId && SEND_ACCOUNT_HEADER) headers['chatgpt-account-id'] = accountId;
  return headers;
}

function looksLikeNoSubscription(status, body, text) {
  if (status === 404) return true;
  const blob = `${JSON.stringify(body || {})} ${text || ''}`.toLowerCase();
  return /no[_\s-]*active[_\s-]*subscription|no[_\s-]*subscription|already[_\s-]*cancel|not[_\s-]*renew|will_renew.{0,12}false|cancel_at_period_end/.test(blob);
}

function patchSessionJson(sessionJson, patch = {}) {
  let data = {};
  try {
    data = typeof sessionJson === 'string' ? JSON.parse(sessionJson) : { ...(sessionJson || {}) };
  } catch {
    data = {};
  }
  if (patch.accessToken) data.accessToken = patch.accessToken;
  if (patch.sessionToken) data.sessionToken = patch.sessionToken;
  if (patch.user) data.user = patch.user;
  return JSON.stringify(data);
}

function applySessionRefresh(state, got) {
  if (!got) return state;
  if (got.accessToken) state.accessToken = got.accessToken;
  if (got.sessionToken) state.sessionToken = got.sessionToken;
  if (got.user) state.user = got.user;
  state.sessionJson = got.sessionJson || patchSessionJson(state.sessionJson, state);
  return state;
}

async function defaultRefreshSession(sessionToken, proxy, fp, reason, getAccessTokenFn) {
  const fn = getAccessTokenFn || (await import('./gpt-session.js')).getAccessToken;
  return fn(sessionToken, proxy, fp, { forceRefresh: true, refreshReason: reason });
}

async function defaultRequest(url, { method = 'GET', headers, body, proxy, fp, timeoutMs } = {}) {
  const response = await ctlsFetch(url, {
    method,
    headers: applyFp(browserHeaders(headers), fp),
    ja3: fp?.ja3,
    timeoutMs: timeoutMs || CANCEL_TIMEOUT_MS,
    ...(body != null ? { body } : {}),
  }, proxy);
  const text = await response.text().catch(() => '');
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: String(text).slice(0, 200) };
  }
  return {
    status: response.status,
    ok: response.ok,
    body: parsed,
    text: String(text).slice(0, 300),
  };
}

function accountIdFromCheckBody(data) {
  const accounts = data?.accounts || {};
  let slice = accounts.default;
  if (!slice || typeof slice !== 'object') {
    slice = Object.values(accounts).find((value) => value && typeof value === 'object') || {};
  }
  const account = slice.account || {};
  return String(account.account_id || account.id || '').trim();
}

function presentCancelResult(extra = {}) {
  return {
    ok: extra.ok !== false,
    skipped: Boolean(extra.skipped),
    optimistic: Boolean(extra.optimistic),
    willRenew: extra.willRenew ?? extra.will_renew ?? null,
    activeUntil: extra.activeUntil || extra.active_until || null,
    cancellationOutcome: extra.cancellationOutcome || extra.cancellation_outcome || null,
    planType: extra.planType || extra.plan_type || null,
    billingPeriod: extra.billingPeriod || extra.billing_period || null,
    billingCurrency: extra.billingCurrency || extra.billing_currency || null,
    returnedAmount: extra.returnedAmount ?? extra.returned_amount ?? null,
    accountId: extra.accountId || '',
    message: extra.message || '',
    accessToken: extra.accessToken || '',
    sessionToken: extra.sessionToken || '',
    sessionJson: extra.sessionJson || '',
  };
}

/**
 * 对齐 ACC cancelRenewal：刷新 session 后 POST /backend-api/subscriptions/cancel，不强制 accounts/check。
 * 取 Session 成功后调用；校验失败时乐观视为已取消。
 */
export async function cancelRenewal({
  email,
  sessionToken = '',
  accessToken = '',
  accountId = '',
  sessionJson = '',
  checkOnly = false,
} = {}, proxy = null, {
  log = () => {},
  getAccessToken,
  request = defaultRequest,
  refreshSession = defaultRefreshSession,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const fp = accountFp({ email });
  const state = {
    sessionToken: String(sessionToken || '').trim(),
    accessToken: String(accessToken || '').trim(),
    sessionJson: typeof sessionJson === 'string' ? sessionJson : JSON.stringify(sessionJson || {}),
    user: null,
  };

  async function refresh(reason) {
    if (!state.sessionToken) return { ok: false, skipped: true, reason: 'no_session_token' };
    const got = await refreshSession(state.sessionToken, proxy, fp, reason, getAccessToken);
    applySessionRefresh(state, got);
    return got;
  }

  if (state.sessionToken) {
    try {
      const ref = await refresh('pre_cancel');
      if (ref?.accessToken || ref?.ok) {
        log(`[session_refresh] pre_cancel ok${ref.sessionRotated ? ' (cookie 已轮换)' : ''}`);
      } else {
        log(`[session_refresh] pre_cancel skip: ${ref?.reason || 'unknown'}`);
      }
    } catch (error) {
      log(`[session_refresh] pre_cancel 失败: ${error.message}；若已有 AT 将继续`);
    }
  }

  if (!state.accessToken && state.sessionToken) {
    applySessionRefresh(state, await refresh('pre_cancel_token'));
  }
  if (!state.accessToken) {
    throw new Error('无 Session/accessToken，无法取消续费');
  }

  let aid = String(accountId || '').trim() || chatgptAccountIdFromAccessToken(state.accessToken);
  if (!aid) {
    try {
      const check = await request(CHECK_URL, {
        headers: cancelRenewalHeaders({
          accessToken: state.accessToken,
          targetPath: CHECK_PATH,
        }),
        proxy,
        fp,
      });
      if (check.status === 401 || check.status === 403) throw new Error(`accounts/check HTTP ${check.status}`);
      if (!check.ok) throw new Error(`accounts/check HTTP ${check.status}`);
      aid = accountIdFromCheckBody(check.body);
      if (aid) log('[cancel] account_id 来自 accounts/check');
    } catch (error) {
      if (state.sessionToken && /401|403/.test(String(error.message))) {
        applySessionRefresh(state, await refresh('check_401'));
        aid = chatgptAccountIdFromAccessToken(state.accessToken);
        if (!aid) {
          const retry = await request(CHECK_URL, {
            headers: cancelRenewalHeaders({
              accessToken: state.accessToken,
              targetPath: CHECK_PATH,
            }),
            proxy,
            fp,
          });
          aid = accountIdFromCheckBody(retry.body);
        }
      } else {
        aid = chatgptAccountIdFromAccessToken(state.accessToken);
        if (!aid) throw error;
        log('[cancel] accounts/check 失败但 JWT 有 account_id，继续');
      }
    }
  } else if (!accountId) {
    log('[cancel] account_id 来自 accessToken JWT');
  }

  if (!aid) throw new Error('Session 或账号 ID 缺失，无法取消续费');
  log(`[cancel] account_id=${aid.slice(0, 8)}…`);

  const seed = aid || email || state.sessionToken || 'cancel';
  const deviceId = stableOaiId('oai-device-', seed);
  const oaiSessionId = stableOaiId('oai-session-', seed);

  async function readSubscription() {
    const path = `${SUBS_PATH}?account_id=${encodeURIComponent(aid)}`;
    const result = await request(`${BASE}${path}`, {
      headers: cancelRenewalHeaders({
        accessToken: state.accessToken,
        accountId: aid,
        deviceId,
        sessionId: oaiSessionId,
        targetPath: SUBS_PATH,
      }),
      proxy,
      fp,
    });
    if (!result.ok) return { ok: false, http_status: result.status };
    return { ok: true, http_status: result.status, ...result.body };
  }

  if (checkOnly) {
    const sub = await readSubscription();
    return presentCancelResult({
      ok: true,
      skipped: true,
      accountId: aid,
      ...sub,
      ...state,
    });
  }

  async function postCancel() {
    log(`[cancel-renewal] POST ${CANCEL_PATH} (no-check path)`);
    return request(`${BASE}${CANCEL_PATH}`, {
      method: 'POST',
      headers: cancelRenewalHeaders({
        accessToken: state.accessToken,
        accountId: aid,
        deviceId,
        sessionId: oaiSessionId,
        targetPath: CANCEL_PATH,
        mutation: true,
      }),
      body: JSON.stringify({ account_id: aid }),
      proxy,
      fp,
    });
  }

  let cancelled = await postCancel();
  if (!cancelled.ok && [401, 403].includes(cancelled.status) && state.sessionToken) {
    log(`[cancel-renewal] cancel ${cancelled.status} → session_refresh 后重试`);
    applySessionRefresh(state, await refresh('cancel_401'));
    const nextAid = chatgptAccountIdFromAccessToken(state.accessToken);
    if (nextAid) aid = nextAid;
    cancelled = await postCancel();
  }

  if (!cancelled.ok) {
    if (looksLikeNoSubscription(cancelled.status, cancelled.body, cancelled.text)) {
      log('[cancel-renewal] 无有效订阅，跳过取消');
      return presentCancelResult({
        ok: true,
        skipped: true,
        willRenew: false,
        message: '无有效订阅，已跳过取消续费',
        accountId: aid,
        ...state,
      });
    }
    throw new Error(`取消续费失败: ${cancelled.status} ${cancelled.text || ''}`);
  }

  const returnedAmount = cancelled.body && typeof cancelled.body === 'object'
    ? cancelled.body.returned_amount
    : null;
  log(`[cancel-renewal] cancel ok returned_amount=${returnedAmount ?? '-'}`);

  await sleep(1200);
  let sub = await readSubscription();
  if (!sub.ok && [401, 403].includes(sub.http_status) && state.sessionToken) {
    applySessionRefresh(state, await refresh('cancel_verify_401'));
    sub = await readSubscription();
  }
  if (!sub.ok) {
    log(`[cancel-renewal] verify HTTP ${sub.http_status}，乐观视为已取消`);
    return presentCancelResult({
      ok: true,
      optimistic: true,
      willRenew: false,
      message: '已发送取消请求(验证跳过)',
      returnedAmount,
      accountId: aid,
      ...state,
    });
  }

  if (sub.will_renew === true) {
    throw new Error(`取消续费后 will_renew 仍为 true，outcome=${sub.cancellation_outcome || '-'}`);
  }
  log(`[cancel-renewal] verify will_renew=${sub.will_renew} outcome=${sub.cancellation_outcome || '-'} until=${sub.active_until || '-'}`);
  return presentCancelResult({
    ok: true,
    willRenew: sub.will_renew,
    activeUntil: sub.active_until,
    cancellationOutcome: sub.cancellation_outcome,
    planType: sub.plan_type,
    billingPeriod: sub.billing_period,
    billingCurrency: sub.billing_currency,
    returnedAmount,
    accountId: aid,
    ...state,
  });
}
