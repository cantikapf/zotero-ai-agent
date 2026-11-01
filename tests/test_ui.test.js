/**
 * Panel answer rendering: model text is Markdown-ish and untrusted, so it is escaped before
 * any tag is added. Offline, no DOM needed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdownToHtml } from "../src/markdown.ts";
import { buildViewportPrompt } from "../src/llm.ts";
import { registerHooks } from "node:module";

// src/*.ts import each other with the ".js" extension that tsc emits, which type-stripping does
// not resolve. Map it back to ".ts" so the panel can be exercised without a build step.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && specifier.endsWith(".js")) {
      try {
        return next(`${specifier.slice(0, -3)}.ts`, context);
      } catch {
        // fall through to the original specifier
      }
    }
    return next(specifier, context);
  }
});
const { createPanel } = await import("../src/ui.ts");

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

/**
 * The Stop button lives entirely in the DOM, so it is checked against a stub document: no jsdom
 * dependency, and the behaviour that matters (label swaps, second click cancels) is observable.
 */
function stubDoc() {
  const el = (tag) => ({
    tagName: tag,
    children: [],
    dataset: {},
    style: {},
    classList: { add() {}, remove() {} },
    hidden: false,
    disabled: false,
    textContent: "",
    innerHTML: "",
    value: "",
    checked: false,
    title: "",
    append(...kids) { this.children.push(...kids); },
    appendChild(kid) { this.children.push(kid); return kid; },
    addEventListener(type, fn) { (this.listeners ||= {})[type] = fn; },
    removeEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    remove() {},
    focus() {},
    closest() { return null; }
  });
  return { createElement: el, head: el("head"), body: el("body"), documentElement: el("html"), getElementById: () => null };
}

/** Depth-first search so the test does not depend on element order. */
function find(node, match) {
  if (!node) return null;
  if (match(node)) return node;
  for (const kid of node.children || []) {
    const hit = find(kid, match);
    if (hit) return hit;
  }
  return null;
}

describe("panel stop button", () => {
  it("swaps to Stop while streaming and cancels on the second click", async () => {
    const doc = stubDoc();
    let captured;
    let release;
    const panel = createPanel(doc, {
      ask: (question, onChunk, highlightKey, useSources, token) => {
        captured = token;
        return new Promise((resolve) => { release = resolve; });
      },
      pageLabel: async () => "p. 4",
      highlights: async () => [],
      saveAnswer: async () => "",
      exportAnswer: async () => "",
      canExport: () => false
    });
    assert.equal(panel.dataset.open, "false", "panel starts closed");

    const input = find(panel, (n) => n.tagName === "textarea");
    const send = find(panel, (n) => n.tagName === "button" && n.textContent === "Send");
    assert.ok(input && send, "input and Send button exist");

    input.value = "What is bifurcation bias?";
    send.listeners.click();
    await Promise.resolve();
    assert.equal(send.textContent, "Stop", "button becomes Stop while in flight");
    assert.equal(send.disabled, false, "Stop must stay clickable");

    send.listeners.click();
    assert.equal(captured.cancelled, true, "second click flips the token");

    release({ answer: "done", pageNumber: 4 });
    await new Promise((r) => setImmediate(r));
    assert.equal(send.textContent, "Send", "label restored after the stream ends");
  });
});
