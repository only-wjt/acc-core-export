import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, summarizeJob } from '../server/logger.js';

function fakeSink() {
  const lines = [];
  const push = (line) => lines.push(line);
  return { lines, log: push, warn: push, error: push };
}

test('respects LOG_LEVEL threshold', () => {
  const sink = fakeSink();
  const log = createLogger({ level: 'warn', sink });
  log.debug('d');
  log.info('i');
  log.warn('w');
  log.error('e');
  assert.equal(sink.lines.length, 2);
  assert.match(sink.lines[0], /WARN w/);
  assert.match(sink.lines[1], /ERROR e/);
});

test('redacts secrets in message and data', () => {
  const sink = fakeSink();
  const log = createLogger({ level: 'info', sink });
  log.info('accessToken=abc123 done', { sessionToken: 'eyJsecret' });
  const line = sink.lines[0];
  assert.doesNotMatch(line, /abc123/);
  assert.doesNotMatch(line, /eyJsecret/);
  assert.match(line, /已隐藏/);
});

test('summarizeJob builds a category histogram from failed items', () => {
  const summary = summarizeJob('session', {
    id: 'j1',
    status: 'completed',
    createdAt: 1000,
    finishedAt: 4000,
    counts: { total: 4, success: 1, failed: 3, cancelled: 0 },
    items: [
      { status: 'success' },
      { status: 'failed', errorCategory: 'region' },
      { status: 'failed', errorCategory: 'proxy' },
      { status: 'failed', errorCategory: 'proxy' },
    ],
  });
  assert.equal(summary.total, 4);
  assert.equal(summary.failed, 3);
  assert.deepEqual(summary.categories, { region: 1, proxy: 2 });
  assert.equal(summary.durationMs, 3000);
});
