// Run: npx tsx --test src/editor-v2/imageFrame.test.ts   (from apps/web)
// The exact frame the Inspector asks the image route for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxAspectRatio } from './imageFrame';

test('a box becomes its reduced whole-pixel ratio', () => {
  assert.equal(boxAspectRatio(600, 750), '4:5');
  assert.equal(boxAspectRatio(1920, 1080), '16:9');
  assert.equal(boxAspectRatio(500, 500), '1:1');
  // Fractional geometry is rounded first, as the canvas draws it.
  assert.equal(boxAspectRatio(599.6, 750.2), '4:5');
});

test('an uncommon box keeps its own ratio (the server snaps it) and stays short', () => {
  const r = boxAspectRatio(1237, 1601)!;
  assert.equal(r, '1237:1601');
  assert.ok(r.length <= 12, 'the route reads at most 12 characters');
});

test('a box with no area asks for nothing', () => {
  assert.equal(boxAspectRatio(0, 400), null);
  assert.equal(boxAspectRatio(400, -1), null);
  assert.equal(boxAspectRatio(Number.NaN, 400), null);
  assert.equal(boxAspectRatio(0.2, 400), null);
});
