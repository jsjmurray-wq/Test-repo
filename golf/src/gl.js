// Thin WebGL helpers: context creation (WebGL2, falling back to WebGL1 + extensions), program
// compilation with automatic attribute/uniform lookup, buffers, textures and instancing. GLSL 100
// shaders are used everywhere so one source runs on both context versions.

// Create a context. Returns null when WebGL is unavailable.
// {gl, gl2, inst:{divisor(loc, n), drawElements(mode, count, type, offset, instances)}, uint32}
export function createContext(canvas, { test = false, forceGL1 = false } = {}) {
  const attrs = {
    alpha: false,
    antialias: true,
    depth: true,
    stencil: false,
    premultipliedAlpha: false,
    // Tests read pixels back after the frame; normal play lets the browser discard the buffer.
    preserveDrawingBuffer: !!test,
    powerPreference: 'high-performance',
  };
  let gl = null;
  let gl2 = false;
  try {
    if (!forceGL1) gl = canvas.getContext('webgl2', attrs);
    if (gl) gl2 = true;
    else gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
  } catch {
    gl = null;
  }
  if (!gl) return null;
  let inst;
  let uint32 = gl2;
  if (gl2) {
    inst = {
      divisor: (loc, n) => gl.vertexAttribDivisor(loc, n),
      drawElements: (mode, count, type, offset, n) => gl.drawElementsInstanced(mode, count, type, offset, n),
    };
  } else {
    const ext = gl.getExtension('ANGLE_instanced_arrays');
    uint32 = !!gl.getExtension('OES_element_index_uint');
    if (ext) {
      inst = {
        divisor: (loc, n) => ext.vertexAttribDivisorANGLE(loc, n),
        drawElements: (mode, count, type, offset, n) => ext.drawElementsInstancedANGLE(mode, count, type, offset, n),
      };
    } else {
      inst = null; // the renderer falls back to one draw per instance batch (see render.js)
    }
  }
  return { gl, gl2, inst, uint32 };
}

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader compile failed: ${log}\n${src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n')}`);
  }
  return sh;
}

// Compile and link; returns {prog, a:{name: location}, u:{name: location}}. Attribute and uniform
// names are discovered from the linked program, so shaders can add inputs freely.
export function createProgram(gl, vsSrc, fsSrc) {
  const prog = gl.createProgram();
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(prog)}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  const a = {};
  const u = {};
  const na = gl.getProgramParameter(prog, gl.ACTIVE_ATTRIBUTES) || 0;
  for (let k = 0; k < na; k++) {
    const info = gl.getActiveAttrib(prog, k);
    if (info) a[info.name] = gl.getAttribLocation(prog, info.name);
  }
  const nu = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) || 0;
  for (let k = 0; k < nu; k++) {
    const info = gl.getActiveUniform(prog, k);
    if (info) {
      const name = info.name.replace(/\[0\]$/, '');
      u[name] = gl.getUniformLocation(prog, info.name);
    }
  }
  return { prog, a, u };
}

export function makeBuffer(gl, data, target = gl.ARRAY_BUFFER, usage = gl.STATIC_DRAW) {
  const b = gl.createBuffer();
  gl.bindBuffer(target, b);
  gl.bufferData(target, data, usage);
  return b;
}

// RGBA8 texture from {width, height, data}. opts: {repeat, mip, nearest}.
// WebGL1 can only repeat or mipmap power-of-two textures; NPOT ones silently fall back to clamp/linear.
export function makeTexture(gl, img, { repeat = false, mip = false, nearest = false, gl2 = false } = {}) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, img.data);
  const pot = (img.width & (img.width - 1)) === 0 && (img.height & (img.height - 1)) === 0;
  const canMip = mip && (gl2 || pot);
  const canRepeat = repeat && (gl2 || pot);
  if (canMip) gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, canMip ? gl.LINEAR_MIPMAP_LINEAR : nearest ? gl.NEAREST : gl.LINEAR);
  const wrap = canRepeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  return t;
}

// Attribute binder that tracks enabled arrays and divisors so switching programs never leaves a
// stale array enabled (a classic source of INVALID_OPERATION on WebGL1).
export class AttribState {
  constructor(gl, inst) {
    this.gl = gl;
    this.inst = inst;
    this.enabled = new Set();
    this.used = new Set();
    this.divs = new Set();
  }
  begin() {
    this.used.clear();
  }
  // Bind buffer `buf` to attribute `loc` (skipped when the program optimised it away: loc < 0/undefined).
  bind(loc, buf, size, stride = 0, offset = 0, divisor = 0) {
    if (loc === undefined || loc < 0) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
    if (!this.enabled.has(loc)) {
      gl.enableVertexAttribArray(loc);
      this.enabled.add(loc);
    }
    if (this.inst && (divisor || this.divs.has(loc))) {
      this.inst.divisor(loc, divisor);
      if (divisor) this.divs.add(loc);
      else this.divs.delete(loc);
    }
    this.used.add(loc);
  }
  // Disable every array the current draw does not use.
  end() {
    for (const loc of this.enabled) {
      if (!this.used.has(loc)) {
        if (this.inst && this.divs.has(loc)) {
          this.inst.divisor(loc, 0);
          this.divs.delete(loc);
        }
        this.gl.disableVertexAttribArray(loc);
        this.enabled.delete(loc);
      }
    }
  }
  reset() {
    this.enabled.clear();
    this.divs.clear();
    this.used.clear();
  }
}
