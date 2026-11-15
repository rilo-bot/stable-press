// ---------------------------------------------------------------------------
// Lifting the pictures out of an attached PDF — the worker's pure decisions
// (apps/worker/src/jobs/documentPhotos.ts, finding C45). Lives with the server tests
// because the worker has no test runner of its own and the module imports nothing
// but node:crypto and the import-free media.ts.
//
// The bug: a PDF attached in the Design Helper was read to text only, so "use the
// horse photo from page 2 of the PDF" had no photo to place and the Studio reached
// for a stranger's stock picture. What is pinned here is what each lifted picture
// becomes in the library — findable by its document and page, never ranked for the
// wrong magazine page, and stored once.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DOCUMENT_PHOTO_LIMITS,
  documentPhotoBatch,
  documentPhotoDedupe,
  documentPhotoKey,
  documentPhotoRow,
  documentPictureKind,
  documentPictureWorthKeeping,
  pictureFingerprint,
} from '../../../worker/src/jobs/documentPhotos.js';
import { isPlaceableMedia, mediaOrigin } from '../../src/lib/magazineV2/media.js';

const MAG = '665f1c2ab3e4d5f6a7b8c9d0';

const row = (over: Partial<Parameters<typeof documentPhotoRow>[0]> = {}) =>
  documentPhotoRow({
    magazineId: MAG,
    docId: 'doc-1',
    docName: 'Results.pdf',
    docPage: 2,
    n: 1,
    key: `public/magazinesV2/${MAG}/media/a.jpg`,
    url: 'https://bucket/a.jpg',
    contentType: 'image/jpeg',
    size: 1234,
    natural: { width: 1600, height: 1067 },
    hasAlpha: false,
    fingerprint: 'abc',
    now: '2026-11-15T00:00:00.000Z',
    ...over,
  });

test('a lifted picture is a placeable library row that names its document and page', () => {
  const r = row();
  assert.equal(r.kind, 'photo');
  assert.equal(r.source, 'extracted');
  assert.equal(r.alt, 'Results.pdf — page 2, picture 1');
  assert.equal(r.docName, 'Results.pdf');
  assert.equal(r.docPage, 2);
  assert.equal(r.docId, 'doc-1');
  assert.equal(r.width, 1600);
  assert.equal(r.height, 1067);
  assert.equal(isPlaceableMedia(r as { kind: string; url: string }), true);
  // What list_media and the media panel say about it.
  assert.equal(mediaOrigin(r as Parameters<typeof mediaOrigin>[0]), 'from “Results.pdf”, page 2');
});

test('it belongs to no magazine page, so it is never ranked for the page that shares its number', () => {
  assert.equal(row().pageIndex, null);
});

test('a picture with transparency is a graphic (shown whole); an opaque one a photo', () => {
  assert.equal(documentPictureKind(true), 'graphic');
  assert.equal(documentPictureKind(false), 'photo');
  assert.equal(row({ hasAlpha: true }).kind, 'graphic');
});

test('bullets, icons and thumbnails are not kept; real pictures are', () => {
  const min = DOCUMENT_PHOTO_LIMITS.minSidePx;
  assert.equal(documentPictureWorthKeeping(null), false);
  assert.equal(documentPictureWorthKeeping({ width: 2000, height: min - 1 }), false);
  assert.equal(documentPictureWorthKeeping({ width: min, height: min }), true);
  assert.equal(documentPictureWorthKeeping({ width: 1600, height: 900 }), true);
});

test('the same picture always has the same fingerprint, and a different one does not', () => {
  const a = Buffer.from('decoded pixels A');
  assert.equal(pictureFingerprint(a), pictureFingerprint(Buffer.from('decoded pixels A')));
  assert.notEqual(pictureFingerprint(a), pictureFingerprint(Buffer.from('decoded pixels B')));
  assert.equal(row({ fingerprint: 'f00' }).contentHash, 'f00');
});

