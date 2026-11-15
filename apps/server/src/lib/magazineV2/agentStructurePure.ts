// ---------------------------------------------------------------------------
// Magazine Builder v2 — the pure half of the Studio agent's STRUCTURE tools and of
// its staging.
//
// structureTools.ts talks to the database (pages, documents, the PDF bytes); every
// decision it makes lives here instead, where a unit test can reach it:
//
//   • which page a number the user said means, pinned to an ID when the change is
//     STAGED — "delete pages 3 and 4" used to be applied one index at a time against
//     a list the first delete had already re-numbered, so it deleted 3 and 5 (C06);
//   • what a whole-page change (a layout rebuild, a PDF page copy) may be staged with,
//     which is nothing — page changes staged alongside one were silently dropped on
//     Apply (C10);
//   • what a layout rebuild really does to the page's words, said honestly: the route
//     RECREATES the page and writes fresh copy, while the tools promised the user's
//     own words would be kept (C09/C31);
//   • the documents a turn can read or build pages from (C12/C27/C28);
//   • how a turn builds on the changes an earlier turn staged and the user has not
//     applied yet, instead of losing them (C05).
//
// Pure: no I/O, no model, no clock (callers pass `now`).
// ---------------------------------------------------------------------------

// Type-only, so the agent.ts -> structureTools.ts -> here cycle is erased at runtime.
import type { AgentProposal } from './agent.js';
import { MAX_ELEMENTS_PER_PAGE, type MagazineElement } from './model.js';
import { normalizeElementPatch, normalizeElements } from './writePipeline.js';
import { FURNITURE_IDS } from './pageFurniture.js';
import { MAX_PAGES_PER_ISSUE } from './config.js';

type Kind = AgentProposal['kind'];

/**
 * A proposal as this module stages it: AgentProposal plus the two fields the web's
 * apply already reads and the server type does not declare yet — `toPageId` (a move's
 * destination, pinned to a page) and `docIds` (the documents new pages are written
 * from). An intersection, so it is assignable to AgentProposal today and stays
 * harmless once agent.ts declares them.
 */
export type StructureProposal = AgentProposal & { toPageId?: string; docIds?: string[] };

// ── Whole-page changes are staged on their own ──────────────────────────────

/**
 * Proposals that replace EVERY element on a page: a layout rebuild and a PDF page
 * copy. The web applies one on its own and drops whatever else was staged with it
 * (it says so now, but the work is still lost), so the tools refuse the combination
 * at staging time, while the model can still tell the user.
 */
export const EXCLUSIVE_KINDS: ReadonlySet<Kind> = new Set<Kind>(['apply-layout', 'copy-document-page']);

export const isExclusiveKind = (kind: string): boolean => EXCLUSIVE_KINDS.has(kind as Kind);

/** The whole-page change already staged, if there is one. */
export function exclusiveStaged(proposals: ReadonlyArray<Pick<AgentProposal, 'kind'>>): Pick<AgentProposal, 'kind'> | undefined {
  return proposals.find((p) => isExclusiveKind(p.kind));
}

function exclusiveName(kind: string): string {
  return kind === 'copy-document-page' ? 'a copy of a PDF page' : 'a layout rebuild';
}

/**
 * Why a whole-page change cannot be staged now, or null when it can.
 *
 * Anything already staged blocks it: element edits would be applied to elements the
 * rebuild destroys, and page changes are not applied alongside it at all. The staged
 * set includes changes from EARLIER turns that are still waiting (C05), so the
 * sentence says "apply or discard" — the user may not remember they are there.
 */
export function wholePageRefusal(proposals: ReadonlyArray<Pick<AgentProposal, 'kind'>>, what: 'rebuild' | 'copy'): string | null {
  if (proposals.length === 0) return null;
  const ex = exclusiveStaged(proposals);
  if (ex) {
    return `This page is already staged for ${exclusiveName(ex.kind)}, and only one whole-page change can wait at a time. Ask the user to apply or discard it first, then ask again in a new message.`;
  }
  const n = proposals.length;
  const verb = what === 'copy' ? 'Copying a PDF page' : 'A layout rebuild';
  return (
    `${verb} replaces every element on the page, so it cannot be combined with other changes — and ` +
    `${n === 1 ? '1 change is' : `${n} changes are`} already staged and waiting. Tell the user: apply (or discard) ` +
    `${n === 1 ? 'it' : 'them'} first, then ask for this again in a new message.`
  );
}

