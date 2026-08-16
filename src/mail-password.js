const ACCOUNT_ORIGIN = 'https://account-lxa.mail.com';
const PASSWORD_PATH = '/ciss/security/edit/passwordChange';
const TOKEN_RE = /^[0-9a-f-]{36}$/i;

function decodeHtmlAttribute(value) {
  return String(value || '')
    .replace(/&amp;|&#38;|&#x26;/gi, '&')
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/');
}
function accountUrl(value, baseUrl = ACCOUNT_ORIGIN) {
  try {
    const url = new URL(decodeHtmlAttribute(value), baseUrl);
    if (url.origin !== ACCOUNT_ORIGIN) return null;
    return url;
  } catch {
    return null;
  }
}

function tokenFromUrl(value) {
  const url = accountUrl(value);
  const token = url?.searchParams.get('srttkn') || '';
  return TOKEN_RE.test(token) ? token : '';
}

function tokenFromHtml(html) {
  const match = decodeHtmlAttribute(html).match(/(?:[?&]|\b)srttkn=([0-9a-f-]{36})/i);
  return match?.[1] || '';
}

function pushUnique(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

export function passwordChangePageCandidates(overviewHtml, overviewUrl) {
  const candidates = [];
  const current = accountUrl(overviewUrl);
  const token = tokenFromUrl(overviewUrl) || tokenFromHtml(overviewHtml);

  if (current?.pathname === PASSWORD_PATH) pushUnique(candidates, current.href);

  // The mounted Wicket page is stable even when the account overview no longer
  // renders the old changePasswordLink anchor. Let Wicket allocate a fresh page
  // instance, with ?0 as a compatibility fallback for older deployments.
  const direct = new URL(PASSWORD_PATH, ACCOUNT_ORIGIN);
  if (token) direct.searchParams.set('srttkn', token);
  pushUnique(candidates, direct.href);
  if (token) pushUnique(candidates, `${ACCOUNT_ORIGIN}${PASSWORD_PATH}?0&srttkn=${encodeURIComponent(token)}`);

  const html = String(overviewHtml || '');
  for (const match of html.matchAll(/\b(?:href|action)\s*=\s*(["'])(.*?)\1/gi)) {
    const raw = decodeHtmlAttribute(match[2]);
    if (!/(?:changePasswordLink|\/security\/edit\/passwordChange)/i.test(raw)) continue;
    const url = accountUrl(raw, overviewUrl);
    if (url) pushUnique(candidates, url.href);
  }
  return candidates;
}

export function isPasswordChangePage(html, pageUrl) {
  const url = accountUrl(pageUrl);
  if (url?.pathname !== PASSWORD_PATH) return false;
  const body = decodeHtmlAttribute(html);
  return /editPanel:currentPasswordPanel/i.test(body)
    && /editPanel:newPasswordFieldPanel/i.test(body)
    && /editPanel:retypeNewPasswordFieldPanel/i.test(body);
}

function appendSaveFlag(value) {
  if (/[?&]saveChanges(?:=|&|$)/.test(value)) return value;
  const hashAt = value.indexOf('#');
  const base = hashAt >= 0 ? value.slice(0, hashAt) : value;
  const hash = hashAt >= 0 ? value.slice(hashAt) : '';
  return `${base}${base.includes('?') ? '&' : '?'}saveChanges=x${hash}`;
}

export function passwordChangeSubmitUrl(pageHtml, pageUrl) {
  const html = String(pageHtml || '');
  for (const match of html.matchAll(/<form\b[^>]*\baction\s*=\s*(["'])(.*?)\1[^>]*>/gi)) {
    const url = accountUrl(match[2], pageUrl);
    if (url?.pathname === PASSWORD_PATH) return appendSaveFlag(url.href);
  }

  // Compatibility fallback for the captured Wicket shape:
  //   render ?3&srttkn=... -> submit ?3-1.-form&srttkn=...&saveChanges=x
  const rendered = accountUrl(pageUrl);
  if (rendered?.pathname !== PASSWORD_PATH) throw new Error('修改密码接口返回了意外地址');
  const pageKey = [...rendered.searchParams.keys()].find((key) => /^\d+$/.test(key));
  const token = tokenFromUrl(rendered.href) || tokenFromHtml(html);
  if (!pageKey || !token) throw new Error('修改密码接口缺少动态表单地址');
  return `${ACCOUNT_ORIGIN}${PASSWORD_PATH}?${pageKey}-1.-form&srttkn=${encodeURIComponent(token)}&saveChanges=x`;
}
