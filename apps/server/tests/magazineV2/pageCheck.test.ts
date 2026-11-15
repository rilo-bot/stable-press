// ---------------------------------------------------------------------------
// pageCheck — the deterministic page check both AIs read instead of being blind.
//
// Every kind of problem is pinned with the numbers that prove it, and the expected
// fit numbers are computed with the write path's own maths (fitFontSize,
// estimateTextHeight) rather than hard-coded, so a change to the estimator moves the
// test with it. The first case is the 2026-11-15 incident itself: a copied PDF line
// rewritten as one long sentence, drawn as the PDF set it, running off the page.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkPage,
  checkElement,
  checkPageFromMeasurements,
  checkSummary,
  issuesFromMeasurements,
  newErrors,
  freeSpaceBelow,
  MAX_ISSUES,
  TINY_TEXT_PX,
  type CheckKind,
  type ElementMeasurement,
  type PageCheck,
} from '../../src/lib/magazineV2/pageCheck.js';
import { estimateTextHeight, fitFontSize, readableColor } from '../../src/lib/magazineV2/layout.js';
import { keepsPdfLines } from '../../src/lib/magazineV2/extractedText.js';
import { measureRunWidthPx } from '../../src/lib/magazineV2/fontMetrics.js';
import { relayoutPage } from '../../src/lib/magazineV2/relayoutPage.js';
import { pageCopyEdits } from '../../src/lib/magazineV2/copyHygiene.js';
import { ROLE_SCALE } from '../../src/lib/magazineV2/roleScale.js';
import { PAGE_TYPES } from '../../src/lib/magazineV2/pageTypes.js';
import { seedSpecForPage } from '../../src/lib/magazineV2/seedSpecs.js';
import type { ElementTextData, MagazineElement } from '../../src/lib/magazineV2/model.js';
import { runSpec, PAGE as SEED_PAGE } from './seedHarness.js';

const PAGE = { width: 1240, height: 1754, background: { type: 'color', value: '#ffffff' } };

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

function imageEl(id: string, over: Partial<MagazineElement> & { url?: string } = {}): MagazineElement {
  const { url, ...rest } = over;
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
    image: { assetId: '', url: url ?? 'https://cdn.example.com/horse.jpg', alt: 'horse', fit: 'cover' },
    ...rest,
  } as MagazineElement;
}

function shapeEl(id: string, over: Partial<MagazineElement> & { fill?: string; opacity?: number } = {}): MagazineElement {
  const { fill, opacity, ...rest } = over;
  return {
    id,
    type: 'shape',
    x: 100,
    y: 100,
    w: 600,
    h: 400,
    rotation: 0,
    zIndex: 2,
    locked: false,
    source: 'ai-agent',
    shape: { fill: fill ?? '#0b1f3a', ...(opacity !== undefined ? { opacity } : {}) },
    ...rest,
  } as MagazineElement;
}

/** Height the copy needs at its own size in its own width — the estimate the check uses. */
function need(el: MagazineElement, fontSize = el.text!.fontSize): number {
  const t = el.text!;
  return estimateTextHeight({
    text: t.content,
    fontSize,
    boxWidthPx: el.w,
    lineHeight: t.lineHeight,
    fontFamily: t.fontFamily,
    fontWeight: t.fontWeight,
    letterSpacing: t.letterSpacing,
    textTransform: t.textTransform,
  });
}

/** A box sized exactly to its copy, so its ink IS its box. */
function snug(id: string, content: string, over: TextOver = {}): MagazineElement {
  const el = textEl(id, content, over);
  return { ...el, h: Math.ceil(need(el)) };
}

const PARA =
  'The New Owners Group is embarking on one of the most significant owner-focused initiatives undertaken in New Zealand racing for many years, and owners are at the heart of it. ';
const para = (n: number) => PARA.repeat(n).trim();
const kinds = (c: PageCheck) => c.issues.map((i) => i.kind);
/** A test page holds a few boxes on an otherwise blank sheet, so the page-level dead-band
 *  advisory is always there; most cases look past it. */
const noBands = <T extends { kind: CheckKind }>(list: T[]) => list.filter((i) => i.kind !== 'dead-band');
const find = (c: PageCheck, kind: CheckKind, id?: string) => c.issues.find((i) => i.kind === kind && (id === undefined || i.elementId === id));

// ── The 2026-11-15 incident ──────────────────────────────────────────────────

const INCIDENT_PAGE = { width: 1588, height: 2246, background: { type: 'color', value: '#ffffff' } };
const REWRITE = 'The New Owners Group (NOG) is embarking on a significant owner-focused initiative here.';

