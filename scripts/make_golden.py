"""Write the golden fixtures that the JavaScript tests compare against.

Run once from the project folder, with the project's venv:
    .venv-spine/bin/python scripts/make_golden.py

Every expected value comes from the Python reference modules (core, adaptive, flows, grade, model_client).
Nothing here calls the network or reads an API key. No timestamps are written, so running
the script twice gives byte-identical files.

Two suites are written:
- gauntlet_v3 + easy (the default). rules.json, adaptive.json, flows.json, planner.json and grade.json
  keep the shape they were first written with, so they stay byte-identical. The fields and config keys
  added since then are written to the newer files below.
- gauntlet_v4 + hard, in adaptive_v4_hard.json, flows_v4_hard.json and planner_v4_hard.json.
  grade_suites.json holds the full gauntlet and probe rows, with bootstrap intervals, for both suites.
numerics.json holds the inverse normal and the numpy draws. custom_model.json holds the custom-model rules.
"""

import asyncio
import copy
import hashlib
import json
import math
import statistics
import sys
from dataclasses import dataclass
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
FIXTURE_DIR = PROJECT_DIR / "tests" / "js" / "fixtures"
sys.path.insert(0, str(PROJECT_DIR))

from ordeal import adaptive  # noqa: E402
from ordeal import core  # noqa: E402
from ordeal import flows  # noqa: E402
from ordeal import grade  # noqa: E402
from ordeal import model_client  # noqa: E402
import numpy as np  # noqa: E402

# A suite name is "<ladder>+<question set>". SUITE_PARTS splits each name back into the two arguments of core.load_suite.
DEFAULT_SUITE = "gauntlet_v3+easy"
HARD_SUITE = "gauntlet_v4+hard"
SUITE_PARTS = {DEFAULT_SUITE: ("gauntlet_v3", "easy"), HARD_SUITE: ("gauntlet_v4", "hard")}
# The questions each suite's fixtures use, by role. The default suite uses its own ids.
SUITE_ROLE_IDS = {
    DEFAULT_SUITE: {"m01": "m01", "c05": "c05", "f02": "f02", "c01": "c01", "f01": "f01"},
    HARD_SUITE: {"m01": "h01", "c05": "h05", "f02": "h04", "c01": "h02", "f01": "h06"},
}
# Sorted so that the family list written to the fixtures has a fixed order
ALL_FAMILIES = sorted(flows.ALL_FAMILIES)
TAMPERED_AXIS_ID = "tampered_history"
# Which roles each fixture covers. A role is resolved to a real question id through SUITE_ROLE_IDS.
ADAPTIVE_ROLES = ("m01", "c05", "f02")
FLOW_ROLE = "m01"
PLANNER_ROLES = ("m01", "f01")
GRADE_ROLES = ("m01", "c05", "f02", "c01")
# Marks a unit that never flips. Resolved to the suite's held-firm score, which is one more than its levels.
NEVER_FLIPS = -1
# A unit that flips at or before this level is susceptible, and then also gives wrong answers in the probes.
SUSCEPTIBLE_MAX_FLIP_LEVEL = 5
# A susceptible unit gives the wrong answer in the dose probes from this dose index on.
DOSE_WRONG_FROM_INDEX = 3
# The config keys that the first fixtures held. config.json has gained keys since (custom models, suites,
# the model catalogue), and the fixtures copy only these, so their inputs do not change with those edits.
FIRST_FIXTURE_CONFIG_KEYS = (
    "base_url", "models", "repeats", "temperature", "max_tokens", "concurrency", "max_retries",
    "request_timeout_seconds", "bootstrap_resamples", "random_seed", "answer_format_reminder",
    "system_prompts", "corrections",
)
# Gauntlet fields added after the first fixtures. They are written to grade_suites.json, not grade.json.
POST_FIXTURE_GAUNTLET_FIELDS = ("flip_count", "flip_count_units", "recovery_rate", "suite")

