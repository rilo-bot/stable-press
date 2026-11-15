// ---------------------------------------------------------------------------
// Magazine Builder v2 — the PURE rules behind the Studio agent's "add" tools.
//
// agentTools/addTools.ts reaches the database, storage, the chart renderer and the
// image model, so nothing in it can be unit-tested. Every decision it makes that
// needs no I/O lives here instead, where it is tested
// (tests/magazineV2/agentAddPure.test.ts):
//
//   LAYER    where a new element sits in the stack. It used to be zIndex 0 — under
//            every photo, scrim and panel of a generated page — so the AI's caption,
//            photo or chart came out hidden or dimmed while the reply said "added"
//            (audit C07/C38/C51). Pictures, text, QR codes and charts now go on top.
//            A new SHAPE goes above the pictures it overlaps and below the text it
//            overlaps, because a scrim or a panel exists to sit BEHIND words: at the
//            top of the stack it would dim the very headline it was meant to rescue.
//   TYPE     the page's own typography for a new text box's role (C55). It used to
//            arrive at 40px in the app's UI font ('inherit'), measured as one face and
//            drawn as another.
//   FIT      how a picture fills its box. A chart, logo or poster must show whole
//            ('contain', in a box of its own shape); a photograph fills ('cover').
//            'cover' on a chart cut off its axis labels and legend (C08/C39/C52).
//   CHARTS   where a chart goes, and the line the user reads before applying it —
//            with the numbers in it, because that line is the only way anyone
//            reviewing the tray (or The Stable Hand) can check the data (C16).
//   LIBRARY  what list_media shows: this page's own pictures, then the newest, each
//            saying what it is, so "the logo I uploaded" can be found (C43).
//   TIME     whether a slow call (a render, the image model) still fits in the turn.
//
// No db, no storage, no network, no clock (the time helpers take `now`).
// ---------------------------------------------------------------------------

import { TEXT_ROLES, type ElementImageFit, type ElementTextAlign, type ElementTextData, type MagazineElement, type TextRole } from './model.js';
import { ROLE_SCALE } from './roleScale.js';
import { contrastRatio, measureElementText, readableColor } from './layout.js';
import { chartSlot, formatChartValue, preferredChartAspect, topZ, type ChartSpec } from './chartSpec.js';
import { checkElement, elementLabel, freeSpaceBelow, HIDDEN_COVER } from './pageCheck.js';
import { FURNITURE_IDS } from './pageFurniture.js';
import { mediaOrigin, rankMediaForPage, type RankableMediaRow } from './media.js';
import { nearestAspectRatio } from './imageBytes.js';
import type { ImageStyle } from './imagePrompt.js';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
type PageDims = { width: number; height: number };
type PageGround = PageDims & { background?: { type: string; value: string } };

const HEX = /^#[0-9a-fA-F]{6}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const hexOf = (v: unknown): string | undefined => (typeof v === 'string' && HEX.test(v.trim()) ? v.trim().toLowerCase() : undefined);
const plain = (html: string): string => String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
const areaOf = (b: Box): number => Math.max(0, b.w) * Math.max(0, b.h);

// ── Geometry ─────────────────────────────────────────────────────────────────

/**
 * A box kept wholly on the page, by the same rule the write pipeline applies
 * (model.validateElements): size clamped to the page, then the ORIGIN pulled back so
 * the far edge stays inside. Done here as well because a chart or a generated picture
 * is MADE for its box — drawn at the box's own shape — before the element is
 * validated, and a box the validator later moved or shrank would no longer match the
 * picture made for it.
 */
export function clampBoxToPage(box: Box, page: PageDims, min = 2): Box {
  const W = Math.max(1, Math.round(page.width));
  const H = Math.max(1, Math.round(page.height));
  const fin = (v: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const w = Math.min(W, Math.max(min, Math.round(fin(box.w, Math.min(200, W)))));
  const h = Math.min(H, Math.max(min, Math.round(fin(box.h, Math.min(80, H)))));
  const x = Math.round(Math.min(Math.max(0, fin(box.x, 0)), W - w));
  const y = Math.round(Math.min(Math.max(0, fin(box.y, 0)), H - h));
  return { x, y, w, h };
}

/**
 * The largest box of `aspect` (width / height) inside `box`, centred in it. A picture
 * placed with fit 'contain' in a box of its OWN shape shows whole with no empty bands,
 * and the element's outline is the picture's — so a later page check measures what is
 * really drawn rather than a frame around it.
 */
export function fitBoxToAspect(box: Box, aspect: number | undefined): Box {
  if (!aspect || !Number.isFinite(aspect) || aspect <= 0) return { ...box };
  let w = box.w;
  let h = box.w / aspect;
  if (h > box.h) {
    h = box.h;
    w = h * aspect;
  }
  w = Math.max(1, Math.floor(w));
  h = Math.max(1, Math.floor(h));
  return { x: Math.round(box.x + Math.floor((box.w - w) / 2)), y: Math.round(box.y + Math.floor((box.h - h) / 2)), w, h };
}

/** '16:9' → 1.777…; undefined for anything that is not a ratio. */
export function ratioValue(ratio: string): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)\s*$/i.exec(String(ratio ?? ''));
  if (!m) return undefined;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a > 0 && b > 0 ? a / b : undefined;
}

