// Course themes: the look of each course as plain data (docs/architecture.md section 8.3). Pure
// module; render.js, shaders.js and bake.js consume it. All colours are 0..1 rgb. Sky, sun, fog and
// ambient colours are LINEAR (as the shaders use them); surface and water-bed colours are albedos
// in the same sRGB-ish space as SURFACES[].color (the bake converts them).
//
//   THEMES = {parkland, desert, tropical, links}; themeFor(id) falls back to parkland.
//
// Theme fields
//   id
//   sky        {zenith, horizon, sunColor, sunDir:{x,y,z} (unit, toward the sun), haze}
//              haze: tint the fog colour applies to the sky just above the horizon
//   fog        {color: null (derived from the sky, as shipped) | rgb, density (exp2, 1/m),
//               aerial (how far past ~200 m the haze takes distant terrain, 0..1)}
//   ambient    {sky, ground}: hemisphere ambient from above and from the ground bounce
//   surfaceColors {[SURF.*]: rgb}: overrides SURFACES[].color for every surface
//   water      {deep (the water's own colour seen straight down), shallow (the bed colour at the
//               margins), sea (an ocean: surf line and a sea horizon)}
//   horizon    'hills' | 'mountains' | 'ocean' | 'dunes' | 'mesas'
//   ridges     {far, near}: colours of the two horizon silhouettes before the haze
//   skirt      {near, far}: ground beyond the hole (near the grid edge, far out)
//   tints      {pine, broad, palm, saguaro, shrub, gorse, rock, grass}: object colours
//   stripe     mowing-stripe strength multiplier (links ~0.4: firmer, browner, fewer stripes)
//
// parkland is exactly the shipped Hollow Pines look (the constants of render.js, shaders.js and
// bake.js as of version 1).

import { SURF, SURFACES } from './constants.js';

const DEG = Math.PI / 180;

// Unit vector toward a sun at azimuth az (deg, counter-clockwise from +x) and elevation el (deg).
function sunAt(az, el) {
  return { x: Math.cos(el * DEG) * Math.cos(az * DEG), y: Math.cos(el * DEG) * Math.sin(az * DEG), z: Math.sin(el * DEG) };
}

// Every surface colour from the SURFACES table, with overrides.
function surfaceColors(over = {}) {
  const out = {};
  for (const k of Object.keys(SURFACES)) out[k] = SURFACES[k].color.slice();
  for (const k of Object.keys(over)) out[k] = over[k].slice();
  return out;
}

const PARKLAND = {
  id: 'parkland',
  sky: {
    zenith: [0.07, 0.19, 0.56],
    horizon: [0.46, 0.6, 0.78],
    sunColor: [1.0 * 1.08, 0.95 * 1.08, 0.86 * 1.08],
    sunDir: sunAt(215, 42),
    haze: [0.9, 0.93, 0.95],
  },
  fog: { color: null, density: 1 / 1100, aerial: 0.8 },
  ambient: { sky: [0.2, 0.235, 0.29], ground: [0.07, 0.075, 0.045] },
  surfaceColors: surfaceColors(),
  water: { deep: [0.01, 0.04, 0.045], shallow: [0.36, 0.38, 0.26], sea: false },
  horizon: 'hills',
  ridges: { far: [0.06, 0.1, 0.13], near: [0.025, 0.05, 0.025] },
  skirt: { near: [0.21, 0.37, 0.13], far: [0.12, 0.22, 0.09] },
  tints: {
    pine: [0.11, 0.2, 0.11], broad: [0.19, 0.3, 0.12], palm: [0.2, 0.36, 0.12], saguaro: [0.24, 0.38, 0.18],
    shrub: [0.22, 0.3, 0.12], gorse: [0.2, 0.28, 0.1], rock: [0.42, 0.4, 0.37], grass: [0.45, 0.5, 0.25],
  },
  stripe: 1.0,
};

// Hot, pale sky over terracotta desert; emerald fairways; red mesas on the horizon.
const DESERT = {
  id: 'desert',
  sky: {
    zenith: [0.12, 0.27, 0.6],
    horizon: [0.7, 0.66, 0.6],
    sunColor: [1.18, 1.06, 0.88],
    sunDir: sunAt(225, 52),
    haze: [1.0, 0.95, 0.88],
  },
  fog: { color: null, density: 1 / 1500, aerial: 0.7 },
  ambient: { sky: [0.24, 0.24, 0.27], ground: [0.13, 0.085, 0.05] },
  surfaceColors: surfaceColors({
    [SURF.TEE]: [0.24, 0.56, 0.22],
    [SURF.FAIRWAY]: [0.24, 0.6, 0.24],
    [SURF.ROUGH]: [0.36, 0.46, 0.2],
    [SURF.FRINGE]: [0.26, 0.6, 0.25],
    [SURF.GREEN]: [0.28, 0.66, 0.28],
    [SURF.BUNKER]: [0.93, 0.85, 0.68],
    [SURF.WATER]: [0.14, 0.38, 0.42],
    [SURF.OOB]: [0.6, 0.44, 0.3],
    [SURF.WASTE]: [0.84, 0.7, 0.52],
    [SURF.DESERT]: [0.7, 0.48, 0.32],
    [SURF.FESCUE]: [0.62, 0.55, 0.34],
  }),
  water: { deep: [0.01, 0.05, 0.06], shallow: [0.5, 0.42, 0.3], sea: false },
  horizon: 'mesas',
  ridges: { far: [0.32, 0.16, 0.1], near: [0.42, 0.2, 0.1] },
  skirt: { near: [0.62, 0.44, 0.3], far: [0.55, 0.36, 0.24] },
  tints: {
    pine: [0.12, 0.2, 0.1], broad: [0.22, 0.3, 0.12], palm: [0.22, 0.34, 0.12], saguaro: [0.2, 0.34, 0.16],
    shrub: [0.3, 0.32, 0.16], gorse: [0.28, 0.3, 0.12], rock: [0.5, 0.32, 0.22], grass: [0.6, 0.55, 0.3],
  },
  stripe: 1.0,
};

