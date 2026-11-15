// ---------------------------------------------------------------------------
// Magazine Builder v2 — keeping the Studio's REPLY honest about what it staged.
//
// On 2026-11-15 the client asked the Design Helper on page 3 to set six paragraphs to
// 20px, 220px tall, 14px apart. The reply said "I've staged the change for you to
// review. All six paragraphs are 20px and 220px tall…" — and no tool had been called.
// Only the next message ("list each element") made the assistant admit nothing had
// changed. A prompt rule ("say it is staged") cannot prevent that: the model wrote the
// sentence the rule asked for without doing the work behind it.
//
// So the reply is checked against the proposals themselves, which are the truth:
//   1. claimsChange: does the reply (its status lines removed) say something was
//      changed / staged / set …? A description of the page is not a claim;
//   2. if it does, the turn staged NOTHING, and the user asked for a change (not a
//      question or a listing — asksForNoChange), the turn is run once more with
//      CORRECTION_NOTE — "call the tools now, or say plainly that nothing was changed".
//      A turn that staged something is never re-run: the re-run cannot see what the
//      first run staged and staged its adds a second time; a reply claiming MORE than
//      was staged gets a note instead (shortClaimNote);
//   3. if it still claims a change it did not make, one honest sentence goes FIRST
//      (honestNoChange, built from what is still waiting) — the model's words are kept;
//   4. every reply ends with a line built from the proposals alone — "Waiting for
//      Apply: 6 changes — …" or "Nothing was changed." — so whatever the model wrote,
//      the last line cannot disagree with what Apply will do.
//
// Also here: what the turn says about a document attached with it (it IS saved — the
// assistant used to answer "I can't store files"), and the fields of a staged change
// that the shared request parser does not keep yet (a background change, a group), so
// a change staged on one message survives the next.
//
// Pure: no I/O, no model.
// ---------------------------------------------------------------------------

import type { AgentProposal } from './agent.js';
import type { MagazineElement } from './model.js';
import { parseBackgroundAsk, storedBackground, type BackgroundAsk } from './agentPanelPure.js';
import { replayStaged, stagedSeq, type DroppedStaged, type StagedLike } from './agentStructurePure.js';
import { MAX_SUMMARY_CHARS } from './studioRequests.js';
import { safePublicImageUrl } from './url.js';

// ── Does the reply claim a change? ───────────────────────────────────────────

/** Verbs a reply uses when it says it changed the page. */
const CHANGE_VERBS =
  'staged|applied|set|moved|removed|deleted|added|changed|replaced|resized|updated|restyled|recolou?red|rewr(?:ote|itten)|swapped|placed|inserted|generated|created|drew|drawn|aligned|spaced|shortened|lengthened|cleared|tidied|arranged|increased|decreased|reduced|enlarged|shrunk|shrank|centred|centered|justified|bolded|made(?!\\s+sure)|put|turned|fixed|adjusted|switched|duplicated|copied|rotated';

/** "I've staged", "I have set", "I moved", "I just added" … */
const FIRST_PERSON = new RegExp(`\\b(?:i[’']?ve|i have|i)\\s+(?:(?:just|now|also|already|then|now also)\\s+)?(?:${CHANGE_VERBS})\\b`, 'gi');
/** "… has been moved", "… have now been removed" */
const PASSIVE = new RegExp(`\\b(?:has|have)\\s+(?:(?:now|just|also)\\s+)?been\\s+(?:${CHANGE_VERBS})\\b`, 'i');
/** "staged for your review", "ready to apply", "waiting for Apply" */
const STAGED = /\b(?:staged|ready (?:to apply|for (?:your )?review)|waiting (?:for|to be) appl(?:y|ied))\b/i;

/**
 * A passive sentence is a claim only when it is reported as DONE. "The headline has
 * been set in Playfair at 48px" is how a model DESCRIBES a page ("list each element"),
 * and read as a claim it sent a correct read-only answer through the corrective re-run
 * ("call the tools NOW") and then replaced it with an apology. "Done — the headline has
 * been moved up" and "the headline has now been moved" still count.
 */
const DONE_OPENING = /^\s*(?:all done|done|all set|finished)\b/i;
const DONE_MARK = /\b(?:done|now|as (?:you )?(?:asked|requested)|for you)\b/i;

