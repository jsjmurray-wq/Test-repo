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
//   mixedSummary() -> menu card data for the mixed round (par 36, no fixed length)
//   isCourseId(id)  a known course id or 'mixed';  courseName(id) -> display name

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

export function isCourseId(id) {
  return id === MIXED_ID || COURSES.some((c) => c.id === id);
}

export function courseName(id) {
  return id === MIXED_ID ? MIXED_NAME : courseById(id).name;
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

export function drawMixedHoles(seed) {
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

// A saved draw is used as is when it names nine real holes.
function validPicks(picks) {
  if (!Array.isArray(picks) || picks.length !== 9) return null;
  for (const p of picks) {
    const c = p && COURSES.find((k) => k.id === p.courseId);
    if (!c || !Number.isInteger(p.hole) || !c.holes[p.hole]) return null;
  }
  return picks.map((p) => ({ courseId: p.courseId, hole: p.hole }));
}

export function mixedCourse(seed, picks = null) {
  const p = validPicks(picks) || drawMixedHoles(seed);
  const holeCourses = p.map((q) => courseById(q.courseId));
  return {
    id: MIXED_ID,
    name: MIXED_NAME,
    tagline: MIXED_TAGLINE,
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

export function mixedSummary() {
  return {
    id: MIXED_ID,
    name: MIXED_NAME,
    tagline: MIXED_TAGLINE,
    theme: 'mixed',
    holes: 9,
    par: Object.entries(MIX_PARS).reduce((a, [par, n]) => a + par * n, 0),
    lengthM: null,
    yards: null,
    mixed: true,
    conditions: { ...DEFAULT_CONDITIONS },
  };
}
