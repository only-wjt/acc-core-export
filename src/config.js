// ───────────── 全局并发配置 ─────────────
// 默认全体 36 并发，硬上限 200；或用对应环境变量单独覆盖某一项。
// 机器容量不是唯一边界：若网关/上游出现 status0、429 或代理失败，仍应按指标主动降载。
// 注:短信锁的真因是"频繁改密"(见 routes init 的 needsInit 门控),不是并发;并发影响的只是网关连通性。

const HARD_CONCURRENCY_MAX = 200;
const boundedConcurrency = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(HARD_CONCURRENCY_MAX, Math.floor(parsed)));
};

export const MAX = boundedConcurrency(process.env.MAX_CONCURRENCY, 36);

// mail.com 登录/检测并发 —— 随全局 MAX(默认 36)。代理网关出现 status0 时用环境变量快速降载。
// 短信锁的真因是"频繁改密"(见 routes init 的 needsInit 门控),不是并发;并发影响的只是网关连通性。
// 间隔默认 0(每号独立 IP 无需错峰)。env: MAIL_LOGIN_CONCURRENCY / MAIL_LOGIN_GAP_MS
// mail.com 登录/取码并发。工作台代理池通常很少，默认压到 2 路并错开，避免 10 个号同时打同一出口。
// env: MAIL_LOGIN_CONCURRENCY / MAIL_LOGIN_GAP_MS
export const MAIL_LOGIN_CONCURRENCY = boundedConcurrency(process.env.MAIL_LOGIN_CONCURRENCY, 2);
export const MAIL_LOGIN_GAP_MS = process.env.MAIL_LOGIN_GAP_MS !== undefined ? Number(process.env.MAIL_LOGIN_GAP_MS) : 1500;

// Playwright 浏览器并发:hCaptcha(共享 Chrome 的并发页) 与 cf-solver(过 CF 的并发上下文)。
// 这是真正跟机器走的上限 —— 机器强就调大。env: PW_HCAPTCHA_MAX / PW_CF_MAX
export const PW_HCAPTCHA_MAX = boundedConcurrency(process.env.PW_HCAPTCHA_MAX, MAX);
export const PW_CF_MAX = boundedConcurrency(process.env.PW_CF_MAX, MAX);

// 批量端点默认并发。env: BATCH_CONCURRENCY
export const BATCH_CONCURRENCY = boundedConcurrency(process.env.BATCH_CONCURRENCY, MAX);

export const MAX_EXECUTION_CONCURRENCY = HARD_CONCURRENCY_MAX;
