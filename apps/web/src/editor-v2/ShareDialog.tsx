// Magazine Builder v2 — Share dialog.
//
// TWO decisions: which staff member, and WHICH PAGES they get. The page scope is
// not decoration — it is the input to the whole review workflow. A page counts as
// "in review scope" only when somebody is assigned to it (server:
// access.isInReviewScope), and the publish gate demands approval for exactly
// those pages. Share everything with everyone and every page needs approving; a
// solo owner with no collaborators needs none.
//
// SOMEONE NOT ON THE TEAM YET can be shared with by typing their email. The
// server saves the share as PENDING and emails them an invite; when they accept
// it they join the team and the pages are theirs — nobody has to share again.
// Pending people are listed under "People with access" until they join. The
// owner CHOOSES the role they join with (from the roles they may give): joining
// through a share is still joining the team, so it's never guessed.
//
// A share grants ONE capability: edit these pages, and submit them for approval.
// There is no per-magazine role to choose — publishing is a staff permission
// (`magazine.publish`, enforced on the publish routes) and belongs to the owner,
// not to a share. Owner-only.

import { useEffect, useMemo, useState } from 'react';
import { X, Users, Pencil, Trash2, AlertTriangle, Check, Mail } from 'lucide-react';
import { toast } from 'sonner';
import { useEditorStore } from './store';
import { ShimmerText } from './BuildProgress';
import * as api from './api';
import type { StaffEntry, PageSummary, V2Collaborator, PendingCollaborator, InviteRoleOption } from './api';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** "page 4" · "pages 4 and 5" · "pages 4, 5 and 9". Mirrors the server's
 *  lib/pageLabels.ts so the dialog names pages the way the emails do. */
