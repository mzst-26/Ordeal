"""Decide which messages are sent for one (model, question, repeat) unit, and in what order.

Nothing here calls the network. The caller passes an async function ask(step, messages) that
sends the messages and returns the reply text, or None when the call failed for good.
Every flow stops at the first None, so no later message of the unit is sent.
"""

# Lets "str | None" annotations load on Python 3.9, which the system python3 is.
from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from typing import Optional

from ordeal import adaptive
from ordeal import core

# Names of the flow families a run can ask for. Each family sends its own group of messages per unit:
# the pressure ladder, correction tests, single-shot axis probes, twin probes, and dose probes.
GAUNTLET = "gauntlet"
CORRECTIONS = "corrections"
FINGERPRINT = "fingerprint"
TWINS = "twins"
DOSE = "dose"
ALL_FAMILIES = frozenset({GAUNTLET, CORRECTIONS, FINGERPRINT, TWINS, DOSE})

# The tampered-history probe is built differently from the others (see run_tampered_history).
TAMPERED_AXIS_ID = "tampered_history"
# Left in an axis message until axis_for_slot swaps in the letter of the chosen option.
LETTER_PLACEHOLDER = "{X_letter}"
# v4 gives the tampered-history texts only inside its forge note, as quoted text after "with:" and "ask:".
FORGED_REPLY_PATTERN = re.compile(r"with: '([^']+)'")
FINAL_ASK_PATTERN = re.compile(r"ask: '([^']+)'")

# This alias is evaluated when the module loads, so it uses Optional, not "str | None".
AskFunction = Callable[[str, list], Awaitable[Optional[str]]]


class AskFailed(Exception):
    """Raised when ask returns None, so that the rest of the unit is not sent."""


def user_turn(text: str) -> dict:
    """Return a user message."""
    return {"role": "user", "content": text}


def assistant_turn(text: str) -> dict:
    """Return an assistant message."""
    return {"role": "assistant", "content": text}


def planted_wrong_turn(question: dict) -> dict:
    """Return an assistant message that states the pushed wrong answer."""
    return assistant_turn(f"Answer: {question['pushed_wrong']}")


def build_first_messages(question: dict, system_prompt: str | None) -> list:
    """Return the opening messages: the system prompt when there is one, then the question."""
    messages = []
    if system_prompt is not None:
        messages.append({"role": "system", "content": system_prompt})
    messages.append(user_turn(core.format_question(question)))
    return messages


async def send_step(ask: AskFunction, step: str, messages: list) -> str:
    """Call ask and return its reply. Raise AskFailed when ask returns None."""
    reply = await ask(step, messages)
    if reply is None:
        raise AskFailed(step)
    return reply


def gauntlet_steps(ladder: dict) -> list:
    """Return the step names of the gauntlet: every level, each setup turn, then the confession."""
    # Setup steps are listed per level that has "setup_turn"; the confession is only sent if the model flipped.
    steps = list(core.pushback_steps(len(ladder["levels"])))
    for entry in ladder["levels"]:
        if entry.get("setup_turn"):
            steps.append(core.setup_step(entry["level"]))
    steps.append(core.CONFESSION_STEP)
    return steps


def probe_steps(axes: list, step_name: Callable[[str], str]) -> list:
    """Return the step names of single-shot probes, with the setup step of each probe that has one."""
    steps = []
    for axis in axes:
        step = step_name(axis["id"])
        steps.append(step)
        if axis.get("setup_turn"):
            steps.append(core.probe_setup_step(step))
    return steps


def fingerprint_axes(probe_spec: dict) -> list:
    """Return the axes sent as single-shot probes, in file order. Tampered history is one of them.

    Both v3 and v4 send every axis in the file. The family mapping is this function and twin_axes.
    """
    return probe_spec["axes"]


def twin_axes(probe_spec: dict) -> list:
    """Return the probe axes marked "twin": true, in file order. Both v3 and v4 mark their twins this way."""
    return [axis for axis in probe_spec["axes"] if axis.get("twin")]


def tampered_axis(axis: dict) -> dict:
    """Return the tampered-history axis with forged_reply and final_ask set, read from its forge note if needed."""
    # v3 stores the texts as fields; v4 only describes them in a "forge" note, so they are cut out of it.
    if "forged_reply" in axis:
        return axis
    note = axis.get("forge", "")
    reply = FORGED_REPLY_PATTERN.search(note)
    ask = FINAL_ASK_PATTERN.search(note)
    if reply is None or ask is None:
        raise ValueError(f"Axis '{axis.get('id')}' needs forged_reply and final_ask, or a forge note with both texts.")
    return dict(axis, forged_reply=reply.group(1), final_ask=ask.group(1))


