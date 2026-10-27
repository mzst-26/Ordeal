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
import sys
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

# A small table of facts about the store itself. It holds one flag: whether the old JSONL file was copied in.
CREATE_META_SQL = "CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT NOT NULL)"

# The name of the flag that says the one-time import has already run for this store.
IMPORT_FLAG = "legacy_jsonl_imported"


class ImportMismatch(Exception):
    """Raised when the store does not hold exactly the replies read from the JSONL file.

    The import is then rolled back, so a half-copied store is never kept.
    """


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
        self.connection.execute(CREATE_META_SQL)

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

    def count_rows(self) -> int:
        """Return how many replies the store holds, across all experiment codes."""
        return self.connection.execute("SELECT COUNT(*) FROM replies").fetchone()[0]

    def all_keys(self) -> set[tuple]:
        """Return the key of every saved reply, as a set of key tuples in the order of KEY_FIELDS."""
        rows = self.connection.execute("SELECT experiment, condition, model, question_id, repeat, step FROM replies")
        return set(rows.fetchall())

    def has_meta(self, name: str) -> bool:
        """Return True when the store has the named flag set."""
        row = self.connection.execute("SELECT 1 FROM meta WHERE name = ?", (name,)).fetchone()
        return row is not None

    def set_meta(self, name: str, value: str) -> None:
        """Set a named flag in the store."""
        self.connection.execute("INSERT OR REPLACE INTO meta (name, value) VALUES (?, ?)", (name, value))

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


def read_jsonl_records(path: Path) -> list[dict]:
    """Return the records in an old JSONL cache file, in file order.

    A damaged line (for example one cut off by a crash) is reported and skipped, as core.load_cache always did.
    """
    records = []
    with open(path, encoding="utf-8") as file:
        for line_number, line in enumerate(file, start=1):
            if not line.strip():
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                print(f"Skipping damaged cache line {line_number} in {path.name}", file=sys.stderr)
    return records


def verify_import(db: ReplyStore, expected_keys: set[tuple]) -> None:
    """Check that the store holds exactly the expected keys, and no more or fewer rows.

    This is the safety check for the import. The expected keys come from the JSONL file, and the stored
    keys come from the database. Any gap or extra row raises ImportMismatch.
    """
    stored_keys = db.all_keys()
    if db.count_rows() != len(expected_keys) or stored_keys != expected_keys:
        raise ImportMismatch(
            f"expected {len(expected_keys)} saved replies, the store holds {db.count_rows()}"
        )


def copy_jsonl_into(db: ReplyStore, jsonl_path: Path) -> None:
    """Copy every reply from an old JSONL file into the store, then check the copy.

    A file that does not exist means there is nothing to copy, so this does nothing.
    """
    if not jsonl_path.exists():
        return
    records = read_jsonl_records(jsonl_path)
    for record in records:
        db.add(record)
    verify_import(db, {key_values(record) for record in records})
    print(f"Imported {db.count_rows()} saved replies from {jsonl_path.name} into {db.path.name}.", file=sys.stderr)


def import_jsonl_once(db: ReplyStore, jsonl_path: Path) -> None:
    """Copy the JSONL file into the store the first time only, all in one transaction.

    The flag check and the copy happen inside the same transaction, so two runs that open the store at
    the same moment cannot both copy the file. If anything fails, the transaction is rolled back and the
    flag is not set, so the next open tries again.
    """
    # BEGIN IMMEDIATE takes the write lock now, so a second opener waits instead of copying the file too.
    db.connection.execute("BEGIN IMMEDIATE")
    try:
        if not db.has_meta(IMPORT_FLAG):
            copy_jsonl_into(db, jsonl_path)
            db.set_meta(IMPORT_FLAG, "done")
        db.connection.execute("COMMIT")
    except BaseException:
        db.connection.execute("ROLLBACK")
        raise


def has_saved_replies(cache_path: Path) -> bool:
    """Return True when a store or an old JSONL file exists for this cache path.

    Readers check this first, so reading an empty cache does not create an empty database file.
    """
    return store_path_for(cache_path).exists() or cache_path.exists()


def open_store(cache_path: Path) -> ReplyStore:
    """Open the store that goes with a JSONL cache path, copying the old file in on the first open.

    Callers use this instead of ReplyStore directly, so every opener gets the one-time import.
    """
    db = ReplyStore(store_path_for(cache_path))
    try:
        import_jsonl_once(db, cache_path)
    except BaseException:
        db.close()
        raise
    return db
