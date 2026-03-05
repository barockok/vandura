# Vandura Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Slack-integrated AI agent system with tiered approval workflows, MCP-based tool integrations, and full audit trails — starting with Postgres MCP and MinIO for object storage.

**Architecture:** Slack Bolt SDK (Socket Mode) receives events, routes to a Thread Manager that creates per-thread Claude Agent SDK instances. An Approval Engine middleware intercepts tool calls, applies configurable tier/guardrail policies, and gates execution on user confirmation or checker approval. MCP servers (Postgres, S3/MinIO) provide the actual tool implementations.

**Tech Stack:** TypeScript, Node.js 22, Slack Bolt SDK, Anthropic Claude Agent SDK, Vitest, Testcontainers, Docker Compose, PostgreSQL 16, MinIO, GitHub Actions

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `eslint.config.js`
- Create: `src/index.ts` (empty entry point)

**Step 1: Initialize the project**

```bash
npm init -y
```

**Step 2: Install core dependencies**

```bash
npm install @slack/bolt @anthropic-ai/sdk @anthropic-ai/claude-agent-sdk dotenv pg zod yaml @aws-sdk/client-s3 @aws-sdk/s3-request-presigner uuid
```

**Step 3: Install dev dependencies**

```bash
npm install -D typescript @types/node @types/pg vitest @testcontainers/postgresql testcontainers eslint @eslint/js typescript-eslint tsx
```

**Step 4: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 5: Create vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
```

**Step 6: Create eslint.config.js**

```javascript
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  { ignores: ["dist/", "node_modules/"] }
);
```

**Step 7: Add scripts to package.json**

```json
{
  "type": "module",
  "scripts": {
    "build": "tsc",
    "dev": "tsx --watch src/index.ts",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "docker compose -f docker-compose.test.yml up --build --abort-on-container-exit",
    "lint": "eslint src/",
    "typecheck": "tsc --noEmit",
    "db:migrate": "tsx src/db/migrate.ts"
  }
}
```

**Step 8: Create empty entry point**

```typescript
// src/index.ts
console.log("Vandura starting...");
```

**Step 9: Verify build works**

Run: `npm run build && npm run typecheck && npm run lint`
Expected: All pass, no errors

**Step 10: Commit**

```bash
git add -A
git commit -m "feat: project scaffolding with TypeScript, Vitest, ESLint"
```

---

## Task 2: Docker Compose for Dev Environment

**Files:**
- Create: `docker-compose.yml`
- Create: `docker-compose.test.yml`
- Create: `Dockerfile`

**Step 1: Create docker-compose.yml (local dev)**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: vandura
      POSTGRES_USER: vandura
      POSTGRES_PASSWORD: vandura
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U vandura"]
      interval: 5s
      timeout: 3s
      retries: 5

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: vandura
      MINIO_ROOT_PASSWORD: vandura123
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - miniodata:/data

  minio-init:
    image: minio/mc:latest
    depends_on:
      minio:
        condition: service_started
    entrypoint: >
      /bin/sh -c "
      sleep 2 &&
      mc alias set local http://minio:9000 vandura vandura123 &&
      mc mb local/vandura-results --ignore-existing
      "

volumes:
  pgdata:
  miniodata:
```

**Step 2: Create docker-compose.test.yml**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: vandura_test
      POSTGRES_USER: vandura
      POSTGRES_PASSWORD: vandura
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U vandura"]
      interval: 5s
      timeout: 3s
      retries: 5

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: vandura
      MINIO_ROOT_PASSWORD: vandura123
    healthcheck:
      test: ["CMD-SHELL", "mc ready local || exit 1"]
      interval: 5s
      timeout: 3s
      retries: 5
      start_period: 5s

  minio-init:
    image: minio/mc:latest
    depends_on:
      minio:
        condition: service_started
    entrypoint: >
      /bin/sh -c "
      sleep 2 &&
      mc alias set local http://minio:9000 vandura vandura123 &&
      mc mb local/vandura-results --ignore-existing
      "

  vandura:
    build:
      context: .
      dockerfile: Dockerfile
      target: test
    depends_on:
      postgres:
        condition: service_healthy
      minio-init:
        condition: service_completed_successfully
    environment:
      DATABASE_URL: postgres://vandura:vandura@postgres:5432/vandura_test
      KMS_PROVIDER: local
      S3_ENDPOINT: http://minio:9000
      S3_ACCESS_KEY: vandura
      S3_SECRET_KEY: vandura123
      S3_BUCKET: vandura-results
      S3_REGION: us-east-1
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      ANTHROPIC_BASE_URL: ${ANTHROPIC_BASE_URL}
      SLACK_APP_TOKEN: ${SLACK_APP_TOKEN}
      SLACK_BOT_TOKEN: ${SLACK_BOT_TOKEN}
      SLACK_CHANNEL_ID: ${SLACK_CHANNEL_ID}
```

**Step 3: Create Dockerfile**

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM build AS test
RUN npm ci --include=dev
CMD ["npm", "test"]

FROM node:22-alpine AS production
WORKDIR /app
RUN addgroup -S vandura && adduser -S vandura -G vandura
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
USER vandura
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

**Step 4: Verify docker compose starts**

Run: `docker compose up -d && docker compose ps`
Expected: postgres and minio running, minio-init completed

Run: `docker compose down`

**Step 5: Commit**

```bash
git add docker-compose.yml docker-compose.test.yml Dockerfile
git commit -m "feat: Docker Compose for dev (Postgres + MinIO) and test environments"
```

---

## Task 3: Database Schema & Migrations

**Files:**
- Create: `src/db/connection.ts`
- Create: `src/db/migrate.ts`
- Create: `src/db/migrations/001_initial_schema.sql`
- Create: `src/config/env.ts`
- Test: `tests/db/connection.test.ts`
- Test: `tests/db/migrate.test.ts`

**Step 1: Write env config loader**

```typescript
// src/config/env.ts
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
```

**Step 2: Write the failing test for DB connection**

```typescript
// tests/db/connection.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createPool, type Pool } from "../helpers/db.js";

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("vandura_test")
    .start();
  pool = createPool(container.getConnectionUri());
}, 60_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

describe("database connection", () => {
  it("connects and runs a simple query", async () => {
    const result = await pool.query("SELECT 1 as num");
    expect(result.rows[0].num).toBe(1);
  });
});
```

**Step 3: Run test to verify it fails**

Run: `npx vitest run tests/db/connection.test.ts`
Expected: FAIL — module not found

**Step 4: Write DB connection module**

```typescript
// src/db/connection.ts
import pg from "pg";

export type Pool = pg.Pool;

export function createPool(connectionUri: string): pg.Pool {
  return new pg.Pool({ connectionString: connectionUri });
}
```

Create test helper that re-exports:

```typescript
// tests/helpers/db.ts
export { createPool, type Pool } from "../../src/db/connection.js";
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run tests/db/connection.test.ts`
Expected: PASS

**Step 6: Write the migration SQL**

```sql
-- src/db/migrations/001_initial_schema.sql

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INT PRIMARY KEY,
    applied_at TIMESTAMPTZ DEFAULT now()
);

