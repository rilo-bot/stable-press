// Run (from apps/web): npx tsx --test src/editor-v2/proposals.test.ts
// The pure decisions behind the Design Helper's staged changes (proposals.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentProposal, MagazineElement, PageCheck } from './model';
import {
  appliedMessage,
  checkErrors,
  inOrder,
  insertIndexFor,
  isExclusiveKind,
  isPageKind,
  listInWords,
  looksLikeGraphic,
  mergeTurnProposals,
  nameWords,
  pageHeadline,
  patchPaths,
  planPageSteps,
  problemsLabel,
  problemsTooltip,
  removalQuestion,
  reorderIndices,
  sameChangeKey,
  tagTurn,
  thumbOf,
  trayRows,
  uniqueIds,
  withoutSettled,
} from './proposals';

const upd = (id: string, elementId: string, patch: Partial<MagazineElement>, summary = `edit ${id}`): AgentProposal => ({
  id,
  kind: 'update',
  elementId,
  patch,
  summary,
});
const add = (id: string, tempId: string, summary = `add ${id}`): AgentProposal => ({
  id,
  kind: 'add',
  tempId,
  element: { type: 'text' },
  summary,
});

// ── mergeTurnProposals ──

test('nothing staged before: the tray is the new turn', () => {
  const next = [upd('p1', 'e1', { x: 10 })];
  const m = mergeTurnProposals({ prev: [], prevPageId: null, next, forPageId: 'A', turnTag: 't1' });
  assert.equal(m.mode, 'fresh');
  assert.deepEqual(m.proposals, next);
  assert.equal(m.pageId, 'A');
  const empty = mergeTurnProposals({ prev: [], prevPageId: null, next: [], forPageId: 'A', turnTag: 't1' });
  assert.equal(empty.pageId, null);
});

test('a question that stages nothing keeps the waiting changes (C05)', () => {
  const prev = [upd('p1', 'e1', { text: { fontSize: 60 } as never }, 'Bigger headline')];
  const m = mergeTurnProposals({ prev, prevPageId: 'A', next: [], forPageId: 'A', turnTag: 't2' });
  assert.equal(m.mode, 'kept');
  assert.deepEqual(m.proposals, prev);
  assert.equal(m.pageId, 'A');
  assert.equal(m.dropped, 0);
});

test('a server that replayed the waiting changes owns the combined list', () => {
  const prev = [upd('p1', 'e1', { x: 1 }, 'Bigger headline')];
  const next = [upd('p1', 'e1', { x: 1 }, 'Bigger headline'), upd('p2', 'e1', { text: { color: '#ff0000' } as never }, 'Red headline')];
  const m = mergeTurnProposals({ prev, prevPageId: 'A', next, forPageId: 'A', turnTag: 't2' });
  assert.equal(m.mode, 'server');
  assert.deepEqual(m.proposals.map((p) => p.id), ['p1', 'p2']);
});

test('the server flag wins, even when it dropped every earlier change', () => {
  const prev = [upd('p1', 'e1', { x: 1 })];
  const m = mergeTurnProposals({ prev, prevPageId: 'A', next: [], forPageId: 'A', serverMerged: true, turnTag: 't2' });
  assert.equal(m.mode, 'server');
  assert.deepEqual(m.proposals, []);
  assert.equal(m.pageId, null);
});

test('an older server: the new turn is appended, with its own ids and placeholders', () => {
  const prev = [upd('p1', 'e1', { x: 1 }, 'Move headline'), add('p2', 'tmp_p2', 'Add caption')];
  const next = [add('p1', 'tmp_p1', 'Add photo'), upd('p2', 'tmp_p1', { y: 5 }, 'Nudge the new photo'), upd('p3', 'e9', { y: 2 }, 'Move byline')];
  const m = mergeTurnProposals({ prev, prevPageId: 'A', next, forPageId: 'A', turnTag: 't2' });
  assert.equal(m.mode, 'appended');
  assert.deepEqual(m.proposals.map((p) => p.id), ['p1', 'p2', 't2-p1', 't2-p2', 't2-p3']);
  // The new turn's update still points at the new turn's own add…
  assert.equal(m.proposals[3]!.elementId, 't2-tmp_p1');
  assert.equal(m.proposals[2]!.tempId, 't2-tmp_p1');
  // …and the earlier add keeps its placeholder.
  assert.equal(m.proposals[1]!.tempId, 'tmp_p2');
  // ids are unique, so the tray's keys and the apply's placeholder map are safe.
  assert.equal(new Set(m.proposals.map((p) => p.id)).size, m.proposals.length);
});

