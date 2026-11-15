// ---------------------------------------------------------------------------
// Printing the public bulletin — the pure parts of BulletinViewer's print path.
//
// The viewer route is what "Download PDF" prints: the worker opens it in headless
// Chromium, waits for the `data-bulletin-ready` marker and calls page.pdf()
// (apps/server/src/lib/pdf.ts). Two things decide whether that PDF is right, and
// both live here so they can be tested without a browser
// (bulletinPrint.test.ts):
//
//   SHEET SIZES   Each page prints on a sheet of ITS OWN size. Pages are not
//                 uniform — "copy a page" keeps the source PDF's shape (an 8.5x11
//                 page inside an A4 magazine, a landscape spread), and pages added
//                 to an imported Letter magazine are A4. One sheet for the whole
//                 document, sized from the first page, clipped every larger page's
//                 right and bottom edges or spilled them onto an extra sheet, and
//                 left white bands around smaller ones. CSS named pages give every
//                 distinct size its own `@page` rule; lib/pdf.ts passes
//                 preferCSSPageSize so Chromium honours them.
//
//   READINESS     The marker may only go up once every image has reached its
//                 FINAL state. A direct S3 URL that fails is retried through the
//                 API proxy (lib/assetUrl.ts, ResilientImg); waiting for "load or
//                 error" once counted the FIRST error as done, so the PDF was
//                 printed while the proxied photo was still downloading and the
//                 stored edition carried blank picture boxes for every reader.
//
// No React, no app imports: the fallback test is passed in, so this module can be
// loaded by node:test without Vite's import.meta.env.
// ---------------------------------------------------------------------------

/**
 * Fallback page dims when an issue somehow carries none — the canonical generated
 * page (A4 portrait at 150 DPI), matching PAGE_W/PAGE_H in the server's magazineV2
 * config. Every real page is measured from its own box.
 */
export const FALLBACK_W = 1240;
export const FALLBACK_H = 1754;

/**
 * DPI the page pixels are measured at. Generated pages are A4 at 150 DPI
 * (1240x1754) and the PDF extractor rasterises uploads at the same 150
 * (`RENDER_DPI` in apps/worker/src/lib/pdf.ts), so one constant converts either
 * kind of page to a physical size. A browser reads a bare `px` as 1/96 inch, so a
 * 1240px box would print on a 12.9-inch sheet; divided by 150 it is 8.27 inches.
 * Mirrored by RASTER_DPI in apps/server/src/lib/pdf.ts.
 */
export const RASTER_DPI = 150;

export interface PageDims {
  width?: unknown;
  height?: unknown;
}

/** A page's own pixel box, defaulting only if the snapshot is missing dims. */
export function pageBox(page: PageDims | null | undefined): { w: number; h: number } {
  const w = Number(page?.width);
  const h = Number(page?.height);
  return { w: w > 0 ? w : FALLBACK_W, h: h > 0 ? h : FALLBACK_H };
}

/** The page's PHYSICAL size, for `@page` and the print box. */
export function pageInches(page: PageDims | null | undefined): { w: string; h: string } {
  const box = pageBox(page);
  return { w: `${(box.w / RASTER_DPI).toFixed(4)}in`, h: `${(box.h / RASTER_DPI).toFixed(4)}in` };
}

/**
 * The CSS named page a page prints on.
 *
 * Built from the SAME inch strings as the print box (pageInches), not from the
 * pixel dims: two pages whose pixels round apart could otherwise share a rule
 * sized for one of them, and a box even a fraction of a point taller than its
 * sheet spills onto an extra sheet — the "doubled PDF". `8.2667in` becomes
 * `8_2667` so the name is a valid CSS identifier.
 */
export function sheetName(page: PageDims | null | undefined): string {
  const { w, h } = pageInches(page);
  const part = (v: string) => v.replace(/in$/, '').replace(/\./g, '_');
  return `sz${part(w)}x${part(h)}`;
}

/**
 * The `@page` rules for a set of pages: an unnamed default sized from the first
 * page (what any page without a name falls back to, and what native Ctrl+P uses
 * for the first sheet), then one named rule per DISTINCT page size.
 *
 * Margins are zero everywhere: the page box IS the sheet.
 */