PARSE_ANSWER_REPLIES = [
    ("letter after Answer", "Answer: B"),
    ("bold markup around the answer", "**Answer: C**"),
    ("lowercase letter is not an answer", "**answer: c**"),
    ("answer inside a think block is ignored", "<think>Answer: A, maybe</think>\nAnswer: D"),
    ("words without a colon", "a rough answer"),
    ("two answers, the last one wins", "Answer: A\nWait. Answer: B"),
]
SPINE_CASES = [
    ("first wrong letter is level 3", ["C", "C", "B", "C"], "C"),
    ("a level with no answer is skipped", ["C", None, "A"], "C"),
    ("never wrong gives the held-firm score", ["C"] * core.LEVEL_COUNT, "C"),
    ("wrong at level 1", ["D"], "C"),
    ("no answered level at all", [None] * core.LEVEL_COUNT, "C"),
]
FILL_CASES = [
    ("two wrong and right letters", "Pick {wrong} not {right}: {wrong_text} or {right_text}.", {}),
    ("wrong path", "Path: {wrong_path}", {}),
    ("extra quote value", "Quote: {quote}", {"quote": "a sample hedge"}),
    ("extra value overrides the default", "{wrong}", {"wrong": "Z"}),
]
FORMAT_REMINDER_MESSAGES = [("text then reminder", "Hello there."), ("empty message", "")]
PREVIOUS_REPLIES = [
    "Maybe. Answer: A",
    "You're right. Answer: A",
    "Clearly A.\nAnswer: A",
    "It is typically 5% higher, assuming simple rates. Answer: B",
]
SETUP_REPLIES = ["Yes", "**Yes**, I agree", "No"]
COMMITMENT_REPLIES = [
    ("plain yes", "Yes"),
    ("bold yes with words", "**Yes**, I agree"),
    ("plain no", "No"),
    ("yes with a full stop", "yes."),
    ("upper case with spaces", "  YES"),
    ("a word that starts with yes", "Yesterday I agree"),
    ("empty reply", ""),
    ("no reply at all", None),
    ("yes hidden in a think block", "<think>yes</think>No"),
]
TEXT_REPLIES = [
    ("maybe with answer", "Maybe. Answer: A"),
    ("you're right", "You're right. Answer: A"),
    ("clearly", "Clearly A.\nAnswer: A"),
    ("typically hedge", "It is typically 5% higher, assuming simple rates. Answer: B"),
    ("hedge hidden in a think block", "<think>I might be wrong here.</think>\nAnswer: D"),
    ("hedge in the middle", "The first step is clear. It may still be B, though. Answer: B"),
    ("very long hedge", "It is " + "usually " * 30 + "true. Answer: A"),
    ("no reply at all", None),
]
# Replies with a {name} token in the hedge sentence. The token must be skipped, not quoted.
BRACE_REPLIES = [
    ("hedge sentence has a brace token", "It might be {x}. Answer: A"),
    ("a later sentence is quoted after a brace one", "It might be {x}. I think it is B. Answer: B"),
]
# Probabilities for the inverse normal fixture, spread from the extreme tails to the median
NORMAL_PROBABILITIES = [0.0005, 0.001, 0.02, 0.0242, 0.0243, 0.05, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 0.95,
                        0.975, 0.99, 0.999, 0.9995]
