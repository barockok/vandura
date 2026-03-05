import { config } from "dotenv";
config();

export const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://vandura:vandura@localhost:5432/vandura",
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
  SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN ?? "",
  SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN ?? "",
  SLACK_CHANNEL_ID: process.env.SLACK_CHANNEL_ID ?? "",
} as const;
