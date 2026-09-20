// blockcore/zip.js
// Minimal ZIP writer, store method only (no compression, no dependencies).
// .mcpack and .mcaddon are plain ZIPs, and Minecraft reads stored entries fine.

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

  /** @returns {Uint8Array} */
  build() {
    const { time, date } = dosTime(this.date);
    let total = 0;
    for (const e of this.entries) total += 30 + e.name.length + e.bytes.length + 46 + e.name.length;
    total += 22;

    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    let p = 0;

    for (const e of this.entries) {
      e.offset = p;
      view.setUint32(p, 0x04034b50, true); p += 4;
      view.setUint16(p, 20, true); p += 2;          // version needed
      view.setUint16(p, 0x0800, true); p += 2;      // flags: UTF-8 names
      view.setUint16(p, 0, true); p += 2;           // method: store
      view.setUint16(p, time, true); p += 2;
      view.setUint16(p, date, true); p += 2;
      view.setUint32(p, e.crc, true); p += 4;
      view.setUint32(p, e.bytes.length, true); p += 4;
      view.setUint32(p, e.bytes.length, true); p += 4;
      view.setUint16(p, e.name.length, true); p += 2;
      view.setUint16(p, 0, true); p += 2;           // extra length
      out.set(e.name, p); p += e.name.length;
      out.set(e.bytes, p); p += e.bytes.length;
    }

    const cdStart = p;
    for (const e of this.entries) {
      view.setUint32(p, 0x02014b50, true); p += 4;
      view.setUint16(p, 20, true); p += 2;          // version made by
      view.setUint16(p, 20, true); p += 2;          // version needed
      view.setUint16(p, 0x0800, true); p += 2;
      view.setUint16(p, 0, true); p += 2;
      view.setUint16(p, time, true); p += 2;
      view.setUint16(p, date, true); p += 2;
      view.setUint32(p, e.crc, true); p += 4;
      view.setUint32(p, e.bytes.length, true); p += 4;
      view.setUint32(p, e.bytes.length, true); p += 4;
      view.setUint16(p, e.name.length, true); p += 2;
      view.setUint16(p, 0, true); p += 2;           // extra
      view.setUint16(p, 0, true); p += 2;           // comment
      view.setUint16(p, 0, true); p += 2;           // disk
      view.setUint16(p, 0, true); p += 2;           // internal attrs
      view.setUint32(p, 0, true); p += 4;           // external attrs
      view.setUint32(p, e.offset, true); p += 4;
      out.set(e.name, p); p += e.name.length;
    }

    const cdEnd = p;
    view.setUint32(p, 0x06054b50, true); p += 4;
    view.setUint16(p, 0, true); p += 2;           // this disk
    view.setUint16(p, 0, true); p += 2;           // disk with cd
    view.setUint16(p, this.entries.length, true); p += 2;
    view.setUint16(p, this.entries.length, true); p += 2;
    view.setUint32(p, cdEnd - cdStart, true); p += 4;
    view.setUint32(p, cdStart, true); p += 4;
    view.setUint16(p, 0, true); p += 2;           // comment length

    return out.subarray(0, p);
  }
}
