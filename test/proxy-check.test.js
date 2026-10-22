import test from 'node:test';
import assert from 'node:assert/strict';
import { createProxyChecker, maskProxy, UNSUPPORTED_COUNTRIES } from '../src/proxy-check.js';

function fakeFetch(map) {
  return async (_url, _opts, proxy) => {
    const entry = map[proxy];
    if (!entry) throw new Error('ECONNREFUSED');
    return { ok: true, status: 200, json: async () => entry };
  };
}

test('maskProxy strips credentials', () => {
  assert.equal(maskProxy('socks5://user:pass@1.2.3.4:1080'), 'socks5://1.2.3.4:1080');
  assert.equal(maskProxy('http://host:8080'), 'http://host:8080');
});

test('flags Hong Kong exit as unsupported', async () => {
  assert.ok(UNSUPPORTED_COUNTRIES.has('HK'));
  const checker = createProxyChecker({
    fetchImpl: fakeFetch({ 'socks5://hk': { ip: '1.1.1.1', country: 'HK' } }),
  });
  const result = await checker.checkProxy('socks5://hk');
  assert.equal(result.ok, true);
  assert.equal(result.country, 'HK');
  assert.equal(result.supported, false);
});

test('marks supported region and dead proxy distinctly', async () => {
  const checker = createProxyChecker({
    fetchImpl: fakeFetch({ 'http://us': { ip: '2.2.2.2', country: 'US' } }),
  });
  const [ok, dead] = await checker.checkProxies(['http://us', 'http://dead']);
  assert.equal(ok.supported, true);
  assert.equal(ok.country, 'US');
  assert.equal(dead.ok, false);
  assert.equal(dead.supported, null);
  assert.ok(dead.error);
});

test('does not echo proxy credentials in results', async () => {
  const checker = createProxyChecker({
    fetchImpl: fakeFetch({ 'socks5://u:secret@hk:1080': { ip: '1.1.1.1', country: 'HK' } }),
  });
  const result = await checker.checkProxy('socks5://u:secret@hk:1080');
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});
