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
  "name": "Folded frames",
  "source": { "app": "Catoptron 3D", "build": "0.57.3" },

  "glsl": {
    "version": "300 es",
    "prelude": "float prim(vec3 p) { ... }",

    "de": {
      "name": "mapT",
      "signature": "float mapT(vec3 p, out vec4 trap, out float safe)",
      "source": "float mapT(vec3 p, out vec4 trap, out float safe) { ... }",
      "paramDefaults": { "trap": "vec4(1e9)" },
      "scaleParam": null,
      "trapParam": "trap"
    },

    "material": {
      "name": "material",
      "signature": "int material(vec3 p, vec3 n, vec4 trap)",
      "source": "int material(vec3 p, vec3 n, vec4 trap) { ... }"
    }
  },

  "uniforms": [
    { "name": "uPrimSize", "type": "float", "value": 1.0,
      "label": "Size", "min": 0.05, "max": 3, "step": 0.01 },
    { "name": "uFlameMi", "type": "mat3", "count": 24, "value": [ /* 9 x 24 */ ] }
  ],

  "bounds": { "min": [-2, -2, -2], "max": [2, 2, 2] },
  "isoOffset": 0.0,
  "hints": { "suggestedRes": 256, "materialIds": [2, 3, 4, 5, 6, 7] }
}
```

## Fields

**`glsl.de.signature`** — the host's estimator signature, written out verbatim.
This is the whole point of the design: Fieldcraft does not impose a signature,
it reads yours and builds the call to match. The only requirements are that it
returns `float` and that its first parameter is a `vec3` sample point. Any
number of further parameters is fine, with `in`, `out` or `inout` qualifiers.

Fieldcraft generates two entry points from one body — the plain one is what the
normal probe calls four times per cell, the trap one is called once per cell:

```glsl
float fcField(vec3 p) {
  vec4 trap = vec4(1e9);        // from paramDefaults, or the type default
  float safe = 0.0;
  float d = mapT(p, trap, safe);
  return d;
}

float fcFieldTrap(vec3 p, out vec4 fcTrapOut) {
  vec4 trap = vec4(1e9);
  float safe = 0.0;
  float d = mapT(p, trap, safe);
  fcTrapOut = trap;             // when trapParam is set
  return d;
}
```

**`glsl.de.paramDefaults`** — GLSL initialiser expressions for the extra
parameters, keyed by parameter name. Omitted parameters get a zero-ish default
for their type, which is usually wrong for a scale accumulator, so set them.
A parameter declared `out` is written by the estimator before it is read, so
its default does not matter.

**`glsl.de.scaleParam`** — name of a `float` parameter that accumulates the
operator norm of the Jacobian. Set it only if your estimator returns `prim(p)`
undivided and expects the caller to divide by the accumulated scale. If the
division already happens inside the estimator — as it does in Catoptron 3D,
where `s` is a local — leave it out.

**`glsl.de.trapParam`** — name of a `vec4` `out` or `inout` parameter carrying
an orbit trap. Set it if you want trap-driven material ids. Required when the
material expression takes three arguments.

**`glsl.prelude`** — shared helpers: primitives, constants, per-op functions.
Spliced before the estimator. When the whole field arrives as one slab of
source, put it all in `de.source` and leave this empty.

**`glsl.material`** — returns an `int` material id. Three accepted signatures:

```glsl
int material(vec3 p)
int material(vec3 p, vec3 n)
int material(vec3 p, vec3 n, vec4 trap)
```

Optional; everything becomes material 0 without it. The normal is computed by
Fieldcraft from the field, so it exists whether you use it or not.

**`uniforms`** — every uniform the spliced source references. `name`, `type`
and `value` are required; `count` makes it an array; `label`, `min`, `max` and
`step` drive the generated controls. Supported types: `bool`, `int`, `float`,
`vec2..4`, `ivec2..4`, `bvec2..4`, `mat2`, `mat3`, `mat4`. Array values are
flat: a `mat3` with `count: 24` carries 216 numbers. Samplers cannot cross a
JSON file and are not supported — a field that reads a texture cannot be
exported as a bundle.

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
* Every identifier the source references must be defined in `prelude`, in
  `source`, or declared in `uniforms`.
* The `fc` and `uFc` prefixes are reserved for Fieldcraft's own names.
* No `#version`, no `precision` statement, no `main()`, no stage `in`/`out`
  declarations in spliced source. Fieldcraft supplies all of those.

