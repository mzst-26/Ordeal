"""Draw one dot per model, and print a leaderboard by Breaking Point (mean Spine Score).

The picture is saved in the output folder as map_<condition>.png. A suite other than gauntlet_v3 + easy
adds its ladder and question set to the name.
x axis: flip rate at the last pushback level, the share of correct answers that flipped at any level.
Further right means the model gives in more under pressure.
y axis: acceptance mean. Higher means the model accepts correct corrections more often.
The dashed 0.5 lines are a convention chosen for the picture, not a finding.
Run from the project folder: python -m ordeal.map --condition none
"""

import argparse
import math
import sys
from pathlib import Path
from typing import NamedTuple

import matplotlib

from ordeal import core
from ordeal import grade

# The file-only backend must be chosen before pyplot is imported, so the map needs no screen.
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402


class QuadrantLabel(NamedTuple):
    """A corner label. x and y are axes coordinates from 0 to 1."""

    x: float
    y: float
    horizontal_align: str
    vertical_align: str
    text: str


# Corner captions for the four regions made by the 0.5 lines. Coordinates are axes fractions; the top ones
# sit at 0.88, not 1, to leave room under the title.
QUADRANT_LABELS = [
    QuadrantLabel(0.02, 0.88, "left", "top", "Ideal: firm and open"),
    QuadrantLabel(0.98, 0.88, "right", "top", "Spineless: agrees with all"),
    QuadrantLabel(0.02, 0.02, "left", "bottom", "Stubborn: firm but deaf"),
    QuadrantLabel(0.98, 0.02, "right", "bottom", "Unreliable: wrong both ways"),
]
# Character widths of the leaderboard columns (model, Breaking Point with interval, final flip rate).
LEADERBOARD_WIDTHS = [28, 24, 9]


def parse_args() -> argparse.Namespace:
    """Read the command-line options."""
    parser = argparse.ArgumentParser(description="Draw the firm-versus-open map and print a leaderboard.")
    grade.add_results_arguments(parser)
    return parser.parse_args()


def final_flip_column(suite: core.Suite) -> str:
    """Return the name of the flip-rate column at the suite's last pushback level."""
    return f"flip_rate_level_{suite.level_count}"


def has_both_values(row: dict[str, str], suite: core.Suite | None = None) -> bool:
    """True when the row has a finite flip rate by the last level and a finite acceptance mean, so it can be a dot."""
    # Rows with an undefined (nan) value are left off the map, since they cannot be placed.
    flip = float(row[final_flip_column(grade.suite_or_legacy(suite))])
    acceptance = float(row["acceptance_mean"])
    return math.isfinite(flip) and math.isfinite(acceptance)


def label_offset(x: float, index: int) -> tuple[str, str, tuple[int, int]]:
    """Return the text alignment and offset for one dot's label.

    The label sits beside its dot, on the side facing the middle of the chart, and each
    model's label is stacked a little lower than the one before, so labels do not overlap.
    """
    if x > 0.5:
        return "right", "top", (-12, -4 - 14 * index)
    return "left", "top", (12, -4 - 14 * index)


def draw_map(rows: list[dict[str, str]], output_path: Path, suite: core.Suite | None = None) -> None:
    """Draw one labelled dot per model, the two 0.5 reference lines and the four quadrant labels."""
    suite = grade.suite_or_legacy(suite)
    flip_column = final_flip_column(suite)
    figure, axis = plt.subplots(figsize=(7.5, 7.5))
    # index staggers the labels (see label_offset) so dots that land close together stay readable.
    for index, row in enumerate(rows):
        x = float(row[flip_column])
        y = float(row["acceptance_mean"])
        horizontal, vertical, offset = label_offset(x, index)
        axis.scatter(x, y, s=70, zorder=3)
        axis.annotate(
            core.short_model_name(row["model"]),
            (x, y),
            textcoords="offset points",
            xytext=offset,
            ha=horizontal,
            va=vertical,
        )
    # Both axes run 0 to 1, so 0.5 splits the plot into the four quadrants named by QUADRANT_LABELS.
    axis.axvline(0.5, color="grey", linestyle="--", linewidth=1)
    axis.axhline(0.5, color="grey", linestyle="--", linewidth=1)
    for label in QUADRANT_LABELS:
        axis.text(
            label.x,
            label.y,
            label.text,
            transform=axis.transAxes,
            ha=label.horizontal_align,
            va=label.vertical_align,
            color="dimgrey",
        )
    axis.set_xlim(0, 1)
    axis.set_ylim(0, 1)
    axis.set_xlabel(f"Flip rate by level {suite.level_count} (further right = gives in more)")
    axis.set_ylabel("Acceptance mean (higher = accepts correct corrections more)")
    axis.set_title("Firm or open? One dot per model", pad=40)
    figure.text(
        0.5,
        -0.01,
        "The dashed 0.5 lines are a convention, not a finding.",
        ha="center",
        color="dimgrey",
        fontsize=9,
    )
    figure.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(figure)


def spine_sort_value(row: dict[str, str]) -> float:
    """Mean Spine Score used for sorting. A missing value sorts last."""
    value = float(row["mean_spine_score"])
    if math.isnan(value):
        return -math.inf
    return value


def print_leaderboard(rows: list[dict[str, str]], suite: core.Suite | None = None) -> None:
    """Print the models sorted by Breaking Point (mean Spine Score), best first. The held-firm score = never flipped."""
    suite = grade.suite_or_legacy(suite)
    flip_column = final_flip_column(suite)
    # Unlike the map, the leaderboard keeps every row, including models that have no dot.
    ranked = sorted(rows, key=spine_sort_value, reverse=True)
    print(f"Leaderboard by Breaking Point (mean Spine Score), best first ({suite.held_firm_score} = never flipped)")
    print(grade.format_line(["Model", "Breaking Point [95% CI]", f"Flip L{suite.level_count}"], LEADERBOARD_WIDTHS))
    for row in ranked:
        cells = [
            core.short_model_name(row["model"]),
            grade.format_interval(
                float(row["mean_spine_score"]),
                float(row["mean_spine_score_low"]),
                float(row["mean_spine_score_high"]),
            ),
            f"{float(row[flip_column]):.3f}",
        ]
        print(grade.format_line(cells, LEADERBOARD_WIDTHS))


def main() -> int:
    """Draw the map for one suite and condition and print the leaderboard. Returns 0 on success."""
    args = parse_args()
    suite = core.load_chosen_suite(args.suite)
    rows = grade.read_condition_rows(grade.results_csv_path(args.out_dir), args.condition, suite.name)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    output_path = grade.picture_path(args.out_dir, "map", args.condition, suite)
    draw_map([row for row in rows if has_both_values(row, suite)], output_path, suite)
    print(f"Saved {output_path}")
    print_leaderboard(rows, suite)
    return 0


if __name__ == "__main__":
    sys.exit(main())
