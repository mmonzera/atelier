# PRD: Landing Page Atelier

> Status: **Draft v1** · 25 Nov 2026 · Owner: mmonzera
> Referensi layout dan microinteraction: <https://cosmoq.framer.website/> (template Framer "COSMOQ", desain Jitu Raut). Dipakai sebagai **referensi pola**, bukan untuk disalin. Semua copy, aset, warna, dan ilustrasi di dokumen ini orisinal untuk Atelier.
> Dokumen ini berisi tiga hal sekaligus: PRD (bagian 1–4, 11–14), **design spec / design.md** (bagian 5–9), dan katalog microinteraction (bagian 8–9). Bagian 5–9 bisa dipotong jadi `DESIGN.md` sendiri kalau mau.

---

## 0. Cara membaca dokumen ini

| Kalau kamu… | Baca |
|---|---|
| Mau tahu *apa* dan *kenapa* | §1–§4 |
| Desainer / mau bikin di Figma / Framer | §5 (token), §6 (section per section), §8 (motion) |
| Developer | §6, §8, §10 (tech), §11 (a11y & performa), Lampiran A (snippet) |
| Mau cek klaim di halaman benar atau tidak | §3.3 (Content Truth Table) |

---

## 1. Ringkasan

### 1.1 Produk
**Atelier** adalah aplikasi desktop Windows (Tauri, installer NSIS, versi 0.1.0) bernama lengkap **"Design-to-Ship Studio"** (di app juga tertulis "Agent Harness & Task Studio"). Satu tempat untuk menjalankan banyak AI agent (Claude, OpenAI/Codex, Antigravity, DeepSeek, OpenCode, OpenRouter) sebagai "bot" berkarakter per project, lengkap dengan memori, browser, QA, dan pencatat meeting. Semua data tinggal di laptop pengguna.

Hal yang sudah ada di kode saat PRD ditulis (basis klaim landing page):

| Kemampuan | Bukti di repo |
|---|---|
| Banyak provider/model dalam satu chat, pilihan model yang tampil bisa diatur, daftar model live | `ModelProvider` di `packages/contracts`, commit `f6e8090` |
| Agent per project dengan maskot bot, kabel emas, dan start-up screen | `web/src/components/mascot/*`, `BootLoader.tsx`, commit `96219e5` |
| Memori berlapis: Canon, ringkasan terstruktur, arsip + auto-compaction | commit `52edc1b`, `fb4e885`, `7837f20` |
| Library gambar per project dan per agent | commit `bf47124`, `5177aff` |
| Plugin, skill on-demand (`/skill`), mention `@`, MCP stdio | commit `94a10a5`, `e14b1d9` |
| **Remote Browser** dengan login vault terenkripsi dan konfirmasi aksi sensitif | commit `7837f20`, `BrowserSettingsPanel.tsx` |
| **Browser QA** otomatis + laporan + screenshot | `QaReportCard.tsx`, `server/src/qa` |
| **Pencatat meeting**: Whisper lokal, deteksi Zoom/Teams/dll, label pembicara, catatan oleh agent | commit `95b7c71`, `941296e`, `d088131`, `188fae8` |
| App lock (scrypt), backup terenkripsi (AES-256-GCM), recovery key | `LockScreen.tsx`, `SecurityBackupPanel.tsx` |
| UI dua bahasa English / Indonesia | commit `681b7f6`, `web/src/i18n` |
| Updater lewat GitHub Releases | `tauri.conf.json` → `mmonzera/atelier` |

**Belum ada / jangan diklaim sebagai fitur rilis:** ekstensi Chrome ("Chrome Tab", baru rencana di `ATELIER-CHROME-EXTENSION-PLAN.md`), build macOS/Linux, akun cloud, sinkronisasi tim.

### 1.2 Tujuan landing page
1. **Mengubah pengunjung jadi unduhan.** CTA utama: *Download for Windows*.
2. Dalam ≤ 10 detik pengunjung paham: *"Ini workspace desktop untuk banyak AI agent, datanya lokal."*
3. Membangun rasa premium dan dipercaya lewat visual dan gerakan, setara kualitas referensi cosmoq, tapi dengan identitas Atelier (gelap hangat, emas, bot berkabel).
4. Jujur: hanya mengklaim yang sudah ada (§3.3).

### 1.3 Non-goals (v1)
- Bukan situs dokumentasi, blog, atau dashboard akun.
- Tidak ada checkout, login, atau backend khusus. Unduhan mengarah ke GitHub Releases.
- Tidak ada testimoni atau logo pelanggan palsu. Bagian bukti memakai bukti nyata (§6.10).
- Tidak ada tracking lintas situs atau cookie iklan.

### 1.4 Metrik keberhasilan

| Metrik | Target 30 hari | Cara ukur |
|---|---|---|
| Klik *Download* / pengunjung unik | ≥ 8% | event `download_click` (analytics tanpa cookie, mis. Plausible/Umami) |
| Scroll sampai bagian Download | ≥ 45% | event `section_view:download` |
| LCP (4G, mid-tier laptop) | ≤ 2,0 s | Lighthouse CI + RUM |
| CLS | ≤ 0,05 | idem |
| INP | ≤ 200 ms | idem |
| Skor Lighthouse (Perf / A11y / SEO / Best Practices) | ≥ 90 / 100 / 100 / 100 | CI |
| Pemakaian CPU saat idle di hero | < 8% satu core, 60 fps saat scroll | DevTools Performance, uji di laptop Ryzen 7 5700G tanpa dGPU |

---

## 2. Audiens dan positioning

### 2.1 Persona

| Persona | Kebutuhan | Pesan utama |
|---|---|---|
| **Solo builder / vibecoder** yang pindah-pindah Claude, Codex, DeepSeek | Satu tempat, konteks tidak hilang, biaya terkendali | "Semua agent-mu satu meja, ingatannya tidak hilang." |
| **Desainer-developer / freelancer** | Dari ide ke desain ke build ke QA tanpa 6 tab | "Design-to-Ship" dalam satu studio |
| **Orang yang peduli privasi** | Tidak mau data meeting dan password lari ke cloud | "Audio, password, dan catatan tetap di laptopmu." |

### 2.2 Positioning
> **Untuk** builder yang memakai banyak AI agent, **Atelier adalah** studio desktop **yang** menyatukan agent, memori, browser, dan catatan meeting dalam satu workspace lokal, **tidak seperti** chat web atau CLI terpisah yang kehilangan konteks dan menaruh datamu di server orang lain.

### 2.3 Tone of voice
Tenang, presisi, sedikit hangat. Kalimat pendek. Tidak berlebihan ("revolusioner", "game-changer" dilarang). Kata kerja konkret (*run*, *remember*, *record*, *lock*). Bahasa default halaman: **English** (audiens internasional + selaras dengan UI app), dengan **toggle ID/EN** di nav. Seluruh copy di §6 ditulis EN; padanan ID dibuat saat implementasi memakai gaya `web/src/i18n/id.ts`.

---

## 3. Strategi pesan

### 3.1 Tagline dan headline
- **Headline hero (utama):** `One studio for every AI agent you run.`
- Alternatif A/B: `Design it. Build it. Ship it. With your agents, on your machine.`
- **Sub-headline:** `Atelier puts Claude, Codex, DeepSeek and more on one desk, with memory, a browser and meeting notes that never leave your laptop.`
- **Badge atas hero** (padanan "Beta Version is launching on 12th September" di cosmoq): `Windows beta · v0.1 is out` → link ke changelog.

### 3.2 Tiga pilar pesan
1. **Many agents, one desk** (banyak model, satu workspace).
2. **Remembers, so you don't repeat** (Canon + ringkasan + arsip).
3. **Yours, on your machine** (lokal, terenkripsi, tidak dikirim ke model).

### 3.3 Content Truth Table (aturan klaim)

| Boleh diklaim | Syarat / catatan |
|---|---|
| "Runs Claude, Codex, Antigravity, DeepSeek, OpenCode, OpenRouter" | Sesuai `ModelProvider`. Nama model tertentu jangan di-hardcode di copy marketing selain di strip logo. |
| "Passwords are encrypted on your machine and never sent to AI models" | Kalimat persis dari UI app. |
| "Transcription runs on your device with Whisper" | Mesin & model di-download sekali atas persetujuan pengguna. Jangan tulis "tanpa internet" tanpa catatan itu. |
| "Backups encrypted with AES-256-GCM, app lock hashed with scrypt" | Backup terenkripsi **hanya jika** pengguna memberi passphrase. Tulis demikian di FAQ. |
| "Asks before it buys, pays, deletes, sends or publishes" | Pengaturan *Confirm sensitive actions*; tulis "can ask", bukan "always". |
| "Windows 10/11" | Satu-satunya platform v1. Tampilkan jujur; macOS/Linux = "Notify me". |
| "Free" | **Keputusan terbuka** (§14 Q1). Sebelum diputuskan, copy memakai "Download" tanpa kata free/price. |
| Chrome Tab extension | **Tidak** di v1. Boleh muncul hanya sebagai kartu "Coming soon" di roadmap, berlabel jelas. |
| Testimoni, jumlah pengguna, logo perusahaan | **Dilarang** sampai ada data nyata dengan izin tertulis. |

---

## 4. Analisis referensi: cosmoq.framer.website

Diamati langsung di browser pane (viewport 1024 px). Nilai ukuran di bawah **terukur** dari computed style; perilaku animasi yang tidak bisa dipastikan lewat inspeksi ditandai *(inferensi)* dan harus divalidasi ulang saat build dengan perekaman layar referensi.

