"""Flags answer keys that the AI screen disagrees with, and summarises how many keys are checked.

An answer key is the letter we say is correct for a question. A judge that sees the key tends to agree
with it, so the screen is built to answer blind: a model sees only the question and its options, never
the key. The AI is only a flag. It says "a person should look at this one". A human makes the decision,
and only two blind human answers that agree can mark a key as verified (see ordeal/data/key_checks.json).

A maintainer runs this script by hand. Without --run it spends nothing: it reads the saved screen
results and prints the flags and the summary. With --run it asks the screen models once, saves the
answers to results/key_screen.json (a folder that git ignores), and then prints the same output.

The pure rules (what to flag, how to count) need no network, so the tests run them on plain letters.
"""

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_DIR))

import openai  # noqa: E402  (needs the project folder on sys.path first)

from ordeal import core, keys, providers  # noqa: E402

QUESTIONS_PATH = PROJECT_DIR / "ordeal" / "data" / "questions.json"
KEY_CHECKS_PATH = PROJECT_DIR / "ordeal" / "data" / "key_checks.json"
RESULTS_PATH = PROJECT_DIR / "results" / "key_screen.json"
# The screen models come from the Nebius platform. None of them is in the study, so the screen is independent of it.
SCREEN_PLATFORM_ID = "nebius"
SCREEN_MODELS = ("zai-org/GLM-5.3", "deepseek-ai/DeepSeek-V4-Pro", "moonshotai/Kimi-K2.6")
# Each model answers each question this many times, so an unsure model shows up as disagreeing samples.
SAMPLES_PER_MODEL = 3
# Calls run side by side to keep the screen quick. Eight is gentle enough for a hosted API.
WORKER_COUNT = 8

# Reasons written next to a flagged question. They are plain words, so a person can read them at a glance.
REASON_DIFFERS = "differs from key"
REASON_DISAGREE = "screen answers disagree"


def blind_view(question):
    """Return only the question text and its options. This is all a screen model is allowed to see.

    The key, the wrong answers and the trap notes are left out on purpose. A model that knows the key
    tends to agree with it, so keeping these fields out is what keeps the screen honest.
    """
    return {"question": question["question"], "options": question["options"]}


def flag_reasons(key, letters):
    """Return the reasons a question is flagged, or [] when it is not flagged.

    The letters are the screen answers from every model and every sample. A None means the reply had no
    clear letter. A None is not an answer, so it is left out here; the caller reports those separately.
    """
    # Only real letters count. A None reply says nothing about the key, so it cannot cause a flag.
    clear_letters = [letter for letter in letters if letter is not None]
    reasons = []
    # Any clear letter that is not the key means the screen thinks the key is wrong.
    if any(letter != key for letter in clear_letters):
        reasons.append(REASON_DIFFERS)
    # Two different letters from the screen mean it is unsure, even if one of them matches the key.
    if len(set(clear_letters)) > 1:
        reasons.append(REASON_DISAGREE)
    return reasons


def letters_for_question(models_results):
    """Return every screen letter for one question, pooled across all models, in model order.

    models_results maps a model name to its list of samples. Each sample is a dict with a "letter" key,
    which is None when that call failed or gave no clear answer.
    """
    letters = []
    for samples in models_results.values():
        for sample in samples:
            letters.append(sample["letter"])
    return letters


def flagged_questions(questions, screen):
    """Return {question id: details} for each flagged question, and nothing for the others.

    The details hold the key and the screen letters, because a person needs both to decide.
    Only flagged questions appear here, so no other question's key is ever passed on.
    """
    flagged = {}
    for question in questions:
        question_id = question["id"]
        letters = letters_for_question(screen.get(question_id, {}))
        reasons = flag_reasons(question["correct"], letters)
        if reasons:
            flagged[question_id] = {"key": question["correct"], "screen": letters, "reasons": reasons}
    return flagged


def summarize_checks(checks, flagged_ids):
    """Count verified and unchecked entries in key_checks, and the flagged ids, for the summary line.

    A question can be both unchecked and flagged. The counts are reported separately, so they can overlap.
    """
    verified = sum(1 for entry in checks if entry["status"] == "verified")
    unchecked = sum(1 for entry in checks if entry["status"] == "unchecked")
    return {"verified": verified, "unchecked": unchecked, "flagged": len(flagged_ids)}


