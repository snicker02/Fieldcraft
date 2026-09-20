// tools/validate.mjs
// Headless gates. Run: node tools/validate.mjs
//
// Gate 1  bundle contract   parsing, validation, refusals, signature splicing
// Gate 2  shader assembly   structure, and real compilation via glslangValidator
//                           when it is on PATH (skipped with a notice if not)
// Gate 3  tiling            atlas layout and slab scatter against an
//                           independently written index formula
// Gate 4  voxelisation      sphere volume within tolerance, Menger sponge
//                           against its exact combinatorial cell count
// Gate 5  blockcore         grid keys, budget, mesher area and signed volume,
//                           .mcstructure round-trip, splitting, zip, .mcpack

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  validateBundle, parseSignature, deWrapper, materialWrapper,
  uniformDeclarations, serializeBundle, parseBundle, BundleError,
} from '../engine/bundle.js';
import { SPHERE_BUNDLE, MENGER_BUNDLE, loadTestBundle, mengerContains, sphereContains } from '../engine/testfields.js';
import { buildFragmentSource, VERTEX_SOURCE } from '../engine/sampler.js';
import {
  makeFieldBundle, fieldFromShaderSource, bundleFromProgram,
} from '../host/fieldcraft-export.js';
import { computeAtlasLayout, voxelizeSlab, encodeSliceCPU, MODE } from '../engine/voxelize.js';
import {
  VoxelGrid, packKey, unpackKey, packValue, valueMaterial, valueShade,
  AXIS_MIN, AXIS_MAX, BlockPalette, meshGrid, countExposedFaces,
  buildMcStructure, splitGrid, placementGuide, buildMcPack, buildMcPackAsync,
  ZipWriter, crc32, writeNBT, readNBT, MATERIALS, deflateAvailable,
} from '../engine/blockcore/index.js';

// --- harness ---------------------------------------------------------------

let passed = 0, failed = 0, skipped = 0;
const failures = [];
let group = '';

function gate(name, fn) {
  group = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
  fn();
}
function ok(label) { passed++; console.log(`  \x1b[32mpass\x1b[0m  ${label}`); }
function bad(label, detail) {
  failed++;
  failures.push(`${group} / ${label}: ${detail}`);
  console.log(`  \x1b[31mFAIL\x1b[0m  ${label}\n        ${detail}`);
}
function skip(label, why) { skipped++; console.log(`  \x1b[33mskip\x1b[0m  ${label} — ${why}`); }

function check(label, fn) {
  try {
    const r = fn();
    if (r === false) bad(label, 'returned false');
    else ok(label);
  } catch (e) {
    bad(label, e.message);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(a, b, msg) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg || 'not equal'}: ${sa} !== ${sb}`);
}
function assertNear(a, b, tol, msg) {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg || 'not near'}: ${a} vs ${b} (tolerance ${tol})`);
}
function assertThrows(fn, match, msg) {
  let threw = null;
  try { fn(); } catch (e) { threw = e; }
  if (!threw) throw new Error(`${msg || 'expected a throw'} but nothing was thrown`);
  if (match && !match.test(threw.message)) throw new Error(`${msg || 'wrong error'}: ${threw.message}`);
  return threw;
}

// --- gate 1: bundle contract ----------------------------------------------

