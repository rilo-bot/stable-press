// Account lifecycle for SUPERADMINS: list every account, deactivate (soft delete),
// restore, and permanently delete (hard delete).
//
// DEACTIVATE is the normal tool. It stamps `users.deletedAt`, which the db wrapper
// already treats as "gone": the next request with their token answers "Account not
// found", and every read skips them. Their role is cleared (and remembered, so a
// restore can hand it back), their pending invites are cancelled, and sign-in
// refuses the address (`isDeactivatedEmail` in session.ts) instead of quietly
// minting a fresh account. Their bylines, magazines and uploads keep working because
// every id that points at them still resolves to a document.
//
// PERMANENT DELETE is for erasure requests. It removes the person's own data and
// detaches them from shared content, then deletes the `users` row. It cannot be
// undone. What happens to each kind of record is decided in ONE place — the steps
// in `purgeAccount` below — in three classes:
//
//   • DELETED     their personal rows: comments, reactions, reports, tips, tipper
//                 profile, notifications, assistant chats/runs, OTPs, invites,
//                 role link, org memberships.
//   • HANDED OVER content other people rely on: magazines they own and records they
//                 created (articles, blogs, horses, racing entries, media items)
//                 are reassigned to the superadmin doing the delete, so nothing
//                 becomes uneditable.
//   • DETACHED    shared rows keep existing without them: removed from magazine
//                 collaborators and record shares, party profiles unclaimed, and
//                 their NAME replaced with "Deleted user" on AI-usage and review
//                 audit rows (the cost and review history stays).
//
// Refused outright: deleting yourself, removing the last superadmin, and deleting
// someone who still OWNS an organisation (nothing can appoint a replacement owner
// automatically — same rule as `DELETE /api/organisations/:id/members/:userId`).
//
// UPLOADS ARE NOT DELETED INLINE. One S3 object can be referenced by several
// records (see scripts/sweep-orphan-objects.ts), so deleting `public/*/<userId>/…`
// here could break a published page. Instead the id goes into `purgedAccounts`,
// which lets the sweeper keep proving those keys are ours; it then removes the ones
// nothing references on its next run.
//
// Every step uses the RAW driver collection on purpose: an erasure must also reach
// rows that were already soft-deleted, which the wrapper cannot see. Steps are
// idempotent and the `users` row goes LAST, so a purge that fails halfway can simply
// be run again.

import { ObjectId, type Filter, type Document } from 'mongodb'
import { db, rawCollection } from './db.js'
import {
  ADMIN_ROLES,
  AGENT_RUNS,
  AI_USAGE,
  INVITES,
  ORGANISATIONS,
  ORG_MEMBERS,
  OTPS,
  PARTIES,
  PURGED_ACCOUNTS,
  USERS,
} from './collections.js'
import { COL } from './magazineV2/collections.js'
import { assignRole, clearRole, getRole, getRoles, linkForUser, linksForUsers } from './roleRegistry.js'
import { checkSuperadminLoss } from './roleGrant.js'
import { findUserByEmail } from './session.js'
import type { AccountUser } from './effectiveAccess.js'

type Outcome<T = object> =
  | ({ ok: true } & T)
  | { ok: false; status: 400 | 403 | 404 | 409; error: string }

const refuse = (status: 400 | 403 | 404 | 409, error: string) => ({ ok: false as const, status, error })

/** The name written over a purged person's name on rows that are kept. */
const DELETED_NAME = 'Deleted user'

/** Matches a document by id whether it was stored as an ObjectId or a string. */
function byId(id: string): Filter<Document> {
  if (ObjectId.isValid(id) && new ObjectId(id).toHexString() === id) {
    return { _id: { $in: [new ObjectId(id), id] } } as Filter<Document>
  }
  return { _id: id } as unknown as Filter<Document>
}

const normalizeEmail = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '')
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ── List ────────────────────────────────────────────────────────────────────

export type AccountStatusFilter = 'active' | 'deactivated' | 'all'

export interface AccountRow {
  userId: string
  name: string
  email: string
  status: 'active' | 'deactivated'
  isAdmin: boolean
  /** Label of the role they hold now. Deactivated accounts hold none. */
  roleLabel: string | null
  isSuperAdmin: boolean
  lastLogin: string | null
  createdAt: string | null
  deactivatedAt: string | null
  deactivatedByName: string | null
}

