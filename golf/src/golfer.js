// The golfer character: skeleton, body proportions, the customisable LOOK and the club specs the
// mesh (golfer-mesh.js) and the swing animation (swing-anim.js) share. Pure module (no DOM).
//
// Golfer frame "G" (the space poses are built in, docs/architecture.md section 9): +X forward
// (from the golfer toward the ball line), +Y toward the target (the golfer's LEFT for a
// right-hander), +Z up, origin on the ground at the centre of the stance. A right-hander faces
// right(d) = d x z for an aim direction d and stands on the LEFT of the ball looking down the
// target line from behind. Left-handers are the mirror image (G's Y flipped), so bone names are
// lead/trail by their right-handed side: 'L' = lead side, 'R' = trail side.
//
// Rest pose ("bind" space = G at rest): standing upright, arms hanging straight down, legs
// straight, every bone's rest orientation the identity. Limb segments lie exactly along -Z at rest
// (shoulder/elbow/wrist share x, y; so do hip/knee/ankle), so a bone's local -Z axis is its
// segment direction and its local +X is the way the joint below it bends (elbow: forearm forward;
// knee: the knee points forward).
//
// Exports
//   BONES, BONE_COUNT, B (name -> index), BONE_PARENT
//   SKIN_TONES, HAIR_COLORS, CLOTH_COLORS (palettes: {id, name, hex}), OPTIONS (every look option),
//   OPTION_NAMES (display names)
//   DEFAULT_LOOK, normalizeLook(any), PRESETS, presetById(id), randomLook(rng), lookKey(look)
//   hexToRgb(hex) -> [r,g,b] 0..1 (sRGB)
//   CLUB_SPECS, clubSpec(club | id | kind, heightM) -> {id, kind, head, len, lie, loft, ...}
//   bodyDims(look) -> proportions, rest joints (Float64Array BONE_COUNT*3), segment lengths and
//                     the grip frames (hand bone poses in club space)

import { clubById } from './clubs.js';

export const BONES = [
  'pelvis', 'spine', 'chest', 'neck', 'head',
  'clavL', 'upperArmL', 'forearmL', 'handL',
  'clavR', 'upperArmR', 'forearmR', 'handR',
  'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR',
  'club',
];
export const BONE_COUNT = BONES.length; // 20 (the shader's uniform array; <= 24 for WebGL1)
export const B = Object.freeze(Object.fromEntries(BONES.map((n, i) => [n, i])));
// Parent of each bone (-1 = root). The club hangs from the lead hand; the trail hand grips the
// club below it (solved each frame by IK in swing-anim.js).
export const BONE_PARENT = [-1, 0, 1, 2, 3, 2, 5, 6, 7, 2, 9, 10, 11, 0, 13, 14, 0, 16, 17, 8];

// ------------------------------------------------------------------ palettes (sRGB hex)
export const SKIN_TONES = [
  { id: 'fair', name: 'Fair', hex: '#f3d3bf' },
  { id: 'light', name: 'Light', hex: '#e8bf9f' },
  { id: 'lightmed', name: 'Light medium', hex: '#d8a581' },
  { id: 'medium', name: 'Medium', hex: '#c58c64' },
  { id: 'tan', name: 'Tan', hex: '#a9724c' },
  { id: 'brown', name: 'Brown', hex: '#8b5a3a' },
  { id: 'dark', name: 'Dark', hex: '#6a4129' },
  { id: 'deep', name: 'Deep', hex: '#4b2d1c' },
];

export const HAIR_COLORS = [
  { id: 'black', name: 'Black', hex: '#1d1a18' },
  { id: 'darkbrown', name: 'Dark brown', hex: '#3a281d' },
  { id: 'brown', name: 'Brown', hex: '#5d3f2b' },
  { id: 'lightbrown', name: 'Light brown', hex: '#8a643f' },
  { id: 'blonde', name: 'Blonde', hex: '#c9a265' },
  { id: 'platinum', name: 'Platinum', hex: '#e2d4b2' },
  { id: 'auburn', name: 'Auburn', hex: '#7e351c' },
  { id: 'ginger', name: 'Ginger', hex: '#b2602b' },
  { id: 'grey', name: 'Grey', hex: '#99958f' },
  { id: 'white', name: 'White', hex: '#dddad3' },
];

