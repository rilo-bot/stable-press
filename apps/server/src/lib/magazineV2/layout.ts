// ---------------------------------------------------------------------------
// Magazine Builder v2 — content-aware text fitting + colour-contrast helpers.
//
// Pure and server-safe (no DOM) so the generator can bake a non-overflowing font
// size into every generated text element and keep it legible over any scrim /
// panel / photo, and the client can reuse the same maths. Width comes from
// MEASURED per-font glyph advances (fontMetrics.ts) — real numbers read from the
// actual fonts, NOT a pattern-match on the font's name. The estimate only ever
// SHRINKS from maxFontSize and leans conservative (ignores kerning), so it is
// safe (never overflows). Nothing downstream corrects it: the editor stores what
// this module computes, so the measurement has to read the copy the way the
// browser lays it out (a <br> is a line break, a <b> run is set in bold).
//
// Originally ported from the campaign-hq reference (packages/blocks/src/layoutFit.ts);
// the name-classifying `advanceRatio` heuristic has since been replaced by the
// measured metrics table. `refitText` (the server write-path hook) is kept here.
// ---------------------------------------------------------------------------

import type { MagazineElement } from './model.js';
import { measureRunWidthPx } from './fontMetrics.js';
import { keepsPdfLines } from './extractedText.js';

// ── Reading the copy the way the browser lays it out ─────────────────────────
//
// Element copy is sanitised inline HTML (b, strong, i, em, u, s, span, br — see
// sanitize.ts). Two of those change how much room the words take, and both are
// what the AI writers are told to produce ("Light inline HTML only (<b><i><u><br>)"):
//   <br>             a hard line break. Dropping it merged a five-line results list
//                    into two long lines, so the list was "fitted" at a size where
//                    its last line was cut off.
//   <b>, <strong>,   bold. Georgia bold is ~15% wider than regular (Archivo ~8%), so
//   font-weight      bold copy measured at the regular weight wrapped one line later
//                    in the browser than in the estimate, and lost that line.
// So the copy is read into runs of visible text, each at the weight it is drawn in.

/** One stretch of visible text and the CSS weight it is drawn at. */
interface Piece {
  text: string;
  weight: number;
}
/** A word as drawn: one piece, or several when the weight changes mid-word ("<b>Win</b>ner"). */
type Word = Piece[];

/** Copy prepared for measurement: hard lines → words → pieces. */
interface PreparedText {
  lines: Word[][];
  /** The heaviest weight anywhere in the copy (spaces are measured at it — conservative). */
  maxWeight: number;
  /** No visible character at all (empty, whitespace, or tags only). */
  empty: boolean;
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
};

/** Decode the entities a reader sees as one character. An unknown named entity is left
 *  as typed: its literal spelling is wider than the glyph, so it can only over-measure. */
function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});/gi, (m, body: string) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return m;
      // A numeric no-break space is still a space to the word splitter (as &nbsp; is).
      return cp === 0xa0 ? ' ' : String.fromCodePoint(cp);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

/** CSS `bolder` (CSS Fonts 4): what <b>/<strong> do to the weight they sit in. */
function bolder(w: number): number {
  if (w < 350) return 400;
  if (w < 550) return 700;
  return 900;
}
/** CSS `lighter` (CSS Fonts 4). */
function lighter(w: number): number {
  if (w < 550) return 100;
  if (w < 750) return 400;
  return 700;
}

/** The weight an opening tag sets for its contents. An inline `font-weight` wins over the
 *  tag's own default, as it does in the browser (`<b style="font-weight:400">` is regular). */
function openedWeight(name: string, attrs: string, current: number): number {
  const fw = /font-weight\s*:\s*([a-z0-9]+)/i.exec(attrs);
  if (fw) {
    const v = fw[1]!.toLowerCase();
    if (v === 'bold') return 700;
    if (v === 'normal') return 400;
    if (v === 'bolder') return bolder(current);
    if (v === 'lighter') return lighter(current);
    const n = Number(v);
    if (Number.isFinite(n) && n >= 1 && n <= 1000) return n;
    return current;
  }
  return name === 'b' || name === 'strong' ? bolder(current) : current;
}

/** Apply a CSS text-transform to plain text for measurement (uppercase widens
 *  real glyphs — we measure the transformed glyphs directly rather than guess). */
