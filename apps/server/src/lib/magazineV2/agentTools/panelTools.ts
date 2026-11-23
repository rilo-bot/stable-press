// ---------------------------------------------------------------------------
// Magazine Builder v2 — Studio-agent tools for what the Page & Element panel does by
// hand, and for the whole-page jobs a person asks for in one sentence.
//
// The rule (2026-11-15): the assistant can do EVERYTHING the manual panel can. Before,
// the client set a picture to Contain by hand because the assistant had no way to, the
// assistant answered "the background is a separate setting that I can't change", and a
// request to empty ten pages became ten messages whose staged removals replaced each
// other. These tools close those gaps:
//
//   set_page_background  a colour, a library picture, or plain white;
//   clear_page           every unlocked element in one call (the folio optionally kept);
//   set_image_fit        Contain / Cover, the focal point, and the box made the
//                        picture's own shape from its real pixel size;
//   set_qr_style         a QR code's colours (refused when it would stop scanning);
//   set_icon             an icon's glyph (the panel's set) and colour;
//   duplicate_element    a copy, on top, offset and kept on the page;
//   arrange_elements     N boxes to one size / height / even spacing between a top and
//                        a bottom, in ONE deterministic step — refused with the numbers
//                        when they cannot fit, never squeezed off the page.
//
// Fonts, justify, vertical alignment, letter spacing, case, rotation and To front /
// To back are on the edit tools (set_element_style, move_element). Like every agent
// tool these only STAGE proposals; the decisions are pure (../agentPanelPure.ts).
// ---------------------------------------------------------------------------

import { tool } from 'ai';
import { z } from 'zod';
import { db } from '../../db.js';
import { storage } from '../../storage.js';
import { COL } from '../collections.js';
import { safeUrl } from '../url.js';
import { isPlaceableMedia } from '../media.js';
import { MAX_ELEMENTS_PER_PAGE, parseColor, type MagazineElement } from '../model.js';
import { dropCapParagraphOf } from '../dropCapPara.js';
import { withoutStaged } from '../agentStructurePure.js';
import { briefLabel, contrastOn, frontZ, groundColorUnder } from '../agentAddPure.js';
import {
  arrangePlan,
  backgroundFromAsk,
  backgroundSummary,
  backgroundUrlAllowed,
  boxForRatio,
  clearPagePlan,
  duplicateOf,
  naturalSizeFor,
  plausibleSize,
  qrColourCheck,
  resolveIconName,
  sizeLabel,
  storedBackground,
  type NaturalSize,
} from '../agentPanelPure.js';
import type { AgentProposal } from '../agent.js';
import { elLabel, find, fitOf, hasLayout, lastProposal, LAYOUT_CLASH, pageDims, pid, stageAdd, stageDelete, stageUpdate, warnProposals, type AgentCtx, type PromptSection } from './shared.js';

/** This module's lines in the SYSTEM prompt (see PromptSection for the slots). */
export const PANEL_PROMPT: PromptSection = {
  rules: () => [
    '- You can do EVERYTHING the Page & Element panel can do by hand — never tell the user a panel option is',
    '  something you cannot do. Text: set_element_style (fontFamily from the panel’s families or one already on',
    '  the page, fontSize, fontWeight 400–900, align incl. justify, vAlign top/middle/bottom, color, lineHeight,',
    '  letterSpacing, textTransform). Pictures: set_image_fit (fit contain/cover, focal point; fitBoxToImage makes',
    '  the box the picture’s own shape), set_element_image (another picture). QR: set_qr_style (colours, link).',
    '  Icons: set_icon (glyph, colour). Any element: move_element (x, y, w, h, rotation, layer front/back),',
    '  duplicate_element, delete_element. The page: set_page_background (a colour, a picture, or clear: true for',
    '  plain white), use_image_as_layout / use_document_as_layout (match a layout), copy_document_page (copy a',
    '  page exactly).',
    '- The ONE panel option you have no tool for is whether the page goes out with "Publish selected pages" (the',
    '  publish tick above the page, or "In this edition" in the Page panel; the owner sets it). Never claim to',
    '  change it: tell the user to tick or untick it there, or to ask the AI Assistant to do it.',
    '- "Remove everything / make the page blank" → clear_page, ONE call (locked elements stay; keepFolio keeps the',
    '  page number and running head). The background is not an element: change or remove it with',
    '  set_page_background.',
    '- Several boxes to one size, height or spacing ("all six paragraphs 20px, 220px tall, 14px apart below the',
    '  subhead, not running off the bottom") → arrange_elements, ONE call. It refuses with the numbers when they',
    '  cannot fit between top and bottom — then tell the user what would fit; never squeeze boxes off the page.',
    '- Pictures in the element list show their own pixel size ("picture 1426x806 px") when it is known; to make a',
    '  box exactly the picture’s ratio use set_image_fit with fitBoxToImage (and w for the width you want).',
  ],
};

