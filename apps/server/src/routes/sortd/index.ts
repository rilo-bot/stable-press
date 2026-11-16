// ---------------------------------------------------------------------------
// Sortd support widget — embed sessions for the signed-in user.
//
//   POST /api/sortd/session         { ticket? } → { enabled: false }
//                                    | { enabled: true, baseUrl, sessionId, expiresAt, ticket }
//   POST /api/sortd/session/revoke  { ticket }  → { ok: true }
//
// The API key stays here (lib/sortd.ts). The browser only ever holds the opaque
// session id plus the signed ticket that lets it reuse, extend and revoke it.
// ---------------------------------------------------------------------------

import { Router } from 'express'
import { attachAccount } from '../../lib/auth.js'
import { rateLimit } from '../../lib/rateLimit.js'
import {
  ensureSortdSession,
  revokeSortdSession,
  sortdConfig,
  sortdIdentityFor,
} from '../../lib/sortd.js'

const router = Router()

// A page load plus a keep-alive every ~23h is the normal rate; this only stops
// a runaway client from minting sessions in a loop.
const sessionLimit = rateLimit('sortd-session', 20, 60_000)
// Anonymous (see revoke below), so this one is keyed by IP.
const revokeLimit = rateLimit('sortd-revoke', 20, 60_000)

// ── Mint, reuse or extend the caller's embed session ──
router.post('/session', attachAccount, sessionLimit, async (req, res) => {
  const config = sortdConfig()
  // Not configured, or an account with no email (Sortd requires one): the widget
  // is simply not offered. A 200, so the browser doesn't log it as an error.
  const identity = config ? sortdIdentityFor(req.account!) : null
  if (!config || !identity) {
    res.json({ enabled: false })
    return
  }
  try {
    const session = await ensureSortdSession(identity, req.body?.ticket)
    res.json({ enabled: true, baseUrl: config.baseUrl, ...session })
  } catch (err) {
    console.error('[sortd] embed session failed:', err instanceof Error ? err.message : err)
    res.status(502).json({ error: 'Support is unavailable right now.' })
  }
})

// ── Revoke on sign-out ──
// No attachAccount: the browser may have just lost its token (a 401 signs it
// out), and the ticket's signature already proves this server minted the session.
router.post('/session/revoke', revokeLimit, async (req, res) => {
  try {
    await revokeSortdSession(req.body?.ticket)
  } catch (err) {
    // Best effort: the session expires within a day regardless.
    console.warn('[sortd] revoke failed:', err instanceof Error ? err.message : err)
  }
  res.json({ ok: true })
})

export default router
