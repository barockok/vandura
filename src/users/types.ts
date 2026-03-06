// src/users/types.ts
export interface VanduraUser {
  id: string;
  slackId: string;
  displayName: string | null;
  role: string;
  toolOverrides: Record<string, { max_tier?: number; blocked?: boolean }>;
  isActive: boolean;
  onboardedAt: Date | null;
  createdAt: Date;
}
