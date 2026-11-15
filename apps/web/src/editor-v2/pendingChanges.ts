// ---------------------------------------------------------------------------
// Magazine Builder v2 — staged Design Helper changes, kept PER PAGE until Apply.
//
// The pure half. The store (store.ts) holds the map and does the writes; the
// waiting-changes bar (WaitingChangesBar.tsx), the panel (AiPanel.tsx) and The
// Stable Hand (operator/useMagazineEditorActions.ts) read it. Everything here
// decides; nothing here writes.
//
// WHY THIS EXISTS. A client cleared pages 7 to 16 one message at a time ("remove
// every element on this page"), and then rewrote page 3 box by box, one message per
// box. Each reply said the change was staged — and each new message threw the
// previous one's staged set away, because there was ONE tray and every turn replaced
// it. At most the last message's changes could ever be applied. The product decision
// (2026-11-15) keeps the Apply step but says staged changes are never lost:
//
//   • they ACCUMULATE across messages (a later edit to the same field of the same
//     element replaces the earlier one — foldChanges);
//   • they are kept PER PAGE, so moving to page 8 and asking there does not touch
//     what waits on page 7;
//   • they survive a page switch and a reload (persisted per magazine in
//     localStorage — serializePending / parsePending);
//   • "Apply all" applies every page's set, in page order (waitingPages), and says
//     per page what landed and what was refused (applyReportLine);
//   • every reply ends with a line built from the proposals THEMSELVES, never from
//     the model's words (stagedLine) — a reply once said "All six paragraphs are 20px"
//     after calling no tool at all, and the user believed it.
//
// Kept free of the store, the API client and React so it runs under `tsx --test`.
// ---------------------------------------------------------------------------

import type { AgentProposal, MagazineElement } from './model';
import { mergeTurnProposals, patchPaths, sameChangeKey, tagTurn, uniqueIds, withoutSettled, type TurnMergeMode } from './proposals';
import { plainAsHtml, replaceInHtml, sameWords, visibleText } from './textReplace';

/** Waiting changes by page id. A page with nothing waiting has no key. */
export type PendingByPage = Readonly<Record<string, readonly AgentProposal[]>>;

/** The two facts the ordering needs about a page: its id and 0-based index. */
export interface PageRef {
  id: string;
  index: number;
}

const EMPTY: readonly AgentProposal[] = Object.freeze([]) as readonly AgentProposal[];

/** How many waiting changes one turn sends back for the server to replay — the
 *  server caps the replay at this (studioRequests.MAX_PENDING_PROPOSALS), so sending
 *  more would only be cut off there, and counted as dropped here. The ones past it are
 *  not sent but are never lost: accumulateTurn keeps them (keepUnsent). Raise the two
 *  together. */
export const MAX_SENT_PER_TURN = 50;

// ── The map ──────────────────────────────────────────────────────────────────

/** One page's waiting changes (never undefined). */
export const pendingFor = (map: PendingByPage, pageId: string | null | undefined): readonly AgentProposal[] =>
  (pageId && map[pageId]) || EMPTY;

/** The map with one page's list replaced. An empty list REMOVES the page, so "is
 *  anything waiting?" is just "are there keys?". Returns the same map when nothing
 *  changes, so a store update can be skipped. */
export function withPage(map: PendingByPage, pageId: string, list: readonly AgentProposal[]): PendingByPage {
  const had = map[pageId];
  if (list.length === 0) {
    if (!had) return map;
    const next: Record<string, readonly AgentProposal[]> = { ...map };
    delete next[pageId];
    return next;
  }
  if (had === list) return map;
  return { ...map, [pageId]: list };
}

/** The map without these pages (deleted, rebuilt, discarded). */
export function withoutPages(map: PendingByPage, pageIds: Iterable<string>): PendingByPage {
  let next: PendingByPage = map;
  for (const id of pageIds) next = withPage(next, id, EMPTY);
  return next;
}

/** Every waiting change, on every page. */
export function pendingTotal(map: PendingByPage): number {
  let n = 0;
  for (const list of Object.values(map)) n += list.length;
  return n;
}

/**
 * What the open page's tray shows: that page's waiting changes, and the page they are
 * for (null when there are none). The store keeps `proposals` / `proposalsPageId` as
 * this mirror, so everything that read the single tray before still reads the right
 * thing for the page on screen.
 */
export function trayFor(map: PendingByPage, currentPageId: string | null | undefined): { proposals: AgentProposal[]; proposalsPageId: string | null } {
  const list = pendingFor(map, currentPageId);
  return { proposals: list as AgentProposal[], proposalsPageId: list.length > 0 && currentPageId ? currentPageId : null };
}

