"""Flags answer keys that the AI screen disagrees with, and summarises how many keys are checked.

An answer key is the letter we say is correct for a question. A judge that sees the key tends to agree
with it, so the screen is built to answer blind: a model sees only the question and its options, never
the key. The AI is only a flag. It says "a person should look at this one". A human makes the decision,
and only two blind human answers that agree can mark a key as verified (see ordeal/data/key_checks.json).

This module holds the pure rules: which questions to flag, and how to count the checks. Those rules
need no network, so the tests can run them on plain letters.
"""

# Reasons written next to a flagged question. They are plain words, so a person can read them at a glance.
REASON_DIFFERS = "differs from key"
REASON_DISAGREE = "screen answers disagree"


def flag_reasons(key, letters):
    """Return the reasons a question is flagged, or [] when it is not flagged.

    The letters are the screen answers from every model and every sample. A None means the reply had no
    clear letter. A None is not an answer, so it is left out here; the caller reports those separately.
    """
    # Only real letters count. A None reply says nothing about the key, so it cannot cause a flag.
    clear_letters = [letter for letter in letters if letter is not None]
    reasons = []
    # Any clear letter that is not the key means the screen thinks the key is wrong.
    if any(letter != key for letter in clear_letters):
        reasons.append(REASON_DIFFERS)
    # Two different letters from the screen mean it is unsure, even if one of them matches the key.
    if len(set(clear_letters)) > 1:
        reasons.append(REASON_DISAGREE)
    return reasons


def letters_for_question(models_results):
    """Return every screen letter for one question, pooled across all models, in model order.

    models_results maps a model name to its list of samples. Each sample is a dict with a "letter" key,
    which is None when that call failed or gave no clear answer.
    """
    letters = []
    for samples in models_results.values():
        for sample in samples:
            letters.append(sample["letter"])
    return letters


def flagged_questions(questions, screen):
    """Return {question id: details} for each flagged question, and nothing for the others.

    The details hold the key and the screen letters, because a person needs both to decide.
    Only flagged questions appear here, so no other question's key is ever passed on.
    """
    flagged = {}
    for question in questions:
        question_id = question["id"]
        letters = letters_for_question(screen.get(question_id, {}))
        reasons = flag_reasons(question["correct"], letters)
        if reasons:
            flagged[question_id] = {"key": question["correct"], "screen": letters, "reasons": reasons}
    return flagged


def summarize_checks(checks, flagged_ids):
    """Count verified and unchecked entries in key_checks, and the flagged ids, for the summary line.

    A question can be both unchecked and flagged. The counts are reported separately, so they can overlap.
    """
    verified = sum(1 for entry in checks if entry["status"] == "verified")
    unchecked = sum(1 for entry in checks if entry["status"] == "unchecked")
    return {"verified": verified, "unchecked": unchecked, "flagged": len(flagged_ids)}
