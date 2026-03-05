import fs from "node:fs/promises";
import YAML from "yaml";
import {
  ToolPoliciesSchema,
  AgentsConfigSchema,
  RolesConfigSchema,
} from "./types.js";
import type { ToolPolicies, AgentConfig, RolePermission } from "./types.js";

async function readYaml(filePath: string): Promise<unknown> {
  const content = await fs.readFile(filePath, "utf-8");
  return YAML.parse(content);
}

export async function loadToolPolicies(filePath: string): Promise<ToolPolicies> {
  const raw = (await readYaml(filePath)) as Record<string, unknown>;
  const policies = raw.tool_policies ?? raw;
  return ToolPoliciesSchema.parse(policies);
}

export async function loadAgents(filePath: string): Promise<AgentConfig[]> {
  const raw = await readYaml(filePath);
  const config = AgentsConfigSchema.parse(raw);
  return config.agents;
}

export async function loadRoles(filePath: string): Promise<Record<string, RolePermission>> {
  const raw = await readYaml(filePath);
  const config = RolesConfigSchema.parse(raw);
  return config.roles;
}
