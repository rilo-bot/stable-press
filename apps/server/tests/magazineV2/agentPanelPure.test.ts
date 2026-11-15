// ---------------------------------------------------------------------------
// agentPanelPure.ts — the decisions behind "the assistant can do everything the Page &
// Element panel can": fonts, the page background, clearing a page, a picture's own size,
// layers, duplicates, QR colours, icons, and arranging boxes in one step.
//
// Pure: no database, no model. The font list is checked against the web registry file
// itself, so the two cannot drift.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ElementTextData, MagazineElement } from '../../src/lib/magazineV2/model.ts';
import {
  arrangePlan,
  backgroundFromAsk,
  backgroundSummary,
  backgroundUrlAllowed,
  boxForRatio,
  clearPagePlan,
  CURATED_FONTS,
  duplicateOf,
  isOwnPageBackgroundKey,
  naturalSizeFor,
  normalizeVAlign,
  pageFontStacks,
  parseBackgroundAsk,
  plausibleSize,
  primaryFamily,
  qrColourCheck,
  resolveFontFamily,
  resolveIconName,
  sizeLabel,
  storedBackground,
  weightNote,
  withNaturalSizes,
  zForLayer,
} from '../../src/lib/magazineV2/agentPanelPure.ts';
import { buildDropCap } from './dropCapFixture.js';

const PAGE = { width: 1240, height: 1754 };

type TextOver = Partial<Omit<MagazineElement, 'text'>> & { text?: Partial<ElementTextData> };
function textEl(id: string, content: string, over: TextOver = {}): MagazineElement {
  const { text, ...rest } = over;
  return {
    id, type: 'text', x: 100, y: 100, w: 500, h: 200, rotation: 0, zIndex: 4, locked: false, source: 'ai-agent',
    ...rest,
    text: {
      content, role: 'body', fontFamily: 'Georgia, serif', fontSize: 24, maxFontSize: 24, minFontSize: 14,
      fontWeight: 400, color: '#111111', align: 'left', lineHeight: 1.4, autoFit: 'shrink', ...text,
    },
  } as MagazineElement;
}
function imageEl(id: string, url: string, over: Partial<MagazineElement> = {}, assetId = ''): MagazineElement {
  return { id, type: 'image', x: 100, y: 300, w: 640, h: 480, rotation: 0, zIndex: 2, locked: false, source: 'manual', image: { url, assetId, alt: 'A chart', fit: 'cover' }, ...over } as MagazineElement;
}

// ── Fonts ────────────────────────────────────────────────────────────────────

test('the curated fonts are exactly the panel’s list (apps/web/src/lib/fonts/registry.ts)', () => {
  const registry = readFileSync(fileURLToPath(new URL('../../../web/src/lib/fonts/registry.ts', import.meta.url)), 'utf8');
  const pairs = [...registry.matchAll(/label: '([^']+)',\s*category: '[a-z]+',\s*stack: ("[^"]+"|'[^']+'),/g)].map((m) => ({
    label: m[1]!,
    stack: m[2]!.slice(1, -1),
  }));
  assert.ok(pairs.length >= 20, `read ${pairs.length} fonts from the registry`);
  assert.deepEqual(CURATED_FONTS.map((f) => ({ label: f.label, stack: f.stack })), pairs);
});

test('a font is matched by its first family, however it is written, and stored as the panel stores it', () => {
  for (const asked of ['Lora', 'lora', "'Lora', serif", '"Lora"']) {
    const r = resolveFontFamily(asked);
    assert.ok(r.ok, asked);
    assert.equal((r as { stack: string }).stack, "'Lora', Georgia, serif");
  }
  assert.equal(primaryFamily("'Source Sans 3', system-ui, sans-serif"), 'source sans 3');
  const dm = resolveFontFamily('DM Serif Display');
  assert.equal((dm as { stack: string }).stack, 'DM Serif Display, Georgia, serif');
});

