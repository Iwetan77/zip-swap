import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "node20",
  },
  {
    entry: { "cli/zip-swap": "cli/zip-swap.ts" },
    format: ["esm"],
    dts: false,
    sourcemap: true,
    target: "node20",
  },
]);
