// ---------------------------------------------------------------------------
// Magazine Builder v2 — the pure half of the Design Helper's staged changes.
//
// Everything here decides; nothing here writes. The store (store.ts) and the panel
// (AiPanel.tsx) do the network and the toasts, and call these to work out WHAT to
// do — which is the part that went wrong:
//
//   • a second chat turn replaced the first turn's staged changes with its own,
//     silently (mergeTurnProposals);
//   • "delete pages 3 and 4" deleted 3 and 5, because each delete re-numbered the
//     magazine before the next one was resolved (planPageSteps / insertIndexFor);
//   • a page deletion was applied on a bare click under a toast promising undo
//     (removalQuestion / appliedMessage).
//
// Kept free of the store, the API client and React so it runs under `tsx --test`.
// ---------------------------------------------------------------------------

import type { AgentProposal, MagazineElement, PageCheck, PageCheckIssue } from './model';

type Kind = AgentProposal['kind'];

/** Proposals that replace a WHOLE page. Each is applied on its own: an element edit
 *  staged alongside would land on elements the rebuild has just destroyed. */
const EXCLUSIVE: ReadonlySet<Kind> = new Set<Kind>(['apply-layout', 'copy-document-page']);
/** Proposals that change which pages exist or their order (the page CRUD). */
const PAGE_KINDS: ReadonlySet<Kind> = new Set<Kind>(['add-page', 'remove-page', 'reorder-page', 'generate-pages']);

export const isExclusiveKind = (k: Kind): boolean => EXCLUSIVE.has(k);
export const isPageKind = (k: Kind): boolean => PAGE_KINDS.has(k);

// ── Merging a new turn into what is already staged ──────────────────────────

/**
 * What a turn did to the tray.
 *
 *  fresh     nothing was staged before; the tray is this turn's list.
 *  server    the server replayed the earlier changes and returned the combined set.
 *  kept      the turn staged nothing, so the earlier changes stay as they were.
 *  appended  an older server built the turn without the earlier changes, so the new
 *            ones are added after them (an earlier edit a newer one fully overrides
 *            is dropped, since it could only ever be overwritten).
 *  replaced  the earlier changes could not be kept alongside the new ones (a page
 *            rebuild on either side, or they were for another page). `dropped` says
 *            how many went, so the caller can SAY so instead of losing them quietly.
 */
export type TurnMergeMode = 'fresh' | 'server' | 'kept' | 'appended' | 'replaced';

export interface TurnMerge {
  proposals: AgentProposal[];
  /** The page the tray now belongs to (null when it is empty). */
  pageId: string | null;
  mode: TurnMergeMode;
  /** How many earlier staged changes were thrown away. */
  dropped: number;
  /** The page those dropped changes were for. */
  droppedPageId: string | null;
}

/** "Is this the same staged change?" — what the server echoes back when it replays. */
export const sameChangeKey = (p: AgentProposal): string =>
  [p.id, p.kind, p.elementId ?? '', p.tempId ?? '', p.pageId ?? '', p.summary].join('\u0001');

/**
 * Take out of a reply the waiting changes that are no longer waiting.
 *
 * A turn is sent the tray's changes and the server hands them back with its own. If
 * they were applied (or discarded) while the turn ran, putting them back in the tray
 * would offer to apply them TWICE — two copies of an added photo. Anything the turn
 * was sent that is not in the tray any more is dropped from its reply.
 */
export function withoutSettled(reply: AgentProposal[], sent: AgentProposal[], waitingNow: AgentProposal[]): AgentProposal[] {
  if (sent.length === 0) return reply;
  const waiting = new Set(waitingNow.map(sameChangeKey));
  const settled = new Set(sent.map(sameChangeKey).filter((k) => !waiting.has(k)));
  return settled.size === 0 ? reply : reply.filter((p) => !settled.has(sameChangeKey(p)));
}

/**
 * The paths an update writes, one level into the element's sub-objects: a patch of
 * `{ text: { content } }` writes 'text.content', and so does not override a patch of
 * `{ text: { color } }` (the store merges sub-objects one level deep, so both land).
 */
