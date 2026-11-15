// Run: npx tsx --test src/editor-v2/pageCheckRules.test.ts   (from apps/web)
//
// The editor's page check — the web twin of the server's lib/magazineV2/pageCheck.ts —
// fed with injected browser measurements, the way editor-v2/pageCheck.ts feeds it
// after drawing a page off-screen. The cases mirror the server's
// tests/magazineV2/pageCheck.test.ts. Two further groups keep the twins in step:
// every threshold is read back out of the server's source, and the server's own
// rules are run on the same measurements and must name the same problems in the same
// words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ElementTextData, MagazineElement } from './model';
import {
  APPROX_METRICS_SLACK,
  BACKGROUND_SHARE,
  BLEED_MAX_ASPECT,
  BLEED_MIN_ASPECT,
  CLIP_MIN_PX,
  CLIP_RATIO,
  COLUMN_OVERLAP,
  DEAD_BAND_SHARE,
  EDGE_ALLOWANCE_SHARE,
  EDGE_ESTIMATE_SLACK,
  EDGE_TOL_PX,
  FURNITURE_IDS,
  GOOD_CONTRAST,
  HIDDEN_COVER,
  HIDING_OPACITY,
  IMAGE_MAX_ASPECT,
  IMAGE_MIN_AREA_SHARE,
  IMAGE_MIN_ASPECT,
  IMAGE_MIN_SIDE,
  LOOSE_GAP_MIN_PX,
  LOOSE_GAP_RATIO,
  LOW_CONTRAST,
  MAX_COVERING_SCRIM_OPACITY,
  MAX_ISSUES,
  OVERLAP_SHARE,
  PAGE_DPI,
  PARAGRAPH_MIN_CHARS,
  SIZE_HI,
  SIZE_LO,
  SIZE_MIN_GROUP,
  SLACK_AT,
  SLACK_SERIOUS_SHARE,
  SPILL_RATIO,
  TINY_TEXT_PX,
  checkPageFromMeasurements,
  checkSummary,
  contrastRatio,
  elementLabel,
  freeSpaceBelow,
  issuesFromMeasurements,
  newErrors,
  parseColor,
  readableColor,
  visibleText,
  type CheckKind,
  type ElementMeasurement,
  type PageCheck,
  type PageCheckIssue,
  type TextProbe,
} from './pageCheckRules';
import { keepsPdfLines } from '../lib/pdfLines';

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

function iconEl(id: string, over: Partial<MagazineElement> & { src?: string } = {}): MagazineElement {
  const { src, ...rest } = over;
  return {
    id,
    type: 'icon',
    x: 800,
    y: 100,
    w: 120,
    h: 120,
    rotation: 0,
    zIndex: 3,
    locked: false,
    source: 'ai-agent',
    icon: src ? { src } : { name: 'trophy' },
    ...rest,
  } as MagazineElement;
}

/** What the browser reports for an element drawn exactly in its box: its copy fills
 *  the box, its lines are the box. Override any field with what was really drawn. */
function drawn(el: MagazineElement, over: Partial<ElementMeasurement> = {}): ElementMeasurement {
  const box = { x: el.x, y: el.y, w: el.w, h: el.h };
  if (el.type !== 'text') return { id: el.id, box, ...over };
  return { id: el.id, box, contentW: el.w, contentH: el.h, ink: { ...box }, ...over };
}
/** Every element of a page, drawn as its box says. */
const drawnAll = (els: MagazineElement[], over: Record<string, Partial<ElementMeasurement>> = {}) => els.map((el) => drawn(el, over[el.id]));

function check(els: MagazineElement[], m: ElementMeasurement[] = drawnAll(els), page: typeof PAGE | { width: number; height: number } = PAGE, opts: { pageNumber?: number; probe?: TextProbe } = {}): PageCheck {
  return checkPageFromMeasurements(m, els, page, opts);
}

const PARA =
  'The New Owners Group is embarking on one of the most significant owner-focused initiatives undertaken in New Zealand racing for many years, and owners are at the heart of it. ';
const para = (n: number) => PARA.repeat(n).trim();
const kinds = (c: PageCheck | PageCheckIssue[]) => (Array.isArray(c) ? c : c.issues).map((i) => i.kind);
/** A test page holds a few boxes on an otherwise blank sheet, so the page-level dead-band
 *  advisory is always there; most cases look past it. */
const noBands = <T extends { kind: CheckKind }>(list: T[]) => list.filter((i) => i.kind !== 'dead-band');
const find = (c: PageCheck, kind: CheckKind, id?: string) => c.issues.find((i) => i.kind === kind && (id === undefined || i.elementId === id));

// ── The 2026-11-15 incident ──────────────────────────────────────────────────

const INCIDENT_PAGE = { width: 1588, height: 2246, background: { type: 'color', value: '#ffffff' } };
const REWRITE = 'The New Owners Group (NOG) is embarking on a significant owner-focused initiative here.';

function incidentLine(): MagazineElement {
  return textEl('pdf-line', REWRITE, {
    source: 'extracted',
    x: 700,
    y: 400,
    w: 880,
    h: 35,
    text: { fontFamily: 'Times New Roman, serif', fontSize: 29, lineHeight: 1.2, maxFontSize: undefined, minFontSize: undefined },
  });
}
/** The browser drew the rewritten line as one 1100px run from x=700. */
const incidentDrawn = (el: MagazineElement) => drawn(el, { contentW: 1100, contentH: 35, ink: { x: 700, y: 401, w: 1100, h: 33 } });

