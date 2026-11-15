// The pure rules behind the Studio agent's add tools (agentAddPure.ts).
//
// What these pin, finding by finding:
//   C07/C38/C51  a new element is VISIBLE: pictures, charts, text and QR codes go on
//                top; a new shape goes above the pictures it overlaps and below the
//                words (a scrim at the top of the stack dims the headline it rescues);
//   C55          new text is set in the page's own type for its role, never 'inherit';
//   C08/C39/C52  a chart, logo or poster shows whole, in a box of its own shape;
//   C16          the review line for a chart carries its numbers;
//   C43          list_media shows this page's pictures, then the newest, and can search;
//   C40          a generated picture is made at the ratio nearest its box.
//
// Run: npx tsx --test tests/magazineV2/agentAddPure.test.ts   (from apps/server)

import test from 'node:test';
import assert from 'node:assert/strict';
import type { MagazineElement } from '../../src/lib/magazineV2/model.ts';
import type { ChartSpec } from '../../src/lib/magazineV2/chartSpec.ts';
import { MAX_SUMMARY_CHARS } from '../../src/lib/magazineV2/studioRequests.ts';
import {
  briefLabel,
  CHART_VALUES_MAX_CHARS,
  chartLabel,
  chartValuesLine,
  clampBoxToPage,
  contrastOn,
  coveredBy,
  coverWarning,
  FALLBACK_TEXT_FONT,
  fitBoxToAspect,
  fitReport,
  frontZ,
  generatedImagePlacement,
  groundColorUnder,
  growTextToFit,
  hasTimeFor,
  imageStyleNoun,
  isGraphicMedia,
  isTextRole,
  layerForShape,
  listMediaView,
  MAX_IMAGES_PER_TURN,
  MAX_Z,
  mediaAspect,
  MIN_CHART_BOX,
  NO_ROOM_FOR_CHART,
  outOfTime,
  placementBox,
  placementFit,
  ratioValue,
  readableOn,
  resolveChartPlacement,
  styleForRole,
  themeImageLook,
  takeImageSlot,
} from '../../src/lib/magazineV2/agentAddPure.ts';

const PAGE = { width: 1240, height: 1754 };

let seq = 0;
function text(o: Partial<MagazineElement> & { t?: Partial<NonNullable<MagazineElement['text']>> } = {}): MagazineElement {
  const { t, ...rest } = o;
  return {
    id: `t${++seq}`,
    type: 'text',
    x: 100,
    y: 100,
    w: 500,
    h: 120,
    rotation: 0,
    zIndex: 1,
    locked: false,
    source: 'ai-agent',
    text: {
      content: 'Hello there',
      role: 'body',
      fontFamily: '"Source Serif 4", Georgia, serif',
      fontSize: 20,
      maxFontSize: 20,
      fontWeight: 400,
      color: '#222222',
      align: 'left',
      lineHeight: 1.45,
      autoFit: 'shrink',
      ...t,
    },
    ...rest,
  } as MagazineElement;
}
function image(o: Partial<MagazineElement> & { url?: string; alt?: string } = {}): MagazineElement {
  const { url = 'https://cdn.example.com/a.jpg', alt = 'A photo', ...rest } = o;
  return {
    id: `i${++seq}`,
    type: 'image',
    x: 0,
    y: 0,
    w: 600,
    h: 400,
    rotation: 0,
    zIndex: 0,
    locked: false,
    source: 'ai-agent',
    image: { url, assetId: '', alt, fit: 'cover' },
    ...rest,
  } as MagazineElement;
}
function shape(o: Partial<MagazineElement> & { fill?: string; opacity?: number } = {}): MagazineElement {
  const { fill = '#0a2342', opacity, ...rest } = o;
  return {
    id: `s${++seq}`,
    type: 'shape',
    x: 0,
    y: 0,
    w: 300,
    h: 300,
    rotation: 0,
    zIndex: 0,
    locked: false,
    source: 'ai-agent',
    shape: { fill, ...(opacity !== undefined ? { opacity } : {}) },
    ...rest,
  } as MagazineElement;
}
const spec = (o: Partial<ChartSpec> = {}): ChartSpec => ({
  type: 'bar',
  title: 'Wins by season',
  categories: ['2022', '2023', '2024'],
  series: [{ name: 'Wins', values: [12, 18, 25] }],
  ...o,
});

