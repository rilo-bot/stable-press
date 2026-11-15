// Run: npx tsx --test src/editor-v2/textFit.test.ts   (from apps/web)
// The Inspector's fixes for cut-off text: grow into the free space below, or the
// size it fits at (finding C50, web side).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { growToFit, roomBelow, shrinkSizeFor } from './textFit';

const page = { width: 1240, height: 1754 };
const body = { id: 'b', x: 100, y: 400, w: 500, h: 260 };

test('roomBelow runs to the page edge when nothing is below', () => {
  assert.equal(roomBelow(body, [], page), page.height - (400 + 260));
});

test('roomBelow stops at the next element in the same column', () => {
  const caption = { id: 'c', x: 120, y: 760, w: 300, h: 40 };
  assert.equal(roomBelow(body, [caption], page), 760 - 660);
});

test('roomBelow ignores other columns, the element itself, backgrounds and panels behind it', () => {
  const otherColumn = { id: 'o', x: 700, y: 700, w: 400, h: 300 };
  const background = { id: 'bg', x: 0, y: 0, w: 1240, h: 1754 };
  const panel = { id: 'p', x: 80, y: 380, w: 540, h: 900 };
  const self = { ...body };
  assert.equal(roomBelow(body, [otherColumn, background, panel, self], page), page.height - 660);
});

test('growToFit takes all the height it needs when there is room', () => {
  assert.deepEqual(growToFit(260, 412, 300), { h: 414, short: 0 });
});

test('growToFit goes as far as the room allows and says what is still hidden', () => {
  const r = growToFit(260, 412, 100);
  assert.equal(r.h, 360);
  assert.equal(r.short, 414 - 360);
});

test('growToFit never shrinks the box', () => {
  assert.equal(growToFit(260, 412, 0).h, 260);
});

test('shrinkSizeFor: roughly the square-root rule, at least 1px smaller, never below 6', () => {
  assert.equal(shrinkSizeFor(26, 412, 260), Math.floor(26 * Math.sqrt(260 / 412) * 0.98));
  assert.equal(shrinkSizeFor(20, 201, 200), 19);
  assert.equal(shrinkSizeFor(8, 1000, 10), 6);
  assert.equal(shrinkSizeFor(18, 100, 200), 18);
});
