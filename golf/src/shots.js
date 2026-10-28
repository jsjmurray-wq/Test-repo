// Special shots (docs/architecture.md section 8.4): draw, cut, stinger, punch, flop and bump & run.
// Pure module. A special shot changes the launch the swing would otherwise produce; swingToLaunch
// applies it after the lie and the partial-swing terms and before the D-plane, so the player's own
// swipe (its start direction and curve) still adds on top of the shot's intended shape.
//
//   SHOTS                                 [{id, name, short?, blurb, releaseK?, ...}] in menu order
//                                         ('normal' first); the factors are listed below
//   shotById(id)                          the shot, or SHOTS[0] (normal) for an unknown id
//   shotsFor(club, lie)                   eligible shot ids for this club and lie ('normal' always)
//   isEligible(shotId, club, lie)         one of shotsFor
//   applyShot(p, shotId, club, lie, opts) p = {ballSpeed, launchDeg, spinRpm, startDirDeg,
//                                         faceToPathDeg}; returns a new p. opts {handed, power}
//   shotIntent(shotId, club, handed)      {startDirDeg, faceToPathDeg}: the shape the shot itself
//                                         adds (toast labels separate it from the swipe's own)
//
// How each shot is played (right-hander; a left-hander's draw and cut are mirrored). The factors
// started from the section 8.4 table and were tuned against this physics until the table's results
// held for every eligible club (tests/shots.test.js):
//   draw     swing path 3 deg out to the right, face 4 deg closed to it (face 1 deg left of the
//            target): the ball starts on the aim line (irons; woods a touch left) and curves left.
//            The closed face delofts it: launch -2.5 deg, spin -8%, so it runs out 3-8 yd further.
//   cut      path 3 deg left, face 4 deg open to it: starts on the line and slides right. The open
//            face adds loft and glances: launch +1 deg, spin +8%, ball speed x 0.985 (carry -2-4%).
//   stinger  ball back, hands ahead, held-off finish: launch x 0.5, spin x 0.7, ball speed x 0.97.
//            A driver stays under 15 m, carries about a fifth less and runs 3-4x as far.
//   punch    a three-quarter knock-down under branches or into the wind: launch x 0.6, spin x 0.75,
//            speed x 0.91. Low flight, so the wind (which grows with height) hurts it far less.
//   flop     face wide open, full swing: launch +18 deg (at most 60), spin x 0.42, speed x 0.72.
//            Lands at 55 deg or steeper and stops within 3 yd on the green. The low spin is what a
//            slow, glancing open-face strike gives: at the stock spin the steep, slow ball zips back
//            4-6 yd here. Needs grass under the ball (not hardpan).
//   bump     a putting-style chip with a lofted iron: launch x 0.3, spin x 0.2, speed x 0.8. The
//            ball lands short and runs: carry is a quarter to under half of the total.
// releaseK (stinger, punch, bump): these shots are meant to run, so the target notch counts all of
// their release instead of the caddie's RELEASE_K share.
//
// Lateral signs: degrees, + = RIGHT of the aim line (as everywhere in swing.js). The D-plane split
// k (clubs.js dPlane: start = path + k x faceToPath) turns the path/face change into a start
// direction change of dPath + k x dFaceToPath.

import { SURF } from './constants.js';
import { clubById, dPlane } from './clubs.js';

