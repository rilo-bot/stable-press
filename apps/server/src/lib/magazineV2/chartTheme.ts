// ---------------------------------------------------------------------------
// Magazine Builder v2 — the LOOK a chart is drawn in.
//
// A chart dropped into a magazine has to look as if the magazine's own designer drew
// it: the issue's colours, the issue's faces. Two sources, in order:
//
//   1. the issue's `genTheme` (generated magazines: the palette and fonts the Creative
//      Director chose, stored on the issue at generation time — GenPalette/GenFonts in
//      templates.ts);
//   2. otherwise the page itself (imported PDFs, copied pages, magazines older than
//      genTheme): the commonest body face, the ink most words are set in, and the
//      coloured fills the page already uses. Read, not invented — applying a chart must
//      not repaint a page in colours it never had (the same rule themeForPage in
//      applyLayout.ts follows).
//
// LEGIBILITY IS NOT OPTIONAL. Every series colour is held to 3:1 against the chart's
// ground (WCAG's bar for graphical objects); a palette colour that fails is DARKENED
// (or lightened, on a dark ground) in steps until it passes, so its hue survives. Text
// is held to 4.5:1. A chart nobody can read is worse than no chart.
//
// Pure: no db, no I/O, deterministic.
// ---------------------------------------------------------------------------

import type { MagazineElement } from './model.js';
import { contrastRatio, relativeLuminance } from './layout.js';

