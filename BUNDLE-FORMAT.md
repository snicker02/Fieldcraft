# Field bundle format

Version 1 · `format: "fieldcraft.field-bundle"`

The contract between a host raymarcher and Fieldcraft. A host exports one JSON
object describing its own distance estimator in its own terms. Fieldcraft loads
it, splices the GLSL into its sampling shader and takes it from there. Nothing
block-related ever enters a host program, and the host never learns that
Minecraft is involved.

## Shape

```jsonc
{
  "format": "fieldcraft.field-bundle",
  "version": 1,
  "name": "Octahedral fold stack",
  "source": { "app": "Catoptron 3D", "build": "0.2.0-mirrors" },

  "glsl": {
    "version": "300 es",
    "prelude": "float prim(vec3 p) { ... }",

    "de": {
      "name": "de",
      "signature": "float de(vec3 p, inout float s, inout vec4 trap)",
      "source": "float de(vec3 p, inout float s, inout vec4 trap) { ... }",
      "paramDefaults": { "s": "1.0", "trap": "vec4(1e10)" },
      "scaleParam": "s"
    },

    "material": {
      "name": "material",
      "signature": "int material(vec3 p, vec3 n)",
      "source": "int material(vec3 p, vec3 n) { ... }"
    }
  },

  "uniforms": [
    { "name": "uScale", "type": "float", "value": 1.9,
      "label": "Fold scale", "min": 1.0, "max": 3.0, "step": 0.01 }
  ],

  "bounds": { "min": [-2, -2, -2], "max": [2, 2, 2] },
  "isoOffset": 0.0,
  "hints": { "suggestedRes": 256, "materialIds": [0, 2, 9, 11] }
}
```

## Fields

**`glsl.de.signature`** — the host's estimator signature, written out verbatim.
This is the whole point of the design: Fieldcraft does not impose a signature,
it reads yours and builds the call to match. Requirements are only that it
returns `float` and that its first parameter is a `vec3` sample point. Any
number of further parameters is fine, with `in`, `out` or `inout` qualifiers.

Fieldcraft generates:

```glsl
float fcField(vec3 p) {
  float s = 1.0;             // from paramDefaults, or the type default
  vec4 trap = vec4(1e10);
  float d = de(p, s, trap);
  d /= max(s, 1e-9);         // only when scaleParam is set
  return d;
}
```

**`glsl.de.paramDefaults`** — GLSL initialiser expressions for the extra
parameters, keyed by parameter name. Omitted parameters get a zero-ish default
for their type, which is usually wrong for a scale accumulator, so set them.

**`glsl.de.scaleParam`** — name of a `float` parameter that accumulates the
operator norm of the Jacobian. If your estimator returns `prim(p)` undivided
and the caller is expected to divide by the accumulated scale, name it here.
If the division already happens inside your `de`, leave it out.

**`glsl.prelude`** — shared helpers: primitives, constants, per-op functions.
Spliced before the estimator.

**`glsl.material`** — returns an `int` material id from `(vec3 p, vec3 n)` or
`(vec3 p)`. Optional; everything becomes material 0 without it. The normal is
computed by Fieldcraft from the field, so it exists whether you use it or not.

**`uniforms`** — every uniform the spliced source references. `name`, `type`
and `value` are required; `label`, `min`, `max` and `step` drive the generated
controls. Supported types: `bool`, `int`, `float`, `vec2..4`, `ivec2..4`,
`bvec2..4`, `mat2`, `mat3`, `mat4`. Component counts must match the type.

**`bounds`** — the box to rasterise, in the field's own coordinates. `max` must
exceed `min` on every axis. This decides what gets built, so it is worth the
host putting some thought into rather than shipping a generic cube.

**`isoOffset`** — a constant subtracted from the distance before the inside
test. Negative shrinks the solid, positive grows it. Fieldcraft exposes its own
slider on top of this.

**`hints`** — advisory only. `suggestedRes` preloads the resolution slider,
`materialIds` documents the ids the material expression can return.

## Rules the host must honour

* The first parameter of the estimator is the sample point.
* Discrete and compile-time choices must already be baked into `source`.
  Fieldcraft compiles the string it is handed; it does not re-run your
  assembler, and a live branch inside a fold would be as unaffordable here as
  it is in a raymarcher.
* Every identifier the source references must be defined in `prelude` or
  declared in `uniforms`.
* The `fc` and `uFc` prefixes are reserved for Fieldcraft's own names and are
  rejected.
* No `#version`, no `precision` statement, no `main()`, no stage `in`/`out`
  declarations in spliced source. Fieldcraft supplies all of those.

## Rejections

`validateBundle` throws a `BundleError` naming the offending path rather than
failing later in the shader compiler. The refusals covered by the test suite:
foreign format tag, future version, non-`float` return, non-`vec3` first
parameter, name/signature disagreement, unbalanced braces or parentheses,
`#version` or `main()` in spliced source, source that never defines the named
function, duplicate uniform, wrong component count, reserved prefix, unknown
uniform type, inverted bounding box, non-finite iso offset, `scaleParam` that
is not a parameter, material expression with the wrong return type.

When a bundle passes validation but the assembled shader still fails to
compile — an undeclared identifier, say, which no string check can catch —
Fieldcraft annotates each error line with the section it fell in and the line
number within that section, so a host's own source is reported in the host's
own coordinates.

## Writing the export hook

`host/fieldcraft-export.js` is a drop-in with no imports. Copy it into the host
and wire the button:

```js
import { makeFieldBundle, addExportFieldButton } from './fieldcraft-export.js';

addExportFieldButton(exportRow, () => makeFieldBundle({
  name: state.presetName,
  source: { app: 'Catoptron 3D', build: BUILD_STAMP },
  prelude: assembled.helpers,
  deSignature: 'float de(vec3 p, inout float s, inout vec4 trap)',
  deSource: assembled.deSource,
  scaleParam: 's',
  paramDefaults: { s: '1.0', trap: 'vec4(1e10)' },
  materialSource: MATERIAL_GLSL,
  uniforms: state.foldParams.map(p => ({
    name: p.glslName, type: p.glslType, value: p.value,
    label: p.label, min: p.min, max: p.max,
  })),
  bounds: { min: [-2, -2, -2], max: [2, 2, 2] },
}));
```
