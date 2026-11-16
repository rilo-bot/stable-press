// Sortd embed sessions — lib/sortd.ts.
//
// Offline: every Sortd call goes through an injected fetch that records the
// request and answers from a script. What matters here:
//   • the API key only ever travels in the Authorization header to Sortd;
//   • a ticket is reused / refreshed ONLY for the account + identity it was
//     minted for, and anything forged or foreign mints a fresh session instead;
//   • revoke works from the ticket alone and ignores forged or expired ones.
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  REFRESH_WINDOW_MS,
  SortdError,
  ensureSortdSession,
  revokeSortdSession,
  sortdConfig,
  sortdIdentityFor,
  type SortdDeps,
  type SortdIdentity,
} from '../src/lib/sortd.js'

const BASE = 'https://support.example.test'
const KEY = 'sk_app_test_key_do_not_log'
const T0 = Date.parse('2026-11-16T00:00:00Z')
const DAY = 24 * 60 * 60_000

interface Call { method: string; url: string; auth: string | null; body: unknown }

/** deps whose fetch answers from `respond` and records every call. */
function harness(respond: (call: Call) => { status?: number; json?: unknown }, now = T0) {
  const calls: Call[] = []
  const clock = { now }
  const deps: SortdDeps = {
    config: { baseUrl: BASE, apiKey: KEY },
    now: () => clock.now,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      const call: Call = {
        method: init?.method ?? 'GET',
        url: String(input),
        auth: headers.get('authorization'),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      }
      calls.push(call)
      const { status = 200, json } = respond(call)
      return new Response(json === undefined ? '' : JSON.stringify(json), { status })
    }) as typeof fetch,
  }
  return { deps, calls, clock }
}

const sessionAt = (id: string, exp: number) => ({ sessionId: id, expiresAt: new Date(exp).toISOString() })

const JANE: SortdIdentity = { externalUserId: 'u1', email: 'jane@example.com', name: 'Jane', role: 'user' }

async function mintFor(identity: SortdIdentity, id = 'ess_1') {
  const h = harness(() => ({ status: 201, json: sessionAt(id, T0 + DAY) }))
  return { ...(await ensureSortdSession(identity, undefined, h.deps)), calls: h.calls }
}

// ── config + identity ──

const savedEnv = { url: process.env.SORTD_BASE_URL, key: process.env.SORTD_API_KEY }
afterEach(() => {
  process.env.SORTD_BASE_URL = savedEnv.url
  process.env.SORTD_API_KEY = savedEnv.key
  if (savedEnv.url === undefined) delete process.env.SORTD_BASE_URL
  if (savedEnv.key === undefined) delete process.env.SORTD_API_KEY
})

test('config: null unless both values are set and the URL is http(s); normalised to the origin', () => {
  delete process.env.SORTD_BASE_URL
  process.env.SORTD_API_KEY = KEY
  assert.equal(sortdConfig(), null)
  process.env.SORTD_BASE_URL = 'ftp://support.example.test'
  assert.equal(sortdConfig(), null)
  process.env.SORTD_BASE_URL = 'not a url'
  assert.equal(sortdConfig(), null)
  process.env.SORTD_BASE_URL = ' https://support.example.test/ '
  assert.deepEqual(sortdConfig(), { baseUrl: BASE, apiKey: KEY })
  delete process.env.SORTD_API_KEY
  assert.equal(sortdConfig(), null)
})

test('identity: superadmin is owner, everyone else (staff included) is user; no email → none', () => {
  const base = { id: 'u1', email: 'jane@example.com', name: ' Jane ' }
  assert.deepEqual(sortdIdentityFor({ ...base, isSuperAdmin: false }), {
    externalUserId: 'u1', email: 'jane@example.com', name: 'Jane', role: 'user',
  })
  assert.equal(sortdIdentityFor({ ...base, isSuperAdmin: true })?.role, 'owner')
  assert.equal(sortdIdentityFor({ ...base, name: '', isSuperAdmin: false })?.name, undefined)
  assert.equal(sortdIdentityFor({ ...base, email: '  ', isSuperAdmin: false }), null)
})

