# DESIGN.md — Atelier

Atelier memakai gaya dark, minimal, dan tenang seperti referensi di akhir halaman: latar hampir hitam dengan tekstur titik halftone, kartu melayang ber-border tipis, dan warna hanya dipakai untuk identitas agent dan status. File ini jadi acuan desain sekaligus instruksi untuk Builder bot.

## 1. Nuansa & prinsip

Rasanya seperti ruang kerja malam yang tenang: gelap, rapi, dan percakapan dengan agent jadi pusat perhatian, sementara konteks teknis (repo, branch, port) diam di samping.

1. **Gelap dan rendah kontras di permukaan, tinggi kontras di teks.** Perbedaan antar permukaan hanya 1–3 langkah abu-abu; teks utama hampir putih.
2. **Warna = makna.** Abu-abu untuk UI. Warna hanya untuk identitas agent (titik warna) dan status. Tombol utama justru putih, bukan berwarna.
3. **Percakapan sebagai panggung.** Kolom tengah sempit (±650 px) dan lega. Pesan user dalam kartu, balasan agent berupa teks polos tanpa bubble.
4. **Kerja agent terlihat tapi tidak berisik.** Langkah kerja dilipat jadi satu baris muted ("Worked for 15s", "Thought process · Searched 1 time") yang bisa dibuka.
5. **Semua melayang.** Rail kiri, composer, dan panel kanan adalah kartu terpisah dengan sudut membulat di atas latar bertekstur, bukan panel yang menempel ke tepi jendela.
6. **Padat tapi bernapas.** Teks kecil (12–13 px), tapi jarak antar grup longgar.

## 2. Token warna

Nilai hex diambil langsung dari pixel screenshot referensi. Hanya ada satu tema: dark.

| Token | Hex | Dipakai untuk |
| --- | --- | --- |
| `bg.base` | `#0D0D11` | Latar jendela, tepi luar |
| `bg.glow` | `#18181C` | Pusat radial glow halus di belakang kolom tengah |
| `surface.1` | `#15151B` | Kartu panel kanan, rail kiri, composer |
| `surface.2` | `#1C1C23` | Bubble pesan user, kartu bersarang (misalnya kartu agent aktif) |
| `surface.3` | `#24242E` | Tombol ikon berlatar (tombol call), hover baris |
| `border.subtle` | `#262630` | Border kartu panel dan rail |
| `border.default` | `#282833` | Border bubble pesan user |
| `text.primary` | `#E4E4EA` | Isi pesan, nama item |
| `text.secondary` | `#9494A3` | Baris status ("Worked for 15s"), label grup |
| `text.tertiary` | `#8A8A98` | Deskripsi tugas agent, nomor port, metadata |
| `text.muted` | `#696976` | Label section huruf kapital (ACTIONS, PORTS) |
| `text.faint` | `#7E7E8E` | Kualifier seperti "High" di pemilih model |
| `action.primary` | `#F4F4F6` | Tombol utama bulat (kirim/stop), ikon di dalamnya `#111116` |
| `agent.green` | `#34D399` | Identitas agent 1, status running/ok |
| `agent.blue` | `#60A5FA` | Identitas agent 2, info |
| `agent.red` | `#F87171` | Identitas agent 3, error |
| `agent.amber` | `#FBBF24` | Identitas agent 4, warning/menunggu |
| `texture.dot` | `#B9B9C0` | Titik halftone di latar, opasitas 10–60% |

Di Atelier: Design bot = `agent.blue`, Builder bot = `agent.green`. Merah dan amber dipakai untuk status, bukan untuk agent baru.

## 3. Tipografi

Satu keluarga sans yang netral untuk semua teks, plus mono hanya untuk angka yang berjalan (timer, port, hash).

- **Sans:** Inter (alternatif Geist). Fallback: `-apple-system, system-ui, sans-serif`.
- **Mono:** Geist Mono atau JetBrains Mono, dengan `font-variant-numeric: tabular-nums`.
- Hanya dua weight: 400 dan 500. Tidak ada bold 600/700.

