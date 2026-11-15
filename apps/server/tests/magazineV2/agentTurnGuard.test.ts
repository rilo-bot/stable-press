// ---------------------------------------------------------------------------
// agentTurnGuard.ts — the Studio's reply can no longer disagree with what it staged.
//
// The 2026-11-15 page-3 reply said "I've staged the change for you to review. All six
// paragraphs are 20px and 220px tall…" with no tool called. These pin the pure parts
// of the guard: spotting a claim, the deterministic Apply line, the saved-document
// confirmation, and the staged changes a turn is sent back (including a background
// change the shared parser does not know yet).
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import type { MagazineElement } from '../../src/lib/magazineV2/model.ts';
import {
  asksForNoChange,
  attachedDocsPromptLines,
  claimedChangeCount,
  claimsChange,
  CORRECTION_NOTE,
  describeStaged,
  HONEST_NO_CHANGE,
  honestNoChange,
  pendingFromWire,
  shortClaimNote,
  withHonestCorrection,
  proposalFingerprint,
  replayPending,
  savedDocsLine,
  splitBackgrounds,
  stagedStatusLine,
  stripStatusLines,
  type PendingLike,
} from '../../src/lib/magazineV2/agentTurnGuard.ts';

// ── Claims ───────────────────────────────────────────────────────────────────

test('the page-3 reply that staged nothing is a claim', () => {
  assert.equal(claimsChange("I've staged the change for you to review. All six paragraphs are 20px and 220px tall, with 14px gaps."), true);
  assert.equal(claimsChange('I’ve staged the removal of all 14 elements on page 7, so the page will be blank once you apply it.'), true);
  assert.equal(claimsChange('Done — the headline has been moved up and the caption has been shortened.'), true);
  assert.equal(claimsChange('I set the body to 20px and moved the photo.'), true);
  assert.equal(claimsChange('Staged for your review.'), true);
  assert.equal(claimsChange("I can't change the background, but I've removed all the elements."), true, 'the second half claims');
});

test('negations, questions, offers, futures and earlier changes are not claims', () => {
  for (const s of [
    'Nothing on the page has changed.',
    "I need to correct my last reply: I didn't actually stage the 20px change. Nothing on the page has changed.",
    'No changes were staged.',
    'Do you want me to set it to 20px?',
    "I'll set it to 20px once you confirm.",
    'If you apply it, the headline will be moved up.',
    'The six changes from earlier are still waiting for Apply.',
    'The page has a headline, a subhead and six body boxes.',
    'I could not find “NZTROF” on this page.',
    'I made sure nothing overlaps: every box fits.',
    'I checked the page and everything fits.',
    // Descriptions of the page, not claims (the reviewer's probe sentences).
    'Here is what is on page 3: the headline has been set in Playfair at 48px; the photo has been placed top right.',
    'The chart I added is at the top right, 640x362.',
    'I looked at the page. The headline I enlarged now fits on one line.',
    'The photo, which I placed earlier, sits under the headline.',
  ]) {
    assert.equal(claimsChange(s), false, s);
  }
});

test('claims stay claims: done passives, clause breaks, prepositions and change nouns', () => {
  for (const s of [
    'The headline has now been moved up.',
    'All done: the caption has been shortened.',
    'This was too big so I reduced it to 40px.',
    'At the top I added a headline.',
    'Here are the changes I made: the photo is bigger.',
    'The chart I added is at the top right, and I moved the photo below it.',
    'I can confirm that I moved the photo.',
  ]) {
    assert.equal(claimsChange(s), true, s);
  }
});

test('a status line copied from history is not a claim once stripped', () => {
  const copied = 'Here are the elements on this page: a headline and two body boxes.\nWaiting for Apply: 3 changes — Rewrote the body.';
  assert.equal(claimsChange(stripStatusLines(copied)), false);
});

test('a question or a listing asks for no change; a request to change does', () => {
  for (const m of [
    "Don't change anything. List each element on this page with its size.",
    'What font is the headline in?',
    'List each element',
    'Is the photo cut off at the bottom?',
    'Just tell me how many words the body has.',
    'Without changing it, which box is the caption?',
  ]) {
    assert.equal(asksForNoChange(m), true, m);
  }
  for (const m of ['Make the headline bigger', 'Can you move the photo up?', 'Is the photo cut off? Fix it if so.', 'replace NZTROF with NOG', '']) {
    assert.equal(asksForNoChange(m), false, m);
  }
});

