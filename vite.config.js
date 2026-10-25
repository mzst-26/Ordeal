// Build for the static site. Vite reads the pages in site/ and writes the built site to dist/, which Netlify publishes.
// The data files and the classic fallback script are not bundled, so they are copied across as they are.

import { cpSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const SITE_DIR = fileURLToPath(new URL("./site", import.meta.url));
const DIST_DIR = fileURLToPath(new URL("./dist", import.meta.url));
// Paths under site/ that the pages request as they are, so they are copied into dist/ unchanged.
const COPIED_PATHS = ["data", "_redirects", "js/load-fallback.js"];

/** After the build, copy the files that Vite does not bundle into dist/. */
function copyStaticFiles() {
  return {
    name: "copy-static-files",
    apply: "build",
    closeBundle() {
      for (const path of COPIED_PATHS) {
        const source = resolve(SITE_DIR, path);
        if (existsSync(source)) {
          cpSync(source, resolve(DIST_DIR, path), { recursive: true });
        }
      }
    },
  };
}

export default defineConfig({
  root: SITE_DIR,
  // The public folder is off, so Vite does not copy all of site/ into dist/.
  publicDir: false,
  plugins: [react(), copyStaticFiles()],
  build: {
    outDir: DIST_DIR,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(SITE_DIR, "index.html"),
        compare: resolve(SITE_DIR, "compare.html"),
        batch: resolve(SITE_DIR, "batch.html"),
        live: resolve(SITE_DIR, "live.html"),
      },
    },
  },
});
