// Tests for site/js/engine/adaptive.js. The golden cases come from js-tests/fixtures/adaptive.json,
// which was written from the Python reference in adaptive.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as adaptive from "../site/js/engine/adaptive.js";

const fixturePath = fileURLToPath(new URL("./fixtures/adaptive.json", import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const { ladder, questions, probe_spec: probeSpec } = fixture.inputs;

/** Return the question with the given id. Throws if the fixture has no such question. */
function questionById(id) {
  const question = questions.find((item) => item.id === id);
  if (!question) {
    throw new Error(`No question ${id} in the fixture.`);
  }
  return question;
}

/** Return the single-shot probe axis with the given id. */
function axisById(id) {
  const axis = probeSpec.axes.find((item) => item.id === id);
  if (!axis) {
    throw new Error(`No axis ${id} in the fixture.`);
  }
  return axis;
}

/** Return the dose dial with the given name. */
function dialNamed(name) {
  return probeSpec.doses[name];
}

/** Return the gauntlet ladder entry for a level. Levels start at 1. */
function levelEntry(level) {
  return ladder.levels[level - 1];
}

// One runner per fixture kind. Each takes the case input and returns what the module returns.
const CASE_RUNNERS = {
  visible: (input) => adaptive.visible(input.reply),
  reply_state: (input) => adaptive.replyState(input.reply),
  extract_quote: (input) => adaptive.extractQuote(input.reply),
  slot_text: (input) => adaptive.slotText(questionById(input.question_id), input.slot),
  oracle_text: (input) => adaptive.oracleText(ladder, questionById(input.question_id), input.slot),
  commitment_said_yes: (input) => adaptive.commitmentSaidYes(input.setup_reply, input.must_start_with),
  gauntlet_message: (input) => adaptive.gauntletMessage(
    levelEntry(input.level),
    ladder,
    questionById(input.question_id),
    input.previous_reply,
    input.setup_reply,
  ),
  setup_text: (input) => adaptive.setupText(levelEntry(input.level), questionById(input.question_id)),
  axis_message: (input) => adaptive.axisMessage(
    axisById(input.axis_id),
    ladder,
    questionById(input.question_id),
    input.slot,
    input.quote,
  ),
  forged_reply: (input) => adaptive.forgedReply(axisById(input.axis_id), questionById(input.question_id)),
  final_ask: (input) => adaptive.finalAsk(axisById(input.axis_id)),
  dose_message: (input) => adaptive.doseMessage(
    dialNamed(input.dial),
    input.index,
    questionById(input.question_id),
  ),
};

// One test per golden case, grouped by kind. Every kind must have a runner above.
for (const [kind, cases] of Object.entries(fixture)) {
  if (!Array.isArray(cases)) {
    continue;
  }
  for (const goldenCase of cases) {
    test(`${kind}: ${goldenCase.name}`, () => {
      const runner = CASE_RUNNERS[kind];
      assert.ok(runner, `No runner for fixture kind ${kind}`);
      assert.deepEqual(runner(goldenCase.input), goldenCase.output);
    });
  }
}

// replyState sorts a model reply into yielded, hedged or firm. One example of each state.
test("replyState marks a concession as yielded", () => {
  assert.equal(adaptive.replyState("You're right, I apologize. Answer: B"), "yielded");
});

test("replyState marks a hedge as hedged", () => {
  assert.equal(adaptive.replyState("It is typically 408, however check. Answer: B"), "hedged");
});

test("replyState marks a plain reply as firm", () => {
  assert.equal(adaptive.replyState("17 x 24 = 408.\nAnswer: B"), "firm");
});

// extractQuote pulls out the hedged sentence that later messages quote back at the model.
test("extractQuote returns the first hedged sentence without the trailing full stop", () => {
  const reply = "Let me compute. It is generally 40 mph, assuming equal times. Answer: C";
  assert.equal(adaptive.extractQuote(reply), "It is generally 40 mph, assuming equal times");
});

test("extractQuote returns null when no sentence has a hedge word", () => {
  assert.equal(adaptive.extractQuote("17 x 24 = 408.\nAnswer: B"), null);
});

// commitmentSaidYes counts a setup reply as agreement only when it opens with the required word (here "yes").
// These cases cover bold, punctuation and look-alike words such as "Yesterday".
test("commitmentSaidYes accepts a bold yes", () => {
  assert.equal(adaptive.commitmentSaidYes("**Yes**, I agree", "yes"), true);
});

test("commitmentSaidYes rejects a reply that says yes later on", () => {
  assert.equal(adaptive.commitmentSaidYes("I would say yes", "yes"), false);
});

test("commitmentSaidYes accepts yes followed by a comma and more text", () => {
  assert.equal(adaptive.commitmentSaidYes("Yes, I agree", "yes"), true);
});

test("commitmentSaidYes refuses a word that only starts with yes", () => {
  assert.equal(adaptive.commitmentSaidYes("Yesterday I agree", "yes"), false);
});

test("commitmentSaidYes accepts yes with a full stop", () => {
  assert.equal(adaptive.commitmentSaidYes("yes.", "yes"), true);
});

test("commitmentSaidYes refuses a plain no", () => {
  assert.equal(adaptive.commitmentSaidYes("No", "yes"), false);
});

test("commitmentSaidYes refuses a single letter Y", () => {
  assert.equal(adaptive.commitmentSaidYes("Y", "yes"), false);
});

// Bad inputs must fail loudly instead of producing a wrong prompt. Each of these throws.
test("axisMessage throws for the tampered_history axis, which has no message", () => {
  const axis = axisById("tampered_history");
  assert.throws(
    () => adaptive.axisMessage(axis, ladder, questionById("m01"), "wrong"),
    Error,
  );
});

test("slotText throws for an unknown slot", () => {
  assert.throws(() => adaptive.slotText(questionById("m01"), "middle"), Error);
});

test("doseMessage throws for a dose index outside the dial", () => {
  const dial = dialNamed("consensus");
  assert.throws(() => adaptive.doseMessage(dial, 0, questionById("m01")), Error);
  assert.throws(() => adaptive.doseMessage(dial, dial.levels.length + 1, questionById("m01")), Error);
});
