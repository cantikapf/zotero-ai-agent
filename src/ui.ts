/**
 * Reader-side chat panel.
 *
 * Injection point is Zotero's documented reader event API (xpcom/reader.js:1577):
 *   registerEventListener('renderToolbar', event => { let { reader, doc, params, append } = event; append(el) })
 * `doc` is the reader document, so every node is created through it and nothing is injected into
 * a foreign realm.
 *
 * ponytail: the panel floats over the reader instead of becoming a real sidebar tab — a custom
 * sidebar tab needs reader internals that are not documented, and this is enough to use the agent.
 * Upgrade path: replace the fixed panel with a ReaderTab sidebar pane once the tab API is verified.
 */

export const PANEL_ID = "zotero-ai-agent-panel";
export const BUTTON_ID = "zotero-ai-agent-toolbar-button";

import { renderMarkdownToHtml } from "./markdown.js";

export interface Highlight {
  key: string;
  text: string;
  pageLabel?: string;
}

export interface PanelHandlers {
  /** Resolves with the full answer; `onChunk` streams deltas into the panel. */
  ask: (
    question: string,
    onChunk: (delta: string) => void,
    highlightKey?: string,
    useExternalSources?: boolean
  ) => Promise<{ answer: string; pageNumber: number; sources?: { title: string; url: string }[] }>;
  /** Current page label, or null when no PDF session is live. */
  pageLabel: () => Promise<string | null>;
  /** Highlights on the open PDF, shown as clickable chips. */
  highlights: () => Promise<Highlight[]>;
  /** Text the user selected in the PDF, rescued before the panel stole focus. */
  selection: () => Promise<string>;
  /**
   * Writes an answer back into Zotero. `highlight` marks the selected text and stores the answer
   * as its comment; `note` creates a child note. Resolves to a human-readable status.
   */
  saveAnswer: (kind: "highlight" | "note", payload: SavedAnswer) => Promise<string>;
  /**
   * Appends the answer to the Obsidian export file. `obsidian` is hidden entirely when no export
   * folder is configured, so the button never lies about doing nothing.
   */
  exportAnswer?: (payload: SavedAnswer) => Promise<string>;
  /** True when an export folder is configured (pref `obsidianExportDir`). */
  canExport?: () => boolean;
}

/** Everything the save buttons need, captured when the answer finished streaming. */
export interface SavedAnswer {
  question: string;
  answer: string;
  pageLabel: string;
}

function panelStyles(doc: any): void {
  if (doc.getElementById(`${PANEL_ID}-style`)) return;
  const style = doc.createElement("style");
  style.id = `${PANEL_ID}-style`;
  style.textContent = `
    #${PANEL_ID} {
      position: fixed; right: 16px; bottom: 16px; width: 360px; max-height: 60vh;
      display: none; flex-direction: column; gap: 8px; padding: 12px;
      background: var(--material-background, #fff); color: var(--fill-primary, #111);
      border: 1px solid rgba(127,127,127,.35); border-radius: 8px;
      box-shadow: 0 6px 24px rgba(0,0,0,.22); font: 13px/1.45 system-ui, sans-serif; z-index: 9999;
    }
    #${PANEL_ID}[data-open="true"] { display: flex; }
    #${PANEL_ID} header { display: flex; justify-content: space-between; align-items: center; font-weight: 600; }
    #${PANEL_ID} textarea { width: 100%; min-height: 56px; resize: vertical; font: inherit; padding: 6px; }
    #${PANEL_ID} .row { display: flex; gap: 8px; align-items: center; }
    #${PANEL_ID} button { font: inherit; padding: 4px 10px; cursor: pointer; }
    #${PANEL_ID} .answer { overflow: auto; max-height: 32vh; }
    #${PANEL_ID} .answer p { margin: 6px 0; }
    #${PANEL_ID} .answer ul { margin: 4px 0; padding-left: 18px; }
    #${PANEL_ID} .answer li { margin: 2px 0; }
    #${PANEL_ID} .answer code { font-size: 11px; }
    #${PANEL_ID} .status { font-size: 11px; opacity: .7; }
    #${PANEL_ID} .chips { display: flex; flex-wrap: wrap; gap: 4px; max-height: 88px; overflow: auto; }
    #${PANEL_ID} .chip {
      font: 11px/1.3 system-ui, sans-serif; padding: 3px 7px; cursor: pointer;
      border: 1px solid rgba(127,127,127,.45); border-radius: 10px; background: transparent;
      color: inherit; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    #${PANEL_ID} .chip[data-active="true"] { background: rgba(80,140,255,.25); border-color: rgba(80,140,255,.8); }
    #${PANEL_ID} .hint { font-size: 11px; opacity: .7; font-style: italic; white-space: pre-wrap; }
    #${PANEL_ID} .save { display: flex; gap: 6px; align-items: center; }
    #${PANEL_ID} .save button[disabled] { opacity: .45; cursor: default; }
    #${PANEL_ID} .sources-toggle {
      display: flex; gap: 6px; align-items: center; font-size: 11px; opacity: .85; cursor: pointer;
    }
    #${PANEL_ID} .answer .sources { font-size: 11px; opacity: .85; border-top: 1px solid rgba(127,127,127,.3); margin-top: 8px; padding-top: 6px; }
    #${PANEL_ID} .answer .sources a { color: inherit; }
  `;
  doc.documentElement.append(style);
}

