// CPU texture bakes for the renderer (pure: typed arrays in, typed arrays out, no DOM).
//
// bakeTerrainColor(terrain, {sunDir, seed, theme}) paints the hole's ground at the surface-grid
// resolution (0.5 m): the albedo of each surface (theme.surfaceColors, which default to
// SURFACES[].color), softened edges, a semi-rough first cut, darkened bunker lips, depth-tinted
// water beds, curvature ambient occlusion and soft object shadows. The alpha channel carries the
// mowing-pattern mask the terrain shader turns into stripes:
//   0 = none (rough, sand, water), 0.5 = fairway / tee / fringe stripes, 1 = green crosshatch.
// Version 2 surfaces get their own looks (desert floor, waste hardpan or beach sand with a damp
// band at the water, tawny fescue) and steep pot-bunker faces are painted as revetted sod. The
// result's `detail` (RGBA, same size; null when the hole has none of these) tells the terrain
// shader where to add their close-up texture: r = desert, g = waste, b = fescue, a = revetted face.
// bakeWaterDepth(terrain) gives the water depth on the 1 m grid for the water shader (turquoise
// shallows, surf). bakeClouds(seed) and bakeNoise(seed) make small tileable textures for the sky
// and for grass grain.

import { SURF, SURFACES } from './constants.js';
import { hash2, fbm2 } from './noise.js';
import { themeFor } from './themes.js';

// Direction TOWARD the sun (unit). Afternoon light from the south-west at about 42 degrees, so
// slopes read clearly from most camera angles. Shared with the renderer for lighting.
export const SUN_DIR = (() => {
  const az = (215 * Math.PI) / 180;
  const el = (42 * Math.PI) / 180;
  return { x: Math.cos(el) * Math.cos(az), y: Math.cos(el) * Math.sin(az), z: Math.sin(el) };
})();

// Separable sliding-window box blur of a W x H float field with radius r (clamped edges).
export function boxBlur(src, W, H, r) {
  if (r < 1) return Float32Array.from(src);
  const tmp = new Float32Array(W * H);
  const out = new Float32Array(W * H);
  const inv = 1 / (2 * r + 1);
  for (let j = 0; j < H; j++) {
    const row = j * W;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(W - 1, Math.max(0, k))];
    for (let i = 0; i < W; i++) {
      tmp[row + i] = acc * inv;
      acc += src[row + Math.min(W - 1, i + r + 1)] - src[row + Math.max(0, i - r)];
    }
  }
  for (let i = 0; i < W; i++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(H - 1, Math.max(0, k)) * W + i];
    for (let j = 0; j < H; j++) {
      out[j * W + i] = acc * inv;
      acc += tmp[Math.min(H - 1, j + r + 1) * W + i] - tmp[Math.max(0, j - r) * W + i];
    }
  }
  return out;
}

const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mul3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const sat = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Shadow casters of one object as discs [height above the base, radius, strength]: the shipped
// trees (a trunk line up to the canopy, then the canopy ellipsoid in slices), a palm's thin trunk
// and its open crown, a saguaro's column and arms, a low bush, a rock.
function objectShadow(t) {
  const discs = [];
  const line = (top, r, k, n = 6) => {
    for (let q = 0; q <= n; q++) discs.push([(top * q) / n, r, k]);
  };
  switch (t.kind) {
    case 'palm': {
      const H = t.trunkH || 9;
      const rx = t.canopy ? t.canopy.rx : 3.5;
      line(H, 0.28, 0.28, 8);
      discs.push([H, rx * 0.85, 0.32], [H - 0.6, rx * 0.6, 0.3]);
      break;
    }
    case 'saguaro': {
      const H = t.trunkH || 6;
      line(H, 0.38, 0.38, 7);
      const s = H / 6.5;
      if (H >= 5) discs.push([3.2 * s, 0.75 * s, 0.3], [4.0 * s, 0.7 * s, 0.3]);
      break;
    }
    case 'shrub':
    case 'gorse': {
      const cz = t.canopy ? t.canopy.cz - t.z : 0.6;
      const rx = t.canopy ? t.canopy.rx : 1.2;
      discs.push([cz * 0.5, rx * 0.95, 0.42], [cz, rx * 0.85, 0.4]);
      break;
    }
    case 'rock': {
      const r = t.trunkR || 0.6;
      const h = t.trunkH || r;
      discs.push([h * 0.3, r * 0.95, 0.55], [h * 0.7, r * 0.7, 0.5]);
      break;
    }
    default: {
      const cz = t.canopy ? t.canopy.cz - t.z : 6; // canopy-centre height above the base
      const rx = t.canopy ? t.canopy.rx : 3;
      const rz = t.canopy ? t.canopy.rz : 3;
      const trunkTop = Math.min(t.trunkH || cz - rz, cz);
      const tr = Math.max(0.3, (t.trunkR || 0.25) * 1.4);
      for (let k = 0; k <= 6; k++) discs.push([(trunkTop * k) / 6, tr, 0.3]);
      for (const f of [-0.6, -0.3, 0, 0.3, 0.6]) discs.push([cz + f * rz, rx * Math.sqrt(1 - f * f) * 1.05, 0.45]);
    }
  }
  return discs;
}

