// ---------------------------------------------------------------------------
// Magazine Builder v2 — the deterministic PAGE CHECK: "what is wrong with this page,
// in numbers, and what exactly would fix it".
//
// Neither AI could see a page. The Studio agent read an element list with 60
// characters of each text box; The Stable Hand read DOM text that is collected
// whether or not it is clipped. So copy cut off by its box, a rewritten PDF line
// running off the page edge, a photo under an opaque panel or white type on a white
// page all reported "done" — and when the client said "the text is cut off", the AI
// answered that it could not see the page (2026-11-15). This module is how both of
// them see it: every issue names the element, states what was MEASURED, and gives a
// concrete next step with numbers ("fits at 17px, or make the box 412px tall — 88px
// free below").
//
// Three ways in, one rule set, so they can never disagree:
//   checkPage                the server's ESTIMATE, from the element data alone (the
//                            same fit maths the write path uses: layout.ts).
//   issuesFromMeasurements   the same rules fed with what a browser actually drew
//                            (renderPreview.measurePagePreview in Chromium, or the
//                            editor's off-screen mount). Real fonts, real wrapping.
//   checkElement             one element on its own — the "fit" every Studio edit
//                            tool returns.
// The web twin (apps/web/src/editor-v2/pageCheckRules.ts) mirrors the thresholds
// exported below — keep the two in step, like extractedText.ts / pdfLines.ts.
//
// Thresholds are drawn from the modules that already decide these things, never
// invented here: the fit estimate and contrast maths (layout.ts), the PDF-lines rule
// (extractedText.ts), measured glyph advances (fontMetrics.ts), the type scale's
// lowest floor (roleScale.ts), the overlap and quality rules (layoutValidate.ts,
// layoutQuality.ts).
//
// Output is deterministic (no clock, no randomness, stable ordering), errors first,
// capped at MAX_ISSUES so a broken page cannot flood a model's context.
//
// Pure + server-safe: no DOM, no LLM, no I/O.
// ---------------------------------------------------------------------------

import { parseColor, type ElementTextData, type MagazineElement } from './model.js';
import { estimateTextHeight, fitFontSize, contrastRatio, readableColor, measureElementText } from './layout.js';
import { pageQuality } from './layoutValidate.js';
import { keepsPdfLines } from './extractedText.js';
import { FONT_METRICS } from './fontMetrics.data.js';
import { ROLE_SCALE, pxToPt } from './roleScale.js';
import {
  coverage,
  imageShapeProblem,
  HIDING_OPACITY,
  IMAGE_MIN_SIDE,
  MAX_COVERING_SCRIM_OPACITY,
  type Box,
  type ImageShapeProblem,
} from './layoutQuality.js';
import { FURNITURE_IDS } from './pageFurniture.js';
import { visibleText } from './textReplace.js';

// ── Contract ─────────────────────────────────────────────────────────────────

export type CheckKind =
  | 'text-clipped'
  | 'text-past-edge'
  | 'text-spills'
  | 'text-overlap'
  | 'element-hidden'
  | 'image-empty'
  | 'image-broken'
  | 'text-empty'
  | 'tiny-text'
  | 'low-contrast'
  | 'size-mismatch'
  | 'loose-gap'
  | 'off-page'
  | 'sliver'
  | 'empty-box'
  | 'dead-band'
  | 'page-empty';

export interface PageCheckIssue {
  kind: CheckKind;
  severity: 'error' | 'warning';
  elementId?: string;
  otherId?: string;
  /** Which element, in words a person recognises: 'body “The New Owners Group…”'. */
  label: string;
  /** The measured fact: 'needs 412px at 24px type, box is 260px — about 4 lines hidden'. */
  detail: string;
  /** A concrete next step with numbers: 'set fontSize 17px, or make the box 412px tall (88px free below)'. */
  fix: string;
  measured?: { needPx?: number; havePx?: number; overflowPx?: number; fitsAtPx?: number; contrast?: number };
}

export interface PageCheck {
  page?: number;
  measuredBy: 'estimate' | 'chromium' | 'browser';
  /** No errors (warnings allowed). */
  ok: boolean;
  /** Errors first, then warnings; at most MAX_ISSUES. */
  issues: PageCheckIssue[];
  summary: string;
}

/** What a browser measured for one element, in PAGE px (the page's own canonical
 *  width/height, whatever size it was drawn at).
 *  - box: the element's wrapper (layout) box.
 *  - contentW / contentH: the size a text element's copy actually needs — its inner
 *    text block's scroll size, unclipped. Taller than the box = it does not fit.
 *  - ink: the union of the rects of every glyph run (a Range over each text node),
 *    NOT clipped by the box: where the words really are, past the box or the page.
 *  - imgOk: for a picture (or an icon drawn from an uploaded file), false when it
 *    finished loading with no pixels (broken); absent while unknown.
 *  renderPreview.MEASURE_PAGE_JS produces exactly this in Chromium; the editor's
 *  off-screen mount (web pageCheck.ts) does the same in the user's browser. */
export interface ElementMeasurement {
  id: string;
  box: { x: number; y: number; w: number; h: number };
  contentW?: number;
  contentH?: number;
  ink?: { x: number; y: number; w: number; h: number };
  imgOk?: boolean;
}

type PageDims = { width: number; height: number };
type PageWithGround = PageDims & { background?: { type: string; value: string } };

// ── Thresholds (mirrored by the web twin, pageCheckRules.ts) ─────────────────

/** At most this many issues are returned (errors first), so a broken page cannot
 *  flood a model's context; the summary says when the list was cut. */
export const MAX_ISSUES = 12;
/** Wrapped text is CLIPPED (its box is overflow:hidden) when it needs more than this
 *  share of its box — and more than CLIP_MIN_PX, so the half-leading under the last
 *  line, which hides nothing, never counts. */
export const CLIP_RATIO = 1.02;
export const CLIP_MIN_PX = 4;
/** Text copied from a PDF is drawn overflow:visible: it SPILLS past its box instead of
 *  being cut. More than this share over (wider or taller) is worth a warning; the
 *  estimate itself is only good to about this much. */
export const SPILL_RATIO = 1.1;
/** Slack before ink counts as past the page edge. The estimate (wider than real type,
 *  by construction) also gets 2% of the line. */
export const EDGE_TOL_PX = 4;
export const EDGE_ESTIMATE_SLACK = 0.02;
/** When a text's own family was never measured, the estimate uses the widest measured
 *  face of its kind instead (fontMetrics' conservative fallback) — Archivo for a sans,
 *  about 13% wider than Source Sans 3 (finding C55). Such ESTIMATES are only trusted
 *  past this much more, so a copied page set in Calibri is not reported as clipped or
 *  spilling everywhere. A browser measurement needs no allowance. */
export const APPROX_METRICS_SLACK = 0.15;
/** Text on text: the rule validatePageLayout applies to boxes, applied to the INK. */
export const OVERLAP_SHARE = 0.2;
/** An element this much covered by an opaque picture or panel drawn above it is
 *  hidden. Opaque = a picture, or a shape at or above layoutQuality's HIDING_OPACITY. */
export const HIDDEN_COVER = 0.9;
/** Below the type scale's lowest floor (a caption's 12px, about 5.8pt in print). */
export const TINY_TEXT_PX = Math.min(...Object.values(ROLE_SCALE).map((r) => r.minFontSize));
/** WCAG's floor for large text. Body copy wants 4.5; anything under 3 is genuinely
 *  hard to read whatever its size. */
