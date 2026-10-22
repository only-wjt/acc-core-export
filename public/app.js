const accounts = document.querySelector('#accounts');
const concurrency = document.querySelector('#concurrency');
const parseCount = document.querySelector('#parseCount');
const inputErrors = document.querySelector('#inputErrors');
const toggleSecrets = document.querySelector('#toggleSecrets');
const startButton = document.querySelector('#startButton');
const cancelButton = document.querySelector('#cancelButton');
const statusSummary = document.querySelector('#statusSummary');
const progressBar = document.querySelector('#progressBar');
const statusBody = document.querySelector('#statusBody');
const sessionList = document.querySelector('#sessionList');
const copyButton = document.querySelector('#copyButton');
const downloadButton = document.querySelector('#downloadButton');
const exportExcelButton = document.querySelector('#exportExcelButton');
const queryAllPlansButton = document.querySelector('#queryAllPlansButton');
const cancelAllRenewalButton = document.querySelector('#cancelAllRenewalButton');
const copyFailedButton = document.querySelector('#copyFailedButton');
const retryFailedButton = document.querySelector('#retryFailedButton');
const retrySelectedButton = document.querySelector('#retrySelectedButton');
const selectAllAccounts = document.querySelector('#selectAllAccounts');
const rateHint = document.querySelector('#rateHint');
const toast = document.querySelector('#toast');

const JOB_STORAGE_KEY = 'acc-core:lastJobId';

const metrics = {
  total: document.querySelector('#metricTotal'),
  running: document.querySelector('#metricRunning'),
  success: document.querySelector('#metricSuccess'),
  failed: document.querySelector('#metricFailed'),
};

let currentJobId = null;
let lastJob = null;
let jobRunning = false;
let statusFilter = 'all';
let pollTimer = null;
let toastTimer = null;
let inputVisible = false;
const selectedAccountIndexes = new Set();

const statusLabels = {
  pending: '等待',
  running: '处理中',
  success: '成功',
  failed: '失败',
  cancelled: '已取消',
};

const errorCategories = {
  password: { label: '密码错误', advice: '请核对账号密码后重试' },
  otp: { label: '验证码', advice: '多为邮箱密码有误或取码超时，请检查邮箱可用性' },
  risk: { label: '风控', advice: '建议降低并发并稍后重试' },
  proxy: { label: '代理/网络', advice: '建议更换代理池后重试' },
  session: { label: 'Session', advice: 'Session 无效时会自动用邮箱重新登录；若仍失败请换代理后重试' },
  ineligible: { label: '不可设密', advice: 'OpenAI 拒绝给该号设置密码，重试通常无效' },
  unknown: { label: '未知', advice: '可先重试，若持续失败请检查代理与账号' },
};

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('visible');
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2200);
}

function localParse(value) {
  const rows = value.split(/\r?\n/).map((line, index) => ({ raw: line.trim(), line: index + 1 })).filter((row) => row.raw);
  const errors = [];
  let valid = 0;
  const seen = new Set();

  for (const row of rows) {
    let email;

    // 优先尝试三段式格式
    if (row.raw.includes('----')) {
      const parts = row.raw.split('----').map((part) => part.trim());
      if (parts.length !== 3 || parts.some((part) => !part)) {
        errors.push(`第 ${row.line} 行格式不正确`);
        continue;
      }
      email = parts[0];
    } else {
      // 兼容两段式格式
      const separator = row.raw.indexOf(':');
      if (separator <= 0 || separator === row.raw.length - 1) {
        errors.push(`第 ${row.line} 行格式不正确`);
        continue;
      }
      email = row.raw.slice(0, separator).trim();
      const password = row.raw.slice(separator + 1).trim();
      if (!email || !password) {
        errors.push(`第 ${row.line} 行格式不正确`);
        continue;
      }
    }

    if (!/^\S+@\S+\.\S+$/.test(email)) {
      errors.push(`第 ${row.line} 行邮箱无效`);
      continue;
    }
    if (seen.has(email.toLowerCase())) {
      errors.push(`第 ${row.line} 行邮箱重复`);
      continue;
    }
    seen.add(email.toLowerCase());
    valid++;
  }

  if (valid > 100) errors.push('单次最多处理 100 个账号');
  return { valid, errors };
}

function updateParseState() {
  const parsed = localParse(accounts.value);
  parseCount.textContent = `${parsed.valid} 条有效输入`;
  inputErrors.textContent = parsed.errors.slice(0, 3).join('；');
  startButton.disabled = jobRunning || parsed.valid === 0 || parsed.errors.length > 0;
}

function setJobRunning(running) {
  jobRunning = running;
  cancelButton.disabled = !running;
  accounts.disabled = running;
  concurrency.disabled = running || currentUser?.role !== 'admin';
  updateParseState();
}

async function copyText(value, successMessage) {
  try {
    await navigator.clipboard.writeText(value);
    showToast(successMessage);
  } catch {
    const helper = document.createElement('textarea');
    helper.value = value;
    document.body.append(helper);
    helper.select();
    document.execCommand('copy');
    helper.remove();
    showToast(successMessage);
  }
}

function failedItems(job = lastJob) {
  return job?.items.filter((item) => item.status === 'failed') || [];
}

function failedRetryableItems(job = lastJob) {
  return job?.items.filter((item) => item.canRetry && (item.status === 'failed' || item.status === 'cancelled')) || [];
}

// 让批量勾选的数量直接体现在按钮上，选没选、选了几个一眼可见
function syncRetrySelectedButton() {
  const count = selectedAccountIndexes.size;
  retrySelectedButton.disabled = count === 0;
  retrySelectedButton.textContent = count ? `重试所选（${count}）` : '重试所选';
}

function syncHeaderCheckbox(header, selected, items) {
  if (!header) return;
  const retryable = items.filter((item) => item.canRetry);
  const selectedVisible = retryable.filter((item) => selected.has(item.index)).length;
  header.checked = retryable.length > 0 && selectedVisible === retryable.length;
  header.indeterminate = selectedVisible > 0 && selectedVisible < retryable.length;
}

const JOB_OWNER_KEY = 'acc-core:lastJobOwner';

// 同一台机器换人登录时，别把上一个人的任务接着显示出来
function dropForeignJob(username) {
  let owner = '';
  try { owner = sessionStorage.getItem(JOB_OWNER_KEY) || ''; } catch { return; }
  if (owner && owner !== username) {
    forgetJob();
    forgetPwJob();
  }
  try { sessionStorage.setItem(JOB_OWNER_KEY, username); } catch { /* ignore */ }
}

function rememberJob(id) {
  currentJobId = id;
  try { sessionStorage.setItem(JOB_STORAGE_KEY, id); } catch { /* 隐私模式可能不可用 */ }
}

