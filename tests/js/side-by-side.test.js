// Tests for the side-by-side rules in frontend/js/models/side-by-side.js: the limit of three providers, the check
// that the browser may call a provider, the key each provider needs, and the grouping of saved results by provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readJson } from './helpers.js';
import {
  MAX_SIDE_PROVIDERS,
  TOO_MANY_PROVIDERS_MESSAGE,
  BROWSER_ALLOWED_HOSTS,
  addSideProvider,
  browserReachability,
  sideProviderStatuses,
  runnableProviderIds,
  groupRowsByProvider,
  comparisonKey,
  sameComparison,
  rowLabelsFor,
  latestRunFor,
  comparisonSettingsOf,
  columnsFor,
  firstReplyPerQuestion,
  cellText,
  resultsTableModel,
  DIFFERENT_SETTINGS_TEXT,
  CELL_TEXT_LIMIT,
  STATUS_READY,
  STATUS_MISSING_KEY,
  STATUS_UNAVAILABLE,
} from '../../frontend/js/models/side-by-side.js';

// The shared platform list, as the browser reads it. Nothing here is a real key.
const PLATFORMS = readJson('ordeal/data/providers.json').platforms;
const NEBIUS = PLATFORMS.find((platform) => platform.id === 'nebius');
const GROQ = PLATFORMS.find((platform) => platform.id === 'groq');
const TOGETHER = PLATFORMS.find((platform) => platform.id === 'together');
const FOURTH = PLATFORMS.find((platform) => platform.id === 'openrouter');

test('up to three providers may be chosen', () => {
  assert.equal(MAX_SIDE_PROVIDERS, 3);
  let chosen = addSideProvider([], 'nebius');
  chosen = addSideProvider(chosen, 'groq');
  chosen = addSideProvider(chosen, 'together');
  assert.deepEqual(chosen, ['nebius', 'groq', 'together']);
});

test('a fourth provider is refused with a message and the list is not changed', () => {
  const full = ['nebius', 'groq', 'together'];
  assert.throws(() => addSideProvider(full, FOURTH.id), (error) => error.message === TOO_MANY_PROVIDERS_MESSAGE);
  assert.deepEqual(full, ['nebius', 'groq', 'together']);
});

test('choosing a provider that is already chosen does not count as a fourth', () => {
  const full = ['nebius', 'groq', 'together'];
  assert.deepEqual(addSideProvider(full, 'groq'), full);
});

test('only Nebius is reachable from the browser, as the content security policy allows', () => {
  assert.deepEqual(BROWSER_ALLOWED_HOSTS, ['api.tokenfactory.nebius.com']);
  assert.equal(browserReachability(NEBIUS).reachable, true);
  const groq = browserReachability(GROQ);
  assert.equal(groq.reachable, false);
  assert.match(groq.reason, /cannot be called from this page/);
  assert.match(groq.reason, /ordeal test groq/);
});

test('the allowed hosts match the connect-src line of the content security policy', () => {
  const netlify = readFileSync(new URL('../../netlify.toml', import.meta.url), 'utf8');
  const connectSrc = netlify.match(/connect-src ([^;]+);/)[1];
  for (const host of BROWSER_ALLOWED_HOSTS) {
    assert.ok(connectSrc.includes(`https://${host}`), `connect-src lists ${host}`);
  }
});

test('a blocked provider is unavailable with its reason, even when a key is saved for it', () => {
  const [status] = sideProviderStatuses(['groq'], PLATFORMS, () => true);
  assert.equal(status.status, 'unavailable');
  assert.match(status.reason, /command line/i);
});

test('a provider with no key is missing-key and does not block the others', () => {
  const haveKey = (id) => id !== 'nebius';
  const statuses = sideProviderStatuses(['nebius', 'groq'], PLATFORMS, haveKey);
  assert.equal(statuses[0].status, 'missing-key');
  assert.match(statuses[0].reason, /No key is saved for Nebius/);
  assert.equal(statuses[1].status, 'unavailable');
});

test('a provider with a key is ready; an id missing from the list is unavailable', () => {
  const statuses = sideProviderStatuses(['nebius', 'not-a-provider'], PLATFORMS, () => true);
  assert.equal(statuses[0].status, 'ready');
  assert.equal(statuses[1].status, 'unavailable');
  assert.match(statuses[1].reason, /not on the platform list/);
});

test('only the ready providers are runnable, so a missing key blocks just that provider', () => {
  const statuses = sideProviderStatuses(['nebius', 'together', 'groq'], PLATFORMS, (id) => id === 'nebius' || id === 'together');
  assert.deepEqual(runnableProviderIds(statuses), ['nebius']);
});

