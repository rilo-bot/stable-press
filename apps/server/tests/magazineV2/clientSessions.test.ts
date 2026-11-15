// ---------------------------------------------------------------------------
// The client's real Design Helper sessions (2026-11-15, “The New Owners Bulletin”),
// replayed through the server's own code — and why "nothing happened" cannot recur.
//
// Each turn is run the way runPageAgent runs one, minus the model: the staged changes
// the client sends back go through studioRequests.parsePendingProposals and
// agentTurnGuard.pendingFromWire, are replayed with replayPending, the tools the model
// would have called run against that working copy, and the turn's proposals go back
// over the wire (a JSON round trip) to be sent with the next message. At the end the
// waiting set is applied in order through the write pipeline, as the web's Apply does.
//
// What used to happen: every message REPLACED the previous message's staged set, so on
// page 3 only the last body rewrite survived and the NZTROF title change was lost; on
// pages 7–16 each "remove everything" was wiped by the next. Now every change survives
// every later message, nothing is duplicated, and the Apply line says exactly what is
// waiting.
//
// lib/db.ts throws at import without a MONGODB_URI, so a placeholder is set; nothing
// here touches the database (the media collection is an empty in-memory stand-in).
// ---------------------------------------------------------------------------

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import type { ElementTextData, MagazineElement } from '../../src/lib/magazineV2/model.ts';
import type { AgentCtx } from '../../src/lib/magazineV2/agentTools/shared.ts';
import type { AgentProposal } from '../../src/lib/magazineV2/agent.ts';
import { parsePendingProposals } from '../../src/lib/magazineV2/studioRequests.ts';
import { normalizeLayoutReading } from '../../src/lib/magazineV2/layoutReading.ts';
import { claimsChange, pendingFromWire, replayPending, stagedStatusLine } from '../../src/lib/magazineV2/agentTurnGuard.ts';
import { normalizeElementPatch } from '../../src/lib/magazineV2/writePipeline.ts';
import { visibleText } from '../../src/lib/magazineV2/textReplace.ts';

type Tools = Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>;
let buildTools: typeof import('../../src/lib/magazineV2/agent.ts').buildTools;
/** In-memory rows by collection name (only the document listing reads any). */
const ROWS: Record<string, Record<string, unknown>[]> = {};

before(async () => {
  process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:9/client-sessions-test-never-connects';
  const { db } = await import('../../src/lib/db.ts');
  (db as { collection: unknown }).collection = (name: string) => ({
    find: async (q: Record<string, unknown> = {}) =>
      (ROWS[name] ?? []).filter((r) => Object.entries(q).every(([k, v]) => (v === null ? r[k] == null : r[k] === v))),
    findById: async (id: string) => (ROWS[name] ?? []).find((r) => r._id === id) ?? null,
  });
  ({ buildTools } = await import('../../src/lib/magazineV2/agent.ts'));
});

const PAGE = { width: 1240, height: 1754 };

