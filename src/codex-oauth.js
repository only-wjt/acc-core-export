// Codex 授权进 Sub2API。一次调用只处理一个号，cookie、验证码和设备号都在这次调用里。
// 不同邮箱可以并行调用。同一个邮箱同时只能有一次授权，mail.com 登录态按邮箱缓存。
import * as mail from './mail.js'
import { AUTH0, extractCookies, mergeCookies, uuid, traceHeaders } from './gpt-shared.js'
import { headers, browserHeaders, applyFp, pickFingerprint, ctlsFetch } from './ctls.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function isTLS(status, raw = '') {
  return status === 495 || status === 408 || /uTlsConn|Syscall Error|Handshake/i.test(String(raw))
}

function b64json(part) {
  const s = String(part || '').replace(/-/g, '+').replace(/_/g, '/')
  const pad = s + '='.repeat((4 - (s.length % 4)) % 4)
  return JSON.parse(Buffer.from(pad, 'base64').toString('utf8'))
}

function cookieValue(jar, name) {
  const hit = String(jar || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='))
  return hit ? hit.slice(name.length + 1) : ''
}

function workspaceIds(jar, html) {
  const ids = []
  const add = (id) => {
    const v = String(id || '').trim()
    if (v && !ids.includes(v)) ids.push(v)
  }
  const text = String(html || '')
  for (const m of text.matchAll(/"workspace_id"\s*:\s*"([^"]+)"/g)) add(m[1])
  for (const m of text.matchAll(/"workspaces"\s*:\s*\[([\s\S]*?)\]/g)) {
    for (const id of m[1].matchAll(/"id"\s*:\s*"([^"]+)"/g)) add(id[1])
  }
  // 确认页是 React Router 流，个人号的工作区写成 \"workspaces\" ... \"id\",\"uuid\"。
  const flat = text.replace(/\\"/g, '"')
  for (const m of flat.matchAll(/"workspaces"[\s\S]{0,800}?"id"\s*,\s*"([0-9a-f-]{36})"/gi)) add(m[1])
  const cookie = cookieValue(jar, 'oai-client-auth-session')
  if (!cookie) return ids
  let raw = cookie
  try { raw = decodeURIComponent(cookie) } catch { /* keep */ }
  const take = (j) => {
    if (!j || typeof j !== 'object') return
    add(j.workspace_id)
    const list = Array.isArray(j.workspaces) ? j.workspaces : []
    for (const w of list) add(w?.id || w?.workspace_id)
  }
  for (const part of raw.split('.')) {
    if (part.length < 8) continue
    try { take(b64json(part)) } catch { /* not json */ }
  }
  return ids
}

function parseCallback(url) {
  try {
    const u = new URL(url, 'http://localhost')
    if ((u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.pathname.includes('/auth/callback')) {
      const code = u.searchParams.get('code')
      const state = u.searchParams.get('state')
      if (code) return { code, state }
    }
  } catch { /* ignore */ }
  return null
}

function withLoginHint(authURL, hint) {
  try {
    const u = new URL(authURL)
    if (!u.searchParams.get('login_hint')) u.searchParams.set('login_hint', hint)
    return u.toString()
  } catch {
    return authURL
  }
}

function shortURL(u) { return String(u || '').slice(0, 120) }

const CHATGPT_CODEX_TEST_MODELS = ['gpt-5.3-codex', 'gpt-5.4-mini', 'gpt-5.2', 'gpt-5.1']

export function isUnsupportedCodexModel(error) {
  return /not supported when using Codex with a ChatGPT account/i.test(String(error || ''))
}

export function parseAccountTestSSE(body) {
  let success = false
  let error = ''
  const texts = []
  for (const line of String(body || '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    let event = null
    try { event = JSON.parse(trimmed.replace(/^data:\s*/, '')) } catch { continue }
    if (event?.type === 'content' && event.text) texts.push(event.text)
    if (event?.type === 'error' && event.error) error = String(event.error)
    if (event?.type === 'test_complete' && event.success) success = true
  }
  return { ok: success && !error, error, text: texts.join('').slice(0, 180) }
}

async function s2send(base, key, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'x-api-key': key,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* raw */ }
  if (!res.ok) throw new Error(`sub2api ${method} ${path} HTTP ${res.status}: ${text.slice(0, 240)}`)
  return json?.data ?? json
}

async function s2json(base, key, path, body) {
  return s2send(base, key, 'POST', path, body || {})
}

// 值班台分组：Plus=2，Go=3，Pro=4。ChatGPT Go 在接口里经常是 prolite。
export const DEFAULT_PLAN_GROUPS = { plus: 2, go: 3, pro: 4 }
const PLAN_GROUP_KEY = {
  plus: 'plus',
  go: 'go',
  prolite: 'go',
  pro: 'pro',
  pro_5x: 'pro',
  pro_20x: 'pro',
}

export function groupIdForPlan(plan, groups = DEFAULT_PLAN_GROUPS) {
  const key = PLAN_GROUP_KEY[String(plan || '').trim().toLowerCase()]
  const id = key ? Number(groups[key]) || 0 : 0
  return id > 0 ? id : 0
}

export function matchAccountByEmail(items, email) {
  const want = String(email || '').trim().toLowerCase()
  if (!want) return null
  for (const item of items || []) {
    const name = String(item?.name || '').trim().toLowerCase()
    const extra = String(item?.extra?.email || item?.email || '').trim().toLowerCase()
    if (name === want || extra === want) return item
  }
  return null
}

function accountPlan(account) {
  return String(account?.extra?.plan_type || account?.credentials?.plan_type || '').trim()
}

async function findAccountIdByEmail(base, key, email) {
  const data = await s2send(
    base,
    key,
    'GET',
    `/api/v1/admin/accounts?platform=openai&search=${encodeURIComponent(email)}&page=1&page_size=50&lite=1`,
  )
  const hit = matchAccountByEmail(data?.items, email)
  return hit?.id ? Number(hit.id) : 0
}

async function readAccountPlan(base, key, id, known) {
  if (known) return known
  const account = await s2send(base, key, 'GET', `/api/v1/admin/accounts/${id}`)
  return accountPlan(account)
}

async function moveToPlanGroup({ base, key, id, plan, fallbackGroupId, log }) {
  const dest = groupIdForPlan(plan)
  const group = dest || (!plan && Number(fallbackGroupId) > 0 ? Number(fallbackGroupId) : 0)
  try {
    await s2send(base, key, 'PUT', `/api/v1/admin/accounts/${id}`, { group_ids: group ? [group] : [] })
  } catch (err) {
    if (!String(err?.message || err).includes('GROUP_NOT_FOUND')) throw err
    log(`分组 ${group || '空'} 不存在，号先留在号池里`)
    return 0
  }
  if (dest) log(`套餐 ${plan} 放入分组 ${group}`)
  else if (group) log(`套餐未知，沿用分组 ${group}`)
  else log(`套餐 ${plan || '未知'} 没有对应付费分组，已移出分组`)
  return group
}

async function setSchedulable(base, key, id, on) {
  await s2send(base, key, 'POST', `/api/v1/admin/accounts/${id}/schedulable`, { schedulable: !!on })
}

const authorizing = new Set()

async function postAccountTest({ base, key, accountId, modelId }) {
  const res = await fetch(`${base}/api/v1/admin/accounts/${accountId}/test`, {
    method: 'POST',
    headers: { 'x-api-key': key, Accept: 'text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'default', model_id: modelId, prompt: 'Reply with ok' }),
    signal: AbortSignal.timeout(120000),
  })
  const text = await res.text()
  if (!res.ok && !text.includes('data:')) {
    throw new Error(`访问测试 HTTP ${res.status}: ${text.slice(0, 180)}`)
  }
  return parseAccountTestSSE(text)
}

export async function testSub2Account({ base, key, accountId, modelId = '', log = () => {} }) {
  const models = modelId ? [modelId] : CHATGPT_CODEX_TEST_MODELS
  let last = { ok: false, error: '', text: '' }
  for (const model of models) {
    log(`测试模型 ${model}`)
    last = await postAccountTest({ base, key, accountId, modelId: model })
    if (last.ok) {
      log(`测试通过 ${model}`)
      return { ...last, model }
    }
    log(`测试没通过 ${model} ${(last.error || '').slice(0, 160)}`)
    if (!isUnsupportedCodexModel(last.error)) break
  }
  throw new Error(last.error || '访问测试没有成功结果')
}

async function drainOldOtps(email, mailPassword, proxy, seen, log) {
  const walk = async (p) => {
    for (const folder of ['INBOX', 'SPAM']) {
      const { mails } = await mail.listMail(email, mailPassword, { page: 0, size: 20, folder, proxy: p })
      for (const m of mails || []) {
        if (m.date && Date.now() - new Date(m.date).getTime() > 20 * 60 * 1000) continue
        const subj = String(m.subject || '')
        const subjCode = /\b(\d{6})\b/.exec(subj)
        if (subjCode) seen.add(subjCode[1])
        if (!/verification code|login code|verification|passcode|one-time|验证码|\bcode\b/i.test(subj)) continue
        try {
          const html = await mail.getBody(email, mailPassword, m.id, p)
          const bodyCode = /\b(\d{6})\b/.exec(String(html).replace(/<[^>]+>/g, ' '))
          if (bodyCode) seen.add(bodyCode[1])
        } catch { /* 读不了就跳过这封 */ }
      }
    }
  }
  try { await walk(proxy) } catch (e) { log(`预扫跳过: ${String(e.message || e).slice(0, 60)}`) }
  if (proxy) {
    try { await walk(null) } catch (e) { log(`直连预扫跳过: ${String(e.message || e).slice(0, 60)}`) }
  }
}

async function followCodex({ authFetch, oaiDid, authURL, email, gptPassword, getOtp, log }) {
  let jar = ''
  const authJSON = (extra = {}) => headers({
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: AUTH0,
    Cookie: jar,
    ...traceHeaders(),
    'oai-device-id': oaiDid,
    ...extra,
  })

  async function postJSON(url, body, referer) {
    let last = null
    for (let i = 0; i < 3; i++) {
      const resp = await authFetch(url, {
        method: 'POST',
        headers: authJSON({ Referer: referer }),
        body: JSON.stringify(body),
        redirect: 'manual',
      })
      jar = mergeCookies(jar, extractCookies(resp))
      const raw = await resp.text().catch(() => '')
      if (isTLS(resp.status, raw) && i < 2) {
        log(`POST TLS ${resp.status}，重试 ${i + 1}/2`)
        await sleep(800 * (i + 1))
        last = { resp, raw, data: null }
        continue
      }
      let data = null
      try { data = raw ? JSON.parse(raw) : null } catch { data = null }
      return { resp, raw, data }
    }
    return last
  }

  let current = withLoginHint(authURL, email)
  let tlsHits = 0
  for (let hop = 0; hop < 24; hop++) {
    const hit = parseCallback(current)
    if (hit) return hit
    log(`[oauth ${hop}] ${shortURL(current)}`)
    let resp
    try {
      resp = await authFetch(current, {
        headers: headers({ Cookie: jar, Referer: AUTH0 + '/', ...traceHeaders(), 'oai-device-id': oaiDid }),
        redirect: 'manual',
      })
    } catch (e) {
      const fromMsg = String(e.message || e).match(/https?:\/\/(?:localhost|127\.0\.0\.1)[^ \]]+/i)
      if (fromMsg) {
        const cb = parseCallback(fromMsg[0])
        if (cb) return cb
      }
      throw e
    }
    if (isTLS(resp.status) && tlsHits < 3) {
      tlsHits += 1
      log(`oauth TLS ${resp.status}，重试 ${tlsHits}/3`)
      await sleep(1000 * tlsHits)
      hop -= 1
      continue
    }
    jar = mergeCookies(jar, extractCookies(resp))
    const loc = resp.headers.get('location') || ''
    if (loc) {
      current = new URL(loc, current).toString()
      const cb = parseCallback(current)
      if (cb) return cb
      continue
    }
    const body = await resp.text().catch(() => '')
    try {
      const j = JSON.parse(body)
      if (j.continue_url) {
        current = new URL(j.continue_url, current).toString()
        continue
      }
    } catch { /* landing page */ }

    if (/\/add-phone/i.test(current)) throw new Error('Codex 授权停在 add-phone（需要手机）')

    if (/sign-in-with-chatgpt|codex\/consent/i.test(current)) {
      const ids = workspaceIds(jar, body)
      log(`确认页工作区 ${ids.length} 个`)
      if (!ids.length) throw new Error('确认页没有工作区，授权不能继续')
      let sel = null
      for (const id of ids) {
        sel = await postJSON(`${AUTH0}/api/accounts/workspace/select`, { workspace_id: id }, current)
        log(`[workspace] status=${sel.resp.status} continue=${shortURL(sel.data?.continue_url)}`)
        if (sel.resp.status < 400 && (sel.data?.continue_url || sel.resp.headers.get('location'))) break
      }
      const next = sel?.resp.headers.get('location') || sel?.data?.continue_url || ''
      if (!next) throw new Error(`选工作区失败(${sel?.resp?.status || 0})`)
      current = new URL(next, AUTH0).toString()
      continue
    }

    if (/log-in-or-create-account/i.test(current)) {
      const pick = await postJSON(`${AUTH0}/api/accounts/authorize/continue`, { username: { value: email, kind: 'email' } }, current)
      log(`[pick] status=${pick.resp.status} page=${pick.data?.page?.type || ''}`)
      const next = pick.resp.headers.get('location') || pick.data?.continue_url || ''
      if (!next) throw new Error('选账号没有 continue_url')
      current = new URL(next, AUTH0).toString()
      continue
    }

    if (/\/log-in\/?(\?|$)/i.test(current) && !/password|email-verification/i.test(current)) {
      const em = await postJSON(`${AUTH0}/api/accounts/authorize/continue`, { username: { value: email, kind: 'email' } }, `${AUTH0}/log-in`)
      const next = em.data?.continue_url || em.resp.headers.get('location') || ''
      current = next ? new URL(next, AUTH0).toString() : `${AUTH0}/log-in/password`
      continue
    }

    if (/log-in\/password/i.test(current)) {
      if (!gptPassword) throw new Error('落到密码页，但这条号只有邮箱密码')
      const pwd = await postJSON(`${AUTH0}/api/accounts/password/verify`, { password: gptPassword }, `${AUTH0}/log-in/password`)
      log(`[pwd] status=${pwd.resp.status} page=${pwd.data?.page?.type || ''}`)
      if (pwd.resp.status >= 400 && !pwd.data?.page) throw new Error(`密码验证失败(${pwd.resp.status})`)
      if (pwd.data?.continue_url) {
        current = new URL(pwd.data.continue_url, AUTH0).toString()
        continue
      }
    }

    if (/email-verification/i.test(current)) {
      let otp = null
      for (let attempt = 1; attempt <= 2; attempt++) {
        const code = await getOtp()
        if (!code) throw new Error('没拿到邮箱验证码')
        log(`提交 OTP（第 ${attempt} 个新码）`)
        otp = await postJSON(`${AUTH0}/api/accounts/email-otp/validate`, { code }, `${AUTH0}/email-verification`)
        log(`[otp] status=${otp.resp.status} continue=${shortURL(otp.data?.continue_url)}`)
        if (otp.resp.status !== 401) break
        log('这个码已失效，等下一封')
      }
      if (!otp || otp.resp.status >= 400) throw new Error(`OTP验证失败(${otp?.resp?.status || 0})`)
      if (otp.data?.continue_url) {
        current = new URL(otp.data.continue_url, AUTH0).toString()
        continue
      }
    }

    throw new Error(`Codex 授权停在 HTTP ${resp.status} ${shortURL(current)}`)
  }
  throw new Error('没截到 Codex code')
}

// 一个号走完：要授权地址 → 邮箱验证码 → 选工作区 → 建号或更新原行 → 按套餐分组 → 访问测试。
// 测试没通过会把号标成不可调度再抛错。同一邮箱已有行时更新凭据，不新建。
export async function authorizeCodexAccount(opts) {
  const email = String(opts?.email || '').trim()
  const lock = email.toLowerCase()
  if (!lock) throw new Error('缺少邮箱或邮箱密码')
  if (authorizing.has(lock)) throw new Error('同一邮箱正在授权，等这次结束再跑')
  authorizing.add(lock)
  try {
    return await authorizeCodexAccountOnce({ ...opts, email })
  } finally {
    authorizing.delete(lock)
  }
}

// 已有号按当前套餐改分组，并按访问结果开关调度。不重新登录。
export async function alignExistingAccount({
  accountId,
  schedulable,
  fallbackGroupId = 0,
  s2Base = 'http://127.0.0.1:8080',
  s2Key,
  log = () => {},
}) {
  const id = Number(accountId) || 0
  if (!id) throw new Error('缺少账号 id')
  if (!s2Key) throw new Error('缺少 Sub2API key')
  const account = await s2send(s2Base, s2Key, 'GET', `/api/v1/admin/accounts/${id}`)
  const plan = accountPlan(account)
  const say = (m) => log(`[${account?.name || id}] ${m}`)
  const groupId = await moveToPlanGroup({
    base: s2Base, key: s2Key, id, plan, fallbackGroupId, log: say,
  })
  let scheduled = account?.schedulable
  if (typeof schedulable === 'boolean') {
    await setSchedulable(s2Base, s2Key, id, schedulable)
    scheduled = schedulable
    say(schedulable ? '已恢复可调度' : '已标成不可调度')
  }
  return { accountId: id, name: account?.name || '', plan, groupId, schedulable: scheduled }
}

async function authorizeCodexAccountOnce({
  email,
  mailPassword,
  gptPassword = '',
  proxy = null,
  groupId = 0,
  accountId = 0,
  concurrency = 3,
  skipTest = false,
  s2Base = 'http://127.0.0.1:8080',
  s2Key,
  log = () => {},
}) {
  email = String(email || '').trim()
  mailPassword = String(mailPassword || '')
  if (!email || !mailPassword) throw new Error('缺少邮箱或邮箱密码')
  if (!s2Key) throw new Error('缺少 Sub2API key')
  const say = (m) => log(`[${email}] ${m}`)

  const auth = await s2json(s2Base, s2Key, '/api/v1/admin/openai/generate-auth-url', {})
  if (!auth?.auth_url || !auth?.session_id) throw new Error('generate-auth-url 失败')
  say('已拿到授权地址')

  const seen = new Set()
  await drainOldOtps(email, mailPassword, proxy, seen, say)
  if (seen.size) say(`已忽略 ${seen.size} 个旧验证码`)
  const getOtp = async () => {
    const isNew = (found) => {
      const key = found?.code || found
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    }
    say('等邮箱验证码')
    try {
      const code = await mail.waitForOTP(email, mailPassword, { maxMs: 90000, proxy, isNew })
      if (code) return code
    } catch (e) {
      say(`代理读信失败: ${String(e.message || e).slice(0, 80)}`)
    }
    say('直连重读邮箱')
    return mail.waitForOTP(email, mailPassword, { maxMs: 60000, proxy: null, isNew })
  }

  const fp = pickFingerprint(email)
  const oaiDid = uuid()
  const authFetch = (url, opts = {}) =>
    ctlsFetch(url, { ...opts, headers: applyFp(browserHeaders(opts.headers || {}), fp), ja3: fp.ja3 }, proxy)
  const oauth = await followCodex({
    authFetch, oaiDid, authURL: auth.auth_url, email, gptPassword, getOtp, log: say,
  })
  if (!oauth?.code) throw new Error('没截到 Codex code')
  say('已拿到授权码')

  const tokens = await s2json(s2Base, s2Key, '/api/v1/admin/openai/exchange-code', {
    session_id: auth.session_id,
    code: oauth.code,
    state: oauth.state,
  })
  if (!tokens?.refresh_token || !tokens?.access_token) throw new Error('exchange 没有 RT/AT')
  let plan = tokens.plan_type || ''
  let name = tokens.email || email
  const credentials = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    id_token: tokens.id_token,
    expires_at: tokens.expires_at,
    client_id: tokens.client_id,
    email: tokens.email,
    chatgpt_account_id: tokens.chatgpt_account_id,
    chatgpt_user_id: tokens.chatgpt_user_id,
    plan_type: tokens.plan_type,
  }
  const extra = {
    email: tokens.email || email,
    ...(tokens.plan_type ? { plan_type: tokens.plan_type } : {}),
  }

  let id = Number(accountId) || 0
  if (!id) {
    id = await findAccountIdByEmail(s2Base, s2Key, email)
    if (id) say(`同一邮箱已有号 id=${id}，这次更新凭据`)
  }
  if (!id) {
    const created = await s2json(s2Base, s2Key, '/api/v1/admin/accounts', {
      name: email,
      platform: 'openai',
      type: 'oauth',
      credentials,
      extra,
      concurrency: Math.max(1, Number(concurrency) || 3),
      priority: 0,
      group_ids: [],
    })
    id = created?.id
    name = created?.name || name
    if (!id) throw new Error('建号没有返回 id')
    say(`已建号 id=${id}`)
  } else {
    await s2json(s2Base, s2Key, `/api/v1/admin/accounts/${id}/apply-oauth-credentials`, {
      type: 'oauth',
      credentials,
      extra,
    })
    say(`已更新凭据 id=${id}`)
  }

  plan = await readAccountPlan(s2Base, s2Key, id, plan)
  const placedGroup = await moveToPlanGroup({
    base: s2Base, key: s2Key, id, plan, fallbackGroupId: groupId, log: say,
  })
  const handed = {
    accountId: id,
    name,
    plan,
    groupId: placedGroup,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
  }
  if (skipTest) {
    await setSchedulable(s2Base, s2Key, id, false)
    say('先不测访问，等充值完成后再测')
    return { ...handed, schedulable: false, skippedTest: true }
  }

  let test
  try {
    test = await testSub2Account({ base: s2Base, key: s2Key, accountId: id, log: say })
  } catch (e) {
    await setSchedulable(s2Base, s2Key, id, false).catch((pauseErr) => {
      say(`标成不可调度失败: ${pauseErr.message}`)
    })
    say('访问测试没通过，已标成不可调度')
    throw new Error(`号已在 Sub2API（id=${id}），访问测试没通过：${e.message}`)
  }
  await setSchedulable(s2Base, s2Key, id, true)
  return { ...handed, schedulable: true, test }
}
