// The Studio agent's structure and document tools (agentTools/structureTools.ts):
// what they offer, what they promise, and the refusals that need no database.
//
//   - collaborators get the whole-page and document tools, never the page tools;
//   - nothing in the prompt or a tool description promises that a layout rebuild
//     keeps the user's words — the rebuild writes new copy (C09/C31);
//   - a page change next to a staged whole-page change is refused at staging (C10),
//     and so is a whole-page change next to anything else;
//   - unstage_changes takes a waiting change back out (C05).
//
// The module reaches lib/db.ts, which throws at import without a MONGODB_URI. The
// client connects lazily, so an unroutable placeholder is enough — every path run
// here refuses BEFORE it would query.

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import type { MagazineElement } from '../../src/lib/magazineV2/model.ts';
import type { AgentCtx, PromptSection } from '../../src/lib/magazineV2/agentTools/shared.ts';
import type { AgentProposal } from '../../src/lib/magazineV2/agent.ts';

let structureTools: typeof import('../../src/lib/magazineV2/agentTools/structureTools.ts').structureTools;
let STRUCTURE_PROMPT: PromptSection;
before(async () => {
  process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:9/structure-tools-test-never-connects';
  ({ structureTools, STRUCTURE_PROMPT } = await import('../../src/lib/magazineV2/agentTools/structureTools.ts'));
});

let seq = 0;
const el = (o: Partial<MagazineElement>): MagazineElement =>
  ({
    id: `e${++seq}`, type: 'text', x: 100, y: 100, w: 400, h: 100,
    rotation: 0, zIndex: 1, locked: false, source: 'ai-agent',
    text: { role: 'body', content: 'Hello', color: '#111111', fontSize: 20 },
    ...o,
  }) as MagazineElement;

function ctxWith(elements: MagazineElement[], proposals: AgentProposal[] = []): AgentCtx {
  return {
    working: elements.map((e) => ({ ...e })),
    proposals: [...proposals],
    magazineId: 'm1',
    pageIndex: 0,
    seq: 10,
    page: { width: 1240, height: 1754 },
    original: elements.map((e) => ({ ...e })),
    deadline: Date.now() + 90_000,
    looks: 0,
  };
}

type Exec = (input: unknown, opts: unknown) => Promise<Record<string, unknown>>;
const run = (tools: Record<string, unknown>, name: string, input: unknown) =>
  ((tools[name] as { execute: Exec }).execute)(input, { toolCallId: 't1', messages: [] });

const PAGE_TOOLS = ['add_page', 'add_content_pages', 'remove_page', 'reorder_pages'];
const ALWAYS = ['use_image_as_layout', 'list_documents', 'read_document', 'use_document_as_layout', 'copy_document_page', 'unstage_changes'];

test('owners get every tool; collaborators get the whole-page and document tools but no page tools', () => {
  const owner = Object.keys(structureTools(ctxWith([]), true));
  for (const n of [...ALWAYS, ...PAGE_TOOLS]) assert.ok(owner.includes(n), `${n} offered to the owner`);
  const collab = Object.keys(structureTools(ctxWith([]), false));
  for (const n of ALWAYS) assert.ok(collab.includes(n), `${n} offered to a collaborator`);
  for (const n of PAGE_TOOLS) assert.ok(!collab.includes(n), `${n} withheld from a collaborator`);
});

const PROMISES_WORDS_KEPT = /keeps the user|own words and photos|own text and photos|carrying the user|flow into the new structure/i;

test('C09/C31: nothing promises that a layout rebuild keeps the user’s words', () => {
  for (const canEditStructure of [true, false]) {
    const prompt = [
      ...STRUCTURE_PROMPT.rules!({ canEditStructure }),
      ...STRUCTURE_PROMPT.attachedImages!({ canEditStructure }),
    ].join('\n');
    assert.doesNotMatch(prompt, PROMISES_WORDS_KEPT);
    assert.match(prompt, /NEWLY WRITTEN copy|newly written copy/);
  }
  const tools = structureTools(ctxWith([]), true) as Record<string, { description?: string }>;
  for (const name of ['use_image_as_layout', 'use_document_as_layout']) {
    const d = tools[name]!.description!;
    assert.doesNotMatch(d, PROMISES_WORDS_KEPT, name);
    assert.match(d, /newly written copy/, name);
    assert.match(d, /cannot be undone/, name);
  }
  assert.match(tools.use_document_as_layout!.description!, /copy_document_page/);
});

