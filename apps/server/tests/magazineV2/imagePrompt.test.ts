// ---------------------------------------------------------------------------
// What the image model is asked for (one capability, four styles) and what people
// are told when it fails (a typed reason per failure, audit C42). Plus the aspect
// ratio a caller passes being snapped to one the model accepts. Pure — imagegen.ts
// itself imports db/storage and cannot load here; this is its testable half.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildImagePrompt,
  classifyImageError,
  classifyImageHttpFailure,
  classifyNoImage,
  imageBriefLimit,
  imageFailureHttpStatus,
  imageFailureMessage,
  IMAGE_FAILURE_REASONS,
  requestedWords,
  resolveImageStyle,
} from '../../src/lib/magazineV2/imagePrompt.js';
import { normalizeAspectRatio, orientationForAspectRatio } from '../../src/lib/magazineV2/imageBytes.js';

/** The prompt imagegen.ts sent before styles existed, verbatim — the photo path must not drift. */
function legacyPrompt(brief: string, orientation: 'portrait' | 'landscape' | 'square', opts: { aspectRatio?: string; style?: string } = {}): string {
  const aspect = opts.aspectRatio
    ? `Frame: ${opts.aspectRatio} aspect ratio.`
    : orientation === 'portrait'
      ? 'Vertical portrait orientation.'
      : orientation === 'landscape'
        ? 'Horizontal landscape orientation.'
        : 'Square (1:1) orientation.';
  return [
    `Editorial magazine photograph: ${brief.trim()}`,
    aspect,
    opts.style?.trim() ? `Photographic style: ${opts.style.trim().slice(0, 400)}.` : '',
    'No text, letters, words, watermarks, or logos in the image.',
    'No identifiable real individuals. Photorealistic editorial photography.',
  ]
    .filter(Boolean)
    .join(' ');
}

// ── styles ───────────────────────────────────────────────────────────────────

test('photo (the default) is byte-for-byte the prompt it always was', () => {
  assert.equal(buildImagePrompt(' a grey mare in morning mist ', 'landscape'), legacyPrompt(' a grey mare in morning mist ', 'landscape'));
  assert.equal(buildImagePrompt('farrier at work', 'portrait', { aspectRatio: '4:5' }), legacyPrompt('farrier at work', 'portrait', { aspectRatio: '4:5' }));
  assert.equal(buildImagePrompt('stable yard', 'square', { style: 'photo' }), legacyPrompt('stable yard', 'square'));
});

test('a free-text style is still the photographic LOOK (generate.ts passes it that way)', () => {
  const look = 'natural light, muted film tones';
  assert.equal(buildImagePrompt('jockey weighing in', 'landscape', { style: look }), legacyPrompt('jockey weighing in', 'landscape', { style: look }));
  assert.deepEqual(resolveImageStyle(look), { kind: 'photo', photoStyle: look });
  assert.deepEqual(resolveImageStyle('poster', look), { kind: 'poster', photoStyle: look });
  assert.deepEqual(resolveImageStyle(undefined), { kind: 'photo' });
});

test('an illustration is not forced photoreal or wordless, and names the words asked for', () => {
  const p = buildImagePrompt('our five-step foaling process, with the heading "From Foal to Track"', 'landscape', { style: 'illustration' });
  assert.match(p, /^Editorial magazine illustration:/);
  assert.ok(!/Photorealistic/.test(p));
  assert.ok(!/No text, letters, words/.test(p));
  assert.match(p, /render exactly this text, spelled exactly as written, and no other words: "From Foal to Track"/);
  assert.match(p, /No identifiable real individuals/);
});

test('a poster with no quoted words still asks for only the words described, spelled exactly', () => {
  const p = buildImagePrompt('spring carnival poster with the title Spring Raceday', 'portrait', { style: 'poster', aspectRatio: '2:3' });
  assert.match(p, /^Magazine poster design:/);
  assert.match(p, /Frame: 2:3 aspect ratio\./);
  assert.match(p, /only the words the description asks for, spelled exactly/);
});

