// The facts about the full run that the site shares: the four conditions, with the names people read them by, and the
// experiment and suite they were all run on. These name the full run when it is loaded from its replies file.

/** The four conditions of the full run, in the order they are shown. Each folder name is also the condition name in the replies file. */
export const CONDITIONS = Object.freeze([
  { folder: "control", label: "Control" },
  { folder: "mitigation", label: "Mitigation" },
  { folder: "none", label: "None" },
  { folder: "third_person", label: "Third person" },
]);

/** The experiment id the full run wrote into every reply. A file from this experiment is labelled as the full run. */
export const FULL_RUN_EXPERIMENT = "82f5e58164d9";

/** The suite that every condition of the full run was graded on. */
export const FULL_RUN_SUITE = "gauntlet_v3+easy";
