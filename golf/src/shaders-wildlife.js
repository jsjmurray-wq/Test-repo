// Wildlife pass (docs/architecture.md section 10): the GLSL programs that pose and light the
// animals, and WildlifePass, the renderer's self-contained draw of them (render.js only calls
// init / setMesh / upload / draw / drawShadows). GL module (not pure).
//
// One instanced draw renders every animal of the hole: the mesh is the theme's species meshes
// concatenated (wildlife-mesh.js wildlifeMesh) and each instance keeps the vertices of its own
// slot (the rest collapse outside the clip volume). A second instanced draw lays their soft
// contact shadows on the ground. 2 draw calls in all (budget 3).
//
// Vertex animation (WILD_VS), from the instance row (wildlife.js write()) and the slot table
// (uSlot: wildlife-mesh.js slotParams):
//   birds    rest pose <-> flight pose by `fly` (swimming tucks the legs), wings flapping about the
//            shoulder with the stroke travelling out to the tip, dihedral and gull-wing glide,
//            legs stepping on foot, the neck bending down to feed, the head turning, a tail flick;
//            bank and pitch of the whole bird
//   mammals  normal <-> alert pose (a deer's white flag, a hare sitting up), a walk / trot /
//            bound leg cycle with the lower leg curling on the swing, the head down to graze and
//            turning to look, ear twitches, tail flicks, the body bouncing at a run
//   lizards  sprawled legs swinging about the vertical, the tail waving
// Lit like the rest of the scene (theme sun, wrap diffuse, hemisphere ambient, a cool rim, fog,
// tone map), with a little fur / feather breakup close up and backlit wings. Dithered fades: near
// the camera, far away, out of sight lines to the ball and the flag, and hidden animals.
//
//   const pass = new WildlifePass();
//   pass.init(gl, ctx)          programs and buffers (again after a context loss)
//   pass.setMesh(mesh)          the hole's species mesh (CPU copy kept for a restore)
//   pass.upload()               its GPU buffers (setHole and context restore)
//   pass.draw(r, scene, frame)          opaque pass (after the themed objects)
//   pass.drawShadows(r, scene, frame)   with the overlays (blending on)
//   scene.wildlife = {inst, count, shadow, shadowCount, key} (main.js; key = the slot list, so a
//   sim of another theme's animals is never drawn with this mesh)

import { COMMON } from './shaders.js';
import { createProgram, makeBuffer } from './gl.js';
import { MAX_SLOTS } from './wildlife-mesh.js';
import { MAX_ANIMALS, INST_FLOATS, SHADOW_FLOATS } from './wildlife.js';