export interface ChartTheme {
  /** Series / slice colours in order; each readable (>= 3:1) on `bg`, no two alike. */
  colors: string[];
  /** The highlight colour (spec.highlight) — distinct from colors[0]. */
  accent: string;
  /** Titles, labels, the zero line. >= 4.5:1 on `bg`. */
  text: string;
  /** Secondary text: axis ticks, subtitle, source. >= 4.5:1 on `bg`. */
  muted: string;
  /** Gridlines — quiet on purpose. */
  grid: string;
  /** The chart's ground (it is drawn as an opaque card, so it reads over anything). */
  bg: string;
  /** Alternate-row fill for tables. */
  stripe: string;
  /** CSS font-family stacks. */
  fontBody: string;
  fontDisplay: string;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

const DEFAULT_BODY = 'Inter, Arial, sans-serif';
const DEFAULT_DISPLAY = 'Playfair Display, Georgia, serif';
/** Editorial defaults for a page that offers no colour of its own: navy, racing red,
 *  green, gold, plum, teal, brown, slate. */
const DEFAULT_SERIES = ['#1f4e79', '#c8102e', '#2e7d5b', '#b7791f', '#6b3fa0', '#00838f', '#7a4a2a', '#455a64'];

/** Series colours a chart can use at most (pie slices are capped at 8). */
const MAX_COLORS = 8;
/** Two colours closer than this (RGB distance) read as the same series. */
const SAME_COLOR = 48;

function hexOr(v: unknown, fallback: string): string {
  return typeof v === 'string' && HEX.test(v.trim()) ? v.trim().toLowerCase() : fallback;
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function toHex([r, g, b]: [number, number, number]): string {
  const c = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** `a` moved toward `b` by `t` (0 = a, 1 = b). */
export function mixColor(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

function distance(a: string, b: string): number {
  const x = rgb(a);
  const y = rgb(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/** HSL-style saturation, 0–1: how much of a COLOUR this is, as opposed to a grey. */
function saturation(hex: string): number {
  const [r, g, b] = rgb(hex).map((n) => n / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const l = (max + min) / 2;
  return l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
}

/**
 * `color`, or the nearest version of it that reaches `min` contrast on `bg`: mixed
 * toward black on a light ground (toward white on a dark one) in 5% steps. Keeps the
 * hue, which swapping to plain black or white (readableColor) would throw away.
 */
export function ensureContrast(color: string, bg: string, min: number): string {
  if (contrastRatio(color, bg) >= min) return color;
  const toward = relativeLuminance(bg) > 0.4 ? '#000000' : '#ffffff';
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const c = mixColor(color, toward, t);
    if (contrastRatio(c, bg) >= min) return c;
  }
  return toward;
}

/** The first family of a CSS font stack, or the default when the stack is unusable. */
function cleanStack(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  const s = v.trim();
  // Font-family characters only: a stack goes into an SVG attribute and a font URL.
  if (!s || s.length > 160 || !/^[A-Za-z0-9 ,'"_-]+$/.test(s)) return fallback;
  const first = s.split(',')[0]!.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
  if (!first || first === 'inherit' || first === 'initial' || first === 'unset') return fallback;
  return s;
}

interface GenThemeLike {
  palette?: Partial<Record<'primary' | 'secondary' | 'accent' | 'bg' | 'text', unknown>>;
  fonts?: Partial<Record<'display' | 'body', unknown>>;
}

function readGenTheme(genTheme: unknown): GenThemeLike {
  if (!genTheme || typeof genTheme !== 'object') return {};
  const g = genTheme as Record<string, unknown>;
  return {
    palette: g.palette && typeof g.palette === 'object' ? (g.palette as GenThemeLike['palette']) : undefined,
    fonts: g.fonts && typeof g.fonts === 'object' ? (g.fonts as GenThemeLike['fonts']) : undefined,
  };
}

/** Values tallied by count, most first; ties broken by the value itself so the order
 *  never depends on element order. */
function ranked(tally: Map<string, number>): string[] {
  return [...tally.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k]) => k);
}

/**
 * The chart's look for this issue and page.
 *
 * `opts.background` is the page's own background, when the caller has it: the chart
 * is drawn on a card in the page's ground colour so it sits on the page rather than
 * on a white rectangle, wherever it is placed.
 */
export function chartTheme(
  genTheme: unknown,
  elements: MagazineElement[],
  opts: { background?: { type: string; value: string } } = {},
): ChartTheme {
  const gt = readGenTheme(genTheme);
  const p = gt.palette ?? {};
  const f = gt.fonts ?? {};
  const texts = elements.filter((e) => e.type === 'text' && e.text);

  // ── ground ──
  const pageBg = opts.background?.type === 'color' ? hexOr(opts.background.value, '') : '';
  const bg = pageBg || hexOr(p.bg, '#ffffff');

  // ── ink: the colour most words are set in that READS on this ground ──
  const inkTally = new Map<string, number>();
  for (const t of texts) {
    const c = hexOr(t.text?.color, '');
    if (c) inkTally.set(c, (inkTally.get(c) ?? 0) + Math.max(1, (t.text?.content ?? '').length));
  }
  const readableInk = ranked(inkTally).find((c) => contrastRatio(c, bg) >= 4.5);
  const fallbackInk = relativeLuminance(bg) > 0.4 ? '#1a1a1a' : '#f5f5f5';
  const text = ensureContrast(hexOr(p.text, readableInk ?? fallbackInk), bg, 4.5);

  // ── colour: the issue's palette, else the coloured fills the page already uses ──
  const fillTally = new Map<string, number>();
  for (const e of elements) {
    if (e.type !== 'shape' || !e.shape) continue;
    if (typeof e.shape.opacity === 'number' && e.shape.opacity < 0.9) continue; // a scrim, not a colour
    const c = hexOr(e.shape.fill, '');
    if (c && saturation(c) >= 0.2) fillTally.set(c, (fillTally.get(c) ?? 0) + 1);
  }
  // A coloured kicker or pull-quote is the page's accent when it has no coloured fill.
  const inkColours = ranked(inkTally).filter((c) => saturation(c) >= 0.25);
  const derived = [...ranked(fillTally), ...inkColours.filter((c) => !fillTally.has(c))];

  const primary = hexOr(p.primary, derived[0] ?? DEFAULT_SERIES[0]!);
  const accent = hexOr(p.accent, derived[1] ?? DEFAULT_SERIES[1]!);
  const secondary = hexOr(p.secondary, derived[2] ?? DEFAULT_SERIES[2]!);

  // Shades (toward the ink end) and tints (toward the ground) of the three, then the
  // editorial defaults, each pushed to 3:1 and de-duplicated: the palette's own colours
  // come first, in palette order, and the chart never runs out of distinct series.
  const darkEnd = relativeLuminance(bg) > 0.4 ? '#000000' : '#ffffff';
  const candidates = [
    primary,
    accent,
    secondary,
    mixColor(primary, darkEnd, 0.35),
    mixColor(accent, darkEnd, 0.35),
    mixColor(secondary, darkEnd, 0.35),
    mixColor(primary, bg, 0.4),
    mixColor(accent, bg, 0.4),
    mixColor(secondary, bg, 0.4),
    ...DEFAULT_SERIES,
  ];
  const colors: string[] = [];
  for (const c of candidates) {
    const usable = ensureContrast(c, bg, 3);
    if (colors.every((k) => distance(k, usable) >= SAME_COLOR)) colors.push(usable);
    if (colors.length >= MAX_COLORS) break;
  }
  // Never fewer than MAX_COLORS, even on a ground that collapses the candidates together.
  for (let i = 0; colors.length < MAX_COLORS; i++) colors.push(colors[i % Math.max(1, colors.length)] ?? text);

  // The highlight must stand apart from the bars it highlights.
  const accentUsable = ensureContrast(accent, bg, 3);
  const highlight = distance(accentUsable, colors[0]!) >= SAME_COLOR ? accentUsable : colors[1]!;

  // ── faces ──
  const familyTally = new Map<string, number>();
  const bodyTally = new Map<string, number>();
  for (const t of texts) {
    const fam = cleanStack(t.text?.fontFamily, '');
    if (!fam) continue;
    familyTally.set(fam, (familyTally.get(fam) ?? 0) + 1);
    if (t.text?.role === 'body') bodyTally.set(fam, (bodyTally.get(fam) ?? 0) + 1);
  }
  const headline = [...texts]
    .filter((t) => cleanStack(t.text?.fontFamily, ''))
    .sort((a, b) => (b.text?.role === 'headline' ? 1 : 0) - (a.text?.role === 'headline' ? 1 : 0) || (b.text?.fontSize ?? 0) - (a.text?.fontSize ?? 0))[0];
  const fontBody = cleanStack(f.body, ranked(bodyTally)[0] ?? ranked(familyTally)[0] ?? DEFAULT_BODY);
  // A page with type of its own titles the chart in its own headline face (or its body
  // face); only a page with no text at all falls back to the editorial default.
  const pageDisplay = headline ? cleanStack(headline.text?.fontFamily, '') : '';
  const fontDisplay = cleanStack(f.display, pageDisplay || (familyTally.size ? fontBody : DEFAULT_DISPLAY));

  return {
    colors,
    accent: highlight,
    text,
    muted: ensureContrast(mixColor(text, bg, 0.3), bg, 4.5),
    grid: mixColor(text, bg, 0.84),
    bg,
    stripe: mixColor(text, bg, 0.95),
    fontBody,
    fontDisplay,
  };
}
