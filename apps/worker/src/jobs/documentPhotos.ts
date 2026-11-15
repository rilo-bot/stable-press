// ---------------------------------------------------------------------------
// Magazine Builder v2 — the pure decisions behind lifting the pictures out of an
// attached PDF (finding C45).
//
// A PDF attached in the Design Helper (or added in the Uploads tab) used to be read
// to TEXT only, and stored as one kind:'doc' row that can never be placed. Nothing
// pulled out the photos inside it, so "put the horse photo from page 2 of the PDF on
// this page" had no photo to place: the Studio said it could not, or reached for a
// stranger's stock horse instead of the client's own picture. Pictures were only
// ever extracted by Import PDF or the destructive "copy a page exactly".
//
// extractDocumentImages.ts does the I/O (MuPDF, sharp, S3, Mongo). What it keeps,
// what it calls each picture and what each library row says lives here, with no
// imports beyond node:crypto and the (import-free) media.ts helpers, so it is
// testable without a database, a bucket or a PDF
// (apps/server/tests/magazineV2/documentPhotos.test.ts).
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import { documentPhotoAlt, type PixelSize } from '../../../server/src/lib/magazineV2/media.js';

/**
 * How much of one document is lifted out.
 *
 *   maxPages   The worker claims ONE job at a time, so a 300-page annual report must
 *              not hold every other magazine's import behind it. The pictures a user
 *              names ("the photo on page 2") are nearly always early; a picture past
 *              this page can still be attached as an image.
 *   maxPhotos  A brochure with a photo on every page would otherwise bury the media
 *              library the user picks from.
 *   minSidePx  A decoded picture smaller than this on its SHORTER side is a bullet,
 *              a rule, a social icon or a thumbnail strip — not something anyone asks
 *              to put on a page, and too small to print at any useful size.
 */
export const DOCUMENT_PHOTO_LIMITS = { maxPages: 40, maxPhotos: 60, minSidePx: 120, batchPages: 10 } as const;

/**
 * The pages one run reads, and where the next run starts (null: this run finishes the
 * document). The worker claims the OLDEST queued job, one at a time, so a run that read
 * all 40 pages would hold up a page copy the user started a second later; a run of
 * `batchPages` hands the worker back and queues the rest behind whatever is waiting
 * (readSourceDoc does the same). 0-based, end exclusive.
 */
export function documentPhotoBatch(fromPage: unknown, totalPages: number): { start: number; end: number; next: number | null } {
  const last = Math.max(0, Math.min(Math.floor(totalPages) || 0, DOCUMENT_PHOTO_LIMITS.maxPages));
  const from = Number.isInteger(fromPage) && (fromPage as number) > 0 ? (fromPage as number) : 0;
  const start = Math.min(from, last);
  const end = Math.min(last, start + DOCUMENT_PHOTO_LIMITS.batchPages);
  return { start, end, next: end < last ? end : null };
}

/** Is a decoded picture of this pixel size worth a row in the media library? */
export function documentPictureWorthKeeping(natural: PixelSize | null | undefined): boolean {
  if (!natural) return false;
  return Math.min(natural.width, natural.height) >= DOCUMENT_PHOTO_LIMITS.minSidePx;
}

/**
 * A fingerprint of the decoded picture, so the same picture is stored once: a logo on
 * every page of a brochure, or the same photo repeated on a contents page, would
 * otherwise fill the library with copies. Taken over the DECODED pixels MuPDF hands
 * back (before re-encoding), so a retried run recognises what it already stored.
 */
export function pictureFingerprint(decoded: Buffer): string {
  return crypto.createHash('sha256').update(decoded).digest('hex');
}

/**
 * What kind of library row a picture becomes. One with transparency is a cut-out, a
 * logo or a badge — a designed picture that must be shown WHOLE ('graphic' is placed
 * with fit 'contain'). An opaque one is a photograph ('photo', placed with 'cover').
 */
export function documentPictureKind(hasAlpha: boolean): 'photo' | 'graphic' {
  return hasAlpha ? 'graphic' : 'photo';
}

/** Where a lifted picture is stored: the magazine's own media folder, never a key
 *  another write could have. */
export function documentPhotoKey(magazineId: string, ext: string): string {
  const safeExt = /^[a-z0-9]{2,5}$/.test(ext) ? ext : 'jpg';
  return `public/magazinesV2/${magazineId}/media/${crypto.randomUUID()}.${safeExt}`;
}

