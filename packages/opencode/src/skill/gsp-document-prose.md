---
name: gsp-document-prose
description: "Gaya bahasa dokumen serah GSP yang mudah dipahami manusia: kalimat utuh, simpulan dulu, tanpa kode internal, angka diberi arti. Pakai sebelum menulis atau menyunting prosa dokumen Studio (kajian, laporan, nota, proposal), saat menulis ringkasan eksekutif, saat lint tanda baca gagal (DATUM-03, C-26c), atau saat pembaca mengeluh tulisan sulit dipahami. Bukan untuk catatan kerja di folder docs."
---

# Gaya bahasa dokumen untuk pembaca manusia

Berlaku untuk setiap dokumen yang dibaca orang di luar tim pengerjaan: kajian, laporan, nota, proposal.
Catatan kerja di folder `docs/` boleh tetap ringkas; dokumen Studio tidak.

## 1. Siapa pembacanya

Pembaca dokumen serah adalah pejabat atau insinyur klien yang tidak ikut mengerjakan. Ia tidak tahu
apa itu B1, M4, F2, A-28, D-8, R4, G3, "rak", "controller", "baris 17", atau "rev2". Ia membaca sekali,
sering hanya ringkasan dan satu bab. Ukuran berhasil: setelah membaca satu paragraf, ia bisa
mengulang isinya dengan kata-katanya sendiri dan tahu apa yang harus ia lakukan.

## 2. Dua belas aturan

1. **Kalimat utuh.** Setiap kalimat punya subjek dan predikat. Bukan potongan catatan yang disambung
   titik, titik dua, panah, atau tanda sama dengan.
2. **Simpulan dulu, alasan sesudahnya.** Kalimat pertama paragraf menyatakan hasilnya. Kalimat
   berikutnya menjelaskan mengapa, lalu apa akibatnya bagi pembaca.
3. **Satu gagasan per kalimat, satu topik per paragraf.** Kalimat yang memuat tiga angka dan dua
   syarat dipecah.
