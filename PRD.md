# PRD — Atelier: Design-to-Ship Studio

Nov 24, 2026 · @Moses · Status: Draft v0.1

## 1. Ringkasan produk

Atelier adalah web app tempat seluruh proses produk, dari desain sampai shipping, berjalan di satu tempat: canvas desain, dua AI agent (Design bot dan Builder bot), dan repo GitHub per project.

- **Canvas**: Penpot self-hosted yang di-embed di dalam app. Desain disimpan sebagai data terstruktur (frame, komponen, token, auto-layout), bukan gambar.
- **Design bot**: agent yang bisa membaca dan mengedit canvas lewat Penpot MCP. User ngobrol dengannya untuk membuat atau merevisi layar.
- **Builder bot**: agent yang bekerja di clone repo GitHub project. Ia membaca frame dan token dari canvas, menulis kode, lalu membuka pull request.
- **Loop review**: hasil build (preview) ditampilkan di samping frame aslinya, sehingga gap desain vs kode langsung kelihatan.

Arsitektur mengikuti dua referensi: OpenBot (agent runtime, antrian per agent, event log di SQLite, tools via MCP) dan Penpot (model data shape yang datar, change records, MCP plugin bridge). Engine agent versi pertama memakai Claude Agent SDK. Nama produk final: Atelier.

## 2. Masalah & peluang

Handoff desain ke kode masih manual, satu arah, dan tersebar di banyak tools, sehingga hasil build sering melenceng dari desain dan butuh beberapa putaran revisi.

**Masalah yang diselesaikan**

1. **Konteks tercecer.** Desain di tool desain, diskusi di chat, kode di GitHub, preview di tab lain. Tidak ada satu tempat yang menunjukkan "frame ini sudah jadi PR yang mana".
2. **Handoff satu arah.** Developer (atau AI coding agent) menerima desain, tapi hasil build jarang dibandingkan kembali ke desain secara sistematis.
3. **AI tools terpisah.** Ada AI untuk bikin desain dan AI untuk nulis kode, tapi keduanya tidak berbagi konteks yang sama (frame, token, komponen, keputusan).
4. **Desain sebagai gambar.** Kalau agent hanya melihat screenshot, ia menebak spacing, warna, dan struktur. Hasilnya tidak konsisten.

**Peluang**

- Penpot menyimpan desain sebagai data terstruktur dan sudah menyediakan MCP server resmi, jadi agent bisa membaca dan menulis desain secara presisi tanpa perlu membangun canvas sendiri.
- Coding agent (Claude Agent SDK) sudah cukup matang untuk bekerja di repo nyata dan membuka PR.
- Yang belum ada adalah **hub** yang menyatukan keduanya dengan loop design → build → review dalam satu layar. Itu diferensiasi Atelier.

## 3. Tujuan, non-goals & metrik sukses

Tujuan MVP: satu orang bisa membawa satu layar dari ide ke PR yang ter-merge, tanpa keluar dari Atelier.

**Tujuan**

1. Design bot bisa membuat dan merevisi frame di Penpot dari instruksi chat.
2. Satu klik (atau satu perintah) mengubah frame menjadi tugas build untuk Builder bot.
3. Builder bot menghasilkan PR di repo yang terhubung, lengkap dengan preview URL.
4. Desain dan hasil build bisa dibandingkan berdampingan dan dikirim balik sebagai revisi.

**Non-goals (MVP)**

- Membangun canvas engine sendiri (dipakai Penpot).
- Kolaborasi multi-user real-time di dalam Atelier (Penpot sudah menangani ini di canvas).
- Multi-provider agent (Codex, Gemini, dll.). Disiapkan lewat interface, tapi bukan scope MVP.
- Deployment ke production, billing, dan marketplace.
- Aplikasi mobile.

**Metrik sukses** (target awal, divalidasi setelah pilot)

| Metrik | Target MVP | Cara ukur |
| --- | --- | --- |
| Waktu dari frame siap sampai PR terbuka | < 30 menit untuk 1 layar standar | Selisih waktu event `handoff.created` dan `handoff.pr_opened` |
| Handoff yang berakhir jadi PR | ≥ 70% | Jumlah handoff berstatus review/done dibagi total handoff |
| Putaran revisi per layar | ≤ 2 | Jumlah handoff ulang untuk frame yang sama |
| PR yang di-merge tanpa edit manual besar | ≥ 50% | Review manual saat pilot |
| Kepuasan sendiri setelah pemakaian | ≥ 4/5 | Evaluasi pribadi setelah 2 minggu pemakaian |

