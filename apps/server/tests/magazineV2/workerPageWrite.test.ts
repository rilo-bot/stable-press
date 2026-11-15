// ---------------------------------------------------------------------------
// Writing an extracted page — the worker's pure decisions
// (apps/worker/src/jobs/pageWrite.ts). Lives with the server tests because the
// worker has no test runner of its own and the module imports nothing but
// node:crypto.
//
// The bug that matters most here is a live data bug: a page's background was
// stored at a key built from the SOURCE page number alone, so copying page 1 of
// another PDF onto page 6 overwrote the imported cover's artwork — and the
// magazine's coverImage and every published snapshot that pointed at that URL
// changed with it. The key tests below are the guard against that coming back.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  backgroundKey,
  copiedFromOf,
  coverAfterReplace,
  pageNotice,
  PAGE_NOTICE_TEXT,
  revBump,
  sourceIndexOf,
} from '../../../worker/src/jobs/pageWrite.js';

const ISSUE = '665f1c2ab3e4d5f6a7b8c9d0';

// ── backgroundKey ────────────────────────────────────────────────────────────

test('two pages never share a background key, even when copied from the same source page', () => {
  // The collision: source page index 0 for the cover's import AND for a copy onto
  // page 6. The key no longer has the source index in it at all.
  const cover = backgroundKey({ prefix: 'public/', issueId: ISSUE, pageId: 'page-cover' });
  const page6 = backgroundKey({ prefix: 'public/', issueId: ISSUE, pageId: 'page-six' });
  assert.notEqual(cover, page6);
  assert.ok(cover.includes('/pages/page-cover/'));
  assert.ok(page6.includes('/pages/page-six/'));
});

test('every write of the SAME page gets a fresh key, so no object anyone still uses is overwritten', () => {
  // Import, retry and re-copy of one page: a published edition may still point at
  // the first URL, and a browser may have cached it.
  const keys = new Set(Array.from({ length: 50 }, () => backgroundKey({ prefix: 'public/', issueId: ISSUE, pageId: 'p1' })));
  assert.equal(keys.size, 50);
});

test('background keys live under the public prefix and the magazine, and end as a jpeg', () => {
  const key = backgroundKey({ prefix: 'public/', issueId: ISSUE, pageId: 'abc', runId: 'run-1' });
  assert.equal(key, `public/magazinesV2/${ISSUE}/pages/abc/run-1-background.jpg`);
});

test('ids are made safe to splice into a key', () => {
  const key = backgroundKey({ prefix: 'public/', issueId: '../evil', pageId: 'a/b c', runId: 'r' });
  assert.ok(!key.includes('..'));
  assert.equal(key, 'public/magazinesV2/evil/pages/a-b-c/r-background.jpg');
});

// ── revBump ──────────────────────────────────────────────────────────────────

test('a rebuilt page moves its rev, compare-and-set on the rev it was read at', () => {
  assert.deepEqual(revBump(0), { condition: { rev: 0 }, rev: 1 });
  assert.deepEqual(revBump(41), { condition: { rev: 41 }, rev: 42 });
});

test('a page with no rev is matched as null (a missing field) and starts at 1', () => {
  // `{ rev: 0 }` would never match a document with no rev, so the write would
  // loop on a conflict it can never win.
  assert.deepEqual(revBump(undefined), { condition: { rev: null }, rev: 1 });
  assert.deepEqual(revBump('3'), { condition: { rev: null }, rev: 1 });
  assert.deepEqual(revBump(Number.NaN), { condition: { rev: null }, rev: 1 });
});

// ── pageNotice ───────────────────────────────────────────────────────────────

test('a page with a text layer needs no notice', () => {
  assert.equal(pageNotice({ textBlockCount: 3, fullPageImage: true }), '');
  assert.equal(pageNotice({ textBlockCount: 1, fullPageImage: false }), '');
});

