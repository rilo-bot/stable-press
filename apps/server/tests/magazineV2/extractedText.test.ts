// ---------------------------------------------------------------------------
// Text copied from a PDF — kept exactly as set until it is edited, then it flows.
//
// The client case (2026-11-15): a PDF page copied onto a magazine page, then its
// paragraphs rewritten (NZTROF → NOG). Each rewrite arrived as ONE line, the page
// drew extracted text without wrapping, and every paragraph ran off the right edge;
// no font or box change could fix it. These pin both halves of the fix.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { keepsPdfLines, editsPdfSetting, asFlowingText } from '../../src/lib/magazineV2/extractedText.js';
import { normalizeElementPatch } from '../../src/lib/magazineV2/writePipeline.js';
import { pageToPreviewHtml, type PreviewPage } from '../../src/lib/magazineV2/previewHtml.js';
import { measureElementText } from '../../src/lib/magazineV2/layout.js';
import type { MagazineElement } from '../../src/lib/magazineV2/model.js';

const PAGE = { width: 1588, height: 2246 };

/** A body paragraph as the extractor leaves it: the PDF's lines joined by "\n",
 *  in a box measured tight to them (about 0.45em per character at 29px). */
const PDF_PARAGRAPH = [
  'The New Zealand Thoroughbred Racing Owners Federation (NZTROF) is',
  'embarking on one of the most significant owner-focused initiatives',
  'undertaken in New Zealand racing for many years, and owners are at',
  'the heart of it.',
].join('\n');

function extracted(content = PDF_PARAGRAPH, over: Partial<MagazineElement> = {}): MagazineElement {
  return {
    id: 'e1',
    type: 'text',
    x: 120,
    y: 400,
    w: 880,
    h: 140,
    rotation: 0,
    zIndex: 1,
    locked: false,
    source: 'extracted',
    text: {
      content,
      role: 'body',
      fontFamily: 'Times New Roman, serif',
      fontSize: 29,
      fontWeight: 400,
      color: '#111111',
      align: 'left',
      lineHeight: 1.2,
      autoFit: 'shrink',
    },
    ...over,
  } as MagazineElement;
}

const REWRITE =
  'The New Owners Group (NOG) is embarking on one of the most significant owner-focused initiatives undertaken in New Zealand racing for many years, and owners are at the heart of it.';

// ── The renderers' safety net ────────────────────────────────────────────────

test('the PDF’s own lines are drawn as set', () => {
  assert.equal(keepsPdfLines(extracted()), true);
});

test('a short masthead in big caps is still drawn as set', () => {
  const el = extracted('THE NEW OWNERS BULLETIN', { w: 1300, h: 110 });
  el.text!.fontSize = 88;
  el.text!.textTransform = 'uppercase';
  assert.equal(keepsPdfLines(el), true);
});

test('a paragraph rewritten as one long line is NOT drawn as set (it would run off the page)', () => {
  assert.equal(keepsPdfLines(extracted(REWRITE)), false);
});

test('only extracted text is ever drawn without wrapping', () => {
  assert.equal(keepsPdfLines({ ...extracted(), source: 'manual' }), false);
  assert.equal(keepsPdfLines({ ...extracted(), source: 'ai-agent' }), false);
});

test('tags and entities count as what the reader sees, and <br> is a line break', () => {
  const html = 'The <strong>New Owners</strong> Group &amp; friends<br>second line';
  assert.equal(keepsPdfLines(extracted(html, { h: 70 })), true);
});

test('a single-line PDF caption is drawn as set', () => {
  assert.equal(keepsPdfLines(extracted('Photo: Trackside Photography', { w: 420, h: 35 })), true);
});

test('a rewrite only a little too wide is caught by the box it was measured for', () => {
  // ~85 characters: the width estimate alone would let it through, but one line in a
  // box measured for four is not the PDF's setting.
  const medium = 'The New Owners Group (NOG) is embarking on a significant owner-focused initiative here.';
  assert.equal(keepsPdfLines(extracted(medium)), false);
});