export const CLOTH_COLORS = [
  { id: 'white', name: 'White', hex: '#f2f2ee' },
  { id: 'black', name: 'Black', hex: '#1e1f23' },
  { id: 'navy', name: 'Navy', hex: '#1f2d52' },
  { id: 'royal', name: 'Royal blue', hex: '#2a57bd' },
  { id: 'sky', name: 'Sky blue', hex: '#8dbfe6' },
  { id: 'red', name: 'Red', hex: '#b51f2b' },
  { id: 'burgundy', name: 'Burgundy', hex: '#6a1e2d' },
  { id: 'pink', name: 'Pink', hex: '#e68aa4' },
  { id: 'coral', name: 'Coral', hex: '#ec7a61' },
  { id: 'orange', name: 'Orange', hex: '#e5802e' },
  { id: 'yellow', name: 'Yellow', hex: '#f0cd3c' },
  { id: 'lime', name: 'Lime', hex: '#a6cd44' },
  { id: 'green', name: 'Green', hex: '#2e7b3d' },
  { id: 'teal', name: 'Teal', hex: '#1e8888' },
  { id: 'lavender', name: 'Lavender', hex: '#a798d4' },
  { id: 'khaki', name: 'Khaki', hex: '#c5b088' },
  { id: 'tan', name: 'Tan', hex: '#ad8d61' },
  { id: 'brown', name: 'Brown', hex: '#6a492f' },
  { id: 'grey', name: 'Grey', hex: '#898c90' },
  { id: 'charcoal', name: 'Charcoal', hex: '#3c3f45' },
];

// Every option of the look, in menu order (the customiser shows these).
export const OPTIONS = Object.freeze({
  body: ['male', 'female'],
  build: ['slim', 'regular', 'athletic', 'heavy'],
  hair: ['short', 'buzz', 'sidepart', 'curly', 'long', 'ponytail', 'bald'],
  facialHair: ['none', 'stubble', 'moustache', 'beard'],
  headwear: ['none', 'cap', 'visor', 'bucket', 'flatcap'],
  shirt: ['polo', 'striped', 'vest'],
  legwear: ['trousers', 'shorts'],
  swing: ['classic', 'compact', 'bigfinish', 'smooth'],
  height: [155, 200],
});

export const OPTION_NAMES = Object.freeze({
  body: { male: 'Male', female: 'Female' },
  build: { slim: 'Slim', regular: 'Regular', athletic: 'Athletic', heavy: 'Heavy' },
  hair: { short: 'Short', buzz: 'Buzz cut', sidepart: 'Side part', curly: 'Curly', long: 'Long', ponytail: 'Ponytail', bald: 'Bald' },
  facialHair: { none: 'None', stubble: 'Stubble', moustache: 'Moustache', beard: 'Beard' },
  headwear: { none: 'None', cap: 'Cap', visor: 'Visor', bucket: 'Bucket hat', flatcap: 'Flat cap' },
  shirt: { polo: 'Polo', striped: 'Striped polo', vest: 'Sweater vest' },
  legwear: { trousers: 'Trousers', shorts: 'Shorts' },
  swing: { classic: 'Classic', compact: 'Compact', bigfinish: 'Big finish', smooth: 'Smooth' },
});

export const DEFAULT_LOOK = Object.freeze({
  body: 'male',
  skin: 2,
  height: 180,
  build: 'regular',
  hair: 'short',
  hairColor: '#3a281d',
  facialHair: 'none',
  sunglasses: false,
  headwear: 'cap',
  hatColor: '#f2f2ee',
  shirt: 'polo',
  shirtColor: '#1f2d52',
  shirtColor2: '#f2f2ee',
  legwear: 'trousers',
  legColor: '#3c3f45',
  shoeColor: '#f2f2ee',
  gloveColor: '#f2f2ee',
  swing: 'classic',
});

const HEX_RE = /^#[0-9a-f]{6}$/i;
const ALL_COLORS = [...SKIN_TONES, ...HAIR_COLORS, ...CLOTH_COLORS];

