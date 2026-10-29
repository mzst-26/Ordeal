# File claims

Before a session edits a file, it adds a line here with its branch, the session and the files. It removes the line
when its batch merges into `main`. If another session has claimed a file you need, stop and ask the owner. See
rule 10 in CLAUDE.md.

| Branch | Session | Files | Since |
| --- | --- | --- | --- |
| batch/run-pace | session 4b71b7c1 (Claude) | frontend/js/engine/run-pace.js, run-advice.js, stop-reason.js, api.js, runner.js, platform-pacer.js, store/run-totals.js, store/run-store.js, store/run-jsonl.js, pages/batch-status-view.js, tests/js/batch-status-view.test.js, tests/js/run-pace.test.js, run-advice.test.js, stop-reason.test.js, run-totals.test.js, api.test.js, runner.test.js, platform-pacer.test.js, store.test.js, run-jsonl.test.js | 2026-10-29 |
