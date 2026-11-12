"""Build the desktop app for the operating system this runs on, test it, and zip it.

    pip install . pyinstaller
    python packaging/build_desktop.py            # -> dist-desktop/MarketLens-<os>-<version>.zip (+ .sha256)

macOS: MarketLens.app. Windows: MarketLens\\MarketLens.exe (a folder). Linux: MarketLens/MarketLens (a folder). The macOS app is sealed with an ad-hoc signature (not notarised) and the others are unsigned, so the first start needs the
usual one-time approval (see docs/INSTALL.md). `--check` (run on the built program) signs a throw-away user up and in, which proves the login works inside the package."""
import hashlib
import os
import platform
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "dist-desktop"
sys.path.insert(0, str(ROOT / "src"))
from marketlens import __version__  # noqa: E402

PLAT = {"darwin": "macos", "win32": "windows"}.get(sys.platform, "linux")


def build():
    shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir()
    args = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--windowed", "--name", "MarketLens", "--distpath", str(OUT / "app"), "--workpath", str(OUT / "work"),
            "--specpath", str(OUT / "work"), "--paths", str(ROOT / "src"), "--collect-data", "marketlens", "--collect-data", "certifi", "--hidden-import", "certifi", "--hidden-import", "marketlens.server", "--hidden-import", "marketlens.cli",
            "--hidden-import", "tkinter", str(ROOT / "packaging" / "marketlens_desktop.py")]
    subprocess.run(args, check=True, cwd=ROOT)
    app = OUT / "app"
    if PLAT == "macos":
        shutil.rmtree(app / "MarketLens", ignore_errors=True)   # PyInstaller also leaves a bare folder beside the .app: ship the app only
        seal_mac(app / "MarketLens.app")
    exe = app / "MarketLens.app" / "Contents" / "MacOS" / "MarketLens" if PLAT == "macos" else app / "MarketLens" / ("MarketLens.exe" if PLAT == "windows" else "MarketLens")
    return app, exe


def seal_mac(bundle):
    """Re-sign the whole .app bundle ad hoc and verify it. A bundle whose seal does not match its contents is what makes macOS say "MarketLens is damaged and can't be opened"
    once the zip has been downloaded (quarantined); a consistent ad-hoc seal gives the ordinary "unidentified developer" prompt that right-click, Open answers. A paid Apple
    Developer ID and notarisation would remove the prompt entirely; this project has neither."""
    subprocess.run(["xattr", "-cr", str(bundle)], check=False)
    subprocess.run(["codesign", "--force", "--deep", "--sign", "-", "--timestamp=none", str(bundle)], check=True)
    subprocess.run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", str(bundle)], check=True)


def check(exe):
    verdict = OUT / "check.txt"
    r = subprocess.run([str(exe), "--check", "--check-out", str(verdict)], capture_output=True, text=True, timeout=240)   # a windowed program has no console: read its verdict from the file
    text = verdict.read_text() if verdict.exists() else (r.stdout + r.stderr)
    print(text[-600:])
    if r.returncode != 0 or "OK:" not in text:
        raise SystemExit(f"the packaged app failed its self-check (exit {r.returncode})")


def pack(app):
    name = f"MarketLens-{PLAT}-{platform.machine().lower()}-{__version__}.zip"
    z = OUT / name
    if PLAT == "macos":   # ditto keeps symlinks, permissions and the code-signature files exactly as macOS expects (Python's zipfile can drop what the seal covers)
        subprocess.run(["ditto", "-c", "-k", "--keepParent", str(app / "MarketLens.app"), str(z)], check=True)
    else:
        with zipfile.ZipFile(z, "w", zipfile.ZIP_DEFLATED) as f:
            for p in sorted(app.rglob("*")):
                if p.is_file() or p.is_symlink():
                    info = zipfile.ZipInfo.from_file(p, p.relative_to(app))
                    if p.is_symlink():
                        info.create_system = 3
                        info.external_attr = (0o120755 << 16)
                        f.writestr(info, os.readlink(p))
                    else:
                        with open(p, "rb") as fh:
                            f.writestr(info, fh.read(), zipfile.ZIP_DEFLATED)
    h = hashlib.sha256(z.read_bytes()).hexdigest()
    (OUT / (name + ".sha256")).write_text(f"{h}  {name}\n")
    print(f"built {z} ({z.stat().st_size / 1e6:.1f} MB) sha256 {h}")


if __name__ == "__main__":
    app, exe = build()
    check(exe)
    pack(app)
