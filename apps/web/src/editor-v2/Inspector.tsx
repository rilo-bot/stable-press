// Magazine Builder v2 — the right-hand inspector for the selected element.
//
// Matches the v1 magazine studio's inspector 1:1 by reusing its own control
// primitives (Section / Stepper / Segmented / ColorControl) and layout, adapted
// to v2's free-form elements. Every change is an undoable commit (before = the
// element as it was when editing started); no direct API calls here.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useEditorStore } from './store';
import { ShimmerText } from './BuildProgress';
import { LayoutReference } from './LayoutReference';
import { CopyDocumentPage } from './CopyDocumentPage';
import { columnOf, COLUMN_LABEL, COLUMN_TONE, readOnlyReason } from './review';
import type { MagazineElement, ElementType, ElementTextAlign, ElementTextWeight, ImageStyle, MagazinePageV2 } from './model';
import { imageBoxFor, isGraphicAsset, zForNew } from './addDefaults';
import { growToFit, roomBelow, shrinkSizeFor } from './textFit';
import { describeSize, mostCommonSize, sameSize } from './pageCopy';
import { boxAspectRatio } from './imageFrame';
import * as api from './api';
import type { MediaAsset } from './api';
import { Section, Stepper, Segmented, ColorControl, FontFamilyMenu } from '@/editor-v2/controls';
import { FONT_REGISTRY } from '@/lib/fonts/registry';
import { ICON_NAMES, resolveIcon } from '@/lib/iconRegistry';
import {
  Type, Image as ImageIcon, QrCode, Square, Shapes,
  AlignLeft, AlignCenter, AlignRight, AlignJustify, ArrowUpToLine, FoldVertical, ArrowDownToLine, Trash2,
  Sliders, Images, Upload, Copy, BringToFront, SendToBack, FileText, Search, Sparkles, Eraser,
} from 'lucide-react';

// ── Stable handles for The Stable Hand ───────────────────────────────────────
//
// Every control in this panel carries a data-agent-id (mag.el-font, mag.el-size,
// mag.el-align-center, mag.el-fit-contain, mag.page-background …) so The Stable Hand
// can drive the manual panel by name instead of guessing at unlabelled buttons — and
// so whatever a person can do here, it can too. The shared primitives in controls.tsx
// take no per-option attributes, so this file stamps them: a wrapper for a numeric
// stepper (its one input is what gets typed into), the hex field of a colour control,
// and the buttons of a choice row (Choice, below).

/**
 * Give a control a stable data-agent-id.
 *
 * Without `on`, the wrapper itself is the anchor — right for a Stepper, whose single
 * input the operator types into. With `on`, the element inside matching that selector
 * is stamped instead (a colour control's hex field, which commits a typed #rrggbb).
 */