gate('Gate 1 — field bundle contract', () => {
  check('both built-in bundles validate', () => {
    const s = validateBundle(structuredClone(SPHERE_BUNDLE));
    const m = validateBundle(structuredClone(MENGER_BUNDLE));
    assertEq(s.glsl.de.name, 'de');
    assertEq(m.glsl.de.scaleParam, 's');
    assert(m.glsl.material.wantsNormal, 'menger material takes a normal');
  });

  check('signature parsing keeps qualifiers verbatim', () => {
    const sig = parseSignature('float de(vec3 p, inout float s, inout vec4 trap)');
    assertEq(sig.name, 'de');
    assertEq(sig.params.map(p => `${p.qualifier} ${p.type} ${p.name}`),
      ['in vec3 p', 'inout float s', 'inout vec4 trap']);
    assertEq(parseSignature('float de(vec3 p)').params.length, 1);
    assertEq(parseSignature('int material( vec3 p , vec3 n )').returnType, 'int');
  });

  check('wrapper declares locals and divides by the declared scale', () => {
    const m = loadTestBundle('menger');
    const w = deWrapper(m);
    assert(/float s = 1\.0;/.test(w), 'scale local missing');
    assert(/vec4 trap = vec4\(1e10\);/.test(w), 'trap local missing');
    assert(/de\(p, s, trap\)/.test(w), 'call does not match the declared signature');
    assert(/d \/= max\(s, 1e-9\)/.test(w), 'scale division missing');

    const s = loadTestBundle('sphere');
    const ws = deWrapper(s);
    assert(/de\(p\);/.test(ws), 'plain call missing');
    assert(!/\/=/.test(ws), 'sphere must not be divided by anything');
  });

  check('material wrapper falls back to id 0 when absent', () => {
    const b = loadTestBundle('sphere');
    b.glsl.material = null;
    assert(/return 0;/.test(materialWrapper(b)), 'fallback missing');
  });

  const reject = (label, mutate, match) => check(`rejects ${label}`, () => {
    const raw = structuredClone(MENGER_BUNDLE);
    mutate(raw);
    const e = assertThrows(() => validateBundle(raw), match, `should reject ${label}`);
    assert(e instanceof BundleError, 'expected a BundleError');
  });

  reject('a foreign format tag', b => { b.format = 'something.else'; }, /format/);
  reject('a future bundle version', b => { b.version = 99; }, /version/);
  reject('an estimator that does not return float', b => { b.glsl.de.signature = 'int de(vec3 p)'; }, /must return float/);
  reject('an estimator whose first argument is not vec3', b => { b.glsl.de.signature = 'float de(float t, vec3 p)'; }, /first parameter/);
  reject('a signature that disagrees with the declared name', b => { b.glsl.de.name = 'distance'; }, /disagrees/);
  reject('unbalanced braces in spliced source', b => { b.glsl.de.source += '\n{'; }, /Unbalanced braces/);
  reject('a #version directive in spliced source', b => { b.glsl.de.source = '#version 300 es\n' + b.glsl.de.source; }, /#version/);
  reject('a main() in spliced source', b => { b.glsl.de.source += '\nvoid main() {}'; }, /main\(\)/);
  reject('source that never defines the named function', b => { b.glsl.de.source = 'float other(vec3 p) { return 1.0; }'; }, /never defines/);
  reject('a duplicate uniform', b => { b.uniforms.push({ ...b.uniforms[0] }); }, /Duplicate/);
  reject('a uniform with the wrong component count', b => { b.uniforms.push({ name: 'uK', type: 'vec3', value: [1, 2] }); }, /3 component/);
  reject('a uniform using the reserved prefix', b => { b.uniforms.push({ name: 'fcThing', type: 'float', value: 1 }); }, /reserved/);
  reject('an unknown uniform type', b => { b.uniforms.push({ name: 'uK', type: 'sampler2D', value: 0 }); }, /Unsupported uniform type/);
  reject('an inverted bounding box', b => { b.bounds.max[1] = b.bounds.min[1]; }, /greater than/);
  reject('a non-finite iso offset', b => { b.isoOffset = Infinity; }, /finite/);
  reject('a scaleParam that is not a parameter', b => { b.glsl.de.scaleParam = 'nope'; }, /not a parameter/);
  reject('a material expression returning the wrong type', b => { b.glsl.material.signature = 'float material(vec3 p, vec3 n)'; }, /must return int/);

  check('serialize round-trips through the validator', () => {
    const a = loadTestBundle('menger');
    const b = parseBundle(serializeBundle(a));
    assertEq(b.glsl.de.signature, a.glsl.de.signature);
    assertEq(b.glsl.de.scaleParam, a.glsl.de.scaleParam);
    assertEq(b.uniforms, a.uniforms);
    assertEq(b.bounds, a.bounds);
  });

  check('host export hook produces a bundle this app accepts', () => {
    // Exactly the shape a Catoptron 3D export hook would emit.
    const raw = makeFieldBundle({
      name: 'Octahedral fold stack',
      source: { app: 'Catoptron 3D', build: '0.2.0-mirrors' },
      prelude: 'float prim(vec3 p) { vec3 q = abs(p) - vec3(1.0); return length(max(q, 0.0)); }',
      deSignature: 'float de(vec3 p, inout float s, inout vec4 trap)',
      deSource: `float de(vec3 p, inout float s, inout vec4 trap) {
  for (int i = 0; i < 8; i++) {
    p = abs(p);
    p = p * uScale - vec3(uScale - 1.0);
    s *= uScale;
    trap = min(trap, vec4(abs(p), dot(p, p)));
  }
  return prim(p);
}`,
      scaleParam: 's',
      paramDefaults: { s: '1.0', trap: 'vec4(1e10)' },
      materialSource: 'int material(vec3 p, vec3 n) { return int(mod(floor(p.y * 4.0), 6.0)); }',
      uniforms: [{ name: 'uScale', type: 'float', value: 1.9, min: 1.0, max: 3.0 }],
      bounds: { min: [-2, -2, -2], max: [2, 2, 2] },
      isoOffset: 0,
    });
    const b = validateBundle(structuredClone(raw));
    assertEq(b.glsl.de.scaleParam, 's', 'scale parameter survived the hook');
    assertEq(b.glsl.de.name, 'de', 'function name read out of the signature');
    assert(b.glsl.material.wantsNormal, 'material normal argument');
    const src = buildFragmentSource(b).source;
    assert(/uniform float uScale;/.test(src), 'host uniform declared');
    assert(/d \/= max\(s, 1e-9\)/.test(src), 'scale division spliced in');
  });
});

// --- gate 1b: slicing a host's assembled shader ---------------------------

// A cut-down stand-in for a real assembled fragment shader, carrying every
// declaration shape that turned up in Catoptron 3D: trailing comments, comma
// lists, precision-qualified samplers, and uniform arrays.
const MOCK_ASSEMBLED = `#version 300 es
precision highp float;
out vec4 fragColor;

#define PI 3.14159265359

uniform vec2  uRes;
uniform float uStepScale;   // safety multiplier - lower it when a bound op misbehaves
uniform vec3  uPal0, uPal1, uPal2;
uniform mat3  uFlameMi[24];
uniform vec3  uFlameBLo[24];   // per-map image box
uniform sampler2D uImg;
uniform highp sampler3D uSdf;   // GLSL ES has no default precision for sampler3D
uniform float uPrimSize;

float prim(vec3 p){ return length(p) - uPrimSize; }

float mapT(vec3 p, out vec4 trap, out float safe){
  float s = 1.0;
  trap = vec4(dot(p, p));
  float d = prim(p) / s;
  safe = d;
  return d;
}

float map(vec3 p){ vec4 t; float sf; return mapT(p, t, sf); }

void main(){ fragColor = vec4(map(vec3(0.0))); }
`;

gate("Gate 1b — slicing a host's assembled shader", () => {
  check('every uniform declaration is carried, whatever its shape', () => {
    const r = fieldFromShaderSource(MOCK_ASSEMBLED, {});
    const names = r.uniforms.map(u => u.name);
    assertEq(names, ['uRes', 'uStepScale', 'uPal0', 'uPal1', 'uPal2',
      'uFlameMi', 'uFlameBLo', 'uPrimSize'], 'uniform names');
    const arr = r.uniforms.find(u => u.name === 'uFlameMi');
    assertEq(arr.count, 24, 'array count');
    assertEq(arr.value.length, 9 * 24, 'array value length');
    assertEq(r.droppedSamplers, ['sampler2D uImg', 'sampler3D uSdf'], 'samplers dropped');
  });

  check('a uniform with a trailing comment is not silently lost', () => {
    // This is the real bug this gate exists for. A declaration the parser did
    // not recognise stays in the source, compiles perfectly, and reads as zero
    // forever: the picture comes out wrong rather than missing, which is the
    // hardest kind of failure to trace back to its cause.
    const r = fieldFromShaderSource(MOCK_ASSEMBLED, {});
    assert(r.uniforms.some(u => u.name === 'uStepScale'),
      'the commented declaration was dropped');
    assert(!/\buniform\b/.test(r.source), 'a uniform declaration survived into the prelude');
  });

  check('an unparseable uniform declaration is refused, not ignored', () => {
    const broken = MOCK_ASSEMBLED.replace('uniform float uPrimSize;', 'uniform float 9bad;');
    assertThrows(() => fieldFromShaderSource(broken, {}),
      /not understood|Cannot parse uniform/, 'malformed name');

    // A declaration the parser cannot see at all — here an interposed block
    // comment. This is what the leftover guard is for: without it the uniform
    // would stay in the source, compile, and read as zero forever.
    const wrapped = MOCK_ASSEMBLED.replace('uniform float uPrimSize;',
      'uniform /* why not */ float uPrimSize;');
    assertThrows(() => fieldFromShaderSource(wrapped, {}), /not understood/, 'leftover guard');

    // Whereas a declaration merely split across lines is understood, not refused.
    const split = MOCK_ASSEMBLED.replace('uniform float uPrimSize;', 'uniform\n  float uPrimSize;');
    assert(fieldFromShaderSource(split, {}).uniforms.some(u => u.name === 'uPrimSize'),
      'a wrapped declaration should still be read');
  });

  check('stage declarations are stripped and values are filled in', () => {
    const r = fieldFromShaderSource(MOCK_ASSEMBLED, { values: { uPrimSize: 0.42, uPal0: [1, 2, 3] } });
    assert(!/#version/.test(r.source), '#version survived');
    assert(!/precision\s+highp/.test(r.source), 'precision statement survived');
    assert(!/out vec4 fragColor/.test(r.source), 'stage output survived');
    assert(!/void main/.test(r.source), 'main survived the cut');
    assertEq(r.uniforms.find(u => u.name === 'uPrimSize').value, 0.42, 'scalar value');
    assertEq(r.uniforms.find(u => u.name === 'uPal0').value, [1, 2, 3], 'vector value');
  });

  check('the sliced field becomes a bundle that validates and assembles', () => {
    const { bundle, droppedSamplers } = bundleFromProgram({
      name: 'Mock host field',
      shaderSource: MOCK_ASSEMBLED,
      values: { uPrimSize: 0.8 },
      deSignature: 'float mapT(vec3 p, out vec4 trap, out float safe)',
      trapParam: 'trap',
      materialSignature: 'int material(vec3 p, vec3 n, vec4 trap)',
      materialSource: 'int material(vec3 p, vec3 n, vec4 trap){ return 2 + int(mod(trap.w, 6.0)); }',
      bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
    });
    assertEq(droppedSamplers.length, 2, 'samplers reported');
    const b = validateBundle(structuredClone(bundle));
    const src = buildFragmentSource(b).source;
    assert(/uniform mat3 uFlameMi\[24\];/.test(src), 'array uniform re-emitted');
    assert(/fcTrapOut = trap;/.test(src), 'trap wired through');
    assert(/fcMaterial\(p, n, trap\)/.test(src), 'material receives the trap');
  });

  check('a material asking for a trap without one declared is refused', () => {
    const b = structuredClone(MENGER_BUNDLE);
    b.glsl.material.signature = 'int material(vec3 p, vec3 n, vec4 trap)';
    b.glsl.material.source = 'int material(vec3 p, vec3 n, vec4 trap){ return 0; }';
    assertThrows(() => validateBundle(b), /trapParam/, 'trap requirement');
  });

  check('array uniforms are validated on component count', () => {
    const b = structuredClone(MENGER_BUNDLE);
    b.uniforms.push({ name: 'uArr', type: 'vec3', count: 4, value: new Array(11).fill(0) });
    assertThrows(() => validateBundle(b), /needs 12 component/, 'array arity');
  });
});

// --- gate 2: shader assembly ----------------------------------------------

function glslangAvailable() {
  try { execFileSync('glslangValidator', ['-v'], { stdio: 'pipe' }); return true; }
  catch { return false; }
}

gate('Gate 2 — sampling shader assembly', () => {
  const built = {};
  check('fragment source assembles for both fields', () => {
    for (const which of ['sphere', 'menger']) {
      const b = loadTestBundle(which);
      const r = buildFragmentSource(b);
      built[which] = r;
      assert(r.source.startsWith('#version 300 es'), 'version header must lead');
      assertEq((r.source.match(/void main\(\)/g) || []).length, 1, 'exactly one main');
      assert(/float fcField\(vec3 p\)/.test(r.source), 'fcField wrapper missing');
      assert(/int fcMaterial\(vec3 p, vec3 n, vec4 trap\)/.test(r.source), 'fcMaterial wrapper missing');
      assert(/float fcFieldTrap\(vec3 p, out vec4 fcTrapOut\)/.test(r.source), 'fcFieldTrap wrapper missing');
      let depth = 0;
      for (const c of r.source) { if (c === '{') depth++; else if (c === '}') depth--; }
      assertEq(depth, 0, 'unbalanced braces in assembled source');
    }
    assert(/uniform int uIterations;/.test(built.menger.source), 'bundle uniform not declared');
    assert(/fcBoxDist/.test(built.menger.source), 'prelude not spliced');
  });

  check('section map covers every line of the assembly', () => {
    const { source, sections } = built.menger;
    const lines = source.split('\n').length;
    assertEq(sections[0].from, 1, 'sections start at line 1');
    for (let i = 1; i < sections.length; i++) {
      assertEq(sections[i].from, sections[i - 1].to + 1, `gap before section ${sections[i].name}`);
    }
    assert(sections[sections.length - 1].to <= lines, 'section map runs past the source');
  });

  if (!glslangAvailable()) {
    skip('shaders compile under glslangValidator', 'glslangValidator is not on PATH');
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'fieldcraft-glsl-'));
    const compile = (name, src, stage) => {
      const file = join(dir, `${name}.${stage}`);
      writeFileSync(file, src);
      try {
        execFileSync('glslangValidator', [file], { stdio: 'pipe' });
        return null;
      } catch (e) {
        return `${e.stdout ? e.stdout.toString() : ''}${e.stderr ? e.stderr.toString() : ''}`.trim();
      }
    };

    check('vertex shader compiles', () => {
      const err = compile('fullscreen', VERTEX_SOURCE, 'vert');
      assert(!err, `glslangValidator rejected the vertex shader:\n${err}`);
    });

    for (const which of ['sphere', 'menger']) {
      check(`${which} fragment shader compiles`, () => {
        const err = compile(which, built[which].source, 'frag');
        assert(!err, `glslangValidator rejected it:\n${err}`);
      });
    }

    check('canary: a broken splice is caught, not waved through', () => {
      const b = loadTestBundle('sphere');
      // Legal-looking GLSL that references an undeclared identifier. The
      // string linter cannot see this; only a real compile can.
      b.glsl.de.source = 'float de(vec3 p) { return length(p) - uUndeclaredRadius; }';
      const err = compile('canary', buildFragmentSource(b).source, 'frag');
      assert(err, 'the canary compiled, so this gate proves nothing');
      assert(/uUndeclaredRadius/.test(err), `unexpected canary error:\n${err}`);
    });

    rmSync(dir, { recursive: true, force: true });
  }
});