test('a graphic says flat and plain; colours and decorative are passed through', () => {
  const p = buildImagePrompt('a rosette motif', 'square', { style: 'graphic', colors: ['#0b1f3a', '#c8102e', 'red', 'url(x)'], decorative: true });
  assert.match(p, /^Clean editorial graphic:/);
  assert.match(p, /Colour palette: #0b1f3a, #c8102e\./);
  assert.match(p, /Purely decorative: show no real data/);
  assert.ok(!p.includes('url(x)'));
  // An illustration without quoted words is told not to invent any.
  assert.match(buildImagePrompt('a horse', 'square', { style: 'illustration' }), /never invent words/);
});

test('brief limits: 600 for a photo, longer for designed pictures (and the design brief is capped)', () => {
  assert.equal(imageBriefLimit(), 600);
  assert.equal(imageBriefLimit('photo'), 600);
  assert.equal(imageBriefLimit('natural light'), 600);
  assert.equal(imageBriefLimit('poster'), 1500);
  const long = 'x'.repeat(2000);
  assert.ok(buildImagePrompt(long, 'square', { style: 'poster' }).includes('x'.repeat(1500)));
  assert.ok(!buildImagePrompt(long, 'square', { style: 'poster' }).includes('x'.repeat(1501)));
});

test('requestedWords reads double, curly and guillemet quotes — not apostrophes', () => {
  assert.deepEqual(requestedWords('a sign saying "Open Day" and “All Welcome”, the horse\'s mane, «Go»'), ['Open Day', 'All Welcome', 'Go']);
  assert.deepEqual(requestedWords("the trainer's yard"), []);
});

// ── failures ─────────────────────────────────────────────────────────────────

test('HTTP failures are typed: credit, rate limit, moderation, timeouts, outages', () => {
  assert.equal(classifyImageHttpFailure(402), 'no-credit');
  assert.equal(classifyImageHttpFailure(400, '{"error":{"message":"Insufficient credits"}}'), 'no-credit');
  assert.equal(classifyImageHttpFailure(429), 'rate-limited');
  assert.equal(classifyImageHttpFailure(403, 'flagged by moderation'), 'refused');
  assert.equal(classifyImageHttpFailure(400, 'Request blocked by safety policy'), 'refused');
  assert.equal(classifyImageHttpFailure(400, 'bad request'), 'failed');
  assert.equal(classifyImageHttpFailure(408), 'timeout');
  assert.equal(classifyImageHttpFailure(524), 'timeout');
  assert.equal(classifyImageHttpFailure(401), 'unavailable');
  assert.equal(classifyImageHttpFailure(503), 'unavailable');
});

test('a thrown fetch: our abort is a timeout; anything else is the service unreachable', () => {
  const timeout = new Error('The operation was aborted due to timeout');
  timeout.name = 'TimeoutError';
  assert.equal(classifyImageError(timeout), 'timeout');
  assert.equal(classifyImageError(new TypeError('fetch failed')), 'unavailable');
});

test('a 200 with no image: text back is a refusal (with its words); nothing is a failure', () => {
  assert.deepEqual(classifyNoImage('stop', "  I can't create images of   real people. "), { reason: 'refused', detail: "I can't create images of real people." });
  assert.equal(classifyNoImage('IMAGE_SAFETY', '').reason, 'refused');
  assert.equal(classifyNoImage('content_filter', '').reason, 'refused');
  assert.equal(classifyNoImage('stop', '').reason, 'failed');
  assert.equal(classifyNoImage(undefined, undefined).reason, 'failed');
});

test('messages say whether to retry — only an unexplained failure invites one', () => {
  for (const reason of IMAGE_FAILURE_REASONS) {
    const m = imageFailureMessage(reason, 'model words');
    if (reason === 'failed') assert.match(m, /Try once more/);
    else assert.match(m, /Do not retry|do not retry/);
  }
  assert.match(imageFailureMessage('refused', "I can't draw that"), /declined.*"I can't draw that".*different subject/);
  assert.match(imageFailureMessage('no-credit'), /out of credit/);
});

test('route statuses per reason', () => {
  assert.equal(imageFailureHttpStatus('refused'), 422);
  assert.equal(imageFailureHttpStatus('rate-limited'), 429);
  assert.equal(imageFailureHttpStatus('timeout'), 504);
  assert.equal(imageFailureHttpStatus('no-credit'), 503);
  assert.equal(imageFailureHttpStatus('unavailable'), 503);
  assert.equal(imageFailureHttpStatus('failed'), 502);
});

// ── aspect ratio ─────────────────────────────────────────────────────────────

test('any ratio a caller passes is snapped to one the model accepts', () => {
  assert.equal(normalizeAspectRatio('4:5'), '4:5');
  assert.equal(normalizeAspectRatio('1075x360'), '21:9');
  assert.equal(normalizeAspectRatio('16/10'), '3:2');
  assert.equal(normalizeAspectRatio(' 1 : 1 '), '1:1');
  assert.equal(normalizeAspectRatio('wide'), undefined);
  assert.equal(normalizeAspectRatio('0:4'), undefined);
  assert.equal(normalizeAspectRatio(undefined), undefined);
  assert.equal(orientationForAspectRatio('21:9'), 'landscape');
  assert.equal(orientationForAspectRatio('4:5'), 'portrait');
  assert.equal(orientationForAspectRatio('1:1'), 'square');
});

test('a ratio written with decimals below 1 snaps to its own shape, not to square', () => {
  // nearestAspectRatio floors each side at 1px (it takes pixel sizes); a written ratio
  // must not be floored, or every portrait "0.8:1" comes back square.
  assert.equal(normalizeAspectRatio('0.8:1'), '4:5');
  assert.equal(normalizeAspectRatio('1:1.25'), '4:5');
  assert.equal(normalizeAspectRatio('0.5625:1'), '9:16');
  assert.equal(normalizeAspectRatio('1.5:1'), '3:2');
  assert.equal(normalizeAspectRatio('1237:1601'), '3:4');
});
