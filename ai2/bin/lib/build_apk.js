/**
 * The native-APK pipeline in one place: read the template, rewrite the manifest, repack with
 * alignment, and sign with APK Signature Scheme v2. `tools/apk/apk_sign.mjs` is its CLI and
 * `tools/apk/verify_apk_sign_browser.js` runs the very same function inside a page - which is
 * the point of the split. A browser test that re-implemented these steps could agree with
 * itself while disagreeing with what we actually ship.
 *
 * Nothing here imports `node:*`, so the module loads in a page as an ES module. The three
 * primitives it cannot provide itself are injected, and each has a one-line counterpart in
 * both runtimes:
 *
 *   inflateRaw(bytes) -> Promise<Uint8Array>  zlib.inflateRawSync / DecompressionStream
 *   sha256(bytes)     -> Promise<Uint8Array>  createHash('sha256') / crypto.subtle.digest
 *   sign(bytes)       -> Promise<Uint8Array>  createSign('sha256') / crypto.subtle.sign
 */
import { readZip, writeZip } from './zip.js';
import { renameApp, manifestPackage, describeAxml } from './axml.js';
import { signApkV2, ALG_RSA_PKCS1_SHA256 } from './apksig.js';

/** Stale JAR (v1) signing files: the v2-only APK must not keep them. */
const V1_SIGNATURE_FILE = /^META-INF\/(MANIFEST\.MF|.+(\.SF|\.RSA|\.DSA|\.EC))$/i;

/**
 * Build a signed APK from the template.
 *
 * opts:
 *   input            Uint8Array   the template APK
 *   newPackage       string?      application id to write (defaults to the template's)
 *   label            string?      application label
 *   minSdk           number?      minSdkVersion to write (scheme v2 needs 24)
 *   payload          { name, bytes }?  an asset to embed (e.g. assets/payload.zip)
 *   certificateDer   Uint8Array   signer certificate, DER
 *   publicKeyDer     Uint8Array   SubjectPublicKeyInfo, DER
 *   certificateChain Uint8Array[]? certificates, DER (defaults to [certificateDer])
 *   algorithmId      number       signature algorithm (default 0x0103, PKCS#1 v1.5 + SHA-256)
 *   align            number       alignment for stored entries (default 4)
 *   sha256, sign, inflateRaw      the injected primitives described above
 *
 * Returns { bytes, manifest, fromPackage, droppedV1Files, alignedLength, signed }.
 */
export async function buildApk(opts) {
  const {
    input, newPackage, label, minSdk, payload,
    certificateDer, publicKeyDer, certificateChain,
    algorithmId = ALG_RSA_PKCS1_SHA256, align = 4,
    sha256, sign, inflateRaw,
  } = opts;
  for (const [name, value] of Object.entries({ input, certificateDer, publicKeyDer, sha256, sign, inflateRaw })) {
    if (!value) throw new Error(`buildApk needs ${name}`);
  }

  // --- 1) manifest -------------------------------------------------------------------
  const zip = readZip(input);
  const manifestEntry = zip.entries.find((e) => e.name === 'AndroidManifest.xml');
  if (!manifestEntry) throw new Error('AndroidManifest.xml not found in the archive');
  const rawManifest = manifestEntry.method === 0
    ? manifestEntry.data : await inflateRaw(manifestEntry.data);
  const fromPackage = manifestPackage(rawManifest);
  const manifest = renameApp(rawManifest, {
    from: fromPackage,
    to: newPackage || fromPackage,
    label,
    minSdk: minSdk === undefined ? undefined : Number(minSdk),
  });

  // --- 2) container: new manifest, optional payload, no stale v1 signature -------------
  const replace = new Map([['AndroidManifest.xml', manifest.bytes]]);
  const droppedV1Files = [];
  for (const e of zip.entries) {
    if (V1_SIGNATURE_FILE.test(e.name)) {
      replace.set(e.name, null);
      droppedV1Files.push(e.name);
    }
  }
  if (payload) replace.set(payload.name, payload.bytes);

  const aligned = writeZip(zip, replace, { align });

  // --- 3) scheme v2 signature ---------------------------------------------------------
  const signed = await signApkV2(aligned, {
    certificateDer, publicKeyDer, certificateChain, algorithmId, sha256, sign,
  });

  return {
    bytes: signed.bytes,
    manifest,
    describe: describeAxml(rawManifest),
    rawManifest,
    fromPackage,
    droppedV1Files,
    alignedLength: aligned.length,
    signed,
  };
}
