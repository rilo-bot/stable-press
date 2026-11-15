// Run (from apps/web): npx tsx --test src/editor-v2/pdfChoices.test.ts
// The PDFs a magazine holds, one entry per file (pdfChoices.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choiceFor, pdfChoices } from './pdfChoices';

const PDF = 'application/pdf';

test('a PDF attached in the Design Helper (upload + its registered source) is listed once', () => {
  const sources = [{ id: 's1', originalName: 'NZTROF Owners Experience.pdf', contentType: PDF, size: 4_200_000, pagesTotal: 16 }];
  const uploads = [{ id: 'u1', originalName: 'NZTROF Owners Experience.pdf', contentType: PDF, size: 4_200_000 }];
  const list = pdfChoices(sources, uploads);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], { docId: 's1', name: 'NZTROF Owners Experience.pdf', pages: 16, aliases: ['u1'] });
  // The operator saved the upload and looks for ITS id: it still finds the entry.
  assert.equal(choiceFor(list, 'u1')?.docId, 's1');
  assert.equal(choiceFor(list, 's1')?.docId, 's1');
  assert.equal(choiceFor(list, 'nope'), undefined);
});

test('the server’s link wins over name and size', () => {
  const sources = [
    { id: 's1', originalName: 'Brochure.pdf', contentType: PDF, size: 100 },
    { id: 's2', originalName: 'Results.pdf', contentType: PDF, size: 200 },
  ];
  const uploads = [{ id: 'u1', originalName: 'renamed.pdf', contentType: PDF, size: 999, sourceDocId: 's2' }];
  const list = pdfChoices(sources, uploads);
  assert.deepEqual(list.map((c) => [c.docId, c.aliases]), [['s1', []], ['s2', ['u1']]]);
});

test('different files stay apart; an unknown size never merges; non-PDFs are left out', () => {
  const sources = [{ id: 's1', originalName: 'Brochure.pdf', contentType: PDF, size: 100 }];
  const uploads = [
    { id: 'u1', originalName: 'Brochure.pdf', contentType: PDF, size: 101 },
    { id: 'u2', originalName: 'Brochure.pdf', contentType: PDF },
    { id: 'u3', originalName: 'Notes.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 100 },
    // A link to a source that is gone: the upload stands on its own.
    { id: 'u4', originalName: 'Old.pdf', contentType: PDF, size: 5, sourceDocId: 'deleted' },
  ];
  const list = pdfChoices(sources, uploads);
  assert.deepEqual(list.map((c) => c.docId), ['s1', 'u1', 'u2', 'u4']);
  assert.equal(list.find((c) => c.docId === 'u1')!.pages, 0, 'an upload has no page count');
});

test('the same file uploaded twice is one entry, the newest upload kept', () => {
  const uploads = [
    { id: 'new', originalName: 'Report.pdf', contentType: PDF, size: 300 },
    { id: 'old', originalName: 'report.pdf', contentType: PDF, size: 300 },
  ];
  const list = pdfChoices([], uploads);
  assert.deepEqual(list, [{ docId: 'new', name: 'Report.pdf', pages: 0, aliases: ['old'] }]);
});