export const WILD_VS = `
attribute vec3 aPos;     // flight pose (birds) / normal pose (mammals)
attribute vec3 aAlt;     // rest pose (birds) / alert pose (mammals)
attribute vec4 aNrm;     // both normals, octahedral (pos.xy, alt.xy)
attribute vec3 aPiv;     // the part's pivot
attribute vec4 aAnim;    // part, weight along it, slot, packed sRGB colour
attribute vec4 iA;       // x, y, z, yaw
attribute vec4 iB;       // slot + 0.5 * visibility, head down, seed, phase (cycles)
attribute vec4 iC;       // mammals: gait, alert, head turn, pitch; birds: fly, flap|walk, bank, pitch
uniform mat4 uVP;
uniform vec3 uEye;
uniform float uTime;
uniform vec4 uSlot[${MAX_SLOTS * 3}]; // per slot: (kind, graze, swing, size) (tail, ear, dihedral, flap) (cz, neckX, neckZ, bob)
uniform vec4 uFade;      // near fade start, end (m, plus 0.9 / 2.2 x the animal's size); far fade start, end
uniform vec4 uClear;     // the ball (sight line kept clear), w = on
uniform vec4 uClear2;    // the flag, w = on
varying vec3 vRel;
varying vec3 vN;
varying vec3 vCol;
varying vec3 vLocal;
varying float vFade;
varying float vWing;

vec3 octN(vec2 e) {
  vec3 v = vec3(e.xy, 1.0 - abs(e.x) - abs(e.y));
  if (v.z < 0.0) {
    vec2 s = vec2(v.x >= 0.0 ? 1.0 : -1.0, v.y >= 0.0 ? 1.0 : -1.0);
    v.xy = (1.0 - abs(v.yx)) * s;
  }
  return normalize(v);
}
// Rotations of a point (about c) and its normal: X = roll (+ lifts the left side), Y = pitch
// (+ nose up), Z = yaw (+ counter-clockwise from above).
void rotX(inout vec3 p, inout vec3 n, vec3 c, float a) {
  float s = sin(a); float k = cos(a); vec3 q = p - c;
  p = c + vec3(q.x, q.y * k - q.z * s, q.y * s + q.z * k);
  n = vec3(n.x, n.y * k - n.z * s, n.y * s + n.z * k);
}
void rotY(inout vec3 p, inout vec3 n, vec3 c, float a) {
  float s = sin(a); float k = cos(a); vec3 q = p - c;
  p = c + vec3(q.x * k - q.z * s, q.y, q.x * s + q.z * k);
  n = vec3(n.x * k - n.z * s, n.y, n.x * s + n.z * k);
}
void rotZ(inout vec3 p, inout vec3 n, vec3 c, float a) {
  float s = sin(a); float k = cos(a); vec3 q = p - c;
  p = c + vec3(q.x * k - q.y * s, q.x * s + q.y * k, q.z);
  n = vec3(n.x * k - n.y * s, n.x * s + n.y * k, n.z);
}
// Fade for an animal in the sight line from the eye to t (xyz, w = on): beside the line, or with
// the line passing over or under its body, it stays.
float clearOf(vec4 t, vec3 at, float size) {
  if (t.w < 0.5) return 1.0;
  vec2 sb = t.xy - uEye.xy;
  float sl = max(dot(sb, sb), 1e-4);
  float u = clamp(dot(at.xy - uEye.xy, sb) / sl, 0.0, 1.0);
  float off = length(uEye.xy + sb * u - at.xy);
  float dz = uEye.z + (t.z - uEye.z) * u - at.z; // the line's height over the animal's feet
  off += step(0.97, u) * 99.0 + (max(dz - size, 0.0) + max(-dz - size * 0.5, 0.0)) * 4.0;
  return smoothstep(size * 0.5 + 0.4, size * 0.5 + 1.6, off);
}

void main() {
  float slot = floor(iB.x + 0.001);
  vWing = 0.0;
  if (abs(aAnim.z - slot) > 0.5) {
    // Another species' vertices: outside the clip volume (the whole triangle is dropped).
    vRel = vec3(0.0); vN = vec3(0.0, 0.0, 1.0); vCol = vec3(0.0); vLocal = vec3(0.0); vFade = 0.0;
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  float vis = clamp((iB.x - slot) * 2.0, 0.0, 1.0);
  int si = int(slot + 0.5) * 3;
  vec4 S0 = uSlot[si];
  vec4 S1 = uSlot[si + 1];
  vec4 S2 = uSlot[si + 2];
  float kind = S0.x;
  bool bird = kind > 1.5 && kind < 2.5;
  float part = aAnim.x;
  float f = aAnim.y;
  float seed = iB.z;
  float ph = iB.w * 6.2831853;
  float head = iB.y;
  float t = uTime;
  // ---- pose blend
  float fly = clamp(iC.x, 0.0, 1.0);
  float w;
  if (bird) w = (part > 1.5 && part < 3.5 && iC.x < 0.0) ? 1.0 : fly;
  else w = 1.0 - clamp(iC.y, 0.0, 1.0);
  vec3 p = mix(aAlt, aPos, w);
  vec3 n = normalize(mix(octN(aNrm.zw), octN(aNrm.xy), w));
  vec3 neck = vec3(S2.y, 0.0, S2.z);
  vec3 ctr = vec3(0.0, 0.0, S2.x);
  if (bird) {
    float flap = iC.y;
    if (part > 7.5 && part < 9.5) {
      // Wings: dihedral (with the outer wing set down a little: a gull's crooked glide) and the
      // stroke, which reaches the tip a moment after the shoulder.
      float side = part < 8.5 ? 1.0 : -1.0;
      float glide = S1.z * (1.0 - 1.6 * smoothstep(0.45, 1.0, f) * step(0.0, S1.z));
      float stroke = flap * S1.w * sin(ph - f * 0.9) * (0.55 + 0.45 * f);
      float upFold = flap * 0.25 * max(0.0, sin(ph - f * 0.9 + 1.2)) * smoothstep(0.5, 1.0, f);
      rotX(p, n, aPiv, side * (glide + stroke) * fly);
      rotZ(p, n, aPiv, side * -upFold * fly);
      vWing = fly;
    } else if (part > 1.5 && part < 3.5) {
      // Legs stepping on foot.
      float off = part < 2.5 ? 0.0 : 3.14159;
      rotY(p, n, aPiv, S0.z * flap * (1.0 - fly) * sin(ph + off) * (0.7 + 0.3 * f));
    } else if (part > 5.5 && part < 6.5) {
      rotY(p, n, aPiv, S1.x * 0.18 * sin(t * (2.3 + seed) + seed * 40.0) * (1.0 - fly) * f);
    } else if (part > 0.5 && part < 1.5) {
      // Neck and head: down to feed, turning to look round (not in flight).
      rotY(p, n, neck, -head * S0.y * f);
      float look = 0.55 * sin(t * (0.5 + 0.3 * seed) + seed * 30.0) * sin(t * 0.23 + seed * 11.0);
      rotZ(p, n, neck, look * (1.0 - fly) * (1.0 - head) * f * f);
      // A nod with each step on foot.
      rotY(p, n, neck, 0.08 * flap * (1.0 - fly) * sin(ph * 2.0) * f);
    }
  } else if (kind > 2.5) {
    // Sprawlers (lizards): legs swing about the vertical in diagonal pairs, the tail waves.
    float g = min(iC.x, 2.0);
    if (part > 9.5 && part < 13.5) {
      float k = part - 10.0;
      float off = (k < 0.5 || k > 2.5) ? 0.0 : 3.14159;
      float left = (k < 0.5 || (k > 1.5 && k < 2.5)) ? 1.0 : -1.0;
      rotZ(p, n, aPiv, -left * S0.z * min(g, 1.0) * (1.0 + 0.5 * max(g - 1.0, 0.0)) * sin(ph + off));
    } else if (part > 13.5) {
      rotZ(p, n, aPiv, (0.3 * min(g, 1.0) * sin(ph - f * 2.5) + 0.06 * sin(t * 0.7 + seed * 9.0)) * f);
    } else if (part > 0.5 && part < 1.5) {
      rotZ(p, n, neck, iC.z * 0.5 * f);
    }
  } else {
    // Mammals.
    float g = iC.x;
    float walk = min(g, 1.0);
    float run = clamp(g - 1.0, 0.0, 1.0);
    bool bound = kind > 0.5;
    if (part > 1.5 && part < 5.5) {
      float k = part - 2.0;
      // Phase offsets: walk FL .25 FR .75 HL 0 HR .5; trot FL 0 FR .5 HL .5 HR 0; bound: hind
      // pair together, the forefeet half a cycle later.
      vec4 wOff = vec4(0.25, 0.75, 0.0, 0.5);
      vec4 rOff = bound ? vec4(0.5, 0.56, 0.0, 0.05) : vec4(0.0, 0.5, 0.5, 0.0);
      vec4 o4 = mix(wOff, rOff, bound ? max(run, step(0.05, g)) : run);
      float off = k < 0.5 ? o4.x : k < 1.5 ? o4.y : k < 2.5 ? o4.z : o4.w;
      float a = ph + off * 6.2831853;
      float amp = S0.z * walk * (1.0 + 0.7 * run);
      float swing = amp * sin(a);
      float curl = -amp * 1.1 * max(0.0, cos(a)) * smoothstep(0.3, 0.85, f);
      rotY(p, n, aPiv, swing + curl);
    } else if (part > 5.5 && part < 6.5) {
      // Tail: an occasional flick, a swing with the stride.
      float flick = pow(max(0.0, sin(t * (1.1 + seed) + seed * 40.0)), 14.0);
      rotZ(p, n, aPiv, S1.x * (flick * sin(t * 16.0) * 0.9 + 0.15 * walk * sin(ph)) * f);
    } else if (part > 6.5 && part < 7.5) {
      float tw = pow(max(0.0, sin(t * (0.8 + seed * 0.7) + seed * 17.0 + step(0.0, p.y) * 2.0)), 18.0);
      rotX(p, n, aPiv, S1.y * tw * (p.y > 0.0 ? 1.0 : -1.0));
    }
    if ((part > 0.5 && part < 1.5) || (part > 6.5 && part < 7.5)) {
      float fw = part > 6.5 ? 1.0 : f;
      rotY(p, n, neck, -head * S0.y * fw + 0.05 * walk * sin(ph * 2.0) * fw);
      rotZ(p, n, neck, iC.z * 0.9 * fw * (1.0 - head));
    }
    // Body: a bounce at a run, a rocking pitch when bounding.
    p.z += S2.w * abs(sin(ph * (bound ? 1.0 : 2.0))) * run;
    if (bound) rotY(p, n, ctr, 0.22 * sin(ph + 1.2) * max(run, 0.4 * walk));
  }
  // Whole-body pitch and bank about the body centre.
  rotY(p, n, ctr, iC.w);
  if (bird) rotX(p, n, ctr, iC.z);
  float sc = bird ? 0.94 + 0.12 * fract(seed * 5.31) : 0.88 + 0.24 * fract(seed * 5.31);
  // Facing: yaw about the vertical, then into the world.
  float cy = cos(iA.w);
  float sy = sin(iA.w);
  p *= sc;
  vec3 wp = vec3(p.x * cy - p.y * sy, p.x * sy + p.y * cy, p.z);
  vec3 wn = vec3(n.x * cy - n.y * sy, n.x * sy + n.y * cy, n.z);
  vRel = iA.xyz + wp - uEye;
  vN = wn;
  // Colour: unpack, a little variation per animal.
  float c = aAnim.w;
  float r = floor(c / 65536.0);
  float gg = floor((c - r * 65536.0) / 256.0);
  float b = c - r * 65536.0 - gg * 256.0;
  vec3 col = vec3(r, gg, b) / 255.0;
  float j = fract(seed * 7.13);
  vCol = bird ? col * (0.96 + 0.08 * j) : col * (0.9 + 0.2 * j) * mix(vec3(1.0), vec3(1.05, 1.0, 0.93), fract(seed * 3.7));
  vLocal = aAlt / max(S0.w, 0.05) * 4.0 + seed * 13.0;
  // Fades: hidden, too near the lens, far away, in a sight line to the ball or the flag.
  float d = length(iA.xyz - uEye);
  float fade = vis * smoothstep(uFade.x + S0.w * 0.9, uFade.y + S0.w * 2.2, d) * (1.0 - smoothstep(uFade.z, uFade.w, d));
  fade *= clearOf(uClear, iA.xyz, S0.w) * clearOf(uClear2, iA.xyz, S0.w);
  vFade = fade;
  gl_Position = uVP * vec4(vRel, 1.0);
  if (fade < 0.004) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}`;

