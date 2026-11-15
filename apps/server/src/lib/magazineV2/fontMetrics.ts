// ---------------------------------------------------------------------------
// Magazine Builder v2 — measured font metrics (the principled text-width model).
//
// This REPLACES the old `advanceRatio` jugaad in layout.ts, which classified
// fonts by pattern-matching their family NAME (`/oswald|condensed|bebas/…`) and
// added magic weight bumps (`+0.035` for bold). Here every number is a real
// glyph advance measured in headless Chromium with the actual font loaded (see
// scripts/measure-font-metrics.mjs); nothing is inferred from the font's name.
//
// The width of a run is the sum of its glyphs' measured advances (× font size ×
// the measured per-weight scale) plus letter-spacing — the same thing the
// browser does, minus kerning (which only ever makes real text NARROWER, so
// ignoring it keeps the estimate conservative → text never overflows its box).
//
// Family resolution mirrors the CSS cascade: walk the font-family stack and use
// the first family we have measured; only if none match do we fall back by the
// stack's OWN generic keyword (serif / sans-serif / …) to the widest measured
// font of that category — widest = conservative, so an unknown family still
// can't overflow. No name-based classification anywhere.
//
// Three cases are resolved to the face the browser really draws rather than to
// that conservative guess, because the guess was wrong for them in a known way:
//   'inherit' (or no family)  the element takes the font of the page around it —
//                             the app's body face, Source Sans 3 (theme.css), on the
//                             editor canvas, the public viewer and the PDF (which
//                             prints the real route). Measured as the widest sans
//                             (Archivo) it came out wider than it prints (about 5%
//                             on running text, 13% on the mean glyph), so every text
//                             box the Studio added was shrunk below what fitted.
//   monospace                 every glyph is the same width (0.6em) — a proportional
//                             sans measures "illicit" at half its real width, so
//                             monospace copy from an imported PDF would overflow.
//   metric twins              Liberation Serif / Tinos / "Times" share Times New
//                             Roman's advances, Liberation Sans / Arimo share Arial's,
//                             by design. They are the same widths, not a guess.
//
// Pure + server-safe: static data + arithmetic, no DOM, no LLM, no I/O.
// ---------------------------------------------------------------------------

import { FONT_METRICS, type FontMetricEntry, type FontMetricCategory } from './fontMetrics.data.js';

/**
 * The face a text element with no family of its own ('inherit', the model default)
 * is drawn in: the app's body font (apps/web/src/styles/theme.css `--font-body`).
 * Exported so the proof renderer and the Studio can give such an element the same
 * face explicitly instead of leaving it to whatever page it is drawn inside.
 */
export const HOST_BODY_FONT_STACK = "'Source Sans 3', Arial, sans-serif";

/** CSS-wide keywords: not a family at all. All but `initial` make an element take
 *  its parent's font; `initial` gives the browser's default face (Times New Roman). */
const INHERITING_KEYWORDS = new Set(['inherit', 'unset', 'revert', 'revert-layer']);

/** Families whose advance widths are identical to a measured face by design. */
const METRIC_TWINS: Record<string, string> = {
  times: 'times new roman',
  'liberation serif': 'times new roman',
  tinos: 'times new roman',
  'liberation sans': 'arial',
  arimo: 'arial',
};

/** Monospace faces: one advance for every glyph. Courier New / Liberation Mono are
 *  0.600em, DejaVu Sans Mono and Menlo 0.602em — the wider is used. */
const MONO_ADVANCE_EM = 0.602;
const MONO_FAMILIES = new Set(['courier new', 'courier', 'liberation mono', 'cousine']);
const GENERIC_MONO = new Set(['monospace', 'ui-monospace']);
/** An empty per-glyph table makes measureRunWidthPx use `base` for every ASCII glyph,
 *  which is exactly a fixed advance. */
const MONO_METRICS: FontMetricEntry = {
  category: 'mono',
  weights: [400, 700],
  adv: { '400': {}, '700': {} },
  base: { '400': MONO_ADVANCE_EM, '700': MONO_ADVANCE_EM },
};