/**
 * Why a page add / remove / move cannot be staged now, or null (C10).
 *
 * Only a staged whole-page change blocks it: the web applies that on its own, so a
 * page change staged with it would never run. Element edits do not block it — the
 * web applies those and the page changes in one go.
 */
export function pageChangeRefusal(proposals: ReadonlyArray<Pick<AgentProposal, 'kind'>>): string | null {
  const ex = exclusiveStaged(proposals);
  if (!ex) return null;
  return `This page is already staged for ${exclusiveName(ex.kind)}, which is applied on its own — a page change staged with it would not be applied. Ask the user to apply it first, then ask for the page change in a new message.`;
}

/**
 * Why slow work (reading a layout from a picture or a PDF) should not start this
 * late in the turn, or null. The turn's model call is aborted at `deadline`; a tool
 * still waiting on a vision call then stages nothing and the user gets "I ran into a
 * hiccup" instead of a sentence they can act on.
 */
export function timeLeftRefusal(deadline: number, needMs: number, now: number): string | null {
  if (!Number.isFinite(deadline) || deadline - now >= needMs) return null;
  return 'There is not enough time left in this turn to read that layout. Tell the user to ask again in a new message — nothing was staged.';
}

// ── Which page a number means ───────────────────────────────────────────────

/** A stored page, as far as resolving and naming it needs. */
export interface PageRow {
  _id: string;
  index: number;
  elements?: unknown;
}

/** The pages in reading order (stored index, then id, so ties are stable). */
export function orderedPages<T extends PageRow>(rows: ReadonlyArray<T>): T[] {
  return [...rows].sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0) || String(a._id).localeCompare(String(b._id)));
}