## 4. Target pengguna & persona

Pengguna utama MVP adalah product designer yang ingin membawa desainnya sampai jadi kode tanpa menunggu antrian developer.

| Persona | Siapa | Kebutuhan utama | Yang dilakukan di Atelier |
| --- | --- | --- | --- |
| Designer-builder (utama) | Product designer yang paham dasar kode, sering juga merangkap PM | Mengubah desain jadi produk yang jalan, cepat, dan sesuai desain | Mendesain bersama Design bot, mengirim handoff, mereview preview, merge PR |
| Developer reviewer | Front-end developer di tim yang sama | PR yang rapi dan mudah direview, dengan referensi desain yang jelas | Mereview dan merge PR dari Builder bot, memberi catatan teknis |
| Founder / solo maker | Pendiri startup kecil tanpa tim desain dan dev penuh | Membuat MVP produk tanpa merekrut banyak orang | Seluruh alur dari ide sampai deploy |
| PM / Product Owner | Pemilik produk yang memantau progres | Melihat status setiap layar: desain, build, review, selesai | Membaca timeline handoff dan status PR |

Contoh konteks awal: dashboard internal dan form operasional (misalnya alur pengajuan pinjaman) yang dibangun di atas komponen library yang tetap. Ruang lingkup yang sempit ini membuat hasil Builder bot jauh lebih konsisten.

## 5. User journey utama

Satu layar melewati enam langkah dalam satu loop, dan kembali ke Design bot setiap kali hasil build belum sesuai desain.

&#91;embedded content: user journey · 6 langkah, 1 loop revisi\]

Langkah 1 cukup sekali per project. Revisi bisa berupa perubahan desain (kembali ke Design bot) atau perbaikan kode, yang memakai handoff baru untuk frame yang sama.

## 6. Kebutuhan fungsional

MVP terdiri dari 26 requirement; P0 wajib untuk pilot, P1 masuk MVP bila waktu cukup, P2 setelah MVP.

### 6.1 Project & workspace

| ID | Requirement | Prioritas | Acceptance criteria |
| --- | --- | --- | --- |
| PRJ-01 | Membuat project baru dengan nama | P0 | Project muncul di sidebar; Design bot dan Builder bot otomatis dibuat untuk project tersebut |
| PRJ-02 | Menautkan file Penpot ke project | P0 | User menempel link file Penpot; canvas tampil di tab Canvas tanpa reload halaman |
| PRJ-03 | Menautkan repo GitHub ke project | P0 | User memilih repo dari daftar; repo di-clone ke workspace project; default branch terdeteksi |
| PRJ-04 | Mengatur preview URL | P1 | Builder bot bisa mengisi otomatis; user bisa mengubah manual |
| PRJ-05 | Menghapus atau mengarsipkan project | P1 | Konfirmasi sebelum hapus; folder repo lokal ikut dihapus hanya jika user setuju |

### 6.2 Canvas (Penpot)

| ID | Requirement | Prioritas | Acceptance criteria |
| --- | --- | --- | --- |
| CNV-01 | Embed editor Penpot di dalam Atelier | P0 | Editor Penpot bisa dipakai penuh (edit, komponen, token) dari tab Canvas |
| CNV-02 | Status koneksi MCP terlihat | P0 | Indikator menunjukkan apakah plugin MCP Penpot terhubung ke file yang sedang dibuka |
| CNV-03 | Mode split Desain vs Build | P0 | Frame dan preview tampil berdampingan dengan ukuran viewport yang sama |
| CNV-04 | Menandai frame siap build dari UI | P1 | User memilih frame lalu klik "Kirim ke Builder"; tercipta handoff dengan nama dan ID frame |

### 6.3 Design bot

| ID | Requirement | Prioritas | Acceptance criteria |
| --- | --- | --- | --- |
| DSB-01 | Chat dengan Design bot per project | P0 | Balasan di-stream per token; riwayat tersimpan setelah reload |
| DSB-02 | Membuat dan mengedit frame lewat Penpot MCP | P0 | Perubahan muncul di canvas yang sedang dibuka; setiap tool call tercatat di activity |
| DSB-03 | Memakai komponen dan token yang ada | P0 | Bot membaca library file sebelum membuat elemen baru; tidak membuat warna hex baru bila token tersedia |
| DSB-04 | Membuat handoff ke Builder bot | P0 | Tool `handoff_to_builder` membuat handoff berisi judul, frame, dan catatan; Builder bot langsung menerima tugas |
| DSB-05 | Review hasil build terhadap desain | P1 | Bot membandingkan screenshot frame dan preview, lalu menulis daftar perbedaan |

