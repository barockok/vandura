import type { Pool } from "./db/connection.js";
import type { StorageService } from "./storage/s3.js";
import type { CredentialManager } from "./credentials/manager.js";
import { createServer, type Server } from "node:http";

interface HealthDeps {
  pool: Pool;
  storage?: StorageService;
  credentialManager?: CredentialManager;
}

export interface HealthResult {
  status: "ok" | "degraded";
  database: string;
  storage: string;
  oauth?: {
    total: number;
    valid: number;
    expiring: number;
    expired: number;
  };
  uptime: number;
}

export function buildHealthCheck(deps: HealthDeps): () => Promise<HealthResult> {
  const startTime = Date.now();

  return async (): Promise<HealthResult> => {
    let dbStatus = "connected";
    let storageStatus = "connected";
    let allOk = true;
    let oauthStatus: HealthResult["oauth"] = undefined;

    try {
      await deps.pool.query("SELECT 1");
    } catch (err) {
      dbStatus = `error: ${err instanceof Error ? err.message : "unknown"}`;
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

    // Check OAuth token health if credential manager is available
    if (deps.credentialManager) {
      try {
        const healthChecks = await deps.credentialManager.checkOAuthHealth();
        oauthStatus = {
          total: healthChecks.length,
          valid: healthChecks.filter((h) => h.status === "valid").length,
          expiring: healthChecks.filter((h) => h.status === "expiring").length,
          expired: healthChecks.filter((h) => h.status === "expired").length,
        };
        if (oauthStatus.expired > 0 || oauthStatus.expiring > 0) {
          allOk = false;
        }
      } catch {
        oauthStatus = { total: 0, valid: 0, expiring: 0, expired: 0 };
        // Don't fail health check for OAuth errors, just report degraded
      }
    }

    return {
      status: allOk ? "ok" : "degraded",
      database: dbStatus,
      storage: storageStatus,
      oauth: oauthStatus,
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
