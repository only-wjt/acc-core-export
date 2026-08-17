import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSubscriptionInfo, chatgptAccountIdFromAccessToken, stableOaiId, cancelRenewal } from '../src/gpt-subscription.js';
import { shutdownCycleTLS } from '../src/ctls.js';

after(async () => {
  await shutdownCycleTLS().catch(() => {});
});

test('normalizes active Plus subscription and masked payment details', () => {
  const now = Date.parse('2026-08-15T00:00:00Z');
  const info = normalizeSubscriptionInfo({
    now,
    session: { account: { planType: 'plus' } },
    subscription: {
      status: 'active',
      current_period_end: '2026-09-15T00:00:00Z',
      cancel_at_period_end: false,
    },
    invoices: {
      invoices: [{ status: 'paid', amount_paid: 98214, currency: 'php', created: '2026-08-15T00:00:00Z' }],
    },
    paymentMethods: {
      payment_methods: [{ card: { brand: 'mastercard', last4: '7262', exp_month: 2, exp_year: 2029 } }],
    },
  });

  assert.equal(info.plan, 'plus');
  assert.equal(info.active, true);
  assert.equal(info.autoRenew, true);
  assert.equal(info.remainingMs, 31 * 86400000);
  assert.equal(info.lastPaymentAmount, 98214);
  assert.equal(info.currency, 'PHP');
  assert.deepEqual(info.paymentMethod, { brand: 'MASTERCARD', last4: '7262', expMonth: 2, expYear: 2029 });
});

test('normalizes transaction-history response', () => {
  const info = normalizeSubscriptionInfo({
    session: { account: { planType: 'free' } },
    transactions: {
      transactions: [{
        type: 'invoice',
        id: 'in_test',
        created_at: '2026-08-14T11:31:50Z',
        amount: 891964,
        currency: 'php',
        status: 'paid',
        invoice_url: 'https://invoice.stripe.com/i/test',
        product: { type: 'subscription', plan: 'chatgptpro' },
      }],
    },
  });
  assert.equal(info.plan, 'pro');
  assert.equal(info.lastPaymentAmount, 891964);
  assert.equal(info.currency, 'PHP');
  assert.equal(info.lastPaymentAt, Date.parse('2026-08-14T11:31:50Z'));
  assert.equal(info.invoiceUrl, 'https://invoice.stripe.com/i/test');
});

test('normalizes account profile fields from backend-api/me', () => {
  const info = normalizeSubscriptionInfo({
    profile: {
      name: 'Robert Walker',
      created: 1785171270,
      mfa_flag_enabled: true,
      email_domain_type: 'social',
      country: 'US',
      region: 'Utah',
      region_code: 'UT',
      orgs: { data: [{ id: 'org-personal' }] },
    },
  });
  assert.deepEqual(info.profile, {
    name: 'Robert Walker',
    country: 'US',
    region: 'Utah',
    regionCode: 'UT',
    createdAt: 1785171270000,
    mfaEnabled: true,
    emailDomainType: 'social',
    personalOrgId: 'org-personal',
  });
});

test('free plan leaves unavailable billing fields null', () => {
  const info = normalizeSubscriptionInfo({ session: { account: { planType: 'free' } } });
  assert.equal(info.plan, 'free');
  assert.equal(info.active, false);
  assert.equal(info.periodEnd, null);
  assert.equal(info.lastPaymentAmount, null);
  assert.equal(info.paymentMethod, null);
  assert.equal(info.billingApplicable, false);
});

test('reads paid period from subscriptions.active_until and invoice period_start', () => {
  const now = Date.parse('2026-08-15T00:00:00Z');
  const info = normalizeSubscriptionInfo({
    now,
    subscription: {
      plan_type: 'plus',
      active_until: '2026-09-15T02:52:15Z',
      will_renew: true,
    },
    transactions: {
      transactions: [{
        type: 'invoice',
        status: 'paid',
        period_start: '2026-08-15T02:52:15Z',
        created_at: '2026-08-15T02:52:15Z',
        amount: 2000,
        currency: 'usd',
      }],
    },
  });
  assert.equal(info.plan, 'plus');
  assert.equal(info.autoRenew, true);
  assert.equal(info.periodStart, Date.parse('2026-08-15T02:52:15Z'));
  assert.equal(info.periodEnd, Date.parse('2026-09-15T02:52:15Z'));
});

test('reads expiry from /me chatgpt_subscription_active_until', () => {
  const info = normalizeSubscriptionInfo({
    profile: { chatgpt_subscription_active_until: '2026-10-01T00:00:00Z' },
    session: { account: { planType: 'plus' } },
  });
  assert.equal(info.periodEnd, Date.parse('2026-10-01T00:00:00Z'));
});

test('reads entitlement from nested accounts/check payload', () => {
  const now = Date.parse('2026-08-15T00:00:00Z');
  const info = normalizeSubscriptionInfo({
    now,
    accountCheck: {
      accounts: {
        default: {
          account: { plan_type: 'plus', has_previously_paid_subscription: true },
          entitlement: {
            has_active_subscription: true,
            subscription_plan: 'chatgptplusplan',
            expires_at: '2026-09-15T00:00:00Z',
            renews_at: '2026-09-15T00:00:00Z',
            billing_period: 'monthly',
            billing_currency: 'usd',
          },
          last_active_subscription: { will_renew: true },
        },
      },
    },
  });
  assert.equal(info.plan, 'plus');
  assert.equal(info.active, true);
  assert.equal(info.autoRenew, true);
  assert.equal(info.periodEnd, Date.parse('2026-09-15T00:00:00Z'));
  assert.equal(info.billingPeriod, 'monthly');
  assert.equal(info.previouslyPaid, true);
  assert.equal(info.currency, 'USD');
});

