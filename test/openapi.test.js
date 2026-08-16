import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiKeys } from '../server/api-keys.js';
import { createOpenApi } from '../server/openapi.js';

async function tempFile() {
  return join(await mkdtemp(join(tmpdir(), 'acc-openapi-')), 'api-keys.json');
}

function mockRes() {
  return {
    status: 0,
    body: null,
    headers: {},
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers || {};
    },
    end(text) {
      this.body = text ? JSON.parse(text) : null;
    },
  };
}

function url(path) {
  return new URL(path, 'http://127.0.0.1');
}

test('health is public; other routes need a key', async () => {
  const apiKeys = createApiKeys({ file: await tempFile(), envKey: '' });
  const openApi = createOpenApi({
    apiKeys,
    manager: { create() { throw new Error('unused'); }, get() { return null; }, cancel() { return null; } },
    checkManager: { create() { throw new Error('unused'); }, get() { return null; }, cancel() { return null; } },
    jobOwners: new Map(),
    adminSettings: { get() { return { proxyText: '' }; } },
    gpt: { totpCode() { return '000000'; } },
    mail: {},
  });

  const health = mockRes();
  await openApi.handle({ method: 'GET', headers: {} }, health, url('/openapi/v1/health'), {});
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.authRequired, false);

  const denied = mockRes();
  await openApi.handle({ method: 'GET', headers: {} }, denied, url('/openapi/v1/me'), {});
  assert.equal(denied.status, 503);
});

test('valid key can create a session job and only see its own task', async () => {
  const apiKeys = createApiKeys({ file: await tempFile(), envKey: '' });
  const created = apiKeys.create({ name: 'cdk', concurrency: 2, actor: { username: 'alice', role: 'admin', concurrency: 2 } });
  const jobs = new Map();
  const jobOwners = new Map();
  const manager = {
    create({ input, concurrency }) {
      const job = {
        id: '11111111-1111-1111-1111-111111111111',
        status: 'running',
        createdAt: 1,
        finishedAt: null,
        concurrency,
        counts: { total: 1, pending: 1, running: 0, success: 0, failed: 0, cancelled: 0 },
        items: [{ email: input.split('----')[0], status: 'pending', stage: '等待开始' }],
        sessions: [],
      };
      jobs.set(job.id, job);
      return { ok: true, job };
    },
    get(id) { return jobs.get(id) || null; },
    cancel() { return null; },
  };
  const openApi = createOpenApi({
    apiKeys,
    manager,
    checkManager: { create() { return { ok: false, errors: [] }; }, get() { return null; }, cancel() { return null; } },
    jobOwners,
    adminSettings: { get() { return { proxyText: '' }; } },
    gpt: { totpCode() { return '123456'; } },
    mail: {},
  });
  const headers = { authorization: `Bearer ${created.key}` };

  const createdJob = mockRes();
  await openApi.handle({ method: 'POST', headers }, createdJob, url('/openapi/v1/sessions'), {
    accounts: [{ email: 'a@mail.com', gptPassword: 'g', mailPassword: 'm' }],
  });
  assert.equal(createdJob.status, 202);
  assert.equal(createdJob.body.id, '11111111-1111-1111-1111-111111111111');
  assert.equal(jobOwners.get(createdJob.body.id), `apikey:${created.item.id}`);

  const other = mockRes();
  await openApi.handle({ method: 'GET', headers }, other, url('/openapi/v1/sessions/22222222-2222-2222-2222-222222222222'), {});
  assert.equal(other.status, 404);

  const me = mockRes();
  await openApi.handle({ method: 'GET', headers }, me, url('/openapi/v1/me'), {});
  assert.equal(me.status, 200);
  assert.equal(me.body.name, 'cdk');
  assert.equal(me.body.owner, 'alice');
  assert.equal(me.body.concurrency, 2);
});

test('docs are public and rate limit returns 429', async () => {
  const apiKeys = createApiKeys({
    file: await tempFile(),
    envKey: '',
    getLimits: () => ({ maxKeysPerUser: 3, rateLimitPerMinute: 1 }),
  });
  const created = apiKeys.create({ name: 'cdk', actor: { username: 'alice', role: 'user', concurrency: 1 } });
  const openApi = createOpenApi({
    apiKeys,
    manager: { create() { return { ok: false, errors: [] }; }, get() { return null; }, cancel() { return null; } },
    checkManager: { create() { return { ok: false, errors: [] }; }, get() { return null; }, cancel() { return null; } },
    jobOwners: new Map(),
    adminSettings: { get() { return { proxyText: '' }; } },
    gpt: { totpCode() { return '000000'; } },
    mail: {},
  });

  const docs = mockRes();
  await openApi.handle({ method: 'GET', headers: {} }, docs, url('/openapi/v1/docs'), {});
  assert.equal(docs.status, 200);
  assert.ok(docs.body.endpoints.length > 3);

  const headers = { authorization: `Bearer ${created.key}` };
  const first = mockRes();
  await openApi.handle({ method: 'GET', headers }, first, url('/openapi/v1/me'), {});
  assert.equal(first.status, 200);
  const second = mockRes();
  await openApi.handle({ method: 'GET', headers }, second, url('/openapi/v1/me'), {});
  assert.equal(second.status, 429);
});
