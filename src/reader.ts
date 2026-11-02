/**
 * Zotero 7 Reader context extraction.
 *
 * Verified live against Zotero 7.0.0-beta.83 (`X-Zotero-Version: 11.0-beta.2+433c109b7`):
 *   Zotero.Reader._readers[n]              -> reader instance (itemID, type, tabID)
 *   reader._iframeWindow.wrappedJSObject   -> the PDF.js window. The raw _iframeWindow is an Xray
 *                                             wrapper and exposes none of these props.
 *   win.PDFViewerApplication.pdfViewer     -> currentPageNumber, pagesCount
 *   win.PDFViewerApplication.pdfDocument
 *     .getPageData({ pageIndex })          -> { chars, viewBox }; chars[i].c holds the glyphs.
 *                                             pageIndex is ZERO-based (page 3 -> 2).
 *
 * Three traps this avoids, all hit live before landing here:
 *   - Nothing to scrape from the DOM: `querySelectorAll('[data-page-number]')` returns 0 and
 *     there is no `.textLayer` in the reader window.
 *   - `getPageData()` cannot cross the compartment boundary — returning it to chrome throws
 *     `DataCloneError: The object could not be cloned.` It is awaited, serialized and parsed
 *     INSIDE the reader window; only a plain JSON string crosses over.
 *   - `pdfDocument.getPage(n)` yields a PDFPageProxy with no `getTextContent()` in this build.
 */

import type { ActiveReadingSession } from "./bridge.js";

declare const Zotero: any;

/** Page excerpt budget handed to the LLM; the prompt builder caps again at MAX_CONTEXT_CHARS. */
export const MAX_PAGE_CHARS = 8000;

/**
 * How long a remembered selection stays authoritative, in ms.
 *
 * Single source of truth: the tracker writes `__zaaLastSelection`, and every reader of it (this
 * snapshot, the panel's selection note, the highlight/note save paths in bootstrap.ts) judges it
 * with this one number. They used to disagree — 120 s here, 300 s there — so between minute 2 and
 * minute 5 the bridge reported no selection while an answer still carried the old text.
 *
 * ponytail: 5 minutes, not a pref. It is long enough to open the panel and type a question, short
 * enough that yesterday's selection cannot silently attach itself to today's answer.
 */
export const SELECTION_MAX_AGE_MS = 300_000;

export interface PageSnapshot {
  pageNumber: number;
  totalPages: number;
  chars: CharInfo[];
  selection: string;
  /** Which tier produced the selection text (debug aid for live selection issues). */
  selectionSource?: string;
  /** Last few tracker events: [{src, text, t}] — evidence for what selection actually fired. */
  selectionLog?: Array<{ src: string; text: string; t: number }>;
}

/** Minimal glyph record handed across the compartment boundary (primitives only, clonable). */
export interface CharInfo {
  c?: string;
  ignorable?: boolean;
  spaceAfter?: boolean;
  lineBreakAfter?: boolean;
  paragraphBreakAfter?: boolean;
}

function activeReader(): any | null {
  const readers = Zotero.Reader?._readers;
  if (!Array.isArray(readers)) return null;
  // ponytail: newest reader wins. Zotero 7.0 exposes no public "active reader" getter
  // (Zotero.Reader own props: _readers, _sidebarWidth, _notifierID, ...), so tab focus order
  // is the only signal available without the renderToolbar listener.
  for (let i = readers.length - 1; i >= 0; i--) {
    if (readers[i] && !readers[i]._isTabClosed) return readers[i];
  }
  return null;
}

function contentWindow(reader: any): any {
  try {
    return reader?._iframeWindow?.wrappedJSObject || null;
  } catch {
    return null;
  }
}

