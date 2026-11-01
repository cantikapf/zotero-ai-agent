/**
 * Chat route + single-paper Q&A. The LLM helpers are injected, so nothing hits the network.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { answerFromSession } from "../src/chat.ts";
import { AgentBridgeServer, CHAT_PATH, ACTIVE_SESSION_PATH } from "../src/bridge.ts";

let seenPrompt = null;
let seenConfig = null;

function deps(overrides = {}) {
  return {
    buildViewportPrompt: (params) => {
      seenPrompt = params;
      return [
        { role: "system", content: "system" },
        { role: "user", content: `${params.viewportText}
${params.userQuestion}` }
      ];
    },
    streamChatCompletion: async (messages, config, onChunk, signal, collect) => {
      seenConfig = { config, collect, count: messages.length, signal };
      return "Grounded answer, p.3";
    },
    config: { baseUrl: "http://stub/v1", model: "ag/gemini-3.8-flash" },
    ...overrides
  };
}

const SESSION = {
  itemKey: "HCS9BRGQ",
  attachmentKey: "B5NKI9K6",
  title: "Success and failure in family firm internationalization",
  authors: ["Kano"],
  publicationYear: 2025,
  activePage: 3,
  totalPages: 24,
  selectedText: "",
  pageText: "Success and failure in family firm internationalization",
  timestamp: "2026-10-28T00:00:00.000Z"
};

describe("answerFromSession", () => {
  it("builds the prompt from the live page and collects the answer", async () => {
    const result = await answerFromSession(SESSION, "  What is the main claim?  ", deps());
    assert.equal(result.answer, "Grounded answer, p.3");
    assert.equal(result.pageNumber, 3);
    assert.equal(result.model, "ag/gemini-3.8-flash");
    assert.equal(seenPrompt.pageNumber, 3);
    assert.equal(seenPrompt.title, SESSION.title);
    assert.equal(seenPrompt.userQuestion, "What is the main claim?");
    assert.equal(seenConfig.collect, true, "chat must collect, not stream");
    assert.equal(seenConfig.count, 2);
  });

  it("looks up references only when asked, and cites them by number", async () => {
    let queried = null;
    const src = {
      index: 1, title: "Sourcing FSAs", authors: ["Rothschild"], year: 2024,
      doi: "10.1/a", url: "https://doi.org/10.1/a"
    };
    const result = await answerFromSession(
      SESSION,
      "What is internalization theory?",
      deps({ findSources: async (q) => ((queried = q), [src]) }),
      undefined,
      { useExternalSources: true }
    );
    // The question is reduced to topic terms; the full question is not a useful Crossref query.
    assert.equal(queried, "internalization theory", "query falls back to the question, cleaned");
    assert.equal(result.sources.length, 1);
    assert.match(seenPrompt.externalSources[0], /^Rothschild \(2024\)\./);
    assert.match(result.answer, /\*\*Sources consulted \(DOI-verified\)\*\*/);
    assert.match(result.answer, /https:\/\/doi\.org\/10\.1\/a/);
  });

  it("never calls the network when the lookup is off", async () => {
    let called = false;
    const result = await answerFromSession(
      SESSION,
      "What is the main claim?",
      deps({ findSources: async () => ((called = true), []) })
    );
    assert.equal(called, false);
    assert.equal(result.sources, undefined);
    assert.equal(seenPrompt.externalSources, undefined);
  });

  it("answers from the paper when the lookup fails", async () => {
    const result = await answerFromSession(
      SESSION,
      "What is the main claim?",
      deps({ findSources: async () => { throw new Error("offline"); } }),
      undefined,
      { useExternalSources: true }
    );
    assert.equal(result.answer, "Grounded answer, p.3");
    assert.equal(result.sources, undefined);
  });

  it("drops a citation the model invented and keeps the real one", async () => {
    const src = { index: 1, title: "A", authors: [], doi: "10.1/a", url: "u" };
    const result = await answerFromSession(
      SESSION,
      "q",
      deps({
        findSources: async () => [src],
        streamChatCompletion: async () => "From the paper [E1], and elsewhere [E9]."
      }),
      undefined,
      { useExternalSources: true }
    );
    assert.match(result.answer, /and elsewhere\./);
    assert.match(result.answer, /\[E1\]/);
  });

  it("rejects a missing session and a blank question", async () => {
    await assert.rejects(() => answerFromSession(null, "hi", deps()), /No active paper in reader/);
    await assert.rejects(() => answerFromSession(SESSION, "   ", deps()), /Missing question/);
  });
});

