// 轻量分级日志。用 LOG_LEVEL 控制（debug < info < warn < error，默认 info）。
// 刻意不引第三方依赖：进程里只要一个带时间戳、能按级别过滤、顺手脱敏的 console 包装。
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// 和各处 publicError 一致：别把 session-token / accessToken / 密码 / cookie 打进日志。
function redact(text) {
  return String(text)
    .replace(/(__Secure-next-auth\.session-token(?:\.\d+)?=)[^;\s]+/gi, '$1[已隐藏]')
    // 兼容裸文本（accessToken=xxx）和 JSON（"sessionToken":"xxx"）两种形态
    .replace(/(accessToken|sessionToken|password|cookie)"?\s*[:=]\s*"?[^\s",;]+/gi, '$1=[已隐藏]');
}

export function createLogger({ level = process.env.LOG_LEVEL || 'info', sink = console } = {}) {
  const threshold = LEVELS[String(level).toLowerCase()] ?? LEVELS.info;

  function emit(name, message, data) {
    if (LEVELS[name] < threshold) return;
    const stamp = new Date().toISOString();
    const base = `${stamp} ${name.toUpperCase()} ${redact(message)}`;
    const line = data !== undefined ? `${base} ${redact(JSON.stringify(data))}` : base;
    const method = name === 'error' ? 'error' : name === 'warn' ? 'warn' : 'log';
    (sink[method] || sink.log).call(sink, line);
  }

  return {
    level,
    debug: (message, data) => emit('debug', message, data),
    info: (message, data) => emit('info', message, data),
    warn: (message, data) => emit('warn', message, data),
    error: (message, data) => emit('error', message, data),
  };
}

// 把一个已序列化的批量任务压成一行可观测摘要：总数/成功/失败 + 失败原因分类直方图。
// 失败里 proxy/region/risk 占比高，就是该降并发或换代理池的信号。
export function summarizeJob(kind, job) {
  const items = job?.items || [];
  const categories = {};
  for (const item of items) {
    if (item.status === 'failed' && item.errorCategory) {
      categories[item.errorCategory] = (categories[item.errorCategory] || 0) + 1;
    }
  }
  return {
    kind,
    id: job?.id,
    status: job?.status,
    total: job?.counts?.total ?? items.length,
    success: job?.counts?.success ?? 0,
    failed: job?.counts?.failed ?? 0,
    cancelled: job?.counts?.cancelled ?? 0,
    categories,
    durationMs: job?.finishedAt && job?.createdAt ? job.finishedAt - job.createdAt : null,
  };
}
