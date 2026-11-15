// ---------------------------------------------------------------------------
// Magazine Builder v2 — draw a chart spec as SVG, deterministically.
//
// The numbers decide the geometry; nothing is imagined. A bar is exactly as tall as
// its value on a "nice" axis (0, 5, 10 …), a pie slice's angle is exactly its share
// of 360°, a table prints the figures as given. That is the whole reason charts are
// drawn here and not by the image model (see chartSpec.ts).
//
// Layout rules worth knowing:
//   • The viewBox IS the box: width × height in page px, so the PNG placed with
//     fit 'contain' fills its box with no letterbox, and label sizes are page px —
//     the same scale as the page's own type.
//   • Every label is measured with the measured glyph advances (fontMetrics.ts) plus
//     a 10% safety margin, and margins are sized from those measurements. A label too
//     wide for its slot is shrunk a little, then ellipsized (or every k-th label is
//     shown, when ellipsis would leave nothing readable) — which is why barh exists
//     for long names like horses and owners.
//   • The chart is an opaque card in the theme's ground colour, so it reads wherever
//     it lands (over a panel, over a photo).
//   • Every string from the spec is XML-escaped. The SVG is only ever RASTERISED
//     (charts.ts → PNG); it is never stored or served as SVG, consistent with
//     imageBytes.ts refusing SVG as a media type.
//   • Deterministic: no Date, no randomness, every coordinate rounded to 0.01px, so the
//     same spec gives a byte-identical SVG (and the test pins that).
//
// Pure: no db, no browser, no network.
// ---------------------------------------------------------------------------

import { chartDecimals, compactChartValue, formatChartValue, sameLabel, type ChartSpec } from './chartSpec.js';
import type { ChartTheme } from './chartTheme.js';
import { measureRunWidthPx } from './fontMetrics.js';
import { contrastRatio } from './layout.js';

/** Measured widths are padded by this much: real text must never be wider than its slot. */
const SAFETY = 1.1;

// ── small pure helpers (exported for the tests) ─────────────────────────────

/**
 * XML-escape a string for text or an attribute. `=` is encoded too: the rasteriser's
 * defence-in-depth pass (renderPreview.stripActiveSvg) strips anything shaped like
 * ` onerror=…` from the raw markup, and a label such as "x onerror=y" must neither be
 * mangled by it nor be able to cut an attribute's closing quote away.
 */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/=/g, '&#61;');
}

/** Fixed precision for coordinates — what makes the output byte-identical. */
function n(v: number): string {
  const r = Math.round(v * 100) / 100;
  return String(Object.is(r, -0) ? 0 : r);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface Font {
  family: string;
  weight: number;
  size: number;
}

function textW(s: string, f: Font): number {
  return measureRunWidthPx(s, f.family, f.weight, f.size) * SAFETY;
}

/** `s`, or the longest prefix of it plus an ellipsis that fits `maxW`. */
export function ellipsize(s: string, maxW: number, f: Font): string {
  if (textW(s, f) <= maxW) return s;
  const chars = Array.from(s);
  let lo = 0;
  let hi = chars.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textW(`${chars.slice(0, mid).join('').trimEnd()}…`, f) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  if (lo === 0) return textW('…', f) <= maxW ? '…' : '';
  return `${chars.slice(0, lo).join('').trimEnd()}…`;
}

/** Greedy word wrap into at most `maxLines`; the last line is ellipsized if the text runs on. */
export function wrapText(s: string, maxW: number, f: Font, maxLines: number): string[] {
  const words = s.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const cand = cur ? `${cur} ${w}` : w;
    if (!cur || textW(cand, f) <= maxW) cur = cand;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    // The tail is at least two wrapped lines joined, so it is always wider than the
    // line and always ends in an ellipsis: a cut title is visibly cut.
    const kept = lines.slice(0, maxLines - 1);
    kept.push(lines.slice(maxLines - 1).join(' '));
    return kept.map((l) => ellipsize(l, maxW, f));
  }
  // A single word wider than the line is ellipsized rather than overflowing.
  return lines.map((l) => ellipsize(l, maxW, f));
}

function niceNum(range: number, round: boolean): number {
  const exp = Math.floor(Math.log10(range));
  const f = range / 10 ** exp;
  const nf = round ? (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) : f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * 10 ** exp;
}

