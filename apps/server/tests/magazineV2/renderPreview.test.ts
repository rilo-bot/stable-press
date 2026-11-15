// ---------------------------------------------------------------------------
// renderPreview — the pure parts of the browser half: the in-page measuring script
// (run here against a hand-built stand-in for the DOM, since the server has no
// browser in tests), the conversion of its answer to page px, and the raster
// helpers for charts (size limits, SVG sanitising, the document, font waits).
// No Chromium, no network: nothing here calls the renderer itself.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MEASURE_PAGE_JS,
  fontsLoadedScript,
  parseMeasurements,
  rasterSize,
  stripActiveSvg,
  svgDocument,
  fontLoadSpecs,
  apiRenderingEnabled,
  handleRequest,
  type PreviewRequest,
} from '../../src/lib/magazineV2/renderPreview.js';
import { googleFontHref, previewSrc } from '../../src/lib/magazineV2/previewHtml.js';

// ── a minimal stand-in for the proof's DOM ───────────────────────────────────

interface FakeRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}
function rect(x: number, y: number, w: number, h: number): FakeRect {
  return { left: x, top: y, right: x + w, bottom: y + h, width: w, height: h };
}
interface FakeTextNode {
  nodeValue: string;
  rects: FakeRect[];
}
interface FakeEl {
  id: string;
  style: { left: string; top: string; width: string; height: string; transform: string };
  text?: { scrollWidth: number; scrollHeight: number; bcr: FakeRect; nodes: FakeTextNode[] };
  img?: { complete: boolean; naturalWidth: number };
}

function runMeasure(pageRect: FakeRect, els: FakeEl[]): unknown {
  const nodes = els.map((e) => ({
    getAttribute: (name: string) => (name === 'data-el-id' ? e.id : null),
    querySelector: (sel: string) => {
      if (sel === '[data-el-text]' && e.text) return { ...e.text, getBoundingClientRect: () => e.text!.bcr };
      if (sel === 'img' && e.img) return e.img;
      return null;
    },
    style: e.style,
  }));
  const root = { getBoundingClientRect: () => pageRect, querySelectorAll: () => nodes };
  const document = {
    getElementById: (id: string) => (id === 'page' ? root : null),
    createTreeWalker: (node: { nodes: FakeTextNode[] }) => {
      let i = -1;
      return { nextNode: () => node.nodes[++i] ?? null };
    },
    createRange: () => {
      let current: FakeTextNode | null = null;
      return {
        selectNodeContents: (n: FakeTextNode) => {
          current = n;
        },
        getClientRects: () => current?.rects ?? [],
      };
    },
  };
  const getComputedStyle = (n: { style: FakeEl['style'] }) => n.style;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('document', 'getComputedStyle', 'NodeFilter', `return ${MEASURE_PAGE_JS}`)(document, getComputedStyle, { SHOW_TEXT: 4 });
}

const BOX = { left: '10px', top: '20px', width: '300px', height: '50px', transform: 'none' };

test('the measuring script reports boxes, content size, text ink and image state', () => {
  const raw = runMeasure(rect(8, 8, 620, 877), [
    {
      id: 'body-1',
      style: BOX,
      text: {
        scrollWidth: 300,
        scrollHeight: 92,
        bcr: rect(18, 28, 300, 91.5),
        nodes: [
          { nodeValue: 'The first line', rects: [rect(18, 28, 280, 30), rect(18, 58, 120, 30)] },
          // Whitespace between paragraphs draws nothing and must not widen the ink.
          { nodeValue: '\n  ', rects: [rect(0, 0, 900, 900)] },
          { nodeValue: 'last', rects: [rect(18, 88, 60, 30), rect(0, 0, 0, 0)] },
        ],
      },
    },
    { id: 'photo-1', style: { ...BOX, left: '0px' }, img: { complete: true, naturalWidth: 0 } },
    { id: 'photo-2', style: { ...BOX, top: '100.5px' }, img: { complete: false, naturalWidth: 0 } },
    { id: 'rot-1', style: { ...BOX, transform: 'matrix(0, 1, -1, 0, 0, 0)' }, text: { scrollWidth: 301, scrollHeight: 40, bcr: rect(0, 0, 500, 500), nodes: [{ nodeValue: 'x', rects: [rect(0, 0, 10, 10)] }] } },
  ]) as { pageW: number; pageH: number; items: Array<Record<string, unknown>> };

  assert.equal(raw.pageW, 620);
  assert.equal(raw.pageH, 877);
  const [text, broken, loading, rotated] = raw.items;
  assert.deepEqual(text, {
    id: 'body-1',
    box: { x: 10, y: 20, w: 300, h: 50 },
    contentW: 300,
    contentH: 92,
    // Union of the drawn runs, relative to the page's own corner (8,8).
    ink: { x: 10, y: 20, w: 280, h: 90 },
  });
  assert.equal(broken!.imgOk, false, 'finished loading with no pixels = broken');
  assert.equal('imgOk' in loading!, false, 'still loading = unknown, not broken');
  assert.equal((loading!.box as { y: number }).y, 100.5);
  // A rotated box: its client rects are rotated too, so no ink — only its scroll size.
  assert.equal('ink' in rotated!, false);
  assert.equal(rotated!.contentW, 301);
});

