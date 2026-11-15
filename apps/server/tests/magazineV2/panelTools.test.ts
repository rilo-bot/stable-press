// ---------------------------------------------------------------------------
// The Studio's panel-parity tools (agentTools/panelTools.ts) and the new options on the
// edit tools, run against a working copy — no model, no real database.
//
// Each test is one thing the client could do by hand in the Page & Element panel (or
// asked for in one sentence) that the assistant could not: change the page background,
// empty a page, set a picture to Contain and make its box the picture's shape, recolour
// a QR code, change an icon, duplicate, rotate, send to back, pick a font, justify,
// align to the middle — and arrange six boxes in one step.
//
// lib/db.ts throws at import without a MONGODB_URI, so a placeholder is set; the media
// collection is replaced with an in-memory one so nothing ever connects.
// ---------------------------------------------------------------------------

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import type { ElementTextData, MagazineElement } from '../../src/lib/magazineV2/model.ts';
import type { AgentCtx } from '../../src/lib/magazineV2/agentTools/shared.ts';

type Tools = Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>;
let buildTools: typeof import('../../src/lib/magazineV2/agent.ts').buildTools;
const MEDIA: Record<string, unknown>[] = [
  { _id: 'bgPhoto', magazineId: 'm1', kind: 'upload', url: 'https://cdn.test/m1/track.jpg', alt: 'Track at dawn' },
  { _id: 'ref', magazineId: 'm1', kind: 'reference', url: 'https://cdn.test/m1/ref.jpg', alt: 'Someone else’s page' },
  { _id: 'chartRow', magazineId: 'm1', kind: 'upload', url: 'https://cdn.test/m1/chart.png', alt: 'Prize money chart', width: 1560, height: 730 },
];

before(async () => {
  process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:9/panel-tools-test-never-connects';
  const { db } = await import('../../src/lib/db.ts');
  (db as { collection: unknown }).collection = () => ({
    find: async (q: Record<string, unknown> = {}) => MEDIA.filter((m) => Object.entries(q).every(([k, v]) => m[k] === v)),
    findById: async () => null,
  });
  ({ buildTools } = await import('../../src/lib/magazineV2/agent.ts'));
});

const PAGE = { width: 1240, height: 1754 };

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
const imageEl = (id: string, url: string, over: Partial<MagazineElement> = {}, assetId = ''): MagazineElement =>
  ({ id, type: 'image', x: 100, y: 400, w: 640, h: 480, rotation: 0, zIndex: 2, locked: false, source: 'manual', image: { url, assetId, alt: 'Chart', fit: 'cover' }, ...over }) as MagazineElement;
const qrEl = (id: string): MagazineElement =>
  ({ id, type: 'qr', x: 900, y: 1500, w: 160, h: 160, rotation: 0, zIndex: 6, locked: false, source: 'manual', qr: { url: 'https://x.test', fg: '#000000', bg: '#ffffff' } }) as MagazineElement;
const iconEl = (id: string, over: Partial<MagazineElement['icon']> = {}): MagazineElement =>
  ({ id, type: 'icon', x: 900, y: 100, w: 60, h: 60, rotation: 0, zIndex: 7, locked: false, source: 'manual', icon: { name: 'Star', ...over } }) as MagazineElement;

