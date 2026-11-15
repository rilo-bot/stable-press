// ---------------------------------------------------------------------------
// Magazine Builder v2 — what a row in the media library IS, and the one question
// almost everything asks of it: MAY THIS BE PLACED ON A PAGE?
//
// This module exists because that question had three answers.
//
// A magazine's media library holds five kinds of row, and two of them must never
// reach a page. `doc` is an uploaded source document — a PDF of race results is not
// a photograph. `reference` is somebody else's licensed magazine page, uploaded so
// the AI could read its STRUCTURE; placing it is the one thing
// docs/MAGAZINE-V2-LAYOUT-FROM-REFERENCE.md §1 says we never do.
//
// The rule was written out by hand at each call site instead of living anywhere,
// and four of the six sites did not have it at all:
//
//   GET /media                    kind !== 'doc' && kind !== 'reference'   ✓
//   apply-layout image top-up     kind !== 'reference' && kind !== 'doc'   ✓
//   loadUserPhotoPool             kind !== 'doc'                           ✗ LEAKED
//   agent list_media              (no filter)                              ✗ LEAKED
//   agent set_element_image       (no filter)                              ✗ LEAKED
//   agent add_media_image         (no filter)                              ✗ LEAKED
//
// loadUserPhotoPool fed the pool generation places FIRST, ahead of stock: use
// a reference layout on a page, ask for more pages, and the reference was composed
// into the client's magazine as a hero photograph — publishable to the public
// newsstand and exportable to PDF. The three agent tools were a shorter path to the
// same place: `list_media` is described to the model as "photos in this magazine's
// library" and handed it references and PDFs, and the two placement tools accepted
// whatever it picked. An invariant restated at six call sites is an invariant that is
// wrong at four of them; there is now one place to be right.
//
// ONE TOOL IS DELIBERATELY EXEMPT. `use_image_as_layout` exists to READ a reference's
// structure, so it takes the unfiltered library on purpose — see the note there.
// Reading a reference is the feature; only its pixels are off-limits.
//
// Pure data, one predicate, and a reader for a picture's pixel size from its first bytes.
// No I/O, no DOM, no model.
// ---------------------------------------------------------------------------

/**
 * The kinds of row the media library holds.
 *
 *   upload    — an image the user put in themselves, to place
 *   photo     — a photograph: extracted from an imported PDF, or found on stock. Rows
 *               written before generation was retired carry `source: 'ai-image'`; they
 *               are still photographs and still placeable.
 *   graphic   — an icon, logo or QR crop lifted off an imported page
 *   reference — a LAYOUT REFERENCE: read for its composition, never placed
 *   doc       — an uploaded source document (PDF/Word/text), never placed
 */
export type MediaKind = 'upload' | 'photo' | 'graphic' | 'reference' | 'doc';

/**
 * May a row of this kind be placed on a page? EXHAUSTIVE, and that is the point.
 *
 * A `Record<MediaKind, …>` rather than a list of exclusions, so adding a kind to the
 * union above is a COMPILE ERROR until someone answers this question for it. The bug
 * this module exists to fix was exactly that shape: `reference` was added, the filters
 * that already existed named only `doc`, and four of six call sites silently treated
 * the new kind as a photograph. A deny-list rebuilds that hole one kind later.
 *
 * The costs are not symmetric, which is what settles it. A picture kind wrongly marked
 * false: a photo does not appear in the picker — visible immediately, harmless, one
 * line to fix. An unplaceable kind wrongly marked true: somebody else's licensed page
 * on a public newsstand and inside an exported PDF. The default has to protect against
 * the second.
 */
const PLACEABLE_BY_KIND: Record<MediaKind, boolean> = {
  upload: true, // the user's own image, put there to be placed
  photo: true, // extracted from an import, or found on stock
  graphic: true, // an icon/logo/QR crop lifted off an imported page
  reference: false, // someone else's licensed page — read for structure, never placed
  doc: false, // a source document; a PDF of race results is not a photograph
};

/** The kinds that may never be placed, derived from the table above so the two
 *  can never disagree. Exported for tests and for anything that needs to explain
 *  itself to a user. */
export const UNPLACEABLE_KINDS: readonly string[] = (Object.keys(PLACEABLE_BY_KIND) as MediaKind[])
  .filter((k) => !PLACEABLE_BY_KIND[k]);

/** Unknown kinds already warned about, so a library scan logs each one once rather
 *  than once per row per request. */
const warnedKinds = new Set<string>();

/** The shape this module needs. Deliberately loose: callers hold raw Mongo rows
 *  whose fields are all optional until proven otherwise. */
