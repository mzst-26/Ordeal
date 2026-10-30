# File claims

Before a session edits a file, it adds a line here with its branch, the session and the files. It removes the line
when its batch merges into `main`. If another session has claimed a file you need, stop and ask the owner. See
rule 10 in CLAUDE.md.

| Branch | Session | Files | Since |
| --- | --- | --- | --- |
| batch/unified-keys | session f508f0fc-7fd2-446c-a0ea-9fc4b362189a | frontend/js/engine/token.js, frontend/js/engine/provider-keys.js, frontend/js/engine/api.js, frontend/js/models/platform-choice.js, frontend/js/models/platform-section.js, frontend/js/models/typed-model-check.js, frontend/js/pages/page-live.js, frontend/js/pages/page-gauntlet.js, frontend/js/react/SiteHeader.jsx, frontend/js/main.jsx, frontend/js/ui/token-dialog.js, tests/js/token.test.js, tests/js/batch-log.test.js, tests/js/api.test.js, tests/js/provider-keys.test.js, tests/js/unified-keys.test.js, tests/python/test_batch_side_by_side_browser.py, README.md | 2026-10-30 |
