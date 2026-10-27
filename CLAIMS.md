# File claims

Before a session edits a file, it adds a line here with its branch, the session and the files. It removes the line
when its batch merges into `main`. If another session has claimed a file you need, stop and ask the owner. See
rule 10 in CLAUDE.md.

| Branch | Session | Files | Since |
| --- | --- | --- | --- |
| batch/79-sqlite-cache | agent-a1525466 | ordeal/store.py, ordeal/core.py (load_cache), ordeal/grade.py (read_cache_by_experiment), ordeal/runner.py (get_reply only), tests/test_store.py | 2026-10-27 |
