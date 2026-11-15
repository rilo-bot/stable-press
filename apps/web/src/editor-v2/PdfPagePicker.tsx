// ---------------------------------------------------------------------------
// Magazine Builder v2 — "which PDF, and which page of it".
//
// Shared by the TWO doors that take a page from a document — "Match a layout"
// (measure its arrangement) and "Copy a page exactly" (reproduce it verbatim).
// One module because the awkward part is the same for both and is easy to get
// half-right: a magazine's PDFs live in TWO stores, and which one a file is in
// depends only on how it arrived.
//
//   sourceDocs   uploaded on the way in. Read, chunked, page-counted.
//   media (doc)  attached in the studio chat.
//
// That split is an accident of two features growing separately, not a distinction
// anybody using the product makes — they attached a PDF either way. The server
// already resolves both through `magazineDocs.ts`; a picker that read one store
// would offer half the answer, and the missing half would look like a lost file.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import { ShimmerText } from './BuildProgress';
import { useEditorStore } from './store';
import * as api from './api';
import { pdfChoices, type PdfChoice } from './pdfChoices';

export type { PdfChoice } from './pdfChoices';

/** Every PDF attached to the open magazine, both stores, ONE entry per file (see
 *  pdfChoices: a PDF attached in the Design Helper is in both stores, and was listed
 *  twice). `null` while loading — distinct from `[]`, which means "none attached".
 *
 *  Re-read whenever this tab stores a document (`uploadsVersion`). It used to be read
 *  once per magazine, so a PDF sent in the Design Helper — which stores it in Uploads
 *  — was missing from "Copy a page exactly" until a reload, and the copy looked like it
 *  had lost the file. The previous list stays on screen while the new one loads, so a
 *  choice in progress does not flicker back to "Looking for PDFs". */
export function usePdfChoices(): PdfChoice[] | null {
  const issueId = useEditorStore((s) => s.issueId);
  const uploadsVersion = useEditorStore((s) => s.uploadsVersion);
  const [docs, setDocs] = useState<PdfChoice[] | null>(null);

  useEffect(() => {
    if (!issueId) return;
    let alive = true;
    void (async () => {
      // Either store failing is survivable: half a list beats an error where the
      // other half would have done.
      const [sources, uploads] = await Promise.all([
        api.listSources(issueId).catch(() => []),
        api.listUploads(issueId).catch(() => []),
      ]);
      if (!alive) return;
      // Source documents first: attaching a file can write to both, and this is the
      // copy that knows its own length. Same precedence as magazineDocument().
      setDocs(pdfChoices(sources, uploads));
    })();
    return () => {
      alive = false;
    };
  }, [issueId, uploadsVersion]);

  return docs;
}

/**
 * Pick a PDF and a page of it, then act. `onRead` owns what "act" means — the two
 * callers do very different things with the same choice.
 */
export function PdfPagePicker({
  disabled,
  actionLabel = 'Read that page’s layout',
  emptyNote = 'No PDF attached to this magazine yet.',
  onRead,
  agentPrefix,
}: {
  disabled?: boolean;
  actionLabel?: string;
  emptyNote?: string;
  onRead: (docId: string, pageNo: number) => void;
  /** Stablehand Operator anchor prefix (e.g. 'mag.layout-pdf'): the controls get
   *  `<prefix>-doc`, `<prefix>-page`, `<prefix>-go`. Two pickers share a panel, so
   *  each caller names its own. */
  agentPrefix?: string;
}) {
  const docs = usePdfChoices();
  const [docId, setDocId] = useState('');
  const [pageNo, setPageNo] = useState(1);

  // Default to the first PDF once the list lands, without clobbering a choice the
  // user has already made.
  useEffect(() => {
    if (docs && docs.length > 0) setDocId((cur) => cur || docs[0]!.docId);
  }, [docs]);

  if (docs === null) return <p className="text-ui-sm text-studio-ink-4"><ShimmerText>Looking for PDFs</ShimmerText></p>;
  if (docs.length === 0) return <p className="text-ui-sm text-studio-ink-4">{emptyNote}</p>;

  const chosen = docs.find((d) => d.docId === docId) ?? null;

  return (
    <div className="flex flex-col gap-1.5 rounded-sm border border-studio-edge p-2">
      <label className="flex items-center gap-1.5 text-ui-sm text-studio-ink-3">
        <FileText size={12} className="flex-shrink-0" />
        <select
          value={docId}
          onChange={(e) => { setDocId(e.target.value); setPageNo(1); }}
          disabled={disabled}
          data-agent-id={agentPrefix ? `${agentPrefix}-doc` : undefined}
          data-agent-label={agentPrefix ? 'Which PDF' : undefined}
          className="min-w-0 flex-1 rounded-sm border border-studio-edge bg-studio-raise px-1.5 py-1 text-ui-sm text-studio-ink"
        >
          {docs.map((d) => (
            // `data-alias-ids`: the other ids this one file is stored under, so The Stable
            // Hand can find the PDF it has just saved by that upload's own id.
            <option key={d.docId} value={d.docId} data-alias-ids={d.aliases.length > 0 ? d.aliases.join(' ') : undefined}>
              {d.name}{d.pages > 0 ? ` (${d.pages} pages)` : ''}
            </option>
          ))}
        </select>
      </label>

      <div className="flex items-center gap-2 text-ui-sm text-studio-ink-3">
        <span className="flex-shrink-0">Its page</span>
        <input
          type="number"
          min={1}
          // Bounded only when the count is KNOWN. Unbounded is right for a document
          // nobody has paged — the server answers with the real count if it is wrong.
          {...(chosen && chosen.pages > 0 ? { max: chosen.pages } : {})}
          value={pageNo}
          onChange={(e) => setPageNo(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
          disabled={disabled}
          data-agent-id={agentPrefix ? `${agentPrefix}-page` : undefined}
          data-agent-label={agentPrefix ? 'PDF page number' : undefined}
          className="w-16 rounded-sm border border-studio-edge bg-studio-raise px-1.5 py-1 text-ui-sm tabular-nums text-studio-ink"
        />
        {chosen && chosen.pages > 0 && <span className="text-studio-ink-4">of {chosen.pages}</span>}
        <button
          onClick={() => chosen && onRead(chosen.docId, pageNo)}
          disabled={disabled || !chosen}
          data-agent-id={agentPrefix ? `${agentPrefix}-go` : undefined}
          className="ml-auto rounded-sm border border-studio-edge px-2 py-1 text-ui-sm font-semibold text-studio-ink hover:bg-studio-raise-2 disabled:opacity-50"
        >
          {actionLabel}
        </button>
      </div>
    </div>
  );
}