test('guest accounts/check maps to free and marks billing as not applicable', () => {
  const info = normalizeSubscriptionInfo({
    accountCheck: {
      accounts: {
        default: {
          account: { plan_type: 'guest', has_previously_paid_subscription: false },
          entitlement: {
            has_active_subscription: false,
            subscription_plan: 'chatgptguestplan',
            expires_at: null,
            renews_at: null,
          },
          last_active_subscription: { will_renew: false },
        },
      },
    },
  });
  assert.equal(info.plan, 'free');
  assert.equal(info.active, false);
  assert.equal(info.autoRenew, null);
  assert.equal(info.billingApplicable, false);
  assert.equal(info.previouslyPaid, false);
});

function jwtWithAccount(accountId) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })).toString('base64url');
  return `${header}.${payload}.sig`;
}

test('extracts chatgpt_account_id from access token JWT', () => {
  assert.equal(chatgptAccountIdFromAccessToken(jwtWithAccount('acc-123')), 'acc-123');
  assert.equal(chatgptAccountIdFromAccessToken('not-a-jwt'), '');
});

test('stableOaiId is deterministic UUID-shaped', () => {
  const first = stableOaiId('oai-device-', 'seed');
  const second = stableOaiId('oai-device-', 'seed');
  const other = stableOaiId('oai-device-', 'other');
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('cancelRenewal refreshes session, posts cancel, and verifies will_renew', async () => {
  const calls = [];
  const access = jwtWithAccount('11111111-1111-1111-1111-111111111111');
  const result = await cancelRenewal({
    email: 'plus@example.com',
    sessionToken: 'session-jwe',
    accessToken: access,
  }, 'http://proxy.example:8080', {
    sleep: async () => {},
    refreshSession: async (token, proxy, fp, reason) => {
      calls.push({ type: 'refresh', token, proxy, reason });
      return {
        accessToken: access,
        sessionToken: 'rotated-jwe',
        sessionJson: JSON.stringify({ accessToken: access, sessionToken: 'rotated-jwe' }),
        sessionRotated: true,
      };
    },
    request: async (url, options = {}) => {
      calls.push({ type: 'http', url, method: options.method || 'GET', body: options.body });
      if (String(url).includes('/subscriptions/cancel')) {
        return { status: 200, ok: true, body: { returned_amount: 0 }, text: '{}' };
      }
      if (String(url).includes('/subscriptions?')) {
        return {
          status: 200,
          ok: true,
          body: { will_renew: false, cancellation_outcome: 'deactivate', active_until: '2026-09-15T00:00:00Z', plan_type: 'plus' },
          text: '{}',
        };
      }
      throw new Error(`unexpected ${url}`);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.willRenew, false);
  assert.equal(result.cancellationOutcome, 'deactivate');
  assert.equal(result.sessionToken, 'rotated-jwe');
  assert.equal(calls.filter((call) => call.type === 'refresh')[0].reason, 'pre_cancel');
  assert.equal(calls.some((call) => call.type === 'http' && String(call.url).includes('/subscriptions/cancel') && call.method === 'POST'), true);
  assert.equal(calls.some((call) => call.type === 'http' && /accounts\/check/.test(call.url)), false);
});

test('cancelRenewal retries after 401 and treats missing subscription as skipped', async () => {
  const access = jwtWithAccount('22222222-2222-2222-2222-222222222222');
  let cancels = 0;
  const result = await cancelRenewal({
    sessionToken: 'session-jwe',
    accessToken: access,
  }, null, {
    sleep: async () => {},
    refreshSession: async (_token, _proxy, _fp, reason) => ({
      accessToken: access,
      sessionToken: `st-${reason}`,
      sessionJson: JSON.stringify({ accessToken: access }),
    }),
    request: async (url) => {
      if (String(url).includes('/subscriptions/cancel')) {
        cancels += 1;
        if (cancels === 1) return { status: 401, ok: false, body: {}, text: 'unauthorized' };
        return { status: 400, ok: false, body: { detail: 'No active subscription' }, text: 'No active subscription' };
      }
      throw new Error(`unexpected ${url}`);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(cancels, 2);
});

test('cancelRenewal throws when verify still shows will_renew true', async () => {
  const access = jwtWithAccount('33333333-3333-3333-3333-333333333333');
  await assert.rejects(() => cancelRenewal({
    sessionToken: 'session-jwe',
    accessToken: access,
  }, null, {
    sleep: async () => {},
    refreshSession: async () => ({ accessToken: access, sessionToken: 'session-jwe', sessionJson: '{}' }),
    request: async (url) => {
      if (String(url).includes('/subscriptions/cancel')) {
        return { status: 200, ok: true, body: {}, text: '{}' };
      }
      return { status: 200, ok: true, body: { will_renew: true, cancellation_outcome: 'none' }, text: '{}' };
    },
  }), /will_renew 仍为 true/);
});
