// Loading a full run from its replies file (cache.jsonl) into this browser as saved batch runs. The file has one line per
// saved reply. Each condition becomes one run, in the same shape the Batch page saves its own runs, so the Runs list and
// Resume show it the way they show a run made on the web. The file is read in pieces, so a file of more than 100 MB
// does not have to be held as one string. This file does no DOM work.

import { importRunDocument, listRuns } from "./store/run-store.js";
import { KIND_BATCH, unitKeyFor, unitPayload } from "./saved-runs.js";
import { CONDITIONS } from "./full-run-summary.js";

/**
 * Turn one line of the replies file into the record a saved run keeps for a step. The step's prompt is the last user
 * message in the conversation the model was sent, which is the message the saved run shows as the step's text.
 */
export function parseReplyLine(line) {
  const row = JSON.parse(line);
  const userMessages = (row.messages ?? []).filter((message) => message.role === "user");
  const lastUser = userMessages.length > 0 ? userMessages[userMessages.length - 1].content : "";
  return {
    condition: row.condition,
    model: row.model,
    question_id: row.question_id,
    repeat: row.repeat,
    step: row.step,
    reply: row.reply,
    user_text: lastUser,
  };
}

/** Add one line to the replies of its condition. Blank lines are skipped, so the last line of a file may be empty. */
function addReplyLine(byCondition, line) {
  if (line.trim() === "") return;
  const reply = parseReplyLine(line);
  if (!byCondition.has(reply.condition)) {
    byCondition.set(reply.condition, []);
  }
  byCondition.get(reply.condition).push(reply);
}

/**
 * Read the replies file in pieces and return a map from condition name to its replies, in the order they were saved.
 * A line can be cut across two pieces, so the unfinished end of each piece is kept until the next piece arrives.
 */
export async function readRepliesByCondition(file) {
  const byCondition = new Map();
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
  let unfinished = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const lines = (unfinished + value).split("\n");
    unfinished = lines.pop();
    for (const line of lines) addReplyLine(byCondition, line);
  }
  addReplyLine(byCondition, unfinished);
  return byCondition;
}

/**
 * Work out the shape of a condition's runs from its replies: the models and questions in the order they first appear,
 * and the number of repeats, which is the largest repeat number. The Batch page checks these against its own lists.
 */
export function runShape(replies) {
  return {
    models: [...new Set(replies.map((reply) => reply.model))],
    questions: [...new Set(replies.map((reply) => reply.question_id))],
    repeats: Math.max(...replies.map((reply) => reply.repeat)),
  };
}

/** Return the label of a run loaded from a file, such as "Full run: Control". */
export function fullRunLabel(conditionFolder) {
  const condition = CONDITIONS.find((item) => item.folder === conditionFolder);
  return `Full run: ${condition === undefined ? conditionFolder : condition.label}`;
}

/**
 * Turn one condition's replies into the input of a saved run: its config, its planned units and its saved results.
 * Planned units are only the units that have replies in the file. A unit the original run never finished (a failed
 * call) has no reply, so it is not planned, and Resume does not send it again. The run is marked stopped, so Resume is
 * offered, and every planned unit is already saved, so Resume shows the results without sending anything.
 */
export function buildRunInput(conditionFolder, replies, settings) {
  const shape = runShape(replies);
  const groups = new Map();
  for (const reply of replies) {
    const key = unitKeyFor(reply.model, reply.question_id, reply.repeat);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(reply);
  }
  const results = {};
  for (const [key, group] of groups) {
    results[key] = unitPayload(group);
  }
  return {
    label: fullRunLabel(conditionFolder),
    status: "stopped",
    plannedUnits: [...groups.keys()],
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
      condition: conditionFolder,
      concurrency: 1,
      callCap: settings.callCap,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
    },
  };
}

/**
 * Save one saved run for each condition in the replies file. A condition whose run is already in this browser is left
 * alone, so loading the same file twice does not make duplicates. Returns the labels that were saved and the labels
 * that were skipped, and a condition with no replies in the file is reported as missing.
 */
export async function importFullRuns(adapter, byCondition, settings) {
  const existingLabels = new Set((await listRuns(adapter)).map((run) => run.label));
  const saved = [];
  const skipped = [];
  for (const condition of CONDITIONS) {
    const label = fullRunLabel(condition.folder);
    const replies = byCondition.get(condition.folder);
    if (replies === undefined || replies.length === 0) {
      skipped.push(`${label} (no replies in the file)`);
    } else if (existingLabels.has(label)) {
      skipped.push(`${label} (already in this browser)`);
    } else {
      await importRunDocument(adapter, buildRunInput(condition.folder, replies, settings));
      saved.push(label);
    }
  }
  return { saved, skipped };
}
