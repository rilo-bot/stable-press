// ---------------------------------------------------------------------------
// Magazine Builder v2 — a drop-cap paragraph, read back from its three pieces and
// re-set after an edit.
//
// The composer builds a drop cap from three text elements (dropCap.ts): the CAP (one
// letter, three lines deep), the LEAD (the opening lines beside it, starting
// mid-word: "orning comes early…") and the REST (the copy that follows, full width).
// Both text pieces are PINNED to one size (min = max), so neither can shrink.
//
// Edited box by box, that paragraph breaks. "Rewrite the opening" sent the whole new
// paragraph into the lead piece and printed "MMorning…" beside the cap; a longer lead
// could not shrink, so it was cut off (finding C13). The Studio agent therefore treats
// the three pieces as ONE paragraph: it describes them as one, and every edit to any
// piece (new words, a word swap, a size, a move or a resize) is applied to the whole
// paragraph and re-set here with the composer's own calculation — or, when the new
// copy can no longer carry a cap, folded into a plain body box the way Adjust folds
// one (relayoutPage.resplit; the two must stay in step).
//
// Pure: arithmetic over measured metrics. No DOM, no LLM, no I/O.
// ---------------------------------------------------------------------------

import type { MagazineElement } from './model.js';
import { estimateTextHeight, fitFontSize } from './layout.js';
import { DROP_CAP_ID_PREFIX, fitDropCap, planDropCap, type DropCapInput, type DropCapPlan } from './dropCap.js';
import { WRAP_SAFETY } from './measureLeaf.js';
import { MIN_PROSE_PT } from './layoutSpec.js';
import { ptToPx } from './roleScale.js';
import { visibleText } from './textReplace.js';

type Box = { x: number; y: number; w: number; h: number };

/** A drop-cap paragraph as one thing. */
export interface DropCapParagraph {
  /** The pieces' shared id prefix ("dropcap-<n>") — the id the paragraph goes by. */
  key: string;
  cap: MagazineElement;
  lead: MagazineElement;
  rest?: MagazineElement;
  /** The copy as stored (markup and entities as they are), cap + lead + rest joined. */
  raw: string;
  /** The copy as it prints. */
  text: string;
  /** The paragraph's rectangle on the page. */
  box: Box;
  /** The one size both text pieces are set at. */
  pinned: number;
  /** The print floor a re-set (or a fold) may shrink to. */
  floor: number;
  input: Omit<DropCapInput, 'text' | 'fontSize' | 'boxW'>;
}

const PIECE_RE = /-(cap|lead|rest)$/;

/** "dropcap-abc-lead" → "dropcap-abc"; the key itself → itself; anything else → null. */
export function dropCapKey(id: string | undefined | null): string | null {
  if (typeof id !== 'string' || !id.startsWith(DROP_CAP_ID_PREFIX)) return null;
  return id.replace(PIECE_RE, '');
}

const right = (b: Box) => b.x + b.w;
const bottom = (b: Box) => b.y + b.h;
/** Copy as a reader sees it, whitespace collapsed — for comparing two versions. */
const norm = (s: string) => visibleText(s).replace(/\s+/g, ' ').trim();
/** Markup that a split would cut in half. Entities are fine: they are decoded. */
const hasMarkup = (s: string) => /<[a-zA-Z/!]/.test(s);

/**
 * The drop-cap paragraphs among `elements`, plus the keys of any that are BROKEN (a
 * cap without its opening lines or the other way round, or pieces dragged out of
 * order). A lone text piece without a cap is a paragraph an earlier pass folded into
 * a body box: it is ordinary text and is not returned.
 */
