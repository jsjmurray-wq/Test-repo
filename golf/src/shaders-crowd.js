// Spectator shaders (docs/architecture.md section 10). GLSL 100 like shaders.js, lit by the same
// sky, fog and tone map (COMMON), camera-relative positions.
//
// CROWD_VS/FS: the instanced spectator (crowd-mesh.js personMesh). Per instance iA = (x, y, z,
// yaw), iB = (height scale, seed, flags, skin), iC = (shirt, legs, hat, hair) (crowd.js layout;
// colours packed 8:8:8). The vertex shader poses the mesh's vertex groups exactly like
// crowd-mesh.js posePerson: an idle weight shift and breathing (stiller while the player addresses
// the ball, uHush), the head (and a little of the shoulders) turned to the attention point uLook
// (the ball, also in flight), and the reactions in uReact (two slots: the newest and the one it
// replaces, each (type, t0, x, y), (radius, strength, duration, floor); type 1 clap, 2 cheer,
// 3 ooh, 4 groan): who joins in, the delay and the length are per person, so a gallery never moves
// as one. Seated spectators (grandstand) fold their legs. Hats are shaped per kind; the parasol
// shows only for its holders. People dissolve (ordered dither) near the camera and inside the play
// corridor (uPlay/uPlay2: eye -> ball -> target: never between the camera, the ball, the golfer
// and the target), and fade out far away (uFar).
//
// CROWD_PROP_VS/FS: the gallery furniture (crowd-mesh.js furnitureMesh: ropes, stakes, the
// grandstand), world positions with a "thin" radius per vertex: ropes and stakes widen to a
// minimum on-screen width (uPx metres of radius per metre of distance) and dissolve by the share
// of that width they really cover, so they read as fine lines without shimmering.

import { COMMON } from './shaders.js';
import { PJ, POSES } from './crowd-mesh.js';

const f = (v) => (Number.isInteger(v) ? `${v}.0` : `${v}`);
const v4 = (a) => `vec4(${f(a[0])}, ${f(a[1])}, ${f(a[2])}, ${f(a[3])})`;

// The play corridor (shared by both vertex shaders): nobody and nothing between the camera and the
// ball (within 5 m of that line) or along the line of play from the ball to the target (uPlay2.w m
// near the ball, narrowing to 4 m from 30 to 80 m out).
const PLAY = `
uniform vec4 uPlay;      // corridor: ball xy, target xy
uniform vec4 uPlay2;     // eye xy, on (0/1), half-width near the ball
float playFade(vec2 P) {
  if (uPlay2.z < 0.5) return 1.0;
  vec2 ab = uPlay.zw - uPlay.xy;
  float L = max(length(ab), 1e-3);
  float t = clamp(dot(P - uPlay.xy, ab) / (L * L), 0.0, 1.0);
  float dT = length(P - (uPlay.xy + ab * t));
  float hw = mix(uPlay2.w, 4.0, smoothstep(30.0, 80.0, t * L));
  vec2 eb = uPlay.xy - uPlay2.xy;
  float le = max(dot(eb, eb), 1e-4);
  float te = clamp(dot(P - uPlay2.xy, eb) / le, 0.0, 1.0);
  float dE = length(P - (uPlay2.xy + eb * te));
  return smoothstep(hw, hw + 2.5, dT) * smoothstep(5.0, 7.0, dE);
}`;