function plainText(html: unknown): string {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

interface TextLike {
  id?: unknown;
  type?: unknown;
  text?: { role?: unknown; content?: unknown; fontSize?: unknown };
}

/** The page's own text boxes with words in them, furniture (running head, folio) left out. */
function storyTexts(elements: unknown): { role: string; words: string; size: number }[] {
  if (!Array.isArray(elements)) return [];
  const out: { role: string; words: string; size: number }[] = [];
  for (const raw of elements as TextLike[]) {
    if (!raw || raw.type !== 'text' || !raw.text) continue;
    if (FURNITURE_IDS.includes(String(raw.id ?? ''))) continue;
    const words = plainText(raw.text.content);
    if (!words) continue;
    out.push({ role: String(raw.text.role ?? ''), words, size: Number(raw.text.fontSize) || 0 });
  }
  return out;
}

/**
 * A page's headline in a few words, for naming it in a summary.
 *
 * "Remove page 4" asks the user to remember what page 4 is; "Remove page 4 (“Derby
 * Day”)" does not, and still reads right after other changes re-number the pages.
 * The largest headline wins; a page without one uses its largest text.
 */
export function pageHeadline(elements: unknown, max = 40): string {
  const texts = storyTexts(elements);
  if (texts.length === 0) return '';
  const heads = texts.filter((t) => t.role === 'headline');
  const best = [...(heads.length > 0 ? heads : texts)].sort((a, b) => b.size - a.size)[0]!;
  return best.words.length > max ? `${best.words.slice(0, max - 1).trimEnd()}…` : best.words;
}

/** "page 3 (“Derby Day”)", or "page 3" for a page with no words. */
export function pageName(n: number, row?: PageRow): string {
  const h = row ? pageHeadline(row.elements) : '';
  return h ? `page ${n} (“${h.replace(/[“”]/g, '"')}”)` : `page ${n}`;
}

export type PageAt =
  | { ok: true; pageId: string; number: number; row: PageRow; isOpen: boolean }
  | { ok: false; error: string };

/**
 * The page a 1-based number means, as an ID, against the magazine AS IT IS NOW.
 *
 * Unlike resolvePageOrdinal (pageDigest.ts) this returns the id even for the open
 * page: a deletion or a move needs to know exactly which page, in every case.
 * `readable` limits a page-scoped collaborator to the pages shared with them (the
 * open page always is).
 */
export function pageAtNumber(
  rows: ReadonlyArray<PageRow>,
  n: number,
  opts: { openIndex: number; readable?: ReadonlySet<string> },
): PageAt {
  const ordered = orderedPages(rows);
  const total = ordered.length;
  if (!Number.isInteger(n) || n < 1 || n > total) {
    return { ok: false, error: `This magazine has ${total} page${total === 1 ? '' : 's'}, so there is no page ${n}.` };
  }
  const row = ordered[n - 1]!;
  const isOpen = Number(row.index) === Number(opts.openIndex);
  if (!isOpen && opts.readable && !opts.readable.has(String(row._id))) {
    return {
      ok: false,
      error: `Page ${n} is not shared with this user, so it cannot be changed from here — only the pages shared with them (start with the one that is open).`,
    };
  }
  return { ok: true, pageId: String(row._id), number: n, row, isOpen };
}

/** How many pages the staged changes would add and remove. */
function stagedPageDelta(staged: ReadonlyArray<AgentProposal>): { adds: number; removes: number } {
  let adds = 0;
  let removes = 0;
  for (const p of staged) {
    if (p.kind === 'add-page') adds += 1;
    else if (p.kind === 'generate-pages') adds += Math.max(1, Number(p.count) || 1);
    else if (p.kind === 'remove-page') removes += 1;
  }
  return { adds, removes };
}

/** True when a staged remove already names this page (by id, or by its old position). */
function alreadyRemoving(staged: ReadonlyArray<AgentProposal>, pageId: string, position: number): boolean {
  return staged.some((p) => p.kind === 'remove-page' && (p.pageId ? p.pageId === pageId : p.targetIndex === position));
}

export type RemovePlan =
  | { ok: true; proposal: Omit<StructureProposal, 'id'>; note: string }
  | { ok: false; error: string };

/**
 * Stage the removal of page `n`, pinned to its id (C06).
 *
 * Refused while the model can still say so, instead of failing after the user
 * pressed Apply: a page that does not exist, the same page twice, or the last page
 * (the magazine must keep one; the delete endpoint refuses it too). `targetIndex`
 * stays on the proposal only for an older client that does not read `pageId`.
 */
export function planRemovePage(
  rows: ReadonlyArray<PageRow>,
  n: number,
  staged: ReadonlyArray<AgentProposal>,
  opts: { openIndex: number; readable?: ReadonlySet<string> },
): RemovePlan {
  const at = pageAtNumber(rows, n, opts);
  if (!at.ok) return at;
  if (alreadyRemoving(staged, at.pageId, n - 1)) {
    return { ok: false, error: `Removing page ${n} is already staged — nothing more to do for it.` };
  }
  const { removes } = stagedPageDelta(staged);
  if (rows.length - removes - 1 < 1) {
    return { ok: false, error: 'A magazine must keep at least one page, so this one cannot be removed as well.' };
  }
  const name = pageName(n, at.row);
  const summary = `Remove ${name}${at.isOpen ? ' — the page that is open now' : ''}`;
  return {
    ok: true,
    proposal: { kind: 'remove-page', pageId: at.pageId, pageNumber: n, targetIndex: n - 1, summary },
    note: 'A deleted page cannot be brought back with undo — say so in your reply. Page numbers in later requests this turn still mean the magazine as it is now, before any staged change.',
  };
}

export type ReorderPlan =
  | { ok: true; proposal: Omit<StructureProposal, 'id'>; note: string }
  | { ok: false; error: string };

/**
 * Stage moving page `from` so it becomes page `to`, both pinned to ids (C06).
 *
 * `pageId` is the page to move and `toPageId` the page now sitting at the
 * destination: on Apply the moved page lands where that page is THEN, so a move
 * staged next to deletions or other moves still lands where the user pointed. The
 * 0-based `from`/`to` stay for an older client.
 */
export function planReorderPage(
  rows: ReadonlyArray<PageRow>,
  from: number,
  to: number,
  opts: { openIndex: number; readable?: ReadonlySet<string> },
): ReorderPlan {
  const at = pageAtNumber(rows, from, opts);
  if (!at.ok) return at;
  const ordered = orderedPages(rows);
  const total = ordered.length;
  if (!Number.isInteger(to) || to < 1 || to > total) {
    return { ok: false, error: `This magazine has ${total} page${total === 1 ? '' : 's'}, so a page cannot become page ${to} — the last position is ${total}.` };
  }
  if (to === from) return { ok: false, error: `That is already page ${from} — nothing to move.` };
  const dest = ordered[to - 1]!;
  const summary = `Move ${pageName(from, at.row)} to become page ${to}`;
  return {
    ok: true,
    proposal: {
      kind: 'reorder-page',
      pageId: at.pageId,
      pageNumber: from,
      toPageId: String(dest._id),
      from: from - 1,
      to: to - 1,
      summary,
    },
    note: 'Page numbers in later requests this turn still mean the magazine as it is now, before any staged change.',
  };
}

export type InsertPlan = { ok: true; atIndex?: number; where: string } | { ok: false; error: string };

/**
 * Where new pages go, from the 1-based position the first one should BECOME.
 *
 * A position past the end is the end — said so in the summary rather than promising
 * "becomes page 40" in a 12-page magazine. Position 1 is refused for designed pages:
 * they are interior pages and the generate endpoint will not put one in front of the
 * cover.
 */
export function planInsert(total: number, position: number | undefined, opts: { allowFront: boolean }): InsertPlan {
  if (position == null) return { ok: true, atIndex: undefined, where: ' (at the end)' };
  if (position === 1 && !opts.allowFront) {
    return { ok: false, error: 'New pages are interior pages, so they cannot go in front of the cover. Use position 2 or later.' };
  }
  if (position > total + 1) {
    return { ok: true, atIndex: undefined, where: ` at the end (the magazine has ${total} page${total === 1 ? '' : 's'}, so there is no page ${position} yet)` };
  }
  return { ok: true, atIndex: position - 1, where: ` — becomes page ${position} (later pages shift down)` };
}

/** Why adding `adding` more pages would break the magazine's page cap, or null. */
export function pageBudgetRefusal(total: number, staged: ReadonlyArray<AgentProposal>, adding: number, max = MAX_PAGES_PER_ISSUE): string | null {
  const { adds, removes } = stagedPageDelta(staged);
  const after = total - removes + adds + adding;
  if (after <= max) return null;
  const room = Math.max(0, max - (total - removes + adds));
  return `A magazine can have at most ${max} pages${room > 0 ? `, so only ${room} more can be added` : ', and this one is full'}.`;
}

// ── What a layout rebuild does to the words ─────────────────────────────────

/**
 * What a layout rebuild really does, in the words every tool and note uses (C09/C31).
 *
 * The apply-layout route RECREATES the page: it clears it, builds the new design and
 * drafts fresh copy for every text slot (on the page's own subject), reusing only the
 * photos — a deliberate product decision. The tools used to promise the opposite,
 * "the page keeps the user's own words", and the model relayed it; the user's
 * corrected copy was then replaced, with no undo.
 */
export const REBUILD_EFFECT =
  'the page is cleared and rebuilt in that design: its photos are reused, but every text box gets NEWLY WRITTEN copy on the page’s subject (its current words are replaced), and this cannot be undone';

/** Text boxes with real words on a page (furniture left out): what a rebuild rewrites. */
export function textBoxesWithWords(elements: unknown): number {
  return storyTexts(elements).length;
}

/** The note a staged rebuild returns to the model — what to tell the user before they apply. */
export function rebuildNote(textBoxes: number): string {
  const words =
    textBoxes > 0
      ? `The ${textBoxes} text box${textBoxes === 1 ? '' : 'es'} on that page now ${textBoxes === 1 ? 'is' : 'are'} NOT kept: `
      : '';
  return (
    'This matches the composition — where things sit and how big they are — not an exact copy, and nothing is taken from the reference itself. ' +
    `${words}on Apply ${REBUILD_EFFECT}. Tell the user that plainly in your reply` +
    (textBoxes > 0 ? ', and suggest they copy out any wording they want to keep before applying.' : '.')
  );
}

// ── Documents ───────────────────────────────────────────────────────────────

/** A source document row (uploaded on the way into a magazine), as listing needs it. */
export interface SourceDocLike {
  _id: unknown;
  originalName?: unknown;
  contentType?: unknown;
  status?: unknown;
  coverage?: { pagesTotal?: unknown } | null;
}

/** A media-library row; only `kind: 'doc'` rows are documents. */
export interface MediaDocLike {
  _id: unknown;
  kind?: unknown;
  originalName?: unknown;
  alt?: unknown;
  contentType?: unknown;
  sourceText?: unknown;
}

export interface DocumentRow {
  docId: string;
  name: string;
  /** 0 = unknown (a chat attachment was never read page by page), not "empty". */
  pages: number;
  status: string;
  /** A PDF: its page design can be copied (use_document_as_layout, copy_document_page). */
  canCopyLayout: boolean;
  /** read_document can return its words now. */
  hasText: boolean;
  /** How it arrived: built from ('source') or attached in the chat / Uploads ('attached'). */
  from: 'source' | 'attached';
}

/** A source document's text is readable once its read has finished (fully or in part). */
export const sourceDocReadable = (status: unknown): boolean => status === 'ready' || status === 'partial';

/**
 * Both document stores as one list (magazineDocs.ts explains why there are two).
 *
 * Source documents first; a chat attachment with the same NAME as one is left out,
 * because attaching a file still writes it to both and the source copy is the one
 * that knows its page count. `hasText` says whether read_document can return words —
 * a scan, or a source still being read, cannot — so the model does not promise what
 * the document cannot give (C27).
 */
export function documentRows(sources: ReadonlyArray<SourceDocLike>, media: ReadonlyArray<MediaDocLike>, max = 20): DocumentRow[] {
  const rows: DocumentRow[] = sources.map((d) => ({
    docId: String(d._id),
    name: String(d.originalName ?? 'document'),
    pages: Math.max(0, Math.floor(Number(d.coverage?.pagesTotal) || 0)),
    status: String(d.status ?? ''),
    // Said plainly rather than left for the model to infer from the mime type: only a
    // PDF has a page design, and a Word file that looks like a document in every other
    // respect does not.
    canCopyLayout: d.contentType === 'application/pdf',
    hasText: sourceDocReadable(d.status),
    from: 'source' as const,
  }));
  const seen = new Set(rows.map((r) => r.name.toLowerCase()));
  for (const m of media) {
    if (m.kind !== 'doc') continue;
    const name = String(m.originalName ?? m.alt ?? 'document');
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    rows.push({
      docId: String(m._id),
      name,
      pages: 0,
      status: 'ready',
      canCopyLayout: String(m.contentType ?? '') === 'application/pdf',
      hasText: typeof m.sourceText === 'string' && m.sourceText.trim().length > 0,
      from: 'attached',
    });
  }
  return rows.slice(0, max);
}

/** Why page `sourcePage` of a document cannot be used, or null. A count of 0 is
 *  unknown, so it never refuses (the worker or the reader finds out). */
export function sourcePageRefusal(doc: { name: string; pages: number }, sourcePage: number): string | null {
  if (!Number.isInteger(sourcePage) || sourcePage < 1) return `Page numbers of a document start at 1.`;
  if (doc.pages > 0 && sourcePage > doc.pages) {
    return `“${doc.name}” has ${doc.pages} page${doc.pages === 1 ? '' : 's'}, so there is no page ${sourcePage}.`;
  }
  return null;
}

/** Most read_document calls one turn may make: each returns up to ~8k characters, and
 *  every one of them stays in the conversation for the rest of the turn. */
export const MAX_DOCUMENT_READS_PER_TURN = 4;

/** What to rank a document's passages by: the model's own query, else the user's
 *  latest words, else nothing (an even sample across the document). */
export function documentQuery(query: unknown, request: unknown): string | undefined {
  const pick = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 600) : '');
  return pick(query) || pick(request) || undefined;
}

