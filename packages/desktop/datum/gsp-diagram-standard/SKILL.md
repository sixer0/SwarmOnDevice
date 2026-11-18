---
name: gsp-diagram-standard
description: "Standar gambar GSP (GSP Diagram Manual, Multi-Domain, Rev B) untuk agen yang menggambar lewat DATUM Studio: prosedur kerja, pemilihan jenis gambar, tata visual, batas kapasitas mesin per family, aturan nilai kosong, aturan ringkas per domain, daftar penolakan, dan contoh rujukan. Muat sebelum membuat atau merevisi diagram, skema, topologi, SLD, rak, swimlane, sequence, atau gambar teknik apa pun di dokumen Studio; saat pengguna menyebut 'standar diagram GSP', 'Diagram Manual', 'gambar teknik', 'drawing set'; atau saat studio_figure_preview menolak dengan FIGURE_OVER_CAPACITY, DATUM-35, DATUM-25L, DATUM-26. Bukan untuk grafik data biasa (pakai kode chart) dan bukan untuk prosa (pakai gsp-document-prose)."
triggers:
  keywords: [diagram, skema, topologi, SLD, swimlane, sequence, rack, drawing set, Diagram Manual, studio_figure_preview, studio_figure_revise, FIGURE_OVER_CAPACITY, DATUM-35]
  missionTypes: [document]
---

# Standar diagram GSP untuk agen Studio

Sumber: GSP Diagram Manual, Multi-Domain, Rev B (603 halaman, 16-XI-2026) dan mesin diagram Studio di Swarm 1.3.3. Kutipan aturan ditulis dalam bahasa Inggris sesuai manual. Angka kapasitas diukur dari render nyata; tabel lengkapnya ada di resource `studio://kapasitas/diagram`. Skill pendamping: `diagram-flow` (flowchart, swimlane, BPMN), `mission-control` (bentuk panggilan alat dan baris misi), `gsp-document-prose` (kalimat caption dan prosa).

Prinsip inti manual (p490): "the model writes the content model; code validates, emits, renders and lints; a human signs." Anda juru gambar. Anda tidak memeriksa dan tidak menyetujui karya sendiri.

## 1. Prosedur kerja (urutan wajib)

1. **Pembaca dan pertanyaan.** Tulis siapa pembacanya dan satu kalimat pertanyaan yang harus dijawab gambar (PER-01). Bila kalimat itu memerlukan "dan", buat dua gambar. Bila pembaca atau pertanyaan tidak ada di permintaan, tanyakan dulu sebelum merencanakan.
2. **Rencana tiga baris.** Tulis: (a) pembaca, (b) pertanyaan satu kalimat, (c) jenis gambar dari katalog beserta alasan dan family Studio yang dipakai. Sebut juga fase, disiplin, dan level (L0 konteks sampai L4 detail). Bila fase tidak diberikan, anggap P1 untuk gambar yang dibaca klien dan P2 untuk gambar yang dipakai pemasang, lalu katakan anggapan itu.
3. **Register dulu.** Kumpulkan setiap angka, rating, tag, dan nama antarmuka ke tabel register sebelum menulis spec (MOD-01). Tiap baris: kunci, nilai, satuan, tanda provenans, sumber, dan rumus bila nilai diturunkan (MOD-02). Tanda Studio: `TERUKUR`, `DITURUNKAN`, `PEMASOK`, `ASUMSI`.
4. **Spec kedua.** Baca `studio://skema/diagram` dan `studio://skema/diagram-visio`, lalu tulis spec. Setiap simpul harus ada di register atau BoQ. Setiap garis harus berlabel isi dan besaran. Bila gambar menyalin gambar sumber, baca bagian 4.1.
5. **Validasi.** Jalankan `datum-studio_studio_figure_preview`. Gerbang mesin: `figure.defects` kosong. Pemberitahuan seperti `LABEL_MOVED`, `AUTO_FIT`, `ELK_LAYOUT`, `LABEL_LEADER`, `CAPACITY_ADAPT`, dan `P1-labels_verified` bukan cacat.
6. **Periksa sendiri, paling banyak tiga putaran.** Bandingkan hasil dengan daftar periksa bagian 9 dan aturan domain bagian 7. Perbaiki spec, bukan gambar jadi (MOD-03). Lihat lebih dulu empat kelompok temuan tersering: label garis, jejak ke register, simbol atau notasi karangan, kebenaran caption. Setelah putaran ketiga, serahkan temuan yang masih terbuka kepada manusia.
7. **Cocokkan dengan sumber sebelum render** (bagian 11.1): daftar sambungan, daftar tag, dan daftar benda wajib.
8. **Render, lalu gerbang mata** pada halaman hasil (bagian 11.2).
9. **Jangan pernah menyetujui sendiri.** Kirim selalu `labels_verified: false` (AIM-04, MOD-06); pemeriksaan label diminta kepada orang (bagian 11.4).
10. **Urutan keluaran.** Rencana tiga baris, lalu spec, lalu daftar temuan periksa sendiri, lalu daftar nilai kosong dan anggapan, lalu register perubahan terhadap sumber.

Bila diminta "desain lengkap" atau "drawing set": buat daftar gambar (drawing register) lebih dulu, satu pertanyaan per lembar, dan baru menggambar setelah daftar itu disepakati (FW-01).

## 2. Memilih jenis gambar dan family Studio HARI INI

Jawab sepuluh pertanyaan dari atas. Jawaban "ya" pertama menentukan jenis utama (Fig 3.1, p20).

