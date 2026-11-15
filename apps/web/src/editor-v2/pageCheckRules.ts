// ---------------------------------------------------------------------------
// Magazine Builder v2 — the PAGE CHECK rules, web twin.
//
// The Stable Hand (the in-site operator) checked its work with readScreen, which
// collects the page's words whether or not they are clipped and has no geometry at
// all. So copy cut off by its box, a rewritten PDF line running off the page edge or a
// photo hidden under a panel all passed as "done" — and when the client said "the text
// is cut off", it answered that it could not see the page (2026-11-15).
//
// This is the same rule set as the server's lib/magazineV2/pageCheck.ts — the same
// kinds, thresholds, wording, ordering, cap and PageCheck shape — fed with what the
// user's own browser drew: editor-v2/pageCheck.ts mounts the page off-screen at its
// canonical width (one CSS px = one page px), waits for its fonts and pictures, and
// measures every element. Both agents therefore read one report format, and a problem
// the Studio is told about is described exactly as the operator would describe it.
// KEEP THE TWO IN STEP, like lib/pdfLines.ts and the server's extractedText.ts:
// pageCheckRules.test.ts checks every threshold against the server's source and runs
// the server's rules on the same measurements.
//
// Where the browser lets this twin do better than the server's measured mode, it does,
// and only there:
//   - Fit SUGGESTIONS ("set fontSize 17px", "make the box 412px tall") come from a
//     TextProbe — the copy laid out again in the same browser at the candidate size —
//     instead of the server's glyph-width estimate. Without a probe (the unit tests),
//     a measured block is scaled by the square of the size, the model the server
//     already uses to hold its estimate to a measurement.
//   - Oversize boxes and dead bands (layoutValidate.pageQuality on the server) read
//     the MEASURED height of each text block rather than an estimate.
//   - There is no estimator here: a text element the browser did not report is not
//     judged for fit at all (never reported clipped or fine on a guess). Every rule
//     that needs only the element data (empty boxes, tiny type, contrast, stacking,
//     off-page, slivers) still runs for it.
//
// Output is deterministic (no clock, no randomness, stable ordering), errors first,
// capped at MAX_ISSUES so a broken page cannot flood a model's context.
//
// Pure: no DOM, no React, no I/O.
// ---------------------------------------------------------------------------

import type { ElementTextWeight, MagazineElement } from './model';
import { keepsPdfLines } from '../lib/pdfLines';

// ── Contract (identical to the server's pageCheck.ts) ────────────────────────

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
 *    finished loading with no pixels (broken); absent while unknown. */
export interface ElementMeasurement {
  id: string;
  box: { x: number; y: number; w: number; h: number };
  contentW?: number;
  contentH?: number;
  ink?: { x: number; y: number; w: number; h: number };
  imgOk?: boolean;
}

/**
 * Lays an element's copy out again in the browser at another type size, WRAPPED in the
 * element's own box width (white-space: pre-wrap — what any edit turns copied PDF text
 * into), and returns the height (page px) it needs. Undefined/null when it cannot.
 * Synchronous: the page is already mounted and its fonts loaded, so this is one forced
 * layout per call.
 */
export type TextProbe = (el: MagazineElement, fontSize: number) => number | null | undefined;

export interface RuleOptions {
  /** Real fit numbers for the suggestions; see TextProbe. */
  probe?: TextProbe;
}

type PageDims = { width: number; height: number };
type PageWithGround = PageDims & { background?: { type: string; value: string } };

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ── Thresholds (server: lib/magazineV2/pageCheck.ts — keep in step) ──────────

/** At most this many issues are returned (errors first), so a broken page cannot
 *  flood a model's context; the summary says when the list was cut. */
export const MAX_ISSUES = 12;
/** Wrapped text is CLIPPED (its box is overflow:hidden) when it needs more than this
 *  share of its box — and more than CLIP_MIN_PX, so the half-leading under the last
 *  line, which hides nothing, never counts. */
export const CLIP_RATIO = 1.02;
export const CLIP_MIN_PX = 4;
/** Text copied from a PDF is drawn overflow:visible: it SPILLS past its box instead of
 *  being cut. More than this share over (wider or taller) is worth a warning. */