/** Decimal places needed to write `v` exactly (to 6 places). */
function placesOf(v: number): number {
  const s = Math.abs(v).toFixed(6).replace(/0+$/, '');
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/**
 * Round axis ticks covering [min, max] (Heckbert's "nice numbers"): steps of 1, 2 or 5
 * × 10^k, the axis widened to whole steps. A flat or empty range is opened up so there
 * is always an axis to draw.
 */
export function niceTicks(min: number, max: number, count = 5): { min: number; max: number; step: number; ticks: number[] } {
  let lo = Number.isFinite(min) ? min : 0;
  let hi = Number.isFinite(max) ? max : 0;
  if (lo > hi) [lo, hi] = [hi, lo];
  if (lo === hi) {
    if (lo === 0) hi = 1;
    else if (lo > 0) lo = 0;
    else hi = 0;
  }
  const range = niceNum(hi - lo, false);
  const step = niceNum(range / Math.max(1, count - 1), true);
  const places = placesOf(step);
  const fix = (v: number) => Number(v.toFixed(places));
  const nmin = fix(Math.floor(lo / step + 1e-9) * step);
  const nmax = fix(Math.ceil(hi / step - 1e-9) * step);
  const ticks: number[] = [];
  for (let i = 0; i <= Math.round((nmax - nmin) / step); i++) ticks.push(fix(nmin + i * step));
  return { min: nmin, max: nmax, step, ticks };
}

// ── the drawing surface ─────────────────────────────────────────────────────

class Svg {
  readonly parts: string[] = [];
  readonly families = new Set<string>();
  rect(x: number, y: number, w: number, h: number, fill: string, extra = ''): void {
    this.parts.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(Math.max(0, w))}" height="${n(Math.max(0, h))}" fill="${fill}"${extra}/>`);
  }
  line(x1: number, y1: number, x2: number, y2: number, stroke: string, width: number, extra = ''): void {
    this.parts.push(`<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${stroke}" stroke-width="${n(width)}"${extra}/>`);
  }
  path(d: string, fill: string, extra = ''): void {
    this.parts.push(`<path d="${d}" fill="${fill}"${extra}/>`);
  }
  circle(cx: number, cy: number, r: number, fill: string, extra = ''): void {
    this.parts.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="${fill}"${extra}/>`);
  }
  text(x: number, y: number, s: string, f: Font, fill: string, anchor: 'start' | 'middle' | 'end' = 'start', extra = ''): void {
    if (!s) return;
    this.families.add(f.family);
    this.parts.push(
      `<text x="${n(x)}" y="${n(y)}" font-family="${escapeXml(f.family)}" font-size="${n(f.size)}" font-weight="${f.weight}" fill="${fill}" text-anchor="${anchor}"${extra}>${escapeXml(s)}</text>`,
    );
  }
}

/** Black or white ink, whichever reads better on `fill` (labels inside bars and slices). */
function inkOn(fill: string, theme: ChartTheme): string {
  const light = contrastRatio(theme.bg, fill) >= contrastRatio(theme.text, fill) ? theme.bg : theme.text;
  if (contrastRatio(light, fill) >= 4.5) return light;
  return contrastRatio('#ffffff', fill) >= contrastRatio('#111111', fill) ? '#ffffff' : '#111111';
}

/** The first family of a CSS stack, unquoted: the name a font URL wants. */
function firstFamily(stack: string): string {
  return (stack.split(',')[0] ?? '').trim().replace(/^['"]|['"]$/g, '').trim();
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Sizes {
  label: number;
  value: number;
  title: number;
  subtitle: number;
  small: number;
  pad: number;
  gap: number;
}

/** Type sizes scale with the box, inside print-legible bounds (12px is ~5.8pt at 150dpi). */
function sizesFor(W: number, H: number): Sizes {
  const unit = Math.min(W, H * 1.5);
  const label = clamp(Math.round(unit * 0.021), 13, 24);
  return {
    label,
    value: Math.max(12, Math.round(label * 0.95)),
    title: clamp(Math.round(label * 1.55), 18, 38),
    subtitle: Math.max(13, Math.round(label * 0.95)),
    small: Math.max(12, Math.round(label * 0.82)),
    pad: Math.max(8, Math.round(unit * 0.035)),
    gap: Math.max(6, Math.round(label * 0.5)),
  };
}

interface Ctx {
  spec: ChartSpec;
  theme: ChartTheme;
  svg: Svg;
  W: number;
  H: number;
  fs: Sizes;
  body: (size: number, weight?: number) => Font;
  display: (size: number, weight?: number) => Font;
}

/** Category labels that fit their slots: shrink a little, then ellipsize, or show every k-th. */
function fitCategoryLabels(labels: string[], slotW: number, base: Font): { font: Font; text: string[]; show: boolean[] } {
  const avail = Math.max(4, slotW * 0.94);
  const minSize = Math.max(11, Math.round(base.size * 0.75));
  let font = base;
  const widest = (f: Font) => labels.reduce((m, l) => Math.max(m, textW(l, f)), 0);
  while (font.size > minSize && widest(font) > avail) font = { ...font, size: font.size - 1 };
  if (widest(font) <= avail) return { font, text: labels, show: labels.map(() => true) };
  const ell = labels.map((l) => ellipsize(l, avail, font));
  const unreadable = ell.some((e, i) => e !== labels[i] && Array.from(e).length < 4);
  if (!unreadable || labels.length <= 3) return { font, text: ell, show: labels.map(() => true) };
  const k = Math.ceil(widest(font) / avail);
  return { font, text: labels.map((l) => ellipsize(l, avail * k * 0.96, font)), show: labels.map((_, i) => i % k === 0) };
}

/** The value labels, all in one format and one size so they read as a set — or none. */
function fitValueLabels(values: number[], maxW: number, ctx: Ctx): { font: Font; text: string[] } | null {
  const full = values.map((v) => formatChartValue(v, ctx.spec));
  const compact = values.map((v) => compactChartValue(v, ctx.spec));
  for (let size = ctx.fs.value; size >= 10; size--) {
    const f = ctx.body(size, 600);
    if (full.every((t) => textW(t, f) <= maxW)) return { font: f, text: full };
    if (compact.every((t) => textW(t, f) <= maxW)) return { font: f, text: compact };
  }
  return null;
}

/** Tick label text: the data's own unit, compact when the numbers are large. */
function tickLabel(v: number, step: number, maxAbs: number, spec: ChartSpec): string {
  if (maxAbs >= 1e5) return compactChartValue(v, spec);
  return formatChartValue(v, spec, Math.min(2, placesOf(step)));
}

function showValuesFor(spec: ChartSpec, marks: number, auto: number): boolean {
  return typeof spec.showValues === 'boolean' ? spec.showValues : marks <= auto;
}

function isHighlighted(spec: ChartSpec, cat: string): boolean {
  return typeof spec.highlight === 'string' && sameLabel(spec.highlight, cat);
}

/** A series' fill: one series uses the first colour (the highlight in the accent);
 *  several series cycle through the palette. */
function fillFor(ctx: Ctx, s: number, cat: string): string {
  if (ctx.spec.series.length === 1) return isHighlighted(ctx.spec, cat) ? ctx.theme.accent : ctx.theme.colors[0]!;
  return ctx.theme.colors[s % ctx.theme.colors.length]!;
}

function dataAttrs(cat: string, series: string, value: number): string {
  return ` data-cat="${escapeXml(cat)}" data-series="${escapeXml(series)}" data-value="${value}"`;
}

/** The value range a bar chart has to show (stacks summed per category, signs apart). */
function barExtent(spec: ChartSpec): { min: number; max: number } {
  let min = 0;
  let max = 0;
  if (spec.stacked) {
    spec.categories.forEach((_, i) => {
      let pos = 0;
      let neg = 0;
      for (const s of spec.series) {
        const v = s.values[i]!;
        if (v >= 0) pos += v;
        else neg += v;
      }
      max = Math.max(max, pos);
      min = Math.min(min, neg);
    });
  } else {
    for (const s of spec.series) for (const v of s.values) {
      max = Math.max(max, v);
      min = Math.min(min, v);
    }
  }
  return { min, max };
}

// ── header, legend, footer ───────────────────────────────────────────────────

/** Title, subtitle and (several series) legend. Returns the y where the plot may start. */
function drawHeader(ctx: Ctx): number {
  const { spec, svg, fs, theme, W } = ctx;
  const innerW = W - 2 * fs.pad;
  let y = fs.pad;
  if (spec.title) {
    const f = ctx.display(fs.title, 700);
    for (const line of wrapText(spec.title, innerW, f, 2)) {
      svg.text(fs.pad, y + f.size * 0.95, line, f, theme.text);
      y += f.size * 1.2;
    }
  }
  if (spec.subtitle) {
    const f = ctx.body(fs.subtitle, 400);
    for (const line of wrapText(spec.subtitle, innerW, f, 2)) {
      svg.text(fs.pad, y + f.size * 0.95, line, f, theme.muted);
      y += f.size * 1.3;
    }
  }
  const legendTypes = spec.type === 'bar' || spec.type === 'barh' || spec.type === 'line';
  if (legendTypes && spec.series.length > 1) {
    if (spec.title || spec.subtitle) y += fs.gap * 0.6;
    const f = ctx.body(fs.small, 400);
    const sw = Math.round(f.size * 0.8);
    const rowH = f.size * 1.5;
    let x = fs.pad;
    let rowTop = y;
    spec.series.forEach((s, i) => {
      const label = ellipsize(s.name, innerW - sw - 8, f);
      const itemW = sw + 8 + textW(label, f) + fs.gap * 2;
      if (x > fs.pad && x + itemW > W - fs.pad) {
        x = fs.pad;
        rowTop += rowH;
      }
      const colour = theme.colors[i % theme.colors.length]!;
      if (spec.type === 'line') svg.rect(x, rowTop + rowH / 2 - 1.5, sw, 3, colour);
      else svg.rect(x, rowTop + (rowH - sw) / 2, sw, sw, colour);
      svg.text(x + sw + 8, rowTop + rowH / 2 + f.size * 0.35, label, f, theme.text);
      x += itemW;
    });
    y = rowTop + rowH;
  }
  return y > fs.pad ? y + fs.gap : y;
}

/** The source line. Returns the height it takes at the bottom. */
function drawFooter(ctx: Ctx): number {
  const { spec, svg, fs, theme, W, H } = ctx;
  if (!spec.source) return 0;
  const f = ctx.body(fs.small, 400);
  const text = /^source\b/i.test(spec.source) ? spec.source : `Source: ${spec.source}`;
  svg.text(fs.pad, H - fs.pad - f.size * 0.25, ellipsize(text, W - 2 * fs.pad, f), f, theme.muted);
  return f.size * 1.5;
}

// ── vertical bars and lines share an axis ───────────────────────────────────

interface YAxis {
  area: Box;
  yOf: (v: number) => number;
  ticks: ReturnType<typeof niceTicks>;
}

interface YAxisPlan {
  ticks: ReturnType<typeof niceTicks>;
  labels: string[];
  labelW: number;
  tf: Font;
}

/** The value axis's ticks and the width of its label column — known before anything is
 *  drawn, so the category slots beside it can be measured exactly. */
function planYAxis(ctx: Ctx, plot: Box, min: number, max: number): YAxisPlan {
  const { spec, fs } = ctx;
  const target = clamp(Math.floor(plot.h / (fs.label * 2.6)), 2, 6);
  const ticks = niceTicks(min, max, target);
  const maxAbs = Math.max(Math.abs(ticks.min), Math.abs(ticks.max));
  const tf = ctx.body(fs.small, 400);
  const labels = ticks.ticks.map((t) => tickLabel(t, ticks.step, maxAbs, spec));
  const labelW = labels.reduce((m, l) => Math.max(m, textW(l, tf)), 0);
  return { ticks, labels, labelW, tf };
}

/**
 * The value axis on the left, its gridlines, and the plot area beside it. `headroom`
 * is kept free above the top of the axis (value labels over the tallest bar),
 * `footroom` below it (value labels under the deepest negative bar).
 */
function drawYAxis(ctx: Ctx, plot: Box, plan: YAxisPlan, bottomBand: number, headroom: number, footroom: number): YAxis {
  const { svg, fs, theme } = ctx;
  const { ticks, labels, labelW, tf } = plan;
  const area: Box = {
    x: plot.x + labelW + fs.gap,
    y: plot.y + Math.max(headroom, tf.size * 0.6),
    w: 0,
    h: 0,
  };
  area.w = Math.max(10, plot.x + plot.w - area.x);
  area.h = Math.max(10, plot.y + plot.h - bottomBand - footroom - area.y);
  const span = ticks.max - ticks.min || 1;
  const yOf = (v: number) => area.y + ((ticks.max - v) / span) * area.h;
  ticks.ticks.forEach((t, i) => {
    const y = yOf(t);
    if (t !== 0) svg.line(area.x, y, area.x + area.w, y, theme.grid, 1);
    svg.text(area.x - fs.gap, y + tf.size * 0.35, labels[i]!, tf, theme.muted, 'end');
  });
  return { area, yOf, ticks };
}

function drawBars(ctx: Ctx, plot: Box): void {
  const { spec, svg, fs, theme } = ctx;
  const N = spec.categories.length;
  const S = spec.series.length;
  const stacked = !!spec.stacked;
  const ext = barExtent(spec);

  // The axis column's width is known first, so each category's slot is exact and the
  // labels are fitted to it.
  const plan = planYAxis(ctx, plot, ext.min, ext.max);
  const slot = Math.max(1, (plot.w - plan.labelW - fs.gap) / N);
  const cats = fitCategoryLabels(spec.categories, slot, ctx.body(fs.label, 400));
  const bottomBand = cats.font.size * 1.25 + fs.gap;

  const groupShare = S > 1 && !stacked ? 0.8 : 0.62;
  const gW = slot * groupShare;
  const bW = stacked || S === 1 ? gW : gW / S;
  const marks = stacked ? N : N * S;
  const allValues = stacked
    ? spec.categories.map((_, i) => spec.series.reduce((a, s) => a + s.values[i]!, 0))
    : spec.series.flatMap((s) => s.values);
  const show = showValuesFor(spec, marks, 16);
  const vals = show ? fitValueLabels(allValues, stacked || S === 1 ? slot * 0.96 : bW * 1.15, ctx) : null;
  const headroom = vals ? vals.font.size * 1.45 : 0;
  const footroom = vals && ext.min < 0 ? vals.font.size * 1.45 : 0;

  const { area, yOf } = drawYAxis(ctx, plot, plan, bottomBand, headroom, footroom);
  const inset = S > 1 && !stacked ? Math.min(2, bW * 0.1) : 0;
  const zeroY = yOf(0);

  spec.categories.forEach((cat, i) => {
    const cx = area.x + (i + 0.5) * slot;
    if (stacked) {
      let pos = 0;
      let neg = 0;
      spec.series.forEach((s, si) => {
        const v = s.values[i]!;
        const base = v >= 0 ? pos : neg;
        const y1 = yOf(base);
        const y2 = yOf(base + v);
        const fill = fillFor(ctx, si, cat);
        svg.rect(cx - gW / 2, Math.min(y1, y2), gW, Math.abs(y2 - y1), fill, ` class="bar"${dataAttrs(cat, s.name, v)}`);
        // Segment value inside the segment, when it fits.
        if (vals && Math.abs(y2 - y1) >= vals.font.size * 1.3) {
          const t = formatChartValue(v, spec);
          if (v !== 0 && textW(t, vals.font) <= gW * 0.92) {
            svg.text(cx, (y1 + y2) / 2 + vals.font.size * 0.35, t, vals.font, inkOn(fill, theme), 'middle');
          }
        }
        if (v >= 0) pos += v;
        else neg += v;
      });
      if (vals) {
        const total = spec.series.reduce((a, s) => a + s.values[i]!, 0);
        const y = total >= 0 ? yOf(pos) - vals.font.size * 0.4 : yOf(neg) + vals.font.size * 1.1;
        svg.text(cx, y, vals.text[i]!, vals.font, theme.text, 'middle');
      }
    } else {
      spec.series.forEach((s, si) => {
        const v = s.values[i]!;
        const x = cx - gW / 2 + si * bW;
        const y = Math.min(zeroY, yOf(v));
        const h = Math.abs(yOf(v) - zeroY);
        svg.rect(x + inset / 2, y, bW - inset, h, fillFor(ctx, si, cat), ` class="bar"${dataAttrs(cat, s.name, v)}`);
        if (vals) {
          const ly = v >= 0 ? yOf(v) - vals.font.size * 0.4 : yOf(v) + vals.font.size * 1.1;
          svg.text(x + bW / 2, ly, vals.text[si * N + i]!, vals.font, theme.text, 'middle');
        }
      });
    }
    if (cats.show[i]) {
      const f = isHighlighted(spec, cat) ? { ...cats.font, weight: 700 } : cats.font;
      svg.text(cx, area.y + area.h + footroom + fs.gap + cats.font.size * 0.95, cats.text[i]!, f, theme.text, 'middle');
    }
  });
  // The zero line last, so it sits crisply over the bars' feet.
  svg.line(area.x, zeroY, area.x + area.w, zeroY, theme.text, 1.5, ' class="zero"');
}

function drawLine(ctx: Ctx, plot: Box): void {
  const { spec, svg, fs, theme } = ctx;
  const N = spec.categories.length;
  const S = spec.series.length;
  const all = spec.series.flatMap((s) => s.values);
  let min = Math.min(...all);
  let max = Math.max(...all);
  // Start at zero when the data is near it anyway; a series far from zero keeps its
  // own range rather than flattening into a line along the top of the chart.
  if (min >= 0 && min <= max * 0.5) min = 0;
  if (max <= 0 && max >= min * 0.5) max = 0;

  const plan = planYAxis(ctx, plot, min, max);
  const slot = Math.max(1, (plot.w - plan.labelW - fs.gap) / N);
  const cats = fitCategoryLabels(spec.categories, slot, ctx.body(fs.label, 400));
  const bottomBand = cats.font.size * 1.25 + fs.gap;
  const show = showValuesFor(spec, N * S, S === 1 ? 14 : 0);
  const vals = show ? fitValueLabels(all, slot * 0.96, ctx) : null;
  const headroom = vals ? vals.font.size * 1.6 : fs.small;

  const { area, yOf } = drawYAxis(ctx, plot, plan, bottomBand, headroom, 0);
  const xOf = (i: number) => area.x + (i + 0.5) * slot;
  const stroke = Math.max(2, fs.label * 0.16);
  if (min < 0 && max > 0) svg.line(area.x, yOf(0), area.x + area.w, yOf(0), theme.text, 1.5, ' class="zero"');
  else svg.line(area.x, area.y + area.h, area.x + area.w, area.y + area.h, theme.text, 1.5, ' class="baseline"');

  spec.series.forEach((s, si) => {
    const colour = theme.colors[si % theme.colors.length]!;
    const pts = s.values.map((v, i) => `${n(xOf(i))},${n(yOf(v))}`).join(' ');
    svg.parts.push(
      `<polyline points="${pts}" fill="none" stroke="${colour}" stroke-width="${n(stroke)}" stroke-linejoin="round" stroke-linecap="round" data-series="${escapeXml(s.name)}"/>`,
    );
    s.values.forEach((v, i) => {
      const cat = spec.categories[i]!;
      const hl = isHighlighted(spec, cat);
      svg.circle(xOf(i), yOf(v), stroke * (hl ? 2.4 : 1.6), hl && S === 1 ? theme.accent : colour, ` stroke="${theme.bg}" stroke-width="1.5" class="point"${dataAttrs(cat, s.name, v)}`);
      if (vals) {
        // Above a peak, below a dip — where the line is not. A point lower than its
        // neighbours' average has the line rising away above it, so its label goes
        // underneath (unless that would run into the axis).
        const prev = s.values[i - 1];
        const next = s.values[i + 1];
        const around = [prev, next].filter((x): x is number => typeof x === 'number');
        const dip = around.length > 0 && v < around.reduce((a, b) => a + b, 0) / around.length;
        const below = yOf(v) + stroke * 2 + vals.font.size * 1.05;
        const y = dip && below <= area.y + area.h - 2 ? below : yOf(v) - stroke * 2 - vals.font.size * 0.3;
        svg.text(xOf(i), y, vals.text[si * N + i]!, vals.font, theme.text, 'middle');
      }
    });
  });
  spec.categories.forEach((cat, i) => {
    if (!cats.show[i]) return;
    const f = isHighlighted(spec, cat) ? { ...cats.font, weight: 700 } : cats.font;
    svg.text(xOf(i), area.y + area.h + fs.gap + cats.font.size * 0.95, cats.text[i]!, f, theme.text, 'middle');
  });
}

function drawBarh(ctx: Ctx, plot: Box): void {
  const { spec, svg, fs, theme } = ctx;
  const N = spec.categories.length;
  const S = spec.series.length;
  const stacked = !!spec.stacked;
  const ext = barExtent(spec);
  const slotEst = plot.h / N;

  const catSize = clamp(Math.min(fs.label, Math.floor(slotEst * 0.62)), 10, fs.label);
  const catFont = ctx.body(catSize, 400);
  const labelColW = Math.min(spec.categories.reduce((m, c) => Math.max(m, textW(c, catFont)), 0), plot.w * 0.38);

  const marks = stacked ? N : N * S;
  const totals = stacked
    ? spec.categories.map((_, i) => spec.series.reduce((a, s) => a + s.values[i]!, 0))
    : spec.series.flatMap((s) => s.values);
  const show = showValuesFor(spec, marks, 24);
  // Value labels sit beside the bars, so they are sized against the row, not a slot.
  let vals: { font: Font; text: string[] } | null = null;
  if (show) {
    const size = clamp(Math.min(fs.value, Math.floor((slotEst / (stacked ? 1 : S)) * 0.8)), 10, fs.value);
    const f = ctx.body(size, 600);
    const full = totals.map((v) => formatChartValue(v, spec));
    const useCompact = full.some((t) => textW(t, f) > plot.w * 0.22);
    vals = { font: f, text: useCompact ? totals.map((v) => compactChartValue(v, spec)) : full };
  }
  const valW = vals ? vals.text.reduce((m, t) => Math.max(m, textW(t, vals!.font)), 0) + fs.gap : 0;
  const hasNeg = ext.min < 0;

  const ticks = niceTicks(ext.min, ext.max, clamp(Math.floor((plot.w - labelColW) / (fs.label * 5)), 2, 6));
  const tf = ctx.body(fs.small, 400);
  const maxAbs = Math.max(Math.abs(ticks.min), Math.abs(ticks.max));
  const tickLabels = ticks.ticks.map((t) => tickLabel(t, ticks.step, maxAbs, spec));
  // Printed values make the axis redundant; without them the axis carries the scale.
  const axisRow = vals ? 0 : tf.size * 1.6;
  const lastTickHalf = vals ? 0 : textW(tickLabels[tickLabels.length - 1] ?? '', tf) / 2;

  const area: Box = {
    x: plot.x + labelColW + fs.gap + (hasNeg && vals ? valW : 0),
    y: plot.y,
    w: 0,
    h: Math.max(10, plot.h - axisRow),
  };
  area.w = Math.max(10, plot.x + plot.w - (vals ? valW : lastTickHalf) - area.x);
  const span = ticks.max - ticks.min || 1;
  const xOf = (v: number) => area.x + ((v - ticks.min) / span) * area.w;
  const slot = area.h / N;
  const groupH = slot * (S > 1 && !stacked ? 0.8 : 0.64);
  const barH = stacked || S === 1 ? groupH : groupH / S;
  const inset = S > 1 && !stacked ? Math.min(2, barH * 0.1) : 0;

  if (!vals) {
    ticks.ticks.forEach((t, i) => {
      const x = xOf(t);
      if (t !== 0) svg.line(x, area.y, x, area.y + area.h, theme.grid, 1);
      svg.text(x, area.y + area.h + tf.size * 1.25, tickLabels[i]!, tf, theme.muted, 'middle');
    });
  }

  spec.categories.forEach((cat, i) => {
    const cy = area.y + (i + 0.5) * slot;
    const f = isHighlighted(spec, cat) ? { ...catFont, weight: 700 } : catFont;
    svg.text(plot.x + labelColW, cy + catFont.size * 0.35, ellipsize(cat, labelColW, f), f, theme.text, 'end');
    if (stacked) {
      let pos = 0;
      let neg = 0;
      spec.series.forEach((s, si) => {
        const v = s.values[i]!;
        const base = v >= 0 ? pos : neg;
        const x1 = xOf(base);
        const x2 = xOf(base + v);
        svg.rect(Math.min(x1, x2), cy - groupH / 2, Math.abs(x2 - x1), groupH, fillFor(ctx, si, cat), ` class="bar"${dataAttrs(cat, s.name, v)}`);
        if (v >= 0) pos += v;
        else neg += v;
      });
      if (vals) {
        const total = totals[i]!;
        const end = total >= 0 ? xOf(pos) : xOf(neg);
        svg.text(total >= 0 ? end + fs.gap * 0.6 : end - fs.gap * 0.6, cy + vals.font.size * 0.35, vals.text[i]!, vals.font, theme.text, total >= 0 ? 'start' : 'end');
      }
    } else {
      spec.series.forEach((s, si) => {
        const v = s.values[i]!;
        const y = cy - groupH / 2 + si * barH;
        const x0 = xOf(0);
        const x1 = xOf(v);
        svg.rect(Math.min(x0, x1), y + inset / 2, Math.abs(x1 - x0), barH - inset, fillFor(ctx, si, cat), ` class="bar"${dataAttrs(cat, s.name, v)}`);
        if (vals) {
          const t = vals.text[si * N + i]!;
          svg.text(v >= 0 ? x1 + fs.gap * 0.6 : x1 - fs.gap * 0.6, y + barH / 2 + vals.font.size * 0.35, t, vals.font, theme.text, v >= 0 ? 'start' : 'end');
        }
      });
    }
  });
  const zx = xOf(0);
  svg.line(zx, area.y, zx, area.y + area.h, theme.text, 1.5, ' class="zero"');
}

// ── pie and donut ────────────────────────────────────────────────────────────

/** A point on a circle, angle in radians measured clockwise from 12 o'clock. */
function polar(cx: number, cy: number, r: number, a: number): [number, number] {
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
}

function pctLabel(p: number): string {
  return p > 0 && p < 1 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`;
}

function drawPie(ctx: Ctx, plot: Box, donut: boolean): void {
  const { spec, svg, fs, theme } = ctx;
  const values = spec.series[0]!.values;
  const total = values.reduce((a, b) => a + b, 0);
  const N = spec.categories.length;

  // The legend carries every label and value, so nothing collides however thin a
  // slice is; percentages go inside the slices big enough to hold them.
  const lf = ctx.body(fs.label, 400);
  const items = spec.categories.map((c, i) => ({
    cat: c,
    detail: `${formatChartValue(values[i]!, spec)} (${pctLabel((values[i]! / total) * 100)})`,
  }));
  const sw = Math.round(lf.size * 0.8);
  // The gap between a label and its figures is a dx shift on the figures, not spaces:
  // spaces (even no-break ones) collapse or vanish differently from one SVG renderer
  // to the next.
  const detailGap = lf.size * 0.6;
  // Sized for the bold (highlighted) label plus the gap the loop keeps, so no item
  // has to drop its figures when there is room for them.
  const itemNatural = (it: { cat: string; detail: string }) => sw + 8 + fs.gap + textW(it.cat, { ...lf, weight: 700 }) + detailGap + textW(it.detail, lf);
  const side = plot.w >= plot.h * 1.25;
  let legend: Box;
  let pieBox: Box;
  let itemH = lf.size * 1.6;
  let cols = 1;
  if (side) {
    const legendW = Math.min(plot.w * 0.46, Math.max(...items.map(itemNatural)));
    itemH = Math.min(itemH, plot.h / N);
    legend = { x: plot.x + plot.w - legendW, y: plot.y + (plot.h - itemH * N) / 2, w: legendW, h: itemH * N };
    pieBox = { x: plot.x, y: plot.y, w: plot.w - legendW - fs.gap * 2, h: plot.h };
  } else {
    cols = plot.w >= Math.max(...items.map(itemNatural)) * 2 + fs.gap * 2 && N > 3 ? 2 : 1;
    const rows = Math.ceil(N / cols);
    itemH = Math.min(itemH, (plot.h * 0.45) / rows);
    const legendH = rows * itemH;
    legend = { x: plot.x, y: plot.y + plot.h - legendH, w: plot.w, h: legendH };
    pieBox = { x: plot.x, y: plot.y, w: plot.w, h: plot.h - legendH - fs.gap };
  }
  const itemFont = itemH < lf.size * 1.6 ? ctx.body(Math.max(10, Math.floor(itemH / 1.6)), 400) : lf;
  const colW = legend.w / cols;
  items.forEach((it, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = legend.x + col * colW;
    const cy = legend.y + row * itemH + itemH / 2;
    const s = Math.min(sw, itemH * 0.7);
    svg.rect(x, cy - s / 2, s, s, theme.colors[i % theme.colors.length]!);
    const hl = isHighlighted(spec, it.cat);
    const cf = hl ? { ...itemFont, weight: 700 } : itemFont;
    const room = colW - s - 8 - fs.gap;
    // Label and figures in ONE text run (the figures a muted tspan), so the browser
    // places the figures after the label itself — no measured offset to get wrong.
    const gap = itemFont.size * 0.6;
    const detailW = gap + textW(it.detail, itemFont);
    const keepDetail = room - detailW >= Math.min(textW(it.cat, cf), 60);
    const catText = ellipsize(it.cat, keepDetail ? room - detailW : room, cf);
    svg.families.add(itemFont.family);
    svg.parts.push(
      `<text x="${n(x + s + 8)}" y="${n(cy + itemFont.size * 0.35)}" font-family="${escapeXml(itemFont.family)}" font-size="${n(itemFont.size)}" font-weight="${cf.weight}" fill="${theme.text}">${escapeXml(catText)}` +
        (keepDetail ? `<tspan dx="${n(gap)}" font-weight="400" fill="${theme.muted}">${escapeXml(it.detail)}</tspan>` : '') +
        '</text>',
    );
  });

  const R = Math.max(10, Math.min(pieBox.w, pieBox.h) / 2 - 2);
  const cx = pieBox.x + pieBox.w / 2;
  const cy = pieBox.y + pieBox.h / 2;
  const ri = donut ? R * 0.58 : 0;
  let a0 = 0;
  values.forEach((v, i) => {
    const cat = spec.categories[i]!;
    const sweep = (v / total) * Math.PI * 2;
    const a1 = a0 + sweep;
    const colour = theme.colors[i % theme.colors.length]!;
    const attrs = ` stroke="${theme.bg}" stroke-width="2" class="slice" data-start="${n((a0 * 180) / Math.PI)}" data-end="${n((a1 * 180) / Math.PI)}"${dataAttrs(cat, spec.series[0]!.name, v)}`;
    if (sweep > 0) {
      // The highlighted slice is pulled out a little along its middle.
      const mid = a0 + sweep / 2;
      const [ox, oy] = isHighlighted(spec, cat) && sweep < Math.PI * 2 - 1e-6 ? polar(0, 0, R * 0.06, mid) : [0, 0];
      const pcx = cx + ox;
      const pcy = cy + oy;
      if (sweep >= Math.PI * 2 - 1e-6) {
        // One slice is the whole: a circle (or ring), since an arc cannot end where it starts.
        const d = donut
          ? `M${n(pcx - R)},${n(pcy)}a${n(R)},${n(R)} 0 1,0 ${n(2 * R)},0a${n(R)},${n(R)} 0 1,0 ${n(-2 * R)},0Z M${n(pcx - ri)},${n(pcy)}a${n(ri)},${n(ri)} 0 1,0 ${n(2 * ri)},0a${n(ri)},${n(ri)} 0 1,0 ${n(-2 * ri)},0Z`
          : `M${n(pcx - R)},${n(pcy)}a${n(R)},${n(R)} 0 1,0 ${n(2 * R)},0a${n(R)},${n(R)} 0 1,0 ${n(-2 * R)},0Z`;
        svg.path(d, colour, `${attrs} fill-rule="evenodd"`);
      } else {
        const large = sweep > Math.PI ? 1 : 0;
        const [x0, y0] = polar(pcx, pcy, R, a0);
        const [x1, y1] = polar(pcx, pcy, R, a1);
        const d = donut
          ? (() => {
              const [ix1, iy1] = polar(pcx, pcy, ri, a1);
              const [ix0, iy0] = polar(pcx, pcy, ri, a0);
              return `M${n(x0)},${n(y0)}A${n(R)},${n(R)} 0 ${large},1 ${n(x1)},${n(y1)}L${n(ix1)},${n(iy1)}A${n(ri)},${n(ri)} 0 ${large},0 ${n(ix0)},${n(iy0)}Z`;
            })()
          : `M${n(pcx)},${n(pcy)}L${n(x0)},${n(y0)}A${n(R)},${n(R)} 0 ${large},1 ${n(x1)},${n(y1)}Z`;
        svg.path(d, colour, attrs);
      }
      // Percentage inside a slice wide enough to hold it.
      if (sweep >= (22 * Math.PI) / 180) {
        const f = ctx.body(clamp(Math.min(fs.value, R * 0.16), 10, fs.value), 700);
        const [lx, ly] = polar(pcx, pcy, donut ? (R + ri) / 2 : R * 0.64, mid);
        svg.text(lx, ly + f.size * 0.35, pctLabel((v / total) * 100), f, inkOn(colour, theme), 'middle');
      }
    }
    a0 = a1;
  });
  if (donut && ri >= 30) {
    const f = ctx.display(clamp(Math.round(ri * 0.42), 14, fs.title + 6), 700);
    const t = ellipsize(formatChartValue(total, spec), ri * 1.7, f);
    const label = ctx.body(Math.max(11, Math.round(f.size * 0.45)), 400);
    svg.text(cx, cy + f.size * 0.2, t, f, theme.text, 'middle');
    svg.text(cx, cy + f.size * 0.2 + label.size * 1.4, 'Total', label, theme.muted, 'middle');
  }
}

// ── table ────────────────────────────────────────────────────────────────────

function drawTable(ctx: Ctx, plot: Box): void {
  const { spec, svg, fs, theme } = ctx;
  const N = spec.categories.length;
  const S = spec.series.length;
  // Rows grow a little to fill a generous box (up to 2.8 type-heights), never more:
  // a table stretched to any height reads as a list of gaps.
  const rowH = Math.min(plot.h / (N + 1), fs.label * 2.8);
  const size = clamp(Math.min(fs.label, Math.floor(rowH * 0.56)), 9, fs.label);
  const cell = ctx.body(size, 400);
  const head = ctx.body(size, 700);
  const padX = size * 0.6;
  const col0W = Math.min(
    spec.categories.reduce((m, c) => Math.max(m, textW(c, cell)), 0) + 2 * padX,
    plot.w * (S === 1 ? 0.6 : 0.45),
  );
  const numW = (plot.w - col0W) / S;
  const numbers = spec.series.map((s) => s.values.map((v) => formatChartValue(v, spec)));
  const tooWide = numbers.some((col) => col.some((t) => textW(t, cell) > numW - 2 * padX));
  const shown = tooWide ? spec.series.map((s) => s.values.map((v) => compactChartValue(v, spec))) : numbers;
  const base = (top: number) => top + rowH / 2 + size * 0.35;

  // header
  spec.series.forEach((s, si) => {
    const right = plot.x + col0W + (si + 1) * numW - padX;
    svg.text(right, base(plot.y), ellipsize(s.name, numW - 2 * padX, head), head, theme.text, 'end');
  });
  svg.line(plot.x, plot.y + rowH, plot.x + plot.w, plot.y + rowH, theme.text, 1.5);

  spec.categories.forEach((cat, i) => {
    const top = plot.y + (i + 1) * rowH;
    const hl = isHighlighted(spec, cat);
    if (hl) svg.rect(plot.x, top, plot.w, rowH, mixHex(theme.accent, theme.bg, 0.82));
    else if (i % 2 === 1) svg.rect(plot.x, top, plot.w, rowH, theme.stripe);
    const f = hl ? head : cell;
    svg.text(plot.x + padX, base(top), ellipsize(cat, col0W - 2 * padX, f), f, theme.text, 'start', ` class="cell"`);
    spec.series.forEach((s, si) => {
      const right = plot.x + col0W + (si + 1) * numW - padX;
      svg.text(right, base(top), ellipsize(shown[si]![i]!, numW - 2 * padX, f), f, theme.text, 'end', ` class="cell"${dataAttrs(cat, s.name, s.values[i]!)}`);
    });
  });
  svg.line(plot.x, plot.y + (N + 1) * rowH, plot.x + plot.w, plot.y + (N + 1) * rowH, theme.grid, 1);
}

/** Local mix (kept here so the table tint needs nothing from chartTheme at runtime). */
function mixHex(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const x = p(a);
  const y = p(b);
  return `#${x.map((v, i) => Math.round(v + (y[i]! - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

// ── entry point ──────────────────────────────────────────────────────────────

/**
 * Draw `spec` in `theme` at exactly `size` (page px). Returns the SVG and the font
 * families it uses (first family of each stack, unquoted), so the rasteriser can load
 * those faces before it takes the picture.
 */
export function chartSvg(spec: ChartSpec, theme: ChartTheme, size: { width: number; height: number }): { svg: string; fontFamilies: string[] } {
  const W = Math.max(40, Math.round(Number.isFinite(size.width) ? size.width : 40));
  const H = Math.max(40, Math.round(Number.isFinite(size.height) ? size.height : 40));
  const svg = new Svg();
  const fs = sizesFor(W, H);
  const ctx: Ctx = {
    spec: { ...spec, decimals: (spec.decimals ?? chartDecimals(spec)) as 0 | 1 | 2 },
    theme,
    svg,
    W,
    H,
    fs,
    body: (s, w = 400) => ({ family: theme.fontBody, weight: w, size: s }),
    display: (s, w = 700) => ({ family: theme.fontDisplay, weight: w, size: s }),
  };

  svg.rect(0, 0, W, H, theme.bg, ' class="ground"');
  const top = drawHeader(ctx);
  const footer = drawFooter(ctx);
  const plot: Box = {
    x: fs.pad,
    y: top,
    w: W - 2 * fs.pad,
    h: Math.max(30, H - fs.pad - footer - (footer ? fs.gap * 0.5 : 0) - top),
  };

  switch (spec.type) {
    case 'bar':
      drawBars(ctx, plot);
      break;
    case 'barh':
      drawBarh(ctx, plot);
      break;
    case 'line':
      drawLine(ctx, plot);
      break;
    case 'pie':
      drawPie(ctx, plot, false);
      break;
    case 'donut':
      drawPie(ctx, plot, true);
      break;
    case 'table':
      drawTable(ctx, plot);
      break;
  }

  const families: string[] = [];
  for (const stack of [theme.fontDisplay, theme.fontBody]) {
    if (!svg.families.has(stack)) continue;
    const fam = firstFamily(stack);
    if (fam && !families.includes(fam)) families.push(fam);
  }
  const out =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    svg.parts.join('') +
    '</svg>';
  return { svg: out, fontFamilies: families };
}
