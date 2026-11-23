// ---------------------------------------------------------------------------
// Pending shares — a magazine shared with someone before they are on the team.
//
// The contract: the owner shares ONCE. When the person joins, planClaim turns the
// pending row into a real collaborator with exactly the pages the owner picked,
// and the owner never has to share again.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planClaim,
  prunePendingPageId,
  upsertPendingShare,
  withoutPendingShare,
  type PendingShare,
} from '../../src/lib/magazineV2/pendingShares.js';

const OWNER = 'u_owner';
const NEW = 'u_new';

const pending = (email: string, pageIds: string[] | 'all', createdAt = '2026-11-01T00:00:00.000Z'): PendingShare => ({
  email,
  pageIds,
  invitedBy: OWNER,
  invitedByName: 'Owner',
  createdAt,
});

const issue = (over: Record<string, unknown> = {}) => ({
  _id: 'm1',
  ownerId: OWNER,
  collaborators: [{ userId: 'u_sam', email: 's@x.com', displayName: 'Sam', pageIds: ['p1'] }],
  pendingCollaborators: [pending('new@x.com', ['p2', 'p3'])],
  ...over,
});

test('claim: the new member becomes a collaborator with exactly the shared pages', () => {
  const plan = planClaim(issue(), { id: NEW, email: 'new@x.com', name: 'Nia' });
  assert.ok(plan);
  assert.deepEqual(plan.pendingCollaborators, []);
  assert.deepEqual(plan.collaborators.at(-1), { userId: NEW, email: 'new@x.com', displayName: 'Nia', pageIds: ['p2', 'p3'] });
  // Existing collaborators are untouched.
  assert.equal(plan.collaborators[0]!.userId, 'u_sam');
});

test('claim: address matching ignores case and surrounding spaces', () => {
  const plan = planClaim(issue(), { id: NEW, email: '  NEW@X.com ' });
  assert.ok(plan);
  assert.equal(plan.collaborators.at(-1)!.email, 'new@x.com');
  // No name yet → shown by email, never blank.
  assert.equal(plan.collaborators.at(-1)!.displayName, 'new@x.com');
});

test('claim: nothing pending for this address → null (no write)', () => {
  assert.equal(planClaim(issue(), { id: NEW, email: 'someone@else.com' }), null);
  assert.equal(planClaim(issue(), { id: NEW, email: '' }), null);
});

test('claim: other pending people stay pending', () => {
  const doc = issue({ pendingCollaborators: [pending('new@x.com', 'all'), pending('later@x.com', ['p1'])] });
  const plan = planClaim(doc, { id: NEW, email: 'new@x.com' })!;
  assert.deepEqual(plan.pendingCollaborators.map((p) => p.email), ['later@x.com']);
  assert.equal(plan.collaborators.at(-1)!.pageIds, 'all');
});

test('claim: an existing collaborator is widened, not duplicated', () => {
  const doc = issue({ pendingCollaborators: [pending('s@x.com', ['p2'])] });
  const plan = planClaim(doc, { id: 'u_sam', email: 's@x.com' })!;
  assert.equal(plan.collaborators.length, 1);
  assert.deepEqual(plan.collaborators[0]!.pageIds, ['p1', 'p2']);
});

test('claim: the owner never becomes their own collaborator', () => {
  const doc = issue({ pendingCollaborators: [pending('owner@x.com', 'all')] });
  const plan = planClaim(doc, { id: OWNER, email: 'owner@x.com' })!;
  assert.deepEqual(plan.pendingCollaborators, []);
  assert.equal(plan.collaborators.some((c) => c.userId === OWNER), false);
});

test('upsert: re-sharing a pending address changes its pages, keeps first-invited time', () => {
  const list = [pending('new@x.com', ['p1'], '2026-11-01T00:00:00.000Z')];
  const next = upsertPendingShare(list, pending('NEW@x.com', 'all', '2026-11-20T00:00:00.000Z'));
  assert.equal(next.length, 1);
  assert.equal(next[0]!.pageIds, 'all');
  assert.equal(next[0]!.createdAt, '2026-11-01T00:00:00.000Z');
  assert.equal(upsertPendingShare(list, pending('b@x.com', 'all')).length, 2);
});

test('withoutPendingShare removes by address, case-insensitively', () => {
  assert.deepEqual(withoutPendingShare([pending('a@x.com', 'all'), pending('b@x.com', 'all')], 'A@X.COM').map((p) => p.email), ['b@x.com']);
});

test('page delete prunes pending scopes; untouched → null', () => {
  const doc = issue({ pendingCollaborators: [pending('a@x.com', ['p2', 'p3']), pending('b@x.com', 'all')] });
  const next = prunePendingPageId(doc, 'p2')!;
  assert.deepEqual(next[0]!.pageIds, ['p3']);
  assert.equal(next[1]!.pageIds, 'all');
  assert.equal(prunePendingPageId(doc, 'p9'), null);
});
