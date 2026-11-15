// ---------------------------------------------------------------------------
// Magazine Builder v2 — AI image generation.
//
// The generative sibling of stock.ts. Where that module SEARCHES Pexels for a
// photograph that already exists, this one asks an image-capable model on
// OpenRouter to render an original editorial image, then persists the bytes
// through the very same S3 `storage` + MediaAsset path stock.ts uses — so a caller
// can use either interchangeably (identical `{ url, assetId, alt }` return shape,
// identical never-throws contract).
//
// WHERE IT SITS IN AUTOMATIC GENERATION: last, before the colour block. The
// order in curateFills is the user's own photos → Pexels → here → a tinted
// block. A real photograph wins wherever one exists; generation is what fills
// the gap that used to be a flat rectangle when a search came back empty. That
// also keeps the cost proportional — an image-model call happens only for the
// slots stock could not answer.
//
// Since 2026-11-12 the Photo Director (photoDirector.ts) LOOKS at the stock
// candidates first; when it rejects them all, this module is asked for the frame
// instead — at the slot's own aspect ratio (nearestAspectRatio) and in the issue's
// photographic style, so a generated picture matches its box and its neighbours.
//
// ONE "MAKE AN IMAGE" CAPABILITY (2026-11-15). The prompt used to be hard-coded to a
// text-free editorial PHOTOGRAPH, so every illustration, poster or graphic a client
// asked for came back photoreal and wordless (audit C37). A caller now names the kind
// of picture — 'photo' (default, the prompt unchanged), 'illustration', 'graphic' or
// 'poster' — and the non-photo kinds may carry the words the user asked for. The
// prompt itself is built in imagePrompt.ts (pure, tested). CHARTS ARE NOT PICTURES:
// they are drawn from the numbers (charts.ts); the guard that keeps them away from
// this module lives in chartSpec.ts and is applied by the tool and the route.
//
// TYPED FAILURES (audit C42). Every failure now carries a reason — refused, no-credit,
// rate-limited, timeout, unavailable, failed — with a sentence the AI relays as-is
// (generateImageAsset). A refusal (a 200 with text and no image) is metered as a
// FAILURE in AI Activity, with the model's words; a timeout is metered too (it used to
// skip the meter entirely while OpenRouter could still bill it).
// generateAndStoreImage keeps its old null-on-failure shape for existing callers.
//
// This rung existed before and was removed on 2026-08-30 ("photographs are
// FOUND, never generated") because it sat AHEAD of Pexels and was gated on
// OPENROUTER_API_KEY, so every generated page went bespoke-image whether or not
// a real photo was available. Reinstated 2026-09-16 at the user's request, as a
// FALLBACK rather than a preference, plus the two manual doors it never had: a
// Design Helper tool and an editor button.
//
// Env-gated with the SAME dual gate as stock.ts: no OPENROUTER_API_KEY (or no
// S3) ⇒ isImageGenConfigured() is false and every caller degrades instead of
// failing. Every generated image becomes a real MediaAsset (S3 + DB), so it
// obeys the "no invented or hotlinked image URL" invariant and can be reused,
// re-placed and edited later like any other row in the library.
// ---------------------------------------------------------------------------

import crypto from 'crypto';
import { db } from '../db.js';
import { storage } from '../storage.js';
import { COL } from './collections.js';
import { recordAiUsage } from '../agent/aiUsage.js';
// The same extension map a hand-uploaded image is held to — a picture the model
// made is not exempt from the library's rules.
import { imageExtFor } from './config.js';
// The pure half of this module: decoding, sniffing and the box→shape rule. It
// lives apart so it can be unit-tested (this file imports db/storage, which
// throw at import time without MONGODB_URI).
import { decodeDataUrl, normalizeAspectRatio, orientationForAspectRatio, orientationForBox } from './imageBytes.js';
import {
  buildImagePrompt,
  classifyImageError,
  classifyImageHttpFailure,
  classifyNoImage,
  DESIGN_BRIEF_LIMIT,
  failureDetail,
  imageFailureMessage,
  resolveImageStyle,
  type ImageFailureReason,
  type ImageStyle,
} from './imagePrompt.js';
import { type StockOrientation } from './stock.js';
import { imageDimensions } from './media.js';

// Re-exported so callers reach for one module, not two, when they need a photo.
export { orientationForBox };
export {
  IMAGE_STYLES,
  imageBriefLimit,
  imageFailureHttpStatus,
  imageFailureMessage,
  type ImageFailureReason,
  type ImageStyle,
} from './imagePrompt.js';
export { nearestAspectRatio, normalizeAspectRatio } from './imageBytes.js';

const OPENROUTER_API_KEY = (process.env.OPENROUTER_API_KEY ?? '').trim();

