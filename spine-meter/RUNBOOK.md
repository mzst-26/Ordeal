# Run-day guide

Written for: you, on Saturday, working through the clock. Each step lists the exact command.
Run every command from the `spine-meter` folder.

## Money first

Only commands marked **PAID** call the Token Factory API. Everything else is free: the dry run, grading,
charts, the map, transcripts, the demo in replay mode and the tests.

The PAID commands read the key from `TOKEN_FACTORY_TOKEN`, from the environment or the `.env` file. Do not
paste the key into a command, a note or a file.

The costs below are upper bounds from the dry-run check (32 questions, 2 repeats, 3 models). A run can
make fewer calls: a wrong first answer skips the gauntlet, and the confession is asked only after a flip.
Retries count toward `--max-calls`.

| Run | Command | Most calls it can make |
| --- | --- | --- |
| Plan only (free) | `../.venv-spine/bin/python runner.py --dry-run` | 0 |
| Main run, all probes (PAID) | `../.venv-spine/bin/python runner.py --condition none --max-calls 10752` | 3,584 per model, 10,752 for 3 models |
| Main run, gauntlet only (PAID) | `../.venv-spine/bin/python runner.py --condition none --probes gauntlet --max-calls 2496` | 832 per model, 2,496 for 3 models |
| Fingerprint and twins only (PAID) | `../.venv-spine/bin/python runner.py --condition none --probes fingerprint,twins --max-calls 4800` | 1,600 per model, 4,800 for 3 models |
| Other condition, optional (PAID) | `../.venv-spine/bin/python runner.py --condition mitigation --max-calls 10752` | 10,752 for 3 models (same for `control` and `third_person`) |
| v4 plan only (free) | `../.venv-spine/bin/python runner.py --dry-run --ladder gauntlet_v4 --questions hard` | 0 |
| v4 main run, all probes (PAID) | `../.venv-spine/bin/python runner.py --ladder gauntlet_v4 --questions hard --condition none --max-calls 22662` | 7,554 per model, 22,662 for 3 models |
| v4 gauntlet only (PAID) | `../.venv-spine/bin/python runner.py --ladder gauntlet_v4 --questions hard --condition none --probes gauntlet --max-calls 5310` | 1,770 per model, 5,310 for 3 models |
| v4 fingerprint and twins only (PAID) | `../.venv-spine/bin/python runner.py --ladder gauntlet_v4 --questions hard --condition none --probes fingerprint,twins --max-calls 10974` | 3,658 per model, 10,974 for 3 models |

- `--max-calls` stops the run at that many API attempts, retries included. Exit code 2 means it stopped
  there. Run the same command again to continue; saved replies are reused.
- The main run includes the correction tests. They run for the 16 questions flagged `correction_test`.
- The v4 totals above are from the dry run with `--ladder gauntlet_v4 --questions hard` and an empty
  temporary cache. They are upper bounds until every first answer is saved, as the dry run says.
- Do not edit `ladder_v3.json`, `wrappers_v3.json`, `questions.json`, `ladder_v4.json`, `wrappers_v4.json`,
  `questions_hard.json`, or the prompt settings in `config.json` once a paid run starts. Any of those edits changes the version code. The old replies are then
  ignored, and must be paid for again. Changing the model list, the repeats or the concurrency is safe.

## The clock

| Time | Step | Command | Cost |
| --- | --- | --- | --- |
| 10:00 | Check-in. Confirm the key works. | `../.venv-spine/bin/python hello.py` | one small PAID call |
| 10:30 | Write down the three model names, rate-limit hints and the Token Factory link in `notes.md`. | none | free |
| 11:00 | Plan the run. Read the number of new calls. | `../.venv-spine/bin/python runner.py --dry-run` | free |
| 11:30 | Start the main run in its own terminal and leave it running. | `../.venv-spine/bin/python runner.py --condition none --max-calls 10752` | PAID |
| 12:30 | Grade the saved replies, then draw the charts and the map. | see "The analysis commands" | free |
| 13:00 | Hand-check 20 transcripts (10 flipped, 10 held). Count the grader mistakes. | see "Transcripts" | free |
| 13:45 | Optional: start the mitigation condition, only if time allows. | `../.venv-spine/bin/python runner.py --condition mitigation --max-calls 10752` | PAID |
| 14:00 | **Scope freeze.** Only fixes from here. | none | free |
| 14:15 | Pick one flipped and one held transcript for the slide. | see "Transcripts" | free |
| 14:45 | Test the demo in replay mode with Wi-Fi off. | `../.venv-spine/bin/python app.py`, then tick **Replay saved run** | free |
| 15:00 | Open the slide and check that all three pictures appear. | open `presentation/slide.html` in a browser | free |
| 15:15 | Record the 60-second backup video (steps below). | none | free |
| 15:30 | Rehearse the story twice with a timer. Use `presentation/pitch.md`, and fill in its square brackets. | none | free |
| 16:00 | Charge the laptop, close extra tabs, test Wi-Fi once. | `../.venv-spine/bin/python hello.py` if you want one live check | one small PAID call |
| 16:30 | Judging starts. Open the replay page first, the live round second. | `../.venv-spine/bin/python app.py` | free |

## v4 commands

Every command here is free unless it says PAID. Run from the `spine-meter` folder.

**Dry run for v4 (free).** It makes no calls. The temporary empty cache keeps the count at zero saved replies, so
the total is the full upper bound. Use a file in your scratch folder.

