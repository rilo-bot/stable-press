// ---------------------------------------------------------------------------
// agentPure — what the Studio agent is shown of a page, and the guardrails its edit
// tools run before staging anything.
//
// The 2026-11-15 incident in tests: the model saw 60 characters of every box, so a
// one-word fix retyped paragraphs it had never read (C01/C17/C47); an asked-for font
// size was cut off by its box and undone by the next edit (C03/C50); nothing told it
// that text was clipped (C04/C48). Expected sizes come from the write path's own
// maths (measureElementText, normalizeElementPatch), never hard-coded, so a change to
// the estimator moves the tests with it.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyPatch,
  checkFlags,
  checkReplyLine,
  clampToPage,
  clipForModel,
  describeElement,
  describePage,
  ELEMENT_TEXT_MAX,
  fitReport,
  growToFit,
  growthNote,
  imageKind,
  lastUserMessage,
  modelText,
  pictureOnlyPageLines,
  previewPageOf,
  replaceOnPage,
  shortUrl,
  tidyColumnPlan,
  turnBudgetMs,
  TURN_BUDGET_MS,
  PICTURE_TURN_BUDGET_MS,
  turnCheck,
  withGrowth,
} from '../../src/lib/magazineV2/agentPure.js';
import { allPageIssues, checkPage, MAX_ISSUES } from '../../src/lib/magazineV2/pageCheck.js';
import { measureElementText } from '../../src/lib/magazineV2/layout.js';
import type { ElementTextData, MagazineElement } from '../../src/lib/magazineV2/model.js';
import { buildDropCap } from './dropCapFixture.js';

const PAGE = { width: 1240, height: 1754 };
const PAGE_BG = { ...PAGE, background: { type: 'color', value: '#ffffff' } };

type TextOver = Partial<Omit<MagazineElement, 'text'>> & { text?: Partial<ElementTextData> };

function textEl(id: string, content: string, over: TextOver = {}): MagazineElement {
  const { text, ...rest } = over;
  return {
    id,
    type: 'text',
    x: 100,
    y: 100,
    w: 500,
    h: 200,
    rotation: 0,
    zIndex: 4,
    locked: false,
    source: 'ai-agent',
    ...rest,
    text: {
      content,
      role: 'body',
      fontFamily: 'Georgia, serif',
      fontSize: 24,
      maxFontSize: 24,
      minFontSize: 14,
      fontWeight: 400,
      color: '#111111',
      align: 'left',
      lineHeight: 1.4,
      autoFit: 'shrink',
      ...text,
    },
  } as MagazineElement;
}

function imageEl(id: string, url: string, over: Partial<MagazineElement> = {}, alt = ''): MagazineElement {
  return {
    id,
    type: 'image',
    x: 100,
    y: 100,
    w: 600,
    h: 400,
    rotation: 0,
    zIndex: 1,
    locked: false,
    source: 'ai-agent',
    image: { assetId: 'a1', url, alt, fit: 'cover' },
    ...over,
  } as MagazineElement;
}

const prose = (words: number, seed = 'racing') =>
  Array.from({ length: words }, (_, i) => `${seed}${i % 7 === 0 ? ',' : ''}`).join(' ') + '.';

// ── What the model reads ─────────────────────────────────────────────────────

test('modelText: tags dropped, entities decoded, every line break shown as " / "', () => {
  assert.equal(modelText('<b>NZ</b>TROF &amp; Co<br>line two'), 'NZTROF & Co / line two');
  assert.equal(modelText('First PDF line\nsecond   PDF line\n'), 'First PDF line / second PDF line');
  assert.equal(modelText(''), '');
});

test('a 500-character paragraph reaches the model in full — not its first 60 characters (C01)', () => {
  const para = `${'The New Owners Group welcomed eleven members this season. '.repeat(8)}NZTROF closes it.`;
  assert.ok(para.length > 450);
  const { lines, truncated } = describePage([textEl('b1', para)]);
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.includes(para.trim()), 'the whole paragraph is on the line');
  assert.ok(lines[0]!.includes('NZTROF closes it.'), 'including the word past character 60');
  assert.equal(truncated.size, 0);
});

