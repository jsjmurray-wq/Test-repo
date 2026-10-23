// Layout mode selection and the world <-> screen transform.
//
// Landscape / square: the table is horizontal, head (break) end on the LEFT.
//   sx = ox + x * scale,  sy = oy - y * scale
// Portrait: the table is rotated to run vertically, head (break) end at the BOTTOM.
//   sx = ox - y * scale,  sy = oy - x * scale
// Both are proper rotations of each other (no mirroring). Screen units are CSS pixels.

import { HL, HW, CUSHION_DEPTH, RAIL_WIDTH } from './constants.js';

export const EXTENT_X = HL + CUSHION_DEPTH + RAIL_WIDTH; // half extent of the whole table incl. rails
export const EXTENT_Y = HW + CUSHION_DEPTH + RAIL_WIDTH;

// 'landscape' (wide phone), 'square' (unfolded foldable / iPad), 'portrait' (tall phone).
export function layoutMode(w, h) {
  const a = w / Math.max(1, h);
  if (a >= 1.25) return 'landscape';
  if (a <= 0.8) return 'portrait';
  return 'square';
}

// Build the view for a table container of cssW x cssH CSS pixels.
export function computeView(cssW, cssH, margin = 4) {
  const rotated = cssH > cssW;
  const w = Math.max(1, cssW - 2 * margin);
  const h = Math.max(1, cssH - 2 * margin);
  const scale = rotated
    ? Math.min(w / (2 * EXTENT_Y), h / (2 * EXTENT_X))
    : Math.min(w / (2 * EXTENT_X), h / (2 * EXTENT_Y));
  const ox = cssW / 2;
  const oy = cssH / 2;
  const toScreen = rotated
    ? (x, y) => ({ x: ox - y * scale, y: oy - x * scale })
    : (x, y) => ({ x: ox + x * scale, y: oy - y * scale });
  const toWorld = rotated
    ? (sx, sy) => ({ x: (oy - sy) / scale, y: (ox - sx) / scale })
    : (sx, sy) => ({ x: (sx - ox) / scale, y: (oy - sy) / scale });
  // Screen-space angle of a world direction angle (radians), and back.
  const angleToScreen = rotated ? (a) => Math.atan2(-Math.cos(a), -Math.sin(a)) : (a) => -a;
  const angleToWorld = rotated ? (s) => Math.atan2(-Math.cos(s), -Math.sin(s)) : (s) => -s;
  return { cssW, cssH, rotated, scale, ox, oy, toScreen, toWorld, angleToScreen, angleToWorld };
}
