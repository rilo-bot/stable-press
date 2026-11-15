// ---------------------------------------------------------------------------
// Magazine Builder v2 — reading what the studio's routes are SENT, in one pure place.
//
// Every value here arrives in a request body, from the Design Helper, from The Stable
// Hand or from anybody with a token, so each one is checked, capped and reduced to the
// shape the route needs before anything reads it. They live here rather than inline in
// routes/magazinesV2/index.ts for one reason: that file reaches the database at import
// time, so nothing written there can be unit tested. The routes stay thin; the rules
// are tested.
//
// Pure: no I/O, no DOM, no model.
// ---------------------------------------------------------------------------

import type { MagazineElement } from './model.js';
import type { ImageFailureReason } from './imagePrompt.js';
import { FURNITURE_IDS } from './pageFurniture.js';
import { parseBackgroundAsk, type BackgroundAsk } from './agentPanelPure.js';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) ? v : undefined);

// ── Changes staged by an earlier turn, sent back with the next one ─────────────
//
// A Studio turn is built from the STORED page, so a change staged on one turn and not
// yet applied was invisible to the next: "make the headline bigger" (staged), then
// "and make it red" built on the old headline, and the client replaced the tray with
// the new turn's list — the bigger headline vanished without a word (finding C05).
// The client now sends what is still waiting, and the agent replays it onto its
// working copy before the model runs, so the new turn composes on top of it and
// returns the combined list. These are UNTRUSTED like everything else in a body: the
// agent re-applies each one through its own guardrails, and the client applies the
// result through the rev-guarded element writes, so nothing here can reach a page
// that the normal path would not let through.

/** Most proposals one turn can carry back. A real tray holds a handful; 50 is a
 *  runaway backstop, not a working limit. */
export const MAX_PENDING_PROPOSALS = 50;
/** One proposal's JSON may not exceed this (an `add` of a long body, or an
 *  apply-layout carrying its reading, stays well inside it). */
const MAX_PROPOSAL_JSON = 200_000;
/**
 * The longest summary a staged change keeps when it is sent back. It must be LONGER
 * than anything a tool writes: the web recognises a waiting change by a key that
 * includes its summary, so a summary cut on the round trip made a staged change look
 * taken off the page and staged again (a chart's summary lists its values — a title of
 * up to 80 characters and up to 8 category labels of up to 60 each passed the old 400).
 */
export const MAX_SUMMARY_CHARS = 1_000;

/** The proposal kinds a turn can stage, including 'copy-document-page'. */
export const PENDING_PROPOSAL_KINDS = [
  'update',
  'add',
  'delete',
  'add-page',
  'remove-page',
  'reorder-page',
  'generate-pages',
  'apply-layout',
  'copy-document-page',
  'set-background',
] as const;
export type PendingProposalKind = (typeof PENDING_PROPOSAL_KINDS)[number];

/** A staged proposal as it comes back from the client: the AgentProposal shape, every
 *  field optional except id, kind and summary, and nothing that was not in it. */
export interface PendingProposal {
  id: string;
  kind: PendingProposalKind;
  summary: string;
  elementId?: string;
  tempId?: string;
  patch?: Record<string, unknown>;
  element?: Record<string, unknown>;
  atIndex?: number;
  targetIndex?: number;
  from?: number;
  to?: number;
  count?: number;
  topic?: string;
  layoutReading?: unknown;
  pageId?: string;
  pageNumber?: number;
  docId?: string;
  docIds?: string[];
  sourcePage?: number;
  /** reorder-page: the page that sits at the destination now (see AgentProposal). */
  toPageId?: string;
  /** The changes one tool call staged as ONE change share a group. */
  group?: string;
  /** What the person should know before applying it (text that will not fit its box,
   *  …) — set when it was staged, kept so the tray still shows it after a replay. */
  warning?: string;
  /** set-background: the page's new background, validated as the tool validated it. */
  background?: BackgroundAsk;
}