test('a box longer than the per-element cap is cut with a marker naming read_element', () => {
  const long = 'a'.repeat(ELEMENT_TEXT_MAX + 250);
  const { lines, truncated } = describePage([textEl('b1', long)]);
  assert.match(lines[0]!, /…\[\+250 more chars — call read_element for all of it\]/);
  assert.ok(truncated.has('b1'));
  assert.deepEqual(clipForModel('short', 10), { text: 'short', cut: 0 });
});

test('the page budget goes to the selected element first, then body copy; the rest get a marked preview', () => {
  const big = (n: number) => `${'word '.repeat(n)}end`; // 5n + 3 characters
  const els = [
    textEl('cap', big(250), { text: { role: 'caption' } }), // listed first, but not body
    textEl('b1', big(250)),
    textEl('sel', big(250), { text: { role: 'subhead' } }),
  ];
  const { lines, truncated } = describePage(els, { selectedId: 'sel', perElement: 1500, budget: 3000 });
  // Lines stay in page order.
  assert.deepEqual(lines.map((l) => /#(\w+)/.exec(l)![1]), ['cap', 'b1', 'sel']);
  assert.ok(lines[2]!.includes('(THIS — the selected element)'));
  assert.ok(!truncated.has('sel'), 'the selected element is shown first and in full');
  assert.ok(!truncated.has('b1'), 'then the body copy');
  assert.ok(truncated.has('cap'), 'the budget ran out for the caption');
  assert.match(lines[0]!, /call read_element/);
});

test('describeElement keeps the old one-line shape for short text, and says when type was shrunk', () => {
  const t = textEl('x1', '<b>Big</b> day', { x: 10.4, y: 20.6, w: 300, h: 80, zIndex: 2, text: { role: 'headline', fontSize: 48.3, maxFontSize: 48.3 } });
  assert.equal(describeElement(t, 'x1'), '- #x1 text headline "Big day" #111111 48px Georgia @(10,21 300x80) z2 (THIS — the selected element)');
  const shrunk = textEl('x2', 'Copy', { text: { fontSize: 18, maxFontSize: 24 } });
  assert.match(describeElement(shrunk), /18px Georgia \(shrunk to fit; max 24px\)/);
  // A box with no family of its own is set in the app's body face, and says so.
  assert.match(describeElement(textEl('x4', 'Copy', { text: { fontFamily: 'inherit' } })), /px body font @/);
  const pdf = textEl('x3', 'line one\nline two', { source: 'extracted' });
  assert.match(describeElement(pdf), /"line one \/ line two" .*\[copied PDF lines\]/);
});

test('pictures are told apart by alt, origin and file (C44)', () => {
  const chart = imageEl('i1', 'https://bucket.s3.amazonaws.com/public/magazinesV2/m1/media/7f3a-chart.png', {}, 'Bar chart — Wins by season');
  const gen = imageEl('i2', 'https://bucket.s3.amazonaws.com/public/magazinesV2/m1/media/91bc-gen-p2.png', {}, 'A bay colt at dawn');
  const stock = imageEl('i3', 'https://bucket.s3.amazonaws.com/public/magazinesV2/m1/media/aa11-stock.jpg', {}, 'Trophy "presentation"');
  const pdf = imageEl('i4', 'https://cdn.example.com/page3-img2.jpg', { source: 'extracted' });
  const empty = imageEl('i5', '');
  assert.equal(imageKind(chart), 'chart');
  assert.equal(imageKind(gen), 'AI image');
  assert.equal(imageKind(stock), 'stock photo');
  assert.equal(imageKind(pdf), 'from the PDF');
  assert.match(describeElement(chart), /img "Bar chart — Wins by season" \(chart\) …\/7f3a-chart\.png fit:cover/);
  assert.match(describeElement(stock), /img "Trophy “presentation“" \(stock photo\)/, 'quotes in alt text cannot break out of the line');
  assert.match(describeElement(pdf), /img "untitled" \(from the PDF\)/);
  assert.match(describeElement(empty), /EMPTY picture box/);
  assert.equal(shortUrl('https://x.test/a/b/photo.jpg?sig=1'), '…/photo.jpg');
  assert.ok(shortUrl(`https://x.test/${'z'.repeat(80)}.png`).length < 50);
});

test('a drop-cap paragraph is listed as ONE line under its key, its pieces never on their own (C13)', () => {
  const dc = buildDropCap(prose(120, 'Morning'));
  const els = [textEl('h1', 'Before the Sun', { y: 40, h: 120, text: { role: 'headline' } }), ...dc.elements];
  const { lines } = describePage(els, { selectedId: dc.lead.id });
  assert.equal(lines.length, 2);
  const line = lines[1]!;
  assert.ok(line.startsWith(`- #${dc.key} paragraph-with-drop-cap`));
  assert.ok(line.includes(`"${modelText(dc.text)}"`.slice(0, 40)), 'the paragraph reads whole, cap letter included');
  assert.ok(line.includes('(THIS — the selected element)'), 'selecting a piece selects the paragraph');
  assert.ok(!lines.some((l) => l.startsWith(`- #${dc.lead.id} `)));
});

test('page-check problems are flagged on the element they belong to', () => {
  const clipped = textEl('b1', prose(400), { h: 120 });
  const flags = checkFlags(checkPage([clipped], PAGE_BG));
  assert.match(flags.get('b1') ?? '', /^⚠ CUT OFF: needs \d+px/);
  const { lines } = describePage([clipped], { flags });
  assert.match(lines[0]!, /⚠ CUT OFF/);
});

// ── Fit, and growing a box into free space ───────────────────────────────────

test('fitReport: a box that fits says so; a clipped one gives the size it fits at and the room below', () => {
  const ok = textEl('b1', 'Short copy.');
  assert.deepEqual(fitReport(ok, PAGE, [ok]).fits, true);
  const tight = textEl('b2', prose(160), { h: 120 });
  const below = textEl('b3', 'Next paragraph.', { y: 400 });
  const fit = fitReport(tight, PAGE, [tight, below]);
  assert.equal(fit.fits, false);
  assert.equal(fit.havePx, 120);
  assert.ok(fit.needPx! > 120);
  assert.equal(fit.freeBelowPx, 400 - (100 + 120));
  assert.ok(fit.problems?.[0]?.startsWith('CUT OFF'));
});

test('C03/C50: a bigger asked-for size becomes the ceiling, grows the box into free space, and survives the next edit', () => {
  const body = textEl('b1', prose(60), { h: 160, text: { fontSize: 18, maxFontSize: 18 } });
  const page = [body];
  const { patch, next, growth } = withGrowth(body, { text: { fontSize: 28, maxFontSize: 28 } }, page, PAGE);
  assert.equal(next.text!.fontSize, 28, 'the size asked for is stored as asked');
  assert.equal(next.text!.maxFontSize, 28, 'and is the new ceiling');
  assert.equal(growth?.kind, 'grow');
  const need = Math.ceil(measureElementText({ ...body, text: { ...body.text!, fontSize: 28, maxFontSize: 28 } })!.needPx);
  assert.equal(patch.h, need + 2, 'the box grows to what the copy needs at that size');
  assert.equal(next.h, need + 2);
  assert.ok(measureElementText(next)!.fits);
  // The next edit — a one-word fix — refits from the NEW ceiling, so it stays 28.
  const after = applyPatch(next, { text: { content: next.text!.content.replace('racing', 'Racing') } }, PAGE);
  assert.equal(after.text!.fontSize, 28, 'a later edit does not undo "bigger"');
  assert.match(growthNote(growth) ?? '', /grew from 160px to \d+px/);
});

test('growing stops at the next element below: the result says it does not fit, with the numbers', () => {
  const body = textEl('b1', prose(60), { h: 160, text: { fontSize: 18, maxFontSize: 18 } });
  const photo = imageEl('p1', 'https://cdn.example.com/a.jpg', { y: 280, x: 100, w: 500, h: 300 });
  const { patch, next, growth } = withGrowth(body, { text: { fontSize: 28, maxFontSize: 28 } }, [body, photo], PAGE);
  assert.equal(patch.h, undefined, 'no room: the box is not grown over the photo');
  assert.equal(next.h, 160);
  assert.equal(growth?.kind, 'blocked');
  if (growth?.kind === 'blocked') assert.equal(growth.freeBelowPx, 280 - 260);
  assert.match(growthNote(growth) ?? '', /only 20px is free below/);
  assert.equal(fitReport(next, PAGE, [next, photo]).fits, false);
});

test('a content edit that no longer fits even at the floor grows the box; copied PDF lines and a set height are left alone', () => {
  const body = textEl('b1', 'Short.', { h: 120 });
  const { next, growth } = withGrowth(body, { text: { content: prose(220) } }, [body], PAGE);
  assert.equal(growth?.kind, 'grow');
  assert.equal(next.text!.fontSize, measureElementText(next)!.fontSize);
  assert.ok(measureElementText(next)!.fits);
  // An explicit height is the model's choice.
  const sized = withGrowth(body, { text: { content: prose(220) }, h: 130 }, [body], PAGE);
  assert.equal(sized.growth, null);
  // PDF lines spill rather than clip, and only a width change re-wraps them.
  const pdf = textEl('p', 'one line\nanother line\nthird', { source: 'extracted', h: 60, text: { fontSize: 14, lineHeight: 1.4, maxFontSize: undefined } });
  assert.equal(growToFit(pdf, [pdf], PAGE), null);
});

test('the working copy is what the write path stores: a longer rewrite is refit from its ceiling', () => {
  const body = textEl('b1', 'Short.', { h: 200 });
  const next = applyPatch(body, { text: { content: prose(150) } }, PAGE);
  assert.ok(next.text!.fontSize < 24, `refit shrank the type (${next.text!.fontSize})`);
  assert.equal(next.id, 'b1');
});

test('clampToPage keeps moves and resizes on the page and says what moved', () => {
  const el = { x: 100, y: 100, w: 400, h: 200 };
  const r = clampToPage(el, { x: 1100 }, PAGE);
  assert.deepEqual(r.patch, { x: PAGE.width - 400 });
  assert.deepEqual(r.notes, [`x 1100 → ${PAGE.width - 400}`]);
  const big = clampToPage(el, { w: 5000, y: -40 }, PAGE);
  assert.deepEqual(big.patch, { w: PAGE.width, x: 0, y: 0 });
  assert.ok(big.notes.includes(`w 5000 → ${PAGE.width}`));
  assert.ok(big.notes.includes('y -40 → 0'));
  assert.deepEqual(clampToPage(el, { y: 300 }, PAGE), { patch: { y: 300 }, notes: [] });
});

test('clampToPage: a picture or panel may keep a bleed, words may not', () => {
  // A full-bleed photo 12px past every edge, nudged down 10px: still covering the page.
  const bleed = { x: -12, y: -12, w: PAGE.width + 24, h: PAGE.height + 24 };
  assert.deepEqual(clampToPage(bleed, { y: -2 }, PAGE, { bleed: true }), { patch: { y: -2 }, notes: [] });
  // Resized wider than the page: not cut down to the page's width.
  assert.deepEqual(clampToPage(bleed, { w: PAGE.width + 24 }, PAGE, { bleed: true }).patch, { w: PAGE.width + 24 });
  // A deliberately cropped picture (a third off the left edge) keeps its place.
  const cropped = { x: -200, y: 100, w: 600, h: 400 };
  assert.deepEqual(clampToPage(cropped, { y: 300 }, PAGE, { bleed: true }).patch, { y: 300 });
  // Mostly off the page is still pulled back in.
  assert.deepEqual(clampToPage(cropped, { x: -500 }, PAGE, { bleed: true }).patch, { x: 0 });
  // Text never bleeds: the same move is pulled inside.
  assert.deepEqual(clampToPage(cropped, { y: 300 }, PAGE).patch, { x: 0, y: 300 });
});

// ── Find and replace ─────────────────────────────────────────────────────────

test('replaceOnPage: a word past character 60 is replaced and every other byte kept (C01/C17/C47)', () => {
  const html = `<b>The New Owners Group</b> met on Tuesday at the club rooms; the chair of NZTROF opened.<br>Then NZTROF voted.`;
  const els = [textEl('b1', html), textEl('b2', 'No match here.'), textEl('b3', 'NZ<i>TROF</i> again', { locked: true })];
  const r = replaceOnPage(els, 'NZTROF', 'NOG');
  assert.equal(r.total, 2);
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0]!.html, html.split('NZTROF').join('NOG'));
  assert.deepEqual(r.locked, [{ id: 'b3', count: 1 }], 'a locked box is counted, never changed');
  assert.equal(r.searched, 3);
});

