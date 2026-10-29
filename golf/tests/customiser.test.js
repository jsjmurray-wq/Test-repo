// Golfer customiser (section 9, Customiser): the DOM-free parts of customiser.js (the avatar, the
// look's name, the preview clubs and tabs). The screen itself is covered by the e2e run
// (tests/e2e.spec.mjs golferCustomiser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avatarSVG, lookSummary, PREVIEW_CLUBS, TABS, SLIDER_MS, Customiser } from '../src/customiser.js';
import { PRESETS, DEFAULT_LOOK, OPTIONS, randomLook, CLUB_SPECS } from '../src/golfer.js';
import { mulberry32 } from '../src/rng.js';

test('avatarSVG draws every option in the look colours (no NaN, balanced markup)', () => {
  const looks = [DEFAULT_LOOK, ...PRESETS.map((p) => p.look)];
  const rng = mulberry32(7);
  for (let i = 0; i < 40; i++) looks.push(randomLook(rng));
  for (const k of ['hair', 'headwear', 'shirt', 'facialHair', 'build']) for (const v of OPTIONS[k]) looks.push({ ...DEFAULT_LOOK, [k]: v });
  for (const L of looks) {
    const svg = avatarSVG(L);
    assert.match(svg, /^<svg viewBox="0 0 48 48"[^>]*>.*<\/svg>$/);
    assert.ok(!/NaN|undefined/.test(svg), svg);
    assert.equal((svg.match(/<path|<circle|<ellipse|<rect/g) || []).length, (svg.match(/\/>/g) || []).length);
  }
  const tour = PRESETS.find((p) => p.id === 'tour').look;
  const s = avatarSVG(tour);
  assert.ok(s.includes(tour.shirtColor) && s.includes(tour.hatColor), 'shirt and cap colours');
  // Garbage still draws the default golfer.
  assert.equal(avatarSVG(null), avatarSVG(DEFAULT_LOOK));
});

test('lookSummary names presets exactly and anything else "Custom golfer"', () => {
  for (const p of PRESETS) {
    const s = lookSummary(p.look);
    assert.equal(s.title, p.name);
    assert.equal(s.preset, p.id);
  }
  const custom = lookSummary({ ...PRESETS[0].look, shirtColor: '#e5802e' });
  assert.equal(custom.title, 'Custom golfer');
  assert.equal(custom.preset, null);
  assert.match(lookSummary(DEFAULT_LOOK).sub, /^Classic swing · 183 cm$/);
  // A new player's untouched golfer has a name: the default look is the Tour Pro preset.
  assert.equal(lookSummary(null).title, 'Tour Pro');
});

test('preview clubs and tabs', () => {
  for (const c of PREVIEW_CLUBS) assert.ok(CLUB_SPECS[c.id], c.id);
  assert.deepEqual(TABS.map((t) => t.id), ['body', 'face', 'clothes', 'swing']);
  assert.equal(TABS.find((t) => t.id === 'face').zoom, 1, 'Hair & Face frames the face');
  assert.ok(SLIDER_MS >= 50 && SLIDER_MS <= 250);
});

test('Customiser without its markup is inert (no throw)', () => {
  const root = { ownerDocument: null, querySelector: () => null, querySelectorAll: () => [] };
  const cz = new Customiser(root, {});
  assert.equal(cz.ok, false);
  cz.open(DEFAULT_LOOK);
  assert.equal(cz.isOpen, false);
  // The view still steps (main reads it every frame while open).
  const v = cz.stepView(1 / 60);
  assert.ok(Number.isFinite(v.yaw) && Number.isFinite(v.zoom));
});
