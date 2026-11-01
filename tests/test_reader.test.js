import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { getPageNumber, getTotalPages, capText, joinChars, readPageSnapshot, MAX_PAGE_CHARS } =
  await import("../src/reader.ts");
const { AgentBridgeServer, ACTIVE_SESSION_PATH } = await import("../src/bridge.ts");

const SNAPSHOT = JSON.stringify({
  pageNumber: 3,
  totalPages: 24,
  chars: [
    { c: "S" },
    { c: "u" },
    { c: "c" },
    { c: "c", spaceAfter: true },
    { c: "a" },
    { c: "n" },
    { c: "d" },
    { c: "s", spaceAfter: true },
    { c: "f" },
    { c: "a" },
    { c: "i", lineBreakAfter: true },
    { c: "l" },
    { c: "-", ignorable: true },
    { c: "u", paragraphBreakAfter: true },
    { c: "r", spaceAfter: false },
    { c: "e" }
  ],
  selection: "a selected clause"
});

/** Fake reader shaped like the live object probed in Zotero 7.0.0-beta.83. */
function fakeReader({ page = 3, pages = 24, evalResult = SNAPSHOT, evalThrows = false, unwrapThrows = false } = {}) {
  let code = "";
  const reader = {
    itemID: 4667,
    _isTabClosed: false,
    code: () => code,
    _iframeWindow: {
      get wrappedJSObject() {
        if (unwrapThrows) throw new Error("permission denied");
        return {
          eval: (body) => {
            code = body;
            if (evalThrows) throw new Error("boom");
            return Promise.resolve(evalResult);
          },
          PDFViewerApplication: { pdfViewer: { currentPageNumber: page, pagesCount: pages } }
        };
      }
    }
  };
  return reader;
}

describe("reader page number lookups", () => {
  test("reads page number and page count from PDFViewerApplication", () => {
    const reader = fakeReader();
    assert.equal(getPageNumber(reader), 3);
    assert.equal(getTotalPages(reader), 24);
  });

  test("degrades to 0 when the content window cannot be unwrapped", () => {
    const reader = fakeReader({ unwrapThrows: true });
    assert.equal(getPageNumber(reader), 0);
    assert.equal(getTotalPages(reader), 0);
  });

  test("tolerates a missing iframe window", () => {
    assert.equal(getPageNumber({ itemID: 1 }), 0);
  });
});

