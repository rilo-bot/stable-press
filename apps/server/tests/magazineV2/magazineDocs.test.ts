// ---------------------------------------------------------------------------
// magazineDocs.ts — reading a magazine's documents back on a later turn (C12/C27),
// and the size check before a PDF's layout is read in the API process (C34).
//
// Offline: db.collection and storage are patched; the MONGODB_URI below is never used
// (db.ts connects lazily); fetch throws if anything tries the network.
// ---------------------------------------------------------------------------

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGODB_URI = 'mongodb://db.invalid:27017/never-connected';

type DocsMod = typeof import('../../src/lib/magazineV2/magazineDocs.js');
let docs: DocsMod;

const MEDIA: Record<string, Record<string, unknown>> = {
  results: {
    _id: 'results',
    magazineId: 'mag-1',
    kind: 'doc',
    key: 'public/magazinesV2/mag-1/media/results.pdf',
    originalName: 'Results.pdf',
    contentType: 'application/pdf',
    sourceText: 'Cup Day results. Race 1 was won by Bold Venture. Race 2 was won by Silver Fern in 1:58.2.',
  },
  scan: { _id: 'scan', magazineId: 'mag-1', kind: 'doc', key: 'k/scan.pdf', originalName: 'Scan.pdf', contentType: 'application/pdf', sourceText: '' },
  theirs: { _id: 'theirs', magazineId: 'mag-2', kind: 'doc', key: 'k/theirs.pdf', originalName: 'Theirs.pdf', contentType: 'application/pdf', sourceText: 'secret' },
  photo: { _id: 'photo', magazineId: 'mag-1', kind: 'photo', key: 'k/p.jpg', url: 'https://x/p.jpg' },
  // A scanned PDF attached in the chat, registered for a page-by-page read still under way.
  scanLinked: { _id: 'scanLinked', magazineId: 'mag-1', kind: 'doc', key: 'k/scan2.pdf', originalName: 'Scan2.pdf', contentType: 'application/pdf', sourceText: '', sourceDocId: 'counted' },
  notes: { _id: 'notes', magazineId: 'mag-1', kind: 'doc', key: 'k/notes.docx', originalName: 'Notes.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sourceText: 'Meeting notes.' },
};
const SOURCES: Record<string, Record<string, unknown>> = {
  reading: { _id: 'reading', magazineId: 'mag-1', originalName: 'Annual.pdf', s3Key: 'k/annual.pdf', contentType: 'application/pdf', status: 'reading', deletedAt: null },
  broken: { _id: 'broken', magazineId: 'mag-1', originalName: 'Broken.pdf', s3Key: 'k/broken.pdf', contentType: 'application/pdf', status: 'failed', error: 'not a PDF', deletedAt: null },
  counted: { _id: 'counted', magazineId: 'mag-1', originalName: 'Scan2.pdf', s3Key: 'k/scan2.pdf', contentType: 'application/pdf', status: 'reading', coverage: { pagesTotal: 12 }, deletedAt: null },
};
const JOBS: Record<string, unknown>[] = [];
let inserted = 0;
const SIZES: Record<string, number> = {
  'public/magazinesV2/mag-1/media/results.pdf': 2 * 1024 * 1024,
  'k/huge.pdf': 150 * 1024 * 1024,
};
const downloads: string[] = [];
const realFetch = globalThis.fetch;

before(async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    throw new Error(`test: unexpected network request to ${String(input)}`);
  }) as typeof fetch;
  const { db } = await import('../../src/lib/db.js');
  const { COL } = await import('../../src/lib/magazineV2/collections.js');
  (db as { collection: unknown }).collection = (name: string) => ({
    findById: async (id: string) => (name === COL.media ? MEDIA[id] : name === COL.sourceDocs ? SOURCES[id] : undefined) ?? null,
    insertOne: async (doc: Record<string, unknown>) => {
      const id = `new-${++inserted}`;
      if (name === COL.sourceDocs) SOURCES[id] = { _id: id, ...doc };
      else if (name === COL.jobs) JOBS.push(doc);
      return id;
    },
    updateOne: async (id: string, patch: Record<string, unknown>) => {
      const target = name === COL.media ? MEDIA[id] : name === COL.sourceDocs ? SOURCES[id] : undefined;
      if (!target) return false;
      Object.assign(target, patch);
      return true;
    },
  });
  const { storage } = await import('../../src/lib/storage.js');
  storage.headObject = (async (key: string) => {
    if (!(key in SIZES)) throw new Error('missing');
    return { contentLength: SIZES[key]!, contentType: 'application/pdf' };
  }) as typeof storage.headObject;
  storage.downloadObject = (async (key: string) => {
    downloads.push(key);
    return Buffer.from('%PDF-1.7');
  }) as typeof storage.downloadObject;
  docs = await import('../../src/lib/magazineV2/magazineDocs.js');
});

after(() => {
  globalThis.fetch = realFetch;
});

test('a chat-attached document is read back, wrapped as untrusted DATA and ranked by the query', async () => {
  const out = await docs.readMagazineDocument('mag-1', 'results', { query: 'who won race 2' });
  assert.equal(out.ok, true);
  const ok = out as Extract<typeof out, { ok: true }>;
  assert.equal(ok.name, 'Results.pdf');
  assert.equal(ok.store, 'media');
  assert.match(ok.block, /Silver Fern/);
  assert.match(ok.block, /UNTRUSTED DATA/, 'the guard travels with the text every time');
});

