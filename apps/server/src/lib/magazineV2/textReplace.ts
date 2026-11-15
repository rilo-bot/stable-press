// ---------------------------------------------------------------------------
// Magazine Builder v2 — find-and-replace INSIDE a text element's stored HTML.
//
// "Replace NZTROF with NOG on this page" used to mean set_element_text: the model
// had to send the WHOLE new content of every box it touched, having seen only a
// 60-character preview of it. It retyped paragraphs it had never read, and the
// client's real copy (and its bold, italics and line breaks) was lost — the "the
// AI rewrote paragraphs" half of the 2026-11-15 incident.
//
// This is the deterministic alternative: change only the matched words and leave
// every other byte of the stored HTML exactly as it was.
//
//   - Matching runs on the VISIBLE text, the words a reader sees: tags dropped,
//     entities decoded ("Smith &amp; Co" matches "Smith & Co"), <br> as a line
//     break. So a word split by an inline tag ("<b>NZ</b>TROF") still matches, and
//     a space in the search matches any run of whitespace, including the "\n" line
//     joins of text copied from a PDF and a <br>. A word hyphenated across a PDF
//     line ("Thorough-\nbred") matches its unbroken spelling, and straight and
//     curly quotes match each other (models type "Hawke's", the page says
//     "Hawke’s").
//   - Each match is mapped back onto the source: the replacement is written where
//     the match starts, and the rest of the matched characters are removed from
//     whichever text nodes they sit in. Tags inside a match stay where they are
//     (a <b>…</b> pair is never broken), except a <br> the match spans: that line
//     break was part of the matched words and goes with them.
//   - Tag names and attributes are never edited, and the replacement is always
//     plain text (entity-encoded), so this can never inject markup.
//
// Pure: string arithmetic only. No DOM, no I/O.
// ---------------------------------------------------------------------------

/** A tag (or comment) in the inline HTML the sanitizer stores. A '<' that does not
 *  start one of these is just a character of text. */
const TAG_RE = /<\/?[a-zA-Z][^>]*>|<!--[\s\S]*?-->/g;
const BR_RE = /^<br\b/i;
const ENTITY_RE = /&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/y;

/** Named entities worth decoding. The sanitizer only ever writes &amp; &lt; &gt;
 *  and &nbsp;, but content pasted or typed before it ran can carry the common
 *  typographic ones. An unknown name is left as literal text. */
const NAMED = new Map<string, string>(Object.entries({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  sbquo: '‚',
  bdquo: '„',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  shy: '­',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  middot: '·',
  bull: '•',
  eacute: 'é',
  egrave: 'è',
  aacute: 'á',
  agrave: 'à',
  ouml: 'ö',
  uuml: 'ü',
  auml: 'ä',
  ccedil: 'ç',
  pound: '£',
  euro: '€',
  times: '×',
  frac12: '½',
}));

/** One character a reader sees, and the span of the stored HTML that draws it. */
interface VisibleChar {
  ch: string; // one code point (1 or 2 UTF-16 units)
  start: number; // source offset in the HTML
  end: number;
  /** true for the "\n" a <br> draws — deleting it deletes the whole tag. */
  fromBr: boolean;
}

function decodeEntity(body: string): string | null {
  if (body[0] === '#') {
    const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    return String.fromCodePoint(cp);
  }
  // A Map, not an object lookup: "&constructor;" must not resolve to a prototype member.
  return NAMED.get(body) ?? NAMED.get(body.toLowerCase()) ?? null;
}

/** Walk the stored HTML into the characters a reader sees, each mapped to its span. */
function scan(html: string): VisibleChar[] {
  const out: VisibleChar[] = [];
  const pushText = (from: number, to: number) => {
    let i = from;
    while (i < to) {
      if (html[i] === '&') {
        ENTITY_RE.lastIndex = i;
        const m = ENTITY_RE.exec(html);
        if (m && m.index === i && i + m[0].length <= to) {
          const decoded = decodeEntity(m[1]!);
          if (decoded !== null) {
            out.push({ ch: decoded, start: i, end: i + m[0].length, fromBr: false });
            i += m[0].length;
            continue;
          }
        }
      }
      const cp = html.codePointAt(i) ?? 0;
      const ch = String.fromCodePoint(cp);
      out.push({ ch, start: i, end: i + ch.length, fromBr: false });
      i += ch.length;
    }
  };
  let last = 0;
  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(html); m; m = TAG_RE.exec(html)) {
    pushText(last, m.index);
    if (BR_RE.test(m[0])) out.push({ ch: '\n', start: m.index, end: m.index + m[0].length, fromBr: true });
    last = m.index + m[0].length;
  }
  pushText(last, html.length);
  return out;
}

/**
 * The text a reader sees in a stored text element: tags dropped, entities decoded,
 * <br> (and the "\n" line joins of PDF text) as "\n". Non-breaking spaces read as
 * spaces. This is the text to show a model, to count, or to measure.
 */
