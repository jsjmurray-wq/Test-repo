// GLSL 100 shader sources (run unchanged on WebGL1 and WebGL2). All lighting happens in linear
// space; colours from SURFACES and the bake are sRGB-ish albedos converted with pow(2.2). Every
// opaque shader ends with the same exp2 fog toward the sky's horizon colour and a filmic tone map,
// so terrain, trees and sky meet seamlessly at the horizon.
//
// Positions are camera-relative: vertex shaders receive (or compute) p - eye in highp, and uVP is
// projection * view-rotation only. Large world coordinates therefore never meet the view
// translation, which keeps far geometry stable on mobile GPUs.

import { BONE_COUNT } from './golfer.js';

// Shared fragment chunk: sky model, fog and tone mapping. Every colour constant of the look comes
// from the course theme (themes.js) through uniforms; parkland's values are the shipped constants.
const COMMON = `
precision highp float;
uniform vec3 uSun;      // unit vector toward the sun
uniform vec3 uSunCol;   // linear sun radiance
uniform vec3 uZenith;   // linear sky colours
uniform vec3 uHorizon;
uniform float uFogK;    // exp2 fog density (1/m)
uniform float uExposure;
uniform vec3 uHaze;     // tint the fog applies to the sky colour near the horizon
uniform vec4 uFogTint;  // rgb + amount: an explicit fog colour (0 = the sky's own haze)
uniform float uAerial;  // strength of the far aerial haze (0.8 shipped)
uniform float uAerialK; // scale of the distances (200..1400 m shipped) over which it builds up
uniform vec3 uAmbSky;   // hemisphere ambient from above
uniform vec3 uAmbGround; // and the ground bounce from below

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
  return mix(skyCol(h) * uHaze, uFogTint.rgb, uFogTint.a);
}

// exp2 fog, plus aerial perspective that takes anything past ~200 m most of the way to the haze
// colour by 1.4 km. The far skirt and woods then grade smoothly up into the (lighter still) ridge
// silhouettes and the sky: nearer is darker, further is lighter, and no dark band forms between
// the tree line and the hills.
float fogF(float d) {
  float f = 1.0 - exp(-d * d * uFogK * uFogK);
  return max(f, uAerial * smoothstep(200.0 * uAerialK, 1400.0 * uAerialK, d));
}
vec3 applyFog(vec3 c, vec3 rel) {
  float d = length(rel);
  return mix(c, fogCol(rel / max(d, 1e-4)), fogF(d));
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
  return mix(uAmbGround, uAmbSky, k);
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
uniform vec4 uCloud;     // cover, shift, grey (theme clouds): density = clamp(d * cover + shift)
uniform vec3 uRidgeFar;  // horizon silhouette colours before the haze
uniform vec3 uRidgeNear;
uniform vec4 uHz;        // x: silhouette kind (0 hills, 1 mountains, 2 mesas, 3 dunes),
                         // y, z: haze mixed into the far / near silhouette
uniform vec4 uSea;       // xy: direction of the sea (unit, world), z: cos of the sector half-angle
                         // (< -1: all round), w: 1 when the hole has a sea
uniform vec4 uSea2;      // x: eye height above the sea (m), y: most haze the sea takes,
                         // z: swell (least cosine of the view to the water)
uniform vec3 uSeaCol;    // deep sea colour (linear)
varying vec2 vNdc;

float ridge(float u, float k, float row) { return texture2D(uNoise, vec2(u * k, row)).a; }

// How much the view direction looks out to sea (0..1, soft at the sector's edges).
float seaMask(vec3 d) {
  if (uSea.w < 0.5) return 0.0;
  vec2 h = normalize(d.xy + vec2(1e-6, 0.0));
  return smoothstep(uSea.z - 0.12, uSea.z + 0.12, dot(h, uSea.xy));
}

// The open sea below the horizon, beyond the far plane: deep water mixed with the reflected sky.
// Wave facets keep it from mirroring the sky at grazing angles, so it stays a little darker than
// the sky and the horizon reads as a crisp line; the haze is capped so the sea stays blue.
vec3 seaFar(vec3 d) {
  float cosv = min(1.0, max(-d.z, 0.0) + uSea2.z);
  float fres = 0.02 + 0.98 * pow(1.0 - cosv, 5.0);
  vec3 c = mix(uSeaCol + uSunCol * 0.01, skyCol(vec3(d.xy, -d.z)), fres);
  float D = uSea2.x / max(-d.z, 1e-4);
  return mix(c, fogCol(d), min(fogF(D), uSea2.y));
}

void main() {
  vec4 p = uInvVP * vec4(vNdc, 1.0, 1.0);
  vec3 d = normalize(p.xyz / p.w);
  vec3 c = skyCol(d);
  float e = d.z;
  float sea = seaMask(d);
  if (sea > 0.0 && e < 0.0) c = mix(c, seaFar(d), sea);

  // Clouds on a virtual plane: tileable density (R) and a sun-shifted copy (G) for self-shadowing.
  if (e > 0.0) {
    vec2 drift = uTime * (vec2(0.0035, 0.0012) + uWind * 0.0004);
    vec2 uv = d.xy / (e + 0.1) * 0.16 + drift;
    vec4 t = texture2D(uClouds, uv);
    vec4 t2 = texture2D(uClouds, uv * 2.3 + vec2(0.37, 0.11));
    float dens = clamp(t.r * 0.85 + (t2.r - 0.5) * 0.35, 0.0, 1.0);
    dens = clamp(dens * uCloud.x + uCloud.y, 0.0, 1.0);
    float shadow = clamp((t.r - t.g) * 2.5 + 0.5, 0.0, 1.0);
    float mu = max(dot(d, uSun), 0.0);
    vec3 lit = uSunCol * (0.62 + 0.5 * pow(mu, 8.0)) + uZenith * 0.5;
    vec3 cc = mix(lit * 0.62 + vec3(0.06, 0.07, 0.10), lit, shadow);
    // Overcast: a grey deck with darker, heavier bases.
    cc = mix(cc, vec3(dot(cc, vec3(0.3, 0.5, 0.2))) * vec3(0.82, 0.87, 0.95) * (0.48 + 0.4 * shadow), uCloud.z);
    float fade = smoothstep(0.015, 0.22, e);
    c = mix(c, cc, dens * fade * 0.92);
    // Thin cirrus.
    c += vec3(0.25, 0.27, 0.3) * texture2D(uClouds, uv * 0.6 + drift * 2.0).b * fade * 0.35;
  }

  // Horizon silhouettes: two lines, the far one hazier. u wraps once around the horizon so the
  // texture tiles (integer frequencies only).
  float u = atan(d.y, d.x) / 6.2831853 + 0.5;
  float far;
  float near;
  vec3 nearTone = vec3(1.0);
  if (uHz.x < 0.5) {
    // Hills: blue far ridges, a darker wooded near line with a tree-crown fringe.
    far = 0.016 + 0.05 * ridge(u, 1.0, 0.31) * ridge(u, 2.0, 0.77);
    near = 0.006 + 0.022 * ridge(u, 2.0, 0.13) + 0.004 * texture2D(uNoise, vec2(u * 24.0, 0.5)).g;
  } else if (uHz.x < 1.5) {
    // Mountains: jagged ranges with peaks.
    float m = clamp((ridge(u, 3.0, 0.21) * 0.6 + ridge(u, 9.0, 0.57) * 0.3 + ridge(u, 29.0, 0.83) * 0.1 - 0.36) * 3.2, 0.0, 1.0);
    far = 0.012 + 0.075 * m * m;
    near = 0.005 + 0.02 * clamp((ridge(u, 5.0, 0.4) - 0.4) * 3.0, 0.0, 1.0);
  } else if (uHz.x < 2.5) {
    // Mesas: distant blue-violet ranges behind flat-topped red buttes with sheer cliffs and talus
    // aprons, their rock banded by the strata.
    float m = clamp((ridge(u, 3.0, 0.21) * 0.6 + ridge(u, 11.0, 0.57) * 0.3 + ridge(u, 31.0, 0.83) * 0.1 - 0.36) * 2.6, 0.0, 1.0);
    far = 0.012 + 0.05 * m;
    float n1 = ridge(u, 7.0, 0.37);
    float n2 = ridge(u, 17.0, 0.63);
    // Cliffs steep but not plumb (a slight taper), an uneven caprock with notches, a stepped tier.
    float butte = smoothstep(0.503, 0.516, n1);
    float tier = smoothstep(0.545, 0.556, n2) * butte;
    float cap = 0.0022 * (ridge(u, 61.0, 0.5) - 0.5) + 0.0016 * (ridge(u, 149.0, 0.21) - 0.5) - 0.0028 * smoothstep(0.78, 0.86, ridge(u, 37.0, 0.44));
    float talus = smoothstep(0.38, 0.505, n1);
    float base = 0.003 + 0.016 * talus * talus * (3.0 - 2.0 * talus);
    near = max(base, sqrt(butte) * (0.036 + 0.01 * tier + cap));
    // Talus slopes darker (shadow, scrub), red cliffs above with faint strata, a paler cap. The
    // flanks are lit or in shade by which way they face the sun (the side where the butte rises
    // with u faces clockwise of the view).
    float cliff = smoothstep(base + 0.0006, base + 0.0016, e);
    float band = smoothstep(0.3, 0.7, fract(e / 0.0042 + 0.3 * ridge(u, 23.0, 0.9)));
    float g = ridge(u + 0.0012, 7.0, 0.37) - ridge(u - 0.0012, 7.0, 0.37);
    float flank = clamp(abs(g) * 160.0, 0.0, 1.0) * (1.0 - smoothstep(0.85, 1.0, butte));
    vec2 vd = normalize(d.xy + vec2(1e-6, 0.0));
    vec2 fn = normalize(-vd + sign(g) * flank * 1.6 * vec2(vd.y, -vd.x));
    float lit = clamp(dot(fn, normalize(uSun.xy + vec2(1e-6, 0.0))) * 0.5 + 0.5, 0.0, 1.0);
    nearTone = mix(vec3(0.62, 0.6, 0.66), vec3(1.04, 0.96, 0.9) * (0.93 + 0.1 * band) * mix(0.66, 1.12, lit), cliff);
    nearTone *= 1.0 + 0.16 * smoothstep(near - 0.0012, near - 0.0002, e);
  } else {
    // Dunes: low, smooth swells.
    far = 0.006 + 0.014 * ridge(u, 3.0, 0.31);
    near = 0.0025 + 0.007 * ridge(u, 11.0, 0.13) + 0.002 * ridge(u, 37.0, 0.71);
  }
  // Toward the sea the land falls away to a flat sea horizon (headlands taper into it).
  far = far * (1.0 - sea) - 0.003 * sea;
  near = near * (1.0 - sea) - 0.003 * sea;
  vec3 hz = fogCol(d);
  // Both ridges sit kilometres away, so they carry most of the haze: the fogged skirt terrain in
  // front of them is already close to hz, and dark ridges would read as a wall on the horizon.
  vec3 farCol = mix(uRidgeFar, hz, uHz.y);
  vec3 nearCol = mix(uRidgeNear * nearTone, hz, uHz.z);
  c = mix(c, farCol, smoothstep(far + 0.0015, far - 0.0015, e) * (1.0 - sea));
  c = mix(c, nearCol, smoothstep(near + 0.001, near - 0.001, e) * (1.0 - sea));

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
varying float vZ;        // world height
void main() {
  vRel = aPos + uOff;
  vWorld = aPos.xy + uOrigin;
  vN = aNrm;
  vZ = aPos.z;
  gl_Position = uVP * vec4(vRel, 1.0);
}`;

