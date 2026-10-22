import { authorizeCodexAccount } from '../src/codex-oauth.js'
import { shutdownCycleTLS } from '../src/ctls.js'

function parseProxy(raw) {
  if (!raw) return null
  try {
    const u = new URL(raw)
    return {
      host: u.hostname,
      port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)),
      username: decodeURIComponent(u.username || '') || undefined,
      password: decodeURIComponent(u.password || '') || undefined,
      protocol: (u.protocol || 'http:').replace(':', ''),
    }
  } catch {
    return raw
  }
}

if (!process.env.S2_KEY) {
  console.error('FAIL 缺少 S2_KEY')
  process.exit(1)
}
const email = process.env.GPT_EMAIL || ''
const mailPassword = process.env.MAIL_PASSWORD || ''
const gptPassword = process.env.GPT_PASSWORD || ''

authorizeCodexAccount({
  email,
  mailPassword,
  gptPassword,
  proxy: parseProxy(process.env.PROXY),
  groupId: Number(process.env.S2_GROUP_ID || 0),
  accountId: Number(process.env.S2_ACCOUNT_ID || 0),
  s2Base: process.env.S2_BASE || 'http://127.0.0.1:8080',
  s2Key: process.env.S2_KEY || '',
  log: (m) => console.log(m),
}).then((out) => {
  console.log(`ok id=${out.accountId} plan=${out.plan || ''} test=${out.test.text || 'ok'}`)
}).catch((e) => {
  console.error('FAIL', e.message)
  process.exitCode = 1
}).finally(() => shutdownCycleTLS().catch(() => {}))
