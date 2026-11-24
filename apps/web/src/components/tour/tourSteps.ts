// ---------------------------------------------------------------------------
// The tour's words and what each step points at. Pure — no React — so the copy
// can be read (and changed) in one place.
//
// TWO VARIANTS, picked by where the person lands:
//   magazine  — the magazine editor. Someone joining because a magazine was shared
//               with them lands INSIDE it (the invite's redirect), so the tour
//               points at the real controls in front of them.
//   campaign  — anywhere else in the Campaign Engine (a Team-screen invite lands on
//               its home), pointing at the sidebar.
// Both are four steps (welcome, where the work is, the AI Assistant's button,
// then the panel it opens — talk or attach a PDF) and END ON THE AI ASSISTANT:
// the one thing every newcomer should leave knowing about.
//
// PANEL: the launcher only shows while the assistant is closed, and the composer
// only while it is open — so a step says which it needs (`panel`) and the tour
// opens / closes it on arrival, Back included.
//
// TARGETS are comma-separated CSS selectors, tried in order (first one showing
// wins) — so list the preferred target first. Most reuse the Stable Hand's own `data-agent-id`
// anchors, which already name these controls; `data-tour` marks the few that
// had none. A step whose target isn't on screen:
//   optional: true   is skipped (e.g. no review button on a phone, or for a role
//                    that can't edit — no point describing a missing control)
//   otherwise        is shown as a centred card, so the story still reads.
// A step with no target is always a centred card.
// ---------------------------------------------------------------------------

export type TourVariant = 'magazine' | 'campaign';

/**
 * A control inside the AI Assistant's composer, explained on the composer step
 * (with the same icon as the real button, which shows in the cut-out above).
 *   voice   — the microphone. Only listed where it will actually be there (the
 *             server has voice on and this browser can record), as the panel does.
 *   attach  — the paperclip: a PDF or a photo.
 */
export type TourHighlight = 'voice' | 'attach';

export const TOUR_HIGHLIGHT_COPY: Record<TourHighlight, { title: string; body: string }> = {
  voice: {
    title: 'Talk instead of typing',
    body: 'Press the microphone, say what you need, then press it again to send.',
  },
  attach: {
    title: 'Share a PDF or photo',
    body: 'Press the paperclip to add a PDF or picture, then ask about it.',
  },
};

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** Composer controls to show on the card (see TourHighlight). */
  highlights?: TourHighlight[];
  /** Title/body to use when there is no microphone (voice off, or the browser
   *  can't record) — so the step never promises a button that isn't there. */
  withoutVoice?: { title: string; body: string };
  /** The AI Assistant panel this step needs: opened or closed on arrival. */
  panel?: 'open' | 'closed';
  /** A soft gold pulse round the target. Meant for a small button: on a wide
   *  target the expanding ring would swamp the screen. */
  pulse?: boolean;
  /** Selector list — the first match that is actually visible wins. */
  target?: string;
  optional?: boolean;
  /** The AI Assistant step: gets the co-pilot treatment (and the final buttons). */
  copilot?: boolean;
}

const STABLE_HAND: TourStep = {
  id: 'stablehand',
  title: 'Meet your AI Assistant',
  body:
    'Click this gold button whenever you need anything. Just type what you want in your own words, for example "share this page with Sam", and your AI Assistant will do it for you. It always asks you before sending or sharing anything.',
  target: '[data-tour="stablehand"]',
  copilot: true,
  panel: 'closed',
  pulse: true,
};

// The panel that button opens, pointing at the real composer row: the paperclip
// on the left, the microphone beside Send.
const ASSISTANT_COMPOSER: TourStep = {
  id: 'assistant-composer',
  title: 'Talk to it, or share a file',
  body: 'This is where you tell your AI Assistant what to do. Type here, or use these buttons:',
  withoutVoice: {
    title: 'Share a PDF or photo',
    body: 'This is where you tell your AI Assistant what to do. Type here, or use this button:',
  },
  target: '[data-tour="assistant-composer"]',
  copilot: true,
  panel: 'open',
  highlights: ['voice', 'attach'],
};

// Kept deliberately short: the people joining are often new to tools like this,
// so the tour shows only TWO things: where their work is, and who can help.
const STEPS: Record<TourVariant, TourStep[]> = {
  magazine: [
    {
      id: 'welcome',
      title: 'Welcome to Stable Press',
      body: 'A magazine has been shared with you. Here is a very short tour.',
    },
    {
      id: 'canvas',
      title: 'This is your page',
      body: 'Click any words or picture on the page to change them. Your changes are saved for you.',
      target: '[data-tour="mag-canvas"]',
    },
    STABLE_HAND,
    ASSISTANT_COMPOSER,
  ],
  campaign: [
    {
      id: 'welcome',
      title: 'Welcome to Stable Press',
      body: 'You have joined the team. Here is a very short tour.',
    },
    {
      id: 'sidebar',
      title: 'Your menu',
      body: 'Everything you can work on is listed here. Click a name to open it.',
      target: '[data-tour="ce-sidebar"]',
      optional: true,
    },
    STABLE_HAND,
    ASSISTANT_COMPOSER,
  ],
};

export function tourSteps(variant: TourVariant): TourStep[] {
  return STEPS[variant];
}

/** Which tour fits this screen, or null when it isn't a staff screen at all
 *  (the public site, sign-in, an invite link) — no tour runs there. */
export function tourVariantFor(pathname: string): TourVariant | null {
  const seg = pathname.split('/').filter(Boolean);
  if (seg[0] !== 'production-system') return null;
  if (seg[1] === 'magazine-v2' && seg[2]) return 'magazine';
  return 'campaign';
}
