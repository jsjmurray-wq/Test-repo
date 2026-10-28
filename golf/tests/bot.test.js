// Playability: the autoplay bot (a ~5 handicap) gets round every hole of the course.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/game.js';
import { planShot, playBotShot, botDecide } from '../src/bot.js';
import { buildHole } from '../src/terrain.js';
import { SURF } from '../src/constants.js';
import { courseById } from '../src/courses.js';

const cache = new Map();
const build = (def, opts) => {
  const k = `${opts.course ? opts.course.id : 'pines'}:${def.n}:${opts.pinIndex}:${opts.seed}`;
  if (!cache.has(k)) cache.set(k, buildHole(def, opts));
  return cache.get(k);
};

// Plays the hole out with the bot; returns the strokes on the card.
function playHole(g) {
  let guard = 0;
  while (g.phase !== 'holed' && guard++ < 40) {
    if (g.phase === 'intro') g.skipIntro();
    else if (g.phase === 'decision') botDecide(g);
    else if (g.phase === 'address') {
      const r = playBotShot(g);
      assert.ok(r.ok, `bot swing ${JSON.stringify(r.plan)}`);
      g.skip();
    } else assert.fail(`unexpected phase ${g.phase}`);
  }
  assert.equal(g.phase, 'holed');
  return g.state.card.holes[g.state.holeIndex].strokes;
}

test('bot round, fixed seed, normal difficulty: every hole <= par + 3, 33-48 total', () => {
  const g = new Game({ seed: 1, settings: { wind: 'light', difficulty: 'normal' }, buildHole: build });
  const lines = [];
  for (let i = 0; i < 9; i++) {
    g.loadHole(i);
    const s = playHole(g);
    const h = g.state.card.holes[i];
    lines.push(`${i + 1}: ${s} (par ${h.par}${h.pickUp ? ', picked up' : ''})`);
    assert.ok(s <= h.par + 3, `hole ${i + 1}: ${s} on a par ${h.par}`);
  }
  const t = g.totals();
  assert.ok(t.strokes >= 33 && t.strokes <= 48, `round of ${t.strokes}: ${lines.join(', ')}`);
  assert.ok(t.pickUps <= 1);
  assert.equal(t.played, 9);
  assert.ok(t.putts >= 9 && t.putts <= 22, `putts ${t.putts}`);
});

test('bot plans are deterministic and sensible: putter on the green, wedge from a greenside bunker', () => {
  const g = new Game({ seed: 4, settings: { wind: 'off' }, buildHole: build });
  g.loadHole(0);
  g.skipIntro();
  const a = planShot(g);
  const b = planShot(g);
  assert.deepEqual(a, b);
  assert.ok(['D', '3W', '5W'].includes(a.clubId), `tee club ${a.clubId}`);
  // On the green: the putter, with a range that covers the putt.
  const t = g.terrain;
  g.debugPlace(t.cup.x + 6, t.cup.y);
  if (g.lie.surface === SURF.GREEN) {
    const p = planShot(g);
    assert.equal(p.clubId, 'P');
    assert.ok(p.puttRange >= 6);
    assert.equal(p.swing.kind, 'putt');
    assert.ok(p.swing.power > 0.4 && p.swing.power <= 1.1);
  }
  // Greenside bunker: a wedge.
  const gr = t.green;
  let spot = null;
  for (let d = 8; d < 30 && !spot; d += 0.5) {
    for (let a2 = 0; a2 < 360 && !spot; a2 += 5) {
      const x = gr.cx + d * Math.cos((a2 * Math.PI) / 180);
      const y = gr.cy + d * Math.sin((a2 * Math.PI) / 180);
      if (t.surfaceAt(x, y) === SURF.BUNKER) spot = { x, y };
    }
  }
  g.debugPlace(spot.x, spot.y);
  const sand = planShot(g);
  assert.ok(['SW', 'LW', 'GW'].includes(sand.clubId), `bunker club ${sand.clubId}`);
});

test('bot into a stiff headwind off the tee plays a stinger, and the game plays it', () => {
  const g = new Game({ seed: 4, settings: { wind: 'off' }, buildHole: build });
  g.loadHole(0);
  g.skipIntro();
  const yaw = g.aimYaw;
  g.state.wind = { x: -7 * Math.cos(yaw), y: -7 * Math.sin(yaw) };
  const plan = planShot(g);
  assert.equal(plan.shot, 'stinger');
  const r = playBotShot(g);
  assert.ok(r.ok);
  assert.equal(r.shot.swing.shot, 'stinger');
  assert.ok(r.shot.result.apex < 15, `apex ${r.shot.result.apex}`);
  // In still air the same tee shot is a normal one.
  const h = new Game({ seed: 4, settings: { wind: 'off' }, buildHole: build });
  h.loadHole(0);
  h.skipIntro();
  assert.equal(planShot(h).shot, 'normal');
});

test('bot plays the desert (saguaros and rocks have no canopy) and the links', () => {
  for (const id of ['desert', 'links']) {
    const g = new Game({ course: courseById(id), seed: 2, settings: { wind: 'light' }, buildHole: build });
    for (const i of [0, 1]) {
      g.loadHole(i);
      const s = playHole(g);
      const h = g.state.card.holes[i];
      assert.ok(s <= h.par + 4, `${id} hole ${i + 1}: ${s} on a par ${h.par}`);
    }
  }
});