function applyTransform(plain: string, textTransform: string): string {
  if (textTransform === 'uppercase') return plain.toUpperCase();
  if (textTransform === 'lowercase') return plain.toLowerCase();
  return plain;
}

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>|<[^>]*>/g;

/**
 * Read inline HTML into runs of visible text at their drawn weight: tags dropped,
 * `<br>` turned into a line break, entities decoded, b/strong/font-weight tracked with
 * a tag stack (so a closing tag restores the weight its opening tag replaced).
 */
function readRuns(html: string, baseWeight: number): Piece[] {
  const runs: Piece[] = [];
  const stack: { name: string; weight: number }[] = [];
  const weightNow = () => (stack.length ? stack[stack.length - 1]!.weight : baseWeight);
  const push = (text: string) => {
    if (!text) return;
    const weight = weightNow();
    const last = runs[runs.length - 1];
    if (last && last.weight === weight) last.text += text;
    else runs.push({ text, weight });
  };
  let at = 0;
  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(html); m; m = TAG_RE.exec(html)) {
    push(decodeEntities(html.slice(at, m.index)));
    at = m.index + m[0].length;
    const name = (m[2] ?? '').toLowerCase();
    if (!name) continue; // a comment or junk inside angle brackets: not visible
    if (name === 'br') {
      push('\n');
      continue;
    }
    if (m[1] === '/') {
      // Close the nearest open tag of that name (and anything left open inside it).
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.name === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    if (/\/\s*$/.test(m[3] ?? '')) continue; // self-closing: no contents to style
    stack.push({ name, weight: openedWeight(name, m[3] ?? '', weightNow()) });
  }
  push(decodeEntities(html.slice(at)));
  return runs;
}

/**
 * The text a reader sees, for measuring and for showing copy to a model: tags dropped,
 * `<br>` as "\n", entities decoded. Exported so every measurer reads copy the same way
 * (an ad-hoc `replace(/<[^>]+>/g, '')` merges the lines either side of a <br>).
 */
export function plainTextForMeasure(html: string): string {
  return readRuns(html ?? '', 400)
    .map((r) => r.text)
    .join('');
}

/** Split runs into hard lines → words → pieces, applying the text-transform per run
 *  (uppercasing can change a run's length, so it is never applied across a boundary). */
function splitWords(runs: Piece[], textTransform: string): Word[][] {
  const lines: Word[][] = [[]];
  let word: Word = [];
  const endWord = () => {
    if (word.length) lines[lines.length - 1]!.push(word);
    word = [];
  };
  for (const run of runs) {
    let buf = '';
    const flush = () => {
      if (!buf) return;
      const last = word[word.length - 1];
      if (last && last.weight === run.weight) last.text += buf;
      else word.push({ text: buf, weight: run.weight });
      buf = '';
    };
    for (const ch of applyTransform(run.text, textTransform)) {
      if (ch === '\n') {
        flush();
        endWord();
        lines.push([]);
      } else if (/\s/.test(ch)) {
        // Whitespace tokenisation (not a classification heuristic).
        flush();
        endWord();
      } else {
        buf += ch;
      }
    }
    flush();
  }
  endWord();
  return lines;
}

// Generation measures the same handful of strings many times over (every candidate
// layout, every binary-search step), so the parse is memoised. Small and bounded:
// cleared outright when full rather than tracking recency.
const PREPARED = new Map<string, PreparedText>();
const PREPARED_MAX = 512;

function prepareText(text: string, fontWeight: number, textTransform: string): PreparedText {
  const key = `${fontWeight}|${textTransform}|${text}`;
  const hit = PREPARED.get(key);
  if (hit) return hit;
  const runs = readRuns(text ?? '', fontWeight);
  const lines = splitWords(runs, textTransform);
  // A break that ends the copy opens no new line: "a<br>" (and "a\n" under pre-wrap) is
  // one line in the browser; it takes "a<br><br>" to show a blank line after it.
  const endsInBreak = runs.length > 0 && runs[runs.length - 1]!.text.endsWith('\n');
  if (endsInBreak && lines.length > 1 && lines[lines.length - 1]!.length === 0) lines.pop();
  let maxWeight = fontWeight;
  for (const r of runs) if (/\S/.test(r.text)) maxWeight = Math.max(maxWeight, r.weight);
  const prepared: PreparedText = { lines, maxWeight, empty: !lines.some((l) => l.length > 0) };
  if (PREPARED.size >= PREPARED_MAX) PREPARED.clear();
  PREPARED.set(key, prepared);
  return prepared;
}