/**
 * The still-pending proposals a turn was sent, checked and reduced to their known
 * fields. Anything malformed is DROPPED, not repaired: a proposal the agent cannot
 * trust is better lost (the user sees it leave the tray and can ask again) than
 * re-staged in a shape it was never staged in.
 *
 *  - kind must be one the agent stages; id and summary are required strings.
 *  - update/delete need an elementId; update needs a patch object; add needs an
 *    element object and a tempId.
 *  - set-background keeps its background only through agentPanelPure.parseBackgroundAsk
 *    (the check set_page_background makes); a malformed one drops the proposal.
 *  - apply-layout keeps its reading only through `normalizeReading` (the route
 *    passes layoutReading.normalizeLayoutReading) — a reading that does not survive
 *    it drops the proposal.
 *  - duplicate ids keep the first; at most `max` (default MAX_PENDING_PROPOSALS).
 */
export function parsePendingProposals(
  raw: unknown,
  opts: { max?: number; normalizeReading?: (r: unknown) => unknown | null } = {},
): PendingProposal[] {
  if (!Array.isArray(raw)) return [];
  const max = Math.max(0, Math.min(MAX_PENDING_PROPOSALS, opts.max ?? MAX_PENDING_PROPOSALS));
  const kinds = new Set<string>(PENDING_PROPOSAL_KINDS);
  const seen = new Set<string>();
  const out: PendingProposal[] = [];
  for (const item of raw) {
    if (out.length >= max) break;
    if (!isObj(item)) continue;
    const id = str(item.id, 80).trim();
    const kind = typeof item.kind === 'string' ? item.kind : '';
    const summary = str(item.summary, MAX_SUMMARY_CHARS).trim();
    if (!id || !kinds.has(kind) || seen.has(id)) continue;
    let size = 0;
    try {
      size = JSON.stringify(item).length;
    } catch {
      continue; // a cycle or a BigInt: not something JSON.parse could have produced
    }
    if (size > MAX_PROPOSAL_JSON) continue;
    const p: PendingProposal = { id, kind: kind as PendingProposalKind, summary: summary || kind };
    const elementId = str(item.elementId, 64);
    const tempId = str(item.tempId, 64);
    if (elementId) p.elementId = elementId;
    if (tempId) p.tempId = tempId;
    if (isObj(item.patch)) p.patch = item.patch;
    if (isObj(item.element)) p.element = item.element;
    for (const k of ['atIndex', 'targetIndex', 'from', 'to', 'count', 'pageNumber', 'sourcePage'] as const) {
      const n = int(item[k]);
      if (n !== undefined && n >= 0 && n <= 10_000) p[k] = n;
    }
    const topic = str(item.topic, 400);
    if (topic) p.topic = topic;
    const pageId = str(item.pageId, 64);
    if (pageId) p.pageId = pageId;
    const docId = str(item.docId, 64);
    if (docId) p.docId = docId;
    const toPageId = str(item.toPageId, 64);
    if (toPageId && p.kind === 'reorder-page') p.toPageId = toPageId;
    const group = str(item.group, 200).trim();
    if (group) p.group = group;
    // Plain words the tray shows (React escapes them) and the model reads back; capped
    // at the length the agent writes (agentTools/shared.ts MAX_WARNING_CHARS).
    const warning = str(item.warning, 300).trim();
    if (warning) p.warning = warning;
    if (Array.isArray(item.docIds)) {
      const ids = item.docIds.filter((d): d is string => typeof d === 'string' && !!d).map((d) => d.slice(0, 64)).slice(0, 6);
      if (ids.length) p.docIds = ids;
    }

    // What each kind cannot do without.
    if ((p.kind === 'update' || p.kind === 'delete') && !p.elementId) continue;
    if (p.kind === 'update' && !p.patch) continue;
    if (p.kind === 'add' && (!p.element || !p.tempId)) continue;
    if (p.kind === 'copy-document-page' && !p.docId) continue;
    if (p.kind === 'set-background') {
      const background = parseBackgroundAsk(item.background);
      if (!background) continue;
      p.background = background;
    }
    if (p.kind === 'apply-layout') {
      const reading = opts.normalizeReading ? opts.normalizeReading(item.layoutReading) : null;
      if (!reading) continue;
      p.layoutReading = reading;
    }
    seen.add(id);
    out.push(p);
  }
  return out;
}

