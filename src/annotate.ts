/**
 * Write answers back into the PDF as Zotero annotations.
 *
 * Two targets, both verified against Zotero 7.0.0-beta.83 internals:
 *
 * 1. Highlight comment — `ON_ADD_ANNOTATION` is what the reader calls when a user drags a
 *    highlight out (`resource/reader/reader.js`: `_getAnnotationFromSelectionRanges(...)` builds
 *    `{type, color, sortIndex, pageLabel, position, text}`, then `_onAddAnnotation(annotation)`
 *    → `AnnotationManager.addAnnotation()` → `_applyChanges()` → `_triggerSaving()` →
 *    `onSaveAnnotations` → `Zotero.Annotations.saveFromJSON`). Feeding the annotation JSON from
 *    the live `_selectionRanges` into `_onAddAnnotation` therefore reuses the real save pipeline
 *    instead of writing SQLite or duplicating the annotation item shape here.
 *
 * 2. Standalone note — `Zotero.Item.addRelatedItem`-free path: a child note is
 *    `new Zotero.Item('note')`, `parentID`, `setNote(html)`, `saveTx()`. `setNote()` is required
 *    (item.js:82067) and the HTML is what Zotero's own "Add to Note" writes.
 *
 * Alignment with the text the user sees: a selection that is already highlighted passes its
 * `key`, and the comment is attached to that existing annotation item instead of creating a
 * second one on top of it (annotations are immutable in position but editable in comment —
 * `Zotero.Annotations.saveFromJSON` reads `json.comment`).
 */

declare const Zotero: any;

import { SELECTION_MAX_AGE_MS } from "./reader.ts";

/**
 * The tracker stores two things about one selection: its text and the annotation JSON. Both
 * expire on the same clock, so "the panel still shows a selection" and "the highlight button can
 * still save it" can never disagree.
 */
const ANNOTATION_MAX_AGE_MS = SELECTION_MAX_AGE_MS;

/** Same default as Zotero's highlight tool: a yellow marker. */
export const DEFAULT_HIGHLIGHT_COLOR = "#ffd400";

// ponytail: the create paths are async because Zotero's saveTx() returns a Promise and the key
// is only assigned after it resolves; the note is written exactly once, so the caller awaits.
export type AnnotateResult =
  // `key` is absent for a freshly created highlight: the reader assigns the item key inside the
  // iframe and writes it through its own debounced save, so there is no id to hand back yet.
  | { ok: true; kind: "highlight"; created: boolean; key?: string }
  | { ok: true; kind: "note"; key: string }
  | { ok: false; error: string };

function activeReader(): any | null {
  const readers = Zotero.Reader?._readers;
  if (!Array.isArray(readers)) return null;
  for (let i = readers.length - 1; i >= 0; i--) {
    if (readers[i] && !readers[i]._isTabClosed) return readers[i];
  }
  return null;
}

function readerWindow(reader: any): any {
  try {
    return reader?._iframeWindow?.wrappedJSObject || null;
  } catch {
    return null;
  }
}

function escapeHtml(text: string): string {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Answer text -> note body: paragraphs and bullets, escaped. Keeps paging hints readable. */
export function answerToNoteHtml(
  answer: string,
  meta: { question?: string; pageLabel?: string; selection?: string }
): string {
  const para = (line: string) => {
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    return bullet ? `<li>${escapeHtml(bullet[1])}</li>` : `<p>${escapeHtml(line.trim())}</p>`;
  };
  const out: string[] = [];
  if (meta.question) out.push(`<p><strong>Q:</strong> ${escapeHtml(meta.question)}</p>`);
  if (meta.pageLabel) out.push(`<p><em>p. ${escapeHtml(meta.pageLabel)}</em></p>`);
  // The passage the answer is about, quoted so the note stands alone outside the reader.
  const quoted = String(meta.selection || "").trim();
  if (quoted) out.push(`<blockquote><p>${escapeHtml(quoted)}</p></blockquote>`);
  let inList = false;
  for (const line of String(answer || "").split(/\r?\n/)) {
    if (!line.trim()) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      continue;
    }
    const isBullet = /^\s*(?:[-*•]|\d+[.)])\s+/.test(line);
    if (isBullet && !inList) {
      out.push("<ul>");
      inList = true;
    } else if (!isBullet && inList) {
      out.push("</ul>");
      inList = false;
    }
    out.push(para(line));
  }
  if (inList) out.push("</ul>");
  return out.join("");
}