### 6.4 Builder bot

| ID | Requirement | Prioritas | Acceptance criteria |
| --- | --- | --- | --- |
| BLD-01 | Antrian tugas per agent (FIFO) | P0 | Pesan baru saat bot sibuk masuk antrian dan dijalankan berurutan; antrian bertahan setelah server restart |
| BLD-02 | Membaca frame dan token dari canvas (read-only) | P0 | Builder tidak pernah menulis ke file Penpot |
| BLD-03 | Menulis kode di branch baru dan membuka PR | P0 | Satu handoff = satu branch `atelier/<handoff-id>` = satu PR yang menautkan ke handoff |
| BLD-04 | Melaporkan hasil build | P0 | Tool `report_build` mengubah status handoff dan mengisi link PR, preview URL, serta ringkasan |
| BLD-05 | Bertanya ke Design bot | P1 | Tool `ask_designer` mengirim pertanyaan ke thread Design bot; jawaban kembali ke Builder |

### 6.5 Handoff, activity & kontrol

| ID | Requirement | Prioritas | Acceptance criteria |
| --- | --- | --- | --- |
| HND-01 | Timeline handoff per project | P0 | Setiap handoff menampilkan status: queued, building, review, done, failed |
| HND-02 | Activity log | P0 | Tool call, perubahan status, dan error tercatat dengan waktu |
| HND-03 | Menghentikan agent yang sedang berjalan | P0 | Tombol Stop membatalkan turn aktif dalam ≤ 3 detik; status kembali idle |

### 6.6 Preview & mapping komponen

| ID | Requirement | Prioritas | Acceptance criteria |
| --- | --- | --- | --- |
| PRV-01 | Builder bot menjalankan dev server lokal | P0 | Builder mendeteksi perintah dev dari repo (stack apa pun), menjalankannya di port khusus project, lalu mengisi preview URL lewat `report_build` |
| CMP-01 | Registry mapping komponen per project | P0 | Setiap komponen Penpot bisa dipetakan ke satu komponen kode (path file, nama export, mapping props/variant); mapping bisa dibuat dan diedit dari UI |
| CMP-02 | Builder wajib memakai komponen yang terpetakan | P0 | Untuk komponen yang punya mapping, kode memakai komponen tersebut, bukan membuat ulang; pelanggaran muncul di ringkasan build |
| CMP-03 | Peringatan komponen tanpa mapping | P1 | Saat handoff, Design bot menyebutkan komponen di frame yang belum punya mapping |

## 7. UX & information architecture

Layout utama punya tiga kolom melayang: rail project di kiri, area kerja (chat, canvas, preview) di tengah, dan kartu konteks di kanan.

**Struktur layar**

- **Rail kiri (±48 px)**: tile project, toggle sidebar, Settings, avatar user di bawah.
- **Header thread**: avatar bot + "Nama bot · project", tab **Chat / Canvas / Preview / Split**.
- **Area tengah**: kolom percakapan maks 650 px (Chat), editor Penpot (Canvas), iframe preview (Preview), atau frame dan preview berdampingan (Split).
- **Composer melayang** di bawah area tengah, selalu terlihat di semua tab, mengirim pesan ke bot yang sedang aktif.
- **Panel kanan (±270 px)**: kartu bertumpuk untuk Project (repo, branch, file Penpot), Agent team (Design bot dan Builder bot dengan status serta tugas saat ini), Handoffs (status dan link PR), dan Ports (dev server preview).

**Layar & state penting**

| Layar / komponen | State yang wajib didesain |
| --- | --- |
| Onboarding / Settings | Penpot belum terhubung, token MCP belum diisi, GitHub CLI belum login, semua siap |
| Canvas | Belum ada file Penpot, file terbuka tapi MCP terputus, MCP terhubung |
| Chat bot | Kosong, streaming, menunggu antrian, sedang menjalankan tool, error dengan tombol retry |
| Kartu handoff | Queued, building, review (ada PR), done, failed |
| Preview | Belum ada preview URL, loading, error (server dev mati) |
| Split | Frame dan preview pada lebar viewport yang sama; toggle overlay perbedaan (P2) |

