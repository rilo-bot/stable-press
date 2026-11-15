// The Studio agent's tool modules, after agent.ts was split into agentTools/.
//
// The split was a pure refactor: every tool kept its name, schema and description,
// and the SYSTEM prompt came out byte-identical. What these tests pin is the part
// that can drift once three modules grow independently:
//   - the twenty original tools are still offered, in their original order (the
//     tool list is part of what the model reads), with new tools after them;
//   - owners get the page-structure tools and collaborators do not;
//   - no two modules define the same tool name (buildTools refuses that);
//   - the shared staging helper keeps its refusals and its one-level merge.
//
// agent.ts and the tool modules reach lib/db.ts, which throws at import without a
// MONGODB_URI. The client connects lazily, so an unroutable placeholder is enough —
// nothing here ever queries.

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import type { MagazineElement } from '../../src/lib/magazineV2/model.ts';
import type { AgentCtx, PromptSection } from '../../src/lib/magazineV2/agentTools/shared.ts';

// Loaded in a hook (this test file is not an ES module, so no top-level await), and
// only after the placeholder URI is set.
let agent: typeof import('../../src/lib/magazineV2/agent.ts');
let shared: typeof import('../../src/lib/magazineV2/agentTools/shared.ts');
let EDIT_PROMPT: PromptSection;
let ADD_PROMPT: PromptSection;
let STRUCTURE_PROMPT: PromptSection;
before(async () => {
  process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:9/agent-tools-test-never-connects';
  agent = await import('../../src/lib/magazineV2/agent.ts');
  shared = await import('../../src/lib/magazineV2/agentTools/shared.ts');
  ({ EDIT_PROMPT } = await import('../../src/lib/magazineV2/agentTools/editTools.ts'));
  ({ ADD_PROMPT } = await import('../../src/lib/magazineV2/agentTools/addTools.ts'));
  ({ STRUCTURE_PROMPT } = await import('../../src/lib/magazineV2/agentTools/structureTools.ts'));
});

/** The tools as they were offered before the split, in that order. */
const ORIGINAL_TOOLS = [
  'get_page', 'list_media', 'set_element_text', 'set_element_style', 'move_element',
  'set_element_image', 'set_qr_link', 'add_element', 'use_image_as_layout', 'list_documents',
  'use_document_as_layout', 'add_media_image', 'add_stock_image', 'generate_image',
  'delete_element', 'change_text_to_image', 'add_page', 'add_content_pages', 'remove_page',
  'reorder_pages',
];
const OWNER_ONLY = ['add_page', 'add_content_pages', 'remove_page', 'reorder_pages'];

let seq = 0;
const el = (o: Partial<MagazineElement>): MagazineElement => ({
  id: `e${++seq}`, type: 'text', x: 0, y: 0, w: 400, h: 100,
  rotation: 0, zIndex: 1, locked: false, source: 'ai',
  text: { role: 'body', content: 'Hello', color: '#111111', fontSize: 20 },
  ...o,
} as MagazineElement);

function ctxWith(elements: MagazineElement[]): AgentCtx {
  return {
    working: elements.map((e) => ({ ...e })),
    proposals: [],
    magazineId: 'm1',
    pageIndex: 0,
    seq: 0,
    page: { width: 1240, height: 1754, background: { type: 'color', value: '#ffffff' } },
    original: elements.map((e) => ({ ...e })),
    deadline: Date.now() + 90_000,
    looks: 0,
  };
}

test('buildTools offers the original tools in their original order, new ones after', () => {
  const names = Object.keys(agent.buildTools(ctxWith([]), true));
  assert.deepEqual(names.filter((n) => ORIGINAL_TOOLS.includes(n)), ORIGINAL_TOOLS);
  // Anything new comes after every original tool.
  const lastOriginal = Math.max(...ORIGINAL_TOOLS.map((n) => names.indexOf(n)));
  assert.equal(lastOriginal, ORIGINAL_TOOLS.length - 1);
});