// ── geometry ─────────────────────────────────────────────────────────────────

test('clampBoxToPage keeps the whole box on the page, pulling the origin back', () => {
  assert.deepEqual(clampBoxToPage({ x: 1200, y: 10, w: 300, h: 100 }, PAGE), { x: 940, y: 10, w: 300, h: 100 });
  assert.deepEqual(clampBoxToPage({ x: -50, y: -5, w: 5000, h: 100 }, PAGE), { x: 0, y: 0, w: 1240, h: 100 });
  const b = clampBoxToPage({ x: 1139.5, y: 0, w: 100.5, h: 10.4 }, PAGE);
  assert.ok(b.x + b.w <= PAGE.width, 'rounding never pushes the far edge off the page');
  assert.deepEqual(clampBoxToPage({ x: NaN, y: 0, w: Infinity, h: 50 }, PAGE), { x: 0, y: 0, w: 200, h: 50 });
});

test('fitBoxToAspect: the largest box of the shape, centred inside', () => {
  const wide = fitBoxToAspect({ x: 100, y: 100, w: 800, h: 800 }, 2);
  assert.deepEqual(wide, { x: 100, y: 300, w: 800, h: 400 });
  const tall = fitBoxToAspect({ x: 0, y: 0, w: 800, h: 400 }, 0.5);
  assert.deepEqual(tall, { x: 300, y: 0, w: 200, h: 400 });
  assert.deepEqual(fitBoxToAspect({ x: 1, y: 2, w: 3, h: 4 }, undefined), { x: 1, y: 2, w: 3, h: 4 });
  assert.equal(ratioValue('16:9'), 16 / 9);
  assert.equal(ratioValue('nonsense'), undefined);
});

// ── layer ────────────────────────────────────────────────────────────────────

test('frontZ: on top of everything already staged, capped at 9999 (C51)', () => {
  assert.equal(frontZ([]), 1);
  assert.equal(frontZ([{ zIndex: 4 }, { zIndex: 990 }, { zIndex: 2 }]), 991);
  assert.equal(frontZ([{ zIndex: MAX_Z }]), MAX_Z);
});

test('a scrim over a photo goes above the photo and below the headline (C51 verifier)', () => {
  const photo = image({ id: 'ph', x: 0, y: 0, w: 1240, h: 900, zIndex: 8 });
  const head = text({ id: 'hd', x: 80, y: 600, w: 900, h: 200, zIndex: 12, t: { role: 'headline' } });
  const plan = layerForShape([photo, head], { x: 0, y: 500, w: 1240, h: 400 }, { page: PAGE, opacity: 0.5 });
  assert.equal(plan.mode, 'behind-text');
  assert.equal(plan.zIndex, 9);
  assert.deepEqual(plan.lift, []);
});

test('on a copied PDF page (photos at 0, text at 1) the words are raised to stay in front', () => {
  const photo = image({ id: 'ph', x: 0, y: 0, w: 800, h: 600, zIndex: 0 });
  const t1 = text({ id: 'a', x: 50, y: 400, w: 600, h: 80, zIndex: 1 });
  const t2 = text({ id: 'b', x: 50, y: 500, w: 600, h: 80, zIndex: 2 });
  const plan = layerForShape([photo, t1, t2], { x: 0, y: 380, w: 800, h: 220 }, { page: PAGE, opacity: 0.4 });
  assert.equal(plan.zIndex, 1);
  // a (1) and b (2) keep their order, both above the new shape at 1.
  assert.deepEqual(plan.lift, [
    { id: 'a', zIndex: 2 },
    { id: 'b', zIndex: 3 },
  ]);
});

test('text a photo already hides is not brought back; no words overlapped → on top', () => {
  const hidden = text({ id: 'h', x: 10, y: 10, w: 100, h: 50, zIndex: 0 });
  const photo = image({ id: 'ph', x: 0, y: 0, w: 600, h: 400, zIndex: 3 });
  const plan = layerForShape([hidden, photo], { x: 0, y: 0, w: 600, h: 400 }, { page: PAGE, opacity: 0.4 });
  assert.equal(plan.mode, 'front');
  assert.equal(plan.zIndex, 4);
  assert.deepEqual(plan.lift, []);
  assert.equal(layerForShape([photo], { x: 900, y: 900, w: 100, h: 100 }, { page: PAGE }).zIndex, 4);
});

