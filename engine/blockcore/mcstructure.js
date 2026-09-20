// blockcore/mcstructure.js
// Writes Bedrock .mcstructure (uncompressed little-endian NBT).
//
// Layout notes that matter and are easy to get wrong:
//  * index order is x-major, then y, then z:  i = (x * sizeY + y) * sizeZ + z
//  * block_indices is a list of TWO int lists (layer 0 and layer 1) and both
//    must be the same length or the game rejects the file
//  * -1 in a layer means "leave whatever is already there", which is what you
//    want for a sculpture; layer 1 is all -1 unless you ask for water
//  * every block palette entry carries a packed game version int

import {
  writeNBT, tByte, tInt, tString, tList, tComp, T,
} from './nbt.js';
import { BlockPalette, blockKey, STRUCTURE_BLOCK_MAX } from './palette.js';
import { valueMaterial, valueShade } from './voxels.js';

/** Refuse to build anything past this many cells in a single file. */
export const MAX_CELLS_PER_FILE = 8_000_000;

export const EMPTY_MODE = {
  NONE: 'none',            // -1, non-destructive
  AIR: 'air',              // minecraft:air, clears the volume
  STRUCTURE_VOID: 'void',  // minecraft:structure_void
};

/**
 * @param {VoxelGrid} grid
 * @param {object} opts
 *   palette       BlockPalette (default: new BlockPalette())
 *   bounds        {min,max,size} to force a volume; default grid.bounds()
 *   worldOrigin   [x,y,z] written into structure_world_origin (default 0,0,0)
 *   empty         EMPTY_MODE.* (default NONE)
 * @returns {{bytes:Uint8Array, size:number[], origin:number[], blocks:number,
 *            paletteEntries:object[], oversize:boolean}}
 */
export function buildMcStructure(grid, opts = {}) {
  const palette = opts.palette || new BlockPalette();
  const b = opts.bounds || grid.bounds();
  if (!b) throw new Error('Nothing to export: the grid is empty');

  const [sx, sy, sz] = b.size;
  const total = sx * sy * sz;
  if (total > MAX_CELLS_PER_FILE) {
    throw new Error(
      `Volume ${sx}x${sy}x${sz} is ${total.toLocaleString()} cells, over the ` +
      `${MAX_CELLS_PER_FILE.toLocaleString()} per-file limit. Split it first.`);
  }

  const entries = [];      // [{name, states}]
  const entryIndex = new Map();
  const internBlock = (block) => {
    const k = blockKey(block);
    let i = entryIndex.get(k);
    if (i === undefined) {
      i = entries.length;
      entryIndex.set(k, i);
      entries.push(block);
    }
    return i;
  };

  let emptyIndex = -1;
  if (opts.empty === EMPTY_MODE.AIR) {
    emptyIndex = internBlock({ name: 'minecraft:air', states: {} });
  } else if (opts.empty === EMPTY_MODE.STRUCTURE_VOID) {
    emptyIndex = internBlock({ name: 'minecraft:structure_void', states: {} });
  }

  const layer0 = new Int32Array(total).fill(emptyIndex);
  const layer1 = new Int32Array(total).fill(-1);

  const [ox, oy, oz] = b.min;
  let blocks = 0;
  grid.forEach((x, y, z, v) => {
    const lx = x - ox, ly = y - oy, lz = z - oz;
    if (lx < 0 || ly < 0 || lz < 0 || lx >= sx || ly >= sy || lz >= sz) return;
    const block = palette.blockFor(valueMaterial(v), valueShade(v));
    layer0[(lx * sy + ly) * sz + lz] = internBlock(block);
    blocks++;
  });

  const blockPalette = entries.map(e => {
    const states = {};
    for (const k of Object.keys(e.states).sort()) {
      const sv = e.states[k];
      states[k] = typeof sv === 'number' ? tInt(sv)
        : typeof sv === 'boolean' ? tByte(sv ? 1 : 0)
        : tString(sv);
    }
    return tComp({
      name: tString(e.name),
      states: tComp(states),
      version: tInt(palette.blockVersion),
    });
  });

  const worldOrigin = opts.worldOrigin || [0, 0, 0];

  const root = tComp({
    format_version: tInt(1),
    size: tList(T.INT, [sx, sy, sz]),
    structure: tComp({
      block_indices: tList(T.LIST, [
        { t: T.LIST, et: T.INT, v: layer0 },
        { t: T.LIST, et: T.INT, v: layer1 },
      ]),
      entities: tList(T.COMPOUND, []),
      palette: tComp({
        default: tComp({
          block_palette: tList(T.COMPOUND, blockPalette),
          block_position_data: tComp({}),
        }),
      }),
    }),
    structure_world_origin: tList(T.INT, worldOrigin.map(v => v | 0)),
  });

  const bytes = writeNBT('', root, Math.max(1 << 16, total * 9));

  return {
    bytes,
    size: [sx, sy, sz],
    origin: [ox, oy, oz],
    blocks,
    paletteEntries: entries,
    oversize: sx > STRUCTURE_BLOCK_MAX[0] || sy > STRUCTURE_BLOCK_MAX[1] || sz > STRUCTURE_BLOCK_MAX[2],
  };
}
