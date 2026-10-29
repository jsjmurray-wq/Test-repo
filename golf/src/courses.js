// Course registry (docs/architecture.md section 8.2): the four courses in menu order, lookup by id,
// and a summary for menus and cards. Pure module.
//
//   COURSES                    [PINES, DESERT, WATER, LINKS]
//   DEFAULT_COURSE_ID          'pines'
//   courseById(id)             the course, or COURSES[0] for an unknown id
//   courseSummary(course)      {id, name, tagline, theme, holes, par, lengthM, yards, conditions}
//
// Course object: {id, name, tagline, theme:'parkland'|'desert'|'tropical'|'links',
//                 conditions:{firm, greenStimpFt, wind:'normal'|'windy'}, holes:[HoleDef x 9]}
//
// Mixed rounds (the "Mixed Nine" card): nine holes drawn at random from all 36, seeded per round.
//   MIXED_ID 'mixed', MIXED_NAME, MIXED_TAGLINE
//   drawMixedHoles(seed) -> [{courseId, hole (0-based)} x 9]: par 36 like every course (two par 3s,
//       five par 4s, two par 5s), two or three holes from each course, opening with a par 4 and
//       never two holes of one course in a row when that can be avoided. Deterministic per seed.
//   mixedCourse(seed, picks?) -> a course object {id:'mixed', mixed:true, picks, holeCourses, holes,
//       ...} whose holes are the source courses' own HoleDefs (picks: a saved draw; invalid or
//       missing -> drawn from the seed). Each hole keeps its own course: holeCourse(course, i)
//       gives the course to build hole i with (theme, conditions, wind), the course itself for a
//       normal round.
//   mixedSummary(n = 9) -> menu card data for a mixed round (par 36 / 72, no fixed length)
//   isCourseId(id)  a known course id, 'mixed' or 'mixed18';  courseName(id) -> display name
//
// Mixed Eighteen (section 8.8): MIXED18_ID 'mixed18' plays 18 holes drawn the same way.
//   drawMixedHoles(seed, 18) -> two par-36 nines with no hole twice (4 par 3s, 4 par 5s, par 72),
//       four or five holes from each course, par 4s on the 1st and 10th, never two holes of one
//       course in a row (also across 9 -> 10) and no back-to-back par 3s or par 5s when a retry
//       can avoid them. The nine-hole draw (n = 9) is unchanged for every seed.
//   mixedCourse(seed, picks?, n?) -> as above with n holes (n: explicit, else a valid saved
//       draw's length, else 9); MIXED_SIZES [9, 18]; isMixedId(id); mixedId(n) -> 'mixed' |
//       'mixed18'; mixedHoles(id) -> 9 | 18 (0 for a fixed course)

import { COURSE } from './course.js';
import { DESERT } from './course-desert.js';
import { WATER } from './course-water.js';
import { LINKS } from './course-links.js';
import { buildPath } from './spline.js';
import { DEFAULT_CONDITIONS, mToYd } from './constants.js';
import { mulberry32 } from './rng.js';

export const PINES = COURSE;
export const COURSES = [PINES, DESERT, WATER, LINKS];
export const DEFAULT_COURSE_ID = 'pines';

export function courseById(id) {
  return COURSES.find((c) => c.id === id) || COURSES[0];
}

// Card data for a course: par and length (the centreline spline lengths rounded to the metre per
// hole, as scoring.newCard does, so the menu card and the scorecard's Out total agree).
export function courseSummary(course) {
  let lengthM = 0;
  let par = 0;
  for (const h of course.holes) {
    lengthM += Math.round(buildPath(h.path).length);
    par += h.par;
  }
  return {
    id: course.id,
    name: course.name,
    tagline: course.tagline || '',
    theme: course.theme || 'parkland',
    holes: course.holes.length,
    par,
    lengthM,
    yards: Math.round(mToYd(lengthM)),
    conditions: { ...DEFAULT_CONDITIONS, ...(course.conditions || {}) },
  };
}

// ------------------------------------------------------------------ mixed rounds

export const MIXED_ID = 'mixed';
export const MIXED_NAME = 'Mixed Nine';
export const MIXED_TAGLINE = 'Nine random holes from all four courses';
const MIX_PARS = { 3: 2, 4: 5, 5: 2 }; // par 36, the same make-up as every course
const MIX_MIN = 2; // holes per course (9 = 2 + 2 + 2 + 3)
const MIX_MAX = 3;

export const MIXED18_ID = 'mixed18';
export const MIXED18_NAME = 'Mixed Eighteen';
export const MIXED18_TAGLINE = 'Eighteen random holes from all four courses';
export const MIXED_SIZES = [9, 18];

