# Ordeal: working rules

These rules apply to every change in this repository, including the work of subagents.

1. **Specialised subagents, right skills.** Split work into subagents that each own one area. Before starting,
   every subagent looks through the available skills and uses the ones that fit its task. It says which skills
   it used and why. A reviewer checks the result against these rules.
2. **Small commits, clear messages.** Commit in small batches, each one about one concern. Each message has a
   short subject line and a body that says what changed and why. Push each batch to its own branch, then merge
   it into `main` when the task is finished.
3. **Self Documented code, readable by even students.** Write code that a student new to programming can follow. Use plain names, short
   functions with one job, and no clever tricks.
4. **Comments that teach.** Every module, class and function has a comment that explains what it is for and why
   it exists. Explain the reason behind a choice, not only the steps. Match the comment density of the file you
   are editing.
5. **Use tokens carefully.** Do not extend a task beyond what was asked. Keep quality high, and spend the
   budget on the parts that matter.
6. **Map every area a change touches before any work starts.** One request often needs changes in several places,
   such as two pages and a shared module, even when only one page is named. Before a subagent starts, search the
   whole app for the old behaviour: its words, element ids, controls, data names and tests, not only the page the
   request names. Write the result down as a list of areas. Each area says what changes, or why it does not change.
   Give each area its own task. A change is reported as done only when every area on the list is changed or
   explained, and the reviewer checks the list against a fresh search. Say the list in the final report.

## Working with several sessions

Several Claude sessions, subagents and worktrees can share this repository. These rules stop their work from
overwriting each other.

7. **One branch, one worktree.** A branch is checked out in at most one worktree at a time. Nobody commits directly
   to `main`. `main` changes only by merging a batch branch.
8. **Start from the current `origin/main`.** Run `git fetch`, then create each batch branch from `origin/main`.
   Before merging, bring the branch up to date and run the full test suite.
9. **Check before you merge.** Before merging into any checkout, confirm it is clean, save a patch of its uncommitted
   work to the scratchpad, and record the branch and HEAD. Stop if anything is unexpected.
10. **Claim files.** Before editing a file, add a line to `CLAIMS.md` at the repository root with the branch, the
    session and the files. Create the file if it is missing. Remove the line when the batch merges. If another
    session has claimed a file you need, stop and ask.
11. **Stash safely.** Stash only with a tag, and record the commit ID. The message names the worktree path. Prefer
    a WIP commit on your own branch. Never pop or drop a stash you did not create.
12. **The GitButler workspace is not a merge target.** Merge into `main` first. Move the workspace only through
    GitButler's target update, after `main` matches origin.
13. **Push `main` only with the owner's approval.**
14. **Subagents never link or copy `.env`.** Keys come from the environment of the main checkout only.
15. **Status follows merges.** A task is marked done only after its batch is merged to `main`.

## Project notes

- Python package: `ordeal/`. Entry point for the command line: `ordeal` (see `pyproject.toml`).
- Shared platform list: `ordeal/data/providers.json`. The Python code and the browser site both read it.
- API keys are never printed, never written to the repository, and only sent to the base URL of their own platform.
