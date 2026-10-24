"""Run the sycophancy experiment and save every reply to the cache.

For each model, question and repeat, the runner asks the question, then runs the flows
from flows.py that apply. Every reply is saved, so a rerun only makes the calls that are missing.
"""

# Lets "int | None" annotations load on Python 3.9, which the system python3 is.
from __future__ import annotations

import argparse
import asyncio
import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

import core
import flows
import model_client
import shuffle
from stub_model import StubModel

# Longest wait between retries; backoff_seconds() doubles the wait each attempt up to this cap.
MAX_BACKOFF_SECONDS = 60
# Both exit codes are 2 on purpose: the shell can tell them from 1 (some call failed) and 0 (clean).
EXIT_INCOMPLETE = 2  # the call limit was reached
EXIT_BAD_OPTION = 2  # a bad option, bad custom model settings, or a missing key
FAMILY_NAMES = ", ".join(sorted(flows.ALL_FAMILIES))
# These families only run after a right first answer, so a wrong one skips them.
BASELINE_DEPENDENT_FAMILIES = frozenset({flows.GAUNTLET, flows.FINGERPRINT, flows.TWINS, flows.DOSE})


class BudgetExhausted(Exception):
    """Raised when the run has used up its call limit. It stops the run quietly, without a failure."""


class CallBudget:
    """Counts every attempt that reaches the API, retries included, against an optional limit."""

    def __init__(self, limit: int | None) -> None:
        self.limit = limit
        self.attempts = 0

    def spend(self) -> None:
        """Record one attempt, or raise BudgetExhausted if the limit has been reached."""
        if self.limit is not None and self.attempts >= self.limit:
            raise BudgetExhausted()
        self.attempts += 1


class ChatClient(Protocol):
    """The methods the runner uses. ModelRouter and StubModel both provide them."""

    async def complete(
        self, model: str, messages: list[dict[str, str]], temperature: float, max_tokens: int
    ) -> str: ...

    async def close(self) -> None: ...


@dataclass
class RunSettings:
    """Settings that are the same for every unit in one run."""

    condition: str
    system_prompt: str | None
    config: dict[str, Any]
    ladder: dict[str, Any]
    probe_spec: dict[str, Any]
    families: frozenset[str]
    is_retryable: Callable[[Exception], bool]
    describe_error: Callable[[Exception], str]
    wait: Callable[[float], Awaitable[None]] = asyncio.sleep
    suite: core.Suite | None = None  # names the saved records; None means the default suite
    labels: dict[str, str] = field(default_factory=dict)  # saved name per model; see model_client.record_labels
    # Per question id: the order seed and the 1-based position. Empty on a run without --shuffle-questions.
    question_orders: dict[str, dict[str, int]] = field(default_factory=dict)


@dataclass
class Unit:
    """One model answering one question on one repeat. 'label' is the name its replies are saved under."""

    model: str
    question: dict[str, Any]
    repeat: int
    label: str = ""

    def __post_init__(self) -> None:
        """Save under the model name unless a label was given."""
        if not self.label:
            self.label = self.model


@dataclass
class Failure:
    """A call that still failed after all of its attempts."""

    model: str
    question_id: str
    repeat: int
    step: str
    message: str


@dataclass
class RunStats:
    """The counts shown in the summary."""

    calls_made: int = 0
    replies_reused: int = 0
    chains_skipped: int = 0
    failures: list[Failure] = field(default_factory=list)
    stopped_by_budget: bool = False


@dataclass
class RunContext:
    """Everything the units share during one run."""

    client: ChatClient
    cache: dict[tuple[Any, ...], dict[str, Any]]
    cache_path: Path
    semaphore: asyncio.Semaphore
    settings: RunSettings
    stats: RunStats
    budget: CallBudget


def backoff_seconds(attempt: int) -> int:
    """Return how long to wait after a failed attempt. Attempts are counted from 0: 1, 2, 4, ... up to 60."""
    return min(2**attempt, MAX_BACKOFF_SECONDS)


def make_units(
    models: list[str], questions: list[dict[str, Any]], repeats: int, labels: dict[str, str] | None = None
) -> list[Unit]:
    """Return every model, question and repeat combination. Repeats are numbered from 1.

    'labels' maps a model name to the name its replies are saved under. A model without one keeps its own name.
    """
    names = labels or {}
    return [
        Unit(model=model, question=question, repeat=repeat, label=names.get(model, model))
        for model in models
        for question in questions
        for repeat in range(1, repeats + 1)
    ]


