// Run (from apps/web): npx tsx --test src/editor-v2/textReplace.test.ts
//
// The editor's twin of the server's textReplace.ts. The waiting Design Helper changes
// are rebased with it after a magazine-wide replace, so it must rewrite a box exactly
// as the server rewrote the stored one: the last group runs the server's own module
// on the same inputs and demands the same bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { plainAsHtml, replaceInHtml, sameWords, visibleText } from './textReplace';

test('only the matched words change; every other byte stays', () => {
  const html = '<p>Welcome to <b>NZTROF</b> — the NZTROF owners’ day.</p>';
  const r = replaceInHtml(html, 'NZTROF', 'NOG');
  assert.equal(r.count, 2);
  assert.equal(r.html, '<p>Welcome to <b>NOG</b> — the NOG owners’ day.</p>');
});

test('a match split by an inline tag, a PDF line join or a hyphenated break still matches', () => {
  assert.equal(replaceInHtml('<b>NZ</b>TROF', 'NZTROF', 'NOG').html, '<b>NOG</b>');
  assert.equal(replaceInHtml('Hawke’s\nBay', "Hawke's Bay", 'Napier').html, 'Napier');
  assert.equal(replaceInHtml('Thorough-\nbred', 'Thoroughbred', 'Standardbred').html, 'Standardbred');
});

test('case, whole words and no-op matches', () => {
  assert.equal(replaceInHtml('Cup and cup', 'cup', 'Plate').count, 1);
  assert.equal(replaceInHtml('Cup and cup', 'cup', 'Plate', { matchCase: false }).count, 2);
  assert.equal(replaceInHtml('Cupboard Cup', 'Cup', 'Plate', { wholeWord: true }).html, 'Cupboard Plate');
  // A match that already reads as the replacement is not a change.
  assert.deepEqual(replaceInHtml('NOG', 'nog', 'NOG', { matchCase: false }), { html: 'NOG', count: 0 });
  assert.deepEqual(replaceInHtml('', 'x', 'y'), { html: '', count: 0 });
  assert.deepEqual(replaceInHtml('abc', '   ', 'y'), { html: 'abc', count: 0 });
});

test('the replacement is always plain text — markup in it never reaches the page', () => {
  const r = replaceInHtml('Smith and Co', 'and', '<b>&</b>');
  assert.equal(r.html, 'Smith &amp; Co');
  assert.equal(replaceInHtml('a b', 'b', 'x\ny').html, 'a x<br>y');
});

test('visibleText and plainAsHtml round-trip plain text', () => {
  assert.equal(visibleText('Smith &amp; Co<br>Hawke&rsquo;s&nbsp;Bay'), 'Smith & Co\nHawke’s Bay');
  for (const s of ['a < b & c > d', 'two\nlines', 'Hawke’s “Bay”', '&amp; literally']) {
    assert.equal(visibleText(plainAsHtml(s)), s);
  }
});

test('sameWords ignores markup-only and spacing differences, not word changes', () => {
  assert.ok(sameWords('Owners  are\nhere ', 'Owners are here'));
  assert.ok(!sameWords('Owners are here', 'Owners were here'));
});

// ── parity with the server ──────────────────────────────────────────────────

function serverFile(file: string): string {
  const rel = path.join('apps', 'server', 'src', 'lib', 'magazineV2', file);
  for (const up of ['.', '..', path.join('..', '..'), path.join('..', '..', '..')]) {
    const p = path.resolve(process.cwd(), up, rel);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`cannot find the server's ${file} from ${process.cwd()}`);
}

test('rewrites exactly as the server does', async () => {
  const server = (await import(pathToFileURL(serverFile('textReplace.ts')).href)) as {
    replaceInHtml: typeof replaceInHtml;
    visibleText: typeof visibleText;
  };
  const cases: [string, string, string, { matchCase?: boolean; wholeWord?: boolean }?][] = [
    ['<p>Welcome to <b>NZTROF</b> — the NZTROF day.</p>', 'NZTROF', 'NOG'],
    ['<b>NZ</b>TROF and nztrof', 'nztrof', 'NOG', { matchCase: false }],
    ['Thorough-\nbred horses<br>Thorough&shy;bred', 'Thoroughbred', 'Standardbred'],
    ['Hawke&rsquo;s Bay, Hawke\'s&nbsp;Bay', "Hawke's Bay", 'Napier & Co'],
    ['Cupboard Cup cup', 'Cup', 'Plate', { wholeWord: true }],
    ['a &unknown; b < c', 'b < c', 'd'],
    ['line one<br/>line two', 'one line', '1\n2'],
    ['&#x41;&#66; &amp;', 'AB &', 'x'],
    ['Smith and Co', 'and', ''],
  ];
  for (const [html, find, rep, opts] of cases) {
    assert.deepEqual(replaceInHtml(html, find, rep, opts), server.replaceInHtml(html, find, rep, opts), `${html} / ${find}`);
    assert.equal(visibleText(html), server.visibleText(html), html);
  }
});
