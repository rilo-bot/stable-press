// ---------------------------------------------------------------------------
// Fill / Adjust — how a box's current copy is shown to the sub-editor model.
//
// The copy used to be shown with every tag stripped, <br> included, so a results
// list "1st Foo<br>2nd Bar" reached the model as "1st Foo2nd Bar" and its rewrite
// lost the list. Line breaks are now shown as <br>, the markup the model is told
// to write, so it can keep one item per line.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shownCopy, charGuideFor } from '../../src/lib/magazineV2/format.js';

test('line breaks are shown as <br>, other markup is dropped', () => {
  assert.equal(shownCopy('<b>1st</b> Desert Sky<br>2nd Ocean Belle<br/>3rd Silver Comet'), '1st Desert Sky<br>2nd Ocean Belle<br>3rd Silver Comet');
});

test('newlines count as line breaks too, and stray whitespace is tidied', () => {
  assert.equal(shownCopy('  Results:\n1st   Desert Sky \n'), 'Results:<br>1st Desert Sky');
});

test('entities are shown as the characters a reader sees', () => {
  assert.equal(shownCopy('Smith &amp; Sons&nbsp;Ltd'), 'Smith & Sons Ltd');
});

test('an empty or tag-only box shows as empty', () => {
  assert.equal(shownCopy(''), '');
  assert.equal(shownCopy('<br><br>'), '');
  assert.equal(shownCopy('<b></b>'), '');
});

test('the per-role character guide still answers for unknown roles', () => {
  assert.equal(charGuideFor('body'), 700);
  assert.equal(charGuideFor('nonsense'), charGuideFor('other'));
});