export const TERRAIN_FS = `${COMMON}
uniform sampler2D uBake;
uniform sampler2D uNoise;
uniform sampler2D uDetail;  // where the close-up ground detail goes: r desert, g waste, b fescue,
                            // a revetted sod face (bake.js; a black texel when the hole has none)
uniform vec2 uBakeMin;
uniform vec2 uBakeInv;   // 1 / bake extent (m)
uniform vec2 uMow;       // mowing direction (unit, world xy)
uniform float uSkirt;    // 1 for the skirt ring: procedural woodland/rough, no bake
uniform float uStripe;   // mowing-stripe strength (theme)
uniform vec3 uSkirtNear; // skirt ground at the grid edge / far out (sRGB albedo, theme)
uniform vec3 uSkirtFar;
uniform vec4 uSkirtDetail; // the ground detail the skirt gets
uniform float uSkirtInv; // 1 / size (m) of the skirt's broad colour variation (97 m shipped)
uniform float uSkirtBlend; // 1: the skirt starts as the (blurred) colour of the grid's edge and
                           // turns into its own ground over the first band (no seam; 0 shipped)
uniform vec4 uBeach;     // x: sea level, y: 1 when there is a sea (the skirt turns to sand there)
uniform vec3 uSand;      // beach sand albedo
uniform vec3 uRevet;     // sod colour of revetted bunker faces
uniform vec4 uDetailK;   // detail strengths: rake lines, pebbles and scrub, fescue sheen
uniform float uTime;
uniform vec2 uWind;
varying vec3 vRel;
varying vec2 vWorld;
varying vec3 vN;
varying float vZ;

// Signed mowing stripe: lanes of width w across direction dir; the sign of each lane flips with the
// view direction because grass laid away from the viewer reflects more light.
float stripe(vec2 w, vec2 dir, float width, vec2 view, float dist) {
  vec2 perp = vec2(-dir.y, dir.x);
  float s = sin(3.14159265 * dot(w, perp) / width);
  float sharp = clamp(width * 14.0 / (dist + 1.0), 1.0, 8.0);   // crisp near, soft far (no shimmer)
  return clamp(s * sharp, -1.0, 1.0) * dot(view, dir);
}

// Close-up texture of the version 2 grounds (linear albedo in, out), weighted by dm.
vec3 groundDetail(vec3 alb, vec4 dm, float dist, vec4 nz, vec4 nzf) {
  float near = 1.0 - smoothstep(18.0, 60.0, dist);
  if (dm.r > 0.004) {
    // Desert floor: dark basalt and pale quartz pebbles (a few cm), olive tufts of dry scrub.
    float h1 = texture2D(uNoise, vWorld / 9.0).b;
    float h2 = texture2D(uNoise, vWorld / 9.0 + vec2(0.5, 0.25)).b;
    float peb = smoothstep(0.83, 0.89, h1) * near * uDetailK.y;
    vec3 pc = h2 > 0.5 ? alb * 0.4 : alb * 1.4 + vec3(0.02);
    float sc = texture2D(uNoise, vWorld / 41.0 + vec2(0.31, 0.77)).b;   // 16 cm cells
    float scrub = smoothstep(0.88, 0.95, sc) * (1.0 - smoothstep(30.0, 90.0, dist)) * uDetailK.y;
    vec3 scrubCol = mix(alb * vec3(0.5, 0.55, 0.42), toLin(vec3(0.36, 0.35, 0.22)), 0.5);
    alb = mix(alb, scrubCol, dm.r * scrub * 0.8);
    alb = mix(alb, pc, dm.r * peb);
  }
  if (dm.g > 0.004) {
    // Waste area: rake lines along the hole (wavering), a few stones.
    float wob = (nz.g - 0.5) * 0.8 + (nzf.r - 0.5) * 0.15;
    float rk = sin((dot(vWorld, vec2(-uMow.y, uMow.x)) + wob) * 6.2831853 / 0.18);
    float rf = (1.0 - smoothstep(5.0, 24.0, dist)) * uDetailK.x;
    alb *= 1.0 + dm.g * rk * 0.08 * rf;
    float h3 = texture2D(uNoise, vWorld / 9.0 + vec2(0.13, 0.71)).b;
    alb = mix(alb, alb * 0.6, dm.g * smoothstep(0.93, 0.96, h3) * near * uDetailK.y);
  }
  if (dm.b > 0.004) {
    // Fescue: wispy streaks combed down-wind, golden tops over grey-green bases, and bright bands
    // of wind sheen rolling across it.
    vec2 wd = normalize(uWind + vec2(0.35, 0.22));
    vec2 q = vec2(dot(vWorld, wd), dot(vWorld, vec2(-wd.y, wd.x)));
    float wisp = texture2D(uNoise, vec2(q.x / 13.0, q.y / 1.3)).g;
    float wisp2 = texture2D(uNoise, vec2(q.x / 5.0, q.y / 0.6) + 0.5).g;
    float clump = texture2D(uNoise, vWorld / 17.0).r;
    float nf = 1.0 - smoothstep(12.0, 45.0, dist);
    vec3 straw = alb * vec3(1.12, 1.05, 0.86);
    vec3 base = alb * vec3(0.72, 0.9, 0.82);
    vec3 f = mix(base, straw, smoothstep(0.3, 0.7, clump * 0.7 + wisp * 0.3));
    f *= 1.0 + ((wisp - 0.5) * 0.3 + (wisp2 - 0.5) * 0.3 + (nzf.b - 0.5) * 0.2) * (0.35 + 0.65 * nf);
    float band = texture2D(uNoise, vec2(q.x / 60.0 - uTime * 0.03, q.y / 70.0)).r;
    float band2 = texture2D(uNoise, vec2(q.x / 23.0 - uTime * 0.055, q.y / 31.0)).g;
    float sheen = smoothstep(0.5, 0.75, band * 0.7 + band2 * 0.3) * uDetailK.z;
    f = mix(f, f * 1.3 + toLin(vec3(0.08, 0.08, 0.06)), sheen * 0.5);
    alb = mix(alb, f, dm.b);
  }
  if (dm.a > 0.004) {
    // Revetted face: stacked sod layers about 11 cm thick.
    float layer = fract(vZ / 0.11 + nzf.r * 0.3);
    float seam = smoothstep(0.0, 0.14, layer) * (1.0 - smoothstep(0.84, 1.0, layer));
    vec3 sod = toLin(uRevet) * (0.62 + 0.45 * seam) * (0.85 + 0.3 * nzf.g);
    alb = mix(alb, sod, clamp(dm.a, 0.0, 1.0));
  }
  return alb;
}

void main() {
  vec3 n = uSkirt > 0.5 ? vec3(0.0, 0.0, 1.0) : normalize(vN);
  float dist = length(vRel);
  vec3 v = vRel / max(dist, 1e-4);
  vec2 view = normalize(v.xy + vec2(1e-5));
  vec4 nz = texture2D(uNoise, vWorld / 24.0);
  vec4 nzf = texture2D(uNoise, vWorld / 5.0);
  vec4 nz2 = texture2D(uNoise, vWorld * uSkirtInv);
  vec3 alb;
  float mask = 0.0;
  vec4 dm;
  if (uSkirt > 0.5) {
    // Beyond the hole: rough at the grid edge (vN.x = 0) turning into woodland further out (or
    // the theme's desert, jungle or dunes); sand at the waterline toward a sea.
    float wood = smoothstep(0.35, 0.65, nz2.a * 0.6 + vN.x * 0.55);
    // (Woodland seen from above is canopy tops in sun, not shadow: a mid green, not near black.)
    alb = mix(uSkirtNear, uSkirtFar, wood) * (0.88 + 0.24 * nz2.r);
    dm = uSkirtDetail;
    if (uSkirtBlend > 0.5) {
      vec3 edge = texture2D(uBake, clamp((vWorld - uBakeMin) * uBakeInv, 0.0, 1.0), 4.0).rgb;
      alb = mix(edge, alb, smoothstep(0.0, 0.45, vN.x));
    }
    if (uBeach.y > 0.5) {
      // (Below the waterline the sand darkens into the deep sea bed.)
      float b = (1.0 - smoothstep(uBeach.x + 0.6, uBeach.x + 1.8, vZ + (nz.r - 0.5) * 0.5)) * smoothstep(0.05, 0.5, vN.y);
      alb = mix(alb, uSand * (0.92 + 0.12 * nz.g) * (1.0 - 0.82 * clamp((uBeach.x - 0.3 - vZ) / 3.3, 0.0, 1.0)), b);
      dm *= 1.0 - b;
    }
  } else {
    vec2 buv = (vWorld - uBakeMin) * uBakeInv;
    vec4 b = texture2D(uBake, buv);
    alb = b.rgb;
    mask = b.a;
    dm = texture2D(uDetail, buv);
  }
  // Grade toward broadcast grass: slightly less saturated than the raw surface albedo.
  alb = toLin(mix(vec3(dot(alb, vec3(0.3, 0.55, 0.15))), alb, 0.86));

  // Grass grain: mipmapped noise at three scales fades out with distance on its own; rough gets more.
  float rough = 1.0 - smoothstep(0.1, 0.45, mask);
  float grain = (nzf.b - 0.5) * 0.22 + (nz.b - 0.5) * 0.14 + (nz.g - 0.5) * 0.12 + (nz.r - 0.5) * 0.10;
  alb *= 1.0 + grain * (0.75 + 1.0 * rough);
  if (dm.r + dm.g + dm.b + dm.a > 0.004) alb = groundDetail(alb, dm, dist, nz, nzf);

  // Mowing: fairway lanes ~9 m wide along the hole; greens get a 1.2 m crosshatch.
  float fair = clamp(1.0 - abs(mask - 0.5) * 4.0, 0.0, 1.0);
  float green = clamp((mask - 0.75) * 4.0, 0.0, 1.0);
  float st = 0.0;
  if (fair > 0.0) st += fair * 0.17 * stripe(vWorld, uMow, 7.0, view, dist);
  if (green > 0.0) {
    vec2 m2 = vec2(-uMow.y, uMow.x);
    st += green * 0.07 * (stripe(vWorld, uMow, 1.2, view, dist) + stripe(vWorld, m2, 1.2, view, dist));
  }
  alb *= 1.0 + st * uStripe;

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
attribute vec2 aWater;   // x: 1 = sea water (surf, open-sea horizon); y: depth (m) of the sea
                         // over the skirt, or -1000 = read the baked depth texture
uniform mat4 uVP;
uniform vec3 uEye;
varying vec3 vRel;
varying vec2 vWorld;
varying float vSea;
varying float vDepth;
void main() {
  vRel = aPos - uEye;
  vWorld = aPos.xy;
  vSea = aWater.x;
  vDepth = aWater.y;
  gl_Position = uVP * vec4(vRel, 1.0);
}`;

