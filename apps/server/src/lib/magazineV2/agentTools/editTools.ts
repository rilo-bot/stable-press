// ---------------------------------------------------------------------------
// Magazine Builder v2 — Studio-agent tools that EDIT what is already on a page, and
// the tools that let the agent SEE the page it is editing.
//
// Read a page or one element, rewrite or restyle a text element (every Text option the
// manual panel has: font, size, weight, alignment incl. justify, vertical alignment,
// colour, line height, letter spacing, case), replace a word, move, resize, rotate or
// restack an element (To front / To back), point a QR code somewhere, delete an
// element, restack a column; and check the page (measured) or look at it (rendered,
// reviewed). The panel's other controls are in panelTools.ts. Each edit
// stages a proposal through the shared helpers (shared.ts) and never writes the
// database — see agent.ts for why the agent only ever stages.
//
// The guardrails live in the tools rather than in the prompt, so a model that forgets
// a rule still cannot break the page (the pure halves are in ../agentPure.ts):
//   - every edit returns `fit` for what it changed: does the text fit its box;
//   - a word swap is a find-and-replace inside the stored HTML (replace_text), never a
//     retype of copy the model has not read;
//   - an asked-for font size becomes the element's ceiling, and text that no longer
//     fits grows its box DOWN into free space (or the result says it does not fit);
//   - moves and resizes stay on the page;
//   - a drop-cap paragraph is edited as the one paragraph it is.
// ---------------------------------------------------------------------------

import { tool } from 'ai';
import { z } from 'zod';
import { db } from '../../db.js';
import { COL } from '../collections.js';
import { safeUrl } from '../url.js';
import { MAX_TEXT_HTML, parseColor, type MagazineElement } from '../model.js';
import { checkPage, checkPageFromMeasurements, freeSpaceBelow, type PageCheck } from '../pageCheck.js';
import { measurePagePreview } from '../renderPreview.js';
import { lookAtPage } from '../pageLook.js';
import { visibleText } from '../textReplace.js';
import { dropCapParagraphOf, dropCapPieceIds, planDropCapRewrite, type DropCapParagraph, type DropCapRewrite } from '../dropCapPara.js';
import {
  checkFlags,
  clampToPage,
  describePage,
  growthNote,
  modelText,
  OTHER_PAGE_BUDGET,
  OTHER_PAGE_ELEMENT_MAX,
  previewPageOf,
  replaceOnPage,
  tidyColumnPlan,
  withGrowth,
} from '../agentPure.js';
import { naturalSizeFor, normalizeVAlign, pageFontStacks, resolveFontFamily, sizeLabel, weightNote, withNaturalSizes, zForLayer } from '../agentPanelPure.js';
import { elLabel, find, fitOf, hasLayout, lastProposal, LAYOUT_CLASH, pageDims, stageDelete, stageUpdate, textPreview, warnProposals, type AgentCtx, type PromptSection } from './shared.js';

/** Vision looks one turn may spend (each is a render plus a Sonnet call). */
const MAX_LOOKS = 2;
/** Below this much turn time left, look_at_page returns the measured check without a
 *  picture: a look takes up to ~35s and the model still has to answer after it. */
const LOOK_MIN_LEFT_MS = 30_000;
/** The look's own time box, and what it leaves the model for the rest of the turn. */
const LOOK_MAX_MS = 35_000;
const LOOK_RESERVE_MS = 15_000;
/** A Chromium measurement is tried only with at least this much turn time left, and
 *  is boxed so it can never eat the model's last steps; otherwise the estimate. */
const MEASURE_MIN_LEFT_MS = 20_000;
const MEASURE_MS = 6_000;
const MEASURE_QUEUE_MS = 3_000;
/** A set_element_text that drops more than this share of a long box's words gets a
 *  warning in its result (C47): right for "shorten it", wrong for a word swap. */
const DROP_WARN_SHARE = 0.5;
const DROP_WARN_MIN_CHARS = 300;

/** This module's lines in the SYSTEM prompt (see PromptSection for the slots). */
export const EDIT_PROMPT: PromptSection = {
  rules: () => [
    '- get_page(page) READS any page of the magazine (read-only). Use it whenever the user mentions another',
    '  page, asks what the magazine contains, or wants this page consistent with another (matching wording,',
    '  colours, sizes — read the other page, then stage the edits HERE). You can only EDIT the open page;',
    '  if they want another page changed, read it, say what you would change, and ask them to open it.',
    '- The element marked THIS is the one the user has selected — resolve "this/that/it/the selected …" to it.',
    '- The element list shows the FULL text of every box (" / " marks a line break); a very long box is cut and',
    '  marked "call read_element". read_element returns a box’s exact stored HTML, sizes and fit.',
    '- To change a word, name, figure or spelling, use replace_text: it changes only the matched words and keeps',
    '  every other character and all formatting. set_element_text replaces a box’s WHOLE content — use it only',
    '  for new or rewritten copy, only on text you have seen in full (read_element first when it is marked cut),',
    '  and keep every word and every <b>/<i>/<br> you were not asked to change.',
    '- A "paragraph-with-drop-cap" line is ONE paragraph drawn as several pieces. Edit, move, restyle or delete',
    '  it only through its #dropcap-… id, and give set_element_text the WHOLE new paragraph; the drop cap is',
    '  re-set for you (or removed, with the reason, when the new copy cannot carry one).',
    '- A fontSize from set_element_style becomes that text’s new maximum, so later edits never undo it. If the',
    '  text no longer fits at that size its box grows down into free space; when there is no room the result',
    '  says so with the numbers (fit) — then pick the size it fits at, shorten it, or make room.',
  ],
  sourceDocument: () => [
    'The user attached a SOURCE DOCUMENT (below). When they ask to fill / write / draft / use it for this',
    "page, draw real copy from its ACTUAL content (names, figures, quotes) and stage it into the page's text",
    'elements with set_element_text.',
  ],
  extra: () => [
    'YOU CAN SEE THIS PAGE. Never tell the user you cannot see it, and never ask them to check it for you.',
    '- The element list below carries the page check: a ⚠ marks a box that is cut off, runs off the page,',
    '  overlaps other text, is hidden under something, or is an empty picture box — with the measured numbers.',
    '- Every edit tool returns fit for what it changed: whether its text fits the box, at what size, and how',
    '  much room is free below it.',
    '- check_page measures the whole page as it will look once your staged changes are applied: cut-off or',
    '  overflowing text, text past the page edge, overlaps, hidden or empty pictures, tiny or low-contrast type.',
    '- look_at_page renders the page and has a reviewer look at it (at most twice a turn). Use it when the user',
    '  says the page LOOKS wrong, and after adding a picture or a chart or changing the layout.',
    '- After any change to text, sizes, positions or pictures, call check_page. If it reports an error, fix it',
    '  in this same turn — shorter copy, the fontSize it fits at, a bigger box, move it, raise its zIndex,',
    '  tidy_column for loose gaps between stacked boxes — and check again, at most 2 rounds. Then say in one',
    '  short line what you checked, and name anything you could not fix.',
  ],
};

