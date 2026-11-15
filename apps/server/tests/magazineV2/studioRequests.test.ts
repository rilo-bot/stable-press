// ---------------------------------------------------------------------------
// studioRequests.ts — what the studio's routes accept from a request body. Every
// value here came from a client (the Design Helper, The Stable Hand, or anybody with
// a token), so these tests are about what is DROPPED as much as what is kept.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_LAYOUT_READ_BYTES,
  MAX_PENDING_PROPOSALS,
  addedElementSource,
  attachedDocsTag,
  clampBoxToPage,
  historyEntry,
  imageFailureUserText,
  joinDocumentTexts,
  latestAttachedDoc,
  layoutReadRefusal,
  pageStoryLine,
  parseAttachedDocs,
  parseDocIds,
  parsePendingProposals,
  parseReplaceTextBody,
  previewBackground,
  refersToDocument,
  withStagedOutcome,
  zIndexForAdd,
} from '../../src/lib/magazineV2/studioRequests.ts';
import type { MagazineElement } from '../../src/lib/magazineV2/model.ts';

// ── pending proposals (C05) ─────────────────────────────────────────────────

test('pending proposals: the waiting tray comes back in the shape it was staged in', () => {
  const tray = [
    { id: 'p1', kind: 'update', summary: 'Headline bigger', elementId: 'h1', patch: { text: { fontSize: 64 } } },
    { id: 'p2', kind: 'add', summary: 'Add a caption', tempId: 'tmp-1', element: { type: 'text', x: 10 } },
    { id: 'p3', kind: 'delete', summary: 'Remove the badge', elementId: 'b1' },
    { id: 'p4', kind: 'generate-pages', summary: 'Add 2 pages', count: 2, topic: 'Results', docId: 'doc9' },
    { id: 'p5', kind: 'copy-document-page', summary: 'Copy page 4', docId: 'doc9', sourcePage: 4 },
  ];
  const out = parsePendingProposals(tray);
  assert.equal(out.length, 5);
  assert.deepEqual(out[0], { id: 'p1', kind: 'update', summary: 'Headline bigger', elementId: 'h1', patch: { text: { fontSize: 64 } } });
  assert.equal(out[1]!.tempId, 'tmp-1');
  assert.equal(out[3]!.count, 2);
  assert.equal(out[3]!.docId, 'doc9');
  assert.equal(out[4]!.sourcePage, 4);
});

test('pending proposals: malformed ones are dropped, not repaired', () => {
  const out = parsePendingProposals([
    null,
    'p1',
    { id: 'x1', kind: 'rewrite-everything', summary: 's' }, // unknown kind
    { kind: 'update', summary: 's', elementId: 'e', patch: {} }, // no id
    { id: 'x2', kind: 'update', summary: 's', patch: { x: 1 } }, // no elementId
    { id: 'x3', kind: 'update', summary: 's', elementId: 'e' }, // no patch
    { id: 'x4', kind: 'add', summary: 's', element: {} }, // no tempId
    { id: 'x5', kind: 'copy-document-page', summary: 's' }, // no docId
    { id: 'ok', kind: 'delete', summary: 's', elementId: 'e', from: -3, count: 1.5 },
    { id: 'ok', kind: 'delete', summary: 'dup', elementId: 'e2' }, // duplicate id
  ]);
  assert.deepEqual(out, [{ id: 'ok', kind: 'delete', summary: 's', elementId: 'e' }], 'a negative or fractional number is dropped too');
  assert.deepEqual(parsePendingProposals({ id: 'p1' }), [], 'not an array');
});

test('pending proposals: an apply-layout keeps its reading only through the normaliser', () => {
  const layout = { id: 'L', kind: 'apply-layout', summary: 'Rebuild', layoutReading: { regions: [] } };
  assert.deepEqual(parsePendingProposals([layout]), [], 'no normaliser: no layout replays');
  const out = parsePendingProposals([layout], { normalizeReading: (r) => (r ? { normalised: true } : null) });
  assert.deepEqual(out[0]!.layoutReading, { normalised: true });
  assert.deepEqual(parsePendingProposals([layout], { normalizeReading: () => null }), []);
});

