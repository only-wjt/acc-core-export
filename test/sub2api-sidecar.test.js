import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSub2Sidecar } from '../server/sub2api-sidecar.js';
import { createAdminSettings } from '../server/admin-settings.js';

// 全程不 spawn 真进程、不发真请求：副作用换成假对象，跑完整个文件只需要几十毫秒。
function quietLogger() {
  const messages = [];
  return {
    messages,
    debug: (m) => messages.push(m),
    info: (m) => messages.push(m),
    warn: (m) => messages.push(m),
    error: (m) => messages.push(m),
  };
}

function fakeChild(pid = 4321) {
  const handlers = { error: [], exit: [], data: [] };
  const child = {
    pid,
    signals: [],
    stdout: { setEncoding() {}, on() {} },
    stderr: { setEncoding() {}, on() {} },
    on(event, handler) { (handlers[event] ||= []).push(handler); return child; },
    once(event, handler) { (handlers[event] ||= []).push(handler); return child; },
    emit(event, ...args) {
      for (const handler of [...(handlers[event] || [])]) handler(...args);
    },
    kill(signal) {
      child.signals.push(signal);
      // 真实进程收到 SIGTERM 会退出，先把退出事件补上，stop() 才不会等满宽限期。
      if (signal === 'SIGTERM') setImmediate(() => child.emit('exit', 0, signal));
      return true;
    },
  };
  return child;
}

async function makeRoot() {
  const dir = await mkdtemp(join(tmpdir(), 'acc-sub2-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'console-server.mjs'), '// stub\n', 'utf8');
  return dir;
}

function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers || {};
    },
    end(body) {
      this.body = body || '';
    },
  };
}

test('status before start reports disabled and missing root', () => {
  const sidecar = createSub2Sidecar({ logger: quietLogger(), rootDir: '', port: 4399 });
  const state = sidecar.status();
  assert.equal(state.enabled, false);
  assert.equal(state.running, false);
  assert.equal(state.ready, false);
  assert.equal(state.port, 4399);
  assert.equal(state.pid, null);
  assert.equal(state.error, '未找到 toSub2 目录');
});

test('start spawns once, caches the console token', async () => {
  const root = await makeRoot();
  const spawns = [];
  const probes = [];
  const sidecar = createSub2Sidecar({
    logger: quietLogger(),
    enabled: true,
    rootDir: root,
    port: 4400,
    spawnImpl: (cmd, args, options) => {
      const child = fakeChild(1000 + spawns.length);
      spawns.push({ cmd, args, options, child });
      return child;
    },
    probeImpl: async (port) => {
      probes.push(port);
      return { token: 'tok-abc', features: {} };
    },
  });

  const [first, second] = await Promise.all([sidecar.start(), sidecar.start()]);
  assert.equal(spawns.length, 1, '并发 start 只能起一个进程');
  assert.equal(first.ready, true);
  assert.equal(second.token, 'tok-abc');
  assert.deepEqual(probes, [4400]);

  const { cmd, args, options } = spawns[0];
  assert.equal(cmd, process.execPath);
  assert.deepEqual(args, ['src/console-server.mjs', '--port', '4400']);
  assert.equal(options.cwd, root);
  assert.equal(options.env.ONBOARDING_HOST, '127.0.0.1');

  // 第二次 start 是幂等的：已有进程就不再 spawn
  await sidecar.start();
  assert.equal(spawns.length, 1);

  const state = sidecar.status();
  assert.equal(state.running, true);
  assert.equal(state.ready, true);
  assert.equal(state.pid, spawns[0].child.pid);
  assert.equal(state.token, 'tok-abc');
});

test('start with a missing rootDir reports the error and spawns nothing', async () => {
  const spawns = [];
  const sidecar = createSub2Sidecar({
    logger: quietLogger(),
    enabled: true,
    rootDir: join(tmpdir(), 'acc-sub2-does-not-exist'),
    spawnImpl: () => {
      spawns.push(1);
      return fakeChild();
    },
    probeImpl: async () => ({ token: 'x' }),
  });

  const state = await sidecar.start();
  assert.equal(spawns.length, 0);
  assert.equal(state.running, false);
  assert.equal(state.error, '未找到 toSub2 目录');
});

test('stop terminates the child and clears the token', async () => {
  const root = await makeRoot();
  const child = fakeChild();
  const sidecar = createSub2Sidecar({
    logger: quietLogger(),
    enabled: true,
    rootDir: root,
    port: 4401,
    spawnImpl: () => child,
    probeImpl: async () => ({ token: 'tok-stop' }),
    stopGraceMs: 50,
  });

  await sidecar.start();
  assert.equal(sidecar.status().running, true);

  await sidecar.stop();
  assert.deepEqual(child.signals, ['SIGTERM']);

  const state = sidecar.status();
  assert.equal(state.running, false);
  assert.equal(state.token, '');
  // 主动 stop 不该被记成「异常退出」
  assert.equal(state.error, '');
});

test('proxy injects the console token and passes the status through', async () => {
  const root = await makeRoot();
  const calls = [];
  const sidecar = createSub2Sidecar({
    logger: quietLogger(),
    enabled: true,
    rootDir: root,
    port: 4402,
    spawnImpl: () => fakeChild(),
    probeImpl: async () => ({ token: 'tok-proxy' }),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        status: 403,
        headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
        text: async () => JSON.stringify({ error: 'Invalid console token' }),
      };
    },
  });
  await sidecar.start();

  const res = fakeRes();
  await sidecar.proxy({ method: 'POST' }, res, 'jobs', { email: 'a@example.com' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:4402/api/jobs');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['x-console-token'], 'tok-proxy');
  assert.deepEqual(JSON.parse(calls[0].init.body), { email: 'a@example.com' });

  assert.equal(res.status, 403, '上游状态码必须原样透传');
  assert.equal(JSON.parse(res.body).error, 'Invalid console token');
});

test('proxy before start answers 503 without touching the network', async () => {
  const calls = [];
  const sidecar = createSub2Sidecar({
    logger: quietLogger(),
    enabled: true,
    rootDir: await makeRoot(),
    fetchImpl: async () => {
      calls.push(1);
      return { status: 200, headers: { get: () => null }, text: async () => '{}' };
    },
  });

  const res = fakeRes();
  await sidecar.proxy({ method: 'GET' }, res, 'bootstrap');
  assert.equal(calls.length, 0);
  assert.equal(res.status, 503);
});

test('admin settings validate and persist the sub2 keys', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'acc-settings-')), 'settings.json');
  const settings = createAdminSettings({ file });

  assert.equal(settings.get().sub2Enabled, false);
  assert.equal(settings.get().sub2Port, 4399);

  const ok = settings.update({ sub2Enabled: 'true', sub2Root: '  /opt/toSub2  ', sub2Port: 4500 });
  assert.equal(ok.ok, true);
  assert.equal(ok.settings.sub2Enabled, true);
  assert.equal(ok.settings.sub2Root, '/opt/toSub2');
  assert.equal(ok.settings.sub2Port, 4500);

  const bad = settings.update({ sub2Port: 80 });
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0].message, /1024/);

  // 落盘后重新加载仍然是新值
  const reloaded = createAdminSettings({ file });
  assert.equal(reloaded.get().sub2Enabled, true);
  assert.equal(reloaded.get().sub2Port, 4500);
});
