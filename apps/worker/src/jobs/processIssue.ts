// ---------------------------------------------------------------------------
// Magazine Builder v2 — whole-issue PDF extraction + single-page retry.
// Adapted from campaign-hq (apps/worker/src/jobs/processIssue.ts) to
// stable-press: raw Mongo driver, COL.* collections, no tenantId, pages keyed
// by stable _id (we create placeholders up front and map index → _id, since
// our db layer has no upsert-by-filter).
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import { db } from '../../../server/src/lib/db.js';
import { storage } from '../../../server/src/lib/storage.js';
import { COL } from '../../../server/src/lib/magazineV2/collections.js';
import { PAGE_W, PAGE_H, MAX_PAGES_PER_ISSUE } from '../../../server/src/lib/magazineV2/config.js';
import { normalizeElements } from '../../../server/src/lib/magazineV2/writePipeline.js';
import { openPdf, countPages } from '../lib/pdf.js';
import { magazineDocument } from '../../../server/src/lib/magazineV2/magazineDocs.js';
import { convertDocxToPdf } from '../lib/docx.js';
import { toStoredImportImage } from '../lib/image.js';
import { mapWithConcurrency } from '../lib/pool.js';
import { processSinglePage, type ProcessedPageResult } from './processPage.js';
import { copiedFromOf, coverAfterReplace, sourceIndexOf } from './pageWrite.js';

/** DOCX mime, and a key-suffix fallback — used to convert Word docs to PDF
 *  before extraction (the pipeline downstream only understands PDF). */
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
function isDocx(src: { key?: string; mimeType?: string } | undefined): boolean {
  return src?.mimeType === DOCX_MIME || !!src?.key?.toLowerCase().endsWith('.docx');
}

/** A directly-uploaded photo/scan (JPEG/PNG). It imports as a single
 *  pixel-faithful page — no MuPDF pass — via processImageIssue below. */
function isImage(src: { key?: string; mimeType?: string } | undefined): boolean {
  const mime = src?.mimeType ?? '';
  if (mime === 'image/jpeg' || mime === 'image/png') return true;
  const key = src?.key?.toLowerCase() ?? '';
  return key.endsWith('.jpg') || key.endsWith('.jpeg') || key.endsWith('.png');
}

const PAGE_CONCURRENCY = Math.max(1, Number(process.env.MAGAZINE_V2_PAGE_CONCURRENCY ?? 3));

/* eslint-disable @typescript-eslint/no-explicit-any */
type Doc = { _id: string; [k: string]: any };

