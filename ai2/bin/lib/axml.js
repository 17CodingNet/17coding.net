/**
 * Minimal binary AndroidManifest.xml (AXML) string access, browser-safe ESM.
 *
 * Design constraint that makes this safe: the string pool keeps its string *count*
 * and *order*, so every index stays valid and nothing outside the pool chunk needs
 * patching. Only the bytes of the strings we replace change, and the pool chunk is
 * rebuilt (its size may grow or shrink; the chunks after it simply move).
 *
 * Layout used here (see Android source, ResChunk_header / ResStringPool_header):
 *   offset 0  ResXMLTree_header  type=0x0003 headerSize=8 size=<file size>
 *   offset 8  ResStringPool      type=0x0001 headerSize=28 size=<pool size>
 *               stringCount styleCount flags stringsStart stylesStart
 *             then: stringCount * uint32 offsets, styleCount * uint32 offsets,
 *                   string data, style data
 *   after the pool: ResXMLTree_node chunks (start/end element, namespace, cdata)
 *
 * Why blind substitution is not enough: a component declared as
 * `android:name=".Screen1"` is resolved against the manifest's package attribute, so
 * renaming the package alone makes Android look for a class the dex does not contain
 * (`ClassNotFoundException: Didn't find class "<newpkg>.Screen1"`, observed on a
 * Huawei P30 / Android 10). Renaming therefore has to read each attribute and decide
 * what the string *means*:
 *   manifest/@package          -> the new application id
 *   android:name=".X"          -> fully qualified with the *old* package, so the dex
 *                                 class still resolves (this is exactly what the Android
 *                                 Gradle plugin emits for applicationIdSuffix builds)
 *   android:authorities=A.B.C  -> re-derived from the new package, or two installs of the
 *                                 same template would fight over one authority
 *   android:label              -> the per-project label
 */

const CHUNK_NULL = 0x0000;
const CHUNK_STRING_POOL = 0x0001;
const CHUNK_XML = 0x0003;
// ResXMLTree chunk types: the namespace pair comes first, then the element pair.
const CHUNK_START_NAMESPACE = 0x0100;
const CHUNK_END_NAMESPACE = 0x0101;
const CHUNK_START_ELEMENT = 0x0102;
const CHUNK_END_ELEMENT = 0x0103;
const CHUNK_CDATA = 0x0104;
const CHUNK_RESOURCE_MAP = 0x0180;
export const UTF8_FLAG = 0x00000100;

const ANDROID_NS = 'http://schemas.android.com/apk/res/android';
const NO_INDEX = 0xffffffff;
const TYPE_STRING = 0x03;
const ATTRIBUTE_SIZE = 20;
const POOL_HEADER_SIZE = 28;
const NODE_HEADER_SIZE = 16;
const ATTR_EXT_SIZE = 20;

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function putU16(b, o, v) { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; }
function putU32(b, o, v) { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff; }

/** Read one pool string. Handles both the UTF-16 and the UTF-8 encoding aapt emits. */
function readPoolString(buf, dataStart, offset, utf8) {
  let p = dataStart + offset;
  if (!utf8) {
    let n = u16(buf, p);
    p += 2;
    if (n & 0x8000) { // continuation form for strings longer than 0x7fff
      const high = ((n & 0x7fff) << 16) | u16(buf, p);
      p += 2;
      n = high;
    }
    return new TextDecoder('utf-16le').decode(buf.subarray(p, p + n * 2));
  }
  let n = buf[p++];
  if (n & 0x80) {
    n = ((n & 0x7f) << 8) | buf[p++];
  }
  const start = p;
  p += n;
  // the UTF-8 form repeats the length as the byte-length of the (NUL-terminated) string
  let m = buf[p++];
  if (m & 0x80) {
    m = ((m & 0x7f) << 8) | buf[p++];
  }
  return new TextDecoder('utf-8').decode(buf.subarray(p, p + m));
}

function encodePoolString(value, utf8) {
  const num = new Uint8Array(4); // worst case length prefix for UTF-16
  const out = [];
  if (!utf8) {
    const units = value.length;
    if (units > 0x7fff) {
      const high = ((units >> 16) | 0x8000) & 0xffff;
      putU16(num, 0, high);
      putU16(num, 2, units & 0xffff);
      out.push(num.subarray(0, 4));
    } else {
      putU16(num, 0, units);
      out.push(num.subarray(0, 2));
    }
    const bytes = new Uint8Array(units * 2 + 2);
    for (let i = 0; i < units; i++) putU16(bytes, i * 2, value.charCodeAt(i));
    out.push(bytes);
  } else {
    const encoded = new TextEncoder().encode(value);
    const bytes = new Uint8Array(encoded.length + 3);
    if (encoded.length > 0x7f) {
      bytes[0] = 0x80 | (encoded.length >> 8);
      bytes[1] = encoded.length & 0xff;
      bytes.set(encoded, 2);
      bytes[2 + encoded.length] = 0; // UTF-8 pool strings end with a NUL
    } else {
      bytes[0] = encoded.length;
      bytes.set(encoded, 1);
      bytes[1 + encoded.length] = 0;
    }
    out.push(bytes);
  }
  const total = out.reduce((n, part) => n + part.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of out) { joined.set(part, at); at += part.length; }
  return joined;
}

