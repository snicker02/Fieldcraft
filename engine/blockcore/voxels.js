// blockcore/voxels.js
// Sparse voxel storage. Map<packedKey, packedValue>.
//
// Key packing: 17 bits per axis, biased, base-131072 positional.
//   max key = 131072^3 - 1 = 2^51 - 1  -> exactly representable as a Number,
//   so Map lookups stay on the integer fast path and no BigInt is involved.
// Coordinate range: -65536 .. 65535 on every axis. There are no world bounds;
// growth is limited by the cell budget, exactly like IFScraft.
//
// Value packing: material id in bits 0..7, shade in bits 8..15.

export const AXIS_BITS = 17;
export const AXIS_SPAN = 1 << AXIS_BITS;      // 131072
export const AXIS_BIAS = AXIS_SPAN >> 1;      // 65536
export const AXIS_MIN = -AXIS_BIAS;
export const AXIS_MAX = AXIS_BIAS - 1;

export class BudgetExceededError extends Error {
  constructor(budget) {
    super(`Cell budget of ${budget.toLocaleString()} cells reached`);
    this.name = 'BudgetExceededError';
    this.budget = budget;
  }
}

export function inRange(x, y, z) {
  return x >= AXIS_MIN && x <= AXIS_MAX &&
         y >= AXIS_MIN && y <= AXIS_MAX &&
         z >= AXIS_MIN && z <= AXIS_MAX;
}

export function packKey(x, y, z) {
  const bx = x + AXIS_BIAS, by = y + AXIS_BIAS, bz = z + AXIS_BIAS;
  return (bx * AXIS_SPAN + by) * AXIS_SPAN + bz;
}

export function unpackKey(key, out) {
  const o = out || [0, 0, 0];
  const bz = key % AXIS_SPAN;
  const r = (key - bz) / AXIS_SPAN;
  const by = r % AXIS_SPAN;
  const bx = (r - by) / AXIS_SPAN;
  o[0] = bx - AXIS_BIAS;
  o[1] = by - AXIS_BIAS;
  o[2] = bz - AXIS_BIAS;
  return o;
}

export function packValue(material, shade) {
  return ((shade & 0xff) << 8) | (material & 0xff);
}
export function valueMaterial(v) { return v & 0xff; }
export function valueShade(v) { return (v >> 8) & 0xff; }

export class VoxelGrid {
  constructor(opts = {}) {
    this.cells = new Map();
    this.budget = opts.budget === undefined ? Infinity : opts.budget;
    this.truncated = false;          // set once the budget stopped a write
    this._tmp = [0, 0, 0];
  }

  get size() { return this.cells.size; }

  /** Returns true if the cell was stored, false if the budget refused it. */
  set(x, y, z, value) {
    if (!inRange(x, y, z)) return false;
    const key = packKey(x, y, z);
    if (!this.cells.has(key) && this.cells.size >= this.budget) {
      this.truncated = true;
      return false;
    }
    this.cells.set(key, value);
    return true;
  }

  /** Same as set() but throws instead of silently truncating. */
  setStrict(x, y, z, value) {
    if (!this.set(x, y, z, value)) {
      if (this.truncated) throw new BudgetExceededError(this.budget);
      throw new RangeError(`Cell ${x},${y},${z} is outside the addressable range`);
    }
    return true;
  }

  get(x, y, z) {
    if (!inRange(x, y, z)) return undefined;
    return this.cells.get(packKey(x, y, z));
  }

  has(x, y, z) {
    return inRange(x, y, z) && this.cells.has(packKey(x, y, z));
  }

  delete(x, y, z) {
    if (!inRange(x, y, z)) return false;
    return this.cells.delete(packKey(x, y, z));
  }

  clear() { this.cells.clear(); this.truncated = false; }

  /** cb(x, y, z, value) */
  forEach(cb) {
    const t = this._tmp;
    for (const [key, value] of this.cells) {
      unpackKey(key, t);
      cb(t[0], t[1], t[2], value);
    }
  }

  /** { min:[x,y,z], max:[x,y,z], size:[sx,sy,sz] } or null when empty. */
  bounds() {
    if (this.cells.size === 0) return null;
    let nx = Infinity, ny = Infinity, nz = Infinity;
    let mx = -Infinity, my = -Infinity, mz = -Infinity;
    const t = this._tmp;
    for (const key of this.cells.keys()) {
      unpackKey(key, t);
      if (t[0] < nx) nx = t[0];
      if (t[1] < ny) ny = t[1];
      if (t[2] < nz) nz = t[2];
      if (t[0] > mx) mx = t[0];
      if (t[1] > my) my = t[1];
      if (t[2] > mz) mz = t[2];
    }
    return {
      min: [nx, ny, nz],
      max: [mx, my, mz],
      size: [mx - nx + 1, my - ny + 1, mz - nz + 1],
    };
  }

  /** Histogram of material id -> cell count. */
  materialHistogram() {
    const h = new Map();
    for (const v of this.cells.values()) {
      const m = valueMaterial(v);
      h.set(m, (h.get(m) || 0) + 1);
    }
    return h;
  }

  translated(dx, dy, dz) {
    const g = new VoxelGrid({ budget: this.budget });
    const t = this._tmp;
    for (const [key, value] of this.cells) {
      unpackKey(key, t);
      g.set(t[0] + dx, t[1] + dy, t[2] + dz, value);
    }
    return g;
  }

  clone() { return this.translated(0, 0, 0); }
}