/**
 * Minimal Markdown -> HTML for model answers: escapes HTML first, then **bold**, `code`,
 * "- " / "1. " bullets, and blank-line paragraphs. Model output is untrusted text, so no raw
 * HTML ever reaches the panel.
 */
/** Creates the toolbar toggle button; safe to call on every toolbar render. */
export function createToolbarButton(doc: any): any {
  const button = doc.createElement("button");
  button.id = BUTTON_ID;
  button.className = "toolbar-button";
  button.title = "Ask the AI about this page";
  button.textContent = "AI";
  return button;
}

/** Creates the chat panel inside the reader document. */
/**
 * `allowExternalSources` comes from the pref: when the user turned web references off globally,
 * the per-question checkbox is not rendered at all rather than shown disabled.
 */
export function createPanel(
  doc: any,
  handlers: PanelHandlers,
  options: { allowExternalSources?: boolean } = {}
): any {
  panelStyles(doc);

  const panel = doc.createElement("div");
  panel.id = PANEL_ID;
  panel.dataset.open = "false";

  const header = doc.createElement("header");
  const title = doc.createElement("span");
  title.textContent = "Ask this paper";
  const close = doc.createElement("button");
  close.textContent = "×";
  close.title = "Close";
  header.append(title, close);

  const input = doc.createElement("textarea");
  input.placeholder = "Ask about the page you are reading…";

  const row = doc.createElement("div");
  row.className = "row";
  const send = doc.createElement("button");
  send.textContent = "Send";
  const status = doc.createElement("span");
  status.className = "status";
  row.append(send, status);

  // Opt-in online lookup: off by default so a question about the page never waits on the network
  // unless the user asked for it.
  const sourcesRow = doc.createElement("label");
  sourcesRow.className = "sources-toggle";
  sourcesRow.hidden = !options.allowExternalSources;
  const useSources = doc.createElement("input");
  useSources.type = "checkbox";
  const sourcesLabel = doc.createElement("span");
  sourcesLabel.textContent = "Add references from the web (DOI-verified)";
  sourcesRow.append(useSources, sourcesLabel);

  const chips = doc.createElement("div");
  chips.className = "chips";

  const hint = doc.createElement("div");
  hint.className = "hint";

  const selectionNote = doc.createElement("div");
  selectionNote.className = "hint";

  const answer = doc.createElement("div");
  answer.className = "answer";

  // Save row: disabled until an answer exists, so it cannot act on a stale or empty result.
  const saveRow = doc.createElement("div");
  saveRow.className = "save";
  const saveHighlight = doc.createElement("button");
  saveHighlight.textContent = "Highlight + comment";
  saveHighlight.title = "Highlight the selected text and store this answer as its comment";
  saveHighlight.disabled = true;
  const saveNote = doc.createElement("button");
  saveNote.textContent = "Save as note";
  saveNote.title = "Create a child note on this item with the question and answer";
  saveNote.disabled = true;
  const saveStatus = doc.createElement("span");
  saveStatus.className = "status";
  // Export button only exists when a vault folder is configured; a dead button is worse than none.
  const saveObsidian = doc.createElement("button");
  saveObsidian.textContent = "Export to Obsidian";
  saveObsidian.title = "Append this discussion to the Obsidian export file for this paper";
  saveObsidian.disabled = true;
  const showExport = !!handlers.exportAnswer && handlers.canExport?.() !== false;
  saveObsidian.hidden = !showExport;
  saveRow.append(saveHighlight, saveNote, ...(showExport ? [saveObsidian] : []), saveStatus);

  panel.append(header, sourcesRow, chips, selectionNote, input, row, hint, answer, saveRow);

  let activeHighlight: string | undefined;
  // Captured after each answer so the save buttons act on what is on screen.
  let lastAnswer: SavedAnswer | null = null;

  // Clicking a highlight fills the question with a ready-made ask about that passage.
  let chipsSignature = "";
  const renderChips = (items: Highlight[]) => {
    const signature = items.map((item) => item.key).join(",");
    if (signature === chipsSignature) return; // keep the active chip when nothing changed
    chipsSignature = signature;
    chips.replaceChildren();
    if (!items.length) {
      chips.textContent = "No highlights yet — select text in the PDF and highlight it.";
      return;
    }
    for (const item of items) {
      const chip = doc.createElement("button");
      chip.className = "chip";
      chip.title = item.text;
      chip.textContent = `${item.pageLabel ? `p.${item.pageLabel} · ` : ""}${item.text.slice(0, 48)}`;
      chip.addEventListener("click", () => {
        activeHighlight = activeHighlight === item.key ? undefined : item.key;
        for (const other of chips.querySelectorAll(".chip")) other.dataset.active = "false";
        if (activeHighlight) {
          chip.dataset.active = "true";
          hint.textContent = `Asking about: "${item.text.slice(0, 160)}${item.text.length > 160 ? "…" : ""}"`;
          input.placeholder = "Ask about this highlight (optional — leave empty to just explain it)";
        } else {
          hint.textContent = "";
          input.placeholder = "Ask about the page you are reading…";
        }
      });
      chips.append(chip);
    }
  };

  let selectionTimer = 0;
  const refreshSelection = () => {
    // New highlights appear while the panel is open; re-render only when the set changed.
    handlers
      .highlights()
      .then(renderChips)
      .catch(() => {});
    handlers
      .selection()
      .then((text) => {
        selectionNote.textContent = text
          ? `Selected text will be used: "${text.slice(0, 120)}${text.length > 120 ? "…" : ""}"`
          : "";
      })
      .catch(() => {
        selectionNote.textContent = "";
      });
  };

  const setOpen = (open: boolean) => {
    panel.dataset.open = open ? "true" : "false";
    if (open) {
      handlers
        .pageLabel()
        .then((label) => {
          status.textContent = label ?? "No PDF page detected";
        })
        .catch(() => {
          status.textContent = "No PDF page detected";
        });
      handlers
        .highlights()
        .then(renderChips)
        .catch(() => renderChips([]));
      refreshSelection();
      // The user often selects text *after* opening the panel, so keep the note honest.
      clearInterval(selectionTimer);
      selectionTimer = setInterval(refreshSelection, 1200);
      input.focus();
    } else {
      clearInterval(selectionTimer);
      selectionTimer = 0;
    }
  };

  close.addEventListener("click", () => setOpen(false));
  panel.toggle = () => setOpen(panel.dataset.open !== "true");

  const submit = async () => {
    const question = String(input.value || "").trim();
    if (!question && !activeHighlight) return;
    send.disabled = true;
    answer.textContent = "";
    status.textContent = "Thinking…";
    saveHighlight.disabled = true;
    saveNote.disabled = true;
    saveObsidian.disabled = true;
    saveStatus.textContent = "";
    lastAnswer = null;
    let raw = "";
    try {
      const result = await handlers.ask(
        question,
        (delta) => {
          raw += delta;
          answer.innerHTML = renderMarkdownToHtml(raw);
        },
        activeHighlight,
        useSources.checked
      );
      // The stream is only a preview: the returned answer is the corrected one — invented
      // citation markers removed, and the paper's own reference list appended from real records.
      // Rendering the raw stream would show the user something the saved copy does not contain.
      if (result.answer) raw = result.answer;
      answer.innerHTML = renderMarkdownToHtml(raw);
      renderSources(result.sources);
      const pageLabel = String(result.pageNumber || "");
      status.textContent = `p. ${pageLabel}`;
      lastAnswer = { question, answer: raw, pageLabel };
      saveHighlight.disabled = false;
      saveNote.disabled = false;
      saveObsidian.disabled = false;
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      answer.textContent = "";
    } finally {
      send.disabled = false;
    }
  };

  /** Reference list under the answer, linked by DOI. Rendered from data, never from model text. */
  const renderSources = (list?: { title: string; url: string }[]) => {
    if (!list || !list.length) return;
    const box = doc.createElement("div");
    box.className = "sources";
    const head = doc.createElement("strong");
    head.textContent = "Sources";
    box.append(head);
    const ol = doc.createElement("ol");
    ol.style.margin = "4px 0 0"; ol.style.paddingLeft = "18px";
    for (const item of list) {
      const li = doc.createElement("li");
      const link = doc.createElement("a");
      link.href = item.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = item.title;
      li.append(link);
      ol.append(li);
    }
    box.append(ol);
    answer.append(box);
  };

  const doSave = async (kind: "highlight" | "note") => {
    if (!lastAnswer) return;
    saveHighlight.disabled = true;
    saveNote.disabled = true;
    saveStatus.textContent = "Saving…";
    try {
      saveStatus.textContent = await handlers.saveAnswer(kind, lastAnswer);
    } catch (error) {
      saveStatus.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      saveHighlight.disabled = false;
      saveNote.disabled = false;
    }
  };

  const doExport = async () => {
    if (!lastAnswer || !handlers.exportAnswer) return;
    saveHighlight.disabled = true;
    saveNote.disabled = true;
    saveObsidian.disabled = true;
    saveStatus.textContent = "Exporting…";
    try {
      saveStatus.textContent = await handlers.exportAnswer(lastAnswer);
    } catch (error) {
      saveStatus.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      saveHighlight.disabled = false;
      saveNote.disabled = false;
      saveObsidian.disabled = false;
    }
  };

  saveHighlight.addEventListener("click", () => void doSave("highlight"));
  saveNote.addEventListener("click", () => void doSave("note"));
  saveObsidian.addEventListener("click", () => void doExport());

  send.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (event: any) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  });

  return panel;
}