-- Agent definitions
CREATE TABLE agents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                VARCHAR(50) UNIQUE NOT NULL,
    avatar              VARCHAR(10),
    role                VARCHAR(50) NOT NULL,
    personality         TEXT,
    tools               JSONB NOT NULL DEFAULT '[]',
    system_prompt_extra TEXT,
    max_concurrent_tasks INT DEFAULT 1,
    is_active           BOOLEAN DEFAULT true,
    created_at          TIMESTAMPTZ DEFAULT now()
);

-- Users
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slack_id        VARCHAR(50) UNIQUE NOT NULL,
    display_name    VARCHAR(100),
    role            VARCHAR(50) NOT NULL,
    tool_overrides  JSONB DEFAULT '{}',
    is_active       BOOLEAN DEFAULT true,
    onboarded_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- Shared connections (admin-managed)
CREATE TABLE shared_connections (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(100) UNIQUE NOT NULL,
    provider        VARCHAR(50) NOT NULL,
    credentials_enc BYTEA NOT NULL,
    credentials_iv  BYTEA NOT NULL,
    credentials_tag BYTEA NOT NULL,
    dek_enc         BYTEA NOT NULL,
    config          JSONB,
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- User access to shared connections
CREATE TABLE user_shared_access (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              UUID REFERENCES users(id) ON DELETE CASCADE,
    shared_connection_id UUID REFERENCES shared_connections(id),
    approved_by          VARCHAR(50),
    access_level         VARCHAR(20) DEFAULT 'read',
    granted_at           TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, shared_connection_id)
);

-- Per-user OAuth connections
CREATE TABLE user_connections (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID REFERENCES users(id) ON DELETE CASCADE,
    provider          VARCHAR(50) NOT NULL,
    access_token_enc  BYTEA NOT NULL,
    refresh_token_enc BYTEA,
    token_iv          BYTEA NOT NULL,
    token_tag         BYTEA NOT NULL,
    dek_enc           BYTEA NOT NULL,
    token_expires_at  TIMESTAMPTZ,
    scopes            JSONB,
    connected_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, provider)
);

-- Tasks (one per Slack thread)
CREATE TABLE tasks (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slack_thread_ts     VARCHAR(50) NOT NULL,
    slack_channel       VARCHAR(50) NOT NULL,
    agent_id            UUID REFERENCES agents(id),
    initiator_slack_id  VARCHAR(50) NOT NULL,
    checker_slack_id    VARCHAR(50),
    topic               TEXT,
    status              VARCHAR(20) DEFAULT 'open',
    created_at          TIMESTAMPTZ DEFAULT now(),
    closed_at           TIMESTAMPTZ
);

-- Conversation history
CREATE TABLE messages (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id     UUID REFERENCES tasks(id),
    role        VARCHAR(20) NOT NULL,
    content     TEXT NOT NULL,
    metadata    JSONB,
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- Approval requests
CREATE TABLE approvals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id         UUID REFERENCES tasks(id),
    tool_name       VARCHAR(100) NOT NULL,
    tool_input      JSONB NOT NULL,
    tier            SMALLINT NOT NULL,
    requested_by    VARCHAR(50) NOT NULL,
    approved_by     VARCHAR(50),
    status          VARCHAR(20) DEFAULT 'pending',
    guardrail_output TEXT,
    created_at      TIMESTAMPTZ DEFAULT now(),
    resolved_at     TIMESTAMPTZ
);

-- Audit log (immutable)
CREATE TABLE audit_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id     UUID REFERENCES tasks(id),
    agent_id    UUID REFERENCES agents(id),
    action      VARCHAR(50) NOT NULL,
    actor       VARCHAR(50) NOT NULL,
    detail      JSONB NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT now()
);

INSERT INTO schema_migrations (version) VALUES (1);
```

**Step 7: Write the migration runner**

```typescript
// src/db/migrate.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "./connection.js";
import { env } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function migrate(connectionUri: string): Promise<void> {
  const pool = createPool(connectionUri);
  try {
    // Ensure schema_migrations exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT now()
      )
    `);

    const result = await pool.query("SELECT COALESCE(MAX(version), 0) as v FROM schema_migrations");
    const currentVersion = result.rows[0].v;

    const migrationsDir = path.join(__dirname, "migrations");
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const version = parseInt(file.split("_")[0], 10);
      if (version > currentVersion) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
        await pool.query(sql);
        console.log(`Applied migration ${file}`);
      }
    }
  } finally {
    await pool.end();
  }
}

// CLI entry point
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ""))) {
  const dbUrl = process.argv.includes("--database-url")
    ? process.argv[process.argv.indexOf("--database-url") + 1]
    : env.DATABASE_URL;
  migrate(dbUrl).catch(console.error);
}
```

**Step 8: Write migration test**

```typescript
// tests/db/migrate.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "../../src/db/migrate.js";
import { createPool } from "../../src/db/connection.js";

let container: StartedPostgreSqlContainer;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("vandura_test")
    .start();
}, 60_000);

afterAll(async () => {
  await container.stop();
});

describe("migrations", () => {
  it("applies initial schema and creates all tables", async () => {
    await migrate(container.getConnectionUri());

    const pool = createPool(container.getConnectionUri());
    try {
      const tables = await pool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `);
      const tableNames = tables.rows.map((r: { table_name: string }) => r.table_name);

      expect(tableNames).toContain("agents");
      expect(tableNames).toContain("users");
      expect(tableNames).toContain("tasks");
      expect(tableNames).toContain("messages");
      expect(tableNames).toContain("approvals");
      expect(tableNames).toContain("audit_log");
      expect(tableNames).toContain("shared_connections");
      expect(tableNames).toContain("user_connections");
      expect(tableNames).toContain("user_shared_access");
    } finally {
      await pool.end();
    }
  });

  it("is idempotent — running twice does not fail", async () => {
    await expect(migrate(container.getConnectionUri())).resolves.not.toThrow();
  });
});
```

**Step 9: Run migration tests**

Run: `npx vitest run tests/db/`
Expected: PASS

**Step 10: Commit**

```bash
git add -A
git commit -m "feat: database schema, migrations, and connection pool"
```

---

## Task 4: Credential Manager

**Files:**
- Create: `src/credentials/manager.ts`
- Create: `src/credentials/local-kms.ts`
- Test: `tests/credentials/manager.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/credentials/manager.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { CredentialManager } from "../../src/credentials/manager.js";
import { LocalKms } from "../../src/credentials/local-kms.js";

let manager: CredentialManager;

beforeAll(() => {
  const kms = new LocalKms();
  manager = new CredentialManager(kms);
});

