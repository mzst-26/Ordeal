# File claims

Before a session edits a file, it adds a line here with its branch, the session and the files. It removes the line
when its batch merges into `main`. If another session has claimed a file you need, stop and ask the owner. See
rule 10 in CLAUDE.md.

| Branch | Session | Files | Since |
| --- | --- | --- | --- |
| batch/provider-field | session f508f0fc (provider-field worker) | ordeal/model_client.py, ordeal/providers.py, ordeal/core.py, ordeal/runner.py, ordeal/grade.py, ordeal/cli.py, scripts/build_compare.py, README.md, tests/python/test_grade.py, tests/python/test_cli.py, tests/python/test_build_compare.py, tests/python/test_runner.py, tests/python/test_model_client.py, tests/python/test_core.py, tests/python/test_providers.py | 2026-10-30 |
