// ---------------------------------------------------------------------------
// Magazine Builder v2 — Operator actions for the STUDIO
// (/production-system/magazine-v2/:id). Catalog twin:
// apps/server/src/lib/agent/operator/catalog/magazine.ts ('magazine-editor').
//
// HOW EACH ACTION ACTS, per THE RULE in agent/operator/contracts.ts:
//
//   driven visibly (ui.click / ui.type / ui.select on data-agent-id anchors):
//     goToPage, addPage, duplicatePage, addAiPages, addMorePages, rename,
//     sharePages, unshare, askStudio, applyStudioChanges, discardStudioChanges,
//     publish, unpublish, fillPage / adjustPage (the per-page AI wands above each
//     page on the canvas), setPageInPublish (that header's "publish" tick), undo,
//     redo, zoom, setCover, openReviewBoard, reviewPages,
//     and movePage when it is a single step (the tile's own ▲/▼ buttons).
//
//   Outcomes that the UI reports only as a toast (Fill/Adjust, the publish tick,
//   the cover, review moves) are read back from the toast the user saw
//   (shared.watchToasts) alongside the store.
//
//   the SAME store handler the button calls, with the cursor pointed at the
//   control first and the result flashed — only where clicking would hit a
//   window.confirm the Operator has already asked for in its own card:
//     deletePage (the tile's 🗑 asks window.confirm) → store.deletePage
//     movePage over more than one slot (drag-and-drop) → store.reorder
//
// SEEING THE PAGE. readScreen collects text whether or not it is cut off and never
// sees a picture, so "check the page with readScreen" passed pages with clipped
// copy and the Stable Hand ended up telling users it could not see the page. Now:
//   magazine.checkPage    measures a page as it renders in THIS browser
//                         (editor-v2/pageCheck.measurePage: an off-screen copy at
//                         the page's own width, real fonts and images) and returns
//                         the issues with element ids, numbers and a fix each;
//   magazine.lookAtPage   adds a visual review of the STORED page, rendered on the
//                         server (POST …/look), alongside that measurement;
//   and every action that changes a page (askStudio / applyStudioChanges /
//   waitForStudio with apply, fillPage, adjustPage, addChart, editChart,
//   replaceText) measures it afterwards and returns `pageCheck` itself.
//
// CHARTS (magazine.addChart / editChart) are drawn by the server from the exact
// numbers (POST …/chart — never an image model) and placed through the store's own
// addElement / commit inside one batchEdits, so the chart is one Ctrl+Z like any
// other edit, rev-guarded like any other write.
//
// STAGED STUDIO CHANGES WAIT PER PAGE until applied or discarded (store `pending`;
// they used to be one tray that each new request replaced, so asking twice lost the
// first set). askStudio reports what its turn REALLY staged — proposalCount and the
// deterministic stagedLine, built from the proposals, never the reply's own claim —
// plus every page's waiting changes (pendingChanges); apply:true applies that page's.
// applyStudioChanges presses the "Apply all" bar: every page, in page order, with a
// per-page report. magazine.status lists them too, so none is ever forgotten.
//
// WORD SWAPS (magazine.replaceText) go through POST …/replace-text: a dry run
// counts the matches on every page this user can edit, the user OKs a card with
// the count per page, then only the matching words change. askStudio refuses a
// magazine-wide swap and points here — the studio edits only the open page.
//
// Reads (status, listStaff) come from the editor store and the Share dialog's
// own GET. Server RBAC applies to every write exactly as it does for a click;
// the `enabled` flags below keep out of the model's list what the server would
// refuse this user: owner-only writes need ownership, studio writes need the
// magazine shared with you, and EVERY write needs the role's `magazine.edit`
// (publishing also `magazine.publish`). Outcomes the store reports only as a
// toast are read back from it — success is never assumed from "it went quiet".
// ---------------------------------------------------------------------------

import { useRef } from 'react';
import { z } from 'zod';
import { useAgentAction } from '@/agent/operator/runtime/registry';
import type { UiDriver } from '@/agent/operator/contracts';
import { presence } from '@/agent/operator/presence';
import { useEditorStore } from '../store';
import { buildStatus } from '../buildStatus';
import { columnOf, COLUMN_LABEL, COLUMN_ORDER, publishBlockedReason, readOnlyReason, submittablePages, type ReviewColumn } from '../review';
import { useOperatorJobs } from '@/agent/operator/runtime/jobs';
import { JOB_STARTED_NOTE, magazineBuildJobId, settlePreviousBuildJob, startMagazineBuildJob } from './magazineJobs';
import {
  ApiError,
  createChart,
  getPage,
  inviteRoles,
  listMedia,
  listSources,
  listUploads,
  lookAtPage as requestPageLook,
  replaceText as requestReplaceText,
  type ChartResult,
  type InviteRoleOption,
  type PageSummary,
  type V2Collaborator,
} from '../api';
import type { AgentProposal, IssuePageData, MagazineElement, PageCheck } from '../model';
import { measurePage } from '../pageCheck';
import { copyNoticeText } from '../pageCopy';
import { applyOutcome, applyReportLine, changeCount, pagesPhrase, pendingFor, waitingPages, type PageApplyReport } from '../pendingChanges';
import { actionError, personDisplay } from '@/agent/operator/runtime/humanRef';
import {
  appliedNote,
  applyAllQuestion,
  chartSpecArgs,
  fixEstimate,
  fixPagesQuestion,
  fixRequestText,
  humanizeElementIds,
  magazineWideSwap,
  MAX_STUDIO_REQUESTS_PER_RUN,
  measuredSentence,
  mergeChartChanges,
  pageElementList,
  pickDocument,
  replaceLeftAlone,
  replaceQuestion,
  studioPrompt as rewriteStudioPrompt,
  type DocChoice,
  type WebChartSpec,
} from './editorActionsPure';
import {
  anchor,
  assertEnabled,
  clickIfPresent,
  collaboratorsOut,
  pendingSharesOut,
  isEmailAddress,
  ensureRail,
  errorToasts,
  firstError,
  loadDirectory,
  matchPeople,
  openPageN,
  pageAt,
  pageListLabel,
  pageNo,
  pageNoOf,
  personLabelAsync,
  problemToasts,
  resolvePerson,
  revealToolbarItem,
  scopeNumbers,
  sleep,
  waitUntil,
  watchPageList,
  watchToasts,
  useRoleCanEditMagazines,
  type SeenToast,
} from './shared';

const get = () => useEditorStore.getState();
const editorRoute = (id: string) => `/production-system/magazine-v2/${id}`;
const isBuilding = () => {
  const s = get();
  return s.generating || s.issue?.status === 'processing';
};

/** The store once the magazine on screen has loaded. */
async function ready(ui: UiDriver) {
  return waitUntil(
    () => {
      const s = get();
      return !s.loading && s.issue ? s : null;
    },
    { signal: ui.signal, timeoutMs: 30_000, what: 'the magazine to load' },
  );
}

/** Refuse a page-structure change while a build runs: the server answers 409
 *  ("still processing") to every structural write until it finishes. */
function refuseWhileBuilding(what: string) {
  if (isBuilding()) {
    throw new Error(`Pages are still being built — ${what} once the build finishes (a [job-update] message arrives when it does).`);
  }
}

/**
 * Click a control whose store handler reports a refusal only as an error toast,
 * then wait for `done`. Fails FAST with the toast's own words instead of sitting
 * out the whole timeout (a 409 used to surface as "Timed out waiting for …").
 */
async function clickAndAwait(ui: UiDriver, agentId: string, label: string, done: () => boolean, what: string, timeoutMs = 20_000) {
  const toasts = watchToasts();
  try {
    await ui.click(agentId, label);
    await waitUntil(() => done() || !!firstError(toasts.peek()), { signal: ui.signal, timeoutMs, what });
  } finally {
    toasts.stop();
  }
  if (!done()) throw new Error(firstError(toasts.peek()) || `That did not work — ${what} never happened.`);
}

/** Open a dropdown (publish / More) unless its item is already showing. Clicking
 *  the trigger of an OPEN menu would close it, hence the check. */
async function openMenu(ui: UiDriver, trigger: string, item: string, label?: string) {
  if (anchor(item)) return;
  await ui.click(trigger, label);
  await ui.waitFor(item, 4000);
}

async function openShareDialog(ui: UiDriver) {
  if (anchor('mag.share-dialog')) return;
  ui.step('Opening the Share dialog');
  await openMenu(ui, 'mag.more-button', 'mag.share-button', 'More');
  await ui.click('mag.share-button', 'Share with staff…');
  await ui.waitFor('mag.share-dialog', 5000);
}

async function closeShareDialog(ui: UiDriver) {
  await clickIfPresent(ui, 'mag.share-close', 'Close');
}

/** The Magazine AI Studio pane open on its Chat tab (where the staged-changes
 *  tray and the composer live). Never starts a new chat — that would throw the
 *  staged changes away (store.newThread clears them). */
async function ensureStudioPanel(ui: UiDriver) {
  // The whole assistant pane can be toggled away from the toolbar.
  if (!anchor('mag.ai-tab-chat')) {
    await ui.click('mag.ai-toggle', 'AI');
    await ui.waitFor('mag.ai-tab-chat', 4000);
  }
  // The thread picker only renders on the Chat tab.
  if (!anchor('mag.ai-new-chat')) {
    await ui.click('mag.ai-tab-chat', 'Chat');
    await ui.waitFor('mag.ai-new-chat', 3000);
  }
}

/** The Magazine AI Studio composer, on screen and writable. */
async function ensureStudioComposer(ui: UiDriver) {
  if (anchor('mag.ai-input')) return;
  await ensureStudioPanel(ui);
  // Still no composer = a read-only conversation (someone else's, or the legacy
  // log). Start a fresh chat of our own, exactly as a person would.
  if (!anchor('mag.ai-input')) await clickIfPresent(ui, 'mag.ai-new-chat', 'Start a new chat');
  await ui.waitFor('mag.ai-input', 5000);
}

/** A collaborator already on this magazine matching a userId / email / name. */
function findCollaborator(person: string, cs: V2Collaborator[] | undefined): V2Collaborator | undefined {
  const q = person.trim().toLowerCase();
  const list = cs ?? [];
  return (
    list.find((c) => c.userId === person.trim() || c.email.toLowerCase() === q || (c.displayName || '').toLowerCase() === q) ??
    (() => {
      const partial = list.filter((c) => (c.displayName || '').toLowerCase().includes(q));
      return partial.length === 1 ? partial[0] : undefined;
    })()
  );
}

/** A collaborator as a confirm card / step names them: name → email. */
const collabName = (c: V2Collaborator) => personDisplay({ name: c.displayName, email: c.email });

/** Does this collaborator already have exactly these pages (null = all pages)? */
/** The pending share (someone invited through a share, not joined yet) for an address. */
function findPending(person: string, issue: { pendingCollaborators?: { email: string; pageIds: string[] | 'all' }[] } | null | undefined) {
  const q = person.trim().toLowerCase();
  return (issue?.pendingCollaborators ?? []).find((p) => p.email.toLowerCase() === q);
}

/** Someone NOT on the team: an email address the staff directory doesn't know.
 *  Null when `person` is staff (or not an email at all — then resolvePerson's
 *  error asks for an address). */
async function newPersonEmail(person: string): Promise<string | null> {
  if (!isEmailAddress(person)) return null;
  const list = await loadDirectory().catch(() => null);
  if (list && matchPeople(list, person).length > 0) return null;
  return person.trim().toLowerCase();
}

/** "Editor" · "Editor (can't edit magazines)" — how the model lists choices to the user. */
const roleChoice = (r: InviteRoleOption) => (r.canUseMagazines ? r.label : `${r.label} (can't edit magazines)`);

/**
 * The role a NEW person joins the team with — always the USER's choice, never a
 * guess. Returns the matched role, or null when no role applies (the owner can't
 * send invites, or they are already pending — their invite has its role). With
 * no `role` arg it throws an error that asks the user, listing the choices.
 */
async function inviteRoleFor(issueId: string, email: string, role: string | undefined, alreadyPending: boolean): Promise<InviteRoleOption | null> {
  const opts = await inviteRoles(issueId);
  if (!opts.canInvite) return null;
  if (opts.roles.length === 0) throw new Error(`${email} isn't on the team yet, and there's no role you're allowed to give — ask someone who manages the team to invite them.`);
  if (!role) {
    if (alreadyPending) return null;
    throw actionError(
      `${email} isn't on the team yet, so they'll be invited. Ask the user which role they should join with: ${opts.roles.map(roleChoice).join(', ')}. Then call again with role.`,
      { roles: opts.roles.map((r) => ({ role: r.name, label: r.label, canEditMagazines: r.canUseMagazines })) },
    );
  }
  const q = role.trim().toLowerCase();
  const hit = opts.roles.find((r) => r.name.toLowerCase() === q || r.label.toLowerCase() === q);
  if (!hit) throw new Error(`"${role}" isn't a role you can give. The choices are: ${opts.roles.map(roleChoice).join(', ')}.`);
  return hit;
}

function hasScope(c: Pick<V2Collaborator, 'pageIds'>, wantIds: string[] | null): boolean {
  if (!wantIds) return c.pageIds === 'all';
  if (c.pageIds === 'all') return false;
  const have = c.pageIds.map(String);
  const want = new Set(wantIds);
  return have.length === want.size && [...want].every((id) => have.includes(id));
}

/** Wait for a dialog's busy button to settle: gone (success closed it), or no
 *  longer busy after a grace period (validation refusal / server error). */
async function settle(ui: UiDriver, agentId: string, done: () => boolean, what: string) {
  const t0 = Date.now();
  await waitUntil(
    () => {
      if (done()) return true;
      const el = anchor(agentId);
      if (Date.now() - t0 > 900 && (!el || el.getAttribute('aria-busy') !== 'true')) return true;
      return false;
    },
    { signal: ui.signal, timeoutMs: 45_000, what },
  );
}

/** Live on Bulletins right now — see the note on magazine.unpublish. */
function isLiveIssue(issue: { publishedIssueId?: string | null; status?: string } | null | undefined): boolean {
  return !!issue?.publishedIssueId && issue.status === 'published';
}

/**
 * Why the server would refuse this publish (pages shared with someone that are
 * not approved, or edited since), or '' — the studio's own rule (review.ts,
 * mirrored from the server's publishGate). A full edition is judged on every
 * page; a selected publish only on the pages that would go out.
 */
function publishRefusal(pages?: number[]): string {
  const s = get();
  if (!pages) {
    const why = publishBlockedReason(s.issue, s.pages, 'full');
    return why ? `${why} Approve them on the review board first, or publish only the other pages.` : '';
  }
  const want = new Set(pages);
  const asIfTicked = s.pages.map((p) => ({ ...p, selectedForPublish: want.has(pageNo(p)) }));
  const why = publishBlockedReason(s.issue, asIfTicked, 'selected');
  return why ? `${why} Approve them on the review board first, or leave them out.` : '';
}

// ── Seeing the page ──────────────────────────────────────────────────────────

const stopped = () => new DOMException('The Stable Hand was stopped.', 'AbortError');

/**
 * `work`, unless it takes longer than `ms` or the run is stopped. measurePage waits
 * for fonts and every picture on the page; a picture whose host never answers must
 * not hold a whole action hostage — the action then says the page could not be
 * measured and the model calls magazine.checkPage again.
 */
