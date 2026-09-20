// blockcore/mesher.js
// Face-culled surface mesher. Two paths with identical output semantics:
//   greedy  - slice sweep with rectangle merging, O(bounding volume)
//   simple  - per-cell neighbour test, O(cells), used when the bounding box is
//             far larger than the cell count or the volume gets huge
// Both emit merged quads as two triangles with flat per-quad colour.

import { VoxelGrid, valueMaterial } from './voxels.js';
import { BlockPalette } from './palette.js';

const DIRS = [
  // [axis, sign, normal]
  [0, +1, [1, 0, 0]], [0, -1, [-1, 0, 0]],
  [1, +1, [0, 1, 0]], [1, -1, [0, -1, 0]],
  [2, +1, [0, 0, 1]], [2, -1, [0, 0, -1]],
];

/** Volume above which the greedy sweep is not worth its allocation. */
export const GREEDY_VOLUME_LIMIT = 64 * 1024 * 1024;

class MeshBuilder {
  constructor(palette, shadeStrength) {
    this.pos = [];
    this.nrm = [];
    this.col = [];
    this.idx = [];
    this.quads = 0;
    this.palette = palette;
    this.shadeStrength = shadeStrength;
  }
  quad(a, b, c, d, n, material, shade) {
    const base = this.pos.length / 3;
    for (const v of [a, b, c, d]) this.pos.push(v[0], v[1], v[2]);
    for (let i = 0; i < 4; i++) this.nrm.push(n[0], n[1], n[2]);
    const rgb = this.palette.rgbFor(material);
    const s = 1 - this.shadeStrength + this.shadeStrength * (shade / 255);
    for (let i = 0; i < 4; i++) this.col.push((rgb[0] / 255) * s, (rgb[1] / 255) * s, (rgb[2] / 255) * s);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    this.quads++;
  }
  finish() {
    return {
      positions: new Float32Array(this.pos),
      normals: new Float32Array(this.nrm),
      colors: new Float32Array(this.col),
      indices: this.idx.length > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx),
      indexType: this.idx.length > 65535 ? 'uint32' : 'uint16',
      quadCount: this.quads,
      triangleCount: this.idx.length / 3,
      vertexCount: this.pos.length / 3,
    };
  }
}

function cornersFor(axis, sign, p, du, dv) {
  // p is the min corner of the quad in cell units; du/dv are the extents in
  // the two tangent axes. Vertices are wound so the face points along +sign.
  const u = (axis + 1) % 3, v = (axis + 2) % 3;
  const mk = (a, b) => {
    const o = [p[0], p[1], p[2]];
    o[u] += a;
    o[v] += b;
    if (sign > 0) o[axis] += 1;
    return o;
  };
  const quad = [mk(0, 0), mk(du, 0), mk(du, dv), mk(0, dv)];
  return sign > 0 ? quad : [quad[0], quad[3], quad[2], quad[1]];
}

function meshSimple(grid, mb) {
  grid.forEach((x, y, z, value) => {
    const material = valueMaterial(value);
    const shade = (value >> 8) & 0xff;
    for (const [axis, sign] of DIRS) {
      const nx = x + (axis === 0 ? sign : 0);
      const ny = y + (axis === 1 ? sign : 0);
      const nz = z + (axis === 2 ? sign : 0);
      if (grid.has(nx, ny, nz)) continue;
      const n = [0, 0, 0]; n[axis] = sign;
      const c = cornersFor(axis, sign, [x, y, z], 1, 1);
      mb.quad(c[0], c[1], c[2], c[3], n, material, shade);
    }
  });
}

function meshGreedy(grid, bounds, mb) {
  const [minx, miny, minz] = bounds.min;
  const dims = bounds.size;

  for (const [axis, sign] of DIRS) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    const du = dims[u], dv = dims[v];
    const mask = new Int32Array(du * dv);
    const mins = [minx, miny, minz];
    const p = [0, 0, 0];

    for (let w = 0; w < dims[axis]; w++) {
      mask.fill(0);
      let any = false;
      for (let b = 0; b < dv; b++) {
        for (let a = 0; a < du; a++) {
          p[axis] = mins[axis] + w;
          p[u] = mins[u] + a;
          p[v] = mins[v] + b;
          const here = grid.get(p[0], p[1], p[2]);
          if (here === undefined) continue;
          p[axis] += sign;
          if (grid.get(p[0], p[1], p[2]) !== undefined) continue;
          // +1 so that a zero value (material 0, shade 0) is still "present"
          mask[b * du + a] = here + 1;
          any = true;
        }
      }
      if (!any) continue;

      for (let b = 0; b < dv; b++) {
        for (let a = 0; a < du;) {
          const m = mask[b * du + a];
          if (m === 0) { a++; continue; }
          let wq = 1;
          while (a + wq < du && mask[b * du + a + wq] === m) wq++;
          let hq = 1;
          grow: while (b + hq < dv) {
            for (let k = 0; k < wq; k++) {
              if (mask[(b + hq) * du + a + k] !== m) break grow;
            }
            hq++;
          }
          const value = m - 1;
          const n = [0, 0, 0]; n[axis] = sign;
          const corner = [0, 0, 0];
          corner[axis] = mins[axis] + w;
          corner[u] = mins[u] + a;
          corner[v] = mins[v] + b;
          const c = cornersFor(axis, sign, corner, wq, hq);
          mb.quad(c[0], c[1], c[2], c[3], n, valueMaterial(value), (value >> 8) & 0xff);

          for (let j = 0; j < hq; j++) for (let i = 0; i < wq; i++) mask[(b + j) * du + a + i] = 0;
          a += wq;
        }
      }
    }
  }
}

/**
 * @param {VoxelGrid} grid
 * @param {object} opts  palette, greedy ('auto'|true|false), shadeStrength 0..1
 * @returns mesh arrays plus quadCount
 */
export function meshGrid(grid, opts = {}) {
  const palette = opts.palette || new BlockPalette();
  const mb = new MeshBuilder(palette, opts.shadeStrength === undefined ? 0.45 : opts.shadeStrength);
  const bounds = grid.bounds();
  if (!bounds) return mb.finish();

  const volume = bounds.size[0] * bounds.size[1] * bounds.size[2];
  let greedy = opts.greedy === undefined ? 'auto' : opts.greedy;
  if (greedy === 'auto') greedy = volume <= GREEDY_VOLUME_LIMIT && volume <= grid.size * 512;

  if (greedy) meshGreedy(grid, bounds, mb);
  else meshSimple(grid, mb);
  return mb.finish();
}

/** Exposed faces without building geometry. Used as a validation oracle. */
export function countExposedFaces(grid) {
  let n = 0;
  grid.forEach((x, y, z) => {
    for (const [axis, sign] of DIRS) {
      const nx = x + (axis === 0 ? sign : 0);
      const ny = y + (axis === 1 ? sign : 0);
      const nz = z + (axis === 2 ? sign : 0);
      if (!grid.has(nx, ny, nz)) n++;
    }
  });
  return n;
}
