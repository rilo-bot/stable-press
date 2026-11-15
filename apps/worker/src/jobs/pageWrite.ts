// ---------------------------------------------------------------------------
// Magazine Builder v2 — the pure decisions behind writing an extracted page.
//
// processPage.ts / processIssue.ts do the I/O (MuPDF, S3, Mongo). Every choice
// they make about WHAT to write lives here instead, with no imports beyond
// node:crypto, so it is testable without a database, a bucket or a PDF
// (apps/server/tests/magazineV2/workerPageWrite.test.ts).
//
// The decisions, and the bug each one exists to prevent:
//
//   backgroundKey   A page's background raster used to be stored at a key built
//                   from the SOURCE page number alone. Copying page 1 of another
//                   PDF onto page 6 therefore wrote the very object the imported
//                   cover used — and the cover, the magazine's coverImage and every
//                   published snapshot that referenced that URL all changed under
//                   the reader. Every write now gets a key no other write can have.
//   revBump         The rebuild replaced every element without moving `rev`, so the
//                   editor's stale copy of the page still held a valid rev: its
//                   writes "succeeded" against ids that no longer existed.
//   pageNotice      A scanned page (no text layer) copied as one flat picture and
//                   nobody was told why its words could not be edited.
//   sourceIndexOf   A retry re-extracted `page.index` — the page's POSITION — which
//                   stops being its source page number the moment a page is
//                   inserted or reordered.
//   coverAfterReplace  With unique keys the cover no longer changes by accident, so
//                   when page 1 really is replaced the cover has to follow on
//                   purpose (but only when it was derived from that page).
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';

/** Keep an id safe to splice into an object key. Mongo ids are hex already; this
 *  is for anything else that might one day arrive as a page id. */
function keySegment(value: string): string {
  const clean = String(value).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return clean || 'page';
}

/**
 * The object key for one write of one page's background raster.
 *
 * Keyed by the TARGET page (never the source page number, which is what collided)
 * and by a fresh run id, so import, retry and copy each produce a new URL:
 *   - no write can overwrite an object another page, the cover, or a published
 *     edition still points at;
 *   - a re-copy can never be served from a browser or CDN cache of the old one.
 * The superseded object becomes an orphan, which scripts/sweep-orphan-objects.ts
 * already cleans up. Deliberately NOT deleted here: a published snapshot may be
 * the thing still using it.
 */
export function backgroundKey(opts: { prefix: string; issueId: string; pageId: string; runId?: string }): string {
  const runId = keySegment(opts.runId ?? crypto.randomUUID());
  return `${opts.prefix}magazinesV2/${keySegment(opts.issueId)}/pages/${keySegment(opts.pageId)}/${runId}-background.jpg`;
}

/**
 * The compare-and-set for replacing a page wholesale: match the rev we read, write
 * the next one.
 *
 * A page that predates `rev` has none, and `{ rev: 0 }` would never match it — so
 * a missing or non-numeric rev is matched as null (Mongo's null matches a missing
 * field) and starts the count at 1.
 */
export function revBump(stored: unknown): { condition: { rev: number | null }; rev: number } {
  const cur = typeof stored === 'number' && Number.isFinite(stored) ? stored : null;
  return { condition: { rev: cur }, rev: (cur ?? 0) + 1 };
}

/**
 * Why an extracted page has fewer editable parts than it looks like it should.
 *
 *   'scanned'  No text layer and a picture covering the page: a scan. It copies
 *              as one image, so its words are pixels and cannot be edited.
 *   'no-text'  No text layer, but not a scan either — typically a print-ready PDF
 *              whose type was converted to outlines. Same consequence for the
 *              user: the words are part of the picture.
 *   ''         The page has a text layer; nothing to explain.
 *
 * Stored on the page as `notice` (never in `error`, which drives the failed
 * state) and rewritten on every extraction, so a re-copy clears an old one.
 */
export type PageNotice = '' | 'scanned' | 'no-text';

export function pageNotice(raster: { textBlockCount: number; fullPageImage: boolean }): PageNotice {
  if (raster.textBlockCount > 0) return '';
  return raster.fullPageImage ? 'scanned' : 'no-text';
}

/** What a page notice means, in words a person (or the agent) can relay. */
export const PAGE_NOTICE_TEXT: Record<Exclude<PageNotice, ''>, string> = {
  scanned:
    'This page came from a scanned PDF page with no text layer. It was copied as one picture, so its words cannot be edited or replaced. To change the wording, add new text over it.',
  'no-text':
    'This PDF page has no text layer (its type was drawn as shapes), so it was copied as a picture and its words cannot be edited or replaced. To change the wording, add new text over it.',
};

/**
 * Which page of the magazine's OWN source file a retry should re-extract.
 *
 * Import stamps each page with the source page it came from (`sourceIndex`,
 * 0-based). A page that predates the stamp falls back to the index the route sent,
 * which is right until pages are inserted or reordered — exactly the case the
 * stamp exists for.
 */
export function sourceIndexOf(page: Record<string, unknown> | null | undefined, fallback: number): number {
  const stamped = page?.sourceIndex;
  if (typeof stamped === 'number' && Number.isInteger(stamped) && stamped >= 0) return stamped;
  return Math.max(0, Math.floor(Number(fallback) || 0));
}

/** Where a page was copied from ("copy this page" from an attached PDF), if it was. */
export interface CopiedFrom {
  docId: string;
  sourcePage: number;
}

export function copiedFromOf(page: Record<string, unknown> | null | undefined): CopiedFrom | null {
  const raw = page?.copiedFrom as { docId?: unknown; sourcePage?: unknown } | null | undefined;
  if (!raw || typeof raw !== 'object') return null;
  const docId = typeof raw.docId === 'string' ? raw.docId.trim() : '';
  const sourcePage = Number(raw.sourcePage);
  if (!docId || !Number.isInteger(sourcePage) || sourcePage < 1) return null;
  return { docId, sourcePage };
}

/**
 * The magazine's coverImage after page `targetIndex` got a new background.
 *
 * Returns the new URL only when the cover was DERIVED from that page — the first
 * page, and the cover still pointing at its old background (import sets it that
 * way). An explicit cover the user chose is a different URL and is left alone;
 * so is every other page. Null means "do not touch the cover".
 */
export function coverAfterReplace(opts: {
  coverImage: unknown;
  targetIndex: number;
  previousBackground: unknown;
  newBackground: string;
}): string | null {
  if (opts.targetIndex !== 0 || !opts.newBackground) return null;
  const cover = typeof opts.coverImage === 'string' ? opts.coverImage : '';
  const prev = typeof opts.previousBackground === 'string' ? opts.previousBackground : '';
  if (!cover || !prev || cover !== prev) return null;
  return cover === opts.newBackground ? null : opts.newBackground;
}
