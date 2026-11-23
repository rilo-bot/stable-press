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
// Both END ON THE STABLE HAND: the co-pilot is the one thing every newcomer
// should leave knowing about.
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
  /** The Stable Hand step: gets the co-pilot treatment (and the final buttons). */
  copilot?: boolean;
}

const STABLE_HAND: TourStep = {
  id: 'stablehand',
  title: 'Meet your AI Assistant',
  body:
    'Your AI Assistant can help you with any task on this platform. Ask in plain words — "share page 2 with Sam", "tighten the copy on this page", "find a photo of a winning finish", "file a story" — and it does the work while you watch, step by step. It always checks with you before anything is published, shared or sent.',
  target: '[data-tour="stablehand"]',
  copilot: true,
};

const STEPS: Record<TourVariant, TourStep[]> = {
  magazine: [
    {
      id: 'welcome',
      title: 'Welcome to Stable Press',
      body: 'A magazine has been shared with you, and you’re looking at it now. Here’s a quick look round — it takes under a minute.',
    },
    {
      id: 'pages',
      title: 'Your pages',
      body: 'This is where your pages live. Open the list to see every page you can work on, then click one to edit it.',
      target: '[data-agent-id="mag.pages-rail"], [data-agent-id="mag.pages-show"]',
      optional: true,
    },
    {
      id: 'canvas',
      title: 'Edit right on the page',
      body: 'Click any text box or picture to change it. Your work saves as you go.',
      target: '[data-tour="mag-canvas"]',
    },
    {
      id: 'ai',
      title: 'Design Helper',
      body: 'The Design Helper is the AI for the page you’re on. Ask it to rewrite copy, swap a photo or tidy the layout. It suggests changes and you choose which to keep. The AI button at the top shows or hides it.',
      // The panel when it's open, its toggle when it isn't.
      target: '[data-tour="mag-ai-panel"], [data-agent-id="mag.ai-toggle"]',
      optional: true,
    },
    {
      id: 'review',
      title: 'Send your pages for review',
      body: 'When your pages are ready, submit them here. The magazine’s owner approves them or sends back notes.',
      target: '[data-agent-id="mag.review-board"]',
      optional: true,
    },
    STABLE_HAND,
  ],
  campaign: [
    {
      id: 'welcome',
      title: 'Welcome to Stable Press',
      body: 'This is the Campaign Engine, where the team creates stories, magazines, podcasts and more. Here’s a quick look round — it takes under a minute.',
    },
    {
      id: 'sidebar',
      title: 'Everything lives here',
      body: 'The sidebar takes you to every area your role can use. You’ll only see the sections that are open to you.',
      target: '[data-tour="ce-sidebar"]',
      optional: true,
    },
    {
      id: 'account',
      title: 'Your account',
      body: 'Your name and role are at the bottom of the sidebar. Click them to visit the public site or to sign out.',
      target: '[data-tour="ce-account"]',
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
