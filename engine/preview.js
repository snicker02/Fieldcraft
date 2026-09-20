// engine/preview.js
// Draws the merged block mesh. Deliberately plain: flat per-face colour, one
// key light plus fill, no shadows. The preview is for reading the shape and
// the material split, not for looking good on its own.

const VS = `#version 300 es
in vec3 aPos;
in vec3 aNrm;
in vec3 aCol;
uniform mat4 uViewProj;
out vec3 vNrm;
out vec3 vCol;
void main() {
  vNrm = aNrm;
  vCol = aCol;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 vNrm;
in vec3 vCol;
uniform vec3 uKey;
out vec4 fragColor;
void main() {
  vec3 n = normalize(vNrm);
  float key = max(dot(n, uKey), 0.0);
  float fill = 0.5 + 0.5 * n.y;
  vec3 c = vCol * (0.28 + 0.62 * key + 0.18 * fill);
  fragColor = vec4(pow(c, vec3(0.4545)), 1.0);
}`;

function perspective(out, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  out.set([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  return out;
}

function lookAt(out, eye, center, up) {
  let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
  let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  out.set([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ]);
  return out;
}

function multiply(out, a, b) {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

export class Preview {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('WebGL2 is not available for the preview');
    this.gl = gl;

    const mk = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, FS));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.bindAttribLocation(p, 1, 'aNrm');
    gl.bindAttribLocation(p, 2, 'aCol');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.program = p;
    this.uViewProj = gl.getUniformLocation(p, 'uViewProj');
    this.uKey = gl.getUniformLocation(p, 'uKey');

    this.vao = gl.createVertexArray();
    this.buffers = { pos: gl.createBuffer(), nrm: gl.createBuffer(), col: gl.createBuffer(), idx: gl.createBuffer() };
    this.indexCount = 0;
    this.indexType = gl.UNSIGNED_SHORT;

    this.center = [0, 0, 0];
    this.radius = 32;
    this.yaw = 0.7;
    this.pitch = 0.5;
    this.dist = 3;

    this._proj = new Float32Array(16);
    this._view = new Float32Array(16);
    this._vp = new Float32Array(16);
    this._dirty = true;

    this._bindInput();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  _bindInput() {
    const c = this.canvas;
    let down = false, lx = 0, ly = 0;
    c.addEventListener('pointerdown', e => { down = true; lx = e.clientX; ly = e.clientY; c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointerup', e => { down = false; c.releasePointerCapture(e.pointerId); });
    c.addEventListener('pointermove', e => {
      if (!down) return;
      this.yaw -= (e.clientX - lx) * 0.008;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch + (e.clientY - ly) * 0.008));
      lx = e.clientX; ly = e.clientY;
      this._dirty = true;
    });
    c.addEventListener('wheel', e => {
      e.preventDefault();
      this.dist = Math.max(0.35, Math.min(12, this.dist * Math.exp(e.deltaY * 0.0012)));
      this._dirty = true;
    }, { passive: false });
  }

  setMesh(mesh, bounds) {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    const attr = (buf, data, loc, size) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    attr(this.buffers.pos, mesh.positions, 0, 3);
    attr(this.buffers.nrm, mesh.normals, 1, 3);
    attr(this.buffers.col, mesh.colors, 2, 3);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buffers.idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.indexCount = mesh.indices.length;
    this.indexType = mesh.indexType === 'uint32' ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;

    if (bounds) {
      this.center = [
        bounds.min[0] + bounds.size[0] / 2,
        bounds.min[1] + bounds.size[1] / 2,
        bounds.min[2] + bounds.size[2] / 2,
      ];
      this.radius = Math.max(1, Math.hypot(bounds.size[0], bounds.size[1], bounds.size[2]) / 2);
    }
    this._dirty = true;
  }

  clear() { this.indexCount = 0; this._dirty = true; }

  _resize() {
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; this._dirty = true; }
  }

  _loop() {
    this._resize();
    if (this._dirty) this.draw();
    requestAnimationFrame(this._loop);
  }

  draw() {
    const gl = this.gl;
    this._dirty = false;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.055, 0.06, 0.075, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.indexCount) return;

    const d = this.radius * 2.6 * this.dist;
    const eye = [
      this.center[0] + d * Math.cos(this.pitch) * Math.sin(this.yaw),
      this.center[1] + d * Math.sin(this.pitch),
      this.center[2] + d * Math.cos(this.pitch) * Math.cos(this.yaw),
    ];
    perspective(this._proj, 0.9, this.canvas.width / this.canvas.height, Math.max(0.05, d * 0.002), d * 6 + this.radius * 8);
    lookAt(this._view, eye, this.center, [0, 1, 0]);
    multiply(this._vp, this._proj, this._view);

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uViewProj, false, this._vp);
    gl.uniform3f(this.uKey, 0.35, 0.86, 0.37);
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.indexCount, this.indexType, 0);
    gl.bindVertexArray(null);
  }
}
