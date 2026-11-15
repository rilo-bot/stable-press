// ---------------------------------------------------------------------------
// The Studio agent's edit tools, run against a working copy (no model, no database).
//
// What is pinned is what the 2026-11-15 incident needed: a word swap that changes
// only the word (replace_text), no retyping of text the model has only seen part of,
// a bigger font size that sticks and grows its box, moves kept on the page, a drop-cap
// paragraph edited as one, and a page the agent can check (and "look at") without
// ever ending up blind. The turn's deadline is set in the past so check_page uses the
// estimate and look_at_page degrades without starting Chromium or a model call.
//
// The tool modules reach lib/db.ts, which throws at import without a MONGODB_URI. The
// client connects lazily, so an unroutable placeholder is enough — nothing here queries.
// ---------------------------------------------------------------------------

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import type { ElementTextData, MagazineElement } from '../../src/lib/magazineV2/model.ts';
import type { AgentCtx } from '../../src/lib/magazineV2/agentTools/shared.ts';
import { visibleText } from '../../src/lib/magazineV2/textReplace.ts';
import { buildDropCap } from './dropCapFixture.js';

let editTools: typeof import('../../src/lib/magazineV2/agentTools/editTools.ts').editTools;
let buildTools: typeof import('../../src/lib/magazineV2/agent.ts').buildTools;
before(async () => {
  process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:9/edit-tools-test-never-connects';
  ({ editTools } = await import('../../src/lib/magazineV2/agentTools/editTools.ts'));
  ({ buildTools } = await import('../../src/lib/magazineV2/agent.ts'));
});

const PAGE = { width: 1240, height: 1754 };
const prose = (words: number, seed = 'racing') => Array.from({ length: words }, (_, i) => `${seed}${i % 7 === 0 ? ',' : ''}`).join(' ') + '.';

type TextOver = Partial<Omit<MagazineElement, 'text'>> & { text?: Partial<ElementTextData> };
function textEl(id: string, content: string, over: TextOver = {}): MagazineElement {
  const { text, ...rest } = over;
  return {
    id, type: 'text', x: 100, y: 100, w: 500, h: 200, rotation: 0, zIndex: 4, locked: false, source: 'ai-agent',
    ...rest,
    text: {
      content, role: 'body', fontFamily: 'Georgia, serif', fontSize: 24, maxFontSize: 24, minFontSize: 14,
      fontWeight: 400, color: '#111111', align: 'left', lineHeight: 1.4, autoFit: 'shrink', ...text,
    },
  } as MagazineElement;
}

