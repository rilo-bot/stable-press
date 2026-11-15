// ---------------------------------------------------------------------------
// Magazine Builder v2 — the web twin of the server's find-and-replace inside a text
// element's stored HTML (apps/server/src/lib/magazineV2/textReplace.ts).
//
// WHY THE EDITOR NEEDS ITS OWN COPY. A magazine-wide replace ("NZTROF" → "NOG") runs
// on the server against the STORED pages. But Design Helper changes waiting for Apply
// live in this browser, and a staged text edit carries the box's WHOLE new content,
// written from the old words. Left alone, Apply would write "NZTROF" straight back
// over the replace. So after a replace the waiting changes are rebased with the very
// same rewrite (pendingChanges.rebaseForReplace) — and "the very same" has to mean
// byte for byte what the server did, or a staged box would come out different from
// its stored twin. textReplace.test.ts runs both on the same inputs to keep it so.
//
// The rules (see the server file for the long form):
//   - matching runs on the VISIBLE text: tags dropped, entities decoded, <br> as a
//     line break; whitespace runs match any whitespace, straight and curly quotes
//     match each other, a word hyphenated across a PDF line matches unbroken;
//   - only the matched characters change; tags inside a match stay, a <br> the match
//     spans goes with it; the replacement is plain text, entity-encoded.
//
// Pure: string arithmetic only. No DOM.
// ---------------------------------------------------------------------------

/** A tag (or comment) in the inline HTML the sanitizer stores. */
const TAG_RE = /<\/?[a-zA-Z][^>]*>|<!--[\s\S]*?-->/g;
const BR_RE = /^<br\b/i;
const ENTITY_RE = /&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/y;

/** Named entities worth decoding — the server's list; an unknown name stays literal. */
const NAMED = new Map<string, string>(
  Object.entries({
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
  }),
);

/** One character a reader sees, and the span of the stored HTML that draws it. */
interface VisibleChar {
  ch: string;
  start: number;
  end: number;
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
            out.push({ ch: decoded, start: i, end: i + m[0].length });
            i += m[0].length;
            continue;
          }
        }
      }
      const cp = html.codePointAt(i) ?? 0;
      const ch = String.fromCodePoint(cp);
      out.push({ ch, start: i, end: i + ch.length });
      i += ch.length;
    }
  };
  let last = 0;
  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(html); m; m = TAG_RE.exec(html)) {
    pushText(last, m.index);
    if (BR_RE.test(m[0])) out.push({ ch: '\n', start: m.index, end: m.index + m[0].length });
    last = m.index + m[0].length;
  }
  pushText(last, html.length);
  return out;
}

/**
 * The text a reader sees in a stored text element: tags dropped, entities decoded,
 * <br> (and the "\n" line joins of PDF text) as "\n", non-breaking spaces as spaces.
 * The server's visibleText, character for character.
 */
export function visibleText(html: string): string {
  return scan(html ?? '')
    .map((c) => c.ch)
    .join('')
    .replace(/ /g, ' ');
}

/** Plain text as the HTML of a text node that reads exactly as it: `&`, `<` and `>`
 *  escaped, line breaks kept as "\n" (which the scan reads back as the same "\n"). */
export function plainAsHtml(text: string): string {
  return (text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Encode plain text for a text node of the stored HTML (the server's encodeText). */
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

/** The search as a pattern over the visible text — the server's searchPattern. */
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
 * Replace `find` with `replace` in the TEXT of a stored inline-HTML string — the
 * server's replaceInHtml. `matchCase` defaults to TRUE, `wholeWord` to false. Returns
 * the new HTML and how many matches CHANGED the text (a match that already reads as
 * the replacement is left byte-identical and not counted). Every byte outside the
 * changed matches is preserved.
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
  let vis = '';
  const at: number[] = [];
  chars.forEach((c, i) => {
    for (let k = 0; k < c.ch.length; k++) at.push(i);
    vis += c.ch;
  });
  at.push(chars.length);

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

/** The words of a stored text, for comparing two versions of a box: the visible text
 *  with every whitespace run read as one space. Markup-only differences (the sanitizer
 *  re-encoding an entity, a PDF line join turned into a space) are not differences. */
export const sameWords = (a: string, b: string): boolean => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