/** Digitize a freshly-uploaded PDF into pages + editable elements. */
export async function processIssue(payload: { issueId: string }): Promise<void> {
  const { issueId } = payload;
  const issue = (await db.collection(COL.magazines).findById(issueId)) as Doc | null;
  if (!issue) return; // deleted before the job ran — nothing to do
  const now = () => new Date().toISOString();
  // MuPDF Document lives in the WASM heap (not GC'd) — free it in finally so the
  // fz_document + its cached page tree don't leak once this issue is processed.
  let doc: ReturnType<typeof openPdf> | null = null;

  try {
    const src = issue.sourceFile as { key?: string; mimeType?: string } | undefined;
    if (!src?.key) throw new Error('No source file to process.');

    // A single uploaded photo/scan doesn't go through MuPDF — it becomes one
    // pixel-faithful page carrying a full-bleed image element.
    if (isImage(src)) {
      await processImageIssue(issue, src);
      return;
    }

    let buffer = await storage.downloadObject(src.key);
    // Word docs: convert to PDF up front (via LibreOffice) so the rest of the
    // pipeline — openPdf and every per-page extractor — is unchanged.
    if (isDocx(src)) buffer = await convertDocxToPdf(buffer);
    doc = openPdf(buffer);
    const totalPages = countPages(doc);
    if (totalPages <= 0) throw new Error('This file has no pages to process.');

    const capped = Math.min(totalPages, MAX_PAGES_PER_ISSUE);
    await db.collection(COL.magazines).updateOne(issueId, {
      pagesTotal: capped,
      pagesProcessed: 0,
      stage: 'Digitizing pages',
      // No silent caps: if we truncate, say so on the issue.
      processingError: capped < totalPages ? `Only the first ${capped} of ${totalPages} pages were processed (per-issue page cap).` : '',
      sourceFile: { ...issue.sourceFile, pageCount: totalPages },
      updatedAt: now(),
    });

    // Clear any pages from a prior partial run (retry safety), then create a
    // "pending" placeholder per page up front so the UI shows pending (not
    // "missing") as pages finish out of order under concurrency.
    for (const p of (await db.collection(COL.pages).find({ magazineId: issueId })) as Doc[]) {
      await db.collection(COL.pages).deleteOne(p._id);
    }
    const pageIds: string[] = [];
    for (let i = 0; i < capped; i++) {
      pageIds[i] = await db.collection(COL.pages).insertOne({
        magazineId: issueId,
        index: i,
        width: PAGE_W,
        height: PAGE_H,
        background: { type: 'color', value: '#ffffff' },
        elements: [],
        status: 'pending',
        selectedForPublish: true,
        rev: 0,
        // Which page of the source file this is. Equal to `index` today, but
        // `index` is the page's POSITION and moves when pages are inserted or
        // reordered; a later retry must re-extract the page it came from, not
        // whatever source page now shares its position. See sourceIndexOf.
        sourceIndex: i,
        createdAt: now(),
        updatedAt: now(),
      });
    }

    let done = 0;
    let coverImage = '';
    const indices = Array.from({ length: capped }, (_v, i) => i);
    await mapWithConcurrency(indices, PAGE_CONCURRENCY, async (index) => {
      // A fresh import: source page N is magazine page N, so targetIndex = index.
      const result = await processSinglePage(doc!, index, { issueId, pageId: pageIds[index]!, targetIndex: index });
      if (index === 0 && result?.backgroundUrl) coverImage = result.backgroundUrl;
      done += 1;
      await db.collection(COL.magazines).updateOne(issueId, { pagesProcessed: done });
    });

    const failedCount = ((await db.collection(COL.pages).find({ magazineId: issueId, status: 'failed' })) as Doc[]).length;
    if (failedCount >= capped) {
      await db.collection(COL.magazines).updateOne(issueId, {
        status: 'failed',
        processingError: 'Every page failed to process — the file may be corrupted or unreadable.',
        stage: '',
        updatedAt: now(),
      });
    } else {
      // Keep the truncation note if we capped; otherwise report partial failures
      // (or clear on a clean run).
      let processingError = '';
      if (failedCount > 0) processingError = `${failedCount} of ${capped} page(s) failed to process — retry them individually.`;
      else if (capped < totalPages) processingError = `Only the first ${capped} of ${totalPages} pages were processed (per-issue page cap).`;
      await db.collection(COL.magazines).updateOne(issueId, {
        status: 'ready',
        ...(coverImage ? { coverImage } : {}),
        processingError,
        generatedAt: now(),
        stage: '',
        updatedAt: now(),
      });
    }
  } catch (err) {
    // Idempotent (clears pages up top) → RETHROW so the queue retries transient
    // failures instead of marking the job done; the queue records the terminal
    // 'failed' status on the issue only once attempts are exhausted.
    const message = err instanceof Error ? err.message : 'Processing failed';
    console.error(`[worker] issue ${issueId} failed:`, message);
    throw err instanceof Error ? err : new Error(message);
  } finally {
    doc?.destroy();
  }
}

/** Import a single uploaded JPEG/PNG as a one-page issue: store the image as a
 *  real MediaAsset and place it full-bleed on a page sized to the image (so the
 *  canonical coordinate space matches the raster 1:1). Editable like any other
 *  page afterwards. Idempotent — clears any prior pages first (retry safety). */
