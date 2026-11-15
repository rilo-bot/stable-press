// One question, one answer: may this media row be placed on a page?
//
// The stakes are not layout. A `reference` row is somebody else's licensed magazine
// page, uploaded so the AI could read its structure — and the pool it leaked into is
// the one generation places FIRST, so it was composed into the client's magazine as a
// hero photograph, publishable to the public newsstand and exportable to PDF.
//
// The rule was restated by hand at three call sites and was wrong at one of them, so
// these tests are about the PREDICATE and about the site that got it wrong.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fitsAPhotoSlot, isPlaceableMedia, UNPLACEABLE_KINDS, userPhotosFrom, rankMediaForPage, documentPhotoAlt, mediaOrigin, imageDimensions, chooseImageSize, sizedPictures } from '../../src/lib/magazineV2/media.ts';

/** A media row exactly as POST /issues/:id/media writes one. Note `source` is
 *  'upload' for BOTH an ordinary photo and a layout reference — the two differ only
 *  by `kind`, which is the whole reason a provenance check let the reference past. */
const row = (kind: string, id = 'm1') => ({
  _id: id,
  url: `https://x/${id}.jpg`,
  alt: '',
  kind,
  source: 'upload',
});

// ── The predicate ────────────────────────────────────────────────────────────

test('a layout reference may never be placed, however it got here', () => {
  assert.equal(isPlaceableMedia({ kind: 'reference', url: 'https://x/their-page.jpg' }), false);
});

test('an uploaded document may never be placed either', () => {
  assert.equal(isPlaceableMedia({ kind: 'doc', url: 'https://x/results.pdf' }), false);
});

test("the kinds that ARE pictures stay placeable", () => {
  for (const kind of ['upload', 'photo', 'graphic']) {
    assert.equal(isPlaceableMedia({ kind, url: 'https://x/p.jpg' }), true, `${kind} should be placeable`);
  }
});

test('a row with no usable url is not placeable — it would render as a hole', () => {
  assert.equal(isPlaceableMedia({ kind: 'photo' }), false);
  assert.equal(isPlaceableMedia({ kind: 'photo', url: '' }), false);
});

test('an unknown kind FAILS SAFE — unplaceable until someone decides', () => {
  // The inverse of this was the bug: `reference` was added, the existing filters named
  // only `doc`, and four call sites treated the new kind as a photograph. Defaulting
  // unknown to placeable rebuilds that hole one kind later.
  //
  // The costs decide it. Wrongly unplaceable: a photo does not appear — visible,
  // harmless. Wrongly placeable: licensed third-party material on a public newsstand.
  assert.equal(isPlaceableMedia({ kind: 'something-new', url: 'https://x/p.jpg' }), false);
  assert.equal(isPlaceableMedia({ url: 'https://x/p.jpg' }), false, 'a row with no kind at all, too');
});

test('the exclusion list is derived from the table, so the two cannot disagree', () => {
  assert.deepEqual([...UNPLACEABLE_KINDS].sort(), ['doc', 'reference']);
});

test('every declared MediaKind has a deliberate answer', () => {
  // The compiler enforces this (PLACEABLE_BY_KIND is Record<MediaKind, boolean>, so a
  // new kind is a build error until it is decided). Asserted here as well so the
  // intent survives a refactor that loosens the type.
  const decided = ['upload', 'photo', 'graphic', 'reference', 'doc'];
  for (const kind of decided) {
    const answer = isPlaceableMedia({ kind, url: 'https://x/p.jpg' });
    assert.equal(typeof answer, 'boolean', `${kind} must have an answer`);
  }
  assert.equal(decided.filter((k) => !isPlaceableMedia({ kind: k, url: 'https://x/p.jpg' })).length, 2);
});

// ── The site that got it wrong ───────────────────────────────────────────────

test('the user photo pool excludes a layout reference', () => {
  // THE REGRESSION. loadUserPhotoPool filtered `source === 'upload' && kind !== 'doc'`,
  // and a reference is source 'upload' AND kind 'reference', so it went into the pool
  // that generation places first. Trigger: use a reference on a page, then ask for
  // more pages — generateMorePages loads this pool.
  const photos = userPhotosFrom([row('upload', 'mine'), row('reference', 'theirs')]);
  assert.deepEqual(photos.map((p) => p.assetId), ['mine'], "the client's own photo, and only that");
});

