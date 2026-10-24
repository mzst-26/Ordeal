"""Check WCAG contrast ratios for the Field Notes colour pairs defined in site/css/tokens.css."""

import re
import sys
from pathlib import Path

TOKENS_PATH = Path(__file__).resolve().parent.parent / "site" / "css" / "tokens.css"
TEXT_MINIMUM = 4.5
UI_MINIMUM = 3.0

# Each pair: (label, foreground token, background token, minimum ratio)
TEXT_PAIRS = [
    ("ink on paper", "ink", "paper", TEXT_MINIMUM),
    ("ink-soft on paper", "ink-soft", "paper", TEXT_MINIMUM),
    ("ink-mute on paper", "ink-mute", "paper", TEXT_MINIMUM),
    ("teal on paper", "teal", "paper", TEXT_MINIMUM),
    ("terracotta on paper", "terracotta", "paper", TEXT_MINIMUM),
    ("ochre on paper", "ochre", "paper", TEXT_MINIMUM),
    ("sage on paper", "sage", "paper", TEXT_MINIMUM),
    ("plum on paper", "plum", "paper", TEXT_MINIMUM),
    ("paper on teal (button text)", "paper", "teal", TEXT_MINIMUM),
    ("ink on clay", "ink", "clay", TEXT_MINIMUM),
]

# Control outlines, icons and chart series marks must reach 3:1 against the paper colour
UI_PAIRS = [
    ("edge on paper (control outline)", "edge", "paper", UI_MINIMUM),
    ("cat-1 on paper (chart series 1)", "cat-1", "paper", UI_MINIMUM),
    ("cat-2 on paper (chart series 2)", "cat-2", "paper", UI_MINIMUM),
    ("cat-3 on paper (chart series 3)", "cat-3", "paper", UI_MINIMUM),
]

# The three colour blocks in tokens.css: light, dark forced with data-theme, and dark chosen by the OS setting
THEMES = ["light", "forced dark", "OS dark"]


def read_tokens_text(path):
    """Return the full text of the tokens stylesheet."""
    return Path(path).read_text(encoding="utf-8")


def find_light_block(css_text):
    """Return the declarations of the first plain :root block (the light theme)."""
    match = re.search(r"^:root\s*\{([^}]*)\}", css_text, re.MULTILINE)
    if match is None:
        raise SystemExit("Could not find the light :root block in tokens.css")
    return match.group(1)


def find_dark_block(css_text):
    """Return the declarations of the :root[data-theme=\"dark\"] block (the dark theme)."""
    match = re.search(r':root\[data-theme="dark"\]\s*\{([^}]*)\}', css_text)
    if match is None:
        raise SystemExit('Could not find the :root[data-theme="dark"] block in tokens.css')
    return match.group(1)


def find_os_dark_block(css_text):
    """Return the declarations of the dark block used when the OS asks for dark (inside the media query)."""
    match = re.search(
        r'@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([^}]*)\}',
        css_text,
    )
    if match is None:
        raise SystemExit("Could not find the OS dark block (prefers-color-scheme: dark) in tokens.css")
    return match.group(1)


def parse_colours(block_text):
    """Return a dict mapping token names (without --) to their six-digit hex values."""
    colours = {}
    # Digits are allowed so names such as cat-1 are read
    for name, value in re.findall(r"--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;", block_text):
        colours[name] = value.upper()
    return colours


def hex_to_rgb(hex_value):
    """Convert a hex colour such as #F5EFE3 into a tuple of three integers from 0 to 255."""
    digits = hex_value.lstrip("#")
    return tuple(int(digits[index:index + 2], 16) for index in (0, 2, 4))


def channel_to_linear(channel_value):
    """Convert one 0-255 colour channel into linear light, as WCAG defines it."""
    scaled = channel_value / 255
    if scaled <= 0.03928:
        return scaled / 12.92
    return ((scaled + 0.055) / 1.055) ** 2.4


def relative_luminance(hex_value):
    """Return the WCAG relative luminance of a hex colour, from 0 (black) to 1 (white)."""
    red, green, blue = (channel_to_linear(channel) for channel in hex_to_rgb(hex_value))
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue


def contrast_ratio(first_hex, second_hex):
    """Return the WCAG contrast ratio between two hex colours, from 1 to 21."""
    first = relative_luminance(first_hex)
    second = relative_luminance(second_hex)
    lighter = max(first, second)
    darker = min(first, second)
    return (lighter + 0.05) / (darker + 0.05)


def get_colour(colours, token_name, theme_name):
    """Return the hex value of one token, or stop with a clear message if it is missing."""
    if token_name not in colours:
        raise SystemExit(f"Token --{token_name} is missing from the {theme_name} theme in tokens.css")
    return colours[token_name]


def check_pair(colours, theme_name, pair):
    """Return one result row for a (label, foreground, background, minimum) pair."""
    label, foreground_name, background_name, minimum = pair
    foreground = get_colour(colours, foreground_name, theme_name)
    background = get_colour(colours, background_name, theme_name)
    ratio = contrast_ratio(foreground, background)
    return {
        "theme": theme_name,
        "label": label,
        "foreground": foreground,
        "background": background,
        "ratio": ratio,
        "minimum": minimum,
        "passed": ratio >= minimum,
    }


def check_theme(colours, theme_name):
    """Return result rows for every text and UI pair in one theme."""
    rows = [check_pair(colours, theme_name, pair) for pair in TEXT_PAIRS]
    rows += [check_pair(colours, theme_name, pair) for pair in UI_PAIRS]
    return rows


def load_all_colours(css_text):
    """Return the colour dicts for the light, forced dark and OS dark blocks, keyed by theme name."""
    return {
        "light": parse_colours(find_light_block(css_text)),
        "forced dark": parse_colours(find_dark_block(css_text)),
        "OS dark": parse_colours(find_os_dark_block(css_text)),
    }


def print_table(rows):
    """Print one line per pair with its ratio, the minimum and PASS or FAIL."""
    header = f"{'theme':<11} {'pair':<34} {'fg/bg':<17} {'ratio':>7} {'min':>5}  result"
    print(header)
    print("-" * len(header))
    for row in rows:
        colour_pair = f"{row['foreground']}/{row['background']}"
        status = "PASS" if row["passed"] else "FAIL"
        print(f"{row['theme']:<11} {row['label']:<34} {colour_pair:<17} "
              f"{row['ratio']:>6.2f}:1 {row['minimum']:>4.1f}  {status}")


def count_passes(rows):
    """Return how many rows passed."""
    return sum(1 for row in rows if row["passed"])


def main():
    """Run every check, print the table and exit with 1 if any pair fails."""
    css_text = read_tokens_text(TOKENS_PATH)
    all_colours = load_all_colours(css_text)
    rows = []
    for theme_name in THEMES:
        rows += check_theme(all_colours[theme_name], theme_name)
    print_table(rows)
    passed = count_passes(rows)
    print()
    print(f"{passed} of {len(rows)} pairs passed.")
    return 0 if passed == len(rows) else 1


if __name__ == "__main__":
    sys.exit(main())
