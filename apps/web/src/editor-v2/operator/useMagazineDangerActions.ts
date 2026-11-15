// ---------------------------------------------------------------------------
// Magazine Builder v2 — Operator DANGER actions for the studio
// (/production-system/magazine-v2/:id). Catalog twin:
// apps/server/src/lib/agent/operator/catalog/magazine.ts ('magazine-editor').
//
// Every one of these is irreversible, and every one is guarded in the app by a
// native window.confirm() — which the Operator cannot click. They drive the REAL
// buttons anyway (THE RULE in agent/operator/contracts.ts): the user OKs the
// Operator's confirm card first, which pre-approves this step
// (runtime/nativeDialogs.ts), so the app's own window.confirm() answers OK while
// the action runs — and only then.
//
//   magazine.deleteMagazine   More ▸ Delete magazine…        (confirm card up front)
//   magazine.startOver        More ▸ Start over…              (confirm card up front)
//   magazine.copyPdfPage      Page panel ▸ Copy a page exactly (card once the PDF
//                             and page are known to be valid). A PDF the user sent
//                             in the Operator chat is saved to the magazine's
//                             Uploads first (`attachment`); the action then waits
//                             for the worker's copy, or hands it to the
//                             'magazine-page-copy' job when it is queued.
//   magazine.applyLayout      Page panel ▸ Match a layout ▸ "Put this page in that
//                             layout" (card once a reading exists). The reference
//                             picture is uploaded FIRST with the `upload` client
//                             tool (agentId 'mag.layout-upload'); calling this
//                             before that opens the panel and says so.
// ---------------------------------------------------------------------------

import { useRef } from 'react';
import { z } from 'zod';
import { useAgentAction } from '@/agent/operator/runtime/registry';
import { actionError } from '@/agent/operator/runtime/humanRef';
import { pickAttachment } from '@/agent/operator/runtime/upload';
import { attachmentToFile, isPdfAttachment, listOperatorAttachments } from '@/agent/operator/runtime/attachmentsStore';
import type { UiDriver } from '@/agent/operator/contracts';
import { useEditorStore } from '../store';
import { uploadMediaDoc, type PageSummary } from '../api';
import { copyFailureText, copyNoticeText, pageSizeNote } from '../pageCopy';
import { runningPageCopy, watchPageCopy } from '../pageCopyWatch';
import { PAGE_COPY_STARTED_NOTE, startPageCopyJob } from './magazineJobs';
import { pageCheckFor } from './actionPageCheck';
import {
  anchor,
  assertEnabled,
  clickIfPresent,
  errorToasts,
  openPageN,
  pageAt,
  pageNo,
  pageNoOf,
  sleep,
  useRoleCanEditMagazines,
  waitUntil,
  watchToasts,
  type SeenToast,
} from './shared';

const get = () => useEditorStore.getState();
const LIBRARY = '/production-system/magazine-v2';
const isBuilding = () => get().generating || get().issue?.status === 'processing';

const DECLINED = 'The user declined — do not retry unless they ask.';
const toastLines = (ts: SeenToast[]) => ts.map((t) => `${t.type}: ${t.text}`);

async function ready(ui: UiDriver) {
  return waitUntil(
    () => {
      const s = get();
      return !s.loading && s.issue ? s : null;
    },
    { signal: ui.signal, timeoutMs: 30_000, what: 'the magazine to load' },
  );
}

/** Open the More menu unless its item is already showing (clicking the trigger
 *  of an open menu would close it). */
async function openMore(ui: UiDriver, item: string) {
  if (anchor(item)) return;
  await ui.click('mag.more-button', 'More');
  await ui.waitFor(item, 4000);
}

const currentPageNumber = () => {
  const s = get();
  return pageNoOf(s.pages, s.currentPageId);
};

/**
 * The right-hand "Page & element" panel showing the PAGE (where "Match a layout"
 * and "Copy a page exactly" live): close an attachment preview, show the pane,
 * clear the selection (an element's panel replaces the page's), pick the tab.
 */
