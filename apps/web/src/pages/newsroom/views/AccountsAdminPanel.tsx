import { useEffect, useState } from 'react';
import { AlertTriangle, Ban, RotateCcw, Search, ShieldAlert, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAuthStore } from '@/stores/authStore';
import { useAccountsStore, type AccountRow, type AccountStatusFilter } from '@/stores/accountsStore';

/**
 * SUPERADMIN-ONLY account management: every account on the platform (readers
 * included, not just staff), with Deactivate / Restore / Delete permanently.
 *
 * Rendering is gated on `isSuperAdmin` here AND by the caller, but the real gate
 * is the server — `/api/accounts` refuses anyone else.
 */

const STATUS_TABS: { id: AccountStatusFilter; label: string }[] = [
  { id: 'active', label: 'Active' },
  { id: 'deactivated', label: 'Deactivated' },
  { id: 'all', label: 'All' },
];

function shortDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function initials(nameOrEmail: string): string {
  const parts = nameOrEmail.trim().split(/[\s@._-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}

function AccountItem({
  account, isSelf, onDeactivate, onRestore, onPurge, busy,
}: {
  account: AccountRow;
  isSelf: boolean;
  busy: boolean;
  onDeactivate: (a: AccountRow) => void;
  onRestore: (a: AccountRow) => void;
  onPurge: (a: AccountRow) => void;
}) {
  const name = account.name || account.email;
  const deactivated = account.status === 'deactivated';

  return (
    <li className={'px-4 py-3 flex items-start gap-3 ' + (deactivated ? 'bg-muted/20' : '')}>
      <span
        className={
          'flex-shrink-0 w-8 h-8 rounded-full grid place-items-center text-[11px] font-bold ' +
          (deactivated ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary')
        }
      >
        {initials(name)}
      </span>
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="min-w-0">
          <span className="flex items-center gap-2 min-w-0 flex-wrap">
            <span className={'text-sm font-medium truncate ' + (deactivated ? 'text-muted-foreground line-through' : 'text-foreground')}>
              {name}
            </span>
            {deactivated && (
              <span className="text-[10px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded-full bg-destructive/10 text-destructive">
                Deactivated
              </span>
            )}
            {account.isSuperAdmin && (
              <span className="text-[10px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">
                Superadmin
              </span>
            )}
            {!account.isSuperAdmin && account.roleLabel && (
              <span className="text-[10px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
                {account.roleLabel}
              </span>
            )}
            {isSelf && <span className="text-[11px] text-muted-foreground">(you)</span>}
          </span>
          <span className="block text-[13px] text-muted-foreground truncate">{account.email}</span>
          <span className="block text-[12px] text-muted-foreground/70">
            {deactivated
              ? `Deactivated ${shortDate(account.deactivatedAt)}${account.deactivatedByName ? ` by ${account.deactivatedByName}` : ''}`
              : `Joined ${shortDate(account.createdAt)} · last sign-in ${shortDate(account.lastLogin)}`}
          </span>
        </div>

        {!isSelf && (
          <div className="flex items-center gap-3 flex-wrap">
            {deactivated ? (
              <button
                onClick={() => onRestore(account)}
                disabled={busy}
                className="text-[12px] font-semibold text-primary hover:underline flex items-center gap-1 disabled:opacity-40"
              >
                <RotateCcw size={11} /> Restore
              </button>
            ) : (
              <button
                onClick={() => onDeactivate(account)}
                disabled={busy}
                className="text-[12px] font-semibold text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1 disabled:opacity-40"
              >
                <Ban size={11} /> Deactivate
              </button>
            )}
            <button
              onClick={() => onPurge(account)}
              disabled={busy}
              className="text-[12px] font-semibold text-muted-foreground hover:text-destructive transition-colors flex items-center gap-1 disabled:opacity-40"
            >
              <Trash2 size={11} /> Delete permanently
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

export function AccountsAdminPanel() {
  const isSuperAdmin = useAuthStore((s) => s.currentUser?.access?.isSuperAdmin === true);
  const myId = useAuthStore((s) => s.currentUser?.id);
  const { accounts, total, loading, query, status, setQuery, setStatus, fetchAccounts, deactivate, restore, purge } =
    useAccountsStore();

  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState<AccountRow | null>(null);
  const [confirmPurge, setConfirmPurge] = useState<AccountRow | null>(null);
  const [typedEmail, setTypedEmail] = useState('');
  const [working, setWorking] = useState(false);

  // Debounced so each keystroke doesn't hit the server.
  useEffect(() => {
    if (!isSuperAdmin) return;
    const t = setTimeout(() => void fetchAccounts(), 250);
    return () => clearTimeout(t);
  }, [isSuperAdmin, query, status, fetchAccounts]);

  if (!isSuperAdmin) return null;

  const label = (a: AccountRow) => a.name || a.email;

  const onConfirmDeactivate = async () => {
    if (!confirmDeactivate) return;
    setWorking(true);
    const r = await deactivate(confirmDeactivate.userId);
    setWorking(false);
    if (r.ok) {
      toast.success(`${label(confirmDeactivate)} was deactivated.`);
      setConfirmDeactivate(null);
    } else toast.error(r.error ?? 'Could not deactivate the account.');
  };

  const onRestore = async (a: AccountRow) => {
    setBusyId(a.userId);
    const r = await restore(a.userId);
    setBusyId(null);
    if (r.ok) toast.success(r.restoredRole ? `${label(a)} was restored as ${r.restoredRole}.` : `${label(a)} was restored.`);
    else toast.error(r.error ?? 'Could not restore the account.');
  };

  const openPurge = (a: AccountRow) => {
    setTypedEmail('');
    setConfirmPurge(a);
  };

  const emailMatches = !!confirmPurge && typedEmail.trim().toLowerCase() === confirmPurge.email.toLowerCase();

  const onConfirmPurge = async () => {
    if (!confirmPurge || !emailMatches) return;
    setWorking(true);
    const r = await purge(confirmPurge.userId, typedEmail.trim());
    setWorking(false);
    if (r.ok) {
      toast.success(`${label(confirmPurge)} was permanently deleted.`);
      setConfirmPurge(null);
    } else toast.error(r.error ?? 'Could not delete the account.');
  };

  return (
    <div className="space-y-3">
      <div className="border border-border/60 rounded-sm overflow-hidden bg-card">
        <div className="px-4 py-2.5 border-b border-border/40 bg-muted/30 flex items-center gap-2">
          <ShieldAlert size={13} className="text-muted-foreground" />
          <p className="text-[12px] uppercase tracking-[0.12em] font-bold text-muted-foreground">
            All accounts ({total})
          </p>
          <span className="ml-auto text-[11px] text-muted-foreground/70">Only superadmins can see this</span>
        </div>

        <div className="px-4 py-3 border-b border-border/40 flex flex-col sm:flex-row gap-2 sm:items-center">
          <div className="relative flex-1">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or email"
              aria-label="Search accounts"
              className="w-full pl-8 pr-3 py-2 text-sm border border-input rounded-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="flex gap-1" role="tablist" aria-label="Account status">
            {STATUS_TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={status === t.id}
                onClick={() => setStatus(t.id)}
                className={
                  'px-3 py-1.5 text-[12px] font-semibold rounded-sm border transition-colors ' +
                  (status === t.id
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background text-muted-foreground border-border hover:text-foreground')
                }
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {loading && accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">Loading accounts…</p>
        ) : accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">No accounts match.</p>
        ) : (
          <ul className="divide-y divide-border/40">
            {accounts.map((a) => (
              <AccountItem
                key={a.userId}
                account={a}
                isSelf={a.userId === myId}
                busy={busyId === a.userId}
                onDeactivate={setConfirmDeactivate}
                onRestore={onRestore}
                onPurge={openPurge}
              />
            ))}
          </ul>
        )}
        {accounts.length < total && (
          <p className="px-4 py-2 text-[12px] text-muted-foreground border-t border-border/40">
            Showing the first {accounts.length} of {total}. Search to narrow the list.
          </p>
        )}
      </div>

      {/* Deactivate (soft delete) */}
      <Dialog open={!!confirmDeactivate} onOpenChange={(open) => !open && setConfirmDeactivate(null)}>
        <DialogContent className="max-w-md rounded-sm">
          <DialogHeader>
            <DialogTitle>Deactivate {confirmDeactivate && label(confirmDeactivate)}?</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>They are signed out at once and can't sign in again with this email.</p>
                <p>
                  Their role and pending invites are removed. Their bylines, magazines and uploads stay as they
                  are. You can restore the account at any time, and their role comes back with it.
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDeactivate(null)} disabled={working}>
              Cancel
            </Button>
            <Button size="sm" onClick={onConfirmDeactivate} disabled={working}>
              {working ? 'Deactivating…' : 'Deactivate account'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete permanently (hard delete) */}
      <Dialog open={!!confirmPurge} onOpenChange={(open) => !open && !working && setConfirmPurge(null)}>
        <DialogContent className="max-w-md rounded-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle size={16} className="text-destructive" />
              Permanently delete {confirmPurge && label(confirmPurge)}?
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p className="font-medium text-foreground">This cannot be undone.</p>
                <ul className="list-disc pl-5 space-y-1">
                  <li>Their account, comments, reactions, tips, notifications and assistant chats are deleted.</li>
                  <li>Magazines and records they created are handed over to you.</li>
                  <li>They're removed from shared magazines and records. Their name is replaced with "Deleted user" in history.</li>
                  <li>Their email address becomes free to sign up again.</li>
                </ul>
                <p>If you only want to stop them signing in, use Deactivate instead.</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <label htmlFor="purge-confirm-email" className="text-[13px] text-foreground">
              Type <span className="font-mono font-semibold">{confirmPurge?.email}</span> to confirm
            </label>
            <input
              id="purge-confirm-email"
              type="email"
              autoComplete="off"
              value={typedEmail}
              onChange={(e) => setTypedEmail(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-input rounded-sm bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmPurge(null)} disabled={working}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={onConfirmPurge}
              disabled={working || !emailMatches}
            >
              {working ? 'Deleting…' : 'Delete permanently'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
