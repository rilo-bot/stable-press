// ---------------------------------------------------------------------------
// Magazine Builder v2 — CHECK A PAGE in the user's own browser.
//
// The Stable Hand (the in-site operator) used to "check" its work by reading the
// screen's text, which includes clipped words and carries no geometry — so it either
// reported a broken page as done or told the client it could not see the page. This
// is how it sees: measurePage draws the page the way every reader sees it and returns
// the same PageCheck the Studio agent gets from the server (pageCheckRules.ts mirrors
// lib/magazineV2/pageCheck.ts), measured instead of estimated.
//
// Why a private, off-screen copy of the page and not the canvas on screen:
//   - The editor draws pages at whatever zoom fits the window; at 22% one screen px
//     is ~4.4 page px, too coarse to tell a clipped line from a fitting one. The copy
//     is drawn at the page's CANONICAL width, so one CSS px is one page px.
//   - It works for any page — the open one, or another the caller fetched — and the
//     user sees nothing: it sits far off-screen, invisible, ignores the pointer and
//     is hidden from assistive tech (and from readScreen) for the second it exists.
//   - It is the SAME component (IssuePageCanvas) the editor, the public viewer and the
//     PDF draw with, so what is measured is what prints.
//
// Steps: mount → load the faces the copy uses (bounded) → let every picture settle,
// fallback proxy included (bounded) → measure each element (pageMeasure.ts) → judge
// (pageCheckRules.ts, with a probe that lays copy out again at other sizes for exact
// fit suggestions) → unmount. Never throws: when the page cannot be drawn, the rules
// still run on the element data and the summary says text fit was not measured.
// ---------------------------------------------------------------------------

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { proxiedAssetUrl } from '@/lib/assetUrl';
import { imageSettled, waitForImagesSettled } from '@/pages/bulletinPrint';
import { IssuePageCanvas } from './IssuePageCanvas';
import type { IssuePageData } from './model';
import { checkPageFromMeasurements, checkSummary, type PageCheck } from './pageCheckRules';
import { drawnFontSpecs, makeTextProbe, parseMeasurements, readMountedPage, type FontLoadSpec } from './pageMeasure';

export type { CheckKind, ElementMeasurement, PageCheck, PageCheckIssue } from './pageCheckRules';
export { checkSummary, elementLabel, newErrors } from './pageCheckRules';

export interface MeasurePageOptions {
  /** The page's real number for the report. Default: index + 1 (what the canvas
   *  header prints and the operator calls the page). */
  pageNumber?: number;
  /** Total wait for the page's fonts and pictures, ms. Measuring itself is
   *  synchronous and fast; this only bounds the loading. Default 8000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;
/** Fonts are the part that changes line breaks; they get most of the budget. */
const FONT_SHARE = 0.6;
/** Pictures always get at least this long, so a broken one can be told from a slow one. */
const MIN_IMAGE_MS = 400;
/** Where the copy is drawn: far enough left to be off any screen. */
const OFFSCREEN_LEFT = -20_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const canFallback = (url: string) => proxiedAssetUrl(url) !== null;

/** Resolve true when `p` settles within `ms`, false when the time runs out first. */
async function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  let done = false;
  await Promise.race([p.then(() => (done = true), () => (done = true)), sleep(Math.max(0, ms))]);
  return done;
}

/** Load every face the drawn copy uses, then wait for the document's fonts to settle. */
async function loadFonts(root: HTMLElement): Promise<void> {
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
  if (!fonts) return;
  let specs: FontLoadSpec[] = [];
  try {
    specs = drawnFontSpecs(root);
  } catch {
    // Styles unreadable: the loads the layout itself started are still waited for.
  }
  await Promise.all(specs.map((s) => fonts.load(s.font, s.text).catch(() => [])));
  await fonts.ready;
}

/** A check from the element data alone, saying plainly that text fit was not measured. */
function unmeasured(page: IssuePageData, pageNumber: number | undefined, why: string): PageCheck {
  const check = checkPageFromMeasurements([], page.elements ?? [], page, { pageNumber, measuredBy: 'browser' });
  const base: PageCheck = { ...check, measuredBy: 'estimate' };
  return { ...base, summary: `${checkSummary(base)} Text fit was not measured (${why}); only the element data was checked.` };
}

