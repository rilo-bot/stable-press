// ---------------------------------------------------------------------------
// replaceAcross.ts — "change NZTROF to NOG everywhere", one page at a time.
//
// The incident this replaces: the Studio retyped whole boxes to swap a name and the
// client's own copy came back rewritten. Here only the matched words change, every
// other byte of the HTML stays, locked boxes are counted but never edited, and each
// changed box goes through the same write pipeline as a typed edit.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planPageReplace, replaceReport } from '../../src/lib/magazineV2/replaceAcross.js';
import { keepsPdfLines } from '../../src/lib/magazineV2/extractedText.js';
import { MAX_TEXT_HTML, type MagazineElement } from '../../src/lib/magazineV2/model.js';
import { readDropCapParagraphs } from '../../src/lib/magazineV2/dropCapPara.js';
import { visibleText } from '../../src/lib/magazineV2/textReplace.js';
import { buildDropCap } from './dropCapFixture.js';

const PAGE = { width: 1275, height: 1650 };
type TextData = NonNullable<MagazineElement['text']>;

function text(id: string, content: string, over: Omit<Partial<MagazineElement>, 'text'> & { text?: Partial<TextData> } = {}): MagazineElement {
  const { text: t, ...rest } = over;
  return {
    id, type: 'text', x: 100, y: 200, w: 500, h: 200, rotation: 0, zIndex: 2, locked: false, source: 'ai-agent',
    ...rest,
    text: { content, role: 'body', fontFamily: 'Inter, Arial, sans-serif', fontSize: 18, maxFontSize: 18, fontWeight: 400, color: '#111111', align: 'left', lineHeight: 1.4, autoFit: 'shrink', ...t },
  } as MagazineElement;
}

const photo: MagazineElement = {
  id: 'p1', type: 'image', x: 0, y: 0, w: 600, h: 400, rotation: 0, zIndex: 1, locked: false, source: 'ai-agent',
  image: { url: 'https://x/nztrof.jpg', alt: 'NZTROF members', fit: 'cover' },
} as MagazineElement;

test('only the matched words change; markup and every other box are left byte for byte', () => {
  const els = [
    text('h', '<b>NZTROF</b> Awards'),
    text('b', 'Members of the NZTROF met in <i>Wellington</i>.<br>The NZTROF board thanked them.'),
    text('c', 'Nothing to see here.'),
    photo,
  ];
  const plan = planPageReplace(els, PAGE, 'NZTROF', 'NOG');
  assert.equal(plan.count, 3);
  assert.equal(plan.skippedLocked, 0);
  assert.deepEqual(plan.changedIds, ['h', 'b']);
  const byId = new Map(plan.elements!.map((e) => [e.id, e]));
  assert.equal(byId.get('h')!.text!.content, '<b>NOG</b> Awards');
  assert.equal(byId.get('b')!.text!.content, 'Members of the NOG met in <i>Wellington</i>.<br>The NOG board thanked them.');
  assert.equal(byId.get('c'), els[2], 'an unchanged box is the same object');
  assert.equal(byId.get('p1'), photo, 'pictures (and their alt text) are not touched');
  assert.equal(plan.elements!.length, els.length);
});

test('nothing to change gives no element list, so nothing is written', () => {
  const plan = planPageReplace([text('a', 'Hello')], PAGE, 'NZTROF', 'NOG');
  assert.deepEqual(plan, { elements: null, count: 0, skippedLocked: 0, skippedTooLong: 0, changedIds: [] });
  const already = planPageReplace([text('a', 'NOG')], PAGE, 'NOG', 'NOG ');
  assert.equal(already.count, 1, 'a real change is counted');
});

test('a locked box is never edited, and its matches are counted', () => {
  const els = [text('a', 'NZTROF and NZTROF', { locked: true }), text('b', 'NZTROF')];
  const plan = planPageReplace(els, PAGE, 'NZTROF', 'NOG');
  assert.equal(plan.count, 1);
  assert.equal(plan.skippedLocked, 2);
  assert.equal(plan.elements![0], els[0]);
  assert.equal(plan.elements![1]!.text!.content, 'NOG');
});

test('case and whole-word options reach the matcher (case-sensitive by default)', () => {
  const els = [text('a', 'Cup cupboard CUP')];
  assert.equal(planPageReplace(els, PAGE, 'Cup', 'Trophy').count, 1);
  assert.equal(planPageReplace(els, PAGE, 'Cup', 'Trophy', { matchCase: false }).count, 3);
  const whole = planPageReplace(els, PAGE, 'cup', 'Trophy', { matchCase: false, wholeWord: true });
  assert.equal(whole.count, 2);
  assert.equal(whole.elements![0]!.text!.content, 'Trophy cupboard Trophy');
});