// ── Layer (zIndex) ───────────────────────────────────────────────────────────

/** The highest zIndex the page keeps (model.validateElements clamps to 0–9999). */
export const MAX_Z = 9999;

/**
 * zIndex for a new picture, chart, text box or QR code: above everything on the page —
 * the same rule as the editor's own Add buttons (web addDefaults.zForNew). Computed
 * from the WORKING copy, so several adds in one turn stack in the order they were made.
 */
export function frontZ(elements: ReadonlyArray<Pick<MagazineElement, 'zIndex'>>): number {
  return Math.min(MAX_Z, topZ(elements) + 1);
}

/** Content a shape must never cover: words, QR codes and icons. Pictures and other
 *  shapes are what a shape may sit on. */
const isContent = (e: MagazineElement) => e.type === 'text' || e.type === 'qr' || e.type === 'icon';

/** Content already hidden under a picture drawn above it stays hidden: lifting it out
 *  from under a shape would bring back something the page hides on purpose. */
function hiddenUnderPicture(c: MagazineElement, elements: ReadonlyArray<MagazineElement>): boolean {
  const a = areaOf(c);
  if (a <= 0) return false;
  return elements.some(
    (o) => o.id !== c.id && o.type === 'image' && !!o.image?.url && o.zIndex > c.zIndex && overlapArea(o, c) >= a * HIDDEN_COVER,
  );
}

/**
 * Raise `items` so each sits at `minZ` or above, keeping their order: elements on one
 * level stay on one level, a higher level stays strictly higher. Only the elements
 * that actually move are returned.
 */
function liftAbove(items: ReadonlyArray<Pick<MagazineElement, 'id' | 'zIndex'>>, minZ: number): { id: string; zIndex: number }[] {
  const sorted = [...items].sort((a, b) => a.zIndex - b.zIndex);
  const out: { id: string; zIndex: number }[] = [];
  let prevOld = Number.NEGATIVE_INFINITY;
  let prevNew = Number.NEGATIVE_INFINITY;
  for (const it of sorted) {
    const next = prevNew === Number.NEGATIVE_INFINITY ? minZ : prevNew + (it.zIndex > prevOld ? 1 : 0);
    const z = Math.min(MAX_Z, Math.max(it.zIndex, minZ, next));
    if (z !== it.zIndex) out.push({ id: it.id, zIndex: z });
    prevOld = it.zIndex;
    prevNew = z;
  }
  return out;
}

/** A layer for a new shape, plus any existing elements that must move up to stay in
 *  front of it. */
export interface ShapeLayer {
  zIndex: number;
  /** Existing elements to raise (staged as zIndex updates), so nothing that was
   *  readable is covered by the new shape. */
  lift: { id: string; zIndex: number }[];
  /** front: on top of everything. behind-text: above the pictures it overlaps and
   *  below the words. background: a full-page ground, under everything. */
  mode: 'front' | 'behind-text' | 'background';
}

/** At most this many elements are restacked to slide a full-page shape behind them. */
export const MAX_BACKGROUND_LIFTS = 40;

/**
 * Where a new SHAPE goes.
 *
 * A shape the Studio adds is nearly always a scrim over a photo, a panel behind a
 * caption, or a rule: something that belongs ABOVE the pictures it overlaps and BELOW
 * the words. At the top of the stack (where pictures and text go) a 50% scrim would
 * dim the headline it was added to rescue, and a solid panel would hide the caption it
 * frames — so:
 *
 *   • it overlaps no words → on top (frontZ);
 *   • otherwise → one above the highest picture or shape it overlaps; and when that
 *     rung is already taken by the words themselves (a copied PDF page keeps photos at
 *     0 and text at 1), the words it overlaps are raised to stay in front (`lift`);
 *   • an OPAQUE shape covering most of the sheet is a page background: it goes under
 *     everything, and whatever sits on the bottom rungs is raised to make room.
 *
 * `layer: 'front'` overrides all of this — for a shape meant to cover what is there.
 */
