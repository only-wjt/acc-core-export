import test from 'node:test';
import assert from 'node:assert/strict';
import { isRegionBlock, REGION_RE, CATEGORY_LABELS } from '../server/error-classify.js';

test('isRegionBlock matches unsupported-country messages', () => {
  assert.ok(isRegionBlock(new Error('unsupported_country')));
  assert.ok(isRegionBlock('ChatGPT is not available in your country'));
  assert.ok(isRegionBlock("OpenAI's services are not available in your region"));
  assert.ok(isRegionBlock('当前地区不可用'));
  assert.ok(isRegionBlock('该出口地区不支持'));
});

test('isRegionBlock does not match generic risk/proxy errors', () => {
  assert.ok(!isRegionBlock(new Error('429 rate limited')));
  assert.ok(!isRegionBlock(new Error('ECONNREFUSED proxy down')));
  assert.ok(!isRegionBlock(new Error('wrong password')));
  assert.ok(!isRegionBlock(''));
});

test('region has a label and a stable regex', () => {
  assert.equal(CATEGORY_LABELS.region, '地区不支持');
  assert.ok(REGION_RE instanceof RegExp);
});
