// ---------------------------------------------------------------------------
// Magazine Builder v2 — where a manually added element goes, and how it looks.
//
// Three small rules shared by the studio's Add buttons (MagazineEditorV2) and the
// Inspector's media panel, so a hand-made addition behaves like the AI's:
//
//   ON TOP        a new element takes the page's highest zIndex + 1. At z 0 it
//                 was drawn UNDER a generated page's photos, scrims and panels.
//   PAGE TYPE     new text copies the page's own body typography (family, size,
//                 weight, colour, leading) instead of a fixed 44px Georgia that
//                 matched no page in any magazine.
//   WHOLE         a designed picture (chart, logo, poster, illustration — media
//                 kind 'graphic') is placed with fit 'contain' in a box of its own
//                 shape when the size is known: 'cover' cropped its axis labels,
//                 legend or the ends of a logo.
//
// Pure (no store, no DOM) — tested in addDefaults.test.ts.
// ---------------------------------------------------------------------------

import type { MagazineElement } from './model';

/** The highest zIndex on the page (0 for an empty page). */
export function topZ(elements: ReadonlyArray<Pick<MagazineElement, 'zIndex'>>): number {
  let z = 0;
  for (const el of elements) if (Number.isFinite(el.zIndex) && el.zIndex > z) z = el.zIndex;
  return z;
}

/** zIndex for a new element: on top, inside the 0–9999 range the server keeps. */
export function zForNew(elements: ReadonlyArray<Pick<MagazineElement, 'zIndex'>>): number {
  return Math.min(9999, topZ(elements) + 1);
}

export interface PageTextStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: NonNullable<MagazineElement['text']>['fontWeight'];
  color: string;
  lineHeight: number;
  letterSpacing?: number;
  textTransform?: NonNullable<MagazineElement['text']>['textTransform'];
}

const plainLength = (html: string) => html.replace(/<[^>]*>/g, '').trim().length;

/**
 * The page's own typography for `role`: taken from the text element of that role
 * carrying the MOST copy (the page's main paragraph, not a one-word label that
 * happens to share the role). null when the page has no such text, or its family
 * is 'inherit' (the app's font — no better than the caller's default).
 */
export function pageTextStyle(elements: readonly MagazineElement[], role = 'body'): PageTextStyle | null {
  let best: MagazineElement | null = null;
  let bestLen = -1;
  for (const el of elements) {
    if (el.type !== 'text' || !el.text || el.text.role !== role) continue;
    const len = plainLength(el.text.content || '');
    if (len > bestLen) {
      best = el;
      bestLen = len;
    }
  }
  const t = best?.text;
  if (!t || !t.fontFamily || t.fontFamily === 'inherit' || !(t.fontSize > 0)) return null;
  return {
    fontFamily: t.fontFamily,
    fontSize: Math.round(t.fontSize),
    fontWeight: t.fontWeight,
    color: t.color,
    lineHeight: t.lineHeight ?? 1.3,
    ...(t.letterSpacing ? { letterSpacing: t.letterSpacing } : {}),
    ...(t.textTransform ? { textTransform: t.textTransform } : {}),
  };
}

/** Is this media row a designed picture that must show whole ('contain')? */
export function isGraphicAsset(asset: { kind?: string; source?: string }): boolean {
  return asset.kind === 'graphic' || asset.source === 'chart';
}

/**
 * The box for a picture added with nothing selected: half the page wide, centred,
 * a third of the way down — in the picture's OWN shape when its pixel size is
 * known (capped at 60% of the page height, narrowing to keep the shape), else the
 * 3:2 box the panel has always used. Always inside the page.
 */
export function imageBoxFor(
  asset: { width?: number; height?: number },
  page: { width: number; height: number },
): { x: number; y: number; w: number; h: number } {
  let w = Math.round(page.width * 0.5);
  let h = Math.round(w * 0.66);
  const aw = Number(asset.width);
  const ah = Number(asset.height);
  if (aw > 0 && ah > 0) {
    h = Math.round((w * ah) / aw);
    const maxH = Math.round(page.height * 0.6);
    if (h > maxH) {
      h = maxH;
      w = Math.round((h * aw) / ah);
    }
  }
  const x = Math.round(page.width / 2 - w / 2);
  const y = Math.max(0, Math.min(Math.round(page.height / 3), page.height - h));
  return { x, y, w, h };
}
