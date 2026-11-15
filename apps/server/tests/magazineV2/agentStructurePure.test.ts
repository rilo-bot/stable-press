// ---------------------------------------------------------------------------
// The pure half of the Studio agent's structure tools and staging
// (lib/magazineV2/agentStructurePure.ts).
//
// What these pin, finding by finding:
//   C06  "delete pages 3 and 4" deletes pages 3 and 4 — every page change is pinned
//        to a page ID when it is staged, and applying the ids in order (the way the
//        web does) hits the pages the user meant, not the ones after them;
//   C10  page changes are refused next to a staged whole-page change, which the web
//        applies on its own;
//   C09/C31  a layout rebuild never again promises to keep the user's words;
//   C12/C27/C28/C14  documents: listing, reading and building pages from them;
//   C05  changes an earlier turn staged are replayed onto the working copy, so a new
//        turn builds on them and nothing is lost without a word.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COPY_PAGE_NOTE,
  copyPageSummary,
  documentQuery,
  documentRows,
  EXCLUSIVE_KINDS,
  exclusiveStaged,
  generatePagesSummary,
  isExclusiveKind,
  orderedPages,
  pageAtNumber,
  pageBudgetRefusal,
  pageChangeRefusal,
  pageHeadline,
  pageName,
  pagesFromDocuments,
  planInsert,
  planRemovePage,
  planReorderPage,
  REBUILD_EFFECT,
  rebuildNote,
  replayStaged,
  sourceDocReadable,
  sourcePageRefusal,
  stagedPromptLines,
  stagedSeq,
  textBoxesWithWords,
  timeLeftRefusal,
  wholePageRefusal,
  withoutStaged,
  type PageRow,
  type StagedLike,
  type StructureProposal,
} from '../../src/lib/magazineV2/agentStructurePure.js';
import type { AgentProposal } from '../../src/lib/magazineV2/agent.js';
import type { MagazineElement } from '../../src/lib/magazineV2/model.js';

const PAGE = { width: 1240, height: 1754 };

let seq = 0;
function text(o: Partial<MagazineElement> & { content?: string; role?: string; fontSize?: number } = {}): MagazineElement {
  const { content, role, fontSize, ...rest } = o;
  return {
    id: `e${++seq}`,
    type: 'text',
    x: 100,
    y: 100,
    w: 600,
    h: 200,
    rotation: 0,
    zIndex: 1,
    locked: false,
    source: 'ai-agent',
    text: {
      role: (role ?? 'body') as NonNullable<MagazineElement['text']>['role'],
      content: content ?? 'Some words',
      color: '#111111',
      fontSize: fontSize ?? 20,
      fontFamily: 'Inter, Arial, sans-serif',
    } as NonNullable<MagazineElement['text']>,
    ...rest,
  } as MagazineElement;
}

/** A magazine of `n` pages whose stored indexes are given OUT of order, each with a headline. */
function magazine(n: number): PageRow[] {
  const rows: PageRow[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({ _id: `pg${i + 1}`, index: i, elements: [text({ role: 'headline', content: `Story ${i + 1}`, fontSize: 60 })] });
  }
  return rows.reverse();
}

const OPEN0 = { openIndex: 0 };

// ── Whole-page changes are staged alone (C10) ──────────────────────────────

test('exclusive kinds: a rebuild and a PDF page copy', () => {
  assert.deepEqual([...EXCLUSIVE_KINDS].sort(), ['apply-layout', 'copy-document-page']);
  assert.equal(isExclusiveKind('apply-layout'), true);
  assert.equal(isExclusiveKind('update'), false);
  assert.equal(exclusiveStaged([{ kind: 'update' }, { kind: 'copy-document-page' }])?.kind, 'copy-document-page');
  assert.equal(exclusiveStaged([{ kind: 'update' }]), undefined);
});

