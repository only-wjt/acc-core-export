/**
 * CF Managed Challenge 绕过：启动真实 Chrome（stealth），通过代理获取 cf_clearance cookie。
 * 获取到的 cf_clearance 按代理缓存 25 分钟，避免频繁启动浏览器。
 */
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { existsSync } from 'fs';
import { PW_CF_MAX } from './config.js';

chromium.use(StealthPlugin());

const CACHE_TTL = 25 * 60 * 1000;
const CF_TIMEOUT = 60000;

const _cfCache = new Map();

// 共享一个 Chrome 进程,每个代理用独立 context(per-context 代理)。并发用信号量限到 PW_CF_MAX(默认15),
// 避免"每次过CF新开一个Chrome"把机器炸掉。context 用完即关,浏览器长驻复用。
let _cfBrowser = null;
async function _getCfBrowser(bin) {
  if (_cfBrowser && _cfBrowser.isConnected()) return _cfBrowser;
  _cfBrowser = await chromium.launch({
    executablePath: bin, headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--window-size=1920,1080'],
    proxy: { server: 'per-context' }, // 允许每个 context 单独设代理
  });
  return _cfBrowser;
}
let _cfActive = 0;
const _cfQueue = [];
function _acquireCf() { return new Promise(res => { if (_cfActive < PW_CF_MAX) { _cfActive++; res(); } else _cfQueue.push(res); }); }
function _releaseCf() { if (_cfQueue.length > 0) _cfQueue.shift()(); else _cfActive = Math.max(0, _cfActive - 1); }

function _proxyKey(proxy) {
  return proxy ? `${proxy.username}@${proxy.host}:${proxy.port}` : 'direct';
}

function _findChrome() {
  for (const p of [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/opt/google/chrome/chrome',
  ].filter(Boolean)) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 获取 auth.openai.com 的 cf_clearance cookie 字符串。
 * 成功返回 "cf_clearance=xxx; __cf_bm=yyy" 字符串，失败返回 ''。
 *
 * @param {string} url        目标 URL（通常是 https://auth.openai.com/）
 * @param {object|null} proxy { host, port, username, password }
 * @param {function} log      日志函数
 */
export async function getCfClearance(url, proxy = null, log = () => {}) {
  const key = _proxyKey(proxy);

  // 命中缓存
  const cached = _cfCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    log('[cf-solver] 命中缓存 cf_clearance');
    return cached.cookieStr;
  }

  const bin = _findChrome();
  if (!bin) {
    log('[cf-solver] 未找到 Chrome 可执行文件，跳过');
    return '';
  }

  await _acquireCf(); // 信号量:同时最多 PW_CF_MAX 个过 CF(默认15,跟机器走)
  log(`[cf-solver] 获取 cf_clearance…(并发 ${_cfActive}/${PW_CF_MAX})`);
  let ctx = null;
  try {
    const browser = await _getCfBrowser(bin); // 复用共享 Chrome
    const proxyServer = proxy ? `http://${proxy.host}:${proxy.port}` : undefined;
    const ctxOpts = proxyServer
      ? { proxy: { server: proxyServer, ...(proxy.username ? { username: proxy.username, password: proxy.password } : {}) } }
      : {};
    ctx = await browser.newContext(ctxOpts); // 每代理独立 context
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 轮询等待 cf_clearance 出现（最多 CF_TIMEOUT ms）
    const deadline = Date.now() + CF_TIMEOUT;
    let cookieStr = '';
    while (Date.now() < deadline) {
      const cookies = await ctx.cookies(url).catch(() => []);
      const cf = cookies.filter(c => ['cf_clearance', '__cf_bm', '_cfuvid'].includes(c.name));
      if (cf.some(c => c.name === 'cf_clearance')) {
        cookieStr = cf.map(c => `${c.name}=${c.value}`).join('; ');
        break;
      }
      await new Promise(r => setTimeout(r, 600));
    }

    if (cookieStr) {
      _cfCache.set(key, { cookieStr, ts: Date.now() });
      log('[cf-solver] cf_clearance 获取成功');
    } else {
      log('[cf-solver] cf_clearance 超时（CF未放行或IP被封）');
    }
    return cookieStr;
  } catch (e) {
    log(`[cf-solver] 错误: ${e.message}`);
    return '';
  } finally {
    try { await ctx?.close(); } catch {} // 只关 context,浏览器长驻复用
    _releaseCf();
  }
}

/** 手动清除指定代理的 cf_clearance 缓存 */
export function clearCfCache(proxy = null) {
  _cfCache.delete(_proxyKey(proxy));
}
