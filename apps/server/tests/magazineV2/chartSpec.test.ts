// ---------------------------------------------------------------------------
// The chart spec: validation a model can act on, numbers formatted the NZ way, the
// alt/data echo that lets the AI check what it drew, the guard that keeps chart
// requests away from the image model, and "change 2023 to 14" on a stored chart.
// Pure — no db, no browser.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyChartChanges,
  chartAlt,
  chartDecimals,
  chartRequestBlocked,
  withoutQuotedWords,
  chartSpecSchema,
  CHART_ALT_MAX,
  compactChartValue,
  dataEcho,
  formatChartValue,
  looksLikeChartRequest,
  validateChartSpec,
  type ChartSpec,
} from '../../src/lib/magazineV2/chartSpec.js';

const WINS: ChartSpec = {
  type: 'bar',
  title: 'Wins by season',
  categories: ['2021', '2022', '2023'],
  series: [{ name: 'Wins', values: [12, 15, 9] }],
};

function err(raw: unknown): string {
  const r = validateChartSpec(raw);
  assert.equal(r.ok, false, 'expected a validation error');
  return (r as { ok: false; error: string }).error;
}

// ── validation ───────────────────────────────────────────────────────────────

test('a clean spec validates and comes back normalised', () => {
  const r = validateChartSpec({ ...WINS, title: '  Wins   by season ' });
  assert.ok(r.ok);
  assert.equal(r.spec.title, 'Wins by season');
  assert.deepEqual(r.spec.series[0]!.values, [12, 15, 9]);
});

test('the zod schema accepts the same shape the validator does', () => {
  assert.ok(chartSpecSchema.safeParse(WINS).success);
  assert.equal(chartSpecSchema.safeParse({ ...WINS, type: 'scatter' }).success, false);
});

test('a series with the wrong number of values names the counts and the categories', () => {
  const e = err({ ...WINS, series: [{ name: 'Wins', values: [12, 15] }] });
  assert.match(e, /"Wins" has 2 values but there are 3 categories/);
  assert.match(e, /2021, 2022, 2023/);
});

test('NaN / Infinity / words are refused with the category named — never guessed at', () => {
  assert.match(err({ ...WINS, series: [{ name: 'Wins', values: [12, Number.NaN, 9] }] }), /"2022" is not a plain number/);
  assert.match(err({ ...WINS, series: [{ name: 'Wins', values: [12, Infinity, 9] }] }), /"2022"/);
  assert.match(err({ ...WINS, series: [{ name: 'Wins', values: [12, 'about 7', 9] }] }), /unit\.prefix/);
});

test('plain numerals written as text are the exact number written down', () => {
  const r = validateChartSpec({ ...WINS, series: [{ name: 'Wins', values: ['12', '1,234', '-3.5'] }] });
  assert.ok(r.ok);
  assert.deepEqual(r.spec.series[0]!.values, [12, 1234, -3.5]);
});

test('pie rules: one series, no negatives, at most 8 slices (barh suggested)', () => {
  const pie = { type: 'pie', categories: ['A', 'B'], series: [{ name: 'Share', values: [3, 5] }] };
  assert.ok(validateChartSpec(pie).ok);
  assert.match(err({ ...pie, series: [{ name: 'Share', values: [3, -5] }] }), /negative share \("B" = -5\)/);
  assert.match(err({ ...pie, series: [pie.series[0], pie.series[0]] }), /ONE series/);
  const nine = Array.from({ length: 9 }, (_, i) => `Horse ${i + 1}`);
  assert.match(err({ type: 'donut', categories: nine, series: [{ name: 'x', values: nine.map(() => 1) }] }), /barh/);
  assert.match(err({ ...pie, series: [{ name: 'Share', values: [0, 0] }] }), /above zero/);
});

test('a line needs two points; unknown types and stray highlights are named', () => {
  assert.match(err({ type: 'line', categories: ['2024'], series: [{ name: 'x', values: [1] }] }), /at least 2 points/);
  assert.match(err({ ...WINS, type: 'scatter' }), /Unknown chart type "scatter"/);
  assert.match(err({ ...WINS, highlight: '2030' }), /highlight "2030" is not one of the categories/);
  assert.match(err({ ...WINS, type: 'pie', stacked: true }), /stacked applies to bar and barh/);
});

test('too many categories or series is refused with the limit', () => {
  const cats = Array.from({ length: 25 }, (_, i) => `C${i}`);
  assert.match(err({ type: 'bar', categories: cats, series: [{ name: 'x', values: cats.map(() => 1) }] }), /at most 24/);
  const s = { name: 's', values: [1, 2, 3] };
  assert.match(err({ ...WINS, series: [s, s, s, s, s] }), /at most 4/);
  assert.ok(validateChartSpec({ ...WINS, type: 'table', series: [s, s, s, s, s, s] }).ok);
});