test('a longer name refits the box from its ceiling, through the normal write pipeline', () => {
  // A tight headline box: the longer name no longer fits at 48px.
  const head = text('h', 'NOG Awards', { w: 300, h: 70, text: { role: 'headline', fontSize: 48, maxFontSize: 48, lineHeight: 1.1 } });
  const plan = planPageReplace([head], PAGE, 'NOG', 'New Zealand Thoroughbred Racing Owners');
  const out = plan.elements![0]!;
  assert.ok(out.text!.fontSize < 48, `shrunk to fit (got ${out.text!.fontSize})`);
  assert.equal(out.text!.maxFontSize, 48, 'the ceiling is kept, so a shorter name later grows back');
});

test('PDF-copied text becomes ordinary flowing text once its words change', () => {
  const copied = text('x', 'NZTROF Annual Report', { source: 'extracted', w: 400, h: 24, text: { fontSize: 20, maxFontSize: undefined, lineHeight: 1.2, autoFit: 'clip' } });
  assert.equal(keepsPdfLines(copied), true, 'the fixture really is drawn as the PDF set it');
  const out = planPageReplace([copied], PAGE, 'NZTROF', 'NOG').elements![0]!;
  assert.equal(out.text!.content, 'NOG Annual Report');
  assert.equal(out.source, 'manual');
  assert.equal(out.text!.autoFit, 'shrink');
  assert.equal(keepsPdfLines(out), false);
});

test('replaceReport: only pages with something to say, in page order, with the total', () => {
  const out = replaceReport([
    { pageId: 'c', pageNumber: 3, count: 2 },
    { pageId: 'a', pageNumber: 1, count: 0 },
    { pageId: 'b', pageNumber: 2, count: 0, skippedLocked: 1 },
    { pageId: 'd', pageNumber: 4, count: 5, skippedLocked: 0 },
  ]);
  assert.deepEqual(out, {
    pages: [
      { pageId: 'b', pageNumber: 2, count: 0, skippedLocked: 1 },
      { pageId: 'c', pageNumber: 3, count: 2 },
      { pageId: 'd', pageNumber: 4, count: 5 },
    ],
    total: 7,
  });
});

// ── Drop-cap paragraphs (searched as one paragraph, re-set as one) ───────────

const OPENING =
  'NZTROF has announced its new season of owner days, with stable visits, track mornings and a members dinner at the course. ' +
  'Every member is welcome to bring a guest, and the committee will share the full calendar in the next issue of the magazine.';

test('a name split between the drop cap and its opening lines is found and the paragraph re-set', () => {
  const dc = buildDropCap(OPENING);
  const els = [...dc.elements, text('other', 'NZTROF news', { y: 1200, h: 60 })];
  const plan = planPageReplace(els, PAGE, 'NZTROF', 'New Owners Group');
  // The paragraph's match (cap "N" + lead "ZTROF…"), plus the plain box.
  assert.equal(plan.count, 2);
  const out = plan.elements!;
  const para = readDropCapParagraphs(out).paras[0];
  const copy = para ? visibleText(para.raw) : visibleText(out.filter((e) => e.id.startsWith(dc.key)).map((e) => e.text!.content).join(''));
  assert.match(copy.replace(/\s+/g, ' '), /^New Owners Group has announced/);
  assert.ok(!/NZTROF|ZTROF/.test(copy), 'no half of the old name is left behind');
  assert.equal(out.find((e) => e.id === 'other')!.text!.content, 'New Owners Group news');
  assert.ok(plan.changedIds.includes('other'));
  assert.ok(plan.changedIds.some((id) => id.startsWith(dc.key)), 'the paragraph pieces are reported as changed');
});

test('a locked drop-cap piece keeps the whole paragraph as it is, and its match is counted', () => {
  const dc = buildDropCap(OPENING);
  const els = dc.elements.map((e) => (e.id === dc.lead.id ? { ...e, locked: true } : e));
  const plan = planPageReplace(els, PAGE, 'NZTROF', 'NOG');
  assert.equal(plan.count, 0);
  assert.equal(plan.skippedLocked, 1);
  assert.equal(plan.elements, null);
});

// ── The stored-text limit ────────────────────────────────────────────────────

test('a box the longer name would push past the stored-text limit is left whole and counted', () => {
  const filler = 'x'.repeat(MAX_TEXT_HTML - 40);
  const full = text('full', `NZTROF ${filler} NZTROF`);
  const fine = text('fine', 'NZTROF', { y: 600 });
  const plan = planPageReplace([full, fine], PAGE, 'NZTROF', 'New Zealand Thoroughbred Racing');
  assert.equal(plan.count, 1);
  assert.equal(plan.skippedTooLong, 2);
  assert.equal(plan.elements![0], full, 'never written shortened');
  assert.equal(plan.elements![1]!.text!.content, 'New Zealand Thoroughbred Racing');
  const report = replaceReport([{ pageId: 'a', pageNumber: 1, count: 0, skippedTooLong: 2 }]);
  assert.deepEqual(report.pages, [{ pageId: 'a', pageNumber: 1, count: 0, skippedTooLong: 2 }]);
});
