"""Tests for ordeal/store.py, the SQLite database that keeps the saved replies.

Each test uses its own temporary folder, so no test touches the real results folder.
"""

import contextlib
import io
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from ordeal import core, grade, store


def make_reply(question_id="q1", repeat=0, step="baseline", reply="Answer: A", experiment="exp-a"):
    """Return one saved reply shaped like core.make_record output, with only the fields the store needs."""
    return {
        "experiment": experiment,
        "condition": "none",
        "model": "model-one",
        "question_id": question_id,
        "repeat": repeat,
        "step": step,
        "temperature": 0.7,
        "messages": [{"role": "user", "content": "Question text"}],
        "reply": reply,
        "timestamp": "2026-10-27T10:00:00+00:00",
    }


class StoreFileTests(unittest.TestCase):
    """The database file is found next to the JSONL cache, and it is set up in WAL mode."""

    def setUp(self) -> None:
        temporary_folder = tempfile.TemporaryDirectory()
        self.addCleanup(temporary_folder.cleanup)
        self.folder = Path(temporary_folder.name)

    def test_store_file_sits_next_to_the_jsonl_cache_with_the_same_stem(self) -> None:
        """A cache named cache.jsonl gets its database as cache.sqlite in the same folder."""
        self.assertEqual(store.store_path_for(self.folder / "cache.jsonl"), self.folder / "cache.sqlite")

    def test_database_uses_wal_mode(self) -> None:
        """WAL mode lets a reader look at the database while a run is still writing to it."""
        db_path = self.folder / "cache.sqlite"
        with store.ReplyStore(db_path):
            pass
        connection = sqlite3.connect(db_path)
        try:
            mode = connection.execute("PRAGMA journal_mode").fetchone()[0]
        finally:
            connection.close()
        self.assertEqual(mode, "wal")

    def test_primary_key_is_experiment_condition_model_question_repeat_step(self) -> None:
        """The primary key is the lookup key, so a reply is found by an indexed read, not a scan."""
        db_path = self.folder / "cache.sqlite"
        with store.ReplyStore(db_path):
            pass
        connection = sqlite3.connect(db_path)
        try:
            columns = connection.execute("PRAGMA table_info(replies)").fetchall()
        finally:
            connection.close()
        # table_info gives the position of each column in the primary key, or 0 when it is not part of it.
        key_columns = [row[1] for row in sorted(columns, key=lambda row: row[5]) if row[5] > 0]
        self.assertEqual(key_columns, ["experiment", "condition", "model", "question_id", "repeat", "step"])


class AddAndReadTests(unittest.TestCase):
    """Replies are written one at a time, committed at once, and read back by experiment."""

    def setUp(self) -> None:
        temporary_folder = tempfile.TemporaryDirectory()
        self.addCleanup(temporary_folder.cleanup)
        self.folder = Path(temporary_folder.name)
        self.db_path = self.folder / "cache.sqlite"

    def test_added_reply_is_read_back_for_its_experiment(self) -> None:
        """A reply written with add comes back unchanged from records_for_experiment."""
        reply = make_reply()
        with store.ReplyStore(self.db_path) as db:
            db.add(reply)
            self.assertEqual(db.records_for_experiment("exp-a"), [reply])

    def test_reply_is_committed_as_soon_as_it_is_added(self) -> None:
        """A second connection sees the reply before the first connection is closed.

        This is the crash rule: a reply that was paid for must already be on disk when add returns.
        """
        with store.ReplyStore(self.db_path) as db:
            db.add(make_reply())
            other = sqlite3.connect(self.db_path)
            try:
                count = other.execute("SELECT COUNT(*) FROM replies").fetchone()[0]
            finally:
                other.close()
            self.assertEqual(count, 1)

    def test_same_key_twice_keeps_only_the_later_reply(self) -> None:
        """The primary key allows one row per key, and the later write replaces the earlier one."""
        with store.ReplyStore(self.db_path) as db:
            db.add(make_reply(reply="first"))
            db.add(make_reply(reply="second"))
            rows = db.records_for_experiment("exp-a")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["reply"], "second")

    def test_other_experiments_are_counted_but_not_returned(self) -> None:
        """Replies from other experiment codes are left out of the read and counted separately."""
        with store.ReplyStore(self.db_path) as db:
            db.add(make_reply(experiment="exp-a"))
            db.add(make_reply(experiment="exp-b", question_id="q2"))
            db.add(make_reply(experiment="exp-c", question_id="q3"))
            self.assertEqual(len(db.records_for_experiment("exp-a")), 1)
            self.assertEqual(db.count_other_experiments("exp-a"), 2)


class ExportTests(unittest.TestCase):
    """The export writes one JSON line per reply, the same lines the JSONL cache used to hold."""

    def setUp(self) -> None:
        temporary_folder = tempfile.TemporaryDirectory()
        self.addCleanup(temporary_folder.cleanup)
        self.folder = Path(temporary_folder.name)

    def test_export_writes_each_reply_as_the_same_json_object(self) -> None:
        """Every exported line parses to the record that was added, so grade and the other readers still work."""
        first = make_reply(question_id="q1")
        second = make_reply(question_id="q2", reply="Answer: C")
        out_path = self.folder / "export.jsonl"
        with store.ReplyStore(self.folder / "cache.sqlite") as db:
            db.add(first)
            db.add(second)
            written = db.export_jsonl(out_path)
        lines = out_path.read_text(encoding="utf-8").splitlines()
        self.assertEqual(written, 2)
        self.assertEqual([json.loads(line) for line in lines], [first, second])