test('friendly type names are accepted; the highlight takes the category\'s own spelling', () => {
  const r = validateChartSpec({ ...WINS, type: 'Column', highlight: ' 2023 ' });
  assert.ok(r.ok);
  assert.equal(r.spec.type, 'bar');
  assert.equal(r.spec.highlight, '2023');
  const h = validateChartSpec({ ...WINS, type: 'doughnut', series: [{ name: 'x', values: [1, 2, 3] }] });
  assert.ok(h.ok);
  assert.equal(h.spec.type, 'donut');
});

test('units keep their own spacing (" wins")', () => {
  const r = validateChartSpec({ ...WINS, unit: { suffix: ' wins' } });
  assert.ok(r.ok);
  assert.equal(r.spec.unit?.suffix, ' wins');
});

// ── formatting ───────────────────────────────────────────────────────────────

test('values: decimals, NZ$ prefix, % suffix, thousands, negatives', () => {
  const money = { unit: { prefix: 'NZ$' }, series: [{ name: 'x', values: [1] }] };
  assert.equal(formatChartValue(1234567, money), 'NZ$1,234,567');
  assert.equal(formatChartValue(-1250.5, { ...money, decimals: 2 }), '-NZ$1,250.50');
  assert.equal(formatChartValue(12.345, { unit: { suffix: '%' }, decimals: 1, series: [] }), '12.3%');
  assert.equal(formatChartValue(7, { unit: { suffix: ' wins' }, series: [] }), '7 wins');
  // A value that rounds to zero carries no sign.
  assert.equal(formatChartValue(-0.001, { decimals: 0, series: [] }), '0');
});

test('decimals default to what the data itself has, at most 2', () => {
  assert.equal(chartDecimals({ series: [{ name: 'x', values: [1, 2, 3] }] }), 0);
  assert.equal(chartDecimals({ series: [{ name: 'x', values: [1.5, 2] }] }), 1);
  assert.equal(chartDecimals({ series: [{ name: 'x', values: [1 / 3] }] }), 2);
  assert.equal(chartDecimals({ decimals: 0, series: [{ name: 'x', values: [1.5] }] }), 0);
});

test('compact form for tight spaces', () => {
  assert.equal(compactChartValue(1500000, { unit: { prefix: '$' } }), '$1.5m');
  assert.equal(compactChartValue(25000, {}), '25k');
  assert.equal(compactChartValue(3_100_000_000, {}), '3.1bn');
  assert.equal(compactChartValue(950, {}), '950');
});

// ── alt + data echo ──────────────────────────────────────────────────────────

test('chartAlt and dataEcho contain every category = value', () => {
  const alt = chartAlt(WINS);
  const echo = dataEcho(WINS);
  for (const pair of ['2021 = 12', '2022 = 15', '2023 = 9']) {
    assert.ok(alt.includes(pair), `alt is missing ${pair}`);
    assert.ok(echo.includes(pair), `echo is missing ${pair}`);
  }
  assert.match(alt, /^Bar chart — Wins by season:/);
  const multi: ChartSpec = { ...WINS, series: [WINS.series[0]!, { name: 'Places', values: [4, 6, 2] }], unit: { prefix: 'NZ$' } };
  const e = dataEcho(multi);
  assert.match(e, /Wins: 2021 = NZ\$12/);
  assert.match(e, /Places: 2021 = NZ\$4, 2022 = NZ\$6, 2023 = NZ\$2/);
});

test('a big chart keeps its alt within the stored limit, with whole values and a count', () => {
  const cats = Array.from({ length: 24 }, (_, i) => `Horse number ${i + 1}`);
  const big: ChartSpec = { type: 'barh', categories: cats, series: [{ name: 'Prize money', values: cats.map((_, i) => 100000 + i) }], unit: { prefix: 'NZ$' } };
  const alt = chartAlt(big);
  assert.ok(Array.from(alt).length <= CHART_ALT_MAX);
  assert.match(alt, /… \(24 values\)$/);
  // The data echo is never cut: it is how the model checks the numbers.
  assert.ok(dataEcho(big).includes('Horse number 24 = NZ$100,023'));
});

// ── the image-model guard ────────────────────────────────────────────────────

test('looksLikeChartRequest: charts yes; bars, pies, tables and plots of land no', () => {
  for (const yes of [
    'bar chart of wins by year',
    'graph of prize money',
    'a pie chart of the yard\'s runners',
    'an infographic about the season',
    'line graph showing earnings',
    'a table of results for 2024',
    'with an x-axis of months',
  ]) {
    assert.equal(looksLikeChartRequest(yes), true, yes);
  }
  for (const no of [
    'horse jumping a bar',
    'apple pie on a table',
    'a picnic table at the races',
    'a plot of land by the river',
    'a photograph of a grey mare',
    'a graphic poster for the spring carnival',
  ]) {
    assert.equal(looksLikeChartRequest(no), false, no);
  }
});