| # | Pertanyaan pembaca | Jenis gambar | Family Studio dan set bentuk hari ini | Status |
|---|---|---|---|---|
| 1 | Urutan langkah dengan cabang? | Flowchart ISO 5807 | `flow` + `direction: "TB"`; `stadium`, `box`, `diamond`, `parallelogram`, `predefined`, `document` | bisa |
| 2 | SIAPA yang bertindak di tiap langkah? | Cross-functional flowchart | `swimlane` + `class.lane`; `phases[]` untuk kolom tahap atau batas waktu | bisa |
| 2b | Model proses BPMN untuk auditor? | BPMN 2.0.2 | `swimlane` + `pools[]` + `event_*`, `task`, `subprocess`, `gateway_*`, `data_object` | sebagian: tanpa message flow dan boundary event |
| 3 | Pesan antar pihak sepanjang waktu? | UML sequence | `sequence`; urutan `nodes` = aktor, urutan `edges` = waktu | bisa: tanpa activation bar dan fragmen loop/alt |
| 4 | Satu objek berubah keadaan? | State machine | `flow` atau `graph`; `stadium` untuk state, `circle` untuk awal dan akhir | sebagian: tulis "state diagram disederhanakan" |
| 5 | Rantai daya dari satu busbar? | SLD IEC 60617 | `sld`; simpul `shape: "bus"`; `symbol: "iec:breaker"` dan sejenisnya | sebagian: simbol hanya lencana di dalam kotak |
| 6 | Pemasang membangun dari posisi U? | Elevasi rak | `rack`; `class.row`, `u` | sebagian: tanpa nomor U dan tabel total |
| 7 | DI MANA letaknya, berskala? | Denah, peta, potongan, coverage | tidak ada | tidak bisa |
| 8 | Bagian masuk ke tier, zona, lapisan? | Arsitektur berlapis, zona | `layered` + `class.tier` + `zones[]`; `tiers[]` untuk label tier | bisa |
| 9 | Perangkat dan link berkapasitas? | Topologi | `topology` + `class.tier` | bisa di level konsep |
| 10 | Relasi banyak-ke-banyak? | Matriks, atau link chart | matriks: blok tabel atau chart `H-03`, `P-15`; link chart: `graph` + `route: "straight"` | sebagian |
| - | Tidak ada yang cocok | Graph, notasi dijelaskan di key row | `graph` + `class.col`, `class.row` + `legend[]` | bisa (SEL-02) |

Jenis yang sering diminta: C4 context atau container memakai `layered` + satu `zones[]` sebagai batas sistem, `cylinder` untuk penyimpanan, `sub: "[Container: Go · REST]"`. DFD memakai `graph` dengan `shadowed` untuk entitas luar. Pipeline data, video, atau ML memakai `flow` + `direction: "LR"`. Lineage dan skema property-graph memakai `graph`. Subsistem yang punya gambar sendiri memakai `doubled`. Jadwal dan garis waktu proyek memakai chart `W-07` dengan `timeUnit` (sumbu waktu bersatuan, jalur kritis, float, garis status). Anggaran kumulatif memakai chart `P-10`, satu nilai terhadap batas memakai `P-11`, KPI memakai `P-09`. RACI memakai tabel, bukan diagram.

Kapan TIDAK menggambar (SEL-04, SEL-05): daftar atribut tanpa relasi menjadi tabel. Satu angka terhadap batas menjadi chart ambang. Relasi banyak-ke-banyak di atas sekitar 15 butir menjadi matriks.

### Belum bisa digambar: katakan terus terang, jangan dipalsukan

Bila permintaan jatuh ke daftar ini, tulis kalimat "Mesin diagram Studio belum dapat menggambar <jenis> menurut standar GSP" lalu tawarkan pengganti yang jujur (tabel, chart, atau gambar level konsep yang diberi label sebagai penyederhanaan). Jangan menulis SVG tangan, jangan memakai gambar raster buatan, jangan menyebut swimlane sebagai BPMN, dan jangan menyebut diagram sebagai peta.

- Tabel revisi dan awan revisi pada lembar. Bingkai, zona grid, baris kunci, dan strip judul dibuat dengan skrip sesudah gambar lolos (bagian 12).
- Tabel, blok derivasi, atau panel DEFECT/CORRECTED di dalam gambar. Pengganti: blok tabel tepat di bawah gambar, dirujuk dari caption.
- Semua gambar berskala (denah, elevasi, potongan, dimensi, scale bar, panah utara, coverage kamera) dan peta bergrid koordinat.
- Plot teknik: profil lintasan radio, jejak OTDR, pola antena, rencana spektrum, diagram waktu.
- P&ID, PFD, ladder, FBD, GRAFCET, skema rangkaian, sirkuit hidraulik, logika IEC 60617-12.
- UML class, ER crow's foot, SysML, ArchiMate, IDEF0, state komposit, gerbang AND/OR attack tree, RBD.
- BPMN kolaborasi sesungguhnya (message flow antar pool, boundary event, ekspor XML).
- DFD dengan batas kepercayaan berupa GARIS yang memotong aliran; Studio hanya punya bingkai zona.
- Matriks sebagai gambar (cause-and-effect, N², DSM, RACI, risiko 5 x 5, ATT&CK berarsir); Gantt dengan panah ketergantungan antar tugas (`W-07` punya batang, tonggak, jalur kritis, dan float, tanpa panah).
- Diagram splice satu baris per fiber, matriks alokasi fiber, skema strip chainage.
- SLD di atas 24 simbol atau dengan simbol sebagai bentuk simpul; rak di atas 23U dalam satu gambar; zona bersarang; lencana ID terpisah dari label.

## 3. Tata visual dalam angka dan token

**Enam jenis garis (GRM-01).** Pola membawa arti lebih dulu, warna kedua.

| `kind` | Arti | Pola | Warna |
|---|---|---|---|
| `data` | sesuatu berpindah: video, paket, daya, dokumen | utuh, kepala terisi | ink900 |
| `control` | perintah, pemicu, orkestrasi | putus-putus, kepala terbuka | ink700 |
| `sync` | replikasi, mirror, heartbeat | titik-titik | ink400 |
| `accent` | SATU jalur yang tidak boleh terlewat | utuh, lebih tebal | signal `#B45309` |
| `alert` | gagal, ditolak, jalur pengecualian | putus panjang | alert `#9B1C1C` |
| `verify` | cek integritas, atestasi, audit | garis-titik | verd `#2F6F6B` |

