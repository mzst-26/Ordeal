# File claims

Before a session edits a file, it adds a line here with its branch, the session and the files. It removes the line
when its batch merges into `main`. If another session has claimed a file you need, stop and ask the owner. See
rule 10 in CLAUDE.md.

| Branch | Session | Files | Since |
| --- | --- | --- | --- |
| batch/104-frontend-folder | f4914fe3 (restructure plan, batch 4) | `site/` (renamed to `frontend/`), `scripts/`, `tests/`, `js-tests/`, `ordeal/core.py`, `vite.config.js`, `netlify/`, `netlify.toml`, `package*.json`, `pyproject.toml`, `.gitignore`, `README.md` | 2026-10-28 (claimed after the first edits, see commit message) |
