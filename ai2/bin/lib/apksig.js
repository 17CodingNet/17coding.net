/**
 * APK Signature Scheme v2, implemented in pure JS (browser-safe ESM): no apksigner, no
 * native crypto. The caller injects two asynchronous primitives so the same code runs on
 * WebCrypto in a page and on node:crypto in Node:
 *
 *   sha256(bytes) -> Promise<Uint8Array>   raw SHA-256
 *   sign(bytes)   -> Promise<Uint8Array>   RSASSA-PKCS1-v1_5 over SHA-256 (the hash is
 *                                          applied by the primitive, as WebCrypto and
 *                                          node:crypto both do)
 *
 * The wire format below is verified against two independent readings of it: apksigner's own
 * output on the template APK decoded field by field, and apksig's `generateApkSignatureSchemeV2
 * Block` / `generateSignerBlock`, which is the code that produced that output. Four details are
 * easy to get wrong from the prose spec alone, and each of them makes a block no verifier will
 * accept:
 *
 *   * an APK Signing Block entry is `uint64 length | uint32 ID | value`, where the length covers
 *     the ID as well as the value. There is no per-entry padding - the block is rounded up to a
 *     multiple of 4096 by appending a single zero-filled *verity padding* pair (ID 0x42726577),
 *     and only when the leftover is at least the 12 bytes a pair needs.
 *   * signing must insert padding before the block so that the block starts on a 4 KiB page
 *     boundary (`generateApkSigningBlockPadding`); that padding is inside the digest.
 *   * a digest record carries its own length prefix as well as the digest's
 *     (`u32 recordLen | u32 algorithmId | u32 digestLen | digestLen bytes`);
 *   * a signer is length-prefixed *inside* the sequence of signers, and signedData ends with
 *     two length-prefixed empty elements (the additional attributes and a trailing empty one).
 *
 * Layout produced (one signer):
 *
 *   value = signers(lp) where signers = signer(lp) of
 *      signedData(lp) = digests(lp) + certificates(lp) + attributes(lp) + empty(lp)
 *      signatures(lp) = record(lp-per-record) of (algorithmId, signature(lp))
 *      publicKey(lp)  = SubjectPublicKeyInfo DER
 *
 * The digest covers everything outside the block: the contents before the signing block (the
 * page padding included), the central directory, and the EOCD with its central-directory
 * offset rewritten to point at the signing block. Those three sections are chunked *separately*
 * at 1 MiB each - chunking the concatenation instead also produces a self-consistent block that
 * no verifier accepts.
 */

export const BLOCK_ID_V2 = 0x7109871a;
export const BLOCK_ID_V3 = 0xf05368c0;
export const BLOCK_ID_VERITY_PADDING = 0x42726577;
export const SIGNING_BLOCK_MAGIC = 'APK Sig Block 42';

/**
 * Signature algorithm IDs. Note the numbering: the RSA-PSS algorithms come *first*, so
 * RSASSA-PKCS1-v1_5 with SHA-256 - the deterministic one build tools pick - is 0x0103, not
 * 0x0101. Getting this backwards makes a block no verifier accepts.
 */
export const ALG_RSA_PSS_SHA256 = 0x0101;
export const ALG_RSA_PSS_SHA512 = 0x0102;
export const ALG_RSA_PKCS1_SHA256 = 0x0103;
export const ALG_RSA_PKCS1_SHA512 = 0x0104;
export const ALG_ECDSA_SHA256 = 0x0201;
export const ALG_ECDSA_SHA512 = 0x0202;
export const ALG_DSA_SHA256 = 0x0301;

const EOCD_SIG = 0x06054b50;
const CHUNK_SIZE = 1048576;
const CHUNK_PREFIX = 0xa5;      // each chunk is digested as 0xa5 || length || bytes
const TOP_PREFIX = 0x5a;        // the top level as 0x5a || chunk count || chunk digests
const BLOCK_ALIGNMENT = 4096;

const MAGIC_BYTES = new TextEncoder().encode(SIGNING_BLOCK_MAGIC);

