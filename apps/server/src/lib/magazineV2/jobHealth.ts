// ---------------------------------------------------------------------------
// Magazine Builder v2 — is this job alive?
//
// TWO WATCHDOGS ASK THIS QUESTION, and until now they each answered it their own
// way from the same weak evidence: how long ago the job STARTED. That is fine for
// a job with a predictable runtime and actively harmful for one without.
//
// The failure it caused is worth stating, because removing the page caps would
// have made it routine. A long document read is killed BY THE STUDIO WATCHING IT:
//
//   1. the studio polls GET /issues/:id for reading progress
//   2. healStuckIssue sees a job running longer than any job "should" take
//   3. it retires the job and marks the issue failed
//   4. the worker is still reading, oblivious, and chains generation into a
//      failed issue
//
// The polling that displays progress is what destroys the run. Start time cannot
// tell "working for an hour" from "dead for an hour", so a job that legitimately
// takes hours is indistinguishable from a crashed one.
//
// A HEARTBEAT can tell them apart. A job that writes `lastBeatAt` as it works is
// alive however long it runs; one that stops writing is dead within minutes. That
// makes the watchdogs both SAFER (no false kill of a live job) and FASTER (a real
// death is caught in minutes instead of 45), and it is the same mechanism the
// scalability review names as the prerequisite for ever running a second worker —
// with beats, an idle worker's sweep can tell another worker's live job apart
// from an abandoned one.
//
// Pure on purpose: both callers (the worker's sweep and the API's heal-on-read)
// import the same decision, so they cannot drift, and it is testable with no db.
// ---------------------------------------------------------------------------

/** The fields of a job row this decision reads. Loose on purpose — both callers
 *  hold untyped documents from the shared db wrapper. */
export interface JobLiveness {
  startedAt?: unknown;
  updatedAt?: unknown;
  createdAt?: unknown;
  /** Written by a long-running handler as it works. Absent on jobs that predate
   *  heartbeats, and on short ones that never needed to beat. */
  lastBeatAt?: unknown;
}

/**
 * How long a BEATING job may be silent before it is presumed dead.
 *
 * Small, and that is the point: a handler that beats every ~15s and has said
 * nothing for 5 minutes is genuinely gone. This is a tighter bound than the old
 * 45-minute rule AND cannot fire on a job that is merely slow.
 */
export const NO_BEAT_MS = 5 * 60_000;

/**
 * How long a job with NO beat at all may run before it is presumed dead.
 *
 * Has to stay generous, because for these jobs we are back to guessing from start
 * time: a 24-page generation legitimately runs ~30 minutes. Every long-running
 * handler should beat so it uses NO_BEAT_MS instead of this.
 */
export const NO_BEAT_GRACE_MS = 45 * 60_000;

function parseMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** The most recent moment this job gave any sign of life, or null if it never did. */
export function lastSignOfLife(job: JobLiveness): number | null {
  return parseMs(job.lastBeatAt) ?? parseMs(job.startedAt) ?? parseMs(job.updatedAt) ?? parseMs(job.createdAt);
}

/** True when the job has a heartbeat, so the tighter rule applies to it. */
export function isBeating(job: JobLiveness): boolean {
  return parseMs(job.lastBeatAt) !== null;
}

/**
 * Is this job presumed dead as of `nowMs`?
 *
 * A job that beats is judged on its beat; one that never beat is judged on start
 * time under a long grace. A job with no parseable timestamp at all returns FALSE
 * — refusing to judge is right, because the alternative is reaping a job we know
 * nothing about, and the cost of a false kill (a user's work discarded mid-flight)
 * is far worse than the cost of a stuck row surviving one more sweep.
 */
export function jobIsPresumedDead(
  job: JobLiveness,
  nowMs: number,
  opts?: { noBeatMs?: number; graceMs?: number },
): boolean {
  const sign = lastSignOfLife(job);
  if (sign === null) return false;
  const limit = isBeating(job) ? (opts?.noBeatMs ?? NO_BEAT_MS) : (opts?.graceMs ?? NO_BEAT_GRACE_MS);
  return nowMs - sign > limit;
}

/** For a log line or an error message: how long since this job last spoke. */
export function silentForMs(job: JobLiveness, nowMs: number): number | null {
  const sign = lastSignOfLife(job);
  return sign === null ? null : Math.max(0, nowMs - sign);
}

