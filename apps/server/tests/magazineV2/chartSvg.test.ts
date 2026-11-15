// ---------------------------------------------------------------------------
// chartSvg draws the numbers, exactly: bar heights proportional to the values on a
// zero baseline (negatives below it), stacks that sum, pie angles that are the shares
// of 360°, line points left to right, a viewBox that IS the box, every string escaped,
// long labels ellipsized to their measured slot, and byte-identical output for the
// same input. Pure — the SVG is parsed with regexes, no browser.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chartSvg, ellipsize, niceTicks, wrapText } from '../../src/lib/magazineV2/chartSvg.js';
import type { ChartSpec } from '../../src/lib/magazineV2/chartSpec.js';
import type { ChartTheme } from '../../src/lib/magazineV2/chartTheme.js';
import { measureRunWidthPx } from '../../src/lib/magazineV2/fontMetrics.js';
import { stripActiveSvg } from '../../src/lib/magazineV2/renderPreview.js';

const THEME: ChartTheme = {
  colors: ['#0b1f3a', '#c8102e', '#2e7d5b', '#7a4a2a', '#6b3fa0', '#00838f', '#455a64', '#b7791f'],
  accent: '#c8102e',
  text: '#111111',
  muted: '#555555',
  grid: '#dddddd',
  bg: '#ffffff',
  stripe: '#f3f3f3',
  fontBody: 'Inter, Arial, sans-serif',
  fontDisplay: 'Playfair Display, Georgia, serif',
};

const SIZE = { width: 900, height: 560 };

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1]!] = m[2]!;
  return out;
}
function tags(svg: string, name: string, cls?: string): Record<string, string>[] {
  const re = new RegExp(`<${name}\\b[^>]*>`, 'g');
  return [...svg.matchAll(re)].map((m) => attrs(m[0])).filter((a) => !cls || a.class === cls);
}
function texts(svg: string): { a: Record<string, string>; body: string }[] {
  return [...svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)].map((m) => ({ a: attrs(m[1]!), body: m[2]! }));
}
const num = (s: string | undefined) => Number(s);

test('bar heights are proportional to the values (to 0.5px) on a shared zero line', () => {
  const spec: ChartSpec = { type: 'bar', title: 'Wins by season', categories: ['2021', '2022', '2023', '2024'], series: [{ name: 'Wins', values: [12, 18, 25, 7] }] };
  const { svg } = chartSvg(spec, THEME, SIZE);
  const bars = tags(svg, 'rect', 'bar');
  assert.equal(bars.length, 4);
  const zero = tags(svg, 'line', 'zero')[0]!;
  const zeroY = num(zero.y1);
  const k = num(bars[0]!.height) / 12;
  bars.forEach((b, i) => {
    const v = spec.series[0]!.values[i]!;
    assert.equal(num(b['data-value']), v);
    assert.ok(Math.abs(num(b.height) - v * k) <= 0.5, `bar ${i}: ${b.height} vs ${v * k}`);
    assert.ok(Math.abs(num(b.y) + num(b.height) - zeroY) <= 0.02, 'every bar stands on the zero line');
  });
  // Every value is printed.
  for (const v of ['12', '18', '25', '7']) assert.ok(texts(svg).some((t) => t.body === v), `value ${v} printed`);
});

test('negative values draw BELOW the zero line, positives above', () => {
  const spec: ChartSpec = { type: 'bar', categories: ['Q1', 'Q2', 'Q3'], series: [{ name: 'Margin', values: [8, -5, 3] }] };
  const { svg } = chartSvg(spec, THEME, SIZE);
  const zeroY = num(tags(svg, 'line', 'zero')[0]!.y1);
  for (const b of tags(svg, 'rect', 'bar')) {
    const v = num(b['data-value']);
    if (v < 0) assert.ok(num(b.y) >= zeroY - 0.02, 'negative bar starts at the zero line and goes down');
    else assert.ok(num(b.y) + num(b.height) <= zeroY + 0.02, 'positive bar ends at the zero line');
  }
  const neg = tags(svg, 'rect', 'bar').find((b) => b['data-value'] === '-5')!;
  const pos = tags(svg, 'rect', 'bar').find((b) => b['data-value'] === '8')!;
  assert.ok(Math.abs(num(neg.height) / 5 - num(pos.height) / 8) < 0.2, 'one scale on both sides of zero');
});

