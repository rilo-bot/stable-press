// ---------------------------------------------------------------------------
// Magazine Builder v2 — the CHART SPEC: what a chart is, before anyone draws it.
//
// Why this exists. A client asked for "a bar chart of these numbers" and got a
// photograph of a chart: the only picture tool was the image model, whose prompt
// forbids text, so the bars were invented and there were no labels or values at
// all (audit findings C02/C16/C36/C37/C52). A chart is DATA, so it is drawn from
// the numbers, deterministically (chartSvg.ts), never imagined by a model.
//
// This module is the pure contract every chart door shares — the Studio agent's
// add_chart / update_chart tools, the POST …/chart route The Stable Hand uses, and
// the charts.ts renderer:
//
//   • chartSpecSchema / ChartSpec — the shape (zod, so a tool can take it directly)
//   • validateChartSpec — the RULES, with errors a model can act on ("series 'Wins'
//     has 3 values but there are 4 categories") rather than a zod dump
//   • applyChartChanges — "change 2023 to 14" against a stored spec
//   • chartAlt / dataEcho — the deterministic sentence that becomes the image's alt
//     text and is handed back to the model, so it can check the numbers it drew
//     against the numbers the user gave
//   • looksLikeChartRequest — the guard that keeps chart requests away from the
//     image model
//   • chartBox / chartSlot / topZ — where a new chart goes on a page, and on top of
//     what
//
// Pure: no db, no storage, no network, no Date, no randomness. Same input, same output.
// ---------------------------------------------------------------------------

import { z } from 'zod';
import type { MagazineElement } from './model.js';

// ── the spec ─────────────────────────────────────────────────────────────────

export const CHART_TYPES = ['bar', 'barh', 'line', 'pie', 'donut', 'table'] as const;
export type ChartType = (typeof CHART_TYPES)[number];

/** Limits, in one place so the schema descriptions, the validator and the tests agree. */
export const CHART_LIMITS = {
  categories: 24,
  series: 4,
  tableSeries: 6,
  pieSlices: 8,
  title: 80,
  subtitle: 120,
  source: 120,
  seriesName: 40,
  category: 60,
  prefix: 4,
  suffix: 8,
} as const;

/**
 * What a chart IS. Written out by hand (rather than z.infer) because it is a shared
 * contract other modules import by name; the schema below must stay assignable to it.
 */
export type ChartSpec = {
  type: ChartType;
  title?: string;
  subtitle?: string;
  source?: string;
  categories: string[];
  series: { name: string; values: number[] }[];
  unit?: { prefix?: string; suffix?: string };
  decimals?: 0 | 1 | 2;
  showValues?: boolean;
  highlight?: string;
  stacked?: boolean;
};

/**
 * The zod shape, for a tool's inputSchema and a route's body. STRUCTURAL only, on
 * purpose: the limits live in validateChartSpec, which explains a breach in words the
 * model can fix in one step. A schema rejection reaches the model as a raw validation
 * dump and tends to start a guessing loop.
 */
export const chartSpecSchema = z.object({
  type: z
    .enum(CHART_TYPES)
    .describe(
      "bar = vertical columns (years, months, a few short labels); barh = horizontal bars (long labels such as horse or owner names, rankings); line = a trend over time; pie / donut = shares of ONE whole (at most 8 slices); table = the numbers as a neat table.",
    ),
  title: z.string().optional().describe(`Short headline for the chart (at most ${CHART_LIMITS.title} characters).`),
  subtitle: z.string().optional().describe('Optional one-line explanation under the title.'),
  source: z.string().optional().describe("Where the numbers come from, shown as a 'Source: …' footnote."),
  categories: z
    .array(z.string())
    .describe(`The x-axis labels / slice labels / table rows, in order (1 to ${CHART_LIMITS.categories}).`),
  series: z
    .array(
      z.object({
        name: z.string().describe('What the numbers measure, e.g. "Wins".'),
        values: z.array(z.number()).describe('One number per category, in the same order. The EXACT numbers the user gave.'),
      }),
    )
    .describe(`1 to ${CHART_LIMITS.series} series (a table may have up to ${CHART_LIMITS.tableSeries} columns; a pie or donut exactly 1).`),
  unit: z
    .object({
      prefix: z.string().optional().describe("Before the number, e.g. 'NZ$'."),
      suffix: z.string().optional().describe("After the number, e.g. '%' or ' wins'."),
    })
    .optional(),
  decimals: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional().describe('Decimal places to show (default: as many as the data has, at most 2).'),
  showValues: z.boolean().optional().describe('Print each value on its bar / point (default: on when there are few enough to read).'),
  highlight: z.string().optional().describe('A category to draw in the accent colour, e.g. the current year.'),
  stacked: z.boolean().optional().describe('bar / barh only: stack the series on top of each other.'),
});