export const SPILL_RATIO = 1.1;
/** Slack before ink counts as past the page edge. The two allowances below apply only
 *  to the server's ESTIMATE (a browser measurement needs none); they are kept here so
 *  the formulas read exactly as the server's do. */
export const EDGE_TOL_PX = 4;
export const EDGE_ESTIMATE_SLACK = 0.02;
export const APPROX_METRICS_SLACK = 0.15;
/** Text on text: the rule validatePageLayout applies to boxes, applied to the INK. */
export const OVERLAP_SHARE = 0.2;
/** An element this much covered by an opaque picture or panel drawn above it is
 *  hidden. Opaque = a picture, or a shape at or above HIDING_OPACITY. */
export const HIDDEN_COVER = 0.9;
/** Below the type scale's lowest floor (roleScale.ts: a caption's 12px, about 5.8pt). */
export const TINY_TEXT_PX = 12;
/** WCAG's floor for large text. Body copy wants 4.5; anything under 3 is genuinely
 *  hard to read whatever its size. */
export const LOW_CONTRAST = 3;
/** A colour from the page's own palette is suggested only when it reads this well. */
export const GOOD_CONTRAST = 4.5;
/** Among SIZE_MIN_GROUP or more body PARAGRAPHS (body role, at least
 *  PARAGRAPH_MIN_CHARS of copy), a size outside this band around their median is out
 *  of step — the leftover of a copied-PDF paragraph rewritten and shrunk to fit while
 *  its neighbours kept their size. */
export const SIZE_LO = 0.8;
export const SIZE_HI = 1.25;
export const SIZE_MIN_GROUP = 3;
export const PARAGRAPH_MIN_CHARS = 120;
/** In one column (boxes sharing COLUMN_OVERLAP of the wider one's width), a gap more
 *  than LOOSE_GAP_RATIO × the column's median gap and more than LOOSE_GAP_MIN_PX —
 *  with nothing printed in it. Above a heading both bars double, and three or more
 *  equal big gaps at a steady interval are a deliberate rhythm, not a hole. */
export const LOOSE_GAP_RATIO = 2.5;
export const LOOSE_GAP_MIN_PX = 40;
export const COLUMN_OVERLAP = 0.8;

// Server: layoutQuality.ts (the shared geometric quality rules).
/** Above this opacity a wash over a photo HIDES it. */
export const HIDING_OPACITY = 0.8;
/** The darkest a scrim spread over most of the sheet may be. */
export const MAX_COVERING_SCRIM_OPACITY = 0.7;
/** The sane shape of a photograph (width ÷ height), and the wider range a bleed gets. */
export const IMAGE_MIN_ASPECT = 0.5;
export const IMAGE_MAX_ASPECT = 2.5;
export const BLEED_MIN_ASPECT = 1 / 3;
export const BLEED_MAX_ASPECT = 4;
/** Below this on its short side a photo is a thumbnail at best. */
export const IMAGE_MIN_SIDE = 120;
/** …and below this share of the sheet it is a postage stamp, whatever its shape. */
export const IMAGE_MIN_AREA_SHARE = 0.01;
/** A photo this big is a BACKGROUND; its shape is the page's shape. */
export const BACKGROUND_SHARE = 0.45;
/** A full-width stripe of nothing this tall (share of the sheet) is a dead band… */
export const DEAD_BAND_SHARE = 0.1;
/** …after a stripe touching the top or bottom edge has paid this much for the margin. */
export const EDGE_ALLOWANCE_SHARE = 0.057;
// Server: fitReport.ts — a text box is oversize when its copy fills less than SLACK_AT
// of it AND the blank part is at least SLACK_SERIOUS_SHARE of the sheet.
export const SLACK_AT = 0.55;
export const SLACK_SERIOUS_SHARE = 0.06;
/** Server: config.ts — the page is rendered at 150 DPI, so pt = px × 0.48. */
export const PAGE_DPI = 150;

/** Server: pageFurniture.ts — the running head and folio. Chrome, not content: exempt
 *  from tiny-text, empty-box, size and gap rules. */
