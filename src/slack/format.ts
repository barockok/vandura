/**
 * Converts Markdown text to Slack mrkdwn format.
 *
 * Key conversions:
 * - **bold** / __bold__  →  *bold*
 * - *italic*             →  _italic_
 * - ***bold italic***    →  *_bold italic_*
 * - ~~strike~~           →  ~strike~
 * - [text](url)          →  <url|text>
 * - ![alt](url)          →  <url|alt>
 * - # Header             →  *Header*
 * - ```lang ... ```      →  ``` ... ```  (strip language tag)
 * - * list item          →  - list item
 * - Markdown tables      →  aligned fixed-width in code blocks
 *
 * Content inside code blocks and inline code is preserved as-is.
 */
export function markdownToSlack(markdown: string): string {
  if (!markdown) return markdown;

  // Split into code-protected segments and non-code segments
  const segments = splitByCode(markdown);

  const converted = segments
    .map((seg) => {
      if (seg.isCode) return seg.text;
      return convertNonCodeSegment(seg.text);
    })
    .join("");

  return converted;
}

interface Segment {
  text: string;
  isCode: boolean;
}

/**
 * Split text into code blocks / inline code and regular text segments.
 * Code content is never transformed.
 */
function splitByCode(text: string): Segment[] {
  const segments: Segment[] = [];
  // Match fenced code blocks (```...```) or inline code (`...`)
  const codePattern = /(```[\s\S]*?```|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codePattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), isCode: false });
    }

    let codeText = match[0];
    // Strip language identifier from fenced code blocks
    if (codeText.startsWith("```") && codeText.endsWith("```") && codeText.length > 6) {
      const inner = codeText.slice(3, -3);
      const newlineIndex = inner.indexOf("\n");
      if (newlineIndex !== -1) {
        const firstLine = inner.slice(0, newlineIndex).trim();
        // If first line looks like a language identifier (no spaces, short)
        if (firstLine && !firstLine.includes(" ") && firstLine.length <= 20) {
          codeText = "```\n" + inner.slice(newlineIndex + 1) + "```";
        }
      }
    }

    segments.push({ text: codeText, isCode: true });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), isCode: false });
  }

  return segments;
}

// Placeholders to protect converted markers from re-matching
const BOLD_OPEN = "\x01B_OPEN\x02";
const BOLD_CLOSE = "\x01B_CLOSE\x02";
const ITALIC_OPEN = "\x01I_OPEN\x02";
const ITALIC_CLOSE = "\x01I_CLOSE\x02";
const STRIKE_OPEN = "\x01S_OPEN\x02";
const STRIKE_CLOSE = "\x01S_CLOSE\x02";

/**
 * Convert a non-code text segment from Markdown to Slack mrkdwn.
 */
function convertNonCodeSegment(text: string): string {
  let result = text;

  // Tables: detect and convert before other transforms
  result = convertTables(result);

  // List markers: * item → - item (before italic/bold to avoid confusion)
  result = result.replace(/^\* /gm, "- ");

  // Images: ![alt](url) → <url|alt>  (before links)
  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "<$2|$1>");

  // Links: [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Bold italic: ***text*** → *_text_* (before bold and italic)
  result = result.replace(/\*{3}(.+?)\*{3}/g, `${BOLD_OPEN}${ITALIC_OPEN}$1${ITALIC_CLOSE}${BOLD_CLOSE}`);

  // Bold: **text** or __text__ → *text*
  result = result.replace(/\*{2}(.+?)\*{2}/g, `${BOLD_OPEN}$1${BOLD_CLOSE}`);
  result = result.replace(/__(.+?)__/g, `${BOLD_OPEN}$1${BOLD_CLOSE}`);

  // Italic: *text* → _text_ (single asterisks only, placeholders protect bold)
  result = result.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, `${ITALIC_OPEN}$1${ITALIC_CLOSE}`);

  // Strikethrough: ~~text~~ → ~text~
  result = result.replace(/~~(.+?)~~/g, `${STRIKE_OPEN}$1${STRIKE_CLOSE}`);

  // Headers: # Text → *Text* (at start of line)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, `${BOLD_OPEN}$1${BOLD_CLOSE}`);

  // Replace placeholders with actual Slack markers
  result = result.replace(new RegExp(escapeRegex(BOLD_OPEN), "g"), "*");
  result = result.replace(new RegExp(escapeRegex(BOLD_CLOSE), "g"), "*");
  result = result.replace(new RegExp(escapeRegex(ITALIC_OPEN), "g"), "_");
  result = result.replace(new RegExp(escapeRegex(ITALIC_CLOSE), "g"), "_");
  result = result.replace(new RegExp(escapeRegex(STRIKE_OPEN), "g"), "~");
  result = result.replace(new RegExp(escapeRegex(STRIKE_CLOSE), "g"), "~");

  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Detect markdown tables and convert them to aligned fixed-width text in code blocks.
 */
function convertTables(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    // Detect table: line with | and next line is separator |---|
    if (isTableRow(lines[i]) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const tableLines: string[] = [];
      tableLines.push(lines[i]); // header
      i += 2; // skip separator

      // Collect remaining table rows
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
    .slice(1, -1) // remove leading/trailing empty from |...|
    .map((c) => c.trim());
}

function formatTable(rows: string[]): string {
  const parsed = rows.map(parseCells);
  if (parsed.length === 0) return "";

  const colCount = Math.max(...parsed.map((r) => r.length));

  // Calculate max width per column
  const colWidths: number[] = Array.from({ length: colCount }, () => 0);
  for (const row of parsed) {
    for (let c = 0; c < colCount; c++) {
      const cell = row[c] ?? "";
      colWidths[c] = Math.max(colWidths[c], cell.length);
    }
  }

  // Build aligned rows
  const formatted = parsed.map((row) => {
    const cells = Array.from({ length: colCount }, (_, c) => {
      const cell = row[c] ?? "";
      return cell.padEnd(colWidths[c]);
    });
    return "| " + cells.join(" | ") + " |";
  });

  return "```\n" + formatted.join("\n") + "\n```";
}