function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function putU32(b, o, v) { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff; }
function u64(b, o) { return Number(new DataView(b.buffer, b.byteOffset + o, 8).getBigUint64(0, true)); }
function putU64(b, o, v) { new DataView(b.buffer, b.byteOffset + o, 8).setBigUint64(0, BigInt(v), true); }

/** Locate the end of central directory record (the last one in the file). */
export function findEocd(bytes) {
  const lowest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= lowest; i--) {
    if (u32(bytes, i) === EOCD_SIG) return i;
  }
  throw new Error('no end of central directory record');
}

/**
 * Parse the APK Signing Block, if there is one. Returns the block bounds, the central
 * directory bounds and every entry (padding entries included), in file order.
 */
export function parseSigningBlock(bytes) {
  const eocdStart = findEocd(bytes);
  const cdStart = u32(bytes, eocdStart + 16);
  const cdSize = u32(bytes, eocdStart + 12);
  const out = { eocdStart, cdStart, cdSize, blockStart: null, blockEnd: null, entries: [], byteLength: bytes.length };
  if (cdStart < 32) return out;
  const magicAt = cdStart - 16;
  for (let i = 0; i < 16; i++) {
    if (bytes[magicAt + i] !== MAGIC_BYTES[i]) return out;
  }
  const size = u64(bytes, cdStart - 24);
  const blockStart = cdStart - (size + 8);
  if (blockStart < 0 || u64(bytes, blockStart) !== size) return out;
  out.blockStart = blockStart;
  out.blockEnd = cdStart - 24;
  let p = blockStart + 8;
  while (p + 8 <= out.blockEnd) {
    const length = u64(bytes, p);          // covers the 4-byte ID as well as the value
    if (length < 4 || p + 8 + length > out.blockEnd) break;
    const id = u32(bytes, p + 8);
    // `length` is reported as the value length, which is what callers care about.
    out.entries.push({ id, length: length - 4, offset: p, value: bytes.subarray(p + 12, p + 8 + length) });
    p += 8 + length;
  }
  return out;
}

/**
 * Dump a v2 block value (diagnostics and verification output).
 *
 * Mirrors the writer above: the value is a length-prefixed sequence of length-prefixed signers,
 * each signer holding a length-prefixed signedData (whose digests and certificates sequences
 * hold records that are length-prefixed too) and a length-prefixed signature sequence. Every
 * loop stops at the enclosing length and advances by at least one byte, so a damaged file
 * reports a short parse instead of spinning - an earlier version of this walk ran away on a
 * bogus length and exhausted the heap.
 */
export function parseV2Block(value) {
  const lp = (at) => {
    const length = u32(value, at);
    return { length, data: value.subarray(at + 4, at + 4 + length), end: at + 4 + length };
  };
  /** Read a sequence of records shaped `uint32 recordLen | uint32 algorithmId | uint32 len | bytes`. */
  const readRecords = (at, end, key) => {
    const records = [];
    for (let r = at; r + 12 <= end;) {
      const record = lp(r + 8);
      records.push({ algorithmId: u32(value, r + 4), [key]: record.data });
      const recordLen = u32(value, r);
      if (recordLen === 0) break;
      r += 4 + recordLen;
    }
    return records;
  };
  const signersField = lp(0);
  const signersEnd = Math.min(4 + signersField.length, value.length);
  const signers = [];
  for (let p = 4; p + 4 <= signersEnd;) {
    const signer = lp(p);
    if (signer.length === 0 || signer.end > value.length) break;
    const signedData = lp(p + 4);
    const digestsField = lp(p + 8);
    const digests = readRecords(p + 12, digestsField.end, 'digest');
    const certsField = lp(digestsField.end);
    const certificates = [];
    for (let c = digestsField.end + 4; c + 4 <= certsField.end;) {
      const cert = lp(c);
      if (cert.length === 0 || cert.end <= c) break;
      certificates.push(cert.data);
      c = cert.end;
    }
    const attrsField = lp(certsField.end);
    const trailingField = lp(attrsField.end);
    const signaturesField = lp(signedData.end);
    const signatures = readRecords(signedData.end + 4, signaturesField.end, 'signature');
    const publicKeyField = lp(signaturesField.end);
    signers.push({
      digests,
      certificates,
      attributesLength: attrsField.length,
      trailingLength: trailingField.length,
      signatures,
      publicKey: publicKeyField.data,
      signedDataLength: signedData.length,
    });
    p = signer.end;
  }
  return signers;
}

