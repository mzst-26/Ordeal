// Decides which messages are sent for one unit (one model, one question, one repeat), and in what order.
// This is the browser port of flows.py, so it must send exactly the same steps and messages.
// Nothing here calls the network. The caller passes an async ask(step, messages) that returns the
// reply text, or null when the call failed for good. Every flow stops at the first null.
import {
  BASELINE_STEP,
  CONFESSION_STEP,
  CORRECTION_STEPS,
  CORRECTION_VARIANT_BY_STEP,
  addFormatReminder,
  pushbackSteps,
  axisProbeStep,
  correctionMessage,
  doseProbeStep,
  formatQuestion,
  isCorrect,
  parseAnswer,
  probeSetupStep,
  setupStep,
  twinProbeStep,
} from "./rules.js";
import {
  axisMessage,
  doseMessage,
  extractQuote,
  finalAsk,
  forgedReply,
  gauntletMessage,
  probeSetupText,
  setupText,
} from "./adaptive.js";

export const GAUNTLET = "gauntlet";
export const CORRECTIONS = "corrections";
export const FINGERPRINT = "fingerprint";
export const TWINS = "twins";
export const DOSE = "dose";
// Frozen array of every family name. Freezing an array stops items being added or removed.
export const ALL_FAMILIES = Object.freeze([GAUNTLET, CORRECTIONS, FINGERPRINT, TWINS, DOSE]);

/** Return a new Set of every family name. Changing the Set does not change ALL_FAMILIES. */
export function allFamilies() {
  return new Set(ALL_FAMILIES);
}

const TAMPERED_AXIS_ID = "tampered_history";
const LETTER_PLACEHOLDER = "{X_letter}";
// v4 gives the tampered-history texts only inside its forge note, as quoted text after "with:" and "ask:".
const FORGED_REPLY_PATTERN = /with: '([^']+)'/;
const FINAL_ASK_PATTERN = /ask: '([^']+)'/;

/** Thrown when ask returns null, so that the rest of the unit is not sent. Not exported. */
class AskFailed extends Error {}

/** Return a user message. */
function userTurn(text) {
  return { role: "user", content: text };
}

/** Return an assistant message. */
function assistantTurn(text) {
  return { role: "assistant", content: text };
}

/** Return an assistant message that states the pushed wrong answer. */
function plantedWrongTurn(question) {
  return assistantTurn(`Answer: ${question.pushed_wrong}`);
}

/** Return the opening messages: the system prompt when there is one, then the question. */
function buildFirstMessages(question, systemPrompt) {
  const messages = [];
  if (systemPrompt !== null && systemPrompt !== undefined) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push(userTurn(formatQuestion(question)));
  return messages;
}

/** Call ask and return its reply. Throw AskFailed when ask returns null. */
async function send(ask, step, messages) {
  const reply = await ask(step, messages);
  if (reply === null) {
    throw new AskFailed(step);
  }
  return reply;
}

/**
 * Return the tampered-history axis with forgedReply and finalAsk set, read from its forge note when needed.
 * Mirrors flows.tampered_axis in flows.py. Throws when the note does not hold both texts.
 */
export function tamperedAxis(axis) {
  if ("forged_reply" in axis) {
    return axis;
  }
  const note = axis.forge ?? "";
  const reply = note.match(FORGED_REPLY_PATTERN);
  const ask = note.match(FINAL_ASK_PATTERN);
  if (reply === null || ask === null) {
    throw new Error(`Axis '${axis.id}' needs forged_reply and final_ask, or a forge note with both texts.`);
  }
  return { ...axis, forged_reply: reply[1], final_ask: ask[1] };
}

/**
 * Return the axis with {X_letter} replaced by the letter of the slot's option. Only v4's format squeeze uses it.
 * Mirrors flows.axis_for_slot in flows.py.
 */
export function axisForSlot(axis, question, slot) {
  const message = axis.message ?? "";
  if (!message.includes(LETTER_PLACEHOLDER)) {
    return axis;
  }
  const letter = slot === "wrong" ? question.pushed_wrong : question.correct;
  return { ...axis, message: message.split(LETTER_PLACEHOLDER).join(letter) };
}

/** Return the step names of the gauntlet: every level, each setup turn, then the confession. */
function gauntletSteps(ladder) {
  const steps = pushbackSteps(ladder.levels.length);
  for (const entry of ladder.levels) {
    if (entry.setup_turn) {
      steps.push(setupStep(entry.level));
    }
  }
  steps.push(CONFESSION_STEP);
  return steps;
}

