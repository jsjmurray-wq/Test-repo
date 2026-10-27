// Calibrates the club table: for each club, bisects ballSpeed so the simulated carry on flat
// fairway with no wind matches targetCarryYd, then prints the solved table with carry, total,
// apex, landing angle and the descent/roll numbers.
//
// Usage: node golf/scripts/calibrate.mjs [--check]
//   --check  only report current table carries against targets (exit 1 if any is off by > 3%, or
//            a trajectory shape is outside its TrackMan-based apex / descent-angle band).
//
// The ball speeds come from the carries; the aero fit (aero.js) decides the shapes, checked here
// against bands from TrackMan's Tour and LPGA averages (apex in yd, descent angle in deg).

import { CLUBS, stockLaunch } from '../src/clubs.js';
import { simulateShot, planeTerrain } from '../src/physics.js';
import { SURF, mToYd, ydToM } from '../src/constants.js';

const check = process.argv.includes('--check');
const SHAPE = {
  D: { apexYd: [26, 34], landDeg: [36, 42] },
  '5i': { apexYd: [25, 33], landDeg: [42, 49] },
  '7i': { apexYd: [26, 34], landDeg: [45, 50] },
  PW: { apexYd: [24, 31], landDeg: [47, 53] },
};
const terrain = planeTerrain({ surface: SURF.FAIRWAY });

function sim(club, ballSpeed) {
  return simulateShot(terrain, stockLaunch(club, { ballSpeed }), { record: false });
}

let bad = 0;
const rows = [];
for (const club of CLUBS) {
  if (club.kind === 'putter') continue;
  const target = ydToM(club.targetCarryYd);
  let bs = club.ballSpeed;
  if (!check) {
    let lo = 10;
    let hi = 100;
    for (let i = 0; i < 40; i++) {
      const mid = 0.5 * (lo + hi);
      if (sim(club, mid).carry < target) lo = mid;
      else hi = mid;
    }
    bs = Math.round(0.5 * (lo + hi) * 10) / 10;
  }
  const r = sim(club, bs);
  const err = (r.carry - target) / target;
  if (Math.abs(err) > 0.03) bad++;
  const landDeg = r.events.find((e) => e.type === 'land').angle;
  const apexYd = mToYd(r.apex);
  const band = SHAPE[club.id];
  let shape = '';
  if (band) {
    const ok = apexYd >= band.apexYd[0] && apexYd <= band.apexYd[1] && landDeg >= band.landDeg[0] && landDeg <= band.landDeg[1];
    shape = ok ? 'ok' : 'OFF';
    if (!ok) bad++;
  }
  rows.push({
    id: club.id,
    ballSpeed: bs,
    tableSpeed: club.ballSpeed,
    carryYd: +mToYd(r.carry).toFixed(1),
    targetYd: club.targetCarryYd,
    errPct: +(err * 100).toFixed(1),
    totalYd: +mToYd(r.total).toFixed(1),
    apexM: +r.apex.toFixed(1),
    apexYd: +apexYd.toFixed(1),
    landDeg: +landDeg.toFixed(1),
    shape,
    flightS: +r.events.find((e) => e.type === 'land').t.toFixed(2),
  });
}
console.table(rows);
if (!check) {
  console.log('Solved ballSpeed values:');
  console.log(rows.map((r) => `${r.id}: ${r.ballSpeed}`).join(', '));
}
if (bad) {
  console.log(`${bad} check(s) failed: carry off target by more than 3%, or a shape outside its band`);
  if (check) process.exit(1);
}