export function readDropCapParagraphs(elements: MagazineElement[]): { paras: DropCapParagraph[]; broken: string[] } {
  const groups = new Map<string, { cap?: MagazineElement; lead?: MagazineElement; rest?: MagazineElement; n: number }>();
  for (const el of elements) {
    if (!el.id.startsWith(DROP_CAP_ID_PREFIX)) continue;
    const m = PIECE_RE.exec(el.id);
    if (!m || el.type !== 'text' || !el.text) continue;
    const role = m[1] as 'cap' | 'lead' | 'rest';
    const key = el.id.slice(0, -role.length - 1);
    const g = groups.get(key) ?? { n: 0 };
    g[role] = el;
    g.n++;
    groups.set(key, g);
  }
  const paras: DropCapParagraph[] = [];
  const broken: string[] = [];
  for (const [key, g] of groups) {
    if (!g.cap && g.n === 1) continue; // folded earlier: ordinary text
    if (!g.cap || !g.lead) {
      broken.push(key);
      continue;
    }
    const { cap, lead, rest } = g;
    const t = lead.text!;
    const pinned = typeof t.maxFontSize === 'number' ? t.maxFontSize : t.fontSize;
    const input: DropCapParagraph['input'] = {
      lineHeight: t.lineHeight,
      bodyFamily: t.fontFamily,
      bodyWeight: t.fontWeight,
      capFamily: cap.text!.fontFamily,
      capWeight: cap.text!.fontWeight,
      safety: WRAP_SAFETY,
      ...(t.letterSpacing !== undefined ? { letterSpacing: t.letterSpacing } : {}),
      ...(t.textTransform && t.textTransform !== 'none' ? { textTransform: t.textTransform } : {}),
    };
    const box: Box = rest
      ? { x: Math.min(cap.x, rest.x), y: lead.y, w: right(rest) - Math.min(cap.x, rest.x), h: bottom(rest) - lead.y }
      : { x: cap.x, y: lead.y, w: right(lead) - cap.x, h: Math.max(lead.h, bottom(cap) - lead.y) };
    if (box.w < lead.w || box.h < lead.h || lead.x < cap.x) {
      broken.push(key);
      continue;
    }
    // How the pieces join: the opening lines run on into the rest with a space, unless
    // the first paragraph ENDED beside the cap (then the rest opens a paragraph of its
    // own). The join that reproduces the stored split is the one that was cut.
    const capC = cap.text!.content;
    const leadC = lead.text!.content;
    const restC = rest?.text?.content ?? '';
    let raw = rest ? `${capC}${leadC} ${restC}` : `${capC}${leadC}`;
    if (rest) {
      for (const j of [' ', '\n']) {
        const candidate = `${capC}${leadC}${j}${restC}`;
        const plan = planDropCap({ ...input, text: visibleText(candidate), fontSize: pinned, boxW: box.w });
        if (plan && norm(plan.first) === norm(leadC)) {
          raw = candidate;
          break;
        }
      }
    }
    paras.push({ key, cap, lead, rest, raw, text: visibleText(raw), box, pinned, floor: Math.min(pinned, ptToPx(MIN_PROSE_PT)), input });
  }
  return { paras, broken };
}

/** The drop-cap paragraph an id belongs to (a piece's id or the paragraph's key). */
export function dropCapParagraphOf(elements: MagazineElement[], id: string): DropCapParagraph | null {
  const key = dropCapKey(id);
  if (!key) return null;
  return readDropCapParagraphs(elements).paras.find((p) => p.key === key) ?? null;
}

/** The ids of a paragraph's pieces, cap first. */
export function dropCapPieceIds(p: DropCapParagraph): string[] {
  return [p.cap.id, p.lead.id, ...(p.rest ? [p.rest.id] : [])];
}

/** Plain text for a text node of stored HTML (the split pieces carry no markup). */
function encodeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>');
}

/** One element's patch in a re-set paragraph. */
export interface PiecePatch {
  elementId: string;
  patch: Record<string, unknown>;
}

/** How an edited drop-cap paragraph is written back. */
export interface DropCapRewrite {
  /** 'split': still a drop cap, re-set; 'fold': set as one plain body box. */
  kind: 'split' | 'fold';
  updates: PiecePatch[];
  deletes: string[];
  /** The size the paragraph's copy ends up at. */
  fontSize: number;
  /** The rectangle it occupies afterwards. */
  box: Box;
  /** True when the copy fits that rectangle (a fold at its floor may still not). */
  fits: boolean;
  /** Why it folded, in words (fold only). */
  why?: string;
}

/**
 * Re-set a drop-cap paragraph after an edit: new copy (`raw`, stored HTML), a new
 * rectangle (`box`), and/or a new size (`fontSize`, which becomes the pinned size).
 *
 * The paragraph keeps its drop cap when the copy can still carry one and it fits —
 * in its rectangle, or in that rectangle grown down by `growPx` (the free space below
 * it, measured by the caller) — at the largest size up to the pinned one (fitDropCap,
 * the composer's own calculation). Otherwise it FOLDS: the lead piece becomes the
 * whole paragraph, set plainly and shrink-to-fit in the rectangle (grown into the free
 * space when it needs it), and the cap and the rest are deleted — what Adjust does.
 */
