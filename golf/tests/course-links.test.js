// The links course, Kittiwake Links (src/course-links.js): course data, every hole's yardage, tee,
// pins and green, the links features the design promises (fescue, pot bunkers, gorse kept out of
// play, the sea, the burn, the blind drive, Hell bunker, the Valley of Sin, greens open to a running
// shot), relief from the water, build time and playability by the autoplay bot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINKS } from '../src/course-links.js';
import { courseById, courseSummary } from '../src/courses.js';
import { buildHole } from '../src/terrain.js';
import { SURF, BALL_R, mToYd, ydToM } from '../src/constants.js';
import { resolveShot, isDropOk, holdsBall } from '../src/rules.js';
import { simulateShot, REVET_GRAD } from '../src/physics.js';
import { stockLaunch, clubById, CLUBS } from '../src/clubs.js';
import { swingToLaunch } from '../src/swing.js';
import { lieAt } from '../src/lie.js';
import { Game } from '../src/game.js';
import { playBotShot, botDecide } from '../src/bot.js';

// Terrain builds are the slow part: share them.
const cache = new Map();
function build(def, opts = {}) {
  const k = `${def.n}:${opts.pinIndex || 0}:${opts.seed || 1}`;
  if (!cache.has(k)) cache.set(k, buildHole(def, { pinIndex: 0, seed: 1, ...opts, course: LINKS }));
  return cache.get(k);
}
const holes = LINKS.holes.map((def) => build(def));

// Distance from p to the green ellipse edge (positive inside), by dense boundary sampling.
function insideDist(green, p) {
  const ca = Math.cos(green.rot);
  const sa = Math.sin(green.rot);
  let best = Infinity;
  for (let k = 0; k < 1440; k++) {
    const a = (k / 1440) * Math.PI * 2;
    const u = green.rx * Math.cos(a);
    const v = green.ry * Math.sin(a);
    best = Math.min(best, Math.hypot(green.cx + u * ca - v * sa - p.x, green.cy + u * sa + v * ca - p.y));
  }
  return best;
}
const slope = (t, x, y) => Math.hypot(...Object.values(t.gradAt(x, y)));
// Point (r, f) metres from the green centre (r to the right, f away from the tee).
function greenPt(t, r, f) {
  const d = t.path.tangentAt(t.lengthM);
  return { x: t.greenCenter.x + r * d.y + f * d.x, y: t.greenCenter.y - r * d.x + f * d.y };
}
// Point (s, off) along the centreline (off + to the right).
function at(t, s, off = 0) {
  const p = t.path.pointAt(s);
  const d = t.path.tangentAt(s);
  return { x: p.x + d.y * off, y: p.y - d.x * off };
}
const surf = (t, p) => t.surfaceAt(p.x, p.y);
const h = (t, p) => t.heightAt(p.x, p.y);

test('Kittiwake Links course object: id, links theme, firm fast windy conditions, registered', () => {
  assert.equal(LINKS.id, 'links');
  assert.equal(LINKS.theme, 'links');
  assert.ok(LINKS.name.length > 3 && LINKS.tagline.length > 10);
  assert.deepEqual(LINKS.conditions, { firm: 1.45, greenStimpFt: 9.5, wind: 'windy' });
  assert.equal(courseById('links'), LINKS);
  for (const t of holes) {
    assert.equal(t.courseId, 'links');
    assert.equal(t.theme, 'links');
    assert.equal(t.conditions.firm, 1.45);
    assert.equal(t.conditions.greenStimpFt, 9.5);
  }
});

