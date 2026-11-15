// Run: npx tsx --test src/pages/bulletinPrint.test.ts   (from apps/web)
//
// The two rules that decide whether the downloaded PDF is right:
//   1. every page prints on a sheet of its own size (mixed-size editions used to
//      be clipped, spilled onto extra sheets, or banded in white);
//   2. the print-ready marker waits for each image's FINAL state, including the
//      proxy fallback a failed S3 URL is retried through (it used to fire on the
//      first error, and the PDF was printed with blank photo boxes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FALLBACK_H,
  FALLBACK_W,
  imageSettled,
  pageBox,
  pageInches,
  printPageRules,
  sheetName,
  waitForImagesSettled,
  type ImgLike,
} from './bulletinPrint';

// ── sheet sizes ───────────────────────────────────────────────────────────────

const A4 = { width: 1240, height: 1754 };
const LETTER = { width: 1275, height: 1650 };
const LANDSCAPE = { width: 2000, height: 1125 };

test('a page is measured from its own box, with the canonical page only as a fallback', () => {
  assert.deepEqual(pageBox(LETTER), { w: 1275, h: 1650 });
  assert.deepEqual(pageBox(undefined), { w: FALLBACK_W, h: FALLBACK_H });
  assert.deepEqual(pageBox({ width: 0, height: 'x' }), { w: FALLBACK_W, h: FALLBACK_H });
  // 150 DPI: Letter is 8.5 x 11 inches, not the 13.3-inch sheet bare px would give.
  assert.deepEqual(pageInches(LETTER), { w: '8.5000in', h: '11.0000in' });
  assert.deepEqual(pageInches(A4), { w: '8.2667in', h: '11.6933in' });
});

test('every distinct page size gets its own named sheet, sized exactly like the page box', () => {
  const pages = [A4, LETTER, A4, LANDSCAPE, LETTER];
  const css = printPageRules(pages);
  // The unnamed default is the first page's size (the fallback lib/pdf.ts also uses).
  assert.match(css, /^@page \{ size: 8\.2667in 11\.6933in; margin: 0; \}/);
  // One named rule per DISTINCT size, never one per page.
  const named = css.split('\n').filter((l) => /^@page sz/.test(l));
  assert.equal(named.length, 3);
  for (const p of [A4, LETTER, LANDSCAPE]) {
    const { w, h } = pageInches(p);
    assert.ok(css.includes(`@page ${sheetName(p)} { size: ${w} ${h}; margin: 0; }`), `rule for ${p.width}x${p.height}`);
  }
});

test('sheet names are valid CSS identifiers and differ exactly when the printed size differs', () => {
  for (const p of [A4, LETTER, LANDSCAPE, { width: 1276, height: 1789 }]) {
    assert.match(sheetName(p), /^[a-z][a-z0-9_]*$/i);
  }
  assert.equal(sheetName(A4), sheetName({ width: 1240, height: 1754 }));
  assert.notEqual(sheetName(A4), sheetName(LETTER));
  // Landscape and portrait of the same paper are different sheets.
  assert.notEqual(sheetName({ width: 1754, height: 1240 }), sheetName(A4));
  // Named from the same inch strings as the box: pixels that print the same size
  // share a sheet, so a box can never be a fraction bigger than its sheet.
  assert.equal(sheetName({ width: 1240.00001, height: 1754 }), sheetName(A4));
});

test('a uniform edition still gets the one sheet it always had', () => {
  const css = printPageRules([A4, A4, A4]);
  const lines = css.split('\n');
  assert.equal(lines.length, 2, 'the default plus one named rule');
  assert.ok(lines[1]!.includes('8.2667in 11.6933in'));
});

// ── readiness ─────────────────────────────────────────────────────────────────

const S3 = 'https://bucket.s3.eu-west-2.amazonaws.com/public/magazinesV2/x/photo.jpg';
const PROXY = '/api/uploads/file/public/magazinesV2/x/photo.jpg';
const canFallback = (url: string) => url.startsWith('https://') && url.includes('.amazonaws.com/');

