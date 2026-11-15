// ---------------------------------------------------------------------------
// Magazine Builder v2 — what we ASK the image model for, and what we tell people
// when it says no.
//
// The pure half of imagegen.ts's request side (imageBytes.ts is the pure half of its
// response side). Separate for the same reason: imagegen.ts imports db/storage, which
// throw at import time without MONGODB_URI, so nothing in it can be unit-tested.
//
// ONE "MAKE AN IMAGE" CAPABILITY, FOUR STYLES. The prompt used to be hard-coded to
// "Editorial magazine photograph … No text … Photorealistic", so every illustration,
// poster or graphic a client asked for came back as a text-free photo (audit C37).
// Now the caller says what kind of picture it wants:
//
//   photo        — the default, and BYTE-FOR-BYTE the prompt it always was: a
//                  text-free editorial photograph (the layout owns every word on the
//                  page; baked-in lettering cannot be edited, translated or resized);
//   illustration — a finished editorial illustration, not a photograph;
//   graphic      — a flat, simple design element;
//   poster       — a complete poster composition.
//
// The non-photo styles MAY carry words — but only the words the user asked for,
// spelled exactly (quoted phrases in the brief are lifted out and named as the only
// lettering allowed), never invented ones. None of them is a CHART: numbers drawn by an
// image model are made up, so chart requests go to add_chart (chartSpec.ts guard).
//
// TYPED FAILURES (audit C42). A refusal, an empty account, a rate limit and a timeout
// used to all become "try again, or a simpler description" — so the model retried a
// paid, 60-second call that could not succeed, and the user never learned why. Each
// now has a reason and a sentence that says what to do (and whether to retry).
// ---------------------------------------------------------------------------

import type { StockOrientation } from './stock.js';

// ── styles ───────────────────────────────────────────────────────────────────

export const IMAGE_STYLES = ['photo', 'illustration', 'graphic', 'poster'] as const;
export type ImageStyle = (typeof IMAGE_STYLES)[number];

export function isImageStyle(v: unknown): v is ImageStyle {
  return typeof v === 'string' && (IMAGE_STYLES as readonly string[]).includes(v);
}

/**
 * Which kind of picture, and the photographic LOOK for a photo.
 *
 * `style` predates the kinds: generate.ts passes the Creative Director's free-text
 * photographic style ("natural light, muted film tones…") in it. So a `style` that is
 * not one of IMAGE_STYLES keeps that meaning — a photo in that look — and existing
 * callers behave exactly as before. New callers pass the kind in `style` and the look
 * in `photoStyle`.
 */
export function resolveImageStyle(style?: string, photoStyle?: string): { kind: ImageStyle; photoStyle?: string } {
  const look = typeof photoStyle === 'string' && photoStyle.trim() ? photoStyle.trim() : undefined;
  if (isImageStyle(style)) return { kind: style, ...(look ? { photoStyle: look } : {}) };
  const legacy = typeof style === 'string' && style.trim() ? style.trim() : undefined;
  const merged = look ?? legacy;
  return { kind: 'photo', ...(merged ? { photoStyle: merged } : {}) };
}

/** How long a description may be. A photo brief is subject + setting + mood; a poster
 *  or graphic brief also carries its words and layout, so it gets more room. */
export const PHOTO_BRIEF_LIMIT = 600;
export const DESIGN_BRIEF_LIMIT = 1500;

export function imageBriefLimit(style?: string): number {
  return resolveImageStyle(style).kind === 'photo' ? PHOTO_BRIEF_LIMIT : DESIGN_BRIEF_LIMIT;
}

/**
 * The exact words a brief asks to see in the picture: its quoted phrases ("…", “…”,
 * «…»), up to six, each at most 80 characters. Single quotes are not read — they are
 * apostrophes far more often than quotes ("the horse's mane").
 */
export function requestedWords(brief: string): string[] {
  const out: string[] = [];
  const re = /"([^"\n]{1,80})"|“([^”\n]{1,80})”|«([^»\n]{1,80})»/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(brief)) && out.length < 6) {
    const w = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\s+/g, ' ').trim();
    if (w && !out.includes(w)) out.push(w);
  }
  return out;
}