// ── Documents attached to a chat turn ─────────────────────────────────────────
//
// The thread used to store only the typed words and IMAGE attachments, so on the
// next turn "the PDF" referred to nothing the model could name (findings C12/C27).
// The client now says which documents it attached (it already uploaded each one to
// the media library), the route stores them on the user's chat row, and every later
// turn's history says "[attached document “Results.pdf” (docId …)]", which is what
// read_document and add_content_pages need to find it again.

export interface AttachedDoc {
  id: string;
  name: string;
}

/** The documents a turn says it attached: `[{ id | docId | uploadId, name }]`, at most 6. */
export function parseAttachedDocs(raw: unknown): AttachedDoc[] {
  if (!Array.isArray(raw)) return [];
  const out: AttachedDoc[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= 6) break;
    if (!isObj(item)) continue;
    const id = str(item.id ?? item.docId ?? item.uploadId, 64).trim();
    if (!id || seen.has(id) || !/^[A-Za-z0-9_-]+$/.test(id)) continue;
    seen.add(id);
    out.push({ id, name: str(item.name, 200).trim() || 'document' });
  }
  return out;
}

/** "[attached document “Results.pdf” (docId abc123)]", one per document, for the
 *  model's view of a user turn. Empty for none. */
export function attachedDocsTag(docs: ReadonlyArray<AttachedDoc>): string {
  return docs.map((d) => `[attached document “${d.name.replace(/[“”"]/g, "'")}” (docId ${d.id})]`).join(' ');
}

/** A stored chat row, as far as history needs it (a raw row carries more fields). */
export interface ChatRowLike {
  role?: unknown;
  content?: unknown;
  pageIndex?: unknown;
  attachments?: unknown;
  [field: string]: unknown;
}

/**
 * One stored chat row as the model sees it in history. A user turn written on a
 * DIFFERENT page is labelled with that page (a thread follows a train of thought
 * across pages); a user turn that attached documents carries their tag, so "it" and
 * "the PDF" two turns later still resolve to a document id.
 */
export function historyEntry(row: ChatRowLike, thisPageIndex: number): { role: 'user' | 'assistant'; content: string } {
  const idx = typeof row.pageIndex === 'number' ? row.pageIndex : thisPageIndex;
  const role = row.role === 'assistant' ? ('assistant' as const) : ('user' as const);
  const tag = role === 'user' && idx !== thisPageIndex ? `[page ${idx + 1}] ` : '';
  const docs: AttachedDoc[] =
    role === 'user' && Array.isArray(row.attachments)
      ? row.attachments
          .filter((a): a is Record<string, unknown> => isObj(a) && a.isImage === false && typeof a.docId === 'string' && !!a.docId)
          .map((a) => ({ id: String(a.docId), name: str(a.name, 200) || 'document' }))
      : [];
  const text = String(row.content ?? '');
  const docTag = docs.length ? attachedDocsTag(docs) : '';
  return { role, content: `${tag}${text}${docTag ? `${text ? ' ' : ''}${docTag}` : ''}` };
}

/**
 * What became of the changes the previous turn staged, told to the model.
 *
 * The thread stores only the words of each turn, so a model that staged "make the
 * headline bigger" last turn still believed it was waiting in the tray after the user
 * had applied or discarded it — and pointed them to a tray that was empty (C05). The
 * route records on each assistant row how many changes it left staged, and with every
 * turn the client sends the ones still waiting. So when the LAST assistant turn of the
 * thread staged changes on THIS page and nothing is waiting any more, they were either
 * applied or discarded; this returns the history with that said after that turn (the
 * model looks at the page to see which). Changes still waiting are replayed by the
 * agent itself, so then nothing is added.
 *
 * `rows` and `history` are the same turns, oldest first, index for index.
 */