test('wholePageRefusal: nothing staged lets it through; anything staged is refused with what to do', () => {
  assert.equal(wholePageRefusal([], 'rebuild'), null);
  const one = wholePageRefusal([{ kind: 'update' }], 'rebuild')!;
  assert.match(one, /1 change is already staged/);
  assert.match(one, /apply \(or discard\) it first/);
  const two = wholePageRefusal([{ kind: 'update' }, { kind: 'add' }], 'copy')!;
  assert.match(two, /^Copying a PDF page replaces every element/);
  assert.match(two, /2 changes are already staged/);
  assert.match(wholePageRefusal([{ kind: 'apply-layout' }], 'copy')!, /already staged for a layout rebuild/);
  assert.match(wholePageRefusal([{ kind: 'copy-document-page' }], 'rebuild')!, /already staged for a copy of a PDF page/);
});

test('pageChangeRefusal: only a staged whole-page change blocks a page change (C10)', () => {
  assert.equal(pageChangeRefusal([]), null);
  assert.equal(pageChangeRefusal([{ kind: 'update' }, { kind: 'remove-page' }]), null);
  assert.match(pageChangeRefusal([{ kind: 'apply-layout' }])!, /layout rebuild, which is applied on its own/);
  assert.match(pageChangeRefusal([{ kind: 'copy-document-page' }])!, /copy of a PDF page/);
});

test('timeLeftRefusal: refuses slow work only when the turn is nearly out of time', () => {
  assert.equal(timeLeftRefusal(100_000, 30_000, 0), null);
  assert.match(timeLeftRefusal(20_000, 30_000, 0)!, /not enough time left in this turn/);
  assert.equal(timeLeftRefusal(Number.NaN, 30_000, 0), null);
});

// ── Which page a number means (C06) ────────────────────────────────────────

test('orderedPages sorts by the stored index; pageAtNumber returns an id even for the open page', () => {
  const rows = magazine(5);
  assert.deepEqual(orderedPages(rows).map((r) => r._id), ['pg1', 'pg2', 'pg3', 'pg4', 'pg5']);
  const open = pageAtNumber(rows, 1, OPEN0);
  assert.ok(open.ok && open.pageId === 'pg1' && open.isOpen);
  const other = pageAtNumber(rows, 4, OPEN0);
  assert.ok(other.ok && other.pageId === 'pg4' && !other.isOpen);
  const missing = pageAtNumber(rows, 9, OPEN0);
  assert.ok(!missing.ok && /has 5 pages, so there is no page 9/.test(missing.error));
});

test('pageAtNumber: a page-scoped collaborator may aim only at pages shared with them (and the open one)', () => {
  const rows = magazine(4);
  const readable = new Set(['pg3']);
  assert.equal(pageAtNumber(rows, 2, { openIndex: 2, readable }).ok, false);
  assert.equal(pageAtNumber(rows, 3, { openIndex: 0, readable }).ok, true);
  // The open page is always theirs, even when the readable set does not list it.
  assert.equal(pageAtNumber(rows, 1, { openIndex: 0, readable }).ok, true);
});

test('pageHeadline and pageName: the largest headline, tags and furniture left out', () => {
  const els = [
    text({ id: 'furniture-head-label', role: 'kicker', content: 'SECTION', fontSize: 90 }),
    text({ role: 'headline', content: 'Small head', fontSize: 30 }),
    text({ role: 'headline', content: '<b>Derby</b>&nbsp;Day', fontSize: 72 }),
    text({ role: 'body', content: 'Body copy that is very large indeed', fontSize: 200 }),
  ];
  assert.equal(pageHeadline(els), 'Derby Day');
  assert.equal(pageHeadline([text({ role: 'body', content: 'Only body here' })]), 'Only body here');
  assert.equal(pageHeadline([]), '');
  assert.equal(pageHeadline(undefined), '');
  assert.equal(pageHeadline([text({ role: 'headline', content: 'x'.repeat(60) })], 20), `${'x'.repeat(19)}…`);
  assert.equal(pageName(3, { _id: 'a', index: 2, elements: els }), 'page 3 (“Derby Day”)');
  assert.equal(pageName(3, { _id: 'a', index: 2, elements: [] }), 'page 3');
});

/**
 * Apply page proposals the way the web store does (planPageSteps + reorderIndices in
 * apps/web/src/editor-v2/proposals.ts): moves first, then deletions, each page found
 * by ID in the list as it is at that moment.
 */
