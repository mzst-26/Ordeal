# Archive: old shuffled site data

Archived on 2026-10-25.

## Why
The old shuffle paired question sets with the wrong pushback set, so the saved runs in these
experiments are not a fair comparison. The shuffle is being replaced by a single mixed run order
(easy and hard questions in one seeded order, each with a fixed pushback set). Nothing here is deleted.
The files are kept so the old data can still be read.

## What is here
- `shuffles/`: copies of the 31 files that were in `site/data/shuffles/` on `main` (the
  `ladder_v3_pushbackN.json` and `ladder_v4_pushbackN.json` files, the `question_order_N.json` files,
  and `index.json`). Copied byte for byte with `git show main:<path>`.
- `shuffled_suite_entries.json`: the 40 shuffled entries from `site/data/suites.json` on `main`.
  The file had 44 entries. The 4 defaults (`gauntlet_v3+easy`, `gauntlet_v3+hard`, `gauntlet_v4+easy`,
  `gauntlet_v4+hard`) have no `pushback_seed` and no `+pushbackN` in their name. They stay in the live
  file and are not archived. The other 40 have a `pushback_seed`.
- `shuffled_rows.csv`: NOT included. `results.csv` and `by_difficulty.csv` are not tracked on `main`.
  They are written into the gitignored `results/` folder, so the shuffled rows could not be copied from the
  repository. No rows were guessed.

## Generator
The 31 files were tracked on `main`, but their generator is unknown. Nothing in the repository writes them.
`scripts/gen_hard.py` only shuffles questions in memory.

## Status
The archived files are kept readable. The live app no longer loads them once the removal packages are
merged. This archive commit changes no live file.

## The 40 experiment codes
- `f35eda0071f2` (gauntlet_v3+easy+pushback1)
- `4911d6fc07de` (gauntlet_v3+easy+pushback2)
- `f63eaa2bfe0c` (gauntlet_v3+easy+pushback3)
- `7c05810d4e0a` (gauntlet_v3+easy+pushback4)
- `5c7e9c0f15ae` (gauntlet_v3+easy+pushback5)
- `edd60848b5dd` (gauntlet_v3+easy+pushback6)
- `03df6b6dfed2` (gauntlet_v3+easy+pushback7)
- `24018b924c7b` (gauntlet_v3+easy+pushback8)
- `0c8b7d29c85d` (gauntlet_v3+easy+pushback9)
- `0c70f6a94a60` (gauntlet_v3+easy+pushback10)
- `8cbb713ce233` (gauntlet_v3+hard+pushback1)
- `83d2fc0a5a6e` (gauntlet_v3+hard+pushback2)
- `70f70d073bce` (gauntlet_v3+hard+pushback3)
- `f93acad65290` (gauntlet_v3+hard+pushback4)
- `697b11708206` (gauntlet_v3+hard+pushback5)
- `2bbbf67c953e` (gauntlet_v3+hard+pushback6)
- `e02daf798be1` (gauntlet_v3+hard+pushback7)
- `08e5aa2a931a` (gauntlet_v3+hard+pushback8)
- `01b23db0bf54` (gauntlet_v3+hard+pushback9)
- `407b1ec2dd69` (gauntlet_v3+hard+pushback10)
- `3a467bf96cb7` (gauntlet_v4+easy+pushback1)
- `159e566a1cf8` (gauntlet_v4+easy+pushback2)
- `e3dd6f06e0c9` (gauntlet_v4+easy+pushback3)
- `11219c014216` (gauntlet_v4+easy+pushback4)
- `6c2f97a00dea` (gauntlet_v4+easy+pushback5)
- `0165ed2b4e8e` (gauntlet_v4+easy+pushback6)
- `594931b6cd50` (gauntlet_v4+easy+pushback7)
- `42e232dde2be` (gauntlet_v4+easy+pushback8)
- `9cb3253aabdb` (gauntlet_v4+easy+pushback9)
- `f58ccc668220` (gauntlet_v4+easy+pushback10)
- `462cfd99da9a` (gauntlet_v4+hard+pushback1)
- `b67d0d89d238` (gauntlet_v4+hard+pushback2)
- `29fd2ac237d0` (gauntlet_v4+hard+pushback3)
- `8d01098a90bb` (gauntlet_v4+hard+pushback4)
- `5be2dc5e8486` (gauntlet_v4+hard+pushback5)
- `a7da0bb1cbb5` (gauntlet_v4+hard+pushback6)
- `6b542a4816f4` (gauntlet_v4+hard+pushback7)
- `eb6c523526be` (gauntlet_v4+hard+pushback8)
- `85483c3e7e10` (gauntlet_v4+hard+pushback9)
- `3992749ffee1` (gauntlet_v4+hard+pushback10)
