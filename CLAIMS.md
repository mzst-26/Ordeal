# File claims

Before a session edits a file, it adds a line here with its branch, the session and the files. It removes the line
when its batch merges into `main`. If another session has claimed a file you need, stop and ask the owner. See
rule 10 in CLAUDE.md.

| Branch | Session | Files | Since |
| --- | --- | --- | --- |
| batch/77-finish-usage-jitter | agent-a496b237d988503ae | ordeal/model_client.py, ordeal/runner.py, tests/mock_openai.py, tests/test_model_client.py, tests/test_runner.py, tests/test_e2e.py | 2026-10-27 |
