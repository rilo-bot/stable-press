// ---------------------------------------------------------------------------
// Magazine Builder v2 — the frame a generated picture is asked for.
//
// The Inspector's "Generate image" used to send only an orientation bucket (wide,
// tall, square), so a 4:5 portrait slot got a 2:3 or 3:4 picture and `cover` cropped
// the subject's head or feet. POST /media/generate takes the exact frame too, and
// snaps it to the nearest ratio the image model supports; this turns a box into it.
//
// Pure (no DOM, no network) so it runs under `npx tsx --test`.
// ---------------------------------------------------------------------------

/**
 * The frame of a w×h box as an "a:b" ratio the image route understands — whole
 * pixels, reduced by their greatest common divisor, so a 600×750 box asks for "4:5".
 * Null for a box with no area (nothing sensible to ask for). The server snaps the
 * ratio to one the model supports, so it need not be a common one; it only has to
 * stay short, and page boxes (a few thousand px at most) always do.
 */
export function boxAspectRatio(w: number, h: number): string | null {
  const a = Math.round(w);
  const b = Math.round(h);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
  let x = a;
  let y = b;
  while (y !== 0) [x, y] = [y, x % y];
  return `${a / x}:${b / x}`;
}
