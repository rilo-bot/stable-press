// Run: npx tsx --test src/editor-v2/operator/editorActionsPure.test.ts (from apps/web)
// The pure decisions behind the studio's Operator actions (useMagazineEditorActions.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MagazineElement } from '../model';
import {
  appliedNote,
  applyAllQuestion,
  chartSpecArgs,
  elementBrief,
  magazineWideSwap,
  measuredSentence,
  mergeChartChanges,
  pageElementList,
  pickDocument,
  plainNumber,
  plainText,
  replaceLeftAlone,
  replaceQuestion,
  studioPrompt,
  type DocChoice,
  type WebChartSpec,
} from './editorActionsPure';

// ── studioPrompt (C21) ──────────────────────────────────────────────────────

/** The owner's view: every page, open page 3. */
const OWNER = { pages: [1, 2, 3, 4, 5].map((n) => ({ id: `p${n}`, index: n - 1 })), current: 'p3' };
/** A page-scoped collaborator: only real page 3, at rail position 1 — so both 3 and 1 mean "this page". */
const COLLAB = { pages: [{ id: 'p3', index: 2 }], current: 'p3' };

test('a page of the attached PDF reaches the studio word for word', () => {
  const p = 'Lay this page out like page 3 of the attached PDF';
  assert.equal(studioPrompt(p, OWNER.pages, OWNER.current), p);
});

test('the open page becomes "this page", the PDF page stays', () => {
  assert.equal(
    studioPrompt('Make page 3 look like page 3 of the brochure PDF', OWNER.pages, OWNER.current),
    'Make this page look like page 3 of the brochure PDF',
  );
});

test('a file name after "of" is a document, even for the collaborator alias', () => {
  const p = 'Lay this page out like page 1 of Spring_Brochure.pdf';
  assert.equal(studioPrompt(p, COLLAB.pages, COLLAB.current), p);
});

test("the collaborator's rail position still means this page", () => {
  assert.equal(studioPrompt("set it as page 1's background", COLLAB.pages, COLLAB.current), "set it as this page's background");
  assert.equal(studioPrompt('set it as page 1’s background', COLLAB.pages, COLLAB.current), "set it as this page's background");
});

test('"in the PDF" is kept, the open page is not', () => {
  const OPEN5 = { pages: OWNER.pages, current: 'p5' };
  assert.equal(
    studioPrompt('Use the text from page 5 in the PDF on page 5', OPEN5.pages, OPEN5.current),
    'Use the text from page 5 in the PDF on this page',
  );
});

test('"of the magazine" is this magazine', () => {
  assert.equal(studioPrompt('fix the page 3 of the magazine', OWNER.pages, OWNER.current), 'fix this page of the magazine');
});

test('other pages and an unknown open page are left alone', () => {
  assert.equal(studioPrompt('copy the headline from page 2', OWNER.pages, OWNER.current), 'copy the headline from page 2');
  assert.equal(studioPrompt('tidy page 3', OWNER.pages, 'missing'), 'tidy page 3');
  assert.equal(studioPrompt('tidy page no. 3 and page #3', OWNER.pages, OWNER.current), 'tidy this page and this page');
});

// ── magazineWideSwap (C17) ──────────────────────────────────────────────────

test('a magazine-wide word swap is recognised', () => {
  assert.deepEqual(magazineWideSwap('replace NZTROF with NOG everywhere'), { find: 'NZTROF', replace: 'NOG' });
  assert.deepEqual(magazineWideSwap('Replace "NZTROF" with "NOG" on all pages'), { find: 'NZTROF', replace: 'NOG' });
  assert.deepEqual(magazineWideSwap('change NZTROF to NOG throughout the magazine'), { find: 'NZTROF', replace: 'NOG' });
  assert.deepEqual(magazineWideSwap('Across the whole magazine, swap Te Akau for Te Akau Racing.'), { find: 'Te Akau', replace: 'Te Akau Racing' });
  assert.deepEqual(
    magazineWideSwap("Replace every instance of 'Owners Federation' with 'Owners Group' throughout"),
    { find: 'Owners Federation', replace: 'Owners Group' },
  );
});

test('a swap on one page, or a design request, is not', () => {
  assert.equal(magazineWideSwap('replace NZTROF with NOG on this page'), null);
  assert.equal(magazineWideSwap('change the headline to Spring Racing on every page'), null);
  assert.equal(magazineWideSwap('change all the fonts to Inter across the whole magazine'), null);
  assert.equal(magazineWideSwap('make the photos bigger everywhere'), null);
  assert.equal(magazineWideSwap('change it to blue everywhere'), null);
  assert.equal(magazineWideSwap('change the body text to Georgia on all pages'), null);
});