export const LOW_CONTRAST = 3;
/** A colour from the page's own palette is suggested only when it reads this well. */
const GOOD_CONTRAST = 4.5;
/** Among SIZE_MIN_GROUP or more body PARAGRAPHS (body role, at least
 *  PARAGRAPH_MIN_CHARS of copy), a size outside this band around their median is out
 *  of step — the leftover of a copied-PDF paragraph rewritten and shrunk to fit while
 *  its neighbours kept their size. Only paragraphs are compared: on a generated page
 *  the body role also carries cover lines, numbered entries and stat lines, whose
 *  sizes differ from the running copy by design (the NZ fixture has all three). */
export const SIZE_LO = 0.8;
export const SIZE_HI = 1.25;
export const SIZE_MIN_GROUP = 3;
export const PARAGRAPH_MIN_CHARS = 120;
/** In one column (boxes sharing COLUMN_OVERLAP of the wider one's width), a gap more
 *  than LOOSE_GAP_RATIO × the column's median gap and more than LOOSE_GAP_MIN_PX —
 *  with nothing printed in it. Above a heading (headline / subhead / byline /
 *  pullquote) both bars double, and three or more equal big gaps at a steady interval
 *  are a deliberate rhythm, not a hole. */
export const LOOSE_GAP_RATIO = 2.5;
export const LOOSE_GAP_MIN_PX = 40;
export const COLUMN_OVERLAP = 0.8;

/** Most important first, within a severity. */
const KIND_ORDER: CheckKind[] = [
  'page-empty',
  'text-past-edge',
  'text-clipped',
  'element-hidden',
  'image-broken',
  'image-empty',
  'text-overlap',
  'off-page',
  'text-spills',
  'low-contrast',
  'tiny-text',
  'size-mismatch',
  'text-empty',
  'loose-gap',
  'sliver',
  'empty-box',
  'dead-band',
];

/** The same thing in a few plain words, for summaries. */
const KIND_WORDS: Record<CheckKind, string> = {
  'text-clipped': 'text cut off',
  'text-past-edge': 'text runs off the page',
  'text-spills': 'text spills out of its box',
  'text-overlap': 'text overlaps other text',
  'element-hidden': 'hidden under another element',
  'image-empty': 'empty picture box',
  'image-broken': 'picture failed to load',
  'text-empty': 'empty text box',
  'tiny-text': 'type too small to read',
  'low-contrast': 'text hard to read on its background',
  'size-mismatch': 'type size out of step with the rest',
  'loose-gap': 'loose gap in a column',
  'off-page': 'off the page',
  sliver: 'photo cut to a sliver',
  'empty-box': 'box far bigger than its text',
  'dead-band': 'empty band across the page',
  'page-empty': 'nothing on the page',
};

// ── Small helpers ────────────────────────────────────────────────────────────

const r0 = (n: number) => Math.round(n);
const isFurniture = (el: MagazineElement) => FURNITURE_IDS.includes(el.id);
const area = (b: Box) => Math.max(0, b.w) * Math.max(0, b.h);

