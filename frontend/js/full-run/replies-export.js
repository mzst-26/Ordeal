// Turns the replies of the batch page into a replies file that the batch page can load back. The file has one JSON
// object per line, the same shape that readReplyGroups in full-run-upload.js reads. That is why an export of the batch
// page loads back through the same "Load saved replies" box, with no second format to keep in step. Keys and tokens
// are never part of a reply, so they cannot reach this file.

/**
 * Return the replies file text for a list of saved replies: one JSON object per line, ending with a newline. Each line
 * keeps the reply's condition, model, question, repeat, step, reply and the messages sent. It also gets the suite name
 * the reply came from. The experiment is left empty, because a batch is not part of a full run. An empty list gives an
 * empty string, so the caller can tell that there is nothing to save.
 */
export function repliesToJsonl(records, suiteName) {
  if (records.length === 0) {
    return "";
  }
  const lines = records.map((record) => JSON.stringify({ ...record, experiment: "", suite: suiteName }));
  return `${lines.join("\n")}\n`;
}