export function patchPaths(patch: Partial<MagazineElement> | undefined): string[] {
  if (!patch) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && (k === 'text' || k === 'image' || k === 'shape' || k === 'qr' || k === 'icon')) {
      const subs = Object.keys(v as Record<string, unknown>);
      if (subs.length === 0) out.push(k);
      else for (const s of subs) out.push(`${k}.${s}`);
    } else {
      out.push(k);
    }
  }
  return out;
}

/** An earlier change that a later one makes pointless: the same element deleted, or
 *  every path it writes written again. Applying it would only be overwritten. */
function supersededBy(old: AgentProposal, later: AgentProposal[]): boolean {
  if (old.kind !== 'update' || !old.elementId) return false;
  const mine = patchPaths(old.patch);
  return later.some((n) => {
    if (n.elementId !== old.elementId) return false;
    if (n.kind === 'delete') return true;
    if (n.kind !== 'update') return false;
    const theirs = new Set(patchPaths(n.patch));
    return mine.length > 0 && mine.every((path) => theirs.has(path));
  });
}

/**
 * Give one turn's proposals ids no earlier turn used.
 *
 * Each server turn numbers from p1 again, and add placeholders are `tmp_p3`. Two turns
 * side by side would share ids — React keys collide and, worse, the apply's
 * placeholder map would send the second turn's update to the first turn's new box.
 * Every id and placeholder of THIS turn gets the turn's tag, and its own references to
 * its placeholders are rewritten to match. References to anything else are left alone.
 */
export function tagTurn(list: AgentProposal[], tag: string): AgentProposal[] {
  const renamed = new Map<string, string>();
  for (const p of list) if (p.tempId) renamed.set(p.tempId, `${tag}-${p.tempId}`);
  return list.map((p) => ({
    ...p,
    id: `${tag}-${p.id}`,
    ...(p.tempId ? { tempId: renamed.get(p.tempId)! } : {}),
    ...(p.elementId && renamed.has(p.elementId) ? { elementId: renamed.get(p.elementId)! } : {}),
  }));
}

/** Make proposal ids unique within one list (the tray keys on them). Only later
 *  duplicates are renamed; placeholders are never touched here. */
export function uniqueIds(list: AgentProposal[], tag: string): AgentProposal[] {
  const seen = new Set<string>();
  return list.map((p, i) => {
    if (!seen.has(p.id)) {
      seen.add(p.id);
      return p;
    }
    const id = `${tag}-${i}-${p.id}`;
    seen.add(id);
    return { ...p, id };
  });
}

/**
 * Combine a new turn's proposals with the ones already waiting.
 *
 * The real fix is on the server: the turn is sent the waiting changes, replays them
 * onto its working copy, and returns the combined list (`serverMerged`, or recognised
 * because the earlier changes come back unchanged). Everything else here is the
 * fallback for a server that does not replay yet — so the second message of a chat
 * never again empties the tray without a word.
 */
export function mergeTurnProposals(input: {
  prev: AgentProposal[];
  prevPageId: string | null;
  next: AgentProposal[];
  forPageId: string;
  /** The server's own statement that it replayed the earlier changes. */
  serverMerged?: boolean;
  /** Unique per turn — prefixes this turn's ids when they are appended. */
  turnTag: string;
}): TurnMerge {
  const { prev, prevPageId, next, forPageId, turnTag } = input;
  const nextPage = next.length > 0 ? forPageId : null;
  if (prev.length === 0 || !prevPageId) {
    return { proposals: next, pageId: nextPage, mode: 'fresh', dropped: 0, droppedPageId: null };
  }
  // Waiting changes for ANOTHER page. A turn that stages nothing leaves them alone
  // (they still show when the user goes back there); one that stages something takes
  // the tray — there is one tray — and the caller says what was dropped.
  if (prevPageId !== forPageId) {
    if (next.length === 0) return { proposals: prev, pageId: prevPageId, mode: 'kept', dropped: 0, droppedPageId: null };
    return { proposals: next, pageId: forPageId, mode: 'replaced', dropped: prev.length, droppedPageId: prevPageId };
  }
  const prevKeys = new Set(prev.map(sameChangeKey));
  const echoed = input.serverMerged === true || (input.serverMerged !== false && next.some((p) => prevKeys.has(sameChangeKey(p))));
  if (echoed) {
    // The server's list IS the tray now — including any earlier change it decided to
    // drop (its element is gone, or the user asked to drop it).
    return { proposals: uniqueIds(next, turnTag), pageId: nextPage, mode: 'server', dropped: 0, droppedPageId: null };
  }
  if (next.length === 0) return { proposals: prev, pageId: prevPageId, mode: 'kept', dropped: 0, droppedPageId: null };
  // A page rebuild cannot share the tray with anything (see EXCLUSIVE), whichever
  // side it is on. The newer request wins; the caller reports the loss.
  if (prev.some((p) => isExclusiveKind(p.kind)) || next.some((p) => isExclusiveKind(p.kind))) {
    return { proposals: next, pageId: forPageId, mode: 'replaced', dropped: prev.length, droppedPageId: forPageId };
  }
  const tagged = tagTurn(next, turnTag);
  const kept = prev.filter((p) => !supersededBy(p, tagged));
  return { proposals: [...kept, ...tagged], pageId: forPageId, mode: 'appended', dropped: 0, droppedPageId: null };
}