**Prinsip UX**

- Agent selalu terlihat sedang mengerjakan apa: setiap tool call muncul sebagai baris activity singkat.
- User bisa menghentikan agent kapan saja dan mengambil alih secara manual.
- Bahasa UI default Inggris, dengan dukungan Bahasa Indonesia di fase berikutnya.

Panduan visual lengkap (warna, tipografi, komponen): DESIGN.md

## 8. Arsitektur sistem

Atelier adalah web app lokal dengan satu server Node.js. Penpot berjalan di Docker di belakang proxy yang sama, sehingga canvas bisa di-embed.

&#91;embedded content: arsitektur sistem · 4 lapis\]

Agent runtime adalah pusatnya: ia mengambil tugas dari antrian tiap bot, memanggil Claude lewat Agent SDK, mengedit atau membaca canvas lewat penpot-mcp, dan bekerja di repo lokal yang terhubung ke GitHub.

**Komponen server**

| Komponen | Tanggung jawab |
| --- | --- |
| API + WebSocket | Endpoint REST untuk command (buat project, tautkan repo, kirim pesan, stop agent) dan stream event `/ws` ke UI |
| Agent runtime | Satu antrian FIFO per agent, menjalankan satu turn pada satu waktu, men-stream teks, mencatat tool call |
| SQLite | Event log append-only + tabel proyeksi (projects, agents, messages, handoffs, activities, settings) |
| MCP internal `atelier` | Tool yang menghubungkan kedua bot: `handoff_to_builder`, `report_build`, `ask_designer`, `project_info` |
| GitHub service | Daftar repo, clone ke workspace, deteksi default branch |

**Stack**: Node.js 22, TypeScript, Hono, `node:sqlite`, `ws`, Claude Agent SDK, React + Vite, Caddy, Docker Compose.

## 9. Model data & event

Semua perubahan state ditulis dulu sebagai event di tabel `events` (append-only), lalu diproyeksikan ke tabel entity yang dibaca UI. Pola ini diambil dari OpenBot. Desainnya sendiri tidak disimpan di Atelier: data desain tetap milik Penpot.

**Entity**

| Entity | Field utama | Catatan |
| --- | --- | --- |
| Project | id, name, penpotFileUrl, repo (fullName, defaultBranch, localPath), previewUrl | Satu project = satu file Penpot + satu repo |
| Agent | id, projectId, role (design / builder), status, queueLength, sessionId, lastError | `sessionId` dipakai untuk melanjutkan sesi Claude Agent SDK |
| Message | id, projectId, agentId, author (user / agent / teammate / system), text, streaming | `teammate` = pesan dari bot lain |
| Handoff | id, projectId, title, frameName, frameId, notes, status, branch, prUrl, previewUrl, summary | Unit kerja dari desain ke build |
| Activity | id, projectId, agentId, kind (tool / status / handoff / pr / error), label | Log yang tampil di UI |
| Settings | penpotBaseUrl, penpotMcpUrl, penpotMcpToken (terenkripsi), model | Global per instalasi |

Entity tambahan untuk mapping komponen: **ComponentMapping** (id, projectId, penpotComponentId, penpotComponentName, codePath, exportName, propsMap). Builder bot membacanya lewat tool `project_info`.

**Event ke UI (WebSocket `/ws`)**

| Event | Kapan dikirim |
| --- | --- |
| `snapshot` | Saat client pertama terhubung |
| `project-upserted` / `project-deleted` | Project dibuat, diubah, atau dihapus |
| `agent-upserted` | Status atau antrian agent berubah |
| `message-upserted` | Pesan baru atau pesan selesai di-stream |
| `message-delta` | Potongan teks saat bot sedang menulis |
| `handoff-upserted` | Handoff dibuat atau statusnya berubah |
| `activity-added` | Tool call, perubahan status, atau error |
| `settings-changed` | Settings disimpan |

Aturan alur data: adapter agent tidak boleh menulis state UI secara langsung. Ia mengirim event ke runtime, runtime menulis ke SQLite, baru kemudian event diteruskan ke UI.

## 10. Integrasi

Atelier hanya bergantung pada tiga integrasi: Penpot (canvas), GitHub (kode), dan Claude Agent SDK (agent).

### 10.1 Penpot + MCP

