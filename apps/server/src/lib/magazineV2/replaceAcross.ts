// ---------------------------------------------------------------------------
// Magazine Builder v2 — replace a word or a name across a page, deterministically.
//
// "Change NZTROF to NOG everywhere" used to go through the Studio one page at a time,
// and the model retyped whole boxes it had seen only a preview of — the client's real
// copy came back rewritten (the 2026-11-15 incident). This is the deterministic
// door: textReplace.replaceInHtml changes only the matched words of each text box and
// leaves every other byte of its stored HTML as it was, and each changed box is then
// written through the same normalizeElementPatch every other edit goes through — so a
// box that grew is refit from its ceiling, and text copied from a PDF becomes ordinary
// flowing text once its words change, exactly as a typed edit would make it.
//
// The SEARCH is the Studio's own (agentPure.replaceOnPage), so the two cannot drift:
//   - a DROP-CAP paragraph is stored as three pieces (cap "N", lead "ZTROF has…", rest)
//     and is searched as the ONE paragraph it reads as — a name that opens a paragraph,
//     which is exactly where a magazine prints it, used to be missed (the cap and the
//     lead each held half of it). A hit is re-set with dropCapPara.planDropCapRewrite,
//     the composer's own calculation, rather than written into a pinned piece that
//     cannot shrink and would cut a longer name off (finding C13);
//   - a box the replacement would push past MAX_TEXT_HTML is left as it is and counted
//     in `skippedTooLong`: validation cuts stored HTML at that length, so writing it
//     would silently delete the end of the client's paragraph.
//
// A LOCKED box is never edited. Its matches are counted separately so the person (or
// The Stable Hand) is told "2 left in locked boxes" instead of finding them later.
//
// Pure: the route reads the pages, runs this, and writes the result with a rev
// compare-and-set per page.
// ---------------------------------------------------------------------------

import type { MagazineElement } from './model.js';
import { normalizeElementPatch } from './writePipeline.js';
import { replaceOnPage } from './agentPure.js';
import { dropCapPieceIds, planDropCapRewrite, type DropCapParagraph } from './dropCapPara.js';
import { freeSpaceBelow } from './pageCheck.js';

export interface ReplaceOptions {
  matchCase?: boolean;
  wholeWord?: boolean;
}

export interface PageReplacePlan {
  /** The page's whole element list after the replacement, or null when nothing changed. */
  elements: MagazineElement[] | null;
  /** Matches replaced on this page (unlocked boxes only). */
  count: number;
  /** Matches found in locked boxes and left as they are. */
  skippedLocked: number;
  /** Matches left as they are because the box would pass the stored-text limit. */
  skippedTooLong: number;
  /** Ids of the boxes whose text changed, in page order. */
  changedIds: string[];
}

/** The free space below a drop-cap paragraph's rectangle (the Studio's freeBelowPara). */
function freeBelowParagraph(p: DropCapParagraph, elements: ReadonlyArray<MagazineElement>, page: { width: number; height: number }): number {
  const pieces = new Set(dropCapPieceIds(p));
  const others = elements.filter((e) => !pieces.has(e.id));
  return freeSpaceBelow({ ...p.lead, id: p.key, ...p.box }, others, page);
}

/**
 * Plan a find-and-replace over one page's text boxes.
 *
 * Every text element is searched, the page's running head and folio included (a
 * magazine's name printed in its running head is part of "everywhere"). A box (or a
 * drop-cap paragraph) whose edit the write pipeline refuses is left untouched and its
 * matches are not counted, so the count is always what really changed.
 */
export function planPageReplace(
  elements: ReadonlyArray<MagazineElement>,
  page: { width: number; height: number },
  find: string,
  replace: string,
  opts: ReplaceOptions = {},
): PageReplacePlan {
  const ro = { matchCase: opts.matchCase !== false, wholeWord: opts.wholeWord === true };
  const found = replaceOnPage(elements, find, replace, ro);
  const skippedLocked = found.locked.reduce((n, l) => n + l.count, 0);
  const skippedTooLong = found.tooLong.reduce((n, l) => n + l.count, 0);

  // Changes by element id: a replacement element, or null for a piece a fold deletes.
  const changes = new Map<string, MagazineElement | null>();
  const byId = new Map(elements.map((e) => [e.id, e]));
  let count = 0;
  for (const hit of found.hits) {
    if (hit.para) {
      const p = hit.para;
      if (hit.html === p.raw) continue;
      const rewrite = planDropCapRewrite(p, { raw: hit.html, growPx: freeBelowParagraph(p, elements, page) });
      // All of the paragraph or none of it: a half re-set paragraph prints twice.
      const staged = new Map<string, MagazineElement | null>();
      let refused = false;
      for (const u of rewrite.updates) {
        const el = byId.get(u.elementId);
        const updated = el ? normalizeElementPatch(el, u.patch, page) : null;
        if (!updated) {
          refused = true;
          break;
        }
        staged.set(u.elementId, { ...updated, id: u.elementId });
      }
      if (refused) continue;
      for (const id of rewrite.deletes) staged.set(id, null);
      for (const [id, el] of staged) changes.set(id, el);
      count += hit.count;
      continue;
    }
    const el = byId.get(hit.id);
    if (!el || el.type !== 'text' || !el.text || hit.html === el.text.content) continue;
    const updated = normalizeElementPatch(el, { text: { content: hit.html } }, page);
    if (!updated) continue;
    changes.set(el.id, updated);
    count += hit.count;
  }

  if (!changes.size) return { elements: null, count: 0, skippedLocked, skippedTooLong, changedIds: [] };
  const next: MagazineElement[] = [];
  const changedIds: string[] = [];
  for (const el of elements) {
    if (!changes.has(el.id)) {
      next.push(el);
      continue;
    }
    const updated = changes.get(el.id);
    if (!updated) continue; // a drop-cap piece the re-set folded away
    next.push(updated);
    changedIds.push(el.id);
  }
  return { elements: next, count, skippedLocked, skippedTooLong, changedIds };
}

/** One page's line in a replace report. */
export interface ReplacePageReport {
  pageId: string;
  pageNumber: number;
  count: number;
  skippedLocked?: number;
  /** Matches left alone because the box would pass the stored-text limit. */
  skippedTooLong?: number;
}

/** The pages worth reporting (something replaced, or something left in a locked or
 *  over-full box), in page order, and the total replaced. */
export function replaceReport(rows: ReadonlyArray<ReplacePageReport>): { pages: ReplacePageReport[]; total: number } {
  const pages = rows
    .filter((r) => r.count > 0 || (r.skippedLocked ?? 0) > 0 || (r.skippedTooLong ?? 0) > 0)
    .map((r) => ({
      pageId: r.pageId,
      pageNumber: r.pageNumber,
      count: r.count,
      ...(r.skippedLocked ? { skippedLocked: r.skippedLocked } : {}),
      ...(r.skippedTooLong ? { skippedTooLong: r.skippedTooLong } : {}),
    }))
    .sort((a, b) => a.pageNumber - b.pageNumber);
  return { pages, total: pages.reduce((n, r) => n + r.count, 0) };
}
