// ---------------------------------------------------------------------------
// Magazine Builder v2 — "Copy a page exactly": when is the copy finished, what
// went wrong, and does the copied page still match its neighbours.
//
// The copy runs in the worker. The copy route marks the page 'pending' before it
// answers 202; the worker then replaces every element and moves the page's rev
// (apps/worker/src/jobs/processPage.ts). Three callers wait on that:
//
//   CopyDocumentPage     the panel a person presses (polls the store, reloads the
//                        canvas, says how it went)
//   magazine.copyPdfPage The Stable Hand (joins the panel's wait, then reports)
//   magazine-page-copy   the background job that takes over when the copy is
//                        queued behind other work (operator/magazineJobs.ts)
//
// They used to disagree, and the panel did not wait at all: it said "it will
// appear here shortly" and nothing ever reloaded the page, so the canvas kept the
// old one and The Stable Hand sat out 90 seconds and reported "still rebuilding".
// The rule lives here once. Pure: no DOM, no store — tested in pageCopy.test.ts.
// ---------------------------------------------------------------------------

import { RASTER_DPI } from '../pages/bulletinPrint';

/** The fields of a page summary these rules read (api.PageSummary has them all;
 *  `error` and `notice` are absent on older servers). */
export interface CopySummaryLike {
  status: string;
  rev: number;
  error?: unknown;
  notice?: unknown;
}

export type CopyState = 'pending' | 'done' | 'failed' | 'gone';

/** What the waiter knew when the copy started. */
export interface CopyStart {
  /** The page's rev before the copy was asked for (undefined when unknown). */
  rev: number | undefined;
  /** A 'pending' status has been seen since the copy was asked for. */
  seenPending: boolean;
}

/**
 * How long a page that never showed 'pending' and never changed rev is still
 * treated as "not started yet". The route marks the page pending before it
 * answers, so the first read almost always sees it; this only covers a worker so
 * fast that the first read already sees the result on a server that does not
 * move the rev on failure.
 */
export const COPY_GRACE_MS = 8_000;

/** Poll cadence: brisk while a copy usually lands, then slower for a queued one. */
export const COPY_POLL_FAST_MS = 2_500;
export const COPY_POLL_SLOW_MS = 6_000;
export const COPY_FAST_PHASE_MS = 90_000;
/** The panel stops watching after this long (a queued copy behind a long build). */
export const COPY_WATCH_MAX_MS = 10 * 60_000;

/** The poll interval at `elapsedMs` into a wait. */
export function copyPollInterval(elapsedMs: number): number {
  return elapsedMs < COPY_FAST_PHASE_MS ? COPY_POLL_FAST_MS : COPY_POLL_SLOW_MS;
}

/**
 * Where a copy stands. Done means "seen pending (or the rev moved), and no longer
 * pending" — the rev alone is not enough: a worker that does not move the rev on
 * failure would leave a failed copy looking unstarted forever.
 */
export function copyState(summary: CopySummaryLike | undefined, start: CopyStart, elapsedMs: number): CopyState {
  if (!summary) return 'gone';
  if (summary.status === 'pending') return 'pending';
  const moved = start.seenPending || (start.rev !== undefined && summary.rev !== start.rev);
  if (!moved && elapsedMs < COPY_GRACE_MS) return 'pending';
  return summary.status === 'failed' ? 'failed' : 'done';
}

/** The page's own failure reason when the server stored one, else a plain sentence. */
export function copyFailureText(summary: CopySummaryLike | undefined, pageNumber: number): string {
  const own = typeof summary?.error === 'string' ? summary.error.trim() : '';
  return own || `The copy onto page ${pageNumber} failed — that PDF page could not be rebuilt as editable elements.`;
}

/**
 * Mirrors PAGE_NOTICE_TEXT in apps/worker/src/jobs/pageWrite.ts: a PDF page with no
 * text layer is copied as one picture, which is a success with a catch the person
 * must hear about (the words cannot be edited).
 */
export function copyNoticeText(notice: unknown): string | undefined {
  if (notice === 'scanned') {
    return 'That PDF page is a scan with no text layer, so it was copied as one picture — its words cannot be edited or replaced. To change the wording, add new text over it.';
  }
  if (notice === 'no-text') {
    return 'That PDF page has no text layer (its type is drawn as shapes), so it was copied as a picture — its words cannot be edited or replaced. To change the wording, add new text over it.';
  }
  return undefined;
}