// prettier-ignore
export const SHOTS = [
  { id: 'normal',  name: 'Normal',     blurb: 'Your stock swing' },
  { id: 'draw',    name: 'Draw',       blurb: 'Bends left, runs out', path: 3, faceToPath: -4, spin: 0.92, launchAdd: -2.5 },
  { id: 'cut',     name: 'Cut',        blurb: 'Slides right, lands soft', path: -3, faceToPath: 4, spin: 1.08, launchAdd: 1, speed: 0.985 },
  { id: 'stinger', name: 'Stinger',    blurb: 'Low bullet under the wind', launch: 0.5, spin: 0.7, speed: 0.97, releaseK: 1,
    clubs: ['D', '3W', '5W', '4H', '5i', '6i'], notFrom: [SURF.BUNKER, SURF.FESCUE] },
  { id: 'punch',   name: 'Punch',      blurb: 'Low under trees and wind', launch: 0.6, spin: 0.75, speed: 0.91, releaseK: 1,
    clubs: ['4H', '5i', '6i', '7i', '8i', '9i', 'PW', 'GW'] },
  { id: 'flop',    name: 'Flop',       blurb: 'Sky-high, stops dead', launchAdd: 18, spin: 0.42, speed: 0.72,
    clubs: ['GW', 'SW', 'LW'], notFrom: [SURF.WASTE, SURF.DESERT] },
  { id: 'bump',    name: 'Bump & run', short: 'Bump', blurb: 'Lands short, rolls out', launch: 0.3, spin: 0.2, speed: 0.8, releaseK: 1,
    clubs: ['7i', '8i', '9i', 'PW', 'GW', 'SW'] },
];

export const FLOP_MAX_LAUNCH = 60; // deg: a flop off a short swing (partial-swing wedge loft) is capped here

const BY_ID = new Map(SHOTS.map((s) => [s.id, s]));
const clubOf = (club) => (typeof club === 'string' ? clubById(club) : club);

export function shotById(id) {
  return BY_ID.get(id) || SHOTS[0];
}

// Eligible for one shot: every full-swing club may draw or cut; the others have a club list and
// lies they cannot be played from. The putter only putts.
export function isEligible(shotId, club, lie) {
  const c = clubOf(club);
  const s = BY_ID.get(shotId);
  if (!s) return false;
  if (s.id === 'normal') return true;
  if (!c || c.kind === 'putter') return false;
  if (s.clubs && !s.clubs.includes(c.id)) return false;
  if (s.notFrom && lie && s.notFrom.includes(lie.surface)) return false;
  return true;
}

export function shotsFor(club, lie) {
  return SHOTS.filter((s) => isEligible(s.id, club, lie)).map((s) => s.id);
}

// The shape a shot adds to the swing (deg, + = right): what applyShot adds to startDirDeg and
// faceToPathDeg. Zero for the straight shots.
export function shotIntent(shotId, club, handed = 'R') {
  const s = BY_ID.get(shotId);
  const c = clubOf(club);
  if (!s || !c || !s.faceToPath) return { startDirDeg: 0, faceToPathDeg: 0 };
  const m = handed === 'L' ? -1 : 1;
  const k = dPlane(c, 1, 0).startDirDeg; // start = path + k x faceToPath
  return { startDirDeg: m * (s.path + k * s.faceToPath), faceToPathDeg: m * s.faceToPath };
}

// p = {ballSpeed, launchDeg, spinRpm, startDirDeg, faceToPathDeg} (after the lie and the partial
// swing); returns a new object with the shot applied (other fields copied through). 'normal', an
// unknown id and the putter return an unchanged copy. Eligibility is the caller's business
// (game.setShot only accepts eligible shots); this applies whatever it is given.
export function applyShot(p, shotId, club, lie, opts = {}) {
  const out = { ...p };
  const s = BY_ID.get(shotId);
  const c = clubOf(club);
  if (!s || s.id === 'normal' || !c || c.kind === 'putter') return out;
  if (s.speed) out.ballSpeed = (p.ballSpeed || 0) * s.speed;
  if (s.spin) out.spinRpm = (p.spinRpm || 0) * s.spin;
  if (s.launch) out.launchDeg = (p.launchDeg || 0) * s.launch;
  if (s.launchAdd) out.launchDeg = (out.launchDeg ?? p.launchDeg ?? 0) + s.launchAdd;
  if (s.id === 'flop') out.launchDeg = Math.min(FLOP_MAX_LAUNCH, out.launchDeg);
  if (s.faceToPath) {
    const it = shotIntent(s.id, c, opts.handed);
    out.startDirDeg = (p.startDirDeg || 0) + it.startDirDeg;
    out.faceToPathDeg = (p.faceToPathDeg || 0) + it.faceToPathDeg;
  }
  return out;
}