- Satu aksen per gambar, pada unsur yang disebut simpulan caption (PER-04). Studio: paling banyak satu garis `kind: "accent"` (`DATUM-26`); simpul subjek memakai `class.accent: true`.
- Paling banyak lima nilai warna, tanpa biru, merah hanya untuk kegagalan, hijau-teal hanya untuk yang terverifikasi (GRM-06). Studio menghitungnya pada SVG (`DATUM-25`): seluruh ramp tinta netral dihitung satu, jadi `data`, `control`, dan `sync` tidak menambah warna; signal, alert, dan verd masing-masing satu; glif tanda provenans tidak dihitung.
- Keenam jenis garis boleh dipakai bersama: `DATUM-25L` mengizinkan sampai enam gaya garis (`kind` + `dash` + `weight`). Di atas empat gaya, dua gaya yang tercetak sama (pola, warna, dan tebal) ditolak; beri pola lain.
- Tanpa isian warna pejal. Isian adalah arsir yang menandai kategori bernama, paling banyak tiga pola, masing-masing disebut di key row (PER-07, GRM-08). Studio hanya punya dua arsir: `class.accent` (45 derajat) dan `class.secondary` (135 derajat).
- Satu notasi per gambar (M-04, GRM-02). Studio menolak campuran (`DATUM-35`): bentuk ISO 5807 tidak boleh bercampur dengan bentuk BPMN, `doubled`, `shadowed`, atau `bus`. Bentuk universal yang boleh di mana saja: `box`, `cylinder`, `circle`, `annotation`.
- Kotak biasa bersudut tajam. Hanya terminator (`stadium`) yang membulat.
- Jangan mengarang simbol standar (GRM-03). Bila simbol tidak ada di pustaka (`iec:` 16, `isa:` 12, `sec:` 7, `mil:` 6), pakai kotak berlabel dan katakan bahwa itu blok sederhana. Satu dialek per gambar. Simbol `sec:` adalah legenda rumah GSP: tulis "house legend, not a standard" di key row.
- Huruf paling kecil 5,5 pt, garis paling tipis 0,18 mm. Lebar gambar 128 mm (`text`) atau 166 mm (`full`), tidak ada nilai di antaranya. Lebar dipilih per gambar dengan `width` pada blok diagram (bukan di `spec`); tanpa `width`, lebar mengikuti templat. Kapan memilih `full`: bagian 5.

**Label (DOC-03, GRM-05).** "Labels name what flows and how much. 'Data', 'link', 'connect' are not labels." Label terlarang: data, link, connect, line, uses. Pemisah bagian label ` · `, tanda kali `×`, spasi antara nilai dan satuan (`6 Mb/s`, `30 °C`). Contoh benar: `RTSP H.265 · 6 Mb/s`, `2 × 25G OS2`. Label simpul menyebut bendanya dan ratingnya: `label` untuk nama, `sub` untuk rating, `tag` untuk ID kebutuhan (`REQ-NET-03`) atau designasi IEC 81346 (`=G01-QA1`). Tanpa garis bawah pada tag, label, dan nomor gambar (FW-12), kecuali nama yang dikutip dari sistem lain seperti variabel PLC. Bila label garis tidak bisa ditulis, garis itu tidak semestinya ada atau dua simpul itu satu.

**Caption sebagai simpulan (DOC-01).** Satu kalimat berakhir titik yang menyatakan simpulan, bukan topik. Salah: "Network diagram". Benar: "Every remote post reaches the hub over two independent paths, microwave and VSAT". Caption hanya mengklaim apa yang terlihat di gambar, di key row, di baris CATATAN, atau di tabel tepat di bawahnya. Bila masukan penentu masih anggapan, caption mengatakannya ("clearance depends on the canopy survey"). Jangan awali caption dengan "Gambar n.m"; nomor dibuat Studio.

**Baris sumber (DOC-02).** Sebut dokumen dan klausul asal, lalu provenans angka penentu, misalnya `Kajian 004 §4.2 Tabel 4.6; kapasitas [PEMASOK, B2]`. Tidak perlu mengawali dengan kata SUMBER; mesin mencetak labelnya sendiri. Sebut edisi standar hanya dari Lampiran A manual atau dari bahan tugas, jangan dari ingatan (AIM-06).

**Key row (GRM-09).** Legenda adalah satu baris di kaki gambar, hanya bila pola atau simbol perlu dijelaskan. Isi `legend[]`. Tanda provenans pada simpul mewajibkan baris key (`DATUM-34`).

**Arah baca (PER-05).** Aliran dan pipeline kiri ke kanan; hierarki, tier, dan daya atas ke bawah.

## 4. Pemetaan field Appendix D ke Studio

Spec Appendix D (p601) tidak sama dengan spec v2 Studio. Pakai kolom kanan.

| Appendix D | Studio v2 hari ini |
|---|---|
| `title` | `caption` pada blok diagram (bukan di `spec`) |
| `sources[]` | `source` pada blok, dan `spec.sources[]` |
| `width_mm` | `width: "text"` atau `"full"` pada blok diagram |
| `id`, `lang`, `apparatus` | tidak diterima di spec v2; diisi Studio dari dokumen dan templat. Blok diagram diberi `id` sendiri bila dirujuk penghubung `offpage` |
| `tiers[] {id,label,note}` | `tiers[] {tier, label}`, dicetak di pita kiri untuk `layered` dan `topology` saja (family lain ditolak `P1-tiers`); posisi tetap dari `class.tier` |
| `nodes[].tier/lane/col/row` | `class.tier`, `class.lane`, `class.col`, `class.row` |
| `nodes[].accent: true` | `class.accent: true` |
| `nodes[].desig` | tidak ada; tulis di `tag` |
| `nodes[].mark: "PEMASOK"` | `mark` (TERUKUR, DITURUNKAN, PEMASOK, ASUMSI) + baris key |
| `boundaries[] {label, nodes[]}` | `zones[] {id, label, members[]}` |
| `{{register.key}}` | tidak ada; token `{{...}}` yang tersisa ditolak `PLACEHOLDER_UNFILLED` di pratinjau, lint, dan render. Tulis nilainya dari register dan sebut kuncinya di baris sumber |
| `notes[]` | dicetak sebagai baris CATATAN di kaki gambar |
| `legend[] {symbol,label}` | `legend[]`; bila blok juga punya `keyRow`, hanya `legend[]` yang dicetak (`KEYROW_SUPERSEDED`) |
| `labels_verified` | agen selalu mengirim `false`; `true` dari agen ditolak `LABELS_VERIFIED_PERSON_ONLY`. Nilai `false` membuat gambar berstatus draf sampai orang memeriksanya (bagian 11.4) |

Setiap simpul memerlukan `class` (boleh `{}`), setiap garis memerlukan `from`, `to`, `kind`, `label`.

### 4.1 Gambar sumber yang ditolak mesin apa adanya

Gambar manual sendiri bisa melanggar aturan mesin. Contoh Gambar 16.6: garis WAN ke FED-01 tanpa label dan wadah WAN tanpa anggota di lembar itu. Mesin menolak keduanya, dan penolakan itu tetap berlaku:

