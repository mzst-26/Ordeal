"""Checks for the model catalog in config.json and the public export that copies it to the site."""

import importlib.util
import json
import unittest
from pathlib import Path

PROJECT_FOLDER = Path(__file__).resolve().parent.parent
CONFIG_PATH = PROJECT_FOLDER / "config.json"
EXPORT_PATH = PROJECT_FOLDER / "scripts" / "export_site_data.py"

# The brief said 27 models, but the list it gave has 29 rows, and the endpoint serves all 29 chat models.
EXPECTED_CATALOG_SIZE = 29
EXPECTED_DEFAULT_MODELS = [
    "Qwen/Qwen3-30B-A3B-Instruct-2507",
    "google/gemma-3-27b-it",
    "nvidia/nemotron-3-super-120b-a12b",
]
CATALOG_FIELDS = (
    "id",
    "provider",
    "kind",
    "price_input_per_million_usd",
    "price_output_per_million_usd",
    "region",
    "verified",
)
ALLOWED_KINDS = ("text", "vision")
EMBEDDING_MODEL_ID = "Qwen/Qwen3-Embedding-8B"
# Model details shown on the batch page: context window, reasoning mode, rank and where the rank came from.
DETAIL_FIELDS = ("context_tokens", "reasoning", "industry_rank", "rank_basis")
REASONING_VALUES = ("yes", "no", None)


def load_config():
    """Read config.json and return its contents."""
    with open(CONFIG_PATH, encoding="utf-8") as handle:
        return json.load(handle)


def load_export_module():
    """Import scripts/export_site_data.py by its file path, without running its main()."""
    spec = importlib.util.spec_from_file_location("export_site_data", EXPORT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CatalogShapeTest(unittest.TestCase):
    """The catalog list in config.json has one object per model, with the fields the pages use."""

    def setUp(self):
        self.catalog = load_config()["catalog"]

    def test_catalog_is_a_list_of_the_expected_size(self):
        self.assertIsInstance(self.catalog, list)
        self.assertEqual(len(self.catalog), EXPECTED_CATALOG_SIZE)

    def test_every_entry_has_all_the_fields(self):
        for entry in self.catalog:
            self.assertIsInstance(entry, dict)
            for field in CATALOG_FIELDS:
                self.assertIn(field, entry, f"{entry.get('id')} has no {field}")

    def test_kind_is_text_or_vision(self):
        for entry in self.catalog:
            self.assertIn(entry["kind"], ALLOWED_KINDS, entry["id"])

    def test_prices_are_numbers_or_null(self):
        for entry in self.catalog:
            for field in ("price_input_per_million_usd", "price_output_per_million_usd"):
                value = entry[field]
                self.assertTrue(value is None or (isinstance(value, (int, float)) and not isinstance(value, bool)),
                                f"{entry['id']} {field} is {value!r}")

    def test_region_and_provider_are_text(self):
        for entry in self.catalog:
            self.assertIsInstance(entry["provider"], str, entry["id"])
            self.assertIsInstance(entry["region"], str, entry["id"])

    def test_verified_is_a_boolean(self):
        for entry in self.catalog:
            self.assertIsInstance(entry["verified"], bool, entry["id"])

    def test_ids_are_unique(self):
        ids = [entry["id"] for entry in self.catalog]
        self.assertEqual(len(ids), len(set(ids)))

    def test_embedding_model_is_not_in_the_catalog(self):
        ids = [entry["id"] for entry in self.catalog]
        self.assertNotIn(EMBEDDING_MODEL_ID, ids)
        self.assertFalse(any("Embedding" in model_id for model_id in ids))


class DefaultModelsTest(unittest.TestCase):
    """The default run uses the same three models as before the catalog was added."""

    def test_models_list_is_unchanged(self):
        self.assertEqual(load_config()["models"], EXPECTED_DEFAULT_MODELS)

    def test_default_models_are_in_the_catalog(self):
        catalog_ids = [entry["id"] for entry in load_config()["catalog"]]
        for model_id in EXPECTED_DEFAULT_MODELS:
            self.assertIn(model_id, catalog_ids)


class PublicExportTest(unittest.TestCase):
    """The public export copies the catalog, so the site can show the model choices."""

    def test_public_config_keeps_the_catalog_and_the_default_models(self):
        export = load_export_module()
        public = export.public_config(load_config())
        self.assertIn("catalog", public)
        self.assertEqual(public["models"], EXPECTED_DEFAULT_MODELS)


class CatalogDetailsTest(unittest.TestCase):
    """Each catalog entry has the context, reasoning and rank fields that the batch page shows."""

    def setUp(self):
        self.catalog = load_config()["catalog"]

    def test_every_entry_has_the_detail_fields(self):
        for entry in self.catalog:
            for field in DETAIL_FIELDS:
                self.assertIn(field, entry, f"{entry.get('id')} has no {field}")

    def test_industry_ranks_are_unique_integers_from_1_to_29(self):
        ranks = [entry["industry_rank"] for entry in self.catalog]
        for rank in ranks:
            self.assertIsInstance(rank, int, f"rank {rank!r} is not an integer")
            self.assertNotIsInstance(rank, bool)
        self.assertEqual(len(ranks), len(set(ranks)), "two models share a rank")
        self.assertEqual(sorted(ranks), list(range(1, EXPECTED_CATALOG_SIZE + 1)))

    def test_context_tokens_is_none_or_a_positive_integer(self):
        for entry in self.catalog:
            value = entry["context_tokens"]
            if value is None:
                continue
            self.assertIsInstance(value, int, f"{entry['id']} context_tokens is {value!r}")
            self.assertNotIsInstance(value, bool, f"{entry['id']} context_tokens is a bool")
            self.assertGreater(value, 0, f"{entry['id']} context_tokens is {value}")

    def test_reasoning_is_yes_no_or_none(self):
        for entry in self.catalog:
            self.assertIn(entry["reasoning"], REASONING_VALUES, entry["id"])

    def test_rank_basis_is_a_non_empty_string(self):
        for entry in self.catalog:
            basis = entry["rank_basis"]
            self.assertIsInstance(basis, str, entry["id"])
            self.assertTrue(basis.strip(), f"{entry['id']} has an empty rank_basis")


if __name__ == "__main__":
    unittest.main()
