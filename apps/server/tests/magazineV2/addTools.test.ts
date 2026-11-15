// The Studio agent's add tools (agentTools/addTools.ts), driven the way the model
// drives them — but only along paths that never reach the database, storage, the
// chart renderer or the image model. Those are covered by the pure rules
// (agentAddPure.test.ts); this file pins that the tools USE them:
//   - a new text box is set in the page's own type for its role, on top (C55, C51);
//   - an asked-for size that does not fit grows the box into free space;
//   - a scrim lands between the photo and the headline, and words it would cover are
//     raised (C51 verifier);
//   - generate_image refuses a chart and names add_chart, even with no image model;
//   - add_chart / update_chart refuse what cannot work before drawing anything;
//   - set_element_image can switch a cropped picture to "contain" (C39).
//
// addTools.ts reaches lib/db.ts, which throws at import without a MONGODB_URI. The
// client connects lazily, so an unroutable placeholder is enough — nothing here queries.
//
// Run: npx tsx --test tests/magazineV2/addTools.test.ts   (from apps/server)

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import type { MagazineElement } from '../../src/lib/magazineV2/model.ts';
import type { AgentCtx } from '../../src/lib/magazineV2/agentTools/shared.ts';

let addTools: typeof import('../../src/lib/magazineV2/agentTools/addTools.ts').addTools;
let ADD_PROMPT: typeof import('../../src/lib/magazineV2/agentTools/addTools.ts').ADD_PROMPT;
let CHART_GUARD_MESSAGE: string;
let NO_ROOM_FOR_CHART: string;
before(async () => {
  process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:9/add-tools-test-never-connects';
  ({ addTools, ADD_PROMPT } = await import('../../src/lib/magazineV2/agentTools/addTools.ts'));
  ({ CHART_GUARD_MESSAGE } = await import('../../src/lib/magazineV2/chartSpec.ts'));
  ({ NO_ROOM_FOR_CHART } = await import('../../src/lib/magazineV2/agentAddPure.ts'));
});

const PAGE = { width: 1240, height: 1754 };

let seq = 0;
function text(o: Partial<MagazineElement> & { t?: Partial<NonNullable<MagazineElement['text']>> } = {}): MagazineElement {
  const { t, ...rest } = o;
  return {
    id: `t${++seq}`,
    type: 'text',
    x: 100,
    y: 100,
    w: 500,
    h: 120,
    rotation: 0,
    zIndex: 1,
    locked: false,
    source: 'ai-agent',
    text: {
      content: 'Hello there',
      role: 'body',
      fontFamily: 'Lora, Georgia, serif',
      fontSize: 20,
      maxFontSize: 20,
      fontWeight: 400,
      color: '#222222',
      align: 'left',
      lineHeight: 1.45,
      autoFit: 'shrink',
      ...t,
    },
    ...rest,
  } as MagazineElement;
}
function image(o: Partial<MagazineElement> & { url?: string } = {}): MagazineElement {
  const { url = 'https://cdn.example.com/a.jpg', ...rest } = o;
  return {
    id: `i${++seq}`,
    type: 'image',
    x: 0,
    y: 0,
    w: 600,
    h: 400,
    rotation: 0,
    zIndex: 0,
    locked: false,
    source: 'ai-agent',
    image: { url, assetId: '', alt: 'A photo', fit: 'cover' },
    ...rest,
  } as MagazineElement;
}

function ctxWith(elements: MagazineElement[], over: Partial<AgentCtx> = {}): AgentCtx {
  return {
    working: elements.map((e) => ({ ...e })),
    proposals: [],
    magazineId: 'm1',
    pageIndex: 0,
    seq: 0,
    page: { ...PAGE, background: { type: 'color', value: '#ffffff' } },
    original: elements.map((e) => ({ ...e })),
    deadline: Date.now() + 90_000,
    looks: 0,
    ...over,
  };
}

type Result = Record<string, unknown> & { ok: boolean; error?: string };
async function run(ctx: AgentCtx, name: string, input: Record<string, unknown>): Promise<Result> {
  const tools = addTools(ctx) as unknown as Record<string, { execute?: (i: unknown, o: unknown) => Promise<unknown> }>;
  const t = tools[name];
  assert.ok(t?.execute, `${name} exists`);
  return (await t.execute!(input, { toolCallId: 'call-1', messages: [] })) as Result;
}