### 4.1 Struktur halaman (urutan section di referensi)

| # | Section di cosmoq | Pola layout | Pola interaksi yang terlihat |
|---|---|---|---|
| 0 | Nav | Pill kaca di tengah (radius 999, blur 10), logo kiri, tombol *Get Started* kanan dengan **border gradien bercahaya** (radius 16) | Nav tetap menempel (sticky) di atas semua section; latar blur |
| 1 | Hero | Badge kecil → H1 → sub → CTA. Latar hitam dengan **aurora vertikal oranye ke biru + horizon bumi melengkung** di bawah | Cahaya hidup (gerak lambat); teks muncul bertahap |
| 2 | Strip logo | Satu baris logo abu | Marquee *(inferensi)* |
| 3 | Pernyataan besar | Satu paragraf raksasa rata kiri | Teks "terisi" kata demi kata saat scroll *(inferensi dari tinggi section yang sangat panjang, ±5.900 px)* |
| 4 | "What sets COSMOQ apart" | Header 2 kolom (judul kiri, deskripsi kanan, eyebrow berikon di atas). Grid kartu 2×2 bergaya kaca; tiap kartu punya ilustrasi (slider cahaya, ikon logo melayang) | Kartu masuk dengan fade+rise; kartu "Control" punya slider yang bergerak; kartu berpendar emas saat hover *(inferensi)* |
| 5 | "All-in-one AI" (Features) | Kolom kiri: **daftar tab vertikal** (Usage / Technology / Data) dengan ikon; kanan: kartu besar yang berganti konten. Di dalamnya chip melayang, kotak ketik "Help me with \|", ring konsentris + ikon integrasi | **Scroll-driven**: tab aktif berubah mengikuti posisi scroll, kartu kanan *sticky* |
| 6 | "Multiple Products" | Tab horizontal pill (Automation / Banking / Recruitment) + kartu besar berisi daftar poin berikon; di bawah 4 kartu kecil | Ganti tab = konten crossfade; kartu kecil hover terangkat |
| 7 | "3 Steps to Kickstart" | 3 kartu lebar, tiap kartu: judul, deskripsi, 3 poin, visual di kanan | **Kartu bertumpuk** (stacking/sticky) saat scroll |
| 8 | Data and Privacy | Visual berlapis (lapisan keamanan) + 3 poin | Lapisan muncul berurutan |
| 9 | Testimonials | Grid/marquee kartu kutipan | Marquee dua arah *(inferensi)* |
| 10 | Pricing | Toggle **Monthly/Yearly (30% off)**, 3 kartu (tengah di-highlight, "Go for more power") | Angka harga beranimasi saat toggle *(inferensi)* |
| 11 | FAQ | Header + daftar akordeon (8 item) | Buka/tutup dengan tinggi halus, ikon berputar |
| 12 | Integration | Judul + deskripsi + tombol, visual ikon | Ikon bergerak pelan |
| 13 | Footer | CTA besar → 4 kolom link → **wordmark raksasa terpotong (outline)** di bawah → bar legal | Wordmark outline terisi gradien saat hover/scroll *(inferensi)* |

### 4.2 Token yang terukur dari referensi

| Properti | Nilai terukur |
|---|---|
| Latar halaman | `#000` (hitam murni) |
| Font | Inter (body) dan **Inter Display** (judul) |
| H1 | 46 px / 500 / letter-spacing −1,38 px (−3%) / line-height 55,2 px |
| H2 | 36 px / 400 / −0,72 px (−2%) / 43,2 px |
| H3 | 24 px / 400 / 31,2 px, dan varian 30 px / 500 / 36 px |
| Body | 16 px / 400 / 24 px |
| Eyebrow & label kecil | 14 px / 500 / −0,42 px / 21 px |
| Tinggi nav | 76 px |
| Tombol CTA | radius 16 px, border gradien (tanpa fill solid) |
| Kartu | radius ±10 px, `backdrop-filter: blur(5–10px)`, latar transparan hampir 0, border tipis terang |
| Pill nav | radius 999 px, `blur(10px)` |

*Catatan:* ukuran H1 di atas diukur di viewport 1024; Framer menskalakan per breakpoint, jadi di desktop lebar angkanya lebih besar. Atelier memakai skala sendiri di §5.2.

### 4.3 Inti "rasa" referensi yang kita tiru
1. **Gelap total + satu sumber cahaya** yang berwarna dan "hidup".
2. **Tipografi besar, tracking rapat, berat ringan**, bukan tebal.
3. **Kaca tipis + garis tepi halus**, hampir tanpa warna fill.
4. **Header section 2 kolom** dengan eyebrow berikon.
5. **Scroll-driven storytelling**: tab yang berpindah sendiri, kartu menumpuk, teks yang terisi.
6. **Tombol dengan tepi bercahaya** sebagai satu-satunya titik warna terang.
7. **Wordmark raksasa terpotong** di footer.

### 4.4 Yang sengaja **tidak** ditiru
- Hitam murni `#000` dan aurora oranye-biru (itu identitas cosmoq). Atelier: hitam-hangat `#09090c` dan cahaya **emas**.
- Bagian testimoni dan harga dengan data rekaan.
- Cookie banner penuh. Atelier tidak memakai cookie pelacak, jadi tidak butuh banner (§11.5).
- Badge "Made in Framer".
- Beberapa section super panjang (hingga 19.000 px). Atelier menargetkan total ±9–11 layar desktop, bukan ±17.900 px.

---

## 5. Design system (design.md)

> Prinsip: **turunkan dari token app** (`web/src/styles/tokens.css`) supaya landing dan aplikasi terasa satu keluarga. Hal baru hanya yang tidak ada di app (aurora, kaca bercahaya, display type).

### 5.1 Warna

#### Fondasi (dari app, dengan satu penyesuaian landing)
| Token | Hex | Pakai untuk |
|---|---|---|
| `--bg-landing` | `#09090c` | Latar halaman (sedikit lebih gelap dari app `#0d0d11` agar cahaya lebih menonjol) |
| `--bg-base` | `#0d0d11` | Latar seksi bergantian, mockup jendela app |
| `--surface-1` | `#15151b` | Kartu solid |
| `--surface-2` | `#1c1c23` | Kartu di atas kartu |
| `--surface-3` | `#24242e` | Chip, track slider |
| `--border-subtle` | `#262630` | Garis pemisah |
| `--border-default` | `#282833` | Border kartu |
| `--text-primary` | `#e4e4ea` | Teks utama (H1 boleh `#f4f4f6`) |
| `--text-secondary` | `#9494a3` | Paragraf |
| `--text-muted` | `#696976` | Label, legal |
| `--action-primary` | `#f4f4f6` / fg `#111116` | Tombol solid putih (CTA sekunder) |

#### Aksen merek: **Atelier Gold** (sama dengan kabel di BootLoader)
| Token | Nilai | Pakai |
|---|---|---|
| `--gold-100` | `#f4e2bd` | Highlight terang, ujung gradien |
| `--gold-300` | `#d8be92` | **Warna merek utama** (kabel, glow, eyebrow ikon) |
| `--gold-500` | `#c9a86a` | Teks aksen di atas gelap |
| `--gold-700` | `#8a6d3b` | Dasar gradien, bayangan |
| `--gold-glow` | `rgba(216,190,146,0.35)` | Halo, box-shadow |

#### Warna agent (dipakai hemat, hanya untuk bot/provider)
Pakai deret `--agent-*` dari tokens.css (blue `#3b8df7`, orange `#f28c28`, purple `#9b67f7`, green `#38c976`, dst.). Aturan: **maksimal 1 warna agent dominan per viewport**, tidak pernah untuk tombol atau teks.

#### Gradien
```
--grad-gold-edge:   conic-gradient(from var(--a), #8a6d3b, #f4e2bd 18%, #d8be92 34%, #3b52ad 52%, #d8be92 70%, #8a6d3b)   /* tepi CTA; --a beranimasi */
--grad-horizon:     radial-gradient(120% 60% at 50% 100%, rgba(244,226,189,.55) 0%, rgba(216,190,146,.28) 22%, rgba(59,82,173,.18) 45%, transparent 70%)
--grad-beams:       linear-gradient(to top, rgba(216,190,146,.35), transparent 70%)   /* tiang cahaya vertikal hero */
--grad-text-fade:   linear-gradient(180deg, #fff 0%, rgba(255,255,255,.55) 100%)       /* untuk H1/H2, clip ke teks */
```
Sedikit biru `#3b52ad` (`--agent-indigo`) sebagai pasangan dingin di horizon, seperti kontras oranye-biru di cosmoq, tapi didominasi emas.

### 5.2 Tipografi
Font: **Inter** (sudah dipakai app) untuk semua teks, **JetBrains Mono** untuk eyebrow, angka, dan kode. Untuk display besar gunakan Inter `font-variation-settings: "opsz" 32` (Inter 4 variable) agar mirip "Inter Display" di referensi. Self-host (woff2, `font-display: swap`, subset Latin).

