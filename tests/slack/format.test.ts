import { describe, it, expect } from "vitest";
import { markdownToSlack } from "../../src/slack/format.js";

describe("markdownToSlack", () => {
  describe("bold", () => {
    it("converts **bold** to *bold*", () => {
      expect(markdownToSlack("This is **bold** text")).toBe("This is *bold* text");
    });

    it("converts __bold__ to *bold*", () => {
      expect(markdownToSlack("This is __bold__ text")).toBe("This is *bold* text");
    });
  });

  describe("italic", () => {
    it("converts *italic* to _italic_ (single asterisk)", () => {
      expect(markdownToSlack("This is *italic* text")).toBe("This is _italic_ text");
    });

    it("converts _italic_ (underscore) unchanged", () => {
      expect(markdownToSlack("This is _italic_ text")).toBe("This is _italic_ text");
    });
  });

  describe("bold + italic ordering", () => {
    it("handles bold and italic in same string", () => {
      expect(markdownToSlack("**bold** and *italic*")).toBe("*bold* and _italic_");
    });

    it("handles ***bold italic*** to *_bold italic_*", () => {
      expect(markdownToSlack("***bold italic***")).toBe("*_bold italic_*");
    });
  });

  describe("strikethrough", () => {
    it("converts ~~strike~~ to ~strike~", () => {
      expect(markdownToSlack("This is ~~removed~~ text")).toBe("This is ~removed~ text");
    });
  });

  describe("links", () => {
    it("converts [text](url) to <url|text>", () => {
      expect(markdownToSlack("See [Google](https://google.com) here")).toBe(
        "See <https://google.com|Google> here",
      );
    });

    it("converts bare URLs unchanged", () => {
      expect(markdownToSlack("Visit https://example.com today")).toBe(
        "Visit https://example.com today",
      );
    });

    it("converts image ![alt](url) to <url|alt>", () => {
      expect(markdownToSlack("![logo](https://img.com/logo.png)")).toBe(
        "<https://img.com/logo.png|logo>",
      );
    });
  });

  describe("headers", () => {
    it("converts # H1 to bold", () => {
      expect(markdownToSlack("# Main Title")).toBe("*Main Title*");
    });

    it("converts ## H2 to bold", () => {
      expect(markdownToSlack("## Section")).toBe("*Section*");
    });

    it("converts ### H3 to bold", () => {
      expect(markdownToSlack("### Subsection")).toBe("*Subsection*");
    });

    it("only converts headers at start of line", () => {
      expect(markdownToSlack("Not a # header")).toBe("Not a # header");
    });
  });

  describe("code", () => {
    it("preserves inline code", () => {
      expect(markdownToSlack("Use `console.log()` here")).toBe("Use `console.log()` here");
    });

    it("preserves code blocks", () => {
      const input = "```sql\nSELECT * FROM users;\n```";
      expect(markdownToSlack(input)).toBe("```\nSELECT * FROM users;\n```");
    });

    it("does not transform content inside code blocks", () => {
      const input = "```\n**not bold** and [not a link](url)\n```";
      expect(markdownToSlack(input)).toBe("```\n**not bold** and [not a link](url)\n```");
    });

    it("does not transform content inside inline code", () => {
      expect(markdownToSlack("Use `**not bold**` here")).toBe("Use `**not bold**` here");
    });
  });

  describe("blockquotes", () => {
    it("preserves > blockquotes (same in Slack)", () => {
      expect(markdownToSlack("> This is a quote")).toBe("> This is a quote");
    });
  });

  describe("lists", () => {
    it("preserves unordered lists with -", () => {
      expect(markdownToSlack("- item one\n- item two")).toBe("- item one\n- item two");
    });

    it("converts * list markers to - (avoid bold confusion)", () => {
      expect(markdownToSlack("* item one\n* item two")).toBe("- item one\n- item two");
    });

    it("preserves ordered lists", () => {
      expect(markdownToSlack("1. first\n2. second")).toBe("1. first\n2. second");
    });
  });

  describe("tables", () => {
    it("converts markdown tables to fixed-width code blocks", () => {
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
      // Should strip the separator row
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
      // Columns should be padded to equal width
      const lines = result.split("\n").filter((l) => l.includes("|"));
      if (lines.length > 1) {
        // All pipe positions should align
        const pipePositions = lines.map((l) =>
          [...l].reduce<number[]>((acc, c, i) => (c === "|" ? [...acc, i] : acc), []),
        );
        expect(pipePositions[0]).toEqual(pipePositions[1]);
      }
    });

    it("preserves text around tables", () => {
      const input = "Before table\n| A | B |\n|---|---|\n| 1 | 2 |\nAfter table";
      const result = markdownToSlack(input);
      expect(result).toContain("Before table");
      expect(result).toContain("After table");
    });
  });

  describe("horizontal rules", () => {
    it("converts --- to separator", () => {
      expect(markdownToSlack("above\n---\nbelow")).toBe("above\n---\nbelow");
    });
  });

  describe("complex content", () => {
    it("handles mixed formatting", () => {
      const input = [
        "# Report",
        "",
        "The **database** query returned *no results*.",
        "",
        "See [documentation](https://docs.example.com) for details.",
        "",
        "```sql",
        "SELECT **not_bold** FROM table;",
        "```",
      ].join("\n");

      const result = markdownToSlack(input);
      expect(result).toContain("*Report*");
      expect(result).toContain("*database*");
      expect(result).toContain("_no results_");
      expect(result).toContain("<https://docs.example.com|documentation>");
      expect(result).toContain("SELECT **not_bold** FROM table;");
    });

    it("handles empty string", () => {
      expect(markdownToSlack("")).toBe("");
    });

    it("handles plain text with no formatting", () => {
      expect(markdownToSlack("Just plain text")).toBe("Just plain text");
    });
  });
});
