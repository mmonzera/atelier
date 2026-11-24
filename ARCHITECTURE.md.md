# ARCHITECTURE.md — Atelier

Atelier adalah satu monorepo TypeScript: server Node.js yang menjalankan agent dan menyimpan state di SQLite, web app React yang hanya membaca event, dan Penpot di Docker sebagai canvas. Tab ini cukup detail untuk mulai ngoding, dan juga dipakai sebagai konteks oleh Builder bot.

## 1. Prinsip arsitektur

Tujuh aturan ini berlaku untuk semua kode Atelier, termasuk kode yang ditulis Builder bot.

1. **Server adalah satu-satunya pemilik state.** UI tidak pernah menyimpan data sendiri; ia menampilkan snapshot plus event dari server.
2. **Tulis dulu, siarkan kemudian.** Setiap perubahan ditulis ke SQLite dalam satu transaksi (event + proyeksi), baru setelah itu disiarkan ke UI lewat WebSocket.
3. **Alur satu arah.** UI → command (HTTP) → server → event (WebSocket) → UI. Adapter agent tidak boleh memanggil kode UI atau menulis tabel secara langsung; ia hanya memanggil fungsi di store.
4. **Kontrak bersama di satu paket.** Semua tipe yang dipakai server dan web ada di `packages/contracts`. Web tidak boleh meng-import kode server, dan sebaliknya.
5. **Engine agent di belakang interface.** Runtime hanya mengenal `AgentRunner`. Claude Agent SDK dan mock adalah dua implementasinya.
6. **Desain milik Penpot, kode milik Git.** Atelier tidak menyalin data desain atau kode ke databasenya; ia hanya menyimpan referensi (URL file, ID frame, path repo, link PR).
7. **Satu turn per agent pada satu waktu.** Pesan baru masuk antrian, tidak pernah menyela turn yang sedang berjalan (kecuali lewat Stop).

## 2. Struktur folder repo

Monorepo npm workspaces dengan tiga paket: `contracts`, `server`, `web`. Folder `data/` dan `workspaces/` dibuat saat runtime dan tidak masuk Git.

```text
atelier/
├─ package.json              # npm workspaces + script dev/build
├─ .env.example              # ANTHROPIC_API_KEY, ATELIER_MOCK, PORT
├─ DESIGN.md                 # salinan tab DESIGN.md
├─ ARCHITECTURE.md           # salinan tab ini
├─ infra/
│  ├─ docker-compose.yml     # Penpot + penpot-mcp + Caddy
│  └─ Caddyfile              # / → Atelier, /penpot/ → Penpot
├─ packages/
│  └─ contracts/src/index.ts # tipe bersama: entity, event, input command
├─ server/src/
│  ├─ index.ts               # bootstrap: db, store, runtime, HTTP, WS
│  ├─ config.ts              # baca env + settings
│  ├─ db.ts                  # node:sqlite, tabel events + proyeksi
│  ├─ store.ts               # command → event → proyeksi → broadcast
│  ├─ bus.ts                 # WebSocket broadcast
│  ├─ http.ts                # route Hono
│  ├─ github.ts              # gh CLI: list, clone, default branch
│  └─ agents/
│     ├─ runtime.ts          # antrian FIFO + drain + stop
│     ├─ runner.ts           # interface AgentRunner
│     ├─ claude-runner.ts    # implementasi Claude Agent SDK
│     ├─ mock-runner.ts      # implementasi palsu untuk dev
│     ├─ studio-tools.ts     # handler tool + MCP server atelier
│     └─ prompts.ts          # system prompt per role
├─ web/src/
│  ├─ main.tsx
│  ├─ styles/tokens.css      # token dari DESIGN.md
│  ├─ state/                 # store client: snapshot + reducer event
│  ├─ api.ts                 # pemanggil command HTTP
│  ├─ components/            # Rail, Composer, Message, SideCard, ...
│  └─ views/                 # Chat, Canvas, Preview, Split, Settings
├─ data/atelier.db           # runtime, di-.gitignore
└─ workspaces/<project-id>/repo  # clone repo project, di-.gitignore
```

## 3. Modul server