// ── Page structure: resolve once, apply in a safe order ─────────────────────

/** The parts of a page summary this planning needs. */
export interface PageRef {
  id: string;
  index: number;
}

export type PageStep =
  | { op: 'reorder'; proposal: AgentProposal }
  /** `pageId` null = the page it named is not in the magazine (a refusal). */
  | { op: 'remove'; proposal: AgentProposal; pageId: string | null }
  /** `beforePageId`: the page the new one goes in front of; undefined = at the end. */
  | { op: 'add-page' | 'generate-pages'; proposal: AgentProposal; beforePageId: string | undefined };

/** The magazine's pages in reading order. */
export const inOrder = (pages: PageRef[]): PageRef[] => [...pages].sort((a, b) => a.index - b.index);

/** The page a legacy 0-based number means: the page whose own index it is, else the
 *  one at that position (a list that is not the whole magazine). */
function pageAtNumber(sorted: PageRef[], zeroBased: number | undefined): PageRef | undefined {
  if (zeroBased == null || !Number.isFinite(zeroBased)) return undefined;
  return sorted.find((p) => p.index === zeroBased) ?? sorted[zeroBased];
}

/**
 * Turn the staged page changes into steps, every page named by ID up front.
 *
 * ORDER: moves, then deletions, then new pages. The numbers the user said ("delete
 * pages 3 and 4", "add a page as page 3") describe the magazine as it was when they
 * said them, so each change is pinned to a page id against THAT list before anything
 * runs. The old loop resolved each number against the list the previous step had
 * just re-numbered — the second of two deletes then hit the page after the one meant.
 *
 * A second delete of the same page is counted in `duplicates` and not run.
 */
export function planPageSteps(proposals: AgentProposal[], pagesAtStart: PageRef[]): { steps: PageStep[]; duplicates: number } {
  const sorted = inOrder(pagesAtStart);
  const reorders: PageStep[] = [];
  const removes: PageStep[] = [];
  const adds: PageStep[] = [];
  const removing = new Set<string>();
  let duplicates = 0;
  for (const p of proposals) {
    if (p.kind === 'reorder-page') {
      reorders.push({ op: 'reorder', proposal: p });
    } else if (p.kind === 'remove-page') {
      const id = p.pageId ? (sorted.some((x) => x.id === p.pageId) ? p.pageId : null) : (pageAtNumber(sorted, p.targetIndex)?.id ?? null);
      if (id && removing.has(id)) {
        duplicates++;
        continue;
      }
      if (id) removing.add(id);
      removes.push({ op: 'remove', proposal: p, pageId: id });
    } else if (p.kind === 'add-page' || p.kind === 'generate-pages') {
      // "Becomes page N" = goes in front of the page that is page N now.
      const before = p.atIndex == null ? undefined : sorted[p.atIndex]?.id;
      adds.push({ op: p.kind, proposal: p, beforePageId: before });
    }
  }
  return { steps: [...reorders, ...removes, ...adds], duplicates };
}

/**
 * Where a move lands, against the page list as it is NOW.
 *
 * The page to move is found by id when the proposal has one (an older server sent
 * only the position). The destination is the position the user named, or — when the
 * proposal names one — wherever that page is now. 'in-place' = it is already there
 * (nothing to send, and nothing went wrong); null = the move cannot be made (the page
 * or its destination is gone) — a refusal.
 */
