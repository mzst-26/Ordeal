"""Golden test for every message list the experiment sends.

The experiment sends the same messages for the same settings. This test builds the messages that
flows.run_flows sends for every condition, every question set with its ladder, and every probe family set.
It hashes each group with SHA-256 and compares the hashes with tests/fixtures/golden_prompts.json.
A changed prompt, question, ladder or probe file changes a hash, so the change shows up in a test
instead of in a batch of real results.

The model is replaced by a recording function that always returns the same reply, so nothing
is sent over the network and no API key is read.

To accept an intended change, write the fixture again and review the diff:
    .venv-spine/bin/python -m tests.test_golden_prompts --write
"""

import asyncio
import hashlib
import json
import sys
import unittest
from pathlib import Path

from ordeal import core
from ordeal import flows

FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "golden_prompts.json"
# The two suites the experiment runs: the default (gauntlet_v3 ladder, easy questions) and the hard one.
SUITE_PARTS = (("gauntlet_v3", "easy"), ("gauntlet_v4", "hard"))
# The probe family sets to check. "all" is what a full run asks for; the others check each family on its own.
FAMILY_SETS = {
    "all": flows.ALL_FAMILIES,
    "gauntlet": frozenset({flows.GAUNTLET}),
    "fingerprint_twins": frozenset({flows.FINGERPRINT, flows.TWINS}),
    "corrections": frozenset({flows.CORRECTIONS}),
    "dose": frozenset({flows.DOSE}),
}
# The reply the recording function gives to every call. It is a wrong letter for most questions, so the
# flows that follow a wrong answer (the confession check) are sent too.
FIXED_REPLY = "Answer: A"
DESCRIPTION = (
    "SHA-256 of every message list sent by flows.run_flows, per suite, condition and probe family set. "
    "Each hash covers all questions of the suite, in order. 'calls' counts the messages lists hashed."
)


def canonical_text(step, messages):
    """Return one call as text with sorted keys, so the same call always gives the same bytes."""
    # ensure_ascii=False keeps the text readable and still exact; sort_keys keeps dict order from mattering.
    return json.dumps({"step": step, "messages": messages}, sort_keys=True, ensure_ascii=False)


def recording_ask(reply, calls):
    """Return an async ask(step, messages) that answers with reply and appends each call's text to calls."""
    # run_flows awaits ask(step, messages). Recording the text at call time keeps a snapshot, so later
    # changes to the conversation list do not change what was recorded.
    async def ask(step, messages):
        calls.append(canonical_text(step, messages))
        return reply

    return ask


def question_calls(suite, question, system_prompt, families, config):
    """Return every call that one question sends, as text in order: the opening question, then the flows."""
    # The runner sends the opening question itself (as the baseline step), so it is recorded first here.
    opening = flows.build_first_messages(question, system_prompt)
    calls = [canonical_text(core.BASELINE_STEP, opening)]
    # The baseline is the right letter, as a correct model would answer, so every pressure flow runs.
    baseline_reply = f"Answer: {question['correct']}"
    ask = recording_ask(FIXED_REPLY, calls)
    asyncio.run(flows.run_flows(
        question, system_prompt, baseline_reply, ask, set(families),
        suite.ladder, suite.probe_spec, config,
    ))
    return calls


def group_entry(suite, system_prompt, families, config):
    """Return the number of calls and the SHA-256 that cover every question of one suite in one group."""
    digest = hashlib.sha256()
    call_count = 0
    for question in suite.questions:
        for text in question_calls(suite, question, system_prompt, families, config):
            # A newline between calls keeps two different call lists from giving the same bytes.
            digest.update((text + "\n").encode("utf-8"))
            call_count += 1
    return {"calls": call_count, "sha256": digest.hexdigest()}


def group_key(suite, condition, family_name):
    """Return the name of one group, such as 'gauntlet_v3+easy|none|all'. It is the key in the fixture."""
    return f"{suite.name}|{condition}|{family_name}"


def build_golden_hashes():
    """Return the hashes for every suite, condition and probe family set, keyed by group_key."""
    config = core.load_config()
    hashes = {}
    for ladder_name, question_set in SUITE_PARTS:
        suite = core.load_suite(ladder=ladder_name, questions=question_set)
        for condition in core.CONDITIONS:
            system_prompt = core.system_prompt_for(condition, config)
            for family_name, families in FAMILY_SETS.items():
                key = group_key(suite, condition, family_name)
                hashes[key] = group_entry(suite, system_prompt, families, config)
    return hashes


def write_fixture():
    """Write the golden fixture from the current code. Run this only after an intended change."""
    payload = {"description": DESCRIPTION, "hashes": build_golden_hashes()}
    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    # Sorted keys and a fixed indent make the file the same on every run, so a diff shows only real changes.
    text = json.dumps(payload, indent=1, sort_keys=True, ensure_ascii=False) + "\n"
    FIXTURE_PATH.write_text(text, encoding="utf-8")


class GoldenPromptTests(unittest.TestCase):
    """The messages sent for every group match the hashes saved in the golden fixture."""

    def test_every_group_matches_the_golden_hashes(self) -> None:
        # The assertion fails with a dict diff, so the group that changed is named in the failure message.
        expected = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))["hashes"]
        self.assertEqual(build_golden_hashes(), expected)


if __name__ == "__main__":
    # Only the --write flag is handled here; every other run is a normal unittest run.
    if "--write" in sys.argv:
        write_fixture()
        print(f"Wrote {FIXTURE_PATH}")
    else:
        unittest.main()