async function processImageIssue(issue: Doc, src: { key?: string; mimeType?: string }): Promise<void> {
  const issueId = issue._id;
  const now = () => new Date().toISOString();

  const raw = await storage.downloadObject(src.key!);
  const stored = await toStoredImportImage(raw);
  // Under `public/` like every other upload, so the bucket serves the page image
  // directly. It was the one write in the magazine pipeline that wasn't: the key
  // sat outside `public/`, which made publicUrl() hand back an /api/uploads/file
  // proxy URL and pushed every view of an imported image page through the API.
  const key = `${storage.PUBLIC_PREFIX}magazinesV2/${issueId}/${crypto.randomUUID()}-source.${stored.ext}`;
  await storage.uploadObject({ key, contentType: stored.contentType, body: stored.buffer });
  const url = storage.publicUrl(key);

  const assetId = await db.collection(COL.media).insertOne({
    magazineId: issueId,
    pageIndex: 0,
    key,
    url,
    contentType: stored.contentType,
    size: stored.buffer.length,
    alt: '',
    kind: 'photo',
    source: 'extracted',
    createdAt: now(),
    updatedAt: now(),
  });

  // Clear any pages from a prior partial run (retry safety), then create the one page.
  for (const p of (await db.collection(COL.pages).find({ magazineId: issueId })) as Doc[]) {
    await db.collection(COL.pages).deleteOne(p._id);
  }
  const elements = normalizeElements(
    [
      {
        type: 'image',
        x: 0,
        y: 0,
        w: stored.width,
        h: stored.height,
        rotation: 0,
        zIndex: 0,
        locked: false,
        source: 'extracted',
        confidence: 1,
        image: { assetId: String(assetId), url, alt: '', fit: 'cover' },
      },
    ],
    { width: stored.width, height: stored.height },
  );
  await db.collection(COL.pages).insertOne({
    magazineId: issueId,
    index: 0,
    width: stored.width,
    height: stored.height,
    background: { type: 'color', value: '#ffffff' },
    elements,
    status: 'extracted',
    selectedForPublish: true,
    rev: 0,
    createdAt: now(),
    updatedAt: now(),
  });

  await db.collection(COL.magazines).updateOne(issueId, {
    status: 'ready',
    pagesTotal: 1,
    pagesProcessed: 1,
    coverImage: url,
    processingError: '',
    generatedAt: now(),
    stage: '',
    sourceFile: { ...issue.sourceFile, pageCount: 1 },
    updatedAt: now(),
  });
}

/** Re-run extraction for ONE page (the retry endpoint). Re-downloads + re-opens
 *  the source (the worker may have restarted since the original job). */