// Image-capable OpenRouter model slug. Swap via MAGAZINE_V2_IMAGE_MODEL — use
// the exact slug from openrouter.ai/models, and note it must support image
// OUTPUT (most chat models do not; a text-only model returns no image and this
// module reports it as a failure).
// Gemini Nano Banana 2.1 — confirmed with the user 2026-11-12 (verified on openrouter.ai).
const DEFAULT_IMAGE_MODEL = 'google/gemini-nano-banana-2.1';
const IMAGE_MODEL = (process.env.MAGAZINE_V2_IMAGE_MODEL ?? '').trim() || DEFAULT_IMAGE_MODEL;

/** How long one image call may take. Image models are slow; an unbounded wait would
 *  hold a generation worker (or an HTTP request) open indefinitely. */
const IMAGE_TIMEOUT_MS = 60_000;

/** True when we can both generate (OpenRouter key) AND persist (S3) an image. */
export function isImageGenConfigured(): boolean {
  return !!OPENROUTER_API_KEY && storage.isConfigured();
}

/** Optional per-call shaping: the frame, the kind of picture, and its look. */
export interface ImageShapeAndStyle {
  /** An aspect ratio, e.g. '4:5' — snapped to the nearest one the model supports
   *  (IMAGE_ASPECT_RATIOS); it wins over the orientation's default. */
  aspectRatio?: string;
  /**
   * 'photo' (default) | 'illustration' | 'graphic' | 'poster'. For backward
   * compatibility any OTHER string means "a photo in this look" — generate.ts passes
   * the Creative Director's photographic style here (see resolveImageStyle).
   */
  style?: ImageStyle | (string & {});
  /** The issue's photographic look, for a photo (the Creative Director's photoStyle). */
  photoStyle?: string;
  /** Purely decorative: the picture shows no real data (no readable numbers or labels). */
  decorative?: boolean;
  /** The magazine's colours (#rrggbb), for an illustration, graphic or poster. */
  colors?: string[];
}

/**
 * The SHAPE of the frame, as a request parameter rather than a wish.
 *
 * Asking for orientation in the prompt does not work: measured against
 * gemini-2.5-flash-image, "Horizontal landscape orientation" and even "Aspect
 * ratio 3:2 — noticeably wider than tall" both come back 1024×1024. `image_config`
 * does work (3:2 → 1248×832, 2:3 → 832×1248), and the difference matters because
 * a square image dropped into a tall slot is cropped by `fit: 'cover'` — the
 * model composes for a frame we then throw half of away.
 *
 * The prompt line stays as well: it costs nothing, and it is what a model without
 * `image_config` support has to go on.
 */
function aspectRatioFor(orientation: StockOrientation): string {
  return orientation === 'portrait' ? '2:3' : orientation === 'landscape' ? '3:2' : '1:1';
}

interface GeneratedImage {
  bytes: Buffer;
  contentType: string;
  alt: string;
}

type GenerateOutcome = { ok: true; image: GeneratedImage } | { ok: false; reason: ImageFailureReason; detail: string };

/** The text of a chat message, whether the provider sent a string or content parts. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
      .join(' ');
  }
  return '';
}

/** The useful part of an OpenRouter error body: its message when it is JSON. */
function errorBodyDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed?.error?.message === 'string') return failureDetail(parsed.error.message);
  } catch {
    /* not JSON — use the raw text */
  }
  return failureDetail(body);
}

/**
 * Call OpenRouter's chat/completions with modalities:["image","text"] and pull
 * the first generated image out of choices[0].message.images[0]. The image comes
 * back as a data: URL (data:image/<type>;base64,<payload>), which we decode to
 * raw bytes. Every way this can fail comes back as a typed reason, metered.
 */