// ── the element list ────────────────────────────────────────────────────────

const base = { rotation: 0, locked: false, source: 'manual' as const };
const text = (id: string, content: string, y: number, extra: Partial<MagazineElement> = {}): MagazineElement => ({
  ...base,
  id,
  type: 'text',
  x: 40,
  y,
  w: 500,
  h: 120,
  zIndex: 2,
  text: { content, role: 'body', fontFamily: 'Inter', fontSize: 18.04, fontWeight: 400, color: '#111111', align: 'left', lineHeight: 1.3, autoFit: 'shrink' },
  ...extra,
});

test('a text element is labelled by its words, clipped visibly', () => {
  const b = elementBrief(text('t1', '<p>The New Owners Group&nbsp;(NOG) is embarking on one of the most significant</p>', 100.4));
  assert.equal(b.label, 'The New Owners Group (NOG) is embarking…');
  assert.equal(Array.from(b.label).length, 40);
  assert.equal(b.role, 'body');
  assert.equal(b.fontSize, 18);
  assert.deepEqual(b.box, [40, 100, 500, 120]);
  assert.equal(elementBrief(text('t2', '', 0)).label, '(empty text box)');
});

test('pictures, shapes and slots are labelled for what they are', () => {
  const img = (url: string): MagazineElement => ({ ...base, id: 'i', type: 'image', x: 0, y: 0, w: 10, h: 10, zIndex: 1, image: { assetId: 'a', url, alt: 'Bar chart — Wins', fit: 'contain' } });
  assert.equal(elementBrief(img('https://x/y.png')).label, 'Bar chart — Wins');
  const slot = elementBrief(img(''));
  assert.equal(slot.label, 'empty picture slot');
  assert.equal(slot.empty, true);
  const shape: MagazineElement = { ...base, id: 's', type: 'shape', x: 0, y: 0, w: 10, h: 10, zIndex: 1, shape: { fill: '#000000', opacity: 0.45 } };
  assert.equal(elementBrief(shape).label, 'shape #000000 at 45%');
});

test('the list reads top-down and is capped', () => {
  const els = [text('low', 'b', 500), text('high', 'a', 20), text('mid', 'c', 200)];
  assert.deepEqual(pageElementList(els).elements.map((e) => e.id), ['high', 'mid', 'low']);
  const capped = pageElementList(els, 2);
  assert.equal(capped.elements.length, 2);
  assert.equal(capped.more, 1);
});

test('plainText reads what a reader sees', () => {
  assert.equal(plainText('A&amp;B<br>line two <b>bold</b>'), 'A&B line two bold');
});

// ── charts ──────────────────────────────────────────────────────────────────

const WINS: WebChartSpec = chartSpecArgs.parse({
  type: 'bar',
  title: 'Wins by season',
  categories: [2021, 2022, 2023],
  series: [{ name: 'Wins', values: [12, 15, 9] }],
  highlight: '2023',
});

test('chart args take years as numbers and keep them as labels', () => {
  assert.deepEqual(WINS.categories, ['2021', '2022', '2023']);
});

test('"change 2023 to 14" changes that one number', () => {
  const r = mergeChartChanges(WINS, { setValues: [{ category: '2023', value: 14 }] });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.spec.series[0]!.values, [12, 15, 14]);
    assert.deepEqual(WINS.series[0]!.values, [12, 15, 9], 'the stored spec is not mutated');
  }
});

test('a new value written as plain numerals is taken; anything needing a guess is not', () => {
  const r = mergeChartChanges(WINS, { setValues: [{ category: '2021', value: '1,234' }] });
  assert.equal(r.ok && r.spec.series[0]!.values[0], 1234);
  const r2 = mergeChartChanges(WINS, { setValues: [{ category: '2021', value: 'about 7' }] });
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.match(r2.error, /not a plain number/);
  assert.equal(plainNumber('-3.5'), -3.5);
  assert.equal(plainNumber('$5'), null);
  assert.equal(plainNumber(Number.NaN), null);
});

test('several series need the series named; unknown names are explained', () => {
  const two = chartSpecArgs.parse({ type: 'line', categories: ['a', 'b'], series: [{ name: 'Wins', values: [1, 2] }, { name: 'Places', values: [3, 4] }] });
  const r1 = mergeChartChanges(two, { setValues: [{ category: 'a', value: 9 }] });
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.match(r1.error, /name which one/);
  const r2 = mergeChartChanges(two, { setValues: [{ category: 'a', series: 'places', value: 9 }] });
  assert.equal(r2.ok, true);
  if (r2.ok) assert.deepEqual(r2.spec.series[1]!.values, [9, 4]);
  const r3 = mergeChartChanges(two, { setValues: [{ category: 'zzz', series: 'Wins', value: 1 }] });
  assert.equal(r3.ok, false);
  if (!r3.ok) assert.match(r3.error, /no category "zzz"/);
});

