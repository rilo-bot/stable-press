// ---------------------------------------------------------------------------
// The first-run product tour — a short "Next, Next, Next" walk round the screen
// a newcomer lands on, ending on The Stable Hand.
//
// WHEN IT RUNS (mounted once, in App.tsx):
//   - the account has `tourPending` (set by the server when they joined the team
//     through an invite link — see stores/tourStore.ts), or a replay was asked
//     for from The Stable Hand; and
//   - they are on a staff screen (tourVariantFor). It waits for that screen to
//     finish loading before it points at anything.
// Finishing OR skipping ends it for good on that account (completeTour). A replay
// never touches the server.
//
// HOW IT LOOKS: the page dims except for a cut-out round the control being
// described (a box-shadow "hole", so the real control shows through untouched),
// with a card beside it. The page underneath is not clickable while the tour is
// up — it is a guided look, not a sandbox — and its keyboard shortcuts are held
// off, so an arrow key can't nudge a picture on the magazine canvas.
//
// Keyboard: → / ← move, Esc skips, Tab stays inside the card. Focus returns to
// where it was when the tour closes.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { useReducedMotion } from 'framer-motion';
import { ArrowLeft, ArrowRight, Mic, Paperclip, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/stores/authStore';
import { useAgentUi } from '@/stores/agentUiStore';
import { useTourStore } from '@/stores/tourStore';
import { isRecordingSupported, isVoiceEnabled } from '@/agent/voice/voiceClient';
import { TOUR_HIGHLIGHT_COPY, tourSteps, tourVariantFor, type TourStep, type TourVariant } from './tourSteps';

const HIGHLIGHT_ICON = { voice: Mic, attach: Paperclip } as const;

/** What must be on screen before the tour starts pointing at things. */
const READY_SELECTOR: Record<TourVariant, string> = {
  // The editor shows a loading screen until the magazine arrives; the canvas
  // column appears with it.
  magazine: '[data-tour="mag-canvas"]',
  campaign: '[data-tour="ce-sidebar"], [data-tour="ce-account"]',
};
/** Give up waiting and start anyway (centred cards still read fine). */
const READY_TIMEOUT_MS = 10_000;
/** A beat after the screen appears, so the tour doesn't land mid-layout. */
const SETTLE_MS = 600;

const MARGIN = 16; // from the window edge
const GAP = 12; // between the target and the card
const PAD = 6; // round the target, inside the cut-out
const CARD_W = 420;
const NARROW = 640; // below this the card docks to the top / bottom edge

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
  /** The cut-out follows the target's own shape: a round button gets a round hole. */
  round: boolean;
}

/**
 * The element a step points at: its selectors tried IN THE ORDER WRITTEN, first
 * one that is actually showing wins. (Not one querySelectorAll over the whole
 * list — that returns matches in document order, so "the AI panel, else its
 * toggle" picked the toggle, which comes first in the page.) Selectors are split
 * on commas, so a step's target must not use a comma inside a single selector.
 */
function findTarget(step: TourStep | undefined): HTMLElement | null {
  if (!step?.target) return null;
  for (const selector of step.target.split(',').map((x) => x.trim()).filter(Boolean)) {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden') return el;
    }
  }
  return null;
}

function rectOf(el: HTMLElement | null): Rect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  // Clipped to the window: a target taller than the screen (the canvas) would
  // otherwise put the cut-out's edges, and the card placement, off-screen.
  const top = Math.max(r.top, 0);
  const left = Math.max(r.left, 0);
  const bottom = Math.min(r.bottom, window.innerHeight);
  const right = Math.min(r.right, window.innerWidth);
  if (bottom <= top || right <= left) return null;
  const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
  return { top, left, width: right - left, height: bottom - top, round: radius >= Math.min(r.width, r.height) / 2 - 1 };
}

const sameRect = (a: Rect | null, b: Rect | null) =>
  a === b || (!!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height && a.round === b.round);

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** Where the card goes: beside the target if there's room (below, above, right,
 *  left, in that order), otherwise over it; centred when there is no target.
 *  Narrow screens dock it to whichever edge is away from the target. */
