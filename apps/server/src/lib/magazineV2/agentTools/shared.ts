// ---------------------------------------------------------------------------
// Magazine Builder v2 — what every Studio-agent tool module shares.
//
// The page agent (agent.ts) used to be one file: prompt, twenty tools and the
// turn loop. It is split by what a tool DOES — edit what is already on the page
// (editTools.ts), put something new on it (addTools.ts), change the page's or
// the magazine's structure (structureTools.ts) — so each family can grow
// without the others tripping over it. This file is the part they all lean on:
// the per-turn context, the staging helpers, the one-line element description
// both the prompt and get_page print, and the shape of a module's share of the
// SYSTEM prompt.
//
// Nothing here talks to the database or a model, which keeps it importable from
// a unit test.
// ---------------------------------------------------------------------------

import type { MagazineElement } from '../model.js';
// Type-only, so the agent.ts <-> shared.ts cycle is erased at runtime.
import type { AgentProposal } from '../agent.js';
import { applyPatch, describeElement as describeOneLine, fitReport, type FitResult } from '../agentPure.js';
import type { SizedPicture } from '../agentPanelPure.js';
import { normalizeElements } from '../writePipeline.js';

/**
 * Everything a tool needs to know about the turn it is running in. One object per
 * turn, built by runPageAgent and handed to every tool module.
 */
export interface AgentCtx {
  /** The open page AS STAGED SO FAR: tools mutate it so a multi-tool turn composes. */
  working: MagazineElement[];
  /** The changes staged this turn, in order — what the user reviews and applies. */
  proposals: AgentProposal[];
  magazineId: string;
  /** 0-based index of the open page. */
  pageIndex: number;
  /** Counter behind pid(); proposal and temp ids are unique within a turn only. */
  seq: number;
  /** Page ids this caller may READ (get_page). Route-scoped: a page-scoped
   *  collaborator's assistant sees exactly the pages their screen does.
   *  Undefined = legacy caller — get_page then refuses everything but the
   *  open page rather than guessing at visibility. */
  readable?: Set<string>;
  /**
   * The open page's canvas. width/height are what every new or moved element is
   * validated against; background is the page colour or image, which a contrast
   * check and a chart's ground need and the element list does not carry.
   */
  page: { width: number; height: number; background?: { type: string; value: string } };
  /** The issue's generation theme (genTheme), as stored. Opaque here: the modules
   *  that read it (chart colours, role typography) validate what they use. */
  theme?: unknown;
  /** The page exactly as it was loaded, before any tool ran — the "before" of a
   *  before/after comparison. Never mutated. */
  original: MagazineElement[];
  /** Epoch ms after which the turn's model call is aborted. Slow work (a render,
   *  a vision look) checks it and degrades instead of eating the rest of the turn. */
  deadline: number;
  /** How many vision looks at the page this turn has spent (they are capped). */
  looks: number;
  /**
   * How many pictures the image model has been asked for this turn (generate_image and
   * change_text_to_image). Capped per turn (MAX_IMAGES_PER_TURN): the tool calls of one
   * step run concurrently, so a model emitting ten generate_image calls at once passed
   * the time check ten times before any of them spent time — ten paid generations per
   * turn, twenty turns a minute. Optional so older callers and tests need not set it.
   */
  imagesMade?: number;
  /** The user's latest message — what a look checks the page against. */
  request?: string;
  /**
   * Ids whose text the model was shown only PART of (the element list's budget ran
   * out, or one box holds more than its cap). set_element_text replaces a box's whole
   * content, so on these it first asks for read_element: a model must not retype copy
   * it has not seen (findings C01/C47).
   */
  shownPartly?: Set<string>;
  /** Ids the model has read in full this turn (read_element). */
  readFully?: Set<string>;
  /**
   * Pictures whose own pixel size is known — media rows that record it, and images
   * attached this turn — so a picture is described with its size and "make the box the
   * image's ratio" (set_image_fit with fitBoxToImage) is exact. Optional: without it
   * the tools look the row up themselves.
   */
  imageSizes?: SizedPicture[];
  /** The page's background as loaded — what taking a staged background change back
   *  out (unstage_changes) returns the page to. */
  originalBackground?: { type: string; value: string };
}

export const find = (ctx: AgentCtx, id: string) => ctx.working.find((e) => e.id === id);
export const pid = (ctx: AgentCtx) => `p${++ctx.seq}`;

/**
 * The page size as a plain { width, height } — what normalizeElements validates a
 * new element against. Copied out rather than passing ctx.page so the write
 * pipeline is handed exactly the two numbers it always was.
 */