export function getPageNumber(reader: any): number {
  try {
    const n = contentWindow(reader)?.PDFViewerApplication?.pdfViewer?.currentPageNumber;
    return typeof n === "number" && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function getTotalPages(reader: any): number {
  try {
    const n = contentWindow(reader)?.PDFViewerApplication?.pdfViewer?.pagesCount;
    return typeof n === "number" && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function capText(text: string, limit = MAX_PAGE_CHARS): string {
  const normalized = (text || "").replace(/\s+/g, " ").trim();
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

/**
 * Joins structured PDF chars into text with the same rule Zotero uses in
 * resource/reader/pdf/build/pdf.worker.mjs `getTextFromChars()`:
 *   spaceAfter, or a lineBreakAfter that is not a paragraph break, inserts a space.
 * `wordBreakAfter` is deliberately ignored — it marks a break *opportunity* and fires on nearly
 * every glyph, which produced "Vol . : ( 0123456789 )" when used as a space.
 */
export function joinChars(chars: CharInfo[]): string {
  const parts: string[] = [];
  for (const ch of chars || []) {
    if (!ch) continue;
    if (!ch.ignorable) parts.push(ch.c || "");
    if (ch.spaceAfter || (ch.lineBreakAfter && !ch.paragraphBreakAfter)) parts.push(" ");
    if (ch.paragraphBreakAfter) parts.push("\n\n");
  }
  return parts.join("").trim();
}

/** Runs `body` inside the reader window and parses the JSON snapshot it returns. */
async function readFromReaderWindow(reader: any, body: string): Promise<PageSnapshot | null> {
  const win = contentWindow(reader);
  if (typeof win?.eval !== "function") return null;
  try {
    const json = await win.eval(`(async () => { ${body} })()`);
    if (typeof json !== "string") return null;
    const parsed = JSON.parse(json);
    return typeof parsed?.pageNumber === "number" ? parsed : null;
  } catch {
    return null;
  }
}

/** Current page text + selection, read from inside the PDF.js window. */
export function readPageSnapshot(reader: any): Promise<PageSnapshot | null> {
  return readFromReaderWindow(
    reader,
    // One freshness window for every consumer of the remembered selection. The tracker (in
    // bootstrap.ts) is the only writer; this snapshot, the panel note and the save paths all
    // judge the same copy with the same age, so they cannot disagree about whether a selection
    // is still in play.
    `
    let SELECTION_MAX_AGE = ${SELECTION_MAX_AGE_MS};
    let app = PDFViewerApplication;
    let pageNumber = app.pdfViewer.currentPageNumber;
    let totalPages = app.pdfViewer.pagesCount;
    let data = await app.pdfDocument.getPageData({ pageIndex: pageNumber - 1 });
    let all = Array.isArray(data && data.chars) ? data.chars : [];
    // Only primitives cross into chrome; anything else makes the transfer throw DataCloneError.
    let chars = all.map(ch => ({
      c: ch && ch.c,
      ignorable: !!ch.ignorable,
      spaceAfter: !!ch.spaceAfter,
      lineBreakAfter: !!ch.lineBreakAfter,
      paragraphBreakAfter: !!ch.paragraphBreakAfter
    }));

    let selection = "";
    let source = "";
    // Tier 1: Zotero's own selection ranges (same text a highlight annotation would store).
    try {
      let view = window._reader && window._reader._lastView;
      let ranges = view && view._selectionRanges;
      if (ranges && ranges.length && !ranges[0].collapsed) {
        selection = ranges.map(r => String((r && r.text) || "")).filter(Boolean).join(" ");
        if (selection) source = "ranges";
      }
    } catch (e) {}
    // Tier 2: clicking the panel clears Zotero's ranges, so reuse the tracker's copy — it was
    // captured FROM the ranges at selection time, and only while fresh (DOM tiers below are
    // stale-prone: the viewer iframe can hold a selection from minutes ago).
    if (!selection) {
      try {
        let stored = window.__zaaLastSelection;
        if (stored && stored.text && Date.now() - stored.t < SELECTION_MAX_AGE) {
          selection = String(stored.text);
          source = "remembered";
        }
      } catch (e) {}
    }
    // Tier 3: DOM selection on the reader window itself.
    if (!selection) {
      try {
        let sel = window.getSelection() || document.getSelection();
        selection = sel ? String(sel.toString() || "") : "";
        if (selection) source = "dom-outer";
      } catch (e) {}
    }
    // Tier 4: the PDF text layer lives in a nested viewer iframe; ask each frame directly.
    if (!selection) {
      try {
        for (const frame of document.querySelectorAll("iframe")) {
          let inner = "";
          try { inner = String((frame.contentWindow && frame.contentWindow.getSelection()) || ""); } catch (e) {}
          if (inner) { selection = inner; source = "dom-inner"; break; }
        }
      } catch (e) {}
    }
    let selectionLog = [];
    try {
      // Record what THIS read resolved to, so a live selection bug leaves evidence in the log
      // (readable via GET /agent-bridge/active → selectionLog).
      let log = window.__zaaSelLog || [];
      let view = window._reader && window._reader._lastView;
      let ranges = view && view._selectionRanges;
      log.push({
        src: "snap:" + (source || "none"),
        text: String(selection || "").slice(0, 80),
        t: Date.now(),
        rangesLen: ranges ? ranges.length : -1,
        storedAge: window.__zaaLastSelection ? Date.now() - window.__zaaLastSelection.t : -1
      });
      window.__zaaSelLog = log.slice(-20);
      selectionLog = window.__zaaSelLog.slice(-10);
    } catch (e) {}
    return JSON.stringify({ pageNumber, totalPages, chars, selection, selectionSource: source, selectionLog });
    `
  );
}

export interface HighlightInfo {
  key: string;
  text: string;
  comment?: string;
  pageLabel?: string;
}

function creatorNames(item: any): string[] {
  try {
    return (item.getCreators?.() || [])
      .map((creator: any) => creator.lastName || creator.name || "")
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Highlight annotations on the open attachment.
 * `Zotero.Item.prototype.getAnnotations()` (xpcom/data/item.js:4023) throws
 * UnloadedDataException when `childItems` is not loaded for a cached item, so load it once
 * and retry instead of silently reporting "no highlights".
 */
export async function getHighlights(attachment: any, limit = 40): Promise<HighlightInfo[]> {
  const collect = () => {
    const out: HighlightInfo[] = [];
    for (const annotation of attachment?.getAnnotations?.() || []) {
      const text = String(annotation?.annotationText || "").trim();
      if (!text) continue;
      out.push({
        key: String(annotation.key || ""),
        text,
        comment: String(annotation.annotationComment || "").trim() || undefined,
        pageLabel: String(annotation.annotationPageLabel || "").trim() || undefined
      });
      if (out.length >= limit) break;
    }
    return out;
  };

  try {
    return collect();
  } catch {
    try {
      await attachment?.loadDataType?.("childItems");
    } catch {
      return [];
    }
    try {
      return collect();
    } catch {
      return [];
    }
  }
}

/**
 * Builds the session payload from live reader state. Returns null when no PDF tab is open.
 * Called per request — no cached copy, so no listener and no teardown to leak.
 */
export async function getReaderContext(): Promise<ActiveReadingSession | null> {
  const reader = activeReader();
  if (!reader) return null;

  let attachment: any;
  try {
    attachment = Zotero.Items.get(reader.itemID);
  } catch {
    attachment = null;
  }
  if (!attachment) return null;

  const parent = attachment.parentItemID ? Zotero.Items.get(attachment.parentItemID) : attachment;
  const snapshot = await readPageSnapshot(reader);

  return {
    itemKey: parent?.key || attachment.key,
    attachmentKey: attachment.key,
    title: parent?.getField?.("title") || attachment.getField?.("title") || "",
    authors: creatorNames(parent),
    publicationYear: Number(parent?.getField?.("date")?.match(/\d{4}/)?.[0]) || undefined,
    activePage: snapshot?.pageNumber || getPageNumber(reader),
    totalPages: snapshot?.totalPages || getTotalPages(reader),
    selectedText: capText(snapshot?.selection || "", 4000),
    selectionSource: snapshot?.selectionSource || "",
    selectionLog: snapshot?.selectionLog || [],
    pageText: capText(joinChars(snapshot?.chars || [])),
    highlights: await getHighlights(attachment),
    timestamp: new Date().toISOString()
  };
}