/**
 * A change to an existing chart (update_chart; the route's edit-from-asset). Any spec
 * field REPLACES the stored one (categories and series wholesale; an empty string
 * removes a title, subtitle or source). `setValues` changes single numbers in place —
 * "change 2023 to 14" — without retyping the rest of the data.
 */
export const chartChangesSchema = chartSpecSchema.partial().extend({
  setValues: z
    .array(
      z.object({
        category: z.string().describe('The category whose number changes, exactly as it appears on the chart.'),
        series: z.string().optional().describe('The series name — needed only when the chart has more than one series.'),
        value: z.number(),
      }),
    )
    .optional()
    .describe('Change single numbers, e.g. [{ "category": "2023", "value": 14 }].'),
});
export type ChartChanges = z.infer<typeof chartChangesSchema>;

// ── validation ───────────────────────────────────────────────────────────────

const TYPE_ALIASES: Record<string, ChartType> = {
  bar: 'bar',
  bars: 'bar',
  column: 'bar',
  columns: 'bar',
  'bar chart': 'bar',
  barh: 'barh',
  hbar: 'barh',
  horizontal: 'barh',
  'horizontal bar': 'barh',
  line: 'line',
  'line chart': 'line',
  pie: 'pie',
  'pie chart': 'pie',
  donut: 'donut',
  doughnut: 'donut',
  table: 'table',
};

/** Clip display text to a limit, with an ellipsis so a cut is visible, never silent. */
function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  const chars = Array.from(t);
  return chars.length <= max ? t : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

function optText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = clip(v, max);
  return t ? t : undefined;
}

/**
 * A number from what a model or a client sent. Plain numerals in a string ("12",
 * "1,234", "-3.5") are accepted — they are exactly the number written down. Anything
 * that needs interpreting ("$5", "12%", "about 7") is NOT guessed at: the caller is
 * told which value it was, so the exact figure is supplied instead.
 */
function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.trim().replace(/,(?=\d{3}(\D|$))/g, '').replace(/\s+/g, '');
    if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Same category, ignoring case and surrounding space. */
