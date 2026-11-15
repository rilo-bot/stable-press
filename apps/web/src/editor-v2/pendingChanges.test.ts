// Run (from apps/web): npx tsx --test src/editor-v2/pendingChanges.test.ts
// Staged Design Helper changes kept per page until Apply (pendingChanges.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentProposal, MagazineElement } from './model';
import {
  accumulateTurn,
  applyOutcome,
  applyReportLine,
  changeCount,
  claimsChange,
  foldChanges,
  hasStagedLine,
  holdStaleTextChanges,
  MAX_SENT_PER_TURN,
  orphanPageIds,
  pagesPhrase,
  parsePending,
  PENDING_MAX_AGE_MS,
  pendingFor,
  pendingStorageKey,
  pendingTotal,
  rebaseForReplace,
  serializePending,
  STALE_WARNING,
  stagedLine,
  stripPaths,
  summarizeChanges,
  trayFor,
  waitingBarText,
  waitingPages,
  withoutPages,
  withPage,
  type PageApplyReport,
  type PendingByPage,
} from './pendingChanges';

const upd = (id: string, elementId: string, patch: Partial<MagazineElement>, summary = `edit ${id}`): AgentProposal => ({
  id,
  kind: 'update',
  elementId,
  patch,
  summary,
});
const del = (id: string, elementId: string, summary = `delete ${elementId}`): AgentProposal => ({ id, kind: 'delete', elementId, summary });
const add = (id: string, tempId: string, summary = `add ${id}`): AgentProposal => ({
  id,
  kind: 'add',
  tempId,
  element: { type: 'text' },
  summary,
});
const bg = (id: string, value: string): AgentProposal => ({
  id,
  kind: 'set-background',
  background: { type: 'color', value },
  summary: `background ${value}`,
});
const text = (o: Record<string, unknown>) => ({ text: o }) as unknown as Partial<MagazineElement>;

const PAGES = [
  { id: 'p7', index: 6 },
  { id: 'p3', index: 2 },
  { id: 'p9', index: 8 },
  { id: 'p8', index: 7 },
];

// ── the map ──────────────────────────────────────────────────────────────────

test('withPage replaces one page and an empty list removes the key', () => {
  const m1 = withPage({}, 'p7', [del('a', 'e1')]);
  assert.deepEqual(Object.keys(m1), ['p7']);
  const m2 = withPage(m1, 'p8', [del('b', 'e2')]);
  assert.deepEqual(Object.keys(m2).sort(), ['p7', 'p8']);
  // page 7 untouched by page 8's write
  assert.equal(m2.p7, m1.p7);
  const m3 = withPage(m2, 'p7', []);
  assert.deepEqual(Object.keys(m3), ['p8']);
  // nothing to remove: same object back (the store can skip the update)
  assert.equal(withPage(m3, 'zz', []), m3);
  assert.equal(pendingTotal(m2), 2);
  assert.deepEqual(Object.keys(withoutPages(m2, ['p7', 'p8'])), []);
});

test('trayFor mirrors only the open page', () => {
  const m = withPage(withPage({}, 'p7', [del('a', 'e1')]), 'p8', [del('b', 'e2'), del('c', 'e3')]);
  assert.deepEqual(trayFor(m, 'p8').proposals.map((p) => p.id), ['b', 'c']);
  assert.equal(trayFor(m, 'p8').proposalsPageId, 'p8');
  assert.deepEqual(trayFor(m, 'p3'), { proposals: [], proposalsPageId: null });
  assert.deepEqual(trayFor(m, null), { proposals: [], proposalsPageId: null });
  assert.equal(pendingFor(m, 'nope').length, 0);
});

// ── folding: dedupe the same element + field ─────────────────────────────────

test('a later update of the same field replaces the earlier one', () => {
  const out = foldChanges([upd('1', 'e1', text({ fontSize: 20 })), upd('2', 'e1', text({ fontSize: 18 }))]);
  assert.deepEqual(out.map((p) => p.id), ['2']);
});