function applyLikeTheWeb(startIds: string[], proposals: StructureProposal[]): string[] {
  let ids = [...startIds];
  for (const p of proposals.filter((x) => x.kind === 'reorder-page')) {
    const from = ids.indexOf(p.pageId!);
    const to = ids.indexOf(p.toPageId!);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved!);
  }
  for (const p of proposals.filter((x) => x.kind === 'remove-page')) ids = ids.filter((id) => id !== p.pageId);
  return ids;
}

test('C06: "delete pages 3 and 4" deletes pages 3 and 4, not 3 and 5', () => {
  const rows = magazine(6);
  const staged: StructureProposal[] = [];
  for (const n of [3, 4]) {
    const plan = planRemovePage(rows, n, staged, OPEN0);
    assert.ok(plan.ok, 'staged');
    staged.push({ id: `p${n}`, ...plan.proposal });
  }
  assert.deepEqual(staged.map((p) => p.pageId), ['pg3', 'pg4']);
  assert.deepEqual(staged.map((p) => p.targetIndex), [2, 3], 'the legacy index stays for an older client');
  assert.match(staged[0]!.summary, /^Remove page 3 \(“Story 3”\)$/);
  assert.deepEqual(applyLikeTheWeb(['pg1', 'pg2', 'pg3', 'pg4', 'pg5', 'pg6'], staged), ['pg1', 'pg2', 'pg5', 'pg6']);
});

test('planRemovePage refuses a page that does not exist, the same page twice, and the last page', () => {
  const rows = magazine(2);
  const missing = planRemovePage(rows, 3, [], OPEN0);
  assert.ok(!missing.ok && /no page 3/.test(missing.error));

  const first = planRemovePage(rows, 2, [], OPEN0);
  assert.ok(first.ok);
  const staged = [{ id: 'p1', ...first.proposal }] as AgentProposal[];
  const again = planRemovePage(rows, 2, staged, OPEN0);
  assert.ok(!again.ok && /already staged/.test(again.error));
  // An older proposal with only a 0-based index is recognised as the same page.
  const legacy = planRemovePage(rows, 2, [{ id: 'x', kind: 'remove-page', targetIndex: 1, summary: 's' }], OPEN0);
  assert.ok(!legacy.ok);

  const last = planRemovePage(rows, 1, staged, OPEN0);
  assert.ok(!last.ok && /at least one page/.test(last.error));
});

test('planRemovePage says when it is the open page and that a deletion cannot be undone', () => {
  const plan = planRemovePage(magazine(3), 1, [], OPEN0);
  assert.ok(plan.ok);
  assert.match(plan.proposal.summary, /the page that is open now/);
  assert.match(plan.note, /cannot be brought back with undo/);
});

test('C06: a move is pinned to the page it moves and the page at its destination', () => {
  const rows = magazine(5);
  const down = planReorderPage(rows, 2, 5, OPEN0);
  assert.ok(down.ok);
  assert.equal(down.proposal.pageId, 'pg2');
  assert.equal(down.proposal.toPageId, 'pg5');
  assert.equal(down.proposal.from, 1);
  assert.equal(down.proposal.to, 4);
  assert.match(down.proposal.summary, /^Move page 2 \(“Story 2”\) to become page 5$/);
  assert.deepEqual(applyLikeTheWeb(['pg1', 'pg2', 'pg3', 'pg4', 'pg5'], [{ id: 'a', ...down.proposal }]), ['pg1', 'pg3', 'pg4', 'pg5', 'pg2']);

  const up = planReorderPage(rows, 5, 2, OPEN0);
  assert.ok(up.ok);
  assert.deepEqual(applyLikeTheWeb(['pg1', 'pg2', 'pg3', 'pg4', 'pg5'], [{ id: 'b', ...up.proposal }]), ['pg1', 'pg5', 'pg2', 'pg3', 'pg4']);
});

