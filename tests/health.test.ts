// tests/health.test.ts
import { describe, it, expect, vi } from "vitest";
import { buildHealthCheck } from "../src/health.js";

describe("Health check", () => {
  it("returns ok when all services are healthy", async () => {
    const check = buildHealthCheck({
      pool: { query: vi.fn().mockResolvedValue({ rows: [{ ok: 1 }] }) } as any,
      storage: { ensureBucket: vi.fn().mockResolvedValue(undefined) } as any,
    });
    const result = await check();
    expect(result.status).toBe("ok");
    expect(result.database).toBe("connected");
    expect(result.storage).toBe("connected");
  });

  it("returns degraded when a service is down", async () => {
    const check = buildHealthCheck({
      pool: { query: vi.fn().mockRejectedValue(new Error("connection refused")) } as any,
      storage: { ensureBucket: vi.fn().mockResolvedValue(undefined) } as any,
    });
    const result = await check();
    expect(result.status).toBe("degraded");
    expect(result.database).toBe("error: connection refused");
  });
});