test('only the overlapping fields are taken out of the earlier update', () => {
  const out = foldChanges([upd('1', 'e1', { ...text({ fontSize: 20, color: '#111111' }), h: 220 }), upd('2', 'e1', text({ fontSize: 18 }))]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0]!.patch, { text: { color: '#111111' }, h: 220 });
  assert.deepEqual(out[1]!.patch, { text: { fontSize: 18 } });
});

test('updates of different elements, or different fields, all stay', () => {
  const list = [upd('1', 'e1', text({ content: 'A' })), upd('2', 'e2', text({ content: 'B' })), upd('3', 'e1', { x: 10 })];
  assert.deepEqual(foldChanges(list).map((p) => p.id), ['1', '2', '3']);
});

test('a later delete drops the earlier updates of that element', () => {
  assert.deepEqual(foldChanges([upd('1', 'e1', { x: 1 }), del('2', 'e1')]).map((p) => p.id), ['2']);
});

test('an element added and then deleted before Apply was never there', () => {
  const out = foldChanges([add('1', 'tmp_1'), upd('2', 'tmp_1', { x: 5 }), del('3', 'tmp_1'), del('4', 'e9')]);
  assert.deepEqual(out.map((p) => p.id), ['4']);
});

test('only the last background change is kept, and a repeated id is kept once', () => {
  const out = foldChanges([bg('1', '#ffffff'), del('2', 'e1'), bg('3', '#000000'), del('2', 'e1')]);
  assert.deepEqual(out.map((p) => p.id), ['2', '3']);
});

test('stripPaths never mutates and drops emptied sub-objects', () => {
  const patch = { text: { fontSize: 20 }, x: 4 } as unknown as Partial<MagazineElement>;
  const out = stripPaths(patch, new Set(['text.fontSize']));
  assert.deepEqual(out, { x: 4 });
  assert.deepEqual(patch, { text: { fontSize: 20 }, x: 4 });
});

// ── accumulate across messages and pages ─────────────────────────────────────

test('a second message on the same page ADDS to what is waiting (older server: appended)', () => {
  const first = accumulateTurn({ map: {}, pageId: 'p3', sent: [], reply: [upd('p1', 'title', text({ content: 'New title' }))], turnTag: 't1' });
  assert.equal(first.added.length, 1);
  const second = accumulateTurn({
    map: first.map,
    pageId: 'p3',
    sent: pendingFor(first.map, 'p3'),
    reply: [upd('p1', 'body1', text({ content: 'Body one' }))],
    turnTag: 't2',
  });
  assert.equal(second.mode, 'appended');
  assert.equal(second.onPage.length, 2, 'the title change survived the second message');
  assert.equal(second.added.length, 1);
  // ids stay unique even though both turns numbered from p1
  assert.equal(new Set(second.onPage.map((p) => p.id)).size, 2);
});

test('a question that stages nothing keeps every waiting change', () => {
  const map = withPage({}, 'p3', [upd('a', 'e1', { x: 1 })]);
  const r = accumulateTurn({ map, pageId: 'p3', sent: pendingFor(map, 'p3'), reply: [], turnTag: 't' });
  assert.equal(r.mode, 'kept');
  assert.equal(r.onPage.length, 1);
  assert.equal(r.added.length, 0);
});

test('a server that replays returns the combined set; nothing is counted twice', () => {
  const waiting = [upd('a', 'e1', { x: 1 })];
  const map = withPage({}, 'p3', waiting);
  const r = accumulateTurn({ map, pageId: 'p3', sent: waiting, reply: [...waiting, upd('p2', 'e2', { y: 2 })], serverMerged: true, turnTag: 't' });
  assert.equal(r.mode, 'server');
  assert.deepEqual(r.onPage.map((p) => p.id), ['a', 'p2']);
  assert.deepEqual(r.added.map((p) => p.id), ['p2']);
});

test('a turn on page 8 never touches what waits on page 7', () => {
  const map = withPage({}, 'p7', [del('a', 'e1'), del('b', 'e2')]);
  const r = accumulateTurn({ map, pageId: 'p8', sent: [], reply: [del('p1', 'x1')], turnTag: 't' });
  assert.equal(r.map.p7, map.p7);
  assert.equal(r.map.p8!.length, 1);
  assert.equal(pendingTotal(r.map), 3);
});