test('pending proposals: capped, and an oversized one is dropped', () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ id: `p${i}`, kind: 'delete', summary: 's', elementId: `e${i}` }));
  assert.equal(parsePendingProposals(many).length, MAX_PENDING_PROPOSALS);
  assert.equal(parsePendingProposals(many, { max: 3 }).length, 3);
  const huge = { id: 'big', kind: 'update', summary: 's', elementId: 'e', patch: { text: { content: 'x'.repeat(250_000) } } };
  assert.deepEqual(parsePendingProposals([huge]), []);
});

// ── attached documents (C12/C27) ────────────────────────────────────────────

test('attached documents: ids from any of the client\'s spellings, at most six, safe characters only', () => {
  const out = parseAttachedDocs([
    { id: 'a1', name: 'Results.pdf' },
    { docId: 'a2' },
    { uploadId: 'a3', name: '  Brochure.pdf ' },
    { id: 'a1', name: 'again' },
    { id: '$where:1' },
    { id: 'a4' }, { id: 'a5' }, { id: 'a6' }, { id: 'a7' },
  ]);
  assert.deepEqual(out.map((d) => d.id), ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
  assert.equal(out[1]!.name, 'document');
  assert.equal(out[2]!.name, 'Brochure.pdf');
});

test('a user turn that attached a document says so in history, a turn from another page says which page', () => {
  const row = { role: 'user', content: 'fill this page from it', pageIndex: 2, attachments: [{ name: 'Results.pdf', isImage: false, docId: 'd1' }, { name: 'horse.jpg', isImage: true, url: 'u' }] };
  assert.deepEqual(historyEntry(row, 2), { role: 'user', content: 'fill this page from it [attached document “Results.pdf” (docId d1)]' });
  assert.deepEqual(historyEntry(row, 5).content.startsWith('[page 3] fill this'), true);
  assert.deepEqual(historyEntry({ role: 'assistant', content: 'Done.', pageIndex: 0 }, 5), { role: 'assistant', content: 'Done.' });
  assert.equal(attachedDocsTag([{ id: 'd1', name: 'The "Big" Report.pdf' }]), "[attached document “The 'Big' Report.pdf” (docId d1)]");
  assert.equal(attachedDocsTag([]), '');
});

test('changes the last turn staged here and nobody sent back are no longer waiting — history says so (C05)', () => {
  const rows = [
    { role: 'user', content: 'make the headline bigger', pageId: 'pg1' },
    { role: 'assistant', content: 'Staged: headline at 72px.', pageId: 'pg1', staged: 2 },
  ];
  const history = rows.map((r) => historyEntry(r, 0));
  const told = withStagedOutcome(history, rows, { pageId: 'pg1', pendingCount: 0 });
  assert.match(told[1]!.content, /^Staged: headline at 72px\.\n\[Since this reply, the 2 changes staged here are no longer waiting/);
  assert.match(told[1]!.content, /never point the user to the tray/);
  assert.equal(told[0]!.content, history[0]!.content);
  assert.equal(history[1]!.content, 'Staged: headline at 72px.', 'the input is not mutated');
  // Still waiting (sent back): the agent replays them, nothing is added.
  assert.deepEqual(withStagedOutcome(history, rows, { pageId: 'pg1', pendingCount: 2 }), history);
  // Staged on another page: that page's tray is not this turn's business.
  assert.deepEqual(withStagedOutcome(history, rows, { pageId: 'pg9', pendingCount: 0 }), history);
  // Nothing staged, or an older assistant turn that staged: nothing to say.
  const later = [...rows, { role: 'user', content: 'thanks' }, { role: 'assistant', content: 'You are welcome.', pageId: 'pg1', staged: 0 }];
  assert.deepEqual(withStagedOutcome(later.map((r) => historyEntry(r, 0)), later, { pageId: 'pg1', pendingCount: 0 }), later.map((r) => historyEntry(r, 0)));
  const one = withStagedOutcome(history, [rows[0]!, { ...rows[1]!, staged: 1 }], { pageId: 'pg1', pendingCount: 0 });
  assert.match(one[1]!.content, /the change staged here is no longer waiting/);
});

test('the most recent document attached in a thread is found, newest row first', () => {
  const rows = [
    { role: 'user', content: 'a', attachments: [{ name: 'Old.pdf', isImage: false, docId: 'old' }] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'b', attachments: [{ name: 'x.jpg', isImage: true, url: 'u' }] },
    { role: 'user', content: 'c', attachments: [{ name: 'New.pdf', isImage: false, docId: 'new' }] },
    { role: 'assistant', content: 'ok' },
  ];
  assert.deepEqual(latestAttachedDoc(rows), { id: 'new', name: 'New.pdf' });
  assert.equal(latestAttachedDoc(rows.slice(1, 3)), null);
});

test('refersToDocument: a turn about the document, not every turn', () => {
  for (const t of ['now add the race results from the PDF', 'use the figures from the attached report', 'put the table from the document on page 4', 'what does the brochure say about entries?']) {
    assert.equal(refersToDocument(t), true, t);
  }
  for (const t of ['make the headline bigger', 'change the background to navy', 'add a photo of a horse']) {
    assert.equal(refersToDocument(t), false, t);
  }
});

// ── replace-text body ───────────────────────────────────────────────────────

test('replace-text: defaults (case-sensitive, not whole-word, real run) and refusals', () => {
  assert.deepEqual(parseReplaceTextBody({ find: 'NZTROF', replace: 'NOG' }), { ok: true, find: 'NZTROF', replace: 'NOG', matchCase: true, wholeWord: false, dryRun: false });
  assert.deepEqual(parseReplaceTextBody({ find: 'Cup', replace: 'Trophy', matchCase: false, wholeWord: true, dryRun: true }), {
    ok: true, find: 'Cup', replace: 'Trophy', matchCase: false, wholeWord: true, dryRun: true,
  });
  assert.equal(parseReplaceTextBody({ find: 'Ltd', replace: '' }).ok, true, 'removing a word is a real edit');
  assert.equal(parseReplaceTextBody({ find: 'nztrof', replace: 'NZTROF', matchCase: false }).ok, true, 'fixing the casing is a real edit');
  for (const bad of [{}, { find: '   ', replace: 'x' }, { find: 'x' }, { find: 'same', replace: 'same' }, { find: 'x'.repeat(201), replace: 'y' }, null]) {
    const out = parseReplaceTextBody(bad);
    assert.equal(out.ok, false, JSON.stringify(bad));
    assert.ok((out as { error: string }).error.length > 10);
  }
});

// ── documents named in a request (C19/C28) ──────────────────────────────────

test('parseDocIds: docIds and docId together, de-duplicated, capped, safe ids only', () => {
  assert.deepEqual(parseDocIds({ docIds: ['a', 'b', 'a'], docId: 'c' }), ['a', 'b', 'c']);
  assert.deepEqual(parseDocIds({ docIds: ['a', 'b', 'c', 'd', 'e'] }), ['a', 'b', 'c', 'd']);
  assert.deepEqual(parseDocIds({ docIds: [{ $ne: null }, '../x', 'ok_1'] }), ['ok_1']);
  assert.deepEqual(parseDocIds(undefined), []);
});

test('joinDocumentTexts: each under its name when several, within the cap, empties left out', () => {
  assert.equal(joinDocumentTexts([{ name: 'A.pdf', text: ' alpha ' }]), 'alpha');
  const two = joinDocumentTexts([{ name: 'A.pdf', text: 'alpha' }, { name: 'B.pdf', text: '' }, { name: 'C.pdf', text: 'gamma' }]);
  assert.equal(two, '=== A.pdf ===\nalpha\n\n=== C.pdf ===\ngamma');
  assert.ok(joinDocumentTexts([{ name: 'A', text: 'x'.repeat(100) }, { name: 'B', text: 'y'.repeat(100) }], 120).length <= 122);
});

// ── layout reads in the API process (C34) ───────────────────────────────────

test('a PDF too large to read in the API is refused with a plain sentence; unknown sizes pass', () => {
  assert.equal(layoutReadRefusal(5 * 1024 * 1024), null);
  assert.equal(layoutReadRefusal(MAX_LAYOUT_READ_BYTES), null);
  const msg = layoutReadRefusal(150 * 1024 * 1024);
  assert.match(msg!, /too large to measure here \(150 MB; the limit is 40 MB\)/);
  assert.match(msg!, /copy this page/);
  assert.equal(layoutReadRefusal(undefined), null);
  assert.equal(layoutReadRefusal(Number.NaN), null);
});

// ── element adds (C51) ──────────────────────────────────────────────────────

test('an added element keeps ai-agent when the AI placed it, never claims extracted; a restore keeps its own', () => {
  assert.equal(addedElementSource('ai-agent', false), 'ai-agent');
  assert.equal(addedElementSource('extracted', false), 'manual');
  assert.equal(addedElementSource(undefined, false), 'manual');
  assert.equal(addedElementSource('manual', false), 'manual');
  assert.equal(addedElementSource('extracted', true), 'extracted', 'undo puts back exactly what was deleted');
});

test('an add with no zIndex goes on top of the page; a named zIndex is kept', () => {
  const page = [{ zIndex: 4 }, { zIndex: 990 }, { zIndex: Number.NaN }];
  assert.equal(zIndexForAdd(undefined, page), 991);
  assert.equal(zIndexForAdd(null, page), 991);
  assert.equal(zIndexForAdd(3, page), undefined, 'the body chose a layer');
  assert.equal(zIndexForAdd(undefined, []), 1);
  assert.equal(zIndexForAdd(undefined, [{ zIndex: 9999 }]), 9999, 'capped at the model ceiling');
});

// ── pages handed to the renderer ────────────────────────────────────────────

test('previewBackground: a stored colour or image, else white', () => {
  assert.deepEqual(previewBackground({ type: 'color', value: '#112233' }), { type: 'color', value: '#112233' });
  assert.deepEqual(previewBackground({ type: 'image', value: 'https://x/bg.jpg' }), { type: 'image', value: 'https://x/bg.jpg' });
  assert.deepEqual(previewBackground({ type: 'gradient', value: 'x' }), { type: 'color', value: '#ffffff' });
  assert.deepEqual(previewBackground(undefined), { type: 'color', value: '#ffffff' });
});

test('clampBoxToPage: numbers only, a minimum size, never past an edge', () => {
  const page = { width: 1240, height: 1754 };
  assert.deepEqual(clampBoxToPage({ x: 100, y: 200, w: 600, h: 400 }, page), { x: 100, y: 200, w: 600, h: 400 });
  assert.deepEqual(clampBoxToPage({ x: 1000, y: -50, w: 600, h: 400 }, page), { x: 640, y: 0, w: 600, h: 400 }, 'moved back on');
  assert.deepEqual(clampBoxToPage({ x: 0, y: 0, w: 5000, h: 10 }, page), { x: 0, y: 0, w: 1240, h: 40 }, 'shrunk to the page, grown to the minimum');
  assert.equal(clampBoxToPage({ x: 'a', y: 0, w: 1, h: 1 }, page), null);
  assert.equal(clampBoxToPage(null, page), null);
});

// ── image failures, for a person (C42) ──────────────────────────────────────

test('each image failure tells a person what happened and whether to try again', () => {
  assert.match(imageFailureUserText('refused', 'I cannot depict real people'), /declined.*“I cannot depict real people”.*different subject/);
  assert.match(imageFailureUserText('no-credit'), /out of credit/);
  assert.match(imageFailureUserText('rate-limited'), /minute or two/);
  assert.match(imageFailureUserText('timeout'), /took too long/);
  assert.match(imageFailureUserText('unavailable'), /unavailable right now/);
  assert.match(imageFailureUserText('failed'), /Try again, or reword/);
  assert.doesNotMatch(imageFailureUserText('no-credit'), /do not retry/i, 'addressed to a person, not to the AI');
});

// ── a page's story (C09) ────────────────────────────────────────────────────

test('pageStoryLine: headline first, then the rest in reading order, furniture left out', () => {
  const t = (id: string, content: string, fontSize: number, y: number): MagazineElement =>
    ({ id, type: 'text', x: 0, y, w: 400, h: 60, rotation: 0, zIndex: 1, locked: false, source: 'ai-agent', text: { content, role: 'body', fontFamily: 'Georgia', fontSize, fontWeight: 400, color: '#111111', align: 'left', lineHeight: 1.3, autoFit: 'shrink' } }) as MagazineElement;
  const els = [
    t('b', 'The <b>Cup</b> field&nbsp;is set.', 18, 400),
    t('h', 'Cup Week', 72, 200),
    t('k', 'RACING', 14, 120),
    t('furniture-head-label', 'The Magazine', 12, 20),
  ];
  assert.equal(pageStoryLine(els), 'Cup Week — RACING — The Cup field is set.');
  assert.equal(pageStoryLine([]), '');
  assert.ok(pageStoryLine([t('x', 'word '.repeat(200), 20, 0)], 50).length <= 50);
});

test('parsePendingProposals keeps a staged background, a group and a reorder destination — validated', () => {
  const out = parsePendingProposals([
    { id: 'p1', kind: 'set-background', summary: 'Set the page background to #112233', background: { type: 'color', value: '#112233' } },
    { id: 'p2', kind: 'set-background', summary: 'Bad colour', background: { type: 'color', value: 'url(javascript:x)' } },
    { id: 'p3', kind: 'set-background', summary: 'No background at all' },
    { id: 'p4', kind: 'delete', elementId: 'e1', summary: 'Clear the page: remove 2 elements', group: 'g-clear' },
    { id: 'p5', kind: 'reorder-page', pageId: 'pg2', from: 1, to: 3, toPageId: 'pg4', summary: 'Move page 2' },
    { id: 'p6', kind: 'update', elementId: 'e2', patch: { x: 1 }, toPageId: 'pg9', summary: 'Moved it' },
  ]);
  assert.deepEqual(out.map((p) => p.id), ['p1', 'p4', 'p5', 'p6']);
  assert.deepEqual(out[0]!.background, { type: 'color', value: '#112233' });
  assert.equal(out[1]!.group, 'g-clear');
  assert.equal(out[2]!.toPageId, 'pg4');
  // A destination page means something only on a reorder.
  assert.equal(out[3]!.toPageId, undefined);
});

test('parsePendingProposals keeps a staged change’s warning, trimmed and capped', () => {
  const out = parsePendingProposals([
    { id: 'p1', kind: 'update', elementId: 'e1', patch: { h: 10 }, summary: 'Shrank it', warning: '  Will not fit its box: needs 412px, box is 300px.  ' },
    { id: 'p2', kind: 'update', elementId: 'e2', patch: { h: 10 }, summary: 'Long', warning: 'x'.repeat(900) },
    { id: 'p3', kind: 'update', elementId: 'e3', patch: { h: 10 }, summary: 'Odd', warning: { not: 'a string' } },
    { id: 'p4', kind: 'update', elementId: 'e4', patch: { h: 10 }, summary: 'Blank', warning: '   ' },
  ]);
  assert.equal(out[0]!.warning, 'Will not fit its box: needs 412px, box is 300px.');
  assert.equal(out[1]!.warning!.length, 300);
  assert.equal(out[2]!.warning, undefined);
  assert.equal(out[3]!.warning, undefined);
});