test('the magazine is the allow-list: another magazine\'s document, or a photo, is not readable', async () => {
  const theirs = await docs.readMagazineDocument('mag-1', 'theirs');
  assert.equal(theirs.ok, false);
  assert.match((theirs as { error: string }).error, /not in this magazine.*list_documents/);
  assert.equal((await docs.readMagazineDocument('mag-1', 'photo')).ok, false);
  assert.equal(await docs.mediaDocumentText('mag-1', 'theirs'), '');
  assert.equal(await docs.mediaDocumentText('mag-2', 'theirs'), 'secret');
});

test('every refusal is a sentence the model can act on', async () => {
  const scan = await docs.readMagazineDocument('mag-1', 'scan');
  assert.match((scan as { error: string }).error, /no readable text stored.*scan/);
  const reading = await docs.readMagazineDocument('mag-1', 'reading');
  assert.match((reading as { error: string }).error, /still being read/);
  const broken = await docs.readMagazineDocument('mag-1', 'broken');
  assert.match((broken as { error: string }).error, /could not be read \(not a PDF\)/);
});

test('magazineDocument says which store a document lives in', async () => {
  assert.equal((await docs.magazineDocument('mag-1', 'results'))!.store, 'media');
  assert.equal((await docs.magazineDocument('mag-1', 'reading'))!.store, 'source');
});

test('a PDF is size-checked BEFORE it is downloaded into the API (C34)', async () => {
  const doc = (await docs.magazineDocument('mag-1', 'results'))!;
  const small = await docs.fetchLayoutPdf(doc);
  assert.equal(small.ok, true);
  assert.deepEqual(downloads, [doc.s3Key]);

  const huge = await docs.fetchLayoutPdf({ ...doc, s3Key: 'k/huge.pdf' });
  assert.equal(huge.ok, false);
  assert.equal((huge as { status: number }).status, 413);
  assert.match((huge as { error: string }).error, /too large to measure here/);
  assert.deepEqual(downloads, [doc.s3Key], 'the huge file was never downloaded');

  const gone = await docs.fetchLayoutPdf({ ...doc, s3Key: 'k/missing.pdf' });
  assert.equal((gone as { status: number }).status, 502);
});

// ── A document attached in the chat is one of the magazine's READABLE documents ──
//
// 2026-11-15: "Please just store it for this magazine" was answered "I can't store or
// attach files myself" about a PDF that was already stored. The route now registers
// every attachment and the assistant confirms it; a PDF is also queued for a
// page-by-page read over the SAME stored file, so a scan gets read and "page 3 of the
// PDF" means something on a later turn.

test('an attached PDF is registered once as a source document over the same file, and queued for its read', async () => {
  const first = await docs.registerAttachedDocument('mag-1', 'results', 'user-1');
  assert.equal(first.readable, true, 'the browser’s text already reads');
  assert.equal(first.reading, true);
  const source = SOURCES[first.sourceDocId!]!;
  assert.equal(source.s3Key, 'public/magazinesV2/mag-1/media/results.pdf', 'no copy: the same stored object');
  assert.equal(source.magazineId, 'mag-1');
  assert.equal(source.ownerId, 'user-1');
  assert.equal(source.status, 'queued');
  assert.equal(MEDIA.results!.sourceDocId, first.sourceDocId);
  assert.deepEqual(JOBS.map((j) => [j.type, (j.payload as { docId: string }).docId]), [['readSourceDoc', first.sourceDocId]]);

  const again = await docs.registerAttachedDocument('mag-1', 'results', 'user-1');
  assert.equal(again.sourceDocId, first.sourceDocId);
  assert.equal(JOBS.length, 1, 'registering twice reads once');
  // The chat's own docId still reads the browser text while the page read runs.
  const read = await docs.readMagazineDocument('mag-1', 'results', { query: 'race 2' });
  assert.equal(read.ok, true);
});

test('a Word file is readable through its stored text; another magazine’s file is not touched', async () => {
  const jobs = JOBS.length;
  assert.deepEqual(await docs.registerAttachedDocument('mag-1', 'notes', 'user-1'), { readable: true, reading: false });
  assert.deepEqual(await docs.registerAttachedDocument('mag-1', 'theirs', 'user-1'), { readable: false, reading: false });
  assert.equal(MEDIA.theirs!.sourceDocId, undefined);
  assert.equal(JOBS.length, jobs);
  // A source document of this magazine reports its own read.
  assert.deepEqual(await docs.registerAttachedDocument('mag-1', 'reading', 'user-1'), { readable: false, reading: true, sourceDocId: 'reading' });
});

test('a registered scan says it is being read — and knows its page count once counted', async () => {
  const r = await docs.readMagazineDocument('mag-1', 'scanLinked');
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /saved and its pages are still being read/);
  assert.equal((await docs.magazineDocument('mag-1', 'scanLinked'))!.pages, 12);
  assert.equal((await docs.magazineDocument('mag-1', 'scan'))!.pages, 0, 'unregistered: unknown, as before');
});