| Peran | Ukuran / line-height | Weight | Warna | Contoh di referensi |
| --- | --- | --- | --- | --- |
| Judul thread | 14 / 20 px | 500 | `text.primary` | "Ran · shipspace" |
| Isi pesan | 13.5 / 21 px | 400 | `text.primary` | Balasan agent, bubble user |
| Nama item | 13 / 18 px | 500 | `text.primary` | "Tyr", "shipspace" |
| Deskripsi item | 12.5 / 18 px | 400 | `text.tertiary` | "Table Tennis Break Room" |
| Meta / status | 12 / 16 px | 400 | `text.secondary` | "Worked for 15s", "8:15 PM" |
| Label section | 11 / 14 px, uppercase, tracking 0.06em | 500 | `text.muted` | ACTIONS, PORTS |
| Angka berjalan | 12 / 16 px mono | 400 | `text.tertiary` | "11.5s", ":5174" |

Ukuran di atas adalah estimasi dari screenshot 1440 px. Teks deskripsi panjang dipotong satu baris dengan ellipsis.

## 4. Spacing, radius, border, elevasi & motion

Kedalaman dibentuk oleh border tipis dan perbedaan abu-abu, bukan bayangan.

| Kategori | Token | Nilai |
| --- | --- | --- |
| Spacing | Skala dasar | 4 px: 4, 8, 12, 16, 20, 24, 32, 48 |
| Spacing | Padding kartu panel | 16 px |
| Spacing | Jarak antar kartu panel kanan | 8 px |
| Spacing | Jarak antar pesan | 24–32 px |
| Radius | `radius.sm` | 8 px (tombol ikon, tile avatar project) |
| Radius | `radius.md` | 12 px (bubble pesan, kartu bersarang) |
| Radius | `radius.lg` | 14–16 px (kartu panel, rail) |
| Radius | `radius.full` | 9999 px (composer, tombol kirim, titik status) |
| Border | Lebar | 1 px, warna `border.subtle` / `border.default` |
| Elevasi | Shadow | Tidak ada. Popover/menu boleh memakai `0 8px 24px rgba(0,0,0,0.5)` |
| Ukuran | Rail kiri | Lebar 48 px, ikon 20 px |
| Ukuran | Panel kanan | Lebar 270 px |
| Ukuran | Kolom percakapan | Maks 650 px, di tengah |
| Ukuran | Composer | Tinggi 52 px, tombol kirim 44 px |
| Motion | Durasi | 120 ms (hover), 200 ms (buka/tutup lipatan) |
| Motion | Easing | `cubic-bezier(0.2, 0, 0, 1)` |
| Motion | Loading | Ikon titik 2×3 berdenyut + timer mono berjalan ("Riffing… 11.5s") |

Ukuran dan durasi adalah estimasi dari screenshot; spacing dan radius dikunci di skala ini agar konsisten.

## 5. Layout Atelier dalam gaya ini

Layout mengikuti referensi: rail sempit di kiri, area kerja di tengah, dan kartu konteks bertumpuk di kanan. Chat pindah ke tengah, dan canvas jadi salah satu tab di area yang sama.

&#91;embedded content: anatomi layout Atelier · 3 kolom melayang\]

Composer tetap melayang di bawah, bahkan saat tab Canvas terbuka, jadi user bisa terus ngobrol dengan Design bot sambil melihat canvas. Layout ini menggantikan susunan "chat di panel kanan 380 px" di bagian 7 PRD.

## 6. Komponen

Setiap komponen di referensi punya padanan langsung di Atelier.