// ── Folding: a later change to the same thing replaces the earlier one ────────

/** A patch with these dotted paths ('x', 'text.content') taken out. Sub-objects left
 *  empty go too. Never mutates. */
export function stripPaths(patch: Partial<MagazineElement>, paths: ReadonlySet<string>): Partial<MagazineElement> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (paths.has(k)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && (k === 'text' || k === 'image' || k === 'shape' || k === 'qr' || k === 'icon')) {
      const sub: Record<string, unknown> = {};
      const keys = Object.keys(v as Record<string, unknown>);
      // `{ text: {} }` writes nothing; patchPaths names it 'text', which is caught above.
      for (const sk of keys) if (!paths.has(`${k}.${sk}`)) sub[sk] = (v as Record<string, unknown>)[sk];
      if (keys.length === 0 || Object.keys(sub).length > 0) out[k] = keys.length === 0 ? v : sub;
      continue;
    }
    out[k] = v;
  }
  return out as Partial<MagazineElement>;
}

/**
 * Fold a list of waiting changes so each thing is changed once.
 *
 *  • An update's fields that a LATER update of the same element writes again are
 *    taken out of the earlier one ("20px" then "18px" → only 18px is applied); an
 *    earlier update left with nothing to write goes.
 *  • A later delete of an element makes earlier updates of it pointless.
 *  • An element added and then deleted before Apply was never there: the add, its
 *    updates and the delete all go.
 *  • Only the LAST background change for the page is kept.
 *  • A change listed twice (the same id) is kept once.
 *
 * Order is kept, so what is left applies exactly as the full list would have.
 */
export function foldChanges(list: readonly AgentProposal[]): AgentProposal[] {
  // Ids are unique per tray; a repeat is the same staged change sent back twice.
  const seenIds = new Set<string>();
  const unique = list.filter((p) => (seenIds.has(p.id) ? false : (seenIds.add(p.id), true)));

  // Elements added AND deleted within the list.
  const deletedIds = new Set(unique.filter((p) => p.kind === 'delete' && p.elementId).map((p) => p.elementId!));
  const vanished = new Set(unique.filter((p) => p.kind === 'add' && p.tempId && deletedIds.has(p.tempId)).map((p) => p.tempId!));

  const lastBackground = (() => {
    for (let i = unique.length - 1; i >= 0; i--) if (unique[i]!.kind === 'set-background') return unique[i]!.id;
    return null;
  })();

  const out: AgentProposal[] = [];
  for (let i = 0; i < unique.length; i++) {
    const p = unique[i]!;
    if (p.kind === 'set-background' && p.id !== lastBackground) continue;
    if (p.kind === 'add' && p.tempId && vanished.has(p.tempId)) continue;
    if ((p.kind === 'update' || p.kind === 'delete') && p.elementId && vanished.has(p.elementId)) continue;
    if (p.kind !== 'update' || !p.elementId) {
      out.push(p);
      continue;
    }
    const later = unique.slice(i + 1).filter((n) => n.elementId === p.elementId);
    if (later.some((n) => n.kind === 'delete')) continue;
    const overwritten = new Set<string>();
    for (const n of later) if (n.kind === 'update') for (const path of patchPaths(n.patch)) overwritten.add(path);
    if (overwritten.size === 0 || !p.patch) {
      out.push(p);
      continue;
    }
    const mine = patchPaths(p.patch);
    if (mine.length > 0 && mine.every((path) => overwritten.has(path))) continue;
    const kept = stripPaths(p.patch, overwritten);
    out.push(kept === p.patch ? p : { ...p, patch: kept });
  }
  return out;
}

// ── One turn's reply into the map ────────────────────────────────────────────

/**
 * Is a waiting change still accounted for in a server's combined reply? It is when the
 * reply carries it unchanged, or carries something that makes it pointless: a delete
 * of its element, a later update writing every field it writes, a newer background.
 */
function accountedFor(p: AgentProposal, reply: readonly AgentProposal[], replyKeys: ReadonlySet<string>): boolean {
  if (replyKeys.has(sameChangeKey(p))) return true;
  if (p.kind === 'set-background') return reply.some((n) => n.kind === 'set-background');
  if (!p.elementId || (p.kind !== 'update' && p.kind !== 'delete')) return false;
  const mine = patchPaths(p.patch);
  return reply.some((n) => {
    if (n.elementId !== p.elementId) return false;
    if (n.kind === 'delete') return true;
    if (p.kind !== 'update' || n.kind !== 'update') return false;
    const theirs = new Set(patchPaths(n.patch));
    return mine.length > 0 && mine.every((path) => theirs.has(path));
  });
}

