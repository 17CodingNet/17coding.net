/**
 * Turning the open project into an installable APK, client side: the payload, and the one call
 * that wraps the template APK around it.
 *
 * What makes the shipped template *this* project is entirely the payload - a zip holding one
 * generated `<Screen>.yail` per screen plus the project's assets - together with the four
 * manifest strings that name the app (see ./axml.js). No dex, no resources, no build server.
 *
 * The payload's shape is not invented here: it is the contract the code that *reads* it
 * implements (`components/.../runtime/util/ProjectManager.java`, the App Library path the
 * template's bootstrap calls):
 *
 *   * a screen is an entry whose name ends with `"<Screen>.yail"`;
 *   * an asset is an entry whose name starts with `"asset"`, and the reader strips that
 *     `assets/` prefix, so the file lands under the name the yail's media properties use;
 *   * the zip itself is read by `java.util.zip.ZipFile`, so the entries may be stored or
 *     deflated - {@link createZip} stores them, because a payload is small.
 *
 * Where the zip has to sit inside the APK is the template's half of the same contract:
 * its bootstrap opens `getAssets().open("payload.zip")`, i.e. the entry `assets/payload.zip` at
 * the top level - not in a subdirectory, because the build server only ever copies asset
 * *files* into an APK (see tools/apk/build_template.sh).
 */
import { createZip } from './zip.js';
import { buildApk } from './build_apk.js';

/** The entry the template's bootstrap opens. Keep in step with appinventor/misc/player/template. */
export const PAYLOAD_ENTRY = 'assets/payload.zip';

/**
 * Scheme v2 is API 24, and a v2-only archive cannot install below it, so the export always
 * claims at least 24 - a manifest that says 21 while there is no v1 signature is a manifest
 * that installs on exactly the phones that reject it.
 */
export const MIN_SDK = 24;

/**
 * The characters upstream's StringUtils.myGetProjectName escapes when a *package name* has to
 * come out of a project name. Kept identical on purpose: an exported APK should sit under the
 * same application id family as the same project built by the build server.
 */
const CJK = /([\u4E00-\u9FA5]|[\uFE30-\uFFA0])/g;

/**
 * Anything else a project name may contain but a package segment may not - a hyphen, a space, a
 * dot - becomes an underscore rather than disappearing, so `a-b` and `ab` do not collide.
 */
const NOT_IN_PACKAGE_SEGMENT = /[^A-Za-z0-9_]/g;

/** Where an exported project's assets live inside the payload zip. */
const ASSET_PREFIX = 'assets/';

/**
 * A stable application id for a project name.
 *
 * Android's rule, not ours: dot-separated Java identifiers, so a Chinese project name has to be
 * escaped - with the same `uXXXX` spelling the build server uses, which keeps the id readable
 * and, unlike a hash, reproducible from the name alone.
 */
export function applicationId(projectName) {
  const escaped = String(projectName == null ? '' : projectName)
      .replace(CJK, (ch) => 'u' + ch.charCodeAt(0).toString(16))
      .replace(NOT_IN_PACKAGE_SEGMENT, '_');
  const segment = /^[A-Za-z_]/.test(escaped) ? escaped : 'app' + escaped;
  return 'app.offline.' + segment;
}

/**
 * The payload entry name for one screen: the screen's own package path under `src/`, which is
 * the layout the build server uses and what makes the name end with `"<Screen>.yail"` - the
 * only part the reader looks at.
 */
export function screenEntryName(screen) {
  const packageName = screen.packageName || screen.name;
  if (!packageName) throw new Error('a screen needs a name');
  return 'src/' + packageName.split('.').join('/') + '.yail';
}

/**
 * Build the payload's entry list: `{ name, data }` for {@link createZip}.
 *
 * @param {{ screens: Array<{name, packageName, yail}>, assets: Array<{name, bytes}> }} project
 */
export function payloadEntries({ screens, assets } = {}) {
  if (!screens || !screens.length) {
    throw new Error('the project has no screens, so there would be nothing to run');
  }
  const entries = [];
  const taken = new Set();
  for (const screen of screens) {
    const name = screenEntryName(screen);
    if (taken.has(name)) throw new Error(`two screens would write the same payload entry: ${name}`);
    if (!screen.yail) throw new Error(`${screen.name} has no generated yail`);
    taken.add(name);
    entries.push({ name, data: screen.yail });
  }
  for (const asset of assets || []) {
    if (!asset || !asset.name) throw new Error('an asset without a name cannot be packaged');
    // The reader strips one `assets/` prefix; a name that already carries it would land in a
    // directory named after the file's path instead of the file itself.
    const bare = asset.name.startsWith(ASSET_PREFIX) ? asset.name.slice(ASSET_PREFIX.length) : asset.name;
    const name = ASSET_PREFIX + bare;
    if (taken.has(name)) throw new Error(`two assets would write the same payload entry: ${name}`);
    taken.add(name);
    entries.push({ name, data: asset.bytes });
  }
  return entries;
}

/** The payload zip's bytes. */
export function buildPayloadZip(project) {
  return createZip(payloadEntries(project));
}

/**
 * Assemble and sign the APK for a project.
 *
 * The pipeline below is {@link buildApk} - the same function `tools/apk/apk_sign.mjs` and the
 * browser verifier run - so this adds only the payload and the application's identity.
 *
 * opts:
 *   template          Uint8Array   the shipped template APK
 *   project           {screens, assets}   or `payload` directly
 *   payload           Uint8Array?  the payload zip (built from `project` when omitted)
 *   projectName       string       used for the application id and the default label
 *   newPackage        string?      defaults to applicationId(projectName)
 *   label             string?      defaults to projectName (UTF-8 is fine - v2 covers it)
 *   minSdk            number       defaults to {@link MIN_SDK}
 *   certificateDer, publicKeyDer, sign, sha256, inflateRaw   as in {@link buildApk}
 *
 * Returns what {@link buildApk} returns; `payloadBytes` is added for reporting.
 */
export async function exportApk(opts) {
  const {
    template, project, payload, projectName,
    newPackage = applicationId(projectName),
    label = projectName,
    minSdk = MIN_SDK,
    certificateDer, publicKeyDer, certificateChain, algorithmId,
    align = 4, sha256, sign, inflateRaw,
  } = opts || {};
  if (!template) throw new Error('the template APK is required');

  const bytes = payload || buildPayloadZip(project);
  if (!bytes.length) throw new Error('the payload is empty');

  const result = await buildApk({
    input: template,
    newPackage,
    label,
    minSdk,
    align,
    payload: { name: PAYLOAD_ENTRY, bytes },
    certificateDer, publicKeyDer, certificateChain, algorithmId,
    sha256, sign, inflateRaw,
  });

  return { ...result, payloadBytes: bytes, toPackage: newPackage, toLabel: label, minSdk };
}