// --- gate 3: atlas tiling --------------------------------------------------

gate('Gate 3 — atlas layout and slab scatter', () => {
  check('layout covers every slice exactly once', () => {
    for (const res of [32, 64, 128, 243, 256, 512]) {
      for (const maxTexture of [4096, 8192, 16384]) {
        const L = computeAtlasLayout([res, res, res], { maxTexture, maxPixels: 16 * 1024 * 1024 });
        assert(L.atlasW <= maxTexture && L.atlasH <= maxTexture, `atlas ${L.atlasW}x${L.atlasH} over the limit`);
        assert(L.atlasW * L.atlasH <= 16 * 1024 * 1024 || L.tilesX * L.tilesY === 1, 'readback budget exceeded');
        const seen = new Set();
        for (const s of L.slabs) {
          assert(s.zCount <= L.tilesX * L.tilesY, 'slab holds more slices than the atlas has tiles');
          for (let z = s.zStart; z < s.zStart + s.zCount; z++) {
            assert(!seen.has(z), `slice ${z} sampled twice at res ${res}`);
            seen.add(z);
          }
        }
        assertEq(seen.size, res, `slices covered at res ${res}, maxTexture ${maxTexture}`);
      }
    }
  });

  check('512 cubed stays within one texture and several slabs', () => {
    const L = computeAtlasLayout([512, 512, 512], { maxTexture: 8192, maxPixels: 16 * 1024 * 1024 });
    assert(L.slabs.length > 1, 'expected more than one slab at 512 cubed');
    assert(L.perSlab * L.slabs.length >= 512, 'slabs do not reach the last slice');
    assertEq(L.bytes <= 64 * 1024 * 1024, true, 'readback buffer over 64 MB');
  });

  check('slab scatter lands on the coordinates an independent formula predicts', () => {
    // Deliberately not reusing encodeSliceCPU: the pixel offsets here are
    // derived from scratch, so agreement is evidence rather than tautology.
    const res = [8, 6, 20];
    const L = computeAtlasLayout(res, { maxTexture: 64, maxPixels: 1 << 20 });
    const pixels = new Uint8Array(L.atlasW * L.atlasH * 4);
    const want = new Map();
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

    for (const slab of L.slabs) {
      pixels.fill(0);
      want.clear();
      for (let i = 0; i < 60; i++) {
        const x = Math.floor(rnd() * res[0]);
        const y = Math.floor(rnd() * res[1]);
        const t = Math.floor(rnd() * slab.zCount);
        const z = slab.zStart + t;
        const tileCol = t % L.tilesX;
        const tileRow = Math.floor(t / L.tilesX);
        const px = tileCol * L.tileW + x;
        const py = tileRow * L.tileH + y;
        const o = (py * L.atlasW + px) * 4;
        const material = (x * 7 + y * 3 + z) % 16;
        const shade = (x + y + z) % 256;
        pixels[o] = 255; pixels[o + 1] = material; pixels[o + 2] = shade; pixels[o + 3] = 0;
        want.set(`${x},${y},${z}`, packValue(material, shade));
      }
      const grid = new VoxelGrid();
      voxelizeSlab(grid, pixels, L, slab, { mode: MODE.SOLID });
      assertEq(grid.size, want.size, `cell count for slab at z=${slab.zStart}`);
      for (const [k, v] of want) {
        const [x, y, z] = k.split(',').map(Number);
        assertEq(grid.get(x, y, z), v, `cell ${k}`);
      }
    }
  });

  check('shell mode keeps exactly the cells inside the thickness', () => {
    const res = [4, 4, 4];
    const L = computeAtlasLayout(res, { maxTexture: 32, maxPixels: 1 << 20 });
    const slab = L.slabs[0];
    const pixels = new Uint8Array(L.atlasW * L.atlasH * 4);
    let expected = 0;
    for (let t = 0; t < slab.zCount; t++) {
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          const px = (t % L.tilesX) * L.tileW + x;
          const py = Math.floor(t / L.tilesX) * L.tileH + y;
          const o = (py * L.atlasW + px) * 4;
          const depth = (x + y + t) % 6;
          pixels[o] = 255; pixels[o + 1] = 0; pixels[o + 2] = 0; pixels[o + 3] = depth;
          if (depth < 3) expected++;
        }
      }
    }
    const solid = new VoxelGrid();
    voxelizeSlab(solid, pixels, L, slab, { mode: MODE.SOLID });
    const shell = new VoxelGrid();
    voxelizeSlab(shell, pixels, L, slab, { mode: MODE.SHELL, shellThickness: 3 });
    assertEq(solid.size, 64, 'solid mode should keep every inside cell');
    assertEq(shell.size, expected, 'shell mode cell count');
  });

  check('material remap is applied during voxelisation', () => {
    const L = computeAtlasLayout([2, 2, 1], { maxTexture: 16, maxPixels: 1 << 16 });
    const pixels = new Uint8Array(L.atlasW * L.atlasH * 4);
    pixels[0] = 255; pixels[1] = 5; pixels[2] = 0; pixels[3] = 0;
    const grid = new VoxelGrid();
    const remap = []; remap[5] = 12;
    voxelizeSlab(grid, pixels, L, L.slabs[0], { mode: MODE.SOLID, remap });
    assertEq(valueMaterial(grid.get(0, 0, 0)), 12, 'remapped material');
  });
});

