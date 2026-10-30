# `war/bin/` — the native-APK export, packaged with the site

Everything the browser needs to turn the open project into an installable APK, with no build
server and no network. `appengine/build.xml` copies this whole directory into `war/`, so it
ships at `<site>/bin/…` and the page loads it from there (`ApkBuilder.java` passes
`GWT.getHostPageBaseURL() + "bin/"` in, so the site also works under a subdirectory).

**This is the browser-side Android export.** Upstream also shipped a server-side Android APK builder
(`appinventor/buildserver/...`, the historic "Build → Android" path that assembled dex + manifest +
alignment + signing on the server). That code is still in this checkout, but the shipped static site
has no build server behind it, so it is not wired into the site's Build menu — the **only Android item
the user sees in the Build menu is this client-side pipeline.** See
`solution/upstream-android-apk-note.md` for the background detail.

| Path | What it is |
|---|---|
| `template.bin` | The generic player template: a normal App Inventor project built with `--isForCompanion --excludeNativeLibs`, whose `Screen1.Initialize` copies its bundled payload out of the APK and hands it to `ProjectManager` (the App Library path). The file **is** an APK, byte for byte; it is named `.bin` because hosting platforms reject `.apk` uploads. The pipeline reads it as bytes, so the extension is only a delivery convention — keep it if you replace the file. It already contains the whole runtime, so an export only has to replace the payload and four manifest strings. ~10 MB, built from `appinventor/misc/player/template/`. That copy runs on the UI thread on **every** cold start, so it must stay buffered — see "The boot copy" below. |
| `keys/key.pk8` | The signing identity used when the user has not uploaded one: private key, PKCS#8 (DER). |
| `keys/cert.der` | Its self-signed certificate, DER. |
| `keys/key.spki` | The matching public key, SubjectPublicKeyInfo (DER). WebCrypto cannot export SPKI from a private key, so the public half has to be shipped beside it; the page verifies the pair before signing. A key the user uploads replaces all three (see "The user's own signing identity"). |
| `lib/*.js` | The pipeline itself, plain ES modules: `zip.js` (container), `axml.js` (binary manifest), `apksig.js` (APK Signing Block / scheme v2), `build_apk.js` (rewrite → align → sign), `export_apk.js` (payload → `exportApk`), `browser.js` (WebCrypto / `DecompressionStream` / inputs / download), `entry.js` (the page's entry point). These are the **source of truth**. |
| `lib/ai2apk.bundle.js` | Generated: the modules above concatenated into one **classic** script defining `window.AI2ApkExport`. The IDE loads *this*, not `entry.js`, because the export has to work from a `file://` copy of the site and a `file://` document cannot load an external module script. Built by `node tools/apk/build_apk_bundle.mjs`. |
| `embedded.js` | Generated: `template.bin` and the three `keys/` files as base64, under `window.AI2_APK_EMBEDDED`. Same reason — a `file://` page cannot `fetch` a sibling file — and loaded lazily on the menu click, not with the page. Same generator. |

## Why the template carries no native libraries

`--isForCompanion` makes the build include every component, because a payload may use any of
them. Native libraries are pulled in by components, and only one component declares any:
`PhoneStatus`'s `@UsesNativeLibraries` adds `libjingle_peerconnection_so.so` (the WebRTC engine)
for `armeabi-v7a`, `arm64-v8a` and `x86_64`. The only code that loads it is the Companion
handshake (`PhoneStatus.startWebRTC` → `WebRTCNativeMgr`, reached through `ReplForm`). An APK
exported from this template is a standalone app; it never connects to a Companion, so those
three libraries have no reader and their ~8.5 MB (compressed) is dead weight in every export.
`--excludeNativeLibs` tells the build server to skip `AttachNativeLibs`, which takes the
template from ~18 MB to ~10 MB. The Companion APK itself still needs the library and is built
without the flag.

The template still carries the whole dex and every component class — that is required — so
do not expect to shrink it further without dropping components.

## Where the shipped template is built

The `template.bin` shipped here is **not** compiled from this branch. It is built on
`offline-webapp-zh_cn-companion`, because the component and runtime localization lives there:
the shipped archive's dex contains Chinese error text (46 occurrences of 「错误」 in
classes.dex), while a template built from this branch's (upstream-English) sources contains
none. That branch got the same
`appinventor/misc/player/` sources, `tools/apk/build_template.sh` and the
`--excludeNativeLibs` build-server option (commit `8a8d2a8b6`).