export function sameLabel(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Check and normalise a chart spec from anywhere (a tool call, a request body, a
 * stored media row). Errors name the exact problem and the fix, because the reader is
 * usually a model that will try again with whatever the message tells it.
 */
export function validateChartSpec(raw: unknown): { ok: true; spec: ChartSpec } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'A chart needs a type, categories and at least one series of numbers.' };
  const o = raw as Record<string, unknown>;

  const typeKey = typeof o.type === 'string' ? o.type.trim().toLowerCase() : '';
  const type = TYPE_ALIASES[typeKey];
  if (!type) return { ok: false, error: `Unknown chart type "${String(o.type ?? '')}". Use one of: ${CHART_TYPES.join(', ')}.` };

  if (!Array.isArray(o.categories) || o.categories.length === 0) {
    return { ok: false, error: 'A chart needs categories: the labels for each bar, point, slice or table row.' };
  }
  if (o.categories.length > CHART_LIMITS.categories) {
    return {
      ok: false,
      error: `${o.categories.length} categories is too many to read — at most ${CHART_LIMITS.categories}. Group or drop some, or split the data into two charts.`,
    };
  }
  const categories: string[] = [];
  for (let i = 0; i < o.categories.length; i++) {
    const c = o.categories[i];
    const label = typeof c === 'number' && Number.isFinite(c) ? String(c) : typeof c === 'string' ? clip(c, CHART_LIMITS.category) : '';
    if (!label) return { ok: false, error: `Category ${i + 1} has no label. Every bar, point, slice or row needs one.` };
    categories.push(label);
  }

  if (!Array.isArray(o.series) || o.series.length === 0) {
    return { ok: false, error: 'A chart needs at least one series: { name, values } with one number per category.' };
  }
  const maxSeries = type === 'table' ? CHART_LIMITS.tableSeries : type === 'pie' || type === 'donut' ? 1 : CHART_LIMITS.series;
  if (o.series.length > maxSeries) {
    return {
      ok: false,
      error:
        type === 'pie' || type === 'donut'
          ? `A ${type} chart shows ONE series (shares of one whole); you gave ${o.series.length}. Use a bar chart to compare several series.`
          : `${o.series.length} series is too many for a ${type === 'table' ? 'table' : 'chart'} — at most ${maxSeries}.`,
    };
  }
  const series: ChartSpec['series'] = [];
  for (let s = 0; s < o.series.length; s++) {
    const so = (o.series[s] && typeof o.series[s] === 'object' ? o.series[s] : {}) as Record<string, unknown>;
    const name = optText(so.name, CHART_LIMITS.seriesName) ?? (o.series.length === 1 ? 'Value' : `Series ${s + 1}`);
    if (!Array.isArray(so.values)) return { ok: false, error: `Series "${name}" has no values. Give one number per category.` };
    if (so.values.length !== categories.length) {
      return {
        ok: false,
        error: `Series "${name}" has ${so.values.length} value${so.values.length === 1 ? '' : 's'} but there ${categories.length === 1 ? 'is 1 category' : `are ${categories.length} categories`} (${categories.slice(0, 8).join(', ')}${categories.length > 8 ? ', …' : ''}). Give exactly one number per category, in the same order.`,
      };
    }
    const values: number[] = [];
    for (let i = 0; i < so.values.length; i++) {
      const n = toNumber(so.values[i]);
      if (n === null) {
        return {
          ok: false,
          error: `Series "${name}": the value for "${categories[i]}" is not a plain number (${JSON.stringify(so.values[i])}). Give the exact figure as a number; put units like $ or % in unit.prefix / unit.suffix.`,
        };
      }
      if (Math.abs(n) > 1e15) return { ok: false, error: `Series "${name}": the value for "${categories[i]}" is too large to chart.` };
      values.push(n);
    }
    series.push({ name, values });
  }

  if (type === 'pie' || type === 'donut') {
    const values = series[0]!.values;
    const neg = values.findIndex((v) => v < 0);
    if (neg >= 0) {
      return {
        ok: false,
        error: `A ${type} chart cannot show a negative share ("${categories[neg]}" = ${values[neg]}). Use a bar chart for values that go below zero.`,
      };
    }
    if (values.reduce((a, b) => a + b, 0) <= 0) return { ok: false, error: `A ${type} chart needs at least one value above zero.` };
    if (categories.length > CHART_LIMITS.pieSlices) {
      return {
        ok: false,
        error: `A ${type} chart with ${categories.length} slices is unreadable — at most ${CHART_LIMITS.pieSlices}. Use type "barh" (horizontal bars) instead, or group the smallest slices into "Other".`,
      };
    }
  }
  if (type === 'line' && categories.length < 2) {
    return { ok: false, error: 'A line chart needs at least 2 points. For a single number use a bar chart or a table.' };
  }

  const spec: ChartSpec = { type, categories, series };
  const title = optText(o.title, CHART_LIMITS.title);
  if (title) spec.title = title;
  const subtitle = optText(o.subtitle, CHART_LIMITS.subtitle);
  if (subtitle) spec.subtitle = subtitle;
  const source = optText(o.source, CHART_LIMITS.source);
  if (source) spec.source = source;

  if (o.unit && typeof o.unit === 'object') {
    const u = o.unit as Record<string, unknown>;
    // NOT clip(): a unit is set flush against the number, so its spacing (' wins') is
    // part of it and must survive.
    const prefix = typeof u.prefix === 'string' ? Array.from(u.prefix.replace(/\s+/g, ' ')).slice(0, CHART_LIMITS.prefix).join('') : '';
    const suffix = typeof u.suffix === 'string' ? Array.from(u.suffix.replace(/\s+/g, ' ')).slice(0, CHART_LIMITS.suffix).join('') : '';
    if (prefix.trim() || suffix.trim()) {
      spec.unit = {};
      if (prefix.trim()) spec.unit.prefix = prefix.trimStart();
      if (suffix.trim()) spec.unit.suffix = suffix.trimEnd();
    }
  }
  if (o.decimals === 0 || o.decimals === 1 || o.decimals === 2) spec.decimals = o.decimals;
  if (typeof o.showValues === 'boolean') spec.showValues = o.showValues;
  if (typeof o.highlight === 'string' && o.highlight.trim()) {
    const hit = categories.find((c) => sameLabel(c, o.highlight as string));
    if (!hit) {
      return {
        ok: false,
        error: `highlight "${o.highlight}" is not one of the categories (${categories.slice(0, 8).join(', ')}${categories.length > 8 ? ', …' : ''}).`,
      };
    }
    spec.highlight = hit;
  }
  if (o.stacked === true) {
    if (type !== 'bar' && type !== 'barh') return { ok: false, error: 'stacked applies to bar and barh charts only.' };
    if (series.length > 1) spec.stacked = true;
  }
  return { ok: true, spec };
}

