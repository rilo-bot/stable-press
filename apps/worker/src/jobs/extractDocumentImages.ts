// ---------------------------------------------------------------------------
// Magazine Builder v2 — lift the pictures out of an attached PDF into the media
// library (finding C45), so "use the horse photo from page 2 of the PDF" places the
// client's own picture.
//
// Started by POST /issues/:id/uploads for every PDF (attached in the Design Helper,
// by The Stable Hand, or added in the Uploads tab). It NEVER touches a page: each
// picture becomes one placeable row, labelled with the document and page it came
// from (documentPhotos.ts says what each row holds and why). The Studio's list_media
// and the media panel then show it like any other picture.
//
// The extraction is the import's own (rasterizePage + the soft-mask composite +
// toStoredImage), minus the page render: only the embedded pictures are wanted.
// ---------------------------------------------------------------------------

import { db } from '../../../server/src/lib/db.js';
import { storage } from '../../../server/src/lib/storage.js';
import { COL } from '../../../server/src/lib/magazineV2/collections.js';
import { canCopyLayout, magazineDocument } from '../../../server/src/lib/magazineV2/magazineDocs.js';
import { imageDimensions } from '../../../server/src/lib/magazineV2/media.js';
import { enqueueJob } from '../../../server/src/lib/magazineV2/jobs.js';
import { openPdf, countPages, rasterizePage } from '../lib/pdf.js';
import { applyAlphaMask, toStoredImage } from '../lib/image.js';
import {
  DOCUMENT_PHOTO_LIMITS,
  documentPhotoBatch,
  documentPhotoDedupe,
  documentPhotoKey,
  documentPhotoRow,
  documentPictureWorthKeeping,
  pictureFingerprint,
  type LibraryRow,
} from './documentPhotos.js';

/**
 * The payload carries `magazineId`, deliberately NOT `issueId`. Both watchdogs (the
 * worker's sweep and the API's heal-on-read, jobs.ts healStuckIssue) treat any job
 * whose payload names an `issueId` as part of building that magazine: while it is
 * queued it keeps a stalled build looking alive, and if it dies it can mark a
 * magazine that is still 'processing' as failed. Lifting pictures out of a document
 * has nothing to do with the magazine's build, so it must not be able to do either.
 *
 * `fromPage` (0-based) is where a continuation starts: a document is read
 * DOCUMENT_PHOTO_LIMITS.batchPages pages per run (documentPhotoBatch).
 */
export interface ExtractDocumentImagesPayload {
  magazineId: string;
  docId: string;
  fromPage?: number;
}

/**
 * Store every worthwhile picture in one of the magazine's PDFs as a library row, a
 * batch of pages per run, queueing the next batch behind whatever else is waiting.
 *
 * Idempotent ACROSS THE MAGAZINE: the rows carry a fingerprint of the decoded picture,
 * and a picture already stored from ANY document of this magazine is skipped — so a
 * retry after a crash finishes the job instead of storing everything twice, and the
 * same PDF attached again (every upload is a new document id, and The Stable Hand may
 * attach one brochure in several turns) adds no new rows or objects. A re-upload whose
 * twin — same file name, size and type on this magazine — already has its pictures in
 * the library is not even opened, so it does not queue MuPDF batches ahead of other
 * people's builds. A missing magazine or document, or a file that is not a PDF, ends
 * quietly (nothing to do). Per-picture problems are logged and skipped; only a failure
 * to read the file at all throws, so the queue retries it.
 */
