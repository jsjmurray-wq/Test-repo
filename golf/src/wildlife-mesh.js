// Wildlife meshes (docs/architecture.md section 10): low-poly animals for every course theme, built
// once on the CPU and drawn instanced by the wildlife pass (shaders-wildlife.js). Pure module.
//
// Every species is one small mesh (80-400 triangles) in its own frame: +x forward (the way it
// faces), +y its left, +z up, the origin on the ground between its feet. Each vertex carries TWO
// poses so the shader can blend them per instance:
//   birds      pos = flight pose (wings spread, legs tucked or trailing, the neck as it flies)
//              alt = rest pose (wings folded on the flanks, legs down, the neck as it stands)
//   mammals    pos = the normal stance, alt = alert (deer: white tail flagged, head up;
//              rabbits and squirrels: sitting up; lizards: a push-up)
// plus the animation data the vertex shader needs (WILD_VS):
//   piv  pivot of the vertex's part (hip / shoulder / ear root / tail base; neck and head use the
//        slot's neck pivot from the uniform table instead)
//   anim (part, f, slot, rgb): part = PART id; f = weight along the part (0 at its root .. 1 at its
//        tip: legs curl, necks bend, wings flap more toward the tip); slot = the mesh's index in
//        the hole's species list (set by wildlifeMesh); rgb = the vertex colour (sRGB 0..255)
//        packed as r * 65536 + g * 256 + b (exact in a float32 attribute)
//   nrm  both poses' unit normals, octahedral-encoded (A.xy, B.xy)
// Closed parts are wound outward; flat parts (ears, wings, tail fans) are two layers with their own
// colours (a gull's grey upperwing and white underwing), so the pass draws with back faces culled.
//
//   MESH_PARAMS[id]  -> per-mesh animation constants for the shader's slot table and the sim:
//       {kind (KIND), graze (rad the head drops when feeding), swing (rad of leg swing at a walk),
//        size (m, height), tail, ear (flick amplitudes), dihedral (rad), flap (rad, half stroke),
//        cz (m, height of the body centre: pitch and bank pivot), neckX, neckZ (neck pivot),
//        bob (m, body bounce at a run), draft (m, origin below the water line when swimming),
//        len, wid (m, body length and width: the contact shadow)}
//   buildSpeciesMesh(id) -> {pos, alt, piv, anim, nrm, idx, tris, verts} (memoised)
//   wildlifeMesh(slots)  -> the hole's species concatenated: {pos, alt, piv, anim (slot filled in),
//                           nrm, idx (Uint16), verts, tris, slotTris[], slotIds[], params
//                           (Float32Array, SLOT_FLOATS per slot: the shader's uSlot table)}
//   SPECIES_MESHES       -> every mesh id

const DEG = Math.PI / 180;

// Part ids (anim.x): what moves a vertex.
export const PART = Object.freeze({
  BODY: 0, HEAD: 1, LEG_FL: 2, LEG_FR: 3, LEG_HL: 4, LEG_HR: 5, TAIL: 6, EAR: 7, WING_L: 8, WING_R: 9,
  SPRAWL_FL: 10, SPRAWL_FR: 11, SPRAWL_HL: 12, SPRAWL_HR: 13, SPRAWL_TAIL: 14,
});
// Body plans (MESH_PARAMS.kind, the shader's gait): walkers (deer, coyote, sheep), bounders
// (rabbits, squirrels: hind legs together), birds and sprawlers (lizards).
export const KIND = Object.freeze({ WALKER: 0, BOUNDER: 1, BIRD: 2, SPRAWLER: 3 });
export const SLOT_FLOATS = 12; // 3 vec4 per slot in the shader's uniform table
export const MAX_SLOTS = 10;

// ------------------------------------------------------------------ small maths
const packRGB = (c) => (Math.round(clamp255(c[0])) * 65536) + (Math.round(clamp255(c[1])) * 256) + Math.round(clamp255(c[2]));
function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const sm = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
function norm3(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// Rotate p about the lateral (y) axis through pivot (px, pz): + = nose up (x toward +z).
function pitchAbout(p, px, pz, deg) {
  const a = deg * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const x = p[0] - px;
  const z = p[2] - pz;
  return [px + x * c - z * s, p[1], pz + x * s + z * c];
}
// Deterministic 0..1 hash (mesh variety without an rng).
function h01(k) {
  const s = Math.sin(k * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}
// Octahedral encoding of a unit normal into two numbers in [-1, 1].
function octEncode(n) {
  const l = Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]) || 1;
  let u = n[0] / l;
  let v = n[1] / l;
  if (n[2] < 0) {
    const ou = u;
    u = (1 - Math.abs(v)) * (ou >= 0 ? 1 : -1);
    v = (1 - Math.abs(ou)) * (v >= 0 ? 1 : -1);
  }
  return [u, v];
}

// ------------------------------------------------------------------ builder
// Collects vertices in both poses; triangles are wound by a reference (outward from a point, or
// facing a direction) so every part is consistent whatever order its builder produced.
class Builder {
  constructor() {
    this.pa = [];
    this.pb = [];
    this.pv = [];
    this.an = [];
    this.ix = [];
  }

  get n() {
    return this.pa.length / 3;
  }

  vert(a, b, part, f, rgb, piv = null) {
    const q = b || a;
    this.pa.push(a[0], a[1], a[2]);
    this.pb.push(q[0], q[1], q[2]);
    this.pv.push(piv ? piv[0] : 0, piv ? piv[1] : 0, piv ? piv[2] : 0);
    this.an.push(part, f, 0, packRGB(rgb));
    return this.n - 1;
  }

  P(i) {
    return [this.pa[i * 3], this.pa[i * 3 + 1], this.pa[i * 3 + 2]];
  }

  // Triangle wound so its pose-A normal points away from `out` (a point) or along `dir`.
  tri(a, b, c, { out = null, dir = null } = {}) {
    const A = this.P(a);
    const B = this.P(b);
    const C = this.P(c);
    const n = cross3(sub3(B, A), sub3(C, A));
    let ref = 1;
    if (out) {
      const m = scl3(add3(add3(A, B), C), 1 / 3);
      ref = dot3(n, sub3(m, out));
    } else if (dir) ref = dot3(n, dir);
    if (ref < 0) this.ix.push(a, c, b);
    else this.ix.push(a, b, c);
  }

  // Normals of one pose: area-weighted face normals summed per vertex.
  _normals(p) {
    const n = new Float64Array(p.length);
    const ix = this.ix;
    for (let k = 0; k < ix.length; k += 3) {
      const a = ix[k] * 3;
      const b = ix[k + 1] * 3;
      const c = ix[k + 2] * 3;
      const ux = p[b] - p[a];
      const uy = p[b + 1] - p[a + 1];
      const uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a];
      const vy = p[c + 1] - p[a + 1];
      const vz = p[c + 2] - p[a + 2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      for (const v of [a, b, c]) {
        n[v] += nx;
        n[v + 1] += ny;
        n[v + 2] += nz;
      }
    }
    return n;
  }

  build() {
    const nv = this.n;
    const na = this._normals(this.pa);
    const nb = this._normals(this.pb);
    const nrm = new Float32Array(nv * 4);
    for (let i = 0; i < nv; i++) {
      let a = [na[i * 3], na[i * 3 + 1], na[i * 3 + 2]];
      let b = [nb[i * 3], nb[i * 3 + 1], nb[i * 3 + 2]];
      if (Math.hypot(a[0], a[1], a[2]) < 1e-12) a = [0, 0, 1];
      if (Math.hypot(b[0], b[1], b[2]) < 1e-12) b = a;
      const ea = octEncode(norm3(a));
      const eb = octEncode(norm3(b));
      nrm[i * 4] = ea[0];
      nrm[i * 4 + 1] = ea[1];
      nrm[i * 4 + 2] = eb[0];
      nrm[i * 4 + 3] = eb[1];
    }
    return {
      pos: new Float32Array(this.pa),
      alt: new Float32Array(this.pb),
      piv: new Float32Array(this.pv),
      anim: new Float32Array(this.an),
      nrm,
      idx: new Uint16Array(this.ix),
      verts: nv,
      tris: this.ix.length / 3,
    };
  }
}

// ------------------------------------------------------------------ primitives
// Superellipse ring point (exponent e, 2 = ellipse) at angle th: [cos-ish, sin-ish].
function se(th, e) {
  const c = Math.cos(th);
  const s = Math.sin(th);
  const k = 2 / e;
  return [Math.sign(c) * Math.pow(Math.abs(c), k), Math.sign(s) * Math.pow(Math.abs(s), k)];
}

// Tube along a polyline in both poses. ptsA/ptsB: [[x,y,z]...] (same length), r: radii per point
// (or [rw, rh] pairs for flattened sections), sides; capEnd closes the last ring with a point.
// color(t, up, side) -> rgb (t along the tube 0..1, up = cos of the ring angle from the frame's
// up side, side = sin). f(t) -> anim weight. frameUp: reference vector for the ring frame.
function tube(B, ptsA, ptsB, r, sides, { part, color, f = (t) => t, piv = null, capEnd = false, capStart = false, frameUp = [0, 0, 1] }) {
  const n = ptsA.length;
  const rows = [];
  const frames = (pts) => {
    const out = [];
    let N = null;
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(n - 1, i + 1)];
      const T = norm3(sub3(b, a));
      let ref = frameUp;
      if (!N) {
        if (Math.abs(dot3(T, ref)) > 0.85) ref = [1, 0, 0];
        if (Math.abs(dot3(T, ref)) > 0.85) ref = [0, 1, 0];
        N = norm3(sub3(ref, scl3(T, dot3(T, ref))));
      } else {
        N = sub3(N, scl3(T, dot3(T, N)));
        if (Math.hypot(N[0], N[1], N[2]) < 1e-6) N = norm3(sub3(frameUp, scl3(T, dot3(T, frameUp))));
        N = norm3(N);
      }
      const Bn = cross3(T, N);
      out.push({ T, N, B: Bn });
    }
    return out;
  };
  const fa = frames(ptsA);
  const fb = ptsB ? frames(ptsB) : fa;
  const pb = ptsB || ptsA;
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0;
    const ri = r[i];
    const rw = Array.isArray(ri) ? ri[0] : ri;
    const rh = Array.isArray(ri) ? ri[1] : ri;
    const row = [];
    for (let k = 0; k < sides; k++) {
      const th = (k / sides) * Math.PI * 2;
      const c = Math.cos(th);
      const s = Math.sin(th);
      const A = add3(ptsA[i], add3(scl3(fa[i].N, c * rh), scl3(fa[i].B, s * rw)));
      const Bp = add3(pb[i], add3(scl3(fb[i].N, c * rh), scl3(fb[i].B, s * rw)));
      row.push(B.vert(A, Bp, part, f(t), color(t, c, s), piv));
    }
    rows.push(row);
  }
  for (let i = 0; i < n - 1; i++) {
    const mid = scl3(add3(ptsA[i], ptsA[i + 1]), 0.5);
    for (let k = 0; k < sides; k++) {
      const k1 = (k + 1) % sides;
      B.tri(rows[i][k], rows[i][k1], rows[i + 1][k], { out: mid });
      B.tri(rows[i][k1], rows[i + 1][k1], rows[i + 1][k], { out: mid });
    }
  }
  const cap = (i, sign) => {
    const T = fa[i].T;
    const tip = add3(ptsA[i], scl3(T, sign * 0.35 * (Array.isArray(r[i]) ? r[i][0] : r[i])));
    const tipB = add3(pb[i], scl3(fb[i].T, sign * 0.35 * (Array.isArray(r[i]) ? r[i][0] : r[i])));
    const t = i / Math.max(1, n - 1);
    const c = B.vert(tip, tipB, part, f(t), color(t, 1, 0), piv);
    const dir = scl3(T, sign);
    for (let k = 0; k < sides; k++) B.tri(rows[i][k], rows[i][(k + 1) % sides], c, { dir });
  };
  if (capEnd) cap(n - 1, 1);
  if (capStart) cap(0, -1);
  return rows;
}