/**
 * The digest over the protected sections: each section is chunked on its own at 1 MiB, every
 * chunk is digested as 0xa5 || uint32 length || bytes, and the top level digests
 * 0x5a || uint32 chunkCount || the chunk digests in order.
 */
export async function chunkedSha256(sections, sha256) {
  const chunkDigests = [];
  for (const section of sections) {
    // No chunks are produced for an empty section, so the count is a plain ceiling.
    const chunks = Math.ceil(section.length / CHUNK_SIZE);
    for (let index = 0; index < chunks; index++) {
      const part = section.subarray(index * CHUNK_SIZE, Math.min(section.length, (index + 1) * CHUNK_SIZE));
      // Five header bytes: the 0xa5 byte plus a uint32 length. Sizing this 4 + length and
      // writing the payload at offset 4 (an easy slip) overlaps the length's top byte with
      // the first content byte, which changes every chunk digest.
      const framed = new Uint8Array(5 + part.length);
      framed[0] = CHUNK_PREFIX;
      putU32(framed, 1, part.length);
      framed.set(part, 5);
      chunkDigests.push(await sha256(framed));
    }
  }
  const top = new Uint8Array(5 + chunkDigests.length * 32);
  top[0] = TOP_PREFIX;
  putU32(top, 1, chunkDigests.length);
  chunkDigests.forEach((d, i) => top.set(d, 5 + i * 32));
  return await sha256(top);
}

/** `u32 length | bytes`, the length-prefixed field the format is built from. */
function lp(bytes) {
  const out = new Uint8Array(4 + bytes.length);
  putU32(out, 0, bytes.length);
  out.set(bytes, 4);
  return out;
}

function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export function buildV2Value({ digest, certificateDer, certificateChain, signature, publicKeyDer, algorithmId = ALG_RSA_PKCS1_SHA256 }) {
  const digestRecord = new Uint8Array(4 + 4 + 4);
  putU32(digestRecord, 0, 8 + digest.length);  // the record's own length
  putU32(digestRecord, 4, algorithmId);
  putU32(digestRecord, 8, digest.length);
  const digestsField = lp(concat([digestRecord, digest]));

  const certs = (certificateChain && certificateChain.length ? certificateChain : [certificateDer])
    .map((cert) => lp(cert));
  const certsField = lp(concat(certs));

  // Scheme v2 has no additional attributes, but apksig still writes the length-prefixed
  // attributes element *and* a trailing empty element, so signedData ends in eight zero bytes.
  const attrsField = lp(new Uint8Array(0));
  const trailingField = lp(new Uint8Array(0));

  const signedDataContent = concat([digestsField, certsField, attrsField, trailingField]);

  const sigRecord = new Uint8Array(4 + 4 + 4);
  putU32(sigRecord, 0, 8 + signature.length);
  putU32(sigRecord, 4, algorithmId);
  putU32(sigRecord, 8, signature.length);
  const signaturesField = lp(concat([sigRecord, signature]));

  const publicKeyField = lp(publicKeyDer);

  // The signer carries its own length prefix inside the sequence of signers, and the sequence is
  // length-prefixed as well: two nested prefixes ahead of the first signer.
  const signerBlock = concat([lp(signedDataContent), signaturesField, publicKeyField]);
  return { value: lp(lp(signerBlock)), signedDataContent };
}

/**
 * Assemble the APK Signing Block: `uint64 size | entries | uint64 size | magic`, each entry
 * being `uint64 (4 + value.length) | uint32 id | value`, plus a verity padding pair when the
 * block would otherwise not be a multiple of `alignment`.
 */