class ImportTests(unittest.TestCase):
    """A JSONL cache is copied into the store once, and the copy is checked before it is kept."""

    def setUp(self) -> None:
        temporary_folder = tempfile.TemporaryDirectory()
        self.addCleanup(temporary_folder.cleanup)
        self.folder = Path(temporary_folder.name)
        self.jsonl_path = self.folder / "cache.jsonl"

    def write_jsonl(self, records: list[dict]) -> None:
        """Write records to the temporary cache.jsonl, one JSON object per line, as the old runner did."""
        text = "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records)
        self.jsonl_path.write_text(text, encoding="utf-8")

    def test_existing_jsonl_replies_are_imported_on_first_open(self) -> None:
        """Opening the store for a cache that has a JSONL file copies every reply into the database."""
        first = make_reply(question_id="q1")
        second = make_reply(question_id="q2")
        self.write_jsonl([first, second])
        with contextlib.redirect_stderr(io.StringIO()):
            with store.open_store(self.jsonl_path) as db:
                self.assertEqual(db.records_for_experiment("exp-a"), [first, second])

    def test_a_repeated_key_in_the_file_imports_as_one_row_with_the_later_line(self) -> None:
        """Duplicate keys in the old file collapse to one row, and the later line wins, as load_cache did."""
        self.write_jsonl([make_reply(reply="old"), make_reply(reply="new")])
        with contextlib.redirect_stderr(io.StringIO()):
            with store.open_store(self.jsonl_path) as db:
                rows = db.records_for_experiment("exp-a")
        self.assertEqual([row["reply"] for row in rows], ["new"])

    def test_damaged_line_is_reported_and_the_rest_is_imported(self) -> None:
        """A line cut off by an old crash is skipped with a message, and the other replies still import."""
        good = make_reply(question_id="q1")
        self.jsonl_path.write_text(json.dumps(good) + "\n{\"experiment\": \"exp-a\", cut", encoding="utf-8")
        report = io.StringIO()
        with contextlib.redirect_stderr(report):
            with store.open_store(self.jsonl_path) as db:
                self.assertEqual(db.records_for_experiment("exp-a"), [good])
        self.assertIn("Skipping damaged cache line 2", report.getvalue())

    def test_import_happens_only_once_for_a_cache(self) -> None:
        """Lines added to the JSONL file after the first open are not copied, because the import is one-time."""
        self.write_jsonl([make_reply(question_id="q1")])
        with contextlib.redirect_stderr(io.StringIO()):
            with store.open_store(self.jsonl_path):
                pass
            self.write_jsonl([make_reply(question_id="q1"), make_reply(question_id="q2")])
            with store.open_store(self.jsonl_path) as db:
                self.assertEqual(db.count_rows(), 1)

    def test_a_failed_import_leaves_the_store_empty_and_is_retried_next_time(self) -> None:
        """A line that cannot be imported stops the whole import, so no half-copied store is kept."""
        broken = make_reply(question_id="q1")
        del broken["step"]
        self.write_jsonl([make_reply(question_id="q2"), broken])
        with self.assertRaises(KeyError):
            with contextlib.redirect_stderr(io.StringIO()):
                store.open_store(self.jsonl_path)
        self.write_jsonl([make_reply(question_id="q2")])
        with contextlib.redirect_stderr(io.StringIO()):
            with store.open_store(self.jsonl_path) as db:
                self.assertEqual(db.count_rows(), 1)

    def test_check_raises_when_a_key_from_the_file_is_missing_from_the_store(self) -> None:
        """The check compares the keys read from the file with the keys in the store, and fails on any gap."""
        with store.ReplyStore(self.folder / "cache.sqlite") as db:
            missing_key = store.key_values(make_reply(question_id="q9"))
            with self.assertRaises(store.ImportMismatch):
                store.verify_import(db, {missing_key})

    def test_check_passes_when_the_store_holds_exactly_the_file_keys(self) -> None:
        """When the keys match, the check returns without raising."""
        reply = make_reply(question_id="q1")
        with store.ReplyStore(self.folder / "cache.sqlite") as db:
            db.add(reply)
            store.verify_import(db, {store.key_values(reply)})

    def test_store_without_a_jsonl_file_starts_empty(self) -> None:
        """A new cache with no JSONL file opens as an empty store and nothing is imported."""
        with store.open_store(self.jsonl_path) as db:
            self.assertEqual(db.count_rows(), 0)


class ReaderTests(unittest.TestCase):
    """The readers (core.load_cache and grade.read_cache_by_experiment) read replies from the store."""

    def setUp(self) -> None:
        temporary_folder = tempfile.TemporaryDirectory()
        self.addCleanup(temporary_folder.cleanup)
        self.folder = Path(temporary_folder.name)
        self.cache_path = self.folder / "cache.jsonl"

    def test_load_cache_reads_replies_that_are_only_in_the_store(self) -> None:
        """With no JSONL file on disk, load_cache still finds the replies saved in the store."""
        reply = make_reply(experiment=core.current_experiment())
        with store.open_store(self.cache_path) as db:
            db.add(reply)
        self.assertFalse(self.cache_path.exists())
        loaded = core.load_cache(self.cache_path)
        self.assertEqual(list(loaded.values()), [reply])

    def test_grade_reads_each_experiment_from_the_store(self) -> None:
        """grade.read_cache_by_experiment groups the store's replies by experiment code and counts the rest."""
        with store.open_store(self.cache_path) as db:
            db.add(make_reply(experiment="exp-a"))
            db.add(make_reply(experiment="exp-b", question_id="q2"))
            db.add(make_reply(experiment="exp-c", question_id="q3"))
        replies, other_count = grade.read_cache_by_experiment(self.cache_path, {"exp-a", "exp-b"})
        self.assertEqual(len(replies["exp-a"]), 1)
        self.assertEqual(len(replies["exp-b"]), 1)
        self.assertEqual(other_count, 1)


if __name__ == "__main__":
    unittest.main()
