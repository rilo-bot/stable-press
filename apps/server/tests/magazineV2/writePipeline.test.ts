// ---------------------------------------------------------------------------
// normalizeElementPatch — when a write refits text, and which size it refits from.
//
// The client case (2026-11-15): "make the body text bigger". The Studio staged
// {text:{fontSize:28}} only; the old ceiling (maxFontSize 18) stayed, so the next
// one-word fix or resize re-fitted from 18 and quietly undid the change. A size
// that is asked for now becomes the ceiling, in either direction.
//
// The other half: every web writer re-sends the whole text object, fitted fontSize
// included. Read as "a size was asked for", that switched the refit off for every
// inline edit and every Fill — new copy was saved at its old size however long it
// had become. Only a size that differs from the stored one is a request.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeElementPatch, normalizeElements } from '../../src/lib/magazineV2/writePipeline.js';
import { fitFontSize, measureElementText } from '../../src/lib/magazineV2/layout.js';
import type { MagazineElement } from '../../src/lib/magazineV2/model.js';

const PAGE = { width: 1275, height: 1650 };
const INTER = 'Inter, Arial, sans-serif';
const PARA =
  'The New Owners Group is embarking on one of the most significant owner-focused initiatives undertaken in New Zealand racing for many years.';

type TextData = NonNullable<MagazineElement['text']>;

function body(over: Omit<Partial<MagazineElement>, 'text'> & { text?: Partial<TextData> } = {}): MagazineElement {
  const { text, ...rest } = over;
  return {
    id: 'b1', type: 'text', x: 100, y: 200, w: 500, h: 160, rotation: 0, zIndex: 2, locked: false, source: 'ai-agent',
    ...rest,
    text: { content: PARA, role: 'body', fontFamily: INTER, fontSize: 18, maxFontSize: 18, fontWeight: 400, color: '#111111', align: 'left', lineHeight: 1.5, autoFit: 'shrink', ...text },
  } as MagazineElement;
}

function patch(el: MagazineElement, partial: Record<string, unknown>): MagazineElement {
  const out = normalizeElementPatch(el, partial, PAGE);
  assert.ok(out, 'patch must be usable');
  return out!;
}

test('the starting element fits at its ceiling (so the cases below test the rule, not the box)', () => {
  assert.equal(measureElementText(body())!.fits, true);
});

test('an asked-for size is stored as asked (not shrunk) and becomes the ceiling', () => {
  const out = patch(body(), { text: { fontSize: 28 } });
  assert.equal(out.text!.fontSize, 28);
  assert.equal(out.text!.maxFontSize, 28);
  // Not hidden by a refit: the writer measures it and grows the box or says so.
  const m = measureElementText(out)!;
  assert.equal(m.fits, false);
  assert.ok(m.overflowPx > 0);
});

test('bigger sticks: a later one-word fix and a resize refit from the NEW ceiling', () => {
  // The Studio grows the box in the same patch when the bigger text needs it.
  const bigger = patch(body(), { text: { fontSize: 28 }, h: 400 });
  assert.equal(bigger.text!.fontSize, 28);
  assert.equal(measureElementText(bigger)!.fits, true);

  const fixed = patch(bigger, { text: { content: PARA.replace('Owners', 'Owner') } });
  assert.equal(fixed.text!.fontSize, 28, 'a one-word fix must not snap the size back to 18');

  const nudged = patch(fixed, { x: 120, y: 210, w: 500, h: 420 });
  assert.equal(nudged.text!.fontSize, 28, 'a resize must not snap the size back to 18');
});

test('where the box cannot hold the new size, a refit shrinks from the new ceiling to what fits', () => {
  const bigger = patch(body(), { text: { fontSize: 28 }, h: 400 });
  const squeezed = patch(bigger, { h: 160 });
  const expected = fitFontSize({
    text: PARA, boxW: 500, boxH: 160, maxFontSize: 28, minFontSize: Math.round(28 * 0.55),
    lineHeight: 1.5, fontFamily: INTER, fontWeight: 400,
  });
  assert.equal(squeezed.text!.fontSize, expected);
  assert.equal(measureElementText(squeezed)!.fits, true);
});