// ── Seeing the page ──────────────────────────────────────────────────────────

/**
 * The page check on the working copy — the page as it will be once the staged changes
 * are applied. Measured in Chromium with the real web fonts when the renderer is up and
 * the turn has time for it (renderPreview.measurePagePreview); the estimate from the
 * element data otherwise. Never throws.
 */
async function workingCheck(ctx: AgentCtx): Promise<PageCheck> {
  const pageNumber = ctx.pageIndex + 1;
  const left = ctx.deadline - Date.now();
  if (left >= MEASURE_MIN_LEFT_MS) {
    try {
      const m = await measurePagePreview(previewPageOf(ctx.page, ctx.working), {
        timeoutMs: Math.min(MEASURE_MS, left - LOOK_RESERVE_MS),
        queueMs: MEASURE_QUEUE_MS,
      });
      if (m) return checkPageFromMeasurements(m, ctx.working, ctx.page, { pageNumber, measuredBy: 'chromium' });
    } catch {
      // measurePagePreview never throws; this is belt and braces for the estimate below.
    }
  }
  return checkPage(ctx.working, ctx.page, { pageNumber });
}

/** A check as a tool result: the verdict, the summary and the issues with their fixes. */
function checkResult(check: PageCheck) {
  return {
    ok: check.ok,
    measuredBy: check.measuredBy,
    summary: check.summary,
    issues: check.issues.map((i) => ({
      severity: i.severity,
      kind: i.kind,
      ...(i.elementId ? { elementId: i.elementId } : {}),
      ...(i.otherId ? { otherId: i.otherId } : {}),
      label: i.label,
      detail: i.detail,
      fix: i.fix,
    })),
  };
}

// ── Drop-cap paragraphs: edited as one ───────────────────────────────────────

/** Free space below a drop-cap paragraph's rectangle, ignoring its own pieces. */
function freeBelowPara(ctx: AgentCtx, p: DropCapParagraph): number {
  const pieces = new Set(dropCapPieceIds(p));
  const others = ctx.working.filter((e) => !pieces.has(e.id));
  return freeSpaceBelow({ ...p.lead, id: p.key, ...p.box }, others, pageDims(ctx));
}

/**
 * Stage a re-set drop-cap paragraph: every piece's update (and the deletes of a fold)
 * as proposals, after checking that none of the pieces is locked — all of it or none.
 */
function stageDropCap(ctx: AgentCtx, p: DropCapParagraph, rewrite: DropCapRewrite, summary: string) {
  if (hasLayout(ctx)) return { ok: false as const, error: LAYOUT_CLASH };
  const locked = dropCapPieceIds(p).find((id) => find(ctx, id)?.locked === true);
  if (locked) return { ok: false as const, error: `#${locked} (part of the paragraph #${p.key}) is locked — ask the user to unlock it first.` };
  rewrite.updates.forEach((u, i) => {
    stageUpdate(ctx, u.elementId, u.patch, i === 0 ? summary : `${summary} (drop-cap piece)`);
  });
  for (const id of rewrite.deletes) stageDelete(ctx, id, `${summary} (removed a drop-cap piece)`);
  const note =
    rewrite.kind === 'fold'
      ? `The drop cap was removed (${rewrite.why}); the paragraph is now one ordinary body box, #${p.lead.id}.`
      : `The drop cap was re-set for it at ${Math.round(rewrite.fontSize)}px.`;
  const fit = fitOf(ctx, p.lead.id);
  return {
    ok: true as const,
    summary,
    note: rewrite.fits ? note : `${note} It still does not fit its ${Math.round(rewrite.box.h)}px: shorten it or make room below.`,
    ...(rewrite.kind === 'fold' && fit ? { fit } : { fit: { fits: rewrite.fits, fontSize: Math.round(rewrite.fontSize * 10) / 10 } }),
  };
}

const quote = (s: string) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > 40 ? `${flat.slice(0, 39)}…` : flat;
};

