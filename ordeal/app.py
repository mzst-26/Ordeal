"""Live demo page for the Ordeal.

The page asks a model a question, pushes it through the levels of a pushback set, and
lets you ask which answer it really believes. You pick the pushback set and the question
set on the page. Replay mode shows the saved run from results/cache.jsonl and needs no
network or API key.
"""

import asyncio
from dataclasses import dataclass, replace
from functools import lru_cache

import gradio as gr
import openai

from ordeal import adaptive
from ordeal import core
from ordeal.model_client import TokenFactoryClient, describe_error

DEMO_REPEAT = 1  # runner.py numbers repeats from 1, so the first saved run is repeat 1.
# Live demo replies go here, never to results/cache.jsonl, which the grader reads as experiment data.
DEMO_CACHE_PATH = core.RESULTS_DIR / "demo_cache.jsonl"

# Colours of the spine meter: red marks the level where the model gave in, green a full hold, light blue
# a level passed so far, grey an untouched level. The *_TEXT colours are for the result line and need to
# stay readable on a white page.
RED = "#ef4444"
GREEN = "#22c55e"
FILLED = "#93c5fd"
EMPTY = "#e5e7eb"
SEGMENT_TEXT = "#111827"
RED_TEXT = "#b91c1c"
GREEN_TEXT = "#15803d"
GREY_TEXT = "#4b5563"
# Page labels for the pushback and question set dropdowns, keyed by the names in core.LADDER_FILES and core.QUESTION_FILES.
PUSHBACK_LABELS = {"gauntlet_v3": "Easy pushbacks (gauntlet_v3)", "gauntlet_v4": "Hard pushbacks (gauntlet_v4)"}
QUESTION_SET_LABELS = {"easy": "Easy questions", "hard": "Hard questions"}

# RuntimeError covers a missing key; openai.OpenAIError covers API and network failures.
REQUEST_ERRORS = (RuntimeError, openai.OpenAIError)

# Read once when the module loads and shared by every handler.
CONFIG = core.load_config()
DEFAULT_SUITE = core.default_suite()


class ReplayMissingError(RuntimeError):
    """Replay mode has no saved reply for the step that was asked for."""


@lru_cache(maxsize=None)
def suite_for(ladder_name: str, question_set: str) -> core.Suite:
    """Return the suite for one pushback set and one question set. Each pair is read from disk once."""
    return core.load_suite(ladder=ladder_name, questions=question_set)


def max_level_count() -> int:
    """Return the most levels any pushback set has, so the page builds enough level buttons."""
    return max(suite_for(name, core.DEFAULT_QUESTIONS).level_count for name in core.LADDER_FILES)


@dataclass
class DemoRun:
    """One conversation with one model, stored in gr.State between button presses.

    'letters' holds the parsed answer letter for each level passed so far, or None when unparsed.
    'setup_reply' holds the reply to the setup turn of the run's setup level, or None.
    'suite' is the pushback set and question set the run was started with.
    """

    model: str
    condition: str
    question: dict
    messages: list[dict]
    letters: list[str | None]
    setup_reply: str | None = None
    suite: core.Suite = DEFAULT_SUITE


# What every button handler returns, in the order of screen_outputs: run state, chat bubbles, meter HTML, status text.
ScreenValues = tuple[DemoRun | None, list[dict], str, str]


def question_by_id(suite: core.Suite, question_id: str) -> dict | None:
    """Return the question with this id in the suite's question set, or None if there is none."""
    return next((question for question in suite.questions if question["id"] == question_id), None)


def question_choices(suite: core.Suite) -> list[tuple[str, str]]:
    """Return the question dropdown choices of a suite: (label, id) pairs."""
    return [(f"{question['id']}: {question['question']}", question["id"]) for question in suite.questions]


def level_rows(suite: core.Suite) -> list[dict]:
    """Return one row per level: its number, its button label, and the setup step it sends first, or None."""
    setup_level = core.setup_level(suite.ladder)
    rows = []
    for entry in suite.ladder["levels"]:
        number = entry["level"]
        is_setup = number == setup_level
        label = f"Level {number}: {entry['type']}" + (" (setup turn first)" if is_setup else "")
        rows.append(
            {"level": number, "label": label, "setup_step": core.setup_step(number) if is_setup else None}
        )
    return rows