export const WATER_FS = `${COMMON}
uniform sampler2D uNoise;
uniform sampler2D uDepth;  // r: water depth / 6 m, g: distance to dry ground (m / 255) on the
                           // hole's 1 m grid (bake.js bakeWaterDepth)
uniform vec2 uDepthMin;
uniform vec2 uDepthInv;
uniform float uTime;
uniform vec2 uWind;
uniform vec3 uDeep;        // linear colour of deep water seen from above (theme water.deep)
uniform vec4 uTint;        // sRGB colour of sunlit shallow water; w = 1 to use it (else the
                           // shipped dark pond)
uniform vec4 uWaterK;      // x: clarity (m), y: most haze the sea takes, z: sea swell (least
                           // cosine of the view to the water)
varying vec3 vRel;
varying vec2 vWorld;
varying float vSea;
varying float vDepth;

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
  // The sea's swell never lets it mirror the sky at grazing angles (a crisp horizon line).
  if (vSea > 0.5) cosv = max(cosv, uWaterK.z);
  float fres = 0.02 + 0.98 * pow(1.0 - cosv, 5.0);
  vec3 r = reflect(v, n);
  r.z = abs(r.z);
  vec3 refl = skyCol(r);
  vec3 deep = uDeep + uSunCol * 0.01;
  float alpha = 0.82;
  float foam = 0.0;
  if (uTint.w > 0.5) {
    // Clear water: the sunlit shallow colour over the sand fading to deep with depth, more
    // see-through in the shallows. Away from the shore the colour deepens further (a shelf
    // falling away; beyond the baked grid the distance keeps growing), so open water turns
    // ocean blue whatever depth the hole's own water was built to.
    vec2 uv = (vWorld - uDepthMin) * uDepthInv;
    vec2 o = max(max(-uv, uv - 1.0), 0.0) / uDepthInv;
    vec4 dt = texture2D(uDepth, clamp(uv, 0.0, 1.0));
    float shore = dt.g * 255.0 + length(o);
    // The local depth: baked on the hole, the skirt's own over the sea beyond it.
    float depth = vDepth > -500.0 ? max(vDepth, 0.0) : dt.r * 6.0;
    float k = 1.0 - exp(-max(depth, dt.r * 6.0 + 0.05 * max(shore - 8.0, 0.0)) / uWaterK.x);
    vec3 lightW = uSunCol * max(uSun.z, 0.0) * 0.55 + uAmbSky * 1.5;
    deep = mix(toLin(uTint.rgb) * lightW, deep, k);
    alpha = mix(0.42, 0.97, k);
    if (vSea > 0.5) {
      // Surf: lines of foam rolling up the beach, and a lacy fringe at the waterline.
      float lace = texture2D(uNoise, vWorld / 4.0 + vec2(uTime * 0.004, 0.0)).g;
      float lace2 = texture2D(uNoise, vWorld / 1.7 - vec2(0.0, uTime * 0.006)).b;
      float ph = depth * 7.0 + uTime * 0.8 + lace * 2.5;
      float band = smoothstep(0.72, 0.95, sin(ph) * 0.5 + 0.5) * (1.0 - smoothstep(0.1, 0.9, depth));
      float fringe = 1.0 - smoothstep(0.03, 0.18, depth + (lace - 0.5) * 0.12);
      foam = max(band * smoothstep(0.35, 0.65, lace * 0.7 + lace2 * 0.3), fringe);
      foam *= 1.0 - 0.5 * smoothstep(80.0, 400.0, dist);
    }
  }
  vec3 c = mix(deep, refl, fres);
  // Sun glint: tight highlight plus sparkle where the ripples catch the sun.
  float sp = max(dot(r, uSun), 0.0);
  c += uSunCol * (pow(sp, 600.0) * 12.0 + pow(sp, 60.0) * 0.25);
  c = mix(c, toLin(vec3(0.95, 0.97, 0.97)) * (uSunCol * max(uSun.z, 0.0) + uAmbSky * 1.5), foam);
  float f = fogF(dist);
  if (vSea > 0.5) f = min(f, uWaterK.y);
  c = mix(c, fogCol(v), f);
  gl_FragColor = vec4(finish(c), mix(alpha, 1.0, max(fres, foam)));
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

// ---------------------------------------------------------------- themed objects (instanced)
// Palms, saguaros, shrubs and gorse, rocks and dune-grass tufts share one program; uKind picks the
// way the unit mesh (meshes.js) is shaped per instance. Instance layout as the trees:
// iA = (base x, y, z, h), iB = (rx, rz, r, seed): palm h = trunk height, rx/rz = crown, r = trunk
// radius; saguaro h = height, r = column radius; shrub/gorse h = canopy-centre height, rx/rz =
// canopy; rock h = height, r = radius; grass h = scale.
export const OBJ_VS = `
attribute vec3 aPos;
attribute vec3 aNrm;
attribute vec4 aAttr;    // part, baked AO, u, v (meshes.js)
attribute vec4 iA;
attribute vec4 iB;
uniform mat4 uVP;
uniform vec3 uEye;
uniform float uTime;
uniform vec2 uWind;
uniform float uKind;     // 0 palm, 1 saguaro, 2 shrub, 3 gorse, 4 rock, 5 grass
uniform vec3 uTint;      // main colour (sRGB): fronds, cactus skin, foliage, rock, blades
uniform vec3 uTint2;     // second colour: palm trunk, saguaro rib grooves
uniform vec4 uFade;      // near dither fade (start, end); far fade (start, end; 0 = none)
uniform vec4 uClear;     // xyz: the ball, w: 1 = keep the sight line from the eye to it clear
varying vec3 vRel;
varying vec3 vN;
varying vec3 vCol;
varying vec4 vUV;        // u, v, part, AO
varying vec3 vLocal;
varying float vFade;
varying float vZ;

