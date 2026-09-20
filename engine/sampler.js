// engine/sampler.js
// Rasterises the field into a volume with WebGL2.
//
// Z slices are packed into a tiled atlas on one large framebuffer and read
// back a slab at a time, so a 256^3 volume is a handful of draw calls rather
// than 256 of them. Nothing here knows about blocks; it hands slabs to
// voxelize.js.

import { uniformDeclarations, deWrapper, materialWrapper } from './bundle.js';
import { computeAtlasLayout } from './voxelize.js';

export const VERTEX_SOURCE = `#version 300 es
void main() {
  vec2 v = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(v * 2.0 - 1.0, 0.0, 1.0);
}`;

const HEADER = `#version 300 es
precision highp float;
precision highp int;

uniform ivec3 fcRes;
uniform vec3  fcBoxMin;
uniform vec3  fcBoxMax;
uniform int   fcTilesX;
uniform int   fcSliceBase;
uniform int   fcSliceCount;
uniform float fcIso;
uniform float fcNormEps;

out vec4 fcOut;
`;

const TAIL = `
vec3 fcNormal(vec3 p) {
  vec2 k = vec2(1.0, -1.0);
  float e = fcNormEps;
  return normalize(
      k.xyy * fcField(p + k.xyy * e)
    + k.yyx * fcField(p + k.yyx * e)
    + k.yxy * fcField(p + k.yxy * e)
    + k.xxx * fcField(p + k.xxx * e));
}

void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  int tw = fcRes.x;
  int th = fcRes.y;
  int tile = (f.y / th) * fcTilesX + (f.x / tw);
  if (tile >= fcSliceCount) { fcOut = vec4(0.0); return; }

  ivec3 c = ivec3(f.x - (f.x / tw) * tw, f.y - (f.y / th) * th, fcSliceBase + tile);
  vec3 span = fcBoxMax - fcBoxMin;
  vec3 p = fcBoxMin + (vec3(c) + 0.5) / vec3(fcRes) * span;

  vec4 trap;
  float d = fcFieldTrap(p, trap) - fcIso;
  if (d > 0.0) { fcOut = vec4(0.0); return; }

  float cell = max(span.x / float(fcRes.x), max(span.y / float(fcRes.y), span.z / float(fcRes.z)));
  vec3 n = fcNormal(p);
  int mid = fcMaterial(p, n, trap);
  float shade = clamp(dot(n, normalize(vec3(0.35, 0.86, 0.37))) * 0.5 + 0.5, 0.0, 1.0);

  fcOut = vec4(
    1.0,
    float(clamp(mid, 0, 255)) / 255.0,
    shade,
    clamp(floor(-d / cell), 0.0, 255.0) / 255.0);
}
`;

/**
 * Assemble the fragment shader for a bundle.
 * @returns {{source:string, sections:Array<{name:string,from:number,to:number}>}}
 */
export function buildFragmentSource(bundle) {
  const parts = [];
  const sections = [];
  const push = (name, text) => {
    const from = parts.join('').split('\n').length;
    parts.push(text.endsWith('\n') ? text : text + '\n');
    const to = parts.join('').split('\n').length - 1;
    sections.push({ name, from, to });
  };

  push('header', HEADER);
  const decls = uniformDeclarations(bundle);
  if (decls) push('bundle uniforms', decls);
  if (bundle.glsl.prelude) push('bundle prelude', bundle.glsl.prelude);
  push('bundle distance estimator', bundle.glsl.de.source);
  if (bundle.glsl.material) push('bundle material expression', bundle.glsl.material.source);
  push('fieldcraft wrappers', deWrapper(bundle) + '\n' + materialWrapper(bundle));
  push('fieldcraft main', TAIL);

  return { source: parts.join(''), sections };
}

function annotate(log, sections) {
  const lines = String(log).trim().split('\n');
  return lines.map(l => {
    const m = /^\s*(?:ERROR|WARNING)?\s*:?\s*\d+\s*:\s*(\d+)/.exec(l);
    if (!m) return l;
    const line = parseInt(m[1], 10);
    const sec = sections.find(s => line >= s.from && line <= s.to);
    return sec ? `${l}    [in ${sec.name}, line ${line - sec.from + 1} of that section]` : l;
  }).join('\n');
}