test('the add module offers the chart tools', () => {
  const names = Object.keys(addTools(ctxWith([])));
  for (const n of ['list_media', 'set_element_image', 'add_element', 'add_media_image', 'add_stock_image', 'generate_image', 'add_chart', 'update_chart', 'change_text_to_image']) {
    assert.ok(names.includes(n), `${n} is offered`);
  }
});

test('add_element text: the page’s own type for the role, on top, never inherit (C55/C51)', async () => {
  const caption = text({ id: 'cap', zIndex: 4, t: { role: 'caption', content: 'Photo: Trish Dunell at Ellerslie', fontFamily: 'Inter, sans-serif', fontSize: 15, maxFontSize: 17, color: '#555555' } });
  const ctx = ctxWith([caption, image({ zIndex: 8, x: 600, y: 900 })]);
  const r = await run(ctx, 'add_element', { type: 'text', x: 100, y: 700, w: 400, h: 60, content: 'Source: NZTR', role: 'caption' });
  assert.equal(r.ok, true);
  const added = ctx.working[ctx.working.length - 1]!;
  assert.equal(added.text!.fontFamily, 'Inter, sans-serif');
  assert.equal(added.text!.role, 'caption');
  assert.equal(added.text!.color, '#555555');
  assert.equal(added.text!.maxFontSize, 17);
  assert.equal(added.zIndex, 9, 'above everything already on the page');
  assert.equal(ctx.proposals.length, 1);
  assert.equal(ctx.proposals[0]!.kind, 'add');
  assert.match(ctx.proposals[0]!.summary, /caption box “Source: NZTR”/);
  assert.equal((r.fit as { fits: boolean }).fits, true);

  // No text of that role on the page and no theme: still never the app's font.
  const blank = ctxWith([]);
  await run(blank, 'add_element', { type: 'text', x: 100, y: 100, w: 600, h: 200, content: 'Hello' });
  assert.notEqual(blank.working[0]!.text!.fontFamily, 'inherit');
  assert.equal(blank.working[0]!.text!.role, 'body');
});

test('add_element text on a dark panel gets a readable ink', async () => {
  const panel: MagazineElement = { ...image(), id: 'pn', type: 'shape', image: undefined, shape: { fill: '#0a2342' }, x: 0, y: 0, w: 800, h: 600, zIndex: 2 } as MagazineElement;
  const ctx = ctxWith([panel, text({ id: 'b', x: 900, y: 900, w: 300, h: 200, t: { content: 'Long body copy on white paper', color: '#222222' } })]);
  await run(ctx, 'add_element', { type: 'text', x: 50, y: 50, w: 500, h: 100, content: 'On the panel', role: 'body' });
  assert.equal(ctx.working[ctx.working.length - 1]!.text!.color, '#ffffff');
});

test('add_element: an asked-for size that does not fit grows the box into free space', async () => {
  const ctx = ctxWith([]);
  const long = 'The New Owners Group is embarking on one of the most significant initiatives in years. '.repeat(3);
  const r = await run(ctx, 'add_element', { type: 'text', x: 100, y: 100, w: 500, h: 60, content: long, fontSize: 28 });
  assert.equal(r.ok, true);
  const el = ctx.working[0]!;
  assert.equal(el.text!.fontSize, 28, 'the asked size is kept');
  assert.equal(el.text!.maxFontSize, 28, 'and is the ceiling');
  assert.ok(el.h > 60, 'the box grew');
  assert.match(String(r.note), /taller/);
  assert.equal((r.fit as { fits: boolean }).fits, true);
});

test('add_element: with no room to grow, the result says so in numbers', async () => {
  const below = image({ id: 'below', x: 100, y: 170, w: 500, h: 400 });
  const ctx = ctxWith([below]);
  const long = 'The New Owners Group is embarking on one of the most significant initiatives in years. '.repeat(3);
  const r = await run(ctx, 'add_element', { type: 'text', x: 100, y: 100, w: 500, h: 60, content: long, fontSize: 28 });
  assert.equal(r.ok, true);
  assert.match(String(r.note), /At 28px the text needs \d+px of height; the box is 60px/);
});