test('the honest correction keeps the model’s words and agrees with what is still waiting', () => {
  const words = 'The headline has been set at 64px.';
  assert.equal(withHonestCorrection(words, 0), `${HONEST_NO_CHANGE}\n\n${words}`);
  // Earlier changes still waiting: the sentence must not say "nothing is waiting".
  const waiting = honestNoChange(6);
  assert.doesNotMatch(waiting, /nothing is waiting/i);
  assert.match(waiting, /nothing new was changed/);
  const status = stagedStatusLine(
    Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, summary: 'Rewrote the body' })),
    new Set(Array.from({ length: 6 }, (_, i) => `p${i}`)),
  );
  assert.match(status, /6 changes from earlier messages are still waiting for Apply/);
  assert.equal(withHonestCorrection('Waiting for Apply: 2 changes — x.', 0), HONEST_NO_CHANGE, 'a copied status line is not kept');
  assert.equal(shortClaimNote(2, 3), 'Note: 2 changes were staged, not the 3 described above — the line below lists what is waiting.');
  assert.match(shortClaimNote(1, 3), /^Note: 1 change was staged/);
});

test('an explicit count is read; vague wording is not', () => {
  assert.equal(claimedChangeCount("I've staged 6 changes for you."), 6);
  assert.equal(claimedChangeCount('I staged three edits.'), 3);
  assert.equal(claimedChangeCount('Made all six paragraphs 20px.'), null);
  assert.equal(claimedChangeCount('Nothing to do.'), null);
});

test('the fingerprint changes when anything is staged or taken out', () => {
  assert.equal(proposalFingerprint([{ id: 'p1' }, { id: 'p2' }]), proposalFingerprint([{ id: 'p1' }, { id: 'p2' }]));
  assert.notEqual(proposalFingerprint([{ id: 'p1' }]), proposalFingerprint([{ id: 'p1' }, { id: 'p2' }]));
  assert.notEqual(proposalFingerprint([{ id: 'p1' }, { id: 'p2' }]), proposalFingerprint([{ id: 'p2' }]));
  assert.match(CORRECTION_NOTE, /no tool call succeeded.*Call the tools NOW.*nothing was changed/);
  assert.match(HONEST_NO_CHANGE, /nothing was changed and nothing is waiting for Apply/);
});

// ── The Apply line ───────────────────────────────────────────────────────────

test('the Apply line is built from the proposals alone', () => {
  const six = Array.from({ length: 6 }, (_, i) => ({ id: `p${i + 1}`, summary: `Arranged 6 boxes: 20px type, 220px tall, 14px apart (y 294–1684) — the body (${i + 1} of 6)`, group: 'Arranged 6 boxes: 20px type, 220px tall, 14px apart (y 294–1684)' }));
  assert.equal(stagedStatusLine(six), 'Waiting for Apply: 6 changes — Arranged 6 boxes: 20px type, 220px tall, 14px apart (y 294–1684).');
  assert.equal(stagedStatusLine([]), 'Nothing was changed.');
  assert.equal(stagedStatusLine([], new Set(['x'])), 'Nothing is waiting for Apply now.');
  const earlier = new Set(['p1', 'p2']);
  assert.equal(
    stagedStatusLine([{ id: 'p1', summary: 'Rewrote the body' }, { id: 'p2', summary: 'Rewrote the body' }], earlier),
    'Nothing new was changed; 2 changes from earlier messages are still waiting for Apply.',
  );
  assert.equal(
    stagedStatusLine([{ id: 'p1', summary: 'Rewrote the body' }, { id: 'p2', summary: 'Rewrote the body' }, { id: 'p3', summary: 'Recoloured the headline.' }], earlier),
    'Waiting for Apply: 3 changes (1 new, 2 from earlier messages) — Recoloured the headline.',
  );
});

test('describeStaged groups repeats, folds drop-cap pieces into their change, and caps the list', () => {
  assert.equal(
    describeStaged([
      { summary: 'Restyled the body' },
      { summary: 'Restyled the body' },
      { summary: 'Rewrote the opening paragraph → “Riders…”' },
      { summary: 'Rewrote the opening paragraph → “Riders…” (drop-cap piece)' },
    ]),
    'Restyled the body ×2; Rewrote the opening paragraph → “Riders…” ×2',
  );
  assert.equal(describeStaged(['a', 'b', 'c', 'd', 'e'].map((s) => ({ summary: s }))), 'a; b; c; and 2 more');
  const clear = Array.from({ length: 14 }, (_, i) => ({ summary: `Clear the page: remove 14 elements (the body ${i})`, group: 'Clear the page: remove 14 elements' }));
  assert.equal(describeStaged(clear), 'Clear the page: remove 14 elements');
});