export class SamplerError extends Error {
  constructor(message) { super(message); this.name = 'SamplerError'; }
}

export class FieldSampler {
  constructor(canvas) {
    this.canvas = canvas || (typeof document !== 'undefined' ? document.createElement('canvas') : null);
    if (!this.canvas) throw new SamplerError('No canvas available');
    const gl = this.canvas.getContext('webgl2', {
      antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: false, powerPreference: 'high-performance',
    });
    if (!gl) throw new SamplerError('WebGL2 is not available in this browser');
    this.gl = gl;
    this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.maxRenderbuffer = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
    this.vao = gl.createVertexArray();
    this.program = null;
    this.programKey = null;
    this.uniformCache = new Map();
    this._target = null;
  }

  get limits() {
    return { maxTexture: Math.min(this.maxTexture, this.maxRenderbuffer) };
  }

  _compileStage(type, source, sections) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new SamplerError(`Shader did not compile.\n${sections ? annotate(log, sections) : log}`);
    }
    return sh;
  }

  /** Compile (and cache) the program for a bundle. */
  compile(bundle) {
    const built = buildFragmentSource(bundle);
    if (this.programKey === built.source) return this.program;

    const gl = this.gl;
    const vs = this._compileStage(gl.VERTEX_SHADER, VERTEX_SOURCE, null);
    const fs = this._compileStage(gl.FRAGMENT_SHADER, built.source, built.sections);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new SamplerError(`Shader did not link.\n${log}`);
    }
    if (this.program) gl.deleteProgram(this.program);
    this.program = prog;
    this.programKey = built.source;
    this.uniformCache.clear();
    this.lastSource = built;
    return prog;
  }

  _loc(name) {
    if (!this.uniformCache.has(name)) {
      this.uniformCache.set(name, this.gl.getUniformLocation(this.program, name));
    }
    return this.uniformCache.get(name);
  }

  _setBundleUniform(u) {
    const gl = this.gl;
    const loc = this._loc(u.name);
    if (loc === null) return; // optimised out
    const v = Array.isArray(u.value) ? u.value : [u.value];
    if (u.count) {
      const f = Float32Array.from(v);
      switch (u.type) {
        case 'bool': case 'int': gl.uniform1iv(loc, Int32Array.from(v)); return;
        case 'float': gl.uniform1fv(loc, f); return;
        case 'vec2': gl.uniform2fv(loc, f); return;
        case 'vec3': gl.uniform3fv(loc, f); return;
        case 'vec4': gl.uniform4fv(loc, f); return;
        case 'ivec2': gl.uniform2iv(loc, Int32Array.from(v)); return;
        case 'ivec3': gl.uniform3iv(loc, Int32Array.from(v)); return;
        case 'ivec4': gl.uniform4iv(loc, Int32Array.from(v)); return;
        case 'mat2': gl.uniformMatrix2fv(loc, false, f); return;
        case 'mat3': gl.uniformMatrix3fv(loc, false, f); return;
        case 'mat4': gl.uniformMatrix4fv(loc, false, f); return;
        default: return;
      }
    }
    switch (u.type) {
      case 'bool': gl.uniform1i(loc, v[0] ? 1 : 0); break;
      case 'int': gl.uniform1i(loc, v[0] | 0); break;
      case 'float': gl.uniform1f(loc, v[0]); break;
      case 'vec2': gl.uniform2f(loc, v[0], v[1]); break;
      case 'vec3': gl.uniform3f(loc, v[0], v[1], v[2]); break;
      case 'vec4': gl.uniform4f(loc, v[0], v[1], v[2], v[3]); break;
      case 'ivec2': gl.uniform2i(loc, v[0] | 0, v[1] | 0); break;
      case 'ivec3': gl.uniform3i(loc, v[0] | 0, v[1] | 0, v[2] | 0); break;
      case 'ivec4': gl.uniform4i(loc, v[0] | 0, v[1] | 0, v[2] | 0, v[3] | 0); break;
      case 'bvec2': gl.uniform2i(loc, v[0] ? 1 : 0, v[1] ? 1 : 0); break;
      case 'bvec3': gl.uniform3i(loc, v[0] ? 1 : 0, v[1] ? 1 : 0, v[2] ? 1 : 0); break;
      case 'bvec4': gl.uniform4i(loc, v[0] ? 1 : 0, v[1] ? 1 : 0, v[2] ? 1 : 0, v[3] ? 1 : 0); break;
      case 'mat2': gl.uniformMatrix2fv(loc, false, v); break;
      case 'mat3': gl.uniformMatrix3fv(loc, false, v); break;
      case 'mat4': gl.uniformMatrix4fv(loc, false, v); break;
      default: break;
    }
  }

  _ensureTarget(w, h) {
    const gl = this.gl;
    if (this._target && this._target.w === w && this._target.h === h) return this._target;
    if (this._target) {
      gl.deleteFramebuffer(this._target.fbo);
      gl.deleteRenderbuffer(this._target.rbo);
    }
    const rbo = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rbo);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, w, h);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rbo);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new SamplerError(`Could not create a ${w}x${h} render target (status 0x${status.toString(16)}). Try a lower resolution.`);
    }
    this._target = { fbo, rbo, w, h, pixels: new Uint8Array(w * h * 4) };
    return this._target;
  }

  /**
   * @param {object} bundle validated bundle
   * @param {object} opts   res (int or [x,y,z]), isoOffset, maxPixels, signal
   * @param {function} onSlab async (pixels, layout, slab) => void
   * @returns {Promise<object>} the layout used
   */
  async sample(bundle, opts, onSlab) {
    const gl = this.gl;
    const r = opts.res;
    const res = Array.isArray(r) ? r.slice() : [r, r, r];
    const layout = computeAtlasLayout(res, {
      maxTexture: this.limits.maxTexture,
      maxPixels: opts.maxPixels || 16 * 1024 * 1024,
    });

    this.compile(bundle);
    const target = this._ensureTarget(layout.atlasW, layout.atlasH);

    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, layout.atlasW, layout.atlasH);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    const span = [
      bundle.bounds.max[0] - bundle.bounds.min[0],
      bundle.bounds.max[1] - bundle.bounds.min[1],
      bundle.bounds.max[2] - bundle.bounds.min[2],
    ];
    const cell = Math.max(span[0] / res[0], span[1] / res[1], span[2] / res[2]);

    gl.uniform3i(this._loc('fcRes'), res[0], res[1], res[2]);
    gl.uniform3f(this._loc('fcBoxMin'), ...bundle.bounds.min);
    gl.uniform3f(this._loc('fcBoxMax'), ...bundle.bounds.max);
    gl.uniform1i(this._loc('fcTilesX'), layout.tilesX);
    gl.uniform1f(this._loc('fcIso'), opts.isoOffset === undefined ? bundle.isoOffset : opts.isoOffset);
    gl.uniform1f(this._loc('fcNormEps'), cell * 0.5);
    for (const u of bundle.uniforms) this._setBundleUniform(u);

    for (let i = 0; i < layout.slabs.length; i++) {
      if (opts.signal && opts.signal.aborted) throw new SamplerError('Cancelled');
      const slab = layout.slabs[i];
      gl.uniform1i(this._loc('fcSliceBase'), slab.zStart);
      gl.uniform1i(this._loc('fcSliceCount'), slab.zCount);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, layout.atlasW, layout.atlasH, gl.RGBA, gl.UNSIGNED_BYTE, target.pixels);
      await onSlab(target.pixels, layout, slab, i);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    return layout;
  }

  dispose() {
    const gl = this.gl;
    if (this._target) {
      gl.deleteFramebuffer(this._target.fbo);
      gl.deleteRenderbuffer(this._target.rbo);
      this._target = null;
    }
    if (this.program) { gl.deleteProgram(this.program); this.program = null; }
    gl.deleteVertexArray(this.vao);
  }
}