test('C06: a move staged with a deletion still lands where the user pointed', () => {
  // "Delete page 1 and move page 4 to page 2" — the numbers describe the magazine as it is.
  const rows = magazine(5);
  const del = planRemovePage(rows, 1, [], OPEN0);
  const mv = planReorderPage(rows, 4, 2, OPEN0);
  assert.ok(del.ok && mv.ok);
  const out = applyLikeTheWeb(['pg1', 'pg2', 'pg3', 'pg4', 'pg5'], [
    { id: 'p1', ...del.proposal },
    { id: 'p2', ...mv.proposal },
  ]);
  // Old page 4 sits just in front of old page 2, and old page 1 is gone.
  assert.deepEqual(out, ['pg4', 'pg2', 'pg3', 'pg5']);
});

test('planReorderPage refuses a destination past the end and a move onto itself', () => {
  const rows = magazine(3);
  const past = planReorderPage(rows, 1, 7, OPEN0);
  assert.ok(!past.ok && /the last position is 3/.test(past.error));
  const same = planReorderPage(rows, 2, 2, OPEN0);
  assert.ok(!same.ok && /already page 2/.test(same.error));
  assert.equal(planReorderPage(rows, 9, 1, OPEN0).ok, false);
});

test('planInsert: the end by default, past the end said honestly, the front only for a blank page', () => {
  assert.deepEqual(planInsert(10, undefined, { allowFront: false }), { ok: true, atIndex: undefined, where: ' (at the end)' });
  const front = planInsert(10, 1, { allowFront: false });
  assert.ok(!front.ok && /in front of the cover/.test(front.error));
  assert.deepEqual(planInsert(10, 1, { allowFront: true }), { ok: true, atIndex: 0, where: ' — becomes page 1 (later pages shift down)' });
  assert.equal((planInsert(10, 11, { allowFront: false }) as { atIndex?: number }).atIndex, 10);
  const far = planInsert(10, 40, { allowFront: false });
  assert.ok(far.ok && far.atIndex === undefined && /at the end \(the magazine has 10 pages, so there is no page 40 yet\)/.test(far.where));
});

test('pageBudgetRefusal counts what is already staged', () => {
  assert.equal(pageBudgetRefusal(10, [], 3, 20), null);
  const staged = [
    { id: 'a', kind: 'generate-pages', count: 4, summary: '' },
    { id: 'b', kind: 'add-page', summary: '' },
    { id: 'c', kind: 'remove-page', pageId: 'x', summary: '' },
  ] as AgentProposal[];
  // 10 - 1 + 5 = 14; adding 6 → 20 is fine, 7 is not.
  assert.equal(pageBudgetRefusal(10, staged, 6, 20), null);
  assert.match(pageBudgetRefusal(10, staged, 7, 20)!, /at most 20 pages, so only 6 more can be added/);
  assert.match(pageBudgetRefusal(20, [], 1, 20)!, /this one is full/);
});

// ── A layout rebuild is honest about the words (C09/C31) ───────────────────

test('rebuildNote: the page’s text is NOT kept, and it says so with the count', () => {
  const els = [
    text({ id: 'furniture-folio', role: 'caption', content: '12' }),
    text({ content: 'Real copy one' }),
    text({ content: 'Real copy two' }),
    text({ content: '   ' }),
    { ...text(), type: 'image', text: undefined } as MagazineElement,
  ];
  assert.equal(textBoxesWithWords(els), 2);
  const note = rebuildNote(2);
  assert.match(note, /The 2 text boxes on that page now are NOT kept/);
  assert.match(note, /NEWLY WRITTEN copy/);
  assert.match(note, /cannot be undone/);
  assert.match(note, /copy out any wording/);
  assert.doesNotMatch(note, /keeps the user/);
  assert.doesNotMatch(rebuildNote(0), /NOT kept/);
  assert.match(REBUILD_EFFECT, /photos are reused/);
});

// ── Documents (C12/C27/C14/C28) ────────────────────────────────────────────

