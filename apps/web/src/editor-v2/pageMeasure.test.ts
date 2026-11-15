// Run: npx tsx --test src/editor-v2/pageMeasure.test.ts   (from apps/web)
//
// Reading a drawn page (the DOM half of the editor's page check). The pure parts —
// page px conversion, ink unions, font load requests — are tested directly; the
// browser parts run against a minimal stand-in for the DOM they read, the same way the
// server's renderPreview tests exercise MEASURE_PAGE_JS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MagazineElement } from './model';
import { cssFamilyList, fontLoadSpecs, makeTextProbe, parseMeasurements, readMountedPage, unionRect } from './pageMeasure';

// ── pure ─────────────────────────────────────────────────────────────────────

test('parseMeasurements: drawn px → page px, junk dropped (the server’s cases)', () => {
  const out = parseMeasurements(
    {
      pageW: 620,
      pageH: 877,
      items: [
        { id: 'a', box: { x: 10, y: 20, w: 300, h: 50 }, contentW: 300, contentH: 92.04, ink: { x: 10, y: 20, w: 280, h: 90 } },
        { id: 'b', box: { x: 0, y: 0, w: 10, h: 10 }, imgOk: false },
        { id: '', box: { x: 0, y: 0, w: 10, h: 10 } },
        { id: 'c', box: { x: 0, y: 'NaN', w: 10, h: 10 } },
        { id: 'd', box: { x: 0, y: 0, w: -1, h: 10 } },
        null,
        'x',
      ],
    },
    1240,
  );
  assert.deepEqual(out, [
    { id: 'a', box: { x: 20, y: 40, w: 600, h: 100 }, contentW: 600, contentH: 184.1, ink: { x: 20, y: 40, w: 560, h: 180 } },
    { id: 'b', box: { x: 0, y: 0, w: 20, h: 20 }, imgOk: false },
  ]);
  // Drawn at the canonical width (what pageCheck.ts does): 1:1.
  assert.deepEqual(parseMeasurements({ pageW: 1240, items: [{ id: 'a', box: { x: 1, y: 2, w: 3, h: 4 } }] }, 1240), [{ id: 'a', box: { x: 1, y: 2, w: 3, h: 4 } }]);
  assert.equal(parseMeasurements(null, 1240), null);
  assert.equal(parseMeasurements({ pageW: 0, items: [] }, 1240), null);
  assert.equal(parseMeasurements({ pageW: 620 }, 1240), null);
});

const rect = (x: number, y: number, w: number, h: number) => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h });

test('unionRect: the box round every glyph run, relative to the page, empty runs ignored', () => {
  assert.deepEqual(unionRect([rect(110, 60, 200, 20), rect(110, 84, 350, 20), rect(0, 0, 0, 0)], 100, 50), { x: 10, y: 10, w: 350, h: 44 });
  assert.equal(unionRect([], 0, 0), null);
  assert.equal(unionRect([rect(5, 5, 0, 10)], 0, 0), null);
});

test('cssFamilyList: every named face quoted, generic keywords bare, nothing that would make load() throw', () => {
  assert.equal(cssFamilyList('Source Sans 3, sans-serif'), '"Source Sans 3", sans-serif');
  assert.equal(cssFamilyList(`"Playfair Display", 'Times New Roman', SERIF`), '"Playfair Display", "Times New Roman", serif');
  assert.equal(cssFamilyList('inherit'), '');
  assert.equal(cssFamilyList('Evil", x'), '"Evil", "x"');
});