/** Every account, live and deactivated — the one read that sees tombstones. */
export async function listAccounts(opts: {
  q?: string
  status?: AccountStatusFilter
  limit?: number
}): Promise<{ accounts: AccountRow[]; total: number }> {
  const users = await rawCollection(USERS)
  const filter: Filter<Document> = {}
  if (opts.status === 'active') filter.deletedAt = null
  else if (opts.status === 'deactivated') filter.deletedAt = { $ne: null }
  const q = (opts.q ?? '').trim().slice(0, 100)
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i')
    filter.$or = [{ name: rx }, { email: rx }]
  }
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200)

  const [docs, total] = await Promise.all([
    users
      .find(filter, {
        projection: { name: 1, email: 1, isAdmin: 1, lastLogin: 1, createdAt: 1, deletedAt: 1, deactivatedBy: 1 },
      })
      .sort({ name: 1, email: 1 })
      .limit(limit)
      .toArray(),
    users.countDocuments(filter),
  ])

  const ids = docs.map((d) => String(d._id))
  const [links, roles] = await Promise.all([linksForUsers(ids), getRoles()])
  const rolesById = new Map([...roles.values()].map((r) => [r.id, r]))

  // Who deactivated each one, in ONE read.
  const deactivatorIds = [...new Set(docs.map((d) => String(d.deactivatedBy ?? '')).filter(Boolean))]
  const deactivators = new Map(
    (await db.collection(USERS).findByIds(deactivatorIds)).map((u) => [String(u._id), String(u.name || u.email || '')]),
  )

  const accounts = docs.map((d): AccountRow => {
    const id = String(d._id)
    const deactivated = !!d.deletedAt
    const link = deactivated ? undefined : links.get(id)
    const role = link ? rolesById.get(link.roleId) : undefined
    return {
      userId: id,
      name: String(d.name ?? ''),
      email: String(d.email ?? ''),
      status: deactivated ? 'deactivated' : 'active',
      isAdmin: !deactivated && d.isAdmin === true,
      roleLabel: role?.label ?? null,
      isSuperAdmin: role?.isSuper === true,
      lastLogin: typeof d.lastLogin === 'string' ? d.lastLogin : null,
      createdAt: typeof d.createdAt === 'string' ? d.createdAt : null,
      deactivatedAt: deactivated ? String(d.deletedAt) : null,
      deactivatedByName: deactivated ? deactivators.get(String(d.deactivatedBy ?? '')) ?? null : null,
    }
  })
  return { accounts, total }
}

// ── Deactivate (soft delete) ────────────────────────────────────────────────

export async function deactivateAccount(actor: AccountUser, userId: string): Promise<Outcome> {
  if (userId === actor.id) return refuse(403, 'You cannot deactivate your own account.')

  const target = await db.collection(USERS).findById(userId)
  if (!target) return refuse(404, 'No active account with that id.')

  const link = await linkForUser(userId)
  const role = link ? await getRole(link.roleId) : undefined
  const blocked = await checkSuperadminLoss(actor, role?.isSuper === true)
  if (blocked) return refuse(403, blocked)

  // Role first, while the user row is still live (clearRole writes through the
  // soft-delete-aware wrapper). The role id is kept so a restore can return it.
  await clearRole(userId)

  // A surviving invite link would be a way back in.
  const email = normalizeEmail(target.email)
  if (email) await (await rawCollection(INVITES)).deleteMany({ email })

  const now = new Date().toISOString()
  await (await rawCollection(USERS)).updateOne(byId(userId), {
    $set: {
      deletedAt: now,
      deactivatedBy: actor.id,
      deactivatedRoleId: link?.roleId ?? null,
      // findById already refuses a tombstoned account, so this is belt-and-braces:
      // any token issued before now is dead even if the account is restored.
      tokenVersion: (typeof target.tokenVersion === 'number' ? target.tokenVersion : 0) + 1,
      updatedAt: now,
    },
  })
  console.warn(`[accounts] user ${userId} DEACTIVATED by ${actor.id} at ${now}`)
  return { ok: true }
}

// ── Restore ─────────────────────────────────────────────────────────────────

