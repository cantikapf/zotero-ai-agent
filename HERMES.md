# HERMES.md — Project Operating Guidelines

**Project**: `zotero-ai-agent`  
**Owner**: Cantikaputri Febrianti (`cantikapf.7@gmail.com`)  
**Single Source of Truth (SSOT)**: This repository guideline governs every Hermes session operating here.

---

## 1. Project Summary & Core Architecture Principles

`zotero-ai-agent` is an ultra-lightweight AI Agent plugin designed for **Zotero 7**. It allows researchers to have contextual discussions with papers in the reader, connect to LLM gateways (such as `9router`), expose an opt-in local bridge for external harnesses (**Hermes Agent**), and export discussion notes compatible with the **ZotLit** Obsidian ecosystem.

### Core Architectural Tenets
1. **Zero-Waste & Low Resource Consumption (Empirical Targets)**:
   - **Target Footprint**: Target RAM overhead in Zotero `< 30 MB`, idle CPU overhead `< 1%`. These are architectural targets to be empirically measured with profiling tools, not unverified claims.
   - **Zero Local Embedding Vector DB**: Eliminates local PyTorch/ChromaDB memory overhead. Relies on structural navigation (Table of Contents) and Zotero native SQLite Full-Text Search (`Zotero.Fulltext`).
   - **Lazy Viewport-Driven Context**: Dynamically injects active page text, user selections, and highlights (< 2,000 tokens target) to the LLM gateway (`9router` local or remote gateway).
2. **Native Zotero 7 Architecture**:
   - Modern TypeScript / ES Module build.
   - Clean lifecycle handling via `bootstrap.js` (`startup` and `shutdown` teardown).
   - Event listener and endpoint unregistration on `shutdown()` is mandatory to prevent leaks during hot-reloading or updates.
   - Reader integration hooks into verified Zotero 7 Reader APIs (verified via compatibility spike; do not assume undocumented internals).
3. **External Harness Bridge (Hermes Integration)**:
   - Proposed local HTTP endpoints via Zotero internal server (default `23119` or user-configured custom port, e.g. `23125`):
     - Proposed read-only: `GET /agent-bridge/active` (opt-in authentication token required).
     - Proposed future write: `POST /agent-bridge/annotate` (deferred to future phase; requires explicit consent validation & idempotency).
4. **ZotLit & Obsidian Protocol Interop**:
   - Deep-linking compatibility using `zotero://open-pdf/...` (handling personal and group libraries) and `obsidian://zotlit/...`.
   - Markdown discussion exports mapped to ZotLit literature note frontmatter (`zotero-key`; `zt-item-key` is an internal @zotlit/db module name, not a frontmatter key — pinned by compatibility spike).
   - Safe export preserving existing notes and library/group identity.

---

## 2. 5-Step Linear Execution Loop

Every future Hermes session in this repo MUST follow these 5 steps sequentially:

1. **Bootstrap**: Read `HERMES.md` and `PROJECT.md` to orient current phase, gate criteria, and active focus.
2. **Scope**: Define exact minimal files to create or modify for the current task.
3. **Verify Pre**: Run existing test/build baseline before making edits (`npm test` or `node --test`).
4. **Execute**: Make targeted minimal changes (patching/writing code).
5. **Sync State**: Run verification and update `PROJECT.md` task checklist. Commit with conventional commits (`feat:`, `fix:`, `chore:`) only when requested or approved by the user (no mandatory automated commits).

---

## 3. Verification & Test Commands

Use standard Node.js / npm toolchain:

```bash
# Run unit and protocol tests (Baseline: Passes 3 core assertions via node native test runner)
npm test

# Type check (Requires devDependencies installed; fails if tsc missing)
npm run typecheck

# Build plugin bundle (Baseline: Fails until scripts/build.js is implemented)
npm run build
```

---

## 4. Hard Guardrails

- **Zero Hardcoded Secrets**: Endpoints, API keys, and personal tokens must be user-configurable via Zotero Preferences (`Zotero.Prefs`) and never committed or logged in plaintext.
- **No Direct Destructive Locks on SQLite**: Never execute write queries directly on `zotero.sqlite` from external processes while Zotero is running. Use Zotero JavaScript APIs or read-only snapshots.
- **Strict UI Responsiveness & Memory Cleanup**: Never run synchronous HTTP calls on the main thread. Stream LLM completions asynchronously (`ReadableStream`). Do not accumulate unbounded memory buffers in memory; support prompt cancellation via `AbortSignal`.
- **Clean Teardown on Shutdown**: Every event listener (`Zotero.Reader`), DOM injection, and HTTP endpoint must be cleanly unregistered during `shutdown()` to prevent leaks (e.g. resolve current missing reader callback teardown in `bootstrap.ts`).
- **Bounded Context, Citation Provenance & Abstention**: Answers must be grounded strictly in the active viewport/excerpt context with explicit page citations. If the provided context does not contain sufficient evidence, the model MUST abstain honestly rather than hallucinating.
- **Bridge Security & Consent Boundary**: External bridge endpoints must be opt-in and authenticated. Read-only inspection first; any future mutation/annotation endpoint requires explicit user consent and idempotency guarantees.
