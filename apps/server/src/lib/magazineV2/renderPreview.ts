// ---------------------------------------------------------------------------
// Magazine Builder v2 — render a composed page to a small JPEG proof, so the
// Visual Critic (visualCritic.ts) can LOOK at what the generator built.
//
// The HTML comes from previewHtml.ts (pure, mirrors the web canvas). This file is
// the browser half:
//
//   • ONE Chromium per process — borrowed from lib/pdf.ts (getSharedBrowser), never
//     launched here and never closed or reset here (a PDF render may be using it).
//   • ONE render lane and one warm, reused tab. Measured on the NZ fixture (6 pages
//     submitted together): three parallel tabs left 2 of 6 proofs over the 8s box
//     even on a warm browser (a background tab's screenshot waits for a frame that a
//     hidden tab does not paint); one lane rendered all six in ~0.5s warm, ~3.8s
//     cold including the Chromium launch. Renders queue; they are ~80ms each.
//   • Every request the proof makes is filtered: our own images are served from S3
//     with the server's credentials (so a bucket WITHOUT public-read — the live
//     bucket's state, see the layout-quality notes — still renders real photos),
//     an image url on any OTHER host is drawn as a grey stand-in and never fetched
//     (the server must not fetch addresses a client names), Google Fonts load
//     normally, and everything else (scripts, frames, XHR) is refused.
//   • Time-boxed (default 8s for content + screenshot). A render that is late,
//     fails, or has no Chromium to run in returns null — the critic is skipped for
//     that page and generation carries on. Never throws.
//
// The same lane and tab pool serve three more jobs, so an interactive caller never
// launches a second Chromium or races the generator for tabs:
//
//   • measurePagePreview — load the proof at the page's own canonical width and
//     MEASURE every element in it (box, laid-out text size, the text's ink, whether
//     its picture loaded). This is the "chromium" variant of the page check
//     (pageCheck.ts issuesFromMeasurements): real fonts, real line breaks.
//   • renderSvgToPng — rasterise a chart's SVG (chartSvg.ts) to a transparent PNG.
//     SVG is never stored or served (imageBytes.ts: it is a script host), so a chart
//     becomes a PNG here, drawn with the same Google Fonts the page uses.
//   • `queueMs` — how long a caller will wait for the lane. The generator keeps the
//     generous default (3× its render budget: six pages finishing together queue,
//     they do not fail); a person waiting on the Studio chat passes a few seconds, so
//     it is never stuck behind a generation run and degrades to the estimate instead.
// ---------------------------------------------------------------------------

import { getSharedBrowser } from '../pdf.js';
import { storage } from '../storage.js';
import { sniffImageType } from './imageBytes.js';
import { curatedFamiliesUsed, escapeAttr, pageToPreviewHtml, previewSize, PREVIEW_WIDTH, type PreviewPage } from './previewHtml.js';
import type { ElementMeasurement } from './pageCheck.js';

export type { PreviewPage, ElementMeasurement };

// ── The slice of puppeteer used here (declared by hand — see the note in lib/pdf.ts
//    on why puppeteer's own types cannot be imported into this dual-built code) ──
export interface PreviewRequest {
  url(): string;
  resourceType(): string;
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
  respond(response: { status: number; contentType: string; body: Uint8Array | string; headers?: Record<string, string> }): Promise<void>;
  isInterceptResolutionHandled?(): boolean;
}
interface PreviewTab {
  setRequestInterception(enabled: boolean): Promise<void>;
  on(event: 'request', handler: (req: PreviewRequest) => void): void;
  setViewport(viewport: { width: number; height: number; deviceScaleFactor?: number }): Promise<void>;
  setContent(html: string, opts?: { waitUntil?: string; timeout?: number }): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  screenshot(opts: Record<string, unknown>): Promise<Uint8Array>;
  close(): Promise<void>;
}
interface PreviewBrowser {
  newPage(): Promise<unknown>;
  connected: boolean;
}

/** Renders in flight at once, across every page being generated in this process. ONE
 *  by default — see the header: parallel tabs were measured slower, not faster.
 *  MAGAZINE_V2_PREVIEW_RENDERS can raise it (max 4) on a host where that changes. */