/**
 * Waiting changes a REPLAYING server did not send back, and that nothing in its reply
 * replaces. Usually deliberate (the user asked to drop one), but a server that does
 * not know a kind yet drops it too — so the caller says so, with "Bring back", rather
 * than letting it vanish.
 */
export function droppedByServer(sentWaiting: readonly AgentProposal[], reply: readonly AgentProposal[]): AgentProposal[] {
  const keys = new Set(reply.map(sameChangeKey));
  return sentWaiting.filter((p) => !accountedFor(p, reply, keys));
}

export interface TurnResult {
  map: PendingByPage;
  /** Never 'replaced': nothing waiting is thrown away by a turn any more. */
  mode: TurnMergeMode;
  /** Earlier waiting changes that did not stay (see `droppedList`). */
  dropped: number;
  /** Which ones: changes a replaying server did not hand back and nothing replaces
   *  (droppedByServer). The caller reports them with a way to bring them back. */
  droppedList: AgentProposal[];
  /** The changes THIS turn staged (not the ones that were already waiting). */
  added: AgentProposal[];
  /** Everything now waiting on the turn's page. */
  onPage: AgentProposal[];
}

/**
 * Put one Design Helper turn's proposals into the map, for the page the turn was
 * about.
 *
 * `sent` is what the turn was sent as already waiting; `reply` what it returned. The
 * page's list as it is NOW (an automation may have applied or discarded underneath
 * the turn) is read from `map`. A server that replays returns the combined set and
 * says so (`serverMerged`); an older one returns only the new changes, which are
 * appended. Either way a later edit of the same field replaces the earlier one, and
 * nothing waiting on ANOTHER page is touched — that is the whole point.
 */
export function accumulateTurn(input: {
  map: PendingByPage;
  pageId: string;
  sent: readonly AgentProposal[];
  reply: readonly AgentProposal[];
  serverMerged?: boolean;
  turnTag: string;
  /** The turn's page's elements as they are now. A text edit this turn staged is
   *  stamped with the words its box has now (stampBaseText), so Apply can tell when the
   *  box was edited in between (holdStaleTextChanges). Absent = no stamp, no check. */
  elements?: readonly MagazineElement[];
}): TurnResult {
  const { map, pageId } = input;
  const waitingNow = pendingFor(map, pageId) as AgentProposal[];
  const reply = withoutSettled([...input.reply], [...input.sent], waitingNow);
  let merged = mergeTurnProposals({
    prev: waitingNow,
    prevPageId: waitingNow.length > 0 ? pageId : null,
    next: reply,
    forPageId: pageId,
    serverMerged: input.serverMerged,
    turnTag: input.turnTag,
  });
  // A whole-page rebuild meeting other changes on the same page: the single tray had
  // to choose, and the older side was thrown away. Both are kept now. Apply runs the
  // rebuild on its own and leaves the rest waiting, said aloud (the store's
  // applyPageSet), so the user decides what happens to them — nothing goes unasked.
  if (merged.mode === 'replaced') {
    merged = { proposals: [...waitingNow, ...tagTurn(reply, input.turnTag)], pageId, mode: 'appended', dropped: 0, droppedPageId: null };
  }
  // A replaying server's list is the page's set from now on — but anything it left
  // out without a replacement is named, never lost in silence.
  let droppedList: AgentProposal[] = [];
  if (merged.mode === 'server') {
    const sentKeys = new Set(input.sent.map(sameChangeKey));
    droppedList = droppedByServer(
      waitingNow.filter((p) => sentKeys.has(sameChangeKey(p))),
      reply,
    );
    // Waiting changes the turn was never SENT (a page holds more than MAX_SENT_PER_TURN:
    // "clear this page" on a copied PDF page stages one delete per box, often 60 or
    // more). The server could neither keep nor drop what it never saw, so taking its
    // list as the whole set lost them without a word — and after Apply the "cleared"
    // page still had boxes on it. They stay, after the changes the server replayed and
    // before this turn's new ones, which is where they were in the queue.
    merged = { ...merged, proposals: keepUnsent(merged.proposals, waitingNow, sentKeys, input.turnTag) };
  }
  const before = new Set(waitingNow.map(sameChangeKey));
  const folded = foldChanges(carryOver(merged.proposals, waitingNow));
  const els = input.elements ? new Map(input.elements.map((e) => [e.id, e])) : null;
  const onPage = els ? folded.map((p) => (before.has(sameChangeKey(p)) ? p : stampBaseText(p, els))) : folded;
  return {
    map: withPage(map, pageId, onPage),
    mode: merged.mode,
    dropped: droppedList.length,
    droppedList,
    added: onPage.filter((p) => !before.has(sameChangeKey(p))),
    onPage,
  };
}