/** A family's widest measured mean advance (across its weights) — used to rank
 *  fallbacks by "widest = most conservative". */
function maxBase(e: FontMetricEntry): number {
  let m = 0;
  for (const w of e.weights) m = Math.max(m, e.base[String(w)] ?? 0);
  return m;
}

/** The widest-mean-advance measured entry in a category — the conservative
 *  fallback (a wider estimate can only shrink text more, never overflow). */
function widestOf(category: FontMetricCategory): FontMetricEntry | undefined {
  let best: FontMetricEntry | undefined;
  for (const e of Object.values(FONT_METRICS)) {
    if (e.category === category && (!best || maxBase(e) > maxBase(best))) best = e;
  }
  return best;
}

/** Nearest measured weight to `weight` (exact if present). */
function nearestWeight(entry: FontMetricEntry, weight: number): number {
  let best = entry.weights[0] ?? 400;
  let bestDist = Infinity;
  for (const w of entry.weights) {
    const d = Math.abs(w - weight);
    if (d < bestDist) {
      bestDist = d;
      best = w;
    }
  }
  return best;
}

// Precomputed once. `sans` always exists (Arial/Inter/…); serif/script fall
// back to sans if a category were ever empty.
const FALLBACK_SANS = widestOf('sans')!;
const FALLBACK_SERIF = widestOf('serif') ?? FALLBACK_SANS;
const FALLBACK_SCRIPT = widestOf('script') ?? FALLBACK_SANS;

/** CSS generic-family keywords — never a real measured face; used only to pick
 *  a fallback bucket from the stack's own declaration. */
const GENERIC_SERIF = new Set(['serif', 'ui-serif']);
const GENERIC_SCRIPT = new Set(['cursive', 'fantasy']);

/** Split a CSS font-family value into normalised family names, in cascade order.
 *  Plain string ops (strip quotes/whitespace, lowercase) — not classification. */
function splitStack(fontFamily: string): string[] {
  return fontFamily
    .split(',')
    .map((s) => s.split("'").join('').split('"').join('').trim().toLowerCase())
    .filter(Boolean);
}

/** The measured family a font-family value is measured as (its key in FONT_METRICS, or
 *  'monospace'), and how it got there — so a test or a report can say "measured as …". */
export function fontMetricsKey(fontFamily: string | undefined): {
  key: string;
  via: 'named' | 'twin' | 'host' | 'generic' | 'fallback';
} {
  const parts = splitStack(fontFamily ?? '');
  // The cascade: the first family the browser could draw that we can measure.
  for (const p of parts) {
    if (FONT_METRICS[p]) return { key: p, via: 'named' };
    const twin = METRIC_TWINS[p];
    if (twin && FONT_METRICS[twin]) return { key: twin, via: 'twin' };
    if (MONO_FAMILIES.has(p)) return { key: 'monospace', via: 'named' };
  }
  // No family at all, or only an inheriting keyword: the element is drawn in the face
  // of the page around it.
  const named = parts.filter((p) => !INHERITING_KEYWORDS.has(p) && p !== 'initial');
  if (named.length === 0) {
    if (parts.includes('initial') && FONT_METRICS['times new roman']) return { key: 'times new roman', via: 'generic' };
    return { key: hostBodyKey(), via: 'host' };
  }
  for (const p of parts) {
    if (GENERIC_MONO.has(p)) return { key: 'monospace', via: 'generic' };
    if (GENERIC_SERIF.has(p)) return { key: keyOf(FALLBACK_SERIF), via: 'generic' };
    if (GENERIC_SCRIPT.has(p)) return { key: keyOf(FALLBACK_SCRIPT), via: 'generic' };
  }
  // 'sans-serif' / 'system-ui' / a family we have never measured → the widest sans.
  // An unmeasured named face may be a wide system font on the reader's machine
  // (Verdana, Tahoma), so this stays deliberately conservative.
  return { key: keyOf(FALLBACK_SANS), via: parts.includes('sans-serif') ? 'generic' : 'fallback' };
}