Setiap modul punya satu tanggung jawab. Ketergantungan hanya mengalir ke bawah tabel ini: `http` memanggil `store` dan `runtime`; `runtime` memanggil `store` dan `runner`; tidak ada yang memanggil `http`.

| Modul | Tanggung jawab | Bergantung pada |
| --- | --- | --- |
| `http.ts` | Validasi input (zod), memetakan route ke command, mengembalikan error yang jelas | `store`, `runtime`, `github` |
| `bus.ts` | Menyimpan koneksi WebSocket, mengirim `snapshot` saat connect, menyiarkan event | — |
| `store.ts` | Semua mutasi state: menulis event dan proyeksi dalam satu transaksi, lalu menyiarkan event | `db`, `bus` |
| `db.ts` | Akses SQLite: tabel `events`, tabel proyeksi (data JSON per entity), `settings` | `node:sqlite` |
| `agents/runtime.ts` | Antrian FIFO per agent, menjalankan turn, menulis delta pesan, mencatat tool call, Stop | `store`, `runner` |
| `agents/runner.ts` | Interface `AgentRunner.run(turn, callbacks)` dan tipe `Turn`, `TurnCallbacks` | — |
| `agents/claude-runner.ts` | Memanggil `query()` dari Claude Agent SDK, menerjemahkan pesan SDK ke callback | SDK, `studio-tools`, `prompts` |
| `agents/mock-runner.ts` | Bot palsu yang men-stream teks dan memanggil handler tool secara langsung | `studio-tools` |
| `agents/studio-tools.ts` | Handler tool sebagai fungsi biasa + pembungkus `createSdkMcpServer` | `store`, `runtime` |
| `github.ts` | `gh repo list`, `gh repo clone`, deteksi default branch | `child_process` |
| `config.ts` | Membaca env dan settings, mengenkripsi token MCP Penpot | `db` |

Interface runner:

```ts
interface Turn {
  agent: Agent; project: Project;
  prompt: string; resumeSessionId: string | null;
  signal: AbortSignal;
}
interface TurnCallbacks {
  onText(delta: string): void;
  onTool(name: string, input: unknown): void;
  onSession(sessionId: string): void;
}
interface AgentRunner {
  run(turn: Turn, cb: TurnCallbacks): Promise<{ finalText: string }>;
}
```

## 4. API & WebSocket

Semua command lewat HTTP JSON di `/api`; semua perubahan state kembali lewat WebSocket `/ws`. Respons HTTP hanya mengonfirmasi command diterima. UI tidak mengandalkan body respons untuk memperbarui tampilan.

| Method | Path | Body | Efek |
| --- | --- | --- | --- |
| GET | `/api/state` | — | Snapshot lengkap (`WorkspaceState`) |
| POST | `/api/projects` | `{ name, penpotFileUrl? }` | Buat project + Design bot + Builder bot |
| PATCH | `/api/projects/:id` | `{ name?, penpotFileUrl?, previewUrl? }` | Ubah project |
| DELETE | `/api/projects/:id` | `{ deleteRepo?: boolean }` | Hapus project, opsional hapus clone repo |
| GET | `/api/github/repos` | — | Daftar repo dari `gh repo list` |
| POST | `/api/projects/:id/repo` | `{ fullName }` | Clone repo ke workspace dan tautkan |
| POST | `/api/agents/:id/messages` | `{ text }` | Simpan pesan user, masukkan ke antrian agent |
| POST | `/api/agents/:id/stop` | — | Batalkan turn aktif, kosongkan antrian |
| POST | `/api/projects/:id/handoffs` | `{ frameName, frameId?, notes }` | Handoff manual dari UI (CNV-04) |
| GET / PUT | `/api/projects/:id/mappings` | daftar `ComponentMapping` | Baca / simpan mapping komponen |
| GET / PUT | `/api/settings` | `SettingsInput` | Baca / simpan settings; token tidak pernah dikembalikan, hanya `penpotMcpTokenSet` |
| WS | `/ws` | — | Server kirim `snapshot`, lalu event `ServerEvent` |

Format error: `{ "error": { "code": "repo_not_found", "message": "..." } }` dengan status HTTP 4xx/5xx yang sesuai.

## 5. Alur satu turn agent

Satu pesan user menjadi satu turn. Teks dan tool call di-stream ke UI selama turn berjalan, bukan setelah turn selesai.

