// Tests for the browser's visitor id (site/js/visitor-id.js). Storage and the random source are fakes, so the tests
// need no browser. They check the id's shape, that a saved id is reused, and what happens when storage is blocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newVisitorId, readOrCreateVisitorId, VISITOR_KEY } from "../site/js/visitor-id.js";
import { checkVisitorId } from "../site/js/visitor-rules.js";

/** Return a fake storage that keeps values in a Map, as localStorage does. */
function fakeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

/** Return a storage whose every call throws, as a blocked storage does in some privacy modes. */
function blockedStorage() {
  const fail = () => {
    throw new Error("storage is blocked");
  };
  return { getItem: fail, setItem: fail };
}

/** Return a fake random source that fills the bytes with a fixed pattern, so the id is known in advance. */
function fakeCrypto() {
  return {
    getRandomValues(bytes) {
      bytes.forEach((_, index) => {
        bytes[index] = index * 16 + 1;
      });
      return bytes;
    },
  };
}

// The id is 16 random bytes written as 32 hex characters, which is 128 random bits and passes the server's check.
test("a new visitor id is 32 hex characters that the server accepts", () => {
  const id = newVisitorId(fakeCrypto());
  assert.equal(id.length, 32);
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(checkVisitorId(id).ok, true);
  assert.equal(id, "01112131415161718191a1b1c1d1e1f1");
});

// On the first visit no id is saved yet, so a new one is made and kept in the storage.
test("the first visit makes an id and keeps it in the storage", () => {
  const storage = fakeStorage();
  const id = readOrCreateVisitorId([storage], () => "a".repeat(32));
  assert.equal(id, "a".repeat(32));
  assert.equal(storage.values.get(VISITOR_KEY), "a".repeat(32));
});

// A later visit reads the saved id and does not make a new one.
test("a later visit reuses the saved id and makes no new one", () => {
  const storage = fakeStorage({ [VISITOR_KEY]: "b".repeat(32) });
  let made = 0;
  const id = readOrCreateVisitorId([storage], () => {
    made += 1;
    return "c".repeat(32);
  });
  assert.equal(id, "b".repeat(32));
  assert.equal(made, 0);
});

// A saved value that is too short or otherwise broken is replaced, so the server never gets a bad id.
test("a saved value that fails the id check is replaced with a new id", () => {
  const storage = fakeStorage({ [VISITOR_KEY]: "short" });
  const id = readOrCreateVisitorId([storage], () => "d".repeat(32));
  assert.equal(id, "d".repeat(32));
  assert.equal(storage.values.get(VISITOR_KEY), "d".repeat(32));
});

// A blocked first storage falls through to the next one, so a visitor still keeps an id where they can.
test("a blocked storage is skipped and the next storage is used", () => {
  const session = fakeStorage();
  const id = readOrCreateVisitorId([blockedStorage(), session], () => "e".repeat(32));
  assert.equal(id, "e".repeat(32));
  assert.equal(session.values.get(VISITOR_KEY), "e".repeat(32));
});

// When every storage is blocked, the id is still made, so the page works. It lasts only as long as the page, and
// the caller keeps it in memory for that page.
test("when every storage is blocked, a new id is still made for the page", () => {
  const id = readOrCreateVisitorId([blockedStorage()], () => "f".repeat(32));
  assert.equal(id, "f".repeat(32));
});