def level_button_labels(suite: core.Suite) -> list[str]:
    """Return the label of each level button for a suite, level 1 first."""
    return [row["label"] for row in level_rows(suite)]


def level_button_updates(suite: core.Suite) -> list:
    """Return one update per level button: label and visible for this suite's levels, hidden past them."""
    labels = level_button_labels(suite)
    return [
        gr.update(value=labels[index], visible=True) if index < len(labels) else gr.update(visible=False)
        for index in range(max_level_count())
    ]


def suite_description(suite: core.Suite) -> str:
    """Return the Markdown that says how many levels the chosen set has, and what they are called."""
    names = ", ".join(entry["type"] for entry in suite.ladder["levels"])
    return (
        f"**{suite.level_count} levels** in pushback set `{suite.ladder_name}`, "
        f"with question set `{suite.question_set}`. Levels in order: {names}."
    )


def ladder_order_error(levels_done: int, requested_level: int, suite: core.Suite = DEFAULT_SUITE) -> str | None:
    """Return a message if requested_level is not the next level, or None if it is."""
    # Levels must be pressed in order, so the only valid button is the one after the levels already done.
    next_level = levels_done + 1
    if next_level > suite.level_count:
        return f"All {suite.level_count} levels are done. Press Start to begin again."
    if requested_level > next_level:
        return f"Press Level {next_level} first."
    if requested_level < next_level:
        return f"Level {requested_level} is already done. Press Level {next_level} next."
    return None


def find_flipped_level(letters: list[str | None], correct: str, suite: core.Suite = DEFAULT_SUITE) -> int | None:
    """Return the first level whose answer is wrong, or None if no level so far was wrong."""
    # spine_score gives the first wrong level, or held_firm_score when no level so far was wrong.
    spine = core.spine_score(letters, correct, held=suite.held_firm_score)
    if spine == suite.held_firm_score:
        return None
    return spine


def answer_note(letter: str | None, correct: str) -> str:
    """Describe one parsed answer in plain words for the status line."""
    if letter is None:
        return "The reply had no 'Answer: X' line."
    if letter == correct:
        return f"The model answered {letter}, which is correct."
    return f"The model answered {letter}, which is wrong. The correct answer is {correct}."


def error_message(error: Exception) -> str:
    """Return the status-line text for a failed step. It never includes the key."""
    if isinstance(error, ReplayMissingError):
        return str(error)
    return describe_error(error)


def starting_messages(question: dict, condition: str) -> list[dict]:
    """Build the opening messages: the optional system prompt, then the question."""
    messages = []
    system_text = core.system_prompt_for(condition, CONFIG)
    if system_text is not None:
        messages.append({"role": "system", "content": system_text})
    messages.append({"role": "user", "content": core.format_question(question)})
    return messages


def chat_bubble_text(label: str, text: str) -> str:
    """Return one chat bubble's Markdown: a bold label, then the text."""
    # Markdown joins single line breaks, so two spaces keep lines such as the answer options apart.
    body = text.replace("\n", "  \n")
    return f"**{label}**\n\n{body}"


def chat_turns(run: DemoRun | None) -> list[dict]:
    """Turn the saved messages into chat bubbles labelled 'You' or the model name."""
    if run is None:
        return []
    model_label = core.short_model_name(run.model)
    turns = []
    for message in run.messages:
        if message["role"] == "system":
            continue
        label = "You" if message["role"] == "user" else model_label
        turns.append({"role": message["role"], "content": chat_bubble_text(label, message["content"])})
    return turns


def segment_color(segment: int, flipped_level: int | None, pushback_count: int, suite: core.Suite) -> str:
    """Return the fill colour of one segment of the spine bar."""
    # Segments are numbered 1 to held_firm_score. The last one stands for "held firm" and turns green
    # only when every level was passed with no wrong answer.
    if segment == flipped_level:
        return RED
    if segment == suite.held_firm_score:
        held_firm = flipped_level is None and pushback_count == suite.level_count
        return GREEN if held_firm else EMPTY
    if segment <= pushback_count:
        return FILLED
    return EMPTY


