"""Design-token checks: WCAG 2.2 AA contrast recomputed from the actual stylesheet, plus static accessibility rules
for the shell. No browser needed."""
import re
import unittest
from pathlib import Path

STATIC = Path(__file__).resolve().parent.parent / "src" / "marketlens" / "static"
CSS = (STATIC / "css" / "style.css").read_text()
HTML = (STATIC / "index.html").read_text()


def tokens(selector):
    m = re.search(re.escape(selector) + r"\s*\{(.*?)\n\}", CSS, re.S)
    return dict(re.findall(r"--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})", m.group(1)))


def lum(h):
    h = h.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    f = lambda c: c / 12.92 if c <= .03928 else ((c + .055) / 1.055) ** 2.4
    return .2126 * f(r) + .7152 * f(g) + .0722 * f(b)


def contrast(a, b):
    la, lb = sorted((lum(a), lum(b)), reverse=True)
    return (la + .05) / (lb + .05)


TEXT_PAIRS = [("text", "bg"), ("text", "surface"), ("text", "surface-2"), ("text-2", "surface"), ("text-muted", "surface"), ("text-muted", "bg"),
              ("text-muted", "surface-2"), ("brand-ink", "brand"), ("brand", "surface"), ("up", "surface"), ("up", "up-bg"), ("down", "surface"),
              ("down", "down-bg"), ("warn-text", "warn-bg"), ("text", "selection")]
UI_PAIRS = [("border-strong", "surface"), ("border-strong", "bg"), ("focus", "surface"), ("focus", "bg"), ("series-1", "surface"), ("series-2", "surface"),
            ("series-3", "surface"), ("series-4", "surface"), ("series-5", "surface"), ("series-6", "surface")]


class ContrastTests(unittest.TestCase):
    def check(self, theme, tok):
        for a, b in TEXT_PAIRS:
            self.assertGreaterEqual(contrast(tok[a], tok[b]), 4.5, f"{theme}: {a} on {b} = {contrast(tok[a], tok[b]):.2f}")
        for a, b in UI_PAIRS:
            self.assertGreaterEqual(contrast(tok[a], tok[b]), 3.0, f"{theme}: {a} on {b} = {contrast(tok[a], tok[b]):.2f}")

    def test_light_theme_meets_wcag_aa(self):
        self.check("light", tokens(":root"))

    def test_dark_theme_meets_wcag_aa(self):
        light = tokens(":root")
        dark = {**light, **tokens('[data-theme="dark"]')}
        self.check("dark", dark)

    def test_both_themes_define_the_same_semantic_tokens(self):
        light, dark = tokens(":root"), tokens('[data-theme="dark"]')
        self.assertFalse({"bg", "surface", "text", "brand", "up", "down"} - set(dark))
        self.assertTrue(set(dark) <= set(light))


class StylesheetRules(unittest.TestCase):
    def test_no_hard_coded_colours_outside_the_token_blocks(self):
        body = re.sub(r"(:root|\[data-theme=\"dark\"\])\s*\{.*?\n\}", "", CSS, flags=re.S)
        self.assertEqual(re.findall(r"#[0-9a-fA-F]{3,8}\b", body), [], "use var(--token) instead")
        self.assertEqual(re.findall(r"rgb\(", re.sub(r"--shadow[^;]*;", "", body)), [])

    def test_accessibility_rules_present(self):
        self.assertIn(":focus-visible", CSS)
        self.assertIn("prefers-reduced-motion: reduce", CSS)
        self.assertIn("font-variant-numeric: tabular-nums", CSS)
        self.assertIn("pointer: coarse", CSS)

    def test_no_web_fonts_or_external_assets(self):
        self.assertNotIn("@import", CSS)
        self.assertNotIn("@font-face", CSS)
        self.assertNotRegex(CSS + HTML, r"https?://(?!www\.w3\.org)")

    def test_page_shell_is_semantic_and_labelled(self):
        for needle in ('<html lang="en">', 'name="viewport"', 'class="skip"', "<header", "<nav", "<main", "<footer", 'aria-label="Main"',
                       'for="q"', 'role="status"', 'aria-expanded="false"', 'aria-controls="nav"'):
            self.assertIn(needle, HTML, needle)
        self.assertEqual(len(re.findall(r"<main", HTML)), 1)
        self.assertEqual(len(re.findall(r"<h1", HTML)), 0)   # each view renders its own single h1

    def test_every_form_control_in_the_shell_has_a_name(self):
        """A control is named by an aria-label, a <label for>, or (for buttons) its visible text. Icon-only buttons must use aria-label."""
        for m in re.finditer(r"<button\b([^>]*)>(.*?)</button>", HTML, re.S):
            attrs, inner = m.groups()
            visible = re.sub(r"<[^>]+>", "", inner).strip()
            self.assertTrue("aria-label=" in attrs or visible, f"unnamed button: {attrs}")
        for tag in re.findall(r"<input\b[^>]*>", HTML):
            ident = re.search(r'id="([^"]+)"', tag)
            self.assertTrue("aria-label=" in tag or (ident and f'for="{ident.group(1)}"' in HTML), f"unlabelled input: {tag}")

    def test_signed_in_chrome_exists_but_starts_hidden(self):
        self.assertRegex(HTML, r'id="logout"[^>]*class="[^"]*\bhide\b')
        self.assertRegex(HTML, r'id="whoami"[^>]*class="[^"]*\bhide\b')


if __name__ == "__main__":
    unittest.main()
