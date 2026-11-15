// ---------------------------------------------------------------------------
// Magazine Builder v2 — the page count a brief asks for.
//
// The composer has no page-count control: the brief itself is the only input
// ("… 12 pages"), and parsePageCount is what turns it into the number sent to
// the server. Two callers need the SAME reading of it:
//
//   MagazineV2Home       sends parsePageCount(brief) with Generate.
//   magazine.generate    (The Stable Hand) writes its pageCount into the brief
//                        it types, and must be sure the composer reads that
//                        number back — not a smaller "3 pages" section size the
//                        brief also mentions.
//
// They used to keep their own copies (a regex in the action that only asked
// "is ANY page count mentioned?"), and a brief like "results across 3 pages"
// with pageCount 12 built a 3-page magazine under a confirm card that said 12.
// One module, so the action checks its text with the composer's own rule.
// Pure: no DOM, no store — unit-tested in pageCount.test.ts.
// ---------------------------------------------------------------------------

/** The range the server honours (it clamps anything else away). */
export const PAGE_COUNT_MIN = 3;
export const PAGE_COUNT_MAX = 16;

export const WORD_NUMS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
};

const COUNT_SOURCE =
  '\\b(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen)[-\\s]*pages?\\b';

/** Every "N page(s)" number the text mentions, in order (out-of-range ones too). */
export function pageCountMentions(text: string): number[] {
  const out: number[] = [];
  const re = new RegExp(COUNT_SOURCE, 'gi');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const n = WORD_NUMS[m[1]!.toLowerCase()] ?? Number(m[1]);
    if (Number.isInteger(n)) out.push(n);
  }
  return out;
}

/** The page count the user explicitly asked for, if any — the LARGEST "N page(s)"
 *  mention in the brief ("two pages of a 16 page bulletin" → 16: the issue size,
 *  not the spread within it). undefined when no usable count is named; the server
 *  only honors 3–16 and ignores anything else, matching its own clamp. */
export function parsePageCount(brief: string): number | undefined {
  let best: number | undefined;
  for (const n of pageCountMentions(brief)) if (best === undefined || n > best) best = n;
  return best !== undefined && best >= PAGE_COUNT_MIN && best <= PAGE_COUNT_MAX ? best : undefined;
}

export interface BriefWithCount {
  /** The text to type into the composer. */
  text: string;
  /** What the composer will build from `text` (parsePageCount of it). */
  pageCount: number | undefined;
  /**
   * Set when `text` cannot be made to say the requested count: the brief already
   * names a LARGER issue size ("a 16-page bulletin" with pageCount 12), which the
   * composer would take instead. The caller refuses rather than build a magazine
   * that disagrees with what the user approved.
   */
  conflict?: number;
}

/**
 * The brief to type so the composer builds exactly `pageCount` pages.
 *
 * Without a pageCount the brief goes in as written. With one, the count is
 * appended in plain words ("— 12 pages in total.") whenever the brief does not
 * already resolve to it. Because the composer takes the LARGEST mention, this
 * fixes every brief whose page phrases are section or spread sizes smaller than
 * the whole issue — the normal case. If a larger number still wins, `conflict`
 * says which.
 */
export function briefWithPageCount(brief: string, pageCount?: number): BriefWithCount {
  let text = brief.trim();
  if (!pageCount) return { text, pageCount: parsePageCount(text) };
  if (parsePageCount(text) !== pageCount) text = `${text.replace(/[.\s]+$/, '')} — ${pageCount} pages in total.`;
  const read = parsePageCount(text);
  if (read === pageCount) return { text, pageCount };
  // The appended count lost to a bigger one already in the brief.
  const larger = pageCountMentions(text).filter((n) => n > pageCount);
  return { text, pageCount: read, conflict: larger.length ? Math.max(...larger) : read };
}
