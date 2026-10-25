# Building and releasing (GitHub Actions)

Everything users download is built on GitHub; nobody needs a build machine.

| Artifact | Workflow | Trigger | Where it ends up |
|---|---|---|---|
| Android app `.apk` + `.sha256` | `android.yml` | tag `mobile-vX.Y.Z` (build only: push to `mobile-app`, manual run) | GitHub **Release** for the tag **and** `downloads/MarketLens-android.apk` on `main` (the direct-download link); run artifact otherwise |
| Container image | `container.yml` | push to `main` (`:latest`), tag `vX.Y.Z` (`:X.Y.Z`, `:X.Y`) | `ghcr.io/akash-8991/rea_marketwatch_app` (Packages) |
| Python wheel + sdist | built by hand: `python -m pip wheel . --no-deps -w dist` | version bump | `dist/` in the repository (with `SHA256SUMS.txt`) |

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
# 2. make sure main is green (Actions tab), then:
git tag v0.2.0        && git push origin v0.2.0          # container image :0.2.0 and :0.2
git tag mobile-v0.3.2 && git push origin mobile-v0.3.2   # Android APK as a GitHub Release
```
The Android version code is the workflow run number, so each build can update the previous one if signed with the same key.

## Checking a build
- **Actions tab**: both workflows should be green; the APK job prints the file's size, checksum and permissions
  (only `INTERNET` is expected).
- **Release**: the `.apk` and `.apk.sha256` are attached; verify with `shasum -a 256 -c`.
- **Container**: `docker run --rm -p 127.0.0.1:8080:8080 ghcr.io/akash-8991/rea_marketwatch_app:<tag>`; the workflow already
  smoke-tests health, the sign-up page, an account creation and the non-root user before publishing.

## Rolling back
Container: pin the previous tag. Android: delete the faulty Release (users keep what they installed) and publish a fixed
tag with a higher run number. Nothing in the app auto-updates; users choose when to install a newer build.
