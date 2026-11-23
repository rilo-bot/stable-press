// ---------------------------------------------------------------------------
// Inviting someone to the team BECAUSE a magazine was shared with them.
//
// The share itself is already staged as a pending share on the magazine (see
// lib/magazineV2/pendingShares.ts) by the time this runs. This only makes sure
// the person has a way in: a team-invite link (the same `pendingStaffGrants` row
// and one-time token as Team › Invite) whose `redirectTo` is the magazine, sent
// as one email that names the magazine and the pages.
//
// The same guards as the Team screen's invite door, because it IS that door:
//   - creating an invite needs team-management permission (canManageTeam)
//   - the role must be one the sharer could grant directly (canOfferRole)
// A sharer without those still gets their share staged; they're told to ask a
// team admin to invite the person, and the share applies when that invite is
// redeemed.
//
// THE SHARER CHOOSES THE ROLE. Joining the team through a magazine share is still
// joining the team, so the role is a decision for a person, not a guess: the
// Share dialog (and Stable Hand) ask for it, from `inviteRoleOptions`, and the
// route refuses a new invite without one.
//
// NEVER THROWS: the share is committed before this runs.
// ---------------------------------------------------------------------------

import { db } from './db.js'
import { INVITES } from './collections.js'
import { canManageTeam } from './rbac.js'
import { canOfferRole } from './roleGrant.js'
import { getRoles, listRoles, type RoleDoc } from './roleRegistry.js'
import type { AccountUser } from './effectiveAccess.js'
import { sendMagazineInviteEmail } from './email.js'
import {
  INVITE_RESEND_COOLDOWN_MS,
  expiresInLabel,
  generateInviteToken,
  hashInviteToken,
  inviteExpiry,
  inviteUrl,
  isExpired,
  sanitizeRedirect,
} from './invites.js'

const WEB_PUBLIC_URL = (process.env.WEB_PUBLIC_URL ?? 'http://localhost:5173').replace(/\/$/, '')

export interface ShareInviteResult {
  /** A live invite now exists for this address (new, refreshed, or already there). */
  invited: boolean
  /** They were already invited, so THAT invite's role stands, not the one chosen
   *  now — a share never changes an invite someone else issued. */
  keptExistingRole?: boolean
  /** The invite email actually went out on THIS call. */
  emailed: boolean
  /** Label of the role they will join with, when known. */
  roleLabel?: string
  /** Why no invite / no email — phrased for the owner to read. */
  error?: string
}

function actorName(actor: AccountUser): string {
  return actor.name?.trim() || actor.email || 'A Stable Press administrator'
}

export interface InviteRoleOption {
  name: string
  label: string
  description?: string
  color?: string
  /** Holds Magazine Builder › View AND Edit. A role without them can join but
   *  can't work on the shared pages, so the picker says so. */
  canUseMagazines: boolean
}

/**
 * What the sharer may choose from. `canInvite` false = they can't create team
 * invites at all (no team-management permission); the share is still saved.
 * Superadmin is never offered here: making someone superadmin is a Team-screen
 * decision, not a side effect of sharing pages.
 */
export async function inviteRoleOptions(actor: AccountUser): Promise<{ canInvite: boolean; roles: InviteRoleOption[] }> {
  if (!canManageTeam(actor)) return { canInvite: false, roles: [] }
  const roles = (await listRoles())
    .filter((r) => !r.isSuper && canOfferRole(actor, r).ok)
    .map((r) => ({
      name: r.name,
      label: r.label,
      description: r.description,
      color: r.color,
      canUseMagazines: r.permissions.includes('magazine.view') && r.permissions.includes('magazine.edit'),
    }))
    .sort((a, b) => Number(b.canUseMagazines) - Number(a.canUseMagazines) || a.label.localeCompare(b.label))
  return { canInvite: true, roles }
}

/**
 * Resolve the role the sharer picked — by name (slug) or label, case-insensitive —
 * and check they may give it. Run BEFORE anything is saved, so a bad pick is a
 * plain refusal rather than a half-done share.
 */
export async function resolveInviteRole(actor: AccountUser, requested: string): Promise<{ role?: RoleDoc; error?: string; status?: number }> {
  const q = requested.trim().toLowerCase()
  const all = await listRoles()
  const role = (await getRoles()).get(requested.trim()) ?? all.find((r) => r.name.toLowerCase() === q || r.label.toLowerCase() === q)
  if (!role) return { error: `There is no role called "${requested}".`, status: 400 }
  if (role.isSuper) return { error: 'Superadmin can only be given from the Team screen.', status: 403 }
  const ok = canOfferRole(actor, role)
  return ok.ok ? { role } : { error: ok.error, status: ok.status }
}

