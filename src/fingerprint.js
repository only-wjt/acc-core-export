// 统一设备指纹:按账号种子(email)确定性生成"完整且自洽"的浏览器指纹。
// 目标:批量注册时每个账号一套独立指纹(UA/屏幕/硬件/GPU/canvas/audio/时区),
// 同账号每次稳定一致,且 TLS 层(ctls.js applyFp)与 sentinel so-token 采集的 JS 指纹对齐。
//
// Fallbacks：单源 browser-profile。注册路径若开真 Chrome/MostLogin，会被 live 覆盖。
import {
  JA3 as PROFILE_JA3,
  SEC_CH_UA as PROFILE_SEC_CH_UA,
  CHROME_FULL as PROFILE_CHROME_FULL,
  UA_WIN, UA_MAC,
} from './browser-profile.js';

const _JA3 = PROFILE_JA3;
const SEC_CH_UA = PROFILE_SEC_CH_UA;
const CHROME_FULL = PROFILE_CHROME_FULL;

// ── 每号真实指纹缓存(从 MostLogin followIP 开窗采集,与代理真实地理自洽)──
// 注册前 collectRealFp 采集并 setRealFp;deviceProfile 优先返回真值,so-token(补环境)与 ctls 都读它 → 全自洽、无写死。
const _realFpCache = new Map();
export function setRealFp(seed, fp) { if (seed && fp) _realFpCache.set(String(seed), fp); }
export function clearRealFp(seed) { _realFpCache.delete(String(seed)); }
export function hasRealFp(seed) { return _realFpCache.has(String(seed)); }