// A pot bunker's walls are far steeper on the 1 m height grid (a 1.2-1.8 m drop within a cell or
// two: gradients 0.8-1.3) than any ordinary bunker bowl (at most ~0.75 on all four courses): walls
// above this gradient are painted as revetted sod.
const REVET_GRAD = 0.88;

export function bakeTerrainColor(terrain, { sunDir = SUN_DIR, seed = 7, theme = null } = {}) {
  const TH = theme || themeFor(terrain.theme);
  const sg = terrain.sgrid;
  const W = sg.nx;
  const H = sg.ny;
  const st = sg.step;
  const N = W * H;
  const S = sg.data;

  // Masks at texel resolution.
  const fair = new Float32Array(N); // closely mown (fairway, tee, fringe, green)
  const sand = new Float32Array(N);
  const wet = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const s = S[k];
    fair[k] = s === SURF.FAIRWAY || s === SURF.TEE || s === SURF.FRINGE || s === SURF.GREEN ? 1 : 0;
    sand[k] = s === SURF.BUNKER ? 1 : 0;
    wet[k] = s === SURF.WATER ? 1 : 0;
  }
  const fairNear = boxBlur(fair, W, H, Math.round(2.5 / st)); // first-cut band ~2.5 m wide
  const fairWide = boxBlur(fairNear, W, H, Math.round(4 / st)); // wider halo for rough shading
  const sandNear = boxBlur(sand, W, H, Math.round(0.8 / st)); // lip band
  const wetNear = boxBlur(wet, W, H, Math.round(1.5 / st));

  // Height grid lookups (bilinear) for water depth and curvature AO.
  const g = terrain.grid;
  const hAt = (x, y) => {
    const fx = Math.min(g.nx - 1.001, Math.max(0, (x - g.minX) / g.step));
    const fy = Math.min(g.ny - 1.001, Math.max(0, (y - g.minY) / g.step));
    const i = fx | 0;
    const j = fy | 0;
    const tx = fx - i;
    const ty = fy - j;
    const h = g.heights;
    const a = h[j * g.nx + i];
    const b = h[j * g.nx + i + 1];
    const c = h[(j + 1) * g.nx + i];
    const d = h[(j + 1) * g.nx + i + 1];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };

  // Per-surface grade on top of SURFACES[].color: closely mown grass is darker relative to the rough
  // than the raw table suggests (on TV the contrast is mostly hue and texture, not brightness).
  const GRADE = { [SURF.FAIRWAY]: 0.8, [SURF.TEE]: 0.8, [SURF.FRINGE]: 0.8, [SURF.GREEN]: 0.8 };
  const albedo = (id) => (TH.surfaceColors && TH.surfaceColors[id]) || (SURFACES[id] || SURFACES[SURF.ROUGH]).color;
  const C = (id) => mul3(albedo(id), GRADE[id] || 1);
  const cFair = C(SURF.FAIRWAY);
  const cTee = C(SURF.TEE);
  const cRough = C(SURF.ROUGH);
  const cFringe = C(SURF.FRINGE);
  const cGreen = C(SURF.GREEN);
  const cSand = C(SURF.BUNKER);
  const cWater = C(SURF.WATER);
  const cOob = C(SURF.OOB);
  const cCut = mix3(cFair, cRough, 0.45); // semi-rough first cut
  const cRoughDry = [cRough[0] * 1.2 + 0.04, cRough[1] * 1.05, cRough[2] * 0.85]; // straw-tinted patches
  const cRoughLush = [cRough[0] * 0.8, cRough[1] * 0.95, cRough[2] * 0.95];
  const cBed = TH.water.shallow; // lake bed at the margins
  const cWaste = C(SURF.WASTE);
  const cDesert = C(SURF.DESERT);
  const cDesertRed = [cDesert[0] * 1.08 + 0.02, cDesert[1] * 0.86, cDesert[2] * 0.8]; // iron-red patches
  const cDesertPale = [cDesert[0] * 1.06 + 0.05, cDesert[1] * 1.08 + 0.05, cDesert[2] * 1.1 + 0.04]; // caliche
  const cFescue = C(SURF.FESCUE);
  const cFescueGreen = [cFescue[0] * 0.72, cFescue[1] * 0.86, cFescue[2] * 0.8]; // grey-green hollows
  const cRevet = TH.revet || [0.2, 0.26, 0.12];
  // Detail weights for the shader (allocated only when something on the hole needs them).
  let det = null;
  const detail = () => det || (det = [new Float32Array(N), new Float32Array(N), new Float32Array(N), new Float32Array(N)]);

  const col = new Float32Array(N * 3);
  const alpha = new Float32Array(N);
  for (let j = 0; j < H; j++) {
    const y = sg.minY + (j + 0.5) * st;
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      const x = sg.minX + (i + 0.5) * st;
      const s = S[k];
      // Two noise scales: broad patches (~25 m) and fine mottling (~3 m).
      const nb = fbm2(x / 25, y / 25, { oct: 3, seed });
      const nf = fbm2(x / 3, y / 3, { oct: 2, seed: seed + 5 });
      let c;
      let a = 0;
      switch (s) {
        case SURF.FAIRWAY:
          c = mul3(cFair, 0.93 + 0.12 * nb + 0.05 * nf);
          a = 0.5;
          break;
        case SURF.TEE:
          c = mul3(cTee, 0.95 + 0.08 * nf);
          a = 0.5;
          break;
        case SURF.FRINGE:
          c = mul3(cFringe, 0.95 + 0.06 * nf);
          a = 0.5;
          break;
        case SURF.GREEN:
          c = mul3(cGreen, 0.97 + 0.05 * nb + 0.03 * nf);
          a = 1;
          break;
        case SURF.BUNKER: {
          // Sand: slightly darker, damp-looking near the edge where the face is shadowed.
          const edge = 1 - sandNear[k];
          c = mul3(cSand, (0.98 + 0.06 * nf) * (1 - 0.22 * sat(edge * 2.2)));
          break;
        }
        case SURF.WATER: {
          // Bed colour darkens with depth below the water level.
          const w = terrain.waterAt ? terrain.waterAt(x, y) : null;
          const depth = w ? Math.max(0, w.level - hAt(x, y)) : 1;
          // Clear (tinted) water shows a sand bed that darkens with depth, as the skirt's sea bed
          // beyond the grid does; the shipped ponds fade to a dark tint of the water colour.
          if (TH.water.tint) c = mul3(cBed, 1 - 0.82 * sat((depth - 0.3) / 3.3));
          else c = mix3(cBed, mul3(cWater, 0.6), sat(depth / 1.2));
          break;
        }
        case SURF.WASTE:
          // Hardpan, waste sand or beach: pale, faint broad patches.
          c = mul3(cWaste, 0.94 + 0.1 * nb + 0.05 * nf);
          detail()[1][k] = 1;
          break;
        case SURF.DESERT: {
          // Desert floor: iron-red and pale caliche patches, mottled by stones and scrub.
          c = mix3(cDesert, cDesertRed, sat((nb - 0.56) * 3) * 0.45);
          c = mix3(c, cDesertPale, sat((0.4 - nb) * 3) * 0.4);
          c = mul3(c, 0.9 + 0.18 * nf);
          detail()[0][k] = 1;
          break;
        }
        case SURF.FESCUE:
          // Tawny fescue with greener, greyer hollows.
          c = mix3(cFescue, cFescueGreen, sat((0.5 - nb) * 2.5));
          c = mul3(c, 0.86 + 0.24 * nf);
          detail()[2][k] = 1;
          break;
        case SURF.OOB:
          c = mul3(mix3(cOob, cRoughDry, nb * 0.6), 0.9 + 0.15 * nf);
          break;
        default: {
          // Rough: patchy, with the first cut hugging the fairway and greens.
          let r = mix3(cRoughLush, cRoughDry, sat((nb - 0.35) * 2.2));
          r = mul3(r, 0.88 + 0.22 * nf);
          const cut = sat(fairNear[k] * 3.5);
          c = mix3(r, cCut, cut);
          // Rough well away from the corridor is a touch darker and cooler.
          c = mul3(c, 0.92 + 0.08 * sat(fairWide[k] * 4));
          a = cut * 0.2;
        }
      }
      // Grass lip around bunkers (and banks around water) reads darker; sandy ground at the water
      // is damp instead of green.
      if (s !== SURF.BUNKER && sandNear[k] > 0.02) c = mul3(c, 1 - 0.32 * sat(sandNear[k] * 2.5));
      if (s !== SURF.WATER && wetNear[k] > 0.02) {
        if (s === SURF.WASTE || s === SURF.DESERT) c = mix3(c, mul3(c, 0.68), 0.8 * sat(wetNear[k] * 2));
        else c = mix3(c, mul3(cRoughLush, 0.8), 0.5 * sat(wetNear[k] * 2));
      }
      // Revetted pot-bunker faces: a wall of stacked sod, far steeper than any ordinary bank.
      if (sandNear[k] > 0.02) {
        const gx = hAt(x + 0.5, y) - hAt(x - 0.5, y);
        const gy = hAt(x, y + 0.5) - hAt(x, y - 0.5);
        const rv = sat((Math.hypot(gx, gy) - REVET_GRAD) * 8);
        if (rv > 0) {
          c = mix3(c, mul3(cRevet, 0.9 + 0.15 * nf), rv);
          detail()[3][k] = rv;
          a *= 1 - rv;
        }
      }
      col[k * 3] = c[0];
      col[k * 3 + 1] = c[1];
      col[k * 3 + 2] = c[2];
      alpha[k] = a;
    }
  }

  // Curvature ambient occlusion: hollows a little darker, crowns a little lighter.
  for (let j = 0; j < H; j++) {
    const y = sg.minY + (j + 0.5) * st;
    for (let i = 0; i < W; i++) {
      const x = sg.minX + (i + 0.5) * st;
      const h0 = hAt(x, y);
      const lap = (hAt(x + 2, y) + hAt(x - 2, y) + hAt(x, y + 2) + hAt(x, y - 2)) / 4 - h0;
      const ao = 1 - Math.max(-0.08, Math.min(0.2, lap * 0.9));
      const k = (j * W + i) * 3;
      col[k] *= ao;
      col[k + 1] *= ao;
      col[k + 2] *= ao;
    }
  }

  // Tree shadows, cast away from the sun along the ground: a thin trunk shadow from the base up
  // to the canopy shadow, which is the canopy ellipsoid projected (a blob stretched along the
  // shadow direction). The trunk line ties the canopy shadow to its tree, which would otherwise
  // sit several metres off on open grass (a 42 deg sun throws a 6-10 m canopy 7-11 m away) and
  // read as a hole in the rough.
  const sx = -sunDir.x / Math.max(0.2, sunDir.z);
  const sy = -sunDir.y / Math.max(0.2, sunDir.z);
  const shade = new Float32Array(N);
  for (const t of terrain.trees || []) {
    const discs = objectShadow(t); // [height of the shadow-casting point, radius, strength]
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [hgt, r] of discs) {
      x0 = Math.min(x0, t.x + sx * hgt - r);
      x1 = Math.max(x1, t.x + sx * hgt + r);
      y0 = Math.min(y0, t.y + sy * hgt - r);
      y1 = Math.max(y1, t.y + sy * hgt + r);
    }
    const i0 = Math.max(0, Math.floor((x0 - sg.minX) / st));
    const i1 = Math.min(W - 1, Math.ceil((x1 - sg.minX) / st));
    const j0 = Math.max(0, Math.floor((y0 - sg.minY) / st));
    const j1 = Math.min(H - 1, Math.ceil((y1 - sg.minY) / st));
    for (let j = j0; j <= j1; j++) {
      const wy = sg.minY + (j + 0.5) * st;
      for (let i = i0; i <= i1; i++) {
        const wx = sg.minX + (i + 0.5) * st;
        // One tree's shadow is the union of its parts (max), not their sum.
        let f = 0;
        for (const [hgt, r, k0] of discs) {
          const d = Math.hypot(wx - (t.x + sx * hgt), wy - (t.y + sy * hgt)) / r;
          if (d < 1) f = Math.max(f, k0 * (1 - d * d) * (1 - d * d));
        }
        if (f > 0) {
          const k = j * W + i;
          shade[k] = 1 - (1 - shade[k]) * (1 - f);
        }
      }
    }
  }

  // Soften every edge by ~0.5 m, then quantise. Alpha is softened a touch more for smooth stripes.
  const R = boxBlur(col.filter((_, k) => k % 3 === 0), W, H, 1);
  const G = boxBlur(col.filter((_, k) => k % 3 === 1), W, H, 1);
  const B = boxBlur(col.filter((_, k) => k % 3 === 2), W, H, 1);
  const A = boxBlur(alpha, W, H, 1);
  const data = new Uint8Array(N * 4);
  for (let k = 0; k < N; k++) {
    const sh = 1 - Math.min(0.62, shade[k]);
    data[k * 4] = Math.round(sat(R[k] * sh) * 255);
    data[k * 4 + 1] = Math.round(sat(G[k] * sh) * 255);
    data[k * 4 + 2] = Math.round(sat(B[k] * sh) * 255);
    data[k * 4 + 3] = Math.round(sat(A[k]) * 255);
  }
  let detailOut = null;
  if (det) {
    const D = det.map((ch) => boxBlur(ch, W, H, 1));
    const dd = new Uint8Array(N * 4);
    for (let k = 0; k < N; k++) for (let c = 0; c < 4; c++) dd[k * 4 + c] = Math.round(sat(D[c][k]) * 255);
    detailOut = { width: W, height: H, data: dd };
  }
  return { width: W, height: H, data, minX: sg.minX, minY: sg.minY, step: st, detail: detailOut };
}

