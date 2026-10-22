// 纯格式化/文本处理：不碰 DOM、不碰应用状态，可单独测试。

function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);
}

function formatDuration(ms) {
  if (!ms) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
}

function formatWhen(value) {
  if (!value) return '—';
  const date = new Date(value);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const time = date.toLocaleTimeString('zh-CN', { hour12: false });
  return sameDay ? `今天 ${time}` : `${date.toLocaleDateString('zh-CN')} ${time}`;
}

function csvCell(value) {
  const text = String(value ?? '');
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function formatResultTags(item) {
  const counts = item.counts || {};
  const tags = item.kind === 'check'
    ? [['有效', counts.alive, 'success'], ['失效', counts.dead, 'failed']]
    : [['成功', counts.success, 'success'], ['失败', counts.failed, 'failed'], ['取消', counts.cancelled, 'cancelled']];
  const rendered = tags
    .filter(([, value]) => value)
    .map(([label, value, tone]) => `<span class="status-pill status-${tone}">${label} ${value}</span>`)
    .join(' ');
  return rendered || '<span class="status-pill status-pending">无结果</span>';
}

function parseAccountDisplay(item) {
  const raw = item.accountDisplay || '';
  if (raw.includes('----')) {
    const [email, gptPassword = '', mailPassword = ''] = raw.split('----');
    return { email: email || item.email, gptPassword, mailPassword };
  }
  const separator = raw.indexOf(':');
  if (separator > 0) {
    return { email: raw.slice(0, separator) || item.email, gptPassword: '', mailPassword: raw.slice(separator + 1) };
  }
  return { email: item.email, gptPassword: '', mailPassword: '' };
}

function maskProxy(line) {
  try {
    const parsed = new URL(/:\/\//.test(line) ? line : `socks5://${line}`);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return line;
  }
}

function normalizeProxyText(text) {
  const seen = new Set();
  const lines = [];
  for (const raw of text.split(/[\r\n,;]+|\s{2,}/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const withScheme = /:\/\//.test(line) ? line : `socks5://${line}`;
    if (seen.has(withScheme)) continue;
    seen.add(withScheme);
    lines.push(withScheme);
  }
  return lines.join('\n');
}

function countProxyLines(text) {
  return text.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#')).length;
}

function formatSubscription(info) {
  if (!info || (!info.plan && !info.cancelRenewal && !info.warnings?.length)) {
    return '';
  }
  const missing = info.billingApplicable === false ? '免费账号无此项' : '未提供';
  const date = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : missing;
  const remaining = info.remainingMs == null ? missing : `${Math.floor(info.remainingMs / 86400000)} 天 ${Math.floor((info.remainingMs % 86400000) / 3600000)} 小时`;
  const amount = info.lastPaymentAmount == null ? missing : `${info.currency || ''} ${(info.lastPaymentAmount / 100).toFixed(2)}`.trim();
  const method = info.paymentMethod
    ? `${info.paymentMethod.brand || 'CARD'} **** ${info.paymentMethod.last4}${info.paymentMethod.expMonth ? ` · ${String(info.paymentMethod.expMonth).padStart(2, '0')}/${info.paymentMethod.expYear}` : ''}`
    : missing;
  let invoiceHost = '';
  if (info.invoiceUrl) {
    try {
      const invoiceUrl = new URL(info.invoiceUrl);
      if (invoiceUrl.protocol === 'https:' && invoiceUrl.hostname === 'invoice.stripe.com') invoiceHost = invoiceUrl.href;
    } catch {}
  }
  const periodLabel = info.billingPeriod === 'year' || info.billingPeriod === 'yearly' ? '年付'
    : info.billingPeriod === 'month' || info.billingPeriod === 'monthly' ? '月付'
      : info.billingPeriod || missing;
  const cancel = info.cancelRenewal;
  let cancelLabel = '未执行';
  if (cancel?.ok && cancel.skipped) cancelLabel = cancel.message || '已跳过';
  else if (cancel?.ok && cancel.optimistic) cancelLabel = '已发送取消请求（验证跳过）';
  else if (cancel?.ok && cancel.willRenew !== true) cancelLabel = cancel.activeUntil
    ? `已取消，权益保留至 ${new Date(cancel.activeUntil).toLocaleString('zh-CN', { hour12: false })}`
    : '已取消，到期后不续费';
  else if (cancel?.ok === false) cancelLabel = cancel.error || '取消失败';
  else if (info.autoRenew === false) cancelLabel = '到期后不续费';
  return `
    <div class="subscription-grid">
      <span>当前套餐</span><strong>${escapeHtml(String(info.plan || '未知').toUpperCase())}</strong>
      <span>订阅状态</span><strong>${info.active ? '有效' : escapeHtml(info.status || '未知')}</strong>
      <span>开始时间</span><strong>${escapeHtml(date(info.periodStart))}</strong>
      <span>到期时间</span><strong>${escapeHtml(date(info.periodEnd))}</strong>
      <span>剩余</span><strong>${escapeHtml(remaining)}</strong>
      <span>自动续费</span><strong>${info.autoRenew == null ? missing : info.autoRenew ? '已开启' : '到期后不续费'}</strong>
      <span>取消续费</span><strong>${escapeHtml(cancelLabel)}</strong>
      <span>计费周期</span><strong>${escapeHtml(periodLabel)}</strong>
      <span>最近付款</span><strong>${escapeHtml(amount)}${info.lastPaymentAt ? ` · ${escapeHtml(date(info.lastPaymentAt))}` : ''}</strong>
      <span>历史付费</span><strong>${info.previouslyPaid == null ? '未提供' : info.previouslyPaid ? '曾付费' : '从未付费'}</strong>
      <span>支付方式</span><strong>${escapeHtml(method)}</strong>
      <span>账号地区</span><strong>${escapeHtml([info.profile?.country, info.profile?.region].filter(Boolean).join(' / ') || '未提供')}</strong>
      <span>创建时间</span><strong>${escapeHtml(info.profile?.createdAt ? new Date(info.profile.createdAt).toLocaleString('zh-CN', { hour12: false }) : '未提供')}</strong>
      <span>MFA</span><strong>${info.profile?.mfaEnabled == null ? '未提供' : info.profile.mfaEnabled ? '已启用' : '未启用'}</strong>
      <span>邮箱类型</span><strong>${escapeHtml(info.profile?.emailDomainType || '未提供')}</strong>
      <span>账单发票</span><strong>${invoiceHost ? `<a class="invoice-link" href="${escapeHtml(invoiceHost)}" target="_blank" rel="noopener noreferrer" download>打开 / 下载发票</a>` : missing}</strong>
    </div>
    ${info.warnings?.length ? `<div class="subscription-warning">${escapeHtml(info.warnings.join('；'))}</div>` : ''}
  `;
}

export {
  escapeHtml,
  formatDuration,
  formatWhen,
  csvCell,
  formatResultTags,
  parseAccountDisplay,
  maskProxy,
  normalizeProxyText,
  countProxyLines,
  formatSubscription,
};