/**
 * A replaying server's list with the waiting changes it was never sent put back: after
 * the ones it replayed, ahead of the turn's new ones. A kept add whose placeholder the
 * server happened to use again is renamed (and so are the kept changes that name it),
 * so the apply's placeholder map cannot send one add's edits to the other's box; ids
 * are made unique over the whole list for the same reason.
 */
function keepUnsent(list: readonly AgentProposal[], waitingNow: readonly AgentProposal[], sentKeys: ReadonlySet<string>, turnTag: string): AgentProposal[] {
  const unsent = waitingNow.filter((p) => !sentKeys.has(sameChangeKey(p)));
  if (unsent.length === 0) return [...list];
  const taken = new Set(list.flatMap((p) => (p.tempId ? [p.tempId] : [])));
  const renamed = new Map<string, string>();
  for (const p of unsent) if (p.tempId && taken.has(p.tempId)) renamed.set(p.tempId, `${turnTag}-kept-${p.tempId}`);
  const kept =
    renamed.size === 0
      ? unsent
      : unsent.map((p) => ({
          ...p,
          ...(p.tempId && renamed.has(p.tempId) ? { tempId: renamed.get(p.tempId)! } : {}),
          ...(p.elementId && renamed.has(p.elementId) ? { elementId: renamed.get(p.elementId)! } : {}),
        }));
  const firstNew = list.findIndex((p) => !sentKeys.has(sameChangeKey(p)));
  const at = firstNew < 0 ? list.length : firstNew;
  return uniqueIds([...list.slice(0, at), ...kept, ...list.slice(at)], `${turnTag}k`);
}

/**
 * What only this client knows about a waiting change, put back on the copy a replaying
 * server returned. The server rebuilds each change it replays from the fields it knows
 * (studioRequests.parsePendingProposals), so the words a text edit was staged against
 * (`baseText`) and a warning set here would vanish on the first follow-up message.
 *
 * A warning the SERVER wrote is the server's to keep or drop: it echoes the warnings it
 * replays, and takes its "Will not fit its box" sentence off a change when a later
 * change in the turn made the text fit. Putting that one back from this copy would
 * show a fit problem that no longer exists.
 */
function carryOver(list: readonly AgentProposal[], waitingNow: readonly AgentProposal[]): AgentProposal[] {
  if (waitingNow.length === 0) return [...list];
  const byKey = new Map(waitingNow.map((p) => [sameChangeKey(p), p]));
  return list.map((p) => {
    const w = byKey.get(sameChangeKey(p));
    if (!w || w === p) return p;
    const extra: Partial<AgentProposal> = {};
    if (w.baseText !== undefined && p.baseText === undefined) extra.baseText = w.baseText;
    if (w.warning && !p.warning && !SERVER_FIT_WARNING.test(w.warning)) extra.warning = w.warning;
    return Object.keys(extra).length > 0 ? { ...p, ...extra } : p;
  });
}

/** The fit sentence the server's Studio agent puts first in a warning (agentTools/shared.ts fitWarning). */
const SERVER_FIT_WARNING = /^Will not fit its box: needs \d+px, box is \d+px\./;

// ── A staged text edit and the box it was written for ────────────────────────

/** The new content an update writes, when it rewrites a box's text. */
const contentOf = (p: AgentProposal): string | undefined => {
  const c = p.kind === 'update' ? p.patch?.text?.content : undefined;
  return typeof c === 'string' ? c : undefined;
};

/**
 * Stamp a text edit with the words its box has NOW. A staged text edit carries the
 * box's WHOLE new content, written from the words the box had when it was staged;
 * changes wait (per page, up to 30 days), and Apply writes that content over whatever
 * the box says by then. The stamp is what lets Apply notice that the box was edited
 * in between (holdStaleTextChanges) instead of overwriting the edit unseen.
 */
export function stampBaseText(p: AgentProposal, elements: ReadonlyMap<string, MagazineElement>): AgentProposal {
  if (p.baseText !== undefined || contentOf(p) === undefined || !p.elementId) return p;
  const content = elements.get(p.elementId)?.text?.content;
  return typeof content === 'string' ? { ...p, baseText: visibleText(content) } : p;
}

