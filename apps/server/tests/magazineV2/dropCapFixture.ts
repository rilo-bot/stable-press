// A drop-cap paragraph built the way composeFromSolved builds one (three pinned text
// elements from fitDropCap), for the tests of the Studio agent's drop-cap handling.

import { fitDropCap } from '../../src/lib/magazineV2/dropCap.js';
import { WRAP_SAFETY } from '../../src/lib/magazineV2/measureLeaf.js';
import type { MagazineElement } from '../../src/lib/magazineV2/model.js';

export const DROP_CAP_INPUT = {
  lineHeight: 1.5,
  bodyFamily: 'Georgia, serif',
  bodyWeight: 400,
  capFamily: 'Playfair Display',
  capWeight: 700,
  safety: WRAP_SAFETY,
};

export function buildDropCap(
  text: string,
  box = { x: 100, y: 300, w: 900, h: 700 },
  size = 24,
  key = 'dropcap-abc123def456',
): { key: string; text: string; box: typeof box; elements: MagazineElement[]; cap: MagazineElement; lead: MagazineElement; rest?: MagazineElement } {
  const plan = fitDropCap({ ...DROP_CAP_INPUT, text, fontSize: size, boxW: box.w, boxH: box.h, maxFontSize: size, minFontSize: 14 });
  if (!plan) throw new Error('fixture: this copy cannot carry a drop cap in that box');
  const base = { rotation: 0, locked: false, source: 'ai-agent' as const };
  const body = (content: string) => ({
    content,
    role: 'body' as const,
    fontFamily: DROP_CAP_INPUT.bodyFamily,
    fontSize: plan.fontSize,
    maxFontSize: plan.fontSize,
    minFontSize: plan.fontSize,
    fontWeight: 400 as const,
    color: '#111111',
    align: 'left' as const,
    lineHeight: DROP_CAP_INPUT.lineHeight,
    autoFit: 'shrink' as const,
  });
  const cap: MagazineElement = {
    ...base,
    id: `${key}-cap`,
    type: 'text',
    x: box.x + plan.capBox.x,
    y: box.y + plan.capBox.y,
    w: plan.capBox.w,
    h: plan.capBox.h,
    zIndex: 3,
    text: {
      content: plan.cap,
      role: 'other',
      fontFamily: DROP_CAP_INPUT.capFamily,
      fontSize: plan.capFontSize,
      maxFontSize: plan.capFontSize,
      minFontSize: plan.capFontSize,
      fontWeight: 700,
      color: '#a01010',
      align: 'left',
      lineHeight: plan.capLineHeight,
      autoFit: 'shrink',
    },
  };
  const lead: MagazineElement = {
    ...base,
    id: `${key}-lead`,
    type: 'text',
    x: box.x + plan.firstBox.x,
    y: box.y,
    w: plan.firstBox.w,
    h: plan.firstBox.h,
    zIndex: 2,
    text: body(plan.first),
  };
  const rest: MagazineElement | undefined = plan.rest
    ? { ...base, id: `${key}-rest`, type: 'text', x: box.x, y: box.y + plan.restY, w: box.w, h: Math.max(1, box.h - plan.restY), zIndex: 2, text: body(plan.rest) }
    : undefined;
  const elements = [cap, lead, ...(rest ? [rest] : [])];
  return { key, text, box, elements, cap, lead, ...(rest ? { rest } : {}) };
}
