// ---------------------------------------------------------------------------
// Magazine Builder v2 — where a magazine's DOCUMENTS are, whichever store holds
// them.
//
// There are two, and which one a PDF is in depends only on how it arrived:
//
//   sourceDocs    uploaded on the way into a new magazine. Read in the worker,
//                 chunked for retrieval, page-counted, coverage tracked.
//   media (doc)   attached in the studio chat. Stored, listed in Uploads, and
//                 carrying whatever text the browser extracted at the time.
//
// That split is an accident of the two features growing separately, not a
// distinction anybody using the product makes — they attached a PDF either way.
// So any feature phrased in terms of "the user's document" has to look in both, and
// a feature that looks in one is silently broken for half the ways of getting a
// document here. This is that lookup, in one place, so it cannot be half-right in
// two.
//
// THE MAGAZINE IS THE ALLOW-LIST. Every caller passes a docId that came from
// outside — a request body, or a model's tool call — and the scope check here is
// what stops it being a way to read any document in the system.
// ---------------------------------------------------------------------------

import { db } from '../db.js';
import { storage } from '../storage.js';
import { COL } from './collections.js';
import { createSourceDoc, getSourceDoc, loadPageChunks } from './sourceDocsDb.js';
import { enqueueJob } from './jobs.js';
import { isReadable } from './sourceStore.js';
import { resolveSource } from './sourceForPrompt.js';
import { renderSource } from './sourceEnvelope.js';
import { SOURCE_BUDGET } from './sourceLimits.js';
import { layoutReadRefusal } from './studioRequests.js';

/** One document, reduced to what a consumer needs: what it is called, where its
 *  bytes are, and what kind of file it is. */
export interface MagazineDocument {
  docId: string;
  name: string;
  s3Key: string;
  contentType: string;
  /** Pages, when something has counted them. 0 means unknown — a chat attachment
   *  was never read page by page — and never "empty". */
  pages: number;
  /**
   * Which store holds it. Callers that only need the bytes never look; a caller that
   * needs the TEXT does, because the two keep it differently: a source document as
   * read chunks (page-numbered, retrievable), a chat attachment as the one string the
   * browser extracted when it was attached (media.sourceText).
   */
  store: 'source' | 'media';
}

function isPdf(contentType: string): boolean {
  return contentType === 'application/pdf';
}

/** True when this document has a page design that can be copied. Only a PDF does:
 *  a Word or text file is a stream of words with no page in it. */
export function canCopyLayout(doc: MagazineDocument): boolean {
  return isPdf(doc.contentType);
}

/**
 * One document of this magazine, by id, from either store — or null when the id
 * names nothing this magazine holds.
 *
 * Source documents are checked first: when a file is in both (attaching one still
 * writes to both), that is the copy that knows its own page count.
 */
export async function magazineDocument(magazineId: string, docId: string): Promise<MagazineDocument | null> {
  const source = await getSourceDoc(docId);
  if (source && !source.deletedAt && String(source.magazineId) === String(magazineId)) {
    return {
      docId: String(source._id),
      name: source.originalName,
      s3Key: source.s3Key,
      contentType: source.contentType,
      pages: Number(source.coverage?.pagesTotal) || 0,
      store: 'source',
    };
  }
  const asset = (await db.collection(COL.media).findById(String(docId))) as MediaDocRow | null;
  if (asset && asset.kind === 'doc' && String(asset.magazineId) === String(magazineId) && asset.key) {
    // A chat attachment registered for a page-by-page read knows its page count once
    // that read has counted them (registerAttachedDocument).
    const linked = await linkedSource(asset, magazineId);
    return {
      docId: String(asset._id),
      name: String(asset.originalName ?? asset.alt ?? 'document'),
      s3Key: String(asset.key),
      contentType: String(asset.contentType ?? ''),
      pages: Number(linked?.coverage?.pagesTotal) || 0,
      store: 'media',
    };
  }
  return null;
}

/** A chat-attached document row, as these lookups read it. */
interface MediaDocRow {
  _id: string;
  magazineId?: string;
  kind?: string;
  key?: string;
  url?: string;
  size?: number;
  originalName?: string;
  alt?: string;
  contentType?: string;
  sourceText?: unknown;
  /** The source document registered for it (registerAttachedDocument). */
  sourceDocId?: string;
}

/** The source document a chat attachment was registered as, when it still exists in
 *  the same magazine. */
async function linkedSource(row: MediaDocRow, magazineId: string) {
  if (!row.sourceDocId) return null;
  const s = await getSourceDoc(String(row.sourceDocId));
  return s && !s.deletedAt && String(s.magazineId) === String(magazineId) ? s : null;
}

/**
 * The source document registered over a chat attachment's file (registerAttachedDocument),
 * when it still exists — the copy of a SCANNED attachment that has its pages read. Scoped
 * by the magazine like every lookup here; null for anything else.
 */
export async function linkedSourceDocId(magazineId: string, mediaDocId: string): Promise<string | null> {
  const row = (await db.collection(COL.media).findById(String(mediaDocId))) as MediaDocRow | null;
  if (!row || row.kind !== 'doc' || String(row.magazineId) !== String(magazineId)) return null;
  const s = await linkedSource(row, magazineId);
  return s ? String(s._id) : null;
}