function intersect(a: Box, b: Box): Box {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return { x, y, w: Math.max(0, w), h: Math.max(0, h) };
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function snippet(s: string, max = 40): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

/** Which element, in words a person recognises. */
export function elementLabel(el: MagazineElement): string {
  if (el.type === 'text') {
    const role = el.text?.role && el.text.role !== 'other' ? el.text.role : 'text';
    const s = snippet(visibleText(el.text?.content ?? ''));
    return s ? `${role} “${s}”` : `empty ${role} box #${el.id}`;
  }
  if (el.type === 'image') {
    if (!el.image?.url) return `empty picture box #${el.id}`;
    const alt = snippet(el.image.alt ?? '', 30);
    return alt ? `photo “${alt}”` : `photo #${el.id}`;
  }
  if (el.type === 'shape') return `shape #${el.id}`;
  if (el.type === 'qr') return `QR code #${el.id}`;
  return `icon #${el.id}`;
}

/** Does this element put anything on the page? */
function draws(el: MagazineElement): boolean {
  if (el.type === 'text') return !!visibleText(el.text?.content ?? '').trim();
  if (el.type === 'image') return !!el.image?.url;
  if (el.type === 'shape') return (el.shape?.opacity ?? 1) > 0.02;
  return true; // qr / icon always draw (icons fall back to a default glyph)
}

/** A sheet-sized picture or panel is the page's ground, and a translucent shape is a
 *  tint — neither blocks a box from growing or counts as a neighbour. */
function isGroundLayer(el: MagazineElement, page: PageDims): boolean {
  if (el.type !== 'image' && el.type !== 'shape') return false;
  if (area(el) >= page.width * page.height * 0.5) return true;
  return el.type === 'shape' && (el.shape?.opacity ?? 1) < 1;
}

/**
 * How far an element could grow DOWN before it meets the next thing below it in its
 * own column (anything whose x-range overlaps it), or the bottom of the page. The
 * page's ground (sheet-sized photos and panels) and translucent tints don't count.
 */
export function freeSpaceBelow(el: MagazineElement, elements: MagazineElement[], page: PageDims): number {
  const bottom = el.y + el.h;
  let limit = page.height;
  for (const o of elements) {
    if (o === el || o.id === el.id || isGroundLayer(o, page)) continue;
    if (Math.min(el.x + el.w, o.x + o.w) - Math.max(el.x, o.x) <= 0) continue;
    if (o.y < bottom - 1) continue; // above or alongside, not below
    limit = Math.min(limit, o.y);
  }
  return Math.max(0, r0(limit - bottom));
}

// ── Text geometry: what a text element prints, estimated or measured ─────────

interface TextGeom {
  /** Drawn exactly as the PDF set it (white-space: pre) — lines never wrap. */
  pdfLines: boolean;
  /** overflow:hidden (anything not copied from a PDF): what doesn't fit is CUT. */
  clips: boolean;
  /** Height (px) the copy needs at its current size. */
  needPx: number;
  /** Width (px) of the widest drawn line (pdfLines), else the box width. */
  widestPx: number;
  /** Where the copy prints, unclipped. */
  ink: Box;
  measured: boolean;
  /** Extra share an estimate must exceed a limit by before it counts: 0 when measured
   *  or when the family has measured metrics, else APPROX_METRICS_SLACK. */
  slack: number;
}

/** 0 when the first family of the stack (the face the page asks for) has measured
 *  metrics; otherwise the allowance for the conservative stand-in. */
function metricsSlack(el: MagazineElement): number {
  const first = (el.text?.fontFamily ?? '').split(',')[0]!.split("'").join('').split('"').join('').trim().toLowerCase();
  return first && Object.prototype.hasOwnProperty.call(FONT_METRICS, first) ? 0 : APPROX_METRICS_SLACK;
}

function inkTop(el: MagazineElement, needPx: number): number {
  const v = el.text?.vAlign ?? 'top';
  return v === 'bottom' ? el.y + el.h - needPx : v === 'center' ? el.y + (el.h - needPx) / 2 : el.y;
}

/** Overflowing lines are start-aligned by the browser; lines that fit follow the box's
 *  alignment. */
function inkLeft(el: MagazineElement, inkW: number): number {
  if (inkW > el.w) return el.x;
  const a = el.text?.align;
  return a === 'center' ? el.x + (el.w - inkW) / 2 : a === 'right' ? el.x + el.w - inkW : el.x;
}

function estimateGeom(el: MagazineElement): TextGeom | null {
  const t = el.text;
  if (el.type !== 'text' || !t) return null;
  const plain = visibleText(t.content ?? '');
  if (!plain.trim()) return null;
  const pdfLines = keepsPdfLines(el);
  let needPx: number;
  let widestPx: number;
  if (pdfLines) {
    // Measured exactly as the write path's refit measures it (layout.measureElementText):
    // each hard line at its drawn weight, so a bold run is measured bold, and a trailing
    // line break adds no line — as the browser draws it. Splitting the visible text on
    // '\n' and measuring every line at the element's weight got both wrong.
    const m = measureElementText(el);
    needPx = m?.needPx ?? 0;
    widestPx = m?.widestLinePx ?? 0;
  } else {
    needPx = estimateTextHeight({
      text: t.content,
      fontSize: t.fontSize,
      boxWidthPx: el.w,
      lineHeight: t.lineHeight,
      fontFamily: t.fontFamily,
      fontWeight: t.fontWeight,
      letterSpacing: t.letterSpacing,
      textTransform: t.textTransform,
    });
    widestPx = el.w;
  }
  const inkW = pdfLines ? widestPx : el.w;
  return {
    pdfLines,
    clips: el.source !== 'extracted',
    needPx,
    widestPx,
    ink: { x: inkLeft(el, inkW), y: inkTop(el, needPx), w: inkW, h: needPx },
    measured: false,
    slack: metricsSlack(el),
  };
}

const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function measuredGeom(el: MagazineElement, m: ElementMeasurement): TextGeom | null {
  const base = estimateGeom(el);
  if (!base) return null;
  const inkM =
    m.ink && [m.ink.x, m.ink.y, m.ink.w, m.ink.h].every((v) => finite(v) !== undefined) ? { x: m.ink.x, y: m.ink.y, w: m.ink.w, h: m.ink.h } : undefined;
  const needPx = finite(m.contentH) ?? inkM?.h ?? base.needPx;
  const widestPx = base.pdfLines ? (inkM?.w ?? finite(m.contentW) ?? base.widestPx) : el.w;
  const ink = inkM ?? { x: inkLeft(el, widestPx), y: inkTop(el, needPx), w: base.pdfLines ? widestPx : el.w, h: needPx };
  return { ...base, needPx, widestPx, ink, measured: true, slack: 0 };
}

/** The ink that can collide with other ink: clipped to the box when the box clips.
 *  For an ESTIMATED PDF-lines block, overshoot within the estimate's own error
 *  (SPILL_RATIO) is not trusted — real type is narrower than the estimate. */
function visibleInk(el: MagazineElement, g: TextGeom): Box {
  if (g.clips) return intersect(g.ink, el);
  if (g.measured) return g.ink;
  const w = g.ink.w > el.w * (SPILL_RATIO + g.slack) ? g.ink.w : Math.min(g.ink.w, el.w);
  const h = g.ink.h > el.h * (SPILL_RATIO + (g.pdfLines ? 0 : g.slack)) ? g.ink.h : Math.min(g.ink.h, el.h);
  const x = w === g.ink.w ? g.ink.x : inkLeft(el, w);
  const y = h === g.ink.h ? g.ink.y : inkTop(el, h);
  return { x, y, w, h };
}

// ── Per-element rules ────────────────────────────────────────────────────────

interface Built {
  issue: PageCheckIssue;
  /** Reading position, for a stable order. */
  y: number;
  x: number;
}

function built(issue: PageCheckIssue, at: { x: number; y: number }): Built {
  return { issue, x: at.x, y: at.y };
}

/** The legibility floor a suggested size never goes under: the element's own design
 *  floor, and never below the smallest size the type scale allows. */
function suggestionFloor(el: MagazineElement): number {
  const t = el.text!;
  return Math.min(t.fontSize, Math.max(TINY_TEXT_PX, t.minFontSize ?? 0));
}

/** Height (px) the copy needs at `fontSize`, wrapped in the box's width. */
function heightAt(el: MagazineElement, fontSize: number): number {
  const t = el.text!;
  return estimateTextHeight({
    text: t.content,
    fontSize,
    boxWidthPx: el.w,
    lineHeight: t.lineHeight,
    fontFamily: t.fontFamily,
    fontWeight: t.fontWeight,
    letterSpacing: t.letterSpacing,
    textTransform: t.textTransform,
  });
}

/** The largest size (≥ the legibility floor, < `below`) at which the copy, wrapped in
 *  its box, fits the box — or undefined when even the floor does not. fitFontSize, the
 *  write path's own search. */
function fitsAt(el: MagazineElement, below: number): number | undefined {
  const t = el.text!;
  const floor = suggestionFloor(el);
  const size = fitFontSize({
    text: t.content,
    boxW: el.w,
    boxH: el.h,
    maxFontSize: below,
    minFontSize: floor,
    lineHeight: t.lineHeight,
    fontFamily: t.fontFamily,
    fontWeight: t.fontWeight,
    letterSpacing: t.letterSpacing,
    textTransform: t.textTransform,
  });
  return heightAt(el, size) <= el.h ? size : undefined;
}

/** "make the box N px tall", with how much room there is to do it when known. */
function growPhrase(el: MagazineElement, needPx: number, free: number | undefined): string {
  const grow = Math.max(0, r0(needPx - el.h));
  if (free === undefined) return `make the box ${r0(needPx)}px tall`;
  if (free >= grow) return `make the box ${r0(needPx)}px tall (${free}px free below)`;
  return `make the box ${r0(needPx)}px tall, but only ${free}px is free below, so move what is underneath first`;
}

interface Neighbours {
  elements: MagazineElement[];
  page: PageDims;
}

/** Fit rules for one text element: clipped, past the page edge, spilling. */
function textFitIssues(el: MagazineElement, g: TextGeom, page: PageDims, nb?: Neighbours): Built[] {
  const t = el.text!;
  const out: Built[] = [];
  const label = elementLabel(el);
  // The room to grow is only worth measuring for an element that has a problem.
  let freeMemo: number | undefined | null = null;
  const free = (): number | undefined => {
    if (freeMemo === null) freeMemo = nb ? freeSpaceBelow(el, nb.elements, nb.page) : undefined;
    return freeMemo;
  };

  if (g.clips) {
    const over = g.needPx - el.h;
    if (g.needPx > Math.max(el.h * (CLIP_RATIO + g.slack), el.h + CLIP_MIN_PX)) {
      // Estimated: the write path's own search. Measured: the estimate's answer, held to
      // what the browser saw (height grows roughly with the square of the size).
      let at = fitsAt(el, t.fontSize);
      if (g.measured) {
        const scaled = Math.floor(t.fontSize * Math.sqrt(el.h / g.needPx));
        at = Math.min(at ?? Infinity, scaled);
        if (!(at >= suggestionFloor(el) && at < t.fontSize)) at = undefined;
      }
      const lineH = t.fontSize * t.lineHeight;
      const hidden = Math.max(1, Math.ceil(over / Math.max(1, lineH)));
      const cut = Math.min(95, Math.max(1, Math.ceil((1 - el.h / g.needPx) * 100)));
      const options: string[] = [];
      if (at !== undefined) options.push(`set fontSize ${at}px (it fits at that size)`);
      options.push(growPhrase(el, g.needPx, free()));
      options.push(`cut about ${cut}% of the words`);
      out.push(
        built(
          {
            kind: 'text-clipped',
            severity: 'error',
            elementId: el.id,
            label,
            detail: `needs ${r0(g.needPx)}px at ${r0(t.fontSize)}px type, the box is ${r0(el.h)}px — about ${plural(hidden, 'line')} cut off`,
            fix: options.join(', or '),
            measured: { needPx: r0(g.needPx), havePx: r0(el.h), overflowPx: r0(over), ...(at !== undefined ? { fitsAtPx: at } : {}) },
          },
          el,
        ),
      );
    }
    return out;
  }

  // Copied PDF text: drawn overflow:visible, so it is never cut by its box — it runs
  // past it, and past the page edge when a line is longer than the room left.
  const slackW = EDGE_TOL_PX + (g.measured ? 0 : g.ink.w * (EDGE_ESTIMATE_SLACK + g.slack));
  const slackH = EDGE_TOL_PX + (g.measured ? 0 : g.ink.h * (EDGE_ESTIMATE_SLACK + (g.pdfLines ? 0 : g.slack)));
  const past: string[] = [];
  const right = g.ink.x + g.ink.w - page.width;
  const bottom = g.ink.y + g.ink.h - page.height;
  if (right > slackW) past.push(`${r0(right)}px past the right edge`);
  if (-g.ink.x > slackW) past.push(`${r0(-g.ink.x)}px past the left edge`);
  if (bottom > slackH) past.push(`${r0(bottom)}px past the bottom edge`);
  if (-g.ink.y > slackH) past.push(`${r0(-g.ink.y)}px past the top edge`);
  // Any edit to its words, size or width turns it into flowing text that wraps in its
  // box and shrinks to fit from its current size (writePipeline + extractedText) — the
  // way out for both problems below. Worked out only when there is a problem.
  const flow = () => {
    const at = fitsAt(el, t.fontSize);
    const words =
      at !== undefined
        ? `edit it (a change to its words, size or width makes it wrap inside its ${r0(el.w)}px box; it fits there at ${at}px)`
        : `edit it so it wraps inside its ${r0(el.w)}px box, and ${growPhrase(el, heightAt(el, suggestionFloor(el)), free())}`;
    return { at, words };
  };
  if (past.length) {
    const { at, words } = flow();
    const room = Math.max(0, r0(page.width - el.x));
    const lineFact = g.pdfLines
      ? `its widest line is ${r0(g.widestPx)}px at ${r0(t.fontSize)}px type, with ${room}px of page right of x=${r0(el.x)}`
      : `it needs ${r0(g.needPx)}px of height from y=${r0(g.ink.y)}`;
    const moveTo = g.pdfLines && g.widestPx <= page.width ? `, or move it to x=${Math.max(0, Math.floor(page.width - g.widestPx))}` : '';
    out.push(
      built(
        {
          kind: 'text-past-edge',
          severity: 'error',
          elementId: el.id,
          label,
          detail: `${lineFact} — it runs ${past.join(' and ')}, where it is cut`,
          fix: `${words}${moveTo}`,
          measured: {
            needPx: r0(g.pdfLines ? g.widestPx : g.needPx),
            havePx: g.pdfLines ? room : r0(page.height - g.ink.y),
            overflowPx: r0(Math.max(right, bottom, -g.ink.x, -g.ink.y)),
            ...(at !== undefined ? { fitsAtPx: at } : {}),
          },
        },
        el,
      ),
    );
    return out;
  }
  // A PDF block's height is its line count (exact); a wrapped block's depends on widths.
  const wide = g.pdfLines && g.widestPx > el.w * (SPILL_RATIO + g.slack);
  const tall = g.needPx > el.h * (SPILL_RATIO + (g.pdfLines ? 0 : g.slack));
  if (wide || tall) {
    const flowing = flow().words;
    const drawnW = r0(g.pdfLines ? Math.max(el.w, g.widestPx) : el.w);
    const drawnH = r0(Math.max(el.h, g.needPx));
    const overPct = r0(Math.max(drawnW / Math.max(1, el.w), drawnH / Math.max(1, el.h)) * 100 - 100);
    out.push(
      built(
        {
          kind: 'text-spills',
          severity: 'warning',
          elementId: el.id,
          label,
          detail: `copied PDF text draws ${drawnW}×${drawnH}px in a ${r0(el.w)}×${r0(el.h)}px box (${overPct}% over) — it spills onto what is around it`,
          fix: `make the box ${drawnW}×${drawnH}px, or ${flowing}`,
          measured: { needPx: drawnH, havePx: r0(el.h), overflowPx: Math.max(0, drawnH - r0(el.h)) },
        },
        el,
      ),
    );
  }
  return out;
}

function offPageIssue(el: MagazineElement, page: PageDims): Built | null {
  const tol = Math.max(EDGE_TOL_PX, page.width * 0.004); // validatePageLayout's slack
  const edges: [string, number][] = [
    ['left', -el.x],
    ['top', -el.y],
    ['right', el.x + el.w - page.width],
    ['bottom', el.y + el.h - page.height],
  ];
  const past = edges.filter(([, d]) => d > tol);
  if (!past.length) return null;
  const visible = area(intersect(el, { x: 0, y: 0, w: page.width, h: page.height })) / Math.max(1, area(el));
  // A picture or panel running off an edge is a bleed — a choice, until most of it is
  // gone. Words, codes and icons are cut by the edge.
  if ((el.type === 'image' || el.type === 'shape') && visible >= 0.5) return null;
  const w = Math.min(el.w, page.width);
  const h = Math.min(el.h, page.height);
  const nx = Math.min(Math.max(0, el.x), page.width - w);
  const ny = Math.min(Math.max(0, el.y), page.height - h);
  const shrink = [el.w > page.width ? `narrow it to ${r0(page.width)}px` : '', el.h > page.height ? `shorten it to ${r0(page.height)}px` : '']
    .filter(Boolean)
    .join(' and ');
  return built(
    {
      kind: 'off-page',
      severity: 'error',
      elementId: el.id,
      label: elementLabel(el),
      detail: `the box runs ${past.map(([e, d]) => `${r0(d)}px past the ${e} edge`).join(' and ')} of the ${r0(page.width)}×${r0(page.height)}px page — ${r0((1 - visible) * 100)}% of it is off the page`,
      fix: `move it to x=${r0(nx)}, y=${r0(ny)}${shrink ? ` and ${shrink}` : ''}`,
    },
    el,
  );
}

/** Rules that need nothing but the element itself. */
function elementIssues(el: MagazineElement, page: PageDims, g: TextGeom | null, nb?: Neighbours): Built[] {
  const out: Built[] = [];
  const off = offPageIssue(el, page);
  if (off) out.push(off);
  const label = elementLabel(el);
  if (el.type === 'text' && el.text) {
    const t = el.text;
    if (!g) {
      if (!isFurniture(el)) {
        // Roughly what the box holds at its size: half an em a character, a line a row.
        const perLine = Math.max(1, Math.floor(el.w / Math.max(1, t.fontSize * 0.5)));
        const lines = Math.max(1, Math.floor(el.h / Math.max(1, t.fontSize * t.lineHeight)));
        out.push(
          built(
            {
              kind: 'text-empty',
              severity: 'warning',
              elementId: el.id,
              label,
              detail: `a ${r0(el.w)}×${r0(el.h)}px text box with no words in it`,
              fix: `type its copy (about ${perLine * lines} characters fit at ${r0(t.fontSize)}px), or delete it`,
            },
            el,
          ),
        );
      }
      return out;
    }
    out.push(...textFitIssues(el, g, page, nb));
    if (t.fontSize < TINY_TEXT_PX - 0.01 && !isFurniture(el)) {
      const need = heightAt(el, TINY_TEXT_PX);
      out.push(
        built(
          {
            kind: 'tiny-text',
            severity: 'warning',
            elementId: el.id,
            label,
            detail: `${+t.fontSize.toFixed(1)}px type is about ${pxToPt(t.fontSize).toFixed(1)}pt in print, under the ${TINY_TEXT_PX}px (${pxToPt(TINY_TEXT_PX).toFixed(1)}pt) floor`,
            fix:
              need > el.h + CLIP_MIN_PX
                ? `set fontSize ${TINY_TEXT_PX}px and ${growPhrase(el, need, nb ? freeSpaceBelow(el, nb.elements, nb.page) : undefined)}, or cut the copy to fit`
                : `set fontSize ${TINY_TEXT_PX}px (it still fits the box)`,
            measured: { needPx: r0(need), havePx: r0(el.h) },
          },
          el,
        ),
      );
    }
    return out;
  }
  if (el.type === 'image' && !el.image?.url) {
    const w = Math.max(1, r0(el.w));
    const h = Math.max(1, r0(el.h));
    out.push(
      built(
        {
          kind: 'image-empty',
          severity: 'error',
          elementId: el.id,
          label,
          detail: `a ${w}×${h}px picture box with no picture — nothing prints there, on the page or in the PDF`,
          fix: `place a picture in it (${w}×${h}px, aspect ${(w / h).toFixed(2)}:1), or delete it`,
        },
        el,
      ),
    );
  }
  return out;
}

/** A photo cut into a sliver (layoutQuality's shape rule), with the size that fixes it. */
function sliverIssue(el: MagazineElement, p: ImageShapeProblem): Built {
  const fix =
    p.kind === 'too-wide'
      ? `make it at least ${Math.ceil(el.w / p.hi)}px tall, or narrow it to ${Math.floor(el.h * p.hi)}px`
      : p.kind === 'too-tall'
        ? `make it at least ${Math.ceil(el.h * p.lo)}px wide, or shorten it to ${Math.floor(el.w / p.lo)}px`
        : `make it at least ${IMAGE_MIN_SIDE}px on its short side (it is ${r0(Math.min(el.w, el.h))}px), or delete it`;
  return built({ kind: 'sliver', severity: 'warning', elementId: el.id, label: elementLabel(el), detail: p.detail, fix }, el);
}

// ── Page-level rules ─────────────────────────────────────────────────────────

interface PageCtx {
  elements: MagazineElement[];
  page: PageWithGround;
  /** Paint order: z, then the order in the list (the renderer's stable sort). */
  rank: Map<MagazineElement, number>;
  geom: Map<MagazineElement, TextGeom>;
}

function makeCtx(elements: MagazineElement[], page: PageWithGround, measured?: Map<string, ElementMeasurement>): PageCtx {
  const rank = new Map<MagazineElement, number>();
  elements
    .map((el, i) => ({ el, i }))
    .sort((a, b) => (a.el.zIndex ?? 0) - (b.el.zIndex ?? 0) || a.i - b.i)
    .forEach(({ el }, r) => rank.set(el, r));
  const geom = new Map<MagazineElement, TextGeom>();
  for (const el of elements) {
    if (el.type !== 'text') continue;
    const m = measured?.get(el.id);
    const g = m ? measuredGeom(el, m) : estimateGeom(el);
    if (g) geom.set(el, g);
  }
  return { elements, page, rank, geom };
}

/** The box that counts as "the element" for cover and contrast: a text's printed
 *  lines, anything else its box. */
function bodyBox(el: MagazineElement, ctx: PageCtx): Box {
  const g = ctx.geom.get(el);
  return g ? visibleInk(el, g) : el;
}

function hiddenIssues(ctx: PageCtx): Built[] {
  const out: Built[] = [];
  for (const el of ctx.elements) {
    if (el.type === 'shape' || !draws(el)) continue;
    const box = bodyBox(el, ctx);
    if (area(box) <= 0) continue;
    const r = ctx.rank.get(el)!;
    let best: { o: MagazineElement; cov: number } | null = null;
    for (const o of ctx.elements) {
      if (o === el || ctx.rank.get(o)! <= r) continue;
      const opaque = o.type === 'image' ? !!o.image?.url : o.type === 'shape' && (o.shape?.opacity ?? 1) >= HIDING_OPACITY;
      if (!opaque) continue;
      const cov = coverage(box, o);
      if (cov >= HIDDEN_COVER && (!best || cov > best.cov || (cov === best.cov && ctx.rank.get(o)! > ctx.rank.get(best.o)!))) best = { o, cov };
    }
    if (!best) continue;
    const { o, cov } = best;
    const op = o.type === 'shape' ? (o.shape?.opacity ?? 1) : 1;
    const what = o.type === 'image' ? 'the picture' : `the ${op < 1 ? `${Math.round(op * 100)}%-opaque ` : ''}shape`;
    // A wash too dark to see through is fixed by thinning it (layoutQuality's ceiling
    // for a covering scrim), not by lifting a photo over the type it was washing.
    const thin = op < 1 ? `, or lower #${o.id}'s opacity to ${MAX_COVERING_SCRIM_OPACITY} or less (it is ${+op.toFixed(2)})` : '';
    out.push(
      built(
        {
          kind: 'element-hidden',
          severity: 'error',
          elementId: el.id,
          otherId: o.id,
          label: elementLabel(el),
          detail: `${r0(cov * 100)}% of it is covered by ${what} #${o.id} (zIndex ${o.zIndex}), drawn above it (zIndex ${el.zIndex})`,
          fix: `set zIndex ${o.zIndex + 1} on it to bring it in front of #${o.id}${thin}, or move it off #${o.id}`,
        },
        el,
      ),
    );
  }
  return out;
}

function overlapIssues(ctx: PageCtx): Built[] {
  const out: Built[] = [];
  const texts = ctx.elements.filter((el) => ctx.geom.has(el)).map((el) => ({ el, ink: visibleInk(el, ctx.geom.get(el)!) }));
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i]!;
      const b = texts[j]!;
      const smaller = Math.min(area(a.ink), area(b.ink));
      if (smaller <= 0) continue;
      const shared = area(intersect(a.ink, b.ink));
      if (shared <= smaller * OVERLAP_SHARE) continue;
      // The one that starts lower is the one to move.
      const [upper, lower] = a.ink.y < b.ink.y || (a.ink.y === b.ink.y && a.ink.x <= b.ink.x) ? [a, b] : [b, a];
      const upperEnd = upper.ink.y + upper.ink.h;
      // Rounded UP, so the suggested position clears the text above by the full gap.
      const target = Math.ceil(lower.el.y + (upperEnd + 12 - lower.ink.y));
      const fits = target + lower.el.h <= ctx.page.height;
      out.push(
        built(
          {
            kind: 'text-overlap',
            severity: 'error',
            elementId: lower.el.id,
            otherId: upper.el.id,
            label: elementLabel(lower.el),
            detail: `its text (y ${r0(lower.ink.y)}–${r0(lower.ink.y + lower.ink.h)}) prints over the text of ${elementLabel(upper.el)} #${upper.el.id} (y ${r0(upper.ink.y)}–${r0(upperEnd)}) — ${r0((shared / smaller) * 100)}% of the smaller block`,
            fix: fits
              ? `move it down to y=${target} (below #${upper.el.id}'s text), or shorten #${upper.el.id} so its text ends above y=${r0(lower.ink.y)}`
              : `shorten #${upper.el.id} so its text ends above y=${r0(lower.ink.y)}, or shrink one of the two (there is no room to move it down to y=${target})`,
            measured: { overflowPx: r0(upperEnd - lower.ink.y) },
          },
          lower.el,
        ),
      );
    }
  }
  return out;
}

