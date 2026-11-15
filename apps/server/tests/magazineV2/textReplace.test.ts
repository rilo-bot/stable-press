// ---------------------------------------------------------------------------
// textReplace — find-and-replace inside stored text, never retyping it.
//
// The 2026-11-15 incident: "replace NZTROF with NOG" made the Studio rewrite whole
// paragraphs it had only seen 60 characters of. replaceInHtml changes exactly the
// matched words and leaves every other byte of the stored HTML alone — across inline
// tags, entities, PDF line joins and <br>, and never inside a tag.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { replaceInHtml, visibleText } from '../../src/lib/magazineV2/textReplace.js';

// ── visibleText ──────────────────────────────────────────────────────────────

test('visibleText: tags dropped, entities decoded, <br> as a line break, nbsp as a space', () => {
  assert.equal(visibleText('The <strong>New</strong> Owners &amp; Friends<br>second&nbsp;line'), 'The New Owners & Friends\nsecond line');
  assert.equal(visibleText('a<br/>b<BR >c'), 'a\nb\nc');
  assert.equal(visibleText('&lt;b&gt; is &quot;bold&quot; &#8212; &#x2019;'), '<b> is "bold" — ’');
  assert.equal(visibleText('PDF line one\nline two'), 'PDF line one\nline two');
  assert.equal(visibleText(''), '');
});

test('visibleText: an unknown entity stays literal text, and no name resolves to a prototype member', () => {
  assert.equal(visibleText('&foo; &constructor; &toString;'), '&foo; &constructor; &toString;');
  assert.equal(visibleText('5 < 6 & 7 > 3'), '5 < 6 & 7 > 3');
});

// ── replaceInHtml ────────────────────────────────────────────────────────────

test('a word is replaced and every other byte is kept', () => {
  const html = 'The <b>NZTROF</b> board met on <i>Tuesday</i>.<br>Owners welcome.';
  const out = replaceInHtml(html, 'NZTROF', 'NOG');
  assert.equal(out.count, 1);
  assert.equal(out.html, 'The <b>NOG</b> board met on <i>Tuesday</i>.<br>Owners welcome.');
});

test('a match far past the 60-character preview leaves the rest of a long paragraph byte-identical', () => {
  const before = 'The New Zealand Thoroughbred Racing Owners Federation is embarking on one of the most significant owner-focused initiatives undertaken in New Zealand racing for many years. '.repeat(2);
  const after = ' Owners are at the heart of it, and the <em>federation</em> will report back to members in the new year with a full programme.';
  const html = `${before}NZTROF${after}`;
  const out = replaceInHtml(html, 'NZTROF', 'NOG');
  assert.equal(out.count, 1);
  assert.equal(out.html, `${before}NOG${after}`);
  assert.ok(before.length > 300);
});

test('tag names and attributes are never edited', () => {
  const html = '<span style="color: red">red letter day</span> and <span>span</span>';
  const out = replaceInHtml(html, 'red', 'blue');
  assert.equal(out.html, '<span style="color: red">blue letter day</span> and <span>span</span>');
  assert.equal(out.count, 1);
  const tags = replaceInHtml(html, 'span', 'bridge');
  assert.equal(tags.html, '<span style="color: red">red letter day</span> and <span>bridge</span>');
  assert.equal(tags.count, 1);
});

test('a word split by an inline tag still matches, and the tags stay balanced', () => {
  const out = replaceInHtml('Welcome to <b>NZ</b>TROF news', 'NZTROF', 'NOG');
  assert.equal(out.count, 1);
  assert.equal(out.html, 'Welcome to <b>NOG</b> news');
  assert.equal(visibleText(out.html), 'Welcome to NOG news');
});

test('entities: the search matches decoded text, and the replacement is encoded', () => {
  const out = replaceInHtml('Smith &amp; Co. sponsor the race', 'Smith & Co.', 'R&D (1 < 2 > 0)');
  assert.equal(out.count, 1);
  assert.equal(out.html, 'R&amp;D (1 &lt; 2 &gt; 0) sponsor the race');
  // Literal angle brackets that would read as a tag are written as entities.
  assert.equal(replaceInHtml('Smith', 'Smith', '&lt;Ltd&gt;').html, '&lt;Ltd&gt;');
  // A search copied out of stored HTML (entity-encoded) works too.
  assert.equal(replaceInHtml('Smith &amp; Co.', 'Smith &amp; Co.', 'Jones').html, 'Jones');
});