// Two-layer flat quad strip (ears, crests, tail fans): edges L[i] and R[i] in both poses; the top
// layer faces `up`, the bottom layer the other way, 2 mm apart. color(t, top) -> rgb.
function leaf(B, LA, RA, LB, RB, { part, color, up, upB = null, f = (t) => t, piv = null, gap = 0.002 }) {
  const n = LA.length;
  const nu = norm3(up);
  const nuB = norm3(upB || up);
  for (const layer of [1, -1]) {
    const top = layer > 0;
    const off = scl3(nu, layer * gap * 0.5);
    const offB = scl3(nuB, layer * gap * 0.5);
    const rowL = [];
    const rowR = [];
    for (let i = 0; i < n; i++) {
      const t = n > 1 ? i / (n - 1) : 0;
      rowL.push(B.vert(add3(LA[i], off), add3(LB[i], offB), part, f(t), color(t, top), piv));
      rowR.push(B.vert(add3(RA[i], off), add3(RB[i], offB), part, f(t), color(t, top), piv));
    }
    const dir = scl3(nu, layer);
    for (let i = 0; i < n - 1; i++) {
      B.tri(rowL[i], rowR[i], rowL[i + 1], { dir });
      if (Math.hypot(...sub3(RA[i + 1], LA[i + 1])) > 1e-6) B.tri(rowR[i], rowR[i + 1], rowL[i + 1], { dir });
    }
  }
}

// ------------------------------------------------------------------ mammals
// spec: body [[x, zTop, zBottom, halfWidth]...] rump -> chest, exp (section shape), sides;
// neck {pts [[x,z]...], r}; head {pitch (deg, + up), len, w[], h[], base [x,z]}; ears {root
// [x,y,z], dir [x,y,z], len, w}; legs {front|hind: {pts [[x,z]...], y, r[]}} or sprawl legs;
// tail {pts, r, part}; horns [{pts [[x,y,z]...], r[]}] (mirrored to both sides); alt [[parts],
// [px, pz], deg] pose-B rotations; paint(region, info) -> rgb.
function mammal(spec) {
  const B = new Builder();
  const paint = spec.paint;
  const altOps = spec.alt || [];
  // Pose B (alert) of a point of a part: the listed rotations in order.
  // A pivot written {at: [x, z]} is that point carried through the rotations before it (a joint
  // that the earlier rotations moved: the neck base of a rabbit sitting up).
  const ops = [];
  for (const [parts, pv, deg] of altOps) {
    let q = Array.isArray(pv) ? [pv[0], 0, pv[1]] : [pv.at[0], 0, pv.at[1]];
    if (!Array.isArray(pv)) for (const o of ops) if (o.parts.includes(pv.of || PART.HEAD)) q = pitchAbout(q, o.px, o.pz, o.deg);
    ops.push({ parts, px: q[0], pz: q[2], deg });
  }
  const alt = (p, part) => {
    let q = p;
    for (const o of ops) if (o.parts.includes(part)) q = pitchAbout(q, o.px, o.pz, o.deg);
    return q;
  };
  const sprawl = spec.kind === KIND.SPRAWLER;
  // ---- body loft
  const rings = spec.body;
  const S = spec.sides || 8;
  const e = spec.exp || 2.2;
  const rows = [];
  rings.forEach(([x, zt, zb, hw], i) => {
    const t = i / (rings.length - 1);
    const zc = (zt + zb) / 2;
    const hh = (zt - zb) / 2;
    const row = [];
    for (let k = 0; k < S; k++) {
      const th = (k / S) * Math.PI * 2;
      const [c, s] = se(th, e);
      // th = 0 on top, going round through the right (-y).
      const wob = spec.wool ? 1 + spec.wool * (h01(i * 31 + k * 7) - 0.5) : 1;
      const p = [x, -s * hw * wob, zc + c * hh * wob];
      row.push(B.vert(p, alt(p, PART.BODY), PART.BODY, sprawl ? t : 0, paint('body', { t, up: Math.cos(th), side: Math.sin(th), p }), null));
    }
    rows.push(row);
  });
  for (let i = 0; i < rings.length - 1; i++) {
    const out = [(rings[i][0] + rings[i + 1][0]) / 2, 0, (rings[i][1] + rings[i][2] + rings[i + 1][1] + rings[i + 1][2]) / 4];
    for (let k = 0; k < S; k++) {
      const k1 = (k + 1) % S;
      B.tri(rows[i][k], rows[i][k1], rows[i + 1][k], { out });
      B.tri(rows[i][k1], rows[i + 1][k1], rows[i + 1][k], { out });
    }
  }
  for (const [i, sign] of [[0, -1], [rings.length - 1, 1]]) {
    const [x, zt, zb] = rings[i];
    const p = [x + sign * 0.012, 0, (zt + zb) / 2];
    const c = B.vert(p, alt(p, PART.BODY), PART.BODY, 0, paint('body', { t: i ? 1 : 0, up: 0, side: 0, p }));
    for (let k = 0; k < S; k++) B.tri(rows[i][k], rows[i][(k + 1) % S], c, { dir: [sign, 0, 0] });
  }
  // ---- neck (anim weight 0 at its base -> 0.85 at the head) and head (1)
  const nk = spec.neck;
  if (nk) {
    const pts = nk.pts.map(([x, z]) => [x, 0, z]);
    tube(B, pts, pts.map((p) => alt(p, PART.HEAD)), nk.r, 6, {
      part: PART.HEAD, f: (t) => 0.85 * t, color: (t, up) => paint('neck', { t, up }),
    });
  }
  const hd = spec.head;
  const hdir = [Math.cos(hd.pitch * DEG), 0, Math.sin(hd.pitch * DEG)];
  const hpts = hd.w.map((_, i) => {
    const t = i / (hd.w.length - 1);
    return [hd.base[0] + hdir[0] * hd.len * t, 0, hd.base[1] + hdir[2] * hd.len * t];
  });
  // (The head's own pivot, its base: it counter-turns there while the neck goes down to graze.)
  const headPiv = [hd.base[0], 0, hd.base[1]];
  tube(B, hpts, hpts.map((p) => alt(p, PART.HEAD)), hd.w.map((w, i) => [w, hd.h[i]]), 6, {
    part: PART.HEAD, f: () => 1, color: (t, up, side) => paint('head', { t, up, side }), capEnd: true, capStart: true, piv: headPiv,
  });
  // ---- ears (two-layer leaves; their own flick about the root, then the head's motion)
  if (spec.ears) {
    const E = spec.ears;
    for (const side of [1, -1]) {
      const root = [E.root[0], E.root[1] * side, E.root[2]];
      const d = norm3([E.dir[0], E.dir[1] * side, E.dir[2]]);
      // The ear's open (pale) side faces forward and out (about 45 deg, as real ears turn), so the
      // ear reads broad from the side as well as from the front.
      const fo = [1, side * 0.9, 0];
      let front = sub3(fo, scl3(d, dot3(d, fo)));
      if (Math.hypot(...front) < 0.2) front = [0, 0, 1];
      front = norm3(front);
      const w = norm3(cross3(d, front));
      const L = [];
      const R = [];
      for (const [t, wf] of [[0, 0.55], [0.45, 1], [1, 0.05]]) {
        const c = add3(root, scl3(d, E.len * t));
        L.push(add3(c, scl3(w, E.w * 0.5 * wf)));
        R.push(add3(c, scl3(w, -E.w * 0.5 * wf)));
      }
      // Alert: the ears also turn up about their own root (spec.earAlt, deg).
      const rootB = alt(root, PART.EAR);
      const earB = (p) => {
        const q = alt(p, PART.EAR);
        return spec.earAlt ? pitchAbout(q, rootB[0], rootB[2], spec.earAlt) : q;
      };
      leaf(B, L, R, L.map(earB), R.map(earB), {
        part: PART.EAR, up: front, color: (t, top) => paint('ear', { t, inner: top }), f: () => 1, piv: root,
      });
    }
  }
  // ---- horns / antlers (rigid with the head)
  for (const hn of spec.horns || []) {
    for (const side of [1, -1]) {
      const pts = hn.pts.map(([x, y, z]) => [x, y * side, z]);
      tube(B, pts, pts.map((p) => alt(p, PART.HEAD)), hn.r, hn.sides || 3, {
        part: PART.HEAD, f: () => 1, color: (t) => paint(hn.region || 'horn', { t }), capEnd: true, piv: headPiv,
      });
    }
  }
  // ---- legs
  if (sprawl) {
    const parts = [PART.SPRAWL_FL, PART.SPRAWL_FR, PART.SPRAWL_HL, PART.SPRAWL_HR];
    [spec.legs.front, spec.legs.front, spec.legs.hind, spec.legs.hind].forEach((lg, k) => {
      const side = k % 2 === 0 ? 1 : -1;
      const pts = lg.pts.map(([x, y, z]) => [x, y * side, z]);
      const ptsB = pts.map((p) => alt(p, parts[k]));
      tube(B, pts, ptsB, lg.r, 4, {
        part: parts[k], f: (t) => t, color: (t) => paint('leg', { t }), piv: pts[0], frameUp: [1, 0, 0],
      });
    });
  } else {
    const parts = [PART.LEG_FL, PART.LEG_FR, PART.LEG_HL, PART.LEG_HR];
    [spec.legs.front, spec.legs.front, spec.legs.hind, spec.legs.hind].forEach((lg, k) => {
      const side = k % 2 === 0 ? 1 : -1;
      const pts = lg.pts.map(([x, z]) => [x, lg.y * side, z]);
      const ptsB = pts.map((p) => alt(p, parts[k]));
      tube(B, pts, ptsB, lg.r, 4, {
        part: parts[k], f: (t) => t, color: (t) => paint('leg', { t, hind: k > 1 }), piv: pts[0], frameUp: [1, 0, 0],
      });
    });
  }
  // ---- tail
  if (spec.tail) {
    const tl = spec.tail;
    const pts = tl.pts.map(([x, z]) => [x, 0, z]);
    const part = sprawl ? PART.SPRAWL_TAIL : PART.TAIL;
    tube(B, pts, pts.map((p) => alt(p, part)), tl.r, tl.sides || 5, {
      part, f: (t) => t, color: (t, up) => paint('tail', { t, up }), capEnd: true, piv: pts[0],
    });
  }
  return B.build();
}