| Token | Desktop ≥1200 | Tablet 768–1199 | Mobile <768 | Weight | Tracking | Line-height |
|---|---|---|---|---|---|---|
| `display-xl` (H1 hero) | 76 px | 60 px | 40 px | 500 | −3,5% | 1,04 |
| `display-l` (H2 section) | 52 px | 44 px | 32 px | 400 | −3% | 1,08 |
| `display-m` (H3 kartu besar) | 32 px | 28 px | 24 px | 500 | −2% | 1,2 |
| `statement` (paragraf raksasa §6.3) | 56 px | 44 px | 28 px | 400 | −2,5% | 1,15 |
| `title` (judul kartu) | 22 px | 20 px | 18 px | 500 | −1,5% | 1,3 |
| `body-l` | 18 px | 17 px | 16 px | 400 | −0,5% | 1,55 |
| `body` | 16 px | 16 px | 15 px | 400 | 0 | 1,6 |
| `small` | 14 px | 14 px | 14 px | 400 | 0 | 1,5 |
| `eyebrow` (mono) | 12 px | 12 px | 12 px | 400 | +8% UPPERCASE | 1,2 |
| `mono-num` | 14 px | 14 px | 13 px | 400 | tabular-nums | 1,4 |

Gunakan `text-wrap: balance` di semua heading dan `text-wrap: pretty` di paragraf. Heading memakai `--grad-text-fade` (putih → 55% putih) kecuali H1 yang putih penuh dengan satu kata beraksen emas.

### 5.3 Grid, spasi, radius

| Item | Nilai |
|---|---|
| Lebar konten maks | 1200 px (hero dan footer boleh bleed penuh) |
| Grid | 12 kolom, gutter 24 px (desktop), 8 kolom/20 px (tablet), 4 kolom/16 px (mobile) |
| Padding halaman | 48 / 32 / 20 px (desktop / tablet / mobile) |
| Skala spasi | 4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 96 · 128 · 160 px |
| Jarak antar section | 160 px desktop, 112 px tablet, 80 px mobile |
| Radius | `sm 8` · `md 12` · `lg 16` (tombol CTA, kartu kecil) · `xl 24` (kartu besar) · `full 9999` (nav pill, chip) |

### 5.4 Elevasi dan "kaca"
| Token | Resep |
|---|---|
| `glass-card` | `background: rgba(255,255,255,.03)`; `border: 1px solid rgba(255,255,255,.08)`; `backdrop-filter: blur(14px) saturate(140%)`; `box-shadow: inset 0 1px 0 rgba(255,255,255,.06), 0 24px 60px -30px rgba(0,0,0,.8)` (selaras kelas `.glass` di app) |
| `glass-card--hover` | border → `rgba(216,190,146,.28)`, plus spotlight (§8.2) |
| `glass-pill` (nav) | `background: rgba(20,20,26,.55)`; `blur(18px) saturate(150%)`; border `rgba(255,255,255,.1)`; radius full |
| `edge-glow` (CTA) | Lihat Lampiran A.1 |
| Fallback tanpa `backdrop-filter` | `background: rgba(24,24,31,.94)` |

**Aturan performa kaca:** `backdrop-filter` hanya pada ≤ 6 elemen terlihat sekaligus; jangan ditumpuk di dalam elemen yang beranimasi `filter`.

### 5.5 Ikon dan ilustrasi
- Ikon: `lucide-react` (sudah dipakai app), stroke 1,5 px, ukuran 16/20/24.
- Maskot: **bot Atelier** dari `BotMascot` + kabel emas (`.boot-rope`, `.boot-knot`) menjadi karakter visual utama landing, menggantikan "planet" cosmoq.
- Mockup app: jendela Atelier asli (screenshot/komponen) dengan frame gelap, radius 16, bayangan besar, pantulan emas tipis di tepi atas.
- Pola latar sisi: `web/src/assets/atelier-pattern.svg` pada opacity ≤ 6%, di-mask ke tepi (seperti commit "fade page edges smoothly").

---

## 6. Spesifikasi section per section

Notasi: **D** = desktop ≥1200, **T** = tablet, **M** = mobile. Durasi dan easing mengacu token motion di §8.1.

### 6.0 Navbar (padanan `Nav` cosmoq)
- **Layout D:** tinggi 76, `position: fixed`, tiga zona. Kiri: logo Atelier (ikon + wordmark). Tengah: **pill kaca** berisi link `Features · Workflow · Privacy · Download · FAQ` (jarak 28 px, font 14/500). Kanan: toggle bahasa `EN | ID` (mono 12) + tombol `Download` (edge-glow).
- **Layout M:** logo kiri, tombol Download kecil + ikon menu kanan. Menu membuka sheet penuh layar dengan link besar (`display-m`), muncul berurutan.
- **Interaksi:**
  | Pemicu | Efek |
  |---|---|
  | Load | Nav turun dari −24 px + fade, 600 ms, `ease-out-expo`, delay 200 ms |
  | Scroll > 24 px | Latar pill naik dari alpha .35 → .65, border lebih terang (200 ms). Nav tidak pernah hilang saat scroll turun (sama seperti referensi). |
  | Hover link | Teks `text-secondary → text-primary`, **pil highlight** (bg `rgba(255,255,255,.07)`) meluncur ke link yang di-hover (shared layout, 220 ms spring `stiffness 400, damping 32`) |
  | Link aktif (scroll-spy) | Titik emas 4 px di bawah label; berpindah dengan animasi layout |
  | Fokus keyboard | Ring 2 px `--gold-300` offset 2 |
  | Klik link | Smooth scroll ke section, 800 ms `ease-in-out-cubic`, offset −96 px |

### 6.1 Hero
- **Tujuan:** mengomunikasikan produk dan mendorong unduhan dalam satu layar.
- **Layout D (tinggi 100 svh, min 760):** konten terpusat vertikal sedikit ke atas (pusat di 42% tinggi). Urutan: badge → H1 (3 baris maks, lebar 860) → sub-headline (lebar 560, `body-l`, `text-secondary`) → baris CTA (`Download for Windows` edge-glow besar 52 px tinggi + `Watch 60s tour` tombol ghost dengan ikon play) → baris kecil `Windows 10/11 · v{version} · {size} MB` (mono, `text-muted`; versi dan ukuran diisi otomatis dari rilis GitHub nyata saat build, bukan ditulis tangan).
- **Latar (padanan aurora + horizon):**
  1. Lapisan dasar `#09090c` + noise grain 3% (PNG 128 px, `mix-blend-mode: soft-light`).
  2. **Horizon emas melengkung** di dasar: elips lebar 160% viewport, tepi atas bercahaya (`--grad-horizon`), dipotong oleh `overflow: hidden`.
  3. **Tiang cahaya vertikal** (`--grad-beams`), 9 tiang, lebar acak 60–200 px, opacity 0,10–0,35, blur 30 px, `mix-blend-mode: screen`.
  4. **Bot bergantung di kabel emas** (3–5 bot dengan panjang kabel berbeda, memakai keyframe `boot-lower` lalu `boot-sway` yang sudah ada). Ini pembeda terkuat Atelier. Bot kiri dan kanan di margin, tidak boleh menimpa H1.
  5. Vignette radial untuk menjaga kontras teks (min 7:1 untuk H1).
- **Mockup di bawah fold:** jendela app Atelier (rasio 1440×920) mengintip dari bawah hero, naik ±120 px ke dalam layar pertama pada D dan jadi pusat section berikutnya saat scroll. Memberi petunjuk scroll tanpa panah.
- **Microinteraction hero:**
  | Pemicu | Efek | Spesifikasi |
  |---|---|---|
  | Load | Orkestrasi berurutan | Nav 0,2 s → badge 0,35 s → H1 per **kata** (stagger 60 ms; tiap kata: opacity 0→1, y 24→0, blur 8→0 px, 700 ms `ease-out-expo`) → sub 0,9 s → CTA 1,05 s → mockup 1,2 s (y 80→0, 1000 ms) |
  | Load | Bot turun | `boot-lower` 1,1 s dengan pantulan kecil, lalu goyang `±3,2°` periode 3–4,5 s (variasi per bot). Hanya `transform` agar jalan di compositor |
  | Pointer bergerak (D) | Paralaks cahaya | Tiang cahaya bergeser −12…+12 px berlawanan pointer, horizon −6…+6 px; smoothing lerp 0,08. Dimatikan di sentuhan dan reduced-motion |
  | Pointer dekat bot | Bot menoleh ke kursor | Memakai `mascotPointer.ts`; jangkauan 280 px |
  | Klik bot | Bot berayun lebih keras (impuls ±9°, redam 1,2 s) dan memunculkan toast mini "Hi, I'm {nama}" (opsional) | |
  | Hover CTA utama | Lihat §8.3 (edge-glow) | |
  | Scroll keluar hero | Teks naik lebih lambat (parallax 0,85×) dan memudar 1→0 di 0–50% tinggi hero; horizon naik pelan | |
  | Tab tidak terlihat / hero keluar viewport | Semua loop animasi **dijeda** (`IntersectionObserver` + `visibilitychange`) | |
- **Badge:** pill kaca, titik emas berdenyut (`atelier-pulse` 1,6 s), teks `Windows beta · v0.1 is out`, panah kecil yang bergeser 3 px saat hover.
- **Fallback:** tanpa WebGL dan saat `prefers-reduced-motion`: gambar statis horizon (WebP) + bot statis miring `--tilt`. Konten tetap tampil penuh.

### 6.2 Strip provider (padanan strip logo)
- **Konten:** label mono `RUNS WITH` lalu logo/wordmark: Claude, OpenAI, Antigravity, DeepSeek, OpenCode, OpenRouter. Memakai `ProviderIcon` yang sudah ada, monokrom abu `#8a8a98`.
- **Layout:** satu baris, tinggi 108, tepi kiri-kanan di-mask (fade 96 px).
- **Interaksi:** marquee kontinu 40 s/loop, kecepatan melambat ke 25% saat hover; hover satu logo → naik ke `#e4e4ea` dan beri halo warna agent-nya 20% (180 ms). Dijeda saat di luar viewport. Reduced-motion: baris statis, dua baris pada M.