/** A media row as these tools read it. */
type LibraryRow = { _id: string; url?: string; kind?: string; alt?: string; width?: unknown; height?: unknown; chartBox?: { w?: unknown; h?: unknown } };

async function libraryRows(magazineId: string): Promise<LibraryRow[]> {
  return (await db.collection(COL.media).find({ magazineId })) as unknown as LibraryRow[];
}

/** A row's own pixel size: its recorded width × height, else the box a chart was drawn for. */
function rowSize(row: LibraryRow | undefined): NaturalSize | undefined {
  if (!row) return undefined;
  return plausibleSize(row.width, row.height) ?? plausibleSize(row.chartBox?.w, row.chartBox?.h);
}

/** Mark the last proposal staged as part of one tool call's change. */
function tagLast(ctx: AgentCtx, group: string): void {
  const last = ctx.proposals[ctx.proposals.length - 1] as AgentProposal | undefined;
  if (last) last.group = group;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function panelTools(ctx: AgentCtx) {
  /** The picture's own size: what the turn was told (media rows, attached images),
   *  else the library row it names. */
  const naturalSize = async (el: MagazineElement): Promise<NaturalSize | undefined> => {
    const known = naturalSizeFor(el, ctx.imageSizes);
    if (known) return known;
    try {
      const rows = await libraryRows(ctx.magazineId);
      const id = el.image?.assetId;
      return rowSize((id ? rows.find((r) => String(r._id) === id) : undefined) ?? rows.find((r) => r.url && r.url === el.image?.url));
    } catch {
      return undefined;
    }
  };

  return {
    set_page_background: tool({
      description:
        'Change the PAGE BACKGROUND — the paper behind every element, which no element tool touches: a solid colour (#rrggbb), a picture from list_media (imageUrl), or clear: true for plain white (removes a coloured or photo background). Staged like every change; one background change per page (a later one replaces an earlier one).',
      inputSchema: z.object({
        color: z.string().optional().describe('#rrggbb'),
        imageUrl: z.string().optional().describe('a picture url from list_media or one already on the page'),
        clear: z.boolean().optional().describe('true = plain white, no colour or picture'),
      }),
      execute: async ({ color, imageUrl, clear }) => {
        if (hasLayout(ctx)) return { ok: false as const, error: LAYOUT_CLASH };
        const ask = backgroundFromAsk({ color, imageUrl, clear });
        if (!ask.ok) return ask;
        let label = '';
        if (ask.background.type === 'image') {
          // EXACTLY the rule the background PATCH applies (agentPanelPure.
          // backgroundUrlAllowed), so a change is never staged that Apply would refuse:
          // the page's stored background, a library picture, a picture already on the
          // stored page, or this magazine's own page-background raster ("put the
          // original background back" on an imported PDF page).
          const url = ask.background.value!;
          let rows: LibraryRow[] = [];
          try {
            rows = await libraryRows(ctx.magazineId);
          } catch {
            rows = [];
          }
          const library = rows.filter((m) => isPlaceableMedia(m) && typeof m.url === 'string');
          const allowed = backgroundUrlAllowed(url, {
            magazineId: ctx.magazineId,
            current: ctx.originalBackground ?? ctx.page.background,
            libraryUrls: library.map((m) => m.url as string),
            pageImageUrls: ctx.original.filter((e) => e.type === 'image' && e.image?.url).map((e) => e.image!.url),
            keyOf: (u) => storage.keyFromUrl(u),
          });
          if (!allowed) return { ok: false as const, error: 'That url is not in the media library or on the page. Use list_media for a picture url.' };
          const asset = library.find((m) => m.url === url);
          const onPage = ctx.working.find((e) => e.type === 'image' && e.image?.url === url) ?? null;
          label = asset?.alt || onPage?.image?.alt || '';
        }
        // One background per page: a later change replaces one staged earlier.
        const before = ctx.proposals.length;
        ctx.proposals.splice(0, ctx.proposals.length, ...ctx.proposals.filter((p) => p.kind !== 'set-background'));
        const replaced = before - ctx.proposals.length;
        const summary = backgroundSummary(ask.background, label ? briefLabel(label, 40) : undefined);
        const staged: AgentProposal = { id: pid(ctx), kind: 'set-background', background: ask.background, summary };
        ctx.proposals.push(staged);
        // Checks and looks from here on judge the page on its new ground.
        ctx.page = { ...ctx.page, background: storedBackground(ask.background) };
        // Words that would vanish on a new flat colour, named so they can be recoloured.
        const hard: string[] = [];
        const hardLabels: string[] = [];
        for (const e of ctx.working) {
          if (e.type !== 'text' || !e.text?.content) continue;
          const c = contrastOn(e.text.color, groundColorUnder(ctx.working, e, ctx.page));
          if (c !== null && c < 3) {
            hard.push(`#${e.id} (${elLabel(e)}, ${c}:1)`);
            hardLabels.push(elLabel(e));
          }
        }
        // The tray says it too — by what the boxes are, since ids mean nothing there.
        if (hardLabels.length) {
          const names = [...new Set(hardLabels)];
          warnProposals(
            [staged],
            `On this background ${plural(hardLabels.length, 'text box', 'text boxes')} would be hard to read (${names.slice(0, 4).join(', ')}${names.length > 4 ? ', …' : ''}).`,
          );
        }
        return {
          ok: true as const,
          summary,
          ...(replaced ? { note: 'This replaces the background change staged earlier.' } : {}),
          ...(hard.length
            ? { warning: `On this background these would be hard to read: ${hard.slice(0, 5).join(', ')}${hard.length > 5 ? ` and ${hard.length - 5} more` : ''}. Recolour them with set_element_style.` }
            : {}),
        };
      },
    }),

    clear_page: tool({
      description:
        'Remove EVERY element from the open page in one call — text, photos, shapes, icons, QR codes — so it is blank ("clear this page", "remove everything", "make it blank"). Locked elements stay (say so). keepFolio: true keeps the page number and running head. The page itself and its background stay: use set_page_background (clear: true) to make the background plain white too. For removing a page entirely, that is remove_page.',
      inputSchema: z.object({ keepFolio: z.boolean().optional().describe('true = keep the page number and running head') }),
      execute: async ({ keepFolio }) => {
        if (hasLayout(ctx)) return { ok: false as const, error: LAYOUT_CLASH };
        let plan = clearPagePlan(ctx.working, { keepFolio });
        // Elements staged as NEW (this turn or an earlier message) do not exist yet:
        // taking their additions back out is the honest "remove", not a delete.
        const doomed = new Set(plan.remove.map((e) => e.id));
        const adds = ctx.proposals.filter((p) => p.kind === 'add' && p.tempId && doomed.has(p.tempId));
        let unstaged = 0;
        if (adds.length) {
          const backgrounds = ctx.proposals.filter((p) => p.kind === 'set-background');
          const r = withoutStaged(ctx.original, ctx.proposals.filter((p) => p.kind !== 'set-background'), adds.map((p) => p.id), pageDims(ctx));
          unstaged = r.removed.length + r.alsoRemoved.length;
          ctx.proposals.splice(0, ctx.proposals.length, ...r.proposals, ...backgrounds);
          ctx.working = r.working;
          plan = clearPagePlan(ctx.working, { keepFolio });
        }
        const total = plan.remove.length + adds.length;
        if (total === 0) {
          return {
            ok: true as const,
            summary: 'Nothing to remove — the page has no unlocked elements.',
            ...(plan.locked.length ? { lockedKept: plan.locked.map((e) => `#${e.id} (${elLabel(e)})`) } : {}),
          };
        }
        // Edits staged for elements that are now going are pointless: take them out.
        const going = new Set(plan.remove.map((e) => e.id));
        ctx.proposals.splice(0, ctx.proposals.length, ...ctx.proposals.filter((p) => !(p.kind === 'update' && p.elementId && going.has(p.elementId))));
        const group = `Clear the page: remove ${plural(total, 'element')}`;
        let lastDelete: AgentProposal | undefined;
        for (const e of plan.remove) {
          const r = stageDelete(ctx, e.id, `${group} (the ${elLabel(e)})`);
          if (r.ok) {
            tagLast(ctx, group);
            lastDelete = lastProposal(ctx);
          }
        }
        // Once, on the group's last change: the tray shows a member with a warning on a
        // row of its own, and one row saying it is enough.
        if (plan.locked.length) {
          warnProposals([lastDelete], `${plural(plan.locked.length, 'locked element')} will stay on the page — unlock ${plan.locked.length === 1 ? 'it' : 'them'} to remove ${plan.locked.length === 1 ? 'it' : 'them'} too.`);
        }
        return {
          ok: true as const,
          summary: group,
          removed: total,
          ...(unstaged ? { note: `${plural(adds.length, 'addition')} staged earlier ${adds.length === 1 ? 'was' : 'were'} taken back out instead.` } : {}),
          ...(plan.locked.length ? { lockedKept: plan.locked.map((e) => `#${e.id} (${elLabel(e)})`), warning: `${plural(plan.locked.length, 'locked element')} stay${plan.locked.length === 1 ? 's' : ''} — the user can unlock and delete ${plan.locked.length === 1 ? 'it' : 'them'}.` } : {}),
          ...(plan.kept.length ? { keptFolio: plan.kept.length } : {}),
          background: ctx.page.background?.type === 'color' && ctx.page.background.value.toLowerCase() !== '#ffffff'
            ? `The page background (${ctx.page.background.value}) stays — use set_page_background with clear: true if the page should be plain white.`
            : ctx.page.background?.type === 'image'
              ? 'The page background picture stays — use set_page_background with clear: true if the page should be plain white.'
              : 'The background is plain white.',
        };
      },
    }),

    set_image_fit: tool({
      description:
        'How a picture fills its box — the panel\'s Fit control: "contain" shows the WHOLE picture (charts, logos, screenshots, posters — nothing cut off), "cover" fills the box and crops the edges (photographs). focalX/focalY (0–1) choose which part a cover crop keeps (0.5, 0.5 = centre; 0.5, 0.2 = keep the top). fitBoxToImage: true resizes the box to the picture\'s own shape from its real pixel size (keeping its width, or the w / h you give), so nothing is cropped or letterboxed — e.g. a 1426x806 picture in a 640-wide box becomes 640x362.',
      inputSchema: z.object({
        elementId: z.string(),
        fit: z.enum(['contain', 'cover']).optional(),
        focalX: z.number().min(0).max(1).optional(),
        focalY: z.number().min(0).max(1).optional(),
        fitBoxToImage: z.boolean().optional(),
        w: z.number().optional().describe('with fitBoxToImage: the width to make the box (its height follows the picture)'),
        h: z.number().optional().describe('with fitBoxToImage: the height to make the box (its width follows the picture)'),
      }),
      execute: async ({ elementId, fit, focalX, focalY, fitBoxToImage, w, h }) => {
        const el = find(ctx, elementId);
        if (!el || el.type !== 'image' || !el.image) return { ok: false as const, error: `#${elementId} is not a picture on this page.` };
        if (!fit && focalX === undefined && focalY === undefined && !fitBoxToImage) {
          return { ok: false as const, error: 'Give a fit ("contain" or "cover"), a focal point, or fitBoxToImage: true.' };
        }
        const image: Record<string, unknown> = {};
        if (fit) image.fit = fit;
        if (focalX !== undefined || focalY !== undefined) {
          image.focalPoint = { x: focalX ?? el.image.focalPoint?.x ?? 0.5, y: focalY ?? el.image.focalPoint?.y ?? 0.5 };
        }
        const patch: Record<string, unknown> = {};
        let natural: NaturalSize | undefined;
        let notes: string[] = [];
        if (fitBoxToImage) {
          if (!el.image.url) return { ok: false as const, error: `#${elementId} is an empty picture box — put a picture in it first.` };
          natural = await naturalSize(el);
          if (!natural) {
            return {
              ok: false as const,
              error: 'This picture’s own pixel size is not recorded, so its exact ratio is unknown. Ask the user for the size, or give the box with move_element (w and h) — and set fit "contain" so nothing is cut off.',
            };
          }
          const sized = boxForRatio(el, natural.width / natural.height, pageDims(ctx), { w, h });
          notes = sized.notes;
          Object.assign(patch, sized.box);
          // In a box of its own shape, contain and cover show the same picture — and
          // contain is the one that can never crop it later.
          if (!fit) image.fit = 'contain';
        }
        if (Object.keys(image).length) patch.image = image;
        const name = el.image.alt ? `“${briefLabel(el.image.alt, 40)}”` : 'the picture';
        const fitWord = image.fit === 'contain' ? 'show whole' : image.fit === 'cover' ? 'fill its box' : '';
        const summary = fitBoxToImage
          ? `Fitted the box to ${name}’s own shape (${(patch as { w: number }).w}x${(patch as { h: number }).h})${fitWord ? `, set to ${fitWord}` : ''}`
          : fitWord
            ? `Set ${name} to ${fitWord}${image.focalPoint ? ' with a new focal point' : ''}`
            : `Moved the focal point of ${name}`;
        const r = stageUpdate(ctx, elementId, patch, summary);
        if (!r.ok) return r;
        const now = find(ctx, elementId)!;
        return {
          ...r,
          fit: now.image?.fit,
          ...(fitBoxToImage ? { box: { x: now.x, y: now.y, w: now.w, h: now.h }, picture: natural ? sizeLabel(natural) : undefined } : {}),
          ...(notes.length ? { note: `The box was ${notes.join(' and ')}.` } : {}),
          ...(fitBoxToImage ? { next: 'Call check_page: the new box may now overlap something below or beside it.' } : {}),
        };
      },
    }),

    set_qr_style: tool({
      description:
        'A QR code\'s colours (fg = the squares, bg = the ground, #rrggbb) and/or its link (https/mailto/tel). Colours that would stop it scanning are refused.',
      inputSchema: z.object({
        elementId: z.string(),
        fg: z.string().optional().describe('#rrggbb — the squares'),
        bg: z.string().optional().describe('#rrggbb — the ground behind them'),
        url: z.string().optional(),
      }),
      execute: async ({ elementId, fg, bg, url }) => {
        const el = find(ctx, elementId);
        if (!el || el.type !== 'qr' || !el.qr) return { ok: false as const, error: `#${elementId} is not a QR code.` };
        if (fg === undefined && bg === undefined && url === undefined) return { ok: false as const, error: 'Give fg, bg or url.' };
        const qr: Record<string, unknown> = {};
        const colour = (v: string | undefined, name: string) => {
          if (v === undefined) return { ok: true as const };
          const c = parseColor(v);
          if (!c || c.alpha < 0.999) return { ok: false as const, error: `${name} must be a solid colour (#rrggbb).` };
          qr[name] = c.hex;
          return { ok: true as const };
        };
        for (const [v, n] of [[fg, 'fg'], [bg, 'bg']] as const) {
          const r = colour(v, n);
          if (!r.ok) return r;
        }
        const check = qrColourCheck(String(qr.fg ?? el.qr.fg), String(qr.bg ?? el.qr.bg));
        if (check.error) return { ok: false as const, error: check.error };
        if (url !== undefined) {
          const safe = safeUrl(url);
          if (!safe) return { ok: false as const, error: 'Invalid URL (only http(s)/mailto/tel).' };
          qr.url = safe;
        }
        const r = stageUpdate(ctx, elementId, { qr }, qr.fg || qr.bg ? 'Recoloured the QR code' : 'Set the QR link');
        if (r.ok && check.warning) warnProposals([lastProposal(ctx)], check.warning);
        return r.ok && check.warning ? { ...r, warning: check.warning } : r;
      },
    }),

    set_icon: tool({
      description:
        'Change an icon element: its glyph (a name from the panel\'s icon set, e.g. Trophy, Horse, Calendar, MapPin, Phone, Mail, Star, Award, BarChart3) and/or its colour (#rrggbb). Unknown names are refused with the closest matches.',
      inputSchema: z.object({ elementId: z.string(), name: z.string().optional(), color: z.string().optional().describe('#rrggbb') }),
      execute: async ({ elementId, name, color }) => {
        const el = find(ctx, elementId);
        if (!el || el.type !== 'icon' || !el.icon) return { ok: false as const, error: `#${elementId} is not an icon.` };
        if (name === undefined && color === undefined) return { ok: false as const, error: 'Give a name or a color.' };
        const icon: Record<string, unknown> = {};
        let glyph = '';
        if (name !== undefined) {
          const hit = resolveIconName(name);
          if (!hit.ok) return hit;
          glyph = hit.name;
          icon.name = hit.name;
          // A glyph replaces uploaded art (which would otherwise keep winning over it).
          if (el.icon.src) icon.src = '';
        }
        if (color !== undefined) {
          const c = parseColor(color);
          if (!c || c.alpha < 0.999) return { ok: false as const, error: 'color must be a solid colour (#rrggbb).' };
          icon.color = c.hex;
        }
        const r = stageUpdate(ctx, elementId, { icon }, glyph ? `Changed the icon to ${glyph}` : 'Recoloured the icon');
        const artwork = r.ok && color !== undefined && el.icon.src && !glyph;
        const warning = 'This icon is uploaded artwork, which shows in its own colours — the colour applies only to the panel’s built-in icons.';
        if (artwork) warnProposals([lastProposal(ctx)], warning);
        return artwork ? { ...r, warning } : r;
      },
    }),

    duplicate_element: tool({
      description:
        'Make a copy of an element (text, picture, shape, QR code or icon) as a new element on top of the page — offset 20px down and right unless you give x/y (or dx/dy) — kept on the page.',
      inputSchema: z.object({
        elementId: z.string(),
        x: z.number().optional(),
        y: z.number().optional(),
        dx: z.number().optional(),
        dy: z.number().optional(),
      }),
      execute: async ({ elementId, x, y, dx, dy }) => {
        if (hasLayout(ctx)) return { ok: false as const, error: LAYOUT_CLASH };
        if (ctx.working.length >= MAX_ELEMENTS_PER_PAGE) return { ok: false as const, error: 'The page is full.' };
        const para = dropCapParagraphOf(ctx.working, elementId);
        if (para) return { ok: false as const, error: `#${para.key} is a paragraph with a drop cap drawn as several pieces — add a new text box with add_element and its words instead.` };
        const el = find(ctx, elementId);
        if (!el) return { ok: false as const, error: `No element #${elementId} on this page.` };
        const partial = duplicateOf(el, pageDims(ctx), frontZ(ctx.working), { x, y, dx, dy });
        const added = stageAdd(ctx, partial, `Duplicated the ${elLabel(el)}`);
        if (!added.ok) return added;
        return {
          ok: true as const,
          tempId: added.tempId,
          summary: `Duplicated the ${elLabel(el)} as ${added.tempId}`,
          zIndex: added.el.zIndex,
          box: { x: added.el.x, y: added.el.y, w: added.el.w, h: added.el.h },
          ...(added.el.type === 'text' ? { fit: fitOf(ctx, added.tempId) } : {}),
        };
      },
    }),

    arrange_elements: tool({
      description:
        'Lay out several boxes in ONE step — the same font size, the same height and even spacing — between a top and a bottom: e.g. six paragraphs at 20px, each 220px tall, 14px apart, starting below the subhead and not running off the page. Boxes in one column are stacked top to bottom in reading order (side-by-side columns are each stacked). fontSize becomes each text box\'s new size; height is every box\'s height (without it a text box becomes exactly as tall as its copy); gap is the space between boxes (with evenly and no gap, the boxes are spread to fill top..bottom); top defaults to just below belowElementId, else the topmost box; bottom defaults to the page bottom less the margin. Refused, with the numbers and what would fit, when they cannot fit — nothing is squeezed or pushed off the page. Reports any box whose text does not fit the height given.',
      inputSchema: z.object({
        elementIds: z.array(z.string()).min(1).max(60),
        fontSize: z.number().optional(),
        height: z.number().optional(),
        gap: z.number().optional(),
        top: z.number().optional(),
        bottom: z.number().optional(),
        evenly: z.boolean().optional(),
        x: z.number().optional().describe('one x for every box'),
        w: z.number().optional().describe('one width for every box'),
        belowElementId: z.string().optional().describe('start just below this element (e.g. the subhead)'),
      }),
      execute: async ({ elementIds, belowElementId, ...o }) => {
        if (hasLayout(ctx)) return { ok: false as const, error: LAYOUT_CLASH };
        const plan = arrangePlan(ctx.working, elementIds, pageDims(ctx), { ...o, belowId: belowElementId });
        if (!plan.ok) return plan;
        if (!plan.moves.length) return { ok: true as const, summary: 'Those boxes are already arranged that way — nothing to change.' };
        const moved: Record<string, unknown>[] = [];
        plan.moves.forEach((m, i) => {
          const el = find(ctx, m.id)!;
          const patch: Record<string, unknown> = {};
          if (m.x !== Math.round(el.x)) patch.x = m.x;
          if (m.y !== Math.round(el.y)) patch.y = m.y;
          if (m.w !== Math.round(el.w)) patch.w = m.w;
          if (m.h !== Math.round(el.h)) patch.h = m.h;
          // An asked-for size is the new ceiling (no snap-back on a later refit).
          if (m.fontSize !== undefined) patch.text = { fontSize: m.fontSize, maxFontSize: m.fontSize };
          const r = stageUpdate(ctx, m.id, patch, `${plan.summary} — the ${elLabel(el)} (${i + 1} of ${plan.moves.length})`);
          if (!r.ok) {
            moved.push({ elementId: m.id, error: r.error });
            return;
          }
          tagLast(ctx, plan.summary);
          const fit = fitOf(ctx, m.id);
          moved.push({ elementId: m.id, x: m.x, y: m.y, w: m.w, h: m.h, ...(fit && !fit.fits ? { fit } : {}) });
        });
        return {
          ok: true as const,
          summary: plan.summary,
          moved,
          columns: plan.columns,
          endsAt: plan.end,
          ...(plan.misfits.length
            ? {
                warning: `At that size the text does not fit the height in ${plural(plan.misfits.length, 'box', 'boxes')}: ${plan.misfits
                  .map((f) => `#${f.id} needs ${f.needPx ?? '?'}px of ${f.havePx ?? '?'}px${f.fitsAtPx ? ` (fits at ${f.fitsAtPx}px)` : ''}`)
                  .join('; ')}. Tell the user, and offer the size it fits at or a taller box.`,
              }
            : {}),
          next: 'Call check_page to confirm nothing now overlaps or runs off the page.',
        };
      },
    }),
  };
}