function pageListLabel(numbers: number[]): string {
  const n = Array.from(new Set(numbers)).sort((a, b) => a - b);
  if (n.length === 0) return 'no pages';
  if (n.length === 1) return `page ${n[0]}`;
  return `pages ${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
}

/** A page-number chip grid, used for both a new share and an existing one. */
function PagePicker({
  pages,
  picked,
  onToggle,
  onAll,
  onNone,
  agentPrefix,
}: {
  pages: PageSummary[];
  picked: Set<string>;
  onToggle: (id: string) => void;
  onAll: () => void;
  onNone: () => void;
  /** Operator anchor prefix — 'mag.share' (new share) or 'mag.share-edit'. */
  agentPrefix: string;
}) {
  return (
    <div className="mb-2">
      <div className="mb-1 flex items-center gap-2 text-ui-sm text-studio-ink-3">
        <span>
          {picked.size} of {pages.length} selected
        </span>
        <button type="button" onClick={onAll} data-agent-id={`${agentPrefix}-pages-all`} className="ml-auto rounded-sm px-1 py-0.5 hover:bg-studio-raise-2 hover:text-studio-ink-2">
          Select all
        </button>
        <button type="button" onClick={onNone} data-agent-id={`${agentPrefix}-pages-clear`} className="rounded-sm px-1 py-0.5 hover:bg-studio-raise-2 hover:text-studio-ink-2">
          Clear
        </button>
      </div>
      <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto rounded-sm border border-studio-hair bg-black/20 p-1.5">
        {pages.map((p) => {
          const on = picked.has(p.id);
          // A page already in review carries a dot, so narrowing a scope can't
          // silently strip somebody off work that is mid-flight.
          const dot =
            p.review === 'approved' ? 'bg-emerald-400' : p.review === 'submitted' ? 'bg-amber-400' : '';
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onToggle(p.id)}
              data-agent-id={`${agentPrefix}-page-${p.index + 1}`}
              data-agent-label={`Page ${p.index + 1}`}
              aria-pressed={on}
              className={
                'relative rounded-sm border px-2 py-1 text-ui-sm tabular-nums ' +
                (on ? 'border-studio-gold bg-studio-gold/15 text-studio-gold' : 'border-studio-edge text-studio-ink-3 hover:bg-studio-raise-2')
              }
            >
              {p.index + 1}
              {dot && <span className={`absolute right-0.5 top-0.5 h-1 w-1 rounded-full ${dot}`} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ShareDialog({ onClose }: { onClose: () => void }) {
  const issue = useEditorStore((s) => s.issue);
  const issueId = useEditorStore((s) => s.issueId);
  const pages = useEditorStore((s) => s.pages);
  const refreshIssue = useEditorStore((s) => s.refreshIssue);

  const [directory, setDirectory] = useState<StaffEntry[]>([]);
  // The picker used to swallow its fetch error and fall through to "everyone
  // already has access" — a lie whenever the request simply failed (and it had
  // been failing: the endpoint it called died with the v1 magazines router).
  // Load state is tracked so an empty list can say WHY it's empty.
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedEmail, setSelectedEmail] = useState('');
  // Someone not in the staff list — typed in. Takes precedence over the picker.
  const [inviteEmail, setInviteEmail] = useState('');
  // The role a new person joins with — the owner's choice, loaded on first use.
  const [inviteRole, setInviteRole] = useState('');
  const [roleOpts, setRoleOpts] = useState<{ canInvite: boolean; roles: InviteRoleOption[] } | null>(null);
  const [roleOptsError, setRoleOptsError] = useState('');
  const [pageMode, setPageMode] = useState<'all' | 'pick'>('all');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  // Which existing collaborator's scope is being edited, and the draft of it.
  const [editing, setEditing] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<'all' | 'pick'>('all');
  const [editPicked, setEditPicked] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');
    api
      .staffDirectory()
      .then((list) => {
        if (cancelled) return;
        setDirectory(Array.isArray(list) ? list : []);
        setLoadState('ready');
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : 'Could not load the staff list.');
        setLoadState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const collaborators = issue?.collaborators ?? [];
  const pendingPeople = issue?.pendingCollaborators ?? [];

  // Staff who aren't already the owner or a collaborator — the owner already has
  // the magazine, and collaborators are listed above with a Remove button.
  const candidates = useMemo(
    () => directory.filter((o) => o.userId !== issue?.ownerId && !collaborators.some((c) => c.userId === o.userId)),
    [directory, issue?.ownerId, collaborators],
  );

  const numberOf = useMemo(() => new Map(pages.map((p) => [p.id, p.index + 1])), [pages]);
  const toggleIn = (set: (fn: (prev: Set<string>) => Set<string>) => void) => (id: string) =>
    set((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const scopeLabel = (c: Pick<V2Collaborator, 'pageIds'>) =>
    c.pageIds === 'all'
      ? 'all pages'
      : pageListLabel(c.pageIds.map((id) => numberOf.get(String(id))).filter((n): n is number => !!n));

  /** Pages this person has in review that a narrowed scope would take away from
   *  them. Worth naming BEFORE the save, not apologising for after it. */
  const strandedBy = (userId: string, keep: Set<string> | 'all') => {
    if (keep === 'all') return [];
    return pages
      .filter((p) => !keep.has(p.id) && p.submittedBy === userId && (p.review === 'submitted' || p.review === 'approved'))
      .map((p) => p.index + 1);
  };

  /** Who the Share button acts on: a typed address wins over the picker. */
  const typed = inviteEmail.trim().toLowerCase();
  const target = typed || selectedEmail;
  // A typed address that is already staff is an ordinary share — no role to pick.
  const typedIsStaff = !!typed && directory.some((d) => d.email.toLowerCase() === typed);
  const wantsRole = !!typed && !typedIsStaff;
  const chosenRole = roleOpts?.roles.find((r) => r.name === inviteRole);
  // Already invited through a share: their invitation carries its role, so changing
  // their pages needs none. (If that invitation has lapsed the server says so and
  // asks for one — the picker stays visible for exactly that case.)
  const typedIsPending = !!typed && pendingPeople.some((p) => p.email.toLowerCase() === typed);
  const roleMissing = wantsRole && !typedIsPending && !!roleOpts?.canInvite && !inviteRole;

  // Load the role list the first time someone types a new address.
  const needRoles = wantsRole && !roleOpts && !roleOptsError;
  useEffect(() => {
    if (!needRoles || !issueId) return;
    let cancelled = false;
    api
      .inviteRoles(issueId)
      .then((r) => {
        if (!cancelled) setRoleOpts(r);
      })
      .catch((e) => {
        if (!cancelled) setRoleOptsError(e instanceof Error ? e.message : 'Could not load the roles.');
      });
    return () => {
      cancelled = true;
    };
  }, [needRoles, issueId]);

  const share = async () => {
    if (!issueId || !target) return;
    if (typed && !EMAIL_RE.test(typed)) {
      toast.error('That doesn’t look like an email address.');
      return;
    }
    if (roleMissing) {
      toast.error(`Choose the role ${typed} should join with.`);
      return;
    }
    if (pageMode === 'pick' && picked.size === 0) {
      toast.error('Pick at least one page to share.');
      return;
    }
    const pageIds: string[] | 'all' = pageMode === 'all' ? 'all' : Array.from(picked);
    setBusy(true);
    try {
      const { emailed, emailError, warning, pending, invited, roleLabel, keptExistingRole, updated } = await api.addCollaborator(issueId, {
        email: target,
        pageIds,
        ...(wantsRole && inviteRole ? { role: inviteRole } : {}),
      });
      // The share is committed; this only re-reads the list that renders it. When the
      // re-read fails the person DOES have access but their row won't appear — say so,
      // rather than leaving a dialog that looks like the share didn't take.
      if (!(await refreshIssue())) toast.message('Shared — the list below may be a moment behind. Reopen this dialog to refresh it.');
      const shared = target;
      const what = pageIds === 'all' ? 'this magazine' : pageListLabel(Array.from(picked).map((id) => numberOf.get(id) ?? 0));
      setSelectedEmail('');
      setInviteEmail('');
      setInviteRole('');
      setPicked(new Set());
      setPageMode('all');
      if (pending) {
        // Not on the team yet: the share is saved and waits for them to join.
        if (updated) toast.success(`${shared} will get ${what} when they join.`);
        else if (!invited) toast.warning(`Saved — ${shared} will get ${what} when they join. ${emailError ?? ''}`.trim(), { duration: 12000 });
        else if (emailed) toast.success(`Invited ${shared}${roleLabel ? ` as ${roleLabel}` : ''}. They'll get ${what} as soon as they accept.`, { duration: 8000 });
        else if (emailError) toast.warning(`${shared} is invited and will get ${what} when they join, but the email didn't send: ${emailError}`, { duration: 10000 });
        else toast.success(`${shared} already has an invitation waiting — they'll get ${what} as soon as they accept it.`, { duration: 8000 });
        // An invitation someone else sent keeps its role; say which, so the owner
        // isn't left believing their pick applied.
        if (keptExistingRole && roleLabel) toast.message(`They were already invited as ${roleLabel}, so that role stands. Change it from Team if needed.`, { duration: 10000 });
        if (warning) toast.warning(warning, { duration: 12000 });
        return;
      }
      // The share is done either way — be explicit when no link was sent, and show
      // WHY (provider rejection / not configured) so it's fixable, not a mystery.
      if (emailed === false) {
        toast.warning(`${shared} now has ${what}, but the email didn't send${emailError ? `: ${emailError}` : '.'}`, { duration: 8000 });
      } else {
        toast.success(`${shared} now has ${what} and was emailed a link.`);
      }
      // Their ROLE can't use what was just shared (no magazine view/edit) — they'd
      // find out the first time they added a photo. The owner hears it now instead.
      if (warning) toast.warning(warning, { duration: 12000 });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not share this magazine.');
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (c: V2Collaborator) => {
    setEditing(c.userId);
    setEditMode(c.pageIds === 'all' ? 'all' : 'pick');
    setEditPicked(new Set(c.pageIds === 'all' ? [] : c.pageIds.map(String)));
  };

  /** Re-sharing the same person is an UPSERT server-side, and the share email
   *  only goes out the first time — so this changes the scope without spamming. */
  const saveScope = async (c: V2Collaborator) => {
    if (!issueId) return;
    if (editMode === 'pick' && editPicked.size === 0) {
      toast.error('Pick at least one page, or remove their access instead.');
      return;
    }
    const pageIds: string[] | 'all' = editMode === 'all' ? 'all' : Array.from(editPicked);
    setBusy(true);
    try {
      await api.addCollaborator(issueId, { email: c.email, pageIds });
      if (!(await refreshIssue())) toast.message('Saved — the list below may be a moment behind.');
      setEditing(null);
      const who = c.displayName || c.email;
      toast.success(`${who} now has ${pageIds === 'all' ? 'all pages' : pageListLabel(Array.from(editPicked).map((id) => numberOf.get(id) ?? 0))}.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not change their pages.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (userId: string, name: string) => {
    if (!issueId) return;
    try {
      await api.removeCollaborator(issueId, userId);
      const fresh = await refreshIssue();
      toast.success(`Removed ${name}.${fresh ? '' : ' (The list below may be a moment behind.)'}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not remove access.');
    }
  };

  const removePending = async (p: PendingCollaborator) => {
    if (!issueId) return;
    try {
      await api.removePendingCollaborator(issueId, p.email);
      const fresh = await refreshIssue();
      toast.success(`Cancelled the share with ${p.email}.${fresh ? '' : ' (The list below may be a moment behind.)'}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not cancel that share.');
    }
  };

  return (
    <div className="fixed inset-stablehand z-[70] flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-md border border-studio-hair bg-studio-panel text-studio-ink shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Share this magazine"
        data-agent-id="mag.share-dialog"
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-studio-hair px-4 py-3">
          <Users size={16} className="text-studio-gold" />
          <div className="min-w-0">
            <p className="text-ui font-bold">Share this magazine</p>
            <p className="truncate text-ui-sm text-studio-ink-3">Choose who, and which pages they may edit</p>
          </div>
          <button onClick={onClose} data-agent-id="mag.share-close" className="ml-auto rounded-sm p-1 text-studio-ink-3 hover:bg-studio-raise-2 hover:text-studio-ink" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {/* Current collaborators */}
          {(collaborators.length > 0 || pendingPeople.length > 0) && (
            <div className="mb-4">
              <p className="mb-1.5 text-ui-sm font-bold uppercase tracking-[0.12em] text-studio-ink-3">People with access</p>
              {collaborators.map((c) => {
                const isEditing = editing === c.userId;
                const stranded = isEditing ? strandedBy(c.userId, editMode === 'all' ? 'all' : editPicked) : [];
                return (
                  <div key={c.userId} className="rounded-sm">
                    <div
                      className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-ui-sm hover:bg-studio-raise"
                      data-agent-id={`mag.share-collab-${c.userId}`}
                      data-agent-label={`${c.displayName || c.email} · can edit ${scopeLabel(c)}`}
                    >
                      {/* One icon, because there is one kind of collaborator. The
                          shield-vs-pencil "Editor / Contributor" split was removed:
                          it gated nothing anywhere, so it promised powers that did
                          not exist. What a share actually decides is the PAGES. */}
                      <Pencil size={13} className="flex-shrink-0 text-studio-gold" />
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-semibold">{c.displayName || c.email}</span>
                        <span className="text-studio-ink-3"> · can edit {scopeLabel(c)}</span>
                      </span>
                      <button
                        onClick={() => (isEditing ? setEditing(null) : startEdit(c))}
                        data-agent-id={`mag.share-edit-${c.userId}`}
                        data-agent-label={`${isEditing ? 'Cancel changing' : 'Change'} ${c.displayName || c.email}'s pages`}
                        className="flex-shrink-0 rounded-sm px-1.5 py-0.5 text-ui-sm text-studio-ink-3 hover:bg-studio-raise-2 hover:text-studio-ink"
                      >
                        {isEditing ? 'Cancel' : 'Change pages'}
                      </button>
                      <button
                        onClick={() => void remove(c.userId, c.displayName || c.email)}
                        data-agent-id={`mag.share-remove-${c.userId}`}
                        aria-label={`Remove ${c.displayName || c.email}`}
                        className="flex-shrink-0 rounded p-1 text-studio-ink-3 hover:bg-studio-raise-2 hover:text-red-300"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>

                    {isEditing && (
                      <div className="mb-1 ml-5 border-l border-studio-hair pl-3 pt-1">
                        <div className="mb-2 flex items-center gap-3 text-ui-sm text-studio-ink-2">
                          <label className="flex cursor-pointer items-center gap-1.5">
                            <input type="radio" data-agent-id="mag.share-edit-scope-all" data-agent-label="All pages" checked={editMode === 'all'} onChange={() => setEditMode('all')} className="accent-studio-gold" /> All pages
                          </label>
                          <label className="flex cursor-pointer items-center gap-1.5">
                            <input type="radio" data-agent-id="mag.share-edit-scope-pick" data-agent-label="Specific pages" checked={editMode === 'pick'} onChange={() => setEditMode('pick')} className="accent-studio-gold" /> Specific pages
                          </label>
                        </div>
                        {editMode === 'pick' && (
                          <PagePicker
                            pages={pages}
                            picked={editPicked}
                            agentPrefix="mag.share-edit"
                            onToggle={toggleIn(setEditPicked)}
                            onAll={() => setEditPicked(new Set(pages.map((p) => p.id)))}
                            onNone={() => setEditPicked(new Set())}
                          />
                        )}
                        {stranded.length > 0 && (
                          <p className="mb-2 flex items-start gap-1.5 rounded-sm bg-amber-400/10 px-2 py-1.5 text-ui-sm text-amber-200">
                            <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                            <span>
                              They have work in review on {pageListLabel(stranded)}. Taking {stranded.length > 1 ? 'those' : 'that'} away
                              leaves it with you to approve.
                            </span>
                          </p>
                        )}
                        <button
                          onClick={() => void saveScope(c)}
                          data-agent-id="mag.share-edit-save"
                          aria-busy={busy}
                          disabled={busy}
                          className="flex items-center gap-1.5 rounded-sm bg-studio-gold px-2.5 py-1 text-ui-sm font-semibold text-studio-ink hover:bg-studio-gold disabled:opacity-50"
                        >
                          <Check size={12} /> {busy ? <ShimmerText>Saving…</ShimmerText> : 'Save pages'}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
              {/* Invited through a share, not joined yet. Their pages are reserved
                  and become theirs automatically when they accept the invite. */}
              {pendingPeople.map((p) => (
                <div
                  key={p.email}
                  className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-ui-sm hover:bg-studio-raise"
                  data-agent-id={`mag.share-pending-${p.email}`}
                  data-agent-label={`${p.email} · invited, will get ${scopeLabel(p)} when they join`}
                >
                  <Mail size={13} className="flex-shrink-0 text-studio-ink-3" />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-semibold">{p.email}</span>
                    <span className="text-studio-ink-3"> · invited · gets {scopeLabel(p)} when they join</span>
                  </span>
                  <button
                    onClick={() => void removePending(p)}
                    data-agent-id={`mag.share-pending-remove-${p.email}`}
                    aria-label={`Cancel the share with ${p.email}`}
                    className="flex-shrink-0 rounded p-1 text-studio-ink-3 hover:bg-studio-raise-2 hover:text-red-300"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Add a staff member */}
          <p className="mb-1.5 text-ui-sm font-bold uppercase tracking-[0.12em] text-studio-ink-3">Add someone</p>
          {loadState === 'loading' ? (
            <p className="flex items-center gap-1.5 text-ui-sm text-studio-ink-3">
              <ShimmerText>Loading the staff list</ShimmerText>
            </p>
          ) : (
            <>
              {loadState === 'error' ? (
                <div className="mb-2 text-ui-sm text-studio-ink-2">
                  <p className="text-red-300">Couldn&apos;t load the staff list{loadError ? ` — ${loadError}` : '.'}</p>
                  <button
                    onClick={() => setReloadKey((k) => k + 1)}
                    data-agent-id="mag.share-retry"
                    className="mt-1.5 rounded-sm border border-studio-edge px-2 py-1 text-ui-sm text-studio-ink-2 hover:bg-studio-raise-2"
                  >
                    Try again
                  </button>
                </div>
              ) : candidates.length === 0 ? (
                <p className="mb-2 text-ui-sm text-studio-ink-3">
                  {directory.length <= 1
                    ? "You're the only staff member on the team — invite a colleague by email below."
                    : 'Every staff member already has access to this magazine.'}
                </p>
              ) : (
                <select
                  data-agent-id="mag.share-person"
                  data-agent-label="Staff member to share with"
                  value={selectedEmail}
                  onChange={(e) => {
                    setSelectedEmail(e.target.value);
                    if (e.target.value) setInviteEmail('');
                  }}
                  className="mb-2 w-full rounded-sm border border-studio-edge bg-studio-raise px-2 py-2 text-ui-sm text-studio-ink outline-none focus:border-studio-edge-strong"
                >
                  <option value="" className="bg-studio-panel">Choose a staff member…</option>
                  {candidates.map((o) => (
                    <option key={o.userId} value={o.email} className="bg-studio-panel">
                      {o.name || o.email} ({o.email})
                    </option>
                  ))}
                </select>
              )}

              {/* Someone who isn't on the team yet. They're emailed an invite and the
                  share waits for them — no second share needed once they join. */}
              <label className="mb-1 block text-ui-sm text-studio-ink-3" htmlFor="mag-share-invite-email">
                {candidates.length > 0 ? 'Or invite someone new by email' : 'Invite someone by email'}
              </label>
              <input
                id="mag-share-invite-email"
                type="email"
                autoComplete="off"
                data-agent-id="mag.share-invite-email"
                data-agent-label="Email of someone not on the team yet"
                placeholder="name@example.com"
                value={inviteEmail}
                onChange={(e) => {
                  setInviteEmail(e.target.value);
                  if (e.target.value.trim()) setSelectedEmail('');
                }}
                className="mb-2 w-full rounded-sm border border-studio-edge bg-studio-raise px-2 py-2 text-ui-sm text-studio-ink outline-none placeholder:text-studio-ink-4 focus:border-studio-edge-strong"
              />

              {/* The role they join the team with — the owner's call, never a guess. */}
              {wantsRole &&
                (roleOptsError ? (
                  <p className="mb-2 text-ui-sm text-red-300">Couldn&apos;t load the roles — {roleOptsError}</p>
                ) : !roleOpts ? (
                  <p className="mb-2 text-ui-sm text-studio-ink-3">
                    <ShimmerText>Loading roles</ShimmerText>
                  </p>
                ) : !roleOpts.canInvite ? (
                  <p className="mb-2 text-ui-sm leading-relaxed text-studio-ink-3">
                    You can&apos;t invite new people to the team. The share will be saved, and they&apos;ll get it as soon as a team admin
                    invites them.
                  </p>
                ) : roleOpts.roles.length === 0 ? (
                  <p className="mb-2 text-ui-sm leading-relaxed text-studio-ink-3">There&apos;s no role you&apos;re allowed to give, so they can&apos;t be invited from here.</p>
                ) : (
                  <>
                    <label className="mb-1 block text-ui-sm text-studio-ink-3" htmlFor="mag-share-invite-role">
                      Role they join the team with
                    </label>
                    <select
                      id="mag-share-invite-role"
                      data-agent-id="mag.share-invite-role"
                      data-agent-label="Role for the new person"
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value)}
                      className="mb-2 w-full rounded-sm border border-studio-edge bg-studio-raise px-2 py-2 text-ui-sm text-studio-ink outline-none focus:border-studio-edge-strong"
                    >
                      <option value="" className="bg-studio-panel">Choose a role…</option>
                      {roleOpts.roles.map((r) => (
                        <option key={r.name} value={r.name} className="bg-studio-panel">
                          {r.label}
                          {r.canUseMagazines ? '' : ' — can’t edit magazines'}
                        </option>
                      ))}
                    </select>
                    {chosenRole && !chosenRole.canUseMagazines && (
                      <p className="mb-2 flex items-start gap-1.5 rounded-sm bg-amber-400/10 px-2 py-1.5 text-ui-sm text-amber-200">
                        <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                        <span>{chosenRole.label} can&apos;t open or edit magazines, so they won&apos;t be able to work on these pages.</span>
                      </p>
                    )}
                  </>
                ))}

              {/* Page scope */}
              <div className="mb-2 flex items-center gap-3 text-ui-sm text-studio-ink-2">
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input type="radio" data-agent-id="mag.share-scope-all" data-agent-label="All pages" checked={pageMode === 'all'} onChange={() => setPageMode('all')} className="accent-studio-gold" /> All pages
                </label>
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input type="radio" data-agent-id="mag.share-scope-pick" data-agent-label="Specific pages" checked={pageMode === 'pick'} onChange={() => setPageMode('pick')} className="accent-studio-gold" /> Specific pages
                </label>
              </div>
              {pageMode === 'pick' && (
                <PagePicker
                  pages={pages}
                  picked={picked}
                  agentPrefix="mag.share"
                  onToggle={toggleIn(setPicked)}
                  onAll={() => setPicked(new Set(pages.map((p) => p.id)))}
                  onNone={() => setPicked(new Set())}
                />
              )}
              <button
                onClick={() => void share()}
                data-agent-id="mag.share-submit"
                data-agent-label={typed ? 'Invite & share' : 'Share & email link'}
                aria-busy={busy}
                disabled={busy || !target || roleMissing || (wantsRole && !roleOpts && !roleOptsError)}
                className="flex w-full items-center justify-center gap-1.5 rounded-sm bg-studio-gold px-3 py-2 text-ui-sm font-semibold text-studio-ink hover:bg-studio-gold disabled:opacity-50"
              >
                {typed ? <Mail size={13} /> : <Users size={13} />}{' '}
                {busy ? <ShimmerText>Sharing…</ShimmerText> : typed ? <>Invite &amp; share</> : <>Share &amp; email link</>}
              </button>
              <p className="mt-1.5 text-ui-sm leading-relaxed text-studio-ink-4">
                {typed
                  ? "If they're not on the team yet, they're emailed an invite and get these pages as soon as they join."
                  : 'Only pages someone is assigned to need approving before you publish.'}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
