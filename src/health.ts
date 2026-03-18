import type { Redis } from "ioredis";
import type { StorageService } from "./storage/s3.js";
import { createServer, type Server } from "node:http";

interface HealthDeps {
  redis: Redis;
  storage?: StorageService;
}

export interface HealthResult {
  status: "ok" | "degraded";
  redis: string;
  storage: string;
  uptime: number;
}

export function buildHealthCheck(deps: HealthDeps): () => Promise<HealthResult> {
  const startTime = Date.now();

  return async (): Promise<HealthResult> => {
    let redisStatus = "connected";
    let storageStatus = "connected";
    let allOk = true;

    try {
      await deps.redis.ping();
    } catch (err) {
      redisStatus = `error: ${err instanceof Error ? err.message : "unknown"}`;
      allOk = false;
    }

    if (deps.storage) {
      try {
        await deps.storage.ensureBucket();
      } catch (err) {
        storageStatus = `error: ${err instanceof Error ? err.message : "unknown"}`;
        allOk = false;
      }
    } else {
      storageStatus = "not_configured";
    }

    return {
      status: allOk ? "ok" : "degraded",
      redis: redisStatus,
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
