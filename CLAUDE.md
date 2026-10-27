# Ordeal: working rules

These rules apply to every change in this repository, including the work of subagents.

1. **Specialised subagents, right skills.** Split work into subagents that each own one area. Before starting,
   every subagent looks through the available skills and uses the ones that fit its task. It says which skills
   it used and why. A reviewer checks the result against these rules.
2. **Small commits, clear messages.** Commit in small batches, each one about one concern. Each message has a
   short subject line and a body that says what changed and why. Push each batch to its own branch, then merge
   it into `main` when the task is finished.
3. **Readable by students.** Write code that a student new to programming can follow. Use plain names, short
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

## Project notes

- Python package: `ordeal/`. Entry point for the command line: `ordeal` (see `pyproject.toml`).
- Shared platform list: `ordeal/data/providers.json`. The Python code and the browser site both read it.
- API keys are never printed, never written to the repository, and only sent to the base URL of their own platform.