function within<T>(work: Promise<T>, ms: number, signal: AbortSignal, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(stopped());
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(stopped());
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${what} took longer than ${Math.round(ms / 1000)}s`));
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (v) => {
        cleanup();
        resolve(v);
      },
      (e) => {
        cleanup();
        reject(e);
      },
    );
  });
}

const MEASURE_MS = 20_000;

/** Design Helper requests made by magazine.askStudio in each Stable Hand run, keyed by
 *  the run's abort signal (a new run gets a new signal; see uiDriver). */
const studioRequestsPerRun = new WeakMap<AbortSignal, number>();

/**
 * Measure one page in this browser. Never throws for a failed measurement (the
 * reason comes back instead, so a change that DID land is not reported as failed
 * because its check could not run) — only a Stop stops it.
 */
async function measureSafely(page: IssuePageData | null | undefined, signal: AbortSignal): Promise<{ check: PageCheck | null; why?: string }> {
  if (!page) return { check: null, why: 'the page is not loaded' };
  try {
    return { check: await within(measurePage(page), MEASURE_MS, signal, 'measuring the page') };
  } catch (e) {
    if (signal.aborted) throw e;
    return { check: null, why: e instanceof Error ? e.message : String(e) };
  }
}

/** Measure the OPEN page (optionally only if it is `pageId`) — the page every
 *  apply, Fill/Adjust and chart lands on. */
async function measureOpenPage(signal: AbortSignal, pageId?: string): Promise<{ check: PageCheck | null; why?: string }> {
  const p = get().page;
  if (!p || (pageId && p.id !== pageId)) return { check: null, why: 'that page is no longer the open one' };
  return measureSafely(p, signal);
}

/** A page's full data: the open page from the store (it holds every write made
 *  this session), any other page fresh from the server — without navigating. */
async function pageData(pageId: string): Promise<IssuePageData> {
  const s = get();
  if (s.page && s.page.id === pageId) return s.page;
  return getPage(s.issueId!, pageId);
}

/** Measure the page with this id, open or not (a staged layout rebuild or PDF copy
 *  can land on a page other than the one on screen). */
async function measurePageId(pageId: string | null | undefined, signal: AbortSignal): Promise<{ check: PageCheck | null; why?: string }> {
  // No page named, or the change deleted it: the open page is what the user sees now.
  if (!pageId || !get().pages.some((p) => p.id === pageId)) return measureOpenPage(signal);
  let data: IssuePageData | null = null;
  try {
    data = await pageData(pageId);
  } catch (e) {
    return { check: null, why: apiMessage(e, 'the page could not be read') };
  }
  return measureSafely(data, signal);
}

/** The page an action is about: the one named, else the open one. */
function targetPage(pages: PageSummary[], n: number | undefined): PageSummary {
  if (n !== undefined) return pageAt(pages, n);
  const s = get();
  const open = s.pages.find((p) => p.id === s.currentPageId);
  if (!open) throw new Error('No page is open yet — wait for the first page to build, or pass page.');
  return open;
}

/** Gold flash on one element of the page on the canvas (IssuePageCanvas marks each
 *  element with data-el-id). Scoped to the canvas's own page wrapper, so the
 *  off-screen copy measurePage mounts is never the one flashed. */
async function flashElement(pageId: string, elementId: string, signal: AbortSignal) {
  await sleep(150, signal); // let React draw the new element first
  const el = document.querySelector(`[data-page="${CSS.escape(pageId)}"] [data-el-id="${CSS.escape(elementId)}"]`);
  if (!el) return;
  try {
    presence.flash(el);
  } catch {
    /* visual only */
  }
}

/** A server refusal in the server's own words (they are written for a person),
 *  never "HTTP 400". */
function apiMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    if (e.status === 429) return 'Too many of those in the last minute — wait a moment, then try again.';
    return e.message && !/^HTTP \d+$/.test(e.message) ? e.message : fallback;
  }
  return e instanceof Error && e.message ? e.message : fallback;
}

/**
 * One staged / applied studio change as a result reports it. A picture's alt says
 * WHAT was placed — for a chart it lists every number (the server's chartAlt), so
 * the Stable Hand can tell the user exactly what went on the page rather than
 * "applied". `warning` is a problem the server found with the change (e.g. text
 * that will not fit its box).
 */
const proposalOut = (p: AgentProposal) => {
  const alt = p.element?.image?.alt || p.patch?.image?.alt;
  return { kind: p.kind, summary: p.summary, ...(alt ? { alt } : {}), ...(p.warning ? { warning: p.warning } : {}) };
};

/** At most this many changes are listed per page in a result (the count is exact). */
const LISTED_PER_PAGE = 12;

/**
 * EVERY page's changes waiting for Apply, in page order — what the studio has staged
 * and nobody has applied or discarded yet. Staged changes are kept per page now (they
 * used to be one tray that each new request replaced), so a result must say what
 * waits on OTHER pages too, or the Stable Hand loses track of them exactly as the old
 * tray did. `scopePageId` narrows it to one page.
 */
function pendingOut(scopePageId?: string | null) {
  const s = get();
  return waitingPages(s.pending, s.pages)
    .filter((w) => !scopePageId || w.pageId === scopePageId)
    .map((w) => ({
      page: w.page,
      count: w.proposals.length,
      changes: w.proposals.slice(0, LISTED_PER_PAGE).map(proposalOut),
      ...(w.proposals.length > LISTED_PER_PAGE ? { more: w.proposals.length - LISTED_PER_PAGE } : {}),
    }));
}

/** One page's apply as a result reports it. */
const reportOut = (r: PageApplyReport) => ({
  page: r.page || null,
  applied: r.applied,
  ...(r.refused ? { refused: r.refused } : {}),
  ...(r.waiting ? { stillWaiting: r.waiting } : {}),
  ...(r.declined ? { declined: true } : {}),
  ...(r.stale ? { heldBecauseEditedSinceStaged: r.stale } : {}),
  ...(r.started ? { started: r.started === 'layout' ? 'layout rebuild' : 'PDF page copy' } : {}),
  ...(r.gone ? { pageGone: true } : {}),
  ...(r.notOpened ? { couldNotOpen: true } : {}),
});

// ── Charts ───────────────────────────────────────────────────────────────────

/**
 * The numbers behind the charts drawn in this session, by media asset id. The media
 * list does not (yet) return a chart's stored spec, so this is the first place
 * editChart looks; it survives the editor re-rendering, not a reload.
 */
const chartSpecs = new Map<string, WebChartSpec>();

/** The stored numbers behind a chart picture: this session's, else the media row's
 *  `chart` field when the server returns it. */
async function storedChartSpec(issueId: string, assetId: string): Promise<WebChartSpec | null> {
  const mine = chartSpecs.get(assetId);
  if (mine) return mine;
  const assets = await listMedia(issueId).catch(() => []);
  const row = assets.find((a) => a.id === assetId) as ({ chart?: unknown } & object) | undefined;
  const parsed = row && 'chart' in row ? chartSpecArgs.safeParse(row.chart) : null;
  return parsed?.success ? parsed.data : null;
}

/**
 * Put a drawn chart on its page as ONE undo entry: a new picture element on top, or
 * — with `replaceId` — in place of an element. A picture being replaced is PATCHED
 * (same id, so editChart can find it again and nothing that names it breaks); any
 * other element is swapped for the new picture (added first, so a refused add never
 * leaves a hole). Returns the chart element's id.
 */
async function placeChart(ui: UiDriver, target: PageSummary, result: ChartResult, replaceId?: string): Promise<string> {
  const pageId = target.id;
  // The store writes to the OPEN page; drawing can take seconds, and the canvas may
  // have scrolled meanwhile.
  if (get().currentPageId !== pageId || get().page?.id !== pageId) await openPageN(ui, pageNo(target));
  const old = replaceId ? get().page?.elements.find((e) => e.id === replaceId) : undefined;
  if (replaceId && !old) throw new Error('The element to replace is no longer on the page — call magazine.checkPage for the current ids.');
  const el = result.element;
  const toasts = watchToasts();
  let placed: { id: string | null; leftOld: boolean };
  try {
    placed = await get().batchEdits('the chart', async () => {
      if (old && old.type === 'image') {
        const patch: Partial<MagazineElement> = {
          ...(typeof el.x === 'number' ? { x: el.x } : {}),
          ...(typeof el.y === 'number' ? { y: el.y } : {}),
          ...(typeof el.w === 'number' ? { w: el.w } : {}),
          ...(typeof el.h === 'number' ? { h: el.h } : {}),
          ...(typeof el.rotation === 'number' ? { rotation: el.rotation } : {}),
          ...(typeof el.zIndex === 'number' ? { zIndex: el.zIndex } : {}),
          ...(el.image && old.image ? { image: { ...old.image, ...el.image } } : el.image ? { image: el.image } : {}),
        };
        return { id: (await get().commit(old.id, patch)) ? old.id : null, leftOld: false };
      }
      const id = await get().addElement(el);
      return { id, leftOld: !!id && !!old && !(await get().deleteElement(old.id)) };
    });
  } finally {
    toasts.stop();
  }
  if (!placed.id) throw new Error(firstError(toasts.peek()) || 'The page did not accept the chart — see the message on screen.');
  if (placed.leftOld) {
    throw new Error(`The chart was added, but the element it should replace could not be removed: ${firstError(toasts.peek()) || 'see the message on screen'}.`);
  }
  await flashElement(pageId, placed.id, ui.signal);
  return placed.id;
}

// ── Documents to build pages from (C19/C28) ─────────────────────────────────

/** Every document the magazine has, from both stores, with whether it can be read. */
async function documentChoices(issueId: string): Promise<DocChoice[]> {
  const [uploads, sources] = await Promise.allSettled([listUploads(issueId), listSources(issueId)]);
  if (uploads.status === 'rejected' && sources.status === 'rejected') {
    throw new Error("Couldn't read the magazine's attached documents just now — try again.");
  }
  const out: DocChoice[] = [];
  if (sources.status === 'fulfilled') {
    for (const d of sources.value) {
      const readable = d.status === 'ready' || d.status === 'partial';
      out.push({
        id: d.id,
        name: d.originalName,
        kind: 'source',
        readable,
        why: readable
          ? undefined
          : d.status === 'failed'
            ? d.error || 'it could not be read'
            : 'it is still being read — try again in a minute',
      });
    }
  }
  if (uploads.status === 'fulfilled') {
    for (const u of uploads.value) {
      // `readable` covers a SCANNED PDF attached in chat: it has no browser text, but
      // its linked page-by-page read makes it usable (POST /pages/generate follows the
      // link). Judging it by hasText alone told The Stable Hand it could not be read.
      const readable = u.readable ?? u.hasText;
      out.push({
        id: u.id,
        name: u.originalName,
        kind: 'upload',
        readable,
        why: readable
          ? undefined
          : u.reading
            ? 'it is still being read — try again in a minute'
            : 'no text could be read from it (a scanned PDF? attach its pages as pictures instead)',
      });
    }
  }
  return out;
}

/** "the brochure" → the one document to write new pages from, or an error the model
 *  can act on (attach it first / which one / not readable yet). */
async function resolveBuildDocument(query: string): Promise<DocChoice> {
  const r = pickDocument(query, await documentChoices(get().issueId!));
  if (r.ok) return r.doc;
  if (r.noDocs) {
    throw actionError('This magazine has no document attached yet — attach it first, then add the pages from it.', {
      next:
        'Open the AI Studio Uploads tab (click mag.ai-tab-uploads), store the user\'s file with upload { agentId: "mag.ai-uploads-add", attachment } — it is saved at once — then call this action again with doc.',
    });
  }
  throw new Error(r.error);
}

/** The page builder's count picker offers 1, 2, 3, 4 or 6 pages per build. */
const BUILD_BATCHES = [6, 4, 3, 2, 1] as const;

/** The biggest batch the builder takes that fits in `count`; the rest is added
 *  after this build finishes. (A plan of 7 pages used to fail its first call —
 *  the action only accepted 1, 2, 3, 4 or 6 — and showed the user a red error.) */
function firstBuildBatch(count: number): number {
  return BUILD_BATCHES.find((n) => n <= count) ?? 1;
}

const aiPagesCount = z.number().int().min(1).max(12);

/**
 * A larger request the user ALREADY approved in full. "Add 7 pages" asks once
 * ("6 now, the other 1 once these are done"); the follow-up call for the rest —
 * made after the [job-update] — must not ask a second time for the same pages.
 * Module-level so it survives the editor re-rendering; one magazine at a time,
 * and it expires so a stale approval can never cover a new request.
 */
let approvedRest: { issueId: string; count: number; topic: string; doc: string; until: number } | null = null;
const topicKey = (t: string | undefined) => (t ?? '').trim().toLowerCase();

function restAlreadyApproved(count: number, topic: string | undefined, doc: string | undefined): boolean {
  const a = approvedRest;
  if (!a || Date.now() > a.until) return false;
  return a.issueId === get().issueId && count <= a.count && a.topic === topicKey(topic) && a.doc === topicKey(doc);
}

function aiPagesConfirm(count: number, topic: string | undefined, doc?: string): string | null {
  if (isBuilding()) return null; // run() refuses before touching anything
  if (restAlreadyApproved(count, topic, doc)) return null;
  const batch = firstBuildBatch(count);
  const rest = count - batch;
  const about = topic ? ` about “${topic.slice(0, 120)}”` : '';
  // The model passes part of the file name; the card says it as given (run()
  // resolves it, and refuses before touching anything when it matches nothing).
  const from = doc?.trim() ? `, written from the attached document “${doc.trim().slice(0, 80)}”,` : '';
  return rest > 0
    ? `Add ${count} new AI-designed pages${about}${from} to this magazine? The builder makes up to 6 at a time: ${batch} now, the other ${rest} once those are done.`
    : `Add ${count} new AI-designed page${count === 1 ? '' : 's'}${about}${from} to this magazine?`;
}

/** Start a build of `count` pages: the first batch now, and tell the model how many
 *  remain. `source` = a resolved document to write the pages from (C19/C28). */
async function startAiPagesBuild(ui: UiDriver, count: number, topic: string | undefined, source: DocChoice | null, docArg?: string) {
  const batch = firstBuildBatch(count);
  const remaining = count - batch;
  const issueId = get().issueId;
  // The last build's background watch may not have noticed it ended yet; a new
  // build started now would be adopted by it (and lose its [job-update]).
  if (issueId) await settlePreviousBuildJob(issueId, ui.signal);
  const started = source ? await submitDocPagesBuild(ui, batch, topic, source) : await submitAiPagesForm(ui, batch, topic);
  // The user approved the whole request: the rest is pre-approved for the follow-up call.
  approvedRest =
    remaining > 0 && issueId ? { issueId, count: remaining, topic: topicKey(topic), doc: topicKey(docArg), until: Date.now() + 2 * 60 * 60_000 } : null;
  return remaining > 0
    ? {
        ...started,
        requested: count,
        remaining,
        note:
          `${started.note} The builder adds 1, 2, 3, 4 or 6 pages at a time, so ${batch} of the ${count} requested were started. ` +
          `When the [job-update] for this build arrives, call this action again with count ${remaining} and the same topic${source ? ' and doc' : ''} (the user already approved them — no second question).`,
      }
    : started;
}

/**
 * Start a build whose pages are written FROM a document already in the magazine
 * (C19/C28). "Add 2 pages from this PDF" used to start a build from the theme and a
 * 300-character topic only, so the new pages read as invented content while the
 * user was told they came from the PDF.
 *
 * The rail's Add-pages popover has no document picker, so its Generate button can
 * only start a theme-and-topic build. This calls the store handler that button
 * calls — store.generatePages, which takes the documents — with the cursor on the
 * rail's AI button first, so the user sees where the pages come from.
 */
async function submitDocPagesBuild(ui: UiDriver, count: number, topic: string | undefined, source: DocChoice) {
  await ensureRail(ui);
  if (anchor('mag.add-ai-pages')) await ui.point('mag.add-ai-pages', `Add pages from “${source.name}”`);
  ui.step(`Starting ${count} new page${count === 1 ? '' : 's'} written from “${source.name}”`);
  const pageCountBefore = get().pages.length;
  const toasts = watchToasts();
  let ok = false;
  try {
    ok = await get().generatePages(count, topic?.trim() || undefined, undefined, [source.id]);
  } finally {
    toasts.stop();
  }
  if (!ok) throw new Error(problemToasts(toasts.peek())[0]?.text || 'The build did not start — see the message on screen.');
  const s = get();
  const job = s.issueId
    ? startMagazineBuildJob({ magazineId: s.issueId, title: s.issue?.title, mode: 'add', pageCountBefore, requested: count })
    : null;
  // The server echoes which documents it really took. A build it started WITHOUT this
  // one (no readable text stored for it) must not be reported as written from it.
  const sources = s.lastBuildSources;
  const used = !!sources && sources.used > 0 && !(sources.skipped ?? []).includes(source.name);
  return {
    started: true,
    jobId: job?.id,
    count,
    topic: topic?.trim() || undefined,
    fromDocument: used ? source.name : undefined,
    documentLeftOut: sources && !used ? source.name : undefined,
    pageCountBefore,
    note: used
      ? `${JOB_STARTED_NOTE} The server confirmed it is writing these pages from “${source.name}”. ` +
        'When they are done, glance at one (magazine.checkPage lists its text) before telling the user they came from it.'
      : sources
        ? `${JOB_STARTED_NOTE} “${source.name}” had no readable text stored, so the server left it out — do NOT tell the user these pages come from it. ` +
          'Once they are done, fill them from the document with magazine.askStudio (attach it) if the user wants its content.'
        : `${JOB_STARTED_NOTE} The builder was given “${source.name}” to write these pages from. ` +
          'When they are done, glance at one (magazine.checkPage lists its text); if its words do not come from that document, fill each new page from it with magazine.askStudio (attach the document) before telling the user they came from it.',
  };
}

/** The page rail's AI popover is open: choose count/topic and press Generate.
 *  Confirms the server accepted the request, then hands the build to a
 *  background job and returns at once (see ./magazineJobs.ts). */
async function submitAiPagesForm(ui: UiDriver, count: number, topic: string | undefined) {
  await ui.select('mag.ai-pages-count', String(count));
  // The popover keeps whatever was typed into it last; a build with no topic must
  // not quietly reuse an old one.
  const topicBox = anchor('mag.ai-pages-topic') as HTMLInputElement | null;
  if (topic?.trim()) await ui.type('mag.ai-pages-topic', topic.trim(), { clear: true });
  else if (topicBox?.value.trim()) await ui.type('mag.ai-pages-topic', '', { clear: true });
  const pageCountBefore = get().pages.length;
  const toasts = watchToasts();
  try {
    await ui.click('mag.ai-pages-generate', 'Generate');
    // The store flips `generating` BEFORE its POST; a refusal (409 page cap,
    // 503 AI off…) clears it again with an error toast — possibly before a poll
    // ever saw it set. Success shows up as the issue going 'processing' on the
    // store's first poll.
    await waitUntil(() => get().generating || get().issue?.status === 'processing' || !!firstError(toasts.peek()), {
      signal: ui.signal,
      timeoutMs: 10_000,
      what: 'the build to start',
    });
    await softWait(ui, () => !get().generating || get().issue?.status === 'processing', 12_000);
    if (!get().generating && get().issue?.status !== 'processing') {
      throw new Error(firstError(toasts.peek()) || 'The build did not start — see the message on screen.');
    }
  } finally {
    toasts.stop();
  }
  const s = get();
  const job = s.issueId
    ? startMagazineBuildJob({ magazineId: s.issueId, title: s.issue?.title, mode: 'add', pageCountBefore, requested: count })
    : null;
  return {
    started: true,
    jobId: job?.id,
    count,
    topic: topic?.trim() || undefined,
    pageCountBefore,
    note: JOB_STARTED_NOTE,
  };
}

function top<T>(a: T[]): T | undefined {
  return a[a.length - 1];
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A wait that may time out harmlessly — but a Stop still stops. */
async function softWait(ui: UiDriver, pred: () => unknown, timeoutMs: number): Promise<boolean> {
  try {
    await waitUntil(() => !!pred(), { signal: ui.signal, timeoutMs });
    return true;
  } catch (e) {
    if (ui.signal.aborted) throw e;
    return false;
  }
}

const toastLines = (ts: SeenToast[]) => ts.map((t) => `${t.type}: ${t.text}`);

/**
 * The confirm question for staged studio changes that must not land on a bare
 * "Use these changes", or null when none are staged: page deletions and a
 * layout rebuild can't be undone, and generate-pages starts an AI page build
 * (spends AI budget — the build magazine.addAiPages confirms). Before, only
 * deletions asked: a staged layout rebuild then hit the app's own
 * window.confirm with no OK behind it (auto-declined) while the action still
 * reported "applied", and a staged page build ran unasked.
 */
function stagedRiskQuestion(scopePageId?: string | null): string | null {
  const { parts, scope } = stagedRiskParts(scopePageId);
  if (parts.length === 0) return null;
  const where = scope.length > 1 ? ` on ${pagesPhrase(scope.map((w) => w.page))}` : '';
  return `Apply the studio's changes${where}, including ${parts.join('; ')}?`;
}

/** The risky parts of the waiting changes in scope, each in a few words (see
 *  stagedRiskQuestion), and the pages in that scope. */
function stagedRiskParts(scopePageId?: string | null) {
  const s = get();
  const parts: string[] = [];
  // Every page's waiting changes (Apply all), or one page's.
  const scope = waitingPages(s.pending, s.pages).filter((w) => !scopePageId || w.pageId === scopePageId);
  const all = scope.flatMap((w) => w.proposals.map((p) => ({ p, ownerId: w.pageId })));
  const removes = all.filter((x) => x.p.kind === 'remove-page').length;
  if (removes > 0) parts.push(`deleting ${removes} page${removes === 1 ? '' : 's'} (cannot be undone)`);
  for (const x of all.filter((y) => y.p.kind === 'apply-layout')) {
    const n = pageNoOf(s.pages, x.p.pageId || x.ownerId);
    // Said as it really happens (C09/C31): the rebuild does not move the page's own
    // words into the new layout — the AI writes fresh copy for it. This card is the
    // only confirm the user sees on this path, so it must not promise more.
    parts.push(
      `rebuilding ${n ? `page ${n}` : 'the page'} in a new layout — everything on it is replaced and its text is rewritten by the AI with fresh copy; its photos are reused (cannot be undone)`,
    );
  }
  // A staged PDF page copy replaces the whole page too, exactly like the page
  // panel's "Copy a page exactly" (which magazine.copyPdfPage confirms).
  for (const x of all.filter((y) => y.p.kind === 'copy-document-page')) {
    const n = pageNoOf(s.pages, x.p.pageId || x.ownerId);
    const which = x.p.sourcePage ? `page ${x.p.sourcePage} of a PDF` : 'a PDF page';
    parts.push(`copying ${which} onto ${n ? `page ${n}` : 'the page'} — everything on it is replaced (cannot be undone)`);
  }
  const gen = all.find((x) => x.p.kind === 'generate-pages')?.p;
  if (gen) parts.push(`having the AI design ${gen.count ? `${gen.count} new page${gen.count === 1 ? '' : 's'}` : 'new pages'}`);
  return { parts, scope };
}

/**
 * The card before magazine.applyStudioChanges (every page's waiting changes): the
 * risky kinds as always, and — whenever anything waits on a page other than the one
 * the latest Design Helper request was about — every page and its count, so changes
 * staged by earlier requests (kept for up to 30 days) are never applied unseen.
 */
function applyAllConfirm(): string | null {
  const s = get();
  const { parts, scope } = stagedRiskParts(null);
  const turnPage = s.lastTurn ? pageNoOf(s.pages, s.lastTurn.pageId) : null;
  return applyAllQuestion(
    scope.map((w) => ({ page: w.page, count: w.proposals.length })),
    turnPage,
    parts,
  );
}

/**
 * The confirm for applying ONE named page's waiting changes: only its risky kinds
 * (stagedRiskQuestion). A page number that does not exist asks nothing — run() then
 * refuses with the reason — rather than falling back to every page's risks.
 */
function onePageApplyConfirm(page: number): string | null {
  // By the number as printed (pageNo), as targetPage resolves it: a page-scoped
  // collaborator's list is not every page, so an index would name the wrong one.
  const id = get().pages.find((p) => pageNo(p) === page)?.id;
  return id ? stagedRiskQuestion(id) : null;
}