test('collaborators are not offered the page-structure tools; the layout tools stay', () => {
  const names = Object.keys(agent.buildTools(ctxWith([]), false));
  for (const n of OWNER_ONLY) assert.ok(!names.includes(n), `${n} must be omitted`);
  assert.ok(names.includes('use_image_as_layout'));
  assert.ok(names.includes('use_document_as_layout'));
  assert.deepEqual(
    names.filter((n) => ORIGINAL_TOOLS.includes(n)),
    ORIGINAL_TOOLS.filter((n) => !OWNER_ONLY.includes(n)),
  );
});

test('every tool has a description and a schema', () => {
  for (const [name, t] of Object.entries(agent.buildTools(ctxWith([]), true))) {
    const def = t as { description?: string; inputSchema?: unknown };
    assert.ok(def.description && def.description.length > 10, `${name} has a description`);
    assert.ok(def.inputSchema, `${name} has an input schema`);
  }
});

test('stageUpdate merges one level into the working copy and stages an update', () => {
  const head = el({ id: 'h1', text: { role: 'headline', content: 'Old', color: '#000000', fontSize: 40 } as MagazineElement['text'] });
  const ctx = ctxWith([head]);
  const r = shared.stageUpdate(ctx, 'h1', { text: { content: 'New' } }, 'Rewrote the headline');
  assert.deepEqual(r, { ok: true, summary: 'Rewrote the headline' });
  const now = shared.find(ctx, 'h1')!;
  assert.equal(now.text!.content, 'New');
  assert.equal(now.text!.fontSize, 40, 'sibling fields survive the merge');
  assert.equal(ctx.original[0].text!.content, 'Old', 'the loaded page is never touched');
  assert.equal(ctx.proposals.length, 1);
  assert.equal(ctx.proposals[0].kind, 'update');
  assert.equal(ctx.proposals[0].id, 'p1');
});

