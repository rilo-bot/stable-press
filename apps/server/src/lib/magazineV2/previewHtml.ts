// ---------------------------------------------------------------------------
// Magazine Builder v2 — a page as ONE self-contained HTML document, for the
// Visual Critic's proof render (renderPreview.ts).
//
// The pure half of the renderer: no browser, no network, no storage, so it can be
// unit-tested. It mirrors the web canvas (apps/web/src/editor-v2/IssuePageCanvas.tsx
// + geometry.ts) rule for rule — element boxes as % of the page's canonical
// width/height, every typographic length in `cqw` against a `container-type:
// inline-size` page box, the same text flex/vAlign/white-space rules, the same
// image object-fit/object-position, shapes with their scrim opacity — because a
// critic judging a page that renders differently from what the reader sees would
// be judging a different page.
//
// Two deliberate simplifications, both told to the critic in its prompt: a QR code
// is drawn as a placeholder pattern (the real one is a client-side component), and
// a registry icon as a simple ring (the real glyphs are Lucide React components).
// Neither changes a page's composition, which is what the critic is judging.
//
// Every element's outer box carries `data-el-id="<element id>"` and a text element's
// inner (content) div carries `data-el-text`. They do not change the rendering; they
// are what lets renderPreview.ts MEASURE a page in Chromium (measurePagePreview) and
// map each measured box back to the element the agents edit by id. The web canvas
// carries the same two attributes for the browser-side page check.
// ---------------------------------------------------------------------------

import type { MagazineElement } from './model.js';
import { keepsPdfLines } from './extractedText.js';
import { HOST_BODY_FONT_STACK } from './fontMetrics.js';
import { safePublicImageUrl } from './url.js';

/** The page fields the serialiser reads (structurally a ComposedPage + its dims). */
export interface PreviewPage {
  width: number;
  height: number;
  background: { type: 'color' | 'image'; value: string };
  elements: MagazineElement[];
}

/** Proof width in CSS px. Wide enough to judge type and crops, small enough to be cheap
 *  to render and to send to a vision model (~620×877 for A4). */
export const PREVIEW_WIDTH = 620;

/**
 * Origin given to a RELATIVE image URL (the API's `/api/uploads/file/<key>` proxy
 * form). The proof is loaded with setContent (an about:blank document), where a
 * relative URL never makes a request at all; anchoring it to this reserved, never-
 * resolvable origin lets the renderer's request handler recognise the key and serve
 * the bytes itself.
 */
export const PREVIEW_ASSET_ORIGIN = 'http://assets.preview.invalid';

/** Faces every machine (or its fallback) already has — never requested from Google. */
const SYSTEM_FAMILIES = new Set(
  ['georgia', 'arial', 'helvetica', 'times new roman', 'times', 'verdana', 'tahoma', 'courier new', 'courier', 'serif', 'sans-serif', 'monospace', 'system-ui', 'cursive', 'fantasy', 'inherit', 'initial'],
);
/**
 * The upright weights the WEB loads for each curated family: the faces the reader's
 * browser (and the PDF, which prints the web route) actually has. Kept to exactly the
 * union of apps/web/src/lib/fonts/registry.ts (googleSpec) and the @imports at the top
 * of apps/web/src/styles/theme.css — the stacks the generator picks from are
 * DISPLAY_FONTS / BODY_FONTS in ./creativeDirection.ts, and every one of their primary
 * families is listed here.
 *
 * Why the WEB's list and not "every weight Google has": the proof exists so the
 * critic, the look call and the Chromium page check see the letterforms readers see.
 * A family requested with no weights loads Regular only, and a weight-800 headline is
 * then drawn as synthetic bold — about 10% narrower than the real ExtraBold for
 * Archivo — so the proof judged different type from the published page (C56). Asking
 * for a weight the web does not load errs the other way.
 *
 * Google's CSS2 API REJECTS a request naming a weight a family lacks, so a family not
 * listed here is requested at its default weight only, and '' means "default only"
 * for a single-weight family. Listing every weight costs nothing at render time: the
 * stylesheet only declares the faces, and Chromium downloads just the ones the page's
 * text uses. tests/magazineV2/previewHtml.test.ts compares this table with the web
 * files, so the two cannot drift silently.
 */