Its `--install` is intentionally disabled (there is no `bin/` pipeline on that branch), so the
loop is:

```bash
# on offline-webapp-zh_cn-companion
bash tools/apk/build_template.sh                 # -> appinventor/misc/player/build/PlayerTemplate.apk

# on offline-webapp-zh_cn-release (this branch)
cp ../appinventor_2026-offline-webapp-zh_cn-companion/appinventor/misc/player/build/PlayerTemplate.apk \
   appinventor/appengine/war/bin/template.bin
node tools/apk/build_apk_bundle.mjs              # embedded.js + ai2apk.bundle.js
cp -R appinventor/appengine/war/bin/. appinventor/appengine/build/war/bin/
cp -R appinventor/appengine/war/bin/. offline-webapp/bin/
node tools/apk/verify_apk_bundle.js
```

Editing `misc/player/` here does not ship anything by itself: the next published template
comes from the companion branch, so port the change there, rebuild, and import the APK.
Running `build_template.sh --install` **here** would replace the Chinese template with an
English-runtime one.

## How it loads, and why two ways

`file://` is the case that shapes this directory. Chrome treats a `file://` document as a
**secure context**, so `crypto.subtle`, `DecompressionStream` and IndexedDB all work from one —
which is what the export actually needs. What a `file://` page cannot do is *read a sibling
file*: no `fetch`, no `XMLHttpRequest`, and no external `<script type="module">`. Classic
`<script src>` is the one thing that still works.

So the export ships both halves of that constraint:

* the pipeline as a classic script (`lib/ai2apk.bundle.js`), generated from the ES modules;
* its inputs as base64 (`embedded.js`), loaded only when the page itself is `file://`.

Over http(s) `entry.js` skips `embedded.js` and fetches `template.bin` and `keys/` directly, so
one implementation feeds both cases: the local file gets the base64 copy, the hosted page gets
the 10 MB binary template and the browser's HTTP/SW cache. `entry.js` also works as a module for
callers that load it that way.

Because `ai2apk.bundle.js` and `embedded.js` are generated, **edit the ES modules and
regenerate** — `node tools/apk/build_apk_bundle.mjs`. `tools/apk/verify_apk_bundle.js` re-derives
both and fails on drift, so a forgotten regeneration is a failing check rather than stale code
in the shipped site.

## The boot copy

`template.bin`'s `Screen1.Initialize` copies `assets/payload.zip` out of the APK into the app's
external files dir, because `ProjectManager` — the App Library path — only reads a project from
there. It does this on **every** cold start, on the **UI thread**, before the user's screen
exists, and it re-copies even when the payload has not changed. So its cost is paid by every
launch of every exported app, and it scales with the payload — which carries the project's
**assets**, not only its yail.

It therefore must never be a per-byte loop on the Scheme interpreter. It was, once: a Kawa
`(invoke in (quote read))` plus `(invoke out (quote write) c)` per byte measured **52 µs/byte**
on a VOG-AL00 / Android 10, linearly, which is 2.5 s for a 51 KB payload and **83 s** (with a
system ANR at 7 s) for a 1.6 MB one. The same bytes copied a few lines later by `loadAssets` →
`AssetFetcher` took 37 ms in the same process and on the same storage, so the interpreter — not
the disk — was ~2000× of the cost. `Screen1.yail` now calls `FileUtil.copy`, which keeps the byte
loop between two 4 KB Java buffers: **83 s → 86 ms**.

