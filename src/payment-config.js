export const PAYMENT_PLAN_KEYS = ['plus', 'pro_5x', 'pro_20x'];

const PLAN_META = Object.freeze({
  plus: { label: 'Plus', upstreamPlan: 'chatgptplusplan', flow: 'direct' },
  pro_5x: { label: 'Pro 5x', upstreamPlan: 'chatgptprolite', flow: 'direct' },
  pro_20x: { label: 'Pro 20x', upstreamPlan: 'chatgptpro', flow: 'plus_upgrade' },
});

const DEFAULT_PLANS = Object.freeze({
  plus: {
    enabled: true,
    serviceFeeUsdMinor: 100,
    expectedAmountMinor: 98214,
    minAmountMinor: 90000,
    maxAmountMinor: 110000,
    balanceBufferBps: 500,
    minBalanceBufferUsdMinor: 200,
  },
  pro_5x: {
    enabled: false,
    serviceFeeUsdMinor: 500,
    expectedAmountMinor: 579464,
    minAmountMinor: 520000,
    maxAmountMinor: 650000,
    balanceBufferBps: 500,
    minBalanceBufferUsdMinor: 300,
  },
  pro_20x: {
    enabled: true,
    serviceFeeUsdMinor: 1000,
    expectedAmountMinor: 891966,
    minAmountMinor: 780000,
    maxAmountMinor: 1050000,
    upgradeExpectedAmountMinor: 793752,
    upgradeMinAmountMinor: 650000,
    upgradeMaxAmountMinor: 950000,
    balanceBufferBps: 500,
    minBalanceBufferUsdMinor: 500,
  },
});

const EDITABLE_FIELDS = new Set([
  'enabled',
  'serviceFeeUsdMinor',
  'expectedAmountMinor', 'minAmountMinor', 'maxAmountMinor',
  'upgradeExpectedAmountMinor', 'upgradeMinAmountMinor', 'upgradeMaxAmountMinor',
  'balanceBufferBps', 'minBalanceBufferUsdMinor',
]);

function intValue(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function normalizePlan(key, raw = {}) {
  const defaults = DEFAULT_PLANS[key];
  const meta = PLAN_META[key];
  const plan = {
    key,
    label: meta.label,
    upstreamPlan: meta.upstreamPlan,
    flow: meta.flow,
    currency: 'PHP',
    enabled: raw.enabled === undefined ? defaults.enabled : raw.enabled === true,
    serviceFeeUsdMinor: intValue(raw.serviceFeeUsdMinor, defaults.serviceFeeUsdMinor),
    expectedAmountMinor: intValue(raw.expectedAmountMinor, defaults.expectedAmountMinor),
    minAmountMinor: intValue(raw.minAmountMinor, defaults.minAmountMinor),
    maxAmountMinor: intValue(raw.maxAmountMinor, defaults.maxAmountMinor),
    balanceBufferBps: intValue(raw.balanceBufferBps, defaults.balanceBufferBps),
    minBalanceBufferUsdMinor: intValue(raw.minBalanceBufferUsdMinor, defaults.minBalanceBufferUsdMinor),
  };
  if (key === 'pro_20x') {
    plan.upgradeExpectedAmountMinor = intValue(raw.upgradeExpectedAmountMinor, defaults.upgradeExpectedAmountMinor);
    plan.upgradeMinAmountMinor = intValue(raw.upgradeMinAmountMinor, defaults.upgradeMinAmountMinor);
    plan.upgradeMaxAmountMinor = intValue(raw.upgradeMaxAmountMinor, defaults.upgradeMaxAmountMinor);
  }
  validatePaymentPlan(plan);
  return plan;
}

export function defaultPaymentConfig() {
  return normalizePaymentConfig({ version: 1, plans: DEFAULT_PLANS });
}

export function normalizePaymentConfig(raw = {}) {
  const plans = {};
  for (const key of PAYMENT_PLAN_KEYS) plans[key] = normalizePlan(key, raw.plans?.[key]);
  return {
    version: Math.max(1, intValue(raw.version, 1)),
    updatedAt: Number(raw.updatedAt) || null,
    updatedBy: String(raw.updatedBy || ''),
    reason: String(raw.reason || ''),
    plans,
  };
}

export function validatePaymentPlan(plan) {
  if (!Number.isSafeInteger(plan.serviceFeeUsdMinor) || plan.serviceFeeUsdMinor < 0 || plan.serviceFeeUsdMinor > 1000000) {
    throw new Error('API/CDK 服务费必须是 0-10000 USD 的最小单位整数');
  }
  for (const field of ['expectedAmountMinor', 'minAmountMinor', 'maxAmountMinor']) {
    if (!Number.isSafeInteger(plan[field]) || plan[field] <= 0) throw new Error(`${field} 必须是正整数`);
  }
  if (plan.minAmountMinor > plan.expectedAmountMinor || plan.expectedAmountMinor > plan.maxAmountMinor) {
    throw new Error('预期金额必须位于最小和最大金额之间');
  }
  if (!Number.isSafeInteger(plan.balanceBufferBps) || plan.balanceBufferBps < 0 || plan.balanceBufferBps > 5000) {
    throw new Error('余额缓冲必须在 0-5000 bps 之间');
  }
  if (!Number.isSafeInteger(plan.minBalanceBufferUsdMinor) || plan.minBalanceBufferUsdMinor < 0) {
    throw new Error('最低余额缓冲必须是非负整数');
  }
  if (plan.key === 'pro_20x') {
    for (const field of ['upgradeExpectedAmountMinor', 'upgradeMinAmountMinor', 'upgradeMaxAmountMinor']) {
      if (!Number.isSafeInteger(plan[field]) || plan[field] <= 0) throw new Error(`${field} 必须是正整数`);
    }
    if (plan.upgradeMinAmountMinor > plan.upgradeExpectedAmountMinor || plan.upgradeExpectedAmountMinor > plan.upgradeMaxAmountMinor) {
      throw new Error('Pro 升级预期金额必须位于升级最小和最大金额之间');
    }
  }
  return plan;
}

export function updatePaymentPlan(config, key, patch = {}, actor = '', reason = '') {
  if (!PAYMENT_PLAN_KEYS.includes(key)) throw new Error('未知支付套餐');
  const current = normalizePaymentConfig(config);
  const filtered = {};
  for (const [field, value] of Object.entries(patch || {})) {
    if (EDITABLE_FIELDS.has(field)) filtered[field] = value;
  }
  const nextPlan = normalizePlan(key, { ...current.plans[key], ...filtered });
  return normalizePaymentConfig({
    ...current,
    version: current.version + 1,
    updatedAt: Date.now(),
    updatedBy: actor,
    reason,
    plans: { ...current.plans, [key]: nextPlan },
  });
}

export function paymentPlanKey(plan) {
  const value = String(plan || '').toLowerCase();
  if (value === 'pro_5x' || value.includes('prolite')) return 'pro_5x';
  if (value === 'pro_20x' || (value.includes('pro') && !value.includes('prolite'))) return 'pro_20x';
  return 'plus';
}

export function paymentPlan(config, plan) {
  const normalized = normalizePaymentConfig(config);
  return normalized.plans[paymentPlanKey(plan)];
}

export function amountWithinRange(amount, plan, stage = 'total') {
  const value = Number(amount);
  if (!Number.isSafeInteger(value) || value <= 0) return false;
  if (stage === 'upgrade' && plan.key === 'pro_20x') {
    return value >= plan.upgradeMinAmountMinor && value <= plan.upgradeMaxAmountMinor;
  }
  return value >= plan.minAmountMinor && value <= plan.maxAmountMinor;
}
