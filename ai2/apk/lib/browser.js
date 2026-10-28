/**
 * The browser half of the APK pipeline: everything `export_apk.js` needs that a page provides
 * differently from Node.
 *
 *   sha256 / sign   WebCrypto (`crypto.subtle`)      node:crypto
 *   inflateRaw      DecompressionStream              node:zlib
 *   the inputs      embedded base64, else fetch      fs.readFileSync
 *   the output      a Blob download                  writeFileSync
 *
 * `crypto.subtle` needs a secure context. That used to be read as "needs http(s)", which is
 * wrong: Chrome treats a `file://` document as a secure context too, so WebCrypto and
 * `DecompressionStream` both work from one. What a `file://` page cannot do is read a sibling
 * file - no `fetch`, no `XMLHttpRequest`, and no external module script - which is why the
 * template and the signing identity are also shipped base64 in `../embedded.js`, used only for a
 * `file://` page. Over http(s) `entry.js` skips it and fetches the template and keys directly.
 */

/**
 * The base64 the build embedded, or null when there is none (the hosted case).
 *
 * `../embedded.js` is loaded lazily by `entry.js` only for a `file://` page, not with the page:
 * it is ~24 MB and most sessions never export an APK.
 */
function embedded(name) {
  const table = typeof window !== 'undefined' ? window.AI2_APK_EMBEDDED : null;
  if (!table) return null;
  const value = table[name];
  return typeof value === 'string' && value.length ? value : null;
}

/**
 * Read one of the shipped inputs: the base64 copy when the page has it, otherwise a fetch of the
 * same path relative to the site.
 *
 * @param {string} url   the site-relative path, e.g. 'apk/template.apk'
 * @param {string} name  its key in the embedded table, e.g. 'template.apk'
 */
async function readInput(url, name, onProgress) {
  const base64 = embedded(name);
  if (base64 !== null) {
    const bytes = base64Bytes(base64);
    if (onProgress) onProgress(bytes.length, bytes.length);
    return bytes;
  }
  return fetchBytes(url, undefined, onProgress);
}

/** RSA PKCS#1 v1.5 with SHA-256, i.e. apksig algorithm 0x0103 - the deterministic one. */
const SIGN_ALGORITHM = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

/** Import a PKCS#8 (DER) private key for signing. Not extractable: it never leaves the page. */
export async function importSigningKey(pkcs8Der) {
  return crypto.subtle.importKey('pkcs8', pkcs8Der, SIGN_ALGORITHM, false, ['sign']);
}

/** Import a SubjectPublicKeyInfo (DER) public key - only ever used to prove the pair matches. */
export async function importPublicKey(spkiDer) {
  return crypto.subtle.importKey('spki', spkiDer, SIGN_ALGORITHM, true, ['verify']);
}

/** The three primitives the pipeline takes as parameters, bound to one imported key. */
export function cryptoPrimitives(key) {
  return {
    sha256: async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    sign: async (bytes) => new Uint8Array(await crypto.subtle.sign(SIGN_ALGORITHM, key, bytes)),
    inflateRaw: async (bytes) => {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    },
  };
}

/**
 * Decode standard base64 (the form `ProjectService.getFileDataUrl` hands assets over in) into
 * bytes. Assets arrive as base64 because they cross a Java/JS boundary; a package with media
 * would otherwise be carried as one enormous string twice.
 */