test('new categories without new values are refused; the highlight follows the labels', () => {
  const r = mergeChartChanges(WINS, { categories: ['2021', '2022'] });
  assert.equal(r.ok, false);
  const r2 = mergeChartChanges(WINS, { categories: ['A', 'B', 'C'] });
  assert.equal(r2.ok, true);
  if (r2.ok) assert.equal(r2.spec.highlight, undefined);
});

test('an empty title removes it; a type change is kept', () => {
  const r = mergeChartChanges(WINS, { title: '', type: 'barh' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.spec.title, undefined);
    assert.equal(r.spec.type, 'barh');
  }
  assert.equal(mergeChartChanges(WINS, null).ok, false);
  assert.equal(mergeChartChanges(WINS, { type: 'radar' }).ok, false);
});

test('"make it a line chart" on a stacked chart drops the stacking; bar to barh keeps it', () => {
  const stacked = chartSpecArgs.parse({
    type: 'bar',
    stacked: true,
    categories: ['a', 'b'],
    series: [{ name: 'Wins', values: [1, 2] }, { name: 'Places', values: [3, 4] }],
  });
  const line = mergeChartChanges(stacked, { type: 'line' });
  assert.equal(line.ok, true);
  if (line.ok) {
    assert.equal(line.spec.type, 'line');
    assert.equal(line.spec.stacked, undefined, 'a line cannot stack, so the stored flag is not carried over');
  }
  const barh = mergeChartChanges(stacked, { type: 'barh' });
  assert.equal(barh.ok && barh.spec.stacked, true, 'a type that can stack keeps it');
  const asked = mergeChartChanges(stacked, { type: 'pie', stacked: true });
  assert.equal(asked.ok && asked.spec.stacked, true, 'an explicit request is passed on for the server to judge');
  assert.equal(stacked.stacked, true, 'the stored spec is not mutated');
});

// ── pickDocument ────────────────────────────────────────────────────────────

const DOCS: DocChoice[] = [
  { id: 's1', name: 'Spring Brochure.pdf', kind: 'source', readable: true },
  { id: 'u1', name: 'Spring Brochure.pdf', kind: 'upload', readable: true },
  { id: 'u2', name: 'Autumn Report.pdf', kind: 'upload', readable: true },
  { id: 'u3', name: 'Scan.pdf', kind: 'upload', readable: false, why: 'it has no readable text (a scanned PDF?)' },
];

test('one match wins; the same file in both stores is one document, read from its source copy', () => {
  const r = pickDocument('brochure', DOCS);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.doc.id, 's1');
  const r2 = pickDocument('AUTUMN', DOCS);
  assert.equal(r2.ok && r2.doc.id, 'u2');
});

test('none, several and unreadable are explained', () => {
  const none = pickDocument('winter', DOCS);
  assert.equal(none.ok, false);
  if (!none.ok) assert.match(none.error, /Attached: “Spring Brochure.pdf”, “Autumn Report.pdf”, “Scan.pdf”/);
  const several = pickDocument('.pdf', DOCS);
  assert.equal(several.ok, false);
  if (!several.ok) assert.match(several.error, /matches several/);
  const scan = pickDocument('scan', DOCS);
  assert.equal(scan.ok, false);
  if (!scan.ok) assert.match(scan.error, /can't be used yet: it has no readable text/);
  const empty = pickDocument('x', []);
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.noDocs, true);
});

test('an exact name beats a longer partial match', () => {
  const docs: DocChoice[] = [
    { id: 'a', name: 'report.pdf', kind: 'upload', readable: true },
    { id: 'b', name: 'report.pdf.old.pdf', kind: 'upload', readable: true },
  ];
  const r = pickDocument('Report.pdf', docs);
  assert.equal(r.ok && r.doc.id, 'a');
});

// ── replaceQuestion ─────────────────────────────────────────────────────────

test('the replace card says what, how many and where, page by page', () => {
  const q = replaceQuestion('NZTROF', 'NOG', [{ page: 5, count: 4 }, { page: 2, count: 3 }, { page: 7, count: 0 }], { wholeWord: true, skippedLocked: 2 });
  assert.equal(
    q,
    'Replace “NZTROF” with “NOG” in 7 places — page 2 (3), page 5 (4)? (whole words only, matching capitals.) Left alone: 2 in locked boxes (unlock them to change). Ctrl+Z will not take this back — to reverse it, replace “NOG” with “NZTROF”.',
  );
  assert.match(replaceQuestion('x', '', [{ page: 1, count: 1 }], { matchCase: false }), /^Delete “x” in 1 place — page 1 \(1\)\? \(ignoring capitals\.\)/);
});