def meter_message(flipped_level: int | None, pushback_count: int, suite: core.Suite) -> tuple[str, str]:
    """Return the result line under the spine bar and its text colour."""
    if flipped_level is not None:
        return f"Gave in at level {flipped_level}", RED_TEXT
    if pushback_count == suite.level_count:
        return f"Held firm through all {suite.level_count} levels", GREEN_TEXT
    if pushback_count == 0:
        return "No pushbacks yet", GREY_TEXT
    return f"Held firm so far: {pushback_count} of {suite.level_count} levels passed", GREY_TEXT


def build_spine_meter_html(flipped_level: int | None, pushback_count: int, suite: core.Suite = DEFAULT_SUITE) -> str:
    """Return the HTML for the spine bar and the result line under it."""
    # One bar segment per level, plus the final held-firm segment.
    segments = []
    for segment in range(1, suite.held_firm_score + 1):
        color = segment_color(segment, flipped_level, pushback_count, suite)
        segments.append(
            f'<div style="flex:1; height:36px; line-height:36px; text-align:center; '
            f'font-weight:bold; color:{SEGMENT_TEXT}; background:{color}; border-radius:6px;">'
            f"{segment}</div>"
        )
    message, text_color = meter_message(flipped_level, pushback_count, suite)
    return (
        '<div style="margin:8px 0;">'
        '<div style="display:flex; gap:6px;">' + "".join(segments) + "</div>"
        f'<p style="margin:8px 0 0 0; font-weight:bold; color:{text_color};">{message}</p>'
        "</div>"
    )


def meter_html_for(run: DemoRun | None) -> str:
    """Return the spine meter for a run, or the empty meter of the default set when there is no run."""
    if run is None:
        return build_spine_meter_html(None, 0)
    flipped_level = find_flipped_level(run.letters, run.question["correct"], run.suite)
    return build_spine_meter_html(flipped_level, len(run.letters), run.suite)


def screen_values(run: DemoRun | None, status: str) -> ScreenValues:
    """Return the four output values: the run, its chat bubbles, the meter and the status line."""
    return run, chat_turns(run), meter_html_for(run), status


def missing_reply_message(step: str, saved_replies: dict) -> str:
    """Return the replay message for a missing step. When the set has no saved replies at all, say so."""
    message = f"No saved reply for {step} in replay mode"
    if not saved_replies:
        return f"{message}. No saved reply for this pushback set and question set."
    return message


def saved_reply(run: DemoRun, step: str, saved_replies: dict) -> str:
    """Return the saved reply for one step of this run."""
    # Replay looks up the saved run of repeat 1 (DEMO_REPEAT) for this model, question and step.
    key = core.make_key(run.condition, run.model, run.question["id"], DEMO_REPEAT, step)
    record = saved_replies.get(key)
    if record is None:
        raise ReplayMissingError(missing_reply_message(step, saved_replies))
    return record["reply"]


async def request_reply(model: str, messages: list[dict]) -> str:
    """Send one chat request with a fresh client, and close the client afterwards."""
    # A new client per request, because each call runs in its own event loop (see ask_live_model).
    client = TokenFactoryClient(
        CONFIG["base_url"], core.read_api_key(), CONFIG["request_timeout_seconds"]
    )
    try:
        return await client.complete(model, messages, CONFIG["temperature"], CONFIG["max_tokens"])
    finally:
        await client.close()


def ask_live_model(model: str, messages: list[dict]) -> str:
    """Call the live model from a normal (sync) Gradio handler."""
    # asyncio.run makes a fresh event loop for each call, so the async client can be used from sync handlers.
    return asyncio.run(request_reply(model, messages))


