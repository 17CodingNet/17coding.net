/**
 * The IDE's way in: one function, reached from the Build → APK menu item.
 *
 * `ApkBuilder.java` injects this file as a module script once (a classic script cannot `import`)
 * and then calls the global assigned below. Everything the export needs is here rather than in
 * Java, so the path a user takes is the same code `tools/apk/verify_apk_export_browser.js`
 * drives: read the shipped template, read the shipped identity and check the pair, assemble the
 * payload from the editors, sign, download.
 *
 * Not a one-liner over `exportApk` on purpose - the three fetches and the identity check are
 * exactly what goes wrong in the field (a missing template, a `key.spki` that does not match
 * `key.pk8`, an origin where modules or WebCrypto are unavailable), and each of those has to
 * produce a sentence instead of a silence.
 */
import { exportApk, MIN_SDK } from './export_apk.js';
import {
  readTemplate, loadSigningIdentity, identityFromParts, verifyIdentity, cryptoPrimitives,
  download, base64Bytes, bytesToBase64,
} from './browser.js';

/** Where the template and the identity live, relative to the site root. */
const DEFAULT_BASE = 'apk/';

/** The base64 copy of the template and identity, loaded once, on demand. */
const EMBEDDED_SCRIPT = 'embedded.js';
let embeddedLoading = null;

/**
 * Make sure `window.AI2_APK_EMBEDDED` is there before the pipeline asks for it.
 *
 * A classic script rather than a module, and loaded at click time rather than with the page: a
 * `file://` document cannot load an external module at all, and ~24 MB of base64 is not
 * something to pay for in every session. Resolves either way - on the hosted site the file is
 * simply not needed, since the same inputs are fetched from the site instead.
 */
async function ensureEmbedded(base) {
  if (typeof window === 'undefined' || window.AI2_APK_EMBEDDED) return;
  // http(s) can fetch the template and keys directly (readInput below), so the
  // 24 MB base64 copy is only for file://, where a sibling fetch is forbidden.
  // Loading and parsing it on a phone is slower than the 18 MB template.
  if (window.location.protocol !== 'file:') return;
  if (!embeddedLoading) {
    embeddedLoading = new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = base + EMBEDDED_SCRIPT;
      script.onload = () => resolve();
      script.onerror = () => resolve();   // the fetch path will report the real problem
      document.head.appendChild(script);
    });
  }
  return embeddedLoading;
}

/**
 * Build the APK for one project and hand it to the browser.
 *
 * options:
 *   base          string?   site-relative directory holding template.apk and keys/ (default 'apk/')
 *   projectName   string    the project, used for the application id and as the label fallback
 *   fileName      string?   what the download is called (default `<projectName>.apk`)
 *   label         string?   the app name shown under the icon (UTF-8 is fine)
 *   newPackage    string?   override the derived application id
 *   minSdk        number?   default 24 - scheme v2 cannot install below it
 *   screens       [{name, packageName, yail}]   one per screen, start screen first
 *   assets        [{name, base64}]              the project's assets
 *   signing       {pkcs8, certDer, spkiDer}?    the user's key, base64 DER; absent means the
 *                                                identity the site ships
 *
 * Resolves with a summary of what was written; rejects with an Error whose message is meant to
 * be shown to the user.
 */

const PROGRESS_ID = 'ai2-apk-progress';
const PROGRESS_STYLE_ID = 'ai2-apk-progress-style';
let activeProgress = null;

function progressLabels() {
  const lang = ((typeof document !== 'undefined' && document.documentElement
      && document.documentElement.lang)
      || (typeof navigator !== 'undefined' ? navigator.language : '') || '').toLowerCase();
  if (lang.indexOf('zh') === 0) {
    return {
      prepare: '准备 APK 工具…', template: '下载 APK 模板…',
      sign: '读取签名…', build: '正在编译 APK…', save: '保存 APK…', done: '完成'
    };
  }
  return {
    prepare: 'Preparing APK tools…', template: 'Downloading APK template…',
    sign: 'Reading signing key…', build: 'Building APK…', save: 'Saving APK…', done: 'Done'
  };
}

