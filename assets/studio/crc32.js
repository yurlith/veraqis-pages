// VERAQIS Studio — incremental CRC-32 (ISO 3309 / ITU-T V.42, the ZIP polynomial).
//
// Deliberately a SECOND implementation, independent of the one in
// assets/zip-checker/zip-core.js. The two are cross-checked against each other
// and against Node's zlib on every test run, so a table typo in either is caught
// rather than silently agreeing with itself.
//
// This one is written for extraction: it consumes chunks, never concatenates,
// and holds no reference to the data it has seen.
//
// No DOM, no network, no storage.

/** Nibble-free byte table, built once. `>>> 0` keeps every value unsigned. */
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

/**
 * Fold `bytes` into a running CRC.
 * @param {number} crc previous value (0 to start)
 * @param {Uint8Array} bytes
 * @returns {number} unsigned 32-bit
 */
export function crc32Update(crc, bytes) {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    c = (TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** One-shot convenience over a single buffer. */
export function crc32(bytes) { return crc32Update(0, bytes); }

/**
 * Streaming accumulator.
 *
 * `new Crc32()` then `.update(chunk)` per chunk then `.value`. An instance that
 * never sees a byte reports 0, which is the correct CRC-32 of the empty string
 * and is exactly what a legitimate empty ZIP entry stores.
 */
export class Crc32 {
  constructor() { this._crc = 0; this._bytes = 0; }

  /** @param {Uint8Array} chunk */
  update(chunk) {
    if (!chunk || chunk.length === 0) return this;
    this._crc = crc32Update(this._crc, chunk);
    this._bytes += chunk.length;
    return this;
  }

  /** Unsigned 32-bit value. Never negative — a signed print is a real bug class. */
  get value() { return this._crc >>> 0; }

  /** How many bytes have been folded in. Used to cross-check the declared size. */
  get bytes() { return this._bytes; }

  reset() { this._crc = 0; this._bytes = 0; return this; }
}

/**
 * The single display form for a CRC anywhere in Studio: eight lowercase hex
 * digits, zero-padded. `(-559038737).toString(16)` is the bug this prevents.
 */
export function crcHex(value) {
  return (Number(value) >>> 0).toString(16).padStart(8, '0');
}
