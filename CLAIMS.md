# File claims

Before a session edits a file, it adds a line here with its branch, the session and the files. It removes the line
when its batch merges into `main`. If another session has claimed a file you need, stop and ask the owner. See
rule 10 in CLAUDE.md.

| Branch | Session | Files | Since |
| --- | --- | --- | --- |
| batch/chart-cleanup | session chart-cleanup-B3 | frontend/js/pages/page-live.js, frontend/index.html, frontend/js/charts/index.js, frontend/js/charts/donut.js, frontend/js/results/batch-figures.js, frontend/js/results/analytics.js, frontend/js/pages/page-batch.js, frontend/js/compare/fig-scatter.js, frontend/compare.html, README.md, tests/js, tests/python/test_compare_browser.py | 2026-10-30 |
