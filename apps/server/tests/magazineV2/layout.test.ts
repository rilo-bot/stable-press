// ---------------------------------------------------------------------------
// fitFontSize / estimateTextHeight / readableColor — the "text never overflows"
// and "text stays legible" halves of the design.
//
// fitFontSize must be CONSERVATIVE (it may under-estimate the available size, but
// must never claim text fits when it doesn't) because the generator bakes its
// answer into the stored element and layout QA trusts it.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fitFontSize,
  estimateTextHeight,
  contrastRatio,
  readableColor,
  refitText,
  plainTextForMeasure,
  widestLineWidthPx,
  measureElementText,
} from '../../src/lib/magazineV2/layout.js';
import type { MagazineElement } from '../../src/lib/magazineV2/model.js';

const FONT = { fontFamily: 'Inter, Arial, sans-serif', fontWeight: 400 };

test('the fitted size never exceeds max nor falls below min', () => {
  const size = fitFontSize({
    text: 'A very long paragraph. '.repeat(60),
    boxW: 300, boxH: 120, maxFontSize: 96, minFontSize: 14, lineHeight: 1.5, ...FONT,
  });
  assert.ok(size >= 14 && size <= 96, `got ${size}`);
});

test('short copy in a big box keeps the design ceiling', () => {
  const size = fitFontSize({ text: 'Hi', boxW: 1000, boxH: 600, maxFontSize: 96, minFontSize: 40, lineHeight: 1.05, ...FONT });
  assert.equal(size, 96);
});

test('the fitted text actually fits the box it was fitted to', () => {
  const text = 'Thoroughbred sales hit a decade high across the Waikato as new owners entered the market.';
  const boxW = 420;
  const boxH = 180;
  const lineHeight = 1.5;
  const size = fitFontSize({ text, boxW, boxH, maxFontSize: 60, minFontSize: 12, lineHeight, ...FONT });
  const h = estimateTextHeight({ text, fontSize: size, boxWidthPx: boxW, lineHeight, ...FONT });
  assert.ok(h <= boxH, `fitted to ${size}px but estimates ${h}px in a ${boxH}px box`);
});

test('more copy in the same box never yields a LARGER size (monotonic)', () => {
  const box = { boxW: 400, boxH: 200, maxFontSize: 72, minFontSize: 10, lineHeight: 1.4, ...FONT };
  let prev = Infinity;
  for (const n of [1, 5, 20, 60, 200]) {
    const size = fitFontSize({ text: 'word '.repeat(n), ...box });
    assert.ok(size <= prev, `${n} words fitted larger (${size}) than fewer words (${prev})`);
    prev = size;
  }
});

test('a narrower box never yields a LARGER size', () => {
  const text = 'Sales hit a decade high across the region this season.';
  let prev = 0;
  for (const boxW of [120, 240, 480, 960]) {
    const size = fitFontSize({ text, boxW, boxH: 300, maxFontSize: 72, minFontSize: 10, lineHeight: 1.3, ...FONT });
    assert.ok(size >= prev, `widening to ${boxW} shrank the size (${size} < ${prev})`);
    prev = size;
  }
});

test('the longest WORD must fit the box width — no mid-word breaks', () => {
  // "THOROUGHBRED" splitting as THOROUG|HBRED always reads as broken, so the
  // fitter shrinks until the widest word fits.
  const boxW = 200;
  const size = fitFontSize({
    text: 'THOROUGHBRED', boxW, boxH: 400, maxFontSize: 96, minFontSize: 8, lineHeight: 1.05, ...FONT,
  });
  const oneLine = estimateTextHeight({ text: 'THOROUGHBRED', fontSize: size, boxWidthPx: boxW, lineHeight: 1.05, ...FONT });
  assert.ok(oneLine <= size * 1.05 * 1.01, `expected a single line at ${size}px, got ${oneLine}px of height`);
});

test('empty or tag-only text returns the ceiling rather than collapsing', () => {
  for (const text of ['', '   ', '<b></b>', '<br>']) {
    assert.equal(fitFontSize({ text, boxW: 300, boxH: 100, maxFontSize: 40, minFontSize: 12, lineHeight: 1.3, ...FONT }), 40);
  }
});

test('explicit newlines are honoured as line breaks', () => {
  const oneLine = estimateTextHeight({ text: 'a', fontSize: 20, boxWidthPx: 500, lineHeight: 1.5, ...FONT });
  const threeLines = estimateTextHeight({ text: 'a\nb\nc', fontSize: 20, boxWidthPx: 500, lineHeight: 1.5, ...FONT });
  assert.ok(threeLines >= oneLine * 3 - 0.01, `expected ~3× the height, got ${threeLines} vs ${oneLine}`);
});

