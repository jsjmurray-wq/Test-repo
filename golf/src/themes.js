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
//   clouds     {cover, shift, grey}: cumulus density = clamp(density * cover + shift); grey turns
//              the cloud deck into an overcast (0 = sunlit white cumulus)
//   fog        {color: null (derived from the sky, as shipped) | rgb, density (exp2, 1/m),
//               aerial (how far past ~200 m the haze takes distant terrain, 0..1), highClear (the
//               aerial haze thins for high cameras as the fog does; off in the shipped look)}
//   ambient    {sky, ground}: hemisphere ambient from above and from the ground bounce
//   surfaceColors {[SURF.*]: rgb}: overrides SURFACES[].color for every surface
//   revet      sod colour of revetted pot-bunker faces (stacked turf walls)
//   detail     {rake, pebbles, sheen}: strengths of the shader's ground detail (waste-area rake
//              lines, desert pebbles and scrub, fescue wind sheen)
//   water      {deep (the water's own colour seen straight down, linear), shallow (the bed colour
//               at the margins), sea (an ocean: surf line and a sea horizon), tint (sRGB colour
//               of sunlit shallow water: turquoise over sand; null keeps the shipped dark pond),
//               clarity (m: depth at which the water turns 63% to deep), haze (max haze on the sea
//               so the horizon line stays crisp), rough (sea swell: least cosine of the view to
//               the water, so it never mirrors the sky at grazing angles)}
//   horizon    'hills' | 'mountains' | 'ocean' | 'dunes' | 'mesas'
//   land       silhouette on the landward side of an 'ocean' horizon ('hills' | 'dunes' | ...)
//   seaAz      sea direction for holes without sea water of their own (deg, relative to the hole
//              line: 0 = beyond the green, 90 = left, -90 = right), per hole number n % length
//   seaHalf    half-angle of the sea sector (deg)
//   ridges     {far, near}: colours of the two horizon silhouettes before the haze
//   skirt      {near, far, detail:[desert, waste, fescue, 0], scale, blend}: ground beyond the hole
//              (near the grid edge, far out), the ground detail it gets, the size (m) of its broad
//              colour variation (97 shipped; larger never aliases into a checker from high up) and
//              blend (it starts as the grid edge's own colour, so the hole has no visible border)
//   skirtObjects null (the shipped pine/broad tree line) | {kinds:{kind: weight}, perVertex, grass}
//              objects on the first skirt band (per 8 m of perimeter) and dune-grass tufts
//   tints      {pine, broad, palm, saguaro, shrub, gorse, rock, grass}: object colours
//   trunks     {palm, saguaro}: second colours (palm trunk, saguaro rib shadows)
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
  clouds: { cover: 1, shift: 0, grey: 0 },
  fog: { color: null, density: 1 / 1100, aerial: 0.8 },
  ambient: { sky: [0.2, 0.235, 0.29], ground: [0.07, 0.075, 0.045] },
  surfaceColors: surfaceColors(),
  revet: [0.2, 0.26, 0.12],
  detail: { rake: 1, pebbles: 1, sheen: 1 },
  water: { deep: [0.01, 0.04, 0.045], shallow: [0.36, 0.38, 0.26], sea: false, tint: null, clarity: 2, haze: 1, rough: 0.12 },
  horizon: 'hills',
  land: 'hills',
  seaAz: [0],
  seaHalf: 70,
  ridges: { far: [0.06, 0.1, 0.13], near: [0.025, 0.05, 0.025] },
  skirt: { near: [0.21, 0.37, 0.13], far: [0.12, 0.22, 0.09], detail: [0, 0, 0, 0] },
  skirtObjects: null,
  tints: {
    pine: [0.11, 0.2, 0.11], broad: [0.19, 0.3, 0.12], palm: [0.2, 0.36, 0.12], saguaro: [0.24, 0.38, 0.18],
    shrub: [0.22, 0.3, 0.12], gorse: [0.2, 0.28, 0.1], rock: [0.42, 0.4, 0.37], grass: [0.45, 0.5, 0.25],
  },
  trunks: { palm: [0.45, 0.4, 0.33], saguaro: [0.16, 0.26, 0.12] },
  stripe: 1.0,
};