test('a same-id collision with a DIFFERENT change is not mistaken for a replay', () => {
  const prev = [upd('p1', 'e1', { x: 1 }, 'Move headline')];
  const next = [upd('p1', 'e1', { text: { color: '#000000' } as never }, 'Recolour headline')];
  const m = mergeTurnProposals({ prev, prevPageId: 'A', next, forPageId: 'A', turnTag: 't2' });
  assert.equal(m.mode, 'appended');
  assert.equal(m.proposals.length, 2);
});

test('an earlier edit a newer one fully overrides is dropped when appending', () => {
  const prev = [
    upd('p1', 'e1', { text: { content: 'Old' } as never }, 'Rewrite headline'),
    upd('p2', 'e1', { text: { color: '#111111' } as never }, 'Darken headline'),
    upd('p3', 'e2', { x: 4 }, 'Move photo'),
  ];
  const next = [upd('p1', 'e1', { text: { content: 'New' } as never }, 'Rewrite headline again'), { id: 'p2', kind: 'delete', elementId: 'e2', summary: 'Remove photo' } as AgentProposal];
  const m = mergeTurnProposals({ prev, prevPageId: 'A', next, forPageId: 'A', turnTag: 't3' });
  // The colour change survives (a different path); the old rewrite and the move of a
  // photo that is now deleted do not.
  assert.deepEqual(m.proposals.map((p) => p.summary), ['Darken headline', 'Rewrite headline again', 'Remove photo']);
});

test('a page rebuild on either side replaces the tray, and says how many went', () => {
  const prev = [upd('p1', 'e1', { x: 1 })];
  const layout: AgentProposal = { id: 'p1', kind: 'apply-layout', summary: 'Rebuild this page' };
  const a = mergeTurnProposals({ prev, prevPageId: 'A', next: [layout], forPageId: 'A', turnTag: 't2' });
  assert.equal(a.mode, 'replaced');
  assert.equal(a.dropped, 1);
  assert.equal(a.droppedPageId, 'A');
  const copy: AgentProposal = { id: 'p1', kind: 'copy-document-page', docId: 'd1', sourcePage: 2, summary: 'Copy page 2' };
  const b = mergeTurnProposals({ prev: [copy], prevPageId: 'A', next: [upd('p1', 'e1', { x: 2 })], forPageId: 'A', turnTag: 't2' });
  assert.equal(b.mode, 'replaced');
  assert.equal(b.dropped, 1);
});

test('waiting changes for another page: kept on an empty turn, reported when replaced', () => {
  const prev = [upd('p1', 'e1', { x: 1 })];
  const kept = mergeTurnProposals({ prev, prevPageId: 'B', next: [], forPageId: 'A', turnTag: 't2' });
  assert.equal(kept.mode, 'kept');
  assert.equal(kept.pageId, 'B');
  const replaced = mergeTurnProposals({ prev, prevPageId: 'B', next: [upd('p1', 'e7', { y: 1 })], forPageId: 'A', turnTag: 't2' });
  assert.equal(replaced.mode, 'replaced');
  assert.equal(replaced.dropped, 1);
  assert.equal(replaced.droppedPageId, 'B');
  assert.equal(replaced.pageId, 'A');
});

test('changes applied while the turn ran are not offered again', () => {
  const a = upd('p1', 'e1', { x: 1 }, 'Move headline');
  const b = add('p2', 'tmp_p2', 'Add caption');
  const c = upd('p3', 'e5', { y: 1 }, 'Move photo');
  // Sent a and b; while the turn ran the user applied them (the tray is empty).
  assert.deepEqual(withoutSettled([a, b, c], [a, b], []), [c]);
  // Still waiting: kept.
  assert.deepEqual(withoutSettled([a, b, c], [a, b], [a, b]), [a, b, c]);
  // Nothing was sent: the reply is untouched.
  assert.deepEqual(withoutSettled([a, c], [], []), [a, c]);
});

test('patchPaths reads one level into sub-objects', () => {
  assert.deepEqual(patchPaths({ x: 1, text: { content: 'a', color: '#000000' } as never }), ['x', 'text.content', 'text.color']);
  assert.deepEqual(patchPaths(undefined), []);
});