describe("CredentialManager", () => {
  it("encrypts and decrypts a string round-trip", async () => {
    const plaintext = "xoxb-my-secret-token-12345";
    const encrypted = await manager.encrypt(plaintext);

    expect(encrypted.ciphertext).toBeInstanceOf(Buffer);
    expect(encrypted.iv).toBeInstanceOf(Buffer);
    expect(encrypted.tag).toBeInstanceOf(Buffer);
    expect(encrypted.dekEncrypted).toBeInstanceOf(Buffer);

    // Ciphertext should not contain the plaintext
    expect(encrypted.ciphertext.toString("utf-8")).not.toContain(plaintext);

    const decrypted = await manager.decrypt(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it("produces different ciphertext for the same input", async () => {
    const plaintext = "same-input";
    const a = await manager.encrypt(plaintext);
    const b = await manager.encrypt(plaintext);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
    expect(a.iv).not.toEqual(b.iv);
  });

  it("fails to decrypt with tampered ciphertext", async () => {
    const encrypted = await manager.encrypt("secret");
    encrypted.ciphertext[0] ^= 0xff; // flip a byte
    await expect(manager.decrypt(encrypted)).rejects.toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/credentials/manager.test.ts`
Expected: FAIL — modules not found

**Step 3: Implement LocalKms**

```typescript
// src/credentials/local-kms.ts
import crypto from "node:crypto";

export interface Kms {
  generateDek(): Promise<{ plainDek: Buffer; encryptedDek: Buffer }>;
  decryptDek(encryptedDek: Buffer): Promise<Buffer>;
}

export class LocalKms implements Kms {
  private masterKey: Buffer;

  constructor(masterKey?: Buffer) {
    // In local dev, use a deterministic key. In prod, this would come from GCP KMS / Vault.
    this.masterKey = masterKey ?? crypto.randomBytes(32);
  }

  async generateDek(): Promise<{ plainDek: Buffer; encryptedDek: Buffer }> {
    const plainDek = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.masterKey, iv);
    const encrypted = Buffer.concat([cipher.update(plainDek), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Pack: iv (12) + tag (16) + encrypted DEK (32)
    const encryptedDek = Buffer.concat([iv, tag, encrypted]);
    return { plainDek, encryptedDek };
  }

  async decryptDek(encryptedDek: Buffer): Promise<Buffer> {
    const iv = encryptedDek.subarray(0, 12);
    const tag = encryptedDek.subarray(12, 28);
    const ciphertext = encryptedDek.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.masterKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}
```

**Step 4: Implement CredentialManager**

```typescript
// src/credentials/manager.ts
import crypto from "node:crypto";
import type { Kms } from "./local-kms.js";

export interface EncryptedPayload {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  dekEncrypted: Buffer;
}

export class CredentialManager {
  constructor(private kms: Kms) {}

  async encrypt(plaintext: string): Promise<EncryptedPayload> {
    const { plainDek, encryptedDek } = await this.kms.generateDek();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", plainDek, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf-8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    // Zero out the plain DEK from memory
    plainDek.fill(0);

    return { ciphertext, iv, tag, dekEncrypted: encryptedDek };
  }

  async decrypt(payload: EncryptedPayload): Promise<string> {
    const plainDek = await this.kms.decryptDek(payload.dekEncrypted);
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", plainDek, payload.iv);
      decipher.setAuthTag(payload.tag);
      const decrypted = Buffer.concat([
        decipher.update(payload.ciphertext),
        decipher.final(),
      ]);
      return decrypted.toString("utf-8");
    } finally {
      plainDek.fill(0);
    }
  }
}
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run tests/credentials/manager.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: credential manager with AES-256-GCM envelope encryption"
```

---

## Task 5: Config Loader (Tool Policies & Agents)

**Files:**
- Create: `src/config/loader.ts`
- Create: `src/config/types.ts`
- Create: `config/tool-policies.yml`
- Create: `config/agents.yml`
- Create: `config/roles.yml`
- Test: `tests/config/loader.test.ts`

**Step 1: Write config types**

```typescript
// src/config/types.ts
import { z } from "zod";

export const ToolPolicySchema = z.object({
  tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal("dynamic")]),
  guardrails: z.string().nullable().optional(),
  checker: z.enum(["role-based", "peer-based", "any"]).optional().default("peer-based"),
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

export type ToolPolicy = z.infer<typeof ToolPolicySchema>;
export type ToolPolicies = z.infer<typeof ToolPoliciesSchema>;
export type AgentConfig = z.infer<typeof AgentSchema>;
export type RolePermission = z.infer<typeof RolePermissionSchema>;
```

**Step 2: Write failing test**

```typescript
// tests/config/loader.test.ts
import { describe, it, expect } from "vitest";
import { loadToolPolicies, loadAgents, loadRoles } from "../../src/config/loader.js";
import path from "node:path";

const fixturesDir = path.join(import.meta.dirname, "fixtures");

describe("config loader", () => {
  it("loads and validates tool policies", () => {
    const policies = loadToolPolicies(path.join(fixturesDir, "tool-policies.yml"));
    expect(policies["mcp__db__query"]).toBeDefined();
    expect(policies["mcp__db__query"].tier).toBe("dynamic");
    expect(policies["_default"]).toBeDefined();
  });

  it("loads and validates agents config", () => {
    const agents = loadAgents(path.join(fixturesDir, "agents.yml"));
    expect(agents.length).toBeGreaterThan(0);
    expect(agents[0].name).toBe("Sentinel");
    expect(agents[0].tools).toContain("mcp-db");
  });

  it("loads and validates roles config", () => {
    const roles = loadRoles(path.join(fixturesDir, "roles.yml"));
    expect(roles["engineering"]).toBeDefined();
    expect(roles["pm"]).toBeDefined();
  });

  it("throws on invalid config", () => {
    expect(() => loadToolPolicies(path.join(fixturesDir, "invalid.yml"))).toThrow();
  });
});
```

**Step 3: Create test fixtures**

Create `tests/config/fixtures/tool-policies.yml`, `agents.yml`, `roles.yml`, and `invalid.yml` with valid/invalid YAML matching the schemas.

**Step 4: Implement config loader**

```typescript
// src/config/loader.ts
import fs from "node:fs";
import YAML from "yaml";
import {
  ToolPoliciesSchema, AgentsConfigSchema, RolesConfigSchema,
  type ToolPolicies, type AgentConfig, type RolePermission,
} from "./types.js";

export function loadToolPolicies(filePath: string): ToolPolicies {
  const raw = YAML.parse(fs.readFileSync(filePath, "utf-8"));
  return ToolPoliciesSchema.parse(raw.tool_policies ?? raw);
}

export function loadAgents(filePath: string): AgentConfig[] {
  const raw = YAML.parse(fs.readFileSync(filePath, "utf-8"));
  return AgentsConfigSchema.parse(raw).agents;
}

export function loadRoles(filePath: string): Record<string, RolePermission> {
  const raw = YAML.parse(fs.readFileSync(filePath, "utf-8"));
  return RolesConfigSchema.parse(raw).roles;
}
```

**Step 5: Create production config files**

Create `config/tool-policies.yml`, `config/agents.yml`, `config/roles.yml` using the YAML from the design doc. Start with one agent (Sentinel) for v1.

**Step 6: Run tests**

Run: `npx vitest run tests/config/`
Expected: PASS

**Step 7: Commit**

```bash
git add -A
git commit -m "feat: config loader with Zod validation for tool policies, agents, and roles"
```

---

## Task 6: Audit Logger

**Files:**
- Create: `src/audit/logger.ts`
- Test: `tests/audit/logger.test.ts`

**Step 1: Write failing test**

```typescript
// tests/audit/logger.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createPool, type Pool } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { AuditLogger } from "../../src/audit/logger.js";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let logger: AuditLogger;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("vandura_test")
    .start();
  await migrate(container.getConnectionUri());
  pool = createPool(container.getConnectionUri());
  logger = new AuditLogger(pool);
}, 60_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

describe("AuditLogger", () => {
  it("logs an action and retrieves it", async () => {
    await logger.log({
      action: "tool_call",
      actor: "U123SLACK",
      detail: { tool: "mcp__db__query", input: { sql: "SELECT 1" } },
    });

    const rows = await logger.getByActor("U123SLACK");
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("tool_call");
    expect(rows[0].detail.tool).toBe("mcp__db__query");
  });

  it("logs with task_id and agent_id", async () => {
    // Insert a dummy agent first
    const agentResult = await pool.query(
      `INSERT INTO agents (name, role, tools) VALUES ('test-agent', 'test', '["mcp-db"]') RETURNING id`
    );
    const agentId = agentResult.rows[0].id;

    // Insert a dummy task
    const taskResult = await pool.query(
      `INSERT INTO tasks (slack_thread_ts, slack_channel, agent_id, initiator_slack_id)
       VALUES ('1234.5678', 'C0123', $1, 'U123') RETURNING id`,
      [agentId]
    );
    const taskId = taskResult.rows[0].id;

    await logger.log({
      taskId,
      agentId,
      action: "approval_granted",
      actor: "U456CHECKER",
      detail: { tool: "mcp__db__write", approved: true },
    });

    const rows = await logger.getByTaskId(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_id).toBe(agentId);
  });
});
```

**Step 2: Implement AuditLogger**

```typescript
// src/audit/logger.ts
import type { Pool } from "../db/connection.js";

interface LogEntry {
  taskId?: string;
  agentId?: string;
  action: string;
  actor: string;
  detail: Record<string, unknown>;
}

interface AuditRow {
  id: string;
  task_id: string | null;
  agent_id: string | null;
  action: string;
  actor: string;
  detail: Record<string, unknown>;
  created_at: Date;
}

export class AuditLogger {
  constructor(private pool: Pool) {}

  async log(entry: LogEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_log (task_id, agent_id, action, actor, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [entry.taskId ?? null, entry.agentId ?? null, entry.action, entry.actor, JSON.stringify(entry.detail)]
    );
  }

  async getByActor(actor: string): Promise<AuditRow[]> {
    const result = await this.pool.query(
      "SELECT * FROM audit_log WHERE actor = $1 ORDER BY created_at DESC",
      [actor]
    );
    return result.rows;
  }

  async getByTaskId(taskId: string): Promise<AuditRow[]> {
    const result = await this.pool.query(
      "SELECT * FROM audit_log WHERE task_id = $1 ORDER BY created_at DESC",
      [taskId]
    );
    return result.rows;
  }
}
```

**Step 3: Run tests**

Run: `npx vitest run tests/audit/`
Expected: PASS

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: audit logger with Postgres persistence"
```

---

## Task 7: Slack Gateway

**Files:**
- Create: `src/slack/gateway.ts`
- Create: `src/slack/types.ts`
- Test: `tests/slack/gateway.test.ts`

**Step 1: Write Slack types**

```typescript
// src/slack/types.ts
export interface SlackEvent {
  type: string;
  user: string;
  text: string;
  channel: string;
  ts: string;
  thread_ts?: string;
}

export interface SlackMessage {
  channel: string;
  text: string;
  thread_ts: string;
}
```

**Step 2: Write failing test**

```typescript
// tests/slack/gateway.test.ts
import { describe, it, expect, vi } from "vitest";
import { SlackGateway } from "../../src/slack/gateway.js";

describe("SlackGateway", () => {
  it("registers app_mention handler", () => {
    const mockApp = {
      event: vi.fn(),
      start: vi.fn().mockResolvedValue(undefined),
    };

    const gateway = new SlackGateway(mockApp as any);
    gateway.onMention(async () => {});

    expect(mockApp.event).toHaveBeenCalledWith("app_mention", expect.any(Function));
  });

  it("registers message handler for thread replies", () => {
    const mockApp = {
      event: vi.fn(),
      start: vi.fn().mockResolvedValue(undefined),
    };

    const gateway = new SlackGateway(mockApp as any);
    gateway.onThreadMessage(async () => {});

    expect(mockApp.event).toHaveBeenCalledWith("message", expect.any(Function));
  });

  it("registers member_joined_channel handler", () => {
    const mockApp = {
      event: vi.fn(),
      start: vi.fn().mockResolvedValue(undefined),
    };

    const gateway = new SlackGateway(mockApp as any);
    gateway.onMemberJoined(async () => {});

    expect(mockApp.event).toHaveBeenCalledWith("member_joined_channel", expect.any(Function));
  });
});
```

**Step 3: Implement SlackGateway**

```typescript
// src/slack/gateway.ts
import type { App } from "@slack/bolt";

type MentionHandler = (event: {
  user: string;
  text: string;
  channel: string;
  ts: string;
  say: (msg: { text: string; thread_ts: string }) => Promise<void>;
}) => Promise<void>;

type ThreadHandler = (event: {
  user: string;
  text: string;
  channel: string;
  ts: string;
  thread_ts: string;
  say: (msg: { text: string; thread_ts: string }) => Promise<void>;
}) => Promise<void>;

type MemberJoinedHandler = (event: {
  user: string;
  channel: string;
}) => Promise<void>;

export class SlackGateway {
  constructor(private app: App) {}

  onMention(handler: MentionHandler): void {
    this.app.event("app_mention", async ({ event, say }) => {
      await handler({
        user: event.user,
        text: event.text,
        channel: event.channel,
        ts: event.ts,
        say: async (msg) => { await say(msg); },
      });
    });
  }

  onThreadMessage(handler: ThreadHandler): void {
    this.app.event("message", async ({ event, say }) => {
      const msg = event as any;
      // Only handle thread replies, not top-level messages
      if (!msg.thread_ts || msg.subtype === "bot_message") return;
      await handler({
        user: msg.user,
        text: msg.text,
        channel: msg.channel,
        ts: msg.ts,
        thread_ts: msg.thread_ts,
        say: async (m) => { await say(m); },
      });
    });
  }

  onMemberJoined(handler: MemberJoinedHandler): void {
    this.app.event("member_joined_channel", async ({ event }) => {
      await handler({ user: event.user, channel: event.channel });
    });
  }

  async start(): Promise<void> {
    await this.app.start();
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/slack/`
Expected: PASS

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: Slack gateway with event handlers for mentions, threads, and member joins"
```

---

## Task 8: Thread Manager

**Files:**
- Create: `src/threads/manager.ts`
- Create: `src/threads/types.ts`
- Test: `tests/threads/manager.test.ts`

**Step 1: Write types**

```typescript
// src/threads/types.ts
export interface Task {
  id: string;
  slackThreadTs: string;
  slackChannel: string;
  agentId: string;
  initiatorSlackId: string;
  checkerSlackId: string | null;
  topic: string | null;
  status: "open" | "completed" | "cancelled";
  createdAt: Date;
  closedAt: Date | null;
}

export interface Message {
  id: string;
  taskId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}
```

**Step 2: Write failing test**

```typescript
// tests/threads/manager.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createPool, type Pool } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { ThreadManager } from "../../src/threads/manager.js";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let manager: ThreadManager;
let agentId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("vandura_test")
    .start();
  await migrate(container.getConnectionUri());
  pool = createPool(container.getConnectionUri());
  manager = new ThreadManager(pool);

  // Seed an agent
  const result = await pool.query(
    `INSERT INTO agents (name, role, tools) VALUES ('sentinel', 'admin', '["mcp-db"]') RETURNING id`
  );
  agentId = result.rows[0].id;
}, 60_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

describe("ThreadManager", () => {
  it("creates a new task for a thread", async () => {
    const task = await manager.createTask({
      slackThreadTs: "1234.5678",
      slackChannel: "C0123",
      agentId,
      initiatorSlackId: "U_INIT",
    });

    expect(task.id).toBeDefined();
    expect(task.status).toBe("open");
    expect(task.initiatorSlackId).toBe("U_INIT");
  });

  it("finds task by thread_ts", async () => {
    const found = await manager.findByThread("C0123", "1234.5678");
    expect(found).not.toBeNull();
    expect(found!.initiatorSlackId).toBe("U_INIT");
  });

  it("sets checker on a task", async () => {
    const task = await manager.findByThread("C0123", "1234.5678");
    await manager.setChecker(task!.id, "U_CHECK");
    const updated = await manager.findByThread("C0123", "1234.5678");
    expect(updated!.checkerSlackId).toBe("U_CHECK");
  });

  it("appends and retrieves messages", async () => {
    const task = await manager.findByThread("C0123", "1234.5678");
    await manager.addMessage(task!.id, "user", "Hello agent", null);
    await manager.addMessage(task!.id, "assistant", "Hi there!", null);

    const messages = await manager.getMessages(task!.id);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("closes a task", async () => {
    const task = await manager.findByThread("C0123", "1234.5678");
    await manager.closeTask(task!.id, "completed");
    const closed = await manager.findByThread("C0123", "1234.5678");
    expect(closed!.status).toBe("completed");
    expect(closed!.closedAt).not.toBeNull();
  });
});
```

**Step 3: Implement ThreadManager**

```typescript
// src/threads/manager.ts
import type { Pool } from "../db/connection.js";
import type { Task, Message } from "./types.js";

export class ThreadManager {
  constructor(private pool: Pool) {}

  async createTask(params: {
    slackThreadTs: string;
    slackChannel: string;
    agentId: string;
    initiatorSlackId: string;
    topic?: string;
  }): Promise<Task> {
    const result = await this.pool.query(
      `INSERT INTO tasks (slack_thread_ts, slack_channel, agent_id, initiator_slack_id, topic)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [params.slackThreadTs, params.slackChannel, params.agentId, params.initiatorSlackId, params.topic ?? null]
    );
    return this.mapTask(result.rows[0]);
  }

  async findByThread(channel: string, threadTs: string): Promise<Task | null> {
    const result = await this.pool.query(
      "SELECT * FROM tasks WHERE slack_channel = $1 AND slack_thread_ts = $2",
      [channel, threadTs]
    );
    return result.rows[0] ? this.mapTask(result.rows[0]) : null;
  }

  async setChecker(taskId: string, checkerSlackId: string): Promise<void> {
    await this.pool.query(
      "UPDATE tasks SET checker_slack_id = $1 WHERE id = $2",
      [checkerSlackId, taskId]
    );
  }

  async addMessage(taskId: string, role: string, content: string, metadata: Record<string, unknown> | null): Promise<void> {
    await this.pool.query(
      "INSERT INTO messages (task_id, role, content, metadata) VALUES ($1, $2, $3, $4)",
      [taskId, role, content, metadata ? JSON.stringify(metadata) : null]
    );
  }

  async getMessages(taskId: string): Promise<Message[]> {
    const result = await this.pool.query(
      "SELECT * FROM messages WHERE task_id = $1 ORDER BY created_at ASC",
      [taskId]
    );
    return result.rows.map(this.mapMessage);
  }

  async closeTask(taskId: string, status: "completed" | "cancelled"): Promise<void> {
    await this.pool.query(
      "UPDATE tasks SET status = $1, closed_at = now() WHERE id = $2",
      [status, taskId]
    );
  }

  private mapTask(row: any): Task {
    return {
      id: row.id,
      slackThreadTs: row.slack_thread_ts,
      slackChannel: row.slack_channel,
      agentId: row.agent_id,
      initiatorSlackId: row.initiator_slack_id,
      checkerSlackId: row.checker_slack_id,
      topic: row.topic,
      status: row.status,
      createdAt: row.created_at,
      closedAt: row.closed_at,
    };
  }

  private mapMessage(row: any): Message {
    return {
      id: row.id,
      taskId: row.task_id,
      role: row.role,
      content: row.content,
      metadata: row.metadata,
      createdAt: row.created_at,
    };
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/threads/`
Expected: PASS

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: thread manager for task lifecycle and conversation history"
```

---

## Task 9: Approval Engine

**Files:**
- Create: `src/approval/engine.ts`
- Create: `src/approval/types.ts`
- Test: `tests/approval/engine.test.ts`

**Step 1: Write types**

```typescript
// src/approval/types.ts
export interface ApprovalRequest {
  id: string;
  taskId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  tier: 1 | 2 | 3;
  requestedBy: string;
  approvedBy: string | null;
  status: "pending" | "approved" | "rejected" | "timeout";
  guardrailOutput: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

export type ApprovalDecision = "approved" | "rejected" | "timeout";
```

**Step 2: Write failing test**

```typescript
// tests/approval/engine.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createPool, type Pool } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { ApprovalEngine } from "../../src/approval/engine.js";
import type { ToolPolicies } from "../../src/config/types.js";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let engine: ApprovalEngine;
let taskId: string;

const policies: ToolPolicies = {
  "mcp__db__query": { tier: 1, checker: "peer-based" },
  "mcp__db__write": { tier: 3, guardrails: "Show the SQL and affected rows.", checker: "peer-based" },
  "mcp__confluence__create_page": { tier: 2, checker: "peer-based" },
  "_default": { tier: 2, guardrails: "Describe what this tool will do.", checker: "peer-based" },
};

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("vandura_test")
    .start();
  await migrate(container.getConnectionUri());
  pool = createPool(container.getConnectionUri());
  engine = new ApprovalEngine(pool, policies);

  // Seed agent + task
  const agentRes = await pool.query(
    `INSERT INTO agents (name, role, tools) VALUES ('sentinel', 'admin', '["mcp-db"]') RETURNING id`
  );
  const taskRes = await pool.query(
    `INSERT INTO tasks (slack_thread_ts, slack_channel, agent_id, initiator_slack_id, checker_slack_id)
     VALUES ('1234.5678', 'C0123', $1, 'U_INIT', 'U_CHECK') RETURNING id`,
    [agentRes.rows[0].id]
  );
  taskId = taskRes.rows[0].id;
}, 60_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

describe("ApprovalEngine", () => {
  it("returns tier 1 — auto-approve", async () => {
    const result = await engine.classify("mcp__db__query", {});
    expect(result.tier).toBe(1);
    expect(result.requiresApproval).toBe(false);
  });

  it("returns tier 2 — needs initiator confirmation", async () => {
    const result = await engine.classify("mcp__confluence__create_page", {});
    expect(result.tier).toBe(2);
    expect(result.requiresApproval).toBe(true);
    expect(result.approver).toBe("initiator");
  });

  it("returns tier 3 — needs checker approval", async () => {
    const result = await engine.classify("mcp__db__write", {});
    expect(result.tier).toBe(3);
    expect(result.requiresApproval).toBe(true);
    expect(result.approver).toBe("checker");
  });

  it("falls back to _default for unknown tools", async () => {
    const result = await engine.classify("mcp__unknown__tool", {});
    expect(result.tier).toBe(2);
  });

  it("creates and resolves an approval request", async () => {
    const request = await engine.requestApproval(taskId, "mcp__db__write", { sql: "DELETE FROM users" }, 3, "U_INIT");
    expect(request.status).toBe("pending");

    await engine.resolve(request.id, "approved", "U_CHECK");

    const resolved = await engine.getApproval(request.id);
    expect(resolved!.status).toBe("approved");
    expect(resolved!.approvedBy).toBe("U_CHECK");
  });

  it("returns guardrails for a tool", () => {
    const guardrails = engine.getGuardrails("mcp__db__write");
    expect(guardrails).toBe("Show the SQL and affected rows.");
  });
});
```

**Step 3: Implement ApprovalEngine**

```typescript
// src/approval/engine.ts
import type { Pool } from "../db/connection.js";
import type { ToolPolicies } from "../config/types.js";
import type { ApprovalRequest, ApprovalDecision } from "./types.js";

interface ClassificationResult {
  tier: 1 | 2 | 3;
  requiresApproval: boolean;
  approver: "none" | "initiator" | "checker";
  guardrails: string | null;
}

export class ApprovalEngine {
  constructor(
    private pool: Pool,
    private policies: ToolPolicies,
  ) {}

  classify(toolName: string, _toolInput: Record<string, unknown>): ClassificationResult {
    const policy = this.policies[toolName] ?? this.policies["_default"];
    if (!policy) {
      return { tier: 2, requiresApproval: true, approver: "initiator", guardrails: null };
    }

    const tier = typeof policy.tier === "number" ? policy.tier : 2;
    const guardrails = policy.guardrails ?? null;

    if (tier === 1) return { tier, requiresApproval: false, approver: "none", guardrails };
    if (tier === 2) return { tier, requiresApproval: true, approver: "initiator", guardrails };
    return { tier: 3, requiresApproval: true, approver: "checker", guardrails };
  }

  async requestApproval(
    taskId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    tier: number,
    requestedBy: string,
  ): Promise<ApprovalRequest> {
    const result = await this.pool.query(
      `INSERT INTO approvals (task_id, tool_name, tool_input, tier, requested_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [taskId, toolName, JSON.stringify(toolInput), tier, requestedBy]
    );
    return this.mapApproval(result.rows[0]);
  }

  async resolve(approvalId: string, decision: ApprovalDecision, resolvedBy: string): Promise<void> {
    await this.pool.query(
      `UPDATE approvals SET status = $1, approved_by = $2, resolved_at = now() WHERE id = $3`,
      [decision, resolvedBy, approvalId]
    );
  }

  async getApproval(approvalId: string): Promise<ApprovalRequest | null> {
    const result = await this.pool.query("SELECT * FROM approvals WHERE id = $1", [approvalId]);
    return result.rows[0] ? this.mapApproval(result.rows[0]) : null;
  }

  async getPendingByTask(taskId: string): Promise<ApprovalRequest[]> {
    const result = await this.pool.query(
      "SELECT * FROM approvals WHERE task_id = $1 AND status = 'pending' ORDER BY created_at ASC",
      [taskId]
    );
    return result.rows.map(this.mapApproval);
  }

  getGuardrails(toolName: string): string | null {
    const policy = this.policies[toolName] ?? this.policies["_default"];
    return policy?.guardrails ?? null;
  }

  private mapApproval(row: any): ApprovalRequest {
    return {
      id: row.id,
      taskId: row.task_id,
      toolName: row.tool_name,
      toolInput: row.tool_input,
      tier: row.tier,
      requestedBy: row.requested_by,
      approvedBy: row.approved_by,
      status: row.status,
      guardrailOutput: row.guardrail_output,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    };
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/approval/`
Expected: PASS

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: approval engine with tier classification and maker-checker flow"
```

---

## Task 10: S3/MinIO Storage Service

**Files:**
- Create: `src/storage/s3.ts`
- Test: `tests/storage/s3.test.ts`

**Step 1: Write failing test**

```typescript
// tests/storage/s3.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { StorageService } from "../../src/storage/s3.js";

let container: StartedTestContainer;
let storage: StorageService;

beforeAll(async () => {
  container = await new GenericContainer("minio/minio:latest")
    .withExposedPorts(9000)
    .withCommand(["server", "/data"])
    .withEnvironment({ MINIO_ROOT_USER: "test", MINIO_ROOT_PASSWORD: "testtest1" })
    .start();

  const port = container.getMappedPort(9000);
  const host = container.getHost();

  storage = new StorageService({
    endpoint: `http://${host}:${port}`,
    accessKey: "test",
    secretKey: "testtest1",
    bucket: "test-results",
    region: "us-east-1",
    signedUrlExpiry: 3600,
  });

  await storage.ensureBucket();
}, 60_000);

afterAll(async () => {
  await container.stop();
});

describe("StorageService", () => {
  it("uploads content and generates a signed URL", async () => {
    const result = await storage.upload({
      key: "task-123/results.csv",
      content: Buffer.from("id,name\n1,Alice\n2,Bob"),
      contentType: "text/csv",
    });

    expect(result.key).toBe("task-123/results.csv");
    expect(result.signedUrl).toContain("test-results");
    expect(result.signedUrl).toContain("results.csv");
  });

  it("uploads and downloads round-trip", async () => {
    const original = "Hello, Vandura!";
    await storage.upload({
      key: "task-456/hello.txt",
      content: Buffer.from(original),
      contentType: "text/plain",
    });

    const downloaded = await storage.download("task-456/hello.txt");
    expect(downloaded.toString("utf-8")).toBe(original);
  });
});
```

**Step 2: Implement StorageService**

```typescript
// src/storage/s3.ts
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

interface StorageConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region: string;
  signedUrlExpiry: number;
}

interface UploadParams {
  key: string;
  content: Buffer;
  contentType: string;
}

interface UploadResult {
  key: string;
  signedUrl: string;
  expiresAt: Date;
}

export class StorageService {
  private client: S3Client;
  private bucket: string;
  private signedUrlExpiry: number;

  constructor(config: StorageConfig) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
      forcePathStyle: true, // Required for MinIO
    });
    this.bucket = config.bucket;
    this.signedUrlExpiry = config.signedUrlExpiry;
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async upload(params: UploadParams): Promise<UploadResult> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: params.key,
      Body: params.content,
      ContentType: params.contentType,
    }));

    const signedUrl = await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: params.key }),
      { expiresIn: this.signedUrlExpiry }
    );

    return {
      key: params.key,
      signedUrl,
      expiresAt: new Date(Date.now() + this.signedUrlExpiry * 1000),
    };
  }

  async download(key: string): Promise<Buffer> {
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }));
    const bytes = await response.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }
}
```

**Step 3: Run tests**

Run: `npx vitest run tests/storage/`
Expected: PASS

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: S3-compatible storage service with MinIO support and signed URLs"
```

---

## Task 11: Agent Runtime (Claude Agent SDK Integration)

**Files:**
- Create: `src/agent/runtime.ts`
- Create: `src/agent/prompt.ts`
- Test: `tests/agent/runtime.test.ts`
- Test: `tests/agent/prompt.test.ts`

**Step 1: Write prompt builder test**

```typescript
// tests/agent/prompt.test.ts
import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../../src/agent/prompt.js";

describe("buildSystemPrompt", () => {
  it("includes agent personality", () => {
    const prompt = buildSystemPrompt({
      agentName: "Sentinel",
      personality: "Cautious, security-minded.",
      systemPromptExtra: "You have broad access. Use it carefully.",
      guardrails: { "mcp__db__write": "Show the SQL before executing." },
    });

    expect(prompt).toContain("Sentinel");
    expect(prompt).toContain("Cautious, security-minded.");
    expect(prompt).toContain("You have broad access");
  });

  it("includes tool guardrails", () => {
    const prompt = buildSystemPrompt({
      agentName: "Atlas",
      personality: "Precise.",
      guardrails: { "mcp__db__query": "Run EXPLAIN first." },
    });

    expect(prompt).toContain("mcp__db__query");
    expect(prompt).toContain("Run EXPLAIN first.");
  });
});
```

**Step 2: Implement prompt builder**

```typescript
// src/agent/prompt.ts
interface PromptParams {
  agentName: string;
  personality?: string;
  systemPromptExtra?: string;
  guardrails?: Record<string, string>;
}

export function buildSystemPrompt(params: PromptParams): string {
  const sections: string[] = [];

  sections.push(`You are ${params.agentName}, an AI agent in the Vandura system.`);
  sections.push("You operate in Slack channels. All your actions are visible to the team.");
  sections.push("Always be transparent about what you are doing and why.");

  if (params.personality) {
    sections.push(`\nPersonality: ${params.personality}`);
  }

  if (params.systemPromptExtra) {
    sections.push(`\n${params.systemPromptExtra}`);
  }

  if (params.guardrails && Object.keys(params.guardrails).length > 0) {
    sections.push("\n## Tool-Specific Guardrails\n");
    for (const [tool, guardrail] of Object.entries(params.guardrails)) {
      sections.push(`### ${tool}\n${guardrail}\n`);
    }
  }

  sections.push("\n## Approval Rules");
  sections.push("- Tier 1 tools: execute immediately and report results.");
  sections.push("- Tier 2 tools: describe what you want to do and ask the initiator to confirm before proceeding.");
  sections.push("- Tier 3 tools: describe what you want to do and wait for the checker to approve before proceeding.");
  sections.push("- If you are unsure about the tier, default to tier 2 and ask the initiator.");

  return sections.join("\n");
}
```

**Step 3: Write agent runtime (thin wrapper around Claude Agent SDK)**

```typescript
// src/agent/runtime.ts
import Anthropic from "@anthropic-ai/sdk";
import type { AgentConfig } from "../config/types.js";
import type { ToolPolicies } from "../config/types.js";
import { buildSystemPrompt } from "./prompt.js";

