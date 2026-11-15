// ---------------------------------------------------------------------------
// Magazine Builder v2 — "Copy a page exactly" (the verbatim door).
//
// The SIBLING of LayoutReference, and the two are kept apart on purpose because
// they disagree about the one question that matters to the person pressing them:
//
//   LayoutReference   takes a reference's ARRANGEMENT and writes this magazine's
//                     own copy into it. The reference's words never come across —
//                     that rule is what stops us reprinting someone else's title.
//   this panel        takes the PAGE. Its real text, at its measured size, in its
//                     own colours, over its own artwork.
//
// One control offering both as a mode was the tempting shape and it is the wrong
// one: "make this page like that" is genuinely ambiguous, and a mode is a setting
// people do not read. Two buttons make the choice at the moment of acting.
//
// Only a PDF can be copied. A picture has no text layer to reconstruct and a Word
// file has no page — `canCopyLayout` on the server says the same, so the picker
// never offers what the server would refuse.
//
// THE COPY RUNS IN THE WORKER, so pressing the button only starts it. This panel
// then WAITS for it (pageCopyWatch: the store's own refresh, the same GET the
// studio makes) and reloads the page on the canvas when it lands. It used to say
// "it will appear here shortly" and stop there: nothing polled, the canvas kept the
// old page until a reload, and edits made on that stale canvas went nowhere. The
// Stable Hand's magazine.copyPdfPage clicks this same button and joins the same
// wait, so a person and the AI see one outcome, told the same way.
// ---------------------------------------------------------------------------

import { useState } from 'react';
import { toast } from 'sonner';
import { useEditorStore } from './store';
import { PdfPagePicker } from './PdfPagePicker';
import { ShimmerText } from './BuildProgress';
import { copyFailureText, copyNoticeText, pageSizeNote } from './pageCopy';
import { watchPageCopy, type PageCopyOutcome } from './pageCopyWatch';
import * as api from './api';

/** Tell the person how the copy went. Toasts are global, so this still speaks when
 *  the panel was closed or the page left while the copy ran. */
function reportCopy(outcome: PageCopyOutcome, pageId: string, n: number, from: { name: string; sourcePage: number }) {
  const { state, summary } = outcome;
  if (state === 'left') return;
  if (state === 'gone') {
    toast.error(`Page ${n} was removed before the copy of page ${from.sourcePage} finished.`);
    return;
  }
  if (state === 'failed') {
    toast.error(copyFailureText(summary, n));
    return;
  }
  if (state === 'timeout') {
    toast.info(`Still copying page ${from.sourcePage} of “${from.name}” onto page ${n} — it is queued behind other work. Reload the page in a few minutes to see it.`);
    return;
  }
  const others = useEditorStore.getState().pages.filter((p) => p.id !== pageId);
  const notes = [
    copyNoticeText((summary as { notice?: unknown } | undefined)?.notice),
    summary ? pageSizeNote(summary, n, others) : null,
  ].filter((t): t is string => !!t);
  const title = `Page ${n} now shows page ${from.sourcePage} of “${from.name}”.`;
  if (notes.length) toast.warning(title, { description: notes.join(' ') });
  else toast.success(title);
}

export function CopyDocumentPage() {
  const issueId = useEditorStore((s) => s.issueId);
  const currentPageId = useEditorStore((s) => s.currentPageId);
  const pages = useEditorStore((s) => s.pages);
  const [busy, setBusy] = useState(false);
  /** The page a copy is still being made onto (shown under the picker). */
  const [copying, setCopying] = useState<{ pageId: string; n: number } | null>(null);

  const run = async (docId: string, sourcePage: number) => {
    // Fix the target NOW: the confirm below can sit open while the canvas scrolls,
    // and everything after it acts on the page the person was asked about.
    const pageId = currentPageId;
    if (!issueId || !pageId) return;
    const sum = pages.find((p) => p.id === pageId);
    // The page's REAL number (as printed on the canvas), not its list position.
    const n = sum ? sum.index + 1 : 0;
    // THE CONFIRM NAMES BOTH PAGES AND THE RESHAPE. This replaces every element and
    // cannot be undone, and it also re-shapes the page to the source's proportions —
    // which is what copying means, but is not what anyone expects unless told.
    const ok = window.confirm(
      `Copy page ${sourcePage} of that PDF onto page ${n > 0 ? n : '?'}?\n\n` +
        `This page's current contents are replaced with that page's own text, pictures and colours — it cannot be undone. ` +
        `The page also takes on the source page's shape, so it may end up a different size from the rest of the magazine.`,
    );
    if (!ok) return;
    setBusy(true);
    let from: { name: string; sourcePage: number };
    try {
      ({ from } = await api.copyDocumentPage(issueId, pageId, { docId, sourcePage }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'That page could not be copied.');
      setBusy(false);
      return;
    }
    // Start the wait BEFORE saying so: The Stable Hand reads this toast as "the copy
    // started" and then joins this exact wait.
    const watch = watchPageCopy(pageId, sum?.rev);
    toast.success(`Copying page ${from.sourcePage} of “${from.name}” onto page ${n}…`);
    setBusy(false);
    setCopying({ pageId, n });
    const outcome = await watch;
    setCopying((c) => (c?.pageId === pageId ? null : c));
    reportCopy(outcome, pageId, n, from);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <PdfPagePicker
        disabled={busy || !currentPageId}
        actionLabel={busy ? 'Starting…' : 'Copy onto this page'}
        emptyNote="No PDF attached to this magazine yet. Add one in the AI Studio's Uploads tab (or attach it when creating the magazine), and you can reproduce any of its pages here exactly."
        onRead={(docId, pageNo) => void run(docId, pageNo)}
        agentPrefix="mag.copy-pdf"
      />
      {copying && (
        <p className="text-ui-sm text-studio-ink-3" role="status" aria-live="polite" data-agent-id="mag.copy-pdf-status">
          <ShimmerText>{`Copying onto page ${copying.n} — the page reloads here when it is done`}</ShimmerText>
        </p>
      )}
      <p className="text-ui-sm text-studio-ink-4">
        An exact reproduction — the PDF page's own words, pictures and colours, as editable elements.
        For its <b className="text-studio-ink-3">design only</b>, with copy written for your magazine, use Match a layout above.
      </p>
    </div>
  );
}