test('a later edit of the same field in a later message replaces the earlier one', () => {
  const map = withPage({}, 'p3', [upd('t1-p1', 'body1', text({ fontSize: 20 }))]);
  const r = accumulateTurn({ map, pageId: 'p3', sent: pendingFor(map, 'p3'), reply: [upd('p1', 'body1', text({ fontSize: 18 }))], turnTag: 't2' });
  assert.equal(r.onPage.length, 1);
  assert.deepEqual(r.onPage[0]!.patch, { text: { fontSize: 18 } });
});

test('a change a replaying server leaves out is named, not lost; a replaced one is not', () => {
  const background = bg('a', '#f5edda');
  const size = upd('b', 'body1', text({ fontSize: 20 }));
  const keep = upd('c', 'body2', { x: 5 });
  const waiting = [background, size, keep];
  const map = withPage({}, 'p3', waiting);
  // The server echoes `keep`, replaces `size` with a newer size, and does not know
  // the background kind at all.
  const reply = [keep, upd('p1', 'body1', text({ fontSize: 18 }))];
  const r = accumulateTurn({ map, pageId: 'p3', sent: waiting, reply, serverMerged: true, turnTag: 't' });
  assert.equal(r.mode, 'server');
  assert.deepEqual(r.droppedList.map((p) => p.id), ['a']);
  assert.equal(r.dropped, 1);
  assert.deepEqual(r.onPage.map((p) => p.id), ['c', 'p1']);
});

test('a page rebuild staged after edits keeps the edits waiting too (nothing goes unasked)', () => {
  const map = withPage({}, 'p3', [upd('a', 'e1', { x: 1 })]);
  const rebuild: AgentProposal = { id: 'p1', kind: 'apply-layout', summary: 'Rebuild in the attached layout', layoutReading: {} };
  const r = accumulateTurn({ map, pageId: 'p3', sent: [], reply: [rebuild], turnTag: 't9' });
  assert.equal(r.dropped, 0);
  assert.equal(r.onPage.length, 2);
  assert.deepEqual(r.added.map((p) => p.kind), ['apply-layout']);
});

test('changes applied while the turn ran do not come back in its reply', () => {
  const sent = [upd('a', 'e1', { x: 1 })];
  // applied meanwhile: nothing waiting any more
  const r = accumulateTurn({ map: {}, pageId: 'p3', sent, reply: [...sent, upd('p2', 'e2', { y: 2 })], serverMerged: true, turnTag: 't' });
  assert.deepEqual(r.onPage.map((p) => p.id), ['p2']);
});

// ── the client's own history (2026-11-15) ────────────────────────────────────

test('clearing pages 7 to 10 one message per page keeps every page’s removals', () => {
  const pages = [7, 8, 9, 10].map((n) => ({ id: `pg${n}`, index: n - 1 }));
  let map: PendingByPage = {};
  for (const p of pages) {
    // each turn: "remove every element on this page" → one delete per element
    const reply = ['a', 'b', 'c'].map((e, i) => del(`p${i + 1}`, `${p.id}-${e}`, 'Removed an element'));
    map = accumulateTurn({ map, pageId: p.id, sent: pendingFor(map, p.id), reply, turnTag: `t${p.index}` }).map;
  }
  const w = waitingPages(map, pages);
  assert.deepEqual(w.map((x) => x.page), [7, 8, 9, 10], 'no page lost its set to the next message');
  assert.equal(pendingTotal(map), 12);
  assert.equal(waitingBarText(w), '12 changes waiting on pages 7, 8, 9, 10');
});

test('rewriting page 3 one body box per message keeps every box’s new text', () => {
  let map: PendingByPage = {};
  const boxes = ['body1', 'body2', 'body3', 'body4'];
  boxes.forEach((id, i) => {
    const reply = [upd('p1', id, text({ content: `New text ${i + 1}` }), `Set the text of ${id}`)];
    map = accumulateTurn({ map, pageId: 'p3', sent: pendingFor(map, 'p3'), reply, turnTag: `t${i}` }).map;
  });
  const onPage = pendingFor(map, 'p3');
  assert.equal(onPage.length, 4);
  assert.deepEqual(onPage.map((p) => p.elementId), boxes);
});