/** Said on a text edit Apply held back because its box changed after staging. */
export const STALE_WARNING =
  'Not applied: this box’s text was edited after the change was staged, so applying it would overwrite that edit. Apply again to use it anyway, or discard it.';

/**
 * Split a page's element changes into the ones to apply and the text edits to HOLD:
 * those whose box's words are no longer the words they were staged against (someone
 * typed in the box, an undo, another apply). A held change stays waiting, marked with
 * STALE_WARNING and re-stamped with the box's current words — so the person sees why,
 * and a second, deliberate Apply uses it anyway. Only text edits are held: a move or a
 * colour applied over a changed box loses nothing, a whole content rewrite does.
 */
export function holdStaleTextChanges(
  list: readonly AgentProposal[],
  elements: readonly MagazineElement[],
): { apply: AgentProposal[]; held: AgentProposal[] } {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const apply: AgentProposal[] = [];
  const held: AgentProposal[] = [];
  for (const p of list) {
    const now = p.elementId ? byId.get(p.elementId)?.text?.content : undefined;
    if (typeof p.baseText !== 'string' || contentOf(p) === undefined || typeof now !== 'string') {
      apply.push(p);
      continue;
    }
    const words = visibleText(now);
    if (sameWords(words, p.baseText)) apply.push(p);
    else held.push({ ...p, baseText: words, warning: STALE_WARNING });
  }
  return { apply, held };
}

/**
 * Rebase waiting changes onto a magazine-wide replace that has just rewritten the
 * stored pages ("NZTROF" → "NOG" everywhere).
 *
 * A staged text edit carries its box's whole new content, written from the OLD words;
 * applied after the replace it would put "NZTROF" straight back (and a follow-up
 * message would replay it to the Design Helper, which would then see the old word
 * again). So the same find-and-replace the server ran is run over that content — the
 * content an update writes and the content an added text box starts with — and over
 * the words a text edit was stamped against, which the replace changed in the stored
 * box too. Returns the list (the same array when nothing changed) and how many changes
 * now read differently.
 */
export function rebaseForReplace(
  list: readonly AgentProposal[],
  find: string,
  replace: string,
  opts: { matchCase?: boolean; wholeWord?: boolean } = {},
): { list: readonly AgentProposal[]; changed: number } {
  let changed = 0;
  const out = list.map((p) => {
    let next = p;
    const content = contentOf(p);
    if (content !== undefined && p.patch?.text) {
      const r = replaceInHtml(content, find, replace, opts);
      if (r.count > 0) next = { ...next, patch: { ...p.patch, text: { ...p.patch.text, content: r.html } } };
    }
    const added = p.kind === 'add' ? p.element?.text : undefined;
    if (added && typeof added.content === 'string') {
      const r = replaceInHtml(added.content, find, replace, opts);
      if (r.count > 0) next = { ...next, element: { ...p.element, text: { ...added, content: r.html } } };
    }
    if (next !== p) changed++;
    if (typeof next.baseText === 'string') {
      const r = replaceInHtml(plainAsHtml(next.baseText), find, replace, opts);
      if (r.count > 0) next = { ...next, baseText: visibleText(r.html) };
    }
    return next;
  });
  return { list: out.some((p, i) => p !== list[i]) ? out : list, changed };
}

// ── Apply order ──────────────────────────────────────────────────────────────

export interface WaitingPage {
  pageId: string;
  /** The page's number as the canvas prints it (index + 1). */
  page: number;
  proposals: readonly AgentProposal[];
}

/**
 * Every page with waiting changes, IN PAGE ORDER — the order Apply all works in.
 * A page that is no longer in the magazine is left out (see orphanPageIds): its
 * changes can never land, and pretending otherwise would count them as refused on a
 * page nobody can see.
 */
export function waitingPages(map: PendingByPage, pages: readonly PageRef[]): WaitingPage[] {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const out: WaitingPage[] = [];
  for (const [pageId, proposals] of Object.entries(map)) {
    const ref = byId.get(pageId);
    if (!ref || proposals.length === 0) continue;
    out.push({ pageId, page: ref.index + 1, proposals });
  }
  return out.sort((a, b) => a.page - b.page);
}

/** Pages in the map that are no longer in the magazine. */
export function orphanPageIds(map: PendingByPage, pages: readonly PageRef[]): string[] {
  const known = new Set(pages.map((p) => p.id));
  return Object.keys(map).filter((id) => !known.has(id));
}

