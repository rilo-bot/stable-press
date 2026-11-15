// ---------------------------------------------------------------------------
// Magazine Builder v2 — editor state (Zustand).
//
// Element writes are optimistic + rev-guarded: local edits render instantly;
// commit() sends the change with the page `rev`; a 409 means someone else wrote
// the page, so we reconcile to the server's current page (and tell the user).
// Undo/redo covers every ELEMENT write — update, add AND delete — whoever made
// it: a drag, the inspector, a Fill/Adjust pass, or the AI assistant applying its
// proposals. Writes are recorded as inverse-able ops and grouped into ONE stack
// entry per user action, so "apply the assistant's changes" (often a dozen adds,
// deletes and updates at once) undoes as a single Ctrl+Z rather than needing
// twelve of them — half-undone being indistinguishable from broken.
// Page-structure ops (add/remove/reorder/generate page) and a layout rebuild are
// still NOT on the stack: they replace or destroy whole pages, and both paths warn
// the user first. A page's BACKGROUND is on it, as one more reversible op.
//
// STAGED CHANGES ARE KEPT PER PAGE (`pending`), across messages, page switches and
// reloads, until the user applies or discards them — see pendingChanges.ts for why.
// ---------------------------------------------------------------------------

import { create } from 'zustand';
import { toast } from 'sonner';
import type { MagazineElement, MagazinePageV2, AgentProposal, PageCheck, ChartSpec, PageBackgroundInput } from './model';
import * as api from './api';
import { ApiError, type IssueMeta, type PageSummary } from './api';
import { copyFailureText } from './pageCopy';
import {
  appliedMessage,
  insertIndexFor,
  inOrder,
  isExclusiveKind,
  isPageKind,
  pageHeadline,
  planPageSteps,
  removalQuestion,
  reorderIndices,
} from './proposals';
import {
  accumulateTurn,
  applyOutcome,
  applyReportLine,
  changeCount,
  claimsChange,
  foldChanges,
  hasStagedLine,
  holdStaleTextChanges,
  MAX_SENT_PER_TURN,
  orphanPageIds,
  otherPagesTail,
  pagesPhrase,
  parsePending,
  pendingFor,
  pendingStorageKey,
  pendingTotal,
  rebaseForReplace,
  serializePending,
  stagedLine,
  trayFor,
  waitingPages,
  withoutPages,
  withPage,
  type PageApplyReport,
  type PendingByPage,
} from './pendingChanges';

/** A file the user attached to a chat turn, shown as a chip inside their sent
 *  message bubble (so the attachment reads as "sent", not stuck in the input). */
export interface ChatAttachmentRef {
  name: string;
  isImage: boolean;
  url?: string; // media-library URL for images (thumbnail); undefined for docs
  /** A document's stored upload id — what later turns read it back by. */
  docId?: string;
}
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  attachments?: ChatAttachmentRef[];
  /** Present on messages loaded from the persisted server thread (used as the
   *  paging cursor identity + optional page tag); absent on optimistic in-session
   *  messages until the next reload pulls them back from the server. */
  id?: string;
  pageIndex?: number | null;
  createdAt?: string;
  /**
   * Assistant replies only: the line shown under the reply saying what the turn
   * REALLY staged ("Waiting for Apply: 2 changes on page 3 — …", "Nothing was
   * changed."). Built from the proposals, never from the reply — see
   * pendingChanges.stagedLine. Present on in-session replies.
   */
  note?: string;
}

/** What the last Design Helper turn really did — read by The Stable Hand, which must
 *  report this and not the model's own account of it. */
export interface StudioTurnRecord {
  pageId: string;
  /** Changes this turn staged. */
  added: number;
  /** Everything waiting on that page now. */
  onPage: number;
  /** The deterministic line (the server's, else the panel's own). */
  line: string;
  /** The reply says it changed something while the turn staged nothing. */
  claimedWithoutChange: boolean;
  at: number;
}

/** Map a persisted server chat message into the in-store shape. */
const dtoToChat = (m: api.ChatMsgDto): ChatMessage => ({
  role: m.role,
  content: m.content,
  id: m.id,
  pageIndex: m.pageIndex,
  createdAt: m.createdAt,
  attachments: m.attachments,
});

/** A chat attachment surfaced in the right pane (docks over the Inspector). */
export interface PreviewDoc {
  name: string;
  isImage: boolean;
  imageUrl?: string; // object URL for image attachments
  text?: string; // extracted text for PDF/text attachments
  /** The document's own URL, when it can be rendered in-browser (PDFs — served
   *  inline by GET /file/*). Lets the pane show the REAL file, with `text` (what
   *  generation actually consumes) behind a toggle. */
  docUrl?: string;
}

/**
 * One reversible element write.
 *
 * `add` and `delete` both carry the WHOLE element, not just its id: undoing a
 * delete has to put the element back exactly as it was (same id — see the
 * `restore` flag on api.addElement — same geometry, same content), and redoing an
 * add has to re-create it the same way.
 */
type UndoOp =
  | { op: 'update'; pageId: string; elementId: string; before: MagazineElement; after: MagazineElement }
  | { op: 'add'; pageId: string; element: MagazineElement }
  | { op: 'delete'; pageId: string; element: MagazineElement }
  /** The page's own background — both ends are what the server stored. */
  | { op: 'background'; pageId: string; before: MagazinePageV2['background']; after: MagazinePageV2['background'] };

/** One Ctrl+Z's worth of work: a single edit, or every write of one AI apply. */
interface UndoEntry {
  /** Human phrase for the toolbar tooltip ("Undo the assistant's changes"). */
  label: string;
  /** In the order they were applied. Undo walks them backwards, redo forwards. */
  ops: UndoOp[];
}

interface EditorState {
  issueId: string | null;
  issue: IssueMeta | null;
  pages: PageSummary[];
  currentPageId: string | null;
  page: MagazinePageV2 | null; // full current page (elements + rev)
  selectedId: string | null;
  zoomWidth: number; // rendered page width in px
  loading: boolean;
  error: string | null;
  generating: boolean; // ANY build run is in flight (initial generation OR add-pages)
  adding: boolean; // specifically an "add more pages" run — drives the isAdding copy. Was conflated with `generating`, which made the INITIAL build show the indeterminate "Adding your new pages" state and hid the real page counter.
  justGenerated: boolean; // a from-scratch generation just finished this session (offer "add more pages")
  formatBusy: boolean; // a Fill/Adjust text pass is running
  publishing: boolean; // a publish/unpublish call is in flight
  reviewBusy: boolean; // a submit/approve/request-changes call is in flight
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];

  // AI editing assistant (per open page)
  chat: ChatMessage[];
  chatBusy: boolean;
  chatHasMore: boolean;
  chatOldest: string | null;
  chatLoadingOlder: boolean;
  // ── Threads ──
  // The conversation list, and which one the transcript above belongs to.
  threads: api.ChatThread[];
  threadsLoading: boolean;
  /** null = a new, not-yet-created chat: the first turn creates it server-side. */
  activeThreadId: string | null;
  loadThreads: () => Promise<void>;
  /** Switch the transcript to a thread. Staged changes are NOT touched: they belong to
   *  their PAGE, not to a conversation, and switching chats used to throw them away. */
  openThread: (threadId: string) => Promise<void>;
  /** A blank chat. Nothing is written until the first message is sent. */
  newThread: () => void;
  renameThread: (threadId: string, title: string) => Promise<void>;
  removeThread: (threadId: string) => Promise<void>;
  /**
   * EVERY staged change waiting for Apply, by page id — the source of truth.
   *
   * Changes accumulate across messages and across pages, survive page switches, and
   * are saved per magazine in this browser (localStorage), so a reload keeps them. A
   * set leaves only by being applied (or refused by the server on apply), by being
   * discarded — which offers "Bring back" — or with its page.
   */
  pending: PendingByPage;
  /**
   * The OPEN page's waiting changes (a mirror of `pending[currentPageId]`), and that
   * page's id when it has any. Kept so everything that read the single tray — the
   * panel's tray, the page rail's marker, The Stable Hand — still reads the right
   * thing for the page on screen. Never written on its own: every write goes through
   * `pending`, and these follow.
   */
  proposals: AgentProposal[];
  proposalsPageId: string | null;
  /** "Use these changes" (one page) or "Apply all" is running. The buttons are
   *  disabled meanwhile, and an automation waits on this rather than on the tray
   *  emptying — a page build that could not start yet stays waiting. */
  applyingProposals: boolean;
  /**
   * Apply every page's waiting changes, in page order — or only `onlyPageId`'s. Each
   * page is opened in turn (its own rev), its set applied as on its own tray, and one
   * Ctrl+Z takes the element edits of the whole run back. Resolves with what happened
   * on each page (also kept as `lastApplyReport`); null when it could not start.
   */
  applyAllWaiting: (onlyPageId?: string) => Promise<PageApplyReport[] | null>;
  /** Per page, what the last apply did. */
  lastApplyReport: PageApplyReport[] | null;
  /**
   * Throw away waiting changes — one page's, or every page's when no id is given.
   * The toast offers "Bring back" for a while, so a slip loses nothing. Returns how
   * many were discarded.
   */
  discardWaiting: (pageId?: string) => number;
  /** What the last Design Helper turn really staged (see StudioTurnRecord). */
  lastTurn: StudioTurnRecord | null;
  /**
   * What the last page build asked to write FROM documents was really given, as the
   * server echoed it (null for a build without documents, or before any). Lets a
   * caller say "written from Results.pdf" only when the server took that document.
   */
  lastBuildSources: api.BuildSources | null;
  /**
   * Set the OPEN page's background — a colour, a library picture, or none. One undo
   * step, rev-guarded like an element write. False when the server refused it (said
   * in a toast).
   */
  setPageBackground: (background: PageBackgroundInput) => Promise<boolean>;
  /**
   * The page check the last turn came back with: what its changes would leave wrong
   * on the page (text cut off, a hidden picture…). Only ever NEW errors — the server
   * leaves out what was already wrong before the turn. Shown as the panel's
   * "N problems · Fix" chip while `lastCheckPageId` is the open page.
   */
  lastCheck: PageCheck | null;
  lastCheckPageId: string | null;
  /** The changes the check describes have been applied (the chip says "on this
   *  page" rather than "after these changes"). */
  lastCheckApplied: boolean;
  /** Hide the problems chip (the user has seen it, or moved on). */
  dismissCheck: () => void;
  /**
   * Bumped whenever this tab stores a document or picture in the magazine's
   * libraries. The PDF pickers and the Uploads tab re-read on it, so a PDF sent in
   * chat shows up in "Copy a page exactly" without a reload.
   */
  uploadsVersion: number;
  noteUploadsChanged: () => void;
  /** When set, the right pane shows this attachment instead of the Inspector. */
  previewDoc: PreviewDoc | null;
  setPreviewDoc: (d: PreviewDoc | null) => void;
  sendChat: (
    text: string,
    sourceText?: string,
    attachedImages?: api.AttachedImage[],
    attachments?: ChatAttachmentRef[],
    extras?: { attachedDocs?: api.AttachedDoc[] },
  ) => Promise<void>;
  loadOlderChat: () => Promise<void>;
  /** "Use these changes": apply the OPEN page's waiting changes. */
  applyAllProposals: () => Promise<void>;
  /** "Don't use these": discard the open page's waiting changes (with "Bring back"). */
  discardProposals: () => void;
  /**
   * Pages a PDF copy staged in chat ('copy-document-page') is being written to right
   * now. The copy runs in the worker; the store follows it (see followPageCopy) until
   * the copied page is on screen, and an automation waits on this list emptying.
   */
  copyingPageIds: string[];
  /**
   * Draw a chart from exact numbers (POST …/chart) and put it on the OPEN page as one
   * undoable step: an add, or — with `replaceElementId`, or an empty picture slot the
   * server chose — a patch of that picture (any other element is swapped for it).
   * Null when it was not placed (the reason is toasted). `dataEcho` lists every number
   * as drawn, to check against what the user gave.
   */
  placeChart: (
    chart: ChartSpec,
    opts?: { box?: { x: number; y: number; w: number; h: number }; replaceElementId?: string },
  ) => Promise<{ elementId: string; dataEcho: string } | null>;
  /**
   * Replace a word or name across every page the user may edit (POST …/replace-text).
   * With `dryRun` it only counts. When it really replaced, the pages it rewrote are
   * re-read — the server wrote them, so the canvas and the rail would otherwise keep
   * showing the old words and every later edit there would be refused as stale.
   * Null when the request failed (toasted).
   */
  /** A magazine-wide find and replace (POST …/replace-text). After a real run the
   *  changes waiting for Apply get the same replacement (`waitingUpdated` counts them),
   *  so applying them later cannot write the old words back. Refused (null, with a
   *  toast) while a Design Helper turn is in flight. */
  replaceTextInMagazine: (body: { find: string; replace: string; matchCase?: boolean; wholeWord?: boolean; dryRun?: boolean }) => Promise<(api.ReplaceTextResult & { waitingUpdated?: number }) | null>;

  /**
   * Full page data for the thumbnail rail, keyed by pageId.
   *
   * The rail draws real pages, and a PageSummary carries only an element COUNT — so
   * each page has to be fetched once. It is filled LAZILY (a tile asks when it first
   * scrolls into view) rather than up front, because a 40-page magazine would
   * otherwise fire 40 requests to draw a strip the user may never scroll.
   */
  thumbs: Record<string, MagazinePageV2>;
  /** Fetch this page's thumbnail if we don't already have a current copy. Fire-and-
   *  forget: it never throws and never blocks anything the user is doing. */
  ensureThumb: (pageId: string) => void;

  load: (id: string) => Promise<void>;
  /**
   * Open a page (fetch its elements and make it the active one).
   *
   * `force` re-fetches a page that is ALREADY open. Without it the call is skipped,
   * which is right for scroll jitter but wrong for "re-read this page because its
   * server-side state just changed" — submitPages relied on the plain call to pick
   * up the read-only lock and got a silent no-op, leaving the canvas editable on a
   * page the server had already closed.
   */
  openPage: (pageId: string, force?: boolean) => Promise<void>;
  /**
   * NAVIGATE to a page: open it AND bring it into view.
   *
   * `openPage` alone is only half the job, and the missing half was a dead click for
   * as long as the page rail has existed. The canvas is a vertical stack of EVERY
   * page (EditorCanvas), so making page 6 "active" while the viewport is still on
   * page 2 changes nothing the user can see — and the canvas's scroll-settle picker
   * then hands the active page back to whatever is centred. Anything that means "take
   * me to this page" must call this, not openPage.
   */
  goToPage: (pageId: string) => Promise<void>;
  select: (id: string | null) => void;
  setZoomWidth: (w: number) => void;
  canManage: () => boolean;
  /** Can edit at least some pages (owner or collaborator). False = view-only. */
  canEdit: () => boolean;

  /** Live, local-only element update (drag/resize feedback — no server call). */
  updateLocal: (elementId: string, patch: Partial<MagazineElement>) => void;
  /**
   * Persist an element change (rev-guarded). `before` = state at edit start, for undo.
   *
   * Returns whether the server STORED it. Every write here reports success, because
   * these actions absorb their own errors (toast + reconcile) and a caller that
   * cannot tell a stored write from a refused one has no choice but to claim
   * success — which is exactly what applyAllProposals used to do over a whole
   * failed apply.
   */
  commit: (elementId: string, patch: Partial<MagazineElement>, before?: MagazineElement) => Promise<boolean>;
  /** The new element's server id, or null when the write was refused. */
  addElement: (partial: Partial<MagazineElement>) => Promise<string | null>;
  deleteElement: (elementId: string) => Promise<boolean>;
  /** Copy an element (offset slightly, on top) and select the copy. */
  duplicateElement: (elementId: string) => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  /**
   * Run `fn`'s element writes as ONE undo entry.
   *
   * Anything that makes several element writes on the user's behalf from a single
   * click — an AI apply, a Fill/Adjust pass — must go through this, or each write
   * lands as its own stack entry and Ctrl+Z only takes back a fraction of what the
   * user asked to take back. Nesting joins the outer batch rather than starting a
   * second one, so callers can compose freely.
   */
  batchEdits: <T>(label: string, fn: () => Promise<T>) => Promise<T>;

  addPage: () => Promise<void>;
  /**
   * Start an AI page build. False when it did not start — a build is already
   * running (said in a toast: it used to return silently, so a staged "design 2 new
   * pages" was reported applied and never happened) or the request was refused.
   * `docIds` = documents to write the new pages from.
   */
  generatePages: (count: number, topic?: string, atIndex?: number, docIds?: string[]) => Promise<boolean>;
  duplicatePage: (pageId: string) => Promise<void>;
  deletePage: (pageId: string) => Promise<void>;
  reorder: (from: number, to: number) => Promise<void>;
  rename: (title: string) => Promise<void>;
  setCover: (cover: { coverImage?: string; coverPageId?: string }) => Promise<boolean>;
  /** Delete the whole magazine (draft + pages + any published edition). */
  remove: () => Promise<boolean>;
  reset: () => Promise<void>;
  /** Fill/Adjust a page's text. Defaults to the open page; passing another
   *  pageId opens that page first, then runs the pass on it. */
  runFormat: (mode: 'fill' | 'adjust', pageId?: string) => Promise<void>;
  /** Toggle whether a page is included in "publish selected pages". */
  setPageSelected: (pageId: string, selected: boolean) => Promise<void>;
  /**
   * Rebuild the open page in a layout read from a reference image.
   *
   * REPLACES every element on the page, and the undo stack does not cover that — the
   * caller must confirm with the user first. Returns the MEASURED fidelity (P3) on
   * success, or null when nothing changed.
   */
  /** `targetPageId` rebuilds a page other than the open one — the assistant resolves it
   *  server-side from a page number the user said. Omitted = the page on screen. */
  /** `fit` defaults to 'exact' — "same layout" means same-to-same. See the implementation. */
  applyLayout: (reading: api.LayoutReading, targetPageId?: string, fit?: api.LayoutFit) => Promise<api.LayoutFidelity | null>;
  /** An "apply this layout" call is in flight. */
  layoutBusy: boolean;
  /** Publish (or republish) to Bulletins ('full' = all pages, 'selected' =
   *  flagged pages) → returns the public Bulletins issue id, or null on failure. */
  publish: (scope: 'full' | 'selected') => Promise<string | null>;
  unpublish: () => Promise<void>;
  /**
   * The draft has diverged from the live edition, so a republish is needed.
   *
   * Two sources, OR'd: what the server derived when the magazine was loaded, and
   * whether we have written anything ourselves since. The local half matters because
   * element writes return only `{element, rev}` — without it the studio would keep
   * saying "in sync" through a whole editing session on a published magazine, which is
   * the one moment the warning has to be right.
   */
  needsRepublish: () => boolean;
  /** Set by every successful write; cleared on load and on publish. */
  editedSinceLoad: boolean;

  // ── Submissions & approval (the review axis) ──
  // A submission is an EVENT over a set of pages, so all three take pageIds[] and
  // resolve to a single toast naming the pages that actually moved.
  /** Collaborator: send assigned pages to the owner for review. */
  submitPages: (pageIds: string[], note?: string) => Promise<boolean>;
  /** Owner: approve pages, recording the rev they were approved at. */
  approvePages: (pageIds: string[], note?: string) => Promise<boolean>;
  /** Owner: send pages back (doubles as reopen). `note` is required by the server. */
  requestChanges: (pageIds: string[], note: string) => Promise<boolean>;
  /** Re-fetch issue meta (collaborators, publish state) without reloading pages.
   *  False = the re-read failed, so what's on screen is stale; the caller decides
   *  whether that's worth saying (the Share dialog's list is the visible half of
   *  an action it just reported as done). */
  refreshIssue: () => Promise<boolean>;
  /** While an issue is still generating (status 'processing'), poll and reveal
   *  its pages as they land — no blocking screen. */
  watchGeneration: () => void;
  /** Stop the generation poll (on unmount / navigating away). */
  stopWatching: () => void;
  /** Dismiss the post-generation "add more pages" nudge. */
  clearJustGenerated: () => void;
}

