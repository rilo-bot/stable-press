// ---------------------------------------------------------------------------
// Magazine Builder v2 — the Studio agent's PURE helpers: how the page is shown to the
// model, and the guardrails its edit tools run before anything is staged.
//
// The agent's tool modules (agentTools/) reach the database and the renderer, so they
// cannot be unit tested; everything here can. What lives here is what decides whether
// an edit breaks a page:
//
//   describePage / describeElement   the element list the model reads. The FULL visible
//                                    text of every box on the open page (it used to be
//                                    the first 60 characters, so a one-word fix meant
//                                    retyping a paragraph the model had never seen —
//                                    finding C01/C17/C47), pictures told apart by their
//                                    alt, origin and file (C44), a drop-cap paragraph
//                                    as ONE paragraph (C13), and the page check's
//                                    flags on the boxes that have a problem (C04/C48).
//   fitReport / growToFit            what every edit tool returns about the element it
//                                    changed (does the text fit its box?), and the box
//                                    growing DOWN into free space when copy or an
//                                    asked-for size no longer fits (C03/C50).
//   clampToPage                      moves and resizes stay on the page.
//   replaceOnPage                    find-and-replace over the page's text boxes,
//                                    through textReplace.replaceInHtml — never a retype.
//   tidyColumnPlan                   restack a column of boxes to close the gaps a
//                                    copied PDF page leaves (Adjust refuses those pages).
//   turnCheck / checkReplyLine       the end-of-turn before/after comparison.
//
// Pure: no DOM, no LLM, no I/O.
// ---------------------------------------------------------------------------

import type { MagazineElement } from './model.js';
import { MAX_TEXT_HTML, MIN_SIZE } from './model.js';
import { measureElementText } from './layout.js';
import { normalizeElementPatch, mergeElement } from './writePipeline.js';
import { replaceInHtml, visibleText } from './textReplace.js';
import {
  checkElement,
  checkSummary,
  freeSpaceBelow,
  MAX_ISSUES,
  newErrors,
  newErrorsIn,
  type CheckKind,
  type PageCheck,
  type PageCheckIssue,
} from './pageCheck.js';
import { readDropCapParagraphs, dropCapKey, type DropCapParagraph } from './dropCapPara.js';
import type { PreviewPage } from './previewHtml.js';

type PageDims = { width: number; height: number };
type Background = { type: string; value: string };

// ── Showing text to the model ────────────────────────────────────────────────

/** Most characters of one element's text shown in the open page's element list. */
export const ELEMENT_TEXT_MAX = 1500;
/** Characters of text the whole open-page list may spend. A dense page cannot crowd the
 *  rest of the prompt out; what does not fit is marked and readable with read_element. */
export const PAGE_TEXT_BUDGET = 12_000;
/** What another page's text gets in get_page (read-only, to match wording or style). */
export const OTHER_PAGE_ELEMENT_MAX = 600;
export const OTHER_PAGE_BUDGET = 6_000;
/** Below this, an element is shown as a short preview with the truncation marker. */
const PREVIEW_MIN = 80;

/**
 * The words a reader sees in a text element, on ONE line for the element list: tags
 * dropped, entities decoded, every line break (a <br>, or the "\n" joins of text copied
 * from a PDF) written " / " so the model can see where the lines are.
 */
