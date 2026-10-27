/**
 * ZotLit & Obsidian Markdown Formatter.
 * Adheres to ZotLit protocol frontmatter and deep-linking contracts.
 */

export interface DiscussionExportParams {
  itemKey: string;             // Zotero 8-char base-32 key, e.g. "ABCD2345"
  attachmentKey: string;       // PDF attachment key
  title: string;
  citekey?: string;
  pageNumber: number;
  question: string;
  aiResponse: string;
  selectedText?: string;
  date?: string;
}

/**
 * Generates an Obsidian Literature Note discussion markdown file.
 * Compatible with ZotLit frontmatter parser (`zt-item-key`).
 */
export function formatZotlitDiscussionMarkdown(params: DiscussionExportParams): string {
  const dateStr = params.date || new Date().toISOString().split("T")[0];
  const zoteroUri = `zotero://open-pdf/library/items/${params.attachmentKey}?page=${params.pageNumber}`;
  const citeLink = params.citekey ? `[[@${params.citekey}]]` : `"${params.title}"`;

  const lines: string[] = [
    "---",
    `zt-item-key: "${params.itemKey}"`,
    `title: "AI Discussion: ${params.title.replace(/"/g, '\\"')}"`,
    "type: literature-discussion",
    `date: ${dateStr}`,
    "source: zotero-ai-agent",
    "---",
    "",
    `# AI Discussion: ${params.title}`,
    "",
    `**Reference**: ${citeLink} | [Open in Zotero PDF (Page ${params.pageNumber})](${zoteroUri})`,
    ""
  ];

  if (params.selectedText && params.selectedText.trim()) {
    lines.push(
      "### Targeted Excerpt",
      "> " + params.selectedText.trim().replace(/\n/g, "\n> "),
      ""
    );
  }

  lines.push(
    "### Question",
    params.question.trim(),
    "",
    "### Synthesis & Findings",
    params.aiResponse.trim(),
    ""
  );

  return lines.join("\n");
}
