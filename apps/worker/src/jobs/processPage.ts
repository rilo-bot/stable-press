// ---------------------------------------------------------------------------
// Magazine Builder v2 — single-page extraction (rasterize → erase glyphs →
// reconstruct editable elements → persist). Adapted from campaign-hq
// (apps/worker/src/jobs/processPage.ts) to stable-press: raw Mongo driver +
// COL.* collections + our normalizeElements write pipeline + mediaAssetsV2, no
// tenantId, pages addressed by stable _id.
//
// Geometry/typography are ALWAYS from MuPDF (pixel-exact). The vision tagger
// only labels roles + flags icon/QR/logo graphics; it never repositions.
// Never throws for a per-page problem — records status:"failed"+error on the
// page and returns null so the rest of the issue keeps processing.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import { db } from '../../../server/src/lib/db.js';
import { storage } from '../../../server/src/lib/storage.js';
import { COL } from '../../../server/src/lib/magazineV2/collections.js';
import { normalizeElements } from '../../../server/src/lib/magazineV2/writePipeline.js';
import type { TextRole } from '../../../server/src/lib/magazineV2/model.js';
import { rasterizePage, type PageRaster, type openPdf } from '../lib/pdf.js';
import { toStoredJpeg, toStoredImage, toVisionJpeg, eraseTextRegions, cropRegion, applyAlphaMask } from '../lib/image.js';
import { classifyPage, type GraphicKind, type ClassifiedGraphic } from '../lib/ai.js';
import { backgroundKey, pageNotice, revBump, type CopiedFrom, type PageNotice } from './pageWrite.js';

const GRAPHIC_LABEL: Record<GraphicKind, string> = { icon: 'Icon', qr: 'QR code', logo: 'Logo' };
const MIN_GRAPHIC_PX = 8; // below this, a "graphic" crop is unusable noise

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function overlapArea(a: Rect, b: Rect): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

export interface ProcessedPageResult {
  pxWidth: number;
  pxHeight: number;
  backgroundUrl: string;
  /** The page's background URL before this write ('' when it had none), so a
   *  caller can tell whether the magazine's cover was derived from it. */
  previousBackgroundUrl: string;
  /** Why the page has no editable words, if it has none. See pageWrite.ts. */
  notice: PageNotice;
}

/**
 * Where the page being written stands, beyond the source page `index`.
 *
 * `index` is the page of the OPENED PDF to extract. It is not the magazine page:
 * a copy takes page 1 of another document onto page 6, and a retry runs after
 * pages may have been inserted. Mixing the two up is what made a copy overwrite
 * the cover's background, so the target is named separately:
 *
 *   targetIndex  the magazine page's own index (media ranking uses it). Defaults
 *                to `index`, which is right only for a fresh import.
 *   copiedFrom   set by "copy this page"; recorded so a retry re-runs the copy
 *                rather than re-extracting the magazine's own source file.
 */
export interface PageWriteContext {
  issueId: string;
  pageId: string;
  targetIndex?: number;
  copiedFrom?: CopiedFrom;
}

/** Rasterize, extract, (optionally) classify, and persist ONE page. Never
 *  throws — records failure on the page doc and returns null. */