const MAX_RENDERS = Math.max(1, Math.min(4, Number(process.env.MAGAZINE_V2_PREVIEW_RENDERS) || 1));
/** Warm tabs kept between renders (one per lane). */
const MAX_IDLE_TABS = MAX_RENDERS;
/** Content + fonts + screenshot, per render. */
const DEFAULT_RENDER_MS = 8_000;
/** Bringing Chromium up the first time (a one-off per process). */
const LAUNCH_MS = 30_000;
/** How long the renderer stays switched off after Chromium could not be started. */
const UNAVAILABLE_COOLDOWN_MS = 10 * 60_000;
/** One of our images, fetched from S3 for a proof. */
const ASSET_FETCH_MS = 5_000;
/** Bytes of our own images kept between renders (a page's retry reuses its photos). */
const ASSET_CACHE_MAX_BYTES = 64 * 1024 * 1024;

const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

// ── availability (log once) ──────────────────────────────────────────────────
let unavailableUntil = 0;
let warned = false;
function warnOnce(message: string): void {
  if (warned) return;
  warned = true;
  console.warn(`[magazineV2] ${message}`);
}

// ── which process may start Chromium ─────────────────────────────────────────
//
// Rendering used to live only in the worker (apps/server/src/routes/issues/index.ts:
// "the API must never pull Chromium into its process … launching it was what exhausted
// the instance"). The Studio now renders in the API process too: check_page measures
// the page, look_at_page renders it for the vision review, and a chart is rasterised
// when it is drawn — product decisions 2 and 3 ("via the server's existing shared
// Chromium"). So this is ONE switch for the API, MAGAZINE_V2_API_RENDERING:
//   unset / anything else  on — the decisions as made;
//   0 / off / false / no   the API never starts Chromium: the page check falls back
//                          to its estimate, a look returns seen:false with the reason,
//                          and a chart is refused with a plain sentence. For an API
//                          instance too small to hold a browser.
// The worker calls markRenderHost() at startup, so the generator's Visual Critic keeps
// rendering whatever the API's switch says (the two processes share one env file).
let renderHost = false;

/** Mark this process as the one rendering belongs to (the worker). */
export function markRenderHost(): void {
  renderHost = true;
}

