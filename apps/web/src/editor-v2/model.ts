// ---------------------------------------------------------------------------
// Magazine Builder v2 — web-side element model (types only).
//
// Mirrors the server model at apps/server/src/lib/magazineV2/model.ts (the
// authority that validates/normalises on every write). Kept as a plain type
// mirror for now; a shared package can extract these once more of the web side
// exists (Phase 3+). If you change the server model, change this too.
// ---------------------------------------------------------------------------

export type ElementType = 'text' | 'image' | 'shape' | 'qr' | 'icon';

export type TextRole = 'headline' | 'subhead' | 'byline' | 'body' | 'caption' | 'pullquote' | 'other';
export type ElementSource = 'extracted' | 'manual' | 'ai-agent';
export type ElementAutoFit = 'shrink' | 'clip';
export type ElementImageFit = 'cover' | 'contain';
export type ElementTextAlign = 'left' | 'center' | 'right' | 'justify';
export type ElementTextTransform = 'none' | 'uppercase' | 'lowercase' | 'capitalize';
export type ElementVAlign = 'top' | 'center' | 'bottom';
/** Mirrors the server's ElementTextData['fontWeight'] (lib/magazineV2/model.ts). */
export type ElementTextWeight = 400 | 500 | 600 | 700 | 800 | 900;

export interface ElementTextData {
  content: string; // sanitised inline HTML
  role: TextRole;
  fontFamily: string;
  fontSize: number; // px at the page's canonical dims — the CURRENT (fit) size
  maxFontSize?: number; // the design's intended ceiling; refit shrinks from here
  minFontSize?: number; // the design's floor; refit may not shrink below it
  fontWeight: ElementTextWeight;
  color: string; // #rrggbb
  align: ElementTextAlign;
  lineHeight: number;
  autoFit: ElementAutoFit;
  vAlign?: ElementVAlign;
  letterSpacing?: number; // px at canonical dims (default 0)
  textTransform?: ElementTextTransform; // default 'none'
}

export interface ElementImageData {
  assetId: string;
  url: string;
  alt: string;
  fit: ElementImageFit;
  focalPoint?: { x: number; y: number }; // 0–1
}

export interface ElementShapeData {
  fill: string; // #rrggbb
  /** 0–1; <1 = translucent scrim (photo shows through, text stays legible). */
  opacity?: number;
}

export interface ElementQrData {
  url: string;
  fg: string; // #rrggbb
  bg: string; // #rrggbb
}

export interface ElementIconData {
  name?: string; // curated Lucide registry glyph name (see editor/templates/iconRegistry)
  src?: string; // uploaded custom icon URL — overrides `name`
  color?: string; // #rrggbb tint (registry glyphs only)
}

export interface MagazineElement {
  id: string;
  type: ElementType;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  zIndex: number;
  locked: boolean;
  text?: ElementTextData;
  image?: ElementImageData;
  shape?: ElementShapeData;
  qr?: ElementQrData;
  icon?: ElementIconData;
  source: ElementSource;
  confidence?: number;
}

/**
 * A page background as a WRITE asks for it (PATCH …/pages/:pageId/background, and the
 * Design Helper's 'set-background' proposal).
 *
 *  color  `value` is #rrggbb.
 *  image  `value` is a picture already in this magazine's media library (the server
 *         refuses any other url).
 *  none   the plain page — white, or the magazine's own default; no `value`.
 *
 * Wider than a stored page's background on purpose: 'none' is an instruction ("take
 * the background away"), and what the server stores for it comes back on the page.
 */
export interface PageBackgroundInput {
  type: 'color' | 'image' | 'none';
  value?: string;
}

/** One staged edit from the AI editing agent (applied via the element/page CRUD). */
export interface AgentProposal {
  id: string;
  kind:
    | 'update'
    | 'add'
    | 'delete'
    | 'add-page'
    | 'remove-page'
    | 'reorder-page'
    | 'generate-pages'
    | 'apply-layout'
    /** Copy one page of a PDF onto a magazine page, words and pictures and all, through
     *  the same background job as the page panel's "Copy a page exactly". Like a layout
     *  rebuild it replaces the whole page, so it is applied on its own. */
    | 'copy-document-page'
    /** Change the page's own background (colour, a library picture, or none). Applied
     *  with the element edits on the same page, as one more undoable step. */
    | 'set-background';
  summary: string;
  /**
   * The proposals ONE tool call staged as one change share a group ("Clear the page:
   * remove 14 elements", "Arranged 6 boxes…"). Kept as received and sent back with the
   * waiting set, so the server still knows they belong together on the next turn.
   */
  group?: string;
  /** set-background: what the page's background becomes. */
  background?: PageBackgroundInput;
  /** Something the person should know before applying — shown in the tray and relayed
   *  by The Stable Hand. Set by this client when Apply held a text edit back because
   *  its box was edited after staging (pendingChanges.STALE_WARNING), and by a server
   *  that sets one on a staged edit (text that will not fit its box). Kept across a
   *  follow-up message even though the server's replay does not echo it. */
  warning?: string;
  /** Web only: the WORDS (visible text) of the box when this text edit was staged.
   *  Apply compares them with the box's words then, and holds the edit back rather
   *  than write it over a box someone has edited since (holdStaleTextChanges). The
   *  server never sees it; the client carries it across replays. */
  baseText?: string;
  elementId?: string; // update/delete — a real id, or a tempId of an earlier 'add'
  tempId?: string; // add — placeholder id remapped to the server id on apply
  patch?: Partial<MagazineElement>; // update
  element?: Partial<MagazineElement>; // add
  // page-structure proposals:
  atIndex?: number; // add-page / generate-pages: the 0-based position the (first) new page takes
  targetIndex?: number; // remove-page: legacy 0-based page — `pageId` wins when present
  from?: number; // reorder-page: legacy 0-based source — `pageId` wins when present
  to?: number; // reorder-page: 0-based destination
  /** reorder-page: land where THIS page is now. An id, so it survives other moves. */
  toPageId?: string;
  count?: number; // generate-pages
  topic?: string; // generate-pages
  /** copy-document-page: the document (from list_documents) and its 1-based page.
   *  generate-pages: a document to write the new pages from. */
  docId?: string;
  sourcePage?: number; // copy-document-page
  /** generate-pages: several documents to write from (docId is the one-document form). */
  docIds?: string[];
  /** apply-layout: the layout read from a reference image the user attached. It
   *  travels with the proposal so applying it costs no second vision call — and so
   *  what the user approves is exactly what the assistant described. Typed loosely
   *  here to avoid a circular import; the server re-normalises it on apply anyway. */
  layoutReading?: unknown;
  /** apply-layout / copy-document-page: which page, when the user named one ("do page
   *  2 like this"). remove-page / reorder-page: the page to delete or move. An ID,
   *  resolved server-side from the ordinal — page order can change between the
   *  assistant's answer and the user pressing Apply, and an index would then point
   *  somewhere else (deleting pages 3 and 4 by index deleted 3 and 5). Absent on a
   *  rebuild = the page on screen, which is all this could ever do before. */
  pageId?: string;
  /** The ordinal as the user said it, for the confirm. Set with pageId. */
  pageNumber?: number;
}

