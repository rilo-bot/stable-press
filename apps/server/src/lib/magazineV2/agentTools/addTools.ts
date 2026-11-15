// ---------------------------------------------------------------------------
// Magazine Builder v2 — Studio-agent tools that ADD something to a page.
//
// Pictures (from the media library, a stock search, or the image model), charts drawn
// from numbers, new text/shape/QR elements, and turning a text element into a photo.
// Like every agent tool they stage proposals and never write the page (see agent.ts).
//
// The rules these tools follow — where a new element sits in the stack, what type a
// new text box is set in, how a picture fills its box, where a chart goes — are pure
// and live in ../agentAddPure.ts, where they are tested. This file is the I/O around
// them: the library, the stock search, the image model and the chart renderer.
//
// Three promises every add tool keeps (audit C07/C38/C51, C55, C08/C39):
//   • a new element is VISIBLE: pictures, charts, text and QR codes go on top of the
//     stack; a new shape goes above the pictures it overlaps and below the words;
//   • new text is set in the page's own type for its role, never the app's UI font;
//   • a chart, logo or poster shows WHOLE (fit 'contain', in a box of its own shape).
// And every result says what happened in numbers the model can act on: the layer it
// landed on, whether its copy fits, and what it now covers.
// ---------------------------------------------------------------------------

import { tool } from 'ai';
import { z } from 'zod';
import { db } from '../../db.js';
import { COL } from '../collections.js';
import { safeUrl } from '../url.js';
import { normalizeElements } from '../writePipeline.js';
import { MAX_ELEMENTS_PER_PAGE, TEXT_ROLES, type MagazineElement } from '../model.js';
import { fetchAndStoreStock, isStockConfigured } from '../stock.js';
// The other half of the photo ladder: FIND one (above) or MAKE one (here).
import {
  generateImageAsset,
  IMAGE_STYLES,
  imageBriefLimit,
  isImageGenConfigured,
  nearestAspectRatio,
  orientationForBox,
  type ImageStyle,
} from '../imagegen.js';
import { isPlaceableMedia } from '../media.js';
// Charts are DRAWN from the numbers, never imagined by the image model.
import {
  applyChartChanges,
  chartChangesSchema,
  chartRequestBlocked,
  CHART_GUARD_MESSAGE,
  chartSpecSchema,
  dataEcho,
  looksLikeChartRequest,
  validateChartSpec,
} from '../chartSpec.js';
import { chartTheme } from '../chartTheme.js';
import { loadChartAsset, renderAndStoreChart } from '../charts.js';
import {
  briefLabel,
  chartLabel,
  chartValuesLine,
  CHART_TIME_NEEDED_MS,
  clampBoxToPage,
  contrastOn,
  coveredBy,
  coverWarning,
  fitReport,
  frontZ,
  generatedImagePlacement,
  groundColorUnder,
  growTextToFit,
  hasTimeFor,
  IMAGE_TIME_NEEDED_MS,
  takeImageSlot,
  imageStyleNoun,
  isGraphicMedia,
  layerForShape,
  listMediaView,
  MAX_BACKGROUND_LIFTS,
  mediaAspect,
  outOfTime,
  placementBox,
  placementFit,
  readableOn,
  resolveChartPlacement,
  STOCK_TIME_NEEDED_MS,
  styleForRole,
  themeImageLook,
  type Box,
  type MediaRowInfo,
} from '../agentAddPure.js';
import { addedProposal, elLabel, find, hasLayout, LAYOUT_CLASH, noteFit, pageDims, pid, stageUpdate, textPreview, warnProposals, type AgentCtx, type PromptSection } from './shared.js';
import { dropCapParagraphOf, dropCapPieceIds } from '../dropCapPara.js';

/** This module's lines in the SYSTEM prompt (see PromptSection for the slots). */
export const ADD_PROMPT: PromptSection = {
  rules: () => [
    '- For images, only use a URL from list_media or an image already on the page: point an EXISTING image',
    '  element at it with set_element_image, or place it as a NEW element with add_media_image. NEVER invent',
    '  image URLs. list_media shows the newest pictures first; pass a query ("logo", "chart") to find one.',
    '- To bring in a NEW picture there are two tools, and the user’s wording picks between them: add_stock_image',
    '  FINDS a real photograph (the default — "add a photo of X"), generate_image MAKES one with AI ("generate/',
    '  create/draw an image of X", or anything no photographer could have shot). If a stock search finds nothing,',
    '  offer to generate it instead. generate_image makes ANY kind of picture — pick its style: photo (default),',
    '  illustration (drawn art), graphic (a flat designed element) or poster (a poster or flyer; put the exact',
    '  words it must show in double quotes in the prompt). If it fails, tell the user its reason in plain words',
    '  and retry only when the reason says a retry can help.',
    '- CHARTS: when the user gives numbers (or the source document has a table of them) and wants a chart,',
    '  graph or table, use add_chart with the EXACT numbers — never rounded, never invented — and check the',
    '  dataEcho it returns against what the user said. update_chart changes one ("make 2023 14"), the type or',
    '  the title. NEVER use generate_image or add_stock_image for a chart, graph, table or infographic of real',
    '  data: an image model cannot plot numbers, it invents the bars and the labels.',
    '- New elements go ON TOP of the page automatically (a new shape goes above the pictures it overlaps and',
    '  below the text, as a scrim or panel should), so pick a box that does not cover words or photos you want',
    '  to keep — each add tool says what its element now covers. New text: add_element with a role (headline,',
    '  subhead, body, caption, byline, pullquote) is set in the page’s own type for that role; pass fontSize',
    '  only when the user asked for a size.',
    '- Charts, logos, infographics, posters and screenshots are placed with fit "contain" so nothing is cut',
    '  off; photographs with "cover". If a picture is cropped badly, set_element_image with fit "contain".',
    '- To turn a text element INTO a photo in the same spot, use change_text_to_image.',
    '- Pictures from a PDF attached to the magazine are lifted into the library a minute or two after it is',
    '  attached, and list_media labels each with its document and page ("from “Results.pdf”, page 2"). When the',
    '  user wants a picture that is IN their document, place that one. NEVER substitute a stock or generated',
    '  image for it; if it is not listed yet, say the PDF’s pictures are still being extracted and offer to',
    '  place it when they are (or ask them to attach the photo itself).',
  ],
  attachedImages: () => [
    '• PUT THE PICTURE ON THE PAGE ("use this photo", "add my chart", "put this in the magazine") →',
    '  add_media_image for a new element, or set_element_image to point an existing image element at it.',
    '  A chart, logo, poster or screenshot the user made goes in with fit "contain", in a box of its own shape.',
  ],
};