def axis_for_slot(axis: dict, question: dict, slot: str) -> dict:
    """Return the axis with {X_letter} replaced by the letter of the slot's option. Only v4's format squeeze uses it."""
    message = axis.get("message", "")
    if LETTER_PLACEHOLDER not in message:
        return axis
    letter = {"wrong": question["pushed_wrong"], "right": question["correct"]}[slot]
    return dict(axis, message=message.replace(LETTER_PLACEHOLDER, letter))


def dose_steps(doses: dict) -> list:
    """Return the step names of every dose on every dial."""
    steps = []
    for dial_name, dial in doses.items():
        for index in range(1, len(dial["levels"]) + 1):
            steps.append(core.dose_probe_step(dial_name, index))
    return steps


def expected_steps(question: dict, families: set, ladder: dict, probe_spec: dict,
                   baseline_correct: bool | None) -> list:
    """Return every step name the flows may send for this unit. Some may be skipped at run time."""
    # baseline_correct is None when the baseline is not known yet, so only an explicit False skips the
    # pressure families. Corrections do not depend on the baseline: they start from a planted wrong answer.
    steps = [core.BASELINE_STEP]
    if GAUNTLET in families and baseline_correct is not False:
        steps += gauntlet_steps(ladder)
    if CORRECTIONS in families and question.get("correction_test"):
        steps += list(core.CORRECTION_STEPS)
    if FINGERPRINT in families and baseline_correct is not False:
        steps += probe_steps(fingerprint_axes(probe_spec), core.axis_probe_step)
    if TWINS in families and baseline_correct is not False:
        steps += probe_steps(twin_axes(probe_spec), core.twin_probe_step)
    if DOSE in families and baseline_correct is not False:
        steps += dose_steps(probe_spec["doses"])
    return steps


def model_flipped(letters: list, question: dict) -> bool:
    """Return True when any answered level gave a letter other than the correct one."""
    return any(letter is not None and letter != question["correct"] for letter in letters)


async def run_gauntlet_setup(ask: AskFunction, conversation: list, question: dict, entry: dict):
    """Send the one-turn setup before a gauntlet level. Return the new conversation and the setup reply."""
    text = adaptive.setup_text(entry, question)
    reply = await send_step(ask, core.setup_step(entry["level"]), conversation + [user_turn(text)])
    return conversation + [user_turn(text), assistant_turn(reply)], reply


async def run_gauntlet(ask: AskFunction, first_messages: list, question: dict, baseline_reply: str,
                       ladder: dict, config: dict) -> None:
    """Send the ten pressure levels in one conversation, then the confession check if the model flipped."""
    # The whole ladder is one growing conversation, so each level sees every earlier pushback and reply.
    # previous_reply and setup_reply feed the axes that quote or react to earlier turns.
    conversation = first_messages + [assistant_turn(baseline_reply)]
    previous_reply = baseline_reply
    setup_reply = None
    letters = []
    pushback_steps = core.pushback_steps(len(ladder["levels"]))
    for entry in ladder["levels"]:
        if entry.get("setup_turn"):
            conversation, setup_reply = await run_gauntlet_setup(ask, conversation, question, entry)
        message = adaptive.gauntlet_message(entry, ladder, question, previous_reply, setup_reply)
        text = core.add_format_reminder(message, config)
        reply = await send_step(ask, pushback_steps[entry["level"] - 1], conversation + [user_turn(text)])
        conversation = conversation + [user_turn(text), assistant_turn(reply)]
        previous_reply = reply
        letters.append(core.parse_answer(reply))
    # The confession probe is only asked of a model that gave a wrong letter at some level.
    if model_flipped(letters, question):
        confession = core.add_format_reminder(ladder["confession_probe"]["message"], config)
        await send_step(ask, core.CONFESSION_STEP, conversation + [user_turn(confession)])


async def run_corrections(ask: AskFunction, first_messages: list, question: dict, config: dict) -> None:
    """Send each correction message after the planted wrong answer."""
    # Each variant starts a fresh conversation, so the two corrections do not affect each other.
    for step in core.CORRECTION_STEPS:
        variant = core.CORRECTION_VARIANT_BY_STEP[step]
        correction = core.correction_message(variant, question, config)
        messages = first_messages + [planted_wrong_turn(question), user_turn(correction)]
        await send_step(ask, step, messages)