- Penpot self-hosted via Docker (frontend, backend, exporter, PostgreSQL, Valkey) dengan flag `enable-mcp`, plus container `penpot-mcp`.
- Penpot mengirim header `X-Frame-Options: SAMEORIGIN`, jadi Atelier dan Penpot harus satu origin. Solusinya: reverse proxy Caddy di `localhost:8080`; path `/penpot/` diteruskan ke Penpot dan path lain ke Atelier. `PENPOT_PUBLIC_URI` diisi `http://localhost:8080/penpot/`.
- Agent terhubung ke endpoint MCP `/penpot/mcp/stream` dengan token MCP user (dibuat di Penpot, diisi di Settings Atelier).
- Plugin MCP harus aktif di file yang sedang dibuka di canvas. Tool utama: `execute_code` (menjalankan JavaScript terhadap Plugin API), `export_shape` (gambar sebuah shape), dan tool dokumentasi API.
- Design bot: akses baca dan tulis. Builder bot: hanya baca, dibatasi lewat instruksi dan daftar tool yang diizinkan.

### 10.2 GitHub

- MVP memakai `gh` CLI yang sudah login di mesin user: daftar repo, clone, buat branch, push, buka PR.
- Repo di-clone ke `workspaces/<project-id>/repo`. Builder bot hanya bekerja di folder ini.
- Konvensi: branch `atelier/<handoff-id>`, judul PR = judul handoff, deskripsi PR berisi link frame dan ringkasan.
- Fase berikutnya: GitHub App (OAuth) agar tidak bergantung pada CLI lokal dan bisa membaca status CI serta review.

Preview: Builder bot menjalankan dev server repo di mesin lokal, satu port per project, lalu melaporkan URL-nya. Mode Split memuat URL ini di samping frame.

### 10.3 Claude Agent SDK

- Setiap turn memanggil `query()` dengan `cwd`, system prompt per role, `mcpServers` (Penpot + server internal `atelier`), dan `resume` dengan `sessionId` agar konteks percakapan berlanjut.
- `includePartialMessages` aktif untuk streaming teks ke UI.
- Server MCP internal `atelier` (dibuat dengan `createSdkMcpServer`) menyediakan `handoff_to_builder`, `report_build`, `ask_designer`, dan `project_info`.
- Engine dibungkus di belakang interface `AgentRunner`, sehingga provider lain (Codex, ACP) bisa ditambahkan nanti tanpa mengubah UI.
- Mode mock (`ATELIER_MOCK=1`) menjalankan bot palsu untuk demo dan pengembangan UI tanpa API key.

## 11. Kebutuhan non-fungsional

Risiko terbesar ada di keamanan: Builder bot menjalankan perintah shell di repo user, jadi batas akses harus jelas sejak MVP.

| Area | Requirement |
| --- | --- |
| Keamanan: eksekusi agent | Builder bot hanya bekerja di folder repo project; perintah shell berjalan dengan izin user lokal. Mode "izin penuh" wajib diaktifkan secara eksplisit oleh user dan diberi peringatan |
| Keamanan: rahasia | Token MCP Penpot dan API key disimpan di server, tidak pernah dikirim ke browser atau ditulis ke log; `.env` tidak ikut ke repo |
| Keamanan: jaringan | MVP hanya listen di `localhost`. Akses jarak jauh butuh autentikasi (fase berikutnya) |
| Keamanan: git | Builder tidak pernah push ke default branch; semua perubahan lewat branch dan PR |
| Performa | Teks pertama dari bot tampil di UI ≤ 2 detik setelah model mulai merespons; delta di-stream tanpa menunggu turn selesai |
| Reliability | Event log dan antrian bertahan setelah server restart; turn yang terputus ditandai error dan bisa di-retry |
| Observability | Setiap tool call, durasi turn, dan error tercatat di activity log dan log server |
| Privasi | Desain dan kode tetap di mesin user (Penpot self-hosted, repo lokal). Yang keluar hanya prompt dan konteks ke API model |
| Kompatibilitas | Chrome dan Edge terbaru; macOS dan Linux untuk server; Windows lewat WSL |
| Aksesibilitas | Navigasi keyboard di chat dan sidebar; kontras teks memenuhi WCAG AA |

## 12. Roadmap & fase rilis

Empat fase dengan gate di antaranya; estimasi durasi mengasumsikan satu orang builder dengan bantuan AI dan perlu dikalibrasi setelah Fase 0.

&#91;embedded content: roadmap · 4 fase, 3 gate\]