export const pageDims = (ctx: AgentCtx) => ({ width: ctx.page.width, height: ctx.page.height });

/**
 * A layout rebuild is EXCLUSIVE, and this is why.
 *
 * `apply-layout` replaces every element on the page with new ones carrying new ids.
 * Any element edit staged in the same turn targets an id that will not exist by the
 * time it runs — so mixing them cannot work in either order: edits first are thrown
 * away by the rebuild, edits second are applied to ghosts.
 *
 * So the tools refuse the combination instead of letting the apply loop discover it.
 * Refusing at the tool is how the rest of the agent handles impossible requests (a
 * locked element, a page-structure op a collaborator can't do): the model is told
 * why, and says so, rather than staging work that fails silently.
 *
 * A staged PDF page copy (`copy-document-page`) replaces every element just the same,
 * so it counts too. It did not when it was added, and an element edit staged after a
 * copy was applied to elements the copy had just removed.
 */
export const hasLayout = (ctx: AgentCtx) => ctx.proposals.some((p) => p.kind === 'apply-layout' || p.kind === 'copy-document-page');
export const LAYOUT_CLASH = 'This page is already staged for a layout rebuild (or a PDF page copy), which replaces every element on it. Apply that first, then ask for this change in a new message.';

/**
 * One line per element so the model can target it by id: its kind, its FULL visible
 * text (up to agentPure.ELEMENT_TEXT_MAX, marked when cut), what a picture is (alt,
 * origin, file) and its box. The page-wide list — a shared text budget, a drop-cap
 * paragraph as one line, the page check's flags — is agentPure.describePage; this is
 * the single-element form, kept for callers that print one element.
 */
export function describeElement(e: MagazineElement, selectedId?: string): string {
  return describeOneLine(e, selectedId);
}

/** Human label for a proposal summary (never the raw id): a text element's role,
 *  else its type. */
export function elLabel(e: MagazineElement): string {
  if (e.type === 'text' && e.text && e.text.role !== 'other') return e.text.role;
  return e.type;
}

/** Short plain-text preview of (possibly HTML) copy for a summary. */
export function textPreview(html: string): string {
  const t = html.replace(/<[^>]+>/g, '').trim();
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
}

/**
 * Stage an UPDATE of one element: validate it may be touched, apply the patch to the
 * working copy so later tools in the same turn see it, and queue the proposal.
 *
 * The working copy is built with the WRITE PATH's own normalizeElementPatch (through
 * agentPure.applyPatch) — exactly what the element CRUD stores when the user applies
 * the proposal: shrink-to-fit text refit from its ceiling, an asked-for size kept as
 * asked (and made the ceiling), edited PDF text turned into flowing text, the box kept
 * on the page. A one-level merge used to stand in for it, so every later tool, the
 * element list and any check saw sizes from before the refit (findings C04/C48). The
 * PROPOSAL's patch stays exactly as sent: the server normalises it again on apply,
 * against the element as it is then.
 *
 * Shared by every tool that changes an existing element, so the refusals (a layout
 * rebuild already staged, an unknown id, a locked element) read the same whichever
 * tool hit them. The result is { ok, summary } or { ok: false, error }; a tool that
 * wants the element's fit adds fitOf() to its own result.
 */
export function stageUpdate(ctx: AgentCtx, elementId: string, patch: Record<string, unknown>, summary: string) {
  if (hasLayout(ctx)) return { ok: false as const, error: LAYOUT_CLASH };
  const el = find(ctx, elementId);
  if (!el) return { ok: false as const, error: `No element #${elementId} on this page.` };
  // A locked element is refused HERE rather than staged and rejected on apply:
  // the element CRUD now 403s a locked write, so staging one would hand the user
  // a proposal that silently fails in "Apply all". Telling the model lets it say so.
  if (el.locked === true) return { ok: false as const, error: `Element #${elementId} is locked — ask the user to unlock it first.` };
  const next = applyPatch(el, patch, pageDims(ctx));
  ctx.working = ctx.working.map((e) => (e.id === elementId ? next : e));
  const proposal: AgentProposal = { id: pid(ctx), kind: 'update', elementId, patch, summary };
  ctx.proposals.push(proposal);
  if (affectsFit(patch)) noteFit(ctx, proposal, next);
  return { ok: true as const, summary };
}