test('an opaque full-page shape is a background: under everything, order kept', () => {
  const els = [image({ id: 'p', zIndex: 0 }), text({ id: 'x', zIndex: 1 }), text({ id: 'y', zIndex: 1 }), text({ id: 'z', zIndex: 5 })];
  const plan = layerForShape(els, { x: 0, y: 0, w: 1240, h: 1754 }, { page: PAGE });
  assert.equal(plan.mode, 'background');
  assert.equal(plan.zIndex, 0);
  assert.deepEqual(plan.lift, [
    { id: 'p', zIndex: 1 },
    { id: 'x', zIndex: 2 },
    { id: 'y', zIndex: 2 },
  ]);
});

test('layer "front" puts a shape on top whatever it overlaps', () => {
  const head = text({ id: 'hd', zIndex: 12 });
  assert.deepEqual(layerForShape([head], { x: 100, y: 100, w: 100, h: 100 }, { page: PAGE, layer: 'front' }), { zIndex: 13, lift: [], mode: 'front' });
});

// ── typography ───────────────────────────────────────────────────────────────

test('styleForRole copies the page’s main text of that role, ceiling included (C55)', () => {
  const els = [
    text({ t: { content: 'Short', fontSize: 30, color: '#ff0000' } }),
    text({ t: { content: 'The New Owners Group is embarking on one of the most significant initiatives in years.', fontSize: 16, maxFontSize: 19, minFontSize: 14 } }),
    text({ t: { role: 'headline', content: 'Big News', fontSize: 72, fontWeight: 800, fontFamily: 'Playfair Display, serif' } }),
  ];
  const s = styleForRole(els, 'body');
  assert.equal(s.from, 'page');
  assert.equal(s.fontFamily, '"Source Serif 4", Georgia, serif');
  assert.equal(s.maxFontSize, 19, 'the ceiling, not the size one box was shrunk to');
  assert.equal(s.minFontSize, 14);
  assert.equal(s.color, '#222222');
  assert.equal(s.lineHeight, 1.45);
  const h = styleForRole(els, 'headline');
  assert.equal(h.fontWeight, 800);
  assert.equal(h.fontFamily, 'Playfair Display, serif');
});

test('styleForRole without that role: the type scale in the issue’s fonts and ink', () => {
  const theme = { fonts: { display: 'Playfair Display, serif', body: 'Inter, sans-serif' }, palette: { text: '#101820', secondary: '#555555', primary: '#003366' } };
  const cap = styleForRole([], 'caption', theme);
  assert.equal(cap.from, 'scale');
  assert.equal(cap.fontFamily, 'Inter, sans-serif');
  assert.equal(cap.color, '#555555');
  assert.equal(cap.maxFontSize, 19);
  assert.equal(cap.minFontSize, 12);
  const quote = styleForRole([], 'pullquote', theme);
  assert.equal(quote.fontFamily, 'Playfair Display, serif');
  assert.equal(quote.align, 'center');
});

test('styleForRole falls back to the page’s own faces, then Georgia — never inherit', () => {
  const page = [text({ t: { role: 'headline', content: 'Title', fontFamily: 'Lora, serif', fontSize: 80 } }), text({ t: { content: 'Copy copy copy', fontFamily: 'Inter, sans-serif' } })];
  assert.equal(styleForRole(page, 'caption').fontFamily, 'Inter, sans-serif');
  assert.equal(styleForRole(page, 'pullquote').fontFamily, 'Lora, serif');
  const inheritOnly = [text({ t: { fontFamily: 'inherit' } })];
  const s = styleForRole(inheritOnly, 'body');
  assert.equal(s.fontFamily, FALLBACK_TEXT_FONT);
  assert.notEqual(s.fontFamily, 'inherit');
  assert.equal(styleForRole([], 'other').maxFontSize, 24, "'other' is set as body copy");
});

test('styleForRole ignores the running head and folio', () => {
  const folio = text({ id: 'furniture-folio', t: { role: 'caption', content: 'Page 4 of the magazine, set small', fontFamily: 'Courier, monospace', fontSize: 11 } });
  assert.equal(styleForRole([folio], 'caption').from, 'scale');
  assert.ok(isTextRole('caption') && !isTextRole('kicker'));
});