&#91;embedded content: alur satu turn Design bot · 10 langkah\]

Garis putus-putus = balasan. Setiap panah ke Web UI melewati `store` dulu (tulis ke SQLite), baru disiarkan oleh `bus`. Untuk Builder bot alurnya sama, ditambah tool bawaan (Bash, Edit) di repo dan `report_build` di akhir.

## 6. Antrian, state agent & pemulihan

Setiap agent punya satu antrian FIFO yang disimpan di SQLite, jadi tugas tidak hilang saat server restart.

**Aturan antrian**

- Item antrian: `{ id, agentId, kind: "user" | "handoff" | "teammate", prompt, refId, createdAt }`. `refId` menunjuk ke pesan atau handoff asalnya.
- `drain(agentId)` dipanggil setiap kali item masuk atau turn selesai. Jika agent `idle` dan antrian tidak kosong, item terdepan diambil dan turn dimulai.
- Pesan user, handoff, dan pesan dari bot lain masuk antrian yang sama, diproses berurutan.
- `queueLength` di entity Agent selalu ikut diperbarui supaya UI bisa menampilkan "2 menunggu".

**State agent**

| State | Artinya | Transisi |
| --- | --- | --- |
| `idle` | Tidak ada turn berjalan | → `working` saat drain mengambil item |
| `working` | Satu turn sedang berjalan | → `idle` saat selesai; → `error` saat runner melempar error; → `idle` saat Stop |
| `error` | Turn terakhir gagal, `lastError` terisi | → `working` saat user mengirim pesan atau klik Retry |

**Stop**: memanggil `abort()` pada `AbortController` turn aktif, menandai pesan yang sedang di-stream sebagai selesai dengan akhiran "(dihentikan)", mengosongkan antrian, lalu status kembali `idle`.

**Pemulihan saat start**: agent yang tercatat `working` diubah ke `error` dengan `lastError = "Server restart saat turn berjalan"`; pesan yang masih `streaming` ditutup. Antrian yang tersisa tidak dijalankan otomatis; user menekan Retry. Ini mencegah turn berjalan dua kali.

## 7. Lifecycle handoff

Handoff bergerak dari `queued` ke `done`. Bot hanya bisa memindahkannya sampai `review` atau `failed`.

&#91;embedded content: lifecycle handoff · 5 status\]

Revisi tidak membuka ulang handoff lama: Design bot membuat handoff baru untuk frame yang sama, dengan link ke handoff sebelumnya di catatannya. Dengan begitu riwayat setiap putaran tetap utuh.

## 8. Tool MCP internal `atelier`

Empat tool ini adalah satu-satunya cara kedua bot berkoordinasi. Handler-nya fungsi biasa di `studio-tools.ts` yang menerima `store` dan fungsi `enqueue` lewat parameter (menghindari import melingkar dengan runtime), lalu dibungkus `createSdkMcpServer` untuk Claude dan dipanggil langsung oleh mock runner.

| Tool | Dipakai oleh | Input (zod) | Efek |
| --- | --- | --- | --- |
| `project_info` | Keduanya | — | Mengembalikan project (repo, branch, URL file Penpot, preview URL) dan daftar `ComponentMapping` |
| `handoff_to_builder` | Design bot | `{ title: string, frameName: string, frameId?: string, notes: string, unmappedComponents?: string[] }` | Membuat Handoff `queued`, mencatat activity, memasukkan prompt build ke antrian Builder bot. Mengembalikan `handoffId` |
| `report_build` | Builder bot | `{ handoffId: string, status: "review" \| "failed", branch?: string, prUrl?: string, previewUrl?: string, summary: string }` | Memperbarui Handoff, mengisi preview URL project, mengirim pesan `teammate` ke thread Design bot |
| `ask_designer` | Builder bot | `{ handoffId?: string, question: string }` | Memasukkan pertanyaan ke antrian Design bot sebagai pesan `teammate`; saat turn Design bot untuk pertanyaan itu selesai, runtime meneruskan teks jawabannya ke antrian Builder bot |

Prompt build yang dimasukkan `handoff_to_builder` berisi: judul, nama dan ID frame, catatan desainer, daftar mapping komponen, aturan branch `atelier/<handoffId>`, dan instruksi untuk memanggil `report_build` di akhir.