function keyOf(entry: FontMetricEntry): string {
  for (const [k, v] of Object.entries(FONT_METRICS)) if (v === entry) return k;
  return '';
}

/** FONT_METRICS key of the host body face (its first family; widest sans if it were
 *  ever missing from the measured table). */
function hostBodyKey(): string {
  const first = splitStack(HOST_BODY_FONT_STACK)[0] ?? '';
  return FONT_METRICS[first] ? first : keyOf(FALLBACK_SANS);
}

// Every glyph run measured goes through resolveFontMetrics (once per word per trial
// size), and a page has only a handful of distinct stacks — so resolution is memoised.
const RESOLVED = new Map<string, FontMetricEntry>();

/**
 * Resolve a CSS font-family value to a measured metric entry, honouring the
 * cascade: the first named family we have measured (or its metric twin) wins;
 * no family / 'inherit' is the host page's body face; otherwise the stack's
 * trailing generic keyword picks a conservative same-category fallback.
 */
export function resolveFontMetrics(fontFamily: string | undefined): FontMetricEntry {
  const stack = fontFamily ?? '';
  const hit = RESOLVED.get(stack);
  if (hit) return hit;
  const { key } = fontMetricsKey(stack);
  const entry = key === 'monospace' ? MONO_METRICS : (FONT_METRICS[key] ?? FALLBACK_SANS);
  if (RESOLVED.size > 256) RESOLVED.clear();
  RESOLVED.set(stack, entry);
  return entry;
}

/** East-Asian WIDE / full-width code points (CJK, kana, Hangul, full-width
 *  forms, emoji): these render ~1em, far wider than a Latin mean advance, so
 *  they must NOT fall back to `base` or the line width is under-counted. */
function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals … symbols/punctuation
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana, Katakana, CJK compat
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compat forms
    (cp >= 0xff00 && cp <= 0xff60) || // Full-width forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Full-width signs
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji & pictographs
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+ (supplementary)
  );
}

/** Conservative advance for a glyph OUTSIDE the measured ASCII table. Wide
 *  scripts and the common editorial punctuation that renders ~1em (em-dash,
 *  ellipsis, horizontal bar) get ~1em so they can never be under-counted;
 *  accented Latin, quotes and en-dash render ≈ their base letter, for which the
 *  weight mean `base` is already a safe over-estimate. Never returns < base. */
function unmeasuredAdvance(cp: number, base: number): number {
  if (isWideCodePoint(cp)) return Math.max(base, 1.0);
  if (cp === 0x2014 /* — em dash */ || cp === 0x2015 /* ― horizontal bar */ || cp === 0x2026 /* … ellipsis */) return Math.max(base, 1.0);
  return base;
}

/**
 * Width (px) of `text` laid out on a SINGLE line — the sum of measured glyph
 * advances (at the nearest measured weight) × font size, plus letter-spacing.
 * Glyphs outside the measured ASCII table are estimated CONSERVATIVELY by
 * Unicode range (see unmeasuredAdvance): wide/full-width and em-dash/ellipsis
 * get ~1em so they're never under-counted, other non-ASCII keeps the weight
 * mean. Conservative by construction (ignores kerning, which only narrows real
 * text), so a fit derived from it never overflows — including for non-ASCII.
 */
export function measureRunWidthPx(
  text: string,
  fontFamily: string | undefined,
  fontWeight: number,
  fontSizePx: number,
  letterSpacing = 0,
): number {
  const entry = resolveFontMetrics(fontFamily);
  const w = String(nearestWeight(entry, fontWeight));
  const adv = entry.adv[w] ?? {};
  const base = entry.base[w] ?? 0.6;
  let em = 0;
  let count = 0;
  for (const ch of text) {
    const measured = adv[ch];
    if (measured !== undefined) em += measured;
    else {
      const cp = ch.codePointAt(0) ?? 0;
      em += cp < 0x80 ? base : unmeasuredAdvance(cp, base);
    }
    count += 1;
  }
  return em * fontSizePx + Math.max(0, letterSpacing) * count;
}