/** The tray line for a staged PDF page copy. */
export function copyPageSummary(docName: string, sourcePage: number, target?: { number: number; name: string }): string {
  const onto = target ? `onto ${target.name}` : 'onto this page';
  return `Copy page ${sourcePage} of “${docName.replace(/[“”]/g, '"')}” ${onto} — its own text, pictures and colours replace what is there`;
}

/** What a staged copy does, for the model to tell the user before they apply (C14). */
export const COPY_PAGE_NOTE =
  'On Apply, everything on the page is replaced by that PDF page — its own words, pictures and colours — and the page takes the PDF page’s shape (it may end up a different size from the rest of the magazine). It runs as a background job for up to a minute and cannot be undone. Tell the user that plainly.';

/** One document named for new pages, as the add tool found it. */
export interface PagesDocState {
  name: string;
  store: 'source' | 'media';
  /** Its words can be read now. */
  readable: boolean;
  /** A source document whose read has not finished yet. */
  reading: boolean;
}

/**
 * Whether new pages can be written from these documents, and what to tell the user
 * (C28). Mirrors the generate endpoint, so the model hears now what Apply would hit:
 * a document still being read is refused (the pages would be written without it);
 * one with no readable text is left out, and if none has text the request is
 * refused; and when source documents and chat attachments are named together the
 * endpoint builds from the source documents only.
 *
 * `use` lists the positions (in `docs`) of the documents the pages will really be
 * written from — the only ones the proposal should carry and the summary name.
 */