// ── apply order ──────────────────────────────────────────────────────────────

test('waitingPages lists pages in page order, not insertion order, and skips gone pages', () => {
  let map: PendingByPage = {};
  map = withPage(map, 'p9', [del('a', 'e1')]);
  map = withPage(map, 'gone', [del('b', 'e2')]);
  map = withPage(map, 'p7', [del('c', 'e3'), del('d', 'e4')]);
  map = withPage(map, 'p8', [del('e', 'e5')]);
  const w = waitingPages(map, PAGES);
  assert.deepEqual(w.map((x) => x.page), [7, 8, 9]);
  assert.deepEqual(w.map((x) => x.pageId), ['p7', 'p8', 'p9']);
  assert.deepEqual(orphanPageIds(map, PAGES), ['gone']);
  assert.equal(waitingBarText(w), '4 changes waiting on pages 7, 8, 9');
});

// ── survives a reload ────────────────────────────────────────────────────────

test('serialize → parse round-trips the per-page map (the reload shape)', () => {
  const map = withPage(withPage({}, 'p7', [del('a', 'e1')]), 'p3', [upd('b', 'e2', text({ content: 'Hi' })), bg('c', '#ffffff')]);
  const now = Date.UTC(2026, 10, 15);
  const raw = serializePending(map, now);
  assert.ok(raw);
  const back = parsePending(raw, { now: now + 1000 });
  assert.deepEqual(back, map);
  assert.equal(pendingStorageKey('abc'), 'mag2.pending.v1:abc');
});

test('nothing waiting is stored as nothing (the key is removed)', () => {
  assert.equal(serializePending({}, 1), null);
});

test('parse drops broken, foreign-version, stale and unknown-page entries without throwing', () => {
  const now = Date.UTC(2026, 10, 15);
  assert.deepEqual(parsePending(null, { now }), {});
  assert.deepEqual(parsePending('{not json', { now }), {});
  assert.deepEqual(parsePending(JSON.stringify({ v: 99, savedAt: now, pages: { p7: [del('a', 'e1')] } }), { now }), {});
  const old = JSON.stringify({ v: 1, savedAt: now - PENDING_MAX_AGE_MS - 1, pages: { p7: [del('a', 'e1')] } });
  assert.deepEqual(parsePending(old, { now }), {});
  const mixed = JSON.stringify({
    v: 1,
    savedAt: now,
    pages: {
      p7: [del('a', 'e1'), { id: 'x', kind: 'explode', summary: 'bad' }, { id: 'y', kind: 'update', summary: 'no patch', elementId: 'e' }],
      p8: [del('b', 'e2')],
      gone: [del('c', 'e3')],
      p9: 'not a list',
    },
  });
  const back = parsePending(mixed, { now, knownPageIds: ['p7', 'p8', 'p9'] });
  assert.deepEqual(Object.keys(back).sort(), ['p7', 'p8']);
  assert.deepEqual(back.p7!.map((p) => p.id), ['a']);
});

// ── words ────────────────────────────────────────────────────────────────────

test('summaries group identical lines (a clear-the-page turn reads as one thing)', () => {
  const list = [del('1', 'a', 'Removed an element'), del('2', 'b', 'Removed an element'), del('3', 'c', 'Removed an element'), upd('4', 'd', { x: 1 }, 'Moved the photo')];
  assert.equal(summarizeChanges(list), 'Removed an element ×3; Moved the photo');
  const many = ['A', 'B', 'C', 'D', 'E'].map((s, i) => upd(String(i), `e${i}`, { x: i }, s));
  assert.equal(summarizeChanges(many), 'A; B; C; and 2 more');
  // One tool call's changes (a shared group) are named once, by the group's own label.
  const cleared = ['headline', 'photo', 'byline'].map((w, i) => ({
    ...del(`c${i}`, `x${i}`),
    summary: `Clear the page: remove 3 elements (the ${w})`,
    group: 'Clear the page: remove 3 elements',
  }));
  assert.equal(summarizeChanges([...cleared, upd('m', 'e9', { x: 1 }, 'Moved the photo')]), 'Clear the page: remove 3 elements; Moved the photo');
  assert.equal(summarizeChanges([upd('a', 'e1', { x: 1 }, 'A'), ...cleared], 1), 'A; and 1 more');
  assert.equal(changeCount(1), '1 change');
  assert.equal(pagesPhrase([9, 7]), 'pages 7, 9');
});