function placeCard(target: Rect | null, cw: number, ch: number): CSSProperties {
  const W = window.innerWidth;
  const H = window.innerHeight;
  if (W < NARROW) {
    const width = W - MARGIN * 2;
    const targetLow = !!target && target.top + target.height / 2 > H / 2;
    return targetLow ? { left: MARGIN, top: MARGIN, width } : { left: MARGIN, bottom: MARGIN, width };
  }
  const width = Math.min(CARD_W, W - MARGIN * 2);
  if (!target) return { left: (W - width) / 2, top: clamp((H - ch) / 2, MARGIN, H - ch - MARGIN), width };

  const t = { top: target.top - PAD, left: target.left - PAD, bottom: target.top + target.height + PAD, right: target.left + target.width + PAD };
  const centreX = clamp(target.left + target.width / 2 - width / 2, MARGIN, W - width - MARGIN);
  const centreY = clamp(target.top + target.height / 2 - ch / 2, MARGIN, H - ch - MARGIN);
  if (t.bottom + GAP + ch <= H - MARGIN) return { left: centreX, top: t.bottom + GAP, width };
  if (t.top - GAP - ch >= MARGIN) return { left: centreX, top: t.top - GAP - ch, width };
  if (t.right + GAP + width <= W - MARGIN) return { left: t.right + GAP, top: centreY, width };
  if (t.left - GAP - width >= MARGIN) return { left: t.left - GAP - width, top: centreY, width };
  // A target that fills the screen (the canvas): sit over it, near its top.
  return { left: centreX, top: clamp(target.top + 24, MARGIN, H - ch - MARGIN), width };
}

/** Wait (polling) until `selector` matches something on screen, or time out. */
function whenOnScreen(selector: string, timeoutMs: number, signal: { cancelled: boolean }): Promise<void> {
  const started = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      if (signal.cancelled) return;
      const hit = Array.from(document.querySelectorAll<HTMLElement>(selector)).some((el) => el.getBoundingClientRect().width > 0);
      if (hit || Date.now() - started > timeoutMs) resolve();
      else setTimeout(check, 200);
    };
    check();
  });
}

export function ProductTour() {
  const isAdmin = useAuthStore((s) => s.currentUser?.isAdmin === true);
  const tourPending = useAuthStore((s) => s.currentUser?.tourPending === true);
  const userId = useAuthStore((s) => s.currentUser?.id);
  const completeTour = useAuthStore((s) => s.completeTour);
  const { pathname } = useLocation();
  const variantHere = tourVariantFor(pathname);

  const active = useTourStore((s) => s.active);
  const variant = useTourStore((s) => s.variant);
  const index = useTourStore((s) => s.index);
  const replayRequested = useTourStore((s) => s.replayRequested);
  const isReplay = useTourStore((s) => s.isReplay);

  // The steps for THIS run, fixed when it starts: optional steps whose control
  // isn't on screen are dropped then, so "2 of 5" is honest from the first card.
  const [steps, setSteps] = useState<TourStep[]>([]);

  // ── Start ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (active || !isAdmin || !variantHere) return;
    if (!tourPending && !replayRequested) return;
    const signal = { cancelled: false };
    void (async () => {
      // Asked alongside the wait, not after it: the answer is cached per session,
      // and the panel itself uses it to decide whether its mic button shows.
      const voice = isRecordingSupported() ? isVoiceEnabled() : Promise.resolve(false);
      await whenOnScreen(READY_SELECTOR[variantHere], READY_TIMEOUT_MS, signal);
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      const voiceReady = await voice;
      if (signal.cancelled) return;
      // The Stable Hand step points at its launcher, which only shows while the
      // panel is closed. The last card offers to open it again.
      useAgentUi.getState().setOpen(false);
      const all = tourSteps(variantHere);
      setSteps(
        all
          .filter((s) => !s.optional || !!findTarget(s))
          // Never describe a microphone this person won't find in the panel.
          .map((s) =>
            s.highlights && !voiceReady
              ? { ...s, ...s.withoutVoice, highlights: s.highlights.filter((h) => h !== 'voice') }
              : s,
          ),
      );
      useTourStore.getState().start(variantHere, !tourPending);
    })();
    return () => {
      signal.cancelled = true;
    };
  }, [active, isAdmin, tourPending, replayRequested, variantHere]);

  // ── Stop when the screen it describes goes away ──────────────────────────
  // (signed out, or navigated somewhere else). Not "completed": a pending tour
  // starts again, fitted to the new screen.
  useEffect(() => {
    if (active && (!isAdmin || variantHere !== variant)) useTourStore.getState().stop();
  }, [active, isAdmin, variantHere, variant]);

  // A different account in this browser must never inherit a run.
  useEffect(() => () => useTourStore.getState().stop(), [userId]);

  const finish = useCallback(
    (openCopilot: boolean) => {
      const replay = useTourStore.getState().isReplay;
      useTourStore.getState().stop();
      if (!replay) void completeTour();
      // The tour closed the panel when it started and opened it for the composer
      // step; it ends the way the person chose: open on "Try", closed otherwise.
      useAgentUi.getState().setOpen(openCopilot);
    },
    [completeTour],
  );

  if (!active || steps.length === 0) return null;
  const step = steps[Math.min(index, steps.length - 1)]!;
  return createPortal(
    <TourOverlay
      key={`${variant}-${isReplay ? 'r' : 'f'}`}
      step={step}
      index={Math.min(index, steps.length - 1)}
      total={steps.length}
      onBack={() => useTourStore.getState().go(Math.max(0, index - 1))}
      onNext={() => useTourStore.getState().go(Math.min(steps.length - 1, index + 1))}
      onFinish={finish}
    />,
    document.body,
  );
}