function forgetJob() {
  currentJobId = null;
  try { sessionStorage.removeItem(JOB_STORAGE_KEY); } catch { /* ignore */ }
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

function csvCell(value) {
  const text = String(value ?? '');
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function sessionByIndex(job) {
  const map = new Map();
  job.items
    .filter((item) => item.status === 'success')
    .sort((a, b) => a.index - b.index)
    .forEach((item, index) => map.set(item.index, job.sessions[index] || ''));
  return map;
}

function updateRateHint(job) {
  const finished = job.counts.success + job.counts.failed + job.counts.cancelled;
  if (job.status === 'running' || finished < 3 || job.counts.failed === 0 || job.counts.failed / finished < 0.4) {
    rateHint.hidden = true;
    rateHint.textContent = '';
    return;
  }
  const counts = {};
  for (const item of job.items) {
    if (item.status === 'failed' && item.errorCategory) {
      counts[item.errorCategory] = (counts[item.errorCategory] || 0) + 1;
    }
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const advice = top ? errorCategories[top[0]]?.advice : '建议降低并发或更换代理后重试';
  rateHint.hidden = false;
  rateHint.textContent = `失败较多（${job.counts.failed}/${finished}）。${advice}。`;
}

function formatDuration(ms) {
  if (!ms) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);
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

function renderJob(job) {
  lastJob = job;
  const done = job.counts.success + job.counts.failed + job.counts.cancelled;
  const percent = job.counts.total ? Math.round((done / job.counts.total) * 100) : 0;
  progressBar.style.width = `${percent}%`;
  metrics.total.textContent = job.counts.total;
  metrics.running.textContent = job.counts.running;
  metrics.success.textContent = job.counts.success;
  metrics.failed.textContent = job.counts.failed;
  statusSummary.textContent = job.status === 'running'
    ? `${done} / ${job.counts.total} 已完成`
    : job.status === 'cancelled' ? '任务已取消' : '任务已完成';

  const visibleItems = statusFilter === 'failed'
    ? job.items.filter((item) => item.status === 'failed' || item.status === 'cancelled')
    : job.items;
  statusBody.innerHTML = visibleItems.length
    ? visibleItems.map((item) => {
      const retryLabel = item.retryCount ? ` · 已重试 ${item.retryCount} 次` : '';
      const errorText = item.error ? `${item.error}${retryLabel}` : (retryLabel ? retryLabel.slice(3) : '—');
      const category = item.status === 'failed' && item.errorCategory ? errorCategories[item.errorCategory] : null;
      const categoryTag = category
        ? `<span class="reason-tag reason-${item.errorCategory}" title="${escapeHtml(category.advice)}">${escapeHtml(category.label)}</span>`
        : '';
      const retryDisabled = !item.canRetry || item.status === 'running' || item.status === 'pending';
      if (!item.canRetry) selectedAccountIndexes.delete(item.index);
      let actionHtml = '—';
      if (item.status === 'running') {
        actionHtml = `<button class="retry-button abort-button" type="button" data-abort-index="${item.index}" ${item.aborting ? 'disabled' : ''}>${item.aborting ? '终止中' : '终止'}</button>`;
      } else if (item.canRetry || item.status === 'failed') {
        actionHtml = `<button class="retry-button" type="button" data-retry-index="${item.index}" ${retryDisabled ? 'disabled' : ''}>重试</button>`;
      }
      return `
    <tr>
      <td class="select-col">${item.canRetry
        ? `<input type="checkbox" data-account-select="${item.index}" ${selectedAccountIndexes.has(item.index) ? 'checked' : ''} aria-label="选择 ${escapeHtml(item.email)}">`
        : ''}</td>
      <td>${escapeHtml(item.email)}</td>
      <td>${escapeHtml(item.stage)}</td>
      <td><span class="status-pill status-${item.status}">${statusLabels[item.status] || item.status}</span></td>
      <td>${formatDuration(item.durationMs)}</td>
      <td class="error-cell" title="${escapeHtml(item.error || '')}">${categoryTag}${escapeHtml(errorText)}</td>
      <td class="action-cell">${actionHtml}</td>
    </tr>`;
    }).join('')
    : `<tr class="empty-row"><td colspan="7">${statusFilter === 'failed' ? '当前没有失败或已取消的账号。' : '开始任务后，这里会逐项显示进度。'}</td></tr>`;

  const failedCount = failedItems(job).length;
  const retryableCount = failedRetryableItems(job).length;
  copyFailedButton.disabled = failedCount === 0;
  retryFailedButton.disabled = retryableCount === 0;
  syncRetrySelectedButton();
  syncHeaderCheckbox(selectAllAccounts, selectedAccountIndexes, visibleItems);
  exportExcelButton.disabled = job.items.length === 0;
  updateRateHint(job);

  const successfulItems = job.items.filter((item) => item.status === 'success').sort((a, b) => a.index - b.index);
  sessionList.innerHTML = successfulItems.length
    ? successfulItems.map((item, index) => {
      const busy = item.billingStatus === 'running';
      const queryLabel = busy && item.billingAction === 'query' ? '查询中' : '查询套餐';
      const cancelLabel = busy && item.billingAction === 'cancel' ? '取消中' : '取消自动续费';
      const planHtml = formatSubscription(item.subscriptionInfo);
      const errorHtml = item.billingError && item.billingStatus === 'error'
        ? `<p class="session-billing-note is-error">${escapeHtml(item.billingError)}</p>`
        : '';
      return `
      <article class="session-item">
        <header class="session-head">
          <div class="session-meta"><span>#${index + 1}</span><strong>${escapeHtml(item.accountDisplay || item.email)}</strong></div>
          <div class="session-billing-actions">
            <button class="icon-text-button" type="button" data-billing="query" data-index="${item.index}" ${busy ? 'disabled' : ''}>${queryLabel}</button>
            <button class="icon-text-button" type="button" data-billing="cancel" data-index="${item.index}" ${busy ? 'disabled' : ''}>${cancelLabel}</button>
          </div>
        </header>
        ${planHtml ? `<div class="session-plan">${planHtml}</div>` : ''}
        ${errorHtml}
        <code class="session-token">${escapeHtml(job.sessions[index] || '')}</code>
      </article>`;
    }).join('')
    : '<p class="session-empty">成功获取的 Session 将在这里逐条显示。</p>';
  const hasResults = job.sessions.length > 0;
  const billingBusyNow = billingBusy(job);
  copyButton.disabled = !hasResults;
  downloadButton.disabled = !hasResults;
  if (queryAllPlansButton) queryAllPlansButton.disabled = !hasResults || billingBusyNow;
  if (cancelAllRenewalButton) cancelAllRenewalButton.disabled = !hasResults || billingBusyNow;
  if (hasResults) {
    copyButton.dataset.sessions = job.sessions.join('\n');
  }
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    window.location.replace('/login');
    throw new Error('登录已过期，正在跳转登录页');
  }
  if (!response.ok) {
    const message = data.error || data.errors?.map((item) => `第 ${item.line || '?'} 行：${item.message}`).join('；') || '请求失败';
    throw new Error(message);
  }
  return data;
}

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
}

function billingBusy(job = lastJob) {
  return (job?.items || []).some((item) => item.billingStatus === 'running');
}

async function pollJob() {
  pollTimer = null;
  if (!currentJobId) return;
  try {
    const job = await request(`/api/jobs/${currentJobId}`);
    renderJob(job);
    if (job.status === 'running') {
      setJobRunning(true);
      pollTimer = setTimeout(pollJob, 800);
    } else if (billingBusy(job)) {
      setJobRunning(false);
      pollTimer = setTimeout(pollJob, 800);
    } else {
      const loginJustFinished = jobRunning;
      setJobRunning(false);
      if (loginJustFinished) {
        showToast(job.status === 'cancelled' ? '任务已取消' : `处理完成：成功 ${job.counts.success}，失败 ${job.counts.failed}`);
        void loadHistory();
      }
    }
  } catch (error) {
    if (/不存在|已清理/.test(error.message)) {
      forgetJob();
      lastJob = null;
    }
    setJobRunning(false);
    showToast(error.message);
  }
}

function ensurePolling() {
  if (!pollTimer) pollTimer = setTimeout(pollJob, 400);
}

async function retryAccounts(payload, toastMessage) {
  if (!currentJobId) return;
  try {
    const job = await request(`/api/jobs/${currentJobId}/retry`, {
      method: 'POST',
      body: JSON.stringify({
        ...payload,
        ...adminConcurrency(concurrency),
      }),
    });
    setJobRunning(true);
    renderJob(job);
    ensurePolling();
    showToast(toastMessage);
  } catch (error) {
    showToast(error.message);
    if (lastJob) renderJob(lastJob);
  }
}

accounts.addEventListener('input', updateParseState);
toggleSecrets.addEventListener('click', () => {
  inputVisible = !inputVisible;
  accounts.classList.toggle('is-masked', !inputVisible);
  toggleSecrets.title = inputVisible ? '隐藏输入内容' : '显示输入内容';
  toggleSecrets.setAttribute('aria-label', toggleSecrets.title);
});

startButton.addEventListener('click', async () => {
  const parsed = localParse(accounts.value);
  if (!parsed.valid || parsed.errors.length) {
    updateParseState();
    return;
  }

  stopPolling();
  selectedAccountIndexes.clear();
  setJobRunning(true);
  sessionList.innerHTML = '<p class="session-empty">正在获取 Session…</p>';
  copyButton.disabled = true;
  downloadButton.disabled = true;
  exportExcelButton.disabled = true;
  if (queryAllPlansButton) queryAllPlansButton.disabled = true;
  if (cancelAllRenewalButton) cancelAllRenewalButton.disabled = true;
  statusSummary.textContent = '正在创建任务';

  try {
    const job = await request('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({
        input: accounts.value,
        ...adminConcurrency(concurrency),
      }),
    });
    rememberJob(job.id);
    renderJob(job);
    ensurePolling();
  } catch (error) {
    forgetJob();
    setJobRunning(false);
    statusSummary.textContent = '创建失败';
    showToast(error.message);
  }
});

cancelButton.addEventListener('click', async () => {
  if (!currentJobId) return;
  cancelButton.disabled = true;
  try {
    const job = await request(`/api/jobs/${currentJobId}/cancel`, { method: 'POST', body: '{}' });
    renderJob(job);
    showToast('已发送取消请求');
  } catch (error) {
    showToast(error.message);
  }
});

