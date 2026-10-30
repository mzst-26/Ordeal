# File claims

Before a session edits a file, it adds a line here with its branch, the session and the files. It removes the line
when its batch merges into `main`. If another session has claimed a file you need, stop and ask the owner. See
rule 10 in CLAUDE.md.

| Branch | Session | Files | Since |
| --- | --- | --- | --- |
| batch/provider-csp | session f508f0fc (owner-approved CSP batch) | netlify.toml, ordeal/data/providers.json, frontend/js/models/side-by-side.js, frontend/js/models/side-by-side-panel.js, tests/js/side-by-side.test.js, tests/python/test_batch_side_by_side_browser.py | 2026-10-30 |