/**
 * The banner over an OPEN page whose words are part of its background picture (C33).
 *
 * copyNoticeText is said once, when a copy lands; this stays on screen while the page
 * is open, because the moment it matters is later — when someone clicks a word on the
 * page, nothing selects, and the Design Helper cannot find it either. Shown only while
 * the background is still a picture: once it is replaced, the old notice no longer
 * describes what is on screen (the worker rewrites it only on the next extraction).
 */
export function pageNoticeText(notice: unknown, background: { type?: string } | null | undefined): string | undefined {
  if (background?.type !== 'image') return undefined;
  if (notice === 'scanned') {
    return 'This page is a picture of a scanned PDF page: the words you see are part of the image and cannot be edited or replaced. To change the wording, add new text over it.';
  }
  if (notice === 'no-text') {
    return 'This page is a picture of a PDF page whose type is drawn as shapes: the words you see are part of the image and cannot be edited or replaced. To change the wording, add new text over it.';
  }
  return undefined;
}

// ── Page size (C53) ──────────────────────────────────────────────────────────
// A copied page takes the SOURCE page's shape, so one page of an A4 magazine can
// become US Letter. The PDF export now prints each page on its own sheet, but a
// person should still hear that the page no longer matches its neighbours.

export interface PageSize {
  width: number;
  height: number;
}

/** Same size within `tol` of each side (1% — extractor rounding, not design). */
export function sameSize(a: PageSize, b: PageSize, tol = 0.01): boolean {
  const close = (x: number, y: number) => Math.abs(x - y) <= tol * Math.max(1, Math.max(x, y));
  return close(a.width, b.width) && close(a.height, b.height);
}

/** The size most pages share (first one wins a tie); null for no usable pages. */
export function mostCommonSize(pages: readonly PageSize[]): PageSize | null {
  const groups: { size: PageSize; count: number }[] = [];
  for (const p of pages) {
    if (!(p.width > 0 && p.height > 0)) continue;
    const g = groups.find((x) => sameSize(x.size, p));
    if (g) g.count++;
    else groups.push({ size: { width: p.width, height: p.height }, count: 1 });
  }
  let best: { size: PageSize; count: number } | null = null;
  for (const g of groups) if (!best || g.count > best.count) best = g;
  return best ? best.size : null;
}

const PAPERS: { name: string; w: number; h: number }[] = [
  { name: 'A4', w: 8.27, h: 11.69 },
  { name: 'US Letter', w: 8.5, h: 11 },
  { name: 'A5', w: 5.83, h: 8.27 },
  { name: 'A3', w: 11.69, h: 16.54 },
  { name: 'US Legal', w: 8.5, h: 14 },
  { name: 'Tabloid', w: 11, h: 17 },
];

/** A named paper size for these pixels (at the export's 150 DPI), else null. */
export function paperName(size: PageSize): string | null {
  const w = size.width / RASTER_DPI;
  const h = size.height / RASTER_DPI;
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.06;
  for (const p of PAPERS) {
    if (near(w, p.w) && near(h, p.h)) return `${p.name} portrait`;
    if (near(w, p.h) && near(h, p.w)) return `${p.name} landscape`;
  }
  return null;
}

/** "A4 portrait (8.27 × 11.69 in)" or "9.00 × 6.00 in". */
export function describeSize(size: PageSize): string {
  const dims = `${(size.width / RASTER_DPI).toFixed(2)} × ${(size.height / RASTER_DPI).toFixed(2)} in`;
  const name = paperName(size);
  return name ? `${name} (${dims})` : dims;
}

/**
 * A sentence for a person when the copied page's size differs from the size most
 * of the OTHER pages share; null when it matches (or there is nothing to compare).
 */
export function pageSizeNote(page: PageSize, pageNumber: number, others: readonly PageSize[]): string | null {
  if (!(page.width > 0 && page.height > 0)) return null;
  const common = mostCommonSize(others);
  if (!common || sameSize(page, common)) return null;
  return (
    `Page ${pageNumber} now has the PDF page's shape, ${describeSize(page)}, while the rest of the magazine is ` +
    `${describeSize(common)}. It keeps that shape on screen and prints on its own sheet size in the downloaded PDF, ` +
    `so it will not line up with its neighbours in print.`
  );
}
