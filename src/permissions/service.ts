// src/permissions/service.ts
import type { RolePermission } from "../config/types.js";
import type { VanduraUser } from "../users/types.js";

export interface AccessCheckResult {
  allowed: boolean;
  reason?: string;
}

export class PermissionService {
  constructor(private roles: Record<string, RolePermission>) {}

  checkToolAccess(user: VanduraUser, toolName: string, tier: number): AccessCheckResult {
    if (!user.isActive) {
      return { allowed: false, reason: "User account is inactive." };
    }

    if (!user.onboardedAt) {
      return { allowed: false, reason: "User has not completed onboarding." };
    }

    // Check per-user overrides first
    const override = user.toolOverrides[toolName];
    if (override?.blocked) {
      return { allowed: false, reason: `Tool "${toolName}" is blocked for this user.` };
    }
    if (override?.max_tier !== undefined) {
      if (tier <= override.max_tier) {
        return { allowed: true };
      }
      return { allowed: false, reason: `Tool "${toolName}" max tier for this user is ${override.max_tier}.` };
    }

    // Check role-based permissions
    const rolePerms = this.roles[user.role];
    if (!rolePerms) {
      return tier <= 1
        ? { allowed: true }
        : { allowed: false, reason: `Unknown role "${user.role}", max tier is 1.` };
    }

    const toolTier = rolePerms.tool_tiers[toolName];
    if (!toolTier) {
      return tier <= 1
        ? { allowed: true }
        : { allowed: false, reason: `Tool "${toolName}" not in role "${user.role}" permissions, max tier is 1.` };
    }

    if (tier <= toolTier.max_tier) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `Role "${user.role}" allows "${toolName}" up to max tier ${toolTier.max_tier}, but tier ${tier} was requested.`,
    };
  }

  getAvailableTools(role: string): string[] {
    const rolePerms = this.roles[role];
    if (!rolePerms) return [];
    return Object.entries(rolePerms.tool_tiers)
      .filter(([, v]) => v.max_tier > 0)
      .map(([k]) => k);
  }
}
