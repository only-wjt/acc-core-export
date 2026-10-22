// 默认走 ctls 的指纹请求，但只在真正发起检测时才按需加载——
// 否则 import 本模块会连带拉起 CycleTLS 子进程（见 ctls.js import 时的初始化），
// 让单测和注入了自定义 fetch 的调用方白白付出这笔开销。
async function defaultFetch(url, opts, proxy) {
  const { ctlsFetch } = await import('./ctls.js');
  return ctlsFetch(url, opts, proxy);
}

// OpenAI 不提供服务的地区（ISO 3166-1 alpha-2）。这是一个"拒绝名单"：
// 命中的代理会被标为不支持，其余一律视为可能可用（supported=true）。
// 香港(HK)是用户最常踩的坑——代理出口落在 HK，ChatGPT 直接拒绝。
// 这份名单会变动，按需增减即可，不求穷尽。
export const UNSUPPORTED_COUNTRIES = new Set([
  'HK', // 香港
  'CN', // 中国大陆
  'RU', // 俄罗斯
  'KP', // 朝鲜
  'IR', // 伊朗
  'SY', // 叙利亚
  'CU', // 古巴
  'VE', // 委内瑞拉（部分服务受限）
]);

// 去掉代理里的账号密码，只保留 协议//host:port，用于回显，避免把凭据打到日志/前端。
export function maskProxy(proxy) {
  const text = String(proxy || '');
  try {
    const url = new URL(text);
    return `${url.protocol}//${url.hostname}:${url.port}`;
  } catch {
    return text.replace(/\/\/[^@/]+@/, '//');
  }
}

function pickCountry(data) {
  if (!data || typeof data !== 'object') return '';
  // ipinfo.io → country；ifconfig.co → country_iso；ip-api → countryCode
  const raw = data.country || data.country_iso || data.countryCode || data.country_code || '';
  return String(raw || '').trim().toUpperCase().slice(0, 2);
}

export function createProxyChecker({
  fetchImpl = defaultFetch,
  endpoint = process.env.PROXY_CHECK_URL || 'https://ipinfo.io/json',
  timeoutMs = 15000,
} = {}) {
  async function checkProxy(proxy) {
    const label = maskProxy(proxy);
    try {
      const res = await fetchImpl(endpoint, { timeoutMs, headers: { Accept: 'application/json' } }, proxy);
      if (!res?.ok) {
        return { proxy: label, ok: false, ip: '', country: '', supported: null, error: `出口查询返回 ${res?.status ?? '异常'}` };
      }
      const data = await res.json().catch(() => null);
      const country = pickCountry(data);
      const ip = String(data?.ip || '').trim();
      if (!country) {
        return { proxy: label, ok: true, ip, country: '', supported: null, error: '未能识别出口国家' };
      }
      return { proxy: label, ok: true, ip, country, supported: !UNSUPPORTED_COUNTRIES.has(country), error: '' };
    } catch (error) {
      return { proxy: label, ok: false, ip: '', country: '', supported: null, error: String(error?.message || error || '代理不可用').slice(0, 200) };
    }
  }

  // 有限并发逐条检测，默认 5 路，避免一次性打爆所有代理/查询端点。
  async function checkProxies(proxies, { concurrency = 5 } = {}) {
    const list = Array.isArray(proxies) ? proxies : [];
    const results = new Array(list.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, list.length || 1)) }, async () => {
      while (cursor < list.length) {
        const index = cursor++;
        results[index] = await checkProxy(list[index]);
      }
    });
    await Promise.all(workers);
    return results;
  }

  return { checkProxy, checkProxies };
}
