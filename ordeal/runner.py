"""Run the sycophancy experiment and save every reply to the cache.

For each model, condition, question and repeat, the runner asks the question, then runs the flows
flows.py that apply. Every reply is saved, so a rerun only makes the calls that are missing.
One run can cover several conditions and models; their units share one queue, served round-robin.
"""

# Lets "int | None" annotations load on Python 3.9, which the system python3 is.
from __future__ import annotations

import argparse
import asyncio
import random
import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Protocol

from ordeal import core
from ordeal import flows
from ordeal import limiter
from ordeal import mix
from ordeal import model_client
from ordeal import store
from ordeal.stub_model import StubModel

# Longest wait between retries; backoff_seconds() doubles the wait each attempt up to this cap.
MAX_BACKOFF_SECONDS = 60
# After a rate limit (429), the wait grows by up to this fraction of itself. The random extra keeps calls that
# were all refused at the same moment from retrying at the same moment again.
RATE_LIMIT_JITTER_FRACTION = 0.25
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
    """The methods the runner uses. ModelRouter and StubModel both provide them.

    The runner asks for the detailed reply, so it gets the headers and usage the pacer learns from.
    """

    async def complete_detailed(
        self, model: str, messages: list[dict[str, str]], temperature: float, max_tokens: int
    ) -> model_client.Reply: ...

    async def close(self) -> None: ...


@dataclass
class PushbackPlan:
    """One pushback set's ladder and probe spec. A mixed run has one of these for each set."""

    ladder: dict[str, Any]
    probe_spec: dict[str, Any]


