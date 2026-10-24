// Tests for site/js/engine/csv.js: the CSV cell text used by the batch exports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, neutraliseFormula } from '../site/js/engine/csv.js';

test('a cell that starts with =, +, - or @ gets a single quote in front', () => {
  assert.equal(csvCell('=HYPERLINK("http://x.example")'), '"\'=HYPERLINK(""http://x.example"")"');
  assert.equal(csvCell('+1+1'), "'+1+1");
  assert.equal(csvCell('-cmd'), "'-cmd");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
});

test('a cell that starts with a tab or a carriage return gets a single quote in front', () => {
  assert.equal(csvCell('\t=1+1'), "'\t=1+1");
  assert.equal(csvCell('\r=1+1'), "\"'\r=1+1\"");
});

test('a custom model name that looks like a formula is neutralised like any other text', () => {
  assert.equal(csvCell('=cmd|model'), "'=cmd|model");
  assert.equal(csvCell('+model-name'), "'+model-name");
  assert.equal(csvCell('@model'), "'@model");
});

test('a cell that starts with a formula character and also has a comma is quoted once, with the quote inside', () => {
  assert.equal(csvCell('=A1,B1'), '"\'=A1,B1"');
});

test('ordinary text and model names are written unchanged', () => {
  assert.equal(csvCell('Qwen/Qwen3-30B-A3B-Instruct-2507'), 'Qwen/Qwen3-30B-A3B-Instruct-2507');
  assert.equal(csvCell('gauntlet_v3'), 'gauntlet_v3');
  assert.equal(csvCell('a = b'), 'a = b');
});

test('text with a comma, a quote or a line break is quoted, with quotes doubled', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line one\nline two'), '"line one\nline two"');
});

test('numbers are never neutralised, so a negative number is written as it is', () => {
  assert.equal(csvCell(-2), '-2');
  assert.equal(csvCell(0.25), '0.25');
});

test('null, undefined and NaN give an empty cell', () => {
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(Number.NaN), '');
});

test('neutraliseFormula leaves text that does not start with a formula character alone', () => {
  assert.equal(neutraliseFormula('plain'), 'plain');
  assert.equal(neutraliseFormula('a =not at the start'), 'a =not at the start');
  assert.equal(neutraliseFormula('  plain'), '  plain');
});

test('a formula character after leading spaces, tabs or carriage returns gets a single quote in front', () => {
  assert.equal(csvCell(' =1+1'), "' =1+1");
  assert.equal(csvCell('   @SUM(A1)'), "'   @SUM(A1)");
  assert.equal(neutraliseFormula(' \t+cmd'), "' \t+cmd");
  assert.equal(neutraliseFormula(' \r-cmd'), "' \r-cmd");
  assert.equal(csvCell(' =A1,B1'), '"\' =A1,B1"');
});
