import { EventEmitter } from "node:events";

export interface ToolUseEvent {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput: unknown;
  toolUseId: string;
  timestamp: Date;
}

export interface SessionStartEvent {
  sessionId: string;
  channelId: string;
  userId: string;
  timestamp: Date;
}

export interface ApprovalRequestedEvent {
  sessionId: string;
  toolName: string;
  tier: number;
  timestamp: Date;
}

export interface ApprovalResolvedEvent {
  sessionId: string;
  toolName: string;
  decision: "allow" | "deny";
  approverId: string;
  timestamp: Date;
}

export interface AuditEventMap {
  tool_use: [ToolUseEvent];
  session_start: [SessionStartEvent];
  approval_requested: [ApprovalRequestedEvent];
  approval_resolved: [ApprovalResolvedEvent];
}

export class AuditEmitter extends EventEmitter<AuditEventMap> {}

export const auditEmitter = new AuditEmitter();
