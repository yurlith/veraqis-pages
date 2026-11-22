// Minimal ZIP writer for "Download all": entries are stored (not compressed),
// names are UTF-8, and every entry carries its CRC-32 so any unzip tool can
// check the bytes. Plain ZIP only, so the total must stay under 4 GiB and
// 65,535 entries; beyond that the page offers the files one by one instead.

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** files: [{ name, bytes: Uint8Array }] → Blob (application/zip). */
export function buildZip(files, now = new Date()) {
  if (files.length > 0xffff) throw new Error('Too many files for one ZIP; download them one by one.');
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(now);
  const body = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const size = f.bytes.length;
    if (size >= 0xffffffff || offset + 30 + name.length + size >= 0xffffffff) {
      throw new Error('These files add up to more than 4 GiB; download them one by one.');
    }
    const crc = crc32(f.bytes);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // names are UTF-8
    lh.setUint16(8, 0, true);      // stored
    lh.setUint16(10, time, true);
    lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true);
    lh.setUint32(22, size, true);
    lh.setUint16(26, name.length, true);
    body.push(new Uint8Array(lh.buffer), name, f.bytes);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true);
    ch.setUint16(14, date, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true);
    ch.setUint32(24, size, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...body, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}
