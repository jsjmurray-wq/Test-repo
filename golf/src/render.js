// WebGL renderer for one hole: sky, terrain, water, trees, furniture, ball, trail and overlays.
//
// Design notes
// - One GLSL 100 code path for WebGL2 and WebGL1 (+ ANGLE_instanced_arrays). Uint16 indices only.
// - Camera-relative rendering: every vertex shader works with p - eye, and the view matrix holds the
//   rotation only. Terrain chunks carry chunk-local positions plus a per-chunk offset uniform.
// - Draw-call budget <= 25: terrain <= 10 chunks (frustum culled) + skirt, sky, water, 2 tree kinds
//   (instanced), props (stakes, tee markers, cup), flag, ball, blob shadow, read grid, aim, trail.
// - Every GPU resource is rebuilt from CPU copies on webglcontextrestored.
// - Resolution: DPR capped at 2 times an adaptive renderScale (0.6..1) driven by the frame interval.

import { createContext, contextExtensions, createProgram, makeBuffer, makeTexture, AttribState } from './gl.js';
import { perspective, lookAt, multiply, invert, project as projectPt, unproject } from './mat4.js';
import {
  terrainChunks, skirtMesh, icosphere, MeshBuilder, pineMesh, broadleafMesh, flagMesh, waterMesh,
  greenReadMesh, trailRibbon, aimRibbon, skirtTrees,
} from './meshes.js';
import { bakeTerrainColor, bakeClouds, bakeNoise, SUN_DIR } from './bake.js';
import {
  SKY_VS, SKY_FS, TERRAIN_VS, TERRAIN_FS, WATER_VS, WATER_FS, TREE_VS, TREE_FS, PROP_VS, PROP_FS,
  FLAG_VS, FLAG_FS, OVERLAY_VS, OVERLAY_FS, READ_VS, READ_FS,
} from './shaders.js';
import { BALL_R, CUP_R, FLAGSTICK_H, FLAGSTICK_R } from './constants.js';

// Lighting (linear). Tuned against screenshots for a bright broadcast look.
const SUN_COL = [1.0 * 1.08, 0.95 * 1.08, 0.86 * 1.08];
const ZENITH = [0.07, 0.19, 0.56];
const HORIZON = [0.46, 0.6, 0.78];
const FOG_K = 1 / 1100;
const EXPOSURE = 1.0;

const PINE_TINT = [0.11, 0.2, 0.11];
const BROAD_TINT = [0.19, 0.3, 0.12];

