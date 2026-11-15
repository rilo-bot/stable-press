// Run: npx tsx --test apps/web/src/lib/pdfLines.test.ts
// Same cases as the server's tests/magazineV2/extractedText.test.ts — the two rules
// must agree, or the editor and the AI's preview draw different pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepsPdfLines } from './pdfLines';

const PDF_PARAGRAPH = [
  'The New Zealand Thoroughbred Racing Owners Federation (NZTROF) is',
  'embarking on one of the most significant owner-focused initiatives',
  'undertaken in New Zealand racing for many years, and owners are at',
  'the heart of it.',
].join('\n');
const REWRITE =
  'The New Owners Group (NOG) is embarking on one of the most significant owner-focused initiatives undertaken in New Zealand racing for many years, and owners are at the heart of it.';

// The box the extractor measured: as tall as the PDF's lines (lines × size × 1.2).
const el = (content: string, over: { source?: string; w?: number; h?: number; fontSize?: number } = {}) => {
  const fontSize = over.fontSize ?? 29;
  return {
    source: over.source ?? 'extracted',
    w: over.w ?? 880,
    h: over.h ?? 4 * fontSize * 1.2,
    text: { content, fontSize, lineHeight: 1.2 },
  };
};

test('the PDF’s own lines are drawn as set', () => {
  assert.equal(keepsPdfLines(el(PDF_PARAGRAPH)), true);
});

test('a big caps masthead is drawn as set', () => {
  assert.equal(keepsPdfLines(el('THE NEW OWNERS BULLETIN', { w: 1300, h: 106, fontSize: 88 })), true);
});

test('a rewrite only a little too wide is caught by the box it was measured for', () => {
  const medium = 'The New Owners Group (NOG) is embarking on a significant owner-focused initiative here.';
  assert.equal(keepsPdfLines(el(medium)), false);
});

test('a paragraph rewritten as one long line wraps instead of running off the page', () => {
  assert.equal(keepsPdfLines(el(REWRITE)), false);
});

test('only extracted text is ever drawn without wrapping', () => {
  assert.equal(keepsPdfLines(el(PDF_PARAGRAPH, { source: 'manual' })), false);
  assert.equal(keepsPdfLines(el(PDF_PARAGRAPH, { source: 'ai-agent' })), false);
});

test('tags and entities count as what the reader sees, and <br> is a line break', () => {
  assert.equal(keepsPdfLines(el('The <strong>New Owners</strong> Group &amp; friends<br>second line', { h: 70 })), true);
});