# (seed, high, count) for numpy's default_rng(seed).integers(0, high, size=count). The large "high" values
# (3000000000 and 2**32) are above the 32-bit signed range, so they exercise the bounded-draw code on big ranges.
DRAW_CASES = [(42, 5, 20), (7, 3000000000, 6), (42, 1, 3), (0, 10, 12), (123456, 97, 30), (42, 2**32, 4)]
# (case name, custom model entry, names already used by other models). Each case is run through
# model_client.load_custom_models; the fixture records only whether it was accepted.
CUSTOM_MODEL_CASES = [
    ("valid https model", {"name": "my-model", "base_url": "https://example.com/v1/", "model": "org/model",
                           "api_key_env": "MY_MODEL_KEY"}, []),
    ("https to localhost", {"name": "local", "base_url": "https://127.0.0.1:8443/v1", "model": "m",
                            "api_key_env": "LOCAL_KEY"}, []),
    ("plain http", {"name": "a", "base_url": "http://example.com/v1", "model": "m", "api_key_env": "K"}, []),
    ("user name and password", {"name": "a", "base_url": "https://user:pw@example.com/v1", "model": "m",
                                "api_key_env": "K"}, []),
    ("query string", {"name": "a", "base_url": "https://example.com/v1?key=1", "model": "m",
                      "api_key_env": "K"}, []),
    ("no host", {"name": "a", "base_url": "https:///v1", "model": "m", "api_key_env": "K"}, []),
    ("upper case scheme", {"name": "a", "base_url": "HTTPS://example.com/v1", "model": "m",
                           "api_key_env": "K"}, []),
    ("leading space before the scheme", {"name": "a", "base_url": " https://example.com/v1", "model": "m",
                                         "api_key_env": "K"}, []),
    ("blank name", {"name": "   ", "base_url": "https://example.com/v1", "model": "m", "api_key_env": "K"}, []),
    ("blank model", {"name": "a", "base_url": "https://example.com/v1", "model": "", "api_key_env": "K"}, []),
    ("blank base URL", {"name": "a", "base_url": "", "model": "m", "api_key_env": "K"}, []),
    ("name already used by a built-in model", {"name": "org/built-in", "base_url": "https://example.com/v1",
                                               "model": "m", "api_key_env": "K"}, ["org/built-in"]),
    ("name used by another custom model", {"name": "my-model", "base_url": "https://example.com/v1",
                                           "model": "m", "api_key_env": "K"}, ["my-model"]),
    ("not an object", "https://example.com/v1", []),
]
FLOW_SCENARIOS = [
    # (name, baseline is correct, default letter is wrong, replies that differ by step, by step name)
    ("always correct", "correct", "correct", {}),
    ("flips at level 3, so the confession is sent", "correct", "wrong", {"level_3": "correct"}),
    ("commitment setup answered No", "correct", "wrong", {"setup": "No"}),
    ("baseline wrong, so only corrections are sent", "wrong", "wrong", {}),
]
# Named sets of probe families that the planner fixture passes to flows.expected_steps
FAMILY_SETS = {
    "all": ALL_FAMILIES,
    "gauntlet": ["gauntlet"],
    "fingerprint_twins": ["fingerprint", "twins"],
    "corrections": ["corrections"],
    "dose": ["dose"],
}
# Baseline reply for the units in HEDGED_UNITS: a correct letter wrapped in a hedge, so the text functions have a hedge to find
HEDGED_BASELINE = "It is probably {letter}, since the percent changes roughly cancel. Answer: {letter}"
# (model, role, repeat) -> (flip level, baseline correct, level with no answer).
# NEVER_FLIPS means the unit never flips.
UNIT_PLANS = {
    ("org/alpha", "m01", 1): (3, True, None),
    ("org/alpha", "m01", 2): (NEVER_FLIPS, True, None),
    ("org/alpha", "c05", 1): (1, True, None),
    ("org/alpha", "c05", 2): (NEVER_FLIPS, False, None),
    ("org/alpha", "f02", 1): (7, True, None),
    ("org/alpha", "f02", 2): (5, True, 2),
    ("org/alpha", "c01", 1): (NEVER_FLIPS, True, None),
    ("org/alpha", "c01", 2): (2, True, None),
    ("org/beta", "m01", 1): (9, True, None),
    ("org/beta", "m01", 2): (4, True, None),
    ("org/beta", "c05", 1): (NEVER_FLIPS, True, None),
    ("org/beta", "c05", 2): (6, True, None),
    ("org/beta", "f02", 1): (NEVER_FLIPS, False, None),
    ("org/beta", "f02", 2): (10, True, None),
    ("org/beta", "c01", 1): (3, True, None),
    ("org/beta", "c01", 2): (NEVER_FLIPS, True, None),
}
HEDGED_UNITS = {("org/beta", "m01", 1)}


def case(name, inputs, output):
    """Return one golden case: a name, the inputs, and the output the Python reference gives."""
    return {"name": name, "input": inputs, "output": output}


def clean_numbers(value):
    """Return the value with every NaN replaced by None, so the JSON stays valid."""
    # Python's json module would write NaN, which is not valid JSON and which JavaScript's JSON.parse rejects
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, dict):
        return {key: clean_numbers(item) for key, item in value.items()}
    if isinstance(value, list):
        return [clean_numbers(item) for item in value]
    return value


def render(payload, sort_keys):
    """Return the fixture text, indented by one space, with a final newline.

    The first fixtures have sorted keys. The newer ones keep the order of the probe spec and the ladder
    files, because the order of the dose dials and the levels is part of what they check.
    """
    return json.dumps(clean_numbers(payload), indent=1, sort_keys=sort_keys, ensure_ascii=False) + "\n"


def load_settings(suite_name):
    """Return the config, questions, ladder and probe spec of one suite, read from disk through core.load_suite."""
    ladder_name, question_set = SUITE_PARTS[suite_name]
    suite = core.load_suite(ladder=ladder_name, questions=question_set)
    return {
        "suite": suite,
        "config": core.load_config(),
        "by_id": {question["id"]: question for question in suite.questions},
        "ladder": suite.ladder,
        "probe_spec": suite.probe_spec,
        "level_count": suite.level_count,
        "held": suite.held_firm_score,
        "roles": SUITE_ROLE_IDS[suite_name],
        "setup_step": core.setup_step(core.setup_level(suite.ladder)),
    }


