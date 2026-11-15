// ---------------------------------------------------------------------------
// Text copied from a PDF: draw it as the PDF set it, or let it wrap?
//
// Extracted text (Magazine Builder "Copy onto this page" / import) carries the
// PDF's own lines in a box measured tight to them, and IssuePageCanvas draws it
// with `white-space: pre` so a web font standing in for the PDF's never re-breaks a
// masthead. That is right only while the lines ARE the PDF's: a paragraph rewritten
// as one long line, drawn "as measured", ran straight off the page edge (client
// report 2026-11-15). The server now turns edited extracted text into flowing text
// (lib/magazineV2/extractedText.ts); this is the renderer's safety net for text
// saved before that, and the SAME rule as the server's keepsPdfLines — keep in step.
// ---------------------------------------------------------------------------

/** Average glyph advance as a fraction of the type size — on the wide side for
 *  prose, so a real PDF line is never estimated much wider than it is. */
const AVG_GLYPH_EM = 0.5;
/** How far past its box a line may be ESTIMATED before it is judged not to be the
 *  PDF's own line. A rewritten paragraph on one line is several times its box. */
const SPILL_ALLOWANCE = 1.5;
/** The extractor sizes a box to exactly its lines (height = lines × size × line
 *  height). Lines filling less than this share of their box are not the lines it was
 *  measured for: a paragraph rewritten onto one line still sits in the box of its four. */
const LINES_FILL = 0.75;

interface TextLike {
  source?: string;
  w: number;
  h: number;
  text?: { content: string; fontSize: number; lineHeight?: number; letterSpacing?: number } | null;
}

/** The text a reader sees, one entry per line. */
function visibleLines(content: string): string[] {
  return (content ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:#\d+|#x[0-9a-f]+|[a-z]+);/gi, 'x')
    .split('\n');
}

/**
 * True only for extracted text that still looks like the lines its box was measured
 * for — enough lines to fill its height, none far wider than it — so draw it exactly
 * as the PDF set it. False means wrap it like any other copy; that never hides a
 * word, it only lets lines break where they no longer fit.
 */
export function keepsPdfLines(el: TextLike): boolean {
  if (el.source !== 'extracted' || !el.text) return false;
  const size = Number(el.text.fontSize) || 16;
  const lines = visibleLines(el.text.content);
  const linesHeight = lines.length * size * (Number(el.text.lineHeight) || 1.2);
  if (linesHeight < (Number(el.h) || 0) * LINES_FILL) return false;
  const perChar = size * AVG_GLYPH_EM + (Number(el.text.letterSpacing) || 0);
  const longest = Math.max(0, ...lines.map((l) => l.length));
  return longest * perChar <= Math.max(1, Number(el.w) || 0) * SPILL_ALLOWANCE;
}
