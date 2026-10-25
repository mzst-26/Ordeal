// Tests for finding the newest saved run (site/js/last-run.js). The adapter is a small in-memory stand-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestRunOfKind, runMatchesSuite } from '../site/js/last-run.js';

/** An adapter that holds runs in a list, like the run store's adapter. */
function adapterWith(runs) {
  return {
    list: async () => runs.map((run) => ({ ...run })),
    get: async (store, id) => {
      const found = runs.find((run) => run.id === id);
      return found ? { ...found } : null;
    },
  };
}

/** A saved run document with the fields the helper reads. */
function run(id, kind, createdAt, extra = {}) {
  return {
    id,
    createdAt,
    updatedAt: createdAt,
    status: 'done',
    label: id,
    config: { kind, pushbackSet: 'gauntlet_v3', questionSet: 'easy', pushbackSeed: null, questionSeed: null },
    plannedUnits: ['a'],
    results: {},
    ...extra,
  };
}

const SUITE = { ladderName: 'gauntlet_v3', questionSet: 'easy' };

test('the newest run of the kind is returned, and other kinds are skipped', async () => {
  const adapter = adapterWith([
    run('old-batch', 'batch', '2026-10-20T10:00:00.000Z'),
    run('gauntlet', 'gauntlet', '2026-10-25T09:00:00.000Z'),
    run('new-batch', 'batch', '2026-10-24T10:00:00.000Z'),
  ]);
  const found = await latestRunOfKind(adapter, 'batch');
  assert.equal(found.id, 'new-batch');
});

test('no run of the kind gives null', async () => {
  const adapter = adapterWith([run('gauntlet', 'gauntlet', '2026-10-25T09:00:00.000Z')]);
  assert.equal(await latestRunOfKind(adapter, 'live'), null);
});

test('a run on the same suite matches, and a run on another suite or seed does not', () => {
  assert.equal(runMatchesSuite(run('r', 'batch', '2026-10-25T00:00:00.000Z'), SUITE), true);
  const otherSet = run('r', 'batch', '2026-10-25T00:00:00.000Z', { config: { kind: 'batch', pushbackSet: 'gauntlet_v4', questionSet: 'easy', pushbackSeed: null, questionSeed: null } });
  assert.equal(runMatchesSuite(otherSet, SUITE), false);
  const seeded = run('r', 'batch', '2026-10-25T00:00:00.000Z', { config: { kind: 'batch', pushbackSet: 'gauntlet_v3', questionSet: 'easy', pushbackSeed: 7, questionSeed: null } });
  assert.equal(runMatchesSuite(seeded, SUITE), false);
});