export const WILD_FS = `${COMMON}
uniform sampler2D uNoise;
varying vec3 vRel;
varying vec3 vN;
varying vec3 vCol;
varying vec3 vLocal;
varying float vFade;
varying float vWing;
void main() {
  if (vFade < 0.999 && vFade < bayer4(gl_FragCoord.xy) * 0.94 + 0.03) discard;
  float dist = length(vRel);
  vec3 v = vRel / max(dist, 1e-4);
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  vec3 alb = toLin(vCol);
  // Fur and feather breakup up close (flat colour far away, where it would only shimmer).
  float tex = texture2D(uNoise, vLocal.xy * 0.37 + vLocal.z * 0.21).g * 0.65 + texture2D(uNoise, vLocal.yz * 0.9).r * 0.35;
  alb *= mix(1.0, 0.84 + 0.32 * tex, smoothstep(70.0, 10.0, dist));
  float ndl = dot(n, uSun);
  float diff = max((ndl + 0.32) / 1.32, 0.0);
  vec3 h = normalize(uSun - v);
  float sp = pow(max(dot(n, h), 0.0), 26.0) * 0.05 * smoothstep(-0.1, 0.2, ndl);
  // Wings glow a little when the sun is behind them.
  float trans = vWing * pow(max(dot(v, uSun), 0.0), 3.0) * 0.3;
  vec3 c = alb * (uSunCol * (diff + trans) + ambient(n) * 1.3) + uSunCol * sp;
  float rim = pow(1.0 - max(dot(n, -v), 0.0), 3.0) * (0.55 + 0.45 * n.z);
  c += rim * (uZenith * 0.12 + uSunCol * 0.03);
  c = applyFog(c, vRel);
  gl_FragColor = vec4(finish(c), 1.0);
}`;

