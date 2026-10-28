// Lie of the ball: the surface it sits on, the slope of the stance relative to the aim line, and
// the launch factors that follow from both (docs/architecture.md section 4). Pure module.
//
//   lieAt(terrain, pos, aimYaw, {handed}) -> Lie
//   applyLie(params, lie, club) -> params with the lie applied
//
// Lie = {surface, slopeAlong, slopeAcross, label, factors:{speed, spin, launch, sdir},
//        dirOffset, greenDist, aimYaw, puttSurf}
//   slopeAlong   ground rise per metre toward the target (+ = uphill lie)
//   slopeAcross  ground rise per metre to the RIGHT of the aim line. For a right-hander (who stands
//                on the left of the line) + means the ball is above the feet.
//   factors      SURFACES[surface].lie with the slope terms folded in:
//                  speed  ball-speed multiplier       spin    spin multiplier
//                  launch degrees added to launch     sdir    extra start-direction sigma (deg)
//   dirOffset    start-direction shift (deg, + = right) from a sidehill stance
//   greenDist    metres from the ball to the green edge (0 on the green)
//   puttSurf     this hole's green ground parameters (surfaceParams: the course's green speed
//                applied), for pacing putts with puttSpeedForDistance
//   label        the surface name ('Fairway', 'Waste area', 'Desert', 'Fescue', ...) plus the slope
//
// Slope physics, simplified:
// * Up/downhill: the golfer sets the shoulders with the slope, so the effective loft grows by
//   about 60% of the slope angle (launch += 0.6 x angle). Uphill the club also digs into the
//   slope and loses energy: speed x (1 - 0.4 x slope).
// * Sidehill: with the ball above the feet the swing gets flatter and the toe-up face points
//   left, so the ball starts left; below the feet it starts right. Either way the ball goes the
//   way the ground falls, so the shift does not depend on handedness: -0.5 x across-angle,
//   clamped to +-4 deg.
// * Bunker: woods can't be swept off sand (speed x 0.5). A greenside wedge plays an explosion
//   shot: the club enters the sand behind the ball, so speed x 0.6, spin x 0.5 and launch +6 deg
//   replace the generic bunker factors.
// * Waste area, desert and fescue (version 2 courses) are general area: their factors come from
//   SURFACES (firm sand clips cleanly, stony desert and long fescue grab the club). Knee-high
//   fescue and desert scrub wrap round the hosel of a long, shallow-faced club: the ball-speed
//   factor falls with loft (TALL_LIE: fescue x0.45 for a 3-wood up to the table's x0.70 for the
//   9-iron and wedges; desert x0.63 up to x0.75), so the club out of fescue is a short iron or a
//   wedge that advances it 60-100 yd, not a 3-wood.
// * In a bush: a ball lying inside a shrub or gorse bush (physics lets it be hacked out of the bush
//   it lies in) is close to unplayable: speed x BUSH_LIE.speed (woods x woodSpeed more), spin cut,
//   a higher launch and a wide start-direction scatter on top of the ground under it. lie.bush is
//   the bush's kind and the label says so ('Fescue · In the gorse').
// * Rough: grass between the face and the ball cuts the spin (a "flier"), most for the lofted
//   clubs whose spin comes from a clean strike: the full rough spin factor for 8-iron and up,
//   rising to about x0.8 for woods, which have little spin to lose. Woods sweep the ball but the
//   shallow face can't get under it: their ball speed totals x0.85 in rough (slope terms apply).

import { SURF, SURF_NAMES, SURFACES } from './constants.js';
import { clamp, DEG } from './vec3.js';
import { surfaceParams, treeHit } from './physics.js';

export const EXPLOSION_RANGE = 40; // m from the green edge for a greenside explosion shot
export const WOOD_ROUGH_SPEED = 0.85; // total ball-speed factor of a wood from the rough
const ROUGH_SPIN_LOFT = [10, 35]; // deg: the rough's spin cut scales from 45% to 100% over these lofts
const LABEL_SLOPE = 0.05; // 5% before a slope is worth naming in the lie chip
// Tall lies: total ball-speed factor [at loft <= lo, at loft >= hi] (linear in loft between).
export const TALL_LIE = {
  [SURF.FESCUE]: { lo: 15, hi: 40, at: [0.45, 0.7] },
  [SURF.DESERT]: { lo: 15, hi: 40, at: [0.63, 0.75] },
};
export const BUSH_LIE = { speed: 0.5, woodSpeed: 0.6, spin: 0.4, launch: 4, sdir: 4 };

// The low bush (shrub or gorse) the ball at pos (centre) lies inside, or null.
function bushAt(terrain, pos) {
  if (!terrain.treesNear || pos.z == null) return null;
  for (const tr of terrain.treesNear(pos.x, pos.y, 3)) {
    if ((tr.kind === 'shrub' || tr.kind === 'gorse') && tr.canopy) {
      const h = treeHit(tr, pos, pos);
      if (h && h.kind === 'canopy') return tr.kind;
    }
  }
  return null;
}

// Distance (m) from (x, y) to the edge of the green ellipse {cx, cy, rx, ry, rot}, 0 inside.
// Radial approximation: exact for circles, close for the mild ellipses of the course.
export function greenEdgeDist(green, x, y) {
  if (!green) return Infinity;
  const dx = x - green.cx;
  const dy = y - green.cy;
  const c = Math.cos(green.rot || 0);
  const s = Math.sin(green.rot || 0);
  const u = dx * c + dy * s;
  const v = -dx * s + dy * c;
  const q = Math.hypot(u / green.rx, v / green.ry);
  if (q <= 1) return 0;
  return Math.hypot(u, v) * (1 - 1 / q);
}