/** Blend `fg` over `bg` at `alpha`. */
function blend(fg: string, bg: string, alpha: number): string {
  const ch = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const out = [0, 1, 2].map((i) => Math.round(ch(fg, i) * alpha + ch(bg, i) * (1 - alpha)));
  return `#${out.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/** The page's own ground, as the canvas paints it; null when it is a photo or a paint
 *  we cannot read (then contrast is left to the visual review). */
function pageGround(page: PageWithGround): string | null {
  const bg = page.background;
  if (!bg) return null;
  if (bg.type === 'image') return null;
  const v = (bg.value ?? '').trim();
  if (!v) return '#ffffff';
  const c = parseColor(v);
  if (c) return c.alpha >= 0.999 ? c.hex : blend(c.hex, '#ffffff', c.alpha);
  // A gradient: judge against the average of its stops.
  const stops = (v.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g) ?? []).map((s) => parseColor(s)?.hex).filter((s): s is string => !!s);
  if (!stops.length) return null;
  const ch = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const avg = [0, 1, 2].map((i) => Math.round(stops.reduce((n, s) => n + ch(s, i), 0) / stops.length));
  return `#${avg.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/** The colour behind a box: the topmost picture or shape drawn below `belowRank` that
 *  holds the box's centre (or covers a quarter of it), else the page. null = a photo
 *  (or a tint over one) — its colours are not known here. */
function groundUnder(box: Box, belowRank: number, ctx: PageCtx, depth = 0): string | null {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  let best: MagazineElement | null = null;
  let loose: MagazineElement | null = null;
  for (const o of ctx.elements) {
    const r = ctx.rank.get(o)!;
    if (r >= belowRank) continue;
    if (o.type === 'image' ? !o.image?.url : o.type !== 'shape' || (o.shape?.opacity ?? 1) <= 0.02) continue;
    if (cx >= o.x && cx <= o.x + o.w && cy >= o.y && cy <= o.y + o.h) {
      if (!best || r > ctx.rank.get(best)!) best = o;
    } else if (coverage(box, o) >= 0.25 && (!loose || r > ctx.rank.get(loose)!)) loose = o;
  }
  const under = best ?? loose;
  if (!under) return pageGround(ctx.page);
  if (under.type === 'image') return null;
  const fill = parseColor(under.shape?.fill)?.hex ?? '#000000';
  const op = under.shape?.opacity ?? 1;
  if (op >= 0.999) return fill;
  const beneath = depth < 4 ? groundUnder(box, ctx.rank.get(under)!, ctx, depth + 1) : null;
  return beneath === null ? null : blend(fill, beneath, op);
}

function contrastIssues(ctx: PageCtx): Built[] {
  const out: Built[] = [];
  // The page's own inks, most used first — a fix that keeps the palette beats black.
  const inkCount = new Map<string, number>();
  for (const el of ctx.elements) {
    const hex = el.type === 'text' && ctx.geom.has(el) ? parseColor(el.text?.color)?.hex : undefined;
    if (hex) inkCount.set(hex, (inkCount.get(hex) ?? 0) + 1);
  }
  const inks = [...inkCount.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const el of ctx.elements) {
    const g = ctx.geom.get(el);
    if (!g) continue;
    const color = parseColor(el.text?.color)?.hex;
    if (!color) continue;
    const ground = groundUnder(visibleInk(el, g), ctx.rank.get(el)!, ctx);
    if (!ground) continue;
    const ratio = contrastRatio(color, ground);
    if (ratio >= LOW_CONTRAST) continue;
    const own = inks.find(([c]) => c !== color && contrastRatio(c, ground) >= GOOD_CONTRAST)?.[0];
    const suggest = own ?? readableColor(color, ground, '#ffffff', '#111111');
    out.push(
      built(
        {
          kind: 'low-contrast',
          severity: 'warning',
          elementId: el.id,
          label: elementLabel(el),
          detail: `${color} type on a ${ground} ground — contrast ${ratio.toFixed(1)}:1, under the ${LOW_CONTRAST}:1 minimum`,
          fix: `set color ${suggest} (contrast ${contrastRatio(suggest, ground).toFixed(1)}:1 on this ground)`,
          measured: { contrast: Math.round(ratio * 100) / 100 },
        },
        el,
      ),
    );
  }
  return out;
}

function sizeMismatchIssues(ctx: PageCtx): Built[] {
  const out: Built[] = [];
  const list = ctx.elements.filter(
    (el) =>
      ctx.geom.has(el) &&
      !isFurniture(el) &&
      el.text?.role === 'body' &&
      visibleText(el.text.content).replace(/\s+/g, ' ').trim().length >= PARAGRAPH_MIN_CHARS,
  );
  if (list.length >= SIZE_MIN_GROUP) {
    const med = median(list.map((el) => el.text!.fontSize));
    for (const el of med > 0 ? list : []) {
      const size = el.text!.fontSize;
      if (size >= med * SIZE_LO && size <= med * SIZE_HI) continue;
      const target = r0(med);
      const need = heightAt(el, target);
      const others = list.length - 1;
      out.push(
        built(
          {
            kind: 'size-mismatch',
            severity: 'warning',
            elementId: el.id,
            label: elementLabel(el),
            detail: `${+size.toFixed(1)}px type, where the ${plural(others, 'other body paragraph')} on this page ${others === 1 ? 'is' : 'are'} set at ${+med.toFixed(1)}px (median)`,
            fix:
              need > el.h + CLIP_MIN_PX
                ? `set fontSize ${target}px to match, and ${growPhrase(el, need, freeSpaceBelow(el, ctx.elements, ctx.page))} (or cut the copy)`
                : `set fontSize ${target}px to match (it fits the box at that size)`,
            measured: { needPx: r0(need), havePx: r0(el.h) },
          },
          el,
        ),
      );
    }
  }
  return out;
}

function looseGapIssues(ctx: PageCtx): Built[] {
  const out: Built[] = [];
  const items = ctx.elements
    .filter((el) => ctx.geom.has(el) && !isFurniture(el))
    .map((el) => ({ el, ink: visibleInk(el, ctx.geom.get(el)!) }))
    .filter((it) => it.ink.h > 0 && it.ink.w > 0);
  // Columns: boxes sharing most of the wider one's width (union-find, so order free).
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!.el;
      const b = items[j]!.el;
      const ov = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      if (ov >= COLUMN_OVERLAP * Math.max(a.w, b.w)) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, typeof items>();
  items.forEach((it, i) => {
    const g = groups.get(find(i)) ?? [];
    g.push(it);
    groups.set(find(i), g);
  });
  // Anything that prints in a gap fills it (a subhead of another width, a rule, a photo).
  const fillers = ctx.elements.filter((el) => draws(el) && !isGroundLayer(el, ctx.page) && !isFurniture(el));
  for (const col of groups.values()) {
    if (col.length < 4) continue; // fewer than three gaps has no meaningful median
    col.sort((a, b) => a.ink.y - b.ink.y || a.ink.x - b.ink.x);
    const gaps: { gap: number; upper: (typeof col)[number]; lower: (typeof col)[number]; at: number }[] = [];
    for (let i = 0; i + 1 < col.length; i++) {
      const upper = col[i]!;
      const lower = col[i + 1]!;
      const gap = lower.ink.y - (upper.ink.y + upper.ink.h);
      if (gap >= 0) gaps.push({ gap, upper, lower, at: i + 1 });
    }
    if (gaps.length < 3) continue;
    const med = median(gaps.map((g) => g.gap));
    const big = gaps.filter((g) => g.gap > LOOSE_GAP_RATIO * med && g.gap > LOOSE_GAP_MIN_PX);
    // A RHYTHM is not a hole: three or more equal big gaps at a steady interval are the
    // spacing between repeated groups (a calendar's date + entry pairs), set on purpose.
    if (big.length >= 3) {
      const sizes = big.map((g) => g.gap);
      const steps = big.slice(1).map((g, i) => g.at - big[i]!.at);
      if (Math.max(...sizes) <= Math.min(...sizes) * 1.25 && steps.every((s) => s === steps[0])) continue;
    }
    for (const g of big) {
      // Extra air above a heading (a question in a Q&A, a subhead opening a section) is
      // typographic convention; only a hole twice the usual bar counts there.
      const role = g.lower.el.text?.role;
      const heading = role === 'headline' || role === 'subhead' || role === 'byline' || role === 'pullquote';
      if (heading && (g.gap <= 2 * LOOSE_GAP_RATIO * med || g.gap <= 2 * LOOSE_GAP_MIN_PX)) continue;
      const top = g.upper.ink.y + g.upper.ink.h;
      const x0 = Math.max(g.upper.el.x, g.lower.el.x);
      const x1 = Math.min(g.upper.el.x + g.upper.el.w, g.lower.el.x + g.lower.el.w);
      const filled = fillers.some((o) => {
        if (o === g.upper.el || o === g.lower.el) return false;
        const box = bodyBox(o, ctx);
        return Math.min(x1, box.x + box.w) - Math.max(x0, box.x) > 0 && Math.min(g.lower.ink.y, box.y + box.h) - Math.max(top, box.y) > 0;
      });
      if (filled) continue;
      const shift = r0(g.gap - med);
      const below = col.length - 1 - g.at;
      out.push(
        built(
          {
            kind: 'loose-gap',
            severity: 'warning',
            elementId: g.lower.el.id,
            otherId: g.upper.el.id,
            label: elementLabel(g.lower.el),
            detail: `a ${r0(g.gap)}px gap above it in its column (y ${r0(top)}–${r0(g.lower.ink.y)}), where the column's other gaps are ${r0(med)}px (median)`,
            fix: `move it up ${shift}px to y=${r0(g.lower.el.y - shift)}${below > 0 ? `, and the ${plural(below, 'box', 'boxes')} below it in this column up by the same ${shift}px` : ''}`,
            measured: { overflowPx: shift },
          },
          g.lower.el,
        ),
      );
    }
  }
  return out;
}

/** layoutValidate's quality advisories (slivers, oversize boxes, dead bands), as today,
 *  with a numbered fix each. */
function adviseQuality(ctx: PageCtx): Built[] {
  const out: Built[] = [];
  const q = pageQuality(ctx.elements, ctx.page);
  const byId = new Map(ctx.elements.map((el) => [el.id, el] as const));
  for (const s of q.slivers) {
    const el = byId.get(s.id);
    if (el) out.push(sliverIssue(el, s.problem));
  }
  for (const b of q.emptyBoxes) {
    const el = byId.get(b.id);
    if (!el) continue;
    const target = r0(b.inkH + (el.text ? el.text.fontSize * 0.5 : 8));
    out.push(
      built(
        {
          kind: 'empty-box',
          severity: 'warning',
          elementId: el.id,
          label: elementLabel(el),
          detail: `the box is ${r0(b.boxH)}px tall but its copy prints only ${r0(b.inkH)}px — ${r0(b.share * 100)}% of the page left blank inside one box`,
          fix: `shrink the box to about ${target}px tall and use the space it frees, or give it more copy`,
          measured: { needPx: r0(b.inkH), havePx: r0(b.boxH) },
        },
        el,
      ),
    );
  }
  for (const d of q.deadBands) {
    const len = d.y1 - d.y0;
    const atBottom = d.y1 >= ctx.page.height - 1;
    const atTop = d.y0 <= 1;
    const fix = atBottom
      ? `fill it: spread the content above y=${d.y0} down the page (bigger pictures, more space between blocks), grow the last element into it, or put a picture or copy there`
      : atTop
        ? `fill it: move the content below y=${d.y1} up by up to ${len}px, or put a picture or headline there`
        : `close it: move what is below y=${d.y1} up by up to ${len}px, grow the element above it into the space, or put a picture or copy there`;
    out.push(
      built(
        {
          kind: 'dead-band',
          severity: 'warning',
          label: `the band y ${d.y0}–${d.y1}`,
          detail: `nothing prints across the page from y=${d.y0} to y=${d.y1} (${len}px)${atBottom ? ', down to the bottom edge' : atTop ? ', from the top edge' : ''}`,
          fix,
        },
        { x: 0, y: d.y0 },
      ),
    );
  }
  return out;
}

function pageEmptyIssue(ctx: PageCtx): Built | null {
  if (ctx.page.background?.type === 'image' && ctx.page.background.value) return null;
  const content = ctx.elements.some((el) => el.type !== 'shape' && draws(el));
  if (content) return null;
  return built(
    {
      kind: 'page-empty',
      severity: 'error',
      label: 'the page',
      detail: `no words, picture, QR code or icon prints on this ${r0(ctx.page.width)}×${r0(ctx.page.height)}px page${ctx.elements.length ? ` (${plural(ctx.elements.length, 'element')}, none of them drawing content)` : ''}`,
      fix: 'add content (a headline, body copy or a picture), or delete the page',
    },
    { x: 0, y: 0 },
  );
}

function brokenImageIssues(ctx: PageCtx, measured: Map<string, ElementMeasurement>): Built[] {
  const out: Built[] = [];
  for (const el of ctx.elements) {
    const m = measured.get(el.id);
    if (!m || m.imgOk !== false) continue;
    const src = el.type === 'image' ? el.image?.url : el.type === 'icon' ? el.icon?.src : undefined;
    if (!src) continue;
    out.push(
      built(
        {
          kind: 'image-broken',
          severity: 'error',
          elementId: el.id,
          label: elementLabel(el),
          detail: `the picture in this ${r0(el.w)}×${r0(el.h)}px box did not load in the render — it prints as a blank`,
          fix: `place a picture in it again (${r0(el.w)}×${r0(el.h)}px, aspect ${(Math.max(1, el.w) / Math.max(1, el.h)).toFixed(2)}:1 — from the library, an upload or a new one), or delete the box`,
        },
        el,
      ),
    );
  }
  return out;
}

// ── Assembly ─────────────────────────────────────────────────────────────────

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/**
 * The numbers the rules read, made finite. Callers pass stored (validated) elements,
 * but a model's working copy can hold a half-merged patch; one NaN must not turn every
 * comparison false and wave a broken page through as "no problems". Elements that are
 * already sound are returned as they are.
 */
function sane(el: MagazineElement): MagazineElement {
  const t = el.text;
  const ok =
    [el.x, el.y, el.w, el.h, el.zIndex].every((v) => typeof v === 'number' && Number.isFinite(v)) &&
    (!t || [t.fontSize, t.lineHeight, t.fontWeight].every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0));
  if (ok) return el;
  const out: MagazineElement = { ...el, x: num(el.x, 0), y: num(el.y, 0), w: num(el.w, 0), h: num(el.h, 0), zIndex: num(el.zIndex, 0) };
  if (t) {
    out.text = {
      ...t,
      content: typeof t.content === 'string' ? t.content : '',
      fontSize: num(t.fontSize, 16) || 16,
      lineHeight: num(t.lineHeight, 1.3) || 1.3,
      fontWeight: (num(t.fontWeight, 400) || 400) as ElementTextData['fontWeight'],
    };
  }
  return out;
}