test('the guard lets ONLY a decorative illustration through', () => {
  assert.equal(chartRequestBlocked('bar chart of wins'), true);
  assert.equal(chartRequestBlocked('bar chart of wins', { style: 'illustration' }), true);
  assert.equal(chartRequestBlocked('bar chart of wins', { style: 'photo', decorative: true }), true);
  assert.equal(chartRequestBlocked('abstract chart shapes as a background', { style: 'illustration', decorative: true }), false);
  assert.equal(chartRequestBlocked('a grey horse in the mist'), false);
});

// ── edits ────────────────────────────────────────────────────────────────────

test('"change 2023 to 14" edits one number and keeps the rest', () => {
  const r = applyChartChanges(WINS, { setValues: [{ category: '2023', value: 14 }] });
  assert.ok(r.ok);
  assert.deepEqual(r.spec.series[0]!.values, [12, 15, 14]);
  assert.equal(r.spec.title, 'Wins by season');
  // The stored spec is not mutated.
  assert.deepEqual(WINS.series[0]!.values, [12, 15, 9]);
});

test('edits name what is wrong: unknown category, ambiguous series', () => {
  const bad = applyChartChanges(WINS, { setValues: [{ category: '2030', value: 1 }] });
  assert.equal(bad.ok, false);
  assert.match((bad as { error: string }).error, /no category "2030".*2021, 2022, 2023/);
  const two: ChartSpec = { ...WINS, series: [WINS.series[0]!, { name: 'Places', values: [1, 2, 3] }] };
  const amb = applyChartChanges(two, { setValues: [{ category: '2022', value: 1 }] });
  assert.equal(amb.ok, false);
  assert.match((amb as { error: string }).error, /name which one/);
  const ok = applyChartChanges(two, { setValues: [{ category: '2022', series: 'places', value: 9 }] });
  assert.ok(ok.ok);
  assert.deepEqual(ok.spec.series[1]!.values, [1, 9, 3]);
});

test('a type change, a removed title and new categories without values', () => {
  const r = applyChartChanges(WINS, { type: 'line', title: '' });
  assert.ok(r.ok);
  assert.equal(r.spec.type, 'line');
  assert.equal(r.spec.title, undefined);
  const mismatch = applyChartChanges(WINS, { categories: ['a', 'b'] });
  assert.equal(mismatch.ok, false);
  assert.match((mismatch as { error: string }).error, /Send the series/);
  const relabel = applyChartChanges({ ...WINS, highlight: '2023' }, { categories: ['21', '22', '23'] });
  assert.ok(relabel.ok);
  assert.equal(relabel.spec.highlight, undefined);
  assert.deepEqual(relabel.spec.series[0]!.values, [12, 15, 9]);
});

test('a stacked bar chart can become a line chart or a table (stacking is dropped, not refused)', () => {
  const stacked: ChartSpec = { ...WINS, type: 'bar', stacked: true, series: [WINS.series[0]!, { name: 'Places', values: [1, 2, 3] }] };
  for (const type of ['line', 'table', 'pie'] as const) {
    const r = applyChartChanges(type === 'pie' ? { ...stacked, series: [WINS.series[0]!] } : stacked, { type });
    assert.ok(r.ok, `${type}: ${(r as { error?: string }).error ?? ''}`);
    assert.equal(r.spec.type, type);
    assert.equal(r.spec.stacked, undefined);
  }
  // bar → barh keeps the stacking.
  const flipped = applyChartChanges(stacked, { type: 'barh' });
  assert.ok(flipped.ok);
  assert.equal(flipped.spec.stacked, true);
  // Asking for a stacked line outright is still refused, with the reason.
  const asked = applyChartChanges(stacked, { type: 'line', stacked: true });
  assert.equal(asked.ok, false);
  assert.match((asked as { error: string }).error, /stacked applies to bar and barh/);
});

test('the words a poster or graphic prints do not make it a chart request', () => {
  const poster = 'a poster for the open day reading "Chart your course to the Cup", gold on navy';
  assert.equal(chartRequestBlocked(poster, { style: 'poster' }), false);
  assert.equal(chartRequestBlocked('a flat graphic with the words “Graph of champions”', { style: 'graphic' }), false);
  // The description outside the quotes still decides.
  assert.equal(chartRequestBlocked('a poster with a bar chart of wins and the title "Season"', { style: 'poster' }), true);
  // A photo or illustration brief is judged whole: it has no words to print.
  assert.equal(chartRequestBlocked(poster, { style: 'photo' }), true);
  assert.equal(chartRequestBlocked(poster), true);
  assert.equal(withoutQuotedWords('a "chart" and “graph” here, "unpaired'), 'a   and   here, "unpaired');
});
