import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { StorageService, type StorageConfig } from "../../src/storage/s3.js";

describe("StorageService", () => {
  let container: StartedTestContainer;
  let service: StorageService;
  const bucket = "test-bucket";

  beforeAll(async () => {
    container = await new GenericContainer("minio/minio:latest")
      .withExposedPorts(9000)
      .withCommand(["server", "/data"])
      .withEnvironment({
        MINIO_ROOT_USER: "test",
        MINIO_ROOT_PASSWORD: "testtest1",
      })
      .withStartupTimeout(60_000)
      .start();

    const config: StorageConfig = {
      endpoint: `http://${container.getHost()}:${container.getMappedPort(9000)}`,
      accessKey: "test",
      secretKey: "testtest1",
      bucket,
      region: "us-east-1",
      signedUrlExpiry: 3600,
    };

    service = new StorageService(config);
    await service.ensureBucket();
  });

  afterAll(async () => {
    if (container) await container.stop();
  });

  it("uploads content and generates a signed URL", async () => {
    const content = Buffer.from("hello world");
    const key = "test/greeting.txt";

    const result = await service.upload({
      key,
      content,
      contentType: "text/plain",
    });

    expect(result.key).toBe(key);
    expect(result.signedUrl).toContain(bucket);
    expect(result.signedUrl).toContain(encodeURIComponent(key).replace(/%2F/g, "/"));
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("round-trips upload and download with matching content", async () => {
    const content = Buffer.from("round-trip test data 🚀");
    const key = "test/roundtrip.bin";

    await service.upload({
      key,
      content,
      contentType: "application/octet-stream",
    });

    const downloaded = await service.download(key);
    expect(downloaded).toEqual(content);
  });
});
