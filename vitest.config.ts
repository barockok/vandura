import { defineConfig } from "vitest/config";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Auto-detect colima Docker socket for Testcontainers
const colimaSocket = join(homedir(), ".colima/default/docker.sock");
if (!process.env.DOCKER_HOST && existsSync(colimaSocket)) {
  process.env.DOCKER_HOST = `unix://${colimaSocket}`;
}
process.env.TESTCONTAINERS_RYUK_DISABLED = "true";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    exclude: ["tests/e2e/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
    },
  },
});