export function planDropCapRewrite(
  p: DropCapParagraph,
  change: { raw?: string; box?: Box; fontSize?: number; growPx?: number },
): DropCapRewrite {
  const raw = change.raw ?? p.raw;
  const B: Box = change.box ?? p.box;
  const pinned = change.fontSize && change.fontSize > 0 ? change.fontSize : p.pinned;
  const floor = Math.min(pinned, p.floor);
  const grow = Math.max(0, change.growPx ?? 0);
  const text = visibleText(raw);
  const eligible = !hasMarkup(raw);
  const planIn = (h: number): DropCapPlan | null =>
    eligible ? fitDropCap({ ...p.input, text, fontSize: pinned, boxW: B.w, boxH: h, maxFontSize: pinned, minFontSize: floor }) : null;

  // A plan that needs a rest piece the paragraph does not have cannot be built by
  // editing what is there, so it folds instead (as Adjust does).
  const usable = (plan: DropCapPlan | null) => !!plan && (!plan.rest || !!p.rest);
  let plan = planIn(B.h);
  let boxH = B.h;
  if (!usable(plan) && grow > 0) {
    const grown = planIn(B.h + grow);
    if (usable(grown)) {
      plan = grown;
      boxH = Math.min(B.h + grow, Math.ceil(grown!.totalH) + 2);
    }
  }
  if (plan && usable(plan)) {
    const updates: PiecePatch[] = [
      {
        elementId: p.cap.id,
        patch: {
          x: B.x + plan.capBox.x,
          y: Math.max(0, B.y + plan.capBox.y),
          w: plan.capBox.w,
          h: plan.capBox.h,
          text: { content: encodeText(plan.cap), fontSize: plan.capFontSize, maxFontSize: plan.capFontSize, minFontSize: plan.capFontSize, lineHeight: plan.capLineHeight },
        },
      },
      {
        elementId: p.lead.id,
        patch: {
          x: B.x + plan.firstBox.x,
          y: B.y,
          w: plan.firstBox.w,
          h: plan.firstBox.h,
          text: { content: encodeText(plan.first), fontSize: plan.fontSize, maxFontSize: plan.fontSize, minFontSize: plan.fontSize },
        },
      },
    ];
    const deletes: string[] = [];
    if (p.rest) {
      if (plan.rest) {
        updates.push({
          elementId: p.rest.id,
          patch: {
            x: B.x,
            y: B.y + plan.restY,
            w: B.w,
            h: Math.max(1, boxH - plan.restY),
            text: { content: encodeText(plan.rest), fontSize: plan.fontSize, maxFontSize: plan.fontSize, minFontSize: plan.fontSize },
          },
        });
      } else {
        deletes.push(p.rest.id);
      }
    }
    return { kind: 'split', updates, deletes, fontSize: plan.fontSize, box: { ...B, h: boxH }, fits: true };
  }

  // FOLD: the lead piece becomes the whole paragraph, set plainly in the rectangle.
  const t = p.lead.text!;
  const style = {
    lineHeight: t.lineHeight,
    fontFamily: t.fontFamily,
    fontWeight: t.fontWeight,
    ...(t.letterSpacing !== undefined ? { letterSpacing: t.letterSpacing } : {}),
    ...(t.textTransform ? { textTransform: t.textTransform } : {}),
  };
  const sizeIn = (h: number) => fitFontSize({ text: raw, boxW: B.w, boxH: h, maxFontSize: pinned, minFontSize: floor, ...style });
  const needAt = (size: number) => estimateTextHeight({ text: raw, fontSize: size, boxWidthPx: B.w * WRAP_SAFETY, ...style });
  let fontSize = sizeIn(B.h);
  let need = needAt(fontSize);
  let h = B.h;
  if (need > B.h && grow > 0) {
    fontSize = sizeIn(B.h + grow);
    need = needAt(fontSize);
    h = B.h + grow;
  }
  // The box hugs the copy it now holds (top-aligned, as the paragraph was).
  const hugged = Math.max(1, Math.min(h, Math.ceil(need)));
  const why = !eligible
    ? 'the new copy has formatting a drop cap cannot carry'
    : planDropCap({ ...p.input, text, fontSize: pinned, boxW: B.w })
      ? 'it no longer fits beside one'
      : 'its copy is too short to carry one';
  return {
    kind: 'fold',
    updates: [
      {
        elementId: p.lead.id,
        patch: { x: B.x, y: B.y, w: B.w, h: hugged, text: { content: raw, fontSize, maxFontSize: pinned, minFontSize: floor } },
      },
    ],
    deletes: [p.cap.id, ...(p.rest ? [p.rest.id] : [])],
    fontSize,
    box: { ...B, h: hugged },
    fits: need <= hugged + 0.5,
    why,
  };
}