export interface ImagePromptOptions {
  /** One of IMAGE_ASPECT_RATIOS (imageBytes.ts), e.g. '4:5'. */
  aspectRatio?: string;
  /** 'photo' | 'illustration' | 'graphic' | 'poster' — or, for backward compatibility,
   *  free text meaning "a photo in this look" (see resolveImageStyle). */
  style?: string;
  /** The issue's photographic look (the Creative Director's photoStyle). Photos only. */
  photoStyle?: string;
  /** Purely decorative: the picture must not pretend to show real data. */
  decorative?: boolean;
  /** The magazine's colours (#rrggbb), for illustrations, graphics and posters. */
  colors?: string[];
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * The prompt for one picture. For a photo with no new options this is EXACTLY the
 * prompt imagegen.ts always sent (the test pins it), so automatic generation and
 * every existing caller are unchanged.
 */
export function buildImagePrompt(brief: string, orientation: StockOrientation, opts: ImagePromptOptions = {}): string {
  const { kind, photoStyle } = resolveImageStyle(opts.style, opts.photoStyle);
  // A photo brief is passed through untouched, exactly as before (callers already hold it
  // to PHOTO_BRIEF_LIMIT); the longer design briefs are capped here.
  const text = kind === 'photo' ? brief.trim() : brief.trim().slice(0, DESIGN_BRIEF_LIMIT);
  const aspect = opts.aspectRatio
    ? `Frame: ${opts.aspectRatio} aspect ratio.`
    : orientation === 'portrait'
      ? 'Vertical portrait orientation.'
      : orientation === 'landscape'
        ? 'Horizontal landscape orientation.'
        : 'Square (1:1) orientation.';

  if (kind === 'photo') {
    return [
      `Editorial magazine photograph: ${text}`,
      aspect,
      // The issue's ONE photographic style (the Creative Director's concept), so a
      // generated picture sits next to the found ones as if one photographer shot both.
      photoStyle ? `Photographic style: ${photoStyle.slice(0, 400)}.` : '',
      'No text, letters, words, watermarks, or logos in the image.',
      'No identifiable real individuals. Photorealistic editorial photography.',
    ]
      .filter(Boolean)
      .join(' ');
  }

  const opening =
    kind === 'illustration'
      ? [`Editorial magazine illustration: ${text}`, 'A finished, polished illustration in a contemporary editorial style — not a photograph.']
      : kind === 'graphic'
        ? [`Clean editorial graphic: ${text}`, 'Flat, simple shapes and a bold, uncluttered composition on a plain background, like a designed magazine element — not a photograph.']
        : [`Magazine poster design: ${text}`, 'A complete poster composition with one strong focal image and a clear visual hierarchy — not a photograph of a poster.'];
  const colors = (opts.colors ?? []).filter((c) => HEX.test(c)).slice(0, 5);
  const words = requestedWords(text);
  const lettering = words.length
    ? `Lettering: render exactly this text, spelled exactly as written, and no other words: ${words.map((w) => `"${w}"`).join(', ')}.`
    : kind === 'poster'
      ? 'Lettering: only the words the description asks for, spelled exactly, large and legible; no other text and no made-up words.'
      : 'No text or lettering unless the description asks for specific words; never invent words.';
  return [
    ...opening,
    aspect,
    colors.length ? `Colour palette: ${colors.join(', ')}.` : '',
    lettering,
    opts.decorative ? 'Purely decorative: show no real data — no readable numbers, values, axis labels or legends.' : '',
    'No watermarks, signatures or logos. No identifiable real individuals.',
  ]
    .filter(Boolean)
    .join(' ');
}

// ── failures ─────────────────────────────────────────────────────────────────

export const IMAGE_FAILURE_REASONS = ['refused', 'no-credit', 'rate-limited', 'timeout', 'unavailable', 'failed'] as const;
export type ImageFailureReason = (typeof IMAGE_FAILURE_REASONS)[number];

const REFUSAL_WORDS = /moderat|safety|polic(y|ies)|flagged|blocked|prohibit|not allowed|disallow|refus|declin|inappropriate|violat/i;
const CREDIT_WORDS = /insufficient (credits?|balance|funds)|more credits|out of credit|credit limit|payment required|billing/i;

/**
 * An HTTP failure from OpenRouter, by status and (when the status is ambiguous) its body:
 * 402 is the account out of credit; 429 a rate limit; 403 OpenRouter's moderation;
 * 408/504/524 a timeout upstream; 401/404 and 5xx the service or model unavailable.
 */
export function classifyImageHttpFailure(status: number, body = ''): ImageFailureReason {
  if (status === 402 || CREDIT_WORDS.test(body)) return 'no-credit';
  if (status === 429) return 'rate-limited';
  if (status === 408 || status === 504 || status === 524) return 'timeout';
  if (status === 403) return 'refused';
  if (status === 401 || status === 404) return 'unavailable';
  if (status === 400 || status === 422) return REFUSAL_WORDS.test(body) ? 'refused' : 'failed';
  if (status >= 500) return 'unavailable';
  return 'failed';
}

/** A thrown fetch: our 60s abort (or any timeout) versus the service being unreachable. */
export function classifyImageError(err: unknown): ImageFailureReason {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name?: unknown }).name) : '';
  const message = err instanceof Error ? err.message : String(err ?? '');
  if (name === 'TimeoutError' || name === 'AbortError' || /timed? ?out|timeout/i.test(message)) return 'timeout';
  return 'unavailable';
}

