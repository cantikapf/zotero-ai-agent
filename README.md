# Zotero AI Agent 📚⚡

> Ultra-Lightweight, Resource-Efficient AI Agent Plugin for Zotero 7 (Architectural Scaffold & Early Planning).  
> Designed to enable contextual discussions with papers in the reader, connect to LLM gateways (such as `9router`), provide an opt-in read-only bridge for external harnesses (**Hermes Agent**), and export discussion insights to Obsidian (compatible with the **ZotLit** ecosystem).

> **Status**: Early Architectural Scaffold (Gate 1 Reopened). Not yet a functioning Zotero 7 plugin.

---

## 🌟 Highlights & Target Goals

- **Target Lightweight Footprint**: Targets `< 30 MB` RAM overhead in Zotero and `< 1%` idle CPU (empirical benchmark targets, to be validated via profiling tools).
- **No Local Vector DB / Heavy Embeddings**: Eliminates local PyTorch/ChromaDB overhead. Leverages Zotero native SQLite FTS and document Table of Contents.
- **Lazy Viewport-Driven Context**: Dynamically injects active page text and user selections (< 2,000 tokens target) to the LLM gateway (`9router`).
- **External Agent Bridge (Proposed)**: Proposed local HTTP bridge (`GET /agent-bridge/active`, opt-in auth token) allowing external harnesses like Hermes Agent to inspect active paper metadata. Future write capabilities (`POST /agent-bridge/annotate`) deferred pending explicit consent/idempotency controls.
- **ZotLit & Obsidian Synergy**: Formats discussion notes for Obsidian using standard deep links (`zotero://open-pdf/...`) and ZotLit v2 metadata (`zotero-key`; `zt-item-key` is an internal @zotlit/db name, not a frontmatter key).

---

## 🏗️ Architecture (Proposed)

```
┌────────────────────────────────────────────────────────┐
│                      ZOTERO 7                          │
│                                                        │
│  ┌────────────────────────┐  ┌───────────────────────┐ │
│  │ In-Reader Sidebar Chat │  │ Local Agent Bridge    │ │
│  │ (Streaming DOM View)   │  │ (Port 23119 / 23125)  │ │
│  └───────────┬────────────┘  └───────────┬───────────┘ │
│              │ Context                   │ JSON HTTP   │
│              │ (< 2k tokens)             │ (Opt-in)    │
└──────────────┼───────────────────────────┼─────────────┘
               │                           │
               ▼                           ▼
┌────────────────────────┐       ┌───────────────────────┐
│ 9router Gateway        │       │ Hermes Agent Harness  │
│ (Local / Remote LLM)   │       │ (External AI Worker)  │
└────────────────────────┘       └───────────┬───────────┘
                                             │ Export / Notes
                                             ▼
                                 ┌───────────────────────┐
                                 │ Obsidian (via ZotLit) │
                                 │ Literature Vault      │
                                 └───────────────────────┘
```

---

## 🛠️ Tech Stack & Directory Structure

- **Language**: TypeScript / ES Modules
- **Target Platform**: Zotero 7 (Gecko 115+ / WebExtensions & XPCOM)
- **LLM Gateway**: 9router (OpenAI-compatible `/v1/chat/completions`)
- **Note Integration**: Obsidian + ZotLit Protocol
- **Test Runner**: Node.js 24 native test runner (`node --experimental-strip-types --test`)

```
zotero-ai-agent/
├── HERMES.md               # Operating System Guidelines & 5-Step Loop
├── PROJECT.md              # Roadmap & State Machine (Gate 1 Reopened -> Gate 3)
├── IDEA.md                 # Ideation & architectural specifications
├── README.md               # Project overview and baseline status
├── package.json            # Node.js dependencies & scripts
├── tsconfig.json           # TypeScript configuration
├── manifest.json           # Zotero 7 WebExtension manifest
├── src/
│   ├── bootstrap.ts        # Zotero plugin lifecycle (startup/shutdown scaffold)
│   ├── bridge.ts           # Local bridge state and endpoint handler scaffold
│   ├── llm.ts              # Streaming LLM client scaffold
│   ├── zotlit.ts           # ZotLit/Obsidian export: frontmatter, deep links, append
│   ├── annotate.ts         # Writes answers back as highlights / child notes
│   ├── sources.ts          # Crossref + DataCite DOI-validated references
│   ├── ui.ts               # Reader chat panel and toolbar button
│   ├── markdown.ts         # Escaped Markdown -> HTML for the panel
│   └── reader.ts           # Reader context extraction (page text, selection, highlights)
├── tests/
│   └── test_core.test.js   # Core unit tests (3 baseline assertions)
└── scripts/
    └── build.js            # (Planned in Gate 1: Build & XPI packager)
```

---

## ⚡ Development & Baseline Verification

```bash
# 1. Run baseline unit tests (Currently passing 3 assertions)
npm test

# 2. Typecheck (Requires devDependencies installed via npm install)
npm run typecheck

# 3. Build add-on package (Currently failing: scripts/build.js under development)
npm run build
```

### Planned Configuration & Preferences
Settings UI and configuration hooks (`Zotero.Prefs`) are scheduled for implementation in Gate 2:
- **API Base URL**: Configurable endpoint for 9router / OpenAI-compatible server, read from `Zotero.Prefs` (on this machine 9router serves `http://127.0.0.1:20128/v1`; port `8080` is not listening).
- **Model Selection**: Model identifier (e.g. `ag/gemini-3.8-flash` or local weights).
- **Bridge Auth**: Token configuration for external Hermes Agent read-only access.
- **Context Boundaries**: Viewport selection and token caps (< 2,000 tokens).
