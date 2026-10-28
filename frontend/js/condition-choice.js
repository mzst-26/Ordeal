// Small helpers for the system prompt conditions on the Batch page. A batch can tick more than one condition, and it
// runs one saved run for each. These functions add up the plans and join the lists the page shows, with no page code
// in them, so the tests can run them in Node without a browser.

/**
 * Add several plans into one. Each plan is { models: [{ model, saved, atMostNew }], totals: { saved, atMostNew } }.
 * The models keep the order they first appear in, and a model that is in more than one plan gets its counts added
 * together. This is how the plan line for each model adds up over every ticked condition.
 */
export function mergePlans(plans) {
  const rowsByModel = new Map();
  const totals = { saved: 0, atMostNew: 0 };
  for (const plan of plans) {
    for (const row of plan.models) {
      const sum = rowsByModel.get(row.model) ?? { model: row.model, saved: 0, atMostNew: 0 };
      sum.saved += row.saved;
      sum.atMostNew += row.atMostNew;
      rowsByModel.set(row.model, sum);
    }
    totals.saved += plan.totals.saved;
    totals.atMostNew += plan.totals.atMostNew;
  }
  return { models: [...rowsByModel.values()], totals };
}

/**
 * Return the values from all the lists, once each, in the order they first appear. Used when several saved runs are
 * loaded together: the form shows every model and question that any of them used.
 */
export function unionInOrder(lists) {
  const seen = new Set();
  const result = [];
  for (const list of lists) {
    for (const value of list) {
      if (!seen.has(value)) {
        seen.add(value);
        result.push(value);
      }
    }
  }
  return result;
}
