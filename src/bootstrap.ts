/**
 * Zotero 7 Extension Bootstrap Lifecycle.
 * Follows modern Zotero 7 WebExtension / XPCOM hybrid specification.
 */

import { ACTIVE_SESSION_PATH, AgentBridgeServer, CHAT_PATH } from "./bridge.js";
import { answerFromSession } from "./chat.js";
import { DEFAULT_CONFIG, buildViewportPrompt, streamChatCompletion } from "./llm.js";
import { SELECTION_MAX_AGE_MS, getReaderContext } from "./reader.js";
import { BUTTON_ID, PANEL_ID, createPanel, createToolbarButton } from "./ui.js";
import {
  addCommentToAnnotation,
  answerToNoteHtml,
  currentReader,
  highlightSelection,
  homeItemFor,
  saveAnswerAsNote
} from "./annotate.js";
import { searchSources } from "./sources.ts";
import {
  appendDiscussionSection,
  discussionFileName,
  formatZotlitDiscussionMarkdown,
  readFrontmatter,
  zotlitZoteroKey
} from "./zotlit.js";

declare const Zotero: any;

const PREF_BASE_URL = "extensions.zotero-ai-agent.baseUrl";
const PREF_MODEL = "extensions.zotero-ai-agent.model";
const PREF_API_KEY = "extensions.zotero-ai-agent.apiKey";
const PREF_LANGUAGE = "extensions.zotero-ai-agent.answerLanguage";
const PREF_BRIDGE_TOKEN = "extensions.zotero-ai-agent.bridgeToken";
const PREF_CONTEXT_CHARS = "extensions.zotero-ai-agent.contextChars";
const PREF_USE_SOURCES = "extensions.zotero-ai-agent.useExternalSources";
const PREF_EXPORT_DIR = "extensions.zotero-ai-agent.obsidianExportDir";

// Verified in xpcom/reader.js:1547-1587: registerEventListener(type, handler, pluginID) and the
// payload shape { reader, doc, params, append }.
const TOOLBAR_EVENT = "renderToolbar";
// Preference pane: Zotero.PreferencePanes.register (xpcom/preferencePanes.js:register) loads `src`
// as an XHTML *fragment* with XUL as default namespace, resolves plugin-relative URIs, and
// auto-unregisters panes on plugin shutdown. `preference="<full key>"` on an element is bound
// natively by preferences/preferences.js (_syncFromPref / _syncToPrefOnModify).
const PREF_PANE_ID = "zaa-preferences";
const PREF_PANE_SRC = "preferences.xhtml";
// Tools menu: menu_ToolsPopup exists in zoteroPane.xhtml and registers no plugin API in Zotero 7
// (Zotero.MenuManager is Zotero 8+), so the item is injected by hand and removed on shutdown.
const TOOLS_MENU_ITEM_ID = "zaa-tools-preferences";
const PLUGIN_ID = "zotero-ai-agent@cantikapf.github.io";

let bridgeServer: AgentBridgeServer | null = null;
let activeEndpoint: any = null;
let chatEndpoint: any = null;
let toolbarHandler: ((event: any) => void) | null = null;
let prefPaneID: string | null = null;

function prefPane(options: { pluginID: string; rootURI: string }) {
  if (!Zotero.PreferencePanes?.register) return;
  prefPaneID = PREF_PANE_ID;
  Zotero.PreferencePanes.register({
    id: PREF_PANE_ID,
    pluginID: options.pluginID,
    src: options.rootURI + PREF_PANE_SRC,
    label: "Zotero AI Agent"
  }).then((id: string) => Zotero.debug(`[Zotero-AI-Agent] Preference pane registered: ${id}`))
    .catch((e: any) => Zotero.logError(e));
}

function openPrefPane() {
  Zotero.Utilities.Internal.openPreferences(prefPaneID || PREF_PANE_ID);
}

/** Idempotent: onMainWindowLoad fires for new windows, startup sweeps the ones already open. */
function addToolsMenuItem(win: any) {
  const popup = win?.document?.getElementById("menu_ToolsPopup");
  if (!popup || popup.querySelector("#" + TOOLS_MENU_ITEM_ID)) return;
  const item = win.document.createXULElement("menuitem");
  item.id = TOOLS_MENU_ITEM_ID;
  item.setAttribute("label", "Zotero AI Agent Preferences…");
  item.addEventListener("command", openPrefPane);
  popup.appendChild(item);
  Zotero.debug("[Zotero-AI-Agent] Added Tools menu item");
}