export interface DocumentPhotoRowInput {
  magazineId: string;
  /** The document it came from (its id in this magazine, as list_documents names it). */
  docId: string;
  docName: string;
  /** 1-based page OF THE DOCUMENT, as a person says it. */
  docPage: number;
  /** 1-based number of the picture on that page. */
  n: number;
  key: string;
  url: string;
  contentType: string;
  size: number;
  /** The stored picture's own pixel size, when its header could be read. */
  natural: PixelSize | null;
  hasAlpha: boolean;
  fingerprint: string;
  now: string;
}

/**
 * The media-library row for one lifted picture.
 *
 *  - `pageIndex: null`: it belongs to no page of the magazine. processPage records an
 *    import's pictures against the MAGAZINE page they land on, and rankMediaForPage
 *    ranks by it; the document's own page number there would rank the photo for
 *    whichever magazine page happens to share it.
 *  - The alt names the document, page and picture ("Results.pdf — page 2, picture 1"),
 *    and docName/docPage say the same for list_media and the media panel (mediaOrigin:
 *    'from “Results.pdf”, page 2'), so the picture the user means can be found.
 *  - `source: 'extracted'` with a docId: lifted from a document, not uploaded.
 */
export function documentPhotoRow(input: DocumentPhotoRowInput): Record<string, unknown> {
  const docPage = Math.max(1, Math.round(input.docPage));
  return {
    magazineId: input.magazineId,
    pageIndex: null,
    key: input.key,
    url: input.url,
    contentType: input.contentType,
    size: input.size,
    ...(input.natural ? { width: input.natural.width, height: input.natural.height } : {}),
    alt: documentPhotoAlt(input.docName, docPage, input.n),
    kind: documentPictureKind(input.hasAlpha),
    source: 'extracted',
    docId: input.docId,
    docName: String(input.docName ?? '').trim().slice(0, 160) || 'document',
    docPage,
    contentHash: input.fingerprint,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/** A media row as the de-duplication reads it. */
export interface LibraryRow {
  _id?: unknown;
  kind?: unknown;
  docId?: unknown;
  contentHash?: unknown;
  originalName?: unknown;
  size?: unknown;
  contentType?: unknown;
}

/**
 * What one extraction run must not store again, from the magazine's whole media library:
 *
 *   seen       the fingerprints of EVERY picture already lifted out of any document of
 *              this magazine. Scoped to one document, the same PDF attached twice (a
 *              new document id each time) stored all its pictures again — up to 60 more
 *              objects and rows per attach;
 *   existing   how many pictures THIS document already has (its per-document cap and
 *              the run's "new pictures" count);
 *   twinDocId  another upload of the same file on this magazine — same name, size and
 *              type — whose pictures are already in the library. A re-upload then needs
 *              no MuPDF run at all. Name and size are the only identity an upload row
 *              has; two different PDFs agreeing on both to the byte is not a real case,
 *              and `seen` would still stop a duplicate if it were.
 */
export function documentPhotoDedupe(rows: ReadonlyArray<LibraryRow>, docId: string): { seen: Set<string>; existing: number; twinDocId: string | null } {
  const seen = new Set<string>();
  const picturesOf = new Map<string, number>();
  for (const r of rows) {
    if (typeof r.docId !== 'string' || !r.docId) continue;
    picturesOf.set(r.docId, (picturesOf.get(r.docId) ?? 0) + 1);
    if (typeof r.contentHash === 'string' && r.contentHash) seen.add(r.contentHash);
  }
  const existing = picturesOf.get(docId) ?? 0;
  const self = rows.find((r) => r.kind === 'doc' && String(r._id) === docId);
  let twinDocId: string | null = null;
  if (self && existing === 0 && typeof self.originalName === 'string' && Number(self.size) > 0) {
    const twin = rows.find(
      (r) =>
        r.kind === 'doc' &&
        String(r._id) !== docId &&
        r.originalName === self.originalName &&
        Number(r.size) === Number(self.size) &&
        r.contentType === self.contentType &&
        (picturesOf.get(String(r._id)) ?? 0) > 0,
    );
    twinDocId = twin ? String(twin._id) : null;
  }
  return { seen, existing, twinDocId };
}