test('stageUpdate refuses unknown ids, locked elements and a staged layout rebuild', () => {
  const ctx = ctxWith([el({ id: 'a' }), el({ id: 'b', locked: true })]);
  assert.match(String((shared.stageUpdate(ctx, 'zz', {}, 's') as { error: string }).error), /No element #zz/);
  assert.match(String((shared.stageUpdate(ctx, 'b', { x: 1 }, 's') as { error: string }).error), /locked/);
  ctx.proposals.push({ id: 'p9', kind: 'apply-layout', summary: 'Rebuild' });
  assert.equal((shared.stageUpdate(ctx, 'a', { x: 1 }, 's') as { error: string }).error, shared.LAYOUT_CLASH);
  assert.equal(ctx.proposals.length, 1, 'nothing staged by the refusals');
});

test('a staged change that leaves text cut off carries the fit warning; a later fix takes it off', () => {
  const body = el({ id: 'b1', x: 40, y: 40, w: 120, h: 24, text: { role: 'body', content: 'Short', color: '#111111', fontSize: 20 } as MagazineElement['text'] });
  const ctx = ctxWith([body]);
  shared.stageUpdate(ctx, 'b1', { text: { content: 'word '.repeat(400) } }, 'Rewrote the body');
  const first = ctx.proposals[0]!;
  assert.match(String(first.warning), /^Will not fit its box: needs \d+px, box is 24px\.$/);
  // A tool's own warning rides along after the fit sentence, once.
  shared.warnProposals([first], 'This removes most of the box’s existing text.');
  shared.warnProposals([first], 'This removes most of the box’s existing text.');
  assert.match(String(first.warning), /^Will not fit its box: needs \d+px, box is 24px\. This removes most of the box’s existing text\.$/);
  // A colour change does not touch the fit: nothing moves.
  shared.stageUpdate(ctx, 'b1', { text: { color: '#222222' } }, 'Recoloured the body');
  assert.match(String(first.warning), /^Will not fit its box/, 'the fit sentence stays on the change that caused it');
  // Back to a short text: it fits, so the fit sentence goes — the tool's warning stays.
  shared.stageUpdate(ctx, 'b1', { text: { content: 'Short again' } }, 'Rewrote the body');
  assert.equal(first.warning, 'This removes most of the box’s existing text.');
  assert.equal(ctx.proposals[2]!.warning, undefined);
});

test('the fit warning lives on the LATEST change to an element, with its numbers', () => {
  const body = el({ id: 'b2', x: 40, y: 40, w: 120, h: 24, text: { role: 'body', content: 'Short', color: '#111111', fontSize: 20 } as MagazineElement['text'] });
  const ctx = ctxWith([body]);
  shared.stageUpdate(ctx, 'b2', { text: { content: 'word '.repeat(400) } }, 'Rewrote the body');
  shared.stageUpdate(ctx, 'b2', { h: 30 }, 'Made the body taller');
  assert.equal(ctx.proposals[0]!.warning, undefined, 'moved to the newer change');
  assert.match(String(ctx.proposals[1]!.warning), /^Will not fit its box: needs \d+px, box is 30px\.$/);
  // A new element staged too small says so as well.
  const added = shared.stageAdd(ctx, { type: 'text', x: 400, y: 400, w: 120, h: 24, text: { role: 'body', content: 'word '.repeat(400), color: '#111111', fontSize: 20 } }, 'Added a text box');
  assert.equal(added.ok, true);
  assert.match(String(ctx.proposals[2]!.warning), /^Will not fit its box/);
  // Pictures and other non-text elements never get a fit sentence.
  const pic = el({ id: 'i1', type: 'image', text: undefined, image: { url: 'https://example.com/a.jpg', alt: '', fit: 'cover' } as MagazineElement['image'] });
  assert.equal(shared.fitWarning(pic, { width: 1240, height: 1754 }), undefined);
});

test('warnProposals caps a warning at the length a replay keeps', () => {
  const p = { id: 'p1', kind: 'delete' as const, summary: 's' };
  shared.warnProposals([p, undefined], 'y'.repeat(500));
  assert.equal((p as { warning?: string }).warning!.length, shared.MAX_WARNING_CHARS);
  shared.warnProposals([p], '   ');
  assert.equal((p as { warning?: string }).warning!.length, shared.MAX_WARNING_CHARS);
});

test('describeElement, elLabel and textPreview', () => {
  const t = el({ id: 'x1', x: 10.4, y: 20.6, w: 300, h: 80, zIndex: 2, text: { role: 'headline', content: '<b>Big</b> day', color: '#111111', fontSize: 48.3 } as MagazineElement['text'] });
  assert.equal(shared.describeElement(t, 'x1'), '- #x1 text headline "Big day" #111111 48px body font @(10,21 300x80) z2 (THIS — the selected element)');
  assert.equal(shared.elLabel(t), 'headline');
  assert.equal(shared.elLabel(el({ text: { role: 'other', content: '', color: '#000', fontSize: 10 } as MagazineElement['text'] })), 'text');
  assert.equal(shared.textPreview('<i>' + 'a'.repeat(50) + '</i>'), `${'a'.repeat(40)}…`);
  const scrim = el({ id: 's', type: 'shape', text: undefined, shape: { fill: '#000000', opacity: 0.4 } as MagazineElement['shape'] });
  assert.match(shared.describeElement(scrim), /fill #000000 at 40% opacity/);
});

test('pageDims hands the write pipeline only width and height', () => {
  assert.deepEqual(shared.pageDims(ctxWith([])), { width: 1240, height: 1754 });
});

test('prompt sections: structure rules follow the capability; slots return plain lines', () => {
  const owner = STRUCTURE_PROMPT.rules!({ canEditStructure: true }).join('\n');
  const collab = STRUCTURE_PROMPT.rules!({ canEditStructure: false }).join('\n');
  assert.match(owner, /add_content_pages/);
  assert.match(collab, /only the magazine’s owner can/);
  for (const section of [EDIT_PROMPT, ADD_PROMPT, STRUCTURE_PROMPT]) {
    for (const slot of ['rules', 'attachedImages', 'sourceDocument', 'extra'] as const) {
      const lines = section[slot]?.({ canEditStructure: true }) ?? [];
      for (const line of lines) assert.equal(typeof line, 'string');
    }
  }
});
