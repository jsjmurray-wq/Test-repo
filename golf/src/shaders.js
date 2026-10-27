// GLSL 100 shader sources (run unchanged on WebGL1 and WebGL2). All lighting happens in linear
// space; colours from SURFACES and the bake are sRGB-ish albedos converted with pow(2.2). Every
// opaque shader ends with the same exp2 fog toward the sky's horizon colour and a filmic tone map,
// so terrain, trees and sky meet seamlessly at the horizon.
//
// Positions are camera-relative: vertex shaders receive (or compute) p - eye in highp, and uVP is
// projection * view-rotation only. Large world coordinates therefore never meet the view
// translation, which keeps far geometry stable on mobile GPUs.

// Shared fragment chunk: sky model, fog and tone mapping.
const COMMON = `
precision highp float;
uniform vec3 uSun;      // unit vector toward the sun
uniform vec3 uSunCol;   // linear sun radiance
uniform vec3 uZenith;   // linear sky colours
uniform vec3 uHorizon;
uniform float uFogK;    // exp2 fog density (1/m)
uniform float uExposure;

vec3 toLin(vec3 c) { return pow(c, vec3(2.2)); }

// Sky radiance in direction d (unit, z up), without the sun disc.
vec3 skyCol(vec3 d) {
  float e = d.z;
  float up = clamp(e, 0.0, 1.0);
  vec3 c = mix(uHorizon, uZenith, pow(up, 0.55));
  // Ground-bounce darkening below the horizon.
  c = mix(c, uHorizon * vec3(0.78, 0.82, 0.8), clamp(-e * 6.0, 0.0, 1.0));
  float mu = max(dot(d, uSun), 0.0);
  // Mie-like forward glow around the sun and a warm horizon band toward it.
  c += uSunCol * (0.07 * pow(mu, 6.0) + 0.18 * pow(mu, 48.0));
  c += vec3(0.10, 0.07, 0.03) * pow(mu, 3.0) * (1.0 - up);
  return c;
}

// Haze colour used by the fog: the sky just above the horizon in the view direction.
vec3 fogCol(vec3 d) {
  vec3 h = normalize(vec3(d.xy, 0.0) + vec3(0.0, 0.0, 0.035));
  return skyCol(h) * vec3(0.9, 0.93, 0.95);
}

vec3 applyFog(vec3 c, vec3 rel) {
  float d = length(rel);
  float f = 1.0 - exp(-d * d * uFogK * uFogK);
  return mix(c, fogCol(rel / max(d, 1e-4)), f);
}

// ACES filmic fit (Narkowicz) then display gamma.
vec3 finish(vec3 c) {
  c *= uExposure;
  c = clamp((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), 0.0, 1.0);
  return pow(c, vec3(1.0 / 2.2));
}

// Hemisphere ambient: sky-tinted from above, warm grass bounce from below.
vec3 ambient(vec3 n) {
  float k = n.z * 0.5 + 0.5;
  return mix(vec3(0.07, 0.075, 0.045), vec3(0.2, 0.235, 0.29), k);
}

// 4x4 ordered dither threshold in [0, 1) from the pixel position.
float bayer2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
`;

// ---------------------------------------------------------------- sky
export const SKY_VS = `
attribute vec2 aPos;
varying vec2 vNdc;
void main() {
  vNdc = aPos;
  gl_Position = vec4(aPos, 1.0, 1.0); // depth = 1: only fills pixels nothing else covered
}`;