def plan_question_order(
    questions: list[dict[str, Any]], limit: int | None, seed: int | None
) -> tuple[list[dict[str, Any]], dict[str, dict[str, int]]]:
    """Return the questions to run, in run order, and the order fields to save with each one.

    The shuffle comes before the limit, so a limited shuffled run is a seeded random sample of the
    set, not the first N questions of the file. Each question gets its 1-based position in the shuffled
    order and the seed. Without a seed the file's order is kept and no question gets order fields, so
    a default run saves the same records as before.
    """
    if seed is None:
        ordered = questions
        orders: dict[str, dict[str, int]] = {}
    else:
        ordered = shuffle.shuffled_questions(questions, seed)
        orders = {
            question["id"]: {"question_order_seed": seed, "question_position": position}
            for position, question in enumerate(ordered, start=1)
        }
    if limit is not None:
        ordered = ordered[:limit]
    return ordered, orders


def step_key(condition: str, unit: Unit, step: str) -> tuple[Any, ...]:
    """Return the cache key of one step of one unit, built from the saved model name."""
    return core.make_key(condition, unit.label, unit.question["id"], unit.repeat, step)


async def run_unit(ctx: RunContext, unit: Unit) -> None:
    """Ask the question, then run the flows the settings ask for. A failed call ends the unit early."""
    settings = ctx.settings
    first_messages = flows.build_first_messages(unit.question, settings.system_prompt)
    reply = await get_reply(ctx, unit, first_messages, core.BASELINE_STEP)
    if reply is None:
        return
    # Only counted here for the summary; this check does not stop the flows below from being called.
    if not core.is_correct(reply, unit.question) and not settings.families.isdisjoint(BASELINE_DEPENDENT_FAMILIES):
        ctx.stats.chains_skipped += 1

    async def ask(step: str, messages: list[dict[str, str]]) -> str | None:
        """Return the reply for one step, or None if the call failed for good."""
        return await get_reply(ctx, unit, messages, step)

    await flows.run_flows(
        unit.question,
        settings.system_prompt,
        reply,
        ask,
        settings.families,
        settings.ladder,
        settings.probe_spec,
        settings.config,
    )


async def get_reply(ctx: RunContext, unit: Unit, messages: list[dict[str, str]], step: str) -> str | None:
    """Return the saved reply for this step, or call the model and save the new reply.

    Returns None if the call failed for good. The failure is then recorded in the stats.
    """
    # The key uses the saved label, so a rerun finds replies saved earlier under the same label.
    key = step_key(ctx.settings.condition, unit, step)
    saved = ctx.cache.get(key)
    if saved is not None:
        ctx.stats.replies_reused += 1
        return saved["reply"]
    reply = await call_with_retries(ctx, unit, messages, step)
    if reply is None:
        return None
    record = core.make_record(
        ctx.settings.condition,
        unit.label,
        unit.question,
        unit.repeat,
        step,
        messages,
        reply,
        ctx.settings.config["temperature"],
        suite=ctx.settings.suite,
        question_order=ctx.settings.question_orders.get(unit.question["id"]),
    )
    # Write to disk first and update the in-memory cache second, so a crash keeps every reply already paid for.
    core.append_record(record, ctx.cache_path)
    ctx.cache[key] = record
    ctx.stats.calls_made += 1
    return reply


async def call_with_retries(ctx: RunContext, unit: Unit, messages: list[dict[str, str]], step: str) -> str | None:
    """Call the model, retrying errors that is_retryable accepts. Returns None after a final failure."""
    attempt = 0
    while True:
        try:
            return await call_model(ctx, unit.model, messages)
        except BudgetExhausted:
            ctx.stats.stopped_by_budget = True
            return None
        except Exception as error:
            # The client can raise many kinds of error, so each one is checked by is_retryable.
            if attempt >= ctx.settings.config["max_retries"] or not ctx.settings.is_retryable(error):
                record_failure(ctx, unit, step, ctx.settings.describe_error(error))
                return None
            await ctx.settings.wait(backoff_seconds(attempt))
            attempt += 1


async def call_model(ctx: RunContext, model: str, messages: list[dict[str, str]]) -> str:
    """Make one API call. The semaphore allows only 'concurrency' calls to run at the same time.

    The budget is checked and spent before the call starts, so no more calls than the limit are ever made.
    """
    async with ctx.semaphore:
        ctx.budget.spend()
        return await ctx.client.complete(
            model=model,
            messages=messages,
            temperature=ctx.settings.config["temperature"],
            max_tokens=ctx.settings.config["max_tokens"],
        )


