"""Tests for ordeal/store.py, the SQLite database that keeps the saved replies.

Each test uses its own temporary folder, so no test touches the real results folder.
"""

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from ordeal import store


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


if __name__ == "__main__":
    unittest.main()
