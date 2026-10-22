import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// toSub2 是一个独立的前端+控制台服务，我们只把它当作「受管子进程」：
// 由本进程 spawn、由本进程杀，只把它 /api/* 的 JSON 接口透传给管理员。
// 不代理它的 SPA（那是它自己的页面），也不需要它的前端资源。
const ENTRY = 'src/console-server.mjs';
const DEFAULT_PORT = 4399;
const DEFAULT_HOST = '127.0.0.1';
// 冷启动要跑 vite 建开发服务器，慢的时候十几秒，25s 留够余量。
const BOOTSTRAP_TIMEOUT_MS = 25000;
const POLL_INTERVAL_MS = 250;
const STOP_GRACE_MS = 5000;
// 透传响应最多留 4MB：任务分页是几千字节，超过这个量级基本是异常输出。
const MAX_PROXY_BYTES = 4 * 1024 * 1024;

const MISSING_ROOT = '未找到 toSub2 目录';

function defaultSleep(ms) {
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
  });
}

// 目录存在还不够：必须是 toSub2 的仓库根（有入口文件），否则 spawn 只会报个含糊的 MODULE_NOT_FOUND。
function hasEntry(rootDir) {
  if (!rootDir) return false;
  try {
    if (!statSync(rootDir).isDirectory()) return false;
  } catch {
    return false;
  }
  return existsSync(join(rootDir, ENTRY));
}

// 纯函数式的小响应封装。index.js 里的 json() 带安全头，但它不能被 require 进来（会成环），
// 这里只补保住透传路径必需的几项。
function writeJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