// ── Registering a document attached in the chat ──────────────────────────────
//
// A PDF attached in the Design Helper is uploaded to the media library with whatever
// text the BROWSER could pull out of it. That is enough for a typed PDF on the turn it
// was attached — but a scan has no such text, the text has no page numbers ("use the
// results on page 3"), and nothing counted the pages. So the attachment is also
// registered as a SOURCE document over the same stored file: the worker reads it page
// by page (and reads a scan's pages too), and later turns read it through the same
// docId the chat already knows (readMagazineDocument follows the link). Nothing is
// copied — both rows name one stored object.

export interface AttachedDocRegistration {
  /** read_document can return its words now (the browser's text, or a finished read). */
  readable: boolean;
  /** Its page-by-page read has not finished yet. */
  reading: boolean;
  /** The source document registered for it, when there is one. */
  sourceDocId?: string;
}

/**
 * Make sure a document attached in the chat is one of the magazine's READABLE
 * documents: a PDF is registered once as a source document and queued for its read;
 * anything else is already readable through the text stored with it. Idempotent — a
 * second call finds the link and only reports. Scoped by the magazine like every
 * lookup here; a docId from another magazine (or a photo) changes nothing.
 */
export async function registerAttachedDocument(magazineId: string, docId: string, ownerId: string): Promise<AttachedDocRegistration> {
  const source = await getSourceDoc(docId);
  if (source && !source.deletedAt && String(source.magazineId) === String(magazineId)) {
    return { readable: isReadable(source.status), reading: source.status === 'queued' || source.status === 'reading', sourceDocId: String(source._id) };
  }
  const row = (await db.collection(COL.media).findById(String(docId))) as MediaDocRow | null;
  if (!row || row.kind !== 'doc' || String(row.magazineId) !== String(magazineId) || !row.key) return { readable: false, reading: false };
  const hasText = typeof row.sourceText === 'string' && row.sourceText.trim().length > 0;
  const linked = await linkedSource(row, magazineId);
  if (linked) {
    return { readable: hasText || isReadable(linked.status), reading: linked.status === 'queued' || linked.status === 'reading', sourceDocId: String(linked._id) };
  }
  // Only a PDF has pages to read one by one (and only a PDF can be a scan); a Word or
  // text file's words are all in the text the browser stored.
  if (row.contentType !== 'application/pdf') return { readable: hasText, reading: false };
  const sourceDocId = await createSourceDoc({
    magazineId: String(magazineId),
    ownerId: String(ownerId),
    originalName: String(row.originalName ?? row.alt ?? 'document'),
    contentType: 'application/pdf',
    size: Number(row.size) || 0,
    s3Key: String(row.key),
    url: String(row.url ?? storage.publicUrl(String(row.key))),
  });
  await db.collection(COL.media).updateOne(String(row._id), { sourceDocId, updatedAt: new Date().toISOString() });
  // Nothing waits on this read: it is for later turns ("the results on page 3").
  await enqueueJob('readSourceDoc', { docId: sourceDocId });
  return { readable: hasText, reading: true, sourceDocId };
}

// ── The words in a document ──────────────────────────────────────────────────
//
// A document attached in the chat used to be readable for ONE turn: its text rode
// along with the message it was attached to, and nothing could fetch it again, so
// "now add the race results from the PDF" on the next turn had nothing to work from
// and the assistant either invented figures or said it could not see the file
// (findings C12/C27). The text was stored all along — on the media row for a chat
// attachment, as chunks for a source document — and these read it back.

/** The raw text a chat-attached (media) document carries — what the browser extracted
 *  when it was attached — or '' for none. Scoped by the magazine like every lookup. */
export async function mediaDocumentText(magazineId: string, docId: string): Promise<string> {
  try {
    const row = (await db.collection(COL.media).findById(String(docId))) as {
      magazineId?: string;
      kind?: string;
      sourceText?: unknown;
    } | null;
    if (!row || row.kind !== 'doc' || String(row.magazineId) !== String(magazineId)) return '';
    return typeof row.sourceText === 'string' ? row.sourceText : '';
  } catch {
    return '';
  }
}

export type DocumentRead =
  | { ok: true; docId: string; name: string; pages: number; store: 'source' | 'media'; block: string }
  | { ok: false; error: string };

/**
 * The passages of one of this magazine's documents most relevant to `query`, wrapped
 * exactly like the per-turn SOURCE DOCUMENT block (renderSource / renderRetrieved):
 * the task line, the UNTRUSTED-DATA guard and an honest coverage note travel with the
 * text every time, so a document read on a later turn is as clearly DATA as one sent
 * with the message. For the Studio's read_document tool.
 *
 *  - `page` (1-based) reads that page of a source document, which was read page by
 *    page. A chat attachment has no page structure, so for it `page` is ignored and
 *    the passages are ranked by `query` instead.
 *  - The result is bounded by `maxChars` (default SOURCE_BUDGET.chat).
 *  - Every refusal is a sentence the model can act on: not in this magazine, still
 *    being read, or no readable text (a scan).
 */
