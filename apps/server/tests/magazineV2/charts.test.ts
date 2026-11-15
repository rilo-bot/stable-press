// ---------------------------------------------------------------------------
// charts.ts, the paths that never reach the renderer: a bad spec, no storage and a
// too-small box are refused in plain words before anything is drawn or stored; and
// loadChartAsset only ever hands back a chart spec that belongs to THIS magazine.
// (The draw-and-store path needs headless Chromium and Google Fonts, so it is covered
// by chartSvg.test.ts for the drawing and renderPreview.test.ts for the raster.)
//
// Offline: db.collection and storage are patched; the MONGODB_URI below is never used
// (db.ts connects lazily); fetch throws if anything tries the network.
// ---------------------------------------------------------------------------

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGODB_URI = 'mongodb://db.invalid:27017/never-connected';
for (const k of ['S3_BUCKET', 'S3_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'S3_ENDPOINT', 'S3_PUBLIC_BASE_URL']) delete process.env[k];

type ChartsMod = typeof import('../../src/lib/magazineV2/charts.js');
type ThemeMod = typeof import('../../src/lib/magazineV2/chartTheme.js');
let charts: ChartsMod;
let theme: ReturnType<ThemeMod['chartTheme']>;
let storageConfigured = true;
const uploads: string[] = [];

const realFetch = globalThis.fetch;
const ROWS: Record<string, Record<string, unknown>> = {
  chart1: {
    _id: 'chart1',
    magazineId: 'mag-1',
    source: 'chart',
    url: 'https://cdn.test/c1.png',
    chart: { type: 'bar', categories: ['2023', '2024'], series: [{ name: 'Wins', values: [4, 7] }] },
    chartBox: { w: 800, h: 500 },
  },
  photo1: { _id: 'photo1', magazineId: 'mag-1', source: 'stock', url: 'https://cdn.test/p1.jpg' },
  other: { _id: 'other', magazineId: 'mag-2', source: 'chart', url: 'https://cdn.test/o.png', chart: { type: 'bar', categories: ['a'], series: [{ name: 'x', values: [1] }] } },
  broken: { _id: 'broken', magazineId: 'mag-1', source: 'chart', url: 'https://cdn.test/b.png', chart: { type: 'pie', categories: ['a'], series: [{ name: 'x', values: [-1] }] } },
};

before(async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    throw new Error(`test: unexpected network request to ${String(input)}`);
  }) as typeof fetch;
  const { storage } = await import('../../src/lib/storage.js');
  storage.isConfigured = () => storageConfigured;
  storage.uploadObject = (async (o: { key: string }) => {
    uploads.push(o.key);
  }) as typeof storage.uploadObject;
  const { db } = await import('../../src/lib/db.js');
  (db as { collection: unknown }).collection = () => ({
    findById: async (id: string) => ROWS[id] ?? null,
    insertOne: async () => {
      throw new Error('test: nothing should be stored');
    },
  });
  charts = await import('../../src/lib/magazineV2/charts.js');
  theme = (await import('../../src/lib/magazineV2/chartTheme.js')).chartTheme(null, []);
});

after(() => {
  globalThis.fetch = realFetch;
});

const SPEC = { type: 'bar' as const, categories: ['2023', '2024'], series: [{ name: 'Wins', values: [4, 7] }] };

test('a spec that fails validation is refused with the validator\'s words, nothing stored', async () => {
  const out = await charts.renderAndStoreChart({ ...SPEC, series: [{ name: 'Wins', values: [4] }] }, theme, { w: 800, h: 500 }, { magazineId: 'mag-1' });
  assert.equal(out.ok, false);
  assert.match((out as { error: string }).error, /"Wins" has 1 value but there are 2 categories/);
  assert.equal(uploads.length, 0);
});

test('no storage, or a box too small to read, is said plainly — never an image-model fallback', async () => {
  storageConfigured = false;
  const noStore = await charts.renderAndStoreChart(SPEC, theme, { w: 800, h: 500 }, { magazineId: 'mag-1' });
  assert.match((noStore as { error: string }).error, /storage is not set up/);
  storageConfigured = true;
  const tiny = await charts.renderAndStoreChart(SPEC, theme, { w: 50, h: 30 }, { magazineId: 'mag-1' });
  assert.match((tiny as { error: string }).error, /too small/);
  assert.equal(uploads.length, 0);
});

test('loadChartAsset: this magazine\'s chart only, re-validated', async () => {
  const got = await charts.loadChartAsset('chart1', 'mag-1');
  assert.ok(got);
  assert.deepEqual(got.spec.series[0]!.values, [4, 7]);
  assert.deepEqual(got.box, { w: 800, h: 500 });
  assert.equal(await charts.loadChartAsset('other', 'mag-1'), null, 'another magazine\'s chart is not readable');
  assert.equal(await charts.loadChartAsset('photo1', 'mag-1'), null, 'a photo is not a chart');
  assert.equal(await charts.loadChartAsset('broken', 'mag-1'), null, 'a hand-broken spec does not crash a redraw');
  assert.equal(await charts.loadChartAsset('', 'mag-1'), null);
  assert.equal(await charts.loadChartAsset('missing', 'mag-1'), null);
});