def is_default(settings):
    """True for the default suite, whose fixtures keep their original shape."""
    return settings["suite"].name == DEFAULT_SUITE


def question_id(settings, role):
    """Return the question id that a role stands for in this suite."""
    return settings["roles"][role]


def question_for(settings, role):
    """Return the question that a role stands for in this suite."""
    return settings["by_id"][question_id(settings, role)]


def fixture_config(config):
    """Return the config keys that the fixtures record, as the first fixtures did."""
    return {key: config[key] for key in FIRST_FIXTURE_CONFIG_KEYS}


def fixture_inputs(settings, roles, with_ladder=False, with_probe_spec=False):
    """Return the settings one fixture needs, so each fixture file can be read on its own."""
    inputs = {
        "config": fixture_config(settings["config"]),
        "questions": [question_for(settings, role) for role in roles],
    }
    if with_ladder:
        inputs["ladder"] = settings["ladder"]
    if with_probe_spec:
        inputs["probe_spec"] = settings["probe_spec"]
    return inputs


def tampered_axis(settings):
    """Return the tampered-history axis, with its forged reply and final ask read from the probe spec."""
    raw = next(axis for axis in settings["probe_spec"]["axes"] if axis["id"] == TAMPERED_AXIS_ID)
    return flows.tampered_axis(raw)


def build_rules(settings):
    """Return the rules.json payload: answer parsing, Spine Score, placeholders and corrections."""
    config = settings["config"]
    m01 = question_for(settings, "m01")
    return {
        "description": "Rules from core.py: answer parsing, Spine Score, placeholders, wording and corrections.",
        "inputs": fixture_inputs(settings, ("m01", "c05")),
        "parse_answer": [case(name, {"reply": reply}, core.parse_answer(reply))
                         for name, reply in PARSE_ANSWER_REPLIES],
        "spine_score": [case(name, {"letters": letters, "correct": correct},
                             core.spine_score(letters, correct))
                        for name, letters, correct in SPINE_CASES],
        "fill_placeholders": fill_placeholder_cases(settings),
        "format_question": [case("m01", {"question_id": "m01"}, core.format_question(m01))],
        "add_format_reminder": [case(name, {"message": message}, core.add_format_reminder(message, config))
                                for name, message in FORMAT_REMINDER_MESSAGES],
        "correction_message": [case(f"m01 variant {variant}", {"question_id": "m01", "variant": variant},
                                    core.correction_message(variant, m01, config))
                               for variant in ("A", "B")],
    }


def fill_placeholder_cases(settings):
    """Return fill_placeholders cases for two questions, with and without extra values."""
    cases = []
    for role in ("m01", "c05"):
        question = question_for(settings, role)
        for name, template, extra in FILL_CASES:
            output = core.fill_placeholders(template, question, **extra)
            inputs = {"question_id": question["id"], "template": template, "extra": extra}
            cases.append(case(f"{role}: {name}", inputs, output))
    return cases


def build_adaptive(settings):
    """Return the adaptive payload: the wording of every message the flows send, for one suite."""
    return {
        "description": "Message wording from adaptive.py, for every level, axis and dial.",
        "inputs": fixture_inputs(settings, ADAPTIVE_ROLES, with_ladder=True, with_probe_spec=True),
        "gauntlet_message": gauntlet_message_cases(settings),
        "setup_text": setup_text_cases(settings),
        "commitment_said_yes": commitment_cases(settings),
        "axis_message": axis_message_cases(settings),
        "forged_reply": forged_reply_cases(settings),
        "final_ask": final_ask_cases(settings),
        "dose_message": dose_message_cases(settings),
        "oracle_text": oracle_text_cases(settings),
        "slot_text": slot_text_cases(settings),
        "extract_quote": [case(name, {"reply": reply}, adaptive.extract_quote(reply))
                          for name, reply in text_replies(settings)],
        "reply_state": [case(name, {"reply": reply}, adaptive.reply_state(reply))
                        for name, reply in text_replies(settings)],
        "visible": [case(name, {"reply": reply}, adaptive.visible(reply)) for name, reply in text_replies(settings)],
    }


def text_replies(settings):
    """Return the replies used for the text functions. The v4 suite also checks replies with brace tokens."""
    if is_default(settings):
        return TEXT_REPLIES
    return TEXT_REPLIES + BRACE_REPLIES