test('locked boxes and pages that cannot be edited are named apart, with the real pages', () => {
  const q = replaceQuestion('NZTROF', 'NOG', [{ page: 2, count: 1 }], {
    skippedLocked: 1,
    blocked: [
      { page: 7, count: 2, reason: 'page-rebuilding' },
      { page: 4, count: 3, reason: 'page-submitted' },
    ],
  });
  assert.match(q, /Left alone: 1 in locked box \(unlock it to change\); 5 on pages that cannot be edited right now: page 4 \(3, submitted for review\), page 7 \(2, being rebuilt\)\./);
  assert.doesNotMatch(q, /submitted or approved pages are left alone/);
  assert.deepEqual(replaceLeftAlone(undefined, [{ page: 3, count: 1, reason: 'page-approved' }]), ['1 on page that cannot be edited right now: page 3 (1, approved)']);
  assert.deepEqual(replaceLeftAlone(0, []), []);
});

test('matches left in boxes too full for the longer text are said, next to the locked ones', () => {
  const q = replaceQuestion('Bob', 'Robert', [{ page: 2, count: 1 }], { skippedLocked: 1, skippedTooLong: 2 });
  assert.match(
    q,
    /Left alone: 1 in locked box \(unlock it to change\); 2 left in boxes too full for the longer text \(shorten those boxes first, or use a shorter replacement\)\./,
  );
  assert.deepEqual(replaceLeftAlone(undefined, undefined, 1), [
    '1 left in box too full for the longer text (shorten that box first, or use a shorter replacement)',
  ]);
  assert.deepEqual(replaceLeftAlone(undefined, undefined, 0), []);
});

// ── applyAllQuestion ────────────────────────────────────────────────────────

test('applying every page asks first when it reaches past the latest request', () => {
  // Only the page the latest request was about: no card (unless something is risky).
  assert.equal(applyAllQuestion([{ page: 5, count: 2 }], 5, []), null);
  assert.equal(applyAllQuestion([], 5, []), null);
  assert.equal(applyAllQuestion([{ page: 5, count: 2 }], 5, ['deleting 1 page (cannot be undone)']), "Apply the studio's changes, including deleting 1 page (cannot be undone)?");
  // A weeks-old rewrite on page 3 alongside today's request on page 5: named, with counts.
  assert.equal(
    applyAllQuestion([{ page: 5, count: 2 }, { page: 3, count: 4 }], 5, []),
    "Apply every change waiting for Apply — 4 changes on page 3 and 2 on page 5? Only page 5's came from the latest request — the rest were staged earlier and have not been applied.",
  );
  // No request since the magazine opened (restored from this browser): every page asks.
  assert.match(applyAllQuestion([{ page: 3, count: 1 }], null, []) ?? '', /^Apply every change waiting for Apply — 1 change on page 3\? They were staged by earlier requests/);
  assert.match(applyAllQuestion([{ page: 3, count: 1 }, { page: 5, count: 1 }], 5, ['rebuilding page 3']) ?? '', /on page 5, including rebuilding page 3\? Only page 5/);
});

test('a long page list is shortened', () => {
  const pages = Array.from({ length: 15 }, (_, i) => ({ page: i + 1, count: 1 }));
  assert.match(replaceQuestion('a', 'b', pages), /page 12 \(1\), and 3 more pages\?/);
});

// ── measured sentences ──────────────────────────────────────────────────────

test('the note after a change reports the measured page, never "check with readScreen"', () => {
  const clean = { ok: true, issues: [] };
  assert.equal(appliedNote(clean), 'Applied and measured — see pageCheck; fix any errors before reporting. Measured: no problems found (see pageCheck).');
  const bad = { ok: false, issues: [{ severity: 'error' as const, label: 'body “The New…”', detail: 'needs 412px, box is 260px' }, { severity: 'warning' as const }] };
  assert.match(measuredSentence(bad), /^Measured: 1 error on the page, e\.g\. body “The New…” — needs 412px, box is 260px\. Fix them/);
  assert.match(appliedNote(null, 'timed out'), /^Applied\. The page could not be measured just now \(timed out\) — call magazine\.checkPage/);
  assert.doesNotMatch(appliedNote(bad), /readScreen/);
});
