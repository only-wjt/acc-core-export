const PAID_STATUSES = new Set(['paid', 'succeeded', 'success', 'complete', 'completed']);
const BLOCKING_STATES = new Set([
  'paid_pending_subscription',
  'submitted_pending_reconciliation',
]);
const NO_CHARGE_STAGES = new Set(['already_subscribed', 'already_pro']);

export function normalizePaymentPlan(plan) {
  const value = String(plan || '').toLowerCase();
  if (value.includes('prolite')) return 'prolite';
  if (value.includes('pro')) return 'pro';
  if (value.includes('plus')) return 'plus';
  return value === 'free' ? 'free' : '';
}

export function planMatches(actual, expected) {
  const current = normalizePaymentPlan(actual);
  const target = normalizePaymentPlan(expected);
  if (!current || !target) return false;
  if (current === target) return true;
  if (target === 'free' || current === 'free') return false;

  const paidPlanRank = { plus: 1, prolite: 2, pro: 3 };
  return (paidPlanRank[current] || 0) >= (paidPlanRank[target] || 0);
}

export function isNoChargeResult(result) {
  return result?.skipped === true || NO_CHARGE_STAGES.has(String(result?.stage || ''));
}

export function isPaidInvoice(invoice) {
  if (!invoice || typeof invoice !== 'object') return false;
  if (invoice.paid === true) return true;
  const status = String(invoice.payment_status || invoice.status || '').toLowerCase();
  if (PAID_STATUSES.has(status)) return true;
  const amountPaid = Number(invoice.amount_paid ?? invoice.paid_amount ?? 0);
  return amountPaid > 0 && !['void', 'uncollectible', 'failed'].includes(status);
}

function invoiceCreatedAt(invoice) {
  const value = invoice?.created;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

export function findNewPaidInvoice(invoices, knownInvoiceIds = [], sinceMs = 0) {
  const known = new Set((knownInvoiceIds || []).filter(Boolean).map(String));
  return (invoices || []).find((invoice) => (
    isPaidInvoice(invoice)
      && (!invoice.id || !known.has(String(invoice.id)))
      && (known.size > 0 || !sinceMs || invoiceCreatedAt(invoice) >= sinceMs - 5 * 60 * 1000)
  )) || null;
}

export function hasConfirmedUnpaidReconciliation(result) {
  return result?.activated === false
    && result?.subscriptionChecked === true
    && result?.invoicesChecked === true
    && !result?.paidInvoice;
}

function resultEvidence(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.paymentEvidence) return result.paymentEvidence;
  return resultEvidence(result.plusResult);
}

export function blocksPaymentRetry(account, requestedPlan) {
  if (!account?.paymentRetryBlocked) return false;
  if (!BLOCKING_STATES.has(String(account.paymentState || ''))) return false;
  return planMatches(account.pendingPlan || account.lastPaymentPlan, requestedPlan);
}

