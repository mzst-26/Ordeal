"""Tests for ordeal/catalog.py and the pure part of scripts/refresh_catalog.py.

Everything here is offline. The listings below copy the shape each platform really returns
(Hugging Face and OpenRouter put modalities under "architecture", Novita puts them at the top level,
and the other platforms have no modality field at all). No test makes a network call.
"""

import json
import sys
import unittest
from pathlib import Path

from ordeal import catalog

# scripts/ is not a package, so it is added to the import path to make refresh_catalog importable.
SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import refresh_catalog  # noqa: E402  (needs scripts/ on sys.path first)

# The two saved copies of the model lists: the one the Python code reads, and the one the site reads.
PROJECT_DIR = Path(__file__).resolve().parent.parent
SAVED_LIST_PATHS = (PROJECT_DIR / "ordeal" / "data" / "models.json", PROJECT_DIR / "site" / "data" / "models.json")


def huggingface_model(model_id, modalities):
    """A model shaped like the Hugging Face router reply: modalities sit under 'architecture'."""
    return {"id": model_id, "architecture": {"output_modalities": modalities}}


class EmbeddingAndOcrNameTests(unittest.TestCase):
    """Embedding, guard and OCR models must be dropped by their names, because their listings give no modalities."""

    def test_bge_and_e5_embedding_models_are_dropped(self):
        for model_id in ("BAAI/bge-m3", "intfloat/e5-large-v2", "BAAI/bge-base-en-v1.5"):
            self.assertFalse(catalog.is_text_model({"id": model_id}), model_id)

    def test_sentence_embedding_models_are_dropped(self):
        self.assertFalse(catalog.is_text_model({"id": "sentence-transformers/all-MiniLM-L6-v2"}))

    def test_guard_and_ocr_models_are_dropped(self):
        for model_id in ("meta-llama/Llama-Guard-4-12B", "openai/gpt-oss-safeguard-20b", "deepseek-ai/deepseek-ocr-2", "paddlepaddle/paddleocr-vl"):
            self.assertFalse(catalog.is_text_model({"id": model_id}), model_id)

    def test_guard_model_is_dropped_even_when_its_modalities_say_text(self):
        model = {"id": "meta-llama/Llama-Guard-4-12B", "architecture": {"output_modalities": ["text"]}}
        self.assertFalse(catalog.is_text_model(model))

    def test_an_e5_inside_a_long_random_name_is_not_a_word_match(self):
        self.assertTrue(catalog.is_text_model({"id": "someone/model-Gensyn-7Bxe5rKPq"}))


class ModalityRuleTests(unittest.TestCase):
    """A model with a modality list is kept only when that list is exactly ["text"]."""

    def test_huggingface_text_only_model_is_kept(self):
        self.assertTrue(catalog.is_text_model(huggingface_model("org/chat", ["text"])))

    def test_huggingface_text_and_image_model_is_dropped(self):
        self.assertFalse(catalog.is_text_model(huggingface_model("org/vision", ["text", "image"])))

    def test_openrouter_shape_is_read_the_same_way(self):
        model = {"id": "vendor/model:free", "architecture": {"output_modalities": ["text"]}}
        self.assertTrue(catalog.is_text_model(model))

    def test_novita_shape_with_modalities_at_top_level(self):
        text_model = {"id": "novita/chat", "output_modalities": ["text"], "model_type": "chat"}
        image_model = {"id": "novita/picture", "output_modalities": ["image"], "model_type": "chat"}
        self.assertTrue(catalog.is_text_model(text_model))
        self.assertFalse(catalog.is_text_model(image_model))

    def test_modality_list_wins_over_a_name_that_looks_like_text(self):
        # The name says "chat" but the platform says it only makes images, so the platform wins.
        model = {"id": "org/chat-image", "architecture": {"output_modalities": ["image"]}}
        self.assertFalse(catalog.is_text_model(model))


class NameRuleTests(unittest.TestCase):
    """With no modality field, the id decides, using the excluded word list."""

    def test_embedding_model_is_dropped(self):
        self.assertFalse(catalog.is_text_model({"id": "Qwen/Qwen3-Embedding-8B"}))

    def test_plain_chat_model_is_kept(self):
        self.assertTrue(catalog.is_text_model({"id": "openai/gpt-oss-120b"}))

    def test_name_match_ignores_case(self):
        self.assertFalse(catalog.is_text_model({"id": "Org/WHISPER-large"}))

    def test_empty_modality_list_is_dropped(self):
        # An empty list says the model makes no output at all, so it is not a text model.
        self.assertFalse(catalog.is_text_model(huggingface_model("org/empty", [])))

    def test_custom_word_list_is_used_when_given(self):
        self.assertFalse(catalog.is_text_model({"id": "org/special"}, excluded_words=("special",)))