Fase berikutnya baru dimulai setelah gate-nya lolos. Kalau Gate 1 gagal (Penpot tidak bisa di-embed di subpath), cadangannya adalah subdomain lokal, dengan Fase 1 tetap berjalan.

## 13. Risiko, asumsi & open questions

Risiko teknis terbesar ada di embed Penpot lewat subpath dan di akurasi hasil desain ke kode. Keduanya perlu dibuktikan di Fase 0.

**Risiko**

| Risiko | Dampak | Mitigasi |
| --- | --- | --- |
| Penpot di subpath `/penpot/` bermasalah (cookie, WebSocket, MCP plugin) | Canvas tidak bisa di-embed | Spike di Fase 0; cadangan: Penpot di subdomain lokal dengan proxy yang sama |
| Hasil build melenceng dari desain | Banyak putaran revisi, user kecewa | Paksa pemakaian token dan komponen; mapping komponen desain ke komponen kode; review di mode Split |
| Builder bot menjalankan perintah berbahaya | Kerusakan file atau kebocoran rahasia | Folder terbatas, konfirmasi untuk mode izin penuh, tidak pernah push ke default branch |
| Biaya API model tinggi | Tidak layak dipakai rutin | Tampilkan pemakaian token per turn; batasi jumlah turn per handoff |
| Perubahan API Penpot MCP atau Plugin API | Design bot rusak setelah upgrade | Kunci versi Penpot di Docker; uji smoke sebelum upgrade |
| Setup terlalu rumit (Docker, token, gh login) | Pengguna berhenti di onboarding | Wizard setup dengan cek status per langkah; satu perintah `docker compose up` |

**Asumsi**

- Pengguna punya Docker, Node.js 22+, dan `gh` CLI yang sudah login.
- Pengguna punya akses ke Claude (API key atau login Claude Code).
- Project target adalah web app dengan stack apa pun, selama punya dev server yang bisa dijalankan lokal.

**Keputusan** (24 Nov 2026)

| Pertanyaan | Keputusan | Dampak ke PRD |
| --- | --- | --- |
| MVP dipakai sendiri atau pilot tim kecil? | Dipakai sendiri dulu | Fase 2 = pemakaian sendiri; metrik kepuasan diukur lewat evaluasi pribadi |
| Stack kode default Builder bot? | Bebas, tidak dikunci ke satu stack | Builder membaca stack dari repo; asumsi project disesuaikan |
| Cara menjalankan preview? | Dev server lokal oleh Builder bot | Requirement PRV-01 ditambahkan |
| Mapping komponen Penpot ke kode? | Sejak MVP | Requirement CMP-01 sampai CMP-03 dan entity ComponentMapping ditambahkan |
| Nama produk? | Atelier | Nama final, bukan lagi nama kerja |

**Positioning:** Atelier adalah tool pribadi, bukan produk publik. Karena itu, onboarding untuk orang lain, multi-tenant, dan billing tidak masuk roadmap.

## 14. Lisensi & kepatuhan

Atelier dipakai sebagai tool pribadi. Lisensi komponennya tetap mengizinkan pemakaian komersial kalau arah ini berubah, dengan tiga batasan berikut.

| Komponen | Lisensi | Konsekuensi |
| --- | --- | --- |
| [Penpot](https://github.com/penpot/penpot) | MPL-2.0 | Boleh dipakai komersial. File Penpot yang dimodifikasi wajib dipublikasikan; kode Atelier di luar Penpot tetap privat. MVP tidak memodifikasi Penpot |
| [OpenBot](https://github.com/nightly-labs/openbot) | PolyForm Noncommercial 1.0.0 | Hanya dipakai sebagai referensi arsitektur. Tidak ada kode OpenBot yang disalin ke Atelier |
| Claude Agent SDK | Ketentuan di `LICENSE.md` paket SDK | Ikuti ketentuan pemakaian Anthropic; pemakaian API ditagih per token |

Aturan internal: setiap dependency baru dicek lisensinya sebelum masuk repo, dan atribusi pihak ketiga dicantumkan di `THIRD_PARTY_NOTICES.md`.

## Sumber

- [nightly-labs/openbot](https://github.com/nightly-labs/openbot): `docs/ARCHITECTURE.md`, `docs/architecture/`, `src/backend/agent-client.ts`
- [penpot/penpot](https://github.com/penpot/penpot): `mcp/README.md`, `docker/images/docker-compose.yaml`, `.serena/memories/`, `render-wasm/`