- **Garis tanpa label** ditolak `DATUM-24`. Tulis label dari isi yang benar-benar mengalir menurut teks sumber atau register (misalnya `WAN · <media> · <kecepatan>`). Bila tidak diketahui, tulis `TBC · <kunci register>`. Jangan mengarang besaran.
- **Wadah tanpa anggota** ditolak `P5-zone` ("zona ... tanpa anggota dikenal"). Jangan menggambar wadah kosong. Gambar isinya sebagai satu simpul berlabel (misalnya `WAN operator`), atau, bila isinya ada di gambar lain, sebagai penghubung `offpage` ke gambar itu.
- Catat setiap penyimpangan dari sumber di register perubahan beserta alasannya, misalnya "label ditambahkan: sumber tanpa label (DATUM-24)" atau "wadah WAN di luar lembar (P5-zone)".

## 5. Kapasitas, lebar, dan pemecahan gambar

Tabel lengkap per family dan lebar ada di resource `studio://kapasitas/diagram`. Tabel itu dibangkitkan dari render nyata; baca di sana, jangan menyalin angka dari ingatan. Ringkasan batas yang lolos pratinjau dan render tanpa cacat, 128 mm (`text`) / 166 mm (`full`):

- **Melebar:** `layered`, `topology`, `stack` 3 / 4 simpul per tier; `sld` 3 / 4 cabang per rel; `flow` TB 4 / 5 simpul per rank; `flow` LR 3 / 4 rank (6 simpul per rank); `graph` 4 / 5 kolom; `swimlane` 3 / 4 simpul per lane; `sequence` 6 / 8 lifeline.
- **Meninggi, sama di kedua lebar:** `layered` 6 tier; `topology` dan `stack` 9 tier; `flow` tanpa `direction` 9 simpul; `flow` TB 7 rank; `sequence` 15 pesan; `graph` 10 baris; `rack` 23U.
- **Batas keras semua family:** 24 simpul, 48 garis, 24 zona, 8 phase, 4 pool, tinggi 247 mm termasuk caption dan sumber.
- **Label tier memakan lebar.** `tiers[]` menyisakan pita di kiri. Label sependek satu huruf tidak mengubah apa pun pada 128 mm; label lebih panjang (misalnya "Tier 2 · Polda") mengurangi satu simpul per tier, dan pada 166 mm setiap label tier mengurangi satu.

Mesin menolak, tidak memampatkan: `FIGURE_OVER_CAPACITY` dengan id cek (`DATUM-33` tinggi, `DATUM-37-sheet` lebar lembar, `DATUM-37-rank`, `DATUM-37-lebar`). Penolakan lain: `DATUM-35` notasi bercampur, `DATUM-26` aksen lebih dari satu, `DATUM-25L` gaya garis, `DATUM-24` garis tanpa label, `DATUM-34` tanda tanpa key row, `E-17` SLD tanpa `bus`. Untuk cacat `GEOM_*`, ubah urutan simpul dulu, baru rute (LAY-02). Jangan mengecilkan huruf untuk memuat isi.

**Kapan memilih `full`.** Pilih `width: "full"` hanya bila pesan penolakan berbunyi `muat N ... pada 128 mm, M pada 166 mm; pilih width "full"` dan gambar Anda muat dalam M. Pasang `width` pada blok diagram, atau lewat `datum-studio_studio_figure_revise` dengan patch `width`. Bila pesan berbunyi `width "full" tidak cukup` atau `width "full" sudah dipakai`, pecah gambar. Selebihnya tetap `text`. Gambar `full` yang dibingkai tidak muat di kolom 128 mm (bagian 12).

Batas manual lebih longgar di jumlah dan lebih ketat di kepadatan: PER-06 meminta "under about 30 nodes and 40 edges, in four to seven clusters", nyaman pada 15 sampai 25 simpul. Pegangan kerja: paling banyak 24 simpul karena mesin menolak di atasnya, dan usahakan paling banyak 18 simpul pada 128 mm (angka 18 adalah inferensi dari uji kepadatan manual di p583, bukan pernyataan manual).

**Aturan pecah (LAY-06, PER-02).** Pecah bila simpul melebihi batas ATAU bila dua level abstraksi bersaing. Pecah menurut pertanyaan pembaca, bukan menurut potongan otomatis alat (CASE-01). Buat satu gambar ikhtisar yang tiap bloknya menyebut gambar detailnya di `sub` (`→ Gambar 4.3`), lalu gambar detail.

**Penghubung luar-halaman dengan `ref`.** Di kedua gambar, pasang simpul `shape: "offpage"` dengan `ref: {figure: "<id blok gambar pasangan>", key: "<kunci yang sama di kedua ujung>"}`. Kedua blok diagram wajib punya `id`. Mesin menulis labelnya sendiri saat render dari penomoran dokumen (`ke Gambar 2.2 · FW-01` dan `dari Gambar 2.1 · FW-01`), jadi teks `label` Anda diganti dan nomor tetap benar bila gambar bergeser. Pasangan diperiksa hanya pada render dokumen: `offpage` tanpa `ref`, `ref` ke blok yang tidak ada, atau kunci yang berbeda membuat render gagal tanpa berkas dengan `OFFPAGE_UNPAIRED`, dan pesannya menyebut sebabnya. Pratinjau menuliskan "belum diperiksa: hanya saat render". Manual meminta rujukan `lembar/zona` (misal `5/A1`); Studio memakai nomor gambar, tulis keterbatasan itu di catatan. `offpage` termasuk set ISO 5807, jadi tidak bisa dipakai bersama `doubled`, `shadowed`, `bus`, atau bentuk BPMN. Pada gambar seperti itu pakai `circle` berlabel nomor gambar; pasangan itu tidak diperiksa mesin, jadi periksa dengan mata dan catat di register.

**Kerangka pecahan.** Penolakan `FIGURE_OVER_CAPACITY` bisa membawa `details.split`: dua spec bagian, `pairs[]` (satu pasang `offpage` per pasangan simpul yang terpotong, beserta daftar `connectors` aslinya), dan penanda `{{id_blok_bagian_1}}` serta `{{id_blok_bagian_2}}`. Cara memakainya: beri kedua blok diagram `id`, ganti kedua penanda dengan `id` itu, cocokkan setiap pasangan dengan sambungan sumber (bagian 11.1), lalu pratinjau tiap bagian. Kerangka hanya ditawarkan bila kedua bagian lolos, paling banyak dua bagian, dan tidak pernah membelah zona. Bila tidak ditawarkan, pesannya mengatakan demikian: pecah sendiri menurut pertanyaan pembaca. Untuk `sld` kerangka tidak pernah ditawarkan.

## 6. Nilai kosong: satu perilaku

