// ---------------------------------------------------------------------------
// Where a new chart goes (chartSlot / chartBox) and what it sits on top of (topZ).
// An empty picture box first; else the largest free rectangle that clears the copy
// and keeps the page's margins; else null ("the page is full") — never a chart
// stacked over the text. Pure.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chartBox, chartSlot, preferredChartAspect, topZ } from '../../src/lib/magazineV2/chartSpec.js';
import type { MagazineElement } from '../../src/lib/magazineV2/model.js';

const PAGE = { width: 1240, height: 1754 };
const MARGIN = 74; // max(40, round(1240 * 0.06))

let seq = 0;
function el(type: MagazineElement['type'], box: { x: number; y: number; w: number; h: number }, extra: Partial<MagazineElement> = {}): MagazineElement {
  seq += 1;
  const base: MagazineElement = { id: `e${seq}`, type, ...box, rotation: 0, zIndex: 1, locked: false, source: 'manual' };
  if (type === 'text') {
    base.text = { content: 'Copy', role: 'body', fontFamily: 'Inter', fontSize: 24, fontWeight: 400, color: '#111111', align: 'left', lineHeight: 1.4, autoFit: 'shrink' };
  }
  if (type === 'image') base.image = { assetId: '', url: 'https://cdn.test/a.jpg', alt: '', fit: 'cover' };
  if (type === 'shape') base.shape = { fill: '#0b1f3a' };
  return { ...base, ...extra };
}

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

test('an EMPTY image slot is preferred, and named so the caller can replace it', () => {
  const slot = el('image', { x: 100, y: 900, w: 1000, h: 600 }, { image: { assetId: '', url: '', alt: '', fit: 'cover' } });
  const els = [el('text', { x: 74, y: 74, w: 1092, h: 700 }), slot];
  const got = chartSlot(els, PAGE, 1.5);
  assert.deepEqual(got, { box: { x: 100, y: 900, w: 1000, h: 600 }, emptySlotId: slot.id });
});

test('the largest free rectangle avoids the text and keeps the margins', () => {
  const copy = el('text', { x: 74, y: 74, w: 1092, h: 800 });
  const box = chartBox([copy], PAGE, 1.5);
  assert.ok(box);
  assert.equal(overlaps(box, { x: copy.x - 16, y: copy.y - 16, w: copy.w + 32, h: copy.h + 32 }), false);
  assert.ok(box.x >= MARGIN && box.y >= MARGIN, 'inside the top/left margins');
  assert.ok(box.x + box.w <= PAGE.width - MARGIN && box.y + box.h <= PAGE.height - MARGIN, 'inside the bottom/right margins');
  // The preferred shape is honoured (to rounding).
  assert.ok(Math.abs(box.w / box.h - 1.5) < 0.02, `aspect ${box.w / box.h}`);
  // And it is a real chart-sized box, not a sliver.
  assert.ok(box.w >= 600, `width ${box.w}`);
});

test('shapes (panels, scrims) and a full-sheet background photo are grounds, not obstacles', () => {
  const els = [el('shape', { x: 0, y: 0, w: 1240, h: 1754 }), el('image', { x: 0, y: 0, w: 1240, h: 1754 })];
  const box = chartBox(els, PAGE, 1.5);
  assert.ok(box);
  assert.ok(box.w > 900);
});

test('a full page returns null — never a chart over the copy', () => {
  const els = [el('text', { x: 60, y: 60, w: 1120, h: 820 }), el('image', { x: 60, y: 900, w: 1120, h: 790 })];
  assert.equal(chartBox(els, PAGE, 1.5), null);
});

test('a too-small empty slot is not used; the free space wins instead', () => {
  const tiny = el('image', { x: 100, y: 100, w: 80, h: 60 }, { image: { assetId: '', url: '', alt: '', fit: 'cover' } });
  const got = chartSlot([tiny], PAGE, 1.5);
  assert.ok(got);
  assert.equal(got.emptySlotId, undefined);
});

test('the answer is deterministic', () => {
  const els = [el('text', { x: 74, y: 600, w: 500, h: 400 })];
  assert.deepEqual(chartBox(els, PAGE, 1.6), chartBox(els, PAGE, 1.6));
});

test('topZ is the page\'s highest zIndex, so a new element at topZ + 1 is on top', () => {
  const els = [el('image', { x: 0, y: 0, w: 10, h: 10 }, { zIndex: 0 }), el('shape', { x: 0, y: 0, w: 10, h: 10 }, { zIndex: 13 }), el('text', { x: 0, y: 0, w: 10, h: 10 }, { zIndex: 4 })];
  assert.equal(topZ(els), 13);
  assert.equal(topZ([]), 0);
  const newZ = topZ(els) + 1;
  assert.ok(els.every((e) => e.zIndex < newZ));
});

test('preferred aspects: horizontal bars grow taller with more rows; pies leave room for a legend', () => {
  const rows = (n: number) => preferredChartAspect({ type: 'barh', categories: Array.from({ length: n }, (_, i) => `H${i}`), series: [{ name: 'x', values: [] }] });
  assert.ok(rows(3) > rows(12));
  assert.ok(rows(24) >= 0.7);
  assert.ok(preferredChartAspect({ type: 'pie', categories: ['a'], series: [{ name: 'x', values: [1] }] }) > 1.2);
});
