// ---------------------------------------------------------------------------
// Magazine Builder v2 — the pure half of the Studio tools that give the assistant
// EVERYTHING the Page & Element panel offers by hand.
//
// The client could set a picture to Contain in the panel, pick a font, justify a
// paragraph, recolour a QR code or change an icon — and the assistant could do none of
// it, so "set it to contain" was answered with an apology, and the client deleted the
// fake chart pictures it made instead (2026-11-15). The rule now: anything the manual
// panel can do, the assistant can do, through a tool that cannot break the page.
//
// This module decides; agentTools/panelTools.ts and editTools.ts do the staging:
//   • fonts — the curated families the panel offers (a mirror of the web registry,
//     apps/web/src/lib/fonts/registry.ts, checked against it by a test) or a family
//     the page already uses; never an invented name the renderers cannot draw;
//   • the page background — a colour, a library picture, or plain white;
//   • clearing a page — every unlocked element, the running head and folio optionally
//     kept, the background left alone (it is not an element);
//   • a picture's own size — so "make the box the image's ratio" is exact;
//   • arranging boxes — same size, same height, even spacing between a top and a
//     bottom, refused WITH NUMBERS when they cannot fit;
//   • duplicating, layering to front/back, QR colours and icon glyphs;
//   • the fields of a staged change the shared request parser does not know yet
//     (a background change, a group), so a change staged on one turn survives the next.
//
// Pure: no I/O, no DOM, no model.
// ---------------------------------------------------------------------------

import { parseColor, MIN_SIZE, type ElementTextTransform, type ElementVAlign, type MagazineElement } from './model.js';
import { FURNITURE_IDS } from './pageFurniture.js';
import { ICON_NAMES } from './icons.js';
import { contrastRatio, measureElementText } from './layout.js';
import { checkElement } from './pageCheck.js';
import { knownFontWeights } from './previewHtml.js';
import { readDropCapParagraphs } from './dropCapPara.js';
import { safePublicImageUrl } from './url.js';

type PageDims = { width: number; height: number };
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const r0 = (n: number) => Math.round(Number(n) || 0);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// ── Fonts ────────────────────────────────────────────────────────────────────

export interface CuratedFont {
  label: string;
  /** The CSS stack the panel stores — the same string, so the panel shows it selected. */
  stack: string;
}

/**
 * The font families the panel's picker offers, label and stack exactly as in
 * apps/web/src/lib/fonts/registry.ts (tests/magazineV2/agentPanelPure.test.ts reads
 * that file and fails on any drift). Storing the registry's own stack matters: the
 * picker matches an element back to its entry, the web loads exactly these faces, and
 * the server's metrics and the PDF proof know them.
 */
export const CURATED_FONTS: readonly CuratedFont[] = [
  { label: 'Playfair Display', stack: "'Playfair Display', Georgia, serif" },
  { label: 'IM Fell English', stack: "'IM Fell English', 'Palatino Linotype', serif" },
  { label: 'Lora', stack: "'Lora', Georgia, serif" },
  { label: 'Merriweather', stack: "'Merriweather', Georgia, serif" },
  { label: 'EB Garamond', stack: "'EB Garamond', Garamond, serif" },
  { label: 'Cormorant Garamond', stack: "'Cormorant Garamond', Garamond, serif" },
  { label: 'Libre Baskerville', stack: "'Libre Baskerville', Baskerville, serif" },
  { label: 'PT Serif', stack: "'PT Serif', Georgia, serif" },
  { label: 'DM Serif Display', stack: 'DM Serif Display, Georgia, serif' },
  { label: 'Georgia', stack: "Georgia, 'Times New Roman', serif" },
  { label: 'Source Sans 3', stack: "'Source Sans 3', system-ui, sans-serif" },
  { label: 'Inter', stack: "'Inter', system-ui, sans-serif" },
  { label: 'Montserrat', stack: "'Montserrat', system-ui, sans-serif" },
  { label: 'Poppins', stack: "'Poppins', system-ui, sans-serif" },
  { label: 'Work Sans', stack: "'Work Sans', system-ui, sans-serif" },
  { label: 'Oswald', stack: "'Oswald', 'Arial Narrow', sans-serif" },
  { label: 'Archivo', stack: "'Archivo', system-ui, sans-serif" },
  { label: 'Arial', stack: 'Arial, Helvetica, sans-serif' },
  { label: 'Dancing Script', stack: "'Dancing Script', cursive" },
  { label: 'Great Vibes', stack: "'Great Vibes', cursive" },
  { label: 'Pacifico', stack: "'Pacifico', cursive" },
  { label: 'Parisienne', stack: "'Parisienne', cursive" },
];

