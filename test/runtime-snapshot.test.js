import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/persist.js';
import { createRuntimeKeeper } from '../server/runtime-snapshot.js';

async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), 'acc-runtime-'));
  return createStore({ dir });
}

function quietLogger() {
  const messages = [];
  return {
    messages,
    info: (m) => messages.push(m),
    warn: (m) => messages.push(m),
    error: (m) => messages.push(m),
    debug: (m) => messages.push(m),
  };
}

function runningJob(overrides = {}) {
  return {
    id: 'aaaaaaaa-1111-2222-3333-444444444444',
    status: 'running',
    createdAt: 1000,
    concurrency: 2,
    proxyCount: 1,
    counts: { total: 2, pending: 1, running: 1, success: 0, failed: 0, cancelled: 0 },
    items: [
      { index: 0, email: 'a@example.com', status: 'running', stage: '等待邮箱验证码', startedAt: 1100 },
      { index: 1, email: 'b@example.com', status: 'pending', stage: '等待开始' },
    ],
    ...overrides,
  };
}

test('snapshotRunning writes a runtime file without credentials', async () => {
  const store = await makeStore();
  const job = runningJob();
  const keeper = createRuntimeKeeper({
    store,
    managers: { session: { listRunning: () => [job] } },
    jobOwners: new Map([[job.id, 'alice']]),
    logger: quietLogger(),
  });

  const written = await keeper.snapshotRunning();
  assert.equal(written, 1);

  const files = (await readdir(store.dir)).filter((name) => name.startsWith('runtime-'));
  assert.equal(files.length, 1);
  const saved = JSON.parse(await readFile(join(store.dir, files[0]), 'utf8'));
  assert.equal(saved.id, job.id);
  assert.equal(saved.owner, 'alice');
  assert.equal(saved.items[0].stage, '等待邮箱验证码');
  // 快照只是进度，不该出现凭据字段
  assert.doesNotMatch(JSON.stringify(saved), /password|sessionToken|accessToken/i);
});

test('recover archives leftovers as interrupted and clears snapshots', async () => {
  const store = await makeStore();
  const job = runningJob();
  const keeper = createRuntimeKeeper({
    store,
    managers: { session: { listRunning: () => [job] } },
    jobOwners: new Map(),
    logger: quietLogger(),
    now: () => 9000,
  });
  await keeper.snapshotRunning();

  const recovered = await keeper.recover();
  assert.equal(recovered, 1);

  // 快照文件被清掉
  const runtimeFiles = (await readdir(store.dir)).filter((name) => name.startsWith('runtime-'));
  assert.equal(runtimeFiles.length, 0);

  // 归档里能看到中断的账号
  const archives = (await readdir(store.dir)).filter((name) => name.startsWith('session-'));
  assert.equal(archives.length, 1);
  const archived = JSON.parse(await readFile(join(store.dir, archives[0]), 'utf8'));
  assert.equal(archived.status, 'interrupted');
  assert.equal(archived.counts.total, 2);
  assert.equal(archived.counts.failed, 2);
  assert.ok(archived.items.every((item) => item.errorCategory === 'interrupted'));
  assert.match(archived.items[0].error, /服务重启/);
});

test('recover keeps already-finished items as they were', async () => {
  const store = await makeStore();
  const job = runningJob({
    items: [
      { index: 0, email: 'a@example.com', status: 'success', stage: '完成' },
      { index: 1, email: 'b@example.com', status: 'pending', stage: '等待开始' },
    ],
  });
  const keeper = createRuntimeKeeper({
    store,
    managers: { session: { listRunning: () => [job] } },
    jobOwners: new Map(),
    logger: quietLogger(),
  });
  await keeper.snapshotRunning();
  await keeper.recover();

  const archives = (await readdir(store.dir)).filter((name) => name.startsWith('session-'));
  const archived = JSON.parse(await readFile(join(store.dir, archives[0]), 'utf8'));
  assert.equal(archived.counts.success, 1);
  assert.equal(archived.counts.failed, 1);
  assert.equal(archived.items[0].status, 'success');
  assert.equal(archived.items[1].status, 'failed');
});

test('disabled store does nothing', async () => {
  const store = createStore({ dir: '' });
  const keeper = createRuntimeKeeper({
    store,
    managers: { session: { listRunning: () => [runningJob()] } },
    jobOwners: new Map(),
    logger: quietLogger(),
  });
  assert.equal(await keeper.snapshotRunning(), 0);
  assert.equal(await keeper.recover(), 0);
  assert.equal(keeper.start(), false);
});
