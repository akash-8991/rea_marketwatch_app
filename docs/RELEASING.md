# Building and releasing (GitHub Actions)

Everything users download is built on GitHub; nobody needs a build machine.

| Artifact | Workflow | Trigger | Where it ends up |
|---|---|---|---|
| Android app `.apk` (checksum in `downloads/checksums/`) | `android.yml` | tag `mobile-vX.Y.Z` (build only: push to `mobile-app`, manual run) | GitHub **Release** for the tag **and** `downloads/MarketLens-android.apk` on `main` (the direct-download link); run artifact otherwise |
| Container image | `container.yml` | push to `main` (`:latest`), tag `vX.Y.Z` (`:X.Y.Z`, `:X.Y`) | `ghcr.io/akash-8991/rea_marketwatch_app` (Packages) |
| Python wheel + sdist | built by hand: `python3 -m pip wheel . --no-deps -w dist` and `python3 -c "from setuptools import setup; setup()" sdist --dist-dir dist` | version bump | `dist/` in the repository (with `SHA256SUMS.txt`); only the current version is kept |

Every build first runs the tests: the 140 Python tests (`container.yml`) and the 19 JavaScript engine tests, which compare
against the Python engine's output (`android.yml`). Pull requests run tests and build, but publish nothing.

## One-time setup
1. **Stable Android signing key** (otherwise phones must uninstall to update, losing app data): create `debug.keystore`, store it
   as the secret `MARKETLENS_DEBUG_KEYSTORE`, and back the file up privately. Step by step: "Signing and updates" in
   [MOBILE.md](MOBILE.md). Never commit the file (`*.keystore` is git-ignored). Check it worked: the APK job log has no
   "No MARKETLENS_DEBUG_KEYSTORE secret" warning.
2. **Container package visibility**: after the first publish, open the repository's *Packages*, select `rea_marketwatch_app`,
   and set visibility to *Public* so `docker pull` works without logging in. Make sure the repository's *Settings > Actions >
   General > Workflow permissions* allows the workflow to write packages (the workflow requests `packages: write` itself).

## Cutting a release
```bash
# 1. bump versions (mobile/package.json is the Android version): pyproject.toml + src/marketlens/__init__.py (desktop), mobile/package.json (Android), update docs
#    bundled stock list changed? run mobile/scripts/gen-sectors.py (a test fails if the phone's copy differs); apps also refresh it weekly by themselves
# 2. make sure main is green (Actions tab), then:
git tag v0.9.0        && git push origin v0.9.0          # container image :0.9.0 and :0.9
git tag mobile-v0.12.0 && git push origin mobile-v0.12.0   # Android APK as a GitHub Release
```
The Android version code is the workflow run number, so each build can update the previous one if signed with the same key.

## Rules that keep users' accounts across updates
These are checked by tests (`mobile/tests/upgrade.test.mjs`, the Python migration tests) and by the build logs:
1. Never change the Android application id, the web scheme in `mobile/capacitor.config.json`, or the IndexedDB name.
2. Always sign with the same key (secret `MARKETLENS_DEBUG_KEYSTORE`); compare the signer fingerprint in the build log with the previous release.
3. Never lower the version code (it is the workflow run number, so it only rises).
4. If you change how accounts or snapshots are stored, add a migration in `mobile/engine/migrations.js` (and raise `CURRENT_SCHEMA`);
   desktop: a column-adding step in `optiondb._migrate`. Do not edit stored values anywhere else.
5. Before a release, install the new build over the previous one on a phone, sign in, and confirm the account is still there.

## Visual checks that automated tests cannot do alone
- Green/red: a CSS class on a cell is not proof the cell is coloured (a more specific rule can win). Check the *computed* colour of every
  `.up`/`.down` element on Home, Markets, Screener, Option chain and Updates, in light and dark mode. `tests/test_design.py` guards the rule.
- Open Markets and Home at phone width: stock cells show only the symbol, tables do not wrap and scroll sideways inside their box.

## Changing the interface
The interface is plain ES modules plus a small generated stylesheet. After adding or changing Tailwind utility classes in `static/js/*.js` or the icon list in
`ui/gen-icons.mjs`, regenerate and commit the output (it is checked in so that installing never needs Node):
```bash
cd ui && npm ci && npm run build      # writes static/css/tailwind.css and static/js/icons.js
```
CI runs the same build and fails if the committed files differ. Then rebuild the phone bundle with `node mobile/scripts/build-www.mjs`.

## Checking a build
- **Actions tab**: both workflows should be green; the APK job prints the file's size, checksum and permissions
  (only `INTERNET` is expected).
- **Release**: the `.apk` is attached; verify with `cd downloads && shasum -a 256 -c checksums/MarketLens-android.apk.sha256`.
- **Container**: `docker run --rm -p 127.0.0.1:8080:8080 ghcr.io/akash-8991/rea_marketwatch_app:<tag>`; the workflow already
  smoke-tests health, the sign-up page, an account creation and the non-root user before publishing.

## Rolling back
Container: pin the previous tag. Android: delete the faulty Release (users keep what they installed) and publish a fixed
tag with a higher run number. Nothing in the app auto-updates; users choose when to install a newer build.