test('documentRows: both stores, sources first, one row per name, and whether the words can be read', () => {
  const rows = documentRows(
    [
      { _id: 's1', originalName: 'Brochure.pdf', contentType: 'application/pdf', status: 'ready', coverage: { pagesTotal: 12 } },
      { _id: 's2', originalName: 'Notes.docx', contentType: 'application/msword', status: 'reading', coverage: null },
    ],
    [
      { _id: 'm1', kind: 'doc', originalName: 'brochure.pdf', contentType: 'application/pdf', sourceText: 'dup' },
      { _id: 'm2', kind: 'doc', originalName: 'Results.pdf', contentType: 'application/pdf', sourceText: 'Race 1 …' },
      { _id: 'm3', kind: 'doc', alt: 'Scan.pdf', contentType: 'application/pdf', sourceText: '  ' },
      { _id: 'm4', kind: 'photo', originalName: 'horse.jpg' },
    ],
  );
  assert.deepEqual(
    rows.map((r) => [r.docId, r.name, r.pages, r.canCopyLayout, r.hasText, r.from]),
    [
      ['s1', 'Brochure.pdf', 12, true, true, 'source'],
      ['s2', 'Notes.docx', 0, false, false, 'source'],
      ['m2', 'Results.pdf', 0, true, true, 'attached'],
      ['m3', 'Scan.pdf', 0, true, false, 'attached'],
    ],
  );
  assert.equal(documentRows([], Array.from({ length: 30 }, (_, i) => ({ _id: `d${i}`, kind: 'doc', originalName: `f${i}` }))).length, 20);
  assert.equal(sourceDocReadable('partial'), true);
  assert.equal(sourceDocReadable('queued'), false);
});

test('sourcePageRefusal: an uncounted document (pages 0) is never refused', () => {
  assert.equal(sourcePageRefusal({ name: 'A.pdf', pages: 0 }, 40), null);
  assert.equal(sourcePageRefusal({ name: 'A.pdf', pages: 4 }, 4), null);
  assert.match(sourcePageRefusal({ name: 'A.pdf', pages: 4 }, 5)!, /“A.pdf” has 4 pages, so there is no page 5/);
  assert.match(sourcePageRefusal({ name: 'A.pdf', pages: 4 }, 0)!, /start at 1/);
});

test('documentQuery: the model’s query, else the user’s words, else nothing', () => {
  assert.equal(documentQuery(' race   results ', 'ignored'), 'race results');
  assert.equal(documentQuery(undefined, 'now add the prize money from the PDF'), 'now add the prize money from the PDF');
  assert.equal(documentQuery('', '   '), undefined);
  assert.equal(documentQuery(42, undefined), undefined);
  assert.equal(documentQuery('x'.repeat(900), undefined)!.length, 600);
});

test('copy_document_page wording: what is copied, onto which page, and that it cannot be undone (C14)', () => {
  assert.equal(copyPageSummary('Brochure.pdf', 2), 'Copy page 2 of “Brochure.pdf” onto this page — its own text, pictures and colours replace what is there');
  assert.match(copyPageSummary('B.pdf', 5, { number: 4, name: 'page 4 (“Derby Day”)' }), /onto page 4 \(“Derby Day”\)/);
  assert.match(COPY_PAGE_NOTE, /cannot be undone/);
  assert.match(COPY_PAGE_NOTE, /PDF page’s shape/);
});

test('pagesFromDocuments mirrors the generate endpoint (C28)', () => {
  assert.deepEqual(pagesFromDocuments([]), { ok: true, note: '', use: [] });
  const reading = pagesFromDocuments([{ name: 'R.pdf', store: 'source', readable: false, reading: true }]);
  assert.ok(!reading.ok && /still being read/.test(reading.error));
  const scan = pagesFromDocuments([{ name: 'Scan.pdf', store: 'media', readable: false, reading: false }]);
  assert.ok(!scan.ok && /“Scan.pdf” has no readable text/.test(scan.error));
  // A source document and chat attachments together: the build uses the source only.
  const mixed = pagesFromDocuments([
    { name: 'Chat.pdf', store: 'media', readable: true, reading: false },
    { name: 'Source.pdf', store: 'source', readable: true, reading: false },
    { name: 'Scan.pdf', store: 'media', readable: false, reading: false },
  ]);
  assert.ok(mixed.ok);
  assert.deepEqual(mixed.use, [1]);
  assert.match(mixed.note, /“Chat.pdf”, “Scan.pdf”/);
  // Chat attachments only: every readable one is used, the scan is left out.
  const chats = pagesFromDocuments([
    { name: 'A.pdf', store: 'media', readable: true, reading: false },
    { name: 'Scan.pdf', store: 'media', readable: false, reading: false },
    { name: 'B.pdf', store: 'media', readable: true, reading: false },
  ]);
  assert.ok(chats.ok);
  assert.deepEqual(chats.use, [0, 2]);
  assert.match(chats.note, /“Scan.pdf”/);
  const clean = pagesFromDocuments([{ name: 'Chat.pdf', store: 'media', readable: true, reading: false }]);
  assert.deepEqual(clean, { ok: true, note: '', use: [0] });
});