async function generateImage(
  brief: string,
  orientation: StockOrientation,
  withAspect = true,
  shape: ImageShapeAndStyle = {},
): Promise<GenerateOutcome> {
  if (!OPENROUTER_API_KEY) return { ok: false, reason: 'unavailable', detail: 'no image model key on this server' };
  const prompt = buildImagePrompt(brief, orientation, shape);
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: IMAGE_MODEL,
        modalities: ['image', 'text'],
        messages: [{ role: 'user', content: prompt }],
        ...(withAspect ? { image_config: { aspect_ratio: shape.aspectRatio || aspectRatioFor(orientation) } } : {}),
      }),
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    });
  } catch (err) {
    // A timeout used to throw past the meter entirely, so a call OpenRouter may still
    // bill never appeared in AI Activity.
    const reason = classifyImageError(err);
    const detail = reason === 'timeout' ? `timeout after ${Math.round(IMAGE_TIMEOUT_MS / 1000)}s` : `network: ${failureDetail(err instanceof Error ? err.message : String(err))}`;
    console.warn(`[magazineV2] image model ${IMAGE_MODEL} request failed (${reason}): ${detail}`);
    meterImage(started, false, undefined, detail);
    return { ok: false, reason, detail };
  }
  if (!res.ok) {
    // `image_config` is not universal, and MAGAZINE_V2_IMAGE_MODEL means the slug
    // is the deployment's choice. Rather than make a working key stop working the
    // day someone swaps the model, drop the parameter and ask once more — a
    // square image is a far better outcome than no image.
    if (withAspect && res.status === 400) {
      console.warn(`[magazineV2] image model ${IMAGE_MODEL} rejected image_config; retrying without it`);
      return generateImage(brief, orientation, false, shape);
    }
    const body = await res.text().catch(() => '');
    const reason = classifyImageHttpFailure(res.status, body);
    const detail = errorBodyDetail(body);
    console.warn(`[magazineV2] image model ${IMAGE_MODEL} returned ${res.status} (${reason})${detail ? `: ${detail}` : ''}`);
    meterImage(started, false, undefined, `HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    return { ok: false, reason, detail };
  }
  let data: {
    choices?: Array<{
      finish_reason?: string;
      native_finish_reason?: string;
      message?: { content?: unknown; images?: Array<{ image_url?: { url?: string } }> };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    error?: { code?: unknown; message?: unknown };
  };
  try {
    data = await res.json();
  } catch (err) {
    const reason = classifyImageError(err) === 'timeout' ? 'timeout' : 'failed';
    meterImage(started, false, undefined, reason === 'timeout' ? 'timeout reading the reply' : 'unreadable reply');
    return { ok: false, reason, detail: reason === 'timeout' ? 'timed out reading the reply' : 'the reply could not be read' };
  }
  // OpenRouter can answer 200 with an error object (an upstream failure mid-request).
  if (data?.error) {
    const msg = failureDetail(data.error.message);
    const reason = classifyImageHttpFailure(Number(data.error.code) || 500, msg);
    console.warn(`[magazineV2] image model ${IMAGE_MODEL} returned an error (${reason}): ${msg}`);
    meterImage(started, false, data.usage, `error ${String(data.error.code ?? '')}: ${msg}`);
    return { ok: false, reason, detail: msg };
  }
  const choice = data.choices?.[0];
  const dataUrl = choice?.message?.images?.[0]?.image_url?.url;
  if (!dataUrl) {
    // A 200 with no picture is the model DECLINING (it wrote text instead) — logged as a
    // failure with its own words, not counted as a success.
    const finish = choice?.native_finish_reason || choice?.finish_reason || '';
    const no = classifyNoImage(finish, messageText(choice?.message?.content));
    console.warn(`[magazineV2] image model ${IMAGE_MODEL} returned no image (${no.reason}): ${no.detail}`);
    meterImage(started, false, data.usage, `no image: ${[finish, no.detail].filter(Boolean).join(' — ')}`.slice(0, 300));
    return { ok: false, reason: no.reason, detail: no.detail };
  }
  meterImage(started, true, data.usage);
  const decoded = decodeDataUrl(dataUrl);
  if (!decoded) return { ok: false, reason: 'failed', detail: 'the model returned something that is not a usable picture' };
  return { ok: true, image: { ...decoded, alt: brief.trim().slice(0, 300) } };
}

/** One AI Activity record per image call. OpenRouter reports the billed cost. */
function meterImage(
  started: number,
  ok: boolean,
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number },
  error?: string,
): void {
  recordAiUsage({
    model: IMAGE_MODEL,
    kind: 'image',
    surface: 'magazine-builder',
    feature: 'image-generation',
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    costUsd: typeof usage?.cost === 'number' ? usage.cost : undefined,
    durationMs: Date.now() - started,
    ok,
    ...(error ? { error } : {}),
  });
}

/** What a generated image becomes: an element-ready reference plus what it is. */
export interface GeneratedImageAsset {
  url: string;
  assetId: string;
  alt: string;
  /** The kind of picture that was asked for. */
  style: ImageStyle;
  /** The media row's kind: a photo is a 'photo'; anything drawn is a 'graphic'. */
  kind: 'photo' | 'graphic';
}

export type ImageGenResult =
  | ({ ok: true } & GeneratedImageAsset)
  | {
      ok: false;
      reason: ImageFailureReason;
      /** A sentence to relay to the user (and the model): what happened, whether to retry. */
      message: string;
      /** The model's or provider's own words, when there were any. */
      detail?: string;
    };

export type ImageGenOptions = { prompt: string; orientation?: StockOrientation } & ImageShapeAndStyle;

function failed(reason: ImageFailureReason, detail?: string): ImageGenResult {
  return { ok: false, reason, message: imageFailureMessage(reason, reason === 'refused' || reason === 'failed' ? detail : undefined), ...(detail ? { detail } : {}) };
}

/**
 * Generate + store an AI image as a MediaAsset, with the REASON when it fails.
 * Never throws. This is the door for anything that talks to a person (the Studio's
 * generate_image, the Make-image route): relay `message` as-is — it says whether a
 * retry can help.
 *
 * `orientation` may be omitted when `aspectRatio` is given (it is derived from it);
 * with neither, the frame is landscape. `pageIndex` is null for a library add that
 * isn't tied to a page (the editor's Generate button), matching how an uploaded
 * image is recorded.
 */
export async function generateImageAsset(opts: ImageGenOptions, ctx: { magazineId: string; pageIndex?: number | null }): Promise<ImageGenResult> {
  if (!OPENROUTER_API_KEY) return failed('unavailable', 'no image model key on this server');
  if (!storage.isConfigured()) return failed('unavailable', 'no file storage on this server');
  const { kind, photoStyle } = resolveImageStyle(opts.style, opts.photoStyle);
  const brief = String(opts.prompt ?? '').trim().slice(0, DESIGN_BRIEF_LIMIT);
  if (!brief) return failed('failed', 'no description');
  const aspectRatio = normalizeAspectRatio(opts.aspectRatio);
  const orientation: StockOrientation = opts.orientation ?? (aspectRatio ? orientationForAspectRatio(aspectRatio) : undefined) ?? 'landscape';
  try {
    const out = await generateImage(brief, orientation, true, {
      aspectRatio,
      style: kind,
      photoStyle,
      decorative: opts.decorative === true,
      colors: opts.colors,
    });
    if (!out.ok) return failed(out.reason, out.detail);
    const generated = out.image;
    // From the SNIFFED type (see decodeDataUrl), so the key's extension and the
    // stored content-type can never disagree.
    const ext = imageExtFor(generated.contentType);
    const pageIndex = typeof ctx.pageIndex === 'number' ? ctx.pageIndex : null;
    const suffix = pageIndex === null ? '' : `-p${pageIndex}`;
    const key = `public/magazinesV2/${ctx.magazineId}/media/${crypto.randomUUID()}-gen${suffix}.${ext}`;
    await storage.uploadObject({ key, contentType: generated.contentType, body: generated.bytes });
    const url = storage.publicUrl(key);
    const now = new Date().toISOString();
    // A photograph is a 'photo'; an illustration, graphic or poster is a 'graphic' —
    // both placeable (media.ts), but only a photo should ever be mistaken for one.
    const mediaKind: 'photo' | 'graphic' = kind === 'photo' ? 'photo' : 'graphic';
    // Its own pixel size, read from the file header, so the Studio can size a box to
    // the picture's shape (set_image_fit fitBoxToImage) and describe it with its size.
    const natural = imageDimensions(generated.bytes);
    const assetId = await db.collection(COL.media).insertOne({
      magazineId: ctx.magazineId,
      pageIndex,
      key,
      url,
      contentType: generated.contentType,
      size: generated.bytes.length,
      ...(natural ? { width: natural.width, height: natural.height } : {}),
      alt: generated.alt,
      kind: mediaKind,
      // 'ai-image' is what tells the library, and anyone auditing it later, that
      // nobody photographed or drew this.
      source: 'ai-image',
      imageStyle: kind,
      ...(opts.decorative === true ? { decorative: true } : {}),
      attribution: { author: `AI (${IMAGE_MODEL})`, url: '' },
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true, url, assetId: String(assetId), alt: generated.alt, style: kind, kind: mediaKind };
  } catch (err) {
    console.warn('[magazineV2] image generation failed:', err instanceof Error ? err.message : err);
    return failed('failed', 'the picture could not be saved');
  }
}

/**
 * Generate + store an AI image as a MediaAsset. Returns the element-ready image
 * reference, or null on no key/S3, no image, or any error (NEVER throws — a
 * missing photo must not fail the page; unattended callers degrade to a colour
 * block). Kept for the unattended callers (generation's photo ladder); anything that
 * reports to a person should call generateImageAsset and relay its reason.
 */
export async function generateAndStoreImage(
  opts: ImageGenOptions,
  ctx: { magazineId: string; pageIndex?: number | null },
): Promise<{ url: string; assetId: string; alt: string } | null> {
  if (!isImageGenConfigured()) return null;
  const out = await generateImageAsset(opts, ctx);
  return out.ok ? { url: out.url, assetId: out.assetId, alt: out.alt } : null;
}