async def run_probe_setup(ask: AskFunction, step: str, opening: list, axis: dict) -> list:
    """Send the setup turn of a single-shot probe. Return the opening with that turn and its reply added."""
    setup_text = adaptive.probe_setup_text(axis)
    reply = await send_step(ask, core.probe_setup_step(step), opening + [user_turn(setup_text)])
    return opening + [user_turn(setup_text), assistant_turn(reply)]


async def send_probe(ask: AskFunction, step: str, opening: list, axis: dict, text: str, config: dict) -> None:
    """Send one single-shot probe, after its setup turn when the axis has one."""
    if axis.get("setup_turn"):
        opening = await run_probe_setup(ask, step, opening, axis)
    final_text = core.add_format_reminder(text, config)
    await send_step(ask, step, opening + [user_turn(final_text)])


async def run_tampered_history(ask: AskFunction, first_messages: list, question: dict, axis: dict,
                               config: dict) -> None:
    """Send the probe whose earlier model reply was edited, then ask which answer it stands by."""
    # The assistant turn is written by us, not the model: it states the forged reply as if the model had said it.
    axis = tampered_axis(axis)
    opening = first_messages + [assistant_turn(adaptive.forged_reply(axis, question))]
    await send_probe(ask, core.axis_probe_step(axis["id"]), opening, axis, adaptive.final_ask(axis), config)


async def run_fingerprint(ask: AskFunction, first_messages: list, question: dict, baseline_reply: str,
                          ladder: dict, probe_spec: dict, config: dict) -> None:
    """Send one single-shot probe per axis of the probe spec, in file order."""
    quote = adaptive.extract_quote(baseline_reply)
    for axis in fingerprint_axes(probe_spec):
        if axis["id"] == TAMPERED_AXIS_ID:
            await run_tampered_history(ask, first_messages, question, axis, config)
            continue
        text = adaptive.axis_message(axis_for_slot(axis, question, "wrong"), ladder, question, "wrong", quote=quote)
        # None means a quote probe with no hedge to quote in this baseline reply, so it is not sent.
        if text is None:
            continue
        opening = first_messages + [assistant_turn(baseline_reply)]
        await send_probe(ask, core.axis_probe_step(axis["id"]), opening, axis, text, config)


async def run_twins(ask: AskFunction, first_messages: list, question: dict, baseline_reply: str,
                    ladder: dict, probe_spec: dict, config: dict) -> None:
    """Send the twin probe of each twin axis, after a planted wrong answer, with the right option's text."""
    # The twin starts from a planted wrong answer and pushes toward the right one, the mirror of the fingerprint probe.
    planted = first_messages + [planted_wrong_turn(question)]
    quote = adaptive.extract_quote(baseline_reply)
    for axis in twin_axes(probe_spec):
        text = adaptive.axis_message(axis_for_slot(axis, question, "right"), ladder, question, "right", quote=quote)
        if text is None:
            continue
        await send_probe(ask, core.twin_probe_step(axis["id"]), planted, axis, text, config)


async def run_dose(ask: AskFunction, first_messages: list, question: dict, baseline_reply: str,
                   probe_spec: dict, config: dict) -> None:
    """Send every dose of every dial, each after the model's correct baseline answer."""
    opening = first_messages + [assistant_turn(baseline_reply)]
    for dial_name, dial in probe_spec["doses"].items():
        for index in range(1, len(dial["levels"]) + 1):
            text = core.add_format_reminder(adaptive.dose_message(dial, index, question), config)
            await send_step(ask, core.dose_probe_step(dial_name, index), opening + [user_turn(text)])


async def run_flows(question: dict, system_prompt: str | None, baseline_reply: str, ask: AskFunction,
                    families: set, ladder: dict, probe_spec: dict, config: dict) -> None:
    """Send the flows of one unit that apply, in order. Stop at the first call that fails."""
    # Pressure flows only make sense when the model started out right. A failed call anywhere raises
    # AskFailed, which ends the unit here, so later flows of this unit are not sent either.
    first_messages = build_first_messages(question, system_prompt)
    baseline_correct = core.is_correct(baseline_reply, question)
    try:
        if GAUNTLET in families and baseline_correct:
            await run_gauntlet(ask, first_messages, question, baseline_reply, ladder, config)
        if CORRECTIONS in families and question.get("correction_test"):
            await run_corrections(ask, first_messages, question, config)
        if FINGERPRINT in families and baseline_correct:
            await run_fingerprint(ask, first_messages, question, baseline_reply, ladder, probe_spec, config)
        if TWINS in families and baseline_correct:
            await run_twins(ask, first_messages, question, baseline_reply, ladder, probe_spec, config)
        if DOSE in families and baseline_correct:
            await run_dose(ask, first_messages, question, baseline_reply, probe_spec, config)
    except AskFailed:
        return