test('tagTurn rewrites only the turn’s own placeholders', () => {
  const out = tagTurn([add('p1', 'tmp_p1'), upd('p2', 'tmp_p1', { x: 1 }), upd('p3', 'realId', { x: 2 })], 'tX');
  assert.equal(out[1]!.elementId, 'tX-tmp_p1');
  assert.equal(out[2]!.elementId, 'realId');
});

test('uniqueIds renames only later duplicates', () => {
  const out = uniqueIds([upd('p1', 'a', {}), upd('p1', 'b', {}), upd('p2', 'c', {})], 't');
  assert.deepEqual(out.map((p) => p.id), ['p1', 't-1-p1', 'p2']);
});

test('sameChangeKey tells a replayed change from a different one with the same id', () => {
  const a = upd('p1', 'e1', { x: 1 }, 'Move headline');
  assert.equal(sameChangeKey(a), sameChangeKey({ ...a, patch: { x: 1 } }));
  assert.notEqual(sameChangeKey(a), sameChangeKey({ ...a, summary: 'Recolour headline' }));
  assert.notEqual(sameChangeKey(a), sameChangeKey({ ...a, elementId: 'e2' }));
});

test('inOrder sorts by the page’s own index without touching the input', () => {
  const input = [{ id: 'b', index: 1 }, { id: 'a', index: 0 }];
  assert.deepEqual(inOrder(input).map((p) => p.id), ['a', 'b']);
  assert.deepEqual(input.map((p) => p.id), ['b', 'a']);
});

test('kind groups', () => {
  assert.equal(isExclusiveKind('apply-layout'), true);
  assert.equal(isExclusiveKind('copy-document-page'), true);
  assert.equal(isExclusiveKind('update'), false);
  assert.equal(isPageKind('remove-page'), true);
  assert.equal(isPageKind('copy-document-page'), false);
});

// ── planPageSteps / reorderIndices / insertIndexFor (C06) ──

const pages = ['P1', 'P2', 'P3', 'P4', 'P5'].map((id, index) => ({ id, index }));

test('"delete pages 3 and 4" deletes pages 3 and 4, not 3 and 5', () => {
  const props: AgentProposal[] = [
    { id: 'a', kind: 'remove-page', targetIndex: 2, summary: 'Remove page 3' },
    { id: 'b', kind: 'remove-page', targetIndex: 3, summary: 'Remove page 4' },
  ];
  const { steps } = planPageSteps(props, pages);
  assert.deepEqual(steps.map((s) => (s.op === 'remove' ? s.pageId : null)), ['P3', 'P4']);
});

test('ids win over numbers, and a page that is not there is a refusal', () => {
  const props: AgentProposal[] = [
    { id: 'a', kind: 'remove-page', pageId: 'P5', targetIndex: 0, summary: 'Remove page 5' },
    { id: 'b', kind: 'remove-page', pageId: 'GONE', summary: 'Remove page 9' },
  ];
  const { steps } = planPageSteps(props, pages);
  assert.deepEqual(steps.map((s) => (s.op === 'remove' ? s.pageId : 'x')), ['P5', null]);
});

test('a second delete of the same page is counted, not run', () => {
  const props: AgentProposal[] = [
    { id: 'a', kind: 'remove-page', pageId: 'P2', summary: 'Remove page 2' },
    { id: 'b', kind: 'remove-page', targetIndex: 1, summary: 'Remove page 2 again' },
  ];
  const { steps, duplicates } = planPageSteps(props, pages);
  assert.equal(steps.length, 1);
  assert.equal(duplicates, 1);
});

test('moves run first, then deletions, then new pages', () => {
  const props: AgentProposal[] = [
    { id: 'g', kind: 'generate-pages', count: 2, atIndex: 2, summary: 'Design 2 pages as page 3' },
    { id: 'r', kind: 'remove-page', pageId: 'P4', summary: 'Remove page 4' },
    { id: 'm', kind: 'reorder-page', pageId: 'P5', to: 1, summary: 'Move page 5 → 2' },
  ];
  const { steps } = planPageSteps(props, pages);
  assert.deepEqual(steps.map((s) => s.op), ['reorder', 'remove', 'generate-pages']);
  const gen = steps[2]!;
  assert.equal(gen.op === 'generate-pages' ? gen.beforePageId : 'x', 'P3');
});

