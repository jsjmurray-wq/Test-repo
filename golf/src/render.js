// WebGL renderer for one hole: sky, terrain, water, trees, furniture, ball, trail and overlays.
//
// Design notes
// - One GLSL 100 code path for WebGL2 and WebGL1 (+ ANGLE_instanced_arrays). Uint16 indices only.
// - Camera-relative rendering: every vertex shader works with p - eye, and the view matrix holds the
//   rotation only. Terrain chunks carry chunk-local positions plus a per-chunk offset uniform.
// - Draw-call budget <= 30: terrain <= 10 chunks (frustum culled) + skirt, sky, water, 2 tree kinds
//   and up to 6 themed object kinds (instanced; a hole only draws the kinds it has: Hollow Pines
//   pine + broad, desert saguaro + shrub + rock, tropical palm + broad, links gorse + grass), props
//   (stakes, tee markers, cup), flag, ball, blob shadow, read grid, aim, trail.
// - The look comes from the hole's course theme (themes.js, terrain.theme): sky, sun, clouds, fog,
//   ambient, surface colours, water, horizon silhouettes, the ground beyond the hole and its
//   objects. 'parkland' reproduces the shipped Hollow Pines exactly. Themes with an ocean horizon
//   (and any hole with sea water) get a sea out to the horizon: the skirt falls below the sea level
//   toward it (seaSetup in meshes.js), an annulus of sea joins the hole's water, and the sky shader
//   draws the open sea beyond the far plane.
// - The golfer (scene.golfer, section 9): one rigidly skinned mesh (2 draw calls with its ground
//   shadow); buffers are rebuilt when the mesh (look, club) changes and after a context loss.
// - Every GPU resource is rebuilt from CPU copies on webglcontextrestored.
// - Resolution: DPR capped at 2 times an adaptive renderScale (0.6..1) driven by the frame interval.

import { createContext, contextExtensions, createProgram, makeBuffer, makeTexture, AttribState } from './gl.js';
import { perspective, lookAt, multiply, invert, project as projectPt, unproject } from './mat4.js';
import {
  terrainChunks, skirtMesh, icosphere, MeshBuilder, pineMesh, broadleafMesh, flagMesh, waterMesh,
  greenReadMesh, trailRibbon, aimRibbon, skirtTrees, skirtObjects, seaSetup, palmMesh, saguaroMesh,
  bushMesh, rockMesh, grassMesh, pathRibbon,
} from './meshes.js';
import { bakeTerrainColor, bakeClouds, bakeNoise, bakeWaterDepth } from './bake.js';
import {
  SKY_VS, SKY_FS, TERRAIN_VS, TERRAIN_FS, WATER_VS, WATER_FS, TREE_VS, TREE_FS, PROP_VS, PROP_FS,
  FLAG_VS, FLAG_FS, OVERLAY_VS, OVERLAY_FS, READ_VS, READ_FS, OBJ_VS, OBJ_FS,
  GOLFER_VS, GOLFER_FS, GOLFER_MASK_VS, GOLFER_MASK_FS, GOLFER_GROUND_VS, GOLFER_GROUND_FS, GOLFER_BONES,
  FLOW_VS, FLOW_FS,
} from './shaders.js';
import { BALL_R, CUP_R, FLAGSTICK_H, FLAGSTICK_R, SURF } from './constants.js';
import { themeFor } from './themes.js';
import { buildGolferMesh } from './golfer-mesh.js';
import { slopeField, FlowParticles, flowIndices, FLOW_FLOATS, FLOW_MAX } from './green-flow.js';

const EXPOSURE = 1.0;

// Themed object kinds drawn by the object program, in draw order: shader kind index, near dither
// fade (start, end, m) and far fade (start, end, m; 0 = none).
const OBJ_KINDS = [
  { kind: 'palm', id: 0, fade: [2.5, 7, 0, 0] },
  { kind: 'saguaro', id: 1, fade: [1.2, 3, 0, 0] },
  { kind: 'shrub', id: 2, fade: [0.6, 1.8, 0, 0] },
  { kind: 'gorse', id: 3, fade: [0.6, 1.8, 0, 0] },
  { kind: 'rock', id: 4, fade: [0.4, 1.2, 0, 0] },
  { kind: 'grass', id: 5, fade: [0.3, 1.0, 70, 120] },
];
const HORIZON_KIND = { hills: 0, mountains: 1, mesas: 2, dunes: 3 };
// Haze mixed into the far and near horizon silhouettes (the shipped 0.86 / 0.78 for hills).
const RIDGE_HAZE = { hills: [0.86, 0.78], mountains: [0.8, 0.7], mesas: [0.52, 0.17], dunes: [0.84, 0.72] };

const ZERO = { x: 0, y: 0, z: 0 };
const PATH_MAX = 3; // scene.paths drawn per frame
const PATH_FLOATS = (520 * 2 + 70) * 6; // pathRibbon output for up to 520 draped points + ring

// Instance row [x, y, z, h, rx, rz, r, seed] for one terrain object, by kind (null for pine and
// broad, which keep the shipped tree layout).
function objectRow(t, seed) {
  const c = t.canopy;
  const sd = t.variant != null ? t.variant : seed;
  switch (t.kind) {
    case 'palm':
      return [t.x, t.y, t.z, t.trunkH || 9, c ? c.rx : 3.5, c ? c.rz : 1.6, t.trunkR || 0.18, sd];
    case 'saguaro':
      return [t.x, t.y, t.z, t.trunkH || 6, 0, 0, t.trunkR || 0.25, sd];
    case 'shrub':
    case 'gorse': {
      const hh = c ? Math.max(0.3, c.cz - t.z) : 0.6;
      return [t.x, t.y, t.z, hh, c ? c.rx : 1.3, hh * 1.05, 0, sd];
    }
    case 'rock':
      return [t.x, t.y, t.z, t.trunkH || 0.6, t.trunkR || 0.6, t.trunkH || 0.6, t.trunkR || 0.6, sd];
    default:
      return null;
  }
}