function removeToolsMenuItem(win: any) {
  const item = win?.document?.getElementById(TOOLS_MENU_ITEM_ID);
  if (!item) return;
  item.remove();
  Zotero.debug("[Zotero-AI-Agent] Removed Tools menu item");
}

export function onMainWindowLoad({ window }: any) {
  addToolsMenuItem(window);
}

export function onMainWindowUnload({ window }: any) {
  removeToolsMenuItem(window);
}

/** Prefs override the defaults so the gateway/model/key stay user-configurable, never hardcoded.
 *  Second arg `true` = use the full pref name; Zotero.Prefs.get otherwise prepends
 *  "extensions.zotero." (xpcom/prefs.js:get), which turned every lookup into a miss. */
function llmConfig() {
  const pref = (name: string) => Zotero.Prefs.get(name, true);
  const apiKey = pref(PREF_API_KEY);
  return {
    ...DEFAULT_CONFIG,
    baseUrl: pref(PREF_BASE_URL) || DEFAULT_CONFIG.baseUrl,
    model: pref(PREF_MODEL) || DEFAULT_CONFIG.model,
    ...(apiKey ? { apiKey: String(apiKey) } : {})
  };
}

/** Context character budget; unset/unparsable falls back to MAX_CONTEXT_CHARS. */
function contextChars(): number | undefined {
  const raw = parseInt(String(Zotero.Prefs.get(PREF_CONTEXT_CHARS, true) || ""), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

/**
 * `fetch` is not guaranteed inside the plugin sandbox, so lookups go through
 * Zotero.HTTP.request, which resolves with the XMLHttpRequest object
 * (verified in chrome/content/zotero/xpcom/http.js: `deferred.resolve(xmlhttp)`).
 * ponytail: AbortSignal is ignored — Zotero's own `timeout` covers it.
 */
async function zoteroFetch(url: string): Promise<any> {
  const xhr = await Zotero.HTTP.request("GET", url, {
    headers: { Accept: "application/json" },
    responseType: "text",
    timeout: 6000,
    successCodes: false // handle every status here instead of throwing on 4xx/5xx
  });
  return {
    ok: xhr.status >= 200 && xhr.status < 300,
    status: xhr.status,
    json: async () => JSON.parse(xhr.responseText)
  };
}

/** Chat dependencies, shared by the reader panel and the HTTP route so they cannot drift apart. */
function chatDeps() {
  return {
    buildViewportPrompt,
    streamChatCompletion,
    config: llmConfig(),
    // Crossref: DOI-validated records only, so every citation resolves. Never throws.
    findSources: (query: string) =>
      searchSources({ query, fetchImpl: zoteroFetch as unknown as typeof fetch }),
    // The paper's own reference list, from the cache Zotero writes when it indexes the PDF.
    readFullText: () => readAttachmentFullText()
  };
}

/**
 * Full text of the open attachment from Zotero's own full-text cache (`.zotero-ft-cache` in the
 * attachment's storage directory, written by `pdfWorker.getFullText`). Reading it costs nothing:
 * Zotero built it at import time, so no extraction is triggered here and an unindexed paper simply
 * returns "". Verified against the live storage layout on this machine.
 */
async function readAttachmentFullText(): Promise<string> {
  try {
    const reader = currentReader();
    if (!reader?.itemID) return "";
    const attachment = Zotero.Items.get(reader.itemID);
    if (!attachment?.isPDFAttachment?.()) return "";
    const cacheFile = Zotero.Fulltext?.getItemCacheFile?.(attachment);
    const path = cacheFile?.path;
    if (!path) return "";
    return String((await Zotero.File.getContentsAsync(path)) || "");
  } catch {
    return "";
  }
}

/** Master switch for the external-reference lookup (pref `useExternalSources`). */
function externalSourcesEnabled(): boolean {
  return !!Zotero.Prefs.get(PREF_USE_SOURCES, true);
}

/** Answer language pref; unset falls back to the prompt default (English). */
function answerLanguage(): string | undefined {
  const value = Zotero.Prefs.get(PREF_LANGUAGE, true);
  return value ? String(value) : undefined;
}

/** Obsidian vault folder for discussion exports; empty string = feature off. */
function exportDir(): string {
  return String(Zotero.Prefs.get(PREF_EXPORT_DIR, true) || "").trim();
}

/**
 * Native-separator join. Live evidence: both `OS.File.writeAtomic` and `FileUtils.File` reject a
 * forward-slash Windows path here (`NS_ERROR_FILE_UNRECOGNIZED_PATH`, then "Unexpected path
 * value"), so mixed separators are normalised to the platform's.
 */
function fileJoin(dir: string, name: string): string {
  const sep = Zotero.isWin ? "\\" : "/";
  const parts = `${dir}/${name}`.split(/[\\/]+/).filter(Boolean);
  const joined = parts.join(sep);
  return dir.trim().startsWith("/") ? "/" + joined : joined;
}

/** Group id for the item's library, or undefined for My Library. */
function groupIDFor(item: any): number | undefined {
  try {
    const library = Zotero.Libraries.get(item.libraryID);
    if (!library || library.libraryType !== "group") return undefined;
    return Number(library.groupID) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Appends the answer to `<exportDir>/AI Discussions - <itemKey>.md`.
 *
 * One file per paper: a second question appends a section instead of replacing the file, and an
 * existing `zotero-key` is never rewritten, so a note ZotLit already manages keeps its identity.
 * `Zotero.File.putContentsAsync` (xpcom/file.js) writes through `OS.File.writeAtomic`, i.e. a
 * temp file plus rename — an interrupted write cannot leave a half-written note.
 */
async function exportAnswerToObsidian(
  payload: { question: string; answer: string; pageLabel: string }
): Promise<string> {
  const dir = exportDir();
  if (!dir) return "Set an export folder in the add-on preferences";
  const reader = currentReader();
  if (!reader) return "No open PDF";
  const home = homeItemFor(reader);
  if (!home) return "No active item";

  try {
    const path = fileJoin(dir, discussionFileName(home.key));
    let existing = "";
    try {
      existing = String(await Zotero.File.getContentsAsync(path) || "");
    } catch {
      existing = ""; // first export for this paper
    }
    const params = {
      itemKey: String(home.key),
      attachmentKey: String(Zotero.Items.get(reader.itemID)?.key || ""),
      title: String(home.getField?.("title") || ""),
      pageNumber: Number(String(payload.pageLabel).match(/\d+/)?.[0]) || 0,
      pageLabel: payload.pageLabel,
      question: payload.question,
      answer: "",
      aiResponse: payload.answer,
      selectedText: selectedTextNow(),
      groupID: groupIDFor(home)
    } as any;

    // Guard: never append into a note that ZotLit pinned to a different item (renamed/duplicated
    // vault file). Writing there would mix two papers' discussions under one identity.
    const pinned = readFrontmatter(existing)?.["zotero-key"];
    const expected = zotlitZoteroKey(params.itemKey, params.groupID);
    if (pinned && pinned !== expected) {
      return `Export file belongs to another item (${pinned})`;
    }

    const body = existing.trim()
      ? appendDiscussionSection(existing, params)
      : formatZotlitDiscussionMarkdown(params);
    await Zotero.File.putContentsAsync(path, body);
    Zotero.debug(`[Zotero-AI-Agent] Exported discussion to ${path}`);
    return existing.trim() ? "Appended to Obsidian export" : "Exported to Obsidian";
  } catch (error) {
    return `Export failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function asResponse(result: { status: number; body: any }): [number, string, string] {
  return [result.status, "application/json", JSON.stringify(result.body)];
}

/** Toolbar render: add the toggle button once per reader document, plus the panel behind it. */
function renderToolbar(event: any) {
  const { doc, append, reader } = event || {};
  if (!doc || typeof append !== "function") return;

  trackSelection(reader);

  if (!doc.getElementById(PANEL_ID)) {
    const panel = createPanel(doc, {
      ask: (
        question: string,
        onChunk: (delta: string) => void,
        highlightKey?: string,
        useExternalSources?: boolean,
        cancelToken?: { cancelled: boolean }
      ) => askLive(question, onChunk, highlightKey, useExternalSources, cancelToken),
      pageLabel: async () => {
        const session = await bridgeServer?.getSession();
        return session ? `p. ${session.activePage} / ${session.totalPages}` : null;
      },
      highlights: async () => {
        const session = await bridgeServer?.getSession();
        return (session?.highlights || []).map((h) => ({
          key: h.key,
          text: h.text,
          pageLabel: h.pageLabel
        }));
      },
      selection: async () => {
        const session = await bridgeServer?.getSession();
        return session?.selectedText || "";
      },
      saveAnswer: async (kind, payload) => saveAnswerToPaper(kind, payload),
      exportAnswer: (payload) => exportAnswerToObsidian(payload),
      canExport: () => !!exportDir()
    }, { allowExternalSources: externalSourcesEnabled() });
    doc.body.append(panel);
  }

  if (doc.getElementById(BUTTON_ID)) return;
  const button = createToolbarButton(doc);
  button.addEventListener("click", () => {
    const existing = doc.getElementById(PANEL_ID);
    if (existing && typeof existing.toggle === "function") existing.toggle();
  });
  append(button);
}

/**
 * Writes an answer back into Zotero. Highlight mode prefers the annotation the user already
 * made on this selection (a comment edit, no duplicate highlight); otherwise it highlights the
 * live selection. Note mode always creates a child note on the paper.
 */
async function saveAnswerToPaper(
  kind: "highlight" | "note",
  payload: { question: string; answer: string; pageLabel: string }
): Promise<string> {
  const reader = currentReader();
  if (!reader) return "No open PDF";

  if (kind === "note") {
    const home = homeItemFor(reader);
    if (!home) return "No active item";
    const html = answerToNoteHtml(payload.answer, {
      question: payload.question,
      pageLabel: payload.pageLabel,
      selection: selectedTextNow()
    });
    const result = await saveAnswerAsNote(home, html);
    return result.ok ? "Saved as note" : `Note failed: ${result.error}`;
  }

  const comment = payload.answer;
  // Existing highlight on this exact selection -> edit its comment instead of stacking a second one.
  const attachment = Zotero.Items.get(reader.itemID);
  const activeKey = existingHighlightKey(attachment);
  if (activeKey) {
    const edited = await addCommentToAnnotation(attachment, activeKey, comment);
    return edited.ok ? "Comment saved on the highlight" : `Highlight failed: ${edited.error}`;
  }

  const created = highlightSelection(comment);
  return created.ok ? "Highlighted + comment saved" : `Highlight failed: ${created.error}`;
}

/** The text the answer is about: live selection, else the tracker's fresh copy. */
function selectedTextNow(): string {
  try {
    const win = currentReader()?._iframeWindow?.wrappedJSObject;
    return String(
      win?.eval(`(() => {
        let view = window._reader && window._reader._lastView;
        let ranges = view && view._selectionRanges;
        if (ranges && ranges.length && !ranges[0].collapsed) {
          let live = ranges.map(r => String((r && r.text) || "")).filter(Boolean).join(" ");
          if (live) return live;
        }
        let stored = window.__zaaLastSelection;
        return stored && stored.text && Date.now() - stored.t < ${SELECTION_MAX_AGE_MS}
          ? String(stored.text)
          : "";
      })()`) || ""
    ).trim();
  } catch {
    return "";
  }
}

/** Key of the annotation already covering the current selection, if any. */
function existingHighlightKey(attachment: any): string {
  try {
    const text = selectedTextNow();
    if (!text) return "";
    for (const item of attachment?.getAnnotations?.() || []) {
      if (String(item?.annotationText || "").trim() === text) return String(item.key || "");
    }
  } catch {
    /* fall through: no match */
  }
  return "";
}

/**
 * Reader tabs restored from the last session mount their React toolbar before our
 * `renderToolbar` listener exists (`resource/reader/reader.js`: CustomSections dispatches
 * `customEvent` from a `useEffect`), so the listener never fires for them. Sweep the readers
 * already open at startup and retry briefly while their document mounts.
 * Returns true when a reader is not ready yet.
 */
function injectReader(reader: any): boolean {
  const win = reader?._iframeWindow?.wrappedJSObject;
  const doc = win?.document;
  if (!doc?.body) return true;
  if (doc.getElementById(BUTTON_ID)) return false;
  const host = doc.querySelector(".toolbar .end");
  if (!host) return true;
  renderToolbar({ doc, append: (el: any) => host.appendChild(el), reader });
  return false;
}

function injectOpenReaders(attempt = 0) {
  let pending = false;
  for (const reader of Zotero.Reader?._readers || []) {
    pending = injectReader(reader) || pending;
  }
  if (pending && attempt < 20) setTimeout(() => injectOpenReaders(attempt + 1), 1000);
}

/**
 * Clicking the panel moves focus out of the PDF document and the browser clears the live
 * selection, so remember the last non-empty one on the reader window instead.
 * ponytail: the listeners are installed by eval inside the reader window, so their function
 * refs never cross into chrome and cannot be removed on shutdown; shutdown flips
 * __zaaSelDisabled and clears the remembered text, and closing the tab frees the rest.
 */
function trackSelection(reader: any) {
  const win = reader?._iframeWindow?.wrappedJSObject;
  if (typeof win?.eval !== "function") return;
  try {
    win.eval(`(() => {
      if (window.__zaaSelTracked) return "1";
      window.__zaaSelTracked = "1";
      window.__zaaSelDisabled = false;
      const remember = (doc) => {
        try {
          if (doc.__zaaHooked) return;
          doc.__zaaHooked = true;
          doc.addEventListener("selectionchange", () => {
            if (window.__zaaSelDisabled) return;
            // Read BOTH tiers every time: the drift bug showed one tier can disagree with the
            // other, and the losing tier's value is the evidence.
            let rangesText = "";
            let view = window._reader && window._reader._lastView;
            try {
              let ranges = view && view._selectionRanges;
              if (ranges && ranges.length && !ranges[0].collapsed) {
                rangesText = ranges.map(r => String((r && r.text) || "")).filter(Boolean).join(" ");
              }
            } catch (e) {}
            let domText = "";
            try {
              domText = String((doc.defaultView || window).getSelection() || "");
            } catch (e) {}
            // Prefer Zotero's own range text: it is what a highlight would store, and it stays
            // correct for the last selection even after the DOM selection collapses.
            let text = rangesText || domText;
            let src = rangesText ? "ranges" : (domText ? (doc === document ? "dom-outer" : "dom-inner") : "");
            if (text) {
              window.__zaaLastSelection = { text, t: Date.now() };
              // Clicking the panel clears _selectionRanges, and a highlight cannot be built
              // without position/sortIndex. Snapshot the full annotation JSON while the ranges
              // are still live, so the save buttons work on the text the user actually selected.
              if (src === "ranges") {
                try {
                  let ann = view._getAnnotationFromSelectionRanges(view._selectionRanges, "highlight", "#ffd400");
                  if (ann && ann.position && ann.sortIndex) {
                    window.__zaaLastAnnotation = { ann, t: Date.now() };
                  }
                } catch (e) {}
              }
              // Bounded evidence trail: a live selection bug is invisible without it.
              let log = window.__zaaSelLog || [];
              let entry = { src, text: String(text).slice(0, 80), t: Date.now() };
              let norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
              if (rangesText && domText && norm(rangesText) !== norm(domText)) {
                entry.rt = norm(rangesText).slice(0, 80);
                entry.dt = norm(domText).slice(0, 80);
              }
              log.push(entry);
              window.__zaaSelLog = log.slice(-20);
            }
          });
        } catch (e) {}
      };
      const hookIframes = () => {
        // The PDF text layer lives in a nested viewer iframe (pdf/web/viewer.html); selection
        // events fire on ITS document, and the document is replaced when the iframe loads.
        for (const frame of document.querySelectorAll("iframe")) {
          try {
            if (!frame.__zaaWatched) {
              frame.__zaaWatched = true;
              frame.addEventListener("load", () => {
                try { remember(frame.contentDocument); } catch (e) {}
              });
            }
            const d = frame.contentDocument;
            if (d && d.readyState === "complete") remember(d);
          } catch (e) {}
        }
      };
      remember(document);
      hookIframes();
      // The viewer iframe may be created after renderToolbar; watch for late additions.
      try {
        new MutationObserver(hookIframes).observe(document.documentElement, { childList: true, subtree: true });
      } catch (e) {}
      return "1";
    })()`);
  } catch {}
}

/** Streams an answer for the panel through the same live session the bridge serves. */
async function askLive(
  question: string,
  onChunk: (delta: string) => void,
  highlightKey?: string,
  useExternalSources?: boolean,
  cancelToken?: { cancelled: boolean }
) {
  const session = await bridgeServer!.getSession();
  return answerFromSession(
    session,
    question,
    chatDeps(),
    onChunk,
    {
      highlightKey,
      language: answerLanguage(),
      style: "explain",
      contextChars: contextChars(),
      cancelToken,
      // The per-question checkbox wins; the pref decides whether sources are offered at all.
      useExternalSources: !!useExternalSources && externalSourcesEnabled()
    }
  );
}

export async function startup({ id, version, rootURI, resourceURI }: any, reason: number) {
  Zotero.debug(`[Zotero-AI-Agent] Starting extension ${id} v${version}`);

  prefPane({ pluginID: id, rootURI: rootURI || resourceURI?.spec || "" });
  for (const win of Zotero.getMainWindows?.() || []) addToolsMenuItem(win);

  bridgeServer = new AgentBridgeServer();
  // Blank token = unauthenticated, which is the current loopback-only behaviour.
  bridgeServer.setAuthToken(Zotero.Prefs.get(PREF_BRIDGE_TOKEN, true));

  // Live read per request: the provider runs on every call, so no state needs tearing down.
  bridgeServer.setSessionProvider(() => getReaderContext());
  bridgeServer.setAnswerer((session, question, options) =>
    answerFromSession(
      session,
      question,
      chatDeps(),
      undefined,
      {
        ...options,
        language: options?.language || answerLanguage(),
        style: options?.style || "explain",
        contextChars: contextChars()
      }
    )
  );

  // Zotero's internal server dispatches endpoints by init() arity: one parameter receives
  // { method, pathname, searchParams, headers, data } and may return [status, contentType,
  // body]. A zero-parameter init() falls into the 3-arg branch and its return is discarded
  // (zotero server.js:489-505).
  if (typeof Zotero.Server !== "undefined" && Zotero.Server.Endpoints) {
    activeEndpoint = class {
      supportedMethods = ["GET"];

      async init(request: any) {
        const result = await bridgeServer!.handleRequest(ACTIVE_SESSION_PATH, request);
        return asResponse(result);
      }
    };
    Zotero.Server.Endpoints[ACTIVE_SESSION_PATH] = activeEndpoint;


    chatEndpoint = class {
      supportedMethods = ["POST"];

      async init(request: any) {
        return asResponse(await bridgeServer!.handleRequest(CHAT_PATH, request));
      }
    };
    Zotero.Server.Endpoints[CHAT_PATH] = chatEndpoint;
  }

  if (Zotero.Reader && typeof Zotero.Reader.registerEventListener === "function") {
    toolbarHandler = renderToolbar;
    Zotero.Reader.registerEventListener(TOOLBAR_EVENT, toolbarHandler, PLUGIN_ID);
    injectOpenReaders();
  }
}

export function shutdown({ id, version }: any, reason: number) {
  Zotero.debug(`[Zotero-AI-Agent] Shutting down extension ${id} v${version}`);

  if (activeEndpoint && typeof Zotero.Server !== "undefined" && Zotero.Server.Endpoints) {
    delete Zotero.Server.Endpoints[ACTIVE_SESSION_PATH];
    activeEndpoint = null;
  }

  if (chatEndpoint && typeof Zotero.Server !== "undefined" && Zotero.Server.Endpoints) {
    delete Zotero.Server.Endpoints[CHAT_PATH];
    chatEndpoint = null;
  }

  // Zotero's own unregisterEventListener filter is inverted (xpcom/reader.js:1582 keeps only the
  // matching entry, dropping every other plugin's listeners), so drop ours by plugin ID instead.
  if (toolbarHandler && Zotero.Reader) {
    if (typeof Zotero.Reader._unregisterEventListenerByPluginID === "function") {
      Zotero.Reader._unregisterEventListenerByPluginID(PLUGIN_ID);
    } else if (typeof Zotero.Reader.unregisterEventListener === "function") {
      Zotero.Reader.unregisterEventListener(TOOLBAR_EVENT, toolbarHandler);
    }
    toolbarHandler = null;
  }

  // Panel and button live inside reader documents; removing them keeps re-enable clean.
  for (const reader of Zotero.Reader?._readers || []) {
    const win = reader?._iframeWindow?.wrappedJSObject;
    const doc = win?.document;
    if (!doc) continue;
    doc.getElementById(PANEL_ID)?.remove();
    doc.getElementById(BUTTON_ID)?.remove();
    // Selection listeners can't be detached from chrome (see trackSelection) — neutralize them.
    try { win.eval("window.__zaaSelDisabled = true; window.__zaaLastSelection = null; window.__zaaSelLog = [];"); } catch {}
  }

  for (const win of Zotero.getMainWindows?.() || []) removeToolsMenuItem(win);

  if (bridgeServer) {
    bridgeServer.clearSession();
    bridgeServer = null;
  }
}

export function install(data: any, reason: number) {
  Zotero.debug("[Zotero-AI-Agent] Installed");
}

export function uninstall(data: any, reason: number) {
  Zotero.debug("[Zotero-AI-Agent] Uninstalled");
}

// Zotero loads bootstrap.js as a classic script into a Cu.Sandbox and resolves lifecycle
// methods off that sandbox scope (`scope[method]` in plugins.js). A bundled ESM entry keeps
// its declarations inside the module wrapper, so publish them on the global explicitly.
const scope = globalThis as any;
Object.assign(scope, { startup, shutdown, install, uninstall, onMainWindowLoad, onMainWindowUnload });