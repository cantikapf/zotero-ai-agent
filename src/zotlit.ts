/**
 * ZotLit & Obsidian Markdown Formatter.
 * Adheres to ZotLit protocol frontmatter and deep-linking contracts.
 *
 * Pinned against the ZotLit docs (zotlit.aidenlx.site):
 *   - A file is a literature note iff it carries `zotero-key` (system-managed, never overridable).
 *     Value is `KEY` for My Library and `KEYg<groupID>` for a group library.
 *   - `%%zt-managed%%` … `%%/zt-managed%%` belongs to ZotLit. Everything outside it is the user's
 *     writing, so discussions go OUTSIDE it — a ZotLit refresh must never eat them.
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
  /** Group library id. Omitted for My Library; changes both `zotero-key` and the deep link. */
  groupID?: number;
  /** Page label as the reader shows it, when it differs from the 1-based page number. */
  pageLabel?: string;
}

/** `zotero-key` for a library: `KEY` in My Library, `KEYg<groupID>` in a group library. */
export function zotlitZoteroKey(itemKey: string, groupID?: number): string {
  return groupID ? `${itemKey}g${groupID}` : itemKey;
}

/**
 * Deep link to the PDF at a page. Verified against Zotero's own protocol handler
 * (chrome/content/zotero/ZoteroProtocolHandler.mjs, `OpenExtension` routes):
 *   zotero://open-pdf/library/items/<key>?page=<n>
 *   zotero://open-pdf/groups/<groupID>/items/<key>?page=<n>
 */
export function zoteroPdfUri(attachmentKey: string, pageNumber: number, groupID?: number): string {
  const path = groupID
    ? `groups/${groupID}/items/${attachmentKey}`
    : `library/items/${attachmentKey}`;
  const page = Number(pageNumber) > 0 ? `?page=${Math.floor(Number(pageNumber))}` : "";
  return `zotero://open-pdf/${path}${page}`;
}

/** Vault-safe file name. One file per paper; discussions append to it. */
export function discussionFileName(itemKey: string): string {
  return `AI Discussions - ${itemKey}.md`;
}

/**
 * Generates an Obsidian Literature Note discussion markdown file.
 * ZotLit v2 pins a literature note to Zotero with a single frontmatter field,
 * `zotero-key` (`zt-item-key` is an internal @zotlit/db module name, not a frontmatter key).
 */
export function formatZotlitDiscussionMarkdown(params: DiscussionExportParams): string {
  const dateStr = params.date || new Date().toISOString().split("T")[0];
  const zoteroUri = zoteroPdfUri(params.attachmentKey, params.pageNumber, params.groupID);
  const citeLink = params.citekey ? `[[@${params.citekey}]]` : `"${params.title}"`;
  const pageLabel = params.pageLabel || String(params.pageNumber);

  const lines: string[] = [
    "---",
    `zotero-key: "${zotlitZoteroKey(params.itemKey, params.groupID)}"`,
    `title: "AI Discussion: ${params.title.replace(/"/g, '\\"')}"`,
    "type: literature-discussion",
    `date: ${dateStr}`,
    "source: zotero-ai-agent",
    "---",
    "",
    `# AI Discussion: ${params.title}`,
    "",
    `**Reference**: ${citeLink} | [Open in Zotero PDF (Page ${pageLabel})](${zoteroUri})`,
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

/** Frontmatter of an existing export, or null when the file has none. */
export function readFrontmatter(markdown: string): Record<string, string> | null {
  const text = String(markdown || "");
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  const out: Record<string, string> = {};
  for (const line of text.slice(3, end).split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (match) out[match[1]] = match[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

/**
 * Appends one discussion to an existing export file.
 *
 * Append, not overwrite: a second question must not delete the first answer, and this file may
 * sit beside a real ZotLit literature note. The frontmatter is only produced for a new file — an
 * existing `zotero-key` (ZotLit's system-managed identity) is never rewritten, so an export can
 * never re-point a note at a different item.
 *
 * ponytail: no `%%zt-managed%%` region — that block is ZotLit's, and its update replaces it.
 * Discussions live outside it, under a plain rule.
 */
export function appendDiscussionSection(existing: string, params: DiscussionExportParams): string {
  const base = String(existing || "");
  if (!base.trim()) return formatZotlitDiscussionMarkdown(params);

  const dateStr = params.date || new Date().toISOString().split("T")[0];
  const zoteroUri = zoteroPdfUri(params.attachmentKey, params.pageNumber, params.groupID);
  const pageLabel = params.pageLabel || String(params.pageNumber);

  const block: string[] = [
    "---",
    "",
    `## Discussion ${dateStr} — p. ${pageLabel}`,
    "",
    `[Open in Zotero PDF (Page ${pageLabel})](${zoteroUri})`,
    ""
  ];
  if (params.selectedText && params.selectedText.trim()) {
    block.push("> " + params.selectedText.trim().replace(/\n/g, "\n> "), "");
  }
  block.push("### Question", params.question.trim(), "", "### Synthesis & Findings", params.aiResponse.trim(), "");

  return base.replace(/\s*$/, "") + "\n\n" + block.join("\n");
}
