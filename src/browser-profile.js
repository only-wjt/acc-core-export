// 浏览器协议画像「单源真相」。
// TLS JA3 / 默认 UA / Client Hints / chromeFull 只在此定义；
// ctls.js、fingerprint.js、支付路径 paymentAccountFp 均引用此处，避免版本漂移。
//
// 2026-07-27 ACC 208.98.50.26：
//   google-chrome 150.0.7871.181
//   peet ja3_hash = ff2757dae3bd19b3c9221ea2e380569d
//   CycleTLS 同串落地同 hash（JA4/H2 仍有 residual，见 RESIDUALS）
//   Client Hints（https://example.com + Win UA 覆盖）：
//     brands Not;A=Brand/8, Chromium/150, Google Chrome/150
//     fullVersionList … 150.0.7871.181；platformVersion "10.0"

/** @type {const} */
export const CHROME_MAJOR = 150;

/** ACC `google-chrome --version` / uaFullVersion 实测 */
export const CHROME_FULL = '150.0.7871.181';

/**
 * ACC 真 Chrome peet 采集的 JA3（扩展序取自样本帧）。
 * CycleTLS/uTLS 使用此串；ja3_hash 应对齐 ff2757dae3bd19b3c9221ea2e380569d。
 */
export const JA3 =
  '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,13-65281-10-18-0-16-17613-35-5-23-65037-51-11-43-27-45,4588-29-23-24,0';

/** 期望 CycleTLS 落地 hash（browserleaks/peet 校验用） */
export const JA3_HASH_EXPECTED = 'ff2757dae3bd19b3c9221ea2e380569d';

/**
 * 2026-07-27 ACC 真 Chrome150（Playwright + Win UA，https 页）高熵 Client Hints。
 * GREASE 品牌是 Not;A=Brand v=8（不是旧的 Not/A)Brand v=99）。
 * 顺序与浏览器一致：GREASE → Chromium → Google Chrome。
 */
export const GREASE_BRAND = 'Not;A=Brand';
export const GREASE_BRAND_VERSION = '8';
export const GREASE_FULL_VERSION = '8.0.0.0';

/** 真 brands 数组（采集快照；构建头时用 buildSecChUa） */
export const CLIENT_HINT_BRANDS = Object.freeze([
  { brand: GREASE_BRAND, version: GREASE_BRAND_VERSION },
  { brand: 'Chromium', version: String(CHROME_MAJOR) },
  { brand: 'Google Chrome', version: String(CHROME_MAJOR) },
]);

export function buildSecChUa(brands = CLIENT_HINT_BRANDS) {
  return brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
}

export const SEC_CH_UA = buildSecChUa();

export const UA_WIN =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;

export const UA_MAC =
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;