interface AgentRuntimeConfig {
  anthropicApiKey: string;
  anthropicBaseUrl?: string;
  agentConfig: AgentConfig;
  toolPolicies: ToolPolicies;
}

export class AgentRuntime {
  private client: Anthropic;
  private systemPrompt: string;
  private conversationHistory: Anthropic.MessageParam[] = [];

  constructor(private config: AgentRuntimeConfig) {
    this.client = new Anthropic({
      apiKey: config.anthropicApiKey,
      baseURL: config.anthropicBaseUrl,
    });

    // Collect guardrails for this agent's tools
    const guardrails: Record<string, string> = {};
    for (const toolName of Object.keys(config.toolPolicies)) {
      const policy = config.toolPolicies[toolName];
      if (policy.guardrails) {
        guardrails[toolName] = policy.guardrails;
      }
    }

    this.systemPrompt = buildSystemPrompt({
      agentName: config.agentConfig.name,
      personality: config.agentConfig.personality,
      systemPromptExtra: config.agentConfig.system_prompt_extra,
      guardrails,
    });
  }

  async chat(userMessage: string): Promise<string> {
    this.conversationHistory.push({ role: "user", content: userMessage });

    const response = await this.client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: this.systemPrompt,
      messages: this.conversationHistory,
    });

    const assistantText = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    this.conversationHistory.push({ role: "assistant", content: assistantText });

    return assistantText;
  }

  getHistory(): Anthropic.MessageParam[] {
    return [...this.conversationHistory];
  }

  loadHistory(messages: Anthropic.MessageParam[]): void {
    this.conversationHistory = [...messages];
  }
}
```

**Step 4: Write runtime test (unit, mocked)**

```typescript
// tests/agent/runtime.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentRuntime } from "../../src/agent/runtime.js";