test('a new page with no position goes at the end', () => {
  const { steps } = planPageSteps([{ id: 'a', kind: 'add-page', summary: 'Add a blank page' }], pages);
  assert.equal(steps[0]!.op === 'add-page' ? steps[0]!.beforePageId : 'x', undefined);
});

test('reorderIndices finds the page by id against the list as it is now', () => {
  const now = ['P1', 'P3', 'P5'];
  assert.deepEqual(reorderIndices({ id: 'm', kind: 'reorder-page', pageId: 'P5', to: 0, summary: '' }, now), { from: 2, to: 0 });
  // Destination clamped to the list; legacy proposals use their own `from`.
  assert.deepEqual(reorderIndices({ id: 'm', kind: 'reorder-page', from: 0, to: 9, summary: '' }, now), { from: 0, to: 2 });
  // Anchored destination.
  assert.deepEqual(reorderIndices({ id: 'm', kind: 'reorder-page', pageId: 'P1', toPageId: 'P5', summary: '' }, now), { from: 0, to: 2 });
  // Gone (a refusal), or already there (nothing to do).
  assert.equal(reorderIndices({ id: 'm', kind: 'reorder-page', pageId: 'P2', to: 0, summary: '' }, now), null);
  assert.equal(reorderIndices({ id: 'm', kind: 'reorder-page', pageId: 'P1', toPageId: 'GONE', summary: '' }, now), null);
  assert.equal(reorderIndices({ id: 'm', kind: 'reorder-page', pageId: 'P1', to: 0, summary: '' }, now), 'in-place');
});

test('insertIndexFor follows its anchor, and skips past a deleted one', () => {
  const original = ['P1', 'P2', 'P3', 'P4', 'P5'];
  assert.equal(insertIndexFor('P3', ['P1', 'P3', 'P4', 'P5'], original), 1);
  // P3 was deleted: in front of P4, the next page that still exists.
  assert.equal(insertIndexFor('P3', ['P1', 'P2', 'P4', 'P5'], original), 2);
  // Everything after it gone: at the end.
  assert.equal(insertIndexFor('P5', ['P1', 'P2'], original), undefined);
  assert.equal(insertIndexFor(undefined, ['P1'], original), undefined);
});

// ── words ──

const text = (content: string, role: string, fontSize: number): MagazineElement =>
  ({
    id: content,
    type: 'text',
    x: 0,
    y: 0,
    w: 10,
    h: 10,
    rotation: 0,
    zIndex: 0,
    locked: false,
    source: 'manual',
    text: { content, role, fontSize, fontFamily: 'Inter', fontWeight: 400, color: '#000000', align: 'left', lineHeight: 1.2, autoFit: 'shrink' },
  }) as MagazineElement;

test('pageHeadline prefers the largest headline and strips markup', () => {
  const els = [text('Body copy here', 'body', 16), text('Small <b>head</b>', 'headline', 30), text('The&nbsp;Big Day', 'headline', 80)];
  assert.equal(pageHeadline(els), 'The Big Day');
  assert.equal(pageHeadline([text('Only body text', 'body', 16)]), 'Only body text');
  assert.equal(pageHeadline([]), '');
  assert.equal(pageHeadline([text('A very long headline that goes on and on and on forever', 'headline', 40)], 20), 'A very long headlin…');
});

test('removalQuestion names every page and says it cannot be undone', () => {
  const q = removalQuestion([
    { number: 3, headline: 'Spring Sales' },
    { number: 4, headline: '' },
  ]);
  assert.match(q, /^Delete page 3 \(“Spring Sales”\) and page 4\?/);
  assert.match(q, /cannot be brought back with undo/);
  assert.equal(listInWords(['a', 'b', 'c']), 'a, b and c');
});

test('appliedMessage promises undo only for what undo covers', () => {
  assert.match(appliedMessage(3, 0), /Undo with Ctrl\+Z/);
  assert.doesNotMatch(appliedMessage(0, 2), /Ctrl\+Z/);
  assert.match(appliedMessage(2, 1), /page changes stay/);
});