function allIssues(input: MagazineElement[], page: PageWithGround, measured?: Map<string, ElementMeasurement>): Built[] {
  const elements = input.filter((el) => el && typeof el === 'object').map(sane);
  const ctx = makeCtx(elements, page, measured);
  const nb: Neighbours = { elements, page };
  const out: Built[] = [];
  const empty = pageEmptyIssue(ctx);
  if (empty) out.push(empty);
  for (const el of elements) out.push(...elementIssues(el, page, ctx.geom.get(el) ?? null, nb));
  out.push(...hiddenIssues(ctx));
  out.push(...overlapIssues(ctx));
  out.push(...contrastIssues(ctx));
  out.push(...sizeMismatchIssues(ctx));
  out.push(...looseGapIssues(ctx));
  // An empty page is one big dead band; saying so twice helps nobody.
  out.push(...adviseQuality(ctx).filter((b) => !(empty && b.issue.kind === 'dead-band')));
  if (measured) out.push(...brokenImageIssues(ctx, measured));
  return out;
}

const SEV = { error: 0, warning: 1 } as const;

/** Errors first, then by importance, then in reading order — the same input always
 *  gives the same list. */
function ordered(list: Built[]): PageCheckIssue[] {
  const cmp = (a?: string, b?: string) => ((a ?? '') < (b ?? '') ? -1 : (a ?? '') > (b ?? '') ? 1 : 0);
  return [...list]
    .sort(
      (a, b) =>
        SEV[a.issue.severity] - SEV[b.issue.severity] ||
        KIND_ORDER.indexOf(a.issue.kind) - KIND_ORDER.indexOf(b.issue.kind) ||
        a.y - b.y ||
        a.x - b.x ||
        cmp(a.issue.elementId, b.issue.elementId) ||
        cmp(a.issue.otherId, b.issue.otherId) ||
        cmp(a.issue.detail, b.issue.detail),
    )
    .map((b) => b.issue);
}

