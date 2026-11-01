/**
 * Saving an answer back into the paper. Zotero is stubbed: highlights go through the reader's
 * own `_onAddAnnotation` and notes through `new Zotero.Item('note')`, so the stubs record the
 * calls the real objects would receive instead of asserting on SQLite.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  answerToNoteHtml,
  DEFAULT_HIGHLIGHT_COLOR,
  highlightSelection,
  addCommentToAnnotation,
  saveAnswerAsNote,
  homeItemFor
} from "../src/annotate.ts";

/** Reader window whose eval() runs the real snippet against a fake pdf_view. */
function fakeReader(ranges, stored) {
  const calls = { added: [], rendered: 0, cleared: 0 };
  const view = {
    _selectionRanges: ranges,
    _getAnnotationFromSelectionRanges(sel, type, color) {
      if (!sel || !sel.length || sel[0].collapsed) return null;
      return {
        type,
        color,
        sortIndex: sel[0].sortIndex,
        pageLabel: "3",
        position: sel[0].position,
        text: sel[0].text
      };
    },
    _onAddAnnotation(annotation, select) {
      calls.added.push({ annotation, select });
      // The real AnnotationManager assigns an id here.
      return { ...annotation, id: "NEWANNO01" };
    },
    _setSelectionRanges() {
      calls.cleared += 1;
    },
    _render() {
      calls.rendered += 1;
    }
  };
  const win = {
    _reader: { _lastView: view },
    __zaaLastAnnotation: stored,
    eval(code) {
      // The snippet is a self-invoking function over the locals above.
      const fn = new Function(
        "window",
        `return ${code.trim().replace(/;$/, "")};`
      );
      return fn({ _reader: this._reader, __zaaLastAnnotation: this.__zaaLastAnnotation });
    }
  };
  return { win, view, calls };
}

const RANGE = {
  collapsed: false,
  sortIndex: "00003|000123|00045",
  text: "Bifurcation bias disrupted recombination.",
  position: { pageIndex: 2, rects: [[10, 20, 30, 40]] }
};

let savedReader;
beforeEach(() => {
  savedReader = fakeReader([RANGE], undefined);
  globalThis.Zotero = {
    Reader: { _readers: [{ itemID: 99, _iframeWindow: { wrappedJSObject: savedReader.win } }] },
    Items: {
      get: () => null,
      getByLibraryAndKey: () => null
    },
    Item: class {
      constructor(type) {
        this.type = type;
        this.libraryID = null;
        this.parentID = null;
        this.note = "";
      }
      setNote(html) {
        this.note = html;
      }
      async saveTx() {
        // The real save() assigns key only after an await point (dataObject.js: saveTx ->
        // save is async), so a caller that forgets to await reads key === "".
        await Promise.resolve();
        this.saved = true;
        this.key = "NOTEKEY1";
      }
      isAnnotation() {
        return false;
      }
    }
  };
});

describe("answerToNoteHtml", () => {
  it("quotes the selected passage so the note reads on its own", () => {
    const html = answerToNoteHtml("Answer body.", {
      question: "Why did it fail?",
      pageLabel: "3",
      selection: "Bifurcation bias disrupted recombination."
    });
    assert.match(html, /<strong>Q:<\/strong> Why did it fail\?/);
    assert.match(html, /<em>p\. 3<\/em>/);
    assert.match(html, /<blockquote><p>Bifurcation bias disrupted recombination\.<\/p><\/blockquote>/);
    assert.match(html, /<p>Answer body\.<\/p>/);
  });

  it("escapes the passage so a quote cannot inject markup", () => {
    const html = answerToNoteHtml("x", { selection: '<img src=x onerror="alert(1)">' });
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
  });

  it("keeps bullets as a list", () => {
    const html = answerToNoteHtml("- one\n- two", {});
    assert.equal(html.match(/<li>/g).length, 2);
  });

  it("omits the quote when there was no selection", () => {
    assert.doesNotMatch(answerToNoteHtml("x", { selection: "   " }), /<blockquote>/);
  });
});