export function pagesFromDocuments(
  docs: ReadonlyArray<PagesDocState>,
): { ok: true; note: string; use: number[] } | { ok: false; error: string } {
  if (docs.length === 0) return { ok: true, note: '', use: [] };
  const reading = docs.find((d) => d.reading);
  if (reading) {
    return { ok: false, error: `“${reading.name}” is still being read — add the pages once it has finished (it shows as ready in Sources).` };
  }
  const readable = docs.map((d, i) => (d.readable ? i : -1)).filter((i) => i >= 0);
  if (readable.length === 0) {
    const one = docs.length === 1;
    return {
      ok: false,
      error: `${one ? `“${docs[0]!.name}” has` : 'Those documents have'} no readable text stored (a scan, or a picture of text), so no pages can be written from ${one ? 'it' : 'them'}. Ask the user to attach a PDF with selectable text, or describe the pages as a topic.`,
    };
  }
  const anySource = readable.some((i) => docs[i]!.store === 'source');
  const use = anySource ? readable.filter((i) => docs[i]!.store === 'source') : readable;
  const left = docs.filter((_, i) => !use.includes(i)).map((d) => d.name);
  const note = left.length
    ? `Left out (no readable text, or a chat attachment named together with the magazine’s source documents): ${left.map((n) => `“${n}”`).join(', ')}. Tell the user.`
    : '';
  return { ok: true, note, use };
}

