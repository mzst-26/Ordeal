// Tests for the two pure helpers that the model picker uses to sort names under letter headings and to split them into
// pages: groupByLetter and pageOf in site/js/model-list.js. No DOM and no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByLetter, pageOf, sortModelIds, letterGroups } from '../site/js/model-list.js';

// groupByLetter: names are sorted by their full id, ignoring case, and each letter gets one group.

test('groupByLetter sorts names by full id ignoring case and groups them under their first letter', () => {
  const ids = ['beta/x', 'Alpha/y', 'alpha/a'];
  assert.deepEqual(groupByLetter(ids), [
    { letter: 'A', ids: ['alpha/a', 'Alpha/y'] },
    { letter: 'B', ids: ['beta/x'] },
  ]);
});

test('groupByLetter puts names that do not start with a letter under the # heading, first', () => {
  const ids = ['org/x', '0-hero/a', '9b/z'];
  assert.deepEqual(groupByLetter(ids), [
    { letter: '#', ids: ['0-hero/a', '9b/z'] },
    { letter: 'O', ids: ['org/x'] },
  ]);
});

test('groupByLetter keeps the # group together even when a symbol sorts after the letters', () => {
  const ids = ['~tilde', 'alpha'];
  assert.deepEqual(groupByLetter(ids), [
    { letter: '#', ids: ['~tilde'] },
    { letter: 'A', ids: ['alpha'] },
  ]);
});

test('groupByLetter gives an empty list for no names', () => {
  assert.deepEqual(groupByLetter([]), []);
});

test('groupByLetter does not change the list it is given', () => {
  const ids = ['b/one', 'a/two'];
  groupByLetter(ids);
  assert.deepEqual(ids, ['b/one', 'a/two']);
});

// sortModelIds and letterGroups: the order the picker shows, and the shape it draws (a label and the names under it).

test('sortModelIds sorts by letter group, then by full id ignoring case', () => {
  assert.deepEqual(sortModelIds(['beta/x', '0-hero/a', 'Alpha/y', 'alpha/a']), ['0-hero/a', 'alpha/a', 'Alpha/y', 'beta/x']);
});

test('letterGroups gives each group a label and its names, in the shape the picker draws', () => {
  assert.deepEqual(letterGroups(['beta/x', 'alpha/a']), [
    { label: 'A', items: ['alpha/a'] },
    { label: 'B', items: ['beta/x'] },
  ]);
});

// pageOf: a page of at most `size` names, with the page number kept in range.

function names(count) {
  return Array.from({ length: count }, (_, i) => `lab/model-${i}`);
}

test('pageOf gives an empty page with one page for an empty list', () => {
  assert.deepEqual(pageOf([], 1, 100), { items: [], page: 1, pageCount: 1, total: 0 });
});

test('pageOf fills a whole page exactly when the count is an exact multiple of the size', () => {
  const result = pageOf(names(200), 2, 100);
  assert.equal(result.items.length, 100);
  assert.equal(result.items[0], 'lab/model-100');
  assert.deepEqual(
    { page: result.page, pageCount: result.pageCount, total: result.total },
    { page: 2, pageCount: 2, total: 200 },
  );
});

test('pageOf gives the names left over on the last, partial page', () => {
  const result = pageOf(names(250), 3, 100);
  assert.equal(result.items.length, 50);
  assert.equal(result.items[49], 'lab/model-249');
  assert.deepEqual(
    { page: result.page, pageCount: result.pageCount, total: result.total },
    { page: 3, pageCount: 3, total: 250 },
  );
});

test('pageOf moves a page number below 1 up to the first page', () => {
  assert.equal(pageOf(names(250), 0, 100).page, 1);
  assert.equal(pageOf(names(250), -5, 100).page, 1);
});

test('pageOf moves a page number above the last page down to the last page', () => {
  const result = pageOf(names(250), 99, 100);
  assert.equal(result.page, 3);
  assert.equal(result.items.length, 50);
});

test('pageOf treats a page number that is not a number as the first page', () => {
  assert.equal(pageOf(names(250), Number.NaN, 100).page, 1);
});