function TourOverlay({
  step,
  index,
  total,
  onBack,
  onNext,
  onFinish,
}: {
  step: TourStep;
  index: number;
  total: number;
  onBack: () => void;
  onNext: () => void;
  onFinish: (openCopilot: boolean) => void;
}) {
  const reduce = useReducedMotion();
  const titleId = useId();
  const bodyId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [target, setTarget] = useState<Rect | null>(null);
  const [cardStyle, setCardStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  const isLast = index === total - 1;

  // Open / close the AI Assistant for the steps that need it — on Back too, so
  // stepping back from the composer brings the launcher back. The target is
  // re-measured every frame, so the cut-out settles once the panel has slid in.
  useEffect(() => {
    if (step.panel) useAgentUi.getState().setOpen(step.panel === 'open');
  }, [step]);

  // Bring the target into view when the step changes (the review button can be
  // off to the side on a narrow window).
  useEffect(() => {
    findTarget(step)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  }, [step, reduce]);

  // Follow the target every frame: panes resize, the page scrolls, the editor
  // reflows. Cheap — one rect read — and only re-renders when it moved.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const next = rectOf(findTarget(step));
      setTarget((prev) => (sameRect(prev, next) ? prev : next));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [step]);

  // Place the card once its size is known (and whenever the target moves).
  useLayoutEffect(() => {
    const place = () => {
      const card = cardRef.current;
      if (!card) return;
      setCardStyle(placeCard(target, card.offsetWidth || CARD_W, card.offsetHeight || 200));
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [target, step]);

  // Focus: into the card on each step; back where it was when the tour closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    return () => before?.focus?.({ preventScroll: true });
  }, []);
  useEffect(() => {
    primaryRef.current?.focus({ preventScroll: true });
  }, [step]);

  // Keyboard. Capture phase on window, and propagation stopped: the page under
  // the tour (the magazine editor especially) has its own shortcuts — Delete,
  // arrows, Ctrl+Z — that must not fire while it's being looked at. The card's
  // own buttons still work: Enter/Space activate a focused button by default
  // action, which stopPropagation doesn't cancel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inCard = !!cardRef.current?.contains(e.target as Node);
      if (e.key === 'Escape') {
        e.preventDefault();
        onFinish(false);
      } else if (e.key === 'ArrowRight' && !isLast) {
        e.preventDefault();
        onNext();
      } else if (e.key === 'ArrowLeft' && index > 0) {
        e.preventDefault();
        onBack();
      } else if (e.key === 'Tab') {
        // Keep focus inside the card.
        const items = Array.from(cardRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? []);
        if (items.length > 0) {
          const first = items[0]!;
          const last = items[items.length - 1]!;
          if (!inCard) {
            e.preventDefault();
            first.focus();
          } else if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      } else if (!inCard) {
        // Typing aimed at the page underneath goes nowhere.
        e.preventDefault();
      }
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [index, isLast, onBack, onNext, onFinish]);

  const moving = reduce ? '' : 'transition-[top,left,width,height] duration-200 ease-out';

  return (
    <div className="fixed inset-0 z-[100] print:hidden" data-operator-ui="">
      {/* Blocks the page underneath. Clicking it does nothing on purpose — a stray
          click shouldn't throw away a tour someone is halfway through. */}
      <div className="absolute inset-0" aria-hidden onMouseDown={(e) => e.preventDefault()} />

      {target ? (
        <>
          <div
            aria-hidden
            className={`pointer-events-none absolute ${target.round ? 'rounded-full' : 'rounded-lg'} ${moving}`}
            style={{
              top: target.top - PAD,
              left: target.left - PAD,
              width: target.width + PAD * 2,
              height: target.height + PAD * 2,
              boxShadow: '0 0 0 2px var(--gold-bright), 0 0 0 9999px rgba(8, 14, 11, 0.62)',
            }}
          />
          {/* The launcher is the one to remember: a soft gold pulse draws the
              eye to it (none with reduced motion). */}
          {step.pulse && !reduce && (
            <div
              aria-hidden
              className={`pointer-events-none absolute animate-ping ${target.round ? 'rounded-full' : 'rounded-lg'}`}
              style={{
                top: target.top - PAD,
                left: target.left - PAD,
                width: target.width + PAD * 2,
                height: target.height + PAD * 2,
                border: '2px solid var(--gold-bright)',
                animationDuration: '1.8s',
              }}
            />
          )}
        </>
      ) : (
        <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: 'rgba(8, 14, 11, 0.62)' }} />
      )}

      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className={`absolute rounded-xl border border-border bg-card p-6 text-card-foreground shadow-2xl ${moving}`}
        style={cardStyle}
      >
        <div className="mb-3 flex items-center gap-2">
          {step.copilot && (
            <span
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full"
              style={{ background: 'linear-gradient(180deg, var(--forest-light) 0%, var(--forest-deep) 100%)', border: '1px solid var(--gold-mid)' }}
            >
              <img src="/images/favicon-gold.png" alt="" className="h-5 w-5 object-contain" />
            </span>
          )}
          <span className="text-sm font-semibold text-muted-foreground">
            Step {index + 1} of {total}
          </span>
          <button
            onClick={() => onFinish(false)}
            className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Skip the tour"
            title="Skip the tour"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <h2 id={titleId} className="mb-2 font-[family-name:var(--font-display)] text-2xl font-bold leading-snug text-foreground">
          {step.title}
        </h2>
        <p id={bodyId} className="text-base leading-relaxed text-foreground/85 sm:text-lg">
          {step.body}
        </p>

        {/* Composer controls, drawn like the real buttons showing in the cut-out
            so they're easy to match up. Not buttons here — nothing to press yet. */}
        {step.highlights && step.highlights.length > 0 && (
          <ul className="mt-4 space-y-3">
            {step.highlights.map((h) => {
              const Icon = HIGHLIGHT_ICON[h];
              const copy = TOUR_HIGHLIGHT_COPY[h];
              return (
                <li key={h} className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground"
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="text-sm leading-snug text-foreground/85 sm:text-base">
                    <span className="block font-semibold text-foreground">{copy.title}</span>
                    {copy.body}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {/* Progress — one segment per step. */}
        <div className="mt-5 flex gap-1.5" aria-hidden>
          {Array.from({ length: total }, (_, i) => (
            <span
              key={i}
              className="h-1.5 flex-1 rounded-full"
              style={{ background: i <= index ? 'var(--gold-bright)' : 'hsl(var(--muted))' }}
            />
          ))}
        </div>

        {isLast ? (
          // Last step: one big, obvious next move; the quieter choices underneath.
          <div className="mt-5 flex flex-col gap-2">
            <Button ref={primaryRef} size="lg" className="w-full text-base" onClick={() => onFinish(true)}>
              Try the AI Assistant
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="lg" onClick={onBack} className="flex-1 gap-1 px-4 text-base">
                <ArrowLeft className="h-4 w-4" /> Back
              </Button>
              <Button variant="outline" size="lg" className="flex-1 px-4 text-base" onClick={() => onFinish(false)}>
                Finish
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-5 flex items-center gap-2">
            <button onClick={() => onFinish(false)} className="text-base text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
              Skip tour
            </button>
            <div className="ml-auto flex items-center gap-2">
              {index > 0 && (
                <Button variant="outline" size="lg" onClick={onBack} className="gap-1 px-4 text-base">
                  <ArrowLeft className="h-4 w-4" /> Back
                </Button>
              )}
              <Button ref={primaryRef} size="lg" onClick={onNext} className="gap-1 px-5 text-base">
                Next <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
