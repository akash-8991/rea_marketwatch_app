"""Customise the generated Capacitor Android project (run after `npx cap add android`, from the mobile/ folder):
  - launcher icons for every density, drawn with Pillow (no other tooling needed)
  - android:allowBackup="false", so accounts and option data stay out of cloud backups
  - versionName / versionCode from package.json (versionCode = major*10000 + minor*100 + patch)
Usage: python3 scripts/prepare-android.py [--version-code N]"""
import json
import os
import re
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
MOBILE = os.path.normpath(os.path.join(HERE, ".."))
RES = os.path.join(MOBILE, "android", "app", "src", "main", "res")
BLUE, WHITE = (28, 59, 160, 255), (255, 255, 255, 255)
DENSITIES = {"mdpi": (48, 108), "hdpi": (72, 162), "xhdpi": (96, 216), "xxhdpi": (144, 324), "xxxhdpi": (192, 432)}


def glyph(size, color, margin):
    """A lens ring with a rising price line, on a transparent canvas of `size` px."""
    big = 1024
    im = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    m = int(big * margin)
    d.ellipse([m, m, big - m, big - m], outline=color, width=int(big * 0.045))
    pts = [(int(x * big), int(y * big)) for x, y in ((0.30, 0.62), (0.42, 0.52), (0.52, 0.58), (0.70, 0.38))]
    d.line(pts, fill=color, width=int(big * 0.05), joint="curve")
    for x, y in pts:
        d.ellipse([x - big * 0.03, y - big * 0.03, x + big * 0.03, y + big * 0.03], fill=color)
    d.line([(int(big * 0.78), int(big * 0.78)), (int(big * 0.88), int(big * 0.88))], fill=color, width=int(big * 0.07))
    return im.resize((size, size), Image.LANCZOS)


def icons():
    for name, (legacy, fg) in DENSITIES.items():
        folder = os.path.join(RES, f"mipmap-{name}")
        os.makedirs(folder, exist_ok=True)
        square = Image.new("RGBA", (legacy, legacy), BLUE)
        square.alpha_composite(glyph(legacy, WHITE, 0.16))
        square.save(os.path.join(folder, "ic_launcher.png"))
        mask = Image.new("L", (legacy, legacy), 0)
        ImageDraw.Draw(mask).ellipse([0, 0, legacy - 1, legacy - 1], fill=255)
        round_icon = Image.new("RGBA", (legacy, legacy), (0, 0, 0, 0))
        round_icon.paste(square, (0, 0), mask)
        round_icon.save(os.path.join(folder, "ic_launcher_round.png"))
        # adaptive foreground: content kept inside the central 66% safe zone
        layer = Image.new("RGBA", (fg, fg), (0, 0, 0, 0))
        layer.alpha_composite(glyph(fg, WHITE, 0.30))
        layer.save(os.path.join(folder, "ic_launcher_foreground.png"))
    path = os.path.join(RES, "values", "ic_launcher_background.xml")
    with open(path, "w") as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#1C3BA0</color>\n</resources>\n')


def manifest():
    path = os.path.join(MOBILE, "android", "app", "src", "main", "AndroidManifest.xml")
    s = open(path).read()
    s = s.replace('android:allowBackup="true"', 'android:allowBackup="false"')
    open(path, "w").write(s)


def version(code_override):
    pkg = json.load(open(os.path.join(MOBILE, "package.json")))
    major, minor, patch = (int(x) for x in re.match(r"(\d+)\.(\d+)\.(\d+)", pkg["version"]).groups())
    code = code_override or major * 10000 + minor * 100 + patch
    path = os.path.join(MOBILE, "android", "app", "build.gradle")
    s = open(path).read()
    s = re.sub(r"versionCode \d+", f"versionCode {code}", s)
    s = re.sub(r'versionName "[^"]*"', f'versionName "{pkg["version"]}"', s)
    open(path, "w").write(s)
    return pkg["version"], code


if __name__ == "__main__":
    override = int(sys.argv[sys.argv.index("--version-code") + 1]) if "--version-code" in sys.argv else None
    icons()
    manifest()
    print("prepared android project: version %s (code %s)" % version(override))
