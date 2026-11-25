# Plan: Speech-to-text Lokal (Whisper) untuk Pencatat Meeting

> Status: **diimplementasikan** (24 Nov 2026), kecuali pengukuran Fase W0 di laptop ini. Ditulis 24 Nov 2026.
>
> **Perbedaan dari rencana awal:**
> - **Mesin:** varian `cpu-x64` dan `blas-x64` (whisper.cpp b5907). Varian Vulkan tidak disertakan, jadi toggle GPU hanya muncul untuk mesin bertanda `gpu`.
> - **Potongan audio:** dipotong di jeda, bukan tepat 20 detik. Pencarian dimulai setelah 18 detik dan memotong di tengah jeda 300 ms. Kalau tidak ada jeda, dipotong paksa di titik paling sunyi antara 15–25 detik. Potongan yang isinya hening dilewati. Lag dihitung dari durasi potongan yang mengantre.
> - **Penangkapan audio:** di shell Rust (`desktop/src-tauri/src/meeting_audio.rs`, cpal + WASAPI loopback). Mic dan suara laptop dicampur ke 16 kHz mono, lalu file ditulis ke `meetings/<id>/incoming/`. Protokolnya ada di `server/src/meetings/capture.ts`.
> - **Deteksi meeting (baru):** `meeting_detect.rs` membaca registry privasi mikrofon Windows tiap 3 detik. Kalau Zoom, Teams, Webex, Slack, Skype, atau browser memakai mic, muncul pop up **Catat meeting / Nanti saja / Jangan tanya lagi**. Saat aplikasinya melepas mic selama 20 detik, muncul tawaran **Selesai catat**. Tidak pernah merekam tanpa klik.
> - **Aktivasi manual:** tombol **Mulai catat meeting** di Settings → Meeting dan menu tray **Mulai / selesai catat meeting**.
> - **Sample tes kecepatan:** ucapan bahasa Inggris dari suara Windows (`server/assets/stt-sample-id.wav`), karena di laptop ini tidak ada suara TTS Indonesia.
> - **Belum:** Fase W0 (ukur small vs turbo, 4 vs 8 thread, dengan Whisper asli) dan uji meeting 10 menit di Fase W4.
> Dokumen ini **pelengkap** `Claude outputs/MEETING-NOTES-PLAN.md`. Penangkapan audio, catatan oleh agent, UI meeting, dan data tetap seperti di plan utama. Dokumen ini menjadi acuan implementasi transkripsi meeting. Atelier menjalankan Whisper di perangkat pengguna.
> Target: **transkripsi tanpa biaya per menit**, audio yang ditangkap Atelier **diproses di perangkat**, dan Atelier **tetap ringan** (installer kecil, nol beban saat tidak dipakai).

> ⚠️ Working tree saat ini berisi pekerjaan remote browser yang belum di-commit. Jangan me-revert perubahan itu.

---

## 1. Ringkasan jawaban

- **Gratis?** Ya. Model Whisper open-source (MIT), dan mesin `whisper.cpp` juga open-source (MIT). Tidak ada biaya per menit. Yang "dibayar" hanya CPU/RAM laptop dan sekali download model.
- **Seberapa berat?** Tergantung ukuran model (§3). Di laptopmu (**AMD Ryzen 7 5700G, 8 core / 16 thread**), model kecil sampai menengah kemungkinan besar jalan lebih cepat dari real-time. Angka pastinya diukur oleh tes kecepatan bawaan (§6.3), bukan ditebak.
- **Bisa ditanam di Atelier?** Bisa, tapi **tidak dimasukkan ke installer**. Mesin dan model di-download **saat kamu menyalakan fitur ini** (sekali), lalu disimpan di folder data Atelier. Ukuran installer dasar ±42 MB menurut plan awal. Ukur kembali setelah integrasi.
- **Model Cina?** Tetap bisa untuk catatan. Whisper hanya mengubah suara jadi teks, sedangkan **catatan dan ringkasan ditulis oleh model agent-mu**, termasuk **DeepSeek**. Kombinasi *Whisper lokal + DeepSeek* sepenuhnya didukung.

---

## 2. Prinsip "tetap ringan"

