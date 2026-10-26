"""Decides which models on a hosted platform can be tested: text-writing models only.

A platform lists every model it serves, including image, speech and embedding models. Ordeal only
tests text, so this module keeps the text models and drops the rest. It never touches the network.
The scripts/refresh_catalog.py script fetches the listings and calls these functions to save the result
in ordeal/data/models.json.

Two rules decide what is text. If the listing says which outputs a model makes, that list is trusted.
If it does not (DeepInfra, Nebius and others), the model id is checked for words that name a non-text
kind of model.
"""

import datetime
import re

# Words in a model id that mark a model which does not write text. Matching is on lower-case text,
# so "Embed" and "embed" both match. Each word is out for a reason:
#   embed, rerank       : return numbers (vectors or scores), not sentences
#   whisper, asr, transcribe : turn speech into text, so they listen rather than write
#   tts, speech, audio  : make sound, not text
#   image, diffusion, flux, sdxl, dall-e : make pictures
#   video               : makes moving pictures
#   moderation, guard   : return a label such as "unsafe", not a reply to test
#   clip                : scores how well an image and a caption match
# A vision-language model (a "VL" model) is kept, because it reads images and still writes text.
# Each word is matched at the start of a word in the id, so "embed" also matches "embedding". Embedding models
# (bge, e5, gte, MiniLM, mpnet, jina, nomic) turn text into numbers, and cannot answer a question. Guard and
# safeguard models classify text, and OCR models read images. None of these can be tested in a conversation.
EXCLUDED_NAME_WORDS = (
    "embed", "bge", "e5", "gte", "minilm", "mpnet", "jina", "nomic", "rerank", "whisper", "tts", "speech",
    "audio", "image", "diffusion", "flux", "dall", "sdxl", "video", "moderation", "guard", "safeguard", "clip",
    "asr", "transcribe", "ocr", "paddleocr",
)
# The status text for a platform whose listing was fetched and read.
STATUS_REFRESHED = "refreshed"
# The status text for a platform that refused the request because no key was given.
STATUS_NEEDS_KEY = "needs a key"


def output_modalities(model: dict) -> list | None:
    """Return the list of output kinds a model makes (such as ["text"]), or None when the listing has none.

    Hugging Face and OpenRouter put the list under "architecture". Novita puts it at the top level.
    Any other shape gives None, so the rule falls back to the id.
    """
    architecture = model.get("architecture")
    if isinstance(architecture, dict) and isinstance(architecture.get("output_modalities"), list):
        return architecture["output_modalities"]
    if isinstance(model.get("output_modalities"), list):
        return model["output_modalities"]
    return None


def is_text_model(model: dict, excluded_words=EXCLUDED_NAME_WORDS) -> bool:
    """Return True when a model writes text and so can be tested.

    A model must pass both checks. The modality list (when there is one) must be exactly ["text"], and the id
    must not contain an excluded word. Guard and OCR models write text too, so only the name catches them.
    """
    modalities = output_modalities(model)
    if modalities is not None and modalities != ["text"]:
        return False
    # The id is split into words at every character that is not a letter or digit, so "e5" in "intfloat/e5-large"
    # is a word, but "e5" inside a long random name is not. A word matches when it starts with an excluded word.
    words = re.split(r"[^a-z0-9]+", str(model.get("id", "")).lower())
    return not any(word.startswith(excluded) for word in words for excluded in excluded_words)


def listing_entries(listing) -> list | None:
    """Return the list of model entries inside a raw listing, or None when the reply has no such list.

    Most platforms wrap the list in a "data" key. A bare list is accepted too.
    """
    if isinstance(listing, dict) and isinstance(listing.get("data"), list):
        return listing["data"]
    if isinstance(listing, list):
        return listing
    return None


# A Hugging Face or OpenAI-style key: the prefix, then a long run of letters and digits. GitHub's push protection
# refuses any file that contains one, so a model whose name has this shape is left out of the saved list.
KEY_SHAPED_PATTERN = re.compile(r"(hf_|sk-)[A-Za-z0-9]{20,}")


def looks_like_key(model_id: str) -> bool:
    """Return True when the id contains something shaped like an API key."""
    return KEY_SHAPED_PATTERN.search(model_id) is not None


def catalogue_ids(listing) -> tuple[list[str], int]:
    """Return (text model ids, number of bad entries) from one raw listing.

    The ids are unique and sorted. An entry with no text id (not an object, or an id that is not a
    non-empty string) is skipped and counted, so one odd entry never stops the whole list.
    """
    entries = listing_entries(listing) or []
    ids = set()
    skipped = 0
    for entry in entries:
        model_id = entry.get("id") if isinstance(entry, dict) else None
        if not isinstance(model_id, str) or not model_id:
            skipped += 1
            continue
        # A name shaped like a key is never saved, because the saved list is published with the project.
        if looks_like_key(model_id):
            skipped += 1
            continue
        if is_text_model(entry):
            ids.add(model_id)
    return sorted(ids), skipped


def keep_previous(status: str, previous: dict, platform_id: str) -> dict:
    """Return the result for a platform that was not refreshed, using its list from the last run.

    The status text says the old list was kept, so nobody reads a stale list as a fresh one.
    When there was no earlier list, nothing is kept.
    """
    previous_platforms = previous.get("platforms", {}) if isinstance(previous, dict) else {}
    earlier = previous_platforms.get(platform_id, {}) if isinstance(previous_platforms, dict) else {}
    earlier_models = earlier.get("models") if isinstance(earlier, dict) else None
    if not isinstance(earlier_models, list) or not earlier_models:
        return {"status": status, "ids": []}
    return {"status": f"{status}; kept the previous list", "ids": list(earlier_models)}


def any_refreshed(platform_results: dict) -> bool:
    """Return True when at least one platform was fetched and read this run."""
    return any(result["status"] == STATUS_REFRESHED for result in platform_results.values())


def build_catalogue(platform_results: dict, today: str | None = None) -> dict:
    """Return the JSON-ready catalogue: the check date, then each platform's status, count and models.

    platform_results maps a platform id to {"status": ..., "ids": [...]}. The count is always the length
    of the model list, so the two can never disagree. 'today' is only given by tests.
    """
    checked = today or datetime.date.today().isoformat()
    platforms = {}
    for platform_id, result in platform_results.items():
        models = list(result["ids"])
        platforms[platform_id] = {"status": result["status"], "count": len(models), "models": models}
    return {"checked": checked, "platforms": platforms}


def keep_details(catalogue: dict, previous: dict) -> dict:
    """Return the catalogue with the details block copied from the previous file, or an empty block if there is none.

    The details (family, size and so on for each model) are typed in by hand, not fetched. A refresh rewrites
    the whole file, so this copies the block across. Without it, the next refresh would delete the details.
    """
    catalogue["details"] = previous.get("details", {}) if isinstance(previous, dict) else {}
    return catalogue