/** The model's own words, tidied for a log line or a user message. */
export function failureDetail(text: unknown, max = 200): string {
  const s = typeof text === 'string' ? text : '';
  return s.replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * A 200 reply with no image in it. A safety/filter finish is a refusal; so is a reply
 * that came back as TEXT — the model wrote to us instead of drawing, which is how an
 * image model declines. Nothing at all is a plain failure.
 */
export function classifyNoImage(finishReason: unknown, content: unknown): { reason: 'refused' | 'failed'; detail: string } {
  const finish = typeof finishReason === 'string' ? finishReason : '';
  const detail = failureDetail(content);
  if (/safety|filter|block|prohibit|recitation|refus/i.test(finish)) return { reason: 'refused', detail: detail || `stopped: ${finish}` };
  if (detail) return { reason: 'refused', detail };
  return { reason: 'failed', detail: finish ? `no image (${finish})` : 'no image in the reply' };
}

/**
 * What the AI (and, through it, the user) is told. Each sentence says whether a retry
 * can help: only an unexplained failure is worth one more attempt; a refusal needs a
 * different subject; credit, rate limits and outages need the user told, not a loop.
 */
export function imageFailureMessage(reason: ImageFailureReason, detail?: string): string {
  const why = detail ? failureDetail(detail, 160) : '';
  switch (reason) {
    case 'refused':
      return `The image model declined to make this picture${why ? ` ("${why}")` : ''}. Explain that to the user in plain words and suggest a different subject or wording — do not retry the same request.`;
    case 'no-credit':
      return 'AI image generation is out of credit right now. Do not retry; tell the user image generation is unavailable until the account is topped up (a stock photo can be used meanwhile).';
    case 'rate-limited':
      return 'The image model is receiving too many requests right now. Do not retry in this turn; tell the user to try again in a minute or two.';
    case 'timeout':
      return 'The image model took too long and timed out. Do not retry in this turn; tell the user and offer to try again.';
    case 'unavailable':
      return 'AI image generation is unavailable right now (the image service could not be reached). Do not retry; tell the user it is unavailable at the moment.';
    case 'failed':
    default:
      return `The image model did not return a usable picture${why ? ` (${why})` : ''}. Try once more with a simpler, more concrete description.`;
  }
}

/** The HTTP status a route answers with for each failure. */
export function imageFailureHttpStatus(reason: ImageFailureReason): number {
  switch (reason) {
    case 'refused':
      return 422;
    case 'rate-limited':
      return 429;
    case 'timeout':
      return 504;
    case 'no-credit':
    case 'unavailable':
      return 503;
    case 'failed':
    default:
      return 502;
  }
}
