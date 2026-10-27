# File claims

Before a session edits a file, it adds a line here with its branch, the session and the files. It removes the line
when its batch merges into `main`. If another session has claimed a file you need, stop and ask the owner. See
rule 10 in CLAUDE.md.

| Branch | Session | Files | Since |
| --- | --- | --- | --- |
| batch/summary-in-batch-runs | Claude (this session) | site/js/page-batch.js, site/js/persistence-ui.js, site/js/full-run-summary.js, site/js/full-run-upload.js (new), site/js/store/run-store.js, site/index.html, site/js/page-live.js, vite.config.js, site/runs.html, site/js/page-runs.js, js-tests/full-run-upload.test.js (new), js-tests/live-run-choice.test.js (new), site/js/saved-runs.js, site/js/persistence-ui.js, js-tests/saved-run-open.test.js (new), site/js/chart-panel.js, site/js/chart-models.js (new), site/js/chart-popup.js (new), site/css/chart-popup.css (new), js-tests/chart-models.test.js (new) | 2026-10-27 |
