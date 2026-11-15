// ---------------------------------------------------------------------------
// previewHtml — the Visual Critic's proof is the page as the reader sees it.
//
// The serialiser must follow the web canvas (IssuePageCanvas.tsx + geometry.ts) rule
// for rule, or the critic judges a different page from the one that ships. Pure: no
// browser, no network. The real render (Chromium) was checked by hand against the
// NZ fixture; these pin the rules.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  pageToPreviewHtml,
  previewSize,
  previewSrc,
  safeCssBackground,
  stripActiveHtml,
  googleFontLinks,
  googleFontHref,
  knownFontWeights,
  curatedFamiliesUsed,
  PREVIEW_ASSET_ORIGIN,
  type PreviewPage,
} from '../../src/lib/magazineV2/previewHtml.js';
import type { MagazineElement } from '../../src/lib/magazineV2/model.js';
import { DISPLAY_FONTS, BODY_FONTS, fontName } from '../../src/lib/magazineV2/creativeDirection.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function el(partial: Partial<MagazineElement> & Pick<MagazineElement, 'type'>): MagazineElement {
  return { id: Math.random().toString(36).slice(2), x: 0, y: 0, w: 100, h: 100, rotation: 0, zIndex: 0, locked: false, source: 'ai-agent', ...partial };
}

const SAMPLE: PreviewPage = {
  width: 1240,
  height: 1754,
  background: { type: 'color', value: '#f4f1ea' },
  elements: [
    el({
      type: 'text',
      x: 124,
      y: 175.4,
      w: 620,
      h: 200,
      zIndex: 3,
      text: {
        content: 'Racing, <strong>Recast</strong>',
        role: 'headline',
        fontFamily: 'Playfair Display, Georgia, serif',
        fontSize: 124,
        fontWeight: 800,
        color: '#12161f',
        align: 'left',
        lineHeight: 1.05,
        autoFit: 'shrink',
        vAlign: 'bottom',
        letterSpacing: 12.4,
        textTransform: 'uppercase',
      },
    }),
    el({
      type: 'image',
      x: 0,
      y: 0,
      w: 1240,
      h: 877,
      zIndex: 0,
      image: { assetId: 'a1', url: 'https://bucket.example/public/x.jpg', alt: 'horse', fit: 'cover', focalPoint: { x: 0.25, y: 0.75 } },
    }),
    el({ type: 'shape', x: 0, y: 600, w: 1240, h: 277, zIndex: 1, shape: { fill: '#0b1f3a', opacity: 0.5 } }),
  ],
};

test('previewSize keeps the page aspect at the proof width', () => {
  assert.deepEqual(previewSize(1240, 1754), { width: 620, height: 877 });
  assert.deepEqual(previewSize(1275, 1650, 510), { width: 510, height: 660 });
  // A page with no dims yet still gets a sane box (the canvas guards the same way).
  assert.equal(previewSize(0, 0).width, 620);
});

test('the page box is a cqw container of exactly the proof size', () => {
  const html = pageToPreviewHtml(SAMPLE, { webFonts: false });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /id="page" style="position:relative;overflow:hidden;width:620px;height:877px;container-type:inline-size/);
});

test('element boxes are % of the canonical page and type lengths are cqw — as geometry.ts does', () => {
  const html = pageToPreviewHtml(SAMPLE, { webFonts: false });
  // x 124/1240 = 10%, y 175.4/1754 = 10%, w 620/1240 = 50%
  assert.match(html, /left:10%;top:10%;width:50%/);
  // fontSize 124px on a 1240 page = 10cqw; letterSpacing 12.4 = 1cqw
  assert.match(html, /font-size:10cqw/);
  assert.match(html, /letter-spacing:1cqw/);
  assert.match(html, /text-transform:uppercase/);
  // vAlign bottom → flex-end, generated copy wraps and clips
  assert.match(html, /justify-content:flex-end/);
  assert.match(html, /white-space:pre-wrap/);
  // Font stacks keep their quotes safely inside the double-quoted attribute.
  assert.match(html, /font-family:Playfair Display, Georgia, serif/);
});

test('elements paint in zIndex order (image, then scrim, then text)', () => {
  const html = pageToPreviewHtml(SAMPLE, { webFonts: false });
  const img = html.indexOf('<img src="https://bucket.example/public/x.jpg"');
  const scrim = html.indexOf('background:#0b1f3a');
  const text = html.indexOf('Racing, <strong>Recast</strong>');
  assert.ok(img > 0 && scrim > img && text > scrim, `order was img ${img}, scrim ${scrim}, text ${text}`);
});

