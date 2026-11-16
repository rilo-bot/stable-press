// ---------------------------------------------------------------------------
// Sortd support widget — browser side. (Server side: apps/server/src/lib/sortd.ts.)
//
// The browser never holds the Sortd API key. It asks our API for an embed
// session and gets back an opaque `sessionId` plus a signed `ticket`. The ticket
// is kept in localStorage per account, so a page load REUSES the session instead
// of minting one, a long-open tab EXTENDS it in place, and sign-out can revoke it.
//
// The widget itself is Sortd's own loader (`<baseUrl>/embed.js`): a floating
// bubble bottom-left, opposite the Stable Hand's bubble bottom-right.
// ---------------------------------------------------------------------------

import { apiUrl, authFetch } from '@/lib/api';

export interface SortdSession {
  baseUrl: string;
  sessionId: string;
  expiresAt: string;
  ticket: string;
}

/** What embed.js puts on `window` (only the parts we use). */
interface SortdSupportApi {
  onNavigate?: (handler: (target: { path: string; label?: string }) => void) => void;
}

declare global {
  interface Window {
    SortdSupport?: SortdSupportApi;
  }
}

// ── Look ──────────────────────────────────────────────────────────────────────
// Hex only (Sortd rejects CSS variables). Values from styles/brand.css + theme.css.
const WIDGET_ATTRS: Record<string, string> = {
  position: 'bottom-left',
  openOnLoad: 'false',
  // The Stable Hand already greets signed-in users; two greetings at once is noise.
  greeting: 'off',
  theme: 'light',
  accent: '#1a3322', // --forest-deep
  font: '"Source Sans 3", sans-serif', // --font-body
};

// ── Ticket storage (per account) ────────────────────────────────────────────

const STORAGE_PREFIX = 'stablepress-sortd:';

interface StoredTicket {
  ticket: string;
  expiresAt: string;
}

function readStored(uid: string): StoredTicket | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + uid);
    const v = raw ? (JSON.parse(raw) as Partial<StoredTicket>) : null;
    return v && typeof v.ticket === 'string' && typeof v.expiresAt === 'string'
      ? { ticket: v.ticket, expiresAt: v.expiresAt }
      : null;
  } catch {
    return null;
  }
}

function writeStored(uid: string, value: StoredTicket): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + uid, JSON.stringify(value));
  } catch {
    /* private mode / storage full: the next load just mints a new session */
  }
}

function forgetStored(uid: string): void {
  try {
    localStorage.removeItem(STORAGE_PREFIX + uid);
  } catch {
    /* ignore */
  }
}

/** When this account's stored session expires (ms), or null if none is stored. */
export function storedSortdExpiry(uid: string): number | null {
  const stored = readStored(uid);
  const t = stored ? Date.parse(stored.expiresAt) : NaN;
  return Number.isFinite(t) ? t : null;
}

// ── Server calls ────────────────────────────────────────────────────────────

/**
 * The signed-in account's embed session (reused, extended or new, the server
 * decides), or null when support isn't offered (Sortd not configured, or the
 * account has no email). Throws on a network or server failure.
 *
 * Concurrent calls for one account share one request, so a double-run effect
 * (React StrictMode) can't mint two sessions for a first visit.
 */
export function requestSortdSession(uid: string): Promise<SortdSession | null> {
  if (inflight?.uid !== uid) {
    const promise = fetchSortdSession(uid).finally(() => {
      if (inflight?.promise === promise) inflight = null;
    });
    inflight = { uid, promise };
  }
  return inflight.promise;
}

let inflight: { uid: string; promise: Promise<SortdSession | null> } | null = null;

async function fetchSortdSession(uid: string): Promise<SortdSession | null> {
  const res = await authFetch('/api/sortd/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket: readStored(uid)?.ticket }),
  });
  if (!res.ok) throw new Error(`Sortd session request failed (HTTP ${res.status})`);
  const data = (await res.json()) as Partial<SortdSession> & { enabled?: boolean };
  if (!data.enabled) {
    forgetStored(uid);
    return null;
  }
  if (
    typeof data.baseUrl !== 'string' ||
    typeof data.sessionId !== 'string' ||
    typeof data.expiresAt !== 'string' ||
    typeof data.ticket !== 'string'
  ) {
    throw new Error('Sortd session response had an unexpected shape');
  }
  writeStored(uid, { ticket: data.ticket, expiresAt: data.expiresAt });
  return { baseUrl: data.baseUrl, sessionId: data.sessionId, expiresAt: data.expiresAt, ticket: data.ticket };
}

