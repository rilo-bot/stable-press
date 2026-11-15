// ---------------------------------------------------------------------------
// Magazine Builder v2 — stock photos for AI generation.
//
// The generation art-director writes PHOTO SEARCH TERMS per photo slot (draftPage);
// this turns those terms into a real, stored MediaAsset.
//
// Two ways in:
//   • fetchAndStoreStock — search and store the FIRST hit, unattended (the editor
//     agent, and the generator's fallback when the Photo Director is unavailable);
//     with `avoidUsed`, the first hit the magazine does not hold yet, so "find
//     another photo" really finds another (stockVariety.ts).
//   • searchStockCandidates + storeStockCandidate — search several, let someone
//     (the Photo Director, photoDirector.ts) LOOK at the previews and pick, then
//     store only the chosen one. Nothing is stored for the candidates not chosen.
//
// The SOURCING lives in lib/stock.ts, shared with the Blog Studio. This file
// keeps what is genuinely magazine-specific: the S3 key namespace and the
// MediaAsset row. Everything above that — the Pexels key, the search cache and the
// rate-limit cooldown, downloading the bytes so nothing is hotlinked, and carrying
// the photographer's credit — is the shared module's job.
//
// Every stock row records WHICH photo it is (`stockProvider` + `stockId`, plus the
// photo's `sourceUrl` page): that is what lets a later run ("add pages") seed the
// issue's used-photo ledger exactly (photoDirector.seedStockLedger).
//
// Env-gated: no PEXELS_API_KEY (or no S3) ⇒ isStockConfigured() is false and the
// generator degrades image slots to flat palette blocks instead of failing.
// ---------------------------------------------------------------------------

import { db } from '../db.js';
import {
  findAndStoreStockPhoto,
  isStockConfigured,
  searchStockPhotos,
  storeStockPhoto,
  type StockCandidate,
  type StockOrientation,
  type StoredPhoto,
} from '../stock.js';
import { COL } from './collections.js';
import { chooseStock, type StockMediaRow } from './stockVariety.js';

// Re-exported so the generator's existing imports from this module keep working —
// it asks `isStockConfigured()` before planning a photo slot at all.
export { isStockConfigured };
export type { StockOrientation, StockCandidate };

/** What an image element needs from a stored photo. */
export interface StoredStockImage {
  url: string;
  assetId: string;
  alt: string;
  /** (avoidUsed) This photo was already in the magazine's library: its existing row
   *  is returned and nothing new was stored. */
  reused?: boolean;
  /** (avoidUsed) Every result for the query is already in the magazine — a DIFFERENT
   *  photo needs a different, more specific query. */
  allUsed?: boolean;
}

/** Write the MediaAsset row for a photo already copied into our bucket. */
async function recordStockAsset(stored: StoredPhoto, ctx: { magazineId: string; pageIndex: number }): Promise<StoredStockImage> {
  const now = new Date().toISOString();
  const assetId = await db.collection(COL.media).insertOne({
    magazineId: ctx.magazineId,
    pageIndex: ctx.pageIndex,
    key: stored.key,
    url: stored.url,
    contentType: stored.contentType,
    size: stored.bytes,
    // The provider's pixel size, so a box can be made the photo's own shape.
    ...(stored.width && stored.height ? { width: stored.width, height: stored.height } : {}),
    alt: stored.alt,
    kind: 'photo',
    source: 'stock',
    attribution: stored.attribution,
    stockProvider: stored.provider,
    stockId: stored.providerId,
    ...(stored.sourceUrl ? { sourceUrl: stored.sourceUrl } : {}),
    createdAt: now,
    updatedAt: now,
  });
  return { url: stored.url, assetId: String(assetId), alt: stored.alt };
}

/**
 * Search + store a stock photo as a MediaAsset. Returns the element-ready image
 * reference, or null on no key/S3, no result, or any error (NEVER throws — a
 * missing photo must not fail the page; the caller degrades to a colour block).
 *
 * `avoidUsed` (the Studio's "add a photo" / "find another one"): skip every Pexels
 * photo this magazine already holds and store the next result instead, so a repeat
 * request gets a DIFFERENT picture. When every result is already held, the existing
 * library row of the best match comes back with `reused` + `allUsed` set — no second
 * copy is downloaded or stored (stockVariety.ts). Without it, the top hit is stored,
 * exactly as before (generation keeps its own ledger, photoDirector.ts).
 */
export async function fetchAndStoreStock(
  opts: { query: string; orientation?: StockOrientation; avoidUsed?: boolean },
  ctx: { magazineId: string; pageIndex: number },
): Promise<StoredStockImage | null> {
  if (!isStockConfigured()) return null;
  try {
    const prefix = `public/magazinesV2/${ctx.magazineId}`;
    if (!opts.avoidUsed) {
      const stored = await findAndStoreStockPhoto({ query: opts.query, orientation: opts.orientation }, prefix);
      if (!stored) return null;
      return await recordStockAsset(stored, ctx);
    }
    const rows = (await db.collection(COL.media).find({ magazineId: ctx.magazineId })) as StockMediaRow[];
    // One request returns a page of results (lib/stock.ts SEARCH_PER_PAGE); asking for
    // all of them costs the same quota as asking for one.
    const candidates = await searchStockPhotos(opts.query, { orientation: opts.orientation, count: 12 });
    const choice = chooseStock(candidates, rows);
    if (choice.kind === 'fresh') {
      const stored = await storeStockPhoto(choice.candidate, prefix);
      return stored ? await recordStockAsset(stored, ctx) : null;
    }
    if (choice.kind === 'reuse') {
      return {
        url: String(choice.row.url),
        assetId: String(choice.row._id),
        alt: choice.row.alt ?? choice.candidate.alt,
        reused: true,
        allUsed: true,
      };
    }
    return null;
  } catch (err) {
    console.warn('[magazineV2] stock fetch failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Several stock results for one brief, NOT stored: each carries a small preview
 * URL (provider-hosted, for looking at only), the full size and the photographer.
 * Never throws; [] on no key, an error, or no match.
 */
export async function searchStockCandidates(
  query: string,
  opts: { orientation?: StockOrientation; count?: number } = {},
): Promise<StockCandidate[]> {
  if (!isStockConfigured()) return [];
  return searchStockPhotos(query, { orientation: opts.orientation, count: opts.count ?? 6 });
}

/**
 * Store ONE chosen candidate (from a server-side search) as a MediaAsset — the
 * same S3 path and row fetchAndStoreStock writes. The full-size URL the search
 * already returned is downloaded directly — no second Pexels lookup; only a
 * candidate without one is re-resolved by its id (lib/stock.ts). Never throws.
 */
export async function storeStockCandidate(
  candidate: StockCandidate,
  ctx: { magazineId: string; pageIndex: number },
): Promise<StoredStockImage | null> {
  if (!isStockConfigured()) return null;
  try {
    const stored = await storeStockPhoto(candidate, `public/magazinesV2/${ctx.magazineId}`);
    if (!stored) return null;
    return await recordStockAsset(stored, ctx);
  } catch (err) {
    console.warn('[magazineV2] stock store failed:', err instanceof Error ? err.message : err);
    return null;
  }
}