/** The first family of a CSS stack, unquoted and lower-cased — how the web's picker
 *  (registry.primaryFamily) and the server's metrics match a stack to a face. */
export function primaryFamily(stack: string): string {
  return (String(stack ?? '').split(',')[0] ?? '').trim().replace(/^['"]+|['"]+$/g, '').trim().toLowerCase();
}

export type FontChoice =
  | { ok: true; stack: string; label: string; from: 'curated' | 'page'; note?: string }
  | { ok: false; error: string };

/**
 * The stack to store for a font the model asked for — a label ("Lora"), a stack
 * ("'Lora', serif") or any spelling of one — matched by its first family:
 *   1. a curated family: the registry's own stack;
 *   2. a family this page (or the magazine's theme) already uses: that stack, so a
 *      copied PDF's own face can be put back on a box;
 *   3. anything else is refused with the list, because a name the renderers cannot
 *      load is drawn in a fallback face on screen and another one in the PDF.
 * `weight`, when given, adds a note if the family has no such weight.
 */
export function resolveFontFamily(asked: string, pageStacks: ReadonlyArray<string> = [], weight?: number): FontChoice {
  const want = primaryFamily(asked);
  if (!want) return { ok: false, error: 'Name a font family, e.g. "Lora" or "Montserrat".' };
  const curated = CURATED_FONTS.find((f) => primaryFamily(f.stack) === want || f.label.toLowerCase() === want);
  if (curated) {
    const note = weightNote(curated.stack, curated.label, weight);
    return { ok: true, stack: curated.stack, label: curated.label, from: 'curated', ...(note ? { note } : {}) };
  }
  const own = pageStacks.find((s) => typeof s === 'string' && primaryFamily(s) === want && want !== 'inherit');
  if (own) {
    const label = (own.split(',')[0] ?? '').trim().replace(/^['"]+|['"]+$/g, '');
    return { ok: true, stack: own, label, from: 'page' };
  }
  const onPage = [...new Set(pageStacks.map((s) => (s.split(',')[0] ?? '').trim().replace(/^['"]+|['"]+$/g, '')).filter((s) => s && s !== 'inherit'))];
  return {
    ok: false,
    error:
      `“${asked.slice(0, 60)}” is not one of the magazine's fonts. Use one of: ${CURATED_FONTS.map((f) => f.label).join(', ')}` +
      (onPage.length ? `; or a font already on this page: ${onPage.slice(0, 6).join(', ')}.` : '.'),
  };
}

/** A note when a family has no face at `weight` (the browser then fakes it or picks the
 *  nearest), or nothing. */
export function weightNote(stack: string, label: string, weight: number | undefined): string | undefined {
  if (!fin(weight)) return undefined;
  const have = knownFontWeights(stack);
  if (!have) return undefined;
  if (have.length === 0) return weight === 400 ? undefined : `${label} has a single weight, so ${weight} shows as its regular face.`;
  if (have.includes(weight)) return undefined;
  const nearest = have.reduce((a, b) => (Math.abs(b - weight) < Math.abs(a - weight) ? b : a), have[0]!);
  return `${label} has no ${weight} weight; it shows at ${nearest}.`;
}

/** The font stacks already in use on a page (text boxes with a real family). */
export function pageFontStacks(elements: ReadonlyArray<MagazineElement>, theme?: unknown): string[] {
  const out = new Set<string>();
  for (const e of elements) {
    const f = e.type === 'text' ? e.text?.fontFamily : undefined;
    if (typeof f === 'string' && f && f !== 'inherit') out.add(f);
  }
  const fonts = (theme && typeof theme === 'object' ? (theme as { fonts?: unknown }).fonts : undefined) as { display?: unknown; body?: unknown } | undefined;
  for (const f of [fonts?.display, fonts?.body]) if (typeof f === 'string' && f) out.add(f);
  return [...out];
}

// ── Text settings the panel has and the tools did not ────────────────────────

/** The panel's Vertical buttons say top / middle / bottom; the element stores 'center'. */
export function normalizeVAlign(v: unknown): ElementVAlign | undefined {
  if (v === 'top') return 'top';
  if (v === 'middle' || v === 'center') return 'center';
  if (v === 'bottom') return 'bottom';
  return undefined;
}

export const TEXT_TRANSFORMS: readonly ElementTextTransform[] = ['none', 'uppercase', 'lowercase', 'capitalize'];

// ── The page background ──────────────────────────────────────────────────────

/** A background as a change asks for it: a colour, a picture, or none (plain white). */
export interface BackgroundAsk {
  type: 'color' | 'image' | 'none';
  value?: string;
}

/** The background a page stores: always a colour or a picture. */
export interface StoredBackground {
  type: 'color' | 'image';
  value: string;
}

/** What "no background" is: plain white paper (a photo or a beige ground removed). */
export const PLAIN_BACKGROUND: StoredBackground = { type: 'color', value: '#ffffff' };

const MAX_BG_URL = 2000;

/**
 * The tool's arguments as one background, or why not. Exactly one of a colour, a
 * picture url or `clear`. A colour must be solid: a page is paper, and a see-through
 * ground would show whatever the renderer happens to draw behind it.
 */
export function backgroundFromAsk(a: { color?: string; imageUrl?: string; clear?: boolean }): { ok: true; background: BackgroundAsk } | { ok: false; error: string } {
  const given = [a.color !== undefined && a.color !== '', a.imageUrl !== undefined && a.imageUrl !== '', a.clear === true].filter(Boolean).length;
  if (given === 0) return { ok: false, error: 'Give a color (#rrggbb), an imageUrl from list_media, or clear: true for plain white.' };
  if (given > 1) return { ok: false, error: 'Give only one of color, imageUrl or clear.' };
  if (a.clear === true) return { ok: true, background: { type: 'none' } };
  if (a.color !== undefined && a.color !== '') {
    const c = parseColor(a.color);
    if (!c) return { ok: false, error: `“${String(a.color).slice(0, 40)}” is not a colour — use #rrggbb.` };
    if (c.alpha < 0.999) return { ok: false, error: 'A page background has to be solid — give a colour without transparency.' };
    return { ok: true, background: { type: 'color', value: c.hex } };
  }
  const url = String(a.imageUrl ?? '').trim().slice(0, MAX_BG_URL);
  return { ok: true, background: { type: 'image', value: url } };
}

/**
 * A background from a request body (PATCH …/background, or a staged change sent back),
 * reduced to its known shape, or null. Only the SHAPE is checked here: whether an image
 * url is allowed is the route's question (the magazine's library is the allow-list).
 */
export function parseBackgroundAsk(raw: unknown): BackgroundAsk | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  if (b.type === 'none') return { type: 'none' };
  if (b.type === 'color') {
    const c = parseColor(b.value);
    return c && c.alpha >= 0.999 ? { type: 'color', value: c.hex } : null;
  }
  if (b.type === 'image' && typeof b.value === 'string' && b.value.trim() && b.value.length <= MAX_BG_URL) {
    return { type: 'image', value: b.value.trim() };
  }
  return null;
}

/** Why a picture may be a page background (see backgroundUrlAllowed). */
export type BackgroundSource = 'current' | 'library' | 'page-background' | 'on-page';

/** A magazine id as the worker splices it into an object key (pageWrite.keySegment). */
function keySegment(value: string): string {
  return String(value).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'page';
}

/**
 * Is `key` one of THIS magazine's page-background rasters — the picture the worker
 * writes for an imported or copied PDF page (pageWrite.backgroundKey:
 * public/magazinesV2/<id>/pages/<pageId>/<run>-background.jpg; older pages:
 * magazinesV2/<id>/pages/<n>/background.jpg)? Those are never media rows, so the
 * library alone cannot vouch for them.
 */
export function isOwnPageBackgroundKey(key: string | null | undefined, magazineId: string): boolean {
  if (typeof key !== 'string' || !key || key.includes('..')) return false;
  // keySegment leaves only [A-Za-z0-9_-], none of which is special in a pattern.
  const id = keySegment(magazineId);
  return new RegExp(`^(?:public/)?magazinesV2/${id}/pages/[A-Za-z0-9_-]+/(?:[A-Za-z0-9_-]+-)?background\\.jpg$`).test(key);
}

/**
 * THE allow-list for a page-background picture — one rule for the background PATCH
 * route, the Studio's set_page_background, and a staged background sent back by the
 * client, so a proposal can never be staged that Apply would then refuse (or the other
 * way round). The page background is drawn by the server (the PDF export, the page
 * check's render), so it must be a public picture this magazine already holds:
 *
 *   'current'          the page's own background as it is now;
 *   'library'          a placeable picture in this magazine's media library;
 *   'page-background'  one of this magazine's own page-background rasters — the
 *                      artwork of an imported or copied PDF page. Without this, undoing
 *                      "clear the background" on such a page was refused, and the page's
 *                      artwork could not be put back by anyone;
 *   'on-page'          a picture already placed on this page (its url was validated
 *                      when it was written; making it the ground adds nothing new).
 *
 * Every one of them must also pass safePublicImageUrl. Returns null when not allowed.
 * `keyOf` is storage.keyFromUrl (passed in so this stays pure).
 */
export function backgroundUrlAllowed(
  url: string,
  ctx: {
    magazineId: string;
    current?: { type?: string; value?: string } | null;
    libraryUrls: Iterable<string>;
    pageImageUrls?: Iterable<string>;
    keyOf: (url: string) => string | null;
  },
): BackgroundSource | null {
  const u = String(url ?? '').trim();
  if (!u || !safePublicImageUrl(u)) return null;
  if (ctx.current?.type === 'image' && ctx.current.value === u) return 'current';
  for (const l of ctx.libraryUrls) if (l === u) return 'library';
  let key: string | null = null;
  try {
    key = ctx.keyOf(u);
  } catch {
    key = null;
  }
  if (isOwnPageBackgroundKey(key, ctx.magazineId)) return 'page-background';
  for (const p of ctx.pageImageUrls ?? []) if (p === u) return 'on-page';
  return null;
}

/** What the page stores for a background change ('none' is plain white). */
export function storedBackground(b: BackgroundAsk): StoredBackground {
  if (b.type === 'color' && b.value) return { type: 'color', value: b.value };
  if (b.type === 'image' && b.value) return { type: 'image', value: b.value };
  return { ...PLAIN_BACKGROUND };
}

/** The tray line for a background change. */
export function backgroundSummary(b: BackgroundAsk, imageLabel?: string): string {
  if (b.type === 'none') return 'Set the page background to plain white';
  if (b.type === 'color') return `Set the page background to ${b.value}`;
  return `Set ${imageLabel ? `“${imageLabel.slice(0, 40)}”` : 'a picture'} as the page background`;
}

// ── Clearing a page ──────────────────────────────────────────────────────────

export interface ClearPlan {
  /** What goes, in page order. */
  remove: MagazineElement[];
  /** Locked elements, which stay (the panel's lock is respected). */
  locked: MagazineElement[];
  /** The running head and folio, kept when asked. */
  kept: MagazineElement[];
}

/**
 * "Remove every element on this page." Every unlocked element goes; with `keepFolio`
 * the running head and page number stay. The background is not an element and is not
 * touched — set_page_background changes it.
 */
export function clearPagePlan(elements: ReadonlyArray<MagazineElement>, opts: { keepFolio?: boolean } = {}): ClearPlan {
  const remove: MagazineElement[] = [];
  const locked: MagazineElement[] = [];
  const kept: MagazineElement[] = [];
  for (const e of elements) {
    if (opts.keepFolio && FURNITURE_IDS.includes(e.id)) kept.push(e);
    else if (e.locked === true) locked.push(e);
    else remove.push(e);
  }
  return { remove, locked, kept };
}

// ── A picture's own size ─────────────────────────────────────────────────────

export interface NaturalSize {
  width: number;
  height: number;
}

/** A pixel size worth believing: two whole numbers between 1 and 30,000. */
export function plausibleSize(w: unknown, h: unknown): NaturalSize | undefined {
  const W = Number(w);
  const H = Number(h);
  if (!Number.isFinite(W) || !Number.isFinite(H) || W < 1 || H < 1 || W > 30_000 || H > 30_000) return undefined;
  return { width: Math.round(W), height: Math.round(H) };
}

/** A media row (or an attached image) whose pixel size is known. */
export interface SizedPicture {
  url?: string;
  assetId?: string;
  width: number;
  height: number;
}

/** The picture's own size for an image element: by the asset it names, else by url. */
export function naturalSizeFor(el: Pick<MagazineElement, 'type' | 'image'>, known: ReadonlyArray<SizedPicture> | undefined): NaturalSize | undefined {
  if (el.type !== 'image' || !el.image?.url || !known?.length) return undefined;
  const id = el.image.assetId;
  const hit = (id ? known.find((k) => k.assetId && k.assetId === id) : undefined) ?? known.find((k) => k.url && k.url === el.image!.url);
  return hit ? plausibleSize(hit.width, hit.height) : undefined;
}

/** "1426x806 px (1.77:1)". */
export function sizeLabel(s: NaturalSize): string {
  return `${s.width}x${s.height} px (${(s.width / s.height).toFixed(2)}:1)`;
}

/**
 * The element list with each picture's own pixel size added to its line, so "resize
 * the box to the image's ratio" can be done exactly. Lines that are not a known
 * picture's are left as they are.
 */
export function withNaturalSizes(lines: string[], elements: ReadonlyArray<MagazineElement>, known: ReadonlyArray<SizedPicture> | undefined): string[] {
  if (!known?.length) return lines;
  const notes = new Map<string, string>();
  for (const e of elements) {
    const s = naturalSizeFor(e, known);
    if (s) notes.set(e.id, ` · picture ${sizeLabel(s)}`);
  }
  if (!notes.size) return lines;
  return lines.map((line) => {
    const m = /^- #(\S+) image /.exec(line);
    const note = m ? notes.get(m[1]!) : undefined;
    return note ? `${line}${note}` : line;
  });
}

/**
 * The box that has the picture's own shape: the width kept (or the width/height
 * asked for), the other side computed from the ratio, scaled down if it would leave
 * the page, and moved back on if it hangs off an edge. 1426x806 in a 640-wide box →
 * 640x362.
 */
export function boxForRatio(box: Box, aspect: number, page: PageDims, want: { w?: number; h?: number } = {}): { box: Box; notes: string[] } {
  const notes: string[] = [];
  let w: number;
  let h: number;
  if (fin(want.w) && want.w > 0) {
    w = want.w;
    h = w / aspect;
  } else if (fin(want.h) && want.h > 0) {
    h = want.h;
    w = h * aspect;
  } else {
    w = box.w;
    h = w / aspect;
  }
  const scale = Math.min(1, page.width / w, page.height / h);
  if (scale < 1) {
    notes.push(`scaled to ${Math.round(scale * 100)}% to stay on the page`);
    w *= scale;
    h *= scale;
  }
  w = Math.max(MIN_SIZE, Math.round(w));
  h = Math.max(MIN_SIZE, Math.round(h));
  const x = Math.round(Math.max(0, Math.min(page.width - w, box.x)));
  const y = Math.round(Math.max(0, Math.min(page.height - h, box.y)));
  if (x !== Math.round(box.x) || y !== Math.round(box.y)) notes.push('moved to stay on the page');
  return { box: { x, y, w, h }, notes };
}

// ── Layers, duplicates, QR codes, icons ──────────────────────────────────────

/** The zIndex "to front" / "to back" gives, exactly as the panel's buttons do. */
export function zForLayer(elements: ReadonlyArray<Pick<MagazineElement, 'id' | 'zIndex'>>, id: string, layer: 'front' | 'back'): number {
  const others = elements.filter((e) => e.id !== id);
  const self = elements.find((e) => e.id === id);
  if (layer === 'front') return Math.min(9999, others.reduce((m, e) => Math.max(m, e.zIndex), 0) + 1);
  return Math.max(0, others.reduce((m, e) => Math.min(m, e.zIndex), self?.zIndex ?? 0) - 1);
}

/** A copy of an element as a new element: no id, unlocked, placed by the AI, on top,
 *  offset (20px down and right by default) and kept on the page. */
export function duplicateOf(el: MagazineElement, page: PageDims, z: number, at: { x?: number; y?: number; dx?: number; dy?: number } = {}): Record<string, unknown> {
  const x0 = fin(at.x) ? at.x : el.x + (fin(at.dx) ? at.dx : 20);
  const y0 = fin(at.y) ? at.y : el.y + (fin(at.dy) ? at.dy : 20);
  const x = Math.max(0, Math.min(page.width - el.w, x0));
  const y = Math.max(0, Math.min(page.height - el.h, y0));
  const { id: _id, locked: _locked, confidence: _c, ...rest } = el;
  void _id;
  void _locked;
  void _c;
  return JSON.parse(JSON.stringify({ ...rest, x: r0(x), y: r0(y), zIndex: z, locked: false, source: 'ai-agent' })) as Record<string, unknown>;
}

/**
 * Will a QR code in these colours scan? Too little contrast is an `error` (the code
 * stops working, so the change is refused); light squares on a dark ground scan in
 * most phones but not all, so that is only a `warning`.
 */
export function qrColourCheck(fg: string, bg: string): { error?: string; warning?: string } {
  const c = contrastRatio(fg, bg);
  if (c < 3) return { error: `Those colours have only ${c.toFixed(1)}:1 contrast, so the QR code would stop scanning — keep a strong difference (dark squares on a light ground is safest).` };
  const lum = (hex: string) => contrastRatio(hex, '#000000');
  if (lum(fg) > lum(bg)) return { warning: 'Light squares on a dark ground do not scan in every phone camera — dark on light is safest.' };
  return {};
}

/** A glyph name from the panel's icon set, matched without regard to case, spaces or
 *  dashes ("bar chart 3" → "BarChart3"), or the closest names when there is none. */
export function resolveIconName(asked: string): { ok: true; name: string } | { ok: false; error: string } {
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const k = key(asked);
  const hit = ICON_NAMES.find((n) => key(n) === k);
  if (hit) return { ok: true, name: hit };
  const near = ICON_NAMES.filter((n) => k && (key(n).includes(k) || k.includes(key(n)))).slice(0, 8);
  return {
    ok: false,
    error: `There is no icon “${asked.slice(0, 40)}”.${near.length ? ` Close matches: ${near.join(', ')}.` : ''} Icons available: ${ICON_NAMES.join(', ')}.`,
  };
}

// ── Arranging boxes ──────────────────────────────────────────────────────────

export interface ArrangeOptions {
  /** Font size for every text box (becomes its ceiling — no snap-back). */
  fontSize?: number;
  /** Height for every box. Absent: a text box becomes as tall as its copy needs. */
  height?: number;
  /** Space between boxes. Absent: the column's own spacing, or (evenly) whatever fills top..bottom. */
  gap?: number;
  /** Where the first box starts (page px). Absent: below `belowId`, else the topmost box. */
  top?: number;
  /** Where the last box must end (page px). Absent: the page bottom less the column's margin. */
  bottom?: number;
  /** Spread the boxes so the gaps between them are equal (filling top..bottom when no gap is given). */
  evenly?: boolean;
  /** One x and one width for every box (the boxes then make one column). */
  x?: number;
  w?: number;
  /** Start below this element (its bottom + gap). */
  belowId?: string;
}

export interface ArrangeMove {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Set when the font size changes. */
  fontSize?: number;
  from: Box;
}

export interface ArrangeMisfit {
  id: string;
  needPx?: number;
  havePx?: number;
  fitsAtPx?: number;
}

export type ArrangePlan =
  | { ok: true; moves: ArrangeMove[]; columns: number; gap: number; top: number; bottom: number; end: number; misfits: ArrangeMisfit[]; summary: string }
  | { ok: false; error: string };

/** Text boxes need two px of air under their last line (the estimate rounds each line). */
const AIR = 2;

/**
 * Lay boxes out in one deterministic step — the request the client typed on page 3:
 * "set all six body paragraph boxes to 20px, make each 220px tall, and space them
 * evenly top to bottom below the subhead with 14px gaps, inside the page margins and
 * not running off the bottom".
 *
 * Boxes are grouped into columns (they overlap side to side), each column stacked top
 * to bottom from `top`, `gap` apart, every box `height` tall (or as tall as its copy
 * at the new size). When a column cannot fit between `top` and `bottom` the plan is
 * REFUSED with the numbers and what would fit — never squeezed off the page. Text that
 * does not fit the height it was given is reported in `misfits` (with the size it fits
 * at), because the height was asked for.
 */
export function arrangePlan(elements: ReadonlyArray<MagazineElement>, ids: ReadonlyArray<string>, page: PageDims, opts: ArrangeOptions = {}): ArrangePlan {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { ok: false, error: 'Give the ids of the boxes to arrange.' };
  const pieceOf = new Map<string, string>();
  for (const p of readDropCapParagraphs([...elements]).paras) {
    pieceOf.set(p.key, p.key);
    for (const id of [p.cap.id, p.lead.id, p.rest?.id]) if (id) pieceOf.set(id, p.key);
  }
  const els: MagazineElement[] = [];
  for (const id of unique) {
    const para = pieceOf.get(id);
    if (para) return { ok: false, error: `#${id} is part of the drop-cap paragraph #${para} — arrange the other boxes, then move that paragraph with move_element on #${para}.` };
    const el = elements.find((e) => e.id === id);
    if (!el) return { ok: false, error: `No element #${id} on this page.` };
    if (el.locked) return { ok: false, error: `Element #${id} is locked — ask the user to unlock it first.` };
    els.push(el);
  }
  for (const [k, v] of [['fontSize', opts.fontSize], ['height', opts.height], ['gap', opts.gap], ['top', opts.top], ['bottom', opts.bottom], ['x', opts.x], ['w', opts.w]] as const) {
    if (v !== undefined && (!fin(v) || v < 0)) return { ok: false, error: `${k} must be a number of page pixels, 0 or more.` };
  }
  if (opts.fontSize !== undefined && (opts.fontSize < 6 || opts.fontSize > 400)) return { ok: false, error: 'fontSize must be between 6 and 400 px.' };
  if (opts.height !== undefined && opts.height < MIN_SIZE) return { ok: false, error: `height must be at least ${MIN_SIZE}px.` };

  // One x/width for all: they become one column, inside the page.
  const w = opts.w !== undefined ? Math.max(MIN_SIZE, Math.min(page.width, opts.w)) : undefined;
  const x = opts.x !== undefined ? Math.max(0, Math.min(page.width - (w ?? 0), opts.x)) : undefined;
  const geom = (el: MagazineElement) => {
    const ew = w ?? el.w;
    const ex = x ?? Math.max(0, Math.min(page.width - ew, el.x));
    return { x: ex, w: ew };
  };

  // Columns: boxes that overlap side to side by at least 30% of the narrower.
  const sorted = [...els].sort((a, b) => a.y - b.y || a.x - b.x);
  const columns: MagazineElement[][] = [];
  for (const el of sorted) {
    const g = geom(el);
    const col = columns.find((c) =>
      c.some((o) => {
        const og = geom(o);
        const ov = Math.min(g.x + g.w, og.x + og.w) - Math.max(g.x, og.x);
        return ov >= 0.3 * Math.min(g.w, og.w);
      }),
    );
    if (col) col.push(el);
    else columns.push([el]);
  }
  columns.sort((a, b) => geom(a[0]!).x - geom(b[0]!).x);

  const below = opts.belowId ? elements.find((e) => e.id === opts.belowId) : undefined;
  if (opts.belowId && !below) return { ok: false, error: `No element #${opts.belowId} on this page to arrange below.` };
  const lineOf = (el: MagazineElement) => (el.text ? (opts.fontSize ?? el.text.fontSize) * el.text.lineHeight : 24);

  // The height each box will have.
  const heightOf = (el: MagazineElement): number => {
    if (opts.height !== undefined) return Math.round(opts.height);
    if (el.type !== 'text' || !el.text) return Math.round(el.h);
    const m = measureElementText(el, { fontSize: opts.fontSize, width: geom(el).w });
    return m ? Math.max(MIN_SIZE, Math.ceil(m.needPx) + (m.noWrap ? 0 : AIR)) : Math.round(el.h);
  };

  // The space between boxes when none was asked for: the column's own usual gap (the
  // median of its gaps no bigger than two lines), else half a line.
  const ownGap = (col: MagazineElement[]): number => {
    const gaps: number[] = [];
    for (let i = 1; i < col.length; i++) {
      const prev = col[i - 1]!;
      const d = col[i]!.y - (prev.y + prev.h);
      if (d >= 0 && d <= 2 * lineOf(prev)) gaps.push(d);
    }
    gaps.sort((a, b) => a - b);
    return gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]!) : Math.round(0.5 * lineOf(col[0]!));
  };

  const firstGap = opts.gap !== undefined ? Math.round(opts.gap) : 14;
  const top = Math.round(opts.top ?? (below ? below.y + below.h + firstGap : Math.min(...els.map((e) => e.y))));
  const leftEdge = Math.min(...els.map((e) => geom(e).x));
  const margin = Math.max(16, Math.min(120, Math.round(leftEdge)));
  const bottom = Math.round(opts.bottom ?? page.height - margin);
  if (bottom <= top) return { ok: false, error: `The space to arrange in is empty: top y=${top} is not above bottom y=${bottom}.` };
  if (bottom > page.height) return { ok: false, error: `bottom y=${bottom} is below the page (it is ${page.height}px tall).` };
  const avail = bottom - top;

  const moves: ArrangeMove[] = [];
  const misfits: ArrangeMisfit[] = [];
  let usedGap = 0;
  let end = top;
  for (let ci = 0; ci < columns.length; ci++) {
    const col = columns[ci]!;
    const heights = col.map(heightOf);
    const sumH = heights.reduce((a, b) => a + b, 0);
    const n = col.length;
    let gap: number;
    if (opts.gap !== undefined) gap = Math.round(opts.gap);
    else if (opts.evenly && n > 1) gap = Math.max(0, Math.floor((avail - sumH) / (n - 1)));
    else gap = ownGap(col);
    const need = sumH + gap * (n - 1);
    if (need > avail + 0.5) {
      const where = columns.length > 1 ? `Column ${ci + 1}: these ${n} boxes` : `These ${n} box${n === 1 ? '' : 'es'}`;
      const parts = [`${sumH}px of boxes`, ...(n > 1 ? [`${n - 1} gaps of ${gap}px`] : [])];
      const fixes: string[] = [];
      const maxH = Math.floor((avail - gap * (n - 1)) / n);
      if (maxH >= MIN_SIZE) fixes.push(`height ${maxH}px or less`);
      if (n > 1 && avail - sumH >= 0) fixes.push(`a gap of ${Math.floor((avail - sumH) / (n - 1))}px or less`);
      if (opts.height === undefined && col.some((e) => e.type === 'text')) fixes.push('a smaller fontSize or shorter copy');
      fixes.push('a higher top or a lower bottom');
      return {
        ok: false,
        error: `${where} need ${need}px (${parts.join(' + ')}), but only ${avail}px is free between y=${top} and y=${bottom}. They would run off the bottom, so nothing was changed. To fit, use ${fixes.join(', or ')}.`,
      };
    }
    usedGap = Math.max(usedGap, gap);
    let y = top;
    col.forEach((el, i) => {
      const g = geom(el);
      const h = heights[i]!;
      const fontSize = opts.fontSize !== undefined && el.type === 'text' && el.text && Math.abs(el.text.fontSize - opts.fontSize) > 0.05 ? Math.round(opts.fontSize * 10) / 10 : undefined;
      const changed = Math.abs(g.x - el.x) > 0.5 || Math.abs(y - el.y) > 0.5 || Math.abs(g.w - el.w) > 0.5 || Math.abs(h - el.h) > 0.5 || fontSize !== undefined;
      if (changed) moves.push({ id: el.id, x: r0(g.x), y: r0(y), w: r0(g.w), h: r0(h), ...(fontSize !== undefined ? { fontSize } : {}), from: { x: r0(el.x), y: r0(el.y), w: r0(el.w), h: r0(el.h) } });
      if (el.type === 'text' && el.text && opts.height !== undefined) {
        const probe: MagazineElement = { ...el, x: g.x, y, w: g.w, h, text: { ...el.text, fontSize: opts.fontSize ?? el.text.fontSize } };
        const c = checkElement(probe, page);
        if (!c.fits) misfits.push({ id: el.id, ...(c.needPx !== undefined ? { needPx: c.needPx } : {}), ...(c.havePx !== undefined ? { havePx: c.havePx } : {}), ...(c.fitsAtPx !== undefined ? { fitsAtPx: c.fitsAtPx } : {}) });
      }
      end = Math.max(end, y + h);
      y += h + gap;
    });
  }
  const n = els.length;
  const bits = [
    ...(opts.fontSize !== undefined ? [`${Math.round(opts.fontSize * 10) / 10}px type`] : []),
    ...(opts.height !== undefined ? [`${Math.round(opts.height)}px tall`] : []),
    ...(n > 1 ? [`${usedGap}px apart`] : []),
  ];
  const summary = `Arranged ${n} box${n === 1 ? '' : 'es'}${bits.length ? `: ${bits.join(', ')}` : ''} (y ${top}–${r0(end)})`;
  return { ok: true, moves, columns: columns.length, gap: usedGap, top, bottom, end: r0(end), misfits, summary };
}