test('nine holes, par 36 (two par 3s, two par 5s), 3100-3400 yd, stroke indexes 1-9', () => {
  assert.equal(LINKS.holes.length, 9);
  assert.deepEqual(LINKS.holes.map((d) => d.n), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const pars = LINKS.holes.map((d) => d.par);
  assert.equal(pars.reduce((a, b) => a + b, 0), 36);
  assert.equal(pars.filter((p) => p === 3).length, 2);
  assert.equal(pars.filter((p) => p === 5).length, 2);
  const yd = holes.reduce((a, t) => a + mToYd(t.lengthM), 0);
  assert.ok(yd > 3100 && yd < 3400, `${yd} yd`);
  assert.equal(courseSummary(LINKS).par, 36);
  assert.deepEqual(LINKS.holes.map((d) => d.si).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(new Set(LINKS.holes.map((d) => d.name)).size, 9);
  // The hardest hole (stroke index 1) is the longest par 4.
  const p4 = holes.filter((t) => t.par === 4).sort((a, b) => b.lengthM - a.lengthM);
  assert.equal(p4[0].si, 1);
});

for (const t of holes) {
  const def = LINKS.holes[t.n - 1];
  test(`hole ${t.n} (${t.name}): yardage, tee, pins and green`, () => {
    const yd = mToYd(t.lengthM);
    if (t.par === 3) assert.ok(yd >= 120 && yd <= 230, `${yd}`);
    if (t.par === 4) assert.ok(yd >= 300 && yd <= 470, `${yd}`);
    if (t.par === 5) assert.ok(yd >= 450 && yd <= 600, `${yd}`);

    assert.equal(t.surfaceAt(t.tee.x, t.tee.y), SURF.TEE);
    assert.ok(!t.isOOB(t.tee.x, t.tee.y) && !t.waterAt(t.tee.x, t.tee.y));
    for (const w of t.waters) assert.ok(t.tee.z > w.level + 0.8, `tee ${t.tee.z.toFixed(2)} over water ${w.level.toFixed(2)}`);

    const straight = Math.hypot(t.cup.x - t.tee.x, t.cup.y - t.tee.y);
    assert.ok(straight <= t.lengthM + 12 && straight >= 0.75 * t.lengthM, `${straight} vs ${t.lengthM}`);

    assert.equal(t.pins.length, 3);
    for (const p of t.pins) {
      assert.equal(t.surfaceAt(p.x, p.y), SURF.GREEN, 'pin on green');
      assert.ok(insideDist(t.green, p) >= 4, `pin ${insideDist(t.green, p).toFixed(2)} m from the edge`);
      for (let r = 0; r <= 2; r += 0.5) {
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2;
          const s = slope(t, p.x + r * Math.cos(a), p.y + r * Math.sin(a));
          assert.ok(s <= 0.025, `slope ${(s * 100).toFixed(2)}% near pin`);
        }
      }
    }
    // Big greens (links): at least 650 m2 of putting surface, but for the narrow Postage on the
    // short 3rd; every part of it 5% or less.
    const { cx, cy, rx, ry } = t.green;
    if (t.n === 3) assert.ok(Math.PI * rx * ry < 560 && rx < 10, 'the Postage is narrow');
    else assert.ok(Math.PI * rx * ry >= 650, `green ${(Math.PI * rx * ry).toFixed(0)} m2`);
    const R = Math.max(rx, ry);
    let maxS = 0;
    for (let y = cy - R; y <= cy + R; y += 0.5) {
      for (let x = cx - R; x <= cx + R; x += 0.5) {
        if (t.surfaceAt(x, y) !== SURF.GREEN) continue;
        maxS = Math.max(maxS, slope(t, x, y));
        for (const w of t.waters) assert.ok(t.heightAt(x, y) > w.level + 0.6);
      }
    }
    assert.ok(maxS <= 0.05, `green max slope ${(maxS * 100).toFixed(2)}%`);

    const t2 = build(def, { pinIndex: 2 });
    assert.ok(Math.hypot(t2.cup.x - t.pins[2].x, t2.cup.y - t.pins[2].y) < 1e-9);
    assert.ok(Math.abs(t2.cup.z - t2.heightAt(t2.cup.x, t2.cup.y)) < 1e-9);
  });

  test(`hole ${t.n}: links ground, gorse out of play, a safe line and relief`, () => {
    // Fescue beyond the rough, every bunker a revetted pot, no trees: gorse, and dune grass decor.
    assert.equal(def.outside, 'fescue');
    assert.ok(def.bunkers.length >= 3 && def.bunkers.every((b) => b.pot), 'pot bunkers');
    assert.ok(t.sgrid.data.includes(SURF.FESCUE) && t.sgrid.data.includes(SURF.BUNKER));
    assert.ok(t.decor.length > 300, 'dune grass');
    for (const s of [1, 2, 3]) {
      const tt = build(def, { seed: s });
      for (const o of tt.trees) {
        assert.equal(o.kind, 'gorse');
        const sf = tt.surfaceAt(o.x, o.y);
        assert.ok(![SURF.FAIRWAY, SURF.GREEN, SURF.FRINGE, SURF.TEE, SURF.WATER, SURF.BUNKER].includes(sf), `object on ${sf}`);
      }
    }
    // Gorse is all but unplayable (a ball in a bush is caught again), so the thickets stand on the
    // dunes: no bush within 20 m of short grass (fairway, tee, green and its surrounds).
    const sg = t.sgrid;
    for (const o of t.trees) {
      for (let a = 0; a < 16; a++) {
        for (let d = 0; d <= 20; d += 2.5) {
          const sf = t.surfaceAt(o.x + d * Math.cos((a * Math.PI) / 8), o.y + d * Math.sin((a * Math.PI) / 8));
          assert.ok(![SURF.FAIRWAY, SURF.TEE, SURF.GREEN, SURF.FRINGE].includes(sf), `gorse at ${o.x.toFixed(0)},${o.y.toFixed(0)} ${d} m from short grass`);
        }
      }
    }
    // Dunes and mounds stay under ~41 deg: only pot-bunker faces are steep enough to be revetted
    // sod (the renderer paints walls steeper than 0.88 on the 1 m grid next to bunkers as sod).
    const g = t.grid;
    const nearBunker = (x, y) => {
      for (let dy = -3; dy <= 3; dy += 0.5) {
        for (let dx = -3; dx <= 3; dx += 0.5) {
          const i = Math.floor((x + dx - sg.minX) / sg.step);
          const j = Math.floor((y + dy - sg.minY) / sg.step);
          if (i >= 0 && j >= 0 && i < sg.nx && j < sg.ny && sg.data[j * sg.nx + i] === SURF.BUNKER) return true;
        }
      }
      return false;
    };
    for (let j = 1; j < g.ny - 1; j++) {
      for (let i = 1; i < g.nx - 1; i++) {
        const k = j * g.nx + i;
        const s = Math.hypot(g.heights[k + 1] - g.heights[k - 1], g.heights[k + g.nx] - g.heights[k - g.nx]) / 2;
        if (s > 0.88) assert.ok(nearBunker(g.minX + i, g.minY + j), `steep ground ${s.toFixed(2)} at ${g.minX + i},${g.minY + j}`);
      }
    }
    // Water stays red (lateral relief); an inland burn lies inside the height grid.
    for (const w of t.waters) {
      assert.ok(w.kind === 'red' && w.poly.length >= 3 && Number.isFinite(w.level));
      if (w.sea) continue;
      const b = t.bounds;
      for (const q of w.poly) assert.ok(Math.min(q.x - b.minX, b.maxX - q.x, q.y - b.minY, b.maxY - q.y) >= 8, 'burn inside the grid');
    }

    if (t.par >= 4) {
      // The default tee line finds dry, in-bounds fairway or rough at driver distance.
      const aim = t.aimPoint(t.tee);
      const d = Math.hypot(aim.x - t.tee.x, aim.y - t.tee.y);
      const ux = (aim.x - t.tee.x) / d;
      const uy = (aim.y - t.tee.y) / d;
      for (const k of [215, 230, 245]) {
        const sf = t.surfaceAt(t.tee.x + ux * k, t.tee.y + uy * k);
        assert.ok(sf === SURF.FAIRWAY || sf === SURF.ROUGH, `${k} m along the aim lands on ${sf}`);
      }
      for (let k = 10; k <= 230; k += 10) assert.ok(!t.isOOB(t.tee.x + ux * k, t.tee.y + uy * k));
    }
    const near = t.aimPoint({ x: t.greenCenter.x + 30, y: t.greenCenter.y });
    assert.ok(Math.hypot(near.x - t.cup.x, near.y - t.cup.y) < 1e-9);

    // Sensible clubs on the default line come to rest in play: the long clubs off a par 4/5 tee
    // (never in the water or out of bounds), and on a par 3 the club whose carry fits the hole
    // finds the green or its fringe.
    const pos = { x: t.tee.x, y: t.tee.y, z: t.tee.z + BALL_R };
    const ap = t.aimPoint(t.tee);
    const yaw = Math.atan2(ap.y - t.tee.y, ap.x - t.tee.x);
    const dist = Math.hypot(t.cup.x - t.tee.x, t.cup.y - t.tee.y) + (t.cup.z - t.tee.z);
    const ids = t.par > 3 ? ['D', '3W', '5W', '4H'] : [CLUBS.find((c) => c.targetCarryYd && ydToM(c.targetCarryYd) <= dist + 6).id];
    for (const id of ids) {
      const r = simulateShot(t, stockLaunch(clubById(id), { pos, aimYaw: yaw }), { seed: 1, record: false });
      assert.equal(r.final.outcome, 'rest', `${id} off the tee: ${r.final.outcome}`);
      if (t.par === 3) assert.ok([SURF.GREEN, SURF.FRINGE].includes(r.final.surface), `${id} to the green: ${r.final.surface}`);
      else assert.ok([SURF.FAIRWAY, SURF.ROUGH].includes(r.final.surface), `${id} off the tee: ${r.final.surface}`);
    }

    // Relief: a fan of stock shots from the tee and the fairway; every ball that finds the sea or the
    // burn gets a legal drop (dry, holds the ball, no nearer the hole).
    if (!t.waters.length) return;
    const spots = [{ p: t.tee, tee: true }];
    if (t.par > 3) for (const f of [0.6, 0.8]) spots.push({ p: at(t, t.lengthM * f), tee: false });
    let wet = 0;
    let replays = 0;
    for (const sp of spots) {
      const from = { x: sp.p.x, y: sp.p.y, z: t.heightAt(sp.p.x, sp.p.y) + BALL_R };
      const prev = { ...from };
      const a2 = t.aimPoint(sp.p);
      const y2 = Math.atan2(a2.y - sp.p.y, a2.x - sp.p.x);
      const clubs = sp.tee && t.par > 3 ? ['D', '3W', '5W'] : ['4H', '6i', '8i', 'PW'];
      for (const id of clubs) {
        for (const da of [-16, -10, -5, 0, 5, 10, 16]) {
          for (const speedScale of [0.85, 1, 1.12]) {
            const r = simulateShot(t, stockLaunch(clubById(id), { pos: from, aimYaw: y2 + (da * Math.PI) / 180, speedScale }), { seed: 3, record: false });
            if (r.final.outcome !== 'water') continue;
            wet++;
            const res = resolveShot({ terrain: t, par: t.par, strokes: 0, prevSpot: prev, fromTee: sp.tee, fromSurface: sp.tee ? SURF.TEE : SURF.FAIRWAY }, r);
            const dec = res.decision;
            assert.ok(dec && res.penalty === 1);
            assert.ok(isDropOk(t, dec.drop.x, dec.drop.y) && holdsBall(t, dec.drop.x, dec.drop.y), `drop ${dec.drop.x.toFixed(1)},${dec.drop.y.toFixed(1)}`);
            if (Math.hypot(dec.drop.x - prev.x, dec.drop.y - prev.y) < 0.01) {
              replays++;
              continue;
            }
            const dE = Math.hypot(dec.entry.x - t.cup.x, dec.entry.y - t.cup.y);
            assert.ok(Math.hypot(dec.drop.x - t.cup.x, dec.drop.y - t.cup.y) >= dE - 1e-6, 'no nearer the hole');
          }
        }
      }
    }
    assert.ok(replays <= 0.15 * wet, `${replays} of ${wet} water balls without a drop`);
  });
}

// Build time of a hole: one untimed build first (JIT warm-up), then the best of three timed ones
// (the test files run in parallel processes, so any single build can be starved of CPU).
function buildMs(def, opts) {
  buildHole(def, opts);
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    const t0 = performance.now();
    buildHole(def, { ...opts, pinIndex: k });
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

test('all nine holes build in under 300 ms', () => {
  for (const def of LINKS.holes) {
    const ms = buildMs(def, { pinIndex: 0, seed: 1, course: LINKS });
    assert.ok(ms < 300, `hole ${def.n}: ${ms.toFixed(0)} ms`);
  }
});

test('the signature features: the sea and its beach, the blind drive, Hell, the burn, the Valley of Sin', () => {
  const [h1, h2, h3, h4, h5, h6, h7, h8, h9] = holes;
  // 1 and 8 run along the shore: from the fairway out to sea it is rough, fescue, beach (waste),
  // then the sea (red), on the left of the 1st and the right of the 8th.
  for (const [t, side] of [[h1, -1], [h8, 1]]) {
    assert.ok(t.waters.some((w) => w.sea), `${t.n}: the sea`);
    for (const s of [120, 200, 280]) {
      const seq = [];
      for (let off = 0; off <= 140; off += 1) {
        const sf = surf(t, at(t, s, side * off));
        if (seq[seq.length - 1] !== sf) seq.push(sf);
        if (sf === SURF.WATER) break;
      }
      assert.equal(seq[0], SURF.FAIRWAY, `${t.n} s ${s}`);
      assert.equal(seq[seq.length - 1], SURF.WATER, `${t.n} s ${s}: the sea`);
      assert.equal(seq[seq.length - 2], SURF.WASTE, `${t.n} s ${s}: a beach before the sea`);
      assert.ok(seq.includes(SURF.FESCUE), `${t.n} s ${s}: fescue dunes`);
    }
  }
  // Every other hole has no sea of its own (the renderer sets the sea beyond the dunes).
  for (const t of [h2, h3, h4, h5, h6, h7, h9]) assert.ok(!t.waters.some((w) => w.sea));

  // 2: the blind drive. From the tee (eyes 1.6 m up) the ridge hides the landing area; the fairway
  //    starts beyond it (a carry over the marram), and the ridge is fescue with a bare sand face.
  const eye = { x: h2.tee.x, y: h2.tee.y, z: h2.tee.z + 1.6 };
  for (let s = 200; s <= 260; s += 10) {
    const p = at(h2, s);
    const dir = { x: p.x - eye.x, y: p.y - eye.y, z: h(h2, p) + 0.3 - eye.z };
    const hit = h2.raycast(eye, dir, 1);
    assert.ok(hit && hit.t < 0.95, `landing area at ${s} m visible from the tee`);
  }
  let crest = 0;
  for (let s = 90; s <= 140; s += 2) crest = Math.max(crest, h(h2, at(h2, s)));
  assert.ok(crest > h2.tee.z + 3, `ridge ${crest.toFixed(1)} m over a ${h2.tee.z.toFixed(1)} m tee`);
  for (let s = 20; s <= 150; s += 5) assert.ok(![SURF.FAIRWAY, SURF.WATER, SURF.BUNKER].includes(surf(h2, at(h2, s))), `carry at ${s}`);
  assert.ok([90, 95, 100, 105, 110].some((s) => [-14, -10, -18].some((o) => surf(h2, at(h2, s, o)) === SURF.WASTE)), 'sand face on the ridge');

  // 3: a narrow green ringed by pots: bunker sand on both sides and in front, within 8 m of it.
  for (const [r, f] of [[-15, 0], [15, 2], [0, -24]]) {
    let sand = false;
    for (let d = -5; d <= 5 && !sand; d += 0.5) sand = surf(h3, greenPt(h3, r + (r ? Math.sign(r) * d : d), f + (r ? d : -Math.abs(d)))) === SURF.BUNKER;
    assert.ok(sand, `pot round the 3rd green near ${r},${f}`);
  }

  // 4: out of bounds all down the right; the Beardies (four pots) left of the driving zone; Hell, a
  //    big pot (over 60 m2 of sand) in the middle of the second-shot landing zone; the green up on a
  //    plateau behind a false front (the approach 10 m short sits a metre or more below its front).
  for (const s of [100, 250, 400]) assert.ok(h4.isOOB(at(h4, s, 52).x, at(h4, s, 52).y) && !h4.isOOB(at(h4, s, 40).x, at(h4, s, 40).y));
  let beardies = 0;
  for (const b of LINKS.holes[3].bunkers) if (b.s >= 200 && b.s <= 250 && b.off < -10) beardies++;
  assert.equal(beardies, 4);
  let hell = 0;
  for (let ds = -12; ds <= 12; ds += 0.5) for (let o = -14; o <= 10; o += 0.5) if (surf(h4, at(h4, 372 + ds, o)) === SURF.BUNKER) hell += 0.25;
  assert.ok(hell > 60, `Hell ${hell} m2`);
  const front4 = greenPt(h4, 0, -LINKS.holes[3].green.ry);
  assert.ok(h(h4, front4) - h(h4, greenPt(h4, 0, -LINKS.holes[3].green.ry - 12)) > 1, 'false front');

  // 5: the burn crosses the line 25-45 m short of the green's middle, a few metres wide, with dry
  //    fairway on both banks.
  let wetRun = 0;
  let first = null;
  for (let s = h5.lengthM - 50; s <= h5.lengthM - 10; s += 0.25) {
    if (surf(h5, at(h5, s)) === SURF.WATER) {
      wetRun += 0.25;
      if (first === null) first = s;
    }
  }
  assert.ok(wetRun >= 3 && wetRun <= 8, `burn ${wetRun} m wide`);
  assert.ok(first >= h5.lengthM - 45 && first <= h5.lengthM - 25, `burn at ${first}`);
  assert.equal(surf(h5, at(h5, first - 6)), SURF.FAIRWAY);
  assert.equal(surf(h5, at(h5, first + wetRun + 6)), SURF.FAIRWAY);
  for (const off of [-60, -30, 30, 60]) {
    let across = false;
    for (let ds = -48; ds <= -20 && !across; ds += 0.5) across = surf(h5, at(h5, h5.lengthM + ds, off)) === SURF.WATER;
    assert.ok(across, `burn across at ${off}`);
  }

  // 6: a dogleg right with pots in the elbow, the green in a dell: sandhills rise 2 m or more over
  //    it on the left, behind and back right, open to the approach from the front right.
  assert.ok(LINKS.holes[5].bunkers.filter((b) => b.s > 230 && b.s < 280 && b.off > 10).length >= 2);
  for (const [r, f] of [[-44, 0], [0, 44], [31, 31]]) assert.ok(h(h6, greenPt(h6, r, f)) > h6.greenCenter.z + 2, `dell ${r},${f}`);

  // 7: an open entrance: the line to the green's front is short grass all the way from 45 m out,
  //    and the ground behind the green falls away into a hollow.
  for (let s = h7.lengthM - 60; s <= h7.lengthM - 18; s += 1) assert.ok([SURF.FAIRWAY, SURF.FRINGE].includes(surf(h7, at(h7, s))), `entrance at ${s}`);
  assert.ok(h(h7, greenPt(h7, 0, 28)) < h(h7, greenPt(h7, 0, LINKS.holes[6].green.ry)) - 1, 'hollow behind');

  // 9: out of bounds right; the Valley of Sin, a hollow short-left of the green, 1.2 m or more
  //    below the green's front, cut as fairway.
  assert.ok(h9.isOOB(at(h9, 250, 50).x, at(h9, 250, 50).y));
  const vos = greenPt(h9, -4, -26);
  assert.equal(surf(h9, vos), SURF.FAIRWAY);
  assert.ok(h(h9, vos) < h(h9, greenPt(h9, 0, -LINKS.holes[8].green.ry)) - 1.2, 'Valley of Sin');
});

test('greens are open to the running shot: a bump & run from 25 m short of the green finishes on it', () => {
  // Power solved on the real hole (bisection on where the ball stops along the line), no wind: the
  // firm approaches and open fronts carry a low runner up onto every green (on the 5th it hops the
  // burn first) but the Postage, whose front pot asks for a pitch.
  const swing = (power) => ({ ok: true, kind: 'full', power, startDir: 0, faceToPath: 0, tempo: 'smooth', label: 'Bump' });
  for (const t of holes.filter((x) => x.n !== 3)) {
    const def = LINKS.holes[t.n - 1];
    const p = at(t, t.lengthM - def.green.ry - 25);
    const pos = { x: p.x, y: p.y, z: t.heightAt(p.x, p.y) + BALL_R };
    const yaw = Math.atan2(t.cup.y - p.y, t.cup.x - p.x);
    const lie = lieAt(t, pos, yaw);
    const d = Math.hypot(t.cup.x - p.x, t.cup.y - p.y);
    const club = clubById('8i');
    let lo = 0.05;
    let hi = 1.1;
    let res = null;
    for (let k = 0; k < 16; k++) {
      const m = (lo + hi) / 2;
      // (Flagstick out: a bump flown at the pin would ricochet off it and break the bisection.)
      res = simulateShot(t, swingToLaunch(club, lie, swing(m), yaw, null, { pos, shot: 'bump' }), { record: false, pin: false });
      if (res.final.outcome === 'holed') break;
      const along = (res.final.x - pos.x) * Math.cos(yaw) + (res.final.y - pos.y) * Math.sin(yaw);
      if (along < d) lo = m;
      else hi = m;
    }
    // (A runner: on the flat an 8-iron bump carries about a fifth of its total; over the 9th's Valley
    // of Sin it has to carry the hollow, about half.)
    assert.ok(res.carry < 0.55 * res.total, `${t.n}: a runner (carry ${res.carry.toFixed(1)} of ${res.total.toFixed(1)} m)`);
    const f = res.final;
    assert.ok(f.outcome === 'holed' || f.surface === SURF.GREEN, `${t.n}: bump finished on ${f.surface}`);
    assert.ok(Math.hypot(f.x - t.cup.x, f.y - t.cup.y) < 5, `${t.n}: bump ${Math.hypot(f.x - t.cup.x, f.y - t.cup.y).toFixed(1)} m from the cup`);
  }
});

// ------------------------------------------------------------------ playability

// Plays the hole out with the bot; returns the strokes on the card. A ball never stays stuck:
// every swing is accepted and the hole is finished within 30 bot actions.
function playHole(g) {
  let guard = 0;
  while (g.phase !== 'holed' && guard++ < 30) {
    if (g.phase === 'intro') g.skipIntro();
    else if (g.phase === 'decision') botDecide(g);
    else if (g.phase === 'address') {
      const r = playBotShot(g);
      assert.ok(r.ok, `bot swing ${JSON.stringify(r.plan)}`);
      g.skip();
    } else assert.fail(`unexpected phase ${g.phase}`);
  }
  assert.equal(g.phase, 'holed', 'the hole is finished');
  return g.state.card.holes[g.state.holeIndex].strokes;
}

for (const [seed, wind] of [[1, 'light'], [2, 'light'], [3, 'breezy']]) {
  test(`bot round on Kittiwake Links (seed ${seed}, ${wind}, normal difficulty): every hole <= par + 3, round par-3 to par+12`, () => {
    const g = new Game({ course: LINKS, seed, settings: { wind, difficulty: 'normal' }, buildHole: (d, opts) => build(d, opts) });
    const lines = [];
    for (let i = 0; i < 9; i++) {
      g.loadHole(i);
      const s = playHole(g);
      const hc = g.state.card.holes[i];
      lines.push(`${i + 1}: ${s}${hc.pickUp ? ' (picked up)' : ''}`);
      assert.ok(s <= hc.par + 3, `hole ${i + 1}: ${s} on a par ${hc.par}`);
    }
    const tt = g.totals();
    assert.equal(tt.played, 9);
    assert.ok(tt.strokes >= 33 && tt.strokes <= 48, `round of ${tt.strokes}: ${lines.join(', ')}`);
    assert.ok(tt.pickUps <= 1);
  });
}

// Floors of the pot bunkers (the lowest sand cells of each deep bunker) at least `minCup` m from
// the cup, with the hole they are on.
function potFloors(minCup = 70) {
  const out = [];
  holes.forEach((t, hi) => {
    const sg = t.sgrid;
    const seen = new Uint8Array(sg.nx * sg.ny);
    for (let k0 = 0; k0 < sg.data.length; k0++) {
      if (seen[k0] || sg.data[k0] !== SURF.BUNKER) continue;
      const stack = [k0];
      seen[k0] = 1;
      const cells = [];
      while (stack.length) {
        const q = stack.pop();
        cells.push(q);
        const qi = q % sg.nx;
        const qj = (q / sg.nx) | 0;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ni = qi + di;
          const nj = qj + dj;
          if (ni < 0 || nj < 0 || ni >= sg.nx || nj >= sg.ny) continue;
          const nk = nj * sg.nx + ni;
          if (!seen[nk] && sg.data[nk] === SURF.BUNKER) {
            seen[nk] = 1;
            stack.push(nk);
          }
        }
      }
      const pts = cells.map((k) => ({ x: sg.minX + (k % sg.nx + 0.5) * sg.step, y: sg.minY + (((k / sg.nx) | 0) + 0.5) * sg.step }));
      const zs = pts.map((p) => t.heightAt(p.x, p.y));
      const lo = Math.min(...zs);
      if (Math.max(...zs) - lo < 1 || !t.potAt(pts[0].x, pts[0].y)) continue;
      const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
      const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
      if (Math.hypot(t.cup.x - cx, t.cup.y - cy) < minCup) continue;
      pts.forEach((p, i) => zs[i] < lo + 0.15 && out.push({ t, hi, ...p }));
    }
  });
  return out;
}

test('pot bunkers: a long iron or hybrid from the floor at the face stays in the pot (the revetted wall is no ramp)', () => {
  const floors = potFloors();
  assert.ok(floors.length > 60, `${floors.length} floor spots`);
  for (const id of ['4H', '5i']) {
    let stay = 0;
    for (const f of floors) {
      const yaw = Math.atan2(f.t.cup.y - f.y, f.t.cup.x - f.x);
      const pos = { x: f.x, y: f.y, z: f.t.heightAt(f.x, f.y) + BALL_R };
      const L = swingToLaunch(clubById(id), lieAt(f.t, pos, yaw), { power: 1, startDir: 0, faceToPath: 0, tempo: 'smooth' }, yaw, null, { pos });
      const r = simulateShot(f.t, L, { record: false });
      if (r.final.surface === SURF.BUNKER) stay++;
    }
    assert.ok(stay / floors.length >= 0.88, `${id}: ${stay}/${floors.length} stay in the pot`);
  }
  // The flop is the escape.
  let out = 0;
  for (const f of floors) {
    const yaw = Math.atan2(f.t.cup.y - f.y, f.t.cup.x - f.x);
    const pos = { x: f.x, y: f.y, z: f.t.heightAt(f.x, f.y) + BALL_R };
    const L = swingToLaunch(clubById('LW'), lieAt(f.t, pos, yaw), { power: 1, startDir: 0, faceToPath: 0, tempo: 'smooth' }, yaw, null, { pos, shot: 'flop' });
    if (simulateShot(f.t, L, { record: false }).final.surface !== SURF.BUNKER) out++;
  }
  assert.ok(out / floors.length > 0.9, `LW flop: ${out}/${floors.length} out`);
});

test('pot bunkers: the steep face is sand or sod (BUNKER) right up to the lip, and no ball rests on it', () => {
  let faces = 0;
  for (const t of holes) {
    const g = t.grid;
    for (let j = 1; j < g.ny - 1; j += 1) {
      for (let i = 1; i < g.nx - 1; i += 1) {
        const x = g.minX + i + 0.5;
        const y = g.minY + j + 0.5;
        if (!t.potAt(x, y)) continue;
        if (slope(t, x, y) > REVET_GRAD) {
          faces++;
          assert.equal(t.surfaceAt(x, y), SURF.BUNKER, `steep pot face at ${x}, ${y} is ${t.surfaceAt(x, y)}`);
          assert.ok(!holdsBall(t, x, y), 'a revetted face holds no ball');
          // A ball set down on the face runs down to the floor.
          const r = simulateShot(t, { pos: { x, y, z: t.heightAt(x, y) + BALL_R }, vel: { x: 0, y: 0, z: 0 }, spin: { x: 0, y: 0, z: 0 }, mode: 'roll' }, { record: false, pin: false, maxT: 8 });
          assert.ok(slope(t, r.final.x, r.final.y) <= REVET_GRAD, `rests on the wall at ${x}, ${y}`);
        }
      }
    }
  }
  assert.ok(faces > 50, `${faces} face samples`);
});