export function base64Bytes(base64) {
  const binary = atob(String(base64));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Encode bytes as standard base64, in chunks.
 *
 * <p>{@code String.fromCharCode.apply} has an argument-count cap; an APK is ~18 MB,
 * so the conversion has to run per chunk. Used only when the caller asks for the
 * bytes back instead of a download.
 */
export function bytesToBase64(bytes) {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * The template APK, from the embedded copy when the page has one and by fetch otherwise.
 *
 * Exported so the export's entry point does not have to know which of the two it is on - the
 * hosted site and a `file://` copy take the same path through the code.
 */
export async function readTemplate(base, onProgress) {
  return readInput(base + 'template.apk', 'template.apk', onProgress);
}

/** A same-origin static file as bytes. */
export async function fetchBytes(url, timeoutMs, onProgress) {
  // The template is ~18 MB; a weak mobile link or a proxy can leave the fetch
  // pending forever. Abort it with a message the Build dialog can show.
  const limit = timeoutMs === undefined ? 120000 : timeoutMs;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(function () { controller.abort(); }, limit) : null;
  try {
    const response = await fetch(url, controller ? {signal: controller.signal} : {});
    if (!response.ok) throw new Error(`could not read ${url} (HTTP ${response.status})`);
    if (!response.body || !onProgress) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (onProgress) onProgress(bytes.length, bytes.length);
      return bytes;
    }
    const total = Number(response.headers.get('content-length')) || 0;
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      if (step.value && step.value.length) {
        chunks.push(step.value);
        received += step.value.length;
        onProgress(received, total);
      }
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error(`timed out reading ${url} after ${Math.round(limit / 1000)}s; `
          + 'check the network and retry');
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The signing identity shipped beside the site: the private key, its certificate, and the
 * matching SPKI public key.
 *
 * The public half has to be shipped separately because WebCrypto cannot export SPKI from a
 * *private* key (`exportKey('spki')` is a public-key operation). The page proves the two belong
 * together before it signs anything - `verifyIdentity` - so a mismatched pair is a clear error
 * here rather than an uninstallable APK later.
 *
 * @param {string} base directory holding the material, e.g. 'apk/keys/'
 */
export async function loadSigningIdentity(base) {
  const [pkcs8, certificateDer, publicKeyDer] = await Promise.all([
    readInput(base + 'key.pk8', 'keys/key.pk8'),
    readInput(base + 'cert.der', 'keys/cert.der'),
    readInput(base + 'key.spki', 'keys/key.spki'),
  ]);
  const key = await importSigningKey(pkcs8);
  const publicKey = await importPublicKey(publicKeyDer);
  return { key, publicKey, certificateDer, publicKeyDer };
}

/**
 * The signing identity the user uploaded, from the three DER blobs the IDE parsed out of it.
 *
 * The same shape {@link loadSigningIdentity} returns, so the exporter does not care which of the
 * two it got - only where the material came from. The public half is passed in rather than
 * derived: WebCrypto cannot export SPKI from a private key, and the IDE reads it out of the
 * certificate for exactly that reason.
 *
 * @param {object} parts  {pkcs8, certDer, spkiDer}, each base64
 */
export async function identityFromParts(parts) {
  const key = await importSigningKey(base64Bytes(parts.pkcs8));
  const publicKey = await importPublicKey(base64Bytes(parts.spkiDer));
  return {
    key,
    publicKey,
    certificateDer: base64Bytes(parts.certDer),
    publicKeyDer: base64Bytes(parts.spkiDer),
  };
}

/**
 * Sign a probe with the private key and check the shipped public key verifies it. Cheap, and it
 * turns "the wrong .spki was copied next to the site" into a sentence instead of a signature the
 * platform rejects with no explanation.
 */
export async function verifyIdentity(identity) {
  const probe = new TextEncoder().encode('apk-signing-probe');
  const signature = new Uint8Array(await crypto.subtle.sign(SIGN_ALGORITHM, identity.key, probe));
  return crypto.subtle.verify(SIGN_ALGORITHM, identity.publicKey, signature, probe);
}

/**
 * Hand the archive to the browser as a download.
 *
 * A Blob and an object URL rather than WebAppBuilder's `data:` URL: this file is ~18 MB, and a
 * `data:` URI of that size is a ~24 MB string the page has to build and the browser has to parse
 * before the download even starts. The object URL is revoked once the download has begun.
 */
export function download(bytes, fileName) {
  // [offline-wails scope] Wails WebView (WKWebView on macOS, WebView2 on Windows)
  // silently ignores the `<a download>` click — same shape Tauri's webview had
  // before it was retired (2026-10). LocalDownloader.java / WebAppBuilder.java
  // already detect `window.go.main.App.SaveFile` and use it instead of
  // `<a download>`; mirror that here so the desktop wrapper hands the APK off
  // through a native save dialog. The chunked base64 pattern matches the Java
  // side — `String.fromCharCode.apply` must run per-chunk, otherwise the JS
  // arg-count cap blows on the ~18 MB APK.
  const wailsApp = (typeof window !== 'undefined'
      && window.go && window.go.main && window.go.main.App) || null;
  if (wailsApp && typeof wailsApp.SaveFile === 'function') {
    const CHUNK = 0x8000;
    let bin = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    const base64 = btoa(bin);
    Promise.resolve(wailsApp.SaveFile(fileName, base64))
        .catch((error) => { console.error('APK save failed: ' + error); });
    return;
  }

  // Legacy Tauri fallback — offline-tauri was retired in 2026-10, but the path
  // is harmless in case some downstream forks re-vendor it.
  const tauri = typeof window !== 'undefined' ? window.__TAURI__ : null;
  if (tauri && tauri.dialog && tauri.fs) {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    tauri.dialog.save({ defaultPath: fileName, filters: [{ name: 'Android package', extensions: ['apk'] }] })
        .then((target) => (target ? tauri.fs.writeFile(target, new Uint8Array(buffer)) : null),
              (error) => { console.error('APK save failed: ' + error); });
    return;
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.android.package-archive' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Revoking immediately can cancel the download in some browsers; a minute is long enough.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
