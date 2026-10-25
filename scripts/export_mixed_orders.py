"""Write the mixed run orders for seeds 1 to 10 into site/data/mixed/, one JSON file per seed.

The browser reads these files, so the site shows the same order that Python runs. Each file is made by
mix.order_document, the same rule the runner and the tests use. Only site/data/mixed/ is written.
Usage (from the project folder): python scripts/export_mixed_orders.py
"""

import json
import sys
from pathlib import Path

# Running this file directly puts scripts/ on sys.path, so the project folder must be added to find the ordeal package.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ordeal import core  # noqa: E402
from ordeal import mix  # noqa: E402

# The seeds the site offers. A run picks one of these, so each one needs its own file.
SEEDS = range(1, 11)
# Where the browser looks for the files. Only this folder is written.
OUT_DIR = core.PROJECT_DIR / "site" / "data" / "mixed"


def main() -> int:
    """Write one file per seed. Each file holds the seed, its counts and the full order of all 91 questions."""
    # The full lists are used, not a --limit, so every exported order has all 91 questions.
    easy = core.load_questions(core.DATA_DIR / core.QUESTION_FILES["easy"])
    hard = core.load_questions(core.DATA_DIR / core.QUESTION_FILES["hard"])
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for seed in SEEDS:
        document = mix.order_document(seed, easy, hard)
        path = OUT_DIR / f"mixed_{seed}.json"
        # Written with a trailing newline and UTF-8, so the files diff cleanly in git.
        path.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"Wrote {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
