// ---------------------------------------------------------------------------
// The look a chart is drawn in: the issue's own palette and faces when it has a
// genTheme; otherwise read off the page (imported magazines). Every series colour
// reads at 3:1 on the ground; a palette colour that does not is darkened (its hue
// kept), never silently used. Pure.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chartTheme, ensureContrast } from '../../src/lib/magazineV2/chartTheme.js';
import { contrastRatio } from '../../src/lib/magazineV2/layout.js';
import type { MagazineElement } from '../../src/lib/magazineV2/model.js';

const GEN = {
  palette: { primary: '#0b1f3a', accent: '#c8102e', secondary: '#2e7d5b', bg: '#ffffff', text: '#111111' },
  fonts: { display: 'Playfair Display, Georgia, serif', body: 'Inter, Arial, sans-serif' },
};

let seq = 0;
function text(content: string, opts: Partial<NonNullable<MagazineElement['text']>> = {}): MagazineElement {
  seq += 1;
  return {
    id: `t${seq}`,
    type: 'text',
    x: 0,
    y: 0,
    w: 400,
    h: 100,
    rotation: 0,
    zIndex: 1,
    locked: false,
    source: 'extracted',
    text: { content, role: 'body', fontFamily: 'Georgia, serif', fontSize: 22, fontWeight: 400, color: '#222222', align: 'left', lineHeight: 1.4, autoFit: 'shrink', ...opts },
  };
}
function shape(fill: string, opacity?: number): MagazineElement {
  seq += 1;
  return { id: `s${seq}`, type: 'shape', x: 0, y: 0, w: 100, h: 20, rotation: 0, zIndex: 0, locked: false, source: 'extracted', shape: { fill, ...(opacity !== undefined ? { opacity } : {}) } };
}

function assertReadable(theme: ReturnType<typeof chartTheme>): void {
  for (const c of theme.colors) assert.ok(contrastRatio(c, theme.bg) >= 3, `${c} on ${theme.bg} is ${contrastRatio(c, theme.bg).toFixed(2)}:1`);
  assert.ok(contrastRatio(theme.text, theme.bg) >= 4.5);
  assert.ok(contrastRatio(theme.muted, theme.bg) >= 4.5);
  assert.equal(new Set(theme.colors).size, theme.colors.length, 'no two series alike');
}

test('a generated issue: its palette is used in order, its faces kept', () => {
  const t = chartTheme(GEN, []);
  assert.deepEqual(t.colors.slice(0, 3), ['#0b1f3a', '#c8102e', '#2e7d5b']);
  assert.equal(t.colors.length, 8);
  assert.equal(t.accent, '#c8102e');
  assert.equal(t.text, '#111111');
  assert.equal(t.bg, '#ffffff');
  assert.equal(t.fontBody, 'Inter, Arial, sans-serif');
  assert.equal(t.fontDisplay, 'Playfair Display, Georgia, serif');
  assertReadable(t);
});

test('a palette colour that fails contrast on the ground is darkened, keeping its hue', () => {
  const t = chartTheme({ ...GEN, palette: { ...GEN.palette, primary: '#f5d76e' } }, []);
  assert.notEqual(t.colors[0], '#f5d76e');
  assert.ok(contrastRatio(t.colors[0]!, '#ffffff') >= 3);
  // Still a yellow-ish: red and green channels well above blue.
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(t.colors[0]!.slice(i, i + 2), 16)) as [number, number, number];
  assert.ok(r > b && g > b, t.colors[0]);
  assertReadable(t);
  assert.equal(ensureContrast('#111111', '#ffffff', 3), '#111111');
});

test('a dark page: the ground follows the page, text turns light', () => {
  const t = chartTheme(GEN, [], { background: { type: 'color', value: '#0b1f3a' } });
  assert.equal(t.bg, '#0b1f3a');
  assert.ok(contrastRatio(t.text, t.bg) >= 4.5);
  assertReadable(t);
});

test('an imported page with no genTheme: faces and colours come from the page itself', () => {
  const els = [
    text('A long body paragraph set in the magazine\'s body face, many words long.', { fontFamily: 'Georgia, serif' }),
    text('Another body paragraph.', { fontFamily: 'Georgia, serif' }),
    text('HEADLINE', { role: 'headline', fontFamily: 'Oswald, sans-serif', fontSize: 72, fontWeight: 700, color: '#111111' }),
    shape('#1d6b4f'),
    shape('#1d6b4f'),
    shape('#1d6b4f'),
    shape('#e0a000'),
    shape('#000000', 0.5), // a scrim — not a colour of the page
    shape('#eeeeee'), // a grey panel — not a series colour
  ];
  const t = chartTheme(undefined, els);
  assert.equal(t.fontBody, 'Georgia, serif');
  assert.equal(t.fontDisplay, 'Oswald, sans-serif');
  assert.equal(t.colors[0], '#1d6b4f');
  // The page's second colour is the accent — darkened, because #e0a000 is under 3:1 on white.
  assert.notEqual(t.colors[1], '#e0a000');
  assert.ok(contrastRatio(t.colors[1]!, t.bg) >= 3);
  assert.ok(t.text === '#222222' || t.text === '#111111');
  assertReadable(t);
});

test('nothing to go on: editorial defaults, still readable', () => {
  const t = chartTheme(null, []);
  assert.equal(t.bg, '#ffffff');
  assert.equal(t.colors.length, 8);
  assert.notEqual(t.accent, t.colors[0]);
  assertReadable(t);
});

test('a hostile font stack is not passed through', () => {
  const t = chartTheme({ fonts: { body: 'x"/><script>', display: 'inherit' } }, []);
  assert.equal(t.fontBody, 'Inter, Arial, sans-serif');
  assert.ok(!t.fontDisplay.includes('inherit'));
});