// ------------------------------------------------------------------ birds
// spec: bl, bw, bh (body length, half width, half height), hb (body centre height standing), tilt
// (deg, rest pose nose up), neckA / neckB [[x,z]...] (flight / rest), neckR, head {len, w, h,
// pitchA, pitchB}, bill {len, w, h, droop, bend}, crest {len, w, pitch}, wing {span (one wing),
// root, wrist, tip (chords), sweep, fingers}, foldLen, tail {len, w, fork, cockB}, legs {len, r,
// gap, trail}, paint(region, info) -> rgb.
function bird(spec) {
  const B = new Builder();
  const paint = spec.paint;
  const { bl, bw, bh, hb } = spec;
  const hipX = -0.06 * bl;
  const hipZ = hb - 0.45 * bh;
  // Rest pose of the body, folded wings and tail: tilted nose-up about the hip.
  const tiltB = (p) => (spec.tilt ? pitchAbout(p, hipX, hipZ, spec.tilt) : p);
  // ---- body loft (x from -bl/2 at the tail base to +bl/2 at the breast)
  const prof = spec.prof || [
    [-0.5, 0.32, 0.35, 0.22], [-0.33, 0.72, 0.78, 0.06], [-0.12, 0.95, 1.0, 0], [0.1, 1.0, 1.0, 0], [0.3, 0.88, 0.86, 0.06], [0.47, 0.5, 0.5, 0.3],
  ];
  const S = 8;
  const rows = [];
  const ringAt = (x) => {
    // half width, half height and centre z of the body at x (for the folded wings).
    const u = x / bl;
    for (let i = 0; i < prof.length - 1; i++) {
      if (u <= prof[i + 1][0] || i === prof.length - 2) {
        const t = Math.min(1, Math.max(0, (u - prof[i][0]) / (prof[i + 1][0] - prof[i][0])));
        const a = prof[i];
        const b = prof[i + 1];
        return { hh: bh * (a[1] + (b[1] - a[1]) * t), hw: bw * (a[2] + (b[2] - a[2]) * t), zc: hb + bh * (a[3] + (b[3] - a[3]) * t) };
      }
    }
    return { hh: bh, hw: bw, zc: hb };
  };
  prof.forEach(([u, fh, fw, dz], i) => {
    const t = i / (prof.length - 1);
    const x = u * bl;
    const zc = hb + dz * bh;
    const row = [];
    for (let k = 0; k < S; k++) {
      const th = (k / S) * Math.PI * 2;
      const c = Math.cos(th);
      const s = Math.sin(th);
      const p = [x, -s * bw * fw, zc + c * bh * fh];
      row.push(B.vert(p, tiltB(p), PART.BODY, 0, paint('body', { t, up: c, side: s, p })));
    }
    rows.push(row);
  });
  for (let i = 0; i < prof.length - 1; i++) {
    const out = [(prof[i][0] + prof[i + 1][0]) * 0.5 * bl, 0, hb + (prof[i][3] + prof[i + 1][3]) * 0.5 * bh];
    for (let k = 0; k < S; k++) {
      const k1 = (k + 1) % S;
      B.tri(rows[i][k], rows[i][k1], rows[i + 1][k], { out });
      B.tri(rows[i][k1], rows[i + 1][k1], rows[i + 1][k], { out });
    }
  }
  for (const [i, sign] of [[0, -1], [prof.length - 1, 1]]) {
    const p = [prof[i][0] * bl + sign * 0.01 * bl, 0, hb + prof[i][3] * bh];
    const c = B.vert(p, tiltB(p), PART.BODY, 0, paint('body', { t: i ? 1 : 0, up: 0, side: 0, p }));
    for (let k = 0; k < S; k++) B.tri(rows[i][k], rows[i][(k + 1) % S], c, { dir: [sign, 0, 0] });
  }
  // ---- neck, head, bill, crest (part HEAD; weights grow toward the head)
  const nA = spec.neckA.map(([x, z]) => [x, 0, z]);
  const nB = spec.neckB.map(([x, z]) => [x, 0, z]);
  tube(B, nA, nB, spec.neckR, 6, { part: PART.HEAD, f: (t) => 0.2 + 0.7 * t, color: (t, up) => paint('neck', { t, up }) });
  const hd = spec.head;
  const headAt = (neck, pitch) => {
    const end = neck[neck.length - 1];
    const d = [Math.cos(pitch * DEG), 0, Math.sin(pitch * DEG)];
    return { c: end, d };
  };
  const HA = headAt(nA, hd.pitchA);
  const HB = headAt(nB, hd.pitchB);
  const hTs = [-0.5, -0.15, 0.25, 0.5];
  const hW = [0.55, 1, 0.85, 0.45];
  const hp = (H) => hTs.map((t) => add3(H.c, scl3(H.d, t * hd.len)));
  const headPiv = HB.c;
  tube(B, hp(HA), hp(HB), hW.map((w) => [w * hd.w, w * hd.h]), 6, {
    part: PART.HEAD, f: () => 1, color: (t, up, side) => paint('head', { t, up, side }), capStart: true, capEnd: true, piv: headPiv,
  });
  // Bill: from the front of the head, drooping (and bent half way for a flamingo).
  const bi = spec.bill;
  const billPts = (H) => {
    const base = add3(H.c, scl3(H.d, 0.42 * hd.len));
    const a0 = Math.atan2(H.d[2], H.d[0]) - (bi.droop || 0) * DEG;
    const pts = [base];
    let p = base;
    const n = bi.bend ? 3 : 2;
    for (let k = 1; k <= n; k++) {
      const a = a0 - (bi.bend && k > 1 ? bi.bend * DEG : 0);
      p = add3(p, [Math.cos(a) * bi.len / n, 0, Math.sin(a) * bi.len / n]);
      pts.push(p);
    }
    return pts;
  };
  const bA = billPts(HA);
  const bB = billPts(HB);
  const bR = bA.map((_, i) => {
    const t = i / (bA.length - 1);
    return [bi.w * (1 - 0.75 * t) + 0.001, bi.h * (1 - 0.7 * t) + (bi.pouch ? bi.pouch * Math.sin(Math.PI * Math.min(1, t * 1.3)) : 0) + 0.001];
  });
  tube(B, bA, bB, bR, 4, { part: PART.HEAD, f: () => 1, color: (t) => paint('bill', { t }), capEnd: true, piv: headPiv });
  if (spec.crest) {
    // A plume or crest: a leaf from the crown, sweeping back (roadrunner, quail topknot, heron).
    const cr = spec.crest;
    const mk = (H) => {
      const root = add3(H.c, add3(scl3(H.d, (cr.at == null ? -0.1 : cr.at) * hd.len), [0, 0, hd.h * 0.8]));
      const a = Math.atan2(H.d[2], H.d[0]) + cr.pitch * DEG;
      const d = [Math.cos(a), 0, Math.sin(a)];
      const L = [root, add3(root, scl3(d, cr.len * 0.5)), add3(root, scl3(d, cr.len))];
      const R = [add3(root, [0, 0, -0.004]), add3(L[1], [0, 0, -cr.w]), add3(L[2], [0, 0, -cr.w * 0.2])];
      return { L, R };
    };
    const A = mk(HA);
    const Bc = mk(HB);
    leaf(B, A.L, A.R, Bc.L, Bc.R, { part: PART.HEAD, up: [0, 1, 0], f: () => 1, color: (t) => paint('crest', { t }), piv: headPiv });
  }
  // ---- wings: spread in pose A, folded along the flanks in pose B
  const wg = spec.wing;
  const sh = [0.16 * bl, bw * 0.7, hb + bh * 0.55];
  const span = wg.span;
  const stations = [
    // [u (span fraction), LE x offset, chord]
    [0, 0.2 * wg.root, wg.root],
    [0.4, 0.22 * wg.root, (wg.root + wg.wrist) / 2],
    [0.62, 0.28 * wg.root - 0.25 * wg.sweep, wg.wrist],
    [1, -wg.sweep, wg.tip],
  ];
  const foldLen = spec.foldLen || bl * 0.8;
  const fold = (u, v, side) => {
    // Folded: span runs back along the flank, the leading edge low and the trailing edge on the
    // back (this keeps the wing's upper side facing out), tilted with the body.
    const x = sh[0] + 0.02 * bl - Math.min(1.15, u) * foldLen;
    const r = ringAt(Math.max(-0.5 * bl, x));
    const hw = x < -0.5 * bl ? r.hw * 0.4 + 0.004 : r.hw;
    const z = r.zc + r.hh * (0.05 + 0.75 * v) * (1 - 0.25 * Math.min(1, u)) + (x < -0.5 * bl ? 0.25 * r.hh : 0);
    return tiltB([x, side * (hw * 0.98 + 0.004), z]);
  };
  for (const side of [1, -1]) {
    const part = side > 0 ? PART.WING_L : PART.WING_R;
    const piv = [sh[0], sh[1] * side, sh[2]];
    // Spread planform for one layer: leading edge, mid chord (cambered) and trailing edge rows.
    const pt = (u, v) => {
      const st = stations;
      let i = 0;
      while (i < st.length - 2 && u > st[i + 1][0]) i++;
      const t = (u - st[i][0]) / (st[i + 1][0] - st[i][0]);
      const le = st[i][1] + (st[i + 1][1] - st[i][1]) * t;
      const ch = st[i][2] + (st[i + 1][2] - st[i][2]) * t;
      const camber = 0.06 * ch * Math.sin(Math.PI * v) * (1 - 0.5 * u);
      return [sh[0] + le - v * ch, side * (sh[1] + u * span), sh[2] + camber];
    };
    const us = [0, 0.2, 0.4, 0.62, 0.82, 1];
    for (const layer of [1, -1]) {
      const top = layer > 0;
      const rowsW = [];
      for (const u of us) {
        const row = [];
        for (const v of [0, 0.45, 1]) {
          const A = add3(pt(u, v), [0, 0, layer * 0.0015]);
          const Bp = add3(fold(u, v, side), [0, side * layer * 0.0015, 0]);
          row.push(B.vert(A, Bp, part, u, paint('wing', { u, v, top, side }), piv));
        }
        rowsW.push(row);
      }
      const dir = [0, 0, layer];
      for (let i = 0; i < us.length - 1; i++) {
        for (let k = 0; k < 2; k++) {
          B.tri(rowsW[i][k], rowsW[i + 1][k], rowsW[i][k + 1], { dir });
          B.tri(rowsW[i + 1][k], rowsW[i + 1][k + 1], rowsW[i][k + 1], { dir });
        }
      }
      // Fingered tips (hawk, heron, pelican): slotted primaries beyond the tip.
      for (let k = 0; k < (wg.fingers || 0); k++) {
        const v0 = 0.02 + (k / wg.fingers) * 0.96;
        const v1 = v0 + 0.85 / wg.fingers;
        const u0 = 0.97;
        const a = pt(u0, v0);
        const b = pt(u0, v1);
        const tipU = 1.1 + 0.035 * Math.sin((k / Math.max(1, wg.fingers - 1)) * Math.PI);
        const tp = pt(1, (v0 + v1) / 2);
        const tip = [tp[0] - (k - (wg.fingers - 1) / 2) * 0.05 * span * 0.5, side * (sh[1] + tipU * span), sh[2]];
        const ia = B.vert(add3(a, [0, 0, layer * 0.0015]), fold(u0, v0, side), part, u0, paint('wing', { u: 1, v: v0, top, side, finger: true }), piv);
        const ib = B.vert(add3(b, [0, 0, layer * 0.0015]), fold(u0, v1, side), part, u0, paint('wing', { u: 1, v: v1, top, side, finger: true }), piv);
        const ic = B.vert(add3(tip, [0, 0, layer * 0.0015]), fold(1.12, (v0 + v1) / 2, side), part, 1, paint('wing', { u: 1.1, v: (v0 + v1) / 2, top, side, finger: true }), piv);
        B.tri(ia, ib, ic, { dir });
      }
    }
  }
  // ---- tail fan (two layers)
  const tl = spec.tail;
  {
    const base = [-0.47 * bl, 0, hb + bh * 0.22];
    const piv = base;
    const fork = tl.fork || 0;
    const L = [add3(base, [0, tl.w * 0.35, 0]), add3(base, [-tl.len * 0.55, tl.w * 0.8, 0]), add3(base, [-tl.len * (1 + fork * 0.15), tl.w, 0])];
    const R = [add3(base, [0, -tl.w * 0.35, 0]), add3(base, [-tl.len * 0.55, -tl.w * 0.8, 0]), add3(base, [-tl.len * (1 + fork * 0.15), -tl.w, 0])];
    // Middle spine row to give the fan its centre tip (a fork pulls it in).
    const M = [base, add3(base, [-tl.len * 0.55, 0, 0]), add3(base, [-tl.len * (1 - fork * 0.2), 0, 0])];
    const cock = (p) => tiltB(pitchAbout(p, base[0], base[2], -(tl.cockB || 0)));
    const droopA = (p) => pitchAbout(p, base[0], base[2], -(tl.cockA || 0));
    for (const [Ls, Rs] of [[L, M], [M, R]]) {
      leaf(B, Ls.map(droopA), Rs.map(droopA), Ls.map(cock), Rs.map(cock), {
        part: PART.TAIL, up: [0, 0, 1], f: (t) => t, color: (t, top) => paint('tail', { t, top }), piv,
      });
    }
  }
  // ---- legs: down to the ground at rest; tucked under the belly or trailing in flight
  const lg = spec.legs;
  for (const side of [1, -1]) {
    const part = side > 0 ? PART.LEG_FL : PART.LEG_FR;
    const y = lg.gap * side;
    const hip = [hipX, y, hipZ];
    const knee = [hipX - 0.04 * bl, y, Math.min(hipZ - 0.02, lg.len * 0.5)];
    const foot = [hipX + 0.01 * bl, y, 0.004];
    const ptsB = [hip, knee, foot];
    const ptsA = ptsB.map((p) => {
      // Flight: legs rotated back about the hip (trailing straight back for waders).
      const q = pitchAbout(p, hip[0], hip[2], lg.trail ? -95 : -80);
      if (lg.trail) return q;
      return add3(hip, scl3(sub3(q, hip), 0.45));
    });
    tube(B, ptsA, ptsB, [lg.r * 1.3, lg.r, lg.r * 0.9], 3, {
      part, f: (t) => t, color: (t) => paint('leg', { t }), piv: hip, frameUp: [1, 0, 0],
    });
    if (lg.toes) {
      // Toes: a flat two-layer foot on the ground (waders, gulls, ducks' webbed feet).
      const fl = lg.toes;
      const Lp = [add3(foot, [-0.01, fl * 0.15, 0.002]), add3(foot, [fl, fl * 0.45, 0.002])];
      const Rp = [add3(foot, [-0.01, -fl * 0.15, 0.002]), add3(foot, [fl, -fl * 0.45, 0.002])];
      const fA = (p) => {
        const q = pitchAbout(p, hip[0], hip[2], lg.trail ? -95 : -80);
        return lg.trail ? q : add3(hip, scl3(sub3(q, hip), 0.45));
      };
      leaf(B, Lp.map(fA), Rp.map(fA), Lp, Rp, { part, up: [0, 0, 1], f: () => 1, color: () => paint('leg', { t: 1 }), piv: hip });
    }
  }
  return B.build();
}

