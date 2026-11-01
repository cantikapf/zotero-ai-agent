/**
 * Single-paper Q&A over the active reader page.
 * Non-mutating: it reads the live session and calls the LLM gateway, nothing is written back to
 * the Zotero library, so it carries none of the consent/idempotency burden of a write endpoint.
 */

import type { LLMConfig, LLMMessage } from "./llm.js";
import type { ActiveReadingSession } from "./bridge.js";
import {
  bibliographyMarkdown,
  citationListMarkdown,
  citedReferences,
  formatSource,
  parseBibliography,
  resolveCitations,
  toSearchQuery
} from "./sources.ts";
import type { ExternalSource } from "./sources.ts";

export interface ChatOptions {
  /** Key of the highlight annotation the question is about. */
  highlightKey?: string;
  language?: string;
  style?: "explain" | "brief";
  /** Context character budget from the `contextChars` pref. */
  contextChars?: number;
  /** Opt-in: look up DOI-validated references to supplement the paper's own text. */
  useExternalSources?: boolean;
}

export interface ChatDeps {
  buildViewportPrompt: (params: {
    title: string;
    pageNumber: number;
    viewportText: string;
    selectedText?: string;
    userQuestion: string;
    highlight?: { text: string; comment?: string; pageLabel?: string };
    language?: string;
    style?: "explain" | "brief";
    contextChars?: number;
    externalSources?: string[];
  }) => LLMMessage[];
  streamChatCompletion: (
    messages: LLMMessage[],
    config: LLMConfig,
    onChunk: (delta: string) => void,
    signal: AbortSignal | undefined,
    collect: boolean
  ) => Promise<string>;
  config: LLMConfig;
  /** Crossref lookup, injected so tests stay offline. Resolves to [] when disabled or offline. */
  findSources?: (query: string) => Promise<ExternalSource[]>;
  /**
   * Full text of the open attachment, read from Zotero's own full-text cache. The paper's reference
   * list lives there, so the author-year citations the answer inherits from the paper can be
   * resolved to real entries instead of being dead names. Undefined or empty = no list shown.
   */
  readFullText?: () => Promise<string>;
}

export interface ChatAnswer {
  answer: string;
  pageNumber: number;
  model: string;
  /** DOI-validated references the answer may cite; empty when the lookup was off or found nothing. */
  sources?: ExternalSource[];
  /** Entries of the paper's own reference list that the answer cites, quoted verbatim. */
  references?: string[];
}

export async function answerFromSession(
  session: ActiveReadingSession | null,
  question: string,
  deps: ChatDeps,
  onChunk: (delta: string) => void = () => {},
  options: ChatOptions = {}
): Promise<ChatAnswer> {
  if (!session) throw new Error("No active paper in reader");
  const highlight = options.highlightKey
    ? (session.highlights || []).find((h) => h.key === options.highlightKey)
    : undefined;
  if (options.highlightKey && !highlight) throw new Error("Highlight not found in this paper");

  // A highlight question needs no typed question: "explain this" is the implicit ask.
  const asked =
    (question || "").trim() || (highlight ? "Explain this highlighted passage and why it matters here." : "");
  if (!asked) throw new Error("Missing question");

  // Look up DOI-validated references before building the prompt, so the model can cite them by
  // number. Off by default; a failure here must never block the paper's own answer.
  let sources: ExternalSource[] = [];
  if (options.useExternalSources && deps.findSources) {
    const query = toSearchQuery(session.selectedText || highlight?.text || asked);
    try {
      sources = await deps.findSources(query);
    } catch {
      sources = [];
    }
  }

  const messages = deps.buildViewportPrompt({
    title: session.title,
    pageNumber: session.activePage,
    viewportText: session.pageText,
    selectedText: session.selectedText,
    userQuestion: asked,
    highlight: highlight
      ? { text: highlight.text, comment: highlight.comment, pageLabel: highlight.pageLabel }
      : undefined,
    language: options.language,
    style: options.style,
    contextChars: options.contextChars,
    externalSources: sources.length ? sources.map(formatSource) : undefined
  });

  // collect = true so the caller also gets the assembled answer (the HTTP route returns one body,
  // the reader panel shows the stream).
  const raw = await deps.streamChatCompletion(messages, deps.config, onChunk, undefined, true);

  // Markers for references that do not exist are removed, and the bibliography is appended from
  // the records themselves. The streamed text already reached the panel, so the corrected version
  // is what the caller stores, saves and returns.
  const resolved = sources.length
    ? resolveCitations(raw, sources) + citationListMarkdown(sources)
    : resolveCitations(raw, []);

  // The answer inherits the paper's own author-year citations ("Buckley & Casson, 1976"), which a
  // reader cannot look up without the paper's reference list. Resolve them against that list when
  // Zotero already has the full text cached; a missing cache leaves the answer unchanged.
  let references: string[] = [];
  if (deps.readFullText) {
    try {
      const fullText = await deps.readFullText();
      if (fullText) references = citedReferences(resolved, parseBibliography(fullText));
    } catch {
      references = []; // the paper's own list is a bonus, never a reason to fail the answer
    }
  }
  const answer = resolved + bibliographyMarkdown(references);

  return {
    answer,
    pageNumber: session.activePage,
    model: deps.config.model,
    ...(sources.length ? { sources } : {}),
    ...(references.length ? { references } : {})
  };
}