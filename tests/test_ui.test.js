/**
 * Panel answer rendering: model text is Markdown-ish and untrusted, so it is escaped before
 * any tag is added. Offline, no DOM needed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdownToHtml } from "../src/markdown.ts";
import { buildViewportPrompt } from "../src/llm.ts";

describe("buildViewportPrompt external references", () => {
  const base = {
    title: "Success and failure in family firm internationalization",
    pageNumber: 4,
    viewportText: "Firm-specific advantages explain cross-border expansion.",
    userQuestion: "What is internalization theory?"
  };

  it("says nothing about references when none were found", () => {
    const [system] = buildViewportPrompt(base);
    assert.doesNotMatch(system.content, /external reference/i);
    assert.doesNotMatch(system.content, /\[E1\]/);
  });

  it("numbers references and forbids inventing them when some were found", () => {
    const [system] = buildViewportPrompt({
      ...base,
      externalSources: ["Rothschild et al. (2024). Sourcing FSAs. JIBS. doi:10.1/a"]
    });
    assert.match(system.content, /\[E1\], \[E2\]/);
    assert.match(system.content, /Never invent a reference/);
    assert.match(system.content, /clearly secondary/);
  });

  it("puts the DOI list in the user turn, numbered from 1", () => {
    const [, user] = buildViewportPrompt({
      ...base,
      externalSources: ["A. doi:10.1/a", "B. doi:10.1/b"]
    });
    assert.match(user.content, /\[E1\] A\. doi:10\.1\/a/);
    assert.match(user.content, /\[E2\] B\. doi:10\.1\/b/);
  });
});

describe("renderMarkdownToHtml", () => {
  it("escapes HTML so model output cannot inject markup", () => {
    const html = renderMarkdownToHtml('<img src=x onerror="alert(1)"> pill');
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
  });

  it("renders bold, inline code and paragraphs", () => {
    const html = renderMarkdownToHtml("**Bifurcation bias** is a `heuristic`.\n\nSecond paragraph.");
    assert.match(html, /<strong>Bifurcation bias<\/strong>/);
    assert.match(html, /<code>heuristic<\/code>/);
    assert.equal(html.match(/<p>/g).length, 2);
  });

  it("groups bullet lines into one list, ordered markers included", () => {
    const html = renderMarkdownToHtml("Intro.\n- one\n- two\n1. three\n\nOutro.");
    assert.equal(html.match(/<ul>/g).length, 1);
    assert.equal(html.match(/<li>/g).length, 3);
    assert.match(html, /<p>Intro\.<\/p><ul>/);
    assert.match(html, /<\/ul><p>Outro\.<\/p>$/);
  });

  it("keeps a plain answer as one paragraph", () => {
    assert.equal(renderMarkdownToHtml("Just one line."), "<p>Just one line.</p>");
  });

  it("tolerates empty input", () => {
    assert.equal(renderMarkdownToHtml(""), "");
    assert.equal(renderMarkdownToHtml(undefined), "");
  });
});

describe("prompt formatting contract", () => {
  it("asks for Markdown instead of an unformatted blob", () => {
    const [system] = buildViewportPrompt({
      title: "T",
      pageNumber: 1,
      viewportText: "x",
      userQuestion: "q"
    });
    assert.match(system.content, /Format in Markdown/);
    assert.match(system.content, /\*\*bold\*\*/);
  });

  it("defaults the answer language to English", () => {
    const [system] = buildViewportPrompt({
      title: "T",
      pageNumber: 1,
      viewportText: "x",
      userQuestion: "q"
    });
    assert.match(system.content, /Answer language: English/);
  });
});