export function isMixedId(id) {
  return id === MIXED_ID || id === MIXED18_ID;
}

export function mixedId(n) {
  return Number(n) === 18 ? MIXED18_ID : MIXED_ID;
}

export function mixedHoles(id) {
  return id === MIXED18_ID ? 18 : id === MIXED_ID ? 9 : 0;
}

export function isCourseId(id) {
  return isMixedId(id) || COURSES.some((c) => c.id === id);
}

export function courseName(id) {
  return id === MIXED18_ID ? MIXED18_NAME : id === MIXED_ID ? MIXED_NAME : courseById(id).name;
}

function shuffle(a, rng) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Playing order: a par 4 to open, then each next hole from another course than the last one's,
// taking the course with the most holes left (so the last few never have to repeat a course;
// ties and the hole within a course follow the random draw order).
function mixOrder(picks) {
  const left = picks.slice();
  const out = [];
  const first = left.findIndex((h) => h.par === 4);
  out.push(left.splice(first < 0 ? 0 : first, 1)[0]);
  while (left.length) {
    const prev = out[out.length - 1].courseId;
    const count = {};
    for (const h of left) count[h.courseId] = (count[h.courseId] || 0) + 1;
    let k = -1;
    for (let j = 0; j < left.length; j++) {
      const c = left[j].courseId;
      if (c !== prev && (k < 0 || count[c] > count[left[k].courseId])) k = j;
    }
    out.push(left.splice(k < 0 ? 0 : k, 1)[0]);
  }
  return out;
}

export function drawMixedHoles(seed, n = 9) {
  if (Number(n) === 18) return drawMixed18(seed);
  const rng = mulberry32(((seed >>> 0) ^ 0x6d1f3a5b) >>> 0);
  const all = [];
  for (const c of COURSES) c.holes.forEach((h, i) => all.push({ courseId: c.id, hole: i, par: h.par }));
  let pick = null;
  for (let attempt = 0; attempt < 64 && !pick; attempt++) {
    shuffle(all, rng);
    const need = { ...MIX_PARS };
    const per = {};
    const got = [];
    let three = false; // only one course may give a third hole (2 + 2 + 2 + 3)
    for (const h of all) {
      if (got.length === 9) break;
      const n = per[h.courseId] || 0;
      if (!need[h.par] || n >= MIX_MAX || (n === MIX_MAX - 1 && three)) continue;
      got.push(h);
      need[h.par]--;
      per[h.courseId] = n + 1;
      if (n + 1 === MIX_MAX) three = true;
    }
    if (got.length === 9 && COURSES.every((c) => (per[c.id] || 0) >= MIX_MIN)) pick = got;
  }
  // (Practically unreachable) fallback: any nine with the par make-up.
  if (!pick) {
    const need = { ...MIX_PARS };
    pick = all.filter((h) => need[h.par] > 0 && need[h.par]--);
  }
  return mixOrder(pick).map((h) => ({ courseId: h.courseId, hole: h.hole }));
}

// ---- Mixed Eighteen: two nines, each with the par make-up and course spread of a Mixed Nine.

// One nine from `pool`: pars 2/5/2, two or three holes per course, exactly one course giving
// three (never `noThree`, the course that gave the other nine its third). -> {got, three} | null
function pickNine(pool, rng, noThree) {
  for (let attempt = 0; attempt < 64; attempt++) {
    shuffle(pool, rng);
    const need = { ...MIX_PARS };
    const per = {};
    const got = [];
    let three = null;
    for (const h of pool) {
      if (got.length === 9) break;
      const k = per[h.courseId] || 0;
      if (!need[h.par] || k >= MIX_MAX || (k === MIX_MAX - 1 && (three || h.courseId === noThree))) continue;
      got.push(h);
      need[h.par]--;
      per[h.courseId] = k + 1;
      if (k + 1 === MIX_MAX) three = h.courseId;
    }
    if (got.length === 9 && COURSES.every((c) => (per[c.id] || 0) >= MIX_MIN)) return { got, three };
  }
  return null;
}

