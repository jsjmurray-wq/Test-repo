// Prints per-hole yardage, par, surface areas, tree count and build time.
// Usage: node golf/scripts/course-report.mjs [seed]

import { COURSE, coursePar } from '../src/course.js';
import { buildHole } from '../src/terrain.js';
import { SURF, SURF_NAMES, mToYd } from '../src/constants.js';

const seed = Number(process.argv[2] || 1);
const pad = (v, n) => String(v).padStart(n);
const names = [SURF.TEE, SURF.FAIRWAY, SURF.ROUGH, SURF.FRINGE, SURF.GREEN, SURF.BUNKER, SURF.WATER, SURF.OOB];

console.log(`${COURSE.name}  par ${coursePar()}  seed ${seed}`);
console.log(
  ` #  par   yd    m  ` + names.map((s) => pad(SURF_NAMES[s].slice(0, 7), 8)).join('') + '  (m²)  trees stakes  elev(tee→cup)  ms',
);
let totYd = 0;
let totMs = 0;
for (const def of COURSE.holes) {
  // Warm-up build so the timing reflects JIT-compiled code, then the timed build.
  if (def === COURSE.holes[0]) buildHole(def, { pinIndex: 0, seed });
  const t0 = performance.now();
  const t = buildHole(def, { pinIndex: 0, seed });
  const ms = performance.now() - t0;
  totMs += ms;
  const counts = new Array(9).fill(0);
  for (const v of t.sgrid.data) counts[v]++;
  const area = (s) => Math.round(counts[s] * t.sgrid.step * t.sgrid.step);
  const yd = Math.round(mToYd(t.lengthM));
  totYd += yd;
  console.log(
    `${pad(def.n, 2)}  ${pad(def.par, 3)} ${pad(yd, 4)} ${pad(Math.round(t.lengthM), 4)}  ` +
      names.map((s) => pad(area(s), 8)).join('') +
      `        ${pad(t.trees.length, 5)} ${pad(t.stakes.length, 6)}  ${pad((t.cup.z - t.tee.z).toFixed(1), 6)} m      ${pad(ms.toFixed(0), 4)}`,
  );
}
console.log(`total ${totYd} yd, build ${totMs.toFixed(0)} ms (avg ${(totMs / COURSE.holes.length).toFixed(0)} ms/hole)`);