Status `done` tidak diset oleh bot. Status ini diset dari UI saat user menandai PR sudah di-merge (atau otomatis lewat status PR di fase berikutnya).

## 9. Konfigurasi agent per role

Kedua bot memakai Claude Agent SDK yang sama; yang berbeda hanya folder kerja, tool yang diizinkan, dan system prompt.

| Opsi `query()` | Design bot | Builder bot |
| --- | --- | --- |
| `cwd` | `workspaces/<project-id>/design` (folder kosong, untuk catatan) | `workspaces/<project-id>/repo` |
| `systemPrompt` | Preset `claude_code` + `append` prompt desainer | Preset `claude_code` + `append` prompt builder |
| `mcpServers` | `penpot` (HTTP, baca + tulis), `atelier` | `penpot` (HTTP, hanya baca lewat instruksi), `atelier` |
| Tool bawaan | Hanya Read, Write di folder kerjanya; tanpa Bash | Read, Write, Edit, Bash, Glob, Grep |
| `permissionMode` | `default` dengan `canUseTool` yang menolak semua tool di luar daftar | `acceptEdits`; mode izin penuh hanya jika user menyalakannya di Settings |
| `resume` | `sessionId` terakhir agent | `sessionId` terakhir agent |
| `includePartialMessages` | `true` | `true` |
| `abortController` | Milik turn aktif (untuk Stop) | Milik turn aktif (untuk Stop) |

Koneksi Penpot MCP: `{ type: "http", url: "http://localhost:8080/penpot/mcp/stream", headers: { Authorization: "Bearer <token MCP>" } }`.

**Isi prompt desainer**: selalu baca library file (komponen, token) sebelum membuat elemen; pakai token, jangan hex baru; satu layar = satu frame dengan auto-layout; panggil `handoff_to_builder` hanya saat user setuju frame siap; sebutkan komponen tanpa mapping.

**Isi prompt builder**: baca `project_info` dan frame terkait lewat `execute_code` (hanya membaca, tidak pernah mengubah file Penpot); deteksi stack dari repo; pakai komponen yang ada di mapping; kerja di branch `atelier/<handoffId>`; jalankan dev server di port project; buka PR dengan `gh pr create`; akhiri dengan `report_build`. Tidak pernah push ke default branch.

## 10. Infrastruktur lokal

Semua berjalan di satu mesin: Penpot dan Caddy di Docker, server dan web Atelier langsung di Node.js. Browser hanya membuka `http://localhost:8080`.

| Proses | Alamat | Dijalankan oleh |
| --- | --- | --- |
| Caddy (pintu masuk) | `localhost:8080` | Docker |
| Penpot frontend + MCP | `penpot-frontend:8080` (internal) | Docker |
| Atelier web (Vite dev) | `localhost:5173` | `npm run dev` |
| Atelier server | `localhost:8787` | `npm run dev` |
| Dev server project | `localhost:5200–5299` (satu per project) | Builder bot |

**docker-compose.yml**: salin `docker/images/docker-compose.yaml` resmi Penpot (sudah berisi frontend, backend, exporter, PostgreSQL, Valkey, `penpot-mcp`), lalu ubah tiga hal berikut:

```yaml
x-flags: &penpot-flags
  PENPOT_FLAGS: disable-email-verification enable-smtp enable-prepl-server disable-secure-session-cookies enable-mcp

x-uri: &penpot-public-uri
  PENPOT_PUBLIC_URI: http://localhost:8080/penpot/   # subpath, dengan slash di akhir

services:
  penpot-frontend:
    # hapus "ports: 9001:8080"; akses hanya lewat Caddy
  caddy:
    image: caddy:2
    ports: ["8080:8080"]
    volumes: ["./Caddyfile:/etc/caddy/Caddyfile:ro"]
    extra_hosts: ["host.docker.internal:host-gateway"]
    networks: [penpot]
```

**Caddyfile**: path `/penpot/` diteruskan tanpa diubah (Penpot mensyaratkan ini), sisanya ke Atelier.

```text
:8080 {
  handle /penpot/* {
    reverse_proxy penpot-frontend:8080
  }
  handle {
    reverse_proxy host.docker.internal:5173   # produksi: :8787
  }
}
```

