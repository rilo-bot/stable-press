// ---------------------------------------------------------------------------
// Magazine Builder v2 — wait for a "Copy a page exactly" run to land, then show it.
//
// ONE wait per page, shared. The panel starts it the moment the copy route
// answers; The Stable Hand's magazine.copyPdfPage clicks that same panel and then
// JOINS the wait instead of running a second poll beside it. The wait reads the
// magazine through the store's own refresh (the same GET the studio makes), so the
// rail and the page summaries move with it, and when the copy lands it reloads the
// page on the canvas if that page is still the open one — otherwise the next time
// it is drawn (ensureThumb re-fetches a page whose rev moved).
//
// The rules about when a copy counts as finished live in ./pageCopy (pure).
// ---------------------------------------------------------------------------

import { useEditorStore } from './store';
import type { PageSummary } from './api';
import { COPY_WATCH_MAX_MS, copyPollInterval, copyState, type CopyState } from './pageCopy';

export interface PageCopyOutcome {
  /** 'timeout' = still pending when the watch gave up; 'left' = the user opened
   *  another magazine, so this one is no longer the store's to refresh. */
  state: CopyState | 'timeout' | 'left';
  /** The page's summary as last read (the copied size, its error / notice). */
  summary?: PageSummary;
}

const watches = new Map<string, Promise<PageCopyOutcome>>();

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * After a copy lands: make the studio show it. Re-reads the magazine (summaries,
 * rev) and reloads the page on the canvas when it is the open one; a page that is
 * not open is re-fetched the next time it is drawn, because its summary's rev has
 * moved past the cached copy. A no-op when another magazine is open.
 */
export async function showCopiedPage(issueId: string, pageId: string, opts: { refresh?: boolean } = {}): Promise<void> {
  const st = useEditorStore.getState();
  if (st.issueId !== issueId) return;
  if (opts.refresh !== false) await st.refreshIssue();
  const now = useEditorStore.getState();
  if (now.issueId !== issueId) return;
  if (now.currentPageId === pageId) await now.openPage(pageId, true);
  else now.ensureThumb(pageId);
}

/**
 * Wait until the copy onto `pageId` has landed (or failed), for the magazine open
 * in the studio right now. A second caller for the same page joins the first
 * wait. `revBefore` is the page's rev before the copy was asked for.
 */
export function watchPageCopy(pageId: string, revBefore: number | undefined, opts: { maxMs?: number } = {}): Promise<PageCopyOutcome> {
  const issueId = useEditorStore.getState().issueId;
  if (!issueId) return Promise.resolve({ state: 'left' });
  const key = `${issueId}:${pageId}`;
  const running = watches.get(key);
  if (running) return running;

  const maxMs = opts.maxMs ?? COPY_WATCH_MAX_MS;
  const run = async (): Promise<PageCopyOutcome> => {
    const started = Date.now();
    let seenPending = false;
    // The route marks the page pending before it answers, so the first read is
    // quick; later reads slow down for a copy queued behind other work.
    await delay(1_500);
    for (;;) {
      if (useEditorStore.getState().issueId !== issueId) return { state: 'left' };
      await useEditorStore.getState().refreshIssue();
      const st = useEditorStore.getState();
      if (st.issueId !== issueId) return { state: 'left' };
      const summary = st.pages.find((p) => p.id === pageId);
      if (summary?.status === 'pending') seenPending = true;
      const elapsed = Date.now() - started;
      const state = copyState(summary, { rev: revBefore, seenPending }, elapsed);
      if (state !== 'pending') {
        if (state !== 'gone') await showCopiedPage(issueId, pageId, { refresh: false });
        return { state, summary };
      }
      if (elapsed > maxMs) return { state: 'timeout', summary };
      await delay(copyPollInterval(elapsed));
    }
  };

  const p = run()
    .catch((): PageCopyOutcome => ({ state: 'timeout' }))
    .finally(() => watches.delete(key));
  watches.set(key, p);
  return p;
}

/** The wait already running for this page, if any (no new wait is started). */
export function runningPageCopy(pageId: string): Promise<PageCopyOutcome> | undefined {
  const issueId = useEditorStore.getState().issueId;
  return issueId ? watches.get(`${issueId}:${pageId}`) : undefined;
}