test('add_element shape: a scrim sits above the photo and below the headline (C51)', async () => {
  const photo = image({ id: 'ph', x: 0, y: 0, w: 1240, h: 900, zIndex: 8 });
  const head = text({ id: 'hd', x: 80, y: 600, w: 900, h: 200, zIndex: 12, t: { role: 'headline', content: 'Big day' } });
  const ctx = ctxWith([photo, head]);
  const r = await run(ctx, 'add_element', { type: 'shape', x: 0, y: 500, w: 1240, h: 400, color: '#000000', opacity: 0.5 });
  assert.equal(r.ok, true);
  assert.equal(r.zIndex, 9);
  assert.equal(ctx.proposals.length, 1, 'nothing needed raising');
});

test('add_element shape on a copied PDF page raises the words it would cover', async () => {
  const photo = image({ id: 'ph', x: 0, y: 0, w: 800, h: 600, zIndex: 0 });
  const t1 = text({ id: 'a', x: 50, y: 400, w: 600, h: 80, zIndex: 1 });
  const ctx = ctxWith([photo, t1]);
  const r = await run(ctx, 'add_element', { type: 'shape', x: 0, y: 380, w: 800, h: 220, color: '#000000', opacity: 0.4 });
  assert.equal(r.zIndex, 1);
  assert.deepEqual(r.raised, ['#a']);
  const lift = ctx.proposals.find((p) => p.kind === 'update');
  assert.equal(lift?.elementId, 'a');
  assert.deepEqual(lift?.patch, { zIndex: 2 });
  assert.equal(ctx.working.find((e) => e.id === 'a')!.zIndex, 2);
});

test('add_element qr goes on top', async () => {
  const ctx = ctxWith([text({ zIndex: 5 })]);
  const r = await run(ctx, 'add_element', { type: 'qr', x: 900, y: 1400, w: 200, h: 200, url: 'https://example.com' });
  assert.equal(r.zIndex, 6);
});

test('generate_image refuses a chart and names add_chart — before anything else (C02/C16)', async () => {
  const ctx = ctxWith([]);
  const r = await run(ctx, 'generate_image', { prompt: 'a bar chart of wins by year: 2022 4, 2023 7, 2024 9', x: 0, y: 0, w: 600, h: 400 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'chart');
  assert.equal(r.error, CHART_GUARD_MESSAGE);
  assert.match(String(r.error), /add_chart/);
  assert.equal(ctx.proposals.length, 0);
});

test('add_chart refuses what cannot be drawn, before drawing anything', async () => {
  const ctx = ctxWith([]);
  const mismatch = await run(ctx, 'add_chart', { type: 'bar', categories: ['2022', '2023'], series: [{ name: 'Wins', values: [4] }] });
  assert.equal(mismatch.ok, false);
  assert.match(String(mismatch.error), /1 value but there are 2 categories/);
  const half = await run(ctx, 'add_chart', { type: 'bar', categories: ['a', 'b'], series: [{ name: 'n', values: [1, 2] }], x: 10, y: 10 });
  assert.match(String(half.error), /x, y, w and h/);
  const packed = ctxWith([text({ x: 0, y: 0, w: 1240, h: 1754 })]);
  const none = await run(packed, 'add_chart', { type: 'bar', categories: ['a', 'b'], series: [{ name: 'n', values: [1, 2] }] });
  assert.equal(none.error, NO_ROOM_FOR_CHART);
  const lockedCtx = ctxWith([image({ id: 'lk', locked: true })]);
  const locked = await run(lockedCtx, 'add_chart', { type: 'pie', categories: ['a', 'b'], series: [{ name: 'n', values: [1, 2] }], replaceElementId: 'lk' });
  assert.match(String(locked.error), /locked/);
  for (const c of [ctx, packed, lockedCtx]) assert.equal(c.proposals.length, 0, 'nothing staged');
});

test('add_chart with the turn nearly over says so instead of starting a render', async () => {
  const ctx = ctxWith([], { deadline: Date.now() - 1 });
  const r = await run(ctx, 'add_chart', { type: 'bar', categories: ['a', 'b'], series: [{ name: 'n', values: [1, 2] }] });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /not enough time left in this turn to draw the chart/);
});