function progressStyle() {
  if (document.getElementById(PROGRESS_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = PROGRESS_STYLE_ID;
  style.textContent = `
#ai2-apk-progress {
  position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
  width: min(380px, 86vw); z-index: 2147483647;
  background: #fff; color: #222; border: 1px solid #ddd; border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, .18); padding: 18px 20px;
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
        "Helvetica Neue", Arial, sans-serif;
  pointer-events: none;
}
#ai2-apk-progress .ai2-apk-progress-row {
  display: flex; justify-content: space-between; gap: 12px; margin-bottom: 10px;
}
#ai2-apk-progress .ai2-apk-progress-label { font-weight: 600; }
#ai2-apk-progress .ai2-apk-progress-pct {
  color: #666; font-variant-numeric: tabular-nums;
}
#ai2-apk-progress .ai2-apk-progress-track {
  height: 6px; background: #e8e8e8; border-radius: 3px; overflow: hidden;
}
#ai2-apk-progress .ai2-apk-progress-bar {
  height: 100%; width: 0; background: #4285f4; border-radius: 3px;
  transition: width .2s ease;
}
#ai2-apk-progress .ai2-apk-progress-bar.indeterminate {
  width: 100% !important;
  background: repeating-linear-gradient(45deg, #4285f4, #4285f4 10px,
              #5a97f6 10px, #5a97f6 20px);
  background-size: 200% 100%;
  animation: ai2-apk-progress-stripes .8s linear infinite;
}
@keyframes ai2-apk-progress-stripes {
  from { background-position: 0 0; }
  to { background-position: 40px 0; }
}`;
  document.head.appendChild(style);
}

function createProgress() {
  if (typeof document === 'undefined' || !document.body) return null;
  if (activeProgress) activeProgress.hide(0);
  progressStyle();
  const box = document.createElement('div');
  box.id = PROGRESS_ID;
  box.setAttribute('role', 'progressbar');
  box.setAttribute('aria-valuemin', '0');
  box.setAttribute('aria-valuemax', '100');
  box.setAttribute('aria-live', 'polite');
  box.innerHTML = '<div class="ai2-apk-progress-row">'
      + '<span class="ai2-apk-progress-label"></span>'
      + '<span class="ai2-apk-progress-pct"></span></div>'
      + '<div class="ai2-apk-progress-track">'
      + '<div class="ai2-apk-progress-bar"></div></div>';
  document.body.appendChild(box);
  const label = box.querySelector('.ai2-apk-progress-label');
  const pct = box.querySelector('.ai2-apk-progress-pct');
  const bar = box.querySelector('.ai2-apk-progress-bar');
  let hidden = false;
  const api = {
    set(value, text, indeterminate) {
      if (hidden) return;
      if (text) label.textContent = text;
      const unknown = !!indeterminate || value === null || value === undefined;
      bar.classList.toggle('indeterminate', unknown);
      if (unknown) {
        bar.style.width = '100%';
        pct.textContent = '…';
        box.removeAttribute('aria-valuenow');
      } else {
        const number = Math.max(0, Math.min(100, Number(value) || 0));
        bar.style.width = number + '%';
        pct.textContent = Math.round(number) + '%';
        box.setAttribute('aria-valuenow', String(Math.round(number)));
      }
    },
    hide(delay) {
      if (hidden) return;
      hidden = true;
      if (activeProgress === api) activeProgress = null;
      setTimeout(function () {
        if (box.parentNode) box.parentNode.removeChild(box);
      }, delay === undefined ? 0 : delay);
    }
  };
  activeProgress = api;
  return api;
}

export async function exportApkForProject(options) {
  const opts = options || {};
  const base = opts.base || DEFAULT_BASE;
  if (!opts.screens || !opts.screens.length) {
    throw new Error('the project has no screens to export');
  }

  const labels = progressLabels();
  const ui = opts.returnBytes ? null : createProgress();
  try {
  if (ui) ui.set(0, labels.prepare, true);
  await ensureEmbedded(base);
  if (ui) ui.set(5, labels.template);
  const template = await readTemplate(base, function (loaded, total) {
    if (!ui) return;
    if (total > 0) {
      ui.set(5 + Math.min(1, loaded / total) * 55, labels.template);
    } else {
      ui.set(null, labels.template, true);
    }
  });
  // The key the user uploaded wins over the one the site ships: an export they signed with their
  // own certificate is the one they can publish and update, and the built-in test identity is
  // good for nothing beyond "it installs".
  let identity;
  let signer;
  if (opts.signing) {
    identity = await identityFromParts(opts.signing);
    // The same check the shipped identity gets: a key and a certificate that do not belong
    // together produce an APK Android refuses to install with no explanation.
    if (!await verifyIdentity(identity)) {
      throw new Error('the stored signing key and its certificate do not match, so nothing can '
          + 'be signed with them - upload the key again');
    }
    signer = { kind: 'user', fingerprint: opts.signing.fingerprint || '' };
  } else {
    identity = await loadSigningIdentity(base + 'keys/');
    // Cheap, and it turns a mismatched key.spki into this sentence instead of a package Android
    // refuses to install with no explanation.
    if (!await verifyIdentity(identity)) {
      throw new Error('the signing identity next to the site is inconsistent: key.spki is not the '
          + 'public half of key.pk8 (see apk/README.md)');
    }
    signer = { kind: 'builtin' };
  }

  const project = {
    screens: opts.screens,
    assets: (opts.assets || []).map((asset) => ({
      name: asset.name, bytes: base64Bytes(asset.base64),
    })),
  };
  const primitives = cryptoPrimitives(identity.key);
  if (ui) ui.set(70, labels.build, true);
  const built = await exportApk({
    template,
    project,
    projectName: opts.projectName,
    newPackage: opts.newPackage,
    label: opts.label,
    minSdk: opts.minSdk === undefined ? MIN_SDK : Number(opts.minSdk),
    certificateDer: identity.certificateDer,
    publicKeyDer: identity.publicKeyDer,
    sha256: primitives.sha256,
    sign: primitives.sign,
    inflateRaw: primitives.inflateRaw,
  });
  if (ui) ui.set(94, labels.save);

  const fileName = opts.fileName || (String(opts.projectName || 'app') + '.apk');
  // The bridge asks for the bytes instead of a download so `--out` works and the
  // artifact can be cached. The menu path keeps downloading as before.
  const returnBytes = opts.returnBytes === true;
  if (!returnBytes) {
    download(built.bytes, fileName);
    if (ui) ui.set(100, labels.done);
  }

  return {
    fileName,
    package: built.toPackage,
    label: built.toLabel,
    bytes: built.bytes.length,
    payloadBytes: built.payloadBytes.length,
    screens: project.screens.length,
    assets: project.assets.length,
    minSdk: built.minSdk,
    contentBase64: returnBytes ? bytesToBase64(built.bytes) : null,
    // Which key signed this, so the IDE can say so rather than leave the user to guess.
    signer: signer.kind,
    signerFingerprint: signer.fingerprint,
    sha256: Array.from(await primitives.sha256(built.bytes))
        .map((b) => b.toString(16).padStart(2, '0')).join(''),
    // The four manifest strings that name the app; reported so the IDE can show what changed.
    manifestChanges: built.manifest.changes.map((c) => c.why),
  };
  } finally {
    if (ui) ui.hide(800);
  }
}

// The handle ApkBuilder.java waits for. Assigned on the window rather than exported, because
// the caller is a classic script.
if (typeof window !== 'undefined') {
  window.AI2ApkExport = exportApkForProject;
}
