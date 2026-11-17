# Indeks struktur dan indeks pemicu untuk knowledge library teknis

Dibuat 2026-11-17 atas permintaan pemilik: daripada memperpanjang deskripsi skill, pustaka teknis diberi dua indeks.
Menjawab K-01 (pustaka kurang terpicu di tengah misi), K-02 (cukup disebut "knowledge library teknis"), K-03 (singkatan
internal tidak dipakai ke pembaca).

## Isi folder

| Berkas | Isi | Ukuran |
|---|---|---|
| `build_kl_index.py` | pembangun kedua indeks dan pencocok (`--match`); pustaka standar Python; hanya membaca pustaka | skrip |
| `indeks_struktur.md` / `.json` | apa ada di mana: 10 folder dan perannya, 25 domain (kartu, resume, rantai jaminan), bagian katalog rumus dengan nomor baris | 3,9 KB / 40 KB |
| `indeks_pemicu.md` / `.json` | kata di tugas ke domain ke berkas dalam urutan baca, bagian katalog rumus per domain, 27 pertanyaan ke rumus | 8,3 KB / 28 KB |
| `indeks_pemicu_ringkas.md` | versi untuk badan skill: kata ke domain dan aturan baca | 2,9 KB (batas badan skill 4096 byte) |

## Dari mana isinya

Diambil otomatis dari pustaka bawaan (202 berkas): nama folder dan berkas, front matter kartu (`reference_id`, `title`,
tingkat keyakinan), bagian "Yang dipasok rujukan ini", judul bagian resume, judul bagian dan tabel "Indeks cepat" katalog rumus.

Kurasi tangan, harus ditinjau pemilik pustaka sebelum dikirim:
- `SEED`: kata pemicu Indonesia dan Inggris per domain (25 domain).
- `FORMULA_SECTIONS`: domain ke nomor bagian katalog rumus (10 domain; 15 domain lain memang tidak punya bagian rumus).
- `WEAK`: kata umum yang sendirian tidak memicu (data, model, ruang, kapasitas, dan sejenisnya).
- `FOLDER_ROLE`: satu kalimat peran tiap folder.

## Cara kerja yang diusulkan di produk

1. Saat build aplikasi, `build_kl_index.py` dijalankan terhadap pustaka bawaan. Hasilnya disimpan di akar pustaka teknis sebagai
   `INDEKS-STRUKTUR.md` dan `INDEKS-PEMICU.md` (plus `.json`). Indeks tidak pernah ditulis tangan, sehingga tidak basi saat
   pustaka bertambah.
2. Badan skill knowledge-library (`packages/opencode/src/skill/index.ts:54-84`) memuat `indeks_pemicu_ringkas.md`, bukan
   deskripsi umum. Deskripsi skill menyebut "knowledge library teknis / technical knowledge library / pustaka teknis" dan kata
   domain utama; nama folder lama tetap hanya sebagai lokasi berkas.
3. Pemicu di tengah misi tidak bergantung pada ingatan model. Saat `studio_mission_create` dan setiap `studio_mission_update_row`
   ke `running`, teks misi atau baris dicocokkan dengan `indeks_pemicu.json` (pencocokan kata utuh, sama dengan `--match`).
   Domain yang kena ditulis ke baris sebagai daftar `knowledge` (path berkas pertama per domain), dan balasan alat mengingatkan
   agen untuk membukanya. Baris yang punya daftar `knowledge` tetapi tidak membuka satu pun berkasnya ditolak saat `done`
   dengan gerbang baru (usul nama: `KNOWLEDGE_NOT_CONSULTED`), kecuali agen mencatat alasan.
4. Ringkasan auto-compact membawa daftar `knowledge` baris yang sedang berjalan, sehingga pemicu tidak hilang saat konteks dipadatkan.
5. Bahasa ke pembaca: dokumen dan laporan menulis "pustaka pengetahuan teknis GSP"; singkatan internal tidak muncul
   (aturan 12 panduan gaya bahasa).

## Yang sudah diuji dan yang belum

Diuji 2026-11-17 terhadap pustaka di aplikasi terpasang (hanya baca):
- Pembangun: 25 domain, 61 kartu, 27 pertanyaan; tidak ada domain tanpa kata pemicu atau tanpa urutan baca.
- Pencocok, teks misi proyek uji (kajian pusat kendali): kena 6 domain yang memang dipakai kajian (daya cadangan, serat optik, pembumian dan
  petir, video, jaringan, keandalan).
- Pencocok, baris misi tanpa nama pustaka ("hitung anggaran rugi ruas serat dan kapasitas penyimpanan rekaman 30 hari"): kena
  serat optik, penyimpanan, video.
- Pencocok, tugas non-teknis ("notulen rapat dan surat undangan") dan kalimat berisi kata umum saja: tidak kena apa pun.

Belum diuji: apakah Swarm benar-benar membuka pustaka lebih sering dengan indeks ini. Itu baru bisa diukur setelah butir 2
dan 3 masuk ke produk; langkah 3 adalah perubahan kode, bukan berkas. Kata pemicu belum ditinjau pemilik pustaka, dan
pencocokan kata utuh tidak mengenali imbuhan ("menghitung redaman" kena lewat "redaman", tetapi "pentanahannya" tidak kena).