test('no key text appears in a status, even when a key is saved', () => {
  const secret = 'SECRET-TEST-VALUE-123456789';
  const statuses = sideProviderStatuses(['nebius'], PLATFORMS, () => true);
  assert.equal(JSON.stringify(statuses).includes(secret), false);
});

test('saved rows are grouped per provider, in the order the providers were chosen', () => {
  const rows = [
    { provider: 'groq', model: 'a', reply: 'g1' },
    { provider: 'nebius', model: 'b', reply: 'n1' },
    { provider: 'groq', model: 'a', reply: 'g2' },
    { reply: 'no provider' },
  ];
  const groups = groupRowsByProvider(rows, ['nebius', 'groq']);
  assert.deepEqual(groups.map((group) => group.id), ['nebius', 'groq']);
  assert.deepEqual(groups[0].rows.map((row) => row.reply), ['n1']);
  assert.deepEqual(groups[1].rows.map((row) => row.reply), ['g1', 'g2']);
});

test('a provider with no saved rows still gets an empty column', () => {
  const groups = groupRowsByProvider([], ['together']);
  assert.deepEqual(groups, [{ id: 'together', rows: [] }]);
});

test('runs are comparable when the questions, conditions, seed and repeats are the same', () => {
  const settingsA = { suite: 'easy', condition: 'none', seed: 7, repeats: 1, questions: ['q2', 'q1'] };
  const settingsB = { suite: 'easy', condition: 'none', seed: 7, repeats: 1, questions: ['q1', 'q2'] };
  assert.equal(comparisonKey(settingsA), comparisonKey(settingsB));
  assert.equal(sameComparison([settingsA, settingsB]), true);
});

test('runs with a different seed, condition or question list are not comparable', () => {
  const base = { suite: 'easy', condition: 'none', seed: 7, repeats: 1, questions: ['q1'] };
  assert.equal(sameComparison([base, { ...base, seed: 8 }]), false);
  assert.equal(sameComparison([base, { ...base, condition: 'other' }]), false);
  assert.equal(sameComparison([base, { ...base, questions: ['q1', 'q2'] }]), false);
});

test('the same-setting check passes for one run or none', () => {
  assert.equal(sameComparison([]), true);
  assert.equal(sameComparison([{ suite: 'easy', seed: 1 }]), true);
});

test('a provider on another host is blocked and points to the command line', () => {
  assert.equal(browserReachability(TOGETHER).reachable, false);
});

// The labels the panel shows for each state, and which buttons each state allows.
test('a ready provider shows Ready and may be used for the batch', () => {
  const labels = rowLabelsFor({ status: STATUS_READY });
  assert.equal(labels.badge, 'Ready');
  assert.equal(labels.canUse, true);
  assert.equal(labels.canAddKey, true);
});

test('a provider with no key shows Needs a key, may not be used yet, and may take a key', () => {
  const labels = rowLabelsFor({ status: STATUS_MISSING_KEY });
  assert.equal(labels.badge, 'Needs a key');
  assert.equal(labels.canUse, false);
  assert.equal(labels.canAddKey, true);
});

test('an unavailable provider shows Not available here and may take neither a key nor a run', () => {
  const labels = rowLabelsFor({ status: STATUS_UNAVAILABLE });
  assert.equal(labels.badge, 'Not available here');
  assert.equal(labels.canUse, false);
  assert.equal(labels.canAddKey, false);
});

// Results side by side: each chosen provider's newest saved batch run, with its replies tagged by provider.
const RUN_CONFIG = { kind: 'batch', questionSet: 'easy', pushbackSet: 'gauntlet_v3', condition: 'none', repeats: 1, questions: ['q1', 'q2'] };
const RUNS = [
  { id: 'run-groq-new', config: { ...RUN_CONFIG, platformId: 'groq' }, results: {} },
  { id: 'run-nebius', config: { ...RUN_CONFIG, platformId: 'nebius' }, results: {} },
  { id: 'run-groq-old', config: { ...RUN_CONFIG, platformId: 'groq' }, results: {} },
  { id: 'run-live', config: { ...RUN_CONFIG, kind: 'live', platformId: 'together' }, results: {} },
];
/** A fake record reader: each run's results hold a list of step records under steps. */
const recordsOf = (run) => (run.records ?? []);

test('the newest batch run made on a provider is the one shown for it', () => {
  assert.equal(latestRunFor(RUNS, 'groq').id, 'run-groq-new');
  assert.equal(latestRunFor(RUNS, 'together'), null, 'a live run is not a batch run');
  assert.equal(latestRunFor(RUNS, 'mistral'), null);
});

