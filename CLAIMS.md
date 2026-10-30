# File claims

Before a session edits a file, it adds a line here with its branch, the session and the files. It removes the line
when its batch merges into `main`. If another session has claimed a file you need, stop and ask the owner. See
rule 10 in CLAUDE.md.

| Branch | Session | Files | Since |
| --- | --- | --- | --- |
| batch/echarts-dense | f508f0fc-7fd2-446c-a0ea-9fc4b362189a | package.json, package-lock.json, CLAIMS.md, README.md, frontend/js/compare/fig-views.js, frontend/js/compare/echarts-heatmap.js, frontend/js/compare/heat-chart.js, tests/js/compare-echarts-heatmap.test.js, tests/python/test_compare_views_browser.py | 2026-10-30 |