function Anchor({ id, label, on, children }: { id: string; label?: string; on?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // Every render: the inner element can be re-created (a different element selected).
  useLayoutEffect(() => {
    if (!on) return;
    const target = ref.current?.querySelector<HTMLElement>(on);
    if (!target) return;
    if (target.getAttribute('data-agent-id') !== id) target.setAttribute('data-agent-id', id);
    if (label && target.getAttribute('data-agent-label') !== label) target.setAttribute('data-agent-label', label);
  });
  return on ? (
    <div ref={ref}>{children}</div>
  ) : (
    <div ref={ref} data-agent-id={id} {...(label ? { 'data-agent-label': label } : {})}>
      {children}
    </div>
  );
}

/** A colour control whose hex field is anchored (see Anchor). */
const HEX_FIELD = 'input[type="text"]';

/** A picture file's pixel size, or undefined when the browser cannot decode it (the
 *  upload goes ahead without it). */
async function pixelSize(file: File): Promise<{ width: number; height: number } | undefined> {
  if (typeof createImageBitmap !== 'function') return undefined;
  try {
    const bmp = await createImageBitmap(file);
    const size = { width: bmp.width, height: bmp.height };
    bmp.close();
    return size.width > 0 && size.height > 0 ? size : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A row of choices, each button its own anchor (mag.el-align-center, …). The same look
 * as controls.Segmented, which cannot carry a per-option id.
 */
function Choice<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string; agentId: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex overflow-hidden rounded-sm border border-studio-edge bg-studio-raise">
      {options.map((opt) => (
        <button
          key={String(opt.value)}
          type="button"
          title={opt.title}
          aria-pressed={value === opt.value}
          data-agent-id={opt.agentId}
          data-agent-label={opt.title ?? String(opt.value)}
          onClick={() => onChange(opt.value)}
          className={
            'flex flex-1 items-center justify-center px-2 py-1.5 text-ui-sm transition-colors ' +
            (value === opt.value ? 'bg-studio-gold text-studio-ink' : 'text-studio-ink-2 hover:bg-studio-raise-2')
          }
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The font menu, anchored: its toggle is mag.el-font and, while the list is open,
 * each face is mag.el-font-<registry id> (e.g. mag.el-font-playfair). The list is
 * built by the shared menu, so its buttons are stamped as they appear.
 */
function FontMenuAnchored({ value, onChange }: { value: string; onChange: (stack: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    const stamp = () => {
      host.querySelectorAll<HTMLButtonElement>('button').forEach((b, i) => {
        let id: string | null = null;
        let label = '';
        if (i === 0) {
          id = 'mag.el-font';
          label = 'Font family';
        } else {
          const name = (b.textContent ?? '').trim();
          const f = FONT_REGISTRY.find((x) => x.label === name);
          if (f) {
            id = `mag.el-font-${f.id}`;
            label = `Font: ${f.label}`;
          }
        }
        if (id && b.getAttribute('data-agent-id') !== id) {
          b.setAttribute('data-agent-id', id);
          b.setAttribute('data-agent-label', label);
        }
      });
    };
    stamp();
    // Only childList: stamping attributes does not re-trigger it.
    const mo = new MutationObserver(stamp);
    mo.observe(host, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);
  return (
    <div ref={ref}>
      <FontFamilyMenu value={value} onChange={onChange} />
    </div>
  );
}

const KIND_META = {
  text: { label: 'Text', icon: Type },
  image: { label: 'Image', icon: ImageIcon },
  shape: { label: 'Shape', icon: Square },
  qr: { label: 'QR Code', icon: QrCode },
  icon: { label: 'Icon', icon: Shapes },
} as const;

/** Hover names for the numeric weight buttons — the numbers are what the pipeline
 *  speaks, but not everyone reads 600 as "Semibold" at a glance. */
const WEIGHT_TITLE: Record<ElementTextWeight, string> = {
  400: 'Regular',
  500: 'Medium',
  600: 'Semibold',
  700: 'Bold',
  800: 'Extrabold',
  900: 'Black',
};

/**
 * ADD TO PAGE — the five insert tools, moved here from the top toolbar.
 *
 * They were in the header, competing with Publish and Delete-magazine for the same
 * glance, which was wrong twice over: they act on the CURRENT PAGE rather than the
 * magazine, and they are only usable when there is a page open. Here they sit
 * directly above the panel that edits whatever they just created.
 */
function AddRow({ onAdd, disabled }: { onAdd: (kind: ElementType) => void; disabled: boolean }) {
  const tools: { kind: ElementType; label: string; icon: ReactNode }[] = [
    { kind: 'text', label: 'Text', icon: <Type size={17} /> },
    { kind: 'image', label: 'Photo', icon: <ImageIcon size={17} /> },
    { kind: 'shape', label: 'Shape', icon: <Square size={17} /> },
    { kind: 'qr', label: 'QR code', icon: <QrCode size={17} /> },
    { kind: 'icon', label: 'Icon', icon: <Shapes size={17} /> },
  ];
  return (
    <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5 border-b border-studio-hair px-2 py-2">
      <span className="w-full pb-0.5 text-ui-sm uppercase tracking-wide text-studio-ink-4">Add to this page</span>
      {tools.map((t) => (
        <button
          key={t.kind}
          onClick={() => onAdd(t.kind)}
          disabled={disabled}
          data-agent-id={`mag.insert-${t.kind}`}
          title={`Add ${t.label.toLowerCase()} to this page`}
          aria-label={`Add ${t.label.toLowerCase()}`}
          className="flex min-w-[52px] flex-col items-center justify-center gap-0.5 rounded-sm border border-studio-edge px-1.5 py-1.5 text-studio-ink-2 hover:bg-studio-raise-2 hover:text-studio-ink disabled:opacity-30 disabled:hover:bg-transparent"
        >
          {t.icon}
          <span className="text-ui-sm leading-none">{t.label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * What the panel shows when nothing is selected: THE PAGE.
 *
 * It used to say "Nothing selected" over an illustration — 300px of screen
 * apologising for itself. A panel that always has something true to show never
 * needs an empty state, and "which page am I on, is it going in the edition, what
 * did the owner say about it" are exactly the questions you have at that moment.
 */
/**
 * THE PAGE'S OWN BACKGROUND — a colour, a picture from this magazine's library, or
 * none. There was no control for it anywhere, so a page cleared to "blank" kept its
 * beige ground and nobody — not the user, not the assistant — could take it away.
 * One undo step per change (store.setPageBackground).
 */
function PageBackgroundControl({ page, disabledWhy }: { page: MagazinePageV2; disabledWhy: string }) {
  const issueId = useEditorStore((s) => s.issueId);
  const setPageBackground = useEditorStore((s) => s.setPageBackground);
  const [picking, setPicking] = useState(false);
  const [assets, setAssets] = useState<MediaAsset[] | null>(null);
  const bg = page.background;
  const isImage = bg?.type === 'image' && !!bg.value;
  const colour = !isImage && /^#[0-9a-f]{6}$/i.test(bg?.value ?? '') ? bg.value : '#ffffff';
  const off = !!disabledWhy;

  // The library is read when the picker opens, not with the panel: most visits to the
  // page tab never want a background picture.
  useEffect(() => {
    if (!picking || !issueId || assets) return;
    let alive = true;
    api.listMedia(issueId)
      .then((a) => { if (alive) setAssets(a); })
      .catch(() => { if (alive) setAssets([]); });
    return () => { alive = false; };
  }, [picking, issueId, assets]);

  return (
    <div className={off ? 'pointer-events-none opacity-50' : ''} title={disabledWhy || undefined} aria-disabled={off || undefined}>
      <div className="mb-2 flex items-center gap-2">
        {isImage ? (
          <img src={bg.value} alt="" className="h-9 w-7 flex-shrink-0 rounded-sm border border-studio-edge object-cover" />
        ) : (
          <span className="h-9 w-7 flex-shrink-0 rounded-sm border border-studio-edge" style={{ background: colour }} aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate text-ui-sm text-studio-ink-2">
          {isImage ? 'A picture fills the page' : colour.toLowerCase() === '#ffffff' ? 'Plain white' : `Colour ${colour}`}
        </span>
        <button
          type="button"
          onClick={() => void setPageBackground({ type: 'none' })}
          disabled={off || (!isImage && colour.toLowerCase() === '#ffffff')}
          data-agent-id="mag.page-background-clear"
          data-agent-label="Clear the page background (plain page)"
          title="Take the background away — a plain page"
          className="flex flex-shrink-0 items-center gap-1 rounded-sm border border-studio-edge px-2 py-1 text-ui-sm text-studio-ink-2 hover:bg-studio-raise-2 disabled:opacity-40"
        >
          <Eraser size={12} /> Clear
        </button>
      </div>
      <Anchor id="mag.page-background" label="Page background colour (#rrggbb)" on={HEX_FIELD}>
        <ColorControl value={colour} onChange={(c) => void setPageBackground({ type: 'color', value: c })} />
      </Anchor>
      <button
        type="button"
        onClick={() => setPicking((v) => !v)}
        aria-expanded={picking}
        disabled={off}
        data-agent-id="mag.page-background-pick"
        data-agent-label="Use a picture from the library as the page background"
        className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-sm border border-studio-edge bg-studio-raise px-3 py-1.5 text-ui-sm font-semibold text-studio-ink-2 hover:bg-studio-raise-2"
      >
        <Images size={13} /> {picking ? 'Hide the library' : 'Use a picture from the library'}
      </button>
      {picking && (
        <div className="mt-2">
          {assets === null ? (
            <p className="text-ui-sm text-studio-ink-3" role="status"><ShimmerText>Loading your media</ShimmerText></p>
          ) : assets.length === 0 ? (
            <p className="text-ui-sm leading-relaxed text-studio-ink-3">No pictures in this magazine yet — add one in the Assets tab first.</p>
          ) : (
            <div className="grid max-h-56 grid-cols-3 gap-1.5 overflow-y-auto">
              {assets.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => { void setPageBackground({ type: 'image', value: a.url }); setPicking(false); }}
                  disabled={off}
                  data-agent-id={`mag.page-background-image-${a.id}`}
                  data-agent-label={`Use “${a.alt || a.kind}” as the page background`}
                  title={a.alt || a.kind}
                  className={
                    'aspect-[3/4] overflow-hidden rounded-sm border hover:border-studio-gold ' +
                    (isImage && bg.value === a.url ? 'border-studio-gold ring-1 ring-studio-gold' : 'border-studio-hair')
                  }
                >
                  <img src={a.url} alt={a.alt} className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PagePanel() {
  const pages = useEditorStore((s) => s.pages);
  const currentPageId = useEditorStore((s) => s.currentPageId);
  const page = useEditorStore((s) => s.page);
  const issue = useEditorStore((s) => s.issue);
  const setPageSelected = useEditorStore((s) => s.setPageSelected);
  const canManage = useEditorStore((s) => s.canManage());
  const canEdit = useEditorStore((s) => s.canEdit());
  const sum = pages.find((p) => p.id === currentPageId);
  if (!sum) return <div className="p-3 text-ui-sm text-studio-ink-3">No page open.</div>;
  // The same lock the canvas honours: a contributor's submitted/approved page.
  const backgroundLocked = !canEdit ? 'You can view this magazine but not edit it.' : readOnlyReason(issue, sum);

  const col = columnOf(sum);
  const tone = COLUMN_TONE[col];
  // A page copied from a PDF takes that page's shape, so it can differ from the rest
  // of the magazine (US Letter in an A4 issue). Said here, where it stays visible —
  // the toast after the copy is gone in seconds.
  const size = page ? { width: page.width, height: page.height } : { width: sum.width, height: sum.height };
  const common = mostCommonSize(pages.filter((p) => p.id !== sum.id));
  const odd = common && size.width > 0 && size.height > 0 && !sameSize(size, common);
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-studio-hair px-3.5 py-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-sm bg-studio-raise-2 text-studio-ink-2 tabular-nums">
          {sum.index + 1}
        </span>
        <div className="min-w-0">
          <p className="truncate text-ui font-bold text-studio-ink">Page {sum.index + 1} of {pages.length}</p>
          <p className="truncate text-ui-sm text-studio-ink-3">
            {sum.elementCount} item{sum.elementCount === 1 ? '' : 's'}
            {page ? ` · ${Math.round(page.width)}×${Math.round(page.height)}` : ''}
          </p>
        </div>
      </div>
      {odd && common && (
        <p className="border-b border-studio-hair bg-amber-400/10 px-3.5 py-2 text-ui-sm leading-relaxed text-amber-200" data-agent-id="mag.page-size-note">
          This page is {describeSize(size)}; the rest of the magazine is {describeSize(common)}. It prints on its own sheet size in the PDF, so it will not line up with its neighbours in print.
        </p>
      )}

      <Section title="In this edition">
        <label className="flex cursor-pointer items-start gap-2 text-ui-sm text-studio-ink-2">
          <input
            type="checkbox"
            checked={sum.selectedForPublish}
            disabled={!canManage}
            onChange={(e) => void setPageSelected(sum.id, e.target.checked)}
            data-agent-id="mag.inspector-publish-toggle"
            data-agent-label={`Include page ${sum.index + 1} when publishing selected pages`}
            className="mt-0.5 accent-studio-gold"
          />
          <span>
            Include when publishing selected pages
            <span className="block text-studio-ink-4">A full-edition publish always includes every page.</span>
          </span>
        </label>
      </Section>

      {page && page.id === sum.id && (
        <Section title="Background">
          <PageBackgroundControl page={page} disabledWhy={backgroundLocked} />
        </Section>
      )}

      <Section title="Review">
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-ui-sm ${tone.chip} ${tone.text}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
          {COLUMN_LABEL[col]}
          {(sum.reviewRound ?? 0) > 0 && col === 'needs_changes' ? ` · round ${sum.reviewRound}` : ''}
        </span>
        {sum.approvalStale && (
          <p className="mt-1.5 text-ui-sm text-amber-200/90">Edited after approval — it needs approving again.</p>
        )}
        {sum.reviewNote && (
          <p className="mt-1.5 border-l-2 border-studio-edge pl-2 text-ui-sm italic text-studio-ink-2">“{sum.reviewNote}”</p>
        )}
        {!sum.reviewNote && !sum.approvalStale && (
          <p className="mt-1.5 text-ui-sm text-studio-ink-4">
            {col === 'in_progress' ? 'Not submitted for review.' : 'No notes on this page.'}
          </p>
        )}
      </Section>

      {/* TWO DOORS, NAMED FOR WHAT THEY DO TO THE WORDS — the one question that
          separates them. "Match a layout" borrows an arrangement and writes fresh
          copy; "Copy a page exactly" reproduces a PDF page verbatim. They were one
          feature for a while, and "make this page like that one" is ambiguous enough
          that people reached for the wrong half and got a 29% match they could not
          explain. */}
      {canManage && (
        <Section title="Match a layout">
          <LayoutReference />
        </Section>
      )}
      {canManage && (
        <Section title="Copy a page exactly">
          <CopyDocumentPage />
        </Section>
      )}

      <Section title="Editing">
        <p className="text-ui-sm leading-relaxed text-studio-ink-3">
          Click any headline, paragraph, photo or shape on the page to edit it here. Use <b className="text-studio-ink-2">Add</b> above
          to put something new on it, or <b className="text-studio-ink-2">Assets</b> to place a photo you have already uploaded.
        </p>
      </Section>
    </div>
  );
}

export function Inspector({ onAdd }: { onAdd?: (kind: ElementType) => void }) {
  const page = useEditorStore((s) => s.page);
  const selectedId = useEditorStore((s) => s.selectedId);
  const canEdit = useEditorStore((s) => s.canEdit());
  const [tab, setTab] = useState<'element' | 'assets'>('element');

  const el = page?.elements.find((e) => e.id === selectedId) ?? null;

  const tabBtn = (id: 'element' | 'assets', label: string, icon: ReactNode) => (
    <button
      onClick={() => setTab(id)}
      data-agent-id={`mag.inspector-tab-${id}`}
      aria-pressed={tab === id}
      className={
        'flex flex-1 items-center justify-center gap-1.5 border-b-2 py-2.5 text-ui-sm font-semibold transition-colors ' +
        (tab === id ? 'border-studio-gold text-studio-ink' : 'border-transparent text-studio-ink-3 hover:text-studio-ink-2')
      }
    >
      {icon} {label}
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      {onAdd && canEdit && <AddRow onAdd={onAdd} disabled={!page} />}
      <div className="flex flex-shrink-0 border-b border-studio-hair">
        {tabBtn('element', el ? 'Element' : 'Page', el ? <Sliders size={13} /> : <FileText size={13} />)}
        {tabBtn('assets', 'Assets', <Images size={13} />)}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* No empty state: with nothing selected the tab shows the PAGE, which is
            always a real thing with real properties. */}
        {tab === 'assets' ? <AssetsTab /> : el ? <ElementPanel el={el} /> : <PagePanel />}
      </div>
    </div>
  );
}

// ── Does the selected text fit its box? ──────────────────────────────────────

/**
 * How much the selected text box hides, MEASURED on the canvas (the open page's
 * real render — IssuePageCanvas marks each box data-el-id and its text
 * data-el-text), in page px. null when it fits, when the box is not on screen
 * (e.g. being typed into), or when it is drawn unclipped (extracted PDF text keeps
 * its lines and may spill, by design).
 */
function measureTextFit(id: string, pageWidth: number): { needPx: number; havePx: number } | null {
  const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
  const box = document.querySelector<HTMLElement>(`[data-active-page] [data-el-id="${esc}"]`);
  const inner = box?.querySelector<HTMLElement>('[data-el-text]');
  if (!box || !inner) return null;
  if (window.getComputedStyle(box).overflow === 'visible') return null;
  const shown = box.closest<HTMLElement>('[data-magazine-page]')?.clientWidth ?? 0;
  if (!(shown > 0) || !(pageWidth > 0)) return null;
  const need = Math.max(inner.scrollHeight, inner.offsetHeight);
  const have = box.clientHeight;
  if (need <= have + 2) return null;
  const k = pageWidth / shown; // page px per screen px
  return { needPx: Math.ceil(need * k), havePx: Math.round(have * k) };
}

/**
 * CUT-OFF TEXT, SAID OUT LOUD — with the two fixes. Copy is clipped to its box, so
 * a bigger size or a longer rewrite used to hide its last lines with no sign at all.
 * "Make the box taller" grows it down into the free space below (the size stays
 * as chosen); "Shrink to fit" picks a size it fits at and makes that the ceiling.
 */
function TextFitHint({ el, page }: { el: MagazineElement; page: MagazinePageV2 }) {
  const commit = useEditorStore((s) => s.commit);
  const zoomWidth = useEditorStore((s) => s.zoomWidth);
  const [fit, setFit] = useState<{ needPx: number; havePx: number } | null>(null);
  const t = el.text!;

  useEffect(() => {
    let alive = true;
    const measure = () => { if (alive) setFit(measureTextFit(el.id, page.width)); };
    // Two frames: the canvas re-renders after the store change that got us here.
    const raf = requestAnimationFrame(() => requestAnimationFrame(measure));
    // A web font still arriving changes the wrap — measure again once fonts settle.
    void document.fonts?.ready.then(measure);
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [el.id, el.w, el.h, el.y, t.content, t.fontSize, t.lineHeight, t.fontFamily, t.fontWeight, t.letterSpacing, t.textTransform, zoomWidth, page.width]);

  if (!fit) return null;
  const room = roomBelow(el, page.elements, page);
  const grow = growToFit(el.h, fit.needPx, room);
  const smaller = shrinkSizeFor(t.fontSize, fit.needPx, fit.havePx);
  return (
    <div
      role="status"
      data-agent-id="mag.el-fit-warning"
      className="mt-2 rounded-sm border border-amber-400/30 bg-amber-400/10 p-2 text-ui-sm leading-relaxed text-amber-100"
    >
      <p>
        Some of this text is cut off: it needs about {fit.needPx}px of height and the box is {fit.havePx}px.
        {room <= 0 ? ' There is no free space below it.' : grow.short > 0 ? ` Only ${room}px is free below it.` : ''}
      </p>
      <div className="mt-1.5 grid grid-cols-2 gap-1.5">
        <button
          onClick={() => void commit(el.id, { h: grow.h }, { ...el })}
          disabled={room <= 0}
          data-agent-id="mag.el-fit-grow"
          title={room <= 0 ? 'Something sits directly below this box' : `Grow the box to ${grow.h}px tall`}
          className="rounded-sm border border-amber-300/40 px-2 py-1 font-semibold text-amber-50 hover:bg-amber-400/15 disabled:opacity-40"
        >
          Make the box taller
        </button>
        <button
          onClick={() => void commit(el.id, { text: { ...t, fontSize: smaller, maxFontSize: smaller } }, { ...el })}
          data-agent-id="mag.el-fit-shrink"
          title={`Set the text to ${smaller}px`}
          className="rounded-sm border border-amber-300/40 px-2 py-1 font-semibold text-amber-50 hover:bg-amber-400/15"
        >
          Shrink to fit ({smaller}px)
        </button>
      </div>
    </div>
  );
}

// ── The per-element editing panel (unchanged controls, now tabbed) ────────────
function ElementPanel({ el }: { el: MagazineElement }) {
  const pages = useEditorStore((s) => s.pages);
  const currentPageId = useEditorStore((s) => s.currentPageId);
  const issueId = useEditorStore((s) => s.issueId);
  const page = useEditorStore((s) => s.page);
  const commit = useEditorStore((s) => s.commit);
  const deleteElement = useEditorStore((s) => s.deleteElement);
  const duplicateElement = useEditorStore((s) => s.duplicateElement);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  // before = current element snapshot, so each inspector change is one undo step.
  const set = (patch: Partial<MagazineElement>) => void commit(el.id, patch, { ...el });

  // Layer order: raise above the current top / drop below the current bottom.
  // zIndex is clamped 0–9999 server-side, so cap the ends accordingly.
  const others = (page?.elements ?? []).filter((e) => e.id !== el.id);
  const bringToFront = () => set({ zIndex: Math.min(9999, others.reduce((m, e) => Math.max(m, e.zIndex), 0) + 1) });
  const sendToBack = () => set({ zIndex: Math.max(0, others.reduce((m, e) => Math.min(m, e.zIndex), el.zIndex) - 1) });

  // Upload a picture from the user's computer and point the selected image element
  // at it — the manual "replace this photo" path (the Assets tab handles picking an
  // existing library photo; a URL can still be pasted below). One commit → one undo.
  const replaceImageFromFile = async (file: File) => {
    if (!issueId || !el.image) return;
    setUploading(true);
    try {
      // With its pixel size, so the assistant can later size a box to this picture's
      // own shape ("resize the box to the image's ratio") instead of guessing.
      const asset = await api.uploadMediaImage(issueId, file, el.image.alt || file.name, undefined, await pixelSize(file));
      set({ image: { ...el.image, url: asset.url, assetId: asset.id, alt: asset.alt } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };
  const meta = KIND_META[el.type];
  const Icon = meta.icon;
  const pageNo = pages.findIndex((p) => p.id === currentPageId) + 1;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-studio-hair px-3.5 py-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-sm bg-studio-gold/20 text-studio-gold">
          <Icon size={14} />
        </span>
        <div className="min-w-0">
          <p className="truncate text-ui-sm font-bold text-studio-ink">{meta.label}{el.type === 'text' && el.text ? ` · ${el.text.role}` : ''}</p>
          <p className="truncate text-ui-sm text-studio-ink-3">Page {pageNo || '—'}</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {el.type === 'text' && el.text && (
          <>
            <Section title="Content">
              <textarea
                key={`c${el.id}`}
                defaultValue={el.text.content}
                rows={3}
                onBlur={(e) => set({ text: { ...el.text!, content: e.target.value } })}
                data-agent-id="mag.el-content"
                data-agent-label="Selected text's content"
                className="w-full resize-none rounded-sm border border-studio-edge bg-studio-raise px-2 py-1.5 text-ui-sm text-studio-ink outline-none focus:border-studio-edge-strong"
              />
            </Section>

            <Section title="Font">
              {/* The curated registry (lib/fonts/registry.ts), grouped and previewed in
                  each face. It replaced a hand-kept list of seven stacks that had drifted
                  from both the registry AND the generator's own font lists. */}
              <FontMenuAnchored
                value={el.text.fontFamily}
                onChange={(stack) => set({ text: { ...el.text!, fontFamily: stack } })}
              />
            </Section>

            <Section title="Size & weight">
              {/* The size typed here is the new CEILING too (maxFontSize), so the copy
                  does not snap back to an older size on the next refit. */}
              <Anchor id="mag.el-size" label="Text size in px">
                <Stepper value={Math.round(el.text.fontSize)} min={6} max={400} suffix="px" onChange={(v) => set({ text: { ...el.text!, fontSize: v, maxFontSize: v } })} />
              </Anchor>
              {/* EVERY weight the model allows, on its own row.
                  Three buttons that collapsed anything ≥700 to "Bold" could not tell the
                  truth about the type on the page: templates and roleScale set headlines,
                  cover titles and stat figures at 800, and the layout DSL emits 900 — all
                  of which displayed as "Bold" and were silently demoted to 700 the moment
                  the control was touched. Numeric labels because that is how the weights
                  are named everywhere else in the pipeline. */}
              <div className="mt-2">
                <Choice<ElementTextWeight>
                  value={el.text.fontWeight}
                  options={([400, 500, 600, 700, 800, 900] as ElementTextWeight[]).map((w) => ({
                    value: w,
                    label: String(w),
                    title: `${WEIGHT_TITLE[w]} (${w})`,
                    agentId: `mag.el-weight-${w}`,
                  }))}
                  onChange={(v) => set({ text: { ...el.text!, fontWeight: v } })}
                />
              </div>
              {page && <TextFitHint el={el} page={page} />}
            </Section>

            <Section title="Alignment">
              {/* Justify is offered because the server can already STORE it: the layout
                  spec lists it (lib/magazineV2/layoutSpec.ts) and generation emits it for
                  body copy. Without the fourth option a justified column showed no
                  selected alignment here and could never be set back to justify by hand. */}
              <Choice<ElementTextAlign>
                value={el.text.align}
                options={[
                  { value: 'left', label: <AlignLeft size={13} />, title: 'Align left', agentId: 'mag.el-align-left' },
                  { value: 'center', label: <AlignCenter size={13} />, title: 'Centre', agentId: 'mag.el-align-center' },
                  { value: 'right', label: <AlignRight size={13} />, title: 'Align right', agentId: 'mag.el-align-right' },
                  { value: 'justify', label: <AlignJustify size={13} />, title: 'Justify', agentId: 'mag.el-align-justify' },
                ]}
                onChange={(v) => set({ text: { ...el.text!, align: v } })}
              />
            </Section>

            <Section title="Vertical">
              {/* The anchors say top / middle / bottom, as this row does; the stored value
                  for the middle is 'center'. */}
              <Choice<'top' | 'center' | 'bottom'>
                value={el.text.vAlign ?? 'top'}
                options={[
                  { value: 'top', label: <ArrowUpToLine size={13} />, title: 'Top', agentId: 'mag.el-valign-top' },
                  { value: 'center', label: <FoldVertical size={13} />, title: 'Middle', agentId: 'mag.el-valign-middle' },
                  { value: 'bottom', label: <ArrowDownToLine size={13} />, title: 'Bottom', agentId: 'mag.el-valign-bottom' },
                ]}
                onChange={(v) => set({ text: { ...el.text!, vAlign: v } })}
              />
            </Section>

            <Section title="Colour">
              <Anchor id="mag.el-color" label="Text colour (#rrggbb)" on={HEX_FIELD}>
                <ColorControl value={el.text.color} onChange={(c) => set({ text: { ...el.text!, color: c } })} />
              </Anchor>
            </Section>

            <Section title="Spacing">
              <p className="mb-1 text-ui-sm text-studio-ink-3">Line height</p>
              <Anchor id="mag.el-line-height" label="Line height in % of the text size">
                <Stepper value={Math.round((el.text.lineHeight ?? 1.3) * 100)} min={80} max={250} step={5} suffix="%" onChange={(v) => set({ text: { ...el.text!, lineHeight: v / 100 } })} />
              </Anchor>
            </Section>
          </>
        )}

        {el.type === 'image' && el.image && (
          <>
            <Section title="Replace image">
              {el.image.url && (
                <div className="mb-2 overflow-hidden rounded-sm border border-studio-hair bg-black/20">
                  <img src={el.image.url} alt={el.image.alt} className="max-h-28 w-full object-contain" />
                </div>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void replaceImageFromFile(f); e.target.value = ''; }}
              />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                data-agent-id="mag.el-image-upload"
                className="flex w-full items-center justify-center gap-2 rounded-sm border border-studio-edge bg-studio-raise px-3 py-2 text-ui-sm font-semibold text-studio-ink hover:bg-studio-raise-2 disabled:opacity-50"
              >
                <Upload size={13} />
                {uploading ? <ShimmerText>Uploading…</ShimmerText> : el.image.url ? 'Upload a replacement' : 'Upload from computer'}
              </button>
              <p className="mt-1.5 text-ui-sm leading-relaxed text-studio-ink-3">
                Or pick an existing photo in the <b>Assets</b> tab, or paste a URL below.
              </p>
            </Section>
            <Section title="Image URL">
              <input
                key={`iu${el.id}`}
                defaultValue={el.image.url}
                placeholder="https://…  (or use the Design Helper to add a photo)"
                onBlur={(e) => set({ image: { ...el.image!, url: e.target.value } })}
                data-agent-id="mag.el-image-url"
                data-agent-label="Selected image's URL"
                className="w-full rounded-sm border border-studio-edge bg-studio-raise px-2 py-1.5 text-ui-sm text-studio-ink outline-none focus:border-studio-edge-strong"
              />
            </Section>
            <Section title="Fit">
              <Choice<'cover' | 'contain'>
                value={el.image.fit}
                options={[
                  { value: 'cover', label: 'Cover', title: 'Cover — fill the box, cropping the edges', agentId: 'mag.el-fit-cover' },
                  { value: 'contain', label: 'Contain', title: 'Contain — show the whole picture', agentId: 'mag.el-fit-contain' },
                ]}
                onChange={(v) => set({ image: { ...el.image!, fit: v } })}
              />
            </Section>
          </>
        )}

        {el.type === 'shape' && el.shape && (
          <Section title="Fill">
            {/* The opacity is kept: a scrim's see-through is part of what it is. */}
            <Anchor id="mag.el-shape-fill" label="Shape fill colour (#rrggbb)" on={HEX_FIELD}>
              <ColorControl value={el.shape.fill} onChange={(c) => set({ shape: { ...el.shape!, fill: c } })} />
            </Anchor>
          </Section>
        )}

        {el.type === 'qr' && el.qr && (
          <>
            <Section title="Link">
              <input
                key={`qu${el.id}`}
                defaultValue={el.qr.url}
                placeholder="https://…"
                onBlur={(e) => set({ qr: { ...el.qr!, url: e.target.value } })}
                data-agent-id="mag.el-qr-url"
                data-agent-label="QR code link"
                className="w-full rounded-sm border border-studio-edge bg-studio-raise px-2 py-1.5 text-ui-sm text-studio-ink outline-none focus:border-studio-edge-strong"
              />
            </Section>
            <Section title="Dark">
              <Anchor id="mag.el-qr-fg" label="QR code dark colour (#rrggbb)" on={HEX_FIELD}>
                <ColorControl value={el.qr.fg} onChange={(c) => set({ qr: { ...el.qr!, fg: c } })} />
              </Anchor>
            </Section>
            <Section title="Light">
              <Anchor id="mag.el-qr-bg" label="QR code light colour (#rrggbb)" on={HEX_FIELD}>
                <ColorControl value={el.qr.bg} onChange={(c) => set({ qr: { ...el.qr!, bg: c } })} />
              </Anchor>
            </Section>
          </>
        )}

        {el.type === 'icon' && el.icon && (
          <>
            <Section title="Icon">
              <div className="grid max-h-56 grid-cols-6 gap-1 overflow-y-auto rounded-sm border border-studio-hair bg-studio-raise p-1.5">
                {ICON_NAMES.map((name) => {
                  const Glyph = resolveIcon(name);
                  const active = el.icon!.name === name;
                  return (
                    <button
                      key={name}
                      title={name}
                      data-agent-id={`mag.el-icon-${name}`}
                      data-agent-label={`Icon: ${name}`}
                      aria-pressed={active}
                      onClick={() => set({ icon: { ...el.icon!, name, src: undefined } })}
                      className={
                        'flex aspect-square items-center justify-center rounded-sm border p-1 ' +
                        (active ? 'border-studio-gold bg-studio-gold/20 text-studio-ink' : 'border-transparent text-studio-ink-2 hover:bg-studio-raise-2 hover:text-studio-ink')
                      }
                    >
                      <Glyph size={16} />
                    </button>
                  );
                })}
              </div>
              {el.icon.src && <p className="mt-1.5 text-ui-sm text-studio-ink-3">A custom uploaded icon is in use; pick a glyph above to replace it.</p>}
            </Section>
            <Section title="Colour">
              <Anchor id="mag.el-icon-color" label="Icon colour (#rrggbb)" on={HEX_FIELD}>
                <ColorControl value={el.icon.color ?? '#111111'} onChange={(c) => set({ icon: { ...el.icon!, color: c } })} />
              </Anchor>
            </Section>
          </>
        )}

        {/* Position & size — shared across kinds */}
        <Section title="Position & size">
          <div className="grid grid-cols-2 gap-2">
            <div><p className="mb-1 text-ui-sm text-studio-ink-3">X</p><Anchor id="mag.el-x" label="Left edge (x) in px"><Stepper value={Math.round(el.x)} min={0} max={5000} suffix="px" onChange={(v) => set({ x: v })} /></Anchor></div>
            <div><p className="mb-1 text-ui-sm text-studio-ink-3">Y</p><Anchor id="mag.el-y" label="Top edge (y) in px"><Stepper value={Math.round(el.y)} min={0} max={5000} suffix="px" onChange={(v) => set({ y: v })} /></Anchor></div>
            <div><p className="mb-1 text-ui-sm text-studio-ink-3">W</p><Anchor id="mag.el-w" label="Width in px"><Stepper value={Math.round(el.w)} min={2} max={5000} suffix="px" onChange={(v) => set({ w: v })} /></Anchor></div>
            <div><p className="mb-1 text-ui-sm text-studio-ink-3">H</p><Anchor id="mag.el-h" label="Height in px"><Stepper value={Math.round(el.h)} min={2} max={5000} suffix="px" onChange={(v) => set({ h: v })} /></Anchor></div>
          </div>
        </Section>

        <Section title="Rotation">
          <Anchor id="mag.el-rotation" label="Rotation in degrees">
            <Stepper value={Math.round(el.rotation)} min={-180} max={180} step={1} suffix="°" onChange={(v) => set({ rotation: v })} />
          </Anchor>
        </Section>

        <Section title="Arrange">
          <div className="grid grid-cols-2 gap-2">
            <button onClick={bringToFront} data-agent-id="mag.el-to-front" className="flex items-center justify-center gap-1.5 rounded-sm border border-studio-edge bg-studio-raise px-2 py-1.5 text-ui-sm text-studio-ink-2 hover:bg-studio-raise-2">
              <BringToFront size={13} /> To front
            </button>
            <button onClick={sendToBack} data-agent-id="mag.el-to-back" className="flex items-center justify-center gap-1.5 rounded-sm border border-studio-edge bg-studio-raise px-2 py-1.5 text-ui-sm text-studio-ink-2 hover:bg-studio-raise-2">
              <SendToBack size={13} /> To back
            </button>
          </div>
        </Section>

        <div className="flex flex-col gap-2 px-3.5 py-3">
          <button
            onClick={() => void duplicateElement(el.id)}
            data-agent-id="mag.el-duplicate"
            className="flex w-full items-center justify-center gap-2 rounded-sm border border-studio-edge bg-studio-raise px-3 py-2 text-ui-sm font-semibold text-studio-ink-2 hover:bg-studio-raise-2"
          >
            <Copy size={13} /> Duplicate element
          </button>
          <button
            onClick={() => void deleteElement(el.id)}
            data-agent-id="mag.el-delete"
            className="flex w-full items-center justify-center gap-2 rounded-sm border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-ui-sm font-semibold text-rose-300 hover:bg-rose-500/20"
          >
            <Trash2 size={13} /> Delete element
          </button>
        </div>
      </div>
    </div>
  );
}

// ── The media panel: three doors onto the same library ────────────────────────
//
//   In this magazine — what is already here (uploads, PDF extracts, anything the
//                      other two doors have added). Click to place.
//   Find a photo     — search Pexels and pick one. The server downloads the bytes
//                      into our own bucket, so the picture is ours and does not
//                      depend on a third party's CDN.
//   Generate         — describe a picture that does not exist and have the image
//                      model render it.
//
// Both new doors ADD TO THE LIBRARY FIRST and place second, which is the whole
// reason they belong in this panel rather than being one-shot inserts: a photo
// sourced once can be re-placed, alt-edited and reused on any page, exactly like
// an upload. Each hides itself when this server has no key for it — an offer the
// server cannot honour is worse than no offer.
function AssetsTab() {
  const issueId = useEditorStore((s) => s.issueId);
  const selectedId = useEditorStore((s) => s.selectedId);
  const page = useEditorStore((s) => s.page);
  const commit = useEditorStore((s) => s.commit);
  const addElement = useEditorStore((s) => s.addElement);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'library' | 'find' | 'make'>('library');
  const [sources, setSources] = useState<api.MediaSources>({ stock: false, generate: false });

  useEffect(() => {
    if (!issueId) return;
    let active = true;
    setLoading(true);
    api.listMedia(issueId)
      .then((a) => { if (active) setAssets(a); })
      .catch(() => {})
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
    // Re-fetch when the page's rev changes (a stock/AI add creates new media).
  }, [issueId, page?.rev]);

  // Which doors this server can open. Asked once per magazine; a failure leaves
  // both false, so the panel degrades to the library it has always been.
  useEffect(() => {
    if (!issueId) return;
    let active = true;
    api.mediaSources(issueId)
      .then((s) => { if (active) setSources(s); })
      .catch(() => {});
    return () => { active = false; };
  }, [issueId]);

  const selEl = page?.elements.find((e) => e.id === selectedId) ?? null;

  // A designed picture — chart, logo, poster, illustration (media kind 'graphic') —
  // must show WHOLE: 'cover' cropped its axis labels, its legend, the ends of a
  // logo. A photo keeps 'cover' (and a replaced photo keeps the box's own fit).
  // New pictures go on top, in their own shape when the size is known.
  const place = (a: MediaAsset) => {
    const graphic = isGraphicAsset(a);
    if (selEl && selEl.type === 'image' && selEl.image) {
      void commit(
        selEl.id,
        { image: { ...selEl.image, url: a.url, assetId: a.id, alt: a.alt, ...(graphic ? { fit: 'contain' as const } : {}) } },
        { ...selEl },
      );
    } else if (page) {
      void addElement({
        type: 'image',
        ...imageBoxFor(a, page),
        rotation: 0,
        zIndex: zForNew(page.elements),
        locked: false,
        source: 'manual',
        image: { url: a.url, assetId: a.id, alt: a.alt, fit: graphic ? 'contain' : 'cover' },
      });
    }
  };

  /** A new row from Find or Generate: into the library, onto the page, and back
   *  to the library view so the user can see where it went. */
  const acceptNew = (a: MediaAsset) => {
    setAssets((prev) => [a, ...prev]);
    place(a);
    setMode('library');
  };

  // The orientation to ASK FOR: the shape of the box it is going into, so a
  // portrait slot gets portrait candidates rather than a crop of a wide photo.
  const wantedOrientation = (): 'portrait' | 'landscape' | 'square' | undefined => {
    if (!selEl || selEl.type !== 'image') return undefined;
    const ratio = selEl.w / Math.max(1, selEl.h);
    return ratio > 1.2 ? 'landscape' : ratio < 0.85 ? 'portrait' : 'square';
  };

  const modeBtn = (id: 'library' | 'find' | 'make', label: string, icon: ReactNode) => (
    <button
      onClick={() => setMode(id)}
      data-agent-id={`mag.assets-mode-${id}`}
      aria-pressed={mode === id}
      className={
        'flex flex-1 items-center justify-center gap-1 rounded-sm px-2 py-1.5 text-ui-sm font-semibold transition-colors ' +
        (mode === id ? 'bg-studio-raise-2 text-studio-ink' : 'text-studio-ink-3 hover:text-studio-ink-2')
      }
    >
      {icon} {label}
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      {(sources.stock || sources.generate) && (
        <div className="flex flex-shrink-0 gap-1 border-b border-studio-hair bg-studio-raise p-1">
          {modeBtn('library', 'In magazine', <Images size={12} />)}
          {sources.stock && modeBtn('find', 'Find photo', <Search size={12} />)}
          {sources.generate && modeBtn('make', 'Generate', <Sparkles size={12} />)}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {mode === 'find' && issueId ? (
          <StockFinder issueId={issueId} orientation={wantedOrientation()} onAdded={acceptNew} />
        ) : mode === 'make' && issueId ? (
          <ImageGenerator
            issueId={issueId}
            orientation={wantedOrientation()}
            aspectRatio={selEl?.type === 'image' ? boxAspectRatio(selEl.w, selEl.h) ?? undefined : undefined}
            onAdded={acceptNew}
          />
        ) : (
          <MediaLibrary
            assets={assets}
            loading={loading}
            forSelectedImage={selEl?.type === 'image'}
            canFind={sources.stock}
            canMake={sources.generate}
            onFind={() => setMode('find')}
            onMake={() => setMode('make')}
            onPlace={place}
          />
        )}
      </div>
    </div>
  );
}

/** The library grid — what this panel has always been, now one view of three. */
function MediaLibrary({
  assets, loading, forSelectedImage, canFind, canMake, onFind, onMake, onPlace,
}: {
  assets: MediaAsset[];
  loading: boolean;
  forSelectedImage: boolean;
  canFind: boolean;
  canMake: boolean;
  onFind: () => void;
  onMake: () => void;
  onPlace: (a: MediaAsset) => void;
}) {
  if (loading) {
    return (
      <div className="p-3">
        <p className="mb-2 text-ui text-studio-ink-3" role="status" aria-live="polite">
          <ShimmerText>Loading your media</ShimmerText>
        </p>
        {/* Thumb-shaped placeholders in the real grid, so the panel doesn't jump. */}
        <div className="grid grid-cols-3 gap-1.5" aria-hidden="true">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="aspect-square rounded-sm border border-studio-hair bg-studio-raise" />
          ))}
        </div>
      </div>
    );
  }
  if (assets.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <Images size={26} className="mb-3 text-studio-ink-4" />
        <p className="text-ui font-semibold text-studio-ink-2">No media yet</p>
        <p className="mt-1 text-ui-sm leading-relaxed text-studio-ink-3">
          Photos appear here when you generate a magazine, import a PDF, or ask the Design Helper to add a photo.
        </p>
        {/* An empty library is exactly when the other two doors are the answer,
            so say so here rather than making someone find the tabs above. */}
        {(canFind || canMake) && (
          <div className="mt-4 flex w-full flex-col gap-1.5">
            {canFind && (
              <button
                onClick={onFind}
                data-agent-id="mag.assets-find"
                className="flex items-center justify-center gap-1.5 rounded-sm border border-studio-edge bg-studio-raise px-3 py-2 text-ui-sm font-semibold text-studio-ink-2 hover:bg-studio-raise-2"
              >
                <Search size={13} /> Find a photo
              </button>
            )}
            {canMake && (
              <button
                onClick={onMake}
                data-agent-id="mag.assets-make"
                className="flex items-center justify-center gap-1.5 rounded-sm border border-studio-edge bg-studio-raise px-3 py-2 text-ui-sm font-semibold text-studio-ink-2 hover:bg-studio-raise-2"
              >
                <Sparkles size={13} /> Generate one with AI
              </button>
            )}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="p-3">
      <p className="mb-2 text-ui-sm text-studio-ink-3">
        {forSelectedImage ? 'Click a photo to set the selected image.' : 'Click a photo to place it on the page.'}
      </p>
      <div className="grid grid-cols-2 gap-2">
        {assets.map((a) => (
          <button
            key={a.id}
            onClick={() => onPlace(a)}
            data-agent-id={`mag.asset-${a.id}`}
            data-agent-label={`${forSelectedImage ? 'Use' : 'Place'} photo “${a.alt || a.kind}”`}
            className="relative aspect-[4/3] overflow-hidden rounded border border-studio-hair hover:border-studio-gold"
            title={a.alt || a.kind}
          >
            <img src={a.url} alt={a.alt} className="h-full w-full object-cover" />
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * FIND: search Pexels, pick one, and it is downloaded into this magazine.
 *
 * Nothing is stored until a result is clicked — the point of a picker is to offer
 * a choice you have not already committed to. Search is manual (Enter or the
 * button), not per-keystroke: every request spends the account's Pexels quota.
 */
function StockFinder({
  issueId, orientation, onAdded,
}: {
  issueId: string;
  orientation?: 'portrait' | 'landscape' | 'square';
  onAdded: (a: MediaAsset) => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<api.StockPhoto[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);

  const run = async () => {
    const query = q.trim();
    if (!query || searching) return;
    setSearching(true);
    try {
      setResults(await api.searchStock(issueId, query, orientation));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not search for photos.');
    } finally {
      setSearching(false);
    }
  };

  const choose = async (photo: api.StockPhoto) => {
    if (adding) return;
    setAdding(photo.id);
    try {
      onAdded(await api.addStockPhoto(issueId, photo.id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add that photo.');
    } finally {
      setAdding(null);
    }
  };

  return (
    <div className="p-3">
      <div className="flex gap-1.5">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void run(); }}
          placeholder="chestnut horse jumping"
          aria-label="Search stock photos"
          data-agent-id="mag.stock-query"
          className="min-w-0 flex-1 rounded-sm border border-studio-edge bg-studio-raise px-2 py-1.5 text-ui-sm text-studio-ink placeholder:text-studio-ink-4 focus:border-studio-gold focus:outline-none"
        />
        <button
          onClick={() => void run()}
          disabled={searching || !q.trim()}
          data-agent-id="mag.stock-search"
          className="flex items-center gap-1 rounded-sm border border-studio-edge bg-studio-raise px-2.5 py-1.5 text-ui-sm font-semibold text-studio-ink-2 hover:bg-studio-raise-2 disabled:opacity-40"
        >
          <Search size={13} /> {searching ? 'Searching…' : 'Search'}
        </button>
      </div>
      <p className="mt-1.5 text-ui-sm text-studio-ink-4">
        A few concrete words work best{orientation ? ` — showing ${orientation} photos to match the box` : ''}.
      </p>

      {searching && (
        <p className="mt-3 text-ui-sm text-studio-ink-3" role="status" aria-live="polite">
          <ShimmerText>Looking for photos</ShimmerText>
        </p>
      )}
      {!searching && results?.length === 0 && (
        <p className="mt-3 text-ui-sm leading-relaxed text-studio-ink-3">
          Nothing found for that. Try fewer, plainer words — or generate the picture instead.
        </p>
      )}
      {!searching && results && results.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {results.map((p) => (
            <button
              key={p.id}
              onClick={() => void choose(p)}
              disabled={adding !== null}
              data-agent-id={`mag.stock-result-${p.id}`}
              data-agent-label={`Add stock photo “${p.alt || p.id}”`}
              title={p.alt}
              className="relative aspect-[4/3] overflow-hidden rounded border border-studio-hair hover:border-studio-gold disabled:opacity-50"
            >
              <img src={p.thumbUrl} alt={p.alt} loading="lazy" className="h-full w-full object-cover" />
              {adding === p.id && (
                <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-ui-sm font-semibold text-white">
                  Adding…
                </span>
              )}
              {/* Pexels does not require the credit; the photographer deserves it. */}
              {p.attribution.author && (
                <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1 py-0.5 text-left text-[10px] text-white/90">
                  {p.attribution.author}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The four looks a generated picture can take (server: imagePrompt.ts). A chart is
 *  not one of them — charts are DRAWN from the numbers, never imagined. */
const IMAGE_STYLE_OPTIONS: { value: ImageStyle; label: string; hint: string; placeholder: string }[] = [
  {
    value: 'photo',
    label: 'Photo',
    hint: 'An editorial photograph. Photos never carry words.',
    placeholder: 'A quiet stable aisle at dawn, light through the doorway, hay dust in the air',
  },
  {
    value: 'illustration',
    label: 'Illustration',
    hint: 'A drawn or painted picture, not a photo. Put any words it should show in "quotes".',
    placeholder: 'A watercolour of a mare and foal in a paddock at sunset',
  },
  {
    value: 'graphic',
    label: 'Graphic',
    hint: 'A flat, simple designed element on a plain ground. Put any words in "quotes".',
    placeholder: 'A bold badge with a horseshoe and the words "Owners Day"',
  },
  {
    value: 'poster',
    label: 'Poster',
    hint: 'A complete poster composition. Write its words in "quotes" — they are spelled exactly as written.',
    placeholder: 'A race-day poster, a galloping horse, headline "Spring Carnival 2027"',
  },
];

/**
 * GENERATE: describe a picture and have the image model render it.
 *
 * Deliberately the second tab, not the first. A real photograph beats a rendered
 * one for anything a camera could have taken, which is also the order automatic
 * generation uses; this is for the pictures no search will ever return.
 *
 * A STYLE, because "make an image" is not always a photo: an illustration, a flat
 * graphic or a poster may carry the words the user asks for, where a photo never
 * does. It used to be photo-only, so every poster or illustration came back as a
 * text-free photograph.
 *
 * NEVER A CHART. An image model cannot plot numbers — it invents the bars and the
 * labels — so the server refuses a chart-like request (400, hint 'chart') and this
 * panel says where charts are made instead. The one way through is a purely
 * decorative illustration with no real data in it, which is offered explicitly.
 *
 * One call is slow (tens of seconds) and paid, so the button states plainly what
 * is happening and stays disabled for the duration rather than inviting a second
 * identical request.
 */
function ImageGenerator({
  issueId, orientation, aspectRatio, onAdded,
}: {
  issueId: string;
  orientation?: 'portrait' | 'landscape' | 'square';
  /** The selected picture box's exact frame ("4:5"), when one is selected. */
  aspectRatio?: string;
  onAdded: (a: MediaAsset) => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [shape, setShape] = useState<'portrait' | 'landscape' | 'square'>(orientation ?? 'landscape');
  const [style, setStyle] = useState<ImageStyle>('photo');
  /** The last request was refused as a chart (cleared by any change to it). */
  const [chartRefused, setChartRefused] = useState(false);
  const styleMeta = IMAGE_STYLE_OPTIONS.find((o) => o.value === style) ?? IMAGE_STYLE_OPTIONS[0]!;
  // The selected box's own frame, while the Shape control still says that box's shape:
  // the picture then comes back exactly fitting the box instead of a generic wide or
  // tall frame that gets cropped. Choosing another shape means the person wants that.
  const boxFrame = aspectRatio && orientation && shape === orientation ? aspectRatio : undefined;

  const run = async (decorative = false) => {
    const text = prompt.trim();
    if (!text || busy) return;
    setBusy(true);
    setChartRefused(false);
    try {
      onAdded(
        await api.generateMediaImage(issueId, text, shape, {
          style,
          ...(decorative ? { decorative: true } : {}),
          ...(boxFrame ? { aspectRatio: boxFrame } : {}),
        }),
      );
    } catch (e) {
      if (api.isChartRefusal(e)) setChartRefused(true);
      toast.error(e instanceof Error ? e.message : 'Could not generate that image.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-3">
      <div className="mb-2">
        <p className="mb-1 text-ui-sm text-studio-ink-3">Style</p>
        <div data-agent-id="mag.imagegen-style" data-agent-label="Image style">
          <Segmented<ImageStyle>
            value={style}
            onChange={(v) => { setStyle(v); setChartRefused(false); }}
            options={IMAGE_STYLE_OPTIONS.map((o) => ({ value: o.value, label: o.label, title: o.hint }))}
          />
        </div>
        <p className="mt-1 text-ui-sm leading-relaxed text-studio-ink-4">{styleMeta.hint}</p>
      </div>
      <textarea
        value={prompt}
        onChange={(e) => { setPrompt(e.target.value); setChartRefused(false); }}
        rows={4}
        placeholder={styleMeta.placeholder}
        aria-label="Describe the image to generate"
        data-agent-id="mag.imagegen-prompt"
        className="w-full resize-none rounded-sm border border-studio-edge bg-studio-raise px-2 py-1.5 text-ui-sm leading-relaxed text-studio-ink placeholder:text-studio-ink-4 focus:border-studio-gold focus:outline-none"
      />
      <div className="mt-2">
        <p className="mb-1 text-ui-sm text-studio-ink-3">
          Shape{boxFrame ? <span className="text-studio-ink-4"> — made to the selected box ({boxFrame})</span> : null}
        </p>
        <Segmented
          value={shape}
          onChange={(v) => setShape(v as 'portrait' | 'landscape' | 'square')}
          options={[
            { value: 'landscape', label: 'Wide' },
            { value: 'portrait', label: 'Tall' },
            { value: 'square', label: 'Square' },
          ]}
        />
      </div>
      <button
        onClick={() => void run()}
        disabled={busy || !prompt.trim()}
        aria-busy={busy}
        data-agent-id="mag.imagegen-submit"
        className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-sm border border-studio-edge bg-studio-raise px-3 py-2 text-ui-sm font-semibold text-studio-ink-2 hover:bg-studio-raise-2 disabled:opacity-40"
      >
        <Sparkles size={13} />
        {busy ? 'Generating…' : 'Generate image'}
      </button>
      {busy && (
        <p className="mt-2 text-ui-sm text-studio-ink-3" role="status" aria-live="polite">
          <ShimmerText>Rendering your image — this takes a few seconds</ShimmerText>
        </p>
      )}
      {chartRefused && (
        <div
          role="alert"
          data-agent-id="mag.imagegen-chart-refused"
          className="mt-2 rounded-sm border border-amber-400/30 bg-amber-400/10 p-2 text-ui-sm leading-relaxed text-amber-100"
        >
          <p>
            Charts are drawn from your numbers, not generated — an image model would invent the bars and the labels.
            Ask the Design Helper or the AI Assistant to “add a bar chart of …” with your exact figures, and it is drawn to scale in this magazine's colours.
          </p>
          {style === 'illustration' ? (
            <button
              onClick={() => void run(true)}
              disabled={busy}
              data-agent-id="mag.imagegen-decorative"
              className="mt-1.5 w-full rounded-sm border border-amber-300/40 px-2 py-1.5 font-semibold text-amber-50 hover:bg-amber-400/15 disabled:opacity-40"
            >
              Make a decorative illustration instead (no real numbers)
            </button>
          ) : (
            <p className="mt-1 text-amber-200/80">
              Only a purely decorative picture with no real data can be generated — choose Illustration for that.
            </p>
          )}
        </div>
      )}
      <p className="mt-2 text-ui-sm leading-relaxed text-studio-ink-4">
        No real people, and photos carry no words. For an ordinary photograph of a real subject,
        <b className="text-studio-ink-3"> Find photo</b> usually looks better. For a chart, ask the Design Helper — it draws one from your exact numbers.
      </p>
    </div>
  );
}
