// Tests for which saved runs the Live page offers in its Run to replay list. Only runs that were made on the replay's
// suite and have replies are listed, so a choice never replays nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { replayableRuns } from "../site/js/page-live.js";
import { choiceOfSuite } from "../site/js/suites.js";

const SUITE = { ladderName: "v3", questionSet: "easy", name: "gauntlet_v3+easy" };

/** Return a saved run document with the given config and results. */
function run(id, config, results) {
  return { id, label: id, createdAt: 1, config, plannedUnits: Object.keys(results), results };
}

test("replayableRuns keeps runs on the replay's suite that have replies, and drops the rest", () => {
  const wanted = choiceOfSuite(SUITE);
  const onSuite = { kind: "batch", pushbackSet: wanted.pushbackSet, questionSet: wanted.questionSet };
  const runs = [
    run("kept", onSuite, { a: { steps: [{ step: "level_0" }] } }),
    run("no-replies", onSuite, {}),
    run("other-suite", { kind: "batch", pushbackSet: "other", questionSet: "other" }, { a: { steps: [{}] } }),
  ];
  assert.deepEqual(replayableRuns(runs, SUITE).map((saved) => saved.id), ["kept"]);
});