### 6.3 Pernyataan besar (padanan paragraf raksasa)
- **Copy:** `Atelier is where your AI agents work like a studio: each with a desk, a memory and a role. You bring the idea. They design, build, test and write it down.`
- **Layout:** `statement` type, lebar 1000 px rata kiri, tinggi section = 240 vh dengan konten `position: sticky; top: 28vh` (efek "terisi").
- **Interaksi:** setiap **kata** punya opacity dasar 0,18; sambil scroll, kata menjadi 1,0 berurutan (`scroll-linked`, menggunakan `useScroll` + `useTransform`, tanpa re-render per frame). Kata kunci (`agents`, `memory`, `studio`) menyala emas `#d8be92` saat terisi. Di bawah paragraf muncul 3 bot kecil yang "naik" dari kabel (stagger) ketika kalimat selesai terisi.
- **Reduced-motion / M:** opacity langsung 1, tanpa sticky, tinggi section normal.

### 6.4 "What sets Atelier apart" (padanan *Exceptionalities*)
- **Header (2 kolom, sama pola referensi):** kiri eyebrow `[ikon sparkles] EXCEPTIONAL BY DESIGN` + H2 `What sets Atelier apart`; kanan (kolom 8–12) `Smarter context, calmer tools and a workspace that stays on your machine.`
- **Grid:** 2×2 kartu `glass-card`, tinggi 440 D, radius xl; tiap kartu: ilustrasi di atas (±55% tinggi), judul `title`, deskripsi `small`.

  | Kartu | Judul | Deskripsi | Ilustrasi (animasi loop) |
  |---|---|---|---|
  | 1 | **Many agents** | Run Claude, Codex, DeepSeek and others in one chat. Pick the models you want to see. | Lima ikon provider melayang pelan di orbit, satu menyala emas bergantian |
  | 2 | **Real memory** | Canon keeps the facts that matter. Summaries and an archive keep long projects light. | Tumpukan 3 lapisan kartu (Canon / Summary / Archive) bergeser seperti kartu remi |
  | 3 | **Under your control** | Atelier asks before it buys, pays, deletes, sends or publishes. | **Tiga slider** vertikal bercahaya (mirip kartu "Control" referensi) yang bergerak naik-turun tak sinkron, tiap slider berlabel `Browser`, `Shell`, `Files` |
  | 4 | **Yours, locally** | Passwords, meeting audio and notes stay on this laptop. | Ikon laptop dengan gembok emas, cincin gelombang keluar-masuk (tanpa panah ke luar) |

- **Interaksi:**
  | Pemicu | Efek |
  |---|---|
  | Masuk viewport (40%) | Header: eyebrow → H2 (per baris) → deskripsi; kartu stagger 90 ms (opacity 0→1, y 40→0, scale .98→1, 800 ms) |
  | Hover kartu | **Spotlight** emas mengikuti kursor di dalam kartu (radial 360 px, alpha .14), border naik ke emas .28, ilustrasi sedikit membesar 1,03 (400 ms). Kartu naik −4 px |
  | Hover kartu 3 | Slider berhenti bergerak otomatis dan **bisa diseret** (drag horizontal/vertikal) dengan efek pegas; lepas = kembali ke loop |
  | Fokus keyboard | Kartu fokusable; sama seperti hover |
  | Sentuh | Tanpa spotlight; ilustrasi tetap loop |

### 6.5 "All-in-one studio" (padanan *Features*, scroll-driven tab)
- **Header:** eyebrow `[ikon layers] FEATURES`, H2 `One connected studio`, deskripsi kanan `Agents, memory, browser, QA and meeting notes, wired together instead of taped together.`
- **Layout D:** tinggi section = 4 × 100 vh. Dalam wrapper `sticky`: kolom kiri (4/12) **daftar tab vertikal**, kolom kanan (8/12) satu **kartu stage** tinggi 560.

  | Tab (kiri) | Isi stage (kanan) |
  |---|---|
  | **Agents** (ikon bot) | Jendela chat Atelier: pesan pengguna muncul, bot membalas dengan efek ketik; chip model `Claude · Codex · DeepSeek` di composer berganti |
  | **Memory** (ikon brain) | Panel Canon: entri `key: value` muncul satu per satu, lalu ringkasan "memadat" (animasi kompaksi: 12 baris → 3 baris) |
  | **Browser** (ikon globe) | Frame browser dengan kursor agent bergerak, dialog **"Confirm browser action"** muncul, tombol *Allow* ditekan; login vault menampilkan titik-titik password |
  | **Meetings** (ikon mic) | Pill rekaman bernapas, gelombang audio, transkrip berlabel pembicara muncul, di akhir catatan rapi dengan *Action items* |

- **Interaksi:**
  | Pemicu | Efek |
  |---|---|
  | Scroll | Tab aktif berubah di 25/50/75% scroll wrapper; indikator emas (bar 2 px di kiri tab) **meluncur** ke tab baru (300 ms). Stage crossfade + geser y 16 px, 500 ms; konten stage dimainkan dari awal tiap kali tab aktif |
  | Klik tab | Smooth-scroll ke posisi tab itu; konten langsung berganti |
  | Hover tab non-aktif | Teks naik ke `text-primary`, ikon berwarna agent 60% |
  | Progress | Garis tipis vertikal di sisi kiri daftar tab terisi emas sesuai progress scroll |
- **Konten stage = komponen React nyata/semi-nyata** (bukan video) agar tajam, kecil, dan bisa i18n. Untuk M: tab menjadi baris pill horizontal yang bisa di-swipe, stage di bawahnya, **tanpa sticky**; ganti tab hanya lewat tap/swipe.

### 6.6 "Workflow" (padanan *Products*: tab pill + kartu detail + kartu kecil)
- **Header:** eyebrow `[ikon workflow] WORKFLOW`, H2 `From idea to shipped`, deskripsi `Design-to-ship, one task at a time.`
- **Tab pill horizontal:** `Design` · `Build` · `QA` · `Meetings` (padanan Automation/Banking/Recruitment).
- **Kartu detail besar** (lebar penuh, kiri teks, kanan visual 560 px):

  | Tab | Judul | Poin (ikon + teks) | Visual |
  |---|---|---|---|
  | Design | Explore options before you commit | *Design option cards* · *Per-project image library* · *Attach references to any chat* | Kartu opsi desain berjajar, satu terpilih |
  | Build | Let agents work in your repo | *Link a local folder or clone with gh* · *Shell only when you allow it* · *Skills and plugins on demand* | Terminal mini + diff |
  | QA | Test in a real browser | *Run Browser QA on your local preview* · *Screenshots and a clear report* · *Pause and take over any time* | `QaReportCard` dengan centang hijau |
  | Meetings | Notes without the bot in the call | *Detects Zoom, Teams and more, asks first* · *Local Whisper transcription* · *Speaker names and an agent-written summary* | Pop-up "Catat meeting / Not now" + transkrip |

- **Empat kartu kecil di bawah** (padanan Healthcare/Marketing/Ecommerce/Development): `Solo builders`, `Design engineers`, `Freelancers`, `Small teams`, masing-pasang satu kalimat. Hover: angkat −6 px, ikon bot kecil melambai.
- **Interaksi:**
  | Pemicu | Efek |
  |---|---|
  | Klik tab pill | Pill aktif adalah **bentuk bersama** yang meluncur (layout animation 280 ms); konten lama keluar (y −12, opacity 0, 180 ms), konten baru masuk (y 16 → 0, 420 ms). Poin muncul stagger 70 ms. Visual kanan crossfade + scale .98→1 |
  | Auto-rotate | Jika pengguna tidak berinteraksi: pindah tab tiap 7 s dengan progress bar emas di bawah pill aktif. Berhenti permanen setelah interaksi pertama atau saat hover/fokus |
  | Swipe (M) | Konten swipeable dengan inersia; pill ikut bergeser |

### 6.7 "3 steps" (padanan *Steps to Use*, kartu bertumpuk)
- **Header:** eyebrow `[ikon steps] GET STARTED`, H2 `Three steps to your first agent`, deskripsi `Install, connect, hand over a task.`
- **Tiga kartu lebar** (tinggi 520 D), **menumpuk** saat scroll (setiap kartu `sticky`, top 112 + 24×index; kartu di bawah tertutup lalu mundur skala 0,96 dan redup 60%).

  | # | Judul | Deskripsi | Poin | Visual |
  |---|---|---|---|---|
  | 1 | **Install and lock it down** | One installer, no account. Set an app password and keep your recovery key safe. | *Windows installer, per user* · *App lock with scrypt* · *Recovery key shown once* | Layar `LockScreen` |
  | 2 | **Connect the models you use** | Sign in or paste a key for the providers you already pay for. | *Claude, Codex, DeepSeek, OpenRouter…* · *Keys stay encrypted here* · *Choose which models appear in chat* | Daftar provider dengan centang |
  | 3 | **Hand over a task** | Start with Chief of Staff, or add a bot to a project and give it a role. | *Say what you need in plain words* · *Switch models mid-project* · *Agents keep working while locked* | Chat dengan bot berkabel emas |

- **Interaksi:** angka besar `01 02 03` (mono, outline) di kiri tiap kartu terisi emas saat kartu menjadi aktif; kartu yang tertutup mengecil `scale(0.96)`, `filter: brightness(.6)`; visual kanan memutar loop pendek (maks 6 s) hanya saat kartu terlihat. Tombol di kartu 3: `Download for Windows`.
- **M:** tanpa sticky; kartu biasa, muncul dengan reveal standar.

