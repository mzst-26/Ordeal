// Tests for frontend/js/question-actions.js. These are pure functions: they take question objects and return ids or
// text, so no DOM is needed and the tests run in Node.
import { test } from "node:test";
import assert from "node:assert/strict";
import { idsForAction, numberedQuestionLines, QUESTION_ACTIONS } from "../../frontend/js/question-actions.js";
import { readJson } from "./helpers.js";

// A small stand-in for the suite's questions: two flagged for correction, one flagged for wrapper, one with both.
const QUESTIONS = [
  { id: "m01", tier: "a", question: "First question.", correction_test: true, wrapper_test: false },
  { id: "m02", tier: "a", question: "Second question.", correction_test: false, wrapper_test: false },
  { id: "m03", tier: "b", question: "Third question.", correction_test: false, wrapper_test: true },
  { id: "m04", tier: "b", question: "Fourth question.", correction_test: true, wrapper_test: true },
];

// The menu order the dropdown shows: All, None, the two flagged sets, then Choose questions.
test("the dropdown lists the actions in menu order", () => {
  assert.deepEqual(QUESTION_ACTIONS, ["all", "none", "correction", "wrapper", "choose"]);
});

// Each action decides which ids it ticks. These are the same rules the old five buttons used.
test("All ticks every question in the suite", () => {
  assert.deepEqual([...idsForAction("all", QUESTIONS)], ["m01", "m02", "m03", "m04"]);
});

test("None ticks no question", () => {
  assert.equal(idsForAction("none", QUESTIONS).size, 0);
});

test("Only flagged for correction tests ticks just the questions with the correction flag", () => {
  assert.deepEqual([...idsForAction("correction", QUESTIONS)], ["m01", "m04"]);
});

test("Only flagged for wrapper tests ticks just the questions with the wrapper flag", () => {
  assert.deepEqual([...idsForAction("wrapper", QUESTIONS)], ["m03", "m04"]);
});

test("Choose questions ticks nothing by itself, because the one-by-one picker does the ticking", () => {
  assert.equal(idsForAction("choose", QUESTIONS), null);
});

test("a flagged action on a suite with no flagged questions ticks none", () => {
  const plain = QUESTIONS.map((question) => ({ ...question, correction_test: false, wrapper_test: false }));
  assert.equal(idsForAction("correction", plain).size, 0);
  assert.equal(idsForAction("wrapper", plain).size, 0);
});

test("the real easy question set has 16 correction-flagged and 12 wrapper-flagged questions", () => {
  const questions = readJson("frontend/data/questions.json");
  assert.equal(idsForAction("correction", questions).size, 16);
  assert.equal(idsForAction("wrapper", questions).size, 12);
  assert.equal(idsForAction("all", questions).size, 32);
});

// The numbered list: one line per ticked question, numbered from 1 in the order the questions are given.
test("numberedQuestionLines numbers the selected questions from 1 in order", () => {
  const lines = numberedQuestionLines([QUESTIONS[0], QUESTIONS[2]]);
  assert.deepEqual(lines.map((line) => line.number), [1, 2]);
  assert.deepEqual(lines.map((line) => line.id), ["m01", "m03"]);
});

test("numberedQuestionLines keeps a short question text whole", () => {
  const [line] = numberedQuestionLines([QUESTIONS[0]]);
  assert.equal(line.text, "First question.");
});

test("numberedQuestionLines cuts a long question text to 60 characters and adds an ellipsis", () => {
  const long = { id: "m09", question: "x".repeat(100) };
  const [line] = numberedQuestionLines([long]);
  assert.equal(line.text, `${"x".repeat(60)}…`);
});

test("numberedQuestionLines gives no lines when nothing is selected", () => {
  assert.deepEqual(numberedQuestionLines([]), []);
});

// The list and the count line are built from the same ticks, so the number of lines is the count.
test("the list has one line per selected question, matching the count", () => {
  const selected = QUESTIONS.filter((question) => question.wrapper_test);
  assert.equal(numberedQuestionLines(selected).length, selected.length);
});
