// engine/voxelize.js
// Atlas layout maths, and the conversion from a read-back RGBA8 slab into
// sparse cells. Kept free of any GL so the tiling arithmetic — which is where
// the bugs live — can be tested headless against synthetic slabs.
//
// Pixel encoding produced by the sampling shader:
//   R  255 when the sample is inside the surface (d <= 0), else 0
//   G  material id from the bundle's material expression, 0..255
//   B  normal-derived shade, 0..255
//   A  depth below the surface in cells, floor(-d / cell), clamped to 255
//
// Depth in A is what makes shell thickness adjustable without re-sampling.

import { packValue } from './blockcore/voxels.js';

export const MODE = { SOLID: 'solid', SHELL: 'shell' };

/**
 * Work out how many Z slices fit into one framebuffer pass.
 * @param {number[]} res [rx, ry, rz]
 * @param {object} limits maxTexture (GL_MAX_TEXTURE_SIZE), maxPixels budget
 */
export function computeAtlasLayout(res, limits = {}) {
  const [rx, ry, rz] = res;
  const maxTexture = limits.maxTexture || 8192;
  const maxPixels = limits.maxPixels || 16 * 1024 * 1024; // 64 MB at RGBA8

  if (rx > maxTexture || ry > maxTexture) {
    throw new Error(`Resolution ${rx}x${ry} exceeds the maximum texture size of ${maxTexture}`);
  }

  let tilesX = Math.max(1, Math.floor(maxTexture / rx));
  let tilesY = Math.max(1, Math.floor(maxTexture / ry));
  // Respect the readback budget as well as the texture limit.
  while (tilesX * tilesY > 1 && tilesX * rx * tilesY * ry > maxPixels) {
    if (tilesY >= tilesX && tilesY > 1) tilesY--;
    else if (tilesX > 1) tilesX--;
    else break;
  }
  const perSlab = Math.min(tilesX * tilesY, rz);
  // Shrink the atlas to the tiles actually used when one slab covers everything.
  if (perSlab < tilesX * tilesY) {
    tilesY = Math.max(1, Math.ceil(perSlab / tilesX));
    if (perSlab < tilesX) tilesX = perSlab;
  }

  const slabs = [];
  for (let z = 0; z < rz; z += perSlab) {
    slabs.push({ zStart: z, zCount: Math.min(perSlab, rz - z) });
  }

  return {
    res: [rx, ry, rz],
    tileW: rx, tileH: ry,
    tilesX, tilesY,
    atlasW: tilesX * rx,
    atlasH: tilesY * ry,
    perSlab,
    slabs,
    bytes: tilesX * rx * tilesY * ry * 4,
  };
}

/**
 * Scatter one read-back slab into the grid.
 * readPixels hands back rows bottom-up, and the shader derives its tile from
 * gl_FragCoord (also bottom-up), so row index maps straight to tile row.
 *
 * @param {VoxelGrid} grid
 * @param {Uint8Array} pixels  atlasW * atlasH * 4
 * @param {object} layout      from computeAtlasLayout
 * @param {object} slab        { zStart, zCount }
 * @param {object} opts        mode, shellThickness, remap, origin, minMaterial
 * @returns {{added:number, inside:number, truncated:boolean}}
 */
export function voxelizeSlab(grid, pixels, layout, slab, opts = {}) {
  const mode = opts.mode || MODE.SOLID;
  const thickness = Math.max(1, Math.round(opts.shellThickness || 1));
  const remap = opts.remap || null;
  const [ox, oy, oz] = opts.origin || [0, 0, 0];
  const { tileW, tileH, tilesX, atlasW } = layout;

  let added = 0, inside = 0;

  for (let t = 0; t < slab.zCount; t++) {
    const tileRow = (t / tilesX) | 0;
    const tileCol = t % tilesX;
    const z = slab.zStart + t;
    const rowBase = tileRow * tileH;
    const colBase = tileCol * tileW;

    for (let y = 0; y < tileH; y++) {
      let p = ((rowBase + y) * atlasW + colBase) * 4;
      for (let x = 0; x < tileW; x++, p += 4) {
        if (pixels[p] === 0) continue;
        inside++;
        if (mode === MODE.SHELL && pixels[p + 3] >= thickness) continue;
        let material = pixels[p + 1];
        if (remap) {
          const r = Array.isArray(remap) ? remap[material] : remap.get(material);
          if (r !== undefined && r !== null) material = r;
        }
        if (grid.set(x + ox, y + oy, z + oz, packValue(material, pixels[p + 2]))) added++;
      }
    }
  }

  return { added, inside, truncated: grid.truncated };
}

/**
 * Same encoding, produced on the CPU. Used by the validation harness and as a
 * fallback path; the shader and this function must agree on the encoding.
 * @param {function} field  (x,y,z) -> signed distance in bundle space
 */
export function encodeSliceCPU(out, layout, slab, bounds, field, opts = {}) {
  const { tileW, tileH, tilesX, atlasW } = layout;
  const [rx, ry, rz] = layout.res;
  const iso = opts.isoOffset || 0;
  const materialFn = opts.material || (() => 0);
  const sx = (bounds.max[0] - bounds.min[0]) / rx;
  const sy = (bounds.max[1] - bounds.min[1]) / ry;
  const sz = (bounds.max[2] - bounds.min[2]) / rz;
  const cell = Math.max(sx, sy, sz);

  for (let t = 0; t < slab.zCount; t++) {
    const tileRow = (t / tilesX) | 0;
    const tileCol = t % tilesX;
    const z = slab.zStart + t;
    const wz = bounds.min[2] + (z + 0.5) * sz;
    for (let y = 0; y < tileH; y++) {
      const wy = bounds.min[1] + (y + 0.5) * sy;
      let p = (((tileRow * tileH) + y) * atlasW + tileCol * tileW) * 4;
      for (let x = 0; x < tileW; x++, p += 4) {
        const wx = bounds.min[0] + (x + 0.5) * sx;
        const d = field(wx, wy, wz) - iso;
        const insideHere = d <= 0;
        out[p] = insideHere ? 255 : 0;
        out[p + 1] = insideHere ? (materialFn(wx, wy, wz) & 0xff) : 0;
        out[p + 2] = 128;
        out[p + 3] = insideHere ? Math.min(255, Math.floor(-d / cell)) : 0;
      }
    }
  }
  return out;
}