async function ensurePagePanel(ui: UiDriver) {
  if (get().previewDoc) {
    if (!(await clickIfPresent(ui, 'mag.preview-close', 'Close the preview'))) get().setPreviewDoc(null);
    await sleep(200, ui.signal);
  }
  if (!anchor('mag.inspector-tab-element')) {
    await ui.click('mag.inspector-show', 'Show the page panel');
    await ui.waitFor('mag.inspector-tab-element', 4000);
  }
  // Selection is view state (like pressing Esc on the canvas), not a write.
  if (get().selectedId) {
    get().select(null);
    await sleep(200, ui.signal);
  }
  if (anchor('mag.inspector-tab-element')?.getAttribute('aria-pressed') !== 'true') {
    await ui.click('mag.inspector-tab-element', 'Page');
    await sleep(150, ui.signal);
  }
}

/** Hide + show the pane: remounts the panel so its PDF list is fetched again
 *  (it loads once per mount; a PDF attached since then would be missing). */
async function reopenPagePanel(ui: UiDriver) {
  if (await clickIfPresent(ui, 'mag.inspector-hide', 'Hide the page panel')) {
    await sleep(250, ui.signal);
  }
  await ensurePagePanel(ui);
}

/** Wait for an anchor to appear; false (not a throw) when it does not. */
async function appears(ui: UiDriver, agentId: string, timeoutMs: number): Promise<boolean> {
  try {
    await waitUntil(() => !!anchor(agentId), { signal: ui.signal, timeoutMs, what: agentId });
    return true;
  } catch (e) {
    if (ui.signal.aborted) throw e;
    return false;
  }
}

/** A PDF option's file name without the picker's " (12 pages)" suffix. */
const docName = (optionText: string) => optionText.replace(/\s*\(\d+ pages?\)\s*$/, '').trim();

/**
 * Right before pressing a button that acts on "the open page": make sure the open
 * page is still the one the user approved on the confirm card.
 *
 * Copy a page exactly and Match a layout both act on whatever page is open at the
 * moment of the click. The canvas's scroll-settle picker makes the page nearest the
 * middle the open one, so a scroll while the card was up used to send an
 * irreversible rebuild to a neighbouring page (and the panel's own window.confirm,
 * naming that other page, was auto-accepted by the pre-approval). The canvas now
 * holds still while a card is up (EditorCanvas), and this is the backstop: go back
 * to the approved page, let `restore` put the panel's choices back, and refuse if
 * it will not stay there.
 */
async function holdTargetPage(ui: UiDriver, target: PageSummary, n: number, restore?: () => Promise<void>): Promise<void> {
  const onTarget = () => get().currentPageId === target.id && get().page?.id === target.id;
  if (onTarget()) return;
  ui.step(`The canvas moved — going back to page ${n}`);
  await openPageN(ui, n);
  await ensurePagePanel(ui);
  if (restore) await restore();
  if (!onTarget()) {
    throw new Error(`The canvas moved to another page while you were deciding and page ${n} would not stay open — nothing was changed. Try again.`);
  }
}

/** How long copyPdfPage waits for the copy itself before handing it to a job. */
const INLINE_COPY_WAIT_MS = 30_000;

/** `p`'s value if it settles within `ms`, else null; an AbortError on Stop. */
function within<T>(p: Promise<T>, ms: number, signal: AbortSignal): Promise<T | null> {
  return new Promise<T | null>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('The Stable Hand was stopped.', 'AbortError'));
    const done = () => {
      clearTimeout(t);
      signal.removeEventListener('abort', onAbort);
    };
    const t = setTimeout(() => {
      done();
      resolve(null);
    }, ms);
    const onAbort = () => {
      done();
      reject(new DOMException('The Stable Hand was stopped.', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        done();
        resolve(v);
      },
      (e) => {
        done();
        reject(e);
      },
    );
  });
}

interface DangerPerms {
  /** issue.myRole === 'owner' (store.canManage). */
  isOwner: boolean;
  /** staff permission `magazine.delete`. */
  mayDelete: boolean;
}

