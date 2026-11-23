// ---------------------------------------------------------------------------
// Turn every pending magazine share addressed to this person into a real
// collaborator row. See ./pendingShares.ts for why pending shares exist.
//
// CALL ONLY ONCE THE PERSON IS STAFF. A collaborator must be an admin account
// (POST /issues/:id/collaborators refuses anyone else), and this is the other
// door onto that same array. Every caller runs it straight after a role has been
// applied (invite redeemed, role granted) or from a staff-gated route.
//
// NEVER THROWS. It runs inside sign-in and role-grant responses whose own work is
// already committed; a failure here is logged and retried naturally by the next
// claim point (the magazine list claims too), never turned into a 500.
// ---------------------------------------------------------------------------

import { db } from '../db.js';
import { COL } from './collections.js';
import { normalizeEmail, planClaim } from './pendingShares.js';

/** Returns the ids of the magazines the person was added to. */
export async function claimPendingShares(user: { id: string; email: string; name?: string }): Promise<string[]> {
  const email = normalizeEmail(user.email);
  if (!user.id || !email) return [];
  try {
    const docs = await db.collection(COL.magazines).find({ 'pendingCollaborators.email': email });
    const claimed: string[] = [];
    for (const doc of docs) {
      const plan = planClaim(doc, { id: user.id, email, name: user.name });
      if (!plan) continue;
      // Conditional on the pending row still being there, so two concurrent claims
      // (invite redeem + a magazine-list load in another tab) cannot both append.
      const won = await db.collection(COL.magazines).updateOneIf(
        String(doc._id),
        { 'pendingCollaborators.email': email },
        { ...plan, updatedAt: new Date().toISOString() },
      );
      if (won && doc.ownerId !== user.id) claimed.push(String(doc._id));
    }
    if (claimed.length > 0) console.log(`[share] ${email} joined — added to ${claimed.length} magazine(s) shared before they had an account`);
    return claimed;
  } catch (err) {
    console.error('[share] claiming pending magazine shares failed:', err instanceof Error ? err.message : err);
    return [];
  }
}
