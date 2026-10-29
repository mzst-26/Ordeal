// Decides whether a model's reply has any words in it. A reply with no words is not an answer: it may be empty, only
// spaces, or only the control tokens some models write instead of text. The same rule is used when a reply comes back
// from the platform and when a saved reply is reused, so an unusable reply is never treated as a real one. The command
// line uses the same rule (ordeal/model_client.py), so the two agree.

// Some reasoning models write their own control tokens, such as <|start|>assistant<|channel|>, instead of an answer.
// Those tokens, and the role word a model writes after <|start|>, are not text.
const CONTROL_TOKEN = /<\|[^|>]*\|>/g;
const LEFTOVER_ROLE_WORD = /^\s*assistant\s*/i;

/** Return true when a reply has words in it, not only spaces, control tokens or a leftover role word. */
export function hasWords(text) {
  return text.replace(CONTROL_TOKEN, '').replace(LEFTOVER_ROLE_WORD, '').trim() !== '';
}
