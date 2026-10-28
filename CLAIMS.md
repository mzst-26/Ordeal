# File claims

Before a session edits a file, it adds a line here with its branch, the session and the files. It removes the line
when its batch merges into `main`. If another session has claimed a file you need, stop and ask the owner. See
rule 10 in CLAUDE.md.

| Branch | Session | Files | Since |
| --- | --- | --- | --- |
| batch/platform-pacing (per-platform pacing so 429s from OpenRouter and similar stop ending steps) | Claude Code session 2026-10-28 | frontend/js/engine/platform-pacer.js (new), frontend/js/engine/api.js, frontend/js/engine/limiter.js, frontend/js/engine/runner.js, tests/js/platform-pacer.test.js (new), tests/js/api.test.js, tests/js/limiter.test.js, tests/js/runner.test.js, frontend/js/pages/page-live.js, frontend/pacing.html, CLAIMS.md | 2026-10-28 |
