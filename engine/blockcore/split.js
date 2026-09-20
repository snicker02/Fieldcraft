// blockcore/split.js
// Splits a grid into chunks aligned to a fixed lattice so the pieces always
// butt up exactly, whatever the overall bounds are. Emits a placement guide
// with the offsets and the /structure load lines.

import { VoxelGrid, unpackKey } from './voxels.js';
import { STRUCTURE_BLOCK_MAX } from './palette.js';

/** Default chunk: safely inside the structure-block limits on every axis. */
export const DEFAULT_CHUNK = [64, 64, 64];

function floorDiv(a, b) { return Math.floor(a / b); }

/**
 * @param {VoxelGrid} grid
 * @param {object} opts  chunk:[cx,cy,cz]
 * @returns {{chunks:Array, chunk:number[], origin:number[], size:number[]}}
 *   each chunk: { index, cell:[i,j,k], origin:[x,y,z] (world),
 *                 grid (local coords starting at 0), size:[sx,sy,sz], blocks }
 */
export function splitGrid(grid, opts = {}) {
  const chunk = opts.chunk || DEFAULT_CHUNK;
  for (let i = 0; i < 3; i++) {
    if (!Number.isInteger(chunk[i]) || chunk[i] < 1) throw new Error('Chunk dimensions must be positive integers');
    if (chunk[i] > STRUCTURE_BLOCK_MAX[i]) {
      throw new Error(`Chunk axis ${'xyz'[i]} of ${chunk[i]} exceeds the in-game structure limit of ${STRUCTURE_BLOCK_MAX[i]}`);
    }
  }

  const b = grid.bounds();
  if (!b) return { chunks: [], chunk, origin: [0, 0, 0], size: [0, 0, 0] };

  const buckets = new Map();
  const t = [0, 0, 0];
  for (const [key, value] of grid.cells) {
    unpackKey(key, t);
    const ci = floorDiv(t[0], chunk[0]);
    const cj = floorDiv(t[1], chunk[1]);
    const ck = floorDiv(t[2], chunk[2]);
    const bk = `${ci},${cj},${ck}`;
    let entry = buckets.get(bk);
    if (!entry) {
      entry = {
        cell: [ci, cj, ck],
        origin: [ci * chunk[0], cj * chunk[1], ck * chunk[2]],
        grid: new VoxelGrid(),
      };
      buckets.set(bk, entry);
    }
    entry.grid.set(t[0] - entry.origin[0], t[1] - entry.origin[1], t[2] - entry.origin[2], value);
  }

  const chunks = [...buckets.values()].sort((a, c) =>
    (a.cell[1] - c.cell[1]) || (a.cell[2] - c.cell[2]) || (a.cell[0] - c.cell[0]));

  chunks.forEach((c, i) => {
    c.index = i;
    const cb = c.grid.bounds();
    c.size = cb ? cb.size : [0, 0, 0];
    c.blocks = c.grid.size;
  });

  return { chunks, chunk, origin: b.min, size: b.size };
}

/**
 * Human-readable placement guide. Offsets are relative to the anchor block you
 * stand on; the command lines are ready to paste with the anchor substituted.
 */
export function placementGuide(split, opts = {}) {
  const namespace = opts.namespace || 'fieldcraft';
  const baseName = opts.baseName || 'field';
  const anchor = opts.anchor || ['~', '~', '~'];
  const lines = [];

  lines.push(`Fieldcraft placement guide`);
  lines.push(`==========================`);
  lines.push(``);
  lines.push(`Pieces:      ${split.chunks.length}`);
  lines.push(`Chunk size:  ${split.chunk.join(' x ')}`);
  lines.push(`Full bounds: ${split.size.join(' x ')} blocks`);
  lines.push(``);
  lines.push(`Stand where you want the lowest north-west corner of the whole build to be,`);
  lines.push(`then run the lines below in order. Offsets are relative to you (~), so you do`);
  lines.push(`not have to move. Each piece is already aligned; if they all load at the right`);
  lines.push(`offsets the seams are exact.`);
  lines.push(``);

  const [ox, oy, oz] = split.origin;
  for (const c of split.chunks) {
    const dx = c.origin[0] - ox;
    const dy = c.origin[1] - oy;
    const dz = c.origin[2] - oz;
    const name = `${baseName}_${String(c.index).padStart(3, '0')}`;
    lines.push(`# piece ${c.index + 1}/${split.chunks.length}  offset ${dx} ${dy} ${dz}  (${c.blocks.toLocaleString()} blocks)`);
    lines.push(`/structure load ${namespace}:${name} ${anchor[0]}${dx} ${anchor[1]}${dy} ${anchor[2]}${dz}`);
  }

  lines.push(``);
  lines.push(`If a piece reports as not found, check that the behaviour pack is active on the`);
  lines.push(`world and that you have reloaded it since installing.`);
  return lines.join('\n');
}