// --- gate 4: voxelisation against oracles ---------------------------------

function voxelizeField(res, bounds, field, opts = {}) {
  const L = computeAtlasLayout([res, res, res], { maxTexture: 16384, maxPixels: 64 * 1024 * 1024 });
  const pixels = new Uint8Array(L.atlasW * L.atlasH * 4);
  const grid = new VoxelGrid();
  for (const slab of L.slabs) {
    pixels.fill(0);
    encodeSliceCPU(pixels, L, slab, bounds, field, opts);
    voxelizeSlab(grid, pixels, L, slab, opts);
  }
  return grid;
}

gate('Gate 4 — voxelisation against oracles', () => {
  const box = { min: [-1, -1, -1], max: [1, 1, 1] };

  check('sphere volume matches the analytic value within 1%', () => {
    const res = 64, r = 0.9;
    const grid = voxelizeField(res, box, (x, y, z) => Math.hypot(x, y, z) - r);
    const cellVol = (2 / res) ** 3;
    const expected = (4 / 3) * Math.PI * r ** 3 / cellVol;
    assertNear(grid.size / expected, 1, 0.01, `sphere cells ${grid.size} vs expected ${Math.round(expected)}`);
  });

  check('sampled cells agree with the sphere membership oracle', () => {
    const res = 32, r = 0.9;
    const grid = voxelizeField(res, box, (x, y, z) => Math.hypot(x, y, z) - r);
    let mismatches = 0;
    for (let z = 0; z < res; z++) for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) {
      const p = i => -1 + (i + 0.5) * (2 / res);
      const expect = sphereContains(p(x), p(y), p(z), r);
      if (expect !== grid.has(x, y, z)) mismatches++;
    }
    assertEq(mismatches, 0, 'cell-by-cell disagreement with the oracle');
  });

  check('Menger sponge hits its exact cell count at every level', () => {
    for (const level of [1, 2, 3]) {
      const res = 3 ** level;
      const cell = 2 / res;
      const grid = voxelizeField(res, box,
        (x, y, z) => (mengerContains(x, y, z, level) ? -cell : cell));
      assertEq(grid.size, 20 ** level, `level ${level} at ${res} cubed`);
    }
  });

  check('iso offset shrinks and grows the solid as expected', () => {
    const field = (x, y, z) => Math.hypot(x, y, z) - 0.9;
    const grew = voxelizeField(32, box, field, { isoOffset: 0.1 });
    const base = voxelizeField(32, box, field, { isoOffset: 0 });
    const shrunk = voxelizeField(32, box, field, { isoOffset: -0.1 });
    assert(grew.size > base.size && base.size > shrunk.size,
      `expected monotone growth, got ${shrunk.size} / ${base.size} / ${grew.size}`);
  });

  check('cell budget truncates rather than overruns', () => {
    const L = computeAtlasLayout([16, 16, 16], { maxTexture: 1024, maxPixels: 1 << 22 });
    const pixels = new Uint8Array(L.atlasW * L.atlasH * 4);
    const grid = new VoxelGrid({ budget: 100 });
    for (const slab of L.slabs) {
      pixels.fill(0);
      encodeSliceCPU(pixels, L, slab, box, () => -1);
      voxelizeSlab(grid, pixels, L, slab, {});
    }
    assertEq(grid.size, 100, 'budget not respected');
    assertEq(grid.truncated, true, 'truncation not reported');
  });
});