test('status lines the model imitated are dropped before the real one is added', () => {
  assert.equal(stripStatusLines('Done.\n\nWaiting for Apply: 3 changes — x.'), 'Done.');
  assert.equal(stripStatusLines('Nothing was changed.'), '');
  assert.equal(stripStatusLines('I moved it.\nNothing new was changed; 2 changes from earlier messages are still waiting for Apply.'), 'I moved it.');
  assert.equal(stripStatusLines('Waiting for your answer on the colour.'), 'Waiting for your answer on the colour.');
});

// ── Documents attached with the message ──────────────────────────────────────

test('an attached document is confirmed saved — never “I can’t store files”', () => {
  const doc = { docId: 'd1', name: 'NZTROF Owners Experience.pdf', readable: true, reading: true };
  const lines = attachedDocsPromptLines([doc]).join('\n');
  assert.match(lines, /ALREADY SAVED to this magazine’s documents/);
  assert.match(lines, /docId d1/);
  assert.match(lines, /Never say you cannot store/);
  assert.equal(savedDocsLine([doc]), 'Saved “NZTROF Owners Experience.pdf” to this magazine’s documents — I can read it again on any later message.');
  assert.match(savedDocsLine([{ ...doc, readable: false }]), /pages are being read and will be ready to use in a minute/);
  assert.match(savedDocsLine([{ ...doc, readable: false, reading: false }]), /no text could be read from it yet/);
  assert.match(savedDocsLine([doc, { ...doc, docId: 'd2', name: 'Results.pdf' }]), /^Saved “NZTROF Owners Experience\.pdf” and “Results\.pdf”/);
  assert.equal(savedDocsLine([]), '');
  assert.deepEqual(attachedDocsPromptLines([]), []);
});

// ── Staged changes sent back by the client ───────────────────────────────────

test('pendingFromWire keeps the parser’s order and puts back group, toPageId and background changes', () => {
  const raw = [
    { id: 'p1', kind: 'update', elementId: 'a', patch: { x: 1 }, summary: 'Moved', group: 'Arranged 2 boxes' },
    { id: 'p2', kind: 'set-background', background: { type: 'color', value: '#F5EFE6' }, summary: 'Set the page background to #f5efe6' },
    { id: 'p3', kind: 'set-background', background: { type: 'color', value: 'not a colour' }, summary: 'bad' },
    { id: 'p4', kind: 'reorder-page', pageId: 'pg2', toPageId: 'pg5', from: 1, to: 4, summary: 'Move page 2' },
    { id: 'p5', kind: 'mystery', summary: 'dropped by the parser' },
  ];
  // What studioRequests.parsePendingProposals returns for these (it does not know
  // set-background, group or toPageId).
  const parsed = [
    { id: 'p1', kind: 'update', elementId: 'a', patch: { x: 1 }, summary: 'Moved' },
    { id: 'p4', kind: 'reorder-page', pageId: 'pg2', from: 1, to: 4, summary: 'Move page 2' },
  ];
  const out = pendingFromWire(parsed, raw);
  assert.deepEqual(out.map((p) => p.id), ['p1', 'p2', 'p4']);
  assert.equal(out[0]!.group, 'Arranged 2 boxes');
  assert.deepEqual(out[1]!.background, { type: 'color', value: '#f5efe6' });
  assert.equal(out[2]!.toPageId, 'pg5');
  assert.deepEqual(pendingFromWire(parsed, 'nonsense'), []);
});

test('only the last staged background counts', () => {
  const pending = [
    { id: 'p1', kind: 'set-background', background: { type: 'color', value: '#111111' }, summary: 'a' },
    { id: 'p2', kind: 'update', elementId: 'x', patch: {}, summary: 'b' },
    { id: 'p3', kind: 'set-background', background: { type: 'none' }, summary: 'c' },
  ] as PendingLike[];
  const s = splitBackgrounds(pending);
  assert.equal(s.background!.id, 'p3');
  assert.deepEqual(s.replaced.map((p) => p.id), ['p1']);
  assert.deepEqual(s.rest.map((p) => p.id), ['p2']);
});

