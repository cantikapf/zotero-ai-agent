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

### A. Zero-Vector DB & Structural Context (Target Efisiensi Memori)
- **Nol Dependency Embedding Lokal**: Menghindari beban RAM dari library PyTorch/Transformers lokal di dalam proses Zotero.
- **Leverage Native Zotero SQLite FTS**: Memanfaatkan mesin pencari teks penuh bawaan Zotero (`Zotero.Fulltext`) sebagai **filter kandidat kata kunci** saja — API ini mengembalikan item yang cocok, bukan teks atau nomor halaman; pengambilan teks aktual masuk cakupan Spike 2.
- **Target Footprint & Metodologi Pengujian**: Menargetkan overhead RAM Zotero `< 30 MB` dan idle CPU `< 1%`. Angka ini merupakan target arsitektur yang harus divalidasi melalui profiling empiris (`about:memory` dan OS process monitor), bukan klaim yang belum diuji.
- **Viewport-Driven Lazy Injection**: Menyuntikkan teks halaman PDF yang sedang aktif di viewport reader dan teks yang diblok/di-highlight user (< 2.000 token target) ke LLM gateway (`9router`). Metodologi ekstraksi teks viewport memerlukan spike pada API publik Zotero 7 Reader.
- **DOM Streaming**: Respons LLM di-stream via SSE (`ReadableStream`) langsung ke elemen UI. Implementasi harus menghindari akumulasi buffer string besar di memori runtime.

### B. Discussion Modes & Batasan Ruang Lingkup MVP
1. **Single-Paper Deep Dive (Fokus Utama Core MVP)**:
   - Diskusi interaktif terikat pada halaman PDF aktif di Zotero Reader.
   - Wajib menyertakan kutipan teks verbatim dan nomor halaman pada setiap klaim jawaban.
   - **Prinsip Abstensi**: Jika jawaban tidak didukung oleh teks kutipan halaman aktif, model wajib menyatakan tidak dapat menjawab secara jujur dan dilarang berhalusinasi.
2. **Multi-Paper Synthesis (Collection-Level) — [Non-MVP / Pasca-MVP]**:
   - Membandingkan temuan dari seluruh paper di dalam satu koleksi Zotero terpilih.
   - Fitur ini secara eksplisit berada di luar cakupan Core MVP dan dievaluasi setelah stabilitas single-paper tercapai.

### C. Local Agent Bridge (Hermes Integration — Spesifikasi Usulan)
- Memanfaatkan internal server Zotero (port default `23119` atau port terkonfigurasi, misal `23125`) dengan rute terpadu yang diusulkan (*proposed, not implemented*):
  * `GET /agent-bridge/active` (Proposed Read-Only): Mengembalikan judul, kunci item, halaman aktif, dan teks seleksi pengguna. Wajib menggunakan autentikasi token opt-in.
  * `POST /agent-bridge/annotate` (Proposed Future Write / Non-MVP): Diusulkan untuk penulisan catatan ke PDF; ditunda ke fase lanjutan dan mewajibkan validasi izin pengguna (*consent*) serta jaminan idempotensi.
- Memungkinkan Zotero dipantau secara aman oleh ekosistem agen eksternal tanpa risiko modifikasi data tanpa izin.

### D. ZotLit & Obsidian Protocol Interoperability
- Mengadopsi integrasi Obsidian melalui ZotLit (versi target dipin melalui compatibility spike):
  * Menggunakan skema URI permanen: `zotero://open-pdf/library/items/<ATTACHMENT_KEY>?page=<PAGE>` (untuk personal library). Varian group library belum terverifikasi — format final dipin lewat Spike 3 sebelum dipakai di ekspor.
  * Mengekspor catatan diskusi ke Vault Obsidian dengan frontmatter yang kompatibel (`zotero-key` untuk ZotLit v2 — `zt-item-key` adalah nama modul internal `@zotlit/db`, bukan key frontmatter).
  * Ekspor catatan wajib menjaga integritas catatan eksisting dan identitas library pengguna.

---

## 4. Stack & Environment
- **Target Host**: Zotero 7.0+ (TypeScript, ES Modules, WebExtensions + XPCOM).
- **LLM Gateway**: 9router gateway (port terkonfigurasi via `Zotero.Prefs`; di mesin ini `http://127.0.0.1:20128/v1` — port `8080` tidak listening; gateway dapat merutekan ke runtime model lokal atau upstream API).
- **External AI Harness**: Hermes Agent (Desktop / CLI tools; integrasi read-only bertoken terlebih dahulu).
- **Knowledge Vault**: Obsidian + ZotLit plugin (versi target dipin via spike).
- **Test Runner**: Node.js 24 native test runner (`node --experimental-strip-types --test`).
- **Build Pipeline**: `scripts/build.js` memaketkan ekstensi `.xpi` (dalam rencana perbaikan Gate 1).
- **Lifecycle & Memory Guardrail**: Wajib membatalkan seluruh event listener dan endpoint server pada `shutdown()`.

---

## 5. Hubungan dengan Dokumen Operasional
- **`HERMES.md`**: Single Source of Truth (SSOT), 5-Step Linear Execution Loop, dan batasan guardrail.
- **`PROJECT.md`**: Roadmap fase pengerjaan (Gate 1 Spec $\rightarrow$ Gate 2 Core MVP $\rightarrow$ Gate 3 Integrasi & Packaging).
- **`README.md`**: Ringkasan teknis dan panduan quick start pengguna.