/**
 * Apply a change to a stored spec ("change 2023 to 14", "make it a line chart", "add
 * a source line"), then re-validate the result. Replacing `categories` without new
 * `series` keeps the old values only when the count still matches — otherwise the
 * caller is told to send the values too, rather than having numbers silently shift
 * onto different labels.
 */
export function applyChartChanges(spec: ChartSpec, changes: unknown): { ok: true; spec: ChartSpec } | { ok: false; error: string } {
  if (!changes || typeof changes !== 'object') return { ok: false, error: 'Say what to change on the chart.' };
  const c = changes as Record<string, unknown>;
  const next: Record<string, unknown> = { ...spec, series: spec.series.map((s) => ({ name: s.name, values: [...s.values] })) };
  for (const key of ['type', 'categories', 'series', 'unit', 'decimals', 'showValues', 'highlight', 'stacked'] as const) {
    if (c[key] !== undefined) next[key] = c[key];
  }
  // "Make it a line chart" on a STACKED bar chart: stacking means nothing to a line,
  // pie or table, and validateChartSpec refuses it there — so carrying the stored
  // `stacked: true` over made every change of type on a stacked chart fail. A new type
  // that cannot stack drops it, unless the caller asked for it explicitly (that one is
  // still refused, with the reason).
  if (typeof c.type === 'string' && c.type !== 'bar' && c.type !== 'barh' && c.stacked === undefined) delete next.stacked;
  // An empty string REMOVES a line of text; undefined leaves it alone.
  for (const key of ['title', 'subtitle', 'source'] as const) {
    if (typeof c[key] === 'string') next[key] = (c[key] as string).trim() || undefined;
  }
  if (c.categories !== undefined && c.series === undefined && Array.isArray(c.categories) && c.categories.length !== spec.categories.length) {
    return {
      ok: false,
      error: `The new categories (${c.categories.length}) do not match the chart's ${spec.categories.length} values. Send the series with one value per new category too.`,
    };
  }
  // New categories that no longer include the highlighted one: drop the highlight
  // rather than fail the whole change over a styling detail nobody asked about.
  if (Array.isArray(c.categories) && c.highlight === undefined && typeof spec.highlight === 'string') {
    if (!c.categories.some((x) => sameLabel(String(x), spec.highlight as string))) next.highlight = undefined;
  }
  if (Array.isArray(c.setValues)) {
    const cats = (Array.isArray(next.categories) ? next.categories : spec.categories) as unknown[];
    const series = next.series as { name?: unknown; values?: unknown[] }[];
    for (const raw of c.setValues) {
      const sv = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const label = typeof sv.category === 'string' || typeof sv.category === 'number' ? String(sv.category) : '';
      const idx = cats.findIndex((x) => sameLabel(String(x), label));
      if (idx < 0) return { ok: false, error: `The chart has no category "${label}". Its categories are: ${cats.map(String).join(', ')}.` };
      let target = series.length === 1 ? series[0] : undefined;
      if (typeof sv.series === 'string' && sv.series.trim()) {
        target = series.find((s) => typeof s.name === 'string' && sameLabel(s.name, sv.series as string));
        if (!target) return { ok: false, error: `The chart has no series "${sv.series}". Its series are: ${series.map((s) => String(s.name)).join(', ')}.` };
      }
      if (!target) return { ok: false, error: `The chart has ${series.length} series — name which one to change (${series.map((s) => String(s.name)).join(', ')}).` };
      const n = toNumber(sv.value);
      if (n === null) return { ok: false, error: `The new value for "${label}" is not a number.` };
      if (Array.isArray(target.values)) target.values[idx] = n;
    }
  }
  return validateChartSpec(next);
}