export const CROWD_VS = `
attribute vec3 aPos;
attribute vec3 aNrm;
attribute vec4 aAttr;    // part, colour slot, aux (hat ring), baked occlusion
attribute vec4 iA;       // x, y, z, yaw
attribute vec4 iB;       // height scale, seed, flags, skin (packed)
attribute vec4 iC;       // shirt, legs, hat, hair (packed)
uniform mat4 uVP;
uniform vec3 uEye;
uniform float uTime;
uniform vec4 uLook;      // attention point xyz; w: how much heads follow it
uniform vec4 uReact[4];  // slot A: (type, t0, x, y), (radius, strength, dur, floor); slot B
uniform vec2 uNear;      // near-camera dither fade (start, end), m
uniform float uFar;      // nobody drawn beyond this horizontal distance
uniform float uHush;     // 0..1: stillness while the player addresses the ball
varying vec3 vRel;
varying vec3 vN;
varying vec3 vCol;
varying float vFade;
varying float vAO;
${PLAY}

const float HIP_Z = ${f(PJ.HIP_Z)};
const float HIP_Y = ${f(PJ.HIP_Y)};
const float KNEE_Z = ${f(PJ.KNEE_Z)};
const float ANKLE_Z = ${f(PJ.ANKLE_Z)};
const float WAIST_Z = ${f(PJ.WAIST_Z)};
const float SH_Z = ${f(PJ.SHOULDER_Z)};
const float SH_Y = ${f(PJ.SHOULDER_Y)};
const float EL_Z = ${f(PJ.ELBOW_Z)};
const float NECK_Z = ${f(PJ.NECK_Z)};
const float HEAD_Z = ${f(PJ.HEAD_Z)};
// Arm poses: forward raise, abduction, elbow flex, upper-arm twist (crowd-mesh.js POSES).
const vec4 IDLE = ${v4(POSES.idle)};
const vec4 FOLD = ${v4(POSES.folded)};
const vec4 CLASP = ${v4(POSES.clasp)};
const vec4 HOLD = ${v4(POSES.holding)};
const vec4 CLAP_O = ${v4(POSES.clapOpen)};
const vec4 CLAP_S = ${v4(POSES.clapShut)};
const vec4 CHEER = ${v4(POSES.cheer)};
const vec4 OOH = ${v4(POSES.ooh)};
const vec4 MOUTH = ${v4(POSES.mouth)};
const vec4 GROAN = ${v4(POSES.groan)};
const vec4 PARA = ${v4(POSES.parasol)};

float hs(float s, float k) { return fract(sin(s * 91.7 + k * 47.31) * 43758.5453); }
vec3 unpack(float v) {
  float r = floor(v / 65536.0);
  float g = floor((v - r * 65536.0) / 256.0);
  return vec3(r, g, v - r * 65536.0 - g * 256.0) / 255.0;
}
mat3 rX(float a) { float c = cos(a); float s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
mat3 rY(float a) { float c = cos(a); float s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 rZ(float a) { float c = cos(a); float s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }

// One reaction slot blended over the pose: arms (a, phi, b) and body (torso pitch, torso yaw,
// head pitch, bob).
void react(vec4 A, vec4 B, float seed, vec2 P, float para, float sit, inout vec4 armL, inout vec4 armR, inout vec4 body) {
  float type = A.x;
  if (type < 0.5) return;
  float d = length(P - A.zw);
  float fall = mix(B.w, 1.0, 1.0 - smoothstep(B.x, B.x * 2.0, d));
  if (hs(seed, 5.0 + type) > B.y * fall) return;
  bool ooh = type > 2.5 && type < 3.5;
  float delay = ooh ? 0.04 + 0.3 * hs(seed, 6.0) : 0.12 + 0.75 * hs(seed, 7.0);
  float dur = B.z * (0.75 + 0.5 * hs(seed, 8.0));
  float lt = uTime - A.y - delay;
  float env = smoothstep(0.0, ooh ? 0.18 : 0.3, lt) * (1.0 - smoothstep(dur - 0.6, dur, lt));
  if (env <= 0.0) return;
  float ph = seed * 61.0;
  vec4 tL;
  vec4 tR;
  vec4 tb = body;
  if (type < 1.5) {
    // Golf claps: open and shut 2.5-3 times a second, the hands meeting in front of the chest.
    float osc = 0.5 + 0.5 * sin(uTime * (15.5 + 3.5 * hs(seed, 9.0)) + ph);
    tL = mix(CLAP_O, CLAP_S, osc * osc);
    tR = tL;
    tb.x += 0.04;
  } else if (type < 2.5) {
    // Arms up in a V, pumping; some raise one fist and keep the other hand low.
    float pump = sin(uTime * (10.0 + 2.5 * hs(seed, 10.0)) + ph);
    tL = CHEER + vec4(0.12 * pump, 0.0, 0.0, 0.0);
    tR = CHEER - vec4(0.12 * pump, 0.0, 0.0, 0.0);
    if (hs(seed, 11.0) < 0.3) tR = HOLD;
    tb.z += 0.25;
    tb.w = 0.04 * max(0.0, sin(uTime * 9.0 + ph)) * (1.0 - sit);
  } else if (ooh) {
    tL = OOH;
    tR = OOH;
    if (hs(seed, 12.0) < 0.35) {
      tL = MOUTH;
      tR = MOUTH;
    }
    tb.x -= 0.07;
    tb.z += 0.12;
  } else {
    tL = GROAN;
    tR = GROAN;
    tb.x += 0.3;
    tb.z -= 0.45;
    if (hs(seed, 13.0) < 0.35) {
      tR = OOH;
      tb.y += 0.35;
    }
  }
  armL = mix(armL, tL, env);
  if (para < 0.5) armR = mix(armR, tR, env);
  body = mix(body, tb, env);
}

// The hat lathe (unit directions, ring aux) shaped per kind, in the figure's rest frame.
vec3 hatShape(vec3 p, float aux, float k) {
  float cr = 0.108;
  float ch = 0.1;
  float r1 = 0.8;
  float br = 0.19;
  float front = 1.0;
  float drop = 0.01;
  float bz = HEAD_Z + 0.035;
  float ex = 1.0;
  if (k > 1.5 && k < 2.5) { cr = 0.112; ch = 0.11; r1 = 0.85; br = 0.175; front = 0.0; drop = 0.04; bz = HEAD_Z + 0.03; }
  else if (k > 2.5 && k < 3.5) { cr = 0.11; ch = 0.11; r1 = 0.86; br = 0.25; front = 0.0; drop = 0.035; }
  else if (k > 3.5 && k < 4.5) { cr = 0.112; ch = 0.085; r1 = 0.95; br = 0.165; drop = 0.0; bz = HEAD_Z + 0.05; ex = 1.1; }
  else if (k > 4.5) { cr = 0.108; ch = 0.125; r1 = 0.72; br = 0.108; front = 0.0; drop = 0.0; bz = HEAD_Z + 0.02; }
  vec2 d = p.xy;
  if (aux < 0.5) return vec3(0.01, 0.0, bz + ch);
  if (aux < 1.5) return vec3(d.x * cr * r1 * ex, d.y * cr * r1, bz + ch * 0.82);
  if (aux < 2.5) return vec3(d.x * cr * ex, d.y * cr, bz);
  float r = front > 0.5 ? cr + (br - cr) * smoothstep(0.2, 1.0, d.x) : br;
  return vec3(d.x * r * ex + (front > 0.5 ? 0.01 : 0.0), d.y * r, bz - drop);
}

void main() {
  float part = aAttr.x;
  float slot = aAttr.y;
  float seed = iB.y;
  float fl = iB.z;
  float sit = mod(fl, 2.0);
  float hatK = mod(floor(fl / 2.0), 8.0);
  float para = mod(floor(fl / 16.0), 2.0);
  float longS = mod(floor(fl / 32.0), 2.0);
  float shorts = mod(floor(fl / 64.0), 2.0);
  float idle = mod(floor(fl / 128.0), 4.0);
  float S = iB.x;
  float wid = 0.9 + 0.22 * hs(seed, 1.0);
  float ph = seed * 40.0;

  // ---- idle pose: weight shift, breathing; stiller while the ball is addressed
  vec4 armL = IDLE;
  vec4 armR = IDLE;
  if (idle > 2.5) armR = HOLD;
  else if (idle > 1.5) { armL = CLASP; armR = CLASP + vec4(0.0, 0.0, 0.08, 0.0); }
  else if (idle > 0.5) { armL = FOLD; armR = FOLD + vec4(0.08, 0.0, -0.1, -0.05); }
  if (para > 0.5) armR = PARA;
  float still = 1.0 - 0.75 * uHush;
  float sway = sin(uTime * (0.33 + 0.25 * hs(seed, 2.0)) + ph) * still;
  float hipShift = 0.016 * sway * (1.0 - sit);
  float tRoll = -0.025 * sway;
  vec4 body = vec4(0.03 + 0.012 * sin(uTime * 1.3 + ph) * still - 0.1 * sit, 0.0, 0.0, 0.0);

  // ---- attention: the head, and a little of the shoulders, turn to the ball
  vec3 dl = uLook.xyz - (iA.xyz + vec3(0.0, 0.0, 1.6 * S));
  float cyw = cos(iA.w);
  float syw = sin(iA.w);
  vec2 loc = vec2(cyw * dl.x + syw * dl.y, -syw * dl.x + cyw * dl.y);
  float want = atan(loc.y, loc.x);
  float k = uLook.w;
  // A few chat to a neighbour between shots.
  if (hs(seed, 14.0) < 0.12 && k < 0.95) want = mix(want, 1.1 * sign(hs(seed, 15.0) - 0.5), step(0.2, sin(uTime * 0.21 + ph)));
  float tYaw = clamp(want * 0.35, -0.5, 0.5) * k;
  float hYaw = clamp(want - tYaw, -1.2, 1.2) * k;
  body.y = tYaw;
  body.z = clamp(atan(dl.z, length(loc)), -0.55, 0.75) * k;

  // ---- reactions (the older slot first; the newer one wins)
  vec2 P = iA.xy;
  react(uReact[2], uReact[3], seed, P, para, sit, armL, armR, body);
  react(uReact[0], uReact[1], seed, P, para, sit, armL, armR, body);

  // ---- pose this vertex (crowd-mesh.js posePerson)
  vec3 p = aPos;
  vec3 n = aNrm;
  bool hat = part > 10.5 && part < 11.5;
  bool head = (part > 1.5 && part < 2.5) || hat;
  if (hat) p = hatK < 0.5 ? vec3(0.0, 0.0, HEAD_Z) : hatShape(p, aAttr.z, hatK);
  if (part > 11.5 && para < 0.5) p = vec3(0.0, 0.0, 1.2);
  if (!(head || part > 11.5)) p.y *= wid;
  if (part > 6.5 && part < 10.5) {
    // Legs: standing they lean with the hips (feet planted); seated, the thighs fold forward
    // and the shins hang from the knees.
    float side = part < 8.5 ? 1.0 : -1.0;
    vec3 hip = vec3(0.0, side * HIP_Y * wid, HIP_Z);
    if (sit > 0.5) {
      mat3 R = rY(-1.5708);
      if (part < 7.5 || (part > 8.5 && part < 9.5)) { p = hip + R * (p - hip); n = R * n; }
      else p += vec3(HIP_Z - KNEE_Z, 0.0, HIP_Z - KNEE_Z);
    } else p.y += hipShift * clamp((p.z - ANKLE_Z) / (HIP_Z - ANKLE_Z), 0.0, 1.0);
  } else if (part < 0.5) {
    p.y += hipShift;
  } else {
    if (part > 2.5 && part < 6.5) {
      bool left = part < 4.5;
      float side = left ? 1.0 : -1.0;
      vec4 arm = left ? armL : armR;
      vec3 sh = vec3(0.0, side * SH_Y * wid, SH_Z);
      mat3 R = rX(side * arm.y) * rY(-arm.x);
      if (part < 3.5 || (part > 4.5 && part < 5.5)) { p = sh + R * (p - sh); n = R * n; }
      else {
        vec3 el = vec3(0.0, side * SH_Y * wid, EL_Z);
        mat3 E = rZ(-side * arm.w) * rY(-arm.z);
        p = sh + R * ((el - sh) + E * (p - el));
        n = R * (E * n);
      }
    } else if (head) {
      vec3 nk = vec3(0.0, 0.0, NECK_Z);
      mat3 H = rZ(hYaw) * rY(-body.z);
      p = nk + H * (p - nk);
      n = H * n;
    }
    vec3 w = vec3(0.0, 0.0, WAIST_Z);
    mat3 Tm = rZ(body.y) * rX(tRoll) * rY(body.x);
    p = w + Tm * (p - w);
    n = Tm * n;
    p.y += hipShift;
  }
  if (sit > 0.5) p.z -= HIP_Z - KNEE_Z;
  p.z += body.w;
  p *= S;
  vec3 wp = vec3(cyw * p.x - syw * p.y, syw * p.x + cyw * p.y, p.z);
  vN = vec3(cyw * n.x - syw * n.y, syw * n.x + cyw * n.y, n.z);
  vRel = iA.xyz + wp - uEye;
  vAO = aAttr.w;

  // ---- colour by slot
  vec3 skin = unpack(iB.w);
  vec3 shirt = unpack(iC.x);
  vec3 legs = unpack(iC.y);
  vec3 hatC = unpack(iC.z);
  vec3 hair = unpack(iC.w);
  float sh = hs(seed, 16.0);
  vec3 shoes = sh < 0.4 ? vec3(0.92, 0.92, 0.9) : sh < 0.65 ? vec3(0.32, 0.22, 0.15) : sh < 0.85 ? vec3(0.12, 0.12, 0.13) : vec3(0.6, 0.5, 0.38);
  vec3 col = skin;
  if (slot > 0.5 && slot < 1.5) col = shirt;
  else if (slot > 1.5 && slot < 2.5) col = legs;
  else if (slot > 2.5 && slot < 3.5) col = shoes;
  else if (slot > 3.5 && slot < 4.5) col = hatC;
  else if (slot > 4.5 && slot < 5.5) col = hair;
  else if (slot > 5.5 && slot < 6.5) col = hatC;
  else if (slot > 6.5 && slot < 7.5) col = vec3(0.2, 0.2, 0.2);
  else if (slot > 7.5 && slot < 8.5) col = mix(skin, shirt, longS);
  else if (slot > 8.5) col = mix(legs, skin, shorts);
  vCol = col;

  // ---- fades: near the camera, inside the play corridor, far away
  vec3 base = iA.xyz - uEye;
  float fade = smoothstep(uNear.x, uNear.y, length(base + vec3(0.0, 0.0, 1.0)));
  fade *= playFade(P);
  float hd = length(base.xy);
  fade *= 1.0 - smoothstep(uFar * 0.8, uFar, hd);
  vFade = fade;
  gl_Position = uVP * vec4(vRel, 1.0);
  if (hd > uFar || fade < 0.004) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
}`;