| Prinsip | Cara |
|---|---|
| Installer tidak membengkak | Mesin `whisper.cpp` (±beberapa MB) dan model pilihan **di-download on-demand** dari sumber resmi, dengan persetujuanmu dan tampilan ukurannya. |
| Nol beban saat tidak dipakai | Whisper berjalan saat ada sesi Live, pekerjaan transkripsi setelah meeting, atau tes kecepatan. Setelah pekerjaan terakhir selesai, proses berhenti setelah 2 menit idle. |
| Tidak mengganggu Teams/Zoom/Meet | Proses berjalan di **prioritas rendah** (Below Normal), dengan **batas thread** (default: setengah core, maks 4). Antrean diproses berurutan, satu potongan dalam satu waktu. |
| Tetap jalan kalau laptop lemah | **Mode hemat**: tidak transkrip selama meeting. Audio dikompres dan disimpan sementara, lalu ditranskrip **setelah** meeting selesai. Catatan berjalan tidak ada, tapi ringkasan final tetap ada. |
| Tidak ada runtime tambahan | Pakai `whisper.cpp` (C++, satu binary). **Bukan** Python / PyTorch / faster-whisper, yang butuh ratusan MB dependency. |
| Mudah dilepas | Tombol **Hapus model** dan **Hapus mesin** di Settings mengosongkan semuanya. |

---

## 3. Model, ukuran, dan beban

Ukuran file dibulatkan. RAM, kecepatan, dan kualitas bahasa Indonesia merupakan perkiraan awal yang perlu diukur di Fase W0. [Katalog model whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp/tree/main)

| Model | File (±) | RAM saat jalan (±) | Kualitas bahasa Indonesia | Catatan |
|---|---|---|---|---|
| `tiny` | 75 MB | ±300 MB | Lemah | Hanya untuk laptop sangat lemah / tes |
| `base` | 142 MB | ±400 MB | Kurang | |
| `small` (q5) | ±190 MB | ±600 MB | Cukup | Pilihan ringan jika Turbo tertinggal |
| `large-v3-turbo` (q5) | ±574 MB | ±1–1,5 GB | Bagus | **Rekomendasi** untuk CPU 8 core seperti 5700G |
| `medium` (q5) | ±539 MB | ±1,2 GB | Bagus | Lebih lambat dari turbo |
| `large-v3` | ±3 GB | ±4 GB | Terbaik | Terlalu berat untuk dipakai live di CPU |

**Gambaran beban di laptopmu** (perkiraan, divalidasi di Fase W0 + tes kecepatan):
- Audio meeting dipotong per ±20 detik. Satu potongan harus selesai ditranskrip **sebelum potongan berikutnya datang**, supaya antrean tidak menumpuk.
- Di Fase W0, ukur waktu per potongan dengan 4 thread saat aplikasi meeting juga aktif. Gunakan hasilnya untuk menilai apakah transkripsi Live bisa mengejar audio secara berkelanjutan.
- Ryzen 5700G punya iGPU Radeon. `whisper.cpp` mendukung akselerasi **Vulkan**, yang bisa memindahkan sebagian kerja dari CPU, tapi dukungan dan kecepatannya di iGPU ini **belum pasti**. Itu jadi opsi yang dites di Fase W0, bukan andalan.

**Kalau tidak bisa mengejar** (antrean > 3 potongan): Atelier memberi tahu ("Transkrip tertinggal ±1 menit") dan menawarkan **pindah ke model lebih kecil** untuk sisa meeting, atau **lanjut di belakang** (catatan berjalan tertunda, ringkasan final tetap lengkap).

---

## 4. Arsitektur

1. Rust shell menangkap audio dan mengirim potongan WAV 16 kHz ke `MeetingService` di perangkat yang sama.
2. `MeetingService` menyimpan potongan yang menunggu transkripsi. Di mode Live, satu worker memprosesnya selama meeting. Di mode Hemat, worker mulai setelah pengguna menekan **Selesai**.
3. `LocalWhisperProvider` mengirim satu potongan per permintaan ke proses `whisper-server.exe` melalui `127.0.0.1`. Teks hasil transkripsi kembali ke `MeetingService`.
4. Agent menggunakan teks untuk menyusun catatan berjalan atau ringkasan final (§7).