test('the line under a reply comes from the proposals, never the reply', () => {
  const added = [upd('1', 'b1', text({ fontSize: 20 }), 'Set body text to 20px'), upd('2', 'b2', { h: 220 }, 'Resized a box')];
  const line = stagedLine({ added, pageNumber: 3, onPage: 2, others: [], claimed: true });
  assert.equal(line, 'Waiting for Apply: 2 changes on page 3 — Set body text to 20px; Resized a box.');
  const others = waitingPages(withPage({}, 'p7', [del('a', 'e1')]), PAGES);
  assert.match(stagedLine({ added, pageNumber: 3, onPage: 5, others, claimed: false }), /\(5 in all on this page\.\) Also waiting: 1 change on page 7\.$/);
  // the 2026-11-15 incident: the reply claimed the change, no tool was called
  assert.equal(
    stagedLine({ added: [], pageNumber: 3, onPage: 0, others: [], claimed: true }),
    'Nothing was changed — no change was staged, whatever the reply above says.',
  );
  assert.equal(
    stagedLine({ added: [], pageNumber: 3, onPage: 3, others: [], claimed: false }),
    'Nothing was changed. 3 earlier changes on this page are still waiting for Apply.',
  );
});

test('claimsChange reads claims of done work, not denials', () => {
  assert.equal(claimsChange("I've staged the change for you to review. All six paragraphs are 20px."), true);
  assert.equal(claimsChange('I set the headline to red.'), true);
  assert.equal(claimsChange('The six boxes are now 220px tall.'), true);
  assert.equal(claimsChange("I need to correct my last reply. I didn't actually stage the change. Nothing on the page has changed."), false);
  assert.equal(claimsChange("I can't change the background from here."), false);
  assert.equal(claimsChange('Page 5 has four images: two charts and two photos.'), false);
  assert.equal(claimsChange("I'll make it red if you like."), false);
});

test('hasStagedLine spots a reply that already carries the line', () => {
  assert.equal(hasStagedLine('Done.\n\nWaiting for Apply: 2 changes on page 3 — x.'), true);
  assert.equal(hasStagedLine('Nothing was changed.'), true);
  assert.equal(hasStagedLine('I made the headline bigger.'), false);
});

// ── apply reports ────────────────────────────────────────────────────────────

const rep = (o: Partial<PageApplyReport> & { page: number }): PageApplyReport => ({
  pageId: `p${o.page}`,
  applied: 0,
  refused: 0,
  waiting: 0,
  elementWrites: 0,
  pageOps: 0,
  ...o,
});

test('the apply line names every page, in order, with what landed and what did not', () => {
  const line = applyReportLine([rep({ page: 7, applied: 6 }), rep({ page: 8, applied: 1, refused: 2 }), rep({ page: 9, applied: 3 })]);
  assert.equal(line, 'Applied 6 changes on page 7, 1 on page 8 and 3 on page 9. Page 8: 2 refused.');
  assert.equal(applyOutcome([rep({ page: 7, applied: 6 })]), 'all');
  assert.equal(applyOutcome([rep({ page: 7, applied: 6 }), rep({ page: 8, refused: 1 })]), 'partial');
  assert.equal(applyOutcome([rep({ page: 8, refused: 1 })]), 'none');
  assert.match(applyReportLine([rep({ page: 4, declined: true, waiting: 2 })]), /Page 4: you said no/);
  assert.equal(applyReportLine([]), 'Nothing was waiting to apply.');
});

// ── more than the server replays: nothing unsent is lost ─────────────────────