// We test the runtime's conversation management, not the API call
describe("AgentRuntime", () => {
  it("builds with correct config", () => {
    const runtime = new AgentRuntime({
      anthropicApiKey: "test-key",
      agentConfig: {
        name: "Sentinel",
        role: "admin",
        tools: ["mcp-db"],
        max_concurrent_tasks: 1,
      },
      toolPolicies: {
        "mcp__db__query": { tier: 1, checker: "peer-based" },
      },
    });

    expect(runtime).toBeDefined();
    expect(runtime.getHistory()).toHaveLength(0);
  });

  it("manages conversation history", () => {
    const runtime = new AgentRuntime({
      anthropicApiKey: "test-key",
      agentConfig: {
        name: "Atlas",
        role: "data-analyst",
        tools: ["mcp-db"],
        max_concurrent_tasks: 1,
      },
      toolPolicies: {},
    });

    runtime.loadHistory([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ]);

    expect(runtime.getHistory()).toHaveLength(2);
  });
});
```

**Step 5: Run tests**

Run: `npx vitest run tests/agent/`
Expected: PASS

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: agent runtime with Claude SDK, prompt builder, and conversation management"
```

---

## Task 12: Wire It All Together — Main Entry Point

**Files:**
- Modify: `src/index.ts`
- Create: `src/app.ts`
- Test: `tests/app.test.ts` (smoke test)

