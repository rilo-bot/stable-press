// ---------------------------------------------------------------------------
// Sortd — hosted customer support (AI chat + tickets) for signed-in users.
//
// The browser NEVER sees SORTD_API_KEY. It calls POST /api/sortd/session; this
// module calls Sortd with the key and hands back an opaque embed `sessionId`,
// which the embed.js loader renders the support widget with.
//
// SESSION TICKETS — why there is no collection.
// A Sortd embed session lasts one day. Minting a new one on every page load is
// what the integration guide warns against, and a tab left open must be able to
// EXTEND its session in place: the widget bakes the id in, so a new id would
// mean tearing the widget down mid-conversation. Extending has to survive an API
// restart too (Render restarts on every deploy), so "who owns this session"
// cannot live in process memory.
//
// So the server signs a small ticket { sid, exp, uid, idn } with HMAC-SHA256,
// keyed by SORTD_API_KEY, and the browser keeps it. A ticket proves THIS server
// minted that session for THAT account and identity:
//   reuse   — a valid ticket for the caller with more than REFRESH_WINDOW_MS
//             left comes back as-is, with no call to Sortd;
//   refresh — inside the window the SAME session is extended at Sortd;
//   revoke  — sign-out sends the ticket and the session is revoked at Sortd.
// Each signed-in device keeps its own ticket, so signing out on one device never
// kills the widget on another.
//
// Rotating SORTD_API_KEY invalidates every ticket. Each browser then mints a
// fresh session on its next page load, so rotation needs no other step.
// ---------------------------------------------------------------------------

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { AccountUser } from './effectiveAccess.js'

/** Sortd scopes ticket visibility by role. `admin` (tenant-wide) is unused:
 *  Stable Press is a single tenant, where admin without a tenant id means
 *  "every ticket", which is what `owner` already says explicitly. */
export type SortdRole = 'user' | 'owner'

export interface SortdConfig {
  /** Origin only, e.g. https://support.example.com (no trailing slash). */
  baseUrl: string
  apiKey: string
}

export interface SortdIdentity {
  externalUserId: string
  email: string
  name?: string
  role: SortdRole
}

export interface SortdSession {
  sessionId: string
  /** ISO timestamp from Sortd. */
  expiresAt: string
  /** Signed proof of ownership. The browser stores it and sends it back. */
  ticket: string
}

interface TicketPayload {
  /** Sortd session id. */
  sid: string
  /** Expiry, epoch ms. */
  exp: number
  /** Stable Press account id. */
  uid: string
  /** Hash of the identity the session was minted with (email, name, role). */
  idn: string
}

export interface SortdDeps {
  config: SortdConfig
  fetch: typeof globalThis.fetch
  now: () => number
}

/** Refresh a session once less than this much of its life is left. The browser
 *  schedules its keep-alive call 30 minutes before expiry, inside this window. */
export const REFRESH_WINDOW_MS = 60 * 60_000
const REQUEST_TIMEOUT_MS = 10_000

// ── Config ──────────────────────────────────────────────────────────────────

/** null when Sortd isn't configured; the widget is then simply not offered. */
export function sortdConfig(): SortdConfig | null {
  const rawUrl = (process.env.SORTD_BASE_URL ?? '').trim()
  const apiKey = (process.env.SORTD_API_KEY ?? '').trim()
  if (!rawUrl || !apiKey) return null
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return { baseUrl: url.origin, apiKey }
  } catch {
    return null
  }
}

/** One line for the server's startup environment report. Never prints the key. */
export function sortdConfigLabel(): string {
  const config = sortdConfig()
  if (config) return `✓ configured (${config.baseUrl})`
  const hasUrl = !!process.env.SORTD_BASE_URL?.trim()
  const hasKey = !!process.env.SORTD_API_KEY?.trim()
  if (!hasUrl && !hasKey) return '✗ not set (support widget hidden)'
  if (hasUrl && hasKey) return '✗ SORTD_BASE_URL is not a valid http(s) URL (support widget hidden)'
  return `✗ ${hasUrl ? 'SORTD_API_KEY' : 'SORTD_BASE_URL'} missing (support widget hidden)`
}

function defaultDeps(): SortdDeps | null {
  const config = sortdConfig()
  return config ? { config, fetch: globalThis.fetch, now: Date.now } : null
}

// ── Identity ────────────────────────────────────────────────────────────────

/**
 * Who Sortd should see. Superadmins get `owner`: every ticket in the app. Every
 * other account, staff included, sees only its own tickets. Your own support
 * team is marked "Internal" in the Sortd portal (Users tab), not here.
 *
 * null when the account has no email: Sortd requires one.
 */
export function sortdIdentityFor(account: Pick<AccountUser, 'id' | 'email' | 'name' | 'isSuperAdmin'>): SortdIdentity | null {
  const email = account.email.trim()
  if (!account.id || !email) return null
  const name = account.name.trim()
  return {
    externalUserId: account.id,
    email,
    ...(name ? { name } : {}),
    role: account.isSuperAdmin ? 'owner' : 'user',
  }
}

/** A short hash, so a changed email, name or role mints a fresh session. */
function identityHash(identity: SortdIdentity): string {
  return createHash('sha256')
    .update(`${identity.email}\n${identity.name ?? ''}\n${identity.role}`)
    .digest('base64url')
    .slice(0, 22)
}

// ── Tickets ─────────────────────────────────────────────────────────────────

function sign(body: string, apiKey: string): string {
  // Domain-separated, so the HMAC can never be confused with any other use of the key.
  return createHmac('sha256', `stablepress-sortd-ticket:${apiKey}`).update(body).digest('base64url')
}

