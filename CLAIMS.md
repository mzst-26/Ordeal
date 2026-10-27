# File claims

Before a session edits a file, it adds a line here with its branch, the session and the files. It removes the line
when its batch merges into `main`. If another session has claimed a file you need, stop and ask the owner. See
rule 10 in CLAUDE.md.

| Branch | Session | Files | Since |
| --- | --- | --- | --- |
| batch/94-per-visitor-runs | claude (agent a80cc56466ae21add) | netlify/**, site/js/run-retention.js, site/js/visitor-rules.js, site/js/visitor-id.js, site/js/runs-api.js, site/js/page-runs.js, site/js/save-to-runs.js, site/js/run-summary.js, site/js/page-batch.js, site/js/page-gauntlet.js, site/runs.html, site/batch.html, site/index.html, site/css/page-runs.css, netlify.toml, README.md, js-tests/run-retention.test.js, js-tests/visitor-rules.test.js, js-tests/run-server-logic.test.js, js-tests/runs-api.test.js | 2026-10-27 |
