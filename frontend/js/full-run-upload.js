// Loading saved replies from a replies file (cache.jsonl) into this browser as saved batch runs. The file has one line per
// saved reply, and a file can hold replies from several experiments, suites and conditions. Replies are grouped by
// experiment, suite and condition, and each group becomes one run in the same shape the Batch page saves its own runs,
// so the Runs list and Resume show it the way they show a run made on the web. A group whose suite the site does not
// offer is reported and not saved. The file is read in pieces, so a large file is not held as one string. This file
// does no DOM work.

import { importRunDocument, listRuns } from "./store/run-store.js";
import { KIND_BATCH, unitKeyFor, unitPayload } from "./saved-runs.js";
import { setsOfChoice } from "./suites.js";
import { CONDITIONS, FULL_RUN_EXPERIMENT, FULL_RUN_SUITE } from "./full-run-summary.js";

/**
 * Turn one line of the replies file into the record a saved run keeps for a step, with the experiment and suite it
 * came from. The step's text is the last user message in the conversation the model was sent.
 */
export function parseReplyLine(line) {
  const row = JSON.parse(line);
  const userMessages = (row.messages ?? []).filter((message) => message.role === "user");
  const lastUser = userMessages.length > 0 ? userMessages[userMessages.length - 1].content : "";
  return {
    experiment: row.experiment ?? "",
    suite: row.suite ?? "",
    condition: row.condition,
    model: row.model,
    question_id: row.question_id,
    repeat: row.repeat,
    step: row.step,
    reply: row.reply,
    user_text: lastUser,
  };
}

/** Add one line to the group of its experiment, suite and condition. Blank lines are skipped. */
function addReplyLine(groups, line) {
  if (line.trim() === "") return;
  const reply = parseReplyLine(line);
  const key = JSON.stringify([reply.experiment, reply.suite, reply.condition]);
  if (!groups.has(key)) {
    groups.set(key, { experiment: reply.experiment, suite: reply.suite, condition: reply.condition, replies: [] });
  }
  groups.get(key).replies.push(reply);
}

/**
 * Read the replies file in pieces and return its groups, in the order they first appear. A line can be cut across two
 * pieces, so the unfinished end of each piece is kept until the next piece arrives.
 */
export async function readReplyGroups(file) {
  const groups = new Map();
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
  let unfinished = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const lines = (unfinished + value).split("\n");
    unfinished = lines.pop();
    for (const line of lines) addReplyLine(groups, line);
  }
  addReplyLine(groups, unfinished);
  return [...groups.values()];
}

/**
 * Work out the shape of a group's runs from its replies: the models and questions in the order they first appear, and
 * the number of repeats, which is the largest repeat number.
 */
export function runShape(replies) {
  return {
    models: [...new Set(replies.map((reply) => reply.model))],
    questions: [...new Set(replies.map((reply) => reply.question_id))],
    repeats: Math.max(...replies.map((reply) => reply.repeat)),
  };
}

/** Return the name of a condition as people read it, or the file's own name when it is not one of the full run's four. */
function conditionLabel(condition) {
  const known = CONDITIONS.find((item) => item.folder === condition);
  return known === undefined ? condition : known.label;
}

/** Return how many units a group holds: distinct model, question and repeat combinations under one condition. */
export function unitCount(group) {
  return new Set(group.replies.map((reply) => unitKeyFor(reply.model, reply.question_id, reply.repeat))).size;
}

/**
 * Return the label of a group's run. The full run keeps its name, such as "Full run: Control". Any other experiment is
 * named by its suite, its condition and the start of its experiment id. Every label ends with the unit count, so a
 * file with more replies for the same experiment and condition gets its own run, and loading the same file again is
 * still recognised by its label.
 */
export function groupLabel(group) {
  const count = unitCount(group);
  const units = count === 1 ? "1 unit" : `${count} units`;
  if (group.experiment === FULL_RUN_EXPERIMENT && group.suite === FULL_RUN_SUITE) {
    return `Full run: ${conditionLabel(group.condition)} · ${units}`;
  }
  return `${group.suite} ${conditionLabel(group.condition)} (${group.experiment.slice(0, 6)}) · ${units}`;
}

/**
 * Turn one group's replies into the input of a saved run: its config, its planned units and its saved results. Planned
 * units are only the units that have replies in the file, so a unit the original run never finished has no reply and
 * is not planned. The run is marked stopped, so Resume is offered, and every planned unit is already saved, so Resume
 * shows the results without sending anything.
 */
export function buildRunInput(group, settings) {
  const shape = runShape(group.replies);
  const units = new Map();
  for (const reply of group.replies) {
    const key = unitKeyFor(reply.model, reply.question_id, reply.repeat);
    if (!units.has(key)) units.set(key, []);
    units.get(key).push(reply);
  }
  const results = {};
  for (const [key, unitReplies] of units) {
    results[key] = unitPayload(unitReplies);
  }
  return {
    label: groupLabel(group),
    status: "stopped",
    plannedUnits: [...units.keys()],
    results,
    config: {
      kind: KIND_BATCH,
      pushbackSet: settings.pushbackSet,
      questionSet: settings.questionSet,
      experiment: null,
      models: shape.models,
      questions: shape.questions,
      families: [],
      repeats: shape.repeats,
      condition: group.condition,
      concurrency: 1,
      callCap: settings.callCap,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
    },
  };
}

/**
 * Save one run for each group in the file. A group whose suite the site does not offer is skipped with its reason. A
 * group whose run is already in this browser is skipped too, so loading the same file twice does not make duplicates.
 * The common settings are the call cap, temperature and max tokens. Returns the labels saved and the labels skipped.
 */
export async function importReplyGroups(adapter, groups, common) {
  const existingLabels = new Set((await listRuns(adapter)).map((run) => run.label));
  const saved = [];
  const skipped = [];
  for (const group of groups) {
    const label = groupLabel(group);
    if (group.replies.length === 0) {
      skipped.push(`${label} (no replies)`);
      continue;
    }
    if (existingLabels.has(label)) {
      skipped.push(`${label} (already in this browser)`);
      continue;
    }
    let sets;
    try {
      sets = setsOfChoice(group.suite);
    } catch {
      skipped.push(`${label} (suite ${group.suite} is not one this site offers)`);
      continue;
    }
    await importRunDocument(adapter, buildRunInput(group, { ...common, ...sets }));
    existingLabels.add(label);
    saved.push(label);
  }
  return { saved, skipped };
}