export const SKY_FS = `${COMMON}
uniform mat4 uInvVP;
uniform sampler2D uClouds;
uniform sampler2D uNoise;
uniform float uTime;
uniform vec2 uWind;
varying vec2 vNdc;

float ridge(float u, float k, float row) { return texture2D(uNoise, vec2(u * k, row)).a; }

void main() {
  vec4 p = uInvVP * vec4(vNdc, 1.0, 1.0);
  vec3 d = normalize(p.xyz / p.w);
  vec3 c = skyCol(d);
  float e = d.z;

  // Clouds on a virtual plane: tileable density (R) and a sun-shifted copy (G) for self-shadowing.
  if (e > 0.0) {
    vec2 drift = uTime * (vec2(0.0035, 0.0012) + uWind * 0.0004);
    vec2 uv = d.xy / (e + 0.1) * 0.16 + drift;
    vec4 t = texture2D(uClouds, uv);
    vec4 t2 = texture2D(uClouds, uv * 2.3 + vec2(0.37, 0.11));
    float dens = clamp(t.r * 0.85 + (t2.r - 0.5) * 0.35, 0.0, 1.0);
    float shadow = clamp((t.r - t.g) * 2.5 + 0.5, 0.0, 1.0);
    float mu = max(dot(d, uSun), 0.0);
    vec3 lit = uSunCol * (0.62 + 0.5 * pow(mu, 8.0)) + uZenith * 0.5;
    vec3 cc = mix(lit * 0.62 + vec3(0.06, 0.07, 0.10), lit, shadow);
    float fade = smoothstep(0.015, 0.22, e);
    c = mix(c, cc, dens * fade * 0.92);
    // Thin cirrus.
    c += vec3(0.25, 0.27, 0.3) * texture2D(uClouds, uv * 0.6 + drift * 2.0).b * fade * 0.35;
  }

  // Distant hills: two ridge lines on the horizon, the far one blue with haze, the near one a darker
  // wooded green with a tree-crown fringe. u wraps once around the horizon so the texture tiles.
  float u = atan(d.y, d.x) / 6.2831853 + 0.5;
  float far = 0.016 + 0.05 * ridge(u, 1.0, 0.31) * ridge(u, 2.0, 0.77);
  float near = 0.006 + 0.022 * ridge(u, 2.0, 0.13) + 0.004 * texture2D(uNoise, vec2(u * 24.0, 0.5)).g;
  vec3 hz = fogCol(d);
  // Both ridges sit kilometres away, so they carry most of the haze: the fogged skirt terrain in
  // front of them is already close to hz, and dark ridges would read as a wall on the horizon.
  vec3 farCol = mix(vec3(0.06, 0.1, 0.13), hz, 0.72);
  vec3 nearCol = mix(vec3(0.025, 0.05, 0.025), hz, 0.6);
  c = mix(c, farCol, smoothstep(far + 0.0015, far - 0.0015, e));
  c = mix(c, nearCol, smoothstep(near + 0.001, near - 0.001, e));

  // Sun disc.
  float mu = dot(d, uSun);
  c += uSunCol * 30.0 * smoothstep(0.99985, 0.99993, mu) * step(far, e);
  gl_FragColor = vec4(finish(c), 1.0);
}`;

// ---------------------------------------------------------------- terrain (and skirt)
export const TERRAIN_VS = `
attribute vec3 aPos;     // chunk-local
attribute vec3 aNrm;
uniform mat4 uVP;
uniform vec3 uOff;       // chunk origin - eye
uniform vec2 uOrigin;    // chunk origin (world xy)
varying vec3 vRel;
varying vec2 vWorld;
varying vec3 vN;
void main() {
  vRel = aPos + uOff;
  vWorld = aPos.xy + uOrigin;
  vN = aNrm;
  gl_Position = uVP * vec4(vRel, 1.0);
}`;