// Contact shadow: a soft ellipse lying on the ground plane under the animal (thrown a little away
// from the sun by wildlife.js), alpha-blended with the overlays.
export const WILD_SHADOW_VS = `
attribute vec2 aCorner;
attribute vec4 iA;       // x, y, ground z, yaw
attribute vec4 iB;       // half length, half width, alpha
attribute vec4 iC;       // ground normal
uniform mat4 uVP;
uniform vec3 uEye;
varying vec2 vUV;
varying float vA;
void main() {
  vec3 nrm = normalize(iC.xyz + vec3(0.0, 0.0, 1e-3));
  float c = cos(iA.w);
  float s = sin(iA.w);
  vec2 d = vec2(c, s) * iB.x * aCorner.x + vec2(-s, c) * iB.y * aCorner.y;
  float dz = -(nrm.x * d.x + nrm.y * d.y) / max(nrm.z, 0.3);
  vec3 p = vec3(iA.xy + d, iA.z + dz + 0.025);
  vUV = aCorner;
  vA = iB.z;
  gl_Position = uVP * vec4(p - uEye, 1.0);
}`;

export const WILD_SHADOW_FS = `
precision mediump float;
varying vec2 vUV;
varying float vA;
void main() {
  float r = dot(vUV, vUV);
  float a = vA * (1.0 - smoothstep(0.2, 1.0, r));
  if (a < 0.004) discard;
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}`;