// ------------------------------------------------------------------ colours (sRGB 0..255)
const C = (r, g, b) => [r, g, b];
// Fur and feather shading: darker on the back, the belly colour below `cut` (up = -1 bottom).
const twoTone = (top, belly, up, cut = -0.45, soft = 0.3) => mix3(top, belly, sm(cut + soft, cut - soft, up));

// ------------------------------------------------------------------ species
const SPECS = {
  // White-tailed deer (doe): reddish-brown summer coat, white belly, throat, muzzle band and the
  // underside of the tail, black nose and hooves.
  doe: () => deer(false),
  buck: () => deer(true),
  squirrel: () => mammal({
    kind: KIND.BOUNDER,
    body: [[-0.11, 0.115, 0.045, 0.03], [-0.085, 0.145, 0.03, 0.05], [-0.04, 0.15, 0.03, 0.05], [0.02, 0.14, 0.04, 0.042], [0.07, 0.13, 0.055, 0.035], [0.1, 0.12, 0.07, 0.022]],
    neck: { pts: [[0.075, 0.105], [0.1, 0.125], [0.115, 0.135]], r: [0.03, 0.026, 0.024] },
    head: { base: [0.105, 0.14], pitch: -12, len: 0.065, w: [0.022, 0.024, 0.016, 0.008], h: [0.022, 0.024, 0.016, 0.009] },
    ears: { root: [0.11, 0.014, 0.158], dir: [-0.2, 0.3, 1], len: 0.02, w: 0.014 },
    legs: {
      front: { y: 0.022, pts: [[0.07, 0.075], [0.08, 0.02], [0.088, 0]], r: [0.012, 0.007, 0.007] },
      hind: { y: 0.035, pts: [[-0.06, 0.09], [-0.09, 0.03], [-0.04, 0.0]], r: [0.022, 0.009, 0.008] },
    },
    tail: { pts: [[-0.105, 0.075], [-0.16, 0.11], [-0.18, 0.2], [-0.15, 0.27], [-0.1, 0.285]], r: [0.022, 0.04, 0.048, 0.042, 0.018], sides: 6 },
    alt: [[[PART.BODY, PART.HEAD, PART.EAR, PART.LEG_FL, PART.LEG_FR], [-0.07, 0.03], 55], [[PART.HEAD, PART.EAR], { at: [0.075, 0.105] }, -45], [[PART.LEG_FL, PART.LEG_FR], { at: [0.07, 0.075], of: PART.LEG_FL }, -35]],
    paint: (r, i) => {
      const grey = C(128, 123, 116);
      const brown = C(146, 120, 92);
      const belly = C(222, 218, 208);
      if (r === 'body') return twoTone(mix3(grey, brown, 0.35 + 0.3 * Math.abs(i.side)), belly, i.up);
      if (r === 'neck') return twoTone(grey, belly, i.up);
      if (r === 'head') return i.t > 0.9 ? C(70, 60, 55) : twoTone(mix3(grey, brown, 0.3), belly, i.up, -0.3);
      if (r === 'ear') return i.inner ? C(160, 130, 115) : grey;
      if (r === 'leg') return mix3(brown, C(110, 100, 90), i.t);
      if (r === 'tail') return mix3(C(118, 112, 104), C(180, 176, 168), sm(0.3, -0.6, i.up) * 0.6);
      return grey;
    },
  }),
  mallardDrake: () => duck(true),
  mallardHen: () => duck(false),
  goose: () => bird({
    bl: 0.62, bw: 0.15, bh: 0.13, hb: 0.3, tilt: 6,
    neckA: [[0.27, 0.36], [0.4, 0.38], [0.53, 0.385], [0.6, 0.385]],
    neckB: [[0.26, 0.37], [0.31, 0.5], [0.33, 0.62], [0.35, 0.71]],
    neckR: [0.06, 0.038, 0.034, 0.033],
    head: { len: 0.11, w: 0.034, h: 0.042, pitchA: -4, pitchB: -6 },
    bill: { len: 0.055, w: 0.017, h: 0.016, droop: 6 },
    wing: { span: 0.76, root: 0.26, wrist: 0.25, tip: 0.07, sweep: 0.14 },
    foldLen: 0.48,
    tail: { len: 0.13, w: 0.07, cockA: -4, cockB: 4 },
    legs: { len: 0.17, r: 0.012, gap: 0.06, toes: 0.06 },
    paint: (r, i) => {
      const body = C(118, 104, 86);
      const breast = C(204, 194, 174);
      if (r === 'body') {
        if (i.t < 0.18) return C(236, 234, 228); // white undertail
        return mix3(twoTone(body, breast, i.up, -0.1, 0.5), breast, sm(0.55, 0.95, i.t) * 0.7);
      }
      if (r === 'neck') return i.t < 0.08 ? C(150, 140, 120) : C(22, 22, 22);
      if (r === 'head') return i.up < -0.2 && i.t > 0.15 && i.t < 0.75 ? C(236, 234, 228) : C(22, 22, 22); // chinstrap
      if (r === 'bill') return C(28, 28, 28);
      if (r === 'wing') return i.top ? (i.u > 0.62 ? C(70, 62, 55) : mix3(C(112, 98, 82), C(140, 128, 110), (1 - i.v) * 0.4)) : C(118, 112, 104);
      if (r === 'tail') return i.t < 0.25 ? C(236, 234, 228) : C(26, 26, 26);
      if (r === 'leg') return C(30, 30, 30);
      return body;
    },
  }),
  songbird: () => bird({
    bl: 0.1, bw: 0.028, bh: 0.03, hb: 0.055, tilt: 14,
    neckA: [[0.035, 0.068], [0.05, 0.072]], neckB: [[0.035, 0.07], [0.048, 0.08]], neckR: [0.022, 0.02],
    head: { len: 0.036, w: 0.02, h: 0.02, pitchA: 0, pitchB: 5 },
    bill: { len: 0.012, w: 0.007, h: 0.007, droop: 4 },
    wing: { span: 0.1, root: 0.06, wrist: 0.055, tip: 0.02, sweep: 0.02 },
    foldLen: 0.085,
    tail: { len: 0.055, w: 0.022, cockB: 12, fork: 0.5 },
    legs: { len: 0.025, r: 0.003, gap: 0.012 },
    paint: (r, i) => {
      const back = C(128, 98, 68);
      const under = C(196, 184, 160);
      if (r === 'body') return twoTone(mix3(back, C(98, 74, 52), h01(i.t * 13 + i.side * 5) * 0.5), under, i.up, -0.2, 0.4);
      if (r === 'neck') return twoTone(C(120, 100, 80), C(200, 196, 186), i.up);
      if (r === 'head') return i.up > 0.3 ? C(112, 96, 82) : i.up < -0.3 ? C(60, 52, 46) : C(150, 132, 112);
      if (r === 'bill') return C(70, 62, 55);
      if (r === 'wing') return i.top ? mix3(C(116, 86, 58), C(64, 50, 40), sm(0.55, 0.95, i.u)) : C(170, 160, 145);
      if (r === 'tail') return C(90, 72, 56);
      if (r === 'leg') return C(150, 120, 100);
      return back;
    },
  }),
  heron: () => wader({
    bl: 0.42, bw: 0.095, bh: 0.1, hb: 0.52, tilt: 28,
    neckA: [[0.15, 0.57], [0.19, 0.62], [0.18, 0.66], [0.2, 0.685], [0.25, 0.69], [0.3, 0.675]],
    neckB: [[0.15, 0.6], [0.21, 0.68], [0.235, 0.76], [0.245, 0.84], [0.28, 0.905], [0.33, 0.93]],
    neckR: [0.05, 0.036, 0.031, 0.028, 0.027, 0.026],
    head: { len: 0.09, w: 0.024, h: 0.028, pitchA: -6, pitchB: -10 },
    bill: { len: 0.12, w: 0.011, h: 0.014, droop: 2 },
    crest: { len: 0.1, w: 0.008, pitch: 170, at: -0.2 },
    wing: { span: 0.86, root: 0.33, wrist: 0.32, tip: 0.2, sweep: 0.05, fingers: 5 },
    foldLen: 0.42,
    tail: { len: 0.1, w: 0.07, cockA: -6, cockB: -20 },
    legs: { len: 0.44, r: 0.009, gap: 0.04, trail: true, toes: 0.08 },
    colors: { body: C(142, 146, 150), under: C(196, 198, 200), neck: C(226, 226, 222), head: C(232, 232, 228), crest: C(24, 24, 26), bill: C(214, 176, 66), wingIn: C(140, 145, 152), wingOut: C(52, 54, 62), wingBot: C(150, 154, 160), leg: C(150, 126, 84), stripe: C(30, 30, 34) },
  }),
  roadrunner: () => bird({
    bl: 0.2, bw: 0.05, bh: 0.055, hb: 0.2, tilt: -4,
    neckA: [[0.08, 0.22], [0.12, 0.235], [0.15, 0.24]], neckB: [[0.08, 0.22], [0.12, 0.25], [0.15, 0.27]], neckR: [0.03, 0.024, 0.023],
    head: { len: 0.055, w: 0.022, h: 0.026, pitchA: -4, pitchB: 0 },
    bill: { len: 0.05, w: 0.008, h: 0.01, droop: 6 },
    crest: { len: 0.045, w: 0.012, pitch: 150, at: 0.1 },
    wing: { span: 0.22, root: 0.11, wrist: 0.1, tip: 0.06, sweep: 0.01, fingers: 3 },
    foldLen: 0.17,
    tail: { len: 0.28, w: 0.035, cockA: 0, cockB: 28 },
    legs: { len: 0.14, r: 0.006, gap: 0.025, toes: 0.035 },
    paint: (r, i) => {
      const streak = (k) => (h01(k) > 0.5 ? C(72, 58, 44) : C(168, 146, 110));
      if (r === 'body') return i.up < -0.35 ? C(214, 202, 176) : mix3(C(116, 98, 74), streak(Math.floor(i.t * 7) * 3 + Math.floor(i.side * 3)), 0.45);
      if (r === 'neck') return i.up < -0.2 ? C(200, 186, 156) : C(120, 100, 76);
      if (r === 'head') return i.up > 0.4 ? C(60, 50, 40) : i.side > 0.6 && i.t > 0.4 ? C(70, 110, 160) : C(150, 128, 98);
      if (r === 'crest') return C(56, 46, 38);
      if (r === 'bill') return C(52, 46, 40);
      if (r === 'wing') return i.top ? mix3(C(110, 92, 70), C(54, 46, 40), sm(0.4, 0.9, i.u)) : C(150, 140, 120);
      if (r === 'tail') return i.t > 0.88 ? C(220, 214, 200) : C(66, 64, 60);
      if (r === 'leg') return C(110, 116, 128);
      return C(120, 100, 76);
    },
  }),
  hawk: () => bird({
    bl: 0.36, bw: 0.085, bh: 0.08, hb: 0.17, tilt: 30,
    neckA: [[0.13, 0.2], [0.17, 0.205], [0.2, 0.205]], neckB: [[0.13, 0.21], [0.16, 0.24], [0.18, 0.26]], neckR: [0.05, 0.042, 0.04],
    head: { len: 0.07, w: 0.034, h: 0.034, pitchA: -6, pitchB: -10 },
    bill: { len: 0.032, w: 0.01, h: 0.014, droop: 40 },
    wing: { span: 0.6, root: 0.3, wrist: 0.29, tip: 0.17, sweep: 0.03, fingers: 5 },
    foldLen: 0.3,
    tail: { len: 0.2, w: 0.09, cockA: 0, cockB: -15 },
    legs: { len: 0.09, r: 0.012, gap: 0.04 },
    paint: (r, i) => {
      const brown = C(98, 66, 44);
      const cream = C(232, 222, 202);
      if (r === 'body') return i.up < 0.2 ? (i.t > 0.35 && i.t < 0.6 && Math.abs(i.side) > 0.3 ? C(112, 78, 52) : cream) : brown;
      if (r === 'neck' || r === 'head') return i.up < -0.2 ? cream : brown;
      if (r === 'bill') return C(64, 66, 72);
      if (r === 'wing') {
        if (i.top) return mix3(brown, C(70, 50, 36), sm(0.6, 1, i.u));
        // Underwing: pale with a dark patagial bar, dark tips and a dark trailing edge.
        if (i.finger || i.u > 0.95) return C(58, 50, 46);
        if (i.v < 0.12 && i.u < 0.5) return C(88, 64, 46);
        return mix3(cream, C(150, 140, 130), sm(0.75, 1, i.v));
      }
      if (r === 'tail') return i.top ? C(182, 84, 46) : C(222, 186, 166);
      if (r === 'leg') return C(214, 188, 70);
      return brown;
    },
  }),
  quail: () => bird({
    bl: 0.17, bw: 0.055, bh: 0.055, hb: 0.095, tilt: 4,
    neckA: [[0.06, 0.12], [0.085, 0.125]], neckB: [[0.06, 0.12], [0.08, 0.14]], neckR: [0.035, 0.03],
    head: { len: 0.045, w: 0.024, h: 0.026, pitchA: 0, pitchB: 0 },
    bill: { len: 0.012, w: 0.008, h: 0.009, droop: 20 },
    crest: { len: 0.035, w: 0.012, pitch: 70, at: 0.15 },
    wing: { span: 0.15, root: 0.09, wrist: 0.085, tip: 0.04, sweep: 0.01 },
    foldLen: 0.13,
    tail: { len: 0.06, w: 0.03, cockB: -5 },
    legs: { len: 0.04, r: 0.005, gap: 0.02 },
    paint: (r, i) => {
      const grey = C(128, 128, 126);
      if (r === 'body') {
        if (i.up < -0.6 && i.t > 0.45 && i.t < 0.75) return C(40, 36, 32); // black belly patch
        if (i.up < -0.3) return C(220, 210, 180);
        if (Math.abs(i.side) > 0.7 && i.t < 0.75) return h01(Math.floor(i.t * 9)) > 0.5 ? C(150, 76, 42) : C(220, 212, 196);
        return grey;
      }
      if (r === 'neck') return grey;
      if (r === 'head') return i.up > 0.4 ? C(148, 70, 40) : i.side > 0.5 || i.up < -0.4 ? C(30, 28, 28) : C(220, 216, 206);
      if (r === 'crest') return C(30, 28, 28);
      if (r === 'bill') return C(30, 30, 30);
      if (r === 'wing') return i.top ? C(122, 118, 108) : C(170, 166, 158);
      if (r === 'tail') return C(110, 110, 108);
      if (r === 'leg') return C(110, 100, 90);
      return grey;
    },
  }),
  jackrabbit: () => hare({ s: 1, earLen: 0.15, earW: 0.055, coat: C(166, 146, 112), dark: C(124, 106, 80), tail: C(30, 28, 26), tips: C(26, 24, 22) }),
  rabbit: () => hare({ s: 0.72, earLen: 0.085, earW: 0.04, coat: C(134, 118, 96), dark: C(108, 94, 76), tail: C(236, 232, 224), tips: C(70, 60, 50), round: true }),
  coyote: () => mammal({
    kind: KIND.WALKER,
    body: [[-0.42, 0.55, 0.42, 0.05], [-0.38, 0.6, 0.37, 0.115], [-0.25, 0.6, 0.36, 0.125], [-0.05, 0.58, 0.39, 0.115], [0.14, 0.6, 0.35, 0.125], [0.29, 0.62, 0.33, 0.125], [0.39, 0.6, 0.37, 0.1], [0.44, 0.55, 0.43, 0.06]],
    neck: { pts: [[0.33, 0.54], [0.43, 0.62], [0.5, 0.68]], r: [0.085, 0.07, 0.06] },
    head: { base: [0.49, 0.7], pitch: -16, len: 0.25, w: [0.06, 0.058, 0.032, 0.015], h: [0.06, 0.052, 0.03, 0.017] },
    ears: { root: [0.5, 0.042, 0.75], dir: [-0.08, 0.3, 1], len: 0.1, w: 0.055 },
    legs: {
      front: { y: 0.07, pts: [[0.3, 0.45], [0.31, 0.15], [0.33, 0.0]], r: [0.042, 0.019, 0.02] },
      hind: { y: 0.075, pts: [[-0.3, 0.48], [-0.4, 0.2], [-0.36, 0.0]], r: [0.058, 0.02, 0.021] },
    },
    tail: { pts: [[-0.42, 0.52], [-0.54, 0.43], [-0.63, 0.31], [-0.67, 0.22]], r: [0.03, 0.058, 0.056, 0.03] },
    alt: [[[PART.HEAD, PART.EAR], [0.36, 0.56], 14], [[PART.TAIL], [-0.42, 0.52], 25]],
    paint: (r, i) => {
      const back = C(96, 86, 74);
      const side = C(128, 112, 92);
      const pale = C(196, 186, 168);
      if (r === 'body') return i.up > 0.6 ? back : twoTone(side, pale, i.up, -0.55);
      if (r === 'neck') return twoTone(C(140, 122, 98), pale, i.up, -0.3);
      if (r === 'head') return i.t > 0.92 ? C(30, 28, 26) : i.up < -0.3 && i.t > 0.5 ? pale : C(160, 126, 90);
      if (r === 'ear') return i.inner ? C(200, 180, 160) : C(150, 104, 66);
      if (r === 'leg') return mix3(C(168, 124, 82), C(140, 112, 86), i.t);
      if (r === 'tail') return i.t > 0.85 ? C(28, 26, 24) : twoTone(C(122, 108, 90), C(190, 176, 152), i.up);
      return side;
    },
  }),
  sheep: () => mammal({
    kind: KIND.WALKER,
    exp: 2.0,
    wool: 0.1,
    sides: 8,
    body: [[-0.52, 0.76, 0.42, 0.07], [-0.47, 0.85, 0.33, 0.2], [-0.32, 0.9, 0.3, 0.25], [-0.05, 0.9, 0.3, 0.26], [0.2, 0.9, 0.31, 0.25], [0.37, 0.88, 0.34, 0.22], [0.47, 0.82, 0.42, 0.15], [0.52, 0.74, 0.52, 0.08]],
    neck: { pts: [[0.42, 0.68], [0.54, 0.73], [0.61, 0.76]], r: [0.13, 0.09, 0.065] },
    head: { base: [0.6, 0.78], pitch: -52, len: 0.24, w: [0.055, 0.052, 0.04, 0.03], h: [0.07, 0.06, 0.045, 0.03] },
    ears: { root: [0.6, 0.055, 0.79], dir: [-0.25, 1, -0.25], len: 0.08, w: 0.035 },
    horns: [{ pts: [[0.62, 0.04, 0.85], [0.56, 0.1, 0.88], [0.52, 0.135, 0.82], [0.55, 0.13, 0.75], [0.6, 0.115, 0.77]], r: [0.024, 0.02, 0.016, 0.012, 0.007], sides: 3 }],
    legs: {
      front: { y: 0.1, pts: [[0.35, 0.42], [0.36, 0.15], [0.37, 0.0]], r: [0.04, 0.02, 0.019] },
      hind: { y: 0.11, pts: [[-0.38, 0.42], [-0.43, 0.22], [-0.4, 0.0]], r: [0.05, 0.021, 0.019] },
    },
    tail: { pts: [[-0.52, 0.7], [-0.56, 0.6], [-0.57, 0.52]], r: [0.04, 0.04, 0.025] },
    alt: [[[PART.HEAD, PART.EAR], [0.45, 0.7], 18]],
    paint: (r, i) => {
      const wool = C(206, 198, 178);
      const black = C(34, 31, 29);
      if (r === 'body') return mix3(wool, C(176, 166, 146), sm(-0.3, -0.9, i.up) * 0.6 + 0.15 * h01(i.t * 17 + i.side * 3));
      if (r === 'neck') return i.t > 0.7 ? black : wool;
      if (r === 'head') return i.t > 0.9 ? C(180, 172, 160) : black;
      if (r === 'ear') return black;
      if (r === 'horn') return mix3(C(176, 160, 124), C(120, 108, 86), i.t);
      if (r === 'leg') return i.t < 0.15 ? wool : black;
      if (r === 'tail') return wool;
      return wool;
    },
  }),
  lizard: () => mammal({
    // Chuckwalla on a rock: flat, dark head and shoulders, rusty hind body and a thick banded tail.
    kind: KIND.SPRAWLER,
    exp: 2.6,
    body: [[-0.1, 0.045, 0.006, 0.03], [-0.07, 0.055, 0.004, 0.05], [0.0, 0.058, 0.004, 0.055], [0.06, 0.055, 0.006, 0.048], [0.1, 0.05, 0.012, 0.032]],
    head: { base: [0.095, 0.035], pitch: -6, len: 0.07, w: [0.03, 0.032, 0.022, 0.01], h: [0.022, 0.022, 0.015, 0.008] },
    legs: {
      front: { pts: [[0.06, 0.035, 0.03], [0.07, 0.075, 0.02], [0.085, 0.085, 0.0]], r: [0.012, 0.009, 0.007] },
      hind: { pts: [[-0.07, 0.04, 0.03], [-0.075, 0.085, 0.02], [-0.06, 0.1, 0.0]], r: [0.015, 0.01, 0.008] },
    },
    tail: { pts: [[-0.095, 0.03], [-0.15, 0.022], [-0.22, 0.012], [-0.28, 0.006]], r: [[0.028, 0.02], [0.022, 0.016], [0.013, 0.01], [0.004, 0.004]], sides: 5 },
    alt: [[[PART.BODY, PART.HEAD], [-0.06, 0.02], 12]],
    paint: (r, i) => {
      if (r === 'body') return i.up < -0.4 ? C(140, 120, 96) : mix3(C(46, 44, 42), C(170, 92, 52), sm(0.75, 0.2, i.t));
      if (r === 'head') return C(42, 40, 38);
      if (r === 'leg') return C(52, 48, 44);
      if (r === 'tail') return Math.floor(i.t * 7) % 2 ? C(196, 176, 140) : C(150, 110, 70);
      return C(60, 56, 50);
    },
  }),
  iguana: () => mammal({
    // Green iguana sunning on the beach: banded tail, dewlap, grey-green with orange tints.
    kind: KIND.SPRAWLER,
    exp: 2.3,
    body: [[-0.2, 0.09, 0.02, 0.04], [-0.14, 0.115, 0.012, 0.07], [0.0, 0.125, 0.012, 0.075], [0.12, 0.12, 0.02, 0.065], [0.2, 0.11, 0.035, 0.045]],
    neck: { pts: [[0.17, 0.08], [0.22, 0.09], [0.25, 0.095]], r: [0.045, 0.04, 0.036] },
    head: { base: [0.24, 0.1], pitch: -10, len: 0.12, w: [0.035, 0.038, 0.028, 0.014], h: [0.045, 0.04, 0.026, 0.012] },
    legs: {
      front: { pts: [[0.13, 0.05, 0.06], [0.15, 0.13, 0.04], [0.17, 0.15, 0.0]], r: [0.022, 0.016, 0.01] },
      hind: { pts: [[-0.14, 0.055, 0.06], [-0.15, 0.15, 0.04], [-0.12, 0.18, 0.0]], r: [0.028, 0.018, 0.011] },
    },
    tail: { pts: [[-0.19, 0.06], [-0.35, 0.04], [-0.55, 0.022], [-0.78, 0.01], [-0.95, 0.005]], r: [[0.04, 0.04], [0.03, 0.03], [0.018, 0.018], [0.009, 0.009], [0.003, 0.003]], sides: 5 },
    alt: [[[PART.BODY, PART.HEAD], [-0.12, 0.04], 10]],
    paint: (r, i) => {
      const green = C(104, 128, 74);
      if (r === 'body') return i.up < -0.4 ? C(150, 150, 110) : mix3(green, C(150, 130, 80), sm(0.4, 0.0, i.t) * 0.5);
      if (r === 'neck') return i.up < -0.3 ? C(170, 140, 90) : green;
      if (r === 'head') return i.up < -0.4 ? C(160, 136, 90) : C(98, 120, 80);
      if (r === 'leg') return C(110, 120, 80);
      if (r === 'tail') return Math.floor(i.t * 9) % 2 ? C(54, 58, 44) : C(120, 136, 84);
      return green;
    },
  }),
  pelican: () => bird({
    bl: 0.7, bw: 0.16, bh: 0.15, hb: 0.28, tilt: 10,
    neckA: [[0.3, 0.34], [0.36, 0.42], [0.31, 0.48], [0.36, 0.52]],
    neckB: [[0.3, 0.36], [0.38, 0.47], [0.34, 0.58], [0.4, 0.64]],
    neckR: [0.07, 0.05, 0.045, 0.045],
    head: { len: 0.11, w: 0.045, h: 0.05, pitchA: -10, pitchB: -30 },
    bill: { len: 0.32, w: 0.03, h: 0.022, droop: 22, pouch: 0.03 },
    wing: { span: 1.0, root: 0.36, wrist: 0.34, tip: 0.18, sweep: 0.06, fingers: 5 },
    foldLen: 0.6,
    tail: { len: 0.14, w: 0.09, cockB: -6 },
    legs: { len: 0.13, r: 0.016, gap: 0.08, toes: 0.08 },
    paint: (r, i) => {
      const body = C(108, 104, 98);
      if (r === 'body') return twoTone(C(150, 148, 140), C(78, 72, 68), i.up, 0.1, 0.4);
      if (r === 'neck') return i.t > 0.6 ? C(236, 228, 196) : C(92, 60, 42);
      if (r === 'head') return C(238, 230, 200);
      if (r === 'bill') return mix3(C(140, 128, 110), C(200, 150, 100), i.t * 0.5);
      if (r === 'wing') {
        if (i.top) return i.u > 0.6 || i.finger ? C(44, 42, 40) : mix3(C(170, 168, 160), C(96, 92, 88), sm(0.6, 1, i.v));
        return i.u > 0.6 || i.finger ? C(50, 48, 46) : C(120, 116, 110);
      }
      if (r === 'tail') return C(90, 86, 82);
      if (r === 'leg') return C(50, 50, 48);
      return body;
    },
  }),
  flamingo: () => wader({
    bl: 0.42, bw: 0.12, bh: 0.12, hb: 0.86, tilt: 8,
    neckA: [[0.18, 0.88], [0.3, 0.885], [0.43, 0.89], [0.56, 0.9], [0.69, 0.9], [0.78, 0.9]],
    neckB: [[0.18, 0.93], [0.25, 1.01], [0.25, 1.1], [0.22, 1.18], [0.25, 1.26], [0.33, 1.3]],
    neckR: [0.042, 0.027, 0.023, 0.022, 0.022, 0.024],
    head: { len: 0.07, w: 0.025, h: 0.03, pitchA: -4, pitchB: -12 },
    bill: { len: 0.11, w: 0.016, h: 0.02, droop: 8, bend: 55 },
    wing: { span: 0.74, root: 0.26, wrist: 0.24, tip: 0.1, sweep: 0.08 },
    foldLen: 0.4,
    tail: { len: 0.09, w: 0.06, cockB: -8 },
    legs: { len: 0.74, r: 0.009, gap: 0.04, trail: true, toes: 0.07 },
    colors: { body: C(240, 132, 116), under: C(246, 160, 146), neck: C(244, 140, 124), head: C(246, 150, 134), bill: C(236, 196, 186), billTip: C(24, 22, 22), wingIn: C(236, 108, 96), wingOut: C(26, 22, 22), wingBot: C(232, 120, 108), leg: C(222, 118, 118) },
  }),
  egret: () => wader({
    bl: 0.36, bw: 0.08, bh: 0.085, hb: 0.5, tilt: 26,
    neckA: [[0.13, 0.54], [0.17, 0.59], [0.16, 0.63], [0.18, 0.655], [0.23, 0.66], [0.27, 0.65]],
    neckB: [[0.13, 0.57], [0.19, 0.66], [0.21, 0.75], [0.22, 0.84], [0.25, 0.92], [0.3, 0.95]],
    neckR: [0.042, 0.028, 0.023, 0.021, 0.02, 0.02],
    head: { len: 0.075, w: 0.02, h: 0.024, pitchA: -6, pitchB: -10 },
    bill: { len: 0.11, w: 0.009, h: 0.012, droop: 2 },
    wing: { span: 0.7, root: 0.28, wrist: 0.27, tip: 0.16, sweep: 0.04, fingers: 4 },
    foldLen: 0.36,
    tail: { len: 0.09, w: 0.06, cockA: -6, cockB: -20 },
    legs: { len: 0.42, r: 0.007, gap: 0.035, trail: true, toes: 0.07 },
    colors: { body: C(240, 240, 236), under: C(232, 232, 228), neck: C(242, 242, 238), head: C(242, 242, 238), bill: C(228, 192, 60), wingIn: C(242, 242, 238), wingOut: C(236, 236, 232), wingBot: C(226, 226, 222), leg: C(28, 28, 28) },
  }),
  parrot: () => bird({
    bl: 0.22, bw: 0.055, bh: 0.06, hb: 0.11, tilt: 40,
    neckA: [[0.09, 0.13], [0.12, 0.135]], neckB: [[0.08, 0.14], [0.1, 0.16]], neckR: [0.04, 0.036],
    head: { len: 0.06, w: 0.032, h: 0.034, pitchA: 0, pitchB: 0 },
    bill: { len: 0.026, w: 0.013, h: 0.018, droop: 45 },
    wing: { span: 0.3, root: 0.13, wrist: 0.12, tip: 0.05, sweep: 0.05 },
    foldLen: 0.2,
    tail: { len: 0.13, w: 0.035, cockB: -10 },
    legs: { len: 0.04, r: 0.007, gap: 0.025 },
    paint: (r, i) => {
      const green = C(64, 150, 62);
      if (r === 'body') return twoTone(green, C(120, 180, 70), i.up, -0.3, 0.5);
      if (r === 'neck') return green;
      if (r === 'head') return i.up > 0.3 && i.t > 0.3 ? C(230, 210, 60) : i.side > 0.5 ? C(80, 160, 70) : green;
      if (r === 'bill') return C(214, 196, 160);
      if (r === 'wing') {
        if (i.top) return i.u > 0.62 ? mix3(C(44, 80, 150), green, 0.25) : i.v > 0.85 && i.u > 0.3 && i.u < 0.55 ? C(180, 50, 40) : green;
        return C(90, 150, 70);
      }
      if (r === 'tail') return i.t > 0.7 ? C(196, 210, 70) : green;
      if (r === 'leg') return C(120, 120, 120);
      return green;
    },
  }),
  kittiwake: () => gull({ bl: 0.3, span: 0.5, leg: C(26, 26, 26), mantle: C(170, 176, 182), bill: C(222, 206, 84), tips: 'ink' }),
  herringGull: () => gull({ bl: 0.4, span: 0.68, leg: C(214, 168, 156), mantle: C(160, 168, 176), bill: C(226, 196, 70), tips: 'spots' }),
  oystercatcher: () => bird({
    bl: 0.27, bw: 0.07, bh: 0.065, hb: 0.15, tilt: 6,
    neckA: [[0.1, 0.17], [0.15, 0.175], [0.18, 0.178]], neckB: [[0.1, 0.18], [0.13, 0.21], [0.15, 0.23]], neckR: [0.04, 0.032, 0.03],
    head: { len: 0.055, w: 0.026, h: 0.03, pitchA: -2, pitchB: -6 },
    bill: { len: 0.08, w: 0.008, h: 0.011, droop: 4 },
    wing: { span: 0.4, root: 0.14, wrist: 0.13, tip: 0.04, sweep: 0.08 },
    foldLen: 0.24,
    tail: { len: 0.08, w: 0.04, cockB: -4 },
    legs: { len: 0.08, r: 0.008, gap: 0.03, toes: 0.035 },
    paint: (r, i) => {
      const black = C(28, 28, 30);
      const white = C(240, 240, 236);
      if (r === 'body') return i.up < -0.15 && i.t < 0.8 ? white : black;
      if (r === 'neck' || r === 'head') return black;
      if (r === 'bill') return C(232, 96, 34);
      if (r === 'wing') return i.top ? (i.v > 0.55 && i.u > 0.15 && i.u < 0.8 ? white : black) : white;
      if (r === 'tail') return i.t < 0.45 ? white : black;
      if (r === 'leg') return C(226, 160, 150);
      return black;
    },
  }),
};