test('the measuring script is null without a page', () => {
  const out = new Function('document', 'getComputedStyle', 'NodeFilter', `return ${MEASURE_PAGE_JS}`)(
    { getElementById: () => null },
    () => ({}),
    { SHOW_TEXT: 4 },
  );
  assert.equal(out, null);
});

test('measurements convert to PAGE px and junk is dropped', () => {
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
  // Laid out at the canonical width: 1:1.
  assert.deepEqual(parseMeasurements({ pageW: 1240, items: [{ id: 'a', box: { x: 1, y: 2, w: 3, h: 4 } }] }, 1240), [{ id: 'a', box: { x: 1, y: 2, w: 3, h: 4 } }]);
  assert.equal(parseMeasurements(null, 1240), null);
  assert.equal(parseMeasurements({ pageW: 0, items: [] }, 1240), null);
  assert.equal(parseMeasurements({ pageW: 620 }, 1240), null);
});

test('the fonts-loaded check needs a loaded face for every listed family', () => {
  const run = (faces: Array<{ family: string; status: string }>, families: string[]) =>
    new Function('document', `return ${fontsLoadedScript(families)}`)({ fonts: { forEach: (fn: (f: unknown) => void) => faces.forEach(fn) } });
  assert.equal(run([{ family: '"Archivo"', status: 'loaded' }, { family: 'Lora', status: 'unloaded' }], ['archivo']), true);
  assert.equal(run([{ family: '"Archivo"', status: 'loaded' }, { family: 'Lora', status: 'error' }], ['archivo', 'lora']), false);
  assert.equal(run([], []), true);
  // A family name can never break out of the script.
  assert.doesNotThrow(() => run([], ['a"]); throw 1; //']));
});

// ── rasterising charts ───────────────────────────────────────────────────────

test('raster size: whole px, clamped sides, scale 2 by default and lowered for huge boxes', () => {
  assert.deepEqual(rasterSize(600.4, 400.6), { width: 600, height: 401, scale: 2 });
  assert.deepEqual(rasterSize(600, 400, 3), { width: 600, height: 400, scale: 3 });
  assert.deepEqual(rasterSize(600, 400, 99), { width: 600, height: 400, scale: 4 });
  assert.deepEqual(rasterSize(600, 400, 0.2), { width: 600, height: 400, scale: 1 });
  assert.equal(rasterSize(9_999, 9_999)?.width, 4_096);
  const big = rasterSize(4_000, 4_000, 4)!;
  assert.ok(big.width * big.scale * big.height * big.scale <= 36_000_000);
  assert.equal(rasterSize(0, 100), null);
  assert.equal(rasterSize(Number.NaN, 100), null);
});

test('an SVG is stripped of anything that could run before it is drawn', () => {
  const out = stripActiveSvg(
    '<svg viewBox="0 0 10 10" onload="x()"><script>alert(1)</script><foreignObject><div>hi</div></foreignObject><a href="javascript:alert(1)"><text>ok</text></a><rect onclick=\'y()\' width="1"/></svg>',
  );
  assert.doesNotMatch(out, /script|alert|onload|onclick|foreignObject|javascript:/i);
  assert.match(out, /<text>ok<\/text>/);
  assert.match(out, /<rect width="1"\/>/);
});

