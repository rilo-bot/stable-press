// ---------------------------------------------------------------------------
// Job liveness — the decision both watchdogs make.
//
// The bug this replaces: liveness was judged from START TIME, which cannot tell
// "working for an hour" from "dead for an hour". Since healStuckIssue runs on
// GET /issues/:id — the endpoint the studio polls to display reading progress —
// watching a long document read was what killed it.
//
// Two properties matter more than any threshold:
//   1. A job that keeps reporting is NEVER presumed dead, however long it runs.
//   2. A job that never reported keeps its long grace, so adding heartbeats
//      cannot make an existing long job (generation) newly reapable.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  jobIsPresumedDead,
  isBeating,
  lastSignOfLife,
  silentForMs,
  NO_BEAT_MS,
  NO_BEAT_GRACE_MS,
  API_NO_BEAT_MS,
  ADD_PAGES_INTERRUPTED,
  KEEP_ALIVE_JOB_TYPES,
  issueStatusAfterDeadJob,
  keptAliveByTimer,
  requeuedJobFields,
} from '../../src/lib/magazineV2/jobHealth.js';

const NOW = Date.parse('2026-08-26T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const MIN = 60_000;

// ── the property that fixes the bug ─────────────────────────────────────────

test('a job that keeps beating is never presumed dead, however long it has run', () => {
  // Six hours of reading, still reporting: alive. Under the old start-time rule
  // this was reaped at 45 minutes, by the studio polling for its progress.
  const job = { startedAt: ago(6 * 60 * MIN), lastBeatAt: ago(20_000) };
  assert.equal(jobIsPresumedDead(job, NOW), false);
});

test('a beating job that goes quiet is caught in minutes, not in an hour', () => {
  const quiet = { startedAt: ago(90 * MIN), lastBeatAt: ago(NO_BEAT_MS + MIN) };
  assert.equal(jobIsPresumedDead(quiet, NOW), true);
  // Faster than the old 45-minute rule: a real death is now caught in ~5 minutes.
  assert.ok(NO_BEAT_MS < NO_BEAT_GRACE_MS);
});

test('a beat just inside the window still counts as alive', () => {
  const job = { startedAt: ago(120 * MIN), lastBeatAt: ago(NO_BEAT_MS - 1_000) };
  assert.equal(jobIsPresumedDead(job, NOW), false);
});

// ── the regression this nearly shipped ──────────────────────────────────────

test('a job that never beat keeps the LONG grace', () => {
  // Generation does not beat internally and legitimately runs ~30 minutes. An
  // earlier draft beat once for every job at claim time, which would have handed
  // generation a lastBeatAt and reaped it after five minutes. A job earns the
  // strict rule by actually reporting, never by merely existing.
  const generating = { startedAt: ago(30 * MIN) };
  assert.equal(isBeating(generating), false);
  assert.equal(jobIsPresumedDead(generating, NOW), false, '30-minute generation must not be reaped');

  const reallyDead = { startedAt: ago(NO_BEAT_GRACE_MS + MIN) };
  assert.equal(jobIsPresumedDead(reallyDead, NOW), true);
});

test('the two rules do not cross over', () => {
  // A silence of 10 minutes: dead for a beating job, alive for a non-beating one.
  const silence = 10 * MIN;
  assert.equal(jobIsPresumedDead({ startedAt: ago(silence), lastBeatAt: ago(silence) }, NOW), true);
  assert.equal(jobIsPresumedDead({ startedAt: ago(silence) }, NOW), false);
});

// ── refusing to judge ───────────────────────────────────────────────────────

test('a job with no usable timestamp is never presumed dead', () => {
  // Refusing to judge is right: the cost of a false kill is a user's work
  // discarded mid-flight, against the cost of one stuck row surviving a sweep.
  for (const job of [{}, { startedAt: '' }, { startedAt: 'not a date' }, { lastBeatAt: null }]) {
    assert.equal(jobIsPresumedDead(job as Record<string, unknown>, NOW), false);
    assert.equal(lastSignOfLife(job as Record<string, unknown>), null);
    assert.equal(silentForMs(job as Record<string, unknown>, NOW), null);
  }
});

test('an unparseable beat falls back to start time rather than being trusted', () => {
  const job = { startedAt: ago(2 * MIN), lastBeatAt: 'garbage' };
  assert.equal(isBeating(job), false, 'a garbage beat is not a beat');
  assert.equal(lastSignOfLife(job), NOW - 2 * MIN);
  assert.equal(jobIsPresumedDead(job, NOW), false);
});

// ── evidence precedence ─────────────────────────────────────────────────────

test('the freshest evidence wins, in the documented order', () => {
  assert.equal(lastSignOfLife({ lastBeatAt: ago(MIN), startedAt: ago(60 * MIN) }), NOW - MIN);
  assert.equal(lastSignOfLife({ startedAt: ago(5 * MIN), updatedAt: ago(MIN) }), NOW - 5 * MIN);
  assert.equal(lastSignOfLife({ createdAt: ago(3 * MIN) }), NOW - 3 * MIN);
});

test('callers may tighten or loosen either threshold', () => {
  const job = { startedAt: ago(20 * MIN), lastBeatAt: ago(7 * MIN) };
  assert.equal(jobIsPresumedDead(job, NOW), true); // default 5 min
  assert.equal(jobIsPresumedDead(job, NOW, { noBeatMs: 10 * MIN }), false);

  const noBeat = { startedAt: ago(50 * MIN) };
  assert.equal(jobIsPresumedDead(noBeat, NOW), true); // default 45 min grace
  assert.equal(jobIsPresumedDead(noBeat, NOW, { graceMs: 90 * MIN }), false);
});

test('silentForMs reports the gap, floored at zero', () => {
  assert.equal(silentForMs({ lastBeatAt: ago(3 * MIN) }, NOW), 3 * MIN);
  // A clock skew that puts the beat in the future must not produce a negative.
  assert.equal(silentForMs({ lastBeatAt: new Date(NOW + 5_000).toISOString() }, NOW), 0);
});

// ── generation keep-alive, requeue, and what a dead "add pages" leaves ─────
//
// The incident: a deploy restarted the worker mid "add pages". Generation never
// beat, so the job sat 'running' on the 45-minute grace with the magazine
// 'processing' (studio frozen on "Designing pages", publish refused), and then the
// watchdog marked a good 'ready'/'published' magazine 'failed'.

test('generation is kept alive by the worker timer; CPU-bound extraction is not', () => {
  assert.equal(keptAliveByTimer('generateIssue'), true);
  assert.equal(keptAliveByTimer('generatePages'), true);
  // MuPDF blocks the event loop while a page rasterises — a timer there could miss
  // its window on one heavy page and get a LIVE job reaped.
  for (const type of ['processIssue', 'processPage', 'copyDocumentPage', 'readSourceDoc', 'renderIssuePdf', 'noop', undefined, 7]) {
    assert.equal(keptAliveByTimer(type), false, String(type));
  }
  assert.deepEqual([...KEEP_ALIVE_JOB_TYPES].sort(), ['generateIssue', 'generatePages']);
});

test('a kept-alive generation run that dies is caught in minutes, not 45', () => {
  // The worker's keep-alive beat stops with the process; NO_BEAT_MS later the run
  // is presumed dead even though it started only a few minutes ago.
  const died = { startedAt: ago(8 * MIN), lastBeatAt: ago(NO_BEAT_MS + 30_000) };
  assert.equal(jobIsPresumedDead(died, NOW), true);
  // …while a live one, beating every half minute, is alive however long it runs.
  assert.equal(jobIsPresumedDead({ startedAt: ago(40 * MIN), lastBeatAt: ago(30_000) }, NOW), false);
});

test('the API watchdog waits longer than the worker sweep for a beating job', () => {
  // The worker requeues a dead run at NO_BEAT_MS (a retry); the API is the
  // backstop for a worker that is down altogether and must not win that race.
  assert.ok(API_NO_BEAT_MS > NO_BEAT_MS);
  assert.ok(API_NO_BEAT_MS < NO_BEAT_GRACE_MS, 'still far faster than the old 45 minutes');
  const silentSix = { startedAt: ago(20 * MIN), lastBeatAt: ago(6 * MIN) };
  assert.equal(jobIsPresumedDead(silentSix, NOW), true, 'worker sweep: requeue');
  assert.equal(jobIsPresumedDead(silentSix, NOW, { noBeatMs: API_NO_BEAT_MS }), false, 'API: not yet');
});

test('a requeued job is judged as a fresh, never-beaten job', () => {
  const stamp = new Date(NOW).toISOString();
  const fields = requeuedJobFields(stamp, 'Requeued after worker restart (silent 6min).');
  assert.equal(fields.status, 'queued');
  assert.equal(fields.startedAt, stamp);
  assert.equal(fields.lastBeatAt, null);
  assert.equal(fields.lastError, 'Requeued after worker restart (silent 6min).');
  // The dead run's stale beat is gone, so the API's heal-on-read does not fail the
  // magazine while the retry waits its turn.
  const deadRun = { startedAt: ago(30 * MIN), lastBeatAt: ago(6 * MIN) };
  assert.equal(jobIsPresumedDead(deadRun, NOW, { noBeatMs: NO_BEAT_MS }), true);
  const requeued = { ...deadRun, ...fields };
  assert.equal(isBeating(requeued), false);
  assert.equal(jobIsPresumedDead(requeued, NOW), false);
  assert.equal(jobIsPresumedDead(requeued, NOW, { noBeatMs: API_NO_BEAT_MS }), false);
});

test('a dead "add pages" job restores the status the magazine had, with a note', () => {
  for (const prev of ['ready', 'draft', 'published']) {
    const out = issueStatusAfterDeadJob({ type: 'generatePages', payload: { issueId: 'i', prevStatus: prev } }, 'ignored');
    assert.deepEqual(out, { status: prev, stage: '', processingError: ADD_PAGES_INTERRUPTED });
  }
  // An unknown or missing previous status lands on 'ready', never on 'failed' or a
  // status the studio does not know.
  for (const prev of [undefined, '', 'processing', 'failed', 42]) {
    const out = issueStatusAfterDeadJob({ type: 'generatePages', payload: { prevStatus: prev } }, 'ignored');
    assert.equal(out.status, 'ready', String(prev));
  }
  assert.equal(issueStatusAfterDeadJob({ type: 'generatePages' }, 'x').status, 'ready');
});

test('any other dead job still fails the magazine, with the caller\'s message', () => {
  for (const type of ['generateIssue', 'processIssue', 'readSourceDoc']) {
    assert.deepEqual(issueStatusAfterDeadJob({ type, payload: { issueId: 'i', prevStatus: 'ready' } }, 'It stalled.'), {
      status: 'failed',
      stage: '',
      processingError: 'It stalled.',
    });
  }
  assert.equal(issueStatusAfterDeadJob(null, 'No job.').status, 'failed');
  assert.equal(issueStatusAfterDeadJob(undefined, 'No job.').processingError, 'No job.');
});
