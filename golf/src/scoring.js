// Scorecard for a round. Pure module; the card is plain JSON (it lives in the save game) and
// matches the shape ui.showScorecard() takes.
//
//   newCard(course) -> {course, holes:[{n, par, si, lengthM, strokes:null, putts:null,
//                       penalties:null, fir:null, gir:null, pickUp:false}]}
//       A mixed round (course.mixed) numbers its holes 1..n in playing order and adds each hole's
//       own course: from {courseId, name, theme, n}.
//   recordHole(card, i, {strokes, putts, penalties, fir, gir, pickUp}) -> card (mutated)
//   totals(card) -> {played, strokes, par, toPar, coursePar, putts, penalties,
//                    fir:{hit, of}, gir:{hit, of}, pickUps, out, in}
//       out: holes 1-9, in: holes 10-18 (null on a nine-hole card), each
//       {played, strokes, par, toPar, coursePar, putts}.
//
// fir is null on par 3s (no fairway to hit). toPar counts only the holes played so far.

import { buildPath } from './spline.js';

export function newCard(course) {
  return {
    course: course.name,
    holes: course.holes.map((h, i) => ({
      n: course.mixed ? i + 1 : h.n || i + 1,
      ...(course.mixed && course.holeCourses ? { from: { courseId: course.holeCourses[i].id, name: course.holeCourses[i].name, theme: course.holeCourses[i].theme, n: h.n || i + 1 } } : {}),
      par: h.par,
      si: h.si,
      lengthM: h.path ? Math.round(buildPath(h.path).length) : undefined,
      strokes: null,
      putts: null,
      penalties: null,
      fir: null,
      gir: null,
      pickUp: false,
    })),
  };
}

export function recordHole(card, i, { strokes, putts = 0, penalties = 0, fir = null, gir = false, pickUp = false } = {}) {
  const h = card.holes[i];
  h.strokes = strokes;
  h.putts = putts;
  h.penalties = penalties;
  h.fir = h.par >= 4 ? !!fir : null;
  h.gir = !!gir;
  h.pickUp = !!pickUp;
  return card;
}

export function totals(card) {
  const t = { played: 0, strokes: 0, par: 0, toPar: 0, coursePar: 0, putts: 0, penalties: 0, fir: { hit: 0, of: 0 }, gir: { hit: 0, of: 0 }, pickUps: 0 };
  for (const h of card.holes) {
    t.coursePar += h.par;
    if (h.strokes == null) continue;
    t.played++;
    t.strokes += h.strokes;
    t.par += h.par;
    t.putts += h.putts || 0;
    t.penalties += h.penalties || 0;
    if (h.pickUp) t.pickUps++;
    if (h.fir !== null && h.fir !== undefined) {
      t.fir.of++;
      if (h.fir) t.fir.hit++;
    }
    t.gir.of++;
    if (h.gir) t.gir.hit++;
  }
  t.toPar = t.strokes - t.par;
  t.out = sumHoles(card.holes.slice(0, 9));
  t.in = card.holes.length > 9 ? sumHoles(card.holes.slice(9, 18)) : null;
  return t;
}

// Out / In: the front and back nine's sums.
function sumHoles(holes) {
  const t = { played: 0, strokes: 0, par: 0, toPar: 0, coursePar: 0, putts: 0 };
  for (const h of holes) {
    t.coursePar += h.par;
    if (h.strokes == null) continue;
    t.played++;
    t.strokes += h.strokes;
    t.par += h.par;
    t.putts += h.putts || 0;
  }
  t.toPar = t.strokes - t.par;
  return t;
}