test('the raster document: the SVG alone at its box size on a transparent page, Google Fonts only', () => {
  const archivo = googleFontHref('Archivo', [400, 700])!;
  const html = svgDocument('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400"><text>A</text></svg>', { width: 600, height: 400 }, [
    archivo,
    'https://evil.example/x.css',
    archivo,
  ]);
  assert.ok(html);
  assert.equal(html.match(/<link /g)?.length, 1, 'one font link, the foreign stylesheet refused, duplicates merged');
  assert.match(html, /background:transparent;width:600px;height:400px/);
  assert.match(html, /body>svg\{display:block;width:600px;height:400px\}/);
  assert.match(html, /<body><svg xmlns/);
  assert.doesNotMatch(html, /<\?xml/);
  assert.equal(svgDocument('<div>not a chart</div>', { width: 10, height: 10 }), null);
  assert.equal(svgDocument('', { width: 10, height: 10 }), null);
});

test('font waits name exactly the faces the chart links declare', () => {
  assert.deepEqual(fontLoadSpecs([googleFontHref('Archivo', [400, 700])!, googleFontHref('DM Serif Display')!, 'https://evil.example/x.css']), [
    '400 16px "Archivo"',
    '700 16px "Archivo"',
    '400 16px "DM Serif Display"',
  ]);
  assert.deepEqual(fontLoadSpecs([]), []);
});

// ── The proof never fetches a host a client named ────────────────────────────

function fakeRequest(url: string, type: string) {
  const seen: { action?: string; contentType?: string } = {};
  const req: PreviewRequest = {
    url: () => url,
    resourceType: () => type,
    continue: async () => {
      seen.action = 'continue';
    },
    abort: async () => {
      seen.action = 'abort';
    },
    respond: async (r) => {
      seen.action = 'respond';
      seen.contentType = r.contentType;
    },
  };
  return { req, seen };
}

test('an image on any other host is drawn as a stand-in, never fetched (no SSRF)', async () => {
  for (const url of [
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost:4000/api/admin',
    'http://127.0.0.1.nip.io/x.png',
    'https://internal-service.onrender.internal/secret.jpg',
    'https://images.example.com/photo.jpg',
  ]) {
    const { req, seen } = fakeRequest(url, 'image');
    await handleRequest(req);
    assert.equal(seen.action, 'respond', url);
    assert.equal(seen.contentType, 'image/svg+xml', url);
  }
  // Scripts, frames and XHR stay refused; data: urls and Google Fonts still load.
  const xhr = fakeRequest('https://example.com/api', 'xhr');
  await handleRequest(xhr.req);
  assert.equal(xhr.seen.action, 'abort');
  const data = fakeRequest('data:image/png;base64,AAAA', 'image');
  await handleRequest(data.req);
  assert.equal(data.seen.action, 'continue');
  const font = fakeRequest('https://fonts.gstatic.com/s/inter.woff2', 'font');
  await handleRequest(font.req);
  assert.equal(font.seen.action, 'continue');
});

test('previewSrc drops loopback, private and link-local picture urls', () => {
  assert.equal(previewSrc('http://169.254.169.254/latest/meta-data/'), '');
  assert.equal(previewSrc('http://localhost:4000/a.jpg'), '');
  assert.equal(previewSrc('http://10.0.0.4/a.jpg'), '');
  assert.equal(previewSrc('https://x.example/a.jpg'), 'https://x.example/a.jpg');
});

test('MAGAZINE_V2_API_RENDERING switches Chromium off in the API; on by default', () => {
  assert.equal(apiRenderingEnabled({}), true, 'product decisions 2 and 3: on unless switched off');
  for (const off of ['0', 'off', 'false', 'NO', ' Off ']) assert.equal(apiRenderingEnabled({ MAGAZINE_V2_API_RENDERING: off }), false, off);
  for (const on of ['1', 'on', 'true', 'yes']) assert.equal(apiRenderingEnabled({ MAGAZINE_V2_API_RENDERING: on }), true, on);
});
