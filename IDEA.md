# Project Idea: Zotero AI Agent

## 1. Overview & Vision
**Zotero AI Agent** adalah ekstensi AI generasi baru untuk **Zotero 7** yang dirancang khusus untuk peneliti akademik. Ekstensi ini memungkinkan pengguna berdiskusi secara interaktif dan berdasar bukti (*grounded*) langsung dengan naskah PDF aktif di dalam reader Zotero, menghubungkannya dengan model lokal melalui **9router**, mengekspos bridge kontrol untuk harness otonom (**Hermes Agent**), dan menyinkronkan seluruh catatan hasil diskusi ke dalam vault **Obsidian** melalui protokol **ZotLit**.

---

## 2. Problem Statement & Feature Gaps

### Masalah pada Solusi Eksisting (Zotero-GPT, Chartero, dsb):
1. **Resource Hogging & Memory Leaks**:
   - Menjalankan local embedding vector database (ChromaDB / LangChain) memakan RAM 1–2 GB dan membuat CPU 100%, menyebabkan UI Zotero (mesin Gecko Firefox) sering freeze/lag saat membuka PDF berat.
2. **Hallucination & Shallow Abstracts**:
   - Kebanyakan plugin hanya memotong sembarangan teks PDF menjadi potongan teks acak (naive chunking) tanpa memahami struktur hierarkis artikel ilmiah (TOC, Bab Metodologi, Discussion, Limitations).
3. **Siloed Conversations**:
   - Percakapan terkunci di dalam jendela popup Zotero. Insight tidak otomatis tersinkronisasi ke sistem Second Brain (Obsidian) atau catatan literatur yang sudah ada.
4. **Tertutup dari Ekosistem AI Luar**:
   - Tidak memiliki antarmuka API/IPC lokal yang bisa diakses oleh coding agent atau research orchestrator eksternal seperti Hermes Agent.

---

## 3. Core Architectural Pillars

### A. Zero-Vector DB & Structural Context (Hemat RAM < 30 MB, CPU < 1%)
- **Nol Dependency Embedding Lokal**: Menghindari pembebanan RAM dari library PyTorch/Transformers lokal di dalam proses Zotero.
- **Leverage Native Zotero SQLite FTS**: Memanfaatkan mesin pencari teks penuh bawaan Zotero (`Zotero.Fulltext`) untuk query kata kunci tanpa perlu indexing ulang.
- **Viewport-Driven Lazy Injection**: Hanya menyuntikkan teks halaman PDF yang sedang aktif di viewport reader dan teks yang diblok/di-highlight user (< 2.000 token). KV-cache di 9router tetap kecil (< 400 MB VRAM) dan respon instan (< 400 ms).
- **DOM Streaming**: Respons LLM di-stream via SSE (`ReadableStream`) langsung ke elemen sidebar HTML tanpa buffering string raksasa di memori JavaScript.

### B. Dual Discussion Modes
1. **Single-Paper Deep Dive**:
   - Diskusi interaktif terikat pada halaman PDF aktif.
   - Wajib menyertakan kutipan teks verbatim dan nomor halaman pada setiap klaim jawaban.
2. **Multi-Paper Synthesis (Collection-Level)**:
   - Membandingkan temuan dari seluruh paper di dalam satu koleksi Zotero terpilih.
   - Mengambil hanya metadata berdensitas tinggi (`Title`, `Abstract`, `User Notes/Tags`) secara instan dari SQLite Zotero (~3.000 token untuk 10–15 paper) tanpa membuka file PDF fisik.

### C. Local Agent Bridge (Hermes Integration)
- Memanfaatkan internal server Zotero (`port 23119` atau `23125`) untuk mengekspos endpoint JSON ringan:
  * `GET /agent-bridge/active`: Mengembalikan judul, kunci item, halaman aktif, dan teks yang sedang dibaca pengguna.
  * `POST /agent-bridge/annotate`: Memungkinkan Hermes Agent menuliskan catatan/ringkasan langsung ke dalam PDF Zotero.
- Menjadikan Zotero dapat diawasi dan dibantu secara otomatis oleh Hermes Agent saat riset mandiri.

### D. ZotLit & Obsidian Protocol Interoperability
- Mengadopsi standar `@zotlit/protocol`:
  * Menggunakan skema URI permanen: `zotero://open-pdf/library/items/<ATTACHMENT_KEY>?page=<PAGE>` dan `obsidian://zotlit/open?...`.
  * Mengekspor catatan diskusi ke Vault Obsidian dengan frontmatter resmi ZotLit (`zt-item-key: "<KEY>"`), sehingga otomatis tertaut dua arah dengan Literature Note utama.

---

## 4. Stack & Environment
- **Target Host**: Zotero 7.0+ (TypeScript, ES Modules, WebExtensions + XPCOM).
- **LLM Gateway**: 9router local server (`http://localhost:8080/v1` atau port aktif).
- **External AI Harness**: Hermes Agent (Desktop / CLI tools).
- **Knowledge Vault**: Obsidian + ZotLit plugin.
- **Test Runner**: Node.js 24 native test runner (`node --experimental-strip-types --test`).

---

## 5. Hubungan dengan Dokumen Operasional
- **`HERMES.md`**: Single Source of Truth (SSOT), 5-Step Linear Execution Loop, dan batasan guardrail.
- **`PROJECT.md`**: Roadmap fase pengerjaan (Gate 1 Spec $\rightarrow$ Gate 2 Core MVP $\rightarrow$ Gate 3 Integrasi & Packaging).
- **`README.md`**: Ringkasan teknis dan panduan quick start pengguna.