// ── numbers in words ─────────────────────────────────────────────────────────

/** Decimal places a value needs (0–2), from its own digits. */
function decimalsOf(v: number): number {
  if (!Number.isFinite(v) || Number.isInteger(v)) return 0;
  const s = Math.abs(v).toFixed(6).replace(/0+$/, '');
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : Math.min(2, s.length - dot - 1);
}

/** The decimal places a chart shows: the spec's own, else as many as the data has (max 2). */
export function chartDecimals(spec: Pick<ChartSpec, 'decimals' | 'series'>): number {
  if (spec.decimals === 0 || spec.decimals === 1 || spec.decimals === 2) return spec.decimals;
  let d = 0;
  for (const s of spec.series) for (const v of s.values) d = Math.max(d, decimalsOf(v));
  return d;
}

const NUMBER_FORMATS = new Map<number, Intl.NumberFormat>();
function numberFormat(decimals: number): Intl.NumberFormat {
  let f = NUMBER_FORMATS.get(decimals);
  if (!f) {
    // en-NZ: the client base's own conventions (comma thousands, point decimals).
    f = new Intl.NumberFormat('en-NZ', { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: true });
    NUMBER_FORMATS.set(decimals, f);
  }
  return f;
}

/**
 * One value as the chart prints it: sign, prefix, grouped digits, suffix —
 * "-NZ$1,234.50", "12%", "7 wins". A value that rounds to zero carries no sign.
 */
export function formatChartValue(v: number, spec: Pick<ChartSpec, 'unit' | 'decimals' | 'series'>, decimals?: number): string {
  const d = decimals ?? chartDecimals(spec);
  const body = numberFormat(d).format(Math.abs(v));
  const negative = v < 0 && Number(Math.abs(v).toFixed(d)) !== 0;
  return `${negative ? '-' : ''}${spec.unit?.prefix ?? ''}${body}${spec.unit?.suffix ?? ''}`;
}

/** A short form for tight spaces (axis ticks, a narrow bar): 1.5k, 2.4m, 3.1bn. */
export function compactChartValue(v: number, spec: Pick<ChartSpec, 'unit'>): string {
  const a = Math.abs(v);
  const [div, tag] = a >= 1e9 ? [1e9, 'bn'] : a >= 1e6 ? [1e6, 'm'] : a >= 1e4 ? [1e3, 'k'] : [1, ''];
  const scaled = a / div;
  // One decimal below 100 of a unit (1.5m), none above (250k) — and none when the
  // decimal is a zero (25k, not 25.0k).
  const rounded = div === 1 ? scaled : Number(scaled.toFixed(scaled >= 100 ? 0 : 1));
  const d = div === 1 ? decimalsOf(scaled) : Number.isInteger(rounded) ? 0 : 1;
  const body = numberFormat(d).format(Number(rounded.toFixed(d)));
  const negative = v < 0 && Number(rounded.toFixed(d)) !== 0;
  return `${negative ? '-' : ''}${spec.unit?.prefix ?? ''}${body}${tag}${spec.unit?.suffix ?? ''}`;
}

const TYPE_NAMES: Record<ChartType, string> = {
  bar: 'Bar chart',
  barh: 'Horizontal bar chart',
  line: 'Line chart',
  pie: 'Pie chart',
  donut: 'Donut chart',
  table: 'Table',
};

function typeName(spec: ChartSpec): string {
  return spec.stacked ? `Stacked ${TYPE_NAMES[spec.type].toLowerCase()}` : TYPE_NAMES[spec.type];
}