/** The tray line for staged designed pages. */
export function generatePagesSummary(o: { count: number; topic?: string; where: string; docNames?: string[] }): string {
  const n = o.count;
  const from = o.docNames && o.docNames.length > 0 ? ` from ${o.docNames.map((d) => `“${d.replace(/[“”]/g, '"')}”`).join(' and ')}` : '';
  return `Design ${n} new page${n === 1 ? '' : 's'}${o.topic ? ` on “${o.topic}”` : ''}${from}${o.where}`;
}

// ── Changes an earlier turn staged (C05) ────────────────────────────────────
//
// A turn used to start from the STORED page with an empty tray, and the client
// replaced its tray with the new turn's list: "make the headline bigger" (staged),
// then "and make it red", and the bigger headline vanished without a word. The client
// now sends what is still waiting; the turn replays it onto its working copy before
// the model runs, so the new turn sees the page as it will be and returns the
// combined list.

/** A staged proposal as it comes back from the client (studioRequests.PendingProposal
 *  fits this shape). Untrusted: everything is re-checked on replay. */
export interface StagedLike {
  id: string;
  kind: string;
  summary: string;
  elementId?: string;
  tempId?: string;
  patch?: Record<string, unknown>;
  element?: Record<string, unknown>;
  [field: string]: unknown;
}