test('the user photo pool still excludes documents, and still keeps real uploads', () => {
  const photos = userPhotosFrom([row('doc', 'pdf'), row('upload', 'a'), row('photo', 'b')]);
  // 'photo' with source 'upload' is a real user upload (stock/extracted rows carry a
  // different source), so it belongs in the pool.
  assert.deepEqual(photos.map((p) => p.assetId).sort(), ['a', 'b']);
});

// ── Ranking the library for one page ─────────────────────────────────────────

const asset = (id: string, o: { kind?: string; pageIndex?: number | null; createdAt?: string } = {}) => ({
  _id: id,
  url: `https://x/${id}.jpg`,
  alt: '',
  kind: o.kind ?? 'photo',
  source: 'extracted',
  pageIndex: o.pageIndex ?? null,
  createdAt: o.createdAt ?? '2026-01-01T00:00:00.000Z',
});

test("a page's own extracted photos come first", () => {
  // The apply-layout top-up read the library in storage order, so rebuilding page 3
  // could take page 12's photograph while page 3's own waited further down the array.
  const ranked = rankMediaForPage(
    [asset('p12', { pageIndex: 12 }), asset('p3', { pageIndex: 3 }), asset('p0', { pageIndex: 0 })],
    3,
  );
  assert.equal(ranked[0]!._id, 'p3');
});

test('everything else falls back to NEWEST first — the only signal an upload has', () => {
  // Uploads carry pageIndex null (nothing asks which page the user meant), so they can
  // never win tier 1. Recency is what is left: a photo added minutes ago is likelier
  // to be meant for the page being worked on than one from the first import.
  const ranked = rankMediaForPage(
    [
      asset('old', { createdAt: '2026-01-01T00:00:00.000Z' }),
      asset('new', { createdAt: '2026-08-25T00:00:00.000Z' }),
      asset('mid', { createdAt: '2026-05-01T00:00:00.000Z' }),
    ],
    3,
  );
  assert.deepEqual(ranked.map((m) => m._id), ['new', 'mid', 'old']);
});

test('page affinity outranks recency', () => {
  const ranked = rankMediaForPage(
    [asset('newer-elsewhere', { createdAt: '2026-08-25T00:00:00.000Z' }), asset('this-page', { pageIndex: 3, createdAt: '2026-01-01T00:00:00.000Z' })],
    3,
  );
  assert.deepEqual(ranked.map((m) => m._id), ['this-page', 'newer-elsewhere']);
});

test('ranking drops what may not be placed, so the caller cannot reintroduce it', () => {
  const ranked = rankMediaForPage(
    [asset('ref', { kind: 'reference', pageIndex: 3 }), asset('pdf', { kind: 'doc' }), asset('ok', { pageIndex: 3 })],
    3,
  );
  assert.deepEqual(ranked.map((m) => m._id), ['ok'], 'a reference cannot win on page affinity either');
});

test('pageIndex 0 is a real page, not a missing one', () => {
  // The cover. A truthiness test here would send every cover photo to tier 2.
  const ranked = rankMediaForPage([asset('other', { pageIndex: 5 }), asset('cover', { pageIndex: 0 })], 0);
  assert.equal(ranked[0]!._id, 'cover');
});

test('the pool is still defined by provenance, not merely by placeability', () => {
  // An EXTRACTED photo is placeable, but it is not one of the user's own uploads and
  // must not be promoted ahead of AI/stock by this pool — it is already on its page.
  const extracted = { _id: 'x', url: 'https://x/x.jpg', alt: '', kind: 'photo', source: 'extracted' };
  assert.deepEqual(userPhotosFrom([extracted]), []);
});

// ── Pictures from an attached document (C45) ─────────────────────────────────

test('a picture lifted out of an attached document says which document and page it came from', () => {
  assert.equal(documentPhotoAlt('Results.pdf', 2, 1), 'Results.pdf — page 2, picture 1');
  assert.equal(documentPhotoAlt('', 0, 0), 'document — page 1, picture 1');
  assert.equal(mediaOrigin({ docName: 'Results.pdf', docPage: 2, source: 'extracted' }), 'from “Results.pdf”, page 2');
  assert.equal(mediaOrigin({ docName: 'Results.pdf' }), 'from “Results.pdf”');
});

