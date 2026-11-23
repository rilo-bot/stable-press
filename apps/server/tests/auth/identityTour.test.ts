// The first-run tour flag rides on the identity: only an explicit `true` shows it,
// so a missing field, a legacy string or a stray truthy value never pops a tour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withIdentityDefaults } from '../../src/lib/identity.js';

test('tourPending is strictly true-only', () => {
  assert.equal(withIdentityDefaults({ id: 'u', tourPending: true }).tourPending, true);
  assert.equal(withIdentityDefaults({ id: 'u' }).tourPending, false);
  assert.equal(withIdentityDefaults({ id: 'u', tourPending: 'true' }).tourPending, false);
  assert.equal(withIdentityDefaults({ id: 'u', tourPending: 1 }).tourPending, false);
});