export function reorderIndices(p: AgentProposal, currentIds: string[]): { from: number; to: number } | 'in-place' | null {
  const n = currentIds.length;
  if (n === 0) return null;
  const from = p.pageId ? currentIds.indexOf(p.pageId) : p.from ?? -1;
  if (from < 0 || from >= n) return null;
  let to = p.toPageId ? currentIds.indexOf(p.toPageId) : p.to ?? -1;
  if (to < 0) return null;
  to = Math.min(n - 1, Math.max(0, to));
  return from === to ? 'in-place' : { from, to };
}

/**
 * The 0-based index to insert a new page at, against the list as it is NOW.
 *
 * In front of the page it was staged in front of. If that page has since been
 * deleted, in front of the next page after it that still exists; if none does, at
 * the end (undefined) — which is where "after the last page" ends up anyway.
 */
export function insertIndexFor(beforePageId: string | undefined, currentIds: string[], originalIds: string[]): number | undefined {
  if (!beforePageId) return undefined;
  const now = currentIds.indexOf(beforePageId);
  if (now >= 0) return now;
  const start = originalIds.indexOf(beforePageId);
  if (start < 0) return undefined;
  for (let i = start + 1; i < originalIds.length; i++) {
    const at = currentIds.indexOf(originalIds[i]!);
    if (at >= 0) return at;
  }
  return undefined;
}

// ── Words for the confirm and the toasts ────────────────────────────────────

const stripTags = (html: string): string =>
  html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

/**
 * A page's headline, in a few words, for naming it in a confirm.
 *
 * A confirm that says only "delete page 4" asks the user to remember what page 4 is —
 * and after a move in the same apply, page 4 may not be the page they think. The
 * largest headline wins; a page with none uses its first words of text.
 */
export function pageHeadline(elements: MagazineElement[] | undefined, max = 40): string {
  if (!elements || elements.length === 0) return '';
  const texts = elements.filter((e) => e.type === 'text' && e.text && stripTags(e.text.content));
  if (texts.length === 0) return '';
  const heads = texts.filter((e) => e.text!.role === 'headline');
  const pool = heads.length > 0 ? heads : texts;
  const best = heads.length > 0 ? [...pool].sort((a, b) => b.text!.fontSize - a.text!.fontSize)[0]! : pool[0]!;
  const words = stripTags(best.text!.content);
  return words.length > max ? `${words.slice(0, max - 1).trimEnd()}…` : words;
}

/** "a", "a and b", "a, b and c". */
export const listInWords = (items: string[]): string =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/** The confirm for staged page deletions, naming each page by number AND headline. */
export function removalQuestion(targets: { number: number; headline: string }[]): string {
  const named = targets.map((t) => `page ${t.number}${t.headline ? ` (“${t.headline}”)` : ''}`);
  const one = targets.length === 1;
  return (
    `Delete ${listInWords(named)}?\n\n` +
    `${one ? 'A deleted page' : 'Deleted pages'} cannot be brought back with undo. The assistant’s other changes are applied with ${one ? 'it' : 'them'}.`
  );
}

/**
 * The closing sentence of an apply that went through.
 *
 * "Undo with Ctrl+Z" is true only of ELEMENT edits — page adds, moves and deletions
 * are not on the undo stack — so the promise is made only as far as it holds.
 */
export function appliedMessage(elementWrites: number, pageOps: number): string {
  if (pageOps === 0) return 'Applied the assistant’s changes. Undo with Ctrl+Z.';
  if (elementWrites === 0) return 'Applied the assistant’s changes.';
  return 'Applied the assistant’s changes. Ctrl+Z undoes the edits on the page; the page changes stay.';
}

// ── The page check, as the panel shows it ───────────────────────────────────

/** The errors in a check (warnings are left to the assistant). */
export const checkErrors = (check: PageCheck | null | undefined): PageCheckIssue[] =>
  check ? check.issues.filter((i) => i.severity === 'error') : [];

/** "1 problem after these changes" — or "on this page" once they are applied. */
export function problemsLabel(n: number, applied: boolean): string {
  return `${n} problem${n === 1 ? '' : 's'} ${applied ? 'on this page' : 'after these changes'}`;
}