// 稳定 32 位 hash
function h32(key) {
  const s = String(key || 'default');
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
// 从种子派生多个独立索引(避免各维度相关)
function subHash(h, salt) { return Math.imul(h ^ (salt * 0x9e3779b1), 2654435761) >>> 0; }
const pick = (arr, n) => arr[n % arr.length];

// ── 真实设备档案池(平台 + GPU + 屏幕候选)──
const WIN_GPUS = [
  { v: 'Google Inc. (NVIDIA)', r: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { v: 'Google Inc. (NVIDIA)', r: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 (0x00002882) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { v: 'Google Inc. (NVIDIA)', r: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Ti (0x00002182) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { v: 'Google Inc. (Intel)', r: 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E9B) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { v: 'Google Inc. (Intel)', r: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { v: 'Google Inc. (AMD)', r: 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { v: 'Google Inc. (AMD)', r: 'ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
];
const MAC_GPUS = [
  { v: 'Google Inc. (Apple)', r: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)' },
  { v: 'Google Inc. (Apple)', r: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)' },
  { v: 'Google Inc. (Apple)', r: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)' },
  { v: 'Google Inc. (Intel)', r: 'ANGLE (Intel, Intel(R) Iris(TM) Plus Graphics 655, OpenGL 4.1)' },
];
const WIN_SCREENS = [
  { w: 1920, h: 1080, taskbar: 40 }, { w: 2560, h: 1440, taskbar: 40 }, { w: 1536, h: 864, taskbar: 32 },
  { w: 1366, h: 768, taskbar: 40 }, { w: 1600, h: 900, taskbar: 40 }, { w: 1920, h: 1200, taskbar: 40 },
  { w: 3840, h: 2160, taskbar: 60 }, { w: 2560, h: 1080, taskbar: 40 },
];
const MAC_SCREENS = [
  { w: 1440, h: 900, taskbar: 25 }, { w: 1512, h: 982, taskbar: 25 }, { w: 1728, h: 1117, taskbar: 25 },
  { w: 2560, h: 1440, taskbar: 25 }, { w: 1680, h: 1050, taskbar: 25 },
];
// 时区必须与代理出口国自洽 —— 否则「IP在美国、指纹说欧洲」是强 bot tell,且所有号共性→整批被删。
// 现用美国住宅代理,故用美国时区。getTimezoneOffset 返回"落后 UTC 的分钟数":美国夏令时(7月)为正值:
// EDT(UTC-4)=240、CDT(UTC-5)=300、MDT(UTC-6)=360、PDT/MST(UTC-7)=420。
// ⚠️ 偏移按夏令时(DST)硬编码,冬令时需 +60;长期应按 proxy.exitGeo 动态派生时区+偏移。
const US_TZ = [
  { tz: 'America/New_York', off: 240 }, { tz: 'America/Chicago', off: 300 },
  { tz: 'America/Denver', off: 360 }, { tz: 'America/Los_Angeles', off: 420 },
  { tz: 'America/Phoenix', off: 420 },
];
const HWC = [4, 6, 8, 8, 12, 16];       // 逻辑核心(8 最常见,加权)
const MEM = [8, 8, 8, 4, 16];           // navigator.deviceMemory(Chrome 上限 8,16 会被夹到 8;这里语义值)

/**
 * 生成账号的完整设备指纹。确定性:同 seed → 同指纹。
 * @param {string} seed 账号标识(通常 email)
 */
export function deviceProfile(seed) {
  const h = h32(seed);
  const isMac = (subHash(h, 1) % 4) === 0;   // ~25% mac,~75% win(贴近真实分布)
  const gpu = isMac ? pick(MAC_GPUS, subHash(h, 2)) : pick(WIN_GPUS, subHash(h, 2));
  // Mac 上若命中 Intel GPU(旧 Intel Mac,MAC_GPUS 里的 Iris Plus 655),arch 应为 x86;Apple 芯才是 arm。
  // 否则 sec-ch-ua-arch=arm 与 WebGL 的 Intel Mac 渲染器自相矛盾(可被交叉核验为 tell)。
  const macIntel = isMac && gpu.v.includes('(Intel)');
  const scr = isMac ? pick(MAC_SCREENS, subHash(h, 3)) : pick(WIN_SCREENS, subHash(h, 3));
  const tz = pick(US_TZ, subHash(h, 4));
  const hwc = pick(HWC, subHash(h, 5));
  const memRaw = pick(MEM, subHash(h, 6));
  const deviceMemory = Math.min(8, memRaw); // Chrome 实际上报上限 8
  const dpr = isMac ? 2 : pick([1, 1, 1.25, 1.5], subHash(h, 7)); // mac 视网膜=2
  const ua = isMac ? UA_MAC : UA_WIN;

  const _prof = {
    // ── TLS / HTTP 头层(ctls.js applyFp 用;JA3 恒定)──
    ua, ja3: _JA3, secChUa: SEC_CH_UA,
    platform: isMac ? '"macOS"' : '"Windows"',
    arch: (isMac && !macIntel) ? '"arm"' : '"x86"', bitness: '"64"',
    platformVersion: isMac ? '"14.5.0"' : '"15.0.0"',
    chromeFull: CHROME_FULL,
    // ── JS 指纹层(sentinel-gen ENV / so-token 用)──
    navPlatform: isMac ? 'MacIntel' : 'Win32',
    languages: ['en-US', 'en'], language: 'en-US',
    hardwareConcurrency: hwc,
    deviceMemory,
    devicePixelRatio: dpr,
    screen: {
      width: scr.w, height: scr.h,
      availWidth: scr.w, availHeight: scr.h - scr.taskbar,
      colorDepth: 24, pixelDepth: 24,
    },
    // 视口(略小于可用区,贴近真实开窗)
    innerWidth: scr.w - (isMac ? 0 : 0),
    innerHeight: scr.h - scr.taskbar - (isMac ? 92 : 130),
    webgl: {
      vendor: 'WebKit', renderer: 'WebKit WebGL',
      unmaskedVendor: gpu.v, unmaskedRenderer: gpu.r,
    },
    timezone: tz.tz, timezoneOffset: tz.off,
    // 指纹噪声种子(canvas/audio 按此产生"每号不同但稳定"的值)
    canvasSeed: subHash(h, 11) >>> 0,
    audioSeed: subHash(h, 12) >>> 0,
    jsHeapSizeLimit: pick([2172649472, 4294705152, 3221225472], subHash(h, 13)),
    _hash: h,
  };
  // 优先用从 MostLogin 采到的真实指纹(与代理真实地理自洽)覆盖程序化默认值;未采到则退回程序化。
  const _real = _realFpCache.get(String(seed));
  return _real ? { ..._prof, ..._real } : _prof;
}

export { _JA3 as JA3, SEC_CH_UA, CHROME_FULL };