function incidentLine(): MagazineElement {
  // A copied PDF line (one line, a box measured tight to it), its words rewritten and
  // saved before edits turned copied text into flowing text: still drawn as the PDF
  // set it, and now far longer than the room left on the page.
  return textEl('pdf-line', REWRITE, {
    source: 'extracted',
    x: 700,
    y: 400,
    w: 880,
    h: 35,
    text: { fontFamily: 'Times New Roman, serif', fontSize: 29, lineHeight: 1.2, maxFontSize: undefined, minFontSize: undefined },
  });
}

test('INCIDENT: a rewritten PDF line drawn as set and wider than the page is text-past-edge', () => {
  const el = incidentLine();
  assert.equal(keepsPdfLines(el), true, 'precondition: the renderer still draws it as the PDF set it');
  const widest = measureRunWidthPx(REWRITE, 'Times New Roman, serif', 400, 29);
  assert.ok(widest > INCIDENT_PAGE.width - el.x, `precondition: ${widest}px is wider than the ${INCIDENT_PAGE.width - el.x}px left`);

  const c = checkPage([el], INCIDENT_PAGE, { pageNumber: 3 });
  assert.equal(c.ok, false);
  assert.equal(c.page, 3);
  const i = find(c, 'text-past-edge', 'pdf-line');
  assert.ok(i, JSON.stringify(c.issues));
  assert.equal(i!.severity, 'error');
  assert.equal(i!.measured?.needPx, Math.round(widest));
  assert.equal(i!.measured?.havePx, INCIDENT_PAGE.width - el.x);
  assert.match(i!.detail, new RegExp(`${Math.round(widest)}px`));
  assert.match(i!.detail, /past the right edge/);
  assert.match(i!.fix, /wrap inside its 880px box/);
  assert.equal(kinds(c).includes('text-spills'), false, 'past the edge is the error; it is not also reported as a spill');
  assert.equal(checkElement(el, INCIDENT_PAGE).fits, false);
  assert.match(c.summary, /Page 3: 1 error/);
});

test('INCIDENT, the paragraph case: a one-line rewrite in a box of four lines wraps (renderer safety net) and is not past the edge', () => {
  const el = textEl('para', 'The New Owners Group (NOG) is embarking on one of the most significant owner-focused initiatives undertaken in New Zealand racing for many years, and owners are at the heart of it.', {
    source: 'extracted',
    x: 120,
    y: 400,
    w: 880,
    h: 140,
    text: { fontFamily: 'Times New Roman, serif', fontSize: 29, lineHeight: 1.2, maxFontSize: undefined, minFontSize: undefined },
  });
  assert.equal(keepsPdfLines(el), false);
  const c = checkPage([el], INCIDENT_PAGE);
  assert.equal(find(c, 'text-past-edge'), undefined);
  assert.equal(c.ok, true);
});

// ── Text that does not fit ───────────────────────────────────────────────────

test('body text needing 2× its box is text-clipped, with need/have/fits-at from the write path’s own maths', () => {
  const base = textEl('body', para(4));
  const full = need(base);
  const el = { ...base, h: Math.round(full / 2) };
  const c = checkPage([el], PAGE);
  const i = find(c, 'text-clipped', 'body');
  assert.ok(i, JSON.stringify(c.issues));
  assert.equal(i!.severity, 'error');
  assert.equal(c.ok, false);

  const floor = Math.max(TINY_TEXT_PX, el.text!.minFontSize!);
  const fitsAt = fitFontSize({
    text: el.text!.content,
    boxW: el.w,
    boxH: el.h,
    maxFontSize: el.text!.fontSize,
    minFontSize: floor,
    lineHeight: el.text!.lineHeight,
    fontFamily: el.text!.fontFamily,
    fontWeight: el.text!.fontWeight,
  });
  assert.ok(need(el, fitsAt) <= el.h, 'precondition: the copy does fit at a legible size');
  assert.equal(i!.measured?.needPx, Math.round(full));
  assert.equal(i!.measured?.havePx, el.h);
  assert.equal(i!.measured?.overflowPx, Math.round(full - el.h));
  assert.equal(i!.measured?.fitsAtPx, fitsAt);
  assert.match(i!.detail, new RegExp(`needs ${Math.round(full)}px at 24px type, the box is ${el.h}px`));
  // Concrete next steps with numbers: the size it fits at, the height it needs and the
  // room there is to grow, and the share to cut.
  assert.match(i!.fix, new RegExp(`set fontSize ${fitsAt}px`));
  assert.match(i!.fix, new RegExp(`make the box ${Math.round(full)}px tall \\(${PAGE.height - (el.y + el.h)}px free below\\)`));
  assert.match(i!.fix, /cut about \d+% of the words/);

  const fit = checkElement(el, PAGE);
  assert.equal(fit.fits, false);
  assert.equal(fit.needPx, Math.round(full));
  assert.equal(fit.havePx, el.h);
  assert.equal(fit.fitsAtPx, fitsAt);
});