function finish(issues: PageCheckIssue[], measuredBy: PageCheck['measuredBy'], pageNumber?: number): PageCheck {
  const capped = issues.slice(0, MAX_ISSUES);
  const check: PageCheck = {
    ...(typeof pageNumber === 'number' ? { page: pageNumber } : {}),
    measuredBy,
    ok: !capped.some((i) => i.severity === 'error'),
    issues: capped,
    summary: '',
  };
  check.summary = checkSummary(check);
  return check;
}

/**
 * Check a whole page from its element data (the server's estimate). `page.background`
 * is the page's own ground; without it, text standing on the bare page is not judged
 * for contrast (on a shape it still is).
 */
export function checkPage(
  elements: MagazineElement[],
  page: { width: number; height: number; background?: { type: string; value: string } },
  opts: { pageNumber?: number } = {},
): PageCheck {
  return finish(allPageIssues(elements, page), 'estimate', opts.pageNumber);
}

/**
 * Every issue checkPage would find, in its order but NOT capped at MAX_ISSUES — for
 * comparing two states of a page. A capped list cannot be diffed: on a copied PDF page
 * with more than a dozen errors, an error cut from the "before" list reappears in the
 * "after" list once another is fixed, and was reported as new. Show the result capped.
 */
export function allPageIssues(
  elements: MagazineElement[],
  page: { width: number; height: number; background?: { type: string; value: string } },
): PageCheckIssue[] {
  return ordered(allIssues(elements ?? [], page));
}