export function lieAt(terrain, pos, aimYaw, { handed = 'R' } = {}) {
  const surface = terrain.surfaceAt(pos.x, pos.y);
  const g = terrain.gradAt(pos.x, pos.y, { x: 0, y: 0 });
  const dx = Math.cos(aimYaw);
  const dy = Math.sin(aimYaw);
  // right = dir x z-up = (dy, -dx)
  const slopeAlong = g.x * dx + g.y * dy;
  const slopeAcross = g.x * dy - g.y * dx;
  const alongDeg = Math.atan(slopeAlong) / DEG;
  const acrossDeg = Math.atan(slopeAcross) / DEG;

  const base = (SURFACES[surface] || SURFACES[SURF.ROUGH]).lie;
  const bush = bushAt(terrain, pos);
  const factors = {
    speed: base.speed * (1 - 0.4 * Math.max(0, slopeAlong)) * (bush ? BUSH_LIE.speed : 1),
    spin: base.spin * (bush ? BUSH_LIE.spin : 1),
    launch: base.launch + 0.6 * alongDeg + (bush ? BUSH_LIE.launch : 0),
    sdir: base.sdir + (bush ? BUSH_LIE.sdir : 0),
  };
  const dirOffset = clamp(-0.5 * acrossDeg, -4, 4) || 0; // (no -0)

  // Label: surface name plus the dominant slope when it is noticeable (greens are read separately),
  // or the bush the ball is in.
  let label = SURF_NAMES[surface] || 'Rough';
  if (bush) label += bush === 'gorse' ? ' · In the gorse' : ' · In a bush';
  else if (surface !== SURF.GREEN && surface !== SURF.TEE) {
    const a = Math.abs(slopeAlong);
    const c = Math.abs(slopeAcross);
    if (Math.max(a, c) >= LABEL_SLOPE) {
      if (a >= c) label += slopeAlong > 0 ? ' · Uphill' : ' · Downhill';
      else {
        // Ground rising to the right puts the ball above a right-hander's feet (below a lefty's).
        const above = handed === 'L' ? slopeAcross < 0 : slopeAcross > 0;
        label += above ? ' · Ball above feet' : ' · Ball below feet';
      }
    }
  }

  return {
    surface,
    slopeAlong,
    slopeAcross,
    label,
    factors,
    dirOffset,
    bush,
    greenDist: greenEdgeDist(terrain.green, pos.x, pos.y),
    aimYaw,
    puttSurf: surfaceParams(terrain, SURF.GREEN),
  };
}

// Applies a lie to launch-monitor numbers {ballSpeed, launchDeg, spinRpm, startDirDeg, ...}.
// Returns a new object (other fields are copied through). The putter ignores the lie: putts are
// paced by distance (swing.js) and start rolling.
export function applyLie(params, lie, club) {
  const out = { ...params };
  if (!lie || (club && club.kind === 'putter')) return out;
  const kind = club ? club.kind : 'iron';
  let { speed, spin, launch } = lie.factors;
  if (lie.surface === SURF.BUNKER) {
    if (kind === 'wedge' && lie.greenDist <= EXPLOSION_RANGE) {
      // Explosion: replaces the generic bunker factors; the slope terms stay.
      const b = SURFACES[SURF.BUNKER].lie;
      speed = (speed / b.speed) * 0.6;
      spin = (spin / b.spin) * 0.5;
      launch = launch - b.launch + 6;
    } else if (kind === 'wood') {
      speed *= 0.5;
    }
  } else if (lie.surface === SURF.ROUGH) {
    const base = SURFACES[SURF.ROUGH].lie;
    const loft = club ? club.loft : 34;
    const cut = clamp((loft - ROUGH_SPIN_LOFT[0]) / (ROUGH_SPIN_LOFT[1] - ROUGH_SPIN_LOFT[0]), 0.45, 1);
    spin = (spin / base.spin) * (1 - (1 - base.spin) * cut);
    if (kind === 'wood') speed *= WOOD_ROUGH_SPEED / base.speed;
  } else if (TALL_LIE[lie.surface]) {
    // Fescue / desert: the table's factor is the short irons'; longer, flatter clubs lose more.
    const tl = TALL_LIE[lie.surface];
    const loft = club ? club.loft : 34;
    const f = tl.at[0] + (tl.at[1] - tl.at[0]) * clamp((loft - tl.lo) / (tl.hi - tl.lo), 0, 1);
    speed *= f / SURFACES[lie.surface].lie.speed;
  }
  if (lie.bush && kind === 'wood') speed *= BUSH_LIE.woodSpeed;
  out.ballSpeed = (params.ballSpeed || 0) * speed;
  out.spinRpm = (params.spinRpm || 0) * spin;
  out.launchDeg = (params.launchDeg || 0) + launch;
  out.startDirDeg = (params.startDirDeg || 0) + (lie.dirOffset || 0);
  return out;
}

// True when the lie calls for the greenside explosion (used by the caddie and the HUD).
export function isExplosion(lie, club) {
  return !!lie && !!club && lie.surface === SURF.BUNKER && club.kind === 'wedge' && lie.greenDist <= EXPLOSION_RANGE;
}