4. **Tidak ada kode internal di kalimat.** Nomor temuan (B1, M2, m10, F2), nomor asumsi (A-28),
   nomor keputusan (D-8, C6), kode perhitungan (CALC-UAS-AVL-01), nomor baris misi, dan kata "rev2"
   tidak muncul di prosa atau judul. Bila rujukan diperlukan, tulis maknanya ("asumsi anggaran daya
   optik 20 dB, lihat Lampiran A butir 28").
5. **Tidak ada path berkas dan nomor baris di kalimat.** `KATALOG-RUMUS.md:408-416` pindah ke baris
   sumber gambar, catatan tabel, atau daftar sumber. Di kalimat cukup "menurut katalog rumus pustaka pengetahuan teknis GSP".
6. **Tidak menceritakan proses pengerjaan.** "Hasil koreksi", "tinjauan eksternal menemukan",
   "sebelumnya dihitung salah", "controller menerima" adalah riwayat kerja. Dokumen menyatakan
   keadaan yang benar sekarang. Riwayat revisi punya tempatnya sendiri di Lembar Kendali.
7. **Istilah dijelaskan sekali, lalu dipakai tetap.** Singkatan ditulis panjang pada pemakaian
   pertama. Satu hal satu nama: jangan berganti antara "ruas", "segmen", dan "span".
8. **Angka diberi arti.** Setiap angka penting diikuti satuannya dan apa artinya bagi keputusan.
   "99,9967 %" menjadi "tersedia 99,9967 %, atau terputus sekitar 17 menit dalam setahun".
9. **Batas pengetahuan ditulis sebagai kalimat biasa.** Ketiadaan sumber tetap wajib disebut,
   tetapi sebagai kalimat: "Pustaka teknis tidak memuat ambang resistans pembumian, sehingga
   nilai 5 ohm di sini adalah persyaratan pemilik, bukan ketentuan standar."
10. **Penekanan dipakai hemat.** Huruf tebal paling banyak satu frasa per paragraf. Huruf kapital
    penuh, "PERINGATAN", "BUKAN", "TIDAK ADA" tidak dipakai untuk menekan.
11. **Tanda baca tidak diakali.** Tanda pisah panjang dan titik koma tidak diganti titik di tengah
    kalimat. Bila lint menolak tanda baca, kalimatnya ditulis ulang menjadi dua kalimat yang utuh.
    Lolos lint dengan merusak kalimat dihitung sebagai gagal.
12. **Singkatan internal GSP tidak dipakai di dokumen.** "EKAS" adalah singkatan internal divisi teknis dan
    membingungkan pembaca lain. Di dokumen, judul, caption, tabel, dan laporan tulis "pustaka pengetahuan teknis GSP"
    (atau "knowledge library teknis") pada penyebutan pertama, lalu "pustaka teknis". Hal yang sama berlaku untuk
    singkatan internal lain: tulis maknanya, bukan singkatannya. Nama folder seperti `ekas-lapis-teks` hanya boleh
    muncul di daftar sumber sebagai lokasi berkas.

## 3. Contoh dari dokumen ini: naskah lama dan tulisan ulangnya

### 3.1 Pembuka ringkasan eksekutif

Naskah lama:

> Kajian disusun atas pustaka pengetahuan EKAS (lapis teks, hanya-baca) dan telah melalui tinjauan
> eksternal independen (2 BLOCKER, 8 MAJOR, 12 MINOR. seluruhnya TERKONFIRMASI/DITERIMA oleh
> controller) yang angkanya diterapkan di sini. Tangga klaim: L1 (agen-lapor), gate pemeriksaan orang
> kedua (G3) masih terbuka. tidak ada pernyataan "lulus" sebagai fakta.

Tulisan ulang:

> Kajian ini menilai apakah empat subsistem Pusat Kendali Terpadu di dua belas lokasi layak dilanjutkan
> ke tahap rancangan rinci. Seluruh angka di dalamnya adalah data uji fiktif dan tidak boleh dipakai
> sebagai dasar pengadaan. Dasar teknisnya diambil dari pustaka pengetahuan teknis GSP, dan setiap angka
> yang berasal dari luar pustaka itu diberi tanda. Perhitungan sudah diperiksa ulang oleh pihak
> kedua, tetapi belum disahkan oleh insinyur penanggung jawab, sehingga hasilnya berstatus usulan.

Yang berubah: pembaca langsung tahu tujuan dokumen, status angkanya, dan seberapa jauh ia boleh
mempercayainya. Jumlah temuan tinjauan dan istilah "tangga klaim" adalah urusan dapur tim.

### 3.2 Baris tabel temuan kunci

Naskah lama:

> Ketersediaan transport (analisis berlabel) | Seri 98,91 % · 1+1 99,9989 % · 2+1 (dua-dari-tiga)
> 99,9967 % | koreksi BLOCKER B1: 2+1 justru lebih buruk dari 1+1. rumus komposisi tidak ditemukan
> di EKAS (F2)

Tulisan ulang:

> Ketersediaan jaringan serat | Tanpa cadangan 98,91 % (terputus sekitar 96 jam per tahun). Dengan
> satu jalur cadangan per ruas 99,9989 % (sekitar 6 menit per tahun). | Jalur cadangan tunggal sudah
> cukup. Susunan tiga jalur tidak menambah ketersediaan. Rumusnya berasal dari luar pustaka teknis.

### 3.3 Paragraf ketersediaan

Naskah lama:

> PERINGATAN hasil koreksi: 2+1 lebih buruk daripada 1+1 — tiga jalur aktif memperbesar permukaan
> kegagalan. 2+1 membeli redundansi kapasitas (satu kegagalan tanpa penurunan kapasitas), bukan
> ketersediaan. Kepekaan U_seg: 0,05 %→99,9992 %. 0,2 %→99,9868 %. 0,5 %→99,9178 % (7,2 jam).
> Dilarang dikutip sebagai klaim "99,x %" tanpa persetujuan manusia.

Tulisan ulang:

> Menambah jalur ketiga tidak membuat jaringan lebih tersedia. Pada susunan dua jalur kerja dengan
> satu cadangan, layanan terganggu begitu dua dari tiga jalur putus, dan dengan tiga jalur aktif
> peluang kejadian itu lebih besar daripada pada susunan satu jalur kerja dengan satu cadangan.
> Hasilnya 99,9967 % berbanding 99,9989 %, atau sekitar 17 menit berbanding 6 menit terputus dalam
> setahun. Susunan tiga jalur layak dipilih hanya bila tujuannya menjaga kapasitas penuh saat satu
> jalur putus.
>
> Angka ini peka terhadap mutu tiap ruas. Bila ketidaktersediaan satu ruas naik dari 0,1 % menjadi
> 0,5 %, ketersediaan susunan tiga jalur turun menjadi 99,92 %, setara tujuh jam terputus per tahun.
> Karena itu angka ketersediaan di bab ini adalah hasil analisis dengan asumsi yang disederhanakan,
> dan belum boleh dikutip sebagai jaminan layanan.

### 3.4 Judul subbab

| Naskah lama | Tulisan ulang |
|---|---|
| Ketersediaan transport — seri vs 1+1 vs 2+1 (CALC-UAS-AVL-01. rev2/B1) | Ketersediaan jaringan serat pada tiga susunan jalur |
| Baterai (CALC-UAS-BAT-01. rev2/M2+M3+m4) | Kapasitas baterai untuk cadangan dua jam |
| Genset (CALC-UAS-GEN-01. rev2/M4) | Kapasitas genset |

### 3.5 Paragraf genset

Naskah lama:

> kVA ≥ P×1,2 ÷ η ÷ PF ÷ derating — basis dikoreksi: genset menanggung input UPS (bukan output).
> rumus dasar KATALOG-RUMUS.md:385-390 §10 (Mahon, PDF 136. mekanisme derating PDF 40-42 :392-394).
> derating dibagi bukan dikali

Tulisan ulang:

> Genset harus sanggup memasok daya masuk UPS, bukan hanya beban di sisi keluarannya, karena UPS
> sendiri membuang sebagian daya sebagai panas. Kapasitas tiap genset dihitung dari beban lokasi
> ditambah cadangan pertumbuhan 20 %, dibagi efisiensi UPS 0,90, faktor daya 0,80, dan faktor
> penurunan kemampuan 0,90 untuk kondisi lokasi. Untuk kantor pusat hasilnya 12,04 kVA, dan untuk
> kedua belas lokasi 30,46 kVA. Angka ini belum mencakup arus mula beban, pengisian ulang baterai,
> dan pendingin ruangan, yang baru dapat dihitung setelah lembar data pabrikan tersedia.
>
> Rumus diletakkan di blok rumus tersendiri, dan rujukannya di baris sumber.

### 3.6 Menyebut pustaka pengetahuan

| Naskah lama | Tulisan ulang |
|---|---|
| Dasar Teknis EKAS | Dasar teknis dari pustaka pengetahuan teknis GSP |
| Ambang resistans pembumian tidak ditemukan di EKAS. | Pustaka teknis tidak memuat ambang resistans pembumian, sehingga nilai 5 ohm di sini adalah persyaratan pemilik. |
| eksternal, bukan dari EKAS | sumber luar, bukan dari pustaka teknis GSP |

## 4. Uji sebelum mengirim bab

Baca tiap paragraf sebagai orang yang baru pertama kali melihat proyek ini, lalu jawab:

1. Apakah kalimat pertama sudah menyatakan hasilnya?
2. Adakah kode, singkatan (termasuk singkatan internal seperti EKAS), atau nama berkas yang tidak dijelaskan di dokumen ini?
3. Adakah kalimat yang hanya bisa dipahami oleh orang yang ikut mengerjakan?
4. Adakah kalimat tanpa subjek atau predikat, atau huruf kecil sesudah titik?
5. Apakah setiap angka penting punya satuan dan arti?
6. Apakah pembaca tahu apa yang harus ia putuskan atau lakukan?

Satu jawaban "tidak beres" berarti paragraf itu ditulis ulang, bukan ditambal.
