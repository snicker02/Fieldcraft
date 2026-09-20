# Fieldcraft 0.1.0

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
    zip.js                  store-method ZIP
    mcpack.js               behaviour pack wrapper
host/fieldcraft-export.js   drop-in export hook for host programs
tools/validate.mjs          the gates
tools/glrender.py           headless GL runner used by gate 6
examples/*.fieldbundle.json
```

## Pipeline

1. **Sample.** WebGL2 renders Z slices into a tiled atlas on one large
   framebuffer and reads back a slab at a time, not a slice at a time. Output is
   RGBA8: R is the inside flag, G the material id, B a normal-derived shade, A
   the depth below the surface in cells.
2. **Voxelise.** Slabs scatter into the sparse map as they arrive, so a 512³
   volume never exists in memory at once. Solid mode keeps everything inside;
   shell mode keeps cells whose depth is under the thickness. Depth living in
   the alpha channel is what lets shell thickness change meaning without
   re-deriving it from geometry.
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

60 checks across six gates:

1. **Bundle contract** — parsing, splicing, and 17 specific refusals.
2. **Shader assembly** — structure, plus real compilation through
   `glslangValidator` when it is on PATH, including a canary that references an
   undeclared uniform. If the canary ever compiles, the gate is broken.
3. **Tiling** — atlas layout, and slab scatter checked against index arithmetic
   written from scratch rather than reusing the encoder's.
4. **Voxelisation** — sphere volume against the analytic value, and the Menger
   sponge against its exact combinatorial cell count of 20^k on a 3^k grid.
5. **blockcore** — key round-trips, budget truncation, mesh surface area,
   outward winding by signed volume, `.mcstructure` round-trip including index
   ordering and palette interning, splitting losslessness, ZIP CRCs, and the
   `.mcpack` opened by an independent reader.
6. **Real GL** — the actual sampling shader rendered headlessly through
   Mesa/EGL and compared to the CPU oracles cell by cell.

Gates 2 and 6 skip with a notice when their tooling is absent:

```
apt-get install glslang-tools libegl1 libgl1-mesa-dri
pip install moderngl
```

Gate 6 earned its place immediately. The Menger fold shipped with
`p * 3.0 - vec3(2.0, 2.0, 0.0)` instead of `vec3(2.0)`, which builds a different
solid — 12 cells at level 1 where the sponge has 20. Gate 4 could not see it,
because it feeds the membership oracle in directly and never touches GLSL. The
only thing that catches a wrong estimator is running the estimator.

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

Two values I could not verify and left configurable rather than guessed:

* The packed block `version` int in each palette entry defaults to 1.21.0.0
  (`0x01150000`). The four bytes are major.minor.patch.revision. Bedrock
  upgrades blocks stamped with an older version on load, so a conservative value
  is safe, but I do not know what 26.51 packs to.
* `min_engine_version` in the pack manifest defaults to `[1, 21, 0]`.

Block names default to the flattened form (`minecraft:white_concrete`), with the
pre-flattening form (`minecraft:concrete` plus a `color` state) available from
the same dropdown in case your version wants it.

## Out of scope for now

Colour-space palette matching and the stair/slab surface detailer. Both are
later passes over blockcore rather than changes to Fieldcraft, which is why the
palette sits behind a single `blockFor()` call and the shade byte is already
carried through the voxel value unused.

## Next

Catoptron 3D gets the export hook first — its DE-contract architecture already
isolates fields behind a known signature. The bundle format reads that signature
verbatim rather than imposing one, so wiring it up is a matter of handing
`makeFieldBundle` the assembled source and the real signature string.