// ── mint ──

test('mints with the key in the Authorization header only, and returns a ticket', async () => {
  const s = await mintFor(JANE)
  assert.equal(s.sessionId, 'ess_1')
  assert.equal(s.expiresAt, new Date(T0 + DAY).toISOString())
  assert.ok(s.ticket.includes('.'))
  assert.equal(s.calls.length, 1)
  const [call] = s.calls
  assert.equal(call.method, 'POST')
  assert.equal(call.url, `${BASE}/api/embed/sessions`)
  assert.equal(call.auth, `Bearer ${KEY}`)
  assert.deepEqual(call.body, { externalUserId: 'u1', email: 'jane@example.com', name: 'Jane', role: 'user' })
  // The ticket goes to the browser, so it must not carry the key.
  assert.equal(s.ticket.includes(KEY), false)
  assert.equal(Buffer.from(s.ticket.split('.')[0], 'base64url').toString().includes(KEY), false)
})

test('a Sortd error surfaces as SortdError with the status and never the key', async () => {
  const h = harness(() => ({ status: 402, json: { code: 'quota_exceeded', echo: KEY } }))
  await assert.rejects(ensureSortdSession(JANE, undefined, h.deps), (err: unknown) => {
    assert.ok(err instanceof SortdError)
    assert.equal(err.status, 402)
    assert.equal(err.message.includes(KEY), false)
    return true
  })
})

test('an unexpected response shape is rejected, not passed to the browser', async () => {
  const h = harness(() => ({ json: { sessionId: 'ess_1' } }))
  await assert.rejects(ensureSortdSession(JANE, undefined, h.deps), SortdError)
})

// ── reuse / refresh ──

test('reuse: a valid ticket with plenty of life left costs no Sortd call', async () => {
  const { ticket } = await mintFor(JANE)
  const h = harness(() => assert.fail('must not call Sortd'), T0 + DAY / 2)
  const s = await ensureSortdSession(JANE, ticket, h.deps)
  assert.equal(s.sessionId, 'ess_1')
  assert.equal(s.ticket, ticket)
  assert.equal(h.calls.length, 0)
})

test('refresh: inside the window the SAME session is extended at Sortd', async () => {
  const { ticket } = await mintFor(JANE)
  const now = T0 + DAY - REFRESH_WINDOW_MS / 2
  const h = harness(() => ({ json: sessionAt('ess_1', now + DAY) }), now)
  const s = await ensureSortdSession(JANE, ticket, h.deps)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].method, 'PUT')
  assert.equal(h.calls[0].url, `${BASE}/api/embed/sessions/ess_1/refresh`)
  assert.equal(s.sessionId, 'ess_1')
  assert.equal(s.expiresAt, new Date(now + DAY).toISOString())
  assert.notEqual(s.ticket, ticket)

  // The new ticket is itself reusable.
  const later = harness(() => assert.fail('must not call Sortd'), now + 60_000)
  assert.equal((await ensureSortdSession(JANE, s.ticket, later.deps)).sessionId, 'ess_1')
})

test('refresh of a session Sortd no longer has (404) mints a new one', async () => {
  const { ticket } = await mintFor(JANE)
  const now = T0 + DAY - 60_000
  const h = harness((c) => (c.method === 'PUT' ? { status: 404 } : { status: 201, json: sessionAt('ess_2', now + DAY) }), now)
  const s = await ensureSortdSession(JANE, ticket, h.deps)
  assert.deepEqual(h.calls.map((c) => c.method), ['PUT', 'POST'])
  assert.equal(s.sessionId, 'ess_2')
})

test('refresh during a Sortd outage is an error, not a silent re-mint', async () => {
  const { ticket } = await mintFor(JANE)
  const h = harness(() => ({ status: 503 }), T0 + DAY - 60_000)
  await assert.rejects(ensureSortdSession(JANE, ticket, h.deps), SortdError)
  assert.equal(h.calls.length, 1)
})