### 4.1 Kontrak transkripsi lokal

Di `server/src/meetings/stt.ts`:

```ts
export interface SttProvider {
  prepare(): Promise<void>;
  transcribe(wav: Buffer, opts: { language: 'auto' | 'id' | 'en'; prompt?: string; signal: AbortSignal }): Promise<{ text: string }>;
  release(): Promise<void>;
}
```

`MeetingService` menggunakan `LocalWhisperProvider`. Di mode Live, panggil `prepare()` saat mulai. Di mode Hemat, panggil saat rekaman selesai. Setelah pengguna menekan **Selesai**, tutup input, proses sisa potongan, lalu panggil `release()` setelah hasil terakhir tersimpan. Ringkasan final menunggu seluruh transkrip tersimpan.

### 4.2 `LocalWhisperProvider` (`server/src/stt/local-whisper.ts`)
- **Start**: `spawn(whisperServerPath, ['-m', modelPath, '--host', '127.0.0.1', '--port', String(port), '-t', String(threads), '-l', language, ...(gpu ? [] : ['--no-gpu'])], { windowsHide: true })`.
  - Nama binary dan flag persisnya (`whisper-server.exe`, `--port`, `--no-gpu`, dan lainnya) **dicek di Fase W0** terhadap rilis `whisper.cpp` yang dipakai.
  - Port: cari port kosong (pola yang sama dengan server Atelier, `port: 0` → baca port yang dipakai, atau cari manual).
  - Tunggu sampai server siap (poll `GET /` atau endpoint health, maks 30 detik, karena memuat model butuh waktu).
- **Prioritas rendah (Windows)**: setelah spawn, jalankan `wmic process where processid=<pid> CALL setpriority "below normal"` atau pakai `os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL)` (Node mendukung `os.setPriority`, dan itu yang dipakai).
- **Transkrip**: `POST http://127.0.0.1:<port>/inference` dengan `multipart/form-data` (`file`, `response_format=json`, `temperature=0`, `prompt` untuk kosakata). Format endpoint persisnya dicek di Fase W0.
- **Satu permintaan dalam satu waktu** (antrean di `MeetingService` sudah berurutan; untuk lokal paralelisme diset ke 1).
- **Mati otomatis**: 2 menit setelah `release()` dan antrean kosong → `kill`. Juga dimatikan saat app keluar (hook shutdown yang sudah ada di `server/src/index.ts`).
- **Crash**: kalau proses mati di tengah meeting → coba start ulang sekali. Kalau gagal lagi → pindah ke **mode hemat** otomatis (simpan audio, transkrip setelah meeting) dan beri tahu pengguna.

### 4.3 Mode hemat (transkrip setelah meeting)
- Selama meeting, potongan WAV **dikompres** ke FLAC/Opus kecil (opsional; atau simpan WAV 16 kHz mono, ±1,9 MB per menit per kanal) di `dataDir/meetings/{id}/pending/`.
- Setelah **Selesai**: proses Whisper start, semua potongan ditranskrip berurutan, lalu catatan final dibuat. UI menampilkan progres "Mentranskrip 34%".
- Beri setiap potongan ID meeting dan nomor urut. Simpan hasil berdasarkan pasangan ini sebelum menghapus audio (kecuali `keepAudio`). Jika aplikasi ditutup atau mesin gagal, lanjutkan dari potongan yang belum memiliki hasil saat pengguna mencoba lagi. Tampilkan status tertunda sampai semua potongan selesai.
- Dipilih manual di Settings atau saat pengguna menekan **Lanjut nanti** ketika antrean tertinggal. Jika mesin gagal dua kali, simpan sisa potongan secara otomatis (§4.2).

---

## 5. Instalasi on-demand (mesin + model)

### 5.1 Lokasi
```
<dataDir>/stt/
  engine/<versi>/whisper-server.exe (+ DLL yang dibutuhkan)
  models/ggml-<nama>.bin
  manifest.json          ← versi mesin, model terpasang, hash, ukuran, tanggal
```
`<dataDir>` sudah ditentukan Atelier (`ATELIER_DATA_DIR`). **Tidak ikut backup** (bisa di-download ulang).