/** The open page's elements as the facts a Fill / Adjust pass can change —
 *  words, the box, a shape's opacity — if `pageId` is the open page. */
function elementFacts(pageId: string) {
  const p = get().page;
  if (!p || p.id !== pageId) return null;
  return new Map(
    p.elements.map((e) => [
      e.id,
      {
        type: e.type,
        role: e.text ? String(e.text.role) : '',
        content: e.text?.content ?? '',
        box: `${Math.round(e.x)},${Math.round(e.y)},${Math.round(e.w)},${Math.round(e.h)},${Math.round(e.rotation ?? 0)}`,
        opacity: e.shape?.opacity,
      },
    ]),
  );
}

/** Why the user cannot change page n right now (a contributor's submitted /
 *  approved page), or '' — the same sentence the studio's lock banner shows. */
function pageLockReason(target: PageSummary): string {
  return readOnlyReason(get().issue, target);
}

/**
 * Press a page's Fill / Adjust wand (the per-page AI buttons above it on the
 * canvas) and follow the pass to the end. The store applies the server's edits
 * as ONE undo entry and reports only through a toast, so the result is the
 * before/after of the page plus the toast the user saw. Adjust also re-balances
 * the layout (moves boxes, removes sliver photos, lightens scrims) — those count
 * as changes too; only reporting the words called a re-balanced page "unchanged".
 */
async function runPageFormat(ui: UiDriver, mode: 'fill' | 'adjust', n: number) {
  const s0 = await ready(ui);
  const name = mode === 'fill' ? 'Fill' : 'Adjust';
  // A contributor's submitted/approved page: the server refuses the pass (409) —
  // say so before pressing anything.
  const lock = pageLockReason(pageAt(s0.pages, n));
  if (lock) throw new Error(lock);
  if (get().formatBusy) {
    ui.step('Waiting for the Fill/Adjust pass already running');
    await waitUntil(() => !get().formatBusy, { signal: ui.signal, timeoutMs: 180_000, what: 'the running Fill/Adjust pass to finish' });
  }
  const target = await openPageN(ui, n);
  const btn = `mag.page-${n}-${mode}`;
  await ui.waitFor(btn, 5000);
  assertEnabled(btn, `The ${name} button for page ${n} is not available right now.`);

  const before = elementFacts(target.id);
  const countBefore = get().page?.id === target.id ? get().page!.elements.length : null;
  const undoTop = top(get().undoStack);
  const toasts = watchToasts();
  let seen: SeenToast[] = [];
  let started = false;
  try {
    ui.step(mode === 'fill' ? `Filling page ${n} with AI` : `Tightening page ${n}'s text with AI`);
    await ui.click(btn, `${name} page ${n}`);
    started = await softWait(ui, () => get().formatBusy || toasts.peek().length > 0, 5000);
    await waitUntil(() => !get().formatBusy, { signal: ui.signal, timeoutMs: 180_000, intervalMs: 300, what: `the ${name} pass to finish` });
    // The outcome toast is raised just as the busy flag drops.
    await softWait(ui, () => toasts.peek().length > 0, 1500);
  } finally {
    seen = toasts.stop();
  }

  const after = elementFacts(target.id);
  const changes: Array<{ elementId: string; role: string; before: string; after: string }> = [];
  let moved = 0;
  let restyled = 0;
  let removed = 0;
  if (before && after) {
    for (const [id, a] of after) {
      const b = before.get(id);
      if (!b) continue;
      if (b.content !== a.content) changes.push({ elementId: id, role: a.role, before: clip(b.content, 80), after: clip(a.content, 160) });
      if (b.box !== a.box) moved++;
      if (b.opacity !== a.opacity) restyled++;
    }
    for (const id of before.keys()) if (!after.has(id)) removed++;
  }
  const anyChange = changes.length + moved + restyled + removed > 0;
  const errs = errorToasts(seen);
  if (!anyChange && errs.length > 0) throw new Error(errs.map((t) => t.text).join(' '));
  if (!started && seen.length === 0 && !anyChange) throw new Error(`The ${name} pass on page ${n} did not start — see the screen.`);
  if (anyChange) ui.flash(btn);
  // The page as it renders NOW — whether the pass left text cut off or a box over
  // another is exactly what the model must know before it reports.
  ui.step(`Measuring page ${n}`);
  const measured = await measureOpenPage(ui.signal, target.id);
  const newTop = top(get().undoStack);
  return {
    page: n,
    mode,
    elementsBefore: countBefore,
    elementsAfter: get().page?.id === target.id ? get().page!.elements.length : null,
    textBlocksChanged: changes.length,
    boxesMovedOrResized: moved || undefined,
    scrimsRestyled: restyled || undefined,
    elementsRemoved: removed || undefined,
    changes: changes.slice(0, 12),
    moreChanges: changes.length > 12 ? changes.length - 12 : undefined,
    undo: newTop && newTop !== undoTop ? `One magazine.undo (Ctrl+Z) takes back ${newTop.label}.` : undefined,
    messages: toastLines(seen),
    pageCheck: measured.check ?? undefined,
    note: anyChange
      ? appliedNote(measured.check, measured.why)
      : `Nothing on the page changed. ${measuredSentence(measured.check, measured.why)}`,
  };
}

/** Undo / Redo through the toolbar button; resolves when that entry has moved stacks. */
async function runHistory(ui: UiDriver, dir: 'undo' | 'redo') {
  await ready(ui);
  const from = () => (dir === 'undo' ? get().undoStack : get().redoStack);
  const to = () => (dir === 'undo' ? get().redoStack : get().undoStack);
  const entry = top(from());
  if (!entry) throw new Error(dir === 'undo' ? 'There is nothing to undo.' : 'There is nothing to redo.');
  const btn = `mag.${dir}`;
  const verb = dir === 'undo' ? 'Undo' : 'Redo';
  await revealToolbarItem(ui, btn); // phone: it is in the More menu
  assertEnabled(btn, `${verb} is not available right now.`);
  const toasts = watchToasts();
  let seen: SeenToast[] = [];
  try {
    await ui.click(btn, `${verb} ${entry.label}`);
    // A replay that fails (wholly or partly) DROPS the entry and says so with a
    // WARNING toast, not an error — watching errors only sat out the whole minute
    // and reported a timeout.
    await waitUntil(
      () => top(to()) === entry || (problemToasts(toasts.peek()).length > 0 && !from().includes(entry)),
      { signal: ui.signal, timeoutMs: 60_000, what: `the ${dir} to finish` },
    );
  } finally {
    seen = toasts.stop();
  }
  const problems = problemToasts(seen).map((t) => t.text);
  if (top(to()) !== entry) {
    // "Undid what I could — 2 changes no longer applied." is a PARTIAL undo, not a failure.
    if (problems.some((t) => /what I could/i.test(t))) {
      return { [dir === 'undo' ? 'undid' : 'redid']: entry.label, partial: true, messages: problems, nextUndo: top(get().undoStack)?.label ?? null };
    }
    throw new Error(problems.join(' ') || `The ${dir} did not complete.`);
  }
  return {
    [dir === 'undo' ? 'undid' : 'redid']: entry.label,
    nextUndo: top(get().undoStack)?.label ?? null,
    nextRedo: top(get().redoStack)?.label ?? null,
    messages: seen.length ? toastLines(seen) : undefined,
  };
}

const zoomPercent = () => Math.round((get().zoomWidth / 1275) * 100);

/** Pages by review column (1-based), and which ones the open board lets you tick. */
function boardSummary() {
  const s = get();
  const cols: Record<ReviewColumn, number[]> = { in_progress: [], needs_changes: [], submitted: [], approved: [] };
  s.pages.forEach((p) => cols[columnOf(p)].push(pageNo(p)));
  return {
    columns: Object.fromEntries(COLUMN_ORDER.map((c) => [c, cols[c]])),
    staleApprovals: s.pages.flatMap((p) => (p.approvalStale ? [pageNo(p)] : [])),
    tickable: s.pages.flatMap((p) => (anchor(`mag.review-page-${pageNo(p)}-select`) ? [pageNo(p)] : [])),
  };
}

/** The board as a sentence ("In progress: 1, 2 · Submitted: 3") — for errors the user reads. */
function boardSentence(): string {
  const s = get();
  return COLUMN_ORDER.map((c) => {
    const nums = s.pages.filter((p) => columnOf(p) === c).map(pageNo);
    return nums.length ? `${COLUMN_LABEL[c]}: ${nums.join(', ')}` : '';
  })
    .filter(Boolean)
    .join(' · ');
}

/**
 * The pages the review board lets this user tick — the SAME rule as
 * ReviewBoard's `actionable`: the owner acts on submitted pages and on approvals
 * that went stale; a collaborator submits their own in-progress pages.
 */
function reviewTickable(isOwner: boolean): Set<string> {
  const s = get();
  if (isOwner) return new Set(s.pages.filter((p) => columnOf(p) === 'submitted' || p.approvalStale === true).map((p) => p.id));
  return new Set(submittablePages(s.issue, s.pages).map((p) => p.id));
}

async function openReviewBoard(ui: UiDriver, isOwner: boolean) {
  if (anchor('mag.review-dialog')) return;
  // Phone: the board button is in the More menu (the locked-page strip's link is not).
  if (!anchor('mag.locked-see-board')) await revealToolbarItem(ui, 'mag.review-board');
  const trigger = anchor('mag.review-board') ? 'mag.review-board' : anchor('mag.locked-see-board') ? 'mag.locked-see-board' : null;
  if (!trigger) {
    throw new Error(
      isOwner
        ? 'There is no review board button right now: nobody else is working on this magazine, so no page needs approving (review only applies to pages shared with someone). You can publish directly.'
        : 'The review board is not available to you on this magazine.',
    );
  }
  ui.step('Opening the review board');
  await ui.click(trigger, 'Review board');
  await ui.waitFor('mag.review-dialog', 4000);
}

const pagesArg = z.union([z.literal('all'), z.array(z.number().int().min(1)).min(1)]);

interface EditorPerms {
  /** issue.myRole === 'owner' (store.canManage). */
  isOwner: boolean;
  /** owner or collaborator (store.canEdit). */
  canEdit: boolean;
  /** staff permission `magazine.publish`. */
  mayPublish: boolean;
}

