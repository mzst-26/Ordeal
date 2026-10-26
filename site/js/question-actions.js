// The choices in the question dropdown on the Batch page: All, None, the two flagged sets, and Choose questions.
// This file holds the rules that decide which questions each choice ticks, and the text of the numbered list of
// the ticked questions. It is plain functions with no DOM, so the tests can run them in Node. page-batch.js reads
// the questions from the page and applies what these functions return.

// The most characters of a question shown in the numbered list. A longer question is cut and given "…", so every
// list line stays on one row. The picker and the tick boxes still show the full text elsewhere.
export const LIST_TEXT_LENGTH = 60;

// The actions in the order the dropdown shows them. "choose" opens the one-by-one picker instead of ticking here.
export const QUESTION_ACTIONS = ["all", "none", "correction", "wrapper", "choose"];

/**
 * Return the set of question ids that an action ticks. "all" ticks every question, "none" ticks none, and the two
 * flagged actions tick the questions whose flag is true. The flag is read from each question object, so the rule
 * is the same one the old separate buttons used. "choose" returns null: the picker does its own ticking.
 */
export function idsForAction(action, questions) {
  if (action === "all") {
    return new Set(questions.map((question) => question.id));
  }
  if (action === "none") {
    return new Set();
  }
  if (action === "correction") {
    return flaggedIds(questions, "correction_test");
  }
  if (action === "wrapper") {
    return flaggedIds(questions, "wrapper_test");
  }
  return null;
}

/** Return the ids of the questions whose named flag is true, as a set. */
function flaggedIds(questions, flagName) {
  return new Set(questions.filter((question) => question[flagName] === true).map((question) => question.id));
}

/**
 * Return one line per selected question for the numbered list: its number (from 1, in the order given), its id,
 * and its text shortened to LIST_TEXT_LENGTH. The list is numbered by the count of what is ticked, so the reader
 * can say "question 3" and find the third line.
 */
export function numberedQuestionLines(selectedQuestions) {
  return selectedQuestions.map((question, index) => ({
    number: index + 1,
    id: question.id,
    text: shortQuestionText(question.question),
  }));
}

/**
 * Return a question's text cut to LIST_TEXT_LENGTH characters with an ellipsis, or the text itself when it is short
 * enough. The numbered list and the question tick-box labels both use this one rule, so they always cut the same way.
 */
export function shortQuestionText(text) {
  return text.length > LIST_TEXT_LENGTH ? `${text.slice(0, LIST_TEXT_LENGTH)}…` : text;
}
