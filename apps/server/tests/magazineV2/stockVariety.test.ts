// ---------------------------------------------------------------------------
// "Find another photo" (audit C46): a repeat stock request gets the NEXT result the
// magazine does not hold yet, from the same single search request; when every result
// is already held, the existing library row is reused rather than a second copy stored.
//
// Mocks only, as in photoSourcing.test.ts: `fetch` answers the Pexels API and CDN and
// THROWS on anything else; storage is patched in memory. No DB, no S3, no model.
// ---------------------------------------------------------------------------

import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

// Read at import time by lib/stock.ts / storage.ts / photoDirector.ts — set first.
process.env.PEXELS_API_KEY = 'test-pexels-key';
process.env.STOCK_PROVIDER = 'pexels';
process.env.MAGAZINE_V2_PHOTO_DIRECTOR = '0';
for (const k of ['S3_BUCKET', 'S3_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'S3_ENDPOINT', 'S3_PUBLIC_BASE_URL']) delete process.env[k];

type StockMod = typeof import('../../src/lib/stock.js');
type VarietyMod = typeof import('../../src/lib/magazineV2/stockVariety.js');
let stock: StockMod;
let variety: VarietyMod;

const realFetch = globalThis.fetch;
let calls: string[] = [];
const uploads: string[] = [];

function pexelsPhoto(id: number) {
  return {
    id,
    url: `https://www.pexels.com/photo/horse-${id}/`,
    alt: `Horse photo ${id}`,
    photographer: `Photographer ${id}`,
    photographer_url: `https://www.pexels.com/@p${id}`,
    src: { medium: `https://images.pexels.com/photos/${id}/m.jpeg`, large2x: `https://images.pexels.com/photos/${id}/l2x.jpeg` },
  };
}
const IDS = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112];

const fakeFetch = (async (input: string | URL | Request) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  calls.push(url.href);
  if (url.hostname === 'api.pexels.com') {
    if (url.pathname.startsWith('/v1/photos/')) return Response.json(pexelsPhoto(Number(url.pathname.split('/').pop())));
    return Response.json({ photos: IDS.map(pexelsPhoto) });
  }
  if (url.hostname === 'images.pexels.com') {
    return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  }
  throw new Error(`test: unexpected network request to ${url.href}`);
}) as typeof fetch;

before(async () => {
  globalThis.fetch = fakeFetch;
  stock = await import('../../src/lib/stock.js');
  variety = await import('../../src/lib/magazineV2/stockVariety.js');
  const storage = (await import('../../src/lib/storage.js')).storage;
  storage.isConfigured = () => true;
  storage.uploadObject = (async (o: { key: string }) => {
    uploads.push(o.key);
  }) as typeof storage.uploadObject;
  storage.publicUrl = (key: string) => `https://cdn.test/${key}`;
});

after(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  stock.resetStockSearchState();
  calls = [];
  uploads.length = 0;
});

const searches = () => calls.filter((u) => u.startsWith('https://api.pexels.com/v1/search')).length;

// ── the pure choice ──────────────────────────────────────────────────────────

const cand = (id: number) => ({ id: String(id), alt: `Horse photo ${id}`, thumbUrl: '', attribution: { author: '', url: `https://www.pexels.com/@p${id}` } });

test('pickUnusedCandidate: the first not yet used; allUsed only when every one is', () => {
  const list = [cand(1), cand(2), cand(3)];
  assert.equal(stock.pickUnusedCandidate(list, (c) => c.id === '1').pick?.id, '2');
  assert.deepEqual(stock.pickUnusedCandidate(list, () => true), { pick: null, allUsed: true });
  assert.deepEqual(stock.pickUnusedCandidate([], () => false), { pick: null, allUsed: false });
});

test('chooseStock: fresh first; else reuse the existing row; old rows matched by fingerprint', () => {
  const rows = [
    { _id: 'm1', source: 'stock', stockId: '1', url: 'https://cdn.test/1.jpg', alt: 'Horse photo 1' },
    // Older row, no stockId: photographer URL + alt.
    { _id: 'm2', source: 'stock', url: 'https://cdn.test/2.jpg', alt: 'Horse photo 2', attribution: { url: 'https://www.pexels.com/@p2' } },
    { _id: 'm3', source: 'upload', stockId: '3', url: 'https://cdn.test/3.jpg' }, // not stock — ignored
  ];
  const fresh = variety.chooseStock([cand(1), cand(2), cand(3)], rows);
  assert.equal(fresh.kind, 'fresh');
  assert.equal((fresh as { candidate: { id: string } }).candidate.id, '3');

  const reuse = variety.chooseStock([cand(1), cand(2)], rows);
  assert.equal(reuse.kind, 'reuse');
  assert.equal((reuse as { row: { _id: string } }).row._id, 'm1');

  assert.equal(variety.chooseStock([], rows).kind, 'none');
  assert.equal(variety.stockRowFor(rows, cand(2))?._id, 'm2');
  assert.equal(variety.stockRowFor(rows, cand(3)), null);
});

// ── the shared sourcing path ────────────────────────────────────────────────

test('without skip: the top hit, exactly as before', async () => {
  const stored = await stock.findAndStoreStockPhoto({ query: 'grey horse' }, 'public/magazinesV2/mag-1');
  assert.equal(stored?.providerId, '101');
  assert.equal(searches(), 1);
});

test('with skip: the NEXT unused result, from the same single search request', async () => {
  const held = new Set(['101', '102']);
  const stored = await stock.findAndStoreStockPhoto({ query: 'grey horse', skip: (c) => held.has(c.id) }, 'public/magazinesV2/mag-1');
  assert.equal(stored?.providerId, '103');
  assert.equal(searches(), 1);
  assert.equal(uploads.length, 1);
  // "Find another" again: still no second search (the cache), and a different photo.
  held.add('103');
  const again = await stock.findAndStoreStockPhoto({ query: 'grey horse', skip: (c) => held.has(c.id) }, 'public/magazinesV2/mag-1');
  assert.equal(again?.providerId, '104');
  assert.equal(searches(), 1);
});

test('with skip and every result held: nothing is downloaded or stored', async () => {
  const stored = await stock.findAndStoreStockPhoto({ query: 'grey horse', skip: () => true }, 'public/magazinesV2/mag-1');
  assert.equal(stored, null);
  assert.equal(uploads.length, 0);
  assert.equal(calls.filter((u) => u.includes('images.pexels.com')).length, 0);
});
