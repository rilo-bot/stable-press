import { create } from 'zustand';
import { authFetch } from '@/lib/api';

/**
 * One row of the superadmin account list. Mirrors `AccountRow` in
 * apps/server/src/lib/accounts.ts — keep the two in step.
 */
export interface AccountRow {
  userId: string;
  name: string;
  email: string;
  status: 'active' | 'deactivated';
  isAdmin: boolean;
  roleLabel: string | null;
  isSuperAdmin: boolean;
  lastLogin: string | null;
  createdAt: string | null;
  deactivatedAt: string | null;
  deactivatedByName: string | null;
}

export type AccountStatusFilter = 'active' | 'deactivated' | 'all';

interface Result {
  ok: boolean;
  error?: string;
  /** Restore only: the role handed back, when there was one. */
  restoredRole?: string | null;
}

interface AccountsState {
  accounts: AccountRow[];
  total: number;
  loading: boolean;
  query: string;
  status: AccountStatusFilter;
  setQuery: (q: string) => void;
  setStatus: (s: AccountStatusFilter) => void;
  fetchAccounts: () => Promise<void>;
  deactivate: (userId: string) => Promise<Result>;
  restore: (userId: string) => Promise<Result>;
  /** PERMANENT. The server re-checks `confirmEmail` against the account. */
  purge: (userId: string, confirmEmail: string) => Promise<Result>;
}

async function readError(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => null);
  return data?.error ?? fallback;
}

// Drops responses to searches the user has already typed past.
let requestSeq = 0;

export const useAccountsStore = create<AccountsState>((set, get) => ({
  accounts: [],
  total: 0,
  loading: false,
  query: '',
  status: 'active',

  setQuery: (query) => set({ query }),
  setStatus: (status) => set({ status }),

  fetchAccounts: async () => {
    const seq = ++requestSeq;
    set({ loading: true });
    try {
      const { query, status } = get();
      const params = new URLSearchParams({ status, limit: '100' });
      if (query.trim()) params.set('q', query.trim());
      const res = await authFetch(`/api/accounts?${params}`);
      const data = res.ok ? await res.json() : { accounts: [], total: 0 };
      if (seq !== requestSeq) return;
      set({ accounts: data.accounts ?? [], total: data.total ?? 0, loading: false });
    } catch {
      if (seq === requestSeq) set({ loading: false });
    }
  },

  deactivate: async (userId) => {
    try {
      const res = await authFetch(`/api/accounts/${userId}/deactivate`, { method: 'POST' });
      if (!res.ok) return { ok: false, error: await readError(res, 'Could not deactivate the account.') };
      await get().fetchAccounts();
      return { ok: true };
    } catch {
      return { ok: false, error: 'Network error. Please try again.' };
    }
  },

  restore: async (userId) => {
    try {
      const res = await authFetch(`/api/accounts/${userId}/restore`, { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (!res.ok) return { ok: false, error: data?.error ?? 'Could not restore the account.' };
      await get().fetchAccounts();
      return { ok: true, restoredRole: data?.restoredRole ?? null };
    } catch {
      return { ok: false, error: 'Network error. Please try again.' };
    }
  },

  purge: async (userId, confirmEmail) => {
    try {
      const res = await authFetch(`/api/accounts/${userId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmEmail }),
      });
      if (!res.ok) return { ok: false, error: await readError(res, 'Could not delete the account.') };
      await get().fetchAccounts();
      return { ok: true };
    } catch {
      return { ok: false, error: 'Network error. Please try again.' };
    }
  },
}));