test('clipped text that fits at no legible size says so: no fits-at, the height it needs instead', () => {
  const base = textEl('body', para(10), { h: 120 });
  const c = checkPage([base], PAGE);
  const i = find(c, 'text-clipped', 'body')!;
  assert.ok(i);
  assert.equal(i.measured?.fitsAtPx, undefined);
  assert.doesNotMatch(i.fix, /set fontSize/);
  assert.match(i.fix, /make the box \d+px tall/);
  assert.equal(checkElement(base, PAGE).fitsAtPx, undefined);
});

test('the room to grow is measured to the next thing below in the column', () => {
  const base = textEl('body', para(4));
  const el = { ...base, h: Math.round(need(base) / 2) };
  const below = snug('next', 'A caption under it.', { y: el.y + el.h + 30, text: { role: 'caption', fontSize: 18 } });
  assert.equal(freeSpaceBelow(el, [el, below], PAGE), 30);
  const i = find(checkPage([el, below], PAGE), 'text-clipped', 'body')!;
  assert.match(i.fix, /only 30px is free below, so move what is underneath first/);
  // A sheet-sized photo behind everything is the ground, not an obstacle.
  const ground = imageEl('bg', { x: 0, y: 0, w: PAGE.width, h: PAGE.height, zIndex: 0 });
  assert.equal(freeSpaceBelow(el, [ground, el], PAGE), PAGE.height - (el.y + el.h));
});

test('text that fits is not flagged, and a fit result says so', () => {
  const el = snug('body', para(2));
  const c = checkPage([el], PAGE);
  assert.deepEqual(noBands(c.issues), []);
  assert.equal(c.ok, true);
  const fit = checkElement(el, PAGE);
  assert.equal(fit.fits, true);
  assert.equal(fit.needPx, Math.round(need(el)));
  assert.equal(fit.fitsAtPx, undefined);
});

test('copied PDF text spilling more than 10% past its box (but inside the page) is a text-spills warning', () => {
  const line = 'Owners are at the heart of the programme for many years.';
  const el = textEl('spill', line, {
    source: 'extracted',
    x: 100,
    w: 600,
    h: 35,
    text: { fontFamily: 'Times New Roman, serif', fontSize: 29, lineHeight: 1.2, maxFontSize: undefined, minFontSize: undefined },
  });
  assert.equal(keepsPdfLines(el), true);
  const widest = measureRunWidthPx(line, 'Times New Roman, serif', 400, 29);
  assert.ok(widest > el.w * 1.1 && el.x + widest < PAGE.width, `precondition: ${widest}px`);
  const c = checkPage([el], PAGE);
  const i = find(c, 'text-spills', 'spill');
  assert.ok(i, JSON.stringify(c.issues));
  assert.equal(i!.severity, 'warning');
  assert.equal(c.ok, true, 'a spill is a warning');
  assert.match(i!.fix, new RegExp(`make the box ${Math.round(widest)}×35px`));
});

test('an estimate from stand-in metrics (a family never measured, e.g. Calibri) needs more before it counts', () => {
  // The same drawn line, once in a measured face and once in a face the estimate can
  // only stand in for with the widest measured sans: a 17% overshoot is a spill in the
  // first, within the stand-in's error in the second.
  const line = 'Owners are at the heart of the programme for years';
  const measuredFace = 'Archivo, sans-serif';
  const standIn = 'Calibri, Candara, Segoe UI, Optima, sans-serif';
  const wM = measureRunWidthPx(line, measuredFace, 400, 29);
  const wS = measureRunWidthPx(line, standIn, 400, 29);
  const w = Math.round(wM / 1.17);
  assert.ok(wS / w < 1.25, `precondition: stand-in estimate ${wS}px within 25% of ${w}px`);
  const el = (fontFamily: string) =>
    textEl('copy', line, { source: 'extracted', w, h: 35, text: { fontFamily, fontSize: 29, lineHeight: 1.2, maxFontSize: undefined, minFontSize: undefined } });
  assert.ok(find(checkPage([el(measuredFace)], PAGE), 'text-spills'));
  assert.equal(find(checkPage([el(standIn)], PAGE), 'text-spills'), undefined);
  // A browser measurement needs no allowance: measured, the stand-in face spills too.
  const m: ElementMeasurement[] = [{ id: 'copy', box: { x: 100, y: 100, w, h: 35 }, contentW: wM, contentH: 35, ink: { x: 100, y: 100, w: wM, h: 35 } }];
  assert.deepEqual(noBands(issuesFromMeasurements(m, [el(standIn)], PAGE)).map((i) => i.kind), ['text-spills']);
});

// ── Collisions and stacking ──────────────────────────────────────────────────