// ── Words ────────────────────────────────────────────────────────────────────

/** "1 change" / "6 changes". */
export const changeCount = (n: number): string => `${n} change${n === 1 ? '' : 's'}`;

/** "page 7" / "pages 7, 8, 9". */
export function pagesPhrase(numbers: readonly number[]): string {
  const ns = [...numbers].sort((a, b) => a - b);
  if (ns.length === 0) return 'no pages';
  return ns.length === 1 ? `page ${ns[0]}` : `pages ${ns.join(', ')}`;
}

/** "6 changes waiting on pages 7, 8, 9" — what the bar says. */
export function waitingBarText(waiting: readonly WaitingPage[]): string {
  const n = waiting.reduce((sum, w) => sum + w.proposals.length, 0);
  return `${changeCount(n)} waiting on ${pagesPhrase(waiting.map((w) => w.page))}`;
}

/** A summary trimmed for one line. */
const short = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim().replace(/[.;\s]+$/, '');
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/**
 * The changes in a few words: identical summaries counted once ("Removed an element
 * ×7" rather than seven lines — a "clear the page" turn is one thing to the person
 * who asked for it), at most `max` of them, then "and N more".
 */
export function summarizeChanges(list: readonly AgentProposal[], max = 3): string {
  // The changes one tool call staged together share a `group` whose label already
  // counts them ("Clear the page: remove 14 elements"): named ONCE, with no ×n, and
  // counted as one change in "and N more" — as the person asked for it.
  const groups: { text: string; n: number; grouped: boolean }[] = [];
  for (const p of list) {
    const grouped = !!p.group;
    const text = short(p.group || p.summary || p.kind, 70);
    const g = groups.find((x) => x.text === text && x.grouped === grouped);
    if (g) g.n++;
    else groups.push({ text, n: 1, grouped });
  }
  const shown = groups.slice(0, max).map((g) => (g.n > 1 && !g.grouped ? `${g.text} ×${g.n}` : g.text));
  const rest = groups.slice(max).reduce((sum, g) => sum + (g.grouped ? 1 : g.n), 0);
  return rest > 0 ? `${shown.join('; ')}; and ${rest} more` : shown.join('; ');
}

/** First-person past tense that reports work as DONE: "I've staged", "I set", "I have moved". */
const CLAIM =
  /\b(?:i(?:['’]ve| have)?|we(?:['’]ve| have)?)\s+(?:now\s+|just\s+|also\s+|already\s+)?(?:staged|applied|set|moved|removed|added|changed|replaced|resized|deleted|updated|made|placed|swapped|rewrote|rewritten|recolou?red|cleared|aligned|spaced|shortened|enlarged|shrunk|raised|lowered|centred|centered|put|turned|copied|rebuilt|inserted|generated|drew|drawn)\b/i;
/** "…are now 20px", "…is now red", "staged for you to review", "ready to apply". */
const STATE_CLAIM = /\b(?:is|are)\s+now\b|\bstaged\b|\bready (?:to|for) (?:apply|review)|\bonce you (?:apply|press)/i;
/** A sentence that says something was NOT done. */
const NEGATED = /\b(?:not|never|nothing|no changes?|didn['’]t|haven['’]t|hasn['’]t|wasn['’]t|weren['’]t|couldn['’]t|can['’]t|cannot|won['’]t|unable)\b/i;

/**
 * Does this reply say it changed something?
 *
 * Read per sentence, and a sentence that says something was NOT done ("I didn't
 * actually stage it", "nothing was changed") does not count. Used only to make the
 * line under a reply blunter when the reply claims work and no change was staged —
 * the line itself comes from the proposals either way.
 */
export function claimsChange(reply: string): boolean {
  for (const sentence of reply.split(/[.!?]+\s+|\n+/)) {
    const s = sentence.trim();
    if (!s || NEGATED.test(s)) continue;
    if (CLAIM.test(s) || STATE_CLAIM.test(s)) return true;
  }
  return false;
}

/** " Also waiting: 4 changes on pages 7, 9." — or '' when no other page has any.
 *  Only this client knows about the OTHER pages (each turn sends the server only its
 *  own page's), so this half is added here even when the server wrote the rest. */
export function otherPagesTail(others: readonly WaitingPage[]): string {
  const n = others.reduce((sum, w) => sum + w.proposals.length, 0);
  return n > 0 ? ` Also waiting: ${changeCount(n)} on ${pagesPhrase(others.map((w) => w.page))}.` : '';
}

