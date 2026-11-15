// Run: npx tsx --test src/editor-v2/pageCopy.test.ts   (from apps/web)
// When a "Copy a page exactly" run is finished, what failed, and whether the copied
// page still matches the magazine's size (findings C23, C25, C53).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COPY_FAST_PHASE_MS,
  COPY_GRACE_MS,
  COPY_POLL_FAST_MS,
  COPY_POLL_SLOW_MS,
  copyFailureText,
  copyNoticeText,
  copyPollInterval,
  copyState,
  describeSize,
  mostCommonSize,
  pageNoticeText,
  pageSizeNote,
  paperName,
  sameSize,
} from './pageCopy';

const A4 = { width: 1240, height: 1754 };
const LETTER = { width: 1275, height: 1650 };

test('pending stays pending', () => {
  assert.equal(copyState({ status: 'pending', rev: 4 }, { rev: 3, seenPending: true }, 60_000), 'pending');
});

test('seen pending, now extracted = done (even when the rev did not move)', () => {
  assert.equal(copyState({ status: 'extracted', rev: 3 }, { rev: 3, seenPending: true }, 5_000), 'done');
});

test('the rev moved without pending ever being seen = done (a fast worker)', () => {
  assert.equal(copyState({ status: 'extracted', rev: 5 }, { rev: 3, seenPending: false }, 1_000), 'done');
});

test('an earlier failed copy does not read as this copy failing at once', () => {
  // Same rev, never seen pending, inside the grace window: not started yet.
  assert.equal(copyState({ status: 'failed', rev: 3 }, { rev: 3, seenPending: false }, 1_000), 'pending');
  // Past the grace window the stored state is taken as the answer.
  assert.equal(copyState({ status: 'failed', rev: 3 }, { rev: 3, seenPending: false }, COPY_GRACE_MS), 'failed');
});

test('seen pending, now failed = failed', () => {
  assert.equal(copyState({ status: 'failed', rev: 3 }, { rev: 3, seenPending: true }, 4_000), 'failed');
});

test('a page that disappeared is gone', () => {
  assert.equal(copyState(undefined, { rev: 3, seenPending: true }, 4_000), 'gone');
});

test('poll interval slows down after the fast phase', () => {
  assert.equal(copyPollInterval(0), COPY_POLL_FAST_MS);
  assert.equal(copyPollInterval(COPY_FAST_PHASE_MS + 1), COPY_POLL_SLOW_MS);
});

test('the failure text prefers the page’s own stored reason', () => {
  assert.equal(copyFailureText({ status: 'failed', rev: 1, error: '  That PDF is password-protected.  ' }, 3), 'That PDF is password-protected.');
  assert.match(copyFailureText({ status: 'failed', rev: 1, error: '' }, 3), /copy onto page 3 failed/);
  assert.match(copyFailureText(undefined, 7), /page 7/);
});

test('notice text for pages copied as a picture', () => {
  assert.match(copyNoticeText('scanned')!, /scan/);
  assert.match(copyNoticeText('no-text')!, /no text layer/);
  assert.equal(copyNoticeText(''), undefined);
  assert.equal(copyNoticeText(undefined), undefined);
});

test('pageNoticeText speaks only while the page is still the picture it describes', () => {
  const pic = { type: 'image' };
  assert.match(pageNoticeText('scanned', pic)!, /scanned PDF page/);
  assert.match(pageNoticeText('no-text', pic)!, /drawn as shapes/);
  // Both say what to do instead.
  assert.match(pageNoticeText('scanned', pic)!, /add new text over it/);
  // A replaced background (a colour now) no longer shows the old words: no banner.
  assert.equal(pageNoticeText('scanned', { type: 'color' }), undefined);
  assert.equal(pageNoticeText('scanned', null), undefined);
  assert.equal(pageNoticeText('', pic), undefined);
  assert.equal(pageNoticeText(undefined, pic), undefined);
});

test('sameSize tolerates extractor rounding, not a different paper', () => {
  assert.ok(sameSize(A4, { width: 1241, height: 1753 }));
  assert.ok(!sameSize(A4, LETTER));
});

test('mostCommonSize picks the size most pages share', () => {
  assert.deepEqual(mostCommonSize([A4, LETTER, A4, { width: 1240, height: 1755 }]), A4);
  assert.equal(mostCommonSize([]), null);
  assert.equal(mostCommonSize([{ width: 0, height: 0 }]), null);
});

test('paper names at the export DPI', () => {
  assert.equal(paperName(A4), 'A4 portrait');
  assert.equal(paperName(LETTER), 'US Letter portrait');
  assert.equal(paperName({ width: 1754, height: 1240 }), 'A4 landscape');
  assert.equal(paperName({ width: 1350, height: 900 }), null);
  assert.equal(describeSize(A4), 'A4 portrait (8.27 × 11.69 in)');
  assert.equal(describeSize({ width: 1350, height: 900 }), '9.00 × 6.00 in');
});

test('pageSizeNote: a Letter page in an A4 magazine is named with both sizes', () => {
  const note = pageSizeNote(LETTER, 3, [A4, A4, A4]);
  assert.ok(note);
  assert.match(note!, /Page 3/);
  assert.match(note!, /US Letter portrait \(8\.50 × 11\.00 in\)/);
  assert.match(note!, /A4 portrait \(8\.27 × 11\.69 in\)/);
});

test('pageSizeNote: nothing to say when the size matches or there is nothing to compare', () => {
  assert.equal(pageSizeNote(A4, 2, [A4, A4]), null);
  assert.equal(pageSizeNote(LETTER, 1, []), null);
  assert.equal(pageSizeNote({ width: 0, height: 0 }, 1, [A4]), null);
});
