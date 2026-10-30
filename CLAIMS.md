# File claims

Before a session edits a file, it adds a line here with its branch, the session and the files. It removes the line
when its batch merges into `main`. If another session has claimed a file you need, stop and ask the owner. See
rule 10 in CLAUDE.md.

| Branch | Session | Files | Since |
| --- | --- | --- | --- |
| batch/vega-compare | f508f0fc-7fd2-446c-a0ea-9fc4b362189a | package.json, package-lock.json, frontend/compare.html, frontend/css/page-compare.css, frontend/js/compare/app.js, frontend/js/compare/vega-rows.js, frontend/js/compare/vega-specs.js, frontend/js/compare/differences.js, frontend/js/compare/fig-views.js, scripts/build_compare.py, tests/js/compare-vega-*.test.js, tests/js/compare-differences.test.js, tests/python/test_build_compare.py, tests/python/test_compare_views_browser.py, README.md | 2026-10-30 |
