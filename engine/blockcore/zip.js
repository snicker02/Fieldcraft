// blockcore/zip.js
// Minimal ZIP writer, no dependencies. .mcpack and .mcaddon are plain ZIPs.
//
// Two build paths. build() stores entries uncompressed and is synchronous.
// buildAsync() deflates through the platform's own CompressionStream, which
// exists in every current browser and in Node, and falls back to storing when
// it does not. That matters more than it sounds: a .mcstructure is a dense
// array of block indices with one entry per cell in the bounding box, and a
// sparse sculpture is mostly the -1 that means "no block". Those runs compress
// by two orders of magnitude, and the difference is a usable download rather
// than a 55 MB one.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export function deflateAvailable() {
  return typeof CompressionStream !== 'undefined' && typeof Response !== 'undefined';
}

async function deflateRaw(bytes) {
  if (!deflateAvailable()) return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

function dosTime(d) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

export class ZipWriter {
  constructor() {
    this.entries = [];
    this.date = new Date();
  }

  /** @param {string} path forward-slash separated. @param {Uint8Array|string} data */
  add(path, data) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    this.entries.push({
      name: new TextEncoder().encode(path.replace(/\\/g, '/')),
      bytes,
      crc: crc32(bytes),
    });
    return this;
  }

  /** Uncompressed. Synchronous. */
  build() {
    return this._assemble(this.entries.map(e => ({ ...e, method: 0, payload: e.bytes })));
  }

  /** Deflated where the platform allows and where it actually helps. */
  async buildAsync() {
    const prepared = [];
    for (const e of this.entries) {
      const packed = await deflateRaw(e.bytes);
      prepared.push(packed && packed.length < e.bytes.length
        ? { ...e, method: 8, payload: packed }
        : { ...e, method: 0, payload: e.bytes });
    }
    return this._assemble(prepared);
  }

  _assemble(prepared) {
    const { time, date } = dosTime(this.date);
    let total = 22;
    for (const e of prepared) total += 30 + e.name.length + e.payload.length + 46 + e.name.length;

    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    let p = 0;

    for (const e of prepared) {
      e.offset = p;
      view.setUint32(p, 0x04034b50, true); p += 4;
      view.setUint16(p, 20, true); p += 2;            // version needed
      view.setUint16(p, 0x0800, true); p += 2;        // flags: UTF-8 names
      view.setUint16(p, e.method, true); p += 2;
      view.setUint16(p, time, true); p += 2;
      view.setUint16(p, date, true); p += 2;
      view.setUint32(p, e.crc, true); p += 4;
      view.setUint32(p, e.payload.length, true); p += 4;
      view.setUint32(p, e.bytes.length, true); p += 4;
      view.setUint16(p, e.name.length, true); p += 2;
      view.setUint16(p, 0, true); p += 2;             // extra length
      out.set(e.name, p); p += e.name.length;
      out.set(e.payload, p); p += e.payload.length;
    }

    const cdStart = p;
    for (const e of prepared) {
      view.setUint32(p, 0x02014b50, true); p += 4;
      view.setUint16(p, 20, true); p += 2;            // version made by
      view.setUint16(p, 20, true); p += 2;            // version needed
      view.setUint16(p, 0x0800, true); p += 2;
      view.setUint16(p, e.method, true); p += 2;
      view.setUint16(p, time, true); p += 2;
      view.setUint16(p, date, true); p += 2;
      view.setUint32(p, e.crc, true); p += 4;
      view.setUint32(p, e.payload.length, true); p += 4;
      view.setUint32(p, e.bytes.length, true); p += 4;
      view.setUint16(p, e.name.length, true); p += 2;
      view.setUint16(p, 0, true); p += 2;             // extra
      view.setUint16(p, 0, true); p += 2;             // comment
      view.setUint16(p, 0, true); p += 2;             // disk
      view.setUint16(p, 0, true); p += 2;             // internal attrs
      view.setUint32(p, 0, true); p += 4;             // external attrs
      view.setUint32(p, e.offset, true); p += 4;
      out.set(e.name, p); p += e.name.length;
    }

    const cdEnd = p;
    view.setUint32(p, 0x06054b50, true); p += 4;
    view.setUint16(p, 0, true); p += 2;               // this disk
    view.setUint16(p, 0, true); p += 2;               // disk with cd
    view.setUint16(p, prepared.length, true); p += 2;
    view.setUint16(p, prepared.length, true); p += 2;
    view.setUint32(p, cdEnd - cdStart, true); p += 4;
    view.setUint32(p, cdStart, true); p += 4;
    view.setUint16(p, 0, true); p += 2;               // comment length

    return out.subarray(0, p);
  }
}