test('ground colour and a readable ink for new text', () => {
  const panel = shape({ x: 0, y: 0, w: 600, h: 600, fill: '#0a2342', zIndex: 2 });
  const box = { x: 50, y: 50, w: 300, h: 100 };
  assert.equal(groundColorUnder([panel], box, { ...PAGE, background: { type: 'color', value: '#ffffff' } }), '#0a2342');
  assert.equal(readableOn('#222222', '#0a2342'), '#ffffff');
  assert.equal(readableOn('#222222', '#ffffff'), '#222222');
  assert.equal(readableOn('#222222', null), '#222222');
  assert.equal(groundColorUnder([], box, { ...PAGE, background: { type: 'color', value: '#F5F0E6' } }), '#f5f0e6');
  assert.equal(groundColorUnder([image({ x: 0, y: 0, w: 600, h: 600 })], box, PAGE), null, 'a photo’s colours are unknown');
  assert.equal(groundColorUnder([shape({ w: 600, h: 600, opacity: 0.5 })], box, PAGE), null, 'a see-through scrim is unknown');
  assert.equal(contrastOn('#ffffff', '#ffffff'), 1);
  assert.equal(contrastOn('#000000', null), null);
});

test('growTextToFit takes the free space below, and only when it is enough', () => {
  const long = 'The New Owners Group is embarking on one of the most significant initiatives in years, '.repeat(4);
  const el = text({ id: 'n', x: 100, y: 100, w: 400, h: 60, t: { content: long, fontSize: 24, maxFontSize: 24 } });
  const grown = growTextToFit(el, [], PAGE);
  assert.ok(grown.grewBy > 0);
  assert.ok(grown.el.h > 60);
  // Something right below the box: no room to grow.
  const below = image({ x: 100, y: 170, w: 400, h: 300 });
  const blocked = growTextToFit(el, [below], PAGE);
  assert.equal(blocked.grewBy, 0);
  assert.equal(blocked.el.h, 60);
  assert.equal(blocked.freePx, 10);
  assert.ok((blocked.needPx ?? 0) > 60);
  // Already fits: unchanged.
  assert.equal(growTextToFit(text({ t: { content: 'Hi' } }), [], PAGE).grewBy, 0);
  // A word wider than the box cannot be helped by more height.
  const wide = text({ w: 60, h: 40, t: { content: 'Supercalifragilistic', fontSize: 40, maxFontSize: 40 } });
  assert.equal(growTextToFit(wide, [], PAGE).grewBy, 0);
});

test('fitReport speaks the page check’s numbers', () => {
  const ok = fitReport(text({ t: { content: 'Hi' } }), PAGE);
  assert.equal(ok.fits, true);
  assert.equal(ok.problems, undefined);
  const cut = fitReport(text({ w: 300, h: 30, t: { content: 'word '.repeat(80), fontSize: 24, maxFontSize: 24 } }), PAGE);
  assert.equal(cut.fits, false);
  assert.ok((cut.needPx ?? 0) > (cut.havePx ?? 0));
  assert.ok(cut.problems && cut.problems.length > 0);
});