export const TERRAIN_FS = `${COMMON}
uniform sampler2D uBake;
uniform sampler2D uNoise;
uniform vec2 uBakeMin;
uniform vec2 uBakeInv;   // 1 / bake extent (m)
uniform vec2 uMow;       // mowing direction (unit, world xy)
uniform float uSkirt;    // 1 for the skirt ring: procedural woodland/rough, no bake
varying vec3 vRel;
varying vec2 vWorld;
varying vec3 vN;

// Signed mowing stripe: lanes of width w across direction dir; the sign of each lane flips with the
// view direction because grass laid away from the viewer reflects more light.
float stripe(vec2 w, vec2 dir, float width, vec2 view, float dist) {
  vec2 perp = vec2(-dir.y, dir.x);
  float s = sin(3.14159265 * dot(w, perp) / width);
  float sharp = clamp(width * 14.0 / (dist + 1.0), 1.0, 8.0);   // crisp near, soft far (no shimmer)
  return clamp(s * sharp, -1.0, 1.0) * dot(view, dir);
}

void main() {
  vec3 n = uSkirt > 0.5 ? vec3(0.0, 0.0, 1.0) : normalize(vN);
  float dist = length(vRel);
  vec3 v = vRel / max(dist, 1e-4);
  vec2 view = normalize(v.xy + vec2(1e-5));
  vec4 nz = texture2D(uNoise, vWorld / 24.0);
  vec4 nzf = texture2D(uNoise, vWorld / 5.0);
  vec4 nz2 = texture2D(uNoise, vWorld / 97.0);
  vec3 alb;
  float mask = 0.0;
  if (uSkirt > 0.5) {
    // Beyond the hole: rough at the grid edge (vN.x = 0) turning into woodland further out.
    float wood = smoothstep(0.35, 0.65, nz2.a * 0.6 + vN.x * 0.55);
    alb = mix(vec3(0.21, 0.37, 0.13), vec3(0.07, 0.14, 0.06), wood) * (0.88 + 0.24 * nz2.r);
  } else {
    vec4 b = texture2D(uBake, (vWorld - uBakeMin) * uBakeInv);
    alb = b.rgb;
    mask = b.a;
  }
  // Grade toward broadcast grass: slightly less saturated than the raw surface albedo.
  alb = toLin(mix(vec3(dot(alb, vec3(0.3, 0.55, 0.15))), alb, 0.86));

  // Grass grain: mipmapped noise at three scales fades out with distance on its own; rough gets more.
  float rough = 1.0 - smoothstep(0.1, 0.45, mask);
  float grain = (nzf.b - 0.5) * 0.22 + (nz.b - 0.5) * 0.14 + (nz.g - 0.5) * 0.12 + (nz.r - 0.5) * 0.10;
  alb *= 1.0 + grain * (0.75 + 1.0 * rough);

  // Mowing: fairway lanes ~9 m wide along the hole; greens get a 1.2 m crosshatch.
  float fair = clamp(1.0 - abs(mask - 0.5) * 4.0, 0.0, 1.0);
  float green = clamp((mask - 0.75) * 4.0, 0.0, 1.0);
  float st = 0.0;
  if (fair > 0.0) st += fair * 0.17 * stripe(vWorld, uMow, 7.0, view, dist);
  if (green > 0.0) {
    vec2 m2 = vec2(-uMow.y, uMow.x);
    st += green * 0.07 * (stripe(vWorld, uMow, 1.2, view, dist) + stripe(vWorld, m2, 1.2, view, dist));
  }
  alb *= 1.0 + st;

  // Light: wrapped Lambert (soft terminator like grass) + hemisphere ambient + a faint sheen.
  float ndl = max((dot(n, uSun) + 0.25) / 1.25, 0.0);
  vec3 h = normalize(uSun - v);
  float sheen = pow(max(dot(n, h), 0.0), 18.0) * (0.03 + 0.05 * (fair + green));
  vec3 c = alb * (uSunCol * ndl + ambient(n)) + uSunCol * sheen * 0.4;
  c = applyFog(c, vRel);
  gl_FragColor = vec4(finish(c), 1.0);
}`;

// ---------------------------------------------------------------- water
export const WATER_VS = `
attribute vec3 aPos;     // world
uniform mat4 uVP;
uniform vec3 uEye;
varying vec3 vRel;
varying vec2 vWorld;
void main() {
  vRel = aPos - uEye;
  vWorld = aPos.xy;
  gl_Position = uVP * vec4(vRel, 1.0);
}`;

export const WATER_FS = `${COMMON}
uniform sampler2D uNoise;
uniform float uTime;
uniform vec2 uWind;
varying vec3 vRel;
varying vec2 vWorld;

vec2 slope(vec2 uv) {
  float e = 1.0 / 256.0;
  float a = texture2D(uNoise, uv).g;
  return vec2(texture2D(uNoise, uv + vec2(e, 0.0)).g - a, texture2D(uNoise, uv + vec2(0.0, e)).g - a);
}

void main() {
  float dist = length(vRel);
  vec3 v = vRel / dist;
  // Two scrolling ripple layers; ripples calm down with distance (mip + explicit fade).
  vec2 w = uWind * 0.004 + vec2(0.006, 0.004);
  vec2 g = slope(vWorld / 30.0 + uTime * w) + slope(vWorld / 13.0 - uTime * w.yx * 1.3);
  float amp = 2.4 / (1.0 + dist * 0.05);
  vec3 n = normalize(vec3(-g * amp, 1.0));
  float cosv = max(dot(-v, n), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - cosv, 5.0);
  vec3 r = reflect(v, n);
  r.z = abs(r.z);
  vec3 refl = skyCol(r);
  vec3 deep = vec3(0.01, 0.04, 0.045) + uSunCol * 0.01;
  vec3 c = mix(deep, refl, fres);
  // Sun glint: tight highlight plus sparkle where the ripples catch the sun.
  float sp = max(dot(r, uSun), 0.0);
  c += uSunCol * (pow(sp, 600.0) * 12.0 + pow(sp, 60.0) * 0.25);
  c = applyFog(c, vRel);
  gl_FragColor = vec4(finish(c), mix(0.82, 1.0, fres));
}`;