export const CROWD_FS = `${COMMON}
varying vec3 vRel;
varying vec3 vN;
varying vec3 vCol;
varying float vFade;
varying float vAO;
void main() {
  if (vFade < 0.999 && vFade < bayer4(gl_FragCoord.xy) * 0.94 + 0.03) discard;
  float dist = length(vRel);
  vec3 v = vRel / max(dist, 1e-4);
  vec3 n = normalize(vN);
  if (dot(n, v) > 0.0) n = -n; // single-sided parts (brims, parasols, hands) lit from the seen side
  vec3 alb = toLin(vCol);
  float ndl = max((dot(n, uSun) + 0.3) / 1.3, 0.0);
  float rim = pow(1.0 - max(dot(n, -v), 0.0), 3.0) * (0.5 + 0.5 * n.z);
  vec3 c = alb * (uSunCol * ndl * (0.55 + 0.45 * vAO) + ambient(n) * (0.8 + 0.5 * vAO));
  c += rim * (uZenith * 0.14 + uSunCol * 0.03) * (0.4 + alb);
  c = applyFog(c, vRel);
  gl_FragColor = vec4(finish(c), 1.0);
}`;

export const CROWD_PROP_VS = `
attribute vec3 aPos;
attribute vec3 aNrm;
attribute vec4 aCol;     // sRGB albedo, thin radius (ropes, stakes; 0 = solid)
uniform mat4 uVP;
uniform vec3 uEye;
uniform float uPx;       // minimum radius per metre of distance (about 0.6 device px)
uniform vec2 uNear;
uniform float uFar;
varying vec3 vRel;
varying vec3 vN;
varying vec3 vCol;
varying float vFade;
${PLAY}
void main() {
  vec3 rel = aPos - uEye;
  float d = length(rel);
  float fade = smoothstep(uNear.x, uNear.y, d) * playFade(aPos.xy);
  if (aCol.w > 0.0) {
    float rr = max(aCol.w, uPx * d);
    rel += aNrm * (rr - aCol.w);
    fade *= aCol.w / rr;
  }
  fade *= 1.0 - smoothstep(uFar * 0.8, uFar, length(rel.xy));
  vRel = rel;
  vN = aNrm;
  vCol = aCol.rgb;
  vFade = fade;
  gl_Position = uVP * vec4(rel, 1.0);
}`;

export const CROWD_PROP_FS = `${COMMON}
varying vec3 vRel;
varying vec3 vN;
varying vec3 vCol;
varying float vFade;
void main() {
  if (vFade < 0.999 && vFade < bayer4(gl_FragCoord.xy) * 0.94 + 0.03) discard;
  float dist = length(vRel);
  vec3 v = vRel / max(dist, 1e-4);
  vec3 n = normalize(vN);
  if (dot(n, v) > 0.0) n = -n;
  vec3 alb = toLin(vCol);
  float ndl = max(dot(n, uSun), 0.0);
  vec3 h = normalize(uSun - v);
  float sp = pow(max(dot(n, h), 0.0), 30.0) * 0.08;
  vec3 c = alb * (uSunCol * ndl + ambient(n) * 1.3) + uSunCol * sp;
  c = applyFog(c, vRel);
  gl_FragColor = vec4(finish(c), 1.0);
}`;