test('INCIDENT: a rewritten PDF line drawn as set and wider than the page is text-past-edge', () => {
  const el = incidentLine();
  assert.equal(keepsPdfLines(el), true, 'precondition: the canvas still draws it as the PDF set it');
  const c = check([el], [incidentDrawn(el)], INCIDENT_PAGE, { pageNumber: 3 });
  assert.equal(c.ok, false);
  assert.equal(c.page, 3);
  assert.equal(c.measuredBy, 'browser');
  const i = find(c, 'text-past-edge', 'pdf-line');
  assert.ok(i, JSON.stringify(c.issues));
  assert.equal(i!.severity, 'error');
  assert.equal(i!.measured?.needPx, 1100);
  assert.equal(i!.measured?.havePx, INCIDENT_PAGE.width - el.x);
  assert.equal(i!.measured?.overflowPx, 212);
  assert.equal(i!.detail, 'its widest line is 1100px at 29px type, with 888px of page right of x=700 — it runs 212px past the right edge, where it is cut');
  // Wrapped in its own box, the one line becomes two at 29px; at 23px it is one line
  // again (1100 × 23/29 = 872px ≤ 880) — the size it fits at.
  assert.equal(i!.fix, 'edit it (a change to its words, size or width makes it wrap inside its 880px box; it fits there at 23px), or move it to x=488');
  assert.equal(kinds(c).includes('text-spills'), false, 'past the edge is the error; it is not also reported as a spill');
  assert.match(c.summary, /^Page 3: 1 error/);
  assert.match(c.summary, /measured in the editor/);
});

test('INCIDENT with a probe: the fit size comes from laying the copy out again in the browser', () => {
  const el = incidentLine();
  const asked: number[] = [];
  const probe: TextProbe = (e, size) => {
    asked.push(size);
    return size <= 20 ? 34 : 70; // two wrapped lines above 20px
  };
  const i = find(check([el], [incidentDrawn(el)], INCIDENT_PAGE, { probe }), 'text-past-edge')!;
  assert.match(i.fix, /it fits there at 20px/);
  assert.equal(i.measured?.fitsAtPx, 20);
  assert.ok(asked.length > 0 && asked.length < 12, `a binary search, not a sweep: ${asked.join(',')}`);
});

test('INCIDENT, the paragraph case: a one-line rewrite in a box of four lines wraps (canvas safety net) and is not past the edge', () => {
  const el = textEl('para', 'The New Owners Group (NOG) is embarking on one of the most significant owner-focused initiatives undertaken in New Zealand racing for many years, and owners are at the heart of it.', {
    source: 'extracted',
    x: 120,
    y: 400,
    w: 880,
    h: 140,
    text: { fontFamily: 'Times New Roman, serif', fontSize: 29, lineHeight: 1.2, maxFontSize: undefined, minFontSize: undefined },
  });
  assert.equal(keepsPdfLines(el), false);
  const c = check([el], [drawn(el, { contentH: 139, ink: { x: 120, y: 401, w: 870, h: 136 } })], INCIDENT_PAGE);
  assert.equal(find(c, 'text-past-edge'), undefined);
  assert.equal(c.ok, true);
});

// ── Text that does not fit ───────────────────────────────────────────────────

test('body text the browser draws 2× its box is text-clipped, with need/have from the measurement', () => {
  const el = textEl('body', para(4));
  const c = check([el], [drawn(el, { contentH: 400, ink: { x: 100, y: 100, w: 498, h: 395 } })]);
  const i = find(c, 'text-clipped', 'body');
  assert.ok(i, JSON.stringify(c.issues));
  assert.equal(i!.severity, 'error');
  assert.equal(c.ok, false);
  assert.equal(i!.measured?.needPx, 400);
  assert.equal(i!.measured?.havePx, 200);
  assert.equal(i!.measured?.overflowPx, 200);
  // No probe: the measured block scaled by the square of the size, the server's rule
  // for holding a suggestion to a measurement: floor(24 × √(200/400)) = 16.
  assert.equal(i!.measured?.fitsAtPx, 16);
  assert.equal(i!.detail, 'needs 400px at 24px type, the box is 200px — about 6 lines cut off');
  assert.equal(i!.fix, `set fontSize 16px (it fits at that size), or make the box 400px tall (${PAGE.height - (el.y + el.h)}px free below), or cut about 50% of the words`);
});

test('with a probe, the clipped text’s fit size is the browser’s own answer', () => {
  const el = textEl('body', para(4));
  const probe: TextProbe = (_e, size) => (size <= 18 ? 195 : 400);
  const i = find(check([el], [drawn(el, { contentH: 400 })], PAGE, { probe }), 'text-clipped')!;
  assert.equal(i.measured?.fitsAtPx, 18);
  assert.match(i.fix, /^set fontSize 18px \(it fits at that size\)/);
  // A probe that cannot answer (throws, or returns nonsense) falls back to the model.
  const broken: TextProbe = () => {
    throw new Error('no layout');
  };
  assert.equal(find(check([el], [drawn(el, { contentH: 400 })], PAGE, { probe: broken }), 'text-clipped')!.measured?.fitsAtPx, 16);
  assert.equal(find(check([el], [drawn(el, { contentH: 400 })], PAGE, { probe: () => Number.NaN }), 'text-clipped')!.measured?.fitsAtPx, 16);
  // A probe that says nothing legible fits gives no size to try.
  const never: TextProbe = () => 10_000;
  const none = find(check([el], [drawn(el, { contentH: 400 })], PAGE, { probe: never }), 'text-clipped')!;
  assert.equal(none.measured?.fitsAtPx, undefined);
  assert.doesNotMatch(none.fix, /set fontSize/);
});

test('clipped text that fits at no legible size says so: no fits-at, the height it needs instead', () => {
  const el = textEl('body', para(10), { h: 120 });
  const i = find(check([el], [drawn(el, { contentH: 2000 })]), 'text-clipped', 'body')!;
  assert.ok(i);
  assert.equal(i.measured?.fitsAtPx, undefined);
  assert.doesNotMatch(i.fix, /set fontSize/);
  assert.match(i.fix, /make the box 2000px tall/);
});

