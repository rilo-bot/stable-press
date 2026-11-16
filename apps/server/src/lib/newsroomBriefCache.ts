// ---------------------------------------------------------------------------
// The Overview's AI brief — written once, reused while nothing it describes changed.
//
// The Campaign Engine Overview asked the model for a fresh brief on EVERY visit:
// opening the page, coming back to it, reloading. Each visit was a paid AI call,
// and the wording changed under the reader even when the newsroom had not.
//
// A brief is a narration of the reader's role-scoped summary (the numbers the
// Overview shows). So it is kept per reader together with a fingerprint of that
// summary, and reused while:
//   - the summary is the same (any changed number — a story moved, a horse
//     verified — means a new brief), and
//   - it is younger than BRIEF_TTL_MS, and
//   - it is still the same day in New Zealand (it greets "today").
// The Overview's refresh button asks for a new one regardless.
//
// In memory, per server process: a restart or deploy just means one fresh brief per
// reader. Bounded (BRIEF_CACHE_MAX readers, oldest dropped first).
// ---------------------------------------------------------------------------

import crypto from 'crypto'

export const BRIEF_TTL_MS = 6 * 60 * 60 * 1000
export const BRIEF_CACHE_MAX = 500

/** JSON with object keys sorted, so the same numbers always fingerprint the same. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

/** A short fingerprint of what the brief narrates. */
export function briefFingerprint(summary: unknown): string {
  return crypto.createHash('sha256').update(stableStringify(summary)).digest('hex').slice(0, 20)
}

/** The calendar day in New Zealand, YYYY-MM-DD. */
export function nzDay(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)
}

interface Entry {
  brief: string
  fingerprint: string
  at: number
  day: string
}

export class BriefCache {
  private readonly entries = new Map<string, Entry>()
  /** Briefs being written right now, by reader + fingerprint — see getOrWrite. */
  private readonly writing = new Map<string, Promise<string>>()

  /**
   * The kept brief, or a new one from `write`. Requests that arrive while that
   * reader's brief is being written share the one write: two tabs, a double-click on
   * Regenerate, or a page that asks twice on load each cost one AI call, not two.
   * `refresh` skips the kept brief (a new one is wanted) but still shares a write in
   * progress — that one is new too. A failed write is not kept and rejects every
   * waiter, so the next visit simply tries again.
   */
  async getOrWrite(
    userId: string,
    fingerprint: string,
    write: () => Promise<string>,
    refresh = false,
  ): Promise<{ brief: string; cached: boolean }> {
    if (!refresh) {
      const kept = this.get(userId, fingerprint)
      if (kept) return { brief: kept, cached: true }
    }
    const key = `${userId}\n${fingerprint}`
    let pending = this.writing.get(key)
    if (!pending) {
      pending = write().then((text) => {
        const brief = String(text ?? '').trim()
        if (brief) this.set(userId, fingerprint, brief)
        return brief
      })
      this.writing.set(key, pending)
      const done = () => {
        if (this.writing.get(key) === pending) this.writing.delete(key)
      }
      pending.then(done, done)
    }
    return { brief: await pending, cached: false }
  }

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = BRIEF_TTL_MS,
    private readonly max = BRIEF_CACHE_MAX,
  ) {}

  /** The kept brief for this reader, if it still describes this summary today. */
  get(userId: string, fingerprint: string): string | null {
    const e = this.entries.get(userId)
    if (!e) return null
    const t = this.now()
    if (e.fingerprint !== fingerprint || t - e.at > this.ttlMs || nzDay(t) !== e.day) return null
    return e.brief
  }

  set(userId: string, fingerprint: string, brief: string): void {
    const t = this.now()
    this.entries.delete(userId) // re-insert: the Map's order is then oldest-first
    this.entries.set(userId, { brief, fingerprint, at: t, day: nzDay(t) })
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  get size(): number {
    return this.entries.size
  }
}
