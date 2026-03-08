import type { JobsOptions } from "bullmq";

/**
 * Job names in the Vandura queue
 */
export type JobName =
  | "start_session"
  | "continue_session"
  | "approve_tool";

/**
 * Base job data shared by all jobs
 */
export interface BaseJobData {
  timestamp: number;
}

/**
 * Start a new agent session
 */
export interface StartSessionJobData extends BaseJobData {
  type: "start_session";
  channelId: string;
  userId: string;
  message: string;
  threadTs?: string;
}

/**
 * Continue an existing session with user input
 */
export interface ContinueSessionJobData extends BaseJobData {
  type: "continue_session";
  sessionId: string;
  message: string;
}

/**
 * Resume session after tool approval decision
 */
export interface ApproveToolJobData extends BaseJobData {
  type: "approve_tool";
  sessionId: string;
  toolUseId: string;
  decision: "allow" | "deny";
  approverId: string;
}

/**
 * Union of all job data types
 */
export type JobData =
  | StartSessionJobData
  | ContinueSessionJobData
  | ApproveToolJobData;

/**
 * Job result returned by workers
 */
export interface JobResult {
  success: boolean;
  sessionId?: string;
  message?: string;
  error?: string;
}

/**
 * Default job options for the queue
 */
export const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: {
    type: "exponential",
    delay: 1000,
  },
  removeOnComplete: {
    count: 100,
    age: 24 * 3600, // 24 hours
  },
  removeOnFail: {
    count: 50,
    age: 7 * 24 * 3600, // 7 days
  },
};

/**
 * Session status values
 */
export type SessionStatus =
  | "active"
  | "awaiting_approval"
  | "completed"
  | "failed";

/**
 * Session record from database
 */
export interface Session {
  id: string;
  channelId: string;
  userId: string;
  threadTs: string | null;
  sandboxPath: string;
  serverSessionId?: string | null; // Server-side session ID for conversation continuity
  status: SessionStatus;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Pending approval record from database
 */
export interface PendingApproval {
  id: string;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
  tier: number;
  requestedAt: Date;
  resolvedAt: Date | null;
  decision: "allow" | "deny" | null;
  approverId: string | null;
}