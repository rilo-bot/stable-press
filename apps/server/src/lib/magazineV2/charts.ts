// ---------------------------------------------------------------------------
// Magazine Builder v2 — draw a chart and keep it: spec → SVG → PNG → media row.
//
// The I/O half of the chart feature (the pure halves are chartSpec.ts, chartTheme.ts
// and chartSvg.ts). It follows generateAndStoreImage in imagegen.ts step for step,
// so a chart is an ordinary library asset like any photo:
//
//   1. chartSvg draws the spec at exactly the box's size (page px);
//   2. renderPreview.renderSvgToPng rasterises it on the shared Chromium lane at 2×
//      (300 dpi at the page's 150 dpi), with the chart's Google Fonts loaded;
//   3. the bytes are checked to really be a PNG (sniffImageType) — SVG is never
//      stored or served (imageBytes.ts: SVG is a script host);
//   4. storage.uploadObject under public/magazinesV2/<id>/media/<uuid>-chart.png;
//   5. a COL.media row: kind 'graphic' (placeable — media.ts), source 'chart', and the
//      SPEC itself, so "change 2023 to 14" re-draws from the stored numbers instead of
//      asking anyone to retype them (loadChartAsset).
//
// NO FALLBACK TO THE IMAGE MODEL, EVER. A picture of a chart that a model imagined is
// exactly the failure this feature exists to end (audit C02/C16/C36/C37/C52).
//
// THE ONE FALLBACK IS ANOTHER EXACT RENDERER. Chromium runs in the worker in production
// (the PDF download renders there), and the API instance may not have a browser at all
// (MAGAZINE_V2_API_RENDERING=0, or none installed) — which would turn every chart
// request on the live site into "the renderer is not available". So when Chromium is
// off, down or busy, the same SVG is rasterised by sharp (librsvg): every bar and number
// is drawn exactly as before; only the type falls back to the host's system fonts
// because the web fonts are not fetched. sharp ships with the worker and is hoisted to
// the repo root, so it resolves here; if it cannot load, the caller gets the plain reason.
//
// Never throws: every failure is { ok: false, error } in words a user can be told.
// ---------------------------------------------------------------------------

import crypto from 'crypto';
import { db } from '../db.js';
import { storage } from '../storage.js';
import { COL } from './collections.js';
import { MAX_IMAGE_BYTES } from './config.js';
import { sniffImageType } from './imageBytes.js';
import { googleFontHref } from './previewHtml.js';
import { apiRenderingEnabled, previewRendererAvailable, renderSvgToPng } from './renderPreview.js';
import { chartAlt, dataEcho, validateChartSpec, type ChartSpec } from './chartSpec.js';
import { chartSvg } from './chartSvg.js';
import type { ChartTheme } from './chartTheme.js';

/** Raster scale: 2 device px per page px (the page is 150 dpi, so 300 dpi in print). */
const CHART_SCALE = 2;
/** Render budget for one chart (content + fonts + screenshot). */
const CHART_RENDER_MS = 8_000;
/** How long an interactive caller waits for the render lane before giving up. */
const CHART_QUEUE_MS = 6_000;
/** Weights chartSvg sets type in: labels 400, values 600, titles and totals 700. */
const CHART_WEIGHTS = [400, 600, 700];

/**
 * Rasterise the chart without a browser (see the header). Null when sharp cannot load
 * or cannot read the SVG — never throws. `density` makes librsvg draw the vector at the
 * target resolution rather than scaling a small bitmap up.
 */
