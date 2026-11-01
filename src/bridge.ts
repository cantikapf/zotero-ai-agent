/**
 * Local Agent Bridge for Hermes Agent and External AI Harnesses.
 * Mounts lightweight JSON endpoints to allow external tools to inspect the active Zotero reading session.
 */

export const ACTIVE_SESSION_PATH = "/agent-bridge/active";
export const CHAT_PATH = "/agent-bridge/chat";

/** Supplies the session for each request; sync or async. */
export type SessionProvider = () =>
  | ActiveReadingSession
  | null
  | Promise<ActiveReadingSession | null>;

/** Answers a question from the live session; injected so the route stays testable offline. */
export type Answerer = (
  session: ActiveReadingSession | null,
  question: string,
  options?: {
    highlightKey?: string;
    language?: string;
    style?: "explain" | "brief";
    useExternalSources?: boolean;
  }
) => Promise<{
  answer: string;
  pageNumber: number;
  model: string;
  sources?: { index: number; title: string; url: string; doi: string }[];
}>;

export interface ActiveReadingSession {
  itemKey: string;
  attachmentKey: string;
  title: string;
  authors: string[];
  publicationYear?: number;
  activePage: number;
  totalPages: number;
  selectedText: string;
  /** Text of the page the user is on, from PDF.js getPageData({ pageIndex }) chars.map(c => c.c). */
  pageText: string;
  /** Highlight annotations on the open attachment; empty when the user has none. */
  highlights?: { key: string; text: string; comment?: string; pageLabel?: string }[];
  /** Which tier produced `selectedText` (ranges | dom-outer | dom-inner | remembered). */
  selectionSource?: string;
  /** Recent selection events, for diagnosing selection problems against the live app. */
  selectionLog?: Array<{ src: string; text: string; t: number }>;
  timestamp: string;
}

export class AgentBridgeServer {
  private activeSession: ActiveReadingSession | null = null;
  private isListening = false;
  private sessionProvider: SessionProvider | null = null;
  private answerer: Answerer | null = null;
  /** Opt-in bearer token. Empty = unauthenticated (the localhost-only default). */
  private authToken = "";

  /** Reads live state per request instead of a cached copy (no reader listener to tear down). */
  public setSessionProvider(provider: SessionProvider) {
    this.sessionProvider = provider;
  }

  public setAnswerer(answerer: Answerer) {
    this.answerer = answerer;
  }

  /** Read per startup from `extensions.zotero-ai-agent.bridgeToken`; blank disables auth. */
  public setAuthToken(token: string | undefined | null) {
    this.authToken = String(token || "").trim();
  }

  /**
   * 401 unless the request carries an `Authorization: Bearer` header matching the configured
   * token (header names arrive lowercased from xpcom/server/server.js:9861).
   * ponytail: plain comparison, not constant-time — the token only guards a loopback port that
   * Zotero already restricts to 127.0.0.1/localhost Host headers (xpcom/server/server.js:10360).
   */
  private authorized(request?: { headers?: any }): boolean {
    if (!this.authToken) return true;
    const raw = request?.headers?.authorization ?? request?.headers?.Authorization ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
    return !!match && match[1].trim() === this.authToken;
  }

  public updateSession(session: Partial<ActiveReadingSession>) {
    if (!this.activeSession) {
      this.activeSession = {
        itemKey: "",
        attachmentKey: "",
        title: "",
        authors: [],
        activePage: 1,
        totalPages: 1,
        selectedText: "",
        pageText: "",
        timestamp: new Date().toISOString(),
        ...session
      };
    } else {
      this.activeSession = {
        ...this.activeSession,
        ...session,
        timestamp: new Date().toISOString()
      };
    }
  }

  public async getSession(): Promise<ActiveReadingSession | null> {
    if (this.sessionProvider) {
      try {
        return (await this.sessionProvider()) ?? null;
      } catch {
        return null;
      }
    }
    return this.activeSession;
  }

  public clearSession() {
    this.activeSession = null;
  }

  /**
   * Serializes current state to JSON-RPC or REST response format for Hermes Agent.
   */
  public async handleRequest(
    path: string,
    request?: { method?: string; headers?: any; data?: any }
  ): Promise<{ status: number; body: any }> {
    if ((path === ACTIVE_SESSION_PATH || path === CHAT_PATH) && !this.authorized(request)) {
      return { status: 401, body: { error: "Missing or invalid bridge token" } };
    }

    if (path === ACTIVE_SESSION_PATH) {
      const session = await this.getSession();
      if (!session) {
        return {
          status: 404,
          body: { error: "No active PDF reader session in Zotero." }
        };
      }
      return {
        status: 200,
        body: session
      };
    }

    if (path === CHAT_PATH) {
      if (!this.answerer) {
        return { status: 503, body: { error: "Chat is not wired up yet." } };
      }
      // Accept a JSON object body; Zotero hands the parsed object over as `data`.
      const payload = typeof request?.data === "string" ? safeJson(request.data) : request?.data;
      const question = typeof payload?.question === "string" ? payload.question : "";
      const options = {
        highlightKey: typeof payload?.highlightKey === "string" ? payload.highlightKey : undefined,
        language: typeof payload?.language === "string" ? payload.language : undefined,
        style: payload?.style === "brief" ? ("brief" as const) : undefined,
        // Opt-in per request: external lookups cost a network call, so a caller must ask.
        useExternalSources: payload?.useExternalSources === true
      };
      try {
        const answer = await this.answerer(await this.getSession(), question, options);
        return { status: 200, body: answer };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // 400 for caller mistakes (no paper, no question, unknown highlight), 502 for the gateway.
        const status = /No active paper|Missing question|Highlight not found/.test(message) ? 400 : 502;
        return { status, body: { error: message } };
      }
    }

    return {
      status: 404,
      body: { error: "Route not found" }
    };
  }
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