test('generatePagesSummary names the documents the pages are written from', () => {
  assert.equal(generatePagesSummary({ count: 1, where: ' (at the end)' }), 'Design 1 new page (at the end)');
  assert.equal(
    generatePagesSummary({ count: 2, topic: 'Race day', where: ' — becomes page 3 (later pages shift down)', docNames: ['Results.pdf'] }),
    'Design 2 new pages on “Race day” from “Results.pdf” — becomes page 3 (later pages shift down)',
  );
});

// ── Changes an earlier turn staged (C05) ───────────────────────────────────

test('stagedSeq: past every proposal number, whatever the client tagged it with', () => {
  assert.equal(stagedSeq([]), 0);
  assert.equal(stagedSeq([{ id: 'p3' }, { id: 'p12', tempId: 'tmp_p11' }, { id: 't1700-p4' }, { id: 'odd' }]), 12);
  assert.equal(stagedSeq([{ id: 'x', tempId: 'tmp_p40' }]), 40);
});

test('replayStaged: updates, adds and deletes compose onto the page as loaded; the list comes back unchanged', () => {
  const head = text({ id: 'h1', role: 'headline', content: 'Old headline', fontSize: 48 });
  const body = text({ id: 'b1', content: 'Body' });
  const gone = text({ id: 'g1', content: 'Delete me' });
  const staged: StagedLike[] = [
    { id: 'p1', kind: 'update', elementId: 'h1', patch: { text: { color: '#cc0000' } }, summary: 'Made the headline red' },
    { id: 'p3', kind: 'add', tempId: 'tmp_p2', element: { type: 'shape', x: 0, y: 0, w: 200, h: 100, shape: { fill: '#000000' } }, summary: 'Added a shape' },
    { id: 'p4', kind: 'update', elementId: 'tmp_p2', patch: { x: 40 }, summary: 'Moved the new shape' },
    { id: 'p5', kind: 'delete', elementId: 'g1', summary: 'Deleted the note' },
    { id: 'p6', kind: 'remove-page', pageId: 'pg4', summary: 'Remove page 4' },
  ];
  const r = replayStaged([head, body, gone], staged, PAGE);
  assert.deepEqual(r.dropped, []);
  assert.deepEqual(r.proposals.map((p) => p.id), ['p1', 'p3', 'p4', 'p5', 'p6']);
  assert.equal(r.proposals[0], staged[0] as unknown, 'kept proposals are returned as sent');
  assert.equal(r.seq, 6);
  const byId = new Map(r.working.map((e) => [e.id, e]));
  assert.equal(byId.get('h1')!.text!.color, '#cc0000');
  assert.equal(byId.get('h1')!.text!.content, 'Old headline', 'a one-field patch keeps the rest');
  assert.equal(byId.get('tmp_p2')!.x, 40, 'an edit to a staged addition composes');
  assert.equal(byId.has('g1'), false);
  assert.equal(head.text!.color, '#111111', 'the loaded page is never mutated');
});