/** Return the step names of single-shot probes, each followed by its setup step when it has one. */
function probeSteps(axes, stepNameOf) {
  const steps = [];
  for (const axis of axes) {
    const step = stepNameOf(axis.id);
    steps.push(step);
    if (axis.setup_turn) {
      steps.push(probeSetupStep(step));
    }
  }
  return steps;
}

/** Return the probe axes that have a valid twin, in file order. */
function twinAxes(probeSpec) {
  return probeSpec.axes.filter((axis) => axis.twin);
}

/** Return the step names of every dose on every dial, in file order. */
function doseSteps(doses) {
  const steps = [];
  for (const [dialName, dial] of Object.entries(doses)) {
    for (let index = 1; index <= dial.levels.length; index += 1) {
      steps.push(doseProbeStep(dialName, index));
    }
  }
  return steps;
}

/**
 * Return every step name the flows may send for this unit. Some may be skipped at run time.
 * families is a Set or the ALL_FAMILIES array of family names. baselineCorrect is true, false or null (unknown).
 */
export function expectedSteps(question, families, ladder, probeSpec, baselineCorrect) {
  const enabled = new Set(families);
  const steps = [BASELINE_STEP];
  // Families that need a correct baseline are kept when the baseline is correct or unknown.
  const baselineNotWrong = baselineCorrect !== false;
  if (enabled.has(GAUNTLET) && baselineNotWrong) {
    steps.push(...gauntletSteps(ladder));
  }
  if (enabled.has(CORRECTIONS) && question.correction_test) {
    steps.push(...CORRECTION_STEPS);
  }
  if (enabled.has(FINGERPRINT) && baselineNotWrong) {
    steps.push(...probeSteps(probeSpec.axes, axisProbeStep));
  }
  if (enabled.has(TWINS) && baselineNotWrong) {
    steps.push(...probeSteps(twinAxes(probeSpec), twinProbeStep));
  }
  if (enabled.has(DOSE) && baselineNotWrong) {
    steps.push(...doseSteps(probeSpec.doses));
  }
  return steps;
}

/** Return true when any answered level gave a letter other than the correct one. */
function modelFlipped(letters, question) {
  return letters.some((letter) => letter !== null && letter !== question.correct);
}

/** Send the one-turn setup before a gauntlet level. Return the new conversation and the setup reply. */
async function runGauntletSetup(ask, conversation, question, entry) {
  const text = setupText(entry, question);
  const reply = await send(ask, setupStep(entry.level), [...conversation, userTurn(text)]);
  return { conversation: [...conversation, userTurn(text), assistantTurn(reply)], reply };
}

/** Send the ten pressure levels in one conversation, then the confession check if the model flipped. */
async function runGauntlet(ask, firstMessages, question, baselineReply, ladder, config) {
  let conversation = [...firstMessages, assistantTurn(baselineReply)];
  let previousReply = baselineReply;
  let setupReply = null;
  const letters = [];
  const pushback = pushbackSteps(ladder.levels.length);
  for (const entry of ladder.levels) {
    if (entry.setup_turn) {
      const setup = await runGauntletSetup(ask, conversation, question, entry);
      conversation = setup.conversation;
      setupReply = setup.reply;
    }
    const message = gauntletMessage(entry, ladder, question, previousReply, setupReply);
    const text = addFormatReminder(message, config.answer_format_reminder);
    const reply = await send(ask, pushback[entry.level - 1], [...conversation, userTurn(text)]);
    conversation = [...conversation, userTurn(text), assistantTurn(reply)];
    previousReply = reply;
    letters.push(parseAnswer(reply));
  }
  if (modelFlipped(letters, question)) {
    const confession = addFormatReminder(ladder.confession_probe.message, config.answer_format_reminder);
    await send(ask, CONFESSION_STEP, [...conversation, userTurn(confession)]);
  }
}

/** Send each correction message after the planted wrong answer. */
async function runCorrections(ask, firstMessages, question, config) {
  for (const step of CORRECTION_STEPS) {
    const variant = CORRECTION_VARIANT_BY_STEP[step];
    const correction = correctionMessage(variant, question, config);
    await send(ask, step, [...firstMessages, plantedWrongTurn(question), userTurn(correction)]);
  }
}

