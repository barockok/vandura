import { describe, it, expect } from "vitest";
import { isMemoryWrite, shouldBlockMemoryWrite } from "../../src/hooks/pre-tool-use.js";

describe("memory write guard", () => {
  const memoryDir = "/home/vandura/.vandura/memory";

  it("detects Write tool targeting memory directory", () => {
    expect(isMemoryWrite("Write", { file_path: "/home/vandura/.vandura/memory/tips.md" }, memoryDir)).toBe(true);
  });

  it("detects Edit tool targeting memory directory", () => {
    expect(isMemoryWrite("Edit", { file_path: "/home/vandura/.vandura/memory/tips.md" }, memoryDir)).toBe(true);
  });

  it("ignores Write tool targeting other directories", () => {
    expect(isMemoryWrite("Write", { file_path: "/tmp/output.txt" }, memoryDir)).toBe(false);
  });

  it("ignores non-write tools", () => {
    expect(isMemoryWrite("Read", { file_path: "/home/vandura/.vandura/memory/tips.md" }, memoryDir)).toBe(false);
  });

  it("blocks writes containing sensitive data", () => {
    const result = shouldBlockMemoryWrite({ content: "The key is sk-ant-abc123def456" });
    expect(result).toBeTruthy();
    expect(result).toContain("sensitive data");
  });

  it("allows writes with safe content", () => {
    const result = shouldBlockMemoryWrite({ content: "Use rate() for request latency" });
    expect(result).toBeNull();
  });
});
