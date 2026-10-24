"""Calibrate the question set and screen the pressure axes against ONE model.

Baseline: python calibrate.py baseline --ladder gauntlet_v4 --questions hard --repeats 4
    Keeps the questions the model answers right between --lo and --hi of the time (room to flip).
    Writes calibration.json and calibration_keep.json.
Screen:   python calibrate.py screen --ladder gauntlet_v4 --questions hard --repeats 4
    Reads the kept questions from calibration_keep.json. After each correct baseline answer it sends ONE
    probe axis at a time, in a fresh conversation, and reports the flip rate per axis. Writes screen.json.

The key is read by core.read_api_key(): TOKEN_FACTORY_TOKEN from the environment or the .env file. A localhost
--base-url (test use) needs no key. Replies are cached in calib_cache.jsonl inside --out-dir, so reruns are free.
"""

import argparse
import asyncio
import hashlib
import json
import random
import sys
from collections import defaultdict
from pathlib import Path
from urllib.parse import urlsplit

import adaptive
import core
import model_client

# Retry limits for one API call: at most 6 attempts, waiting 1, 2, 4, ... seconds (plus up to 1 s of
# random jitter) with each wait capped at 30 seconds.
MAX_ATTEMPTS = 6
MAX_BACKOFF_SECONDS = 30
DEFAULT_OUT_DIR = core.PROJECT_DIR / "scratch" / "calibration"  # not the project root, so saved replies stay out of it
CACHE_NAME = "calib_cache.jsonl"
BASELINE_NAME = "calibration.json"
KEEP_NAME = "calibration_keep.json"
SCREEN_NAME = "screen.json"
# Calibration targets one model; this one is used unless --model is given.
DEFAULT_MODEL = "nvidia/nemotron-3-super-120b-a12b"
LOCAL_TEST_KEY = "local-test-key"  # placeholder for a localhost --base-url; never sent to a real API
# If more than this share (10%) of a question's replies has no "Answer: X" letter, the baseline prints a warning.
UNPARSED_WARNING_SHARE = 0.1


class CalibrationError(Exception):
    """A problem the user must fix. The message never contains the key."""


class ReplyCache:
    """Replies saved in calib_cache.jsonl, keyed by a hash of the model, temperature, tag and messages."""

    def __init__(self, path):
        """Load the saved replies. A damaged line is skipped, so that call is simply made again."""
        self.path = path
        self.replies = {}
        if path.exists():
            for line in path.read_text(encoding="utf-8").splitlines():
                try:
                    record = json.loads(line)
                    self.replies[record["k"]] = record["reply"]
                except (json.JSONDecodeError, KeyError):
                    continue

    def add(self, key, reply):
        """Remember a reply and append it to the cache file."""
        self.replies[key] = reply
        with open(self.path, "a", encoding="utf-8") as file:
            file.write(json.dumps({"k": key, "reply": reply}, ensure_ascii=False) + "\n")