// ── Warnings the tray shows next to a staged change ─────────────────────────
//
// The tool results already told the MODEL when a change leaves a problem (text that
// will not fit its box, words that vanish on a new background, locked boxes left
// under a new shape) — and the model does not always pass that on. The person
// pressing Apply never saw it. So the same facts ride on the proposal itself as
// `warning`: the Design Helper's tray shows it next to the change, and The Stable
// Hand relays it. Two sources, kept apart so one can be updated without losing the
// other: the FIT sentence (always first, always in FIT_WARNING's exact form, so it
// can be found and replaced when a later change in the turn fixes or worsens the
// fit) and whatever the tool itself warned about (appended).

/** The longest warning a proposal carries — the same cap parsePendingProposals keeps
 *  when the change is sent back, so the tray's copy does not change on a replay. */
export const MAX_WARNING_CHARS = 300;

/** The fit sentence, exactly as fitWarning writes it (and only that). */
const FIT_WARNING = /^Will not fit its box: needs \d+px, box is \d+px\.(?:\s+|$)/;

/**
 * "Will not fit its box: needs 412px, box is 300px." for a text element whose copy
 * will be cut off once the change is applied; undefined when it fits, when it is not
 * text, or when the numbers are not known (a picture, a word wider than its box).
 */
export function fitWarning(el: MagazineElement, page: { width: number; height: number }): string | undefined {
  if (el.type !== 'text' || !el.text) return undefined;
  const fit = fitReport(el, page);
  if (fit.fits || fit.needPx === undefined || fit.havePx === undefined) return undefined;
  if (fit.needPx <= fit.havePx) return undefined;
  return `Will not fit its box: needs ${Math.round(fit.needPx)}px, box is ${Math.round(fit.havePx)}px.`;
}

/** Text fields that change how text LOOKS but not how much room it needs. */
const FIT_NEUTRAL_TEXT_KEYS = new Set(['color', 'align', 'vAlign', 'role']);

/**
 * Does this patch change what decides whether text fits: its words, its type, its
 * box size? A recolour or a re-alignment does not, and must not move a fit warning
 * off the change that caused the problem.
 */
function affectsFit(patch: Record<string, unknown>): boolean {
  if (patch.w !== undefined || patch.h !== undefined) return true;
  const t = patch.text;
  if (t === undefined) return false;
  if (!t || typeof t !== 'object') return true;
  return Object.keys(t).some((k) => !FIT_NEUTRAL_TEXT_KEYS.has(k));
}

const clipWarning = (s: string) => (s.length > MAX_WARNING_CHARS ? `${s.slice(0, MAX_WARNING_CHARS - 1).trimEnd()}…` : s);

/** A proposal's warning with its fit sentence replaced (or removed, with undefined). */
function withFitSentence(warning: string | undefined, fit: string | undefined): string | undefined {
  const rest = (warning ?? '').replace(FIT_WARNING, '').trim();
  const out = [fit, rest].filter(Boolean).join(' ');
  return out ? clipWarning(out) : undefined;
}

/** Set (or clear, with undefined) the fit sentence on one proposal, keeping any tool warning. */
function setFitWarning(p: AgentProposal, fit: string | undefined): void {
  const next = withFitSentence(p.warning, fit);
  if (next) p.warning = next;
  else delete p.warning;
}

/**
 * After a change to element `el` (staged as `proposal`): the fit sentence describes
 * the element as Apply will leave it, so it lives on the LATEST change to that
 * element only. Earlier changes to it lose theirs — a later change in the turn may
 * have fixed the fit (the warning would be false) or changed the numbers.
 */
export function noteFit(ctx: AgentCtx, proposal: AgentProposal, el: MagazineElement): void {
  const id = proposal.kind === 'add' ? proposal.tempId : proposal.elementId;
  if (!id) return;
  for (const p of ctx.proposals) {
    if (p === proposal || !p.warning) continue;
    const target = p.kind === 'add' ? p.tempId : p.kind === 'update' ? p.elementId : undefined;
    if (target === id) setFitWarning(p, undefined);
  }
  setFitWarning(proposal, fitWarning(el, pageDims(ctx)));
}

/**
 * Add a tool's own warning to the proposal(s) its call staged — the ones the tray
 * shows. Appended after any fit sentence; the same words are never added twice.
 */
export function warnProposals(proposals: ReadonlyArray<AgentProposal | undefined>, warning: string | undefined): void {
  const w = (warning ?? '').trim();
  if (!w) return;
  for (const p of proposals) {
    if (!p) continue;
    if (p.warning?.includes(w)) continue;
    p.warning = clipWarning(p.warning ? `${p.warning} ${w}` : w);
  }
}

/** The last staged proposal — the one a synchronous stage call just pushed. */
export const lastProposal = (ctx: AgentCtx): AgentProposal | undefined => ctx.proposals[ctx.proposals.length - 1];