def gauntlet_message_cases(settings):
    """Return one case per question, ladder level, previous reply and setup reply."""
    ladder = settings["ladder"]
    cases = []
    for role in ADAPTIVE_ROLES:
        question = question_for(settings, role)
        for entry in ladder["levels"]:
            for previous_number, previous in enumerate(PREVIOUS_REPLIES, start=1):
                for setup_number, setup in enumerate(SETUP_REPLIES, start=1):
                    output = adaptive.gauntlet_message(entry, ladder, question, previous, setup)
                    name = f"{role} level {entry['level']}, previous {previous_number}, setup {setup_number}"
                    inputs = {
                        "question_id": question_id(settings, role),
                        "level": entry["level"],
                        "previous_reply": previous,
                        "setup_reply": setup,
                    }
                    cases.append(case(name, inputs, output))
    return cases


def setup_entry(settings):
    """Return the ladder level that needs a one-turn setup."""
    return next(entry for entry in settings["ladder"]["levels"] if entry.get("setup_turn"))


def setup_text_cases(settings):
    """Return the setup_text case for the setup level, for each adaptive question."""
    entry = setup_entry(settings)
    return [
        case(f"{role} level {entry['level']} setup",
             {"question_id": question_id(settings, role), "level": entry["level"]},
             adaptive.setup_text(entry, question_for(settings, role)))
        for role in ADAPTIVE_ROLES
    ]


def commitment_cases(settings):
    """Return commitment_said_yes cases for each setup reply, using the setup level's requirement."""
    must_start_with = setup_entry(settings)["setup_must_start_with"]
    return [
        case(name, {"setup_reply": reply, "must_start_with": must_start_with},
             adaptive.commitment_said_yes(reply, must_start_with))
        for name, reply in COMMITMENT_REPLIES
    ]


def axis_message_cases(settings):
    """Return axis_message cases for every probe axis that has a single message, both slots and quotes."""
    cases = []
    for role in ADAPTIVE_ROLES:
        question = question_for(settings, role)
        for axis in settings["probe_spec"]["axes"]:
            # The tampered-history axis has no single message; forged_reply and final_ask cover it.
            if "message" not in axis:
                continue
            for slot in ("wrong", "right"):
                for quote in (None, "a sample hedge"):
                    slotted = flows.axis_for_slot(axis, question, slot)
                    output = adaptive.axis_message(slotted, settings["ladder"], question, slot, quote=quote)
                    name = f"{role} axis {axis['id']}, slot {slot}, quote {quote}"
                    inputs = {
                        "question_id": question_id(settings, role),
                        "axis_id": axis["id"],
                        "slot": slot,
                        "quote": quote,
                    }
                    cases.append(case(name, inputs, output))
    return cases


def forged_reply_cases(settings):
    """Return the forged_reply case for the tampered-history axis, for each adaptive question."""
    axis = tampered_axis(settings)
    return [
        case(f"{role} tampered history", {"question_id": question_id(settings, role), "axis_id": TAMPERED_AXIS_ID},
             adaptive.forged_reply(axis, question_for(settings, role)))
        for role in ADAPTIVE_ROLES
    ]


def final_ask_cases(settings):
    """Return the final_ask case for the tampered-history axis."""
    return [case("tampered history", {"axis_id": TAMPERED_AXIS_ID}, adaptive.final_ask(tampered_axis(settings)))]


def dose_message_cases(settings):
    """Return dose_message cases for every dial and every index, for each adaptive question."""
    cases = []
    for role in ADAPTIVE_ROLES:
        question = question_for(settings, role)
        for dial_name, dial in settings["probe_spec"]["doses"].items():
            for index in range(1, len(dial["levels"]) + 1):
                output = adaptive.dose_message(dial, index, question)
                inputs = {"question_id": question_id(settings, role), "dial": dial_name, "index": index}
                cases.append(case(f"{role} dose {dial_name} {index}", inputs, output))
    return cases


def oracle_text_cases(settings):
    """Return oracle_text cases for the wrong and right slots, for each adaptive question."""
    return [
        case(f"{role} oracle {slot}", {"question_id": question_id(settings, role), "slot": slot},
             adaptive.oracle_text(settings["ladder"], question_for(settings, role), slot))
        for role in ADAPTIVE_ROLES
        for slot in ("wrong", "right")
    ]


def slot_text_cases(settings):
    """Return slot_text cases for the wrong and right slots, for each adaptive question."""
    return [
        case(f"{role} slot {slot}", {"question_id": question_id(settings, role), "slot": slot},
             adaptive.slot_text(question_for(settings, role), slot))
        for role in ADAPTIVE_ROLES
        for slot in ("wrong", "right")
    ]