test('uppercase transform measures wider than mixed case', () => {
  const args = { text: 'sales hit a decade high', fontSize: 40, boxWidthPx: 300, lineHeight: 1.2, ...FONT };
  const plain = estimateTextHeight(args);
  const upper = estimateTextHeight({ ...args, textTransform: 'uppercase' });
  assert.ok(upper >= plain, 'uppercasing widens real glyphs, so it must not measure narrower');
});

test('HTML tags do not count toward measured length', () => {
  const bare = estimateTextHeight({ text: 'hello world', fontSize: 30, boxWidthPx: 400, lineHeight: 1.3, ...FONT });
  const tagged = estimateTextHeight({ text: '<b>hello</b> <i>world</i>', fontSize: 30, boxWidthPx: 400, lineHeight: 1.3, ...FONT });
  assert.equal(tagged, bare);
});

test('contrastRatio matches the WCAG extremes', () => {
  assert.ok(Math.abs(contrastRatio('#ffffff', '#000000') - 21) < 0.01);
  assert.ok(Math.abs(contrastRatio('#ffffff', '#ffffff') - 1) < 0.01);
  assert.equal(contrastRatio('#000000', '#ffffff'), contrastRatio('#ffffff', '#000000'), 'must be symmetric');
});

test('readableColor keeps a legible choice and replaces an illegible one', () => {
  // Legible already → kept.
  assert.equal(readableColor('#ffffff', '#0e0e0e', '#ffffff', '#111111'), '#ffffff');
  // Light grey on white fails 3.5:1 → swap to the dark candidate.
  assert.equal(readableColor('#eeeeee', '#ffffff', '#ffffff', '#111111'), '#111111');
  // Dark on a dark scrim → swap to the light candidate.
  assert.equal(readableColor('#111111', '#0e0e0e', '#ffffff', '#111111'), '#ffffff');
});

test('refitText only touches shrink-to-fit text that declares a ceiling', () => {
  const els = [
    // Generated: autoFit shrink + maxFontSize → refit.
    { id: 'a', type: 'text', x: 0, y: 0, w: 200, h: 40, rotation: 0, zIndex: 0, locked: false, source: 'ai-agent',
      text: { content: 'A long headline that cannot possibly fit at ninety-six pixels', role: 'headline', fontFamily: FONT.fontFamily, fontSize: 96, maxFontSize: 96, fontWeight: 800, color: '#111111', align: 'left', lineHeight: 1.05, autoFit: 'shrink' } },
    // Extracted: no maxFontSize → the extractor's measured size is authoritative.
    { id: 'b', type: 'text', x: 0, y: 0, w: 200, h: 40, rotation: 0, zIndex: 0, locked: false, source: 'extracted',
      text: { content: 'Measured from the source PDF', role: 'body', fontFamily: FONT.fontFamily, fontSize: 33, fontWeight: 400, color: '#111111', align: 'left', lineHeight: 1.2, autoFit: 'shrink' } },
    // Clip: opted out of shrinking.
    { id: 'c', type: 'text', x: 0, y: 0, w: 200, h: 40, rotation: 0, zIndex: 0, locked: false, source: 'manual',
      text: { content: 'Deliberately clipped, not shrunk', role: 'body', fontFamily: FONT.fontFamily, fontSize: 80, maxFontSize: 80, fontWeight: 400, color: '#111111', align: 'left', lineHeight: 1.3, autoFit: 'clip' } },
  ] as unknown as MagazineElement[];

  const out = refitText(els);
  assert.ok(out[0]!.text!.fontSize < 96, 'generated text should have been shrunk to fit');
  assert.equal(out[1]!.text!.fontSize, 33, 'extracted text must keep its measured size');
  assert.equal(out[2]!.text!.fontSize, 80, 'clip text must not be refitted');
});

// ── Reading copy the way the browser draws it (<br> breaks, bold runs) ──────────
//
// Both AI writers are told to use light inline HTML (<b> <i> <u> <br>). The estimator
// used to drop <br> without a break and measure bold at the regular weight, so a
// results list or a bold lead-in was "fitted" at a size whose last line was cut off.

const LIST = [
  '1st Desert Sky — J. Smith',
  '2nd Prince of Waikato — A. Brown',
  '3rd Ocean Belle — K. Lee',
  '4th Mighty Ruler — S. Ng',
  '5th Silver Comet — R. Patel',
];
const GEORGIA = "Georgia, 'Times New Roman', serif";
const PARA =
  'The New Owners Group is embarking on one of the most significant owner-focused initiatives undertaken in New Zealand racing for many years.';