test('replaceOnPage: not found reports how many matches a case-insensitive search would find', () => {
  const r = replaceOnPage([textEl('b1', 'the nztrof meeting')], 'NZTROF', 'NOG');
  assert.equal(r.total, 0);
  assert.equal(r.otherCase, 1);
  const ci = replaceOnPage([textEl('b1', 'the nztrof meeting')], 'NZTROF', 'NOG', { matchCase: false });
  assert.equal(ci.total, 1);
  const only = replaceOnPage([textEl('b1', 'NZTROF'), textEl('b2', 'NZTROF')], 'NZTROF', 'NOG', { ids: ['b2'] });
  assert.deepEqual(only.hits.map((h) => h.id), ['b2']);
});

test('replaceOnPage: a box the longer text would push past the stored limit is refused, not cut', () => {
  // Validation cuts stored HTML at MAX_TEXT_HTML (8000): writing this hit would delete
  // the end of the paragraph while the count reported a clean replace.
  const long = textEl('long', `NZTROF ${'y'.repeat(7980)}`);
  const r = replaceOnPage([long, textEl('short', 'NZTROF')], 'NZTROF', 'New Zealand Thoroughbred Racing');
  assert.deepEqual(r.hits.map((h) => h.id), ['short']);
  assert.deepEqual(r.tooLong, [{ id: 'long', count: 1 }]);
  assert.equal(r.total, 1);
  const none = replaceOnPage([long], 'NZTROF', 'New Zealand Thoroughbred Racing');
  assert.equal(none.total, 0);
  assert.equal(none.otherCase, 0, 'a refusal is not reported as "not found"');
});