If you ever touch that function, this is the regression signal:

```sh
adb logcat -c && adb shell am start -S -n <pkg>/app.offline.player.Screen1 && sleep 3 \
  && adb logcat -d -v time -s PlayerTemplate:I Form:V ProjectManager:V
```

`boot: start` → `boot: copied bytes=N` is the copy, and the last `PlayerTemplate` line is
`boot: done`; the two `ProjectManager` lines (`Yail:` / `Init_Yail:`) split the Scheme evaluation
that follows. **Do not trust `am start -W` or `ActivityManager: Displayed` here**: the launcher's
theme is `AppTheme.Translucent` (see `CreateManifest.java`), so the system reports the activity as
displayed once the empty window is attached — measured 237 ms for an app that then took 3.2 s to
become usable. Those two metrics cannot see this app at all.

## The built-in key is a public test identity

`keys/` is committed **on purpose** and is **not a secret**:

```
CN=test, O=test, C=CN
SHA-256: 06:CC:0C:D2:13:49:7F:ED:9D:0B:09:F3:50:BC:0B:8A:64:E1:38:6A:71:4B:6C:88:CA:50:AB:15:10:9B:96:A9
notAfter: 2046-10-19
```

The identity was replaced on 2026-10-24 (it used to be `CN=Roadlabs APK Test Identity,
O=Roadlabs, C=CN`, SHA-256 `41:0B:91:…:D7:34`). An app installed from that older identity cannot
be updated in place by the current one — Android compares the signing certificate, so the user
has to uninstall the old APK first.

Because every copy of this site signs with the same key, anyone can produce an APK that claims
to come from this product, and two people who export a project with the same name produce
packages with the same application id. That is acceptable while the export is a development and
testing feature — it is what makes re-exporting a project update an installed app instead of
sitting next to it — and it is not acceptable for distribution.

## The user's own signing identity

**设置 → 上传密钥** replaces that identity with the user's own. The file is **one PEM bundle**
holding an RSA private key and the certificate that goes with it:

```
-----BEGIN PRIVATE KEY-----      (PKCS#8; the PKCS#1 "BEGIN RSA PRIVATE KEY" form is accepted too)
-----BEGIN CERTIFICATE-----
```