describe("highlightSelection", () => {
  it("highlights the live selection and stores the answer as the comment", () => {
    const result = highlightSelection("Because of **bifurcation bias**.");
    assert.deepEqual(result, { ok: true, kind: "highlight", created: true });
    const [{ annotation, select }] = savedReader.calls.added;
    assert.equal(annotation.type, "highlight");
    assert.equal(annotation.color, DEFAULT_HIGHLIGHT_COLOR);
    assert.equal(annotation.comment, "Because of **bifurcation bias**.");
    assert.equal(annotation.text, RANGE.text);
    assert.equal(annotation.sortIndex, RANGE.sortIndex);
    assert.equal(select, true, "new highlight should be selected in the sidebar");
    assert.equal(savedReader.calls.rendered, 1);
    assert.equal(savedReader.calls.cleared, 1);
  });

  it("uses the snapshot once clicking the panel has cleared the ranges", () => {
    // Clicking into our panel clears _selectionRanges; only the tracker's snapshot survives.
    savedReader = fakeReader([], {
      t: Date.now(),
      ann: { ...RANGE, type: "highlight", color: DEFAULT_HIGHLIGHT_COLOR, pageLabel: "3" }
    });
    Zotero.Reader._readers[0]._iframeWindow.wrappedJSObject = savedReader.win;

    const result = highlightSelection("answer");
    assert.equal(result.ok, true);
    assert.equal(savedReader.calls.added.length, 1);
    assert.equal(savedReader.calls.added[0].annotation.text, RANGE.text);
  });

  it("ignores a stale snapshot instead of highlighting an unrelated passage", () => {
    savedReader = fakeReader([], { t: Date.now() - 600_000, ann: { ...RANGE } });
    Zotero.Reader._readers[0]._iframeWindow.wrappedJSObject = savedReader.win;

    const result = highlightSelection("answer");
    assert.deepEqual(result, { ok: false, error: "Select text in the PDF first" });
    assert.equal(savedReader.calls.added.length, 0);
  });

  it("refuses a collapsed selection instead of creating an empty highlight", () => {
    savedReader = fakeReader([{ ...RANGE, collapsed: true }], undefined);
    Zotero.Reader._readers[0]._iframeWindow.wrappedJSObject = savedReader.win;

    const result = highlightSelection("answer");
    assert.deepEqual(result, { ok: false, error: "Selection is empty" });
    assert.equal(savedReader.calls.added.length, 0);
  });

  it("reports missing reader instead of throwing", () => {
    Zotero.Reader._readers = [];
    assert.deepEqual(highlightSelection("a"), { ok: false, error: "No open PDF" });
  });
});

describe("addCommentToAnnotation", () => {
  it("edits the comment of the existing annotation", async () => {
    let saved = 0;
    const item = {
      key: "ABCD1234",
      annotationComment: "",
      isAnnotation: () => true,
      saveTx: async () => {
        saved += 1;
      }
    };
    Zotero.Items.getByLibraryAndKey = () => item;

    const result = await addCommentToAnnotation({ libraryID: 1 }, "ABCD1234", "new comment");
    assert.deepEqual(result, { ok: true, kind: "highlight", created: false, key: "ABCD1234" });
    assert.equal(item.annotationComment, "new comment");
    assert.equal(saved, 1);
  });

  it("refuses a key that is not an annotation", async () => {
    Zotero.Items.getByLibraryAndKey = () => ({ isAnnotation: () => false });
    const result = await addCommentToAnnotation({ libraryID: 1 }, "NOPE", "x");
    assert.equal(result.ok, false);
    assert.match(result.error, /Highlight not found/);
  });
});

describe("saveAnswerAsNote", () => {
  it("creates a child note on the paper", async () => {
    const home = { libraryID: 1, id: 4667 };
    const result = await saveAnswerAsNote(home, "<p>x</p>");
    assert.deepEqual(result, { ok: true, kind: "note", key: "NOTEKEY1" });
    assert.notEqual(result.key, "", "a note with an empty key is unsaved");
  });

  it("refuses an unsaved parent", async () => {
    assert.equal((await saveAnswerAsNote(null, "<p>x</p>")).ok, false);
  });
});

describe("homeItemFor", () => {
  it("walks from the PDF attachment up to the paper", () => {
    Zotero.Items.get = (id) => (id === 99 ? { parentItemID: 4667 } : { key: "PAPER", id: 4667 });
    assert.equal(homeItemFor({ itemID: 99 }).key, "PAPER");
  });

  it("keeps a standalone attachment as its own home", () => {
    Zotero.Items.get = () => ({ key: "STANDALONE", id: 5, parentItemID: false });
    assert.equal(homeItemFor({ itemID: 5 }).key, "STANDALONE");
  });
});