export async function processPageJob(payload: { issueId: string; pageId: string; index: number }): Promise<void> {
  const { issueId, pageId } = payload;
  const issue = (await db.collection(COL.magazines).findById(issueId)) as Doc | null;
  if (!issue) return;
  // A magazine built with AI has no source file of its own, but a page on it copied
  // from an attached PDF can still be retried — by copying it again (below). So the
  // source is only required once we know the page was not a copy.
  const src = issue.sourceFile as { key?: string; mimeType?: string } | undefined;
  const now = () => new Date().toISOString();

  // The payload's `index` is the page's POSITION when the retry was asked for. The
  // page itself knows better: which source page it was imported from, or which
  // attached document it was copied from. The job's payload shape is unchanged —
  // this only reads the page it was already pointed at.
  const page = (await db.collection(COL.pages).findById(pageId)) as Doc | null;
  if (!page) {
    // Deleted since the retry was queued: nothing to rebuild, but the magazine's
    // status may still be waiting on this page.
    await reconcileAfterRetry(issue, issueId);
    return;
  }
  const targetIndex = Number(page.index) || 0;

  // A page made by "copy this page" is retried by copying it again. Re-extracting
  // the magazine's own source here would put a different page's content on it.
  const copied = copiedFromOf(page);
  if (copied) {
    await copyDocumentPageJob({ issueId, pageId, docId: copied.docId, sourcePage: copied.sourcePage });
    await reconcileAfterRetry(issue, issueId);
    return;
  }
  if (!src?.key) {
    // Nothing to re-extract from. Said on the page, so a retry never leaves it
    // spinning as 'pending' (the route has already marked it so).
    await db.collection(COL.pages).updateOne(pageId, { status: 'failed', error: 'This magazine has no source file to re-extract this page from.', updatedAt: now() });
    return;
  }
  const index = sourceIndexOf(page, payload.index);

  // Image issues have a single page and no MuPDF pass — a retry just rebuilds it.
  if (isImage(src)) {
    try {
      await processImageIssue(issue, src);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Page retry failed';
      await db.collection(COL.pages).updateOne(pageId, { status: 'failed', error: message, updatedAt: now() });
    }
    return;
  }

  let doc: ReturnType<typeof openPdf> | null = null;
  try {
    let buffer = await storage.downloadObject(src.key);
    // Same DOCX→PDF conversion as the full run — a retry re-downloads the
    // original source, which may be a Word doc.
    if (isDocx(src)) buffer = await convertDocxToPdf(buffer);
    doc = openPdf(buffer);
    if (index >= countPages(doc)) {
      throw new Error(`The source file has no page ${index + 1} to re-extract.`);
    }
    const result = await processSinglePage(doc, index, { issueId, pageId, targetIndex });
    await followCover(issueId, targetIndex, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Page retry failed';
    await db.collection(COL.pages).updateOne(pageId, { status: 'failed', error: message, updatedAt: now() });
  } finally {
    doc?.destroy();
  }

  await reconcileAfterRetry(issue, issueId);
}

/** After a retry: an import that was still 'processing' (or had 'failed') settles
 *  on what its pages now say. A 'ready' magazine is left alone. */
async function reconcileAfterRetry(issue: Doc, issueId: string): Promise<void> {
  const now = () => new Date().toISOString();
  const all = (await db.collection(COL.pages).find({ magazineId: issueId })) as Doc[];
  const failed = all.filter((p) => p.status === 'failed').length;
  if (issue.status === 'processing' || issue.status === 'failed') {
    await db.collection(COL.magazines).updateOne(issueId, {
      status: failed >= all.length && all.length > 0 ? 'failed' : 'ready',
      processingError: failed > 0 ? `${failed} of ${all.length} page(s) failed to process.` : '',
      stage: '',
      updatedAt: now(),
    });
  }
}

/**
 * Copy ONE page of an ATTACHED PDF onto ONE page of this magazine, verbatim.
 *
 * The same extractor as import and retry — `processSinglePage` already takes the
 * opened document as an argument, so nothing about the extraction changes here.
 * What changes is only where the bytes come from: any PDF the magazine holds,
 * resolved through `magazineDocument`, rather than the single `sourceFile` the
 * magazine was born from. That one substitution is the whole feature.
 *
 * THE TARGET PAGE TAKES THE SOURCE PAGE'S DIMENSIONS. `processSinglePage` writes
 * the raster's width/height onto the page, so copying an A4 page onto a page of
 * another shape re-shapes it. That is deliberate and is what "copy this page"
 * means — a page reproduced at a different aspect is not a copy — but it does mean
 * one page of a magazine can end up a different shape from its neighbours. The
 * route's confirm says so before it is enqueued, and the Download PDF prints every
 * page on a sheet of its own size (BulletinViewer.tsx named @page rules + lib/pdf.ts
 * preferCSSPageSize), so a differently shaped page is neither clipped nor spilled.
 *
 * WHERE IT LANDS vs WHERE IT COMES FROM. `sourcePage` is the attached document's
 * page; the target page's own `index` is its place in this magazine. Media are
 * recorded against the target, and the background is stored under a key of its
 * own (pageWrite.ts backgroundKey) — keying it by the source page number is what
 * once made a copy overwrite the cover's artwork and the published edition's.
 *
 * A PAGE WITH NO TEXT LAYER (a scan, or type converted to outlines) still copies,
 * as a picture, and the page records `notice` ('scanned' | 'no-text') so the
 * studio and the assistants can say why its words cannot be edited.
 *
 * Never throws for a per-page problem: the page records `failed` + the reason, the
 * same contract processPageJob follows, so a bad page is visible in the rail rather
 * than as a dead job.
 */
export async function copyDocumentPageJob(payload: {
  issueId: string;
  pageId: string;
  docId: string;
  sourcePage: number;
}): Promise<void> {
  const { issueId, pageId, docId } = payload;
  // 1-based as a person says it; the extractor indexes from 0.
  const sourcePage = Math.max(1, Math.floor(Number(payload.sourcePage) || 1));
  const copiedFrom = { docId: String(docId), sourcePage };
  const now = () => new Date().toISOString();
  // A failed copy still records what was attempted, so the page's Retry re-runs
  // THIS copy instead of re-extracting the magazine's own source onto it.
  const fail = async (message: string) => {
    await db.collection(COL.pages).updateOne(pageId, { status: 'failed', error: message, copiedFrom, updatedAt: now() });
  };

  // The TARGET page, for its position in the magazine. `sourcePage` says where the
  // content comes from; this says where it lands, and the two must never be mixed
  // up again (that is how a copy once overwrote the cover's background).
  const target = (await db.collection(COL.pages).findById(pageId)) as Doc | null;
  if (!target) return; // the page was deleted while the job waited
  const targetIndex = Number(target.index) || 0;

  // Re-resolved in the worker rather than trusted from the payload: the job may have
  // sat in the queue while the document was deleted, and this is also the scope check
  // (the magazine is the allow-list) applied a second time at the point of use.
  const source = await magazineDocument(String(issueId), String(docId));
  if (!source) {
    await fail('That document is no longer attached to this magazine.');
    return;
  }

  let doc: ReturnType<typeof openPdf> | null = null;
  try {
    const buffer = await storage.downloadObject(source.s3Key);
    doc = openPdf(buffer);
    const index = sourcePage - 1;
    const total = countPages(doc);
    if (index >= total) {
      await fail(`“${source.name}” has ${total} page${total === 1 ? '' : 's'}, so there is no page ${sourcePage} to copy.`);
      return;
    }
    const result = await processSinglePage(doc, index, { issueId, pageId, targetIndex, copiedFrom });
    if (result) {
      await followCover(issueId, targetIndex, result);
      console.log(
        `[magazineV2] copied page ${sourcePage} of “${source.name}” onto page ${pageId}${result.notice ? ` (${result.notice}: no editable text)` : ''}`,
      );
    } else {
      // processSinglePage recorded the failure and its reason; add the provenance.
      await db.collection(COL.pages).updateOne(pageId, { copiedFrom });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Copying that page failed';
    console.warn('[magazineV2] copyDocumentPage failed:', message);
    await fail(message);
  } finally {
    doc?.destroy();
  }

  // The magazine's own stamp, so the studio's poll sees the change. No status
  // reconciliation here: unlike import, this touches ONE page of a magazine that was
  // already 'ready', and flipping the magazine's status off the back of one page
  // would be wrong.
  await db.collection(COL.magazines).updateOne(issueId, { updatedAt: now() });
}

/**
 * Keep a DERIVED cover in step when the first page gets a new background.
 *
 * Every background write now has its own key (pageWrite.ts backgroundKey), so the
 * cover can no longer change by accident when page 1 is rebuilt — which also means
 * it would not change when it SHOULD. Import set coverImage to page 1's background;
 * if it still is that old URL, it follows the page. An explicit cover the user
 * picked is a different URL and stays. Compare-and-set on the old value so a cover
 * chosen while the job ran is never clobbered. Best-effort: the page is already
 * written, and a stale thumbnail is not worth failing the job over.
 */
async function followCover(issueId: string, targetIndex: number, result: ProcessedPageResult | null): Promise<void> {
  if (!result) return;
  try {
    const issue = (await db.collection(COL.magazines).findById(issueId)) as Doc | null;
    const next = coverAfterReplace({
      coverImage: issue?.coverImage,
      targetIndex,
      previousBackground: result.previousBackgroundUrl,
      newBackground: result.backgroundUrl,
    });
    if (next && issue) {
      await db.collection(COL.magazines).updateOneIf(issueId, { coverImage: issue.coverImage }, { coverImage: next });
    }
  } catch (err) {
    console.warn('[worker] could not update the derived cover (page is written):', err instanceof Error ? err.message : err);
  }
}
