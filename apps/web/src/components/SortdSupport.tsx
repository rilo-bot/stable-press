// ---------------------------------------------------------------------------
// Sortd support: the help-desk widget (AI support chat + "My tickets") for
// every signed-in account. Renders nothing itself; it drives lib/sortd.ts, and
// Sortd's embed.js draws the bubble bottom-left.
//
//   signed in       → get (or reuse) an embed session, load the widget once
//   tab left open   → extend the session 30 min before it expires, so the open
//                     widget keeps working (same session id, nothing reloads)
//   signed out /    → revoke the previous account's session and take the widget
//   account switch    off the page
//
// Signed-out visitors get nothing: Sortd needs a user id and an email.
// ---------------------------------------------------------------------------

import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuthStore } from '@/stores/authStore';
import {
  requestSortdSession,
  revokeSortdSession,
  setSortdNavigator,
  showSortdWidget,
  sortdWidgetAccount,
  storedSortdExpiry,
  unloadSortdWidget,
} from '@/lib/sortd';

/** Extend the session this long before it expires (the server refreshes inside its last hour). */
const KEEPALIVE_LEAD_MS = 30 * 60_000;
/** After a failure (Sortd or our API down), try again this much later. */
const RETRY_MS = 5 * 60_000;
const MIN_DELAY_MS = 60_000;
/** Re-check at least this often. Also keeps under setTimeout's 24.8-day ceiling. */
const MAX_DELAY_MS = 6 * 60 * 60_000;

const clampDelay = (ms: number) => Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, Number.isFinite(ms) ? ms : RETRY_MS));

export function SortdSupport() {
  // An account counts only with a token: a persisted user whose token is gone is signed out.
  const uid = useAuthStore((s) => (s.token ? (s.currentUser?.id ?? null) : null));

  // Deep links from Sortd's answers go through the router (no full page load).
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  useEffect(() => {
    setSortdNavigator((path) => navigateRef.current(path));
    return () => setSortdNavigator(null);
  }, []);

  const prevUid = useRef(uid);
  useEffect(() => {
    // ── Sign-out or account switch: the previous account's session goes. ──
    const prev = prevUid.current;
    prevUid.current = uid;
    if (prev && prev !== uid) {
      if (sortdWidgetAccount() === prev) unloadSortdWidget(); // off the page now, revoked in the background
      else void revokeSortdSession(prev);
    }
    if (!uid) return;

    // ── Signed in: load the widget, then keep its session alive. ──
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => void run(), clampDelay(ms));
    };
    const run = async () => {
      try {
        const session = await requestSortdSession(uid);
        if (cancelled || !session) return; // null = support not offered (not configured / no email)
        // Same session → no-op. A new one (the old was revoked, lapsed while the
        // laptop slept, or the account's details changed) → widget rebuilt on it.
        showSortdWidget(uid, session);
        schedule(Date.parse(session.expiresAt) - Date.now() - KEEPALIVE_LEAD_MS);
      } catch (err) {
        if (cancelled) return;
        console.warn('[sortd] support widget unavailable:', err instanceof Error ? err.message : err);
        schedule(RETRY_MS);
      }
    };
    // Timers are throttled in background tabs and frozen while asleep; catch up
    // as soon as the tab is looked at again.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const exp = storedSortdExpiry(uid);
      if (exp !== null && exp - Date.now() < KEEPALIVE_LEAD_MS) {
        clearTimeout(timer);
        void run();
      }
    };

    void run();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [uid]);

  return null;
}