def record_failure(ctx: RunContext, unit: Unit, step: str, message: str) -> None:
    """Keep a record of a failed call and print one line about it to stderr. The key is never printed."""
    question_id = unit.question["id"]
    ctx.stats.failures.append(
        Failure(model=unit.model, question_id=question_id, repeat=unit.repeat, step=step, message=message)
    )
    print(f"Failed: {unit.model} {question_id} repeat {unit.repeat} {step}: {message}", file=sys.stderr)


async def run_all(
    client: ChatClient,
    cache: dict[tuple[Any, ...], dict[str, Any]],
    cache_path: Path,
    questions: list[dict[str, Any]],
    models: list[str],
    repeats: int,
    settings: RunSettings,
    max_calls: int | None = None,
) -> RunStats:
    """Run every unit, with at most config["concurrency"] API calls at once, then close the client.

    Saved replies are read from 'cache', and new ones are appended to 'cache_path'.
    With 'max_calls', the run makes no more API attempts than that and then stops.
    """
    ctx = RunContext(
        client=client,
        cache=cache,
        cache_path=cache_path,
        semaphore=asyncio.Semaphore(settings.config["concurrency"]),
        settings=settings,
        stats=RunStats(),
        budget=CallBudget(max_calls),
    )
    units = make_units(models, questions, repeats, settings.labels)
    # All units start at once; the semaphore in call_model is what limits how many API calls run together.
    tasks = [asyncio.create_task(run_unit(ctx, unit)) for unit in units]
    try:
        # Units finish in any order, so this counts completions, not unit numbers.
        for finished_count, finished in enumerate(asyncio.as_completed(tasks), start=1):
            await finished
            print(f"Finished {finished_count} of {len(units)} units")
    finally:
        # Close the client even if a unit raised, so connections are not left open.
        await client.close()
    return ctx.stats


@dataclass
class CallPlan:
    """For one model: replies already saved, and the most new calls the run could still make."""

    saved: int = 0
    at_most_new: int = 0


def saved_baseline_correct(cache: dict[tuple[Any, ...], dict[str, Any]], condition: str, unit: Unit) -> bool | None:
    """Return whether the saved first answer of this unit is right, or None if it is not saved yet."""
    saved = cache.get(step_key(condition, unit, core.BASELINE_STEP))
    if saved is None:
        return None
    return core.is_correct(saved["reply"], unit.question)


def confession_can_follow(
    cache: dict[tuple[Any, ...], dict[str, Any]], condition: str, unit: Unit, ladder: dict[str, Any]
) -> bool:
    """Return False when every pressure level is saved and none gave a wrong letter, so no confession will be sent."""
    letters = []
    # If any pressure level is not saved yet, we cannot rule the confession out, so assume it may follow.
    for step in core.pushback_steps(len(ladder["levels"])):
        saved = cache.get(step_key(condition, unit, step))
        if saved is None:
            return True
        letters.append(core.parse_answer(saved["reply"]))
    return flows.model_flipped(letters, unit.question)


def plan_model_calls(
    model: str,
    questions: list[dict[str, Any]],
    repeats: int,
    cache: dict[tuple[Any, ...], dict[str, Any]],
    condition: str,
    families: frozenset[str],
    ladder: dict[str, Any],
    probe_spec: dict[str, Any],
    labels: dict[str, str] | None = None,
) -> CallPlan:
    """Count the calls a run would still need for one model. Nothing is called and nothing is saved.

    Until a unit's first answer is saved, every step that could follow it is counted, so the number
    of new calls is an upper bound.
    """
    plan = CallPlan()
    for unit in make_units([model], questions, repeats, labels):
        baseline_correct = saved_baseline_correct(cache, condition, unit)
        # baseline_correct is None until the first answer is saved; expected_steps then counts every possible step.
        steps = flows.expected_steps(unit.question, families, ladder, probe_spec, baseline_correct)
        if not confession_can_follow(cache, condition, unit, ladder):
            steps = [step for step in steps if step != core.CONFESSION_STEP]
        for step in steps:
            if step_key(condition, unit, step) in cache:
                plan.saved += 1
            else:
                plan.at_most_new += 1
    return plan


def family_text(families: frozenset[str]) -> str:
    """Return the family names in alphabetical order, joined by commas."""
    return ", ".join(sorted(families))


def print_pushback_slots(axis_order: list[str]) -> None:
    """Print the axis that sits in each pushback slot, so a shuffled order can be read before a run."""
    print("Pushback slots in shuffled order:")
    for slot, axis in enumerate(axis_order, start=1):
        print(f"  level {slot}: {axis}")


