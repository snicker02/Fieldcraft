// engine/bundle.js
// The field bundle: the contract between a host raymarcher and Fieldcraft.
//
// A host exports one JSON object. Fieldcraft loads it and splices the GLSL
// straight into its own sampling shader. Nothing block-related ever crosses
// back into the host — the host only has to describe its own distance
// estimator in the terms it already uses.
//
// See BUNDLE-FORMAT.md for the written spec.

export const BUNDLE_FORMAT = 'fieldcraft.field-bundle';
export const BUNDLE_VERSION = 1;

export const GLSL_TYPES = {
  bool: { arity: 1, kind: 'bool' },
  int: { arity: 1, kind: 'int' },
  float: { arity: 1, kind: 'float' },
  vec2: { arity: 2, kind: 'float' },
  vec3: { arity: 3, kind: 'float' },
  vec4: { arity: 4, kind: 'float' },
  ivec2: { arity: 2, kind: 'int' },
  ivec3: { arity: 3, kind: 'int' },
  ivec4: { arity: 4, kind: 'int' },
  bvec2: { arity: 2, kind: 'bool' },
  bvec3: { arity: 3, kind: 'bool' },
  bvec4: { arity: 4, kind: 'bool' },
  mat2: { arity: 4, kind: 'float' },
  mat3: { arity: 9, kind: 'float' },
  mat4: { arity: 16, kind: 'float' },
};

/** Default initialiser for a local standing in for a de() out/inout parameter. */
export const TYPE_DEFAULTS = {
  bool: 'false', int: '0', float: '0.0',
  vec2: 'vec2(0.0)', vec3: 'vec3(0.0)', vec4: 'vec4(0.0)',
  ivec2: 'ivec2(0)', ivec3: 'ivec3(0)', ivec4: 'ivec4(0)',
  bvec2: 'bvec2(false)', bvec3: 'bvec3(false)', bvec4: 'bvec4(false)',
  mat2: 'mat2(1.0)', mat3: 'mat3(1.0)', mat4: 'mat4(1.0)',
};

export class BundleError extends Error {
  constructor(message, path) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'BundleError';
    this.path = path;
  }
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse a function signature exactly as the host declares it, e.g.
 *   "float de(vec3 p)"
 *   "float de(vec3 p, inout float s, inout vec4 trap)"
 * @returns {{returnType, name, params:[{qualifier,type,name}]}}
 */
export function parseSignature(sig, path = 'signature') {
  const s = String(sig).replace(/\s+/g, ' ').trim().replace(/;$/, '');
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)$/.exec(s);
  if (!m) throw new BundleError(`Cannot parse "${sig}" as a GLSL function signature`, path);
  const [, returnType, name, argstr] = m;
  if (!GLSL_TYPES[returnType]) throw new BundleError(`Unsupported return type "${returnType}"`, path);

  const params = [];
  const trimmed = argstr.trim();
  if (trimmed && trimmed !== 'void') {
    for (const raw of trimmed.split(',')) {
      const parts = raw.trim().split(' ').filter(Boolean);
      let qualifier = 'in';
      if (parts.length && ['in', 'out', 'inout', 'const'].includes(parts[0])) qualifier = parts.shift();
      if (parts.length !== 2) throw new BundleError(`Cannot parse parameter "${raw.trim()}"`, path);
      const [type, pname] = parts;
      if (!GLSL_TYPES[type]) throw new BundleError(`Unsupported parameter type "${type}"`, path);
      if (!IDENT.test(pname)) throw new BundleError(`Invalid parameter name "${pname}"`, path);
      params.push({ qualifier, type, name: pname });
    }
  }
  return { returnType, name, params, normalized: s };
}

const GLSL_FORBIDDEN = [
  [/^\s*#version/m, 'a #version directive (Fieldcraft supplies its own header)'],
  [/\bprecision\s+(lowp|mediump|highp)\s+\w+\s*;/, 'a precision statement (Fieldcraft supplies its own)'],
  [/\bvoid\s+main\s*\(/, 'a main() function'],
  [/\b(out|in)\s+vec4\s+\w+\s*;/, 'a stage in/out declaration'],
];

function lintGLSL(src, path) {
  if (typeof src !== 'string' || !src.trim()) throw new BundleError('GLSL source is empty', path);
  let depth = 0, paren = 0;
  for (const ch of src) {
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth < 0) throw new BundleError('Unbalanced braces', path); }
    else if (ch === '(') paren++;
    else if (ch === ')') { paren--; if (paren < 0) throw new BundleError('Unbalanced parentheses', path); }
  }
  if (depth !== 0) throw new BundleError('Unbalanced braces', path);
  if (paren !== 0) throw new BundleError('Unbalanced parentheses', path);
  for (const [re, what] of GLSL_FORBIDDEN) {
    if (re.test(src)) throw new BundleError(`GLSL source contains ${what}`, path);
  }
}

function checkDeclares(src, name, path) {
  const re = new RegExp(`\\b${name}\\s*\\(`);
  if (!re.test(src)) throw new BundleError(`GLSL source never defines "${name}"`, path);
}