// ---------------------------------------------------------------- trees (instanced)
export const TREE_VS = `
attribute vec3 aPos;
attribute vec3 aNrm;
attribute vec2 aAttr;    // part (0 trunk, 1 canopy), baked AO
attribute vec4 iA;       // base x, y, z, canopy centre height above base
attribute vec4 iB;       // canopy rx, rz, trunk radius, random seed 0..1
uniform mat4 uVP;
uniform vec3 uEye;
uniform float uTime;
uniform vec2 uWind;
uniform vec3 uTint;      // base canopy colour (sRGB) for this tree kind
uniform vec2 uFade;      // dither-fade distances (start, end)
varying vec3 vLocal;
varying vec3 vRel;
varying vec3 vN;
varying vec3 vCol;
varying float vAO;
varying float vFade;
void main() {
  float ch = iA.w;
  float rx = iB.x;
  float rz = iB.y;
  vec3 p;
  vec3 n;
  if (aAttr.x < 0.5) {
    p = vec3(aPos.xy * iB.z, aPos.z * ch);
    n = aNrm;
    vCol = vec3(0.30, 0.22, 0.15) * (0.8 + 0.4 * iB.w);
  } else {
    p = vec3(aPos.xy * rx, ch + aPos.z * rz);
    n = normalize(aNrm / vec3(rx, rx, rz));
    // Gentle sway grows toward the crown; stronger with wind.
    float k = (aPos.z + 1.0) * 0.5;
    float wl = length(uWind);
    vec2 wd = wl > 0.01 ? uWind / wl : vec2(0.7, 0.7);
    float s = sin(uTime * (1.1 + 0.4 * iB.w) + iB.w * 40.0) * (0.04 + 0.02 * wl);
    p.xy += wd * (s + 0.015 * wl) * k * k * rz;
    // Hue jitter: some trees yellower, some bluer, some darker.
    float j = fract(iB.w * 7.31);
    vec3 tint = uTint * (0.82 + 0.36 * fract(iB.w * 3.7));
    vCol = mix(tint * vec3(1.18, 1.08, 0.8), tint * vec3(0.85, 0.98, 1.12), j);
  }
  vAO = aAttr.y;
  vLocal = aPos * vec3(1.0, 1.0, 1.4) + iB.w * 13.0;
  vN = n;
  vRel = iA.xyz + p - uEye;
  vFade = smoothstep(uFade.x, uFade.y, length(vRel.xy - vec2(0.0)) - rx * 0.5);
  gl_Position = uVP * vec4(vRel, 1.0);
}`;

export const TREE_FS = `${COMMON}
uniform sampler2D uNoise;
varying vec3 vLocal;
varying vec3 vRel;
varying vec3 vN;
varying vec3 vCol;
varying float vAO;
varying float vFade;
void main() {
  if (vFade < 0.999 && vFade < bayer4(gl_FragCoord.xy) * 0.94 + 0.03) discard;
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  vec3 v = normalize(vRel);
  // Leaf-clump breakup: two noise lookups in the tree's own unit space.
  float leaf = texture2D(uNoise, vLocal.xy * 0.45 + vLocal.z * 0.31).g * 0.6 + texture2D(uNoise, vLocal.yz * 0.9).r * 0.4;
  vec3 alb = toLin(vCol) * (0.6 + 0.8 * leaf);
  float ndl = max((dot(n, uSun) + 0.45) / 1.45, 0.0) * (0.7 + 0.6 * leaf);
  // Leaves glow when backlit.
  float trans = pow(max(dot(v, uSun), 0.0), 4.0) * 0.35;
  vec3 c = alb * (uSunCol * (ndl * (0.35 + 0.65 * vAO) + trans) + ambient(n) * (0.4 + 0.6 * vAO));
  c = applyFog(c, vRel);
  gl_FragColor = vec4(finish(c), 1.0);
}`;

// ---------------------------------------------------------------- lit vertex-coloured props, ball
export const PROP_VS = `
attribute vec3 aPos;
attribute vec3 aNrm;
attribute vec3 aCol;
uniform mat4 uVP;
uniform vec3 uOff;       // added after scaling: -eye for world-space props, ball - eye for the ball
uniform float uScale;
varying vec3 vRel;
varying vec3 vN;
varying vec3 vCol;
void main() {
  vRel = aPos * uScale + uOff;
  vN = aNrm;
  vCol = aCol;
  gl_Position = uVP * vec4(vRel, 1.0);
}`;

