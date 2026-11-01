/**
 * Highlight-scoped questions: the panel can ask about a Zotero annotation, not only the page.
 * Offline — the LLM helpers are injected.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildViewportPrompt } from "../src/llm.ts";
import { answerFromSession } from "../src/chat.ts";
import { AgentBridgeServer, CHAT_PATH } from "../src/bridge.ts";

const SESSION = {
  itemKey: "HCS9BRGQ",
  attachmentKey: "B5NKI9K6",
  title: "Success and failure in family firm internationalization",
  authors: ["Kano"],
  publicationYear: 2025,
  activePage: 3,
  totalPages: 24,
  selectedText: "",
  pageText: "Bifurcation bias is a dysfunctional, affect-based heuristic.",
  highlights: [
    { key: "HL000001", text: "bifurcation bias treats nonfamily resources as commodities", pageLabel: "3" }
  ],
  timestamp: "2026-10-28T00:00:00.000Z"
};

function deps() {
  const seen = { prompt: null };
  return {
    seen,
    buildViewportPrompt: (params) => {
      seen.prompt = params;
      return [{ role: "user", content: "x" }];
    },
    streamChatCompletion: async () => "answer",
    config: { baseUrl: "http://stub/v1", model: "m" }
  };
}

describe("buildViewportPrompt options", () => {
  it("carries the highlight, its note and page label into the context", () => {
    const [system, user] = buildViewportPrompt({
      title: "T",
      pageNumber: 3,
      viewportText: "page text",
      userQuestion: "explain",
      highlight: { text: "bifurcation bias", comment: "my note", pageLabel: "3" }
    });
    assert.match(user.content, /Highlight the question is about \(user's page label 3\)/);
    assert.match(user.content, /bifurcation bias/);
    assert.match(user.content, /my note/);
    assert.equal(system.role, "system");
  });

  it("asks for an explanation in the configured language, not a bare list", () => {
    const [system] = buildViewportPrompt({
      title: "T",
      pageNumber: 1,
      viewportText: "x",
      userQuestion: "q",
      language: "Indonesian"
    });
    assert.match(system.content, /Answer language: Indonesian/);
    assert.match(system.content, /Explain, do not just enumerate/);
  });

  it("switches to the brief style on request", () => {
    const [system] = buildViewportPrompt({
      title: "T",
      pageNumber: 1,
      viewportText: "x",
      userQuestion: "q",
      style: "brief"
    });
    assert.match(system.content, /one short paragraph/);
    assert.doesNotMatch(system.content, /Explain, do not just enumerate/);
  });
});

describe("answerFromSession with a highlight", () => {
  it("lets an empty question mean 'explain this highlight'", async () => {
    const d = deps();
    const result = await answerFromSession(SESSION, "", d, () => {}, {
      highlightKey: "HL000001",
      language: "Indonesian",
      style: "explain"
    });
    assert.equal(result.answer, "answer");
    assert.equal(d.seen.prompt.highlight.key, undefined, "only the text/comment/label reach the prompt");
    assert.equal(d.seen.prompt.highlight.text, "bifurcation bias treats nonfamily resources as commodities");
    assert.match(d.seen.prompt.userQuestion, /Explain this highlighted passage/);
    assert.equal(d.seen.prompt.language, "Indonesian");
  });

  it("rejects a highlight key that is not in this paper", async () => {
    await assert.rejects(
      () => answerFromSession(SESSION, "hi", deps(), () => {}, { highlightKey: "NOPE" }),
      /Highlight not found in this paper/
    );
  });

  it("still rejects a blank question when no highlight is picked", async () => {
    await assert.rejects(() => answerFromSession(SESSION, "   ", deps()), /Missing question/);
  });
});

describe("bridge forwards highlight options", () => {
  it("passes highlightKey through and maps an unknown highlight to 400", async () => {
    const server = new AgentBridgeServer();
    server.setSessionProvider(() => SESSION);
    server.setAnswerer((session, question, options) =>
      answerFromSession(session, question, deps(), () => {}, options)
    );

    const ok = await server.handleRequest(CHAT_PATH, { data: { highlightKey: "HL000001" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.answer, "answer");

    const bad = await server.handleRequest(CHAT_PATH, { data: { highlightKey: "NOPE" } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /Highlight not found/);
  });
});