export interface MediaRowLike {
  kind?: string;
  url?: string;
}

/**
 * May this media row be placed on a page?
 *
 * Note what it does NOT look at: `source`. A layout reference is stored with
 * `source: 'upload'` (it really was uploaded) and `kind: 'reference'`, so any check
 * phrased in terms of provenance rather than KIND lets it through — which is
 * precisely how it leaked into the user photo pool. Placeability is a property of
 * what a row IS, never of where it came from.
 *
 * A row with no usable url is not placeable either: an image element pointing at
 * nothing renders as a hole, and downstream (pruneSpec) deletes its slot and
 * re-partitions the page.
 *
 * A kind OUTSIDE the union fails SAFE — unplaceable, with one warning per distinct
 * value. The compile-time table above cannot reach a legacy row written before a kind
 * existed, or one hand-edited in the database, so the runtime needs its own answer;
 * "hide a photo and say so in the log" is a recoverable wrong answer, and "publish
 * someone's licensed page" is not.
 */
export function isPlaceableMedia(m: MediaRowLike): boolean {
  if (typeof m.url !== 'string' || !m.url) return false;
  const kind = m.kind ?? '';
  if (Object.prototype.hasOwnProperty.call(PLACEABLE_BY_KIND, kind)) {
    return PLACEABLE_BY_KIND[kind as MediaKind];
  }
  if (!warnedKinds.has(kind)) {
    warnedKinds.add(kind);
    console.warn(
      `[magazineV2] media kind ${JSON.stringify(kind)} is not a known MediaKind — treating it as unplaceable. ` +
        'Add it to PLACEABLE_BY_KIND in lib/magazineV2/media.ts to decide deliberately.',
    );
  }
  return false;
}

/** One of the user's own photographs, ready to hand to a composer. */
export interface UserPhoto {
  url: string;
  assetId: string;
  alt: string;
}

/** A media row as the collection stores it. */
export interface MediaRow extends MediaRowLike {
  _id: string;
  alt?: string;
  source?: string;
  /**
   * A picture lifted out of a document the user attached (finding C45): the document
   * it came from and its 1-based page there. Such a row keeps `pageIndex: null` — the
   * page of the DOCUMENT is not a page of the magazine, and recording it as pageIndex
   * would make rankMediaForPage offer it as the "own photo" of whichever magazine page
   * shares that number.
   */
  docId?: string;
  docName?: string;
  docPage?: number;
}

/** The alt text a picture lifted out of an attached document is stored with:
 *  "Results.pdf — page 2, picture 1". Readable to a person in the media panel and
 *  matchable by the Studio when the user says "the photo on page 2 of the PDF". */
export function documentPhotoAlt(docName: string, docPage: number, n: number): string {
  const name = String(docName ?? '').trim().slice(0, 160) || 'document';
  return `${name} — page ${Math.max(1, Math.round(docPage))}, picture ${Math.max(1, Math.round(n))}`;
}

/**
 * Where a library row came from, in a few words — for the Studio's list_media and the
 * media panel. A picture from an attached document says which document and page, so
 * "put the horse photo from page 2 of the PDF on this page" can be answered with the
 * client's own picture instead of a stranger's stock photo.
 */
export function mediaOrigin(m: Pick<MediaRow, 'source' | 'docName' | 'docPage' | 'kind'> & { pageIndex?: number | null }): string {
  if (m.docName) return `from “${m.docName}”${typeof m.docPage === 'number' && m.docPage > 0 ? `, page ${m.docPage}` : ''}`;
  switch (m.source) {
    case 'chart':
      return 'a chart drawn from data';
    case 'ai-image':
      return m.kind === 'graphic' ? 'an AI illustration' : 'an AI-generated picture';
    case 'stock':
      return 'a stock photo';
    case 'upload':
      return 'uploaded by the user';
    case 'extracted':
      return typeof m.pageIndex === 'number' ? `from page ${m.pageIndex + 1} of the imported magazine` : 'from an imported page';
    default:
      return '';
  }
}

/**
 * The user's own uploaded photographs, out of a magazine's whole media library.
 *
 * Lives HERE rather than in generate.ts for two reasons. It is the same question
 * this module already answers, one filter clause further on — and generate.ts
 * reaches the database at import time, so anything defined there cannot be tested
 * without one. This is the pool generation places FIRST, ahead of stock, so
 * whatever reaches it reaches the client's magazine; it has to be testable.
 *
 * Two INDEPENDENT conditions, and conflating them is what caused the leak:
 *   • `source === 'upload'` is the pool's DEFINITION — photos the user put in
 *     themselves. An extracted photo is a fine picture but already sits on its own
 *     page, so it must not be promoted ahead of stock by this pool.
 *   • `isPlaceableMedia` is whether the row may be placed AT ALL. A layout reference
 *     is `source: 'upload'` too, so provenance alone can never exclude it.
 */