/**
 * The deterministic line under a Design Helper reply — built from what the turn
 * actually staged, so it can never disagree with the page.
 *
 *   "Waiting for Apply: 2 changes on page 3 — Set the body to 20px; Moved the photo.
 *    Also waiting: 4 changes on pages 7, 9."
 *   "Nothing was changed. 3 earlier changes on this page are still waiting for Apply."
 *   "Nothing was changed — no change was staged, whatever the reply above says."
 */
export function stagedLine(input: {
  /** The changes this turn staged. */
  added: readonly AgentProposal[];
  /** The turn's page number (0 when unknown). */
  pageNumber: number;
  /** Everything waiting on the turn's page now (this turn's included). */
  onPage: number;
  /** Other pages with changes waiting. */
  others: readonly WaitingPage[];
  /** The reply says it changed something (claimsChange). */
  claimed: boolean;
}): string {
  const where = input.pageNumber > 0 ? ` on page ${input.pageNumber}` : '';
  const tail = otherPagesTail(input.others);
  if (input.added.length > 0) {
    const earlier = input.onPage - input.added.length;
    const all = earlier > 0 ? ` (${input.onPage} in all on this page.)` : '';
    return `Waiting for Apply: ${changeCount(input.added.length)}${where} — ${summarizeChanges(input.added)}.${all}${tail}`;
  }
  const head = input.claimed ? 'Nothing was changed — no change was staged, whatever the reply above says.' : 'Nothing was changed.';
  const still =
    input.onPage > 0
      ? ` ${input.onPage === 1 ? '1 earlier change on this page is' : `${input.onPage} earlier changes on this page are`} still waiting for Apply.`
      : '';
  return `${head}${still}${tail}`;
}

/** Does this reply already end with a line of that kind (a server that appends its
 *  own)? Then the panel does not add a second one. */
export const hasStagedLine = (reply: string): boolean =>
  /(?:^|\n|\.\s)(?:Waiting for Apply:|Nothing was changed\b)/.test(reply.trim());

// ── Persistence (localStorage, per magazine) ─────────────────────────────────

export const PENDING_STORE_VERSION = 1;
/** The storage key for one magazine's waiting changes. Versioned: a shape change
 *  bumps it, and an old entry is simply never read. */
export const pendingStorageKey = (issueId: string): string => `mag2.pending.v${PENDING_STORE_VERSION}:${issueId}`;
/** Waiting changes older than this are not restored — the pages they were staged
 *  against have almost certainly moved on, and every write would be refused. */
export const PENDING_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Above this the set is not written (a quota error would lose it anyway); it stays
 *  in memory for the session. */
export const PENDING_MAX_CHARS = 1_500_000;

const KINDS: ReadonlySet<string> = new Set<AgentProposal['kind']>([
  'update',
  'add',
  'delete',
  'add-page',
  'remove-page',
  'reorder-page',
  'generate-pages',
  'apply-layout',
  'copy-document-page',
  'set-background',
]);

/** The stored text for a map, or null when there is nothing to keep (remove the key)
 *  or it is too large to keep. */
export function serializePending(map: PendingByPage, now: number): string | null {
  if (pendingTotal(map) === 0) return null;
  const text = JSON.stringify({ v: PENDING_STORE_VERSION, savedAt: now, pages: map });
  return text.length > PENDING_MAX_CHARS ? null : text;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** One stored proposal, if it is still a proposal this client can apply. */
function readProposal(raw: unknown): AgentProposal | null {
  if (!isObj(raw)) return null;
  if (typeof raw.id !== 'string' || !raw.id || typeof raw.kind !== 'string' || !KINDS.has(raw.kind)) return null;
  if (typeof raw.summary !== 'string') return null;
  if ((raw.kind === 'update' || raw.kind === 'delete') && typeof raw.elementId !== 'string') return null;
  if (raw.kind === 'update' && !isObj(raw.patch)) return null;
  if (raw.kind === 'add' && !isObj(raw.element)) return null;
  if (raw.kind === 'set-background' && !isObj(raw.background)) return null;
  return raw as unknown as AgentProposal;
}

/**
 * What a stored entry still holds. Anything unreadable, from another version, too old,
 * or for a page that is no longer in the magazine (`knownPageIds`) is left out —
 * never thrown: a broken entry must not stop the magazine from opening.
 */
export function parsePending(raw: string | null | undefined, opts: { now: number; knownPageIds?: Iterable<string> }): PendingByPage {
  if (!raw) return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isObj(data) || data.v !== PENDING_STORE_VERSION || !isObj(data.pages)) return {};
  const savedAt = typeof data.savedAt === 'number' ? data.savedAt : 0;
  if (!(savedAt > 0) || opts.now - savedAt > PENDING_MAX_AGE_MS) return {};
  const known = opts.knownPageIds ? new Set(opts.knownPageIds) : null;
  const out: Record<string, readonly AgentProposal[]> = {};
  for (const [pageId, list] of Object.entries(data.pages)) {
    if (known && !known.has(pageId)) continue;
    if (!Array.isArray(list)) continue;
    const kept = list.map(readProposal).filter((p): p is AgentProposal => !!p);
    if (kept.length > 0) out[pageId] = kept;
  }
  return out;
}