test('two body boxes overlapping by 30% are a text-overlap error, naming both and where to move', () => {
  const a = snug('a', para(2));
  const b = snug('b', para(2), { y: a.y + Math.round(a.h * 0.7) });
  const c = checkPage([a, b], PAGE);
  const i = find(c, 'text-overlap');
  assert.ok(i, JSON.stringify(c.issues));
  assert.equal(i!.severity, 'error');
  assert.equal(i!.elementId, 'b', 'the lower block is the one to move');
  assert.equal(i!.otherId, 'a');
  assert.match(i!.detail, /30% of the smaller block/);
  assert.match(i!.fix, new RegExp(`move it down to y=${a.y + a.h + 12}`));
});

test('text side by side, or a hair apart, does not overlap', () => {
  const a = snug('a', para(2));
  const b = snug('b', para(2), { x: a.x + a.w + 40 });
  const c = snug('c', para(1), { y: a.y + a.h + 4 });
  assert.equal(find(checkPage([a, b, c], PAGE), 'text-overlap'), undefined);
});

test('text under an opaque shape drawn above it is element-hidden, and the fix names z+1', () => {
  const t = snug('t', para(1), { zIndex: 1 });
  const panel = shapeEl('panel', { x: 80, y: 80, w: 560, h: 400, zIndex: 5 });
  const c = checkPage([t, panel], PAGE);
  const i = find(c, 'element-hidden', 't');
  assert.ok(i, JSON.stringify(c.issues));
  assert.equal(i!.severity, 'error');
  assert.equal(i!.otherId, 'panel');
  assert.match(i!.fix, /set zIndex 6 on it/);
  // A see-through scrim does not hide; neither does a panel drawn BELOW the text.
  assert.equal(find(checkPage([t, { ...panel, shape: { fill: '#000000', opacity: 0.55 } }], PAGE), 'element-hidden'), undefined);
  assert.equal(find(checkPage([t, { ...panel, zIndex: 0 }], PAGE), 'element-hidden'), undefined);
});