export function parseAxml(bytes) {
  if (u16(bytes, 0) !== CHUNK_XML) {
    throw new Error(`not a binary XML document (chunk type 0x${u16(bytes, 0).toString(16)})`);
  }
  const fileSize = u32(bytes, 4);
  const poolOffset = u16(bytes, 2);
  if (u16(bytes, poolOffset) !== CHUNK_STRING_POOL) {
    throw new Error('expected a string pool as the first chunk');
  }
  const poolSize = u32(bytes, poolOffset + 4);
  const stringCount = u32(bytes, poolOffset + 8);
  const styleCount = u32(bytes, poolOffset + 12);
  const flags = u32(bytes, poolOffset + 16);
  const stringsStart = u32(bytes, poolOffset + 20);
  const stylesStart = u32(bytes, poolOffset + 24);
  const utf8 = (flags & UTF8_FLAG) !== 0;
  const offsets = [];
  for (let i = 0; i < stringCount; i++) {
    offsets.push(u32(bytes, poolOffset + POOL_HEADER_SIZE + i * 4));
  }
  const dataStart = poolOffset + stringsStart;
  const strings = offsets.map((o) => readPoolString(bytes, dataStart, o, utf8));
  return {
    fileSize, poolOffset, poolSize, stringCount, styleCount, flags, utf8,
    strings, restOffset: poolOffset + poolSize,
  };
}

/**
 * There is deliberately no "replace this string by value" helper: renaming a package by
 * blind substitution is the mistake that produced
 * `ClassNotFoundException: Didn't find class "<newpkg>.Screen1"` on a real device, because
 * `android:name=".Screen1"` resolves against the manifest package. Every rewrite goes
 * through renameApp(), which looks at what each attribute means.
 */

/**
 * Walk the node chunks and report every attribute, so callers can reason about what a
 * pool string is used for. `valueIndex` is the pool index the attribute points at
 * (NO_INDEX when the value is not a string reference), which is the index to rewrite.
 */
export function inspectManifest(bytes) {
  const doc = parseAxml(bytes);
  const strings = doc.strings;
  const attrs = [];
  const elements = [];
  let p = doc.restOffset;
  while (p + 8 <= bytes.length) {
    const type = u16(bytes, p);
    const size = u32(bytes, p + 4);
    if (size < 8) break;
    if (type === CHUNK_START_ELEMENT) {
      const element = strings[u32(bytes, p + NODE_HEADER_SIZE + 4)];
      const attributeStart = u16(bytes, p + NODE_HEADER_SIZE + 8);
      const attributeCount = u16(bytes, p + NODE_HEADER_SIZE + 12);
      elements.push(element);
      let a = p + NODE_HEADER_SIZE + attributeStart;
      for (let i = 0; i < attributeCount; i++, a += ATTRIBUTE_SIZE) {
        const nsIndex = u32(bytes, a);
        const nameIndex = u32(bytes, a + 4);
        const rawIndex = u32(bytes, a + 8);
        const dataType = bytes[a + 15];
        const data = u32(bytes, a + 16);
        const isString = (dataType === TYPE_STRING && data !== NO_INDEX) || rawIndex !== NO_INDEX;
        attrs.push({
          element,
          namespace: nsIndex === NO_INDEX ? null : strings[nsIndex],
          name: strings[nameIndex],
          dataType,
          valueIndex: isString ? (rawIndex !== NO_INDEX ? rawIndex : data) : NO_INDEX,
          // Absolute offset of the typed value's payload (a `data` word for an int, a pool
          // index for a string). Needed to patch values that are not pool strings, such as
          // <uses-sdk android:minSdkVersion>.
          dataOffset: a + 16,
        });
      }
    }
    p += size;
  }
  return { ...doc, attrs, elements };
}

/** The value of <manifest package="..."> (the application id) as a string. */
export function manifestPackage(bytes) {
  const doc = inspectManifest(bytes);
  const attr = doc.attrs.find((a) => a.element === 'manifest' && a.name === 'package' && !a.namespace);
  if (!attr || attr.valueIndex === NO_INDEX) throw new Error('no <manifest package="..."> attribute found');
  return doc.strings[attr.valueIndex];
}

/**
 * Rewrite the minimum SDK. Unlike the package name this is not a pool string but an inline
 * typed integer, so it is patched in the node chunk (and the pool rebuild above has to have
 * happened first, or the offset would be stale).
 */
export function setMinSdkVersion(bytes, value) {
  const doc = inspectManifest(bytes);
  const attr = doc.attrs.find((a) => a.element === 'uses-sdk'
    && a.namespace === ANDROID_NS && a.name === 'minSdkVersion');
  if (!attr) throw new Error('no <uses-sdk android:minSdkVersion> attribute in the manifest');
  const out = bytes.slice();
  const from = u32(out, attr.dataOffset);
  putU32(out, attr.dataOffset, value);
  return { bytes: out, from, to: value };
}

