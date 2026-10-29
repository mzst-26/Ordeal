# File claims

Before a session edits a file, it adds a line here with its branch, the session and the files. It removes the line
when its batch merges into `main`. If another session has claimed a file you need, stop and ask the owner. See
rule 10 in CLAUDE.md.

| Branch | Session | Files | Since |
| --- | --- | --- | --- |
| batch/units-move | session 4b71b7c1 (Claude) | frontend/js/engine/runner.js, frontend/js/engine/run-pace.js, frontend/js/engine/run-advice.js, frontend/js/pages/page-batch.js, frontend/js/pages/batch-status-view.js, frontend/index.html, frontend/css/page-batch.css, tests/js/runner.test.js, tests/js/run-pace.test.js, tests/js/run-advice.test.js, tests/js/batch-status-view.test.js | 2026-10-29 |