test('mediaOrigin names every other provenance in a few words', () => {
  assert.equal(mediaOrigin({ source: 'chart', kind: 'graphic' }), 'a chart drawn from data');
  assert.equal(mediaOrigin({ source: 'ai-image', kind: 'photo' }), 'an AI-generated picture');
  assert.equal(mediaOrigin({ source: 'ai-image', kind: 'graphic' }), 'an AI illustration');
  assert.equal(mediaOrigin({ source: 'stock' }), 'a stock photo');
  assert.equal(mediaOrigin({ source: 'upload' }), 'uploaded by the user');
  assert.equal(mediaOrigin({ source: 'extracted', pageIndex: 0 }), 'from page 1 of the imported magazine');
  assert.equal(mediaOrigin({ source: 'mystery' }), '');
});

test('a document picture keeps pageIndex null, so it is never ranked as a magazine page’s own photo', () => {
  const fromDoc = { _id: 'd', url: 'https://x/d.jpg', kind: 'photo', source: 'extracted', pageIndex: null, docName: 'Results.pdf', docPage: 3, createdAt: '2026-01-01' };
  const own = { _id: 'own', url: 'https://x/o.jpg', kind: 'photo', source: 'extracted', pageIndex: 2, createdAt: '2025-01-01' };
  assert.deepEqual(rankMediaForPage([fromDoc, own], 2).map((m) => m._id), ['own', 'd']);
});

// ── A picture's own pixel size, from its first bytes ─────────────────────────
//
// "Resize each image box to exactly its own ratio (1426x806 -> 640x362)" needs the
// picture's size; the upload route now reads it from the stored file's header.

const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

const png = (w: number, h: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32be(13), ...ascii('IHDR'), ...u32be(w), ...u32be(h), 8, 6, 0, 0, 0]);
const gif = (w: number, h: number) => Buffer.from([...ascii('GIF89a'), ...u16le(w), ...u16le(h), 0, 0, 0]);
const webpLossy = (w: number, h: number) =>
  Buffer.from([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), ...ascii('VP8 '), 0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(w), ...u16le(h), 0, 0]);
const webpLossless = (w: number, h: number) => {
  const v = (w - 1) | ((h - 1) << 14);
  return Buffer.from([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), ...ascii('VP8L'), 0, 0, 0, 0, 0x2f, v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff, 0, 0, 0, 0, 0]);
};
const webpExtended = (w: number, h: number) =>
  Buffer.from([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), ...ascii('VP8X'), 10, 0, 0, 0, 0, 0, 0, 0, ...u24le(w - 1), ...u24le(h - 1), 0, 0]);
const sof0 = (w: number, h: number) => [0xff, 0xc0, ...u16be(17), 8, ...u16be(h), ...u16be(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
const app0 = [0xff, 0xe0, ...u16be(16), ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
/** An EXIF block (big-endian TIFF) with one entry: Orientation = `o`. */
const exif = (o: number) => {
  const tiff = [...ascii('MM'), 0, 0x2a, ...u32be(8), ...u16be(1), ...u16be(0x0112), ...u16be(3), ...u32be(1), ...u16be(o), 0, 0, ...u32be(0)];
  const body = [...ascii('Exif'), 0, 0, ...tiff];
  return [0xff, 0xe1, ...u16be(body.length + 2), ...body];
};
const jpeg = (w: number, h: number, orientation?: number) =>
  Buffer.from([0xff, 0xd8, ...app0, ...(orientation ? exif(orientation) : []), ...sof0(w, h), 0xff, 0xd9]);

test('the pixel size is read from the header of every format the library accepts', () => {
  assert.deepEqual(imageDimensions(png(1426, 806)), { width: 1426, height: 806 });
  assert.deepEqual(imageDimensions(gif(320, 200)), { width: 320, height: 200 });
  assert.deepEqual(imageDimensions(webpLossy(1560, 730)), { width: 1560, height: 730 });
  assert.deepEqual(imageDimensions(webpLossless(1200, 900)), { width: 1200, height: 900 });
  assert.deepEqual(imageDimensions(webpExtended(4000, 3000)), { width: 4000, height: 3000 });
  assert.deepEqual(imageDimensions(jpeg(1426, 806)), { width: 1426, height: 806 });
});

test('a phone photo turned a quarter by its EXIF orientation reports the size people see', () => {
  assert.deepEqual(imageDimensions(jpeg(4032, 3024, 6)), { width: 3024, height: 4032 });
  assert.deepEqual(imageDimensions(jpeg(4032, 3024, 1)), { width: 4032, height: 3024 });
  assert.deepEqual(imageDimensions(jpeg(4032, 3024, 3)), { width: 4032, height: 3024 }, 'upside down is not turned');
});

test('bytes that are not a picture, or are cut short, give no size — never a throw', () => {
  assert.equal(imageDimensions(Buffer.from('%PDF-1.7 not an image')), null);
  assert.equal(imageDimensions(Buffer.alloc(0)), null);
  assert.equal(imageDimensions(png(1426, 806).subarray(0, 18)), null);
  assert.equal(imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])), null);
  assert.equal(imageDimensions(png(0, 806)), null);
});

