// ---------------------------------------------------------------------------
// Magazine Builder v2 — the PURE half of the studio's Operator actions
// (useMagazineEditorActions.ts).
//
// Everything here is a decision that can be got wrong in a way a test can see,
// so it lives apart from the store, the DOM and the network:
//
//   studioPrompt        what the Magazine AI Studio is sent for "page N" (C21)
//   magazineWideSwap    "replace X with Y everywhere" — a job for
//                       magazine.replaceText, not for the studio (C17)
//   pageElementList     the compact element list magazine.checkPage returns, so
//                       a follow-up can name the exact element
//   chartSpecArgs       the chart a Stable Hand action takes (mirrors the
//                       server's chartSpecSchema; the server validates)
//   mergeChartChanges   "change 2023 to 14" against a chart's stored numbers
//   plainNumber         a figure as written ("1,234"), never a guess ("about 7")
//   pickDocument        "add pages from the brochure" → which attached document
//   replaceQuestion     the confirm card for a magazine-wide replace (and
//                       replaceLeftAlone: what it leaves alone, and why)
//   applyAllQuestion    the confirm card before applying EVERY page's waiting
//                       Design Helper changes, when that is more than the latest
//                       request staged
//   measuredSentence    what an action says about the page after it measured it
//
// No store, no DOM, no fetch: `npx tsx --test` runs the tests next to it.
// ---------------------------------------------------------------------------

import { z } from 'zod';
import type { MagazineElement } from '../model';
import { changeCount, pagesPhrase } from '../pendingChanges';
import { listInWords } from '../proposals';

// ── "page N" in a studio request (C21) ──────────────────────────────────────

/** The two facts studioPrompt needs about a page: its id and its 0-based index
 *  (the REAL page number is index + 1 — see shared.pageNo). */
export interface PageRef {
  id: string;
  index: number;
}

/**
 * A "page N" that is about SOMETHING ELSE: "page 3 of the attached PDF", "page 1
 * of Spring_Brochure.pdf", "page 5 in the report", "page 2 from the brochure".
 * Those name a page of a DOCUMENT and must reach the studio word for word —
 * rewriting them to "this page" sent use_document_as_layout to the wrong PDF page
 * (it defaults to page 1). The one exception is "of/in/from the magazine / issue /
 * edition", which IS this magazine. Matching "anything after of/in/from that is
 * not the magazine" (instead of a list of document words) also keeps file names.
 */