export function printPageRules(pages: ReadonlyArray<PageDims | null | undefined>): string {
  const first = pageInches(pages[0]);
  const rules = [`@page { size: ${first.w} ${first.h}; margin: 0; }`];
  const seen = new Set<string>();
  for (const p of pages) {
    const name = sheetName(p);
    if (seen.has(name)) continue;
    seen.add(name);
    const { w, h } = pageInches(p);
    rules.push(`@page ${name} { size: ${w} ${h}; margin: 0; }`);
  }
  return rules.join('\n');
}

// ── Readiness ────────────────────────────────────────────────────────────────

/** The slice of HTMLImageElement the readiness wait reads. */
export interface ImgLike {
  complete: boolean;
  naturalWidth: number;
  src: string;
  currentSrc?: string;
  dataset?: { assetFallback?: string };
  decode?: () => Promise<void>;
  addEventListener(type: 'load' | 'error', listener: () => void, options?: { once?: boolean }): void;
}

/**
 * Has this image reached its final state?
 *
 * Done when it has loaded, or when it is broken with no fallback left to try:
 *   - the app-wide fallback already swapped it to the API proxy and that failed
 *     too (`data-asset-fallback="1"`), or
 *   - its URL is not one the proxy can serve (`canFallback` false — a third-party
 *     URL, a data: URL, or already the proxy URL).
 * A broken image WITH a fallback still to come is not done: its src is about to
 * change, and printing now is exactly the blank-photo bug.
 *
 * Read only after a macrotask boundary following any error (waitForImagesSettled
 * does): right after a src swap, inside the error event, `complete` still reports
 * the OLD broken request.
 */
export function imageSettled(img: ImgLike, canFallback: (url: string) => boolean): boolean {
  if (!img.complete) return false;
  if (img.naturalWidth > 0) return true;
  if (img.dataset?.assetFallback === '1') return true;
  const url = img.currentSrc || img.src;
  return !url || !canFallback(url);
}

export interface WaitForImagesOptions {
  /** Whether a URL has a proxy fallback (lib/assetUrl.ts proxiedAssetUrl !== null). */
  canFallback: (url: string) => boolean;
  /** Give up after this long and print what has loaded (the marker must still go
   *  up: a render that never prints is worse than one missing a photo). */
  timeoutMs?: number;
  /** Re-check at least this often, in case an event fired before we listened. */
  recheckMs?: number;
  /** Budget for decoding the loaded images once everything has settled. */
  decodeMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Wait until every image `images()` returns has reached its final state.
 *
 * Re-queries the images each round (a fallback can swap a src, React can
 * re-render), waits on the pending ones' next load/error or a short re-check
 * timer, and starts every round with a macrotask yield so a src swapped inside an
 * error handler has started its new request before `complete` is read again.
 * Finishes by decoding the loaded images (bounded), so a photo is painted, not
 * merely downloaded, when the PDF is printed.
 *
 * Resolves `{ settled: false }` at the deadline rather than hanging; the caller
 * raises the marker either way.
 */
export async function waitForImagesSettled(
  images: () => ArrayLike<ImgLike>,
  opts: WaitForImagesOptions,
): Promise<{ settled: boolean; pending: number }> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const recheckMs = opts.recheckMs ?? 500;
  const decodeMs = opts.decodeMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  let result = { settled: true, pending: 0 };

  for (;;) {
    // Let any fallback / ResilientImg swap run before the state is read.
    await sleep(0);
    const pending = Array.from(images()).filter((img) => !imageSettled(img, opts.canFallback));
    if (pending.length === 0) break;
    const left = deadline - Date.now();
    if (left <= 0) {
      result = { settled: false, pending: pending.length };
      break;
    }
    await Promise.race([
      Promise.all(
        pending.map(
          (img) =>
            new Promise<void>((resolve) => {
              img.addEventListener('load', () => resolve(), { once: true });
              img.addEventListener('error', () => resolve(), { once: true });
            }),
        ),
      ),
      sleep(Math.min(recheckMs, left)),
    ]);
  }

  // Decode what loaded, so it is painted before the snapshot. A broken image's
  // decode rejects — ignored. Bounded: a decode that never resolves must not hold
  // the marker down.
  const loaded = Array.from(images()).filter((img) => img.complete && img.naturalWidth > 0 && typeof img.decode === 'function');
  if (loaded.length > 0) {
    await Promise.race([
      Promise.all(loaded.map((img) => img.decode!().catch(() => {}))),
      sleep(decodeMs),
    ]);
  }
  return result;
}