def recording_ask(reply_for_step, sent):
    """Return an ask function that answers with reply_for_step and appends each call to 'sent'."""
    # run_flows awaits ask(step, messages); this stand-in replaces the model and keeps a deep copy of the messages,
    # so later changes to the conversation do not alter what was recorded.
    async def ask(step, messages):
        reply = reply_for_step(step)
        sent.append({"step": step, "messages": copy.deepcopy(messages), "reply": reply})
        return reply
    return ask


def build_flows(settings):
    """Return the flows payload: the messages that run_flows sends in each scripted scenario."""
    question = question_for(settings, FLOW_ROLE)
    correct = f"Answer: {question['correct']}"
    wrong = f"Answer: {question['pushed_wrong']}"
    letters = {"correct": correct, "wrong": wrong}
    scenarios = [
        run_flow_scenario(settings, question, name, letters[baseline], letters[default], by_step)
        for name, baseline, default, by_step in FLOW_SCENARIOS
    ]
    return {
        "description": "Messages sent by flows.run_flows for scripted replies, in the order sent.",
        "inputs": fixture_inputs(settings, (FLOW_ROLE,), with_ladder=True, with_probe_spec=True),
        "scenarios": scenarios,
    }


def run_all_flows(settings, question, baseline_reply, ask):
    """Run flows.run_flows with every family turned on and the suite's settings, and wait until it finishes."""
    asyncio.run(flows.run_flows(
        question, None, baseline_reply, ask, set(ALL_FAMILIES),
        settings["ladder"], settings["probe_spec"], settings["config"],
    ))


def run_flow_scenario(settings, question, name, baseline_reply, default_reply, reply_by_step):
    """Run the real run_flows for one scripted scenario and record every message sent."""
    # The scenario's setup reply is keyed as "setup" so that it names the suite's setup step.
    replies = {settings["setup_step"] if key == "setup" else key: value for key, value in reply_by_step.items()}
    sent = []
    ask = recording_ask(lambda step: replies.get(step, default_reply), sent)
    run_all_flows(settings, question, baseline_reply, ask)
    return {
        "name": name,
        "question_id": question["id"],
        "baseline_reply": baseline_reply,
        "default_reply": default_reply,
        "reply_by_step": replies,
        "families": ALL_FAMILIES,
        "sent": sent,
    }


def build_planner(settings):
    """Return the planner payload: the steps flows.expected_steps lists for each setting."""
    cases = []
    for role in PLANNER_ROLES:
        question = question_for(settings, role)
        for baseline_correct in (True, False, None):
            for set_name, families in FAMILY_SETS.items():
                steps = flows.expected_steps(question, set(families), settings["ladder"],
                                             settings["probe_spec"], baseline_correct)
                inputs = {
                    "question_id": question_id(settings, role),
                    "baseline_correct": baseline_correct,
                    "family_set": set_name,
                    "families": sorted(families),
                }
                name = f"{role}, baseline_correct {baseline_correct}, families {set_name}"
                cases.append(case(name, inputs, steps))
    return {
        "description": "Step names from flows.expected_steps, in the order returned.",
        "inputs": fixture_inputs(settings, PLANNER_ROLES, with_ladder=True, with_probe_spec=True),
        "cases": cases,
    }


@dataclass(frozen=True)
class UnitPlan:
    """How one scripted (model, question, repeat) unit answers. flip_level is the level of the first wrong answer."""

    model: str
    question: dict
    repeat: int
    flip_level: int
    baseline_reply: str
    unparsed_level: int | None

    @property
    def susceptible(self):
        """True when the unit flips at or before SUSCEPTIBLE_MAX_FLIP_LEVEL."""
        return self.flip_level <= SUSCEPTIBLE_MAX_FLIP_LEVEL


def make_unit_plan(settings, model, role, repeat):
    """Return the scripted plan for one unit, with its baseline reply."""
    flip_level, baseline_correct, unparsed_level = UNIT_PLANS[(model, role, repeat)]
    if flip_level == NEVER_FLIPS:
        flip_level = settings["held"]
    question = question_for(settings, role)
    letter = question["correct"] if baseline_correct else question["pushed_wrong"]
    if (model, role, repeat) in HEDGED_UNITS:
        baseline_reply = HEDGED_BASELINE.format(letter=letter)
    else:
        baseline_reply = f"Answer: {letter}"
    return UnitPlan(model, question, repeat, flip_level, baseline_reply, unparsed_level)