// Water depth below each water surface on the 1 m height grid (r = depth / WATER_DEPTH_MAX m,
// 0 on dry ground) and the distance to the nearest dry ground (g, m, up to 255), for the water
// shader's shallows, its deepening away from the shore and the surf. {width, height, data, minX,
// minY, step}: texel (i, j) is centred on grid node (i, j), i.e. the texture spans minX =
// grid.minX - step/2 .. + width·step. Only nodes inside a water body's bounding box ask
// terrain.waterAt (the surface grid would miss water under out-of-bounds ground at the edge).
export const WATER_DEPTH_MAX = 6;
export function bakeWaterDepth(terrain) {
  const g = terrain.grid;
  const W = g.nx;
  const H = g.ny;
  const data = new Uint8Array(W * H * 4);
  const boxes = (terrain.waters || []).filter((w) => w.poly && w.poly.length).map((w) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const q of w.poly) {
      x0 = Math.min(x0, q.x);
      y0 = Math.min(y0, q.y);
      x1 = Math.max(x1, q.x);
      y1 = Math.max(y1, q.y);
    }
    return [x0 - 1, y0 - 1, x1 + 1, y1 + 1];
  });
  if (!terrain.waterAt || !boxes.length) return { width: W, height: H, data, minX: g.minX - g.step / 2, minY: g.minY - g.step / 2, step: g.step };
  for (let j = 0; j < H; j++) {
    const y = g.minY + j * g.step;
    const rows = boxes.filter((b) => y >= b[1] && y <= b[3]);
    if (!rows.length) continue;
    for (let i = 0; i < W; i++) {
      const x = g.minX + i * g.step;
      let inBox = false;
      for (const b of rows) if (x >= b[0] && x <= b[2]) inBox = true;
      if (!inBox) continue;
      const w = terrain.waterAt(x, y);
      if (!w) continue;
      const d = Math.max(0, w.level - g.heights[j * W + i]);
      data[(j * W + i) * 4] = Math.round(sat(d / WATER_DEPTH_MAX) * 255);
      data[(j * W + i) * 4 + 1] = 255; // wet: the distance pass below fills in the real value
    }
  }
  // Distance to dry ground (chamfer 1 / 1.4 metric, two passes), in grid steps.
  const D = new Float32Array(W * H);
  for (let k = 0; k < W * H; k++) D[k] = data[k * 4 + 1] ? 1e9 : 0;
  const relax = (k, k2, w) => {
    if (D[k2] + w < D[k]) D[k] = D[k2] + w;
  };
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      if (!D[k]) continue;
      if (i > 0) relax(k, k - 1, 1);
      if (j > 0) {
        relax(k, k - W, 1);
        if (i > 0) relax(k, k - W - 1, 1.4);
        if (i < W - 1) relax(k, k - W + 1, 1.4);
      }
    }
  }
  for (let j = H - 1; j >= 0; j--) {
    for (let i = W - 1; i >= 0; i--) {
      const k = j * W + i;
      if (!D[k]) continue;
      if (i < W - 1) relax(k, k + 1, 1);
      if (j < H - 1) {
        relax(k, k + W, 1);
        if (i < W - 1) relax(k, k + W + 1, 1.4);
        if (i > 0) relax(k, k + W - 1, 1.4);
      }
    }
  }
  for (let k = 0; k < W * H; k++) data[k * 4 + 1] = Math.min(255, Math.round(D[k] * g.step));
  return { width: W, height: H, data, minX: g.minX - g.step / 2, minY: g.minY - g.step / 2, step: g.step };
}