test('a space in the search matches a PDF line join ("\\n") and a <br>', () => {
  const pdf = 'The New Zealand Thoroughbred Racing Owners\nFederation (NZTROF) is\nembarking on';
  const a = replaceInHtml(pdf, 'Racing Owners Federation', 'Owners Group');
  assert.equal(a.count, 1);
  assert.equal(a.html, 'The New Zealand Thoroughbred Owners Group (NZTROF) is\nembarking on');
  // The line break inside the match goes with the matched words.
  const b = replaceInHtml('The Racing Owners<br>Federation met', 'Owners Federation', 'Owners Group');
  assert.equal(b.count, 1);
  assert.equal(b.html, 'The Racing Owners Group met');
  // A non-breaking space matches an ordinary one.
  assert.equal(replaceInHtml('New&nbsp;Zealand Cup', 'New Zealand', 'Aotearoa').html, 'Aotearoa Cup');
});

test('a word hyphenated across a PDF line matches its unbroken spelling', () => {
  const out = replaceInHtml('the finest thorough-\nbred stock', 'thoroughbred', 'racehorse');
  assert.equal(out.count, 1);
  assert.equal(out.html, 'the finest racehorse stock');
});

test('straight and curly quotes match each other', () => {
  const out = replaceInHtml('Racing in Hawke’s Bay', "Hawke's Bay", 'Hastings');
  assert.equal(out.count, 1);
  assert.equal(out.html, 'Racing in Hastings');
});

test('case-sensitive by default; matchCase:false finds every casing', () => {
  const html = 'NZTROF, Nztrof and nztrof';
  assert.equal(replaceInHtml(html, 'nztrof', 'NOG').count, 1);
  assert.equal(replaceInHtml(html, 'nztrof', 'NOG').html, 'NZTROF, Nztrof and NOG');
  const all = replaceInHtml(html, 'nztrof', 'NOG', { matchCase: false });
  assert.equal(all.count, 3);
  assert.equal(all.html, 'NOG, NOG and NOG');
});

test('wholeWord refuses a match inside a longer word', () => {
  const html = 'The Cup and the cupboard. Cups for all. Cup!';
  assert.equal(replaceInHtml(html, 'Cup', 'Trophy').count, 3);
  const whole = replaceInHtml(html, 'Cup', 'Trophy', { wholeWord: true });
  assert.equal(whole.count, 2);
  assert.equal(whole.html, 'The Trophy and the cupboard. Cups for all. Trophy!');
});

test('every match is counted', () => {
  const out = replaceInHtml('<p>NZTROF</p> NZTROF<br>NZTROF', 'NZTROF', 'NOG');
  assert.equal(out.count, 3);
  assert.equal(out.html, '<p>NOG</p> NOG<br>NOG');
});

test('no match: the HTML comes back untouched with a count of 0', () => {
  const html = 'The <b>New</b> Owners Group &amp; friends';
  const out = replaceInHtml(html, 'NZTROF', 'NOG');
  assert.equal(out.count, 0);
  assert.equal(out.html, html);
  assert.equal(replaceInHtml(html, '', 'x').count, 0);
  assert.equal(replaceInHtml(html, '   ', 'x').count, 0);
});

test('a match that already reads as the replacement is left alone and not counted', () => {
  const html = 'NOG and &#78;OG';
  const out = replaceInHtml(html, 'NOG', 'NOG');
  assert.equal(out.count, 0);
  assert.equal(out.html, html);
});

test('the replacement is plain text: markup in it is dropped, never injected', () => {
  const out = replaceInHtml('Call NZTROF', 'NZTROF', '<b>NOG</b><script>x</script>');
  assert.equal(out.html, 'Call NOGx');
  assert.doesNotMatch(out.html, /<script|<b>/);
  // A line break asked for in the replacement is stored as a <br>.
  assert.equal(replaceInHtml('a b', 'b', 'c\nd').html, 'a c<br>d');
});

test('an empty replacement deletes the words', () => {
  assert.equal(replaceInHtml('the very big horse', ' very', '').html, 'the big horse');
});

test('special regex characters in the search are literal', () => {
  const out = replaceInHtml('Prize (NZ$) 1.5m and 125m', '(NZ$) 1.5m', '(NZD) 1.5 million');
  assert.equal(out.count, 1);
  assert.equal(out.html, 'Prize (NZD) 1.5 million and 125m');
  assert.equal(replaceInHtml('a.b axb', 'a.b', 'X').html, 'X axb');
});

test('the same input always gives the same output', () => {
  const html = 'The <b>NZ</b>TROF&nbsp;board and NZTROF<br>members';
  const a = replaceInHtml(html, 'NZTROF', 'NOG');
  const b = replaceInHtml(html, 'NZTROF', 'NOG');
  assert.deepEqual(a, b);
  assert.equal(a.count, 2);
});
