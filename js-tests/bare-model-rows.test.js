// Tests for the rule that a plain name from a saved list shows only its name in the picker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasNoDetails, modelRowText } from '../site/js/model-details.js';

test('a plain name from a saved list has no details, so its card shows the name alone', () => {
  assert.equal(hasNoDetails(modelRowText({ id: 'org/name' })), true);
});

test('a model with a context window is not bare', () => {
  assert.equal(hasNoDetails(modelRowText({ id: 'org/name', context_tokens: 131072 })), false);
});

test('a model with a rank is not bare', () => {
  assert.equal(hasNoDetails(modelRowText({ id: 'org/name', industry_rank: 3 })), false);
});
