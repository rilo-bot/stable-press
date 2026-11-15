// ---------------------------------------------------------------------------
// Magazine Builder v2 — text copied from a PDF, and the moment it stops being a copy.
//
// "Copy onto this page" and import reproduce a PDF page as editable elements. Each
// text block carries the PDF's own LINES (joined with "\n") in a box measured tight
// to them, and is marked `source: 'extracted'`. The renderers draw extracted text
// with `white-space: pre` — never re-wrapped — so a masthead does not break in two
// when a web font stands in for the PDF's own.
//
// That is right only while the lines ARE the PDF's. Rewrite a paragraph and the new
// words arrive as one long line; drawn "as measured" it runs straight off the edge
// of the page, and no font size or box change can bring it back, because nothing
// wraps it. That is what a client hit on 2026-11-15: every paragraph of a copied
// page on a single line, cut at the page edge, with the assistant changing fonts
// and boxes to no effect.
//
// Two rules, one per side of the write:
//   editsPdfSetting / asFlowingText  an edit that changes the words, the type or the
//                                    box width turns the element into ordinary
//                                    flowing text (wraps in its box, shrinks to fit
//                                    from its measured size). writePipeline.ts.
//   keepsPdfLines                    the renderers' safety net for text saved before
//                                    that rule: lines far longer than their box are
//                                    plainly not the PDF's, so they wrap.
//                                    previewHtml.ts here, IssuePageCanvas.tsx (via
//                                    web/src/lib/pdfLines.ts, the same rule) on the web.
// ---------------------------------------------------------------------------

import type { MagazineElement } from './model.js';

/** Average glyph advance as a fraction of the type size. Deliberately on the wide
 *  side for prose (most text faces average 0.42–0.5em including spaces), so a line
 *  that really is the PDF's is never estimated much wider than it is. */
const AVG_GLYPH_EM = 0.5;

/** How far past its box a line may be ESTIMATED before it is judged not to be the
 *  PDF's own line. The estimate is rough (±~20% across faces); a rewritten paragraph
 *  on one line is several times its box. 1.5 keeps the two well apart. */
const SPILL_ALLOWANCE = 1.5;

/** The extractor sizes a box to exactly its lines (height = lines × size × line
 *  height — pdf.ts derives lineHeight from that very ratio). Lines filling less than
 *  this share of their box are not the lines it was measured for: a paragraph
 *  rewritten onto one line still sits in the box of its four. */
const LINES_FILL = 0.75;

/** The text a reader sees, one entry per line: tags dropped, <br> as a break,
 *  each entity counted as one character. */
function visibleLines(content: string): string[] {
  return (content ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:#\d+|#x[0-9a-f]+|[a-z]+);/gi, 'x')
    .split('\n');
}

/**
 * Whether an element's text should be drawn exactly as the PDF set it (no wrapping).
 *
 * True only for extracted text that still looks like the lines its box was measured
 * for: enough lines to fill the box's height, none of them far wider than the box.
 * A false here never hides anything: the text simply wraps where it no longer fits
 * (and a real PDF line that does fit renders identically either way).
 */
export function keepsPdfLines(el: Pick<MagazineElement, 'source' | 'w' | 'h' | 'text'>): boolean {
  if (el.source !== 'extracted' || !el.text) return false;
  const t = el.text;
  const size = Number(t.fontSize) || 16;
  const lines = visibleLines(t.content);
  const linesHeight = lines.length * size * (Number(t.lineHeight) || 1.2);
  if (linesHeight < (Number(el.h) || 0) * LINES_FILL) return false;
  const perChar = size * AVG_GLYPH_EM + (Number(t.letterSpacing) || 0);
  const longest = Math.max(0, ...lines.map((l) => l.length));
  return longest * perChar <= Math.max(1, Number(el.w) || 0) * SPILL_ALLOWANCE;
}

/** Text fields whose change means the PDF's measured lines no longer apply. */
const SETTING_FIELDS = ['content', 'fontSize', 'fontFamily', 'fontWeight', 'letterSpacing', 'textTransform'] as const;

/**
 * Whether this patch changes what the PDF's line breaks were measured for: the
 * words, the type, or the width of the box. Moving the box, recolouring it or
 * changing its height leaves the lines exactly as they were.
 */
export function editsPdfSetting(stored: MagazineElement, partial: Record<string, unknown>): boolean {
  if (stored.source !== 'extracted' || stored.type !== 'text' || !stored.text) return false;
  const pText = partial.text && typeof partial.text === 'object' ? (partial.text as Record<string, unknown>) : undefined;
  if (pText) {
    const before = stored.text as unknown as Record<string, unknown>;
    for (const k of SETTING_FIELDS) {
      if (k in pText && pText[k] !== undefined && pText[k] !== before[k]) return true;
    }
  }
  return typeof partial.w === 'number' && partial.w !== stored.w;
}

/**
 * Turn an edited extracted text element (already merged with its patch) into
 * ordinary flowing text: it wraps in its box like any other copy, and the size it
 * now has becomes the ceiling it shrinks from — so a longer rewrite fits its box
 * instead of spilling over the paragraph below or being cut off.
 */
export function asFlowingText(merged: Record<string, unknown>): Record<string, unknown> {
  const text = (merged.text && typeof merged.text === 'object' ? merged.text : {}) as Record<string, unknown>;
  const size = typeof text.fontSize === 'number' ? text.fontSize : undefined;
  return {
    ...merged,
    source: 'manual',
    text: {
      ...text,
      autoFit: 'shrink',
      ...(typeof text.maxFontSize !== 'number' && size !== undefined ? { maxFontSize: size } : {}),
    },
  };
}