### 5.2 Sumber & integritas
- **Mesin**: rilis resmi `whisper.cpp` di GitHub (paket Windows x64; varian CPU, dan opsional Vulkan). URL dan nama paket persis dicek di Fase W0, lalu **dikunci** di kode beserta **SHA-256**-nya (`server/src/stt/catalog.ts`).
- **Model**: file `ggml-*.bin` resmi dari repositori model `whisper.cpp` di Hugging Face, juga dikunci dengan **SHA-256**.
- Download hanya dari URL yang terdaftar di `catalog.ts`, bukan dari input pengguna.
- Verifikasi hash setelah download. Kalau tidak cocok → hapus dan tampilkan error.
- Download ke file sementara `*.part`, rename setelah lengkap, dan bisa dilanjutkan (HTTP Range) kalau terputus.
- **Persetujuan pengguna**: tombol download menampilkan nama, sumber (domain), dan ukuran sebelum mulai.

### 5.3 Isi `catalog.ts`
```ts
export const WHISPER_ENGINES = [
  { id: 'cpu-x64', version: '<cek Fase W0>', url: '<github release zip>', sha256: '<…>', sizeBytes: 0, exe: 'whisper-server.exe' },
  { id: 'vulkan-x64', version: '…', url: '…', sha256: '…', sizeBytes: 0, exe: 'whisper-server.exe', gpu: true },
] as const;

export const WHISPER_MODELS = [
  { id: 'small-q5_1', label: 'Small (ringan)', url: '…', sha256: '…', sizeBytes: 0, ramMb: 600, quality: 2 },
  { id: 'large-v3-turbo-q5_0', label: 'Large v3 Turbo (disarankan)', url: '…', sha256: '…', sizeBytes: 0, ramMb: 1400, quality: 4 },
  { id: 'medium-q5_0', label: 'Medium', url: '…', sha256: '…', sizeBytes: 0, ramMb: 1200, quality: 4 },
  { id: 'base', label: 'Base (sangat ringan)', url: '…', sha256: '…', sizeBytes: 0, ramMb: 400, quality: 1 },
] as const;
```
Nilai `<…>` **wajib** diisi dengan data asli saat Fase W0. Jangan dikarang.

### 5.4 Arsitektur CPU lain
Plan ini untuk Windows x64 (yang dipakai sekarang). `catalog.ts` sudah dibuat per platform supaya versi Mac (lihat diskusi port ke Mac) tinggal menambah entri `darwin-arm64` / `darwin-x64`.

---

## 6. UI (Settings → Meeting → Speech-to-text)

Semua teks lewat `t('…')` + terjemahan di `web/src/i18n/id.ts`. Form inline, tanpa pop up.

### 6.1 Status transkripsi

Tampilkan **Whisper lokal** dan status kesiapan berdasarkan mesin serta model aktif. Jika salah satunya belum terpasang, arahkan pengguna ke tombol pemasangan yang sesuai sebelum mulai mencatat.

### 6.2 Pengaturan Whisper

- **Mesin**: status (Belum terpasang / Terpasang v… / Update tersedia), tombol **Pasang (±X MB dari github.com)**, dan pilihan **Pakai GPU (Vulkan)** dengan label "eksperimental".
- **Model**: daftar dari `catalog.ts` dengan ukuran, RAM, dan bintang kualitas. Model yang direkomendasikan untuk CPU ini ditandai. Tombol **Download** / **Pakai** / **Hapus**. Ada progress bar download (bisa dibatalkan).
- **Thread**: slider 1..(jumlah core), default `min(4, core/2)`. Teks bantu: "Lebih banyak = lebih cepat, tapi lebih berat saat meeting".
- **Mode**: *Live (catatan selama meeting)* / *Hemat (transkrip setelah meeting)*.
- **Ruang terpakai**: "Mesin 4 MB · Model 574 MB · Total 578 MB", dengan tombol **Kosongkan semua**.

