// Deterministic 2D value noise and fractal Brownian motion (pure, no allocation).
// Ranges: hash2 and valueNoise2 return [0, 1); fbm2 is normalised by the total octave amplitude so
// it also stays in [0, 1) (mean about 0.5). Callers that want a signed field use (v - 0.5) * 2.

// Integer lattice hash -> [0, 1). Math.imul keeps it in 32-bit integer arithmetic so results are
// identical on every JS engine.
export function hash2(ix, iy, seed = 0) {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Smooth value noise: lattice values blended with a quintic fade, so the field and its first and
// second derivatives are continuous (no creases in terrain built from it).
export function valueNoise2(x, y, seed = 0) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  const top = a + (b - a) * ux;
  const bot = c + (d - c) * ux;
  return top + (bot - top) * uy;
}

// Fractal sum of value noise octaves. Each octave is offset (and re-seeded) so the lattices of
// successive octaves do not line up, which would otherwise show as a faint grid.
export function fbm2(x, y, { oct = 4, lac = 2, gain = 0.5, seed = 0 } = {}) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < oct; o++) {
    sum += amp * valueNoise2(x * f + o * 17.31, y * f - o * 11.17, seed + o * 101);
    norm += amp;
    amp *= gain;
    f *= lac;
  }
  return sum / norm;
}