test('a <br> is a line break: <br>-separated lines measure exactly like newline-separated ones', () => {
  const args = { fontSize: 20, boxWidthPx: 500, lineHeight: 1.5, ...FONT };
  assert.equal(estimateTextHeight({ ...args, text: 'a<br>b<br>c' }), estimateTextHeight({ ...args, text: 'a\nb\nc' }));
  assert.equal(estimateTextHeight({ ...args, text: 'a<br/>b<br />c' }), estimateTextHeight({ ...args, text: 'a\nb\nc' }));
});

test('five <br>-separated lines in a 600×200 box fit at 33px, not the 40px that cut the last line off', () => {
  const box = { boxW: 600, boxH: 200, maxFontSize: 40, minFontSize: 10, lineHeight: 1.2, ...FONT };
  const withBr = fitFontSize({ text: LIST.join('<br>'), ...box });
  assert.equal(withBr, fitFontSize({ text: LIST.join('\n'), ...box }));
  assert.equal(withBr, 33);
  const h = estimateTextHeight({ text: LIST.join('<br>'), fontSize: withBr, boxWidthPx: 600, lineHeight: 1.2, ...FONT });
  assert.ok(h <= 200, `fitted to ${withBr}px but needs ${h}px of a 200px box`);
});

test('a break that ends the copy opens no new line, as in the browser; two show a blank line', () => {
  const args = { fontSize: 20, boxWidthPx: 500, lineHeight: 1, fontFamily: GEORGIA, fontWeight: 400 };
  assert.equal(estimateTextHeight({ ...args, text: 'a<br>' }), 20);
  assert.equal(estimateTextHeight({ ...args, text: 'a\n' }), 20);
  assert.equal(estimateTextHeight({ ...args, text: 'a<br><br>' }), 40);
});

test('bold copy is measured at the bold weight: it wraps where the browser wraps it', () => {
  const args = { fontSize: 24, boxWidthPx: 380, lineHeight: 1, fontFamily: GEORGIA, fontWeight: 400 };
  const regular = estimateTextHeight({ ...args, text: PARA });
  const bold = estimateTextHeight({ ...args, text: `<b>${PARA}</b>` });
  assert.equal(bold, estimateTextHeight({ ...args, text: PARA, fontWeight: 700 }));
  assert.ok(bold > regular, `bold Georgia is ~15% wider, so it must take more lines (${bold} vs ${regular})`);
  assert.equal(estimateTextHeight({ ...args, text: `<strong>${PARA}</strong>` }), bold);
  assert.equal(estimateTextHeight({ ...args, text: `<span style="font-weight: 700">${PARA}</span>` }), bold);
});

test('an inline font-weight beats the tag, and a closing tag restores the weight it replaced', () => {
  const args = { fontSize: 24, boxWidthPx: 380, lineHeight: 1, fontFamily: GEORGIA, fontWeight: 400 };
  const regular = estimateTextHeight({ ...args, text: PARA });
  assert.equal(estimateTextHeight({ ...args, text: `<b style="font-weight:400">${PARA}</b>` }), regular);
  assert.equal(estimateTextHeight({ ...args, text: `<b>x</b> ${PARA}` }), estimateTextHeight({ ...args, text: `x ${PARA}` }));
});

test('fully bold Georgia copy refit to its box still fits when measured at weight 700', () => {
  for (const [w, h] of [[400, 200], [500, 160], [600, 120]] as const) {
    const [el] = refitText([
      { id: 'b', type: 'text', x: 0, y: 0, w, h, rotation: 0, zIndex: 0, locked: false, source: 'ai-agent',
        text: { content: `<b>${PARA}</b>`, role: 'body', fontFamily: GEORGIA, fontSize: 40, maxFontSize: 40, minFontSize: 8, fontWeight: 400, color: '#111111', align: 'left', lineHeight: 1.3, autoFit: 'shrink' } },
    ] as unknown as MagazineElement[]);
    const size = el!.text!.fontSize;
    const atBold = estimateTextHeight({ text: PARA, fontSize: size, boxWidthPx: w, lineHeight: 1.3, fontFamily: GEORGIA, fontWeight: 700 });
    assert.ok(atBold <= h, `${w}×${h}: refit to ${size}px, which needs ${atBold}px in bold`);
    // ...and the regular-weight answer it used to give would not have fitted.
    const regularSize = fitFontSize({ text: PARA, boxW: w, boxH: h, maxFontSize: 40, minFontSize: 8, lineHeight: 1.3, fontFamily: GEORGIA, fontWeight: 400 });
    assert.ok(regularSize > size, `${w}×${h}: bold must fit smaller than regular (${size} vs ${regularSize})`);
  }
});

test('plainTextForMeasure: tags gone, <br> a newline, entities one character each', () => {
  assert.equal(plainTextForMeasure('<b>A</b> &amp; B<br/>C&#8217;s &lt;x&gt;'), 'A & B\nC’s <x>');
  assert.equal(plainTextForMeasure('one<br>two'), 'one\ntwo');
  assert.equal(plainTextForMeasure('&mdash; &#x2014; &unknown;'), '— — &unknown;');
  assert.equal(plainTextForMeasure(''), '');
});