// Playing order of one nine after the hole `prev` ({courseId, par} or null): a par 4 from another
// course to open, then the course with the most holes left that is not the last one's; among
// those, a hole whose par differs from a par-3 or par-5 predecessor.
function mixOrder18(picks, prev = null) {
  const left = picks.slice();
  const out = [];
  const count = (arr) => {
    const c = {};
    for (const h of arr) c[h.courseId] = (c[h.courseId] || 0) + 1;
    return c;
  };
  let cnt = count(left);
  let f = -1;
  for (let j = 0; j < left.length; j++) {
    const h = left[j];
    if (h.par === 4 && (!prev || h.courseId !== prev.courseId) && (f < 0 || cnt[h.courseId] > cnt[left[f].courseId])) f = j;
  }
  out.push(left.splice(f < 0 ? 0 : f, 1)[0]);
  while (left.length) {
    const p = out[out.length - 1];
    cnt = count(left);
    const parOk = (h) => (p.par === 4 || h.par !== p.par ? 1 : 0);
    let k = -1;
    for (let j = 0; j < left.length; j++) {
      const h = left[j];
      if (h.courseId === p.courseId) continue;
      if (k < 0) {
        k = j;
        continue;
      }
      const b = left[k];
      const d = cnt[h.courseId] - cnt[b.courseId];
      if (d > 0 || (d === 0 && parOk(h) > parOk(b))) k = j;
    }
    out.push(left.splice(k < 0 ? 0 : k, 1)[0]);
  }
  return out;
}

function parPairs(holes) {
  let n = 0;
  for (let i = 1; i < holes.length; i++) if (holes[i].par !== 4 && holes[i].par === holes[i - 1].par) n++;
  return n;
}

function drawMixed18(seed) {
  const rng = mulberry32(((seed >>> 0) ^ 0x6d1f3a5b ^ 0x1b873593) >>> 0);
  const all = [];
  for (const c of COURSES) c.holes.forEach((h, i) => all.push({ courseId: c.id, hole: i, par: h.par }));
  let best = null;
  let bestPairs = Infinity;
  for (let attempt = 0; attempt < 32 && bestPairs > 0; attempt++) {
    const a = pickNine(all.slice(), rng, null);
    if (!a) continue;
    const used = new Set(a.got.map((h) => `${h.courseId}:${h.hole}`));
    const b = pickNine(all.filter((h) => !used.has(`${h.courseId}:${h.hole}`)), rng, a.three);
    if (!b) continue;
    const front = mixOrder18(a.got);
    const back = mixOrder18(b.got, front[8]);
    const r = front.concat(back);
    let ok = r[0].par === 4 && r[9].par === 4;
    for (let i = 1; i < 18 && ok; i++) if (r[i].courseId === r[i - 1].courseId) ok = false;
    if (!ok) continue;
    const pairs = parPairs(r);
    if (pairs < bestPairs) {
      best = r;
      bestPairs = pairs;
    }
  }
  // (Practically unreachable) fallback: two nines of the par make-up from distinct holes.
  if (!best) {
    const need = { 3: 4, 4: 10, 5: 4 };
    best = all.filter((h) => need[h.par] > 0 && need[h.par]--);
  }
  return best.map((h) => ({ courseId: h.courseId, hole: h.hole }));
}

// A saved draw is used as is when it names n (9 or 18; any of those when n is null) real holes.
function validPicks(picks, n = null) {
  if (!Array.isArray(picks) || !(n == null ? MIXED_SIZES.includes(picks.length) : picks.length === n)) return null;
  for (const p of picks) {
    const c = p && COURSES.find((k) => k.id === p.courseId);
    if (!c || !Number.isInteger(p.hole) || !c.holes[p.hole]) return null;
  }
  return picks.map((p) => ({ courseId: p.courseId, hole: p.hole }));
}

export function mixedCourse(seed, picks = null, n = null) {
  const size = n != null && MIXED_SIZES.includes(Number(n)) ? Number(n) : null;
  const p = validPicks(picks, size) || drawMixedHoles(seed, size || 9);
  const holeCourses = p.map((q) => courseById(q.courseId));
  const eighteen = p.length === 18;
  return {
    id: eighteen ? MIXED18_ID : MIXED_ID,
    name: eighteen ? MIXED18_NAME : MIXED_NAME,
    tagline: eighteen ? MIXED18_TAGLINE : MIXED_TAGLINE,
    theme: 'mixed',
    mixed: true,
    conditions: { ...DEFAULT_CONDITIONS },
    picks: p,
    holeCourses,
    holes: p.map((q, i) => holeCourses[i].holes[q.hole]),
  };
}

export function holeCourse(course, i) {
  return (course && course.holeCourses && course.holeCourses[i]) || course;
}

export function mixedSummary(n = 9) {
  const holes = Number(n) === 18 ? 18 : 9;
  return {
    id: mixedId(holes),
    name: holes === 18 ? MIXED18_NAME : MIXED_NAME,
    tagline: holes === 18 ? MIXED18_TAGLINE : MIXED_TAGLINE,
    theme: 'mixed',
    holes,
    par: (holes / 9) * Object.entries(MIX_PARS).reduce((a, [par, k]) => a + par * k, 0),
    lengthM: null,
    yards: null,
    mixed: true,
    conditions: { ...DEFAULT_CONDITIONS },
  };
}