export async function extractDocumentImagesJob(
  payload: ExtractDocumentImagesPayload,
  ctx?: { beat?: () => Promise<void> },
): Promise<void> {
  const magazineId = String(payload?.magazineId ?? '');
  const docId = String(payload?.docId ?? '');
  if (!magazineId || !docId) return;
  // The magazine may have been deleted while the job waited (findById treats a
  // soft-deleted one as gone).
  const magazine = await db.collection(COL.magazines).findById(magazineId);
  if (!magazine) return;
  // Re-resolved here rather than trusted from the payload: the magazine is the
  // allow-list, and the document may have been removed while the job waited.
  const source = await magazineDocument(magazineId, docId);
  if (!source || !canCopyLayout(source)) return;

  const library = (await db.collection(COL.media).find({ magazineId })) as LibraryRow[];
  const plan = documentPhotoDedupe(library, source.docId);
  if (plan.twinDocId) {
    console.log(`[magazineV2] “${source.name}”: the same file is already on this magazine with its pictures in the library — nothing to extract.`);
    return;
  }
  const existing = plan.existing;
  const seen = plan.seen;
  let stored = existing;
  if (stored >= DOCUMENT_PHOTO_LIMITS.maxPhotos) return;

  let doc: ReturnType<typeof openPdf> | null = null;
  let next: number | null = null;
  try {
    doc = openPdf(await storage.downloadObject(source.s3Key));
    const batch = documentPhotoBatch(payload.fromPage, countPages(doc));
    next = batch.next;
    for (let index = batch.start; index < batch.end && stored < DOCUMENT_PHOTO_LIMITS.maxPhotos; index++) {
      let raster: ReturnType<typeof rasterizePage>;
      try {
        raster = rasterizePage(doc, index, { imagesOnly: true });
      } catch (err) {
        console.warn(`[worker] extractDocumentImages: page ${index + 1} of “${source.name}” could not be read:`, err instanceof Error ? err.message : err);
        continue;
      }
      // "picture k" counts every worthwhile picture on the page in reading order, the
      // ones already stored included, so a retried run names each one the same way.
      let n = 0;
      for (const img of raster.imageBlocks) {
        if (stored >= DOCUMENT_PHOTO_LIMITS.maxPhotos) break;
        try {
          if (!documentPictureWorthKeeping(imageDimensions(img.png))) continue;
          n += 1;
          const fingerprint = pictureFingerprint(img.png);
          if (seen.has(fingerprint)) continue;
          seen.add(fingerprint);
          // The soft mask back in as real alpha (rounded corners, cut-outs), then the
          // import's own encoding: alpha stays PNG, opaque goes to JPEG.
          const composed = img.maskPng ? await applyAlphaMask(img.png, img.maskPng) : img.png;
          const out = await toStoredImage(composed, { hasAlpha: img.hasAlpha, quality: 85, maxWidth: 2000 });
          const key = documentPhotoKey(magazineId, out.ext);
          await storage.uploadObject({ key, contentType: out.contentType, body: out.buffer });
          await db.collection(COL.media).insertOne(
            documentPhotoRow({
              magazineId,
              docId: source.docId,
              docName: source.name,
              docPage: index + 1,
              n,
              key,
              url: storage.publicUrl(key),
              contentType: out.contentType,
              size: out.buffer.length,
              natural: imageDimensions(out.buffer),
              hasAlpha: img.hasAlpha,
              fingerprint,
              now: new Date().toISOString(),
            }),
          );
          stored += 1;
        } catch (err) {
          console.warn(`[worker] extractDocumentImages: a picture on page ${index + 1} of “${source.name}” was skipped:`, err instanceof Error ? err.message : err);
        }
      }
      // One beat per page: the job is then judged on its progress, not on how long a
      // long document takes.
      await ctx?.beat?.();
    }
    console.log(
      `[magazineV2] “${source.name}” pages ${batch.start + 1}–${batch.end}: ${stored - existing} new picture(s) in the media library (${stored} in all)${next !== null && stored < DOCUMENT_PHOTO_LIMITS.maxPhotos ? '; the rest is queued' : ''}`,
    );
  } finally {
    doc?.destroy();
  }
  // The rest of the document goes to the back of the queue, so a page copy or an
  // import started meanwhile runs first. Last act of the run, after the file is closed.
  if (next !== null && stored < DOCUMENT_PHOTO_LIMITS.maxPhotos) {
    await enqueueJob('extractDocumentImages', { magazineId, docId: source.docId, fromPage: next });
  }
}