test('images keep their fit and focal point; shapes keep their scrim opacity', () => {
  const html = pageToPreviewHtml(SAMPLE, { webFonts: false });
  assert.match(html, /object-fit:cover;object-position:25% 75%/);
  assert.match(html, /background:#0b1f3a;opacity:0.5/);
});

test('extracted text keeps its own line breaks and may spill, like the canvas', () => {
  const page: PreviewPage = {
    ...SAMPLE,
    elements: [
      el({
        type: 'text',
        source: 'extracted',
        // Measured as the extractor measures: a box exactly as tall as its two lines.
        h: 48,
        text: { content: 'A\nB', role: 'body', fontFamily: 'Arial', fontSize: 20, fontWeight: 400, color: '#000000', align: 'left', lineHeight: 1.2, autoFit: 'clip' },
      }),
    ],
  };
  const html = pageToPreviewHtml(page, { webFonts: false });
  assert.match(html, /overflow:visible/);
  assert.match(html, /white-space:pre(;|")/);
});

test('a gradient page background is painted, an unsafe one is not', () => {
  assert.equal(safeCssBackground('linear-gradient(135deg, #283a52 0%, #0B1F3A 45%, #09182d 100%)'), 'linear-gradient(135deg, #283a52 0%, #0B1F3A 45%, #09182d 100%)');
  assert.equal(safeCssBackground('#ABCDEF'), '#ABCDEF');
  assert.equal(safeCssBackground('url(https://evil.example/x.png)'), '#ffffff');
  assert.equal(safeCssBackground('red;position:fixed'), '#ffffff');
  assert.equal(safeCssBackground(undefined), '#ffffff');
});

test('image sources: absolute and data pass, relative proxy URLs are anchored, scripts are dropped', () => {
  assert.equal(previewSrc('https://x.example/a.jpg'), 'https://x.example/a.jpg');
  assert.equal(previewSrc('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(previewSrc('/api/uploads/file/public/m/1.jpg'), `${PREVIEW_ASSET_ORIGIN}/api/uploads/file/public/m/1.jpg`);
  assert.equal(previewSrc('javascript:alert(1)'), '');
  assert.equal(previewSrc('//evil.example/x.jpg'), '');
  assert.equal(previewSrc(''), '');
});

test('active HTML in copy is stripped (defence in depth; the write path already sanitises)', () => {
  const out = stripActiveHtml('Hi <script>alert(1)</script><b onclick="x()">there</b><iframe src="x"></iframe><a href="javascript:void(0)">l</a>');
  assert.doesNotMatch(out, /script|alert|onclick|iframe|javascript:/i);
  assert.match(out, /<b>there<\/b>/);
});

test('web fonts: one link per non-system family, known weights only', () => {
  const links = googleFontLinks([
    ...SAMPLE.elements,
    el({ type: 'text', text: { content: 'x', role: 'body', fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 20, fontWeight: 400, color: '#000000', align: 'left', lineHeight: 1.3, autoFit: 'shrink' } }),
    el({ type: 'text', text: { content: 'y', role: 'body', fontFamily: 'Oswald, Arial, sans-serif', fontSize: 20, fontWeight: 700, color: '#000000', align: 'left', lineHeight: 1.3, autoFit: 'shrink' } }),
    el({ type: 'text', text: { content: 'z', role: 'body', fontFamily: "'Libre Caslon Text', serif", fontSize: 20, fontWeight: 400, color: '#000000', align: 'left', lineHeight: 1.3, autoFit: 'shrink' } }),
  ]);
  assert.deepEqual(links, [
    'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;600;700;800;900&display=swap',
    'https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&display=swap',
    // Unknown to us: requested at its default weight, so Google cannot reject the link.
    'https://fonts.googleapis.com/css2?family=Libre+Caslon+Text&display=swap',
  ]);
  assert.match(pageToPreviewHtml(SAMPLE), /<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/css2\?family=Playfair\+Display/);
});

test('every NZ fixture page serialises, with one block per renderable element', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'nz-racing-scene.json'), 'utf8')) as { pages: PreviewPage[] };
  for (const page of fixture.pages) {
    const html = pageToPreviewHtml(page, { webFonts: false });
    const renderable = page.elements.filter((e) => e.type !== 'image' || e.image?.url).length;
    // Each element opens with an absolutely positioned box.
    const boxes = html.match(/style="position:absolute;left:/g)?.length ?? 0;
    assert.equal(boxes, renderable, `page ${page.width}x${page.height}`);
    // ...and every one of them carries its element's id for the Chromium page check.
    assert.equal(html.match(/" data-el-id="/g)?.length ?? 0, renderable, `ids on page ${page.width}x${page.height}`);
  }
});

// ── element identity: what the Chromium page check keys its measurements by ──────

test('every element kind carries data-el-id on its outer box; text marks its content div', () => {
  const page: PreviewPage = {
    width: 1240,
    height: 1754,
    background: { type: 'color', value: '#ffffff' },
    elements: [
      el({ id: 'txt-1', type: 'text', text: { content: 'Hello', role: 'body', fontFamily: 'Arial', fontSize: 20, fontWeight: 400, color: '#000000', align: 'left', lineHeight: 1.3, autoFit: 'shrink' } }),
      el({ id: 'img-1', type: 'image', image: { assetId: '', url: 'https://x.example/a.jpg', alt: '', fit: 'cover' } }),
      el({ id: 'shp-1', type: 'shape', shape: { fill: '#112233' } }),
      el({ id: 'qr-1', type: 'qr', qr: { url: 'https://x.example', fg: '#000000', bg: '#ffffff' } }),
      el({ id: 'ico-1', type: 'icon', icon: { name: 'star', color: '#ff0000' } }),
      el({ id: 'ico-2', type: 'icon', icon: { src: 'https://x.example/i.png' } }),
    ],
  };
  const html = pageToPreviewHtml(page, { webFonts: false });
  for (const id of ['txt-1', 'img-1', 'shp-1', 'qr-1', 'ico-1', 'ico-2']) {
    // On the absolutely positioned outer box itself, exactly once.
    const re = new RegExp(`<div style="position:absolute;left:[^"]*" data-el-id="${id}"`, 'g');
    assert.equal(html.match(re)?.length ?? 0, 1, `outer box of ${id}`);
  }
  assert.equal(html.match(/data-el-text/g)?.length ?? 0, 1);
  assert.match(html, /data-el-id="txt-1" data-role="body"><div style="[^"]*" data-el-text>Hello<\/div>/);
});

test('an element id cannot break out of its attribute', () => {
  const html = pageToPreviewHtml(
    { width: 100, height: 100, background: { type: 'color', value: '#ffffff' }, elements: [el({ id: 'a"><script>x</script>', type: 'shape', shape: { fill: '#000000' } })] },
    { webFonts: false },
  );
  assert.match(html, /data-el-id="a&quot;&gt;&lt;script&gt;x&lt;\/script&gt;"/);
  assert.doesNotMatch(html, /<script>/);
});

test('an image with no picture draws nothing (as on the web canvas), so it has no measured box', () => {
  const html = pageToPreviewHtml(
    { width: 100, height: 100, background: { type: 'color', value: '#ffffff' }, elements: [el({ id: 'empty', type: 'image', image: { assetId: '', url: '', alt: '', fit: 'cover' } })] },
    { webFonts: false },
  );
  assert.doesNotMatch(html, /data-el-id/);
});

// ── web fonts: the proof loads the faces the reader's browser loads (C56) ─────────

test('googleFontHref: every weight the web loads, or the nearest real weights asked for', () => {
  assert.equal(googleFontHref('Archivo'), 'https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&display=swap');
  // A CSS stack resolves to its first family, quotes and all.
  assert.equal(googleFontHref("'Source Sans 3', Arial, sans-serif"), 'https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;500;600;700&display=swap');
  assert.equal(googleFontHref('Archivo', [700, 400, 700]), 'https://fonts.googleapis.com/css2?family=Archivo:wght@400;700&display=swap');
  // Lora has no 900: Google would reject the link, and the browser draws 700 anyway.
  assert.equal(googleFontHref('Lora', [900]), 'https://fonts.googleapis.com/css2?family=Lora:wght@700&display=swap');
  // Single-weight and unknown families are asked for at their default weight only.
  assert.equal(googleFontHref('DM Serif Display', [700]), 'https://fonts.googleapis.com/css2?family=DM+Serif+Display&display=swap');
  assert.equal(googleFontHref('Libre Caslon Text', [400, 700]), 'https://fonts.googleapis.com/css2?family=Libre+Caslon+Text&display=swap');
  // System faces and names Google could not serve.
  assert.equal(googleFontHref('Georgia, serif'), null);
  assert.equal(googleFontHref('sans-serif'), null);
  assert.equal(googleFontHref('Evil"<x>'), null);
  assert.equal(googleFontHref(''), null);
});

test('every curated display and body family is requested with its weights, not Regular only (C56)', () => {
  for (const stack of [...DISPLAY_FONTS, ...BODY_FONTS]) {
    const family = fontName(stack);
    const href = googleFontHref(stack);
    if (['georgia', 'arial'].includes(family.toLowerCase())) {
      assert.equal(href, null, family);
      continue;
    }
    assert.ok(knownFontWeights(family) !== null, `${family} is in the known-weights table`);
    if (family === 'DM Serif Display') continue; // one weight only
    assert.match(href ?? '', /:wght@\d/, `${family} carries a weight list`);
    assert.ok((knownFontWeights(family) ?? []).includes(700), `${family} loads a real bold`);
  }
  // The family from the finding: Archivo headlines at 800 get the real ExtraBold.
  assert.ok(knownFontWeights('Archivo')?.includes(800));
});

test('the known-weights table matches what the web app actually loads', (t) => {
  const webRoot = path.join(here, '..', '..', '..', 'web', 'src');
  const registryPath = path.join(webRoot, 'lib', 'fonts', 'registry.ts');
  const themePath = path.join(webRoot, 'styles', 'theme.css');
  if (!fs.existsSync(registryPath) || !fs.existsSync(themePath)) {
    t.skip('web sources not present');
    return;
  }
  // family (lower-case) → upright weights the web requests from Google.
  const web = new Map<string, Set<number>>();
  const add = (spec: string) => {
    const [famRaw, axes = ''] = spec.split(':');
    const family = decodeURIComponent(famRaw!.replace(/\+/g, ' ')).toLowerCase();
    const set = web.get(family) ?? new Set<number>();
    const m = /wght@(.+)$/.exec(axes);
    if (m) {
      for (const tuple of m[1]!.split(';')) {
        const parts = tuple.split(',');
        if (parts.length === 1 || parts[0] === '0') set.add(Number(parts[parts.length - 1]));
      }
    }
    web.set(family, set);
  };
  for (const m of fs.readFileSync(registryPath, 'utf8').matchAll(/googleSpec:\s*'([^']+)'/g)) add(m[1]!);
  for (const m of fs.readFileSync(themePath, 'utf8').matchAll(/family=([^&')]+)/g)) add(m[1]!);
  assert.ok(web.size >= 15, `parsed ${web.size} web families`);
  for (const [family, weights] of web) {
    const known = knownFontWeights(family);
    assert.ok(known !== null, `${family} is loaded by the web but missing from KNOWN_WEIGHTS`);
    // A family the web asks for with no weight list (or italic only) loads its default face.
    const expected = [...weights].filter((w) => Number.isFinite(w)).sort((a, b) => a - b);
    assert.deepEqual(known, expected, family);
  }
});

test('curatedFamiliesUsed lists only curated web faces that have words to draw', () => {
  const t = (fontFamily: string, content: string) =>
    el({ type: 'text', text: { content, role: 'body', fontFamily, fontSize: 20, fontWeight: 400, color: '#000000', align: 'left', lineHeight: 1.3, autoFit: 'shrink' } });
  assert.deepEqual(
    curatedFamiliesUsed([
      t('Archivo, Arial, sans-serif', 'Headline'),
      t("'Archivo'", 'Again'),
      t('Lora, Georgia, serif', '<p> </p>'), // empty: its face never loads
      t('Georgia, serif', 'System face'),
      t('Libre Caslon Text, serif', 'Not curated: the reader falls back too'),
    ]),
    ['archivo'],
  );
});

test('text with no family of its own is drawn, loaded and waited for in the host body face', () => {
  // The web canvas draws an 'inherit' box in the app's body font (Source Sans 3), and
  // the text estimate measures it that way. The proof used to leave it to the bare
  // document's default serif, so the look and the Chromium check saw a face no reader sees.
  const t = (fontFamily: string, content: string) =>
    el({ type: 'text', text: { content, role: 'body', fontFamily, fontSize: 20, fontWeight: 400, color: '#000000', align: 'left', lineHeight: 1.3, autoFit: 'shrink' } });
  const page: PreviewPage = { width: 1240, height: 1754, background: { type: 'color', value: '#ffffff' }, elements: [t('inherit', 'A caption'), t('', 'Another')] };
  assert.deepEqual(googleFontLinks(page.elements), [
    'https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;500;600;700&display=swap',
  ]);
  assert.deepEqual(curatedFamiliesUsed(page.elements), ['source sans 3']);
  const html = pageToPreviewHtml(page);
  assert.match(html, /body\{font-family:'Source Sans 3', Arial, sans-serif\}/);
  // The box itself still inherits, exactly as on the web canvas.
  assert.match(html, /font-family:inherit/);
  // An empty 'inherit' box draws no glyphs, so nothing waits for its face.
  assert.deepEqual(curatedFamiliesUsed([t('inherit', '<p> </p>')]), []);
  // 'initial' is the browser default (Times) for the reader too: not the body face.
  assert.deepEqual(googleFontLinks([t('initial', 'x')]), []);
});