function checkVec3(v, path) {
  if (!Array.isArray(v) || v.length !== 3 || v.some(n => typeof n !== 'number' || !Number.isFinite(n))) {
    throw new BundleError('Expected three finite numbers', path);
  }
}

/**
 * Validate and normalise a parsed bundle object. Throws BundleError on the
 * first problem; returns a normalised copy with defaults filled in.
 */
export function validateBundle(raw) {
  if (!raw || typeof raw !== 'object') throw new BundleError('Bundle is not an object');
  if (raw.format !== BUNDLE_FORMAT) {
    throw new BundleError(`Expected format "${BUNDLE_FORMAT}", found "${raw.format}"`, 'format');
  }
  if (raw.version !== BUNDLE_VERSION) {
    throw new BundleError(`Unsupported bundle version ${raw.version}; this build reads version ${BUNDLE_VERSION}`, 'version');
  }

  const glsl = raw.glsl;
  if (!glsl || typeof glsl !== 'object') throw new BundleError('Missing glsl block', 'glsl');
  if (glsl.version && glsl.version !== '300 es') {
    throw new BundleError(`Fieldcraft samples with #version 300 es; bundle declares "${glsl.version}"`, 'glsl.version');
  }

  if (glsl.prelude !== undefined && glsl.prelude !== '') lintGLSL(glsl.prelude, 'glsl.prelude');

  if (!glsl.de || typeof glsl.de !== 'object') throw new BundleError('Missing de block', 'glsl.de');
  const deSig = parseSignature(glsl.de.signature, 'glsl.de.signature');
  if (glsl.de.name && glsl.de.name !== deSig.name) {
    throw new BundleError(`name "${glsl.de.name}" disagrees with the signature "${deSig.name}"`, 'glsl.de.name');
  }
  if (deSig.returnType !== 'float') throw new BundleError('The distance estimator must return float', 'glsl.de.signature');
  if (!deSig.params.length || deSig.params[0].type !== 'vec3') {
    throw new BundleError('The first parameter of the distance estimator must be vec3 (the sample point)', 'glsl.de.signature');
  }
  lintGLSL(glsl.de.source, 'glsl.de.source');
  checkDeclares(glsl.de.source, deSig.name, 'glsl.de.source');

  const paramDefaults = glsl.de.paramDefaults || {};
  for (const p of deSig.params.slice(1)) {
    if (p.qualifier === 'in' || p.qualifier === 'const') continue;
    const d = paramDefaults[p.name];
    if (d !== undefined && typeof d !== 'string') {
      throw new BundleError(`paramDefaults.${p.name} must be a GLSL expression string`, 'glsl.de.paramDefaults');
    }
  }
  if (glsl.de.scaleParam) {
    const sp = deSig.params.find(p => p.name === glsl.de.scaleParam);
    if (!sp) throw new BundleError(`scaleParam "${glsl.de.scaleParam}" is not a parameter of ${deSig.name}`, 'glsl.de.scaleParam');
    if (sp.type !== 'float') throw new BundleError('scaleParam must be a float parameter', 'glsl.de.scaleParam');
  }

  let matSig = null;
  if (glsl.material) {
    matSig = parseSignature(glsl.material.signature, 'glsl.material.signature');
    if (matSig.returnType !== 'int') throw new BundleError('The material expression must return int', 'glsl.material.signature');
    const types = matSig.params.map(p => p.type).join(',');
    if (types !== 'vec3,vec3' && types !== 'vec3') {
      throw new BundleError('The material expression takes (vec3 p, vec3 n) or (vec3 p)', 'glsl.material.signature');
    }
    lintGLSL(glsl.material.source, 'glsl.material.source');
    checkDeclares(glsl.material.source, matSig.name, 'glsl.material.source');
  }

  const uniforms = raw.uniforms || [];
  if (!Array.isArray(uniforms)) throw new BundleError('uniforms must be an array', 'uniforms');
  const seen = new Set();
  uniforms.forEach((u, i) => {
    const path = `uniforms[${i}]`;
    if (!u || typeof u !== 'object') throw new BundleError('Not an object', path);
    if (!IDENT.test(u.name || '')) throw new BundleError(`Invalid uniform name "${u.name}"`, path);
    if (seen.has(u.name)) throw new BundleError(`Duplicate uniform "${u.name}"`, path);
    seen.add(u.name);
    if (u.name.startsWith('fc') || u.name.startsWith('uFc')) {
      throw new BundleError(`Uniform "${u.name}" uses the reserved fc/uFc prefix`, path);
    }
    const ty = GLSL_TYPES[u.type];
    if (!ty) throw new BundleError(`Unsupported uniform type "${u.type}"`, path);
    const v = u.value;
    const arr = Array.isArray(v) ? v : [v];
    if (arr.length !== ty.arity) {
      throw new BundleError(`${u.type} needs ${ty.arity} component(s), found ${arr.length}`, path);
    }
    for (const n of arr) {
      if (ty.kind === 'bool') { if (typeof n !== 'boolean' && n !== 0 && n !== 1) throw new BundleError('Expected a boolean', path); }
      else if (typeof n !== 'number' || !Number.isFinite(n)) throw new BundleError('Expected finite numbers', path);
    }
  });

  const bounds = raw.bounds;
  if (!bounds || typeof bounds !== 'object') throw new BundleError('Missing bounds', 'bounds');
  checkVec3(bounds.min, 'bounds.min');
  checkVec3(bounds.max, 'bounds.max');
  for (let i = 0; i < 3; i++) {
    if (!(bounds.max[i] > bounds.min[i])) {
      throw new BundleError(`max[${i}] must be greater than min[${i}]`, 'bounds');
    }
  }

  const iso = raw.isoOffset === undefined ? 0 : raw.isoOffset;
  if (typeof iso !== 'number' || !Number.isFinite(iso)) throw new BundleError('Must be a finite number', 'isoOffset');

  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    name: raw.name || 'Untitled field',
    source: raw.source || null,
    glsl: {
      version: '300 es',
      prelude: glsl.prelude || '',
      de: {
        name: deSig.name,
        signature: deSig.normalized,
        source: glsl.de.source,
        paramDefaults: { ...paramDefaults },
        scaleParam: glsl.de.scaleParam || null,
      },
      material: glsl.material ? {
        name: matSig.name,
        signature: matSig.normalized,
        source: glsl.material.source,
        wantsNormal: matSig.params.length === 2,
      } : null,
    },
    uniforms: uniforms.map(u => ({
      name: u.name,
      type: u.type,
      value: Array.isArray(u.value) ? u.value.slice() : u.value,
      label: u.label || u.name,
      min: u.min, max: u.max, step: u.step,
    })),
    bounds: { min: bounds.min.slice(), max: bounds.max.slice() },
    isoOffset: iso,
    hints: raw.hints || {},
    _sig: deSig,
  };
}