/** May this process start Chromium for proofs, measurements and charts? */
export function apiRenderingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (renderHost) return true;
  const v = String(env.MAGAZINE_V2_API_RENDERING ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

/** False while the renderer is switched off — by MAGAZINE_V2_API_RENDERING in the API,
 *  or for a while after a failed Chromium start. */
export function previewRendererAvailable(): boolean {
  return apiRenderingEnabled() && Date.now() >= unavailableUntil;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// ── our own images, served from S3 with credentials ───────────────────────────
const assetCache = new Map<string, { bytes: Buffer; contentType: string }>();
let assetCacheBytes = 0;
const assetInflight = new Map<string, Promise<{ bytes: Buffer; contentType: string } | null>>();

function cachePut(key: string, value: { bytes: Buffer; contentType: string }): void {
  if (value.bytes.length > ASSET_CACHE_MAX_BYTES / 4) return;
  const prev = assetCache.get(key);
  if (prev) assetCacheBytes -= prev.bytes.length;
  assetCache.set(key, value);
  assetCacheBytes += value.bytes.length;
  while (assetCacheBytes > ASSET_CACHE_MAX_BYTES && assetCache.size > 1) {
    const oldest = assetCache.keys().next().value as string;
    assetCacheBytes -= assetCache.get(oldest)!.bytes.length;
    assetCache.delete(oldest);
  }
}

async function ownAsset(key: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  const hit = assetCache.get(key);
  if (hit) {
    assetCache.delete(key);
    assetCache.set(key, hit); // most-recently-used
    return hit;
  }
  let pending = assetInflight.get(key);
  if (!pending) {
    pending = withTimeout(storage.downloadObject(key), ASSET_FETCH_MS, 'asset download')
      .then((bytes) => {
        const contentType = sniffImageType(bytes);
        if (!contentType) return null;
        const value = { bytes, contentType };
        cachePut(key, value);
        return value;
      })
      .catch(() => null)
      .finally(() => assetInflight.delete(key));
    assetInflight.set(key, pending);
  }
  return pending;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * What a proof shows for a picture whose url is NOT in our bucket: a plain grey
 * stand-in, authored here (no script, no external reference). The server's Chromium
 * never fetches another host — a page's picture urls come from clients (a url pasted in
 * the Inspector, a staged background sent back with a chat turn), and a server-side
 * fetch of whatever address they name reaches internal services and the cloud metadata
 * endpoint. Every picture this product places is stored in our bucket (uploads, stock,
 * generated images, charts, PDF pictures), so the proof loses nothing it can vouch
 * for; and the stand-in has real pixels, so the page check does not call such a
 * picture broken — it prints from the browser that renders the edition.
 */
const EXTERNAL_IMAGE_STANDIN =
  '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3" viewBox="0 0 4 3"><rect width="4" height="3" fill="#d9d9d9"/></svg>';

/** Decide every request a proof makes. Exactly one of continue/abort/respond per request. */
export async function handleRequest(req: PreviewRequest): Promise<void> {
  const url = req.url();
  const type = req.resourceType();
  try {
    if (url.startsWith('data:') || url === 'about:blank') return await req.continue();
    if (type === 'image') {
      const key = storage.isConfigured() ? storage.keyFromUrl(url) : null;
      if (key && storage.isPublicKey(key)) {
        const asset = await ownAsset(key);
        if (asset) return await req.respond({ status: 200, contentType: asset.contentType, body: asset.bytes });
        return await req.abort('failed');
      }
      // A relative proxy URL with no S3 to read it from cannot load anywhere.
      if (hostOf(url) === 'assets.preview.invalid') return await req.abort('failed');
      if (/^https?:\/\//i.test(url)) {
        return await req.respond({ status: 200, contentType: 'image/svg+xml', body: EXTERNAL_IMAGE_STANDIN });
      }
      return await req.abort('blockedbyclient');
    }
    if ((type === 'stylesheet' || type === 'font') && FONT_HOSTS.has(hostOf(url))) return await req.continue();
    if (type === 'document' && url === 'about:blank') return await req.continue();
    return await req.abort('blockedbyclient');
  } catch {
    // Already handled (or the tab closed under us) — nothing left to decide.
    try {
      if (!req.isInterceptResolutionHandled?.()) await req.abort('failed');
    } catch {
      /* ignore */
    }
  }
}

// ── the tab pool ─────────────────────────────────────────────────────────────
interface PooledTab {
  tab: PreviewTab;
  browser: PreviewBrowser;
}
const idleTabs: PooledTab[] = [];
let inFlight = 0;
const waiters: Array<() => void> = [];

/** A render slot, or false after `maxWaitMs` in the queue. Single-threaded JS means a
 *  waiter is either woken by releaseSlot or removed by its timer — never both. */
function acquireSlot(maxWaitMs: number): Promise<boolean> {
  if (inFlight < MAX_RENDERS) {
    inFlight++;
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      inFlight++;
      resolve(true);
    };
    const timer = setTimeout(() => {
      const i = waiters.indexOf(wake);
      if (i >= 0) waiters.splice(i, 1);
      resolve(false);
    }, maxWaitMs);
    waiters.push(wake);
  });
}
function releaseSlot(): void {
  inFlight = Math.max(0, inFlight - 1);
  const next = waiters.shift();
  if (next) next();
}

async function browser(): Promise<PreviewBrowser | null> {
  if (!previewRendererAvailable()) return null;
  try {
    return (await withTimeout(getSharedBrowser(), LAUNCH_MS, 'Chromium launch')) as unknown as PreviewBrowser;
  } catch (err) {
    unavailableUntil = Date.now() + UNAVAILABLE_COOLDOWN_MS;
    warnOnce(
      `visual critic: no headless Chromium (${err instanceof Error ? err.message : String(err)}) — page previews are skipped, so the critic is too; deterministic layout QA still runs.`,
    );
    return null;
  }
}

async function openTab(): Promise<PooledTab | null> {
  const b = await browser();
  if (!b) return null;
  while (idleTabs.length > 0) {
    const pooled = idleTabs.pop()!;
    if (pooled.browser === b && b.connected) return pooled;
    void pooled.tab.close().catch(() => {});
  }
  const tab = (await b.newPage()) as PreviewTab;
  await tab.setRequestInterception(true);
  tab.on('request', (req) => {
    void handleRequest(req);
  });
  return { tab, browser: b };
}