// Periodic value noise on a lattice of period P (so the texture tiles).
function pnoise(x, y, P, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const w = (v) => ((v % P) + P) % P;
  const a = hash2(w(ix), w(iy), seed);
  const b = hash2(w(ix + 1), w(iy), seed);
  const c = hash2(w(ix), w(iy + 1), seed);
  const d = hash2(w(ix + 1), w(iy + 1), seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function pfbm(u, v, base, oct, seed) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = base;
  for (let o = 0; o < oct; o++) {
    sum += amp * pnoise(u * f, v * f, f, seed + o * 31);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

// Tileable cloud texture (size x size RGBA): R = cumulus density (thresholded fbm, soft edges),
// G = the same field shifted toward the sun (the sky shader uses R - G for self-shadowing),
// B = high thin cirrus streaks, A = 255.
export function bakeClouds(seed = 1, size = 256) {
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const v = j / size;
      const d = pfbm(u, v, 4, 5, seed);
      const d2 = pfbm(u + 2 / size, v + 2 / size, 4, 5, seed);
      const cov = (x) => sat((x - 0.5) * 3.2);
      const ci = pfbm(u * 1, v * 4 % 1, 4, 4, seed + 99);
      const k = (j * size + i) * 4;
      data[k] = Math.round(cov(d) * 255);
      data[k + 1] = Math.round(cov(d2) * 255);
      data[k + 2] = Math.round(sat((ci - 0.55) * 3) * 255);
      data[k + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

// Tileable grain/detail noise (size x size RGBA, power of two so it can repeat and mipmap on WebGL1):
// R = smooth noise period 1 tile/8 cells, G = 32 cells, B = fine per-texel noise, A = fbm.
export function bakeNoise(seed = 3, size = 256) {
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const v = j / size;
      const k = (j * size + i) * 4;
      data[k] = Math.round(pnoise(u * 8, v * 8, 8, seed) * 255);
      data[k + 1] = Math.round(pnoise(u * 32, v * 32, 32, seed + 1) * 255);
      data[k + 2] = Math.round(hash2(i, j, seed + 2) * 255);
      data[k + 3] = Math.round(pfbm(u, v, 16, 4, seed + 3) * 255);
    }
  }
  return { width: size, height: size, data };
}