export function buildSigningBlock(entries, alignment = BLOCK_ALIGNMENT) {
  const parts = entries.map(({ id, value }) => {
    const entry = new Uint8Array(12 + value.length);
    putU64(entry, 0, 4 + value.length);
    putU32(entry, 8, id);
    entry.set(value, 12);
    return entry;
  });
  const fixed = 8 + 8 + 16;                               // leading/trailing size fields + magic
  const body = parts.reduce((n, p) => n + p.length, 0);
  // A padding pair is only useful when it is at least as long as its own header, which is why
  // apksig adds a whole block's worth of alignment when the slack is under 12 bytes.
  let padding = (alignment - ((fixed + body) % alignment)) % alignment;
  if (padding !== 0 && padding < 12) padding += alignment;
  if (padding > 0) {
    const padPair = new Uint8Array(padding);               // zero-filled value
    putU64(padPair, 0, padding - 8);
    putU32(padPair, 8, BLOCK_ID_VERITY_PADDING);
    parts.push(padPair);
  }
  const content = concat(parts);
  const block = new Uint8Array(8 + content.length + 8 + 16);
  putU64(block, 0, content.length + 8 + 16);
  block.set(content, 8);
  putU64(block, 8 + content.length, content.length + 8 + 16);
  block.set(MAGIC_BYTES, 8 + content.length + 8);
  return block;
}

/**
 * Sign an aligned APK with scheme v2 only, replacing any existing signing block.
 *
 * opts: { certificateDer, publicKeyDer, sign, sha256, algorithmId, certificateChain }
 */
export async function signApkV2(bytes, opts) {
  const { certificateDer, publicKeyDer, sign, sha256, algorithmId = ALG_RSA_PKCS1_SHA256 } = opts;
  if (!certificateDer || !publicKeyDer || !sign || !sha256) {
    throw new Error('signApkV2 needs certificateDer, publicKeyDer, sign and sha256');
  }
  const before = parseSigningBlock(bytes);
  const contentsEnd = before.blockStart !== null ? before.blockStart : before.cdStart;
  const cdEnd = before.eocdStart;

  // The block has to start on a page boundary, so the archive is padded before it. This
  // padding is part of the signed contents, not just of the container.
  const blockStart = Math.ceil(contentsEnd / BLOCK_ALIGNMENT) * BLOCK_ALIGNMENT;
  const padBeforeBlock = blockStart - contentsEnd;
  const content = padBeforeBlock === 0
    ? bytes.subarray(0, contentsEnd)
    : concat([bytes.subarray(0, contentsEnd), new Uint8Array(padBeforeBlock)]);

  // Two copies of the EOCD are needed. The one covered by the digest points its central
  // directory offset at the signing block (which is where the block will start, fixed by the
  // content length); the one written to the file points at the central directory that now
  // follows the block. Only the offset field differs.
  const digestEocd = bytes.slice(before.eocdStart);
  putU32(digestEocd, 16, blockStart);
  const fileEocd = bytes.slice(before.eocdStart);

  const digest = await chunkedSha256([
    content,
    bytes.subarray(before.cdStart, cdEnd),
    digestEocd,
  ], sha256);

  // The signed data does not contain the signature, so build it once to get the exact bytes
  // to sign and once more to embed the result.
  const draft = buildV2Value({
    digest, certificateDer, certificateChain: opts.certificateChain,
    signature: new Uint8Array(0), publicKeyDer, algorithmId,
  });
  const signature = await sign(draft.signedDataContent);
  const { value } = buildV2Value({
    digest, certificateDer, certificateChain: opts.certificateChain,
    signature, publicKeyDer, algorithmId,
  });
  const signedDataContent = draft.signedDataContent;

  const block = buildSigningBlock([{ id: BLOCK_ID_V2, value }]);
  const newCdStart = blockStart + block.length;
  putU32(fileEocd, 16, newCdStart);
  const out = new Uint8Array(newCdStart + (cdEnd - before.cdStart) + fileEocd.length);
  out.set(content, 0);
  out.set(block, blockStart);
  out.set(bytes.subarray(before.cdStart, cdEnd), newCdStart);
  out.set(fileEocd, newCdStart + (cdEnd - before.cdStart));

  return {
    bytes: out,
    digest,
    paddingBeforeBlock: padBeforeBlock,
    blockLength: block.length,
    blockStart,
    centralDirectoryStart: newCdStart,
    signedDataLength: signedDataContent.length,
    certificateLength: certificateDer.length,
  };
}