export function createSub2Sidecar({
  logger = console,
  rootDir = '',
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
  enabled = false,
  // 设置改了要立刻生效，所以配置走回调而不是构造时快照；回调抛错就退回构造参数。
  getConfig,
  spawnImpl = spawn,
  fetchImpl,
  probeImpl,
  sleepImpl = defaultSleep,
  now = Date.now,
  bootstrapTimeoutMs = BOOTSTRAP_TIMEOUT_MS,
  pollIntervalMs = POLL_INTERVAL_MS,
  stopGraceMs = STOP_GRACE_MS,
} = {}) {
  let child = null;
  let token = '';
  let activePort = null;
  let error = '';
  let starting = null;

  function config() {
    const base = { enabled, rootDir, port, host };
    if (typeof getConfig !== 'function') return base;
    try {
      return { ...base, ...(getConfig() || {}) };
    } catch {
      return base;
    }
  }

  function status() {
    const cfg = config();
    const running = Boolean(child);
    const missing = !hasEntry(cfg.rootDir);
    return {
      enabled: Boolean(cfg.enabled),
      running,
      ready: running && Boolean(token),
      port: running && activePort ? activePort : Number(cfg.port) || DEFAULT_PORT,
      rootDir: cfg.rootDir || '',
      // token 只有管理员能拿到（过滤在 index.js 的 /api/sub2/* 里统一做）
      token,
      error: error || (missing ? MISSING_ROOT : ''),
      pid: child?.pid ?? null,
    };
  }

  function fail(message, data) {
    error = message;
    logger?.warn?.(`[sub2] ${message}`, data);
    return status();
  }

  function wire(running, cfg) {
    running.stdout?.setEncoding?.('utf8');
    running.stderr?.setEncoding?.('utf8');
    // 子进程输出按行转进我们的日志：它有 [ok]/[info]/[note] 前缀，保留原样便于对账。
    const relay = (level) => (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) logger?.[level]?.(`[sub2] ${line.trim()}`);
      }
    };
    running.stdout?.on?.('data', relay('debug'));
    running.stderr?.on?.('data', relay('info'));

    running.on?.('error', (cause) => {
      if (child !== running) return;
      child = null;
      token = '';
      activePort = null;
      fail(`toSub2 启动失败：${cause?.message || cause}`);
    });

    running.on?.('exit', (code, signal) => {
      // 主动 stop() 时 child 已经置空，这里只处理「没让我们同意就退了」的情况。
      if (child !== running) return;
      child = null;
      token = '';
      activePort = null;
      error = `toSub2 进程已退出（code=${code ?? '-'} signal=${signal || '-'}）`;
      logger?.warn?.(error);
    });

    logger?.debug?.(`[sub2] 子进程已启动 pid=${running.pid}`, { rootDir: cfg.rootDir, port: activePort });
  }

  // 轮询 /api/bootstrap 拿 console token：它每次启动随机生成，只能从接口里读。
  async function discoverToken(targetPort) {
    const probe = probeImpl || (async (value) => {
      const response = await (fetchImpl || globalThis.fetch)(`http://${host}:${value}/api/bootstrap`, {
        signal: AbortSignal.timeout?.(2000),
      });
      if (!response.ok) throw new Error(`bootstrap 返回 ${response.status}`);
      return response.json();
    });

    const deadline = now() + bootstrapTimeoutMs;
    let last = '';
    while (now() < deadline) {
      if (!child) return null;
      try {
        const result = await probe(targetPort);
        if (result?.token) return result;
        last = 'bootstrap 未返回 token';
      } catch (cause) {
        last = String(cause?.message || cause);
      }
      const left = deadline - now();
      if (left <= 0) break;
      await sleepImpl(Math.min(pollIntervalMs, left));
    }
    throw new Error(`等待 toSub2 就绪超时（${bootstrapTimeoutMs}ms）：${last || '无响应'}`);
  }

  async function doStart() {
    if (child) return status();
    error = '';

    const cfg = config();
    if (!hasEntry(cfg.rootDir)) return fail(MISSING_ROOT, { rootDir: cfg.rootDir || '' });

    const dir = resolve(cfg.rootDir);
    const targetPort = Number(cfg.port) || DEFAULT_PORT;
    activePort = targetPort;

    // toSub2 的端口只认 CLI 的 --port，不读环境变量；host 反过来只认 ONBOARDING_HOST（或 --host）。
    const running = spawnImpl(process.execPath, [ENTRY, '--port', String(targetPort)], {
      cwd: dir,
      env: { ...process.env, ONBOARDING_HOST: host },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child = running;
    wire(running, cfg);

    let bootstrapped;
    try {
      bootstrapped = await discoverToken(targetPort);
    } catch (cause) {
      // 起不来就别留半截进程占着端口
      await stop();
      return fail(String(cause?.message || cause), { port: targetPort });
    }
    if (!bootstrapped) {
      // 轮询期间进程自己退了，exit 处理器已经写好 error
      return status();
    }

    token = bootstrapped.token;
    logger?.info?.(`[sub2] 已就绪 http://${host}:${targetPort}`, { pid: running.pid });
    return status();
  }

  // 幂等：并发调用共用同一个启动 Promise，避免管理端连点两下起两个进程。
  function start() {
    if (starting) return starting;
    const task = doStart();
    starting = task;
    const clear = () => {
      if (starting === task) starting = null;
    };
    task.then(clear, clear);
    return task;
  }

  async function ensureReady() {
    const cfg = config();
    if (!cfg.enabled) throw new Error('toSub2 未启用，请先在设置中开启');
    if (child && token) return status();
    return start();
  }

  // SIGTERM 走它的 shutdown()（会顺手落盘配置文件）；不听话再 SIGKILL。
  function stop() {
    const running = child;
    token = '';
    activePort = null;
    if (!running) {
      child = null;
      return Promise.resolve(true);
    }
    child = null;

    return new Promise((done) => {
      let settled = false;
      let timer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        done(true);
      };
      // 先挂 exit 再 kill：kill 可能同步触发事件，反过来写会漏掉或踩到 timer 的暂时性死区。
      running.once?.('exit', finish);
      timer = setTimeout(() => {
        try {
          running.kill?.('SIGKILL');
        } catch {
          /* 已经没了就算了 */
        }
        finish();
      }, stopGraceMs);
      timer.unref?.();

      try {
        running.kill?.('SIGTERM');
      } catch {
        finish();
      }
    });
  }

  async function restart() {
    await stop();
    return start();
  }

  // 透传一条 /api/* 请求。用全局 fetch 而不是裸 http.request：Node >= 20 自带，
  // 且响应体、状态码、header 都能原样拿回来，测试里换个 fake 就能离线跑。
  async function proxy(req, res, subPath, body) {
    if (!child || !token) {
      writeJson(res, 503, { error: 'toSub2 未启动，请先在管理页启动' });
      return;
    }
    const method = req.method === 'POST' ? 'POST' : 'GET';
    const target = `http://${host}:${activePort}/api/${subPath}`;
    const headers = { accept: 'application/json', 'x-console-token': token };
    const init = { method, headers };
    if (method === 'POST') {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body || {});
    }

    let response;
    try {
      response = await (fetchImpl || globalThis.fetch)(target, init);
    } catch (cause) {
      writeJson(res, 502, { error: `toSub2 无响应：${cause?.message || cause}` });
      return;
    }

    const text = await response.text();
    if (text.length > MAX_PROXY_BYTES) {
      writeJson(res, 502, { error: 'toSub2 响应过大，已拒绝转发' });
      return;
    }
    res.writeHead(response.status, {
      'Content-Type': response.headers?.get?.('content-type') || 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(text);
  }

  return { status, start, stop, restart, ensureReady, proxy };
}
