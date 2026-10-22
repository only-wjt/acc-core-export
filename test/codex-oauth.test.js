import test from 'node:test'
import assert from 'node:assert/strict'
import { parseAccountTestSSE, isUnsupportedCodexModel, groupIdForPlan, matchAccountByEmail } from '../src/codex-oauth.js'
import { shutdownCycleTLS } from '../src/ctls.js'

test.after(async () => {
  await shutdownCycleTLS().catch(() => {})
})

test('parseAccountTestSSE accepts a completed stream', () => {
  const body = [
    'data: {"type":"test_start","model":"gpt-5"}',
    '',
    'data: {"type":"content","text":"ok"}',
    '',
    'data: {"type":"test_complete","success":true}',
    '',
  ].join('\n')
  const got = parseAccountTestSSE(body)
  assert.equal(got.ok, true)
  assert.equal(got.text, 'ok')
  assert.equal(got.error, '')
})

test('parseAccountTestSSE rejects an error event even if complete follows', () => {
  const body = [
    'data: {"type":"error","error":"401 unauthorized"}',
    'data: {"type":"test_complete","success":true}',
  ].join('\n')
  const got = parseAccountTestSSE(body)
  assert.equal(got.ok, false)
  assert.equal(got.error, '401 unauthorized')
})

test('parseAccountTestSSE rejects a body that is not a stream', () => {
  const got = parseAccountTestSSE('{"data":null}')
  assert.equal(got.ok, false)
})

test('isUnsupportedCodexModel only matches the ChatGPT model gate', () => {
  assert.equal(isUnsupportedCodexModel("The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account."), true)
  assert.equal(isUnsupportedCodexModel('401 unauthorized'), false)
})

test('groupIdForPlan keeps prolite out of Plus', () => {
  assert.equal(groupIdForPlan('plus'), 2)
  assert.equal(groupIdForPlan('prolite'), 3)
  assert.equal(groupIdForPlan('go'), 3)
  assert.equal(groupIdForPlan('pro'), 4)
  assert.equal(groupIdForPlan('pro_20x'), 4)
  assert.equal(groupIdForPlan('free'), 0)
  assert.equal(groupIdForPlan(''), 0)
})

test('matchAccountByEmail updates the same mailbox instead of a lookalike', () => {
  const items = [
    { id: 9, name: 'other@mail.com' },
    { id: 10, name: 'Aesculapius_Olsontuh@mail.com', extra: { email: 'Aesculapius_Olsontuh@mail.com' } },
  ]
  assert.equal(matchAccountByEmail(items, 'aesculapius_olsontuh@mail.com')?.id, 10)
  assert.equal(matchAccountByEmail(items, 'olsontuh@mail.com'), null)
})