A Java keystore (`.keystore` / `.jks` / `.p12` / `.pfx`) is **not** accepted: a browser cannot
open one (it needs the store password and Java's PBE implementations), so dropping or picking one
is refused with the command that converts it:

```bash
openssl pkcs8 -topk8 -nocrypt -in key.jks -outform PEM -out key-pk8.pem   # the store password is asked for
# then put key-pk8.pem and the certificate into one file
```

What happens with the file, in the order it matters:

* the file is **checked, not just stored** — the key and the certificate have to belong together
  (`signingidentity.js`), the key has to be RSA, and it must not be passphrase-protected. A file
  that fails is refused with the reason, before anything is stored;
* it is stored **verbatim** in the browser's IndexedDB, under `android-signing.pem`. Verbatim is
  what makes **下载密钥** a real backup: the bytes you get back are the bytes you put in, so the
  file can be uploaded again on another machine;
* the exported APK is signed **with it**, and the export says which key signed it (the
  certificate's fingerprint) — the one thing about a signature you cannot see for yourself;
* the project archive (`.aia`) carries it too, so moving a project to another machine moves the
  key with it. Importing an archive restores the key (overwriting an existing one is confirmed
  first). An old archive's `android.keystore` — the Java keystore this build used to keep — is
  skipped rather than unpacked: it cannot sign anything.

The pipeline is unchanged by this: `exportApk` takes the certificate, the public key and the
signing function as parameters, and only *where they come from* moved. `entry.js` uses the
identity the IDE passes in when there is one, and the shipped `keys/` identity otherwise.

Two things to know before you rely on it:

* the key lives in the browser's storage on this machine only. Nothing uploads it, and nothing
  backs it up — **下载密钥** (or the `.aia`) is the backup, and there is only one copy of it;
* a passphrase-protected key cannot be used at all: the page has nowhere to ask for one, and
  asking would mean handling a secret in the UI.

The per-user key generated in the page (rather than supplied by the user) is still the intended
direction for a distributed product: generate an RSA key pair with WebCrypto, keep it in the
browser's storage, self-sign the certificate in the page, and export it. Nothing in `lib/` has to
change for that either.

## Regenerating

The template needs the build server, which is why it is a build artifact rather than something
the site's build produces. Once per machine:

```bash
cd appinventor
ant MakeAuthKey
ant -Dskip.ios=true BuildServer          # once
cd ..
```

Then, after every edit under `appinventor/misc/player/template/`:

```bash
bash tools/apk/build_template.sh --install
```

That is the whole loop — it builds the template, copies it to **this** directory's
`template.bin`, regenerates `embedded.js` (which carries the APK as base64, and is what a
`file://` page reads), syncs `offline-webapp/bin/` (and `appengine/build/war/bin/`, which is
what `build-webapp.sh` actually copies from), and finishes by running
`verify_apk_bundle.js` so a stale copy is a failing check rather than a silently old export.
Dropping the `--install` builds into `appinventor/misc/player/build/` and stops there; the copy
step is what makes it useless on its own.

A fresh identity (any RSA key of 2048 bits or more works; Android does not check the
certificate's validity dates):

```bash
openssl req -x509 -newkey rsa:2048 -sha256 -keyout key.pem -nodes -days 7300 \
  -subj "/CN=test/O=test/C=CN" -out cert.pem
openssl pkcs8 -topk8 -nocrypt -in key.pem -outform DER -out keys/key.pk8
openssl x509  -in cert.pem -outform DER -out keys/cert.der
openssl rsa   -in key.pem -pubout -outform DER -out keys/key.spki
node tools/apk/build_apk_bundle.mjs   # regenerate embedded.js, then rebuild the site
```

Replacing `keys/` changes the signer of every future export: an app already installed from an
older identity can no longer be updated by an APK signed with the new one (Android matches the
signature on update), so users have to uninstall first.

## What checks this

* `bash tools/apk/verify_apk_export.sh [--device] [--browser]` — assembles a payload from a
  project directory through `export_apk.js` and judges the artifact with python's zipfile,
  upstream `apksigner`/`zipalign`/`aapt`, an A/B against the verified pipeline, and on a device
  the screens plus a packaged asset (written to the app's asset directory and decoded by
  MediaUtil).
* `node tools/qa/verify_build_targets.js apk` — drives the shipped site in headless Chrome:
  opens a project, clicks **Build → Android App (.apk)**, unpacks the download, and checks it
  against this directory's template and keys.
* `node tools/qa/check_signing_identity.js` — the parser that decides whether a file the user
  picks is a usable signing identity: the shipped identity parses, a fresh openssl pair parses,
  and a mismatched pair, a certificate without a key, a key without a certificate, an encrypted
  key and a file that is not a PEM are each refused with their own reason.
* `node tools/qa/check_user_signed_apk.mjs` — the export actually signing with the user's key:
  the certificate in the finished APK's signature block is the user's, byte for byte, and not
  the shipped one.
* `node tools/qa/cdp_keystore_menu_check.js` — the three menu items end to end in the shipped
  site: upload, download, delete, the `.aia` round trip, and an exported APK signed with the
  uploaded certificate.
* `node tools/apk/verify_apk_bundle.js` — the `file://` path: checks the two generated files are
  current, that the bundle really is a classic script and leaks only `AI2ApkExport`, that the
  embedded base64 decodes to the files themselves, and then runs the export in a real page over
  **both** `file://` and `http://` and requires the two archives to be byte-identical and
  `apksigner`/`zipalign`/`aapt` to accept the `file://` one.

Design notes and the reasoning behind the format details live in `solution/apk-template-poc.md`.