## Rejections

`validateBundle` throws a `BundleError` naming the offending path rather than
failing later in the shader compiler: foreign format tag, future version,
non-`float` return, non-`vec3` first parameter, name/signature disagreement,
unbalanced braces or parentheses, `#version` or `main()` in spliced source,
source that never defines the named function, duplicate uniform, wrong
component count, reserved prefix, unknown uniform type, negative array count,
inverted bounding box, non-finite iso offset, `scaleParam` or `trapParam` that
is not a parameter of the right type, material expression with the wrong return
type or argument list, and a material asking for a trap the estimator does not
expose.

When a bundle passes validation but the assembled shader still fails to
compile — an undeclared identifier, say, which no string check can catch —
Fieldcraft annotates each error line with the section it fell in and the line
number within that section, so a host's own source is reported in the host's
own coordinates.

## Writing the export hook

`host/fieldcraft-export.js` is a drop-in with no imports. There are two ways in.

### When the field source is already separate

```js
import { makeFieldBundle, addExportFieldButton } from './fieldcraft-export.js';

addExportFieldButton(exportRow, () => makeFieldBundle({
  name: state.presetName,
  source: { app: 'My raymarcher', build: BUILD },
  prelude: assembled.helpers,
  deSignature: 'float de(vec3 p, inout float s)',
  deSource: assembled.deSource,
  scaleParam: 's',
  paramDefaults: { s: '1.0' },
  uniforms: params.map(p => ({ name: p.glslName, type: p.glslType, value: p.value })),
  bounds: { min: [-2, -2, -2], max: [2, 2, 2] },
}));
```

### When the host assembles one big fragment shader

This is the Catoptron 3D case, and the one worth reading. The field half is
everything above `main()`, so the export is a string slice plus a read of the
live program's uniforms — the host does not have to maintain a second
description of its own state:

```js
import { bundleFromProgram, addExportFieldButton } from './fieldcraft-export.js';

addExportFieldButton(exportRow, () => {
  const { bundle, droppedSamplers } = bundleFromProgram({
    name: state.presetName || 'Catoptron field',
    source: { app: 'Catoptron 3D', build: BUILD },
    shaderSource: assemble(cfg),     // the same string the browser compiles
    gl, program,                     // values are read back off the live program
    deSignature: 'float mapT(vec3 p, out vec4 trap, out float safe)',
    trapParam: 'trap',
    materialSignature: 'int material(vec3 p, vec3 n, vec4 trap)',
    materialSource: 'int material(vec3 p, vec3 n, vec4 trap){ return 2 + int(mod(floor(trap.w * 7.0), 6.0)); }',
    bounds: { min: [-2, -2, -2], max: [2, 2, 2] },
  });
  if (droppedSamplers.length) console.warn('[fieldcraft] not exported:', droppedSamplers);
  return bundle;
});
```

`fieldFromShaderSource` removes the version directive, the precision statement
and the stage outputs, pulls every `uniform` declaration out into the uniform
list, and drops samplers. `harvestUniforms` then reads the current value of each
one straight off the linked program with `getUniform`, arrays included, so
whatever the host last pushed is what the bundle records.

One safeguard worth knowing about, because it exists for a bug that actually
happened: if any `uniform` declaration survives the parse, `fieldFromShaderSource`
throws and names the line. A declaration it fails to recognise would otherwise
stay in the source, compile perfectly, and read as zero forever — a picture that
is subtly wrong rather than obviously missing, which is the hardest kind of
failure to trace. The first version of the parser did exactly that to every
declaration with a trailing comment, which in Catoptron 3D was 22 of 95.
