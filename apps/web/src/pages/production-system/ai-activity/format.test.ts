// Run: npx tsx --test src/pages/production-system/ai-activity/format.test.ts (from apps/web)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duration } from './format';

test('durations never show "60s" — whole seconds are rounded before minutes are split off', () => {
  // 1,619.6s was shown as "26m 60s" on the Magazines list.
  assert.equal(duration(1_619_600), '27m');
  assert.equal(duration(59_600), '1m');
  assert.equal(duration(362_000), '6m 2s');
  assert.equal(duration(32_000), '32s');
  assert.equal(duration(6_500), '6.5s');
  assert.equal(duration(450), '450ms');
  assert.equal(duration(0), '—');
});
