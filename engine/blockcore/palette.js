// blockcore/palette.js
// Small fixed material palette. Material ids 0..15 come out of a field
// bundle's material expression; this maps them to Bedrock blocks.
//
// Sophisticated colour-space matching is deliberately out of scope here —
// this is an explicit table plus an id remap, and the later matcher will
// slot in behind the same blockFor() call.

/**
 * The packed "version" int in a block palette entry encodes the game version
 * the block permutation was written for: bytes are major.minor.patch.revision,
 * e.g. 1.16.210.03 -> 0x0110D203. Bedrock upgrades blocks written with an
 * older version on load, so a conservative value is the safe default.
 * Override via new BlockPalette({ blockVersion }) if you want to stamp the
 * exact build you are playing.
 */
export const BLOCK_VERSION_1_21_0 = 0x01150000; // 18153472
export const DEFAULT_BLOCK_VERSION = BLOCK_VERSION_1_21_0;

/** Hard limits the game itself applies to structures made with a structure block. */
export const STRUCTURE_BLOCK_MAX = [64, 384, 64];

const C = (color, rgb, label) => ({
  label,
  flat: `minecraft:${color}_concrete`,
  legacy: { name: 'minecraft:concrete', states: { color } },
  rgb,
});

/** Material id -> block. Index in this array IS the material id. */
export const MATERIALS = [
  C('white',      [0xcf, 0xd5, 0xd6], 'White'),
  C('light_gray', [0x7d, 0x7d, 0x73], 'Light gray'),
  C('gray',       [0x36, 0x39, 0x3d], 'Gray'),
  C('black',      [0x08, 0x0a, 0x0f], 'Black'),
  C('red',        [0x8e, 0x21, 0x1b], 'Red'),
  C('orange',     [0xe0, 0x6c, 0x0c], 'Orange'),
  C('yellow',     [0xf0, 0xaf, 0x15], 'Yellow'),
  C('lime',       [0x5e, 0xa9, 0x18], 'Lime'),
  C('green',      [0x49, 0x5b, 0x24], 'Green'),
  C('cyan',       [0x15, 0x74, 0x87], 'Cyan'),
  C('light_blue', [0x2c, 0x8e, 0xd1], 'Light blue'),
  C('blue',       [0x2c, 0x2e, 0x8f], 'Blue'),
  C('purple',     [0x64, 0x21, 0x9d], 'Purple'),
  C('magenta',    [0xa9, 0x2c, 0xb8], 'Magenta'),
  C('brown',      [0x60, 0x3c, 0x20], 'Brown'),
  C('pink',       [0xd5, 0x65, 0x8f], 'Pink'),
];

export const MATERIAL_COUNT = MATERIALS.length;

export class BlockPalette {
  /**
   * @param {object} opts
   *  flattened     use minecraft:<color>_concrete names (default true).
   *                Set false for the pre-flattening minecraft:concrete[color=] form.
   *  blockVersion  packed version int stamped on every palette entry.
   *  remap         optional Int array or Map: bundle material id -> palette material id.
   */
  constructor(opts = {}) {
    this.flattened = opts.flattened !== false;
    this.blockVersion = opts.blockVersion || DEFAULT_BLOCK_VERSION;
    this.remap = opts.remap || null;
  }

  /** Resolve a bundle material id through the remap into a palette material id. */
  resolve(materialId) {
    let id = materialId | 0;
    if (this.remap) {
      const r = Array.isArray(this.remap) ? this.remap[id] : this.remap.get(id);
      if (r !== undefined && r !== null) id = r | 0;
    }
    if (id < 0) id = 0;
    return id % MATERIAL_COUNT;
  }

  /** @returns {{name:string, states:object}} */
  blockFor(materialId /*, shade */) {
    const m = MATERIALS[this.resolve(materialId)];
    return this.flattened
      ? { name: m.flat, states: {} }
      : { name: m.legacy.name, states: { ...m.legacy.states } };
  }

  rgbFor(materialId) { return MATERIALS[this.resolve(materialId)].rgb; }
  labelFor(materialId) { return MATERIALS[this.resolve(materialId)].label; }
}

/** Stable interning key for a resolved block. */
export function blockKey(block) {
  const keys = Object.keys(block.states).sort();
  let s = block.name;
  for (const k of keys) s += `|${k}=${block.states[k]}`;
  return s;
}