### 6.8 "Privacy and security" (padanan *Data and Privacy*)
- **Header:** eyebrow `[ikon shield] PRIVACY`, H2 `Yours, on your machine`, deskripsi `Layers of protection that don't depend on our servers, because there aren't any.` (hanya benar selama tidak ada backend; tinjau ulang tiap rilis).
- **Layout D:** kiri visual **cincin konsentris** (4 cincin, bot kecil di tengah, gembok emas), kanan tiga poin berjudul:
  1. **App lock** · Password di-hash (scrypt), sesi HttpOnly, kunci otomatis saat idle.
  2. **Encrypted login vault** · Password situs dienkripsi di perangkat ini dan tidak pernah dikirim ke model AI.
  3. **Local meetings** · Audio ditranskrip di perangkat dengan Whisper; backup terenkripsi AES-256-GCM bila kamu mengisi passphrase.
- **Interaksi:** cincin digambar berurutan dari dalam ke luar (stroke-dashoffset, stagger 160 ms, 900 ms); saat hover poin kanan, cincin terkait menyala emas dan berdenyut sekali; garis tipis emas menghubungkan poin ke cincinnya (SVG path draw 300 ms). Titik kecil mengorbit pelan di tiap cincin (kecepatan beda, dijeda off-screen).

### 6.9 Bukti (pengganti *Testimonials*) — "Built in the open"
- **Alasan:** tidak ada testimoni nyata. Bagian ini diisi bukti yang benar.
- **Header:** eyebrow `[ikon git-commit] PROGRESS`, H2 `Shipping steadily`, deskripsi `Recent changes, straight from the changelog.`
- **Konten:** 2 baris marquee berlawanan arah berisi **kartu rilis** (judul commit/rilis dalam bahasa manusia + tanggal mono), mis. `Local Whisper transcription`, `Speaker names in meeting notes`, `Remote Browser with encrypted login vault`, `English / Indonesian UI`, `Start-up screen with bots on gold cables`. Diambil dari `CHANGELOG`/GitHub Releases saat build, bukan ditulis tangan.
- **Slot testimoni (disembunyikan):** komponen `Testimonial` disiapkan; tampil hanya bila ada ≥ 3 kutipan dengan izin tertulis (flag `SHOW_TESTIMONIALS`).
- **Interaksi:** marquee 60 s/loop, jeda saat hover; hover kartu menghentikan baris itu dan mengangkat kartu −4 px.

### 6.10 Download (pengganti *Pricing*)
- **Header:** eyebrow `[ikon download] DOWNLOAD`, H2 `Get Atelier`, deskripsi `Windows today. More platforms when they're ready.`
- **Layout D:** tiga kartu sejajar, kartu tengah di-highlight (padanan "Go for more power"), tinggi sama:
  | Kartu | Isi |
  |---|---|
  | **Windows 10/11** (highlight, tepi emas bergerak) | Versi, ukuran, tanggal rilis (diambil dari GitHub Releases API saat build); CTA `Download .exe`; tautan kecil `Release notes`, `SHA-256` |
  | **macOS** | Status `Not available yet`; input email opsional `Notify me` (hanya bila ada tempat menyimpan; lihat Q4) |
  | **Linux** | Sama dengan macOS |
- **Toggle:** tidak ada toggle bulanan/tahunan (tidak ada harga). Sebagai gantinya toggle kecil `Installer | Portable` **hanya jika** build portabel tersedia; kalau tidak, hilangkan.
- **Interaksi:** kartu tengah memiliki tepi `edge-glow` berputar pelan (conic 8 s); hover kartu mana pun → spotlight; klik `Download` → tombol berubah jadi `Starting download…` (cek centang sukses 1,2 s) sebelum navigasi ke URL rilis; konfeti **tidak** dipakai.
- **Catatan jujur:** tampilkan kalimat `Windows may show a SmartScreen prompt if the installer isn't code-signed yet.` bila build belum ditandatangani (Q3).

### 6.11 FAQ
- **Header:** eyebrow `[ikon help-circle] FAQ`, H2 `Questions, answered`, deskripsi `Short answers about how Atelier works.`
- **Daftar 8 akordeon:**
  1. **What is Atelier?** A Windows desktop studio where you run several AI agents with shared memory, a browser, QA and meeting notes.
  2. **Which models can I use?** Claude, OpenAI/Codex, Antigravity, DeepSeek, OpenCode and OpenRouter. You use your own accounts or API keys.
  3. **Where is my data stored?** On your computer. Atelier has no cloud account. Your chosen AI provider still receives what you send in a chat.
  4. **Do passwords go to the AI?** No. Saved site passwords are encrypted locally and are not sent to models.
  5. **How does meeting transcription work?** Whisper runs on your device. You download the engine and a model once, then audio is transcribed locally. Atelier asks before recording.
  6. **Can agents run commands on my computer?** Only if you enable shell access per project. They act with your user's permissions.
  7. **Is there a Mac or Linux version?** Not yet. Windows is the only supported platform for now.
  8. **How do updates work?** Atelier checks GitHub Releases for new versions.
- **Interaksi:** satu item terbuka sekali waktu (opsional shift-klik buka banyak); tinggi animasi 320 ms `ease-atelier`, konten fade 200 ms dengan delay 80 ms; ikon `+` berputar 45° → `×`; baris hover: latar `rgba(255,255,255,.03)`; mendukung `#hash` deep-link ke pertanyaan; `aria-expanded`, tombol `<button>` penuh baris.

### 6.12 Integrasi (padanan *Integration*)
- **Header:** `Connect the tools you already use` · `Plugins, skills and any local MCP server over stdio.` · tombol `Browse plugins` (tautan ke docs/README).
- **Visual:** **hub-and-spoke**: bot di tengah, 8–10 chip (contoh dari daftar plugin/MCP bawaan app: Brave Search, Filesystem, Knowledge graph, GitHub; **hanya yang benar-benar tersedia di app saat rilis**, cek `PluginsView`) di orbit, garis emas tipis menuju bot dengan titik data berjalan.
- **Interaksi:** titik data bergerak sepanjang garis (SVG `offset-path`, 3 s, acak); hover chip → chip membesar 1,08, garis menyala, tooltip nama; kursor menjauh → kembali. Reduced-motion: statis.

### 6.13 CTA penutup + Footer (padanan *Footer*)
- **CTA:** H2 `display-l` `Step into your studio`, sub `Everything your agents need, on one desk.`, tombol `Download for Windows` (edge-glow). Di latar: horizon emas hero muncul lagi (lebih redup) + bot kecil bergantung di kiri-kanan (loop `boot-sway`).
- **Footer 4 kolom:** `Navigation` (Features, Workflow, Privacy, Download, FAQ) · `Resources` (Changelog, GitHub, Release notes, Docs) · `Legal` (Privacy policy, Terms) · `Connect` (GitHub, X/Twitter jika ada, Email). Baris bawah: `© 2026 Atelier` kiri; kanan `Designed with Atelier` opsional.
- **Wordmark raksasa:** `ATELIER`, tinggi ±22 vw, huruf **outline** 1 px `rgba(255,255,255,.14)`, **dipotong** di tepi bawah halaman (hanya 60% atas terlihat), mirip "COSMOQ" di referensi.
- **Interaksi wordmark:** saat masuk viewport, outline **digambar** (stroke-dashoffset 1400 ms); saat pointer bergerak di atasnya, **spotlight emas** mengisi huruf di sekitar kursor (mask radial 240 px, `background-clip: text`); saat tidak ada pointer, glow bergerak pelan kiri-kanan (12 s). Di M: glow otomatis saja.

---

## 7. Komponen reusable (inventaris)

| Komponen | Varian | Catatan |
|---|---|---|
| `Button` | `glow` (CTA), `solid` (putih), `ghost`, `link` | tinggi 40/48/56; radius 16; ikon trailing bergeser 3 px saat hover |
| `Pill` / `Badge` | `status` (titik berdenyut), `chip`, `tab` | radius full |
| `Eyebrow` | ikon + label mono uppercase | warna ikon `--gold-300` |
| `SectionHeader` | 2 kolom (judul kiri, deskripsi kanan) | M: tumpuk |
| `GlassCard` | `default`, `highlight`, `stage` | spotlight prop |
| `Tabs` | `vertical` (scroll-driven), `pill` (horizontal) | indikator shared-layout |
| `Marquee` | 1 arah / 2 arah | jeda hover, jeda off-screen, mask tepi |
| `Accordion` | single / multiple | animasi tinggi |
| `StepCard` | sticky stack | |
| `WindowFrame` | bungkus mockup app | radius 16, titlebar gelap |
| `BotHanging` | panjang kabel, delay, sway, warna | turunan `BootLoader` |
| `Reveal` | `fade-up`, `words`, `lines`, `blur-in` | satu-satunya jalur animasi masuk (konsisten) |
| `ScrollWords` | teks terisi kata demi kata | |
| `BigWordmark` | outline + spotlight | |

---

## 8. Sistem motion dan katalog microinteraction