async function rasteriseWithoutBrowser(svg: string, width: number, height: number): Promise<Buffer | null> {
  try {
    const mod = (await import('sharp')) as unknown as { default?: unknown };
    const sharp = (mod.default ?? mod) as (input: Buffer, opts?: { density?: number }) => {
      resize: (w: number, h: number, o: { fit: 'fill' }) => { png: () => { toBuffer: () => Promise<Buffer> } };
    };
    return await sharp(Buffer.from(svg), { density: 72 * CHART_SCALE })
      .resize(Math.round(width * CHART_SCALE), Math.round(height * CHART_SCALE), { fit: 'fill' })
      .png()
      .toBuffer();
  } catch (err) {
    console.warn('[magazineV2] chart rasterising without a browser failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

export type ChartStoreResult =
  | { ok: true; url: string; assetId: string; alt: string; dataEcho: string }
  | { ok: false; error: string };

/**
 * Draw `spec` at `box` (page px) in `theme`, store the PNG as a media asset and return
 * what an image element needs plus the data echo for the model. `ctx.pageIndex` is
 * recorded on the row when known (the page the chart was made for), like an image the
 * Studio generates.
 */
export async function renderAndStoreChart(
  spec: ChartSpec,
  theme: ChartTheme,
  box: { w: number; h: number },
  ctx: { magazineId: string; pageIndex?: number | null },
): Promise<ChartStoreResult> {
  try {
    // Re-checked here as well as at the door: this function writes to the library, and
    // a spec that skipped validation must not become a stored asset.
    const checked = validateChartSpec(spec);
    if (!checked.ok) return checked;
    const clean = checked.spec;

    if (!storage.isConfigured()) {
      return { ok: false, error: 'File storage is not set up on this server, so a chart cannot be saved.' };
    }
    const width = Math.round(box.w);
    const height = Math.round(box.h);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 60 || height < 40) {
      return { ok: false, error: 'That box is too small to draw a readable chart in — make it at least 60 × 40 px (ideally 400 × 260 or more).' };
    }
    const { svg, fontFamilies } = chartSvg(clean, theme, { width, height });
    const fontHrefs = fontFamilies
      .map((family) => googleFontHref(family, CHART_WEIGHTS))
      .filter((href): href is string => typeof href === 'string');
    // Chromium first (the magazine's own web fonts); without it, or when it is busy or
    // fails, the same SVG through sharp — exact either way (see the header).
    const viaBrowser = previewRendererAvailable()
      ? await renderSvgToPng(svg, {
          width,
          height,
          scale: CHART_SCALE,
          fontHrefs,
          timeoutMs: CHART_RENDER_MS,
          queueMs: CHART_QUEUE_MS,
        })
      : null;
    const png = viaBrowser ?? (await rasteriseWithoutBrowser(svg, width, height));
    if (!png) {
      return {
        ok: false,
        // Switched off on purpose (MAGAZINE_V2_API_RENDERING) is not "try again later".
        error: apiRenderingEnabled()
          ? 'The chart could not be drawn on this server just now (the renderer is busy or unavailable). Nothing was added; try again in a moment.'
          : 'Charts cannot be drawn on this server: its page renderer is switched off and the fallback renderer could not load. Nothing was added.',
      };
    }
    if (sniffImageType(png) !== 'image/png') return { ok: false, error: 'The chart renderer returned something that is not a picture, so nothing was added.' };
    if (png.length > MAX_IMAGE_BYTES) return { ok: false, error: 'The drawn chart came out too large to store — try a smaller box.' };

    const pageIndex = typeof ctx.pageIndex === 'number' ? ctx.pageIndex : null;
    const key = `public/magazinesV2/${ctx.magazineId}/media/${crypto.randomUUID()}-chart.png`;
    await storage.uploadObject({ key, contentType: 'image/png', body: png });
    const url = storage.publicUrl(key);
    const alt = chartAlt(clean);
    const now = new Date().toISOString();
    const assetId = await db.collection(COL.media).insertOne({
      magazineId: ctx.magazineId,
      pageIndex,
      key,
      url,
      contentType: 'image/png',
      size: png.length,
      alt,
      // 'graphic' so it is placeable (media.ts) and is never taken for a photograph
      // (the user photo pool reads source 'upload'; the stock ledger reads 'stock').
      kind: 'graphic',
      source: 'chart',
      // The numbers themselves, so an edit re-draws from them (loadChartAsset).
      chart: clean,
      // The CSS box it was drawn for: a re-draw keeps the chart's proportions.
      chartBox: { w: width, h: height },
      width: Math.round(width * CHART_SCALE),
      height: Math.round(height * CHART_SCALE),
      attribution: { author: 'Chart drawn from the data', url: '' },
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true, url, assetId: String(assetId), alt, dataEcho: dataEcho(clean) };
  } catch (err) {
    console.warn('[magazineV2] chart render/store failed:', err instanceof Error ? err.message : err);
    return { ok: false, error: 'The chart could not be saved. Nothing was added; try again.' };
  }
}

/**
 * The stored spec behind a chart image, for an edit ("change 2023 to 14") — read from
 * the media row the element's `image.assetId` points at. Null when the asset is not a
 * chart of THIS magazine (a photo, another magazine's row, or a deleted one), so an
 * edit can never be steered at somebody else's data. The spec is re-validated: a row
 * edited by hand must not crash a re-draw.
 */
export async function loadChartAsset(
  assetId: string,
  magazineId: string,
): Promise<{ spec: ChartSpec; box?: { w: number; h: number }; url: string } | null> {
  if (!assetId) return null;
  try {
    const row = (await db.collection(COL.media).findById(String(assetId))) as {
      magazineId?: string;
      source?: string;
      chart?: unknown;
      chartBox?: { w?: unknown; h?: unknown };
      url?: string;
    } | null;
    if (!row || String(row.magazineId) !== String(magazineId) || row.source !== 'chart') return null;
    const checked = validateChartSpec(row.chart);
    if (!checked.ok) return null;
    const w = Number(row.chartBox?.w);
    const h = Number(row.chartBox?.h);
    return {
      spec: checked.spec,
      ...(Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { box: { w, h } } : {}),
      url: String(row.url ?? ''),
    };
  } catch {
    return null;
  }
}