/**
 * Is there a team invite for this address that would actually WORK — unexpired,
 * and for a role that still exists? A row whose role was deleted can't be redeemed
 * (the accept route refuses it), so counting it as live would skip asking for a
 * role and leave the person with a link that fails.
 */
export async function hasLiveInvite(email: string): Promise<boolean> {
  try {
    const roles = await getRoles()
    return (await db.collection(INVITES).find({ email })).some((r) => !isExpired(r) && roles.has(String(r.role)))
  } catch {
    return false
  }
}

export async function inviteForShare(opts: {
  actor: AccountUser
  email: string
  magazineTitle: string
  /** Same-origin path to the magazine. */
  magazinePath: string
  /** Already phrased, e.g. "You can edit pages 2 and 3 of 12." */
  scope: string
  /** The role the sharer chose, already checked by resolveInviteRole. Required
   *  to create a new invite; ignored when one is already waiting for them. */
  role?: RoleDoc
}): Promise<ShareInviteResult> {
  const { actor, email } = opts
  try {
    const rows = await db.collection(INVITES).find({ email })
    const roles = await getRoles()
    // Prefer a live row whose role still exists; one with a deleted role is dead.
    const live = rows.find((r) => !isExpired(r) && roles.has(String(r.role))) ?? rows.find((r) => !isExpired(r))
    const liveRole = live ? roles.get(String(live.role)) : undefined

    if (!canManageTeam(actor)) {
      // Someone who CAN manage the team already invited them: the share will ride
      // on that invite. Nothing to send, nothing to apologise for.
      if (live && liveRole) return { invited: true, emailed: false, roleLabel: liveRole.label, keptExistingRole: true }
      return {
        invited: false,
        emailed: false,
        error: `${email} isn't on the team yet and you can't invite new people. Ask someone who manages the team to invite them — the share is saved and will apply as soon as they join.`,
      }
    }

    const now = new Date()
    const token = generateInviteToken()
    let role: RoleDoc | undefined

    if (live && liveRole) {
      // Already invited (from Team, or an earlier share). Keep THEIR role — a share
      // must never downgrade or upgrade an invite someone else issued — but send a
      // fresh link that names this magazine. A fresh token, exactly like Resend, so
      // the latest email is always the one that works.
      role = liveRole
      const lastSent = typeof live.lastSentAt === 'string' ? Date.parse(live.lastSentAt) : 0
      if (lastSent && Date.now() - lastSent < INVITE_RESEND_COOLDOWN_MS) {
        // Emailed moments ago (e.g. a second magazine shared in the same minute).
        // That link is still good and redeeming it claims THIS share too.
        return { invited: true, emailed: false, roleLabel: role.label, keptExistingRole: true }
      }
      await db.collection(INVITES).updateOne(String(live._id), {
        tokenHash: hashInviteToken(token),
        expiresAt: inviteExpiry(now),
        lastSentAt: now.toISOString(),
        redirectTo: sanitizeRedirect(opts.magazinePath),
      })
    } else {
      if (!opts.role) return { invited: false, emailed: false, error: `Choose which role ${email} should join with.` }
      role = opts.role
      const doc = {
        email,
        role: role.name,
        tokenHash: hashInviteToken(token),
        expiresAt: inviteExpiry(now),
        invitedBy: actor.id,
        invitedByName: actorName(actor),
        redirectTo: sanitizeRedirect(opts.magazinePath),
        lastSentAt: now.toISOString(),
        createdAt: now.toISOString(),
      }
      // An expired row for this address is refreshed in place, not duplicated —
      // same rule as POST /api/staff. A row whose role was deleted counts as dead.
      const stale = rows.find((r) => r.role === role!.name) ?? (live && !liveRole ? live : undefined)
      if (stale) await db.collection(INVITES).updateOne(String(stale._id), doc)
      else await db.collection(INVITES).insertOne(doc)
    }

    // The invite row is written; from here a failure is a delivery problem only
    // (fixable with Team › Resend), never "not invited".
    try {
      const { delivered } = await sendMagazineInviteEmail({
        to: email,
        magazineTitle: opts.magazineTitle,
        sharedBy: actorName(actor),
        acceptUrl: inviteUrl(WEB_PUBLIC_URL, token),
        scope: opts.scope,
        roleLabel: role.label,
        expiresIn: expiresInLabel(),
      })
      const kept = live && liveRole ? { keptExistingRole: true } : {}
      return delivered
        ? { invited: true, emailed: true, roleLabel: role.label, ...kept }
        : { invited: true, emailed: false, roleLabel: role.label, ...kept, error: 'No email provider is configured on the server.' }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      console.error('[share] magazine invite email failed:', error)
      return { invited: true, emailed: false, roleLabel: role.label, error }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.error('[share] magazine invite failed:', error)
    return { invited: false, emailed: false, error }
  }
}
