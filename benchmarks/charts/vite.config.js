// Build config for the benchmark page only. It builds benchmarks/charts/index.html into benchmarks/charts/dist, so the
// benchmark bundle (with ECharts) is kept apart from the site build at the repository root (vite.config.js there),
// which never reads this folder. The Vega code is imported from frontend/js/compare, exactly as the site imports it.
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));

export default {
  root: HERE,
  publicDir: false,
  build: {
    outDir: resolve(HERE, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(HERE, "index.html"),
    },
  },
};
