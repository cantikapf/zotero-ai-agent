/**
 * Obsidian / ZotLit export contract.
 *
 * Pinned to the ZotLit docs (zotlit.aidenlx.site): `zotero-key` is the only system-managed
 * frontmatter key and identifies the literature note (`KEY` or `KEYg<groupID>`); ZotLit owns the
 * `%%zt-managed%%` region, so our discussions must never be written inside it. Deep links follow
 * Zotero's own protocol handler (ZoteroProtocolHandler.mjs, OpenExtension routes).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appendDiscussionSection,
  discussionFileName,
  formatZotlitDiscussionMarkdown,
  readFrontmatter,
  zoteroPdfUri,
  zotlitZoteroKey
} from "../src/zotlit.ts";

const base = {
  itemKey: "ABCD2345",
  attachmentKey: "PDF12345",
  title: "Techno-Nationalism in Global Business",
  citekey: "buckley2020",
  pageNumber: 7,
  question: "How does techno-nationalism affect supply chains?",
  aiResponse: "Techno-nationalism forces localization of critical infrastructure.",
  selectedText: "critical infrastructure localization",
  date: "2026-10-27"
};

describe("zotlit identity and deep links", () => {
  it("uses KEY for My Library and KEYg<groupID> for a group library", () => {
    assert.equal(zotlitZoteroKey("ABCD2345"), "ABCD2345");
    assert.equal(zotlitZoteroKey("ABCD2345", 42), "ABCD2345g42");
  });

  it("builds the personal-library PDF URI", () => {
    assert.equal(
      zoteroPdfUri("PDF12345", 7),
      "zotero://open-pdf/library/items/PDF12345?page=7"
    );
  });

  it("builds the group-library PDF URI", () => {
    assert.equal(
      zoteroPdfUri("PDF12345", 7, 42),
      "zotero://open-pdf/groups/42/items/PDF12345?page=7"
    );
  });

  it("omits the page parameter when the page is unknown", () => {
    assert.equal(zoteroPdfUri("PDF12345", 0), "zotero://open-pdf/library/items/PDF12345");
  });

  it("names one file per paper", () => {
    assert.equal(discussionFileName("ABCD2345"), "AI Discussions - ABCD2345.md");
  });
});

describe("formatZotlitDiscussionMarkdown", () => {
  it("writes zotero-key, citekey link, style block and the page deep link", () => {
    const md = formatZotlitDiscussionMarkdown(base);
    assert.match(md, /^---\n/);
    assert.match(md, /zotero-key: "ABCD2345"/);
    assert.match(md, /\[\[@buckley2020\]\]/);
    assert.match(md, /zotero:\/\/open-pdf\/library\/items\/PDF12345\?page=7/);
    assert.match(md, /### Question\nHow does techno-nationalism/);
    assert.match(md, /### Synthesis & Findings/);
  });

  it("never emits a zt-managed region, which ZotLit owns", () => {
    assert.doesNotMatch(formatZotlitDiscussionMarkdown(base), /%%\/?zt-managed%%/);
  });

  it("pins the group identity in both frontmatter and link", () => {
    const md = formatZotlitDiscussionMarkdown({ ...base, groupID: 42 });
    assert.match(md, /zotero-key: "ABCD2345g42"/);
    assert.match(md, /zotero:\/\/open-pdf\/groups\/42\/items\/PDF12345\?page=7/);
  });

  it("escapes quotes in the title instead of breaking the YAML block", () => {
    const md = formatZotlitDiscussionMarkdown({ ...base, title: 'A "quoted" title' });
    assert.match(md, /title: "AI Discussion: A \\"quoted\\" title"/);
  });

  it("renders a multi-line excerpt as one blockquote", () => {
    const md = formatZotlitDiscussionMarkdown({ ...base, selectedText: "line one\nline two" });
    assert.match(md, /> line one\n> line two/);
  });

  it("drops the excerpt section entirely when nothing was selected", () => {
    const md = formatZotlitDiscussionMarkdown({ ...base, selectedText: "  " });
    assert.doesNotMatch(md, /Targeted Excerpt/);
  });

  it("falls back to the page label when the reader supplies one", () => {
    const md = formatZotlitDiscussionMarkdown({ ...base, pageNumber: 9, pageLabel: "ix" });
    assert.match(md, /Open in Zotero PDF \(Page ix\)/);
  });
});

describe("appendDiscussionSection", () => {
  it("creates the full note when the file does not exist yet", () => {
    assert.equal(appendDiscussionSection("", base), formatZotlitDiscussionMarkdown(base));
    assert.equal(appendDiscussionSection("   \n", base), formatZotlitDiscussionMarkdown(base));
  });

  it("keeps earlier answers and appends a dated section", () => {
    const first = appendDiscussionSection("", { ...base, question: "Q1", aiResponse: "A1" });
    const second = appendDiscussionSection(first, { ...base, question: "Q2", aiResponse: "A2" });
    assert.match(second, /Q1/);
    assert.match(second, /A1/);
    assert.match(second, /Q2/);
    assert.match(second, /A2/);
    // Exactly one frontmatter block: a second one would make Obsidian show the note as broken.
    assert.equal(second.match(/^---$/gm).length, 3); // open + close of YAML, plus one rule
    assert.equal(second.match(/zotero-key:/g).length, 1);
  });

  it("does not duplicate the H1 heading on append", () => {
    const once = appendDiscussionSection("", base);
    const twice = appendDiscussionSection(once, base);
    assert.equal(twice.match(/# AI Discussion:/g).length, 1);
    assert.match(twice, /## Discussion 2026-10-27 — p\. 7/);
  });

  it("preserves the existing frontmatter verbatim", () => {
    const existing = '---\nzotero-key: "ABCD2345"\ntitle: Real ZotLit note\ntags: [x]\n---\n\nmy own writing\n';
    const out = appendDiscussionSection(existing, base);
    assert.match(out, /title: Real ZotLit note/);
    assert.match(out, /tags: \[x\]/);
    assert.match(out, /my own writing/);
    assert.match(out, /### Question/);
  });

  it("quotes the excerpt in appended sections too", () => {
    const out = appendDiscussionSection(formatZotlitDiscussionMarkdown(base), {
      ...base,
      question: "Q2",
      selectedText: "second passage"
    });
    assert.match(out, /> second passage/);
  });
});

describe("readFrontmatter", () => {
  it("reads the pinned identity", () => {
    const fm = readFrontmatter(formatZotlitDiscussionMarkdown({ ...base, groupID: 7 }));
    assert.equal(fm?.["zotero-key"], "ABCD2345g7");
  });

  it("returns null for a file without frontmatter", () => {
    assert.equal(readFrontmatter("# just a note\n"), null);
    assert.equal(readFrontmatter(""), null);
  });

  it("survives a YAML block that is never closed", () => {
    assert.equal(readFrontmatter("---\nzotero-key: \"X\"\nbody only"), null);
  });
});
