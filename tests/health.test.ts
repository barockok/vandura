// tests/health.test.ts
import { describe, it, expect, vi } from "vitest";
import { buildHealthCheck } from "../src/health.js";

describe("Health check", () => {
  it("returns ok when all services are healthy", async () => {
    const check = buildHealthCheck({
      redis: { ping: vi.fn().mockResolvedValue("PONG") } as any,
      storage: { ensureBucket: vi.fn().mockResolvedValue(undefined) } as any,
    });
    const result = await check();
    expect(result.status).toBe("ok");
    expect(result.redis).toBe("connected");
    expect(result.storage).toBe("connected");
  });

  it("returns degraded when a service is down", async () => {
    const check = buildHealthCheck({
      redis: { ping: vi.fn().mockRejectedValue(new Error("connection refused")) } as any,
      storage: { ensureBucket: vi.fn().mockResolvedValue(undefined) } as any,
    });
    const result = await check();
    expect(result.status).toBe("degraded");
    expect(result.redis).toBe("error: connection refused");
  });
});