test('coveredBy names what a new element on top hides — not grounds or shapes', () => {
  const body = text({ id: 'b', x: 100, y: 100, w: 400, h: 200, t: { content: 'Body copy here' } });
  const bg = image({ id: 'bg', x: 0, y: 0, w: 1240, h: 1754 });
  const panel = shape({ id: 'p', x: 0, y: 0, w: 600, h: 600 });
  const empty = text({ id: 'e', x: 100, y: 100, w: 400, h: 200, t: { content: '' } });
  const hit = coveredBy([body, bg, panel, empty], { x: 100, y: 100, w: 400, h: 150 }, PAGE);
  assert.deepEqual(hit.map((e) => e.id), ['b']);
  assert.match(coverWarning(hit)!, /#b/);
  assert.equal(coverWarning([]), undefined);
  assert.deepEqual(coveredBy([body], { x: 100, y: 100, w: 400, h: 150 }, PAGE, ['b']), []);
});

// ── pictures from the library ────────────────────────────────────────────────

test('designed pictures show whole: by kind, by chart source, by an upload’s name (C08/C39)', () => {
  assert.ok(isGraphicMedia({ kind: 'graphic' }));
  assert.ok(isGraphicMedia({ kind: 'photo', source: 'chart' }));
  assert.ok(isGraphicMedia({ kind: 'graphic', source: 'ai-image', imageStyle: 'poster' }));
  assert.ok(isGraphicMedia({ kind: 'upload', alt: 'client-logo.png' }));
  assert.ok(isGraphicMedia({ kind: 'upload', alt: 'Results_Table_2024.png' }));
  assert.ok(!isGraphicMedia({ kind: 'upload', alt: 'IMG_2041.jpg' }));
  assert.ok(!isGraphicMedia({ kind: 'photo', source: 'stock', alt: 'a horse by a table' }));
  assert.ok(!isGraphicMedia(null));
  assert.equal(placementFit({ kind: 'graphic' }), 'contain');
  assert.equal(placementFit({ kind: 'photo' }), 'cover');
  assert.equal(placementFit({ kind: 'graphic' }, 'cover'), 'cover', 'the model’s choice wins');
});

test('a picture shown whole is placed in a box of its own shape', () => {
  assert.equal(mediaAspect({ width: 1600, height: 900 }), 1600 / 900);
  assert.equal(mediaAspect({ chartBox: { w: 800, h: 400 } }), 2);
  assert.equal(mediaAspect({ width: 'x', height: 0 }), undefined);
  const b = placementBox({ x: 100, y: 100, w: 600, h: 600 }, PAGE, 'contain', 16 / 9);
  assert.equal(b.w, 600);
  assert.equal(b.h, Math.floor(600 / (16 / 9)));
  assert.ok(b.y > 100, 'centred in the box asked for');
  assert.deepEqual(placementBox({ x: 100, y: 100, w: 600, h: 600 }, PAGE, 'cover', 16 / 9), { x: 100, y: 100, w: 600, h: 600 });
});

test('listMediaView: this page’s own, then the NEWEST; searchable; says what each is (C43)', () => {
  const rows = [
    { _id: 'old', url: 'https://x/old.jpg', alt: 'Old photo', kind: 'photo', source: 'stock', pageIndex: 7, createdAt: '2026-01-01T00:00:00.000Z' },
    { _id: 'mine', url: 'https://x/mine.jpg', alt: 'This page', kind: 'photo', source: 'extracted', pageIndex: 2, createdAt: '2025-01-01T00:00:00.000Z' },
    { _id: 'logo', url: 'https://x/logo.png', alt: 'client-logo.png', kind: 'upload', source: 'upload', pageIndex: null, createdAt: '2026-11-15T09:00:00.000Z', width: 1200, height: 400 },
    { _id: 'chart', url: 'https://x/c.png', alt: 'Bar chart — Wins', kind: 'graphic', source: 'chart', pageIndex: 2, createdAt: '2026-11-14T00:00:00.000Z' },
    { _id: 'ref', url: 'https://x/ref.jpg', alt: 'their page', kind: 'reference', source: 'upload', createdAt: '2026-11-15T10:00:00.000Z' },
  ];
  const all = listMediaView(rows, 2);
  assert.deepEqual(all.assets.map((a) => a.assetId), ['mine', 'chart', 'logo', 'old'], 'own page first, then newest; never a reference');
  assert.equal(all.total, 4);
  const logo = all.assets.find((a) => a.assetId === 'logo')!;
  assert.equal(logo.size, '1200x400');
  assert.equal(logo.fit, 'contain');
  assert.equal(logo.added, '2026-11-15');
  assert.equal(logo.from, 'uploaded by the user');
  assert.equal(all.assets.find((a) => a.assetId === 'chart')!.chart, true);
  const found = listMediaView(rows, 2, { query: 'logos' });
  assert.deepEqual(found.assets.map((a) => a.assetId), ['logo']);
  assert.equal(found.matched, 1);
  assert.deepEqual(listMediaView(rows, 2, { query: 'chart' }).assets.map((a) => a.assetId), ['chart']);
  assert.equal(listMediaView(rows, 2, { limit: 2 }).assets.length, 2);
});

// ── charts ───────────────────────────────────────────────────────────────────

test('the chart’s review line carries its numbers (C16)', () => {
  assert.equal(chartLabel(spec()), 'a bar chart “Wins by season”');
  assert.equal(chartLabel(spec({ type: 'barh', title: undefined })), 'a horizontal bar chart');
  assert.equal(chartLabel(spec({ stacked: true, series: [{ name: 'A', values: [1, 2, 3] }, { name: 'B', values: [1, 2, 3] }] })), 'a stacked bar chart “Wins by season”');
  assert.equal(chartValuesLine(spec()), '2022 12 · 2023 18 · 2024 25');
  assert.equal(chartValuesLine(spec({ unit: { prefix: 'NZ$' }, series: [{ name: 'Prize', values: [1500, 2000, 12500.5] }] })), '2022 NZ$1,500.0 · 2023 NZ$2,000.0 · 2024 NZ$12,500.5');
  const many = spec({ categories: Array.from({ length: 12 }, (_, i) => `M${i + 1}`), series: [{ name: 'Runs', values: Array.from({ length: 12 }, (_, i) => i) }] });
  assert.match(chartValuesLine(many), /M8 7 · … \(12 values\)$/);
  const two = spec({ series: [{ name: 'Wins', values: [1, 2, 3] }, { name: 'Places', values: [4, 5, 6] }] });
  assert.equal(chartValuesLine(two), 'Wins: 2022 1 · 2023 2 · 2024 3; Places: 2022 4 · 2023 5 · 2024 6');
  assert.match(chartValuesLine(two, 4), /^Wins: 2022 1 · 2023 2 · 2024 3; Places: 2022 4 … \(6 values\)$/);
});

test('a chart summary stays inside what a staged change keeps on its round trip', () => {
  // Eight 60-character owner names on a barh: the line is bounded, so the summary the
  // client sends back is the summary it was given (studioRequests.MAX_SUMMARY_CHARS).
  const names = Array.from({ length: 8 }, (_, i) => `${'Owner syndicate with a very long registered name'.padEnd(58, 'x')} ${i}`);
  const long = spec({ type: 'barh', categories: names, series: [{ name: 'Wins', values: names.map((_, i) => i * 3) }] });
  const line = chartValuesLine(long);
  assert.ok(line.length <= CHART_VALUES_MAX_CHARS, `got ${line.length}`);
  assert.ok(line.endsWith('…'));
  assert.ok(`Added ${chartLabel(long)}: ${line}`.length < MAX_SUMMARY_CHARS);
});

test('resolveChartPlacement: replace a picture in place, swap anything else, refuse locked', () => {
  const photo = image({ id: 'ph', x: 100, y: 200, w: 800, h: 500, zIndex: 6 });
  const t = text({ id: 'tx', x: 100, y: 800, w: 800, h: 300 });
  const locked = image({ id: 'lk', locked: true });
  const fill = resolveChartPlacement(spec(), { replaceElementId: 'ph' }, [photo, t, locked], PAGE);
  assert.ok(fill.ok && fill.mode === 'fill' && fill.target.id === 'ph');
  assert.deepEqual(fill.ok && fill.box, { x: 100, y: 200, w: 800, h: 500 });
  const swap = resolveChartPlacement(spec(), { replaceElementId: 'tx' }, [photo, t], PAGE);
  assert.ok(swap.ok && swap.mode === 'swap');
  const no = resolveChartPlacement(spec(), { replaceElementId: 'lk' }, [locked], PAGE);
  assert.ok(!no.ok && /locked/.test(no.error));
  const missing = resolveChartPlacement(spec(), { replaceElementId: 'zz' }, [], PAGE);
  assert.ok(!missing.ok && /No element #zz/.test(missing.error));
});

test('resolveChartPlacement: a whole box is kept on the page; half a box is refused', () => {
  const add = resolveChartPlacement(spec(), { x: 1000, y: 100, w: 600, h: 400 }, [], PAGE);
  assert.ok(add.ok && add.mode === 'add');
  assert.deepEqual(add.ok && add.box, { x: 640, y: 100, w: 600, h: 400 });
  const half = resolveChartPlacement(spec(), { x: 10, y: 10 }, [], PAGE);
  assert.ok(!half.ok && /x, y, w and h/.test(half.error));
  const tiny = resolveChartPlacement(spec(), { x: 0, y: 0, w: MIN_CHART_BOX.w - 1, h: 300 }, [], PAGE);
  assert.ok(!tiny.ok && /at least/.test(tiny.error));
});

test('resolveChartPlacement: an empty picture box first, then free space, else a clear refusal', () => {
  const slot = image({ id: 'slot', url: '', x: 100, y: 900, w: 900, h: 600 });
  const filled = resolveChartPlacement(spec(), {}, [slot], PAGE);
  assert.ok(filled.ok && filled.mode === 'fill' && filled.target.id === 'slot');
  const free = resolveChartPlacement(spec(), {}, [text({ x: 0, y: 0, w: 1240, h: 600 })], PAGE);
  assert.ok(free.ok && free.mode === 'add');
  if (free.ok) assert.ok(free.box.y >= 600, 'below the text, never over it');
  const packed = resolveChartPlacement(spec(), {}, [text({ x: 0, y: 0, w: 1240, h: 1754 })], PAGE);
  assert.ok(!packed.ok);
  if (!packed.ok) assert.equal(packed.error, NO_ROOM_FOR_CHART);
});

// ── generated pictures ───────────────────────────────────────────────────────

test('a generated picture is made at the ratio nearest its box (C40)', () => {
  const banner = { x: 0, y: 0, w: 1075, h: 360 };
  const photo = generatedImagePlacement('photo', banner);
  assert.equal(photo.aspectRatio, '21:9');
  assert.equal(photo.fit, 'cover');
  assert.deepEqual(photo.box, banner);
  const poster = generatedImagePlacement('poster', { x: 100, y: 100, w: 600, h: 1000 });
  assert.equal(poster.fit, 'contain', 'a poster’s words must not be cropped');
  assert.equal(poster.aspectRatio, '9:16');
  const r = ratioValue(poster.aspectRatio)!;
  assert.ok(Math.abs(poster.box.w / poster.box.h - r) < 0.01, 'the box takes the ratio the picture is made at');
  assert.ok(poster.box.x >= 100 && poster.box.x + poster.box.w <= 700);
  assert.equal(generatedImagePlacement('illustration', banner).fit, 'cover');
  assert.equal(generatedImagePlacement('graphic', banner).fit, 'contain');
  assert.equal(imageStyleNoun('illustration'), 'an illustration');
  assert.equal(imageStyleNoun('photo'), 'an image');
});

test('themeImageLook reads the issue’s photo style and palette', () => {
  const look = themeImageLook({ concept: { photoStyle: '  natural light, muted film tones ' }, palette: { primary: '#003366', secondary: 'nope', accent: '#C8102E' } });
  assert.equal(look.photoStyle, 'natural light, muted film tones');
  assert.deepEqual(look.colors, ['#003366', '#c8102e']);
  assert.deepEqual(themeImageLook(undefined), {});
  assert.deepEqual(themeImageLook('junk'), {});
});

// ── time and words ───────────────────────────────────────────────────────────

test('hasTimeFor: a slow call starts only when it can finish inside the turn', () => {
  assert.equal(hasTimeFor(100_000, 25_000, 70_000), true);
  assert.equal(hasTimeFor(100_000, 25_000, 80_000), false);
  assert.equal(hasTimeFor(undefined, 25_000, 0), true);
  assert.match(outOfTime('make a picture'), /not enough time left in this turn to make a picture/);
});

test('briefLabel cuts a long description cleanly', () => {
  assert.equal(briefLabel('  a   horse  '), 'a horse');
  const cut = briefLabel('x'.repeat(100));
  assert.equal(Array.from(cut).length, 58);
  assert.ok(cut.endsWith('…'));
});

test('a turn may ask the image model for at most MAX_IMAGES_PER_TURN pictures', () => {
  // The tool calls of one step run concurrently; the count is taken synchronously, so
  // a burst of generate_image calls cannot all pass.
  const ctx: { imagesMade?: number } = {};
  for (let i = 0; i < MAX_IMAGES_PER_TURN; i++) assert.deepEqual(takeImageSlot(ctx), { ok: true });
  const refused = takeImageSlot(ctx);
  assert.equal(refused.ok, false);
  assert.equal((refused as { reason: string }).reason, 'limit');
  assert.match((refused as { error: string }).error, /new message/);
  assert.equal(ctx.imagesMade, MAX_IMAGES_PER_TURN, 'a refusal does not count');
});