describe("readPageSnapshot", () => {
  test("parses the primitive char payload the reader window returns", async () => {
    const snapshot = await readPageSnapshot(fakeReader());
    assert.equal(snapshot.pageNumber, 3);
    assert.equal(snapshot.totalPages, 24);
    assert.equal(snapshot.selection, "a selected clause");
    assert.equal(snapshot.chars.length, 16);
    assert.equal(snapshot.chars[0].c, "S");
  });

  test("asks PDF.js for the current page with a zero-based pageIndex", async () => {
    const reader = fakeReader();
    await readPageSnapshot(reader);
    const code = reader.code();
    assert.match(code, /getPageData\(\{ pageIndex: pageNumber - 1 \}\)/);
    // glyph text lives on chars[i].c; only primitives are copied across compartments
    assert.match(code, /let chars = all\.map\(ch => \(\{/);
    assert.match(code, /return JSON\.stringify\(\{ pageNumber, totalPages, chars, selection, selectionSource: source, selectionLog \}\)/);
  });

  test("falls back to the selection remembered before the panel stole focus", async () => {
    const reader = fakeReader();
    await readPageSnapshot(reader);
    const code = reader.code();
    assert.match(code, /__zaaLastSelection/);
    // Zotero's ranges win; the fresh remembered copy beats stale-prone DOM tiers.
    assert.ok(code.indexOf("_selectionRanges") < code.indexOf("__zaaLastSelection"));
    assert.ok(code.indexOf("__zaaLastSelection") < code.indexOf("window.getSelection"));
    assert.ok(code.indexOf("window.getSelection") < code.indexOf("contentWindow.getSelection"));
    // A remembered selection older than the freshness window must not be offered as context.
    assert.match(code, /Date\.now\(\) - stored\.t < 120000/);
    // Zotero's own selection ranges win: same text a highlight would store, survives focus loss.
    assert.match(code, /_reader\._lastView/);
    assert.match(code, /_selectionRanges/);
    assert.ok(code.indexOf("_selectionRanges") < code.indexOf("window.getSelection"));
  });

  test("serializes inside the reader window (only a JSON string crosses compartments)", async () => {
    const reader = fakeReader();
    await readPageSnapshot(reader);
    assert.match(reader.code(), /return JSON\.stringify\(/);
  });

  test("returns null when eval throws", async () => {
    assert.equal(await readPageSnapshot(fakeReader({ evalThrows: true })), null);
  });

  test("returns null when the window returns something other than a JSON string", async () => {
    assert.equal(await readPageSnapshot(fakeReader({ evalResult: null })), null);
  });

  test("returns null without an eval-able window", async () => {
    assert.equal(await readPageSnapshot({ itemID: 1 }), null);
  });
});

describe("joinChars", () => {
  test("inserts spaces where spaceAfter is set", () => {
    const chars = [{ c: "a" }, { c: "b", spaceAfter: true }, { c: "c" }];
    assert.equal(joinChars(chars), "ab c");
  });

  test("treats a non-paragraph line break as a space", () => {
    const chars = [{ c: "a", lineBreakAfter: true }, { c: "b" }];
    assert.equal(joinChars(chars), "a b");
  });

  test("keeps paragraph breaks out of the space path", () => {
    const chars = [{ c: "a", lineBreakAfter: true, paragraphBreakAfter: true }, { c: "b" }];
    const joined = joinChars(chars);
    assert.ok(joined.startsWith("a\n\n"), JSON.stringify(joined));
    assert.ok(!joined.includes("a \n"), JSON.stringify(joined));
  });

  test("drops ignorable glyphs but keeps their spacing", () => {
    const chars = [{ c: "a" }, { c: "-", ignorable: true }, { c: "b", spaceAfter: true }, { c: "c" }];
    assert.equal(joinChars(chars), "ab c");
  });

  test("ignores wordBreakAfter (break opportunity, not a space)", () => {
    const chars = [{ c: "V", wordBreakAfter: true }, { c: "o" }, { c: "l" }];
    assert.equal(joinChars(chars), "Vol");
  });

  test("handles empty and missing input", () => {
    assert.equal(joinChars([]), "");
    assert.equal(joinChars(undefined), "");
    assert.equal(joinChars([null, undefined]), "");
  });

  test("joins the snapshot payload into spaced text", async () => {
    const snapshot = await readPageSnapshot(fakeReader());
    // S,u,c,c(spaceAfter) | a,n,d,s(spaceAfter) | f,a,i(lineBreak) | -(ignorable) u(paragraphBreak) | r,e
    assert.equal(joinChars(snapshot.chars), "Succ ands fai lu\n\nre");
  });
});

describe("capText", () => {
  test("collapses whitespace", () => {
    assert.equal(capText("  alpha \n beta  "), "alpha beta");
  });

  test("caps overlong text", () => {
    assert.equal(capText("x".repeat(MAX_PAGE_CHARS * 2)).length, MAX_PAGE_CHARS);
  });

  test("honours a custom limit", () => {
    assert.equal(capText("abcdef", 3), "abc");
  });

  test("handles empty input", () => {
    assert.equal(capText(""), "");
  });
});

describe("bridge session provider", () => {
  const session = {
    itemKey: "ABCD2345",
    attachmentKey: "B5NKI9K6",
    title: "Family firm internationalization",
    authors: ["Kano"],
    activePage: 3,
    totalPages: 24,
    selectedText: "",
    pageText: "success and failure",
    timestamp: "2026-10-27T00:00:00.000Z"
  };

  test("serves live provider state instead of a cached copy", async () => {
    const server = new AgentBridgeServer();
    let pageText = "first read";
    server.setSessionProvider(() => ({ ...session, pageText }));

    assert.equal((await server.handleRequest(ACTIVE_SESSION_PATH)).body.pageText, "first read");
    pageText = "second read";
    assert.equal((await server.handleRequest(ACTIVE_SESSION_PATH)).body.pageText, "second read");
  });

  test("awaits an async provider", async () => {
    const server = new AgentBridgeServer();
    server.setSessionProvider(async () => session);
    const res = await server.handleRequest(ACTIVE_SESSION_PATH);
    assert.equal(res.status, 200);
    assert.equal(res.body.itemKey, "ABCD2345");
  });

  test("404s when the provider throws", async () => {
    const server = new AgentBridgeServer();
    server.setSessionProvider(() => {
      throw new Error("reader exploded");
    });
    assert.equal((await server.handleRequest(ACTIVE_SESSION_PATH)).status, 404);
  });

  test("404s when the provider rejects", async () => {
    const server = new AgentBridgeServer();
    server.setSessionProvider(async () => {
      throw new Error("reader exploded");
    });
    assert.equal((await server.handleRequest(ACTIVE_SESSION_PATH)).status, 404);
  });

  test("404s when no reader is open", async () => {
    const server = new AgentBridgeServer();
    server.setSessionProvider(() => null);
    assert.equal((await server.handleRequest(ACTIVE_SESSION_PATH)).status, 404);
  });
});