/**
 * Revoke the account's stored session at Sortd and forget it (sign-out).
 * Needs no app token, because the browser may have just lost it. Resolves within
 * ~2s either way, since a failed revoke still expires on its own within a day.
 */
export async function revokeSortdSession(uid: string): Promise<void> {
  const stored = readStored(uid);
  forgetStored(uid);
  if (stored) await postRevoke(stored.ticket);
}

async function postRevoke(ticket: string): Promise<void> {
  try {
    await fetch(apiUrl('/api/sortd/session/revoke'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
      keepalive: true,
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    /* best effort */
  }
}

// ── The widget ──────────────────────────────────────────────────────────────
//
// What embed.js builds (read from the loader itself, v1.0.0): ONE container,
// #sortd-support-root, holding the bubble, panel, iframe, toast and greeting.
// It also adds one constructable stylesheet, and `window.SortdSupport` with an
// `__installed` flag that refuses a second install. Its window/document
// listeners all check for its own iframe, so they go inert once it is removed.

/** embed.js's container. */
const ROOT_ID = 'sortd-support-root';
/** What embed.js remembers PER PERSON in this browser (an unread count, "reopen
 *  after a reload"). Cleared on sign-out so the next person doesn't inherit them.
 *  Its UI preferences (sortd_expanded, greeting dismissal) are left alone. */
const LOADER_PERSONAL_KEYS = { local: ['sortd_unread_count'], session: ['sortd_reopen'] };

let loaded: { uid: string; sessionId: string; ticket: string; script: HTMLScriptElement } | null = null;
let routerNavigate: ((path: string) => void) | null = null;

/** The account the widget is currently showing, or null. */
export function sortdWidgetAccount(): string | null {
  return loaded?.uid ?? null;
}

/** In-app navigation for the widget's deep links (the app's router). */
export function setSortdNavigator(fn: ((path: string) => void) | null): void {
  routerNavigate = fn;
}

/**
 * Show the widget for this account's session. Idempotent for the same session.
 * When Sortd handed back a DIFFERENT session (the old one was revoked or lapsed,
 * or the account's name, email or role changed), embed.js can't switch sessions
 * in place, so the widget is rebuilt on the new one and the old one is revoked.
 */
export function showSortdWidget(uid: string, session: SortdSession): void {
  if (loaded && loaded.uid === uid && loaded.sessionId === session.sessionId) {
    loaded.ticket = session.ticket; // a refresh re-signs the ticket
    return;
  }
  if (loaded) {
    const stale = loaded.ticket;
    removeWidget();
    void postRevoke(stale);
  }
  const script = document.createElement('script');
  script.src = `${session.baseUrl}/embed.js`;
  script.async = true;
  script.dataset.sessionId = session.sessionId;
  script.dataset.baseUrl = session.baseUrl;
  for (const [key, value] of Object.entries(WIDGET_ATTRS)) script.dataset[key] = value;
  script.addEventListener('load', wireNavigation);
  script.addEventListener('error', () => console.warn('[sortd] could not load', script.src));
  document.body.appendChild(script);
  loaded = { uid, sessionId: session.sessionId, ticket: session.ticket, script };
}

/** Remove everything embed.js put on the page, so a fresh install can follow. */
function removeWidget(): void {
  document.getElementById(ROOT_ID)?.remove(); // takes the iframe, and its live connection, with it
  loaded?.script.remove();
  loaded = null;
  try {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
      (sheet) => !Array.from(sheet.cssRules).some((rule) => rule.cssText.includes(`#${ROOT_ID}`)),
    );
  } catch {
    /* only styles a now-missing element; harmless if it stays */
  }
  delete window.SortdSupport; // or its __installed guard refuses the next install
  try {
    for (const key of LOADER_PERSONAL_KEYS.local) localStorage.removeItem(key);
    for (const key of LOADER_PERSONAL_KEYS.session) sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/**
 * Deep links from an agent answer ("Settings → Billing") go through the app's
 * router instead of a full page load. Sortd only ever sends a relative path; we
 * check that anyway, since a protocol-relative "//host" would leave the site.
 */
function wireNavigation(): void {
  window.SortdSupport?.onNavigate?.(({ path }) => {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return;
    if (routerNavigate) routerNavigate(path);
    else window.location.assign(path);
  });
}

/**
 * Take the widget off the page and revoke its session (sign-out, or another
 * account signed in). Removal is immediate, so the previous person's support
 * conversation is gone before the next render. The revoke runs in the background.
 */
export function unloadSortdWidget(): void {
  if (!loaded) return;
  const { uid, ticket } = loaded;
  removeWidget();
  forgetStored(uid);
  void postRevoke(ticket);
}