test('problem chip words and tooltip', () => {
  const check: PageCheck = {
    measuredBy: 'estimate',
    ok: false,
    summary: '',
    issues: [
      { kind: 'text-clipped', severity: 'error', label: 'body “Hello”', detail: 'needs 412px, box is 260px', fix: '' },
      { kind: 'tiny-text', severity: 'warning', label: 'caption', detail: '10px', fix: '' },
      { kind: 'image-empty', severity: 'error', label: 'photo', detail: 'no picture', fix: '' },
    ],
  };
  const errs = checkErrors(check);
  assert.equal(errs.length, 2);
  assert.equal(problemsLabel(1, false), '1 problem after these changes');
  assert.equal(problemsLabel(2, true), '2 problems on this page');
  assert.equal(problemsTooltip(errs, 1), '• body “Hello”: needs 412px, box is 260px\n…and 1 more');
  assert.deepEqual(checkErrors(null), []);
});

// ── The tray's rows ──

test('trayRows shows one tool call as one row, under its group label', () => {
  const group = 'Clear the page: remove 3 elements';
  const del = (id: string, what: string, extra: Partial<AgentProposal> = {}): AgentProposal => ({
    id,
    kind: 'delete',
    elementId: `e-${id}`,
    summary: `${group} (the ${what})`,
    group,
    ...extra,
  });
  const rows = trayRows([del('p1', 'headline'), del('p2', 'photo'), upd('p3', 'e9', { x: 1 }, 'Moved the caption'), del('p4', 'byline')]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.label, group);
  assert.equal(rows[0]!.n, 3);
  assert.equal(rows[1]!.label, undefined);
  assert.equal(rows[1]!.p.summary, 'Moved the caption');
  // A member with a warning keeps its own row, so the warning is seen.
  const warned = trayRows([del('p1', 'headline'), del('p2', 'photo', { warning: 'This is the only photo.' })]);
  assert.equal(warned.length, 2);
  assert.equal(warned[1]!.p.warning, 'This is the only photo.');
});

test('trayRows still folds identical ungrouped changes with a count, but never pictures', () => {
  const same = (id: string): AgentProposal => ({ id, kind: 'delete', elementId: `e-${id}`, summary: 'Removed an element' });
  const rows = trayRows([same('a'), same('b'), same('c')]);
  assert.deepEqual(rows.map((r) => [r.n, r.label]), [[3, undefined]]);
  const pic = (id: string): AgentProposal => ({
    id,
    kind: 'add',
    tempId: `t-${id}`,
    summary: 'Added a photo',
    element: { type: 'image', image: { url: `https://cdn.example/${id}.jpg`, assetId: id, alt: '', fit: 'cover' } },
  });
  assert.equal(trayRows([pic('a'), pic('b')]).length, 2);
});

test('thumbOf draws a placed picture the way the page will', () => {
  const chart: AgentProposal = {
    id: 'c',
    kind: 'add',
    summary: 'Added a bar chart',
    element: { type: 'image', image: { url: 'https://cdn.example/c.png', assetId: 'c', alt: 'Bar chart', fit: 'contain' } },
  };
  assert.deepEqual(thumbOf(chart), { url: 'https://cdn.example/c.png', contain: true });
  const bg: AgentProposal = { id: 'b', kind: 'set-background', summary: 'Background', background: { type: 'image', value: '/api/media/x.jpg' } };
  assert.deepEqual(thumbOf(bg), { url: '/api/media/x.jpg', contain: false });
  // Anything that is not a web url (a data: url, a bare id) gets no thumbnail.
  const odd: AgentProposal = { id: 'o', kind: 'add', summary: 'x', element: { type: 'image', image: { url: 'data:image/png;base64,AAAA', assetId: '', alt: '', fit: 'cover' } } };
  assert.equal(thumbOf(odd), undefined);
});

// ── looksLikeGraphic (C39) ──

test('graphic names are matched as whole words', () => {
  assert.equal(looksLikeGraphic('sales-chart.png', false), true);
  assert.equal(looksLikeGraphic('ClientLogo.png', false), true);
  assert.equal(looksLikeGraphic('Screen Shot 2026-11-15 at 10.02.png', false), true);
  assert.equal(looksLikeGraphic('screenshot.png', false), true);
  assert.equal(looksLikeGraphic('photograph.jpg', false), false);
  assert.equal(looksLikeGraphic('charter-boat.jpg', false), false);
  assert.equal(looksLikeGraphic('dining-table.jpg', false), false);
  assert.equal(looksLikeGraphic('horse.jpg', true), true);
  assert.deepEqual(nameWords('RaceDay_Results-2026.final.PNG'), ['race', 'day', 'results', '2026', 'final']);
});