export class Renderer {
  constructor(canvas, { quality = 'auto', test = false, gl1 = false } = {}) {
    this.canvas = canvas;
    this.quality = quality;
    this.test = !!test;
    this.cssW = canvas.clientWidth || canvas.width || 300;
    this.cssH = canvas.clientHeight || canvas.height || 150;
    this.dpr = 1;
    this.renderScale = quality === 'low' ? 0.75 : 1;
    this.maxScale = this.renderScale;
    this.terrain = null;
    this.theme = themeFor('parkland');
    this.cpu = null;
    this._themeUniforms();
    this.res = null;
    this.lost = false;
    this.eye = { x: 0, y: 0, z: 0 };
    this.vp = new Float32Array(16);
    this.invVP = new Float32Array(16);
    this.pxPerRad = 600;
    this._stats = { drawCalls: 0, tris: 0, renderScale: this.renderScale, ms: 0 };
    this._lastFrame = 0;
    this._frameEma = 16.7;
    this._frames = 0;
    this._trailBuf = new Float32Array(400 * 12 + 24);
    this._aimBuf = new Float32Array(4096);
    this._quad = new Float32Array(24);
    // Green reading (section 8.9): flowing slope streaks and up to PATH_MAX draped dotted paths.
    this._flowBuf = new Float32Array(FLOW_MAX * 4 * FLOW_FLOATS);
    this._pathBuf = new Float32Array(PATH_FLOATS);
    this.flow = null;
    this._flowT = null;
    this._golferBones = new Float32Array(GOLFER_BONES * 16);
    this._golferMesh = null; // {key, mesh} built from scene.golfer.look + club
    this.golferGL = null;
    const ctx = createContext(canvas, { test, forceGL1: gl1 });
    this.ok = !!ctx;
    if (!ctx) return;
    this.ctx = ctx;
    this.gl = ctx.gl;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      // Fresh extension objects for the new context (WebGL1 instancing would silently no-op).
      this.ctx = { ...this.ctx, ...contextExtensions(this.gl, this.ctx.gl2) };
      this._initGL();
      if (this.cpu) this._uploadHole();
    });
    try {
      this._initGL();
    } catch (e) {
      console.error(e);
      this.ok = false;
    }
  }

  // ------------------------------------------------------------------ GL resources
  _initGL() {
    const gl = this.gl;
    const { inst } = this.ctx;
    this.attribs = new AttribState(gl, inst);
    this.P = {
      sky: createProgram(gl, SKY_VS, SKY_FS),
      terrain: createProgram(gl, TERRAIN_VS, TERRAIN_FS),
      water: createProgram(gl, WATER_VS, WATER_FS),
      tree: createProgram(gl, TREE_VS, TREE_FS),
      prop: createProgram(gl, PROP_VS, PROP_FS),
      flag: createProgram(gl, FLAG_VS, FLAG_FS),
      overlay: createProgram(gl, OVERLAY_VS, OVERLAY_FS),
      read: createProgram(gl, READ_VS, READ_FS),
      obj: createProgram(gl, OBJ_VS, OBJ_FS),
      golfer: createProgram(gl, GOLFER_VS, GOLFER_FS),
      golferMask: createProgram(gl, GOLFER_MASK_VS, GOLFER_MASK_FS),
      golferGround: createProgram(gl, GOLFER_GROUND_VS, GOLFER_GROUND_FS),
      flow: createProgram(gl, FLOW_VS, FLOW_FS),
    };
    // Golfer buffers are rebuilt on the next draw (new context or first use); the shadow mask is
    // a small offscreen texture.
    this.golferGL = null;
    this._shadowMask = this._makeMask(256);
    // Static meshes (built once on the CPU and kept for restore).
    if (!this.static) {
      this.static = {
        clouds: bakeClouds(11),
        noise: bakeNoise(3),
        ico: icosphere(2),
        pine: pineMesh(),
        broad: broadleafMesh(),
        flag: flagMesh(),
        palm: palmMesh(),
        saguaro: saguaroMesh(),
        bush: bushMesh(),
        rock: rockMesh(),
        grass: grassMesh(),
      };
    }
    const s = this.static;
    const gl2 = this.ctx.gl2;
    const mesh = (m, extra) => {
      const o = {
        pos: makeBuffer(gl, m.pos),
        nrm: m.nrm ? makeBuffer(gl, m.nrm) : null,
        idx: makeBuffer(gl, m.idx, gl.ELEMENT_ARRAY_BUFFER),
        count: m.idx.length,
      };
      if (extra) o[extra] = makeBuffer(gl, m[extra]);
      return o;
    };
    this.G = {
      skyTri: makeBuffer(gl, new Float32Array([-1, -1, 3, -1, -1, 3])),
      clouds: makeTexture(gl, s.clouds, { repeat: true, mip: true, gl2 }),
      noise: makeTexture(gl, s.noise, { repeat: true, mip: true, gl2 }),
      ico: mesh(s.ico),
      pine: mesh(s.pine, 'attr'),
      broad: mesh(s.broad, 'attr'),
      flag: mesh(s.flag, 'attr'),
      palm: mesh(s.palm, 'attr'),
      saguaro: mesh(s.saguaro, 'attr'),
      bush: mesh(s.bush, 'attr'),
      rock: mesh(s.rock, 'attr'),
      grass: mesh(s.grass, 'attr'),
      // Stand-ins for a hole without themed ground detail or water depth.
      black: makeTexture(gl, { width: 1, height: 1, data: new Uint8Array(4) }),
      trail: gl.createBuffer(),
      aim: gl.createBuffer(),
      quad: gl.createBuffer(),
      quad2: gl.createBuffer(),
      flow: gl.createBuffer(),
      flowIdx: makeBuffer(gl, flowIndices(FLOW_MAX), gl.ELEMENT_ARRAY_BUFFER),
      paths: [gl.createBuffer(), gl.createBuffer(), gl.createBuffer()],
    };
    gl.bindBuffer(gl.ARRAY_BUFFER, this.G.flow);
    gl.bufferData(gl.ARRAY_BUFFER, this._flowBuf.byteLength, gl.DYNAMIC_DRAW);
    for (const b of this.G.paths) {
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, this._pathBuf.byteLength, gl.DYNAMIC_DRAW);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.G.trail);
    gl.bufferData(gl.ARRAY_BUFFER, this._trailBuf.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.G.aim);
    gl.bufferData(gl.ARRAY_BUFFER, this._aimBuf.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.G.quad);
    gl.bufferData(gl.ARRAY_BUFFER, this._quad.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.G.quad2);
    gl.bufferData(gl.ARRAY_BUFFER, this._quad.byteLength, gl.DYNAMIC_DRAW);
    this.res = null;
  }

  // ------------------------------------------------------------------ hole data
  setHole(terrain) {
    this.terrain = terrain;
    const theme = themeFor(terrain.theme);
    this.theme = theme;
    const stride = this.quality === 'low' ? 2 : 1;
    const sea = seaSetup(terrain, theme);
    const chunks = terrainChunks(terrain.grid, { stride });
    // (The shipped parkland skirt keeps its sparse edge; the themed ones meet the grid exactly.)
    const skirt = skirtMesh(terrain.grid, theme.id === 'parkland' && !sea ? {} : { sea, dense: true });
    const bake = bakeTerrainColor(terrain, { sunDir: theme.sky.sunDir, theme });
    const water = waterMesh(terrain.waters, 1.6, { sea, skirt });
    const depth = water.idx.length && theme.water.tint ? bakeWaterDepth(terrain) : null;
    const read = greenReadMesh(terrain);
    // Flowing slope streaks over the green (CPU particles; rebuilt per hole, kept across a context loss).
    const field = slopeField(terrain);
    this.flow = field ? new FlowParticles(field, { seed: 7 }) : null;
    this._flowT = null;
    // Tree instances: [x, y, z, canopy-centre height, rx, rz, trunkR, seed] per tree, by kind.
    // Themed objects: [x, y, z, h, rx, rz, r, seed] (objectRow), by kind.
    const pines = [];
    const broads = [];
    const objs = {};
    for (const o of OBJ_KINDS) objs[o.kind] = [];
    (terrain.trees || []).forEach((t, k) => {
      const seed = ((Math.sin(k * 12.9898 + t.x * 0.37 + t.y * 0.11) * 43758.5453) % 1 + 1) % 1;
      const orow = objectRow(t, seed);
      if (orow) {
        objs[t.kind].push(...orow);
        return;
      }
      const c = t.canopy || { cz: t.z + 6, rx: 3, rz: 3 };
      const row = [t.x, t.y, t.z, c.cz - t.z, c.rx, c.rz, t.trunkR || 0.25, seed];
      (t.kind === 'pine' ? pines : broads).push(...row);
    });
    (terrain.decor || []).forEach((d, k) => {
      if (d.kind === 'grass') objs.grass.push(d.x, d.y, d.z, d.scale || 1, 0, 0, 0, (Math.sin(k * 78.233 + d.x) * 43758.5453 % 1 + 1) % 1);
    });
    // The ground beyond the hole: the shipped pine/broad tree line, or the theme's objects.
    const low = this.quality === 'low';
    if (theme.skirtObjects) {
      const so = theme.skirtObjects;
      const bg = skirtObjects(skirt, {
        kinds: so.kinds, perVertex: so.perVertex * (low ? 0.5 : 1), grass: so.grass * (low ? 0.5 : 1),
        minZ: sea ? sea.level + 0.6 : -Infinity,
      });
      for (const kind of Object.keys(bg.rows)) {
        if (kind === 'pine') pines.push(...bg.rows[kind]);
        else if (kind === 'broad') broads.push(...bg.rows[kind]);
        else if (objs[kind]) objs[kind].push(...bg.rows[kind]);
      }
      objs.grass.push(...bg.grass);
    } else {
      const bg = skirtTrees(skirt, { perVertex: low ? 0.6 : 1.3 });
      pines.push(...bg.pines);
      broads.push(...bg.broads);
    }
    // Static furniture: OOB stakes, tee markers and the cup (dark hole with a white liner rim).
    const mb = new MeshBuilder();
    const H = (x, y) => terrain.heightAt(x, y);
    for (const st of terrain.stakes || []) {
      mb.cylinder(st.x, st.y, st.z - 0.1, 0.04, 0.035, 1.0, [0.93, 0.93, 0.9], 6);
    }
    if (terrain.tee) {
      const tg = terrain.path && terrain.path.tangentAt ? terrain.path.tangentAt(0) : null;
      let dx = tg ? tg.x : terrain.cup.x - terrain.tee.x;
      let dy = tg ? tg.y : terrain.cup.y - terrain.tee.y;
      const l = Math.hypot(dx, dy) || 1;
      dx /= l;
      dy /= l;
      for (const side of [-1, 1]) {
        const x = terrain.tee.x + dx * 1.2 + dy * 3.2 * side;
        const y = terrain.tee.y + dy * 1.2 - dx * 3.2 * side;
        const z = H(x, y);
        mb.cylinder(x, y, z - 0.02, 0.03, 0.03, 0.05, [0.1, 0.1, 0.1], 6);
        mb.sphere(x, y, z + 0.08, 0.065, [0.12, 0.25, 0.7]);
      }
    }
    if (terrain.cup) {
      const c = terrain.cup;
      mb.disc(c.x, c.y, 0, CUP_R * 0.84, [0.015, 0.015, 0.012], H, 0.004);
      mb.disc(c.x, c.y, CUP_R * 0.84, CUP_R * 1.02, [0.95, 0.95, 0.92], H, 0.004);
    }
    const props = mb.build();
    let mx = terrain.cup.x - terrain.tee.x;
    let my = terrain.cup.y - terrain.tee.y;
    const ml = Math.hypot(mx, my) || 1;
    mx /= ml;
    my /= ml;
    const objF = {};
    for (const k of Object.keys(objs)) if (objs[k].length) objF[k] = new Float32Array(objs[k]);
    this.cpu = {
      chunks, skirt, bake, water, depth, read, props,
      pines: new Float32Array(pines), broads: new Float32Array(broads), objs: objF,
      mow: [mx, my],
      sea,
    };
    this._themeUniforms();
    if (this.ok && !this.lost) this._uploadHole();
  }

  // Per-hole uniform values from the theme (kept as typed arrays: no per-frame allocation).
  _themeUniforms() {
    const th = this.theme;
    const sea = this.cpu ? this.cpu.sea : null;
    const f3 = (a) => new Float32Array(a);
    const fog = th.fog || {};
    const hz = th.horizon === 'ocean' ? th.land || 'hills' : th.horizon;
    const rh = RIDGE_HAZE[hz] || RIDGE_HAZE.hills;
    const tint = th.water.tint;
    this.U = {
      sunCol: f3(th.sky.sunColor),
      zenith: f3(th.sky.zenith),
      horizon: f3(th.sky.horizon),
      haze: f3(th.sky.haze),
      fogTint: f3(fog.color ? [...fog.color, fog.amount == null ? 1 : fog.amount] : [0, 0, 0, 0]),
      aerial: fog.aerial == null ? 0.8 : fog.aerial,
      highClear: !!fog.highClear,
      fogK: fog.density || 1 / 1100,
      ambSky: f3(th.ambient.sky),
      ambGround: f3(th.ambient.ground),
      cloud: f3([th.clouds ? th.clouds.cover : 1, th.clouds ? th.clouds.shift : 0, th.clouds ? th.clouds.grey : 0, 0]),
      ridgeFar: f3(th.ridges.far),
      ridgeNear: f3(th.ridges.near),
      hz: f3([HORIZON_KIND[hz] || 0, rh[0], rh[1], 0]),
      sea: f3(sea ? [sea.dir.x, sea.dir.y, sea.cosHalf, 1] : [1, 0, 2, 0]),
      seaLevel: sea ? sea.level : 0,
      seaHaze: th.water.haze == null ? 1 : th.water.haze,
      seaCol: f3(th.water.deep),
      deep: f3(th.water.deep),
      tint: f3(tint ? [...tint, 1] : [0, 0, 0, 0]),
      waterK: f3([th.water.clarity || 2, th.water.haze == null ? 1 : th.water.haze, th.water.rough || 0.12, 0]),
      skirtNear: f3(th.skirt.near),
      skirtFar: f3(th.skirt.far),
      skirtDetail: f3(th.skirt.detail || [0, 0, 0, 0]),
      skirtScale: th.skirt.scale || 97,
      skirtBlend: th.skirt.blend ? 1 : 0,
      beach: f3(sea ? [sea.level, 1, 0, 0] : [0, 0, 0, 0]),
      sand: f3(th.surfaceColors[SURF.WASTE] || [0.9, 0.85, 0.7]),
      revet: f3(th.revet || [0.2, 0.26, 0.12]),
      detailK: f3([th.detail ? th.detail.rake : 1, th.detail ? th.detail.pebbles : 1, th.detail ? th.detail.sheen : 1, 0]),
      stripe: th.stripe == null ? 1 : th.stripe,
      tints: th.tints,
      trunks: th.trunks || {},
    };
  }

  _uploadHole() {
    const gl = this.gl;
    const c = this.cpu;
    // Free the previous hole's buffers and textures.
    if (this.res) {
      for (const b of this.res.buffers) gl.deleteBuffer(b);
      for (const t of this.res.textures) gl.deleteTexture(t);
    }
    const buffers = [];
    const textures = [];
    const buf = (data, target) => {
      const b = makeBuffer(gl, data, target);
      buffers.push(b);
      return b;
    };
    const tex = (img, opts) => {
      const t = makeTexture(gl, img, { ...opts, gl2: this.ctx.gl2 });
      textures.push(t);
      return t;
    };
    const E = gl.ELEMENT_ARRAY_BUFFER;
    const res = { buffers, textures };
    res.chunks = c.chunks.map((ch) => ({
      ...ch,
      bPos: buf(ch.pos), bNrm: buf(ch.nrm), bIdx: buf(ch.idx, E), count: ch.idx.length,
    }));
    res.skirt = { cx: c.skirt.cx, cy: c.skirt.cy, bPos: buf(c.skirt.pos), bNrm: buf(c.skirt.nrm), bIdx: buf(c.skirt.idx, E), count: c.skirt.idx.length };
    res.water = c.water.idx.length
      ? { bPos: buf(c.water.pos), bWater: buf(c.water.water), bIdx: buf(c.water.idx, E), count: c.water.idx.length }
      : null;
    res.read = c.read ? { cx: c.read.cx, cy: c.read.cy, bData: buf(c.read.data), bIdx: buf(c.read.idx, E), count: c.read.idx.length } : null;
    res.props = c.props.idx.length
      ? { bPos: buf(c.props.pos), bNrm: buf(c.props.nrm), bCol: buf(c.props.col), bIdx: buf(c.props.idx, E), count: c.props.idx.length }
      : null;
    res.pines = c.pines.length ? { b: buf(c.pines), n: c.pines.length / 8, cpu: c.pines } : null;
    res.broads = c.broads.length ? { b: buf(c.broads), n: c.broads.length / 8, cpu: c.broads } : null;
    res.objs = {};
    for (const k of Object.keys(c.objs)) res.objs[k] = { b: buf(c.objs[k]), n: c.objs[k].length / 8, cpu: c.objs[k] };
    const bk = c.bake;
    res.bake = tex(bk, { mip: true });
    res.bakeMin = [bk.minX, bk.minY];
    res.bakeInv = [1 / (bk.width * bk.step), 1 / (bk.height * bk.step)];
    res.detail = bk.detail ? tex(bk.detail, { mip: true }) : this.G.black;
    const dp = c.depth;
    res.depth = dp ? tex(dp, {}) : this.G.black;
    res.depthMin = dp ? [dp.minX, dp.minY] : [0, 0];
    res.depthInv = dp ? [1 / (dp.width * dp.step), 1 / (dp.height * dp.step)] : [1, 1];
    this.res = res;
  }

  // ------------------------------------------------------------------ viewport
  resize(cssW, cssH, dpr = 1) {
    this.cssW = Math.max(1, cssW);
    this.cssH = Math.max(1, cssH);
    this.dpr = Math.min(2, Math.max(0.5, dpr || 1));
    this._applySize();
  }

  _applySize() {
    const pr = this.dpr * this.renderScale;
    const w = Math.max(1, Math.round(this.cssW * pr));
    const h = Math.max(1, Math.round(this.cssH * pr));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this._stats.renderScale = this.renderScale;
  }

  // Adaptive resolution: watch the frame interval and step renderScale down when the GPU cannot keep
  // up (interval well above 60 Hz), back up when there is headroom. Hysteresis keeps it from hunting.
  _adapt(now) {
    if (this.test) return;
    if (this._lastFrame) {
      const dt = Math.min(100, now - this._lastFrame);
      this._frameEma += (dt - this._frameEma) * 0.05;
    }
    this._lastFrame = now;
    if (++this._frames % 90 !== 0) return;
    let s = this.renderScale;
    if (this._frameEma > 24 && s > 0.6) s = Math.max(0.6, s - 0.1);
    else if (this._frameEma < 17.5 && s < this.maxScale) s = Math.min(this.maxScale, s + 0.05);
    if (s !== this.renderScale) {
      this.renderScale = s;
      this._applySize();
    }
  }

  // ------------------------------------------------------------------ queries
  // World point -> CSS px. z is the view-space depth in metres (positive in front of the camera).
  project(x, y, z) {
    const e = this.eye;
    const r = projectPt(this.vp, { x: x - e.x, y: y - e.y, z: z - e.z }, this.cssW, this.cssH);
    return { sx: r.sx, sy: r.sy, z: r.w, visible: r.visible };
  }

  // CSS px -> first terrain hit along the view ray (or null).
  pickTerrain(sx, sy) {
    const t = this.terrain;
    if (!t) return null;
    const a = unproject(this.invVP, sx, sy, -1, this.cssW, this.cssH);
    const b = unproject(this.invVP, sx, sy, 1, this.cssW, this.cssH);
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let dz = b.z - a.z;
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l;
    dy /= l;
    dz /= l;
    const o = { x: a.x + this.eye.x, y: a.y + this.eye.y, z: a.z + this.eye.z };
    if (t.raycast) return t.raycast(o, { x: dx, y: dy, z: dz }, 4000);
    // Fallback march for terrains without raycast.
    let prev = 0;
    for (let s = 0.5; s < 4000; s *= 1.02) {
      const x = o.x + dx * s;
      const y = o.y + dy * s;
      if (o.z + dz * s <= t.heightAt(x, y)) {
        let lo = prev;
        let hi = s;
        for (let k = 0; k < 20; k++) {
          const m = (lo + hi) / 2;
          if (o.z + dz * m <= t.heightAt(o.x + dx * m, o.y + dy * m)) hi = m;
          else lo = m;
        }
        const hx = o.x + dx * hi;
        const hy = o.y + dy * hi;
        return { x: hx, y: hy, z: t.heightAt(hx, hy) };
      }
      prev = s;
      s += 0.5;
    }
    return null;
  }

  stats() {
    return { ...this._stats };
  }

  // Read one pixel (CSS px) of the last frame. Valid right after draw() (tests create the context
  // with preserveDrawingBuffer).
  debugPixel(sx, sy) {
    if (!this.ok) return [0, 0, 0, 0];
    const gl = this.gl;
    const px = Math.min(this.canvas.width - 1, Math.max(0, Math.floor((sx / this.cssW) * this.canvas.width)));
    const py = Math.min(this.canvas.height - 1, Math.max(0, this.canvas.height - 1 - Math.floor((sy / this.cssH) * this.canvas.height)));
    const out = new Uint8Array(4);
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return Array.from(out);
  }

  // ------------------------------------------------------------------ drawing helpers
  _use(p, frame) {
    const gl = this.gl;
    gl.useProgram(p.prog);
    const u = p.u;
    const U = this.U;
    if (u.uVP) gl.uniformMatrix4fv(u.uVP, false, this.vp);
    if (u.uSun) gl.uniform3f(u.uSun, frame.sun.x, frame.sun.y, frame.sun.z);
    if (u.uSunCol) gl.uniform3fv(u.uSunCol, U.sunCol);
    if (u.uZenith) gl.uniform3fv(u.uZenith, U.zenith);
    if (u.uHorizon) gl.uniform3fv(u.uHorizon, U.horizon);
    if (u.uFogK) gl.uniform1f(u.uFogK, frame.fogK);
    if (u.uExposure) gl.uniform1f(u.uExposure, EXPOSURE);
    if (u.uHaze) gl.uniform3fv(u.uHaze, U.haze);
    if (u.uFogTint) gl.uniform4fv(u.uFogTint, U.fogTint);
    if (u.uAerial) gl.uniform1f(u.uAerial, U.aerial);
    if (u.uAerialK) gl.uniform1f(u.uAerialK, frame.aerialK);
    if (u.uAmbSky) gl.uniform3fv(u.uAmbSky, U.ambSky);
    if (u.uAmbGround) gl.uniform3fv(u.uAmbGround, U.ambGround);
    if (u.uTime) gl.uniform1f(u.uTime, frame.time);
    if (u.uWind) gl.uniform2f(u.uWind, frame.wind.x, frame.wind.y);
    if (u.uEye) gl.uniform3f(u.uEye, this.eye.x, this.eye.y, this.eye.z);
    this.attribs.begin();
    return u;
  }

  _drawElements(count, instances = 0) {
    const gl = this.gl;
    this.attribs.end();
    if (instances) this.ctx.inst.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0, instances);
    else gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0);
    this._stats.drawCalls++;
    this._stats.tris += (count / 3) * (instances || 1);
  }

  // Instanced draw of meshG with per-instance rows [iA(4), iB(4)] from set (attributes iA, iB of
  // program p); without the instancing extension, constant attributes per instance (rare WebGL1
  // fallback, counted as one draw call).
  _drawInstanced(p, meshG, set) {
    const gl = this.gl;
    const A = this.attribs;
    if (this.ctx.inst) {
      A.bind(p.a.iA, set.b, 4, 32, 0, 1);
      A.bind(p.a.iB, set.b, 4, 32, 16, 1);
      this._drawElements(meshG.count, set.n);
      return;
    }
    A.end();
    for (let k = 0; k < set.n; k++) {
      const o = k * 8;
      gl.vertexAttrib4f(p.a.iA, set.cpu[o], set.cpu[o + 1], set.cpu[o + 2], set.cpu[o + 3]);
      gl.vertexAttrib4f(p.a.iB, set.cpu[o + 4], set.cpu[o + 5], set.cpu[o + 6], set.cpu[o + 7]);
      gl.drawElements(gl.TRIANGLES, meshG.count, gl.UNSIGNED_SHORT, 0);
    }
    this._stats.drawCalls++;
    this._stats.tris += (meshG.count / 3) * set.n;
  }

  _drawStrip(n) {
    const gl = this.gl;
    this.attribs.end();
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, n);
    this._stats.drawCalls++;
    this._stats.tris += Math.max(0, n - 2);
  }

  // Frustum planes (camera-relative) from the view-projection matrix, for chunk culling.
  _planes() {
    const m = this.vp;
    const row = (i) => [m[i], m[4 + i], m[8 + i], m[12 + i]];
    const r0 = row(0);
    const r1 = row(1);
    const r2 = row(2);
    const r3 = row(3);
    const pl = [];
    for (const [r, s] of [[r0, 1], [r0, -1], [r1, 1], [r1, -1], [r2, 1], [r2, -1]]) {
      pl.push([r3[0] + s * r[0], r3[1] + s * r[1], r3[2] + s * r[2], r3[3] + s * r[3]]);
    }
    return pl;
  }

  _boxVisible(pl, x0, y0, z0, x1, y1, z1) {
    for (const p of pl) {
      const x = p[0] >= 0 ? x1 : x0;
      const y = p[1] >= 0 ? y1 : y0;
      const z = p[2] >= 0 ? z1 : z0;
      if (p[0] * x + p[1] * y + p[2] * z + p[3] < 0) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ frame
  draw(scene) {
    if (!this.ok || this.lost) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this._adapt(now);
    const gl = this.gl;
    const st = this._stats;
    st.drawCalls = 0;
    st.tris = 0;
    const cam = scene.cam;
    const e = cam.eye;
    this.eye = { x: e.x, y: e.y, z: e.z };
    const W = this.canvas.width;
    const Hh = this.canvas.height;
    const aspect = this.cssW / this.cssH;
    const fovY = cam.fovY || 1;
    const proj = perspective(fovY, aspect, cam.near || 0.2, cam.far || 6000);
    // Lens shift (NDC x): the view's centre moves sideways without turning the camera (landscape
    // address puts the ball under the swing arc on the right). project/pick use the same matrix.
    proj[8] = -(cam.shiftX || 0);
    proj[9] = -(cam.shiftY || 0); // (NDC y, + up: the Golfer customiser's preview window, section 9)
    const fwd ={ x: cam.target.x - e.x, y: cam.target.y - e.y, z: cam.target.z - e.z };
    const view = lookAt(ZERO, fwd, cam.up || { x: 0, y: 0, z: 1 });
    multiply(proj, view, this.vp);
    invert(this.vp, this.invVP);
    this.pxPerRad = this.cssH / (2 * Math.tan(fovY / 2));
    let sun = scene.sunDir || this.theme.sky.sunDir;
    const sl = Math.hypot(sun.x, sun.y, sun.z) || 1;
    sun = { x: sun.x / sl, y: sun.y / sl, z: sun.z / sl };
    // Thinner haze for high cameras (map, flyover): the air above is clearer, and a uniform exp2 fog
    // would wash out a top-down view.
    const agl = this.terrain ? Math.max(0, e.z - this.terrain.heightAt(e.x, e.y)) : 0;
    const thin = 1 + Math.max(0, agl - 30) / 100;
    const fogK = this.U.fogK / thin;
    // The aerial haze thins with height too on the themed courses (the shipped look keeps it).
    const aerialK = this.U.highClear ? thin : 1;
    const frame = { sun, fogK, aerialK, time: scene.time || 0, wind: scene.wind || { x: 0, y: 0 } };

    gl.viewport(0, 0, W, Hh);
    gl.clearColor(0.75, 0.82, 0.88, 1);
    gl.clearDepth(1);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.frontFace(gl.CCW);
    gl.cullFace(gl.BACK);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const R = this.res;
    const A = this.attribs;
    const T = this.terrain;

    if (R) {
      // ---- terrain chunks + skirt
      const pl = this._planes();
      let u = this._use(this.P.terrain, frame);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, R.bake);
      gl.uniform1i(u.uBake, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.G.noise);
      gl.uniform1i(u.uNoise, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, R.detail);
      gl.uniform1i(u.uDetail, 2);
      gl.uniform2fv(u.uBakeMin, R.bakeMin);
      gl.uniform2fv(u.uBakeInv, R.bakeInv);
      gl.uniform2fv(u.uMow, this.cpu.mow);
      gl.uniform1f(u.uSkirt, 0);
      const U = this.U;
      gl.uniform1f(u.uStripe, U.stripe);
      gl.uniform3fv(u.uSkirtNear, U.skirtNear);
      gl.uniform3fv(u.uSkirtFar, U.skirtFar);
      gl.uniform4fv(u.uSkirtDetail, U.skirtDetail);
      gl.uniform1f(u.uSkirtInv, 1 / U.skirtScale);
      gl.uniform1f(u.uSkirtBlend, U.skirtBlend);
      gl.uniform4fv(u.uBeach, U.beach);
      gl.uniform3fv(u.uSand, U.sand);
      gl.uniform3fv(u.uRevet, U.revet);
      gl.uniform4fv(u.uDetailK, U.detailK);
      for (const ch of R.chunks) {
        if (!this._boxVisible(pl, ch.minX - e.x, ch.minY - e.y, ch.minZ - e.z - 0.1, ch.maxX - e.x, ch.maxY - e.y, ch.maxZ - e.z + 0.1)) continue;
        gl.uniform3f(u.uOff, ch.ox - e.x, ch.oy - e.y, -e.z);
        gl.uniform2f(u.uOrigin, ch.ox, ch.oy);
        A.begin();
        A.bind(this.P.terrain.a.aPos, ch.bPos, 3);
        A.bind(this.P.terrain.a.aNrm, ch.bNrm, 3);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ch.bIdx);
        this._drawElements(ch.count);
      }
      const sk = R.skirt;
      gl.uniform1f(u.uSkirt, 1);
      gl.uniform3f(u.uOff, sk.cx - e.x, sk.cy - e.y, -e.z);
      gl.uniform2f(u.uOrigin, sk.cx, sk.cy);
      A.begin();
      A.bind(this.P.terrain.a.aPos, sk.bPos, 3);
      A.bind(this.P.terrain.a.aNrm, sk.bNrm, 3);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sk.bIdx);
      this._drawElements(sk.count);

      // ---- props (stakes, tee markers, cup)
      const pp = this.P.prop;
      if (R.props) {
        u = this._use(pp, frame);
        gl.uniform3f(u.uOff, -e.x, -e.y, -e.z);
        gl.uniform1f(u.uScale, 1);
        gl.uniform1f(u.uSpec, 0.25);
        A.bind(pp.a.aPos, R.props.bPos, 3);
        A.bind(pp.a.aNrm, R.props.bNrm, 3);
        A.bind(pp.a.aCol, R.props.bCol, 3);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, R.props.bIdx);
        this._drawElements(R.props.count);
      }

      // ---- trees (instanced, two-sided foliage)
      gl.disable(gl.CULL_FACE);
      const tp = this.P.tree;
      const drawTrees = (meshG, set, tint) => {
        if (!set) return;
        u = this._use(tp, frame);
        gl.uniform3fv(u.uTint, tint);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.G.noise);
        gl.uniform1i(u.uNoise, 0);
        gl.uniform2f(u.uFade, 2.5, 7.0);
        A.bind(tp.a.aPos, meshG.pos, 3);
        A.bind(tp.a.aNrm, meshG.nrm, 3);
        A.bind(tp.a.aAttr, meshG.attr, 2);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, meshG.idx);
        this._drawInstanced(tp, meshG, set);
      };
      drawTrees(this.G.pine, R.pines, this.U.tints.pine);
      drawTrees(this.G.broad, R.broads, this.U.tints.broad);

      // ---- themed objects (instanced, one draw per kind present)
      const ob = this.P.obj;
      const ball = scene.ball;
      const clear = !!ball && ball.visible !== false && scene.clearView !== false;
      const MESH = { palm: this.G.palm, saguaro: this.G.saguaro, shrub: this.G.bush, gorse: this.G.bush, rock: this.G.rock, grass: this.G.grass };
      for (const o of OBJ_KINDS) {
        const set = R.objs[o.kind];
        if (!set) continue;
        const meshG = MESH[o.kind];
        u = this._use(ob, frame);
        gl.uniform1f(u.uKind, o.id);
        gl.uniform3fv(u.uTint, this.U.tints[o.kind] || [0.3, 0.4, 0.2]);
        gl.uniform3fv(u.uTint2, this.U.trunks[o.kind] || this.U.tints[o.kind] || [0.3, 0.3, 0.25]);
        gl.uniform4fv(u.uFade, o.fade);
        gl.uniform4f(u.uClear, clear ? ball.x : 0, clear ? ball.y : 0, clear ? ball.z : 0, clear ? 1 : 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.G.noise);
        gl.uniform1i(u.uNoise, 0);
        A.bind(ob.a.aPos, meshG.pos, 3);
        A.bind(ob.a.aNrm, meshG.nrm, 3);
        A.bind(ob.a.aAttr, meshG.attr, 4);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, meshG.idx);
        this._drawInstanced(ob, meshG, set);
      }

      gl.enable(gl.CULL_FACE);
    }

    // ---- the golfer (opaque, skinned)
    const golf = this._golferPrep(scene.golfer);
    if (golf) this._drawGolfer(golf, frame);

    // ---- ball (icosphere when it covers its minimum size, else a billboard after the sky).
    // scene.ball.minPx (CSS px radius, default 2.5) keeps it readable from a raised camera.
    const ball = scene.ball;
    let farBall = null;
    if (ball && ball.visible !== false) {
      const d = Math.hypot(ball.x - e.x, ball.y - e.y, ball.z - e.z);
      const rPx = (BALL_R / Math.max(d, 1e-3)) * this.pxPerRad;
      const minPx = Math.max(2.5, ball.minPx || 0);
      if (rPx >= minPx) {
        const pp = this.P.prop;
        const u = this._use(pp, frame);
        gl.uniform3f(u.uOff, ball.x - e.x, ball.y - e.y, ball.z - e.z);
        gl.uniform1f(u.uScale, BALL_R);
        gl.uniform1f(u.uSpec, 0.6);
        A.bind(pp.a.aPos, this.G.ico.pos, 3);
        A.bind(pp.a.aNrm, this.G.ico.nrm, 3);
        A.end();
        if (pp.a.aCol !== undefined) gl.vertexAttrib3f(pp.a.aCol, 0.96, 0.96, 0.95);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.G.ico.idx);
        this._drawElements(this.G.ico.count);
      } else {
        farBall = { d, r: (minPx * d) / this.pxPerRad };
      }
    }

    // ---- sky last among opaques: only fills pixels at depth 1
    {
      const sp = this.P.sky;
      const u = this._use(sp, frame);
      gl.uniformMatrix4fv(u.uInvVP, false, this.invVP);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.G.clouds);
      gl.uniform1i(u.uClouds, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.G.noise);
      gl.uniform1i(u.uNoise, 1);
      const U = this.U;
      gl.uniform4fv(u.uCloud, U.cloud);
      gl.uniform3fv(u.uRidgeFar, U.ridgeFar);
      gl.uniform3fv(u.uRidgeNear, U.ridgeNear);
      gl.uniform4fv(u.uHz, U.hz);
      gl.uniform4fv(u.uSea, U.sea);
      gl.uniform4f(u.uSea2, Math.max(0.5, e.z - U.seaLevel), U.seaHaze, U.waterK[2], 0);
      gl.uniform3fv(u.uSeaCol, U.seaCol);
      gl.depthMask(false);
      A.bind(sp.a.aPos, this.G.skyTri, 2);
      this.attribs.end();
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      st.drawCalls++;
      st.tris += 1;
    }

    // ---- transparent passes
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    if (R && R.water) {
      const wp = this.P.water;
      const u = this._use(wp, frame);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.G.noise);
      gl.uniform1i(u.uNoise, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, R.depth);
      gl.uniform1i(u.uDepth, 1);
      gl.uniform2fv(u.uDepthMin, R.depthMin);
      gl.uniform2fv(u.uDepthInv, R.depthInv);
      gl.uniform3fv(u.uDeep, this.U.deep);
      gl.uniform4fv(u.uTint, this.U.tint);
      gl.uniform4fv(u.uWaterK, this.U.waterK);
      gl.depthMask(true);
      gl.disable(gl.CULL_FACE);
      A.bind(wp.a.aPos, R.water.bPos, 3);
      A.bind(wp.a.aWater, R.water.bWater, 2);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, R.water.bIdx);
      this._drawElements(R.water.count);
      gl.enable(gl.CULL_FACE);
    }
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -4);
    const op = this.P.overlay;

    // Golfer's ground shadow (a blurred mask of the flattened figure).
    if (golf) this._drawGolferShadow(golf, frame, sun);

    // Blob shadow under the ball: darker and tighter when the ball is on the ground.
    if (ball && ball.visible !== false && T) {
      const gz = T.heightAt(ball.x, ball.y);
      const hgt = Math.max(0, ball.z - BALL_R - gz);
      const fade = Math.max(0, 1 - hgt / 25);
      if (fade > 0) {
        const n = T.normalAt ? T.normalAt(ball.x, ball.y) : { x: 0, y: 0, z: 1 };
        const r = BALL_R * 1.25 + hgt * 0.03 + (farBall ? farBall.r * 0.8 : 0);
        this._groundQuad(ball.x, ball.y, gz + 0.004, n, r);
        const u = this._use(op, frame);
        gl.uniform4f(u.uColor, 0, 0, 0, 0.5 * fade);
        gl.uniform1f(u.uMode, 2);
        this._bindOverlay(this.G.quad, this._quad);
        this._drawStrip(4);
      }
    }

    // Green-read grid.
    if (R && R.read && scene.read && scene.read.on) {
      const rp = this.P.read;
      const u = this._use(rp, frame);
      gl.uniform3f(u.uOff, R.read.cx - e.x, R.read.cy - e.y, -e.z);
      gl.uniform2f(u.uCenter, R.read.cx, R.read.cy);
      gl.uniform1f(u.uChevrons, scene.read.chevrons === false ? 0 : 1);
      gl.uniform1f(u.uAlpha, scene.read.alpha == null ? 0.75 : scene.read.alpha);
      A.bind(rp.a.aPos, R.read.bData, 3, 24, 0);
      A.bind(rp.a.aGrad, R.read.bData, 3, 24, 12);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, R.read.bIdx);
      this._drawElements(R.read.count);
    }

    // Flowing slope streaks (scene.read.flow = their alpha), stepped on the scene clock.
    const flowA = scene.read && scene.read.on ? scene.read.flow || 0 : 0;
    if (this.flow && flowA > 0) {
      const t = scene.time || 0;
      if (this._flowT != null) this.flow.step(Math.min(0.1, Math.max(0, t - this._flowT)));
      this._flowT = t;
      const m = this.flow.writeQuads(this._flowBuf, e, { pxPerRad: this.pxPerRad, minPx: scene.read.flowPx || 3 });
      if (m > 0) {
        const fp = this.P.flow;
        const u = this._use(fp, frame);
        gl.uniform1f(u.uAlpha, flowA);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.G.flow);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._flowBuf.subarray(0, m * 4 * FLOW_FLOATS));
        const S = FLOW_FLOATS * 4;
        A.bind(fp.a.aPos, this.G.flow, 3, S, 0);
        A.bind(fp.a.aUV, this.G.flow, 2, S, 12);
        A.bind(fp.a.aMisc, this.G.flow, 2, S, 20);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.G.flowIdx);
        this._drawElements(m * 6);
      }
    } else this._flowT = null;

    // Aim line (dashed, draped) with the landing ring.
    if (scene.aim && T) {
      const n = aimRibbon(T, scene.aim, e, this._aimBuf, { pxPerRad: this.pxPerRad });
      const u = this._use(op, frame);
      gl.uniform4f(u.uColor, 1, 1, 1, 0.85);
      gl.uniform1f(u.uMode, 1);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.G.aim);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._aimBuf.subarray(0, n * 6));
      A.bind(op.a.aPos, this.G.aim, 3, 24, 0);
      A.bind(op.a.aMisc, this.G.aim, 3, 24, 12);
      this._drawStrip(n);
    }

    // Draped dotted paths (putt preview, chip roll): scene.paths = [{data: [x,y,z]*, count, color:
    // [r,g,b,a], width, minPx, ring, ringR}], at most PATH_MAX.
    if (scene.paths && T) {
      for (let k = 0; k < Math.min(PATH_MAX, scene.paths.length); k++) {
        const pth = scene.paths[k];
        if (!pth || pth.count < 2) continue;
        const n = pathRibbon(pth.data, pth.count, e, this._pathBuf, { width: pth.width || 0.035, minPx: pth.minPx || 6, pxPerRad: this.pxPerRad, ring: !!pth.ring, ringR: pth.ringR || 0.12, terrain: T });
        if (n < 3) continue;
        const u = this._use(op, frame);
        const col = pth.color || [1, 1, 1, 1];
        gl.uniform4f(u.uColor, col[0], col[1], col[2], col[3] == null ? 1 : col[3]);
        gl.uniform1f(u.uMode, 4);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.G.paths[k]);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._pathBuf.subarray(0, n * 6));
        A.bind(op.a.aPos, this.G.paths[k], 3, 24, 0);
        A.bind(op.a.aMisc, this.G.paths[k], 3, 24, 12);
        this._drawStrip(n);
      }
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);

    // ---- flagstick and flag, after the aim line so the line never paints over the pin. Far away
    // they keep a minimum size on screen (pole >= 40 px tall, flag >= 18 px long): the target.
    if (R && T && T.cup && (!scene.pin || scene.pin.visible !== false)) {
      const fp = this.P.flag;
      const c = T.cup;
      const d = Math.hypot(c.x - e.x, c.y - e.y, c.z + 1.5 - e.z);
      const mPerPx = d / this.pxPerRad;
      const u = this._use(fp, frame);
      gl.depthMask(true);
      gl.uniform3f(u.uOff, c.x - e.x, c.y - e.y, c.z - e.z);
      gl.uniform1f(u.uPoleR, Math.max(FLAGSTICK_R, 0.8 * mPerPx));
      gl.uniform1f(u.uFlagS, Math.min(30, Math.max(1, (18 * mPerPx) / 0.52)));
      gl.uniform1f(u.uPoleH, Math.max(FLAGSTICK_H, 40 * mPerPx));
      A.bind(fp.a.aPos, this.G.flag.pos, 3);
      A.bind(fp.a.aNrm, this.G.flag.nrm, 3);
      A.bind(fp.a.aAttr, this.G.flag.attr, 3);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.G.flag.idx);
      this._drawElements(this.G.flag.count);
      gl.depthMask(false);
    }

    // Shot trail.
    if (scene.trail && scene.trail.count > 1) {
      let n = trailRibbon(scene.trail.data, scene.trail.count, e, this._trailBuf, { pxPerRad: this.pxPerRad });
      if (n < 0) n = 0;
      if (n > 0) {
        const u = this._use(op, frame);
        gl.uniform4f(u.uColor, 1.0, 0.82, 0.3, 0.9);
        gl.uniform1f(u.uMode, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.G.trail);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._trailBuf.subarray(0, n * 6));
        A.bind(op.a.aPos, this.G.trail, 3, 24, 0);
        A.bind(op.a.aMisc, this.G.trail, 3, 24, 12);
        this._drawStrip(n);
      }
    }

    // Far ball: a camera-facing disc at least 2.5 CSS px in radius.
    if (farBall) {
      this._billboard(ball, farBall.r, cam);
      const u = this._use(op, frame);
      gl.uniform4f(u.uColor, 0.98, 0.98, 0.97, 1);
      gl.uniform1f(u.uMode, 3);
      this._bindOverlay(this.G.quad2, this._quad);
      this._drawStrip(4);
    }

    gl.depthMask(true);
    gl.disable(gl.BLEND);
    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    st.ms += (t1 - now - st.ms) * 0.1;
  }

  // ------------------------------------------------------------------ golfer
  // scene.golfer = {visible, mesh | {look, club}, bones: Float32Array (skin matrices, world),
  // alpha}. Returns the draw state or null.
  _golferPrep(gs) {
    if (!gs || gs.visible === false || !gs.bones) return null;
    const alpha = gs.alpha == null ? 1 : gs.alpha;
    if (alpha <= 0.004) return null;
    let mesh = gs.mesh;
    if (!mesh) {
      const key = JSON.stringify([gs.look || null, gs.club || '7i']);
      if (!this._golferMesh || this._golferMesh.key !== key) this._golferMesh = { key, mesh: buildGolferMesh(gs.look, gs.club || '7i') };
      mesh = this._golferMesh.mesh;
    }
    const G = this._golferUpload(mesh);
    if (!G) return null;
    // Camera-relative skin matrices; a mirrored figure (left-hander) flips the winding.
    const src = gs.bones;
    const b = this._golferBones;
    const n = Math.min(src.length, b.length);
    for (let i = 0; i < n; i++) b[i] = src[i];
    const e = this.eye;
    for (let o = 0; o + 15 < n; o += 16) {
      b[o + 12] -= e.x;
      b[o + 13] -= e.y;
      b[o + 14] -= e.z;
    }
    const det = b[0] * (b[5] * b[10] - b[6] * b[9]) - b[4] * (b[1] * b[10] - b[2] * b[9]) + b[8] * (b[1] * b[6] - b[2] * b[5]);
    // Ground under the golfer: the pelvis (mesh.center) carried by the root's skin matrix.
    const c = mesh.center || [0, 0, 1];
    const wx = src[0] * c[0] + src[4] * c[1] + src[8] * c[2] + src[12];
    const wy = src[1] * c[0] + src[5] * c[1] + src[9] * c[2] + src[13];
    return { G, alpha, mirror: det < 0, wx, wy, fadeNear: gs.fadeNear !== false };
  }

  _golferUpload(mesh) {
    const gl = this.gl;
    if (this.golferGL && this.golferGL.mesh === mesh) return this.golferGL;
    if (this.golferGL) for (const k of ['pos', 'nrm', 'col', 'bm', 'idx']) gl.deleteBuffer(this.golferGL[k]);
    const nv = mesh.pos.length / 3;
    const bm = new Float32Array(nv * 2);
    for (let i = 0; i < nv; i++) {
      bm[i * 2] = mesh.bone[i];
      bm[i * 2 + 1] = mesh.mat ? mesh.mat[i] : 0;
    }
    this.golferGL = {
      mesh,
      pos: makeBuffer(gl, mesh.pos),
      nrm: makeBuffer(gl, mesh.nrm),
      col: makeBuffer(gl, mesh.col),
      bm: makeBuffer(gl, bm),
      idx: makeBuffer(gl, mesh.idx, gl.ELEMENT_ARRAY_BUFFER),
      count: mesh.idx.length,
    };
    return this.golferGL;
  }

  _drawGolfer(st, frame) {
    const gl = this.gl;
    const p = this.P.golfer;
    const u = this._use(p, frame);
    gl.uniformMatrix4fv(u.uBones, false, this._golferBones);
    gl.uniform1f(u.uAlpha, st.alpha);
    gl.uniform1f(u.uNear, st.fadeNear ? 1 : 0);
    const A = this.attribs;
    A.bind(p.a.aPos, st.G.pos, 3);
    A.bind(p.a.aNrm, st.G.nrm, 3);
    A.bind(p.a.aCol, st.G.col, 3);
    A.bind(p.a.aBM, st.G.bm, 2);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, st.G.idx);
    gl.enable(gl.CULL_FACE);
    if (st.mirror) gl.frontFace(gl.CW);
    this._drawElements(st.G.count);
    gl.frontFace(gl.CCW);
  }

  _makeMask(size) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return ok ? { tex, fb, size } : null;
  }

  // The golfer's sun shadow: the flattened figure rendered into the mask over a square of ground
  // under and beyond the feet (away from the sun), then laid on the ground blurred.
  _drawGolferShadow(st, frame, sun) {
    const M = this._shadowMask;
    if (!M) return;
    const gl = this.gl;
    const T = this.terrain;
    const e = this.eye;
    let gz = 0;
    let n = { x: 0, y: 0, z: 1 };
    if (T) {
      gz = T.heightAt(st.wx, st.wy);
      if (T.normalAt) n = T.normalAt(st.wx, st.wy);
    }
    const alpha = 0.42 * st.alpha * Math.min(1, Math.max(0, sun.z * 2.5));
    if (alpha < 0.004) return;
    // Shadow length of a ~2.4 m figure-with-club; the square reaches that far from the feet.
    const sh = Math.hypot(sun.x, sun.y);
    const len = Math.min(8, (2.4 * sh) / Math.max(0.2, sun.z));
    const half = 1.4 + 0.5 * len;
    const ox = sh > 1e-4 ? (-sun.x / sh) * len * 0.5 : 0;
    const oy = sh > 1e-4 ? (-sun.y / sh) * len * 0.5 : 0;
    const cx = st.wx + ox;
    const cy = st.wy + oy;
    const cz = gz - (n.x * ox + n.y * oy) / (n.z || 1) + 0.02;
    // Quad (also defines the mask axes).
    this._groundQuad(cx, cy, cz, n, half);
    const q = this._quad;
    // Axes from the quad's corners: a = (corner1 - corner0) / 2r, b = (corner2 - corner0) / 2r.
    const ax = (q[6] - q[0]) / (2 * half);
    const ay = (q[7] - q[1]) / (2 * half);
    const az = (q[8] - q[2]) / (2 * half);
    const bx = (q[12] - q[0]) / (2 * half);
    const by = (q[13] - q[1]) / (2 * half);
    const bz = (q[14] - q[2]) / (2 * half);
    // ---- mask pass
    gl.bindFramebuffer(gl.FRAMEBUFFER, M.fb);
    gl.viewport(0, 0, M.size, M.size);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    const pm = this.P.golferMask;
    let u = this._use(pm, frame);
    gl.uniformMatrix4fv(u.uBones, false, this._golferBones);
    const d = -(n.x * (st.wx - e.x) + n.y * (st.wy - e.y) + n.z * (gz - e.z));
    gl.uniform4f(u.uPlane, n.x, n.y, n.z, d);
    gl.uniform3f(u.uSun, sun.x, sun.y, sun.z);
    gl.uniform3f(u.uC, cx - e.x, cy - e.y, cz - e.z);
    gl.uniform3f(u.uE1, ax, ay, az);
    gl.uniform3f(u.uE2, bx, by, bz);
    gl.uniform1f(u.uInvHalf, 1 / half);
    const A = this.attribs;
    A.bind(pm.a.aPos, st.G.pos, 3);
    A.bind(pm.a.aBM, st.G.bm, 2);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, st.G.idx);
    this._drawElements(st.G.count);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    // ---- ground quad
    const pg = this.P.golferGround;
    u = this._use(pg, frame);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, M.tex);
    gl.uniform1i(u.uMask, 0);
    gl.uniform1f(u.uAlpha, alpha);
    gl.uniform2f(u.uTexel, 1.2 / M.size, 1.2 / M.size);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.G.quad);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._quad);
    A.bind(pg.a.aPos, this.G.quad, 3, 24, 0);
    A.bind(pg.a.aMisc, this.G.quad, 3, 24, 12);
    this._drawStrip(4);
  }

  _bindOverlay(buffer, data) {
    const gl = this.gl;
    const op = this.P.overlay;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    this.attribs.bind(op.a.aPos, buffer, 3, 24, 0);
    this.attribs.bind(op.a.aMisc, buffer, 3, 24, 12);
  }

  // Quad lying on the ground plane with normal n, camera-relative, into this._quad (strip order).
  _groundQuad(x, y, z, n, r) {
    let ax = 1;
    let ay = 0;
    let az = -n.x / (n.z || 1);
    const al = Math.hypot(ax, ay, az);
    ax /= al;
    ay /= al;
    az /= al;
    // b = n x a
    const bx = n.y * az - n.z * ay;
    const by = n.z * ax - n.x * az;
    const bz = n.x * ay - n.y * ax;
    const e = this.eye;
    const q = this._quad;
    const c = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    for (let k = 0; k < 4; k++) {
      const [s, t] = c[k];
      q[k * 6] = x + (ax * s + bx * t) * r - e.x;
      q[k * 6 + 1] = y + (ay * s + by * t) * r - e.y;
      q[k * 6 + 2] = z + (az * s + bz * t) * r - e.z;
      q[k * 6 + 3] = s;
      q[k * 6 + 4] = t;
      q[k * 6 + 5] = 1;
    }
  }

  _billboard(p, r, cam) {
    const e = this.eye;
    let fx = p.x - e.x;
    let fy = p.y - e.y;
    let fz = p.z - e.z;
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl;
    fy /= fl;
    fz /= fl;
    const up = cam.up || { x: 0, y: 0, z: 1 };
    // right = f x up, top = right x f
    let rx = fy * up.z - fz * up.y;
    let ry = fz * up.x - fx * up.z;
    let rz = fx * up.y - fy * up.x;
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl;
    ry /= rl;
    rz /= rl;
    const tx = ry * fz - rz * fy;
    const ty = rz * fx - rx * fz;
    const tz = rx * fy - ry * fx;
    const q = this._quad;
    const c = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    for (let k = 0; k < 4; k++) {
      const [s, t] = c[k];
      q[k * 6] = p.x - e.x + (rx * s + tx * t) * r;
      q[k * 6 + 1] = p.y - e.y + (ry * s + ty * t) * r;
      q[k * 6 + 2] = p.z - e.z + (rz * s + tz * t) * r;
      q[k * 6 + 3] = s;
      q[k * 6 + 4] = t;
      q[k * 6 + 5] = 1;
    }
  }
}
