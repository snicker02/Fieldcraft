# Fieldcraft 0.2.0

Signed distance fields from a raymarcher, out the other end as Minecraft
Bedrock structures.

Separate app from IFScraft, Imagecraft and Mazecraft. Same conventions as
Catoptron 3D: multi-file ES modules, no external dependencies, headless
validation.

## The two pieces

**The field bundle** is the contract between host programs and this app — see
`BUNDLE-FORMAT.md`. A host gets a small "Export field" button that writes one
JSON object describing its own estimator. Fieldcraft splices that GLSL into its
sampling shader. Nothing block-related crosses back into the host.

**blockcore** is a standalone engine module under `engine/blockcore/`. It owns
the sparse voxel map, the block palette and matching, the merged face-culled
mesher, splitting, and the `.mcstructure` / `.mcpack` writers. It knows nothing
about distance fields, shaders or Fieldcraft, which is what makes it the thing
IFScraft, Imagecraft and Mazecraft migrate onto later. Fieldcraft is a front end
on top of it.

```
index.html
main.js                     DOM and order of operations only
engine/
  bundle.js                 bundle schema, signature parsing, GLSL splicing
  testfields.js             sphere + Menger bundles, CPU membership oracles
  sampler.js                WebGL2 tiled atlas sampling
  voxelize.js               atlas layout, slab -> cells, solid/shell
  preview.js                mesh viewer
  blockcore/
    index.js                the public surface
    voxels.js               sparse map, packed keys, cell budget
    palette.js              material ids -> Bedrock blocks
    mesher.js               greedy + simple face-culled meshing
    nbt.js                  little-endian NBT read/write
    mcstructure.js          .mcstructure writer
    split.js                aligned chunking + placement guide
    zip.js                  ZIP writer, stored or deflated
    mcpack.js               behaviour pack wrapper
host/fieldcraft-export.js   drop-in export hook for host programs
tools/validate.mjs          the gates
tools/glrender.py           headless GL runner used by gate 6
examples/*.fieldbundle.json including one exported from a real Catoptron stack
```

## Pipeline

1. **Sample.** WebGL2 renders Z slices into a tiled atlas on one large
   framebuffer and reads back a slab at a time, not a slice at a time. Output is
   RGBA8: R is the inside flag, G the material id, B a normal-derived shade, A
   the depth below the surface in cells.
2. **Voxelise.** Slabs scatter into the sparse map as they arrive, so a 512³
   volume never exists in memory at once. Solid mode keeps everything inside;
   shell mode keeps cells whose depth is under the thickness. Depth living in
   the alpha channel is what lets shell thickness change without re-sampling.
3. **Mesh.** Merged face-culled quads for the preview.
4. **Export.** `.mcstructure`, or a `.mcpack` behaviour pack. Anything over the
   practical size splits into aligned chunks with a placement guide.

Default 256³, ceiling 512³. At 256³ the atlas is 2048×2048 with 64 slices per
slab; at 512³ it is 4096×4096 across eight slabs, which is the readback budget
rather than the texture limit talking.

Cell budget is hard, with no world bounds, as in IFScraft. Coordinates address
±65536 on every axis: 17 bits each, packed positionally into a Number that stays
a safe integer, so Map lookups stay on the integer fast path.

## Running it

Serve the directory — ES modules will not load from `file://`.

```
python3 -m http.server 8080
```

## Validation

```
node tools/validate.mjs
```

69 checks across seven gates:

1. **Bundle contract** — parsing, splicing, and the refusals.
2. **Slicing a host's assembled shader** — every uniform declaration shape that
   turned up in Catoptron 3D, plus the leftover guard.
3. **Shader assembly** — structure, plus real compilation through
   `glslangValidator` when it is on PATH, including a canary that references an
   undeclared uniform. If the canary ever compiles, the gate is broken.
4. **Tiling** — atlas layout, and slab scatter checked against index arithmetic
   written from scratch rather than reusing the encoder's.
5. **Voxelisation** — sphere volume against the analytic value, and the Menger
   sponge against its exact combinatorial cell count of 20^k on a 3^k grid.
6. **blockcore** — key round-trips, budget truncation, mesh surface area,
   outward winding by signed volume, `.mcstructure` round-trip including index
   ordering and palette interning, splitting losslessness, ZIP CRCs, deflate,
   and the `.mcpack` opened by an independent reader.