/** "2021 = 12, 2022 = 15" for one series. */
function pairs(spec: ChartSpec, s: ChartSpec['series'][number]): string[] {
  return spec.categories.map((c, i) => `${c} = ${formatChartValue(s.values[i]!, spec)}`);
}

/**
 * EVERY number, in words — returned to the model after drawing so it can confirm the
 * chart says what the user said. Never truncated: this is the check, not a caption.
 */
export function dataEcho(spec: ChartSpec): string {
  const head = `${typeName(spec)}${spec.title ? ` "${spec.title}"` : ''}`;
  if (spec.series.length === 1) return `${head}: ${pairs(spec, spec.series[0]!).join(', ')}.`;
  return `${head}: ${spec.series.map((s) => `${s.name}: ${pairs(spec, s).join(', ')}`).join('; ')}.`;
}

/** model.ts keeps an image's alt to 300 characters; the stored alt is held to the same. */
export const CHART_ALT_MAX = 300;

/**
 * The chart in one sentence, for the image's alt text (screen readers, the AI's own
 * page digest). Every value when it fits; otherwise as many whole values as fit plus a
 * count, never a number cut in half.
 */
export function chartAlt(spec: ChartSpec): string {
  const head = `${typeName(spec)} — ${spec.title ?? spec.series.map((s) => s.name).join(' and ')}`;
  const parts =
    spec.series.length === 1
      ? pairs(spec, spec.series[0]!)
      : spec.series.flatMap((s) => pairs(spec, s).map((p, i) => (i === 0 ? `${s.name}: ${p}` : p)));
  const full = `${head}: ${parts.join(', ')}.`;
  if (Array.from(full).length <= CHART_ALT_MAX) return full;
  const total = spec.categories.length * spec.series.length;
  let out = `${head}:`;
  let used = 0;
  for (const p of parts) {
    const tail = ` … (${total} values)`;
    const candidate = `${out}${used ? ',' : ''} ${p}`;
    if (Array.from(candidate + tail).length > CHART_ALT_MAX) break;
    out = candidate;
    used++;
  }
  return Array.from(`${out} … (${total} values)`).slice(0, CHART_ALT_MAX).join('');
}

// ── keeping charts away from the image model ────────────────────────────────

/**
 * Does this picture request describe a CHART — something that must show real numbers
 * or labels — rather than a picture?
 *
 * Deliberately narrow. "Bar" and "pie" alone are not charts ("a horse jumping a bar",
 * "apple pie on a table"), nor are "table" and "plot" ("a picnic table", "a plot of
 * land") — the verifiers on C16 asked for exactly those to stay legitimate photo
 * requests. "graphic" and "photograph" must not match "graph", hence the word bounds.
 */
export function looksLikeChartRequest(text: string): boolean {
  const t = ` ${String(text ?? '').toLowerCase().replace(/[^a-z0-9%$-]+/g, ' ')} `;
  if (/\b(charts?|graphs?|infographics?|histograms?|sparklines?|scatterplots?|dataviz)\b/.test(t)) return true;
  if (/\bdata visuali[sz]ations?\b/.test(t)) return true;
  if (/\b[xy][ -]ax[ie]s\b|\baxes labell?ed\b/.test(t)) return true;
  if (/\btable (of|showing|with) (the )?(figures|numbers|results|stats|statistics|data|values|scores|prices|earnings|winnings)\b/.test(t)) return true;
  if (/\bplot(ted)? (of |the )?(the )?(data|numbers|figures|results|values|statistics)\b/.test(t)) return true;
  return false;
}

/**
 * The image-model guard as ONE rule, so the Studio tool and the /media/generate route
 * cannot drift: a chart-like request is refused unless it is explicitly a purely
 * decorative illustration (no real data on it).
 */
export function chartRequestBlocked(prompt: string, opts: { style?: string; decorative?: boolean } = {}): boolean {
  if (opts.style === 'illustration' && opts.decorative === true) return false;
  // A poster or graphic carries the user's own words in double quotes (the prompt tells
  // the model to quote them). Those words are what gets PRINTED, not what the picture
  // is: 'a poster reading "Chart your course to the Cup"' is a poster, not a chart.
  // Only the description outside the quotes decides.
  const brief = opts.style === 'poster' || opts.style === 'graphic' ? withoutQuotedWords(prompt) : prompt;
  return looksLikeChartRequest(brief);
}