function ctxWith(elements: MagazineElement[], extra: Partial<AgentCtx> = {}): AgentCtx {
  return {
    working: elements.map((e) => ({ ...e })),
    proposals: [],
    magazineId: 'm1',
    pageIndex: 6,
    seq: 0,
    page: { ...PAGE, background: { type: 'color', value: '#f5efe6' } },
    original: elements.map((e) => ({ ...e })),
    deadline: Date.now() - 1,
    looks: 0,
    shownPartly: new Set(),
    readFully: new Set(),
    originalBackground: { type: 'color', value: '#f5efe6' },
    ...extra,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyResult = any;
async function run(ctx: AgentCtx, name: string, input: Record<string, unknown>): Promise<AnyResult> {
  const t = (buildTools(ctx, true) as unknown as Tools)[name];
  assert.ok(t, `tool ${name} exists`);
  return t.execute(input, { toolCallId: 't1', messages: [] });
}

test('every panel-parity tool is offered, after the original tools, to collaborators too', () => {
  for (const canEdit of [true, false]) {
    const names = Object.keys(buildTools(ctxWith([]), canEdit));
    for (const n of ['set_page_background', 'clear_page', 'set_image_fit', 'set_qr_style', 'set_icon', 'duplicate_element', 'arrange_elements']) {
      assert.ok(names.includes(n), `${n} (canEditStructure ${canEdit})`);
    }
  }
});

// ── The page background ──────────────────────────────────────────────────────

test('set_page_background: plain white stages one change, and later checks see the new ground', async () => {
  const ctx = ctxWith([textEl('t', 'Words', { text: { color: '#ffffff' } })]);
  const r = await run(ctx, 'set_page_background', { clear: true });
  assert.equal(r.ok, true);
  assert.deepEqual(ctx.proposals.map((p) => [p.kind, p.background]), [['set-background', { type: 'none' }]]);
  assert.equal(r.summary, 'Set the page background to plain white');
  assert.deepEqual(ctx.page.background, { type: 'color', value: '#ffffff' });
  assert.match(r.warning, /#t .*hard to read|hard to read.*#t/, 'white words on a now-white page are named');
});

test('set_page_background: a later change replaces the earlier one; a bad colour is refused', async () => {
  const ctx = ctxWith([]);
  await run(ctx, 'set_page_background', { color: '#0a2342' });
  const r = await run(ctx, 'set_page_background', { color: '#ffffff' });
  assert.equal(ctx.proposals.length, 1);
  assert.deepEqual(ctx.proposals[0]!.background, { type: 'color', value: '#ffffff' });
  assert.match(r.note, /replaces the background change staged earlier/);
  assert.equal((await run(ctx, 'set_page_background', { color: 'beige' })).ok, false);
});

test('set_page_background: a picture must be one of the magazine’s placeable pictures', async () => {
  const ctx = ctxWith([]);
  const ok = await run(ctx, 'set_page_background', { imageUrl: 'https://cdn.test/m1/track.jpg' });
  assert.equal(ok.ok, true);
  assert.match(ok.summary, /“Track at dawn” as the page background/);
  const ref = await run(ctxWith([]), 'set_page_background', { imageUrl: 'https://cdn.test/m1/ref.jpg' });
  assert.equal(ref.ok, false, 'a layout reference is never placed');
  const invented = await run(ctxWith([]), 'set_page_background', { imageUrl: 'https://evil.test/x.jpg' });
  assert.match(invented.error, /not in the media library/);
});

// ── Clearing a page ──────────────────────────────────────────────────────────

test('clear_page: every unlocked element in ONE call, grouped; locked kept; the background is mentioned', async () => {
  const els = [
    textEl('h', 'Headline', { text: { role: 'headline' } }),
    textEl('b', 'Body'),
    imageEl('p', 'https://cdn.test/m1/track.jpg'),
    iconEl('i'),
    textEl('lk', 'Locked caption', { locked: true }),
    textEl('furniture-folio', '7', { text: { role: 'other' } }),
  ];
  const ctx = ctxWith(els);
  const r = await run(ctx, 'clear_page', { keepFolio: true });
  assert.equal(r.ok, true);
  assert.equal(r.summary, 'Clear the page: remove 4 elements');
  assert.deepEqual(ctx.proposals.map((p) => [p.kind, p.elementId]), [['delete', 'h'], ['delete', 'b'], ['delete', 'p'], ['delete', 'i']]);
  assert.ok(ctx.proposals.every((p) => p.group === 'Clear the page: remove 4 elements'));
  assert.deepEqual(ctx.working.map((e) => e.id), ['lk', 'furniture-folio']);
  assert.match(r.warning, /1 locked element stays/);
  assert.match(r.background, /#f5efe6\) stays — use set_page_background/);
});

test('clear_page takes staged additions back out instead of deleting what does not exist yet', async () => {
  const ctx = ctxWith([textEl('a', 'A')]);
  await run(ctx, 'add_element', { type: 'text', x: 100, y: 600, w: 400, h: 80, content: 'New caption', role: 'caption' });
  await run(ctx, 'set_element_style', { elementId: 'a', color: '#aa0000' });
  const r = await run(ctx, 'clear_page', {});
  assert.equal(r.ok, true);
  assert.deepEqual(ctx.proposals.map((p) => [p.kind, p.elementId]), [['delete', 'a']], 'the add is gone and the pointless restyle with it');
  assert.equal(ctx.working.length, 0);
  assert.match(r.note, /1 addition staged earlier was taken back out/);
});

// ── Pictures: fit, focal point, the box made the picture's shape ─────────────

test('set_image_fit: "set it to contain" works, and a focal point is kept', async () => {
  const ctx = ctxWith([imageEl('c', 'https://cdn.test/m1/chart.png')]);
  const r = await run(ctx, 'set_image_fit', { elementId: 'c', fit: 'contain' });
  assert.equal(r.ok, true);
  assert.equal(r.fit, 'contain');
  assert.deepEqual(ctx.proposals[0]!.patch, { image: { fit: 'contain' } });
  await run(ctx, 'set_image_fit', { elementId: 'c', focalY: 0.2 });
  assert.deepEqual(ctx.working[0]!.image!.focalPoint, { x: 0.5, y: 0.2 });
});

test('set_image_fit fitBoxToImage: the client’s 1426x806 chart in a 640-wide box becomes 640x362, shown whole', async () => {
  const ctx = ctxWith([imageEl('c', 'https://cdn.test/m1/a.png', {}, 'A')], { imageSizes: [{ url: 'https://cdn.test/m1/a.png', assetId: 'A', width: 1426, height: 806 }] });
  const r = await run(ctx, 'set_image_fit', { elementId: 'c', fitBoxToImage: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.box, { x: 100, y: 400, w: 640, h: 362 });
  assert.equal(r.fit, 'contain');
  assert.match(r.summary, /own shape \(640x362\), set to show whole/);
  // From the library row when the turn was not told (1560x730 → 640x299).
  const lib = ctxWith([imageEl('d', 'https://cdn.test/m1/chart.png')]);
  const r2 = await run(lib, 'set_image_fit', { elementId: 'd', fitBoxToImage: true, w: 640 });
  assert.deepEqual(r2.box, { x: 100, y: 400, w: 640, h: 299 });
});

test('set_image_fit fitBoxToImage with no recorded size says so instead of guessing', async () => {
  const ctx = ctxWith([imageEl('c', 'https://cdn.test/m1/unknown.png')]);
  const r = await run(ctx, 'set_image_fit', { elementId: 'c', fitBoxToImage: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /pixel size is not recorded/);
  assert.equal(ctx.proposals.length, 0);
  assert.equal((await run(ctx, 'set_image_fit', { elementId: 'c' })).ok, false);
});

// ── QR codes, icons, duplicates ──────────────────────────────────────────────

test('set_qr_style: colours and link; a code that would stop scanning is refused', async () => {
  const ctx = ctxWith([qrEl('q')]);
  const r = await run(ctx, 'set_qr_style', { elementId: 'q', fg: '#0a2342', url: 'https://club.test/join' });
  assert.equal(r.ok, true);
  assert.deepEqual(ctx.working[0]!.qr, { url: 'https://club.test/join', fg: '#0a2342', bg: '#ffffff' });
  const bad = await run(ctx, 'set_qr_style', { elementId: 'q', fg: '#eeeeee' });
  assert.match(bad.error, /stop scanning/);
  const inverted = await run(ctx, 'set_qr_style', { elementId: 'q', fg: '#ffffff', bg: '#0a2342' });
  assert.match(inverted.warning, /dark on light/);
});

test('set_icon: a glyph from the panel’s set and a colour; an uploaded icon gives way to the glyph', async () => {
  const ctx = ctxWith([iconEl('i'), iconEl('u', { src: 'https://cdn.test/m1/logo.png', name: undefined })]);
  const r = await run(ctx, 'set_icon', { elementId: 'i', name: 'trophy', color: '#C8A04A' });
  assert.equal(r.ok, true);
  assert.deepEqual(ctx.working[0]!.icon, { name: 'Trophy', color: '#c8a04a' });
  await run(ctx, 'set_icon', { elementId: 'u', name: 'Horse' });
  assert.deepEqual(ctx.working[1]!.icon, { name: 'Horse' });
  assert.match((await run(ctx, 'set_icon', { elementId: 'i', name: 'unicornz' })).error, /no icon “unicornz”/);
});

test('duplicate_element: a copy on top, offset, with its own placeholder id', async () => {
  const ctx = ctxWith([textEl('t', 'Copy me', { zIndex: 9 }), imageEl('p', 'https://cdn.test/m1/track.jpg')]);
  const r = await run(ctx, 'duplicate_element', { elementId: 'p' });
  assert.equal(r.ok, true);
  assert.equal(r.zIndex, 10);
  assert.deepEqual(r.box, { x: 120, y: 420, w: 640, h: 480 });
  const add = ctx.proposals[0]!;
  assert.equal(add.kind, 'add');
  assert.equal(add.element!.source, 'ai-agent');
  assert.equal(add.element!.image!.url, 'https://cdn.test/m1/track.jpg');
});

// ── The edit tools' new options ──────────────────────────────────────────────

test('set_element_style: a panel font, justify, middle, letter spacing and case', async () => {
  const ctx = ctxWith([textEl('t', 'Words on the page')]);
  const r = await run(ctx, 'set_element_style', { elementId: 't', fontFamily: 'lora', align: 'justify', vAlign: 'middle', letterSpacing: 1.5, textTransform: 'uppercase' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const t = ctx.working[0]!.text!;
  assert.equal(t.fontFamily, "'Lora', Georgia, serif");
  assert.equal(t.align, 'justify');
  assert.equal(t.vAlign, 'center');
  assert.equal(t.letterSpacing, 1.5);
  assert.equal(t.textTransform, 'uppercase');
  assert.match(r.summary, /in Lora/);
  const bad = await run(ctx, 'set_element_style', { elementId: 't', fontFamily: 'Comic Neue' });
  assert.match(bad.error, /not one of the magazine's fonts/);
  // A weight in hundreds, never silently stored as 400.
  await run(ctx, 'set_element_style', { elementId: 't', fontWeight: 640 });
  assert.equal(ctx.working[0]!.text!.fontWeight, 600);
});

test('move_element: rotation, and To front / To back like the panel’s buttons', async () => {
  const ctx = ctxWith([textEl('a', 'A', { zIndex: 3 }), textEl('b', 'B', { zIndex: 8, y: 500 })]);
  const r = await run(ctx, 'move_element', { elementId: 'a', rotation: -12 });
  assert.equal(r.ok, true);
  assert.equal(ctx.working[0]!.rotation, -12);
  assert.match(r.summary, /^Rotated/);
  await run(ctx, 'move_element', { elementId: 'a', layer: 'front' });
  assert.equal(ctx.working.find((e) => e.id === 'a')!.zIndex, 9);
  await run(ctx, 'move_element', { elementId: 'b', layer: 'back' });
  assert.equal(ctx.working.find((e) => e.id === 'b')!.zIndex, 7, 'one below the lowest of itself and the others, as the panel does (8 - 1)');
});

test('read_element shows a picture’s own size, fit and focal point; a QR code its colours', async () => {
  const ctx = ctxWith([imageEl('c', 'https://cdn.test/m1/a.png', {}, 'A'), qrEl('q')], { imageSizes: [{ url: 'https://cdn.test/m1/a.png', assetId: 'A', width: 1426, height: 806 }] });
  const img = await run(ctx, 'read_element', { elementId: 'c' });
  assert.equal(img.naturalSize, '1426x806 px (1.77:1)');
  const qr = await run(ctx, 'read_element', { elementId: 'q' });
  assert.deepEqual([qr.fg, qr.bg], ['#000000', '#ffffff']);
});

// ── Arranging ────────────────────────────────────────────────────────────────

test('arrange_elements: one call stages each box, grouped as one change; a refusal stages nothing', async () => {
  const bodies = [0, 1, 2].map((i) => textEl(`b${i}`, `Paragraph ${i} about the season.`, { x: 80, y: 400 + i * 200, w: 531, h: 150 }));
  const ctx = ctxWith([textEl('sub', 'Subhead', { x: 80, y: 220, w: 1080, h: 60, text: { role: 'subhead' } }), ...bodies]);
  const r = await run(ctx, 'arrange_elements', { elementIds: ['b0', 'b1', 'b2'], fontSize: 20, height: 220, gap: 14, belowElementId: 'sub' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(ctx.proposals.length, 3);
  assert.ok(ctx.proposals.every((p) => p.group === r.summary));
  assert.deepEqual(ctx.working.filter((e) => e.id.startsWith('b')).map((e) => [e.y, e.h, e.text!.fontSize, e.text!.maxFontSize]), [
    [294, 220, 20, 20],
    [528, 220, 20, 20],
    [762, 220, 20, 20],
  ]);
  const before = ctx.proposals.length;
  const no = await run(ctx, 'arrange_elements', { elementIds: ['b0', 'b1', 'b2'], height: 900, gap: 14, belowElementId: 'sub' });
  assert.equal(no.ok, false);
  assert.match(no.error, /run off the bottom, so nothing was changed/);
  assert.equal(ctx.proposals.length, before);
});

test('a staged copy of a PDF page blocks element edits like a layout rebuild', async () => {
  const ctx = ctxWith([textEl('a', 'A')]);
  ctx.proposals.push({ id: 'p1', kind: 'copy-document-page', docId: 'd1', sourcePage: 2, summary: 'Copy page 2' });
  assert.match((await run(ctx, 'set_element_style', { elementId: 'a', color: '#ff0000' })).error, /PDF page copy/);
  assert.match((await run(ctx, 'clear_page', {})).error, /PDF page copy/);
});

test('unstage_changes takes a staged background back out and the page returns to its own ground', async () => {
  const ctx = ctxWith([textEl('a', 'A')]);
  await run(ctx, 'set_page_background', { color: '#000000' });
  await run(ctx, 'set_element_style', { elementId: 'a', color: '#ff0000' });
  const bgId = ctx.proposals.find((p) => p.kind === 'set-background')!.id;
  const r = await run(ctx, 'unstage_changes', { ids: [bgId] });
  assert.equal(r.ok, true);
  assert.deepEqual(ctx.proposals.map((p) => p.kind), ['update']);
  assert.deepEqual(ctx.page.background, { type: 'color', value: '#f5efe6' });
  // Taking out an element change keeps the background change.
  const ctx2 = ctxWith([textEl('a', 'A')]);
  await run(ctx2, 'set_page_background', { clear: true });
  await run(ctx2, 'set_element_style', { elementId: 'a', color: '#ff0000' });
  const upd = ctx2.proposals.find((p) => p.kind === 'update')!.id;
  await run(ctx2, 'unstage_changes', { ids: [upd] });
  assert.deepEqual(ctx2.proposals.map((p) => p.kind), ['set-background']);
});