// A colour value: '#rrggbb', a palette id ('navy', 'blonde'), or anything else -> fallback.
function normColor(v, palette, fallback) {
  if (typeof v === 'string') {
    if (HEX_RE.test(v)) return v.toLowerCase();
    const p = palette.find((c) => c.id === v) || ALL_COLORS.find((c) => c.id === v);
    if (p) return p.hex;
  }
  return fallback;
}

function normEnum(v, list, fallback) {
  return typeof v === 'string' && list.includes(v) ? v : fallback;
}

// Any value (a saved look, a partial look, garbage) -> a complete, valid look. Unknown keys are
// dropped; every field falls back to the default (female figures default to 168 cm).
export function normalizeLook(any) {
  const src = any && typeof any === 'object' && !Array.isArray(any) ? any : {};
  const D = DEFAULT_LOOK;
  const body = normEnum(src.body, OPTIONS.body, D.body);
  let skin = src.skin;
  if (typeof skin === 'string') {
    const k = SKIN_TONES.findIndex((s) => s.id === skin);
    skin = k >= 0 ? k : Number(skin);
  }
  skin = Number.isFinite(skin) ? Math.min(SKIN_TONES.length - 1, Math.max(0, Math.round(skin))) : D.skin;
  let height = Number(src.height);
  if (!Number.isFinite(height)) height = body === 'female' ? 168 : D.height;
  height = Math.min(OPTIONS.height[1], Math.max(OPTIONS.height[0], Math.round(height)));
  return {
    body,
    skin,
    height,
    build: normEnum(src.build, OPTIONS.build, D.build),
    hair: normEnum(src.hair, OPTIONS.hair, D.hair),
    hairColor: normColor(src.hairColor, HAIR_COLORS, D.hairColor),
    facialHair: body === 'female' ? 'none' : normEnum(src.facialHair, OPTIONS.facialHair, D.facialHair),
    sunglasses: src.sunglasses === true || src.sunglasses === 1 || src.sunglasses === 'true',
    headwear: normEnum(src.headwear, OPTIONS.headwear, D.headwear),
    hatColor: normColor(src.hatColor, CLOTH_COLORS, D.hatColor),
    shirt: normEnum(src.shirt, OPTIONS.shirt, D.shirt),
    shirtColor: normColor(src.shirtColor, CLOTH_COLORS, D.shirtColor),
    shirtColor2: normColor(src.shirtColor2, CLOTH_COLORS, D.shirtColor2),
    legwear: normEnum(src.legwear, OPTIONS.legwear, D.legwear),
    legColor: normColor(src.legColor, CLOTH_COLORS, D.legColor),
    shoeColor: normColor(src.shoeColor, CLOTH_COLORS, D.shoeColor),
    gloveColor: normColor(src.gloveColor, CLOTH_COLORS, D.gloveColor),
    swing: normEnum(src.swing, OPTIONS.swing, D.swing),
  };
}

// Stable string for caching meshes per look.
export function lookKey(look) {
  const L = normalizeLook(look);
  return OPTIONS_KEYS.map((k) => L[k]).join('|');
}
const OPTIONS_KEYS = Object.keys(DEFAULT_LOOK);

const C = (id) => CLOTH_COLORS.find((c) => c.id === id).hex;
const HC = (id) => HAIR_COLORS.find((c) => c.id === id).hex;

