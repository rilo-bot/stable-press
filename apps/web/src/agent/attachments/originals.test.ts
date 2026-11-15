// Run: npx tsx --test src/agent/attachments/originals.test.ts   (from apps/web)
// The user's original image is what gets placed, not the reduced JPEG the model
// reads — so a transparent PNG keeps its alpha and its size (finding C41).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ORIGINALS, ORIGINAL_MAX_BYTES, attachmentKey, forgetOriginals, originalFor, rememberOriginal } from './originals';

const png = (name = 'logo.png', bytes = 16) => new File([new Uint8Array(bytes)], name, { type: 'image/png' });
const dataUrl = (tail: string) => `data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD${tail}`;

beforeEach(() => forgetOriginals());

test('the original behind a sent data URL is handed back', () => {
  const file = png();
  const url = dataUrl('AAAA1111');
  rememberOriginal(url, file);
  assert.equal(originalFor(url), file);
  assert.equal(originalFor(url)!.type, 'image/png');
});

test('an unknown data URL (a thread restored after a reload) has no original', () => {
  assert.equal(originalFor(dataUrl('nothing-here')), undefined);
  assert.equal(originalFor(undefined), undefined);
  assert.equal(originalFor(''), undefined);
});

test('only placeable image types are kept', () => {
  const avif = new File([new Uint8Array(8)], 'a.avif', { type: 'image/avif' });
  const pdf = new File([new Uint8Array(8)], 'a.pdf', { type: 'application/pdf' });
  rememberOriginal(dataUrl('avif'), avif);
  rememberOriginal(dataUrl('pdf'), pdf);
  assert.equal(originalFor(dataUrl('avif')), undefined);
  assert.equal(originalFor(dataUrl('pdf')), undefined);
  for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
    const f = new File([new Uint8Array(8)], 'x', { type });
    rememberOriginal(dataUrl(type), f);
    assert.equal(originalFor(dataUrl(type)), f, type);
  }
});

test('an original over the library cap is not handed out', () => {
  const big = { type: 'image/png', size: ORIGINAL_MAX_BYTES + 1, name: 'huge.png' } as unknown as File;
  rememberOriginal(dataUrl('big'), big);
  assert.equal(originalFor(dataUrl('big')), undefined);
});

test('bounded: the oldest original is forgotten first', () => {
  for (let i = 0; i <= MAX_ORIGINALS; i++) rememberOriginal(dataUrl(`n${i}`), png(`f${i}.png`));
  assert.equal(originalFor(dataUrl('n0')), undefined);
  assert.equal(originalFor(dataUrl(`n${MAX_ORIGINALS}`))!.name, `f${MAX_ORIGINALS}.png`);
});

test('the key is the length plus the tail, not the whole URL', () => {
  const url = dataUrl('x'.repeat(200));
  assert.equal(attachmentKey(url), `${url.length}:${url.slice(-64)}`);
  assert.notEqual(attachmentKey(dataUrl('aa')), attachmentKey(dataUrl('ab')));
});
