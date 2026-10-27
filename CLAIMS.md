# File claims

Before a session edits a file, it adds a line here with its branch, the session and the files. It removes the line
when its batch merges into `main`. If another session has claimed a file you need, stop and ask the owner. See
rule 10 in CLAUDE.md.

| Branch | Session | Files | Since |
| --- | --- | --- | --- |
| batch/83-health-guard | agent-a47dfe95 (T21) | ordeal/runner.py, ordeal/data/config.json, README.md, tests/test_health_guard.py, CLAIMS.md | 2026-10-27 |
