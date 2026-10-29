# File claims

Before a session edits a file, it adds a line here with its branch, the session and the files. It removes the line
when its batch merges into `main`. If another session has claimed a file you need, stop and ask the owner. See
rule 10 in CLAUDE.md.

| Branch | Session | Files | Since |
| --- | --- | --- | --- |
| batch/resume-after-stop | session 4b71b7c1 (Claude) | frontend/index.html, frontend/js/pages/page-batch.js, frontend/js/shared/view-ids.js, tests/js/batch-resume-button.test.js | 2026-10-29 |