// Deer: doe or (with antlers) buck.
function deer(buck) {
  const coat = C(134, 100, 72);
  const back = C(104, 80, 60);
  const white = C(236, 232, 222);
  return mammal({
    kind: KIND.WALKER,
    body: [[-0.62, 0.84, 0.66, 0.05], [-0.56, 0.9, 0.56, 0.14], [-0.4, 0.93, 0.53, 0.18], [-0.15, 0.9, 0.56, 0.175], [0.12, 0.93, 0.54, 0.19], [0.34, 0.96, 0.52, 0.17], [0.48, 0.95, 0.58, 0.13], [0.56, 0.88, 0.68, 0.075]],
    neck: { pts: [[0.4, 0.84], [0.53, 1.02], [0.63, 1.18], [0.69, 1.29]], r: [[0.12, 0.15], [0.105, 0.125], [0.085, 0.1], [0.07, 0.08]] },
    head: { base: [0.69, 1.33], pitch: -40, len: 0.31, w: [0.07, 0.072, 0.05, 0.03], h: [0.08, 0.077, 0.055, 0.034] },
    ears: { root: [0.69, 0.05, 1.37], dir: [-0.3, 0.75, 0.55], len: 0.15, w: 0.07 },
    horns: buck
      ? [
        { region: 'antler', pts: [[0.69, 0.05, 1.38], [0.64, 0.17, 1.52], [0.8, 0.21, 1.62]], r: [0.017, 0.013, 0.006] },
        { region: 'antler', pts: [[0.68, 0.18, 1.54], [0.71, 0.18, 1.69]], r: [0.009, 0.004] },
      ]
      : [],
    legs: {
      front: { y: 0.09, pts: [[0.36, 0.72], [0.38, 0.3], [0.395, 0.08], [0.41, 0.0]], r: [0.055, 0.024, 0.019, 0.021] },
      hind: { y: 0.1, pts: [[-0.42, 0.72], [-0.55, 0.42], [-0.5, 0.08], [-0.48, 0.0]], r: [0.07, 0.03, 0.02, 0.021] },
    },
    tail: { pts: [[-0.62, 0.84], [-0.69, 0.77], [-0.73, 0.68]], r: [[0.045, 0.025], [0.05, 0.026], [0.03, 0.018]], sides: 4 },
    // Alert: the white flag up and the head raised.
    alt: [[[PART.TAIL], [-0.62, 0.84], 125], [[PART.HEAD, PART.EAR], [0.46, 0.86], 10]],
    paint: (r, i) => {
      if (r === 'body') return i.up < -0.6 ? white : mix3(back, coat, sm(0.95, 0.2, i.up));
      if (r === 'neck') return i.up < -0.55 && i.t > 0.55 ? white : mix3(back, coat, 0.6);
      if (r === 'head') {
        if (i.t > 0.93) return C(28, 26, 24); // nose
        if (i.t > 0.78) return white; // muzzle band
        if (i.up < -0.55 && i.t > 0.3) return white;
        return C(122, 92, 66);
      }
      if (r === 'ear') return i.inner ? C(214, 200, 186) : C(120, 92, 70);
      if (r === 'antler') return mix3(C(196, 180, 150), C(232, 222, 200), i.t);
      if (r === 'leg') return i.t > 0.93 ? C(42, 38, 34) : mix3(coat, C(176, 150, 120), sm(0.3, 0.8, i.t));
      if (r === 'tail') return i.up > 0.2 ? C(118, 84, 58) : white;
      return coat;
    },
  });
}