test('stacked bars: each stack is the sum of its segments', () => {
  const spec: ChartSpec = {
    type: 'bar',
    stacked: true,
    categories: ['2023', '2024'],
    series: [
      { name: 'Wins', values: [4, 6] },
      { name: 'Places', values: [3, 9] },
    ],
  };
  const { svg } = chartSvg(spec, THEME, SIZE);
  const bars = tags(svg, 'rect', 'bar');
  assert.equal(bars.length, 4);
  const k = num(bars[0]!.height) / 4;
  for (const cat of ['2023', '2024']) {
    const segs = bars.filter((b) => b['data-cat'] === cat);
    const total = segs.reduce((a, b) => a + num(b['data-value']), 0);
    const height = segs.reduce((a, b) => a + num(b.height), 0);
    assert.ok(Math.abs(height - total * k) <= 0.5, `${cat}: ${height} vs ${total * k}`);
    // Segments touch: the top of one is the bottom of the next.
    const [lower, upper] = [...segs].sort((a, b) => num(b.y) - num(a.y));
    assert.ok(Math.abs(num(upper!.y) + num(upper!.height) - num(lower!.y)) <= 0.02);
  }
  // Totals are printed.
  assert.ok(texts(svg).some((t) => t.body === '7'));
  assert.ok(texts(svg).some((t) => t.body === '15'));
});

test('pie: slice angles are the shares of 360°, summing to 360', () => {
  const spec: ChartSpec = { type: 'pie', title: 'Starters by state', categories: ['NSW', 'VIC', 'QLD', 'NZ'], series: [{ name: 'Starters', values: [40, 30, 20, 10] }] };
  const { svg } = chartSvg(spec, THEME, SIZE);
  const slices = tags(svg, 'path', 'slice');
  assert.equal(slices.length, 4);
  const sweeps = slices.map((s) => num(s['data-end']) - num(s['data-start']));
  assert.ok(Math.abs(sweeps.reduce((a, b) => a + b, 0) - 360) < 0.1);
  sweeps.forEach((sw, i) => assert.ok(Math.abs(sw - (spec.series[0]!.values[i]! / 100) * 360) < 0.05, `slice ${i}: ${sw}`));
  // Consecutive: each slice starts where the last ended.
  for (let i = 1; i < slices.length; i++) assert.ok(Math.abs(num(slices[i]!['data-start']) - num(slices[i - 1]!['data-end'])) < 0.02);
  // The legend carries every category with its value and share.
  assert.ok(svg.includes('NSW') && svg.includes('40 (40%)'));
});

test('donut: every slice is a ring segment (outer and inner arc), with the total in the hole', () => {
  const spec: ChartSpec = { type: 'donut', categories: ['Wins', 'Places', 'Unplaced'], series: [{ name: 'Starts', values: [5, 8, 12] }] };
  const { svg } = chartSvg(spec, THEME, SIZE);
  for (const s of tags(svg, 'path', 'slice')) {
    const arcs = [...s.d!.matchAll(/A([\d.]+),([\d.]+)/g)].map((m) => Number(m[1]));
    assert.equal(arcs.length, 2, 'outer + inner arc');
    assert.ok(arcs[1]! < arcs[0]! * 0.7, 'the inner radius leaves a hole');
  }
  assert.ok(texts(svg).some((t) => t.body === '25'), 'total in the hole');
});

test('a single 100% slice is drawn as a whole circle, not a degenerate arc', () => {
  const spec: ChartSpec = { type: 'pie', categories: ['All', 'None'], series: [{ name: 'x', values: [10, 0] }] };
  const { svg } = chartSvg(spec, THEME, SIZE);
  const slices = tags(svg, 'path', 'slice');
  assert.equal(slices.length, 1);
  assert.match(slices[0]!.d!, /a[\d.]+,[\d.]+ 0 1,0/);
});