test('clearing a 60-box page, then one more message: every delete is still waiting', () => {
  // "Clear this page" on a copied PDF page: one delete per box, 60 of them.
  const deletes = Array.from({ length: 60 }, (_, i) => del(`c${i}`, `box${i}`));
  let map: PendingByPage = accumulateTurn({ map: {}, pageId: 'p7', sent: [], reply: deletes, turnTag: 't1' }).map;
  assert.equal(pendingFor(map, 'p7').length, 60);
  // The next turn is SENT only the first MAX_SENT_PER_TURN (50); a replaying server
  // hands back those 50 plus its own change, and says it merged.
  const sent = pendingFor(map, 'p7').slice(0, MAX_SENT_PER_TURN);
  const white = bg('p1', '#ffffff');
  const r = accumulateTurn({ map, pageId: 'p7', sent, reply: [...sent, white], serverMerged: true, turnTag: 't2' });
  map = r.map;
  const onPage = pendingFor(map, 'p7');
  assert.equal(onPage.length, 61, 'all 60 deletes and the background');
  assert.equal(onPage.filter((p) => p.kind === 'delete').length, 60);
  assert.equal(r.dropped, 0);
  assert.deepEqual(r.added.map((p) => p.kind), ['set-background']);
  // The unsent deletes sit after the replayed ones and before the new change.
  assert.equal(onPage[50]!.elementId, 'box50');
  assert.equal(onPage[60]!.kind, 'set-background');
});

test('a kept change whose placeholder the server reused is renamed with its references', () => {
  const waiting = [...Array.from({ length: 50 }, (_, i) => del(`d${i}`, `x${i}`)), add('a1', 'tmp_p1'), upd('u1', 'tmp_p1', { y: 5 })];
  const map: PendingByPage = { p3: waiting };
  const sent = waiting.slice(0, 50);
  const r = accumulateTurn({ map, pageId: 'p3', sent, reply: [...sent, add('a1', 'tmp_p1', 'a new box')], serverMerged: true, turnTag: 't5' });
  const list = pendingFor(r.map, 'p3');
  const temps = list.filter((p) => p.kind === 'add').map((p) => p.tempId);
  assert.equal(new Set(temps).size, 2, 'two adds, two placeholders');
  const kept = list.find((p) => p.kind === 'add' && p.tempId !== 'tmp_p1')!;
  assert.equal(list.find((p) => p.kind === 'update')!.elementId, kept.tempId, 'the kept update still names the kept add');
  assert.equal(new Set(list.map((p) => p.id)).size, list.length, 'ids stay unique');
});

// ── a text edit and the words it was staged against ──────────────────────────

const box = (id: string, content: string) => ({ id, type: 'text', text: { content } }) as unknown as MagazineElement;

test('a new text edit is stamped with the words of its box, and the stamp survives a replay', () => {
  const els = [box('body', 'Old <b>words</b> here')];
  const r1 = accumulateTurn({ map: {}, pageId: 'p3', sent: [], reply: [upd('p1', 'body', text({ content: 'New words' }))], turnTag: 't1', elements: els });
  const staged = pendingFor(r1.map, 'p3')[0]!;
  assert.equal(staged.baseText, 'Old words here');
  // The server rebuilds what it replays from the fields it knows: no baseText, no warning.
  const echoed = { ...staged, baseText: undefined, warning: undefined };
  const marked = { ...staged, warning: 'heads up' };
  const r2 = accumulateTurn({
    map: { p3: [marked] },
    pageId: 'p3',
    sent: [marked],
    reply: [echoed, upd('p2', 'body', { x: 4 })],
    serverMerged: true,
    turnTag: 't2',
    elements: [box('body', 'Typed since')],
  });
  const kept = pendingFor(r2.map, 'p3').find((p) => p.id === staged.id)!;
  assert.equal(kept.baseText, 'Old words here', 'the original stamp, not the words now');
  assert.equal(kept.warning, 'heads up');
  // A move is not a text edit: no stamp.
  assert.equal(pendingFor(r2.map, 'p3').find((p) => p.id !== staged.id)!.baseText, undefined);
});