function ctxWith(elements: MagazineElement[], extra: Partial<AgentCtx> = {}): AgentCtx {
  return {
    working: elements.map((e) => ({ ...e })),
    proposals: [],
    magazineId: 'm1',
    pageIndex: 2,
    seq: 0,
    page: { ...PAGE, background: { type: 'color', value: '#ffffff' } },
    original: elements.map((e) => ({ ...e })),
    deadline: Date.now() - 1, // no time for Chromium or a model: the estimate path
    looks: 0,
    shownPartly: new Set(),
    readFully: new Set(),
    ...extra,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyResult = any;
async function run(ctx: AgentCtx, name: string, input: Record<string, unknown>): Promise<AnyResult> {
  const t = (editTools(ctx) as Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>)[name]!;
  return t.execute(input, { toolCallId: 't1', messages: [] });
}

test('the new tools are offered after the original twenty', () => {
  const names = Object.keys(buildTools(ctxWith([]), true));
  for (const n of ['read_element', 'replace_text', 'check_page', 'look_at_page', 'tidy_column']) assert.ok(names.includes(n), n);
  assert.ok(names.indexOf('read_element') > names.indexOf('reorder_pages'));
});

test('replace_text changes only the word, one proposal per box, and says “not found” plainly (C01/C17)', async () => {
  const html = '<b>The New Owners Group</b> met at the club rooms on Tuesday evening; NZTROF chaired it.<br>NZTROF thanked everyone.';
  const ctx = ctxWith([textEl('b1', html, { h: 300 }), textEl('b2', 'Nothing to see.', { y: 500 })]);
  const r = await run(ctx, 'replace_text', { find: 'NZTROF', replace: 'NOG' });
  assert.equal(r.ok, true);
  assert.equal(r.summary, 'Replaced “NZTROF” → “NOG” (2×)');
  assert.equal(ctx.proposals.length, 1);
  assert.equal(ctx.proposals[0]!.summary, 'Replaced “NZTROF” → “NOG” (2×)');
  assert.deepEqual(ctx.proposals[0]!.patch, { text: { content: html.split('NZTROF').join('NOG') } });
  assert.equal(ctx.working[0]!.text!.content, html.split('NZTROF').join('NOG'), 'the working copy sees the change');
  const miss = await run(ctx, 'replace_text', { find: 'Melbourne Cup', replace: 'Cup' });
  assert.equal(miss.ok, false);
  assert.match(miss.error, /“Melbourne Cup” was not found on this page \(searched 2 text boxes\)/);
  assert.equal(ctx.proposals.length, 1, 'nothing staged for a miss');
});

test('set_element_text on text shown only in part is refused until read_element (C47)', async () => {
  const long = prose(400);
  const ctx = ctxWith([textEl('b1', long, { h: 1200, w: 900 })], { shownPartly: new Set(['b1']) });
  const refused = await run(ctx, 'set_element_text', { elementId: 'b1', content: 'A new paragraph.' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /shown only part/);
  const read = await run(ctx, 'read_element', { elementId: 'b1' });
  assert.equal(read.content, long, 'read_element returns the stored HTML in full');
  assert.equal(read.maxFontSize, 24);
  assert.ok(read.fit);
  const ok = await run(ctx, 'set_element_text', { elementId: 'b1', content: 'A new paragraph.' });
  assert.equal(ok.ok, true);
  assert.match(ok.warning ?? '', /removed most of the existing copy/, 'dropping most of a long box is flagged');
});

test('set_element_style fontSize: the size becomes the ceiling and the box grows into free space (C03/C50)', async () => {
  const ctx = ctxWith([textEl('b1', prose(60), { h: 160, text: { fontSize: 18, maxFontSize: 18 } })]);
  const r = await run(ctx, 'set_element_style', { elementId: 'b1', fontSize: 28 });
  assert.equal(r.ok, true);
  const patch = ctx.proposals[0]!.patch as { text: { fontSize: number; maxFontSize: number }; h?: number };
  assert.equal(patch.text.fontSize, 28);
  assert.equal(patch.text.maxFontSize, 28);
  assert.ok(typeof patch.h === 'number' && patch.h > 160, 'the box grew in the same proposal');
  assert.equal(r.fit.fits, true);
  assert.match(r.note, /grew from 160px/);
  // The next edit (a word swap) keeps 28.
  await run(ctx, 'replace_text', { find: 'racing', replace: 'Racing', elementIds: ['b1'] });
  assert.equal(ctx.working[0]!.text!.fontSize, 28);
});

test('move_element keeps the box on the page and says so', async () => {
  const ctx = ctxWith([textEl('b1', 'Short copy.', { w: 400 })]);
  const r = await run(ctx, 'move_element', { elementId: 'b1', x: 1300, y: 50 });
  assert.equal(r.ok, true);
  assert.deepEqual(ctx.proposals[0]!.patch, { x: PAGE.width - 400, y: 50 });
  assert.match(r.clamped, /x 1300 → 840/);
  assert.equal(r.fit.fits, true);
});

test('a drop-cap paragraph is rewritten as one: three pieces staged, the new first letter in the cap (C13)', async () => {
  const dc = buildDropCap(`Morning comes early ${prose(110)}`);
  const ctx = ctxWith(dc.elements);
  const next = `Evening falls late ${prose(100, 'stable')}`;
  const r = await run(ctx, 'set_element_text', { elementId: dc.lead.id, content: next });
  assert.equal(r.ok, true, r.error);
  assert.equal(ctx.proposals.length, 3);
  const cap = ctx.working.find((e) => e.id === dc.cap.id)!;
  const lead = ctx.working.find((e) => e.id === dc.lead.id)!;
  assert.equal(visibleText(cap.text!.content), 'E');
  assert.ok(visibleText(lead.text!.content).startsWith('vening'), 'no doubled first letter');
  // A word swap that runs from the cap into the opening lines.
  const swap = await run(ctx, 'replace_text', { find: 'Evening', replace: 'Midnight' });
  assert.equal(swap.ok, true);
  assert.equal(visibleText(ctx.working.find((e) => e.id === dc.cap.id)!.text!.content), 'M');
  // Deleting any piece deletes the paragraph.
  const del = await run(ctx, 'delete_element', { elementId: dc.cap.id });
  assert.equal(del.ok, true);
  assert.equal(ctx.working.filter((e) => e.id.startsWith(dc.key)).length, 0);
});

test('check_page measures the working copy; look_at_page is never blind and is capped at two a turn', async () => {
  const ctx = ctxWith([textEl('b1', 'Fits.')]);
  await run(ctx, 'set_element_text', { elementId: 'b1', content: prose(30) });
  // Make it clip on purpose with an explicit small height.
  await run(ctx, 'move_element', { elementId: 'b1', h: 40 });
  const check = await run(ctx, 'check_page', {});
  assert.equal(check.measuredBy, 'estimate');
  assert.equal(check.ok, false);
  assert.ok(check.issues.some((i: { kind: string; elementId?: string }) => i.kind === 'text-clipped' && i.elementId === 'b1'));
  assert.match(check.next, /Fix each error now/);

  const look1 = await run(ctx, 'look_at_page', { focus: 'the body' });
  assert.equal(look1.seen, false);
  assert.ok(look1.reason);
  assert.equal(look1.check.ok, false, 'no picture, but the measured check comes back');
  assert.match(look1.next, /do not tell the user you cannot see the page/);
  await run(ctx, 'look_at_page', {});
  const look3 = await run(ctx, 'look_at_page', {});
  assert.match(look3.reason, /already looked 2 times this turn/);
  assert.equal(ctx.looks, 2);
});

test('tidy_column stages the restack, one proposal per moved box', async () => {
  const a = textEl('a', prose(20), { y: 100, h: 120 });
  const b = textEl('b', prose(20), { y: 600, h: 120 });
  const ctx = ctxWith([a, b]);
  const r = await run(ctx, 'tidy_column', { elementIds: ['a', 'b'], gap: 16 });
  assert.equal(r.ok, true, r.error);
  const moveB = ctx.proposals.find((p) => p.elementId === 'b')!;
  const aNow = ctx.working.find((e) => e.id === 'a')!;
  assert.equal((moveB.patch as { y: number }).y, aNow.y + aNow.h + 16);
});