function closeTab(pooled: PooledTab, reusable: boolean): void {
  if (reusable && pooled.browser.connected && idleTabs.length < MAX_IDLE_TABS) {
    idleTabs.push(pooled);
    return;
  }
  void pooled.tab.close().catch(() => {});
}

/**
 * A pooled tab, or null when `maxWaitMs` passes first (an interactive caller that
 * must not sit through a cold Chromium start). The start is NOT abandoned: it carries
 * on, so the next caller finds Chromium warm, and a tab it opens late joins the idle
 * pool instead of leaking. Without a limit this is plain openTab(), whose launch is
 * bounded by LAUNCH_MS (and a launch that fails switches the renderer off).
 */
async function openTabWithin(maxWaitMs: number | undefined): Promise<PooledTab | null> {
  const opening = openTab();
  if (maxWaitMs === undefined || !Number.isFinite(maxWaitMs)) return opening;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), Math.max(0, maxWaitMs));
  });
  const won = await Promise.race([opening, late]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  if (won !== 'late') return won;
  void opening
    .then((pooled) => {
      if (pooled) closeTab(pooled, true);
    })
    .catch(() => {});
  return null;
}

/** One job on the shared lane: what it is (for the log line), its own time box, how
 *  long it may queue for the lane, and the work itself on a ready tab. */
interface LaneJob<T> {
  what: string;
  /** Appended to the warning when the job fails ("— critic skipped for this page."). */
  failNote: string;
  budgetMs: number;
  queueMs: number;
  /** Cap on waiting for a tab when Chromium is still starting (interactive callers). */
  openMs?: number;
  run: (tab: PreviewTab, left: () => number) => Promise<T>;
}

/**
 * Run one job in a pooled tab on the shared lane. Null — never throws — when the
 * renderer is off, the lane stays busy past `queueMs`, no tab could be had in time,
 * or the job fails or overruns `budgetMs`. A tab is reused only after a clean run: a
 * job that timed out may still be working in its tab, so that tab is closed.
 */
async function onLane<T>(job: LaneJob<T>): Promise<T | null> {
  if (!previewRendererAvailable()) return null;
  // Waiting for the lane is bounded too, but is not part of the job's own budget.
  if (!(await acquireSlot(Math.max(0, job.queueMs)))) return null;
  let pooled: PooledTab | null = null;
  let reusable = false;
  try {
    pooled = await openTabWithin(job.openMs);
    if (!pooled) return null;
    const tab = pooled.tab;
    const started = Date.now();
    const left = () => Math.max(500, job.budgetMs - (Date.now() - started));
    const out = await withTimeout(job.run(tab, left), job.budgetMs, job.what);
    reusable = true;
    return out;
  } catch (err) {
    console.warn(`[magazineV2] ${job.what} failed (${err instanceof Error ? err.message : String(err)})${job.failNote}`);
    return null;
  } finally {
    if (pooled) closeTab(pooled, reusable);
    releaseSlot();
  }
}

/** Bounded queue wait from a caller's option: a finite, non-negative number of ms. */
function queueWait(queueMs: number | undefined, fallback: number): number {
  return typeof queueMs === 'number' && Number.isFinite(queueMs) ? Math.max(0, Math.min(120_000, queueMs)) : fallback;
}

/** Load a proof document and let its fonts settle. Forcing a layout first makes the
 *  page REQUEST its web fonts, so `document.fonts.ready` waits for them rather than
 *  resolving before any load has started. */
async function loadDocument(tab: PreviewTab, html: string, left: () => number, fontsMs: number): Promise<void> {
  // 'load' waits for the stylesheets, fonts already requested and every image. A slow
  // image must not cost the whole job: on a timeout, carry on with what is there.
  await tab.setContent(html, { waitUntil: 'load', timeout: Math.max(1_000, left() - 1_500) }).catch(() => {});
  await withTimeout(
    tab.evaluate('(document.body && document.body.getBoundingClientRect(), document.fonts ? document.fonts.ready.then(() => true) : true)'),
    Math.min(fontsMs, left()),
    'fonts',
  ).catch(() => {});
}