test('replaceOnPage: a word running from the drop cap into the opening lines still matches, as one paragraph', () => {
  const dc = buildDropCap(`Morning ${prose(120)}`);
  const r = replaceOnPage(dc.elements, 'Morning', 'Evening');
  assert.equal(r.total, 1);
  assert.equal(r.hits[0]!.id, dc.key);
  assert.ok(r.hits[0]!.para);
  assert.ok(r.hits[0]!.html.startsWith('Evening'));
  // Targeting a piece targets its paragraph.
  assert.equal(replaceOnPage(dc.elements, 'Morning', 'Evening', { ids: [dc.cap.id] }).total, 1);
});

// ── Tidying a column ─────────────────────────────────────────────────────────

test('tidy_column closes a loose gap with the column’s own spacing and fits each box to its copy', () => {
  const a = textEl('a', prose(30), { y: 100, h: 200 });
  const needA = Math.ceil(measureElementText(a)!.needPx) + 2;
  const b = textEl('b', prose(30), { y: 100 + needA + 20, h: needA });
  const c = textEl('c', prose(30), { y: b.y + needA + 20, h: needA });
  const d = textEl('d', prose(30), { y: c.y + needA + 300, h: needA }); // the hole
  const plan = tidyColumnPlan([d, b, a, c], ['d', 'c', 'b', 'a'], PAGE);
  assert.ok(plan.ok, !plan.ok ? plan.error : '');
  if (!plan.ok) return;
  assert.equal(plan.gap, 20, 'the median of the column’s ordinary gaps');
  const moveD = plan.moves.find((m) => m.id === 'd')!;
  assert.equal(moveD.y, c.y + needA + 20);
  assert.equal(moveD.fromY, d.y);
  assert.ok(!plan.moves.some((m) => m.id === 'a' && m.y !== a.y), 'the first box keeps its place');
  assert.equal(plan.moves.find((m) => m.id === 'a')?.h, needA, 'and hugs its copy');
});

