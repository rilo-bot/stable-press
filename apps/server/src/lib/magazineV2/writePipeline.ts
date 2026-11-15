// ---------------------------------------------------------------------------
// Magazine Builder v2 — the single element write pipeline.
//
// EVERY element write (manual, AI-agent, extraction, generation) goes through
// these two functions, so the guardrails can't be bypassed by any caller:
//     validate → sanitise → refit.
// This is the discipline that earns "no layout bugs": geometry is clamped to the
// page, unknown/invalid elements are dropped (never throw), rich text is
// sanitised, and shrink-to-fit text is re-fit to its box.
// ---------------------------------------------------------------------------

import {
  validateElements,
  validateElementPatch,
  type MagazineElement,
} from './model.js';
import { sanitizeElements } from './sanitize.js';
import { refitText } from './layout.js';
import { asFlowingText, editsPdfSetting } from './extractedText.js';

type PageDims = { width: number; height: number };

/** Full-list write path (extraction, generation, bulk import, page create). */
export function normalizeElements(raw: unknown, page: PageDims): MagazineElement[] {
  return refitText(sanitizeElements(validateElements(raw, page)));
}

/**
 * Deep-merge a client's PARTIAL element onto the stored one (text/image/shape/qr
 * merged one level), so a patch that only sends `{text:{fontSize:20}}` doesn't
 * wipe geometry or the rest of the text data. Must run BEFORE validation.
 */
export function mergeElement(
  stored: MagazineElement,
  partial: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...stored, ...partial };
  for (const sub of ['text', 'image', 'shape', 'qr', 'icon'] as const) {
    const p = partial[sub];
    if (p && typeof p === 'object') {
      merged[sub] = { ...(stored[sub] as object | undefined), ...(p as object) };
    }
  }
  return merged;
}

/**
 * A patch that sets a NEW font size without saying what the ceiling is makes that size
 * the ceiling (`maxFontSize`), in either direction.
 *
 * Refit always shrinks from the ceiling. Left at its old value, the next write that
 * refits — a one-word fix, a resize, an arrow-key nudge of the box's width — re-fitted
 * from the old ceiling and quietly undid the size that was asked for: "make the body
 * bigger" (18 → 26) went back to 18 on the very next edit, and "smaller" grew back the
 * same way. The Inspector's stepper already sends both values; this gives every other
 * writer (the Studio's set_element_style, The Stable Hand, an API client) the same rule.
 *
 * Only a real change counts (askedFontSize): the web re-sends the whole text object,
 * fitted fontSize included, on every save, and treating that echo as "a size was asked
 * for" would ratchet the ceiling down to whatever the copy had been shrunk to. A patch
 * that names its own maxFontSize (Inspector, Adjust's drop-cap writes) keeps it. The
 * floor needs nothing here: validation clamps minFontSize to at most the new ceiling.
 */
function withAskedSizeAsCeiling(
  stored: MagazineElement,
  partial: Record<string, unknown>,
  merged: Record<string, unknown>,
): Record<string, unknown> {
  const pText = textOf(partial);
  const asked = askedFontSize(stored, pText);
  if (asked === undefined) return merged;
  if (typeof pText?.maxFontSize === 'number' && Number.isFinite(pText.maxFontSize)) return merged;
  const text = (merged.text && typeof merged.text === 'object' ? merged.text : {}) as Record<string, unknown>;
  return { ...merged, text: { ...text, maxFontSize: asked } };
}

function textOf(partial: Record<string, unknown>): Record<string, unknown> | undefined {
  return partial.text && typeof partial.text === 'object' ? (partial.text as Record<string, unknown>) : undefined;
}

/**
 * The font size this patch ASKS for, or undefined when it asks for none.
 *
 * Every web writer sends the whole text object back — the canvas's inline editor, the
 * Inspector's text box, Fill's new copy (`{ ...before.text, content }`) — so a patch
 * carrying the size the element already has is an echo, not a request. Read as a
 * request, it switched the refit off for every one of those content edits: copy typed
 * into a box, or written into an empty one by Fill, was saved at its old size however
 * long it had become, and cut off at the bottom of its box.
 */
function askedFontSize(stored: MagazineElement, pText: Record<string, unknown> | undefined): number | undefined {
  if (!pText || typeof pText.fontSize !== 'number' || !Number.isFinite(pText.fontSize)) return undefined;
  const before = stored.text?.fontSize;
  if (typeof before === 'number' && Math.abs(before - pText.fontSize) < 0.01) return undefined;
  return pText.fontSize;
}

/** Text fields whose change alters how much room the copy takes (a style-only change
 *  such as colour or alignment does not). */
const FIT_FIELDS = ['content', 'fontFamily', 'fontWeight', 'letterSpacing', 'textTransform', 'lineHeight'] as const;

/** Whether the patch really changes the copy or its type (not merely re-sends them). */
function changesTextFit(stored: MagazineElement, pText: Record<string, unknown> | undefined): boolean {
  if (!pText) return false;
  const before = (stored.text ?? {}) as unknown as Record<string, unknown>;
  return FIT_FIELDS.some((k) => k in pText && pText[k] !== undefined && pText[k] !== before[k]);
}

/**
 * Single-element patch write path. Merges the partial onto the stored element,
 * then validates → sanitises → (conditionally) refits, returning the canonical
 * element to store.
 *
 * Shrink-to-fit text is refit from its ceiling whenever the patch could change the
 * fit: new words, a new face / weight / tracking / case / leading, or a resized box.
 * A style-only patch (e.g. colour) never rewrites the size, and neither does a patch
 * that asks for a size of its own (askedFontSize): an asked-for size is stored as
 * asked and becomes the ceiling later refits start from (withAskedSizeAsCeiling) — it
 * is NOT shrunk to its box here, because the writer asked for exactly that size.
 * Whoever asked (the Studio, The Stable Hand) measures the result with
 * layout.measureElementText and grows the box or says what no longer fits.
 *
 * Text copied from a PDF stops being a copy once its words, type or width change:
 * it becomes ordinary flowing text that wraps and shrinks to fit its box, and is
 * refit unless the patch set an explicit size (see ./extractedText.ts).
 */
export function normalizeElementPatch(
  stored: MagazineElement,
  partial: Record<string, unknown>,
  page: PageDims,
): MagazineElement | null {
  const editsCopy = editsPdfSetting(stored, partial);
  const base = mergeElement(stored, partial);
  const merged = withAskedSizeAsCeiling(stored, partial, editsCopy ? asFlowingText(base) : base);
  const validated = validateElementPatch(merged, page);
  if (!validated.type) return null; // unusable
  const [sanitized] = sanitizeElements([validated as MagazineElement]);
  if (!sanitized) return null;

  const pText = textOf(partial);
  const asksForSize = askedFontSize(stored, pText) !== undefined;
  const changedGeometry = 'w' in partial || 'h' in partial;
  const shouldRefit = !asksForSize && (changesTextFit(stored, pText) || changedGeometry || editsCopy);

  return shouldRefit ? (refitText([sanitized])[0] ?? sanitized) : sanitized;
}