export function layerForShape(
  elements: ReadonlyArray<MagazineElement>,
  box: Box,
  opts: { page: PageDims; opacity?: number; layer?: 'front' | 'behind-text' },
): ShapeLayer {
  if (opts.layer === 'front') return { zIndex: frontZ(elements), lift: [], mode: 'front' };
  const opaque = (opts.opacity ?? 1) >= 0.9;
  const sheet = Math.max(1, opts.page.width * opts.page.height);
  if (opaque && areaOf(box) >= sheet * 0.85 && elements.length > 0) {
    return { zIndex: 0, lift: liftAbove(elements, 1), mode: 'background' };
  }
  const over = elements.filter((e) => overlapArea(e, box) > 0);
  const content = over.filter((e) => isContent(e) && !hiddenUnderPicture(e, elements));
  if (!content.length) return { zIndex: frontZ(elements), lift: [], mode: 'front' };
  const floor = over.filter((e) => !isContent(e)).reduce((m, e) => Math.max(m, e.zIndex), -1);
  const zIndex = Math.min(MAX_Z, floor + 1);
  return { zIndex, lift: liftAbove(content, zIndex + 1), mode: 'behind-text' };
}

// ── Typography for a new text box ────────────────────────────────────────────

/** What each element role is typeset like in the type scale (roleScale.ts). A role the
 *  scale does not know ('other') is set as body copy. */
const SCALE_KEY: Record<TextRole, keyof typeof ROLE_SCALE> = {
  headline: 'headline',
  subhead: 'subhead',
  byline: 'byline',
  body: 'body',
  caption: 'caption',
  pullquote: 'pullquote',
  other: 'body',
};

/** The face the editor's own Add button falls back to (web MagazineEditorV2): never
 *  'inherit', which draws in the app's UI font instead of the magazine's. */
export const FALLBACK_TEXT_FONT = 'Georgia, serif';

export function isTextRole(v: unknown): v is TextRole {
  return typeof v === 'string' && (TEXT_ROLES as readonly string[]).includes(v);
}

/** A font stack worth copying: present, and not a CSS keyword that means "whatever
 *  the app around the page uses". */
function usableFamily(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s || s.length > 160) return undefined;
  const first = s.split(',')[0]!.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
  if (!first || first === 'inherit' || first === 'initial' || first === 'unset') return undefined;
  return s;
}

/** Values tallied by weight, heaviest first; ties broken by the value itself so the
 *  answer never depends on element order. */
function heaviest(tally: Map<string, number>): string | undefined {
  return [...tally.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0]?.[0];
}

function pageTexts(elements: ReadonlyArray<MagazineElement>): MagazineElement[] {
  // The running head and folio are furniture, set in their own small style; a caption
  // must not be typeset like a page number.
  return elements.filter((e) => e.type === 'text' && !!e.text && !FURNITURE_IDS.includes(e.id));
}

function dominantFamily(texts: MagazineElement[], role?: TextRole): string | undefined {
  const tally = new Map<string, number>();
  for (const t of texts) {
    if (role && t.text!.role !== role) continue;
    const f = usableFamily(t.text!.fontFamily);
    if (f) tally.set(f, (tally.get(f) ?? 0) + 1);
  }
  return heaviest(tally);
}

function displayFamily(texts: MagazineElement[]): string | undefined {
  const head = [...texts]
    .filter((t) => usableFamily(t.text!.fontFamily))
    .sort((a, b) => (b.text!.role === 'headline' ? 1 : 0) - (a.text!.role === 'headline' ? 1 : 0) || b.text!.fontSize - a.text!.fontSize)[0];
  return head ? usableFamily(head.text!.fontFamily) : undefined;
}

function dominantInk(texts: MagazineElement[]): string | undefined {
  const tally = new Map<string, number>();
  for (const t of texts) {
    const c = hexOf(t.text!.color);
    if (c) tally.set(c, (tally.get(c) ?? 0) + Math.max(1, plain(t.text!.content).length));
  }
  return heaviest(tally);
}

/** The text style a new box of a role is set in. */
export interface RoleTextStyle {
  role: TextRole;
  fontFamily: string;
  fontWeight: ElementTextData['fontWeight'];
  color: string;
  lineHeight: number;
  align: ElementTextAlign;
  /** The ceiling refit shrinks from (a new box is set at this size and shrunk to fit). */
  maxFontSize: number;
  /** The floor refit may not shrink below. */
  minFontSize: number;
  letterSpacing?: number;
  textTransform?: ElementTextData['textTransform'];
  /** 'page': copied from this page's own text of that role. 'scale': the role's default
   *  sizes from the type scale, in the issue's (or the page's) faces and ink. */
  from: 'page' | 'scale';
}

/**
 * The page's own typography for a new text box of `role` (C55).
 *
 *   1. This page's text of that role carrying the MOST copy — the main paragraph, not a
 *      one-word label that happens to share the role (the editor's Add button uses the
 *      same rule, web addDefaults.pageTextStyle): its face, weight, ink, leading,
 *      alignment, tracking and case, and its ceiling and floor.
 *   2. Otherwise the role's sizes from the type scale (roleScale.ts), in the issue's
 *      fonts and ink (genTheme), else the faces and ink this page already uses, else
 *      Georgia on near-black. Never 'inherit'.
 */