export function withStagedOutcome(
  history: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
  rows: ReadonlyArray<ChatRowLike>,
  ctx: { pageId: string; pendingCount: number },
): { role: 'user' | 'assistant'; content: string }[] {
  const out = history.map((h) => ({ ...h }));
  if (ctx.pendingCount > 0 || rows.length !== history.length) return out;
  let last = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.role === 'assistant') {
      last = i;
      break;
    }
  }
  if (last < 0) return out;
  const row = rows[last]!;
  const staged = typeof row.staged === 'number' && row.staged > 0 ? Math.round(row.staged) : 0;
  if (!staged || String(row.pageId ?? '') !== String(ctx.pageId)) return out;
  const it = staged === 1 ? 'it' : 'them';
  out[last] = {
    ...out[last]!,
    content:
      `${out[last]!.content}\n[Since this reply, the ${staged === 1 ? 'change' : `${staged} changes`} staged here ${staged === 1 ? 'is' : 'are'} ` +
      `no longer waiting to be applied (the user applied or discarded ${it}). The page as it is now shows whether ${it} took effect; ` +
      `if one the user still wants is missing, stage it again — never point the user to the tray for ${it}.]`,
  };
  return out;
}

/** The most recent document attached in a thread's history (rows oldest→newest), or
 *  null. Only the newest user row that attached one counts. */
export function latestAttachedDoc(rows: ReadonlyArray<ChatRowLike>): AttachedDoc | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.role === 'assistant' || !Array.isArray(r.attachments)) continue;
    const doc = [...r.attachments]
      .reverse()
      .find((a): a is Record<string, unknown> => isObj(a) && a.isImage === false && typeof a.docId === 'string' && !!a.docId);
    if (doc) return { id: String(doc.docId), name: str(doc.name, 200) || 'document' };
  }
  return null;
}

/**
 * Does this message talk about a document? Used only to decide whether a turn that
 * attached nothing should be given the text of the document attached earlier in the
 * same thread ("now add the race results from the PDF"). Deliberately about the
 * DOCUMENT, not about content in general: "make the headline bigger" must not pay
 * for 8,000 characters of a report it never mentioned.
 */
export function refersToDocument(text: string): boolean {
  const t = ` ${String(text ?? '').toLowerCase()} `;
  return /\b(pdf|pdfs|document|documents|doc|docx|attachment|attached|upload(?:ed)?|the file|that file|this file|brochure|report|spreadsheet|csv|the table|that table|the figures|the results|the source)\b/.test(t);
}

// ── Find and replace across the magazine ─────────────────────────────────────

export interface ReplaceTextRequest {
  find: string;
  replace: string;
  matchCase: boolean;
  wholeWord: boolean;
  dryRun: boolean;
}

/** Longest search a caller may send (a name or a phrase, never a paragraph). */
export const MAX_FIND_CHARS = 200;
export const MAX_REPLACE_CHARS = 500;

/**
 * The body of POST /issues/:id/replace-text, or the sentence that says what is wrong
 * with it. `matchCase` defaults to TRUE (replaceInHtml's own default: a name swap
 * must not rewrite a different word that only shares its letters) and `wholeWord` to
 * false. An empty replacement is allowed — removing a word is a real edit — but a
 * replacement identical to the search is refused, because it could change nothing.
 */
export function parseReplaceTextBody(body: unknown): ({ ok: true } & ReplaceTextRequest) | { ok: false; error: string } {
  const b = isObj(body) ? body : {};
  const find = typeof b.find === 'string' ? b.find : '';
  const replace = typeof b.replace === 'string' ? b.replace : '';
  if (!find.trim()) return { ok: false, error: 'Say what to find (find).' };
  if (find.length > MAX_FIND_CHARS) return { ok: false, error: `The search is too long — keep it under ${MAX_FIND_CHARS} characters.` };
  if (typeof b.replace !== 'string') return { ok: false, error: 'Say what to replace it with (replace) — an empty string removes it.' };
  if (replace.length > MAX_REPLACE_CHARS) return { ok: false, error: `The replacement is too long — keep it under ${MAX_REPLACE_CHARS} characters.` };
  // Only an IDENTICAL replacement is refused: a case-insensitive "nztrof" → "NZTROF"
  // is a real edit (it fixes the casing everywhere).
  if (find === replace) {
    return { ok: false, error: 'The replacement is the same as the search, so there is nothing to change.' };
  }
  return { ok: true, find, replace, matchCase: b.matchCase !== false, wholeWord: b.wholeWord === true, dryRun: b.dryRun === true };
}

// ── Documents named in a request ─────────────────────────────────────────────