/** What the chip's tooltip lists: one line per problem, at most `max`. */
export function problemsTooltip(issues: PageCheckIssue[], max = 4): string {
  const lines = issues.slice(0, max).map((i) => `• ${i.label}: ${i.detail}`);
  if (issues.length > max) lines.push(`…and ${issues.length - max} more`);
  return lines.join('\n');
}

// ── The tray's rows ─────────────────────────────────────────────────────────

/** The picture a proposal places, for the tray — drawn the way the PAGE will draw it:
 *  a chart or logo placed whole (`contain`) is shown whole here too, not cropped into
 *  a thumbnail that hides the very edges the placement keeps. A background picture
 *  fills the page, so it is shown filling its tile. */
export function thumbOf(p: AgentProposal): { url: string; contain: boolean } | undefined {
  if (p.kind === 'set-background') {
    const v = p.background?.type === 'image' ? p.background.value : undefined;
    return v && /^https?:\/\/|^\/api\//.test(v) ? { url: v, contain: false } : undefined;
  }
  const img = p.element?.image ?? p.patch?.image;
  const url = img?.url as string | undefined;
  return url && /^https?:\/\/|^\/api\//.test(url) ? { url, contain: img?.fit === 'contain' } : undefined;
}

/** One row of the tray: a proposal shown for `n` changes, under `label` when the row
 *  stands for a whole group. */
export interface TrayRow {
  p: AgentProposal;
  n: number;
  label?: string;
}

/**
 * The tray's rows: one change as the person asked for it, shown ONCE.
 *
 * "Clear this page" stages one delete per element, and twenty "Removed …" rows hid the
 * one line that mattered. Two ways rows fold together:
 *   • the changes ONE tool call staged carry a `group` — its own label, which already
 *     says how many ("Clear the page: remove 14 elements") — while each member's
 *     summary names its element. They show once, under the label. A member with a
 *     warning keeps a row of its own, so the warning is seen;
 *   • otherwise identical changes (same kind, same summary, no picture, no warning)
 *     show once with a count.
 */
export function trayRows(list: readonly AgentProposal[]): TrayRow[] {
  const rows: TrayRow[] = [];
  for (const p of list) {
    if (p.group && !p.warning) {
      const same = rows.find((r) => r.label === p.group);
      if (same) same.n++;
      else rows.push({ p, n: 1, label: p.group });
      continue;
    }
    const same = rows.find((r) => !r.label && r.p.kind === p.kind && r.p.summary === p.summary && !r.p.warning && !p.warning && !thumbOf(p));
    if (same) same.n++;
    else rows.push({ p, n: 1 });
  }
  return rows;
}

// ── Attached pictures ───────────────────────────────────────────────────────

/**
 * Words in a file name that say "graphic, not photograph". Matched as WHOLE words —
 * a substring test called "photograph.jpg" a graph and "charter-boat.jpg" a chart.
 * Deliberately narrow: "dining-table.jpg" is a photo, so 'table' is not on the list.
 */
const GRAPHIC_WORDS = new Set([
  'chart', 'charts', 'graph', 'graphs', 'logo', 'logos', 'diagram', 'diagrams', 'infographic', 'infographics',
  'screenshot', 'screenshots', 'screengrab', 'poster', 'posters', 'flyer', 'flyers', 'scan', 'scanned',
  'wordmark', 'badge', 'icon', 'icons',
]);

/** A file name's words: extension dropped, camelCase split, lower-cased. */
export function nameWords(name: string): string[] {
  return name
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Is this attached picture a GRAPHIC — something that must be shown whole?
 *
 * Charts, logos, diagrams, screenshots and cut-outs lose their words and edges when a
 * box crops them (`fit: 'cover'`). Transparent pixels are the strongest sign (a logo
 * or cut-out); otherwise the file name. A hint the assistant weighs, not a rule.
 */
export function looksLikeGraphic(name: string, transparent: boolean): boolean {
  if (transparent) return true;
  const words = nameWords(name);
  if (words.some((w) => GRAPHIC_WORDS.has(w))) return true;
  // macOS names its screenshots "Screen Shot 2026-…", two words.
  return words.some((w, i) => w === 'screen' && (words[i + 1] === 'shot' || words[i + 1] === 'grab'));
}
