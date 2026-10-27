# Zotero AI Agent 📚⚡

> Ultra-Lightweight, Resource-Efficient AI Agent Plugin for Zotero 7.  
> Discuss papers with local LLMs (via 9router), bridge with external agent harnesses (Hermes Agent), and seamlessly export discussion insights to Obsidian (ZotLit protocol).

---

## 🌟 Highlights & Philosophy

- **Ultra-Lightweight & Zero-Waste**: Consumes `< 30 MB` RAM in Zotero with `< 1%` CPU overhead.
- **No Local Vector DB / Heavy Embeddings**: Eliminates heavy Python/PyTorch dependencies. Leverages Zotero's native SQLite FTS and document Table of Contents for targeted section jumping.
- **Lazy Viewport-Driven Context**: Dynamically injects only the active page, user selections, and highlights (< 2.000 tokens) to minimize KV-cache overhead in 9router.
- **External Agent Bridge (Hermes Agent)**: Exposes a lightweight local REST bridge so external orchestrators like Hermes can read what paper you are currently viewing and inject annotations.
- **ZotLit & Obsidian Synergy**: Syncs discussion notes to your Obsidian vault using standard deep links (`zotero://open-pdf/...`) and ZotLit-compatible metadata (`zt-item-key`).

---

## 🏗️ Architecture

```
┌────────────────────────────────────────────────────────┐
│                      ZOTERO 7                          │
│                                                        │
│  ┌────────────────────────┐  ┌───────────────────────┐ │
│  │ In-Reader Sidebar Chat │  │ Local Agent Bridge    │ │
│  │ (Streaming DOM View)   │  │ (Port 23119 / HTTP)   │ │
│  └───────────┬────────────┘  └───────────┬───────────┘ │
│              │ Context                   │ JSON-RPC    │
│              │ (< 2k tokens)             │             │
└──────────────┼───────────────────────────┼─────────────┘
               │                           │
               ▼                           ▼
┌────────────────────────┐       ┌───────────────────────┐
│ 9router (Local LLM)    │       │ Hermes Agent Harness  │
│ OpenAI-compatible API  │       │ (External AI Worker)  │
└────────────────────────┘       └───────────┬───────────┘
                                             │ Auto-write notes
                                             ▼
                                 ┌───────────────────────┐
                                 │ Obsidian (via ZotLit) │
                                 │ Vault: Literature/    │
                                 └───────────────────────┘
```

---

## 🛠️ Tech Stack & Directory Structure

- **Language**: TypeScript / ES Modules
- **Target Platform**: Zotero 7 (Gecko 115+ / WebExtensions & XPCOM)
- **Local LLM Engine**: 9router (OpenAI-compatible `/v1/chat/completions`)
- **Note Integration**: Obsidian + ZotLit Protocol

```
zotero-ai-agent/
├── HERMES.md               # Operating System Guidelines & 5-Step Loop
├── PROJECT.md              # Roadmap & State Machine (Gate 1 -> Gate 3)
├── README.md               # Project documentation
├── package.json            # Node.js dependencies & build scripts
├── tsconfig.json           # TypeScript configuration for Zotero 7
├── manifest.json           # Zotero 7 WebExtension manifest
├── src/
│   ├── bootstrap.ts        # Zotero plugin lifecycle (startup/shutdown)
│   ├── reader.ts           # PDF Reader hook (active page, selection, annotations)
│   ├── llm.ts              # Streaming LLM client for 9router (zero-buffer)
│   ├── bridge.ts           # Local HTTP endpoint for Hermes Agent
│   └── zotlit.ts           # Markdown export formatter with ZotLit URI anchors
└── tests/
    └── test_protocol.test.js # Core protocol & context window tests
```

---

## ⚡ Quick Start & Development

```bash
# 1. Install dependencies
npm install

# 2. Run unit tests
npm test

# 3. Build add-on package
npm run build
```

### Configuring with 9router
In Zotero, navigate to **Settings → Zotero AI Agent**:
1. **API Base URL**: `http://localhost:8080/v1` (or your active 9router port).
2. **Model Name**: Select your active local model (e.g. `ag/gemini-3.8-flash` or local GGUF).
3. **Context Mode**: `Viewport + Selection` (Default, recommended for minimum memory usage).