class FakeImg extends EventTarget implements ImgLike {
  complete = false;
  naturalWidth = 0;
  src: string;
  currentSrc = '';
  dataset: { assetFallback?: string } = {};
  decoded = false;
  constructor(src: string) {
    super();
    this.src = src;
    this.currentSrc = src;
  }
  async decode(): Promise<void> {
    this.decoded = true;
  }
  override addEventListener(type: 'load' | 'error', listener: () => void, options?: { once?: boolean }): void {
    super.addEventListener(type, listener, options);
  }
  /** What the browser does when the image arrives. */
  load(): void {
    this.complete = true;
    this.naturalWidth = 800;
    this.dispatchEvent(new Event('load'));
  }
  /**
   * What the browser plus lib/assetUrl.ts's capture listener do on a failed load:
   * the error is reported while `complete` still says "broken", the listener swaps
   * the src to the proxy inside that same event, and only a microtask later does
   * the new request make `complete` false.
   */
  failWithFallback(): void {
    this.complete = true;
    this.naturalWidth = 0;
    if (!this.dataset.assetFallback && canFallback(this.src)) {
      this.dataset.assetFallback = '1';
      this.src = PROXY;
      queueMicrotask(() => {
        this.complete = false;
        this.currentSrc = PROXY;
      });
    }
    this.dispatchEvent(new Event('error'));
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('imageSettled: loaded, or broken with no fallback left, and nothing else', () => {
  const loaded = new FakeImg(S3);
  loaded.complete = true;
  loaded.naturalWidth = 10;
  assert.equal(imageSettled(loaded, canFallback), true);

  const loading = new FakeImg(S3);
  assert.equal(imageSettled(loading, canFallback), false);

  // Broken, but the proxy has not been tried: its src is about to change.
  const brokenS3 = new FakeImg(S3);
  brokenS3.complete = true;
  assert.equal(imageSettled(brokenS3, canFallback), false);

  // Broken after the proxy was tried: final.
  const brokenAfterProxy = new FakeImg(PROXY);
  brokenAfterProxy.complete = true;
  brokenAfterProxy.dataset.assetFallback = '1';
  assert.equal(imageSettled(brokenAfterProxy, canFallback), true);

  // Broken with no proxy for it (third-party URL): final.
  const brokenElsewhere = new FakeImg('https://example.com/a.jpg');
  brokenElsewhere.complete = true;
  assert.equal(imageSettled(brokenElsewhere, canFallback), true);
});

test('the marker waits for the proxied fallback to LOAD, not for the first error', async () => {
  const photo = new FakeImg(S3);
  const order: string[] = [];
  setTimeout(() => {
    order.push('s3 error');
    photo.failWithFallback();
  }, 10);
  setTimeout(() => {
    order.push('proxy load');
    photo.load();
  }, 60);
  const out = await waitForImagesSettled(() => [photo], { canFallback, recheckMs: 20, timeoutMs: 2_000 });
  order.push('ready');
  assert.deepEqual(order, ['s3 error', 'proxy load', 'ready']);
  assert.deepEqual(out, { settled: true, pending: 0 });
  assert.equal(photo.naturalWidth, 800);
  assert.equal(photo.decoded, true, 'loaded images are decoded before the marker goes up');
});

test('a fallback that also fails is final, so it cannot hold the marker down', async () => {
  const photo = new FakeImg(S3);
  setTimeout(() => photo.failWithFallback(), 5);
  setTimeout(() => photo.failWithFallback(), 30); // the proxy fails too
  const started = Date.now();
  const out = await waitForImagesSettled(() => [photo], { canFallback, recheckMs: 20, timeoutMs: 2_000 });
  assert.equal(out.settled, true);
  assert.ok(Date.now() - started < 1_000);
});

test('images already loaded or already broken for good settle at once', async () => {
  const a = new FakeImg('https://example.com/a.jpg');
  a.load();
  const b = new FakeImg('https://example.com/b.jpg');
  b.complete = true; // broken, no fallback possible
  const started = Date.now();
  const out = await waitForImagesSettled(() => [a, b], { canFallback, timeoutMs: 2_000 });
  assert.equal(out.settled, true);
  assert.ok(Date.now() - started < 500);
});

test('an image that never finishes gives up at the deadline instead of hanging the render', async () => {
  const stuck = new FakeImg(S3);
  const ok = new FakeImg(S3);
  ok.load();
  const out = await waitForImagesSettled(() => [stuck, ok], { canFallback, recheckMs: 10, timeoutMs: 60, decodeMs: 10 });
  assert.deepEqual(out, { settled: false, pending: 1 });
});

test('the image list is re-read every round, so a late-rendered image is waited for too', async () => {
  const first = new FakeImg('https://example.com/a.jpg');
  const late = new FakeImg('https://example.com/late.jpg');
  const imgs: FakeImg[] = [first];
  const order: string[] = [];
  // `first` is still loading when the wait begins; `late` is rendered while the
  // wait is under way and finishes last.
  setTimeout(() => imgs.push(late), 15);
  setTimeout(() => {
    order.push('first load');
    first.load();
  }, 30);
  setTimeout(() => {
    order.push('late load');
    late.load();
  }, 70);
  const out = await waitForImagesSettled(() => imgs, { canFallback, recheckMs: 10, timeoutMs: 2_000 });
  order.push('ready');
  assert.equal(out.settled, true);
  assert.deepEqual(order, ['first load', 'late load', 'ready']);
  await wait(0);
});