/**
 * Attaches `comment` to the annotation identified by `key`.
 * Comment edits go through the same saveFromJSON path the reader uses for its own comment box,
 * so the item stays consistent with sync (only `onlyTextOrComment` fields change).
 */
export async function addCommentToAnnotation(
  attachment: any,
  key: string,
  comment: string
): Promise<AnnotateResult> {
  try {
    const item = Zotero.Items.getByLibraryAndKey(attachment.libraryID, key);
    if (!item || !item.isAnnotation?.()) return { ok: false, error: "Highlight not found" };
    item.annotationComment = String(comment || "");
    // saveTx returns a Promise; the comment is only durable once it resolves.
    await item.saveTx({ skipSelect: true });
    return { ok: true, kind: "highlight", created: false, key: item.key };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Creates a highlight from the live PDF selection and stores `comment` on it.
 * Requires a non-collapsed selection: the JSON comes from Zotero's own
 * `_getAnnotationFromSelectionRanges`, so text/position/sortIndex match exactly what a manual
 * highlight would produce.
 */
export function highlightSelection(comment: string, color = DEFAULT_HIGHLIGHT_COLOR): AnnotateResult {
  const reader = activeReader();
  const win = readerWindow(reader);
  if (!win) return { ok: false, error: "No open PDF" };

  try {
    const result = JSON.parse(
      win.eval(`(() => {
        let view = window._reader && window._reader._lastView;
        if (!view) return JSON.stringify({ ok: false, error: "No open PDF" });

        // Clicking the panel clears _selectionRanges, so prefer the annotation JSON the
        // selection tracker captured while the ranges were still live (bounded age).
        let annotation = null;
        let stored = window.__zaaLastAnnotation;
        if (stored && stored.ann && Date.now() - stored.t < ${ANNOTATION_MAX_AGE_MS}) {
          annotation = JSON.parse(JSON.stringify(stored.ann));
        }
        if (!annotation) {
          let ranges = view._selectionRanges;
          if (!ranges || !ranges.length) {
            return JSON.stringify({ ok: false, error: "Select text in the PDF first" });
          }
          if (ranges[0].collapsed) {
            return JSON.stringify({ ok: false, error: "Selection is empty" });
          }
          annotation = view._getAnnotationFromSelectionRanges(
            ranges,
            "highlight",
            ${JSON.stringify(color)}
          );
        }
        if (!annotation || !annotation.position || !annotation.sortIndex) {
          return JSON.stringify({ ok: false, error: "Could not build annotation" });
        }
        annotation.comment = ${JSON.stringify(String(comment || ""))};
        // _onAddAnnotation assigns id/dateCreated inside AnnotationManager.addAnnotation and
        // routes through the reader's own debounced save (onSaveAnnotations), so nothing here
        // touches SQLite directly.
        let added = view._onAddAnnotation(annotation, true);
        view._setSelectionRanges();
        view._render();
        return JSON.stringify({
          ok: true,
          id: String((added && added.id) || ""),
          text: String(annotation.text || "").slice(0, 200),
          pageLabel: String(annotation.pageLabel || "")
        });
      })()`)
    );
    if (!result?.ok) return { ok: false, error: result?.error || "Highlight failed" };
    return { ok: true, kind: "highlight", created: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Creates a standalone child note under the item, next to the PDF. */
export async function saveAnswerAsNote(homeItem: any, html: string): Promise<AnnotateResult> {
  try {
    if (!homeItem?.libraryID) return { ok: false, error: "No active item" };
    const note = new Zotero.Item("note");
    note.libraryID = homeItem.libraryID;
    note.parentID = homeItem.id;
    note.setNote(html);
    // The key is assigned inside save(), which is async; await it before reading key.
    await note.saveTx();
    return { ok: true, kind: "note", key: String(note.key || "") };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Resolves the item a note should hang off: the paper, not its PDF attachment. */
export function homeItemFor(reader: any): any | null {
  try {
    const attachment = Zotero.Items.get(reader.itemID);
    if (!attachment) return null;
    return attachment.parentItemID ? Zotero.Items.get(attachment.parentItemID) : attachment;
  } catch {
    return null;
  }
}

export function currentReader(): any | null {
  return activeReader();
}
