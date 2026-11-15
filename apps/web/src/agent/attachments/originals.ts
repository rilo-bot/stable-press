// ---------------------------------------------------------------------------
// The user's ORIGINAL image files, kept beside the reduced copies the model reads.
//
// A chat image is re-encoded before it is sent (attachments.ts: a JPEG, at most
// 1568px) because the data URL is re-sent on every turn and the model needs no
// more. That copy is right for READING and wrong for PLACING: a transparent PNG —
// a sponsor logo, a chart, a cut-out — came out as a downscaled JPEG on a solid
// black box, and that JPEG is what The Stable Hand's `upload` tool put on the page
// (runtime/attachmentsStore.ts rebuilds the file from the sent data URL).
//
// So the original File is remembered here, keyed by the data URL the chat sent,
// and attachmentToFile hands it out instead of the reduced copy. Session-only and
// bounded: a thread restored after a reload has no originals and falls back to
// the data URL, exactly as before. Pure module (no DOM beyond File) — tested in
// originals.test.ts.
// ---------------------------------------------------------------------------

/** How many originals are kept (oldest forgotten first). */
export const MAX_ORIGINALS = 24;

/**
 * Larger originals are not handed out: the magazine media library refuses images
 * over 15 MB (apps/server/src/lib/magazineV2/config.ts MAX_IMAGE_BYTES), and the
 * reduced copy is the better thing to place than a refusal.
 */
export const ORIGINAL_MAX_BYTES = 15 * 1024 * 1024;

/** Types an upload input or the media library takes as they are. AVIF is left
 *  out on purpose: the library refuses it, and the reduced JPEG is placeable. */
const KEEPABLE = /^image\/(png|jpeg|webp|gif)$/i;

/**
 * The key for a data URL. Not the whole string (megabytes as a Map key, hashed on
 * every lookup): its length plus its last 64 characters. The tail of a base64
 * payload is the end of the encoded bytes, so two different images sharing both is
 * not a practical concern — and a miss only means the reduced copy is used.
 */
export function attachmentKey(url: string): string {
  return `${url.length}:${url.slice(-64)}`;
}

const originals = new Map<string, File>();

/** Remember the original behind a sent data URL (images only). */
export function rememberOriginal(url: string, file: File): void {
  if (!url || !KEEPABLE.test(file.type)) return;
  const key = attachmentKey(url);
  // Re-insert so the Map's insertion order stays "least recently remembered first".
  originals.delete(key);
  originals.set(key, file);
  while (originals.size > MAX_ORIGINALS) {
    const oldest = originals.keys().next();
    if (oldest.done) break;
    originals.delete(oldest.value);
  }
}

/** The original File behind this data URL, when it is known and placeable. */
export function originalFor(url: string | undefined | null): File | undefined {
  if (!url) return undefined;
  const f = originals.get(attachmentKey(url));
  return f && f.size > 0 && f.size <= ORIGINAL_MAX_BYTES ? f : undefined;
}

/** Forget every original (tests; nothing in the app needs it). */
export function forgetOriginals(): void {
  originals.clear();
}
