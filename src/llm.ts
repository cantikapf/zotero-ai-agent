/**
 * Ultra-Lightweight Streaming LLM Client for 9router / OpenAI-compatible API.
 * Designed for Zotero 7: Zero heavy dependencies, streaming directly to callback, minimal RAM footprint.
 */

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMConfig {
  baseUrl: string; // e.g. "http://127.0.0.1:20128/v1"
  model: string;   // e.g. "ag/gemini-3.8-flash"
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
}

/** Approximate token budget for injected context (~4 chars/token). */
export const MAX_CONTEXT_CHARS = 8000;

export const DEFAULT_CONFIG: LLMConfig = {
  // 9router on this machine serves 20128; 8080 is not listening. Override via Zotero.Prefs.
  baseUrl: "http://127.0.0.1:20128/v1",
  model: "ag/gemini-3.8-flash",
  maxTokens: 1024,
  temperature: 0.2
};

/**
 * Builds minimal viewport context (< 2,000 tokens) to avoid KV cache explosion in 9router.
 */
export function buildViewportPrompt(params: {
  title: string;
  pageNumber: number;
  viewportText: string;
  selectedText?: string;
  userQuestion: string;
  /** Specific highlight the question is about (from Zotero annotations, not the DOM selection). */
  highlight?: { text: string; comment?: string; pageLabel?: string };
  /** Answer language, e.g. "Indonesian". Defaults to English. */
  language?: string;
  /** "explain" (default) teaches the concept; "brief" is a one-paragraph answer. */
  style?: "explain" | "brief";
  /** Total context character budget (pref `contextChars`); defaults to MAX_CONTEXT_CHARS. */
  contextChars?: number;
  /** DOI-validated external references; the model may only cite these, by number. */
  externalSources?: string[];
}): LLMMessage[] {
  const cap = (text: string, budget: number) =>
    text.length <= budget ? text.trim() : `${text.slice(0, budget).trim()}\n[... truncated at ${budget} chars]`;

  const language = params.language || "English";
  const style = params.style || "explain";

  const systemPrompt = [
    "You are an expert academic research assistant embedded inside Zotero 7.",
    "Answer the user's inquiry based strictly on the provided paper excerpts.",
    `Answer language: ${language}. Write the prose in ${language}, keeping technical terms, ` +
      "quoted phrases and citations in their original wording.",
    "Rules:",
    "1. Cite the exact page number for every claim.",
    "2. If the answer cannot be deduced from the excerpt, state it honestly without fabricating.",
    "3. Keep responses structured, concise, and academically rigorous.",
    "4. Format in Markdown: short paragraphs, **bold** for key terms, \"- \" bullets only when " +
      "you are listing items. Never open with a bare list of phrases.",
    style === "explain"
      ? "5. Explain, do not just enumerate. Unpack the concept in your own words, say what it " +
        "does in the paper's argument, and where the excerpt is thin about it, say so."
      : "5. Answer in one short paragraph."
  ];

  // External references are numbered by us, not by the model: it may only cite indices from this
  // list, and the bibliography is rendered from the same records, so a fabricated citation cannot
  // reach the user.
  if (params.externalSources && params.externalSources.length) {
    systemPrompt.push(
      "6. A list of DOI-validated external references is provided as [E1], [E2], ... They are " +
        "not all journal articles: each carries a kind tag such as [paper], [report], [standard], " +
        "[dataset] or [web page]. Use whatever is relevant, and name the kind when it matters " +
        "(e.g. 'an OECD report [E3]').",
      "7. Cite an external reference only as [E1], [E2], ... matching that list. Never invent a " +
        "reference, author, year, DOI or URL, and never cite an index that is not in the list. " +
        "Never substitute a blog, forum thread or opinion piece for the list: if it is not listed, " +
        "it does not exist for citation purposes.",
      "8. Keep external material clearly secondary: state what THIS paper says first, then what " +
        "the external literature adds. If the external list does not cover the point, say so " +
        "instead of forcing a citation."
    );
  }

  const systemPromptText = systemPrompt.join("\n");

  const contextChars = Math.min(
    Math.max(Math.floor(params.contextChars || MAX_CONTEXT_CHARS), 1000),
    200000
  );
  const selectionBudget = Math.min(1500, Math.floor(contextChars / 4));
  const contextSegments: string[] = [
    `Paper Title: "${params.title}"`,
    `Active Page: ${params.pageNumber}`,
    `Page Excerpt:\n"""\n${cap(params.viewportText, contextChars - selectionBudget)}\n"""`
  ];

  if (params.selectedText && params.selectedText.trim()) {
    contextSegments.push(
      `User Highlighted Selection:\n"""\n${cap(params.selectedText, selectionBudget)}\n"""`
    );
  }

  if (params.highlight && params.highlight.text.trim()) {
    const label = params.highlight.pageLabel ? ` (user's page label ${params.highlight.pageLabel})` : "";
    const note = params.highlight.comment ? `\nUser's own note on this highlight: "${params.highlight.comment}"` : "";
    contextSegments.push(
      `Highlight the question is about${label}:\n"""\n${cap(params.highlight.text, selectionBudget)}\n"""${note}`
    );
  }

  if (params.externalSources && params.externalSources.length) {
    contextSegments.push(
      "External references (DOI-validated, cite as [E1], [E2], ...):\n" +
        params.externalSources.map((line, i) => `[E${i + 1}] ${line}`).join("\n")
    );
  }

  const userContent = `${contextSegments.join("\n\n")}\n\nQuestion: ${params.userQuestion}`;

  return [
    { role: "system", content: systemPromptText },
    { role: "user", content: userContent }
  ];
}

/**
 * Streams LLM completion tokens via Server-Sent Events (SSE) without large string buffering.
 */
export async function streamChatCompletion(
  messages: LLMMessage[],
  config: LLMConfig = DEFAULT_CONFIG,
  onChunk: (delta: string) => void,
  signal?: AbortSignal,
  /** ponytail: off by default so the stream is not buffered; pass true when the caller needs
   *  the assembled answer (e.g. export). */
  collect = false
): Promise<string> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };

  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.model,
      messages,
      stream: true,
      max_tokens: config.maxTokens ?? 1024,
      temperature: config.temperature ?? 0.2
    }),
    signal
  });

  if (!response.ok) {
    // Diagnostics stay non-secret: which endpoint, which model, whether auth was attached.
    const auth = headers["Authorization"] ? "attached" : "missing";
    throw new Error(
      `LLM Error ${response.status}: ${response.statusText} [url=${url} model=${config.model} auth=${auth}]`
    );
  }

  if (!response.body) {
    throw new Error("Response body is null or streaming is unsupported");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let fullOutput = "";
  let buffer = "";
  let finished = false;

  while (!finished) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const dataStr = trimmed.slice(5).trim();
      if (dataStr === "[DONE]") {
        finished = true;
        break;
      }

      try {
        const parsed = JSON.parse(dataStr);
        const delta = parsed.choices?.[0]?.delta?.content || "";
        if (delta) {
          if (collect) fullOutput += delta;
          onChunk(delta);
        }
      } catch {
        // partial json chunk ignored until line completes
      }
    }
  }

  try {
    await reader.cancel();
  } catch {
    // stream already closed
  }

  return collect ? fullOutput : "";
}