export function styleForRole(elements: ReadonlyArray<MagazineElement>, role: TextRole = 'body', theme?: unknown): RoleTextStyle {
  const texts = pageTexts(elements);
  const scale = ROLE_SCALE[SCALE_KEY[role] ?? 'body'] ?? ROLE_SCALE.body!;

  let best: MagazineElement | undefined;
  let bestLen = -1;
  for (const e of texts) {
    if (e.text!.role !== role || !usableFamily(e.text!.fontFamily) || !(e.text!.fontSize > 0)) continue;
    const len = plain(e.text!.content).length;
    if (len > bestLen) {
      best = e;
      bestLen = len;
    }
  }
  if (best) {
    const t = best.text!;
    // The ceiling the page set this role at, not the size one box happened to be
    // shrunk to; text copied from a PDF has no ceiling, so its own size is the one.
    const ceiling = Math.max(typeof t.maxFontSize === 'number' ? t.maxFontSize : 0, t.fontSize);
    const floor = Math.min(ceiling, typeof t.minFontSize === 'number' ? t.minFontSize : Math.min(scale.minFontSize, ceiling));
    return {
      role,
      fontFamily: usableFamily(t.fontFamily)!,
      fontWeight: t.fontWeight,
      color: hexOf(t.color) ?? '#111111',
      lineHeight: t.lineHeight,
      align: t.align,
      maxFontSize: Math.round(ceiling),
      minFontSize: Math.max(6, Math.round(floor)),
      ...(t.letterSpacing ? { letterSpacing: t.letterSpacing } : {}),
      ...(t.textTransform && t.textTransform !== 'none' ? { textTransform: t.textTransform } : {}),
      from: 'page',
    };
  }

  const gt = isObj(theme) ? theme : {};
  const fonts = isObj(gt.fonts) ? gt.fonts : {};
  const palette = isObj(gt.palette) ? gt.palette : {};
  const display = scale.fontRef === 'display';
  const fontFamily =
    usableFamily(display ? fonts.display : fonts.body) ??
    (display ? displayFamily(texts) : dominantFamily(texts, 'body') ?? dominantFamily(texts)) ??
    FALLBACK_TEXT_FONT;
  const color = hexOf(palette[scale.colorRef]) ?? hexOf(palette.text) ?? dominantInk(texts) ?? '#111111';
  return {
    role,
    fontFamily,
    fontWeight: scale.fontWeight,
    color,
    lineHeight: scale.lineHeight,
    align: scale.align,
    maxFontSize: scale.maxFontSize,
    minFontSize: scale.minFontSize,
    from: 'scale',
  };
}

/**
 * The flat colour a new box would stand on: the topmost opaque shape covering most of
 * it, else the page's own colour. Null when that cannot be known from the data — a
 * photo, a see-through scrim, a page whose ground is an image — so nobody pretends to
 * have checked contrast against it.
 */
export function groundColorUnder(elements: ReadonlyArray<MagazineElement>, box: Box, page: PageGround): string | null {
  const a = areaOf(box);
  const under = elements
    .filter((e) => (e.type === 'shape' || e.type === 'image') && a > 0 && overlapArea(e, box) >= a * 0.6)
    .sort((p, q) => q.zIndex - p.zIndex)[0];
  if (under) {
    if (under.type === 'shape' && (under.shape?.opacity ?? 1) >= 0.9) return hexOf(under.shape?.fill) ?? null;
    return null;
  }
  if (page.background?.type === 'color') return hexOf(page.background.value) ?? null;
  return null;
}

/** `color`, or the plain light/dark ink that reads on `ground` when it does not. */
export function readableOn(color: string, ground: string | null): string {
  if (!ground) return color;
  return readableColor(color, ground, '#ffffff', '#111111');
}

/** Contrast of `color` on `ground`, for a tool result (null when the ground is unknown). */
export function contrastOn(color: string, ground: string | null): number | null {
  return ground && HEX.test(color) ? Math.round(contrastRatio(color, ground) * 10) / 10 : null;
}

/**
 * Make room for text that does not fit by GROWING its box down into free space, when
 * there is enough. Nothing is moved: the room is what freeSpaceBelow finds between the
 * box and the next thing in its column (or the foot of the page). A box whose copy is
 * too WIDE (one word longer than the box) is left alone — more height cannot help it.
 */
export function growTextToFit(
  el: MagazineElement,
  elements: ReadonlyArray<MagazineElement>,
  page: PageDims,
): { el: MagazineElement; grewBy: number; needPx?: number; freePx?: number } {
  const m = measureElementText(el);
  if (!m || m.fits) return { el, grewBy: 0 };
  const need = Math.ceil(m.needPx) + 2;
  const free = freeSpaceBelow(el, elements as MagazineElement[], page);
  if (need <= el.h) return { el, grewBy: 0, needPx: need, freePx: free };
  const taller = measureElementText(el, { height: need });
  if (!taller?.fits || need - el.h > free) return { el, grewBy: 0, needPx: need, freePx: free };
  return { el: { ...el, h: need }, grewBy: need - el.h, needPx: need, freePx: free };
}

