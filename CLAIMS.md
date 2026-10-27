# File claims

Before a session edits a file, it adds a line here with its branch, the session and the files. It removes the line
when its batch merges into `main`. If another session has claimed a file you need, stop and ask the owner. See
rule 10 in CLAUDE.md.

| Branch | Session | Files | Since |
| --- | --- | --- | --- |
| probe-coverage-notes | claude-haiku-5-5 (this session) | site/js/page-live.js, js-tests/chart-models.test.js, ordeal/grade.py, ordeal/charts.py, tests/test_charts_map.py, tests/test_grade.py | 2026-10-27 |