/** A brief with its double-quoted spans (straight or curly quotes) taken out. An
 *  unpaired quote is left as it is, so nothing past it is dropped. */
export function withoutQuotedWords(text: string): string {
  return String(text ?? '').replace(/"[^"]*"|“[^”]*”/g, ' ');
}

/** What the model is told when generate_image is asked for a chart. */
export const CHART_GUARD_MESSAGE =
  'Charts, graphs and tables are DRAWN from the exact numbers with add_chart — the image model cannot plot data or write labels, so it would invent them. Call add_chart with the categories and the exact values (ask the user for the numbers if you do not have them). Only for a purely decorative picture that shows no real data, call generate_image with style "illustration" and decorative: true.';

/** What a person is told when the Make-image box is asked for a chart. */
export const CHART_GUARD_USER_MESSAGE =
  'Charts are drawn from your numbers, not generated as a picture — the image model would invent the bars and labels. Ask the Design Helper to "add a bar chart of …" with your figures instead.';

// ── placement ────────────────────────────────────────────────────────────────

/** The highest zIndex on the page (0 for an empty page). A new chart, photo or box goes
 *  at topZ + 1 so it can never land under a scrim or a panel. */
export function topZ(elements: ReadonlyArray<Pick<MagazineElement, 'zIndex'>>): number {
  let z = 0;
  for (const el of elements) if (Number.isFinite(el.zIndex) && el.zIndex > z) z = el.zIndex;
  return z;
}

/**
 * The frame shape a chart reads best in (width / height), for chartBox. Horizontal bars
 * grow taller with every row; a pie wants room for its legend beside it.
 */
