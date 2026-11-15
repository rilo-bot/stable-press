// ---------------------------------------------------------------------------
// Magazine Builder v2 — the PDFs a magazine holds, ONE entry per file.
//
// The pure half of PdfPagePicker.tsx ("Copy a page exactly", "Match a layout"),
// kept free of React and the store so it runs under `tsx --test`.
//
// A magazine's PDFs live in two stores (sourceDocs: uploaded on the way in; media
// 'doc' rows: attached in the studio chat), and since a PDF attached in the Design
// Helper is ALSO registered as a source document over the same stored file (so the
// worker can read it page by page — magazineDocs.registerAttachedDocument), the same
// file is in both. De-duplicating by id kept both rows, so "NZTROF Owners
// Experience.pdf" was listed twice under two ids — and The Stable Hand, which reads
// that list, refused the only PDF there was: "Several PDFs are attached".
//
// One file = one entry:
//   • an upload that names its source (`sourceDocId`) is that source;
//   • without the link (a server that does not send it), the same name AND the same
//     byte size is the same file — two different PDFs that agree on both do not occur
//     in practice, and the same PDF stored twice is still one document to pick;
//   • the source row is the one kept (it knows its page count; copy-document-page and
//     the layout read take either id), and the ids it stands for are kept in `aliases`
//     so a caller holding the upload's id (the operator just saved it) still finds it.
// ---------------------------------------------------------------------------

/** One PDF this magazine holds, from either store. */
export interface PdfChoice {
  docId: string;
  name: string;
  /**
   * Pages, when something has counted them. 0 means UNKNOWN — a chat attachment was
   * never read page by page — and never "empty". Mirrors magazineDocs.ts, where the
   * same 0 carries the same meaning, so a caller must not render it as a count.
   */
  pages: number;
  /** Other ids the same file is stored under (the chat upload of a source, a second
   *  upload of the same file). Selecting `docId` is selecting any of these. */
  aliases: string[];
}

/** The parts of a source document row this needs (api.SourceDocSummary). */
export interface SourceRow {
  id: string;
  originalName: string;
  contentType: string;
  size?: number;
  pagesTotal?: number;
}

/** The parts of an upload row this needs (api.MagazineUpload). */
export interface UploadRow {
  id: string;
  originalName: string;
  contentType: string;
  size?: number;
  /** The source document registered over the same stored file, when the server says. */
  sourceDocId?: string;
}

const isPdf = (contentType: string): boolean => contentType === 'application/pdf';

/** Name and size, the identity of a file when no link says it. Null when the size is
 *  unknown — a name alone is not enough to call two files one. */
const fileKey = (name: string, size: number | undefined): string | null =>
  typeof size === 'number' && size > 0 ? `${name.trim().toLowerCase()}\u0001${size}` : null;

/**
 * Every PDF in the two stores, one entry per file, sources first (then uploads, newest
 * first as the server lists them).
 */
export function pdfChoices(sources: readonly SourceRow[], uploads: readonly UploadRow[]): PdfChoice[] {
  const out: PdfChoice[] = [];
  const byId = new Map<string, PdfChoice>();
  const byFile = new Map<string, PdfChoice>();
  for (const s of sources) {
    if (!isPdf(s.contentType) || byId.has(s.id)) continue;
    const choice: PdfChoice = { docId: s.id, name: s.originalName, pages: s.pagesTotal || 0, aliases: [] };
    out.push(choice);
    byId.set(s.id, choice);
    const key = fileKey(s.originalName, s.size);
    if (key && !byFile.has(key)) byFile.set(key, choice);
  }
  for (const u of uploads) {
    if (!isPdf(u.contentType) || byId.has(u.id)) continue;
    const key = fileKey(u.originalName, u.size);
    const same = (u.sourceDocId ? byId.get(u.sourceDocId) : undefined) ?? (key ? byFile.get(key) : undefined);
    if (same) {
      same.aliases.push(u.id);
      byId.set(u.id, same);
      continue;
    }
    const choice: PdfChoice = { docId: u.id, name: u.originalName, pages: 0, aliases: [] };
    out.push(choice);
    byId.set(u.id, choice);
    if (key) byFile.set(key, choice);
  }
  return out;
}

/** The entry that stands for this id — its own, or one it was folded into. */
export const choiceFor = (choices: readonly PdfChoice[], id: string): PdfChoice | undefined =>
  choices.find((c) => c.docId === id || c.aliases.includes(id));