test('the preview the AI judges wraps a rewritten copied paragraph, like the web canvas', () => {
  const page: PreviewPage = { ...PAGE, background: { type: 'color', value: '#ffffff' }, elements: [extracted(REWRITE)] };
  const html = pageToPreviewHtml(page, { webFonts: false });
  assert.match(html, /white-space:pre-wrap/);
  assert.doesNotMatch(html, /white-space:pre(;|")/);
});

// ── Edits turn the copy into flowing text ────────────────────────────────────

test('rewriting the words turns it into flowing text that shrinks to fit from its measured size', () => {
  const out = normalizeElementPatch(extracted(), { text: { content: REWRITE } }, PAGE)!;
  assert.equal(out.source, 'manual');
  assert.equal(out.text!.content, REWRITE);
  assert.equal(out.text!.autoFit, 'shrink');
  assert.equal(out.text!.maxFontSize, 29);
  assert.ok(out.text!.fontSize <= 29, `refit to the box, got ${out.text!.fontSize}`);
  assert.equal(keepsPdfLines(out), false);
});

test('an explicit new size is kept as asked (and becomes the ceiling), the text still flows', () => {
  const out = normalizeElementPatch(extracted(), { text: { fontSize: 23 } }, PAGE)!;
  assert.equal(out.source, 'manual');
  assert.equal(out.text!.fontSize, 23);
  assert.equal(out.text!.maxFontSize, 23);
});

test('narrowing the box turns it into flowing text too', () => {
  const out = normalizeElementPatch(extracted(), { w: 500 }, PAGE)!;
  assert.equal(out.source, 'manual');
});

test('moving, recolouring or changing only the height keeps the exact copy', () => {
  for (const patch of [{ x: 200, y: 500 }, { text: { color: '#003366' } }, { h: 200 }]) {
    const out = normalizeElementPatch(extracted(), patch, PAGE)!;
    assert.equal(out.source, 'extracted', JSON.stringify(patch));
    assert.equal(out.text!.content, PDF_PARAGRAPH);
    assert.equal(out.text!.fontSize, 29);
  }
});

test('re-sending the same words is not an edit', () => {
  assert.equal(editsPdfSetting(extracted(), { text: { content: PDF_PARAGRAPH } }), false);
  assert.equal(normalizeElementPatch(extracted(), { text: { content: PDF_PARAGRAPH } }, PAGE)!.source, 'extracted');
});

test('ordinary text is untouched by the rule', () => {
  const manual = { ...extracted(), source: 'manual' as const };
  assert.equal(editsPdfSetting(manual, { text: { content: REWRITE } }), false);
});

test('a design ceiling the element already has is kept', () => {
  const merged = asFlowingText({ ...extracted(), text: { ...extracted().text!, maxFontSize: 40 } });
  assert.equal((merged.text as { maxFontSize: number }).maxFontSize, 40);
});

// ── Measured the way it is drawn ─────────────────────────────────────────────

test('copied text still set as the PDF set it is measured line for line, never wrapped', () => {
  const m = measureElementText(extracted())!;
  assert.equal(m.noWrap, true);
  assert.equal(m.lines, 4);
  assert.ok(Math.abs(m.needPx - 4 * 29 * 1.2) < 1e-9);
});

test('a rewritten copied paragraph is refit so it fits its box, by the measure the page check uses', () => {
  const out = normalizeElementPatch(extracted(), { text: { content: REWRITE } }, PAGE)!;
  const m = measureElementText(out)!;
  assert.equal(m.noWrap, false);
  assert.equal(m.fits, true, `needs ${m.needPx}px of ${m.havePx}px at ${m.fontSize}px`);
});

test('copied lines joined with <br> are measured as lines too (the same rule as "\\n")', () => {
  const br = extracted(PDF_PARAGRAPH.split('\n').join('<br>'));
  assert.equal(keepsPdfLines(br), true);
  assert.equal(measureElementText(br)!.lines, 4);
});

test('a copy made bigger is asked-for: kept at that size, the ceiling, and not shrunk back by the next edit', () => {
  const bigger = normalizeElementPatch(extracted(), { text: { fontSize: 32 }, h: 400 }, PAGE)!;
  assert.equal(bigger.text!.fontSize, 32);
  assert.equal(bigger.text!.maxFontSize, 32);
  const fixed = normalizeElementPatch(bigger, { text: { content: REWRITE } }, PAGE)!;
  assert.equal(fixed.text!.maxFontSize, 32);
  assert.equal(fixed.text!.fontSize, measureElementText(fixed)!.fitsAtPx, 'refit from 32 to the largest size that fits');
});
