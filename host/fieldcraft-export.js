// host/fieldcraft-export.js
// Drop this one file into a host raymarcher (Catoptron 3D first) and wire the
// button. It has no imports, knows nothing about blocks, voxels or Minecraft,
// and never has to: it only describes the host's own distance estimator.
//
// Typical use in Catoptron 3D, where the fold stack is already assembled into
// a shader string with a known estimator signature:
//
//   import { makeFieldBundle, addExportFieldButton } from './fieldcraft-export.js';
//
//   addExportFieldButton(document.querySelector('#exportRow'), () => makeFieldBundle({
//     name: state.presetName || 'Catoptron field',
//     source: { app: 'Catoptron 3D', build: BUILD_STAMP },
//     prelude: assembled.helpers,           // primitives, shared ops
//     deSignature: 'float de(vec3 p, inout float s, inout vec4 trap)',
//     deSource: assembled.deSource,         // the generated estimator
//     scaleParam: 's',                      // Fieldcraft divides by it, as the DE contract does
//     paramDefaults: { s: '1.0', trap: 'vec4(1e10)' },
//     materialSignature: 'int material(vec3 p, vec3 n)',
//     materialSource: MATERIAL_GLSL,
//     uniforms: state.foldParams.map(p => ({ name: p.glslName, type: p.glslType, value: p.value })),
//     bounds: { min: [-2, -2, -2], max: [2, 2, 2] },
//     isoOffset: 0,
//   }));
//
// Rules the host has to honour:
//  * the estimator's first parameter is the sample point (vec3)
//  * discrete/compile-time choices must already be baked into deSource, since
//    Fieldcraft compiles the string it is handed and does not re-run your
//    assembler
//  * every identifier deSource references must be declared in prelude or in
//    the uniforms array
//  * do not use the reserved fc / uFc prefix for your own names
//  * if your estimator accumulates a scale and divides at the end, leave the
//    division in and omit scaleParam; if it returns the undivided primitive
//    distance, name the accumulator in scaleParam instead

export const FIELD_BUNDLE_FORMAT = 'fieldcraft.field-bundle';
export const FIELD_BUNDLE_VERSION = 1;

/**
 * @returns {object} a plain JSON-serialisable bundle
 */
export function makeFieldBundle(spec) {
  if (!spec || !spec.deSource) throw new Error('makeFieldBundle needs deSource');
  if (!spec.deSignature) throw new Error('makeFieldBundle needs deSignature');
  if (!spec.bounds || !spec.bounds.min || !spec.bounds.max) throw new Error('makeFieldBundle needs bounds');

  const bundle = {
    format: FIELD_BUNDLE_FORMAT,
    version: FIELD_BUNDLE_VERSION,
    name: spec.name || 'Untitled field',
    source: spec.source || undefined,
    glsl: {
      version: '300 es',
      prelude: spec.prelude || undefined,
      de: {
        name: functionNameOf(spec.deSignature),
        signature: spec.deSignature,
        source: spec.deSource,
        paramDefaults: spec.paramDefaults || undefined,
        scaleParam: spec.scaleParam || undefined,
      },
      material: spec.materialSource ? {
        name: functionNameOf(spec.materialSignature || 'int material(vec3 p, vec3 n)'),
        signature: spec.materialSignature || 'int material(vec3 p, vec3 n)',
        source: spec.materialSource,
      } : undefined,
    },
    uniforms: (spec.uniforms || []).map(u => ({
      name: u.name,
      type: u.type,
      value: u.value,
      label: u.label,
      min: u.min,
      max: u.max,
      step: u.step,
    })),
    bounds: { min: [...spec.bounds.min], max: [...spec.bounds.max] },
    isoOffset: spec.isoOffset || 0,
    hints: spec.hints || undefined,
  };

  return JSON.parse(JSON.stringify(bundle));
}

function functionNameOf(signature) {
  const m = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(String(signature));
  if (!m) throw new Error(`Cannot read a function name out of "${signature}"`);
  return m[1];
}

export function downloadFieldBundle(bundle, filename) {
  const name = filename || `${String(bundle.name || 'field').toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}.fieldbundle.json`;
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * Adds the small "Export field" button.
 * @param {HTMLElement} container
 * @param {function} getBundle  called on click, returns a bundle object
 */
export function addExportFieldButton(container, getBundle, label = 'Export field') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  btn.addEventListener('click', () => {
    try {
      downloadFieldBundle(getBundle());
    } catch (e) {
      console.error('[fieldcraft] export failed', e);
      btn.textContent = 'Export failed — see console';
      setTimeout(() => { btn.textContent = label; }, 2500);
    }
  });
  container.appendChild(btn);
  return btn;
}