Vite mem-proxy `/api` dan `/ws` ke `localhost:8787`, dan HMR memakai `clientPort: 8080`.

**.env** (tidak masuk Git):

```text
ANTHROPIC_API_KEY=        # kosong jika memakai login Claude Code
ATELIER_PORT=8787
ATELIER_MOCK=0            # 1 = bot palsu, tanpa API
ATELIER_DATA_DIR=./data
ATELIER_WORKSPACES_DIR=./workspaces
ATELIER_SECRET=           # kunci enkripsi token MCP di SQLite
```

Token MCP Penpot tidak disimpan di `.env`, tapi diisi di Settings dan disimpan terenkripsi.

## 11. Keamanan & batas akses

Atelier tool pribadi yang berjalan lokal, tapi Builder bot tetap menjalankan perintah shell, jadi batasnya ditegakkan di kode, bukan hanya di prompt.

| Batas | Ditegakkan di |
| --- | --- |
| Server hanya listen di `127.0.0.1` | `index.ts` |
| Header `Host` dan `Origin` request harus `localhost:8080` atau `localhost:5173`; selain itu ditolak (mencegah halaman web lain memanggil API lokal) | Middleware `http.ts` dan `bus.ts` |
| Builder bot hanya bekerja di `workspaces/<project-id>/repo` | `cwd` + `canUseTool` menolak path di luar folder itu untuk tool file |
| Tidak ada push ke default branch | Prompt + git hook `pre-push` yang dipasang di clone saat repo ditautkan |
| Design bot tidak bisa menjalankan shell | Daftar tool tanpa Bash |
| Token MCP Penpot dan API key tidak keluar dari server | Settings API hanya mengembalikan `penpotMcpTokenSet`; logger menyensor header `Authorization` |
| Token MCP terenkripsi di SQLite | AES-256-GCM dengan kunci `ATELIER_SECRET` |
| Mode izin penuh (`bypassPermissions`) | Mati secara default; dinyalakan per project di Settings dengan peringatan |

## 12. Mode dev & testing

Mode mock membuat seluruh UI bisa dikembangkan tanpa Penpot, tanpa GitHub, dan tanpa biaya API.

- **`ATELIER_MOCK=1`**: `mock-runner` men-stream balasan palsu kata per kata. Kalau pesan mengandung kata "handoff", Design bot palsu memanggil `handoff_to_builder`; Builder bot palsu lalu men-stream langkah kerja dan memanggil `report_build` dengan PR dan preview contoh.
- **Unit test (Vitest)**: `store` (event + proyeksi dalam satu transaksi), `runtime` (urutan FIFO, Stop, pemulihan saat start), handler `studio-tools`.
- **Test integrasi**: server dengan mock runner + client WebSocket, memeriksa urutan event untuk satu alur penuh: pesan → handoff → report.
- **Uji visual**: Playwright membuka `localhost:8080` dalam mode mock dan mengambil screenshot setiap view untuk dibandingkan dengan DESIGN.md.
- **Smoke test manual** sebelum upgrade Penpot: Design bot membuat satu frame, Builder bot membaca frame itu.

## 13. Urutan implementasi

Dikerjakan dari bawah ke atas supaya setiap langkah bisa diuji sebelum langkah berikutnya. Langkah 1–3 adalah Fase 0 (spike) di roadmap.

- [ ] 1\. Jalankan Penpot via Docker di subpath `/penpot/` di belakang Caddy; pastikan editor bisa dibuka dan plugin MCP terhubung
- [ ] 2\. Skrip kecil: satu `query()` Claude Agent SDK yang terhubung ke Penpot MCP dan membuat satu rectangle di file
- [ ] 3\. Embed Penpot di halaman kosong di `localhost:8080`; pastikan login dan WebSocket jalan di dalam iframe
- [ ] 4\. Monorepo + `packages/contracts`
- [ ] 5\. `db.ts` + `store.ts` + `bus.ts`, dengan unit test
- [ ] 6\. `http.ts`: project, settings, state, WebSocket
- [ ] 7\. `runtime.ts` + `mock-runner.ts` + `studio-tools.ts`; alur mock penuh lulus test integrasi
- [ ] 8\. Web: token dari DESIGN.md, rail, kartu panel kanan, view Chat, composer
- [ ] 9\. Web: view Canvas, Preview, Split
- [ ] 10\. `claude-runner.ts` untuk Design bot dengan Penpot MCP
- [ ] 11\. `github.ts` + penautan repo + hook `pre-push`
- [ ] 12\. `claude-runner.ts` untuk Builder bot: branch, dev server, PR, `report_build`
- [ ] 13\. Mapping komponen: API, UI editor mapping, injeksi ke prompt build
- [ ] 14\. Wizard Settings: cek Docker, token MCP, `gh auth status`, API key
- [ ] 15\. Uji alur penuh dengan satu layar nyata (Gate 2)

