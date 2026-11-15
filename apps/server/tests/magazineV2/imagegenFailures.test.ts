// ---------------------------------------------------------------------------
// imagegen.ts end to end, offline (audit C42 + the style/aspect options):
//   • every failure comes back with a typed reason and a sentence to relay;
//   • a refusal (200, text, no picture) is metered as a FAILURE with the model's words;
//   • a timeout is metered at all (it used to skip AI Activity entirely);
//   • a box's ratio is snapped to one the model accepts and sent as image_config;
//   • a poster is stored as a 'graphic', a photo as a 'photo';
//   • generateAndStoreImage keeps its old { url, assetId, alt } | null shape.
//
// Nothing leaves the process: `fetch` answers openrouter.ai and THROWS on anything
// else, `db.collection` and storage are patched in memory (the MONGODB_URI below is
// never connected to — db.ts connects lazily), and AI usage goes to a test sink.
// ---------------------------------------------------------------------------

import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

// Read at import time — set before the dynamic imports below.
process.env.MONGODB_URI = 'mongodb://db.invalid:27017/never-connected';
process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
delete process.env.MAGAZINE_V2_IMAGE_MODEL;
for (const k of ['S3_BUCKET', 'S3_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'S3_ENDPOINT', 'S3_PUBLIC_BASE_URL']) delete process.env[k];

type ImagegenMod = typeof import('../../src/lib/magazineV2/imagegen.js');
let imagegen: ImagegenMod;

const realFetch = globalThis.fetch;
/** The fake OpenRouter: set per test. Receives the parsed request body. */
let answer: (body: Record<string, unknown>, call: number) => Response | Promise<Response> = () => new Response('', { status: 500 });
let requests: Record<string, unknown>[] = [];
const rows: Record<string, unknown>[] = [];
const uploads: string[] = [];
const usage: { ok: boolean; error?: string; feature?: string }[] = [];

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
const imageReply = () =>
  Response.json({
    choices: [{ finish_reason: 'stop', message: { content: '', images: [{ image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 1290, cost: 0.04 },
  });

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== 'openrouter.ai') throw new Error(`test: unexpected network request to ${url.href}`);
  const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
  requests.push(body);
  return answer(body, requests.length);
}) as typeof fetch;

before(async () => {
  globalThis.fetch = fakeFetch;
  const { storage } = await import('../../src/lib/storage.js');
  storage.isConfigured = () => true;
  storage.uploadObject = (async (o: { key: string }) => {
    uploads.push(o.key);
  }) as typeof storage.uploadObject;
  storage.publicUrl = (key: string) => `https://cdn.test/${key}`;
  const { db } = await import('../../src/lib/db.js');
  (db as { collection: unknown }).collection = () => ({
    insertOne: async (doc: Record<string, unknown>) => {
      rows.push(doc);
      return `asset-${rows.length}`;
    },
  });
  const { setAiUsageSink } = await import('../../src/lib/agent/aiUsage.js');
  setAiUsageSink((r) => {
    usage.push({ ok: r.ok, error: r.error, feature: r.feature });
  });
  imagegen = await import('../../src/lib/magazineV2/imagegen.js');
});

after(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  requests = [];
  rows.length = 0;
  uploads.length = 0;
  usage.length = 0;
});

const CTX = { magazineId: 'mag-1', pageIndex: 3 };
const prompt = (body: Record<string, unknown>) => ((body.messages as { content: string }[])[0]!.content);

test('a picture: stored as a photo at the box\'s nearest supported ratio, metered as a success', async () => {
  answer = () => imageReply();
  const out = await imagegen.generateImageAsset({ prompt: 'a grey horse galloping along a beach', aspectRatio: '1075x360' }, CTX);
  assert.ok(out.ok);
  assert.equal(out.kind, 'photo');
  assert.equal(out.style, 'photo');
  assert.deepEqual(requests[0]!.image_config, { aspect_ratio: '21:9' });
  assert.match(prompt(requests[0]!), /^Editorial magazine photograph: a grey horse/);
  assert.equal(rows[0]!.kind, 'photo');
  assert.equal(rows[0]!.source, 'ai-image');
  assert.equal(rows[0]!.imageStyle, 'photo');
  assert.match(uploads[0]!, /^public\/magazinesV2\/mag-1\/media\/.+-gen-p3\.png$/);
  assert.deepEqual(usage, [{ ok: true, error: undefined, feature: 'image-generation' }]);
});

test('a poster: the poster prompt, stored as a graphic', async () => {
  answer = () => imageReply();
  const out = await imagegen.generateImageAsset({ prompt: 'Spring carnival poster titled "Raceday"', style: 'poster', aspectRatio: '2:3' }, CTX);
  assert.ok(out.ok);
  assert.equal(out.kind, 'graphic');
  assert.match(prompt(requests[0]!), /^Magazine poster design:.*"Raceday"/);
  assert.equal(rows[0]!.kind, 'graphic');
});

test('402: out of credit — typed, told not to retry, metered as a failure', async () => {
  answer = () => Response.json({ error: { code: 402, message: 'Insufficient credits' } }, { status: 402 });
  const out = await imagegen.generateImageAsset({ prompt: 'a horse', orientation: 'square' }, CTX);
  assert.equal(out.ok, false);
  assert.equal((out as { reason: string }).reason, 'no-credit');
  assert.match((out as { message: string }).message, /out of credit.*Do not retry/);
  assert.equal(usage.length, 1);
  assert.equal(usage[0]!.ok, false);
  assert.match(usage[0]!.error!, /HTTP 402: Insufficient credits/);
  assert.equal(rows.length, 0);
});

test('429 and a 200 carrying an error object are both "rate-limited"', async () => {
  answer = () => new Response('slow down', { status: 429 });
  assert.equal(((await imagegen.generateImageAsset({ prompt: 'a horse' }, CTX)) as { reason: string }).reason, 'rate-limited');
  answer = () => Response.json({ error: { code: 429, message: 'Rate limit exceeded upstream' } });
  assert.equal(((await imagegen.generateImageAsset({ prompt: 'a horse' }, CTX)) as { reason: string }).reason, 'rate-limited');
});

test('a 200 with text and no picture is a REFUSAL with the model\'s words, metered as a failure', async () => {
  answer = () =>
    Response.json({
      choices: [{ finish_reason: 'stop', message: { content: "I can't create images of identifiable real people." } }],
      usage: { prompt_tokens: 12, completion_tokens: 20, cost: 0.001 },
    });
  const out = await imagegen.generateImageAsset({ prompt: 'jockey Joe Bloggs on his horse' }, CTX);
  assert.equal(out.ok, false);
  assert.equal((out as { reason: string }).reason, 'refused');
  assert.match((out as { message: string }).message, /declined.*identifiable real people.*do not retry/);
  assert.equal(usage[0]!.ok, false, 'a refusal is not counted as a success');
  assert.match(usage[0]!.error!, /^no image: stop — I can't create images/);
});

test('a timeout is typed AND metered (it used to skip AI Activity)', async () => {
  answer = () => {
    const e = new Error('The operation was aborted due to timeout');
    e.name = 'TimeoutError';
    throw e;
  };
  const out = await imagegen.generateImageAsset({ prompt: 'a horse' }, CTX);
  assert.equal((out as { reason: string }).reason, 'timeout');
  assert.match((out as { message: string }).message, /timed out/);
  assert.deepEqual(usage.map((u) => [u.ok, u.error]), [[false, 'timeout after 60s']]);
});

test('a 400 still retries ONCE without image_config, as before', async () => {
  answer = (_body, call) => (call === 1 ? new Response('image_config not supported', { status: 400 }) : imageReply());
  const out = await imagegen.generateImageAsset({ prompt: 'a horse', orientation: 'portrait' }, CTX);
  assert.ok(out.ok);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0]!.image_config, { aspect_ratio: '2:3' });
  assert.equal(requests[1]!.image_config, undefined);
});

test('a moderation 403 is a refusal', async () => {
  answer = () => Response.json({ error: { code: 403, message: 'Input was flagged by moderation' } }, { status: 403 });
  const out = await imagegen.generateImageAsset({ prompt: 'a horse' }, CTX);
  assert.equal((out as { reason: string }).reason, 'refused');
  assert.match((out as { message: string }).message, /flagged by moderation/);
});

test('generateAndStoreImage keeps its old shape: the reference, or null', async () => {
  answer = () => imageReply();
  const ok = await imagegen.generateAndStoreImage({ prompt: 'a horse', orientation: 'landscape', style: 'natural light, film tones' }, CTX);
  assert.deepEqual(Object.keys(ok ?? {}).sort(), ['alt', 'assetId', 'url']);
  // The legacy free-text style is still the photographic look.
  assert.match(prompt(requests[0]!), /Photographic style: natural light, film tones\./);
  answer = () => new Response('nope', { status: 503 });
  assert.equal(await imagegen.generateAndStoreImage({ prompt: 'a horse', orientation: 'landscape' }, CTX), null);
});
