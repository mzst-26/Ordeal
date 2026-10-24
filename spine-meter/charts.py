"""Draw the Breaking Point at each pushback level, one line per model, and the fingerprint probe bars.

The pictures are saved in the output folder (results/ by default): flip_by_level_<condition>.png and
fingerprint_<condition>.png. A suite other than gauntlet_v3 + easy adds its ladder and question set to the names.
Each shaded band is that model's 95 percent interval. Run from this folder: python charts.py --condition none
"""

import argparse
import sys
from pathlib import Path

import matplotlib

import core
import grade

# The file-only backend must be chosen before pyplot is imported, so the chart needs no screen.
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

# These two values pick out the probe rows used for the bars in probes.csv (the "family" and "measure" columns).
FINGERPRINT_FAMILY = "fingerprint"
FLIP_MEASURE = "flip_rate"
CHART_TITLE = "Breaking Point: share of correct answers that flipped, by pushback level"


def parse_args() -> argparse.Namespace:
    """Read the command-line options."""
    parser = argparse.ArgumentParser(description="Draw the Breaking Point by pushback level and the fingerprint bars.")
    grade.add_results_arguments(parser)
    return parser.parse_args()


def read_flip_series(
    row: dict[str, str], level_count: int = grade.V3_LEVEL_COUNT
) -> tuple[list[float], list[float], list[float]]:
    """Return the flip rates, lower bounds and upper bounds for levels 1 to level_count, as numbers."""
    # Values come from the CSV as text, hence float(); a column missing for a level raises KeyError.
    levels = range(1, level_count + 1)
    rates = [float(row[f"flip_rate_level_{level}"]) for level in levels]
    lows = [float(row[f"flip_rate_level_{level}_low"]) for level in levels]
    highs = [float(row[f"flip_rate_level_{level}_high"]) for level in levels]
    return rates, lows, highs


def draw_chart(rows: list[dict[str, str]], output_path: Path, suite: core.Suite | None = None) -> None:
    """Draw one line per model with its shaded 95 percent band, then save the picture."""
    suite = grade.suite_or_legacy(suite)
    level_numbers = list(range(1, suite.level_count + 1))
    figure, axis = plt.subplots(figsize=(9, 5.5))
    # One line per model, with the band drawn in the same colour as its line.
    for row in rows:
        rates, lows, highs = read_flip_series(row, suite.level_count)
        line = axis.plot(level_numbers, rates, marker="o", label=core.short_model_name(row["model"]))[0]
        axis.fill_between(level_numbers, lows, highs, color=line.get_color(), alpha=0.2)
    axis.set_xticks(level_numbers)
    if suite.level_count <= grade.V3_LEVEL_COUNT:
        tick_labels = [f"Level {level}" for level in level_numbers]
    else:
        # "Level N" labels would overlap on a longer ladder, so it gets bare numbers.
        tick_labels = [str(level) for level in level_numbers]
    axis.set_xticklabels(tick_labels)
    # Rates are shares, so the y axis is fixed to 0..1 and charts from different runs compare directly.
    axis.set_ylim(0, 1)
    axis.set_xlabel("Pushback level")
    axis.set_ylabel("Flip rate (share of correct answers that flipped)")
    title = CHART_TITLE if grade.is_legacy_suite(suite) else f"{CHART_TITLE} ({suite.name})"
    axis.set_title(title)
    axis.grid(alpha=0.3)
    axis.legend()
    figure.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(figure)


def is_fingerprint_flip(row: dict[str, str]) -> bool:
    """True for a probe row that holds the flip rate of a fingerprint probe."""
    return row["family"] == FINGERPRINT_FAMILY and row["measure"] == FLIP_MEASURE


def error_bar_lengths(row: dict[str, str]) -> tuple[float, float]:
    """Return the error bar lengths below and above the estimate. A bar never reaches below zero."""
    estimate = float(row["estimate"])
    return max(0.0, estimate - float(row["low"])), max(0.0, float(row["high"]) - estimate)


def draw_model_bars(
    axis, model_rows: list[dict[str, str]], probe_names: list[str], x_offset: float, bar_width: float
) -> None:
    """Draw one model's bar for each of its probes, with an error bar from low to high."""
    # Bars for different models share one probe slot, so x_offset shifts this model's bars sideways.
    positions = [probe_names.index(row["probe"]) + x_offset for row in model_rows]
    estimates = [float(row["estimate"]) for row in model_rows]
    lower_errors, upper_errors = zip(*(error_bar_lengths(row) for row in model_rows))
    axis.bar(
        positions,
        estimates,
        bar_width,
        yerr=[lower_errors, upper_errors],
        capsize=3,
        label=core.short_model_name(model_rows[0]["model"]),
    )


def draw_fingerprint(rows: list[dict[str, str]], output_path: Path) -> bool:
    """Draw grouped bars of the fingerprint flip rate, one group per probe, then save the picture.

    Returns False and writes nothing when the rows hold no fingerprint flip rates.
    """
    fingerprint_rows = [row for row in rows if is_fingerprint_flip(row)]
    if not fingerprint_rows:
        return False
    probe_names = list(dict.fromkeys(row["probe"] for row in fingerprint_rows))
    models = sorted({row["model"] for row in fingerprint_rows})
    # Each probe slot is 1 unit wide; the model bars share 0.8 of it, leaving a gap between probe groups.
    bar_width = 0.8 / len(models)
    figure, axis = plt.subplots(figsize=(9, 5.5))
    for model_index, model in enumerate(models):
        model_rows = [row for row in fingerprint_rows if row["model"] == model]
        # Centres the whole group of bars on the probe's tick.
        x_offset = (model_index - (len(models) - 1) / 2) * bar_width
        draw_model_bars(axis, model_rows, probe_names, x_offset, bar_width)
    axis.set_xticks(range(len(probe_names)))
    axis.set_xticklabels(probe_names)
    axis.set_ylim(0, 1)
    axis.set_xlabel("Fingerprint probe")
    axis.set_ylabel("Flip rate (share of correct answers that flipped)")
    axis.set_title("Fingerprint probes: share of correct answers that flipped")
    axis.grid(axis="y", alpha=0.3)
    axis.legend()
    figure.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(figure)
    return True


def save_fingerprint_picture(args: argparse.Namespace, suite: core.Suite) -> None:
    """Draw the fingerprint bars from the probes file, or print why the picture was skipped."""
    # read_probe_rows stops with a message when the file or its rows are missing. The line chart must still be drawn.
    try:
        probe_rows = grade.read_probe_rows(grade.probes_csv_path(args.out_dir), args.condition, suite.name)
    except SystemExit as stop:
        print(f"Skipped fingerprint picture: {stop.code}")
        return
    fingerprint_path = grade.picture_path(args.out_dir, "fingerprint", args.condition, suite)
    if draw_fingerprint(probe_rows, fingerprint_path):
        print(f"Saved {fingerprint_path}")
    else:
        print("Skipped fingerprint picture: no fingerprint flip rates for this condition.")


def main() -> int:
    """Read the results for one suite and condition and save the pictures. Returns 0 on success."""
    args = parse_args()
    suite = core.load_suite(ladder=args.ladder, questions=args.questions)
    rows = grade.read_condition_rows(grade.results_csv_path(args.out_dir), args.condition, suite.name)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    output_path = grade.picture_path(args.out_dir, "flip_by_level", args.condition, suite)
    draw_chart(rows, output_path, suite)
    print(f"Saved {output_path}")
    save_fingerprint_picture(args, suite)
    return 0


if __name__ == "__main__":
    sys.exit(main())
