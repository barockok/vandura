import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { createPool } from "./connection.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runMigrations(pool: pg.Pool): Promise<void> {
  // 1. Create schema_migrations table if not exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // 2. Read current version
  const versionResult = await pool.query(
    "SELECT COALESCE(MAX(version), 0) AS current_version FROM schema_migrations"
  );
  const currentVersion: number = versionResult.rows[0].current_version;

  // 3. Read migration files sorted by name
  const migrationsDir = path.join(__dirname, "migrations");
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  // 4. Apply migrations with version > currentVersion
  for (const file of files) {
    const match = file.match(/^(\d+)/);
    if (!match) continue;
    const version = parseInt(match[1], 10);
    if (version <= currentVersion) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
    await pool.query(sql);
    await pool.query(
      "INSERT INTO schema_migrations (version) VALUES ($1)",
      [version],
    );
    console.log(`Applied migration ${file}`);
  }
}

// CLI entry point
const isCLI =
  process.argv[1] &&
  (process.argv[1].endsWith("migrate.ts") || process.argv[1].endsWith("migrate.js"));

if (isCLI) {
  const dbUrlArg = process.argv.find((a) => a.startsWith("--database-url="));
  const databaseUrl =
    dbUrlArg?.split("=").slice(1).join("=") ??
    process.env.DATABASE_URL ??
    "postgres://vandura:vandura@localhost:5432/vandura";

  const pool = createPool(databaseUrl);
  runMigrations(pool)
    .then(() => {
      console.log("All migrations applied.");
      return pool.end();
    })
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}
