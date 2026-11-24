# Memory layers di Atelier

SQLite menyimpan riwayat chat lengkap. Saat provider memulai sesi baru, Atelier
menyusun konteks dari tiga bagian dengan total perkiraan maksimal 9.500 token
riwayat, di luar pesan aktif dan instruksi agent.

| Lapisan | Isi | Perkiraan maksimum |
| --- | --- | ---: |
| Canon | Keputusan, aturan, dan referensi aset yang berlaku di scope | 1.500 token |
| Ringkasan | Goal, Decisions, Done, Open, Artifacts | 2.000 token |
| Riwayat terbaru | Pesan terbaru dengan urutan asli dan referensi lampiran | 6.000 token |
| Arsip | Pesan lengkap dan aset yang diambil lewat tool sesuai kebutuhan | 0 token secara default |

## Canon dan aset

Setiap opsi desain yang selesai dikirim tersimpan sebagai artifact. Menekan
**Pilih opsi** menyimpan pilihan di Canon dan mengirim satu pesan ke agent.
Pilihan logo SVG tersedia di `brand/logo.svg`. SVG lain menggunakan
`brand/<slug>.svg`. Jika file tujuan sudah berisi perubahan, Atelier
melindunginya dan menampilkan konflik saat memilih opsi.

Panel **Canon** di sisi kanan menampilkan keputusan dan aset dalam scope aktif.
Agent menggunakan `record_decision` untuk menyimpan keputusan yang berlaku
lintas turn dan `forget_decision` untuk melepasnya atas permintaan user.
Versi sebelumnya tersimpan saat sebuah key diganti. Canon mengutamakan aset,
aturan, dan keputusan yang dipilih atau diedit user ketika ruang prompt terbatas.

## Kompaksi dan arsip

Kompaksi menyimpan ringkasan deterministik lebih dulu. Model ringkasan dapat
memperbaikinya di background dengan batas waktu 20 detik. Provider memakai
model ringkasan ringan bawaan kecuali user mengatur `summarizerModel`.
Ringkasan lama masih bisa dimuat. Riwayat lengkap tetap tersimpan.

`search_history`, `get_message`, dan `get_artifact` tersedia lewat MCP di
Claude SDK dan lewat `atelier-action` di runner CLI. SQLite FTS5 mengindeks
pesan lama dalam batch. Build SQLite tanpa FTS5 memakai pencarian LIKE atas
1.500 pesan terbaru per scope.

Protokol dan panduan desain berada di awal prompt. Sesi native yang sehat
tetap dipakai saat kompaksi otomatis, sedangkan kompaksi manual mereset sesi.
Runner CLI mengirim instruksi terbaru pada setiap invocation. Jalur Claude SDK
juga menyisipkan pembaruan Canon saat isinya berubah selama sesi yang sama.

## Pengaturan dan migrasi

- Default kompaksi baru memicu pada 60 pesan atau 24.000 token konteks, dengan
  14 pesan disimpan untuk dipertimbangkan dalam riwayat terbaru. Profil lama
  20 pesan, 6 pesan disimpan, dan 40.000 token dimigrasikan. Profil yang
  dikustomisasi tetap memakai nilainya.
- Di Settings, **History tail tokens** mengatur jumlah token riwayat terbaru
  dari 1.000 sampai 6.000, dan **Summarizer model** menerima ID model untuk
  provider aktif. Nilai kosong memakai model bawaan.
- Tabel Canon dan artifact dibuat saat startup. File artifact disalin ke
  `data/artifacts/<scope>`. Snapshot SQLite menyertakan byte sumber agar file
  pulih saat import. Backup lama yang belum memiliki tabel tersebut tetap
  bisa diimpor. Workspace repo yang ditautkan pulih saat dipakai setelah relink.
- `usage_logs.memoryTokens` mencatat perkiraan token Canon, ringkasan, dan
  riwayat terbaru per turn. `ATELIER_LOG_LEVEL=debug` juga menulis angka yang
  sama ke log server.

Canon hanya dapat mempertahankan keputusan yang dipilih atau dicatat. Ketika
ruang prompt penuh, entri yang terpotong tetap tersedia di panel, dan riwayat
tetap bisa dicari di arsip. Perkiraan token internal menggunakan panjang teks,
sementara konteks yang dipertahankan oleh sesi native dihitung oleh provider.

## Peta implementasi

| Fase | File terkait |
| --- | --- |
| Canon dan aset | `packages/contracts/src/index.ts`, `server/src/{db,store,http,memory-files}.ts`, `server/src/backup/service.ts`, `web/src/App.tsx`, `web/src/api.ts`, `web/src/state/reducer.ts`, `web/src/components/{CanonPanel,DesignOptionsCard,RightPanel}.tsx`, `web/src/views/ChatView.tsx`, `web/src/styles/tokens.css` |
| Ringkasan dan budget | `server/src/agents/{compactor,runtime,runner}.ts`, `web/src/views/SettingsView.tsx` |
| Pencarian arsip | `server/src/{db,store}.ts`, `server/src/agents/{studio-tools,cli-runners}.ts` |
| Prompt dan sesi | `server/src/agents/{prompts,claude-runner,cli-runners,compactor,runtime}.ts` |
| Tes | `server/test/{canon,architecture,attachments-design}.test.ts` |