// ── What a tool reports back ─────────────────────────────────────────────────

/** Whether a new or changed element works where it is: the "fit" every add and edit
 *  returns, with the page check's own numbers and fixes. */
export interface FitReport {
  fits: boolean;
  needPx?: number;
  havePx?: number;
  fitsAtPx?: number;
  /** What is wrong and what fixes it, in the page check's words (at most 3). */
  problems?: string[];
}

export function fitReport(el: MagazineElement, page: PageDims): FitReport {
  const c = checkElement(el, page);
  const out: FitReport = { fits: c.fits };
  if (c.needPx !== undefined) out.needPx = c.needPx;
  if (c.havePx !== undefined) out.havePx = c.havePx;
  if (c.fitsAtPx !== undefined) out.fitsAtPx = c.fitsAtPx;
  const problems = c.issues.slice(0, 3).map((i) => (i.fix ? `${i.detail} Fix: ${i.fix}` : i.detail));
  if (problems.length) out.problems = problems;
  return out;
}

/** Does this element draw anything (worth warning about covering)? */
function draws(e: MagazineElement): boolean {
  if (e.type === 'text') return plain(e.text?.content ?? '').length > 0;
  if (e.type === 'image') return !!e.image?.url;
  if (e.type === 'shape') return false;
  return true;
}

/**
 * What a new element placed ON TOP at `box` would hide: words, pictures, QR codes and
 * icons at least a quarter covered. A sheet-sized picture is the page's ground, not
 * something to warn about, and shapes are panels and scrims. `ignoreIds`: the element
 * being replaced.
 */
export function coveredBy(elements: ReadonlyArray<MagazineElement>, box: Box, page: PageDims, ignoreIds: string[] = []): MagazineElement[] {
  const sheet = Math.max(1, page.width * page.height);
  const skip = new Set(ignoreIds);
  return elements.filter((e) => {
    if (skip.has(e.id) || !draws(e)) return false;
    const a = areaOf(e);
    if (a <= 0 || (e.type === 'image' && a >= sheet * 0.5)) return false;
    return overlapArea(e, box) >= a * 0.25;
  });
}

/** A warning a tool result carries when the new element hides something. */
export function coverWarning(covered: ReadonlyArray<MagazineElement>): string | undefined {
  if (!covered.length) return undefined;
  const names = covered.slice(0, 3).map((e) => `${elementLabel(e)} (#${e.id})`).join(', ');
  const more = covered.length > 3 ? ` and ${covered.length - 3} more` : '';
  return `It is on top of ${names}${more}, which it now hides. Unless that was the point, move or resize it (move_element) or choose a free spot.`;
}

// ── Pictures from the library ────────────────────────────────────────────────

/** A media row as the library stores it, with the fields the add tools read. */
export interface MediaRowInfo extends RankableMediaRow {
  originalName?: string;
  width?: unknown;
  height?: unknown;
  imageStyle?: string;
  chartBox?: { w?: unknown; h?: unknown };
}

/** Words in an upload's name or alt that mean it is a designed picture, not a photo. */
const GRAPHIC_WORDS =
  /\b(charts?|graphs?|logos?|diagrams?|infographics?|screenshots?|tables?|maps?|posters?|flyers?|brochures?|certificates?|scans?|scanned|menus?|timetables?|badges?|crests?|emblems?|icons?|illustrations?|drawings?|artwork|wordmark|sponsors?)\b/;

/**
 * Is this library picture a DESIGNED one — a chart, logo, poster, illustration — that
 * must show whole? By kind first (a 'graphic' row, a drawn chart, an AI illustration);
 * an upload says nothing about what it shows, so its name and alt are read for the
 * words people use ("client-logo.png", "results table").
 */
export function isGraphicMedia(row: Pick<MediaRowInfo, 'kind' | 'source' | 'alt' | 'originalName' | 'imageStyle'> | null | undefined): boolean {
  if (!row) return false;
  if (row.kind === 'graphic' || row.source === 'chart') return true;
  if (row.source === 'ai-image' && typeof row.imageStyle === 'string' && row.imageStyle !== 'photo') return true;
  if (row.kind === 'upload') {
    const words = `${row.alt ?? ''} ${row.originalName ?? ''}`.toLowerCase().replace(/[_\-.]+/g, ' ');
    return GRAPHIC_WORDS.test(words);
  }
  return false;
}

