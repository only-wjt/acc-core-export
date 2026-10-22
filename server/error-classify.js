// 地区不支持的识别：OpenAI 对香港等不支持地区会直接拒绝登录/访问。
// 单独归为 region 分类，让"换个受支持地区的代理"这类问题一眼可见，
// 不要被笼统地混进 risk（风控/人机验证）里。
//
// 注意：只有当底层报文确实带有国家/地区字样时才命中；若上游只回了裸 403 或
// Cloudflare challenge，这里识别不到——那种情况靠代理预检（见 src/proxy-check.js）兜底。
export const REGION_RE = /(unsupported_country|country[\s_-]*not[\s_-]*supported|not available in your country|services?\s+are\s+not\s+available\s+in\s+your\s+(?:country|region)|地区不支持|不支持的?(?:国家|地区)|所在地区不?可用|当前地区(?:不可用|不支持)|区域不可用)/i;

export function isRegionBlock(error) {
  return REGION_RE.test(String(error?.message || error || ''));
}

// 各分类的中文说明，前端可直接拿来展示，避免在前端再维护一份映射。
export const CATEGORY_LABELS = {
  region: '地区不支持',
  password: '密码错误',
  otp: '邮箱验证码未取到',
  risk: '风控/人机验证',
  proxy: '代理不可用',
  session: 'Session 失效',
  ineligible: '不允许改密',
  billing: '套餐操作异常',
  unknown: '未知错误',
};
