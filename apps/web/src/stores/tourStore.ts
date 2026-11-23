// ---------------------------------------------------------------------------
// The first-run product tour — which tour is on screen and at which step.
//
// WHO SEES IT: someone who has just joined the team by redeeming an invite link.
// The server sets `tourPending` on their account at that moment (routes/invites)
// and clears it for good when they finish or skip (POST /api/auth/tour-complete),
// so it shows once per ACCOUNT, not once per browser. Anyone can replay it from
// The Stable Hand ("Take the tour") — a replay never touches the server.
//
// The host that decides WHEN to start and draws it is components/tour/ProductTour.
// ---------------------------------------------------------------------------

import { create } from 'zustand';
import type { TourVariant } from '@/components/tour/tourSteps';

interface TourState {
  active: boolean;
  variant: TourVariant | null;
  index: number;
  /** A replay was asked for (from The Stable Hand); the host starts it as soon as
   *  a staff screen is showing. */
  replayRequested: boolean;
  /** This run is a replay — finishing it must not call the server. */
  isReplay: boolean;
  start: (variant: TourVariant, isReplay: boolean) => void;
  go: (index: number) => void;
  stop: () => void;
  requestReplay: () => void;
}

export const useTourStore = create<TourState>((set) => ({
  active: false,
  variant: null,
  index: 0,
  replayRequested: false,
  isReplay: false,
  start: (variant, isReplay) => set({ active: true, variant, index: 0, isReplay, replayRequested: false }),
  go: (index) => set({ index }),
  stop: () => set({ active: false, variant: null, index: 0, isReplay: false }),
  requestReplay: () => set({ replayRequested: true }),
}));
