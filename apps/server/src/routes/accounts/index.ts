// Every account, and the two ways to remove one. SUPERADMIN ONLY.
//
//   GET    /api/accounts?q=&status=active|deactivated|all&limit=
//   POST   /api/accounts/:userId/deactivate     soft delete — reversible
//   POST   /api/accounts/:userId/restore        undo a deactivation
//   DELETE /api/accounts/:userId  { confirmEmail }   permanent delete — NOT reversible
//
// Gated on `isSuperAdmin` (the role's `isSuper` flag), not on a catalogue
// permission: there is deliberately no checkbox that hands this to another role.
// What each operation touches is documented in lib/accounts.ts.

import { Router } from 'express'
import { attachAccount } from '../../lib/auth.js'
import { isPlatformAdmin } from '../../lib/rbac.js'
import {
  deactivateAccount,
  listAccounts,
  purgeAccount,
  restoreAccount,
  type AccountStatusFilter,
} from '../../lib/accounts.js'

const router = Router()

router.use(attachAccount)
router.use((req, res, next) => {
  if (!isPlatformAdmin(req.account)) {
    res.status(403).json({ error: 'Only a superadmin can manage accounts.' })
    return
  }
  next()
})

const STATUSES: AccountStatusFilter[] = ['active', 'deactivated', 'all']

/**
 * Express 4 does not forward a rejected promise from an async handler — the
 * request just hangs. Every handler here goes through this.
 */
function handle(fn: (req: import('express').Request, res: import('express').Response) => Promise<void>) {
  return (req: import('express').Request, res: import('express').Response) => {
    fn(req, res).catch((err) => {
      console.error('[accounts]', err instanceof Error ? err.message : err)
      if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Please try again.' })
    })
  }
}

router.get('/', handle(async (req, res) => {
  const status = STATUSES.includes(req.query.status as AccountStatusFilter)
    ? (req.query.status as AccountStatusFilter)
    : 'all'
  const result = await listAccounts({
    q: typeof req.query.q === 'string' ? req.query.q : '',
    status,
    limit: Number(req.query.limit) || undefined,
  })
  res.json(result)
}))

router.post('/:userId/deactivate', handle(async (req, res) => {
  const r = await deactivateAccount(req.account!, String(req.params.userId))
  if (!r.ok) {
    res.status(r.status).json({ error: r.error })
    return
  }
  res.json({ ok: true })
}))

router.post('/:userId/restore', handle(async (req, res) => {
  const r = await restoreAccount(req.account!, String(req.params.userId))
  if (!r.ok) {
    res.status(r.status).json({ error: r.error })
    return
  }
  res.json({ ok: true, restoredRole: r.restoredRole })
}))

router.delete('/:userId', handle(async (req, res) => {
  const r = await purgeAccount(req.account!, String(req.params.userId), req.body?.confirmEmail)
  if (!r.ok) {
    res.status(r.status).json({ error: r.error })
    return
  }
  res.json({ ok: true, summary: r.summary })
}))

export default router