Manual memberi empat perintah yang tidak sama: tinggalkan kosong dan catat di `notes[]` (ch. 38, ch. 10, ch. 12); tulis catatan terlihat "speed TBC, register row NET-L-14" (ch. 9); berhenti dan daftar nilai yang hilang (ch. 16, ch. 19); tandai anggapan dengan segitiga dan lanjutkan (ch. 18, 20, 21, 29). Sampai pemilik standar memutuskan, pakai SATU perilaku ini:

1. Jangan pernah mengisi angka yang masuk akal (AIM-03, MOD-07).
2. Nilai hilang: jangan tulis angka. Tulis `TBC · <kunci register>` di `sub` simpul atau di label garis supaya kekosongan terlihat, dan tambahkan satu baris di `notes[]` serta di daftar nilai kosong pada keluaran. Lanjutkan menggambar strukturnya.
3. Nilai yang diberikan pengguna sebagai anggapan: tulis nilainya, beri `mark: "ASUMSI"`, cantumkan di key row dan baris sumber, dan sebut di caption bila anggapan itu menentukan simpulan.
4. Berhenti dan minta data hanya bila yang hilang menentukan geometri atau keselamatan (lensa, tinggi pasang, rating pemutus, waktu respons), atau bila register kosong sama sekali. Untuk register kosong, buat draf struktur tanpa besaran berjudul "DRAFT – no quantities" lalu berhenti.
5. Tulis satu kalimat di catatan: "Aturan nilai kosong mengikuti skill gsp-diagram-standard bagian 6; manual memuat petunjuk yang berbeda antar bab."

## 7. Aturan ringkas per domain

Pasangan nomor dan teks aturan di bagian ini sudah dicocokkan dengan halaman manual (bab domain dan Lampiran C, p591 sampai p600) pada 2026-11-17. Sebagian kutipan hanya memuat kalimat atau klausa pertama aturan, jadi buka halaman manual sebelum mengutip aturan secara utuh ke klien.

**Jaringan (ch. 9).** Mesin hanya untuk level konsep: `topology` (fisik), `layered` (zona).
- NET-01: "Draw physical and logical topologies as separate figures. Never put cable media and subnets in one view."
- NET-02: "Label every physical link with count, speed and medium, and every logical flow with service, port and direction."
- NET-04: "Every zone frame names a real VRF, VLAN set or firewall zone."
- NET-05: "Draw denied flows that a reviewer will ask about, in the alert pattern, labelled 'denied'."
- NET-07: "Group identical devices into one counted node on topology views."

**Komputasi dan rak (ch. 10).** `rack` untuk elevasi, `layered` satu tier per plane untuk klaster.
- DC-01: "Number rack units from the bottom (U1 at the floor) and draw every device at its true U height."
- DC-02: "Show and label every empty U as a hatched blank."
- DC-03: "Print rack totals beside every elevation ..., each with its value mark." Studio: blok tabel di bawah gambar.
- DC-05: "Draw GPU clusters with three planes (compute, storage, management/OOB) and three key-row line types."
- DC-12: "Draw an air-gapped enclave with its single ingress path ... and an explicit statement that no egress path exists."

**Fiber (ch. 11).** Manual melarang family mesin untuk splice, matriks alokasi, dan OTDR.
- FO-01: "Identify every fibre by cable · tube · fibre number. Colour ... serves as a check, never as the identifier."
- FO-04: "Name the fibre type (G.652.D, G.657.A2) and the cable construction on every cable."
- FO-05: "Compute loss budgets at every operating and test wavelength, with each allowance and its source stated."
- FO-10: "Draw PON trees with every splitter ratio and loss, the fibre length per branch ..." Studio: `layered` sebagai pohon.
- FO-16: "Mark every number as measured or designed and state its source."

**Daya dan SLD (ch. 12).** `sld`, atas ke bawah, sumber di atas.
- PWR-01: "Use IEC 60617 symbols and cite the database as consulted; no IEEE or ANSI symbols on Indonesian projects."
- PWR-02: "Distinguish breaker, disconnector, contactor and switch by their IEC marks."
- PWR-03: "Draw a transfer switch as a changeover contact or as interlocked breakers, always with its control function KF ...; never as an invented box." Studio: `iec:changeover` + simpul KF dengan garis `control`.
- PWR-05: "Draw SLDs top to bottom with sources at the top; the busbar is the only heavy stroke."
- PWR-07: "Print the earthing system (TN-S, TN-C-S, TT) at the busbar it applies to."
- Catatan: bab resep (ch. 41) mengutip nomor PWR yang berbeda untuk temuan yang sama; ikuti nomor bab 12.

**Video dan keamanan fisik (ch. 16, 17).** Mesin hanya untuk arsitektur, antarmuka, dan urutan.
- VID-02: "State the IEC 62676-4:2025 category and pixel density for every operational requirement area; map DORI only when the KAK uses it, and say so."
- VID-07: "Print the load on every link of an architecture sheet."
- VID-10: "Draw evidence export as a sequence with hash, signature, write-once archive, receipt and custody record; mark integrity steps with the verify line."
- SEC-06: "Hard-wire every life-safety release in series with the lock supply; never route egress through a controller input or software."
- SEC-11: "PSIM may request, never command, life-safety actions."
- SEC-12: "Draw alarm SOPs as swimlanes with cumulative time limits that the acceptance test measures." Studio: `phases[]` sebagai kolom batas waktu, paling banyak 8.

**Perangkat lunak: C4 dan sequence (ch. 18).** Mulai dari C4 context, lalu container; jangan mulai dari component atau class.
- SW-01: "One notation per figure: C4, UML, ISO 5807, crow's foot or DFD. State the notation and its edition in the source line."
- SW-02: "Every C4 element carries a name, a type in brackets and a technology; state the C4 level on the figure."
- SW-03: "Every arrow carries purpose and protocol ..."
- SW-05: "Flowcharts keep the happy path in one column; every decision exit is labelled; every loop shows its bound."
- SW-07: "Sequence diagrams use time as the vertical axis only ... and draw replies dashed." Studio: balasan memakai `dash: "dashed"`.

**Data dan ML (ch. 20, 21).** `layered` + zona untuk lapisan, `flow` LR untuk pipeline, `graph` untuk lineage, `sequence` untuk urutan penegakan.
- DATA-01: "Every flow carries what moves, its format and its rate."
- DATA-07: "Promotion between layers passes a named gate ...; rejected rows go to quarantine with a reason code." Studio: `diamond` di antara lapisan, jalur karantina `kind: "alert"`.
- AI-01: "Never draw a generic 'AI' box or an 'insights' arrow; name each model with version, precision and serving configuration."
- AI-06: "Access control is applied inside retrieval ..., and the answer's label is computed from what it cites."
- AI-09: "Retrieved and tool-returned content is drawn as untrusted and is never executed as instructions."