test('line: points run left to right, one per category, with the values on the scale', () => {
  const spec: ChartSpec = { type: 'line', categories: ['Jan', 'Feb', 'Mar', 'Apr', 'May'], series: [{ name: 'Runners', values: [3, 5, 4, 9, 7] }] };
  const { svg } = chartSvg(spec, THEME, SIZE);
  const pts = tags(svg, 'circle', 'point');
  assert.equal(pts.length, 5);
  for (let i = 1; i < pts.length; i++) assert.ok(num(pts[i]!.cx) > num(pts[i - 1]!.cx), 'monotonic in x');
  // Higher value → higher on the page (smaller y).
  const byValue = [...pts].sort((a, b) => num(a['data-value']) - num(b['data-value']));
  for (let i = 1; i < byValue.length; i++) assert.ok(num(byValue[i]!.cy) < num(byValue[i - 1]!.cy));
  assert.equal(tags(svg, 'polyline').length, 1);
});

test('the viewBox is exactly the box, so fit "contain" has no letterbox', () => {
  for (const size of [{ width: 900, height: 560 }, { width: 400, height: 700 }, { width: 1092.4, height: 300.6 }]) {
    const { svg } = chartSvg({ type: 'bar', categories: ['a'], series: [{ name: 'x', values: [1] }] }, THEME, size);
    const root = attrs(/<svg\b[^>]*>/.exec(svg)![0]);
    const [, , w, h] = root.viewBox!.split(' ').map(Number);
    assert.equal(w, Math.round(size.width));
    assert.equal(h, Math.round(size.height));
    assert.equal(root.width, String(Math.round(size.width)));
  }
});

test('every string is XML-escaped', () => {
  const spec: ChartSpec = {
    type: 'barh',
    title: '<script>alert(1)</script>',
    subtitle: 'Fish & "chips"',
    source: "O'Brien <data>",
    categories: ['A & B', '<img src=x onerror=alert(1)>'],
    series: [{ name: 'S"1', values: [1, 2] }],
  };
  const { svg } = chartSvg(spec, THEME, SIZE);
  assert.ok(!svg.includes('<script'), 'no live script tag');
  assert.ok(!svg.includes('<img'), 'no live img tag');
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('A &amp; B'));
  assert.ok(svg.includes('Fish &amp; &quot;chips&quot;'));
  assert.ok(svg.includes('data-series="S&quot;1"'));
});

test('the rasteriser\'s sanitiser leaves a chart untouched, even with hostile labels', () => {
  const spec: ChartSpec = {
    type: 'bar',
    title: 'x onerror=alert(1) href=javascript:alert(2)',
    categories: ['a onload=steal()', '<svg onload=x>', 'b'],
    series: [{ name: 'n onclick="y"', values: [1, 2, 3] }],
  };
  const { svg } = chartSvg(spec, THEME, SIZE);
  assert.equal(stripActiveSvg(svg), svg, 'nothing in the chart looks like an active attribute');
  // Every bar keeps its full, intact attribute list.
  assert.equal(tags(svg, 'rect', 'bar').length, 3);
});

test('long horse names are ellipsized to their measured label column', () => {
  const long = 'Sir Lancelot of the Very Long Name Stakes Winner Twenty Twenty Four';
  const spec: ChartSpec = { type: 'barh', categories: [long, 'Short'], series: [{ name: 'Wins', values: [9, 4] }] };
  const size = { width: 420, height: 320 };
  const { svg } = chartSvg(spec, THEME, size);
  // (It survives only in the bar's data-cat attribute, which is not drawn.)
  assert.ok(!texts(svg).some((t) => t.body.includes(long)), 'the full name does not fit and is not drawn');
  const label = texts(svg).find((t) => t.body.startsWith('Sir Lancelot'))!;
  assert.ok(label.body.endsWith('…'));
  // pad = max(8, round(min(420, 480) * 0.035)) = 15 → the label column is at most 38% of 390px.
  const width = measureRunWidthPx(label.body, label.a['font-family']!.replace(/&apos;/g, "'"), Number(label.a['font-weight']), Number(label.a['font-size'])) * 1.1;
  assert.ok(width <= 0.38 * (420 - 2 * 15) + 0.5, `label ${width}px`);
  assert.ok(svg.includes('>Short<'));
});