const el = (p: MagazinePageV2 | null, id: string | null) => p?.elements.find((e) => e.id === id) ?? null;

/** A page's number as the canvas prints it (its index + 1), or 0 when it is not in
 *  the list. Never its POSITION in `pages`: a contributor shared only page 3 holds a
 *  one-item list, and position 1 is not "page 1". */
const pageNumberIn = (pages: PageSummary[], pageId: string | null | undefined): number => {
  const p = pageId ? pages.find((x) => x.id === pageId) : undefined;
  return p ? p.index + 1 : 0;
};

/**
 * Merge a META-ONLY issue response into state.
 *
 * Only GET /issues/:id carries the pages, and `needsRepublish` is derived FROM the
 * pages — so every other route (PATCH, publish/unpublish, collaborators) answers
 * `needsRepublish: false` unconditionally, not because it is false but because that
 * response had nothing to derive it from (see withViewer server-side). A wholesale
 * `set({ issue })` therefore ERASED a divergence the user still had to act on: rename
 * a published magazine and the "Needs republish" badge disappeared, while readers
 * kept seeing the old title. The flag is sticky here — only load() (which has the
 * server's real answer) and publish() (which just resolved it) clear it.
 */
const mergeIssue = (st: EditorState, incoming: IssueMeta): Partial<EditorState> => ({
  issue: {
    ...(st.issue ?? {}),
    ...incoming,
    needsRepublish: incoming.needsRepublish === true || st.issue?.needsRepublish === true,
  },
});

/**
 * Serialises page opens.
 *
 * `openPage` is fired from the canvas's scroll-settle picker, so a fast scroll
 * through a long magazine starts several fetches at once. They resolve in whatever
 * order the network hands them back, and the LAST TO RESOLVE used to win — which is
 * not the page the user stopped on. Each call takes a ticket; a response is applied
 * only if no newer open has started since.
 */
let openSeq = 0;

// Poll handle for watching a still-generating issue reveal its pages live (so
// "Build with AI" drops the user straight into the studio instead of a blocking
// loading screen). Module-scoped so it survives store updates but stays single.
let genPoll: ReturnType<typeof setTimeout> | null = null;
function stopGenPoll() { if (genPoll) { clearTimeout(genPoll); genPoll = null; } }

// Thumbnail fetches in flight. Module-scoped rather than in the store because it is
// pure de-duplication — nothing renders from it, and putting it in state would make
// every tile re-render each time any other tile started loading.
const thumbsInFlight = new Set<string>();

/**
 * The undo entry currently being collected, if a batch is open.
 *
 * Module-scoped for the same reason as the set above: it is bookkeeping, nothing
 * renders from it, and it must not cause a re-render on every write inside a
 * fifteen-proposal apply.
 */
let openBatch: UndoEntry | null = null;

/**
 * True while undo/redo is replaying — writes made by the replay itself must not be
 * recorded, or undo would push its own inverse back onto the stack and Ctrl+Z would
 * toggle the same change forever instead of walking back through history.
 */
let replaying = false;

/**
 * Undo/redo runs one entry at a time.
 *
 * A replay is several awaited round trips, and each one consumes the page `rev` the
 * previous one produced. Ctrl+Z held down (or pressed three times quickly) would
 * otherwise start three overlapping replays against the same rev: two of them 409,
 * and the user's history appears to skip entries at random. Serialising means a
 * held Ctrl+Z simply walks back through the stack in order, which is what it looks
 * like it is doing anyway.
 */
let replayChain: Promise<unknown> = Promise.resolve();
function enqueueReplay<T>(task: () => Promise<T>): Promise<T> {
  const next = replayChain.then(task, task);
  // The chain itself must never reject, or one thrown replay would wedge every
  // later undo behind a rejected promise.
  replayChain = next.catch(() => {});
  return next;
}

/**
 * Drop every stack entry that touches `pageId`.
 *
 * Called when a page is DELETED or rebuilt from a reference: its elements no longer
 * exist (or have been replaced wholesale), so entries naming them are ghosts. This
 * matters more now that undo can re-CREATE elements — a stale `delete` op replayed
 * against a rebuilt page would paste an orphan element back onto a layout that
 * never had it, which is worse than the old ghost `update` that simply 404'd.
 *
 * An entry is dropped whole rather than filtered op-by-op: half of a batch is not a
 * coherent thing to undo.
 */
const withoutPage = (stack: UndoEntry[], pageId: string) =>
  stack.filter((entry) => !entry.ops.some((op) => op.pageId === pageId));

/** Record one reversible write: into the open batch, or as its own stack entry. */
function record(set: (fn: (st: EditorState) => Partial<EditorState>) => void, op: UndoOp, label: string) {
  if (replaying) return;
  if (openBatch) {
    openBatch.ops.push(op);
    return;
  }
  set((st) => ({ undoStack: [...st.undoStack.slice(-59), { label, ops: [op] }], redoStack: [] }));
}

/**
 * Scroll the canvas stack to a page.
 *
 * Retries across a few frames because a page created a moment ago (add / duplicate /
 * generate) is in the store before React has put it in the DOM — without the retry,
 * "add a page" would scroll nowhere, which is the same dead click it is fixing.
 */
function scrollToPage(pageId: string, tries = 3): void {
  const node = document.querySelector(`[data-page="${pageId}"]`);
  if (node) {
    // `block: 'start'` leaves the page filling the viewport, so when the canvas's
    // scroll-settle picker runs it lands on this same page and doesn't undo us.
    node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (tries > 0) requestAnimationFrame(() => scrollToPage(pageId, tries - 1));
}

/**
 * The page an apply is writing to, while it writes.
 *
 * Every element write goes to the OPEN page, and each is a round trip. The canvas's
 * scroll-settle picker opens whatever page is centred, so a scroll during an apply
 * used to move the open page and the rest of the set was refused half way. While
 * this is set, only that page (or a forced re-read) may be opened; the picker's
 * next settle after the apply catches up with the scroll.
 */
let pinnedPageId: string | null = null;

/**
 * How the last applyLayout call ended. Its caller (applying a staged rebuild) has to
 * tell "the user said no at the confirm" — the rebuild stays waiting — from "it ran"
 * and from "it failed" (the reason was already toasted; it also stays waiting, to
 * try again or discard). applyLayout itself returns only the fidelity or null.
 */
let layoutOutcome: 'declined' | 'failed' | 'done' = 'done';

/** The waiting changes this browser kept for a magazine. Never throws: storage can be
 *  missing (private mode), full or corrupt, and none of that may stop a magazine
 *  from opening. */
function loadPending(issueId: string): PendingByPage {
  try {
    if (typeof localStorage === 'undefined') return {};
    return parsePending(localStorage.getItem(pendingStorageKey(issueId)), { now: Date.now() });
  } catch {
    return {};
  }
}

/** Keep a magazine's waiting changes in this browser (removed when there are none). */
function savePending(issueId: string, map: PendingByPage): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const key = pendingStorageKey(issueId);
    if (pendingTotal(map) === 0) {
      localStorage.removeItem(key);
      return;
    }
    const raw = serializePending(map, Date.now());
    // Too large to keep: leave the stored copy as it was rather than erase it. The
    // set still lives in memory for this session.
    if (raw) localStorage.setItem(key, raw);
  } catch {
    /* quota or a blocked storage — the set still lives in memory for this session */
  }
}

/** A state update that replaces the waiting-changes map and keeps the open page's
 *  tray (`proposals` / `proposalsPageId`) in step with it. */
const withPending = (st: Pick<EditorState, 'currentPageId'>, pending: PendingByPage): Partial<EditorState> => ({
  pending,
  ...trayFor(pending, st.currentPageId),
});