/** The `add` that created placeholder `tempId` (found by id, so a concurrent tool
 *  call staging in between cannot make this pick the wrong change). */
export const addedProposal = (ctx: AgentCtx, tempId: string): AgentProposal | undefined =>
  ctx.proposals.find((p) => p.kind === 'add' && p.tempId === tempId);

/**
 * Stage a DELETE of one element, with the same refusals as stageUpdate. delete_element
 * goes through it, and so does a tool that removes pieces as part of a bigger change
 * (a drop-cap paragraph folded into one box).
 */
export function stageDelete(ctx: AgentCtx, elementId: string, summary: string) {
  if (hasLayout(ctx)) return { ok: false as const, error: LAYOUT_CLASH };
  const el = find(ctx, elementId);
  if (!el) return { ok: false as const, error: `No element #${elementId} on this page.` };
  if (el.locked === true) return { ok: false as const, error: `Element #${elementId} is locked — ask the user to unlock it first.` };
  ctx.working = ctx.working.filter((e) => e.id !== elementId);
  ctx.proposals.push({ id: pid(ctx), kind: 'delete', elementId, summary });
  return { ok: true as const, summary };
}

/**
 * Stage a NEW element: validate it through the write pipeline (so it is clamped,
 * sanitised and refit exactly as the apply will store it), put it in the working copy
 * under a placeholder id so later tools in the turn can address it, and queue the
 * proposal. The client swaps the placeholder for the id the server gives it on Apply.
 */
export function stageAdd(
  ctx: AgentCtx,
  partial: Record<string, unknown>,
  summary: string,
  extra: Partial<Pick<AgentProposal, 'group'>> = {},
): { ok: true; tempId: string; el: MagazineElement } | { ok: false; error: string } {
  if (hasLayout(ctx)) return { ok: false, error: LAYOUT_CLASH };
  const [clean] = normalizeElements([partial], pageDims(ctx));
  if (!clean) return { ok: false, error: 'Could not build that element.' };
  const tempId = `tmp_${pid(ctx)}`;
  clean.id = tempId;
  ctx.working.push(clean);
  const proposal: AgentProposal = { id: pid(ctx), kind: 'add', tempId, element: { ...clean, id: undefined }, summary, ...extra };
  ctx.proposals.push(proposal);
  noteFit(ctx, proposal, clean);
  return { ok: true, tempId, el: clean };
}

/**
 * The fit of an element as it now stands in the working copy (pageCheck.checkElement,
 * compact): does its text fit its box, at what size, how much room there is below.
 * Every edit tool returns it, so the model learns about cut-off text in the same step
 * that caused it rather than from the user.
 */
export function fitOf(ctx: AgentCtx, elementId: string): FitResult | undefined {
  const el = find(ctx, elementId);
  return el ? fitReport(el, pageDims(ctx), ctx.working) : undefined;
}

// ── The SYSTEM prompt, split the same way as the tools ──────────────────────

/** What a module's prompt lines may depend on: the turn's capabilities, never the
 *  page's data (agent.ts prints that, once, for everyone). */
export interface PromptOpts {
  /** false when the page-structure tools are not offered this turn. */
  canEditStructure: boolean;
}

/**
 * One tool module's share of the SYSTEM prompt.
 *
 * The prompt is ONE document whose parts interleave — the Rules list names tools
 * from all three modules, and the attached-images guidance is half "place it"
 * (addTools) and half "copy its layout" (structureTools). So a module does not own
 * a contiguous chunk; it contributes lines to named SLOTS, and agent.ts places each
 * slot where it has always been, taking the modules in a fixed order (edit, add,
 * structure). That keeps the assembled prompt byte-identical to the one-file
 * version while letting each module change its own wording.
 *
 * Every slot is optional and returns plain lines (no trailing newline).
 */
export interface PromptSection {
  /**
   * Lines inside the "Rules:" list. Like the rest of the prompt's first block,
   * these pass through filter(Boolean), so an empty string is dropped, not kept
   * as a blank line.
   */
  rules?: (o: PromptOpts) => string[];
  /** Lines in the block shown only when the user attached images this turn, after
   *  the url list and the "two different things" lead-in. */
  attachedImages?: (o: PromptOpts) => string[];
  /** Lines introducing the attached source document, just before its text. */
  sourceDocument?: (o: PromptOpts) => string[];
  /**
   * A paragraph of the module's own, placed after the source document and before
   * the element list, preceded by one blank line. Nothing uses it yet; an empty
   * array adds nothing to the prompt.
   */
  extra?: (o: PromptOpts) => string[];
}