def print_dry_run(
    models: list[str],
    questions: list[dict[str, Any]],
    repeats: int,
    condition: str,
    cache: dict[tuple[Any, ...], dict[str, Any]],
    families: frozenset[str],
    ladder: dict[str, Any],
    probe_spec: dict[str, Any],
    labels: dict[str, str] | None = None,
    axis_order: list[str] | None = None,
) -> None:
    """Print, per model, how many replies are saved and the most new calls a real run would make.

    With 'axis_order' (a shuffled ladder), the axis of each pushback slot is printed too.
    """
    total_new = 0
    print("Dry run: no calls will be made.")
    print(f"Ladder: {ladder['name']}")
    print(f"Families: {family_text(families)}")
    if axis_order is not None:
        print_pushback_slots(axis_order)
    for model in models:
        plan = plan_model_calls(model, questions, repeats, cache, condition, families, ladder, probe_spec, labels)
        total_new += plan.at_most_new
        print(f"  {model}: {plan.saved} replies saved, at most {plan.at_most_new} new calls")
    print(f"Total: at most {total_new} new calls.")
    print("The number is exact once every first answer is saved. Before that it is an upper bound.")


def parse_families(text: str) -> frozenset[str]:
    """Turn 'gauntlet,twins' into a set of family names. 'all' stands for every family."""
    if text.strip() == "all":
        return flows.ALL_FAMILIES
    names = [part.strip() for part in text.split(",")]
    for name in names:
        if name not in flows.ALL_FAMILIES:
            raise argparse.ArgumentTypeError(f"Unknown family '{name}'. Allowed names: {FAMILY_NAMES}, or all.")
    return frozenset(names)


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    """Read the command-line options. The repeats default comes from config.json."""
    config = core.load_config()
    parser = argparse.ArgumentParser(description="Run the sycophancy experiment. Saved replies are reused on rerun.")
    parser.add_argument(
        "--condition",
        choices=core.CONDITIONS,
        default=core.NO_SYSTEM_PROMPT,
        help="which system prompt to use (default: %(default)s)",
    )
    parser.add_argument(
        "--models",
        nargs="+",
        default=None,
        help="full model names; a custom model from config.json runs only when named here "
        "(default: the built-in models, or 'stub' with --stub)",
    )
    parser.add_argument(
        "--limit", type=int, default=None, help="run only the first N questions (default: all)"
    )
    parser.add_argument(
        "--repeats",
        type=int,
        default=config["repeats"],
        help="how many times each question is run for each model (default: %(default)s)",
    )
    parser.add_argument(
        "--stub",
        action="store_true",
        help="use the offline stub model instead of the real API (saves to its own cache)",
    )
    parser.add_argument(
        "--max-calls",
        type=int,
        default=None,
        help="stop after this many API attempts, retries included, so a run cannot overspend",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="count the saved replies and the calls a run would still need, without calling the API",
    )
    parser.add_argument(
        "--probes",
        type=parse_families,
        default="all",
        help=f"which families to run, comma-separated, or all: {FAMILY_NAMES} (default: all)",
    )
    parser.add_argument(
        "--ladder",
        choices=tuple(core.LADDER_FILES),
        default=None,
        help="pushback set (default: the ladder in config.json, gauntlet_v3)",
    )
    parser.add_argument(
        "--questions",
        choices=tuple(core.QUESTION_FILES),
        default=None,
        help="question set (default: the questions in config.json, easy)",
    )
    parser.add_argument(
        "--shuffle-questions",
        type=int,
        default=None,
        help="run the questions in this seeded random order; applied before --limit, so a limited run is a random "
        "sample (default: the file's order)",
    )
    parser.add_argument(
        "--shuffle-pushbacks",
        type=int,
        default=None,
        help="put the movable pushbacks in this seeded random order; makes a new experiment code "
        "(default: the ladder's order)",
    )
    parser.add_argument(
        "--cache",
        type=Path,
        default=None,
        help="file to read saved replies from and append new ones to "
        "(default: results/cache.jsonl; required with --base-url)",
    )
    parser.add_argument(
        "--base-url",
        default=None,
        help="test use only: send every request to this 127.0.0.1 or localhost address instead of the API "
        "(needs --cache)",
    )
    args = parser.parse_args(argv)
    # Checks argparse cannot express itself; parser.error() prints the message and exits with code 2.
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be at least 1")
    if args.repeats < 1:
        parser.error("--repeats must be at least 1")
    if args.max_calls is not None and args.max_calls < 1:
        parser.error("--max-calls must be at least 1")
    if args.base_url is not None and not model_client.is_local_base_url(args.base_url):
        parser.error("--base-url is accepted only for 127.0.0.1 or localhost (test use).")
    if args.base_url is not None and args.cache is None:
        parser.error("--base-url needs --cache, so test replies never go into the real cache.")
    return args


