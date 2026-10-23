// Builds the collision and drawing geometry of the table from constants.js.
//
// Pocket ids (shared by physics, rules, render, AI):
//   0 head-left corner  (-HL, +HW)     1 side-left  (0, +HW)     2 foot-left corner  (+HL, +HW)
//   5 head-right corner (-HL, -HW)     4 side-right (0, -HW)     3 foot-right corner (+HL, -HW)
//
// Cushion segments are one-sided: a ball collides only when it is on the side `n` points to
// (inside the playing area / pocket mouth) and moving against n. Jaw noses are small circles at
// every segment end so balls can rattle off the points.

import {
  BALL_R,
  HL,
  HW,
  CORNER_MOUTH,
  SIDE_MOUTH,
  CORNER_FACING_DEG,
  SIDE_FACING_DEG,
  CORNER_CAPTURE_R,
  SIDE_CAPTURE_R,
  SIDE_CAPTURE_OFFSET,
  JAW_NOSE_R,
  CUSHION_DEPTH,
  HEAD_STRING_X,
  FOOT_SPOT,
  HEAD_SPOT,
} from './constants.js';

const DEG = Math.PI / 180;

function seg(ax, ay, bx, by, towardX, towardY, kind, pocket) {
  // Normal perpendicular to ab, pointing toward (towardX, towardY).
  const dx = bx - ax;
  const dy = by - ay;
  const l = Math.hypot(dx, dy);
  let nx = -dy / l;
  let ny = dx / l;
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  if ((towardX - mx) * nx + (towardY - my) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  return { a: { x: ax, y: ay }, b: { x: bx, y: by }, n: { x: nx, y: ny }, kind, pocket };
}

export function buildTable() {
  const dC = CORNER_MOUTH / Math.SQRT2; // jaw point distance from the corner along each rail
  const hS = SIDE_MOUTH / 2;
  const cushions = [];
  const noses = [];
  const pockets = [];

  // Pocket definitions with their two jaw points (each on a cushion line) and facing directions.
  const cornerDefs = [
    { id: 0, sx: -1, sy: 1 },
    { id: 2, sx: 1, sy: 1 },
    { id: 3, sx: 1, sy: -1 },
    { id: 5, sx: -1, sy: -1 },
  ];
  const facingC = (180 - CORNER_FACING_DEG) * DEG; // 38 deg off the cushion line, outward
  const facingS = (180 - SIDE_FACING_DEG) * DEG; // 76 deg off the cushion line, outward
  const facingLenC = CUSHION_DEPTH / Math.sin(facingC);
  const facingLenS = CUSHION_DEPTH / Math.sin(facingS);

  for (const { id, sx, sy } of cornerDefs) {
    const cx = sx * HL;
    const cy = sy * HW;
    // Jaw on the long rail (y = sy*HW) and on the short rail (x = sx*HL).
    const jl = { x: sx * (HL - dC), y: cy };
    const js = { x: cx, y: sy * (HW - dC) };
    const mouthC = { x: (jl.x + js.x) / 2, y: (jl.y + js.y) / 2 };
    // Long-rail facing: heads toward the corner (sx) and outward (sy) at facingC off the rail line.
    const fl = {
      x: jl.x + sx * Math.cos(facingC) * facingLenC,
      y: jl.y + sy * Math.sin(facingC) * facingLenC,
    };
    const fs = {
      x: js.x + sx * Math.sin(facingC) * facingLenC,
      y: js.y + sy * Math.cos(facingC) * facingLenC,
    };
    cushions.push(seg(jl.x, jl.y, fl.x, fl.y, mouthC.x, mouthC.y, 'jaw', id));
    cushions.push(seg(js.x, js.y, fs.x, fs.y, mouthC.x, mouthC.y, 'jaw', id));
    // Nose centres sit just outside the cushion line so the rounded tip is flush with it.
    noses.push({ x: jl.x, y: jl.y + sy * JAW_NOSE_R, r: JAW_NOSE_R, pocket: id });
    noses.push({ x: js.x + sx * JAW_NOSE_R, y: js.y, r: JAW_NOSE_R, pocket: id });
    pockets.push({
      id,
      kind: 'corner',
      x: cx,
      y: cy,
      captureR: CORNER_CAPTURE_R,
      jaws: [jl, js],
      facings: [fl, fs],
      mouth: mouthC,
      // Unit vector pointing from the table into the pocket.
      dir: { x: sx / Math.SQRT2, y: sy / Math.SQRT2 },
    });
  }

  for (const { id, sy } of [
    { id: 1, sy: 1 },
    { id: 4, sy: -1 },
  ]) {
    const y = sy * HW;
    const ja = { x: -hS, y };
    const jb = { x: hS, y };
    const mouthS = { x: 0, y };
    const fa = { x: ja.x + Math.cos(facingS) * facingLenS, y: y + sy * Math.sin(facingS) * facingLenS };
    const fb = { x: jb.x - Math.cos(facingS) * facingLenS, y: y + sy * Math.sin(facingS) * facingLenS };
    const inside = { x: 0, y: y + sy * 0.01 };
    cushions.push(seg(ja.x, ja.y, fa.x, fa.y, inside.x, inside.y, 'jaw', id));
    cushions.push(seg(jb.x, jb.y, fb.x, fb.y, inside.x, inside.y, 'jaw', id));
    noses.push({ x: ja.x, y: ja.y + sy * JAW_NOSE_R, r: JAW_NOSE_R, pocket: id });
    noses.push({ x: jb.x, y: jb.y + sy * JAW_NOSE_R, r: JAW_NOSE_R, pocket: id });
    pockets.push({
      id,
      kind: 'side',
      x: 0,
      y: y + sy * SIDE_CAPTURE_OFFSET,
      captureR: SIDE_CAPTURE_R,
      jaws: [ja, jb],
      facings: [fa, fb],
      mouth: mouthS,
      dir: { x: 0, y: sy },
    });
  }
  pockets.sort((a, b) => a.id - b.id);

  // Rail cushions (nose lines) between the jaws. Normals point into the playing area.
  for (const sy of [1, -1]) {
    const y = sy * HW;
    cushions.push(seg(-(HL - dC), y, -hS, y, 0, 0, 'rail', -1));
    cushions.push(seg(hS, y, HL - dC, y, 0, 0, 'rail', -1));
  }
  for (const sx of [1, -1]) {
    const x = sx * HL;
    cushions.push(seg(x, -(HW - dC), x, HW - dC, 0, 0, 'rail', -1));
  }
  cushions.forEach((c, i) => (c.id = i));

  // Diamonds (sights) on the wooden rail: 3 between each pair of pockets on the long rails,
  // 3 on each short rail. Positions are on the cushion nose lines; render pushes them outward.
  const diamonds = [];
  for (const sy of [1, -1]) {
    for (let k = 1; k <= 7; k++) {
      if (k === 4) continue; // side pocket
      diamonds.push({ x: -HL + (k * 2 * HL) / 8, y: sy * HW, side: sy > 0 ? 'left' : 'right' });
    }
  }
  for (const sx of [1, -1]) {
    for (let k = 1; k <= 3; k++) {
      diamonds.push({ x: sx * HL, y: -HW + (k * 2 * HW) / 4, side: sx > 0 ? 'foot' : 'head' });
    }
  }

  return {
    R: BALL_R,
    HL,
    HW,
    headStringX: HEAD_STRING_X,
    headSpot: HEAD_SPOT,
    footSpot: FOOT_SPOT,
    cushions,
    noses,
    pockets,
    diamonds,
  };
}

// Shared instance; geometry is immutable after construction.
export const TABLE = buildTable();