const PAGE = { width: 1240, height: 1754 };
const textEl = (id: string, content: string, y = 100): MagazineElement =>
  ({
    id, type: 'text', x: 100, y, w: 500, h: 200, rotation: 0, zIndex: 4, locked: false, source: 'ai-agent',
    text: { content, role: 'body', fontFamily: 'Georgia, serif', fontSize: 24, maxFontSize: 24, minFontSize: 14, fontWeight: 400, color: '#111111', align: 'left', lineHeight: 1.4, autoFit: 'shrink' },
  }) as MagazineElement;

test('replayPending: the waiting changes are on the page the turn starts from, a background included', () => {
  const stored = [textEl('a', 'Alpha'), textEl('b', 'Beta', 400)];
  const pending = [
    { id: 'p1', kind: 'update', elementId: 'a', patch: { text: { content: 'Alpha one' } }, summary: 'Rewrote the body' },
    { id: 'p2', kind: 'delete', elementId: 'b', summary: 'Deleted the body' },
    { id: 'p3', kind: 'set-background', background: { type: 'none' }, summary: 'Set the page background to plain white' },
    { id: 'p4', kind: 'update', elementId: 'gone', patch: { x: 1 }, summary: 'Moved the caption' },
  ] as PendingLike[];
  const start = replayPending(stored, { ...PAGE, background: { type: 'color', value: '#f5efe6' } }, pending);
  assert.deepEqual(start.working.map((e) => e.id), ['a']);
  assert.equal(start.working[0]!.text!.content, 'Alpha one');
  assert.deepEqual(start.proposals.map((p) => p.id), ['p1', 'p2', 'p3']);
  assert.deepEqual(start.background, { type: 'color', value: '#ffffff' });
  assert.deepEqual(start.dropped, [{ id: 'p4', summary: 'Moved the caption', reason: 'its element is no longer on the page' }]);
  assert.deepEqual([...start.pendingIds], ['p1', 'p2', 'p3']);
  assert.equal(start.seq, 4, 'new ids continue past every id the client sent');
  assert.equal(stored[0]!.text!.content, 'Alpha', 'the stored page is untouched');
});

test('replayPending: a background change does not ride with a page copy', () => {
  const start = replayPending([textEl('a', 'A')], PAGE, [
    { id: 'p1', kind: 'copy-document-page', docId: 'd1', sourcePage: 2, summary: 'Copy page 2' },
    { id: 'p2', kind: 'set-background', background: { type: 'color', value: '#000000' }, summary: 'Black' },
  ] as PendingLike[]);
  assert.deepEqual(start.proposals.map((p) => p.id), ['p1']);
  assert.match(start.dropped[0]!.reason, /applied on its own/);
  assert.equal(start.background, undefined);
});

test('a staged background picture sent back must pass the allow-list (the server renders it)', () => {
  const raw = [
    { id: 'p1', kind: 'set-background', background: { type: 'image', value: 'http://169.254.169.254/latest/meta-data/' }, summary: 'x' },
    { id: 'p2', kind: 'set-background', background: { type: 'image', value: 'https://cdn.example.com/public/magazinesV2/m/media/a.jpg' }, summary: 'y' },
    { id: 'p3', kind: 'set-background', background: { type: 'color', value: '#112233' }, summary: 'z' },
  ];
  // No allow-list given: at least a public http(s) address.
  assert.deepEqual(pendingFromWire([], raw).map((p) => p.id), ['p2', 'p3']);
  // The route's allow-list (this magazine's library): only what it vouches for.
  const onlyLibrary = (u: string) => u === 'https://cdn.example.com/public/magazinesV2/m/media/a.jpg';
  assert.deepEqual(pendingFromWire([], raw, { allowImage: onlyLibrary }).map((p) => p.id), ['p2', 'p3']);
  assert.deepEqual(pendingFromWire([], raw, { allowImage: () => false }).map((p) => p.id), ['p3'], 'a colour needs no allow-list');
  // The same filter applies to a change the shared parser already accepted.
  const parsed = [{ id: 'p1', kind: 'set-background', summary: 'x', background: { type: 'image', value: 'http://169.254.169.254/latest/meta-data/' } }];
  assert.deepEqual(pendingFromWire(parsed, raw.slice(0, 1)), []);
});
