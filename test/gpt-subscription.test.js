import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSubscriptionInfo } from '../src/gpt-subscription.js';

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