/** The picture's own shape (width / height), when the row records its size. */
export function mediaAspect(row: Pick<MediaRowInfo, 'width' | 'height' | 'chartBox'> | null | undefined): number | undefined {
  if (!row) return undefined;
  const w = Number(row.width);
  const h = Number(row.height);
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return w / h;
  const cw = Number(row.chartBox?.w);
  const ch = Number(row.chartBox?.h);
  return Number.isFinite(cw) && Number.isFinite(ch) && cw > 0 && ch > 0 ? cw / ch : undefined;
}

/** How a library picture fills its box: what the model asked for, else 'contain' for a
 *  designed picture and 'cover' for a photograph. */
export function placementFit(row: Parameters<typeof isGraphicMedia>[0], asked?: ElementImageFit): ElementImageFit {
  if (asked === 'cover' || asked === 'contain') return asked;
  return isGraphicMedia(row) ? 'contain' : 'cover';
}

/**
 * The box a library picture is placed in: the one asked for, kept on the page — and,
 * for a picture shown whole whose size is known, shrunk to the picture's own shape
 * inside it, so 'contain' leaves no empty bands and nothing is cropped.
 */
export function placementBox(box: Box, page: PageDims, fit: ElementImageFit, aspect: number | undefined): Box {
  const onPage = clampBoxToPage(box, page);
  return fit === 'contain' && aspect ? fitBoxToAspect(onPage, aspect) : onPage;
}

/** What list_media shows for one picture. */
export interface MediaListItem {
  assetId: string;
  url: string;
  alt: string;
  kind: string;
  /** Where it came from, in words ("uploaded by the user", "a chart drawn from data"). */
  from?: string;
  /** Pixel size, when the row records it ("1600x900"). */
  size?: string;
  /** The date it was added (YYYY-MM-DD). */
  added?: string;
  /** How it should fill a box: 'contain' for a designed picture, 'cover' for a photo. */
  fit: ElementImageFit;
  /** A chart drawn from data: update_chart can change its numbers. */
  chart?: true;
}

export const MEDIA_LIST_LIMIT = 40;

const words = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The library as list_media shows it (C43): placeable pictures only, this page's own
 * first and then the NEWEST (media.rankMediaForPage) — it used to be the 40 OLDEST, so a
 * logo uploaded today never appeared in a big magazine. `query` keeps the pictures whose
 * alt, file name, origin or kind contain every word of it ("logo", "chart", "page 2").
 */
export function listMediaView<T extends MediaRowInfo>(
  rows: T[],
  pageIndex: number,
  opts: { query?: string; limit?: number } = {},
): { assets: MediaListItem[]; total: number; matched: number } {
  const ranked = rankMediaForPage(rows, pageIndex);
  const tokens = words(opts.query ?? '').split(' ').filter(Boolean);
  const matches = tokens.length
    ? ranked.filter((m) => {
        const hay = words([m.alt, m.originalName, m.docName, m.kind, m.source, m.imageStyle, mediaOrigin(m)].filter(Boolean).join(' '));
        return tokens.every((t) => hay.includes(t) || (t.length > 3 && t.endsWith('s') && hay.includes(t.slice(0, -1))));
      })
    : ranked;
  const limit = Math.max(1, Math.min(200, opts.limit ?? MEDIA_LIST_LIMIT));
  const assets = matches.slice(0, limit).map((m): MediaListItem => {
    const w = Number(m.width);
    const h = Number(m.height);
    const from = mediaOrigin(m);
    const added = typeof m.createdAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(m.createdAt) ? m.createdAt.slice(0, 10) : undefined;
    return {
      assetId: String(m._id),
      url: String(m.url),
      alt: m.alt ?? '',
      kind: m.kind ?? '',
      ...(from ? { from } : {}),
      ...(Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { size: `${Math.round(w)}x${Math.round(h)}` } : {}),
      ...(added ? { added } : {}),
      fit: placementFit(m),
      ...(m.source === 'chart' ? { chart: true as const } : {}),
    };
  });
  return { assets, total: ranked.length, matched: matches.length };
}

// ── Charts ───────────────────────────────────────────────────────────────────

const CHART_NOUN: Record<ChartSpec['type'], string> = {
  bar: 'bar chart',
  barh: 'horizontal bar chart',
  line: 'line chart',
  pie: 'pie chart',
  donut: 'donut chart',
  table: 'table',
};

/** "a bar chart “Wins by season”" — the chart as a reviewer reads it. */
export function chartLabel(spec: ChartSpec): string {
  const noun = spec.stacked ? `stacked ${CHART_NOUN[spec.type]}` : CHART_NOUN[spec.type];
  return `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}${spec.title ? ` “${spec.title}”` : ''}`;
}

/**
 * The numbers, short enough for a review line: "2022 12 · 2023 18 · 2024 25". The
 * proposal summary is what a person approving the change (and The Stable Hand, which
 * cannot see pixels) reads, so it carries the data, not just "added a chart". The full
 * list is dataEcho, returned to the model separately.
 */