test('a photo under a near-opaque wash is hidden, and the fix offers thinning the wash', () => {
  const photo = imageEl('photo', { zIndex: 0 });
  const wash = shapeEl('wash', { fill: '#0e0e0e', opacity: 0.88, zIndex: 1 });
  const i = find(checkPage([photo, wash], PAGE), 'element-hidden', 'photo')!;
  assert.ok(i);
  assert.match(i.fix, /set zIndex 2 on it/);
  assert.match(i.fix, /lower #wash's opacity to 0\.7 or less \(it is 0\.88\)/);
});

test('equal zIndex: the later element in the list is drawn on top (the renderer’s stable sort)', () => {
  const photo = imageEl('photo', { zIndex: 3 });
  const panel = shapeEl('panel', { zIndex: 3 });
  assert.ok(find(checkPage([photo, panel], PAGE), 'element-hidden', 'photo'));
  assert.equal(find(checkPage([panel, photo], PAGE), 'element-hidden'), undefined);
});

// ── Pictures and empty boxes ─────────────────────────────────────────────────

test('an image with no url is image-empty (it prints nothing, on the page or in the PDF)', () => {
  const slot = imageEl('slot', { url: '' });
  const c = checkPage([slot, snug('t', 'Headline', { y: 600 })], PAGE);
  const i = find(c, 'image-empty', 'slot');
  assert.ok(i);
  assert.equal(i!.severity, 'error');
  assert.match(i!.fix, /600×400px, aspect 1\.50:1/);
  assert.equal(checkElement(slot, PAGE).fits, false);
});

test('a text box with no words is a text-empty warning', () => {
  const c = checkPage([snug('t', para(1)), textEl('blank', '  <b></b> ', { y: 800 })], PAGE);
  const i = find(c, 'text-empty', 'blank');
  assert.ok(i);
  assert.equal(i!.severity, 'warning');
});

test('a page with nothing drawn is page-empty; a photo background is not empty', () => {
  assert.deepEqual(kinds(checkPage([], PAGE)), ['page-empty']);
  const onlyShape = checkPage([shapeEl('s')], PAGE);
  assert.ok(find(onlyShape, 'page-empty'));
  assert.equal(onlyShape.ok, false);
  assert.equal(find(checkPage([], { ...PAGE, background: { type: 'image', value: 'https://cdn.example.com/bg.jpg' } }), 'page-empty'), undefined);
});

// ── Legibility ───────────────────────────────────────────────────────────────

test('10px body text is tiny-text (under the type scale’s lowest floor)', () => {
  assert.equal(TINY_TEXT_PX, Math.min(...Object.values(ROLE_SCALE).map((r) => r.minFontSize)));
  const el = snug('small', 'Terms and conditions apply to all entries.', { text: { fontSize: 10, maxFontSize: 10, minFontSize: 6 } });
  const c = checkPage([el], PAGE);
  const i = find(c, 'tiny-text', 'small');
  assert.ok(i, JSON.stringify(c.issues));
  assert.equal(i!.severity, 'warning');
  assert.match(i!.detail, /10px type is about 4\.8pt in print/);
  assert.match(i!.fix, new RegExp(`set fontSize ${TINY_TEXT_PX}px`));
  // Furniture (the folio, the running head) is deliberately small and exempt.
  assert.equal(find(checkPage([{ ...el, id: 'furniture-folio' }], PAGE), 'tiny-text'), undefined);
});

test('#ffffff text on a white page is low-contrast, and the fix is readableColor’s choice', () => {
  const el = snug('white', 'Owners are at the heart of it', { text: { color: '#ffffff' } });
  const c = checkPage([el], PAGE);
  const i = find(c, 'low-contrast', 'white');
  assert.ok(i, JSON.stringify(c.issues));
  assert.equal(i!.severity, 'warning');
  assert.equal(i!.measured?.contrast, 1);
  assert.match(i!.fix, new RegExp(`set color ${readableColor('#ffffff', '#ffffff', '#ffffff', '#111111')}`));
});

test('contrast is judged against what is behind the text: a panel, a tint over the page, never a photo', () => {
  const el = snug('white', 'Owners are at the heart of it', { text: { color: '#ffffff' }, zIndex: 5 });
  // White on a navy panel reads fine.
  assert.equal(find(checkPage([shapeEl('panel', { zIndex: 1 }), el], PAGE), 'low-contrast'), undefined);
  // Over a photo the colours are unknown here — that is for the visual review.
  assert.equal(find(checkPage([imageEl('photo', { zIndex: 1 }), el], PAGE), 'low-contrast'), undefined);
  // A pale 30% tint over a white page is still a white page.
  assert.ok(find(checkPage([shapeEl('tint', { fill: '#000000', opacity: 0.05, zIndex: 1 }), el], PAGE), 'low-contrast'));
  // The page's own ink is preferred when it reads well.
  const navy = snug('navy', para(1), { y: 900, text: { color: '#0b1f3a' } });
  assert.match(find(checkPage([el, navy], PAGE), 'low-contrast')!.fix, /set color #0b1f3a/);
  // With no page background given, bare-page contrast is not guessed at.
  assert.equal(find(checkPage([el], { width: PAGE.width, height: PAGE.height }), 'low-contrast'), undefined);
});

test('body paragraphs at 24/24/24/15 flag the 15 as size-mismatch, and only it', () => {
  const sizes = [24, 24, 24, 15];
  const els = sizes.map((s, i) => snug(`p${i}`, para(2), { y: 100 + i * 360, text: { fontSize: s, maxFontSize: s } }));
  const c = checkPage(els, PAGE);
  const found = c.issues.filter((i) => i.kind === 'size-mismatch');
  assert.deepEqual(found.map((i) => i.elementId), ['p3']);
  assert.match(found[0]!.detail, /15px type, where the 3 other body paragraphs on this page are set at 24px \(median\)/);
  assert.match(found[0]!.fix, /set fontSize 24px to match/);
});

test('short body lines (cover lines, numbered entries) are not compared with running copy', () => {
  const els = [24, 24, 24, 15].map((s, i) => snug(`l${i}`, `0${i} — A short entry line`, { y: 100 + i * 100, text: { fontSize: s } }));
  assert.equal(find(checkPage(els, PAGE), 'size-mismatch'), undefined);
});

test('an uneven gap in a column is loose-gap, with the shift that closes it', () => {
  const gaps = [16, 16, 120, 16];
  const els: MagazineElement[] = [];
  let y = 100;
  for (let i = 0; i < 5; i++) {
    const el = snug(`c${i}`, para(1), { y });
    els.push(el);
    y = el.y + el.h + (gaps[i] ?? 0);
  }
  const c = checkPage(els, PAGE);
  const found = c.issues.filter((i) => i.kind === 'loose-gap');
  assert.equal(found.length, 1, JSON.stringify(c.issues));
  assert.equal(found[0]!.elementId, 'c3');
  assert.equal(found[0]!.otherId, 'c2');
  assert.match(found[0]!.detail, /a 120px gap above it in its column/);
  assert.match(found[0]!.fix, new RegExp(`move it up 104px to y=${els[3]!.y - 104}, and the 1 box below it in this column up by the same 104px`));
});

test('a gap holding something (a photo, a subhead of another width) is not loose', () => {
  const gaps = [16, 16, 220, 16];
  const els: MagazineElement[] = [];
  let y = 100;
  for (let i = 0; i < 5; i++) {
    const el = snug(`c${i}`, para(1), { y });
    els.push(el);
    y = el.y + el.h + (gaps[i] ?? 0);
  }
  const photo = imageEl('photo', { x: 100, y: els[2]!.y + els[2]!.h + 20, w: 300, h: 180 });
  assert.equal(find(checkPage([...els, photo], PAGE), 'loose-gap'), undefined);
});

test('a text box running off the page is off-page with a move that brings it back', () => {
  const el = snug('off', 'A line', { x: 1100, w: 400 });
  const i = find(checkPage([el], PAGE), 'off-page', 'off')!;
  assert.ok(i);
  assert.equal(i.severity, 'error');
  assert.match(i.detail, /260px past the right edge/);
  assert.match(i.fix, new RegExp(`move it to x=${PAGE.width - 400}, y=100`));
  // A photo bleeding a little off the edge is a choice, not an error.
  assert.equal(find(checkPage([imageEl('bleed', { x: -20, w: 700 })], PAGE), 'off-page'), undefined);
});

test('checkElement on a picture box: a sliver is reported with the size that fixes it', () => {
  const ribbon = imageEl('ribbon', { w: 529, h: 123 });
  const r = checkElement(ribbon, PAGE);
  assert.deepEqual(r.issues.map((i) => i.kind), ['sliver']);
  assert.equal(r.fits, true, 'a sliver is a warning, not a fit failure');
  assert.match(r.issues[0]!.fix, /make it at least 212px tall, or narrow it to 307px/);
  assert.equal(r.needPx, undefined);
});

test('a half-merged working copy (a NaN size, a missing line height) is still checked, never waved through', () => {
  const broken = { ...textEl('body', para(6), { h: 80 }) };
  broken.text = { ...broken.text!, fontSize: Number.NaN, lineHeight: undefined as unknown as number };
  const c = checkPage([broken], PAGE);
  assert.ok(find(c, 'text-clipped', 'body'), JSON.stringify(c.issues));
  assert.equal(checkElement(broken, PAGE).fits, false);
});

// ── The real issue (NZ fixture) ──────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'nz-racing-scene.json'), 'utf8')) as {
  magazine: { genPlanPages: { kind: string; sectionTitle: string }[] };
  pages: { index: number; width: number; height: number; background: { type: 'color' | 'image'; value: string }; elements: MagazineElement[] }[];
};

test('NZ fixture: the stored cover is ok, and page 5’s only error is the photo hidden under a 0.88 wash', () => {
  const p1 = fx.pages[0]!;
  const c1 = checkPage(p1.elements, { width: p1.width, height: p1.height, background: p1.background }, { pageNumber: 1 });
  assert.equal(c1.ok, true, c1.summary);
  const p5 = fx.pages[4]!;
  const c5 = checkPage(p5.elements, { width: p5.width, height: p5.height, background: p5.background }, { pageNumber: 5 });
  const errors = c5.issues.filter((i) => i.severity === 'error');
  assert.deepEqual(errors.map((i) => i.kind), ['element-hidden']);
  assert.match(errors[0]!.detail, /88%-opaque shape/);
  // The reported defects are visible as warnings: slivers, oversize boxes, dead bands.
  const p4 = fx.pages[3]!;
  const k4 = kinds(checkPage(p4.elements, { width: p4.width, height: p4.height, background: p4.background }));
  for (const k of ['sliver', 'empty-box', 'dead-band'] as const) assert.ok(k4.includes(k), `page 4 ${k}: ${k4.join(', ')}`);
});

test('NZ fixture: after Adjust, the clean pages check ok with nothing to report', () => {
  for (const n of [1, 3, 4, 5, 6]) {
    const p = fx.pages[n - 1]!;
    const plan = fx.magazine.genPlanPages[p.index]!;
    const edits = pageCopyEdits(p.elements, [], { pageKind: plan.kind, totalPages: fx.pages.length, sectionTitle: plan.sectionTitle });
    const byId = new Map(edits.map((e) => [e.elementId, e.content]));
    const edited = p.elements.map((e) => (byId.has(e.id) && e.text ? { ...e, text: { ...e.text, content: byId.get(e.id)! } } : e));
    const r = relayoutPage(edited, { width: p.width, height: p.height });
    assert.ok(r, `page ${n} could not be re-balanced`);
    const c = checkPage(r!.elements, { width: p.width, height: p.height, background: p.background }, { pageNumber: n });
    assert.equal(c.ok, true, c.summary);
    assert.deepEqual(c.issues, [], c.summary);
    assert.equal(c.summary, `Page ${n}: no problems found (estimated from the element data).`);
  }
});

test('every page type the generator composes (offline seeds, real copy) checks clean: the check does not cry wolf', () => {
  for (const t of PAGE_TYPES) {
    const r = runSpec(seedSpecForPage({ kind: t.baseKind, pageType: t.id }));
    const c = checkPage(r.elements, { ...SEED_PAGE, background: { type: 'color', value: r.background } });
    assert.deepEqual(
      c.issues.map((i) => `${i.severity} ${i.kind} ${i.label}: ${i.detail}`),
      [],
      `seed "${t.id}"`,
    );
  }
});

// ── Order, cap, comparison ───────────────────────────────────────────────────

test('output is deterministic, errors first, and capped at 12', () => {
  const els: MagazineElement[] = [];
  for (let i = 0; i < 20; i++) els.push(imageEl(`slot${i}`, { url: '', x: 40 + (i % 4) * 290, y: 40 + Math.floor(i / 4) * 330, w: 260, h: 300 }));
  els.push(snug('small', 'Fine print', { x: 40, y: 1700, h: 20, text: { fontSize: 9, maxFontSize: 9, minFontSize: 6 } }));
  const a = checkPage(els, PAGE);
  const b = checkPage([...els].reverse(), PAGE);
  assert.equal(a.issues.length, MAX_ISSUES);
  assert.deepEqual(a, b, 'the same page in another element order gives the same check');
  assert.ok(a.issues.every((i) => i.severity === 'error'), 'errors fill the cap before any warning');
  assert.deepEqual(a.issues.map((i) => i.elementId).slice(0, 4), ['slot0', 'slot1', 'slot2', 'slot3'], 'reading order');
  assert.match(a.summary, /12 errors \(the most important shown\)/);

  const mixed = checkPage([snug('white', 'Pale words', { text: { color: '#ffffff' } }), imageEl('slot', { url: '', y: 900 })], PAGE);
  assert.deepEqual(noBands(mixed.issues).map((i) => `${i.severity}:${i.kind}`), ['error:image-empty', 'warning:low-contrast']);
  const sev = mixed.issues.map((i) => i.severity);
  assert.deepEqual(sev, [...sev].sort(), 'every error before any warning');
});

test('newErrors reports only regressions: new errors, and errors that got clearly worse', () => {
  const clippedA = { ...textEl('a', para(4)), h: 200 };
  const fineB = snug('b', para(1), { x: 700 });
  const before = checkPage([clippedA, fineB], PAGE);
  assert.equal(before.ok, false);
  // Same clipped A, and B now clipped too.
  const clippedB = { ...fineB, h: Math.round(fineB.h / 3) };
  const after = checkPage([clippedA, clippedB], PAGE);
  assert.deepEqual(newErrors(before, after).map((i) => i.elementId), ['b']);
  // A fixed page has no new errors; an unchanged page has none either.
  assert.deepEqual(newErrors(before, checkPage([snug('a', para(4)), fineB], PAGE)), []);
  assert.deepEqual(newErrors(before, before), []);
  // A's overflow tripling is a regression even though A was already clipped.
  const worse = checkPage([{ ...textEl('a', para(12)), h: 200 }, fineB], PAGE);
  assert.deepEqual(newErrors(before, worse).map((i) => `${i.kind}:${i.elementId}`), ['text-clipped:a']);
  // Warnings are never "new errors".
  assert.deepEqual(newErrors(checkPage([fineB], PAGE), checkPage([fineB, snug('w', 'Pale', { y: 900, text: { color: '#ffffff' } })], PAGE)), []);
});

test('checkSummary names the page, the counts and each error', () => {
  const clipped = { ...textEl('body', para(4)), h: 150 };
  const c = checkPage([clipped, imageEl('slot', { url: '', y: 700 })], PAGE, { pageNumber: 2 });
  assert.equal(c.summary, checkSummary(c));
  assert.match(
    c.summary,
    /^Page 2: 2 errors, 2 warnings \(estimated from the element data\)\. Errors: body “The New Owners Group is embarking on one…”: text cut off; empty picture box #slot: empty picture box\. Warnings: the band y \d+–\d+: empty band across the page/,
  );
  assert.equal(checkSummary({ measuredBy: 'browser', ok: true, issues: [], summary: '' }), 'This page: no problems found (measured in the editor).');
});

// ── Measured by a browser ────────────────────────────────────────────────────

test('issuesFromMeasurements: synthetic Chromium measurements give the same kinds', () => {
  const body = textEl('body', para(2), { h: 200 });
  const pdf = textEl('pdf', 'A copied line', { source: 'extracted', x: 900, y: 300, w: 300, h: 35, text: { fontSize: 29, lineHeight: 1.2 } });
  const spill = textEl('spill', 'Another copied line', { source: 'extracted', x: 100, y: 900, w: 300, h: 35, text: { fontSize: 29, lineHeight: 1.2 } });
  const a = textEl('a', para(1), { y: 1200, h: 100 });
  const b = textEl('b', para(1), { y: 1250, h: 100 });
  const photo = imageEl('photo', { x: 700, y: 1400, w: 400, h: 300 });
  const els = [body, pdf, spill, a, b, photo];
  const m: ElementMeasurement[] = [
    { id: 'body', box: { x: 100, y: 100, w: 500, h: 200 }, contentW: 500, contentH: 260 },
    { id: 'pdf', box: { x: 900, y: 300, w: 300, h: 35 }, contentW: 420, contentH: 35, ink: { x: 900, y: 300, w: 420, h: 35 } },
    { id: 'spill', box: { x: 100, y: 900, w: 300, h: 35 }, contentW: 360, contentH: 35, ink: { x: 100, y: 900, w: 360, h: 35 } },
    { id: 'a', box: { x: 100, y: 1200, w: 500, h: 100 }, contentH: 100, ink: { x: 100, y: 1200, w: 500, h: 100 } },
    { id: 'b', box: { x: 100, y: 1250, w: 500, h: 100 }, contentH: 100, ink: { x: 100, y: 1250, w: 500, h: 100 } },
    { id: 'photo', box: { x: 700, y: 1400, w: 400, h: 300 }, imgOk: false },
  ];
  const issues = issuesFromMeasurements(m, els, PAGE);
  const byId = (id: string) => issues.filter((i) => i.elementId === id).map((i) => i.kind);
  assert.deepEqual(byId('body'), ['text-clipped']);
  const clip = issues.find((i) => i.kind === 'text-clipped')!;
  assert.equal(clip.measured?.needPx, 260, 'the browser’s height, not the estimate');
  assert.equal(clip.measured?.havePx, 200);
  assert.ok(clip.measured!.fitsAtPx! < 24 && clip.measured!.fitsAtPx! >= 14);
  assert.deepEqual(byId('pdf'), ['text-past-edge']);
  assert.match(issues.find((i) => i.kind === 'text-past-edge')!.detail, /80px past the right edge/);
  assert.deepEqual(byId('spill'), ['text-spills']);
  assert.ok(byId('b').includes('text-overlap'));
  assert.deepEqual(byId('photo'), ['image-broken']);

  const check = checkPageFromMeasurements(m, els, PAGE, { pageNumber: 4 });
  assert.equal(check.measuredBy, 'chromium');
  assert.equal(check.page, 4);
  assert.equal(check.ok, false);
  assert.match(check.summary, /measured on a render of the page/);
  assert.equal(checkPageFromMeasurements(m, els, PAGE, { measuredBy: 'browser' }).measuredBy, 'browser');
});

test('issuesFromMeasurements: the measurement is the truth — text the estimate calls clipped but the browser fits is fine', () => {
  const base = textEl('body', para(4));
  const el = { ...base, h: Math.round(need(base) * 0.9) };
  assert.ok(find(checkPage([el], PAGE), 'text-clipped'), 'precondition: the estimate says clipped');
  const m: ElementMeasurement[] = [{ id: 'body', box: { x: el.x, y: el.y, w: el.w, h: el.h }, contentW: el.w, contentH: el.h - 10 }];
  assert.deepEqual(noBands(issuesFromMeasurements(m, [el], PAGE)), []);
  // An element the browser did not report falls back to the estimate.
  assert.deepEqual(noBands(issuesFromMeasurements([], [el], PAGE)).map((i) => i.kind), ['text-clipped']);
});

test('copied PDF lines are estimated as the write path measures them: a trailing break adds no line', () => {
  // Two lines set by the PDF, the second ending in a break (common in extracted copy).
  // Split on the visible text's '\n', that was THREE lines — a third taller than the box
  // the PDF drew them in — and the estimate reported text spilling out of a box it fits.
  const h = Math.ceil(2 * 29 * 1.2);
  const el = textEl('pdf', 'Winter racing<br>at Ellerslie<br>', {
    source: 'extracted',
    x: 100,
    y: 300,
    w: 600,
    h,
    text: { fontFamily: 'Archivo, sans-serif', fontSize: 29, lineHeight: 1.2, maxFontSize: undefined, minFontSize: undefined },
  });
  assert.ok(keepsPdfLines(el), 'precondition: drawn as the PDF set it');
  const c = checkPage([el], PAGE);
  assert.equal(find(c, 'text-spills', 'pdf'), undefined, JSON.stringify(c.issues));
  assert.equal(find(c, 'text-past-edge', 'pdf'), undefined);
  // Three real lines in the same box still spill.
  const three = { ...el, text: { ...el.text!, content: 'Winter racing<br>at Ellerslie<br>on Saturday' } };
  assert.ok(find(checkPage([three], PAGE), 'text-spills', 'pdf'));
});
