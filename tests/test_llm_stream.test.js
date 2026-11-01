import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

const { buildViewportPrompt, streamChatCompletion, MAX_CONTEXT_CHARS, DEFAULT_CONFIG } = await import(
  "../src/llm.ts"
);

const realFetch = globalThis.fetch;
let lastRequest = null;

/** Builds a fake streaming Response from raw SSE text split at the given cut points. */
function sseResponse(raw, cuts = []) {
  const encoder = new TextEncoder();
  const pieces = [];
  let start = 0;
  for (const cut of cuts) {
    pieces.push(raw.slice(start, cut));
    start = cut;
  }
  pieces.push(raw.slice(start));

  const stream = new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    }
  });
  return { ok: true, status: 200, statusText: "OK", body: stream };
}

const delta = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
const done = "data: [DONE]\n\n";

describe("streamChatCompletion", () => {
  const rawResponse = delta("Hello ") + delta("world") + done;
  const cuts = [7, 23, 40];
  let currentRaw = rawResponse;

  const okFetch = async (url, init) => {
    lastRequest = { url, init };
    return sseResponse(currentRaw, cuts);
  };

  before(() => {
    globalThis.fetch = okFetch;
  });
  after(() => {
    globalThis.fetch = realFetch;
  });

  test("reassembles deltas split across chunk boundaries", async () => {
    const chunks = [];
    const answer = await streamChatCompletion(
      [{ role: "user", content: "hi" }],
      DEFAULT_CONFIG,
      (c) => chunks.push(c),
      undefined,
      true
    );

    assert.deepEqual(chunks, ["Hello ", "world"]);
    assert.equal(answer, "Hello world");
  });

  test("stops at [DONE] and drops trailing events", async () => {
    currentRaw = delta("kept") + done + delta("dropped");
    const received = [];
    const answer = await streamChatCompletion(
      [{ role: "user", content: "hi" }],
      DEFAULT_CONFIG,
      (c) => received.push(c),
      undefined,
      true
    );

    assert.deepEqual(received, ["kept"]);
    assert.equal(answer, "kept");
    currentRaw = rawResponse;
  });

  test("does not buffer the answer unless collect is requested", async () => {
    const answer = await streamChatCompletion([{ role: "user", content: "hi" }], DEFAULT_CONFIG, () => {});
    assert.equal(answer, "");
  });

  test("posts to the configured OpenAI-compatible endpoint", async () => {
    await streamChatCompletion([{ role: "user", content: "hi" }], DEFAULT_CONFIG, () => {});
    assert.equal(lastRequest.url, `${DEFAULT_CONFIG.baseUrl}/chat/completions`);
    const body = JSON.parse(lastRequest.init.body);
    assert.equal(body.stream, true);
    assert.equal(body.model, DEFAULT_CONFIG.model);
  });

  test("surfaces HTTP errors instead of returning partial text", async () => {
    globalThis.fetch = async () => ({ ok: false, status: 500, statusText: "Internal Server Error", body: null });
    await assert.rejects(
      () => streamChatCompletion([{ role: "user", content: "hi" }], DEFAULT_CONFIG, () => {}),
      /LLM Error 500/
    );
    globalThis.fetch = okFetch;
  });

  test("forwards the abort signal to fetch and propagates abort", async () => {
    const controller = new AbortController();
    let seenSignal = null;
    globalThis.fetch = async (_url, init) => {
      seenSignal = init.signal;
      controller.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    };

    await assert.rejects(
      () =>
        streamChatCompletion(
          [{ role: "user", content: "hi" }],
          DEFAULT_CONFIG,
          () => {},
          controller.signal
        ),
      (err) => err.name === "AbortError"
    );
    assert.equal(seenSignal, controller.signal);

    globalThis.fetch = okFetch;
  });
});

describe("buildViewportPrompt context cap", () => {
  test("truncates oversized viewport text", async () => {
    const messages = buildViewportPrompt({
      title: "Long Paper",
      pageNumber: 3,
      viewportText: "x".repeat(MAX_CONTEXT_CHARS * 4),
      selectedText: "y".repeat(MAX_CONTEXT_CHARS),
      userQuestion: "What?"
    });

    const user = messages[1].content;
    assert.ok(user.includes("[... truncated at"), "truncation marker present");
    assert.ok(
      user.length <= MAX_CONTEXT_CHARS + 1500 + 200,
      `context stayed bounded: ${user.length}`
    );
  });

  test("keeps short text intact", async () => {
    const messages = buildViewportPrompt({
      title: "Short",
      pageNumber: 1,
      viewportText: "  exact excerpt  ",
      userQuestion: "What?"
    });
    assert.ok(messages[1].content.includes("exact excerpt"));
    assert.ok(!messages[1].content.includes("truncated"));
  });
});
/**
 * The panel cannot pass an AbortSignal (Zotero's bootstrap sandbox has no AbortController), so it
 * passes a plain token. Cancelling must stop the stream and reject, not return a half answer.
 */
describe("cancellation through a plain token", () => {
  const chunk = (text) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

  test("stops at the next chunk and rejects with AbortError", async () => {
    const token = { cancelled: false };
    const seen = [];
    let cancelledStream = false;
    const chunks = [chunk("one "), chunk("two "), chunk("three")];
    let i = 0;

    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: {
        getReader: () => ({
          read: async () => {
            if (i >= chunks.length) return { done: true, value: undefined };
            const value = new TextEncoder().encode(chunks[i++]);
            // Stop arrives while the first delta is being consumed.
            if (i === 1) token.cancelled = true;
            return { done: false, value };
          },
          cancel: async () => { cancelledStream = true; }
        })
      }
    });

    await assert.rejects(
      () =>
        streamChatCompletion(
          [{ role: "user", content: "hi" }],
          { baseUrl: "http://x/v1", model: "m" },
          (d) => seen.push(d),
          token,
          true
        ),
      /cancelled/
    );
    assert.deepEqual(seen, ["one "], "no delta is delivered after the stop");
    assert.equal(cancelledStream, true, "the reader is cancelled, not just dropped");
  });

  test("an uncancelled token streams normally to the end", async () => {
    const token = { cancelled: false };
    const chunks = [chunk("a"), chunk("b")];
    let i = 0;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: {
        getReader: () => ({
          read: async () =>
            i >= chunks.length
              ? { done: true, value: undefined }
              : { done: false, value: new TextEncoder().encode(chunks[i++]) },
          cancel: async () => {}
        })
      }
    });

    const seen = [];
    const out = await streamChatCompletion(
      [{ role: "user", content: "hi" }],
      { baseUrl: "http://x/v1", model: "m" },
      (d) => seen.push(d),
      token,
      true
    );
    assert.equal(out, "ab");
    assert.deepEqual(seen, ["a", "b"]);
  });
});