export const PROP_FS = `${COMMON}
uniform float uSpec;
varying vec3 vRel;
varying vec3 vN;
varying vec3 vCol;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(vRel);
  vec3 alb = toLin(vCol);
  float ndl = max(dot(n, uSun), 0.0);
  vec3 h = normalize(uSun - v);
  float sp = pow(max(dot(n, h), 0.0), 40.0) * uSpec;
  vec3 c = alb * (uSunCol * ndl + ambient(n) * 1.4) + uSunCol * sp;
  c = applyFog(c, vRel);
  gl_FragColor = vec4(finish(c), 1.0);
}`;

// ---------------------------------------------------------------- flagstick + waving cloth
export const FLAG_VS = `
attribute vec3 aPos;
attribute vec3 aNrm;
attribute vec3 aAttr;    // part, u, v
uniform mat4 uVP;
uniform vec3 uOff;       // cup - eye
uniform float uPoleR;    // pole radius (m), widened far away so the pin stays visible
uniform float uFlagS;    // cloth scale
uniform float uPoleH;
uniform float uTime;
uniform vec2 uWind;
varying vec3 vRel;
varying vec3 vN;
varying vec3 vCol;
void main() {
  vec3 p;
  vec3 n;
  if (aAttr.x < 0.5) {
    p = vec3(aPos.xy * uPoleR, aPos.z);
    n = aNrm;
    // White pole with a darker band every 30 cm near the top for scale.
    vCol = mix(vec3(0.92, 0.92, 0.88), vec3(0.75, 0.1, 0.08), step(0.5, fract(aPos.z / 0.3)) * step(uPoleH - 0.6, aPos.z));
  } else {
    float wl = length(uWind);
    vec2 wd = wl > 0.05 ? uWind / wl : vec2(0.8, 0.6);
    // Drooping in calm air, flying in a breeze. Never fully limp: a limp cloth folds into the
    // pole's plane and vanishes edge-on, and the flag is the player's target from 200 m out.
    float stiff = 0.55 + 0.45 * smoothstep(0.3, 7.0, wl);
    vec3 along = normalize(vec3(wd * stiff, -(1.0 - stiff) * 1.4));
    vec3 side = vec3(-wd.y, wd.x, 0.0);
    float L = 0.52 * uFlagS;
    float Hh = 0.36 * uFlagS;
    float u = aAttr.y;
    float ph = u * 7.0 - uTime * (3.5 + wl * 0.9);
    float amp = (0.035 + 0.012 * wl) * uFlagS * u;
    vec3 top = vec3(0.0, 0.0, uPoleH - 0.02);
    p = top + along * u * L - vec3(0.0, 0.0, (1.0 - aAttr.z) * Hh) + side * sin(ph) * amp
        + vec3(0.0, 0.0, -u * u * (1.0 - stiff) * 0.06 * uFlagS);
    n = normalize(side - along * cos(ph) * amp * 7.0 / L);
    vCol = vec3(0.98, 0.82, 0.06);
  }
  vN = n;
  vRel = p + uOff;
  gl_Position = uVP * vec4(vRel, 1.0);
}`;

export const FLAG_FS = `${COMMON}
varying vec3 vRel;
varying vec3 vN;
varying vec3 vCol;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(vRel);
  if (dot(n, v) > 0.0) n = -n;   // two-sided cloth
  vec3 alb = toLin(vCol);
  float ndl = max(dot(n, uSun), 0.0) + 0.25 * max(dot(-n, uSun), 0.0);
  vec3 c = alb * (uSunCol * ndl + ambient(n) * 1.2);
  c = applyFog(c, vRel);
  gl_FragColor = vec4(finish(c), 1.0);
}`;

// ---------------------------------------------------------------- overlays (trail, aim, blob shadow, far ball)
// aMisc = (u, v, alpha). uMode: 0 trail (soft edges), 1 dashed ground line (u < 0: solid ring),
// 2 radial blob shadow (u, v in -1..1), 3 far-ball billboard disc.
export const OVERLAY_VS = `
attribute vec3 aPos;     // camera-relative
attribute vec3 aMisc;
uniform mat4 uVP;
varying vec3 vMisc;
varying vec3 vRel;
void main() {
  vMisc = aMisc;
  vRel = aPos;
  gl_Position = uVP * vec4(aPos, 1.0);
}`;