test('an expired ticket mints a new session without trying to refresh it', async () => {
  const { ticket } = await mintFor(JANE)
  const now = T0 + DAY + 1
  const h = harness(() => ({ status: 201, json: sessionAt('ess_2', now + DAY) }), now)
  const s = await ensureSortdSession(JANE, ticket, h.deps)
  assert.deepEqual(h.calls.map((c) => c.method), ['POST'])
  assert.equal(s.sessionId, 'ess_2')
})

// ── tickets that must NOT be honoured ──

const fresh = () => harness(() => ({ status: 201, json: sessionAt('ess_new', T0 + DAY) }), T0 + 60_000)

test("another account's ticket is never reused: a fresh session is minted", async () => {
  const { ticket } = await mintFor({ ...JANE, externalUserId: 'u2' })
  const h = fresh()
  const s = await ensureSortdSession(JANE, ticket, h.deps)
  assert.equal(s.sessionId, 'ess_new')
  assert.deepEqual(h.calls.map((c) => c.method), ['POST'])
})

test('a changed identity (promoted to owner, renamed) mints a fresh session', async () => {
  const { ticket } = await mintFor(JANE)
  for (const changed of [{ ...JANE, role: 'owner' as const }, { ...JANE, name: 'Jane F' }, { ...JANE, email: 'j@x.com' }]) {
    const h = fresh()
    assert.equal((await ensureSortdSession(changed, ticket, h.deps)).sessionId, 'ess_new')
  }
})

test('a tampered or foreign-key ticket is ignored', async () => {
  const { ticket } = await mintFor(JANE)
  const [body, sig] = ticket.split('.')
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString())
  const forgedBody = Buffer.from(JSON.stringify({ ...payload, sid: 'ess_victim' })).toString('base64url')

  const otherKey = harness(() => ({ status: 201, json: sessionAt('ess_x', T0 + DAY) }))
  otherKey.deps.config.apiKey = 'sk_app_other'
  const foreign = (await ensureSortdSession(JANE, undefined, otherKey.deps)).ticket

  const flippedSig = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1)
  for (const bad of [`${forgedBody}.${sig}`, `${body}.${flippedSig}`, foreign, 'garbage', '', 42, null, `${body}.`]) {
    const h = fresh()
    assert.equal((await ensureSortdSession(JANE, bad, h.deps)).sessionId, 'ess_new', `ticket ${String(bad).slice(0, 20)}`)
  }
})

// ── revoke ──

test('revoke: a valid ticket deletes its session at Sortd', async () => {
  const { ticket } = await mintFor(JANE)
  const h = harness(() => ({ json: { ok: true } }), T0 + 60_000)
  assert.equal(await revokeSortdSession(ticket, h.deps), true)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].method, 'DELETE')
  assert.equal(h.calls[0].url, `${BASE}/api/embed/sessions/ess_1`)
  assert.equal(h.calls[0].auth, `Bearer ${KEY}`)
})

test('revoke ignores forged, garbage and expired tickets without calling Sortd', async () => {
  const { ticket } = await mintFor(JANE)
  const [body] = ticket.split('.')
  for (const bad of [`${body}.forged`, 'garbage', undefined]) {
    const h = harness(() => assert.fail('must not call Sortd'), T0 + 60_000)
    assert.equal(await revokeSortdSession(bad, h.deps), false)
  }
  const expired = harness(() => assert.fail('must not call Sortd'), T0 + DAY + 1)
  assert.equal(await revokeSortdSession(ticket, expired.deps), false)
})

test('revoke of a session Sortd already dropped (404) is not an error', async () => {
  const { ticket } = await mintFor(JANE)
  const h = harness(() => ({ status: 404 }), T0 + 60_000)
  assert.equal(await revokeSortdSession(ticket, h.deps), false)
})

test('not configured: ensure throws, revoke is a no-op', async () => {
  await assert.rejects(ensureSortdSession(JANE, undefined, null), SortdError)
  assert.equal(await revokeSortdSession('x.y', null), false)
})
