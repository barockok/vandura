import { join } from "node:path";
import { config } from "dotenv";
config();

export const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://vandura:vandura@localhost:5432/vandura",
  DB_TOOL_CONNECTION_URL: process.env.DB_TOOL_CONNECTION_URL ?? process.env.DATABASE_URL ?? "postgres://vandura:vandura@localhost:5432/vandura",
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
  CLAUDE_SESSIONS_DIR: process.env.CLAUDE_SESSIONS_DIR,
  CLAUDE_CODE_PATH: process.env.CLAUDE_CODE_PATH,
  KMS_PROVIDER: process.env.KMS_PROVIDER ?? "local",
  KMS_LOCAL_KEY_FILE: process.env.KMS_LOCAL_KEY_FILE ?? ".dev-master-key",
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? "vandura",
  S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? "vandura123",
  S3_BUCKET: process.env.S3_BUCKET ?? "vandura-results",
  S3_REGION: process.env.S3_REGION ?? "us-east-1",
  S3_SIGNED_URL_EXPIRY: Number(process.env.S3_SIGNED_URL_EXPIRY ?? "86400"),
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5-20250929",
  SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN ?? "",
  SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN ?? "",
  SLACK_CHANNEL_ID: process.env.SLACK_CHANNEL_ID ?? "",
  VANDURA_MEMORY_DIR: process.env.VANDURA_MEMORY_DIR || join(process.env.HOME || "/root", ".vandura", "memory"),
  CLAUDE_DEBUG: process.env.CLAUDE_DEBUG === "true" || process.env.CLAUDE_DEBUG === "1",
  EXPORT_SUMMARY_MAX_SIZE: Number(process.env.EXPORT_SUMMARY_MAX_SIZE ?? "51200"),
} as const;