**Step 1: Create the app orchestrator**

```typescript
// src/app.ts
import { App } from "@slack/bolt";
import { env } from "./config/env.js";
import { createPool } from "./db/connection.js";
import { migrate } from "./db/migrate.js";
import { loadToolPolicies, loadAgents, loadRoles } from "./config/loader.js";
import { SlackGateway } from "./slack/gateway.js";
import { ThreadManager } from "./threads/manager.js";
import { ApprovalEngine } from "./approval/engine.js";
import { AuditLogger } from "./audit/logger.js";
import { AgentRuntime } from "./agent/runtime.js";
import { StorageService } from "./storage/s3.js";
import path from "node:path";

export async function createApp() {
  // Load config
  const configDir = path.join(process.cwd(), "config");
  const toolPolicies = loadToolPolicies(path.join(configDir, "tool-policies.yml"));
  const agents = loadAgents(path.join(configDir, "agents.yml"));
  const roles = loadRoles(path.join(configDir, "roles.yml"));

  // Database
  const pool = createPool(env.DATABASE_URL);
  await migrate(env.DATABASE_URL);

  // Services
  const threadManager = new ThreadManager(pool);
  const approvalEngine = new ApprovalEngine(pool, toolPolicies);
  const auditLogger = new AuditLogger(pool);
  const storage = new StorageService({
    endpoint: env.S3_ENDPOINT,
    accessKey: env.S3_ACCESS_KEY,
    secretKey: env.S3_SECRET_KEY,
    bucket: env.S3_BUCKET,
    region: env.S3_REGION,
    signedUrlExpiry: env.S3_SIGNED_URL_EXPIRY,
  });
  await storage.ensureBucket();

  // Slack
  const slackApp = new App({
    token: env.SLACK_BOT_TOKEN,
    appToken: env.SLACK_APP_TOKEN,
    socketMode: true,
  });
  const gateway = new SlackGateway(slackApp);

  // Active agent runtimes (keyed by thread_ts)
  const activeAgents = new Map<string, AgentRuntime>();

  // Use the first configured agent for now (v1 = single agent)
  const agentConfig = agents[0];

  // Handle @mentions — create new task thread
  gateway.onMention(async ({ user, text, channel, ts, say }) => {
    await auditLogger.log({
      action: "mention_received",
      actor: user,
      detail: { text, channel },
    });

    // Create a thread reply
    await say({ text: `I'm on it! Let me look into this...`, thread_ts: ts });

    // Create task in DB
    const task = await threadManager.createTask({
      slackThreadTs: ts,
      slackChannel: channel,
      agentId: agentConfig.name, // Will be UUID after seeding
      initiatorSlackId: user,
    });

    // Create agent runtime for this thread
    const runtime = new AgentRuntime({
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      anthropicBaseUrl: env.ANTHROPIC_BASE_URL,
      agentConfig,
      toolPolicies,
    });
    activeAgents.set(ts, runtime);

    // Process the message
    const cleanText = text.replace(/<@[^>]+>/g, "").trim();
    await threadManager.addMessage(task.id, "user", cleanText, null);

    try {
      const response = await runtime.chat(cleanText);
      await threadManager.addMessage(task.id, "assistant", response, null);
      await say({ text: response, thread_ts: ts });
    } catch (err) {
      const errorMsg = `Sorry, I encountered an error: ${err instanceof Error ? err.message : "unknown error"}`;
      await say({ text: errorMsg, thread_ts: ts });
    }
  });

  // Handle thread replies — continue conversation
  gateway.onThreadMessage(async ({ user, text, channel, ts, thread_ts, say }) => {
    const task = await threadManager.findByThread(channel, thread_ts);
    if (!task) return; // Not a Vandura thread

    const runtime = activeAgents.get(thread_ts);
    if (!runtime) return;

    await threadManager.addMessage(task.id, "user", text, null);

    try {
      const response = await runtime.chat(text);
      await threadManager.addMessage(task.id, "assistant", response, null);
      await say({ text: response, thread_ts: thread_ts });
    } catch (err) {
      const errorMsg = `Sorry, I encountered an error: ${err instanceof Error ? err.message : "unknown error"}`;
      await say({ text: errorMsg, thread_ts: thread_ts });
    }
  });

  return {
    start: () => gateway.start(),
    pool,
    gateway,
    threadManager,
    approvalEngine,
    auditLogger,
    storage,
  };
}
```

**Step 2: Update index.ts**

```typescript
// src/index.ts
import { createApp } from "./app.js";