// Hares and rabbits (bounders): a hunched body, long ears, big hind legs; alert = sitting up.
function hare({ s, earLen, earW, coat, dark, tail, tips, round = false }) {
  const k = s;
  const P = (x, z) => [x * k, z * k];
  const white = C(232, 228, 220);
  return mammal({
    kind: KIND.BOUNDER,
    exp: round ? 2.0 : 2.2,
    body: [[-0.2, 0.22, 0.07, 0.04], [-0.17, 0.26, 0.045, 0.09], [-0.08, 0.27, 0.05, 0.095], [0.02, 0.25, 0.075, 0.085], [0.1, 0.23, 0.095, 0.072], [0.16, 0.21, 0.115, 0.052], [0.19, 0.195, 0.135, 0.03]].map(([x, zt, zb, hw]) => [x * k, zt * k, zb * k, hw * k * (round ? 1.08 : 1)]),
    neck: { pts: [P(0.13, 0.19), P(0.17, 0.225), P(0.19, 0.24)], r: [0.05 * k, 0.045 * k, 0.042 * k] },
    head: { base: P(0.19, 0.25), pitch: -18, len: 0.11 * k, w: [0.035 * k, 0.04 * k, 0.03 * k, 0.016 * k], h: [0.042 * k, 0.045 * k, 0.032 * k, 0.018 * k] },
    ears: { root: [0.19 * k, 0.022 * k, 0.29 * k], dir: [-0.42, 0.28, 0.86], len: earLen, w: earW },
    legs: {
      front: { y: 0.03 * k, pts: [P(0.12, 0.12), P(0.135, 0.04), P(0.15, 0.0)], r: [0.018 * k, 0.012 * k, 0.012 * k] },
      hind: { y: 0.06 * k, pts: [P(-0.12, 0.16), P(-0.2, 0.035), P(-0.06, 0.0)], r: [0.05 * k, 0.02 * k, 0.018 * k] },
    },
    tail: { pts: [P(-0.2, 0.18), P(-0.235, 0.2)], r: [0.026 * k, 0.022 * k] },
    alt: [
      [[PART.BODY, PART.HEAD, PART.EAR, PART.LEG_FL, PART.LEG_FR, PART.TAIL], [-0.12 * k, 0.06 * k], 32],
      [[PART.HEAD, PART.EAR], { at: [0.13 * k, 0.19 * k] }, -26],
      [[PART.LEG_FL, PART.LEG_FR], { at: [0.12 * k, 0.12 * k], of: PART.LEG_FL }, -24],
    ],
    earAlt: -12,
    paint: (r, i) => {
      if (r === 'body') return i.up < -0.55 ? white : mix3(dark, coat, sm(0.9, 0.2, i.up) * (0.85 + 0.15 * h01(i.t * 11)));
      if (r === 'neck') return twoTone(coat, white, i.up);
      if (r === 'head') return i.t > 0.9 ? C(80, 66, 56) : i.up < -0.5 ? C(210, 200, 186) : mix3(coat, dark, 0.3);
      if (r === 'ear') return i.t > 0.8 ? tips : i.inner ? C(196, 170, 160) : coat;
      if (r === 'leg') return mix3(coat, C(200, 186, 166), i.t * 0.6);
      if (r === 'tail') return round ? (i.up > 0.3 ? dark : tail) : (i.up > 0.2 ? tail : white);
      return coat;
    },
  });
}