// ── Page checks (mirrors apps/server/src/lib/magazineV2/pageCheck.ts) ──
// The same report shape on both sides, so the Design Helper, The Stable Hand and the
// server read one thing. Thresholds live in the server module and its web twin
// (editor-v2/pageCheckRules.ts); these are only the types.

export type CheckKind =
  | 'text-clipped'
  | 'text-past-edge'
  | 'text-spills'
  | 'text-overlap'
  | 'element-hidden'
  | 'image-empty'
  | 'image-broken'
  | 'text-empty'
  | 'tiny-text'
  | 'low-contrast'
  | 'size-mismatch'
  | 'loose-gap'
  | 'off-page'
  | 'sliver'
  | 'empty-box'
  | 'dead-band'
  | 'page-empty';

export interface PageCheckIssue {
  kind: CheckKind;
  severity: 'error' | 'warning';
  elementId?: string;
  otherId?: string;
  /** Which element, in words a person recognises: 'body “The New Owners Group…”'. */
  label: string;
  /** The measured fact: 'needs 412px, box is 260px — about 4 lines hidden'. */
  detail: string;
  /** A concrete next step with numbers. */
  fix: string;
  measured?: { needPx?: number; havePx?: number; overflowPx?: number; fitsAtPx?: number; contrast?: number };
}

export interface PageCheck {
  page?: number;
  measuredBy: 'estimate' | 'chromium' | 'browser';
  /** No errors (warnings allowed). */
  ok: boolean;
  /** Errors first, then warnings, capped. */
  issues: PageCheckIssue[];
  summary: string;
}

/** One thing the vision "look" at a rendered page noticed (pageLook.ts). */
export interface LookFinding {
  elementId?: string;
  /** Where on the page, in the model's words ("headline", "lower-right photo"). */
  area: string;
  issue: string;
  fix: string;
}

// ── Charts (mirrors apps/server/src/lib/magazineV2/chartSpec.ts) ──
// A chart is DRAWN from these numbers on the server and placed as an image; it is
// never imagined by an image model.

export type ChartType = 'bar' | 'barh' | 'line' | 'pie' | 'donut' | 'table';

export interface ChartSpec {
  type: ChartType;
  title?: string;
  subtitle?: string;
  /** Shown as a 'Source: …' footnote. */
  source?: string;
  categories: string[];
  series: { name: string; values: number[] }[];
  unit?: { prefix?: string; suffix?: string };
  decimals?: 0 | 1 | 2;
  showValues?: boolean;
  /** A category drawn in the accent colour. */
  highlight?: string;
  /** bar / barh only. */
  stacked?: boolean;
}

/** The look a generated picture takes. 'photo' is a text-free editorial photograph;
 *  the others may carry the words the user asks for. Charts are not one of these. */
export type ImageStyle = 'photo' | 'illustration' | 'graphic' | 'poster';

/** A fully-loaded page (elements included) as returned by GET …/pages/:pageId.
 *  `background` is what is STORED: a colour or a picture. A write of `none` comes
 *  back as whatever plain ground the server stores for it (see PageBackgroundInput);
 *  the canvas draws any non-image background as its colour, white when it has none. */
export interface MagazinePageV2 {
  id: string;
  magazineId: string;
  index: number;
  width: number;
  height: number;
  background: { type: 'image' | 'color'; value: string };
  elements: MagazineElement[];
  status: 'pending' | 'extracted' | 'failed' | 'reviewed';
  selectedForPublish: boolean;
  rev: number;
  // ── Read-only facts the worker records (absent from older servers) ──
  /** Why the last extraction or PDF copy failed, in words for a person. */
  error?: string;
  /**
   * 'scanned' / 'no-text': the page came from a PDF page with no text layer, so its
   * words are part of the background PICTURE — there is nothing to edit as text.
   */
  notice?: '' | 'scanned' | 'no-text';
  /** The attached document page this page was copied from, when it was. */
  copiedFrom?: { docId: string; sourcePage: number } | null;
  /** 0-based page of the magazine's own source file this page was imported from. */
  sourceIndex?: number | null;
}

/** The minimal shape the renderer needs (a page or a frozen-issue snapshot page). */
export interface IssuePageData {
  index: number;
  width: number;
  height: number;
  background: { type: 'image' | 'color'; value: string };
  elements: MagazineElement[];
}
