import { slackifyMarkdown } from "slackify-markdown";

/**
 * Converts Markdown to Slack mrkdwn format using slackify-markdown,
 * with post-processing for tables (Slack has no native table support).
 */
export function markdownToSlack(markdown: string): string {
  if (!markdown) return markdown;

  // Pre-process: extract markdown tables and convert to code blocks
  // (slackify-markdown passes tables through as-is, which renders poorly in Slack)
  const withTables = convertTables(markdown);

  return slackifyMarkdown(withTables);
}

/**
 * Detect markdown tables and convert them to aligned fixed-width code blocks
 * before passing to slackify-markdown.
 */
function convertTables(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    if (isTableRow(lines[i]) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const tableLines: string[] = [];
      tableLines.push(lines[i]);
      i += 2; // skip separator

      while (i < lines.length && isTableRow(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }

      result.push(formatTable(tableLines));
    } else {
      result.push(lines[i]);
      i++;
    }
  }

  return result.join("\n");
}

function isTableRow(line: string): boolean {
  return line.includes("|") && line.trim().startsWith("|");
}

function isTableSeparator(line: string): boolean {
  return /^\|[\s\-:|]+\|$/.test(line.trim());
}

function parseCells(row: string): string[] {
  return row
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim());
}

function formatTable(rows: string[]): string {
  const parsed = rows.map(parseCells);
  if (parsed.length === 0) return "";

  const colCount = Math.max(...parsed.map((r) => r.length));

  const colWidths: number[] = Array.from({ length: colCount }, () => 0);
  for (const row of parsed) {
    for (let c = 0; c < colCount; c++) {
      const cell = row[c] ?? "";
      colWidths[c] = Math.max(colWidths[c], cell.length);
    }
  }

  const formatted = parsed.map((row) => {
    const cells = Array.from({ length: colCount }, (_, c) => {
      const cell = row[c] ?? "";
      return cell.padEnd(colWidths[c]);
    });
    return "| " + cells.join(" | ") + " |";
  });

  return "```\n" + formatted.join("\n") + "\n```";
}