/** Width (px) of one word as drawn — the sum of its pieces, each at its own weight. */
function wordWidth(word: Word, fontFamily: string, fontSize: number, letterSpacing: number): number {
  let w = 0;
  for (const p of word) w += measureRunWidthPx(p.text, fontFamily, p.weight, fontSize, letterSpacing);
  return w;
}

/** Greedy word-wrap of prepared copy at `fontSize` in `boxWidthPx`, honouring hard
 *  line breaks. Measured in PIXELS from the font's real glyph advances (fontMetrics),
 *  so a proportional face wraps where it actually would — no fixed chars-per-line
 *  assumption. Negative letter-spacing is clamped to stay conservative. */
function countLines(
  prep: PreparedText,
  fontSize: number,
  boxWidthPx: number,
  fontFamily: string,
  letterSpacing: number,
): number {
  const spaceW = measureRunWidthPx(' ', fontFamily, prep.maxWeight, fontSize, letterSpacing);
  const box = Math.max(1, boxWidthPx);
  let lines = 0;
  for (const words of prep.lines) {
    if (words.length === 0) {
      lines += 1; // a blank line still occupies a row
      continue;
    }
    let colW = 0; // measured width (px) of the current line so far
    let lineCount = 1;
    for (const word of words) {
      const wW = wordWidth(word, fontFamily, fontSize, letterSpacing);
      if (colW === 0) {
        colW = wW;
        // A single word wider than the box wraps internally (break-word).
        if (wW > box) lineCount += Math.floor(wW / box);
      } else if (colW + spaceW + wW <= box) {
        colW += spaceW + wW;
      } else {
        lineCount += 1;
        colW = wW;
        if (wW > box) lineCount += Math.floor(wW / box);
      }
    }
    lines += lineCount;
  }
  return Math.max(1, lines);
}

/** Width (px) of the widest word, for the "no mid-word break" guard. */
function widestWord(prep: PreparedText, fontFamily: string, fontSize: number, letterSpacing: number): number {
  let w = 0;
  for (const line of prep.lines) for (const word of line) w = Math.max(w, wordWidth(word, fontFamily, fontSize, letterSpacing));
  return w;
}

/** Width (px) of the widest HARD line set on one line (no wrapping). */
function widestLine(prep: PreparedText, fontFamily: string, fontSize: number, letterSpacing: number): number {
  const spaceW = measureRunWidthPx(' ', fontFamily, prep.maxWeight, fontSize, letterSpacing);
  let widest = 0;
  for (const words of prep.lines) {
    let w = 0;
    words.forEach((word, i) => {
      w += (i > 0 ? spaceW : 0) + wordWidth(word, fontFamily, fontSize, letterSpacing);
    });
    widest = Math.max(widest, w);
  }
  return widest;
}

/** The rendered height (px) of `text` at `fontSize` in a `boxWidthPx` column. */
export function estimateTextHeight(opts: {
  text: string;
  fontSize: number;
  boxWidthPx: number;
  lineHeight: number;
  fontFamily: string;
  fontWeight: number;
  letterSpacing?: number;
  textTransform?: string;
}): number {
  const prep = prepareText(opts.text, opts.fontWeight, opts.textTransform ?? 'none');
  const lines = countLines(prep, opts.fontSize, opts.boxWidthPx, opts.fontFamily, opts.letterSpacing ?? 0);
  return lines * opts.fontSize * opts.lineHeight;
}

/**
 * Width (px) of the widest hard line of `text` set WITHOUT wrapping — what a box drawn
 * with `white-space: pre` (text copied from a PDF, see extractedText.keepsPdfLines)
 * occupies, and how wide a box must be to hold each line on one row. Bold runs and
 * `<br>` are read as the browser draws them.
 */
export function widestLineWidthPx(opts: {
  text: string;
  fontSize: number;
  fontFamily: string;
  fontWeight: number;
  letterSpacing?: number;
  textTransform?: string;
}): number {
  const prep = prepareText(opts.text, opts.fontWeight, opts.textTransform ?? 'none');
  return widestLine(prep, opts.fontFamily, opts.fontSize, opts.letterSpacing ?? 0);
}

/**
 * Largest font size in [minFontSize, maxFontSize] at which `text` fits inside
 * boxW×boxH (with optional maxLines cap). Never returns above max or below min;
 * if it can't fit even at min, returns min (the renderer then clips cleanly).
 */