/**
 * Render one page to a JPEG proof `previewWidth` px wide (default 620). Returns
 * null — never throws — when Chromium is unavailable, the render pool is saturated
 * for too long, or the render fails or overruns its time box.
 *
 * `queueMs` bounds the wait for the render lane (default 3× the render budget, which
 * suits the generator). An interactive caller (the Studio's look at a page) passes a
 * few seconds; it then also waits at most `queueMs + timeoutMs` for a cold Chromium
 * to come up, rather than up to the 30s launch limit.
 */
export async function renderPagePreview(
  page: PreviewPage,
  opts: { previewWidth?: number; timeoutMs?: number; queueMs?: number } = {},
): Promise<Buffer | null> {
  if (!previewRendererAvailable()) return null;
  const previewWidth = opts.previewWidth ?? PREVIEW_WIDTH;
  const budget = Math.max(2_000, opts.timeoutMs ?? DEFAULT_RENDER_MS);
  const size = previewSize(page.width, page.height, previewWidth);
  const html = pageToPreviewHtml(page, { previewWidth });
  const interactive = opts.queueMs !== undefined;
  const queueMs = queueWait(opts.queueMs, budget * 3);
  const shot = await onLane({
    what: 'page preview',
    failNote: ' — that page is judged without a picture.',
    budgetMs: budget,
    queueMs,
    openMs: interactive ? queueMs + budget : undefined,
    run: async (tab, left) => {
      await tab.setViewport({ width: size.width, height: size.height, deviceScaleFactor: 1 });
      await loadDocument(tab, html, left, 1_500);
      return tab.screenshot({ type: 'jpeg', quality: 72, clip: { x: 0, y: 0, width: size.width, height: size.height } });
    },
  });
  return shot ? Buffer.from(shot) : null;
}

// ── measuring a page (the Chromium variant of the page check) ────────────────

/** Default time box for one measurement (content + fonts + the measuring script). */
const MEASURE_MS = 6_000;
/** Default wait for the lane: a measurement serves a person waiting on a chat turn. */
const MEASURE_QUEUE_MS = 3_000;
/** Measurement proofs are laid out at the page's canonical width, within these bounds. */
const MEASURE_MIN_W = 200;
const MEASURE_MAX_W = 4_000;

/**
 * The measuring script, evaluated in the proof as a self-contained expression (the
 * server's TypeScript has no DOM types, and a stringified function would be at the
 * mercy of the compiler's down-levelling). It returns CSS px of the proof:
 *
 *   { pageW, pageH, items: [{ id, box, contentW?, contentH?, ink?, imgOk? }] }
 *
 *   • box — the element's own layout box (left/top/width/height as laid out, so a
 *     rotated element reports its unrotated box), relative to the page.
 *   • contentW / contentH (text only) — the size the text's content actually needs:
 *     its inner div's scroll size. Taller than box.h = the copy does not fit (it is
 *     clipped, or for extracted text it spills); wider = a kept PDF line overruns.
 *   • ink (text only, unrotated only) — the union of the rectangles of every glyph run,
 *     relative to the page and NOT clipped by the box: where the words really are,
 *     including any that run past the box or the page edge.
 *   • imgOk (image/icon with a picture) — true once loaded with real pixels, false
 *     when it finished loading with none (broken), absent while still loading.
 */