export async function readMagazineDocument(
  magazineId: string,
  docId: string,
  opts: { query?: string; page?: number; maxChars?: number; task?: string } = {},
): Promise<DocumentRead> {
  const doc = await magazineDocument(magazineId, docId);
  if (!doc) return { ok: false, error: 'That document is not in this magazine — call list_documents for the ids of the documents it has.' };
  const maxChars = Math.max(1_000, Math.min(20_000, Math.round(opts.maxChars ?? SOURCE_BUDGET.chat)));
  const task = opts.task || 'use this document’s own facts, names and figures for the page — never invent any';
  const intent = (opts.query ?? '').trim().slice(0, 600) || undefined;
  const base = { docId: doc.docId, name: doc.name, pages: doc.pages, store: doc.store };

  // A chat attachment registered for a page-by-page read (registerAttachedDocument):
  // a page asked for, or a scan with no browser text, is read from that read once it
  // has finished; otherwise the text stored with the attachment answers, as before.
  let sourceId = doc.docId;
  if (doc.store === 'media') {
    const row = (await db.collection(COL.media).findById(String(doc.docId))) as MediaDocRow | null;
    const linked = row ? await linkedSource(row, magazineId) : null;
    const text = await mediaDocumentText(magazineId, doc.docId);
    const wantsPage = typeof opts.page === 'number' && Number.isInteger(opts.page) && opts.page > 0;
    const useLinked = !!linked && isReadable(linked.status) && (wantsPage || !text.trim());
    if (!useLinked) {
      if (!text.trim()) {
        const reading = linked && (linked.status === 'queued' || linked.status === 'reading');
        return {
          ok: false,
          error: reading
            ? `“${doc.name}” is saved and its pages are still being read — try again in a minute.`
            : `“${doc.name}” has no readable text stored — it may be a scan or a picture of text. Ask the user to paste the part they need, or attach it again as a PDF with selectable text.`,
        };
      }
      const block = renderSource(text, { intent, kind: 'chat', maxChars, task });
      return block ? { ok: true, ...base, block } : { ok: false, error: `Nothing in “${doc.name}” could be read.` };
    }
    sourceId = String(linked!._id);
  }

  const source = await getSourceDoc(sourceId);
  if (!source || !isReadable(source.status)) {
    const failed = source?.status === 'failed';
    return {
      ok: false,
      error: failed
        ? `“${doc.name}” could not be read${source?.error ? ` (${String(source.error).slice(0, 160)})` : ''}.`
        : `“${doc.name}” is still being read — try again in a minute.`,
    };
  }
  const page = typeof opts.page === 'number' && Number.isInteger(opts.page) && opts.page > 0 ? opts.page : undefined;
  if (page !== undefined) {
    if (doc.pages > 0 && page > doc.pages) {
      return { ok: false, error: `“${doc.name}” has ${doc.pages} page${doc.pages === 1 ? '' : 's'}, so there is no page ${page}.` };
    }
    const chunks = await loadPageChunks(sourceId, page);
    const text = chunks.map((c) => c.text).join('\n\n');
    if (!text.trim()) return { ok: false, error: `Page ${page} of “${doc.name}” has no readable text (it may be a picture or a scan).` };
    const block = renderSource(text, { intent, kind: 'chat', maxChars, task: `${task} (page ${page} of “${doc.name}”)` });
    return block ? { ok: true, ...base, block } : { ok: false, error: `Nothing on page ${page} of “${doc.name}” could be read.` };
  }
  const resolved = await resolveSource({ docIds: [sourceId] }, { intent, kind: 'chat', maxChars, task });
  return resolved.block ? { ok: true, ...base, block: resolved.block } : { ok: false, error: `Nothing in “${doc.name}” could be read yet.` };
}

// ── A PDF's bytes for a layout read in the API process ───────────────────────

export type LayoutPdfFetch = { ok: true; bytes: Buffer } | { ok: false; status: number; error: string };

/**
 * Download a document to read its LAYOUT in the API process — but only after the
 * stored object's size says it is safe to (studioRequests.MAX_LAYOUT_READ_BYTES).
 * Documents up to 150 MB are accepted and the API runs on a 512 MB instance, so a
 * big print-ready PDF read here could take every endpoint down (finding C34). For
 * the layout-reference route and the Studio's use_document_as_layout.
 */
export async function fetchLayoutPdf(doc: MagazineDocument): Promise<LayoutPdfFetch> {
  try {
    const head = await storage.headObject(doc.s3Key);
    const refusal = layoutReadRefusal(head.contentLength);
    if (refusal) return { ok: false, status: 413, error: refusal };
  } catch {
    return { ok: false, status: 502, error: 'I could not fetch that document just now — please try again.' };
  }
  try {
    return { ok: true, bytes: await storage.downloadObject(doc.s3Key) };
  } catch (e) {
    console.warn('[magazineV2] layout read: could not fetch the document', e instanceof Error ? e.message : e);
    return { ok: false, status: 502, error: 'I could not fetch that document just now — please try again.' };
  }
}
