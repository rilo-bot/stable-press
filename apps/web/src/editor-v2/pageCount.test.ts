// Run: npx tsx --test src/editor-v2/pageCount.test.ts   (from apps/web)
// The composer's page-count rule, and the brief The Stable Hand types so the
// composer reads back exactly the count the user approved (finding C20).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { briefWithPageCount, pageCountMentions, parsePageCount } from './pageCount';

test('parsePageCount takes the largest mention in range', () => {
  assert.equal(parsePageCount('two pages of a 16 page bulletin'), 16);
  assert.equal(parsePageCount('a 6-page magazine'), 6);
  assert.equal(parsePageCount('Twelve pages about the yearling sales'), 12);
  assert.equal(parsePageCount('no count here'), undefined);
  // Out of range (the server ignores it) → undefined.
  assert.equal(parsePageCount('a two-page spread'), undefined);
  assert.equal(parsePageCount('a 40 page annual'), undefined);
});

test('pageCountMentions lists every mention in order', () => {
  assert.deepEqual(pageCountMentions('3 pages of results, a two-page spread, 12 pages'), [3, 2, 12]);
});

test('no pageCount: the brief goes in as written', () => {
  const r = briefWithPageCount('  A stable yearbook.  ');
  assert.equal(r.text, 'A stable yearbook.');
  assert.equal(r.pageCount, undefined);
  assert.equal(r.conflict, undefined);
});

test('a smaller section size no longer wins over the issue size (the C20 repro)', () => {
  const r = briefWithPageCount('Stable yearbook: results table across 3 pages, trainer interviews, sales', 12);
  assert.equal(r.pageCount, 12);
  assert.equal(parsePageCount(r.text), 12);
  assert.match(r.text, /12 pages in total\.$/);
  assert.equal(r.conflict, undefined);
});

test('a two-page spread no longer turns the build into a short preview', () => {
  const r = briefWithPageCount('Open with a two-page spread of the winners.', 12);
  assert.equal(parsePageCount(r.text), 12);
  assert.equal(r.conflict, undefined);
});

test('a brief that already says the count is left alone', () => {
  const r = briefWithPageCount('A 12 page magazine about the Karaka sales.', 12);
  assert.equal(r.text, 'A 12 page magazine about the Karaka sales.');
  assert.equal(r.pageCount, 12);
});

test('a larger issue size in the brief is a conflict, never a silent disagreement', () => {
  const r = briefWithPageCount('A 16-page bulletin for the owners.', 12);
  assert.equal(r.conflict, 16);
  assert.equal(r.pageCount, 16);
});

test('trailing punctuation is tidied before the count is appended', () => {
  const r = briefWithPageCount('Spring racing preview...  ', 8);
  assert.equal(r.text, 'Spring racing preview — 8 pages in total.');
});