export function modelText(html: string): string {
  return visibleText(html ?? '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' / ');
}

/** `s` cut to `max` characters with a marker naming the tool that reads the rest. */
export function clipForModel(s: string, max: number): { text: string; cut: number } {
  const chars = Array.from(s);
  if (chars.length <= max) return { text: s, cut: 0 };
  const keep = chars.slice(0, Math.max(0, max)).join('').trimEnd();
  const cut = chars.length - Array.from(keep).length;
  return { text: `${keep}…[+${cut} more chars — call read_element for all of it]`, cut };
}

/** The last path segment of a picture's url — enough to tell two files apart. */
export function shortUrl(url: string): string {
  const clean = (url ?? '').split(/[?#]/)[0] ?? '';
  const seg = clean.split('/').filter(Boolean).pop() ?? '';
  if (!seg) return '';
  return seg.length > 48 ? `…/${seg.slice(0, 20)}…${seg.slice(-20)}` : `…/${seg}`;
}

/** Where a picture came from, in a word or two the model can match to a request. */
export function imageKind(el: MagazineElement): string {
  const url = (el.image?.url ?? '').toLowerCase();
  if (/-chart\.png$/.test(url.split(/[?#]/)[0] ?? '')) return 'chart';
  if (/-gen(-p\d+)?\.[a-z0-9]+$/.test(url.split(/[?#]/)[0] ?? '')) return 'AI image';
  if (/-stock\.[a-z0-9]+$/.test(url.split(/[?#]/)[0] ?? '')) return 'stock photo';
  if (el.source === 'extracted') return 'from the PDF';
  if (el.source === 'ai-agent') return 'placed by the assistant';
  return 'uploaded/placed by hand';
}

/** Quote-safe one-line rendering of page data (alt text and the like). */
function quoted(s: string, max: number): string {
  const flat = (s ?? '').replace(/\s+/g, ' ').replace(/"/g, '“').trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max).join('').trimEnd()}…` : flat;
}

const r0 = (n: number) => Math.round(Number(n) || 0);
const boxOf = (e: { x: number; y: number; w: number; h: number }) => `@(${r0(e.x)},${r0(e.y)} ${r0(e.w)}x${r0(e.h)})`;

/**
 * One element as a line of the list the model reads. Text shows its FULL visible copy
 * up to `maxChars` (default ELEMENT_TEXT_MAX), marked when cut. `flag` is a page-check
 * note appended at the end. Returns the line and whether the text was cut.
 */
export function describeOne(
  e: MagazineElement,
  opts: { selected?: boolean; maxChars?: number; flag?: string } = {},
): { line: string; cut: boolean } {
  const tag = opts.selected ? ' (THIS — the selected element)' : '';
  const box = `${boxOf(e)} z${e.zIndex}`;
  let detail = '';
  let cut = false;
  if (e.type === 'text' && e.text) {
    const t = e.text;
    const shown = clipForModel(modelText(t.content), opts.maxChars ?? ELEMENT_TEXT_MAX);
    cut = shown.cut > 0;
    const ceiling = typeof t.maxFontSize === 'number' && t.maxFontSize > t.fontSize + 0.5 ? ` (shrunk to fit; max ${r0(t.maxFontSize)}px)` : '';
    const pdf = e.source === 'extracted' ? ' [copied PDF lines]' : '';
    // The face, so a box set in a different family from its neighbours can be seen
    // (and fixed with set_element_style fontFamily) — C55. 'inherit' prints in the
    // app's body face, so it is named as such rather than as a family.
    const first = (t.fontFamily ?? '').split(',')[0]!.trim().replace(/^['"]|['"]$/g, '');
    const face = !first || /^(inherit|unset|revert|revert-layer|initial)$/i.test(first) ? 'body font' : first.slice(0, 40);
    detail = `${t.role} "${shown.text}" ${t.color} ${r0(t.fontSize)}px ${face}${ceiling}${pdf}`;
  } else if (e.type === 'image' && e.image) {
    const im = e.image;
    if (!im.url) detail = `EMPTY picture box fit:${im.fit}`;
    else {
      const alt = quoted(im.alt ?? '', 60);
      detail = `img "${alt || 'untitled'}" (${imageKind(e)}) ${shortUrl(im.url)} fit:${im.fit}`;
    }
  } else if (e.type === 'shape' && e.shape) {
    detail = `fill ${e.shape.fill}${typeof e.shape.opacity === 'number' && e.shape.opacity < 1 ? ` at ${Math.round(e.shape.opacity * 100)}% opacity` : ' (solid)'}`;
  } else if (e.type === 'qr' && e.qr) detail = `qr ${e.qr.url || '(no link)'}`;
  else if (e.type === 'icon' && e.icon) detail = `icon ${e.icon.src ? 'uploaded art' : e.icon.name || 'default'}`;
  const flag = opts.flag ? ` ${opts.flag}` : '';
  return { line: `- #${e.id} ${e.type} ${detail} ${box}${tag}${flag}`, cut };
}

/** describeOne's line alone. */
export function describeElement(e: MagazineElement, selectedId?: string, opts: { maxChars?: number; flag?: string } = {}): string {
  return describeOne(e, { ...opts, selected: !!selectedId && e.id === selectedId }).line;
}

/** A drop-cap paragraph as ONE line, under the key every edit tool accepts. */
function describeDropCap(p: DropCapParagraph, opts: { selected: boolean; maxChars: number; flag?: string }): { line: string; cut: boolean } {
  const t = p.lead.text!;
  const shown = clipForModel(modelText(p.raw), opts.maxChars);
  const pieces = [p.cap.id, p.lead.id, ...(p.rest ? [p.rest.id] : [])].map((id) => `#${id}`).join(', ');
  const tag = opts.selected ? ' (THIS — the selected element)' : '';
  const flag = opts.flag ? ` ${opts.flag}` : '';
  return {
    line:
      `- #${p.key} paragraph-with-drop-cap ${t.role} "${shown.text}" ${t.color} ${r0(p.pinned)}px ${boxOf(p.box)} z${p.lead.zIndex}` +
      ` — ONE paragraph drawn as ${p.rest ? 3 : 2} pieces (${pieces}); edit, move or restyle it only through #${p.key}${tag}${flag}`,
    cut: shown.cut > 0,
  };
}

/**
 * The element list for a page: one line per element (a drop-cap paragraph's pieces as
 * one line), text shown in full up to `perElement` characters each and `budget` for
 * the whole page. The budget is spent on the selected element first, then on body
 * copy, then on the rest in page order; an element the budget does not reach gets a
 * short preview with the read_element marker. Lines stay in page order.
 *
 * Returns the lines and the ids whose text was cut (the agent then asks for a
 * read_element before letting the model replace that text wholesale).
 */
export function describePage(
  elements: MagazineElement[],
  opts: { selectedId?: string; perElement?: number; budget?: number; flags?: Map<string, string> } = {},
): { lines: string[]; truncated: Set<string> } {
  const perElement = opts.perElement ?? ELEMENT_TEXT_MAX;
  let budget = opts.budget ?? PAGE_TEXT_BUDGET;
  const { paras } = readDropCapParagraphs(elements);
  const pieceToPara = new Map<string, DropCapParagraph>();
  for (const p of paras) for (const id of [p.cap.id, p.lead.id, p.rest?.id]) if (id) pieceToPara.set(id, p);
  const selectedKey = opts.selectedId ? (pieceToPara.get(opts.selectedId)?.key ?? opts.selectedId) : undefined;

  // One entry per line, in page order.
  type Entry = { id: string; el?: MagazineElement; para?: DropCapParagraph; textLen: number; body: boolean };
  const entries: Entry[] = [];
  const seenPara = new Set<string>();
  for (const el of elements) {
    const para = pieceToPara.get(el.id);
    if (para) {
      if (seenPara.has(para.key)) continue;
      seenPara.add(para.key);
      entries.push({ id: para.key, para, textLen: Array.from(modelText(para.raw)).length, body: true });
      continue;
    }
    const textLen = el.type === 'text' && el.text ? Array.from(modelText(el.text.content)).length : 0;
    entries.push({ id: el.id, el, textLen, body: el.type === 'text' && el.text?.role === 'body' });
  }
  // Who gets the budget first.
  const order = entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const rank = (x: Entry) => (x.id === selectedKey ? 0 : x.body ? 1 : 2);
      return rank(a.e) - rank(b.e) || a.i - b.i;
    });
  const allowance = new Map<string, number>();
  for (const { e } of order) {
    if (!e.textLen) continue;
    const want = Math.min(perElement, e.textLen);
    const give = budget >= want ? want : Math.max(PREVIEW_MIN, budget);
    allowance.set(e.id, give);
    budget = Math.max(0, budget - Math.min(give, e.textLen));
  }
  const truncated = new Set<string>();
  const lines = entries.map((e) => {
    const maxChars = allowance.get(e.id) ?? perElement;
    const flag = opts.flags?.get(e.id);
    const out = e.para
      ? describeDropCap(e.para, { selected: e.id === selectedKey, maxChars, flag })
      : describeOne(e.el!, { selected: e.id === selectedKey, maxChars, flag });
    if (out.cut) {
      truncated.add(e.id);
      if (e.para) for (const id of [e.para.cap.id, e.para.lead.id, e.para.rest?.id]) if (id) truncated.add(id);
    }
    return out.line;
  });
  return { lines, truncated };
}

// ── The page check, folded into the list ────────────────────────────────────

const FLAG_WORDS: Record<CheckKind, string> = {
  'text-clipped': 'CUT OFF',
  'text-past-edge': 'RUNS OFF THE PAGE',
  'text-spills': 'spills out of its box',
  'text-overlap': 'OVERLAPS other text',
  'element-hidden': 'HIDDEN under another element',
  'image-empty': 'EMPTY picture box',
  'image-broken': 'picture FAILED TO LOAD',
  'text-empty': 'empty text box',
  'tiny-text': 'type too small',
  'low-contrast': 'hard to read on its background',
  'size-mismatch': 'size out of step',
  'loose-gap': 'loose gap above it',
  'off-page': 'OFF THE PAGE',
  sliver: 'photo cut to a sliver',
  'empty-box': 'box far bigger than its text',
  'dead-band': 'empty band',
  'page-empty': 'page empty',
};

/**
 * Per-element flags from a page check, for the element list: "⚠ CUT OFF: needs 412px
 * at 24px type, the box is 260px …". Errors are marked ⚠, warnings "note:". At most two
 * per element. A drop-cap piece's flag is also filed under its paragraph's key.
 */
export function checkFlags(check: PageCheck | undefined): Map<string, string> {
  const per = new Map<string, string[]>();
  for (const i of check?.issues ?? []) {
    if (!i.elementId) continue;
    const ids = [i.elementId];
    const key = dropCapKey(i.elementId);
    if (key && key !== i.elementId) ids.push(key);
    const detail = i.detail.length > 150 ? `${i.detail.slice(0, 147)}…` : i.detail;
    const note = `${i.severity === 'error' ? '⚠' : 'note:'} ${FLAG_WORDS[i.kind]}: ${detail}`;
    for (const id of ids) {
      const list = per.get(id) ?? [];
      if (list.length < 2) list.push(note);
      per.set(id, list);
    }
  }
  return new Map([...per.entries()].map(([id, notes]) => [id, notes.join(' ')]));
}

// ── Fit: what an edit tool returns about the element it changed ──────────────

export interface FitResult {
  fits: boolean;
  /** Font size the text is at after the change (text only). */
  fontSize?: number;
  /** Height (px) the copy needs at that size, and the box height (text only). */
  needPx?: number;
  havePx?: number;
  /** Largest size at which it would fit the box, when it does not. */
  fitsAtPx?: number;
  /** Room (px) to grow the box downward before it meets the next element or the page bottom. */
  freeBelowPx?: number;
  /** What is wrong and the concrete fix, one line per problem (at most three). */
  problems?: string[];
}

/** checkElement's answer, in the compact form a tool result carries. */
export function fitReport(el: MagazineElement, page: PageDims, elements?: MagazineElement[]): FitResult {
  const c = checkElement(el, page);
  const out: FitResult = { fits: c.fits };
  if (el.type === 'text' && el.text) {
    out.fontSize = Math.round(el.text.fontSize * 10) / 10;
    if (c.needPx !== undefined) out.needPx = c.needPx;
    if (c.havePx !== undefined) out.havePx = c.havePx;
    if (c.fitsAtPx !== undefined) out.fitsAtPx = c.fitsAtPx;
  }
  if (!c.fits && elements) out.freeBelowPx = freeSpaceBelow(el, elements, page);
  const problems = c.issues
    .filter((i) => i.severity === 'error' || i.kind === 'text-spills')
    .slice(0, 3)
    .map((i) => `${FLAG_WORDS[i.kind]}: ${i.detail}. Fix: ${i.fix}`);
  if (problems.length) out.problems = problems;
  return out;
}

/** Room left to grow, or why growing will not help. */
export type Growth =
  | { kind: 'grow'; from: number; to: number }
  | { kind: 'blocked'; needPx: number; havePx: number; freeBelowPx: number };

/**
 * When a text element's copy does not fit its box at the size it is set at, the height
 * the box must grow to — DOWNWARD into free space only (nothing it would run into, and
 * inside the page). Null when the copy fits, when it is drawn as its PDF lines (those
 * spill, they are not cut, and only a width change re-wraps them), or when the problem
 * is a word wider than the box (more height cannot fix that). 'blocked' when there is
 * not enough room below, with the numbers.
 */
export function growToFit(el: MagazineElement, elements: MagazineElement[], page: PageDims): Growth | null {
  if (el.type !== 'text' || !el.text) return null;
  const m = measureElementText(el);
  if (!m || m.fits || m.noWrap) return null;
  if (m.needPx <= m.havePx + 0.5) return null; // a width problem, not a height one
  // Two px of air: the estimate rounds each line, and a box sized to the pixel clips
  // the last descenders in a browser that wraps a hair later.
  const need = Math.ceil(m.needPx) + 2;
  const free = Math.min(freeSpaceBelow(el, elements, page), roomInContainer(el, elements, page));
  if (need - el.h <= free) return { kind: 'grow', from: r0(el.h), to: need };
  return { kind: 'blocked', needPx: Math.ceil(m.needPx), havePx: r0(el.h), freeBelowPx: free };
}

/**
 * Room left inside the panel, scrim or picture the text sits ON (one that holds the
 * whole box and is not the page's sheet-sized ground): growing past its bottom edge
 * would carry the words off their panel onto whatever is beside it. Infinity when the
 * text stands on the page itself.
 */
function roomInContainer(el: MagazineElement, elements: MagazineElement[], page: PageDims): number {
  const bottom = el.y + el.h;
  let room = Infinity;
  for (const o of elements) {
    if (o.id === el.id || (o.type !== 'shape' && o.type !== 'image')) continue;
    if (o.type === 'shape' && (o.shape?.opacity ?? 1) <= 0.02) continue;
    if (o.type === 'image' && !o.image?.url) continue;
    if (o.w * o.h >= page.width * page.height * 0.5) continue; // the page's ground
    const holds = o.x <= el.x + 1 && o.x + o.w >= el.x + el.w - 1 && o.y <= el.y + 1 && o.y + o.h >= bottom - 1;
    if (holds) room = Math.min(room, Math.max(0, Math.floor(o.y + o.h - bottom)));
  }
  return room;
}

/** normalizeElementPatch with the one-level merge as a fallback, keeping the id. */
export function applyPatch(el: MagazineElement, patch: Record<string, unknown>, page: PageDims): MagazineElement {
  const stored = normalizeElementPatch(el, patch, page);
  const out = stored ?? (mergeElement(el, patch) as unknown as MagazineElement);
  return { ...out, id: el.id };
}

/**
 * A text edit with the box-growing guardrail: the element as it will be stored after
 * `patch`, and — when its copy then no longer fits — the same patch with the box grown
 * downward into free space (one patch, one proposal). A patch that sets its own height
 * is left as the model sent it.
 */
export function withGrowth(
  el: MagazineElement,
  patch: Record<string, unknown>,
  elements: MagazineElement[],
  page: PageDims,
): { patch: Record<string, unknown>; next: MagazineElement; growth: Growth | null } {
  const next = applyPatch(el, patch, page);
  if ('h' in patch || el.type !== 'text') return { patch, next, growth: null };
  const others = elements.map((e) => (e.id === el.id ? next : e));
  const growth = growToFit(next, others, page);
  if (!growth || growth.kind !== 'grow') return { patch, next, growth };
  const grown = { ...patch, h: growth.to };
  return { patch: grown, next: applyPatch(el, grown, page), growth };
}

/** One sentence about a growth, for a tool result. */
export function growthNote(g: Growth | null): string | undefined {
  if (!g) return undefined;
  if (g.kind === 'grow') return `The box grew from ${g.from}px to ${g.to}px tall (into free space below) so all the text shows.`;
  return (
    `It does not fit: the text needs ${g.needPx}px but the box is ${g.havePx}px and only ${g.freeBelowPx}px is free below. ` +
    'Shorten the copy, use a smaller fontSize (see fit.fitsAtPx), move what is below, or widen the box.'
  );
}

// ── Geometry ─────────────────────────────────────────────────────────────────

/**
 * A move/resize kept on the page: w and h within [MIN_SIZE, page], x and y so the
 * whole box stays inside. Only the fields given are returned (with what the element
 * already has filling in the rest for the bounds), plus a note per field that moved.
 *
 * `bleed` (pictures and panels): a box that runs off an edge is a BLEED — a design
 * choice the page check accepts while at least half of it is on the page
 * (pageCheck.offPageIssue). Such a box keeps the position it was given, and a box that
 * is already wider or taller than the page is not cut down to the page's size, so a
 * full-bleed photo that is resized or nudged keeps covering the page instead of being
 * pulled in and leaving a white strip. Words, codes and icons never bleed.
 *
 * Call it only when the edit CHANGES geometry: on a box that already bleeds, even an
 * empty `geo` would pull it inside (x/y are written whenever the box is outside).
 */
export function clampToPage(
  el: Pick<MagazineElement, 'x' | 'y' | 'w' | 'h'>,
  geo: { x?: number; y?: number; w?: number; h?: number },
  page: PageDims,
  opts: { bleed?: boolean } = {},
): { patch: { x?: number; y?: number; w?: number; h?: number }; notes: string[] } {
  const notes: string[] = [];
  const patch: { x?: number; y?: number; w?: number; h?: number } = {};
  const fin = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const w0 = fin(geo.w);
  const h0 = fin(geo.h);
  const maxW = opts.bleed ? Math.max(page.width, el.w) : page.width;
  const maxH = opts.bleed ? Math.max(page.height, el.h) : page.height;
  const w = w0 !== undefined ? Math.max(MIN_SIZE, Math.min(maxW, w0)) : el.w;
  const h = h0 !== undefined ? Math.max(MIN_SIZE, Math.min(maxH, h0)) : el.h;
  if (w0 !== undefined) {
    patch.w = w;
    if (Math.abs(w - w0) > 0.5) notes.push(`w ${r0(w0)} → ${r0(w)}`);
  }
  if (h0 !== undefined) {
    patch.h = h;
    if (Math.abs(h - h0) > 0.5) notes.push(`h ${r0(h0)} → ${r0(h)}`);
  }
  const x0 = fin(geo.x);
  const y0 = fin(geo.y);
  // The box must stay inside even when only its size changed.
  const xWant = x0 ?? el.x;
  const yWant = y0 ?? el.y;
  let x = Math.max(0, Math.min(page.width - w, xWant));
  let y = Math.max(0, Math.min(page.height - h, yWant));
  if (opts.bleed) {
    const visW = Math.max(0, Math.min(xWant + w, page.width) - Math.max(xWant, 0));
    const visH = Math.max(0, Math.min(yWant + h, page.height) - Math.max(yWant, 0));
    if (visW * visH >= 0.5 * w * h) {
      x = xWant;
      y = yWant;
    }
  }
  if (x0 !== undefined || Math.abs(x - xWant) > 0.5) {
    patch.x = x;
    if (Math.abs(x - xWant) > 0.5) notes.push(`x ${r0(xWant)} → ${r0(x)}`);
  }
  if (y0 !== undefined || Math.abs(y - yWant) > 0.5) {
    patch.y = y;
    if (Math.abs(y - yWant) > 0.5) notes.push(`y ${r0(yWant)} → ${r0(y)}`);
  }
  return { patch, notes };
}

// ── Find and replace over a page ─────────────────────────────────────────────

export interface ReplaceHit {
  /** The element (or drop-cap paragraph key) whose copy changed. */
  id: string;
  /** Its new stored HTML (the whole paragraph's, for a drop cap). */
  html: string;
  count: number;
  /** Set when the hit is a drop-cap paragraph (re-set it as one). */
  para?: DropCapParagraph;
}

/**
 * Replace `find` with `replace` in the text boxes of a page, through replaceInHtml
 * (every byte outside the matches kept). A drop-cap paragraph is searched as ONE
 * paragraph, so a word that runs from the cap into the opening lines still matches.
 * `ids` limits the search (an id may be a drop-cap piece or its key). Locked boxes are
 * never changed; their matches are counted in `locked`. When nothing matched with the
 * case as given, `otherCase` counts the matches a case-insensitive search would find.
 *
 * A box the replacement would push past MAX_TEXT_HTML is NOT a hit: validation cuts
 * stored HTML at that length, so writing it would silently delete the end of the
 * client's paragraph (possibly mid-tag) while the count reported a clean replace. Its
 * matches are counted in `tooLong` instead, for the caller to say so.
 */
export function replaceOnPage(
  elements: ReadonlyArray<MagazineElement>,
  find: string,
  replace: string,
  opts: { ids?: string[]; matchCase?: boolean; wholeWord?: boolean } = {},
): {
  hits: ReplaceHit[];
  total: number;
  locked: { id: string; count: number }[];
  tooLong: { id: string; count: number }[];
  searched: number;
  otherCase: number;
} {
  const { paras } = readDropCapParagraphs([...elements]);
  const pieceToPara = new Map<string, DropCapParagraph>();
  for (const p of paras) for (const id of [p.cap.id, p.lead.id, p.rest?.id]) if (id) pieceToPara.set(id, p);
  const wanted = opts.ids?.length ? new Set(opts.ids.map((id) => pieceToPara.get(id)?.key ?? dropCapKey(id) ?? id)) : null;
  const ro = { matchCase: opts.matchCase !== false, wholeWord: opts.wholeWord === true };

  // Each searchable unit: a plain text element, or a whole drop-cap paragraph.
  const units: { id: string; html: string; locked: boolean; para?: DropCapParagraph }[] = [];
  const seen = new Set<string>();
  for (const el of elements) {
    if (el.type !== 'text' || !el.text) continue;
    const para = pieceToPara.get(el.id);
    if (para) {
      if (seen.has(para.key)) continue;
      seen.add(para.key);
      const locked = [para.cap, para.lead, para.rest].some((p) => p?.locked === true);
      units.push({ id: para.key, html: para.raw, locked, para });
      continue;
    }
    units.push({ id: el.id, html: el.text.content, locked: el.locked === true });
  }
  const hits: ReplaceHit[] = [];
  const locked: { id: string; count: number }[] = [];
  const tooLong: { id: string; count: number }[] = [];
  let searched = 0;
  for (const u of units) {
    if (wanted && !wanted.has(u.id)) continue;
    searched++;
    const r = replaceInHtml(u.html, find, replace, ro);
    if (!r.count) continue;
    if (u.locked) locked.push({ id: u.id, count: r.count });
    else if (r.html.length > MAX_TEXT_HTML) tooLong.push({ id: u.id, count: r.count });
    else hits.push({ id: u.id, html: r.html, count: r.count, ...(u.para ? { para: u.para } : {}) });
  }
  const total = hits.reduce((n, h) => n + h.count, 0);
  let otherCase = 0;
  if (!total && !locked.length && !tooLong.length && ro.matchCase) {
    for (const u of units) {
      if (wanted && !wanted.has(u.id)) continue;
      otherCase += replaceInHtml(u.html, find, replace, { ...ro, matchCase: false }).count;
    }
  }
  return { hits, total, locked, tooLong, searched, otherCase };
}

// ── Tidying a column ─────────────────────────────────────────────────────────

export interface TidyMove {
  id: string;
  y: number;
  h: number;
  fromY: number;
  fromH: number;
}

/**
 * Restack boxes as one column in reading order, closing the gaps between them: the
 * first keeps its place, each next one starts `gap` px below the end of the text above
 * it, and every text box becomes exactly as tall as its copy needs (which also frees
 * text that was cut off). Pictures and shapes keep their height. The default gap is the
 * column's own usual spacing (the median of its gaps that are no bigger than two lines),
 * else about half a line.
 *
 * Refuses (with the reason) ids that are not on the page, locked boxes, drop-cap pieces,
 * boxes that are not one column, and a column that cannot fit on the page even with
 * the gaps closed up completely.
 */
export function tidyColumnPlan(
  elements: MagazineElement[],
  ids: string[],
  page: PageDims,
  gap?: number,
): { ok: true; moves: TidyMove[]; gap: number; bottom: number } | { ok: false; error: string } {
  const unique = [...new Set(ids)];
  if (unique.length < 2) return { ok: false, error: 'Give at least two element ids from the same column.' };
  // A drop-cap paragraph's pieces move together (move_element on its key); a lone piece
  // left by an earlier fold is ordinary text and may be tidied like any other box.
  const inParagraph = new Map<string, string>();
  for (const p of readDropCapParagraphs(elements).paras) {
    inParagraph.set(p.key, p.key);
    for (const id of [p.cap.id, p.lead.id, p.rest?.id]) if (id) inParagraph.set(id, p.key);
  }
  const els: MagazineElement[] = [];
  for (const id of unique) {
    const key = inParagraph.get(id);
    if (key) return { ok: false, error: `#${id} is part of the drop-cap paragraph #${key} — move that paragraph with move_element on #${key} instead.` };
    const el = elements.find((e) => e.id === id);
    if (!el) return { ok: false, error: `No element #${id} on this page.` };
    if (el.locked) return { ok: false, error: `Element #${id} is locked — ask the user to unlock it first.` };
    els.push(el);
  }
  els.sort((a, b) => a.y - b.y || a.x - b.x);
  for (let i = 1; i < els.length; i++) {
    const a = els[i - 1]!;
    const b = els[i]!;
    const ov = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    if (ov < 0.3 * Math.min(a.w, b.w)) {
      return { ok: false, error: `#${a.id} and #${b.id} are not in one column (they barely overlap side to side) — tidy each column on its own.` };
    }
  }
  const lineOf = (el: MagazineElement) => (el.text ? el.text.fontSize * el.text.lineHeight : 24);
  /** The height each box will have: a text box exactly its copy, anything else as is. */
  const heightOf = (el: MagazineElement): number => {
    if (el.type !== 'text' || !el.text || !visibleText(el.text.content).trim()) return el.h;
    const m = measureElementText(el);
    return m ? Math.max(MIN_SIZE, Math.ceil(m.needPx) + (m.noWrap ? 0 : 2)) : el.h;
  };
  /** Where the box's printed content ends today (a text box's copy, not its box). */
  const inkBottom = (el: MagazineElement) => el.y + Math.min(el.h, heightOf(el));
  let g = gap;
  if (g === undefined || !Number.isFinite(g)) {
    const gaps: number[] = [];
    for (let i = 1; i < els.length; i++) {
      const d = els[i]!.y - inkBottom(els[i - 1]!);
      if (d >= 0 && d <= 2 * lineOf(els[i - 1]!)) gaps.push(d);
    }
    gaps.sort((a, b) => a - b);
    g = gaps.length ? gaps[Math.floor(gaps.length / 2)]! : 0.5 * lineOf(els[0]!);
  }
  g = Math.max(0, Math.min(200, Math.round(g)));
  const heights = els.map(heightOf);
  const total = heights.reduce((n, h) => n + h, 0);
  const top = els[0]!.y;
  let usedGap = g;
  const room = page.height - top - total;
  if (room < 0) {
    return {
      ok: false,
      error: `These boxes need ${Math.ceil(total)}px stacked with no gaps, but only ${Math.floor(page.height - top)}px is left below y=${r0(top)}. Shorten the copy or use smaller type first.`,
    };
  }
  if (room < usedGap * (els.length - 1)) usedGap = Math.floor(room / (els.length - 1));
  const moves: TidyMove[] = [];
  let y = top;
  els.forEach((el, i) => {
    const h = heights[i]!;
    const ny = i === 0 ? el.y : y;
    if (Math.abs(ny - el.y) > 0.5 || Math.abs(h - el.h) > 0.5) moves.push({ id: el.id, y: r0(ny), h: r0(h), fromY: r0(el.y), fromH: r0(el.h) });
    y = ny + h + usedGap;
  });
  return { ok: true, moves, gap: usedGap, bottom: r0(y - usedGap) };
}

// ── The end of a turn ────────────────────────────────────────────────────────

/**
 * What the turn BROKE: the errors in `after` that were not in `before` (newErrors).
 * Undefined when there are none — the AgentTurn.check contract.
 *
 * `all` carries both states' UNCAPPED issue lists (pageCheck.allPageIssues). A
 * PageCheck shows at most MAX_ISSUES, so on a page with more errors than that, one cut
 * from the capped "before" could resurface in "after" once another was fixed and be
 * reported as new; with `all` the diff sees everything and only the result is capped.
 */
export function turnCheck(
  before: PageCheck,
  after: PageCheck,
  all?: { before: ReadonlyArray<PageCheckIssue>; after: ReadonlyArray<PageCheckIssue> },
): PageCheck | undefined {
  const issues: PageCheckIssue[] = (all ? newErrorsIn(all.before, all.after) : newErrors(before, after)).slice(0, MAX_ISSUES);
  if (!issues.length) return undefined;
  const check: PageCheck = { ...after, ok: false, issues, summary: '' };
  check.summary = checkSummary(check);
  return check;
}

const REPLY_WORDS: Partial<Record<CheckKind, string>> = {
  'text-clipped': 'would be cut off',
  'text-past-edge': 'would run off the page',
  'text-overlap': 'would overlap other text',
  'element-hidden': 'would be hidden under another element',
  'image-empty': 'would be an empty picture box',
  'image-broken': 'would show a broken picture',
  'off-page': 'would sit partly off the page',
  'page-empty': 'would be empty',
};

/** The one plain line added to the reply when a turn leaves new errors on the page. */
export function checkReplyLine(check: PageCheck | undefined): string {
  const errors = (check?.issues ?? []).filter((i) => i.severity === 'error');
  if (!errors.length) return '';
  const phrase = (i: PageCheckIssue) => `${i.kind === 'page-empty' ? 'the page' : i.label} ${REPLY_WORDS[i.kind] ?? 'would need fixing'}`;
  if (errors.length === 1) return `Heads-up: after these changes ${phrase(errors[0]!)} — say “fix it” and I’ll sort it out.`;
  const shown = errors.slice(0, 2).map(phrase).join('; ');
  const more = errors.length > 2 ? `; and ${errors.length - 2} more` : '';
  return `Heads-up: after these changes ${errors.length} things on this page would need fixing (${shown}${more}) — say “fix it” and I’ll sort them out.`;
}

// ── The page as the renderer takes it ────────────────────────────────────────

/** The working copy as a PreviewPage (what measurePagePreview and the look render). */
export function previewPageOf(page: PageDims & { background?: Background }, elements: MagazineElement[]): PreviewPage {
  const bg = page.background;
  const background: PreviewPage['background'] =
    bg && typeof bg.value === 'string' ? { type: bg.type === 'image' ? 'image' : 'color', value: bg.value } : { type: 'color', value: '#ffffff' };
  return { width: page.width, height: page.height, background, elements };
}

/** The user's latest message (what a look checks the page against). */
export function lastUserMessage(messages: { role: string; content: string }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) return m.content.trim().slice(0, 600);
  }
  return '';
}

// ── A page whose words are part of a picture (C33) ───────────────────────────

/**
 * What the Studio is told when the open page's words cannot be edited because they
 * are part of a PICTURE — a PDF page copied from a scan (`notice: 'scanned'`), one
 * whose type was drawn as shapes (`'no-text'`), or any page whose only content is an
 * image background. The model used to see an empty element list, and either said
 * "I can't see any text on this page" about a page full of words, or wrote new copy
 * as if nothing was there. Empty when the page has editable text of its own.
 */
export function pictureOnlyPageLines(
  page: { background?: Background; notice?: string },
  elements: ReadonlyArray<MagazineElement>,
): string[] {
  const hasWords = elements.some((e) => e.type === 'text' && !!visibleText(e.text?.content ?? '').trim());
  const imageGround = page.background?.type === 'image' && !!page.background.value;
  const why =
    page.notice === 'scanned'
      ? 'This page was copied from a SCANNED PDF page that has no text layer, so it was copied as one picture (the page background).'
      : page.notice === 'no-text'
        ? 'This page was copied from a PDF page whose type was drawn as shapes (no text layer), so it was copied as one picture (the page background).'
        : imageGround && !hasWords
          ? 'This page’s background is a picture (for example a copied or scanned PDF page) and it has no text elements of its own.'
          : '';
  if (!why) return [];
  return [
    `PAGE NOTE: ${why} Any words you can see on it are part of that picture, NOT editable elements, so they`,
    'cannot be changed, replaced or restyled. If the user asks to edit them, explain this in one sentence and',
    'offer to add new text over the picture (add_element), or to rebuild the page with fresh, editable copy.',
  ];
}

// ── How long a turn may take ─────────────────────────────────────────────────

/** The time a turn gets: most edits are quick tool calls. */
export const TURN_BUDGET_MS = 90_000;
/** A turn that makes or places a picture or a chart: generating one alone takes up to
 *  ~25 s (agentAddPure.IMAGE_TIME_NEEDED_MS), and a look after it another ~15 s. */
export const PICTURE_TURN_BUDGET_MS = 120_000;

const PICTURE_ASK =
  /\b(photos?|photograph\w*|pictures?|images?|illustrat\w*|posters?|flyers?|graphics?|charts?|graphs?|infographics?|drawings?|draw|generate)\b/i;

/**
 * The turn's time budget (design B6). With the 90 s every turn used to get, a turn that
 * read the page, generated a picture and then looked at the result ran out part-way, and
 * the image tools could only answer "try again in a new message". A turn that attaches
 * pictures or asks for one gets 120 s; the client sets no timeout of its own on the call.
 */
export function turnBudgetMs(request: string, attachedImages = 0): number {
  return attachedImages > 0 || PICTURE_ASK.test(request ?? '') ? PICTURE_TURN_BUDGET_MS : TURN_BUDGET_MS;
}