/**
 * Measure a page as the browser draws it and check it: clipped text, text past the
 * page edge or spilling from its box, text over text, elements hidden under others,
 * empty or broken pictures, tiny or low-contrast type, sizes out of step, loose gaps,
 * slivers, oversize boxes, dead bands, an empty page. `measuredBy: 'browser'`.
 */
export async function measurePage(page: IssuePageData, opts: MeasurePageOptions = {}): Promise<PageCheck> {
  const pageNumber =
    typeof opts.pageNumber === 'number' ? opts.pageNumber : Number.isFinite(page.index) && page.index >= 0 ? page.index + 1 : undefined;
  if (typeof document === 'undefined' || !document.body) return unmeasured(page, pageNumber, 'no page to draw it on');
  if (!(page.width > 0) || !(page.height > 0)) return unmeasured(page, pageNumber, 'the page has no size yet');

  const W = page.width;
  const deadline = Date.now() + Math.max(1_000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const host = document.createElement('div');
  // Hidden every way that leaves layout alone: visibility (lines, boxes, Range rects,
  // font and picture loading are all unchanged by it — and readScreen skips it),
  // aria-hidden and inert (no screen reader, no focus), no pointer.
  host.setAttribute('aria-hidden', 'true');
  host.setAttribute('inert', '');
  host.setAttribute('data-page-check', '');
  host.style.cssText = `position:fixed;left:${OFFSCREEN_LEFT}px;top:0;width:${W}px;visibility:hidden;pointer-events:none;`;
  const mount = document.createElement('div');
  // The probe's ground: the page's width and a size container, so the canvas's cqw
  // type sizes resolve to the same px here as on the page.
  const scratch = document.createElement('div');
  scratch.style.cssText = `position:absolute;left:0;top:0;width:${W}px;container-type:inline-size;visibility:hidden;`;
  host.append(mount, scratch);
  document.body.appendChild(host);
  const root = createRoot(mount);
  try {
    try {
      // Synchronous, so the page exists the moment this returns.
      flushSync(() => root.render(createElement(IssuePageCanvas, { page })));
    } catch {
      // A render error is caught below as "no page"; a flushSync refused mid-render
      // has still scheduled the render, which the next tick commits.
    }
    let pageRoot = mount.querySelector<HTMLElement>('[data-magazine-page]');
    if (!pageRoot) {
      await sleep(0);
      pageRoot = mount.querySelector<HTMLElement>('[data-magazine-page]');
    }
    if (!pageRoot) return unmeasured(page, pageNumber, 'the page could not be drawn');

    // Lay it out once so the faces in use start loading, then wait for them.
    void pageRoot.offsetHeight;
    const fontMs = Math.max(0, (deadline - Date.now()) * FONT_SHARE);
    const fontsReady = await within(loadFonts(pageRoot), fontMs);
    await waitForImagesSettled(() => pageRoot!.querySelectorAll('img'), {
      canFallback,
      timeoutMs: Math.max(MIN_IMAGE_MS, deadline - Date.now()),
      recheckMs: 200,
      decodeMs: 0,
    });

    const measurements = parseMeasurements(
      readMountedPage(pageRoot, (img) => imageSettled(img, canFallback)),
      W,
    );
    if (!measurements) return unmeasured(page, pageNumber, 'the drawn page had no size');
    const check = checkPageFromMeasurements(measurements, page.elements ?? [], page, {
      pageNumber,
      measuredBy: 'browser',
      probe: makeTextProbe(pageRoot, scratch, W),
    });
    if (fontsReady) return check;
    // The reader's browser will have the real face; this one did not get it in time,
    // so line breaks may differ from what prints. Say so rather than hide it.
    return { ...check, summary: `${check.summary} Some fonts were still loading, so text was measured in a stand-in face.` };
  } catch (err) {
    return unmeasured(page, pageNumber, err instanceof Error && err.message ? `the page could not be measured: ${err.message.slice(0, 120)}` : 'the page could not be measured');
  } finally {
    try {
      root.unmount();
    } catch {
      // Unmounting while React is mid-render only warns; the host goes regardless.
    }
    host.remove();
  }
}