export function useMagazineEditorActions(input: EditorPerms): void {
  const roleCanEdit = useRoleCanEditMagazines();
  const perms = { ...input, roleCanEdit };
  const live = useRef(perms);
  live.current = perms;
  const { mayPublish } = perms;
  // What the server will actually accept from this user: role AND magazine access.
  const isOwner = perms.isOwner && roleCanEdit;
  const canEdit = perms.canEdit && roleCanEdit;

  // ── Read ─────────────────────────────────────────────────────────────────
  useAgentAction({
    name: 'magazine.status',
    description: 'What is open: title, id, your role, every page (number, id, review state), collaborators, publish state, build progress, and the AI Studio state.',
    args: z.object({}),
    run: async (_a, ui) => {
      let s = await ready(ui);
      // A page being copied or extracted changes on the SERVER, and nothing here would
      // notice: the summaries stayed 'pending' and the open page kept showing the old
      // elements until a reload, so "is the copy done?" was answered from stale data
      // (C23). While any page is pending, read the magazine again first; if the open
      // page's summary moved past what is on screen, reload that page too.
      if (s.pages.some((p) => p.status === 'pending')) {
        await get().refreshIssue().catch(() => false);
        const now = get();
        const open = now.page;
        const sum = open ? now.pages.find((p) => p.id === open.id) : undefined;
        if (open && sum && now.currentPageId === open.id && (sum.rev !== open.rev || sum.status !== open.status)) {
          await now.openPage(open.id, true).catch(() => undefined);
        }
        s = get();
      }
      const issue = s.issue!;
      const b = buildStatus(issue, s.adding);
      const curIdx = s.pages.findIndex((p) => p.id === s.currentPageId);
      return {
        id: issue.id,
        title: issue.title,
        route: editorRoute(issue.id),
        status: issue.status,
        myRole: issue.myRole ?? 'view-only',
        canEdit: live.current.canEdit && live.current.roleCanEdit,
        isOwner: live.current.isOwner,
        canPublish: live.current.isOwner && live.current.mayPublish && live.current.roleCanEdit,
        viewOnlyReason: !live.current.roleCanEdit
          ? 'Your role can open magazines but not edit them (no Magazine edit permission) — every change would be refused.'
          : !live.current.canEdit
            ? 'This magazine is not shared with you — view only.'
            : undefined,
        published: !!issue.publishedIssueId && issue.status === 'published',
        publishedIssueId: issue.publishedIssueId ?? null,
        needsRepublish: s.needsRepublish(),
        currentPage: curIdx >= 0 ? pageNo(s.pages[curIdx]) : null,
        pageCount: s.pages.length,
        pages: s.pages.map((p) => ({
          page: pageNo(p),
          id: p.id,
          // The open page's live element list beats the summary count, which
          // only refreshes on the next server round-trip (an applied studio
          // change looked like "still 11 elements").
          elements: s.page && s.page.id === p.id ? s.page.elements.length : p.elementCount,
          build: p.status,
          // Why the last copy or extraction failed, in the server's words.
          error: p.status === 'failed' && p.error ? p.error : undefined,
          // The page is one picture of a PDF page: its words cannot be edited.
          notice: p.notice ? copyNoticeText(p.notice) : undefined,
          review: p.review ?? 'in_progress',
          approvalStale: !!p.approvalStale,
          selectedForPublish: p.selectedForPublish,
        })),
        collaborators: collaboratorsOut(issue.collaborators, s.pages),
        // Invited by email, not joined yet — they get these pages automatically on joining.
        pendingInvites: pendingSharesOut(issue.pendingCollaborators, s.pages),
        coverImage: issue.coverImage || null,
        zoomPercent: zoomPercent(),
        history: { nextUndo: top(s.undoStack)?.label ?? null, nextRedo: top(s.redoStack)?.label ?? null },
        fillAdjustRunning: s.formatBusy,
        generation: isBuilding()
          ? { building: true, headline: b.headline, done: b.count?.done ?? null, total: b.count?.total ?? null }
          : { building: false, error: issue.processingError || undefined },
        studio: {
          replying: s.chatBusy,
          applying: s.applyingProposals,
          // Every page's waiting changes (they are kept per page until applied or
          // discarded) — magazine.applyStudioChanges applies them, all or one page.
          pendingChanges: pendingOut(),
          pendingTotal: Object.values(s.pending).reduce((n, l) => n + l.length, 0),
          // What the last studio turn REALLY staged, from its proposals.
          lastTurn: s.lastTurn
            ? { page: pageNoOf(s.pages, s.lastTurn.pageId), proposalCount: s.lastTurn.added, stagedLine: s.lastTurn.line }
            : null,
        },
      };
    },
  });

  useAgentAction(
    {
      name: 'magazine.listStaff',
      description: 'Staff who can be invited to this magazine (userId, name, email, whether they already have access). Optional text filter.',
      args: z.object({ query: z.string().optional() }),
      run: async ({ query }, ui) => {
        const s = await ready(ui);
        const list = await loadDirectory(true);
        const q = (query ?? '').trim().toLowerCase();
        const cs = s.issue?.collaborators ?? [];
        return {
          staff: list
            .filter((e) => !q || (e.name || '').toLowerCase().includes(q) || e.email.toLowerCase().includes(q))
            .slice(0, 50)
            .map((e) => ({
              userId: e.userId,
              name: e.name || e.email,
              email: e.email,
              access: e.userId === s.issue?.ownerId ? 'owner' : cs.some((c) => c.userId === e.userId) ? 'collaborator' : 'none',
            })),
        };
      },
    },
    isOwner,
  );

  // ── Pages ────────────────────────────────────────────────────────────────
  useAgentAction({
    name: 'magazine.goToPage',
    description: 'Open a page (its number as printed on the canvas, "Page N") via the page rail.',
    args: z.object({ page: z.number().int().min(1) }),
    run: async ({ page }, ui) => {
      await ready(ui);
      // Waits for the canvas to settle on it, so the next step ("ask the studio",
      // "fill this page") acts on THIS page and not a neighbour the scroll passed.
      const target = await openPageN(ui, page);
      return { page, pageId: target.id, pageCount: get().pages.length };
    },
  });

  useAgentAction(
    {
      name: 'magazine.addPage',
      description: 'Add one blank page at the end and open it.',
      args: z.object({}),
      run: async (_a, ui) => {
        const s = await ready(ui);
        refuseWhileBuilding('add a page');
        const had = new Set(s.pages.map((p) => p.id));
        await ensureRail(ui);
        assertEnabled('mag.add-page', 'Adding a page is not available right now.');
        await clickAndAwait(ui, 'mag.add-page', 'Add a blank page', () => get().pages.length > had.size, 'the new page');
        // The new page by id — the store opens it a moment AFTER the list updates, so
        // "the open page" right now can still be the old one.
        const fresh = get().pages.find((p) => !had.has(p.id));
        if (fresh) await softWait(ui, () => get().currentPageId === fresh.id, 5000);
        const after = get();
        const n = pageNoOf(after.pages, fresh?.id) ?? after.pages.length;
        ui.flash(`mag.page-${n}`);
        return { newPage: n, opened: after.currentPageId === fresh?.id, pageCount: after.pages.length };
      },
    },
    isOwner,
  );

  useAgentAction(
    {
      name: 'magazine.addAiPages',
      description:
        'Have the AI design and add on-theme pages (count 1–12; optional topic, at most 300 characters). doc = part of the file name of a document already attached to the magazine to write the pages FROM (pass it instead of pasting the document into topic). The builder adds 1, 2, 3, 4 or 6 per build, so a larger or odd count starts the biggest batch that fits and the result says how many remain. Starts the build and returns at once with a jobId — a [job-update] message arrives when the pages are done (no need to wait).',
      args: z.object({
        count: aiPagesCount,
        topic: z.string().max(300).optional(),
        doc: z.string().min(1).max(200).optional(),
      }),
      // Generating pages writes new content into the magazine and spends AI
      // budget — the user approves it first (reported: pages were added from a
      // PDF instruction without asking).
      // No card while a build runs (run() refuses that before touching anything),
      // nor for the rest of a larger request the user already approved.
      confirm: ({ count, topic, doc }) => aiPagesConfirm(count, topic, doc),
      run: async ({ count, topic, doc }, ui) => {
        await ready(ui);
        if (isBuilding()) throw new Error('A build is already running — a [job-update] message will arrive when it finishes; add more pages after that.');
        // Which document, BEFORE anything is pressed: a name that matches nothing
        // (or a file still being read) is refused with nothing changed.
        const source = doc ? await resolveBuildDocument(doc) : null;
        await ensureRail(ui);
        if (!source && !anchor('mag.ai-pages-generate')) {
          assertEnabled('mag.add-ai-pages', 'Adding AI pages is not available right now.');
          await ui.click('mag.add-ai-pages', 'Add pages with AI');
          await ui.waitFor('mag.ai-pages-generate', 4000);
        }
        return startAiPagesBuild(ui, count, topic, source, doc);
      },
    },
    isOwner,
  );

  useAgentAction(
    {
      name: 'magazine.addMorePages',
      description:
        'Press "Add more pages" (the gold banner after a first build; falls back to the page rail\'s AI button) to open the add-AI-pages popover. With count (1–12; the builder adds 1, 2, 3, 4 or 6 per build, so a larger or odd count starts the biggest batch that fits and the result says how many remain), optional topic (at most 300 characters) and optional doc (part of the file name of an attached document to write the pages from) it also starts the build and returns at once with a jobId — a [job-update] message arrives when the pages are done.',
      args: z.object({
        count: aiPagesCount.optional(),
        topic: z.string().max(300).optional(),
        doc: z.string().min(1).max(200).optional(),
      }),
      // Only a build (count given) creates content; just opening the popover is safe.
      confirm: ({ count, topic, doc }) => (count ? aiPagesConfirm(count, topic, doc) : null),
      run: async ({ count, topic, doc }, ui) => {
        await ready(ui);
        if (isBuilding()) throw new Error('A build is already running — a [job-update] message will arrive when it finishes; add more pages after that.');
        // A build from a document starts from the store handler (the popover has no
        // document picker) — resolve the document before touching anything.
        if (count && doc) return startAiPagesBuild(ui, count, topic, await resolveBuildDocument(doc), doc);
        if (!anchor('mag.ai-pages-generate')) {
          if (anchor('mag.add-more-pages')) {
            await ui.click('mag.add-more-pages', 'Add more pages');
          } else {
            await ensureRail(ui);
            assertEnabled('mag.add-ai-pages', 'Adding AI pages is not available right now.');
            await ui.click('mag.add-ai-pages', 'Add pages with AI');
          }
          await ui.waitFor('mag.ai-pages-generate', 4000);
        }
        if (!count) {
          return {
            opened: true,
            started: false,
            note:
              'The "Add pages with AI" popover is open. Call magazine.addMorePages (or magazine.addAiPages) with count 1 to 12 to start the build' +
              (doc ? ' — and doc again, to write the pages from that document.' : '.'),
          };
        }
        return startAiPagesBuild(ui, count, topic, null);
      },
    },
    isOwner,
  );

  useAgentAction(
    {
      name: 'magazine.duplicatePage',
      description: 'Duplicate a page (1-based).',
      args: z.object({ page: z.number().int().min(1) }),
      run: async ({ page }, ui) => {
        const s = await ready(ui);
        pageAt(s.pages, page);
        refuseWhileBuilding('duplicate it');
        const had = new Set(s.pages.map((p) => p.id));
        await ensureRail(ui);
        await clickAndAwait(ui, `mag.page-${page}-duplicate`, `Duplicate page ${page}`, () => get().pages.length > had.size, 'the copy');
        const copyAt = pageNoOf(get().pages, get().pages.find((p) => !had.has(p.id))?.id) ?? 0;
        if (copyAt > 0) ui.flash(`mag.page-${copyAt}`);
        return { duplicated: page, copyIsPage: copyAt || null, pageCount: get().pages.length };
      },
    },
    isOwner,
  );

  useAgentAction(
    {
      name: 'magazine.deletePage',
      description: 'Delete a page (1-based). Permanent — page deletions cannot be undone.',
      args: z.object({ page: z.number().int().min(1) }),
      confirm: ({ page }) => {
        const s = get();
        // Real page number (not list position); no card for a page that isn't
        // there or the last page — run() refuses both before touching anything.
        const p = s.pages.find((x) => pageNo(x) === page);
        if (!p || s.pages.length <= 1 || isBuilding()) return null;
        const submitted = p.review === 'submitted' ? ' It was submitted for review — the submitter will be emailed.' : '';
        return `Delete page ${page} of “${s.issue?.title ?? 'this magazine'}”? This cannot be undone.${submitted}`;
      },
      run: async ({ page }, ui) => {
        const s = await ready(ui);
        const target = pageAt(s.pages, page);
        if (s.pages.length <= 1) throw new Error('A magazine needs at least one page.');
        refuseWhileBuilding('delete it');
        await ensureRail(ui);
        // The tile's own 🗑 raises window.confirm, which the card above already
        // asked — so point at it and call the same store handler it calls. (A
        // SUBMITTED page makes the store ask once more, naming the submitter; the
        // card's OK pre-approves that too.)
        await ui.point(`mag.page-${page}-delete`, `Delete page ${page}`);
        ui.step(`Deleting page ${page}`);
        const toasts = watchToasts();
        try {
          await get().deletePage(target.id);
        } finally {
          toasts.stop();
        }
        const gone = !get().pages.some((p) => p.id === target.id);
        if (!gone) throw new Error(firstError(toasts.peek()) || `Page ${page} was not deleted — see the message on screen.`);
        return { deleted: page, pageCount: get().pages.length };
      },
    },
    isOwner,
  );

  useAgentAction(
    {
      name: 'magazine.movePage',
      description: 'Move a page from one position to another (both 1-based).',
      args: z.object({ from: z.number().int().min(1), to: z.number().int().min(1) }),
      run: async ({ from, to }, ui) => {
        const s = await ready(ui);
        const target = pageAt(s.pages, from);
        pageAt(s.pages, to);
        if (from === to) return { page: to, pageCount: s.pages.length, moved: false };
        refuseWhileBuilding('move it');
        await ensureRail(ui);
        const landed = () => get().pages[to - 1]?.id === target.id;
        if (Math.abs(from - to) === 1) {
          const dir = to < from ? 'up' : 'down';
          await clickAndAwait(ui, `mag.page-${from}-${dir}`, `Move page ${from} ${dir}`, landed, 'the page to move');
        } else {
          // Multi-slot moves are a drag in the UI; call the handler the drop calls.
          await ui.point(`mag.page-${from}`, `Moving page ${from} to ${to}`);
          ui.step(`Moving page ${from} to position ${to}`);
          const toasts = watchToasts();
          try {
            await get().reorder(from - 1, to - 1);
          } finally {
            toasts.stop();
          }
          if (!landed()) throw new Error(firstError(toasts.peek()) || `Page ${from} did not move — see the message on screen.`);
        }
        ui.flash(`mag.page-${to}`);
        return { moved: true, from, to, order: get().pages.map((p, i) => ({ page: i + 1, id: p.id })) };
      },
    },
    isOwner,
  );

  // ── Magazine ─────────────────────────────────────────────────────────────
  useAgentAction(
    {
      name: 'magazine.rename',
      description: "Rename the magazine (the title field in the studio's toolbar).",
      args: z.object({ title: z.string().trim().min(1).max(200) }),
      run: async ({ title }, ui) => {
        await ready(ui);
        const saved = () => get().issue?.title === title;
        const toasts = watchToasts();
        try {
          await ui.type('mag.title-input', title, { clear: true });
          // The field saves on blur, the way a person finishes editing it. If the
          // field never had focus there is no blur to fire, so fall back to the
          // handler that blur calls.
          anchor('mag.title-input')?.blur();
          if (!(await softWait(ui, () => saved() || firstError(toasts.peek()), 4000))) await get().rename(title);
          await softWait(ui, () => saved() || firstError(toasts.peek()), 10_000);
        } finally {
          toasts.stop();
        }
        if (!saved()) throw new Error(firstError(toasts.peek()) || 'The new title did not save — see the message on screen.');
        ui.flash('mag.title-input');
        return { title: get().issue?.title };
      },
    },
    isOwner,
  );

  // ── Sharing ──────────────────────────────────────────────────────────────

  /**
   * Share with someone who is NOT on the team yet, through the dialog's "invite by
   * email" field. The server saves a pending share and emails them an invite; the
   * pages become theirs automatically when they accept it. The model must not plan
   * a second share for after they sign up — the result says so.
   */
  async function shareWithNewPerson(ui: UiDriver, email: string, nums: number[] | null, wantIds: string[] | null, roleArg: string | undefined) {
    const pend = () => findPending(email, get().issue);
    const result = () => {
      const after = get();
      return {
        invited: email,
        pages: pend() ? scopeNumbers(pend()!, after.pages) : nums ?? 'all',
        status: 'Pending: they are not on the team yet. They get these pages AUTOMATICALLY when they accept the invite — no need to share again.',
        pendingInvites: pendingSharesOut(after.issue?.pendingCollaborators, after.pages),
      };
    };
    const already = pend();
    if (already && hasScope(already, wantIds)) return { unchanged: true, ...result() };
    // Before touching the screen: no role chosen yet → this asks the user.
    const role = await inviteRoleFor(get().issueId!, email, roleArg, !!already);

    await openShareDialog(ui);
    await waitUntil(() => !!anchor('mag.share-invite-email'), { signal: ui.signal, timeoutMs: 15_000, what: 'the Share dialog to load' });
    ui.step(`Inviting ${email}`);
    await ui.type('mag.share-invite-email', email, { clear: true });
    if (role) {
      await waitUntil(() => !!anchor('mag.share-invite-role'), { signal: ui.signal, timeoutMs: 15_000, what: 'the role list to load' });
      await ui.select('mag.share-invite-role', role.name);
    }
    if (!nums) {
      await ui.click('mag.share-scope-all', 'All pages');
    } else {
      await ui.click('mag.share-scope-pick', 'Specific pages');
      await ui.waitFor('mag.share-pages-clear', 3000);
      await ui.click('mag.share-pages-clear', 'Clear');
      for (const n of nums) await ui.click(`mag.share-page-${n}`, `Page ${n}`);
    }
    assertEnabled('mag.share-submit', 'The Share button is not available.');
    const matches = () => {
      const p = pend();
      return !!p && hasScope(p, wantIds);
    };
    const toasts = watchToasts();
    let seen: SeenToast[] = [];
    try {
      await ui.click('mag.share-submit', 'Invite & share');
      await settle(ui, 'mag.share-submit', () => matches() || !!firstError(toasts.peek()), 'the invite to save');
      if (!matches() && !firstError(toasts.peek())) await get().refreshIssue();
    } finally {
      seen = toasts.stop();
    }
    const landed = matches() || (!firstError(seen) && seen.some((t) => /^invited|when they join|invitation waiting/i.test(t.text)));
    if (!landed) throw new Error(firstError(seen) || 'The invite did not go through — see the message on screen.');
    // Two different warnings can appear: the email/invite didn't go out, or the
    // chosen role can't edit magazines. Report each as what it is.
    const emailTrouble = seen.find((t) => t.type === 'warning' && /didn.t send|^saved —/i.test(t.text));
    const roleWarning = seen.find((t) => t.type === 'warning' && t !== emailTrouble);
    ui.flash(`mag.share-pending-${email}`);
    await sleep(900, ui.signal);
    await closeShareDialog(ui);
    return {
      ...result(),
      ...(role ? { role: role.label } : {}),
      ...(roleWarning ? { warning: roleWarning.text } : {}),
      emailed: emailTrouble ? `NO — ${emailTrouble.text}` : already ? 'no (pages changed only — the invite went out the first time)' : 'yes (or an invitation was already waiting for them)',
      messages: toastLines(seen),
    };
  }

  useAgentAction(
    {
      name: 'magazine.sharePages',
      description:
        "Share pages (person = userId, email or name) through the Share dialog. A staff member is added straight away and emailed a link; for someone who already has access this changes which pages they can edit. Someone NOT on the team yet must be given by EMAIL plus the ROLE they join the team with — ask the user for the role, never pick one (without it this returns the choices). They're emailed an invite, the share waits for them, and they get the pages automatically when they join — never ask the user to share again after they sign up.",
      args: z.object({ person: z.string().min(1), pages: pagesArg, role: z.string().min(1).optional() }),
      confirm: async ({ person, pages, role }) => {
        const s = get();
        // No card for page numbers that don't exist (run() refuses them before
        // touching anything) or for someone who already has exactly these pages
        // (run() returns unchanged).
        let wantIds: string[] | null = null;
        try {
          wantIds = pages === 'all' ? null : pages.map((n) => pageAt(s.pages, n).id);
        } catch {
          return null;
        }
        let existing = findCollaborator(person, s.issue?.collaborators);
        const title0 = s.issue?.title || 'this magazine';
        const what0 = pages === 'all' ? 'all pages' : pageListLabel(pages);
        const invitee = existing ? null : await newPersonEmail(person);
        if (invitee) {
          const pend = findPending(invitee, s.issue);
          if (pend) return hasScope(pend, wantIds) ? null : `Change the pages waiting for ${invitee} on “${title0}” to ${what0}?`;
          // No card until a role is chosen: run() stops first and asks the user.
          let r: InviteRoleOption | null;
          try {
            r = await inviteRoleFor(s.issueId!, invitee, role, false);
          } catch {
            return null;
          }
          return r
            ? `${invitee} isn't on the team yet. Invite them as ${r.label} and share ${what0} of “${title0}”? They'll be emailed an invitation and get the pages as soon as they join.`
            : `${invitee} isn't on the team yet. Save ${what0} of “${title0}” for them? You can't send team invites, so they'll get the pages once a team admin invites them.`;
        }
        if (!existing) {
          // Resolve the way run() will (staff directory). No card when run() is
          // going to refuse anyway: nobody / several people match, or it is the
          // owner. Someone matched in the directory who IS already a collaborator
          // (a partial name that only matched their email) is a scope change.
          const list = await loadDirectory().catch(() => null);
          if (list) {
            const hits = matchPeople(list, person);
            if (hits.length !== 1 || hits[0]!.userId === s.issue?.ownerId) return null;
            existing = s.issue?.collaborators?.find((c) => c.userId === hits[0]!.userId);
          }
        }
        if (existing && hasScope(existing, wantIds)) return null;
        const what = pages === 'all' ? 'all pages' : pageListLabel(pages);
        const title = s.issue?.title || 'this magazine';
        if (existing) return `Change ${collabName(existing)}'s access on “${title}” to ${what}?`;
        // Not a collaborator yet — the model usually passes the userId it got
        // from findStaff, so look the NAME up (staff directory) rather than
        // printing the id. Reported: "Share pages 1–2 … with 6650f1a2…?".
        const who = await personLabelAsync(person, s.issue?.collaborators);
        return `Share ${what} of “${title}” with ${who}? They'll be emailed a link.`;
      },
      run: async ({ person, pages, role }, ui) => {
        const s = await ready(ui);
        const issue = s.issue!;
        const nums = pages === 'all' ? null : Array.from(new Set(pages)).sort((a, b) => a - b);
        const wantIds = nums ? nums.map((n) => pageAt(s.pages, n).id) : null;

        let existing = findCollaborator(person, issue.collaborators);
        let newPerson: { userId: string; email: string; name: string } | null = null;
        const invitee = existing ? null : await newPersonEmail(person);
        if (invitee) return shareWithNewPerson(ui, invitee, nums, wantIds, role);
        if (!existing) {
          const p = resolvePerson(await loadDirectory(), person);
          if (p.userId === issue.ownerId) throw new Error(`${personDisplay(p)} owns this magazine already.`);
          // Matched in the directory but already on the magazine (e.g. a partial name
          // that only matched their email): the Share dialog lists them under
          // "People with access", not in the new-person picker — so it is a scope change.
          existing = issue.collaborators?.find((c) => c.userId === p.userId);
          if (!existing) newPerson = { userId: p.userId, email: p.email, name: personDisplay(p) };
        }
        // Already exactly this access — nothing to save (confirm() asked nothing).
        if (existing && hasScope(existing, wantIds)) {
          return {
            unchanged: true,
            sharedWith: { userId: existing.userId, name: existing.displayName || existing.email, email: existing.email },
            pages: scopeNumbers(existing, s.pages),
          };
        }
        const who = existing ? { userId: existing.userId, email: existing.email, name: collabName(existing) } : newPerson!;

        await openShareDialog(ui);
        const matches = () => {
          const c = get().issue?.collaborators?.find((x) => x.userId === who.userId);
          return !!c && hasScope(c, wantIds);
        };

        const prefix = existing ? 'mag.share-edit' : 'mag.share';
        if (existing) {
          // "Change pages" toggles; on the row already being edited it reads Cancel.
          if (!(anchor('mag.share-edit-save') && anchor(`mag.share-edit-${who.userId}`)?.textContent?.includes('Cancel'))) {
            await ui.click(`mag.share-edit-${who.userId}`, `Change ${who.name}'s pages`);
          }
          await ui.waitFor('mag.share-edit-save', 4000);
        } else {
          ui.step(`Choosing ${who.name}`);
          // The picker appears once the staff list loads; a failed load or an
          // empty list shows a sentence instead — report that, not a timeout.
          const dialogText = () => (anchor('mag.share-dialog')?.textContent ?? '').replace(/\s+/g, ' ');
          await waitUntil(
            () => !!anchor('mag.share-person') || !!anchor('mag.share-retry') || /already has access|only staff member/i.test(dialogText()),
            { signal: ui.signal, timeoutMs: 15_000, what: 'the staff list to load' },
          );
          if (!anchor('mag.share-person')) {
            throw new Error(
              anchor('mag.share-retry')
                ? "The Share dialog couldn't load the staff list — see the message on screen."
                : `${who.name} can't be added from the Share dialog right now — it says: ${dialogText().slice(0, 160)}`,
            );
          }
          await ui.select('mag.share-person', who.email);
        }

        if (!nums) {
          await ui.click(`${prefix}-scope-all`, 'All pages');
        } else {
          await ui.click(`${prefix}-scope-pick`, 'Specific pages');
          await ui.waitFor(`${prefix}-pages-clear`, 3000);
          await ui.click(`${prefix}-pages-clear`, 'Clear');
          for (const n of nums) await ui.click(`${prefix}-page-${n}`, `Page ${n}`);
        }

        const submit = existing ? 'mag.share-edit-save' : 'mag.share-submit';
        assertEnabled(submit, 'The Share button is not available.');
        ui.step(existing ? `Saving ${who.name}'s pages` : `Sharing with ${who.name}`);
        const toasts = watchToasts();
        let seen: SeenToast[] = [];
        try {
          await ui.click(submit, existing ? 'Save pages' : 'Share & email link');
          await settle(ui, submit, () => matches() || !!firstError(toasts.peek()), 'the share to save');
          // The dialog re-reads the magazine after a share; if that re-read failed
          // the share still happened (the toast says so) — read it once more here.
          if (!matches() && !firstError(toasts.peek())) await get().refreshIssue();
        } finally {
          seen = toasts.stop();
        }
        if (!matches()) {
          // The share landed but the dialog's re-read failed ("Shared — the list below
          // may be a moment behind"): a success the store cannot show yet.
          const landed = !firstError(seen) && seen.some((t) => /now has|^shared|^saved/i.test(t.text));
          if (!landed) throw new Error(firstError(seen) || 'The share did not go through — see the message on screen.');
          await closeShareDialog(ui);
          return { sharedWith: { userId: who.userId, name: who.name, email: who.email }, pages: nums ?? 'all', note: 'Saved; the collaborator list could not refresh yet.', messages: toastLines(seen) };
        }
        const emailTrouble = seen.find((t) => t.type === 'warning' && /email didn.t send/i.test(t.text));
        const roleWarning = seen.find((t) => t.type === 'warning' && t !== emailTrouble);

        ui.flash(`mag.share-collab-${who.userId}`);
        await sleep(900, ui.signal);
        await closeShareDialog(ui);
        const after = get();
        const c = after.issue!.collaborators!.find((x) => x.userId === who.userId)!;
        return {
          sharedWith: { userId: who.userId, name: who.name, email: who.email },
          pages: scopeNumbers(c, after.pages),
          emailed: existing ? 'no (scope change only — the share email goes out the first time)' : emailTrouble ? `NO — ${emailTrouble.text}` : 'yes',
          warning: roleWarning?.text,
          collaborators: collaboratorsOut(after.issue?.collaborators, after.pages),
        };
      },
    },
    isOwner,
  );

  useAgentAction(
    {
      name: 'magazine.unshare',
      description: "Remove a collaborator's access to this magazine (person = userId, email or name). Also cancels a pending share with someone invited by email who hasn't joined yet.",
      args: z.object({ person: z.string().min(1) }),
      confirm: ({ person }) => {
        const s = get();
        // Not a collaborator → run() refuses before touching anything; no card.
        const c = findCollaborator(person, s.issue?.collaborators);
        if (!c) {
          const p = findPending(person, s.issue);
          return p ? `Cancel the share with ${p.email} on “${s.issue?.title || 'this magazine'}”? They haven't joined yet.` : null;
        }
        return `Remove ${collabName(c)}'s access to “${s.issue?.title || 'this magazine'}”?`;
      },
      run: async ({ person }, ui) => {
        const s = await ready(ui);
        const c = findCollaborator(person, s.issue?.collaborators);
        const pending = c ? undefined : findPending(person, s.issue);
        if (pending) {
          await openShareDialog(ui);
          const gone = () => !findPending(pending.email, get().issue);
          const toasts = watchToasts();
          try {
            await ui.click(`mag.share-pending-remove-${pending.email}`, `Cancel ${pending.email}`);
            await waitUntil(() => gone() || !!firstError(toasts.peek()), { signal: ui.signal, timeoutMs: 20_000, what: 'the pending share to be cancelled' });
          } finally {
            toasts.stop();
          }
          if (!gone()) throw new Error(firstError(toasts.peek()) || `The share with ${pending.email} was not cancelled — see the message on screen.`);
          await sleep(500, ui.signal);
          await closeShareDialog(ui);
          const after = get();
          return { cancelledInvite: pending.email, pendingInvites: pendingSharesOut(after.issue?.pendingCollaborators, after.pages) };
        }
        // Named (staff directory), never the raw userId the model passed.
        if (!c) throw new Error(`${await personLabelAsync(person, s.issue?.collaborators)} is not a collaborator on this magazine.`);
        await openShareDialog(ui);
        const gone = () => !get().issue?.collaborators?.some((x) => x.userId === c.userId);
        const toasts = watchToasts();
        try {
          await ui.click(`mag.share-remove-${c.userId}`, `Remove ${collabName(c)}`);
          await waitUntil(() => gone() || !!firstError(toasts.peek()) || toasts.peek().some((t) => /^removed/i.test(t.text)), {
            signal: ui.signal,
            timeoutMs: 20_000,
            what: 'their access to be removed',
          });
          // Removed, but the dialog's re-read failed ("The list below may be a moment behind").
          if (!gone() && !firstError(toasts.peek())) await get().refreshIssue();
        } finally {
          toasts.stop();
        }
        if (!gone() && !toasts.peek().some((t) => /^removed/i.test(t.text))) {
          throw new Error(firstError(toasts.peek()) || `${collabName(c)}'s access was not removed — see the message on screen.`);
        }
        await sleep(500, ui.signal);
        await closeShareDialog(ui);
        const after = get();
        return { removed: { userId: c.userId, name: collabName(c) }, collaborators: collaboratorsOut(after.issue?.collaborators, after.pages) };
      },
    },
    isOwner,
  );

  // ── Magazine AI Studio ───────────────────────────────────────────────────
  useAgentAction(
    {
      name: 'magazine.askStudio',
      description:
        "Type a request into the Magazine AI Studio chat (optionally after opening a page) and send it, like a person; waits for the reply. The studio STAGES changes, kept per page until applied: proposalCount and stagedLine say what this turn REALLY staged (trust them over the reply's wording), pendingChanges lists every page's waiting changes. Pass apply:true to apply this page's (or call magazine.applyStudioChanges); an apply returns a measured pageCheck. A word or name swap across pages is magazine.replaceText, and a chart from numbers is magazine.addChart — not this.",
      args: z.object({
        prompt: z.string().min(1).max(4000),
        page: z.number().int().min(1).optional(),
        apply: z.boolean().optional(),
      }),
      run: async ({ prompt, page, apply }, ui) => {
        // "Replace NZTROF with NOG everywhere" is not a studio job: the studio edits
        // only the open page, and before replace_text it could only do it by retyping
        // whole paragraphs it saw a preview of (C17). Refused before anything is
        // touched, with the exact call to make instead.
        const swap = magazineWideSwap(prompt);
        if (swap) {
          throw actionError('Swapping a word or name across the magazine is done with Replace text, not the studio — the studio only changes the open page.', {
            next: `Call magazine.replaceText { find: ${JSON.stringify(swap.find)}, replace: ${JSON.stringify(swap.replace)} } — it counts the matches on every page and asks the user before changing anything. For a swap on one page only, ask the studio without "everywhere".`,
          });
        }
        // A HANDFUL PER RUN, THEN ASK. After a build, The Stable Hand once "fixed" page
        // after page — and back again — for half an hour of paid AI time without the
        // user asking (2026-11-16). Several pages are fixed with magazine.fixPages, ONE
        // action the user confirms; anything past this many single requests in one run
        // needs the user's go-ahead.
        const used = studioRequestsPerRun.get(ui.signal) ?? 0;
        if (used >= MAX_STUDIO_REQUESTS_PER_RUN) {
          throw actionError(`${used} Design Helper requests were made in this run without the user's go-ahead, so no more are sent.`, {
            next: 'Stop here. Tell the user in a short list what was changed and what still looks wrong, and ask (offer_choices) whether to carry on. To fix several pages after they agree, use magazine.fixPages — one request per page.',
          });
        }
        studioRequestsPerRun.set(ui.signal, used + 1);
        return runStudioTurn(ui, prompt, page, apply);
      },
    },
    canEdit,
  );

  /** One Design Helper request on the open page (or `page`), like a person typing it:
   *  wait for the reply, optionally apply, and return what really happened. Shared by
   *  magazine.askStudio and magazine.fixPages (which does not count against the cap). */
  async function runStudioTurn(ui: UiDriver, prompt: string, page: number | undefined, apply: boolean | undefined) {
    await ready(ui);
    // The studio works on the OPEN page: wait for the canvas to settle on it, or
    // the scroll-settle picker can hand the turn to a neighbouring page.
    if (page) await openPageN(ui, page);
    if (!get().currentPageId) throw new Error('No page is open yet — wait for the first page to build.');
    // The chat shows this request word for word: element ids become words.
    prompt = humanizeElementIds(prompt, get().page?.elements ?? []);
    await ensureStudioComposer(ui);
    // The studio says up front when this page cannot be changed by this user (a
    // submitted/approved page, or a role without magazine.edit) and disables its
    // composer. Report that reason rather than typing into a disabled box.
    const blocked = anchor('mag.ai-send')?.getAttribute('data-studio-blocked');
    if (blocked) throw new Error(blocked);
    await waitUntil(() => !get().chatBusy, { signal: ui.signal, timeoutMs: 300_000, what: 'the studio to finish its previous reply' });

    const before = get().chat.length;
    ui.step('Asking the Magazine AI Studio');
    // Watch the studio's own toasts during the turn: when an attached image
    // can't be stored (e.g. the bucket's CORS doesn't allow this site's
    // address) the studio only DESCRIBES it to its AI, which can't place the
    // real file — and stages a look-alike instead (a solid-black image came
    // back as a black shape). That must stop the job, not be applied.
    const toasts = watchToasts();
    let seen: SeenToast[] = [];
    const sentAt = Date.now();
    try {
      await ui.type('mag.ai-input', studioPrompt(prompt), { clear: true });
      assertEnabled('mag.ai-send', 'The studio cannot take a message right now.');
      await ui.click('mag.ai-send', 'Send');
      await waitForStudioTurn(ui, before, Date.now(), () => firstError(toasts.peek()));
    } finally {
      seen = toasts.stop();
    }
    const storageProblem = seen.find((t) => /couldn.t store|could not reach storage|can.t be placed/i.test(t.text));
    return finishStudioTurn(ui, storageProblem ? false : apply, seen, storageProblem?.text, sentAt);
  }

  /**
   * The request as the studio should read it: every "page N" that means the OPEN
   * page becomes "this page", while a page of a document ("page 3 of the attached
   * PDF") is left word for word — rewriting those sent a layout-from-PDF request to
   * the wrong PDF page (C21). The rule and its tests: editorActionsPure.studioPrompt.
   */
  function studioPrompt(prompt: string): string {
    const s = get();
    return rewriteStudioPrompt(prompt, s.pages, s.currentPageId);
  }

  /** What the studio composer is doing right now, read off its Send button
   *  (AiPanel sets data-studio-phase). 'ingesting' = uploading/reading an
   *  attachment before the message goes out — local state the store can't see. */
  function studioPhase(): 'ingesting' | 'replying' | 'idle' | 'unknown' {
    const btn = document.querySelector('[data-agent-id="mag.ai-send"]');
    const p = btn?.getAttribute('data-studio-phase');
    return p === 'ingesting' || p === 'replying' || p === 'idle' ? p : 'unknown';
  }

  /**
   * Wait until the studio has REALLY finished the turn: the attachment is read,
   * the message is in the thread and the reply is done. Uploading/reading counts
   * as progress, never as "not sent" — a big image can take a while (reported:
   * the Stable Hand gave up after 4s while the studio was still reading the
   * user's photo, then told the user the studio was "still working").
   * "Not sent" is concluded when the studio has sat idle for 20s with nothing
   * posted — or at once when the panel raised an error (an unreadable document
   * stops the turn before anything is posted).
   */
  async function waitForStudioTurn(ui: UiDriver, chatLenBefore: number, sentAt: number, errorNow?: () => string | undefined) {
    let shown: string | null = null;
    const note = (label: string) => {
      if (shown !== label) {
        shown = label;
        ui.step(label);
      }
    };
    // The studio is briefly idle between "reading the attachment" and
    // "replying" — only a SETTLED idle (1.5s) counts as the turn being over.
    let idleSince = 0;
    await waitUntil(
      () => {
        const st = get();
        const phase = studioPhase();
        if (phase === 'ingesting') {
          idleSince = 0;
          note('The studio is reading the attachment');
          return false;
        }
        if (st.chatBusy || phase === 'replying') {
          idleSince = 0;
          note('Waiting for the studio to reply');
          return false;
        }
        if (!idleSince) idleSince = Date.now();
        if (st.chat.length >= chatLenBefore + 2) return Date.now() - idleSince >= 1500;
        if (st.chat.length === chatLenBefore && Date.now() - idleSince >= 1500) {
          const err = errorNow?.();
          if (err) throw new Error(`The studio did not take the message: ${err}`);
          // Idle, nothing posted, nothing reading, nothing replying: nothing is in
          // flight. Waiting the full ten minutes would only hide that.
          if (Date.now() - sentAt > 20_000) {
            const box = document.querySelector<HTMLTextAreaElement | HTMLInputElement>('[data-agent-id="mag.ai-input"]');
            const stillTyped = !!box && 'value' in box && box.value.trim().length > 0;
            throw new Error(
              stillTyped
                ? 'The message was not sent — the studio composer did not accept it.'
                : 'The studio did not reply — nothing was posted. Check the studio panel, then try again.',
            );
          }
        }
        return false;
      },
      { signal: ui.signal, timeoutMs: 600_000, intervalMs: 500, what: "the studio's reply" },
    );
  }

  /**
   * Read the finished turn; optionally apply its page's waiting changes and verify.
   *
   * What the turn DID comes from the store's record of it (lastTurn: the proposals
   * themselves), never from the model's reply. The reply once said "All six paragraphs
   * are 20px and 220px tall" after calling no tool at all, and both the user and the
   * Stable Hand believed it. `sentAt` keeps an older turn's record from being read as
   * this one's.
   */
  async function finishStudioTurn(ui: UiDriver, apply: boolean | undefined, toasts: SeenToast[] = [], storageProblem?: string, sentAt?: number) {
    const after = get();
    const reply = [...after.chat].reverse().find((m) => m.role === 'assistant')?.content ?? '';
    const turn = after.lastTurn && (!sentAt || after.lastTurn.at >= sentAt) ? after.lastTurn : null;
    // The page the turn was about: its record's, else the open one.
    const turnPageId = turn?.pageId ?? after.currentPageId;
    const onPage = pageNoOf(after.pages, turnPageId);
    const staged = pendingFor(after.pending, turnPageId).map(proposalOut);
    // The studio's own check of what its staged changes would leave wrong (only NEW
    // errors), when it sent one for this page.
    const predicted = after.lastCheck && after.lastCheckPageId === turnPageId ? after.lastCheck : null;
    // The turn itself failed (server error, refusal): the store posts an apology and
    // raises an error toast — say so instead of "the studio staged no changes".
    const turnError = !turn ? firstError(toasts) : undefined;
    let outcome: Awaited<ReturnType<typeof applyStaged>> | null = null;
    if (apply && staged.length > 0 && turnPageId) {
      // Same question as magazine.applyStudioChanges (deletions, a layout rebuild, a
      // PDF page copy, an AI page build). An OK here also pre-approves the app's own
      // window.confirm for the rebuild / a submitted page's deletion.
      const risky = stagedRiskQuestion(turnPageId);
      if (risky && !(await ui.confirm(risky))) {
        return {
          reply: reply.slice(0, 2000),
          proposalCount: turn?.added ?? 0,
          stagedLine: turn?.line,
          stagedChanges: staged,
          stagedOnPage: onPage,
          pendingChanges: pendingOut(),
          applied: false,
          declined: true,
        };
      }
      outcome = await applyStaged(ui, turnPageId);
    }
    const applied = !!outcome;
    // Applied: measure the page as it renders now, and hand the model the numbers.
    const measuredId = outcome?.pageIds[0] ?? null;
    const measured = outcome ? await measurePageId(measuredId, ui.signal) : null;
    const measuredPage = outcome ? pageNoOf(get().pages, measuredId) : null;
    const buildNote = outcome?.buildJobId ? ' It also started an AI page build: a [job-update] message arrives when it finishes.' : '';
    const waitingNote = outcome?.buildWaiting ? ` ${outcome.buildWaiting}` : '';
    // Waiting on OTHER pages (earlier requests) — reported every time, so nothing staged
    // is forgotten between calls the way the single tray forgot it.
    const pendingChanges = pendingOut();
    const elsewhere = pendingChanges.filter((w) => !turnPageId || w.page !== onPage);
    const elsewhereNote =
      elsewhere.length > 0
        ? ` Also waiting for Apply, from earlier requests: ${changeCount(elsewhere.reduce((n, w) => n + w.count, 0))} on ${pagesPhrase(elsewhere.map((w) => w.page))} (pendingChanges). Apply those only if the user asks — magazine.applyStudioChanges applies every page's, after a card that lists them.`
        : '';
    const claimNote = turn?.claimedWithoutChange
      ? " The studio's reply CLAIMS it changed things, but it staged NOTHING — nothing was changed. Do not report it as done: ask the studio again naming the elements in words and the exact values, or tell the user plainly that nothing changed."
      : '';
    return {
      reply: reply.slice(0, 2000),
      // What this turn REALLY staged — counted from its proposals. Trust these over
      // the reply's own account of itself.
      proposalCount: turn?.added ?? 0,
      stagedLine: turn?.line,
      stagedChanges: applied ? [] : staged,
      appliedChanges: applied ? staged : undefined,
      stagedOnPage: onPage,
      pendingChanges,
      applied,
      partial: outcome?.partial || undefined,
      perPage: outcome ? outcome.reports.map(reportOut) : undefined,
      buildJobId: outcome?.buildJobId,
      pageCheck: measured?.check ?? undefined,
      measuredPage: measuredPage ?? undefined,
      // Not applied yet: what the studio itself measured its changes would leave.
      predictedProblems: !applied && predicted && predicted.issues.length > 0 ? predicted : undefined,
      appMessages: [...toasts, ...(outcome?.messages ?? [])].map((t) => t.text).filter((t, i, all) => all.indexOf(t) === i).slice(0, 8),
      storageProblem: storageProblem
        ? `${storageProblem} — the attached file never reached storage, so the studio could NOT place the real image; anything it staged is only a look-alike. Do NOT apply it. Tell the user the upload failed and why (usually the S3 bucket's CORS rule doesn't allow this site's address), and suggest discarding the staged changes.`
        : undefined,
      note:
        (storageProblem
          ? 'NOT applied: the image upload failed (see storageProblem).'
          : turnError
            ? `The studio's turn FAILED: ${turnError} Nothing was staged or changed.`
            : outcome?.partial
              ? `PARTLY applied: ${applyReportLine(outcome.reports)}${waitingNote} ${measuredSentence(measured?.check, measured?.why)}`
              : applied
                ? `${appliedNote(measured?.check, measured?.why)} (Undo with magazine.undo.)${buildNote}${waitingNote}`
                : staged.length > 0
                  ? `Changes are STAGED (waiting for Apply), not on the page yet: ${turn?.line ?? `${changeCount(staged.length)} on page ${onPage}.`} If the user asked for this change, call magazine.waitForStudio with apply: true now — it applies this page's changes only (magazine.applyStudioChanges would apply every page's, including older requests').` +
                    (predicted && predicted.issues.length > 0 ? ' The studio measured problems these changes would leave (predictedProblems) — ask it to fix them first.' : '')
                  : 'The studio staged no changes — nothing was changed. Read its reply; it may need more detail.') +
        claimNote +
        elsewhereNote,
      pageCount: get().pages.length,
    };
  }

  // Recovery / follow-up: the studio is mid-turn (reading an attachment or
  // replying) or has finished with staged changes. Never leave the user with
  // "it's still working" — wait here, then finish the job.
  useAgentAction(
    {
      name: 'magazine.waitForStudio',
      description:
        'Wait (up to 10 minutes) for the Magazine AI Studio to finish what it is doing — reading an attachment, then replying — and return its reply, what it really staged (proposalCount, stagedLine) and every page\'s waiting changes. With apply:true, then apply that page\'s waiting changes, confirm they are on the page and return the page measured (pageCheck). Use whenever the studio is still working on something you asked for.',
      args: z.object({ apply: z.boolean().optional() }),
      run: async ({ apply }, ui) => {
        await ready(ui);
        // The panel, NOT a fresh chat (staged changes now survive one, but the reply
        // being waited for lives in this one).
        await ensureStudioPanel(ui);
        const st = get();
        const phase = studioPhase();
        const busy = phase === 'ingesting' || phase === 'replying' || st.chatBusy;
        // While the attachment is still being read the message is not in the thread
        // yet (the turn adds 2); once it is replying, the message is (it adds 1).
        if (busy) await waitForStudioTurn(ui, phase === 'ingesting' ? st.chat.length : Math.max(0, st.chat.length - 1), Date.now());
        // Already idle: there is no turn to wait for — just report / apply.
        return finishStudioTurn(ui, apply);
      },
    },
    canEdit,
  );

  /**
   * Apply waiting changes and follow the apply to the end — one page's (its tray's
   * "Use these changes") or every page's (the bar's "Apply all", `scopePageId` null).
   *
   * The store records what happened on each page (lastApplyReport): applied, refused,
   * still waiting, declined at a confirm, a rebuild or copy started. That record is
   * the result — the toasts are kept only as the user's own words for it. An apply
   * that changed nothing is an error, never "applied".
   */
  async function applyStaged(
    ui: UiDriver,
    scopePageId: string | null,
  ): Promise<{ partial: boolean; messages: SeenToast[]; buildJobId?: string; buildWaiting?: string; pageIds: string[]; reports: PageApplyReport[] }> {
    const s = get();
    const scope = waitingPages(s.pending, s.pages).filter((w) => !scopePageId || w.pageId === scopePageId);
    if (scope.length === 0) throw new Error(scopePageId ? 'The studio has no changes waiting on that page.' : 'The studio has no changes waiting.');
    const all = scope.flatMap((w) => w.proposals.map((p) => ({ p, ownerId: w.pageId })));
    const layoutAt = all.find((x) => x.p.kind === 'apply-layout');
    const copyAt = all.find((x) => x.p.kind === 'copy-document-page');
    const copyPageId = copyAt ? copyAt.p.pageId || copyAt.ownerId : null;
    const gen = all.some((x) => x.p.kind === 'generate-pages');
    const pageCountBefore = get().pages.length;
    // A staged page build starts a NEW build — let the last one's watch finish first.
    if (gen && get().issueId) await settlePreviousBuildJob(get().issueId!, ui.signal);

    let button: string;
    let label: string;
    if (scopePageId) {
      // One page: its own tray, on the Chat tab of the open studio pane.
      if (scopePageId !== get().currentPageId) {
        const n = pageNoOf(get().pages, scopePageId) ?? 0;
        if (n <= 0) throw new Error('The page those changes were for no longer exists.');
        await openPageN(ui, n);
      }
      await ensureStudioPanel(ui);
      await ui.waitFor('mag.ai-apply', 4000);
      button = 'mag.ai-apply';
      label = 'Use these changes';
      ui.step('Applying the studio’s changes');
    } else {
      // Every page: the waiting-changes bar at the top of the studio pane.
      await ensureStudioPanel(ui);
      await ui.waitFor('mag.waiting-apply-all', 4000);
      button = 'mag.waiting-apply-all';
      label = 'Apply all';
      ui.step(`Applying the changes waiting on ${pagesPhrase(scope.map((w) => w.page))}`);
    }

    // The store sets lastApplyReport when an apply ENDS (a new array every time), so a
    // different one than before the click is the definitive "it ran and finished".
    const reportBefore = get().lastApplyReport;
    // Watched by subscription: a quick apply can raise and drop the flag between polls.
    let sawApplying = get().applyingProposals;
    const unwatch = useEditorStore.subscribe((st, prev) => {
      if (st.applyingProposals && !prev.applyingProposals) sawApplying = true;
    });
    const toasts = watchToasts();
    let seen: SeenToast[] = [];
    try {
      await ui.click(button, label);
      const clickedAt = Date.now();
      await waitUntil(
        () =>
          (get().lastApplyReport !== reportBefore && !get().applyingProposals) ||
          // One page: the canvas moved off it before the click landed — nothing ran.
          (!!scopePageId && !get().applyingProposals && get().lastApplyReport === reportBefore && get().currentPageId !== scopePageId) ||
          // The click never started an apply (the studio still replying, say): stop
          // waiting rather than sit out the whole timeout.
          (!sawApplying && get().lastApplyReport === reportBefore && Date.now() - clickedAt > 5000),
        // Apply all opens each page in turn; a long run across many pages needs time.
        { signal: ui.signal, timeoutMs: scopePageId ? 180_000 : 600_000, intervalMs: 300, what: 'the changes to apply' },
      );
      // A rebuild runs inside the apply; a PDF page copy runs in the worker and the
      // store follows it until the copied page is on screen. Wait for that, so the page
      // measured next is the copy.
      await waitUntil(() => !get().layoutBusy, { signal: ui.signal, timeoutMs: 180_000, what: 'the layout rebuild to finish' });
      const reportsNow = get().lastApplyReport ?? [];
      if (copyPageId && reportsNow.some((r) => r.started === 'copy')) {
        await softWait(ui, () => get().copyingPageIds.includes(copyPageId), 3000);
        await waitUntil(() => !get().copyingPageIds.includes(copyPageId), { signal: ui.signal, timeoutMs: 180_000, what: 'the PDF page copy to finish' });
      }
      // The closing toast is raised as the apply ends.
      await softWait(ui, () => toasts.peek().length > 0, 2000);
    } finally {
      unwatch();
      seen = toasts.stop();
    }
    const reports = get().lastApplyReport !== reportBefore ? (get().lastApplyReport ?? []) : [];
    if (reports.length === 0) {
      throw new Error(
        get().chatBusy
          ? 'The studio is still replying, so the apply did not start — nothing was changed. Call magazine.waitForStudio, then apply.'
          : 'The canvas moved to another page before the changes could be applied — nothing was changed. Try again.',
      );
    }
    if (reports.every((r) => r.declined)) {
      throw new Error('The user said no at the confirm, so nothing was applied — the changes are still waiting.');
    }
    const appliedAny = reports.some((r) => r.applied > 0 || !!r.started);
    if (!appliedAny) {
      const errs = errorToasts(seen);
      throw new Error(`${applyReportLine(reports)}${errs.length > 0 ? ` (${errs.map((t) => t.text).join(' ')})` : ''}`);
    }
    // A rebuild that failed on one page while others applied is PARTIAL, not an error:
    // the per-page report says which page and that its rebuild is still waiting.
    const partial = applyOutcome(reports) === 'partial';
    // A staged "design N new pages" starts a real build: watch it like addAiPages does.
    const buildLeft = waitingPages(get().pending, get().pages).some((w) => w.proposals.some((p) => p.kind === 'generate-pages'));
    let buildJobId: string | undefined;
    if (gen && !buildLeft && isBuilding() && get().issueId) {
      buildJobId = startMagazineBuildJob({ magazineId: get().issueId!, title: get().issue?.title, mode: 'add', pageCountBefore }).id;
    }
    const buildWaiting = gen && buildLeft
      ? 'The staged AI page build could NOT start yet (another build is running) — it is still waiting; call magazine.applyStudioChanges again after the running build finishes.'
      : undefined;
    // The pages the changes LANDED on — what is measured afterwards. A rebuild or a copy
    // the user aimed at a NAMED page lands there, not on the page that staged it.
    const landed: string[] = [];
    const add = (id: string | null | undefined) => {
      if (id && !landed.includes(id) && get().pages.some((p) => p.id === id)) landed.push(id);
    };
    if (copyPageId && reports.some((r) => r.started === 'copy')) add(copyPageId);
    if (layoutAt && reports.some((r) => r.started === 'layout')) add(layoutAt.p.pageId || layoutAt.ownerId);
    for (const r of reports) if (r.applied > 0 && !r.started) add(r.pageId);
    return { partial, messages: seen, buildJobId, buildWaiting, pageIds: landed, reports };
  }

  /** Measure each page an apply landed on (the first few). */
  async function measureLanded(pageIds: string[], signal: AbortSignal) {
    const out: { page: number | null; check: PageCheck | null; why?: string }[] = [];
    for (const id of pageIds.slice(0, 4)) {
      const m = await measurePageId(id, signal);
      out.push({ page: pageNoOf(get().pages, id), ...m });
    }
    return out;
  }

  useAgentAction(
    {
      name: 'magazine.applyStudioChanges',
      description:
        'Apply EVERY page\'s changes the AI Studio has staged and nobody has applied yet (they wait per page until applied), in page order — the "Apply all" bar; with page (its number as printed), only that page\'s, through its own "Use these changes". Undoable with Ctrl+Z, except page deletions, a layout rebuild and a PDF page copy — those, and an AI page build, ask the user first; so does anything waiting on a page other than the latest request\'s (the card lists every page and its count). A text edit whose box was edited after it was staged is held back, still waiting (perPage heldBecauseEditedSinceStaged) — apply it again only if the user says so. Returns what landed on each page (perPage), anything still waiting, and the pages measured afterwards (pageCheck / pageChecks). To apply only the page you just asked about, pass apply:true to magazine.askStudio or magazine.waitForStudio instead.',
      // `page` narrows Apply all to one page's waiting changes. The catalog twin takes
      // the same argument; the two must match (operatorMagazineCatalog.test.ts).
      args: z.object({ page: z.number().int().min(1).optional() }),
      // Asks for deletions / a layout rebuild / a PDF page copy / an AI page build
      // (see stagedRiskQuestion) — and, for every page, whenever it reaches pages other
      // than the latest request's, names every page and its count (applyAllConfirm).
      // One named page asks only for its risky kinds: the user named the page.
      confirm: ({ page }) => (page === undefined ? applyAllConfirm() : onePageApplyConfirm(page)),
      run: async ({ page }, ui) => {
        const s = await ready(ui);
        const scopeId: string | null = page === undefined ? null : targetPage(s.pages, page).id;
        const before = pendingOut(scopeId);
        if (before.length === 0) {
          if (scopeId) {
            throw actionError(`Nothing is waiting for Apply on page ${page}.`, {
              next: 'magazine.status lists every waiting change and its page; call this again with that page, or without page for all of them.',
            });
          }
          throw actionError('Nothing is waiting for Apply.', {
            next: 'Ask the studio for the change first (magazine.askStudio), then apply it. magazine.status lists every waiting change.',
          });
        }
        const out = await applyStaged(ui, scopeId);
        const checks = await measureLanded(out.pageIds, ui.signal);
        const first = checks[0];
        const build = out.buildJobId ? ' An AI page build started in the background — a [job-update] message arrives when it finishes.' : '';
        const waiting = out.buildWaiting ? ` ${out.buildWaiting}` : '';
        const errorsSomewhere = checks.some((c) => c.check && c.check.issues.some((i) => i.severity === 'error'));
        return {
          applied: before,
          perPage: out.reports.map(reportOut),
          line: applyReportLine(out.reports),
          partial: out.partial || undefined,
          messages: toastLines(out.messages),
          buildJobId: out.buildJobId,
          pageCheck: first?.check ?? undefined,
          measuredPage: first?.page ?? undefined,
          // More than one page landed: each one's verdict (the first is pageCheck).
          pageChecks:
            checks.length > 1
              ? checks.map((c) => ({ page: c.page, ok: c.check?.ok ?? null, summary: c.check?.summary ?? `not measured (${c.why ?? 'unknown'})`, errors: c.check ? c.check.issues.filter((i) => i.severity === 'error') : [] }))
              : undefined,
          stillWaiting: pendingOut(),
          note: out.partial
            ? `${applyReportLine(out.reports)}${waiting} ${measuredSentence(first?.check, first?.why)}`
            : `${applyReportLine(out.reports)} ${appliedNote(first?.check, first?.why)}${checks.length > 1 && errorsSomewhere ? ' Another page measured has errors too — see pageChecks.' : ''}${build}${waiting}`,
          pageCount: get().pages.length,
        };
      },
    },
    canEdit,
  );

  useAgentAction(
    {
      name: 'magazine.discardStudioChanges',
      description: `Throw away EVERY page's waiting AI Studio changes (the bar's "Discard"); with page (its number as printed), only that page's. Nothing on the pages changes. The user can press "Bring back" on the message for a few seconds.`,
      // `page` narrows it to one page's — the same argument as applyStudioChanges.
      args: z.object({ page: z.number().int().min(1).optional() }),
      run: async ({ page }, ui) => {
        const s = await ready(ui);
        const scopeId: string | null = page === undefined ? null : targetPage(s.pages, page).id;
        const before = pendingOut(scopeId);
        const n = before.reduce((sum, w) => sum + w.count, 0);
        if (n === 0) return { discarded: 0, stillWaiting: pendingOut() };
        await ensureStudioPanel(ui);
        // The control the user would press: the bar's Discard for every page, the
        // open page's tray for its own set — else the same store handler.
        if (!scopeId) {
          if (!(await clickIfPresent(ui, 'mag.waiting-discard', 'Discard'))) get().discardWaiting();
        } else if (scopeId === get().currentPageId) {
          if (!(await clickIfPresent(ui, 'mag.ai-discard', "Don't use these"))) get().discardWaiting(scopeId);
        } else {
          get().discardWaiting(scopeId);
        }
        return {
          discarded: n,
          pages: before.map((w) => ({ page: w.page, count: w.count })),
          stillWaiting: pendingOut(),
          note: `Discarded ${changeCount(n)} on ${pagesPhrase(before.map((w) => w.page))}; nothing on the pages changed.`,
        };
      },
    },
    canEdit,
  );

  // ── Seeing the page ──────────────────────────────────────────────────────
  // A read: measuring changes nothing, so it is offered to anyone who can open the
  // magazine (like magazine.status).
  useAgentAction({
    name: 'magazine.checkPage',
    description:
      "Measure a page as it renders in this browser (default: the open page; page = its number as printed): text cut off by its box or running past the page edge, overlapping or hidden elements, empty or broken pictures, tiny or low-contrast text, uneven gaps. Returns pageCheck (ok, and each issue with its element id, what was measured and a fix with numbers) and the page's elements (id, type, role, label, box [x, y, w, h], z). Use it after any page change and before telling the user a page is done.",
    args: z.object({ page: z.number().int().min(1).optional() }),
    run: async ({ page }, ui) => {
      const s = await ready(ui);
      const target = targetPage(s.pages, page);
      const n = pageNo(target);
      ui.step(`Measuring page ${n}`);
      let data: IssuePageData;
      try {
        data = await pageData(target.id);
      } catch (e) {
        throw new Error(apiMessage(e, `Page ${n} could not be read just now.`));
      }
      const measured = await measureSafely(data, ui.signal);
      if (!measured.check) {
        throw actionError(`Page ${n} could not be measured just now: ${measured.why}.`, {
          next: "Call magazine.checkPage once more; magazine.lookAtPage also returns the server's own measurement of the saved page.",
        });
      }
      ui.flash(`mag.page-${n}`);
      return {
        page: n,
        open: get().currentPageId === target.id,
        pageCheck: measured.check,
        ...pageElementList(data.elements),
      };
    },
  });

  // ── Ask first, then fix in ONE pass ──────────────────────────────────────
  // After a build The Stable Hand used to measure a page, fix its headline, move on,
  // come back and fix something else — half an hour of paid AI time nobody asked for
  // (2026-11-16). Now: checkAllPages measures every page once and changes nothing;
  // the user decides; fixPages visits each chosen page ONCE with every problem on it
  // in one Design Helper request (one retry at most), behind a confirm card that says
  // about how long and how much it will cost.
  useAgentAction({
    name: 'magazine.checkAllPages',
    description:
      "Measure EVERY page once in this browser (changes nothing) and return each page's errors (in words) and warning count, the pages with errors, and fixEstimate (about how long and how much AI usage fixing them takes). Then REPORT to the user and ASK (offer_choices: Fix all / only some pages / Not now) — never fix without a yes; after a yes use magazine.fixPages.",
    args: z.object({}),
    run: async (_a, ui) => {
      const s = await ready(ui);
      const pages: { page: number; errors?: string[]; moreErrors?: number; warnings?: number; notMeasured?: string }[] = [];
      for (const p of s.pages) {
        if (ui.signal.aborted) break;
        const n = pageNo(p);
        ui.step(`Measuring page ${n} of ${s.pages.length}`);
        let data: IssuePageData;
        try {
          data = await pageData(p.id);
        } catch (e) {
          pages.push({ page: n, notMeasured: apiMessage(e, 'the page could not be read') });
          continue;
        }
        const m = await measureSafely(data, ui.signal);
        if (!m.check) {
          pages.push({ page: n, notMeasured: m.why ?? 'it could not be measured' });
          continue;
        }
        const errors = m.check.issues.filter((i) => i.severity === 'error');
        const warnings = m.check.issues.length - errors.length;
        pages.push({
          page: n,
          ...(errors.length > 0
            ? { errors: errors.slice(0, 5).map((i) => humanizeElementIds(`${i.label}: ${i.detail}`, data.elements)), ...(errors.length > 5 ? { moreErrors: errors.length - 5 } : {}) }
            : {}),
          ...(warnings > 0 ? { warnings } : {}),
        });
      }
      const withErrors = pages.filter((p) => p.errors).map((p) => p.page);
      return {
        pages,
        pagesWithErrors: withErrors,
        fixEstimate: withErrors.length > 0 ? fixEstimate(withErrors.length).text : undefined,
        note:
          withErrors.length > 0
            ? `Nothing was changed. Tell the user in one short list which pages have problems and what, with the estimate, and ask (offer_choices: Fix all / Only page N / Not now). Fix only after a yes, with magazine.fixPages { pages: [${withErrors.join(', ')}] } (or the pages they chose).`
            : 'Nothing was changed. No errors on any measured page.',
      };
    },
  });

  useAgentAction(
    {
      name: 'magazine.fixPages',
      description:
        "Fix the measured errors on the given pages (default: every page with errors) in ONE pass: each page is opened once, ALL its errors go to the Design Helper in one request, the changes are applied and the page re-measured (one retry only if errors remain). Asks the user to confirm first with about how long and how much AI usage. Use only after the user agreed (e.g. to a magazine.checkAllPages report).",
      args: z.object({ pages: z.array(z.number().int().min(1)).max(60).optional() }),
      confirm: ({ pages }) => fixPagesQuestion(pages && pages.length > 0 ? [...new Set(pages)] : null, get().pages.length),
      run: async ({ pages }, ui) => {
        const s = await ready(ui);
        const targets = pages && pages.length > 0 ? [...new Set(pages)].sort((a, b) => a - b).map((n) => targetPage(s.pages, n)) : s.pages;
        const report: { page: number; result: string; remaining?: string[] }[] = [];
        for (const p of targets) {
          if (ui.signal.aborted) break;
          const n = pageNo(p);
          // Earlier, unapplied Design Helper changes on this page would be applied too —
          // that is the user's call, not this action's.
          if (pendingFor(get().pending, p.id).length > 0) {
            report.push({ page: n, result: 'skipped — it has changes from an earlier request waiting for Apply; apply or discard those first' });
            continue;
          }
          ui.step(`Page ${n}: measuring`);
          let data: IssuePageData;
          try {
            data = await pageData(p.id);
          } catch (e) {
            report.push({ page: n, result: `not fixed — ${apiMessage(e, 'the page could not be read')}` });
            continue;
          }
          const m = await measureSafely(data, ui.signal);
          if (!m.check) {
            report.push({ page: n, result: `not fixed — it could not be measured (${m.why})` });
            continue;
          }
          const request = fixRequestText(m.check.issues, data.elements);
          if (!request) {
            report.push({ page: n, result: 'no errors — left as it is' });
            continue;
          }
          const before = m.check.issues.filter((i) => i.severity === 'error').length;
          ui.step(`Page ${n}: fixing ${before} problem${before === 1 ? '' : 's'} in one request`);
          let turn = await runStudioTurn(ui, request, n, true);
          let left = turn.pageCheck ? turn.pageCheck.issues.filter((i) => i.severity === 'error') : null;
          // ONE retry, only for what is still wrong — never a third visit.
          if (turn.applied && turn.pageCheck && left && left.length > 0) {
            const again = fixRequestText(turn.pageCheck.issues, get().page?.elements ?? []);
            if (again) {
              ui.step(`Page ${n}: one more try for ${left.length} problem${left.length === 1 ? '' : 's'}`);
              turn = await runStudioTurn(ui, again, n, true);
              left = turn.pageCheck ? turn.pageCheck.issues.filter((i) => i.severity === 'error') : left;
            }
          }
          const elements = get().page?.elements ?? data.elements;
          report.push({
            page: n,
            result: !turn.applied
              ? `not changed — ${turn.note ?? 'the Design Helper staged nothing'}`
              : left === null
                ? `applied ${before} fix${before === 1 ? '' : 'es'}; the page could not be re-measured`
                : left.length === 0
                  ? `fixed all ${before} problem${before === 1 ? '' : 's'}`
                  : `fixed ${Math.max(0, before - left.length)} of ${before}; ${left.length} still need a person`,
            ...(left && left.length > 0 ? { remaining: left.slice(0, 5).map((i) => humanizeElementIds(`${i.label}: ${i.detail}`, elements)) } : {}),
          });
        }
        return {
          pages: report,
          stopped: ui.signal.aborted || undefined,
          note: 'Each page was visited once (one retry at most). Report briefly what was fixed and what still needs a person; do not run more fixes on these pages unless the user asks.',
        };
      },
    },
    canEdit,
  );

  // A read too, like checkPage: the server renders the STORED page behind the same read
  // gate as GET page (canViewPage), so a view-only staff member asking "does page 3 look
  // right?" gets it as well. It changes nothing.
  useAgentAction(
    {
      name: 'magazine.lookAtPage',
      description:
        "A visual review of a page (default: the open page): the server renders the SAVED page and an AI looks at the picture; focus = what to look at ('the headline', 'is the chart readable'). Returns findings (area, issue, fix, and the element id when known) together with pageCheck measured in this browser. Slower than magazine.checkPage — use it after adding a picture or chart or changing the layout, or when the user says something LOOKS wrong.",
      args: z.object({ page: z.number().int().min(1).optional(), focus: z.string().max(300).optional() }),
      run: async ({ page, focus }, ui) => {
        const s = await ready(ui);
        const target = targetPage(s.pages, page);
        const n = pageNo(target);
        ui.step(`Looking at page ${n}`);
        // The review renders the stored page on the server; the measurement runs here
        // at the same time. Either one alone still answers.
        const lookP = requestPageLook(s.issueId!, target.id, focus?.trim() ? { focus: focus.trim() } : {}).then(
          (r) => ({ ok: true as const, r }),
          (e: unknown) => ({ ok: false as const, error: apiMessage(e, 'The visual review could not run.') }),
        );
        const measured = await pageData(target.id).then(
          (d) => measureSafely(d, ui.signal),
          (e: unknown) => ({ check: null, why: apiMessage(e, 'the page could not be read') }),
        );
        const look = await within(lookP, 90_000, ui.signal, 'the visual review').catch((e: unknown) => {
          if (ui.signal.aborted) throw e;
          return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
        });
        const check = measured.check ?? (look.ok ? look.r.check : null);
        if (!check && !look.ok) throw new Error(`Page ${n} could not be reviewed just now: ${look.error}`);
        const seen = look.ok && look.r.seen;
        const findings = look.ok ? look.r.findings : [];
        const reason = look.ok ? look.r.reason : look.error;
        ui.flash(`mag.page-${n}`);
        return {
          page: n,
          seen,
          findings,
          reason: seen ? undefined : reason,
          pageCheck: check ?? undefined,
          note: seen
            ? findings.length > 0
              ? 'If the user asked about this page, tell them what was found. Fix only what their request covers (magazine.askStudio naming the element in words and what to change); for anything else, ask first.'
              : 'The visual review found nothing wrong; pageCheck has the measurements.'
            : `No picture could be reviewed this time (${reason || 'unavailable'}) — pageCheck is measured from the page itself and still applies.`,
        };
      },
    },
  );

  // ── Charts drawn from numbers ────────────────────────────────────────────
  useAgentAction(
    {
      name: 'magazine.addChart',
      description:
        "Draw a chart, graph or table from EXACT numbers and place it on a page (default: the open page) — drawn from the data, never imagined by an image model. chart = { type: 'bar' | 'barh' (long labels, rankings) | 'line' | 'pie' | 'donut' | 'table', title?, subtitle?, source?, categories: [labels], series: [{ name, values: [one number per category] }], unit?: { prefix?, suffix? }, decimals?, showValues?, highlight?: a category, stacked? }. replace = id of an element to put it in place of (from magazine.checkPage); otherwise it goes into an empty picture slot or the largest free area, on top. One undo. Returns dataEcho (every number as drawn — compare it with the user's numbers) and pageCheck.",
      args: z.object({
        page: z.number().int().min(1).optional(),
        chart: chartSpecArgs,
        replace: z.string().min(1).optional(),
      }),
      run: async ({ page, chart, replace }, ui) => {
        const s = await ready(ui);
        const summary = targetPage(s.pages, page);
        // A contributor's submitted/approved page: the server refuses every write.
        const lock = pageLockReason(summary);
        if (lock) throw new Error(lock);
        const target = page ? await openPageN(ui, page) : summary;
        const n = pageNo(target);
        if (replace && !get().page?.elements.some((e) => e.id === replace)) {
          throw new Error(`The element to replace is not on page ${n} — call magazine.checkPage for the current element ids.`);
        }
        ui.step(`Drawing the chart from the numbers${chart.title ? `: ${clip(chart.title, 60)}` : ''}`);
        let result: ChartResult;
        try {
          result = await createChart(s.issueId!, target.id, { chart, ...(replace ? { replaceElementId: replace } : {}) });
        } catch (e) {
          if (ui.signal.aborted) throw e;
          // A 400 names the part of the data to fix; a 503 says drawing is down.
          throw new Error(apiMessage(e, 'The chart could not be drawn.'));
        }
        chartSpecs.set(result.asset.id, result.chart ? (chartSpecArgs.safeParse(result.chart).data ?? chart) : chart);
        ui.step(`Placing it on page ${n}`);
        // With no `replace`, the server may still have put it into an empty picture slot
        // (it says which); that slot is then patched rather than covered.
        const elementId = await placeChart(ui, target, result, replace ?? result.replaceElementId);
        const measured = await measureOpenPage(ui.signal, target.id);
        return {
          page: n,
          elementId,
          replaced: replace || result.replaceElementId ? true : undefined,
          dataEcho: result.dataEcho,
          alt: result.asset.alt,
          pageCheck: measured.check ?? undefined,
          undo: 'One magazine.undo takes the chart back.',
          note: `${appliedNote(measured.check, measured.why)} Compare dataEcho with the user's numbers; to change one, use magazine.editChart.`,
        };
      },
    },
    canEdit,
  );

  useAgentAction(
    {
      name: 'magazine.editChart',
      description:
        "Change a chart placed earlier (elementId from magazine.checkPage or the addChart result; page = its page, default the open one). changes = any chart field to replace (type, title, subtitle, source, categories together with series, unit, decimals, showValues, highlight, stacked; an empty title removes it) and/or setValues: [{ category, series?, value }] to change single numbers ('change 2023 to 14'). Redraws it in the same place. Returns dataEcho and pageCheck.",
      args: z.object({
        page: z.number().int().min(1).optional(),
        elementId: z.string().min(1),
        changes: z.record(z.string(), z.unknown()),
      }),
      run: async ({ page, elementId, changes }, ui) => {
        const s = await ready(ui);
        const summary = targetPage(s.pages, page);
        const lock = pageLockReason(summary);
        if (lock) throw new Error(lock);
        const target = page ? await openPageN(ui, page) : summary;
        const n = pageNo(target);
        const el = get().page?.id === target.id ? get().page!.elements.find((e) => e.id === elementId) : undefined;
        if (!el) throw new Error(`That chart is not on page ${n} — call magazine.checkPage for the current element ids.`);
        if (el.type !== 'image' || !el.image?.assetId) {
          throw new Error('That element is not a chart — pass the id of a chart picture (magazine.checkPage labels it by its alt, e.g. “Bar chart — …”).');
        }
        const spec = await storedChartSpec(s.issueId!, el.image.assetId);
        // Merged HERE when the numbers are known, so a bad change is refused before any
        // drawing. When they cannot be read back in this browser, the server redraws it
        // from the spec it stored with the picture (editElementId + changes): it applies
        // the same changes, and refuses with a 400 if the picture is not a drawn chart.
        const merged = spec ? mergeChartChanges(spec, changes) : null;
        if (merged && !merged.ok) throw new Error(merged.error);
        ui.step('Redrawing the chart with the new numbers');
        let result: ChartResult;
        try {
          result = await createChart(
            s.issueId!,
            target.id,
            merged?.ok ? { chart: merged.spec, replaceElementId: elementId } : { editElementId: elementId, changes },
          );
        } catch (e) {
          if (ui.signal.aborted) throw e;
          if (!merged && e instanceof ApiError && e.status === 400 && /not a chart/i.test(e.message)) {
            throw actionError('The numbers behind that chart could not be read back, so it cannot be edited in place.', {
              next: `Redraw it with magazine.addChart { page: ${n}, replace: ${JSON.stringify(elementId)}, chart: <the whole chart with the change> } using the numbers from this conversation (ask the user for any you do not have).`,
            });
          }
          throw new Error(apiMessage(e, 'The chart could not be redrawn.'));
        }
        const drawnSpec = result.chart ? chartSpecArgs.safeParse(result.chart).data : undefined;
        const kept = drawnSpec ?? (merged?.ok ? merged.spec : undefined);
        if (kept) chartSpecs.set(result.asset.id, kept);
        const id = await placeChart(ui, target, result, elementId);
        const measured = await measureOpenPage(ui.signal, target.id);
        return {
          page: n,
          elementId: id,
          dataEcho: result.dataEcho,
          alt: result.asset.alt,
          pageCheck: measured.check ?? undefined,
          undo: 'One magazine.undo puts the previous chart back.',
          note: `${appliedNote(measured.check, measured.why)} Compare dataEcho with what the user asked for.`,
        };
      },
    },
    canEdit,
  );

  // ── Word and name swaps across the magazine (C17) ────────────────────────
  useAgentAction(
    {
      name: 'magazine.replaceText',
      description:
        "Replace a word, name or figure in the text of EVERY page you can edit (e.g. find 'NZTROF', replace 'NOG'; replace '' deletes it). Counts the matches first and asks the user with the count per page; then only the matching words change — no paragraph is retyped. matchCase defaults to true, wholeWord to false. Returns the count per page and pageChecks for the changed pages. Use it for every word or name swap, not askStudio.",
      args: z.object({
        find: z
          .string()
          .min(1)
          .max(200)
          .refine((t) => t.trim().length > 0, 'find is empty'),
        replace: z.string().max(500),
        matchCase: z.boolean().optional(),
        wholeWord: z.boolean().optional(),
      }),
      run: async ({ find, replace, matchCase, wholeWord }, ui) => {
        const s = await ready(ui);
        const issueId = s.issueId!;
        if (find === replace) return { found: 0, replaced: 0, note: 'find and replace are the same — nothing to change.' };
        const body = { find, replace, ...(matchCase !== undefined ? { matchCase } : {}), ...(wholeWord !== undefined ? { wholeWord } : {}) };
        const numberOf = (p: { pageId: string; pageNumber: number }) => pageNoOf(get().pages, p.pageId) ?? p.pageNumber;

        // 1) Count first — nothing changes until the user has seen where.
        ui.step(`Looking for “${clip(find, 40)}” on every page`);
        let dry: Awaited<ReturnType<typeof requestReplaceText>>;
        try {
          dry = await requestReplaceText(issueId, { ...body, dryRun: true });
        } catch (e) {
          if (ui.signal.aborted) throw e;
          throw new Error(apiMessage(e, 'The pages could not be searched just now.'));
        }
        const found = dry.pages.filter((p) => p.count > 0).map((p) => ({ page: numberOf(p), count: p.count }));
        // Three things the server counts apart: matches inside LOCKED BOXES on pages that
        // can be edited (skippedLocked), matches in boxes too full for the longer text
        // (skippedTooLong: writing them would cut the end of the copy at the stored-HTML
        // limit), and pages that cannot be edited right now — submitted, approved, being
        // rebuilt (blocked). Each is said as what it is, before anything changes.
        const skippedLocked = dry.pages.reduce((sum, p) => sum + (p.skippedLocked ?? 0), 0);
        const drySkippedTooLong = dry.pages.reduce((sum, p) => sum + (p.skippedTooLong ?? 0), 0);
        const dryBlocked = (dry.blocked ?? []).map((b) => ({ page: numberOf(b), count: b.count, reason: b.reason }));
        const leftAlone = replaceLeftAlone(skippedLocked, dryBlocked, drySkippedTooLong);
        if (dry.total === 0) {
          return {
            found: 0,
            replaced: 0,
            skippedLocked: skippedLocked || undefined,
            skippedTooLong: drySkippedTooLong || undefined,
            blocked: dryBlocked.length > 0 ? dryBlocked : undefined,
            note:
              `“${find}” is not in the text of any page you can edit right now${leftAlone.length > 0 ? ` — it IS in: ${leftAlone.join('; ')}` : ''}.` +
              (leftAlone.length === 0 && matchCase !== false ? ' The search matched capitals — try matchCase: false if the user typed it differently.' : ''),
          };
        }

        // 2) The user's OK, with the count per page and what is left alone.
        const ok = await ui.confirm(
          replaceQuestion(find, replace, found, { matchCase, wholeWord, skippedLocked, skippedTooLong: drySkippedTooLong, blocked: dryBlocked }),
        );
        if (!ok) {
          return { found: dry.total, pages: found, applied: false, declined: true, note: 'The user declined — nothing was changed. Do not retry unless they ask.' };
        }

        // 3) Replace, then show the changed pages as they now are.
        ui.step(`Replacing “${clip(find, 40)}” on ${pageListLabel(found.map((f) => f.page))}`);
        // Through the store, not the API alone: besides re-reading the magazine and the
        // open page, it drops undo entries on the rewritten pages. An entry restores a
        // WHOLE element as it was, so undoing an older edit there would quietly put the
        // replaced word back. A refusal comes back as its toast, in the server's words.
        const replaceToasts = watchToasts();
        let res: Awaited<ReturnType<ReturnType<typeof get>['replaceTextInMagazine']>>;
        try {
          res = await get().replaceTextInMagazine({ ...body, dryRun: false });
        } finally {
          replaceToasts.stop();
        }
        if (!res) throw new Error(firstError(replaceToasts.peek()) || 'The replace did not go through.');
        const changed = res.pages.filter((p) => p.count > 0);
        const openId = get().currentPageId;
        for (const p of changed) {
          if (p.pageId !== openId) get().ensureThumb(p.pageId);
          ui.flash(`mag.page-${numberOf(p)}`);
        }

        // 4) Measure what changed: a longer name can push copy out of its box.
        const MEASURE_PAGES = 6;
        const pageChecks: Array<
          { page: number; ok: boolean; summary: string; errors: PageCheck['issues'] } | { page: number; notMeasured: string }
        > = [];
        for (const p of changed.slice(0, MEASURE_PAGES)) {
          const n = numberOf(p);
          ui.step(`Measuring page ${n}`);
          const data = await pageData(p.pageId).catch(() => null);
          const m = await measureSafely(data, ui.signal);
          pageChecks.push(
            m.check
              ? { page: n, ok: m.check.ok, summary: m.check.summary, errors: m.check.issues.filter((i) => i.severity === 'error').slice(0, 4) }
              : { page: n, notMeasured: m.why || 'unknown reason' },
          );
        }
        const withErrors = pageChecks.flatMap((c) => ('errors' in c && c.errors.length > 0 ? [c.page] : []));
        const unmeasured = [
          ...pageChecks.flatMap((c) => ('notMeasured' in c ? [c.page] : [])),
          ...changed.slice(MEASURE_PAGES).map(numberOf),
        ];
        const short = res.total < dry.total ? ` ${dry.total - res.total} of the ${dry.total} matches were not changed (a page changed meanwhile, or could not be edited — see what was left alone) — run it again to catch the ones a change got in the way of.` : '';
        // Changes waiting for Apply were rewritten too, so applying them later cannot put
        // the old words back.
        const waitingNote = res.waitingUpdated ? ` ${changeCount(res.waitingUpdated)} waiting for Apply got the same replacement.` : '';
        // Pages left as they were, and why: submitted/approved pages are counted, never
        // changed; a page edited twice under the replace is skipped rather than guessed.
        // A page that started rebuilding between the count and the write comes back in
        // `blocked` with reason 'page-rebuilding' from the write retry, not only from the
        // first read — it is listed with the others.
        const blocked = (res.blocked ?? []).map((b) => ({ page: numberOf(b), count: b.count, reason: b.reason }));
        const conflicts = (res.conflicts ?? []).map((c) => numberOf(c));
        // The write re-counts against the page as it then is, so its own figure wins.
        const skippedTooLong = res.pages.reduce((sum, p) => sum + (p.skippedTooLong ?? 0), 0);
        const leftAfter = replaceLeftAlone(undefined, blocked, skippedTooLong);
        const leftAloneNote = leftAfter.length > 0 ? ` Left alone: ${leftAfter.join('; ')}.` : '';
        return {
          replaced: res.total,
          found: dry.total,
          applied: res.applied,
          pages: changed.map((p) => ({ page: numberOf(p), count: p.count })),
          skippedLocked: skippedLocked || undefined,
          skippedTooLong: skippedTooLong || undefined,
          blocked: blocked.length > 0 ? blocked : undefined,
          notChangedBecauseEditedMeanwhile: conflicts.length > 0 ? conflicts : undefined,
          waitingChangesUpdated: res.waitingUpdated || undefined,
          pageChecks,
          fixEstimate: withErrors.length > 0 ? fixEstimate(withErrors.length).text : undefined,
          undo: `Not on the undo stack — to reverse it, call magazine.replaceText with find ${JSON.stringify(replace)} and replace ${JSON.stringify(find)}.`,
          note:
            `Applied and measured — see pageChecks.${short}${leftAloneNote}${waitingNote}` +
            (withErrors.length > 0
              ? ` Problems measured on ${pageListLabel(withErrors)}. Do NOT fix them unasked: tell the user in one short list, with fixEstimate's time and cost for those pages, and ask (offer_choices: Fix them / Not now). If they agree, call magazine.fixPages with those pages.`
              : ' No errors on the measured pages.') +
            (unmeasured.length > 0 ? ` Not measured: ${pageListLabel(unmeasured)} — call magazine.checkPage on them.` : ''),
        };
      },
    },
    canEdit,
  );

  // ── Publishing ───────────────────────────────────────────────────────────
  useAgentAction(
    {
      name: 'magazine.publish',
      description:
        'Publish (or republish) to the public Bulletins newsstand: the full edition, or only the given 1-based pages (through "Publish selected pages…"). Refused with the reason when pages still need approval.',
      args: z.object({ pages: z.array(z.number().int().min(1)).min(1).optional() }),
      confirm: ({ pages }) => {
        const s = get();
        // run() refuses these before touching anything — no pointless card: a build
        // or a publish running, a page that isn't there, pages still awaiting approval.
        if (isBuilding() || s.publishing || (pages && pages.some((n) => !s.pages.some((p) => pageNo(p) === n)))) return null;
        if (publishRefusal(pages)) return null;
        const verb = isLiveIssue(s.issue) ? 'Republish' : 'Publish';
        const what = pages ? pageListLabel(pages) : `all ${s.pages.length} page${s.pages.length === 1 ? '' : 's'}`;
        return `${verb} ${what} of “${s.issue?.title ?? 'this magazine'}” to Bulletins? It will be public.`;
      },
      run: async ({ pages }, ui) => {
        const s = await ready(ui);
        if (isBuilding()) throw new Error('Pages are still being built — publish once the build finishes (a [job-update] message arrives when it does).');
        if (s.publishing) throw new Error('A publish is already running — wait for it to finish.');
        if (pages) for (const n of pages) pageAt(s.pages, n);
        // The server's approval gate, checked BEFORE ticking anything: the selected
        // path writes each page's publish tick, and those writes must not happen for
        // a publish that is then refused.
        const refusal = publishRefusal(pages);
        if (refusal) throw new Error(refusal);
        assertEnabled('mag.publish-button', 'Publishing is not available right now.');
        // A REPUBLISH that fails leaves the magazine 'published', so success is
        // judged by what the studio SAID (its success / error toast) and what moved.
        const was = { live: isLiveIssue(s.issue), id: s.issue?.publishedIssueId, at: s.issue?.publishedAt };
        const toasts = watchToasts();
        let seen: SeenToast[] = [];
        try {
          if (!pages) {
            await openMenu(ui, 'mag.publish-button', 'mag.publish-full', 'Publish');
            assertEnabled('mag.publish-full', 'The full edition cannot be published right now.');
            await ui.click('mag.publish-full', 'Publish full edition');
          } else {
            await openMenu(ui, 'mag.publish-button', 'mag.publish-selected', 'Publish');
            assertEnabled('mag.publish-selected', 'Selected pages cannot be published right now.');
            await ui.click('mag.publish-selected', 'Publish selected pages…');
            await ui.waitFor('mag.publish-dialog', 4000);
            const want = new Set(pages);
            ui.step(`Ticking ${pageListLabel(pages)}`);
            // Boxes are anchored by REAL page number (PublishDialog: index + 1). Each
            // tick is its own server write whose reply REPLACES the page list, so they
            // go one at a time: overlapping replies could land out of order and undo a
            // tick that was already saved.
            for (const n of get().pages.map(pageNo)) {
              const box = anchor(`mag.publish-page-${n}`) as HTMLInputElement | null;
              if (box && box.checked !== want.has(n)) {
                // The tick sets an optimistic list; the server's reply (or a rollback +
                // error toast) then replaces it again — that is the save landing.
                const lists = watchPageList();
                try {
                  await ui.click(`mag.publish-page-${n}`, `Page ${n}`);
                  await softWait(ui, () => lists.count() >= 2 || !!firstError(toasts.peek()), 10_000);
                } finally {
                  lists.stop();
                }
                const err = firstError(toasts.peek());
                if (err) throw new Error(err);
              }
            }
            await waitUntil(() => get().pages.every((p) => p.selectedForPublish === want.has(pageNo(p))), {
              signal: ui.signal,
              what: 'the page selection to save',
            });
            assertEnabled('mag.publish-confirm', 'Those pages cannot be published yet.');
            await ui.click('mag.publish-confirm', 'Publish');
          }

          ui.step('Publishing to Bulletins');
          await softWait(ui, () => get().publishing || toasts.peek().length > 0, 3000);
          await waitUntil(() => !get().publishing, { signal: ui.signal, timeoutMs: 180_000, what: 'publishing to finish' });
          // The success toast ("Published … to Bulletins.") follows the store's reply.
          await softWait(ui, () => toasts.peek().some((t) => /published/i.test(t.text)) || !!firstError(toasts.peek()), 2000);
        } finally {
          seen = toasts.stop();
        }
        const issueAfter = get().issue;
        const err = firstError(seen);
        if (err) throw new Error(`${was.live ? 'Republishing' : 'Publishing'} failed: ${err}`);
        const said = seen.some((t) => /published/i.test(t.text));
        const moved = !!issueAfter?.publishedIssueId && (issueAfter.publishedIssueId !== was.id || issueAfter.publishedAt !== was.at);
        if (!issueAfter || !isLiveIssue(issueAfter) || !(said || moved || !was.live)) {
          throw new Error(`${was.live ? 'Republishing' : 'Publishing'} failed — see the message on screen.`);
        }
        return {
          published: true,
          republished: was.live || undefined,
          scope: pages ? 'selected' : 'full',
          pages: pages ? [...pages].sort((a, b) => a - b) : 'all',
          publishedIssueId: issueAfter.publishedIssueId,
          publicRoute: `/bulletins/${issueAfter.publishedIssueId}`,
        };
      },
    },
    isOwner && mayPublish,
  );

  useAgentAction(
    {
      name: 'magazine.unpublish',
      description: 'Take the live edition off the Bulletins newsstand (the draft is kept).',
      args: z.object({}),
      // Not published → run() refuses before touching anything; no card.
      // LIVE is publishedIssueId AND status 'published': unpublish keeps the id (for a
      // one-click re-publish) and sets status back to 'ready'. Testing the id alone
      // offered to unpublish a pulled magazine and reported a SUCCESSFUL unpublish
      // as "Unpublish failed".
      confirm: () =>
        isLiveIssue(get().issue) ? `Unpublish “${get().issue?.title ?? 'this magazine'}” from Bulletins? Readers will no longer see it.` : null,
      run: async (_a, ui) => {
        const s = await ready(ui);
        if (!isLiveIssue(s.issue)) throw new Error('This magazine is not published.');
        if (s.publishing) throw new Error('A publish is already running — wait for it to finish.');
        await openMenu(ui, 'mag.publish-button', 'mag.unpublish', 'Publish');
        assertEnabled('mag.unpublish', 'Unpublish is not available right now.');
        const toasts = watchToasts();
        try {
          await ui.click('mag.unpublish', 'Unpublish');
          await softWait(ui, () => get().publishing || toasts.peek().length > 0, 3000);
          await waitUntil(() => !get().publishing, { signal: ui.signal, timeoutMs: 60_000, what: 'unpublishing to finish' });
        } finally {
          toasts.stop();
        }
        // Judged by the LIVE rule (see above), never by publishedIssueId alone.
        if (isLiveIssue(get().issue)) throw new Error(`Unpublish failed${firstError(toasts.peek()) ? `: ${firstError(toasts.peek())}` : ' — see the message on screen.'}`);
        return { published: false, status: get().issue?.status };
      },
    },
    isOwner && mayPublish,
  );

  // ── Build progress ───────────────────────────────────────────────────────
  useAgentAction({
    name: 'magazine.waitForGeneration',
    description:
      'OPTIONAL. Builds already report back by themselves with a [job-update] message. Use this only to glance at a build in progress: follows it for at most 60 seconds, then returns the current progress and its jobId.',
    args: z.object({}),
    run: async (_a, ui) => {
      await ready(ui);
      if (!isBuilding()) {
        const s = get();
        return { building: false, status: s.issue?.status, pageCount: s.pages.length, error: s.issue?.processingError || undefined };
      }
      // Make sure the build is watched in the background (a build the user
      // started by hand has no job yet), so a [job-update] comes either way.
      const first = get();
      const magId = first.issueId;
      // Re-joins the running job for this magazine if there is one (same id).
      // An add-pages run needs its starting count, or a first poll that lands before
      // the server flips to 'processing' reads as "finished, nothing added".
      const job = magId
        ? startMagazineBuildJob({
            magazineId: magId,
            title: first.issue?.title,
            mode: first.adding ? 'add' : 'new',
            pageCountBefore: first.adding ? first.pages.length : undefined,
          })
        : null;
      const end = Date.now() + 60_000;
      let lastPhase = '';
      try {
        while (isBuilding()) {
          const s = get();
          const b = buildStatus(s.issue, s.adding);
          if (b.phase !== lastPhase) {
            lastPhase = b.phase;
            ui.step(b.headline);
          }
          ui.progress(b.count ? { label: 'Building pages', done: b.count.done, total: b.count.total } : null);
          if (Date.now() > end) {
            return {
              building: true,
              jobId: job?.id,
              headline: b.headline,
              done: b.count?.done ?? null,
              total: b.count?.total ?? null,
              pageCount: s.pages.length,
              note: JOB_STARTED_NOTE,
            };
          }
          await sleep(1000, ui.signal);
        }
      } finally {
        ui.progress(null);
      }
      // The model just saw it finish here — its [job-update] would only repeat it.
      // Let the watch notice the end first (it polls every few seconds): a watch
      // left "running" but marked delivered would adopt the NEXT build and swallow
      // that build's [job-update].
      if (job && magId) {
        await settlePreviousBuildJob(magId, ui.signal);
        useOperatorJobs.getState().markDelivered(magazineBuildJobId(magId));
      }
      const s = get();
      return {
        building: false,
        status: s.issue?.status,
        pageCount: s.pages.length,
        error: s.issue?.status === 'failed' || s.issue?.processingError ? s.issue?.processingError || 'The build failed.' : undefined,
      };
    },
  });

  // ── Per-page AI wands (Fill / Adjust above every page on the canvas) ──────
  useAgentAction(
    {
      name: 'magazine.fillPage',
      description:
        "Press the page's Fill wand (above the page on the canvas): AI writes copy into empty text boxes and tightens crowded text. Waits for it; returns the text blocks it changed and the page measured afterwards (pageCheck). Undoable with magazine.undo.",
      args: z.object({ page: z.number().int().min(1) }),
      run: async ({ page }, ui) => runPageFormat(ui, 'fill', page),
    },
    canEdit,
  );

  useAgentAction(
    {
      name: 'magazine.adjustPage',
      description:
        "Press the page's Adjust wand (above the page on the canvas): AI tightens crowded / overflowing text and re-balances an AI-built layout, without filling empty boxes. Waits for it; returns what changed and the page measured afterwards (pageCheck). Undoable with magazine.undo.",
      args: z.object({ page: z.number().int().min(1) }),
      run: async ({ page }, ui) => runPageFormat(ui, 'adjust', page),
    },
    canEdit,
  );

  // ── The "publish" tick in each page's canvas header ──────────────────────
  useAgentAction(
    {
      name: 'magazine.setPageInPublish',
      description:
        'Tick or untick the "publish" box above a page on the canvas — whether it is included when publishing SELECTED pages (a full-edition publish always includes every page).',
      args: z.object({ page: z.number().int().min(1), include: z.boolean() }),
      run: async ({ page, include }, ui) => {
        const s = await ready(ui);
        const target = pageAt(s.pages, page);
        const selected = () => get().pages.filter((p) => p.selectedForPublish).map((p) => pageNo(p));
        if (target.selectedForPublish === include) return { page, included: include, changed: false, selectedPages: selected() };
        const box = `mag.page-${page}-publish-toggle`;
        await ui.waitFor(box, 5000);
        const value = () => get().pages.find((p) => p.id === target.id)?.selectedForPublish;
        const toasts = watchToasts();
        const lists = watchPageList();
        let seen: SeenToast[] = [];
        try {
          await ui.click(box, include ? `Include page ${page} when publishing` : `Leave page ${page} out of selected publishing`);
          // The tick is optimistic; the server's page list (or a rollback) then
          // REPLACES the array again — that second replacement is the save landing.
          await softWait(ui, () => lists.count() >= 2 || errorToasts(toasts.peek()).length > 0, 15_000);
        } finally {
          lists.stop();
          seen = toasts.stop();
        }
        if (value() !== include) {
          throw new Error(errorToasts(seen).map((t) => t.text).join(' ') || `Page ${page}'s publish selection did not save.`);
        }
        ui.flash(box);
        return { page, included: include, changed: true, selectedPages: selected() };
      },
    },
    isOwner,
  );

  // ── Toolbar: undo / redo / zoom ──────────────────────────────────────────
  useAgentAction(
    {
      name: 'magazine.undo',
      description: "Press Undo in the studio toolbar (Ctrl+Z): takes back the last edit — one whole AI apply or Fill/Adjust pass counts as one. Page deletions can't be undone.",
      args: z.object({}),
      run: async (_a, ui) => runHistory(ui, 'undo'),
    },
    canEdit,
  );

  useAgentAction(
    {
      name: 'magazine.redo',
      description: 'Press Redo in the studio toolbar: re-applies the last undone edit.',
      args: z.object({}),
      run: async (_a, ui) => runHistory(ui, 'redo'),
    },
    canEdit,
  );

  useAgentAction({
    name: 'magazine.zoom',
    description: "Zoom the canvas with the toolbar's − / + buttons: action 'in' | 'out' for one step, or percent (about 22–110) to step to the nearest level. Returns the zoom %.",
    args: z.object({ percent: z.number().min(10).max(200).optional(), action: z.enum(['in', 'out']).optional() }),
    run: async ({ percent, action }, ui) => {
      await ready(ui);
      const before = zoomPercent();
      const step = async (dir: 'in' | 'out') => {
        const w = get().zoomWidth;
        await revealToolbarItem(ui, `mag.zoom-${dir}`); // phone: in the More menu (stays open between steps)
        await ui.click(`mag.zoom-${dir}`, dir === 'in' ? 'Zoom in' : 'Zoom out');
        await softWait(ui, () => get().zoomWidth !== w, 1000);
        return get().zoomWidth !== w;
      };
      if (action) await step(action);
      if (percent !== undefined) {
        // Same clamp as the store's setZoomWidth; each click is ±80px of page width.
        const want = Math.max(280, Math.min(1400, Math.round((percent / 100) * 1275)));
        for (let i = 0; i < 25; i++) {
          const diff = want - get().zoomWidth;
          if (Math.abs(diff) <= 40) break;
          if (!(await step(diff > 0 ? 'in' : 'out'))) break; // at the limit
        }
      }
      ui.flash('mag.zoom-level');
      return { zoomPercent: zoomPercent(), before, note: !action && percent === undefined ? 'Pass action or percent to change it.' : undefined };
    },
  });

  // ── Cover image (More ▸ Cover image…) ────────────────────────────────────
  useAgentAction(
    {
      name: 'magazine.setCover',
      description:
        "Set the cover shown on the Bulletins newsstand card through the Cover dialog: page (use that page's picture), imageUrl (an https image), or reset:true (automatic, from page 1). Exactly one.",
      args: z.object({
        page: z.number().int().min(1).optional(),
        imageUrl: z.string().url().optional(),
        reset: z.boolean().optional(),
      }),
      run: async ({ page, imageUrl, reset }, ui) => {
        const s = await ready(ui);
        const chosen = [page !== undefined, !!imageUrl, !!reset].filter(Boolean).length;
        if (chosen !== 1) throw new Error('Give exactly one of page, imageUrl or reset:true.');
        if (page !== undefined) pageAt(s.pages, page);
        if (reset && !s.issue?.coverImage) return { coverImage: null, automatic: true, changed: false };

        if (!anchor('mag.cover-dialog')) {
          ui.step('Opening the Cover dialog');
          await openMenu(ui, 'mag.more-button', 'mag.cover-button', 'More');
          await ui.click('mag.cover-button', 'Cover image…');
          await ui.waitFor('mag.cover-dialog', 4000);
        }
        const coverBefore = s.issue?.coverImage ?? '';
        const toasts = watchToasts();
        let seen: SeenToast[] = [];
        try {
          if (reset) {
            await ui.click('mag.cover-reset', 'Reset to automatic');
            await settle(ui, 'mag.cover-dialog', () => !get().issue?.coverImage, 'the cover to reset');
          } else {
            if (page !== undefined) {
              await ui.click('mag.cover-tab-pages', 'Pages');
              await ui.waitFor(`mag.cover-page-${page}`, 3000);
              await ui.click(`mag.cover-page-${page}`, `Page ${page}`);
            } else {
              await ui.click('mag.cover-tab-upload', 'Upload / URL');
              await ui.type('mag.cover-url', imageUrl!, { clear: true });
              await ui.click('mag.cover-url-set', 'Set');
            }
            // Success closes the dialog; a refusal leaves it open with a toast.
            await settle(ui, 'mag.cover-dialog', () => !anchor('mag.cover-dialog'), 'the cover to save');
          }
          await softWait(ui, () => toasts.peek().length > 0, 1500);
        } finally {
          seen = toasts.stop();
        }
        const errs = errorToasts(seen);
        const after = get().issue?.coverImage ?? '';
        const ok = reset ? !after : !anchor('mag.cover-dialog') && errs.length === 0;
        await clickIfPresent(ui, 'mag.cover-close', 'Close');
        if (!ok) throw new Error(errs.map((t) => t.text).join(' ') || 'The cover was not changed — see the message on screen.');
        return { coverImage: after || null, automatic: !after, changed: after !== coverBefore || !!reset, messages: toastLines(seen) };
      },
    },
    isOwner,
  );

  // ── Review board ─────────────────────────────────────────────────────────
  useAgentAction(
    {
      name: 'magazine.openReviewBoard',
      description:
        'Open the review board (pages in progress / needs changes / submitted / approved). Returns the pages in each column and which ones you can tick. Only offered when someone else works on the magazine.',
      args: z.object({}),
      run: async (_a, ui) => {
        await ready(ui);
        await openReviewBoard(ui, live.current.isOwner);
        return boardSummary();
      },
    },
    // A read: anyone the magazine is shared with (or its owner) can look.
    perms.canEdit,
  );

  useAgentAction(
    {
      name: 'magazine.reviewPages',
      description:
        "On the review board: owner → action 'approve' or 'sendBack' (note required) on submitted pages; collaborator → 'submit' finished pages to the owner. Ticks exactly those pages, writes the note, presses the button. Emails the people involved.",
      args: z.object({
        action: z.enum(['approve', 'sendBack', 'submit']),
        pages: z.array(z.number().int().min(1)).min(1),
        note: z.string().max(2000).optional(),
      }),
      confirm: ({ action, pages, note }) => {
        const s = get();
        // Moves run() refuses before touching anything get no card: the wrong
        // action for your role, sendBack without a note, a page that isn't there,
        // or a page the board won't let you tick (e.g. approving an in-progress page).
        if ((action === 'submit') === live.current.isOwner) return null;
        if (action === 'sendBack' && !note?.trim()) return null;
        const tickable = reviewTickable(live.current.isOwner);
        if (pages.some((n) => !s.pages.some((p) => pageNo(p) === n && tickable.has(p.id)))) return null;
        const what = pageListLabel(pages);
        const title = s.issue?.title ?? 'this magazine';
        if (action === 'approve') return `Approve ${what} of “${title}”? Whoever worked on ${pages.length === 1 ? 'it' : 'them'} is emailed.`;
        if (action === 'sendBack') return `Send ${what} of “${title}” back for changes with your note? Whoever worked on ${pages.length === 1 ? 'it' : 'them'} is emailed.`;
        return `Submit ${what} of “${title}” to the owner for review? The owner is emailed, and the ${pages.length === 1 ? 'page locks' : 'pages lock'} until reviewed.`;
      },
      run: async ({ action, pages, note }, ui) => {
        const s = await ready(ui);
        const owner = live.current.isOwner;
        if ((action === 'submit') === owner) {
          throw new Error(
            owner
              ? "As the owner you 'approve' or 'sendBack' pages — 'submit' is for collaborators."
              : "Only the magazine's owner approves or sends back pages — you can 'submit' yours for review.",
          );
        }
        if (action === 'sendBack' && !note?.trim()) throw new Error('Sending pages back needs a note saying what to change.');
        const want = new Set(pages);
        const ids = new Map([...want].map((n) => [n, pageAt(s.pages, n).id]));
        const verbed = action === 'approve' ? 'approved' : action === 'sendBack' ? 'sent back' : 'submitted';
        // Same rule as the board's tick boxes — refused BEFORE opening anything
        // (the confirm card above was not shown for these either).
        const tickable = reviewTickable(owner);
        const notTickable = [...want].filter((n) => !tickable.has(ids.get(n)!)).sort((a, b) => a - b);
        const tickableNums = s.pages.filter((p) => tickable.has(p.id)).map(pageNo);
        if (notTickable.length > 0) {
          throw new Error(
            `${pageListLabel(notTickable)} can't be ${verbed} right now. ` +
              `${owner ? 'Pages waiting for you' : 'Your pages ready to submit'}: ${tickableNums.length ? tickableNums.join(', ') : 'none'}. Board: ${boardSentence() || 'empty'}.`,
          );
        }

        await openReviewBoard(ui, owner);
        const blocked = [...want].filter((n) => !anchor(`mag.review-page-${n}-select`));
        if (blocked.length > 0) {
          const b = boardSummary();
          throw new Error(
            `${pageListLabel(blocked)} can't be ${verbed} right now. ` +
              `Pages you can tick: ${b.tickable.length ? b.tickable.join(', ') : 'none'}. Board: ${boardSentence() || 'empty'}.`,
          );
        }
        ui.step(`Ticking ${pageListLabel(pages)}`);
        // Boxes are anchored by REAL page number (ReviewBoard: index + 1). Looping
        // 1..pages.length missed a page-scoped collaborator's pages entirely (their
        // list is e.g. just page 3), so 'submit' ticked nothing.
        for (const n of get().pages.map(pageNo)) {
          const box = anchor(`mag.review-page-${n}-select`) as HTMLInputElement | null;
          if (box && box.checked !== want.has(n)) await ui.click(`mag.review-page-${n}-select`, `Page ${n}`);
        }
        if (note?.trim()) await ui.type('mag.review-note', note.trim(), { clear: true });

        const btn = action === 'approve' ? 'mag.review-approve' : action === 'sendBack' ? 'mag.review-send-back' : 'mag.review-submit';
        const goal: ReviewColumn = action === 'approve' ? 'approved' : action === 'sendBack' ? 'needs_changes' : 'submitted';
        assertEnabled(btn, 'That review button is not available right now.');
        const toasts = watchToasts();
        let seen: SeenToast[] = [];
        try {
          await ui.click(btn, action === 'approve' ? 'Approve' : action === 'sendBack' ? 'Send back' : 'Submit');
          await softWait(ui, () => get().reviewBusy || toasts.peek().length > 0, 3000);
          await waitUntil(() => !get().reviewBusy, { signal: ui.signal, timeoutMs: 60_000, what: 'the review to save' });
          await softWait(ui, () => toasts.peek().length > 0, 1500);
        } finally {
          seen = toasts.stop();
        }
        const landed = (n: number) => {
          const p = get().pages.find((x) => x.id === ids.get(n));
          return !!p && columnOf(p) === goal && (goal !== 'approved' || !p.approvalStale);
        };
        const moved = [...want].filter(landed).sort((a, b) => a - b);
        const notMoved = [...want].filter((n) => !landed(n)).sort((a, b) => a - b);
        const board = boardSummary();
        if (moved.length === 0) {
          throw new Error(errorToasts(seen).map((t) => t.text).join(' ') || 'Nothing moved on the review board — see the message on screen.');
        }
        await sleep(600, ui.signal);
        await clickIfPresent(ui, 'mag.review-close', 'Close');
        return { action, moved, notMoved, columns: board.columns, messages: toastLines(seen) };
      },
    },
    canEdit,
  );
}
