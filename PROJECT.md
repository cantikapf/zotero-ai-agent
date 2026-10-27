# PROJECT.md — Roadmap & State Machine

**Project**: `zotero-ai-agent`  
**Current Phase**: Gate 1 Complete → Transitioning to Gate 2 (Core MVP)  
**Last Updated**: October 2026

---

## 1. Phase Gates

### Gate 1: Spec & Architecture Validation
- [x] Reverse engineer `aidenlx/zotlit` protocol and reader notification system (`POST /notify`, `reader/active`).
- [x] Define resource-saving architecture: Zero Vector DB, native Zotero SQLite FTS, lazy viewport-driven context (< 2k tokens), and streaming DOM rendering.
- [x] Design local IPC bridge to external harnesses (Hermes Agent / HTTP endpoints).
- [x] Design Obsidian export contract with ZotLit frontmatter compatibility (`zt-item-key`).
- [x] Scaffold initial project repository structure with `HERMES.md`, `PROJECT.md`, `README.md`, `.gitignore`, `package.json`, `tsconfig.json`, and core source stubs.

### Gate 2: Core MVP Implementation (Zotero 7 Reader Chat)
- [ ] Implement `src/bootstrap.ts` lifecycle hooks (`startup`, `shutdown`) for Zotero 7.
- [ ] Implement Reader Hook (`src/reader.ts`) to capture active PDF attachment, current page number, and selected text.
- [ ] Build Ultra-Lightweight Streaming LLM Client (`src/llm.ts`) with custom OpenAI-compatible endpoint support (default: `9router` localhost).
- [ ] Build Custom Reader Sidebar Panel (`src/ui/sidebar.ts`) using native Zotero 7 DOM APIs with streaming text display and auto-scroll.
- [ ] Implement Single-Paper Q&A with automatic quote attribution and page number anchor.
- [ ] Add unit test suite covering protocol payloads, context window caps, and streaming parser.

### Gate 3: External Harness Bridge, ZotLit Sync & Packaging
- [ ] Implement Local Agent Bridge (`src/bridge.ts`) exposing `GET /agent/active` and `POST /agent/comment` via Zotero's internal server.
- [ ] Add Hermes Agent integration skill / tool definition to query Zotero reading state during autonomous tasks.
- [ ] Implement "Export Discussion to Obsidian" with ZotLit URI schema (`zotero://open-pdf/...` and `obsidian://zotlit/...`).
- [ ] Benchmark CPU/RAM consumption inside Zotero 7 (< 30 MB RAM footprint verified).
- [ ] Setup build and packaging script to produce signed/installable `.xpi` add-on bundle.

---

## 2. Active Focus & Blocker Log

- **Active Focus**: Setting up Gate 2 core TypeScript sources (`bootstrap.ts`, `reader.ts`, `llm.ts`, `bridge.ts`).
- **Blockers**: None.