// Deep blue sky, turquoise water with sandy shallows, white beaches (WASTE), palms, lush greens.
const TROPICAL = {
  id: 'tropical',
  sky: {
    zenith: [0.02, 0.15, 0.62],
    horizon: [0.48, 0.68, 0.86],
    sunColor: [1.12, 1.06, 0.94],
    sunDir: sunAt(200, 55),
    haze: [0.92, 0.96, 0.98],
  },
  fog: { color: null, density: 1 / 1300, aerial: 0.75 },
  ambient: { sky: [0.2, 0.25, 0.32], ground: [0.08, 0.09, 0.05] },
  surfaceColors: surfaceColors({
    [SURF.TEE]: [0.3, 0.64, 0.24],
    [SURF.FAIRWAY]: [0.32, 0.68, 0.24],
    [SURF.ROUGH]: [0.22, 0.5, 0.16],
    [SURF.FRINGE]: [0.32, 0.68, 0.26],
    [SURF.GREEN]: [0.34, 0.74, 0.3],
    [SURF.BUNKER]: [0.95, 0.92, 0.82],
    [SURF.WATER]: [0.08, 0.5, 0.55],
    [SURF.WASTE]: [0.94, 0.9, 0.78],
  }),
  water: { deep: [0.0, 0.1, 0.13], shallow: [0.5, 0.78, 0.7], sea: true },
  horizon: 'ocean',
  ridges: { far: [0.08, 0.14, 0.16], near: [0.03, 0.08, 0.04] },
  skirt: { near: [0.2, 0.42, 0.14], far: [0.1, 0.26, 0.08] },
  tints: {
    pine: [0.1, 0.22, 0.1], broad: [0.16, 0.34, 0.1], palm: [0.2, 0.4, 0.1], saguaro: [0.2, 0.34, 0.16],
    shrub: [0.18, 0.34, 0.1], gorse: [0.2, 0.3, 0.1], rock: [0.45, 0.43, 0.4], grass: [0.5, 0.56, 0.28],
  },
  stripe: 1.0,
};

// Grey-blue overcast, a sea horizon, tawny fescue, firm yellow-green fairways, almost no trees.
const LINKS = {
  id: 'links',
  sky: {
    zenith: [0.22, 0.3, 0.42],
    horizon: [0.62, 0.66, 0.7],
    sunColor: [0.82, 0.82, 0.8],
    sunDir: sunAt(200, 30),
    haze: [0.92, 0.94, 0.96],
  },
  fog: { color: null, density: 1 / 850, aerial: 0.85 },
  ambient: { sky: [0.28, 0.3, 0.34], ground: [0.1, 0.1, 0.07] },
  surfaceColors: surfaceColors({
    [SURF.TEE]: [0.44, 0.58, 0.26],
    [SURF.FAIRWAY]: [0.48, 0.6, 0.26],
    [SURF.ROUGH]: [0.44, 0.5, 0.25],
    [SURF.FRINGE]: [0.42, 0.6, 0.27],
    [SURF.GREEN]: [0.4, 0.62, 0.28],
    [SURF.BUNKER]: [0.8, 0.72, 0.55],
    [SURF.WATER]: [0.16, 0.3, 0.36],
    [SURF.OOB]: [0.6, 0.55, 0.34],
    [SURF.WASTE]: [0.78, 0.72, 0.56],
    [SURF.FESCUE]: [0.7, 0.62, 0.38],
  }),
  water: { deep: [0.02, 0.05, 0.07], shallow: [0.42, 0.46, 0.4], sea: true },
  horizon: 'ocean',
  ridges: { far: [0.2, 0.24, 0.28], near: [0.3, 0.32, 0.22] },
  skirt: { near: [0.6, 0.55, 0.33], far: [0.5, 0.48, 0.3] },
  tints: {
    pine: [0.1, 0.18, 0.1], broad: [0.18, 0.26, 0.12], palm: [0.2, 0.32, 0.12], saguaro: [0.2, 0.32, 0.16],
    shrub: [0.2, 0.26, 0.1], gorse: [0.22, 0.3, 0.1], rock: [0.45, 0.45, 0.43], grass: [0.68, 0.62, 0.38],
  },
  stripe: 0.4,
};

export const THEMES = { parkland: PARKLAND, desert: DESERT, tropical: TROPICAL, links: LINKS };

export function themeFor(id) {
  return THEMES[id] || PARKLAND;
}