**Zona siber (ch. 22).** Mesin: `layered` untuk ikhtisar pertahanan berlapis level proposal, `swimlane` dan `sequence` untuk respons insiden.
- CYB-01: "Draw trust boundaries as lines that cut flows, and number every flow that crosses one." Studio belum bisa; katakan demikian.
- CYB-04: "Zone diagrams give every zone an SL-T vector over FR1 to FR7 and every conduit a numbered row in a conduit schedule."
- CYB-05: "Put administrative access in its own zone with its own conduit; never inside the zone it administers."
- CYB-07: "... draw no line back across a diode except another diode."
- CYB-11: "ATT&CK figures cite the version and use its tactic names and IDs."

**Proses dan BPMN (ch. 29).** Putuskan dulu: BPMN atau cross-functional flowchart.
- BP-01: "Draw every process with lanes that name roles; a process without roles is incomplete."
- BP-02: "Name lanes for roles, never for people."
- BP-03: "Claim 'BPMN 2.0.2' only for drawings with true BPMN shapes ...; otherwise write 'cross-functional flowchart'."
- BP-04: "Keep sequence flows inside one pool; draw every hand-off between organisations as a message flow whose content is listed."
- BP-05: "Give every process start and end events, and label every output of an exclusive or inclusive gateway."

## 8. Daftar penolakan

Tolak, dan sebut alasannya, bila diminta:

1. Membuat diagram teknik sebagai gambar raster atau dengan model pembuat gambar (AIM-01); menulis koordinat atau SVG dengan tangan (AIM-02).
2. Mengarang angka, rating, koordinat, edisi standar, atau simbol (AIM-03); menambah komponen yang tidak ada di register atau desain (contoh manual: "Redis cache").
3. Menandai karya sendiri sudah diperiksa atau mengisi `labels_verified: true` (AIM-04). Mesin menolak nilai itu dari agen; hanya orang yang menaikkannya lewat keputusan di Mission Control (bagian 11.4). Jangan menjawab sendiri permintaan pemeriksaan label walau diminta "finalkan".
4. Mencampur notasi; memakai ikon vendor di dokumen netral (AIM-05).
5. Mencetak ketelitian melebihi fase: ±30 % di P0, ±10 % di P1, ±2 % di IFC (FW-06).
6. Memakai data pribadi, alamat hidup, atau koordinat nyata situs sensitif (AIM-07); frekuensi operasi atau nama produk kripto nyata (petunjuk model ch. 9, p57); peta celah deteksi (petunjuk model ch. 11, p85). Pakai data fiktif dan katakan fiktif.
7. Menggambar fungsi keselamatan jiwa (E-stop, pelepasan gas, pelepasan pintu darurat) sebagai logika perangkat lunak biasa; menggambar diode dengan jalur balik.
8. Menyatakan redundansi, tier, atau "secure/encrypted" tanpa unsur penegak dan sumbernya.
9. Menggambar jenis dari daftar "belum bisa digambar" seolah memenuhi standar.
10. Prosedur serangan langkah demi langkah, cara menjebol kunci atau sensor, penargetan orang.

## 9. Daftar periksa sendiri

Jawab ya atau tidak untuk tiap butir dan laporkan yang "tidak":

1. Pembaca dan pertanyaan satu kalimat tercatat; caption menyatakan simpulan yang terlihat di gambar.
2. Ada caption, baris sumber dengan dokumen dan klausul, dan klasifikasi mengikuti dokumen induk.
3. Satu level abstraksi; simpul paling banyak 24 dan sedapatnya 18; penghubung luar-halaman berpasangan lewat `ref`.
4. Satu notasi; simbol dari pustaka pada satu dialek, atau legenda rumah disebut di key row.
5. Setiap garis berlabel isi dan besaran; tidak ada label "data", "link", "connect", "line", "uses".
6. Setiap simpul bernama dan ber-rating; tag kebutuhan atau designasi ada bila domain memintanya.
7. Setiap angka berasal dari register; nilai penentu bertanda provenans; nilai kosong tertulis TBC.
8. Satu aksen pada subjek caption; paling banyak lima warna; merah hanya untuk kegagalan; arti tetap terbaca pada cetak hitam-putih.
9. Kotak bersudut tajam; tidak ada isian pejal; arsir disebut di key row.
10. Setiap simpul ada di register atau BoQ; tidak ada komponen hantu; tidak ada bingkai hiasan.
11. `figure.defects` kosong; tidak ada garis menembus kotak atau menimpa label pada gambar hasil.
12. Daftar sambungan, daftar tag, dan daftar benda wajib cocok dengan sumber; setiap perubahan ada di register dengan alasan (bagian 11.1).
13. `labels_verified` tetap `false`; daftar temuan terbuka dan daftar nilai kosong disertakan.
14. Dikerjakan manusia, bukan Anda: uji lima detik, uji fotokopi, tiga tanda tangan berbeda, rekonsiliasi terhadap register dan BoQ.

## 10. Contoh rujukan

Berkas gambar: `references/pages/pNNN.jpg`; indeks lengkap: `references/index.md`. Keduanya dibaca dengan `datum-studio_studio_library_read` pada path `skill:gsp-diagram-standard/references/index.md`; untuk halaman JPG alat itu memberi path absolut untuk dibuka dengan pembaca gambar. Sertakan `mission` dan `row` supaya bacaan tercatat di baris misi. Gambar manual melanggar sebagian aturannya sendiri (label tertimpa garis, teks terpotong elipsis, garis tanpa label), jadi tiru strukturnya, bukan pikselnya.