export const OVERLAY_FS = `
precision highp float;
uniform vec4 uColor;     // display-space rgb, alpha
uniform float uMode;
uniform float uTime;
varying vec3 vMisc;
varying vec3 vRel;
void main() {
  float a = uColor.a * vMisc.z;
  vec3 c = uColor.rgb;
  if (uMode < 0.5) {
    float e = abs(vMisc.y);
    a *= 1.0 - smoothstep(0.35, 1.0, e);
    c = mix(c, vec3(1.0), 0.6 * (1.0 - smoothstep(0.0, 0.5, e)));   // hot core
  } else if (uMode < 1.5) {
    float e = abs(vMisc.y);
    a *= 1.0 - smoothstep(0.55, 1.0, e);
    if (vMisc.x >= 0.0) {
      float dash = fract(vMisc.x / 2.4 - uTime * 0.35);
      a *= smoothstep(0.0, 0.08, dash) * (1.0 - smoothstep(0.5, 0.58, dash));
    }
  } else if (uMode < 2.5) {
    float r = length(vMisc.xy);
    a *= (1.0 - smoothstep(0.2, 1.0, r));
  } else {
    float r = length(vMisc.xy);
    a *= 1.0 - smoothstep(0.7, 1.0, r);
    c *= 1.0 - 0.18 * smoothstep(0.0, 1.0, length(vMisc.xy + vec2(0.35, -0.35)));
  }
  if (a < 0.003) discard;
  gl_FragColor = vec4(c, a);
}`;

// ---------------------------------------------------------------- green-read overlay
export const READ_VS = `
attribute vec3 aPos;     // relative to green centre (xy), absolute z
attribute vec3 aGrad;    // dz/dx, dz/dy, edge mask
uniform mat4 uVP;
uniform vec3 uOff;       // (green centre xy, 0) - eye
uniform vec2 uCenter;
varying vec2 vWorld;
varying vec3 vGrad;
varying vec3 vRel;
void main() {
  vRel = aPos + uOff;
  vWorld = aPos.xy + uCenter;
  vGrad = aGrad;
  gl_Position = uVP * vec4(vRel, 1.0);
}`;

export const READ_FS = `
precision highp float;
uniform float uTime;
uniform float uChevrons;
uniform float uAlpha;
varying vec2 vWorld;
varying vec3 vGrad;
varying vec3 vRel;

// Slope colour ramp (percent grade): flat blue -> green -> yellow -> red.
vec3 slopeCol(float s) {
  vec3 c = mix(vec3(0.2, 0.45, 1.0), vec3(0.2, 0.95, 0.5), smoothstep(0.5, 1.5, s));
  c = mix(c, vec3(1.0, 0.9, 0.15), smoothstep(1.5, 2.6, s));
  return mix(c, vec3(1.0, 0.25, 0.15), smoothstep(2.6, 4.0, s));
}

void main() {
  float mask = vGrad.z;
  if (mask <= 0.0) discard;
  float dist = length(vRel);
  vec2 g = vGrad.xy;
  float s = length(g) * 100.0;
  // 1 m grid lines, widened with distance so they never alias away.
  vec2 f = abs(fract(vWorld) - 0.5);
  float lw = 0.007 + dist * 0.0009;
  float line = 1.0 - smoothstep(lw, lw * 2.0, 0.5 - max(f.x, f.y));
  vec3 c = slopeCol(s);
  float a = 0.12 + 0.45 * line;
  // Chevrons flowing downhill, faster on steeper ground.
  if (uChevrons > 0.5 && s > 0.4) {
    vec2 dn = -g / length(g);
    vec2 q = fract(vWorld / 1.5) - 0.5;       // 1.5 m cells
    float al = dot(q, dn);
    float ac = dot(q, vec2(-dn.y, dn.x));
    al = fract(al + 0.5 - uTime * (0.15 + s * 0.08)) - 0.5;
    float chev = 1.0 - smoothstep(0.025, 0.05, abs(al + abs(ac) * 0.9 - 0.05));
    chev *= 1.0 - smoothstep(0.14, 0.18, abs(ac));
    c = mix(c, vec3(1.0), chev * 0.8);
    a = max(a, chev * 0.85);
  }
  gl_FragColor = vec4(c, a * mask * uAlpha);
}`;