// Mallard: drake (green head, white collar, chestnut breast, grey flanks) or the mottled hen.
function duck(drake) {
  return bird({
    bl: 0.4, bw: 0.11, bh: 0.09, hb: 0.16, tilt: 4,
    neckA: [[0.17, 0.2], [0.26, 0.205], [0.32, 0.21]],
    neckB: [[0.16, 0.2], [0.2, 0.26], [0.215, 0.3]],
    neckR: [0.046, 0.034, 0.032],
    head: { len: 0.085, w: 0.03, h: 0.036, pitchA: -2, pitchB: -2 },
    bill: { len: 0.055, w: 0.021, h: 0.011, droop: 8 },
    wing: { span: 0.42, root: 0.15, wrist: 0.14, tip: 0.045, sweep: 0.08 },
    foldLen: 0.3,
    tail: { len: 0.07, w: 0.05, cockB: 10 },
    legs: { len: 0.07, r: 0.008, gap: 0.04, toes: 0.045 },
    paint: (r, i) => {
      if (drake) {
        if (r === 'body') {
          if (i.t > 0.6 && i.up < 0.4) return C(108, 58, 38); // chestnut breast
          if (i.t < 0.18) return C(24, 24, 26); // black rump
          return i.up > 0.55 ? C(118, 108, 92) : C(182, 180, 174);
        }
        if (r === 'neck') return i.t < 0.25 ? C(236, 236, 230) : C(24, 78, 46);
        if (r === 'head') return C(22, 74, 44);
        if (r === 'bill') return C(212, 192, 64);
        if (r === 'tail') return i.top && i.t < 0.4 ? C(26, 26, 28) : C(226, 226, 220);
      } else {
        const mottle = h01((i.t || 0) * 23 + (i.side || 0) * 7 + (i.up || 0) * 3) * 0.35;
        if (r === 'body') return mix3(C(146, 112, 76), C(96, 72, 50), mottle + (i.up > 0.5 ? 0.3 : 0));
        if (r === 'neck') return C(150, 120, 88);
        if (r === 'head') return i.up > 0.45 || (Math.abs(i.side) > 0.8 && i.t > 0.3 && i.t < 0.6) ? C(84, 64, 46) : C(166, 136, 100);
        if (r === 'bill') return C(196, 120, 50);
        if (r === 'tail') return C(140, 112, 82);
      }
      if (r === 'wing') {
        if (!i.top) return C(214, 212, 206);
        if (i.v > 0.65 && i.u > 0.12 && i.u < 0.5) return C(56, 70, 168); // speculum
        return mix3(C(118, 104, 88), C(84, 76, 68), sm(0.6, 1, i.u));
      }
      if (r === 'leg') return C(228, 128, 44);
      return C(140, 120, 100);
    },
  });
}

