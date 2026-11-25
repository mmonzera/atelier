# Plan: Nama Pembicara + Pelajaran dari Meetily

> Status: **S0–S4 diimplementasikan** (25 Nov 2026). Belum dicoba di meeting sungguhan dengan mesin yang di-download dari app.
>
> **Hasil S0 (diukur di laptop ini, bukan perkiraan):**
> - Rilis sherpa-onnx v2.0.3 `win-x64-shared-MD-Release-no-tts` (26 MB) menyertakan `bin\sherpa-onnx-offline-speaker-diarization.exe` dan `onnxruntime.dll`; jalan tanpa DLL tambahan. Opsi 1 di §3.3 dipakai.
> - Sampel dua suara Windows (David/Zira, 41 dtk): 6 dari 6 kalimat dipisah benar. 1 thread 10 dtk, 4 thread 4,8 dtk. `--clustering.cluster-threshold=0.9` menemukan 2 pembicara tanpa diberi jumlahnya.
> - Model segmentasi pyannote 3.0: LICENSE di arsip = MIT. Model suara: `3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx` (39,6 MB). TitaNet tidak dipakai karena GitHub tidak memberi digest-nya. Semua URL dan SHA-256 ada di `server/src/stt/catalog.ts`.
> - `whisper-server` b5907 mendukung `response_format=verbose_json` dengan `segments[].start/end` (detik).
> - Belum diuji: akurasi untuk suara dan bahasa Indonesia sungguhan, dan ambang Saya/Lainnya (`classifySide`) pada rekaman asli dengan dan tanpa headset.
>
> **Ditulis awalnya 25 Nov 2026 sebagai rencana untuk dikerjakan besok.**
> Pelengkap `Claude outputs/MEETING-NOTES-WHISPER-PLAN.md`. Perekaman, Whisper lokal, dan halaman Catatan meeting tetap seperti yang sudah dibangun.
> Target: transkrip menunjukkan **siapa bicara apa**, pembicara bisa diberi nama seperti di Meetily Pro, dan catatan meeting memakai nama itu (mis. "Rina: selesaikan QA hari Kamis").

---

## 1. Ringkasan

- **Fitur "Name your speakers" di Meetily hanya ada di versi Pro (berbayar).** Repo open-source-nya (lisensi MIT) tidak berisi kode diarization. Jadi kita merancang sendiri, bukan menyalin.
- **Kita punya keunggulan yang Meetily tidak punya:** shell Rust kita menangkap **mic** dan **suara laptop** secara terpisah sebelum dicampur. Meetily mencampur keduanya jadi satu aliran, sehingga tidak bisa membedakan "saya" dan "orang lain". Kita bisa, dengan murah dan secara live.
- **Untuk membedakan orang-orang lain** (Rina vs Budi di Zoom) dipakai **sherpa-onnx** (Apache-2.0): model segmentasi pyannote 3.0 (±1,5 MB versi int8) dan model "sidik suara" (embedding). Semuanya jalan lokal di CPU, tanpa Python. Mesin dan model di-download saat fitur dinyalakan, sama seperti Whisper.
- **Alur:** selama rekaman, label live hanya **Saya / Lainnya**. Setelah Selesai, Atelier menjalankan diarization sekali untuk seluruh meeting, lalu membuka dialog **Beri nama pembicara** (jumlah peserta, tombol Dengarkan, Ulangi). Setelah nama diisi, catatan meeting ditulis ulang dengan nama-nama itu.

---

## 2. Pelajaran dari Meetily

Sumber: README, `docs/architecture.md`, `audio/pipeline.rs`, `audio/vad.rs`, dan `LICENSE.md` di repo `Zackriya-Solutions/meetily`. Modul `audio/capture`, `whisper_engine`, `summary`, dan `database` belum dibaca.