export const UA_LINUX =
  `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;

/**
 * 支付路径 platformVersion 池。
 * 真采样（Win UA 覆盖）得到 "10.0"；头里常用 "10.0.0"。另保留 Win11 风格分散。
 */
export const PAY_WIN_PLATFORM_VERSIONS = ['"10.0.0"', '"15.0.0"', '"14.0.0"'];

/**
 * 支付多画像实验池（全部强制 Win + 同一已验证 JA3）。
 * 故意不做 XingWan 式「狂洗 JA3」——只在自洽范围内扩散 platform/fullVersion/语言。
 * TLS 层共用 JA3（CycleTLS 仅有一条 ACC peet 真值）；差异在 HTTP Client Hints / UA 细节。
 *
 * 选择策略见 payment-fp-experiment.js（sticky/random/fixed）。
 */
export const PAYMENT_FP_PROFILES = Object.freeze([
  {
    id: 'chrome150-win10-zh',
    label: 'Chrome150 / Win10 / zh-CN（默认对照）',
    chromeMajor: CHROME_MAJOR,
    chromeFull: CHROME_FULL,
    platformVersion: '"10.0.0"',
    acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
    oaiLanguage: 'zh-CN',
    experimental: false,
  },
  {
    id: 'chrome150-win11-zh',
    label: 'Chrome150 / Win11-style / zh-CN',
    chromeMajor: CHROME_MAJOR,
    chromeFull: CHROME_FULL,
    platformVersion: '"15.0.0"',
    acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
    oaiLanguage: 'zh-CN',
    experimental: false,
  },
  {
    id: 'chrome150-win14-zh',
    label: 'Chrome150 / platform 14 / zh-CN',
    chromeMajor: CHROME_MAJOR,
    chromeFull: CHROME_FULL,
    platformVersion: '"14.0.0"',
    acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
    oaiLanguage: 'zh-CN',
    experimental: false,
  },
  {
    id: 'chrome150-win10-en',
    label: 'Chrome150 / Win10 / en-US',
    chromeMajor: CHROME_MAJOR,
    chromeFull: CHROME_FULL,
    platformVersion: '"10.0.0"',
    acceptLanguage: 'en-US,en;q=0.9',
    oaiLanguage: 'en-US',
    experimental: false,
  },
  {
    id: 'chrome150-win11-en',
    label: 'Chrome150 / Win11-style / en-US',
    chromeMajor: CHROME_MAJOR,
    chromeFull: CHROME_FULL,
    platformVersion: '"15.0.0"',
    acceptLanguage: 'en-US,en;q=0.9',
    oaiLanguage: 'en-US',
    experimental: false,
  },
  {
    id: 'chrome150-win10-en-strict',
    label: 'Chrome150 / Win10 / en-US / full=major.0.0.0',
    chromeMajor: CHROME_MAJOR,
    chromeFull: `${CHROME_MAJOR}.0.0.0`,
    platformVersion: '"10.0.0"',
    acceptLanguage: 'en-US,en;q=0.9',
    oaiLanguage: 'en-US',
    experimental: true,
  },
  // —— 对齐 Java BrowserFingerprint（Chrome 148 + Not/A)Brand v=99，配合 stripe.js/3704557c13）——
  {
    id: 'java148-win11-zh',
    label: 'Java对齐 Chrome148 / Win11 / zh-CN',
    chromeMajor: 148,
    chromeFull: '148.0.7778.96',
    platformVersion: '"15.0.0"',
    acceptLanguage: 'zh-CN,zh;q=0.9',
    oaiLanguage: 'zh-CN',
    greaseBrand: 'Not/A)Brand',
    greaseVersion: '99',
    greaseFullVersion: '99.0.0.0',
    secChUaOrder: 'chromium-first',
    experimental: false,
  },
  {
    id: 'java148-win10-zh',
    label: 'Java对齐 Chrome148 / Win10 / zh-CN',
    chromeMajor: 148,
    chromeFull: '148.0.7778.86',
    platformVersion: '"10.0.0"',
    acceptLanguage: 'zh-CN,zh;q=0.9',
    oaiLanguage: 'zh-CN',
    greaseBrand: 'Not/A)Brand',
    greaseVersion: '99',
    greaseFullVersion: '99.0.0.0',
    secChUaOrder: 'chromium-first',
    experimental: false,
  },
  {
    id: 'java148-win14-zh',
    label: 'Java对齐 Chrome148 / platform14 / zh-CN',
    chromeMajor: 148,
    chromeFull: '148.0.7778.107',
    platformVersion: '"14.0.0"',
    acceptLanguage: 'zh-CN,zh;q=0.9',
    oaiLanguage: 'zh-CN',
    greaseBrand: 'Not/A)Brand',
    greaseVersion: '99',
    greaseFullVersion: '99.0.0.0',
    secChUaOrder: 'chromium-first',
    experimental: false,
  },
]);

/** 已知不可对齐残差（文档/验收用，禁止误报已对齐） */
export const RESIDUALS = Object.freeze({
  ja4: {
    real: 't13d… (TLS1.3-class)',
    stack: 't12d… (CycleTLS/uTLS)',
    status: 'residual',
  },
  h2_akamai: {
    real: '1:65536;2:0;4:6291456;6:262144|…',
    stack: 'extra 3:1000;5:16384',
    status: 'residual',
  },
  peetprint: { status: 'not_simulated' },
  grease_extension_order: {
    note: '真 Chrome 每次 GREASE 重排扩展序；协议栈固定一条可复现 JA3',
    status: 'fixed_frame',
  },
  client_hints_source: {
    note: 'Client Hints 来自 ACC Chrome150 + Win UA 覆盖 + HTTPS 页；非 Windows 实体机',
    status: 'forced_win_ua_on_linux_chrome',
  },
  multi_profile_tls: {
    note: '多画像共用同一 JA3；只变 platformVersion/chromeFull/语言，避免假 JA3 库',
    status: 'shared_ja3',
  },
});

export function secChUaFullVersionList(chromeFull = CHROME_FULL) {
  const full = String(chromeFull || CHROME_FULL).replace(/^"|"$/g, '');
  // 与真 fullVersionList 顺序一致：GREASE → Chromium → Google Chrome
  return `"${GREASE_BRAND}";v="${GREASE_FULL_VERSION}", "Chromium";v="${full}", "Google Chrome";v="${full}"`;
}

export function quotedFullVersion(chromeFull = CHROME_FULL) {
  const full = String(chromeFull || CHROME_FULL).replace(/^"|"$/g, '');
  return `"${full}"`;
}

export function seedHash(seed) {
  const s = String(seed || 'default');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

export function getPaymentFpProfile(id) {
  const key = String(id || '').trim();
  return PAYMENT_FP_PROFILES.find((p) => p.id === key) || null;
}

export function listPaymentFpProfiles({ includeExperimental = true } = {}) {
  return PAYMENT_FP_PROFILES.filter((p) => includeExperimental || !p.experimental);
}

/**
 * 支付专用 Win 画像（禁止 Mac/Linux 混进支付链）。
 * @param {string} seed 号间分散种子
 * @param {object} base 底层 accountFp 等
 * @param {object|string|null} profileOrId PAYMENT_FP_PROFILES 条目或 id；缺省 sticky 选一套
 */
export function buildPaymentBrowserProfile(seed = 'default', base = {}, profileOrId = null) {
  let profile = null;
  if (profileOrId && typeof profileOrId === 'object' && profileOrId.id) {
    profile = profileOrId;
  } else if (profileOrId) {
    profile = getPaymentFpProfile(profileOrId);
  }
  if (!profile) {
    // 兼容旧行为：未指定画像时按 seed 在 platformVersion 池上分散
    const idx = seedHash(seed) % PAYMENT_FP_PROFILES.length;
    profile = PAYMENT_FP_PROFILES[idx];
  }
  const major = Number(profile.chromeMajor) || CHROME_MAJOR;
  const chromeFull = String(profile.chromeFull || CHROME_FULL).replace(/^"|"$/g, '');
  const greaseBrand = String(profile.greaseBrand || GREASE_BRAND);
  const greaseVer = String(profile.greaseVersion || GREASE_BRAND_VERSION);
  const greaseFull = String(profile.greaseFullVersion || GREASE_FULL_VERSION);
  // Java：Chromium → Google Chrome → Not/A)Brand；Chrome150 真机：GREASE → Chromium → Google Chrome
  const brands = profile.secChUaOrder === 'chromium-first'
    ? [
      { brand: 'Chromium', version: String(major) },
      { brand: 'Google Chrome', version: String(major) },
      { brand: greaseBrand, version: greaseVer },
    ]
    : [
      { brand: greaseBrand, version: greaseVer },
      { brand: 'Chromium', version: String(major) },
      { brand: 'Google Chrome', version: String(major) },
    ];
  const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  const secChUa = buildSecChUa(brands);
  const fullList = profile.secChUaOrder === 'chromium-first'
    ? `"Chromium";v="${chromeFull}", "Google Chrome";v="${chromeFull}", "${greaseBrand}";v="${greaseFull}"`
    : secChUaFullVersionList(chromeFull).replace(
      `"${GREASE_BRAND}";v="${GREASE_FULL_VERSION}"`,
      `"${greaseBrand}";v="${greaseFull}"`,
    );
  return {
    ...base,
    ua,
    ja3: JA3,
    secChUa,
    secChUaFullVersionList: fullList,
    platform: '"Windows"',
    arch: '"x86"',
    bitness: '"64"',
    platformVersion: profile.platformVersion || '"10.0.0"',
    navPlatform: 'Win32',
    chromeFull,
    model: '""',
    chromeMajor: major,
    acceptLanguage: profile.acceptLanguage || 'en-US,en;q=0.9',
    oaiLanguage: profile.oaiLanguage || 'en-US',
    profileId: profile.id,
    profileLabel: profile.label || profile.id,
    profileExperimental: profile.experimental === true,
  };
}

/**
 * 画像自洽检查：UA major ↔ sec-ch-ua ↔ chromeFull ↔ ja3 非空。
 * @returns {{ ok: boolean, issues: string[], major: number|null }}
 */
export function assertProfileCoherent(fp = {}) {
  const issues = [];
  const ua = String(fp.ua || '');
  const sec = String(fp.secChUa || '');
  const full = String(fp.chromeFull || '').replace(/^"|"$/g, '');
  const uaMajor = Number((/Chrome\/(\d+)/.exec(ua) || [])[1] || NaN);
  const secMajors = [...sec.matchAll(/v="(\d+)"/g)].map((m) => Number(m[1])).filter((n) => n < 200);
  const fullMajor = Number((full.split('.')[0]) || NaN);

  if (!fp.ja3 || !String(fp.ja3).startsWith('771,')) {
    issues.push('ja3_missing_or_invalid');
  }
  if (!Number.isFinite(uaMajor)) issues.push('ua_major_missing');
  if (Number.isFinite(uaMajor) && Number.isFinite(fullMajor) && uaMajor !== fullMajor) {
    issues.push(`ua_full_major_mismatch:${uaMajor}!=${fullMajor}`);
  }
  for (const m of secMajors) {
    // GREASE 品牌版本：99 / 8 / 24 等，不与 Chrome major 比
    if (m === 99 || m === 8 || m === 24) continue;
    if (Number.isFinite(uaMajor) && m !== uaMajor) {
      issues.push(`sec_ch_ua_major_mismatch:${m}!=${uaMajor}`);
      break;
    }
  }
  if (fp.platform && /Windows/i.test(String(fp.platform)) && ua && !/Windows/i.test(ua)) {
    issues.push('platform_ua_os_mismatch');
  }
  if (fp.platform && /Windows/i.test(String(fp.platform)) && fp.navPlatform && fp.navPlatform !== 'Win32') {
    issues.push('navPlatform_expected_Win32');
  }
  return { ok: issues.length === 0, issues, major: Number.isFinite(uaMajor) ? uaMajor : null };
}

/** 供 pay-diag / 日志：短摘要 */
export function profileDiagFields(fp = {}) {
  const coherent = assertProfileCoherent(fp);
  return {
    chrome: String(fp.chromeFull || '').slice(0, 16),
    ua_major: coherent.major,
    platform: fp.platform,
    ja3_head: String(fp.ja3 || '').slice(0, 24),
    grease: GREASE_BRAND,
    coherent: coherent.ok ? 'yes' : coherent.issues.join(','),
  };
}