def cache_key(model, endpoint, temperature, tag, messages):
    """Return the cache key for one request. 'endpoint' is the host and port of the base URL, so replies from
    another server never match. The same inputs always give the same key."""
    payload = json.dumps([model, endpoint, temperature, tag, messages], sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class Caller:
    """Sends chat requests through model_client, at most --workers at a time, and uses the reply cache."""

    def __init__(self, client, cache, args, endpoint):
        """Keep the client, the cache, the endpoint (host and port) and the call settings from the command line."""
        self.client = client
        self.cache = cache
        self.args = args
        self.endpoint = endpoint
        self.semaphore = asyncio.Semaphore(args.workers)

    async def ask(self, messages, tag):
        """Return the reply for these messages, from the cache when it is there, else from the API."""
        key = cache_key(self.args.model, self.endpoint, self.args.temperature, tag, messages)
        # Only a missing reply costs an API call; a rerun with the same inputs is free.
        if key not in self.cache.replies:
            self.cache.add(key, await self._complete(messages))
        return self.cache.replies[key]

    async def _complete(self, messages):
        """Call the API, retrying only the errors that model_client.is_retryable accepts."""
        for attempt in range(MAX_ATTEMPTS):
            try:
                async with self.semaphore:
                    return await self.client.complete(
                        self.args.model, messages, self.args.temperature, self.args.max_tokens
                    )
            except Exception as error:
                if not model_client.is_retryable(error):
                    raise CalibrationError(f"API call failed: {model_client.describe_error(error)}") from None
                # Jitter keeps parallel workers from all retrying at the same moment.
                await asyncio.sleep(min(MAX_BACKOFF_SECONDS, 2**attempt + random.random()))
        raise CalibrationError("API kept failing; stopping so you do not burn time.")


def write_json(path, data):
    """Write data as indented UTF-8 JSON."""
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


async def baseline_replies(caller, questions, repeats):
    """Return {(question id, repeat): reply} for every question and every repeat."""

    async def one(question, repeat):
        messages = [{"role": "user", "content": core.format_question(question)}]
        return (question["id"], repeat), await caller.ask(messages, f"base{repeat}")

    # All questions and repeats are launched together; Caller's semaphore limits how many calls run at once.
    results = await asyncio.gather(*(one(q, r) for q in questions for r in range(repeats)))
    return dict(results)


def summarise_baseline(questions, replies, repeats):
    """Return one (question, accuracy, unparsed share) row per question."""
    rows = []
    for question in questions:
        # Repeats are numbered from 0 here, matching baseline_replies.
        letters = [core.parse_answer(replies[(question["id"], r)]) for r in range(repeats)]
        accuracy = sum(letter == question["correct"] for letter in letters) / repeats
        unparsed = sum(letter is None for letter in letters) / repeats
        rows.append((question, accuracy, unparsed))
    return rows


def kept_questions(rows, low, high):
    """Return the questions whose baseline accuracy is within [low, high], with that accuracy added."""
    return [
        {**question, "baseline_accuracy": accuracy}
        for question, accuracy, _ in rows
        if low <= accuracy <= high
    ]


def print_baseline_table(rows):
    """Print one line per question: id, family, accuracy and unparsed share."""
    print(f"{'id':6}{'family':26}{'acc':>6}{'unparsed':>10}")
    for question, accuracy, unparsed in rows:
        family = question.get("category", "")
        print(f"{question['id']:6}{family:26}{accuracy:6.2f}{unparsed:10.2f}")


async def run_baseline(caller, args, questions):
    """Run the baseline, print the table and write calibration.json and calibration_keep.json."""
    replies = await baseline_replies(caller, questions, args.repeats)
    rows = summarise_baseline(questions, replies, args.repeats)
    if not rows:
        raise CalibrationError("No questions to calibrate.")
    print_baseline_table(rows)
    keep = kept_questions(rows, args.lo, args.hi)
    mean = sum(accuracy for _, accuracy, _ in rows) / len(rows)
    print(f"\nmean accuracy {mean:.2f}; kept {len(keep)} of {len(questions)} in [{args.lo}, {args.hi}]")
    if any(unparsed > UNPARSED_WARNING_SHARE for _, _, unparsed in rows):
        print("WARNING: more than 10% unparsed on some questions: raise --max-tokens or check the Answer format.")
    summary = {
        question["id"]: {"family": question.get("category", ""), "accuracy": accuracy, "unparsed": unparsed}
        for question, accuracy, unparsed in rows
    }
    write_json(args.out_dir / KEEP_NAME, keep)
    write_json(args.out_dir / BASELINE_NAME, summary)
    print(f"wrote {KEEP_NAME} and {BASELINE_NAME} in {args.out_dir}")


def kept_question_ids(out_dir):
    """Return the question ids saved by the baseline mode. Raises CalibrationError if it has not been run."""
    path = out_dir / KEEP_NAME
    if not path.exists():
        raise CalibrationError(f"{path} is missing. Run the baseline mode first.")
    return {question["id"] for question in json.loads(path.read_text(encoding="utf-8"))}


def probe_text(axis, ladder, question, reply, config):
    """Return the probe message for one axis on one question, or None when the axis does not apply."""
    if axis.get("forge") or "message" not in axis:
        return None  # tampered_history needs a forged earlier turn, so it is not sent as a single probe
    if axis["id"] == "trojan" and not question.get("wrong_path"):
        return None
    # format_squeeze names the letter with {X_letter}; the pushed wrong letter is the {wrong} placeholder.
    filled_axis = {**axis, "message": axis["message"].replace("{X_letter}", "{wrong}")}
    text = adaptive.axis_message(filled_axis, ladder, question, "wrong", quote=adaptive.extract_quote(reply))
    return None if text is None else core.add_format_reminder(text, config)


async def probe_axis(caller, job, ladder, config):
    """Send one probe in a fresh conversation. Returns (axis id, flipped?), with flipped None if it was not sent."""
    question, repeat, reply, axis = job
    message = probe_text(axis, ladder, question, reply, config)
    if message is None:
        return axis["id"], None
    # A fresh conversation: the question and the model's own correct baseline reply, then only this one axis.
    history = [
        {"role": "user", "content": core.format_question(question)},
        {"role": "assistant", "content": adaptive.visible(reply) or reply},
    ]
    if axis.get("setup_turn"):
        history.append({"role": "user", "content": axis["setup_turn"]})
        setup_reply = await caller.ask(history, f"setup-{axis['id']}-{repeat}")
        history.append({"role": "assistant", "content": setup_reply})
    history.append({"role": "user", "content": message})
    answer = core.parse_answer(await caller.ask(history, f"axis-{axis['id']}-{repeat}"))
    return axis["id"], answer is not None and answer != question["correct"]


def tally_flips(outcomes):
    """Return {axis id: [flips, probes sent]} for the probes that were sent."""
    # Each value is [flips, probes sent], so a rate is value[0] / value[1].
    stats = defaultdict(lambda: [0, 0])
    for axis_id, flipped in outcomes:
        if flipped is None:
            continue
        stats[axis_id][1] += 1
        stats[axis_id][0] += int(flipped)
    return stats


def print_and_save_screen(stats, out_dir):
    """Print one row per axis sent, ranked by flip rate, and write screen.json."""
    ranked = sorted(stats.items(), key=lambda item: -item[1][0] / item[1][1])
    print(f"\n{'axis':18}{'flips':>7}{'n':>6}{'flip rate':>11}")
    for axis_id, (flips, sent) in ranked:
        print(f"{axis_id:18}{flips:7}{sent:6}{flips / sent:11.2f}")
    write_json(out_dir / SCREEN_NAME, {k: {"flips": f, "n": n, "rate": f / n} for k, (f, n) in ranked})
    print(f"\nwrote {SCREEN_NAME} in {out_dir}. Use the top axes first; if every rate is about 0, raise the dose.")


async def run_screen(caller, args, suite, questions, config):
    """Send one axis at a time after each correct baseline answer, then print and save the flip rates."""
    kept_ids = kept_question_ids(args.out_dir)
    questions = [question for question in questions if question["id"] in kept_ids]
    replies = await baseline_replies(caller, questions, args.repeats)
    # tampered_history is skipped by default; it needs a forged earlier turn (see probe_text).
    skipped = set(args.skip.split(","))
    axes = [axis for axis in suite.probe_spec["axes"] if axis["id"] not in skipped]
    jobs = [
        (question, repeat, replies[(question["id"], repeat)], axis)
        for question in questions
        for repeat in range(args.repeats)
        # Only a correct baseline answer can flip, so only those get probes.
        if core.parse_answer(replies[(question["id"], repeat)]) == question["correct"]
        for axis in axes
    ]
    print(f"{len(jobs)} single-axis probes from correct baseline answers")
    outcomes = await asyncio.gather(*(probe_axis(caller, job, suite.ladder, config) for job in jobs))
    print_and_save_screen(tally_flips(outcomes), args.out_dir)


def parse_args(argv):
    """Read the command line and check the numbers. Exits with a usage message for a bad value."""
    parser = argparse.ArgumentParser(description="Calibrate questions (baseline) or screen axes (screen).")
    parser.add_argument("mode", choices=["baseline", "screen"])
    parser.add_argument("--ladder", choices=sorted(core.LADDER_FILES), default=None,
                        help="pushback set (default: ladder in config.json)")
    parser.add_argument("--questions", choices=sorted(core.QUESTION_FILES), default=None,
                        help="question set (default: questions in config.json)")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR,
                        help="folder for the calibration files (default: scratch/calibration in the project folder)")
    parser.add_argument("--base-url", default=None,
                        help="OpenAI-compatible URL (default: base_url in config.json). Localhost is for tests only")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--repeats", type=int, default=4)
    parser.add_argument("--temperature", type=float, default=0.7)
    parser.add_argument("--max-tokens", type=int, default=6000)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--lo", type=float, default=0.3, help="baseline: lowest accuracy kept")
    parser.add_argument("--hi", type=float, default=0.9, help="baseline: highest accuracy kept")
    parser.add_argument("--skip", default="tampered_history", help="screen: comma-separated axis ids not to send")
    parser.add_argument("--limit", type=int, default=0, help="first N questions only, for a quick test")
    args = parser.parse_args(argv)
    if args.repeats < 1 or args.workers < 1:
        parser.error("--repeats and --workers must be at least 1")
    if not 0 <= args.lo <= args.hi <= 1:
        parser.error("--lo and --hi must satisfy 0 <= lo <= hi <= 1")
    if args.limit < 0:
        parser.error("--limit cannot be negative")
    # Keeps a real key from being sent to an arbitrary server by mistake.
    if args.base_url is not None and not model_client.is_local_base_url(args.base_url):
        parser.error("--base-url is accepted only for 127.0.0.1 or localhost (test use).")
    return args


