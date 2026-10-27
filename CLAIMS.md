# File claims

Before a session edits a file, it adds a line here with its branch, the session and the files. It removes the line
when its batch merges into `main`. If another session has claimed a file you need, stop and ask the owner. See
rule 10 in CLAUDE.md.

| Branch | Session | Files | Since |
| --- | --- | --- | --- |
| batch/78-shared-scheduler | agent-a6eeb7af777e8bcd5 | ordeal/runner.py (run_all, main, new scheduling code), tests/test_shared_scheduler.py, tests/test_full_scale_stub.py | 2026-10-27 |
