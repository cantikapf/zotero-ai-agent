import { test, describe } from "node:test";
import assert from "node:assert/strict";

// We import the compiled or mock module logic directly
describe("Zotero AI Agent Core Unit Tests", () => {
  test("Viewport Prompt Builder caps context and formats correctly", async () => {
    // Dynamic import of TS source or inline logic check
    const title = "Geopolitical Risk and Multinational Enterprise Strategy";
    const pageNumber = 14;
    const viewportText = "Multinational enterprises show distinct fragmentation under techno-nationalist policies.";
    const selectedText = "fragmentation under techno-nationalist policies";
    const userQuestion = "What is the effect of techno-nationalist policies?";

    const { buildViewportPrompt } = await import("../src/llm.ts");

    const messages = buildViewportPrompt({
      title,
      pageNumber,
      viewportText,
      selectedText,
      userQuestion
    });

    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, "system");
    assert.equal(messages[1].role, "user");
    assert.ok(messages[1].content.includes("Geopolitical Risk"));
    assert.ok(messages[1].content.includes("Active Page: 14") || messages[1].content.includes("Page: 14"));
  });

  test("context budget pref overrides the default cap and is clamped", async () => {
    const { buildViewportPrompt, MAX_CONTEXT_CHARS } = await import("../src/llm.ts");
    const long = "x".repeat(50_000);
    const prompt = (contextChars) =>
      buildViewportPrompt({ title: "t", pageNumber: 1, viewportText: long, userQuestion: "q", contextChars })[1]
        .content;

    // Default still truncates.
    assert.ok(prompt(undefined).includes(`truncated at ${MAX_CONTEXT_CHARS - 1500} chars`));
    // A small budget truncates harder.
    const small = prompt(1200);
    assert.ok(small.includes("truncated at 900 chars"));
    // 0 is falsy -> default; negatives clamp up to the 1000-char floor, never to nothing.
    assert.ok(prompt(0).includes(`truncated at ${MAX_CONTEXT_CHARS - 1500} chars`));
    assert.ok(prompt(-5).includes("truncated at 750 chars"));
    // Absurd values clamp instead of sending the whole page.
    assert.ok(prompt(10_000_000).length < 210_000);
  });

  test("ZotLit Markdown Formatter generates valid frontmatter and deep-links", async () => {
    const { formatZotlitDiscussionMarkdown } = await import("../src/zotlit.ts");

    const markdown = formatZotlitDiscussionMarkdown({
      itemKey: "ABCD2345",
      attachmentKey: "PDF12345",
      title: "Techno-Nationalism in Global Business",
      citekey: "buckley2020",
      pageNumber: 7,
      question: "How does techno-nationalism affect supply chains?",
      aiResponse: "Techno-nationalism forces localization of critical infrastructure.",
      selectedText: "critical infrastructure localization",
      date: "2026-10-27"
    });

    assert.ok(markdown.includes('zotero-key: "ABCD2345"'));
    assert.ok(markdown.includes("zotero://open-pdf/library/items/PDF12345?page=7"));
    assert.ok(markdown.includes("[[@buckley2020]]"));
    assert.ok(markdown.includes("AI Discussion: Techno-Nationalism in Global Business"));
  });

  test("Agent Bridge Server manages active session state", async () => {
    const { AgentBridgeServer } = await import("../src/bridge.ts");

    const server = new AgentBridgeServer();
    assert.equal((await server.handleRequest("/agent/active")).status, 404);
    assert.equal((await server.handleRequest("/agent-bridge/active")).status, 404);

    server.updateSession({
      itemKey: "TEST1234",
      attachmentKey: "ATT9999",
      title: "International Business Study",
      activePage: 3
    });

    const res = await server.handleRequest("/agent-bridge/active");
    assert.equal(res.status, 200);
    assert.equal(res.body.itemKey, "TEST1234");
    assert.equal(res.body.activePage, 3);
  });
});