export function userPhotosFrom(media: MediaRow[]): UserPhoto[] {
  return media
    .filter((m) => m.source === 'upload' && isPlaceableMedia(m))
    .map((m) => ({ url: m.url as string, assetId: String(m._id), alt: m.alt ?? '' }));
}

/**
 * May a row fill an empty PHOTO slot that nobody chose a picture for (the apply-layout
 * top-up)? Not everything placeable may: a drawn CHART (it shows one page's numbers —
 * and a deleted chart even ranked first for its own page), a picture lifted out of an
 * attached DOCUMENT (a logo, a form header, a chart from someone's PDF — placed only
 * when asked for by name), and an AI GRAPHIC (an illustration or poster made for one
 * place). Before those kinds existed, the newest rows were the user's own uploads and
 * stock photos; now the newest are often these, and a rebuilt page got a bar chart from
 * another page in its photo slot. All of them stay placeable on request.
 */
export function fitsAPhotoSlot(m: { source?: unknown; kind?: unknown; docId?: unknown }): boolean {
  if (m.source === 'chart') return false;
  if (typeof m.docId === 'string' && m.docId) return false;
  if (m.source === 'ai-image' && m.kind === 'graphic') return false;
  return true;
}

/** A media row with the two fields that decide how RELEVANT it is to a given page. */
export interface RankableMediaRow extends MediaRow {
  /** The page this asset came off, for extracted/stock rows. `null` for uploads —
   *  nothing records which page a user had in mind when they uploaded a photo. */
  pageIndex?: number | null;
  createdAt?: string;
}

/**
 * The magazine's placeable pictures, best candidate for THIS page first.
 *
 * Rebuilding a page needs photographs, and the library is the whole magazine's. Read
 * in storage order — which is what the apply-layout top-up did — page 3's rebuild can
 * take page 12's photograph while page 3's own sits further down the array. The
 * pictures are technically the client's own, so nothing is leaked; the page is just
 * wrong, in a way that reads as the feature being careless.
 *
 * Two tiers, and the second matters as much as the first:
 *
 *   1. Assets extracted from THIS page. Only extraction and stock record a
 *      `pageIndex` — an upload is stored with `pageIndex: null`, because nothing ever
 *      asked the user which page they meant.
 *   2. Everything else, NEWEST first. This is the tier uploads land in, and recency is
 *      the only signal there is: a photo added minutes ago is far likelier to be meant
 *      for the page being worked on than one from the first import.
 *
 * Stable: rows that tie keep their relative order, so the result does not shuffle
 * between two calls with the same input.
 *
 * `forPhotoSlots`: the pool for filling empty photo slots nobody chose a picture for —
 * charts, document pictures and AI graphics are left out (fitsAPhotoSlot).
 */
export function rankMediaForPage<T extends RankableMediaRow>(media: T[], pageIndex: number, opts: { forPhotoSlots?: boolean } = {}): T[] {
  const placeable = media.filter((m) => isPlaceableMedia(m) && (!opts.forPhotoSlots || fitsAPhotoSlot(m)));
  const onThisPage = (m: T) => Number.isInteger(m.pageIndex) && m.pageIndex === pageIndex;
  const newest = (a: T, b: T) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''));
  return [
    ...placeable.filter(onThisPage),
    ...placeable.filter((m) => !onThisPage(m)).sort(newest),
  ];
}

// ── A picture's own pixel size ───────────────────────────────────────────────
//
// "Resize each image box to exactly its own ratio (1426x806 -> 640x362 …)" — the client
// had to work the numbers out themselves, because nothing recorded how big an uploaded
// picture is. The upload route now reads it from the stored file's first bytes (every
// format we accept keeps its size in its header), so the assistant can describe each
// picture with its size and make a box exactly its shape.

/** Width and height in pixels. */
export interface PixelSize {
  width: number;
  height: number;
}

const be16 = (b: Buffer, i: number) => (b[i]! << 8) | b[i + 1]!;
const le16 = (b: Buffer, i: number) => b[i]! | (b[i + 1]! << 8);
const le24 = (b: Buffer, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);

