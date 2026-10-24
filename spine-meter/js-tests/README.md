# JavaScript tests for the browser version

Run from the project root with `npm test` (Node 18 or newer, no packages to install).
The fixtures in `js-tests/fixtures/` come from `scripts/make_golden.py`, which runs the Python
reference. Do not edit them by hand; regenerate with the project venv:
`/Users/mobinzaki/Github/Hacktest/.venv-spine/bin/python scripts/make_golden.py`.
The JavaScript code under `site/` must produce the same messages and numbers as these files.
Each fixture holds the inputs it needs, so the tests do not read the Python files.
