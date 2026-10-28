// Tests for the suite helpers of the Live theatre page: loading a suite, the confession label,
// and the confirmation text that names the suite and its planned calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readJson } from "./helpers.js";
import { loadSuite, confessionLabel, planMessage } from "../../frontend/js/page-live.js";
import { ALL_FAMILIES } from "../../frontend/js/engine/flows.js";
import { buildCacheIndex, planAllModels } from "../../frontend/js/engine/planner.js";
import { makeSuite, setupLevel } from "../../frontend/js/engine/rules.js";

// The page reads its data from /data/..., which sits under frontend/ in this project.
const readSiteJson = (path) => readJson(`frontend${path}`);

// loadSuite: each pushback set (v3, v4) reports its own level count, held-firm score and setup level,
// and bad names or a broken ladder are refused with a plain message.
test("the v4 suite has 12 levels and the v3 suite has 10", async () => {
  const v4 = await loadSuite("gauntlet_v4", "easy", readSiteJson);
  const v3 = await loadSuite("gauntlet_v3", "easy", readSiteJson);
  assert.equal(v4.suite.levelCount, 12);
  assert.equal(v4.suite.heldFirmScore, 13);
  assert.equal(v3.suite.levelCount, 10);
  assert.equal(v3.suite.heldFirmScore, 11);
  assert.equal(v4.suite.name, "gauntlet_v4+easy");
  assert.equal(v3.suite.name, "gauntlet_v3+easy");
});

test("the v4 setup turn is at level 5 and the v3 setup turn is at level 4", async () => {
  const v4 = await loadSuite("gauntlet_v4", "easy", readSiteJson);
  const v3 = await loadSuite("gauntlet_v3", "easy", readSiteJson);
  assert.equal(setupLevel(v4.suite.ladder), 5);
  assert.equal(setupLevel(v3.suite.ladder), 4);
});

test("the hard question set loads with its own question index", async () => {
  const view = await loadSuite("gauntlet_v4", "hard", readSiteJson);
  assert.equal(view.suite.name, "gauntlet_v4+hard");
  assert.equal(view.suite.questions.length, 59);
  assert.equal(view.questionsById[view.suite.questions[0].id], view.suite.questions[0]);
});

test("an unknown pushback set or question set is refused with a plain message", async () => {
  await assert.rejects(loadSuite("gauntlet_v9", "easy", readSiteJson), /There is no suite gauntlet_v9/);
  await assert.rejects(loadSuite("gauntlet_v3", "medium", readSiteJson), /medium questions/);
});

test("a ladder that breaks the engine's rules is refused", async () => {
  const broken = (path) => {
    const data = readSiteJson(path);
    return path.includes("ladder") ? { ...data, levels: [] } : data;
  };
  await assert.rejects(loadSuite("gauntlet_v4", "easy", broken), /needs at least one level/);
});

// confessionLabel: the ladder can name its confession probe, otherwise the label is "Confession".
test("the confession label comes from the ladder's confession probe", () => {
  const ladder = { confession_probe: { message: "m", label: "Final check" } };
  assert.equal(confessionLabel(ladder), "Final check");
  assert.equal(confessionLabel({ confession_probe: { label: "  Final check  " } }), "Final check");
});

test("the confession label falls back to Confession when the ladder gives none", async () => {
  const v4 = await loadSuite("gauntlet_v4", "easy", readSiteJson);
  assert.equal(confessionLabel(v4.suite.ladder), "Confession");
  assert.equal(confessionLabel({ confession_probe: { label: "   " } }), "Confession");
  assert.equal(confessionLabel({}), "Confession");
});

// planMessage: the confirmation text names the suite and the planned calls, and warns when the call cap is lower.
test("the confirmation names the v4 suite and its planned calls", async () => {
  const view = await loadSuite("gauntlet_v4", "easy", readSiteJson);
  const { suite } = view;
  const config = readSiteJson("/data/config.json");
  const questions = suite.questions.slice(0, 3);
  const plan = planAllModels(
    config.models, questions, 1, buildCacheIndex([]), "none", ALL_FAMILIES,
    suite.ladder, suite.probeSpec, config,
  );
  const planned = plan.totals.atMostNew;
  assert.ok(Number.isInteger(planned) && planned > 0);
  const message = planMessage(plan, planned, suite);
  assert.ok(message.includes("Suite gauntlet_v4+easy, 12 levels."), message);
  assert.ok(message.includes(`This will make at most ${planned} calls; 0 are already saved`), message);
  assert.ok(!message.includes("will stop the run first"), message);
});

test("the confirmation warns when the cap is below the planned v4 calls", async () => {
  const { suite } = await loadSuite("gauntlet_v4", "easy", readSiteJson);
  const config = readSiteJson("/data/config.json");
  const plan = planAllModels(
    config.models, suite.questions.slice(0, 1), 1, buildCacheIndex([]), "none", ALL_FAMILIES,
    suite.ladder, suite.probeSpec, config,
  );
  const message = planMessage(plan, 1, suite);
  assert.ok(message.includes("The call cap of 1 will stop the run first."), message);
});

test("a suite made from data the engine accepts reports its own level count", () => {
  const ladder = {
    name: "tiny",
    levels: [1, 2].map((level) => ({ level, type: "t", axis: "a" })),
    confession_probe: { message: "m" },
  };
  const probeSpec = {
    axes: [{ id: "bare" }],
    doses: Object.fromEntries(["consensus", "authority", "stated_confidence", "stakes"].map((dial) => [
      dial, { levels: ["x"] },
    ])),
  };
  const suite = makeSuite({ ladderName: "tiny", questionSet: "easy", ladder, probeSpec, questions: [{ id: "q" }] });
  assert.equal(suite.levelCount, 2);
  assert.equal(suite.name, "tiny+easy");
});