test('no text layer under a page-covering picture is a scan', () => {
  assert.equal(pageNotice({ textBlockCount: 0, fullPageImage: true }), 'scanned');
});

test('no text layer without a page-covering picture is still flagged (type drawn as outlines)', () => {
  assert.equal(pageNotice({ textBlockCount: 0, fullPageImage: false }), 'no-text');
});

test('each notice has a plain sentence that says the words cannot be edited and what to do', () => {
  for (const text of Object.values(PAGE_NOTICE_TEXT)) {
    assert.match(text, /cannot be edited/);
    assert.match(text, /add new text over it/);
  }
});

// ── provenance: sourceIndexOf / copiedFromOf ─────────────────────────────────

test('a retry re-extracts the page the import stamped, not the page position the route sent', () => {
  // Two pages were inserted ahead of it: position 5, source page 3.
  assert.equal(sourceIndexOf({ sourceIndex: 3, index: 5 }, 5), 3);
  assert.equal(sourceIndexOf({ sourceIndex: 0 }, 7), 0);
});

test('a page that predates the stamp falls back to the index the route sent', () => {
  assert.equal(sourceIndexOf({}, 4), 4);
  assert.equal(sourceIndexOf(null, 2), 2);
  assert.equal(sourceIndexOf({ sourceIndex: null }, 2), 2);
  assert.equal(sourceIndexOf({ sourceIndex: -1 }, 2), 2);
  assert.equal(sourceIndexOf({ sourceIndex: 1.5 }, 2), 2);
  assert.equal(sourceIndexOf({}, Number.NaN), 0);
});

test('a copied page names the document and 1-based page it came from; anything else is not a copy', () => {
  assert.deepEqual(copiedFromOf({ copiedFrom: { docId: ' doc-1 ', sourcePage: 4 } }), { docId: 'doc-1', sourcePage: 4 });
  assert.equal(copiedFromOf({ copiedFrom: null }), null);
  assert.equal(copiedFromOf({}), null);
  assert.equal(copiedFromOf(undefined), null);
  assert.equal(copiedFromOf({ copiedFrom: { docId: '', sourcePage: 1 } }), null);
  assert.equal(copiedFromOf({ copiedFrom: { docId: 'd', sourcePage: 0 } }), null);
  assert.equal(copiedFromOf({ copiedFrom: { docId: 'd', sourcePage: 2.5 } }), null);
});

// ── coverAfterReplace ────────────────────────────────────────────────────────

const OLD = 'https://cdn.example/public/magazinesV2/x/pages/p0/a-background.jpg';
const NEW = 'https://cdn.example/public/magazinesV2/x/pages/p0/b-background.jpg';

test('a cover derived from page 1 follows page 1 when it gets a new background', () => {
  assert.equal(coverAfterReplace({ coverImage: OLD, targetIndex: 0, previousBackground: OLD, newBackground: NEW }), NEW);
});

test('a cover the user chose is never replaced', () => {
  assert.equal(
    coverAfterReplace({ coverImage: 'https://cdn.example/chosen.jpg', targetIndex: 0, previousBackground: OLD, newBackground: NEW }),
    null,
  );
});

test('only the first page can move the cover', () => {
  assert.equal(coverAfterReplace({ coverImage: OLD, targetIndex: 5, previousBackground: OLD, newBackground: NEW }), null);
});

test('no cover, or a page with no previous picture background, leaves the cover alone', () => {
  assert.equal(coverAfterReplace({ coverImage: '', targetIndex: 0, previousBackground: '', newBackground: NEW }), null);
  assert.equal(coverAfterReplace({ coverImage: undefined, targetIndex: 0, previousBackground: OLD, newBackground: NEW }), null);
  assert.equal(coverAfterReplace({ coverImage: OLD, targetIndex: 0, previousBackground: '', newBackground: NEW }), null);
  assert.equal(coverAfterReplace({ coverImage: OLD, targetIndex: 0, previousBackground: OLD, newBackground: '' }), null);
});
