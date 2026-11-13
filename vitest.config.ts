import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/unit/**/*.test.ts"],
    // full 180 s matches run in these tests; the real sim needs a few hundred ms each
    testTimeout: 120_000,
  },
});