/** A JPEG's EXIF orientation (1–8), or 1 when it has none. 5–8 are turned a quarter. */
function jpegOrientation(b: Buffer, app1: number, len: number): number {
  const start = app1 + 4; // after the marker and its length
  if (b.toString('latin1', start, start + 6) !== 'Exif\u0000\u0000') return 1;
  const tiff = start + 6;
  const little = b.toString('latin1', tiff, tiff + 2) === 'II';
  const u16 = (i: number) => (little ? le16(b, i) : be16(b, i));
  const u32 = (i: number) => (little ? b.readUInt32LE(i) : b.readUInt32BE(i));
  const end = Math.min(b.length, app1 + 2 + len);
  if (tiff + 8 > end) return 1;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const count = u16(ifd);
  for (let k = 0; k < count; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > end) break;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

/**
 * The pixel size an image is DRAWN at, read from the first bytes of a PNG, JPEG, GIF
 * or WebP file (the formats the library accepts) — or null when the bytes do not say.
 * A JPEG turned a quarter by its EXIF orientation (a phone's portrait photo) reports
 * the turned size, which is what every browser shows. Never throws.
 */
export function imageDimensions(b: Buffer): PixelSize | null {
  try {
    if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('latin1', 12, 16) === 'IHDR') {
      return sized(b.readUInt32BE(16), b.readUInt32BE(20));
    }
    if (b.length >= 10 && (b.toString('latin1', 0, 6) === 'GIF87a' || b.toString('latin1', 0, 6) === 'GIF89a')) {
      return sized(le16(b, 6), le16(b, 8));
    }
    if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
      const chunk = b.toString('latin1', 12, 16);
      if (chunk === 'VP8 ') return sized(le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff);
      if (chunk === 'VP8L' && b[20] === 0x2f) {
        return sized(1 + (b[21]! | ((b[22]! & 0x3f) << 8)), 1 + (((b[22]! & 0xc0) >> 6) | (b[23]! << 2) | ((b[24]! & 0x0f) << 10)));
      }
      if (chunk === 'VP8X') return sized(1 + le24(b, 24), 1 + le24(b, 27));
      return null;
    }
    if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      let orientation = 1;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1]!;
        if (marker === 0xff) {
          i += 1; // fill byte
          continue;
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2; // a marker with no length
          continue;
        }
        const len = be16(b, i + 2);
        if (marker === 0xe1) orientation = jpegOrientation(b, i, len);
        // Start-of-frame markers carry the size (C4 = Huffman table, C8 = reserved, CC = arithmetic table).
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          const h = be16(b, i + 5);
          const w = be16(b, i + 7);
          return orientation >= 5 ? sized(h, w) : sized(w, h);
        }
        if (len < 2) return null;
        i += 2 + len;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function sized(width: number, height: number): PixelSize | null {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 30_000 && height <= 30_000 ? { width, height } : null;
}

/**
 * The size to record for an upload: what the file's bytes say, unless the browser's
 * own measurement is the same picture turned a quarter (an orientation this reader
 * missed) — then the browser's, since it is what people see. The browser's alone (no
 * readable bytes) is kept as a hint; anything implausible is dropped.
 */
export function chooseImageSize(fromBytes: PixelSize | null, fromClient: { width?: unknown; height?: unknown } | null | undefined): PixelSize | null {
  const cw = Number(fromClient?.width);
  const ch = Number(fromClient?.height);
  const client = Number.isFinite(cw) && Number.isFinite(ch) ? sized(Math.round(cw), Math.round(ch)) : null;
  if (fromBytes && client && client.width === fromBytes.height && client.height === fromBytes.width) return client;
  return fromBytes ?? client;
}

/** A library picture whose own size is known, as the Studio reads it. */
export interface SizedMediaRow {
  url: string;
  assetId: string;
  width: number;
  height: number;
}

/** The pictures in a set of media rows whose size is recorded: width × height, else the
 *  box a chart was drawn for. Documents and rows without a url are left out. */
export function sizedPictures(rows: ReadonlyArray<{ _id?: unknown; url?: unknown; kind?: unknown; width?: unknown; height?: unknown; chartBox?: { w?: unknown; h?: unknown } | null }>): SizedMediaRow[] {
  const out: SizedMediaRow[] = [];
  for (const r of rows) {
    if (typeof r.url !== 'string' || !r.url || r.kind === 'doc') continue;
    const s = sized(Math.round(Number(r.width)), Math.round(Number(r.height))) ?? sized(Math.round(Number(r.chartBox?.w)), Math.round(Number(r.chartBox?.h)));
    if (s) out.push({ url: r.url, assetId: String(r._id ?? ''), ...s });
  }
  return out;
}