async function main() {
  const app = await createApp();
  await app.start();
  console.log("Vandura is running!");
}

main().catch((err) => {
  console.error("Failed to start Vandura:", err);
  process.exit(1);
});
```

**Step 3: Write smoke test**

```typescript
// tests/app.test.ts
import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../src/agent/prompt.js";

describe("app smoke test", () => {
  it("can build a system prompt", () => {
    const prompt = buildSystemPrompt({
      agentName: "Sentinel",
      personality: "Cautious.",
      guardrails: {},
    });
    expect(prompt).toContain("Sentinel");
    expect(prompt).toContain("Vandura");
  });
});
```

**Step 4: Test locally with docker compose**

```bash
docker compose up -d  # Start Postgres + MinIO
npm run dev            # Start Vandura
```

Go to Slack, @mention the agent in the configured channel. Verify it responds in a thread.

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: wire up main app — Slack gateway, agent runtime, thread management"
```

---

## Task 13: GitHub Actions CI Pipeline

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`

**Step 1: Create CI workflow**

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  lint-and-typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck

  test:
    runs-on: ubuntu-latest
    needs: lint-and-typecheck
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm test
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: test-results
          path: test-results.xml
          retention-days: 7

  build-and-push:
    runs-on: ubuntu-latest
    needs: test
    if: github.ref == 'refs/heads/main'
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: |
            ghcr.io/${{ github.repository }}:latest
            ghcr.io/${{ github.repository }}:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

**Step 2: Create release workflow**

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    tags:
      - "v*"

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: |
            ghcr.io/${{ github.repository }}:${{ github.ref_name }}
            ghcr.io/${{ github.repository }}:latest
      - uses: softprops/action-gh-release@v2
        with:
          generate_release_notes: true
```

**Step 3: Commit**

```bash
git add -A
git commit -m "feat: GitHub Actions CI pipeline and release workflow"
```

---

## Task 14: Push and Verify CI

**Step 1: Push to GitHub**

```bash
git push origin main
```

**Step 2: Verify CI passes**

Run: `gh run watch` or check GitHub Actions tab.
Expected: lint-and-typecheck -> test -> build-and-push all green

---

## Summary: Task Dependency Order

```
Task 1:  Project Scaffolding
Task 2:  Docker Compose (Postgres + MinIO)
Task 3:  Database Schema & Migrations
Task 4:  Credential Manager
Task 5:  Config Loader
Task 6:  Audit Logger
Task 7:  Slack Gateway
Task 8:  Thread Manager
Task 9:  Approval Engine
Task 10: S3/MinIO Storage Service
Task 11: Agent Runtime (Claude SDK)
Task 12: Wire It All Together
Task 13: GitHub Actions CI
Task 14: Push and Verify CI
```

Tasks 3-11 can be partially parallelized (3-6 are independent of 7-10), but Task 12 depends on all of them. Task 13-14 can be done any time after Task 1 but are listed last for clarity.
