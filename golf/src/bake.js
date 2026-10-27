// CPU texture bakes for the renderer (pure: typed arrays in, typed arrays out, no DOM).
//
// bakeTerrainColor(terrain) paints the hole's ground at the surface-grid resolution (0.5 m): the
// albedo of each surface from SURFACES[].color, softened edges, a semi-rough first cut, darkened
// bunker lips, depth-tinted water beds, curvature ambient occlusion and soft tree blob shadows. The
// alpha channel carries the mowing-pattern mask the terrain shader turns into stripes:
//   0 = none (rough, sand, water), 0.5 = fairway / tee / fringe stripes, 1 = green crosshatch.
// bakeClouds(seed) and bakeNoise(seed) make small tileable textures for the sky and for grass grain.

import { SURF, SURFACES } from './constants.js';
import { hash2, fbm2 } from './noise.js';

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

export function bakeTerrainColor(terrain, { sunDir = SUN_DIR, seed = 7 } = {}) {
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
  const C = (id) => mul3(SURFACES[id].color, GRADE[id] || 1);
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
          c = mix3([0.36, 0.38, 0.26], mul3(cWater, 0.6), sat(depth / 1.2));
          break;
        }
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
      // Grass lip around bunkers (and banks around water) reads darker.
      if (s !== SURF.BUNKER && sandNear[k] > 0.02) c = mul3(c, 1 - 0.32 * sat(sandNear[k] * 2.5));
      if (s !== SURF.WATER && wetNear[k] > 0.02) c = mix3(c, mul3(cRoughLush, 0.8), 0.5 * sat(wetNear[k] * 2));
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

  // Soft tree blob shadows, cast away from the sun along the ground.
  const sx = -sunDir.x / Math.max(0.2, sunDir.z);
  const sy = -sunDir.y / Math.max(0.2, sunDir.z);
  const shade = new Float32Array(N);
  for (const t of terrain.trees || []) {
    const ch = (t.canopy ? t.canopy.cz - t.z : 6) * 0.85; // canopy-centre height above the base
    const rx = t.canopy ? t.canopy.rx : 3;
    // A canopy-shaped blob displaced by the shadow vector, plus a small dark spot at the trunk.
    for (const [ox, oy, r, k0] of [[sx * ch, sy * ch, rx * 1.1, 0.55], [sx * ch * 0.3, sy * ch * 0.3, rx * 0.7, 0.25]]) {
      const cx = t.x + ox;
      const cy = t.y + oy;
      const i0 = Math.max(0, Math.floor((cx - r - sg.minX) / st));
      const i1 = Math.min(W - 1, Math.ceil((cx + r - sg.minX) / st));
      const j0 = Math.max(0, Math.floor((cy - r - sg.minY) / st));
      const j1 = Math.min(H - 1, Math.ceil((cy + r - sg.minY) / st));
      for (let j = j0; j <= j1; j++) {
        const py = sg.minY + (j + 0.5) * st - cy;
        for (let i = i0; i <= i1; i++) {
          const px = sg.minX + (i + 0.5) * st - cx;
          const d = Math.hypot(px, py) / r;
          if (d >= 1) continue;
          const f = k0 * (1 - d * d) * (1 - d * d);
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
  return { width: W, height: H, data, minX: sg.minX, minY: sg.minY, step: st };
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
