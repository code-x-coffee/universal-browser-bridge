import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Vitest 4+ no longer excludes dist/ by default; only run the TypeScript sources.
    include: ["src/**/*.test.ts"],
  },
});
