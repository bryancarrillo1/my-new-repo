import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/*/test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    globalSetup: ["scripts/test-global-setup.ts"],
    // Integration tests share one Postgres; run files one at a time.
    fileParallelism: false,
  },
});
