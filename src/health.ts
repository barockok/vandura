import type { Pool } from "./db/connection.js";
import type { StorageService } from "./storage/s3.js";
import { createServer, type Server } from "node:http";

interface HealthDeps {
  pool: Pool;
  storage: StorageService;
}

export interface HealthResult {
  status: "ok" | "degraded";
  database: string;
  storage: string;
  uptime: number;
}

export function buildHealthCheck(deps: HealthDeps): () => Promise<HealthResult> {
  const startTime = Date.now();

  return async (): Promise<HealthResult> => {
    let dbStatus = "connected";
    let storageStatus = "connected";
    let allOk = true;

    try {
      await deps.pool.query("SELECT 1");
    } catch (err) {
      dbStatus = `error: ${err instanceof Error ? err.message : "unknown"}`;
      allOk = false;
    }

    try {
      await deps.storage.ensureBucket();
    } catch (err) {
      storageStatus = `error: ${err instanceof Error ? err.message : "unknown"}`;
      allOk = false;
    }

    return {
      status: allOk ? "ok" : "degraded",
      database: dbStatus,
      storage: storageStatus,
      uptime: Math.floor((Date.now() - startTime) / 1000),
    };
  };
}

export function startHealthServer(
  healthCheck: () => Promise<HealthResult>,
  port = 4734,
): Server {
  const server = createServer(async (req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      const result = await healthCheck();
      const status = result.status === "ok" ? 200 : 503;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  server.listen(port);
  return server;
}