export function editTools(ctx: AgentCtx) {
  /** Has the model seen all of this element's text (or read it since)? */
  const seenInFull = (id: string) => !ctx.shownPartly?.has(id) || !!ctx.readFully?.has(id);
  const markRead = (...ids: string[]) => {
    ctx.readFully ??= new Set();
    for (const id of ids) ctx.readFully.add(id);
  };

  return {
    get_page: tool({
      description:
        'READ any page of this magazine by its 1-based page number: returns that page\'s elements (same format as the open page\'s list, with full text). Read-only — you cannot edit elements on other pages; use it to answer questions about them or to match their style/wording on the OPEN page.',
      inputSchema: z.object({ page: z.number().int().min(1).describe('1-based page number, as the user counts pages') }),
      execute: async ({ page }) => {
        const all = (await db.collection(COL.pages).find({ magazineId: ctx.magazineId })) as
          { _id: string; index: number; elements?: unknown }[];
        const ordered = all.sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));
        const target = ordered[page - 1];
        if (!target) {
          const n = ordered.length;
          return { ok: false as const, error: `This magazine has ${n} page${n === 1 ? '' : 's'}, so there is no page ${page}.` };
        }
        const isOpen = Number(target.index) === ctx.pageIndex;
        // Visibility is the caller's, not the magazine's: a page the user cannot
        // see on their own screen is refused, not summarised.
        if (!isOpen && !ctx.readable?.has(String(target._id))) {
          return { ok: false as const, error: `Page ${page} is not shared with this user, so it cannot be read here.` };
        }
        if (isOpen) {
          // The open page reads from the WORKING copy so the model sees its own staged
          // edits, every element of it (it used to stop at 40), with the page check's
          // flags as they stand now.
          const listed = describePage(ctx.working, { flags: checkFlags(checkPage(ctx.working, ctx.page)) });
          ctx.shownPartly ??= new Set();
          for (const id of listed.truncated) ctx.shownPartly.add(id);
          return { ok: true as const, page, isOpenPage: true, elements: withNaturalSizes(listed.lines, ctx.working, ctx.imageSizes) };
        }
        // Other pages read from what is stored, with a smaller text budget, and their
        // pictures' exact urls (so "use the same photo as page 2" can name one).
        const els = Array.isArray(target.elements) ? (target.elements as MagazineElement[]) : [];
        const listed = describePage(els, { perElement: OTHER_PAGE_ELEMENT_MAX, budget: OTHER_PAGE_BUDGET });
        const images = els
          .filter((e) => e.type === 'image' && e.image?.url)
          .slice(0, 40)
          .map((e) => {
            const s = naturalSizeFor(e, ctx.imageSizes);
            return { id: e.id, url: e.image!.url, alt: (e.image!.alt ?? '').slice(0, 120), ...(s ? { size: sizeLabel(s) } : {}) };
          });
        return {
          ok: true as const,
          page,
          isOpenPage: false,
          elements: listed.lines,
          ...(images.length ? { images } : {}),
          note: 'Read-only: these element ids belong to another page and cannot be edited from here.',
        };
      },
    }),

    read_element: tool({
      description:
        'Read ONE element of the open page in full: a text box\'s exact stored HTML content (with its <b>/<i>/<br>) and its role, source, fontSize, maxFontSize, lineHeight and box; a picture\'s exact url, alt and assetId. Reflects changes you staged this turn. Call it before set_element_text on text the list shows cut.',
      inputSchema: z.object({ elementId: z.string() }),
      execute: async ({ elementId }) => {
        const para = dropCapParagraphOf(ctx.working, elementId);
        if (para) {
          markRead(para.key, ...dropCapPieceIds(para));
          return {
            ok: true as const,
            id: para.key,
            type: 'paragraph-with-drop-cap',
            role: para.lead.text!.role,
            content: para.raw,
            text: modelText(para.raw),
            fontSize: para.pinned,
            box: para.box,
            pieces: dropCapPieceIds(para),
            note: `ONE paragraph drawn as ${dropCapPieceIds(para).length} pieces. Edit it only through #${para.key}: set_element_text takes the WHOLE paragraph and the drop cap is re-set.`,
          };
        }
        const el = find(ctx, elementId);
        if (!el) return { ok: false as const, error: `No element #${elementId} on this page.` };
        markRead(el.id);
        const base = {
          ok: true as const,
          id: el.id,
          type: el.type,
          source: el.source,
          x: Math.round(el.x),
          y: Math.round(el.y),
          w: Math.round(el.w),
          h: Math.round(el.h),
          zIndex: el.zIndex,
          ...(el.rotation ? { rotation: el.rotation } : {}),
          locked: el.locked,
        };
        if (el.type === 'text' && el.text) {
          const t = el.text;
          return {
            ...base,
            role: t.role,
            content: t.content,
            fontSize: t.fontSize,
            ...(typeof t.maxFontSize === 'number' ? { maxFontSize: t.maxFontSize } : {}),
            ...(typeof t.minFontSize === 'number' ? { minFontSize: t.minFontSize } : {}),
            lineHeight: t.lineHeight,
            fontFamily: t.fontFamily,
            fontWeight: t.fontWeight,
            color: t.color,
            align: t.align,
            vAlign: t.vAlign === 'center' ? 'middle' : (t.vAlign ?? 'top'),
            ...(t.letterSpacing ? { letterSpacing: t.letterSpacing } : {}),
            ...(t.textTransform && t.textTransform !== 'none' ? { textTransform: t.textTransform } : {}),
            fit: fitOf(ctx, el.id),
            ...(el.source === 'extracted'
              ? { note: 'Copied from a PDF: its lines are kept as the PDF set them ("\\n"). Any change to its words, size or width makes it ordinary text that wraps in its box.' }
              : {}),
          };
        }
        if (el.type === 'image' && el.image) {
          // The picture's own pixel size, when known: what "make the box the image's
          // ratio" needs (set_image_fit with fitBoxToImage does it exactly).
          const natural = naturalSizeFor(el, ctx.imageSizes);
          return {
            ...base,
            url: el.image.url,
            alt: el.image.alt,
            assetId: el.image.assetId,
            fit: el.image.fit,
            ...(el.image.focalPoint ? { focalPoint: el.image.focalPoint } : {}),
            ...(natural ? { naturalSize: sizeLabel(natural) } : {}),
          };
        }
        if (el.type === 'shape' && el.shape) return { ...base, fill: el.shape.fill, opacity: el.shape.opacity ?? 1 };
        if (el.type === 'qr' && el.qr) return { ...base, url: el.qr.url, fg: el.qr.fg, bg: el.qr.bg };
        if (el.type === 'icon' && el.icon) return { ...base, icon: el.icon.src ? 'uploaded art' : el.icon.name ?? '', ...(el.icon.color ? { color: el.icon.color } : {}) };
        return base;
      },
    }),

    set_element_text: tool({
      description:
        'Replace the ENTIRE content of a text element (light inline HTML only: <b><i><u><br>). Whatever is not in `content` is removed. For a word, name, figure or spelling change use replace_text instead. On text the list shows cut, call read_element first. For a paragraph with a drop cap, pass its #dropcap-… id and the WHOLE new paragraph. Returns fit; text that no longer fits grows its box down into free space when there is room.',
      inputSchema: z.object({ elementId: z.string(), content: z.string() }),
      execute: async ({ elementId, content }) => {
        const html = content.slice(0, 8000);
        const para = dropCapParagraphOf(ctx.working, elementId);
        if (para) {
          if (!seenInFull(para.key)) {
            return { ok: false as const, error: `You were shown only part of the paragraph #${para.key}. Call read_element first (or use replace_text for a word swap).` };
          }
          const rewrite = planDropCapRewrite(para, { raw: html, growPx: freeBelowPara(ctx, para) });
          const preview = textPreview(html);
          return stageDropCap(ctx, para, rewrite, `Rewrote the opening paragraph${preview ? ` → “${preview}”` : ''}`);
        }
        const el = find(ctx, elementId);
        if (!el || el.type !== 'text' || !el.text) return { ok: false as const, error: 'Not a text element.' };
        if (!seenInFull(el.id)) {
          return {
            ok: false as const,
            error: `You were shown only part of #${el.id}'s text, and set_element_text replaces all of it. Call read_element first and keep every word you were not asked to change — or use replace_text for a word swap.`,
          };
        }
        const before = visibleText(el.text.content).replace(/\s+/g, ' ').trim();
        const { patch, growth } = withGrowth(el, { text: { content: html } }, ctx.working, pageDims(ctx));
        const preview = textPreview(html);
        const r = stageUpdate(ctx, elementId, patch, `Rewrote the ${elLabel(el)}${preview ? ` → “${preview}”` : ''}${growth?.kind === 'grow' ? ' (box grown to fit)' : ''}`);
        if (!r.ok) return r;
        // stageUpdate is synchronous, so the last proposal is the one it just staged.
        const staged = lastProposal(ctx);
        const after = visibleText(html).replace(/\s+/g, ' ').trim();
        const dropped = before.length >= DROP_WARN_MIN_CHARS && after.length < before.length * (1 - DROP_WARN_SHARE);
        // The person pressing Apply sees the same fact, in their words rather than the
        // model's instructions.
        if (dropped) warnProposals([staged], `This removes most of the box's existing text (${before.length} → ${after.length} characters).`);
        const note = growthNote(growth);
        return {
          ...r,
          fit: fitOf(ctx, elementId),
          ...(note ? { note } : {}),
          ...(dropped
            ? { warning: `This removed most of the existing copy (${before.length} → ${after.length} characters). Right only if the user asked for shorter or new text; for a word change, use replace_text on the original instead.` }
            : {}),
        };
      },
    }),

    replace_text: tool({
      description:
        'Find and replace words INSIDE the text of the open page\'s text boxes (or only the elementIds given), keeping every other character and all formatting exactly as it is. The right tool for any word, name, figure or spelling change ("replace NZTROF with NOG"). Matches across line breaks and formatting; case-sensitive unless matchCase is false. Returns how many places changed in each box, or that the text was not found.',
      inputSchema: z.object({
        find: z.string().min(1).describe('The exact words to find, as they read on the page'),
        replace: z.string().describe('What to put in their place (plain text)'),
        elementIds: z.array(z.string()).optional().describe('Only these boxes; default every text box on the page'),
        matchCase: z.boolean().optional().describe('Default true: "Cup" does not match "cup"'),
        wholeWord: z.boolean().optional().describe('true: "Cup" does not match "Cupboard"'),
      }),
      execute: async ({ find: needle, replace, elementIds, matchCase, wholeWord }) => {
        if (hasLayout(ctx)) return { ok: false as const, error: LAYOUT_CLASH };
        if (needle.trim() === replace.trim()) return { ok: false as const, error: 'find and replace are the same — there is nothing to change.' };
        const r = replaceOnPage(ctx.working, needle, replace, { ids: elementIds, matchCase, wholeWord });
        const locked = r.locked.length
          ? { lockedSkipped: r.locked.map((l) => ({ elementId: l.id, count: l.count })) }
          : {};
        // A box the replacement would push past the stored-text limit is left as it is
        // (the write would cut the end of its copy off) and named, so the model can say
        // so or shorten that box's copy itself.
        const tooLong = r.tooLong.length
          ? {
              tooLongSkipped: r.tooLong.map((l) => ({ elementId: l.id, count: l.count })),
              tooLongNote: `Not replaced in ${r.tooLong.map((l) => `#${l.id}`).join(', ')}: the longer text would pass the ${MAX_TEXT_HTML}-character limit of one text box and its end would be cut off. Tell the user; shortening that box's copy first would make room.`,
            }
          : {};
        if (!r.total) {
          if (r.locked.length || r.tooLong.length) {
            const lockedPart = r.locked.length ? `locked boxes (${r.locked.map((l) => `#${l.id}`).join(', ')}) — ask the user to unlock them` : '';
            const longPart = r.tooLong.length ? `boxes too full to take the longer text (${r.tooLong.map((l) => `#${l.id}`).join(', ')})` : '';
            return { ok: false as const, error: `“${quote(needle)}” appears only in ${[lockedPart, longPart].filter(Boolean).join(', and in ')}.`, ...locked, ...tooLong };
          }
          const other = r.otherCase
            ? ` It does appear ${r.otherCase} time${r.otherCase === 1 ? '' : 's'} with different capital letters — call again with matchCase: false if those are meant.`
            : '';
          return {
            ok: false as const,
            found: 0,
            error: `“${quote(needle)}” was not found on this page (searched ${r.searched} text box${r.searched === 1 ? '' : 'es'}).${other} Tell the user rather than rewriting anything.`,
          };
        }
        const summaryFor = (n: number) => `Replaced “${quote(needle)}” → “${quote(replace)}” (${n}×)`;
        const changed: Record<string, unknown>[] = [];
        const firstNew = ctx.proposals.length;
        for (const hit of r.hits) {
          if (hit.para) {
            const rewrite = planDropCapRewrite(hit.para, { raw: hit.html, growPx: freeBelowPara(ctx, hit.para) });
            const s = stageDropCap(ctx, hit.para, rewrite, summaryFor(hit.count));
            changed.push({ elementId: hit.id, count: hit.count, ...(s.ok ? { note: s.note } : { error: s.error }) });
            continue;
          }
          const el = find(ctx, hit.id)!;
          const { patch, growth } = withGrowth(el, { text: { content: hit.html } }, ctx.working, pageDims(ctx));
          const s = stageUpdate(ctx, hit.id, patch, summaryFor(hit.count));
          if (!s.ok) {
            changed.push({ elementId: hit.id, count: hit.count, error: s.error });
            continue;
          }
          const fit = fitOf(ctx, hit.id);
          const note = growthNote(growth);
          changed.push({ elementId: hit.id, count: hit.count, ...(fit && !fit.fits ? { fit } : {}), ...(note ? { note } : {}) });
        }
        const staged = changed.filter((c) => !('error' in c)).reduce((n, c) => n + Number(c.count), 0);
        // One find-and-replace is ONE change to the person approving it, however many
        // boxes it touched: the Apply line names it once ("… (4×)").
        for (const p of ctx.proposals.slice(firstNew)) p.group = summaryFor(staged);
        return {
          ok: staged > 0,
          summary: summaryFor(staged),
          changed,
          ...locked,
          ...tooLong,
        };
      },
    }),

    set_element_style: tool({
      description:
        "Change a text element's typography — everything the panel's Text section has: fontFamily, fontSize, fontWeight (400–900), color (hex), align (left/center/right/justify), vAlign (top/middle/bottom of its box), lineHeight, letterSpacing (px), textTransform — or a shape element's fill (#rrggbb) and opacity. " +
        'A fontSize becomes the text\'s new maximum (later edits never undo it); if the text no longer fits, its box grows down into free space, or the result says it does not fit (fit). ' +
        'fontFamily takes a family the panel offers (Playfair Display, Lora, Merriweather, EB Garamond, Source Sans 3, Inter, Montserrat, Oswald, …) or one already used on this page. ' +
        'For a see-through overlay or scrim over a photo use a dark fill with opacity 0.35–0.6 — never a solid band over the photo.',
      inputSchema: z.object({
        elementId: z.string(),
        fontFamily: z.string().optional().describe('a font family name, e.g. "Lora" or "Montserrat"'),
        fontSize: z.number().optional(),
        fontWeight: z.number().optional().describe('400 (regular) to 900 (black), in hundreds'),
        color: z.string().optional(),
        align: z.enum(['left', 'center', 'right', 'justify']).optional(),
        vAlign: z.enum(['top', 'middle', 'center', 'bottom']).optional().describe('where the text sits inside its box, top to bottom'),
        lineHeight: z.number().optional(),
        letterSpacing: z.number().min(-20).max(100).optional().describe('extra space between letters, in px (0 = normal)'),
        textTransform: z.enum(['none', 'uppercase', 'lowercase', 'capitalize']).optional(),
        fill: z.string().optional().describe('shapes: #rrggbb'),
        opacity: z.number().min(0).max(1).optional().describe('shapes: 0 = invisible, 1 = solid; 0.35–0.6 for a scrim over a photo'),
      }),
      execute: async ({ elementId, fill, opacity, ...asked }) => {
        // The panel's values, made into what the element stores: a weight in hundreds
        // between 400 and 900 (anything else used to be stored as 400 without a word),
        // "middle" as the stored 'center'.
        const { vAlign: vRaw, fontFamily: familyRaw, ...rest } = asked;
        const text: Record<string, unknown> & { fontWeight?: number; align?: string; lineHeight?: number; fontSize?: number; color?: string } = { ...rest };
        if (typeof text.fontWeight === 'number') text.fontWeight = Math.max(400, Math.min(900, Math.round(text.fontWeight / 100) * 100));
        const vAlign = normalizeVAlign(vRaw);
        const para = dropCapParagraphOf(ctx.working, elementId);
        if (para) {
          if (
            text.fontWeight !== undefined ||
            text.align !== undefined ||
            text.lineHeight !== undefined ||
            familyRaw !== undefined ||
            vAlign !== undefined ||
            text.letterSpacing !== undefined ||
            text.textTransform !== undefined
          ) {
            return { ok: false as const, error: `#${para.key} is a paragraph with a drop cap: only its fontSize and color can change. To restyle it otherwise, rewrite it with set_element_text as a plain paragraph.` };
          }
          if (text.fontSize !== undefined) {
            const rewrite = planDropCapRewrite(para, { fontSize: text.fontSize, growPx: freeBelowPara(ctx, para) });
            const r = stageDropCap(ctx, para, rewrite, `Set the opening paragraph at ${Math.round(text.fontSize)}px`);
            if (!r.ok || text.color === undefined) return r;
          }
          if (text.color !== undefined) {
            // The colour of the copy, not of the cap (which carries the accent), unless
            // the cap itself was named.
            const ids = elementId === para.cap.id ? [para.cap.id] : [para.lead.id, ...(para.rest ? [para.rest.id] : [])];
            const locked = ids.find((id) => find(ctx, id)?.locked === true);
            if (locked) return { ok: false as const, error: `#${locked} is locked — ask the user to unlock it first.` };
            let last: ReturnType<typeof stageUpdate> = { ok: true as const, summary: '' };
            ids.forEach((id, i) => {
              last = stageUpdate(ctx, id, { text: { color: text.color } }, i === 0 ? 'Recoloured the opening paragraph' : 'Recoloured the opening paragraph (drop-cap piece)');
            });
            return last;
          }
          return { ok: false as const, error: 'No style fields given.' };
        }
        const el = find(ctx, elementId);
        if (!el) return { ok: false as const, error: `No element #${elementId}.` };
        if (el.type === 'shape' && (fill || opacity !== undefined)) {
          // Both fields, so neither is lost when the shape is restyled. A fill written
          // with its own alpha ("rgba(0,0,0,0.4)") also becomes opacity (model.ts).
          const shape: Record<string, unknown> = { fill: fill ?? el.shape?.fill ?? '#000000' };
          // A fill that carries its own alpha sets the transparency by itself (reset the
          // stored opacity to 1 so the two don't multiply); a plain #rrggbb recolour
          // keeps whatever opacity the shape already had.
          const fillAlpha = fill ? (parseColor(fill)?.alpha ?? 1) : 1;
          const keep = opacity ?? (fill && fillAlpha < 1 ? 1 : fill ? undefined : el.shape?.opacity);
          if (keep !== undefined) shape.opacity = keep;
          return stageUpdate(ctx, elementId, { shape }, opacity !== undefined && !fill ? 'Changed the shape opacity' : 'Recoloured the shape');
        }
        if (el.type === 'text' && el.text) {
          const t: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(text)) if (v !== undefined) t[k] = v;
          if (vAlign !== undefined) t.vAlign = vAlign;
          // A family the renderers can draw: the panel's own list, or one this page
          // already uses. Stored as the panel stores it, so the picker shows it chosen.
          const notes: string[] = [];
          if (familyRaw !== undefined) {
            const font = resolveFontFamily(familyRaw, pageFontStacks(ctx.working, ctx.theme), typeof t.fontWeight === 'number' ? t.fontWeight : el.text.fontWeight);
            if (!font.ok) return { ok: false as const, error: font.error };
            t.fontFamily = font.stack;
            if (font.note) notes.push(font.note);
          } else if (typeof t.fontWeight === 'number') {
            const label = (el.text.fontFamily.split(',')[0] ?? '').trim().replace(/^['"]+|['"]+$/g, '');
            const note = weightNote(el.text.fontFamily, label, t.fontWeight);
            if (note) notes.push(note);
          }
          if (!Object.keys(t).length) return { ok: false as const, error: 'No style fields given.' };
          // The asked-for size is the new CEILING: shrink-to-fit only ever starts from
          // maxFontSize, so leaving the old one meant the next edit undid "bigger"
          // (C03/C50). The write path does the same for any writer; saying it here too
          // keeps the proposal right whatever applies it.
          if (typeof t.fontSize === 'number') t.maxFontSize = t.fontSize;
          const changesFit = ['fontSize', 'fontWeight', 'lineHeight', 'fontFamily', 'letterSpacing', 'textTransform'].some((k) => t[k] !== undefined);
          const { patch, growth } = changesFit
            ? withGrowth(el, { text: t }, ctx.working, pageDims(ctx))
            : { patch: { text: t }, growth: null };
          const what = familyRaw !== undefined && t.fontFamily ? ` in ${String(t.fontFamily).split(',')[0]!.replace(/['"]/g, '')}` : '';
          const r = stageUpdate(ctx, elementId, patch, `Restyled the ${elLabel(el)}${what}${growth?.kind === 'grow' ? ' (box grown to fit)' : ''}`);
          if (!r.ok) return r;
          const note = [growthNote(growth), ...notes].filter(Boolean).join(' ');
          return { ...r, fit: fitOf(ctx, elementId), ...(note ? { note } : {}) };
        }
        return { ok: false as const, error: 'Element has no styleable properties.' };
      },
    }),

    move_element: tool({
      description:
        'Reposition/resize an element (pixels, page coordinates), rotate it (degrees, -180 to 180), and/or change its stacking — a zIndex, or layer "front" / "back" exactly like the panel\'s To front / To back buttons. The box is kept on the page (the result says when a value was pulled in). Returns fit for text.',
      inputSchema: z.object({
        elementId: z.string(),
        x: z.number().optional(),
        y: z.number().optional(),
        w: z.number().optional(),
        h: z.number().optional(),
        rotation: z.number().min(-180).max(180).optional().describe('degrees clockwise; 0 = upright'),
        zIndex: z.number().optional(),
        layer: z.enum(['front', 'back']).optional().describe('front = above everything else on the page, back = below everything else'),
      }),
      execute: async ({ elementId, zIndex, rotation, layer, ...geo }) => {
        const given = Object.values(geo).some((v) => v !== undefined);
        if (!given && zIndex === undefined && rotation === undefined && layer === undefined) return { ok: false as const, error: 'No geometry given.' };
        const dims = pageDims(ctx);
        const layerId = dropCapParagraphOf(ctx.working, elementId)?.lead.id ?? elementId;
        const z =
          zIndex !== undefined
            ? Math.round(Math.max(0, Math.min(9999, zIndex)))
            : layer !== undefined && find(ctx, layerId)
              ? zForLayer(ctx.working, layerId, layer)
              : undefined;

        const para = dropCapParagraphOf(ctx.working, elementId);
        if (para) {
          if (rotation !== undefined) return { ok: false as const, error: `#${para.key} is a paragraph with a drop cap, drawn as several pieces — it cannot be rotated.` };
          // Only a call that moves or resizes is clamped: a layer-only call must not
          // shift the paragraph (clampToPage writes x/y for any box outside the page).
          const { patch: box, notes } = given ? clampToPage(para.box, geo, dims) : { patch: {}, notes: [] as string[] };
          const target = { ...para.box, ...box };
          const resized = Math.abs(target.w - para.box.w) > 0.5 || Math.abs(target.h - para.box.h) > 0.5;
          if (resized) {
            const rewrite = planDropCapRewrite(para, { box: target });
            const r = stageDropCap(ctx, para, rewrite, 'Resized the opening paragraph');
            return notes.length && r.ok ? { ...r, clamped: notes.join(', ') } : r;
          }
          const dx = target.x - para.box.x;
          const dy = target.y - para.box.y;
          const ids = dropCapPieceIds(para);
          const locked = ids.find((id) => find(ctx, id)?.locked === true);
          if (locked) return { ok: false as const, error: `#${locked} is locked — ask the user to unlock it first.` };
          let last: ReturnType<typeof stageUpdate> = { ok: true as const, summary: '' };
          ids.forEach((id, i) => {
            const piece = find(ctx, id)!;
            const patch: Record<string, unknown> = {};
            if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) Object.assign(patch, { x: piece.x + dx, y: piece.y + dy });
            if (z !== undefined) patch.zIndex = id === para.cap.id ? z + 1 : z;
            if (Object.keys(patch).length) last = stageUpdate(ctx, id, patch, i === 0 ? 'Moved the opening paragraph' : 'Moved the opening paragraph (drop-cap piece)');
          });
          return notes.length && last.ok ? { ...last, clamped: notes.join(', ') } : last;
        }

        const el = find(ctx, elementId);
        if (!el) return stageUpdate(ctx, elementId, {}, 'Moved an element'); // the shared "no element" refusal
        // Clamped only when this call moves or resizes: "send the background photo to
        // the back" or "rotate it" used to pull a full-bleed or deliberately cropped
        // picture inside the page by its bleed. Pictures and panels may keep a bleed.
        const { patch, notes } = given
          ? clampToPage(el, geo, dims, { bleed: el.type === 'image' || el.type === 'shape' })
          : { patch: {} as ReturnType<typeof clampToPage>['patch'], notes: [] as string[] };
        const full: Record<string, unknown> = { ...patch };
        if (z !== undefined) full.zIndex = z;
        if (rotation !== undefined) full.rotation = Math.round(rotation * 10) / 10;
        if (!Object.keys(full).length) return { ok: true as const, summary: 'Nothing to change', fit: fitOf(ctx, elementId) };
        const verb =
          given ? 'Moved' : rotation !== undefined && z === undefined ? 'Rotated' : layer === 'front' ? 'Brought to the front' : layer === 'back' ? 'Sent to the back' : 'Restacked';
        const r = stageUpdate(ctx, elementId, full, verb === 'Moved' || verb === 'Rotated' || verb === 'Restacked' ? `${verb} the ${elLabel(el)}` : `${verb}: the ${elLabel(el)}`);
        if (!r.ok) return r;
        return {
          ...r,
          ...(notes.length ? { clamped: `Kept it on the page: ${notes.join(', ')}` } : {}),
          fit: fitOf(ctx, elementId),
        };
      },
    }),

    set_qr_link: tool({
      description: 'Set a QR element\'s destination (https/mailto/tel only).',
      inputSchema: z.object({ elementId: z.string(), url: z.string() }),
      execute: async ({ elementId, url }) => {
        const el = find(ctx, elementId);
        if (!el || el.type !== 'qr') return { ok: false, error: 'Not a QR element.' };
        const safe = safeUrl(url);
        if (!safe) return { ok: false, error: 'Invalid URL (only http(s)/mailto/tel).' };
        return stageUpdate(ctx, elementId, { qr: { url: safe } }, 'Set the QR link');
      },
    }),

    delete_element: tool({
      description: 'Remove an element from the page (a paragraph with a drop cap goes as a whole).',
      inputSchema: z.object({ elementId: z.string() }),
      execute: async ({ elementId }) => {
        if (hasLayout(ctx)) return { ok: false, error: LAYOUT_CLASH };
        const para = dropCapParagraphOf(ctx.working, elementId);
        if (para) {
          const ids = dropCapPieceIds(para);
          const locked = ids.find((id) => find(ctx, id)?.locked === true);
          if (locked) return { ok: false, error: `#${locked} is locked — ask the user to unlock it first.` };
          for (const id of ids) stageDelete(ctx, id, id === para.cap.id ? 'Deleted the opening paragraph (with its drop cap)' : 'Deleted the opening paragraph (drop-cap piece)');
          return { ok: true, summary: 'Deleted the opening paragraph (with its drop cap)' };
        }
        const el = find(ctx, elementId);
        if (!el) return { ok: false, error: `No element #${elementId}.` };
        // Name a picture by what it shows, so the person approving the delete can see
        // WHICH picture goes (C44).
        const alt = el.type === 'image' ? quote(el.image?.alt ?? '') : '';
        return stageDelete(ctx, elementId, alt ? `Deleted the image “${alt}”` : `Deleted the ${elLabel(el)}`);
      },
    }),

    check_page: tool({
      description:
        'MEASURE the open page as it will look once your staged changes are applied: text cut off or spilling, text past the page edge, overlapping text, elements hidden under others, empty or broken pictures, tiny or low-contrast type, loose gaps. Each issue names the element, the measured numbers and a concrete fix. Call it after your edits; fix any error and check again (at most 2 rounds).',
      inputSchema: z.object({}),
      execute: async () => {
        const check = await workingCheck(ctx);
        return {
          ...checkResult(check),
          ...(check.ok ? {} : { next: 'Fix each error now with your tools (the fix line says how), then call check_page again — at most 2 rounds.' }),
        };
      },
    }),

    look_at_page: tool({
      description:
        'LOOK at the open page: it is rendered as it will print (with your staged changes) and reviewed by eye for what a measurement cannot see — a photo cropped through its subject, type lost on a busy photo, a page that does not look like what the user asked for. Returns findings that name elements, plus the measured check. At most twice a turn; use it when the user says the page looks wrong, and after adding a picture, a chart or a layout change.',
      inputSchema: z.object({ focus: z.string().optional().describe('What to look at in particular, e.g. "the new chart" or "the headline"') }),
      execute: async ({ focus }) => {
        const blind = (reason: string, check: PageCheck) => ({
          seen: false as const,
          reason,
          findings: [] as unknown[],
          check: checkResult(check),
          next: 'No picture this time: the measured check above is the page as it stands — act on it, and do not tell the user you cannot see the page.',
        });
        if (ctx.looks >= MAX_LOOKS) return blind(`already looked ${MAX_LOOKS} times this turn — use check_page`, checkPage(ctx.working, ctx.page, { pageNumber: ctx.pageIndex + 1 }));
        ctx.looks += 1;
        const check = await workingCheck(ctx);
        const left = ctx.deadline - Date.now();
        if (left < LOOK_MIN_LEFT_MS) return blind('out of time this turn', check);
        const res = await lookAtPage({
          page: previewPageOf(ctx.page, ctx.working),
          elements: ctx.working,
          request: ctx.request,
          focus: focus?.slice(0, 200),
          pageNumber: ctx.pageIndex + 1,
          check,
          timeoutMs: Math.min(LOOK_MAX_MS, left - LOOK_RESERVE_MS),
        });
        if (!res.seen) return blind(res.reason ?? 'the visual review was not available', check);
        return {
          seen: true as const,
          findings: res.findings,
          check: checkResult(check),
          ...(res.findings.length || !check.ok ? { next: 'Fix what was found with your tools, then check_page again.' } : {}),
        };
      },
    }),

    tidy_column: tool({
      description:
        'Restack boxes that sit in ONE column, top to bottom, so the gaps between them close up: the first keeps its place, each next one starts `gap` px below the text above it, and each text box becomes exactly as tall as its copy needs. For loose gaps between paragraphs (common on pages copied from a PDF, which the Adjust wand leaves alone). gap defaults to the column\'s own usual spacing.',
      inputSchema: z.object({
        elementIds: z.array(z.string()).min(2).describe('The boxes of the column, in any order'),
        gap: z.number().min(0).max(200).optional().describe('Space between boxes in page px'),
      }),
      execute: async ({ elementIds, gap }) => {
        if (hasLayout(ctx)) return { ok: false as const, error: LAYOUT_CLASH };
        const plan = tidyColumnPlan(ctx.working, elementIds, pageDims(ctx), gap);
        if (!plan.ok) return plan;
        if (!plan.moves.length) return { ok: true as const, summary: 'That column is already tidy — nothing to move.' };
        const moved: Record<string, unknown>[] = [];
        for (const m of plan.moves) {
          const el = find(ctx, m.id)!;
          const patch: Record<string, unknown> = {};
          if (m.y !== m.fromY) patch.y = m.y;
          if (m.h !== m.fromH) patch.h = m.h;
          const r = stageUpdate(ctx, m.id, patch, `Tidied the column: the ${elLabel(el)} ${m.y !== m.fromY ? `moved to y=${m.y}` : `fitted to ${m.h}px`}`);
          if (!r.ok) return { ok: false as const, error: r.error, staged: moved };
          const fit = fitOf(ctx, m.id);
          moved.push({ elementId: m.id, y: m.y, h: m.h, ...(fit && !fit.fits ? { fit } : {}) });
        }
        return {
          ok: true as const,
          summary: `Restacked ${plan.moves.length} box${plan.moves.length === 1 ? '' : 'es'} with ${plan.gap}px between them; the column now ends at y=${plan.bottom}.`,
          moved,
          next: 'Call check_page: anything below the column that the boxes now reach is reported there.',
        };
      },
    }),
  };
}
