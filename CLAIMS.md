# File claims

Before a session edits a file, it adds a line here with its branch, the session and the files. It removes the line
when its batch merges into `main`. If another session has claimed a file you need, stop and ask the owner. See
rule 10 in CLAUDE.md.

| Branch | Session | Files | Since |
| --- | --- | --- | --- |
| batch/93-web-save-ui | agent-af0d04c9dea4fcc2d | site/js/runs-api.js, site/js/web-save-panel.js (new), site/js/page-gauntlet.js, site/js/page-batch.js, site/index.html, site/js/react/SiteHeader.jsx, js-tests/web-save.test.js (new) | 2026-10-27 |