function signTicket(payload: TicketPayload, apiKey: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${sign(body, apiKey)}`
}

/** The payload, or null for anything this server didn't sign. Never throws. */
function readTicket(ticket: unknown, apiKey: string): TicketPayload | null {
  if (typeof ticket !== 'string' || ticket.length > 2048) return null
  const dot = ticket.indexOf('.')
  if (dot <= 0) return null
  const body = ticket.slice(0, dot)
  const given = Buffer.from(ticket.slice(dot + 1))
  const expected = Buffer.from(sign(body, apiKey))
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<TicketPayload>
    if (
      typeof p.sid !== 'string' || !p.sid ||
      typeof p.exp !== 'number' || !Number.isFinite(p.exp) ||
      typeof p.uid !== 'string' || !p.uid ||
      typeof p.idn !== 'string'
    ) return null
    return { sid: p.sid, exp: p.exp, uid: p.uid, idn: p.idn }
  } catch {
    return null
  }
}

// ── Sortd HTTP ──────────────────────────────────────────────────────────────

export class SortdError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'SortdError'
  }
}

async function sortdRequest(deps: SortdDeps, method: string, path: string, body?: unknown): Promise<unknown> {
  let res: Response
  try {
    res = await deps.fetch(`${deps.config.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${deps.config.apiKey}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    throw new SortdError(`${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  const text = await res.text().catch(() => '')
  // Only the status: a Sortd error body could echo request details, and the key
  // must never reach a log.
  if (!res.ok) throw new SortdError(`${method} ${path} → ${res.status}`, res.status)
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new SortdError(`${method} ${path} returned non-JSON`, res.status)
  }
}

/** Sortd's { sessionId, expiresAt }, validated. */
function parseSession(raw: unknown, what: string): { sessionId: string; exp: number; expiresAt: string } {
  const r = (raw ?? {}) as { sessionId?: unknown; expiresAt?: unknown }
  const exp = typeof r.expiresAt === 'string' ? Date.parse(r.expiresAt) : NaN
  if (typeof r.sessionId !== 'string' || !r.sessionId || !Number.isFinite(exp)) {
    throw new SortdError(`${what} returned an unexpected shape`)
  }
  return { sessionId: r.sessionId, exp, expiresAt: new Date(exp).toISOString() }
}

// ── Sessions ────────────────────────────────────────────────────────────────

/**
 * The caller's embed session: the ticket's own session when it is still theirs
 * and still good, extended at Sortd when it's near expiry, otherwise a new one.
 */
export async function ensureSortdSession(
  identity: SortdIdentity,
  ticket?: unknown,
  deps: SortdDeps | null = defaultDeps(),
): Promise<SortdSession> {
  if (!deps) throw new SortdError('Sortd is not configured')
  const { config, now } = deps
  const idn = identityHash(identity)
  const prior = readTicket(ticket, config.apiKey)

  // Only ever reuse a session minted for THIS account with THIS identity. A
  // ticket left in the browser by a different account is ignored, not refreshed.
  if (prior && prior.uid === identity.externalUserId && prior.idn === idn && prior.exp > now()) {
    if (prior.exp - now() > REFRESH_WINDOW_MS) {
      return { sessionId: prior.sid, expiresAt: new Date(prior.exp).toISOString(), ticket: ticket as string }
    }
    try {
      const refreshed = parseSession(
        await sortdRequest(deps, 'PUT', `/api/embed/sessions/${encodeURIComponent(prior.sid)}/refresh`),
        'refresh',
      )
      return toSession(refreshed, identity, idn, config.apiKey)
    } catch (err) {
      // Revoked or already gone at Sortd: fall through and mint a new one.
      // Anything else (Sortd down) is an outage, so don't paper over it.
      if (!(err instanceof SortdError) || (err.status !== 404 && err.status !== 401 && err.status !== 410)) throw err
    }
  }

  const minted = parseSession(
    await sortdRequest(deps, 'POST', '/api/embed/sessions', {
      externalUserId: identity.externalUserId,
      email: identity.email,
      name: identity.name,
      role: identity.role,
    }),
    'mint',
  )
  return toSession(minted, identity, idn, config.apiKey)
}

function toSession(
  s: { sessionId: string; exp: number; expiresAt: string },
  identity: SortdIdentity,
  idn: string,
  apiKey: string,
): SortdSession {
  return {
    sessionId: s.sessionId,
    expiresAt: s.expiresAt,
    ticket: signTicket({ sid: s.sessionId, exp: s.exp, uid: identity.externalUserId, idn }, apiKey),
  }
}

/**
 * Revoke the ticket's session at Sortd (on sign-out).
 *
 * Needs no app session on purpose: the browser may have just LOST its token (a
 * 401 auto-signs out), and the signed ticket already proves this server minted
 * the session. Revoking only ever removes access. Returns false for a forged,
 * foreign or expired ticket, and for a session Sortd no longer has.
 */
export async function revokeSortdSession(ticket: unknown, deps: SortdDeps | null = defaultDeps()): Promise<boolean> {
  if (!deps) return false
  const prior = readTicket(ticket, deps.config.apiKey)
  if (!prior || prior.exp <= deps.now()) return false
  try {
    await sortdRequest(deps, 'DELETE', `/api/embed/sessions/${encodeURIComponent(prior.sid)}`)
    return true
  } catch (err) {
    if (err instanceof SortdError && err.status === 404) return false
    throw err
  }
}
