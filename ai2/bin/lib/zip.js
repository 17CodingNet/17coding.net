/**
 * Minimal ZIP container reader/writer for APK rewriting, browser-safe ESM.
 *
 * Untouched entries keep their *original compressed bytes*, so rewriting a 10 MB
 * APK is a memcpy per entry and never recompresses or changes the payload. Entries
 * we replace are written uncompressed (method 0): legal for an APK, and it lets this
 * module stay free of a deflate implementation. Alignment is left to a separate step.
 *
 * Content we generate from scratch - the APK export's payload.zip - goes through
 * {@link createZip}, which shares the serializer with {@link writeZip}.
 *
 * Zip64 is deliberately not supported: it throws instead of writing something wrong.
 */

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function putU16(b, o, v) { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; }
function putU32(b, o, v) { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff; }

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function readZip(bytes) {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 0xffff; i--) {
    if (u32(bytes, i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip: no end of central directory record');
  const entryCount = u16(bytes, eocd + 10);
  const cdOffset = u32(bytes, eocd + 16);
  if (entryCount === 0xffff || cdOffset === 0xffffffff) throw new Error('zip64 archives are not supported');

  const entries = [];
  const decoder = new TextDecoder('utf-8');
  let p = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (u32(bytes, p) !== CD_SIG) throw new Error(`bad central directory record at ${p}`);
    const flags = u16(bytes, p + 8);
    const method = u16(bytes, p + 10);
    const crc = u32(bytes, p + 16);
    const csize = u32(bytes, p + 20);
    const usize = u32(bytes, p + 24);
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    const localOffset = u32(bytes, p + 42);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, flags, method, crc, csize, usize, localOffset, extra: bytes.slice(p + 46 + nameLen, p + 46 + nameLen + extraLen) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  for (const e of entries) {
    if (u32(bytes, e.localOffset) !== LFH_SIG) throw new Error(`bad local header for ${e.name}`);
    const nameLen = u16(bytes, e.localOffset + 26);
    const extraLen = u16(bytes, e.localOffset + 28);
    e.dataOffset = e.localOffset + 30 + nameLen + extraLen;
    e.data = bytes.slice(e.dataOffset, e.dataOffset + e.csize);
    e.localExtra = bytes.slice(e.localOffset + 30 + nameLen, e.localOffset + 30 + nameLen + extraLen);
  }
  return { entries, comment: bytes.slice(eocd + 22) };
}

/**
 * Give every *stored* entry a zipalign padding record (id 0xd935, version 1 followed by zeros)
 * so that its data starts on an `align` boundary - the same thing the zipalign tool does, which
 * is why `zipalign -c` accepts the result. Deflated entries are left alone: their payload is
 * never read from the file at the aligned offset.
 *
 * The running offset matters, so this walks the plan in order: 30 bytes of local header, then
 * the name, then the extra field.
 */
function alignEntries(plan, align) {
  const encoder = new TextEncoder();
  let at = 0;
  for (const e of plan) {
    const nameLength = encoder.encode(e.name).length;
    if (align && e.method === 0) {
      const record = 4 + 2;                                 // id, size, version
      const need = (align - ((at + 30 + nameLength + record) % align)) % align;
      const extra = new Uint8Array(record + need);
      putU16(extra, 0, 0xd935);
      putU16(extra, 2, 2 + need);                           // size = version + padding
      putU16(extra, 4, 1);                                  // zipalign record version
      e.extra = extra;
    }
    at += 30 + nameLength + e.extra.length + e.data.length;
  }
  return plan;
}

/** Emit the local headers, the central directory and the end-of-central-directory record. */
function serializeArchive(plan, comment) {
  const encoder = new TextEncoder();
  let size = 0;
  for (const e of plan) size += 30 + encoder.encode(e.name).length + e.extra.length + e.data.length;
  const cdSize = plan.reduce((n, e) => n + 46 + encoder.encode(e.name).length + e.extra.length, 0);
  const out = new Uint8Array(size + cdSize + 22 + comment.length);
  let off = 0;
  const localOffsets = [];
  for (const e of plan) {
    const name = encoder.encode(e.name);
    localOffsets.push(off);
    putU32(out, off, LFH_SIG);
    putU16(out, off + 4, 20);          // version needed
    putU16(out, off + 6, e.flags);
    putU16(out, off + 8, e.method);
    putU16(out, off + 10, 0);          // mod time
    putU16(out, off + 12, 0x21);       // mod date (1980-01-01)
    putU32(out, off + 14, e.crc);
    putU32(out, off + 18, e.data.length);
    putU32(out, off + 22, e.usize);
    putU16(out, off + 26, name.length);
    putU16(out, off + 28, e.extra.length);
    off += 30;
    out.set(name, off); off += name.length;
    out.set(e.extra, off); off += e.extra.length;
    out.set(e.data, off); off += e.data.length;
  }
  const cdOffset = off;
  for (let i = 0; i < plan.length; i++) {
    const e = plan[i];
    const name = encoder.encode(e.name);
    putU32(out, off, CD_SIG);
    putU16(out, off + 4, 20);          // version made by
    putU16(out, off + 6, 20);          // version needed
    putU16(out, off + 8, e.flags);
    putU16(out, off + 10, e.method);
    putU16(out, off + 12, 0);
    putU16(out, off + 14, 0x21);
    putU32(out, off + 16, e.crc);
    putU32(out, off + 20, e.data.length);
    putU32(out, off + 24, e.usize);
    putU16(out, off + 28, name.length);
    putU16(out, off + 30, e.extra.length);  // same extra field as the local header
    putU16(out, off + 32, 0);          // comment length
    putU16(out, off + 34, 0);          // disk number
    putU16(out, off + 36, 0);          // internal attributes
    putU32(out, off + 38, 0);          // external attributes
    putU32(out, off + 42, localOffsets[i]);
    off += 46;
    out.set(name, off); off += name.length;
    out.set(e.extra, off); off += e.extra.length;
  }
  const cdSizeActual = off - cdOffset;
  putU32(out, off, EOCD_SIG);
  putU16(out, off + 8, plan.length);
  putU16(out, off + 10, plan.length);
  putU32(out, off + 12, cdSizeActual);
  putU32(out, off + 16, cdOffset);
  off += 22;
  out.set(comment, off);
  return out;
}

/**
 * Rebuild the archive. `replace` maps an entry name to new (uncompressed) bytes;
 * a value of `null` drops the entry. Everything else is copied exactly as it was,
 * in the original entry order.
 *
 * With `options.align`, the *stored* entries get a zipalign padding record in their local
 * header (id 0xd935, payload u16 version 1 followed by zero bytes) so that their data
 * starts on an alignment boundary - the same thing the zipalign tool does, which is why
 * `zipalign -c` accepts the result. Deflated entries are left alone: their payload is
 * never read from the file at the aligned offset.
 */
export function writeZip(zip, replace = new Map(), options = {}) {
  const plan = zip.entries.map((e) => {
    const replacement = replace.get(e.name);
    if (replacement === null) return null;
    if (replacement === undefined) {
      return { name: e.name, flags: e.flags & ~0x08, method: e.method, crc: e.crc, data: e.data, usize: e.usize, extra: new Uint8Array(0) };
    }
    const data = replacement instanceof Uint8Array ? replacement : new Uint8Array(replacement);
    return { name: e.name, flags: 0, method: 0, crc: crc32(data), data, usize: data.length, extra: new Uint8Array(0) };
  }).filter((e) => e !== null);

  return serializeArchive(alignEntries(plan, options.align || 0), zip.comment);
}

/**
 * Build a brand new archive out of `{ name, data }` entries, all stored (method 0). This is for
 * content we generate rather than rewrite - the APK export's payload.zip, which the app reads
 * with java.util.zip.ZipFile. Stored rather than deflated: a payload is a few KB.
 *
 * `data` may be a Uint8Array or a string (encoded as UTF-8), because the screens come out of the
 * editor as text.
 */
export function createZip(entries, options = {}) {
  const encoder = new TextEncoder();
  const plan = entries.map((e) => {
    const data = e.data instanceof Uint8Array ? e.data : encoder.encode(String(e.data));
    return { name: e.name, flags: 0, method: 0, crc: crc32(data), data, usize: data.length, extra: new Uint8Array(0) };
  });
  return serializeArchive(alignEntries(plan, options.align || 0), new Uint8Array(0));
}

export function findEntry(zip, name) {
  const e = zip.entries.find((x) => x.name === name);
  if (!e) throw new Error(`entry not found: ${name}`);
  if (e.method !== 0) throw new Error(`entry ${name} is compressed; this module only reads stored entries`);
  return e;
}