7. **Real GL** — the actual sampling shader rendered headlessly through
   Mesa/EGL and compared to the CPU oracles cell by cell.

Gates 3 and 7 skip with a notice when their tooling is absent:

```
apt-get install glslang-tools libegl1 libgl1-mesa-dri
pip install moderngl
```

The GL gate earned its place immediately. The Menger fold shipped with
`p * 3.0 - vec3(2.0, 2.0, 0.0)` instead of `vec3(2.0)`, which builds a different
solid — 12 cells at level 1 where the sponge has 20. The CPU gate could not see
it, because it feeds the membership oracle in directly and never touches GLSL.
The only thing that catches a wrong estimator is running the estimator.

Every gate has been checked for teeth by sabotage: flipped mesher winding,
swapped tile row and column, z-major structure indexing, corrupted ZIP CRCs, a
dropped scale division, and a swapped tile formula inside the shader. All six
were caught.

## Bedrock notes

Bedrock only. No `.schem`, no loose `.nbt`.

`.mcstructure` is uncompressed little-endian NBT. Index order is x-major then y
then z. `block_indices` holds two int lists and both must be the same length or
the game rejects the file; layer 1 is all -1. A -1 in layer 0 means the cell is
not written at all, so a structure drops into a world without clearing the
volume around it — `EMPTY_MODE.AIR` if you want the opposite.

Structures made with a structure block are capped at 64 × 384 × 64. Splitting
defaults to 64³ chunks aligned to a fixed lattice, so pieces butt up exactly
whatever the overall bounds are, and the placement guide lists every offset with
a ready-to-paste `/structure load` line.

The format stores one index per cell of the bounding box, with no run-length
encoding, so a sparse sculpture is mostly the -1 that means "no block": a
192³ build weighs 56 MB as raw structures whatever it actually contains. The
pack writer therefore deflates through the platform's own `CompressionStream`,
which takes that 56 MB to 131 KB. There is no dependency involved; it falls back
to storing where the API is missing.

Two values I could not verify and left configurable rather than guessed:

* The packed block `version` int in each palette entry defaults to 1.21.0.0
  (`0x01150000`). The four bytes are major.minor.patch.revision. Bedrock
  upgrades blocks stamped with an older version on load, so a conservative value
  is safe, but I do not know what 26.51 packs to.
* `min_engine_version` in the pack manifest defaults to `[1, 21, 0]`.

Block names default to the flattened form (`minecraft:white_concrete`), with the
pre-flattening form (`minecraft:concrete` plus a `color` state) available from
the same dropdown.

## Catoptron 3D

Confirmed working against build 0.57.3, headlessly, end to end.

* **Entry point:** `float mapT(vec3 p, out vec4 trap, out float safe)`. The
  division by the accumulated scale happens inside `mapTinner`, where `s` is a
  local, so `scaleParam` stays unset. `trapParam: "trap"` gives the orbit trap
  to the material expression, which is what turns a grey solid into something
  that reads. `map(vec3 p)` also works if you do not want the trap.
* **The export is a string slice.** `bundleFromProgram` cuts the assembled
  fragment shader at `void main(`, which is the same cut `tools/validate.py`
  already makes for the DE gate, strips the stage declarations, and reads the
  uniform values back off the live program.
* **95 of 97 uniforms travel.** The two that cannot are `sampler2D uImg` and
  `sampler3D uSdf`; the first is render-side only, the second means the flame
  voxel mode cannot be exported as a bundle, since its field *is* a texture.
* **Fold parameters live in the per-slot bank uniforms** (`uP0_0`, `uO0`, `uR0`),
  not in the baked source, which is exactly why reading them off the live
  program matters. With them at zero the box fold has limit zero, space
  collapses to the origin, and the volume comes back empty.

Measured on the factory "Folded frames" preset — octahedral fold 0.42, box fold
1.0, 8 iterations, box-frame primitive, box ±2 — at 192³ through llvmpipe:
75,656 cells in 1.1 s, six materials off the orbit trap, 298,678 merged quads
from 300,552 exposed faces, 27 pieces, 131 KB pack. The bundle ships as
`examples/catoptron-folded-frames.fieldbundle.json`.

## Out of scope for now

Colour-space palette matching and the stair/slab surface detailer. Both are
later passes over blockcore rather than changes to Fieldcraft, which is why the
palette sits behind a single `blockFor()` call and the shade byte is already
carried through the voxel value unused.

## License

MIT — see [LICENSE](LICENSE).
