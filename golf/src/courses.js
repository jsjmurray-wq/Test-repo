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

import { COURSE } from './course.js';
import { DESERT } from './course-desert.js';
import { WATER } from './course-water.js';
import { LINKS } from './course-links.js';
import { buildPath } from './spline.js';
import { DEFAULT_CONDITIONS, mToYd } from './constants.js';

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