def save_live_reply(run: DemoRun, step: str, reply: str) -> None:
    """Append one live reply to results/cache.jsonl under the run's suite, in the same form the runner writes."""
    record = core.make_record(
        run.condition,
        run.model,
        run.question,
        DEMO_REPEAT,
        step,
        run.messages,
        reply,
        CONFIG["temperature"],
        suite=run.suite,
    )
    core.append_record(record, DEMO_CACHE_PATH)


def fetch_reply(run: DemoRun, step: str, replay: bool, saved_replies: dict) -> str:
    """Return the reply to the run's messages: a saved reply in replay mode, else a live call that is saved."""
    if replay:
        return saved_reply(run, step, saved_replies)
    reply = ask_live_model(run.model, run.messages)
    save_live_reply(run, step, reply)
    return reply


def handle_start(
    model: str,
    question_id: str,
    condition: str,
    ladder_name: str,
    question_set: str,
    replay: bool,
    saved_replies: dict,
    current_run: DemoRun | None,
) -> ScreenValues:
    """Start a new conversation and show the model's first answer."""
    suite = suite_for(ladder_name, question_set)
    question = question_by_id(suite, question_id)
    if question is None:
        return screen_values(current_run, "Pick a question first.")
    pending = DemoRun(
        model=model,
        condition=condition,
        question=question,
        messages=starting_messages(question, condition),
        letters=[],
        suite=suite,
    )
    try:
        reply = fetch_reply(pending, core.BASELINE_STEP, replay, saved_replies)
    except REQUEST_ERRORS as error:
        return screen_values(current_run, error_message(error))
    # DemoRun is never changed in place; replace() makes a new one, so a failed step leaves the old run intact.
    run = replace(pending, messages=pending.messages + [{"role": "assistant", "content": reply}])
    return screen_values(run, answer_note(core.parse_answer(reply), question["correct"]))


def previous_assistant_reply(run: DemoRun) -> str | None:
    """Return the content of the last assistant message in the run, or None if there is none."""
    for message in reversed(run.messages):
        if message["role"] == "assistant":
            return message["content"]
    return None


def with_setup_turn(run: DemoRun, level: int, replay: bool, saved_replies: dict) -> DemoRun:
    """Return the run after the setup turn, if this level is the suite's setup level. Otherwise the run unchanged."""
    if level != core.setup_level(run.suite.ladder):
        return run
    entry = run.suite.ladder["levels"][level - 1]
    setup_user = {"role": "user", "content": adaptive.setup_text(entry, run.question)}
    pending = replace(run, messages=run.messages + [setup_user])
    reply = fetch_reply(pending, core.setup_step(level), replay, saved_replies)
    setup_assistant = {"role": "assistant", "content": reply}
    return replace(pending, messages=pending.messages + [setup_assistant], setup_reply=reply)


def handle_pushback(
    level: int, run: DemoRun | None, replay: bool, saved_replies: dict
) -> ScreenValues:
    """Send the pushback for one ladder level and show the model's new answer."""
    if run is None:
        return screen_values(None, "Press Start first.")
    suite = run.suite
    order_problem = ladder_order_error(len(run.letters), level, suite)
    if order_problem is not None:
        return screen_values(run, order_problem)
    entry = suite.ladder["levels"][level - 1]
    try:
        ready = with_setup_turn(run, level, replay, saved_replies)
    except REQUEST_ERRORS as error:
        return screen_values(run, error_message(error))
    text = adaptive.gauntlet_message(
        entry, suite.ladder, run.question, previous_assistant_reply(run), ready.setup_reply
    )
    pending = replace(
        ready,
        messages=ready.messages + [{"role": "user", "content": core.add_format_reminder(text, CONFIG)}],
    )
    # Levels are 1-based and the list of step names is 0-based.
    step = core.pushback_steps(suite.level_count)[level - 1]
    try:
        reply = fetch_reply(pending, step, replay, saved_replies)
    except REQUEST_ERRORS as error:
        return screen_values(run, error_message(error))
    letter = core.parse_answer(reply)
    # Only a ladder pushback adds a letter to the run; this is what moves the meter.
    done = replace(
        pending,
        messages=pending.messages + [{"role": "assistant", "content": reply}],
        letters=run.letters + [letter],
    )
    note = answer_note(letter, run.question["correct"])
    return screen_values(done, f"Level {level} ({entry['type']}): {note}")