test('smaller sticks too: the next content edit does not grow it back to the old ceiling', () => {
  const big = body({ w: 900, h: 600, text: { fontSize: 24, maxFontSize: 24 } });
  const smaller = patch(big, { text: { fontSize: 16 } });
  assert.equal(smaller.text!.maxFontSize, 16);
  const edited = patch(smaller, { text: { content: `${PARA} Owners are at the heart of it.` } });
  assert.equal(edited.text!.fontSize, 16);
});

test('a floor above the new, smaller size is brought down to it', () => {
  const out = patch(body({ text: { fontSize: 24, maxFontSize: 24, minFontSize: 16 } }), { text: { fontSize: 12 } });
  assert.equal(out.text!.maxFontSize, 12);
  assert.ok(out.text!.minFontSize! <= 12, `floor ${out.text!.minFontSize} sits above the ceiling`);
});

test('a patch naming its own ceiling keeps it (the Inspector, Adjust)', () => {
  const out = patch(body(), { text: { fontSize: 20, maxFontSize: 36 } });
  assert.equal(out.text!.fontSize, 20);
  assert.equal(out.text!.maxFontSize, 36);
});

test('an echoed size is not a request: the inline editor saving longer copy refits it', () => {
  const stored = body();
  const longer = `${PARA} ${PARA} ${PARA}`;
  // EditorCanvas / Inspector / Fill all send { ...el.text, content }.
  const out = patch(stored, { text: { ...stored.text!, content: longer } });
  assert.ok(out.text!.fontSize < 18, `longer copy must shrink to fit, got ${out.text!.fontSize}`);
  assert.equal(out.text!.maxFontSize, 18, 'and the ceiling is untouched');
  assert.equal(measureElementText(out)!.fits, true);
});

test('an echoed size never lowers the ceiling, and colour alone never rewrites the size', () => {
  const shrunk = body({ text: { fontSize: 20, maxFontSize: 28 } });
  const out = patch(shrunk, { text: { ...shrunk.text!, color: '#003366' } });
  assert.equal(out.text!.maxFontSize, 28);
  assert.equal(out.text!.fontSize, 20);
  assert.equal(out.text!.color, '#003366');
});

test('a heavier weight or another face refits from the ceiling, so the copy stays in its box', () => {
  const tight = body({ h: 81 }); // three lines of Inter at 18px × 1.5
  assert.equal(measureElementText(tight)!.fits, true);
  for (const p of [{ text: { fontWeight: 900 } }, { text: { fontFamily: 'Montserrat, Arial, sans-serif' } }, { text: { letterSpacing: 3 } }]) {
    const out = patch(tight, p);
    assert.equal(measureElementText(out)!.fits, true, JSON.stringify(p));
    assert.equal(out.text!.maxFontSize, 18, JSON.stringify(p));
  }
});

test('text saved with a size above its ceiling (before this rule) heals on its next write', () => {
  // The legacy state: fontSize 26 stored over a ceiling of 18, in a box that holds 26.
  const legacy = body({ h: 400, text: { fontSize: 26, maxFontSize: 18 } });
  const out = patch(legacy, { text: { content: PARA.replace('Owners', 'Owner') } });
  assert.equal(out.text!.fontSize, 26, 'a one-word fix must not drop it to 18');
  assert.equal(out.text!.maxFontSize, 26);
});

test('PDF-copied text made bigger flows from the asked size, even over a ceiling it carried', () => {
  const pdf = body({ source: 'extracted', text: { content: 'The New Owners Group\nis embarking on', fontSize: 29, maxFontSize: 40, lineHeight: 1.2 } });
  const out = patch(pdf, { text: { fontSize: 34 } });
  assert.equal(out.source, 'manual');
  assert.equal(out.text!.fontSize, 34);
  assert.equal(out.text!.maxFontSize, 34);
});

test('full-list writes keep a generated element exactly as composed', () => {
  const [el] = normalizeElements([body()], PAGE);
  assert.equal(el!.text!.fontSize, 18);
  assert.equal(el!.text!.maxFontSize, 18);
});