test('half-leading under the last line is not clipping: within 2% and 4px is a fit', () => {
  const el = textEl('body', para(2), { h: 300 });
  assert.equal(find(check([el], [drawn(el, { contentH: 300 + CLIP_MIN_PX })]), 'text-clipped'), undefined);
  assert.ok(find(check([el], [drawn(el, { contentH: Math.ceil(300 * CLIP_RATIO) + 1 })]), 'text-clipped'));
});

test('the room to grow is measured to the next thing below in the column', () => {
  const el = textEl('body', para(4));
  const below = textEl('next', 'A caption under it.', { y: el.y + el.h + 30, h: 30, text: { role: 'caption', fontSize: 18 } });
  assert.equal(freeSpaceBelow(el, [el, below], PAGE), 30);
  const i = find(check([el, below], [drawn(el, { contentH: 400 }), drawn(below)]), 'text-clipped', 'body')!;
  assert.match(i.fix, /make the box 400px tall, but only 30px is free below, so move what is underneath first/);
  // A sheet-sized photo behind everything is the ground, not an obstacle.
  const ground = imageEl('bg', { x: 0, y: 0, w: PAGE.width, h: PAGE.height, zIndex: 0 });
  assert.equal(freeSpaceBelow(el, [ground, el], PAGE), PAGE.height - (el.y + el.h));
});

test('text the browser fits is not flagged', () => {
  const el = textEl('body', para(2));
  const c = check([el], [drawn(el, { contentH: 190 })]);
  assert.deepEqual(noBands(c.issues), []);
  assert.equal(c.ok, true);
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
  const c = check([el], [drawn(el, { contentW: 700, contentH: 35, ink: { x: 100, y: 101, w: 700, h: 33 } })]);
  const i = find(c, 'text-spills', 'spill');
  assert.ok(i, JSON.stringify(c.issues));
  assert.equal(i!.severity, 'warning');
  assert.equal(c.ok, true, 'a spill is a warning');
  assert.equal(i!.detail, 'copied PDF text draws 700×35px in a 600×35px box (17% over) — it spills onto what is around it');
  assert.match(i!.fix, /^make the box 700×35px, or edit it/);
  // Within 10% is the PDF's own set, drawn in the reader's face.
  assert.equal(find(check([el], [drawn(el, { ink: { x: 100, y: 101, w: 655, h: 33 } })]), 'text-spills'), undefined);
});

test('a measurement needs no stand-in-metrics allowance: a face the server cannot measure spills here too', () => {
  const el = textEl('copy', 'Owners are at the heart of the programme for years', {
    source: 'extracted',
    w: 600,
    h: 35,
    text: { fontFamily: 'Calibri, Candara, Segoe UI, Optima, sans-serif', fontSize: 29, lineHeight: 1.2, maxFontSize: undefined, minFontSize: undefined },
  });
  const m = [drawn(el, { contentW: 702, ink: { x: 100, y: 100, w: 702, h: 35 } })];
  assert.deepEqual(kinds(noBands(issuesFromMeasurements(m, [el], PAGE))), ['text-spills']);
});

// ── Collisions and stacking ──────────────────────────────────────────────────

test('two body boxes overlapping by 30% are a text-overlap error, naming both and where to move', () => {
  const a = textEl('a', para(2));
  const b = textEl('b', para(2), { y: a.y + Math.round(a.h * 0.7) });
  const c = check([a, b]);
  const i = find(c, 'text-overlap');
  assert.ok(i, JSON.stringify(c.issues));
  assert.equal(i!.severity, 'error');
  assert.equal(i!.elementId, 'b', 'the lower block is the one to move');
  assert.equal(i!.otherId, 'a');
  assert.match(i!.detail, /30% of the smaller block/);
  assert.match(i!.fix, new RegExp(`move it down to y=${a.y + a.h + 12}`));
});

test('overlap is judged on the drawn lines, not the boxes: boxes that overlap but whose lines do not are fine', () => {
  const a = textEl('a', para(1));
  const b = textEl('b', para(1), { y: a.y + 100 });
  // The browser drew a's copy in its top 90px, so b's lines start below it.
  const m = [drawn(a, { contentH: 90, ink: { x: 100, y: 100, w: 500, h: 90 } }), drawn(b)];
  assert.equal(find(check([a, b], m), 'text-overlap'), undefined);
  assert.ok(find(check([a, b]), 'text-overlap'), 'drawn to their full boxes, they do overlap');
});

test('text side by side, or a hair apart, does not overlap', () => {
  const a = textEl('a', para(2));
  const b = textEl('b', para(2), { x: a.x + a.w + 40 });
  const c = textEl('c', para(1), { y: a.y + a.h + 4, h: 100 });
  assert.equal(find(check([a, b, c]), 'text-overlap'), undefined);
});

test('text under an opaque shape drawn above it is element-hidden, and the fix names z+1', () => {
  const t = textEl('t', para(1), { zIndex: 1, h: 100 });
  const panel = shapeEl('panel', { x: 80, y: 80, w: 560, h: 400, zIndex: 5 });
  const c = check([t, panel]);
  const i = find(c, 'element-hidden', 't');
  assert.ok(i, JSON.stringify(c.issues));
  assert.equal(i!.severity, 'error');
  assert.equal(i!.otherId, 'panel');
  assert.match(i!.fix, /set zIndex 6 on it/);
  // A see-through scrim does not hide; neither does a panel drawn BELOW the text.
  assert.equal(find(check([t, { ...panel, shape: { fill: '#000000', opacity: 0.55 } }]), 'element-hidden'), undefined);
  assert.equal(find(check([t, { ...panel, zIndex: 0 }]), 'element-hidden'), undefined);
});