### 6.3 Tes kecepatan
Tombol **Tes kecepatan** mentranskrip contoh audio 20 detik bawaan (file kecil di `server/assets/stt-sample-id.wav`, atau rekam 10 detik dari mic) dengan model terpilih, lalu menampilkan:
- "20 detik audio selesai dalam 5,2 detik (3,8× lebih cepat dari real-time) · CPU puncak ±45%"
- Rekomendasi: **Live aman** kalau ≥ 2× real-time, **Live mepet** kalau 1–2× (sarankan model lebih kecil atau lebih banyak thread), dan **Pakai mode hemat** kalau < 1×.
- Simpan hasil per versi mesin, model, jumlah thread, dan pilihan CPU/GPU. Tampilkan rekomendasi sesuai konfigurasi aktif.

Angka utama yang ditampilkan adalah **rasio real-time** (paling berguna dan mudah diukur). Persentase CPU bersifat opsional. Kalau mudah didapat dari proses Whisper di Windows, tampilkan. Kalau tidak, lewati.

### 6.4 Saat meeting
Pil rekaman (plan utama) mendapat indikator kecil: **"Transkrip lokal · tertinggal 0 dtk"**. Kalau tertinggal, muncul tombol **Ganti ke model kecil** jika modelnya sudah terpasang, atau **Lanjut nanti** untuk menyimpan sisa audio dan memprosesnya sesudah meeting.

---

## 7. Catatan oleh agent (DeepSeek dan lainnya)

Tidak ada perubahan dari plan utama §6. Catatan berjalan dan final memakai `runner.summarize(provider, model, …)` dengan **provider agent**. DeepSeek, OpenRouter, Claude, ChatGPT, dan OpenCode semua didukung lewat fungsi itu.

Supaya tidak ada data yang keluar sama sekali, kombinasi yang disarankan untuk privasi penuh adalah **Whisper lokal + model lokal** (misalnya OpenCode dengan model lokal). Itu di luar plan ini. Dengan DeepSeek/Claude/ChatGPT, **teks transkrip** tetap dikirim ke provider itu untuk dibuat catatan, tapi **audio** tidak.

---

## 8. Memberi tahu peserta

Karena AI tidak join meeting, platform tidak menampilkan tanda apa pun ke peserta. Atelier membantu dengan:
- **Pengingat** saat mulai mencatat (bisa dimatikan di Settings).
- Tombol **Salin pesan pemberitahuan** (mengikuti bahasa app):
  - ID: *"Info: saya memakai asisten AI di laptop saya untuk mencatat poin penting meeting ini. Kalau ada yang keberatan, kabari saya."*
  - EN: *"Heads-up: I'm using an AI assistant on my laptop to take notes during this meeting. Let me know if you'd rather I didn't."*
- Teks bisa diubah di Settings → Meeting.

Pemberitahuan mengikuti konfigurasi ringkasan. Jika agent memakai layanan eksternal, tambahkan pesan “Audio diproses di laptop saya. Teks transkrip dikirim ke [nama penyedia] untuk membuat ringkasan.”

---

## 9. Fase pengerjaan (tambahan di atas plan utama)

### Fase W0 — Spike (±45 menit)
- [ ] Ambil rilis `whisper.cpp` Windows x64 → pastikan ada server HTTP (`whisper-server.exe` atau nama setaranya), catat flag (`-m`, `-t`, `--host`, `--port`, `-l`, GPU on/off) dan format endpoint transkrip.
- [ ] Ukur di laptop ini (5700G): `small-q5_1` dan `large-v3-turbo-q5_0` dengan 4 dan 8 thread pada potongan 20 detik (Indonesia, Inggris, campur) → waktu, RAM, dan kualitas kasar. Catat di dokumen ini.
- [ ] Coba varian Vulkan di iGPU Radeon: jalan atau tidak, dan apakah lebih cepat.
- [ ] Isi `catalog.ts` (URL resmi, SHA-256, ukuran).
- [ ] Pastikan `os.setPriority` bekerja untuk proses anak di Windows.

### Fase W1 — Instalasi on-demand (±1 jam)
- [ ] `server/src/stt/catalog.ts`, `installer.ts` (download resumable + hash + unzip mesin), `manifest.json`.
- [ ] Routes: `GET /api/stt/local/status`, `POST /api/stt/local/install-engine`, `POST /api/stt/local/models/:id/download`, `DELETE …`, `POST /api/stt/local/cancel`. Progres lewat event WS `stt-download-progress`.
- [ ] Unzip: `tar -xf` bawaan Windows 10+ (`tar.exe`) atau unzip kecil di Node (tanpa dependency berat).