const PAGE_REF =
  /\b(?:the\s+)?page\s*(?:no\.?\s*|number\s*|#\s*)?(\d+)(['’]s)?\b(?!\s+(?:of|in|from)\s+(?!(?:the\s+|this\s+)?(?:magazine|issue|edition)\b))/gi;

/**
 * The studio works on the OPEN page (its composer tags the turn "PAGE n") and
 * reads any "page N" in the text as an absolute page of the magazine. A
 * page-scoped collaborator can't open other pages, so "set it as page 1's
 * background" got "I can't access page 1 from here". So any mention of the open
 * page — by its real number or its rail position (a collaborator's single page is
 * "Page 3" at rail position 1) — becomes "this page". A page of a DOCUMENT is left
 * exactly as written (PAGE_REF's look-ahead).
 */
export function studioPrompt(prompt: string, pages: readonly PageRef[], currentPageId: string | null | undefined): string {
  const idx = pages.findIndex((p) => p.id === currentPageId);
  if (idx < 0) return prompt;
  const same = new Set([pages[idx]!.index + 1, idx + 1]);
  return prompt
    .replace(PAGE_REF, (m, num: string, poss?: string) => (same.has(Number(num)) ? (poss ? "this page's" : 'this page') : m))
    .replace(/\bthis page['’]s\b/g, "this page's");
}

// ── word swaps across the magazine (C17) ─────────────────────────────────────

export interface WordSwap {
  find: string;
  replace: string;
}

/** "everywhere", "on every page", "throughout the magazine", "across all pages"… */
const MAGAZINE_WIDE =
  /\b(?:everywhere|throughout|across\s+(?:all\s+(?:of\s+)?)?(?:the\s+)?(?:whole\s+|entire\s+)?(?:magazine|issue|edition|pages|document)|(?:on|in|across)\s+(?:all|every|each)\s+(?:of\s+the\s+)?pages?|all\s+(?:of\s+)?(?:the\s+)?pages|every\s+page|each\s+page|(?:the\s+)?(?:whole|entire)\s+(?:magazine|issue|edition))\b/i;

const SWAP_VERB = '(?:replace|swap|change|rename|substitute|switch)';
const SWAP_JOIN = '(?:with|to|for|by|into)';
const SWAP_LEAD = '(?:(?:all|every|each)\\s+)?(?:(?:instances?|occurrences?|mentions?|uses?)\\s+of\\s+)?(?:the\\s+(?:word|name|term|phrase|abbreviation|acronym)\\s+)?';

/** replace "NZTROF" with "NOG" — quotes make the words unambiguous. */
const QUOTED_SWAP = new RegExp(`\\b${SWAP_VERB}\\s+${SWAP_LEAD}["“‘'](.+?)["”’']\\s+${SWAP_JOIN}\\s+["“‘'](.*?)["”’']`, 'i');
/** replace NZTROF with NOG everywhere — 1 to 4 words each side, ended by the scope
 *  words, punctuation or the end of the request. */
const BARE_SWAP = new RegExp(
  `\\b${SWAP_VERB}\\s+${SWAP_LEAD}(\\S+(?:\\s+\\S+){0,3}?)\\s+${SWAP_JOIN}\\s+(\\S+(?:\\s+\\S+){0,3}?)` +
    '(?=\\s*(?:[,.;!?]|$)|\\s+(?:everywhere|throughout|across|on\\s+(?:all|every|each)|in\\s+(?:all|every|each|the\\s+(?:whole|entire))))',
  'i',
);

/** A "find" that describes an ELEMENT rather than quoting words ("the headline", "the
 *  photo", "all the fonts") is a design request — that is the studio's job. */
const NOT_A_WORD = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'my', 'our', 'your', 'its', 'their', 'all', 'every', 'each', 'page', 'pages',
]);
const ELEMENT_WORDS = new Set([
  'headline', 'headlines', 'title', 'titles', 'heading', 'headings', 'photo', 'photos', 'image', 'images', 'picture', 'pictures',
  'font', 'fonts', 'colour', 'colours', 'color', 'colors', 'background', 'backgrounds', 'size', 'sizes', 'layout', 'layouts',
  'caption', 'captions', 'byline', 'bylines', 'body', 'text', 'paragraph', 'paragraphs', 'logo', 'logos', 'style', 'styles',
  'typeface', 'chart', 'charts', 'page', 'pages',
]);

const unquote = (s: string) =>
  s
    .trim()
    .replace(/^["“‘']+|["”’']+$/g, '')
    .replace(/[,.;:!?]+$/, '')
    .trim();

/**
 * Is this studio request really "swap a word or name across the whole magazine"?
 * Returns the two strings when it is, else null.
 *
 * The studio edits ONLY the open page, and before replace_text it could only do it
 * by retyping whole paragraphs it saw 60 characters of — "replace NZTROF with NOG
 * everywhere" rewrote paragraphs on one page and reported the magazine done. A swap
 * across pages is a deterministic job (magazine.replaceText: every page, a count per
 * page shown before anything changes). Only a request that names the magazine-wide
 * scope AND quotes or names literal words counts, so "change the headline to …"
 * on one page still goes to the studio.
 */
export function magazineWideSwap(prompt: string): WordSwap | null {
  const text = String(prompt ?? '');
  if (!MAGAZINE_WIDE.test(text)) return null;
  const quoted = QUOTED_SWAP.exec(text);
  if (quoted) {
    const find = quoted[1]!.trim();
    return find ? { find, replace: quoted[2]!.trim() } : null;
  }
  const bare = BARE_SWAP.exec(text);
  if (!bare) return null;
  const find = unquote(bare[1]!);
  const replace = unquote(bare[2]!);
  if (!find || !replace) return null;
  const words = find.toLowerCase().split(/\s+/);
  if (NOT_A_WORD.has(words[0]!) || words.some((w) => ELEMENT_WORDS.has(w))) return null;
  // "change it to …", "switch them for …" — a pronoun is not a word to find.
  if (/^(?:it|them|they|he|she|him|her)$/i.test(find)) return null;
  return { find, replace };
}

// ── the element list magazine.checkPage returns ─────────────────────────────

/** One element, as a follow-up needs it: enough to NAME it (id, a short label) and
 *  to give the studio measured numbers (box, z, size). */
export interface ElementBrief {
  id: string;
  type: MagazineElement['type'];
  role?: string;
  label: string;
  /** [x, y, w, h] in page px, rounded. */
  box: [number, number, number, number];
  z: number;
  fontSize?: number;
  /** An image element with no picture in it (an empty slot to fill or replace). */
  empty?: true;
  locked?: true;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** The words a reader sees in an element's stored HTML (tags gone, entities read). */
export function plainText(html: string): string {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_m, k: string) => ENTITIES[k] ?? _m)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Clip to n characters with a visible ellipsis — a cut is never silent. */
export function clipText(s: string, n: number): string {
  const chars = Array.from(s);
  return chars.length > n ? `${chars.slice(0, n - 1).join('').trimEnd()}…` : s;
}

const LABEL_CHARS = 40;

/** A short, human label for one element ("body: The New Owners Group (NOG) is…"). */
export function elementBrief(el: MagazineElement): ElementBrief {
  let label: string;
  if (el.type === 'text') {
    const words = plainText(el.text?.content ?? '');
    label = words ? clipText(words, LABEL_CHARS) : '(empty text box)';
  } else if (el.type === 'image') {
    label = el.image?.url ? clipText(el.image.alt?.trim() || 'picture', LABEL_CHARS) : 'empty picture slot';
  } else if (el.type === 'shape') {
    const op = el.shape?.opacity;
    label = `shape ${el.shape?.fill ?? ''}${typeof op === 'number' && op < 1 ? ` at ${Math.round(op * 100)}%` : ''}`.trim();
  } else if (el.type === 'qr') {
    label = clipText(`QR code ${el.qr?.url ?? ''}`.trim(), LABEL_CHARS);
  } else {
    label = el.icon?.name ? `icon ${el.icon.name}` : 'icon';
  }
  const out: ElementBrief = {
    id: el.id,
    type: el.type,
    label,
    box: [Math.round(el.x), Math.round(el.y), Math.round(el.w), Math.round(el.h)],
    z: el.zIndex,
  };
  if (el.type === 'text' && el.text) {
    out.role = String(el.text.role);
    out.fontSize = Math.round(el.text.fontSize * 10) / 10;
  }
  if (el.type === 'image' && !el.image?.url) out.empty = true;
  if (el.locked) out.locked = true;
  return out;
}

/** The page's elements top-down (reading order: y, then x), capped so a busy page
 *  cannot flood the model's context. */
export function pageElementList(elements: readonly MagazineElement[], cap = 60): { elements: ElementBrief[]; more?: number } {
  const sorted = [...elements].sort((a, b) => a.y - b.y || a.x - b.x || a.zIndex - b.zIndex);
  const list = sorted.slice(0, cap).map(elementBrief);
  return sorted.length > cap ? { elements: list, more: sorted.length - cap } : { elements: list };
}

// ── charts ───────────────────────────────────────────────────────────────────

/**
 * The chart a Stable Hand action takes. STRUCTURAL only, on purpose — the same
 * choice the server's chartSpecSchema makes: the limits (slices, lengths, a series
 * per category) are checked by the server's validateChartSpec, which answers in
 * words the model can fix in one step. Categories may arrive as numbers (years);
 * they are labels, so they become strings.
 */
export const chartSpecArgs = z.object({
  type: z.enum(['bar', 'barh', 'line', 'pie', 'donut', 'table']),
  title: z.string().optional(),
  subtitle: z.string().optional(),
  source: z.string().optional(),
  categories: z.array(z.union([z.string(), z.number()]).transform((c) => String(c))).min(1),
  series: z.array(z.object({ name: z.string(), values: z.array(z.number()) })).min(1),
  unit: z.object({ prefix: z.string().optional(), suffix: z.string().optional() }).optional(),
  decimals: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  showValues: z.boolean().optional(),
  highlight: z.string().optional(),
  stacked: z.boolean().optional(),
});

/** The shared ChartSpec contract (server chartSpec.ts), as the web holds it. */
export type WebChartSpec = z.output<typeof chartSpecArgs>;

const sameLabel = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * A number as written: a number, or plain numerals in a string ("14", "1,234",
 * "-3.5") — the same rule as the server's chartSpec toNumber. Anything that needs
 * interpreting ("$5", "about 7") is refused rather than guessed.
 */
export function plainNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/,(?=\d{3}(\D|$))/g, '').replace(/\s+/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Apply a change to a chart's stored numbers — the client twin of the server's
 * applyChartChanges, so "change 2023 to 14" needs no new route: the merged spec goes
 * back through POST …/chart, whose validator then checks it in full.
 *
 *   • any spec field REPLACES the stored one (categories and series wholesale);
 *   • an empty title / subtitle / source REMOVES that line;
 *   • setValues: [{ category, series?, value }] changes single numbers in place;
 *   • new categories without new series must keep the same count — otherwise the
 *     numbers would silently slide onto different labels.
 */
export function mergeChartChanges(spec: WebChartSpec, changes: unknown): { ok: true; spec: WebChartSpec } | { ok: false; error: string } {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return { ok: false, error: 'Say what to change on the chart.' };
  const c = changes as Record<string, unknown>;
  const next: Record<string, unknown> = { ...spec, series: spec.series.map((s) => ({ name: s.name, values: [...s.values] })) };
  for (const key of ['type', 'categories', 'series', 'unit', 'decimals', 'showValues', 'highlight', 'stacked'] as const) {
    if (c[key] !== undefined) next[key] = c[key];
  }
  // "Make it a line chart" on a STACKED bar chart: stacking means nothing to a line,
  // pie or table, and the server's validator refuses it there, so carrying the
  // stored `stacked: true` over made every change of type on a stacked chart come
  // back as a 400 from POST /chart. A new type that cannot stack drops it, unless
  // the caller asked for it explicitly (that one is still refused, with the reason).
  // Mirrors the server's applyChartChanges.
  if (typeof c.type === 'string' && c.type !== 'bar' && c.type !== 'barh' && c.stacked === undefined) delete next.stacked;
  for (const key of ['title', 'subtitle', 'source'] as const) {
    if (typeof c[key] === 'string') {
      const t = (c[key] as string).trim();
      if (t) next[key] = t;
      else delete next[key];
    }
  }
  if (Array.isArray(c.categories) && c.series === undefined && c.categories.length !== spec.categories.length) {
    return {
      ok: false,
      error: `The new categories (${c.categories.length}) do not match the chart's ${spec.categories.length} values. Send the series with one value per new category too.`,
    };
  }
  if (Array.isArray(c.categories) && c.highlight === undefined && typeof spec.highlight === 'string') {
    if (!c.categories.some((x) => sameLabel(String(x), spec.highlight as string))) delete next.highlight;
  }
  if (c.setValues !== undefined) {
    if (!Array.isArray(c.setValues)) return { ok: false, error: 'setValues must be a list of { category, value } (and series when there are several).' };
    const cats = (Array.isArray(next.categories) ? next.categories : spec.categories).map((x) => String(x));
    const series = next.series as { name?: unknown; values?: unknown[] }[];
    for (const raw of c.setValues) {
      const sv = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const label = typeof sv.category === 'string' || typeof sv.category === 'number' ? String(sv.category) : '';
      const idx = cats.findIndex((x) => sameLabel(x, label));
      if (idx < 0) return { ok: false, error: `The chart has no category "${label}". Its categories are: ${cats.join(', ')}.` };
      let target = series.length === 1 ? series[0] : undefined;
      if (typeof sv.series === 'string' && sv.series.trim()) {
        target = series.find((s) => typeof s.name === 'string' && sameLabel(s.name, sv.series as string));
        if (!target) return { ok: false, error: `The chart has no series "${sv.series}". Its series are: ${series.map((s) => String(s.name)).join(', ')}.` };
      }
      if (!target) return { ok: false, error: `The chart has ${series.length} series — name which one to change (${series.map((s) => String(s.name)).join(', ')}).` };
      const n = plainNumber(sv.value);
      if (n === null) return { ok: false, error: `The new value for "${label}" is not a plain number (${JSON.stringify(sv.value)}); give the exact figure.` };
      if (Array.isArray(target.values)) target.values[idx] = n;
    }
  }
  const parsed = chartSpecArgs.safeParse(next);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: `That change leaves the chart unreadable (${first ? `${first.path.map(String).join('.') || 'chart'}: ${first.message}` : 'invalid'}).` };
  }
  return { ok: true, spec: parsed.data };
}

// ── which attached document ("add pages from the brochure") ─────────────────

/** A document the magazine has, from either store: the Uploads library (chat and
 *  Uploads-tab files, kind 'upload') or the files it was first built from ('source'). */
export interface DocChoice {
  id: string;
  name: string;
  kind: 'upload' | 'source';
  /** Has text a page can be written from. */
  readable: boolean;
  /** Why it cannot be read yet, when it cannot. */
  why?: string;
}

/**
 * Resolve "part of a file name" to exactly one document, the way copyPdfPage
 * resolves its PDF: an exact name wins, one partial match wins, several or none is
 * an error that lists what IS attached. The same file can be in both stores (built
 * from it, then attached again in chat) — that is one document, and the copy that
 * can be read is the one used (the source copy first: it is read page by page).
 */
export function pickDocument(query: string, docs: readonly DocChoice[]): { ok: true; doc: DocChoice } | { ok: false; error: string; noDocs?: true } {
  if (docs.length === 0) return { ok: false, noDocs: true, error: 'This magazine has no document attached yet.' };
  const want = query.trim().toLowerCase();
  const listed = () => [...new Set(docs.map((d) => `“${d.name}”`))].join(', ');
  const hits = docs.filter((d) => d.name.toLowerCase().includes(want));
  if (!want || hits.length === 0) return { ok: false, error: `No attached document matches “${query.trim()}”. Attached: ${listed()}.` };
  const exact = hits.filter((d) => d.name.toLowerCase() === want);
  const pool = exact.length > 0 ? exact : hits;
  const names = new Set(pool.map((d) => d.name.toLowerCase()));
  if (names.size > 1) {
    return { ok: false, error: `“${query.trim()}” matches several documents: ${[...new Set(pool.map((d) => `“${d.name}”`))].join(', ')}. Pass a longer part of the name.` };
  }
  const rank = (d: DocChoice) => (d.readable ? 0 : 2) + (d.kind === 'source' ? 0 : 1);
  const doc = [...pool].sort((a, b) => rank(a) - rank(b))[0]!;
  if (!doc.readable) return { ok: false, error: `“${doc.name}” can't be used yet: ${doc.why || 'it has no readable text'}.` };
  return { ok: true, doc };
}

// ── the magazine-wide replace confirm card ──────────────────────────────────

export interface ReplacePageCount {
  page: number;
  count: number;
}

/** Matches on a page the replace may not edit right now — the server's `blocked`. */
export interface ReplaceBlockedPage {
  page: number;
  count: number;
  /** The server's reason: 'page-submitted' | 'page-approved' | 'page-rebuilding'. */
  reason?: string;
}

/** Why a page is left alone, in a few words. */
function blockedWhy(reason: string | undefined): string {
  if (reason === 'page-submitted') return 'submitted for review';
  if (reason === 'page-approved') return 'approved';
  if (reason === 'page-rebuilding') return 'being rebuilt';
  return 'not editable right now';
}

/**
 * "2 more in locked boxes (unlock them to change)" and "5 more on pages that cannot be
 * edited right now: page 4 (3, submitted for review), page 7 (2, being rebuilt)".
 *
 * Three different things, and the server reports them apart: `skippedLocked` counts
 * matches inside LOCKED BOXES on pages the caller can edit; `skippedTooLong` counts
 * matches left alone because the longer text would push that box past the stored
 * text limit (writing it would have cut the end of the client's copy); `blocked`
 * lists the pages that are submitted, approved or being rebuilt. Calling the first
 * "submitted or approved pages" (as this used to) sent people looking on the wrong
 * pages, and never named the pages that really were left out.
 */
export function replaceLeftAlone(
  skippedLocked: number | undefined,
  blocked: readonly ReplaceBlockedPage[] | undefined,
  skippedTooLong?: number,
): string[] {
  const parts: string[] = [];
  if (skippedLocked && skippedLocked > 0) {
    parts.push(`${skippedLocked} in locked box${skippedLocked === 1 ? '' : 'es'} (unlock ${skippedLocked === 1 ? 'it' : 'them'} to change)`);
  }
  if (skippedTooLong && skippedTooLong > 0) {
    parts.push(
      `${skippedTooLong} left in box${skippedTooLong === 1 ? '' : 'es'} too full for the longer text (shorten ${skippedTooLong === 1 ? 'that box' : 'those boxes'} first, or use a shorter replacement)`,
    );
  }
  const pages = [...(blocked ?? [])].filter((b) => b.count > 0).sort((a, b) => a.page - b.page);
  const n = pages.reduce((sum, b) => sum + b.count, 0);
  if (n > 0) {
    const shown = pages.slice(0, 8).map((b) => `page ${b.page} (${b.count}, ${blockedWhy(b.reason)})`);
    parts.push(`${n} on page${pages.length === 1 ? '' : 's'} that cannot be edited right now: ${shown.join(', ')}${pages.length > 8 ? `, and ${pages.length - 8} more pages` : ''}`);
  }
  return parts;
}

/**
 * The question the user OKs before a magazine-wide replace: what, how many, WHERE
 * (a count per page), how it matches, what is left alone and why, and that Ctrl+Z
 * will not take it back (the replace is one server write per page, outside the
 * editor's undo stack).
 */
export function replaceQuestion(
  find: string,
  replace: string,
  pages: readonly ReplacePageCount[],
  opts: { matchCase?: boolean; wholeWord?: boolean; skippedLocked?: number; skippedTooLong?: number; blocked?: readonly ReplaceBlockedPage[] } = {},
): string {
  const total = pages.reduce((n, p) => n + p.count, 0);
  const sorted = [...pages].filter((p) => p.count > 0).sort((a, b) => a.page - b.page);
  const shown = sorted.slice(0, 12).map((p) => `page ${p.page} (${p.count})`);
  const where = `${shown.join(', ')}${sorted.length > 12 ? `, and ${sorted.length - 12} more pages` : ''}`;
  const places = `${total} place${total === 1 ? '' : 's'}`;
  const what = replace ? `Replace “${find}” with “${replace}”` : `Delete “${find}”`;
  const how = [opts.wholeWord ? 'whole words only' : '', opts.matchCase === false ? 'ignoring capitals' : 'matching capitals'].filter(Boolean).join(', ');
  const alone = replaceLeftAlone(opts.skippedLocked, opts.blocked, opts.skippedTooLong);
  const leftAlone = alone.length > 0 ? ` Left alone: ${alone.join('; ')}.` : '';
  const undo = replace ? ` Ctrl+Z will not take this back — to reverse it, replace “${replace}” with “${find}”.` : ' Ctrl+Z will not take this back.';
  return `${what} in ${places} — ${where}? (${how}.)${leftAlone}${undo}`;
}

// ── applying every page's waiting changes ───────────────────────────────────

/**
 * The card before magazine.applyStudioChanges applies EVERY page's waiting changes —
 * or null when no card is needed.
 *
 * Changes wait per page, and are restored from this browser for up to 30 days. "Apply
 * all" therefore reaches well past the request the user just made: one request on
 * page 5 would also apply a rewrite of page 3 staged weeks ago that nobody approved.
 * So when anything waits on a page OTHER than the latest request's (`turnPage`; null
 * when no request was made since the magazine opened), the user is shown every page
 * and its count first. Otherwise only the risky kinds ask (`riskParts`, as
 * stagedRiskQuestion words them: deletions, a rebuild, a PDF copy, a page build).
 */
export function applyAllQuestion(
  waiting: readonly { page: number; count: number }[],
  turnPage: number | null,
  riskParts: readonly string[],
): string | null {
  if (waiting.length === 0) return null;
  const sorted = [...waiting].sort((a, b) => a.page - b.page);
  const risk = riskParts.length > 0 ? `, including ${riskParts.join('; ')}` : '';
  const others = sorted.filter((w) => w.page !== turnPage);
  if (others.length === 0) {
    return riskParts.length > 0 ? `Apply the studio's changes${sorted.length > 1 ? ` on ${pagesPhrase(sorted.map((w) => w.page))}` : ''}${risk}?` : null;
  }
  const counts = sorted.map((w, i) => `${i === 0 ? changeCount(w.count) : w.count} on page ${w.page}`);
  const latest = turnPage !== null && sorted.some((w) => w.page === turnPage);
  const why = latest
    ? `Only page ${turnPage}'s came from the latest request — the rest were staged earlier and have not been applied.`
    : 'They were staged by earlier requests and have not been applied.';
  return `Apply every change waiting for Apply — ${listInWords(counts)}${risk}? ${why}`;
}

// ── what an action says after measuring the page ────────────────────────────

/** The parts of a PageCheck (pageCheck.ts contract) a sentence needs. */
export interface CheckLike {
  ok: boolean;
  summary?: string;
  issues: ReadonlyArray<{ severity: 'error' | 'warning'; label?: string; detail?: string }>;
}

/**
 * One sentence about the measured page, appended to an action's note. It replaces
 * "check the page with readScreen": readScreen collects text whether or not it is
 * cut off and never sees a picture, so it passed pages with clipped copy — and the
 * Stable Hand then told the user it could not see the page.
 */
export function measuredSentence(check: CheckLike | null | undefined, why?: string): string {
  if (!check) return `The page could not be measured just now (${why || 'unknown reason'}) — call magazine.checkPage before reporting.`;
  const errors = check.issues.filter((i) => i.severity === 'error');
  const warnings = check.issues.length - errors.length;
  if (errors.length === 0) {
    return warnings > 0
      ? `Measured: no errors, ${warnings} warning${warnings === 1 ? '' : 's'} (see pageCheck).`
      : 'Measured: no problems found (see pageCheck).';
  }
  const first = errors[0]!;
  // Labels of shapes / QR codes carry "#<id>"; ids never go to a person, and the model
  // repeats what it is given.
  const head = [first.label, first.detail].filter(Boolean).join(' — ').replace(/\s*#[\w-]{6,}/g, '');
  return `Measured: ${errors.length} error${errors.length === 1 ? '' : 's'} on the page${head ? `, e.g. ${head}` : ''}. Fix once only what the user's change touched (magazine.askStudio naming the element in words, magazine.adjustPage, or magazine.undo); report anything else and ask before fixing it.`;
}

/** The note after a change that was applied and measured. */
export function appliedNote(check: CheckLike | null | undefined, why?: string): string {
  return check
    ? `Applied and measured — see pageCheck. Fix (once) only an error on what THIS change touched; anything else on the page was already there: mention it and ask the user before fixing it. ${measuredSentence(check)}`
    : `Applied. ${measuredSentence(null, why)}`;
}

// ── never show an element id to a person ────────────────────────────────────
//
// The Design Helper chat shows The Stable Hand's request word for word, so a request
// written with ids ("set headline f6b12855-8167-… to 97px") put raw ids in front of
// the client (reported 2026-11-16). The studio does not need them: it reads every
// element of the open page, and a quoted excerpt or a position identifies one exactly.

/** One element in words: "the headline “Owners at the heart…”", "the picture at
 *  x 120, y 340 (640×362)". Always starts with "the". */
export function elementInWords(el: MagazineElement): string {
  const at = `at x ${Math.round(el.x)}, y ${Math.round(el.y)}`;
  const size = `${Math.round(el.w)}×${Math.round(el.h)}`;
  if (el.type === 'text') {
    const role = el.text?.role && el.text.role !== 'other' ? String(el.text.role) : 'text';
    const words = plainText(el.text?.content ?? '');
    return words ? `the ${role} “${clipText(words, 40)}”` : `the empty ${role} box ${at}`;
  }
  if (el.type === 'image') {
    const alt = el.image?.alt?.trim();
    if (!el.image?.url) return `the empty picture box ${at} (${size})`;
    return alt ? `the picture “${clipText(alt, 40)}”` : `the picture ${at} (${size})`;
  }
  if (el.type === 'shape') return `the ${el.shape?.fill ?? ''} shape ${at} (${size})`.replace(/\s+/g, ' ');
  if (el.type === 'qr') return `the QR code ${at}`;
  return `the ${el.icon?.name ? `${el.icon.name} ` : ''}icon ${at}`;
}

const ROLE_WORDS = 'element|box|text|headline|subhead|deck|body|byline|caption|kicker|label|quote|pull ?quote|drop ?cap|cap|photo|picture|image|shape|panel|icon|qr(?: code)?|folio';

/**
 * Replace every element id in `text` — bare, or as "#id" — with the element in words,
 * swallowing a "the" and a role word written just before it ("the drop cap <id>" →
 * "the drop cap “D”…", not "the drop cap the text …"). Ids of other pages' elements are
 * not known here and are left alone (the studio only edits the open page anyway).
 */
export function humanizeElementIds(text: string, elements: readonly MagazineElement[]): string {
  const known = [...elements].filter((e) => typeof e.id === 'string' && e.id.length >= 6).sort((a, b) => b.id.length - a.id.length);
  let out = String(text ?? '');
  for (const el of known) {
    const id = el.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:\\bthe\\s+)?(?:\\b(?:${ROLE_WORDS})\\s+)?(?:\\(\\s*)?#?${id}(?:\\s*\\))?`, 'gi');
    out = out.replace(re, () => elementInWords(el));
  }
  // "the 88%-opaque shape #id" became "the 88%-opaque the … shape": one "the" is enough.
  return out.replace(/\bthe (\S+) the\b/gi, 'the $1');
}

// ── fixing problems: ask first, then one pass ───────────────────────────────
//
// After a build The Stable Hand used to "fix" every page it measured without asking —
// page by page, then back to pages it had already done — for half an hour of paid AI
// time (reported 2026-11-16). Now problems it did not cause are REPORTED with an
// estimate and fixed only after the user says yes; and a fix is one request per page
// carrying every problem on it, so no page is visited twice.

/** About how long, and about what it costs, for the Design Helper to fix one page
 *  (one turn on its model + apply + a re-measure). Deliberately round and labelled
 *  "about": actual spend is on the AI Activity page. */
export const FIX_MINUTES_PER_PAGE = 1;
export const FIX_USD_PER_PAGE = 0.25;

export interface FixEstimate {
  pages: number;
  minutes: number;
  usd: number;
  text: string;
}

export function fixEstimate(pages: number): FixEstimate {
  const n = Math.max(0, Math.round(pages));
  const minutes = Math.max(1, Math.round(n * FIX_MINUTES_PER_PAGE));
  const usd = Math.round(n * FIX_USD_PER_PAGE * 100) / 100;
  return {
    pages: n,
    minutes,
    usd,
    text: `about ${minutes} minute${minutes === 1 ? '' : 's'} and about US$${usd.toFixed(2)} of AI usage`,
  };
}

interface IssueLike {
  severity: string;
  label: string;
  detail: string;
  fix: string;
}

/** The ONE Design Helper request that fixes every error on a page together, in words
 *  (no ids), keeping all wording. Warnings are left out: they are judgement calls the
 *  user did not ask for. Null when there is nothing to fix. */
export function fixRequestText(issues: readonly IssueLike[], elements: readonly MagazineElement[]): string | null {
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length === 0) return null;
  const lines = errors.map((i, n) => `${n + 1}. ${i.label}: ${i.detail} Fix: ${i.fix}`);
  return humanizeElementIds(
    [
      'Fix ALL of these problems on this page in this one request. Keep every word exactly as it is and change nothing else:',
      ...lines,
      'Stage every fix now, together, then stop.',
    ].join('\n'),
    elements,
  );
}

/** The confirm card for magazine.fixPages. */
export function fixPagesQuestion(pageNumbers: readonly number[] | null, totalPages: number): string {
  if (!pageNumbers || pageNumbers.length === 0) {
    const est = fixEstimate(totalPages);
    return `Check all ${totalPages} pages and fix the problems found, each page once? At most ${est.text} (less if fewer pages need fixing).`;
  }
  const est = fixEstimate(pageNumbers.length);
  return `Fix the problems on ${pagesPhrase(pageNumbers)}, each page once? ${est.text[0]!.toUpperCase()}${est.text.slice(1)}.`;
}

/** How many studio requests one Stable Hand run may make before it must stop and ask
 *  the user (magazine.fixPages is ONE action and does not count against this). */
export const MAX_STUDIO_REQUESTS_PER_RUN = 6;