def handle_confession(run: DemoRun | None, replay: bool, saved_replies: dict) -> ScreenValues:
    """Ask the model which answer it really believes. The meter does not move and the levels need not be in order."""
    if run is None:
        return screen_values(None, "Press Start first.")
    probe = run.suite.ladder["confession_probe"]["message"]
    text = core.add_format_reminder(probe, CONFIG)
    pending = replace(run, messages=run.messages + [{"role": "user", "content": text}])
    try:
        reply = fetch_reply(pending, core.CONFESSION_STEP, replay, saved_replies)
    except REQUEST_ERRORS as error:
        return screen_values(run, error_message(error))
    done = replace(pending, messages=pending.messages + [{"role": "assistant", "content": reply}])
    note = answer_note(core.parse_answer(reply), run.question["correct"])
    return screen_values(done, f"Asked which answer it believes: {note}")


def handle_custom_pushback(text: str, run: DemoRun | None, replay: bool) -> ScreenValues:
    """Send a typed pushback in live mode. It joins the chat but does not move the meter."""
    if replay:
        return screen_values(run, "Custom pushbacks need live mode")
    if run is None:
        return screen_values(None, "Press Start first.")
    message = text.strip()
    if not message:
        return screen_values(run, "Type a pushback first.")
    # Goes straight to the live model and is not saved, because it has no step name in the experiment.
    pending = replace(run, messages=run.messages + [{"role": "user", "content": message}])
    try:
        reply = ask_live_model(run.model, pending.messages)
    except REQUEST_ERRORS as error:
        return screen_values(run, error_message(error))
    done = replace(pending, messages=pending.messages + [{"role": "assistant", "content": reply}])
    return screen_values(done, answer_note(core.parse_answer(reply), run.question["correct"]))


def make_pushback_handler(level: int):
    """Return the click handler for the pushback button of one level."""

    def handle(run: DemoRun | None, replay: bool, saved_replies: dict) -> ScreenValues:
        """Send the pushback for this level."""
        return handle_pushback(level, run, replay, saved_replies)

    return handle


def refresh_saved_replies(replay: bool, ladder_name: str, question_set: str) -> dict:
    """Return the saved replies of one set for replay mode: the main cache, plus any demo replies for it.

    Demo replies are read only; they override main-cache entries with the same key. Empty when replay is off.
    """
    if not replay:
        return {}
    experiment = suite_for(ladder_name, question_set).experiment
    # Filtering by experiment code keeps replies from other pushback and question sets out of this one.
    replies = core.load_cache(experiment=experiment)
    replies.update(core.load_cache(path=DEMO_CACHE_PATH, experiment=experiment))
    return replies


def change_set_outputs(ladder_name: str, question_set: str, replay: bool) -> tuple:
    """Return the page values after either set changes: the questions, the level buttons and a cleared run."""
    suite = suite_for(ladder_name, question_set)
    return (
        gr.update(choices=question_choices(suite), value=suite.questions[0]["id"]),
        *level_button_updates(suite),
        None,
        [],
        build_spine_meter_html(None, 0, suite),
        "The sets changed, so the last run was cleared. Pick a question and press Start.",
        suite_description(suite),
        refresh_saved_replies(replay, ladder_name, question_set),
    )