def choose_models(args: argparse.Namespace, config: dict[str, Any]) -> list[str]:
    """Pick the models: the ones named on the command line, else 'stub' with --stub, else the built-in models.

    Custom models from config.json run only when they are named with --models.
    """
    if args.models is not None:
        return args.models
    if args.stub:
        return ["stub"]
    return list(config["models"])


def make_client(
    args: argparse.Namespace,
    config: dict[str, Any],
    models: list[str],
    custom_routes: list[model_client.ModelRoute],
    questions: list[dict[str, Any]],
) -> ChatClient:
    """Return the client for a real run: the offline stub, or a router with one endpoint and key per model.

    Raises RuntimeError when a key is missing. The message names the variable, never its value.
    """
    if args.stub:
        return StubModel(questions)
    routes = model_client.attach_keys(model_client.build_routes(models, config, custom_routes, args.base_url))
    return model_client.ModelRouter(routes, config["request_timeout_seconds"])


def print_plan(
    ladder_name: str,
    experiment: str,
    condition: str,
    models: list[str],
    families: frozenset[str],
    question_count: int,
    repeats: int,
    cache_path: Path,
) -> None:
    """Print what this run will do before any call is made."""
    print(f"Ladder: {ladder_name}")
    print(f"Experiment version: {experiment}")
    print(f"Condition: {condition}")
    print(f"Models: {', '.join(models)}")
    print(f"Families: {family_text(families)}")
    print(f"Questions: {question_count}")
    print(f"Repeats: {repeats}")
    print(f"Cache: {cache_path}")


def print_summary(stats: RunStats) -> None:
    """Print the counts at the end of the run."""
    print("Summary")
    print(f"  Calls made: {stats.calls_made}")
    print(f"  Replies reused from cache: {stats.replies_reused}")
    print(f"  Chains skipped (first answer wrong): {stats.chains_skipped}")
    print(f"  Failures: {len(stats.failures)}")


def main(argv: list[str] | None = None) -> int:
    """Run the experiment from the command line.

    Returns 0, 1 if any call failed, or 2 for a bad option, a missing key, or a call limit that stopped the run.
    """
    config = core.load_config()
    args = parse_args(argv)
    try:
        custom_routes = model_client.load_custom_models(config)
    except ValueError as error:
        print(error, file=sys.stderr)
        return EXIT_BAD_OPTION
    suite = core.load_suite(ladder=args.ladder, questions=args.questions, pushback_seed=args.shuffle_pushbacks)
    questions, question_orders = plan_question_order(suite.questions, args.limit, args.shuffle_questions)
    models = choose_models(args, config)
    labels = model_client.record_labels(models, config, custom_routes, args.base_url)
    # An explicit --cache wins; otherwise stub runs use their own cache file so fake replies never mix with real ones.
    cache_path = args.cache or (core.STUB_CACHE_PATH if args.stub else core.CACHE_PATH)
    cache = core.load_cache(cache_path, experiment=suite.experiment)

    if args.dry_run:
        print_dry_run(
            models, questions, args.repeats, args.condition, cache, args.probes, suite.ladder, suite.probe_spec,
            labels, suite.pushback_order,
        )
        return 0

    try:
        client = make_client(args, config, models, custom_routes, questions)
    except RuntimeError as error:
        print(error, file=sys.stderr)
        return EXIT_BAD_OPTION
    settings = RunSettings(
        condition=args.condition,
        system_prompt=core.system_prompt_for(args.condition, config),
        config=config,
        ladder=suite.ladder,
        probe_spec=suite.probe_spec,
        families=args.probes,
        is_retryable=model_client.is_retryable,
        describe_error=model_client.describe_error,
        suite=suite,
        labels=labels,
        question_orders=question_orders,
    )

    print_plan(
        suite.ladder["name"], suite.experiment, args.condition, models, args.probes, len(questions), args.repeats,
        cache_path,
    )
    stats = asyncio.run(
        run_all(client, cache, cache_path, questions, models, args.repeats, settings, args.max_calls)
    )
    print_summary(stats)
    if stats.stopped_by_budget:
        print(f"Stopped at the --max-calls limit of {args.max_calls}. Run the same command again to continue.")
        return EXIT_INCOMPLETE
    return 1 if stats.failures else 0


if __name__ == "__main__":
    sys.exit(main())