/** Send the setup turn of a single-shot probe. Return the opening with that turn and its reply added. */
async function runProbeSetup(ask, step, opening, axis) {
  const text = probeSetupText(axis);
  const reply = await send(ask, probeSetupStep(step), [...opening, userTurn(text)]);
  return [...opening, userTurn(text), assistantTurn(reply)];
}

/** Send one single-shot probe, after its setup turn when the axis has one. */
async function sendProbe(ask, step, opening, axis, text, config) {
  let messages = opening;
  if (axis.setup_turn) {
    messages = await runProbeSetup(ask, step, opening, axis);
  }
  const finalText = addFormatReminder(text, config.answer_format_reminder);
  await send(ask, step, [...messages, userTurn(finalText)]);
}

/** Send the probe whose earlier model reply was edited, then ask which answer it stands by. */
async function runTamperedHistory(ask, firstMessages, question, rawAxis, config) {
  const axis = tamperedAxis(rawAxis);
  const opening = [...firstMessages, assistantTurn(forgedReply(axis, question))];
  await sendProbe(ask, axisProbeStep(axis.id), opening, axis, finalAsk(axis), config);
}

/** Send one single-shot probe per axis of the probe spec, in file order. */
async function runFingerprint(ask, firstMessages, question, baselineReply, ladder, probeSpec, config) {
  const quote = extractQuote(baselineReply);
  for (const axis of probeSpec.axes) {
    if (axis.id === TAMPERED_AXIS_ID) {
      await runTamperedHistory(ask, firstMessages, question, axis, config);
    } else {
      const text = axisMessage(axisForSlot(axis, question, "wrong"), ladder, question, "wrong", quote);
      if (text !== null) {
        const opening = [...firstMessages, assistantTurn(baselineReply)];
        await sendProbe(ask, axisProbeStep(axis.id), opening, axis, text, config);
      }
    }
  }
}

/** Send the twin probe of each twin axis, after a planted wrong answer, with the right option's text. */
async function runTwins(ask, firstMessages, question, baselineReply, ladder, probeSpec, config) {
  const planted = [...firstMessages, plantedWrongTurn(question)];
  const quote = extractQuote(baselineReply);
  for (const axis of twinAxes(probeSpec)) {
    const text = axisMessage(axisForSlot(axis, question, "right"), ladder, question, "right", quote);
    if (text !== null) {
      await sendProbe(ask, twinProbeStep(axis.id), planted, axis, text, config);
    }
  }
}

/** Send every dose of every dial, each after the model's correct baseline answer. */
async function runDose(ask, firstMessages, question, baselineReply, probeSpec, config) {
  const opening = [...firstMessages, assistantTurn(baselineReply)];
  for (const [dialName, dial] of Object.entries(probeSpec.doses)) {
    for (let index = 1; index <= dial.levels.length; index += 1) {
      const text = addFormatReminder(doseMessage(dial, index, question), config.answer_format_reminder);
      await send(ask, doseProbeStep(dialName, index), [...opening, userTurn(text)]);
    }
  }
}

/**
 * Send the flows of one unit that apply, in order. Stop the whole unit at the first call that fails.
 * families is a Set or the ALL_FAMILIES array of family names. The returned promise resolves when the flows are done.
 */
export async function runFlows(question, systemPrompt, baselineReply, ask, families, ladder, probeSpec, config) {
  const enabled = new Set(families);
  const firstMessages = buildFirstMessages(question, systemPrompt);
  const baselineCorrect = isCorrect(baselineReply, question);
  try {
    if (enabled.has(GAUNTLET) && baselineCorrect) {
      await runGauntlet(ask, firstMessages, question, baselineReply, ladder, config);
    }
    if (enabled.has(CORRECTIONS) && question.correction_test) {
      await runCorrections(ask, firstMessages, question, config);
    }
    if (enabled.has(FINGERPRINT) && baselineCorrect) {
      await runFingerprint(ask, firstMessages, question, baselineReply, ladder, probeSpec, config);
    }
    if (enabled.has(TWINS) && baselineCorrect) {
      await runTwins(ask, firstMessages, question, baselineReply, ladder, probeSpec, config);
    }
    if (enabled.has(DOSE) && baselineCorrect) {
      await runDose(ask, firstMessages, question, baselineReply, probeSpec, config);
    }
  } catch (error) {
    // A null reply is a normal stop. Any other error is a real bug, so it is passed on.
    if (!(error instanceof AskFailed)) {
      throw error;
    }
  }
}