export async function restoreAccount(
  actor: AccountUser,
  userId: string,
): Promise<Outcome<{ restoredRole: string | null }>> {
  const users = await rawCollection(USERS)
  const doc = await users.findOne(byId(userId))
  if (!doc) return refuse(404, 'No account with that id.')
  if (!doc.deletedAt) return refuse(409, 'That account is already active.')

  // `users.email` is unique among LIVE accounts, so a restore cannot coexist with
  // an account someone created on the same address in the meantime.
  const email = normalizeEmail(doc.email)
  if (email && (await findUserByEmail(email))) {
    return refuse(409, 'Another active account now uses this email, so this one cannot be restored.')
  }

  const now = new Date().toISOString()
  try {
    await users.updateOne(byId(userId), {
      $set: { updatedAt: now, restoredAt: now, restoredBy: actor.id },
      $unset: { deletedAt: '', deactivatedBy: '', deactivatedRoleId: '' },
    })
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      return refuse(409, 'Another active account now uses this email, so this one cannot be restored.')
    }
    throw err
  }

  // Hand back the role they held, if it still exists.
  let restoredRole: string | null = null
  const roleId = typeof doc.deactivatedRoleId === 'string' ? doc.deactivatedRoleId : ''
  const role = roleId ? await getRole(roleId) : undefined
  if (role) {
    await assignRole(userId, role.id, actor.id)
    restoredRole = role.label
  }
  console.warn(`[accounts] user ${userId} RESTORED by ${actor.id} at ${now}`)
  return { ok: true, restoredRole }
}

// ── Permanent delete (hard delete) ──────────────────────────────────────────

/** What was done, per step, for the confirmation toast and the server log. */
export type PurgeSummary = Record<string, number>