## 14. Local Vault Lock & Portable Migration (Fase 3)

Tetap zero server cost: semua berjalan di laptop user, cloud drive hanya dipakai sebagai folder sync.

**App lock (opsional, default mati)** — `server/src/security/`

| Bagian | Detail |
| --- | --- |
| Hash | `crypto.scrypt` (N=2^15, r=8, p=1) + salt acak 16 byte, dibandingkan dengan `timingSafeEqual` |
| Sesi | Token acak 32 byte di memori server (restart = login ulang), cookie `atelier_session; HttpOnly; SameSite=Strict; Path=/` |
| Idle timeout | Default 15 menit. Hanya aktivitas user (heartbeat dari UI, connect WS) yang memperpanjang sesi — polling latar belakang tidak. Sesi kedaluwarsa → socket ditutup dengan kode `4401` → UI menampilkan layar kunci |
| Cakupan | Middleware `lockGate` untuk seluruh `/api/*` + cek cookie saat upgrade `/ws`. Pengecualian: `/auth/status|login|logout|recover`, `/health`, `/mcp/oauth/callback` (dilindungi `state` PKCE) |
| Brute force | 5 salah → jeda 30 dtk, berlipat sampai 15 menit |
| Lupa password | Recovery key sekali pakai (125 bit, di-hash scrypt, dirotasi setiap dipakai). Kalau ikut hilang: `npm run lock:reset` atau `Atelier.exe --reset-lock` |
| Penyimpanan | Tabel `app_lock` — **machine-local**: tidak pernah ikut export, tidak ditimpa saat import |

**`.atelier-backup`** — `server/src/backup/`

- Snapshot konsisten lewat `VACUUM INTO` (aman di WAL mode, file `-wal` tidak pernah disalin manual), lalu tabel machine-local & secret dibersihkan dan di-`VACUUM` ulang supaya data terhapus tidak tersisa di free page.
- Format: `ATLBKP01` + header JSON (publik, tanpa data project) + body `gzip(manifest + db)`. Dengan passphrase: AES-256-GCM, kunci `scrypt(passphrase, salt)`, header dipakai sebagai AAD.
- API key (`provider_secrets`), token OAuth (`mcp_oauth`), serta header/env MCP yang terlihat rahasia **hanya ikut kalau file dienkripsi** dan user mencentang opsinya.
- Import: validasi checksum + `PRAGMA integrity_check` → salinan pengaman `data/backups/pre-import-*.db` (3 terakhir) → hentikan semua turn → `ATTACH` + salin isi tabel dalam satu transaksi (handle DB tidak pernah ditutup/diganti filenya) → `recoverOnStartup` → broadcast snapshot. Backup tanpa secret tidak menghapus secret yang sudah ada di laptop tujuan.
- Wizard relink: project yang `repo.localPath`-nya tidak ada → pilih folder / clone ulang via `gh` / lepas tautan (`DELETE /api/projects/:id/repo`).

**Auto-backup ke OneDrive / Google Drive / Dropbox** — folder dideteksi otomatis (env OneDrive, `Dropbox/info.json`, `G:\My Drive`/`Drive Saya`). Snapshot terenkripsi ditulis ke `*.partial` lalu di-rename (atomic, sync client tidak pernah melihat file setengah jadi), rotasi N file terakhir, jadwal tiap X jam (dilewati kalau tidak ada event baru) + saat app ditutup. Passphrase disegel dengan kunci mesin `data/.atelier-machine.key` (di luar DB) dan tidak pernah dikembalikan oleh API. Konfigurasi di tabel machine-local `backup_config`.