vec2 rot(vec2 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

void main() {
  float seed = iB.w;
  float ang = seed * 43.98;  // seven turns: neighbours face different ways
  float wl = length(uWind);
  vec2 wd = wl > 0.01 ? uWind / wl : vec2(0.7, 0.7);
  float gust = sin(uTime * (1.1 + 0.4 * seed) + seed * 40.0);
  float part = aAttr.x;
  // Colour jitter per instance, as the trees: some yellower, some bluer, some darker.
  float j = fract(seed * 7.31);
  vec3 tint = uTint * (0.82 + 0.36 * fract(seed * 3.7));
  tint = mix(tint * vec3(1.12, 1.05, 0.85), tint * vec3(0.88, 0.98, 1.1), j);
  vec3 p;
  vec3 n;
  vec3 col = tint;
  float reach = 1.0;
  float top = iA.w;        // height of the object's top above its base
  if (uKind < 0.5) {
    // Palm: a trunk curving away from the vertical, the crown on its top. The crown sways with
    // the gusts and the fronds bob and stream down-wind, most at their tips.
    float H = iA.w;
    float rx = iB.x;
    float rz = iB.y;
    float lean = (0.035 + 0.06 * fract(seed * 5.3)) * H;
    vec2 sway = wd * (gust * (0.04 + 0.02 * wl) + 0.015 * wl) * H * 0.08;
    if (part < 0.5) {
      float t = aPos.z;
      p = vec3(aPos.xy * iB.z + vec2(lean * t * t, 0.0), t * H);
      p.xy = rot(p.xy, ang) + sway * t * t;
      n = vec3(rot(aNrm.xy, ang), aNrm.z);
      col = uTint2 * (0.85 + 0.3 * fract(seed * 11.3));
    } else {
      float u = aAttr.z;
      vec3 q = vec3(aPos.xy * rx, aPos.z * rz);
      q.z += u * u * rz * (0.06 + 0.03 * wl) * sin(uTime * (1.9 + 0.7 * seed) + aPos.x * 3.0 + aPos.y * 2.0);
      p = q + vec3(lean, 0.0, H);
      p.xy = rot(p.xy, ang) + sway + wd * u * u * rx * (0.04 + 0.025 * wl) * (0.6 + 0.4 * gust);
      n = normalize(vec3(rot(aNrm.xy / rx, ang), aNrm.z / rz));
      col = part < 1.5 ? mix(tint, tint * vec3(1.3, 1.2, 0.55), u * u * 0.5 * fract(seed * 2.9)) : uTint2 * vec3(0.85, 0.66, 0.42);
    }
    reach = rx;
    top = H + rz;
  } else if (uKind < 1.5) {
    // Saguaro: the ribbed column (thicker on old giants) and up to four arms; young ones have
    // none or one.
    float H = iA.w;
    float s = H / 6.5;
    float R = iB.z * max(1.0, s * 0.95);
    float arms = H < 5.0 ? step(0.45, fract(seed * 3.3)) : 1.0 + floor(fract(seed * 13.7) * 3.0);
    if (part < 0.5) {
      float z = aPos.z <= 1.0 ? aPos.z * H : H + (aPos.z - 1.0) * R * 1.15;
      p = vec3(aPos.xy * R, z);
    } else {
      p = aPos * s;
      if (aAttr.w > arms + 0.5) p = vec3(0.0, 0.0, H * 0.5);
    }
    p.xy = rot(p.xy, ang);
    n = vec3(rot(aNrm.xy, ang), aNrm.z);
    col = mix(uTint2, tint, aAttr.y);
  } else if (uKind < 3.5) {
    // Shrub / gorse: the low canopy, a little sway at the top.
    float rx = iB.x;
    float rz = iB.y;
    p = vec3(aPos.xy * rx, iA.w + aPos.z * rz);
    float k = (aPos.z + 1.0) * 0.5;
    p.xy = rot(p.xy, ang) + wd * (gust * (0.03 + 0.015 * wl) + 0.01 * wl) * k * k * rz;
    n = normalize(vec3(rot(aNrm.xy / rx, ang), aNrm.z / rz));
    reach = rx;
    top = iA.w + rz;
  } else if (uKind < 4.5) {
    // Rock: stretched and turned per instance, the lower part buried.
    float r = iB.z;
    float h = iA.w;
    vec3 sc = vec3(r * (0.85 + 0.35 * fract(seed * 3.1)), r * (0.85 + 0.35 * fract(seed * 5.7)), h * 0.78);
    p = vec3(aPos.xy * sc.xy, h * 0.25 + aPos.z * sc.z);
    p.xy = rot(p.xy, ang);
    n = normalize(aNrm / sc);
    n.xy = rot(n.xy, ang);
    col = uTint * (0.8 + 0.4 * fract(seed * 9.1));
    reach = r;
  } else {
    // Dune-grass tuft: the blade tips stream and flutter in the wind.
    float sc = iA.w;
    float v = aAttr.w;
    p = aPos * sc;
    p.xy = rot(p.xy, ang) + wd * (sin(uTime * (2.2 + seed) + seed * 30.0) * (0.05 + 0.02 * wl) + 0.03 * wl) * v * v * sc;
    n = vec3(rot(aNrm.xy, ang), aNrm.z);
    col = mix(tint * vec3(0.78, 0.88, 0.76), tint * vec3(1.18, 1.1, 0.92), v);
    reach = 0.4;
    top = 0.9 * sc;
  }
  vUV = vec4(aAttr.z, aAttr.w, part, aAttr.y);
  vLocal = aPos * 3.0 + seed * 13.0;
  vN = n;
  vCol = col;
  vRel = iA.xyz + p - uEye;
  vZ = iA.z + p.z;
  float hd = length(iA.xy - uEye.xy);
  vFade = smoothstep(uFade.x, uFade.y, length(vRel.xy) - reach * 0.5);
  if (uClear.w > 0.5) {
    // Objects standing in the sight line from the camera to the ball and tall enough to block it
    // (a saguaro behind the tee) dissolve rather than fill the screen.
    vec2 sb = uClear.xy - uEye.xy;
    float sl = max(dot(sb, sb), 1e-4);
    float t = clamp(dot(iA.xy - uEye.xy, sb) / sl, 0.0, 1.0);
    float off = length(uEye.xy + sb * t - iA.xy);
    float below = uEye.z + (uClear.z - uEye.z) * t - (iA.z + top);
    off += step(0.97, t) * 99.0 + max(below, 0.0) * 4.0;
    vFade *= smoothstep(reach * 0.6 + 0.8, reach * 0.6 + 2.5, off);
  }
  gl_Position = uVP * vec4(vRel, 1.0);
  if (uFade.w > 0.0) {
    // Far fade for small things (grass): dithered out, then not drawn at all.
    vFade *= 1.0 - smoothstep(uFade.z, uFade.w, hd);
    if (hd > uFade.w) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
  }
}`;

export const OBJ_FS = `${COMMON}
uniform sampler2D uNoise;
uniform float uKind;
varying vec3 vRel;
varying vec3 vN;
varying vec3 vCol;
varying vec4 vUV;
varying vec3 vLocal;
varying float vFade;
varying float vZ;
void main() {
  if (vFade < 0.999 && vFade < bayer4(gl_FragCoord.xy) * 0.94 + 0.03) discard;
  float dist = length(vRel);
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  vec3 v = vRel / max(dist, 1e-4);
  vec3 alb = toLin(vCol);
  float ao = vUV.w;
  float foliage = 0.0;
  if (uKind < 0.5) {
    if (vUV.z > 0.5) {
      // Frond: pinnate leaflets cut out of the blade along the rachis; solid in the distance,
      // where the cut-outs would only shimmer.
      float av = abs(vUV.y);
      float lf = fract(vUV.x * 24.0 - av * 2.4);
      if (av > 0.12 && lf > mix(0.62, 1.01, smoothstep(40.0, 90.0, dist))) discard;
      alb *= 0.75 + 0.5 * texture2D(uNoise, vLocal.xy * 0.3).g;
      foliage = 1.0;
    } else {
      // Trunk: rings of old leaf scars.
      float ring = fract(vUV.y * 34.0);
      alb *= 0.78 + 0.3 * smoothstep(0.0, 0.25, ring) * (1.0 - smoothstep(0.75, 1.0, ring));
    }
  } else if (uKind < 1.5) {
    // Saguaro skin: fine vertical spine texture.
    alb *= 0.9 + 0.2 * texture2D(uNoise, vec2(vUV.x * 3.0, vZ * 0.8)).b;
  } else if (uKind < 3.5) {
    float leaf = texture2D(uNoise, vLocal.xy * 0.45 + vLocal.z * 0.31).g * 0.6 + texture2D(uNoise, vLocal.yz * 0.9).r * 0.4;
    if (uKind < 2.5) {
      // Creosote: open and twiggy (sky shows through near by).
      if (leaf < mix(0.4, 0.0, smoothstep(50.0, 120.0, dist))) discard;
    } else {
      // Gorse: dense, dark, flecked with yellow flowers.
      // (Far away the flecks merge into a yellow cast.)
      float fl = texture2D(uNoise, vLocal.xz * 0.07 + vLocal.y * 0.04).b;
      float bloom = mix(smoothstep(0.7, 0.8, fl), 0.22, smoothstep(12.0, 45.0, dist));
      alb = mix(alb, toLin(vec3(0.98, 0.8, 0.1)), bloom * (0.6 + 0.4 * fract(vLocal.x * 0.37)));
    }
    alb *= 0.6 + 0.8 * leaf;
    foliage = 1.0;
  } else if (uKind < 4.5) {
    // Rock: bedding strata and pale lichen.
    float strata = texture2D(uNoise, vec2(vLocal.x * 0.05, vZ * 2.2)).r;
    alb *= 0.8 + 0.35 * strata;
    float lich = texture2D(uNoise, vLocal.xy * 0.7).g;
    alb = mix(alb, alb * vec3(1.2, 1.18, 0.9), smoothstep(0.66, 0.8, lich) * 0.6);
  } else {
    foliage = 1.0;
  }
  // Foliage wraps the light (soft terminator); bark and skin a little; rock not at all.
  float wrap = foliage > 0.5 ? 0.45 : uKind < 1.5 ? 0.25 : 0.0;
  float ndl = max((dot(n, uSun) + wrap) / (1.0 + wrap), 0.0);
  // Leaves glow when backlit; rock and cactus get a faint specular.
  float trans = foliage * pow(max(dot(v, uSun), 0.0), 4.0) * 0.35;
  vec3 h = normalize(uSun - v);
  float sp = (1.0 - foliage) * pow(max(dot(n, h), 0.0), 24.0) * 0.1;
  vec3 c = alb * (uSunCol * (ndl * (0.35 + 0.65 * ao) + trans) + ambient(n) * (0.45 + 0.6 * ao)) + uSunCol * sp;
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
    p = vec3(aPos.xy * uPoleR, aAttr.z * uPoleH); // aAttr.z: 0 at the foot, 1 at the top
    n = aNrm;
    // White pole with a darker band every 30 cm near the top for scale.
    vCol = mix(vec3(0.92, 0.92, 0.88), vec3(0.75, 0.1, 0.08), step(0.5, fract(p.z / 0.3)) * step(uPoleH - 0.6, p.z));
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
    // An arrow: a V head pointing downhill on a short stem, so the direction reads in a still
    // frame and in perspective (a bare V looks like a tick from a low angle).
    float head = 1.0 - smoothstep(0.025, 0.05, abs(al + abs(ac) * 0.9 - 0.05));
    head *= 1.0 - smoothstep(0.14, 0.18, abs(ac));
    float stem = (1.0 - smoothstep(0.018, 0.035, abs(ac))) * step(-0.34, al) * step(al, 0.04);
    float chev = max(head, stem);
    c = mix(c, vec3(1.0), chev * 0.8);
    a = max(a, chev * 0.85);
  }
  gl_FragColor = vec4(c, a * mask * uAlpha);
}`;

// ---------------------------------------------------------------- golfer (rigid skinning)
// One merged mesh (golfer-mesh.js); each vertex follows one bone's skin matrix (uBones, camera-
// relative translation; GOLFER_BONES mat4s = 80 vertex uniform vectors, within WebGL1's 128).
// aBM = (bone index, material): 0 cloth, 1 skin, 2 hair, 3 metal, 4 gloss, 5 rubber/leather,
// 6 eyes. Lit like the rest of the scene (theme sun, hemisphere ambient, fog) plus a soft
// sky-tinted rim light; skin wraps the light with a warm terminator. uAlpha fades the figure
// (dithered, no sorting), and so does a camera within ~1 m.
export const GOLFER_BONES = BONE_COUNT;
export const GOLFER_VS = `
attribute vec3 aPos;
attribute vec3 aNrm;
attribute vec3 aCol;
attribute vec2 aBM;
uniform mat4 uVP;
uniform mat4 uBones[${BONE_COUNT}];
varying vec3 vRel;
varying vec3 vN;
varying vec3 vCol;
varying float vMat;
void main() {
  mat4 m = uBones[int(aBM.x + 0.5)];
  vec4 p = m * vec4(aPos, 1.0);
  vRel = p.xyz;
  vN = (m * vec4(aNrm, 0.0)).xyz;
  vCol = aCol;
  vMat = aBM.y;
  gl_Position = uVP * vec4(vRel, 1.0);
}`;

export const GOLFER_FS = `${COMMON}
uniform float uAlpha;
uniform float uNear;     // 1: fade out within ~1 m of the camera, 0: never
varying vec3 vRel;
varying vec3 vN;
varying vec3 vCol;
varying float vMat;
void main() {
  float dist = length(vRel);
  float a = uAlpha * mix(1.0, smoothstep(0.45, 1.05, dist), uNear);
  if (a < 0.999 && a < bayer4(gl_FragCoord.xy) * 0.96 + 0.02) discard;
  vec3 v = vRel / max(dist, 1e-4);
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  float m = vMat;
  bool skin = m > 0.5 && m < 1.5;
  bool hair = m > 1.5 && m < 2.5;
  bool metal = m > 2.5 && m < 3.5;
  bool gloss = m > 3.5 && m < 4.5;
  bool rubber = m > 4.5 && m < 5.5;
  bool eye = m > 5.5;
  vec3 alb = toLin(vCol);
  float ndl = dot(n, uSun);
  float wrap = skin ? 0.4 : hair ? 0.25 : 0.18;
  float diff = max((ndl + wrap) / (1.0 + wrap), 0.0);
  vec3 h = normalize(uSun - v);
  float nh = max(dot(n, h), 0.0);
  float sp = skin ? pow(nh, 22.0) * 0.06 : hair ? pow(nh, 28.0) * 0.09 : metal ? pow(nh, 70.0) * 1.4
           : gloss ? pow(nh, 90.0) * 0.7 : rubber ? pow(nh, 10.0) * 0.03 : eye ? pow(nh, 140.0) * 0.8 : pow(nh, 10.0) * 0.035;
  sp *= smoothstep(-0.1, 0.15, ndl);
  vec3 amb = ambient(n);
  vec3 c;
  if (metal) {
    vec3 r = reflect(v, n);
    vec3 env = skyCol(normalize(vec3(r.xy, max(r.z, -0.25))));
    env = mix(env, uAmbGround * 2.0, smoothstep(0.0, -0.3, r.z));
    c = alb * (uSunCol * diff * 0.35 + amb * 0.5) + env * alb * 0.9 + uSunCol * sp;
  } else {
    // Soft cloth sheen at grazing angles; a warm terminator on skin.
    float fres = pow(1.0 - max(dot(n, -v), 0.0), 4.0);
    vec3 sss = skin ? vec3(0.28, 0.08, 0.04) * smoothstep(-0.35, 0.1, ndl) * (1.0 - smoothstep(0.1, 0.6, ndl)) : vec3(0.0);
    c = alb * (uSunCol * (diff + sss) + amb * 1.3) + uSunCol * sp;
    if (!skin && !eye) c += alb * amb * fres * 0.6;
  }
  // Rim: a cool sky light from behind keeps the silhouette readable against the ground.
  float rim = pow(1.0 - max(dot(n, -v), 0.0), 3.0) * (0.55 + 0.45 * n.z);
  c += rim * (uZenith * 0.18 + uSunCol * 0.05) * (metal ? 0.3 : 1.0);
  c = applyFog(c, vRel);
  gl_FragColor = vec4(finish(c), 1.0);
}`;

// Ground shadow of the golfer: the skinned mesh flattened along the sun onto the ground plane
// under the feet, drawn as white into a small mask texture whose square (centre uC, axes uE1,
// uE2, half-size 1/uInvHalf; camera-relative) lies on that plane. Overlaps write the same white,
// so the shadow darkens once; GOLFER_GROUND then lays the blurred mask on the ground.
export const GOLFER_MASK_VS = `
attribute vec3 aPos;
attribute vec2 aBM;
uniform mat4 uBones[${BONE_COUNT}];
uniform vec3 uSun;
uniform vec4 uPlane;
uniform vec3 uC;
uniform vec3 uE1;
uniform vec3 uE2;
uniform float uInvHalf;
void main() {
  vec4 p = uBones[int(aBM.x + 0.5)] * vec4(aPos, 1.0);
  float hgt = dot(uPlane.xyz, p.xyz) + uPlane.w;
  float ln = max(dot(uPlane.xyz, uSun), 0.2);
  vec3 q = p.xyz - uSun * (max(hgt, 0.0) / ln);
  vec3 r = q - uC;
  gl_Position = vec4(dot(r, uE1) * uInvHalf, dot(r, uE2) * uInvHalf, 0.0, 1.0);
}`;

export const GOLFER_MASK_FS = `
precision mediump float;
void main() {
  gl_FragColor = vec4(1.0);
}`;

export const GOLFER_GROUND_VS = `
attribute vec3 aPos;
attribute vec3 aMisc;
uniform mat4 uVP;
varying vec2 vUV;
void main() {
  vUV = aMisc.xy * 0.5 + 0.5;
  gl_Position = uVP * vec4(aPos, 1.0);
}`;

export const GOLFER_GROUND_FS = `
precision highp float;
uniform sampler2D uMask;
uniform float uAlpha;
uniform vec2 uTexel;
varying vec2 vUV;
void main() {
  vec2 t = uTexel;
  float s = texture2D(uMask, vUV).r * 0.2;
  s += (texture2D(uMask, vUV + vec2(t.x, 0.0)).r + texture2D(uMask, vUV - vec2(t.x, 0.0)).r
      + texture2D(uMask, vUV + vec2(0.0, t.y)).r + texture2D(uMask, vUV - vec2(0.0, t.y)).r) * 0.125;
  s += (texture2D(uMask, vUV + t).r + texture2D(uMask, vUV - t).r
      + texture2D(uMask, vUV + vec2(t.x, -t.y)).r + texture2D(uMask, vUV + vec2(-t.x, t.y)).r) * 0.075;
  float edge = smoothstep(0.0, 0.04, min(min(vUV.x, vUV.y), min(1.0 - vUV.x, 1.0 - vUV.y)));
  float a = s * uAlpha * edge;
  if (a < 0.003) discard;
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}`;