test('bar labels too wide for their slot are shortened, never left overlapping', () => {
  const cats = ['Melbourne Cup Carnival', 'Cox Plate Day', 'Caulfield Cup Day', 'Derby Day', 'Oaks Day', 'Stakes Day'];
  const spec: ChartSpec = { type: 'bar', categories: cats, series: [{ name: 'Crowd', values: [90, 40, 35, 80, 50, 30] }] };
  const { svg } = chartSvg(spec, THEME, { width: 500, height: 360 });
  const drawn = texts(svg).filter((t) => t.a['text-anchor'] === 'middle' && cats.some((c) => c.startsWith(t.body.replace('…', '').trim())) && t.body.length > 0);
  assert.ok(drawn.some((t) => t.body.endsWith('…')), 'at least the long ones are cut');
});

test('a table prints every figure, right-aligned, with zebra rows', () => {
  const spec: ChartSpec = {
    type: 'table',
    title: 'Season summary',
    categories: ['Starts', 'Wins', 'Prize money'],
    series: [
      { name: '2023', values: [12, 3, 154000] },
      { name: '2024', values: [15, 5, 281500] },
    ],
    unit: { prefix: '$' },
  };
  const { svg } = chartSvg(spec, THEME, SIZE);
  for (const v of ['$12', '$3', '$154,000', '$15', '$5', '$281,500']) {
    const cell = texts(svg).find((t) => t.body === v);
    assert.ok(cell, `${v} printed`);
    assert.equal(cell.a['text-anchor'], 'end');
  }
  assert.ok(tags(svg, 'rect').some((r) => r.fill === THEME.stripe), 'zebra stripe');
});

test('the same input gives a byte-identical SVG; fonts used are reported', () => {
  const spec: ChartSpec = { type: 'line', title: 'Trend', categories: ['a', 'b', 'c'], series: [{ name: 'x', values: [1.5, 2.25, 3] }, { name: 'y', values: [3, 2, 1] }] };
  const a = chartSvg(spec, THEME, SIZE);
  const b = chartSvg(spec, THEME, SIZE);
  assert.equal(a.svg, b.svg);
  assert.deepEqual(a.fontFamilies, ['Playfair Display', 'Inter']);
  // No title, no display face.
  assert.deepEqual(chartSvg({ ...spec, title: undefined }, THEME, SIZE).fontFamilies, ['Inter']);
});

test('the highlighted category is drawn in the accent', () => {
  const spec: ChartSpec = { type: 'bar', highlight: '2024', categories: ['2022', '2023', '2024'], series: [{ name: 'Wins', values: [3, 4, 9] }] };
  const bars = tags(chartSvg(spec, THEME, SIZE).svg, 'rect', 'bar');
  assert.equal(bars.find((b) => b['data-cat'] === '2024')!.fill, THEME.accent);
  assert.equal(bars.find((b) => b['data-cat'] === '2022')!.fill, THEME.colors[0]);
});

test('niceTicks: round steps that cover the data, zero kept, flat data opened up', () => {
  const t = niceTicks(0, 25, 5);
  assert.equal(t.ticks[0], 0);
  assert.ok(t.max >= 25);
  assert.ok([1, 2, 5, 10].includes(t.step / 10 ** Math.floor(Math.log10(t.step))));
  const neg = niceTicks(-7, 12, 5);
  assert.ok(neg.min <= -7 && neg.max >= 12 && neg.ticks.includes(0));
  assert.deepEqual(niceTicks(0, 0).ticks.slice(0, 1), [0]);
  assert.ok(niceTicks(0, 0).max > 0);
  const small = niceTicks(0, 0.3, 4);
  assert.ok(small.ticks.every((v) => Number(v.toFixed(6)) === v), 'no floating-point dust in the ticks');
});

test('ellipsize / wrapText stay inside the width they are given', () => {
  const f = { family: 'Inter, Arial, sans-serif', weight: 400, size: 20 };
  const s = ellipsize('A very long label that will not fit', 120, f);
  assert.ok(s.endsWith('…'));
  assert.ok(measureRunWidthPx(s, f.family, 400, 20) * 1.1 <= 120);
  const lines = wrapText('One two three four five six seven eight nine ten eleven twelve', 160, f, 2);
  assert.equal(lines.length, 2);
  assert.ok(lines[1]!.endsWith('…'));
});