```
touch /path/to/scratch/empty_cache.jsonl
../.venv-spine/bin/python runner.py --dry-run --ladder gauntlet_v4 --questions hard --cache /path/to/scratch/empty_cache.jsonl
```

**v4 check without a model or a mock server (free).** The dry run above reads only the cache file. It sends no
request and starts no mock server, so it is the check to run before any paid v4 run. The tests are also free:

```
../.venv-spine/bin/python -m unittest discover -s tests -t .
```

**Calibration (PAID).** Each command calls the API unless `--base-url` names a localhost test server, which is
not used here. Run `baseline` first. `screen` reads the file that `baseline` writes.

```
make calibrate-baseline    # PAID, at most 236 calls (59 questions x 4 repeats)
make calibrate-screen      # PAID, at most 4,012 calls, after calibrate-baseline
```

The Makefile writes to `scratch/calibration/`. The calls above are for the model in the Makefile,
`nvidia/nemotron-3-super-120b-a12b`. Check `calibrate.py --help` (free) for the other flags.

**Fingerprint table (free).** It reads the saved replies and writes a CSV table and a radar picture to `--out-dir`.
It makes no calls. Use `--out-dir` to keep the output out of `results/` while you check it.

```
../.venv-spine/bin/python fingerprint.py --condition none --ladder gauntlet_v4 --questions hard
```

**Grade, charts and map for v4 (free).** Add the same two flags to each command.

```
../.venv-spine/bin/python grade.py --condition none --ladder gauntlet_v4 --questions hard
../.venv-spine/bin/python charts.py --condition none --ladder gauntlet_v4 --questions hard
../.venv-spine/bin/python map.py --condition none --ladder gauntlet_v4 --questions hard
```

## The analysis commands

After the main run finishes, these three commands make the results table, the charts and the map. Use
the same condition in each one.

```
../.venv-spine/bin/python grade.py --condition none
../.venv-spine/bin/python charts.py --condition none
../.venv-spine/bin/python map.py --condition none
```

The pictures are written to `results/flip_by_level_none.png`, `results/fingerprint_none.png` and
`results/map_none.png`. The slide shows all three. The fingerprint picture is skipped, and the script says
so, if the fingerprint probes did not run.

The numbers for `presentation/pitch.md` come from `results/results.csv` (the gauntlet columns) and
`results/probes.csv` (the probe rows). The `units` column shows how many units each model has.

For another condition, repeat the three commands with `--condition mitigation` (or `control` or
`third_person`). The slide shows only the `none` condition.

`grade.py` also writes `results/by_difficulty.csv`, with the results by question difficulty, question tier and
pushback type. It does not take the shuffle flags yet, so it does not grade a shuffled pushback run.

## Shuffle flags (optional)

`--shuffle-questions SEED` runs the questions in a random order. `--shuffle-pushbacks SEED` puts the movable
pushbacks in a random order. A pushback seed makes its own experiment code, so its replies stay apart from the
main run. The "Shuffle mode" section of `README.md` explains the rest. The dry run is free and shows the order:

```
../.venv-spine/bin/python runner.py --dry-run --shuffle-pushbacks 7
```

## Transcripts for checking and for the demo

```
../.venv-spine/bin/python transcripts.py --model Qwen/Qwen3-30B-A3B-Instruct-2507 --outcome flipped --count 10
../.venv-spine/bin/python transcripts.py --model Qwen/Qwen3-30B-A3B-Instruct-2507 --outcome held --count 10
```

Use a different `--seed` to see other transcripts. The same seed always prints the same ones. Each
transcript shows the first answer and the ten levels, with the first wrong level marked. It does not show
the confession or the probes; read those in `results/cache.jsonl` if you need them.

## Recording the backup video

1. Open QuickTime Player, then File, then New Screen Recording.
2. Start `app.py` and open the page in the browser.
3. Turn on **Replay saved run**. Pick a model and a question that the model answered correctly, then press
   Start.
4. Press Level 1 to Level 10 in order, pausing on the first answer that changes.
5. Stop the recording. Keep it under 60 seconds.

## If something goes wrong

| Problem | What to do |
| --- | --- |
| The main run is not finished in time | Stop it with Ctrl+C, or let `--max-calls` stop it. Grade what is saved (`grade.py` reads the partial cache). Check the `units` column, and say on the limits slide that the run was partial. |
| The paid run cannot finish at all | Run the gauntlet alone: `runner.py --condition none --probes gauntlet --max-calls 2496`. It gives the flip rates for at most 832 calls per model. Say that the probes were not run. |
| One model keeps failing | Run again with `--models` naming the other two models, then grade. Say which model is missing. |
| Rate-limit or other errors | Run the same command again. Each failed call prints a `Failed:` line, and the run ends with exit code 1. Saved replies are kept, and the rerun fills the gaps. |
| Wi-Fi or the API is down | Use replay mode. It needs no network, only saved replies. |
| Replay says "No saved reply" | Pick a question the model answered correctly. The levels are saved only for those. The confession is saved only after a flip. |
| Replay has nothing saved at all | Show `results/flip_by_level_none.png` and the transcripts output on the slide. Neither needs a network. |
| Grading or charts say "No saved replies" | Check that `--condition` matches the run. Then run `runner.py` for that condition first. |
| A result looks wrong | Run `transcripts.py` on that model and read the raw replies before you change anything. |
| A file was edited by mistake after the run | Undo the edit. The saved replies come back, because the version code is the same again. Do not run the paid calls again to fix it. |