async function runBilling(path, payload, toastMessage) {
  if (!currentJobId) return;
  try {
    const job = await request(`/api/jobs/${currentJobId}/${path}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    renderJob(job);
    ensurePolling();
    if (toastMessage) showToast(toastMessage);
  } catch (error) {
    showToast(error.message);
    if (lastJob) renderJob(lastJob);
  }
}

queryAllPlansButton?.addEventListener('click', () => {
  const count = lastJob?.items.filter((item) => item.status === 'success').length || 0;
  if (!count) return;
  void runBilling('subscription', { all: true }, `正在查询 ${count} 个账号的套餐`);
});

cancelAllRenewalButton?.addEventListener('click', () => {
  const count = lastJob?.items.filter((item) => item.status === 'success').length || 0;
  if (!count) return;
  if (!window.confirm(`将对 ${count} 个已成功账号取消自动续费，确定继续？`)) return;
  void runBilling('cancel-renewal', { all: true }, `正在取消 ${count} 个账号的自动续费`);
});

sessionList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-billing]');
  if (!button || button.disabled) return;
  const index = Number(button.dataset.index);
  if (!Number.isInteger(index) || index < 0) return;
  if (button.dataset.billing === 'query') {
    void runBilling('subscription', { index }, '正在查询套餐');
    return;
  }
  if (button.dataset.billing === 'cancel') {
    void runBilling('cancel-renewal', { index }, '正在取消自动续费');
  }
});

copyButton.addEventListener('click', async () => {
  const value = Array.from(sessionList.querySelectorAll('code')).map((node) => node.textContent).join('\n');
  await copyText(value, 'Session 已全部复制');
});

copyFailedButton.addEventListener('click', async () => {
  const emails = failedItems().map((item) => item.email).join('\n');
  if (!emails) return;
  await copyText(emails, `已复制 ${failedItems().length} 个失败邮箱`);
});

retryFailedButton.addEventListener('click', async () => {
  const count = failedRetryableItems().length;
  if (!count) return;
  retryFailedButton.disabled = true;
  await retryAccounts({ failed: true }, `正在重试 ${count} 个失败账号`);
});

retrySelectedButton.addEventListener('click', async () => {
  const indexes = [...selectedAccountIndexes]
    .filter((index) => lastJob?.items.find((item) => item.index === index)?.canRetry)
    .sort((a, b) => a - b);
  if (!indexes.length) {
    showToast('请先勾选要重试的账号');
    return;
  }
  for (const index of indexes) selectedAccountIndexes.delete(index);
  retrySelectedButton.disabled = true;
  await retryAccounts({ indexes }, `正在重试 ${indexes.length} 个所选账号`);
});

selectAllAccounts.addEventListener('change', () => {
  const boxes = statusBody.querySelectorAll('[data-account-select]');
  for (const box of boxes) {
    box.checked = selectAllAccounts.checked;
    const index = Number(box.dataset.accountSelect);
    if (selectAllAccounts.checked) selectedAccountIndexes.add(index);
    else selectedAccountIndexes.delete(index);
  }
  syncRetrySelectedButton();
});

statusBody.addEventListener('change', (event) => {
  const box = event.target.closest('[data-account-select]');
  if (!box) return;
  const index = Number(box.dataset.accountSelect);
  if (box.checked) selectedAccountIndexes.add(index);
  else selectedAccountIndexes.delete(index);
  syncRetrySelectedButton();
  if (lastJob) {
    const visibleItems = statusFilter === 'failed'
      ? lastJob.items.filter((item) => item.status === 'failed' || item.status === 'cancelled')
      : lastJob.items;
    syncHeaderCheckbox(selectAllAccounts, selectedAccountIndexes, visibleItems);
  }
});

statusBody.addEventListener('click', async (event) => {
  if (event.target.closest('[data-account-select]')) return;
  const abortButton = event.target.closest('[data-abort-index]');
  if (abortButton && !abortButton.disabled) {
    const index = Number(abortButton.dataset.abortIndex);
    abortButton.disabled = true;
    abortButton.textContent = '终止中';
    try {
      const job = await request(`/api/jobs/${currentJobId}/abort`, {
        method: 'POST',
        body: JSON.stringify({ index }),
      });
      renderJob(job);
      ensurePolling();
      showToast('已发送终止请求，结束后可重试');
    } catch (error) {
      showToast(error.message);
      if (lastJob) renderJob(lastJob);
    }
    return;
  }
  const button = event.target.closest('[data-retry-index]');
  if (!button || button.disabled) return;
  const index = Number(button.dataset.retryIndex);
  button.disabled = true;
  await retryAccounts({ index }, '正在重试该账号');
});

document.querySelectorAll('#panel-session .filter-tab[data-filter]').forEach((button) => {
  button.addEventListener('click', () => {
    statusFilter = button.dataset.filter;
    document.querySelectorAll('#panel-session .filter-tab[data-filter]').forEach((tab) => tab.classList.toggle('is-active', tab === button));
    if (lastJob) renderJob(lastJob);
  });
});

downloadButton.addEventListener('click', () => {
  const value = Array.from(sessionList.querySelectorAll('code')).map((node) => node.textContent).join('\n');
  const blob = new Blob([`${value}\n`], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'sessions.txt';
  link.click();
  URL.revokeObjectURL(url);
});

exportExcelButton.addEventListener('click', () => {
  if (!lastJob?.items.length) return;
  const sessions = sessionByIndex(lastJob);
  const rows = [
    ['邮箱', 'GPT密码', '邮箱密码', 'session'],
    ...lastJob.items
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((item) => {
        const account = parseAccountDisplay(item);
        return [account.email, account.gptPassword, account.mailPassword, sessions.get(item.index) || ''];
      }),
  ];
  const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'sessions.csv';
  link.click();
  URL.revokeObjectURL(url);
  showToast('已导出 Excel（CSV）');
});

async function restoreJob() {
  let id = '';
  try { id = sessionStorage.getItem(JOB_STORAGE_KEY) || ''; } catch { return; }
  if (!id) return;
  currentJobId = id;
  try {
    const job = await request(`/api/jobs/${id}`);
    renderJob(job);
    if (job.status === 'running') {
      setJobRunning(true);
      ensurePolling();
    }
  } catch {
    forgetJob();
  }
}

window.addEventListener('beforeunload', stopPolling);
accounts.classList.add('is-masked');
updateParseState();

function bindFileImport(buttonId, fileId, textareaId, successMessage) {
  const button = document.querySelector(buttonId);
  const file = document.querySelector(fileId);
  const textarea = document.querySelector(textareaId);
  if (!button || !file || !textarea) return;
  button.addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const picked = file.files?.[0];
    file.value = '';
    if (!picked) return;
    textarea.value = `${textarea.value.trim()}\n${await picked.text()}`.trim();
    textarea.dispatchEvent(new Event('input'));
    showToast(successMessage);
  });
}

bindFileImport('#importAccounts', '#accountsFile', '#accounts', '已导入账号文件');
bindFileImport('#importProxies', '#proxiesFile', '#proxies', '已导入代理文件');
bindFileImport('#importCheck', '#checkFile', '#checkInput', '已导入 Token 文件');
bindFileImport('#importPwAccounts', '#pwAccountsFile', '#pwAccounts', '已导入账号文件');

let currentUser = null;

const USER_PANELS = new Set(['session', 'check', 'password', 'mfa', 'history', 'openapi']);

function canUsePanel(panel) {
  return currentUser?.role === 'admin' || USER_PANELS.has(panel);
}

function showPanel(panel) {
  // 无论是谁调的（标签点击、残留状态、控制台），越权的目标一律落回默认页
  const target = canUsePanel(panel) ? panel : 'session';
  document.querySelectorAll('.app-tab').forEach((tab) => {
    tab.classList.toggle('is-active', tab.dataset.panel === target);
  });
  document.querySelectorAll('.app-panel').forEach((node) => {
    node.hidden = node.dataset.panel !== target;
  });
}

function applyTabVisibility(user) {
  const isAdmin = user?.role === 'admin';
  document.querySelectorAll('.app-tab').forEach((tab) => {
    const allowed = isAdmin || USER_PANELS.has(tab.dataset.panel);
    tab.hidden = !allowed;
  });
  // 代理池和并发属于管理员配置，普通用户连入口都不该看到
  document.querySelectorAll('.app-panel [data-admin-only]').forEach((node) => {
    node.hidden = !isAdmin;
  });
  if (!isAdmin) {
    closeUserModal();
    if (typeof closeKeyModal === 'function') closeKeyModal();
  }
  const active = document.querySelector('.app-tab.is-active');
  if (!user || !active || active.hidden || !canUsePanel(active.dataset.panel)) showPanel('session');
}

const concurrencyInputs = [concurrency, document.querySelector('#checkConcurrency'), document.querySelector('#pwConcurrency')];

// 普通用户的并发数由管理员在「用户」页分配：输入框既看不到也点不动，更不会被提交
function applyConcurrencyQuota(user) {
  const isAdmin = user?.role === 'admin';
  for (const input of concurrencyInputs) {
    if (!input) continue;
    input.disabled = !isAdmin;
    if (!isAdmin) input.value = '';
    else if (user?.concurrency) input.value = String(user.concurrency);
  }
}

// 只有管理员能临时改并发；普通用户不带这个字段，服务端只认这个账号的并发配额
function adminConcurrency(input) {
  if (currentUser?.role !== 'admin') return {};
  const value = Number(input?.value);
  return Number.isInteger(value) && value > 0 ? { concurrency: value } : {};
}

function applyUser(user) {
  currentUser = user || null;
  const chip = document.querySelector('#userChip');
  if (!user) {
    chip.hidden = true;
    applyTabVisibility(null);
    applyConcurrencyQuota(null);
    return;
  }
  chip.hidden = false;
  chip.textContent = `${user.username} · ${user.role === 'admin' ? '管理员' : '普通用户'}`;
  applyTabVisibility(user);
  applyConcurrencyQuota(user);
  void loadKeys();
  void loadApiDocs();
  const scope = document.querySelector('#historyScope');
  if (scope) {
    scope.textContent = user.role === 'admin'
      ? '任务结束后自动归档，管理员可以看到所有人的记录。归档只存结果，不存密码。'
      : '任务结束后自动归档，这里只显示你自己跑过的记录。归档只存结果，不存密码。';
  }
}

const historyBody = document.querySelector('#historyBody');
const historyDetailBody = document.querySelector('#historyDetailBody');
const historyState = { kind: '', q: '', page: 1, pageSize: 20, total: 0 };
const historyDetailState = { items: [], sessions: [], filter: 'all', q: '' };
let historySearchTimer = null;

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

function formatWhen(value) {
  if (!value) return '—';
  const date = new Date(value);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const time = date.toLocaleTimeString('zh-CN', { hour12: false });
  return sameDay ? `今天 ${time}` : `${date.toLocaleDateString('zh-CN')} ${time}`;
}

function renderHistoryPager() {
  const pages = Math.max(1, Math.ceil(historyState.total / historyState.pageSize));
  document.querySelector('#historyPage').textContent = `${historyState.page} / ${pages}`;
  document.querySelector('#historyPrev').disabled = historyState.page <= 1;
  document.querySelector('#historyNext').disabled = historyState.page >= pages;
  document.querySelector('#historyCount').textContent = historyState.total
    ? `共 ${historyState.total} 条${historyState.q ? '（已按关键词过滤）' : ''}`
    : '暂无记录';
}

async function loadHistory() {
  if (!historyBody) return;
  const params = new URLSearchParams({
    page: String(historyState.page),
    pageSize: String(historyState.pageSize),
  });
  if (historyState.kind) params.set('kind', historyState.kind);
  if (historyState.q) params.set('q', historyState.q);

  try {
    const data = await request(`/api/history?${params}`);
    historyState.total = data.total || 0;
    const items = data.items || [];
    if (!items.length) {
      const message = !data.persistEnabled
        ? '当前未开启归档目录（PERSIST_DIR），任务结果不会保存。'
        : historyState.q || historyState.kind
          ? '没有匹配的记录，换个关键词试试。'
          : '还没有归档记录，跑完一次任务就会出现在这里。';
      historyBody.innerHTML = `<tr class="empty-row"><td colspan="6">${message}</td></tr>`;
    } else {
      historyBody.innerHTML = items.map((item) => `
      <tr>
        <td>${escapeHtml(item.kind === 'check' ? '验活' : item.kind === 'password' ? '添加密码' : '取 Session')}</td>
        <td>${escapeHtml(item.owner || '—')}</td>
        <td class="nowrap-cell" title="${escapeHtml(item.finishedAt ? new Date(item.finishedAt).toLocaleString('zh-CN', { hour12: false }) : '')}">${escapeHtml(formatWhen(item.finishedAt))}</td>
        <td>${formatResultTags(item)}${item.status === 'cancelled' ? ' <span class="status-pill status-cancelled">已取消</span>' : ''}</td>
        <td>${item.accounts || 0}</td>
        <td><button class="retry-button" type="button" data-history-file="${escapeHtml(item.file)}">查看</button></td>
      </tr>`).join('');
    }
    renderHistoryPager();
  } catch {
    historyBody.innerHTML = '<tr class="empty-row"><td colspan="6">读取归档失败。</td></tr>';
  }
}

function renderHistoryDetail() {
  const needle = historyDetailState.q.trim().toLowerCase();
  const rows = historyDetailState.items.filter((item) => {
    const bad = item.status === 'failed' || item.status === 'cancelled' || item.reason && item.reason !== 'ok';
    if (historyDetailState.filter === 'bad' && !bad) return false;
    return !needle || String(item.email || '').toLowerCase().includes(needle);
  });

  historyDetailBody.innerHTML = rows.length
    ? rows.map((item) => `
      <tr>
        <td>${escapeHtml(item.email || '—')}</td>
        <td><span class="status-pill status-${escapeHtml(item.status || 'pending')}">${escapeHtml(statusLabels[item.status] || item.status || '—')}</span></td>
        <td>${escapeHtml((item.plan || '—').toUpperCase())}</td>
        <td class="error-cell">${escapeHtml(item.error || checkReasonLabels[item.reason] || item.reason || '—')}</td>
      </tr>`).join('')
    : `<tr class="empty-row"><td colspan="4">${historyDetailState.items.length ? '没有匹配的账号。' : '这次任务没有账号明细。'}</td></tr>`;
}

async function showHistoryDetail(file) {
  const band = document.querySelector('#historyDetailBand');
  try {
    const detail = await request(`/api/history/${encodeURIComponent(file)}`);
    const when = detail.finishedAt ? new Date(detail.finishedAt).toLocaleString('zh-CN', { hour12: false }) : '';
    document.querySelector('#historyDetailTitle').textContent =
      `${detail.kind === 'check' ? '验活' : detail.kind === 'password' ? '添加密码' : '取 Session'} · ${detail.owner || '—'}${when ? ` · ${when}` : ''}`;
    historyDetailState.items = detail.items || [];
    historyDetailState.sessions = detail.sessions || [];
    historyDetailState.q = '';
    historyDetailState.filter = 'all';
    document.querySelector('#historyDetailSearch').value = '';
    document.querySelectorAll('[data-detail-filter]').forEach((tab) => {
      tab.classList.toggle('is-active', tab.dataset.detailFilter === 'all');
    });
    document.querySelector('#historyCopySessions').disabled = historyDetailState.sessions.length === 0;
    renderHistoryDetail();
    band.hidden = false;
    band.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    showToast(error.message);
  }
}

document.querySelector('#historyRefresh')?.addEventListener('click', () => {
  void loadHistory();
  showToast('已刷新归档列表');
});

document.querySelector('#historySearch')?.addEventListener('input', (event) => {
  clearTimeout(historySearchTimer);
  const value = event.target.value;
  historySearchTimer = setTimeout(() => {
    historyState.q = value.trim();
    historyState.page = 1;
    void loadHistory();
  }, 250);
});

document.querySelectorAll('[data-history-kind]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-history-kind]').forEach((tab) => tab.classList.toggle('is-active', tab === button));
    historyState.kind = button.dataset.historyKind;
    historyState.page = 1;
    void loadHistory();
  });
});

document.querySelector('#historyPrev')?.addEventListener('click', () => {
  if (historyState.page <= 1) return;
  historyState.page -= 1;
  void loadHistory();
});

document.querySelector('#historyNext')?.addEventListener('click', () => {
  historyState.page += 1;
  void loadHistory();
});

historyBody?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-history-file]');
  if (!button) return;
  void showHistoryDetail(button.dataset.historyFile);
});

document.querySelector('#historyDetailSearch')?.addEventListener('input', (event) => {
  historyDetailState.q = event.target.value;
  renderHistoryDetail();
});

document.querySelectorAll('[data-detail-filter]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-detail-filter]').forEach((tab) => tab.classList.toggle('is-active', tab === button));
    historyDetailState.filter = button.dataset.detailFilter;
    renderHistoryDetail();
  });
});

document.querySelector('#historyCloseDetail')?.addEventListener('click', () => {
  document.querySelector('#historyDetailBand').hidden = true;
});

document.querySelector('#historyCopySessions')?.addEventListener('click', async () => {
  if (!historyDetailState.sessions.length) return;
  await copyText(historyDetailState.sessions.join('\n'), `已复制 ${historyDetailState.sessions.length} 条 Session`);
});

let concurrencyLimit = 20;

async function loadUsers() {
  if (currentUser?.role !== 'admin') return;
  const body = document.querySelector('#usersBody');
  const data = await request('/api/users');
  concurrencyLimit = data.concurrencyLimit || concurrencyLimit;
  const newUserConcurrency = document.querySelector('#newUserConcurrency');
  if (newUserConcurrency) newUserConcurrency.max = String(concurrencyLimit);
  const rateCeiling = data.rateLimitCeiling || 60;
  body.innerHTML = (data.users || []).map((user) => `
    <tr>
      <td>${escapeHtml(user.username)}</td>
      <td>${user.role === 'admin' ? '管理员' : '普通用户'}</td>
      <td>
        <div class="quota-cell">
          <input type="number" min="1" max="${concurrencyLimit}" step="1" value="${user.concurrency}"
            data-quota-for="${escapeHtml(user.username)}" aria-label="${escapeHtml(user.username)} 的并发数">
        </div>
      </td>
      <td>
        <div class="quota-cell">
          <input type="number" min="1" max="${user.role === 'admin' ? 6000 : rateCeiling}" step="1" value="${user.apiRateLimit || rateCeiling}"
            data-rate-for="${escapeHtml(user.username)}" aria-label="${escapeHtml(user.username)} 的每分钟请求数">
          <button class="retry-button" type="button" data-save-quota="${escapeHtml(user.username)}">保存</button>
        </div>
      </td>
      <td><button class="retry-button" type="button" data-delete-user="${escapeHtml(user.username)}">删除</button></td>
    </tr>`).join('');
}

async function loadKeys() {
  if (!currentUser) return;
  const body = document.querySelector('#keysBody');
  const head = document.querySelector('#keysHead');
  if (!body) return;
  const data = await request('/api/apikeys');
  const isAdmin = currentUser.role === 'admin';
  const keyConcurrencyCap = data.concurrencyLimit || currentUser.concurrency || 1;
  const newKeyConcurrency = document.querySelector('#newKeyConcurrency');
  if (newKeyConcurrency) {
    newKeyConcurrency.max = String(keyConcurrencyCap);
    if (Number(newKeyConcurrency.value) > keyConcurrencyCap) newKeyConcurrency.value = String(keyConcurrencyCap);
  }
  const myRate = document.querySelector('#myRateLimit');
  const myRateHint = document.querySelector('#myRateHint');
  if (myRate) {
    const personalCap = isAdmin ? 6000 : data.rateLimitPerMinute;
    myRate.max = String(personalCap);
    myRate.value = String(Math.min(data.myRateLimit || data.rateLimitPerMinute, personalCap));
  }
  if (myRateHint) {
    myRateHint.textContent = isAdmin
      ? '管理员可单独设置，不受每用户上限限制'
      : `不能超过每用户上限 ${data.rateLimitPerMinute} 次/分钟`;
  }
  const note = document.querySelector('#keyQuotaNote');
  if (note) {
    note.textContent = `每名用户最多 ${data.maxKeysPerUser} 把密钥。你当前 ${data.myRateLimit} 次/分钟。完整密钥只显示一次，不要共用。`;
  }
  if (head) {
    head.innerHTML = isAdmin
      ? '<tr><th>归属</th><th>名称</th><th>前缀</th><th>并发数</th><th>操作</th></tr>'
      : '<tr><th>名称</th><th>前缀</th><th>并发数</th><th>操作</th></tr>';
  }
  const rows = data.keys || [];
  body.innerHTML = rows.map((key) => {
    const quota = `<div class="quota-cell">
          <input type="number" min="1" max="${keyConcurrencyCap}" step="1" value="${key.concurrency}"
            data-key-quota-for="${escapeHtml(key.id)}" aria-label="${escapeHtml(key.name)} 的并发数">
          <button class="retry-button" type="button" data-save-key-quota="${escapeHtml(key.id)}">保存</button>
        </div>`;
    const owner = isAdmin ? `<td>${escapeHtml(key.owner)}</td>` : '';
    return `<tr>
      ${owner}
      <td>${escapeHtml(key.name)}${key.source === 'env' ? ' <small>环境变量</small>' : ''}</td>
      <td><code>${escapeHtml(key.prefix)}…</code></td>
      <td>${quota}</td>
      <td><button class="retry-button" type="button" data-revoke-key="${escapeHtml(key.id)}">撤销</button></td>
    </tr>`;
  }).join('') || `<tr><td colspan="${isAdmin ? 5 : 4}">还没有密钥。点右上角创建一把，配给自己的 CDK。</td></tr>`;
}

async function loadApiDocs() {
  const root = document.querySelector('#apiDocs');
  if (!root || !currentUser) return;
  const spec = await request('/api/openapi/docs');
  root.innerHTML = (spec.endpoints || []).map((item) => `
    <article class="api-card">
      <header>
        <span class="api-method api-method-${escapeHtml(item.method.toLowerCase())}">${escapeHtml(item.method)}</span>
        <code class="api-path">${escapeHtml(item.path)}</code>
        ${item.auth ? '<span class="api-auth">需要密钥</span>' : '<span class="api-auth is-public">无需密钥</span>'}
      </header>
      <p>${escapeHtml(item.summary)}</p>
      ${item.body ? `<pre class="api-sample">${escapeHtml(JSON.stringify(item.body, null, 2))}</pre>` : ''}
      <button class="icon-text-button" type="button" data-copy-api="${escapeHtml(item.id)}">复制 curl</button>
    </article>
  `).join('');
  root.dataset.spec = JSON.stringify(spec);
}

const proxies = document.querySelector('#proxies');
const proxyCount = document.querySelector('#proxyCount');
const proxyErrors = document.querySelector('#proxyErrors');

function countProxyLines(text) {
  return text.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#')).length;
}

function updateProxyCount() {
  const total = countProxyLines(proxies?.value || '');
  if (proxyCount) proxyCount.textContent = total ? `${total} 条代理，将随机分配` : '0 条代理，将使用直连';
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

function renderProxyList() {
  const body = document.querySelector('#proxyList');
  if (!body) return;
  const lines = (proxies?.value || '').split(/\r?\n/).filter((line) => line.trim());
  body.innerHTML = lines.map((line, index) => `
    <tr>
      <td><code>${escapeHtml(maskProxy(line))}</code></td>
      <td><button class="retry-button" type="button" data-remove-proxy="${index}">删除</button></td>
    </tr>
  `).join('') || '<tr><td colspan="2">还没有代理。点「添加代理」或导入文件。</td></tr>';
  updateProxyCount();
}

function setProxyText(text) {
  if (proxies) proxies.value = normalizeProxyText(text);
  renderProxyList();
}

// 粘贴的代理格式五花八门，统一成每行一条，顺手补协议并去重
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

function applySettings(settings) {
  if (!proxies) return;
  proxies.value = settings.proxyText || '';
  concurrencyLimit = settings.concurrencyLimit || concurrencyLimit;
  for (const input of [...concurrencyInputs, document.querySelector('#newUserConcurrency')]) {
    if (input) input.max = String(concurrencyLimit);
  }
  document.querySelector('#concurrencyLimit').textContent = String(concurrencyLimit);
  document.querySelector('#statConcurrencyLimit').textContent = String(concurrencyLimit);
  document.querySelector('#statProxyCount').textContent = String(settings.proxyCount);
  document.querySelector('#statProxyMode').textContent = settings.proxyCount ? '代理池' : '直连';
  const maxApiKeys = document.querySelector('#maxApiKeys');
  const apiRateLimit = document.querySelector('#apiRateLimit');
  if (maxApiKeys && settings.maxApiKeys) maxApiKeys.value = String(settings.maxApiKeys);
  if (apiRateLimit && settings.apiRateLimit) apiRateLimit.value = String(settings.apiRateLimit);
  const adminRateLimit = document.querySelector('#adminRateLimit');
  if (adminRateLimit) adminRateLimit.value = String(currentUser?.apiRateLimit || settings.apiRateLimit || 60);
  const newUserRate = document.querySelector('#newUserRateLimit');
  if (newUserRate && settings.apiRateLimit) {
    newUserRate.max = String(settings.apiRateLimit);
    newUserRate.value = String(settings.apiRateLimit);
  }
  const newUserRateHint = document.querySelector('#newUserRateHint');
  if (newUserRateHint && settings.apiRateLimit) {
    newUserRateHint.textContent = `不能超过每用户上限 ${settings.apiRateLimit}`;
  }
  renderProxyList();
  const sessionNote = document.querySelector('#sessionRuntimeNote');
  const checkNote = document.querySelector('#checkRuntimeNote');
  const proxyHint = settings.proxyCount ? `代理池 ${settings.proxyCount} 条` : '当前直连';
  const quotaHint = `本账号并发配额 ${currentUser?.concurrency || 1}`;
  if (sessionNote) sessionNote.textContent = `${proxyHint}，${quotaHint}，这里可临时调整。`;
  if (checkNote) checkNote.textContent = `${proxyHint}，${quotaHint}，这里可临时调整。`;
  updateProxyCount();
  if (proxyErrors) proxyErrors.textContent = '';
}

async function loadSettings() {
  if (currentUser?.role !== 'admin') return;
  try {
    applySettings(await request('/api/settings'));
  } catch (error) {
    showToast(error.message);
  }
}

document.querySelector('#saveSettings')?.addEventListener('click', async () => {
  const button = document.querySelector('#saveSettings');
  button.disabled = true;
  try {
    const result = await request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        proxies: proxies.value,
        maxApiKeys: Number(document.querySelector('#maxApiKeys')?.value),
        apiRateLimit: Number(document.querySelector('#apiRateLimit')?.value),
      }),
    });
    applySettings(result.settings);
    const adminRate = Number(document.querySelector('#adminRateLimit')?.value);
    if (Number.isInteger(adminRate) && adminRate > 0) {
      const me = await request('/api/me', {
        method: 'PUT',
        body: JSON.stringify({ apiRateLimit: adminRate }),
      });
      currentUser = { ...currentUser, ...me.user };
      const adminRateLimit = document.querySelector('#adminRateLimit');
      if (adminRateLimit) adminRateLimit.value = String(me.user.apiRateLimit);
    }
    showToast(result.notes?.length ? result.notes.join('；') : '配置已保存');
  } catch (error) {
    proxyErrors.textContent = error.message;
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#reloadSettings')?.addEventListener('click', () => {
  void loadSettings();
  showToast('已恢复为服务器上的配置');
});

document.querySelector('#proxyClear')?.addEventListener('click', () => {
  setProxyText('');
  showToast('已清空列表，记得保存才会生效');
});

proxies?.addEventListener('input', renderProxyList);

const proxyModal = document.querySelector('#proxyModal');
const proxyModalInput = document.querySelector('#proxyModalInput');
const proxyModalErrors = document.querySelector('#proxyModalErrors');

function openProxyModal() {
  if (proxyModalErrors) proxyModalErrors.textContent = '';
  if (proxyModalInput) proxyModalInput.value = '';
  if (proxyModal) proxyModal.hidden = false;
  proxyModalInput?.focus();
}

function closeProxyModal() {
  if (proxyModal) proxyModal.hidden = true;
}

document.querySelector('#openProxyModal')?.addEventListener('click', openProxyModal);
document.querySelector('#closeProxyModal')?.addEventListener('click', closeProxyModal);
document.querySelector('#cancelProxyModal')?.addEventListener('click', closeProxyModal);
proxyModal?.addEventListener('click', (event) => {
  if (event.target.closest('[data-modal-dismiss]')) closeProxyModal();
});

document.querySelector('#confirmProxyModal')?.addEventListener('click', () => {
  const added = normalizeProxyText(proxyModalInput?.value || '');
  if (!added) {
    if (proxyModalErrors) proxyModalErrors.textContent = '请先填写或导入至少一条代理';
    return;
  }
  setProxyText(`${proxies.value}\n${added}`);
  closeProxyModal();
  showToast(`已加入 ${countProxyLines(added)} 条，记得保存配置`);
});

bindFileImport('#importProxyModalFile', '#proxyModalFile', '#proxyModalInput', '已导入到弹窗，确认后才会加入列表');

document.querySelector('#proxyList')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-proxy]');
  if (!button || !proxies) return;
  const index = Number(button.dataset.removeProxy);
  const lines = proxies.value.split(/\r?\n/).filter((line) => line.trim());
  lines.splice(index, 1);
  setProxyText(lines.join('\n'));
  showToast('已从列表移除，记得保存配置');
});

function goToLogin() {
  window.location.replace('/login');
}

async function bootAuth() {
  const logoutButton = document.querySelector('#logoutButton');
  try {
    const meta = await request('/api/meta');
    document.querySelector('#privacyText').textContent = meta.persistEnabled ? '结果会写入服务器目录' : '不保存数据';
    document.querySelector('#privacyMark').title = meta.persistEnabled
      ? '已启用 PERSIST_DIR，任务结束后会归档成功结果（不含密码）'
      : '输入和结果仅保留在当前进程内存中';
    if (!meta.authRequired) {
      logoutButton.hidden = true;
      applyUser({ username: 'local', role: 'admin' });
      dropForeignJob('local');
      void restoreJob();
      void restorePwJob();
      void loadHistory();
      void loadSettings();
      return;
    }
    const status = await request('/api/auth/status');
    if (!status.authorized) {
      goToLogin();
      return;
    }
    applyUser(status.user);
    logoutButton.hidden = false;
    dropForeignJob(status.user.username);
    void restoreJob();
    void restorePwJob();
    void loadHistory();
    if (status.user?.role === 'admin') {
      void loadUsers();
      void loadSettings();
    }
  } catch {
    goToLogin();
  }
}

document.querySelector('#logoutButton').addEventListener('click', async () => {
  try { await request('/api/auth/logout', { method: 'POST', body: '{}' }); } catch { /* ignore */ }
  forgetJob();
  forgetPwJob();
  goToLogin();
});

document.querySelector('#generateUserPassword')?.addEventListener('click', () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const password = Array.from({ length: 10 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  const field = document.querySelector('#newUserPassword');
  field.type = 'text';
  field.value = password;
  void copyText(password, `已生成口令并复制：${password}`);
});

const userModal = document.querySelector('#userModal');
const userFormErrors = document.querySelector('#userFormErrors');

function openUserModal() {
  if (!userModal || currentUser?.role !== 'admin') return;
  userFormErrors.textContent = '';
  document.querySelector('#newUsername').value = '';
  const password = document.querySelector('#newUserPassword');
  password.type = 'password';
  password.value = '';
  document.querySelector('#newUserRole').value = 'user';
  document.querySelector('#newUserConcurrency').value = '1';
  const rateField = document.querySelector('#newUserRateLimit');
  const ceiling = Number(document.querySelector('#apiRateLimit')?.value) || 60;
  if (rateField) {
    rateField.max = String(ceiling);
    rateField.value = String(ceiling);
  }
  userModal.hidden = false;
  document.querySelector('#newUsername').focus();
}

function closeUserModal() {
  if (userModal) userModal.hidden = true;
}

document.querySelector('#openUserModal')?.addEventListener('click', openUserModal);
document.querySelector('#closeUserModal')?.addEventListener('click', closeUserModal);
document.querySelector('#cancelUserModal')?.addEventListener('click', closeUserModal);

userModal?.addEventListener('click', (event) => {
  if (event.target.closest('[data-modal-dismiss]')) closeUserModal();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && userModal && !userModal.hidden) closeUserModal();
  if (event.key === 'Escape' && keyModal && !keyModal.hidden) closeKeyModal();
  if (event.key === 'Escape' && proxyModal && !proxyModal.hidden) closeProxyModal();
});

function readQuota(input) {
  const value = Number(input?.value);
  if (!Number.isInteger(value) || value < 1 || value > concurrencyLimit) {
    return { error: `并发数必须是 1 到 ${concurrencyLimit} 之间的整数` };
  }
  return { value };
}

document.querySelector('#createUserButton')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const quota = readQuota(document.querySelector('#newUserConcurrency'));
  if (quota.error) {
    userFormErrors.textContent = quota.error;
    return;
  }
  userFormErrors.textContent = '';
  button.disabled = true;
  try {
    await request('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username: document.querySelector('#newUsername').value,
        password: document.querySelector('#newUserPassword').value,
        role: document.querySelector('#newUserRole').value,
        concurrency: quota.value,
        apiRateLimit: Number(document.querySelector('#newUserRateLimit')?.value),
      }),
    });
    closeUserModal();
    showToast('用户已创建');
    await loadUsers();
  } catch (error) {
    userFormErrors.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#usersBody')?.addEventListener('click', async (event) => {
  const save = event.target.closest('[data-save-quota]');
  if (save) {
    const username = save.dataset.saveQuota;
    const quota = readQuota(document.querySelector(`[data-quota-for="${CSS.escape(username)}"]`));
    const rateInput = document.querySelector(`[data-rate-for="${CSS.escape(username)}"]`);
    const rate = Number(rateInput?.value);
    if (quota.error) {
      showToast(quota.error);
      return;
    }
    if (!Number.isInteger(rate) || rate < 1) {
      showToast('每分钟请求数必须是正整数');
      return;
    }
    save.disabled = true;
    try {
      await request(`/api/users/${encodeURIComponent(username)}`, {
        method: 'PUT',
        body: JSON.stringify({ concurrency: quota.value, apiRateLimit: rate }),
      });
      showToast(`${username} 已保存：并发 ${quota.value}，${rate} 次/分钟`);
      if (username === currentUser?.username) {
        currentUser = { ...currentUser, concurrency: quota.value, apiRateLimit: rate };
        applyConcurrencyQuota(currentUser);
      }
      await loadUsers();
    } catch (error) {
      showToast(error.message);
    } finally {
      save.disabled = false;
    }
    return;
  }

  const button = event.target.closest('[data-delete-user]');
  if (!button) return;
  try {
    await request(`/api/users/${encodeURIComponent(button.dataset.deleteUser)}`, { method: 'DELETE' });
    showToast('用户已删除');
    await loadUsers();
  } catch (error) {
    showToast(error.message);
  }
});

const keyModal = document.querySelector('#keyModal');
const keyFormErrors = document.querySelector('#keyFormErrors');
const createdKeyBox = document.querySelector('#createdKeyBox');
const createdKeyValue = document.querySelector('#createdKeyValue');
const createKeyButton = document.querySelector('#createKeyButton');
const copyCreatedKey = document.querySelector('#copyCreatedKey');

function resetKeyModal() {
  if (keyFormErrors) keyFormErrors.textContent = '';
  if (createdKeyBox) createdKeyBox.hidden = true;
  if (createdKeyValue) createdKeyValue.value = '';
  if (createKeyButton) createKeyButton.hidden = false;
  if (copyCreatedKey) copyCreatedKey.hidden = true;
  const name = document.querySelector('#newKeyName');
  if (name) name.value = '';
  const quota = document.querySelector('#newKeyConcurrency');
  if (quota) quota.value = String(currentUser?.concurrency || 1);
}

function openKeyModal() {
  resetKeyModal();
  if (keyModal) keyModal.hidden = false;
  document.querySelector('#newKeyName')?.focus();
}

function closeKeyModal() {
  if (keyModal) keyModal.hidden = true;
  resetKeyModal();
}

document.querySelector('#openKeyModal')?.addEventListener('click', openKeyModal);
document.querySelector('#closeKeyModal')?.addEventListener('click', closeKeyModal);
document.querySelector('#cancelKeyModal')?.addEventListener('click', closeKeyModal);
keyModal?.addEventListener('click', (event) => {
  if (event.target.closest('[data-modal-dismiss]')) closeKeyModal();
});

createKeyButton?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const payload = { name: document.querySelector('#newKeyName').value };
  const quota = readQuota(document.querySelector('#newKeyConcurrency'));
  if (quota.error) {
    keyFormErrors.textContent = quota.error;
    return;
  }
  payload.concurrency = quota.value;
  keyFormErrors.textContent = '';
  button.disabled = true;
  try {
    const result = await request('/api/apikeys', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (createdKeyBox) createdKeyBox.hidden = false;
    if (createdKeyValue) createdKeyValue.value = result.key || '';
    button.hidden = true;
    if (copyCreatedKey) copyCreatedKey.hidden = false;
    showToast('密钥已创建，请立即复制');
    await loadKeys();
  } catch (error) {
    keyFormErrors.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#saveMyRate')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const value = Number(document.querySelector('#myRateLimit')?.value);
  if (!Number.isInteger(value) || value < 1) {
    showToast('每分钟请求数必须是正整数');
    return;
  }
  button.disabled = true;
  try {
    const result = await request('/api/me', {
      method: 'PUT',
      body: JSON.stringify({ apiRateLimit: value }),
    });
    currentUser = { ...currentUser, ...result.user };
    showToast(`已设为每分钟 ${result.user.apiRateLimit} 次（上限 ${result.rateLimitCeiling}）`);
    await loadKeys();
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});

copyCreatedKey?.addEventListener('click', async () => {
  if (!createdKeyValue?.value) return;
  await copyText(createdKeyValue.value, '已复制 API Key');
});

document.querySelector('#apiDocs')?.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy-api]');
  if (!button) return;
  const spec = JSON.parse(document.querySelector('#apiDocs').dataset.spec || '{}');
  const item = (spec.endpoints || []).find((entry) => entry.id === button.dataset.copyApi);
  if (!item) return;
  const origin = window.location.origin;
  const curl = item.method === 'GET'
    ? `curl -sS "${origin}${item.path}" -H "Authorization: Bearer YOUR_API_KEY"`
    : `curl -sS "${origin}${item.path}" -H "Authorization: Bearer YOUR_API_KEY" -H "Content-Type: application/json"${item.body ? ` -d '${JSON.stringify(item.body)}'` : ''}`;
  await copyText(curl, `已复制 ${item.method} ${item.path}`);
});

document.querySelector('#keysBody')?.addEventListener('click', async (event) => {
  const save = event.target.closest('[data-save-key-quota]');
  if (save) {
    const id = save.dataset.saveKeyQuota;
    const quota = readQuota(document.querySelector(`[data-key-quota-for="${CSS.escape(id)}"]`));
    if (quota.error) {
      showToast(quota.error);
      return;
    }
    save.disabled = true;
    try {
      await request(`/api/apikeys/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify({ concurrency: quota.value }),
      });
      showToast(`并发数已改为 ${quota.value}`);
      await loadKeys();
    } catch (error) {
      showToast(error.message);
    } finally {
      save.disabled = false;
    }
    return;
  }

  const revoke = event.target.closest('[data-revoke-key]');
  if (!revoke) return;
  try {
    await request(`/api/apikeys/${encodeURIComponent(revoke.dataset.revokeKey)}`, { method: 'DELETE' });
    showToast('密钥已撤销');
    await loadKeys();
  } catch (error) {
    showToast(error.message);
  }
});