type TextOver = Partial<Omit<MagazineElement, 'text'>> & { text?: Partial<ElementTextData> };
function textEl(id: string, content: string, over: TextOver = {}): MagazineElement {
  const { text, ...rest } = over;
  return {
    id, type: 'text', x: 80, y: 100, w: 531, h: 200, rotation: 0, zIndex: 4, locked: false, source: 'extracted',
    ...rest,
    text: {
      content, role: 'body', fontFamily: 'Georgia, serif', fontSize: 16, maxFontSize: 16, minFontSize: 12,
      fontWeight: 400, color: '#222222', align: 'left', lineHeight: 1.4, autoFit: 'shrink', ...text,
    },
  } as MagazineElement;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyResult = any;
type Call = (name: string, input: Record<string, unknown>) => Promise<AnyResult>;

/** One message, as runPageAgent handles it, with `act` standing in for the model. */
async function turn(
  stored: MagazineElement[],
  wire: unknown[],
  act: (call: Call) => Promise<void>,
  background = { type: 'color', value: '#f5efe6' },
): Promise<{ wire: AgentProposal[]; line: string; dropped: number; working: MagazineElement[] }> {
  const parsed = parsePendingProposals(wire, { normalizeReading: normalizeLayoutReading });
  const start = replayPending(stored, { ...PAGE, background }, pendingFromWire(parsed, wire));
  const ctx: AgentCtx = {
    working: start.working,
    proposals: start.proposals,
    magazineId: 'm1',
    pageIndex: 2,
    seq: start.seq,
    page: { ...PAGE, background: start.background ?? background },
    original: stored.map((e) => ({ ...e })),
    deadline: Date.now() - 1,
    looks: 0,
    shownPartly: new Set(),
    readFully: new Set(),
    originalBackground: background,
  };
  const tools = buildTools(ctx, true) as unknown as Tools;
  await act((name, input) => tools[name]!.execute(input, { toolCallId: 't', messages: [] }));
  return {
    wire: JSON.parse(JSON.stringify(ctx.proposals)) as AgentProposal[],
    line: stagedStatusLine(ctx.proposals, start.pendingIds, parsed.length),
    dropped: start.dropped.length,
    working: ctx.working,
  };
}

/** Apply a waiting set in order, as the web's "Apply all" does (element changes only). */
function applyAll(stored: MagazineElement[], proposals: AgentProposal[]): MagazineElement[] {
  let page = stored.map((e) => ({ ...e }));
  for (const p of proposals) {
    if (p.kind === 'update') {
      const i = page.findIndex((e) => e.id === p.elementId);
      assert.ok(i >= 0, `update ${p.id} finds #${p.elementId}`);
      page[i] = normalizeElementPatch(page[i]!, p.patch as Record<string, unknown>, PAGE)!;
    } else if (p.kind === 'delete') {
      assert.ok(page.some((e) => e.id === p.elementId), `delete ${p.id} finds #${p.elementId}`);
      page = page.filter((e) => e.id !== p.elementId);
    }
  }
  return page;
}

const ids = (list: AgentProposal[]) => list.map((p) => p.id);

/** Page 3 as the client had it: copied from the NZTROF PDF. */
function page3(): MagazineElement[] {
  return [
    textEl('title', 'NZTROF Owners Experience', { y: 80, w: 1080, h: 90, text: { role: 'headline', fontSize: 56, maxFontSize: 56 } }),
    textEl('sub', 'What owning a racehorse is really like', { y: 190, w: 1080, h: 50, text: { role: 'subhead', fontSize: 26, maxFontSize: 26 } }),
    textEl('b1', 'The New Owners Group (NZTROF) welcomed <b>forty</b> first-time owners this season.', { y: 300, h: 120 }),
    textEl('b2', 'NZTROF runs stable days twice a year so owners can meet their trainers.', { y: 460, h: 120 }),
    textEl('b3', 'Every NZTROF member receives the monthly bulletin and race-day passes.', { y: 620, h: 120 }),
  ];
}

test('page 3, message by message: the title swap and both body rewrites all survive to Apply', async () => {
  const stored = page3();

  // 1. "Replace every reference to NZTROF …" — one find-and-replace, never a retype.
  const t1 = await turn(stored, [], async (call) => {
    const r = await call('replace_text', { find: 'NZTROF', replace: 'NOG' });
    assert.equal(r.ok, true);
  });
  assert.equal(t1.wire.length, 4);
  assert.equal(t1.line, `Waiting for Apply: 4 changes — Replaced “NZTROF” → “NOG” (4×).`);

  // 2. "Change only the body box that starts 'The New Owners Group' … set its text to exactly: …"
  const exact1 = 'The New Owners Group welcomed <b>forty</b> first-time owners in its first season.';
  const t2 = await turn(stored, t1.wire, async (call) => {
    const r = await call('set_element_text', { elementId: 'b1', content: exact1 });
    assert.equal(r.ok, true);
  });
  assert.deepEqual(ids(t2.wire).slice(0, 4), ids(t1.wire), 'the earlier changes come back first, unchanged');
  assert.equal(t2.wire.length, 5);
  assert.equal(new Set(ids(t2.wire)).size, 5, 'no id repeats');
  assert.match(t2.line, /^Waiting for Apply: 5 changes \(1 new, 4 from earlier messages\) — Rewrote the body/);

  // 3. The same for the second body box.
  const exact2 = 'Stable days run twice a year so owners can meet their trainers and horses.';
  const t3 = await turn(stored, t2.wire, async (call) => {
    assert.equal((await call('set_element_text', { elementId: 'b2', content: exact2 })).ok, true);
  });
  assert.deepEqual(ids(t3.wire).slice(0, 5), ids(t2.wire));
  assert.equal(t3.wire.length, 6);

  // 4. "Don't change any wording. Set the body boxes to 20px, 220px tall, 14px apart below
  //    the subhead …" — the request the assistant once claimed and never staged. Now one call.
  const t4 = await turn(stored, t3.wire, async (call) => {
    const r = await call('arrange_elements', { elementIds: ['b1', 'b2', 'b3'], fontSize: 20, height: 220, gap: 14, belowElementId: 'sub' });
    assert.equal(r.ok, true, JSON.stringify(r));
  });
  assert.equal(t4.wire.length, 9);
  assert.equal(new Set(ids(t4.wire)).size, 9);
  assert.equal(t4.dropped, 0, 'nothing the client sent back was dropped');
  assert.match(t4.line, /^Waiting for Apply: 9 changes \(3 new, 6 from earlier messages\) — Arranged 3 boxes: 20px type, 220px tall, 14px apart/);

  // 5. A question ("list each element") stages nothing — and keeps everything waiting.
  const t5 = await turn(stored, t4.wire, async () => {});
  assert.deepEqual(ids(t5.wire), ids(t4.wire));
  assert.equal(t5.line, 'Nothing new was changed; 9 changes from earlier messages are still waiting for Apply.');

  // Apply: every message's work is on the page.
  const after = applyAll(stored, t5.wire);
  const words = (id: string) => visibleText(after.find((e) => e.id === id)!.text!.content);
  assert.equal(words('title'), 'NOG Owners Experience');
  assert.equal(after.find((e) => e.id === 'b1')!.text!.content, exact1, 'exactly the text the client gave');
  assert.equal(after.find((e) => e.id === 'b2')!.text!.content, exact2);
  assert.equal(words('b3'), 'Every NOG member receives the monthly bulletin and race-day passes.');
  assert.ok(!after.some((e) => /NZTROF/.test(e.text?.content ?? '')), 'no NZTROF left anywhere');
  const bodies = ['b1', 'b2', 'b3'].map((id) => after.find((e) => e.id === id)!);
  assert.deepEqual(bodies.map((e) => [e.y, e.h, e.text!.fontSize]), [[254, 220, 20], [488, 220, 20], [722, 220, 20]]);
});

test('the word swap kept the formatting it did not touch', async () => {
  const t = await turn(page3(), [], async (call) => {
    await call('replace_text', { find: 'NZTROF', replace: 'NOG' });
  });
  const b1 = t.working.find((e) => e.id === 'b1')!;
  assert.equal(b1.text!.content.includes('<b>forty</b>'), true);
});

test('pages 7–16: "remove every element" survives the next message, which adds the white background', async () => {
  const page7 = [
    textEl('h', 'Season Review', { text: { role: 'headline' }, source: 'ai-agent' }),
    ...Array.from({ length: 12 }, (_, i) => textEl(`e${i}`, `Item ${i}`, { y: 300 + i * 100, h: 80, source: 'ai-agent' })),
  ];
  const t1 = await turn(page7, [], async (call) => {
    assert.equal((await call('clear_page', {})).ok, true);
  });
  assert.equal(t1.wire.length, 13);
  assert.equal(t1.line, 'Waiting for Apply: 13 changes — Clear the page: remove 13 elements.');
  // "and make the background plain white" — no longer "a separate setting I can't change".
  const t2 = await turn(page7, t1.wire, async (call) => {
    assert.equal((await call('set_page_background', { clear: true })).ok, true);
  });
  assert.equal(t2.wire.length, 14);
  assert.deepEqual(ids(t2.wire).slice(0, 13), ids(t1.wire));
  assert.equal(t2.line, 'Waiting for Apply: 14 changes (1 new, 13 from earlier messages) — Set the page background to plain white.');
  // The background change itself survives a message after it.
  const t3 = await turn(page7, t2.wire, async () => {});
  assert.deepEqual(ids(t3.wire), ids(t2.wire));
  assert.deepEqual(t3.wire[13]!.background, { type: 'none' });
  assert.equal(applyAll(page7, t3.wire).length, 0, 'the page is blank once applied');
});

test('the same change sent twice is kept once; one whose element is gone is dropped and said', async () => {
  const stored = page3();
  const t1 = await turn(stored, [], async (call) => {
    await call('set_element_style', { elementId: 'title', color: '#0a2342' });
  });
  const twice = [...t1.wire, ...t1.wire];
  const t2 = await turn(stored, twice, async () => {});
  assert.equal(t2.wire.length, 1);
  // The client deleted the title by hand meanwhile: the waiting restyle cannot apply.
  const t3 = await turn(stored.filter((e) => e.id !== 'title'), t1.wire, async () => {});
  assert.equal(t3.wire.length, 0);
  assert.equal(t3.dropped, 1);
  assert.equal(t3.line, 'Nothing is waiting for Apply now.');
});

test('the reply that described the page-3 change without staging it is caught', async () => {
  const stored = page3();
  const t = await turn(stored, [], async () => {});
  const reply = "I've staged the change for you to review. All six paragraphs are 20px and 220px tall, with 14px gaps.";
  assert.equal(claimsChange(reply), true);
  assert.equal(t.wire.length, 0, 'no tool was called');
  assert.equal(t.line, 'Nothing was changed.', 'the line the reply ends with says so whatever the model wrote');
});

test('the attached NZTROF PDF is listed ONCE, under the id the chat knows, readable, with its page count', async () => {
  const { COL } = await import('../../src/lib/magazineV2/collections.ts');
  ROWS[COL.media] = [
    { _id: 'att1', magazineId: 'm1', kind: 'doc', originalName: 'NZTROF Owners Experience.pdf', contentType: 'application/pdf', sourceText: 'NZTROF welcomes new owners.', sourceDocId: 'src9' },
  ];
  ROWS[COL.sourceDocs] = [
    { _id: 'src9', magazineId: 'm1', originalName: 'NZTROF Owners Experience.pdf', contentType: 'application/pdf', status: 'ready', coverage: { pagesTotal: 6 } },
    { _id: 'brief', magazineId: 'm1', originalName: 'Brief.pdf', contentType: 'application/pdf', status: 'ready', coverage: { pagesTotal: 2 } },
  ];
  try {
    const t = await turn(page3(), [], async (call) => {
      const r = await call('list_documents', {});
      assert.deepEqual(
        r.documents.map((d: { docId: string; pages: number; hasText: boolean; from: string }) => [d.docId, d.pages, d.hasText, d.from]),
        [
          ['brief', 2, true, 'source'],
          ['att1', 6, true, 'attached'],
        ],
      );
    });
    assert.equal(t.wire.length, 0);
  } finally {
    ROWS[COL.media] = [];
    ROWS[COL.sourceDocs] = [];
  }
});