export const MEASURE_PAGE_JS = `(function () {
  var root = document.getElementById('page');
  if (!root) return null;
  var pr = root.getBoundingClientRect();
  var items = [];
  var nodes = root.querySelectorAll('[data-el-id]');
  for (var i = 0; i < nodes.length && items.length < 600; i++) {
    var el = nodes[i];
    var cs = getComputedStyle(el);
    var m = { id: el.getAttribute('data-el-id') || '', box: { x: parseFloat(cs.left) || 0, y: parseFloat(cs.top) || 0, w: parseFloat(cs.width) || 0, h: parseFloat(cs.height) || 0 } };
    var rotated = !!cs.transform && cs.transform !== 'none';
    var text = el.querySelector('[data-el-text]');
    if (text) {
      var tr = text.getBoundingClientRect();
      m.contentW = Math.max(text.scrollWidth || 0, rotated ? 0 : tr.width);
      m.contentH = Math.max(text.scrollHeight || 0, rotated ? 0 : tr.height);
      if (!rotated) {
        var walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
        var range = document.createRange();
        var l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
        for (var n = walker.nextNode(); n; n = walker.nextNode()) {
          if (!/\\S/.test(n.nodeValue || '')) continue;
          range.selectNodeContents(n);
          var rects = range.getClientRects();
          for (var j = 0; j < rects.length; j++) {
            var q = rects[j];
            if (!(q.width > 0) || !(q.height > 0)) continue;
            if (q.left < l) l = q.left;
            if (q.top < t) t = q.top;
            if (q.right > r) r = q.right;
            if (q.bottom > b) b = q.bottom;
          }
        }
        if (r > l && b > t) m.ink = { x: l - pr.left, y: t - pr.top, w: r - l, h: b - t };
      }
    }
    var img = el.querySelector('img');
    if (img && img.complete) m.imgOk = img.naturalWidth > 0;
    items.push(m);
  }
  return { pageW: pr.width, pageH: pr.height, items: items };
})()`;

/**
 * An expression that is true when every listed (lower-cased) family has at least one
 * LOADED face in the proof. Families are embedded as a JSON literal, so a name can
 * never break out of the script.
 */
export function fontsLoadedScript(families: string[]): string {
  return `(function (want) {
  if (!document.fonts || want.length === 0) return true;
  var loaded = {};
  document.fonts.forEach(function (f) { if (f.status === 'loaded') loaded[String(f.family).replace(/["']/g, '').trim().toLowerCase()] = true; });
  for (var i = 0; i < want.length; i++) if (!loaded[want[i]]) return false;
  return true;
})(${JSON.stringify(families.map((f) => f.toLowerCase()))})`;
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
function rectFrom(v: unknown, scale: number): { x: number; y: number; w: number; h: number } | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const x = finite(o.x);
  const y = finite(o.y);
  const w = finite(o.w);
  const h = finite(o.h);
  if (x === null || y === null || w === null || h === null || w < 0 || h < 0) return null;
  return { x: round1(x * scale), y: round1(y * scale), w: round1(w * scale), h: round1(h * scale) };
}

/**
 * The measuring script's raw answer → ElementMeasurement[] in PAGE px (the canonical
 * units elements are stored in), or null when it is not a measurement at all. Pure,
 * so the conversion is tested without a browser. `pageWidth` is the page's canonical
 * width; the proof's own width gives the scale.
 */
export function parseMeasurements(raw: unknown, pageWidth: number): ElementMeasurement[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const proofW = finite(o.pageW);
  if (proofW === null || proofW <= 0 || !Array.isArray(o.items)) return null;
  const scale = pageWidth > 0 ? pageWidth / proofW : 1;
  const out: ElementMeasurement[] = [];
  for (const item of o.items) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : '';
    const box = rectFrom(r.box, scale);
    if (!id || !box) continue;
    const m: ElementMeasurement = { id, box };
    const cw = finite(r.contentW);
    const ch = finite(r.contentH);
    if (cw !== null && cw >= 0) m.contentW = round1(cw * scale);
    if (ch !== null && ch >= 0) m.contentH = round1(ch * scale);
    const ink = rectFrom(r.ink, scale);
    if (ink) m.ink = ink;
    if (typeof r.imgOk === 'boolean') m.imgOk = r.imgOk;
    out.push(m);
  }
  return out;
}

/**
 * Measure every element of a page as Chromium lays it out with the real web fonts,
 * in PAGE px (see MEASURE_PAGE_JS for what each field means). Feed the result to
 * pageCheck.ts issuesFromMeasurements.
 *
 * The proof is laid out at the page's own canonical width, so a page px is a CSS px
 * and nothing is lost to scaling. Null — never throws — when Chromium is unavailable,
 * the lane stays busy past `queueMs` (default 3s), the job overruns `timeoutMs`
 * (default 6s), or a curated web font the page uses did not load: the reader's
 * browser HAS that font, so a measurement taken with a fallback face would report the
 * wrong line breaks, and the caller is better served by the estimate (which uses the
 * real font's metrics). A family outside the curated set falls back for the reader
 * too, so it is not waited for.
 */
