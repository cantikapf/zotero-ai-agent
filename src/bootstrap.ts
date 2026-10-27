/**
 * Zotero 7 Extension Bootstrap Lifecycle.
 * Follows modern Zotero 7 WebExtension / XPCOM hybrid specification.
 */

import { AgentBridgeServer } from "./bridge.js";

declare const Zotero: any;

let bridgeServer: AgentBridgeServer | null = null;

export async function startup({ id, version, rootURI }: any, reason: number) {
  Zotero.debug(`[Zotero-AI-Agent] Starting extension ${id} v${version}`);

  bridgeServer = new AgentBridgeServer();

  // Register internal bridge endpoint if Zotero.Server exists
  if (typeof Zotero.Server !== "undefined" && Zotero.Server.Endpoints) {
    Zotero.Server.Endpoints["/agent-bridge/active"] = class {
      public init() {
        const session = bridgeServer?.getSession();
        if (!session) {
          return [404, "application/json", JSON.stringify({ error: "No active paper in reader" })];
        }
        return [200, "application/json", JSON.stringify(session)];
      }
    };
  }

  // Hook into reader active tab notifications
  if (Zotero.Reader) {
    Zotero.Reader.registerEventListener("renderProcessCreated", () => {
      Zotero.debug("[Zotero-AI-Agent] Reader renderProcessCreated");
    });
  }
}

export function shutdown({ id, version }: any, reason: number) {
  Zotero.debug(`[Zotero-AI-Agent] Shutting down extension ${id} v${version}`);

  if (typeof Zotero.Server !== "undefined" && Zotero.Server.Endpoints) {
    delete Zotero.Server.Endpoints["/agent-bridge/active"];
  }

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