export function preferredChartAspect(spec: Pick<ChartSpec, 'type' | 'categories' | 'series' | 'stacked'>): number {
  const n = spec.categories.length;
  const s = spec.series.length;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  switch (spec.type) {
    case 'pie':
    case 'donut':
      return 1.6;
    case 'line':
      return 1.7;
    case 'barh':
      return clamp(2.3 - 0.075 * n * (spec.stacked ? 1 : Math.sqrt(s)), 0.7, 2.3);
    case 'table': {
      // chartSvg sets a table's type at ~2.1% of the box width and its rows at ~2.3×
      // that, plus ~4.5 type-heights of title, rule and padding — so the height a
      // table fills is about 0.021 × width × (2.3 × rows + 4.5). Columns stretch to any
      // width; it is the ROWS that decide the shape.
      return clamp(1 / (0.021 * (2.3 * (n + 1) + 4.5)), 0.6, 3);
    }
    case 'bar':
    default:
      return clamp(1.3 + 0.05 * n * (spec.stacked ? 1 : s), 1.3, 2.2);
  }
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const GRID = 40; // px: placement works on a 40px grid
const OBSTACLE_PAD = 16; // px kept clear around text and pictures

/** Smallest box a chart is still readable in, for a page of this size. */
function minChartSize(page: { width: number; height: number }): { w: number; h: number } {
  return { w: Math.max(240, Math.round(page.width * 0.22)), h: Math.max(160, Math.round(page.height * 0.1)) };
}

/**
 * Where a new chart goes, and whether it fills an existing empty picture box:
 *
 *   1. an EMPTY image slot (an image element with no url — it renders as nothing on the
 *      public page and in the PDF, so filling it is pure gain); the largest one wins;
 *   2. else the largest free rectangle on a 40px grid inside the page's margins, clear
 *      of text, pictures, QR codes and icons (shapes are panels, rules and scrims — a
 *      chart may sit on them; a sheet-sized background photo is a ground, not a box);
 *   3. else null — the page is full, and the caller says so ("name an element to
 *      replace, or give a box") rather than stacking a chart over the copy.
 *
 * `preferredAspect` (width / height, see preferredChartAspect) shapes the box inside
 * the free space; the chart is drawn at exactly the box's aspect, so it never letterboxes.
 */
export function chartSlot(
  elements: ReadonlyArray<MagazineElement>,
  page: { width: number; height: number },
  preferredAspect?: number,
): { box: Rect; emptySlotId?: string } | null {
  const W = Math.max(1, page.width);
  const H = Math.max(1, page.height);
  const min = minChartSize({ width: W, height: H });

  // 1. an empty picture box
  const empty = elements
    .filter((e) => e.type === 'image' && !(e.image?.url ?? '').trim() && e.w >= min.w * 0.8 && e.h >= min.h * 0.8)
    .sort((a, b) => b.w * b.h - a.w * a.h || a.y - b.y || a.x - b.x)[0];
  if (empty) {
    return {
      box: { x: Math.round(empty.x), y: Math.round(empty.y), w: Math.round(empty.w), h: Math.round(empty.h) },
      emptySlotId: empty.id,
    };
  }

  // 2. the largest free rectangle
  const margin = Math.max(GRID, Math.round(W * 0.06));
  const cols = Math.floor((W - 2 * margin) / GRID);
  const rows = Math.floor((H - 2 * margin) / GRID);
  if (cols <= 0 || rows <= 0) return null;
  const sheet = W * H;
  const obstacles: Rect[] = elements
    .filter((e) => {
      if (e.type === 'shape') return false;
      if (e.type === 'image' && e.w * e.h >= sheet * 0.7) return false; // a background, not a box
      return e.w > 0 && e.h > 0;
    })
    .map((e) => ({ x: e.x - OBSTACLE_PAD, y: e.y - OBSTACLE_PAD, w: e.w + 2 * OBSTACLE_PAD, h: e.h + 2 * OBSTACLE_PAD }));

  const free: boolean[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < cols; c++) {
      const cx = margin + c * GRID;
      const cy = margin + r * GRID;
      row.push(!obstacles.some((o) => cx < o.x + o.w && cx + GRID > o.x && cy < o.y + o.h && cy + GRID > o.y));
    }
    free.push(row);
  }

  const aspect = preferredAspect && Number.isFinite(preferredAspect) && preferredAspect > 0 ? preferredAspect : undefined;
  /** The box we would actually use inside a free rectangle, and its usable area. */
  const fitIn = (w: number, h: number): { w: number; h: number } => {
    if (aspect) {
      const fw = Math.min(w, h * aspect);
      return { w: fw, h: fw / aspect };
    }
    // No preference: any shape between 1:2 and 3:1, so a free strip is not mistaken
    // for a home for a chart.
    return { w: Math.min(w, h * 3), h: Math.min(h, w * 2) };
  };

  let best: { rect: Rect; fit: { w: number; h: number }; area: number } | null = null;
  const heights = new Array<number>(cols).fill(0);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) heights[c] = free[r]![c] ? heights[c]! + 1 : 0;
    // Every maximal-height span ending on this row: O(cols²) per row, ~30k on A4.
    for (let c0 = 0; c0 < cols; c0++) {
      let minH = Infinity;
      for (let c1 = c0; c1 < cols; c1++) {
        minH = Math.min(minH, heights[c1]!);
        if (minH === 0) break;
        const rect = { x: margin + c0 * GRID, y: margin + (r - minH + 1) * GRID, w: (c1 - c0 + 1) * GRID, h: minH * GRID };
        const fit = fitIn(rect.w, rect.h);
        const area = fit.w * fit.h;
        // Strictly greater: ties keep the earliest (top-most, then left-most) rectangle,
        // so the answer is deterministic.
        if (!best || area > best.area + 0.5) best = { rect, fit, area };
      }
    }
  }
  if (!best || best.fit.w < min.w || best.fit.h < min.h) return null;
  // Centred across the free space, sitting at its top: a chart reads as part of the
  // column it lands in, not as something floating in the middle of a gap.
  const x = best.rect.x + (best.rect.w - best.fit.w) / 2;
  return { box: { x: Math.round(x), y: Math.round(best.rect.y), w: Math.round(best.fit.w), h: Math.round(best.fit.h) } };
}

/** chartSlot's box alone — the shared contract. */
export function chartBox(
  elements: MagazineElement[],
  page: { width: number; height: number },
  preferredAspect?: number,
): { x: number; y: number; w: number; h: number } | null {
  return chartSlot(elements, page, preferredAspect)?.box ?? null;
}
