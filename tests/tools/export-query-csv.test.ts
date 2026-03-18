import { describe, it, expect, vi, beforeEach } from "vitest";
import { exportQueryToCsv } from "../../src/tools/export-query-csv.js";

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

const mockQuery = vi.fn();
const mockEnd = vi.fn().mockResolvedValue(undefined);

vi.mock("pg", () => {
  return {
    Pool: class MockPool {
      query = mockQuery;
      end = mockEnd;
    },
  };
});

import { writeFile } from "node:fs/promises";
const mockWriteFile = vi.mocked(writeFile);

describe("exportQueryToCsv", () => {
  const options = { connectionUrl: "postgres://test:test@localhost:5432/testdb" };

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnd.mockResolvedValue(undefined);
  });

  it("exports query results to CSV file and returns metadata with sample", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { id: 1, name: "Acme Corp", mrr: 3990 },
        { id: 2, name: "GlobalTech", mrr: 7980 },
      ],
      fields: [{ name: "id" }, { name: "name" }, { name: "mrr" }],
    });

    const result = await exportQueryToCsv(options, {
      query: "SELECT id, name, mrr FROM customers",
      output_path: "/sandbox/export.csv",
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("Exported 2 rows");
    expect(text).toContain("3 columns: id, name, mrr");
    expect(text).toContain("/sandbox/export.csv");
    expect(text).toContain("File size:");
    expect(text).toContain("Sample (first 2 rows):");
    expect(text).toContain("Acme Corp");

    expect(mockWriteFile).toHaveBeenCalledWith(
      "/sandbox/export.csv",
      "id,name,mrr\n1,Acme Corp,3990\n2,GlobalTech,7980\n",
      "utf-8",
    );
  });

  it("sample is capped at 5 rows", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: i, name: `Co${i}` }));
    mockQuery.mockResolvedValue({
      rows,
      fields: [{ name: "id" }, { name: "name" }],
    });

    const result = await exportQueryToCsv(options, {
      query: "SELECT id, name FROM companies",
      output_path: "/sandbox/out.csv",
    });

    const text = result.content[0].text;
    expect(text).toContain("Exported 10 rows");
    expect(text).toContain("Sample (first 5 rows):");
    // Should contain rows 0-4 but not 5+
    expect(text).toContain("Co4");
    expect(text).not.toContain("Co5");
  });

  it("reports correct file size in bytes", async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 1 }],
      fields: [{ name: "id" }],
    });

    const result = await exportQueryToCsv(options, {
      query: "SELECT id FROM t",
      output_path: "/sandbox/out.csv",
    });

    const csv = "id\n1\n";
    const expectedSize = Buffer.byteLength(csv, "utf-8");
    expect(result.content[0].text).toContain(`File size: ${expectedSize} bytes`);
  });

  it("handles CSV escaping for commas and quotes", async () => {
    mockQuery.mockResolvedValue({
      rows: [{ name: 'Foo, Inc.', desc: 'They said "hello"' }],
      fields: [{ name: "name" }, { name: "desc" }],
    });

    const result = await exportQueryToCsv(options, {
      query: "SELECT name, desc FROM companies",
      output_path: "/sandbox/out.csv",
    });

    expect(result.isError).toBeUndefined();
    const written = mockWriteFile.mock.calls[0][1] as string;
    expect(written).toContain('"Foo, Inc."');
    expect(written).toContain('"They said ""hello"""');
  });

  it("handles null values", async () => {
    mockQuery.mockResolvedValue({
      rows: [{ id: 1, email: null }],
      fields: [{ name: "id" }, { name: "email" }],
    });

    const result = await exportQueryToCsv(options, {
      query: "SELECT id, email FROM users",
      output_path: "/sandbox/out.csv",
    });

    expect(result.isError).toBeUndefined();
    const written = mockWriteFile.mock.calls[0][1] as string;
    expect(written).toBe("id,email\n1,\n");
  });

  it("returns message for 0 rows without writing file", async () => {
    mockQuery.mockResolvedValue({
      rows: [],
      fields: [{ name: "id" }],
    });

    const result = await exportQueryToCsv(options, {
      query: "SELECT id FROM empty_table",
      output_path: "/sandbox/out.csv",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("Query returned 0 rows. No file written.");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("rejects non-SELECT queries", async () => {
    const result = await exportQueryToCsv(options, {
      query: "DELETE FROM customers",
      output_path: "/sandbox/out.csv",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Only SELECT or WITH queries are allowed for CSV export.");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("rejects INSERT queries", async () => {
    const result = await exportQueryToCsv(options, {
      query: "INSERT INTO customers VALUES (1, 'test')",
      output_path: "/sandbox/out.csv",
    });

    expect(result.isError).toBe(true);
  });

  it("allows WITH (CTE) queries", async () => {
    mockQuery.mockResolvedValue({
      rows: [{ total: 5 }],
      fields: [{ name: "total" }],
    });

    const result = await exportQueryToCsv(options, {
      query: "WITH cte AS (SELECT 1) SELECT count(*) as total FROM cte",
      output_path: "/sandbox/out.csv",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Exported 1 rows");
  });

  it("returns error when query fails", async () => {
    mockQuery.mockRejectedValue(new Error('relation "foo" does not exist'));

    const result = await exportQueryToCsv(options, {
      query: "SELECT * FROM foo",
      output_path: "/sandbox/out.csv",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Export failed: relation "foo" does not exist');
  });

  it("always closes the pool", async () => {
    mockQuery.mockRejectedValue(new Error("fail"));

    await exportQueryToCsv(options, {
      query: "SELECT 1",
      output_path: "/sandbox/out.csv",
    });

    expect(mockEnd).toHaveBeenCalled();
  });
});