### 8.1 Token motion
| Token | Nilai |
|---|---|
| `--ease-atelier` | `cubic-bezier(0.2, 0, 0, 1)` (sudah dipakai app, default UI) |
| `--ease-out-expo` | `cubic-bezier(0.16, 1, 0.3, 1)` (reveal besar) |
| `--ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` (smooth scroll, ganti tab) |
| `--ease-spring-pop` | `cubic-bezier(0.22, 1.2, 0.36, 1)` (toast, pantulan kecil) |
| Spring (JS) | `{ stiffness: 400, damping: 32, mass: 0.8 }` untuk indikator layout; `{ stiffness: 120, damping: 20 }` untuk drag slider |
| Durasi | `instant 120` · `fast 200` · `base 320` · `slow 600` · `hero 900–1100` ms |
| Jarak reveal | `y 24` (teks), `y 40` (kartu), `y 80` (mockup) |
| Stagger | kata 60 ms · kartu 90 ms · poin 70 ms · chip 50 ms |
| Trigger masuk | `IntersectionObserver` threshold 0,3 / rootMargin `0px 0px -10% 0px`; **sekali saja** (tidak diulang saat scroll balik), kecuali elemen *scroll-linked* |

### 8.2 Spotlight kartu (pointer-follow)
- Setiap `GlassCard` menyimpan `--mx`, `--my` (px, relatif kartu) dari `pointermove` (di-throttle `requestAnimationFrame`).
- Lapisan `::before`: `background: radial-gradient(360px circle at var(--mx) var(--my), rgba(216,190,146,.14), transparent 60%)`, `opacity 0 → 1` 200 ms saat hover.
- Lapisan `::after` (border): gradien yang sama dengan `mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); mask-composite: exclude` sehingga **hanya tepi** yang menyala.
- Tidak dipasang pada perangkat `(hover: none)`.

### 8.3 Tombol edge-glow (padanan CTA cosmoq)
- Isi tombol gelap (`#0d0d11`), tepi 1,5 px berupa `--grad-gold-edge` dengan `--a` (sudut) beranimasi 0→360° lewat `@property --a` selama 6 s linier tak terbatas, **diperlambat hingga berhenti** saat idle di luar viewport.
- Hover: sudut berputar cepat 1 putaran (900 ms `ease-out-expo`), halo `box-shadow: 0 0 32px -4px var(--gold-glow)` menguat, teks bergeser 0 → −2 px dengan ikon panah masuk dari kiri (opacity 0→1, x −6→0).
- Active: `scale(0.97)` 90 ms. Fokus-visible: ring 2 px putih + offset 3.
- Kode: Lampiran A.1.

### 8.4 Katalog lengkap

| ID | Elemen | Pemicu | Efek | Durasi / easing | Reduced-motion |
|---|---|---|---|---|---|
| MI-01 | Nav | load | turun + fade | 600 ms expo | langsung tampil |
| MI-02 | Nav link | hover | highlight pill meluncur | spring 400/32 | tanpa luncur, ganti warna saja |
| MI-03 | Nav | scroll | latar menebal | 200 ms | sama |
| MI-04 | Hero H1 | load | kata-per-kata (blur→jelas) | 700 ms expo, stagger 60 | fade 150 ms |
| MI-05 | Bot hero | load | turun + pantul, lalu sway | 1,1 s + loop 3–4,5 s | statis miring |
| MI-06 | Tiang cahaya | pointer | paralaks ±12 px | lerp .08 | mati |
| MI-07 | Tiang cahaya | idle | napas opacity .7↔1 | 8–14 s alternate | mati |
| MI-08 | Hero konten | scroll | parallax .85× + fade | linked | tanpa |
| MI-09 | Mockup | scroll | naik + sedikit rotasiX 6°→0° (perspective 1400) | linked, 0–60% | tanpa rotasi |
| MI-10 | Strip provider | idle | marquee | 40 s linear | statis |
| MI-11 | ScrollWords | scroll | kata terisi | linked | langsung penuh |
| MI-12 | Kartu bento | masuk | fade-up stagger | 800 ms expo | fade 150 ms |
| MI-13 | Kartu bento | hover | spotlight + lift −4 + ilustrasi 1,03 | 200–400 ms | tanpa lift, spotlight tetap |
| MI-14 | Slider "Control" | hover/drag | berhenti auto, bisa diseret | spring 120/20 | statis |
| MI-15 | Tab vertikal | scroll | indikator meluncur + stage crossfade | 300/500 ms | tanpa luncur |
| MI-16 | Stage Agents | masuk tab | efek ketik 28 ms/karakter | — | teks penuh |
| MI-17 | Stage Memory | masuk tab | entri muncul + kompaksi | 120 ms/baris | akhir state |
| MI-18 | Stage Browser | masuk tab | kursor agent bergerak ke tombol Allow | 1,4 s ease-in-out | akhir state |
| MI-19 | Stage Meetings | masuk tab | pill rekaman bernapas + transkrip bertahap | 1,6 s | akhir state |
| MI-20 | Pill tab (Workflow) | klik | bentuk bersama meluncur + konten swap | 280 / 420 ms | tanpa luncur |
| MI-21 | Pill tab | idle | auto-rotate 7 s + progress bar | 7 s | mati |
| MI-22 | Kartu kecil | hover | lift −6 + bot melambai | 200 ms | tanpa gerak |
| MI-23 | StepCard | scroll | menumpuk, scale .96, brightness .6 | linked | normal berurutan |
| MI-24 | Angka 01/02/03 | aktif | outline → isi emas | 300 ms | sama |
| MI-25 | Cincin privasi | masuk | gambar stroke berurutan | 900 ms, stagger 160 | tampil penuh |
| MI-26 | Poin privasi | hover | cincin menyala + garis tergambar | 300 ms | sama tanpa gambar |
| MI-27 | Marquee rilis | idle/hover | jalan / jeda | 60 s | statis |
| MI-28 | Kartu Download tengah | idle | tepi conic berputar | 8 s | statis |
| MI-29 | Tombol Download | klik | `Starting download…` + centang | 1,2 s | teks saja |
| MI-30 | FAQ item | klik | tinggi + ikon putar 45° | 320 ms | instan |
| MI-31 | Hub integrasi | idle | titik data bergerak | 3 s acak | statis |
| MI-32 | Wordmark | masuk | outline tergambar | 1400 ms | tampil penuh |
| MI-33 | Wordmark | pointer | spotlight emas mengisi huruf | lerp .1 | glow statis |
| MI-34 | Tombol (semua) | hover/active | edge-glow / scale .97 | 900 / 90 ms | tanpa putar |
| MI-35 | Link teks | hover | garis bawah tumbuh dari kiri | 220 ms | ganti warna |
| MI-36 | Kursor | — | **tidak** memakai kursor kustom | — | — |
| MI-37 | Scroll progress | scroll | garis 2 px emas di atas nav terisi | linked | tetap |
| MI-38 | Bahasa EN↔ID | klik | teks crossfade 200 ms, tanpa reload; pilihan disimpan di `localStorage` | 200 ms | instan |

### 8.5 Aturan emas motion
1. **Hanya `transform` dan `opacity`** (plus `filter: blur` pada reveal teks yang pendek, ≤ 10 elemen sekaligus). Tidak ada animasi `width/height/top/left/box-shadow` terus-menerus. *Pelajaran dari riwayat repo: commit "Replace Electron shell with Tauri and fix GPU-heavy animations" dan "Stop the page freezing on the first start" menunjukkan laptop target mudah tersedak animasi berat.*
2. Semua loop **dijeda** saat di luar viewport atau tab tersembunyi.
3. Maksimum **satu** animasi "bintang" per layar, sisanya halus.
4. Gerakan menandai makna (urutan, hubungan, status), bukan hiasan.
5. `prefers-reduced-motion: reduce` → semua animasi di kolom terakhir tabel §8.4; konten dan urutan baca tidak berubah.
6. Jangan memblokir interaksi menunggu animasi selesai (tombol aktif sejak frame pertama).
7. Anggaran: ≤ 12 elemen dengan `will-change` pada satu waktu; lepas `will-change` setelah animasi masuk selesai.

---

## 9. Responsif dan perilaku per breakpoint

| Breakpoint | Lebar | Perubahan utama |
|---|---|---|
| `xl` | ≥ 1440 | Konten maks 1200, hero bleed, tiang cahaya penuh |
| `lg` | 1200–1439 | Seperti D |
| `md` | 768–1199 | Grid 8 kolom; bento 2×2 tetap, tab vertikal tetap tapi stage 480; sticky stack tetap |
| `sm` | < 768 | Satu kolom; bento 1×4; Features jadi tab pill swipeable (tanpa sticky); StepCard biasa; wordmark footer 28 vw; bot hero maksimal 2; spotlight dimatikan; marquee tetap |
| Tinggi pendek (< 700) | — | Hero `min-height: 700px`, mockup tidak mengintip |
| Cetak | — | Sembunyikan latar dan animasi, tampilkan konten teks |

Uji minimal: 1920×1080, 1440×900, 1280×720, 1024×768, 768×1024, 390×844, 360×740.

---

## 10. Arsitektur teknis

### 10.1 Rekomendasi stack
**Astro (statis) + React islands + Motion (`motion` / Framer Motion) + CSS modern.** Alasan: halaman hampir statis (SEO, LCP), interaksi dibungkus island hanya di bagian yang perlu, bisa memakai ulang komponen React app (`BotMascot`, `ProviderIcon`, `QaReportCard`) tanpa mengikat ke state app.