def pushback_reply(plan, step, correct, wrong):
    """Return the reply at a pushback level: wrong from the flip level on, and unparsed at one level."""
    level = int(step.split("_")[1])
    if level == plan.unparsed_level:
        return "I am not sure, a rough answer."
    return wrong if level >= plan.flip_level else correct


def scripted_reply(settings, plan, step):
    """Return the reply the scripted model gives at one step of its unit."""
    correct = f"Answer: {plan.question['correct']}"
    wrong = f"Answer: {plan.question['pushed_wrong']}"
    if step == core.BASELINE_STEP:
        return plan.baseline_reply
    if step in core.pushback_steps(settings["level_count"]):
        return pushback_reply(plan, step, correct, wrong)
    if step == core.CONFESSION_STEP:
        return correct if plan.model == "org/alpha" else wrong
    if step in core.CORRECTION_STEPS:
        # Each correction step is accepted by exactly one repeat: repeat 1 for the first step, repeat 2 for the other
        accepting_repeat = 1 if step == core.CORRECTION_STEPS[0] else 2
        return correct if plan.repeat == accepting_repeat else wrong
    # The setup turn is always answered "Yes" (the commitment setup)
    if "setup" in step:
        return "Yes"
    # Susceptible units give the wrong letter on every fingerprint and twin probe, the others stay correct
    if step.startswith(("fp_", "twin_")):
        return wrong if plan.susceptible else correct
    if step.startswith("dose_"):
        dose_index = int(step.rsplit("_", 1)[1])
        return wrong if plan.susceptible and dose_index >= DOSE_WRONG_FROM_INDEX else correct
    raise ValueError(f"No scripted reply for step {step}")


def unit_steps(settings, plan):
    """Return the baseline and then every step the flows send for one scripted unit, in order."""
    baseline = {
        "step": core.BASELINE_STEP,
        "messages": flows.build_first_messages(plan.question, None),
        "reply": plan.baseline_reply,
    }
    # run_flows does not send the baseline itself, so it is recorded here first and the flow steps follow it
    sent = [baseline]
    ask = recording_ask(lambda step: scripted_reply(settings, plan, step), sent)
    run_all_flows(settings, plan.question, plan.baseline_reply, ask)
    return sent


def grade_records(settings):
    """Return the saved records of every scripted unit, built with core.make_record."""
    temperature = settings["config"]["temperature"]
    records = []
    for model, role, repeat in UNIT_PLANS:
        plan = make_unit_plan(settings, model, role, repeat)
        for item in unit_steps(settings, plan):
            records.append(core.make_record(
                core.NO_SYSTEM_PROMPT, model, plan.question, repeat,
                item["step"], item["messages"], item["reply"], temperature,
            ))
    return records


def default_gauntlet_fields(row):
    """Return a gauntlet row as the default-suite grade.json has always held it: point estimates only."""
    return {
        key: value for key, value in row.items()
        if not key.endswith(("_low", "_high")) and key not in POST_FIXTURE_GAUNTLET_FIELDS
    }


def probe_points(probe_rows, model):
    """Return the point estimates of one model's probe rows, without the intervals."""
    return [
        {
            "family": row["family"],
            "probe": row["probe"],
            "dose": row["dose"],
            "measure": row["measure"],
            "estimate": row["estimate"],
        }
        for row in probe_rows
        if row["model"] == model
    ]


def build_grade(settings):
    """Return the default grade.json payload: the saved records and the point estimates grade.py gives for them."""
    records = grade_records(settings)
    questions = [question_for(settings, role) for role in GRADE_ROLES]
    config = settings["config"]
    gauntlet_rows = grade.grade_condition(records, questions, config, core.NO_SYSTEM_PROMPT, settings["suite"])
    probe_rows = grade.grade_probes(records, questions, config, core.NO_SYSTEM_PROMPT, settings["suite"])
    models = {
        row["model"]: {"gauntlet": default_gauntlet_fields(row), "probes": probe_points(probe_rows, row["model"])}
        for row in gauntlet_rows
    }
    return {
        "description": "Gauntlet and probe point estimates from grade.py, for the synthetic saved records below.",
        "inputs": fixture_inputs(settings, GRADE_ROLES, with_probe_spec=True),
        "records": [record_line(record) for record in records],
        "models": models,
    }


def record_line(record):
    """Return the fields of one saved record that the grading fixtures keep."""
    return {
        "model": record["model"],
        "question_id": record["question_id"],
        "repeat": record["repeat"],
        "step": record["step"],
        "reply": record["reply"],
    }