class VisionNameRuleTests(unittest.TestCase):
    """Vision models are dropped, because the experiments send text only and a model that reads images is not a test target."""

    def test_vision_word_drops_a_model(self):
        for model_id in ("CohereLabs/aya-vision-32b", "deepseek-ai/DeepSeek-V4-Flash-Vision-Exp", "GitMylo/nsfwvision-v5_qwen3.5-9b-sft"):
            self.assertFalse(catalog.is_text_model({"id": model_id}), model_id)

    def test_vl_word_drops_a_model(self):
        for model_id in ("Qwen/Qwen2.5-VL-7B-Instruct", "org/qwen-vl", "org/model_vl_chat"):
            self.assertFalse(catalog.is_text_model({"id": model_id}), model_id)

    def test_multimodal_word_drops_a_model(self):
        self.assertFalse(catalog.is_text_model({"id": "org/gemma-3-4B-multimodal-ft"}))

    def test_vl_inside_a_longer_word_is_not_a_vl_token(self):
        # "vl" only counts as its own word, so names such as "vlad" and "vllm" are kept.
        for model_id in ("org/vlad-7b-chat", "org/vllm-chat-7b"):
            self.assertTrue(catalog.is_text_model({"id": model_id}), model_id)

    def test_image_input_in_the_listing_drops_a_model(self):
        model = {"id": "org/chat", "architecture": {"input_modalities": ["text", "image"], "output_modalities": ["text"]}}
        self.assertFalse(catalog.is_text_model(model))

    def test_image_input_at_the_top_level_drops_a_model(self):
        model = {"id": "novita/chat", "input_modalities": ["text", "image"], "output_modalities": ["text"]}
        self.assertFalse(catalog.is_text_model(model))

    def test_text_only_input_is_kept(self):
        model = {"id": "org/chat", "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]}}
        self.assertTrue(catalog.is_text_model(model))


class StoredCatalogueTests(unittest.TestCase):
    """The saved lists that ship with the project never hold a vision model."""

    def test_no_saved_list_holds_a_vision_model(self):
        offenders = []
        for path in SAVED_LIST_PATHS:
            saved = json.loads(path.read_text(encoding="utf-8"))
            for platform_id, platform in saved["platforms"].items():
                for model_id in platform["models"]:
                    if catalog.is_vision_name(model_id):
                        offenders.append(f"{path.relative_to(PROJECT_DIR)} {platform_id}: {model_id}")
        self.assertEqual(offenders, [])


class CatalogueIdsTests(unittest.TestCase):
    def test_an_id_shaped_like_a_key_is_never_saved(self):
        listing = [{"id": "someone/model-hf_abcdefghijklmnopqrstuvwxyz"}, {"id": "org/plain-chat-model"}]
        ids, skipped = catalog.catalogue_ids(listing)
        self.assertEqual(ids, ["org/plain-chat-model"])
        self.assertEqual(skipped, 1)

    """catalogue_ids turns a raw listing into sorted, unique, text-only ids, and counts the bad entries."""

    def test_returns_sorted_unique_text_ids_and_skip_count(self):
        listing = {
            "data": [
                {"id": "zeta/chat"},
                {"id": "alpha/chat"},
                {"id": "alpha/chat"},
                {"id": "Qwen/Qwen3-Embedding-8B"},
            ]
        }
        ids, skipped = catalog.catalogue_ids(listing)
        self.assertEqual(ids, ["alpha/chat", "zeta/chat"])
        self.assertEqual(skipped, 0)

    def test_bad_entries_are_skipped_and_counted_not_crashed_on(self):
        listing = {
            "data": [
                {"id": "good/chat"},
                {"name": "no id here"},
                {"id": 42},
                {"id": None},
                {"id": ""},
                "just a string",
                None,
            ]
        }
        ids, skipped = catalog.catalogue_ids(listing)
        self.assertEqual(ids, ["good/chat"])
        self.assertEqual(skipped, 6)

    def test_a_bare_list_is_accepted_as_the_listing(self):
        ids, skipped = catalog.catalogue_ids([{"id": "a/b"}])
        self.assertEqual((ids, skipped), (["a/b"], 0))

    def test_a_reply_with_no_model_list_gives_no_ids(self):
        self.assertEqual(catalog.catalogue_ids({"error": "nope"}), ([], 0))
        self.assertIsNone(catalog.listing_entries({"error": "nope"}))


class BuildCatalogueTests(unittest.TestCase):
    """build_catalogue makes the JSON-ready dict, with counts that match the model lists."""

    def test_counts_match_the_models_and_the_date_is_iso(self):
        results = {
            "groq": {"status": "refreshed", "ids": ["a/one", "a/two"]},
            "nebius": {"status": "needs a key", "ids": []},
        }
        built = catalog.build_catalogue(results, today="2026-10-25")
        self.assertEqual(built["checked"], "2026-10-25")
        self.assertEqual(built["platforms"]["groq"], {"status": "refreshed", "count": 2, "models": ["a/one", "a/two"]})
        self.assertEqual(built["platforms"]["nebius"], {"status": "needs a key", "count": 0, "models": []})

    def test_default_date_is_today_in_iso_form(self):
        built = catalog.build_catalogue({})
        self.assertRegex(built["checked"], r"^\d{4}-\d{2}-\d{2}$")


class KeepDetailsTests(unittest.TestCase):
    """keep_details carries the hand-written details block over a refresh, so a refresh never drops it."""

    def test_copies_the_details_block_from_the_previous_file(self):
        catalogue = {"checked": "2026-10-26", "platforms": {}}
        previous = {"checked": "2026-10-25", "details": {"a/b": {"family": "A"}}, "platforms": {}}
        result = catalog.keep_details(catalogue, previous)
        self.assertEqual(result["details"], {"a/b": {"family": "A"}})
        self.assertEqual(result["platforms"], {})

    def test_gives_an_empty_block_when_the_previous_file_has_none(self):
        result = catalog.keep_details({"checked": "2026-10-26", "platforms": {}}, {})
        self.assertEqual(result["details"], {})


class KeepPreviousTests(unittest.TestCase):
    """A platform that was not refreshed keeps its last list, and its status says so."""

    def test_failed_platform_keeps_its_previous_models(self):
        previous = {"platforms": {"groq": {"status": "refreshed", "count": 1, "models": ["a/one"]}}}
        kept = catalog.keep_previous("failed: the server answered 500", previous, "groq")
        self.assertEqual(kept["ids"], ["a/one"])
        self.assertIn("kept the previous list", kept["status"])
        self.assertIn("500", kept["status"])

    def test_platform_with_no_previous_entry_keeps_nothing(self):
        kept = catalog.keep_previous("failed: could not reach the server", {}, "groq")
        self.assertEqual(kept["ids"], [])
        self.assertEqual(kept["status"], "failed: could not reach the server")

    def test_any_refreshed_is_false_when_every_call_failed(self):
        results = {
            "groq": {"status": "failed: the server answered 500", "ids": []},
            "nebius": {"status": "needs a key", "ids": []},
        }
        self.assertFalse(catalog.any_refreshed(results))

    def test_any_refreshed_is_true_when_one_call_worked(self):
        results = {"groq": {"status": "refreshed", "ids": ["a/b"]}}
        self.assertTrue(catalog.any_refreshed(results))


class ShouldWriteTests(unittest.TestCase):
    """The refresh script writes models.json only when at least one platform was refreshed."""

    def test_does_not_write_when_every_call_fails(self):
        results = {
            "groq": {"status": "failed: could not reach the server", "ids": []},
            "huggingface": {"status": "failed: the reply was not JSON", "ids": []},
        }
        self.assertFalse(refresh_catalog.should_write(results))

    def test_writes_when_one_platform_refreshed(self):
        results = {
            "groq": {"status": "failed: could not reach the server", "ids": []},
            "huggingface": {"status": "refreshed", "ids": ["a/b"]},
        }
        self.assertTrue(refresh_catalog.should_write(results))


class SavedListLocationTests(unittest.TestCase):
    """The saved model list is written into ordeal/data, beside the platform list it goes with."""

    def test_the_refresh_script_writes_into_the_data_folder(self):
        data_folder = Path(catalog.__file__).resolve().parent / "data"
        self.assertEqual(refresh_catalog.OUTPUT_PATH, data_folder / "models.json")


if __name__ == "__main__":
    unittest.main()