// ── What an apply did, page by page ──────────────────────────────────────────

export interface PageApplyReport {
  pageId: string;
  /** The page's number as printed (0 when it is not in the magazine any more). */
  page: number;
  applied: number;
  refused: number;
  /** Changes still waiting afterwards (a page build that cannot start yet, or a set
   *  the user said no to at a confirm). */
  waiting: number;
  /** Writes to the page's elements (and background) — undoable with Ctrl+Z. */
  elementWrites: number;
  /** Page adds, moves and deletions — not on the undo stack. */
  pageOps: number;
  /** The user said no at the confirm (a page deletion, a rebuild, a PDF copy). */
  declined?: boolean;
  /** A whole-page change was STARTED rather than finished here: a layout rebuild (it
   *  reports in its own toast) or a PDF page copy (a background job). */
  started?: 'layout' | 'copy';
  /** The page is gone (deleted since the changes were staged); its changes went with it. */
  gone?: boolean;
  /** The page could not be opened to apply on, so nothing there was tried. */
  notOpened?: boolean;
  /** Text edits held back because their box was edited after they were staged
   *  (holdStaleTextChanges). Counted in `waiting` too: they are still waiting. */
  stale?: number;
}

/**
 * The one sentence an Apply all ends with, naming every page:
 * "Applied 6 changes on page 7 and 3 on page 9. Page 8: 2 refused."
 */
export function applyReportLine(reports: readonly PageApplyReport[]): string {
  const done = reports.filter((r) => r.applied > 0);
  const parts: string[] = [];
  if (done.length > 0) {
    const bits = done.map((r, i) => `${i === 0 ? changeCount(r.applied) : r.applied} on page ${r.page}`);
    parts.push(`Applied ${bits.length === 1 ? bits[0] : `${bits.slice(0, -1).join(', ')} and ${bits[bits.length - 1]}`}.`);
  }
  for (const r of reports) {
    const where = r.page > 0 ? `Page ${r.page}` : 'A page that is gone';
    if (r.gone) parts.push(`${where}: the page no longer exists, so its ${changeCount(r.refused || r.waiting)} went with it.`);
    else if (r.notOpened) parts.push(`${where}: could not be opened — its changes are still waiting.`);
    else if (r.declined) parts.push(`${where}: you said no, so its changes are still waiting.`);
    else {
      if (r.started === 'layout') parts.push(`${where}: the layout rebuild ran (see its own message).`);
      if (r.started === 'copy') parts.push(`${where}: the PDF page is being copied — it shows when it is done.`);
      if (r.refused > 0) parts.push(`${where}: ${r.refused} refused.`);
      const stale = r.stale ?? 0;
      if (stale > 0) {
        parts.push(
          `${where}: ${changeCount(stale)} not applied — ${stale === 1 ? 'its box was' : 'their boxes were'} edited after ${stale === 1 ? 'it was' : 'they were'} staged, and applying would overwrite that. Still waiting: apply again only to overwrite it.`,
        );
      }
      const otherWaiting = r.waiting - stale;
      if (otherWaiting > 0 && !r.started) parts.push(`${where}: ${changeCount(otherWaiting)} still waiting.`);
    }
  }
  return parts.length > 0 ? parts.join(' ') : 'Nothing was waiting to apply.';
}

/** 'all' = every change landed; 'none' = nothing did; 'partial' otherwise. */
export function applyOutcome(reports: readonly PageApplyReport[]): 'all' | 'partial' | 'none' {
  const applied = reports.reduce((n, r) => n + r.applied, 0) + reports.filter((r) => r.started).length;
  const problems = reports.some((r) => r.refused > 0 || r.waiting > 0 || r.gone || r.notOpened || r.declined);
  if (applied === 0) return 'none';
  return problems ? 'partial' : 'all';
}