// Arizona target golf: hot, pale sky over terracotta desert; emerald fairways; red mesas and far
// blue ranges on the horizon; saguaros, creosote and boulders.
const DESERT = {
  id: 'desert',
  sky: {
    zenith: [0.03, 0.15, 0.6],
    horizon: [0.5, 0.62, 0.76],
    sunColor: [1.2, 1.08, 0.9],
    sunDir: sunAt(225, 50),
    haze: [0.98, 0.95, 0.9],
  },
  clouds: { cover: 0.65, shift: -0.14, grey: 0 },
  fog: { color: null, density: 1 / 1800, aerial: 0.5, highClear: true },
  ambient: { sky: [0.22, 0.24, 0.3], ground: [0.13, 0.09, 0.06] },
  surfaceColors: surfaceColors({
    // (Watered turf in the desert: a deep, slightly olive green, not neon; the green a cooler,
    // bluer green of its own so it stands out from the fairway.)
    [SURF.TEE]: [0.27, 0.5, 0.2],
    [SURF.FAIRWAY]: [0.28, 0.52, 0.19],
    [SURF.ROUGH]: [0.36, 0.45, 0.21],
    [SURF.FRINGE]: [0.26, 0.52, 0.23],
    [SURF.GREEN]: [0.22, 0.56, 0.3],
    [SURF.BUNKER]: [0.93, 0.87, 0.72],
    [SURF.WATER]: [0.14, 0.38, 0.42],
    [SURF.OOB]: [0.64, 0.52, 0.41],
    [SURF.WASTE]: [0.78, 0.69, 0.55],
    [SURF.DESERT]: [0.65, 0.52, 0.41],
    [SURF.FESCUE]: [0.62, 0.55, 0.34],
  }),
  revet: [0.2, 0.26, 0.12],
  detail: { rake: 1, pebbles: 1, sheen: 0.6 },
  water: { deep: [0.0, 0.05, 0.07], shallow: [0.62, 0.52, 0.38], sea: false, tint: [0.2, 0.55, 0.5], clarity: 1.6, haze: 1, rough: 0.12 },
  horizon: 'mesas',
  land: 'mesas',
  seaAz: [0],
  seaHalf: 70,
  ridges: { far: [0.24, 0.22, 0.38], near: [0.46, 0.13, 0.035] }, // (warm red-orange rock, lightly hazed: render.js RIDGE_HAZE)
  skirt: { near: [0.63, 0.5, 0.4], far: [0.6, 0.47, 0.38], detail: [1, 0, 0, 0], scale: 700, blend: true },
  skirtObjects: { kinds: { saguaro: 0.3, shrub: 0.55, rock: 0.15 }, perVertex: 0.8, grass: 0 },
  tints: {
    pine: [0.12, 0.2, 0.1], broad: [0.22, 0.3, 0.12], palm: [0.22, 0.34, 0.12], saguaro: [0.34, 0.43, 0.27],
    shrub: [0.32, 0.36, 0.17], gorse: [0.28, 0.3, 0.12], rock: [0.56, 0.36, 0.25], grass: [0.6, 0.55, 0.3],
  },
  trunks: { palm: [0.45, 0.4, 0.33], saguaro: [0.17, 0.23, 0.13] },
  stripe: 1.0,
};

// Island and lagoon resort: deep blue sky with fair-weather cumulus, turquoise shallows over white
// sand fading to deep blue, surf on the beaches, palms, lush green turf, an ocean horizon.
const TROPICAL = {
  id: 'tropical',
  sky: {
    zenith: [0.01, 0.11, 0.6],
    horizon: [0.42, 0.64, 0.88],
    sunColor: [1.14, 1.08, 0.96],
    sunDir: sunAt(200, 55),
    haze: [0.92, 0.96, 0.98],
  },
  clouds: { cover: 1.3, shift: -0.06, grey: 0 },
  fog: { color: null, density: 1 / 1500, aerial: 0.62, highClear: true },
  ambient: { sky: [0.2, 0.25, 0.32], ground: [0.08, 0.09, 0.05] },
  surfaceColors: surfaceColors({
    [SURF.TEE]: [0.3, 0.64, 0.24],
    [SURF.FAIRWAY]: [0.32, 0.68, 0.24],
    [SURF.ROUGH]: [0.22, 0.5, 0.16],
    [SURF.FRINGE]: [0.32, 0.68, 0.26],
    [SURF.GREEN]: [0.34, 0.74, 0.3],
    [SURF.BUNKER]: [0.96, 0.93, 0.84],
    [SURF.WATER]: [0.08, 0.5, 0.55],
    [SURF.WASTE]: [0.95, 0.91, 0.8],
  }),
  revet: [0.2, 0.28, 0.12],
  detail: { rake: 0.5, pebbles: 0.3, sheen: 0.6 },
  water: { deep: [0.0, 0.035, 0.17], shallow: [0.86, 0.84, 0.72], sea: true, tint: [0.2, 0.8, 0.78], clarity: 2.2, haze: 0.35, rough: 0.12 },
  horizon: 'ocean',
  land: 'hills',
  seaAz: [0, 90, -90],
  seaHalf: 75,
  ridges: { far: [0.08, 0.15, 0.17], near: [0.03, 0.08, 0.04] },
  skirt: { near: [0.2, 0.42, 0.14], far: [0.1, 0.26, 0.08], detail: [0, 0, 0, 0], scale: 700, blend: true },
  skirtObjects: { kinds: { palm: 0.65, broad: 0.35 }, perVertex: 1.2, grass: 0 },
  tints: {
    pine: [0.1, 0.22, 0.1], broad: [0.16, 0.34, 0.1], palm: [0.3, 0.5, 0.13], saguaro: [0.2, 0.34, 0.16],
    shrub: [0.18, 0.34, 0.1], gorse: [0.2, 0.3, 0.1], rock: [0.45, 0.43, 0.4], grass: [0.5, 0.56, 0.28],
  },
  trunks: { palm: [0.72, 0.66, 0.56], saguaro: [0.13, 0.2, 0.1] },
  stripe: 1.0,
};