/** A media row as the add tools read it. */
type LibraryRow = MediaRowInfo & { _id: string; url: string };

async function libraryRows(magazineId: string): Promise<LibraryRow[]> {
  return (await db.collection(COL.media).find({ magazineId })) as unknown as LibraryRow[];
}

export function addTools(ctx: AgentCtx) {
  /**
   * Stage a NEW element: validate it through the write pipeline (so it is clamped,
   * sanitised and refit exactly as the apply will store it), put it in the working
   * copy so later tools in the turn see it, and queue the proposal.
   */
  const stageAdd = (partial: Record<string, unknown>, summary: string): { ok: true; tempId: string; el: MagazineElement } | { ok: false; error: string } => {
    const [clean] = normalizeElements([partial], pageDims(ctx));
    if (!clean) return { ok: false, error: 'Could not build that element.' };
    const tempId = `tmp_${pid(ctx)}`;
    clean.id = tempId;
    ctx.working.push(clean);
    const proposal = { id: pid(ctx), kind: 'add' as const, tempId, element: { ...clean, id: undefined }, summary };
    ctx.proposals.push(proposal);
    // A new text box whose words will not fit says so on the tray, as an edit does.
    noteFit(ctx, proposal, clean);
    return { ok: true, tempId, el: clean };
  };

  /**
   * What a new element now hides, as a warning for the tool result (or nothing). The
   * first id in `ignore` is the new element's own placeholder: the add it staged carries
   * the same fact for the tray, worded for the person rather than the model.
   */
  const coverNote = (box: Box, ignore: string[] = []) => {
    const covered = coveredBy(ctx.working, box, ctx.page, ignore);
    const w = coverWarning(covered);
    if (!w) return {};
    const names = [...new Set(covered.map((e) => elLabel(e)))];
    const tray = `It sits on top of the ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}, hiding ${covered.length === 1 ? 'it' : 'them'}.`;
    if (ignore[0]) warnProposals([addedProposal(ctx, ignore[0])], tray);
    return { warning: w };
  };

  const full = () => ctx.working.length >= MAX_ELEMENTS_PER_PAGE;

  return {
    list_media: tool({
      description:
        'List the pictures in this magazine’s media library — this page’s own first, then the NEWEST — with what each is (kind, where it came from, size, the fit it should be placed with, and whether it is a chart drawn from data). Use these urls for set_element_image / add_media_image — never invent one. Pass query to find one ("logo", "chart", "page 2").',
      inputSchema: z.object({
        query: z.string().optional().describe('Words the picture’s name or description contains, e.g. "logo" or "trophy".'),
      }),
      execute: async ({ query }) => {
        // PICTURES, as the description promises — not every row in the library. A
        // `reference` is someone else's licensed page and a `doc` is a PDF; offering
        // either here hands the model a url it will place as a photograph. See media.ts.
        // Ranked before it is cut (C43): read in storage order, a big magazine showed
        // only its 40 OLDEST pictures and the logo uploaded today was never listed.
        const view = listMediaView(await libraryRows(ctx.magazineId), ctx.pageIndex, { query });
        return {
          assets: view.assets,
          total: view.total,
          ...(query ? { matching: view.matched } : {}),
          ...(view.matched > view.assets.length ? { note: `Showing ${view.assets.length} of ${view.matched}. Pass a query to narrow the list.` } : {}),
        };
      },
    }),

    set_element_image: tool({
      description:
        'Point an image element at a url from list_media or an image already on the page (never invent a url), and/or change how it fills its box: fit "contain" shows the whole picture (charts, logos, posters, screenshots), "cover" fills the box and crops the edges (photographs). Leave url out to change only fit or alt.',
      inputSchema: z.object({
        elementId: z.string(),
        url: z.string().optional(),
        alt: z.string().optional(),
        fit: z.enum(['cover', 'contain']).optional(),
      }),
      execute: async ({ elementId, url, alt, fit }) => {
        const el = find(ctx, elementId);
        if (!el || el.type !== 'image') return { ok: false, error: 'Not an image element.' };
        const before = el.image?.alt ? `“${briefLabel(el.image.alt, 40)}”` : 'the picture';
        if (!url) {
          if (!fit && alt === undefined) return { ok: false, error: 'Give a url from list_media, or a fit / alt to change.' };
          const patch = { image: { ...(fit ? { fit } : {}), ...(alt !== undefined ? { alt } : {}) } };
          const what = fit ? (fit === 'contain' ? 'show whole' : 'fill its box') : 'have a new description';
          return { ...stageUpdate(ctx, elementId, patch, `Set ${before} to ${what}`), ...(fit ? { fit } : {}) };
        }
        // PLACEABLE rows only. The allow-list exists to stop the model inventing a
        // url; it must not become a route to the one url it is forbidden to place.
        const onPage = ctx.working.find((e) => e.type === 'image' && e.image?.url === url);
        const rows = await libraryRows(ctx.magazineId);
        const asset = rows.find((m) => isPlaceableMedia(m) && m.url === url);
        if (!asset && !onPage) return { ok: false, error: 'That url is not in the media library or on the page. Use list_media or add_stock_image.' };
        // The asset id travels with the url. Left behind, it went on naming the OLD
        // picture — and update_chart, which redraws from the asset the element names,
        // would have redrawn a chart over the photo that replaced it.
        const assetId = asset ? String(asset._id) : (onPage?.image?.assetId ?? '');
        const nextAlt = alt ?? asset?.alt ?? onPage?.image?.alt ?? '';
        // A designed picture shows whole; a photo taking the place of one (a chart, a
        // logo) goes back to filling the box instead of sitting letterboxed. Otherwise
        // the element keeps the fit it has.
        const wasGraphic = isGraphicMedia(rows.find((m) => String(m._id) === (el.image?.assetId ?? '')));
        const nextFit =
          fit ?? (asset ? (isGraphicMedia(asset) ? 'contain' : wasGraphic ? 'cover' : undefined) : onPage?.image?.fit);
        const after = nextAlt ? `“${briefLabel(nextAlt, 40)}”` : 'another picture';
        const patch = { image: { url, assetId, alt: nextAlt, ...(nextFit ? { fit: nextFit } : {}) } };
        return { ...stageUpdate(ctx, elementId, patch, `Replaced ${before} with ${after}`), ...(nextFit ? { fit: nextFit } : {}) };
      },
    }),

    add_element: tool({
      description:
        'Add a new element to the page: text, shape or qr (for a picture use add_stock_image, generate_image or add_media_image; for a chart from numbers use add_chart). Give a box in page pixels. New text is set in the page’s own type for its role. It goes on top of the page, except a shape, which sits above the pictures it overlaps and below the text (a scrim or a panel). Returns the layer and whether the text fits.',
      inputSchema: z.object({
        type: z.enum(['text', 'shape', 'qr']),
        x: z.number(), y: z.number(), w: z.number(), h: z.number(),
        content: z.string().optional().describe('text elements: the copy'),
        role: z
          .enum(TEXT_ROLES)
          .optional()
          .describe('text elements: what it is — headline, subhead, body (default), caption, byline or pullquote. It takes the page’s own font, size, weight and colour for that role.'),
        fontSize: z.number().optional().describe('text elements: a size in px, ONLY when the user asked for one. Otherwise the role’s size is used and shrunk to fit the box.'),
        color: z.string().optional().describe('text color / shape fill, hex. Text: leave out to use the page’s own colour for the role.'),
        opacity: z.number().min(0).max(1).optional().describe('shapes: 0–1; 0.35–0.6 for a see-through scrim over a photo'),
        url: z.string().optional().describe('qr destination'),
        layer: z
          .enum(['behind-text', 'front'])
          .optional()
          .describe('shapes only: behind-text (default) sits above the pictures it overlaps and below the text; front covers everything it overlaps.'),
      }),
      execute: async ({ type, x, y, w, h, content, role, fontSize, color, opacity, url, layer }) => {
        if (hasLayout(ctx)) return { ok: false, error: LAYOUT_CLASH };
        if (full()) return { ok: false, error: 'The page is full.' };
        const box = clampBoxToPage({ x, y, w, h }, ctx.page);

        if (type === 'text') {
          const r = role ?? 'body';
          const style = styleForRole(ctx.working, r, ctx.theme);
          const asked = typeof fontSize === 'number' && Number.isFinite(fontSize) && fontSize > 0 ? Math.round(fontSize * 10) / 10 : undefined;
          // The page's ink for the role, unless it would vanish on what the box stands
          // on (a dark panel, a coloured page); a colour the model chose is its own.
          const ground = groundColorUnder(ctx.working, box, ctx.page);
          const ink = color || readableOn(style.color, ground);
          const text = {
            content: (content ?? 'Text').slice(0, 8000),
            role: r,
            fontFamily: style.fontFamily,
            fontWeight: style.fontWeight,
            color: ink,
            lineHeight: style.lineHeight,
            align: style.align,
            ...(style.letterSpacing ? { letterSpacing: style.letterSpacing } : {}),
            ...(style.textTransform ? { textTransform: style.textTransform } : {}),
            // An asked-for size is the ceiling (no snap-back on a later refit); without
            // one, the role's ceiling, shrunk to the box by the write pipeline.
            fontSize: asked ?? style.maxFontSize,
            maxFontSize: asked ?? style.maxFontSize,
            minFontSize: asked ? Math.min(style.minFontSize, asked) : style.minFontSize,
            autoFit: 'shrink',
          };
          const partial: Record<string, unknown> = { type, ...box, zIndex: frontZ(ctx.working), source: 'ai-agent', text };
          // Text that does not fit at the size it should be set at gets the room below
          // it when the room is there, rather than being shrunk or cut off. "Should" is
          // the asked size; without one, whatever refit settled on (the role's floor
          // when even that overflows).
          const [probe] = normalizeElements([partial], pageDims(ctx));
          let note: string | undefined;
          if (probe?.text) {
            const target = asked ?? probe.text.fontSize;
            const atTarget = { ...probe, text: { ...probe.text, fontSize: target } };
            const grown = growTextToFit(atTarget, ctx.working, ctx.page);
            if (grown.grewBy > 0) {
              partial.h = grown.el.h;
              note = `Made the box ${grown.grewBy}px taller (into free space below) so the text fits at ${Math.round(target)}px.`;
            } else if (asked && probe.text.fontSize < asked - 0.5 && grown.needPx) {
              note = `At ${asked}px the text needs ${grown.needPx}px of height; the box is ${probe.h}px and only ${grown.freePx ?? 0}px is free below, so it is set at ${Math.round(probe.text.fontSize)}px. Make the box taller or wider, or the copy shorter, to use ${asked}px.`;
            }
          }
          const preview = textPreview(text.content);
          const added = stageAdd(partial, `Added a ${r === 'other' ? 'text' : r} box${preview ? ` “${preview}”` : ''}`);
          if (!added.ok) return added;
          const t = added.el.text!;
          const contrast = contrastOn(t.color, ground);
          return {
            ok: true,
            tempId: added.tempId,
            summary: `Added a ${r} text box (${added.tempId}) in ${t.fontFamily.split(',')[0]} ${Math.round(t.fontSize)}px${style.from === 'page' ? `, matching this page’s ${r} text` : ''}`,
            zIndex: added.el.zIndex,
            box: { x: added.el.x, y: added.el.y, w: added.el.w, h: added.el.h },
            fit: fitReport(added.el, ctx.page),
            ...(note ? { note } : {}),
            ...(contrast !== null && contrast < 3 ? { contrastWarning: `The text colour has only ${contrast}:1 contrast on what it stands on.` } : {}),
            ...coverNote(added.el, [added.tempId]),
          };
        }

        if (type === 'shape') {
          const plan = layerForShape(ctx.working, box, { page: ctx.page, opacity, layer });
          if (plan.mode === 'background' && plan.lift.length > MAX_BACKGROUND_LIFTS) {
            return {
              ok: false,
              error: `A shape covering the whole page would have to slide behind ${plan.lift.length} elements. Use a smaller panel behind the part that needs it, or layer: "front" if it really should cover everything.`,
            };
          }
          const seeThrough = typeof opacity === 'number' && opacity < 1;
          const added = stageAdd(
            { type, ...box, zIndex: plan.zIndex, source: 'ai-agent', shape: { fill: color || '#0a2342', ...(opacity !== undefined ? { opacity } : {}) } },
            plan.mode === 'background' ? 'Added a full-page background shape' : seeThrough ? 'Added a see-through shape' : 'Added a shape',
          );
          if (!added.ok) return added;
          // The words a backing shape overlaps stay in front of it.
          const kept: string[] = [];
          const stuck: string[] = [];
          for (const l of plan.lift) {
            const t = find(ctx, l.id);
            if (!t) continue;
            const r = stageUpdate(ctx, l.id, { zIndex: l.zIndex }, `Kept the ${elLabel(t)} in front of the new shape`);
            (r.ok ? kept : stuck).push(`#${l.id}`);
          }
          if (stuck.length) {
            warnProposals(
              [addedProposal(ctx, added.tempId)],
              `${stuck.length === 1 ? 'A locked element' : `${stuck.length} locked elements`} will sit under the new shape — unlock ${stuck.length === 1 ? 'it' : 'them'} to bring ${stuck.length === 1 ? 'it' : 'them'} in front.`,
            );
          }
          return {
            ok: true,
            tempId: added.tempId,
            summary: `Added a shape (${added.tempId}) at layer ${added.el.zIndex}${plan.mode === 'behind-text' ? ', above the pictures it overlaps and below the text' : plan.mode === 'background' ? ', behind everything on the page' : ''}`,
            zIndex: added.el.zIndex,
            ...(kept.length ? { raised: kept } : {}),
            ...(stuck.length ? { warning: `These are locked and now sit under the new shape: ${stuck.join(', ')}.` } : {}),
          };
        }

        // qr
        const added = stageAdd({ type, ...box, zIndex: frontZ(ctx.working), source: 'ai-agent', qr: { url: safeUrl(url ?? '') } }, 'Added a QR code');
        if (!added.ok) return added;
        return { ok: true, tempId: added.tempId, summary: `Added a QR code (${added.tempId})`, zIndex: added.el.zIndex, ...coverNote(added.el, [added.tempId]) };
      },
    }),

    add_media_image: tool({
      description:
        'Add a NEW image element from a url already in the media library (e.g. a photo, chart or logo the user uploaded) at the given box (page pixels). A chart, logo, poster or screenshot is placed whole (fit contain) in a box of its own shape; a photograph fills the box (cover). Pass fit to choose. For a brand-new stock photo use add_stock_image instead. If the user wants the page ARRANGED like the image rather than the image ON the page, use use_image_as_layout.',
      inputSchema: z.object({
        url: z.string(),
        x: z.number(), y: z.number(), w: z.number(), h: z.number(),
        alt: z.string().optional(),
        fit: z.enum(['cover', 'contain']).optional().describe('contain shows the whole picture; cover fills the box and crops. Default: contain for charts, logos and designed pictures, cover for photos.'),
      }),
      execute: async ({ url, x, y, w, h, alt, fit }) => {
        if (hasLayout(ctx)) return { ok: false, error: LAYOUT_CLASH };
        if (full()) return { ok: false, error: 'The page is full.' };
        // Same allow-list as set_element_image: the media library + images already
        // on the page. The model can never introduce an arbitrary/invented URL.
        // Placeable rows only — same reason as set_element_image above.
        const asset = (await libraryRows(ctx.magazineId)).find((m) => isPlaceableMedia(m) && m.url === url);
        const onPage = ctx.working.find((e) => e.type === 'image' && e.image?.url === url);
        if (!asset && !onPage) return { ok: false, error: 'That url is not in the media library or on the page. Use list_media or add_stock_image.' };
        // A chart or logo shows whole, in a box of its own shape when its size is known
        // (C08/C39: 'cover' in a guessed box cut off axis labels, legends, logo ends).
        const chosenFit = asset ? placementFit(asset, fit) : (fit ?? onPage?.image?.fit ?? 'cover');
        const box = placementBox({ x, y, w, h }, ctx.page, chosenFit, asset ? mediaAspect(asset) : undefined);
        const label = alt ?? asset?.alt ?? onPage?.image?.alt ?? '';
        const added = stageAdd(
          {
            type: 'image',
            ...box,
            zIndex: frontZ(ctx.working),
            source: 'ai-agent',
            image: { url, assetId: asset ? String(asset._id) : (onPage?.image?.assetId ?? ''), alt: label, fit: chosenFit },
          },
          `Added ${label ? `“${briefLabel(label, 40)}”` : 'an image'} from the media library`,
        );
        if (!added.ok) return { ok: false, error: 'Could not place the image.' };
        return {
          ok: true,
          tempId: added.tempId,
          summary: 'Added the image from the media library',
          zIndex: added.el.zIndex,
          fit: chosenFit,
          box: { x: added.el.x, y: added.el.y, w: added.el.w, h: added.el.h },
          ...(box.w !== Math.round(w) || box.h !== Math.round(h) ? { note: 'The box was fitted to the picture’s own shape so it shows whole.' } : {}),
          ...coverNote(added.el, [added.tempId]),
        };
      },
    }),

    add_stock_image: tool({
      description:
        'FIND a real stock photograph for a query and add it as an image element at the given box (page pixels). The default way to put a photo on a page. Asked again ("another one"), it finds a photo this magazine does not already use. To MAKE a picture that does not exist (an illustration, a poster, a scene no photographer shot), use generate_image; for a chart, add_chart.',
      inputSchema: z.object({ query: z.string(), x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
      execute: async ({ query, x, y, w, h }) => {
        if (hasLayout(ctx)) return { ok: false, error: LAYOUT_CLASH };
        if (!isStockConfigured()) {
          // Name the other door, so a server with only the image model configured
          // still gets a picture instead of the model giving up here.
          return {
            ok: false,
            error: isImageGenConfigured()
              ? 'Stock photo search is not configured on this server — use generate_image instead.'
              : 'Stock photos are not configured on this server.',
          };
        }
        if (full()) return { ok: false, error: 'The page is full.' };
        if (!hasTimeFor(ctx.deadline, STOCK_TIME_NEEDED_MS, Date.now())) return { ok: false, error: outOfTime('find a photo') };
        const box = clampBoxToPage({ x, y, w, h }, ctx.page);
        const orientation = orientationForBox(box.w, box.h);
        // avoidUsed (C46): the first result this magazine does not already hold, so
        // "find another one" really finds another — and a repeat never stores a copy.
        const stored = await fetchAndStoreStock({ query, orientation, avoidUsed: true }, { magazineId: ctx.magazineId, pageIndex: ctx.pageIndex });
        if (!stored) {
          return {
            ok: false,
            error: isImageGenConfigured()
              ? `No stock photo found for "${query}". Try generate_image with the same subject, or a simpler query.`
              : `No photo found for "${query}". Try a simpler query — a few concrete nouns.`,
          };
        }
        if (stored.allUsed) {
          return {
            ok: false,
            error: `Every stock result for "${query}" is already in this magazine, so this would repeat a photo. For a different picture, try a different, more specific query${isImageGenConfigured() ? ' or generate_image' : ''}. To reuse the best match anyway, place ${stored.url} with add_media_image.`,
          };
        }
        const added = stageAdd(
          { type: 'image', ...box, zIndex: frontZ(ctx.working), source: 'ai-agent', image: { url: stored.url, assetId: stored.assetId, alt: stored.alt, fit: 'cover' } },
          `Added a photo for "${query}"`,
        );
        if (!added.ok) return { ok: false, error: 'Could not place the photo.' };
        return {
          ok: true,
          tempId: added.tempId,
          summary: `Sourced and added a photo for "${query}"`,
          alt: stored.alt,
          zIndex: added.el.zIndex,
          ...coverNote(added.el, [added.tempId]),
        };
      },
    }),

    // MAKE a picture, rather than find one. Deliberately a separate tool from
    // add_stock_image rather than a mode on it: the two answer different asks
    // ("a photo of a farrier" vs "an illustration of our five-step process"),
    // and giving the model one tool with a flag makes the choice invisible in
    // the proposal the user is asked to approve.
    //
    // ONE "make an image" capability for any picture (2026-11-15): the style says what
    // kind — a photo, an illustration, a graphic, a poster with the user's words on it.
    // Charts are not pictures: they are refused here and drawn by add_chart.
    generate_image: tool({
      description:
        'GENERATE a new picture with AI from a description and add it as an image element at the given box (page pixels). style: photo (default — a photograph of something no photographer shot), illustration (drawn editorial art), graphic (a flat, simple designed element) or poster (a poster or flyer; it may show the words the user asked for — put them in double quotes in the prompt). The picture is made in the box’s own shape. Use it when the user asks to generate/create/make/draw a picture, or when add_stock_image found nothing; for an ordinary photograph of a real subject prefer add_stock_image — a real photo beats a rendered one. NEVER for charts, graphs, tables or anything that must show real numbers — use add_chart. A photo contains no text; no picture shows identifiable real people.',
      inputSchema: z.object({
        prompt: z.string().describe('What to make: subject, setting, mood, lighting. For a poster or graphic also the layout, and the exact words in double quotes.'),
        x: z.number(),
        y: z.number(),
        w: z.number(),
        h: z.number(),
        style: z.enum(IMAGE_STYLES).optional().describe('photo (default), illustration, graphic or poster.'),
        decorative: z
          .boolean()
          .optional()
          .describe('true only for a purely decorative illustration that shows no real data (e.g. abstract rising shapes). Never for a chart of real numbers.'),
      }),
      execute: async ({ prompt, x, y, w, h, style, decorative }) => {
        if (hasLayout(ctx)) return { ok: false, error: LAYOUT_CLASH };
        const kind: ImageStyle = style ?? 'photo';
        // A chart is DRAWN from its numbers (add_chart). Refused before anything else —
        // before the configuration check too — so the model is pointed at the right
        // tool even on a server with no image model, rather than at a dead end.
        if (chartRequestBlocked(prompt, { style: kind, decorative })) return { ok: false, reason: 'chart', error: CHART_GUARD_MESSAGE };
        if (!isImageGenConfigured()) {
          return {
            ok: false,
            reason: 'unavailable',
            error: isStockConfigured()
              ? 'AI image generation is not configured on this server — use add_stock_image to find a real photo instead.'
              : 'AI image generation is not configured on this server.',
          };
        }
        if (full()) return { ok: false, error: 'The page is full.' };
        const brief = prompt.trim().slice(0, imageBriefLimit(kind));
        if (!brief) return { ok: false, error: 'Describe what to generate.' };
        // The image model can take most of a minute. Started with too little of the
        // turn left, the turn ends in "I ran into a hiccup" and the picture is orphaned.
        if (!hasTimeFor(ctx.deadline, IMAGE_TIME_NEEDED_MS, Date.now())) return { ok: false, reason: 'timeout', error: outOfTime('make a picture') };
        // The per-turn cap, taken with no await since the check above (takeImageSlot).
        const slot = takeImageSlot(ctx);
        if (!slot.ok) return slot;
        // Made for the box it lands in (C40): the box is settled first, then the
        // picture is asked for at the supported ratio nearest that box.
        const place = generatedImagePlacement(kind, clampBoxToPage({ x, y, w, h }, ctx.page));
        const look = themeImageLook(ctx.theme);
        const made = await generateImageAsset(
          {
            prompt: brief,
            aspectRatio: place.aspectRatio,
            style: kind,
            ...(kind === 'photo' && look.photoStyle ? { photoStyle: look.photoStyle } : {}),
            ...(kind !== 'photo' && look.colors ? { colors: look.colors } : {}),
            ...(decorative === true ? { decorative: true } : {}),
          },
          { magazineId: ctx.magazineId, pageIndex: ctx.pageIndex },
        );
        // The REASON, not "try again" (C42): a refusal needs another subject, an empty
        // account or a rate limit needs the user told — the message says which.
        if (!made.ok) return { ok: false, reason: made.reason, error: made.message };
        // The summary says GENERATED, in the user's own words, because this is the
        // line they read before approving — "added a photo" would misdescribe it.
        const label = briefLabel(brief);
        const noun = imageStyleNoun(kind);
        const added = stageAdd(
          { type: 'image', ...place.box, zIndex: frontZ(ctx.working), source: 'ai-agent', image: { url: made.url, assetId: made.assetId, alt: made.alt, fit: place.fit } },
          `Generated ${noun}: “${label}”`,
        );
        if (!added.ok) return { ok: false, error: 'Could not place the image.' };
        return {
          ok: true,
          tempId: added.tempId,
          summary: `Generated and added ${noun} for “${label}”`,
          style: kind,
          aspectRatio: place.aspectRatio,
          fit: place.fit,
          zIndex: added.el.zIndex,
          box: { x: added.el.x, y: added.el.y, w: added.el.w, h: added.el.h },
          ...coverNote(added.el, [added.tempId]),
        };
      },
    }),

    // Draw a chart from numbers: spec → SVG → PNG on the shared Chromium → a media row
    // that keeps the numbers (charts.ts). Never the image model, which can only invent
    // bars and labels (audit C02/C16/C36/C37/C52).
    add_chart: tool({
      description:
        'DRAW a chart or table from numbers and put it on the page: bar (columns — years, months, a few short labels), barh (horizontal bars — long labels such as horse or owner names, rankings), line (a trend), pie or donut (shares of one whole, at most 8), or table. Use the EXACT numbers the user gave or the source document has; never round or invent them. It is drawn in the magazine’s colours and fonts at the box’s own shape and shown whole (fit contain), on top of the page. Leave x, y, w, h out to let it find free space (or fill an empty picture box); pass replaceElementId to put it where an element is (e.g. a photo). Returns dataEcho — every value as drawn: check it against what the user said.',
      inputSchema: chartSpecSchema.extend({
        x: z.number().optional(),
        y: z.number().optional(),
        w: z.number().optional(),
        h: z.number().optional(),
        replaceElementId: z.string().optional().describe('Put the chart in place of this element (a picture is replaced in place; any other element is removed and the chart takes its box).'),
      }),
      execute: async (input) => {
        if (hasLayout(ctx)) return { ok: false, error: LAYOUT_CLASH };
        const { x, y, w, h, replaceElementId, ...raw } = input;
        const checked = validateChartSpec(raw);
        if (!checked.ok) return { ok: false, error: checked.error };
        const spec = checked.spec;
        const place = resolveChartPlacement(spec, { x, y, w, h, replaceElementId }, ctx.working, ctx.page);
        if (!place.ok) return { ok: false, error: place.error };
        if (place.mode !== 'fill' && full()) return { ok: false, error: 'The page is full.' };
        if (!hasTimeFor(ctx.deadline, CHART_TIME_NEEDED_MS, Date.now())) return { ok: false, error: outOfTime('draw the chart') };

        const theme = chartTheme(ctx.theme, ctx.working, { background: ctx.page.background });
        const drawn = await renderAndStoreChart(spec, theme, { w: place.box.w, h: place.box.h }, { magazineId: ctx.magazineId, pageIndex: ctx.pageIndex });
        if (!drawn.ok) return { ok: false, error: drawn.error };
        const image = { url: drawn.url, assetId: drawn.assetId, alt: drawn.alt, fit: 'contain' as const };
        const what = chartLabel(spec);
        const values = chartValuesLine(spec);

        if (place.mode === 'fill') {
          const target = place.target;
          const wasEmpty = !(target.image?.url ?? '').trim();
          const summary = wasEmpty
            ? `Added ${what} in the empty picture box: ${values}`
            : `Replaced ${target.image?.alt ? `“${briefLabel(target.image.alt, 40)}”` : 'the picture'} with ${what}: ${values}`;
          const r = stageUpdate(ctx, target.id, { image }, summary);
          if (!r.ok) return r;
          const now = find(ctx, target.id) ?? target;
          return { ok: true, elementId: target.id, summary, dataEcho: drawn.dataEcho, box: place.box, fit: fitReport(now, ctx.page) };
        }

        if (place.mode === 'swap') {
          // Build the chart element BEFORE staging the delete, so either both are
          // staged or neither is (the same rule as change_text_to_image).
          const target = place.target;
          const [clean] = normalizeElements(
            [{ type: 'image', ...place.box, zIndex: target.zIndex, rotation: target.rotation, source: 'ai-agent', image }],
            pageDims(ctx),
          );
          if (!clean) return { ok: false, error: 'Could not place the chart.' };
          ctx.working = ctx.working.filter((e) => e.id !== target.id);
          ctx.proposals.push({ id: pid(ctx), kind: 'delete', elementId: target.id, summary: `Removed the ${elLabel(target)} to make room for the chart` });
          const tempId = `tmp_${pid(ctx)}`;
          clean.id = tempId;
          ctx.working.push(clean);
          const summary = `Added ${what} in place of the ${elLabel(target)}: ${values}`;
          ctx.proposals.push({ id: pid(ctx), kind: 'add', tempId, element: { ...clean, id: undefined }, summary });
          return { ok: true, tempId, summary, dataEcho: drawn.dataEcho, zIndex: clean.zIndex, box: place.box, fit: fitReport(clean, ctx.page) };
        }

        const summary = `Added ${what}: ${values}`;
        const added = stageAdd({ type: 'image', ...place.box, zIndex: frontZ(ctx.working), source: 'ai-agent', image }, summary);
        if (!added.ok) return { ok: false, error: 'Could not place the chart.' };
        return {
          ok: true,
          tempId: added.tempId,
          summary,
          dataEcho: drawn.dataEcho,
          zIndex: added.el.zIndex,
          box: { x: added.el.x, y: added.el.y, w: added.el.w, h: added.el.h },
          fit: fitReport(added.el, ctx.page),
          ...coverNote(added.el, [added.tempId]),
        };
      },
    }),

    update_chart: tool({
      description:
        'CHANGE a chart that add_chart drew, from its stored numbers: one value ("make 2023 14" → setValues), the type ("make it a line chart"), the title or source line, or the whole data. Redrawn in the same box. For a picture that is not a drawn chart, use add_chart with replaceElementId.',
      inputSchema: z.object({
        elementId: z.string(),
        changes: chartChangesSchema.describe('Only what changes. setValues changes single numbers; any other field replaces the stored one (an empty title, subtitle or source removes it).'),
      }),
      execute: async ({ elementId, changes }) => {
        if (hasLayout(ctx)) return { ok: false, error: LAYOUT_CLASH };
        const el = find(ctx, elementId);
        if (!el || el.type !== 'image') return { ok: false, error: 'Not an image element — a chart is an image element drawn by add_chart.' };
        if (el.locked === true) return { ok: false, error: `Element #${elementId} is locked — ask the user to unlock it first.` };
        // The numbers live on the media row the element names (charts.ts), never in the
        // picture: a chart is redrawn from what was drawn, not read back off pixels.
        const stored = el.image?.assetId ? await loadChartAsset(el.image.assetId, ctx.magazineId) : null;
        if (!stored) {
          return {
            ok: false,
            error: `That picture is not a chart drawn from data, so it has no stored numbers to change. To draw one from the numbers, use add_chart with replaceElementId: "${elementId}".`,
          };
        }
        const next = applyChartChanges(stored.spec, changes);
        if (!next.ok) return { ok: false, error: next.error };
        if (!hasTimeFor(ctx.deadline, CHART_TIME_NEEDED_MS, Date.now())) return { ok: false, error: outOfTime('redraw the chart') };
        const theme = chartTheme(ctx.theme, ctx.working, { background: ctx.page.background });
        // Redrawn at the element's CURRENT box, which the user may have resized since.
        const drawn = await renderAndStoreChart(next.spec, theme, { w: el.w, h: el.h }, { magazineId: ctx.magazineId, pageIndex: ctx.pageIndex });
        if (!drawn.ok) return { ok: false, error: drawn.error };
        const summary = `Redrew ${chartLabel(next.spec)}: ${chartValuesLine(next.spec)}`;
        const r = stageUpdate(ctx, elementId, { image: { url: drawn.url, assetId: drawn.assetId, alt: drawn.alt, fit: 'contain' } }, summary);
        if (!r.ok) return r;
        return { ok: true, elementId, summary, dataEcho: drawn.dataEcho, before: dataEcho(stored.spec) };
      },
    }),

    // Type-swap: replace a TEXT element with a real photo in the SAME box. Staged
    // as a delete (of the text) + add (of the image), so it rides the existing
    // element-CRUD apply path — no special client routing needed.
    change_text_to_image: tool({
      description:
        'Replace a TEXT element with a photo in the same position and layer (sources a real stock photo for `query`, or generates one when stock has none). For a chart in its place use add_chart with replaceElementId.',
      inputSchema: z.object({ elementId: z.string(), query: z.string() }),
      execute: async ({ elementId, query }) => {
        if (hasLayout(ctx)) return { ok: false, error: LAYOUT_CLASH };
        // A paragraph set with a drop cap is drawn as two or three pieces (cap, lead,
        // rest). Replacing ONE of them left the others standing — a stray giant letter
        // or half a paragraph next to the photo — so the photo replaces the whole
        // paragraph: every piece goes, and the photo takes the paragraph's rectangle.
        // The paragraph's key (as read_element names it) is accepted too.
        const para = dropCapParagraphOf(ctx.working, elementId);
        const pieces = para
          ? dropCapPieceIds(para).map((id) => find(ctx, id)).filter((e): e is MagazineElement => !!e)
          : [find(ctx, elementId)].filter((e): e is MagazineElement => !!e);
        const el = pieces[0];
        if (!el || el.type !== 'text') return { ok: false, error: 'Not a text element.' };
        const locked = pieces.find((p) => p.locked === true);
        if (locked) {
          return { ok: false, error: `Element #${locked.id}${para ? ` (part of the paragraph #${para.key})` : ''} is locked — ask the user to unlock it first.` };
        }
        if (looksLikeChartRequest(query)) {
          return { ok: false, error: `A chart is drawn from its numbers: use add_chart with replaceElementId "${elementId}" and the exact values.` };
        }
        if (!isStockConfigured() && !isImageGenConfigured()) return { ok: false, error: 'Photos are not configured on this server.' };
        const box = clampBoxToPage(para ? para.box : el, ctx.page);
        // The highest piece's layer: the photo stays where the words were visible.
        const layer = Math.max(...pieces.map((p) => (Number.isFinite(p.zIndex) ? p.zIndex : 0)));
        const orientation = orientationForBox(box.w, box.h);
        // Same ladder as automatic generation: FIND a real photograph first, MAKE
        // one only if the search comes back empty. This tool takes a box that is
        // already on the page, so "no photo" would leave the user staring at the
        // text they asked to replace.
        let stored: { url: string; assetId: string; alt: string } | null = null;
        let reused = false;
        if (isStockConfigured()) {
          const found = await fetchAndStoreStock({ query, orientation, avoidUsed: true }, { magazineId: ctx.magazineId, pageIndex: ctx.pageIndex });
          if (found && !found.allUsed) stored = found;
          else if (found?.allUsed && !isImageGenConfigured()) {
            // Nothing new to find and nothing to make: the magazine's own copy of the
            // best match is better than leaving the text there — and says so.
            stored = found;
            reused = true;
          }
        }
        let failure: { reason: string; message: string } | null = null;
        if (!stored && isImageGenConfigured()) {
          if (!hasTimeFor(ctx.deadline, IMAGE_TIME_NEEDED_MS, Date.now())) return { ok: false, reason: 'timeout', error: outOfTime('make a picture') };
          // The per-turn cap, taken with no await since the check above (takeImageSlot).
          const slot = takeImageSlot(ctx);
          if (!slot.ok) return slot;
          const look = themeImageLook(ctx.theme);
          const made = await generateImageAsset(
            { prompt: query, aspectRatio: nearestAspectRatio(box.w, box.h), style: 'photo', ...(look.photoStyle ? { photoStyle: look.photoStyle } : {}) },
            { magazineId: ctx.magazineId, pageIndex: ctx.pageIndex },
          );
          if (made.ok) stored = made;
          else failure = { reason: made.reason, message: made.message };
        }
        if (!stored) {
          return failure
            ? { ok: false, reason: failure.reason, error: `No new stock photo for "${query}", and generating one failed. ${failure.message}` }
            : { ok: false, error: 'No photo found for that query.' };
        }
        // Build the REPLACEMENT before staging the delete. The delete used to be
        // pushed (and ctx.working mutated) first, so a normalizeElements miss here
        // returned an error with the delete already staged — applying that turn
        // removed the user's text and put nothing in its place. Either both
        // proposals are staged or neither is.
        //
        // The photo takes the text's LAYER and rotation: at zIndex 0 a photo replacing
        // text that sat on a panel went behind the panel and vanished (C07).
        const [clean] = normalizeElements(
          [{ type: 'image', ...box, zIndex: layer, rotation: el.rotation, source: 'ai-agent', image: { url: stored.url, assetId: stored.assetId, alt: stored.alt, fit: 'cover' } }],
          pageDims(ctx),
        );
        if (!clean) return { ok: false, error: 'Could not place the photo.' };
        const gone = new Set(pieces.map((p) => p.id));
        ctx.working = ctx.working.filter((e) => !gone.has(e.id));
        for (const p of pieces) {
          ctx.proposals.push({
            id: pid(ctx),
            kind: 'delete',
            elementId: p.id,
            summary: para ? (p === el ? `Removed the paragraph #${para.key} (with its drop cap)` : `Removed the paragraph #${para.key} (drop-cap piece)`) : `Removed the ${elLabel(el)} text`,
          });
        }
        const tempId = `tmp_${pid(ctx)}`;
        clean.id = tempId;
        ctx.working.push(clean);
        ctx.proposals.push({ id: pid(ctx), kind: 'add', tempId, element: { ...clean, id: undefined }, summary: `Replaced text with a photo for "${query}"` });
        return {
          ok: true,
          tempId,
          summary: `Staged: replace the text with a photo for "${query}"`,
          alt: stored.alt,
          zIndex: clean.zIndex,
          ...(reused ? { note: 'Every stock result for that query is already in this magazine, so this reuses the best match.' } : {}),
        };
      },
    }),
  };
}
