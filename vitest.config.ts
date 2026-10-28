import { defineConfig } from "vitest/config";
import { TEST_ENV } from "./scripts/test-env.ts";

export default defineConfig({
  test: {
    include: ["apps/*/test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    globalSetup: ["scripts/test-global-setup.ts"],
    env: TEST_ENV,
    // Integration tests share one Postgres; run files one at a time.
    fileParallelism: false,
  },
});
