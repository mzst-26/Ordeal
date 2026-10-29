// Tests for the reply word check (frontend/js/engine/reply-words.js). A reply with no words is not an answer, whether it
// is empty, only spaces, or only the control tokens some models write. The same rule is used when a reply is sent, and
// when saved replies are reused, so an unusable reply is never treated as a real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasWords } from '../../frontend/js/engine/reply-words.js';

test('a reply with an answer in it has words', () => {
  assert.equal(hasWords('Answer: B'), true);
});

test('an empty reply, or one of only spaces and new lines, has no words', () => {
  assert.equal(hasWords(''), false);
  assert.equal(hasWords('   \n  '), false);
});

test('a reply of only control tokens has no words, even with the role word a model writes after them', () => {
  assert.equal(hasWords('<|start|>assistant<|channel|>'), false);
  assert.equal(hasWords('<|channel|>'), false);
});

test('a control token in front of a real answer does not hide the answer', () => {
  assert.equal(hasWords('<|channel|>Answer: B'), true);
});