/**
 * The end of the words before an "I <verb>" that make it a RELATIVE clause — a noun
 * phrase it describes: "the chart I added is at the top right", "the headline I
 * enlarged now fits". That names a thing on the page; it does not report this turn's
 * work. Not when the noun is a change itself ("the changes I made"), when a clause
 * break sits between ("this was too big so I reduced it"), or when the phrase follows a
 * preposition ("at the top I added a headline").
 */
const DETERMINER_TAIL = /(?:^|[^\p{L}\p{N}])(\p{L}+\s+)?(the|this|that|these|those|each|every|any|which|whichever|your|my|its|their|our)((?:\s+[\p{L}\p{N}’'-]+){0,3})\s*$/iu;
const CLAUSE_WORDS = new Set([
  'is', 'was', 'were', 'are', 'be', 'been', 'so', 'and', 'then', 'but', 'now', 'also', 'because', 'as', 'since', 'too', 'very', 'it', 'to', 'done', 'here', 'there',
]);
const PREPOSITIONS = new Set(['in', 'at', 'on', 'for', 'to', 'from', 'with', 'by', 'after', 'into', 'onto', 'under', 'over', 'across', 'beside', 'above', 'below']);
const CHANGE_NOUNS = /\b(?:changes?|edits?|updates?|fix(?:es)?|tweaks?|adjustments?)\b/i;

function isRelativeClause(lead: string): boolean {
  const m = DETERMINER_TAIL.exec(lead);
  if (!m) return false;
  const before = (m[1] ?? '').trim().toLowerCase();
  const determiner = m[2]!.toLowerCase();
  const words = (m[3] ?? '').trim().split(/\s+/).filter(Boolean);
  if (before && PREPOSITIONS.has(before)) return false;
  // "…, which I added" is relative on its own; "confirm that I moved it" is not.
  if (!words.length && determiner !== 'which') return false;
  if (words.some((w) => CLAUSE_WORDS.has(w.toLowerCase()))) return false;
  if (CHANGE_NOUNS.test(m[3] ?? '')) return false;
  return true;
}

/** A first-person claim in one clause: "I moved it", not "the chart I added". */
function firstPersonClaim(s: string): boolean {
  FIRST_PERSON.lastIndex = 0;
  for (let m = FIRST_PERSON.exec(s); m; m = FIRST_PERSON.exec(s)) {
    const lead = s.slice(0, m.index);
    // "Nothing was staged", "I have not moved it": the negation sits before the verb.
    if (NOT_A_CLAIM.test(lead)) continue;
    if (isRelativeClause(lead)) continue;
    FIRST_PERSON.lastIndex = 0;
    return true;
  }
  FIRST_PERSON.lastIndex = 0;
  return false;
}

/**
 * What in a clause BEFORE the claim makes it not a claim: a negation ("nothing was
 * staged"), a condition or a future ("once you apply", "I'll set", "would"), or an offer
 * or a question ("want me to").
 */
const NOT_A_CLAIM =
  /\b(?:not|never|nothing|no|didn[’']?t|did not|haven[’']?t|hasn[’']?t|couldn[’']?t|can[’']?t|cannot|won[’']?t|wasn[’']?t|weren[’']?t|if|once|when|unless|before|after you|would|could|should|will|shall|i[’']?ll|i[’']?d|want me|can i|may i|let me know)\b/i;
/** A clause about changes from an EARLIER message — the model may mention those
 *  freely, they are not this turn's work. */
const EARLIER = /\b(?:earlier|previously|last time|already waiting|still waiting|from before|in my (?:last|previous)|from (?:the|your|my) (?:last|previous|earlier))\b/i;

/** Split a reply into clauses: sentences (keeping the mark that ended each), and the
 *  halves of "I can't do X, but I've done Y" / "…; …". */
function clauses(text: string): string[] {
  return String(text ?? '')
    .split(/(?<=[.!?])\s+|\n+|;\s*|,?\s+but\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Does this reply say the page was changed (or a change staged) THIS turn?
 * A question, a negation, a condition, a future and a mention of earlier changes are
 * not claims; nor is a DESCRIPTION of the page — a relative clause ("the chart I added
 * is at the top right") or a passive sentence not reported as done ("the headline has
 * been set in Playfair"). Pass the reply WITHOUT its status lines (stripStatusLines):
 * a "Waiting for Apply: …" line the model copied from history is not its claim.
 * Still on the side of catching a claim: "I moved", "I've staged", "Done — it has been
 * moved", "staged for your review" all count.
 */
export function claimsChange(reply: string): boolean {
  const opensDone = DONE_OPENING.test(String(reply ?? ''));
  for (const s of clauses(reply)) {
    if (/\?\s*$/.test(s) || EARLIER.test(s)) continue;
    if (firstPersonClaim(s)) return true;
    const p = PASSIVE.exec(s);
    if (p && !NOT_A_CLAIM.test(s.slice(0, p.index)) && (opensDone || DONE_MARK.test(s))) return true;
    const st = STAGED.exec(s);
    if (st && !NOT_A_CLAIM.test(s.slice(0, st.index))) return true;
  }
  return false;
}

/** "Don't change anything", "no changes", "just tell me", "read-only". */
const NO_CHANGE_ASK =
  /\b(?:don[’']?t|do not|never|without)\s+(?:change|changing|edit|editing|touch|touching|modify|modifying|alter|altering|apply|applying|stage|staging|move|moving)\b|\b(?:no changes?|read[- ]only|just (?:tell|list|show|describe|explain|answer))\b/i;
/** A question or a listing: what the page holds, not a change to it. */
const ASKS_ABOUT = /^\s*(?:what|what['’]s|which|where|why|how|who|when|whose|is|are|does|do|did|has|have|was|were|list|describe|explain|summari[sz]e|tell me|show me|give me a list)\b/i;
/** Words that ask for a change somewhere in the message. */
const CHANGE_ASK =
  /\b(?:make|change|set|move|add|remove|delete|replace|put|swap|resize|rewrite|recolou?r|restyle|fix|insert|generate|create|draw|align|centre|center|enlarge|shrink|increase|decrease|reduce|shorten|lengthen|apply|clear|tidy|arrange|bold|rotate|duplicate|place|turn)\b/i;

/**
 * Did the user's message ask for NO change — a question about the page, a listing,
 * or an explicit "don't change anything"? Such a turn is never sent through the
 * corrective re-run: its reply describes the page, and CORRECTION_NOTE ("call the tools
 * NOW to make the change the user asked for") would push the model to stage edits
 * nobody asked for.
 */
export function asksForNoChange(message: string): boolean {
  const m = String(message ?? '').trim();
  if (!m) return false;
  if (NO_CHANGE_ASK.test(m)) return true;
  return ASKS_ABOUT.test(m) && !CHANGE_ASK.test(m);
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/**
 * How many changes the reply says it staged, when it says so outright ("I've staged 6
 * changes", "staged three edits"), else null. Only the explicit form counts: "all six
 * paragraphs" may be one change to one box or six.
 */
export function claimedChangeCount(reply: string): number | null {
  const m = /\b(?:staged|prepared|made|queued)\s+(?:all\s+)?(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:\w+\s+)?(?:changes?|edits?|updates?)\b/i.exec(String(reply ?? ''));
  if (!m) return null;
  const raw = m[1]!.toLowerCase();
  const n = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
  return n && n > 0 ? n : null;
}

/** The staged set as one string: two equal fingerprints mean the turn changed nothing. */
export function proposalFingerprint(proposals: ReadonlyArray<Pick<AgentProposal, 'id'>>): string {
  return proposals.map((p) => p.id).join('|');
}

/** The note the corrective re-run is given, as the user's next message. */
export const CORRECTION_NOTE =
  '[Automatic check, not from the user] Your reply said you changed or staged something on the page, but no change was staged in that turn — no tool call succeeded. ' +
  'Call the tools NOW to make exactly the change the user asked for, then reply in one short sentence. ' +
  'If you cannot make it, say plainly in one sentence that nothing was changed and why. Never describe a change you have not staged with a tool.';

/** The correction when the model claimed a change twice and staged nothing (and
 *  nothing from earlier messages is waiting either). */
export const HONEST_NO_CHANGE =
  'Sorry — I described a change but did not actually make it, so nothing was changed and nothing is waiting for Apply. Ask me again and I’ll make it with my tools.';

/**
 * The correction sentence for a claim that is still untrue after the re-run, built from
 * the state rather than fixed: when changes from EARLIER messages are still waiting
 * (`waiting` > 0), "nothing is waiting for Apply" would contradict the deterministic
 * line under it ("Nothing new was changed; 6 changes from earlier messages are still
 * waiting…"), so it only says that THIS message changed nothing and leaves the count to
 * that line.
 */
export function honestNoChange(waiting: number): string {
  return waiting > 0
    ? 'Sorry — I described a change but did not actually make it in this message, so nothing new was changed. Ask me again and I’ll make it with my tools.'
    : HONEST_NO_CHANGE;
}

/**
 * The reply after a claim that is still untrue: the correction FIRST, then the model's
 * own words. The words are never thrown away — a false alarm on a reply that only
 * described the page used to lose the user's whole answer to the apology.
 */
export function withHonestCorrection(reply: string, waiting: number): string {
  return [honestNoChange(waiting), stripStatusLines(reply)].filter(Boolean).join('\n\n');
}

/**
 * A note for a reply that says it made MORE changes than it staged ("I've made 3
 * changes" with two staged). The turn is not re-run for that — a re-run cannot see what
 * the first run staged and stages its adds again — the Apply line already gives the
 * real count; this says plainly that the two differ.
 */
export function shortClaimNote(staged: number, claimed: number): string {
  return `Note: ${staged} change${staged === 1 ? ' was' : 's were'} staged, not the ${claimed} described above — the line below lists what is waiting.`;
}

// ── The deterministic last line ──────────────────────────────────────────────

/** Lines the reply ends with, written here — any the model wrote itself are dropped. */
const STATUS_LINE = /^(?:waiting for apply:|nothing was changed\.?$|nothing is waiting for apply|nothing new was changed)/i;

/** The reply without status lines the model imitated (it sees them in history). */
export function stripStatusLines(reply: string): string {
  return String(reply ?? '')
    .split('\n')
    .filter((l) => !STATUS_LINE.test(l.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A summary as a group key: a drop-cap piece's own suffix dropped, trailing dot too. */
function groupKey(p: Pick<AgentProposal, 'summary'> & { group?: string }): string {
  const s = (p.group ?? p.summary ?? '').replace(/\s*\((?:removed a )?drop-cap piece\)\s*$/i, '').replace(/[.\s]+$/, '').trim();
  return s.replace(/\s+/g, ' ');
}

/**
 * The changes in a few words: their summaries grouped (a group set by one tool call —
 * clearing a page, arranging boxes — counts once), "×n" for a repeat, at most `max`
 * groups and "and N more".
 */
export function describeStaged(proposals: ReadonlyArray<Pick<AgentProposal, 'summary'> & { group?: string }>, max = 3): string {
  const order: string[] = [];
  const count = new Map<string, number>();
  const grouped = new Set<string>();
  for (const p of proposals) {
    const k = groupKey(p);
    if (!k) continue;
    if (!count.has(k)) order.push(k);
    count.set(k, (count.get(k) ?? 0) + 1);
    if (p.group) grouped.add(k);
  }
  const shown = order.slice(0, max).map((k) => {
    const n = count.get(k)!;
    const text = k.length > 90 ? `${k.slice(0, 89).trimEnd()}…` : k;
    return n > 1 && !grouped.has(k) ? `${text} ×${n}` : text;
  });
  const more = order.length - shown.length;
  return `${shown.join('; ')}${more > 0 ? `; and ${more} more` : ''}`;
}

const changes = (n: number) => `${n} change${n === 1 ? '' : 's'}`;

/**
 * The line every reply ends with, built from the proposals alone:
 *   "Waiting for Apply: 6 changes — Arranged 6 boxes: 20px type, 220px tall, 14px apart."
 *   "Waiting for Apply: 7 changes (1 new, 6 from earlier messages) — Recoloured the headline."
 *   "Nothing new was changed; 6 changes from earlier messages are still waiting for Apply."
 *   "Nothing was changed."
 * `pendingIds` are the changes from earlier messages the turn kept; `sentEarlier` how many
 * it was sent (some may have been dropped — then nothing may be waiting any more).
 */
export function stagedStatusLine(
  proposals: ReadonlyArray<Pick<AgentProposal, 'id' | 'summary'> & { group?: string }>,
  pendingIds: ReadonlySet<string> = new Set(),
  sentEarlier = pendingIds.size,
): string {
  const fresh = proposals.filter((p) => !pendingIds.has(p.id));
  const earlier = proposals.length - fresh.length;
  if (proposals.length === 0) return sentEarlier > 0 ? 'Nothing is waiting for Apply now.' : 'Nothing was changed.';
  if (fresh.length === 0) {
    return `Nothing new was changed; ${changes(earlier)} from earlier messages ${earlier === 1 ? 'is' : 'are'} still waiting for Apply.`;
  }
  const mix = earlier > 0 ? ` (${fresh.length} new, ${earlier} from earlier messages)` : '';
  return `Waiting for Apply: ${changes(proposals.length)}${mix} — ${describeStaged(fresh)}.`;
}

// ── Documents attached with the message ──────────────────────────────────────

/** A document attached with this turn, as the route found it once it was saved. */
export interface AttachedDocState {
  docId: string;
  name: string;
  /** read_document can return its words now. */
  readable: boolean;
  /** Its pages are being read in the background (ready in a minute or so). */
  reading: boolean;
}

const docName = (n: string) => `“${String(n || 'document').replace(/[“”]/g, '"').slice(0, 80)}”`;

/** The prompt block for documents attached this turn: they are SAVED, and readable later. */
export function attachedDocsPromptLines(docs: ReadonlyArray<AttachedDocState>): string[] {
  if (!docs.length) return [];
  return [
    'The user ATTACHED these document(s) with this message. Each one is ALREADY SAVED to this magazine’s documents (the Uploads tab) — nothing more is needed to store it — and stays readable on every later message with read_document:',
    ...docs.map(
      (d) =>
        `- ${docName(d.name)} (docId ${d.docId}) — ${d.readable ? 'its words can be read now' : d.reading ? 'its pages are being read; ready in a minute or so' : 'no readable text was found (it may be a scan); its pages can still be copied or used as a layout'}`,
    ),
    'If the user only asks you to store, save or keep it, confirm it is saved and change nothing on the page. Never say you cannot store, save or attach files.',
  ];
}

/** The deterministic line confirming the attached documents were saved. */
export function savedDocsLine(docs: ReadonlyArray<AttachedDocState>): string {
  if (!docs.length) return '';
  const names = docs.map((d) => docName(d.name));
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const unreadable = docs.filter((d) => !d.readable && !d.reading);
  const reading = docs.filter((d) => !d.readable && d.reading);
  const tail =
    unreadable.length === docs.length
      ? ' — no text could be read from it yet (it may be a scan), but it is kept'
      : reading.length === docs.length
        ? ' — its pages are being read and will be ready to use in a minute'
        : ' — I can read it again on any later message';
  return `Saved ${list} to this magazine’s documents${tail}.`;
}

// ── Staged changes sent back by the client ───────────────────────────────────

/** A staged change as the agent replays it (studioRequests.PendingProposal plus the
 *  fields that parser does not know yet). */
export type PendingLike = Record<string, unknown> & { id: string; kind: string; summary: string };

/** A staged background change, as replayed. */
export interface PendingBackground extends PendingLike {
  kind: 'set-background';
  background: BackgroundAsk;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The staged changes a turn was sent, in the order the client sent them: each one the
 * shared parser accepted (studioRequests.parsePendingProposals), with the fields it
 * does not keep yet put back from the raw item — `group` (one tool call's changes),
 * `toPageId` (a reorder's destination page) — plus the `set-background` changes it does
 * not know, validated here. Anything else the parser dropped stays dropped.
 */
export function pendingFromWire(
  parsed: ReadonlyArray<{ id: string; kind: string; summary: string }>,
  raw: unknown,
  opts: { allowImage?: (url: string) => boolean } = {},
): PendingLike[] {
  // A staged background PICTURE sent back by the client becomes the working page's
  // ground, and check_page / look_at_page render that page in the server's Chromium —
  // so an unchecked url here was a server-side fetch of any address the client named
  // (a cloud metadata endpoint, an internal service). Only a picture that passes the
  // background allow-list is kept (the route passes agentPanelPure.backgroundUrlAllowed
  // for this page); without one, at least a public http(s) url.
  const allowImage = opts.allowImage ?? ((u: string) => !!safePublicImageUrl(u));
  const keepBackground = (b: unknown): boolean => {
    const bg = b as BackgroundAsk | undefined;
    return !!bg && (bg.type !== 'image' || (typeof bg.value === 'string' && allowImage(bg.value)));
  };
  const byId = new Map(parsed.map((p) => [p.id, p]));
  const out: PendingLike[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!isObj(item)) continue;
    const id = typeof item.id === 'string' ? item.id.slice(0, 80).trim() : '';
    if (!id || seen.has(id)) continue;
    const known = byId.get(id);
    if (known) {
      if (known.kind === 'set-background' && !keepBackground((known as { background?: unknown }).background)) continue;
      const extra: Record<string, unknown> = {};
      if (typeof item.group === 'string' && item.group.trim()) extra.group = item.group.slice(0, 200);
      if (known.kind === 'reorder-page' && typeof item.toPageId === 'string' && item.toPageId) extra.toPageId = item.toPageId.slice(0, 64);
      out.push({ ...known, ...extra } as PendingLike);
      seen.add(id);
      continue;
    }
    if (item.kind === 'set-background') {
      const background = parseBackgroundAsk(item.background);
      if (!background || !keepBackground(background)) continue;
      const summary = typeof item.summary === 'string' && item.summary.trim() ? item.summary.slice(0, MAX_SUMMARY_CHARS) : 'Change the page background';
      out.push({ id, kind: 'set-background', summary, background } as PendingBackground);
      seen.add(id);
    }
  }
  return out;
}

/** Where a turn starts once the waiting changes are replayed. */
export interface TurnStart {
  /** The page with every kept change applied — what the model is shown and edits. */
  working: MagazineElement[];
  /** The kept changes, in order and unchanged (the client recognises them by id). */
  proposals: AgentProposal[];
  /** Changes that could not be kept, each with the reason. */
  dropped: DroppedStaged[];
  /** The ids of the kept changes — "from earlier messages" in the Apply line. */
  pendingIds: Set<string>;
  /** Where the turn's own ids continue, so a new one never repeats a kept one. */
  seq: number;
  /** The page's ground with a waiting background change applied. */
  background?: { type: string; value: string };
}

/**
 * Replay the changes still waiting from earlier messages onto the page as loaded
 * (C05, and the 2026-11-15 sessions where every message wiped the one before):
 * element changes through agentStructurePure.replayStaged (the write pipeline, as
 * Apply will run it); a background change here — only the last one counts, and none
 * rides with a whole-page rebuild or PDF page copy, which Apply runs on its own.
 */
export function replayPending(
  elements: ReadonlyArray<MagazineElement>,
  page: { width: number; height: number; background?: { type: string; value: string } },
  pending: ReadonlyArray<PendingLike>,
): TurnStart {
  const sent = pending.filter((p) => p && typeof p.id === 'string');
  const split = splitBackgrounds(sent);
  const replay = replayStaged(elements, split.rest as unknown as StagedLike[], { width: page.width, height: page.height });
  const dropped: DroppedStaged[] = [...replay.dropped];
  for (const r of split.replaced) dropped.push({ id: r.id, summary: r.summary, reason: 'a later background change replaces it' });
  let bg = split.background;
  if (bg && replay.proposals.some((p) => p.kind === 'apply-layout' || p.kind === 'copy-document-page')) {
    dropped.push({ id: bg.id, summary: bg.summary, reason: 'a page rebuild or PDF page copy is staged with it, and that is applied on its own' });
    bg = null;
  }
  const proposals: AgentProposal[] = [...replay.proposals, ...(bg ? [bg as unknown as AgentProposal] : [])];
  const background = bg ? storedBackground(bg.background) : page.background;
  return {
    working: replay.working,
    proposals,
    dropped,
    pendingIds: new Set(proposals.map((p) => p.id)),
    seq: stagedSeq(sent),
    ...(background ? { background } : {}),
  };
}

/** Split replayable changes from staged background changes (the element replay does
 *  not know the latter). Only the LAST background change counts — a later one replaces
 *  an earlier one, as Apply would. */
export function splitBackgrounds(pending: ReadonlyArray<PendingLike>): { rest: PendingLike[]; background: PendingBackground | null; replaced: PendingBackground[] } {
  const rest: PendingLike[] = [];
  const bgs: PendingBackground[] = [];
  for (const p of pending) {
    if (p.kind === 'set-background' && parseBackgroundAsk((p as PendingBackground).background)) bgs.push(p as PendingBackground);
    else if (p.kind !== 'set-background') rest.push(p);
  }
  return { rest, background: bgs.length ? bgs[bgs.length - 1]! : null, replaced: bgs.slice(0, -1) };
}
