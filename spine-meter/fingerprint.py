"""Report which kind of pressure breaks each model, one axis at a time.

The fingerprint probes are sent by runner.py (--probes fingerprint) and saved in the cache. This script only reads
them: for each model and axis it calls grade.axis_flip_row, the function that writes probes.csv, then writes
fingerprint_table_<condition>.csv and fingerprint_<condition>.png. Nothing here calls the network.
The tampered-history axis is in the table under family "tampered" and is left out of the radar.
Run from this folder: python fingerprint.py --condition none
"""

import argparse
import csv
import sys
from pathlib import Path

import matplotlib
import numpy as np

import core
import grade

# The file-only backend must be chosen before pyplot is imported, so the chart needs no screen.
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

# File name starts; grade.picture_path adds the condition and suite to make the full name.
TABLE_PREFIX = "fingerprint_table"
PICTURE_PREFIX = "fingerprint_radar"
# The family name grade.flip_family gives to ordinary axes; tampered history gets another family.
FINGERPRINT_FAMILY = "fingerprint"
TABLE_COLUMNS = ["model", "axis", "family", "flip_rate", "low", "high", "n_units", "unparsed_share", "suite"]
NO_ROWS_MESSAGE = "No fingerprint replies saved for this suite and condition."
RADAR_TITLE = "Fingerprint radar: share of correct answers that flipped, by axis"
# Character widths of the printed table columns.
AXIS_COLUMN_WIDTH = 28
MODEL_COLUMN_WIDTH = 26
# Flip-rate values where the radar draws its grid rings.
RADAR_RING_STEPS = (0.25, 0.5, 0.75, 1.0)


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    """Read the command-line options."""
    parser = argparse.ArgumentParser(description="Report the fingerprint flip rate of each model, per axis.")
    grade.add_results_arguments(parser)
    parser.add_argument(
        "--cache",
        type=Path,
        default=core.CACHE_PATH,
        help="file of saved replies to read (default: %(default)s)",
    )
    return parser.parse_args(argv)


def fingerprint_axis_ids(suite: core.Suite) -> list[str]:
    """Return the ids of every single-shot axis in the suite's probe spec, in file order."""
    return [axis["id"] for axis in suite.probe_spec["axes"]]


def radar_axis_ids(axis_ids: list[str]) -> list[str]:
    """Return the axes that belong on the radar: every axis except tampered history."""
    return [axis_id for axis_id in axis_ids if grade.flip_family(axis_id) == FINGERPRINT_FAMILY]


def unparsed_share_at(units: list[grade.Unit], step: str) -> float:
    """Share of the units whose reply at this step has no readable answer letter."""
    unparsed = [unit for unit in units if unit.letters[step] is None]
    return grade.share(len(unparsed), len(units))


def axis_row(model: str, condition: str, axis_id: str, units: list[grade.Unit], config: dict) -> dict | None:
    """Return the flip-rate row of one model and one axis, or None when the model has no reply for that axis.

    The estimate and its interval come from grade.axis_flip_row, the same function that writes probes.csv.
    """
    # A model with no reply at this step simply has no row, rather than a row of nan.
    step = core.axis_probe_step(axis_id)
    if not any(step in unit.letters for unit in units):
        return None
    probe = grade.axis_flip_row(condition, model, axis_id, units, config)
    return {
        "model": model,
        "axis": axis_id,
        "family": probe["family"],
        "flip_rate": probe["estimate"],
        "low": probe["low"],
        "high": probe["high"],
        "n_units": probe["units"],
        "unparsed_share": unparsed_share_at(grade.probe_units_with(units, [step]), step),
    }


def build_rows(suite: core.Suite, records: list[dict], condition: str, config: dict) -> list[dict]:
    """Return one row per model and axis that has a saved fingerprint reply, in model then axis order.

    Units are built from every saved reply of the model, as grade.py does, so the rows match probes.csv exactly.
    """
    axis_ids = fingerprint_axis_ids(suite)
    questions_by_id = grade.index_questions(suite.questions)
    rows = []
    for model, model_records in grade.records_by_model(records, condition).items():
        units = grade.build_units(model_records, questions_by_id)
        for axis_id in axis_ids:
            row = axis_row(model, condition, axis_id, units, config)
            if row is not None:
                rows.append({**row, "suite": suite.name})
    return rows


def table_path(out_dir: Path, condition: str, suite: core.Suite) -> Path:
    """Return the path of the CSV table. It follows the picture naming, with a .csv extension."""
    return grade.picture_path(out_dir, TABLE_PREFIX, condition, suite).with_suffix(".csv")