const ZERO = { x: 0, y: 0, z: 0 };

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
    this.cpu = null;
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
    };
    // Static meshes (built once on the CPU and kept for restore).
    if (!this.static) {
      this.static = {
        clouds: bakeClouds(11),
        noise: bakeNoise(3),
        ico: icosphere(2),
        pine: pineMesh(),
        broad: broadleafMesh(),
        flag: flagMesh(),
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
      trail: gl.createBuffer(),
      aim: gl.createBuffer(),
      quad: gl.createBuffer(),
      quad2: gl.createBuffer(),
    };
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
    const stride = this.quality === 'low' ? 2 : 1;
    const chunks = terrainChunks(terrain.grid, { stride });
    const skirt = skirtMesh(terrain.grid);
    const bake = bakeTerrainColor(terrain, { sunDir: SUN_DIR });
    const water = waterMesh(terrain.waters);
    const read = greenReadMesh(terrain);
    // Tree instances: [x, y, z, canopy-centre height, rx, rz, trunkR, seed] per tree, by kind.
    const pines = [];
    const broads = [];
    (terrain.trees || []).forEach((t, k) => {
      const c = t.canopy || { cz: t.z + 6, rx: 3, rz: 3 };
      const seed = ((Math.sin(k * 12.9898 + t.x * 0.37 + t.y * 0.11) * 43758.5453) % 1 + 1) % 1;
      const row = [t.x, t.y, t.z, c.cz - t.z, c.rx, c.rz, t.trunkR || 0.25, seed];
      (t.kind === 'pine' ? pines : broads).push(...row);
    });
    const bg = skirtTrees(skirt, { perVertex: this.quality === 'low' ? 0.6 : 1.3 });
    pines.push(...bg.pines);
    broads.push(...bg.broads);
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
    this.cpu = {
      chunks, skirt, bake, water, read, props,
      pines: new Float32Array(pines), broads: new Float32Array(broads),
      mow: [mx, my],
    };
    if (this.ok && !this.lost) this._uploadHole();
  }

  _uploadHole() {
    const gl = this.gl;
    const c = this.cpu;
    // Free the previous hole's buffers.
    if (this.res) {
      for (const b of this.res.buffers) gl.deleteBuffer(b);
      gl.deleteTexture(this.res.bake);
    }
    const buffers = [];
    const buf = (data, target) => {
      const b = makeBuffer(gl, data, target);
      buffers.push(b);
      return b;
    };
    const E = gl.ELEMENT_ARRAY_BUFFER;
    const res = { buffers };
    res.chunks = c.chunks.map((ch) => ({
      ...ch,
      bPos: buf(ch.pos), bNrm: buf(ch.nrm), bIdx: buf(ch.idx, E), count: ch.idx.length,
    }));
    res.skirt = { cx: c.skirt.cx, cy: c.skirt.cy, bPos: buf(c.skirt.pos), bNrm: buf(c.skirt.nrm), bIdx: buf(c.skirt.idx, E), count: c.skirt.idx.length };
    res.water = c.water.idx.length ? { bPos: buf(c.water.pos), bIdx: buf(c.water.idx, E), count: c.water.idx.length } : null;
    res.read = c.read ? { cx: c.read.cx, cy: c.read.cy, bData: buf(c.read.data), bIdx: buf(c.read.idx, E), count: c.read.idx.length } : null;
    res.props = c.props.idx.length
      ? { bPos: buf(c.props.pos), bNrm: buf(c.props.nrm), bCol: buf(c.props.col), bIdx: buf(c.props.idx, E), count: c.props.idx.length }
      : null;
    res.pines = c.pines.length ? { b: buf(c.pines), n: c.pines.length / 8, cpu: c.pines } : null;
    res.broads = c.broads.length ? { b: buf(c.broads), n: c.broads.length / 8, cpu: c.broads } : null;
    const bk = c.bake;
    res.bake = makeTexture(gl, bk, { mip: true, gl2: this.ctx.gl2 });
    res.bakeMin = [bk.minX, bk.minY];
    res.bakeInv = [1 / (bk.width * bk.step), 1 / (bk.height * bk.step)];
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
    if (u.uVP) gl.uniformMatrix4fv(u.uVP, false, this.vp);
    if (u.uSun) gl.uniform3f(u.uSun, frame.sun.x, frame.sun.y, frame.sun.z);
    if (u.uSunCol) gl.uniform3fv(u.uSunCol, SUN_COL);
    if (u.uZenith) gl.uniform3fv(u.uZenith, ZENITH);
    if (u.uHorizon) gl.uniform3fv(u.uHorizon, HORIZON);
    if (u.uFogK) gl.uniform1f(u.uFogK, frame.fogK);
    if (u.uExposure) gl.uniform1f(u.uExposure, EXPOSURE);
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
    const fwd = { x: cam.target.x - e.x, y: cam.target.y - e.y, z: cam.target.z - e.z };
    const view = lookAt(ZERO, fwd, cam.up || { x: 0, y: 0, z: 1 });
    multiply(proj, view, this.vp);
    invert(this.vp, this.invVP);
    this.pxPerRad = this.cssH / (2 * Math.tan(fovY / 2));
    let sun = scene.sunDir || SUN_DIR;
    const sl = Math.hypot(sun.x, sun.y, sun.z) || 1;
    sun = { x: sun.x / sl, y: sun.y / sl, z: sun.z / sl };
    // Thinner haze for high cameras (map, flyover): the air above is clearer, and a uniform exp2 fog
    // would wash out a top-down view.
    const agl = this.terrain ? Math.max(0, e.z - this.terrain.heightAt(e.x, e.y)) : 0;
    const fogK = FOG_K / (1 + Math.max(0, agl - 30) / 100);
    const frame = { sun, fogK, time: scene.time || 0, wind: scene.wind || { x: 0, y: 0 } };

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
      gl.uniform2fv(u.uBakeMin, R.bakeMin);
      gl.uniform2fv(u.uBakeInv, R.bakeInv);
      gl.uniform2fv(u.uMow, this.cpu.mow);
      gl.uniform1f(u.uSkirt, 0);
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
        if (this.ctx.inst) {
          A.bind(tp.a.iA, set.b, 4, 32, 0, 1);
          A.bind(tp.a.iB, set.b, 4, 32, 16, 1);
          this._drawElements(meshG.count, set.n);
        } else {
          // No instancing extension: constant attributes per tree (rare WebGL1 fallback).
          A.end();
          for (let k = 0; k < set.n; k++) {
            const o = k * 8;
            gl.vertexAttrib4f(tp.a.iA, set.cpu[o], set.cpu[o + 1], set.cpu[o + 2], set.cpu[o + 3]);
            gl.vertexAttrib4f(tp.a.iB, set.cpu[o + 4], set.cpu[o + 5], set.cpu[o + 6], set.cpu[o + 7]);
            gl.drawElements(gl.TRIANGLES, meshG.count, gl.UNSIGNED_SHORT, 0);
          }
          st.drawCalls++;
          st.tris += (meshG.count / 3) * set.n;
        }
      };
      drawTrees(this.G.pine, R.pines, PINE_TINT);
      drawTrees(this.G.broad, R.broads, BROAD_TINT);

      gl.enable(gl.CULL_FACE);
    }

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
      gl.depthMask(true);
      gl.disable(gl.CULL_FACE);
      A.bind(wp.a.aPos, R.water.bPos, 3);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, R.water.bIdx);
      this._drawElements(R.water.count);
      gl.enable(gl.CULL_FACE);
    }
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -4);
    const op = this.P.overlay;

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