| Pilihan | Dipilih | Alasan |
|---|---|---|
| Framework | Astro 5 + `@astrojs/react` | HTML statis cepat, JS minimal |
| Animasi | `motion` (React) untuk reveal, layout, scroll-linked | Sudah umum, ringan dengan `LazyMotion` + `domAnimation` |
| Smooth scroll | **Tanpa Lenis** pada v1 | Hindari memotong scroll native dan risiko jank; pakai `scroll-behavior: smooth` + `scroll-padding-top` |
| Scroll-linked | `animation-timeline: view()/scroll()` (CSS) bila didukung, fallback `motion` | Compositor-driven |
| Latar hero | CSS (gradien + mask) + Canvas 2D ringan untuk noise; **WebGL hanya jika** anggaran frame lolos | Aman di iGPU |
| Ikon | `lucide-react` (tree-shaken) | Sama dengan app |
| Font | self-host woff2 Inter variable + JetBrains Mono 400 | Tanpa Google Fonts runtime |
| Analytics | Plausible/Umami self-host atau cloud, tanpa cookie | Lihat §11.5 |
| Hosting | GitHub Pages / Cloudflare Pages | Gratis, selaras dengan rilis di GitHub |

**Lokasi di repo:** workspace baru `landing/` (tambahkan ke `workspaces` di `package.json`). Token CSS diimpor dari satu file bersama `landing/src/styles/tokens.css` yang **menyalin** nilai dari `web/src/styles/tokens.css` (jangan impor langsung agar landing tidak menarik CSS app).

### 10.2 Struktur folder
```
landing/
  astro.config.mjs
  public/ (og.png, favicon.svg, fonts/, img/)
  src/
    pages/index.astro
    layouts/Base.astro
    sections/ Hero.astro Strip.astro Statement.tsx Bento.astro Features.tsx Workflow.tsx Steps.tsx Privacy.tsx Progress.astro Download.astro Faq.tsx Integrations.tsx Footer.astro
    components/ Button Pill Eyebrow GlassCard Tabs Marquee Accordion BotHanging WindowFrame Reveal ScrollWords BigWordmark
    styles/ tokens.css base.css motion.css
    content/ en.json id.json faq.json
    lib/ releases.ts (ambil rilis GitHub saat build) pointer.ts motion.ts
```

### 10.3 Data dinamis saat build
`releases.ts` memanggil GitHub Releases API (`mmonzera/atelier`) **saat build** untuk: versi terbaru, tanggal, ukuran aset `.exe`, URL unduhan, daftar changelog (§6.9). Jika gagal, build memakai `content/release.fallback.json`. Tidak ada panggilan API dari browser pengunjung.

### 10.4 i18n
`en.json` dan `id.json` dengan kunci stabil. Render **statis dua halaman** (`/` EN, `/id/` ID) untuk SEO; toggle di nav melakukan navigasi halus (View Transitions) ke halaman satunya dan menyimpan preferensi. `hreflang` + `<html lang>` benar.

### 10.5 Aset yang dibutuhkan
| Aset | Format | Catatan |
|---|---|---|
| Logo + wordmark Atelier | SVG | Ikon app sudah ada di `desktop/src-tauri/icons` |
| Bot mascot set (≥ 6 pose/warna) | SVG | Dari `BotMascot`, ekspor statis untuk fallback |
| Latar hero fallback | WebP ≤ 120 KB | Horizon + tiang cahaya |
| Screenshot app (Chat, Canon, Browser, QA, Meeting, Lock) | WebP 2×, ≤ 160 KB per gambar | Ambil dari build asli dengan data demo, **tanpa data pribadi** |
| Logo provider | SVG monokrom | Cek pedoman merek tiap provider sebelum dipakai |
| OG image 1200×630 | PNG | Headline + bot + horizon |
| Favicon | SVG + 32 px PNG | `web/public/favicon.svg` |
| Video tur 60 s (opsional) | MP4 H.264 ≤ 6 MB + poster | Dimuat saat diklik, bukan di load awal |

---

## 11. Persyaratan non-fungsional

### 11.1 Performa (anggaran)
| Item | Batas |
|---|---|
| HTML + CSS kritis | ≤ 40 KB gzip |
| JS awal (di atas lipatan) | ≤ 70 KB gzip; total halaman ≤ 180 KB gzip |
| Font | ≤ 2 file woff2, ≤ 90 KB total, `preload` hanya Inter variable |
| Gambar di atas lipatan | ≤ 200 KB total |
| Total transfer saat load awal | ≤ 600 KB |
| Frame | 60 fps scroll di laptop Ryzen 7 5700G (iGPU) |
| Island React | dimuat `client:visible`, kecuali nav dan hero `client:load` |

### 11.2 Aksesibilitas (WCAG 2.2 AA)
- Kontras teks ≥ 4,5:1 (H1/H2 ≥ 7:1). `text-muted` hanya untuk teks dekoratif ≥ 14 px bold atau label non-esensial.
- Semua interaksi dapat dipakai keyboard; urutan fokus = urutan visual; *skip to content*.
- Ring fokus terlihat di semua elemen interaktif.
- Tab scroll-driven **juga** bisa dioperasikan dengan klik/keyboard (`role="tablist"`, panah kiri/kanan).
- Marquee dan auto-rotate punya tombol **Pause** yang terlihat saat fokus, dan berhenti pada reduced-motion.
- Animasi tidak berkedip > 3 kali/detik.
- Gambar bermakna punya `alt`; dekoratif `alt=""`/`aria-hidden`.
- Akordeon, tab, dan dialog mengikuti pola WAI-ARIA APG.

### 11.3 SEO dan berbagi
- `<title>`: `Atelier — Design-to-Ship Studio for AI agents (Windows)`; meta description ≤ 155 karakter.
- Open Graph + Twitter card; JSON-LD `SoftwareApplication` (`operatingSystem: Windows`, `applicationCategory: DeveloperApplication`) **tanpa** `offers` sampai harga diputuskan.
- `sitemap.xml`, `robots.txt`, kanonik, `hreflang`.
- Semua heading hierarkis (satu H1).

### 11.4 Browser support
Chrome/Edge 110+, Firefox 115+, Safari 16.4+. Fitur progresif: `@property`, `animation-timeline`, `backdrop-filter`, `text-wrap` memiliki fallback yang layak.

### 11.5 Privasi dan analytics
- Tanpa cookie pelacak, tanpa fingerprint, tanpa iklan. Tidak perlu banner cookie.
- Event: `page_view`, `download_click`, `section_view:<id>`, `lang_toggle`, `faq_open:<id>`. Tanpa IP/ID pengguna disimpan.
- Preferensi bahasa disimpan lokal (`localStorage`), bukan cookie.
- Halaman `Privacy` menjelaskan semua di atas dalam ≤ 200 kata.

---

## 12. Kriteria penerimaan

### 12.1 Fungsional
- [ ] Semua 14 section (0–13) tampil sesuai §6 di 7 ukuran layar di §9.
- [ ] Tombol *Download* mengarah ke aset rilis terbaru, menampilkan versi dan ukuran nyata.
- [ ] Toggle EN/ID mengganti semua teks, tanpa kunci hilang.
- [ ] Tidak ada klaim di luar §3.3; tidak ada testimoni, logo pelanggan, atau angka pengguna palsu.
- [ ] Semua MI-01…MI-38 ada dan perilaku reduced-motion sesuai tabel.

### 12.2 Kualitas
- [ ] Lighthouse mobile ≥ 90 Perf, 100 A11y/SEO/BP.
- [ ] LCP ≤ 2,0 s, CLS ≤ 0,05, INP ≤ 200 ms (laboratorium, throttling 4× CPU).
- [ ] Rekaman Performance panel: tidak ada *long task* > 100 ms selama scroll penuh; GPU tidak jenuh.
- [ ] Axe/Lighthouse: 0 pelanggaran serius; uji manual dengan keyboard dan NVDA.
- [ ] Tanpa animasi saat tab di latar (CPU ≈ 0%).
- [ ] Halaman tetap utuh dan terbaca dengan JS dimatikan (konten teks, nav, CTA).

### 12.3 Kecocokan referensi (QA visual)
Dibandingkan dengan cosmoq secara berdampingan, reviewer mengecek **rasa**, bukan salinan:
- [ ] Gelap dengan satu sumber cahaya hidup di hero.
- [ ] Heading besar, tracking rapat, berat ringan.
- [ ] Kaca tipis + garis tepi halus; satu titik warna terang (tombol).
- [ ] Header 2 kolom ber-eyebrow di setiap section.
- [ ] Minimal tiga momen scroll-driven: ScrollWords, tab Features, StepCard menumpuk.
- [ ] Footer wordmark raksasa terpotong.
- [ ] Tidak ada elemen yang menyalin aset, teks, atau ilustrasi cosmoq.

---

## 13. Rencana kerja

| Fase | Isi | Keluaran | Estimasi |
|---|---|---|---|
| **P0 Fondasi** | Workspace `landing/`, token, font, `Base`, `Button`, `Reveal`, nav, i18n skeleton, CI Lighthouse | Halaman kosong dengan nav, lulus anggaran | 1–2 hari |
| **P1 Hero** | Latar CSS, bot bergantung (`BotHanging`), orkestrasi load, paralaks, fallback | Hero final + mockup mengintip | 2–3 hari |
| **P2 Inti cerita** | Strip, ScrollWords, Bento, Features (scroll-driven), Workflow | §6.2–6.6 | 3–4 hari |
| **P3 Kepercayaan** | Steps (stack), Privacy, Progress, Download (data rilis), FAQ | §6.7–6.11 | 3 hari |
| **P4 Penutup** | Integrasi, CTA, Footer + wordmark, scroll progress | §6.12–6.13 | 1–2 hari |
| **P5 Poles** | Reduced-motion, a11y, performa, OG, analytics, uji 7 viewport, QA kecocokan §12.3 | Rilis kandidat | 2–3 hari |
| **P6 Rilis** | Domain/hosting, redirect, pengumuman | Live | 0,5 hari |

