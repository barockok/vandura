import { z } from "zod";

export const ToolPolicySchema = z.object({
  tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal("dynamic")]),
  guardrails: z.string().nullable().optional(),
  checker: z.enum(["role-based", "peer-based", "any"]).optional().default("peer-based"),
  connection_type: z.enum(["shared", "per-user"]).optional().default("shared"),
});

export const ToolPoliciesSchema = z.record(z.string(), ToolPolicySchema);

export const AgentSchema = z.object({
  name: z.string(),
  avatar: z.string().optional(),
  role: z.string(),
  personality: z.string().optional(),
  tools: z.array(z.string()),
  max_concurrent_tasks: z.number().default(1),
  system_prompt_extra: z.string().optional(),
});

export const AgentsConfigSchema = z.object({
  agents: z.array(AgentSchema),
});

export const RolePermissionSchema = z.object({
  agents: z.array(z.string()),
  tool_tiers: z.record(z.string(), z.object({ max_tier: z.number() })),
});

export const RolesConfigSchema = z.object({
  roles: z.record(z.string(), RolePermissionSchema),
});

// Export inferred types
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;
export type ToolPolicies = z.infer<typeof ToolPoliciesSchema>;
export type AgentConfig = z.infer<typeof AgentSchema>;
export type RolePermission = z.infer<typeof RolePermissionSchema>;
