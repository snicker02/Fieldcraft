// engine/testfields.js
// Hardcoded fields so the whole pipeline is provable before any host program
// is touched. The Menger bundle deliberately uses the Catoptron-style
// estimator signature — inout scale accumulator plus an orbit trap, with the
// division by the accumulated scale left to the caller — so the splice path
// for a real host is exercised, not just the trivial one.

import { validateBundle } from './bundle.js';

export const SPHERE_BUNDLE = {
  format: 'fieldcraft.field-bundle',
  version: 1,
  name: 'Test sphere',
  source: { app: 'Fieldcraft built-in', build: 'test' },
  glsl: {
    version: '300 es',
    de: {
      name: 'de',
      signature: 'float de(vec3 p)',
      source: `float de(vec3 p) {
  return length(p) - uRadius;
}`,
    },
    material: {
      name: 'material',
      signature: 'int material(vec3 p, vec3 n)',
      source: `int material(vec3 p, vec3 n) {
  if (n.y > 0.6) return 0;
  if (n.y < -0.6) return 3;
  return p.x > 0.0 ? 10 : 4;
}`,
    },
  },
  uniforms: [
    { name: 'uRadius', type: 'float', value: 0.9, label: 'Radius', min: 0.1, max: 1.0, step: 0.01 },
  ],
  bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
  isoOffset: 0,
  hints: { suggestedRes: 128, materialIds: [0, 3, 4, 10] },
};

export const MENGER_BUNDLE = {
  format: 'fieldcraft.field-bundle',
  version: 1,
  name: 'Test Menger sponge',
  source: { app: 'Fieldcraft built-in', build: 'test' },
  glsl: {
    version: '300 es',
    prelude: `float fcBoxDist(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}`,
    de: {
      name: 'de',
      signature: 'float de(vec3 p, inout float s, inout vec4 trap)',
      paramDefaults: { s: '1.0', trap: 'vec4(1e10)' },
      scaleParam: 's',
      source: `vec3 mengerFold(vec3 p, inout float s, inout vec4 trap) {
  p = abs(p);
  if (p.x < p.y) p.xy = p.yx;
  if (p.x < p.z) p.xz = p.zx;
  if (p.y < p.z) p.yz = p.zy;
  p = p * 3.0 - vec3(2.0);
  if (p.z < -1.0) p.z += 2.0;
  s *= 3.0;
  trap = min(trap, vec4(abs(p), dot(p, p)));
  return p;
}

float de(vec3 p, inout float s, inout vec4 trap) {
  for (int i = 0; i < uIterations; i++) {
    p = mengerFold(p, s, trap);
  }
  return fcBoxDist(p, vec3(1.0));
}`,
    },
    material: {
      name: 'material',
      signature: 'int material(vec3 p, vec3 n)',
      source: `int material(vec3 p, vec3 n) {
  vec3 a = abs(n);
  if (a.y >= a.x && a.y >= a.z) return n.y > 0.0 ? 0 : 2;
  if (a.x >= a.z) return 9;
  return 11;
}`,
    },
  },
  uniforms: [
    { name: 'uIterations', type: 'int', value: 3, label: 'Iterations', min: 1, max: 6, step: 1 },
  ],
  bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
  isoOffset: 0,
  hints: { suggestedRes: 243, materialIds: [0, 2, 9, 11] },
};

export const TEST_BUNDLES = [SPHERE_BUNDLE, MENGER_BUNDLE];

export function loadTestBundle(which) {
  const raw = which === 'menger' ? MENGER_BUNDLE : SPHERE_BUNDLE;
  return validateBundle(JSON.parse(JSON.stringify(raw)));
}

// --- CPU mirrors, used by the validation harness as exact oracles ----------

/** Solid sphere membership for a point in bundle space. */
export function sphereContains(x, y, z, radius = 0.9) {
  return Math.sqrt(x * x + y * y + z * z) <= radius;
}

/**
 * Exact Menger sponge membership on [-1,1]^3 at the given level. A point is
 * outside as soon as two of its three base-3 digits are the middle digit.
 * On a 3^level grid of cell centres this yields exactly 20^level solid cells,
 * which is what makes it a hard oracle rather than an approximate one.
 */
export function mengerContains(x, y, z, level = 3) {
  let u = (x + 1) / 2, v = (y + 1) / 2, w = (z + 1) / 2;
  if (u < 0 || u >= 1 || v < 0 || v >= 1 || w < 0 || w >= 1) return false;
  for (let i = 0; i < level; i++) {
    const du = Math.floor(u * 3), dv = Math.floor(v * 3), dw = Math.floor(w * 3);
    const mids = (du === 1 ? 1 : 0) + (dv === 1 ? 1 : 0) + (dw === 1 ? 1 : 0);
    if (mids >= 2) return false;
    u = u * 3 - du; v = v * 3 - dv; w = w * 3 - dw;
  }
  return true;
}
