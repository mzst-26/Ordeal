# File claims

Before a session edits a file, it adds a line here with its branch, the session and the files. It removes the line
when its batch merges into `main`. If another session has claimed a file you need, stop and ask the owner. See
rule 10 in CLAUDE.md.

| Branch | Session | Files | Since |
| --- | --- | --- | --- |
| batch/109-banner-front | f4914fe3 (banner fix) | `frontend/css/base.css`, `frontend/js/ui/banner-height.js` (new), `frontend/js/main.jsx`, `frontend/js/page-pacing.js`, `frontend/js/page-runs.js`, `frontend/js/compare/app.js`, `tests/js/banner-height.test.js` (new) | 2026-10-28 |