test('a photo under a near-opaque wash is hidden, and the fix offers thinning the wash', () => {
  const photo = imageEl('photo', { zIndex: 0 });
  const wash = shapeEl('wash', { fill: '#0e0e0e', opacity: 0.88, zIndex: 1 });
  const i = find(check([photo, wash]), 'element-hidden', 'photo')!;
  assert.ok(i);
  assert.match(i.detail, /88%-opaque shape/);
  assert.match(i.fix, /set zIndex 2 on it/);
  assert.match(i.fix, /lower #wash's opacity to 0\.7 or less \(it is 0\.88\)/);
});

test('equal zIndex: the later element in the list is drawn on top (the canvas’s stable sort)', () => {
  const photo = imageEl('photo', { zIndex: 3 });
  const panel = shapeEl('panel', { zIndex: 3 });
  assert.ok(find(check([photo, panel]), 'element-hidden', 'photo'));
  assert.equal(find(check([panel, photo]), 'element-hidden'), undefined);
});

// ── Pictures and empty boxes ─────────────────────────────────────────────────

test('an image with no url is image-empty (it prints nothing, on the page or in the PDF)', () => {
  const slot = imageEl('slot', { url: '' });
  const t = textEl('t', 'Headline', { y: 600, h: 40 });
  // IssuePageCanvas draws nothing for it, so the browser reports nothing for it.
  const c = check([slot, t], [drawn(t)]);
  const i = find(c, 'image-empty', 'slot');
  assert.ok(i);
  assert.equal(i!.severity, 'error');
  assert.match(i!.fix, /600×400px, aspect 1\.50:1/);
});

test('a picture that finished loading with no pixels is image-broken; one still loading is not judged', () => {
  const photo = imageEl('photo', { x: 700, y: 1400, w: 400, h: 300 });
  const icon = iconEl('logo', { src: 'https://cdn.example.com/logo.png' });
  const glyph = iconEl('glyph', { x: 950 });
  const els = [photo, icon, glyph];
  const c = check(els, [drawn(photo, { imgOk: false }), drawn(icon, { imgOk: false }), drawn(glyph)]);
  assert.deepEqual(c.issues.filter((i) => i.kind === 'image-broken').map((i) => i.elementId).sort(), ['logo', 'photo']);
  const i = find(c, 'image-broken', 'photo')!;
  assert.equal(i.severity, 'error');
  assert.match(i.fix, /400×300px, aspect 1\.33:1/);
  assert.equal(find(check(els, [drawn(photo), drawn(icon, { imgOk: true }), drawn(glyph)]), 'image-broken'), undefined);
});

test('a text box with no words is a text-empty warning', () => {
  const t = textEl('t', para(1), { h: 100 });
  const blank = textEl('blank', '  <b></b> ', { y: 800 });
  const i = find(check([t, blank]), 'text-empty', 'blank');
  assert.ok(i);
  assert.equal(i!.severity, 'warning');
});

test('a page with nothing drawn is page-empty; a photo background is not empty', () => {
  assert.deepEqual(kinds(check([])), ['page-empty']);
  const onlyShape = check([shapeEl('s')]);
  assert.ok(find(onlyShape, 'page-empty'));
  assert.equal(onlyShape.ok, false);
  assert.equal(find(check([], [], { ...PAGE, background: { type: 'image', value: 'https://cdn.example.com/bg.jpg' } }), 'page-empty'), undefined);
});

test('a tall box whose drawn copy fills a fraction of it is empty-box, from the MEASURED height', () => {
  const el = textEl('lead', para(1), { w: 1000, h: 800 });
  const c = check([el], [drawn(el, { contentH: 100, ink: { x: 100, y: 100, w: 1000, h: 96 } })]);
  const i = find(c, 'empty-box', 'lead');
  assert.ok(i, JSON.stringify(c.issues));
  assert.equal(i!.detail, 'the box is 800px tall but its copy prints only 100px — 32% of the page left blank inside one box');
  assert.equal(i!.fix, 'shrink the box to about 112px tall and use the space it frees, or give it more copy');
  // The dead band under the copy is measured from the copy, not the box.
  assert.ok(c.issues.some((b) => b.kind === 'dead-band' && /from y=200 /.test(b.detail)), JSON.stringify(c.issues));
});

// ── Legibility ───────────────────────────────────────────────────────────────

test('10px body text is tiny-text (under the type scale’s lowest floor)', () => {
  const el = textEl('small', 'Terms and conditions apply to all entries.', { h: 20, text: { fontSize: 10, maxFontSize: 10, minFontSize: 6 } });
  const c = check([el]);
  const i = find(c, 'tiny-text', 'small');
  assert.ok(i, JSON.stringify(c.issues));
  assert.equal(i!.severity, 'warning');
  assert.match(i!.detail, /10px type is about 4\.8pt in print, under the 12px \(5\.8pt\) floor/);
  // At 12px the drawn 20px grows to about 29px: more than the box holds.
  assert.match(i!.fix, new RegExp(`^set fontSize ${TINY_TEXT_PX}px and make the box 29px tall`));
  // Room to spare: it still fits.
  const roomy = { ...el, h: 40 };
  assert.match(find(check([roomy], [drawn(roomy, { contentH: 20 })]), 'tiny-text')!.fix, /set fontSize 12px \(it still fits the box\)/);
  // Furniture (the folio, the running head) is deliberately small and exempt.
  const folio = { ...el, id: 'furniture-folio' };
  assert.equal(find(check([folio]), 'tiny-text'), undefined);
});

test('#ffffff text on a white page is low-contrast, and the fix is readableColor’s choice', () => {
  const el = textEl('white', 'Owners are at the heart of it', { h: 40, text: { color: '#ffffff' } });
  const c = check([el]);
  const i = find(c, 'low-contrast', 'white');
  assert.ok(i, JSON.stringify(c.issues));
  assert.equal(i!.severity, 'warning');
  assert.equal(i!.measured?.contrast, 1);
  assert.match(i!.fix, new RegExp(`set color ${readableColor('#ffffff', '#ffffff', '#ffffff', '#111111')}`));
});

test('contrast is judged against what is behind the text: a panel, a tint over the page, never a photo', () => {
  const el = textEl('white', 'Owners are at the heart of it', { h: 40, text: { color: '#ffffff' }, zIndex: 5 });
  assert.equal(find(check([shapeEl('panel', { zIndex: 1 }), el]), 'low-contrast'), undefined);
  assert.equal(find(check([imageEl('photo', { zIndex: 1 }), el]), 'low-contrast'), undefined);
  assert.ok(find(check([shapeEl('tint', { fill: '#000000', opacity: 0.05, zIndex: 1 }), el]), 'low-contrast'));
  const navy = textEl('navy', para(1), { y: 900, h: 100, text: { color: '#0b1f3a' } });
  assert.match(find(check([el, navy]), 'low-contrast')!.fix, /set color #0b1f3a/);
  assert.equal(find(check([el], drawnAll([el]), { width: PAGE.width, height: PAGE.height }), 'low-contrast'), undefined);
});

test('body paragraphs at 24/24/24/15 flag the 15 as size-mismatch, and only it', () => {
  const sizes = [24, 24, 24, 15];
  const els = sizes.map((s, i) => textEl(`p${i}`, para(2), { y: 100 + i * 360, h: 300, text: { fontSize: s, maxFontSize: s } }));
  const found = check(els).issues.filter((i) => i.kind === 'size-mismatch');
  assert.deepEqual(found.map((i) => i.elementId), ['p3']);
  assert.match(found[0]!.detail, /15px type, where the 3 other body paragraphs on this page are set at 24px \(median\)/);
  assert.match(found[0]!.fix, /set fontSize 24px to match/);
});

test('short body lines (cover lines, numbered entries) are not compared with running copy', () => {
  const els = [24, 24, 24, 15].map((s, i) => textEl(`l${i}`, `0${i} — A short entry line`, { y: 100 + i * 100, h: 40, text: { fontSize: s } }));
  assert.equal(find(check(els), 'size-mismatch'), undefined);
});

test('an uneven gap in a column is loose-gap, with the shift that closes it', () => {
  const gaps = [16, 16, 120, 16];
  const els: MagazineElement[] = [];
  let y = 100;
  for (let i = 0; i < 5; i++) {
    const el = textEl(`c${i}`, para(1), { y, h: 100 });
    els.push(el);
    y = el.y + el.h + (gaps[i] ?? 0);
  }
  const found = check(els).issues.filter((i) => i.kind === 'loose-gap');
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.equal(found[0]!.elementId, 'c3');
  assert.equal(found[0]!.otherId, 'c2');
  assert.match(found[0]!.detail, /a 120px gap above it in its column/);
  assert.match(found[0]!.fix, new RegExp(`move it up 104px to y=${els[3]!.y - 104}, and the 1 box below it in this column up by the same 104px`));
});

test('a gap holding something (a photo) is not loose', () => {
  const gaps = [16, 16, 220, 16];
  const els: MagazineElement[] = [];
  let y = 100;
  for (let i = 0; i < 5; i++) {
    const el = textEl(`c${i}`, para(1), { y, h: 100 });
    els.push(el);
    y = el.y + el.h + (gaps[i] ?? 0);
  }
  const photo = imageEl('photo', { x: 100, y: els[2]!.y + els[2]!.h + 20, w: 300, h: 180 });
  assert.equal(find(check([...els, photo]), 'loose-gap'), undefined);
});

test('a text box running off the page is off-page with a move that brings it back', () => {
  const el = textEl('off', 'A line', { x: 1100, w: 400, h: 40 });
  const i = find(check([el]), 'off-page', 'off')!;
  assert.ok(i);
  assert.equal(i.severity, 'error');
  assert.match(i.detail, /260px past the right edge/);
  assert.match(i.fix, new RegExp(`move it to x=${PAGE.width - 400}, y=100`));
  // A photo bleeding a little off the edge is a choice, not an error.
  assert.equal(find(check([imageEl('bleed', { x: -20, w: 700 })]), 'off-page'), undefined);
});

test('a photo cut to a ribbon is a sliver, with the size that fixes it', () => {
  const ribbon = imageEl('ribbon', { w: 529, h: 123 });
  const i = find(check([ribbon]), 'sliver', 'ribbon')!;
  assert.ok(i);
  assert.equal(i.severity, 'warning');
  assert.match(i.fix, /make it at least 212px tall, or narrow it to 307px/);
});

test('a half-merged element (a NaN size, a missing line height) is still checked, never waved through', () => {
  const broken = { ...textEl('body', para(6), { h: 80 }) };
  broken.text = { ...broken.text!, fontSize: Number.NaN, lineHeight: undefined as unknown as number };
  const c = check([broken], [drawn(broken, { contentH: 400 })]);
  assert.ok(find(c, 'text-clipped', 'body'), JSON.stringify(c.issues));
});

test('a text element the browser did not report is not judged for fit — no guess either way', () => {
  const el = textEl('body', para(12), { h: 60 });
  const c = check([el], []);
  assert.equal(find(c, 'text-clipped'), undefined);
  assert.equal(find(c, 'text-past-edge'), undefined);
  // Everything that needs only the element data still runs.
  const tiny = textEl('tiny', 'Fine print', { y: 900, h: 20, text: { fontSize: 9, maxFontSize: 9, minFontSize: 6 } });
  assert.ok(find(check([tiny], []), 'tiny-text'));
});

// ── Order, cap, comparison ───────────────────────────────────────────────────

test('output is deterministic, errors first, and capped at 12', () => {
  const els: MagazineElement[] = [];
  for (let i = 0; i < 20; i++) els.push(imageEl(`slot${i}`, { url: '', x: 40 + (i % 4) * 290, y: 40 + Math.floor(i / 4) * 330, w: 260, h: 300 }));
  const small = textEl('small', 'Fine print', { x: 40, y: 1700, h: 20, text: { fontSize: 9, maxFontSize: 9, minFontSize: 6 } });
  els.push(small);
  const a = check(els, [drawn(small)]);
  const b = check([...els].reverse(), [drawn(small)]);
  assert.equal(a.issues.length, MAX_ISSUES);
  assert.deepEqual(a, b, 'the same page in another element order gives the same check');
  assert.ok(a.issues.every((i) => i.severity === 'error'), 'errors fill the cap before any warning');
  assert.deepEqual(a.issues.map((i) => i.elementId).slice(0, 4), ['slot0', 'slot1', 'slot2', 'slot3'], 'reading order');
  assert.match(a.summary, /12 errors \(the most important shown\)/);

  const white = textEl('white', 'Pale words', { h: 40, text: { color: '#ffffff' } });
  const slot = imageEl('slot', { url: '', y: 900 });
  const mixed = check([white, slot], [drawn(white)]);
  assert.deepEqual(noBands(mixed.issues).map((i) => `${i.severity}:${i.kind}`), ['error:image-empty', 'warning:low-contrast']);
  const sev = mixed.issues.map((i) => i.severity);
  assert.deepEqual(sev, [...sev].sort(), 'every error before any warning');
});

test('newErrors reports only regressions: new errors, and errors that got clearly worse', () => {
  const a = textEl('a', para(4));
  const b = textEl('b', para(1), { x: 700, h: 100 });
  const before = check([a, b], [drawn(a, { contentH: 400 }), drawn(b)]);
  assert.equal(before.ok, false);
  const after = check([a, b], [drawn(a, { contentH: 400 }), drawn(b, { contentH: 300 })]);
  assert.deepEqual(newErrors(before, after).map((i) => i.elementId), ['b']);
  assert.deepEqual(newErrors(before, check([a, b])), [], 'a fixed page has no new errors');
  assert.deepEqual(newErrors(before, before), []);
  const worse = check([a, b], [drawn(a, { contentH: 1000 }), drawn(b)]);
  assert.deepEqual(newErrors(before, worse).map((i) => `${i.kind}:${i.elementId}`), ['text-clipped:a']);
  const pale = textEl('w', 'Pale', { y: 900, h: 40, text: { color: '#ffffff' } });
  assert.deepEqual(newErrors(check([b]), check([b, pale])), [], 'warnings are never new errors');
});

test('checkSummary names the page, the counts and each error; measuredBy defaults to the editor', () => {
  const clipped = textEl('body', para(4), { h: 150 });
  const slot = imageEl('slot', { url: '', y: 700 });
  const c = check([clipped, slot], [drawn(clipped, { contentH: 400 })], PAGE, { pageNumber: 2 });
  assert.equal(c.measuredBy, 'browser');
  assert.equal(c.summary, checkSummary(c));
  assert.match(
    c.summary,
    /^Page 2: 2 errors, 2 warnings \(measured in the editor\)\. Errors: body “The New Owners Group is embarking on one…”: text cut off; empty picture box #slot: empty picture box\. Warnings: the band y \d+–\d+: empty band across the page/,
  );
  assert.equal(checkSummary({ measuredBy: 'browser', ok: true, issues: [], summary: '' }), 'This page: no problems found (measured in the editor).');
  assert.equal(checkPageFromMeasurements([], [], PAGE, { measuredBy: 'chromium' }).measuredBy, 'chromium');
});

// ── Helpers shared with the server ───────────────────────────────────────────

test('visibleText reads stored HTML the way a reader does', () => {
  assert.equal(visibleText('Smith &amp; Co<br>Hawke&rsquo;s&nbsp;Bay'), 'Smith & Co\nHawke’s Bay');
  assert.equal(visibleText('<b>NZ</b>TROF &#x41;&#66; &unknown; a < b'), 'NZTROF AB &unknown; a < b');
  assert.equal(visibleText('<!-- note -->x<br/>'), 'x\n');
  assert.equal(elementLabel(textEl('t', `<b>${PARA}</b>`)), 'body “The New Owners Group is embarking on one…”');
  assert.equal(elementLabel(textEl('t', ' <i></i> ')), 'empty body box #t');
  assert.equal(elementLabel(imageEl('p', { url: '' })), 'empty picture box #p');
});

test('colours: parseColor, contrastRatio and readableColor agree with the server’s maths', () => {
  assert.deepEqual(parseColor('#FFF'), { hex: '#ffffff', alpha: 1 });
  assert.deepEqual(parseColor('rgba(0, 0, 0, 0.5)'), { hex: '#000000', alpha: 0.5 });
  assert.deepEqual(parseColor('#11223380'), { hex: '#112233', alpha: 128 / 255 });
  assert.equal(parseColor('linear-gradient(#000, #fff)'), null);
  assert.equal(Math.round(contrastRatio('#000000', '#ffffff')), 21);
  assert.equal(contrastRatio('#777777', '#777777'), 1);
  assert.equal(readableColor('#ffffff', '#ffffff', '#ffffff', '#111111'), '#111111');
  assert.equal(readableColor('#0b1f3a', '#ffffff', '#ffffff', '#111111'), '#0b1f3a');
});

// ── Kept in step with the server ─────────────────────────────────────────────

/** apps/server/src/lib/magazineV2/<file>, found from wherever the test is run. */
function serverFile(file: string): string {
  const rel = path.join('apps', 'server', 'src', 'lib', 'magazineV2', file);
  for (const up of ['.', '..', path.join('..', '..'), path.join('..', '..', '..')]) {
    const p = path.resolve(process.cwd(), up, rel);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`cannot find the server's ${file} from ${process.cwd()}`);
}

/** The number a `const NAME = …;` declares in a server source file. */
function serverConst(file: string, name: string): number {
  const src = fs.readFileSync(serverFile(file), 'utf8');
  const m = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*([0-9.]+)(?:\\s*/\\s*([0-9.]+))?\\s*;`).exec(src);
  assert.ok(m, `${name} not found as a number in ${file}`);
  return m[2] ? Number(m[1]) / Number(m[2]) : Number(m[1]);
}

test('every threshold equals the server’s', () => {
  const here: Record<string, [string, number]> = {
    MAX_ISSUES: ['pageCheck.ts', MAX_ISSUES],
    CLIP_RATIO: ['pageCheck.ts', CLIP_RATIO],
    CLIP_MIN_PX: ['pageCheck.ts', CLIP_MIN_PX],
    SPILL_RATIO: ['pageCheck.ts', SPILL_RATIO],
    EDGE_TOL_PX: ['pageCheck.ts', EDGE_TOL_PX],
    EDGE_ESTIMATE_SLACK: ['pageCheck.ts', EDGE_ESTIMATE_SLACK],
    APPROX_METRICS_SLACK: ['pageCheck.ts', APPROX_METRICS_SLACK],
    OVERLAP_SHARE: ['pageCheck.ts', OVERLAP_SHARE],
    HIDDEN_COVER: ['pageCheck.ts', HIDDEN_COVER],
    LOW_CONTRAST: ['pageCheck.ts', LOW_CONTRAST],
    GOOD_CONTRAST: ['pageCheck.ts', GOOD_CONTRAST],
    SIZE_LO: ['pageCheck.ts', SIZE_LO],
    SIZE_HI: ['pageCheck.ts', SIZE_HI],
    SIZE_MIN_GROUP: ['pageCheck.ts', SIZE_MIN_GROUP],
    PARAGRAPH_MIN_CHARS: ['pageCheck.ts', PARAGRAPH_MIN_CHARS],
    LOOSE_GAP_RATIO: ['pageCheck.ts', LOOSE_GAP_RATIO],
    LOOSE_GAP_MIN_PX: ['pageCheck.ts', LOOSE_GAP_MIN_PX],
    COLUMN_OVERLAP: ['pageCheck.ts', COLUMN_OVERLAP],
    HIDING_OPACITY: ['layoutQuality.ts', HIDING_OPACITY],
    MAX_COVERING_SCRIM_OPACITY: ['layoutQuality.ts', MAX_COVERING_SCRIM_OPACITY],
    IMAGE_MIN_ASPECT: ['layoutQuality.ts', IMAGE_MIN_ASPECT],
    IMAGE_MAX_ASPECT: ['layoutQuality.ts', IMAGE_MAX_ASPECT],
    BLEED_MIN_ASPECT: ['layoutQuality.ts', BLEED_MIN_ASPECT],
    BLEED_MAX_ASPECT: ['layoutQuality.ts', BLEED_MAX_ASPECT],
    IMAGE_MIN_SIDE: ['layoutQuality.ts', IMAGE_MIN_SIDE],
    IMAGE_MIN_AREA_SHARE: ['layoutQuality.ts', IMAGE_MIN_AREA_SHARE],
    BACKGROUND_SHARE: ['layoutQuality.ts', BACKGROUND_SHARE],
    DEAD_BAND_SHARE: ['layoutQuality.ts', DEAD_BAND_SHARE],
    EDGE_ALLOWANCE_SHARE: ['layoutQuality.ts', EDGE_ALLOWANCE_SHARE],
    SLACK_AT: ['fitReport.ts', SLACK_AT],
    SLACK_SERIOUS_SHARE: ['fitReport.ts', SLACK_SERIOUS_SHARE],
    PAGE_DPI: ['config.ts', PAGE_DPI],
  };
  for (const [name, [file, value]] of Object.entries(here)) assert.equal(value, serverConst(file, name), `${name} (${file})`);
  // TINY_TEXT_PX is the type scale's lowest floor.
  const scale = fs.readFileSync(serverFile('roleScale.ts'), 'utf8');
  const floors = [...scale.matchAll(/minFontSize:\s*(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(floors.length >= 5);
  assert.equal(TINY_TEXT_PX, Math.min(...floors));
  // The furniture ids: every id pageFurniture.ts declares, and only those.
  const furniture = fs.readFileSync(serverFile('pageFurniture.ts'), 'utf8');
  const ids = [...furniture.matchAll(/const\s+\w+_ID\s*=\s*'([^']+)'/g)].map((m) => m[1]!);
  assert.deepEqual([...FURNITURE_IDS].sort(), [...new Set(ids)].sort());
});

/** The server's rules, loaded straight from its source (a path, not an import the
 *  web's type-check would follow into server code). */
async function serverRules(): Promise<{
  issuesFromMeasurements: (m: ElementMeasurement[], els: MagazineElement[], page: object) => PageCheckIssue[];
  checkSummary: (c: PageCheck) => string;
  visibleText: (html: string) => string;
  elementLabel: (el: MagazineElement) => string;
}> {
  const mod = await import(pathToFileURL(serverFile('pageCheck.ts')).href);
  const text = await import(pathToFileURL(serverFile('textReplace.ts')).href);
  return { ...(mod as object), visibleText: text.visibleText } as never;
}

/** Kinds whose suggested NUMBERS deliberately differ (the browser lays copy out again
 *  where the server estimates); their facts must still match. */
const SUGGESTION_KINDS = new Set<CheckKind>(['text-clipped', 'text-past-edge', 'text-spills', 'tiny-text', 'size-mismatch']);
/** Kinds the twin judges from the measured copy height where the server estimates it. */
const QUALITY_KINDS = new Set<CheckKind>(['empty-box', 'dead-band']);

function comparable(list: PageCheckIssue[]): string[] {
  return list
    .filter((i) => !QUALITY_KINDS.has(i.kind))
    .map((i) => [i.kind, i.severity, i.elementId ?? '', i.otherId ?? '', i.label, i.detail, SUGGESTION_KINDS.has(i.kind) ? '' : i.fix].join(' | '));
}

test('the server’s own rules, given the same measurements, name the same problems in the same words', async () => {
  const server = await serverRules();
  const incident = incidentLine();
  const spill = textEl('spill', 'Owners are at the heart of the programme for many years.', {
    source: 'extracted',
    x: 100,
    y: 900,
    w: 600,
    h: 35,
    text: { fontFamily: 'Times New Roman, serif', fontSize: 29, lineHeight: 1.2, maxFontSize: undefined, minFontSize: undefined },
  });
  const body = textEl('body', para(4));
  const a = textEl('a', para(2), { y: 1200, h: 200 });
  const b = textEl('b', para(2), { y: 1340, h: 200 });
  const fixtures: { name: string; page: { width: number; height: number; background?: { type: string; value: string } }; els: MagazineElement[]; m: ElementMeasurement[] }[] = [
    {
      name: 'text fit',
      page: INCIDENT_PAGE,
      els: [incident, spill, body, a, b],
      m: [incidentDrawn(incident), drawn(spill, { contentW: 700, ink: { x: 100, y: 901, w: 700, h: 33 } }), drawn(body, { contentH: 400 }), drawn(a), drawn(b)],
    },
    (() => {
      const t = textEl('t', para(1), { zIndex: 1, h: 100 });
      const panel = shapeEl('panel', { x: 80, y: 80, w: 560, h: 400, zIndex: 5 });
      const photo = imageEl('photo', { x: 700, y: 600, zIndex: 0, w: 400, h: 300 });
      const wash = shapeEl('wash', { x: 700, y: 600, w: 400, h: 300, fill: '#0e0e0e', opacity: 0.88, zIndex: 1 });
      const slot = imageEl('slot', { url: '', x: 100, y: 1000, w: 500, h: 300 });
      const broken = imageEl('broken', { x: 700, y: 1000, w: 400, h: 300 });
      const white = textEl('white', 'Owners are at the heart of it', { x: 100, y: 1400, h: 40, text: { color: '#ffffff' } });
      const off = textEl('off', 'A line', { x: 1100, y: 1500, w: 400, h: 40 });
      const els = [t, panel, photo, wash, slot, broken, white, off];
      return { name: 'stacking and pictures', page: PAGE, els, m: [drawn(t), drawn(panel), drawn(photo), drawn(wash), drawn(broken, { imgOk: false }), drawn(white), drawn(off)] };
    })(),
    (() => {
      const els: MagazineElement[] = [];
      let y = 100;
      const gaps = [16, 16, 120, 16];
      for (let i = 0; i < 5; i++) {
        const el = textEl(`c${i}`, para(1), { y, h: 100, text: { fontSize: i === 4 ? 10 : 24, maxFontSize: 24 } });
        els.push(el);
        y = el.y + el.h + (gaps[i] ?? 0);
      }
      els.push(textEl('blank', ' <b></b> ', { x: 700, y: 100 }));
      els.push(imageEl('ribbon', { x: 700, y: 400, w: 529, h: 123 }));
      return { name: 'columns, legibility, shapes', page: PAGE, els, m: drawnAll(els) };
    })(),
    (() => {
      const els = [24, 24, 24, 15].map((s, i) => textEl(`p${i}`, para(2), { y: 100 + i * 360, h: 300, text: { fontSize: s, maxFontSize: s } }));
      return { name: 'sizes out of step', page: PAGE, els, m: drawnAll(els) };
    })(),
    { name: 'empty page', page: PAGE, els: [shapeEl('s')], m: [] },
  ];
  for (const f of fixtures) {
    const mine = issuesFromMeasurements(f.m, f.els, f.page);
    const theirs = server.issuesFromMeasurements(f.m, f.els, f.page);
    assert.ok(mine.length < MAX_ISSUES, `${f.name}: keep fixtures under the cap so both lists are whole`);
    assert.deepEqual(comparable(mine), comparable(theirs), f.name);
    // The wording of a whole report is the server's, word for word.
    const report = checkPageFromMeasurements(f.m, f.els, f.page, { pageNumber: 4 });
    assert.equal(checkSummary(report), server.checkSummary(report), `${f.name}: summary`);
    assert.equal(checkSummary({ ...report, measuredBy: 'estimate' }), server.checkSummary({ ...report, measuredBy: 'estimate' }));
  }
  // Every fixture together covers the kinds both sides judge the same way.
  const seen = new Set(fixtures.flatMap((f) => issuesFromMeasurements(f.m, f.els, f.page).map((i) => i.kind)));
  for (const k of ['text-past-edge', 'text-clipped', 'text-spills', 'text-overlap', 'element-hidden', 'image-empty', 'image-broken', 'text-empty', 'tiny-text', 'low-contrast', 'size-mismatch', 'loose-gap', 'off-page', 'sliver', 'page-empty'] as const) {
    assert.ok(seen.has(k), `cross-checked kind ${k}`);
  }
  for (const html of ['Smith &amp; Co<br>Hawke&rsquo;s&nbsp;Bay', '<b>NZ</b>TROF &#x41;&#66; &unknown; a < b', '<!-- c -->x<br/>', 'caf&eacute; &shy;&frac12;']) {
    assert.equal(visibleText(html), server.visibleText(html), html);
  }
});