def write_table(rows: list[dict], path: Path) -> None:
    """Write the rows as a CSV file with the TABLE_COLUMNS header."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=TABLE_COLUMNS)
        writer.writeheader()
        for row in rows:
            writer.writerow({name: grade.format_cell(row[name]) for name in TABLE_COLUMNS})


def axis_label(row: dict) -> str:
    """Return the axis name for the printed table. Tampered history is marked as its own family."""
    if row["family"] == FINGERPRINT_FAMILY:
        return row["axis"]
    return f"{row['axis']} [{row['family']}]"


def print_table(rows: list[dict]) -> None:
    """Print one row per axis and one column per model, each cell a flip rate with its 95 percent interval."""
    models = list(dict.fromkeys(row["model"] for row in rows))
    axis_rows = list(dict.fromkeys(row["axis"] for row in rows))
    by_key = {(row["model"], row["axis"]): row for row in rows}
    widths = [AXIS_COLUMN_WIDTH] + [MODEL_COLUMN_WIDTH] * len(models)
    print(grade.format_line(["Axis", *(core.short_model_name(model) for model in models)], widths))
    for axis_id in axis_rows:
        label = next(axis_label(row) for row in rows if row["axis"] == axis_id)
        values = []
        for model in models:
            row = by_key.get((model, axis_id))
            values.append("-" if row is None else grade.format_interval(row["flip_rate"], row["low"], row["high"]))
        print(grade.format_line([label, *values], widths))


def radar_series(rows: list[dict], axis_ids: list[str]) -> dict[str, list[float]]:
    """Return, per model, the flip rate on each radar axis, in axis order. A missing reply is nan."""
    by_key = {(row["model"], row["axis"]): row["flip_rate"] for row in rows}
    models = list(dict.fromkeys(row["model"] for row in rows))
    return {model: [by_key.get((model, axis_id), np.nan) for axis_id in axis_ids] for model in models}


def draw_radar(rows: list[dict], axis_ids: list[str], output_path: Path, suite: core.Suite, condition: str) -> bool:
    """Draw one polygon per model over the radar axes, flip rate 0 to 1, then save the picture.

    Returns False and writes nothing when there are no fingerprint rows for the radar.
    """
    radar_rows = [row for row in rows if row["family"] == FINGERPRINT_FAMILY]
    if not radar_rows:
        return False
    series = radar_series(radar_rows, axis_ids)
    # One evenly spaced angle per axis. The first point is repeated at the end so each polygon closes.
    angles = np.linspace(0, 2 * np.pi, len(axis_ids), endpoint=False)
    closed_angles = np.append(angles, angles[:1])
    figure = plt.figure(figsize=(8, 8))
    axis = figure.add_subplot(projection="polar")
    for model, values in series.items():
        closed_values = values + values[:1]
        line = axis.plot(closed_angles, closed_values, marker="o", label=core.short_model_name(model))[0]
        axis.fill(closed_angles, closed_values, color=line.get_color(), alpha=0.1)
    # Put the first axis at the top and run clockwise, the usual way to read a radar chart.
    axis.set_theta_offset(np.pi / 2)
    axis.set_theta_direction(-1)
    axis.set_xticks(angles)
    axis.set_xticklabels(axis_ids, fontsize=8)
    axis.set_ylim(0, 1)
    axis.set_yticks(RADAR_RING_STEPS)
    # The default (legacy) suite keeps the plain title; other suites name themselves and the condition.
    title = RADAR_TITLE if grade.is_legacy_suite(suite) else f"{RADAR_TITLE} ({suite.name}, {condition})"
    axis.set_title(title, pad=20)
    # Legend sits outside the plot, to the right; bbox_inches="tight" below keeps it in the saved picture.
    axis.legend(loc="upper left", bbox_to_anchor=(1.05, 1.0))
    figure.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(figure)
    return True


def main(argv: list[str] | None = None) -> int:
    """Read the fingerprint replies of one suite and condition, then write the table and the radar.

    Returns 0, including when there are no fingerprint rows (then nothing is written).
    """
    args = parse_args(argv)
    config = core.load_config()
    suite = core.load_suite(ladder=args.ladder, questions=args.questions)
    # Only replies saved under this suite's experiment code are read, so other wordings never mix in.
    records = list(core.load_cache(args.cache, experiment=suite.experiment).values())
    rows = build_rows(suite, records, args.condition, config)
    if not rows:
        print(NO_ROWS_MESSAGE)
        return 0
    args.out_dir.mkdir(parents=True, exist_ok=True)
    csv_path = table_path(args.out_dir, args.condition, suite)
    write_table(rows, csv_path)
    print_table(rows)
    picture_path = grade.picture_path(args.out_dir, PICTURE_PREFIX, args.condition, suite)
    draw_radar(rows, radar_axis_ids(fingerprint_axis_ids(suite)), picture_path, suite, args.condition)
    print(f"Saved {csv_path}")
    print(f"Saved {picture_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