// ── Keeping generation alive, and what a dead one leaves behind ─────────────
//
// THE GAP THIS CLOSES. Generation ('generateIssue', 'generatePages') never beat,
// so it stayed on the 45-minute grace above. A deploy that restarted the worker
// while it was adding pages left the job 'running' and the magazine 'processing'
// for three quarters of an hour — the studio showing "Designing pages" and
// refusing publish and page edits all that time — and then the watchdog marked a
// perfectly good 'ready' or 'published' magazine 'failed'.
//
// Two changes, both decided here so the worker's sweep and the API's heal-on-read
// cannot disagree:
//   1. The worker keeps these jobs alive with a TIMER while the handler's promise
//      is pending (queue.ts). Generation is I/O-bound — model calls — so the event
//      loop is free and the timer fires as long as the process lives; a dead
//      process stops beating at once and is caught in NO_BEAT_MS. Beating per
//      composed page instead could go quiet for longer than NO_BEAT_MS on one slow
//      page and be reaped while alive. CPU-bound extraction (MuPDF blocks the loop)
//      is deliberately NOT on the list: a timer there could not fire while a big
//      page rasterises, which is the false kill this whole file exists to avoid.
//   2. A dead 'add pages' job puts the magazine back the way it was. The pages it
//      was adding are only inserted at the very end of the run, so an interrupted
//      run has changed nothing worth failing the whole magazine over.

/** Job types the worker keeps alive with a timer for as long as their handler runs. */
export const KEEP_ALIVE_JOB_TYPES: readonly string[] = ['generateIssue', 'generatePages'];

export function keptAliveByTimer(type: unknown): boolean {
  return typeof type === 'string' && KEEP_ALIVE_JOB_TYPES.includes(type);
}

/**
 * How long the API's heal-on-read lets a BEATING job stay silent.
 *
 * Twice the worker's NO_BEAT_MS on purpose. A worker that restarted mid-job sweeps
 * at NO_BEAT_MS and REQUEUES the job (it still has attempts left), which is the
 * better outcome — the work is retried. The API is the backstop for a worker that
 * is down altogether, so it should not win that race and throw the retry away.
 */
export const API_NO_BEAT_MS = 2 * NO_BEAT_MS;

/** What the magazine says when an interrupted "add pages" run is given up on. */
export const ADD_PAGES_INTERRUPTED = 'Adding pages was interrupted. Please try again.';

const RESTORABLE_STATUSES = ['ready', 'draft', 'published'];

/**
 * The fields a 'processing' magazine is given when the job working on it is given
 * up on (abandoned by the sweep, retired by the API watchdog, or out of attempts).
 *
 * An "add pages" job carries the status the magazine had before (`prevStatus`),
 * and the magazine goes back to it — a published magazine stays published — with
 * a processingError the studio shows as a toast. Anything else (an import, a
 * from-scratch build) has no previous state worth restoring and is 'failed', as
 * before. Callers write this guarded on `status: 'processing'`.
 */
export function issueStatusAfterDeadJob(
  job: Record<string, unknown> | null | undefined,
  failMessage: string,
): { status: string; stage: string; processingError: string } {
  if (job?.type === 'generatePages') {
    const prev = (job.payload as { prevStatus?: unknown } | undefined)?.prevStatus;
    const status = typeof prev === 'string' && RESTORABLE_STATUSES.includes(prev) ? prev : 'ready';
    return { status, stage: '', processingError: ADD_PAGES_INTERRUPTED };
  }
  return { status: 'failed', stage: '', processingError: failMessage };
}

/**
 * The fields that put a job back in the queue.
 *
 * `startedAt` is reset and `lastBeatAt` cleared because both watchdogs judge a
 * QUEUED job too: left as they were, a job requeued after a crash still carries
 * the dead run's last beat, so the API's heal-on-read would see "beating job,
 * silent for minutes" and fail the magazine while the job sat waiting for its
 * retry. Null rather than absent because the db wrapper only $sets; a null
 * lastBeatAt reads as "never beat" (lastSignOfLife ignores non-strings).
 */
export function requeuedJobFields(
  nowIso: string,
  lastError: string,
): { status: 'queued'; lastError: string; startedAt: string; lastBeatAt: null; updatedAt: string } {
  return { status: 'queued', lastError, startedAt: nowIso, lastBeatAt: null, updatedAt: nowIso };
}
