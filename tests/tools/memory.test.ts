import { describe, it, expect } from "vitest";
import { containsSensitiveData } from "../../src/tools/memory.js";

describe("containsSensitiveData", () => {
  it("detects sk- prefixed keys", () => {
    expect(containsSensitiveData("key is sk-ant-abc123def456")).toBe(true);
  });

  it("detects sk_ prefixed keys", () => {
    expect(containsSensitiveData("key is sk_live_abc123def456")).toBe(true);
  });

  it("detects xox tokens", () => {
    expect(containsSensitiveData("token xoxb-123-456-abc")).toBe(true);
  });

  it("detects glsa_ tokens", () => {
    expect(containsSensitiveData("use glsa_abc123 for grafana")).toBe(true);
  });

  it("detects Bearer tokens", () => {
    expect(containsSensitiveData("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9")).toBe(true);
  });

  it("detects password= patterns", () => {
    expect(containsSensitiveData("password=hunter2")).toBe(true);
  });

  it("detects secret= patterns", () => {
    expect(containsSensitiveData("secret=abc123xyz")).toBe(true);
  });

  it("detects PEM private keys", () => {
    expect(containsSensitiveData("-----BEGIN PRIVATE KEY-----")).toBe(true);
    expect(containsSensitiveData("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
  });

  it("allows safe content", () => {
    expect(containsSensitiveData("Use rate(http_requests_total[5m]) for latency")).toBe(false);
  });

  it("allows the word 'token' in normal context", () => {
    expect(containsSensitiveData("The GRAFANA_API_KEY config variable name")).toBe(false);
  });

  it("allows discussion of passwords without actual values", () => {
    expect(containsSensitiveData("The user needs to reset their password")).toBe(false);
  });
});