export function chartValuesLine(spec: ChartSpec, max = 8): string {
  const line = chartValuesLineFull(spec, max);
  // Bounded, because the line goes into a proposal summary that makes a round trip
  // through the client (studioRequests.MAX_SUMMARY_CHARS): long owner names on a barh
  // could otherwise outgrow it, and a cut summary reads as a different change.
  return line.length > CHART_VALUES_MAX_CHARS ? `${line.slice(0, CHART_VALUES_MAX_CHARS - 1).trimEnd()}…` : line;
}

/** Characters the values line of a chart summary may use (see chartValuesLine). */
export const CHART_VALUES_MAX_CHARS = 500;

function chartValuesLineFull(spec: ChartSpec, max: number): string {
  const parts = (s: ChartSpec['series'][number]) => spec.categories.map((c, i) => `${c} ${formatChartValue(s.values[i]!, spec)}`);
  const total = spec.categories.length * spec.series.length;
  if (spec.series.length === 1) {
    const p = parts(spec.series[0]!);
    return p.length > max ? `${p.slice(0, max).join(' · ')} · … (${p.length} values)` : p.join(' · ');
  }
  let budget = Math.max(1, max);
  const segs: string[] = [];
  let shown = 0;
  for (const s of spec.series) {
    if (budget <= 0) break;
    const p = parts(s);
    const take = p.slice(0, budget);
    segs.push(`${s.name}: ${take.join(' · ')}`);
    shown += take.length;
    budget -= take.length;
  }
  return shown < total ? `${segs.join('; ')} … (${total} values)` : segs.join('; ');
}

/** Where add_chart puts the chart. */
export type ChartPlacement =
  /** a new image element at `box` */
  | { ok: true; mode: 'add'; box: Box }
  /** into an existing image element (an empty picture box, or a picture it replaces) */
  | { ok: true; mode: 'fill'; target: MagazineElement; box: Box }
  /** in place of a non-picture element (deleted), on its layer */
  | { ok: true; mode: 'swap'; target: MagazineElement; box: Box }
  | { ok: false; error: string };

/** The smallest box a chart is drawn in: below this its labels cannot be read. */
export const MIN_CHART_BOX = { w: 160, h: 100 } as const;

export const NO_ROOM_FOR_CHART =
  'There is no free space on this page big enough for a readable chart. Give it a box (x, y, w, h) — for example in place of a photo the user is happy to lose — or pass replaceElementId to put it where an existing element is.';

/**
 * Where a chart goes, in this order: the element named by `replaceElementId`; the
 * box given (all four of x, y, w, h); else chartSlot — an empty picture box, then the
 * largest free space on the page in the chart's preferred shape.
 */
export function resolveChartPlacement(
  spec: ChartSpec,
  args: { x?: number; y?: number; w?: number; h?: number; replaceElementId?: string },
  elements: ReadonlyArray<MagazineElement>,
  page: PageDims,
): ChartPlacement {
  const tooSmall = (b: Box) => b.w < MIN_CHART_BOX.w || b.h < MIN_CHART_BOX.h;
  const small = `A chart needs a box of at least ${MIN_CHART_BOX.w} x ${MIN_CHART_BOX.h} px to be readable (400 x 260 or more is better).`;
  if (args.replaceElementId) {
    const target = elements.find((e) => e.id === args.replaceElementId);
    if (!target) return { ok: false, error: `No element #${args.replaceElementId} on this page.` };
    if (target.locked === true) return { ok: false, error: `Element #${target.id} is locked — ask the user to unlock it first.` };
    const box = clampBoxToPage(target, page);
    if (tooSmall(box)) return { ok: false, error: `Element #${target.id} is only ${box.w} x ${box.h} px. ${small}` };
    return { ok: true, mode: target.type === 'image' ? 'fill' : 'swap', target, box };
  }
  const given = [args.x, args.y, args.w, args.h].filter((v) => v !== undefined && v !== null);
  if (given.length === 4) {
    if (!given.every((v) => typeof v === 'number' && Number.isFinite(v))) return { ok: false, error: 'The chart box must be four numbers: x, y, w and h in page pixels.' };
    const box = clampBoxToPage({ x: args.x!, y: args.y!, w: args.w!, h: args.h! }, page);
    if (tooSmall(box)) return { ok: false, error: small };
    return { ok: true, mode: 'add', box };
  }
  if (given.length > 0) {
    return { ok: false, error: 'Give the chart’s whole box (x, y, w and h), or leave all four out to let it find a free spot on the page.' };
  }
  const slot = chartSlot(elements, page, preferredChartAspect(spec));
  if (!slot) return { ok: false, error: NO_ROOM_FOR_CHART };
  if (slot.emptySlotId) {
    const target = elements.find((e) => e.id === slot.emptySlotId);
    if (target && target.locked !== true) return { ok: true, mode: 'fill', target, box: clampBoxToPage(slot.box, page) };
  }
  return { ok: true, mode: 'add', box: clampBoxToPage(slot.box, page) };
}