export function useMagazineDangerActions(perms: DangerPerms): void {
  const live = useRef(perms);
  live.current = perms;
  // Deleting the MAGAZINE is gated on `magazine.delete` alone (server: the one
  // DELETE /issues/:id route); every other action here is a write gated on
  // `magazine.edit` — without it the owner's Start over / Copy / Match a layout
  // would only be refused.
  const roleCanEdit = useRoleCanEditMagazines();
  const { mayDelete } = perms;
  const isOwner = perms.isOwner;
  const ownerCanEdit = perms.isOwner && roleCanEdit;

  // ── Delete the whole magazine ────────────────────────────────────────────
  useAgentAction(
    {
      name: 'magazine.deleteMagazine',
      description:
        'Owner with Magazine delete. Delete this magazine — the draft and all its pages — through More ▸ Delete magazine…; if it is live it also comes off Bulletins. Cannot be undone. Ends back in the library.',
      args: z.object({}),
      confirm: () => {
        const issue = get().issue;
        // The button is disabled while a publish runs — run() refuses; no card.
        if (get().publishing) return null;
        const title = issue?.title ? `“${issue.title}”` : 'this magazine';
        const isLive = !!issue?.publishedIssueId && issue.status === 'published';
        return (
          `Delete ${title}? The draft and all ${get().pages.length} of its pages are removed — this cannot be undone.` +
          (isLive ? ' It is live on Bulletins, so it is taken off the public newsstand too.' : '')
        );
      },
      run: async (_a, ui) => {
        const s = await ready(ui);
        const title = s.issue!.title;
        const id = s.issue!.id;
        ui.step('Opening More ▸ Delete magazine…');
        await openMore(ui, 'mag.delete-magazine');
        assertEnabled('mag.delete-magazine', 'Delete is not available right now (a publish may be running).');
        const toasts = watchToasts();
        try {
          await ui.click('mag.delete-magazine', 'Delete magazine…');
          // Success navigates to the library; a refusal is a toast.
          await waitUntil(
            () => window.location.pathname.replace(/\/+$/, '') === LIBRARY || errorToasts(toasts.peek()).length > 0,
            { signal: ui.signal, timeoutMs: 30_000, what: 'the magazine to be deleted' },
          );
          const seen = toasts.stop();
          const errs = errorToasts(seen);
          if (errs.length) throw new Error(errs.map((t) => t.text).join(' '));
          return { deleted: true, magazineId: id, title, route: LIBRARY, toasts: toastLines(seen) };
        } finally {
          toasts.stop();
        }
      },
    },
    isOwner && mayDelete,
  );

  // ── Start over (reset to one blank page) ─────────────────────────────────
  useAgentAction(
    {
      name: 'magazine.startOver',
      description:
        'Owner only. More ▸ Start over…: reset this magazine to a single blank page. Every page and its content is deleted and the undo history is cleared — cannot be undone.',
      args: z.object({}),
      confirm: () => {
        const s = get();
        // The server refuses a reset while pages are being built — run() says so; no card.
        if (isBuilding()) return null;
        const title = s.issue?.title ? `“${s.issue.title}”` : 'this magazine';
        return `Start ${title} over? All ${s.pages.length} page${s.pages.length === 1 ? '' : 's'} and everything on them are deleted and it is reset to one blank page — this cannot be undone.`;
      },
      run: async (_a, ui) => {
        const before = (await ready(ui)).pages.length;
        if (isBuilding()) throw new Error('Pages are still being built — start over once the build finishes (a [job-update] message arrives when it does).');
        ui.step('Opening More ▸ Start over…');
        await openMore(ui, 'mag.start-over');
        const toasts = watchToasts();
        try {
          await ui.click('mag.start-over', 'Start over…');
          const seen = await waitUntil(
            () => {
              const ts = toasts.peek();
              return ts.some((t) => /reset to a blank page/i.test(t.text)) || errorToasts(ts).length ? ts : null;
            },
            { signal: ui.signal, timeoutMs: 30_000, what: 'the reset to finish' },
          );
          const errs = errorToasts(seen);
          if (errs.length) throw new Error(errs.map((t) => t.text).join(' '));
          return { reset: true, pagesBefore: before, pagesNow: get().pages.length, toasts: toastLines(seen) };
        } finally {
          toasts.stop();
        }
      },
    },
    ownerCanEdit,
  );

  // ── Copy a PDF page exactly onto a page ──────────────────────────────────
  useAgentAction(
    {
      name: 'magazine.copyPdfPage',
      description:
        'Owner only. Page panel ▸ "Copy a page exactly": reproduce page docPage of a PDF (its own text, pictures and colours, as editable elements) onto page `page` (default: the open page), replacing everything on it — the page also takes the PDF page\'s shape. Cannot be undone. A PDF the user sent in THIS chat: pass attachment (0 = their newest file, or its file name) — the action saves it to the magazine\'s Uploads itself and copies from that file (upload on mag.ai-attach only stages a file for the next studio message; it does not store it). A PDF already in the magazine: doc = part of its file name when there are several. Waits for the copy and returns the measured pageCheck, or a jobId (a [job-update] follows) when the copy is queued.',
      args: z.object({
        page: z.number().int().min(1).optional(),
        docPage: z.number().int().min(1),
        doc: z.string().min(1).optional(),
        attachment: z.union([z.number().int().min(0), z.string().min(1)]).optional(),
      }),
      run: async (a, ui) => {
        const s0 = await ready(ui);
        const issueId = s0.issue!.id;
        const target = a.page ? await openPageN(ui, a.page) : pageAt(get().pages, currentPageNumber() ?? 1);
        const n = pageNo(target);

        // THE USER'S PDF, STORED FIRST. The Copy panel lists only what the magazine
        // holds; a file staged in the chat composer is not stored until a studio
        // message is sent, so the old advice (upload on mag.ai-attach) looped on
        // "no PDF attached". This saves it through the same route as the AI
        // Studio's Uploads tab, then picks THAT file by its id — never options[0],
        // which silently copied whatever other PDF the magazine already held.
        let stored: { id: string; name: string } | null = null;
        const storeChatPdf = async (ref: number | string | undefined) => {
          const att = pickAttachment(ref);
          if (!isPdfAttachment(att)) {
            throw new Error(
              `“${att.name}” is not a PDF — only a PDF page can be copied exactly. For a picture, use magazine.applyLayout (its layout) or place it as a photo.`,
            );
          }
          ui.step(`Saving “${att.name}” to the magazine's Uploads`);
          const file = await attachmentToFile(att);
          const up = await uploadMediaDoc(issueId, file, { sourceText: '' });
          return { id: up.id, name: up.originalName || file.name };
        };
        if (a.attachment !== undefined) stored = await storeChatPdf(a.attachment);

        ui.step('Opening Copy a page exactly');
        await ensurePagePanel(ui);
        let found = !stored && (await appears(ui, 'mag.copy-pdf-go', 8000));
        if (!found) {
          // The list loads once per mount — reload it (a PDF attached since, or the one just saved).
          await reopenPagePanel(ui);
          found = await appears(ui, 'mag.copy-pdf-go', 8000);
        }
        if (!found && !stored) {
          // The magazine holds no PDF at all, and the newest file the user sent here
          // is one: that is the PDF they mean. Store it and carry on (the confirm
          // card below still names it before anything is replaced).
          const newest = listOperatorAttachments()[0];
          if (newest && isPdfAttachment(newest)) {
            stored = await storeChatPdf(0);
            await reopenPagePanel(ui);
            found = await appears(ui, 'mag.copy-pdf-go', 8000);
          }
        }
        if (!found) {
          if (stored) {
            throw new Error(`“${stored.name}” was saved to the magazine's Uploads, but the Copy panel does not list it yet — nothing was copied. Try again in a moment.`);
          }
          // The sentence is for the person; the how-to rides in the model-only detail.
          throw actionError('This magazine has no PDF attached yet — nothing was copied.', {
            next:
              'If the user sent the PDF in this chat, call magazine.copyPdfPage again with attachment: 0 (or its file name) — it saves the PDF to the magazine itself. Otherwise ask the user to attach the PDF in this chat.',
          });
        }

        // Which PDF.
        const sel = () => anchor('mag.copy-pdf-doc') as HTMLSelectElement | null;
        // One option per FILE: a PDF stored twice (its chat upload and the source document
        // registered over it) is one option, and the other ids it stands for are on
        // `data-alias-ids` — so the PDF just saved is found by its upload's id too.
        const readOptions = () => {
          const s = sel();
          return s
            ? Array.from(s.options).map((o) => ({
                value: o.value,
                text: (o.textContent ?? '').trim(),
                aliases: (o.getAttribute('data-alias-ids') ?? '').split(' ').filter(Boolean),
              }))
            : [];
        };
        const isOption = (o: { value: string; aliases: string[] }, id: string) => o.value === id || o.aliases.includes(id);
        if (stored) {
          const listed = (id: string) =>
            waitUntil(() => readOptions().some((o) => isOption(o, id)), { signal: ui.signal, timeoutMs: 8000, what: 'the saved PDF to be listed' }).then(
              () => true,
              (e) => {
                if (ui.signal.aborted) throw e;
                return false;
              },
            );
          if (!(await listed(stored.id))) {
            await reopenPagePanel(ui);
            if (!(await listed(stored.id))) {
              throw new Error(`“${stored.name}” was saved to the magazine's Uploads, but the Copy panel does not list it yet — nothing was copied. Try again in a moment.`);
            }
          }
        }
        const options = readOptions();
        let chosen: { value: string; text: string } | undefined;
        if (stored) {
          chosen = options.find((o) => isOption(o, stored!.id));
        } else if (a.doc) {
          const want = a.doc.trim().toLowerCase();
          const hits = options.filter((o) => o.text.toLowerCase().includes(want));
          if (hits.length === 0) {
            throw actionError(`No PDF in this magazine matches “${a.doc}”. Its PDFs: ${options.map((o) => `“${o.text}”`).join(', ')}.`, {
              next: 'If the user meant a PDF they sent in this chat, call magazine.copyPdfPage with attachment (0 or its file name) instead of doc.',
            });
          }
          if (hits.length > 1 && !hits.some((h) => docName(h.text).toLowerCase() === want)) {
            throw new Error(`“${a.doc}” matches several PDFs: ${hits.map((o) => `“${o.text}”`).join(', ')}. Pass a longer part of the name.`);
          }
          chosen = hits.find((h) => docName(h.text).toLowerCase() === want) ?? hits[0];
        } else {
          // The newest file in this chat is a PDF the magazine does not hold: that is
          // almost certainly the one meant, and copying another PDF instead would be
          // a silent, irreversible mistake.
          const newest = listOperatorAttachments()[0];
          if (newest && isPdfAttachment(newest) && !options.some((o) => docName(o.text).toLowerCase() === newest.name.toLowerCase())) {
            throw actionError(`“${newest.name}”, the PDF sent in this chat, is not in this magazine yet — nothing was copied.`, {
              next: 'Call magazine.copyPdfPage again with attachment: 0 (or that file name) to save and copy it, or pass doc to copy from a PDF the magazine already holds.',
            });
          }
          if (options.length > 1) {
            throw new Error(`Several PDFs are attached: ${options.map((o) => `“${o.text}”`).join(', ')}. Ask the user which one, then pass doc.`);
          }
          chosen = options[0];
        }
        if (!chosen) throw new Error('The PDF to copy from is not listed in the Copy panel — nothing was copied.');
        const pick = chosen;
        if (sel()?.value !== pick.value) await ui.select('mag.copy-pdf-doc', pick.value);

        // Which page of it (bounded when the PDF's length is known).
        await ui.type('mag.copy-pdf-page', String(a.docPage), { clear: true });
        await sleep(150, ui.signal);
        const pageInput = anchor('mag.copy-pdf-page') as HTMLInputElement | null;
        const max = pageInput?.max ? Number(pageInput.max) : 0;
        if (max > 0 && a.docPage > max) {
          throw new Error(`“${pick.text}” has ${max} pages — there is no page ${a.docPage}.`);
        }

        const ok = await ui.confirm(
          `Copy page ${a.docPage} of “${pick.text}” onto page ${n}? Everything on page ${n} is replaced with that PDF page's own text, pictures and colours, and the page takes on its shape — this cannot be undone.`,
        );
        if (!ok) throw new Error(DECLINED);

        // The panel copies onto whatever page is OPEN when the button is pressed. If
        // the canvas moved while the card was up, go back to the approved page (and
        // put the choice back) before pressing — never copy onto another page.
        await holdTargetPage(ui, target, n, async () => {
          if (!(await appears(ui, 'mag.copy-pdf-go', 8000))) throw new Error(`The Copy panel closed while you were deciding — nothing was copied onto page ${n}.`);
          if (sel()?.value !== pick.value) await ui.select('mag.copy-pdf-doc', pick.value);
          const pi = anchor('mag.copy-pdf-page') as HTMLInputElement | null;
          if (pi && pi.value !== String(a.docPage)) await ui.type('mag.copy-pdf-page', String(a.docPage), { clear: true });
        });

        const revBefore = get().pages.find((p) => p.id === target.id)?.rev;
        const toasts = watchToasts();
        try {
          assertEnabled('mag.copy-pdf-go', 'The copy button is busy right now.');
          await ui.click('mag.copy-pdf-go', 'Copy onto this page');
          const seen = await waitUntil(
            () => {
              const ts = toasts.peek();
              return ts.some((t) => /copying page/i.test(t.text)) || errorToasts(ts).length ? ts : null;
            },
            { signal: ui.signal, timeoutMs: 45_000, what: 'the copy to start' },
          );
          const errs = errorToasts(seen);
          if (errs.length) throw new Error(errs.map((t) => t.text).join(' '));

          // The rebuild runs in the worker: the page goes 'pending', then comes back
          // with new elements and a new rev. The panel that was just pressed is
          // already waiting for exactly that (pageCopyWatch) and reloads the page on
          // the canvas when it lands — join that wait rather than poll beside it.
          ui.step(`Copying the PDF page onto page ${n}`);
          const watch = runningPageCopy(target.id) ?? watchPageCopy(target.id, revBefore);
          const outcome = await within(watch, INLINE_COPY_WAIT_MS, ui.signal);
          const base = { page: n, pdf: pick.text, docPage: a.docPage, ...(stored ? { savedToUploads: stored.name } : {}) };

          if (!outcome || outcome.state === 'timeout') {
            // Queued behind other work (the worker takes one job at a time). Hand the
            // wait to a background job — a [job-update] arrives when the page lands —
            // instead of sitting out a fixed wait and reporting "still rebuilding".
            if (get().currentPageId === target.id) await get().openPage(target.id, true);
            const job = startPageCopyJob({
              magazineId: issueId,
              pageId: target.id,
              pageNumber: n,
              revBefore,
              seenPending: true,
              pdf: pick.text,
              docPage: a.docPage,
              title: get().issue?.title,
            });
            return { ...base, started: true, rebuilt: false, jobId: job.id, note: PAGE_COPY_STARTED_NOTE, toasts: toastLines(toasts.stop()) };
          }
          if (outcome.state === 'left') throw new Error(`The magazine was closed before the copy onto page ${n} finished — open it again to see the page.`);
          if (outcome.state === 'gone') throw new Error(`Page ${n} was removed before the copy finished.`);
          if (outcome.state === 'failed') throw new Error(copyFailureText(outcome.summary, n));

          // Landed. The wait reloaded the open page; make sure the canvas has it.
          if (get().currentPageId === target.id && get().page?.rev !== outcome.summary?.rev) await get().openPage(target.id, true);
          const others = get().pages.filter((p) => p.id !== target.id);
          const notice = copyNoticeText((outcome.summary as { notice?: unknown } | undefined)?.notice);
          const sizeNote = outcome.summary ? pageSizeNote(outcome.summary, n, others) : null;
          ui.step(`Checking page ${n}`);
          const pageCheck = await pageCheckFor(target.id);
          return {
            ...base,
            started: true,
            rebuilt: true,
            elements: outcome.summary?.elementCount,
            ...(notice ? { notice } : {}),
            ...(sizeNote ? { sizeNote } : {}),
            pageCheck,
            toasts: toastLines(toasts.stop()),
          };
        } finally {
          toasts.stop();
        }
      },
    },
    ownerCanEdit,
  );

  // ── Rebuild a page in an uploaded reference's layout ─────────────────────
  useAgentAction(
    {
      name: 'magazine.applyLayout',
      description:
        'Owner only. Page panel ▸ "Match a layout": rebuild page `page` (default: the open page) in the arrangement of a reference picture — fit "exact" puts every box where the reference had it, "adapt" re-composes it around this page\'s content. Fresh copy is written; nothing is copied from the reference. Replaces everything on the page; cannot be undone. FLOW: (1) call it once — it opens the page and the Match-a-layout panel; (2) upload the user\'s reference image with upload { agentId: "mag.layout-upload", attachment }; (3) call it again: it waits for the reading, asks the user, then rebuilds. Returns the measured verdict (matched / adapted / loose + %).',
      args: z.object({
        page: z.number().int().min(1).optional(),
        fit: z.enum(['exact', 'adapt']),
      }),
      run: async (a, ui) => {
        await ready(ui);
        const target = a.page ? await openPageN(ui, a.page) : pageAt(get().pages, currentPageNumber() ?? 1);
        const n = pageNo(target);
        ui.step('Opening Match a layout');
        await ensurePagePanel(ui);
        if (!(await appears(ui, 'mag.layout-upload', 6000))) {
          throw new Error('The Match a layout panel is not available here (owner only, with the page panel open).');
        }

        // A reading in flight (the upload button shows busy) → wait for it.
        const uploadBtn = () => anchor('mag.layout-upload') as HTMLButtonElement | null;
        if (!anchor('mag.layout-apply') && uploadBtn()?.disabled) {
          ui.step('Waiting for the reference to be read');
          await waitUntil(() => !!anchor('mag.layout-apply') || !uploadBtn()?.disabled, {
            signal: ui.signal,
            timeoutMs: 120_000,
            what: 'the layout reference to be read',
          });
        }
        if (!anchor('mag.layout-apply')) {
          await ui.point('mag.layout-upload', 'Upload the reference here');
          // The sentence is for the person; the next steps ride in the model-only detail.
          throw actionError(`No layout reference has been read for page ${n} yet — the Match a layout panel is open, ready for the picture.`, {
            next:
              "Upload the user's reference image with upload { agentId: \"mag.layout-upload\", attachment: <0 or its file name> }, then call magazine.applyLayout again " +
              '(it waits for the reading). If the upload fails to read, the error toast says why.',
          });
        }

        // Choose the fit (radio), then ask.
        const radio = `mag.layout-fit-${a.fit}`;
        if (!(anchor(radio) as HTMLInputElement | null)?.checked) await ui.click(radio, a.fit === 'exact' ? 'Copy the layout exactly' : 'Adapt it to my content');
        const count = get().page?.id === target.id ? get().page!.elements.length : target.elementCount;
        const ok = await ui.confirm(
          `Rebuild page ${n} in the reference's layout (${a.fit === 'exact' ? 'every box where the reference had it' : 'adapted to this page\'s content'})? ` +
            `Its ${count} current item${count === 1 ? '' : 's'} are replaced — fresh words are written and its photos re-used — and this cannot be undone.`,
        );
        if (!ok) throw new Error(DECLINED);

        // The rebuild goes to whatever page is OPEN at the click (store.applyLayout
        // uses the open page) — hold it to the page the card named.
        await holdTargetPage(ui, target, n, async () => {
          if (!(await appears(ui, 'mag.layout-apply', 6000))) {
            throw new Error(`The layout reading is no longer showing for page ${n} — nothing was changed. Call magazine.applyLayout again.`);
          }
          if (!(anchor(radio) as HTMLInputElement | null)?.checked) await ui.click(radio, a.fit === 'exact' ? 'Copy the layout exactly' : 'Adapt it to my content');
        });

        const toasts = watchToasts();
        try {
          assertEnabled('mag.layout-apply', 'A layout rebuild is already running.');
          await ui.click('mag.layout-apply', 'Put this page in that layout');
          // layoutBusy goes up on the request and down when it lands.
          await waitUntil(() => get().layoutBusy, { signal: ui.signal, timeoutMs: 5000, what: 'the rebuild to start' }).catch((e) => {
            if (ui.signal.aborted) throw e;
          });
          await waitUntil(() => !get().layoutBusy, { signal: ui.signal, timeoutMs: 180_000, what: 'the rebuild to finish' });
          await sleep(300, ui.signal);
          const seen = toasts.stop();
          const errs = errorToasts(seen);
          if (errs.length) throw new Error(errs.map((t) => t.text).join(' '));
          if (seen.length === 0) {
            throw new Error('The rebuild did not run — nothing changed on the page. Call readScreen to see the panel state.');
          }
          const verdict = seen.find((t) => t.type === 'success' || t.type === 'warning');
          // The rebuilt page, measured — a fresh layout is exactly where copy gets
          // cut off or boxes collide, and readScreen cannot see either.
          ui.step(`Checking page ${n}`);
          const pageCheck = await pageCheckFor(target.id);
          return {
            rebuilt: true,
            page: n,
            fit: a.fit,
            verdict: verdict?.text,
            elements: get().page?.id === target.id ? get().page!.elements.length : undefined,
            pageCheck,
            toasts: toastLines(seen),
          };
        } finally {
          toasts.stop();
        }
      },
    },
    ownerCanEdit,
  );
}