test('each picture gets its own key in the magazine media folder', () => {
  const a = documentPhotoKey(MAG, 'png');
  const b = documentPhotoKey(MAG, 'png');
  assert.notEqual(a, b);
  assert.match(a, new RegExp(`^public/magazinesV2/${MAG}/media/[0-9a-f-]{36}\\.png$`));
  // An extension that is not a plain short word never reaches the key.
  assert.match(documentPhotoKey(MAG, '../x'), /\.jpg$/);
});

test('page and picture numbers are whole and 1-based; an unnamed document still reads', () => {
  const r = row({ docPage: 0, n: 0, docName: '  ' });
  assert.equal(r.docPage, 1);
  assert.equal(r.docName, 'document');
  assert.equal(r.alt, 'document — page 1, picture 1');
  // No size known: no width/height fields at all (never a guess).
  const unsized = row({ natural: null });
  assert.equal('width' in unsized, false);
  assert.equal('height' in unsized, false);
});

test('a long document is read a batch of pages per run, so other jobs are not held up', () => {
  const B = DOCUMENT_PHOTO_LIMITS.batchPages;
  assert.deepEqual(documentPhotoBatch(undefined, 3), { start: 0, end: 3, next: null });
  assert.deepEqual(documentPhotoBatch(0, B + 5), { start: 0, end: B, next: B });
  assert.deepEqual(documentPhotoBatch(B, B + 5), { start: B, end: B + 5, next: null });
  // Never past the page cap, however long the file.
  const last = documentPhotoBatch(DOCUMENT_PHOTO_LIMITS.maxPages - 1, 500);
  assert.equal(last.end, DOCUMENT_PHOTO_LIMITS.maxPages);
  assert.equal(last.next, null);
  // A junk or stale start reads nothing it should not.
  assert.deepEqual(documentPhotoBatch(-4, 3), { start: 0, end: 3, next: null });
  assert.deepEqual(documentPhotoBatch(99, 3), { start: 3, end: 3, next: null });
  assert.deepEqual(documentPhotoBatch('2', 3), { start: 0, end: 3, next: null });
  assert.deepEqual(documentPhotoBatch(0, 0), { start: 0, end: 0, next: null });
});

// ── The same PDF attached again ──────────────────────────────────────────────

test('pictures are de-duplicated across the magazine, not per upload', () => {
  const rows = [
    { _id: 'docA', kind: 'doc', originalName: 'Brochure.pdf', size: 5_000_000, contentType: 'application/pdf' },
    { _id: 'p1', kind: 'photo', docId: 'docA', contentHash: 'h1' },
    { _id: 'p2', kind: 'graphic', docId: 'docA', contentHash: 'h2' },
    { _id: 'docB', kind: 'doc', originalName: 'Brochure.pdf', size: 5_000_000, contentType: 'application/pdf' },
    { _id: 'docC', kind: 'doc', originalName: 'Results.pdf', size: 80_000, contentType: 'application/pdf' },
    { _id: 'up', kind: 'photo', source: 'upload' },
  ];
  // A second upload of the same file: its twin's pictures are in the library already.
  const b = documentPhotoDedupe(rows, 'docB');
  assert.equal(b.twinDocId, 'docA');
  assert.deepEqual([...b.seen].sort(), ['h1', 'h2']);
  assert.equal(b.existing, 0);
  // A different document still runs, and still skips any picture already stored.
  const c = documentPhotoDedupe(rows, 'docC');
  assert.equal(c.twinDocId, null);
  assert.deepEqual([...c.seen].sort(), ['h1', 'h2']);
  // A continuation of the first upload counts its own pictures and is never a "twin".
  const a = documentPhotoDedupe(rows, 'docA');
  assert.equal(a.existing, 2);
  assert.equal(a.twinDocId, null);
  // A twin with no pictures yet is no reason to skip.
  assert.equal(documentPhotoDedupe(rows.filter((r) => r.docId !== 'docA'), 'docB').twinDocId, null);
});
