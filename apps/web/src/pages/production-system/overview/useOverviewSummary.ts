/**
 * The Overview's data: one role-scoped aggregate (`/api/newsroom/summary`) and
 * one short AI narration of it (`/api/newsroom/brief`).
 *
 * `/summary` also returns the caller's capability list. The Overview no longer
 * reads it: the old "Quick actions" grid built eight buttons from it, three of
 * which navigated to screens that no longer exist, and the other five duplicated
 * sidebar rows. The list is still the Stablehand's source of truth server-side
 * (lib/agent/capabilities.ts) — it just isn't a second navigation surface.
 */
import { useCallback, useEffect, useState } from 'react';

import { apiUrl } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';

export interface AttentionItem {
  id: string;
  label: string;
  count: number;
  /** A nav token — resolve it through `resolveWhere`, never `pathForModule`. */
  where: string;
}

export interface OverviewSummary {
  generatedFor: { name: string; roles: string[] };
  stories: { total: number; mine: number; live: number; byStatus: Record<string, number> };
  needsAttention: AttentionItem[];
  snapshot: {
    horses: number;
    unverifiedHorses: number;
    parties: number;
    unverifiedParties: number;
    articlesLive: number;
    upcomingRaces: number;
    issues: number;
    issuesInProgress: number;
  };
}

function authHeaders(): HeadersInit {
  const token = useAuthStore.getState().token;
  return token
    ? { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    : { 'content-type': 'application/json' };
}

/**
 * The last brief each reader saw this session. Coming back to the Overview shows it
 * at once instead of a loading state; the request that follows is cheap, because
 * the server reuses the brief while the numbers are unchanged
 * (server lib/newsroomBriefCache.ts) and writes a new one only when they changed.
 */
const lastBrief = new Map<string, string>();

function readerId(): string {
  return useAuthStore.getState().currentUser?.id ?? '';
}

export function useOverviewSummary() {
  const [summary, setSummary] = useState<OverviewSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [brief, setBrief] = useState<string | null>(() => lastBrief.get(readerId()) ?? null);
  const [briefLoading, setBriefLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(apiUrl('/api/newsroom/summary'), { headers: authHeaders() });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setSummary(data.summary);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  /** `refresh` (the Regenerate button) asks for a new brief even when the numbers
   *  have not changed; otherwise the server returns the one it already wrote. */
  const reloadBrief = useCallback(async (refresh = false) => {
    const who = readerId();
    const shown = lastBrief.get(who);
    // A brief already on screen stays put while it is checked; only a first load
    // (or an explicit Regenerate) shows the loading state.
    if (refresh || !shown) setBriefLoading(true);
    try {
      const res = await fetch(apiUrl('/api/newsroom/brief'), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(refresh ? { refresh: true } : {}),
      });
      const data = await res.json();
      const text = typeof data.brief === 'string' ? data.brief : null;
      if (text) lastBrief.set(who, text);
      else lastBrief.delete(who);
      setBrief(text);
    } catch {
      setBrief(shown ?? null);
    } finally {
      setBriefLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    void reloadBrief();
  }, [reload, reloadBrief]);

  return { summary, brief, loading, error, briefLoading, reload, reloadBrief };
}
