import { testSub2Account } from '../src/codex-oauth.js'
import { shutdownCycleTLS } from '../src/ctls.js'

if (!process.env.S2_KEY) {
  console.error('FAIL 缺少 S2_KEY')
  process.exit(1)
}
const accountId = Number(process.env.S2_ACCOUNT_ID || 0)
if (!accountId) {
  console.error('FAIL 缺少 S2_ACCOUNT_ID')
  process.exitCode = 1
} else {
  testSub2Account({
    base: process.env.S2_BASE || 'http://127.0.0.1:8080',
    key: process.env.S2_KEY || '',
    accountId,
    modelId: process.env.S2_TEST_MODEL || '',
    log: (m) => console.log(m),
  }).then((out) => {
    console.log(`ok model=${out.model} text=${out.text || ''}`)
  }).catch((e) => {
    console.error('FAIL', e.message)
    process.exitCode = 1
  }).finally(() => shutdownCycleTLS().catch(() => {}))
}
