"""The reply store: a SQLite database that keeps every saved model reply.

Why this exists: the old cache was a JSONL file that grew by one line per reply. Finding one reply meant reading
the whole file, and a crash could leave a half-written line. SQLite gives an indexed lookup on the reply key,
and each reply is committed as soon as it arrives, so a crash loses at most the reply that was being written.

The database sits next to the JSONL cache path. A cache called results/cache.jsonl keeps its replies in
results/cache.sqlite. The JSONL file is still the format that grade and the other tools understand, so
export_jsonl writes the same lines that core.load_cache reads.
"""

import hashlib
import json
import sqlite3
import sys
from pathlib import Path

# The table holds one row per saved reply. The primary key is the reply's identity, and SQLite builds an
# index for it, so a lookup by key does not scan the table. 'record' is the saved record as JSON text, without
# its messages. 'messages_hash' names the message list in message_lists, which holds each list only once.
CREATE_REPLIES_SQL = """
CREATE TABLE IF NOT EXISTS replies (
    experiment TEXT NOT NULL,
    condition TEXT NOT NULL,
    model TEXT NOT NULL,
    question_id TEXT NOT NULL,
    repeat INTEGER NOT NULL,
    step TEXT NOT NULL,
    messages_hash TEXT,
    record TEXT NOT NULL,
    PRIMARY KEY (experiment, condition, model, question_id, repeat, step)
)
"""

# One row per distinct message list. Many replies send the same messages (every model gets the same question),
# so the list is stored here once, and the hash is its name.
CREATE_MESSAGE_LISTS_SQL = """
CREATE TABLE IF NOT EXISTS message_lists (
    hash TEXT PRIMARY KEY,
    messages TEXT NOT NULL
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


def messages_text_and_hash(messages: list) -> tuple[str, str]:
    """Return the canonical JSON text of a message list, and the SHA-256 hash of that text.

    Sorted keys and no spaces mean the same messages give the same text, however their dicts were built, so
    the same list always gets the same hash and is stored once.
    """
    text = json.dumps(messages, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return digest, text


def full_record(record_text: str, messages_text: str | None) -> dict:
    """Join a stored reply row and its message list back into one record, with the same fields as when it was added.

    A record saved with no messages field has no message list (messages_text is None), so none is added back.
    """
    record = json.loads(record_text)
    if messages_text is not None:
        record["messages"] = json.loads(messages_text)
    return record


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
        self.connection.execute(CREATE_MESSAGE_LISTS_SQL)
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
        """Save one reply. A reply with the same key replaces the earlier one, as the JSONL cache did.

        The message list goes into message_lists (only if it is new), and the reply row points to it. Both
        writes are one transaction, so a reply is never saved without its message list.
        """
        self.connection.execute("BEGIN")
        try:
            self.write_record(record)
            self.connection.execute("COMMIT")
        except BaseException:
            self.connection.execute("ROLLBACK")
            raise

    def write_record(self, record: dict) -> None:
        """Write one reply and its message list, without starting or committing a transaction.

        The caller must already be inside a transaction. add uses this for one reply; the one-time import uses
        it for many replies, so the whole import commits or rolls back as one.
        """
        # The record is saved without its messages, because they are already in message_lists.
        slim = {name: value for name, value in record.items() if name != "messages"}
        digest = None
        if "messages" in record:
            digest, messages_text = messages_text_and_hash(record["messages"])
            self.connection.execute(
                "INSERT OR IGNORE INTO message_lists (hash, messages) VALUES (?, ?)", (digest, messages_text)
            )
        self.connection.execute(
            "INSERT OR REPLACE INTO replies "
            "(experiment, condition, model, question_id, repeat, step, messages_hash, record) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (*key_values(record), digest, json.dumps(slim, ensure_ascii=False)),
        )

    def joined_rows(self, where_sql: str = "", params: tuple = ()) -> list[tuple[str, str | None]]:
        """Return (record text, messages text) for the matching replies, in the order they were saved.

        The join is a LEFT JOIN, so a reply saved with no message list still comes back (with None for its messages).
        """
        return self.connection.execute(
            "SELECT replies.record, message_lists.messages FROM replies "
            "LEFT JOIN message_lists ON message_lists.hash = replies.messages_hash "
            + where_sql
            + " ORDER BY replies.rowid",
            params,
        ).fetchall()

    def records_for_experiment(self, experiment: str) -> list[dict]:
        """Return every saved reply for one experiment code, in the order they were saved."""
        rows = self.joined_rows("WHERE replies.experiment = ?", (experiment,))
        return [full_record(record_text, messages_text) for record_text, messages_text in rows]

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
        rows = self.joined_rows()
        with open(out_path, "w", encoding="utf-8") as file:
            for record_text, messages_text in rows:
                line = json.dumps(full_record(record_text, messages_text), ensure_ascii=False)
                file.write(line + "\n")
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
        db.write_record(record)
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