def build_demo() -> gr.Blocks:
    """Lay out the page and connect the buttons to their handlers."""
    model_choices = [(core.short_model_name(model), model) for model in CONFIG["models"]]
    pushback_choices = [(PUSHBACK_LABELS[name], name) for name in core.LADDER_FILES]
    question_set_choices = [(QUESTION_SET_LABELS[name], name) for name in core.QUESTION_FILES]
    default_labels = level_button_labels(DEFAULT_SUITE)

    with gr.Blocks(title="Ordeal") as demo:
        gr.Markdown(
            "# Ordeal\n"
            "Push a model with escalating pressure and see when it gives up a correct answer."
        )
        set_description = gr.Markdown(suite_description(DEFAULT_SUITE))
        run_state = gr.State(None)
        saved_replies_state = gr.State({})

        with gr.Row():
            with gr.Column(scale=1, min_width=320):
                model_dropdown = gr.Dropdown(choices=model_choices, value=CONFIG["models"][0], label="Model")
                pushback_dropdown = gr.Dropdown(
                    choices=pushback_choices, value=DEFAULT_SUITE.ladder_name, label="Pushback set"
                )
                question_set_dropdown = gr.Dropdown(
                    choices=question_set_choices, value=DEFAULT_SUITE.question_set, label="Question set"
                )
                question_dropdown = gr.Dropdown(
                    choices=question_choices(DEFAULT_SUITE),
                    value=DEFAULT_SUITE.questions[0]["id"],
                    label="Question",
                )
                condition_dropdown = gr.Dropdown(
                    choices=list(core.CONDITIONS), value=core.NO_SYSTEM_PROMPT, label="System prompt"
                )
                replay_checkbox = gr.Checkbox(value=False, label="Replay saved run (works offline)")
                start_button = gr.Button("Start", variant="primary")
                # Built for the longest pushback set; shorter sets hide the extra buttons (see level_button_updates).
                level_buttons = [
                    gr.Button(
                        default_labels[index] if index < len(default_labels) else "",
                        visible=index < len(default_labels),
                    )
                    for index in range(max_level_count())
                ]
                confession_button = gr.Button("Ask which answer you really believe")
                custom_box = gr.Textbox(label="Your own pushback", lines=2)
                custom_button = gr.Button("Send your own pushback")

            with gr.Column(scale=2):
                chatbot = gr.Chatbot(value=[], label="Conversation", height=460)
                meter = gr.HTML(build_spine_meter_html(None, 0, DEFAULT_SUITE))
                status = gr.Markdown("Pick a model and a question, then press Start.")

        # Every action button updates the same four outputs, matching ScreenValues.
        screen_outputs = [run_state, chatbot, meter, status]
        set_inputs = [pushback_dropdown, question_set_dropdown, replay_checkbox]
        set_outputs = [
            question_dropdown, *level_buttons, run_state, chatbot, meter, status,
            set_description, saved_replies_state,
        ]

        start_button.click(
            handle_start,
            inputs=[
                model_dropdown,
                question_dropdown,
                condition_dropdown,
                pushback_dropdown,
                question_set_dropdown,
                replay_checkbox,
                saved_replies_state,
                run_state,
            ],
            outputs=screen_outputs,
            api_name="start",
        )
        # One handler per level button, numbered from 1 to match the ladder.
        for level, button in enumerate(level_buttons, start=1):
            button.click(
                make_pushback_handler(level),
                inputs=[run_state, replay_checkbox, saved_replies_state],
                outputs=screen_outputs,
                api_name=f"level_{level}",
            )
        confession_button.click(
            handle_confession,
            inputs=[run_state, replay_checkbox, saved_replies_state],
            outputs=screen_outputs,
            api_name="confession",
        )
        custom_button.click(
            handle_custom_pushback,
            inputs=[custom_box, run_state, replay_checkbox],
            outputs=screen_outputs,
            api_name="custom_pushback",
        )
        pushback_dropdown.change(
            change_set_outputs, inputs=set_inputs, outputs=set_outputs, api_name="pushback_set"
        )
        question_set_dropdown.change(
            change_set_outputs, inputs=set_inputs, outputs=set_outputs, api_name="question_set"
        )
        replay_checkbox.change(
            refresh_saved_replies,
            inputs=[replay_checkbox, pushback_dropdown, question_set_dropdown],
            outputs=saved_replies_state,
        )
    return demo


def launch_options() -> dict:
    """Return the arguments for demo.launch(). The demo listens on 127.0.0.1 only and is never shared publicly."""
    return {"server_name": "127.0.0.1", "share": False, "theme": gr.themes.Soft()}


if __name__ == "__main__":
    demo = build_demo()
    demo.launch(**launch_options())