const NEAR_FADE = [0.5, 1.2]; // m from the lens (+ 0.9 / 2.2 x the animal's height: a deer 1.7-4.2 m)
const FAR_FADE = [520, 760]; // m

export class WildlifePass {
  constructor() {
    this.gl = null;
    this.ctx = null;
    this.P = null;
    this.PS = null;
    this.mesh = null; // CPU copy (setMesh)
    this.G = null; // the mesh's GPU buffers
    this.slotTris = null;
    this.stats = { animals: 0, shadows: 0, drawCalls: 0, tris: 0, verts: 0 };
  }

  // Programs, the shadow quad and the per-frame instance buffers (after a context loss as well:
  // every old GL object belongs to the lost context and is simply dropped).
  init(gl, ctx) {
    this.gl = gl;
    this.ctx = ctx;
    this.P = createProgram(gl, WILD_VS, WILD_FS);
    this.PS = createProgram(gl, WILD_SHADOW_VS, WILD_SHADOW_FS);
    this.quad = makeBuffer(gl, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));
    this.quadIdx = makeBuffer(gl, new Uint16Array([0, 1, 2, 2, 1, 3]), gl.ELEMENT_ARRAY_BUFFER);
    this.bInst = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bInst);
    gl.bufferData(gl.ARRAY_BUFFER, MAX_ANIMALS * INST_FLOATS * 4, gl.DYNAMIC_DRAW);
    this.bShadow = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bShadow);
    gl.bufferData(gl.ARRAY_BUFFER, MAX_ANIMALS * SHADOW_FLOATS * 4, gl.DYNAMIC_DRAW);
    this.G = null;
  }

  setMesh(mesh) {
    this.mesh = mesh;
  }

  // The hole's species mesh to the GPU (replacing the last hole's).
  upload() {
    const gl = this.gl;
    if (!gl) return;
    if (this.G) for (const k of ['pos', 'alt', 'nrm', 'piv', 'anim', 'idx']) gl.deleteBuffer(this.G[k]);
    this.G = null;
    const m = this.mesh;
    if (!m || !m.idx.length) return;
    this.G = {
      pos: makeBuffer(gl, m.pos), alt: makeBuffer(gl, m.alt), nrm: makeBuffer(gl, m.nrm), piv: makeBuffer(gl, m.piv),
      anim: makeBuffer(gl, m.anim), idx: makeBuffer(gl, m.idx, gl.ELEMENT_ARRAY_BUFFER), count: m.idx.length, key: m.key,
    };
    this.slotTris = m.slotTris;
  }

  _ready(w) {
    return !!(w && w.count > 0 && this.G && this.P && w.key === this.G.key);
  }

  // Opaque: every visible animal in one instanced draw (back faces culled; the flat parts are
  // two-layer).
  draw(r, scene, frame) {
    const st = this.stats;
    st.animals = 0;
    st.drawCalls = 0;
    st.tris = 0;
    const w = scene.wildlife;
    if (!this._ready(w)) return;
    const gl = this.gl;
    const A = r.attribs;
    const p = this.P;
    const u = r._use(p, frame);
    const m = this.mesh;
    gl.uniform4fv(u.uSlot, m.params);
    gl.uniform4f(u.uFade, NEAR_FADE[0], NEAR_FADE[1], FAR_FADE[0], FAR_FADE[1]);
    const ball = scene.ball;
    const clear = !!ball && ball.visible !== false && scene.clearView !== false;
    gl.uniform4f(u.uClear, clear ? ball.x : 0, clear ? ball.y : 0, clear ? ball.z : 0, clear ? 1 : 0);
    const T = r.terrain;
    const pin = T && T.cup && (!scene.pin || scene.pin.visible !== false);
    gl.uniform4f(u.uClear2, pin ? T.cup.x : 0, pin ? T.cup.y : 0, pin ? T.cup.z + 1.2 : 0, pin && scene.clearView !== false ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, r.G.noise);
    gl.uniform1i(u.uNoise, 0);
    const G = this.G;
    A.bind(p.a.aPos, G.pos, 3);
    A.bind(p.a.aAlt, G.alt, 3);
    A.bind(p.a.aNrm, G.nrm, 4);
    A.bind(p.a.aPiv, G.piv, 3);
    A.bind(p.a.aAnim, G.anim, 4);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, G.idx);
    const n = Math.min(w.count, MAX_ANIMALS);
    gl.enable(gl.CULL_FACE);
    gl.frontFace(gl.CCW);
    if (this.ctx.inst) {
      // (The whole buffer each frame: no subarray view to allocate.)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bInst);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, w.inst);
      const S = INST_FLOATS * 4;
      A.bind(p.a.iA, this.bInst, 4, S, 0, 1);
      A.bind(p.a.iB, this.bInst, 4, S, 16, 1);
      A.bind(p.a.iC, this.bInst, 4, S, 32, 1);
      A.end();
      this.ctx.inst.drawElements(gl.TRIANGLES, G.count, gl.UNSIGNED_SHORT, 0, n);
    } else {
      // WebGL1 without instancing: constant attributes per animal (counted as one draw).
      A.end();
      const c = w.inst;
      for (let k = 0; k < n; k++) {
        const o = k * INST_FLOATS;
        gl.vertexAttrib4f(p.a.iA, c[o], c[o + 1], c[o + 2], c[o + 3]);
        gl.vertexAttrib4f(p.a.iB, c[o + 4], c[o + 5], c[o + 6], c[o + 7]);
        gl.vertexAttrib4f(p.a.iC, c[o + 8], c[o + 9], c[o + 10], c[o + 11]);
        gl.drawElements(gl.TRIANGLES, G.count, gl.UNSIGNED_SHORT, 0);
      }
    }
    gl.disable(gl.CULL_FACE);
    // Triangles that are really drawn: each animal's own mesh (the others' vertices are dropped
    // in the vertex shader).
    let tris = 0;
    for (let k = 0; k < n; k++) tris += this.slotTris[Math.floor(w.inst[k * INST_FLOATS + 4] + 0.001)] || 0;
    r._stats.drawCalls++;
    r._stats.tris += tris;
    st.animals = n;
    st.drawCalls = 1;
    st.tris = tris;
    st.verts = m.verts * n;
  }

  // Contact shadows (blending and polygon offset are already set by the overlay pass).
  drawShadows(r, scene, frame) {
    const w = scene.wildlife;
    this.stats.shadows = 0;
    if (!this._ready(w) || !w.shadowCount) return;
    const gl = this.gl;
    const A = r.attribs;
    const p = this.PS;
    r._use(p, frame);
    A.bind(p.a.aCorner, this.quad, 2);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadIdx);
    const n = Math.min(w.shadowCount, MAX_ANIMALS);
    if (this.ctx.inst) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bShadow);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, w.shadow);
      const S = SHADOW_FLOATS * 4;
      A.bind(p.a.iA, this.bShadow, 4, S, 0, 1);
      A.bind(p.a.iB, this.bShadow, 4, S, 16, 1);
      A.bind(p.a.iC, this.bShadow, 4, S, 32, 1);
      A.end();
      this.ctx.inst.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, n);
    } else {
      A.end();
      const c = w.shadow;
      for (let k = 0; k < n; k++) {
        const o = k * SHADOW_FLOATS;
        gl.vertexAttrib4f(p.a.iA, c[o], c[o + 1], c[o + 2], c[o + 3]);
        gl.vertexAttrib4f(p.a.iB, c[o + 4], c[o + 5], c[o + 6], c[o + 7]);
        gl.vertexAttrib4f(p.a.iC, c[o + 8], c[o + 9], c[o + 10], c[o + 11]);
        gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
      }
    }
    r._stats.drawCalls++;
    r._stats.tris += 2 * n;
    this.stats.shadows = n;
    this.stats.drawCalls++;
  }
}