test('the always-on rules: whole-page changes stand alone, documents are read not guessed, three PDF asks', () => {
  for (const canEditStructure of [true, false]) {
    const rules = STRUCTURE_PROMPT.rules!({ canEditStructure }).join('\n');
    assert.match(rules, /cannot be staged alongside other edits or page changes/);
    assert.match(rules, /list_documents, then read_document/);
    assert.match(rules, /Never invent names, figures, results or quotes/);
    assert.match(rules, /never say you cannot see a document/);
    assert.match(rules, /copy_document_page/);
  }
  const owner = STRUCTURE_PROMPT.rules!({ canEditStructure: true }).join('\n');
  assert.match(owner, /AS IT IS NOW/);
  assert.match(owner, /pass its docId to\s+add_content_pages/);
  // The rebuild-on-its-own sentence moved out of the attached-images block (C10).
  assert.doesNotMatch(STRUCTURE_PROMPT.attachedImages!({ canEditStructure: true }).join('\n'), /do it on its own turn/);
});

test('C10: page changes are refused while a whole-page change is staged', async () => {
  for (const kind of ['apply-layout', 'copy-document-page'] as const) {
    const ctx = ctxWith([], [{ id: 'p1', kind, summary: 'whole page' }]);
    const tools = structureTools(ctx, true);
    for (const [name, input] of [
      ['add_page', {}],
      ['add_content_pages', { count: 2 }],
      ['remove_page', { page: 2 }],
      ['reorder_pages', { from: 2, to: 3 }],
    ] as const) {
      const r = await run(tools, name, input);
      assert.equal(r.ok, false, `${name} refused next to ${kind}`);
      assert.match(String(r.error), /applied on its own/);
    }
    assert.equal(ctx.proposals.length, 1, 'nothing staged by the refusals');
  }
});

test('a whole-page change is refused when anything is already staged', async () => {
  const ctx = ctxWith([el({ id: 'h' })], [{ id: 'p1', kind: 'update', elementId: 'h', patch: { x: 1 }, summary: 'Nudged' }]);
  const tools = structureTools(ctx, false);
  const copy = await run(tools, 'copy_document_page', { docId: 'd1', sourcePage: 2 });
  assert.equal(copy.ok, false);
  assert.match(String(copy.error), /1 change is already staged/);
  const img = await run(tools, 'use_image_as_layout', { url: 'https://x/y.png' });
  assert.equal(img.ok, false);
  const doc = await run(tools, 'use_document_as_layout', { docId: 'd1' });
  assert.equal(doc.ok, false);
  assert.equal(ctx.proposals.length, 1);
});

test('a layout read is not started when the turn is nearly out of time', async () => {
  const ctx = ctxWith([]);
  ctx.deadline = Date.now() + 5_000;
  const r = await run(structureTools(ctx, true), 'use_image_as_layout', { url: 'https://x/y.png' });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /not enough time left/);
});

test('C05: unstage_changes takes a waiting change out and the page shows the rest', async () => {
  const head = el({ id: 'h1', text: { role: 'headline', content: 'Head', color: '#111111', fontSize: 40 } as MagazineElement['text'] });
  const ctx = ctxWith([head], [
    { id: 'p1', kind: 'update', elementId: 'h1', patch: { text: { color: '#ff0000' } }, summary: 'Red headline' },
    { id: 'p2', kind: 'update', elementId: 'h1', patch: { x: 300 }, summary: 'Moved the headline' },
  ]);
  // The working copy as the turn would have it, both changes applied.
  ctx.working = [{ ...head, x: 300, text: { ...head.text!, color: '#ff0000' } }];
  const tools = structureTools(ctx, false);

  const unknown = await run(tools, 'unstage_changes', { ids: ['zz'] });
  assert.equal(unknown.ok, false);
  assert.deepEqual(unknown.staged, [
    { id: 'p1', summary: 'Red headline' },
    { id: 'p2', summary: 'Moved the headline' },
  ]);

  const r = await run(tools, 'unstage_changes', { ids: ['p2'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.removed, ['Moved the headline']);
  assert.equal(r.stillStaged, 1);
  assert.deepEqual(ctx.proposals.map((p) => p.id), ['p1']);
  assert.equal(ctx.working[0]!.x, 100, 'the move is gone from the page');
  assert.equal(ctx.working[0]!.text!.color, '#ff0000', 'the colour change is still shown');
});