export interface DroppedStaged {
  id: string;
  summary: string;
  reason: string;
}

export interface ReplayResult {
  /** The page with every kept change applied — what the model is shown. */
  working: MagazineElement[];
  /** The changes kept, in their original order and unchanged (the client recognises
   *  them by id and summary). */
  proposals: AgentProposal[];
  /** Changes that could not be kept, each with the reason, for the model to relay. */
  dropped: DroppedStaged[];
  /** Where pid() must continue so a new id or placeholder cannot repeat a kept one. */
  seq: number;
}

const KNOWN_KINDS: ReadonlySet<string> = new Set<Kind>([
  'update',
  'add',
  'delete',
  'add-page',
  'remove-page',
  'reorder-page',
  'generate-pages',
  'apply-layout',
  'copy-document-page',
  // Kept unchanged like a page change: it has no effect on the elements. Without it
  // here, a staged background vanished with no dropped entry whenever a list holding
  // one was replayed (unstage_changes and clear_page set backgrounds aside first).
  'set-background',
]);

/**
 * The highest proposal number used in a list — `p7`, `tmp_p7`, or a client-tagged
 * `t123-p7` all count as 7 — so the turn's next id is past every one of them.
 */
export function stagedSeq(list: ReadonlyArray<{ id?: unknown; tempId?: unknown }>): number {
  let max = 0;
  for (const p of list) {
    for (const v of [p.id, p.tempId]) {
      const m = typeof v === 'string' ? /p(\d{1,9})$/.exec(v) : null;
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return max;
}

/**
 * Replay changes staged earlier onto the page as loaded.
 *
 *  - update: merged into its element through the same write pipeline the apply will
 *    use (normalizeElementPatch), so the model sees sizes as they will be stored.
 *  - add: placed under its placeholder id, so a later update to it composes.
 *  - delete: the element leaves the working copy.
 *  - page changes, whole-page changes and a background change: kept, nothing to apply
 *    to the elements.
 *
 * DROPPED, with a reason, rather than kept: an edit whose element is gone or is now
 * locked (applying it would fail), anything the write pipeline rejects, and — when a
 * whole-page change is in the list — everything else, because the web applies that
 * on its own and would drop the rest anyway.
 */
export function replayStaged(
  elements: ReadonlyArray<MagazineElement>,
  staged: ReadonlyArray<StagedLike>,
  page: { width: number; height: number },
): ReplayResult {
  let working: MagazineElement[] = elements.map((e) => ({ ...e }));
  const proposals: AgentProposal[] = [];
  const dropped: DroppedStaged[] = [];
  const drop = (p: StagedLike, reason: string) => dropped.push({ id: String(p.id), summary: String(p.summary ?? p.kind), reason });
  const ex = staged.find((p) => isExclusiveKind(p.kind));

  for (const p of staged) {
    if (!p || typeof p.id !== 'string' || !KNOWN_KINDS.has(p.kind)) continue;
    if (ex && p !== ex) {
      drop(p, `${exclusiveName(ex.kind)} is staged with it, and that is applied on its own`);
      continue;
    }
    if (p.kind === 'update' || p.kind === 'delete') {
      const target = working.find((e) => e.id === p.elementId);
      if (!target) {
        drop(p, 'its element is no longer on the page');
        continue;
      }
      // The flag on the page as loaded: the user may have locked it since the change
      // was staged, and the element write now refuses a locked element.
      if (target.locked === true) {
        drop(p, 'that element has been locked since');
        continue;
      }
      if (p.kind === 'delete') {
        working = working.filter((e) => e.id !== target.id);
      } else {
        const patch = p.patch && typeof p.patch === 'object' ? p.patch : null;
        const next = patch ? (normalizeElementPatch(target, patch, page) ?? null) : null;
        if (!next) {
          drop(p, 'it could not be applied to the page as it is now');
          continue;
        }
        working = working.map((e) => (e.id === target.id ? next : e));
      }
    } else if (p.kind === 'add') {
      const tempId = typeof p.tempId === 'string' ? p.tempId : '';
      if (!tempId || !p.element || typeof p.element !== 'object') {
        drop(p, 'it was incomplete');
        continue;
      }
      if (working.some((e) => e.id === tempId)) {
        drop(p, 'it was staged twice');
        continue;
      }
      if (working.length >= MAX_ELEMENTS_PER_PAGE) {
        drop(p, 'the page is full');
        continue;
      }
      const [clean] = normalizeElements([{ ...p.element, id: tempId }], page);
      if (!clean) {
        drop(p, 'it could not be built');
        continue;
      }
      working.push(clean);
    }
    proposals.push(p as unknown as AgentProposal);
  }
  return { working, proposals, dropped, seq: stagedSeq(staged) };
}

/**
 * The prompt lines that tell the model what is already staged — so it builds on it
 * and neither repeats it nor tells the user it is gone. Empty when nothing is staged
 * or dropped.
 */
export function stagedPromptLines(kept: ReadonlyArray<Pick<AgentProposal, 'id' | 'summary'>>, dropped: ReadonlyArray<DroppedStaged> = []): string[] {
  const lines: string[] = [];
  const show = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 160);
  if (kept.length > 0) {
    lines.push(
      'ALREADY STAGED — changes from earlier in this chat, still waiting for the user to apply (the element list below already shows the page with them):',
      ...kept.slice(0, 25).map((p) => `- ${p.id}: ${show(p.summary)}`),
      ...(kept.length > 25 ? [`- …and ${kept.length - 25} more`] : []),
      'Build on them and never stage them again: they are applied together with anything you stage now. Take one out with unstage_changes only when the user asks to drop it.',
    );
  }
  if (dropped.length > 0) {
    lines.push(
      'These earlier staged changes could NOT be kept — tell the user in one line:',
      ...dropped.slice(0, 10).map((d) => `- “${show(d.summary)}”: ${d.reason}`),
    );
  }
  return lines;
}

export interface UnstageResult {
  /** What stays staged, in order. */
  proposals: AgentProposal[];
  /** The page with only those applied. */
  working: MagazineElement[];
  /** Taken out because they were asked for by id. */
  removed: AgentProposal[];
  /** Taken out because they edit an element a removed `add` would have created. */
  alsoRemoved: AgentProposal[];
  /** Ids asked for that are not staged. */
  unknown: string[];
}

/**
 * Take staged changes out by id and rebuild the working copy from the page as loaded.
 *
 * An edit to an element that a removed `add` would have created goes with it — it
 * would otherwise fail on Apply, aimed at a box that never appears.
 */
export function withoutStaged(
  original: ReadonlyArray<MagazineElement>,
  proposals: ReadonlyArray<AgentProposal>,
  ids: ReadonlyArray<string>,
  page: { width: number; height: number },
): UnstageResult {
  const wanted = new Set(ids);
  const removed = proposals.filter((p) => wanted.has(p.id));
  const unknown = ids.filter((id) => !proposals.some((p) => p.id === id));
  const gone = new Set(removed.filter((p) => p.kind === 'add' && p.tempId).map((p) => p.tempId!));
  const alsoRemoved = proposals.filter((p) => !wanted.has(p.id) && !!p.elementId && gone.has(p.elementId));
  const out = new Set([...removed, ...alsoRemoved].map((p) => p.id));
  const remaining = proposals.filter((p) => !out.has(p.id));
  const replay = replayStaged(original, remaining as unknown as StagedLike[], page);
  return { proposals: remaining, working: replay.working, removed, alsoRemoved, unknown };
}
