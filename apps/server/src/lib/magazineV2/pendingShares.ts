// ---------------------------------------------------------------------------
// Magazine Builder v2 — PENDING shares: a share addressed to someone who is not
// on the team yet.
//
// A collaborator must be staff (see POST /issues/:id/collaborators), so sharing
// with a brand-new address used to dead-end at "No account with that email. Ask
// them to sign up first." — and once they had, the owner had to come back and
// share AGAIN. Now the share is remembered by EMAIL on the magazine
// (`pendingCollaborators`) and turned into a real collaborator row the moment that
// address becomes staff (invite redeemed, or a role granted from Team / Roles).
// See ./claimPendingShares.ts for the DB side.
//
// A pending row grants NOTHING on its own: every access check reads
// `collaborators` (keyed by userId), never this array. It is a note of intent,
// not a permission, which is why it is safe to stage for any address.
//
// Pure — no db import — so the merge/prune rules are unit-testable.
// ---------------------------------------------------------------------------

import type { V2Collaborator } from './access.js';

export interface PendingShare {
  /** Lower-cased, trimmed. The ONLY key: there is no userId yet. */
  email: string;
  pageIds: string[] | 'all';
  /** userId of whoever shared (always the owner at the time). */
  invitedBy: string;
  invitedByName: string;
  createdAt: string;
}

type IssueDoc = { ownerId?: unknown; collaborators?: unknown; pendingCollaborators?: unknown; [k: string]: unknown };

export function normalizeEmail(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

export function pendingSharesOf(doc: IssueDoc): PendingShare[] {
  return Array.isArray(doc.pendingCollaborators) ? (doc.pendingCollaborators as PendingShare[]) : [];
}

/** Insert or replace the pending row for `share.email`. Order is kept stable so the
 *  Share dialog's list doesn't jump when a scope is changed. */
export function upsertPendingShare(list: PendingShare[], share: PendingShare): PendingShare[] {
  const email = normalizeEmail(share.email);
  const row = { ...share, email };
  const at = list.findIndex((p) => normalizeEmail(p.email) === email);
  if (at === -1) return [...list, row];
  // Keep the ORIGINAL createdAt: it is when they were first invited.
  const next = list.slice();
  next[at] = { ...row, createdAt: list[at]!.createdAt || row.createdAt };
  return next;
}

export function withoutPendingShare(list: PendingShare[], email: string): PendingShare[] {
  const e = normalizeEmail(email);
  return list.filter((p) => normalizeEmail(p.email) !== e);
}

/** Same rule as the collaborator prune: drop a deleted page's id from every
 *  page-scoped pending row. Null when nothing referenced it (skip the write). */
export function prunePendingPageId(doc: IssueDoc, pageId: string): PendingShare[] | null {
  let touched = false;
  const next = pendingSharesOf(doc).map((p) => {
    if (p.pageIds === 'all' || !Array.isArray(p.pageIds)) return p;
    if (!p.pageIds.some((id) => String(id) === String(pageId))) return p;
    touched = true;
    return { ...p, pageIds: p.pageIds.filter((id) => String(id) !== String(pageId)) };
  });
  return touched ? next : null;
}

/** Union of two scopes; 'all' wins. */
function mergeScopes(a: string[] | 'all', b: string[] | 'all'): string[] | 'all' {
  if (a === 'all' || b === 'all') return 'all';
  return Array.from(new Set([...a.map(String), ...b.map(String)]));
}

/**
 * What claiming this magazine's pending share means for `user`: the new
 * `collaborators` and `pendingCollaborators` arrays, or null when there is no
 * pending row for their address.
 *
 *   - the owner never becomes their own collaborator (the row is just dropped)
 *   - someone ALREADY a collaborator keeps their row, widened by the pending scope
 *     — the owner asked for both, so neither request is silently lost
 */
export function planClaim(
  doc: IssueDoc,
  user: { id: string; email: string; name?: string },
): { collaborators: V2Collaborator[]; pendingCollaborators: PendingShare[] } | null {
  const email = normalizeEmail(user.email);
  if (!email) return null;
  const pending = pendingSharesOf(doc);
  const mine = pending.filter((p) => normalizeEmail(p.email) === email);
  if (mine.length === 0) return null;
  const rest = pending.filter((p) => normalizeEmail(p.email) !== email);
  const current = Array.isArray(doc.collaborators) ? (doc.collaborators as V2Collaborator[]) : [];
  if (doc.ownerId === user.id) return { collaborators: current, pendingCollaborators: rest };

  const scope = mine.reduce<string[] | 'all'>((acc, p) => mergeScopes(acc, p.pageIds), []);
  const existing = current.find((c) => c.userId === user.id);
  const collaborators = existing
    ? current.map((c) => (c.userId === user.id ? { ...c, pageIds: mergeScopes(c.pageIds, scope) } : c))
    : [...current, { userId: user.id, email, displayName: user.name || email, pageIds: scope }];
  return { collaborators, pendingCollaborators: rest };
}
