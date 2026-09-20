// blockcore/nbt.js
// Minimal little-endian NBT. Bedrock's .mcstructure is uncompressed LE NBT.
// No dependencies; writer plus a reader used by the validation harness to
// prove round-trips.

export const T = {
  END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6,
  BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12,
};

export const tByte = v => ({ t: T.BYTE, v });
export const tShort = v => ({ t: T.SHORT, v });
export const tInt = v => ({ t: T.INT, v });
export const tLong = v => ({ t: T.LONG, v: BigInt(v) });
export const tFloat = v => ({ t: T.FLOAT, v });
export const tDouble = v => ({ t: T.DOUBLE, v });
export const tString = v => ({ t: T.STRING, v: String(v) });
export const tByteArray = v => ({ t: T.BYTE_ARRAY, v });
export const tIntArray = v => ({ t: T.INT_ARRAY, v });
export const tList = (et, v) => ({ t: T.LIST, et, v });
export const tComp = v => ({ t: T.COMPOUND, v });

class Writer {
  constructor(initial = 1 << 16) {
    this.buf = new Uint8Array(initial);
    this.view = new DataView(this.buf.buffer);
    this.pos = 0;
  }
  need(n) {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.pos + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.pos));
    this.buf = nb;
    this.view = new DataView(nb.buffer);
  }
  u8(v) { this.need(1); this.view.setUint8(this.pos, v); this.pos += 1; }
  i8(v) { this.need(1); this.view.setInt8(this.pos, v); this.pos += 1; }
  i16(v) { this.need(2); this.view.setInt16(this.pos, v, true); this.pos += 2; }
  i32(v) { this.need(4); this.view.setInt32(this.pos, v, true); this.pos += 4; }
  i64(v) { this.need(8); this.view.setBigInt64(this.pos, BigInt(v), true); this.pos += 8; }
  f32(v) { this.need(4); this.view.setFloat32(this.pos, v, true); this.pos += 4; }
  f64(v) { this.need(8); this.view.setFloat64(this.pos, v, true); this.pos += 8; }
  str(s) {
    const bytes = new TextEncoder().encode(s);
    this.need(2 + bytes.length);
    this.view.setUint16(this.pos, bytes.length, true);
    this.pos += 2;
    this.buf.set(bytes, this.pos);
    this.pos += bytes.length;
  }
  bytes(arr) {
    this.need(arr.length);
    this.buf.set(arr, this.pos);
    this.pos += arr.length;
  }
  done() { return this.buf.slice(0, this.pos); }
}

function writePayload(w, tag) {
  switch (tag.t) {
    case T.BYTE: w.i8(tag.v); break;
    case T.SHORT: w.i16(tag.v); break;
    case T.INT: w.i32(tag.v); break;
    case T.LONG: w.i64(tag.v); break;
    case T.FLOAT: w.f32(tag.v); break;
    case T.DOUBLE: w.f64(tag.v); break;
    case T.STRING: w.str(tag.v); break;
    case T.BYTE_ARRAY:
      w.i32(tag.v.length);
      w.bytes(tag.v instanceof Uint8Array ? tag.v : Uint8Array.from(tag.v));
      break;
    case T.INT_ARRAY:
      w.i32(tag.v.length);
      for (let i = 0; i < tag.v.length; i++) w.i32(tag.v[i]);
      break;
    case T.LIST: {
      const n = tag.v.length;
      w.u8(n === 0 ? T.END : tag.et);
      w.i32(n);
      if (tag.et === T.INT) {
        for (let i = 0; i < n; i++) w.i32(tag.v[i]);
      } else {
        for (let i = 0; i < n; i++) {
          const item = tag.v[i];
          writePayload(w, item.t === undefined ? { t: tag.et, v: item } : item);
        }
      }
      break;
    }
    case T.COMPOUND: {
      for (const name of Object.keys(tag.v)) {
        const child = tag.v[name];
        w.u8(child.t);
        w.str(name);
        writePayload(w, child);
      }
      w.u8(T.END);
      break;
    }
    default:
      throw new Error(`Unsupported NBT tag type ${tag.t}`);
  }
}

/** @returns {Uint8Array} */
export function writeNBT(rootName, rootTag, initialBytes) {
  const w = new Writer(initialBytes);
  w.u8(rootTag.t);
  w.str(rootName);
  writePayload(w, rootTag);
  return w.done();
}

class Reader {
  constructor(bytes) {
    this.buf = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = 0;
    this.dec = new TextDecoder();
  }
  u8() { return this.view.getUint8(this.pos++); }
  i8() { return this.view.getInt8(this.pos++); }
  i16() { const v = this.view.getInt16(this.pos, true); this.pos += 2; return v; }
  i32() { const v = this.view.getInt32(this.pos, true); this.pos += 4; return v; }
  i64() { const v = this.view.getBigInt64(this.pos, true); this.pos += 8; return v; }
  f32() { const v = this.view.getFloat32(this.pos, true); this.pos += 4; return v; }
  f64() { const v = this.view.getFloat64(this.pos, true); this.pos += 8; return v; }
  str() {
    const n = this.view.getUint16(this.pos, true);
    this.pos += 2;
    const s = this.dec.decode(this.buf.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }
}

function readPayload(r, type) {
  switch (type) {
    case T.BYTE: return r.i8();
    case T.SHORT: return r.i16();
    case T.INT: return r.i32();
    case T.LONG: return r.i64();
    case T.FLOAT: return r.f32();
    case T.DOUBLE: return r.f64();
    case T.STRING: return r.str();
    case T.BYTE_ARRAY: {
      const n = r.i32();
      const a = r.buf.slice(r.pos, r.pos + n);
      r.pos += n;
      return a;
    }
    case T.INT_ARRAY: {
      const n = r.i32();
      const a = new Int32Array(n);
      for (let i = 0; i < n; i++) a[i] = r.i32();
      return a;
    }
    case T.LIST: {
      const et = r.u8();
      const n = r.i32();
      if (et === T.INT) {
        const a = new Int32Array(n);
        for (let i = 0; i < n; i++) a[i] = r.i32();
        return { __list: T.INT, items: a };
      }
      const items = [];
      for (let i = 0; i < n; i++) items.push(readPayload(r, et));
      return { __list: et, items };
    }
    case T.COMPOUND: {
      const obj = {};
      for (;;) {
        const t = r.u8();
        if (t === T.END) break;
        const name = r.str();
        obj[name] = readPayload(r, t);
      }
      return obj;
    }
    default:
      throw new Error(`Unsupported NBT tag type ${type} at ${r.pos}`);
  }
}

/** @returns {{name:string, value:any}} */
export function readNBT(bytes) {
  const r = new Reader(bytes);
  const t = r.u8();
  const name = r.str();
  return { name, type: t, value: readPayload(r, t) };
}