// Long-legged waders (heron, egret, flamingo) share a colouring scheme from `colors`.
function wader(spec) {
  const c = spec.colors;
  return bird({
    ...spec,
    paint: (r, i) => {
      if (r === 'body') return twoTone(c.body, c.under, i.up, -0.2, 0.4);
      if (r === 'neck') return c.stripe && i.up > 0.85 && i.t > 0.3 ? mix3(c.neck, c.stripe, 0.35) : c.neck;
      if (r === 'head') return c.stripe && i.up > 0.5 && i.t < 0.5 ? c.stripe : c.head;
      if (r === 'crest') return c.crest || c.head;
      if (r === 'bill') return c.billTip && i.t > 0.6 ? c.billTip : c.bill;
      if (r === 'wing') {
        if (!i.top) return i.u > 0.62 || i.finger ? mix3(c.wingBot, c.wingOut, 0.8) : c.wingBot;
        // (A flamingo's black flight feathers: the outer wing and the trailing edge, hidden when folded.)
        return i.u > 0.62 || i.finger || (i.v > 0.75 && c.billTip) ? c.wingOut : c.wingIn;
      }
      if (r === 'tail') return c.wingIn;
      if (r === 'leg') return c.leg;
      return c.body;
    },
  });
}

// Gulls: white body and head, grey mantle and upperwing, black wingtips (a kittiwake's "dipped in
// ink"; a herring gull's with white mirrors), yellow bill, legs black or pink.
function gull({ bl, span, leg, mantle, bill, tips }) {
  const k = bl / 0.3;
  return bird({
    bl, bw: 0.075 * k, bh: 0.068 * k, hb: 0.13 * k, tilt: 8,
    neckA: [[0.1 * k, 0.16 * k], [0.14 * k, 0.165 * k], [0.17 * k, 0.168 * k]],
    neckB: [[0.1 * k, 0.17 * k], [0.13 * k, 0.21 * k], [0.15 * k, 0.23 * k]],
    neckR: [0.04 * k, 0.032 * k, 0.03 * k],
    head: { len: 0.06 * k, w: 0.027 * k, h: 0.031 * k, pitchA: -4, pitchB: -6 },
    bill: { len: 0.04 * k, w: 0.008 * k, h: 0.012 * k, droop: 6 },
    wing: { span, root: 0.15 * k, wrist: 0.14 * k, tip: 0.03 * k, sweep: 0.1 * span },
    foldLen: 0.31 * k,
    tail: { len: 0.1 * k, w: 0.05 * k, cockB: -4, fork: tips === 'ink' ? 0.3 : 0 },
    legs: { len: 0.06 * k, r: 0.006 * k, gap: 0.025 * k, toes: 0.03 * k },
    paint: (r, i) => {
      const white = C(242, 242, 240);
      if (r === 'body') return i.up > 0.55 && i.t > 0.15 && i.t < 0.8 ? mantle : white;
      if (r === 'neck' || r === 'head') return white;
      if (r === 'bill') return bill;
      if (r === 'wing') {
        const tip = i.u > (tips === 'ink' ? 0.84 : 0.8);
        if (!i.top) return tip && tips !== 'ink' ? C(60, 60, 62) : tip ? C(30, 30, 32) : white;
        if (tip) return tips === 'spots' && i.u > 0.93 && i.v > 0.3 && i.v < 0.7 ? white : C(26, 26, 28);
        return i.v > 0.9 ? mix3(mantle, white, 0.6) : mantle;
      }
      if (r === 'tail') return white;
      if (r === 'leg') return leg;
      return white;
    },
  });
}

// ------------------------------------------------------------------ animation constants
// kind, graze, swing, size, tail, ear, dihedral, flap, cz, neckX, neckZ, bob, draft, len, wid
const MP = (kind, graze, swing, size, tail, ear, dihedral, flap, cz, neckX, neckZ, bob, draft, len, wid) =>
  Object.freeze({ kind, graze, swing, size, tail, ear, dihedral, flap, cz, neckX, neckZ, bob, draft, len, wid });
export const MESH_PARAMS = Object.freeze({
  doe: MP(KIND.WALKER, 1.9, 0.42, 1.35, 0.5, 0.35, 0, 0, 0.75, 0.46, 0.86, 0.05, 0, 1.6, 0.42),
  buck: MP(KIND.WALKER, 1.9, 0.42, 1.6, 0.5, 0.3, 0, 0, 0.75, 0.46, 0.86, 0.05, 0, 1.65, 0.44),
  squirrel: MP(KIND.BOUNDER, 0.5, 0.7, 0.2, 0.25, 0.3, 0, 0, 0.09, 0.08, 0.11, 0.03, 0, 0.3, 0.1),
  mallardDrake: MP(KIND.BIRD, 1.0, 0.5, 0.33, 0.1, 0, 0.1, 0.95, 0.16, 0.16, 0.2, 0, 0.13, 0.5, 0.22),
  mallardHen: MP(KIND.BIRD, 1.0, 0.5, 0.33, 0.1, 0, 0.1, 0.95, 0.16, 0.16, 0.2, 0, 0.13, 0.5, 0.22),
  goose: MP(KIND.BIRD, 1.25, 0.45, 0.75, 0.1, 0, 0.06, 0.85, 0.3, 0.27, 0.37, 0, 0.25, 0.85, 0.3),
  songbird: MP(KIND.BIRD, 0.8, 0.7, 0.1, 0.4, 0, 0.1, 1.1, 0.055, 0.035, 0.07, 0, 0, 0.15, 0.06),
  heron: MP(KIND.BIRD, 1.6, 0.35, 0.95, 0.1, 0, -0.05, 0.7, 0.52, 0.15, 0.6, 0, 0, 0.6, 0.2),
  roadrunner: MP(KIND.BIRD, 0.6, 0.9, 0.3, 0.6, 0, 0.05, 0.9, 0.2, 0.08, 0.22, 0, 0, 0.55, 0.1),
  hawk: MP(KIND.BIRD, 0.5, 0.3, 0.45, 0.15, 0, 0.14, 0.65, 0.17, 0.13, 0.21, 0, 0, 0.5, 0.18),
  quail: MP(KIND.BIRD, 0.7, 0.8, 0.2, 0.2, 0, 0.08, 1.0, 0.095, 0.06, 0.12, 0, 0, 0.25, 0.11),
  jackrabbit: MP(KIND.BOUNDER, 0.45, 0.8, 0.42, 0.2, 0.35, 0, 0, 0.17, 0.13, 0.19, 0.06, 0, 0.5, 0.18),
  rabbit: MP(KIND.BOUNDER, 0.45, 0.8, 0.28, 0.2, 0.3, 0, 0, 0.12, 0.094, 0.137, 0.04, 0, 0.36, 0.13),
  coyote: MP(KIND.WALKER, 0.9, 0.48, 0.8, 0.3, 0.2, 0, 0, 0.48, 0.36, 0.56, 0.04, 0, 1.15, 0.26),
  sheep: MP(KIND.WALKER, 0.75, 0.4, 0.95, 0.4, 0.3, 0, 0, 0.6, 0.45, 0.7, 0.03, 0, 1.15, 0.5),
  lizard: MP(KIND.SPRAWLER, 0.2, 0.55, 0.06, 0.4, 0, 0, 0, 0.03, 0.09, 0.035, 0, 0, 0.4, 0.16),
  iguana: MP(KIND.SPRAWLER, 0.25, 0.5, 0.14, 0.35, 0, 0, 0, 0.07, 0.2, 0.08, 0, 0, 1.2, 0.3),
  pelican: MP(KIND.BIRD, 0.6, 0.35, 0.65, 0.1, 0, 0.04, 0.6, 0.28, 0.3, 0.35, 0, 0.17, 1.1, 0.35),
  flamingo: MP(KIND.BIRD, 2.35, 0.32, 1.3, 0.1, 0, 0.02, 0.75, 0.86, 0.18, 0.9, 0, 0, 0.6, 0.22),
  egret: MP(KIND.BIRD, 1.6, 0.35, 0.95, 0.1, 0, -0.04, 0.72, 0.5, 0.13, 0.56, 0, 0, 0.55, 0.18),
  parrot: MP(KIND.BIRD, 0.5, 0.5, 0.3, 0.3, 0, 0.06, 0.6, 0.11, 0.09, 0.13, 0, 0, 0.35, 0.1),
  kittiwake: MP(KIND.BIRD, 0.8, 0.5, 0.3, 0.15, 0, 0.12, 0.8, 0.13, 0.1, 0.16, 0, 0.09, 0.42, 0.16),
  herringGull: MP(KIND.BIRD, 0.8, 0.5, 0.4, 0.15, 0, 0.1, 0.75, 0.173, 0.133, 0.213, 0, 0.12, 0.56, 0.2),
  oystercatcher: MP(KIND.BIRD, 1.1, 0.6, 0.3, 0.2, 0, 0.08, 0.9, 0.15, 0.1, 0.17, 0, 0, 0.42, 0.14),
});
export const SPECIES_MESHES = Object.freeze(Object.keys(SPECS));

const cache = new Map();
export function buildSpeciesMesh(id) {
  if (!SPECS[id]) throw new Error(`wildlife-mesh: unknown species mesh ${id}`);
  if (!cache.has(id)) cache.set(id, SPECS[id]());
  return cache.get(id);
}

// Pack one mesh's animation constants into the shader's slot table (3 vec4):
// (kind, graze, swing, size) (tail, ear, dihedral, flap) (cz, neckX, neckZ, bob).
export function slotParams(id, out = new Float32Array(SLOT_FLOATS), o = 0) {
  const m = MESH_PARAMS[id];
  const v = [m.kind, m.graze, m.swing, m.size, m.tail, m.ear, m.dihedral, m.flap, m.cz, m.neckX, m.neckZ, m.bob];
  for (let k = 0; k < SLOT_FLOATS; k++) out[o + k] = v[k];
  return out;
}

// The hole's species meshes concatenated in slot order (one instanced draw renders them all: the
// shader keeps the vertices of the instance's own slot and drops the rest).
export function wildlifeMesh(slots) {
  if (slots.length > MAX_SLOTS) throw new Error(`wildlife-mesh: at most ${MAX_SLOTS} slots`);
  const parts = slots.map((id) => buildSpeciesMesh(id));
  const verts = parts.reduce((a, m) => a + m.verts, 0);
  if (verts > 65535) throw new Error('wildlife-mesh: too many vertices for 16-bit indices');
  const tris = parts.reduce((a, m) => a + m.tris, 0);
  const pos = new Float32Array(verts * 3);
  const alt = new Float32Array(verts * 3);
  const piv = new Float32Array(verts * 3);
  const anim = new Float32Array(verts * 4);
  const nrm = new Float32Array(verts * 4);
  const idx = new Uint16Array(tris * 3);
  const params = new Float32Array(Math.max(1, slots.length) * SLOT_FLOATS);
  let v0 = 0;
  let i0 = 0;
  parts.forEach((m, s) => {
    pos.set(m.pos, v0 * 3);
    alt.set(m.alt, v0 * 3);
    piv.set(m.piv, v0 * 3);
    nrm.set(m.nrm, v0 * 4);
    anim.set(m.anim, v0 * 4);
    for (let k = 0; k < m.verts; k++) anim[(v0 + k) * 4 + 2] = s;
    for (let k = 0; k < m.idx.length; k++) idx[i0 + k] = m.idx[k] + v0;
    slotParams(slots[s], params, s * SLOT_FLOATS);
    v0 += m.verts;
    i0 += m.idx.length;
  });
  return { pos, alt, piv, anim, nrm, idx, verts, tris, slotIds: slots.slice(), slotTris: parts.map((m) => m.tris), params, key: slots.join(',') };
}