export function fitFontSize(opts: {
  text: string;
  boxW: number;
  boxH: number;
  maxFontSize: number;
  minFontSize: number;
  lineHeight: number;
  fontFamily: string;
  fontWeight: number;
  maxLines?: number;
  letterSpacing?: number;
  textTransform?: string;
}): number {
  const { boxW, boxH, lineHeight, fontFamily } = opts;
  const letterSpacing = opts.letterSpacing ?? 0;
  const max = Math.max(6, opts.maxFontSize);
  const min = Math.max(6, Math.min(opts.minFontSize, max));
  const prep = prepareText(opts.text, opts.fontWeight, opts.textTransform ?? 'none');
  if (prep.empty) return max;
  const fits = (size: number): boolean => {
    // A single word wider than the box breaks mid-word (e.g. "THOROUG|HBRED") —
    // that always reads as broken, so shrink until the longest word fits.
    if (boxW > 0 && widestWord(prep, fontFamily, size, letterSpacing) > boxW + 0.5) return false;
    const lines = countLines(prep, size, boxW, fontFamily, letterSpacing);
    if (opts.maxLines && lines > opts.maxLines) return false;
    return lines * size * lineHeight <= boxH;
  };
  if (fits(max)) return max;
  // Integer binary search for the largest fitting size.
  let lo = min;
  let hi = max;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ── How much room an element's copy needs ────────────────────────────────────

/** What an element's text needs against the box it has — the numbers the page check,
 *  the Studio's edit tools and their "fit" results report. */
export interface ElementTextFit {
  /** The size measured at (the element's own unless one was asked about). */
  fontSize: number;
  /** The column width measured in (the box width unless one was asked about). */
  width: number;
  /** Rendered lines at that size and width (hard lines only when `noWrap`). */
  lines: number;
  /** Height (px) the copy needs at that size. */
  needPx: number;
  /** Height (px) of the box. */
  havePx: number;
  /** How far the copy runs past the bottom of the box (0 when it fits). */
  overflowPx: number;
  /** Drawn exactly as a PDF set it (white-space: pre): lines never wrap, they run on. */
  noWrap: boolean;
  /** Width (px) of the widest hard line set on one row. */
  widestLinePx: number;
  /** Whether the copy fits: its height fits the box, and no word (or, when `noWrap`, no
   *  line) is wider than the box. The same rule fitFontSize applies. */
  fits: boolean;
  /** The ceiling a shrink-to-fit refit starts from (maxFontSize, else the size itself). */
  ceiling: number;
  /** Largest whole size ≤ the ceiling at which the copy fits the box (6px is the least
   *  ever tried); null when even that does not fit. Equal to `ceiling` when it fits there. */
  fitsAtPx: number | null;
}

/**
 * Measure an element's copy against its box: "how tall does this text need to be at
 * size S in width W, and what size would fit". `opts.fontSize` / `opts.width` /
 * `opts.height` ask about a size or box the element does not have yet (the Studio
 * checking a font-size change or a resize before it is applied). Returns null for a
 * non-text element. Pure; it reads only the element.
 */
export function measureElementText(
  el: Pick<MagazineElement, 'type' | 'w' | 'h' | 'text' | 'source'>,
  opts: { fontSize?: number; width?: number; height?: number } = {},
): ElementTextFit | null {
  if (el.type !== 'text' || !el.text) return null;
  const t = el.text;
  const fontSize = opts.fontSize !== undefined && opts.fontSize > 0 ? opts.fontSize : t.fontSize;
  const width = Math.max(1, opts.width ?? el.w);
  const havePx = Math.max(0, opts.height ?? el.h);
  const letterSpacing = t.letterSpacing ?? 0;
  const transform = t.textTransform ?? 'none';
  const prep = prepareText(t.content ?? '', t.fontWeight, transform);
  const widestLinePx = widestLine(prep, t.fontFamily, fontSize, letterSpacing);
  // Text still drawn as its PDF set it never wraps (previewHtml / IssuePageCanvas draw it
  // with white-space: pre): its height is its hard lines, and a long line runs on past
  // the box instead of wrapping. Asked about a different width, it is judged as the
  // flowing text such an edit turns it into (writePipeline / extractedText.asFlowingText).
  const noWrap = opts.width === undefined && keepsPdfLines(el);
  const linesAt = (size: number): number =>
    noWrap ? Math.max(1, prep.lines.length) : countLines(prep, size, width, t.fontFamily, letterSpacing);
  // The same rule fitFontSize applies (height within the box, no word wider than it),
  // with a PDF-set line standing in for a word when lines never wrap.
  const fitsAt = (size: number): boolean => {
    if (prep.empty) return true;
    const tooWide = noWrap
      ? widestLine(prep, t.fontFamily, size, letterSpacing) > width + 0.5
      : widestWord(prep, t.fontFamily, size, letterSpacing) > width + 0.5;
    return !tooWide && linesAt(size) * size * t.lineHeight <= havePx + 0.5;
  };
  const lines = linesAt(fontSize);
  const needPx = prep.empty ? 0 : lines * fontSize * t.lineHeight;
  const ceiling = typeof t.maxFontSize === 'number' ? Math.max(t.maxFontSize, fontSize) : fontSize;
  return {
    fontSize,
    width,
    lines,
    needPx,
    havePx,
    overflowPx: Math.max(0, needPx - havePx),
    noWrap,
    widestLinePx,
    fits: fitsAt(fontSize),
    ceiling,
    fitsAtPx: largestFittingSize(ceiling, fitsAt),
  };
}

/** Largest whole size in [6, ceiling] passing `ok` (the ceiling itself when it passes),
 *  or null when even 6px does not. `ok` must be monotonic: fitting at a size implies
 *  fitting at every smaller one, which holds for wrapped and unwrapped copy alike. */
function largestFittingSize(ceiling: number, ok: (size: number) => boolean): number | null {
  if (ok(ceiling)) return ceiling;
  let lo = 6;
  let hi = Math.ceil(ceiling) - 1;
  if (lo > hi || !ok(lo)) return null;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ok(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ── Colour / contrast ────────────────────────────────────────────────────────

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function toRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
export function relativeLuminance(hex: string): number {
  if (!HEX_RE.test(hex)) return 0;
  const [r, g, b] = toRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
export function isDark(hex: string): boolean {
  return relativeLuminance(hex) < 0.4;
}

/**
 * Return `desired` if it reads acceptably on `bg`; otherwise the palette colour
 * (light or dark) that contrasts best. Keeps generated text legible over any
 * scrim/panel/background colour without a model call.
 */
export function readableColor(desired: string, bg: string, light: string, dark: string): string {
  const MIN = 3.5; // large display text — a touch below the 4.5 body threshold
  if (HEX_RE.test(desired) && HEX_RE.test(bg) && contrastRatio(desired, bg) >= MIN) return desired;
  const candLight = HEX_RE.test(light) ? light : '#ffffff';
  const candDark = HEX_RE.test(dark) ? dark : '#111111';
  return contrastRatio(candLight, bg) >= contrastRatio(candDark, bg) ? candLight : candDark;
}

// ── Server write-path hook ─────────────────────────────────────────────────────

/**
 * Recompute fontSize for shrink-to-fit text that declares a maxFontSize.
 * Extracted text (no maxFontSize) keeps its measured size untouched. Runs on
 * every element write (via writePipeline.normalizeElements).
 *
 * Honours the element's OWN `minFontSize` when it carries one. The 55%-of-ceiling
 * default is a reasonable guess for hand-made text, but it is not a print floor: a body
 * slot composed with an 8pt floor would be re-fitted from `24 × 0.55 = 13px` (6.3pt) on
 * the very next save, so the legibility rule would hold only until someone dragged the
 * box. Carrying the floor on the element is what makes it durable.
 */
export function refitText(elements: MagazineElement[]): MagazineElement[] {
  return elements.map((el) => {
    if (el.type !== 'text' || !el.text) return el;
    const t = el.text;
    if (t.autoFit !== 'shrink' || typeof t.maxFontSize !== 'number') return el;
    const fontSize = fitFontSize({
      text: t.content,
      boxW: el.w,
      boxH: el.h,
      maxFontSize: t.maxFontSize,
      minFontSize: typeof t.minFontSize === 'number' ? t.minFontSize : Math.max(6, Math.round(t.maxFontSize * 0.55)),
      lineHeight: t.lineHeight,
      fontFamily: t.fontFamily,
      fontWeight: t.fontWeight,
      letterSpacing: t.letterSpacing,
      textTransform: t.textTransform,
    });
    return { ...el, text: { ...t, fontSize } };
  });
}