test('tidy_column refuses boxes that are not one column, locked boxes, drop-cap pieces and a column that cannot fit', () => {
  const a = textEl('a', 'One.', { x: 100, w: 400 });
  const b = textEl('b', 'Two.', { x: 700, w: 400, y: 400 });
  assert.match((tidyColumnPlan([a, b], ['a', 'b'], PAGE) as { error: string }).error, /not in one column/);
  const l = textEl('l', 'Locked.', { y: 400, locked: true });
  assert.match((tidyColumnPlan([a, l], ['a', 'l'], PAGE) as { error: string }).error, /locked/);
  assert.match((tidyColumnPlan([a], ['a', 'zz'], PAGE) as { error: string }).error, /No element #zz/);
  const dc = buildDropCap(prose(120));
  assert.match((tidyColumnPlan([a, ...dc.elements], ['a', dc.lead.id], PAGE) as { error: string }).error, /drop-cap/);
  const tall = textEl('t', prose(900), { y: 1500, h: 200 });
  const top = textEl('u', 'Above.', { y: 1400, h: 60 });
  assert.match((tidyColumnPlan([top, tall], ['u', 't'], PAGE) as { error: string }).error, /only \d+px is left below y=1400/);
});

// ── The end of a turn ────────────────────────────────────────────────────────

test('turnCheck reports only what the turn broke, and the reply gets one plain line about it', () => {
  const before = checkPage([textEl('b1', 'Fits.'), textEl('b2', prose(400), { y: 600, h: 100 })], PAGE_BG);
  assert.ok(before.issues.some((i) => i.kind === 'text-clipped' && i.elementId === 'b2'), 'the premise: b2 was already cut off');
  const after = checkPage([textEl('b1', prose(400), { h: 100 }), textEl('b2', prose(400), { y: 600, h: 100 })], PAGE_BG);
  const check = turnCheck(before, after)!;
  assert.ok(check);
  assert.equal(check.ok, false);
  assert.deepEqual(check.issues.map((i) => [i.kind, i.elementId]), [['text-clipped', 'b1']]);
  assert.match(checkReplyLine(check), /^Heads-up: after these changes body “racing, racing.*” would be cut off — say “fix it” and I’ll sort it out\.$/);
  assert.equal(turnCheck(before, before), undefined);
  assert.equal(checkReplyLine(undefined), '');
});

test('turnCheck over uncapped lists: an error cut from a capped "before" is not reported as new', () => {
  // Fifteen boxes cut off: more errors than a PageCheck shows (MAX_ISSUES).
  const els = Array.from({ length: 15 }, (_, i) => textEl(`b${String(i).padStart(2, '0')}`, prose(200), { y: 20 + i * 110, h: 60 }));
  const beforeAll = allPageIssues(els, PAGE_BG);
  const before = checkPage(els, PAGE_BG);
  assert.ok(beforeAll.filter((i) => i.severity === 'error').length > MAX_ISSUES, 'the premise: more errors than a check shows');
  assert.equal(before.issues.length, MAX_ISSUES);
  // The turn fixes the first box (short copy): the 13th error now fits in the capped list.
  const fixed = els.map((e, i) => (i === 0 ? textEl(e.id, 'Short.', { y: e.y, h: 60 }) : e));
  const after = checkPage(fixed, PAGE_BG);
  const capped = turnCheck(before, after);
  assert.ok(capped && capped.issues.length > 0, 'the premise: the capped diff reports an old error as new');
  assert.equal(turnCheck(before, after, { before: beforeAll, after: allPageIssues(fixed, PAGE_BG) }), undefined);
});

test('previewPageOf and lastUserMessage', () => {
  assert.deepEqual(previewPageOf(PAGE, []).background, { type: 'color', value: '#ffffff' });
  assert.deepEqual(previewPageOf({ ...PAGE, background: { type: 'image', value: 'https://x/y.jpg' } }, []).background, { type: 'image', value: 'https://x/y.jpg' });
  assert.equal(lastUserMessage([{ role: 'user', content: 'one' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: ' make it bigger ' }]), 'make it bigger');
  assert.equal(lastUserMessage([]), '');
});

test('tidy_column treats a lone piece left by a folded drop cap as ordinary text', () => {
  const dc = buildDropCap(prose(120));
  const folded = { ...dc.lead, x: 100, w: 900, y: 300, h: 400 };
  const above = textEl('a', 'Above.', { x: 100, w: 900, y: 100, h: 60 });
  const plan = tidyColumnPlan([above, folded], ['a', folded.id], PAGE);
  assert.ok(plan.ok, !plan.ok ? plan.error : '');
});

test('text on a panel grows only to the panel’s bottom edge, never off it onto the page', () => {
  const body = textEl('b1', prose(60), { x: 120, y: 120, w: 460, h: 160, zIndex: 5, text: { fontSize: 18, maxFontSize: 18 } });
  const panel = { id: 'panel', type: 'shape', x: 100, y: 100, w: 500, h: 220, rotation: 0, zIndex: 1, locked: false, source: 'ai-agent', shape: { fill: '#0b1f3a' } } as MagazineElement;
  const g = growToFit(applyPatch(body, { text: { fontSize: 28 } }, PAGE), [body, panel], PAGE);
  assert.equal(g?.kind, 'blocked');
  if (g?.kind === 'blocked') assert.equal(g.freeBelowPx, 320 - 280, 'the room left inside the panel');
});

// ── pictureOnlyPageLines (C33) ──────────────────────────────────────────────

test('a copied scan is described as one picture whose words cannot be edited', () => {
  const scan = pictureOnlyPageLines({ background: { type: 'image', value: 'https://x/bg.jpg' }, notice: 'scanned' }, []);
  assert.ok(scan.length > 0);
  assert.match(scan.join(' '), /SCANNED PDF page/);
  assert.match(scan.join(' '), /NOT editable elements/);
  assert.match(scan.join(' '), /add_element/);
  // Type drawn as shapes says so, even after text was added over the picture.
  const outlined = pictureOnlyPageLines({ background: { type: 'image', value: 'https://x/bg.jpg' }, notice: 'no-text' }, [textEl('t1', 'A new caption')]);
  assert.match(outlined.join(' '), /drawn as shapes/);
});

test('an image-only page with no words of its own gets the general note; a page with text gets none', () => {
  const bare = pictureOnlyPageLines({ background: { type: 'image', value: 'https://x/bg.jpg' } }, []);
  assert.match(bare.join(' '), /background is a picture/);
  // An empty text box is not words.
  assert.ok(pictureOnlyPageLines({ background: { type: 'image', value: 'https://x/bg.jpg' } }, [textEl('t1', '<p> </p>')]).length > 0);
  assert.deepEqual(pictureOnlyPageLines({ background: { type: 'image', value: 'https://x/bg.jpg' } }, [textEl('t1', 'Headline')]), []);
  assert.deepEqual(pictureOnlyPageLines({ background: { type: 'color', value: '#ffffff' } }, []), []);
  assert.deepEqual(pictureOnlyPageLines({}, []), []);
});

test('a turn that makes or places a picture gets the longer budget (B6)', () => {
  assert.equal(turnBudgetMs('Make the headline red'), TURN_BUDGET_MS);
  assert.equal(turnBudgetMs('Generate a poster for the Derby'), PICTURE_TURN_BUDGET_MS);
  assert.equal(turnBudgetMs('add a bar chart of these numbers'), PICTURE_TURN_BUDGET_MS);
  assert.equal(turnBudgetMs('put a photo of a bay colt here'), PICTURE_TURN_BUDGET_MS);
  assert.equal(turnBudgetMs('use this', 1), PICTURE_TURN_BUDGET_MS);
  assert.equal(turnBudgetMs(''), TURN_BUDGET_MS);
  assert.ok(PICTURE_TURN_BUDGET_MS > TURN_BUDGET_MS);
});