export async function measurePagePreview(
  page: PreviewPage,
  opts: { timeoutMs?: number; queueMs?: number } = {},
): Promise<ElementMeasurement[] | null> {
  try {
    if (!previewRendererAvailable()) return null;
    if (!(page.width > 0) || !(page.height > 0)) return null;
    const budget = Math.max(2_000, opts.timeoutMs ?? MEASURE_MS);
    const queueMs = queueWait(opts.queueMs, MEASURE_QUEUE_MS);
    const width = Math.round(Math.max(MEASURE_MIN_W, Math.min(MEASURE_MAX_W, page.width)));
    const size = previewSize(page.width, page.height, width);
    const html = pageToPreviewHtml(page, { previewWidth: width });
    const families = curatedFamiliesUsed(page.elements ?? []);
    const raw = await onLane({
      what: 'page measurement',
      failNote: ' — the page check falls back to its estimate.',
      budgetMs: budget,
      queueMs,
      openMs: queueMs + budget,
      run: async (tab, left) => {
        await tab.setViewport({ width: size.width, height: size.height, deviceScaleFactor: 1 });
        await loadDocument(tab, html, left, 3_000);
        if (families.length > 0 && (await tab.evaluate(fontsLoadedScript(families))) !== true) return { fontsMissing: true };
        return tab.evaluate(MEASURE_PAGE_JS);
      },
    });
    if (!raw || (raw as { fontsMissing?: boolean }).fontsMissing) return null;
    return parseMeasurements(raw, page.width);
  } catch {
    return null;
  }
}

// ── rasterising an SVG (charts) ──────────────────────────────────────────────

/** Default time box for one SVG raster (content + fonts + screenshot). */
const SVG_RENDER_MS = 8_000;
/** Largest CSS box a raster may ask for, per side. */
const SVG_MAX_SIDE = 4_096;
/** Device-pixel ceiling for one raster (keeps a big box at scale 2 from making a 100MB PNG). */
const SVG_MAX_DEVICE_PIXELS = 36_000_000;

/**
 * The CSS box and device scale a raster will use, or null for a size that cannot be
 * drawn. Sides are whole CSS px within 1..SVG_MAX_SIDE; scale defaults to 2 (a page px
 * is 1/150 in, so 2× prints at 300 dpi), is kept within 1..4, and is lowered when the
 * device-pixel area would pass SVG_MAX_DEVICE_PIXELS.
 */
export function rasterSize(width: number, height: number, scale?: number): { width: number; height: number; scale: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const w = Math.max(1, Math.min(SVG_MAX_SIDE, Math.round(width)));
  const h = Math.max(1, Math.min(SVG_MAX_SIDE, Math.round(height)));
  let s = typeof scale === 'number' && Number.isFinite(scale) ? Math.max(1, Math.min(4, scale)) : 2;
  const maxScale = Math.sqrt(SVG_MAX_DEVICE_PIXELS / (w * h));
  if (s > maxScale) s = Math.max(1, Math.floor(maxScale * 100) / 100);
  return { width: w, height: h, scale: s };
}

/**
 * Defence in depth for an SVG about to be rasterised. Charts come from chartSvg.ts,
 * which escapes every string it writes, and the renderer refuses every script/frame/
 * XHR request; this strips the elements and attributes that could still DO something
 * inside the document (inline script, foreignObject HTML, event handlers,
 * javascript: links) if a future caller ever passed an SVG from elsewhere.
 */
export function stripActiveSvg(svg: string): string {
  return svg
    .replace(/<\s*(script|foreignObject|iframe|object|embed)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*\/?\s*(script|foreignObject|iframe|object|embed|link|meta|base)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|xlink:href)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '');
}

/** Only Google Fonts stylesheet links may be added to a raster document. */
function fontHrefsAllowed(hrefs: ReadonlyArray<string> | undefined): string[] {
  return [...new Set((hrefs ?? []).filter((h) => typeof h === 'string' && h.length <= 1_000 && /^https:\/\/fonts\.googleapis\.com\/css2\?/.test(h)))].slice(0, 6);
}

/**
 * `document.fonts.load` specs for the faces a set of Google Fonts links declare —
 * "700 16px \"Archivo\"" — so a raster waits for exactly the faces the chart draws
 * with. A link with no weight list declares the family's default (400) face.
 */