export function parseBundle(text) {
  let raw;
  try { raw = JSON.parse(text); }
  catch (e) { throw new BundleError(`Not valid JSON — ${e.message}`); }
  return validateBundle(raw);
}

/** GLSL uniform declarations for the bundle's uniform block. */
export function uniformDeclarations(bundle) {
  return bundle.uniforms.map(u => `uniform ${u.type} ${u.name};`).join('\n');
}

/**
 * The wrapper that calls the host's estimator with whatever signature it
 * declares. Out/inout parameters get locals; a declared scale parameter is
 * divided out afterwards, matching the DE contract where the estimator
 * returns prim(p)/s.
 */
export function deWrapper(bundle, fnName = 'fcField') {
  const de = bundle.glsl.de;
  const sig = bundle._sig || parseSignature(de.signature);
  const lines = [];
  const args = ['p'];

  for (const p of sig.params.slice(1)) {
    const init = de.paramDefaults[p.name] || TYPE_DEFAULTS[p.type];
    lines.push(`  ${p.type} ${p.name} = ${init};`);
    args.push(p.name);
  }
  lines.push(`  float d = ${sig.name}(${args.join(', ')});`);
  if (de.scaleParam) lines.push(`  d /= max(${de.scaleParam}, 1e-9);`);
  lines.push(`  return d;`);

  return `float ${fnName}(vec3 p) {\n${lines.join('\n')}\n}`;
}

/** The material call, defaulted to id 0 when the bundle does not supply one. */
export function materialWrapper(bundle, fnName = 'fcMaterial') {
  const m = bundle.glsl.material;
  if (!m) return `int ${fnName}(vec3 p, vec3 n) { return 0; }`;
  const call = m.wantsNormal ? `${m.name}(p, n)` : `${m.name}(p)`;
  return `int ${fnName}(vec3 p, vec3 n) { return ${call}; }`;
}

/** Serialise a bundle back out (hosts can round-trip what Fieldcraft loaded). */
export function serializeBundle(bundle) {
  const out = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    name: bundle.name,
    source: bundle.source || undefined,
    glsl: {
      version: '300 es',
      prelude: bundle.glsl.prelude || undefined,
      de: {
        name: bundle.glsl.de.name,
        signature: bundle.glsl.de.signature,
        source: bundle.glsl.de.source,
        paramDefaults: Object.keys(bundle.glsl.de.paramDefaults).length ? bundle.glsl.de.paramDefaults : undefined,
        scaleParam: bundle.glsl.de.scaleParam || undefined,
      },
      material: bundle.glsl.material ? {
        name: bundle.glsl.material.name,
        signature: bundle.glsl.material.signature,
        source: bundle.glsl.material.source,
      } : undefined,
    },
    uniforms: bundle.uniforms.map(u => ({
      name: u.name, type: u.type, value: u.value,
      label: u.label !== u.name ? u.label : undefined,
      min: u.min, max: u.max, step: u.step,
    })),
    bounds: bundle.bounds,
    isoOffset: bundle.isoOffset,
    hints: Object.keys(bundle.hints || {}).length ? bundle.hints : undefined,
  };
  return JSON.stringify(out, (k, v) => (v === undefined ? undefined : v), 2);
}