| Komponen | Spesifikasi | Padanan di Atelier |
| --- | --- | --- |
| Rail kiri | Kartu vertikal melayang, `surface.1`, `radius.lg`, ikon 20 px `text.secondary`; item aktif = tile avatar 28 px `radius.sm`. Avatar user bulat di pojok kiri bawah | Toggle sidebar, daftar project (tile), Settings |
| Header thread | Avatar agent bulat 28 px (wajah dua titik) + "Nama · project", tombol ⋯ di kanan | "Design bot · nama project" |
| Pesan user | Rata kanan, `surface.2`, border `border.default`, `radius.md`, padding 12×16 px, lebar maks 75% kolom | Instruksi ke bot |
| Balasan agent | Teks polos rata kiri, tanpa bubble | Balasan Design/Builder bot |
| Baris kerja terlipat | Chevron › + ikon + "Worked for 15s" di `text.secondary`; klik untuk membuka daftar tool call | Activity per turn (tool Penpot, git, dev server) |
| Chip agent | "Started" + titik warna 8 px + nama agent, inline di bawah balasan | "Handoff ke ● Builder bot" |
| Aksi pesan | Jam + ikon copy, branch, reply 14 px muted, muncul penuh saat hover | Copy, buat handoff, balas |
| Status berjalan | Ikon titik 2×3 + "Riffing…" + timer mono | Bot sedang bekerja |
| Composer | Pill `radius.full`, `surface.1`, border tipis; kiri: + lampiran; kanan: pemilih model, mic, tombol bulat putih (▶ kirim / ■ stop) | Kirim pesan ke bot aktif |
| Footer composer | Baris meta 12 px: checkout, branch ⌄, mesin ⌄, pemakaian (○ 4%, ◔ 42%) | Repo lokal, branch, pemakaian token |
| Kartu konteks | Kartu panel: perangkat, project (tile + nama), branch; label ACTIONS + "+ Add action" | Project: repo, branch, file Penpot |
| Kartu agent team | Kartu agent aktif bersarang (avatar, nama, model, tombol ikon), lalu daftar agent: radio, titik warna, nama, tugas terpotong, handle drag berwarna | Design bot + Builder bot dengan status dan tugas saat ini |
| Kartu ports | Label PORTS, baris ikon globe + nama server + port mono rata kanan, "Show 2 more" | Dev server preview per project |
| Scrubber percakapan | Garis-garis tick vertikal di kiri kolom, tick aktif lebih terang | Navigasi cepat ke pesan lama |

Kartu handoff mengikuti gaya kartu panel yang sama dan diletakkan di panel kanan, di antara kartu agent team dan kartu ports.

## 7. Tekstur latar halftone

Ciri paling khas referensi: pola titik halftone bergaya dithering di kiri dan kanan jendela, memudar ke kolom tengah yang bersih.

- Titik bulat `texture.dot` di grid 6 px, diameter 1–3 px. Ukuran dan opasitasnya mengikuti noise lembut yang membentuk gumpalan organik, seperti awan atau asap.
- Kepadatan tertinggi di tepi kiri bawah dan kanan bawah. Di belakang kolom percakapan (±700 px di tengah) titik memudar ke 0 lewat mask radial.
- Di atasnya ada radial glow sangat halus dari `bg.glow` di tengah ke `bg.base` di tepi.
- Implementasi: satu `<canvas>` statis di belakang layout, digambar sekali saat load dan saat resize (tidak dianimasikan), `pointer-events: none`, opasitas total ±50%.
- Kartu, rail, dan composer selalu solid di atas tekstur supaya teks tetap terbaca.
- Saat tab Canvas (Penpot) aktif, tekstur hanya terlihat di gutter sekitar area canvas.

## 8. Do & don't

| Do | Don't |
| --- | --- |
| Abu-abu untuk semua UI, warna hanya untuk agent dan status | Tombol berwarna, gradient, atau aksen brand cerah |
| Kedalaman lewat border 1 px dan beda surface | Drop shadow tebal atau glow di kartu |
| Balasan agent sebagai teks polos | Bubble chat dua sisi ala aplikasi pesan |
| Langkah kerja agent dilipat jadi satu baris | Menampilkan semua log tool secara default |
| Label section kecil huruf kapital, muted | Judul besar dan tebal di panel samping |
| Angka berjalan dalam mono tabular | Timer atau port dalam font proporsional |
| Satu tombol putih per area sebagai aksi utama | Banyak tombol primary yang bersaing |
| Ikon outline 1.5 px (Lucide atau sejenisnya) | Ikon filled atau ikon berwarna |

## 9. Referensi visual

Screenshot di bawah adalah acuan utama nuansa Atelier. Kalau ada keraguan saat mendesain atau membangun UI, ikuti screenshot ini, lalu token di atas.

&#91;image: Referensi visual Atelier: aplikasi agent bertema gelap dengan rail kiri, chat di tengah, dan kartu konteks di kanan\]