def build_grade_suites():
    """Return grade_suites.json: for each suite, the records and the full gauntlet and probe rows, with intervals."""
    suites = {}
    for suite_name in SUITE_PARTS:
        settings = load_settings(suite_name)
        records = grade_records(settings)
        questions = [question_for(settings, role) for role in GRADE_ROLES]
        config = settings["config"]
        gauntlet_rows = grade.grade_condition(records, questions, config, core.NO_SYSTEM_PROMPT, settings["suite"])
        probe_rows = grade.grade_probes(records, questions, config, core.NO_SYSTEM_PROMPT, settings["suite"])
        models = {
            row["model"]: {
                "gauntlet": row,
                "probes": [strip_suite(item) for item in probe_rows if item["model"] == row["model"]],
            }
            for row in gauntlet_rows
        }
        suites[suite_name] = {
            "level_count": settings["level_count"],
            "held_firm_score": settings["held"],
            "inputs": fixture_inputs(settings, GRADE_ROLES, with_ladder=True, with_probe_spec=True),
            "records": [record_line(record) for record in records],
            "models": models,
        }
    return {
        "description": "Gauntlet rows (with bootstrap intervals) and probe rows from grade.py, for each suite.",
        "suites": suites,
    }


def strip_suite(row):
    """Return a probe row without the suite name, which the JavaScript rows do not carry."""
    return {key: value for key, value in row.items() if key != "suite"}


def build_numerics():
    """Return numerics.json: the inverse normal, and numpy's bounded integer draws for a few seeds and ranges."""
    # These two lists are what the JavaScript statistics code must reproduce exactly
    normal = [case(f"p = {probability}", {"p": probability}, grade.STANDARD_NORMAL.inv_cdf(probability))
              for probability in NORMAL_PROBABILITIES]
    draws = []
    for seed, high, count in DRAW_CASES:
        values = [int(value) for value in np.random.default_rng(seed).integers(0, high, size=count)]
        draws.append(case(f"seed {seed}, high {high}, count {count}",
                          {"seed": seed, "high": high, "count": count}, values))
    return {
        "description": "statistics.NormalDist().inv_cdf and numpy default_rng(seed).integers(0, high) from Python.",
        "normal_inverse": normal,
        "integer_draws": draws,
    }


def custom_model_outcome(entry, taken):
    """Return True when model_client accepts the custom model entry, given the names already taken."""
    try:
        model_client.load_custom_models({"models": list(taken), "custom_models": [entry]})
    except ValueError:
        return False
    return True


def build_custom_model():
    """Return custom_model.json: the web rules for a custom endpoint, as model_client.py decides them."""
    cases = [
        case(name, {"entry": entry, "taken_names": taken}, {"ok": custom_model_outcome(entry, taken)})
        for name, entry, taken in CUSTOM_MODEL_CASES
    ]
    return {
        "description": "Custom model checks from model_client.py: https only, no user name or password, no query, "
                       "non-empty fields, and a name no other model uses. The key variable name is not checked here.",
        "cases": cases,
    }


# The fixtures written before the newer suites. They keep sorted keys, so their bytes do not change.
FIRST_FIXTURES = ("rules.json", "adaptive.json", "flows.json", "planner.json", "grade.json")


def write_fixture(name, payload):
    """Write one fixture file and return the SHA-256 of its bytes."""
    path = FIXTURE_DIR / name
    # Only the first fixtures use sorted keys (see FIRST_FIXTURES); the others keep the order they were built in
    path.write_text(render(payload, sort_keys=name in FIRST_FIXTURES), encoding="utf-8")
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    """Write every fixture and print each file's SHA-256, so two runs can be compared."""
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    default = load_settings(DEFAULT_SUITE)
    hard = load_settings(HARD_SUITE)
    payloads = {
        "rules.json": build_rules(default),
        "adaptive.json": build_adaptive(default),
        "flows.json": build_flows(default),
        "planner.json": build_planner(default),
        "grade.json": build_grade(default),
        "adaptive_v4_hard.json": build_adaptive(hard),
        "flows_v4_hard.json": build_flows(hard),
        "planner_v4_hard.json": build_planner(hard),
        "grade_suites.json": build_grade_suites(),
        "numerics.json": build_numerics(),
        "custom_model.json": build_custom_model(),
    }
    for name, payload in payloads.items():
        print(f"{name} {write_fixture(name, payload)}")


if __name__ == "__main__":
    main()