const THEME_STORAGE_KEY = 'acc-core:theme';

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('#themeLabel').textContent = theme === 'light' ? '白天' : '夜间';
  document.querySelector('#themeToggle').title = theme === 'light' ? '切换到夜间外观' : '切换到白天外观';
}

applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

document.querySelector('#themeToggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  localStorage.setItem(THEME_STORAGE_KEY, next);
  applyTheme(next);
});

void bootAuth();

document.querySelectorAll('.app-tab').forEach((button) => {
  button.addEventListener('click', () => {
    if (button.hidden) return;
    showPanel(button.dataset.panel);
  });
});

const checkReasonLabels = {
  ok: '有效',
  token_expired: '已过期',
  token_invalidated: '已被撤销',
  banned: '封号/停用',
  cf_blocked: 'CF/代理拦截',
  proxy_down: '代理异常',
  network: '网络错误',
  no_token: '无 Token',
  error: '失败',
};

let checkJobId = null;
let checkPollTimer = null;
let lastCheckJob = null;
const selectedCheckIndexes = new Set();
const checkRetrySelected = document.querySelector('#checkRetrySelected');
const selectAllChecks = document.querySelector('#selectAllChecks');

function syncCheckRetrySelected() {
  const count = selectedCheckIndexes.size;
  checkRetrySelected.disabled = count === 0;
  checkRetrySelected.textContent = count ? `重试所选（${count}）` : '重试所选';
}

