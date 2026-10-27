"""The reply store: a SQLite database that keeps every saved model reply.

Why this exists: the old cache was a JSONL file that grew by one line per reply. Finding one reply meant reading
the whole file, and a crash could leave a half-written line. SQLite gives an indexed lookup on the reply key,
and each reply is committed as soon as it arrives, so a crash loses at most the reply that was being written.

The database sits next to the JSONL cache path. A cache called results/cache.jsonl keeps its replies in
results/cache.sqlite. The JSONL file is still the format that grade and the other tools understand, so
export_jsonl writes the same lines that core.load_cache reads.
"""

import json
import sqlite3
from pathlib import Path

# The table holds one row per saved reply. The primary key is the reply's identity, and SQLite builds an
# index for it, so a lookup by key does not scan the table. 'record' is the whole saved record as JSON text.
CREATE_REPLIES_SQL = """
CREATE TABLE IF NOT EXISTS replies (
    experiment TEXT NOT NULL,
    condition TEXT NOT NULL,
    model TEXT NOT NULL,
    question_id TEXT NOT NULL,
    repeat INTEGER NOT NULL,
    step TEXT NOT NULL,
    record TEXT NOT NULL,
    PRIMARY KEY (experiment, condition, model, question_id, repeat, step)
)
"""

# The order of the key columns above. Every query that builds a key uses this order.
KEY_FIELDS = ("experiment", "condition", "model", "question_id", "repeat", "step")


def store_path_for(cache_path: Path) -> Path:
    """Return the database file that goes with a JSONL cache path, such as cache.jsonl -> cache.sqlite.

    The database keeps the same name and folder as the JSONL file, so each cache file has exactly one store,
    and the runs that use different cache files never share replies.
    """
    return cache_path.with_suffix(".sqlite")


def key_values(record: dict) -> tuple:
    """Return the six key values of a saved record, in the order of KEY_FIELDS."""
    # The key is taken from the record itself, so the reply is filed under the same key a reader will ask for.
    return tuple(record[field] for field in KEY_FIELDS)


class ReplyStore:
    """An open connection to one reply database file.

    Use it with 'with' so the connection is always closed. Each add call is committed before it returns.
    """

    def __init__(self, path: Path):
        """Open the database file, creating it and its table on first use."""
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        # isolation_level=None means each statement is committed by itself as soon as it runs. That is what
        # makes a reply durable the moment add returns, instead of waiting for a later commit.
        self.connection = sqlite3.connect(path, isolation_level=None)
        # WAL mode lets a reader (such as grade) look at the file while a run is still writing a reply.
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute(CREATE_REPLIES_SQL)

    def __enter__(self) -> "ReplyStore":
        """Return the store itself, so 'with' can be used."""
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        """Close the connection when the 'with' block ends, even if it failed."""
        self.close()

    def close(self) -> None:
        """Close the database connection."""
        self.connection.close()

    def add(self, record: dict) -> None:
        """Save one reply. A reply with the same key replaces the earlier one, as the JSONL cache did."""
        # The record is stored as text so export_jsonl can write back exactly the line that was saved.
        text = json.dumps(record, ensure_ascii=False)
        self.connection.execute(
            "INSERT OR REPLACE INTO replies (experiment, condition, model, question_id, repeat, step, record) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (*key_values(record), text),
        )

    def records_for_experiment(self, experiment: str) -> list[dict]:
        """Return every saved reply for one experiment code, in the order they were saved."""
        rows = self.connection.execute(
            "SELECT record FROM replies WHERE experiment = ? ORDER BY rowid", (experiment,)
        ).fetchall()
        return [json.loads(row[0]) for row in rows]

    def count_other_experiments(self, experiment: str) -> int:
        """Return how many saved replies belong to an experiment code other than the one given."""
        row = self.connection.execute("SELECT COUNT(*) FROM replies WHERE experiment != ?", (experiment,)).fetchone()
        return row[0]

    def export_jsonl(self, out_path: Path) -> int:
        """Write every saved reply to out_path, one JSON object per line, and return how many were written.

        The lines are the same ones core.load_cache reads, so grade and the other readers can use the export.
        """
        rows = self.connection.execute("SELECT record FROM replies ORDER BY rowid").fetchall()
        with open(out_path, "w", encoding="utf-8") as file:
            for row in rows:
                file.write(row[0] + "\n")
        return len(rows)
