// ---------------------------------------------------------------------------
// Magazine Builder v2 — measuring a page the browser has drawn.
//
// The DOM half of the editor's page check (editor-v2/pageCheck.ts mounts the page;
// pageCheckRules.ts judges what is measured here). It reads exactly what the server's
// Chromium measurement reads (lib/magazineV2/renderPreview.ts MEASURE_PAGE_JS) from
// the same markers IssuePageCanvas writes — `data-el-id` on each element's box,
// `data-el-text` on a text element's content div — so a page measured in the
// editor and a page measured on the server describe their elements identically:
//
//   box        the element's layout box, from its computed left/top/width/height
//              (before any rotation, which is how elements are stored).
//   contentW/H the copy's own size: its content div's scroll size, unclipped. The
//              box is overflow:hidden, but the div inside it is not, so the div is
//              as tall as the copy needs — taller than the box means cut off.
//   ink        the union of every glyph run's rects (a Range over each text node).
//              Ranges ignore clipping, so this is where the words really are —
//              past the box, past the page edge — not where they happen to show.
//   imgOk      a picture that finished loading (fallback included) with no pixels.
//
// No React here, so the pure parts are unit-tested without a browser.
// ---------------------------------------------------------------------------

import type { ElementMeasurement, TextProbe } from './pageCheckRules';
import type { MagazineElement } from './model';

/** One element as read off the page, in CSS px of the mount (not yet page px). */
export interface RawItem {
  id: string;
  box: { x: number; y: number; w: number; h: number };
  contentW?: number;
  contentH?: number;
  ink?: { x: number; y: number; w: number; h: number };
  imgOk?: boolean;
}

/** What readMountedPage returns: the page's drawn width (for the scale) and its items. */
export interface RawPage {
  pageW: number;
  pageH: number;
  items: RawItem[];
}

/** More elements than any real page holds; a runaway page is cut, never hung on. */
const MAX_ITEMS = 600;
/** NodeFilter.SHOW_TEXT, as a literal so the reader also runs against a DOM stand-in. */
const SHOW_TEXT = 0x4;

// ── Pure ─────────────────────────────────────────────────────────────────────

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
function rectFrom(v: unknown, scale: number): { x: number; y: number; w: number; h: number } | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const x = finite(o.x);
  const y = finite(o.y);
  const w = finite(o.w);
  const h = finite(o.h);
  if (x === null || y === null || w === null || h === null || w < 0 || h < 0) return null;
  return { x: round1(x * scale), y: round1(y * scale), w: round1(w * scale), h: round1(h * scale) };
}

/**
 * The raw reading → ElementMeasurement[] in PAGE px (the canonical units elements are
 * stored in), or null when it is not a measurement at all. `pageWidth` is the page's
 * canonical width; the drawn width gives the scale. The server's parseMeasurements,
 * line for line, so the two sides round alike.
 */
export function parseMeasurements(raw: unknown, pageWidth: number): ElementMeasurement[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const drawnW = finite(o.pageW);
  if (drawnW === null || drawnW <= 0 || !Array.isArray(o.items)) return null;
  const scale = pageWidth > 0 ? pageWidth / drawnW : 1;
  const out: ElementMeasurement[] = [];
  for (const item of o.items) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : '';
    const box = rectFrom(r.box, scale);
    if (!id || !box) continue;
    const m: ElementMeasurement = { id, box };
    const cw = finite(r.contentW);
    const ch = finite(r.contentH);
    if (cw !== null && cw >= 0) m.contentW = round1(cw * scale);
    if (ch !== null && ch >= 0) m.contentH = round1(ch * scale);
    const ink = rectFrom(r.ink, scale);
    if (ink) m.ink = ink;
    if (typeof r.imgOk === 'boolean') m.imgOk = r.imgOk;
    out.push(m);
  }
  return out;
}

/** The smallest rect holding every non-empty rect, relative to (originX, originY);
 *  null when there is none. Rects are DOMRect-like (left/top/right/bottom). */