test('add tools refuse while a layout rebuild is staged', async () => {
  const ctx = ctxWith([]);
  ctx.proposals.push({ id: 'p9', kind: 'apply-layout', summary: 'Rebuild' });
  for (const [name, input] of [
    ['add_element', { type: 'text', x: 0, y: 0, w: 100, h: 50 }],
    ['add_chart', { type: 'bar', categories: ['a'], series: [{ name: 'n', values: [1] }] }],
    ['generate_image', { prompt: 'a horse', x: 0, y: 0, w: 100, h: 100 }],
  ] as const) {
    const r = await run(ctx, name, input as Record<string, unknown>);
    assert.match(String(r.error), /layout rebuild/, name);
  }
});

test('update_chart: only a drawn chart has numbers to change', async () => {
  const ctx = ctxWith([text({ id: 'tx' }), image({ id: 'ph' })]);
  const notImage = await run(ctx, 'update_chart', { elementId: 'tx', changes: { title: 'x' } });
  assert.match(String(notImage.error), /Not an image element/);
  const photo = await run(ctx, 'update_chart', { elementId: 'ph', changes: { setValues: [{ category: '2023', value: 14 }] } });
  assert.match(String(photo.error), /not a chart drawn from data/);
  assert.match(String(photo.error), /add_chart with replaceElementId: "ph"/);
  assert.equal(ctx.proposals.length, 0);
});

test('set_element_image switches a cropped picture to show whole, without a url (C39)', async () => {
  const ctx = ctxWith([image({ id: 'ph' })]);
  const r = await run(ctx, 'set_element_image', { elementId: 'ph', fit: 'contain' });
  assert.equal(r.ok, true);
  assert.deepEqual(ctx.proposals[0]!.patch, { image: { fit: 'contain' } });
  assert.equal(ctx.working[0]!.image!.fit, 'contain');
  assert.equal(ctx.working[0]!.image!.url, 'https://cdn.example.com/a.jpg', 'the picture itself is kept');
  const nothing = await run(ctx, 'set_element_image', { elementId: 'ph' });
  assert.equal(nothing.ok, false);
});

test('change_text_to_image points a chart request at add_chart', async () => {
  const ctx = ctxWith([text({ id: 'tx' })]);
  const r = await run(ctx, 'change_text_to_image', { elementId: 'tx', query: 'pie chart of prize money by race' });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /add_chart with replaceElementId "tx"/);
  assert.equal(ctx.proposals.length, 0);
});

test('ADD_PROMPT routes pictures by style and charts to add_chart', () => {
  const rules = ADD_PROMPT.rules!({ canEditStructure: true }).join('\n');
  assert.match(rules, /add_chart with the EXACT numbers/);
  assert.match(rules, /NEVER use generate_image or add_stock_image for a chart/);
  assert.match(rules, /illustration/);
  assert.match(rules, /poster/);
  assert.match(rules, /fit "contain"/);
  assert.ok(!rules.includes('`'), 'no backticks');
});

test('change_text_to_image treats a drop-cap paragraph as ONE paragraph, never one piece', async () => {
  const { buildDropCap } = await import('./dropCapFixture.ts');
  const dc = buildDropCap(
    'Winter racing at Ellerslie drew the biggest crowd in a decade, and the feature race lived up to it with a finish that will be talked about for years to come.',
  );
  // A locked piece anywhere in the paragraph refuses the whole swap, naming the paragraph —
  // before any photo is sourced, so nothing is spent and nothing is staged.
  const lockedLead = dc.elements.map((e) => (e.id === dc.lead.id ? { ...e, locked: true } : e));
  const ctx = ctxWith(lockedLead);
  for (const target of [dc.cap.id, dc.key]) {
    const r = await run(ctx, 'change_text_to_image', { elementId: target, query: 'racehorse at the finish' });
    assert.equal(r.ok, false);
    assert.match(String(r.error), new RegExp(`part of the paragraph #${dc.key}`));
  }
  assert.equal(ctx.proposals.length, 0);
  // A chart in its place is still pointed at add_chart, for the paragraph too.
  const open = ctxWith(dc.elements);
  const chart = await run(open, 'change_text_to_image', { elementId: dc.key, query: 'bar chart of attendance by year' });
  assert.equal(chart.ok, false);
  assert.match(String(chart.error), /add_chart/);
  assert.equal(open.proposals.length, 0);
});