test('replayStaged drops what can no longer be applied, with the reason', () => {
  const locked = text({ id: 'L', locked: true });
  const r = replayStaged(
    [locked],
    [
      { id: 'p1', kind: 'update', elementId: 'missing', patch: { x: 1 }, summary: 'Nudged the caption' },
      { id: 'p2', kind: 'update', elementId: 'L', patch: { x: 1 }, summary: 'Moved the locked one' },
      { id: 'p3', kind: 'add', summary: 'Broken add' },
      { id: 'p4', kind: 'mystery', summary: 'Unknown kind' },
    ],
    PAGE,
  );
  assert.deepEqual(r.proposals, []);
  assert.deepEqual(
    r.dropped.map((d) => [d.id, d.reason]),
    [
      ['p1', 'its element is no longer on the page'],
      ['p2', 'that element has been locked since'],
      ['p3', 'it was incomplete'],
    ],
  );
  assert.equal(r.working.length, 1);
});

test('replayStaged: a whole-page change keeps the tray to itself', () => {
  const r = replayStaged(
    [text({ id: 'a' })],
    [
      { id: 'p1', kind: 'update', elementId: 'a', patch: { x: 5 }, summary: 'Nudge' },
      { id: 'p2', kind: 'apply-layout', summary: 'Rebuild this page', layoutReading: {} },
    ],
    PAGE,
  );
  assert.deepEqual(r.proposals.map((p) => p.id), ['p2']);
  assert.equal(r.dropped.length, 1);
  assert.match(r.dropped[0]!.reason, /layout rebuild is staged with it/);
  assert.equal(r.working[0]!.x, 100, 'the dropped edit is not shown as applied');
});

test('stagedPromptLines lists what is waiting, by id, and what could not be kept', () => {
  assert.deepEqual(stagedPromptLines([]), []);
  const lines = stagedPromptLines(
    [{ id: 'p1', summary: 'Made the headline bigger' }],
    [{ id: 'p2', summary: 'Moved the caption', reason: 'its element is no longer on the page' }],
  );
  const all = lines.join('\n');
  assert.match(all, /ALREADY STAGED/);
  assert.match(all, /- p1: Made the headline bigger/);
  assert.match(all, /never stage them again/);
  assert.match(all, /unstage_changes/);
  assert.match(all, /could NOT be kept/);
  assert.match(all, /“Moved the caption”: its element is no longer on the page/);
});

test('withoutStaged takes a change out, with the edits that depended on it, and rebuilds the page', () => {
  const head = text({ id: 'h1', content: 'Head' });
  const proposals = [
    { id: 'p1', kind: 'update', elementId: 'h1', patch: { text: { color: '#ff0000' } }, summary: 'Red headline' },
    { id: 'p3', kind: 'add', tempId: 'tmp_p2', element: { type: 'shape', x: 0, y: 0, w: 100, h: 100, shape: { fill: '#000000' } }, summary: 'Added a shape' },
    { id: 'p4', kind: 'update', elementId: 'tmp_p2', patch: { y: 20 }, summary: 'Moved the shape' },
  ] as AgentProposal[];
  const r = withoutStaged([head], proposals, ['p3', 'nope'], PAGE);
  assert.deepEqual(r.removed.map((p) => p.id), ['p3']);
  assert.deepEqual(r.alsoRemoved.map((p) => p.id), ['p4']);
  assert.deepEqual(r.proposals.map((p) => p.id), ['p1']);
  assert.deepEqual(r.unknown, ['nope']);
  assert.deepEqual(r.working.map((e) => e.id), ['h1']);
  assert.equal(r.working[0]!.text!.color, '#ff0000', 'what stays staged is still shown');
});


test('replayStaged keeps a staged background change as it was sent (it changes no element)', () => {
  const body = text({ id: 'b1', content: 'Body' });
  const staged: StagedLike[] = [
    { id: 'p1', kind: 'set-background', background: { type: 'color', value: '#112233' }, summary: 'Set the page background to #112233' },
    { id: 'p2', kind: 'update', elementId: 'b1', patch: { x: 40 }, summary: 'Moved the body' },
  ];
  const r = replayStaged([body], staged, PAGE);
  assert.deepEqual(r.dropped, []);
  assert.deepEqual(r.proposals.map((p) => p.id), ['p1', 'p2']);
  assert.equal(r.proposals[0], staged[0] as unknown);
});