export function unionRect(
  rects: ArrayLike<{ left: number; top: number; right: number; bottom: number; width: number; height: number }>,
  originX: number,
  originY: number,
): { x: number; y: number; w: number; h: number } | null {
  let l = Infinity;
  let t = Infinity;
  let r = -Infinity;
  let b = -Infinity;
  for (let j = 0; j < rects.length; j++) {
    const q = rects[j]!;
    if (!(q.width > 0) || !(q.height > 0)) continue;
    if (q.left < l) l = q.left;
    if (q.top < t) t = q.top;
    if (q.right > r) r = q.right;
    if (q.bottom > b) b = q.bottom;
  }
  return r > l && b > t ? { x: l - originX, y: t - originY, w: r - l, h: b - t } : null;
}

const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'emoji', 'math', 'fangsong', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded']);

/**
 * A computed font-family list as a string `FontFaceSet.load` will parse: every named
 * family quoted (an unquoted "Source Sans 3" is not valid CSS — the 3 is not an
 * identifier — and one bad name makes the whole call throw), generic keywords bare.
 * Empty when nothing usable is left.
 */
export function cssFamilyList(family: string): string {
  return (family ?? '')
    .split(',')
    .map((f) => f.trim().replace(/^["']|["']$/g, '').trim())
    .filter((f) => f && f !== 'inherit' && f !== 'initial' && f !== 'unset')
    .map((f) => (GENERIC_FAMILIES.has(f.toLowerCase()) ? f.toLowerCase() : `"${f.replace(/["\\]/g, '')}"`))
    .join(', ');
}

/** One FontFaceSet.load request: the face, and the characters it must cover (a
 *  Google font is split by unicode-range, so "Māori" needs its latin-ext slice). */
export interface FontLoadSpec {
  font: string;
  text: string;
}

/** Most characters sent with one load request — enough to name every subset in use. */
const SAMPLE_CHARS = 200;

/**
 * Collapse (style, weight, family, sample text) readings into one load request per
 * face, each with the distinct characters drawn in it. Pure, so the browser half only
 * reads computed styles.
 */
export function fontLoadSpecs(readings: { style: string; weight: string; family: string; text: string }[]): FontLoadSpec[] {
  const byFont = new Map<string, Set<string>>();
  for (const r of readings) {
    const family = cssFamilyList(r.family);
    if (!family) continue;
    const style = r.style === 'italic' || r.style === 'oblique' ? 'italic' : 'normal';
    const weight = /^\d{3}$/.test((r.weight ?? '').trim()) ? r.weight.trim() : r.weight === 'bold' ? '700' : '400';
    const font = `${style} ${weight} 16px ${family}`;
    const chars = byFont.get(font) ?? new Set<string>();
    for (const ch of Array.from((r.text ?? '').replace(/\s+/g, ' '))) {
      if (chars.size >= SAMPLE_CHARS) break;
      chars.add(ch);
    }
    byFont.set(font, chars);
  }
  return [...byFont.entries()].map(([font, chars]) => ({ font, text: [...chars].join('') || ' ' }));
}

// ── Browser ──────────────────────────────────────────────────────────────────

/**
 * Read every element of a page drawn by IssuePageCanvas (`root` is its
 * `[data-magazine-page]` node), in CSS px of the drawing. Feed the result to
 * parseMeasurements. `imgSettled` says whether a picture has reached its final state
 * (loaded, or broken with no fallback left — bulletinPrint.imageSettled); a picture
 * still on its way is left unjudged rather than called broken.
 */
export function readMountedPage(root: HTMLElement, imgSettled?: (img: HTMLImageElement) => boolean): RawPage {
  const doc = root.ownerDocument;
  const view = doc.defaultView ?? window;
  const pr = root.getBoundingClientRect();
  const items: RawItem[] = [];
  const nodes = root.querySelectorAll<HTMLElement>('[data-el-id]');
  for (let i = 0; i < nodes.length && items.length < MAX_ITEMS; i++) {
    const el = nodes[i]!;
    const cs = view.getComputedStyle(el);
    const m: RawItem = {
      id: el.getAttribute('data-el-id') || '',
      box: { x: parseFloat(cs.left) || 0, y: parseFloat(cs.top) || 0, w: parseFloat(cs.width) || 0, h: parseFloat(cs.height) || 0 },
    };
    // A rotated box's client rects are its rotated bounds, not its lines: its copy's
    // own size still reads true from the scroll size, but its ink is left out.
    const rotated = !!cs.transform && cs.transform !== 'none';
    const text = el.querySelector<HTMLElement>('[data-el-text]');
    if (text) {
      const tr = text.getBoundingClientRect();
      m.contentW = Math.max(text.scrollWidth || 0, rotated ? 0 : tr.width);
      m.contentH = Math.max(text.scrollHeight || 0, rotated ? 0 : tr.height);
      if (!rotated) {
        const walker = doc.createTreeWalker(text, SHOW_TEXT);
        const range = doc.createRange();
        const rects: DOMRect[] = [];
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (!/\S/.test(n.nodeValue || '')) continue;
          range.selectNodeContents(n);
          const list = range.getClientRects();
          for (let j = 0; j < list.length; j++) rects.push(list[j]!);
        }
        const ink = unionRect(rects, pr.left, pr.top);
        if (ink) m.ink = ink;
      }
    }
    const img = el.querySelector('img');
    if (img && img.complete && (!imgSettled || imgSettled(img))) m.imgOk = img.naturalWidth > 0;
    items.push(m);
  }
  return { pageW: pr.width, pageH: pr.height, items };
}

/** The faces the drawn copy uses (every text block and the bold/italic runs inside
 *  it), as load requests. Computed styles, so 'inherit' resolves to the real face. */
export function drawnFontSpecs(root: HTMLElement): FontLoadSpec[] {
  const view = root.ownerDocument.defaultView ?? window;
  const readings: { style: string; weight: string; family: string; text: string }[] = [];
  root.querySelectorAll<HTMLElement>('[data-el-text]').forEach((block) => {
    const nodes: Element[] = [block, ...Array.from(block.querySelectorAll('*'))];
    for (const n of nodes) {
      const cs = view.getComputedStyle(n);
      readings.push({ style: cs.fontStyle, weight: cs.fontWeight, family: cs.fontFamily, text: n.textContent || '' });
    }
  });
  return fontLoadSpecs(readings);
}

/**
 * A TextProbe over a mounted page: lays an element's copy out again at another size,
 * wrapped in its own box width, and returns the height it needs in page px.
 *
 * The copy is a CLONE of the drawn content div (same face, weight, tracking, case and
 * line height, same inline markup), set in `scratch` — a sibling of the page that is
 * the page's own width and a size container, so the canvas's cqw units mean the same
 * px there. Each call forces one layout; pageCheckRules memoises per size.
 */
export function makeTextProbe(root: HTMLElement, scratch: HTMLElement, pageWidth: number): TextProbe {
  let byId: Map<string, HTMLElement> | null = null;
  const source = (id: string): HTMLElement | undefined => {
    if (!byId) {
      byId = new Map();
      root.querySelectorAll<HTMLElement>('[data-el-id]').forEach((box) => {
        const id = box.getAttribute('data-el-id');
        const text = box.querySelector<HTMLElement>('[data-el-text]');
        if (id && text && !byId!.has(id)) byId!.set(id, text);
      });
    }
    return byId.get(id);
  };
  return (el: MagazineElement, fontSize: number) => {
    const src = source(el.id);
    const W = pageWidth > 0 ? pageWidth : 0;
    if (!src || !(W > 0) || !(el.w > 0) || !(fontSize > 0)) return undefined;
    const drawnW = scratch.getBoundingClientRect().width;
    if (!(drawnW > 0)) return undefined;
    const doc = scratch.ownerDocument;
    const wrap = doc.createElement('div');
    wrap.style.cssText = `position:absolute;left:0;top:0;width:${(el.w / W) * 100}%;`;
    const clone = src.cloneNode(true) as HTMLElement;
    clone.removeAttribute('data-el-text');
    clone.style.width = '100%';
    clone.style.fontSize = `${(fontSize / W) * 100}cqw`;
    // Wrapped in its box — what any edit turns copied PDF text into.
    clone.style.whiteSpace = 'pre-wrap';
    clone.style.overflowWrap = 'break-word';
    wrap.appendChild(clone);
    scratch.appendChild(wrap);
    try {
      const h = Math.max(clone.scrollHeight || 0, clone.getBoundingClientRect().height);
      return h * (W / drawnW);
    } finally {
      wrap.remove();
    }
  };
}
