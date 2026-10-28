// Build for the static site. Vite reads the pages in frontend/ and writes the built site to dist/, which Netlify publishes.
// The data files and the classic fallback script are not bundled, so they are copied across as they are.

import { cpSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extname, resolve, sep } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const FRONTEND_DIR = fileURLToPath(new URL("./frontend", import.meta.url));
const DIST_DIR = fileURLToPath(new URL("./dist", import.meta.url));
// Paths under frontend/ that the pages request as they are, so they are copied into dist/ unchanged.
const COPIED_PATHS = ["data", "_redirects", "js/load-fallback.js"];

// The full-run summary lives in docs/ and is the only copy. It is served under SUMMARY_URL, so the same
// links work in the dev server and in the built site. Only these two file types are served from it.
const SUMMARY_DIR = fileURLToPath(new URL("./docs/full-run-summary", import.meta.url));
const SUMMARY_URL = "/data/full-run-summary/";
const SUMMARY_TYPES = {
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
};

/** After the build, copy the files that Vite does not bundle into dist/, including the full-run summary. */
function copyStaticFiles() {
  return {
    name: "copy-static-files",
    apply: "build",
    closeBundle() {
      for (const path of COPIED_PATHS) {
        const source = resolve(FRONTEND_DIR, path);
        if (existsSync(source)) {
          cpSync(source, resolve(DIST_DIR, path), { recursive: true });
        }
      }
      if (existsSync(SUMMARY_DIR)) {
        cpSync(SUMMARY_DIR, resolve(DIST_DIR, SUMMARY_URL.slice(1)), { recursive: true });
      }
    },
  };
}

/**
 * In the dev server, answer requests for the full-run summary from docs/, so `npm run dev` shows the same
 * files as the build. A request outside the summary folder, or for another file type, is passed on as usual.
 */
function serveFullRunSummaryInDev() {
  return {
    name: "serve-full-run-summary",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = decodeURIComponent((req.url ?? "").split("?")[0]);
        if (!path.startsWith(SUMMARY_URL)) {
          return next();
        }
        const file = resolve(SUMMARY_DIR, path.slice(SUMMARY_URL.length));
        const type = SUMMARY_TYPES[extname(file)];
        if (!file.startsWith(SUMMARY_DIR + sep) || !type || !existsSync(file)) {
          return next();
        }
        res.setHeader("Content-Type", type);
        res.end(readFileSync(file));
      });
    },
  };
}

export default defineConfig({
  root: FRONTEND_DIR,
  // The public folder is off, so Vite does not copy all of frontend/ into dist/.
  publicDir: false,
  plugins: [react(), copyStaticFiles(), serveFullRunSummaryInDev()],
  build: {
    outDir: DIST_DIR,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(FRONTEND_DIR, "index.html"),
        compare: resolve(FRONTEND_DIR, "compare.html"),
        batch: resolve(FRONTEND_DIR, "batch.html"),
        live: resolve(FRONTEND_DIR, "live.html"),
        pacing: resolve(FRONTEND_DIR, "pacing.html"),
        runs: resolve(FRONTEND_DIR, "runs.html"),
      },
    },
  },
});