// Scottish seaside links: grey-blue overcast, a sea horizon, tawny fescue and marram on rumpled
// dunes, firm yellow-green fairways with faint stripes, revetted pot bunkers, gorse, no trees.
const LINKS = {
  id: 'links',
  sky: {
    zenith: [0.15, 0.23, 0.38],
    horizon: [0.48, 0.55, 0.63],
    sunColor: [0.9, 0.88, 0.82],
    sunDir: sunAt(200, 32),
    haze: [0.92, 0.94, 0.96],
  },
  clouds: { cover: 1.1, shift: -0.02, grey: 0.5 },
  fog: { color: null, density: 1 / 1200, aerial: 0.75, highClear: true },
  ambient: { sky: [0.3, 0.32, 0.36], ground: [0.1, 0.1, 0.07] },
  surfaceColors: surfaceColors({
    [SURF.TEE]: [0.44, 0.58, 0.26],
    [SURF.FAIRWAY]: [0.5, 0.62, 0.27],
    [SURF.ROUGH]: [0.44, 0.52, 0.26],
    [SURF.FRINGE]: [0.44, 0.61, 0.27],
    [SURF.GREEN]: [0.42, 0.63, 0.28],
    [SURF.BUNKER]: [0.8, 0.72, 0.55],
    [SURF.WATER]: [0.16, 0.3, 0.36],
    [SURF.OOB]: [0.6, 0.55, 0.34],
    [SURF.WASTE]: [0.78, 0.72, 0.56],
    [SURF.FESCUE]: [0.7, 0.62, 0.38],
  }),
  revet: [0.3, 0.34, 0.17], // (lit stacked turf: the darker 0.17/0.22/0.1 read as a black pit)
  detail: { rake: 0.4, pebbles: 0.5, sheen: 1 },
  water: { deep: [0.01, 0.035, 0.05], shallow: [0.62, 0.58, 0.46], sea: true, tint: [0.22, 0.36, 0.38], clarity: 1.5, haze: 0.45, rough: 0.3 },
  horizon: 'ocean',
  land: 'dunes',
  seaAz: [90, 0, -90],
  seaHalf: 55,
  ridges: { far: [0.2, 0.24, 0.28], near: [0.3, 0.31, 0.22] },
  skirt: { near: [0.64, 0.58, 0.36], far: [0.58, 0.55, 0.35], detail: [0, 0, 1, 0], scale: 700, blend: true },
  skirtObjects: { kinds: { gorse: 1 }, perVertex: 0.35, grass: 3 },
  tints: {
    pine: [0.1, 0.18, 0.1], broad: [0.18, 0.26, 0.12], palm: [0.2, 0.32, 0.12], saguaro: [0.2, 0.32, 0.16],
    shrub: [0.2, 0.26, 0.1], gorse: [0.26, 0.36, 0.12], rock: [0.45, 0.45, 0.43], grass: [0.78, 0.7, 0.46],
  },
  trunks: { palm: [0.45, 0.4, 0.33], saguaro: [0.13, 0.2, 0.1] },
  stripe: 0.4,
};

export const THEMES = { parkland: PARKLAND, desert: DESERT, tropical: TROPICAL, links: LINKS };

export function themeFor(id) {
  return THEMES[id] || PARKLAND;
}