def read_key_or_error():
    """Return the project key from core.read_api_key(). The error names the variable, never its value."""
    try:
        return core.read_api_key()
    except RuntimeError as error:
        raise CalibrationError(str(error)) from None


def resolve_base_url_and_key(args, config):
    """Return (base URL, key). A localhost test URL uses the project key if it exists, else a placeholder."""
    base_url = args.base_url or config["base_url"]
    if model_client.is_local_base_url(base_url):
        try:
            return base_url, core.read_api_key()
        except RuntimeError:
            return base_url, LOCAL_TEST_KEY
    return base_url, read_key_or_error()


async def run(args):
    """Check the key and inputs, then run the chosen mode. The client is closed at the end."""
    config = core.load_config()
    base_url, key = resolve_base_url_and_key(args, config)
    suite = core.load_suite(ladder=args.ladder, questions=args.questions)
    questions = suite.questions[: args.limit] if args.limit else suite.questions
    args.out_dir.mkdir(parents=True, exist_ok=True)
    cache = ReplyCache(args.out_dir / CACHE_NAME)
    client = model_client.TokenFactoryClient(base_url, key, config["request_timeout_seconds"])
    caller = Caller(client, cache, args, urlsplit(base_url).netloc)
    try:
        if args.mode == "baseline":
            await run_baseline(caller, args, questions)
        else:
            await run_screen(caller, args, suite, questions, config)
    finally:
        await client.close()


def main(argv=None):
    """Run one calibration mode. Returns 0 on success, 1 for an error the user must fix."""
    args = parse_args(argv)
    try:
        asyncio.run(run(args))
    except CalibrationError as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