| Hal | Meetily | Atelier sekarang | Ambil? |
|---|---|---|---|
| Arsitektur | Semua di Rust (Tauri), Whisper/Parakeet in-process, tanpa server terpisah | Shell Rust + server Node + `whisper-server.exe` | **Tidak.** Arsitektur kita sudah jalan dan proses Whisper terpisah lebih aman (crash tidak menjatuhkan app). |
| Pemotongan audio | Silero VAD (`silero_rs` di ONNX Runtime), segmen per ucapan, tutup setelah 500 ms hening | Energi RMS, potong di jeda setelah 18 dtk, maksimal 25 dtk | **Nanti (opsional).** VAD lebih akurat membedakan ucapan dari bising. Batas 25 dtk kita tetap perlu: Meetily punya bug ucapan panjang tanpa jeda (issue #756). |
| Mic vs suara laptop | Dicampur sebelum VAD/transkripsi | Dicampur saat potongan ditulis | **Kita lebih baik:** simpan energi per sumber (§4.1) untuk label Saya/Lainnya. |
| Perbaikan suara mic | High-pass 80 Hz, RNNoise, normalisasi -23 LUFS (mic saja) | Normalisasi puncak per potongan | **Ya, yang murah:** high-pass 80 Hz dan normalisasi terpisah per sumber, supaya suara laptop yang keras tidak menenggelamkan mic. RNNoise nanti. |
| Mesin transkripsi | Whisper + Parakeet (NVIDIA parakeet-tdt-0.6b ONNX); Vulkan di Windows | whisper.cpp CPU/BLAS | **Tidak untuk sekarang.** Parakeet terutama untuk bahasa Inggris/Eropa; dukungan bahasa Indonesia perlu dicek dulu. Vulkan tetap item Fase W0. |
| Transkrip live | Teks muncul per ucapan, dengan waktu | Teks per potongan ±20 dtk, tanpa waktu | **Ya:** timestamp per kalimat dan tampilan live (§5.1, seperti screenshot 1). |
| Impor file audio + "Enhance" (transkrip ulang) | Ada (beta) | Belum | **Nanti.** Cocok setelah diarization ada. |
| Template ringkasan, ekspor PDF/DOCX | Pro | Ekspor .md | **Nanti.** |
| Lisensi | MIT | — | Ide dan desain boleh diambil. Kalau suatu saat menyalin kode, cantumkan copyright notice-nya. |

---

## 3. Fitur Nama Pembicara: desain

### 3.1 Dua lapis

1. **Saya vs Lainnya (live, gratis).** Untuk tiap kalimat, bandingkan energi mic dan suara laptop pada rentang waktu kalimat itu.
   - Mic jauh lebih keras dan suara laptop sepi → **Saya**.
   - Suara laptop yang dominan → **Lainnya**.
   - Pakai speaker tanpa headset (mic ikut menangkap suara peserta): kalimat itu tetap **Lainnya** kalau suara laptop juga keras pada saat yang sama. Aturan persisnya ditentukan di Fase S0 dengan rekaman uji.
2. **Siapa saja "Lainnya" (setelah meeting).** Diarization sherpa-onnx atas seluruh audio meeting memberi giliran bicara `mulai – selesai – speaker_NN`. Setiap kalimat transkrip diberi pembicara berdasarkan **tumpang tindih waktu terbesar**. Cluster yang paling sering bertepatan dengan kalimat "Saya" otomatis diberi nama pengguna.

Live diarization untuk semua orang tidak dipakai di versi pertama: diarization sherpa-onnx bekerja per file utuh, dan menjalankannya terus-menerus menambah beban CPU yang baru saja kita kurangi.

### 3.2 Model (diverifikasi di Fase S0)

| Komponen | Kandidat | Ukuran | Catatan |
|---|---|---|---|
| Segmentasi | `sherpa-onnx-pyannote-segmentation-3-0` (`model.int8.onnx`) | ±1,5 MB | Dari pyannote/segmentation-3.0. **Cek file LICENSE di arsipnya** sebelum dipakai. |
| Embedding suara | `nemo_en_titanet_small.onnx` atau `3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx` | belum diketahui | TitaNet lebih cepat di dokumentasi (RTF ±0,11 vs ±0,30, 1 thread). Pilih yang lebih akurat untuk **bahasa Indonesia** di uji S0. |
| **Jangan dipakai** | `sherpa-onnx-reverb-diarization-v1` | — | Lisensi non-komersial. |

Pengaturan: `numClusters` = jumlah peserta kalau diketahui (stepper "Peserta" di dialog), atau `-1` + `threshold` kalau tidak tahu. `minDurationOn` ±0,3 dtk, `minDurationOff` ±0,5 dtk. Input harus 16 kHz mono 16-bit, cocok dengan potongan kita.

Perkiraan beban: RTF 0,1–0,3 per thread menurut dokumentasi (mesin Apple). Meeting 1 jam ≈ 6–18 menit dengan 1 thread, lebih cepat dengan 4 thread. Jalan **setelah** meeting di prioritas Below Normal, tidak selama rekaman. Angka di laptop ini diukur di S0.

### 3.3 Cara menjalankan sherpa-onnx (diputuskan di Fase S0)

Urutan preferensi:
1. **CLI prebuilt `sherpa-onnx-offline-speaker-diarization.exe`**, di-download on-demand dan dikunci SHA-256 di `catalog.ts`, sama seperti `whisper-server.exe`. Paling konsisten dengan yang sudah ada, dan crash tidak menjatuhkan server. **Belum dipastikan** apakah rilis Windows x64 menyertakan exe ini.
2. **Addon Node `sherpa-onnx-node`** (`OfflineSpeakerDiarization`, `sd.process(samples)`). **Belum dipastikan** ada binary win-x64, nama field hasilnya belum diketahui, dan addon native harus ikut dibundel ke sidecar.
3. **Helper Rust di shell** memakai C API sherpa-onnx. Pilihan terakhir karena paling banyak kerja build.

### 3.4 Menyimpan audio untuk diarization dan tombol "Dengarkan"

Sekarang potongan audio dihapus setelah ditranskrip (kecuali `keepAudio`). Diarization dan tombol Dengarkan butuh audionya:
- Saat fitur pembicara aktif, potongan **disimpan sampai pengguna menekan Selesai di dialog nama** (atau maksimal 24 jam), lalu dihapus. Pengaturan `keepAudio` tetap berlaku seperti biasa.
- **Dengarkan** memutar ±5 detik ucapan terjelas tiap pembicara, dipotong dari audio itu dan disajikan sebagai WAV oleh server.

### 3.5 Mengingat suara antar-meeting (fase lanjut, opt-in)

Simpan "sidik suara" (embedding) orang yang sudah diberi nama, supaya di meeting berikutnya nama disarankan otomatis. Ini **data biometrik**:
- Harus opt-in eksplisit dan hanya disimpan lokal.
- Bisa dihapus per orang.
- Disimpan di vault terenkripsi Atelier.

Tidak masuk build besok.

---

## 4. Perubahan pipeline

### 4.1 Shell Rust (`meeting_audio.rs`)
- Saat mencampur, hitung **RMS per 100 ms untuk mic dan suara laptop secara terpisah**. Tulis di samping tiap potongan sebagai `00001.energy.json` (±200 angka per potongan, beberapa KB), dan sertakan path-nya di `audio-chunk`.
- High-pass 80 Hz di mic dan penyeimbangan level per sumber sebelum dicampur (dari Meetily).
- Levels untuk UI gelombang tetap dari campuran.

### 4.2 Server
- **Timestamp:** minta `response_format=verbose_json` ke `whisper-server` supaya dapat segmen kalimat dengan `start/end`. Format persisnya dicek di S0. Simpan di tabel baru `meeting_segments (meeting_id, seq, idx, start_ms, end_ms, text, speaker_id)`. `start_ms` dihitung dari waktu rekaman: offset potongan dikurangi jeda pause.
- **Saya/Lainnya:** saat potongan selesai ditranskrip, baca `energy.json` dan beri label tiap segmen.
- **Diarization:** status baru `identifying` di antara `transcribing` dan `summarizing`:
  1. Gabungkan potongan menjadi satu WAV.
  2. Jalankan sherpa-onnx.
  3. Cocokkan giliran bicara ke segmen.
  4. Simpan ke `meeting_speakers (meeting_id, id, label, name, color, is_me)`.
- **Ringkasan** baru dibuat setelah pembicara ada. Prompt menyertakan transkrip berformat `[00:12] Rina: …`. Kalau nama belum diisi, pakai "Pembicara 2" dan seterusnya, lalu tawarkan **Tulis ulang catatan** setelah nama diisi.
- **Endpoint:**
  - `GET /meetings/:id/speakers`
  - `PATCH /meetings/:id/speakers/:sid` (nama)
  - `POST /meetings/:id/diarize { participants?: number }` (Ulangi)
  - `GET /meetings/:id/speakers/:sid/sample.wav`
  - `POST /meetings/:id/regenerate-notes`
- **Instalasi:** entri baru `DIARIZATION_ENGINE` dan `DIARIZATION_MODELS` di `catalog.ts`, dengan download, SHA-256, dan tombol Hapus yang sama seperti Whisper. Ini fitur opsional, tidak masuk installer.

### 4.3 Kontrak
- `MeetingTranscriptSegment` mendapat `startMs`, `endMs`, dan `speakerId`.
- `MeetingSession` mendapat `speakers[]`.
- `MeetingStatus` mendapat `identifying`.
- Pengaturan baru: `speakerLabels: boolean` (default aktif kalau model sudah terpasang).

---

## 5. UI

### 5.1 Transkrip live (screenshot 1)
- Halaman detail meeting yang sedang direkam menampilkan transkrip yang bertambah sendiri. Kolom kiri berisi waktu (`0:12`) dalam teks mono pudar, lalu chip nama pembicara berwarna (warna agent Atelier), lalu kalimatnya.
- Perekam (timer, gelombang, tombol jeda/selesai) tetap ada. Di halaman meeting ia bisa berada di bawah seperti bar kontrol di screenshot, di halaman lain tetap kartu mengambang.
- Auto-scroll ke bawah, kecuali pengguna sedang menggulir ke atas.

### 5.2 Dialog "Beri nama pembicara" (screenshot 2)
- Muncul otomatis setelah diarization selesai, dan bisa dibuka lagi dari halaman detail.
- **Peserta:** stepper − angka + dan tombol **Ulangi**, yang menjalankan diarization lagi dengan jumlah itu.
- Satu baris per pembicara: nama yang bisa diedit inline (placeholder "Pembicara 2"), titik warna, tombol **▶ Dengarkan**. "Saya" sudah terisi nama pengguna.
- Bisa **menggabungkan** dua pembicara kalau ternyata orang yang sama: pilih "Sama dengan…". Ini lebih cepat daripada Ulangi.
- Tombol **Selesai**: simpan nama, tulis ulang catatan dengan nama-nama itu, lalu hapus audio sesuai §3.4.
- Teks dan tombol lewat `t()` dengan terjemahan Indonesia. Warna dan gaya mengikuti kartu Atelier (surface-2, border, tombol putih untuk aksi utama).

### 5.3 Lainnya
- Ekspor .md: `**[0:12] Rina:** …`.
- Pencarian di halaman Catatan meeting bisa memfilter per pembicara (nanti).

---

## 6. Fase pengerjaan

### Fase S0: Spike (±1,5 jam)
- [ ] Cek aset rilis sherpa-onnx untuk Windows x64: apakah ada `sherpa-onnx-offline-speaker-diarization.exe`, dan apa saja DLL-nya. Kalau tidak ada, cek `sherpa-onnx-node` untuk win-x64. Putuskan antara opsi 1, 2, atau 3 di §3.3.
- [ ] Cek LICENSE model pyannote segmentation-3.0 dan model embedding yang dipilih.
- [ ] Rekam uji 3–5 menit di laptop ini: 2–4 orang, bahasa Indonesia, dengan dan tanpa headset. Bandingkan TitaNet vs 3D-Speaker, catat akurasi kasar dan waktu prosesnya.
- [ ] Pastikan `whisper-server` b5907 mengembalikan segmen bertimestamp (`verbose_json`) dan catat formatnya.
- [ ] Tentukan aturan energi Saya/Lainnya dari rekaman uji.
- [ ] Isi `catalog.ts` dengan URL, SHA-256, dan ukuran asli. **Jangan dikarang.**

### Fase S1: Timestamp + transkrip live (±1,5 jam)
- [ ] `verbose_json`, tabel `meeting_segments`, offset waktu (termasuk pause).
- [ ] Transkrip live di halaman detail dengan kolom waktu dan auto-scroll.

### Fase S2: Saya / Lainnya (±1 jam)
- [ ] Rust: `energy.json` per potongan, high-pass mic, level per sumber.
- [ ] Server: label per segmen dan chip di UI.

### Fase S3: Diarization setelah meeting (±2 jam)
- [ ] Instalasi on-demand sherpa-onnx dan model (catalog, installer, Settings → Meeting).
- [ ] Status `identifying`, gabung WAV, jalankan, cocokkan, simpan pembicara.
- [ ] Ringkasan memakai nama pembicara.

### Fase S4: Dialog nama (±1,5 jam)
- [ ] Dialog: stepper peserta, Ulangi, nama inline, Dengarkan, gabungkan.
- [ ] Tulis ulang catatan, ekspor dengan nama, hapus audio setelah Selesai.

### Fase S5: Uji (±1 jam)
- [ ] Test otomatis (§7) dan satu meeting sungguhan di laptop ini.

**Estimasi: ±8,5 jam**, lebih dari satu hari. Saran urutan besok: **S0 → S1 → S2** dulu (timestamp, transkrip live, Saya/Lainnya sudah sangat terasa manfaatnya), lalu S3–S4 di hari berikutnya.

### Nanti
- Silero VAD menggantikan pemotongan berbasis energi.
- RNNoise untuk mic.
- Ingat suara antar-meeting (opt-in, §3.5).
- Impor file audio dan transkrip ulang.
- Template ringkasan.

---

## 7. Test

1. **Offset waktu:** dua potongan dengan pause di antaranya menghasilkan `start_ms` segmen kedua yang benar (pause tidak dihitung).
2. **Saya/Lainnya:** `energy.json` sintetis (mic keras/laptop sepi, sebaliknya, dan keduanya keras) menghasilkan label yang diharapkan.
3. **Pencocokan giliran:** segmen yang tumpang tindih dengan dua pembicara masuk ke pembicara dengan overlap terbesar. Segmen tanpa overlap tetap tanpa pembicara.
4. **Diarization palsu:** proses pengganti mengembalikan `0.0 -- 5.0 speaker_00` dan seterusnya. Status melewati `identifying`, pembicara tersimpan, dan ringkasan memakai nama.
5. **Ulangi** dengan jumlah peserta lain menimpa pembicara lama tanpa menggandakan segmen.
6. **Ganti nama dan gabung:** segmen pindah ke pembicara gabungan, dan ekspor .md memakai nama baru.
7. **Hapus audio:** setelah Selesai di dialog (atau 24 jam), file audio hilang. Dengan `keepAudio` tetap ada.
8. **Hanya URL katalog** yang bisa di-download (sama seperti Whisper).

---

## 8. Risiko

| Risiko | Mitigasi |
|---|---|
| Exe atau addon sherpa-onnx tidak tersedia untuk Windows | Opsi 3 (helper Rust via C API). Diputuskan di S0 sebelum menulis kode. |
| Akurasi buruk untuk bahasa Indonesia atau suara mirip | Uji di S0, jumlah peserta dari pengguna, tombol Ulangi dan gabung. |
| Gema tanpa headset membuat label Saya salah | Aturan energi gabungan (§3.1), diuji di S0. Sarankan headset di UI. |
| Beban CPU | Diarization hanya setelah meeting, prioritas Below Normal. Selama rekaman hanya label Saya/Lainnya yang murah. |
| Privasi suara | Audio dihapus setelah Selesai. Sidik suara hanya opt-in dan lokal (fase lanjut). |
| Lisensi model | Hanya model dengan lisensi komersial yang jelas. Reverb-diarization tidak dipakai. |

---

## 9. Pertanyaan untuk diputuskan sebelum build

1. Simpan audio sampai dialog nama selesai (maks. 24 jam) supaya tombol **Dengarkan** bisa jalan? *(Saran: ya.)*
2. Dialog nama muncul **otomatis** setelah meeting, atau hanya lewat tombol di halaman detail? *(Saran: otomatis, bisa ditutup.)*
3. Besok mulai dari **S0 → S2** saja (timestamp, transkrip live, Saya/Lainnya), dan diarization penuh hari berikutnya? *(Saran: ya.)*