test('fontLoadSpecs: one request per face, carrying the characters drawn in it', () => {
  const specs = fontLoadSpecs([
    { style: 'normal', weight: '400', family: 'Inter, sans-serif', text: 'Māori  owners' },
    { style: 'normal', weight: '400', family: '"Inter", sans-serif', text: 'owners!' },
    { style: 'italic', weight: '700', family: 'Inter', text: '' },
    { style: 'normal', weight: 'bold', family: 'Lora', text: 'x' },
    { style: 'normal', weight: '400', family: 'inherit', text: 'dropped' },
  ]);
  assert.deepEqual(specs, [
    { font: 'normal 400 16px "Inter", sans-serif', text: 'Māori wnes!' },
    { font: 'italic 700 16px "Inter"', text: ' ' },
    { font: 'normal 700 16px "Lora"', text: 'x' },
  ]);
  const many = fontLoadSpecs([{ style: 'normal', weight: '400', family: 'Inter', text: Array.from({ length: 500 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('') }]);
  assert.equal(Array.from(many[0]!.text).length, 200, 'the sample is bounded');
});

// ── a minimal stand-in for the DOM the reader walks ──────────────────────────

type Rect = ReturnType<typeof rect>;
interface FakeNode {
  nodeValue: string;
  rects: Rect[];
}
interface FakeEl {
  attrs: Record<string, string>;
  style: Record<string, string>;
  cs?: Record<string, string>;
  rect?: Rect;
  scrollWidth?: number;
  scrollHeight?: number;
  textNodes?: FakeNode[];
  text?: FakeEl;
  img?: { complete: boolean; naturalWidth: number };
}

function fakeDoc() {
  return {
    defaultView: { getComputedStyle: (el: FakeEl) => el.cs ?? {} },
    createTreeWalker: (root: FakeEl) => {
      const nodes = root.textNodes ?? [];
      let i = -1;
      return { nextNode: () => nodes[++i] ?? null };
    },
    createRange: () => {
      let node: FakeNode | null = null;
      return {
        selectNodeContents: (n: FakeNode) => (node = n),
        getClientRects: () => node?.rects ?? [],
      };
    },
  };
}

function elementBox(id: string, cs: Record<string, string>, extra: Partial<FakeEl> = {}): FakeEl & { getAttribute(n: string): string | null; querySelector(s: string): unknown } {
  const el: FakeEl = { attrs: { 'data-el-id': id }, style: {}, cs, ...extra };
  return Object.assign(el, {
    getAttribute: (n: string) => el.attrs[n] ?? null,
    querySelector: (s: string) => (s === '[data-el-text]' ? (el.text ? textBlock(el.text) : null) : s === 'img' ? (el.img ?? null) : null),
  });
}
function textBlock(t: FakeEl) {
  return Object.assign(t, { getBoundingClientRect: () => t.rect!, scrollWidth: t.scrollWidth ?? 0, scrollHeight: t.scrollHeight ?? 0 });
}

test('readMountedPage: boxes from computed style, copy size unclipped, ink from glyph runs, pictures only once settled', () => {
  const doc = fakeDoc();
  const px = (x: number, y: number, w: number, h: number) => ({ left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`, transform: 'none' });
  const body = elementBox('body', px(100, 100, 500, 200), {
    text: {
      attrs: {},
      style: {},
      rect: rect(1100, 150, 500, 400),
      scrollWidth: 500,
      scrollHeight: 401,
      textNodes: [
        { nodeValue: 'First line of copy', rects: [rect(1100, 150, 480, 30)] },
        { nodeValue: '   ', rects: [rect(0, 0, 9999, 9999)] },
        { nodeValue: 'last line, cut off below the box', rects: [rect(1100, 510, 300, 30)] },
      ],
    },
  });
  const turned = elementBox('turned', { ...px(700, 100, 300, 60), transform: 'matrix(0.9, 0.4, -0.4, 0.9, 0, 0)' }, {
    text: { attrs: {}, style: {}, rect: rect(1700, 140, 340, 200), scrollWidth: 300, scrollHeight: 70, textNodes: [{ nodeValue: 'tilted', rects: [rect(1700, 140, 340, 200)] }] },
  });
  const photo = elementBox('photo', px(100, 400, 600, 400), { img: { complete: true, naturalWidth: 0 } });
  const pending = elementBox('pending', px(700, 400, 300, 300), { img: { complete: true, naturalWidth: 0 } });
  const fine = elementBox('fine', px(100, 900, 300, 300), { img: { complete: true, naturalWidth: 800 } });
  const root = {
    ownerDocument: doc,
    getBoundingClientRect: () => rect(1000, 50, 1240, 1754),
    querySelectorAll: () => [body, turned, photo, pending, fine],
  };
  const settled = (img: { naturalWidth: number }) => img !== pending.img;
  const raw = readMountedPage(root as unknown as HTMLElement, settled as unknown as (img: HTMLImageElement) => boolean);
  assert.equal(raw.pageW, 1240);
  assert.deepEqual(raw.items[0], {
    id: 'body',
    box: { x: 100, y: 100, w: 500, h: 200 },
    contentW: 500,
    contentH: 401,
    // Lines from y=150 to y=540 on screen: past the 200px box, as drawn.
    ink: { x: 100, y: 100, w: 480, h: 390 },
  });
  // Rotated: its own size still reads, its rotated rects are not taken for its lines.
  assert.deepEqual(raw.items[1], { id: 'turned', box: { x: 700, y: 100, w: 300, h: 60 }, contentW: 300, contentH: 70 });
  assert.equal(raw.items[2]!.imgOk, false, 'broken, nothing left to try');
  assert.equal(raw.items[3]!.imgOk, undefined, 'its fallback is still on the way: not judged');
  assert.equal(raw.items[4]!.imgOk, true);
  // Straight into page px (drawn at the canonical width: 1:1).
  assert.deepEqual(parseMeasurements(raw, 1240)![0], raw.items[0]);
});

test('makeTextProbe: the copy re-laid at another size in its own width, in page px; removed afterwards', () => {
  const appended: { wrap: { style: { cssText: string }; children: { style: Record<string, string> }[] } }[] = [];
  let removed = 0;
  const clone = {
    style: {} as Record<string, string>,
    removeAttribute: (n: string) => assert.equal(n, 'data-el-text'),
    // A fake layout: 10px of height per px of type, in a box 400px wide.
    get scrollHeight() {
      return parseFloat(this.style.fontSize!) * 10;
    },
    getBoundingClientRect: () => rect(0, 0, 0, 0),
  };
  const textDiv = { cloneNode: () => clone };
  const box = { getAttribute: () => 'body', querySelector: () => textDiv };
  const root = { querySelectorAll: () => [box] };
  const scratch = {
    ownerDocument: {
      createElement: () => {
        const wrap = {
          style: { cssText: '' },
          children: [] as { style: Record<string, string> }[],
          appendChild: (c: { style: Record<string, string> }) => wrap.children.push(c),
          remove: () => removed++,
        };
        return wrap;
      },
    },
    // Drawn at half the canonical width: every px read is two page px.
    getBoundingClientRect: () => rect(0, 0, 620, 10),
    appendChild: (wrap: (typeof appended)[number]['wrap']) => appended.push({ wrap }),
  };
  const probe = makeTextProbe(root as unknown as HTMLElement, scratch as unknown as HTMLElement, 1240);
  const el = { id: 'body', w: 310 } as MagazineElement;
  // fontSize in cqw of a 1240 page: 24px → 1.935…cqw; the fake reads that number ×10.
  const h = probe(el, 24)!;
  assert.ok(Math.abs(h - (24 / 1240) * 100 * 10 * 2) < 1e-9, String(h));
  assert.equal(appended[0]!.wrap.style.cssText, 'position:absolute;left:0;top:0;width:25%;');
  assert.equal(clone.style.whiteSpace, 'pre-wrap');
  assert.equal(clone.style.width, '100%');
  assert.equal(removed, 1, 'the scratch copy is gone after each measurement');
  assert.equal(probe({ id: 'missing', w: 100 } as MagazineElement, 24), undefined);
  assert.equal(probe(el, 0), undefined);
});
