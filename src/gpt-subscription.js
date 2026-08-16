import { BASE, accountFp } from './gpt-shared.js';
import { applyFp, browserHeaders, ctlsFetch } from './ctls.js';

const REQUEST_TIMEOUT_MS = 15000;

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