| Kebutuhan | Buka halaman | Studio hari ini |
|---|---|---|
| Enam jenis garis | p030 | bisa, juga keenamnya sekaligus |
| Flowchart ISO 5807; gerbang mutu G1-G7 | p527, p563, p492 | bisa sampai 7 rank TB; gerbang G1-G7 dan triase 10 simpul terlalu tinggi untuk satu gambar: pecah |
| Topologi bertingkat, riser; pohon anggaran PoE | p554, p547 | pohon PoE bisa pada `full` (contoh C); riser sebagian |
| C4 container; sequence RAG | p558, p560 | sequence RAG bisa (contoh B); C4 container sebagian (garis menyusuri kepala zona) |
| Zona logis L3; zona dan conduit; konteks ber-ID antarmuka | p538, p393, p390 | sebagian |
| DFD STRIDE; state machine; link chart | p561, p398, p571 | sebagian |
| Swimlane BPMN; swimlane dengan penggaris waktu | p562, p382 | sebagian |
| Elevasi rak; cincin WAN dengan tabel hop | p541, p373 | sebagian |
| Ikhtisar dan detail dengan penghubung luar-halaman | p028 | bisa dengan `ref`; tanpa rujukan zona lembar |
| SLD IEC 60617 | p378 | tidak pada ukuran penuh |
| P&ID, denah, coverage, peta | p433, p410, p552, p575 | tidak bisa |
| Matriks ATT&CK, halaman KPI, matriks jejak | p468, p470, p486 | sebagian, sebagai chart atau tabel |
| Title block, lembar register berbingkai | p033, p039 | sebagian: bingkai dan strip judul lewat skrip (bagian 12) |
| Templat spec Appendix D | p601 | rujukan field, lihat bagian 4; bentuk Studio-nya contoh A |

**Contoh teruji.** Tiga spec ini lolos pratinjau dan render dokumen tanpa cacat di Swarm 1.3.3. Dari delapan calon, lima lainnya ditolak kapasitas atau mencetak cacat dan tidak dipakai sebagai contoh.

A. Templat Appendix D dalam bentuk Studio, `layered`, lebar `text`:

```json
{"type":"diagram","caption":{"text":"Every zone has its own VRF and subnet, and traffic between zones only crosses the internal firewall."},"source":{"text":"Kajian Teknis 000/GSP/KT/XI/2026 §5.2 Table 5.4"},"spec":{"family":"layered","classification":"BIASA","labels_verified":false,"sources":["Kajian Teknis 000/GSP/KT/XI/2026 §5.2 Table 5.4"],"nodes":[{"id":"v10","label":"VLAN 10 Staff","sub":"TBC · net.v10.prefix · gw .1","tag":"REQ-NET-03","shape":"box","class":{"tier":0}},{"id":"fwi","label":"Internal firewall","sub":"zone policy · IPS","shape":"box","mark":"PEMASOK","class":{"tier":1,"accent":true}},{"id":"v100","label":"VLAN 100 Apps","sub":"TBC · net.v100.prefix","shape":"box","class":{"tier":2}}],"edges":[{"from":"v10","to":"fwi","kind":"data","label":"HTTPS 443"},{"from":"fwi","to":"v100","kind":"data","label":"allowed apps"}],"legend":[{"symbol":"data","label":"permitted flow"},{"symbol":"PEMASOK","label":"value from the vendor (house legend, not a standard)"}],"notes":["Guest VLAN denial shown on sheet 8.3","Unresolved register references: net.v10.prefix, net.v100.prefix"]}}
```

B. Urutan kueri RAG (p560), `sequence` lima lifeline, lebar `text`:

```json
{"type":"diagram","caption":{"text":"One RAG query shows the access filter runs in the vector store before any context reaches the model."},"source":{"text":"Contoh ilustrasi GSP, data rekaan untuk pengajaran · notasi UML 2.5.1 subset"},"spec":{"family":"sequence","classification":"BIASA","labels_verified":false,"sources":["GSP reference set, Gambar 13.4 Urutan Kueri RAG"],"nodes":[{"id":"an","label":"Analis","sub":"Person","shape":"box","class":{}},{"id":"k2","label":"Gerbang API","sub":"K2","shape":"box","class":{}},{"id":"k3","label":"Layanan RAG","sub":"K3","shape":"box","class":{}},{"id":"k7","label":"Vector Store","sub":"K7","shape":"box","class":{}},{"id":"k4","label":"Server Inferensi","sub":"K4","shape":"box","class":{}}],"edges":[{"from":"an","to":"k2","kind":"data","label":"01 · kueri + token OIDC"},{"from":"k2","to":"k3","kind":"data","label":"02 · kueri + klaim peran"},{"from":"k3","to":"k7","kind":"accent","label":"03 · cari + filter ACL"},{"from":"k7","to":"k3","kind":"data","dash":"dashed","label":"04 · 8 chunk + sumber"},{"from":"k3","to":"k4","kind":"data","label":"05 · prompt + konteks"},{"from":"k4","to":"k3","kind":"data","dash":"dashed","label":"06 · draf jawaban"},{"from":"k3","to":"k2","kind":"data","dash":"dashed","label":"07 · jawaban tersaring"},{"from":"k2","to":"an","kind":"data","dash":"dashed","label":"08 · jawaban + sitasi"}],"legend":[{"symbol":"data","label":"panggilan sinkron"},{"symbol":"data-dashed","label":"balasan"},{"symbol":"accent","label":"titik penegakan hak akses"}],"notes":["Message numbers are typed into the labels as printed"]}}
```

C. Pohon anggaran PoE (p547), `layered` tiga tier dengan empat simpul di tier daun: ditolak `DATUM-37-sheet` pada `text`, lolos bersih dengan `width: "full"`. Inilah contoh kapan memilih `full`: satu tier butuh empat simpul berdampingan dan pecahan akan memisahkan switch dari bebannya. Isinya: UPS rak (tier 0); Switch A dan Switch B dengan anggaran dan alokasi di `sub` (tier 1); empat kelompok beban (tier 2); garis `data` berlabel watt, dan satu garis `alert` ke kelompok yang membuat Switch B melampaui anggaran.

## 11. Gerbang dan bukti

### 11.1 Sebelum render: cocokkan dengan sumber

Bila gambar menyalin, memecah, atau menggambar ulang gambar sumber (halaman manual, gambar klien, gambar revisi sebelumnya):

1. **Daftar sambungan.** Tulis setiap sambungan sumber sebagai (dari, ke, label) dan cocokkan satu per satu dengan `edges` semua bagian. Saat gambar dipecah, setiap sambungan tetap sama dengan sumbernya; separuh sambungan yang menuju `offpage` dihitung sebagai sambungan yang sama.
2. **Daftar tag.** Setiap tag kebutuhan (`REQ-...`) dan designasi disalin dari sumber pada simpul yang sama; tag tidak dipindah ke simpul lain.
3. **Daftar benda wajib (paritas).** Dari sumber, daftar setiap simpul, wadah, dan sambungan bernama. Untuk tiap butir tulis satu status: `ada` (sebut id simpulnya), `pindah ke tabel` (sebut tabelnya), atau `hilang` dengan alasan. Jumlah saja bukan bukti paritas: dua gambar bisa sama jumlahnya dengan isi berbeda.
4. **Register perubahan.** Setiap sambungan atau tag yang diubah, ditambah, atau dibuang, dan setiap butir `pindah` atau `hilang`, dicatat dengan alasannya. Tanpa catatan, perubahan itu cacat.