export function paymentResultPatch(result, requestedPlan, now = Date.now()) {
  if (!result || typeof result !== 'object') return {};
  const target = normalizePaymentPlan(
    result.pendingPlan || result.expectedPlan || result.paymentEvidence?.plan || requestedPlan,
  );
  const finalPlan = normalizePaymentPlan(result.finalPlan || result.plan_type);
  const settled = target && planMatches(finalPlan, target);
  const evidence = resultEvidence(result);

  if (isNoChargeResult(result)) {
    return {
      paymentState: 'not_charged',
      paymentRetryBlocked: false,
      pendingPlan: null,
      lastPaymentPlan: target || finalPlan || null,
      lastPaymentUpdatedAt: now,
    };
  }
  const pending = result.subscriptionPending === true
    || result.retryPayment === false
    || result.stage === 'paid_pending_subscription'
    || result.stage === 'submitted_pending_reconciliation';

  if (result.stage === 'checkout_created') {
    return {
      paymentState: 'checkout_created',
      paymentRetryBlocked: false,
      pendingPlan: null,
      lastPaymentPlan: target || null,
      lastCheckoutSessionId: result.checkoutSessionId || result.paymentEvidence?.checkoutSessionId || null,
      lastPaymentUpdatedAt: now,
    };
  }

  // external_subscription: 账号非本平台开通的已订阅状态，不可升级
  if (result.stage === 'external_subscription') {
    return {
      paymentState: 'failed_precharge',
      paymentRetryBlocked: true,
      pendingPlan: null,
      lastPaymentPlan: target || finalPlan || null,
      lastPaymentUpdatedAt: now,
    };
  }

  // cs_live 路径失败：本单禁止再扣（可新开订单）；会话 id 写入便于对账
  if (
    result.stage === 'cs_live_failed'
    || result.path === 'cs_live_payment_pages' && result.ok === false && result.retryPayment === false
    || String(result.code || '').startsWith('cs_live_')
  ) {
    return {
      paymentState: 'failed_precharge',
      paymentRetryBlocked: true,
      pendingPlan: null,
      lastPaymentPlan: target || finalPlan || null,
      lastCheckoutSessionId: result.checkoutSessionId || result.paymentEvidence?.checkoutSessionId || null,
      lastPaymentIntent: result.paymentEvidence?.paymentIntent || result.paymentIntent || null,
      lastPaymentUpdatedAt: now,
    };
  }

  // 已扣款但 /subscriptions 仍 free：终态失败，禁止再扣；停止无尽对账 pending
  if (result.stage === 'plus_paid_plan_still_free' || result.code === 'subscription_query_stale') {
    const evidence = resultEvidence(result);
    return {
      paymentState: 'paid_pending_subscription',
      paymentRetryBlocked: true,
      pendingPlan: null,
      lastPaymentPlan: target || finalPlan || 'plus',
      lastPaymentUpdatedAt: now,
      lastPaymentSource: evidence?.source || 'stripe_payment_intent',
      lastPaymentConfirmedAt: evidence?.confirmedAt || now,
      lastPaymentIntent: evidence?.paymentIntent || result?.paymentIntent || null,
      lastCheckoutSessionId: evidence?.checkoutSessionId || result?.checkoutSessionId || null,
      lastInvoiceId: evidence?.invoiceId || null,
      lastPaymentAmount: evidence?.amount ?? result?.amount ?? null,
      lastPaymentCurrency: evidence?.currency || result?.currency || null,
    };
  }

  if (result.retryPayment === true && ['declined', 'failed_precharge', 'upgrade_rejected'].includes(result.stage)) {
    return {
      paymentState: result.stage,
      paymentRetryBlocked: false,
      pendingPlan: null,
      lastPaymentPlan: target || finalPlan || null,
      lastPaymentUpdatedAt: now,
    };
  }

  if (!evidence && !pending && !settled) return {};

  const patch = {
    paymentState: settled
      ? 'settled'
      : (evidence?.confirmed === true ? 'paid_pending_subscription' : 'submitted_pending_reconciliation'),
    paymentRetryBlocked: !settled,
    pendingPlan: settled ? null : (target || null),
    lastPaymentPlan: target || finalPlan || null,
    lastPaymentUpdatedAt: now,
  };

  if (evidence) {
    patch.lastPaymentSource = evidence.source || null;
    patch.lastPaymentSubmittedAt = evidence.submittedAt || now;
    patch.lastPaymentConfirmedAt = evidence.confirmed === true ? (evidence.confirmedAt || now) : null;
    patch.lastPaymentIntent = evidence.paymentIntent || null;
    patch.lastCheckoutSessionId = evidence.checkoutSessionId || null;
    patch.lastInvoiceId = evidence.invoiceId || null;
    patch.lastPaymentAmount = evidence.amount ?? null;
    patch.lastPaymentCurrency = evidence.currency || null;
  }
  // 支付过程拿到的 OpenAI account_id：取消续费必须缓存（参考项目 order.accountId）
  const chatgptAccountId = result.chatgptAccountId || result.accountId
    || evidence?.chatgptAccountId || evidence?.accountId || null;
  if (chatgptAccountId) patch.chatgptAccountId = String(chatgptAccountId).slice(0, 64);
  if (settled) patch.plan = finalPlan;
  return patch;
}
