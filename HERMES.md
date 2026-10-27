# HERMES.md — Project Operating Guidelines

**Project**: `zotero-ai-agent`  
**Owner**: Cantikaputri Febrianti (`cantikapf.7@gmail.com`)  
**Single Source of Truth (SSOT)**: This repository guideline governs every Hermes session operating here.

---

## 1. Project Summary & Core Architecture Principles

`zotero-ai-agent` is an ultra-lightweight, resource-efficient AI Agent plugin for **Zotero 7**. It allows researchers to have contextual discussions with their papers, connect to local LLM harnesses (such as `9router` and `Hermes Agent`), and synchronize insights with Obsidian literature notes via the `ZotLit` protocol.

### Core Architectural Tenets
1. **Zero-Waste & Low Resource Consumption**:
   - RAM footprint inside Zotero strictly capped at **< 30 MB** (idle CPU < 1%).
   - **Zero Local Embedding Vector DB**: Eliminates PyTorch/ChromaDB overhead. Uses structural parsing (Table of Contents, Section Jumping) and Zotero's native SQLite Full-Text Search (`Zotero.Fulltext`).
   - **Lazy Viewport-Driven Context**: Instead of stuffing 50+ pages into memory, injects only active viewport text, user selections, and highlights (< 2.000 tokens) directly to 9router.
2. **Native Zotero 7 Architecture**:
   - Modern TypeScript / ES Module build.
   - Clean lifecycle handling via `bootstrap.js` (`startup` and `shutdown` tear-down to support hot-reloading).
   - Hooked into `Zotero.Reader` API for real-time page, selection, and annotation tracking.
3. **External Harness Bridge (Hermes Integration)**:
   - Exposes local endpoints via Zotero's internal server (`port 23119` or configurable `23125`) so Hermes Agent can inspect the reading session, query active paper metadata, and write annotation cards autonomously.
4. **ZotLit & Obsidian Protocol Interop**:
   - Deep-linking compatibility using `zotero://open-pdf/...` and `obsidian://zotlit/...`.
   - Markdown discussion exports mapped to ZotLit literature note frontmatter (`zt-item-key: <KEY>`).

---

## 2. 5-Step Linear Execution Loop

Every future Hermes session in this repo MUST follow these 5 steps sequentially:

1. **Bootstrap**: Read `HERMES.md` and `PROJECT.md` to orient current phase, gate criteria, and active focus.
2. **Scope**: Define exact minimal files to create or modify for the current task.
3. **Verify Pre**: Run existing test/build baseline before making edits (`npm test` or `node --test`).
4. **Execute**: Make targeted minimal changes (patching/writing code).
5. **Sync State**: Run verification, commit with conventional commits (`feat:`, `fix:`, `chore:`), and update `PROJECT.md` task checklist.

---

## 3. Verification & Test Commands

Use standard Node.js / npm toolchain:

```bash
# Run unit and protocol tests
npm test

# Build plugin bundle (.xpi / build output)
npm run build

# Type check
npm run typecheck
```

---

## 4. Hard Guardrails

- **Zero Hardcoded Secrets**: Endpoints, API keys, and personal tokens must be user-configurable via Zotero Preferences (`Zotero.Prefs`).
- **No Direct Destructive Locks on SQLite**: Never execute write queries directly on `zotero.sqlite` from external processes while Zotero is running. Use Zotero JavaScript APIs or read-only snapshots.
- **Strict UI Responsiveness**: Never run synchronous HTTP calls on the main thread. Always stream LLM completions asynchronously (`ReadableStream`) directly to DOM nodes without accumulating huge memory buffers.
- **Clean Shutdown**: Every event listener, DOM injection, and HTTP endpoint must be cleanly unregistered during `shutdown()` to prevent memory leaks during extension updates.