Pelajaran asal aturan ini: uji ulang 2026-11-17 meloloskan jalur WAN yang keluar dari simpul yang salah, karena gerbang mata hanya membandingkan cetakan dengan spec sendiri.

### 11.2 Render dan gerbang mata

Pratinjau bukan render. Lulus pratinjau belum berarti lulus render, dan pasangan `offpage` hanya diperiksa saat render. Satu render dokumen penuh wajib sebelum vonis.

1. Render dokumen dengan `datum-studio_studio_render`, format `html` dan `pdf`.
2. Panggil `datum-studio_studio_witness_list` dengan `documentId`. Hasilnya satu PNG 150 dpi untuk setiap halaman yang memuat gambar atau chart, beserta gambar yang ada di halaman itu. Bila hasilnya `witness: "none"`, lakukan langkah berikut yang disebut di `next`.
3. Buka satu raster per halaman bergambar. Buka beberapa halaman dalam satu langkah baca, jangan satu per langkah. Perbesar bagian halaman hanya bila ada yang mencurigakan (label terpotong, garis menembus kotak, teks bertumpuk).
4. Bandingkan halaman hasil dengan halaman sumber (`references/pages/pNNN.jpg` atau gambar sumber dari pengguna), bukan dengan spec Anda. Pertanyaannya: apakah setiap benda dan sambungan sumber tampak di halaman hasil, di tempat dan dengan label yang benar? Spec hanya bisa membuktikan bahwa mesin menggambar apa yang Anda tulis.
5. Laporan menyebut nomor halaman yang dibuka. Jangan menulis "tercetak" untuk hal yang belum dilihat di halaman.

### 11.3 Vonis kepatuhan

Setiap vonis "patuh" atau "tidak patuh" mengutip bunyi aturannya (id dan kalimatnya) dan menunjuk bukti yang tercetak: nomor halaman PDF, nomor gambar, dan unsur yang terlihat (label, baris CATATAN, key row, atau tabel tepat di bawah gambar). Contoh: NET-02 "Label every physical link with count, speed and medium": patuh, halaman 14, Gambar 3.2, garis CORE ke DIST berlabel `2 × 25G OS2`. Yang tidak tercetak tidak boleh diklaim. Jadwal tanpa sumbu waktu tidak pernah dinyatakan patuh, apa pun isinya; gambar jadwal dengan chart `W-07` dan `timeUnit`.

### 11.4 Pemeriksaan label, tinjau, dan terbit

- **Pemeriksaan label oleh orang.** Ajukan dengan `datum-studio_studio_mission_request_decision`, opsi persis `approve` dan `decline`, dan baris `context` dengan bentuk persis `labels_verified row=<id baris> document=<id dokumen> revision=<nomor> figures=<pid>,<pid>`. Satu permintaan memuat sekitar 17 gambar; kirim beberapa permintaan bila lebih. Hanya orang yang menjawab di Mission Control; jawaban agen atau controller ditolak `LABELS_VERIFIED_PERSON_ONLY`. Sesudah disetujui, mesin menaikkan `labels_verified` pada gambar yang tidak berubah sejak revisi yang disebut. Suntingan agen atas gambar yang sudah diperiksa wajib mengirim `labels_verified: false` (mesin menolak selain itu), jadi gambar yang berubah diperiksa lagi.
- **Deliverable sudah di folder proyek.** Render seluruh dokumen (bukan bab atau slot) yang lolos verifikasi menyalin PDF, DOCX, dan HTML ke `<folder proyek>/deliverables/<id misi>/`; balasan render memuat baris `project copy:` dengan path-nya. Saat baris misi masuk tinjau (`needs-review`) atau selesai, saat permintaan keputusan menyebut dokumen itu (juga pemeriksaan label), dan saat terbit, salinan revisi terakhir harus sudah ada di sana; kalau belum, mesin menolak dengan `DELIVERABLE_NOT_IN_PROJECT`. Sebut path salinan itu di laporan. Bila salinan hilang, render dokumen lagi; jangan menyalin dengan tangan. Bila sebabnya `sha-mismatch` atau `PROJECT_UNWRITABLE`, tanyakan kepada orangnya.

### 11.5 Pelajaran dari uji 2026-11-17 (33 gambar dinilai terhadap halaman manual)

1. **Pecah, jangan pangkas.** Bila mesin menolak karena kapasitas, bagi menjadi dua gambar dengan pasangan `offpage`. Jangan mengurangi isi sampai lolos: gambar 3 sampai 5 simpul yang meniru contoh 20 simpul dinilai sketsa, bukan tiruan.
2. **Angka turunan harus bisa dihitung ulang dari yang tergambar.** Bila separuh pohon dibuang, nilai akar ikut berubah atau gambar itu salah.
3. **Caption hanya menyebut yang digambar.** Sebelum mengirim, cocokkan tiap benda dan angka di caption dengan simpul dan label di gambar.
4. **Pilih jenis yang benar sebelum menyerah:** jadwal memakai chart `W-07`, RACI memakai tabel (bukan diagram), diagram satu garis mencoba simbol `iec:` lebih dulu.

## 12. Lembar berbingkai

Lembar berbingkai (bingkai, rujukan zona 1-8 / A-F, baris kunci, strip judul) dibuat sesudah gambar lolos, dengan `scripts/bingkai_lembar.py`; isi gambar tidak diubah. Langkah lengkapnya ada di `references/cara_bingkai_lembar.md`. Ringkasnya: render dengan `figures: ["svg"]` memberi path SVG tiap gambar; salin SVG ke folder proyek; jalankan skrip dengan perintah dari catatan Swarm di atas skill ini; pasang lembar dengan `datum-studio_studio_asset_put` (`svg` berisi teks lembar, `width` berisi `text` atau `full`). Lembar = lebar gambar + 14 mm: gambar 128 mm menjadi lembar 142 mm yang dicetak di kolom 128 mm; gambar 166 mm menjadi lembar 180 mm yang hanya bisa dipasang dengan `width: "full"`.
