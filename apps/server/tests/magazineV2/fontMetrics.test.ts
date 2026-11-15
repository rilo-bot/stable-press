// ---------------------------------------------------------------------------
// Font resolution for measurement — which measured face a font-family value is
// measured as.
//
// The cascade picks the first measured family; an unknown family falls back to the
// widest face of its generic category (conservative). Three cases are resolved to
// the face the browser really draws instead, because the conservative guess was
// wrong for them in a known way: 'inherit' (the Studio's added text boxes) is the
// app's body face, monospace has one advance for every glyph, and the metric twins
// of Times New Roman / Arial share their widths by design.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fontMetricsKey,
  measureRunWidthPx,
  resolveFontMetrics,
  HOST_BODY_FONT_STACK,
} from '../../src/lib/magazineV2/fontMetrics.js';

const PARA = 'The New Owners Group is embarking on a significant owner-focused initiative.';

test('a measured family is used as named, first in the stack winning', () => {
  assert.deepEqual(fontMetricsKey("'Playfair Display', Georgia, serif"), { key: 'playfair display', via: 'named' });
  assert.deepEqual(fontMetricsKey('Unknown Face, Lora, serif'), { key: 'lora', via: 'named' });
});

test("'inherit' (and no family at all) is measured as the app's body face, Source Sans 3", () => {
  for (const stack of ['inherit', '', 'unset', undefined]) {
    assert.deepEqual(fontMetricsKey(stack), { key: 'source sans 3', via: 'host' }, String(stack));
  }
  assert.equal(measureRunWidthPx(PARA, 'inherit', 400, 20), measureRunWidthPx(PARA, HOST_BODY_FONT_STACK, 400, 20));
  // It used to be measured as the widest sans (Archivo): ~5% wider at 400, so every
  // text box the Studio added was shrunk below what really fitted.
  assert.ok(measureRunWidthPx(PARA, 'inherit', 400, 20) < measureRunWidthPx(PARA, 'Archivo', 400, 20));
});

test("'initial' is the browser default face (Times New Roman), not the page's", () => {
  assert.equal(fontMetricsKey('initial').key, 'times new roman');
});

test('monospace: every glyph is the same width, so narrow letters are not under-measured', () => {
  for (const stack of ['Courier New, Courier, monospace', 'monospace', 'Menlo, monospace']) {
    assert.equal(fontMetricsKey(stack).key, 'monospace', stack);
    const narrow = measureRunWidthPx('iiii', stack, 400, 10);
    assert.ok(Math.abs(narrow - measureRunWidthPx('MMMM', stack, 400, 10)) < 1e-9, stack);
    assert.ok(Math.abs(narrow - 4 * 0.602 * 10) < 1e-9, stack);
  }
  // A proportional sans would have measured "illicit" far narrower than it prints.
  assert.ok(measureRunWidthPx('illicit', 'Courier New, monospace', 400, 10) > measureRunWidthPx('illicit', 'Arial', 400, 10) * 1.5);
});

test('metric twins of Times New Roman and Arial measure exactly as their twin', () => {
  assert.deepEqual(fontMetricsKey('Times, serif'), { key: 'times new roman', via: 'twin' });
  assert.equal(measureRunWidthPx(PARA, 'Liberation Serif', 400, 20), measureRunWidthPx(PARA, 'Times New Roman', 400, 20));
  assert.equal(measureRunWidthPx(PARA, 'Arimo, sans-serif', 700, 20), measureRunWidthPx(PARA, 'Arial', 700, 20));
});

test('an unknown family still falls back conservatively by its own generic keyword', () => {
  assert.equal(fontMetricsKey('Some Display Face, serif').via, 'generic');
  assert.equal(fontMetricsKey('Some Display Face, serif').key, 'libre baskerville');
  assert.deepEqual(fontMetricsKey('Some Display Face'), { key: 'archivo', via: 'fallback' });
  assert.equal(fontMetricsKey('Some Display Face, cursive').via, 'generic');
});

test('resolution is stable across calls (it is memoised)', () => {
  const a = resolveFontMetrics('inherit');
  const b = resolveFontMetrics('inherit');
  assert.equal(a, b);
  assert.equal(resolveFontMetrics('monospace').category, 'mono');
});