export async function processSinglePage(
  doc: ReturnType<typeof openPdf>,
  index: number,
  ctx: PageWriteContext,
): Promise<ProcessedPageResult | null> {
  const now = () => new Date().toISOString();
  try {
    const raster = rasterizePage(doc, index);
    // The reconstructed text elements below are drawn live on top of this
    // background — erase MuPDF's own rendered glyphs first, or the original and
    // reconstructed text both show at once (doubled/garbled).
    const cleanBackgroundPng = await eraseTextRegions(raster.backgroundPng, raster.textBlocks);
    const backgroundUrl = await uploadBackground(cleanBackgroundPng, ctx.issueId, ctx.pageId);
    const rawElements = await buildRawElements(raster, ctx.issueId, index, ctx.targetIndex ?? index);
    // The single write pipeline: validate → sanitize → refit (refit is a no-op
    // for extracted text, which carries no maxFontSize, so measured sizes stay).
    const elements = normalizeElements(rawElements, { width: raster.pxWidth, height: raster.pxHeight });
    const notice = pageNotice({ textBlockCount: raster.textBlocks.length, fullPageImage: raster.fullPageImage });
    if (notice) {
      console.log(`[worker] page ${index} of issue ${ctx.issueId} has no text layer (${notice}) — copied as a picture.`);
    }

    const previous = await writeReplacedPage(ctx.pageId, {
      width: raster.pxWidth,
      height: raster.pxHeight,
      background: { type: 'image', value: backgroundUrl },
      elements,
      status: 'extracted',
      error: '',
      // Rewritten on every extraction so a re-copy of a text page clears the
      // notice an earlier scan left behind.
      notice,
      // Provenance, so a retry knows what to re-run (see sourceIndexOf /
      // copiedFromOf). A copy is no longer the magazine's own source page.
      ...(ctx.copiedFrom
        ? { copiedFrom: ctx.copiedFrom, sourceIndex: null }
        : { sourceIndex: index, copiedFrom: null }),
      updatedAt: now(),
    });
    return {
      pxWidth: raster.pxWidth,
      pxHeight: raster.pxHeight,
      backgroundUrl,
      previousBackgroundUrl: previous,
      notice,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Page processing failed';
    console.error(`[worker] page ${index} of issue ${ctx.issueId} failed:`, message);
    await db.collection(COL.pages).updateOne(ctx.pageId, { status: 'failed', error: message, updatedAt: now() });
    return null;
  }
}

/** How many times the rev compare-and-set is retried before writing regardless. */
const REV_CAS_ATTEMPTS = 3;

/**
 * Replace a page wholesale AND move its rev, returning its previous background URL.
 *
 * The rev is the point. The editor guards every write with the rev it loaded; a
 * rebuild that swaps every element but leaves the rev alone lets a stale canvas
 * keep "succeeding" — the agent's patches land on the new elements while the
 * canvas maps them onto old ids it still shows, and manual edits 404. With the rev
 * moved, the stale canvas gets the 409 it already knows how to recover from (it
 * adopts the fresh page), and The Stable Hand's rev check sees the copy land.
 *
 * Compare-and-set so a concurrent edit is never silently undone by OUR rev
 * arithmetic. On contention it re-reads and tries again; the copy still wins in
 * the end, because replacing the page is exactly what was asked for — what must
 * not happen is the editor's next write passing against a rev that no longer
 * describes the page.
 */
async function writeReplacedPage(pageId: string, fields: Record<string, unknown>): Promise<string> {
  const pages = db.collection(COL.pages);
  const bgOf = (p: Record<string, unknown> | null): string => {
    const bg = p?.background as { type?: unknown; value?: unknown } | undefined;
    return bg?.type === 'image' && typeof bg.value === 'string' ? bg.value : '';
  };
  for (let attempt = 0; attempt < REV_CAS_ATTEMPTS; attempt++) {
    const cur = (await pages.findById(pageId)) as Record<string, unknown> | null;
    // Deleted while the job ran: nothing to write onto (the plain updateOne this
    // replaced was a no-op on a deleted page too).
    if (!cur) return '';
    const { condition, rev } = revBump(cur.rev);
    if (await pages.updateOneIf(pageId, condition, { ...fields, rev })) return bgOf(cur);
  }
  const cur = (await pages.findById(pageId)) as Record<string, unknown> | null;
  if (!cur) return '';
  console.warn(`[worker] page ${pageId} kept changing during the rebuild — writing it with a fresh rev regardless.`);
  // One past whatever is there, so even a write that lands between this read and
  // the update leaves the editor's rev behind the page's.
  await pages.updateOne(pageId, { ...fields, rev: revBump(cur.rev).rev + 1 });
  return bgOf(cur);
}

async function uploadBackground(png: Buffer, issueId: string, pageId: string): Promise<string> {
  const jpeg = await toStoredJpeg(png, { quality: 82 });
  // Images live under `public/` so the bucket's public-read rule serves them
  // directly (S3_PUBLIC_BASE_URL). Source docs stay OUTSIDE `public/` (private).
  //
  // A NEW key for every write, keyed by the target page — never by the source page
  // number, which is what let one page's copy overwrite another page's (often the
  // cover's) background, and the published edition's with it. See backgroundKey.
  const key = backgroundKey({ prefix: storage.PUBLIC_PREFIX, issueId, pageId });
  await storage.uploadObject({ key, contentType: 'image/jpeg', body: jpeg });
  return storage.publicUrl(key);
}

async function insertMedia(opts: {
  issueId: string;
  /** The MAGAZINE page the asset lands on (rankMediaForPage ranks by it), not the
   *  source PDF's page number. */
  pageIndex: number;
  key: string;
  url: string;
  contentType: string;
  size: number;
  alt: string;
  kind: 'photo' | 'graphic';
}): Promise<string> {
  const now = new Date().toISOString();
  return db.collection(COL.media).insertOne({
    magazineId: opts.issueId,
    pageIndex: opts.pageIndex,
    key: opts.key,
    url: opts.url,
    contentType: opts.contentType,
    size: opts.size,
    alt: opts.alt,
    kind: opts.kind,
    source: 'extracted',
    createdAt: now,
    updatedAt: now,
  });
}

/** `index` is the source PDF page (log lines, key hints); `pageIndex` is the
 *  magazine page the extracted media is recorded against. */
async function buildRawElements(raster: PageRaster, issueId: string, index: number, pageIndex: number): Promise<unknown[]> {
  const elements: unknown[] = [];

  // Text: layout/typography ALWAYS from MuPDF (pixel-exact). The vision model,
  // when configured, only tags each block's role by index — never repositions,
  // resizes, merges, or rewrites. Without a key, every block lands role "other".
  let classifiedGraphics: ClassifiedGraphic[] = [];
  const roleByIndex = new Map<number, { role: TextRole; confidence: number }>();
  if (raster.textBlocks.length > 0) {
    const vision = await toVisionJpeg(raster.backgroundPng);
    const classified = await classifyPage({
      pageImageJpeg: vision.buffer,
      roughBlocks: raster.textBlocks,
      pxWidth: raster.pxWidth,
      pxHeight: raster.pxHeight,
    });
    if (classified) {
      classifiedGraphics = classified.graphics;
      for (const r of classified.roles) roleByIndex.set(r.index, { role: r.role, confidence: r.confidence });
    }
  }
  raster.textBlocks.forEach((b, i) => {
    const tagged = roleByIndex.get(i);
    elements.push({
      type: 'text',
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      rotation: 0,
      zIndex: 1,
      locked: false,
      source: 'extracted',
      confidence: tagged?.confidence ?? 0.4,
      text: {
        content: b.text,
        role: tagged?.role ?? 'other',
        fontFamily: b.fontFamily,
        fontSize: b.fontSize,
        fontWeight: b.fontWeight,
        color: b.color,
        align: 'left',
        lineHeight: b.lineHeight,
        autoFit: 'shrink',
      },
    });
  });

  // Images: MuPDF already decoded these — re-encode, upload, record a real
  // MediaAsset (so they appear in the media library too), place at zIndex 0
  // (below text: a hero photo with an overlaid headline is the common case).
  const imageBoxes: Rect[] = [];
  let n = 0;
  for (const img of raster.imageBlocks) {
    n += 1;
    try {
      // Re-attach the PDF soft mask as real alpha first (rounded corners /
      // feathered shadows live in the mask, not the base image).
      const composed = img.maskPng ? await applyAlphaMask(img.png, img.maskPng) : img.png;
      // Alpha-bearing images stay PNG — flattening to JPEG turns transparent
      // pixels black (the black-box bug). Opaque ones go to JPEG.
      const stored = await toStoredImage(composed, { hasAlpha: img.hasAlpha, quality: 85, maxWidth: 2000 });
      const key = `public/magazinesV2/${issueId}/${crypto.randomUUID()}-p${index}-${n}.${stored.ext}`;
      await storage.uploadObject({ key, contentType: stored.contentType, body: stored.buffer });
      const url = storage.publicUrl(key);
      const assetId = await insertMedia({ issueId, pageIndex, key, url, contentType: stored.contentType, size: stored.buffer.length, alt: '', kind: 'photo' });
      elements.push({
        type: 'image',
        x: img.x,
        y: img.y,
        w: img.w,
        h: img.h,
        rotation: 0,
        zIndex: 0,
        locked: false,
        source: 'extracted',
        confidence: 0.8,
        image: { assetId: String(assetId), url, alt: '', fit: 'cover' },
      });
      imageBoxes.push({ x: img.x, y: img.y, w: img.w, h: img.h });
    } catch (err) {
      console.warn(`[worker] failed to store an extracted image on page ${index}:`, err instanceof Error ? err.message : err);
    }
  }

  // Graphics: icon/QR/logo boxes the vision model identified (semantic — geometry
  // alone can't tell a real icon from decorative vector texture). Each needs a
  // real raster crop, unlike a flat-color rule.
  const placedQrBoxes: Rect[] = [];
  let gi = 0;
  for (const g of classifiedGraphics) {
    const boxPx = { x: g.x * raster.pxWidth, y: g.y * raster.pxHeight, w: g.w * raster.pxWidth, h: g.h * raster.pxHeight };
    if (boxPx.w < MIN_GRAPHIC_PX || boxPx.h < MIN_GRAPHIC_PX) continue;
    // Skip a graphic that's already a real embedded image MuPDF pulled out above.
    const alreadyCaptured = imageBoxes.some((box) => overlapArea(boxPx, box) / (boxPx.w * boxPx.h) > 0.5);
    if (alreadyCaptured) continue;

    // A detected QR becomes a LIVE qr element with no destination yet (a printed
    // QR's target can't be recovered from geometry) — the admin sets the link in
    // the editor and a clean code renders client-side. No raster kept.
    if (g.kind === 'qr') {
      placedQrBoxes.push(boxPx);
      elements.push({
        type: 'qr',
        x: boxPx.x,
        y: boxPx.y,
        w: boxPx.w,
        h: boxPx.h,
        rotation: 0,
        zIndex: 1,
        locked: false,
        source: 'extracted',
        confidence: g.confidence,
        qr: { url: '', fg: '#111111', bg: '#ffffff' },
      });
      continue;
    }

    gi += 1;
    try {
      const cropped = await cropRegion(raster.backgroundPng, boxPx);
      const jpeg = await toStoredJpeg(cropped, { quality: 90 });
      const key = `public/magazinesV2/${issueId}/${crypto.randomUUID()}-p${index}-graphic${gi}.jpg`;
      await storage.uploadObject({ key, contentType: 'image/jpeg', body: jpeg });
      const url = storage.publicUrl(key);
      const label = GRAPHIC_LABEL[g.kind];
      const assetId = await insertMedia({ issueId, pageIndex, key, url, contentType: 'image/jpeg', size: jpeg.length, alt: label, kind: 'graphic' });
      elements.push({
        type: 'image',
        x: boxPx.x,
        y: boxPx.y,
        w: boxPx.w,
        h: boxPx.h,
        rotation: 0,
        zIndex: 1,
        locked: false,
        source: 'extracted',
        confidence: g.confidence,
        // "contain" — an icon/QR/logo must stay fully visible, never edge-cropped.
        image: { assetId: String(assetId), url, alt: label, fit: 'contain' },
      });
    } catch (err) {
      console.warn(`[worker] failed to store an extracted graphic on page ${index}:`, err instanceof Error ? err.message : err);
    }
  }

  // QR codes drawn as vector modules (detected in pdf.ts): one live qr element
  // per region, destination blank. Modules were kept out of lineBlocks already.
  for (const r of raster.qrRegions) {
    if (placedQrBoxes.some((b) => overlapArea(r, b) / (r.w * r.h) > 0.4)) continue;
    elements.push({
      type: 'qr',
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      rotation: 0,
      zIndex: 1,
      locked: false,
      source: 'extracted',
      confidence: 0.6,
      qr: { url: '', fg: '#111111', bg: '#ffffff' },
    });
  }

  // Rules/dividers: a hairline is visually a flat-color rectangle → reconstruct
  // as a "shape" directly from its measured box/color (no raster/upload).
  for (const line of raster.lineBlocks) {
    elements.push({
      type: 'shape',
      x: line.x,
      y: line.y,
      w: line.w,
      h: line.h,
      rotation: 0,
      zIndex: 1,
      locked: false,
      source: 'extracted',
      confidence: 0.7,
      shape: { fill: line.color },
    });
  }

  return elements;
}