def ladder_and_probes_for(
    unit: "Unit", pushback_plans: dict[str, PushbackPlan] | None, ladder: dict[str, Any], probe_spec: dict[str, Any]
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return the ladder and probe spec this unit uses.

    A fixed run has no per-set plans, so every unit gets the one ladder and probe spec. A mixed run
    picks the plan of the unit's own pushback set, so easy and hard questions each get their own pushbacks.
    """
    if pushback_plans is None:
        return ladder, probe_spec
    plan = pushback_plans[unit.pushback_set]
    return plan.ladder, plan.probe_spec


@dataclass
class RunSettings:
    """Settings that are the same for every unit in one run."""

    condition: str
    system_prompt: str | None
    config: dict[str, Any]
    ladder: dict[str, Any] | None
    probe_spec: dict[str, Any] | None
    families: frozenset[str]
    is_retryable: Callable[[Exception], bool]
    describe_error: Callable[[Exception], str]
    wait: Callable[[float], Awaitable[None]] = asyncio.sleep
    suite: core.Suite | core.MixedSuite | None = None  # names the saved records; None means the default suite
    labels: dict[str, str] = field(default_factory=dict)  # saved name per model; see model_client.record_labels
    # For a mixed run only: one plan per pushback set, keyed by the set name. None for a fixed run.
    pushback_plans: dict[str, PushbackPlan] | None = None


@dataclass
class Unit:
    """One model answering one question on one repeat. 'label' is the name its replies are saved under.

    'pushback_set' names the ladder this question uses; it is empty for a fixed run. 'mix_fields' are
    extra fields saved with each reply of a mixed run (the seed, the position and the sets); empty otherwise.
    """

    model: str
    question: dict[str, Any]
    repeat: int
    label: str = ""
    pushback_set: str = ""
    mix_fields: dict[str, Any] = field(default_factory=dict)

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
class HealthCounts:
    """What one model's new calls looked like in this run. The health guard reads these to decide on a pause.

    'calls' counts every call that ended, whether it gave a reply or failed for good. 'graded_replies' counts
    the replies at graded steps (see is_graded_step), and 'unparsed_replies' the graded ones with no 'Answer: X'.
    """

    calls: int = 0
    failures: int = 0
    graded_replies: int = 0
    unparsed_replies: int = 0


def health_problem(counts: HealthCounts, config: dict[str, Any]) -> str | None:
    """Return why the model should be paused, or None while it is still healthy.

    Nothing is judged before health_min_calls calls, because a few bad calls say little about a model.
    After that, a rate above its limit pauses the model. A rate exactly at the limit is not above it.
    """
    if counts.calls == 0 or counts.calls < config["health_min_calls"]:
        return None
    failure_rate = counts.failures / counts.calls
    if failure_rate > config["health_max_failure_rate"]:
        return (
            f"{counts.failures} of {counts.calls} calls failed ({failure_rate:.0%}), "
            f"above the limit of {config['health_max_failure_rate']:.0%}"
        )
    # With no graded reply yet there is no unparsed rate to judge, so it counts as zero.
    unparsed_rate = counts.unparsed_replies / counts.graded_replies if counts.graded_replies else 0.0
    if unparsed_rate > config["health_max_unparsed_rate"]:
        return (
            f"{counts.unparsed_replies} of {counts.graded_replies} graded replies had no 'Answer: X' line "
            f"({unparsed_rate:.0%}), above the limit of {config['health_max_unparsed_rate']:.0%}"
        )
    return None


def model_is_unhealthy(counts: HealthCounts, config: dict[str, Any]) -> bool:
    """True when the model should be paused: enough calls, and a failure or unparsed rate above its limit."""
    return health_problem(counts, config) is not None


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
    # The most calls in flight at once across all models, from config["concurrency"].
    semaphore: asyncio.Semaphore
    # Decides when each model may be called, so no model is called faster than its own limits allow.
    pacer: limiter.Pacer
    settings: RunSettings
    stats: RunStats
    budget: CallBudget


def backoff_seconds(attempt: int) -> int:
    """Return how long to wait after a failed attempt. Attempts are counted from 0: 1, 2, 4, ... up to 60."""
    return min(2**attempt, MAX_BACKOFF_SECONDS)


def jittered_seconds(seconds: float) -> float:
    """Return the wait plus a random extra of up to a quarter of it. Used only after a rate-limit (429) error.

    The base wait is never shortened, so the provider's pause is always respected. Only the extra is random.
    """
    return seconds + random.uniform(0, seconds * RATE_LIMIT_JITTER_FRACTION)


def make_units(
    models: list[str],
    questions: list[dict[str, Any]],
    repeats: int,
    labels: dict[str, str] | None = None,
    mix_fields_by_question: dict[str, dict[str, Any]] | None = None,
) -> list[Unit]:
    """Return every model, question and repeat combination. Repeats are numbered from 1.

    'labels' maps a model name to the name its replies are saved under. A model without one keeps its own name.
    'mix_fields_by_question' gives a mixed run's fields for each question id (its set, pushback set, seed and
    position). Fixed runs pass none, so their units have no pushback set and no extra fields.
    """
    names = labels or {}
    fields_by_id = mix_fields_by_question or {}
    units = []
    for model in models:
        for question in questions:
            mix_fields = dict(fields_by_id.get(question["id"], {}))
            for repeat in range(1, repeats + 1):
                units.append(
                    Unit(
                        model=model,
                        question=question,
                        repeat=repeat,
                        label=names.get(model, model),
                        pushback_set=mix_fields.get("pushback_set", ""),
                        mix_fields=mix_fields,
                    )
                )
    return units


def interleave(groups: list[list[Any]]) -> list[Any]:
    """Return the items of several lists in turn: the first item of each list, then the second of each, and so on.

    A list that runs out is skipped, so the others keep their turns. This is round-robin. One model with a long
    list cannot push the other models to the back of the queue, because every model gets a turn in each round.
    """
    merged = []
    for position in range(max((len(group) for group in groups), default=0)):
        for group in groups:
            if position < len(group):
                merged.append(group[position])
    return merged


def settings_for_condition(settings: RunSettings, condition: str) -> RunSettings:
    """Return the settings for one system-prompt condition. Each condition in a run gets its own copy.

    The settings given to run_all already hold the prompt of settings.condition, so that condition keeps them.
    Any other condition takes its prompt from config.json, the same place main() reads the prompt of one condition.
    """
    if condition == settings.condition:
        return settings
    return replace(settings, condition=condition, system_prompt=core.system_prompt_for(condition, settings.config))


def make_run_queue(
    contexts: list[RunContext],
    models: list[str],
    questions: list[dict[str, Any]],
    repeats: int,
    labels: dict[str, str],
    mix_fields_by_question: dict[str, dict[str, Any]] | None,
) -> list[tuple[RunContext, Unit]]:
    """Return every unit of every model and condition, in the order the run should start them.

    The units of one model are grouped together: each condition, then each question and repeat. The groups are
    then interleaved, so the models take turns. asyncio.Semaphore hands out its slots first come, first served,
    so the order of this queue is the order in which the models get to make calls.
    """
    groups = []
    for model in models:
        units = make_units([model], questions, repeats, labels, mix_fields_by_question)
        groups.append([(context, unit) for context in contexts for unit in units])
    return interleave(groups)


def step_key(condition: str, unit: Unit, step: str) -> tuple[Any, ...]:
    """Return the cache key of one step of one unit, built from the saved model name."""
    return core.make_key(condition, unit.label, unit.question["id"], unit.repeat, step)


async def run_unit(ctx: RunContext, unit: Unit) -> None:
    """Ask the question, then run the flows the settings ask for. A failed call ends the unit early."""
    settings = ctx.settings
    ladder, probe_spec = ladder_and_probes_for(unit, settings.pushback_plans, settings.ladder, settings.probe_spec)
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
        ladder,
        probe_spec,
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
        reply.text,
        ctx.settings.config["temperature"],
        suite=ctx.settings.suite,
        extra=saved_extra_fields(unit, reply),
    )
    # Write to disk first and update the in-memory cache second, so a crash keeps every reply already paid for.
    # The store commits the row before add returns. The same line is then appended to the JSONL file, which
    # stays a copy of the store for tools that still read the file.
    with store.open_store(ctx.cache_path) as db:
        db.add(record)
    core.append_record(record, ctx.cache_path)
    ctx.cache[key] = record
    ctx.stats.calls_made += 1
    return reply.text


def saved_extra_fields(unit: Unit, reply: model_client.Reply) -> dict[str, Any]:
    """Return the extra fields saved with a reply: the mixed run's fields, plus the usage and finish_reason.

    The usage and finish_reason let later analysis see how long each answer was and why it stopped. They are
    not part of the experiment code, so saving them never changes which replies are reused.
    """
    extra = dict(unit.mix_fields)
    extra["prompt_tokens"] = reply.prompt_tokens
    extra["completion_tokens"] = reply.completion_tokens
    extra["finish_reason"] = reply.finish_reason
    return extra


async def call_with_retries(
    ctx: RunContext, unit: Unit, messages: list[dict[str, str]], step: str
) -> model_client.Reply | None:
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
            wait = backoff_seconds(attempt)
            # A rate limit gets jitter so the retries of many calls spread out. Other errors keep the exact wait.
            if model_client.is_rate_limit(error):
                wait = jittered_seconds(wait)
            await ctx.settings.wait(wait)
            attempt += 1


async def call_model(ctx: RunContext, model: str, messages: list[dict[str, str]]) -> model_client.Reply:
    """Make one API call, once the pacer says the model has room, and return the whole reply.

    The pacer goes first, so a model with no room waits without holding one of the global slots that other
    models could use. The pacer slot is always given back in the finally, even when the call fails.
    """
    estimate = await ctx.pacer.admit(model, limiter.estimate_input_tokens(messages))
    started = ctx.pacer.clock()
    reply = None
    try:
        reply = await complete_in_slot(ctx, model, messages)
        return reply
    except Exception as error:
        park_if_told_to_wait(ctx, model, error)
        raise
    finally:
        finish_admitted_call(ctx, model, estimate, started, reply)


async def complete_in_slot(ctx: RunContext, model: str, messages: list[dict[str, str]]) -> model_client.Reply:
    """Make the call while holding one of the global slots. The budget is spent inside the slot.

    The budget is checked and spent before the call starts, so no more calls than the limit are ever made.
    """
    async with ctx.semaphore:
        ctx.budget.spend()
        return await ctx.client.complete_detailed(
            model=model,
            messages=messages,
            temperature=ctx.settings.config["temperature"],
            max_tokens=ctx.settings.config["max_tokens"],
        )


def park_if_told_to_wait(ctx: RunContext, model: str, error: Exception) -> None:
    """Park the model for the wait that a rate-limit error asked for.

    An error with no wait time parks nothing. The normal retry backoff handles it, and guessing a wait here
    would hold the model back for a time the provider never asked for.
    """
    if not model_client.is_rate_limit(error):
        return
    seconds = model_client.retry_after_seconds(error)
    if seconds is not None:
        ctx.pacer.record_rate_limit(model, seconds)


def finish_admitted_call(
    ctx: RunContext, model: str, estimate: float, started: float, reply: model_client.Reply | None
) -> None:
    """Give back the pacer slot of a call that has ended, and pass on what its reply said.

    A failed call has no reply, so it only gives its slot back. The reserved tokens are not refunded then,
    because a failed call may still have used the provider's allowance.
    """
    if reply is None:
        ctx.pacer.finish_call(model, estimate)
        return
    ctx.pacer.finish_call(
        model,
        estimate,
        seconds=ctx.pacer.clock() - started,
        headers=reply.headers,
        prompt_tokens=reply.prompt_tokens,
        completion_tokens=reply.completion_tokens,
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
    mix_fields_by_question: dict[str, dict[str, Any]] | None = None,
    pacer: limiter.Pacer | None = None,
    conditions: list[str] | None = None,
) -> RunStats:
    """Run every unit, with at most config["concurrency"] API calls at once in total, paced to each model's limits.
    Then close the client.

    'conditions' names the system prompts to run together in this one schedule. None means only settings.condition.
    Saved replies are read from 'cache', and new ones are appended to 'cache_path'.
    With 'max_calls', the run makes no more API attempts than that and then stops.
    'mix_fields_by_question' is passed on to make_units for a mixed run.
    'pacer' decides when each model may be called. A new one, reading the shipped limits, is made when none is given.
    """
    shared = RunContext(
        client=client,
        cache=cache,
        cache_path=cache_path,
        semaphore=asyncio.Semaphore(settings.config["concurrency"]),
        pacer=pacer if pacer is not None else limiter.Pacer(),
        settings=settings,
        stats=RunStats(),
        budget=CallBudget(max_calls),
    )
    condition_names = conditions if conditions is not None else [settings.condition]
    # Every condition shares the cache, the slots, the pacer, the stats and the budget. Only its settings differ.
    contexts = [replace(shared, settings=settings_for_condition(settings, name)) for name in condition_names]
    queue = make_run_queue(contexts, models, questions, repeats, settings.labels, mix_fields_by_question)
    # All units start at once; the semaphore in call_model is what limits how many API calls run together.
    tasks = [asyncio.create_task(run_unit(context, unit)) for context, unit in queue]
    try:
        # Units finish in any order, so this counts completions, not unit numbers.
        for finished_count, finished in enumerate(asyncio.as_completed(tasks), start=1):
            await finished
            print(f"Finished {finished_count} of {len(queue)} units")
    finally:
        # Close the client even if a unit raised, so connections are not left open.
        await client.close()
    return shared.stats


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
    ladder: dict[str, Any] | None,
    probe_spec: dict[str, Any] | None,
    labels: dict[str, str] | None = None,
    mix_fields_by_question: dict[str, dict[str, Any]] | None = None,
    pushback_plans: dict[str, PushbackPlan] | None = None,
) -> CallPlan:
    """Count the calls a run would still need for one model. Nothing is called and nothing is saved.

    Until a unit's first answer is saved, every step that could follow it is counted, so the number
    of new calls is an upper bound. A mixed run passes 'pushback_plans', so each unit counts its own ladder.
    """
    plan = CallPlan()
    for unit in make_units([model], questions, repeats, labels, mix_fields_by_question):
        baseline_correct = saved_baseline_correct(cache, condition, unit)
        unit_ladder, unit_probes = ladder_and_probes_for(unit, pushback_plans, ladder, probe_spec)
        # baseline_correct is None until the first answer is saved; expected_steps then counts every possible step.
        steps = flows.expected_steps(unit.question, families, unit_ladder, unit_probes, baseline_correct)
        if not confession_can_follow(cache, condition, unit, unit_ladder):
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


def plan_model_calls_for_conditions(
    model: str,
    questions: list[dict[str, Any]],
    repeats: int,
    cache: dict[tuple[Any, ...], dict[str, Any]],
    conditions: list[str],
    families: frozenset[str],
    ladder: dict[str, Any] | None,
    probe_spec: dict[str, Any] | None,
    labels: dict[str, str] | None = None,
    mix_fields_by_question: dict[str, dict[str, Any]] | None = None,
    pushback_plans: dict[str, PushbackPlan] | None = None,
) -> CallPlan:
    """Add up plan_model_calls over every condition of the run, since each condition has its own saved replies."""
    total = CallPlan()
    for condition in conditions:
        plan = plan_model_calls(
            model, questions, repeats, cache, condition, families, ladder, probe_spec, labels,
            mix_fields_by_question, pushback_plans,
        )
        total.saved += plan.saved
        total.at_most_new += plan.at_most_new
    return total


def print_dry_run(
    models: list[str],
    questions: list[dict[str, Any]],
    repeats: int,
    conditions: list[str],
    cache: dict[tuple[Any, ...], dict[str, Any]],
    families: frozenset[str],
    ladder: dict[str, Any] | None,
    probe_spec: dict[str, Any] | None,
    labels: dict[str, str] | None = None,
    mix_fields_by_question: dict[str, dict[str, Any]] | None = None,
    pushback_plans: dict[str, PushbackPlan] | None = None,
) -> None:
    """Print, per model, how many replies are saved and the most new calls a real run would make."""
    total_new = 0
    print("Dry run: no calls will be made.")
    # A mixed run has no single ladder; it names its pushback sets instead.
    print(f"Ladder: {ladder['name']}" if pushback_plans is None else f"Ladder: {', '.join(pushback_plans)}")
    print(f"Families: {family_text(families)}")
    for model in models:
        plan = plan_model_calls_for_conditions(
            model, questions, repeats, cache, conditions, families, ladder, probe_spec, labels,
            mix_fields_by_question, pushback_plans,
        )
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
        dest="conditions",
        nargs="+",
        choices=core.CONDITIONS,
        default=[core.NO_SYSTEM_PROMPT],
        help="which system prompt or prompts to use. Several can be given, and they run in one schedule, "
        "sharing the same slots and limits (default: none)",
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
    core.add_suite_argument(parser)
    parser.add_argument(
        "--shuffle-mix",
        type=int,
        default=None,
        metavar="SEED",
        help="run easy and hard questions together, in the order chosen by SEED, each with its own pushbacks "
        "(easy: gauntlet_v3, hard: gauntlet_v4). --limit keeps the first N of each set before the order is made. "
        "Cannot be combined with --suite.",
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
    if args.shuffle_mix is not None and args.suite is not None:
        parser.error("--shuffle-mix cannot be combined with --suite: a mixed run sets both itself.")
    # A condition named twice would make every one of its units run twice and save each reply twice.
    if len(set(args.conditions)) != len(args.conditions):
        parser.error("--condition names each condition once.")
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
    """Print what this run will do before any call is made. 'condition' is the names of the conditions, joined."""
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


@dataclass
class RunPlan:
    """What one run asks, and the settings and names that go with it. A fixed run and a mixed run both make one."""

    experiment: str  # the version code the saved replies carry and are read under
    suite: core.Suite | core.MixedSuite
    questions: list[dict[str, Any]]  # the questions to ask, in the order they are asked
    ladder: dict[str, Any] | None  # a fixed run's single ladder; None for a mixed run
    probe_spec: dict[str, Any] | None  # a fixed run's single probe spec; None for a mixed run
    pushback_plans: dict[str, PushbackPlan] | None = None  # mixed runs only, one per pushback set
    mix_fields_by_question: dict[str, dict[str, Any]] | None = None  # mixed runs only, saved with each reply
    counts: dict[str, Any] | None = None  # mixed runs only: how many questions each set has
    order: list[dict[str, Any]] | None = None  # mixed runs only: the planned order, one row per question

    @property
    def is_mixed(self) -> bool:
        """True for a mixed run. Only a mixed run has an order."""
        return self.order is not None


def plan_fixed_run(args: argparse.Namespace) -> RunPlan:
    """Plan a run of one pushback set and one question set, as before the mixed run existed."""
    suite = core.load_chosen_suite(args.suite)
    # --limit keeps the first N questions of the file, so a limited run is the same set every time.
    questions = suite.questions if args.limit is None else suite.questions[: args.limit]
    return RunPlan(
        experiment=suite.experiment, suite=suite, questions=questions, ladder=suite.ladder,
        probe_spec=suite.probe_spec,
    )


def plan_mixed_run(seed: int, limit: int | None) -> RunPlan:
    """Plan a mixed run: easy and hard questions in the order that SEED gives, each with its own pushback set.

    --limit is applied to each set first (the first N of each file), and the order is made from those,
    so the counts describe the questions that will really be asked.
    """
    mixed = core.load_mixed_suite()
    easy = mixed.suites["easy"].questions
    hard = mixed.suites["hard"].questions
    if limit is not None:
        easy, hard = easy[:limit], hard[:limit]
    slots = mix.build_mixed_order(easy, hard, seed)
    # Each question's saved fields say which seed, position, set and pushback set it came from.
    fields_by_question = {
        slot["question"]["id"]: {
            "mix_seed": seed,
            "mix_position": slot["position"],
            "pushback_set": slot["pushback_set"],
            "question_set": slot["question_set"],
        }
        for slot in slots
    }
    pushback_plans = {
        suite.ladder_name: PushbackPlan(ladder=suite.ladder, probe_spec=suite.probe_spec)
        for suite in mixed.suites.values()
    }
    return RunPlan(
        experiment=mixed.experiment,
        suite=mixed,
        questions=[slot["question"] for slot in slots],
        ladder=None,
        probe_spec=None,
        pushback_plans=pushback_plans,
        mix_fields_by_question=fields_by_question,
        counts=mix.mix_counts(slots),
        order=mix.order_rows(slots),
    )


def count_finished_questions(
    cache: dict[tuple[Any, ...], dict[str, Any]],
    conditions: list[str],
    models: list[str],
    repeats: int,
    questions: list[dict[str, Any]],
    labels: dict[str, str],
    mix_fields_by_question: dict[str, dict[str, Any]],
) -> int:
    """Count the questions whose first answer is saved for every model, repeat and condition.

    This is the 'completed' number in the mixed run record. It is read from the saved replies, so a run
    that stopped early shows fewer than it planned.
    """
    finished = 0
    for question in questions:
        units = make_units(models, [question], repeats, labels, mix_fields_by_question)
        if all(step_key(condition, unit, core.BASELINE_STEP) in cache for condition in conditions for unit in units):
            finished += 1
    return finished


def new_run_record(plan: RunPlan, seed: int, limit: int | None) -> dict[str, Any]:
    """Return the record written at the start of a mixed run. It is replaced at the end with the completed count."""
    return {
        "experiment": plan.experiment,
        "seed": seed,
        "limit": limit,
        "status": "started",
        "started": core.utc_timestamp(),
        "finished": None,
        "planned": len(plan.order or []),
        "completed": None,
        "counts": plan.counts,
        "order": plan.order,
    }


def main(
    argv: list[str] | None = None, prebuilt_routes: dict[str, model_client.ModelRoute] | None = None
) -> int:
    """Run the experiment from the command line.

    'prebuilt_routes' lets the ordeal command pass in routes that already hold their keys. Each one is
    treated like a custom model, so its saved replies get the same digest label, and --models is ignored.

    Returns 0, 1 if any call failed, or 2 for a bad option, a missing key, or a call limit that stopped the run.
    """
    config = core.load_config()
    args = parse_args(argv)
    try:
        custom_routes = model_client.load_custom_models(config)
    except ValueError as error:
        print(error, file=sys.stderr)
        return EXIT_BAD_OPTION
    if prebuilt_routes is not None:
        custom_routes = custom_routes + list(prebuilt_routes.values())
        models = list(prebuilt_routes)
    else:
        models = choose_models(args, config)
    plan = plan_fixed_run(args) if args.shuffle_mix is None else plan_mixed_run(args.shuffle_mix, args.limit)
    labels = model_client.record_labels(models, config, custom_routes, args.base_url)
    # An explicit --cache wins; otherwise stub runs use their own cache file so fake replies never mix with real ones.
    cache_path = args.cache or (core.STUB_CACHE_PATH if args.stub else core.CACHE_PATH)
    cache = core.load_cache(cache_path, experiment=plan.experiment)

    if args.dry_run:
        print_dry_run(
            models, plan.questions, args.repeats, args.conditions, cache, args.probes, plan.ladder, plan.probe_spec,
            labels, plan.mix_fields_by_question, plan.pushback_plans,
        )
        return 0

    try:
        # Routes from the ordeal command already hold their keys, so they skip the environment lookup in make_client.
        if prebuilt_routes is not None and not args.stub:
            client = model_client.ModelRouter(prebuilt_routes, config["request_timeout_seconds"])
        else:
            client = make_client(args, config, models, custom_routes, plan.questions)
    except RuntimeError as error:
        print(error, file=sys.stderr)
        return EXIT_BAD_OPTION
    # The first condition is the template; run_all gives every other condition its own copy of these settings.
    settings = RunSettings(
        condition=args.conditions[0],
        system_prompt=core.system_prompt_for(args.conditions[0], config),
        config=config,
        ladder=plan.ladder,
        probe_spec=plan.probe_spec,
        families=args.probes,
        is_retryable=model_client.is_retryable,
        describe_error=model_client.describe_error,
        suite=plan.suite,
        labels=labels,
        pushback_plans=plan.pushback_plans,
    )

    if plan.is_mixed:
        print_mixed_plan(args.shuffle_mix, plan.counts)
        ladder_name = ", ".join(plan.pushback_plans)
    else:
        ladder_name = plan.ladder["name"]
    print_plan(
        ladder_name, plan.experiment, ", ".join(args.conditions), models, args.probes, len(plan.questions),
        args.repeats, cache_path,
    )
    # A killed run may have saved a reply only to the store. Copy such replies into the JSONL file before any new
    # call, so the file is complete again and a resumed run does not leave it one line short.
    store.repair_jsonl_from_store(cache_path)
    # A mixed run's record is written before the first call, so a stopped run still shows what was planned.
    record_path = core.mixed_runs_path(cache_path)
    run_record = new_run_record(plan, args.shuffle_mix, args.limit) if plan.is_mixed else None
    if run_record is not None:
        core.write_run_record(run_record, record_path)
    # One pacer for the whole run, so the snapshot written below shows what the run itself learned about each model.
    # A stub run never reaches a provider, so it is not paced. Pacing it would add minutes of waiting for nothing.
    pacer = limiter.Pacer(paced=not args.stub)
    stats = asyncio.run(
        run_all(
            client, cache, cache_path, plan.questions, models, args.repeats, settings, args.max_calls,
            plan.mix_fields_by_question, pacer=pacer, conditions=args.conditions,
        )
    )
    limiter.write_snapshot(pacer, core.RESULTS_DIR / "rate_limits.json")
    if run_record is not None:
        run_record["completed"] = count_finished_questions(
            cache, args.conditions, models, args.repeats, plan.questions, labels, plan.mix_fields_by_question,
        )
        run_record["status"] = "stopped" if stats.stopped_by_budget else "finished"
        run_record["finished"] = core.utc_timestamp()
        core.write_run_record(run_record, record_path)
    print_summary(stats)
    if stats.stopped_by_budget:
        print(f"Stopped at the --max-calls limit of {args.max_calls}. Run the same command again to continue.")
        return EXIT_INCOMPLETE
    return 1 if stats.failures else 0


def print_mixed_plan(seed: int, counts: dict[str, Any]) -> None:
    """Print the seed and the counts of a mixed run, before any call is made."""
    print(f"Mixed order, seed {seed}: {counts['easy']['count']} easy with gauntlet_v3, "
          f"{counts['hard']['count']} hard with gauntlet_v4 ({counts['total']} questions)")


if __name__ == "__main__":
    sys.exit(main())
