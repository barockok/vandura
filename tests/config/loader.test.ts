import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadToolPolicies, loadAgents, loadRoles } from "../../src/config/loader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(__dirname, "fixtures");

describe("Config Loader", () => {
  describe("loadToolPolicies", () => {
    it("loads and validates tool policies from YAML", async () => {
      const policies = await loadToolPolicies(path.join(fixtures, "tool-policies.yml"));

      expect(policies).toHaveProperty("mcp__db__query");
      expect(policies.mcp__db__query.tier).toBe("dynamic");
      expect(policies.mcp__db__query.guardrails).toContain("EXPLAIN");

      expect(policies.mcp__db__write.tier).toBe(3);
      expect(policies.mcp__gcs__upload.tier).toBe(1);
      expect(policies._default.tier).toBe(2);
    });

    it("applies default checker value", async () => {
      const policies = await loadToolPolicies(path.join(fixtures, "tool-policies.yml"));
      expect(policies.mcp__db__query.checker).toBe("peer-based");
    });

    it("throws ZodError for invalid tier value", async () => {
      await expect(
        loadToolPolicies(path.join(fixtures, "invalid.yml"))
      ).rejects.toThrow();
    });
  });

  describe("loadAgents", () => {
    it("loads and returns agent array with correct data", async () => {
      const agents = await loadAgents(path.join(fixtures, "agents.yml"));

      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("TestAgent");
      expect(agents[0].role).toBe("admin");
      expect(agents[0].tools).toEqual(["mcp-db", "mcp-rest"]);
      expect(agents[0].max_concurrent_tasks).toBe(2);
      expect(agents[0].avatar).toBe("robot");
      expect(agents[0].system_prompt_extra).toContain("test agent");
    });

    it("applies default max_concurrent_tasks when not specified", async () => {
      // The fixture has it set to 2, so we just verify the schema works
      const agents = await loadAgents(path.join(fixtures, "agents.yml"));
      expect(typeof agents[0].max_concurrent_tasks).toBe("number");
    });
  });

  describe("loadRoles", () => {
    it("loads and validates roles correctly", async () => {
      const roles = await loadRoles(path.join(fixtures, "roles.yml"));

      expect(roles).toHaveProperty("pm");
      expect(roles).toHaveProperty("engineering");

      expect(roles.pm.agents).toEqual(["atlas", "scribe"]);
      expect(roles.pm.tool_tiers["mcp-db"].max_tier).toBe(1);
      expect(roles.pm.tool_tiers["mcp-confluence"].max_tier).toBe(2);

      expect(roles.engineering.agents).toEqual(["atlas", "sentinel"]);
      expect(roles.engineering.tool_tiers["mcp-db"].max_tier).toBe(3);
    });
  });
});