test('widestLineWidthPx measures the widest hard line, unwrapped', () => {
  const style = { fontSize: 20, fontFamily: GEORGIA, fontWeight: 400 };
  const long = 'a much longer second line';
  assert.equal(widestLineWidthPx({ ...style, text: `short<br>${long}` }), widestLineWidthPx({ ...style, text: long }));
  assert.ok(widestLineWidthPx({ ...style, text: `<b>${long}</b>` }) > widestLineWidthPx({ ...style, text: long }));
  assert.ok(widestLineWidthPx({ ...style, text: long, textTransform: 'uppercase' }) > widestLineWidthPx({ ...style, text: long }));
});

// ── measureElementText: the numbers the page check and the edit tools report ──

type TextData = NonNullable<MagazineElement['text']>;

function textEl(over: Omit<Partial<MagazineElement>, 'text'> & { text?: Partial<TextData> } = {}): MagazineElement {
  const { text, ...rest } = over;
  return {
    id: 't', type: 'text', x: 0, y: 0, w: 500, h: 160, rotation: 0, zIndex: 0, locked: false, source: 'manual',
    ...rest,
    text: { content: `${PARA} ${PARA}`, role: 'body', fontFamily: GEORGIA, fontSize: 28, maxFontSize: 28, fontWeight: 400, color: '#111111', align: 'left', lineHeight: 1.3, autoFit: 'shrink', ...text },
  } as MagazineElement;
}

test('measureElementText reports need, have, overflow and the size it fits at', () => {
  const m = measureElementText(textEl())!;
  assert.equal(m.fontSize, 28);
  assert.equal(m.havePx, 160);
  assert.equal(m.needPx, estimateTextHeight({ text: `${PARA} ${PARA}`, fontSize: 28, boxWidthPx: 500, lineHeight: 1.3, fontFamily: GEORGIA, fontWeight: 400 }));
  assert.equal(m.overflowPx, m.needPx - 160);
  assert.equal(m.fits, false);
  assert.equal(m.ceiling, 28);
  assert.equal(m.fitsAtPx, fitFontSize({ text: `${PARA} ${PARA}`, boxW: 500, boxH: 160, maxFontSize: 28, minFontSize: 6, lineHeight: 1.3, fontFamily: GEORGIA, fontWeight: 400 }));
  const at = measureElementText(textEl({ text: { fontSize: m.fitsAtPx! } }))!;
  assert.equal(at.fits, true, 'the size it says fits does fit');
  assert.equal(at.overflowPx, 0);
});

test('measureElementText answers "at size S in width W" without changing the element', () => {
  const el = textEl();
  const wide = measureElementText(el, { fontSize: 20, width: 900 })!;
  assert.equal(wide.fontSize, 20);
  assert.equal(wide.width, 900);
  assert.equal(wide.needPx, estimateTextHeight({ text: el.text!.content, fontSize: 20, boxWidthPx: 900, lineHeight: 1.3, fontFamily: GEORGIA, fontWeight: 400 }));
  assert.equal(el.text!.fontSize, 28);
  const taller = measureElementText(el, { height: 2000 })!;
  assert.equal(taller.fits, true);
  assert.equal(taller.fitsAtPx, 28);
});

test('measureElementText: copy that cannot fit even at 6px says so (null); refit text fits', () => {
  assert.equal(measureElementText(textEl({ w: 60, h: 10 }))!.fitsAtPx, null);
  const [refit] = refitText([textEl()]);
  assert.equal(measureElementText(refit!)!.fits, true);
  assert.equal(measureElementText({ ...textEl(), type: 'image', text: undefined } as MagazineElement), null);
});

test('measureElementText: text still set as its PDF set it never wraps; its lines run on', () => {
  const pdf = textEl({
    source: 'extracted',
    w: 880,
    h: 140,
    text: {
      content: [
        'The New Zealand Thoroughbred Racing Owners Federation (NZTROF) is',
        'embarking on one of the most significant owner-focused initiatives',
        'undertaken in New Zealand racing for many years, and owners are at',
        'the heart of it.',
      ].join('\n'),
      fontSize: 29,
      maxFontSize: undefined,
      lineHeight: 1.2,
      fontFamily: 'Times New Roman, serif',
    },
  });
  const m = measureElementText(pdf)!;
  assert.equal(m.noWrap, true);
  assert.equal(m.lines, 4);
  assert.ok(Math.abs(m.needPx - 4 * 29 * 1.2) < 1e-9);
  // Asked about another width, it is judged as the flowing text that edit turns it into.
  assert.equal(measureElementText(pdf, { width: 500 })!.noWrap, false);
});