const KNOWN_WEIGHTS: Record<string, string> = {
  // styles/theme.css + registry.ts
  'playfair display': '400;500;600;700;800;900',
  'source sans 3': '400;500;600;700',
  inter: '400;500;600;700;800',
  montserrat: '400;500;600;700;800',
  oswald: '400;500;600;700',
  'dm serif display': '',
  // registry.ts
  lora: '400;500;600;700',
  merriweather: '400;700;900',
  'eb garamond': '400;500;600;700',
  'cormorant garamond': '400;500;600;700',
  'libre baskerville': '400;700',
  'pt serif': '400;700',
  poppins: '400;500;600;700',
  'work sans': '400;500;600;700',
  archivo: '400;500;600;700;800',
  'dancing script': '400;500;600;700',
  'im fell english': '',
  'great vibes': '',
  pacifico: '',
  parisienne: '',
};

/** The first family of a CSS stack, unquoted ("'Source Sans 3', Arial" → "Source Sans 3"). */
function firstFamily(stack: string): string {
  return (stack.split(',')[0] ?? '').trim().replace(/^['"]|['"]$/g, '').trim();
}

/** CSS-wide keywords that make an element take its parent's font (fontMetrics.ts). */
const INHERITING = new Set(['inherit', 'unset', 'revert', 'revert-layer']);

/**
 * The stack a text element is really DRAWN in. A box with no family of its own ('' or
 * 'inherit' — the model default, and what an added text box used to get) takes the
 * page's font, which on the web canvas, the public viewer and the PDF is the app's
 * body face (HOST_BODY_FONT_STACK, Source Sans 3). The proof says so explicitly:
 * left to inherit inside this bare document it was drawn in the browser's default
 * serif, so the look and the Chromium check judged a face no reader sees — and the
 * text estimate (layout.ts) already measures such text as Source Sans 3.
 */
function drawnStack(stack: string | undefined): string {
  const s = (stack ?? '').trim();
  return !s || INHERITING.has(firstFamily(s).toLowerCase()) ? HOST_BODY_FONT_STACK : s;
}

/** A family name Google could serve: plain words only, and not a system face. */
function webFamilyName(stackOrFamily: string): string | null {
  const name = firstFamily(stackOrFamily);
  if (!name || !/^[A-Za-z0-9 ]{2,60}$/.test(name) || SYSTEM_FAMILIES.has(name.toLowerCase())) return null;
  return name;
}

/**
 * The upright weights the web loads for a family (see KNOWN_WEIGHTS), [] for a
 * single-weight family, or null when the family is not one of the curated set (its
 * weights are unknown, so only its default face may be asked for).
 */
export function knownFontWeights(family: string): number[] | null {
  const spec = KNOWN_WEIGHTS[firstFamily(family).toLowerCase()];
  if (spec === undefined) return null;
  return spec ? spec.split(';').map(Number) : [];
}

/**
 * The Google Fonts stylesheet URL for one family (a bare name, or a CSS stack whose
 * first family is used), or null for a system face or a name Google could not serve.
 *
 * Without `weights`, every weight the web loads for that family is declared (see
 * KNOWN_WEIGHTS: the browser fetches only the faces in use). With `weights` — a chart
 * that sets its labels at 400 and its title at 700 — each is mapped to the nearest
 * weight the family really has, because Google rejects a link naming a missing weight
 * and the browser would have drawn that nearest face anyway. An unknown family is
 * always asked for at its default weight only, for the same reason.
 */
export function googleFontHref(family: string, weights?: number[]): string | null {
  const name = webFamilyName(family);
  if (!name) return null;
  const known = knownFontWeights(name);
  let spec = '';
  if (known && known.length > 0) {
    const wanted = (weights ?? []).filter((w) => Number.isFinite(w) && w > 0);
    const chosen = wanted.length
      ? [...new Set(wanted.map((w) => known.reduce((best, k) => (Math.abs(k - w) < Math.abs(best - w) ? k : best), known[0]!)))].sort((a, b) => a - b)
      : known;
    spec = `:wght@${chosen.join(';')}`;
  }
  return `https://fonts.googleapis.com/css2?family=${name.replace(/ /g, '+')}${spec}&display=swap`;
}

/**
 * One Google Fonts stylesheet URL per web-font family the page's text uses (the first
 * family of each stack), each declaring every weight the web loads for it. One link per
 * family, so a family Google does not serve fails alone instead of taking the others
 * with it.
 */
export function googleFontLinks(elements: ReadonlyArray<MagazineElement>): string[] {
  const families = new Map<string, string>();
  for (const el of elements) {
    if (el.type !== 'text' || !el.text) continue;
    const name = webFamilyName(drawnStack(el.text.fontFamily));
    if (name) families.set(name.toLowerCase(), name);
  }
  return [...families.values()].map((name) => googleFontHref(name)).filter((href): href is string => !!href);
}

/**
 * The curated web families a page's text uses (lower-cased): the ones the reader's
 * browser loads for real, so a Chromium measurement of the page is only the truth once
 * these have loaded. A family outside the curated set falls back to a system face for
 * the reader too, so it is not waited for. An empty text box is skipped: with no
 * glyphs to draw, the browser never loads its face, and waiting for it would wait
 * forever.
 */
export function curatedFamiliesUsed(elements: ReadonlyArray<MagazineElement>): string[] {
  const out = new Set<string>();
  for (const el of elements) {
    if (el.type !== 'text' || !el.text) continue;
    if (!(el.text.content ?? '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim()) continue;
    const name = webFamilyName(drawnStack(el.text.fontFamily));
    if (name && knownFontWeights(name) !== null) out.add(name.toLowerCase());
  }
  return [...out];
}

/** The proof's pixel size for a page of `pageW × pageH` canonical px. */
export function previewSize(pageW: number, pageH: number, previewWidth = PREVIEW_WIDTH): { width: number; height: number } {
  const w = pageW > 0 ? pageW : 1;
  const h = pageH > 0 ? pageH : Math.round(w * 1.414);
  return { width: Math.round(previewWidth), height: Math.round((previewWidth * h) / w) };
}

/** Escape for a double-quoted HTML attribute. */
export function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
function hex(v: unknown, fallback: string): string {
  return typeof v === 'string' && HEX_RE.test(v) ? v : fallback;
}
/**
 * A page background colour as the web canvas paints it (`background: value`): a hex,
 * or a CSS colour/gradient expression such as the generator's
 * `linear-gradient(135deg, #283a52 0%, #0B1F3A 45%, …)`. Only colour-expression
 * characters are allowed — no url(), quotes, semicolons or escapes — else white.
 */
export function safeCssBackground(v: unknown): string {
  if (typeof v !== 'string') return '#ffffff';
  const s = v.trim();
  if (HEX_RE.test(s)) return s;
  if (s.length <= 400 && /^[#a-zA-Z0-9%(),.\s-]+$/.test(s) && !/url|expression|image-set|var\(/i.test(s)) return s;
  return '#ffffff';
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
/** A CSS percentage with enough precision to land on the same pixel as the web canvas. */
function pct(part: number, whole: number): string {
  return `${+((part / whole) * 100).toFixed(4)}%`;
}
function cqw(px: number, pageW: number): string {
  return `${+((px / pageW) * 100).toFixed(4)}cqw`;
}

/**
 * Image src for the proof: http(s) and data: pass through; a root-relative URL is
 * anchored to PREVIEW_ASSET_ORIGIN; anything else (javascript:, blob:, junk) is dropped.
 */
export function previewSrc(url: string | undefined | null): string {
  const u = (url ?? '').trim();
  if (!u) return '';
  if (/^data:image\//i.test(u)) return u;
  // Defence in depth for the server's renderer (renderPreview never fetches a host
  // outside our bucket anyway): a loopback, private or link-local address is dropped.
  if (/^https?:\/\//i.test(u)) return safePublicImageUrl(u) ? u : '';
  if (u.startsWith('/') && !u.startsWith('//')) return `${PREVIEW_ASSET_ORIGIN}${u}`;
  return '';
}

/**
 * Defence in depth for text content. Element HTML is already sanitised on every write
 * (writePipeline → sanitize.ts), and the renderer blocks every script/frame/XHR
 * request; this strips the few tags and handlers that could still DO something in a
 * proof document if a future write path ever skipped the sanitiser.
 */
export function stripActiveHtml(html: string): string {
  return html
    .replace(/<\s*(script|style|iframe|object|embed|form|svg|math|template|noscript)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*\/?\s*(script|style|iframe|object|embed|link|meta|base|form|svg|math|template|noscript)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '');
}

function style(parts: Array<[string, string | number | undefined | null | false]>): string {
  return parts
    .filter(([, v]) => v !== undefined && v !== null && v !== false && v !== '')
    .map(([k, v]) => `${k}:${v}`)
    .join(';');
}

/**
 * The element's identity on its outer box: ` data-el-id="<id>"`, or '' for an element
 * with no usable id. Measurements (renderPreview.ts measurePagePreview) are keyed by it.
 */
function idAttr(el: MagazineElement): string {
  return typeof el.id === 'string' && el.id ? ` data-el-id="${escapeAttr(el.id)}"` : '';
}

function boxStyle(el: MagazineElement, page: { width: number; height: number }): Array<[string, string | number | undefined]> {
  return [
    ['position', 'absolute'],
    ['left', pct(num(el.x, 0), page.width)],
    ['top', pct(num(el.y, 0), page.height)],
    ['width', pct(num(el.w, 0), page.width)],
    ['height', pct(num(el.h, 0), page.height)],
    ['transform', el.rotation ? `rotate(${num(el.rotation, 0)}deg)` : undefined],
    ['z-index', Math.round(num(el.zIndex, 0))],
    ['overflow', 'hidden'],
  ];
}

function textHtml(el: MagazineElement, page: { width: number; height: number }): string {
  const t = el.text;
  if (!t) return '';
  // Same rule as the web canvas: EXTRACTED text keeps the source PDF's line breaks and
  // may spill; generated/manual copy wraps and clips. Extracted text whose lines no
  // longer fit their box (rewritten before edits converted it) wraps too — drawn "as
  // measured" it would run off the page. See ./extractedText.ts.
  const extracted = el.source === 'extracted';
  const pdfLines = keepsPdfLines(el);
  const vAlign = t.vAlign ?? 'top';
  const outer = style([
    ...boxStyle(el, page),
    ['overflow', extracted ? 'visible' : 'hidden'],
    ['display', 'flex'],
    ['flex-direction', 'column'],
    ['justify-content', vAlign === 'center' ? 'center' : vAlign === 'bottom' ? 'flex-end' : 'flex-start'],
  ]);
  const inner = style([
    ['width', '100%'],
    ['font-family', t.fontFamily || 'inherit'],
    ['font-weight', num(t.fontWeight, 400)],
    ['color', hex(t.color, '#111111')],
    ['text-align', t.align || 'left'],
    ['line-height', num(t.lineHeight, 1.3)],
    ['font-size', cqw(num(t.fontSize, 16), page.width)],
    ['letter-spacing', t.letterSpacing ? cqw(t.letterSpacing, page.width) : undefined],
    ['text-transform', t.textTransform && t.textTransform !== 'none' ? t.textTransform : undefined],
    ['white-space', pdfLines ? 'pre' : 'pre-wrap'],
    ['overflow-wrap', pdfLines ? undefined : 'break-word'],
  ]);
  return `<div style="${escapeAttr(outer)}"${idAttr(el)} data-role="${escapeAttr(t.role || 'other')}"><div style="${escapeAttr(inner)}" data-el-text>${stripActiveHtml(t.content || '')}</div></div>`;
}

function imageHtml(el: MagazineElement, page: { width: number; height: number }): string {
  const src = previewSrc(el.image?.url);
  if (!src || !el.image) return '';
  const fp = el.image.focalPoint;
  const img = style([
    ['display', 'block'],
    ['width', '100%'],
    ['height', '100%'],
    ['object-fit', el.image.fit === 'contain' ? 'contain' : 'cover'],
    ['object-position', fp ? `${num(fp.x, 0.5) * 100}% ${num(fp.y, 0.5) * 100}%` : undefined],
  ]);
  return `<div style="${escapeAttr(style(boxStyle(el, page)))}"${idAttr(el)}><img src="${escapeAttr(src)}" alt="" style="${escapeAttr(img)}"></div>`;
}

function shapeHtml(el: MagazineElement, page: { width: number; height: number }): string {
  if (!el.shape) return '';
  const opacity = typeof el.shape.opacity === 'number' && el.shape.opacity < 1 ? Math.max(0, el.shape.opacity) : 1;
  return `<div style="${escapeAttr(style([...boxStyle(el, page), ['background', hex(el.shape.fill, '#000000')], ['opacity', opacity]]))}"${idAttr(el)}></div>`;
}

/** A QR-like placeholder: the real code is drawn client-side; its footprint is what matters here. */
function qrHtml(el: MagazineElement, page: { width: number; height: number }): string {
  if (!el.qr) return '';
  const fg = hex(el.qr.fg, '#000000');
  const bg = hex(el.qr.bg, '#ffffff');
  const finder = (x: number, y: number) =>
    `<rect x="${x}" y="${y}" width="7" height="7" fill="${fg}"/><rect x="${x + 1}" y="${y + 1}" width="5" height="5" fill="${bg}"/><rect x="${x + 2}" y="${y + 2}" width="3" height="3" fill="${fg}"/>`;
  let dots = '';
  for (let y = 0; y < 25; y++) {
    for (let x = 0; x < 25; x++) {
      const inFinder = (x < 8 && y < 8) || (x > 16 && y < 8) || (x < 8 && y > 16);
      if (!inFinder && (x * 7 + y * 13 + x * y) % 3 === 0) dots += `<rect x="${x}" y="${y}" width="1" height="1" fill="${fg}"/>`;
    }
  }
  const svg = `<svg viewBox="-2 -2 29 29" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" style="display:block;background:${bg}">${finder(0, 0)}${finder(18, 0)}${finder(0, 18)}${dots}</svg>`;
  return `<div style="${escapeAttr(style([...boxStyle(el, page), ['background', bg]]))}"${idAttr(el)}>${svg}</div>`;
}

/** An icon: an uploaded glyph as an image, a registry glyph as a simple ring. */
function iconHtml(el: MagazineElement, page: { width: number; height: number }): string {
  if (!el.icon) return '';
  const color = hex(el.icon.color, '#111111');
  const wrap = escapeAttr(style([...boxStyle(el, page), ['display', 'flex'], ['align-items', 'center'], ['justify-content', 'center'], ['color', color]]));
  const src = previewSrc(el.icon.src);
  if (src) return `<div style="${wrap}"${idAttr(el)}><img src="${escapeAttr(src)}" alt="" style="width:100%;height:100%;object-fit:contain"></div>`;
  return `<div style="${wrap}"${idAttr(el)}><svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="${color}" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5"/></svg></div>`;
}

function elementHtml(el: MagazineElement, page: { width: number; height: number }): string {
  switch (el.type) {
    case 'text':
      return textHtml(el, page);
    case 'image':
      return imageHtml(el, page);
    case 'shape':
      return shapeHtml(el, page);
    case 'qr':
      return qrHtml(el, page);
    case 'icon':
      return iconHtml(el, page);
    default:
      return '';
  }
}

/**
 * Serialise one page to a complete HTML document whose `#page` box is exactly
 * previewSize(...) CSS px. Elements are painted in zIndex order (a stable sort, so
 * equal z keeps document order — as the web canvas does).
 */
export function pageToPreviewHtml(page: PreviewPage, opts: { previewWidth?: number; webFonts?: boolean } = {}): string {
  const dims = { width: page.width > 0 ? page.width : 1, height: page.height > 0 ? page.height : Math.round((page.width || 1) * 1.414) };
  const size = previewSize(dims.width, dims.height, opts.previewWidth ?? PREVIEW_WIDTH);
  const sorted = [...(page.elements ?? [])].sort((a, b) => num(a.zIndex, 0) - num(b.zIndex, 0));
  const bgValue = page.background?.value ?? '';
  const bgSrc = page.background?.type === 'image' ? previewSrc(bgValue) : '';
  const background = bgSrc
    ? `<img src="${escapeAttr(bgSrc)}" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block">`
    : `<div style="position:absolute;inset:0;background:${escapeAttr(safeCssBackground(bgValue))}"></div>`;
  const fontLinks = opts.webFonts === false ? [] : googleFontLinks(sorted);
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    ...fontLinks.map((href) => `<link rel="stylesheet" href="${escapeAttr(href)}">`),
    // A minimal copy of the Tailwind preflight the web canvas renders under — it is
    // what zeroes paragraph margins and heading sizes inside rich-text copy.
    '<style>',
    '*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;border:0 solid}',
    'html,body{background:#ffffff;-webkit-text-size-adjust:100%}',
    // The app's body face, which text with no family of its own inherits on the web
    // canvas (theme.css `body { font-family: var(--font-body) }`) — see drawnStack.
    `body{font-family:${HOST_BODY_FONT_STACK}}`,
    'h1,h2,h3,h4,h5,h6{font-size:inherit;font-weight:inherit}',
    'ol,ul{list-style:none}',
    'img{display:block;max-width:100%}',
    'b,strong{font-weight:bolder}',
    '</style></head><body>',
    `<div id="page" style="position:relative;overflow:hidden;width:${size.width}px;height:${size.height}px;container-type:inline-size;background:#ffffff">`,
    background,
    ...sorted.map((el) => elementHtml(el, dims)),
    '</div></body></html>',
  ].join('');
}