function renderCheckJob(job) {
  lastCheckJob = job;
  document.querySelector('#checkTotal').textContent = job.counts.total;
  document.querySelector('#checkRunning').textContent = job.counts.running;
  document.querySelector('#checkAlive').textContent = job.counts.alive;
  document.querySelector('#checkDead').textContent = job.counts.dead;
  document.querySelector('#checkRetryFailed').disabled = !job.items.some((item) => item.canRetry);
  document.querySelector('#checkBody').innerHTML = job.items.length
    ? job.items.map((item) => {
      if (!item.canRetry) selectedCheckIndexes.delete(item.index);
      return `
      <tr>
        <td class="select-col">${item.canRetry
          ? `<input type="checkbox" data-check-select="${item.index}" ${selectedCheckIndexes.has(item.index) ? 'checked' : ''} aria-label="选择 ${escapeHtml(item.email || `Token #${item.index + 1}`)}">`
          : ''}</td>
        <td>${escapeHtml(item.email || `Token #${item.index + 1}`)}</td>
        <td><span class="status-pill ${item.alive ? 'status-success' : item.status === 'running' ? 'status-running' : 'status-failed'}">${
          item.status === 'running' || item.status === 'pending'
            ? (statusLabels[item.status] || item.status)
            : (item.alive ? '有效' : '失效')
        }</span></td>
        <td>${escapeHtml((item.plan || '—').toUpperCase())}</td>
        <td class="error-cell">${escapeHtml((() => {
          const label = checkReasonLabels[item.reason] || item.reason || '';
          if (item.alive || !item.error) return label || '—';
          if (!label || label === item.error) return item.error;
          return `${label}：${item.error}`;
        })())}</td>
        <td>${item.canRetry ? `<button class="retry-button" type="button" data-check-retry="${item.index}">重试</button>` : '—'}</td>
      </tr>`;
    }).join('')
    : '<tr class="empty-row"><td colspan="6">开始验活后，这里会显示每条结果。</td></tr>';
  syncCheckRetrySelected();
  syncHeaderCheckbox(selectAllChecks, selectedCheckIndexes, job.items);
}

async function pollCheck() {
  checkPollTimer = null;
  if (!checkJobId) return;
  try {
    const job = await request(`/api/checks/${checkJobId}`);
    renderCheckJob(job);
    if (job.status === 'running') {
      document.querySelector('#checkCancel').disabled = false;
      checkPollTimer = setTimeout(pollCheck, 800);
    } else {
      document.querySelector('#checkCancel').disabled = true;
      document.querySelector('#checkStart').disabled = false;
      showToast(`验活完成：有效 ${job.counts.alive}，失效 ${job.counts.dead}`);
      void loadHistory();
    }
  } catch (error) {
    document.querySelector('#checkStart').disabled = false;
    showToast(error.message);
  }
}

document.querySelector('#checkInput').addEventListener('input', () => {
  const count = document.querySelector('#checkInput').value.split(/\r?\n/).filter((line) => line.trim()).length;
  document.querySelector('#checkParseCount').textContent = `${count} 条输入`;
});

document.querySelector('#checkStart').addEventListener('click', async () => {
  document.querySelector('#checkStart').disabled = true;
  selectedCheckIndexes.clear();
  try {
    const job = await request('/api/checks', {
      method: 'POST',
      body: JSON.stringify({
        input: document.querySelector('#checkInput').value,
        ...adminConcurrency(document.querySelector('#checkConcurrency')),
      }),
    });
    checkJobId = job.id;
    renderCheckJob(job);
    document.querySelector('#checkCancel').disabled = false;
    checkPollTimer = setTimeout(pollCheck, 400);
  } catch (error) {
    document.querySelector('#checkStart').disabled = false;
    showToast(error.message);
  }
});

document.querySelector('#checkCancel').addEventListener('click', async () => {
  if (!checkJobId) return;
  try {
    const job = await request(`/api/checks/${checkJobId}/cancel`, { method: 'POST', body: '{}' });
    renderCheckJob(job);
    showToast('已发送取消请求');
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector('#checkRetryFailed').addEventListener('click', async () => {
  if (!checkJobId) return;
  try {
    const job = await request(`/api/checks/${checkJobId}/retry`, { method: 'POST', body: JSON.stringify({ failed: true, ...adminConcurrency(document.querySelector('#checkConcurrency')) }) });
    document.querySelector('#checkStart').disabled = true;
    document.querySelector('#checkCancel').disabled = false;
    renderCheckJob(job);
    if (!checkPollTimer) checkPollTimer = setTimeout(pollCheck, 400);
  } catch (error) {
    showToast(error.message);
  }
});

checkRetrySelected.addEventListener('click', async () => {
  if (!checkJobId) return;
  const indexes = [...selectedCheckIndexes]
    .filter((index) => lastCheckJob?.items.find((item) => item.index === index)?.canRetry)
    .sort((a, b) => a - b);
  if (!indexes.length) {
    showToast('请先勾选要重试的账号');
    return;
  }
  for (const index of indexes) selectedCheckIndexes.delete(index);
  checkRetrySelected.disabled = true;
  try {
    const job = await request(`/api/checks/${checkJobId}/retry`, { method: 'POST', body: JSON.stringify({ indexes, ...adminConcurrency(document.querySelector('#checkConcurrency')) }) });
    document.querySelector('#checkStart').disabled = true;
    document.querySelector('#checkCancel').disabled = false;
    renderCheckJob(job);
    if (!checkPollTimer) checkPollTimer = setTimeout(pollCheck, 400);
    showToast(`正在重试 ${indexes.length} 个所选账号`);
  } catch (error) {
    showToast(error.message);
  }
});

selectAllChecks.addEventListener('change', () => {
  const boxes = document.querySelector('#checkBody').querySelectorAll('[data-check-select]');
  for (const box of boxes) {
    box.checked = selectAllChecks.checked;
    const index = Number(box.dataset.checkSelect);
    if (selectAllChecks.checked) selectedCheckIndexes.add(index);
    else selectedCheckIndexes.delete(index);
  }
  syncCheckRetrySelected();
});

document.querySelector('#checkBody').addEventListener('change', (event) => {
  const box = event.target.closest('[data-check-select]');
  if (!box) return;
  const index = Number(box.dataset.checkSelect);
  if (box.checked) selectedCheckIndexes.add(index);
  else selectedCheckIndexes.delete(index);
  syncCheckRetrySelected();
  if (lastCheckJob) syncHeaderCheckbox(selectAllChecks, selectedCheckIndexes, lastCheckJob.items);
});

document.querySelector('#checkBody').addEventListener('click', async (event) => {
  if (event.target.closest('[data-check-select]')) return;
  const button = event.target.closest('[data-check-retry]');
  if (!button || !checkJobId) return;
  button.disabled = true;
  try {
    const job = await request(`/api/checks/${checkJobId}/retry`, {
      method: 'POST',
      body: JSON.stringify({ index: Number(button.dataset.checkRetry), ...adminConcurrency(document.querySelector('#checkConcurrency')) }),
    });
    document.querySelector('#checkStart').disabled = true;
    renderCheckJob(job);
    if (!checkPollTimer) checkPollTimer = setTimeout(pollCheck, 400);
  } catch (error) {
    showToast(error.message);
  }
});

const PW_STORAGE_KEY = 'acc-core:lastPasswordJobId';
const pwAccounts = document.querySelector('#pwAccounts');
const pwStart = document.querySelector('#pwStart');
const pwCancel = document.querySelector('#pwCancel');
const pwBody = document.querySelector('#pwBody');
const pwResultList = document.querySelector('#pwResultList');
let pwJobId = null;
let pwPollTimer = null;
let lastPwJob = null;
let pwRunning = false;
let pwFilter = 'all';
let pwInputVisible = false;
const selectedPwIndexes = new Set();

function extractPwSession(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (text.startsWith('{')) {
    try {
      const json = JSON.parse(text);
      return String(json.sessionToken || json.session_token || json.session || '').trim();
    } catch {
      return '';
    }
  }
  return text;
}

function localParseMailAccounts(value) {
  const rows = value.split(/\r?\n/).map((line, index) => ({ raw: line.trim(), line: index + 1 })).filter((row) => row.raw);
  const errors = [];
  let valid = 0;
  const seen = new Set();

  for (const row of rows) {
    let email = '';
    let mailPassword = '';

    if (!row.raw.includes('----') && row.raw.includes('@') && row.raw.includes(':')) {
      const index = row.raw.indexOf(':');
      email = row.raw.slice(0, index).trim();
      mailPassword = row.raw.slice(index + 1).trim();
    } else if (row.raw.includes('----')) {
      const parts = row.raw.split('----').map((part) => part.trim()).filter(Boolean);
      if (parts.length >= 1 && parts[0].includes('@') && parts[0].includes(':')) {
        email = parts[0].slice(0, parts[0].indexOf(':')).trim();
        mailPassword = parts[0].slice(parts[0].indexOf(':') + 1).trim();
      } else if (parts.length >= 2) {
        email = parts[0];
        mailPassword = parts[1];
      }
    } else {
      errors.push(`第 ${row.line} 行格式应为 邮箱:邮箱密码 或 邮箱----邮箱密码`);
      continue;
    }

    if (!email || !mailPassword) {
      errors.push(`第 ${row.line} 行格式应为 邮箱:邮箱密码 或 邮箱----邮箱密码`);
      continue;
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      errors.push(`第 ${row.line} 行邮箱无效`);
      continue;
    }
    if (seen.has(email.toLowerCase())) {
      errors.push(`第 ${row.line} 行邮箱重复`);
      continue;
    }
    seen.add(email.toLowerCase());
    valid += 1;
  }

  if (valid > 100) errors.push('单次最多处理 100 个账号');
  return { valid, errors };
}

function updatePwParseState() {
  if (!pwAccounts || !pwStart) return;
  const parsed = localParseMailAccounts(pwAccounts.value);
  const shared = document.querySelector('#pwBatchNew')?.value.trim() || '';
  if (shared && shared.length < 8) parsed.errors.push('统一新密码至少 8 位');
  document.querySelector('#pwParseCount').textContent = `${parsed.valid} 条有效输入`;
  document.querySelector('#pwInputErrors').textContent = parsed.errors.slice(0, 3).join('；');
  pwStart.disabled = pwRunning || parsed.valid === 0 || parsed.errors.length > 0;
}

function setPwRunning(running) {
  pwRunning = running;
  if (pwCancel) pwCancel.disabled = !running;
  if (pwAccounts) pwAccounts.disabled = running;
  const concurrencyInput = document.querySelector('#pwConcurrency');
  if (concurrencyInput) concurrencyInput.disabled = running || currentUser?.role !== 'admin';
  const shared = document.querySelector('#pwBatchNew');
  if (shared) shared.disabled = running;
  updatePwParseState();
}

function rememberPwJob(id) {
  pwJobId = id;
  try { sessionStorage.setItem(PW_STORAGE_KEY, id); } catch { /* ignore */ }
}

function forgetPwJob() {
  pwJobId = null;
  try { sessionStorage.removeItem(PW_STORAGE_KEY); } catch { /* ignore */ }
}

function syncPwRetrySelected() {
  const button = document.querySelector('#pwRetrySelected');
  if (!button) return;
  const count = selectedPwIndexes.size;
  button.disabled = count === 0;
  button.textContent = count ? `重试所选（${count}）` : '重试所选';
}

function parsePwResultLine(line) {
  const parts = String(line || '').split('----');
  return {
    email: parts[0] || '',
    gptPassword: parts[1] || '',
    mailPassword: parts.slice(2).join('----') || '',
  };
}

function renderPwJob(job) {
  lastPwJob = job;
  document.querySelector('#pwTotal').textContent = job.counts.total;
  document.querySelector('#pwRunning').textContent = job.counts.running;
  document.querySelector('#pwSuccess').textContent = job.counts.success;
  document.querySelector('#pwFailed').textContent = job.counts.failed;

  const visibleItems = pwFilter === 'failed'
    ? job.items.filter((item) => item.status === 'failed' || item.status === 'cancelled')
    : job.items;
  pwBody.innerHTML = visibleItems.length
    ? visibleItems.map((item) => {
      const retryLabel = item.retryCount ? ` · 已重试 ${item.retryCount} 次` : '';
      const errorText = item.error ? `${item.error}${retryLabel}` : (retryLabel ? retryLabel.slice(3) : '—');
      const category = item.status === 'failed' && item.errorCategory ? errorCategories[item.errorCategory] : null;
      const categoryTag = category
        ? `<span class="reason-tag reason-${item.errorCategory}" title="${escapeHtml(category.advice)}">${escapeHtml(category.label)}</span>`
        : '';
      const retryDisabled = !item.canRetry || item.status === 'running' || item.status === 'pending';
      if (!item.canRetry) selectedPwIndexes.delete(item.index);
      let actionHtml = '—';
      if (item.status === 'running') {
        actionHtml = `<button class="retry-button abort-button" type="button" data-pw-abort="${item.index}" ${item.aborting ? 'disabled' : ''}>${item.aborting ? '终止中' : '终止'}</button>`;
      } else if (item.canRetry || item.status === 'failed') {
        actionHtml = `<button class="retry-button" type="button" data-pw-retry="${item.index}" ${retryDisabled ? 'disabled' : ''}>重试</button>`;
      }
      return `
      <tr>
        <td class="select-col">${item.canRetry
          ? `<input type="checkbox" data-pw-select="${item.index}" ${selectedPwIndexes.has(item.index) ? 'checked' : ''} aria-label="选择 ${escapeHtml(item.email)}">`
          : ''}</td>
        <td>${escapeHtml(item.email)}</td>
        <td>${escapeHtml(item.stage || '—')}</td>
        <td><span class="status-pill status-${item.status}">${statusLabels[item.status] || item.status}</span></td>
        <td>${formatDuration(item.durationMs)}</td>
        <td class="error-cell" title="${escapeHtml(item.error || '')}">${categoryTag}${escapeHtml(errorText)}</td>
        <td class="action-cell">${actionHtml}</td>
      </tr>`;
    }).join('')
    : `<tr class="empty-row"><td colspan="7">${pwFilter === 'failed' ? '当前没有失败或已取消的账号。' : '开始任务后，这里会逐项显示进度。'}</td></tr>`;

  document.querySelector('#pwCopyFailed').disabled = !job.items.some((item) => item.status === 'failed');
  document.querySelector('#pwRetryFailed').disabled = !job.items.some((item) => item.canRetry && (item.status === 'failed' || item.status === 'cancelled'));
  syncPwRetrySelected();
  syncHeaderCheckbox(document.querySelector('#selectAllPw'), selectedPwIndexes, visibleItems);

  const successful = job.items.filter((item) => item.status === 'success' && item.resultLine).sort((a, b) => a.index - b.index);
  pwResultList.innerHTML = successful.length
    ? successful.map((item, index) => `
      <article class="session-item">
        <header class="session-head">
          <div class="session-meta"><span>#${index + 1}</span><strong>${escapeHtml(item.email)}</strong></div>
        </header>
        <code class="session-token">${escapeHtml(item.resultLine)}</code>
      </article>`)
      .join('')
    : '<p class="session-empty">成功添加的账号会按 邮箱----GPT密码----邮箱密码 显示在这里。</p>';
  const hasResults = (job.results || []).length > 0;
  document.querySelector('#pwCopyResults').disabled = !hasResults;
  document.querySelector('#pwDownloadResults').disabled = !hasResults;
  document.querySelector('#pwExportExcel').disabled = !hasResults;
}

async function pollPwJob() {
  pwPollTimer = null;
  if (!pwJobId) return;
  try {
    const job = await request(`/api/passwords/${pwJobId}`);
    renderPwJob(job);
    if (job.status === 'running') {
      setPwRunning(true);
      pwPollTimer = setTimeout(pollPwJob, 800);
    } else {
      setPwRunning(false);
      showToast(`添加密码完成：成功 ${job.counts.success}，失败 ${job.counts.failed}`);
      void loadHistory();
    }
  } catch (error) {
    setPwRunning(false);
    showToast(error.message);
  }
}

async function retryPwAccounts(payload, toastMessage) {
  if (!pwJobId) return;
  try {
    const job = await request(`/api/passwords/${pwJobId}/retry`, {
      method: 'POST',
      body: JSON.stringify({ ...payload, ...adminConcurrency(document.querySelector('#pwConcurrency')) }),
    });
    setPwRunning(true);
    if (pwCancel) pwCancel.disabled = false;
    renderPwJob(job);
    if (!pwPollTimer) pwPollTimer = setTimeout(pollPwJob, 400);
    if (toastMessage) showToast(toastMessage);
  } catch (error) {
    showToast(error.message);
  }
}

pwAccounts?.addEventListener('input', updatePwParseState);
document.querySelector('#pwBatchNew')?.addEventListener('input', updatePwParseState);
document.querySelector('#togglePwSecrets')?.addEventListener('click', () => {
  pwInputVisible = !pwInputVisible;
  pwAccounts.classList.toggle('is-masked', !pwInputVisible);
  const button = document.querySelector('#togglePwSecrets');
  button.title = pwInputVisible ? '隐藏输入内容' : '显示输入内容';
  button.setAttribute('aria-label', button.title);
});
pwAccounts?.classList.add('is-masked');
updatePwParseState();

pwStart?.addEventListener('click', async () => {
  selectedPwIndexes.clear();
  setPwRunning(true);
  try {
    const job = await request('/api/passwords', {
      method: 'POST',
      body: JSON.stringify({
        input: pwAccounts.value,
        newPassword: document.querySelector('#pwBatchNew').value.trim(),
        ...adminConcurrency(document.querySelector('#pwConcurrency')),
      }),
    });
    rememberPwJob(job.id);
    renderPwJob(job);
    pwPollTimer = setTimeout(pollPwJob, 400);
  } catch (error) {
    setPwRunning(false);
    showToast(error.message);
  }
});

pwCancel?.addEventListener('click', async () => {
  if (!pwJobId) return;
  try {
    const job = await request(`/api/passwords/${pwJobId}/cancel`, { method: 'POST', body: '{}' });
    renderPwJob(job);
    showToast('已发送取消请求');
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector('#pwCopyFailed')?.addEventListener('click', async () => {
  const emails = (lastPwJob?.items || []).filter((item) => item.status === 'failed').map((item) => item.email);
  if (!emails.length) return;
  await copyText(emails.join('\n'), `已复制 ${emails.length} 个失败邮箱`);
});

document.querySelector('#pwRetryFailed')?.addEventListener('click', async () => {
  await retryPwAccounts({ failed: true }, '正在重试失败账号');
});

document.querySelector('#pwRetrySelected')?.addEventListener('click', async () => {
  const indexes = [...selectedPwIndexes]
    .filter((index) => lastPwJob?.items.find((item) => item.index === index)?.canRetry)
    .sort((a, b) => a - b);
  if (!indexes.length) {
    showToast('请先勾选要重试的账号');
    return;
  }
  for (const index of indexes) selectedPwIndexes.delete(index);
  await retryPwAccounts({ indexes }, `正在重试 ${indexes.length} 个所选账号`);
});

document.querySelector('#selectAllPw')?.addEventListener('change', () => {
  const header = document.querySelector('#selectAllPw');
  const boxes = pwBody.querySelectorAll('[data-pw-select]');
  for (const box of boxes) {
    box.checked = header.checked;
    const index = Number(box.dataset.pwSelect);
    if (header.checked) selectedPwIndexes.add(index);
    else selectedPwIndexes.delete(index);
  }
  syncPwRetrySelected();
});

pwBody?.addEventListener('change', (event) => {
  const box = event.target.closest('[data-pw-select]');
  if (!box) return;
  const index = Number(box.dataset.pwSelect);
  if (box.checked) selectedPwIndexes.add(index);
  else selectedPwIndexes.delete(index);
  syncPwRetrySelected();
  if (lastPwJob) {
    const visibleItems = pwFilter === 'failed'
      ? lastPwJob.items.filter((item) => item.status === 'failed' || item.status === 'cancelled')
      : lastPwJob.items;
    syncHeaderCheckbox(document.querySelector('#selectAllPw'), selectedPwIndexes, visibleItems);
  }
});

pwBody?.addEventListener('click', async (event) => {
  if (event.target.closest('[data-pw-select]')) return;
  const abortButton = event.target.closest('[data-pw-abort]');
  if (abortButton && !abortButton.disabled && pwJobId) {
    abortButton.disabled = true;
    abortButton.textContent = '终止中';
    try {
      const job = await request(`/api/passwords/${pwJobId}/abort`, {
        method: 'POST',
        body: JSON.stringify({ index: Number(abortButton.dataset.pwAbort) }),
      });
      renderPwJob(job);
      if (!pwPollTimer) pwPollTimer = setTimeout(pollPwJob, 400);
      showToast('已发送终止请求，结束后可重试');
    } catch (error) {
      showToast(error.message);
      if (lastPwJob) renderPwJob(lastPwJob);
    }
    return;
  }
  const button = event.target.closest('[data-pw-retry]');
  if (!button || button.disabled || !pwJobId) return;
  button.disabled = true;
  await retryPwAccounts({ index: Number(button.dataset.pwRetry) }, '正在重试该账号');
});

document.querySelectorAll('[data-pw-filter]').forEach((button) => {
  button.addEventListener('click', () => {
    pwFilter = button.dataset.pwFilter;
    document.querySelectorAll('[data-pw-filter]').forEach((tab) => tab.classList.toggle('is-active', tab === button));
    if (lastPwJob) renderPwJob(lastPwJob);
  });
});

document.querySelector('#pwCopyResults')?.addEventListener('click', async () => {
  const lines = lastPwJob?.results || [];
  if (!lines.length) return;
  await copyText(lines.join('\n'), `已复制 ${lines.length} 条账号`);
});

document.querySelector('#pwDownloadResults')?.addEventListener('click', () => {
  const lines = lastPwJob?.results || [];
  if (!lines.length) return;
  const blob = new Blob([`${lines.join('\n')}\n`], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'gpt-passwords.txt';
  link.click();
  URL.revokeObjectURL(url);
});

document.querySelector('#pwExportExcel')?.addEventListener('click', () => {
  const lines = lastPwJob?.results || [];
  if (!lines.length) return;
  const rows = [
    ['邮箱', 'GPT密码', '邮箱密码'],
    ...lines.map((line) => {
      const account = parsePwResultLine(line);
      return [account.email, account.gptPassword, account.mailPassword];
    }),
  ];
  const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'gpt-passwords.csv';
  link.click();
  URL.revokeObjectURL(url);
  showToast('已导出 Excel（CSV）');
});

async function restorePwJob() {
  let id = '';
  try { id = sessionStorage.getItem(PW_STORAGE_KEY) || ''; } catch { return; }
  if (!id) return;
  pwJobId = id;
  try {
    const job = await request(`/api/passwords/${id}`);
    renderPwJob(job);
    if (job.status === 'running') {
      setPwRunning(true);
      pwPollTimer = setTimeout(pollPwJob, 400);
    }
  } catch {
    forgetPwJob();
  }
}

function totpCodeLocal(secret, atMs = Date.now()) {
  const s = String(secret || '').toUpperCase().replace(/[\s=-]+/g, '');
  if (!s) return '';
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of s) {
    const value = alphabet.indexOf(char);
    if (value < 0) continue;
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  if (!bytes.length) return '';
  const counter = Math.floor(atMs / 1000 / 30);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  return crypto.subtle.importKey('raw', new Uint8Array(bytes), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
    .then((key) => crypto.subtle.sign('HMAC', key, msg))
    .then((buf) => {
      const h = new Uint8Array(buf);
      const offset = h[h.length - 1] & 0xf;
      const code = ((h[offset] & 0x7f) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
      return String(code % 1_000_000).padStart(6, '0');
    })
    .catch(() => '');
}

async function refreshTotp() {
  const secret = document.querySelector('#totpSecret').value;
  const remain = 30 - Math.floor((Date.now() % 30000) / 1000);
  document.querySelector('#totpRemain').textContent = String(remain);
  document.querySelector('#totpBar').style.width = `${(remain / 30) * 100}%`;
  const code = secret ? await totpCodeLocal(secret) : '------';
  document.querySelector('#totpCode').textContent = code || '无效 Secret';
}

document.querySelector('#totpSecret').addEventListener('input', () => { void refreshTotp(); });
document.querySelector('#totpCopy').addEventListener('click', async () => {
  const code = document.querySelector('#totpCode').textContent;
  if (!/^\d{6}$/.test(code)) return;
  await copyText(code, '验证码已复制');
});
setInterval(() => { void refreshTotp(); }, 1000);

async function runTool(button, output, url, payload) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '处理中…';
  output.textContent = '正在请求…';
  try {
    const data = await request(url, { method: 'POST', body: JSON.stringify(payload) });
    output.textContent = JSON.stringify(data, null, 2);
    showToast(data.message || '完成');
  } catch (error) {
    output.textContent = error.message;
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

document.querySelector('#mailList').addEventListener('click', (event) => runTool(event.currentTarget, document.querySelector('#mailOutput'), '/api/mail/list', {
  email: document.querySelector('#mailEmail').value,
  password: document.querySelector('#mailPassword').value,
  proxy: document.querySelector('#mailProxy').value || null,
}));
document.querySelector('#mailOtp').addEventListener('click', (event) => runTool(event.currentTarget, document.querySelector('#mailOutput'), '/api/mail/otp', {
  email: document.querySelector('#mailEmail').value,
  password: document.querySelector('#mailPassword').value,
  proxy: document.querySelector('#mailProxy').value || null,
}));
document.querySelector('#mailWaitOtp').addEventListener('click', (event) => runTool(event.currentTarget, document.querySelector('#mailOutput'), '/api/mail/otp', {
  email: document.querySelector('#mailEmail').value,
  password: document.querySelector('#mailPassword').value,
  proxy: document.querySelector('#mailProxy').value || null,
  wait: true,
}));
document.querySelector('#mailLink').addEventListener('click', (event) => runTool(event.currentTarget, document.querySelector('#mailOutput'), '/api/mail/link', {
  email: document.querySelector('#mailEmail').value,
  password: document.querySelector('#mailPassword').value,
  proxy: document.querySelector('#mailProxy').value || null,
  pattern: document.querySelector('#mailPattern').value,
}));

document.querySelector('#mfaEnable').addEventListener('click', (event) => runTool(event.currentTarget, document.querySelector('#mfaOutput'), '/api/mfa/enable', {
  email: document.querySelector('#mfaEmail').value,
  gptPassword: document.querySelector('#mfaGptPassword').value,
  mailPassword: document.querySelector('#mfaMailPassword').value,
  totpSecret: document.querySelector('#mfaSecret').value || null,
  sessionToken: document.querySelector('#mfaSession').value || null,
  proxy: document.querySelector('#mfaProxy').value || null,
}));
document.querySelector('#mfaDisable').addEventListener('click', (event) => runTool(event.currentTarget, document.querySelector('#mfaOutput'), '/api/mfa/disable', {
  email: document.querySelector('#mfaEmail').value,
  gptPassword: document.querySelector('#mfaGptPassword').value,
  totpSecret: document.querySelector('#mfaSecret').value,
  sessionToken: document.querySelector('#mfaSession').value || null,
  proxy: document.querySelector('#mfaProxy').value || null,
}));

document.querySelector('#pwAddBtn').addEventListener('click', (event) => runTool(event.currentTarget, document.querySelector('#pwOutput'), '/api/password/gpt-add', {
  email: document.querySelector('#pwEmail').value,
  mailPassword: document.querySelector('#pwMail').value,
  sessionToken: document.querySelector('#pwSession').value,
  totpSecret: document.querySelector('#pwSecret').value || null,
  newPassword: document.querySelector('#pwNew').value,
  proxy: document.querySelector('#pwProxy').value || null,
}));
document.querySelector('#pwGptBtn').addEventListener('click', (event) => runTool(event.currentTarget, document.querySelector('#pwOutput'), '/api/password/gpt', {
  email: document.querySelector('#pwEmail').value,
  gptPassword: document.querySelector('#pwGpt').value,
  mailPassword: document.querySelector('#pwMail').value,
  sessionToken: document.querySelector('#pwSession').value || null,
  totpSecret: document.querySelector('#pwSecret').value || null,
  newPassword: document.querySelector('#pwNew').value,
  proxy: document.querySelector('#pwProxy').value || null,
}));
document.querySelector('#pwMailBtn').addEventListener('click', (event) => runTool(event.currentTarget, document.querySelector('#pwOutput'), '/api/password/mail', {
  email: document.querySelector('#pwEmail').value,
  password: document.querySelector('#pwMail').value,
  newPassword: document.querySelector('#pwNew').value,
  proxy: document.querySelector('#pwProxy').value || null,
}));