// --- gate 5: blockcore -----------------------------------------------------

// Built with top-level await so the two checks below stay synchronous like the rest.
const DEFLATE_FIXTURE = await (async () => {
  if (!deflateAvailable()) return null;
  const g = new VoxelGrid();
  for (let i = 0; i < 64; i++) g.set(i, i, i, packValue(3, 0));
  const s = buildMcStructure(g, {});
  const z = new ZipWriter();
  z.add('structures/ns/sparse.mcstructure', s.bytes);
  return { raw: s.bytes, stored: z.build(), packed: await z.buildAsync() };
})();

gate('Gate 5 — blockcore', () => {
  check('packed keys round-trip across the full addressable range', () => {
    const cases = [[0, 0, 0], [1, 2, 3], [-1, -1, -1],
      [AXIS_MIN, AXIS_MIN, AXIS_MIN], [AXIS_MAX, AXIS_MAX, AXIS_MAX],
      [AXIS_MIN, AXIS_MAX, 0], [-65536, 65535, -1]];
    let seed = 7;
    const rnd = n => Math.floor((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff * n);
    for (let i = 0; i < 4000; i++) {
      cases.push([rnd(131072) - 65536, rnd(131072) - 65536, rnd(131072) - 65536]);
    }
    const seen = new Set();
    for (const [x, y, z] of cases) {
      const k = packKey(x, y, z);
      assert(Number.isSafeInteger(k), `key ${k} is not a safe integer`);
      assertEq(unpackKey(k), [x, y, z], `round-trip ${x},${y},${z}`);
      const s = `${x},${y},${z}`;
      if (!seen.has(s)) { assert(!seen.has(k), `key collision at ${s}`); seen.add(s); }
    }
  });

  check('value packing keeps material and shade separate', () => {
    for (const m of [0, 1, 15, 255]) for (const s of [0, 128, 255]) {
      const v = packValue(m, s);
      assertEq(valueMaterial(v), m, 'material');
      assertEq(valueShade(v), s, 'shade');
    }
  });

  const cube = (n, material = 0) => {
    const g = new VoxelGrid();
    for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      g.set(x, y, z, packValue(material, 0));
    }
    return g;
  };

  check('exposed face count is exact for a solid cube', () => {
    for (const n of [1, 2, 5, 9]) assertEq(countExposedFaces(cube(n)), 6 * n * n, `cube ${n}`);
  });

  check('greedy merge collapses a uniform cube to six quads', () => {
    const mesh = meshGrid(cube(7), { greedy: true, shadeStrength: 0 });
    assertEq(mesh.quadCount, 6, 'quads');
    assertEq(mesh.triangleCount, 12, 'triangles');
  });

  check('greedy and simple meshes cover the same surface area', () => {
    const g = new VoxelGrid();
    let seed = 99;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 900; i++) {
      g.set(Math.floor(rnd() * 12), Math.floor(rnd() * 12), Math.floor(rnd() * 12),
        packValue(Math.floor(rnd() * 4), 0));
    }
    const area = mesh => {
      let a = 0;
      const p = mesh.positions, idx = mesh.indices;
      for (let i = 0; i < idx.length; i += 3) {
        const [i0, i1, i2] = [idx[i] * 3, idx[i + 1] * 3, idx[i + 2] * 3];
        const ux = p[i1] - p[i0], uy = p[i1 + 1] - p[i0 + 1], uz = p[i1 + 2] - p[i0 + 2];
        const vx = p[i2] - p[i0], vy = p[i2 + 1] - p[i0 + 1], vz = p[i2 + 2] - p[i0 + 2];
        a += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
      }
      return a;
    };
    const greedy = meshGrid(g, { greedy: true });
    const simple = meshGrid(g, { greedy: false });
    const faces = countExposedFaces(g);
    assertNear(area(greedy), faces, 1e-6, 'greedy area');
    assertNear(area(simple), faces, 1e-6, 'simple area');
    assert(greedy.quadCount < simple.quadCount, 'greedy did not merge anything');
  });

  check('mesh winding is outward: signed volume equals the cell count', () => {
    // Divergence theorem over the closed surface. A flipped quad shows up as a
    // sign error here, which no area check would catch.
    const signedVolume = mesh => {
      let v = 0;
      const p = mesh.positions, idx = mesh.indices;
      for (let i = 0; i < idx.length; i += 3) {
        const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
        const ax = p[a], ay = p[a + 1], az = p[a + 2];
        const bx = p[b], by = p[b + 1], bz = p[b + 2];
        const cx = p[c], cy = p[c + 1], cz = p[c + 2];
        v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
      }
      return v;
    };
    for (const n of [1, 4, 6]) {
      const g = cube(n);
      const off = g.translated(3, 5, 7);
      assertNear(signedVolume(meshGrid(g, { greedy: true })), n ** 3, 1e-6, `greedy cube ${n}`);
      assertNear(signedVolume(meshGrid(g, { greedy: false })), n ** 3, 1e-6, `simple cube ${n}`);
      assertNear(signedVolume(meshGrid(off, { greedy: true })), n ** 3, 1e-6, `offset cube ${n}`);
    }
  });

  check('quad normals agree with the geometric winding', () => {
    const mesh = meshGrid(cube(3), { greedy: true });
    const p = mesh.positions, nr = mesh.normals, idx = mesh.indices;
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      const d = cx * nr[a] + cy * nr[a + 1] + cz * nr[a + 2];
      assert(d > 0, `normal disagrees with winding on triangle ${i / 3}`);
    }
  });

  check('NBT round-trips every tag type the writer emits', () => {
    const src = {
      b: { t: 1, v: -7 }, s: { t: 2, v: 300 }, i: { t: 3, v: -123456 },
      f: { t: 5, v: 0.5 }, d: { t: 6, v: 1 / 3 }, str: { t: 8, v: 'minecraft:stone' },
      list: { t: 9, et: 3, v: [1, 2, 3] },
      nested: { t: 9, et: 9, v: [{ t: 9, et: 3, v: [4, 5] }, { t: 9, et: 3, v: [6] }] },
      comp: { t: 10, v: { inner: { t: 3, v: 42 } } },
      emptyComp: { t: 10, v: {} },
    };
    const bytes = writeNBT('', { t: 10, v: src });
    const back = readNBT(bytes).value;
    assertEq(back.b, -7); assertEq(back.s, 300); assertEq(back.i, -123456);
    assertNear(back.f, 0.5, 1e-9); assertNear(back.d, 1 / 3, 1e-12);
    assertEq(back.str, 'minecraft:stone');
    assertEq([...back.list.items], [1, 2, 3]);
    assertEq([...back.nested.items[0].items], [4, 5]);
    assertEq(back.comp.inner, 42);
    assertEq(Object.keys(back.emptyComp).length, 0);
  });

  check('.mcstructure round-trips: size, ordering, palette, empties', () => {
    const g = new VoxelGrid();
    const placed = new Map();
    let seed = 4;
    const rnd = n => Math.floor((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff * n);
    for (let i = 0; i < 400; i++) {
      const x = rnd(9) - 4, y = rnd(7), z = rnd(11) - 5;
      const m = rnd(4);
      g.set(x, y, z, packValue(m, rnd(256)));
      placed.set(`${x},${y},${z}`, m);
    }
    const palette = new BlockPalette();
    const out = buildMcStructure(g, { palette, worldOrigin: [10, 20, 30] });
    const back = readNBT(out.bytes);

    assertEq(back.name, '', 'root tag is unnamed');
    assertEq(back.value.format_version, 1, 'format_version');
    assertEq([...back.value.size.items], out.size, 'size');
    assertEq([...back.value.structure_world_origin.items], [10, 20, 30], 'world origin');

    const layers = back.value.structure.block_indices.items;
    assertEq(layers.length, 2, 'two layers');
    assertEq(layers[0].items.length, layers[1].items.length, 'layers must be the same length');
    assertEq(layers[0].items.length, out.size[0] * out.size[1] * out.size[2], 'layer length');
    assert([...layers[1].items].every(v => v === -1), 'layer 1 should be untouched');

    const bp = back.value.structure.palette.default.block_palette.items;
    assertEq(bp.length, out.paletteEntries.length, 'palette length');
    for (const e of bp) {
      assert(e.name.startsWith('minecraft:'), `odd block name ${e.name}`);
      assertEq(e.version, palette.blockVersion, 'block version stamp');
    }

    const [sx, sy, sz] = out.size;
    const [ox, oy, oz] = out.origin;
    let checked = 0;
    for (let x = 0; x < sx; x++) for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) {
      const idx = (x * sy + y) * sz + z;
      const key = `${x + ox},${y + oy},${z + oz}`;
      const got = layers[0].items[idx];
      if (placed.has(key)) {
        const want = palette.blockFor(placed.get(key)).name;
        assertEq(bp[got].name, want, `block at ${key}`);
        checked++;
      } else {
        assertEq(got, -1, `empty cell at ${key} should be -1`);
      }
    }
    assertEq(checked, placed.size, 'every placed cell accounted for');
    assertEq(out.blocks, placed.size, 'reported block count');
  });

  check('legacy block naming produces a states compound', () => {
    const g = new VoxelGrid();
    g.set(0, 0, 0, packValue(4, 0));
    const out = buildMcStructure(g, { palette: new BlockPalette({ flattened: false }) });
    const bp = readNBT(out.bytes).value.structure.palette.default.block_palette.items;
    assertEq(bp[0].name, 'minecraft:concrete', 'legacy name');
    assertEq(bp[0].states.color, 'red', 'legacy colour state');
    const flat = buildMcStructure(g, { palette: new BlockPalette({ flattened: true }) });
    const fbp = readNBT(flat.bytes).value.structure.palette.default.block_palette.items;
    assertEq(fbp[0].name, 'minecraft:red_concrete', 'flattened name');
  });

  check('air fill mode writes a real block instead of -1', () => {
    const g = new VoxelGrid();
    g.set(0, 0, 0, packValue(1, 0));
    g.set(2, 0, 0, packValue(1, 0));
    const out = buildMcStructure(g, { empty: 'air' });
    const parsed = readNBT(out.bytes).value;
    const bp = parsed.structure.palette.default.block_palette.items;
    const idx = parsed.structure.block_indices.items[0].items;
    assert([...idx].every(v => v >= 0), 'no cell should be -1 in air mode');
    assert(bp.some(e => e.name === 'minecraft:air'), 'air missing from the palette');
  });

  check('oversized volumes are refused with a clear message', () => {
    const g = new VoxelGrid();
    g.set(0, 0, 0, 0);
    g.set(300, 300, 300, 0);
    assertThrows(() => buildMcStructure(g), /Split it first/, 'oversize guard');
  });

  check('splitting is aligned, lossless and duplicate-free', () => {
    const g = new VoxelGrid();
    let seed = 21;
    const rnd = n => Math.floor((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff * n);
    const placed = new Map();
    for (let i = 0; i < 3000; i++) {
      const x = rnd(90) - 45, y = rnd(50), z = rnd(70) - 30;
      const v = packValue(rnd(8), rnd(256));
      g.set(x, y, z, v);
      placed.set(`${x},${y},${z}`, v);
    }
    const split = splitGrid(g, { chunk: [16, 16, 16] });
    let sum = 0;
    const seen = new Set();
    for (const c of split.chunks) {
      for (let a = 0; a < 3; a++) assertEq(c.origin[a] % 16, 0, 'chunk origin alignment');
      sum += c.grid.size;
      c.grid.forEach((x, y, z, v) => {
        const key = `${x + c.origin[0]},${y + c.origin[1]},${z + c.origin[2]}`;
        assert(!seen.has(key), `cell ${key} appears in two chunks`);
        seen.add(key);
        assertEq(placed.get(key), v, `value at ${key}`);
        assert(x >= 0 && x < 16 && y >= 0 && y < 16 && z >= 0 && z < 16, 'local coords out of chunk');
      });
    }
    assertEq(sum, g.size, 'cells lost or duplicated by splitting');
    assertEq(seen.size, placed.size, 'reassembled cell set');

    const guide = placementGuide(split, { baseName: 'thing' });
    assertEq((guide.match(/\/structure load/g) || []).length, split.chunks.length, 'one command per piece');
    assert(/thing_000/.test(guide), 'piece naming');
  });

  check('chunk sizes over the in-game structure limit are refused', () => {
    const g = cube(2);
    assertThrows(() => splitGrid(g, { chunk: [128, 16, 16] }), /exceeds the in-game structure limit/);
  });

  check('zip: stored entries carry correct CRCs and offsets', () => {
    const z = new ZipWriter();
    const payloads = {
      'manifest.json': new TextEncoder().encode('{"a":1}'),
      'structures/ns/a.mcstructure': new Uint8Array([1, 2, 3, 4, 5]),
      'placement-guide.txt': new TextEncoder().encode('hello\nworld'),
    };
    for (const [k, v] of Object.entries(payloads)) z.add(k, v);
    const bytes = z.build();
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    let eocd = -1;
    for (let i = bytes.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    assert(eocd >= 0, 'no end of central directory record');
    assertEq(dv.getUint16(eocd + 10, true), 3, 'entry count');
    const cdOffset = dv.getUint32(eocd + 16, true);
    assertEq(dv.getUint32(eocd + 12, true), eocd - cdOffset, 'central directory size');

    let p = cdOffset;
    for (let i = 0; i < 3; i++) {
      assertEq(dv.getUint32(p, true), 0x02014b50, 'central directory signature');
      const nameLen = dv.getUint16(p + 28, true);
      const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
      const local = dv.getUint32(p + 42, true);
      assertEq(dv.getUint32(local, true), 0x04034b50, 'local header signature');
      const lnameLen = dv.getUint16(local + 26, true);
      const lextra = dv.getUint16(local + 28, true);
      const dataAt = local + 30 + lnameLen + lextra;
      const size = dv.getUint32(local + 18, true);
      const data = bytes.subarray(dataAt, dataAt + size);
      assertEq([...data], [...payloads[name]], `payload of ${name}`);
      assertEq(dv.getUint32(local + 14, true), crc32(payloads[name]), `crc of ${name}`);
      p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
    }
  });

  check('.mcpack carries a valid manifest and the structure payload', () => {
    const g = cube(4, 6);
    const s = buildMcStructure(g, {});
    const pack = buildMcPack({
      name: 'Test', namespace: 'Field Craft!',
      structures: [{ name: 'My Field', bytes: s.bytes }],
      extraFiles: [{ path: 'placement-guide.txt', data: 'guide' }],
    });
    assertEq(pack.namespace, 'field_craft', 'namespace sanitised');
    assertEq(pack.paths[0], 'structures/field_craft/my_field.mcstructure', 'structure path');
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    assert(uuidRe.test(pack.manifest.header.uuid), 'header uuid');
    assert(uuidRe.test(pack.manifest.modules[0].uuid), 'module uuid');
    assert(pack.manifest.header.uuid !== pack.manifest.modules[0].uuid, 'uuids must differ');
    assertEq(pack.manifest.format_version, 2, 'manifest format version');
    assertEq(pack.manifest.modules[0].type, 'data', 'module type');
    globalThis.__packBytes = pack.bytes;
    globalThis.__structBytes = s.bytes;
  });

  check('deflate shrinks a sparse structure by orders of magnitude', () => {
    // A sparse sculpture is mostly the -1 that means "no block", so this is the
    // difference between a usable download and a 55 MB one.
    if (!DEFLATE_FIXTURE) throw new Error('CompressionStream is unavailable here');
    const { stored, packed } = DEFLATE_FIXTURE;
    assert(packed.length * 20 < stored.length,
      `expected a large saving, got ${stored.length} -> ${packed.length}`);
  });

  check('a deflated entry inflates correctly in an independent reader', () => {
    if (!DEFLATE_FIXTURE) throw new Error('CompressionStream is unavailable here');
    const dir = mkdtempSync(join(tmpdir(), 'fieldcraft-def-'));
    const file = join(dir, 'd.zip');
    writeFileSync(file, Buffer.from(DEFLATE_FIXTURE.packed));
    let out;
    try {
      out = execFileSync('python3', ['-c', `
import zipfile
z = zipfile.ZipFile(${JSON.stringify(file)})
assert z.testzip() is None
i = z.getinfo('structures/ns/sparse.mcstructure')
assert i.compress_type == zipfile.ZIP_DEFLATED, i.compress_type
print(len(z.read('structures/ns/sparse.mcstructure')))
`], { stdio: 'pipe' }).toString().trim();
    } catch (e) {
      throw new Error(`python zipfile rejected it: ${e.stderr ? e.stderr.toString() : e.message}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    assertEq(parseInt(out, 10), DEFLATE_FIXTURE.raw.length, 'inflated size');
  });

  check('.mcpack opens as a zip in an independent reader', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fieldcraft-pack-'));
    const file = join(dir, 'test.mcpack');
    writeFileSync(file, Buffer.from(globalThis.__packBytes));
    let out;
    try {
      out = execFileSync('python3', ['-c', `
import zipfile, json, sys
z = zipfile.ZipFile(${JSON.stringify(file)})
bad = z.testzip()
assert bad is None, 'corrupt entry: %s' % bad
m = json.loads(z.read('manifest.json'))
assert m['format_version'] == 2
names = z.namelist()
assert 'structures/field_craft/my_field.mcstructure' in names, names
assert 'placement-guide.txt' in names, names
print(len(z.read('structures/field_craft/my_field.mcstructure')))
`], { stdio: 'pipe' }).toString().trim();
    } catch (e) {
      throw new Error(`python zipfile rejected the pack: ${e.stderr ? e.stderr.toString() : e.message}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    assertEq(parseInt(out, 10), globalThis.__structBytes.length, 'structure bytes survived the zip');
  });

  check('palette covers every material id the test fields emit', () => {
    const p = new BlockPalette();
    for (const b of [loadTestBundle('sphere'), loadTestBundle('menger')]) {
      for (const id of b.hints.materialIds || []) {
        assert(MATERIALS[p.resolve(id)], `material ${id} in ${b.name}`);
      }
    }
    assertEq(p.blockFor(0).name, 'minecraft:white_concrete', 'material 0');
    assertEq(p.resolve(17), 1, 'ids wrap into the palette');
  });
});

// --- gate 6: real GL against the oracles ----------------------------------

function renderWithGL(bundle, res) {
  const dir = mkdtempSync(join(tmpdir(), 'fieldcraft-gl-'));
  const L = computeAtlasLayout([res, res, res], { maxTexture: 4096, maxPixels: 16 * 1024 * 1024 });
  const built = buildFragmentSource(bundle);
  const span = bundle.bounds.max.map((v, i) => v - bundle.bounds.min[i]);
  const cell = Math.max(...span.map(s => s / res));

  writeFileSync(join(dir, 'shader.vert'), VERTEX_SOURCE);
  writeFileSync(join(dir, 'shader.frag'), built.source);
  writeFileSync(join(dir, 'job.json'), JSON.stringify({
    res: [res, res, res],
    boxMin: bundle.bounds.min,
    boxMax: bundle.bounds.max,
    tilesX: L.tilesX,
    iso: bundle.isoOffset,
    normEps: cell * 0.5,
    atlasW: L.atlasW,
    atlasH: L.atlasH,
    slabs: L.slabs,
    uniforms: bundle.uniforms.map(u => ({ name: u.name, value: u.value })),
  }));

  let report;
  try {
    report = JSON.parse(execFileSync('python3', [join('tools', 'glrender.py'), dir], { stdio: 'pipe' }).toString());
  } catch (e) {
    const out = (e.stdout && e.stdout.toString()) || '';
    let parsed = null;
    try { parsed = JSON.parse(out); } catch { /* not our JSON */ }
    rmSync(dir, { recursive: true, force: true });
    return { skip: parsed ? parsed.error : (e.stderr ? e.stderr.toString().split('\n')[0] : e.message) };
  }

  const bytes = readFileSync(join(dir, 'pixels.bin'));
  rmSync(dir, { recursive: true, force: true });
  const slabBytes = L.atlasW * L.atlasH * 4;
  return { layout: L, bytes, slabBytes, report };
}

gate('Gate 6 — the real shader against the oracles (Mesa/EGL)', () => {
  const probe = renderWithGL(loadTestBundle('sphere'), 32);
  if (probe.skip) {
    skip('sphere rendered by GL matches the membership oracle', probe.skip);
    skip('Menger rendered by GL hits its exact cell count', 'same reason');
    skip('GL and CPU encoders agree pixel for pixel', 'same reason');
    return;
  }
  console.log(`        renderer: ${probe.report.renderer} · ${probe.report.version}`);

  const gridFrom = r => {
    const grid = new VoxelGrid();
    r.layout.slabs.forEach((slab, i) => {
      const view = new Uint8Array(r.bytes.buffer, r.bytes.byteOffset + i * r.slabBytes, r.slabBytes);
      voxelizeSlab(grid, view, r.layout, slab, { mode: MODE.SOLID });
    });
    return grid;
  };

  check('sphere rendered by GL matches the membership oracle', () => {
    const res = 32, r = 0.9;
    const grid = gridFrom(probe);
    let mismatches = 0;
    const p = i => -1 + (i + 0.5) * (2 / res);
    for (let z = 0; z < res; z++) for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) {
      if (sphereContains(p(x), p(y), p(z), r) !== grid.has(x, y, z)) mismatches++;
    }
    assertEq(mismatches, 0, 'GL disagreed with the CPU oracle');
    assert(grid.size > 1000, `suspiciously empty result: ${grid.size} cells`);
  });

  check('Menger rendered by GL hits its exact cell count', () => {
    for (const level of [2, 3]) {
      const b = loadTestBundle('menger');
      b.uniforms[0].value = level;
      const res = 3 ** level;
      const r = renderWithGL(b, res);
      assert(!r.skip, r.skip || '');
      const grid = gridFrom(r);
      assertEq(grid.size, 20 ** level, `level ${level} at ${res} cubed`);
      let mismatches = 0;
      const p = i => -1 + (i + 0.5) * (2 / res);
      for (let z = 0; z < res; z++) for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) {
        if (mengerContains(p(x), p(y), p(z), level) !== grid.has(x, y, z)) mismatches++;
      }
      assertEq(mismatches, 0, `cell-by-cell disagreement at level ${level}`);
    }
  });

  check('GL and CPU encoders agree pixel for pixel', () => {
    const res = 32, r = 0.9;
    const L = probe.layout;
    const cpu = new Uint8Array(L.atlasW * L.atlasH * 4);
    let insideChecked = 0;
    L.slabs.forEach((slab, i) => {
      cpu.fill(0);
      encodeSliceCPU(cpu, L, slab, { min: [-1, -1, -1], max: [1, 1, 1] },
        (x, y, z) => Math.hypot(x, y, z) - r, {});
      const gl = new Uint8Array(probe.bytes.buffer, probe.bytes.byteOffset + i * probe.slabBytes, probe.slabBytes);
      for (let p = 0; p < cpu.length; p += 4) {
        assertEq(gl[p] > 0, cpu[p] > 0, `inside flag at byte ${p} of slab ${i}`);
        if (cpu[p] > 0) {
          // Depth is quantised the same way on both sides; allow one step of
          // float32 slack at the cell boundary.
          assert(Math.abs(gl[p + 3] - cpu[p + 3]) <= 1,
            `depth at byte ${p} of slab ${i}: GL ${gl[p + 3]} vs CPU ${cpu[p + 3]}`);
          insideChecked++;
        }
      }
    });
    assert(insideChecked > 1000, `too few inside samples compared: ${insideChecked}`);
  });
});

// --- summary ---------------------------------------------------------------

console.log(`\n${'-'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('All gates green.');