export const FURNITURE_IDS: readonly string[] = [
  'furniture-head-label',
  'furniture-head-title',
  'furniture-head-rule',
  'furniture-folio',
  'furniture-folio-rule',
];

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

// ── Visible text (server: textReplace.ts visibleText) ────────────────────────

/** A tag (or comment) in the inline HTML the sanitizer stores. */
const TAG_RE = /<\/?[a-zA-Z][^>]*>|<!--[\s\S]*?-->/g;
const BR_RE = /^<br\b/i;
const ENTITY_RE = /&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;
/** Named entities worth decoding — the server's list; an unknown name stays literal. */
const NAMED = new Map<string, string>(
  Object.entries({
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    rsquo: '’',
    lsquo: '‘',
    rdquo: '”',
    ldquo: '“',
    sbquo: '‚',
    bdquo: '„',
    mdash: '—',
    ndash: '–',
    hellip: '…',
    shy: '­',
    copy: '©',
    reg: '®',
    trade: '™',
    deg: '°',
    middot: '·',
    bull: '•',
    eacute: 'é',
    egrave: 'è',
    aacute: 'á',
    agrave: 'à',
    ouml: 'ö',
    uuml: 'ü',
    auml: 'ä',
    ccedil: 'ç',
    pound: '£',
    euro: '€',
    times: '×',
    frac12: '½',
  }),
);

function decodeEntity(body: string): string | null {
  if (body[0] === '#') {
    const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    return String.fromCodePoint(cp);
  }
  // A Map, not an object lookup: "&constructor;" must not resolve to a prototype member.
  return NAMED.get(body) ?? NAMED.get(body.toLowerCase()) ?? null;
}

/**
 * The text a reader sees in a stored text element: tags dropped, entities decoded,
 * <br> as "\n" (PDF line joins already are). Non-breaking spaces read as spaces. The
 * same answer as the server's visibleText, so labels and lengths agree.
 */
export function visibleText(html: string): string {
  const source = html ?? '';
  const decode = (s: string) => s.replace(ENTITY_RE, (whole, body: string) => decodeEntity(body) ?? whole);
  let out = '';
  let last = 0;
  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(source); m; m = TAG_RE.exec(source)) {
    out += decode(source.slice(last, m.index));
    if (BR_RE.test(m[0])) out += '\n';
    last = m.index + m[0].length;
  }
  out += decode(source.slice(last));
  return out.replace(/ /g, ' ');
}

// ── Colour (server: model.ts parseColor, layout.ts contrast) ─────────────────

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const to2 = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');

/** Read a colour the way a designer (or a model) writes it: #rgb, #rgba, #rrggbb,
 *  #rrggbbaa, rgb()/rgba(), black/white/transparent. Null for anything else. */
export function parseColor(v: unknown): { hex: string; alpha: number } | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (HEX_RE.test(s)) return { hex: s, alpha: 1 };
  let m = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/.exec(s);
  if (m) {
    const h = `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`;
    return { hex: h, alpha: m[4] ? parseInt(m[4] + m[4], 16) / 255 : 1 };
  }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})$/.exec(s);
  if (m) return { hex: `#${m[1]}`, alpha: parseInt(m[2]!, 16) / 255 };
  m = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    const ch = (c: string) => (c.endsWith('%') ? (parseFloat(c) / 100) * 255 : parseFloat(c));
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    if (![m[1], m[2], m[3]].every((c) => Number.isFinite(ch(c!))) || !Number.isFinite(a)) return null;
    return { hex: `#${to2(ch(m[1]!))}${to2(ch(m[2]!))}${to2(ch(m[3]!))}`, alpha: Math.min(1, Math.max(0, a)) };
  }
  if (s === 'black') return { hex: '#000000', alpha: 1 };
  if (s === 'white') return { hex: '#ffffff', alpha: 1 };
  if (s === 'transparent') return { hex: '#000000', alpha: 0 };
  return null;
}

function toRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function relativeLuminance(hex: string): number {
  if (!HEX_RE.test(hex)) return 0;
  const [r, g, b] = toRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
/** WCAG contrast ratio of two #rrggbb colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
/** `desired` if it reads acceptably on `bg`; otherwise the light or dark candidate
 *  that contrasts best (server: layout.ts readableColor). */
export function readableColor(desired: string, bg: string, light: string, dark: string): string {
  const MIN = 3.5;
  if (HEX_RE.test(desired) && HEX_RE.test(bg) && contrastRatio(desired, bg) >= MIN) return desired;
  const candLight = HEX_RE.test(light) ? light : '#ffffff';
  const candDark = HEX_RE.test(dark) ? dark : '#111111';
  return contrastRatio(candLight, bg) >= contrastRatio(candDark, bg) ? candLight : candDark;
}

const pxToPt = (px: number): number => (px * 72) / PAGE_DPI;

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

/** Share of `inner` that lies inside `outer` (0–1). */
function coverage(inner: Box, outer: Box): number {
  const w = Math.min(inner.x + inner.w, outer.x + outer.w) - Math.max(inner.x, outer.x);
  const h = Math.min(inner.y + inner.h, outer.y + outer.h) - Math.max(inner.y, outer.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.max(1, inner.w * inner.h);
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

// ── Picture shape and dead bands (server: layoutQuality.ts) ──────────────────

type ImageShapeKind = 'tiny' | 'too-tall' | 'too-wide';
interface ImageShapeProblem {
  kind: ImageShapeKind;
  aspect: number;
  lo: number;
  hi: number;
  detail: string;
}

const BLEED_EDGE_TOL = 2;

function bleeds(box: Box, page: PageDims): boolean {
  const acrossX = box.x <= BLEED_EDGE_TOL && box.x + box.w >= page.width - BLEED_EDGE_TOL;
  const acrossY = box.y <= BLEED_EDGE_TOL && box.y + box.h >= page.height - BLEED_EDGE_TOL;
  return acrossX || acrossY;
}

function imageShapeProblem(box: Box, page: PageDims): ImageShapeProblem | null {
  const pageArea = Math.max(1, page.width * page.height);
  if (box.w <= 0 || box.h <= 0) return { kind: 'tiny', aspect: 0, lo: IMAGE_MIN_ASPECT, hi: IMAGE_MAX_ASPECT, detail: 'the photo has no area at all' };
  if ((box.w * box.h) / pageArea >= BACKGROUND_SHARE) return null;
  const aspect = box.w / box.h;
  const { lo, hi } = bleeds(box, page) ? { lo: BLEED_MIN_ASPECT, hi: BLEED_MAX_ASPECT } : { lo: IMAGE_MIN_ASPECT, hi: IMAGE_MAX_ASPECT };
  const size = `${Math.round(box.w)}×${Math.round(box.h)}`;
  if (Math.min(box.w, box.h) < IMAGE_MIN_SIDE || (box.w * box.h) / pageArea < IMAGE_MIN_AREA_SHARE) {
    return { kind: 'tiny', aspect, lo, hi, detail: `the photo is ${size}px — too small to read as a picture (keep it at least ${IMAGE_MIN_SIDE}px on its short side)` };
  }
  if (aspect < lo) {
    return { kind: 'too-tall', aspect, lo, hi, detail: `the photo is ${size}px (aspect ${aspect.toFixed(2)}) — a sliver standing on end; a photo needs at least ${lo.toFixed(2)}:1` };
  }
  if (aspect > hi) {
    return { kind: 'too-wide', aspect, lo, hi, detail: `the photo is ${size}px (aspect ${aspect.toFixed(2)}) — a ribbon, not a picture; a photo needs at most ${hi.toFixed(2)}:1` };
  }
  return null;
}

interface Band {
  y0: number;
  y1: number;
}

/** Full-width horizontal stripes of the sheet that nothing inks, at least
 *  DEAD_BAND_SHARE of the page tall after edge stripes pay the margin allowance. */
function deadBands(ink: { y: number; h: number }[], pageHeight: number): Band[] {
  const H = Math.max(1, pageHeight);
  const min = H * DEAD_BAND_SHARE;
  const allowance = H * EDGE_ALLOWANCE_SHARE;
  const spans = ink
    .filter((b) => b.h > 0)
    .map((b) => [Math.max(0, b.y), Math.min(H, b.y + b.h)] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  const bands: Band[] = [];
  let cursor = 0;
  const consider = (y0: number, y1: number) => {
    let len = y1 - y0;
    if (y0 <= 0) len -= allowance;
    if (y1 >= H) len -= allowance;
    if (len >= min) bands.push({ y0: Math.round(y0), y1: Math.round(y1) });
  };
  for (const [a, b] of spans) {
    if (a > cursor) consider(cursor, a);
    cursor = Math.max(cursor, b);
  }
  if (cursor < H) consider(cursor, H);
  return bands;
}

// ── Text geometry: what a text element prints, as the browser measured it ────

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
  /** False: no measurement for this element — its box stands in, and its fit is not
   *  judged (there is no estimator in the browser). */
  measured: boolean;
  /** The server's allowance for an estimate from stand-in metrics; always 0 here. */
  slack: number;
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

/** An unmeasured text element: its own box stands in for its lines. */
function boxGeom(el: MagazineElement): TextGeom | null {
  const t = el.text;
  if (el.type !== 'text' || !t) return null;
  if (!visibleText(t.content ?? '').trim()) return null;
  return {
    pdfLines: keepsPdfLines(el),
    clips: el.source !== 'extracted',
    needPx: el.h,
    widestPx: el.w,
    ink: { x: el.x, y: el.y, w: el.w, h: el.h },
    measured: false,
    slack: 0,
  };
}

const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function measuredGeom(el: MagazineElement, m: ElementMeasurement): TextGeom | null {
  const base = boxGeom(el);
  if (!base) return null;
  const inkM =
    m.ink && [m.ink.x, m.ink.y, m.ink.w, m.ink.h].every((v) => finite(v) !== undefined) ? { x: m.ink.x, y: m.ink.y, w: m.ink.w, h: m.ink.h } : undefined;
  const needPx = finite(m.contentH) ?? inkM?.h ?? base.needPx;
  const widestPx = base.pdfLines ? (inkM?.w ?? finite(m.contentW) ?? base.widestPx) : el.w;
  const ink = inkM ?? { x: inkLeft(el, widestPx), y: inkTop(el, needPx), w: base.pdfLines ? widestPx : el.w, h: needPx };
  return { ...base, needPx, widestPx, ink, measured: true, slack: 0 };
}

/** The ink that can collide with other ink: clipped to the box when the box clips.
 *  (The server's estimate branch is kept for an unmeasured box, which never overshoots.) */
function visibleInk(el: MagazineElement, g: TextGeom): Box {
  if (g.clips) return intersect(g.ink, el);
  if (g.measured) return g.ink;
  const w = g.ink.w > el.w * (SPILL_RATIO + g.slack) ? g.ink.w : Math.min(g.ink.w, el.w);
  const h = g.ink.h > el.h * (SPILL_RATIO + (g.pdfLines ? 0 : g.slack)) ? g.ink.h : Math.min(g.ink.h, el.h);
  const x = w === g.ink.w ? g.ink.x : inkLeft(el, w);
  const y = h === g.ink.h ? g.ink.y : inkTop(el, h);
  return { x, y, w, h };
}

// ── Fit numbers for the suggestions ──────────────────────────────────────────

interface Fitter {
  /** Height (px) the copy needs at `fontSize`, wrapped in the box's width. */
  heightAt(el: MagazineElement, g: TextGeom | null, fontSize: number): number;
  /** Whether a real browser probe answers (vs the scaling model). */
  probed(el: MagazineElement): boolean;
}

function makeFitter(probe?: TextProbe): Fitter {
  const memo = new Map<string, number | undefined>();
  const ask = (el: MagazineElement, size: number): number | undefined => {
    if (!probe) return undefined;
    const key = `${el.id}|${size}`;
    if (memo.has(key)) return memo.get(key);
    let v: number | undefined;
    try {
      const raw = probe(el, size);
      v = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
    } catch {
      v = undefined;
    }
    memo.set(key, v);
    return v;
  };
  return {
    heightAt(el, g, fontSize) {
      const real = ask(el, fontSize);
      if (real !== undefined) return real;
      // The scaling model: at k× the size a wrapped block takes about k× the lines,
      // each k× taller (the server holds its estimate to a measurement the same way).
      const t = el.text!;
      const k = fontSize / Math.max(1, t.fontSize);
      const need = g ? g.needPx : el.h;
      if (g?.pdfLines) {
        // Its PDF lines, each wrapped into the box: an upper bound from the widest.
        const lineH = Math.max(1, t.fontSize * t.lineHeight);
        const lines = Math.max(1, Math.round(need / lineH));
        const rows = Math.max(1, Math.ceil((g.widestPx * k) / Math.max(1, el.w)));
        return lines * rows * fontSize * t.lineHeight;
      }
      return need * k * k;
    },
    probed(el) {
      return !!probe && ask(el, el.text?.fontSize ?? 0) !== undefined;
    },
  };
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

/** The largest size (≥ the legibility floor, ≤ `below`) at which the copy, wrapped in
 *  its box, fits the box — or undefined when even the floor does not. The same integer
 *  search as the server's fitFontSize, over browser-measured heights. */
function fitsAt(el: MagazineElement, g: TextGeom | null, below: number, fit: Fitter): number | undefined {
  const floor = suggestionFloor(el);
  const max = Math.max(6, below);
  const min = Math.max(6, Math.min(floor, max));
  const fits = (size: number) => fit.heightAt(el, g, size) <= el.h;
  let size = max;
  if (!fits(max)) {
    let lo = min;
    let hi = max;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(mid)) lo = mid;
      else hi = mid - 1;
    }
    size = lo;
  }
  return fit.heightAt(el, g, size) <= el.h ? size : undefined;
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
function textFitIssues(el: MagazineElement, g: TextGeom, page: PageDims, fit: Fitter, nb?: Neighbours): Built[] {
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
      // Probed: the browser's own answer at each candidate size. Not probed: the
      // scaling model, held to the server's square-root rule exactly.
      let at = fitsAt(el, g, t.fontSize, fit);
      if (!fit.probed(el)) {
        const scaled = Math.floor(t.fontSize * Math.sqrt(el.h / g.needPx));
        at = Math.min(at ?? Infinity, scaled);
      }
      if (at !== undefined && !(at >= suggestionFloor(el) && at < t.fontSize)) at = undefined;
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
  // box and shrinks to fit from its current size (the server's write path) — the way
  // out for both problems below. Worked out only when there is a problem.
  const flow = () => {
    const at = fitsAt(el, g, t.fontSize, fit);
    const words =
      at !== undefined
        ? `edit it (a change to its words, size or width makes it wrap inside its ${r0(el.w)}px box; it fits there at ${at}px)`
        : `edit it so it wraps inside its ${r0(el.w)}px box, and ${growPhrase(el, fit.heightAt(el, g, suggestionFloor(el)), free())}`;
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

/** Rules that need nothing but the element itself (and, for fit, its measurement). */
function elementIssues(el: MagazineElement, page: PageDims, g: TextGeom | null, fit: Fitter, nb?: Neighbours): Built[] {
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
    // Fit is judged only from what the browser drew (see the header).
    if (g.measured) out.push(...textFitIssues(el, g, page, fit, nb));
    if (t.fontSize < TINY_TEXT_PX - 0.01 && !isFurniture(el)) {
      const need = fit.heightAt(el, g, TINY_TEXT_PX);
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

/** A photo cut into a sliver, with the size that fixes it. */
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
  fit: Fitter;
}

function makeCtx(elements: MagazineElement[], page: PageWithGround, measured: Map<string, ElementMeasurement>, fit: Fitter): PageCtx {
  const rank = new Map<MagazineElement, number>();
  elements
    .map((el, i) => ({ el, i }))
    .sort((a, b) => (a.el.zIndex ?? 0) - (b.el.zIndex ?? 0) || a.i - b.i)
    .forEach(({ el }, r) => rank.set(el, r));
  const geom = new Map<MagazineElement, TextGeom>();
  for (const el of elements) {
    if (el.type !== 'text') continue;
    const m = measured.get(el.id);
    const g = m ? measuredGeom(el, m) : boxGeom(el);
    if (g) geom.set(el, g);
  }
  return { elements, page, rank, geom, fit };
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
    // A wash too dark to see through is fixed by thinning it, not by lifting a photo
    // over the type it was washing.
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
      const need = ctx.fit.heightAt(el, ctx.geom.get(el) ?? null, target);
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
    // spacing between repeated groups, set on purpose.
    if (big.length >= 3) {
      const sizes = big.map((g) => g.gap);
      const steps = big.slice(1).map((g, i) => g.at - big[i]!.at);
      if (Math.max(...sizes) <= Math.min(...sizes) * 1.25 && steps.every((s) => s === steps[0])) continue;
    }
    for (const g of big) {
      // Extra air above a heading is typographic convention; only a hole twice the
      // usual bar counts there.
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

/** The vertical extent a text element prints (server: layoutValidate.textInk), from
 *  its MEASURED height. */
function textInk(el: MagazineElement, ctx: PageCtx): { y: number; h: number } | null {
  if (el.type !== 'text' || !el.text) return null;
  if (!el.text.content.replace(/<[^>]+>/g, '').trim()) return null;
  const g = ctx.geom.get(el);
  // Markup that draws nothing a reader sees (a lone &nbsp;) prints one empty line.
  const need = g ? g.needPx : el.text.fontSize * el.text.lineHeight;
  const h = Math.min(el.h, need);
  const y = el.text.vAlign === 'bottom' ? el.y + el.h - h : el.text.vAlign === 'center' ? el.y + (el.h - h) / 2 : el.y;
  return { y, h };
}

/** A shape laid over a photo is its scrim — the photo's tint, not ink of its own. */
function isScrimEl(el: MagazineElement, all: MagazineElement[]): boolean {
  return el.type === 'shape' && all.some((o) => o !== el && o.type === 'image' && o.zIndex <= el.zIndex && coverage(o, el) > 0);
}

interface PageQuality {
  slivers: { id: string; problem: ImageShapeProblem }[];
  emptyBoxes: { id: string; boxH: number; inkH: number; share: number }[];
  deadBands: Band[];
}

/** Slivers, oversize text boxes and dead bands (server: layoutValidate.pageQuality).
 *  Furniture is chrome and is left out of every measure. */
function pageQuality(ctx: PageCtx): PageQuality {
  const page = ctx.page;
  const pageArea = Math.max(1, page.width * page.height);
  const els = ctx.elements.filter((e) => !isFurniture(e));
  const slivers: PageQuality['slivers'] = [];
  const emptyBoxes: PageQuality['emptyBoxes'] = [];
  const ink: { y: number; h: number }[] = [];
  for (const el of els) {
    if (el.type === 'text') {
      const t = textInk(el, ctx);
      if (!t) continue;
      ink.push(t);
      const share = ((el.h - t.h) * el.w) / pageArea;
      if (t.h < el.h * SLACK_AT && share >= SLACK_SERIOUS_SHARE) emptyBoxes.push({ id: el.id, boxH: el.h, inkH: Math.round(t.h), share });
      continue;
    }
    if (el.type === 'image') {
      // Backing photo: words sit on it, so its shape is the shape of what it backs.
      const backing = els.some((o) => o.type === 'text' && o.zIndex > el.zIndex && coverage(o, el) >= 0.5);
      if (!backing) {
        const problem = imageShapeProblem(el, page);
        if (problem) slivers.push({ id: el.id, problem });
      }
      const hidden = els.some(
        (o) => o.type === 'shape' && o.zIndex > el.zIndex && coverage(el, o) >= 0.9 && (o.shape?.opacity ?? 1) >= HIDING_OPACITY,
      );
      if (!hidden) ink.push(el);
      continue;
    }
    if (el.type === 'shape') {
      // A sheet-sized shape is the page's ground, and a scrim is its photo's tint; a rule,
      // a bar or a card is ink.
      if ((el.w * el.h) / pageArea >= 0.5 || isScrimEl(el, els)) continue;
      ink.push(el);
      continue;
    }
    ink.push(el); // qr / icon
  }
  return { slivers, emptyBoxes, deadBands: deadBands(ink, page.height) };
}

/** The quality advisories (slivers, oversize boxes, dead bands), with a numbered fix each. */
function adviseQuality(ctx: PageCtx): Built[] {
  const out: Built[] = [];
  const q = pageQuality(ctx);
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
 * The numbers the rules read, made finite. A page in the middle of an edit can hold a
 * half-merged patch; one NaN must not turn every comparison false and wave a broken
 * page through as "no problems". Elements that are already sound are returned as is.
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
      fontWeight: (num(t.fontWeight, 400) || 400) as ElementTextWeight,
    };
  }
  return out;
}

function allIssues(input: MagazineElement[], page: PageWithGround, measured: Map<string, ElementMeasurement>, fit: Fitter): Built[] {
  const elements = input.filter((el) => el && typeof el === 'object').map(sane);
  const ctx = makeCtx(elements, page, measured, fit);
  const nb: Neighbours = { elements, page };
  const out: Built[] = [];
  const empty = pageEmptyIssue(ctx);
  if (empty) out.push(empty);
  for (const el of elements) out.push(...elementIssues(el, page, ctx.geom.get(el) ?? null, fit, nb));
  out.push(...hiddenIssues(ctx));
  out.push(...overlapIssues(ctx));
  out.push(...contrastIssues(ctx));
  out.push(...sizeMismatchIssues(ctx));
  out.push(...looseGapIssues(ctx));
  // An empty page is one big dead band; saying so twice helps nobody.
  out.push(...adviseQuality(ctx).filter((b) => !(empty && b.issue.kind === 'dead-band')));
  out.push(...brokenImageIssues(ctx, measured));
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
 * The rules fed with what a browser drew: clipping, edges, spills and overlaps from
 * the measured text blocks (real fonts, real wrapping), broken pictures from the
 * images that failed to load; everything else from the element data. A text element
 * with no measurement is not judged for fit. Ordered and capped at MAX_ISSUES.
 */
export function issuesFromMeasurements(
  m: ElementMeasurement[],
  elements: MagazineElement[],
  page: { width: number; height: number; background?: { type: string; value: string } },
  opts: RuleOptions = {},
): PageCheckIssue[] {
  const byId = new Map<string, ElementMeasurement>();
  for (const x of m ?? []) if (x && typeof x.id === 'string' && !byId.has(x.id)) byId.set(x.id, x);
  return ordered(allIssues(elements ?? [], page, byId, makeFitter(opts.probe))).slice(0, MAX_ISSUES);
}

/** A whole PageCheck from browser measurements (issuesFromMeasurements + summary).
 *  `measuredBy` defaults to 'browser' — this twin's caller is the editor. */
export function checkPageFromMeasurements(
  m: ElementMeasurement[],
  elements: MagazineElement[],
  page: { width: number; height: number; background?: { type: string; value: string } },
  opts: RuleOptions & { pageNumber?: number; measuredBy?: 'chromium' | 'browser' } = {},
): PageCheck {
  return finish(issuesFromMeasurements(m, elements, page, opts), opts.measuredBy ?? 'browser', opts.pageNumber);
}

// ── Comparing and summarising ────────────────────────────────────────────────

function issueKey(i: PageCheckIssue): string {
  // An overlap is the same overlap whichever of the pair is named first.
  const ids = i.kind === 'text-overlap' ? [i.elementId ?? '', i.otherId ?? ''].sort() : [i.elementId ?? '', i.otherId ?? ''];
  return `${i.kind}|${ids.join('|')}`;
}

/**
 * The errors in `after` that were not in `before` — what a change BROKE, not what was
 * already wrong. The same error on the same element counts as new only when it got
 * clearly worse (its overflow grew by half again and by more than 8px).
 */
export function newErrors(before: PageCheck, after: PageCheck): PageCheckIssue[] {
  const was = new Map<string, PageCheckIssue>();
  for (const i of before?.issues ?? []) if (i.severity === 'error') was.set(issueKey(i), i);
  return (after?.issues ?? []).filter((i) => {
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
