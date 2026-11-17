# Cara membuat lembar berbingkai dari gambar Studio

Keputusan pengguna (2026-11-17): gambar tetap dibuat dan digerbang di Studio; sesudah itu agen menambahkan
lapisan luar (bingkai, rujukan zona, baris kunci, strip judul) dengan skrip, tanpa mengubah isi gambar.

## Urutan

1. Buat gambar di Studio seperti biasa sampai pratinjau DALAM dokumen tanpa cacat.
2. Render dengan `datum-studio_studio_render`, argumen `figures: ["svg"]`. Balasannya memuat daftar `figures`: satu
   butir per berkas gambar dengan `label` (nomor gambar), `blockId`, `format`, `path`, dan `sha256`. `path` adalah path
   absolut di penyimpanan Studio, di luar folder proyek: buka hanya untuk dibaca.
3. Salin SVG tiap gambar ke folder proyek (misalnya `<folder proyek>/lembar/gambar-<nomor>.svg`). Skrip hanya dijalankan
   sebagai langkah rutin bila `--svg`, `--meta`, dan `--out` semuanya di dalam folder proyek.
4. Tulis `lembar-<nomor>.json` di folder proyek berisi medan strip judul. SEMUA nilai dari register dokumen, tidak
   dikarang. Wajib: `owner`, `title` (maks dua baris, sekitar 80 karakter), `dwg_no` (pola `GSP-<PROJ>-<DISC>-<snn>`;
   digit seri: 1 ikhtisar, 2 logis, 3 denah, 4 elevasi/detail, 5 jadwal, 7 hitungan, 8 uji), `rev`, `sheet` ("n/N"),
   `classification`. Opsional: `scale` (bawaan "NTS"), `status`, `date`, `standards` (ketiganya dicetak di kaki lembar),
   dan `key` (daftar pasangan [jenis garis, arti]; jenis: data, control, sync, alert, verify, accent). Jangan menambahkan
   medan folder font: tautan font berkas lokal membuat lembar ditolak saat dipasang, dan mesin sudah memakai fontnya
   sendiri.
5. Jalankan skrip dengan perintah dari catatan Swarm di atas SKILL.md (Python bawaan dan path skrip di akar skill),
   dengan `--svg <gambar.svg> --meta <lembar.json> --out <lembar.svg>`. Skrip menolak (kode keluar 2) bila medan wajib
   kosong, nilai terlalu panjang untuk selnya, jenis garis kunci tidak dikenal, atau baris kunci melewati lebar lembar;
   perbaiki nilainya, jangan sunting skrip.
6. Pasang lembar dengan `datum-studio_studio_asset_put`: `svg` berisi teks lengkap `lembar.svg`, `width` berisi `text`
   (kolom 128 mm) atau `full` (166 mm). Mesin memeriksa SVG (skrip, tautan luar, `url()` ke berkas, dan konstruksi tak aman
   lain ditolak dengan namanya), lalu menyimpannya hanya sebagai PNG 300 dpi. Balasan menyebut blok gambar yang ditulis:
   `type: "image"`, `asset` (sha256), dan `width` yang sama. Sisipkan blok itu dengan caption berupa simpulan dan baris
   sumber, di lampiran "Lembar berbingkai".
7. Gerbang: render dokumen, lalu buka raster halaman lewat `datum-studio_studio_witness_list` (satu raster per halaman,
   beberapa halaman dalam satu langkah baca, perbesar hanya bila curiga). Periksa: tidak ada teks terpotong di strip
   judul, gambar utuh di dalam bingkai, baris kunci cocok dengan garis yang benar-benar dipakai gambar.

## Batas yang harus diketahui

- Lebar lembar = lebar gambar + 14 mm. Gambar 128 mm menjadi lembar 142 mm; dengan `width: "text"` lembar itu dicetak
  selebar kolom 128 mm (diperkecil 10 %). Gambar 166 mm menjadi lembar 180 mm dan tidak muat kolom 128 mm: dengan
  `width: "text"` ditolak `FIGURE_OVER_CAPACITY` (alasan `framed_sheet_too_wide`), tidak diperkecil. Pasang dengan
  `width: "full"`.
- Tinggi lembar = tinggi gambar + 25 mm, ditambah 6 mm bila ada baris kunci. Gambar setinggi lebih dari sekitar 216 mm
  tidak muat satu blok teks 247 mm setelah dibingkai, belum termasuk caption.
- SVG yang dipasang paling besar 2 MiB, lebar dan tinggi lembar masing-masing 10 sampai 400 mm.
- Bingkai tidak menambah isi: tabel jadwal, blok derivasi, tabel revisi, dan simbol tidak dibuat oleh skrip ini.
