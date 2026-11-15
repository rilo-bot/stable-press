// Magazine Builder v2 — the waiting-changes bar.
//
// "6 changes waiting on pages 7, 8, 9 · Review · Apply all · Discard"
//
// The Design Helper STAGES its changes, and the user applies them. With one tray that
// a new message replaced, a client cleared pages 7 to 16 one message at a time and
// only the last page's removals could ever be applied; the rest vanished without a
// word. Staged changes are now kept per page until they are applied or discarded
// (store `pending`, pendingChanges.ts), and this bar is where all of them are visible
// at once — whatever page is open, whichever chat is open.
//
// Mounted at the top of the Design Helper panel. It can also be mounted by the editor
// itself (`where="editor"`, above the canvas), and then the panel's copy steps aside so
// the bar is never shown twice.

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Check, ChevronDown, ChevronUp, Clock, Loader2, X } from 'lucide-react';
import { useEditorStore } from './store';
import { changeCount, summarizeChanges, waitingBarText, waitingPages } from './pendingChanges';

// ── Which copy of the bar shows ──
// A module counter, not store state: nothing about the magazine changes when the
// editor mounts its own bar, only which of two identical bars is drawn.
let editorHosts = 0;
const hostListeners = new Set<() => void>();
const subscribeHosts = (cb: () => void) => {
  hostListeners.add(cb);
  return () => {
    hostListeners.delete(cb);
  };
};
const editorHosted = () => editorHosts > 0;

export function WaitingChangesBar({ where = 'panel' }: { where?: 'panel' | 'editor' }) {
  const pending = useEditorStore((s) => s.pending);
  const pages = useEditorStore((s) => s.pages);
  const currentPageId = useEditorStore((s) => s.currentPageId);
  const applying = useEditorStore((s) => s.applyingProposals);
  const chatBusy = useEditorStore((s) => s.chatBusy);
  const applyAllWaiting = useEditorStore((s) => s.applyAllWaiting);
  const discardWaiting = useEditorStore((s) => s.discardWaiting);
  const goToPage = useEditorStore((s) => s.goToPage);
  const [open, setOpen] = useState(false);
  const hosted = useSyncExternalStore(subscribeHosts, editorHosted, editorHosted);

  useEffect(() => {
    if (where !== 'editor') return;
    editorHosts++;
    hostListeners.forEach((l) => l());
    return () => {
      editorHosts--;
      hostListeners.forEach((l) => l());
    };
  }, [where]);

  const waiting = useMemo(() => waitingPages(pending, pages), [pending, pages]);
  if (waiting.length === 0) return null;
  if (where === 'panel' && hosted) return null;

  // Disabled while an apply runs (a second press would apply the same changes twice)
  // and while the assistant is replying: that turn is building on these changes.
  const busy = applying || chatBusy;
  const busyWhy = applying ? 'Applying the changes…' : chatBusy ? 'The Design Helper is still working on these changes' : undefined;
  const text = waitingBarText(waiting);

  return (
    <div
      role="status"
      aria-live="polite"
      data-agent-id="mag.waiting-bar"
      data-agent-label={text}
      className="flex-shrink-0 border-b px-3 py-2 text-ui-sm"
      style={{ borderColor: 'var(--gold-mid)', background: 'rgba(212,168,67,0.12)' }}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 font-semibold" style={{ color: 'var(--gold-light)' }}>
          <Clock size={12} className="flex-shrink-0" />
          <span className="min-w-0">{text}</span>
        </span>
        <div className="flex flex-shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            data-agent-id="mag.waiting-review"
            data-agent-label="Review the changes waiting for Apply"
            className="flex items-center gap-1 rounded-sm border border-studio-edge px-2 py-0.5 text-studio-ink-2 hover:bg-studio-raise-2"
          >
            Review {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          </button>
          <button
            type="button"
            onClick={() => void applyAllWaiting()}
            disabled={busy}
            title={busyWhy ?? 'Apply every waiting change, page by page'}
            data-agent-id="mag.waiting-apply-all"
            data-agent-label="Apply all waiting changes"
            className="flex items-center gap-1 rounded-sm bg-emerald-500 px-2 py-0.5 font-semibold text-studio-ink hover:bg-emerald-600 disabled:opacity-60"
          >
            {applying ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />} {applying ? 'Applying…' : 'Apply all'}
          </button>
          <button
            type="button"
            onClick={() => discardWaiting()}
            disabled={busy}
            title={busyWhy ?? 'Throw away every waiting change — nothing on the pages changes, and the message offers to bring them back'}
            data-agent-id="mag.waiting-discard"
            data-agent-label="Discard all waiting changes"
            className="flex items-center gap-1 rounded-sm border border-studio-edge px-2 py-0.5 text-studio-ink-2 hover:bg-studio-raise-2 disabled:opacity-50"
          >
            <X size={11} /> Discard
          </button>
        </div>
      </div>
      {open && (
        <ul className="studio-scroll mt-2 max-h-48 space-y-1.5 overflow-y-auto">
          {waiting.map((w) => (
            <li
              key={w.pageId}
              data-agent-id={`mag.waiting-page-${w.page}`}
              data-agent-label={`Page ${w.page}: ${changeCount(w.proposals.length)} waiting`}
              className="rounded-md border px-2 py-1.5"
              style={{ borderColor: 'rgba(212,168,67,0.3)', background: 'rgba(212,168,67,0.05)' }}
            >
              <div className="flex items-center gap-2">
                <span className="font-semibold text-studio-ink">
                  Page {w.page}
                  {w.pageId === currentPageId ? ' (open)' : ''} · {changeCount(w.proposals.length)}
                </span>
                <span className="ml-auto flex items-center gap-1">
                  {w.pageId !== currentPageId && (
                    <button
                      type="button"
                      onClick={() => void goToPage(w.pageId)}
                      disabled={applying}
                      data-agent-id={`mag.waiting-page-${w.page}-open`}
                      data-agent-label={`Go to page ${w.page}`}
                      className="rounded-sm border border-studio-edge px-1.5 py-0.5 text-studio-ink-2 hover:bg-studio-raise-2 disabled:opacity-50"
                    >
                      Go to page
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void applyAllWaiting(w.pageId)}
                    disabled={busy}
                    data-agent-id={`mag.waiting-page-${w.page}-apply`}
                    data-agent-label={`Apply page ${w.page}'s waiting changes`}
                    className="rounded-sm border border-emerald-400/40 px-1.5 py-0.5 text-emerald-200 hover:bg-emerald-500/15 disabled:opacity-50"
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    onClick={() => discardWaiting(w.pageId)}
                    disabled={busy}
                    data-agent-id={`mag.waiting-page-${w.page}-discard`}
                    data-agent-label={`Discard page ${w.page}'s waiting changes`}
                    aria-label={`Discard page ${w.page}'s waiting changes`}
                    className="rounded-sm border border-studio-edge px-1.5 py-0.5 text-studio-ink-3 hover:bg-studio-raise-2 disabled:opacity-50"
                  >
                    <X size={10} />
                  </button>
                </span>
              </div>
              <p className="mt-0.5 leading-snug text-studio-ink-3">{summarizeChanges(w.proposals, 4)}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