/**
 * The same rules fed with what a browser drew: clipping, edges, spills and overlaps
 * from the measured text blocks (real fonts, real wrapping), broken pictures from the
 * images that failed to load; everything else from the element data. An element with
 * no measurement falls back to the estimate. Ordered and capped like checkPage.
 */
export function issuesFromMeasurements(
  m: ElementMeasurement[],
  elements: MagazineElement[],
  page: { width: number; height: number; background?: { type: string; value: string } },
): PageCheckIssue[] {
  const byId = new Map<string, ElementMeasurement>();
  for (const x of m ?? []) if (x && typeof x.id === 'string' && !byId.has(x.id)) byId.set(x.id, x);
  return ordered(allIssues(elements ?? [], page, byId)).slice(0, MAX_ISSUES);
}

/** A whole PageCheck from browser measurements (issuesFromMeasurements + summary). */
export function checkPageFromMeasurements(
  m: ElementMeasurement[],
  elements: MagazineElement[],
  page: { width: number; height: number; background?: { type: string; value: string } },
  opts: { pageNumber?: number; measuredBy?: 'chromium' | 'browser' } = {},
): PageCheck {
  return finish(issuesFromMeasurements(m, elements, page), opts.measuredBy ?? 'chromium', opts.pageNumber);
}

/**
 * One element on its own — the "fit" an edit tool returns. Only the rules that need
 * nothing but the element: does its text fit (clipped / past the edge / spilling),
 * is it empty, tiny, off the page, an empty or sliver picture box.
 *
 *  fits      false when the element has an error, or its copied text spills
 *  needPx    height (px) its copy needs at its current size (text only)
 *  havePx    its box height (text only)
 *  fitsAtPx  when it does not fit: the largest size at which it would (never under
 *            the legibility floor); absent when no legible size fits
 */
