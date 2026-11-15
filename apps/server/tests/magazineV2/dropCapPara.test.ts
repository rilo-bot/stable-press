// ---------------------------------------------------------------------------
// dropCapPara — a drop-cap paragraph edited as the ONE paragraph it is (C13).
//
// Edited box by box, "rewrite the opening" sent the whole paragraph into the lead
// piece beside the cap ("MMorning…"), and the pinned lead could not shrink, so it was
// cut off. Here an edit goes to the whole paragraph and is re-set with the composer's
// own calculation, or folded into one plain box when the copy cannot carry a cap.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  dropCapKey,
  dropCapParagraphOf,
  dropCapPieceIds,
  planDropCapRewrite,
  readDropCapParagraphs,
} from '../../src/lib/magazineV2/dropCapPara.js';
import { visibleText } from '../../src/lib/magazineV2/textReplace.js';
import { applyPatch } from '../../src/lib/magazineV2/agentPure.js';
import type { MagazineElement } from '../../src/lib/magazineV2/model.js';
import { buildDropCap } from './dropCapFixture.js';

const PAGE = { width: 1240, height: 1754 };
const prose = (words: number, seed = 'racing') => Array.from({ length: words }, (_, i) => `${seed}${i % 7 === 0 ? ',' : ''}`).join(' ') + '.';
const flat = (s: string) => visibleText(s).replace(/\s+/g, ' ').trim();

/** The page after applying a rewrite the way the write path will. */
function applied(elements: MagazineElement[], rw: ReturnType<typeof planDropCapRewrite>): MagazineElement[] {
  const byId = new Map(rw.updates.map((u) => [u.elementId, u.patch]));
  return elements
    .filter((e) => !rw.deletes.includes(e.id))
    .map((e) => (byId.has(e.id) ? applyPatch(e, byId.get(e.id)!, PAGE) : e));
}

test('dropCapKey: a piece id or the key itself gives the key; anything else gives null', () => {
  assert.equal(dropCapKey('dropcap-abc-lead'), 'dropcap-abc');
  assert.equal(dropCapKey('dropcap-abc-cap'), 'dropcap-abc');
  assert.equal(dropCapKey('dropcap-abc'), 'dropcap-abc');
  assert.equal(dropCapKey('el_12'), null);
  assert.equal(dropCapKey(undefined), null);
});

test('the three pieces read back as one paragraph, the cap letter joined to its word', () => {
  const text = `Morning comes early ${prose(110)}`;
  const dc = buildDropCap(text);
  const { paras, broken } = readDropCapParagraphs(dc.elements);
  assert.deepEqual(broken, []);
  assert.equal(paras.length, 1);
  const p = paras[0]!;
  assert.equal(p.key, dc.key);
  assert.equal(flat(p.raw), flat(text));
  assert.deepEqual(p.box, dc.box);
  assert.equal(p.pinned, dc.lead.text!.fontSize);
  assert.deepEqual(dropCapPieceIds(p), dropCapPieceIds(dropCapParagraphOf(dc.elements, dc.lead.id)!));
});

test('a cap without its opening lines is broken; a lone folded piece is ordinary text', () => {
  const dc = buildDropCap(prose(120));
  assert.deepEqual(readDropCapParagraphs([dc.cap]).broken, [dc.key]);
  assert.deepEqual(readDropCapParagraphs([dc.lead]), { paras: [], broken: [] });
  assert.equal(dropCapParagraphOf([dc.lead], dc.lead.id), null);
});

test('new copy is re-set as a drop cap: the cap is the NEW first letter, never doubled ("MMorning")', () => {
  const dc = buildDropCap(`Morning comes early ${prose(110)}`);
  const p = readDropCapParagraphs(dc.elements).paras[0]!;
  const next = `Evening falls late ${prose(100, 'stable')}`;
  const rw = planDropCapRewrite(p, { raw: next });
  assert.equal(rw.kind, 'split');
  assert.equal(rw.fits, true);
  const page = applied(dc.elements, rw);
  const cap = page.find((e) => e.id === dc.cap.id)!;
  const lead = page.find((e) => e.id === dc.lead.id)!;
  const rest = page.find((e) => e.id === dc.rest!.id);
  assert.equal(flat(cap.text!.content), 'E');
  assert.ok(flat(lead.text!.content).startsWith('vening falls late'));
  const joined = flat(`${cap.text!.content}${lead.text!.content} ${rest?.text?.content ?? ''}`);
  assert.equal(joined, flat(next), 'the pieces read as exactly the new paragraph');
  // Pinned: the write path cannot refit either half to a different size.
  assert.equal(lead.text!.fontSize, rest?.text?.fontSize ?? lead.text!.fontSize);
  assert.equal(lead.text!.minFontSize, lead.text!.maxFontSize);
});

test('copy too short for a cap folds into one plain body box; the cap and the rest are deleted', () => {
  const dc = buildDropCap(`Morning comes early ${prose(110)}`);
  const p = readDropCapParagraphs(dc.elements).paras[0]!;
  const rw = planDropCapRewrite(p, { raw: 'A short opening line.' });
  assert.equal(rw.kind, 'fold');
  assert.deepEqual(rw.deletes.sort(), [dc.cap.id, dc.rest!.id].sort());
  assert.match(rw.why ?? '', /too short/);
  const page = applied(dc.elements, rw);
  assert.equal(page.length, 1);
  assert.equal(flat(page[0]!.text!.content), 'A short opening line.');
  assert.ok(page[0]!.h < dc.box.h, 'the box hugs the copy it now holds');
  // Once folded, the lone piece is ordinary text.
  assert.equal(dropCapParagraphOf(page, dc.lead.id), null);
});

test('copy with formatting folds too (a split would cut the markup in half)', () => {
  const dc = buildDropCap(prose(120));
  const p = readDropCapParagraphs(dc.elements).paras[0]!;
  const rw = planDropCapRewrite(p, { raw: `<b>Morning</b> ${prose(110)}` });
  assert.equal(rw.kind, 'fold');
  assert.match(rw.why ?? '', /formatting/);
});

test('a longer paragraph grows into the free space below instead of being cut off', () => {
  const dc = buildDropCap(prose(120), { x: 100, y: 300, w: 900, h: 700 });
  const p = readDropCapParagraphs(dc.elements).paras[0]!;
  const longer = prose(650); // more than the 700px holds even at the print floor
  const tight = planDropCapRewrite(p, { raw: longer });
  const roomy = planDropCapRewrite(p, { raw: longer, growPx: 600 });
  assert.ok(roomy.fits);
  assert.ok(roomy.box.h > dc.box.h, 'the paragraph took room below');
  assert.equal(tight.fits, false, "the premise: without the room it does not fit");
  assert.ok(roomy.fontSize >= tight.fontSize, "and keeps a size at least as large as without the room");
});

test('a new size becomes the pinned size of both halves', () => {
  const dc = buildDropCap(prose(120), { x: 100, y: 300, w: 900, h: 900 }, 22);
  const p = readDropCapParagraphs(dc.elements).paras[0]!;
  const rw = planDropCapRewrite(p, { fontSize: 26, growPx: 300 });
  assert.equal(rw.kind, 'split');
  const page = applied(dc.elements, rw);
  const lead = page.find((e) => e.id === dc.lead.id)!;
  assert.ok(lead.text!.fontSize > 22 && lead.text!.fontSize <= 26, `set at ${lead.text!.fontSize}`);
  assert.equal(lead.text!.maxFontSize, lead.text!.fontSize);
});
