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
// Both are three steps (welcome, where the work is, the AI Assistant) and END
// ON THE AI ASSISTANT: the one thing every newcomer should leave knowing about.
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

export interface TourStep {
  id: string;
  title: string;
  body: string;
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
