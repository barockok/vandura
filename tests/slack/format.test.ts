import { describe, it, expect } from "vitest";
import { markdownToSlack } from "../../src/slack/format.js";

describe("markdownToSlack", () => {
  describe("bold", () => {
    it("converts **bold** to *bold*", () => {
      expect(markdownToSlack("**bold**")).toContain("*bold*");
    });

    it("converts __bold__ to *bold*", () => {
      expect(markdownToSlack("__bold__")).toContain("*bold*");
    });
  });

  describe("italic", () => {
    it("converts *italic* to _italic_", () => {
      expect(markdownToSlack("*italic*")).toContain("_italic_");
    });

    it("converts _italic_ to _italic_", () => {
      expect(markdownToSlack("_italic_")).toContain("_italic_");
    });
  });

  describe("bold + italic", () => {
    it("handles bold and italic in same string", () => {
      const result = markdownToSlack("**bold** and *italic*");
      expect(result).toContain("*bold*");
      expect(result).toContain("_italic_");
    });
  });

  describe("strikethrough", () => {
    it("converts ~~strike~~ to ~strike~", () => {
      expect(markdownToSlack("~~removed~~")).toContain("~removed~");
    });
  });

  describe("links", () => {
    it("converts [text](url) to <url|text>", () => {
      expect(markdownToSlack("[Google](https://google.com)")).toContain(
        "<https://google.com|Google>",
      );
    });

    it("converts image ![alt](url) to <url|alt>", () => {
      expect(markdownToSlack("![logo](https://img.com/logo.png)")).toContain(
        "<https://img.com/logo.png|logo>",
      );
    });

    it("converts links with complex URLs containing query params", () => {
      const url = "http://localhost:9000/bucket/file.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc123";
      expect(markdownToSlack(`[Download](${url})`)).toContain(
        `<${url}|Download>`,
      );
    });
  });

  describe("headers", () => {
    it("converts # H1 to bold", () => {
      expect(markdownToSlack("# Main Title")).toContain("*Main Title*");
    });

    it("converts ## H2 to bold", () => {
      expect(markdownToSlack("## Section")).toContain("*Section*");
    });

    it("converts ### H3 to bold", () => {
      expect(markdownToSlack("### Subsection")).toContain("*Subsection*");
    });
  });

  describe("code", () => {
    it("preserves inline code", () => {
      expect(markdownToSlack("Use `console.log()` here")).toContain("`console.log()`");
    });

    it("preserves code blocks and strips language tag", () => {
      const input = "```sql\nSELECT * FROM users;\n```";
      const result = markdownToSlack(input);
      expect(result).toContain("```");
      expect(result).toContain("SELECT * FROM users;");
      expect(result).not.toContain("sql");
    });

    it("does not transform content inside code blocks", () => {
      const input = "```\n**not bold** and [not a link](url)\n```";
      const result = markdownToSlack(input);
      expect(result).toContain("**not bold**");
    });
  });

  describe("blockquotes", () => {
    it("preserves > blockquotes", () => {
      expect(markdownToSlack("> This is a quote")).toContain("> This is a quote");
    });
  });

  describe("lists", () => {
    it("converts unordered lists", () => {
      const result = markdownToSlack("- item one\n- item two");
      expect(result).toContain("item one");
      expect(result).toContain("item two");
    });

    it("converts ordered lists", () => {
      const result = markdownToSlack("1. first\n2. second");
      expect(result).toContain("1.");
      expect(result).toContain("first");
      expect(result).toContain("2.");
      expect(result).toContain("second");
    });
  });

  describe("tables", () => {
    it("converts markdown tables to code blocks", () => {
      const input = [
        "| Name | Age |",
        "|------|-----|",
        "| Alice | 30 |",
        "| Bob | 25 |",
      ].join("\n");

      const result = markdownToSlack(input);
      expect(result).toContain("```");
      expect(result).toContain("Name");
      expect(result).toContain("Alice");
      expect(result).not.toContain("---");
    });

    it("aligns table columns", () => {
      const input = [
        "| Name | Age |",
        "|------|-----|",
        "| Alice | 30 |",
        "| Bob | 25 |",
      ].join("\n");

      const result = markdownToSlack(input);
      // All data rows should have pipes at same positions
      const dataLines = result
        .split("\n")
        .filter((l) => l.includes("|") && !l.startsWith("```"));
      if (dataLines.length > 1) {
        const pipePositions = dataLines.map((l) =>
          [...l].reduce<number[]>((acc, c, i) => (c === "|" ? [...acc, i] : acc), []),
        );
        expect(pipePositions[0]).toEqual(pipePositions[1]);
      }
    });

    it("preserves text around tables", () => {
      const input = "Before\n| A | B |\n|---|---|\n| 1 | 2 |\nAfter";
      const result = markdownToSlack(input);
      expect(result).toContain("Before");
      expect(result).toContain("After");
    });
  });

  describe("edge cases", () => {
    it("handles empty string", () => {
      expect(markdownToSlack("")).toBe("");
    });

    it("handles plain text", () => {
      const result = markdownToSlack("Just plain text");
      expect(result).toContain("Just plain text");
    });

    it("handles complex mixed content", () => {
      const input = [
        "# Report",
        "",
        "The **database** query returned *no results*.",
        "",
        "See [docs](https://docs.example.com) for details.",
        "",
        "```sql",
        "SELECT **not_bold** FROM table;",
        "```",
      ].join("\n");

      const result = markdownToSlack(input);
      expect(result).toContain("*Report*");
      expect(result).toContain("*database*");
      expect(result).toContain("_no results_");
      expect(result).toContain("<https://docs.example.com|docs>");
      expect(result).toContain("SELECT **not_bold** FROM table;");
    });
  });
});
