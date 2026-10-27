# File claims

Before a session edits a file, it adds a line here with its branch, the session and the files. It removes the line
when its batch merges into `main`. If another session has claimed a file you need, stop and ask the owner. See
rule 10 in CLAUDE.md.

| Branch | Session | Files | Since |
| --- | --- | --- | --- |
| batch/80-stats-bootstrap-retest | 2ea9abb2-89d2-4bca-940a-6a862d061bee | ordeal/grade.py, ordeal/data/config.json (bootstrap key), README.md (statistics section), tests/test_grade.py | 2026-10-27 |