export function visibleText(html: string): string {
  return scan(html ?? '')
    .map((c) => c.ch)
    .join('')
    .replace(/ /g, ' ');
}

/** Encode plain text for a text node of the stored HTML. A line break in the
 *  replacement becomes a <br>, the markup stored copy uses for one. */
function encodeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/ /g, '&nbsp;')
    .replace(/\r?\n/g, '<br>');
}

/** Characters with a special meaning in a regular expression (u-mode safe). */
function escapeRe(ch: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(ch) ? `\\${ch}` : ch;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const LETTER = /\p{L}/u;
const SINGLE_QUOTES = "'‘’ʼ′";
const DOUBLE_QUOTES = '"“”″';

/**
 * The search, as a pattern over the visible text. Whitespace runs match any
 * whitespace run (spaces, "\n" line joins, <br>, non-breaking spaces); straight and
 * curly quotes match each other; between two letters an optional "-\n" (or a soft
 * hyphen) lets a word hyphenated across a PDF line match its unbroken spelling.
 */
function searchPattern(find: string, matchCase: boolean, wholeWord: boolean): RegExp | null {
  const chars = Array.from(find);
  if (!chars.some((c) => !/\s/.test(c))) return null;
  let src = '';
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (/\s/.test(c)) {
      if (i > 0 && /\s/.test(chars[i - 1]!)) continue;
      src += '\\s+';
      continue;
    }
    if (SINGLE_QUOTES.includes(c)) src += `[${SINGLE_QUOTES}]`;
    else if (DOUBLE_QUOTES.includes(c)) src += `[${DOUBLE_QUOTES}]`;
    else src += escapeRe(c);
    const next = chars[i + 1];
    if (next !== undefined && LETTER.test(c) && LETTER.test(next)) src += '(?:-\\n|\\u00ad\\n?)?';
  }
  const first = chars[0]!;
  const last = chars[chars.length - 1]!;
  if (wholeWord && WORD_CHAR.test(first)) src = `(?<![\\p{L}\\p{N}_])${src}`;
  if (wholeWord && WORD_CHAR.test(last)) src = `${src}(?![\\p{L}\\p{N}_])`;
  return new RegExp(src, matchCase ? 'gu' : 'giu');
}

/**
 * Replace `find` with `replace` in the TEXT of a stored inline-HTML string.
 *
 * - Matches the visible text (see the header): across inline tags, entities, line
 *   joins and <br>, with quotes and whitespace matched loosely.
 * - `matchCase` defaults to TRUE: a name swap must not rewrite a different word
 *   that merely shares its letters. Pass false for a case-insensitive search.
 * - `wholeWord` defaults to false; true refuses a match inside a longer word
 *   ("Cup" no longer matches "Cupboard").
 * - Both `find` and `replace` are read as plain text: entities in them are decoded
 *   and tags dropped, so a search copied out of stored HTML works, and markup in a
 *   replacement can never reach the page as literal tags or as live HTML.
 *
 * Returns the new HTML and how many matches CHANGED the text. A match that already
 * reads exactly as the replacement is left byte-identical and not counted, so a
 * count of 0 means "nothing to change here" — either not found or already done.
 * Every byte outside the changed matches is preserved.
 */
export function replaceInHtml(
  html: string,
  find: string,
  replace: string,
  opts: { matchCase?: boolean; wholeWord?: boolean } = {},
): { html: string; count: number } {
  const source = html ?? '';
  const needle = scan(find ?? '').map((c) => c.ch).join('');
  const pattern = searchPattern(needle, opts.matchCase !== false, opts.wholeWord === true);
  if (!pattern || !source) return { html: source, count: 0 };
  const replacement = scan(replace ?? '').map((c) => c.ch).join('');

  const chars = scan(source);
  // The visible string, and for each of its UTF-16 offsets the visible char index.
  let vis = '';
  const at: number[] = [];
  chars.forEach((c, i) => {
    for (let k = 0; k < c.ch.length; k++) at.push(i);
    vis += c.ch;
  });
  at.push(chars.length);

  // Each change: delete these source spans, and write the replacement at the first.
  const edits: { start: number; end: number; insert: string }[] = [];
  let count = 0;
  pattern.lastIndex = 0;
  for (let m = pattern.exec(vis); m; m = pattern.exec(vis)) {
    if (m[0].length === 0) {
      pattern.lastIndex += 1;
      continue;
    }
    if (m[0] === replacement) continue;
    const from = at[m.index]!;
    const to = at[m.index + m[0].length]!;
    if (to <= from) continue;
    count += 1;
    for (let i = from; i < to; i++) {
      const c = chars[i]!;
      edits.push({ start: c.start, end: c.end, insert: i === from ? encodeText(replacement) : '' });
    }
  }
  if (count === 0) return { html: source, count: 0 };

  edits.sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const e of edits) {
    out += source.slice(cursor, e.start) + e.insert;
    cursor = e.end;
  }
  out += source.slice(cursor);
  return { html: out, count };
}