Total ±13–18 hari kerja satu orang. Urutan dapat dipecah: P1 dan P2 bisa paralel setelah P0.

**Risiko dan mitigasi**
| Risiko | Mitigasi |
|---|---|
| Animasi berat di iGPU | Anggaran §8.5, WebGL opsional, uji di laptop target sejak P1 |
| Scroll-driven terasa patah di Safari/Firefox | Fallback `motion` + versi non-sticky |
| Kehilangan kejujuran (klaim melebihi produk) | Tabel §3.3 sebagai gerbang review copy |
| Screenshot membocorkan data pribadi | Pakai akun/data demo, review sebelum commit |
| Merek provider (logo) | Cek pedoman, pakai teks bila tidak boleh |
| Tidak ada rilis publik / aset `.exe` belum ada | Mode "Coming soon" + daftar tunggu; CTA tetap ada |

---

## 14. Pertanyaan terbuka (butuh keputusan)

| # | Pertanyaan | Dampak | Default yang dipakai PRD |
|---|---|---|---|
| Q1 | Atelier gratis, berbayar, atau open-source? | Menentukan §6.10 dan kata "Free" | Tidak ada harga di halaman; "Download" saja |
| Q2 | Domain dan hosting final? | Canonical, OG, analytics | GitHub Pages sementara |
| Q3 | Installer sudah ditandatangani (code signing)? | Peringatan SmartScreen | Tampilkan catatan SmartScreen |
| Q4 | Perlu daftar tunggu macOS/Linux? Disimpan di mana? | Butuh backend/form | Tanpa input email; tombol "Follow on GitHub" |
| Q5 | Repo `mmonzera/atelier` publik? Rilis dipublikasikan di sana? | Sumber unduhan dan changelog | Ya, sesuai `tauri.conf.json` |
| Q6 | Apakah boleh menampilkan nama/logo provider (Claude, OpenAI, dll.)? | §6.2, §6.12 | Ya sebagai teks "works with", cek pedoman |
| Q7 | Perlu video tur 60 s? | Aset, bobot | Opsional, ditunda ke v1.1 |
| Q8 | Bahasa default EN atau ID? | SEO, copy | EN default, ID tersedia |
| Q9 | Bagian "Coming soon: Chrome Tab" ditampilkan? | Manajemen ekspektasi | Tidak di v1; masuk roadmap saat extension rilis |

---

## Lampiran A — Snippet referensi implementasi

### A.1 Tombol edge-glow
```css
@property --a { syntax: '<angle>'; inherits: false; initial-value: 0deg; }

.btn-glow {
  --a: 0deg;
  position: relative;
  display: inline-flex; align-items: center; gap: 10px;
  height: 52px; padding: 0 26px;
  border-radius: 16px;
  color: #f4f4f6; font: 500 15px/1 var(--font-sans); letter-spacing: -0.01em;
  background: #0d0d11;
  isolation: isolate;
  transition: transform 90ms var(--ease-atelier), box-shadow 300ms var(--ease-atelier);
  box-shadow: 0 0 0 0 rgba(216,190,146,0);
}
.btn-glow::before {            /* tepi bercahaya */
  content: ''; position: absolute; inset: 0; z-index: -1; border-radius: inherit; padding: 1.5px;
  background: conic-gradient(from var(--a), #8a6d3b, #f4e2bd 18%, #d8be92 34%, #3b52ad 52%, #d8be92 70%, #8a6d3b);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor; mask-composite: exclude;
  animation: edge-spin 6s linear infinite;
}
.btn-glow:hover { box-shadow: 0 0 32px -4px rgba(216,190,146,.35); }
.btn-glow:hover::before { animation-duration: .9s; animation-iteration-count: 1; animation-timing-function: var(--ease-out-expo); }
.btn-glow:active { transform: scale(.97); }
@keyframes edge-spin { to { --a: 360deg; } }
@media (prefers-reduced-motion: reduce) { .btn-glow::before { animation: none; } }
```
*Catatan:* animasi properti kustom `--a` berjalan di main thread; batasi ke ≤ 3 tombol/kartu bersamaan dan hentikan di luar viewport (`animation-play-state: paused` lewat `IntersectionObserver`).

### A.2 Spotlight kartu
```css
.glass-card { position: relative; border-radius: 24px; overflow: hidden;
  background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08);
  backdrop-filter: blur(14px) saturate(140%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.06), 0 24px 60px -30px rgba(0,0,0,.8);
  transition: transform 300ms var(--ease-atelier), border-color 200ms var(--ease-atelier); }
.glass-card::before { content:''; position:absolute; inset:0; pointer-events:none; opacity:0;
  background: radial-gradient(360px circle at var(--mx,50%) var(--my,50%), rgba(216,190,146,.14), transparent 60%);
  transition: opacity 200ms var(--ease-atelier); }
.glass-card:hover { transform: translateY(-4px); border-color: rgba(216,190,146,.28); }
.glass-card:hover::before { opacity: 1; }
@media (hover: none) { .glass-card::before { display: none; } .glass-card:hover { transform: none; } }
```
```ts
// pointer.ts — satu listener per kartu, di-rAF
export function spotlight(el: HTMLElement) {
  let raf = 0;
  el.addEventListener('pointermove', (e) => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${e.clientX - r.left}px`);
      el.style.setProperty('--my', `${e.clientY - r.top}px`);
    });
  });
}
```

### A.3 Reveal kata-per-kata (hero H1)
```tsx
const words = text.split(' ');
<h1 aria-label={text}>
  {words.map((w, i) => (
    <motion.span key={i} aria-hidden style={{ display: 'inline-block', marginRight: '0.25em' }}
      initial={{ opacity: 0, y: 24, filter: 'blur(8px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1], delay: 0.35 + i * 0.06 }}>
      {w}
    </motion.span>
  ))}
</h1>
```

### A.4 ScrollWords (pernyataan besar)
```tsx
const ref = useRef(null);
const { scrollYProgress } = useScroll({ target: ref, offset: ['start 0.8', 'end 0.4'] });
words.map((w, i) => {
  const start = i / words.length, end = start + 1 / words.length;
  const o = useTransform(scrollYProgress, [start, end], [0.18, 1]);
  return <motion.span key={i} style={{ opacity: o }}>{w} </motion.span>;
});
```
*(Pindahkan `useTransform` ke komponen `Word` agar tidak melanggar aturan hooks.)*

### A.5 Tab scroll-driven (CSS murni, progresif)
```css
.features { height: 400vh; view-timeline-name: --feat; }
.features__stage { position: sticky; top: 96px; height: calc(100vh - 128px); }
@supports (animation-timeline: view()) {
  .features__indicator { animation: feat-step linear both; animation-timeline: --feat; animation-range: contain; }
  @keyframes feat-step { 0%{transform:translateY(0)} 33%{transform:translateY(100%)} 66%{transform:translateY(200%)} 100%{transform:translateY(300%)} }
}
```
Fallback JS: `IntersectionObserver` pada 4 sentinel setinggi 100 vh.

### A.6 Marquee tanpa jank
```css
.marquee { overflow: hidden; mask-image: linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent); }
.marquee__track { display: flex; gap: 56px; width: max-content; animation: marquee 40s linear infinite; }
.marquee:hover .marquee__track { animation-duration: 160s; }          /* melambat, tidak berhenti kaget */
@keyframes marquee { to { transform: translateX(-50%); } }             /* konten diduplikasi 2× */
```

### A.7 Wordmark outline + spotlight
```css
.wordmark { font: 600 22vw/0.8 var(--font-sans); letter-spacing: -0.06em; color: transparent;
  -webkit-text-stroke: 1px rgba(255,255,255,.14); position: relative; height: 13vw; overflow: hidden; }
.wordmark::after { content: attr(data-text); position: absolute; inset: 0; color: transparent;
  background: radial-gradient(240px circle at var(--mx,50%) var(--my,60%), #f4e2bd, #d8be92 40%, transparent 70%);
  -webkit-background-clip: text; background-clip: text; -webkit-text-stroke: 0; opacity: .9; }
```

---

## Lampiran B — Peta kepatuhan terhadap referensi

| Elemen cosmoq | Padanan Atelier | Orisinalitas |
|---|---|---|
| Aurora oranye-biru + bumi | Horizon emas + tiang cahaya + bot berkabel | Identitas Atelier |
| Nav pill kaca + CTA tepi bercahaya | Sama pola, warna emas, highlight meluncur | Pola umum, implementasi sendiri |
| Strip logo | Strip provider | Konten sendiri |
| Paragraf raksasa terisi | `ScrollWords` | Pola umum |
| Bento "Exceptionalities" | "What sets Atelier apart" (4 kartu, slider Control) | Ilustrasi sendiri |
| Tab vertikal sticky | Features (Agents/Memory/Browser/Meetings) dengan stage komponen app nyata | Konten sendiri |
| Tab pill produk | Workflow (Design/Build/QA/Meetings) | Konten sendiri |
| 3 langkah bertumpuk | 3 langkah Atelier | Konten sendiri |
| Data & Privacy berlapis | Cincin konsentris | Visual sendiri |
| Testimonials | Changelog marquee (bukti nyata) | Berbeda sengaja |
| Pricing toggle | Download (3 kartu platform) | Berbeda sengaja |
| FAQ | FAQ 8 item | Konten sendiri |
| Integration | Hub-and-spoke MCP/plugin | Visual sendiri |
| Footer wordmark terpotong | `ATELIER` outline + spotlight emas | Pola umum |