test('the browser’s measurement settles a quarter turn and stands in when the bytes say nothing', () => {
  assert.deepEqual(chooseImageSize({ width: 4032, height: 3024 }, { width: 3024, height: 4032 }), { width: 3024, height: 4032 });
  assert.deepEqual(chooseImageSize({ width: 1426, height: 806 }, { width: 10, height: 10 }), { width: 1426, height: 806 }, 'the file wins over a wrong hint');
  assert.deepEqual(chooseImageSize(null, { width: '1426', height: 806 }), { width: 1426, height: 806 });
  assert.equal(chooseImageSize(null, { width: -1, height: 806 }), null);
  assert.equal(chooseImageSize(null, null), null);
});

test('sizedPictures: recorded sizes (or a chart’s drawn box), never a document', () => {
  const rows = [
    { _id: 'a', url: 'https://x/a.png', kind: 'upload', width: 1426, height: 806 },
    { _id: 'c', url: 'https://x/c.png', kind: 'graphic', chartBox: { w: 640, h: 360 } },
    { _id: 'd', url: 'https://x/d.pdf', kind: 'doc', width: 10, height: 10 },
    { _id: 'n', url: 'https://x/n.jpg', kind: 'photo' },
  ];
  assert.deepEqual(sizedPictures(rows), [
    { url: 'https://x/a.png', assetId: 'a', width: 1426, height: 806 },
    { url: 'https://x/c.png', assetId: 'c', width: 640, height: 360 },
  ]);
});

test('filling empty photo slots: a newer chart, document picture or AI graphic never comes before an older upload', () => {
  const old = { _id: 'upload', url: 'https://x/u.jpg', kind: 'photo', source: 'upload', pageIndex: null, createdAt: '2026-01-01' };
  const chart = { _id: 'chart', url: 'https://x/c.png', kind: 'graphic', source: 'chart', pageIndex: 3, createdAt: '2026-11-01' };
  const fromPdf = { _id: 'pdf', url: 'https://x/d.jpg', kind: 'photo', source: 'extracted', docId: 'doc1', pageIndex: null, createdAt: '2026-11-02' };
  const drawn = { _id: 'ai-graphic', url: 'https://x/g.png', kind: 'graphic', source: 'ai-image', pageIndex: 3, createdAt: '2026-11-03' };
  const aiPhoto = { _id: 'ai-photo', url: 'https://x/p.png', kind: 'photo', source: 'ai-image', pageIndex: null, createdAt: '2026-10-01' };
  const rows = [old, chart, fromPdf, drawn, aiPhoto];
  assert.deepEqual(rankMediaForPage(rows, 3, { forPhotoSlots: true }).map((m) => m._id), ['ai-photo', 'upload']);
  // Without the option every placeable row is still offered (list_media, pickers).
  assert.deepEqual(rankMediaForPage(rows, 3).map((m) => m._id), ['chart', 'ai-graphic', 'pdf', 'ai-photo', 'upload']);
  assert.equal(fitsAPhotoSlot(old), true);
  assert.equal(fitsAPhotoSlot(chart), false);
  assert.equal(fitsAPhotoSlot(fromPdf), false);
  assert.equal(fitsAPhotoSlot(drawn), false);
});