export function fontLoadSpecs(hrefs: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  for (const href of fontHrefsAllowed(hrefs)) {
    const m = /[?&]family=([A-Za-z0-9+]{2,80})(?::wght@([0-9;]+))?/.exec(href);
    if (!m) continue;
    const family = m[1]!.replace(/\+/g, ' ');
    const weights = (m[2] ?? '400').split(';').filter((w) => /^[1-9]00$/.test(w));
    for (const w of weights.length ? weights : ['400']) out.push(`${w} 16px "${family}"`);
  }
  return out.slice(0, 24);
}

/**
 * The HTML document a raster is shot from: the (sanitised) SVG as the body's only
 * child, sized to exactly the CSS box, on a transparent page, with the chart's Google
 * Fonts linked in the head. Null when the input is not an <svg> document.
 */
export function svgDocument(svg: string, size: { width: number; height: number }, fontHrefs?: ReadonlyArray<string>): string | null {
  const body = stripActiveSvg(String(svg ?? '').replace(/^﻿/, '').replace(/^\s*<\?xml[^>]*\?>/i, '').trim());
  if (!/^<svg[\s>]/i.test(body)) return null;
  const links = fontHrefsAllowed(fontHrefs).map((href) => `<link rel="stylesheet" href="${escapeAttr(href)}">`);
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    ...links,
    '<style>',
    '*{margin:0;padding:0}',
    `html,body{background:transparent;width:${size.width}px;height:${size.height}px;overflow:hidden}`,
    `body>svg{display:block;width:${size.width}px;height:${size.height}px}`,
    '</style></head><body>',
    body,
    '</body></html>',
  ].join('');
}

/**
 * Rasterise an SVG to a PNG on the shared lane: `width × height` CSS px at
 * `scale` (default 2) device pixels per px, with a TRANSPARENT background (so a chart
 * sits on a page's own colour), and Google Fonts allowed exactly as for previews
 * (`fontHrefs`, e.g. from previewHtml.ts googleFontHref). Returns the PNG bytes, or
 * null — never throws — when Chromium is unavailable, the lane is busy past `queueMs`
 * (default 2× the budget), the job overruns `timeoutMs` (default 8s), the input is
 * not an SVG, or the result is not a PNG.
 */
export async function renderSvgToPng(
  svg: string,
  opts: { width: number; height: number; scale?: number; fontHrefs?: string[]; timeoutMs?: number; queueMs?: number },
): Promise<Buffer | null> {
  try {
    if (!previewRendererAvailable()) return null;
    const size = rasterSize(opts.width, opts.height, opts.scale);
    if (!size) return null;
    const html = svgDocument(svg, size, opts.fontHrefs);
    if (!html) return null;
    const specs = fontLoadSpecs(opts.fontHrefs ?? []);
    const budget = Math.max(2_000, opts.timeoutMs ?? SVG_RENDER_MS);
    const interactive = opts.queueMs !== undefined;
    const queueMs = queueWait(opts.queueMs, budget * 2);
    const shot = await onLane({
      what: 'chart render',
      failNote: ' — the chart was not drawn.',
      budgetMs: budget,
      queueMs,
      openMs: interactive ? queueMs + budget : undefined,
      run: async (tab, left) => {
        await tab.setViewport({ width: size.width, height: size.height, deviceScaleFactor: size.scale });
        await loadDocument(tab, html, left, 2_000);
        if (specs.length > 0) {
          // Ask for the exact faces too: a face only starts loading once text needs it,
          // and a chart drawn in the fallback face would not match the page.
          await withTimeout(
            tab.evaluate(
              `Promise.all(${JSON.stringify(specs)}.map(function (s) { return document.fonts ? document.fonts.load(s).catch(function () { return []; }) : []; })).then(function () { return true; })`,
            ),
            Math.min(2_500, left()),
            'chart fonts',
          ).catch(() => {});
        }
        return tab.screenshot({ type: 'png', omitBackground: true, clip: { x: 0, y: 0, width: size.width, height: size.height } });
      },
    });
    if (!shot) return null;
    const png = Buffer.from(shot);
    return sniffImageType(png) === 'image/png' ? png : null;
  } catch {
    return null;
  }
}