// Ready-made golfers (the customiser's starting points).
export const PRESETS = [
  {
    id: 'tour', name: 'Tour Pro',
    look: { body: 'male', skin: 2, height: 183, build: 'athletic', hair: 'short', hairColor: HC('darkbrown'), facialHair: 'none',
      sunglasses: false, headwear: 'cap', hatColor: C('white'), shirt: 'polo', shirtColor: C('navy'), shirtColor2: C('white'),
      legwear: 'trousers', legColor: C('grey'), shoeColor: C('white'), gloveColor: C('white'), swing: 'classic' },
  },
  {
    id: 'ladypro', name: 'Lady Pro',
    look: { body: 'female', skin: 1, height: 170, build: 'athletic', hair: 'ponytail', hairColor: HC('blonde'), facialHair: 'none',
      sunglasses: true, headwear: 'visor', hatColor: C('white'), shirt: 'polo', shirtColor: C('coral'), shirtColor2: C('white'),
      legwear: 'shorts', legColor: C('white'), shoeColor: C('white'), gloveColor: C('white'), swing: 'smooth' },
  },
  {
    id: 'power', name: 'Power Hitter',
    look: { body: 'male', skin: 6, height: 193, build: 'athletic', hair: 'buzz', hairColor: HC('black'), facialHair: 'beard',
      sunglasses: false, headwear: 'none', hatColor: C('black'), shirt: 'polo', shirtColor: C('black'), shirtColor2: C('white'),
      legwear: 'trousers', legColor: C('white'), shoeColor: C('black'), gloveColor: C('white'), swing: 'bigfinish' },
  },
  {
    id: 'gent', name: 'Classic Gent',
    look: { body: 'male', skin: 0, height: 177, build: 'regular', hair: 'sidepart', hairColor: HC('grey'), facialHair: 'moustache',
      sunglasses: false, headwear: 'flatcap', hatColor: C('tan'), shirt: 'vest', shirtColor: C('burgundy'), shirtColor2: C('white'),
      legwear: 'trousers', legColor: C('khaki'), shoeColor: C('brown'), gloveColor: C('white'), swing: 'smooth' },
  },
  {
    id: 'weekend', name: 'Weekend Warrior',
    look: { body: 'male', skin: 4, height: 175, build: 'heavy', hair: 'bald', hairColor: HC('brown'), facialHair: 'stubble',
      sunglasses: true, headwear: 'bucket', hatColor: C('khaki'), shirt: 'striped', shirtColor: C('green'), shirtColor2: C('white'),
      legwear: 'shorts', legColor: C('navy'), shoeColor: C('white'), gloveColor: C('white'), swing: 'compact' },
  },
  {
    id: 'rising', name: 'Rising Star',
    look: { body: 'female', skin: 5, height: 164, build: 'slim', hair: 'long', hairColor: HC('black'), facialHair: 'none',
      sunglasses: false, headwear: 'none', hatColor: C('white'), shirt: 'polo', shirtColor: C('teal'), shirtColor2: C('white'),
      legwear: 'trousers', legColor: C('navy'), shoeColor: C('white'), gloveColor: C('white'), swing: 'compact' },
  },
  {
    id: 'links', name: 'Links Veteran',
    look: { body: 'male', skin: 1, height: 172, build: 'regular', hair: 'curly', hairColor: HC('ginger'), facialHair: 'beard',
      sunglasses: false, headwear: 'none', hatColor: C('charcoal'), shirt: 'vest', shirtColor: C('navy'), shirtColor2: C('sky'),
      legwear: 'trousers', legColor: C('charcoal'), shoeColor: C('brown'), gloveColor: C('white'), swing: 'smooth' },
  },
  {
    id: 'collegiate', name: 'Collegiate',
    look: { body: 'female', skin: 7, height: 176, build: 'athletic', hair: 'curly', hairColor: HC('black'), facialHair: 'none',
      sunglasses: false, headwear: 'cap', hatColor: C('navy'), shirt: 'striped', shirtColor: C('white'), shirtColor2: C('navy'),
      legwear: 'shorts', legColor: C('khaki'), shoeColor: C('white'), gloveColor: C('white'), swing: 'classic' },
  },
].map((p) => ({ ...p, look: Object.freeze(normalizeLook(p.look)) }));

export function presetById(id) {
  return PRESETS.find((p) => p.id === id) || null;
}

const pick = (rng, list) => list[Math.min(list.length - 1, Math.floor(rng() * list.length))];