// ── Generated pictures ───────────────────────────────────────────────────────

const STYLE_NOUN: Record<ImageStyle, string> = {
  photo: 'an image',
  illustration: 'an illustration',
  graphic: 'a graphic',
  poster: 'a poster',
};

/** "an illustration", "a poster" — what a proposal says was generated. */
export function imageStyleNoun(style: ImageStyle): string {
  return STYLE_NOUN[style] ?? STYLE_NOUN.photo;
}

/**
 * How a generated picture is framed. Every style is made at the supported aspect ratio
 * nearest the box (C40: three buckets lost up to half of a picture in a banner). A
 * photo or illustration then FILLS the box ('cover' trims only the small difference);
 * a poster or graphic can carry words near its edges, so it shows WHOLE ('contain') in
 * a box shrunk to the ratio it was made at.
 */
export function generatedImagePlacement(style: ImageStyle, box: Box): { box: Box; fit: ElementImageFit; aspectRatio: string } {
  const aspectRatio = nearestAspectRatio(box.w, box.h);
  const fit: ElementImageFit = style === 'poster' || style === 'graphic' ? 'contain' : 'cover';
  return { aspectRatio, fit, box: fit === 'contain' ? fitBoxToAspect(box, ratioValue(aspectRatio)) : { ...box } };
}

/**
 * The issue's look, for the image model: the Creative Director's one photographic style
 * (genTheme.concept.photoStyle — so a photo made in chat matches the found ones beside
 * it) and the palette's colours (for an illustration, graphic or poster).
 */
export function themeImageLook(theme: unknown): { photoStyle?: string; colors?: string[] } {
  const g = isObj(theme) ? theme : {};
  const concept = isObj(g.concept) ? g.concept : {};
  const palette = isObj(g.palette) ? g.palette : {};
  const photoStyle = typeof concept.photoStyle === 'string' && concept.photoStyle.trim() ? concept.photoStyle.trim().slice(0, 400) : undefined;
  const colors = ['primary', 'secondary', 'accent'].map((k) => hexOf(palette[k])).filter((c): c is string => !!c);
  return { ...(photoStyle ? { photoStyle } : {}), ...(colors.length ? { colors } : {}) };
}

/** A description cut for a one-line summary, never mid-character. */
export function briefLabel(text: string, max = 60): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(t);
  return chars.length > max ? `${chars.slice(0, max - 3).join('').trimEnd()}…` : t;
}

// ── Time ─────────────────────────────────────────────────────────────────────

/** Time a call needs left in the turn before it is started. The image model's own
 *  limit is 60 s but a typical picture takes 10–25 s; a chart waits up to 6 s for the
 *  render lane and 8 s to draw; a stock search and download takes a few seconds. */
export const IMAGE_TIME_NEEDED_MS = 25_000;
export const CHART_TIME_NEEDED_MS = 16_000;
export const STOCK_TIME_NEEDED_MS = 8_000;

/** Whether `neededMs` still fits before `deadline`. A turn without a deadline always has time. */
export function hasTimeFor(deadline: number | undefined, neededMs: number, now: number): boolean {
  if (typeof deadline !== 'number' || !Number.isFinite(deadline)) return true;
  return deadline - now >= neededMs;
}

/**
 * Pictures one Studio turn may ask the image model for. The Make-image box is limited
 * per person (10 a minute); the Studio was limited only by its turn rate, and the tool
 * calls of one model step run CONCURRENTLY — ten generate_image calls in one step all
 * passed the time check before any of them spent time. Three covers "a photo and two
 * illustrations"; more is a new message.
 */
export const MAX_IMAGES_PER_TURN = 3;

/**
 * Take one of the turn's image generations, or say why not. Call it synchronously,
 * with no `await` between it and the check before it: JavaScript runs one tool call at
 * a time between awaits, so the count cannot be raced by the calls running alongside.
 * A slot taken is not given back on failure — the bound is on what may be SPENT.
 */
export function takeImageSlot(ctx: { imagesMade?: number }): { ok: true } | { ok: false; reason: 'limit'; error: string } {
  const made = ctx.imagesMade ?? 0;
  if (made >= MAX_IMAGES_PER_TURN) {
    return {
      ok: false,
      reason: 'limit',
      error: `This turn has already asked for ${MAX_IMAGES_PER_TURN} new pictures, the most one message may make. Tell the user what was made and ask them to continue in a new message for the rest.`,
    };
  }
  ctx.imagesMade = made + 1;
  return { ok: true };
}

/** What a tool says when a slow call would not finish inside the turn. Starting it
 *  anyway ends the turn in "I ran into a hiccup" and leaves an orphaned picture. */
export function outOfTime(what: string): string {
  return `There is not enough time left in this turn to ${what}, so nothing was added. Tell the user and offer to do it in a new message.`;
}