### Fase W2 — Provider lokal (±1 jam)
- [ ] `server/src/stt/local-whisper.ts` (spawn, port, health, prioritas, transcribe, release, crash → mode hemat).
- [ ] Hubungkan `MeetingService` ke `LocalWhisperProvider` melalui `SttProvider` di `meetings/stt.ts`.
- [ ] Mode hemat di `MeetingService` (simpan potongan, transkrip setelah Selesai, progres).

### Fase W3 — UI (±1 jam)
- [ ] Bagian Speech-to-text di `MeetingSettingsPanel` (§6), tes kecepatan, dan indikator tertinggal di pil rekaman.
- [ ] Terjemahan.

### Fase W4 — Uji (±45 menit)
- [ ] Test otomatis (§10) + uji manual meeting 10 menit di laptop ini: live dengan `large-v3-turbo`, dan mode hemat.

**Estimasi awal W0–W4 untuk prototipe: ±4,5 jam.** Tinjau kembali setelah W0 berdasarkan hasil pengujian Windows, instalasi, dan pemulihan antrean.

---

## 10. Test

1. **Installer**: server HTTP lokal palsu menyajikan file "model" → download, verifikasi hash, rename. Hash salah → file dihapus, error. Download terputus → lanjut dengan Range.
2. **Hanya URL dari katalog** yang bisa di-download (id tak dikenal → 404).
3. **Provider lokal dengan server Whisper palsu** (proses Node kecil yang meniru endpoint transkrip): `prepare` → start, `transcribe` → teks, `release` → proses mati setelah timeout yang dipercepat di test.
4. **Crash** server palsu di tengah → restart sekali → crash lagi → meeting pindah ke mode hemat, dan potongan tersimpan.
5. **Mode hemat**: 3 potongan disimpan selama "meeting" → setelah stop, semua ditranskrip berurutan, catatan final dibuat, dan file audio dihapus.
6. **Kosongkan semua** → folder `stt/` bersih, dan status kembali "Belum terpasang".
7. **Idle**: setelah tugas terakhir (Live, Hemat, atau tes kecepatan) selesai dan timeout berlalu, proses Whisper berhenti.
8. **Stop saat tertinggal**: klik Selesai ketika tiga potongan masih menunggu. Semua hasil tersimpan sesuai urutan sebelum ringkasan final dibuat. Tutup dan buka ulang aplikasi di tengah pemrosesan, lalu coba lagi. Setiap potongan muncul sekali di transkrip.

---

## 11. Risiko

| Risiko | Mitigasi |
|---|---|
| Laptop pengguna lain lebih lemah | Tes kecepatan + rekomendasi model + pilihan **Lanjut nanti** |
| Nama/flag `whisper-server` berubah antar versi | Versi dikunci di `catalog.ts`. Update mesin hanya lewat versi baru yang sudah dites. |
| Akurasi Indonesia/campur kurang di model kecil | Default ke `large-v3-turbo` kalau CPU sanggup. Kosakata dikirim sebagai `prompt`. |
| Antivirus menandai binary yang baru di-download | Ambil dari rilis resmi, verifikasi hash, dan tampilkan sumbernya. Kalau diblokir, tampilkan status mesin dan simpan potongan yang tertunda agar transkripsi dapat dilanjutkan setelah mesin tersedia. |
| Disk penuh | Cek ruang kosong sebelum download (ukuran × 1,2). |
| Meeting app jadi patah-patah | Prioritas rendah + batas thread + antrean satu-satu. Kalau masih terasa, kurangi thread atau pakai mode hemat. |

---

## 12. Keputusan

| # | Pertanyaan | Keputusan |
|---|---|---|
| 1 | Model default | **Large v3 Turbo** (q5). Tetap divalidasi di Fase W0. Kalau di laptop pengguna ternyata tidak mengejar, tes kecepatan menyarankan **Small**. |
| 2 | Mode default | **Live** (catatan selama meeting). Saat tertinggal, tawarkan **Lanjut nanti**. Jika restart mesin gagal, otomatis simpan potongan untuk dilanjutkan dalam mode Hemat. |
