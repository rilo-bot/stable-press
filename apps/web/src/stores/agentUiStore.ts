// ---------------------------------------------------------------------------
// Tiny UI bus for The Stable Hand assistant. Lets any component (inline "Ask"
// buttons across the app) open the global assistant and optionally seed a
// first question. The AgentWidget owns the conversation; this carries where the
// assistant sits on screen + a one-shot pending prompt the widget consumes.
//
// Where it sits (components/StablehandShell.tsx draws it):
//   open=false                   closed — just the gold-horse launcher
//   open=true,  collapsed=false  the panel: docked on the right on desktop (the
//                                site is pushed left, like Claude in Chrome), a
//                                bottom sheet on tablets / phones
//   open=true,  collapsed=true   desktop: a slim rail on the right edge (the site
//                                gets its space back); smaller screens: the
//                                launcher, as if closed
//   wide                         the docked panel's wider size
//   width                        a width the user dragged the docked panel to
//                                (px; null = the preset from `wide`). Widen /
//                                Narrow clears it back to a preset.
//
// `collapsed`, `wide` and `width` are the user's preference, remembered in localStorage.
// Opening from a launcher / inline "Ask" button always opens the full panel; the
// once-per-session greeting (StablehandGreeting.tsx) opens in the remembered
// state, so someone who keeps it on the rail is greeted by the rail.
// ---------------------------------------------------------------------------

import { create } from 'zustand';

const PREFS_KEY = 'sp-stablehand-dock';

interface DockPrefs {
  collapsed: boolean;
  wide: boolean;
  width: number | null;
}

function readPrefs(): DockPrefs {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(PREFS_KEY) : null;
    const p = raw ? (JSON.parse(raw) as Partial<DockPrefs>) : {};
    const width = typeof p.width === 'number' && Number.isFinite(p.width) && p.width > 0 ? Math.round(p.width) : null;
    return { collapsed: p.collapsed === true, wide: p.wide === true, width };
  } catch {
    return { collapsed: false, wide: false, width: null };
  }
}

function writePrefs(p: DockPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage blocked (private mode) — the preference just isn't remembered */
  }
}

interface AgentUiState {
  /** The assistant is on screen — the full panel, or the rail when `collapsed`. */
  open: boolean;
  /** Docked as the slim rail instead of the full panel (remembered). */
  collapsed: boolean;
  /** The docked panel's wider size (remembered). */
  wide: boolean;
  /** The docked panel's dragged width in px, or null for the `wide` preset (remembered). */
  width: number | null;
  /** Phones / tablets: the "What can I do for you?" bubble over the launcher. */
  greetingBubble: boolean;
  /** A question queued by an inline trigger, sent once then cleared. */
  pendingPrompt: string | null;
  /** true opens the FULL panel (the user asked for it); false closes it. */
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** Open in the remembered state (rail or panel) — the landing greeting. */
  openRemembered: () => void;
  /** Collapse the open panel to the rail. */
  collapse: () => void;
  /** Rail → full panel. */
  expand: () => void;
  /** Pick a preset size — also drops any dragged width. */
  setWide: (wide: boolean) => void;
  /** The drag handle's result; null returns to the preset. */
  setWidth: (width: number | null) => void;
  setGreetingBubble: (show: boolean) => void;
  /** Open the full panel and queue a question to send. */
  ask: (prompt: string) => void;
  consumePrompt: () => void;
}

const initial = readPrefs();

export const useAgentUi = create<AgentUiState>((set, get) => {
  const savePrefs = () => writePrefs({ collapsed: get().collapsed, wide: get().wide, width: get().width });
  return {
    open: false,
    collapsed: initial.collapsed,
    wide: initial.wide,
    width: initial.width,
    greetingBubble: false,
    pendingPrompt: null,
    setOpen: (open) => {
      if (!open) return set({ open: false });
      set({ open: true, collapsed: false, greetingBubble: false });
      savePrefs();
    },
    toggle: () => get().setOpen(!(get().open && !get().collapsed)),
    openRemembered: () => set({ open: true, greetingBubble: false }),
    collapse: () => {
      set({ open: true, collapsed: true });
      savePrefs();
    },
    expand: () => get().setOpen(true),
    setWide: (wide) => {
      set({ wide, width: null });
      savePrefs();
    },
    setWidth: (width) => {
      set({ width: width == null ? null : Math.round(width) });
      savePrefs();
    },
    setGreetingBubble: (greetingBubble) => set({ greetingBubble }),
    ask: (prompt) => {
      get().setOpen(true);
      set({ pendingPrompt: prompt });
    },
    consumePrompt: () => set({ pendingPrompt: null }),
  };
});
