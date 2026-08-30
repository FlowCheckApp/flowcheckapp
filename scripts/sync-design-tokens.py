#!/usr/bin/env python3
"""
sync-design-tokens.py — one source of truth for both apps' design tokens.

FlowCheck ships twice: the Capacitor web app (Android) and the SwiftUI app
(iOS). They render through completely different systems, but they are the same
product and must not look like two products. Colour, type, radius and spacing
are the layer where that is achievable — and where it was being maintained by
hand, in two places, with nothing checking.

CLAUDE.md already names the authority:

    "Read the values out of `flowcheck-design-system.css`, not out of this
     file. The list above is a summary and has been wrong before."

This script makes that literal. The stylesheet is the source; the Xcode asset
catalog is generated from it.

    python3 scripts/sync-design-tokens.py            # verify (CI)
    python3 scripts/sync-design-tokens.py --write    # regenerate colorsets

WHAT IS GENERATED AND WHAT IS ONLY CHECKED

Colorsets are pure data with no reasoning in them, so they are GENERATED —
hand-editing one is how a typo ships. The Swift scale in FlowCheckTheme.swift
is CHECKED but never rewritten, because it carries the reasoning that makes it
usable ("11vw is below 44 at every iPhone width, so the clamp's floor is what
renders on phone"). Generating over that prose would trade a real explanation
for a saved keystroke.

FAILS CLOSED. A colorset with no entry in SOURCE below is an error, not a
skip — otherwise adding a colour to the catalog quietly opts it out of the
only thing keeping the two apps together. The check this replaces covered
nine of eighteen colorsets and only their dark values; it passed while the
other nine were unverified.

WHAT THIS DOES NOT DO

It syncs tokens, not screens. There is no mechanism that turns a SwiftUI view
into HTML — the two have different layout models, and anything claiming
otherwise is a rewrite in disguise. Structure stays in step through the
ratchets (check-canonical-chrome.js, check-design-system.py) and through the
shared backend, not through code generation.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSS = os.path.join(ROOT, "www", "css", "flowcheck-design-system.css")
ASSETS = os.path.join(
    ROOT, "FlowCheckSwiftUI", "FlowCheckSwiftUI", "Resources", "Assets.xcassets"
)
THEME = os.path.join(
    ROOT, "FlowCheckSwiftUI", "FlowCheckSwiftUI", "Core", "Design", "FlowCheckTheme.swift"
)

# colorset name -> the CSS custom property it mirrors.
SOURCE = {
    "FCBackground": "--fc-bg",
    "FCSurface": "--fc-bg-elevated",
    "FCSurfaceRaised": "--fc-bg-elevated-2",
    "FCAccent": "--fc-accent",
    "FCAccentInk": "--fc-accent-ink",
    "FCElectric": "--fc-electric",
    "FCText": "--fc-text",
    "FCTextMuted": "--fc-text-muted",
    "FCTextFaint": "--fc-text-faint",
    "FCSuccess": "--fc-success",
    "FCWarning": "--fc-warning",
    "FCDanger": "--fc-danger",
    "FCStroke": "--fc-border",
    "FCGlass": "--fc-glass",
    "FCMedalGold": "--fc-medal-gold",
    "FCMedalSilver": "--fc-medal-silver",
    "FCMedalBronze": "--fc-medal-bronze",
    "FCMedalInk": "--fc-medal-ink",
}

# Swift scale constant -> CSS property. Checked, never rewritten.
TYPE_SCALE = {
    "hero": "--fc-text-hero",
    "h1": "--fc-text-h1",
    "h2": "--fc-text-h2",
    "h3": "--fc-text-h3",
    "body": "--fc-text-body",
    "small": "--fc-text-sm",
    "xSmall": "--fc-text-xs",
}
RADIUS_SCALE = {
    "small": "--fc-r-sm",
    "medium": "--fc-r-md",
    "large": "--fc-r-lg",
    "xLarge": "--fc-r-xl",
    "pill": "--fc-r-pill",
}
SPACING_SCALE = {f"s{n}": f"--fc-s-{n}" for n in (1, 2, 3, 4, 5, 6, 8, 10)}


def theme_block(css, selector):
    """The declarations inside one rule. `:root` is LIGHT; dark is the
    [data-theme] block — the stylesheet is light-first and CLAUDE.md has been
    wrong about this before."""
    start = css.index(selector)
    end = css.index("}", start)
    return dict(re.findall(r"(--fc-[a-z0-9-]+)\s*:\s*([^;]+);", css[start:end]))


def parse_color(value):
    """`#rrggbb` or `rgba(r, g, b, a)` -> (r, g, b, alpha)."""
    value = value.strip()
    hexmatch = re.fullmatch(r"#([0-9a-fA-F]{6})", value)
    if hexmatch:
        h = hexmatch.group(1)
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 1.0)
    rgba = re.fullmatch(r"rgba?\(([^)]+)\)", value)
    if rgba:
        parts = [p.strip() for p in rgba.group(1).split(",")]
        r, g, b = (int(float(p)) for p in parts[:3])
        a = float(parts[3]) if len(parts) > 3 else 1.0
        return (r, g, b, a)
    return None


def contents_json(light, dark):
    """The shape Xcode writes."""
    def entry(rgba, is_dark):
        r, g, b, a = rgba
        color = {
            "color-space": "srgb",
            "components": {
                "alpha": f"{a:.3f}",
                "red": f"0x{r:02X}",
                "green": f"0x{g:02X}",
                "blue": f"0x{b:02X}",
            },
        }
        item = {"color": color, "idiom": "universal"}
        if is_dark:
            item["appearances"] = [{"appearance": "luminosity", "value": "dark"}]
        return item

    return {
        "colors": [entry(light, False), entry(dark, True)],
        "info": {"author": "xcode", "version": 1},
    }


def catalog_colors(doc):
    """A colorset's two appearances as (r, g, b, alpha) tuples.

    Compared as VALUES rather than as serialized text. Xcode writes no
    trailing newline and may reorder keys between versions; neither says
    anything about whether the two apps agree on the colour, which is the
    only thing this check is for."""
    out = {}
    for item in doc.get("colors", []):
        is_dark = any(a.get("value") == "dark" for a in item.get("appearances", []))
        comp = item.get("color", {}).get("components")
        if not comp:
            continue
        out["dark" if is_dark else "light"] = (
            int(comp["red"], 16), int(comp["green"], 16), int(comp["blue"], 16),
            float(comp.get("alpha", 1)),
        )
    return out


def fmt(rgba):
    if not rgba:
        return "(missing)"
    r, g, b, a = rgba
    return f"#{r:02x}{g:02x}{b:02x}" + ("" if a == 1 else f"@{a:g}")


def css_number(css, var):
    """A px value, or the floor of a clamp()."""
    match = re.search(re.escape(var) + r"\s*:\s*([^;]+);", css)
    if not match:
        return None
    value = match.group(1).strip()
    clamp = re.match(r"clamp\(\s*([0-9.]+)px", value)
    if clamp:
        return float(clamp.group(1))
    px = re.match(r"([0-9.]+)px", value)
    return float(px.group(1)) if px else None


def main():
    write = "--write" in sys.argv
    css = open(CSS).read()
    light = theme_block(css, ":root {")
    dark = theme_block(css, '[data-theme="dark"] {')

    problems = []
    written = 0
    checked = 0

    catalog = sorted(n for n in os.listdir(ASSETS) if n.endswith(".colorset"))
    for folder in catalog:
        name = folder[: -len(".colorset")]
        var = SOURCE.get(name)
        if var is None:
            problems.append(
                f"{name}.colorset has no entry in SOURCE. Add the CSS property it "
                f"mirrors — a colour the stylesheet does not define is a colour "
                f"the two apps can disagree about."
            )
            continue

        light_raw, dark_raw = light.get(var), dark.get(var)
        if light_raw is None or dark_raw is None:
            missing = "light (:root)" if light_raw is None else 'dark ([data-theme="dark"])'
            problems.append(f"{var} is not defined in the {missing} theme, but {name} needs it.")
            continue

        want_light, want_dark = parse_color(light_raw), parse_color(dark_raw)
        if not want_light or not want_dark:
            problems.append(f"{var} is not a colour this script can read: {light_raw!r} / {dark_raw!r}")
            continue

        path = os.path.join(ASSETS, folder, "Contents.json")
        try:
            have = catalog_colors(json.load(open(path)))
        except (OSError, ValueError, KeyError) as err:
            problems.append(f"{name}.colorset could not be read: {err}")
            continue

        if have == {"light": want_light, "dark": want_dark}:
            checked += 1
            continue
        if write:
            # Xcode writes no trailing newline; match it so a regeneration
            # leaves the file byte-identical to what the IDE would produce.
            open(path, "w").write(json.dumps(contents_json(want_light, want_dark), indent=2))
            written += 1
        else:
            problems.append(
                f"{name}.colorset does not match {var} — "
                f"light {fmt(have.get('light'))} vs {fmt(want_light)}, "
                f"dark {fmt(have.get('dark'))} vs {fmt(want_dark)}. Run "
                f"`python3 scripts/sync-design-tokens.py --write`."
            )

    # The Swift scale: checked, never rewritten.
    theme = open(THEME).read()
    for scale, table, pattern in (
        ("FCType", TYPE_SCALE, r"static let {}\s*=\s*Style\(size: ([0-9.]+)"),
        ("FCRadius", RADIUS_SCALE, r"static let {}: CGFloat = ([0-9.]+)"),
        ("FCSpacing", SPACING_SCALE, r"static let {}: CGFloat = ([0-9.]+)"),
    ):
        for const, var in table.items():
            match = re.search(pattern.format(re.escape(const)), theme)
            want = css_number(css, var)
            if want is None:
                problems.append(f"{var} is missing from the stylesheet, but {scale}.{const} mirrors it.")
                continue
            if match is None:
                problems.append(f"{scale}.{const} is gone from FlowCheckTheme.swift, but {var} still defines it.")
                continue
            got = float(match.group(1))
            checked += 1
            if got != want:
                problems.append(
                    f"{scale}.{const} is {got:g} but {var} is {want:g}. "
                    f"The stylesheet is the source — change the Swift constant."
                )

    if problems:
        print("design tokens are out of sync:\n")
        for p in problems:
            print(f"  ✗ {p}")
        print(f"\n{len(problems)} problem(s).")
        return 1

    if write:
        print(f"design tokens: {written} colorset(s) rewritten, {checked} already correct")
    else:
        print(f"design tokens: {len(catalog)} colorsets + {len(TYPE_SCALE)} type + "
              f"{len(RADIUS_SCALE)} radii + {len(SPACING_SCALE)} spacing steps")
        print("✓ the web stylesheet and the SwiftUI app agree, in both themes.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
