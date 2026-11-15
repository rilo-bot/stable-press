// Run: npx tsx --test src/editor-v2/addDefaults.test.ts   (from apps/web)
// A hand-added element goes on top, in the page's own type, and a designed picture
// shows whole (findings C51 / C55 / C39, web side).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageBoxFor, isGraphicAsset, pageTextStyle, topZ, zForNew } from './addDefaults';
import type { MagazineElement } from './model';

const text = (id: string, role: string, content: string, over: Partial<NonNullable<MagazineElement['text']>> = {}, z = 1): MagazineElement =>
  ({
    id,
    type: 'text',
    x: 0,
    y: 0,
    w: 400,
    h: 100,
    rotation: 0,
    zIndex: z,
    locked: false,
    source: 'ai-agent',
    text: {
      content,
      role,
      fontFamily: '"Source Serif 4", Georgia, serif',
      fontSize: 18,
      maxFontSize: 18,
      fontWeight: 400,
      color: '#222222',
      align: 'left',
      lineHeight: 1.45,
      autoFit: 'shrink',
      ...over,
    },
  }) as MagazineElement;

const page = { width: 1240, height: 1754 };

test('topZ / zForNew: on top of everything, capped at 9999', () => {
  assert.equal(topZ([]), 0);
  assert.equal(topZ([{ zIndex: 4 }, { zIndex: 13 }, { zIndex: 2 }]), 13);
  assert.equal(zForNew([{ zIndex: 4 }, { zIndex: 13 }]), 14);
  assert.equal(zForNew([{ zIndex: 9999 }]), 9999);
  assert.equal(zForNew([]), 1);
});

test('pageTextStyle copies the main body paragraph, not a short label', () => {
  const els = [
    text('a', 'body', 'Short', { fontSize: 30, color: '#ff0000' }),
    text('b', 'body', 'The New Owners Group is embarking on one of the most significant initiatives in years.', { fontSize: 17 }),
    text('c', 'headline', 'Big News', { fontSize: 72, fontWeight: 800 }),
  ];
  const s = pageTextStyle(els, 'body');
  assert.ok(s);
  assert.equal(s!.fontSize, 17);
  assert.equal(s!.color, '#222222');
  assert.equal(s!.lineHeight, 1.45);
  assert.equal(s!.fontFamily, '"Source Serif 4", Georgia, serif');
  assert.equal(pageTextStyle(els, 'headline')!.fontWeight, 800);
});

test('pageTextStyle: none for a page without that role, or with the app font', () => {
  assert.equal(pageTextStyle([text('c', 'headline', 'Hi')], 'body'), null);
  assert.equal(pageTextStyle([text('b', 'body', 'Words here', { fontFamily: 'inherit' })], 'body'), null);
});

test('graphics are recognised by kind or by chart source', () => {
  assert.ok(isGraphicAsset({ kind: 'graphic' }));
  assert.ok(isGraphicAsset({ kind: 'photo', source: 'chart' }));
  assert.ok(!isGraphicAsset({ kind: 'photo', source: 'stock' }));
  assert.ok(!isGraphicAsset({ kind: 'upload' }));
});

test('imageBoxFor: the 3:2 default when the size is unknown', () => {
  const b = imageBoxFor({}, page);
  assert.equal(b.w, 620);
  assert.equal(b.h, Math.round(620 * 0.66));
  assert.equal(b.x, 310);
});

test('imageBoxFor: the picture’s own shape, inside the page', () => {
  const wide = imageBoxFor({ width: 1600, height: 900 }, page);
  assert.equal(wide.w, 620);
  assert.equal(wide.h, Math.round((620 * 900) / 1600));
  const tall = imageBoxFor({ width: 600, height: 2400 }, page);
  assert.equal(tall.h, Math.round(page.height * 0.6));
  assert.ok(Math.abs(tall.w / tall.h - 600 / 2400) < 0.01);
  for (const b of [wide, tall]) {
    assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= page.width && b.y + b.h <= page.height);
  }
});
