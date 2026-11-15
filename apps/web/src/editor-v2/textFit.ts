// ---------------------------------------------------------------------------
// Magazine Builder v2 — the two ways to make cut-off text fit its box.
//
// Generated and hand-made copy is drawn clipped to its box (overflow hidden), so
// a bigger font size or a longer rewrite can hide its last lines without any sign
// on the page. The Inspector measures the selected box on the canvas and, when it
// is cut off, offers the same two fixes the agents use:
//
//   GROW DOWNWARD   into the free space below the box (up to the next element in
//                   the same column, or the page edge) — the size stays as asked.
//   SHRINK          to a size it fits at — the new size becomes the ceiling, so a
//                   later edit does not snap it back up.
//
// Pure geometry, no DOM — tested in textFit.test.ts.
// ---------------------------------------------------------------------------

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Same page-coverage rule as the canvas hit-test: a near-full-page element is a
 *  background, not a neighbour. */
const isBackdrop = (b: Box, page: { width: number; height: number }) => b.w * b.h >= 0.85 * page.width * page.height;

const contains = (outer: Box, inner: Box) =>
  outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.w >= inner.x + inner.w && outer.y + outer.h >= inner.y + inner.h;

/**
 * Free height below `el` (page px): down to the top of the nearest element that
 * sits below it and shares part of its column, else to the page's bottom edge.
 * Backgrounds and panels the box sits ON (they contain it) are not obstacles.
 */
export function roomBelow(el: Box & { id?: string }, others: ReadonlyArray<Box & { id?: string }>, page: { width: number; height: number }): number {
  const bottom = el.y + el.h;
  let limit = page.height;
  for (const o of others) {
    if (o.id !== undefined && o.id === el.id) continue;
    if (isBackdrop(o, page) || contains(o, el)) continue;
    const overlapX = Math.min(el.x + el.w, o.x + o.w) - Math.max(el.x, o.x);
    if (overlapX <= 0) continue;
    if (o.y >= bottom - 1 && o.y < limit) limit = o.y;
  }
  return Math.max(0, Math.floor(limit - bottom));
}

/**
 * The height to grow to for `needPx` of text: all of it when the room allows,
 * else as far as the room goes. `short` is how many px would still be hidden.
 */
export function growToFit(havePx: number, needPx: number, room: number): { h: number; short: number } {
  const want = Math.ceil(needPx) + 2;
  const h = Math.min(want, Math.floor(havePx + Math.max(0, room)));
  return { h: Math.max(havePx, h), short: Math.max(0, want - Math.max(havePx, h)) };
}

/**
 * A font size the text should fit at. Wrapped text grows with roughly the SQUARE
 * of its size (more lines, each taller), so the size scales by the square root of
 * the height ratio, with a little room to spare. Always at least 1px smaller, and
 * never below the 6px the Inspector's stepper allows.
 */
export function shrinkSizeFor(fontSize: number, needPx: number, havePx: number): number {
  if (!(needPx > havePx) || !(fontSize > 0)) return fontSize;
  const s = Math.floor(fontSize * Math.sqrt(havePx / needPx) * 0.98);
  return Math.max(6, Math.min(s, Math.round(fontSize) - 1));
}
