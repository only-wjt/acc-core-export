import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const protocolContext = new AsyncLocalStorage();
const STATIC_RESOURCE_RE = /\.(?:avif|css|gif|ico|jpe?g|map|mp4|png|svg|webp|woff2?)(?:\?|$)/i;
const SECRET_KEY_RE = /authorization|cookie|password|passwd|secret|session|token|csrf|otp|verification|code_verifier|refresh|access|id_token/i;
const EMAIL_KEY_RE = /email|login_hint|username/i;
const CAPTURE_ROOT = process.env.CAPTURE_DIR
  || (process.platform === 'win32' ? 'D:/accounthub/captures' : path.resolve('captures'));

function safeName(value) {
  return String(value || 'capture').replace(/[^a-zA-Z0-9_.@-]/g, '_');
}

function isSecretKey(key) {
  return SECRET_KEY_RE.test(String(key || '')) || /^(?:code|p|pin|proof)$/i.test(String(key || ''));
}

export function sanitizeUrl(raw) {
  try {
    const url = new URL(String(raw));
    for (const key of [...url.searchParams.keys()]) {
      url.searchParams.set(key, isSecretKey(key) || EMAIL_KEY_RE.test(key) ? '[REDACTED]' : '[value]');
    }
    url.hash = '';
    return url.toString();
  } catch {
    return String(raw || '').slice(0, 500);
  }
}

export function sanitizeHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (isSecretKey(key)) out[key] = '[REDACTED]';
    else if (/referer|origin/i.test(key)) out[key] = sanitizeUrl(value);
    else out[key] = String(value).slice(0, 500);
  }
  return out;
}

function sanitizeValue(value, key = '') {
  if (isSecretKey(key) || EMAIL_KEY_RE.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitizeValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 80).map(([childKey, child]) => [childKey, sanitizeValue(child, childKey)]));
  }
  if (typeof value === 'string') return value.slice(0, 1000);
  return value;
}

export function sanitizeBody(body) {
  if (body == null || body === '') return null;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  try { return sanitizeValue(JSON.parse(text)); } catch {}
  try {
    const params = new URLSearchParams(text);
    if ([...params.keys()].length) {
      return Object.fromEntries([...params.entries()].map(([key, value]) => [
        key,
        isSecretKey(key) || EMAIL_KEY_RE.test(key) ? '[REDACTED]' : value.slice(0, 1000),
      ]));
    }
  } catch {}
  return `[unparsed body: ${Buffer.byteLength(text)} bytes]`;
}

export function createTrafficCapture({ email, transport, experimentId = null } = {}) {
  const startedAt = Date.now();
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-');
  const dir = path.join(CAPTURE_ROOT, safeName(experimentId || `gpt-ab-${stamp.slice(0, 10)}`));
  const file = path.join(dir, `${safeName(email)}-${safeName(transport)}-${stamp}.jsonl`);
  const entries = [];
  let phase = 'registration';
  let finished = false;

  const capture = {
    email,
    transport,
    file,
    setPhase(value) { phase = String(value || 'unknown'); },
    add(entry) {
      if (finished) return;
      entries.push({ at: Date.now(), phase, ...entry });
    },
    finish(summary = {}) {
      if (finished) return file;
      finished = true;
      mkdirSync(dir, { recursive: true });
      const lines = [
        { type: 'meta', version: 1, email, transport, experimentId, startedAt },
        ...entries,
        { type: 'summary', finishedAt: Date.now(), requestCount: entries.filter((entry) => entry.type === 'request').length, ...summary },
      ];
      writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
      return file;
    },
  };
  return capture;
}

export function attachBrowserCapture(context, capture) {
  const requests = new Map();
  const onRequest = (request) => {
    const url = request.url();
    if (!/^https?:/i.test(url) || STATIC_RESOURCE_RE.test(url)) return;
    const entry = {
      type: 'request', transport: 'chrome', method: request.method(), url: sanitizeUrl(url),
      resourceType: request.resourceType(), headers: sanitizeHeaders(request.headers()),
      body: sanitizeBody(request.postData()),
    };
    requests.set(request, entry);
    capture.add(entry);
  };
  const onResponse = (response) => {
    const request = response.request();
    if (!requests.has(request)) return;
    capture.add({
      type: 'response', transport: 'chrome', method: request.method(), url: sanitizeUrl(request.url()),
      status: response.status(), headers: sanitizeHeaders(response.headers()),
    });
  };
  const onFailed = (request) => {
    if (!requests.has(request)) return;
    capture.add({
      type: 'failure', transport: 'chrome', method: request.method(), url: sanitizeUrl(request.url()),
      error: String(request.failure()?.errorText || 'request failed').slice(0, 500),
    });
  };
  context.on('request', onRequest);
  context.on('response', onResponse);
  context.on('requestfailed', onFailed);
  return () => {
    context.off('request', onRequest);
    context.off('response', onResponse);
    context.off('requestfailed', onFailed);
  };
}

export function withProtocolCapture(capture, fn) {
  return capture ? protocolContext.run(capture, fn) : fn();
}

// 把「当前步骤」写进活动 capture，使每个 ctlsFetch 记录都带上它所属步骤（供订单审计树按步骤分组）。
// 无活动 capture 时静默返回，对非直充流程零影响。
export function setProtocolPhase(step) {
  const capture = protocolContext.getStore();
  if (capture && typeof capture.setPhase === 'function') capture.setPhase(step);
}

// 内存版 capture：只在内存累积已脱敏的请求/响应条目，不落文件。用于直充订单的请求级审计树。
// 上限 200 条，避免异常流程把 db.json 撑大；沿用同一套 sanitize（密钥/卡/邮箱已脱敏）。
export function createMemoryCapture() {
  const entries = [];
  let phase = 'init';
  return {
    entries,
    setPhase(value) { phase = String(value || 'unknown'); },
    add(entry) { if (entries.length < 200) entries.push({ at: Date.now(), phase, ...entry }); },
  };
}

// 把扁平的 request/response/failure 条目按步骤(phase)分组，供前端渲染「步骤 → 请求」审计树。
export function summarizeCapture(entries = []) {
  const order = [];
  const byPhase = new Map();
  for (const e of entries) {
    const step = e.phase || 'unknown';
    if (!byPhase.has(step)) { byPhase.set(step, []); order.push(step); }
    byPhase.get(step).push({
      type: e.type, method: e.method, url: e.url,
      status: e.status ?? null, durationMs: e.durationMs ?? null, error: e.error || null,
    });
  }
  return order.map((step) => ({ step, requests: byPhase.get(step) }));
}

export function beginProtocolRequest(url, opts = {}) {
  const capture = protocolContext.getStore();
  if (!capture) return null;
  const startedAt = Date.now();
  const method = String(opts.method || 'GET').toUpperCase();
  const safeUrl = sanitizeUrl(url);
  capture.add({
    type: 'request', transport: 'protocol', method, url: safeUrl,
    headers: sanitizeHeaders(opts.headers), body: sanitizeBody(opts.body),
  });
  return {
    response(status, headers) {
      capture.add({ type: 'response', transport: 'protocol', method, url: safeUrl, status, durationMs: Date.now() - startedAt, headers: sanitizeHeaders(headers) });
    },
    failure(error) {
      capture.add({ type: 'failure', transport: 'protocol', method, url: safeUrl, durationMs: Date.now() - startedAt, error: String(error?.message || error).slice(0, 500) });
    },
  };
}