| Method | Path | Efek |
| --- | --- | --- |
| GET | `/api/auth/status` | `{ enabled, authenticated, idleMinutes, retryAfterSeconds }` |
| POST | `/api/auth/login` · `/logout` · `/lock-now` · `/heartbeat` · `/recover` | Sesi |
| POST | `/api/auth/enable` · `/disable` · `/change-password` · `/recovery-key` | Kelola lock |
| PATCH | `/api/auth/settings` | `{ idleMinutes }` |
| POST | `/api/backup/export` | `{ passphrase?, includeSecrets? }` → file biner |
| POST | `/api/backup/import` | multipart `file`, `passphrase?` → `BackupImportResult` |
| GET | `/api/backup/relink` · `/api/backup/cloud-folders` | Kandidat relink / folder cloud |
| GET / PUT | `/api/backup/auto` | Konfigurasi auto-backup |
| POST | `/api/backup/auto/run` | Backup sekarang |

## 15. Windows desktop app (Fase 4) — `desktop/`

Cangkang native **Tauri 2 (Rust)** + server TypeScript yang berjalan sebagai *sidecar* Node. Semua logika app tetap di server dan web UI; Rust hanya mengurus jendela dan integrasi OS.

```text
atelier-desktop.exe (Rust, ~28 MB RAM) --stdin/stdout--> atelier-node.exe server.mjs (Hono + node:sqlite)
        |  WebView2 (bawaan Windows 11)                         ^ 127.0.0.1:<port acak>
        +-------- http://127.0.0.1:<port>/ ---------------------+
```

- **Sidecar** (`desktop/sidecar/entry.ts`, dibundel esbuild ke `server-dist/server.mjs`): protokol baris teks. stdout `ATELIER_READY {port}` dan `ATELIER_NOTIFY {title,body}`; stdin `lock`, `shutdown`, atau EOF (shell mati -> server ikut berhenti graceful, tidak ada proses yatim). Env `ATELIER_EMBEDDED=1` mencegah `server/src/index.ts` start sendiri.
- **Port dinamis** (`port: 0`) + plugin single-instance: tidak ada `EADDRINUSE`; instance kedua hanya memunculkan jendela yang ada.
- **Data**: `%APPDATA%\Atelier\{data,workspaces,logs}` (bisa ditimpa `ATELIER_DATA_DIR` / `ATELIER_WORKSPACES_DIR`). Uninstall tidak menghapus data. Tidak ada build portable (Tauri tidak punya target portable); pakai Export/Import `.atelier-backup` untuk pindah.
- **Tray**: menutup jendela = sembunyi ke tray (agent tetap jalan). Menu: Buka, Kunci sekarang, Buka folder data, Periksa update, Keluar. Keluar -> `shutdown` ke sidecar -> stop agent -> backup-on-close -> tutup SQLite (maks 22 dtk, lalu kill).
- **Notifikasi native** (agent selesai/error/butuh persetujuan, task `in_review`), hanya saat jendela tidak fokus.
- **Folder picker**: dialog Windows asli lewat endpoint `/api/fs/pick-folder` yang sudah ada.
- **Auto-update**: `tauri-plugin-updater` membaca `latest.json` dari GitHub Releases, diverifikasi tanda tangan minisign (public key ada di `tauri.conf.json`). Cek 30 dtk setelah start (hanya memberi tahu); pemasangan hanya saat user memilih "Periksa update" di tray. Private key ada di `~/.tauri/atelier-updater.key` (jangan di-commit, jangan sampai hilang).
- **Animasi hemat GPU**: `web/src/state/animationGate.ts` menidurkan animasi dekoratif (maskot, efek kursor pada background) saat jendela tidak fokus atau tersembunyi ke tray (shell mengirim event `atelier-shell-hidden/shown`). Background adalah `web/src/assets/atelier-pattern.svg` (±40 path statis, di-inline oleh `PatternBackground.tsx`; garis hanya bergerak saat kursor lewat). Pengganti api halftone lama yang menggambar ~10 ribu titik per frame.

Perintah:

