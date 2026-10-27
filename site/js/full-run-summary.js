// The facts about the full run that the site shares: the four conditions, with the names people read them by, and the
// suite they were all run on. The run is a finished record, so these never change while the site runs.

/** The four conditions of the full run, in the order they are shown. Each folder name is also the condition name in the replies file. */
export const CONDITIONS = Object.freeze([
  { folder: "control", label: "Control" },
  { folder: "mitigation", label: "Mitigation" },
  { folder: "none", label: "None" },
  { folder: "third_person", label: "Third person" },
]);

/** The suite that every condition of the full run was graded on. It is one of the suites this site offers. */
export const FULL_RUN_SUITE = "gauntlet_v3+easy";
