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

    def test_up_and_down_colours_beat_the_table_text_colour(self):
        # ".tbl td { color: var(--text) }" outweighs a bare ".up", which once left every change cell in a table dark instead of green/red
        self.assertRegex(CSS, r"\.tbl td\.up[^{]*\{\s*color:\s*var\(--up\)")
        self.assertRegex(CSS, r"\.tbl td\.down[^{]*\{\s*color:\s*var\(--down\)")

    def test_tables_do_not_wrap_their_text(self):
        self.assertRegex(CSS, r"\.tbl th, \.tbl td \{ white-space: nowrap; \}")

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

    # ---- responsive: the layout must hold from a 280 px folded phone to a 4K display ----
    def test_grid_and_flex_children_may_shrink_so_nothing_widens_the_page(self):
        self.assertRegex(CSS, r"\.grid > \*[^{]*\{\s*min-width:\s*0")
        self.assertRegex(CSS, r"\.card, \.content[^{]*\{[^}]*min-width:\s*0")
        self.assertRegex(CSS, r"html, body \{\s*overflow-x:\s*clip")

    def test_breakpoints_cover_folded_phone_phone_tablet_and_large_screens(self):
        widths = {int(w) for w in re.findall(r"@media \(max-width:\s*(\d+)px\)", CSS)}
        self.assertTrue({340, 380, 640, 860, 1100} <= widths, widths)
        self.assertRegex(CSS, r"@media \(min-width:\s*1500px\)")
        self.assertRegex(CSS, r"@media \(min-width:\s*2200px\)")
        self.assertRegex(CSS, r"@media \(max-height:\s*520px\) and \(orientation:\s*landscape\)")

    def test_touch_targets_and_viewport(self):
        self.assertRegex(CSS, r"@media \(pointer: coarse\)[^{]*\{[^}]*\.th-btn")
        self.assertRegex(HTML, r'<meta name="viewport" content="[^"]*width=device-width')
        self.assertNotRegex(HTML, r"user-scalable=no|maximum-scale=1\b")   # pinch-zoom stays available

    def test_index_tiles_scroll_sideways_instead_of_wrapping(self):
        self.assertRegex(CSS, r"\.tick \{[^}]*flex:\s*none[^}]*white-space:\s*nowrap")


if __name__ == "__main__":
    unittest.main()
