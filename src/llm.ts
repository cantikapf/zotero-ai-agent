/**
 * Ultra-Lightweight Streaming LLM Client for 9router / OpenAI-compatible API.
 * Designed for Zotero 7: Zero heavy dependencies, streaming directly to callback, minimal RAM footprint.
 */

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMConfig {
  baseUrl: string; // e.g. "http://localhost:8080/v1"
  model: string;   // e.g. "ag/gemini-3.8-flash"
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
}

export const DEFAULT_CONFIG: LLMConfig = {
  baseUrl: "http://localhost:8080/v1",
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
}): LLMMessage[] {
  const systemPrompt = [
    "You are an expert academic research assistant embedded inside Zotero 7.",
    "Answer the user's inquiry based strictly on the provided paper excerpts.",
    "Rules:",
    "1. Cite the exact page number for every claim.",
    "2. If the answer cannot be deduced from the excerpt, state it honestly without fabricating.",
    "3. Keep responses structured, concise, and academically rigorous."
  ].join("\n");

  const contextSegments: string[] = [
    `Paper Title: "${params.title}"`,
    `Active Page: ${params.pageNumber}`,
    `Page Excerpt:\n"""\n${params.viewportText.trim()}\n"""`
  ];

  if (params.selectedText && params.selectedText.trim()) {
    contextSegments.push(`User Highlighted Selection:\n"""\n${params.selectedText.trim()}\n"""`);
  }

  const userContent = `${contextSegments.join("\n\n")}\n\nQuestion: ${params.userQuestion}`;

  return [
    { role: "system", content: systemPrompt },
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
  signal?: AbortSignal
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
    throw new Error(`LLM Error ${response.status}: ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error("Response body is null or streaming is unsupported");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let fullOutput = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const dataStr = trimmed.slice(5).trim();
      if (dataStr === "[DONE]") break;

      try {
        const parsed = JSON.parse(dataStr);
        const delta = parsed.choices?.[0]?.delta?.content || "";
        if (delta) {
          fullOutput += delta;
          onChunk(delta);
        }
      } catch {
        // partial json chunk ignored until line completes
      }
    }
  }

  return fullOutput;
}