// A random, tasteful look (colour pairs come from short lists that go together).
export function randomLook(rng = Math.random) {
  const body = rng() < 0.5 ? 'male' : 'female';
  const fem = body === 'female';
  const shirtColor = pick(rng, CLOTH_COLORS).hex;
  const darkLegs = ['navy', 'charcoal', 'grey', 'black', 'khaki', 'tan', 'white'];
  const hair = fem ? pick(rng, ['ponytail', 'long', 'short', 'curly', 'sidepart']) : pick(rng, ['short', 'buzz', 'sidepart', 'curly', 'bald', 'short']);
  const older = rng() < 0.2;
  return normalizeLook({
    body,
    skin: Math.floor(rng() * SKIN_TONES.length),
    height: Math.round(fem ? 158 + rng() * 22 : 168 + rng() * 26),
    build: pick(rng, ['slim', 'regular', 'regular', 'athletic', 'athletic', 'heavy']),
    hair,
    hairColor: older ? pick(rng, ['#99958f', '#dddad3']) : pick(rng, HAIR_COLORS.slice(0, 8)).hex,
    facialHair: fem ? 'none' : pick(rng, ['none', 'none', 'stubble', 'moustache', 'beard']),
    sunglasses: rng() < 0.3,
    headwear: pick(rng, fem ? ['none', 'visor', 'cap', 'none', 'bucket'] : ['cap', 'cap', 'none', 'visor', 'bucket', 'flatcap']),
    hatColor: pick(rng, ['white', 'navy', 'black', 'khaki', 'grey', 'red']),
    shirt: pick(rng, ['polo', 'polo', 'striped', 'vest']),
    shirtColor,
    shirtColor2: pick(rng, ['white', 'navy', 'grey', 'sky', 'black']),
    legwear: rng() < (fem ? 0.5 : 0.3) ? 'shorts' : 'trousers',
    legColor: pick(rng, darkLegs),
    shoeColor: pick(rng, ['white', 'white', 'black', 'brown', 'grey']),
    gloveColor: pick(rng, ['white', 'white', 'white', 'black', 'navy']),
    swing: pick(rng, OPTIONS.swing),
  });
}