export async function purgeAccount(
  actor: AccountUser,
  userId: string,
  confirmEmail: unknown,
): Promise<Outcome<{ summary: PurgeSummary }>> {
  if (userId === actor.id) return refuse(403, 'You cannot delete your own account.')

  const users = await rawCollection(USERS)
  const doc = await users.findOne(byId(userId))
  if (!doc) return refuse(404, 'No account with that id.')

  const email = normalizeEmail(doc.email)
  // The server checks this too, so a stray request cannot erase someone.
  if (!email || normalizeEmail(confirmEmail) !== email) {
    return refuse(400, "Type the account's email address exactly to confirm.")
  }

  const ownedOrgs = await (await rawCollection(ORGANISATIONS))
    .find({ ownerUserId: userId, deletedAt: null }, { projection: { name: 1 } })
    .toArray()
  if (ownedOrgs.length > 0) {
    const names = ownedOrgs.map((o) => `“${String(o.name ?? 'Untitled')}”`).join(', ')
    return refuse(409, `They own ${names}. Transfer ownership of the organisation first.`)
  }

  const link = await linkForUser(userId)
  const role = link ? await getRole(link.roleId) : undefined
  const blocked = await checkSuperadminLoss(actor, role?.isSuper === true)
  if (blocked) return refuse(403, blocked)

  const summary: PurgeSummary = {}
  const step = async (label: string, run: () => Promise<number>) => {
    summary[label] = await run()
  }
  const col = rawCollection
  const actorName = actor.name?.trim() || actor.email || 'Superadmin'

  // ── DELETED: their own rows ──
  await step('roleLinks', async () => (await (await col(ADMIN_ROLES)).deleteMany({ userId })).deletedCount)
  await step('orgMemberships', async () => (await (await col(ORG_MEMBERS)).deleteMany({ userId })).deletedCount)
  await step('notifications', async () =>
    (await (await col('notifications')).deleteMany({ recipientUserId: userId })).deletedCount)
  await step('reactions', async () => (await (await col('reactions')).deleteMany({ userId })).deletedCount)

  // Their comments, and every report filed against them.
  const comments = await col('comments')
  const commentReports = await col('commentReports')
  const theirCommentIds = (await comments.find({ userId }, { projection: { _id: 1 } }).toArray()).map((c) =>
    String(c._id),
  )
  await step('comments', async () => (await comments.deleteMany({ userId })).deletedCount)
  if (theirCommentIds.length) await commentReports.deleteMany({ commentId: { $in: theirCommentIds } })

  // Reports THEY filed — then recount `reportCount` on the comments they reported,
  // because the moderation queue sorts on that denormalised number.
  const reported = [
    ...new Set(
      (await commentReports.find({ userId }, { projection: { commentId: 1 } }).toArray()).map((r) =>
        String(r.commentId),
      ),
    ),
  ]
  await step('commentReports', async () => (await commentReports.deleteMany({ userId })).deletedCount)
  for (const commentId of reported) {
    const count = await commentReports.countDocuments({ commentId, deletedAt: null })
    await comments.updateOne(byId(commentId), { $set: { reportCount: count } })
  }

  await step('tips', async () => (await (await col('tips')).deleteMany({ userId })).deletedCount)
  await step('tipperProfiles', async () => (await (await col('tipperProfiles')).deleteMany({ userId })).deletedCount)
  await step('assistantRuns', async () => (await (await col(AGENT_RUNS)).deleteMany({ userId })).deletedCount)
  await step('assistantThreads', async () => (await (await col(COL.threads)).deleteMany({ userId })).deletedCount)
  await step('assistantMessages', async () => (await (await col(COL.chat)).deleteMany({ userId })).deletedCount)
  await step('invites', async () => (await (await col(INVITES)).deleteMany({ email })).deletedCount)
  await step('signInCodes', async () => (await (await col(OTPS)).deleteMany({ email })).deletedCount)

  // ── HANDED OVER: content others rely on goes to the acting superadmin ──
  const magazines = await col(COL.magazines)
  const owned = (await magazines.find({ ownerId: userId }, { projection: { _id: 1 } }).toArray()).map((m) => m._id)
  await step('magazinesHandedOver', async () => {
    if (owned.length === 0) return 0
    const r = await magazines.updateMany(
      { _id: { $in: owned } },
      // The new owner must not also sit in the collaborator list.
      { $set: { ownerId: actor.id, ownerName: actorName }, $pull: { collaborators: { userId: actor.id } } } as Document,
    )
    return r.modifiedCount
  })
  for (const name of ['racingEntries', 'mediaItems']) {
    await step(`${name}HandedOver`, async () =>
      (await (await col(name)).updateMany(
        { createdByUserId: userId },
        { $set: { createdByUserId: actor.id, createdByName: actorName } },
      )).modifiedCount)
  }
  for (const name of ['articles', 'blogs', 'horses']) {
    await step(`${name}HandedOver`, async () =>
      (await (await col(name)).updateMany({ createdByUserId: userId }, { $set: { createdByUserId: actor.id } }))
        .modifiedCount)
  }

  // ── DETACHED: shared rows stay, without them ──
  await step('magazineCollaborations', async () =>
    (await magazines.updateMany(
      { $or: [{ 'collaborators.userId': userId }, { 'pendingCollaborators.email': email }] },
      { $pull: { collaborators: { userId }, pendingCollaborators: { email } } } as Document,
    )).modifiedCount)
  for (const name of ['racingEntries', 'mediaItems']) {
    await step(`${name}Shares`, async () =>
      (await (await col(name)).updateMany(
        { 'sharedWith.userId': userId },
        { $pull: { sharedWith: { userId } } } as Document,
      )).modifiedCount)
  }
  // Unclaimed rows carry `taken: false` and no userId (routes/parties).
  await step('partiesUnclaimed', async () =>
    (await (await col(PARTIES)).updateMany({ userId }, { $set: { taken: false }, $unset: { userId: '' } }))
      .modifiedCount)
  await step('aiUsageAnonymised', async () =>
    (await (await col(AI_USAGE)).updateMany({ userId }, { $set: { userName: DELETED_NAME } })).modifiedCount)
  await step('reviewHistoryAnonymised', async () =>
    (await (await col(COL.reviews)).updateMany({ actorId: userId }, { $set: { actorName: DELETED_NAME } }))
      .modifiedCount)

  // ── The account itself, LAST ──
  const now = new Date().toISOString()
  await (await col(PURGED_ACCOUNTS)).updateOne(
    { userId },
    { $setOnInsert: { userId, purgedAt: now, purgedBy: actor.id } },
    { upsert: true },
  )
  await step('account', async () => (await users.deleteOne(byId(userId))).deletedCount)

  console.warn(`[accounts] user ${userId} PERMANENTLY DELETED by ${actor.id} at ${now}`, summary)
  return { ok: true, summary }
}