export function checkElement(
  el: MagazineElement,
  page: { width: number; height: number },
): { fits: boolean; needPx?: number; havePx?: number; fitsAtPx?: number; issues: PageCheckIssue[] } {
  el = sane(el);
  const g = estimateGeom(el);
  const list = elementIssues(el, page, g);
  if (el.type === 'image') {
    // On its own an image backs no text, so the shape rule applies as it stands.
    const p = imageShapeProblem(el, page);
    if (p) list.push(sliverIssue(el, p));
  }
  const issues = ordered(list);
  const fits = !issues.some((i) => i.severity === 'error' || i.kind === 'text-spills');
  const out: { fits: boolean; needPx?: number; havePx?: number; fitsAtPx?: number; issues: PageCheckIssue[] } = { fits, issues };
  if (g) {
    out.needPx = r0(g.needPx);
    out.havePx = r0(el.h);
    if (!fits) {
      const at = issues.find((i) => i.measured?.fitsAtPx !== undefined)?.measured?.fitsAtPx;
      if (at !== undefined) out.fitsAtPx = at;
    }
  }
  return out;
}

// ── Comparing and summarising ────────────────────────────────────────────────

function issueKey(i: PageCheckIssue): string {
  // An overlap is the same overlap whichever of the pair is named first.
  const ids = i.kind === 'text-overlap' ? [i.elementId ?? '', i.otherId ?? ''].sort() : [i.elementId ?? '', i.otherId ?? ''];
  return `${i.kind}|${ids.join('|')}`;
}

/**
 * The errors in `after` that were not in `before` — what a turn of edits BROKE, not
 * what was already wrong. The same error on the same element counts as new only when
 * it got clearly worse (its overflow grew by half again and by more than 8px).
 */
export function newErrors(before: PageCheck, after: PageCheck): PageCheckIssue[] {
  return newErrorsIn(before?.issues ?? [], after?.issues ?? []);
}

/**
 * newErrors over two issue lists. Give it UNCAPPED lists (allPageIssues) whenever a
 * page may have more issues than a PageCheck shows; cap what it returns for display.
 */
export function newErrorsIn(before: ReadonlyArray<PageCheckIssue>, after: ReadonlyArray<PageCheckIssue>): PageCheckIssue[] {
  const was = new Map<string, PageCheckIssue>();
  for (const i of before ?? []) if (i.severity === 'error') was.set(issueKey(i), i);
  return (after ?? []).filter((i) => {
    if (i.severity !== 'error') return false;
    const prev = was.get(issueKey(i));
    if (!prev) return true;
    const a = i.measured?.overflowPx;
    const b = prev.measured?.overflowPx;
    return typeof a === 'number' && typeof b === 'number' && a > b * 1.5 + 8;
  });
}

/** One paragraph a model (or a person) can read: counts, then each error and the
 *  first warnings by name. */
export function checkSummary(check: PageCheck): string {
  const where = typeof check.page === 'number' ? `Page ${check.page}` : 'This page';
  const how =
    check.measuredBy === 'chromium' ? 'measured on a render of the page' : check.measuredBy === 'browser' ? 'measured in the editor' : 'estimated from the element data';
  const issues = check.issues ?? [];
  if (!issues.length) return `${where}: no problems found (${how}).`;
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const counts = [errors.length ? plural(errors.length, 'error') : '', warnings.length ? plural(warnings.length, 'warning') : ''].filter(Boolean).join(', ');
  const name = (i: PageCheckIssue) => `${i.label}: ${KIND_WORDS[i.kind]}`;
  const parts = [`${where}: ${counts}${issues.length >= MAX_ISSUES ? ' (the most important shown)' : ''} (${how}).`];
  if (errors.length) parts.push(`Errors: ${errors.slice(0, 4).map(name).join('; ')}${errors.length > 4 ? `; and ${errors.length - 4} more` : ''}.`);
  if (warnings.length) parts.push(`Warnings: ${warnings.slice(0, 3).map(name).join('; ')}${warnings.length > 3 ? `; and ${warnings.length - 3} more` : ''}.`);
  return parts.join(' ');
}