```text
npm run desktop          # build + jalankan shell Tauri (dev)
npm run desktop:build    # installer NSIS di desktop/src-tauri/target/release/bundle/nsis/
npm --workspace @atelier/desktop run build:release   # + artefak update bertanda tangan (set TAURI_SIGNING_PRIVATE_KEY)
npm run lock:reset       # matikan app lock (versi source); installer: Atelier.exe --reset-lock
```

## 16. Lampiran chat & kartu opsi desain

### Lampiran file / gambar
- **Composer**: menu "+" -> *Attach file or image…*, tempel gambar (Ctrl+V), atau seret file ke area composer. Maks 8 file/pesan, 25 MB/file, 60 MB total. Chip/thumbnail muncul di atas composer; × menghapus file yang belum terkirim.
- **Penyimpanan**: `<data>/attachments/<att_id>/{meta.json,<nama aman>}` (`server/src/attachments.ts`). Jenis ditentukan dari isi file (magic bytes), bukan MIME/ekstensi dari browser. Hanya png/jpeg/gif/webp yang ditampilkan inline; semua lainnya dipaksa download dengan `nosniff` + CSP `sandbox`. Unggahan yang tidak pernah dikirim dibersihkan setelah 24 jam. **File lampiran tidak ikut `.atelier-backup`** (hanya metadata di DB).
- **Ke agent**: teks bubble tetap kata-kata user; `metadata.attachments` menyimpan daftar file. Prompt model = teks + daftar path absolut (+ isi file teks kecil, maks 24 KB/file, 60 KB total, untuk provider yang tak bisa membaca file). Codex menerima gambar lewat `--image`; Claude CLI/SDK diberi akses baca ke folder lampiran (`--add-dir` / `additionalDirectories`), tulis tetap dibatasi workspace. Riwayat turn berikutnya memuat daftar file yang sama.
- **API**: `POST /api/attachments` (multipart `files`), `GET /api/attachments/:id/:nama`, `DELETE /api/attachments/:id` (409 jika sudah dipakai pesan), `POST /api/agents/:id/messages` menerima `attachmentIds`.
- **Tauri**: `dragDropEnabled: false` di `tauri.conf.json` supaya drag & drop HTML5 sampai ke halaman (WebView2 menelannya secara default).

### Kartu opsi desain
Agent menulis blok ini di balasannya (diajarkan lewat system prompt, jalan di semua provider):

```text
<atelier-design title="Pilih arah" ask="Mau yang mana?">
  <atelier-option id="A" label="Scope chip" summary="…" pros="…" cons="…" width="900" height="560">
    <!doctype html>…halaman lengkap, CSS inline…
  </atelier-option>
  <atelier-option id="B" label="Logo" kind="svg"><svg …/></atelier-option>
  <atelier-option id="C" label="Render" kind="image" src="C:\\path\\render.png"></atelier-option>
</atelier-design>
```

- **Parser** bersama server+web: `parseMessageSegments` di `packages/contracts`. Blok yang belum selesai (streaming) tampil sebagai kartu "Menyiapkan opsi desain…", HTML setengah jadi tidak pernah dirender. Tag `<atelier-option>` dipilih agar HTML mockup boleh berisi `<option>` biasa.
- **Render** (`web/src/components/DesignOptionsCard.tsx`): thumbnail diskalakan, tombol *Perbesar* (modal via portal) dan *Pilih opsi X* yang mengirim "Saya pilih opsi X — label" ke agent.
- **Keamanan preview**: `<iframe sandbox="allow-scripts">` tanpa `allow-same-origin` (origin opaque, tak bisa menyentuh Atelier), CSP `default-src 'none'` (tidak ada request jaringan, font/gambar eksternal, form, atau navigasi link). SVG dirender tanpa script.
- **Gambar**: agent tidak bisa membuat gambar raster sendiri; opsi `kind="image"` hanya untuk file PNG/JPG/WEBP yang benar-benar dibuat agent (mis. lewat tool/MCP image-generation atau skrip) di workspace. `GET /api/workspace-image?path=` menyajikannya, dibatasi ke folder workspaces, repo yang tertaut, dan lampiran; hanya file gambar valid <= 20 MB.
- **Konteks hemat**: di riwayat model, blok desain diringkas jadi satu baris (`summarizeDesignBlocks`), termasuk saat kompaksi.