/** Document ids from `docIds: string[]` and/or `docId: string`, de-duplicated, at most
 *  `max` (default 4). Ids are opaque, but only the characters an id can have pass. */
export function parseDocIds(body: unknown, max = 4): string[] {
  const b = isObj(body) ? body : {};
  const raw = [...(Array.isArray(b.docIds) ? b.docIds : []), b.docId];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const id = v.trim().slice(0, 64);
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

/** How much of a chat-attached document's stored text an add-pages job carries. The
 *  same cap the generate route puts on a posted source text. */
export const MAX_JOB_SOURCE_CHARS = 60_000;

/** Several documents' text joined for one job, each under its own name, within the
 *  cap. Documents with no text are left out. */
export function joinDocumentTexts(docs: ReadonlyArray<{ name: string; text: string }>, maxChars = MAX_JOB_SOURCE_CHARS): string {
  const parts: string[] = [];
  let left = maxChars;
  for (const d of docs) {
    const text = (d.text ?? '').trim();
    if (!text || left <= 0) continue;
    const head = docs.length > 1 ? `=== ${d.name} ===\n` : '';
    const body = text.slice(0, Math.max(0, left - head.length));
    if (!body) break;
    parts.push(head + body);
    left -= head.length + body.length + 2;
  }
  return parts.join('\n\n');
}

// ── Reading a PDF's layout in the API process ────────────────────────────────
//
// "Lay this page out like page 4 of the PDF" downloads the document into the API and
// parses it there. Documents up to 150 MB are accepted, and the API runs on a 512 MB
// instance, so one big print-ready PDF could take every endpoint down with it — the
// failure that moved PDF rendering to the worker (finding C34). The size is checked
// on the stored object BEFORE anything is downloaded.

/** The largest PDF whose layout is read in the API process. */
export const MAX_LAYOUT_READ_BYTES = 40 * 1024 * 1024;

/** The sentence for a document too large to read here, or null when it may be read.
 *  An unknown size (not a finite positive number) is let through: the download path
 *  has its own failure handling, and a HEAD that reported nothing is not a reason to
 *  refuse a small file. */
export function layoutReadRefusal(sizeBytes: unknown, maxBytes = MAX_LAYOUT_READ_BYTES): string | null {
  const n = typeof sizeBytes === 'number' ? sizeBytes : Number.NaN;
  if (!Number.isFinite(n) || n <= maxBytes) return null;
  const mb = (x: number) => Math.round(x / 1024 / 1024);
  return `That PDF is too large to measure here (${mb(n)} MB; the limit is ${mb(maxBytes)} MB) — use “copy this page” instead, or attach a smaller export of the pages you need.`;
}

// ── Elements added through the element CRUD ──────────────────────────────────

/**
 * The `source` a newly added element is stored with.
 *
 *  - A RESTORE (undo putting back a deleted element) keeps whatever it had.
 *  - Otherwise 'ai-agent' when the client says the AI placed it — a staged proposal
 *    the user applied, a chart The Stable Hand added — and 'manual' for everything
 *    else. Never 'extracted': only an import or a copy of a PDF page produces that,
 *    and a client claiming it would switch on the copied-text rules for a box that
 *    was never copied.
 *
 * Forcing every add to 'manual' (as the route used to) made an AI-added chart or photo
 * look hand-placed, and Adjust refuses to re-balance any page with a hand-placed box —
 * so one applied suggestion switched Adjust off for the page (finding C51 / B5).
 */
export function addedElementSource(clientSource: unknown, restore: boolean): unknown {
  if (restore) return clientSource;
  return clientSource === 'ai-agent' ? 'ai-agent' : 'manual';
}

/** The highest zIndex on a page, 0 when empty (non-finite values are ignored). */
function highestZ(elements: ReadonlyArray<Pick<MagazineElement, 'zIndex'>>): number {
  let z = 0;
  for (const el of elements) if (Number.isFinite(el.zIndex) && el.zIndex > z) z = el.zIndex;
  return z;
}

/**
 * The zIndex for an added element whose body did not name one: on top of everything
 * already on the page (capped at 9999, the model's ceiling). A body that names its
 * own zIndex keeps it, so an undo restore or a client that chose a layer on purpose
 * is never moved. Without this an added element defaulted to 0, the very bottom of a
 * generated page's stack, where it is drawn UNDER the photos and panels it overlaps.
 */
export function zIndexForAdd(clientZ: unknown, elements: ReadonlyArray<Pick<MagazineElement, 'zIndex'>>): number | undefined {
  if (typeof clientZ === 'number' && Number.isFinite(clientZ)) return undefined;
  return Math.min(9999, highestZ(elements) + 1);
}

// ── Pages handed to the renderer ─────────────────────────────────────────────

/** A stored page background as the preview renderer takes it: a colour or an image,
 *  white when the stored value is missing or malformed. */
export function previewBackground(bg: unknown): { type: 'color' | 'image'; value: string } {
  if (isObj(bg) && (bg.type === 'color' || bg.type === 'image') && typeof bg.value === 'string' && bg.value) {
    return { type: bg.type, value: bg.value.slice(0, 4000) };
  }
  return { type: 'color', value: '#ffffff' };
}

/**
 * A box a caller asked for, made to sit on the page: numbers only, at least `min` on
 * each side, and moved (then, if still needed, shrunk) so no edge leaves the page.
 * Null when the input is not a box at all.
 */
export function clampBoxToPage(
  box: unknown,
  page: { width: number; height: number },
  min: { w: number; h: number } = { w: 60, h: 40 },
): { x: number; y: number; w: number; h: number } | null {
  if (!isObj(box)) return null;
  const nums = ['x', 'y', 'w', 'h'].map((k) => Number(box[k]));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  let [x, y, w, h] = nums as [number, number, number, number];
  w = Math.min(page.width, Math.max(min.w, w));
  h = Math.min(page.height, Math.max(min.h, h));
  x = Math.min(Math.max(0, x), page.width - w);
  y = Math.min(Math.max(0, y), page.height - h);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

// ── A page's story, in one line ──────────────────────────────────────────────

/**
 * What a page is about, from its own words: its largest type first (the headline),
 * then the rest in reading order, tags dropped, at most `max` characters. Furniture
 * (running head, folio) is left out — it names the magazine, not the story. For a
 * rebuild that writes fresh copy but should stay on the page's subject.
 */
export function pageStoryLine(elements: ReadonlyArray<MagazineElement>, max = 300): string {
  const texts = elements
    .filter((e) => e.type === 'text' && !!e.text && !FURNITURE_IDS.includes(e.id))
    .map((e) => ({ e, words: plainWords(e.text!.content) }))
    .filter((t) => t.words.length > 0);
  if (texts.length === 0) return '';
  const lead = [...texts].sort((a, b) => b.e.text!.fontSize - a.e.text!.fontSize || a.e.y - b.e.y)[0]!;
  const rest = texts.filter((t) => t !== lead).sort((a, b) => a.e.y - b.e.y || a.e.x - b.e.x);
  const line = [lead, ...rest].map((t) => t.words).join(' — ');
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function plainWords(html: string): string {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Image-model failures, for a PERSON ───────────────────────────────────────

/**
 * What the Make-image box says when the image model fails, by reason. The Studio
 * relays imagegen's own message, which is written for the AI ("do not retry; tell the
 * user…"); a person pressing a button needs the same facts addressed to them, and
 * needs to be told whether trying again can help. Only an unexplained failure is
 * worth a retry; a refusal needs a different subject; credit, rate limits and outages
 * need waiting, not a loop (finding C42).
 */
export function imageFailureUserText(reason: ImageFailureReason, detail?: string): string {
  const why = (detail ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
  switch (reason) {
    case 'refused':
      return `The image model declined to make this picture${why ? ` (“${why}”)` : ''}. Try a different subject or wording.`;
    case 'no-credit':
      return 'AI image generation is out of credit right now. Use a stock photo or upload one until it is topped up.';
    case 'rate-limited':
      return 'The image model is busy with too many requests right now. Please try again in a minute or two.';
    case 'timeout':
      return 'The image model took too long to answer. Please try again.';
    case 'unavailable':
      return 'AI image generation is unavailable right now. Please try again later, or use a stock photo.';
    case 'failed':
    default:
      return 'The image model did not return a picture. Try again, or reword the description.';
  }
}