test('a family already on the page is allowed; an invented one is refused with the list', () => {
  const page = [textEl('a', 'x', { text: { fontFamily: "'Garamond Premier Pro', serif" } })];
  const own = resolveFontFamily('Garamond Premier Pro', pageFontStacks(page));
  assert.ok(own.ok);
  assert.equal((own as { from: string }).from, 'page');
  const bad = resolveFontFamily('Comic Neue', pageFontStacks(page));
  assert.equal(bad.ok, false);
  assert.match((bad as { error: string }).error, /not one of the magazine's fonts.*Playfair Display.*Lora.*Garamond Premier Pro/);
  assert.equal(resolveFontFamily('inherit', ['inherit']).ok, false);
});

test('a weight the family does not have is noted, with the one it shows at', () => {
  assert.match(weightNote("'Lora', Georgia, serif", 'Lora', 900)!, /no 900 weight; it shows at 700/);
  assert.equal(weightNote("'Lora', Georgia, serif", 'Lora', 700), undefined);
  assert.match(weightNote("'Pacifico', cursive", 'Pacifico', 700)!, /single weight/);
  assert.equal(weightNote('Unknown Face', 'Unknown Face', 900), undefined);
  const lora = resolveFontFamily('Lora', [], 900);
  assert.match((lora as { note?: string }).note ?? '', /no 900/);
});

test('the theme’s fonts count as the page’s own', () => {
  const stacks = pageFontStacks([textEl('a', 'x', { text: { fontFamily: 'inherit' } })], { fonts: { display: "'Oswald', sans-serif", body: 'Merriweather, serif' } });
  assert.deepEqual(stacks, ["'Oswald', sans-serif", 'Merriweather, serif']);
});

test('the panel’s Vertical buttons: middle is stored as center', () => {
  assert.equal(normalizeVAlign('middle'), 'center');
  assert.equal(normalizeVAlign('center'), 'center');
  assert.equal(normalizeVAlign('top'), 'top');
  assert.equal(normalizeVAlign('bottom'), 'bottom');
  assert.equal(normalizeVAlign('sideways'), undefined);
});

// ── Background ───────────────────────────────────────────────────────────────

test('a background is exactly one of a solid colour, a picture or plain white', () => {
  assert.deepEqual(backgroundFromAsk({ color: '#F5EFE6' }), { ok: true, background: { type: 'color', value: '#f5efe6' } });
  assert.deepEqual(backgroundFromAsk({ color: '#abc' }), { ok: true, background: { type: 'color', value: '#aabbcc' } });
  assert.deepEqual(backgroundFromAsk({ clear: true }), { ok: true, background: { type: 'none' } });
  assert.deepEqual(backgroundFromAsk({ imageUrl: ' https://x/p.jpg ' }), { ok: true, background: { type: 'image', value: 'https://x/p.jpg' } });
  assert.match((backgroundFromAsk({}) as { error: string }).error, /color.*imageUrl.*clear/);
  assert.match((backgroundFromAsk({ color: '#fff', clear: true }) as { error: string }).error, /only one/);
  assert.match((backgroundFromAsk({ color: 'rgba(0,0,0,0.4)' }) as { error: string }).error, /solid/);
  assert.match((backgroundFromAsk({ color: 'beige-ish' }) as { error: string }).error, /not a colour/);
});

test('a background from a request body: known shapes only; none is plain white', () => {
  assert.deepEqual(parseBackgroundAsk({ type: 'none' }), { type: 'none' });
  assert.deepEqual(parseBackgroundAsk({ type: 'color', value: '#112233' }), { type: 'color', value: '#112233' });
  assert.equal(parseBackgroundAsk({ type: 'color', value: 'red-ish' }), null);
  assert.equal(parseBackgroundAsk({ type: 'image', value: '' }), null);
  assert.equal(parseBackgroundAsk({ type: 'video', value: 'x' }), null);
  assert.equal(parseBackgroundAsk('#fff'), null);
  assert.deepEqual(storedBackground({ type: 'none' }), { type: 'color', value: '#ffffff' });
  assert.deepEqual(storedBackground({ type: 'image', value: 'https://x/p.jpg' }), { type: 'image', value: 'https://x/p.jpg' });
  assert.equal(backgroundSummary({ type: 'none' }), 'Set the page background to plain white');
  assert.match(backgroundSummary({ type: 'image', value: 'u' }, 'Track at dawn'), /“Track at dawn” as the page background/);
});

// ── Clearing a page ──────────────────────────────────────────────────────────

test('clearing a page removes every unlocked element; locked ones stay; keepFolio keeps the furniture', () => {
  const els = [
    textEl('h', 'Headline', { text: { role: 'headline' } }),
    textEl('furniture-folio', '7', { text: { role: 'other' } }),
    textEl('furniture-head-label', 'Feature', { text: { role: 'other' } }),
    imageEl('p', 'https://x/p.jpg', { locked: true }),
    { id: 's', type: 'shape', x: 0, y: 0, w: 10, h: 10, rotation: 0, zIndex: 1, locked: false, source: 'manual', shape: { fill: '#000000' } } as MagazineElement,
  ];
  const all = clearPagePlan(els);
  assert.deepEqual(all.remove.map((e) => e.id), ['h', 'furniture-folio', 'furniture-head-label', 's']);
  assert.deepEqual(all.locked.map((e) => e.id), ['p']);
  const keep = clearPagePlan(els, { keepFolio: true });
  assert.deepEqual(keep.remove.map((e) => e.id), ['h', 's']);
  assert.deepEqual(keep.kept.map((e) => e.id), ['furniture-folio', 'furniture-head-label']);
});

// ── A picture's own size ─────────────────────────────────────────────────────

test('a picture’s own size: by the asset it names, else by url; only plausible numbers', () => {
  const known = [
    { url: 'https://x/a.png', assetId: 'A', width: 1426, height: 806 },
    { url: 'https://x/b.png', assetId: '', width: 1560, height: 730 },
  ];
  assert.deepEqual(naturalSizeFor(imageEl('i', 'https://x/other.png', {}, 'A'), known), { width: 1426, height: 806 });
  assert.deepEqual(naturalSizeFor(imageEl('i', 'https://x/b.png'), known), { width: 1560, height: 730 });
  assert.equal(naturalSizeFor(imageEl('i', 'https://x/none.png'), known), undefined);
  assert.equal(naturalSizeFor(textEl('t', 'x'), known), undefined);
  assert.equal(plausibleSize(0, 10), undefined);
  assert.equal(plausibleSize('12', 'abc'), undefined);
  assert.deepEqual(plausibleSize('12', 9.6), { width: 12, height: 10 });
  assert.equal(sizeLabel({ width: 1426, height: 806 }), '1426x806 px (1.77:1)');
});

test('the element list names each picture’s own size', () => {
  const els = [imageEl('i1', 'https://x/a.png', {}, 'A'), textEl('t', 'Words')];
  const lines = ['- #i1 image img "A chart" (uploaded/placed by hand) …/a.png fit:cover @(100,300 640x480) z2', '- #t text body "Words" #111111 24px @(100,100 500x200) z4'];
  const out = withNaturalSizes(lines, els, [{ url: 'https://x/a.png', assetId: 'A', width: 1426, height: 806 }]);
  assert.match(out[0]!, / · picture 1426x806 px \(1\.77:1\)$/);
  assert.equal(out[1], lines[1]);
  assert.deepEqual(withNaturalSizes(lines, els, []), lines);
});

test('a box made the picture’s own shape: the client’s two charts, exactly', () => {
  const box = { x: 100, y: 300, w: 640, h: 480 };
  assert.deepEqual(boxForRatio(box, 1426 / 806, PAGE).box, { x: 100, y: 300, w: 640, h: 362 });
  assert.deepEqual(boxForRatio(box, 1560 / 730, PAGE).box, { x: 100, y: 300, w: 640, h: 299 });
  assert.deepEqual(boxForRatio(box, 2, PAGE, { w: 800 }).box, { x: 100, y: 300, w: 800, h: 400 });
  assert.deepEqual(boxForRatio(box, 2, PAGE, { h: 100 }).box, { x: 100, y: 300, w: 200, h: 100 });
  // A tall picture that would not fit the page is scaled down, and moved back on.
  const tall = boxForRatio({ x: 100, y: 1500, w: 1240, h: 100 }, 0.5, PAGE);
  assert.ok(tall.box.h <= PAGE.height && tall.box.y + tall.box.h <= PAGE.height && tall.box.x + tall.box.w <= PAGE.width);
  assert.ok(Math.abs(tall.box.w / tall.box.h - 0.5) < 0.01);
  assert.ok(tall.notes.length > 0);
});

// ── Layers, duplicates, QR, icons ────────────────────────────────────────────

test('To front / To back give the same zIndex as the panel’s buttons', () => {
  const els = [{ id: 'a', zIndex: 3 }, { id: 'b', zIndex: 7 }, { id: 'c', zIndex: 5 }];
  assert.equal(zForLayer(els, 'a', 'front'), 8);
  assert.equal(zForLayer(els, 'b', 'back'), 2);
  assert.equal(zForLayer([{ id: 'a', zIndex: 0 }, { id: 'b', zIndex: 0 }], 'a', 'back'), 0);
  assert.equal(zForLayer([{ id: 'a', zIndex: 9999 }, { id: 'b', zIndex: 1 }], 'b', 'front'), 9999);
});

test('a duplicate has no id, is unlocked, on top, offset and kept on the page', () => {
  const el = textEl('t', 'Copy me', { x: 1000, y: 1700, w: 200, h: 40, locked: true, source: 'extracted' });
  const d = duplicateOf(el, PAGE, 12);
  assert.equal(d.id, undefined);
  assert.equal(d.locked, false);
  assert.equal(d.source, 'ai-agent');
  assert.equal(d.zIndex, 12);
  assert.equal(d.x, 1020);
  assert.equal(d.y, PAGE.height - 40, 'pulled back on at the bottom');
  assert.equal((d.text as ElementTextData).content, 'Copy me');
  (d.text as ElementTextData).content = 'changed';
  assert.equal(el.text!.content, 'Copy me', 'a deep copy');
  assert.deepEqual([duplicateOf(el, PAGE, 1, { x: 5, y: 6 }).x, duplicateOf(el, PAGE, 1, { x: 5, y: 6 }).y], [5, 6]);
});

test('QR colours that would stop it scanning are an error; light on dark is a warning', () => {
  assert.match(qrColourCheck('#cccccc', '#ffffff').error!, /stop scanning/);
  assert.match(qrColourCheck('#ffffff', '#0a2342').warning!, /dark on light/);
  assert.deepEqual(qrColourCheck('#0a2342', '#ffffff'), {});
});

test('icon names are matched loosely; an unknown one gets the closest names', () => {
  assert.deepEqual(resolveIconName('trophy'), { ok: true, name: 'Trophy' });
  assert.deepEqual(resolveIconName('bar chart 3'), { ok: true, name: 'BarChart3' });
  assert.deepEqual(resolveIconName('map-pin'), { ok: true, name: 'MapPin' });
  const bad = resolveIconName('horses');
  assert.equal(bad.ok, false);
  assert.match((bad as { error: string }).error, /Close matches: Horse/);
});

// ── Arranging boxes ──────────────────────────────────────────────────────────

/** Page 3 of the client's bulletin: a headline, a subhead and six body paragraphs. */
function page3(): MagazineElement[] {
  const body = (i: number) =>
    textEl(`b${i}`, `Paragraph ${i}: the owners met at the club rooms and talked about the season ahead.`, { x: 80, y: 360 + i * 190, w: 531, h: 150, zIndex: 5 });
  return [
    textEl('head', 'The New Owners Group', { x: 80, y: 80, w: 1080, h: 120, text: { role: 'headline', fontSize: 64, maxFontSize: 64 } }),
    textEl('sub', 'What the first season taught us', { x: 80, y: 220, w: 1080, h: 60, text: { role: 'subhead', fontSize: 30, maxFontSize: 30 } }),
    ...[0, 1, 2, 3, 4, 5].map(body),
  ];
}

test('arrange: six paragraphs at 20px, 210px tall, 14px apart below the subhead — in one plan', () => {
  const els = page3();
  const ids = ['b0', 'b1', 'b2', 'b3', 'b4', 'b5'];
  // 220px each (the client's ask) needs 1390px; this page has 1380px below the subhead:
  // refused, with the height that WOULD fit.
  const tooTall = arrangePlan(els, ids, PAGE, { fontSize: 20, height: 220, gap: 14, belowId: 'sub', evenly: true });
  assert.match((tooTall as { error: string }).error, /need 1390px.*only 1380px is free.*height 218px or less/);
  const plan = arrangePlan(els, ids, PAGE, { fontSize: 20, height: 210, gap: 14, belowId: 'sub', evenly: true });
  assert.equal(plan.ok, true);
  const p = plan as Extract<typeof plan, { ok: true }>;
  assert.equal(p.top, 220 + 60 + 14);
  assert.deepEqual(p.moves.map((m) => m.y), [294, 518, 742, 966, 1190, 1414]);
  assert.ok(p.moves.every((m) => m.h === 210 && m.fontSize === 20 && m.x === 80 && m.w === 531));
  assert.equal(p.end, 1414 + 210);
  assert.ok(p.end <= p.bottom);
  assert.equal(p.misfits.length, 0);
  assert.match(p.summary, /Arranged 6 boxes: 20px type, 210px tall, 14px apart/);
});

test('arrange: boxes that cannot fit between top and bottom are REFUSED with the numbers and what would fit', () => {
  const plan = arrangePlan(page3(), ['b0', 'b1', 'b2', 'b3', 'b4', 'b5'], PAGE, { fontSize: 20, height: 260, gap: 14, belowId: 'sub' });
  assert.equal(plan.ok, false);
  const e = (plan as { error: string }).error;
  assert.match(e, /need 1630px \(1560px of boxes \+ 5 gaps of 14px\)/);
  assert.match(e, /between y=294 and y=\d+/);
  assert.match(e, /height \d+px or less/);
  assert.match(e, /nothing was changed/);
});

test('arrange: evenly with no gap spreads the boxes to fill the space', () => {
  const plan = arrangePlan(page3(), ['b0', 'b1', 'b2'], PAGE, { height: 100, top: 300, bottom: 900, evenly: true });
  assert.equal(plan.ok, true);
  const p = plan as Extract<typeof plan, { ok: true }>;
  assert.equal(p.gap, 150);
  assert.deepEqual(p.moves.map((m) => m.y), [300, 550, 800]);
  assert.equal(p.end, 900);
});

test('arrange: without a height, text boxes become as tall as their copy at the new size', () => {
  const plan = arrangePlan(page3(), ['b0', 'b1'], PAGE, { fontSize: 20, gap: 10, top: 300 });
  assert.equal(plan.ok, true);
  const p = plan as Extract<typeof plan, { ok: true }>;
  assert.ok(p.moves.every((m) => m.h > 20 && m.h < 150), JSON.stringify(p.moves));
  assert.equal(p.moves[1]!.y, 300 + p.moves[0]!.h + 10);
});

test('arrange: text that does not fit the height it was given is reported with the size it fits at', () => {
  const long = Array.from({ length: 120 }, () => 'racing').join(' ');
  const els = [textEl('a', long, { x: 80, y: 300, w: 300 }), textEl('b', long, { x: 80, y: 600, w: 300 })];
  const plan = arrangePlan(els, ['a', 'b'], PAGE, { fontSize: 24, height: 80, gap: 10 });
  assert.equal(plan.ok, true);
  const p = plan as Extract<typeof plan, { ok: true }>;
  assert.equal(p.misfits.length, 2);
  assert.ok(p.misfits[0]!.needPx! > 80);
  assert.ok(p.misfits[0]!.fitsAtPx === undefined || p.misfits[0]!.fitsAtPx < 24);
});

test('arrange: side-by-side columns are stacked each on its own', () => {
  const els = [textEl('l1', 'a', { x: 80, y: 300, w: 500 }), textEl('l2', 'b', { x: 80, y: 700, w: 500 }), textEl('r1', 'c', { x: 660, y: 320, w: 500 }), textEl('r2', 'd', { x: 660, y: 900, w: 500 })];
  const plan = arrangePlan(els, ['l1', 'l2', 'r1', 'r2'], PAGE, { height: 100, gap: 20, top: 300 });
  const p = plan as Extract<typeof plan, { ok: true }>;
  assert.equal(p.columns, 2);
  const y = (id: string) => p.moves.find((m) => m.id === id)?.y ?? els.find((e) => e.id === id)!.y;
  assert.deepEqual([y('l1'), y('l2'), y('r1'), y('r2')], [300, 420, 300, 420]);
});

test('arrange refuses locked boxes, unknown ids, drop-cap pieces and a bottom below the page', () => {
  const els = [...page3(), textEl('lk', 'locked', { locked: true })];
  assert.match((arrangePlan(els, ['b0', 'lk'], PAGE) as { error: string }).error, /locked/);
  assert.match((arrangePlan(els, ['nope'], PAGE) as { error: string }).error, /No element #nope/);
  assert.match((arrangePlan(els, ['b0'], PAGE, { bottom: 5000 }) as { error: string }).error, /below the page/);
  assert.match((arrangePlan(els, ['b0'], PAGE, { fontSize: 2 }) as { error: string }).error, /fontSize/);
  const dc = buildDropCap(Array.from({ length: 60 }, () => 'Riders gathered early at the track').join(' ') + '.');
  assert.match((arrangePlan(dc.elements, [dc.lead.id], PAGE) as { error: string }).error, /drop-cap paragraph/);
});

// ── The page-background allow-list (one rule for the PATCH, the Studio and the wire) ──

const MAG = '6650a1b2c3d4e5f6a7b8c9d0';
const BUCKET = 'https://cdn.example.com';
const keyOf = (u: string) => (u.startsWith(`${BUCKET}/`) ? u.slice(BUCKET.length + 1) : null);

test('a page-background raster of THIS magazine is allowed, so undo can put it back', () => {
  const raster = `${BUCKET}/public/magazinesV2/${MAG}/pages/6650a1b2c3d4e5f6a7b8c9d1/8f14e45f-ceea-4c1a-9d2b-1a2b3c4d5e6f-background.jpg`;
  const ctx = { magazineId: MAG, current: { type: 'color', value: '#ffffff' }, libraryUrls: [], keyOf };
  assert.equal(backgroundUrlAllowed(raster, ctx), 'page-background');
  // The older key shape (no public/ prefix, a page number, no run id) too.
  assert.equal(isOwnPageBackgroundKey(`magazinesV2/${MAG}/pages/3/background.jpg`, MAG), true);
  // Another magazine's raster, another file under this magazine, a traversal: refused.
  assert.equal(backgroundUrlAllowed(raster.replace(MAG, '0000a1b2c3d4e5f6a7b8c9d0'), ctx), null);
  assert.equal(isOwnPageBackgroundKey(`public/magazinesV2/${MAG}/media/x.jpg`, MAG), false);
  assert.equal(isOwnPageBackgroundKey(`public/magazinesV2/${MAG}/pages/../x/background.jpg`, MAG), false);
});

test('the allow-list: current, library, on the page — and never a private address', () => {
  const lib = `${BUCKET}/public/magazinesV2/${MAG}/media/a.jpg`;
  const pasted = 'https://images.example.org/horse.jpg';
  const ctx = { magazineId: MAG, current: { type: 'image', value: 'https://x.example/cur.jpg' }, libraryUrls: [lib], pageImageUrls: [pasted], keyOf };
  assert.equal(backgroundUrlAllowed('https://x.example/cur.jpg', ctx), 'current');
  assert.equal(backgroundUrlAllowed(lib, ctx), 'library');
  assert.equal(backgroundUrlAllowed(pasted, ctx), 'on-page');
  assert.equal(backgroundUrlAllowed('https://elsewhere.example/a.jpg', ctx), null);
  for (const bad of ['http://169.254.169.254/latest/meta-data/', 'http://localhost:4000/a.jpg', 'javascript:alert(1)', '']) {
    assert.equal(backgroundUrlAllowed(bad, { ...ctx, libraryUrls: [bad], pageImageUrls: [bad] }), null, bad);
  }
});