export const useEditorStore = create<EditorState>((set, get) => ({
  issueId: null,
  issue: null,
  pages: [],
  currentPageId: null,
  page: null,
  selectedId: null,
  zoomWidth: 720,
  loading: false,
  error: null,
  generating: false,
  adding: false,
  justGenerated: false,
  formatBusy: false,
  publishing: false,
  reviewBusy: false,
  editedSinceLoad: false,
  undoStack: [],
  redoStack: [],
  chat: [],
  threads: [],
  threadsLoading: false,
  activeThreadId: null,
  chatBusy: false,
  chatHasMore: false,
  chatOldest: null,
  chatLoadingOlder: false,
  pending: {},
  proposals: [],
  proposalsPageId: null,
  applyingProposals: false,
  lastApplyReport: null,
  lastTurn: null,
  lastBuildSources: null,
  lastCheck: null,
  lastCheckPageId: null,
  lastCheckApplied: false,
  dismissCheck: () => set({ lastCheck: null, lastCheckPageId: null, lastCheckApplied: false }),
  uploadsVersion: 0,
  noteUploadsChanged: () => set((st) => ({ uploadsVersion: st.uploadsVersion + 1 })),
  copyingPageIds: [],
  previewDoc: null,
  setPreviewDoc: (d) => set({ previewDoc: d }),
  thumbs: {},

  ensureThumb: (pageId) => {
    const { issueId, thumbs, pages } = get();
    if (!issueId || thumbsInFlight.has(pageId)) return;
    const summary = pages.find((p) => p.id === pageId);
    if (!summary) return;
    // A cached copy at the same rev is still accurate. Our own edits bump the OPEN
    // page's rev without touching its summary, which is fine: the rail renders the
    // open page from `page`, and openPage() hands the outgoing copy back to the cache.
    const have = thumbs[pageId];
    if (have && have.rev >= summary.rev) return;
    thumbsInFlight.add(pageId);
    void api
      .getPage(issueId, pageId)
      .then((page) => {
        // Guard the late response: the user may have opened another magazine.
        if (get().issueId === issueId) set((st) => ({ thumbs: { ...st.thumbs, [pageId]: page } }));
      })
      // A thumbnail is decoration. A failed fetch leaves the numbered placeholder in
      // place, which still navigates — so there is nothing worth interrupting for.
      .catch(() => {})
      .finally(() => { thumbsInFlight.delete(pageId); });
  },

  canManage: () => get().issue?.myRole === 'owner',
  canEdit: () => !!get().issue?.myRole,

  load: async (id) => {
    stopGenPoll();
    // editedSinceLoad resets here: the freshly-loaded `issue.needsRepublish` is the
    // server's own answer, so carrying a stale local flag across a reload would keep
    // claiming changes that were already published.
    // chatBusy/formatBusy are reset here too: they belong to a turn or a pass on the
    // magazine we are LEAVING, and an in-flight one whose response is discarded (see
    // sendChat) would otherwise leave the new magazine's composer disabled forever.
    //
    // The waiting changes this browser kept for THIS magazine come back here, before
    // anything else, so a reload never loses them (and the save that follows every
    // change to `pending` writes back exactly what was read).
    set({ loading: true, error: null, issueId: id, generating: false, adding: false, justGenerated: false, currentPageId: null, page: null, chat: [], pending: loadPending(id), proposals: [], proposalsPageId: null, lastApplyReport: null, lastTurn: null, lastBuildSources: null, editedSinceLoad: false, thumbs: {}, chatBusy: false, formatBusy: false, layoutBusy: false, applyingProposals: false, lastCheck: null, lastCheckPageId: null, lastCheckApplied: false, copyingPageIds: [] });
    try {
      const { issue, pages } = await api.getIssue(id);
      if (get().issueId !== id) return;
      set({ issue, pages, loading: false, undoStack: [], redoStack: [], selectedId: null });
      // Changes kept for pages that are no longer in the magazine can never land.
      // (Not while the list is empty — a magazine still uploading has no pages yet.)
      if (pages.length > 0) {
        const gone = orphanPageIds(get().pending, pages);
        if (gone.length > 0) set((st) => withPending(st, withoutPages(st.pending, gone)));
      }
      // Say what is still waiting from before, once, so a set kept across a reload is
      // not discovered by accident on Apply.
      const kept = waitingPages(get().pending, pages);
      if (kept.length > 0) {
        const n = kept.reduce((sum, w) => sum + w.proposals.length, 0);
        toast.message(`${changeCount(n)} from the Design Helper ${n === 1 ? 'is' : 'are'} still waiting for Apply on ${pagesPhrase(kept.map((w) => w.page))}.`);
      }
      if (pages[0]) await get().openPage(pages[0].id);
      // Load the conversation list and open the most recent one — the behaviour of
      // every chat app: you come back to where you left off. Best-effort; a chat
      // fetch failure must never block opening the magazine.
      try {
        const threads = await api.listThreads(id);
        // Guard against a slow response landing after the user opened another issue.
        if (get().issueId !== id) return;
        set({ threads });
        // Resume the newest thread YOU can write to. Landing in the legacy log or
        // someone else's read-only thread would mean the composer is disabled before
        // the user has done anything.
        const resume = threads.find((t) => t.mine && !t.legacy);
        if (resume) await get().openThread(resume.id);
      } catch {
        /* start with a blank chat */
      }
      // Still generating (from "Build with AI" / import)? Poll and reveal pages
      // as they arrive instead of making the user wait on a loading screen.
      if (issue.status === 'processing') get().watchGeneration();
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : 'Failed to load' });
    }
  },

  openPage: async (pageId, force) => {
    const { issueId } = get();
    if (!issueId) return;
    // Re-opening the already-active page (scroll jitter, or clicking the active
    // tab) would needlessly refetch and reset selection — skip it, unless the
    // caller explicitly wants the page re-read (see `force` on the interface).
    if (!force && get().currentPageId === pageId && get().page) return;
    // An apply is writing to another page right now (see pinnedPageId) — unless that
    // page has just been deleted, when the editor must be free to land elsewhere.
    if (!force && pinnedPageId && pageId !== pinnedPageId && get().pages.some((p) => p.id === pinnedPageId)) return;
    const ticket = ++openSeq;
    try {
      const page = await api.getPage(issueId, pageId);
      // A newer open (or another magazine) started while this was in flight — drop
      // it. Applying it would land the user on a page they have already scrolled
      // past, purely because this response was the slower one.
      if (ticket !== openSeq || get().issueId !== issueId) return;
      // Selection, chat AND staged proposals deliberately survive a page change.
      //
      // Proposals used to be cleared here, which was defensible when a page change
      // meant a deliberate click — but the canvas's scroll-settle picker calls this
      // on every scroll, so asking the assistant for changes and then scrolling up
      // to look at the page silently threw them away. They are kept per page now
      // (`pending`): the tray shows the page on screen's own set, and every other
      // page's set waits in the bar until Apply all or Discard.
      //
      // A stale selectedId harmlessly resolves to nothing on a page that doesn't
      // contain it (every consumer looks it up on the current page). previewDoc is
      // not page-scoped and survives too.
      //
      // The page we're LEAVING goes into the thumbnail cache: every element write
      // landed on that object, so it is the freshest copy of it in existence. Without
      // this, walking away from a page you just edited would leave the rail showing
      // the version the server last handed us.
      set((st) => ({
        page,
        currentPageId: pageId,
        thumbs: { ...st.thumbs, ...(st.page ? { [st.page.id]: st.page } : {}), [pageId]: page },
        ...trayFor(st.pending, pageId),
      }));
    } catch (e) {
      if (ticket !== openSeq || get().issueId !== issueId) return;
      set({ error: e instanceof Error ? e.message : 'Failed to load page' });
    }
  },

  goToPage: async (pageId) => {
    // Scroll FIRST, so the click feels instant instead of waiting on the page fetch.
    // Both states render the page at the same width (the open one only gains the
    // editing layer), so there is no layout shift to scroll into.
    scrollToPage(pageId);
    await get().openPage(pageId);
  },

  select: (id) => set({ selectedId: id }),
  setZoomWidth: (w) => set({ zoomWidth: Math.max(280, Math.min(1400, Math.round(w))) }),

  updateLocal: (elementId, patch) =>
    set((s) => {
      if (!s.page) return {};
      const merged = (e: MagazineElement): MagazineElement => {
        const next: MagazineElement = { ...e, ...patch } as MagazineElement;
        // one-level merge for sub-objects so a partial doesn't wipe siblings
        for (const k of ['text', 'image', 'shape', 'qr'] as const) {
          if ((patch as any)[k]) (next as any)[k] = { ...(e as any)[k], ...(patch as any)[k] };
        }
        return next;
      };
      return { page: { ...s.page, elements: s.page.elements.map((e) => (e.id === elementId ? merged(e) : e)) } };
    }),

  commit: async (elementId, patch, before) => {
    const s0 = get();
    if (!s0.page || !s0.issueId) return false;
    const pageId = s0.page.id;
    const issueId = s0.issueId;
    const beforeEl = before ?? el(s0.page, elementId) ?? undefined;

    // Optimistic: reflect the edit on the canvas IMMEDIATELY so the inspector
    // never feels "dead" waiting on the network, and a later conflict can't erase
    // the change silently. The server write then confirms (or reconciles) it.
    get().updateLocal(elementId, patch);

    const send = async (rev: number, isRetry: boolean): Promise<boolean> => {
      try {
        const { element, rev: newRev } = await api.patchElement(issueId, pageId, elementId, rev, patch);
        set((st) => ({
          page: st.page && st.page.id === pageId
            ? { ...st.page, rev: newRev, elements: st.page.elements.map((e) => (e.id === elementId ? element : e)) }
            : st.page,
          editedSinceLoad: true,
        }));
        if (beforeEl) record(set, { op: 'update', pageId, elementId, before: beforeEl, after: element }, 'the edit');
        return true;
      } catch (e) {
        // A stale rev (an AI/format write or a collaborator landed first) must NOT
        // discard the user's edit or their selection — that is exactly what made
        // the inspector look "dead" after using the assistant. Adopt the server's
        // fresh page, re-apply the edit on top, and retry ONCE against the new rev.
        const fresh = e instanceof ApiError && e.status === 409 ? (e.body?.page as MagazinePageV2 | undefined) : undefined;
        if (fresh && !isRetry && fresh.elements.some((x) => x.id === elementId)) {
          set((st) => (st.page && st.page.id === pageId ? { page: fresh } : {}));
          get().updateLocal(elementId, patch);
          return send(fresh.rev, true);
        }
        // TAKE THE OPTIMISTIC PAINT BACK when nothing else is going to.
        //
        // updateLocal already drew this edit on the canvas. handleWriteError re-reads
        // the stored page for the two conflict shapes, but a 403, a 500 or a dropped
        // connection fell through to a toast alone — leaving the edit on screen,
        // saved nowhere, with a transient message as the only clue. A write that
        // didn't land must not still be visible.
        if (handleWriteError(e, set, get) === 'unreconciled') revertElement(pageId, elementId, beforeEl, set, get);
        return false;
      }
    };
    return send(s0.page.rev, false);
  },

  addElement: async (partial) => {
    const s = get();
    if (!s.page || !s.issueId) return null;
    const pageId = s.page.id;
    try {
      const { element, rev } = await api.addElement(s.issueId, pageId, s.page.rev, partial);
      set((st) => ({
        page: st.page && st.page.id === pageId ? { ...st.page, rev, elements: [...st.page.elements, element] } : st.page,
        selectedId: element.id,
        editedSinceLoad: true,
      }));
      // The SERVER's element is what gets recorded, so a redo re-creates exactly what
      // was stored (normalised geometry, canonical id) rather than what we asked for.
      record(set, { op: 'add', pageId, element }, 'adding that');
      return element.id;
    } catch (e) {
      handleWriteError(e, set, get);
      return null;
    }
  },

  deleteElement: async (elementId) => {
    const s = get();
    if (!s.page || !s.issueId) return false;
    const pageId = s.page.id;
    // Snapshot BEFORE the write: once the server has it, the only copy of a deleted
    // element is the one we kept, and that copy is what undo puts back.
    const victim = el(s.page, elementId);
    try {
      const { rev } = await api.deleteElement(s.issueId, pageId, elementId, s.page.rev);
      set((st) => ({
        page: st.page && st.page.id === pageId ? { ...st.page, rev, elements: st.page.elements.filter((e) => e.id !== elementId) } : st.page,
        selectedId: st.selectedId === elementId ? null : st.selectedId,
        editedSinceLoad: true,
      }));
      if (victim) record(set, { op: 'delete', pageId, element: victim }, 'deleting that');
      return true;
    } catch (e) {
      handleWriteError(e, set, get);
      return false;
    }
  },

  duplicateElement: async (elementId) => {
    const s = get();
    if (!s.page) return;
    const src = s.page.elements.find((e) => e.id === elementId);
    if (!src) return;
    const topZ = s.page.elements.reduce((m, e) => Math.max(m, e.zIndex), 0);
    // Offset so the copy is visibly distinct; the server re-clamps to the page box.
    const off = 24;
    const { id: _id, ...rest } = src;
    void _id;
    await get().addElement({ ...rest, x: src.x + off, y: src.y + off, zIndex: topZ + 1, source: 'manual' });
    // addElement already selects the new element.
  },

  batchEdits: async (label, fn) => {
    // Nested → join the batch already open, so the whole outer action stays one
    // undo entry. (runFormat inside an AI apply, say.)
    if (openBatch) return fn();
    const forIssue = get().issueId;
    openBatch = { label, ops: [] };
    try {
      return await fn();
    } finally {
      const done = openBatch;
      openBatch = null;
      // An action that wrote nothing (every proposal refused, nothing to fill) must
      // not leave an empty entry: the Undo button would light up and do nothing. And
      // if the user opened a DIFFERENT magazine while this ran, the entry is dropped
      // rather than pushed onto that one's stack, where it could only ever misfire.
      if (done && done.ops.length > 0 && get().issueId === forIssue) {
        set((st) => ({ undoStack: [...st.undoStack.slice(-59), done], redoStack: [] }));
      }
    }
  },

  // The stack is read INSIDE the queued task, not when the key was pressed, so a
  // queued undo acts on the state its predecessor left behind.
  undo: () =>
    enqueueReplay(async () => {
      const entry = get().undoStack[get().undoStack.length - 1];
      if (!entry || !get().issueId) return;
      // Pop FIRST. If a replay fails half way the entry must not stay on the stack, or
      // the next Ctrl+Z would re-apply the half that already came back.
      set((st) => ({ undoStack: st.undoStack.slice(0, -1) }));
      // Undo walks the ops backwards: an entry like [delete text, add photo] has to
      // take the photo away before the text can go back where it was.
      const ok = await replayOps([...entry.ops].reverse(), 'undo', set, get);
      if (ok) set((st) => ({ redoStack: [...st.redoStack, entry] }));
    }),

  redo: () =>
    enqueueReplay(async () => {
      const entry = get().redoStack[get().redoStack.length - 1];
      if (!entry || !get().issueId) return;
      set((st) => ({ redoStack: st.redoStack.slice(0, -1) }));
      const ok = await replayOps(entry.ops, 'redo', set, get);
      if (ok) set((st) => ({ undoStack: [...st.undoStack, entry] }));
    }),

  addPage: async () => {
    const s = get();
    if (!s.issueId) return;
    const had = new Set(s.pages.map((p) => p.id));
    try {
      const { pages } = await api.addPage(s.issueId);
      set({ pages, editedSinceLoad: true });
      // Open the page that was just made. Leaving the user on the old one reads as a
      // no-op — and in the vertical rail the new tile can be below the fold, so there
      // was nothing on screen to tell them it had worked.
      const fresh = pages.find((p) => !had.has(p.id));
      if (fresh) await get().goToPage(fresh.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to add page');
    }
  },

  generatePages: async (count, topic, atIndex, docIds) => {
    const { issueId, generating } = get();
    if (!issueId) return false;
    // SAY it, rather than returning quietly. Only one build runs at a time, and a
    // silent bail is how a staged "design 2 new pages" came to be reported applied
    // while nothing was ever made.
    if (generating || get().issue?.status === 'processing') {
      toast.warning('A page build is already running — try again once it finishes.');
      return false;
    }
    set({ generating: true, adding: true, lastBuildSources: null });
    try {
      const started = await api.generatePages(issueId, count, topic || undefined, atIndex, docIds);
      if (get().issueId === issueId) set({ lastBuildSources: started.fromDocuments ?? null });
      // Some of the documents had no readable text (a scan, or still being read): the
      // pages are written from the others. Said now, not discovered in the pages later.
      const skipped = started.fromDocuments?.skipped ?? [];
      if (skipped.length > 0) {
        toast.warning(
          `${skipped.map((n) => `“${n}”`).join(', ')} ${skipped.length === 1 ? 'has' : 'have'} no readable text yet, so the new pages are written from the other document${started.fromDocuments!.used === 1 ? '' : 's'}.`,
        );
      }
    } catch (e) {
      set({ generating: false, adding: false });
      toast.error(e instanceof Error ? e.message : 'Failed to start generation');
      return false;
    }
    toast.message('Designing new pages…');
    // Poll until the issue settles out of 'processing' — NO wall-clock cap. The
    // old 180s deadline expired long before a real run finished (each page takes
    // ~60–150s to design), and its else-branch then toasted "Pages added" while
    // the worker was still working — the reported "stuck at loading until
    // refresh" bug. The loop always terminates: the server's stuck-issue
    // watchdog (healStuckIssue, checked by this very GET) guarantees
    // 'processing' is finite even if the worker dies. Backs off after 5 minutes
    // so a long run doesn't hammer the API.
    // Uses the shared, cancellable genPoll handle and guards every set() on the
    // captured issueId — otherwise navigating to a different magazine mid-run
    // would overwrite THAT magazine's state with this one's.
    stopGenPoll();
    const start = Date.now();
    const settle = () => { genPoll = null; set({ generating: false, adding: false }); };
    /**
     * Navigated away — stop, and TOUCH NOTHING.
     *
     * This used to call settle(), which clears `generating` unconditionally. If the
     * magazine you moved to was itself building, its freshly-armed banner was turned
     * off by this magazine's last tick. Whatever is open now owns those flags: load()
     * resets them, and watchGeneration re-arms them if that issue is still processing.
     */
    const abandon = () => { genPoll = null; };
    const tick = async () => {
      if (get().issueId !== issueId) { abandon(); return; } // navigated away
      try {
        const { issue, pages } = await api.getIssue(issueId);
        if (get().issueId !== issueId) { abandon(); return; } // re-check after await
        set({ issue, pages });
        if (issue.status === 'processing') {
          genPoll = setTimeout(() => void tick(), Date.now() - start > 300_000 ? 5000 : 1500);
        } else {
          settle();
          // The server restores the PREVIOUS status on an add-pages failure (not
          // 'failed') and reports why in processingError — cleared to '' on
          // success. Checking only status === 'failed' here is what made real
          // failures toast "Pages added".
          if (issue.status === 'failed' || issue.processingError) toast.error(issue.processingError || 'Adding pages failed');
          else toast.success('Pages added');
        }
      } catch {
        if (get().issueId !== issueId) { abandon(); return; } // stop if we've moved on
        genPoll = setTimeout(() => void tick(), Date.now() - start > 300_000 ? 10_000 : 2000); // transient — keep polling
      }
    };
    genPoll = setTimeout(() => void tick(), 1500);
    return true;
  },

  duplicatePage: async (pageId) => {
    const s = get();
    if (!s.issueId) return;
    try {
      const { pages } = await api.duplicatePage(s.issueId, pageId);
      set({ pages, editedSinceLoad: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to duplicate');
    }
  },

  deletePage: async (pageId) => {
    const s = get();
    if (!s.issueId) return;
    const issueId = s.issueId;
    const finish = async (pages: PageSummary[]) => {
      // The page is gone, so its stack entries can never be replayed — and undo now
      // re-creates elements, so leaving them would have it try to restore an element
      // onto a page that no longer exists. Its waiting changes go with it, said aloud.
      const lost = pendingFor(get().pending, pageId).length;
      set((st) => ({
        pages,
        editedSinceLoad: true,
        undoStack: withoutPage(st.undoStack, pageId),
        redoStack: withoutPage(st.redoStack, pageId),
        ...withPending(st, withoutPages(st.pending, [pageId])),
      }));
      if (lost > 0) toast.message(`The ${changeCount(lost)} waiting for Apply on that page went with it.`);
      if (get().currentPageId === pageId && pages[0]) await get().openPage(pages[0].id);
    };
    try {
      const { pages } = await api.deletePage(issueId, pageId);
      await finish(pages);
    } catch (e) {
      // A page a collaborator has SUBMITTED is refused first time round, naming who
      // submitted it, so the owner can't discard someone's work without being told.
      // The server's own sentence is what we show — it already names the page and the
      // people — and confirming retries with ?confirm=1. Without this the refusal
      // would be a dead end: a lock with no key.
      if (e instanceof ApiError && e.status === 409 && e.body?.reason === 'page-submitted') {
        if (!window.confirm(`${e.message}\n\nDelete it anyway? They'll be emailed about it.`)) return;
        try {
          const { pages } = await api.deletePage(issueId, pageId, true);
          await finish(pages);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : 'Failed to delete page');
        }
        return;
      }
      toast.error(e instanceof Error ? e.message : 'Failed to delete page');
    }
  },

  reorder: async (from, to) => {
    const s = get();
    if (!s.issueId) return;
    try {
      const { pages } = await api.reorderPages(s.issueId, from, to);
      set({ pages, editedSinceLoad: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to reorder');
    }
  },

  // Both of these change the DRAFT of a magazine that may be live, so both set
  // editedSinceLoad: a renamed or re-covered published magazine genuinely differs
  // from what readers see, and the reply they get back cannot say so itself (see
  // mergeIssue). Merged rather than replaced for the same reason.
  rename: async (title) => {
    const s = get();
    if (!s.issueId) return;
    const issueId = s.issueId;
    try {
      const issue = await api.renameIssue(issueId, title);
      set((st) => (st.issueId === issueId ? { ...mergeIssue(st, issue), editedSinceLoad: true } : {}));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to rename');
    }
  },

  setCover: async (cover) => {
    const s = get();
    if (!s.issueId) return false;
    const issueId = s.issueId;
    try {
      const issue = await api.setCover(issueId, cover);
      set((st) => (st.issueId === issueId ? { ...mergeIssue(st, issue), editedSinceLoad: true } : {}));
      toast.success(cover.coverImage === '' ? 'Cover reset to automatic.' : 'Cover updated.');
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to set cover');
      return false;
    }
  },

  remove: async () => {
    const s = get();
    if (!s.issueId) return false;
    const issueId = s.issueId;
    try {
      await api.deleteIssue(issueId);
      toast.success('Magazine deleted.');
      return true;
    } catch (e) {
      // Deleting a LIVE magazine also takes the bulletin off the public newsstand,
      // which isn't obvious from a button in the studio — so the server refuses the
      // first attempt and says so. Show its sentence, then confirm through.
      if (e instanceof ApiError && e.status === 409 && e.body?.reason === 'is-live') {
        if (!window.confirm(`${e.message}\n\nDelete it anyway? This cannot be undone.`)) return false;
        try {
          await api.deleteIssue(issueId, true);
          toast.success('Magazine deleted, and removed from Bulletins.');
          return true;
        } catch (err) {
          toast.error(err instanceof Error ? err.message : 'Delete failed');
          return false;
        }
      }
      toast.error(e instanceof Error ? e.message : 'Delete failed');
      return false;
    }
  },

  reset: async () => {
    const s = get();
    if (!s.issueId) return;
    try {
      const { issue, pages } = await api.resetIssue(s.issueId);
      // thumbs are cleared with everything else: reset() destroys every page, and a
      // stale tile for a page that no longer exists would be a ghost in the rail. The
      // same goes for changes waiting on those pages — none of them exist any more.
      set({ issue, pages, selectedId: null, undoStack: [], redoStack: [], pending: {}, proposals: [], proposalsPageId: null, thumbs: {}, lastCheck: null, lastCheckPageId: null, lastCheckApplied: false });
      if (pages[0]) await get().openPage(pages[0].id);
      toast.success('Reset to a blank page.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to reset');
    }
  },

  // Fill (write empty + tighten crowded) / Adjust (tighten crowded) — the server
  // returns text edits; we auto-apply each through the undoable element CRUD.
  // A different pageId first opens that page (per-page buttons in the stack).
  runFormat: async (mode, pageId) => {
    if (pageId && pageId !== get().currentPageId) await get().openPage(pageId);
    const s = get();
    if (!s.issueId || !s.currentPageId || !s.page || s.formatBusy) return;
    // The pass is written for THIS page; the canvas's scroll-settle picker can make
    // another one active while it runs, and the edits below would then be applied to
    // whatever page had arrived under the cursor.
    const forPageId = s.currentPageId;
    set({ formatBusy: true });
    try {
      const { edits, note, layout } = await api.formatPage(s.issueId, forPageId, mode);
      const layoutOps = layout ? layout.moves.length + layout.removes.length + layout.scrims.length + (layout.texts?.length ?? 0) : 0;
      if (edits.length === 0 && layoutOps === 0) {
        toast.message(note || 'Nothing to change on this page.');
        return;
      }
      if (get().currentPageId !== forPageId) {
        toast.message('You moved to another page while that ran, so nothing was changed. Try it again on this page.');
        return;
      }
      // ONE undo entry for the whole pass — a Fill can rewrite a dozen blocks, and
      // taking them back one Ctrl+Z at a time is not "undo", it's twelve undos.
      let wrote = 0;
      let refused = 0;
      await get().batchEdits(mode === 'fill' ? 'the text fill' : 'the text adjustment', async () => {
        for (const e of edits) {
          if (get().currentPageId !== forPageId) { refused++; continue; }
          const before = get().page?.elements.find((x) => x.id === e.elementId);
          if (!before || before.type !== 'text' || !before.text) { refused++; continue; }
          if (await get().commit(e.elementId, { text: { ...before.text, content: e.content } }, before)) wrote++;
          else refused++;
        }
        // The re-balance, AFTER the copy it was measured against has landed. Each move is
        // an ordinary geometry patch, so the server refits the type to the new box exactly
        // as it does when a box is dragged.
        if (layout) {
          // A drop cap's pieces re-split for their new measure: copy and pinned sizes first
          // (the sizes are explicit, so the write does not refit them), so the move that
          // follows refits against the copy the box will really hold.
          for (const t of layout.texts ?? []) {
            if (get().currentPageId !== forPageId) { refused++; continue; }
            const before = get().page?.elements.find((x) => x.id === t.elementId);
            if (!before || before.type !== 'text' || !before.text) { refused++; continue; }
            const { elementId: _id, ...patch } = t;
            if (await get().commit(t.elementId, { text: { ...before.text, ...patch } }, before)) wrote++;
            else refused++;
          }
          for (const m of layout.moves) {
            if (get().currentPageId !== forPageId) { refused++; continue; }
            const before = get().page?.elements.find((x) => x.id === m.elementId);
            if (!before) { refused++; continue; }
            const geo = { x: m.x, y: m.y, w: m.w, h: m.h, ...(typeof m.rotation === 'number' ? { rotation: m.rotation } : {}) };
            if (await get().commit(m.elementId, geo, before)) wrote++;
            else refused++;
          }
          for (const sc of layout.scrims) {
            if (get().currentPageId !== forPageId) { refused++; continue; }
            const before = get().page?.elements.find((x) => x.id === sc.elementId);
            if (!before || before.type !== 'shape' || !before.shape) { refused++; continue; }
            if (await get().commit(sc.elementId, { shape: { ...before.shape, opacity: sc.opacity } }, before)) wrote++;
            else refused++;
          }
          for (const id of layout.removes) {
            if (get().currentPageId !== forPageId) { refused++; continue; }
            if (!get().page?.elements.some((x) => x.id === id)) { refused++; continue; }
            if (await get().deleteElement(id)) wrote++;
            else refused++;
          }
        }
      });
      // Report what was STORED. `edits.length` is what the model proposed, and using
      // it here claimed a dozen rewritten blocks over a pass where the page had
      // refused every one of them.
      if (wrote === 0) toast.error(`Couldn't apply that text pass — the page didn't accept ${refused === 1 ? 'the change' : 'any of the changes'}.`);
      else if (refused > 0) toast.warning(`${mode === 'fill' ? 'Filled' : 'Adjusted'} ${wrote} block${wrote === 1 ? '' : 's'} — ${refused} ${refused === 1 ? 'was' : 'were'} refused. Undo with Ctrl+Z.`);
      else {
        // The layout summary rides along even when the model wrote its own note — it is
        // the line that says a photo was removed or that the page is still short of copy.
        const said = [note, layout?.summary].filter((x, i, all) => !!x && all.indexOf(x) === i).join(' ');
        toast.success(said || `${mode === 'fill' ? 'Filled' : 'Adjusted'} ${wrote} block${wrote === 1 ? '' : 's'}. Undo with Ctrl+Z.`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Text pass failed');
    } finally {
      set({ formatBusy: false });
    }
  },

  // Toggle a page's inclusion in "publish selected pages".
  layoutBusy: false,

  /**
   * `fit` defaults to 'exact' because of what this action MEANS to the person who
   * triggered it. Both callers — the reference panel's button and the assistant's
   * `apply-layout` — are answering "make this page look like that one", and the
   * honest reading of that is same-to-same.
   *
   * It used to send nothing, so the server fell back to 'adapt' and re-composed the
   * reference through its frame tree: an unfillable slot was PRUNED and its siblings
   * grew to take the space. That is why a rebuilt page came back at 29% with "1 box
   * from the reference had nothing to put in it, so the rest grew to fill the page" —
   * the mode was doing exactly what it says, for a job the user had not asked for.
   * 'exact' leaves the hole instead and keeps every other box where the reference
   * put it.
   */
  applyLayout: async (reading, targetPageId, fit = 'exact') => {
    // Every early return below is a failure unless it says otherwise (see layoutOutcome).
    layoutOutcome = 'failed';
    const s = get();
    if (!s.issueId || !s.page || s.layoutBusy) return null;
    const issueId = s.issueId;
    /**
     * The page the assistant NAMED, or the one on screen.
     *
     * `targetPageId` is resolved server-side from an ordinal the user spoke ("do page 2
     * like this") — the chat tool had no page argument at all until now, so it always
     * rebuilt whatever page happened to be open. Everything below therefore has to come
     * from the TARGET rather than from `s.page`: its rev, its element count, and whether
     * the editor's own view needs replacing afterwards.
     */
    const pageId = targetPageId ?? s.page.id;
    const summary = s.pages.find((p) => p.id === pageId);
    if (targetPageId && !summary) {
      toast.error('That page is no longer in this magazine.');
      return null;
    }
    const isOpen = pageId === s.page.id;
    // The open page's own element array is authoritative. Any OTHER page is read
    // fresh, here, before the confirm.
    //
    // It used to take the rev from the rail summary — and element writes bump only the
    // OPEN page's rev, never its summary. So a page edited earlier in the session ("do
    // page 2 like this" after working on page 2, then moving on) sent a stale rev and
    // was refused with a 409 every time, until a reload. The fresh read also makes the
    // confirm's item count true; the server's own rev check still catches a real
    // concurrent edit.
    let rev: number;
    let count: number;
    if (isOpen) {
      rev = s.page.rev;
      count = s.page.elements.length;
    } else {
      const target = await api.getPage(issueId, pageId).catch(() => null);
      if (!target) {
        toast.error('Couldn’t read that page just now — check your connection, then try again.');
        return null;
      }
      if (get().issueId !== issueId) return null;
      rev = target.rev;
      count = target.elements.length;
      set((st) => ({
        pages: st.pages.map((p) => (p.id === pageId ? { ...p, rev: target.rev, elementCount: target.elements.length } : p)),
        thumbs: { ...st.thumbs, [pageId]: target },
      }));
    }
    // THE CONFIRM LIVES HERE, not in the panel that used to own it. A rebuild replaces
    // every element and the undo stack cannot cover it, and there are two ways to reach
    // it: the reference panel and the assistant staging `apply-layout` in chat. With the
    // confirm in the component, the chat path rebuilt the page with no warning while a
    // comment down in applyAllProposals claimed the confirm was shared. It names the
    // PAGE, too: from chat you may not be looking at the page you are about to replace —
    // and now that the assistant can target a page you are NOT looking at, that naming
    // is the only thing standing between "do page 2" and a rebuilt page 5.
    // The REAL page number (index + 1), as the canvas prints it — not the position in
    // `pages`. A contributor shared only page 3 has a one-item list, and the position
    // made this confirm ask "Rebuild page 1…?" about the page captioned "Page 3".
    const n = summary ? summary.index + 1 : 0;
    const where = n > 0 ? `page ${n}` : 'this page';
    const ok = window.confirm(
      `Rebuild ${where} to match that reference?\n\nThe page is cleared and recreated in the image's design — fresh words are written for your magazine, and the page's photos are re-used where the layout wants pictures. Its current ${count} item${count === 1 ? '' : 's'} are replaced and cannot be brought back with undo.`,
    );
    if (!ok) {
      layoutOutcome = 'declined';
      return null;
    }
    set({ layoutBusy: true });
    try {
      const { page, leftOver, fidelity, warning, tightSummary } = await api.applyLayoutToPage(issueId, pageId, { rev, reading, fit });
      set((st) => ({
        // The returned page is authoritative — it is what the solver produced.
        page: st.currentPageId === pageId ? page : st.page,
        // Keep the summary and the rail thumbnail in step: the element count and the
        // rev both changed, and a stale summary would leave the rail drawing the old
        // page until something else happened to refresh it.
        pages: st.pages.map((p) => (p.id === pageId ? { ...p, elementCount: page.elements.length, rev: page.rev } : p)),
        thumbs: { ...st.thumbs, [pageId]: page },
        // Every element on the REBUILT page is new, so stack entries pointing at them
        // are now ghosts — dropped by PAGE rather than by clearing everything, since the
        // assistant can rebuild a page you are not looking at and the undo history of the
        // pages this rebuild never touched has to survive.
        undoStack: withoutPage(st.undoStack, pageId),
        redoStack: withoutPage(st.redoStack, pageId),
        ...(st.currentPageId === pageId ? { selectedId: null } : {}),
        editedSinceLoad: true,
      }));
      // Say what didn't fit. Surplus photos genuinely have nowhere to go, and a
      // silent loss is the thing this feature must never do.
      const lost: string[] = [];
      if (leftOver.images > 0) lost.push(`${leftOver.images} photo${leftOver.images === 1 ? '' : 's'}`);
      if (leftOver.text > 0) lost.push(`${leftOver.text} text block${leftOver.text === 1 ? '' : 's'}`);
      const tail = lost.length > 0 ? ` ${lost.join(' and ')} had nowhere to go and stayed out.` : '';
      // Name the page when it is NOT the one on screen. "Matched your reference closely
      // (73%)" is a complete sentence about a page you can see and an ambiguous one
      // about a page you cannot.
      const head = isOpen ? '' : `${where.charAt(0).toUpperCase()}${where.slice(1)}: `;
      // The MEASURED verdict decides the tone of the toast. A "loose" result is not a
      // success message with a caveat buried in a panel — it is the headline.
      if (fidelity.verdict === 'loose') toast.warning(`${head}${fidelity.summary}${tail}`);
      else toast.success(`${head}${fidelity.summary}${tail}`);
      if (warning) toast.message(warning);
      // Copy that had to be cut to stay readable. Its own toast, because it is about
      // the WRITING rather than the layout, and it is the one thing here the user can
      // actually fix. It used to be a 422 quoting an element id at them.
      if (tightSummary) toast.warning(tightSummary);
      layoutOutcome = 'done';
      return fidelity;
    } catch (e) {
      // A 409 carries the server's current page: adopt it so the user is looking at
      // what actually exists before they try again — and put its rev on the SUMMARY
      // and the rail's copy too, or a retry from another page would send the same
      // stale rev and be refused again.
      if (e instanceof ApiError && e.status === 409 && e.body?.page) {
        const fresh = e.body.page as MagazinePageV2;
        set((st) => ({
          ...(st.currentPageId === pageId ? { page: fresh } : {}),
          pages: st.pages.map((p) => (p.id === pageId ? { ...p, rev: fresh.rev, elementCount: fresh.elements.length } : p)),
          thumbs: { ...st.thumbs, [pageId]: fresh },
        }));
        toast.error('This page changed while you were choosing a layout — have another look, then try again.');
        return null;
      }
      toast.error(e instanceof Error ? e.message : 'Could not apply that layout');
      return null;
    } finally {
      set({ layoutBusy: false });
    }
  },

  setPageSelected: async (pageId, selected) => {
    const s = get();
    if (!s.issueId) return;
    // Optimistic — the checkbox answers instantly; reconcile with the server list.
    set({ pages: s.pages.map((p) => (p.id === pageId ? { ...p, selectedForPublish: selected } : p)) });
    try {
      const { pages } = await api.setPageSelected(s.issueId, pageId, selected);
      set({ pages, editedSinceLoad: true });
    } catch (e) {
      set({ pages: s.pages }); // roll back
      toast.error(e instanceof Error ? e.message : 'Could not update the page selection');
    }
  },

  // Publish/republish to Bulletins. Returns the frozen edition's public id (or
  // null on failure); the caller shows the success toast + "View" navigation.
  publish: async (scope) => {
    const s = get();
    if (!s.issueId || s.publishing) return null;
    const issueId = s.issueId;
    set({ publishing: true });
    try {
      const { publishedIssueId } = await api.publishIssue(issueId, scope);
      // THE PUBLISH HAS HAPPENED. Everything after this point is refreshing our view
      // of it, and must not be able to report failure for it — the re-read used to
      // share this try, so a flaky GET turned a successful publish into "Publish
      // failed" and sent the owner back to republish a live edition.
      //
      // Re-read the whole issue rather than trusting the publish reply: `needsRepublish`
      // is derived from the pages, and only GET /issues/:id carries them. Refreshing the
      // summaries also picks up any selectedForPublish the server changed.
      try {
        const fresh = await api.getIssue(issueId);
        if (get().issueId === issueId) set({ issue: fresh.issue, pages: fresh.pages, editedSinceLoad: false });
      } catch {
        // Clear the local half regardless: those edits ARE published now, and leaving
        // the flag set would keep the "Needs republish" badge up on a magazine that is
        // in sync. The server's own answer arrives on the next load.
        if (get().issueId === issueId) set({ editedSinceLoad: false });
        toast.message('Published. Couldn’t refresh the page list just now — reload to see the latest.');
      }
      return publishedIssueId;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Publish failed');
      return null;
    } finally {
      set({ publishing: false });
    }
  },

  needsRepublish: () => {
    const s = get();
    if (s.issue?.status !== 'published') return false;
    // THREE sources, any of which is enough:
    //  1. what the server derived from timestamps when the magazine loaded;
    //  2. any page it flagged as edited since the snapshot — a backstop, so if a write
    //     path ever forgets (3), the warning appears on the next load instead of never;
    //  3. our own writes this session, because element writes return no page summary
    //     and this is the one moment the warning has to be immediate.
    return s.issue.needsRepublish === true || s.pages.some((p) => p.editedSincePublish) || s.editedSinceLoad;
  },

  // ── Submissions & approval ────────────────────────────────────────────────
  //
  // All three share the same shape, and the same discipline about honesty:
  //  • `pages` comes back from the server, so the board reflects what was STORED,
  //    not what we hoped for — a partially-applied batch shows as such.
  //  • the toast names the pages that actually moved (`label`, phrased server-side)
  //    and reports `skipped` rather than hiding it.
  //  • email failure is REPORTED, never fatal: the transition is already committed,
  //    so "approved, but we couldn't email them" is the truth and the user needs it.
  submitPages: async (pageIds, note) => {
    const s = get();
    if (!s.issueId || pageIds.length === 0 || s.reviewBusy) return false;
    set({ reviewBusy: true });
    try {
      const r = await api.submitPages(s.issueId, pageIds, note);
      set({ pages: r.pages });
      // Re-open the current page so its read-only state takes effect immediately —
      // submitting locks it, and a canvas that still looks editable would invite
      // edits the server then refuses. FORCED, because the page is already the open
      // one: without that flag openPage's "already current" short-circuit made this
      // line a no-op and the lock only appeared on the next reload.
      if (s.currentPageId && pageIds.includes(s.currentPageId)) await get().openPage(s.currentPageId, true);
      const what = r.label || `${r.submitted} page${r.submitted === 1 ? '' : 's'}`;
      if (r.emailed) toast.success(`Sent ${what} for review — the owner has been emailed.`);
      else toast.success(`Sent ${what} for review.${r.emailError ? ` (Couldn't email the owner: ${r.emailError})` : ''}`);
      if (r.skipped > 0) toast.message(`${r.skipped} page${r.skipped === 1 ? '' : 's'} had already moved on.`);
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not submit those pages');
      return false;
    } finally {
      set({ reviewBusy: false });
    }
  },

  approvePages: async (pageIds, note) => {
    const s = get();
    if (!s.issueId || pageIds.length === 0 || s.reviewBusy) return false;
    set({ reviewBusy: true });
    try {
      const r = await api.approvePages(s.issueId, pageIds, note);
      set({ pages: r.pages });
      const what = r.label || `${r.approved} page${r.approved === 1 ? '' : 's'}`;
      toast.success(`Approved ${what}.${r.emailed ? '' : ' (Nobody was emailed.)'}`);
      if (r.emailErrors?.length) toast.message(`Couldn't email: ${r.emailErrors.join('; ')}`);
      if (r.skipped > 0) toast.message(`${r.skipped} page${r.skipped === 1 ? '' : 's'} changed while you were reviewing — reload to see them.`);
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not approve those pages');
      return false;
    } finally {
      set({ reviewBusy: false });
    }
  },

  requestChanges: async (pageIds, note) => {
    const s = get();
    if (!s.issueId || pageIds.length === 0 || !note.trim() || s.reviewBusy) return false;
    set({ reviewBusy: true });
    try {
      const r = await api.requestPageChanges(s.issueId, pageIds, note.trim());
      set({ pages: r.pages });
      const what = r.label || `${r.returned} page${r.returned === 1 ? '' : 's'}`;
      toast.success(`Sent ${what} back with your note.${r.emailed ? '' : ' (Nobody was emailed.)'}`);
      if (r.emailErrors?.length) toast.message(`Couldn't email: ${r.emailErrors.join('; ')}`);
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send those pages back');
      return false;
    } finally {
      set({ reviewBusy: false });
    }
  },

  unpublish: async () => {
    const s = get();
    if (!s.issueId || !s.issue?.publishedIssueId || s.publishing) return;
    const issueId = s.issueId;
    set({ publishing: true });
    try {
      const { issue } = await api.unpublishIssue(issueId);
      set((st) => (st.issueId === issueId ? mergeIssue(st, issue) : {}));
      toast.success('Removed from Bulletins.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Unpublish failed');
    } finally {
      set({ publishing: false });
    }
  },

  refreshIssue: async () => {
    const s = get();
    if (!s.issueId) return false;
    const issueId = s.issueId;
    try {
      const { issue, pages } = await api.getIssue(issueId);
      // This response DOES carry the pages, so its needsRepublish is the real answer
      // and replaces ours outright — the one refresh entitled to do that.
      if (get().issueId === issueId) set({ issue, pages });
      return true;
    } catch {
      return false; // keep current state; the caller decides whether to say so
    }
  },

  watchGeneration: () => {
    const watchId = get().issueId;
    if (!watchId) return;
    stopGenPoll();
    set({ generating: true, adding: false });
    const start = Date.now();
    // Same rule as generatePages: on navigating away we stop and leave `generating`
    // alone. Clearing it here switched off the banner of whatever magazine had just
    // been opened, which is the one thing this poll must never do to a build it is
    // not watching.
    const abandon = () => { genPoll = null; };
    const tick = async () => {
      if (get().issueId !== watchId) { abandon(); return; } // navigated away
      try {
        const { issue, pages } = await api.getIssue(watchId);
        if (get().issueId !== watchId) { abandon(); return; } // re-check after await — a late response must not overwrite another magazine's state
        set({ issue, pages });
        // Reveal the first page the moment it exists so the user sees the build.
        if (!get().currentPageId && pages[0]) await get().openPage(pages[0].id);
        if (issue.status === 'processing') {
          // NO wall-clock cap. A 10-page build realistically takes 5.5–13 minutes
          // (two pages compose at a time, each ~60–150s); the old 300s deadline
          // expired mid-build, silently stopped polling, and left the banner up
          // forever — the "5-6 pages then stuck until refresh" bug (refresh
          // worked because load() re-arms this watch). The loop always ends: the
          // server's stuck-issue watchdog guarantees 'processing' is finite.
          // Back off after 5 minutes so a long build doesn't hammer the API.
          genPoll = setTimeout(() => void tick(), Date.now() - start > 300_000 ? 5000 : 1500);
        } else {
          genPoll = null;
          // Completed OK → offer "add more pages" (the preview is intentionally
          // short). 'ready' precisely — the old `!== 'failed'` also matched a
          // still-'processing' snapshot at the poll cap.
          set({ generating: false, justGenerated: issue.status === 'ready' && issue.origin !== 'upload' });
          if (issue.status === 'failed') toast.error(issue.processingError || 'Generation failed');
        }
      } catch {
        if (get().issueId !== watchId) { abandon(); return; } // moved on mid-error
        genPoll = setTimeout(() => void tick(), Date.now() - start > 300_000 ? 10_000 : 2500); // transient — keep polling
      }
    };
    genPoll = setTimeout(() => void tick(), 1200);
  },

  stopWatching: () => { stopGenPoll(); },

  clearJustGenerated: () => set({ justGenerated: false }),

  // ── Threads ──
  loadThreads: async () => {
    const id = get().issueId;
    if (!id) return;
    set({ threadsLoading: true });
    try {
      const threads = await api.listThreads(id);
      set((st) => (st.issueId === id ? { threads, threadsLoading: false } : { threadsLoading: false }));
    } catch {
      set({ threadsLoading: false });
    }
  },

  openThread: async (threadId) => {
    const id = get().issueId;
    if (!id) return;
    // Clear the transcript FIRST. Loading over the old one would leave another
    // conversation on screen for the length of the fetch, and the user would read it
    // as belonging to the thread they just clicked.
    //
    // The staged changes (and the check that describes them) stay: they wait on their
    // PAGE, not in a conversation. Opening a chat used to throw them away.
    set({ activeThreadId: threadId, chat: [], chatHasMore: false, chatOldest: null });
    try {
      const t = await api.listThreadMessages(id, threadId, { limit: 50 });
      set((st) => (st.issueId === id && st.activeThreadId === threadId
        ? { chat: t.messages.map(dtoToChat), chatHasMore: t.hasMore, chatOldest: t.oldestCreatedAt }
        : {}));
    } catch (e) {
      // DON'T LEAVE THE PANEL POINTING AT A THREAD WE COULDN'T READ. It would show an
      // empty transcript with a live composer, so the next message would be appended
      // to a conversation whose history is on screen nowhere — indistinguishable from
      // a new chat, except that it isn't one. Drop to an actual new chat, which is
      // what the emptied panel already looks like; the thread is still in the list to
      // try again.
      set((st) => (st.issueId === id && st.activeThreadId === threadId ? { activeThreadId: null } : {}));
      toast.error(e instanceof Error ? e.message : 'Could not open that chat.');
    }
  },

  // No server call: an empty chat that nobody has spoken in isn't worth a document.
  // The first turn creates it and adopts the id the server returns. Waiting changes
  // stay with their pages (see openThread).
  newThread: () => set({ activeThreadId: null, chat: [], chatHasMore: false, chatOldest: null }),

  renameThread: async (threadId, title) => {
    const id = get().issueId;
    if (!id || !title.trim()) return;
    try {
      const updated = await api.renameThread(id, threadId, title.trim());
      set((st) => ({ threads: st.threads.map((t) => (t.id === threadId ? updated : t)) }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not rename that chat.');
    }
  },

  removeThread: async (threadId) => {
    const id = get().issueId;
    if (!id) return;
    try {
      await api.deleteThread(id, threadId);
      const wasActive = get().activeThreadId === threadId;
      set((st) => ({ threads: st.threads.filter((t) => t.id !== threadId) }));
      // Deleting the chat you're reading leaves the panel showing a transcript that
      // no longer exists — so land on the next one, or a blank chat.
      if (wasActive) {
        const next = get().threads.find((t) => t.mine && !t.legacy);
        if (next) await get().openThread(next.id);
        else get().newThread();
      }
      toast.success('Chat deleted.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not delete that chat.');
    }
  },

  // ── AI editing assistant ──
  sendChat: async (text, sourceText, attachedImages, attachments, extras) => {
    const s = get();
    const body = text.trim();
    if (!body || !s.issueId || !s.currentPageId || s.chatBusy) return;
    // Read-only thread (someone else's, or the legacy log) — the composer is
    // disabled for these, and this is the matching guard so a stale render can't
    // post into a conversation the server would refuse anyway.
    const active = s.threads.find((t) => t.id === s.activeThreadId);
    if (active?.readOnly) return;
    const issueId = s.issueId;
    const forPageId = s.currentPageId;
    const forThreadId = s.activeThreadId;
    /**
     * The changes still waiting in the tray for THIS page go with the turn.
     *
     * "Make the headline bigger" → staged; "and make it red" → the second turn used to
     * be built from the STORED page and its list replaced the tray, so the bigger
     * headline vanished without a word. The server replays these onto its working
     * copy, so the new turn builds on them and returns the combined set. Capped like
     * the server caps them.
     */
    const pending = pendingFor(s.pending, forPageId).slice(0, MAX_SENT_PER_TURN);
    // The page as the turn is built from it — what each text edit it stages is written
    // against. Read NOW, not when the reply lands: a word typed into a box while the turn
    // runs is exactly the edit Apply must not overwrite unseen.
    const sentElements = s.page?.id === forPageId ? s.page.elements : s.thumbs[forPageId]?.elements;
    set({ chat: [...s.chat, { role: 'user', content: body, attachments }], chatBusy: true });
    /**
     * Is this reply still wanted?
     *
     * A turn takes a while, and this was the one async action in the store with no
     * such check: open another magazine mid-turn and the reply — plus its staged
     * proposals, aimed at a page in the magazine you left — was appended to the new
     * one's chat, straight past the clean slate load() had just set up. The thread is
     * checked too, so a reply cannot land in a conversation the user has switched to.
     *
     * `chatBusy` is released on the ISSUE check alone: switching thread within the
     * same magazine must still unlock the composer (nothing else will), while a
     * different magazine's flag is not ours to touch — it may have a turn of its own
     * in flight, and clearing it would let a second one start alongside.
     */
    const sameIssue = () => get().issueId === issueId;
    const stillOurs = () => sameIssue() && get().activeThreadId === forThreadId;
    try {
      // ONE turn, plus the thread id. The server reads the rest of the history from
      // the thread itself — the client's transcript is for display, not the prompt.
      const turn = await api.chatAgent(
        issueId,
        forPageId,
        [{ role: 'user', content: body }],
        s.selectedId ?? undefined,
        sourceText,
        attachedImages,
        forThreadId ?? undefined,
        // `baseText` is this client's own bookkeeping (the words a text edit was staged
        // against) — the server has no use for it, so it stays here.
        { pendingProposals: pending.map(({ baseText: _base, ...p }) => p), attachedDocs: extras?.attachedDocs },
      );
      const { reply, threadId } = turn;
      if (!stillOurs()) {
        if (sameIssue()) set({ chatBusy: false });
        return;
      }
      // Combine with what is ALREADY waiting on this page, read at the moment the reply
      // lands. The tray's buttons are disabled during a turn, but an automation can
      // still discard or apply underneath it — and a change applied meanwhile must not
      // come back in the reply to be applied twice (withoutSettled, inside
      // accumulateTurn). Other pages' waiting changes are never touched: a turn on page
      // 8 used to replace the tray that held page 7's.
      const now = get();
      const result = accumulateTurn({
        map: now.pending,
        pageId: forPageId,
        sent: pending,
        reply: Array.isArray(turn.proposals) ? turn.proposals : [],
        serverMerged: turn.pendingMerged,
        turnTag: `t${Date.now().toString(36)}`,
        // So each new text edit remembers the words it was written against (Apply holds
        // it back if the box is edited in between).
        elements: sentElements,
      });
      // THE LINE UNDER THE REPLY, from the proposals and never from the reply. A reply
      // once said "All six paragraphs are 20px…" after calling no tool at all; this
      // line would have said "Nothing was changed". The server writes its own when it
      // can; only this client knows what waits on OTHER pages, so that tail is ours.
      const others = waitingPages(result.map, now.pages).filter((w) => w.pageId !== forPageId);
      const claimed = claimsChange(reply);
      // `staged.line` is what the server sends; `stagedLine` was this client's name for
      // it before the two met, read only as a fallback.
      const serverLine =
        typeof turn.staged?.line === 'string' ? turn.staged.line.trim() : typeof turn.stagedLine === 'string' ? turn.stagedLine.trim() : '';
      const tail = otherPagesTail(others).trim();
      const line = serverLine
        ? `${serverLine}${tail && !/Also waiting:/.test(serverLine) ? ` ${tail}` : ''}`
        : stagedLine({ added: result.added, pageNumber: pageNumberIn(now.pages, forPageId), onPage: result.onPage.length, others, claimed });
      // Not twice: a reply the server already ended with its line gets only the tail.
      // A bare "Nothing was changed." under a reply that already says so in its own
      // words ("nothing was changed on the page") is the same sentence twice, too. Only
      // the bare line: one that also says what is still waiting adds something.
      const saysNothingChanged = /^Nothing was changed\.?$/i.test(serverLine) && /\bnothing (?:was|has been) changed\b/i.test(reply);
      const alreadySaid = (serverLine && (reply.includes(serverLine) || saysNothingChanged)) || (!serverLine && hasStagedLine(reply));
      const note = alreadySaid ? tail || undefined : line;
      set((st) => ({
        chat: [...st.chat, { role: 'assistant', content: reply, ...(note ? { note } : {}) }],
        ...withPending(st, result.map),
        chatBusy: false,
        lastTurn: {
          pageId: forPageId,
          added: result.added.length,
          onPage: result.onPage.length,
          line,
          claimedWithoutChange: claimed && result.added.length === 0,
          at: Date.now(),
        },
        // The page check comes back only when this turn's changes leave NEW errors.
        // No check = nothing new is wrong, so an older chip goes too — unless the
        // page's set was KEPT exactly as it was (a question, from a server that does
        // not replay the waiting changes): the old check still describes those changes.
        ...(turn.check
          ? { lastCheck: turn.check, lastCheckPageId: forPageId, lastCheckApplied: false }
          : result.mode === 'kept'
            ? {}
            : { lastCheck: null, lastCheckPageId: null, lastCheckApplied: false }),
        // Adopt the thread the server used — on the first turn of a new chat this is
        // the id it just created. Without this, every turn would start another one.
        activeThreadId: threadId || st.activeThreadId,
      }));
      // A replaying server's list is the page's set from now on. Anything waiting that
      // it left out WITHOUT a replacement is named — usually the user asked to drop it,
      // but a server that does not know a kind yet drops it too — and can come back.
      if (result.droppedList.length > 0) {
        const lost = result.droppedList;
        // The server says WHY it could not keep a change (its element is gone, or now
        // locked) — worth one clause, since "Bring back" will not help with those.
        const why = (turn.pendingDropped ?? []).find((d) => lost.some((p) => p.id === d.id) && d.reason)?.reason;
        toast.message(
          `The Design Helper took ${lost.length === 1 ? 'this waiting change' : `${changeCount(lost.length)} waiting`} off this page: ${lost
            .slice(0, 2)
            .map((p) => `“${p.summary}”`)
            .join(', ')}${lost.length > 2 ? ` and ${lost.length - 2} more` : ''}${why ? ` (${why.replace(/[.\s]+$/, '')})` : ''}.`,
          {
            duration: 12_000,
            action: {
              label: 'Bring back',
              onClick: () => {
                if (get().issueId !== issueId || !get().pages.some((p) => p.id === forPageId)) return;
                set((st) => withPending(st, withPage(st.pending, forPageId, foldChanges([...lost, ...pendingFor(st.pending, forPageId)]))));
              },
            },
          },
        );
      }
      // Refresh the list so the new/renamed thread appears with its real title and
      // sorts to the top. Cheap, and it keeps the list honest without a socket.
      void get().loadThreads();
    } catch (e) {
      if (!stillOurs()) {
        if (sameIssue()) set({ chatBusy: false });
        return;
      }
      // A REFUSAL is not a snag. 403/409 carry a sentence written for the person
      // ("This page is submitted for review — ask the owner to reopen it.", "You can
      // only edit the pages shared with you."), and "try again" over one of those
      // sends them round in a loop that can never succeed. Say what the server said.
      const refusal = e instanceof ApiError && (e.status === 403 || e.status === 409) && e.message ? e.message : '';
      set((st) => ({
        chat: [...st.chat, { role: 'assistant', content: refusal || 'Sorry — I hit a snag just then. Please try again.' }],
        chatBusy: false,
      }));
      toast.error(e instanceof Error ? e.message : 'Assistant failed');
      // The page was locked (submitted/approved) since this screen last looked — pull
      // the summaries so the lock banner and the disabled composer catch up with it.
      if (e instanceof ApiError && e.status === 409 && (e.body?.reason === 'page-submitted' || e.body?.reason === 'page-approved')) {
        void get().refreshIssue();
      }
    }
  },

  // Lazily pull the batch OLDER than the oldest message we hold, prepending it —
  // so a long thread pages upward without loading all of it at once.
  loadOlderChat: async () => {
    const s = get();
    if (!s.issueId || !s.activeThreadId || !s.chatHasMore || s.chatLoadingOlder || !s.chatOldest) return;
    const issueId = s.issueId;
    const threadId = s.activeThreadId;
    const before = s.chatOldest;
    set({ chatLoadingOlder: true });
    try {
      const t = await api.listThreadMessages(issueId, threadId, { before, limit: 50 });
      set((st) => (st.issueId !== issueId || st.activeThreadId !== threadId ? { chatLoadingOlder: false } : {
        chat: [...t.messages.map(dtoToChat), ...st.chat],
        chatHasMore: t.hasMore,
        chatOldest: t.oldestCreatedAt ?? st.chatOldest,
        chatLoadingOlder: false,
      }));
    } catch {
      set({ chatLoadingOlder: false });
    }
  },

  // "Use these changes": the OPEN page's waiting changes, through the rev-guarded
  // CRUD (applyPageSet). Apply all runs the same thing page by page.
  applyAllProposals: async () => {
    const s = get();
    // Not while a turn is running: that turn was sent these changes and builds on
    // them — applying underneath it would race the reply.
    if (!s.page || !s.currentPageId || !s.issueId || s.applyingProposals || s.chatBusy) return;
    if (pendingFor(s.pending, s.currentPageId).length === 0) return;
    set({ applyingProposals: true });
    let report: PageApplyReport | null = null;
    try {
      report = await applyPageSet(set, get, false);
    } finally {
      pinnedPageId = null;
      set({ applyingProposals: false, lastApplyReport: report ? [report] : [] });
    }
  },

  /**
   * APPLY ALL: every page's waiting changes, in page order.
   *
   * Each page is opened in turn — every write goes to the open page, with that page's
   * own rev — and its set is applied exactly as its own tray's "Use these changes"
   * would (applyPageSet, quiet: one toast at the end instead of one per page). The
   * confirms still ask, per page, before anything that cannot be undone. The element
   * edits of the whole run are ONE undo entry.
   */
  applyAllWaiting: async (onlyPageId) => {
    const s = get();
    if (!s.issueId || s.applyingProposals || s.chatBusy) return null;
    const issueId = s.issueId;
    const order = waitingPages(s.pending, s.pages).filter((w) => !onlyPageId || w.pageId === onlyPageId);
    // Pages that left the magazine since their changes were staged: nothing there can
    // land, and it is said rather than left waiting forever.
    const orphans = onlyPageId ? [] : orphanPageIds(s.pending, s.pages);
    if (order.length === 0 && orphans.length === 0) return [];
    set({ applyingProposals: true });
    const reports: PageApplyReport[] = [];
    const blank = (pageId: string, page: number): PageApplyReport => ({ pageId, page, applied: 0, refused: 0, waiting: 0, elementWrites: 0, pageOps: 0 });
    try {
      if (orphans.length > 0) {
        for (const id of orphans) reports.push({ ...blank(id, 0), waiting: pendingFor(s.pending, id).length, gone: true });
        set((st) => withPending(st, withoutPages(st.pending, orphans)));
      }
      await get().batchEdits(order.length > 1 ? 'the assistant’s changes on several pages' : 'the assistant’s changes', async () => {
        for (const w of order) {
          if (get().issueId !== issueId) break;
          // An earlier page's set may have deleted this page.
          if (!get().pages.some((p) => p.id === w.pageId)) {
            reports.push({ ...blank(w.pageId, w.page), waiting: pendingFor(get().pending, w.pageId).length, gone: true });
            set((st) => withPending(st, withoutPages(st.pending, [w.pageId])));
            continue;
          }
          // Applied or discarded meanwhile (an automation, another click).
          if (pendingFor(get().pending, w.pageId).length === 0) continue;
          if (get().currentPageId !== w.pageId || get().page?.id !== w.pageId) {
            pinnedPageId = w.pageId;
            await get().goToPage(w.pageId);
          }
          if (get().currentPageId !== w.pageId || get().page?.id !== w.pageId) {
            reports.push({ ...blank(w.pageId, w.page), waiting: pendingFor(get().pending, w.pageId).length, notOpened: true });
            continue;
          }
          const r = await applyPageSet(set, get, true);
          if (r) reports.push(r);
        }
      });
    } finally {
      pinnedPageId = null;
      set({ applyingProposals: false, lastApplyReport: reports });
    }
    if (get().issueId === issueId) {
      // ONE sentence naming every page — what landed, what was refused, what waits.
      const line = applyReportLine(reports);
      const outcome = applyOutcome(reports);
      const undoable = reports.some((r) => r.elementWrites > 0);
      if (outcome === 'all') toast.success(`${line}${undoable ? ' Undo with Ctrl+Z.' : ''}`);
      else if (outcome === 'partial') toast.warning(line);
      else toast.error(line);
    }
    return reports;
  },

  discardProposals: () => {
    const id = get().currentPageId;
    if (id) get().discardWaiting(id);
  },

  // A discarded set takes its page check with it — the check described changes that
  // will now never land. A check on changes already APPLIED stays: the page still has
  // those problems. Nothing is lost on a slip: the toast brings the set back.
  discardWaiting: (pageId) => {
    const st0 = get();
    const issueId = st0.issueId;
    const ids = pageId ? [pageId] : Object.keys(st0.pending);
    const removed: Record<string, AgentProposal[]> = {};
    let n = 0;
    for (const id of ids) {
      const list = pendingFor(st0.pending, id);
      if (list.length > 0) {
        removed[id] = [...list];
        n += list.length;
      }
    }
    if (n === 0) return 0;
    set((st) => ({
      ...withPending(st, withoutPages(st.pending, Object.keys(removed))),
      ...(st.lastCheckPageId && removed[st.lastCheckPageId] && !st.lastCheckApplied ? { lastCheck: null, lastCheckPageId: null } : {}),
    }));
    const numbers = Object.keys(removed)
      .map((id) => pageNumberIn(get().pages, id))
      .filter((x) => x > 0);
    toast.message(`Discarded ${changeCount(n)}${numbers.length > 0 ? ` on ${pagesPhrase(numbers)}` : ''} — nothing on the page${numbers.length === 1 ? ' was' : 's were'} changed.`, {
      duration: 12_000,
      action: {
        label: 'Bring back',
        onClick: () => {
          if (get().issueId !== issueId) return;
          set((st) => {
            let next = st.pending;
            // Older first, so anything staged since still wins where the two overlap.
            for (const [id, list] of Object.entries(removed)) {
              if (st.pages.some((p) => p.id === id)) next = withPage(next, id, foldChanges([...list, ...pendingFor(next, id)]));
            }
            return withPending(st, next);
          });
        },
      },
    });
    return n;
  },

  setPageBackground: async (background) => {
    const s0 = get();
    if (!s0.page || !s0.issueId) return false;
    const issueId = s0.issueId;
    const pageId = s0.page.id;
    const before = s0.page.background;
    // Optimistic, like an element edit: the page answers at once, and the stored page
    // that comes back replaces the guess ('none' is drawn white until then).
    const shown: MagazinePageV2['background'] =
      background.type === 'image' && background.value
        ? { type: 'image', value: background.value }
        : background.type === 'color' && background.value
          ? { type: 'color', value: background.value }
          : { type: 'color', value: '#ffffff' };
    set((st) => (st.page && st.page.id === pageId ? { page: { ...st.page, background: shown } } : {}));
    const send = async (rev: number, isRetry: boolean): Promise<boolean> => {
      try {
        const { page } = await api.setPageBackground(issueId, pageId, rev, background);
        const after = page?.background ?? shown;
        set((st) => {
          if (!st.page || st.page.id !== pageId) return { editedSinceLoad: true };
          const merged: MagazinePageV2 = {
            ...st.page,
            ...page,
            elements: Array.isArray(page?.elements) ? page.elements : st.page.elements,
            background: after,
            rev: typeof page?.rev === 'number' ? page.rev : st.page.rev,
          };
          return { page: merged, thumbs: { ...st.thumbs, [pageId]: merged }, editedSinceLoad: true };
        });
        record(set, { op: 'background', pageId, before, after }, 'the page background');
        return true;
      } catch (e) {
        // Someone wrote the page first: adopt it and ask again once, like commit().
        const fresh = e instanceof ApiError && e.status === 409 ? (e.body?.page as MagazinePageV2 | undefined) : undefined;
        if (fresh && !isRetry && fresh.id === pageId) {
          set((st) => (st.page && st.page.id === pageId ? { page: { ...fresh, background: shown } } : {}));
          return send(fresh.rev, true);
        }
        // A write that did not land must not stay painted.
        if (handleWriteError(e, set, get) === 'unreconciled') {
          set((st) => (st.page && st.page.id === pageId ? { page: { ...st.page, background: before } } : {}));
        }
        return false;
      }
    };
    return send(s0.page.rev, false);
  },

  placeChart: async (chart, opts) => {
    const s = get();
    if (!s.issueId || !s.page) return null;
    const issueId = s.issueId;
    const pageId = s.page.id;
    let res: api.ChartResult;
    try {
      res = await api.createChart(issueId, pageId, { chart, ...(opts?.box ? { box: opts.box } : {}), ...(opts?.replaceElementId ? { replaceElementId: opts.replaceElementId } : {}) });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'The chart could not be drawn.');
      return null;
    }
    // Drawn for THAT page's free space; placing it on whatever page scrolled into
    // view meanwhile would put it somewhere nobody chose.
    if (get().issueId !== issueId || get().page?.id !== pageId) {
      toast.message('You moved to another page while the chart was drawn, so it was not placed. Try again on that page.');
      return null;
    }
    // The element the chart takes the place of: the one asked for, or — with neither a
    // box nor a target — an empty picture slot the server chose by itself. Leaving that
    // slot under the new chart would stack two pictures in one place.
    const replaceId = opts?.replaceElementId ?? res.replaceElementId;
    if (replaceId) {
      const before = get().page?.elements.find((e) => e.id === replaceId);
      if (!before) {
        toast.error('The element the chart was meant to replace is no longer on this page.');
        return null;
      }
      const drawn = res.element;
      if (before.type === 'image') {
        // A picture is PATCHED (same id, so whatever names it still finds it): its new
        // image, drawn to be shown whole (`contain`), and the box the server settled on.
        // One undo entry, like any edit. The server's `patch` wins where it is given.
        const patch: Partial<MagazineElement> = {
          ...(typeof drawn.x === 'number' ? { x: drawn.x } : {}),
          ...(typeof drawn.y === 'number' ? { y: drawn.y } : {}),
          ...(typeof drawn.w === 'number' ? { w: drawn.w } : {}),
          ...(typeof drawn.h === 'number' ? { h: drawn.h } : {}),
          ...(typeof res.patch?.zIndex === 'number' ? { zIndex: res.patch.zIndex } : {}),
          ...(drawn.image ? { image: { ...(before.image ?? { assetId: '', url: '', alt: '', fit: 'contain' as const }), ...drawn.image } } : {}),
        };
        return (await get().commit(before.id, patch, before)) ? { elementId: before.id, dataEcho: res.dataEcho } : null;
      }
      // Anything else (a text box the chart stands in for) is SWAPPED: the chart is
      // added first, so a refused add never leaves a hole, then the old element goes —
      // both inside one batch, so one undo takes the whole swap back.
      return get().batchEdits('the chart', async () => {
        const id = await get().addElement(drawn);
        if (!id) return null;
        if (!(await get().deleteElement(before.id))) {
          toast.warning('The chart was added, but the element it replaces could not be removed — delete it by hand.');
        }
        return { elementId: id, dataEcho: res.dataEcho };
      });
    }
    const id = await get().addElement(res.element);
    return id ? { elementId: id, dataEcho: res.dataEcho } : null;
  },

  replaceTextInMagazine: async (body) => {
    const issueId = get().issueId;
    if (!issueId) return null;
    // A Design Helper turn in flight was sent the waiting changes as they are now and
    // will hand them back with the OLD words after the replace has rebased them —
    // putting the old words back in the tray. Replace once it has answered.
    if (!body.dryRun && get().chatBusy) {
      toast.error('The Design Helper is still answering — replace once its reply is in, so its changes get the new words too.');
      return null;
    }
    let res: api.ReplaceTextResult;
    try {
      res = await api.replaceText(issueId, body);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not replace that text.');
      return null;
    }
    if (body.dryRun || get().issueId !== issueId) return res;
    // Changes waiting for Apply were written from the OLD words, and a staged text edit
    // carries its box's whole content: applied later, it would put the replaced word
    // straight back (the reason the undo entries below go too). The same replace runs
    // over them — on every page the replace could edit; a page it was refused on keeps
    // its words, and so do its waiting changes.
    const refusedPages = new Set((res.blocked ?? []).map((b) => b.pageId));
    const ro = { matchCase: body.matchCase, wholeWord: body.wholeWord };
    const rebased: { pageId: string; count: number }[] = [];
    set((st) => {
      let next = st.pending;
      for (const [pageId, list] of Object.entries(st.pending)) {
        if (refusedPages.has(pageId)) continue;
        const r = rebaseForReplace(list, body.find, body.replace, ro);
        if (r.list === list) continue;
        next = withPage(next, pageId, r.list);
        if (r.changed > 0) rebased.push({ pageId, count: r.changed });
      }
      return next === st.pending ? {} : withPending(st, next);
    });
    const waitingUpdated = rebased.reduce((n, r) => n + r.count, 0);
    if (waitingUpdated > 0) {
      const numbers = rebased.map((r) => pageNumberIn(get().pages, r.pageId)).filter((x) => x > 0);
      toast.message(
        `Also changed it in ${changeCount(waitingUpdated)} waiting for Apply${numbers.length > 0 ? ` on ${pagesPhrase(numbers)}` : ''}, so applying them will not bring the old words back.`,
      );
    }
    const out = waitingUpdated > 0 ? { ...res, waitingUpdated } : res;
    if (!res.applied) return out;
    const changed = new Set(res.pages.filter((p) => p.count > 0).map((p) => p.pageId));
    if (changed.size === 0) return out;
    // The server rewrote these pages. Their rail copies go, and so do undo entries on
    // them: an entry restores a WHOLE element as it was, so undoing an older edit there
    // would quietly put the replaced word back as well. (The replace itself is not on
    // the stack — it spans pages; the same replace the other way round reverses it.)
    set((st) => {
      const thumbs = { ...st.thumbs };
      for (const id of changed) delete thumbs[id];
      const prune = (stack: UndoEntry[]) => stack.filter((entry) => !entry.ops.some((op) => changed.has(op.pageId)));
      return { thumbs, undoStack: prune(st.undoStack), redoStack: prune(st.redoStack), editedSinceLoad: true };
    });
    await get().refreshIssue();
    const cur = get().currentPageId;
    if (cur && changed.has(cur)) await get().openPage(cur, true);
    return out;
  },
}));

// Keep each magazine's waiting changes in this browser after EVERY change to them, so
// a reload (or a closed tab) at any moment finds them again. One subscriber rather
// than a save beside each of the writes to `pending`, so none can be forgotten.
// (load() puts the stored set into `pending` first, so the save that follows a
// magazine switch writes back what was just read — never an empty set over it.)
useEditorStore.subscribe((st, prev) => {
  if (st.pending !== prev.pending && st.issueId) savePending(st.issueId, st.pending);
});

/**
 * Start a PDF page copy (POST …/copy-document-page). Returns the page and the rev it
 * had BEFORE, which is how the watch tells the copied page from the old one; null
 * when the server refused (its sentence is shown — it already names the reason).
 */
async function startPageCopy(
  set: (partial: Partial<EditorState> | ((st: EditorState) => Partial<EditorState>)) => void,
  get: () => EditorState,
  docId: string,
  sourcePage: number,
  pageId?: string,
): Promise<{ pageId: string; revBefore: number | undefined } | null> {
  const s = get();
  const issueId = s.issueId;
  const target = pageId ?? s.currentPageId;
  if (!issueId || !target) return null;
  // The open page carries the rev our own writes produced; its summary lags behind.
  const revBefore = s.page?.id === target ? s.page.rev : s.pages.find((p) => p.id === target)?.rev;
  try {
    const { from } = await api.copyDocumentPage(issueId, target, { docId, sourcePage });
    // Shown as running at once, before the first poll, so the rail does not look idle.
    set((st) => ({
      pages: st.pages.map((p) => (p.id === target ? { ...p, status: 'pending' } : p)),
    }));
    toast.success(`Copying page ${from.sourcePage} of “${from.name}” — it will appear here shortly.`);
    return { pageId: target, revBefore };
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'That page could not be copied.');
    return null;
  }
}

/**
 * Follow a started PDF copy until the copied page is on screen, then say how it went.
 *
 * Joins the ONE shared wait per page (pageCopyWatch.ts) that the page panel and The
 * Stable Hand use, rather than running a second poll beside it; that wait re-reads
 * the magazine and reloads the page on the canvas when it lands. Imported lazily:
 * that module reads this store, so a static import would be a cycle. While it runs
 * the page is listed in `copyingPageIds`.
 */
async function followPageCopy(
  set: (partial: Partial<EditorState> | ((st: EditorState) => Partial<EditorState>)) => void,
  get: () => EditorState,
  pageId: string,
  revBefore: number | undefined,
): Promise<boolean> {
  const issueId = get().issueId;
  if (!issueId) return false;
  set((st) => ({ copyingPageIds: st.copyingPageIds.includes(pageId) ? st.copyingPageIds : [...st.copyingPageIds, pageId] }));
  try {
    const { watchPageCopy } = await import('./pageCopyWatch');
    const outcome = await watchPageCopy(pageId, revBefore);
    // Another magazine was opened meanwhile: none of this is the open one's business.
    if (outcome.state === 'left' || get().issueId !== issueId) return false;
    const n = pageNumberIn(get().pages, pageId);
    if (outcome.state === 'done') {
      // Every element on that page is new, so undo entries naming the old ones are
      // ghosts — the same pruning a layout rebuild does.
      set((st) => ({ undoStack: withoutPage(st.undoStack, pageId), redoStack: withoutPage(st.redoStack, pageId), editedSinceLoad: true }));
      toast.success(`The PDF page is on ${n > 0 ? `page ${n}` : 'the page'} now.`);
      return true;
    }
    if (outcome.state === 'failed') toast.error(copyFailureText(outcome.summary, n));
    else if (outcome.state === 'gone') toast.error('That page is no longer in this magazine, so the copy has nowhere to show.');
    else toast.message('The PDF page is still being copied — it will show once you reopen that page.');
    return false;
  } catch {
    return false;
  } finally {
    if (get().issueId === issueId) set((st) => ({ copyingPageIds: st.copyingPageIds.filter((x) => x !== pageId) }));
  }
}

type SetState = (partial: Partial<EditorState> | ((st: EditorState) => Partial<EditorState>)) => void;

/**
 * Apply the OPEN page's waiting changes — the body of that page's "Use these
 * changes", and of each page's turn in Apply all. Returns what happened (null when
 * no page is open).
 *
 * `quiet` leaves the closing toast to the caller (Apply all says one sentence for
 * every page). Confirms are never quiet: a page deletion, a layout rebuild and a PDF
 * copy each ask first, and a "no" leaves that page's whole set waiting.
 *
 * What stays waiting afterwards: anything not tried (the page moved under the
 * apply), a page build that cannot start yet, and the rest of a set whose page
 * rebuild ran on its own. What a server REFUSED is dropped and counted — it was
 * tried and would only be refused again.
 */
async function applyPageSet(set: SetState, get: () => EditorState, quiet: boolean): Promise<PageApplyReport | null> {
  const s = get();
  if (!s.page || !s.currentPageId || !s.issueId) return null;
  const issueId = s.issueId;
  /** The page these proposals were written FOR — re-checked before every write. */
  const forPageId = s.currentPageId;
  const list = [...pendingFor(s.pending, forPageId)];
  const report: PageApplyReport = {
    pageId: forPageId,
    page: pageNumberIn(s.pages, forPageId),
    applied: 0,
    refused: 0,
    waiting: 0,
    elementWrites: 0,
    pageOps: 0,
  };
  if (list.length === 0) return report;
  /** What stays waiting on this page (unless the page itself is gone). */
  const keep = (rest: AgentProposal[]) =>
    set((st) => (st.pages.some((p) => p.id === forPageId) ? withPending(st, withPage(st.pending, forPageId, rest)) : withPending(st, withoutPages(st.pending, [forPageId]))));
  // The canvas must not move this page out from under the writes (see pinnedPageId).
  pinnedPageId = forPageId;

  // ── A whole-page change runs on its own ──
  //
  // A layout rebuild and a PDF page copy each replace every element on a page, so
  // neither can be mixed with element edits. Anything staged with one STAYS WAITING
  // (it used to be thrown away with a toast) — the user decides what happens to it.
  const exclusive = list.find((p) => isExclusiveKind(p.kind));
  if (exclusive) {
    const others = list.filter((p) => p !== exclusive);
    const sayOthers = () => {
      if (others.length > 0 && !quiet) {
        toast.message(
          `${changeCount(others.length)} staged with it ${others.length === 1 ? 'is' : 'are'} still waiting — a page rebuild runs on its own. ` +
            `Check ${others.length === 1 ? 'it' : 'them'} before applying: ${others.length === 1 ? 'it was' : 'they were'} written for the page as it was.`,
        );
      }
    };
    if (exclusive.kind === 'apply-layout') {
      const reading = exclusive.layoutReading as api.LayoutReading | undefined;
      if (!reading) {
        // Malformed — it can never run. Dropped, and said.
        keep(others);
        report.refused = 1;
        report.waiting = others.length;
        if (!quiet) toast.error('That layout could not be applied — ask the assistant to read the image again.');
        return report;
      }
      // Straight through the same store action the panel uses, and the confirm
      // genuinely lives in there. `pageId` is set only when the user NAMED a page; the
      // server resolved the ordinal against the real page order, so this is an id and
      // not an index that could have drifted since the assistant answered.
      await get().applyLayout(reading, exclusive.pageId);
      if (layoutOutcome === 'done') {
        keep(others);
        report.applied = 1;
        report.started = 'layout';
        report.waiting = others.length;
        sayOthers();
      } else if (layoutOutcome === 'declined') {
        report.declined = true;
        report.waiting = list.length;
      } else {
        // It failed, and applyLayout already said why. It stays waiting — to try again
        // once the page has settled, or to discard.
        report.refused = 1;
        report.waiting = list.length;
      }
      return report;
    }
    // 'copy-document-page': the page panel's "Copy a page exactly", asked for in chat.
    // Same confirm as that panel — it cannot be undone and it re-shapes the page —
    // naming the page it will overwrite, which may not be the one on screen.
    const targetId = exclusive.pageId ?? forPageId;
    if (!exclusive.docId || !exclusive.sourcePage || !get().pages.some((p) => p.id === targetId)) {
      keep(others);
      report.refused = 1;
      report.waiting = others.length;
      if (!quiet) toast.error('That copy could not be started — ask the assistant again.');
      return report;
    }
    const n = pageNumberIn(get().pages, targetId);
    const ok = window.confirm(
      `Copy page ${exclusive.sourcePage} of that PDF onto ${n > 0 ? `page ${n}` : 'this page'}?\n\n` +
        `That page's current contents are replaced with the PDF page's own text, pictures and colours — it cannot be undone. ` +
        `The page also takes on the source page's shape, so it may end up a different size from the rest of the magazine.`,
    );
    if (!ok) {
      report.declined = true;
      report.waiting = list.length;
      return report;
    }
    const started = await startPageCopy(set, get, exclusive.docId, exclusive.sourcePage, targetId);
    if (!started) {
      // Refused by the server (startPageCopy said why). Still waiting, to retry or discard.
      report.refused = 1;
      report.waiting = list.length;
      return report;
    }
    keep(others);
    report.applied = 1;
    report.started = 'copy';
    report.waiting = others.length;
    sayOthers();
    // Followed in the background: the copy is a worker job, and the apply must not sit
    // "applying" for the minute it can take. The follow brings the copied page onto the
    // canvas — before, nothing did, and later edits went to elements the copy had
    // already replaced.
    void followPageCopy(set, get, started.pageId, started.revBefore);
    return report;
  }

  // Refusals are COUNTED, not just survived. Each loop keeps going after a failure
  // (one bad proposal shouldn't strand the rest), but the result has to reflect what
  // actually happened: a page op can legitimately be refused — a submitted page, a
  // published draft — and reporting "Applied the assistant's changes" over a
  // swallowed 409 tells the user their magazine changed when it did not.
  let refused = 0;
  let applied = 0;
  let elementWrites = 0;
  let pageOps = 0;

  // A staged text edit carries its box's WHOLE new content, written from the words the
  // box had when it was staged — and changes wait per page for up to 30 days. One whose
  // box has been edited since (typed in, undone, another apply) is HELD, not written
  // over that edit: it stays waiting, marked, and a second Apply uses it anyway.
  const open = get().page;
  const { apply: elementProps, held: staleHeld } = holdStaleTextChanges(
    list.filter((p) => !isPageKind(p.kind)),
    open && open.id === forPageId ? open.elements : [],
  );
  const pageProps = list.filter((p) => isPageKind(p.kind));

  // ── A page build cannot start while one is running ──
  //
  // generatePages bails while `generating` (one build at a time), and this used to
  // count the staged build as applied anyway: "Applied the assistant's changes", and
  // no pages, ever. It stays waiting instead, to apply again once the running build
  // finishes.
  const building = get().generating || get().issue?.status === 'processing';
  const heldBack: AgentProposal[] = building ? pageProps.filter((p) => p.kind === 'generate-pages') : [];
  const pageRun = building ? pageProps.filter((p) => p.kind !== 'generate-pages') : pageProps;

  // ── Page changes, every page pinned by ID against the list as it is NOW ──
  // (see planPageSteps: "delete pages 3 and 4" used to delete 3 and 5).
  const startPages = get().pages;
  const originalIds = inOrder(startPages).map((p) => p.id);
  const { steps } = planPageSteps(pageRun, startPages);

  // ── Deleting a page cannot be undone: ask first, naming each page ──
  //
  // Asked BEFORE anything is written, so "no" leaves the pages and every waiting
  // change exactly as they were.
  const removals = steps.filter((x) => x.op === 'remove' && !!x.pageId) as { op: 'remove'; proposal: AgentProposal; pageId: string }[];
  if (removals.length > 0) {
    const targets = removals.map((r) => {
      const sum = startPages.find((p) => p.id === r.pageId);
      const open = get().page;
      const els = open && open.id === r.pageId ? open.elements : get().thumbs[r.pageId]?.elements;
      return { number: sum ? sum.index + 1 : 0, headline: pageHeadline(els) };
    });
    if (!window.confirm(removalQuestion(targets))) {
      report.declined = true;
      report.waiting = list.length;
      return report;
    }
  }

  // 1) Element edits (and the background) on this page — rev-guarded CRUD; add → id
  // remap.
  //
  // The whole apply is ONE undo entry, so the user takes the assistant's turn back
  // with the one Ctrl+Z they expect (Apply all opens one batch around every page,
  // which this joins). Every write is judged by its RETURN VALUE, not by whether it
  // threw: these store actions absorb their own errors (that is how a conflict
  // reconciles instead of exploding), so they never reject.
  //
  // An 'add' that fails also has to STOP the proposals that depended on it: with no
  // id in the map, a later update/delete naming the temp id would be sent to the
  // server as if it were real, get refused for a different reason, and be counted
  // twice. Its dependants are counted once, here, and never sent.
  const idMap = new Map<string, string>();
  const dead = new Set<string>();
  /** Not tried because the page moved under the apply — these stay waiting. */
  const untried: AgentProposal[] = [];
  await get().batchEdits('the assistant’s changes', async () => {
    for (const p of elementProps) {
      if (get().currentPageId !== forPageId || get().issueId !== issueId) {
        untried.push(p);
        continue;
      }
      if (p.kind === 'add' && p.element) {
        const newId = await get().addElement(p.element);
        if (!newId) { refused++; if (p.tempId) dead.add(p.tempId); continue; }
        if (p.tempId) idMap.set(p.tempId, newId);
        applied++;
        elementWrites++;
      } else if (p.kind === 'update' && p.elementId && p.patch) {
        if (dead.has(p.elementId)) { refused++; continue; }
        if (await get().commit(idMap.get(p.elementId) ?? p.elementId, p.patch)) { applied++; elementWrites++; }
        else refused++;
      } else if (p.kind === 'delete' && p.elementId) {
        if (dead.has(p.elementId)) { refused++; continue; }
        if (await get().deleteElement(idMap.get(p.elementId) ?? p.elementId)) { applied++; elementWrites++; }
        else refused++;
      } else if (p.kind === 'set-background' && p.background) {
        if (await get().setPageBackground(p.background)) { applied++; elementWrites++; }
        else refused++;
      } else {
        // A change with nothing to apply (no patch, no element) — counted, not hidden.
        refused++;
      }
    }
  });

  // 2) Page structure: moves, then deletions, then new pages (planPageSteps). A move
  // or a new page finds its place against the list as it is at that moment, by page
  // id; a deletion names its page by id. Nothing is resolved against a position an
  // earlier step has already shifted.
  const idsNow = () => inOrder(get().pages).map((p) => p.id);
  let deferGenerate: { proposal: AgentProposal; beforePageId: string | undefined } | null = null;
  for (const step of steps) {
    try {
      if (step.op === 'reorder') {
        const at = reorderIndices(step.proposal, idsNow());
        if (at === null) refused++;
        else if (at === 'in-place') applied++;
        else {
          const { pages } = await api.reorderPages(issueId, at.from, at.to);
          set({ pages, editedSinceLoad: true });
          applied++;
          pageOps++;
        }
      } else if (step.op === 'remove') {
        const target = step.pageId ? get().pages.find((x) => x.id === step.pageId) : undefined;
        // A target that has since gone (or the last remaining page, which the server
        // won't delete) is a refusal, not a silent skip.
        if (!target || get().pages.length <= 1) refused++;
        else if (target.review === 'submitted') {
          // Deleting a SUBMITTED page is refused first time with a 409 naming who
          // submitted it. Route it through the store's own deletePage so the owner gets
          // that confirmation dialog instead of a silent no-op.
          const before = get().pages.length;
          await get().deletePage(target.id);
          if (get().pages.length === before) refused++;
          else { applied++; pageOps++; }
        } else {
          const { pages } = await api.deletePage(issueId, target.id);
          // Same pruning as deletePage's own path — this branch skips it only because it
          // doesn't need the submitted-page confirmation. The deleted page's own waiting
          // changes go with it (counted in the toast below by the caller's report).
          set((st) => ({
            pages,
            editedSinceLoad: true,
            undoStack: withoutPage(st.undoStack, target.id),
            redoStack: withoutPage(st.redoStack, target.id),
            ...(target.id !== forPageId ? withPending(st, withoutPages(st.pending, [target.id])) : {}),
          }));
          if (get().currentPageId === target.id && pages[0]) await get().openPage(pages[0].id);
          applied++;
          pageOps++;
        }
      } else if (step.op === 'add-page') {
        const { pages } = await api.addPage(issueId, insertIndexFor(step.beforePageId, idsNow(), originalIds));
        set({ pages, editedSinceLoad: true });
        applied++;
        pageOps++;
      } else if (step.op === 'generate-pages' && step.proposal.count) {
        // One build per apply — they cannot overlap. A second staged build waits for
        // the next press rather than being quietly merged away.
        if (deferGenerate) heldBack.push(step.proposal);
        else deferGenerate = { proposal: step.proposal, beforePageId: step.beforePageId };
      }
    } catch {
      refused++;
    }
  }
  // The build starts LAST, once the page list has settled, so its position is read
  // against the final order. It is counted only if it really started.
  if (deferGenerate) {
    const g = deferGenerate.proposal;
    const docIds = g.docIds && g.docIds.length > 0 ? g.docIds : g.docId ? [g.docId] : undefined;
    if (await get().generatePages(g.count!, g.topic, insertIndexFor(deferGenerate.beforePageId, idsNow(), originalIds), docIds)) {
      applied++;
      pageOps++;
    } else refused++;
  }

  // Whatever could not run yet stays waiting, for this page. The check the last turn
  // returned now describes the page itself, not changes in waiting.
  const rest = [...staleHeld, ...heldBack, ...untried];
  keep(rest);
  set((st) => (st.lastCheck && st.lastCheckPageId === forPageId ? { lastCheckApplied: true } : {}));
  Object.assign(report, { applied, refused, elementWrites, pageOps, waiting: rest.length, ...(staleHeld.length > 0 ? { stale: staleHeld.length } : {}) });
  if (quiet) return report;

  if (staleHeld.length > 0) {
    const one = staleHeld.length === 1;
    toast.warning(
      `${one ? 'One text change was' : `${staleHeld.length} text changes were`} not applied: ${one ? 'its box was' : 'their boxes were'} edited after the assistant staged ${one ? 'it' : 'them'}, and applying would overwrite that edit. ` +
        `${one ? 'It is' : 'They are'} still waiting — press “Use these changes” again to use ${one ? 'it' : 'them'} anyway, or discard.`,
      { duration: 12_000 },
    );
  }

  if (untried.length > 0) {
    toast.warning(`The page changed under the apply, so ${changeCount(untried.length)} ${untried.length === 1 ? 'was' : 'were'} not tried — ${untried.length === 1 ? 'it is' : 'they are'} still waiting. Press “Use these changes” again on that page.`);
  }
  if (heldBack.length > 0) {
    toast.warning(
      building
        ? 'A page build is still running, so the new pages were not started. Press “Use these changes” again once it finishes.'
        : 'Only one page build can run at a time — press “Use these changes” again once this one finishes to start the next.',
    );
  }
  // Three outcomes, not two. "Applied what I could" is the right sentence for a
  // PARTIAL apply and the wrong one for a total refusal — where nothing was applied
  // and there is nothing to undo. And "Undo with Ctrl+Z" is promised only for what the
  // undo stack really covers: page deletions, moves and new pages are not on it.
  if (refused > 0 && applied === 0) {
    toast.error(
      `Couldn't apply ${refused === 1 ? 'that change' : `any of those ${refused} changes`} — the page didn't accept ${refused === 1 ? 'it' : 'them'}. Nothing was altered.`,
    );
  } else if (refused > 0) {
    toast.warning(`Applied ${applied} change${applied === 1 ? '' : 's'} — ${refused} ${refused === 1 ? 'was' : 'were'} refused.${pageOps === 0 ? ' Undo with Ctrl+Z.' : ''}`);
  } else if (applied > 0) {
    toast.success(appliedMessage(elementWrites, pageOps));
  }
  return report;
}

// ── Undo/redo replay ────────────────────────────────────────────────────────
//
// These three write through the SAME rev-guarded endpoints as everything else, but
// deliberately bypass the store's own actions: those record undo ops, and a replay
// that records its own inverse would make Ctrl+Z toggle one change back and forth
// forever instead of walking back through history. (`replaying` is belt-and-braces
// for anything that reaches them indirectly.)

/** Adopt the server's page from a 409 so the ops still to come use a live rev. */
function adoptConflict(e: unknown, pageId: string, set: any, get: any) {
  if (e instanceof ApiError && e.status === 409 && e.body?.page) {
    const fresh = e.body.page as MagazinePageV2;
    if (get().page?.id === pageId) set({ page: fresh });
  }
}

async function replayUpdate(issueId: string, pageId: string, elementId: string, target: MagazineElement, set: any, get: any) {
  const page = get().page as MagazinePageV2 | null;
  if (!page || page.id !== pageId) throw new Error('page not open');
  const { element, rev } = await api.patchElement(issueId, pageId, elementId, page.rev, target);
  set((st: EditorState) => ({
    page: st.page && st.page.id === pageId
      ? { ...st.page, rev, elements: st.page.elements.map((x) => (x.id === elementId ? element : x)) }
      : st.page,
    editedSinceLoad: true,
  }));
}

async function replayRemove(issueId: string, pageId: string, elementId: string, set: any, get: any) {
  const page = get().page as MagazinePageV2 | null;
  if (!page || page.id !== pageId) throw new Error('page not open');
  const { rev } = await api.deleteElement(issueId, pageId, elementId, page.rev);
  set((st: EditorState) => ({
    page: st.page && st.page.id === pageId ? { ...st.page, rev, elements: st.page.elements.filter((x) => x.id !== elementId) } : st.page,
    selectedId: st.selectedId === elementId ? null : st.selectedId,
    editedSinceLoad: true,
  }));
}

/** Put a page's background back (or forward) to exactly what was stored. */
async function replayBackground(issueId: string, pageId: string, target: MagazinePageV2['background'], set: any, get: any) {
  const page = get().page as MagazinePageV2 | null;
  if (!page || page.id !== pageId) throw new Error('page not open');
  const { page: stored } = await api.setPageBackground(issueId, pageId, page.rev, target);
  set((st: EditorState) => {
    if (!st.page || st.page.id !== pageId) return { editedSinceLoad: true };
    const next = { ...st.page, rev: typeof stored?.rev === 'number' ? stored.rev : st.page.rev, background: stored?.background ?? target };
    return { page: next, thumbs: { ...st.thumbs, [pageId]: next }, editedSinceLoad: true };
  });
}

/** Put a deleted element back — same id, same source (see api.addElement's
 *  `restore`), so later stack entries naming it still resolve. */
async function replayRestore(issueId: string, pageId: string, element: MagazineElement, set: any, get: any) {
  const page = get().page as MagazinePageV2 | null;
  if (!page || page.id !== pageId) throw new Error('page not open');
  const { element: created, rev } = await api.addElement(issueId, pageId, page.rev, element, true);
  set((st: EditorState) => ({
    page: st.page && st.page.id === pageId ? { ...st.page, rev, elements: [...st.page.elements, created] } : st.page,
    editedSinceLoad: true,
  }));
}

/**
 * Replay one stack entry's ops in the given direction.
 *
 * Every op is attempted even if an earlier one fails, so a single stale op can't
 * strand the rest of the entry half-applied — but failures are COUNTED and said out
 * loud. "Undid the assistant's changes" over a swallowed refusal is the one thing
 * undo must never do: the user would believe the page went back and it did not.
 *
 * Returns true only if the entry replayed cleanly (the caller moves it to the other
 * stack); on a partial failure the entry is dropped rather than offered for redo.
 */
async function replayOps(ops: UndoOp[], dir: 'undo' | 'redo', set: any, get: any): Promise<boolean> {
  const issueId = get().issueId as string | null;
  if (!issueId) return false;
  replaying = true;
  let failed = 0;
  let abandoned = false;
  try {
    for (const op of ops) {
      // Opened another magazine mid-replay (each op is a round trip) — stop rather
      // than write this magazine's history into that one.
      if (get().issueId !== issueId) {
        abandoned = true;
        break;
      }
      // Belt-and-braces against a page that has since been deleted elsewhere (another
      // tab, a collaborator): openPage on a missing page would put the editor into its
      // error state, which is a much louder failure than a skipped op deserves.
      if (!get().pages.some((p: PageSummary) => p.id === op.pageId)) {
        failed++;
        continue;
      }
      // The op may be on a page you have scrolled away from since — bring it back, so
      // undo works wherever you are rather than only on the page you're looking at.
      if (get().page?.id !== op.pageId) await get().openPage(op.pageId);
      try {
        if (op.op === 'background') {
          await replayBackground(issueId, op.pageId, dir === 'undo' ? op.before : op.after, set, get);
        } else if (op.op === 'update') {
          await replayUpdate(issueId, op.pageId, op.elementId, dir === 'undo' ? op.before : op.after, set, get);
        } else if ((op.op === 'add') === (dir === 'undo')) {
          // Undoing an add, or redoing a delete → the element goes away again.
          await replayRemove(issueId, op.pageId, op.element.id, set, get);
        } else {
          // Undoing a delete, or redoing an add → the element comes back.
          await replayRestore(issueId, op.pageId, op.element, set, get);
        }
      } catch (e) {
        adoptConflict(e, op.pageId, set, get);
        failed++;
      }
    }
  } finally {
    replaying = false;
  }
  // Abandoned because the user moved on: no toast (they are looking at something
  // else) and no push onto the other stack — load() has cleared both anyway.
  if (abandoned) return false;
  if (failed > 0) {
    toast.warning(
      failed === ops.length
        ? `Couldn't ${dir === 'undo' ? 'undo' : 'redo'} that — the page has changed since.`
        : `${dir === 'undo' ? 'Undid' : 'Redid'} what I could — ${failed} change${failed === 1 ? '' : 's'} no longer applied.`,
    );
  }
  return failed === 0;
}

/**
 * Put one element back the way it was after a refused write.
 *
 * Used only where the write was OPTIMISTIC (commit), and only when nothing else has
 * already replaced the page. With a `before` snapshot this is exact; without one
 * (a commit whose caller passed none, on an element that has since gone) the stored
 * page is re-read instead, because a wrong local guess is worse than a round trip.
 */
function revertElement(
  pageId: string,
  elementId: string,
  before: MagazineElement | undefined,
  set: any,
  get: any,
) {
  if (before) {
    set((st: EditorState) => ({
      page: st.page && st.page.id === pageId
        ? { ...st.page, elements: st.page.elements.map((x) => (x.id === elementId ? before : x)) }
        : st.page,
    }));
    return;
  }
  const issueId = get().issueId as string | null;
  if (!issueId) return;
  void api
    .getPage(issueId, pageId)
    .then((stored) => {
      if (get().page?.id === pageId) set({ page: stored });
    })
    .catch(() => {
      /* the caller's toast already said the write failed; leave state alone */
    });
}

/**
 * Shared write-error handling: a 409 reconciles to the server's current page.
 * Keeps the user's SELECTION if that element still exists on the fresh page —
 * blanking it is what made the inspector snap to "Nothing selected" after a
 * conflict and read as a dead panel.
 *
 * Returns whether the page was RECONCILED (replaced with, or re-read from, what the
 * server actually holds). 'unreconciled' means only a toast happened, so a caller
 * that painted an optimistic change still has to take it back.
 */
function handleWriteError(e: unknown, set: any, get: any): 'reconciled' | 'unreconciled' {
  if (e instanceof ApiError && e.status === 409 && e.body?.page) {
    const fresh = e.body.page as MagazinePageV2;
    const keep = get().selectedId as string | null;
    const stillThere = Array.isArray(fresh.elements) && fresh.elements.some((x: MagazineElement) => x.id === keep);
    // Only adopt it if it IS the page on screen — the user may have moved on while
    // this write was in flight, and pasting another page's elements over the open
    // one is a far louder failure than the conflict itself.
    if (get().page?.id !== fresh.id) return 'reconciled';
    set({ page: fresh, selectedId: stillThere ? keep : null });
    toast.message('This page was updated elsewhere — reloaded the latest.');
    return 'reconciled';
  }
  // A STATE block (page-submitted / page-approved) carries a `reason`
  // and no page body. Writes are optimistic — updateLocal already painted the change —
  // so without re-reading the stored page the canvas would keep showing an edit the
  // server refused, and the user would believe it saved. Re-fetch to discard it.
  if (e instanceof ApiError && e.status === 409 && typeof e.body?.reason === 'string') {
    const { issueId, page } = get();
    if (issueId && page) {
      const pageId = page.id as string;
      void api
        .getPage(issueId, pageId)
        .then((stored) => {
          if (get().page?.id === pageId) set({ page: stored });
        })
        .catch(() => {
          /* the toast below already told them; leave state alone */
        });
    }
    toast.error(e.message);
    return 'reconciled';
  }
  toast.error(e instanceof Error ? e.message : 'Save failed');
  return 'unreconciled';
}