test('the comparison settings are the question set, pushback set, condition, repeats, questions and seed', () => {
  const settings = comparisonSettingsOf({ ...RUN_CONFIG, platformId: 'groq', seed: 4 });
  assert.deepEqual(settings, {
    suite: JSON.stringify([null, 'easy', 'gauntlet_v3']),
    condition: 'none',
    seed: 4,
    repeats: 1,
    questions: ['q1', 'q2'],
  });
});

test('columns for three providers keep the chosen order, and an empty column when a provider has no run', () => {
  const runs = [
    { id: 'g', config: { ...RUN_CONFIG, platformId: 'groq' }, records: [{ provider: 'groq', question_id: 'q1', reply: 'a' }] },
    { id: 'n', config: { ...RUN_CONFIG, platformId: 'nebius' }, records: [{ provider: 'nebius', question_id: 'q1', reply: 'b' }] },
  ];
  const columns = columnsFor(['nebius', 'groq', 'together'], runs, recordsOf);
  assert.deepEqual(columns.map((column) => column.id), ['nebius', 'groq', 'together']);
  assert.equal(columns[2].run, null);
  assert.deepEqual(columns[2].rows, []);
  assert.equal(columns[1].rows[0].reply, 'a');
});

test('a row from an older run, saved before providers were recorded, takes the run provider', () => {
  const runs = [{ id: 'old', config: { ...RUN_CONFIG, platformId: 'groq' }, records: [{ question_id: 'q1', reply: 'old' }] }];
  const [column] = columnsFor(['groq'], runs, recordsOf);
  assert.equal(column.rows[0].provider, 'groq');
});

test('the first reply for each question is shown side by side in one line per question', () => {
  const rows = [
    { provider: 'groq', question_id: 'q1', reply: 'first' },
    { provider: 'groq', question_id: 'q1', reply: 'second' },
    { provider: 'groq', question_id: 'q2', reply: 'third' },
  ];
  const firsts = firstReplyPerQuestion(rows);
  assert.equal(firsts.get('q1'), 'first');
  assert.equal(firsts.get('q2'), 'third');
});

test('a long reply is cut to the cell limit with an ellipsis, and a short one is kept whole', () => {
  assert.equal(cellText('short'), 'short');
  const long = 'x'.repeat(CELL_TEXT_LIMIT + 10);
  const cut = cellText(long);
  assert.equal(cut.length, CELL_TEXT_LIMIT);
  assert.ok(cut.endsWith('…'));
});

test('the results table has one row per question, and each cell is that provider reply to it', () => {
  const columns = [
    { id: 'groq', run: { id: 'g' }, settings: { suite: 's', condition: 'none', seed: null, repeats: 1, questions: ['q1', 'q2'] }, rows: [
      { provider: 'groq', question_id: 'q1', reply: 'g-one' },
      { provider: 'groq', question_id: 'q2', reply: 'g-two' },
    ] },
    { id: 'nebius', run: { id: 'n' }, settings: { suite: 's', condition: 'none', seed: null, repeats: 1, questions: ['q1', 'q2'] }, rows: [
      { provider: 'nebius', question_id: 'q1', reply: 'n-one' },
    ] },
  ];
  const model = resultsTableModel(columns, { groq: 'Groq', nebius: 'Nebius' });
  assert.deepEqual(model.headers, ['Groq', 'Nebius']);
  assert.deepEqual(model.rows, [
    { question: 'q1', cells: ['g-one', 'n-one'] },
    { question: 'q2', cells: ['g-two', '—'] },
  ]);
  assert.equal(model.warning, null);
  assert.deepEqual(model.missing, []);
});

test('a provider with no saved run is marked missing, and its cells are empty', () => {
  const columns = [{ id: 'together', run: null, settings: null, rows: [] }];
  const model = resultsTableModel(columns, { together: 'Together AI' });
  assert.deepEqual(model.missing, ['together']);
  assert.deepEqual(model.rows, []);
});

test('runs made with different questions, conditions or seeds get a warning, not a comparison', () => {
  const same = { suite: 's', condition: 'none', seed: 1, repeats: 1, questions: ['q1'] };
  const other = { ...same, seed: 2 };
  const columns = [
    { id: 'groq', run: { id: 'g' }, settings: same, rows: [] },
    { id: 'nebius', run: { id: 'n' }, settings: other, rows: [] },
  ];
  const model = resultsTableModel(columns, {});
  assert.equal(model.warning, DIFFERENT_SETTINGS_TEXT);
});