export function hexToRgb(hex) {
  const h = HEX_RE.test(hex) ? hex : '#808080';
  return [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
}

// ------------------------------------------------------------------ clubs
// Standard (men's steel/graphite) lengths in metres and address lie angles (deg, the shaft's
// angle above the ground with the sole flat); `head` picks the mesh. Lengths are fitted to the
// golfer: +/- 3% per 10% of height from 1.78 m (a tall player plays longer clubs).
export const CLUB_SPECS = {
  D: { len: 1.143, lie: 56, head: 'driver' },
  '3W': { len: 1.092, lie: 57, head: 'wood' },
  '5W': { len: 1.067, lie: 58, head: 'wood' },
  '4H': { len: 1.016, lie: 59.5, head: 'hybrid' },
  '5i': { len: 0.965, lie: 61, head: 'iron' },
  '6i': { len: 0.953, lie: 61.5, head: 'iron' },
  '7i': { len: 0.94, lie: 62, head: 'iron' },
  '8i': { len: 0.927, lie: 62.5, head: 'iron' },
  '9i': { len: 0.914, lie: 63, head: 'iron' },
  PW: { len: 0.908, lie: 63.5, head: 'wedge' },
  GW: { len: 0.902, lie: 64, head: 'wedge' },
  SW: { len: 0.895, lie: 64, head: 'wedge' },
  LW: { len: 0.889, lie: 64, head: 'wedge' },
  P: { len: 0.864, lie: 71, head: 'putter' },
};
const KIND_DEFAULT = { driver: 'D', wood: '3W', hybrid: '4H', iron: '7i', wedge: 'SW', putter: 'P' };

// Head geometry per head type (m): heel-to-sweet-spot distance along the sole, sweet-spot height
// above the sole, face progression (face ahead of the shaft line), head length heel-toe, depth
// front-back and height.
const HEADS = {
  driver: { heel: 0.06, ss: 0.03, prog: 0.018, length: 0.118, depth: 0.112, height: 0.06 },
  wood: { heel: 0.045, ss: 0.019, prog: 0.014, length: 0.098, depth: 0.084, height: 0.036 },
  hybrid: { heel: 0.04, ss: 0.018, prog: 0.008, length: 0.09, depth: 0.06, height: 0.034 },
  iron: { heel: 0.034, ss: 0.017, prog: 0.002, length: 0.076, depth: 0.022, height: 0.046 },
  wedge: { heel: 0.033, ss: 0.017, prog: 0.004, length: 0.074, depth: 0.026, height: 0.054 },
  putter: { heel: 0.05, ss: 0.013, prog: 0.0, length: 0.105, depth: 0.026, height: 0.024 },
};

// Club spec for a club object, a club id ('7i') or a kind ('wood', 'iron', 'putter'...), fitted
// to a golfer of heightM metres. Club space (the club bone's frame): origin at the lead hand's
// grip point on the shaft axis, -Z down the shaft toward the head, +X the square face normal
// (unlofted), -Y toward the toe. Returned vectors are in club space:
//   hosel   the bottom of the shaft (heel of the sole)
//   toe, up, faceN   unit head axes (toe direction along the sole, up from the sole, lofted face normal)
//   sweet   the sweet spot on the face
//   impact  where the CENTRE of a ball struck on the sweet spot sits (sweet + faceN * ball radius):
//           the club head reference point (swing-anim.js puts it on the ball at impact)
export function clubSpec(club, heightM = 1.78) {
  let id = null;
  if (club && typeof club === 'object') id = club.id;
  else if (typeof club === 'string') id = CLUB_SPECS[club] ? club : KIND_DEFAULT[club] || null;
  if (!id || !CLUB_SPECS[id]) id = '7i';
  const s = CLUB_SPECS[id];
  const c = clubById(id);
  const hh = Math.min(2.05, Math.max(1.5, heightM));
  const fit = 1 + 0.42 * (hh / 1.78 - 1);
  const len = s.len * fit;
  // Fitted lie: shorter players play flatter clubs (hands lower), taller ones more upright.
  const lie = ((s.lie + (s.head === 'putter' ? 0 : 6 * (hh - 1.78))) * Math.PI) / 180;
  const loft = ((c ? c.loft : 30) * Math.PI) / 180;
  const head = HEADS[s.head];
  const butt = 0.042; // butt end above the lead grip point
  const hosel = [0, 0, -(len - butt)];
  const toe = [0, -Math.sin(lie), -Math.cos(lie)];
  const up = [0, -Math.cos(lie), Math.sin(lie)];
  const cl = Math.cos(loft);
  const sl = Math.sin(loft);
  const faceN = [cl, up[1] * sl, up[2] * sl];
  const sweet = [
    head.prog,
    hosel[1] + toe[1] * head.heel + up[1] * head.ss,
    hosel[2] + toe[2] * head.heel + up[2] * head.ss,
  ];
  const R = 0.02135;
  const impact = [sweet[0] + faceN[0] * R, sweet[1] + faceN[1] * R, sweet[2] + faceN[2] * R];
  return {
    id, kind: c ? c.kind : s.head, head: s.head, len, lie, loft, butt,
    hosel, toe, up, faceN, sweet, impact, dims: head,
  };
}

// ------------------------------------------------------------------ body proportions
const BUILD = {
  slim: { shoulder: 0.96, chest: 0.92, waist: 0.9, belly: 0.88, hip: 0.95, limb: 0.88, neck: 0.92 },
  regular: { shoulder: 1, chest: 1, waist: 1, belly: 1, hip: 1, limb: 1, neck: 1 },
  athletic: { shoulder: 1.07, chest: 1.07, waist: 0.96, belly: 0.92, hip: 0.98, limb: 1.1, neck: 1.08 },
  heavy: { shoulder: 1.04, chest: 1.12, waist: 1.24, belly: 1.55, hip: 1.12, limb: 1.16, neck: 1.15 },
};

// Proportions of a look. All rest positions are in G at rest (metres). Fractions of the height H
// follow adult anthropometry (shoulder joint centre 0.80 H, hip joint 0.52 H, knee 0.283 H,
// ankle 0.042 H; upper arm 0.186 H, forearm 0.146 H); the head grows more slowly than the body
// (a tall golfer is not a scaled-up short one), about 7.7 heads tall at 1.78 m.
export function bodyDims(look) {
  const L = normalizeLook(look);
  const H = L.height / 100;
  const fem = L.body === 'female';
  const bf = BUILD[L.build];
  const headH = 0.232 * Math.pow(H / 1.78, 0.45) * (fem ? 0.955 : 1);
  const sh = (fem ? 0.101 : 0.112) * bf.shoulder; // shoulder joint half-width / H
  const hipHalf = (fem ? 0.055 : 0.05) * (0.5 + 0.5 * bf.hip);
  const j = new Float64Array(BONE_COUNT * 3);
  const set = (b, x, y, z) => {
    j[b * 3] = x;
    j[b * 3 + 1] = y;
    j[b * 3 + 2] = z;
  };
  const hipZ = 0.52 * H;
  const kneeZ = 0.283 * H;
  const ankleZ = 0.042 * H;
  const shZ = 0.8 * H;
  const chinZ = H - headH;
  set(B.pelvis, 0, 0, hipZ);
  set(B.spine, -0.006 * H, 0, 0.578 * H);
  set(B.chest, -0.012 * H, 0, 0.668 * H);
  set(B.neck, -0.022 * H, 0, 0.82 * H);
  set(B.head, -0.012 * H, 0, chinZ + 0.012 * H);
  for (const [side, cl, ua, fa, hd] of [[1, B.clavL, B.upperArmL, B.forearmL, B.handL], [-1, B.clavR, B.upperArmR, B.forearmR, B.handR]]) {
    const y = side * sh * H;
    set(cl, 0.014 * H, side * 0.016 * H, shZ + 0.004 * H);
    set(ua, -0.008 * H, y, shZ);
    set(fa, -0.008 * H, y, shZ - 0.186 * H);
    set(hd, -0.008 * H, y, shZ - 0.186 * H - 0.146 * H);
  }
  for (const [side, th, sn, ft] of [[1, B.thighL, B.shinL, B.footL], [-1, B.thighR, B.shinR, B.footR]]) {
    const y = side * hipHalf * H;
    set(th, 0, y, hipZ);
    set(sn, 0, y, kneeZ);
    set(ft, 0, y, ankleZ);
  }
  // The club bone's rest origin: any fixed point; under the lead hand.
  set(B.club, -0.008 * H, sh * H, shZ - 0.186 * H - 0.146 * H - 0.08 * H);
  const handS = H * (fem ? 0.93 : 1) * (0.96 + 0.04 * bf.limb);
  return {
    look: L, H, fem, build: bf, headH, chinZ, hipZ, kneeZ, ankleZ, shZ,
    shoulderHalf: sh * H, hipHalf: hipHalf * H,
    joints: j,
    upperArm: 0.186 * H,
    forearm: 0.146 * H,
    thigh: hipZ - kneeZ,
    shin: kneeZ - ankleZ,
    foot: { toe: 0.118 * H, heel: 0.04 * H, ball: 0.078 * H, width: 0.05 * H, sole: ankleZ },
    hand: handS,
    grip: gripFrames(handS),
  };
}

// The hand bones' poses in club space: {rot (3x3 column-major: the hand's local axes), wrist (the
// hand bone origin), grip (where the hand's middle sits on the shaft)} for the lead and trail hand.
// The lead hand's palm faces away from the target, its back toward it; the trail hand sits one
// hand-width lower with its palm toward the target. The forearm directions are those of a
// neutral address (the wrists hinge from there during the swing).
function gripFrames(hs) {
  const s = hs / 1.8;
  const frame = (zDir, yHint, wrist, grip) => {
    const z = norm3(zDir);
    const y = norm3(sub3(yHint, scale3(z, dot3(yHint, z))));
    const x = cross3(y, z);
    return { rot: new Float64Array([x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]]), wrist, grip };
  };
  const leadZ = norm3([0.16, -0.3, 0.94]);
  const lead = frame(leadZ, [1, 0, 0], null, [0, 0, 0]);
  // Wrist: up the forearm from the grip, a little toward the back of the hand.
  lead.wrist = new Float64Array(add3(scale3(leadZ, 0.083 * s), scale3([lead.rot[3], lead.rot[4], lead.rot[5]], 0.012 * s)));
  const gap = 0.088 * s;
  const trailZ = norm3([-0.3, -0.26, 0.92]);
  const trail = frame(trailZ, [1, 0, 0], null, [0, 0, -gap]);
  // The right hand's back faces -Y_hand (its palm faces the target, +X club).
  trail.wrist = new Float64Array(add3(add3([0, 0, -gap], scale3(trailZ, 0.083 * s)), scale3([trail.rot[3], trail.rot[4], trail.rot[5]], -0.012 * s)));
  return { lead, trail, gap, scale: s };
}

// Tiny 3-vector helpers on arrays (setup code only; swing-anim.js has allocation-free versions).
function add3(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function sub3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function scale3(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross3(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm3(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
