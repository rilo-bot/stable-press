// The Overview brief is written once and reused while nothing it describes changed.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { BRIEF_TTL_MS, BriefCache, briefFingerprint, nzDay } from '../src/lib/newsroomBriefCache.js'

const summary = (draft: number) => ({
  generatedFor: { name: 'Vatsal', roles: ['administrator'] },
  stories: { total: 12, mine: 3, live: 5, byStatus: { draft, review: 2 } },
  needsAttention: [{ id: 'review', label: 'Stories waiting for review', count: 2, where: 'workflow' }],
})

// 10:00 on 16 Nov 2026 in New Zealand (NZDT, UTC+13) = 21:00 on 15 Nov UTC.
const T0 = Date.parse('2026-11-15T21:00:00Z')

test('the same numbers fingerprint the same, whatever the key order', () => {
  const a = briefFingerprint(summary(4))
  const reordered = { needsAttention: summary(4).needsAttention, stories: { byStatus: { review: 2, draft: 4 }, live: 5, mine: 3, total: 12 }, generatedFor: summary(4).generatedFor }
  assert.equal(briefFingerprint(reordered), a)
  assert.notEqual(briefFingerprint(summary(5)), a)
})

test('a visit with unchanged numbers reuses the brief — no new AI call', () => {
  let now = T0
  const cache = new BriefCache(() => now)
  cache.set('u1', briefFingerprint(summary(4)), 'Morning Vatsal — two stories wait for review.')
  now += 45 * 60_000
  assert.equal(cache.get('u1', briefFingerprint(summary(4))), 'Morning Vatsal — two stories wait for review.')
})

test('a changed number means a new brief', () => {
  const cache = new BriefCache(() => T0)
  cache.set('u1', briefFingerprint(summary(4)), 'old')
  assert.equal(cache.get('u1', briefFingerprint(summary(5))), null)
})

test('a brief is kept at most 6 hours, and never into the next New Zealand day', () => {
  let now = T0
  const cache = new BriefCache(() => now)
  const fp = briefFingerprint(summary(4))
  cache.set('u1', fp, 'old')
  now = T0 + BRIEF_TTL_MS + 1
  assert.equal(cache.get('u1', fp), null)

  // 23:30 NZ, then 00:10 NZ the next day — 40 minutes apart, different day.
  now = Date.parse('2026-11-16T10:30:00Z')
  cache.set('u1', fp, 'late')
  assert.equal(nzDay(now), '2026-11-16')
  now = Date.parse('2026-11-16T11:10:00Z')
  assert.equal(nzDay(now), '2026-11-17')
  assert.equal(cache.get('u1', fp), null)
})

test('briefs are kept per reader', () => {
  const cache = new BriefCache(() => T0)
  const fp = briefFingerprint(summary(4))
  cache.set('u1', fp, 'for u1')
  assert.equal(cache.get('u2', fp), null)
})

test('the cache is bounded — the oldest reader is dropped first', () => {
  const cache = new BriefCache(() => T0, BRIEF_TTL_MS, 2)
  cache.set('a', 'f', '1')
  cache.set('b', 'f', '2')
  cache.set('c', 'f', '3')
  assert.equal(cache.size, 2)
  assert.equal(cache.get('a', 'f'), null)
  assert.equal(cache.get('c', 'f'), '3')
})

test('requests that arrive together share ONE write (two tabs, a double-click, a page asking twice)', async () => {
  const cache = new BriefCache(() => T0)
  const fp = briefFingerprint(summary(4))
  let writes = 0
  let finish!: (s: string) => void
  const write = () => {
    writes++
    return new Promise<string>((r) => (finish = r))
  }
  const a = cache.getOrWrite('u1', fp, write)
  const b = cache.getOrWrite('u1', fp, write)
  const c = cache.getOrWrite('u1', fp, write, true) // Regenerate while it is being written
  finish('  Morning Vatsal.  ')
  assert.deepEqual(await Promise.all([a, b, c]), [
    { brief: 'Morning Vatsal.', cached: false },
    { brief: 'Morning Vatsal.', cached: false },
    { brief: 'Morning Vatsal.', cached: false },
  ])
  assert.equal(writes, 1)
  // ...and the next visit is served from the cache, with no write at all.
  assert.deepEqual(await cache.getOrWrite('u1', fp, write), { brief: 'Morning Vatsal.', cached: true })
  assert.equal(writes, 1)
  // Regenerate (refresh) asks for a new one.
  const r = cache.getOrWrite('u1', fp, write, true)
  finish('A fresh one.')
  assert.deepEqual(await r, { brief: 'A fresh one.', cached: false })
  assert.equal(writes, 2)
})

test('a failed write is not kept — the next visit tries again', async () => {
  const cache = new BriefCache(() => T0)
  const fp = briefFingerprint(summary(4))
  await assert.rejects(cache.getOrWrite('u1', fp, async () => { throw new Error('model down') }))
  assert.deepEqual(await cache.getOrWrite('u1', fp, async () => 'Back up.'), { brief: 'Back up.', cached: false })
})
