// Tests for the pure parts of saving a run to the web store: the body of the save request, its headers, the message
// shown for each answer, and the save call itself. The save call goes through a fake fetch, so nothing touches the
// network. The password must never reach the body or the message, so the tests check that too.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSaveBody,
  buildSaveHeaders,
  saveMessage,
  saveRunToWeb,
} from "../site/js/runs-api.js";

const PASSWORD = "correct horse battery";
const RUN = { id: "run-1", results: { a: { steps: [] } } };

/** Return a fake fetch that answers with the given status, and records every call it gets. */
function fakeFetch(status) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => ({}) };
  };
  return { fetchFn, calls };
}

// The server reads the kind and the run from the body, so the body must carry both under those names.
test("buildSaveBody puts the kind and the run in the body", () => {
  assert.deepEqual(buildSaveBody("batch", RUN), { kind: "batch", run: RUN });
});

// The password goes in the Authorization header as a Bearer value, the same as the delete call.
test("buildSaveHeaders sends the password as a Bearer value and says the body is JSON", () => {
  assert.deepEqual(buildSaveHeaders(PASSWORD), {
    "content-type": "application/json",
    authorization: `Bearer ${PASSWORD}`,
  });
});

// A 201 means the server kept the run, so the page says so in plain words.
test("saveMessage says the run was saved when the server answers 201", () => {
  assert.equal(saveMessage(201), "Saved to the web store. It is kept for 7 days.");
});

// A 401 is the one case the visitor can fix by typing the password again, so it has its own words.
test("saveMessage says the password is wrong when the server answers 401", () => {
  assert.equal(saveMessage(401), "The write password is missing or wrong.");
});

// A 413 means the run alone is bigger than the whole store, so the visitor cannot fix it by retrying.
test("saveMessage says the run is too large when the server answers 413", () => {
  assert.equal(saveMessage(413), "This run is too large for the 1.5 GB store, so it was not saved.");
});

// Any other answer, including a network-level failure, gets one general message.
test("saveMessage gives the general error for any other status", () => {
  assert.equal(saveMessage(500), "The run could not be saved to the web store.");
  assert.equal(saveMessage(400), "The run could not be saved to the web store.");
});

// No message may print the password, even by accident.
test("no save message contains the password", () => {
  for (const status of [201, 400, 401, 413, 500]) {
    assert.equal(saveMessage(status).includes(PASSWORD), false);
  }
});

// The save call posts to the list address, with the headers and the body built above.
test("saveRunToWeb posts the run to /api/runs with the Bearer header", async () => {
  const { fetchFn, calls } = fakeFetch(201);
  await saveRunToWeb("gauntlet", RUN, PASSWORD, fetchFn);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/runs");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].init.headers, buildSaveHeaders(PASSWORD));
  assert.deepEqual(JSON.parse(calls[0].init.body), { kind: "gauntlet", run: RUN });
});

// The password is sent only in the header, never inside the body that is stored on the server.
test("saveRunToWeb keeps the password out of the request body", async () => {
  const { fetchFn, calls } = fakeFetch(201);
  await saveRunToWeb("batch", RUN, PASSWORD, fetchFn);
  assert.equal(calls[0].init.body.includes(PASSWORD), false);
});

// The result says whether the run was kept, the status the server sent (so the page can tell a wrong password
// from other failures), and the message the page shows.
test("saveRunToWeb reports saved on 201 and not saved on 401", async () => {
  const ok = await saveRunToWeb("batch", RUN, PASSWORD, fakeFetch(201).fetchFn);
  assert.deepEqual(ok, { saved: true, status: 201, message: "Saved to the web store. It is kept for 7 days." });
  const wrong = await saveRunToWeb("batch", RUN, PASSWORD, fakeFetch(401).fetchFn);
  assert.deepEqual(wrong, { saved: false, status: 401, message: "The write password is missing or wrong." });
});
