# File claims

Before a session edits a file, it adds a line here with its branch, the session and the files. It removes the line
when its batch merges into `main`. If another session has claimed a file you need, stop and ask the owner. See
rule 10 in CLAUDE.md.

| Branch | Session | Files | Since |
| --- | --- | --- | --- |
| batch/106-group-frontend-js | f4914fe3 (restructure plan, batch 6) | `frontend/js/` (51 modules moved into folders), `frontend/*.html`, `tests/js/` (imports), `scripts/`, `vite.config.js` | 2026-10-28 |