test('a fit warning the server took off a replayed change is not put back', () => {
  const els = [box('body', 'Old words')];
  const r1 = accumulateTurn({ map: {}, pageId: 'p3', sent: [], reply: [upd('p1', 'body', text({ content: 'Much longer words' }))], turnTag: 't1', elements: els });
  const staged = { ...pendingFor(r1.map, 'p3')[0]!, warning: 'Will not fit its box: needs 412px, box is 300px.' };
  // The next turn grew the box, so the server echoes the change without its fit sentence.
  const echoed = { ...staged, baseText: undefined, warning: undefined };
  const r2 = accumulateTurn({
    map: { p3: [staged] },
    pageId: 'p3',
    sent: [staged],
    reply: [echoed, upd('p2', 'body', { h: 420 })],
    serverMerged: true,
    turnTag: 't2',
    elements: els,
  });
  assert.equal(pendingFor(r2.map, 'p3').find((p) => p.id === staged.id)!.warning, undefined);
});

test('Apply holds a text edit whose box was edited since staging, and only that', () => {
  const edit = { ...upd('p1', 'body', text({ content: 'AI rewrite' })), baseText: 'Original copy' };
  const same = { ...upd('p2', 'title', text({ content: 'New title' })), baseText: 'Old  title' };
  const move = { ...upd('p3', 'body', { x: 10 }), baseText: 'whatever' };
  const r = holdStaleTextChanges([edit, same, move], [box('body', 'Original copy, typed into'), box('title', 'Old\ntitle')]);
  assert.deepEqual(r.apply.map((p) => p.id), ['p2', 'p3']);
  assert.equal(r.held.length, 1);
  assert.equal(r.held[0]!.warning, STALE_WARNING);
  assert.equal(r.held[0]!.baseText, 'Original copy, typed into', 're-stamped: a second Apply uses it');
  assert.deepEqual(holdStaleTextChanges(r.held, [box('body', 'Original copy, typed into')]).held, []);
  // No stamp (an older client's change) or an unknown box: applied as before.
  assert.equal(holdStaleTextChanges([upd('p4', 'body', text({ content: 'x' }))], [box('body', 'y')]).held.length, 0);
});

test('the apply line says why a held change was not applied', () => {
  const line = applyReportLine([rep({ page: 3, applied: 2, waiting: 1, stale: 1 })]);
  assert.match(line, /Page 3: 1 change not applied — its box was edited after it was staged/);
  assert.doesNotMatch(line, /still waiting\.$/);
  assert.equal(applyOutcome([rep({ page: 3, applied: 2, waiting: 1, stale: 1 })]), 'partial');
});

// ── a magazine-wide replace rebases what is waiting ──────────────────────────

test('rebaseForReplace swaps the word in staged content, added boxes and the stamp', () => {
  const edit = { ...upd('p1', 'body', text({ content: 'Welcome to <b>NZTROF</b>.', color: '#111111' })), baseText: 'Welcome to NZTROF' };
  const added: AgentProposal = {
    id: 'p2',
    kind: 'add',
    tempId: 'tmp_p2',
    element: { type: 'text', text: { content: 'NZTROF owners' } } as unknown as Partial<MagazineElement>,
    summary: 'add',
  };
  const other = upd('p3', 'photo', { x: 1 });
  const r = rebaseForReplace([edit, added, other], 'NZTROF', 'NOG');
  assert.equal(r.changed, 2);
  const [e, a, o] = r.list;
  assert.equal(e!.patch!.text!.content, 'Welcome to <b>NOG</b>.');
  assert.equal((e!.patch!.text as unknown as { color: string }).color, '#111111', 'the rest of the patch stays');
  assert.equal(e!.baseText, 'Welcome to NOG', 'the stamp follows the stored box, which the replace changed too');
  assert.equal(a!.element!.text!.content, 'NOG owners');
  assert.equal(o, other);
  // Nothing to change: the same array back.
  const list = [other];
  assert.equal(rebaseForReplace(list, 'NZTROF', 'NOG').list, list);
  // Options are the replace's own: case is matched by default.
  assert.equal(rebaseForReplace([upd('p9', 'b', text({ content: 'nztrof' }))], 'NZTROF', 'NOG').changed, 0);
  assert.equal(rebaseForReplace([upd('p9', 'b', text({ content: 'nztrof' }))], 'NZTROF', 'NOG', { matchCase: false }).changed, 1);
});