/**
 * Rename the app: application id, per-project label, and the identifiers that derive from
 * the package. Component class names are *pinned* to the old package (fully qualified) so
 * the classes already in the dex keep resolving - see the note at the top of this file.
 *
 * `minSdk` is optional and rewrites <uses-sdk android:minSdkVersion> (scheme v2 signing
 * alone means the app cannot install on API 21-23, so the manifest has to say 24).
 *
 * Returns { bytes, changes, intChanges, leftover }: changes lists the pool entries that
 * moved, intChanges the inline integers that moved.
 */
export function renameApp(bytes, { from, to, label, minSdk } = {}) {
  const doc = inspectManifest(bytes);
  const strings = doc.strings.slice();
  const changes = [];
  const set = (index, value, why) => {
    if (index === NO_INDEX || index >= strings.length) return;
    if (strings[index] === value) return;
    changes.push({ index, from: strings[index], to: value, why });
    strings[index] = value;
  };

  for (const a of doc.attrs) {
    if (a.valueIndex === NO_INDEX || a.valueIndex >= strings.length) continue;
    const value = strings[a.valueIndex];
    if (a.element === 'manifest' && a.name === 'package' && !a.namespace) {
      set(a.valueIndex, to, 'application id');
    } else if (a.namespace === ANDROID_NS && a.name === 'name' && value.startsWith('.')) {
      // A relative component name would be resolved against the new package, where no
      // such class exists. Fully qualifying it with the old package is what the Android
      // Gradle plugin emits when applicationId and Java package differ.
      set(a.valueIndex, from + value, 'component class pinned to the original package');
    } else if (a.namespace === ANDROID_NS && a.name === 'authorities'
        && value.startsWith(from + '.')) {
      set(a.valueIndex, to + value.slice(from.length), 'provider authority');
    } else if (a.namespace === ANDROID_NS && a.name === 'label' && label) {
      set(a.valueIndex, label, 'application label');
    }
  }

  // Anything else that still carries the old package (an intent scheme, a meta-data value)
  // is left alone but reported, so a template change cannot rot silently.
  const leftover = strings
    .map((s, index) => ({ index, value: s }))
    .filter(({ value }) => value === from || value.startsWith(from + '.'))
    .filter(({ index }) => !changes.some((c) => c.index === index))
    .map(({ index, value }) => ({ index, value }));

  let out = rebuildDocument(bytes, doc, strings);
  const intChanges = [];
  if (minSdk !== undefined && minSdk !== null) {
    const patched = setMinSdkVersion(out, minSdk);
    out = patched.bytes;
    if (patched.from !== patched.to) {
      intChanges.push({
        name: 'minSdkVersion', from: patched.from, to: patched.to,
        why: 'minimum SDK (scheme v2 only cannot install on API 21-23)',
      });
    }
  }

  return { bytes: out, changes, intChanges, leftover };
}

/** Re-encode the whole pool and splice it back in front of the untouched node chunks. */
function rebuildDocument(bytes, doc, strings) {
  if (doc.styleCount > 0) {
    throw new Error('styled string pools are not supported (the manifest has none)');
  }
  const encoded = strings.map((s) => encodePoolString(s, doc.utf8));
  const offsetsSize = doc.stringCount * 4;
  const dataSize = encoded.reduce((n, e) => n + e.length, 0);
  const stringsStart = POOL_HEADER_SIZE + offsetsSize;
  const padded = (stringsStart + dataSize + 3) & ~3; // pool data must stay 4-byte aligned
  const poolSize = padded;
  const pool = new Uint8Array(poolSize);

  putU16(pool, 0, CHUNK_STRING_POOL);
  putU16(pool, 2, POOL_HEADER_SIZE);
  putU32(pool, 4, poolSize);
  putU32(pool, 8, doc.stringCount);
  putU32(pool, 12, 0);
  putU32(pool, 16, doc.flags);
  putU32(pool, 20, stringsStart);
  putU32(pool, 24, 0);
  let at = 0;
  for (let i = 0; i < encoded.length; i++) {
    putU32(pool, POOL_HEADER_SIZE + i * 4, at);
    at += encoded[i].length;
  }
  let dataAt = stringsStart;
  for (const e of encoded) { pool.set(e, dataAt); dataAt += e.length; }

  const head = bytes.subarray(0, doc.poolOffset);
  const rest = bytes.subarray(doc.restOffset);
  const out = new Uint8Array(head.length + pool.length + rest.length);
  out.set(head, 0);
  out.set(pool, head.length);
  out.set(rest, head.length + pool.length);
  putU32(out, 4, out.length);
  return out;
}

/** Convenience: list the attribute values a manifest references (for diagnostics). */
export function describeAxml(bytes) {
  const doc = parseAxml(bytes);
  return { stringCount: doc.stringCount, utf8: doc.utf8, strings: doc.strings };
}