describe("bridge chat route", () => {
  const server = new AgentBridgeServer();
  beforeEach(() => {
    seenPrompt = null;
    server.setAuthToken("");
    server.setSessionProvider(() => null);
  });

  it("stays open while no bridge token is configured", async () => {
    server.setAuthToken("");
    const result = await server.handleRequest(ACTIVE_SESSION_PATH, {});
    assert.notEqual(result.status, 401);
  });

  it("401s on a missing or wrong bearer token once one is set", async () => {
    server.setAuthToken("s3cret");
    for (const headers of [undefined, {}, { authorization: "Bearer nope" }, { authorization: "s3cret" }]) {
      const result = await server.handleRequest(ACTIVE_SESSION_PATH, { headers });
      assert.equal(result.status, 401, `headers ${JSON.stringify(headers)} should be rejected`);
    }
  });

  it("accepts the configured token on both routes, case-insensitively", async () => {
    server.setAuthToken("s3cret");
    const ok = await server.handleRequest(ACTIVE_SESSION_PATH, {
      headers: { authorization: "bearer   s3cret " }
    });
    assert.notEqual(ok.status, 401);

    const chat = await server.handleRequest(CHAT_PATH, {
      headers: { authorization: "Bearer s3cret" },
      data: { question: "hi" }
    });
    assert.notEqual(chat.status, 401);
  });

  it("503s while no answerer is wired", async () => {
    const result = await server.handleRequest(CHAT_PATH, { data: { question: "hi" } });
    assert.equal(result.status, 503);
  });

  it("400s without an active paper and without a question", async () => {
    server.setAnswerer((session, question) => answerFromSession(session, question, deps()));
    const noPaper = await server.handleRequest(CHAT_PATH, { data: { question: "hi" } });
    assert.equal(noPaper.status, 400);
    assert.match(noPaper.body.error, /No active paper/);

    server.setSessionProvider(() => SESSION);
    const noQuestion = await server.handleRequest(CHAT_PATH, { data: {} });
    assert.equal(noQuestion.status, 400);
    assert.match(noQuestion.body.error, /Missing question/);
  });

  it("200s with the answer, accepting a JSON string body too", async () => {
    server.setSessionProvider(() => SESSION);
    server.setAnswerer(async (_session, question) => ({
      answer: `echo:${question}`,
      pageNumber: 3,
      model: "stub-model"
    }));

    const fromObject = await server.handleRequest(CHAT_PATH, { data: { question: "why?" } });
    assert.equal(fromObject.status, 200);
    assert.equal(fromObject.body.answer, "echo:why?");
    assert.equal(fromObject.body.model, "stub-model");

    const fromString = await server.handleRequest(CHAT_PATH, {
      data: JSON.stringify({ question: "again" })
    });
    assert.equal(fromString.body.answer, "echo:again");
  });

  it("502s when the gateway call fails", async () => {
    server.setSessionProvider(() => SESSION);
    server.setAnswerer(async () => {
      throw new Error("LLM Error 500: Internal Server Error");
    });
    const result = await server.handleRequest(CHAT_PATH, { data: { question: "hi" } });
    assert.equal(result.status, 502);
    assert.match(result.body.error, /LLM Error 500/);
  });

  it("keeps the read route working next to the chat route", async () => {
    server.setSessionProvider(() => SESSION);
    const result = await server.handleRequest(ACTIVE_SESSION_PATH);
    assert.equal(result.status, 200);
    assert.equal(result.body.itemKey, "HCS9BRGQ");
  });
});
/** The panel's Stop button only works if the token survives the trip from UI to stream. */
describe("cancellation pass-through", () => {
  it("hands the cancel token to the stream unchanged", async () => {
    const token = { cancelled: false };
    await answerFromSession(SESSION, "What is the main claim?", deps(), () => {}, {
      cancelToken: token
    });
    assert.equal(seenConfig.signal, token, "same object, so flipping it is seen by the stream");
  });

  it("passes nothing when the caller has no token", async () => {
    await answerFromSession(SESSION, "What is the main claim?", deps());
    assert.equal(seenConfig.signal, undefined);
  });
});
