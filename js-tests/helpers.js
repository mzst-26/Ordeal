// Shared helpers for the JavaScript tests in this folder.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// This file sits in js-tests/, so the project folder is one level up.
const PROJECT_FOLDER_URL = new URL("../", import.meta.url);

/** Read and parse a JSON file. The path is relative to the project folder, such as "frontend/data/config.json". */
export function readJson(projectPath) {
  const path = fileURLToPath(new URL(projectPath, PROJECT_FOLDER_URL));
  return JSON.parse(readFileSync(path, "utf8"));
}