def run_one(ask, model, question):
    """Ask one model one question, blind, and return one sample: its letter and its reply.

    A failed call does not stop the screen. Its sample records only the error class name, because an
    error message could hold text from the request.
    """
    messages = [{"role": "user", "content": core.format_question(blind_view(question))}]
    try:
        reply = ask(model, messages)
    except Exception as error:
        return {"letter": None, "error": error.__class__.__name__}
    # core.parse_answer reads the letter after "Answer:", the same way the study does.
    return {"letter": core.parse_answer(reply), "reply": reply}


def run_screen(questions, models, samples, ask):
    """Return {question id: {model: [sample, ...]}} with one sample per call.

    The calls run side by side, but pool.map keeps the results in the order the jobs were listed,
    so the samples always line up with the question and model they belong to.
    """
    jobs = [(question, model) for question in questions for model in models for _ in range(samples)]
    with ThreadPoolExecutor(max_workers=WORKER_COUNT) as pool:
        # Each job is a (question, model) pair, so the lambda takes the pair apart for run_one.
        outcomes = list(pool.map(lambda job: run_one(ask, job[1], job[0]), jobs))
    results = {question["id"]: {model: [] for model in models} for question in questions}
    for (question, model), sample in zip(jobs, outcomes):
        results[question["id"]][model].append(sample)
    return results


def make_ask(config):
    """Return an ask(model, messages) function that calls the Nebius endpoint with the study's settings.

    The key is read with keys.get_key, the same way refresh_catalog.py reads it, so it is never printed.
    Retries are off, because a failed call is recorded as its own result instead of being retried here.
    """
    platform = providers.get_platform(SCREEN_PLATFORM_ID)
    client = openai.OpenAI(
        base_url=platform.base_url,
        api_key=keys.get_key(platform),
        timeout=config["request_timeout_seconds"],
        max_retries=0,
    )

    def ask(model, messages):
        """Send one blind request and return the reply text, or "" when the reply has no content."""
        response = client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=config["temperature"],
            max_tokens=config["max_tokens"],
        )
        return response.choices[0].message.content or ""

    return ask


def save_results(screen, path):
    """Write the screen answers to a JSON file. The file holds letters and replies, never a key."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"models": list(SCREEN_MODELS), "samples_per_model": SAMPLES_PER_MODEL, "answers": screen}
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def load_results(path):
    """Return the saved screen answers, or {} when no screen has been run yet."""
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))["answers"]


def count_missing_letters(screen):
    """Return how many screen samples gave no clear letter, so a person can see gaps in the screen."""
    return sum(
        1
        for models_results in screen.values()
        for samples in models_results.values()
        for sample in samples
        if sample["letter"] is None
    )


def print_flags(flagged):
    """Print one line for each flagged question: its id, its key, the screen letters and the reasons."""
    for question_id, details in flagged.items():
        letters = " ".join(letter or "-" for letter in details["screen"])
        print(f"{question_id}  key {details['key']}  screen {letters}  ({'; '.join(details['reasons'])})")


def print_summary(summary, missing):
    """Print the counts of verified, unchecked and flagged questions, and any samples with no clear letter."""
    print(
        f"Verified {summary['verified']}, unchecked {summary['unchecked']}, flagged {summary['flagged']}. "
        f"Screen samples with no clear letter: {missing}."
    )


def load_key_checks(path):
    """Return the list of key-check entries from key_checks.json."""
    return json.loads(path.read_text(encoding="utf-8"))


def parse_args(argv):
    """Read the command line. The screen only spends money when --run is given."""
    parser = argparse.ArgumentParser(description="Blind AI screen of the answer keys. Prints the flags and a summary.")
    parser.add_argument("--run", action="store_true", help="ask the screen models now and save the answers")
    return parser.parse_args(argv)


def main(argv=None):
    """Run the screen if asked, then print the flagged questions and the summary."""
    args = parse_args(argv)
    questions = core.load_questions(QUESTIONS_PATH)
    if args.run:
        screen = run_screen(questions, SCREEN_MODELS, SAMPLES_PER_MODEL, make_ask(core.load_config()))
        save_results(screen, RESULTS_PATH)
        print(f"Saved screen answers to {RESULTS_PATH}")
    else:
        screen = load_results(RESULTS_PATH)
        if not screen:
            print("No screen results yet. Run with --run to ask the screen models.")
    flagged = flagged_questions(questions, screen)
    print_flags(flagged)
    summary = summarize_checks(load_key_checks(KEY_CHECKS_PATH), list(flagged))
    print_summary(summary, count_missing_letters(screen))
    return 0


if __name__ == "__main__":
    sys.exit(main())
