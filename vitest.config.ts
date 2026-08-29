import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: { reporter: ["text", "json-summary"] },
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
