/**
 * Local Agent Bridge for Hermes Agent and External AI Harnesses.
 * Mounts lightweight JSON endpoints to allow external tools to inspect the active Zotero reading session.
 */

export interface ActiveReadingSession {
  itemKey: string;
  attachmentKey: string;
  title: string;
  authors: string[];
  publicationYear?: number;
  activePage: number;
  totalPages: number;
  selectedText: string;
  timestamp: string;
}

export class AgentBridgeServer {
  private activeSession: ActiveReadingSession | null = null;
  private isListening = false;

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

  public getSession(): ActiveReadingSession | null {
    return this.activeSession;
  }

  public clearSession() {
    this.activeSession = null;
  }

  /**
   * Serializes current state to JSON-RPC or REST response format for Hermes Agent.
   */
  public handleRequest(path: string): { status: number; body: any } {
    if (path === "/agent/active" || path === "/agent-bridge/active") {
      if (!this.activeSession) {
        return {
          status: 404,
          body: { error: "No active PDF reader session in Zotero." }
        };
      }
      return {
        status: 200,
        body: this.activeSession
      };
    }

    return {
      status: 404,
      body: { error: "Route not found" }
    };
  }
}
