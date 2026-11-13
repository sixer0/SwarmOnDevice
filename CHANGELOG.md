# Changelog Swarm 1.1.0 sampai 1.2.6

Disusun 2026-11-13 dari catatan rilis, laporan akhir, log keputusan dan pesan commit tiap versi (sumber di akhir tiap bagian; path `docs/...` ada di folder kerja Swarm_OnDevice, di luar repo ini). Urutan terbaru di atas. "Diperbaiki" = cacat yang dibetulkan; "Baru" = fitur atau perilaku yang ditambahkan.

Catatan penomoran: sampai 1.1.4 versi app dan CLI tetap 1.19.3 (warisan basis); nomor rilis Swarm dibaca dari `SwarmRelease`. Mulai 1.2.0 versi app ikut nomor rilis Swarm.

| Versi | Tanggal | Cara rilis | Fokus |
|---|---|---|---|
| 1.2.6 | 2026-11-13 | Patch menu dari 1.2.5 | 62 temuan research-case: diagram, MCP, mode otonom, Mission Control, subagen, panduan |
| 1.2.5 | 2026-11-10 | Patch menu | Hapus lint C-27 |
| 1.2.4 | 2026-11-09 | Patch menu | Kunci versi templat bawaan |
| 1.2.3 | 2026-11-09 | Patch menu | Gerbang verifikasi Studio benar, workflow Swarm sendiri, vision dan PDF |
| 1.2.2 | 2026-11-08 | dmg | Subagen spesialis, workflow otomatis, cakupan Mission Control |
| 1.2.1 | 2026-11-08 | dmg | Mission Control dan gerbang verifikasi output Studio |
| 1.2.0 | 2026-11-07 | dmg (tanpa patch dari 1.1.x) | DATUM Studio di dalam Swarm |
| 1.1.4 | 2026-11-06 | Dibangun, tidak pernah diterbitkan | Isinya masuk ke 1.2.0 |
| 1.1.3 | 2026-11-06 | Patch menu | Mode otonom tanpa menunggu |
| 1.1.2 | 2026-11-05 | Patch menu (pertama) | Menu "Update from File…" |
| 1.1.1 | 2026-11-04 | Installer | Mode otonom dengan persetujuan |
| 1.1.0 | 2026-11-03 | Installer | Knowledge Library, pemasang tools, CLI `swarm` |

---

## 1.2.6 (2026-11-13)

Commit `f7ecc46b0c` (`release/1.2.6`, 173 commit di atas 1.2.5), digabung ke `main` sebagai `dc850e06ed`. Menindaklanjuti handoff 62 butir dari uji semua workflow pada research case internal.

**Diperbaiki**
- Mesin diagram Studio (T-01 s.d. T-18): gerbang AUTO_FIT tidak lagi lolos palsu; jenis cacat geometri baru (`edgeEntryCollision`, `stubSegment`, `arrowTangent`); inset tepi graf, label tepi, warna, tinggi diamond, fan-out, batang jujur `BAR_SUBMIN`; flow mendukung arah `TB`/`LR` dan multikolom; caption tidak boleh diawali token label gambar; halaman temuan lint (batas 100 dicabut, daftar penuh bisa di-page).
- Render dan MCP: batas waktu render 540 s diteruskan; jembatan stdio tidak lagi memutus permintaan senyap tepat di 300 s (cacat Bun `fetch`); reconnect MCP tidak lagi menjalankan ulang panggilan yang sedang berjalan (render atau tulis misi ganda); gambar gagal tidak lagi menggagalkan seluruh DOCX; nama berkas selalu memuat ` rev<N>`; preview dan gerbang render kini sepakat.
- Mode otonom: `cp`/`mv` ke nama baru tidak dianggap penggantian; teks penolakan lengkap; `apply_patch` tidak lagi melewati checkpoint.
- Mission Control: `running -> done` dengan catatan, `set_status` idempoten, patch catatan tanpa gerbang dependensi, petunjuk skema, hasil per patch.
- Subagen: alasan diberikan saat hasil kosong (planner tidak lagi diam), `expected_outputs` dengan `SUBAGENT_OUTPUT_MISSING`.
- Keamanan: agen tidak bisa memanggil API server Swarm sendiri lewat loopback (masalah sejak 1.2.5); pengerasan penyamaran rahasia dan revert checkpoint.

**Baru**
- Semua baca diizinkan di mode otonom, nilai rahasia tetap tersamar `[hidden:NAME]`; tindakan yang tidak bisa dibatalkan didahului checkpoint, dengan tombol Revert khusus manusia.
- Memori proyek model indeks + referensi: indeks 2000 karakter, isi catatan 10000, maksimal 10 referensi per catatan, muat 8000 token.
- Kesehatan tool: runtime, SearXNG, Firecrawl, render bridge, layout runtime diperiksa saat Swarm mulai dan dihidupkan ulang lewat `swarm-setup start`; skill bawaan `tool-health` dan `flux3-image-gen`.
- Tautan dokumen lintas misi (migrasi Studio 0007), deteksi drift setelah persetujuan, register keputusan saat misi selesai.
- `studio_asset_put` untuk gambar PNG/JPEG eksternal; revisi diagram parsial dengan `FIGURE_GRAPH_DELTA`; folder `.bak/` retensi 5; kuota gambar.
- Konfigurasi bawaan dari `swarm.jsonc` pengguna: batas konteks/output per model GSP (thinker 784000/120000, worker 512000/90000, worker-fast 512000/60000), `mcp_timeout` 600000, compaction `{auto:true, max_context:0}`; nilai pengguna tetap menang.
- Panduan ditulis ulang sesuai perilaku baru: skill mission-control, house style, STUDIO-AGENT-GUIDE, resep dokumen-klien, deskripsi tool MCP; mode juri buta di verifier.

**Perlu diketahui**: setelah 1.2.6 berjalan, Undo ke 1.2.5 membuat Studio menolak store (pulihkan dengan memasang ulang 1.2.6). Pada dokumen 004, 23 dari 24 diagram kini gagal gerbang T-03: cacat yang dulu lolos palsu sekarang terlihat.

Sumber: `docs/2026-11-12_swarm_1_2_6_patch/report/release_note_1_2_6.md`, `report/report.md`.

## 1.2.5 (2026-11-10)

Commit `e363918a69`.

**Diperbaiki**
- Lint C-27 (jumlah kata per kalimat) dan parameternya dihapus; templat bawaan dinaikkan versinya.

Sumber: commit `e363918a69`.

## 1.2.4 (2026-11-09)

Commit `08bb40547d`.

**Diperbaiki**
- Templat bawaan yang isinya berubah (datum-gsp di 1.2.2, datum-kanonik di 1.2.3) masih bernomor versi 1, sehingga store yang sudah mem-pin versi itu gagal `TEMPLATE_VERSION_CONFLICT` dan semua jalur templat (get, preview, render) gagal. Kini ada `version-lock.json`; datum-gsp dan datum-kanonik naik ke v2, store lama ter-upgrade tanpa langkah manual.

**Baru**
- Tes kunci versi: gagal bila isi templat berubah tanpa kenaikan versi.
- Panduan: bentuk kolofon dan contoh payload sampul minimal yang valid.

Sumber: commit `08bb40547d`.

## 1.2.3 (2026-11-09)

Commit `a3a2e99a45` s.d. `ae174f84ae`.

**Diperbaiki**
- OVERLAP_CLIP selalu FAIL palsu: dengan mouse terpasang macOS menggambar scrollbar 15 px di jendela render bridge, halaman flow ditata 779 px, bukan 794 px. Scrollbar kini disembunyikan; tata letak yang lebih sempit dinilai UNKNOWN, bukan FAIL. DATUM-37 ikut konsisten.
- Rincian verifikasi kini sampai ke klien (dibatasi 16 KB, dinetralkan); lint tiga keadaan (pass/fail/unknown).
- Kolom METODE/OBJEK/HASIL di verificationChain kini tercetak dan bisa diedit.
- datum-kanonik menyisakan kolom rail (preview tidak lagi gagal DATUM-15).
- Kartu agen tidak lagi mengulang "What failed".
- JSON provider bawaan dijaga di bawah batas 1000 byte launcher Windows; string baru diterjemahkan ke 60 locale.

**Baru**
- Workflow milik Swarm sendiri: aturan bawaan, SWARM.md, AGENTS.md; berkas Claude mati secara default (`claude_compat`); skill bawaan swarm-workflow dan mission-control.
- Misi tertaut otomatis ke sesi pemanggil; penolakan menyebut panggilan berikutnya; persetujuan otonom hanya saat mode otonom aktif, agen tidak pernah menjawab keputusan atas nama pengguna.
- Model GSP AI thinker, worker, worker-fast menerima gambar (vision).
- PDF bisa dibaca model tanpa input PDF native (teks dengan penanda halaman).
- Mode otonom boleh memakai folder di luar proyek, kecuali path yang dilindungi.
- Panduan serah terima tim (HANDOVER.md).

Sumber: `docs/2026-11-09_swarm_1_2_3_patch`, commit `c3661f8805` s.d. `ae174f84ae`.

## 1.2.2 (2026-11-08)

Commit `9bf7bf2838`.

**Baru**
- Lima subagen spesialis bawaan (coder, planner, verifier, data-collector, document-writer) pada tier GSP AI, dengan aturan routing.
- Workflow master-controller dimuat otomatis untuk pekerjaan terorkestrasi; nama peran Claude dipetakan ke agen Swarm.
- Agen wajib mengikuti Mission Control dan Studio: misi di folder sesi, status baris langsung, gerbang sebelum selesai.
- Mission Control: tampilan kosong, misi di subfolder sesi dan sesi (sub)agen yang tertaut, batas cakupan aman.
- Persiapan lintas platform: staging dan konfigurasi build untuk linux-x64 dan win32-x64, launcher Windows/Linux (build Linux dan Windows masih ditahan).

**Diperbaiki**
- Penolakan agen bersifat final; skill tingkat pengguna menang bila namanya bentrok; bypass lewat @-mention dibatasi; alias ke agen yang dimatikan memberi error.

Sumber: commit `9bf7bf2838`, `docs/2026-11-05_swarm_linux_installer_patcher`.

## 1.2.1 (2026-11-08)

Commit `acaf31e217`, build terpasang `67156edcfd`.

**Baru**
- Mission Control di tampilan Agents: HQ radial dengan ruang dan kru, keputusan dijawab di tempat, panel Deliverables berisi output terverifikasi per baris, refresh langsung.
- Gerbang verifikasi output Studio: output dihitung hanya bila FIDELITY, OVERLAP_CLIP dan LINT lulus; UNKNOWN tidak pernah lulus; baris misi tidak bisa selesai dengan output yang belum terverifikasi; draf usang bisa di-retire.
- Tata letak ELK.js untuk diagram kompleks dan keluarga chart Vega-Lite V-01 s.d. V-08; penolakan kapasitas untuk gambar terlalu besar.
- Tier misi memakai tier GSP AI (thinker, worker, worker-fast, inherit); panduan format misi.
- Prompt izin menyebut tool dan server yang meminta; panel About menampilkan nama, versi, tanggal update.

**Diperbaiki**
- Perbaikan Rev A Studio: blok kontrol sampul 4 x 2 dengan 8 field manual, lembar kontrol dengan pernyataan metode dan tiga kolom tanda tangan, aturan halaman, warna rail, gambar vektor dengan label terbaca, gambar berdiri sendiri dengan caption/KUNCI/SUMBER, berkas dikirim dengan nama judul.
- Lembar simbol dan klasifikasi; injeksi marker PDF dan pemalsuan nama (tinjauan keamanan).

Sumber: `docs/2026-11-06_swarm_1_2_0_datum_installer/report/report.md`, commit `acaf31e217`.

## 1.2.0 (2026-11-07)

Commit `1eb98be8e2`. Diterbitkan sebagai dmg saja, tanpa patch dari 1.1.x; menggantikan 1.1.4.

**Baru**
- DATUM Studio di dalam Swarm: store, host MCP dengan 39 tool, render bridge, wrapper stdio untuk Claude. Pekerjaan dokumen tidak lagi butuh installer terpisah.
- House style Rev A di mesin Studio dan builder Python bawaan.
- Layanan templat dengan form lock dan penjaga Rev A.
- Fondasi data misi (migrasi 0003, tool misi).
- Preview PDF dan HTML Studio di tab berkas.
- Tahap packaging dan gerbang build baru.
- Seluruh isi 1.1.4 (lihat di bawah).

Sumber: commit `1eb98be8e2`, `docs/2026-11-06_swarm_1_2_0_datum_installer/decisions/decisions.md` (U3).

## 1.1.4 (2026-11-06, tidak pernah diterbitkan)

Dibangun dan dibuat paketnya (`029c07829a`), tetapi pengguna memutuskan paket ini tidak diterbitkan (U3 1.2.0); isinya ikut dalam 1.2.0.

**Diperbaiki**
- Tombol sesi di chat kembali mendaftar sesi proyek: pemilih sesi lama dihapus, diganti panel Home di samping chat.
- Fokus: `mod+b` memindahkan fokus ke kotak cari panel, Esc menutupnya; fokus tidak pernah otomatis jatuh ke baris papan (mencegah ketikan menjawab izin).

**Baru**
- Setiap prompt izin non-otonom menawarkan "Always allow in this session"; semua "always" non-otonom kini berlaku per sesi, termasuk yang dulu berlaku per proyek. Prompt batas biaya hanya Stop / Continue.
- Knowledge Library edisi baru (pin `f60afc8`).

Sumber: `docs/2026-11-06_swarm_1_1_4_patch` (README, decisions U1-U7, C1-C13).

## 1.1.3 (2026-11-06)

Commit `aba880de69`.

**Baru**
- Di mode otonom yang sudah disetujui tidak ada keputusan yang membuat agen menunggu: tindakan destruktif langsung dijawab "pakai metode arsip" (pindah ke arsip atau Trash), tidak dijalankan dan tidak ditanyakan.
- Keputusan kelas P diputuskan agen utama tanpa model penimbang (tidak ada lagi tunda karena model tidak tersedia).
- Jaring pengaman: keputusan yang masih akan menunggu diubah jadi jawaban teks ke agen.
- Folder hasil build (`dist`, `build`, `.next`, `coverage`, `target`, dan lain-lain) boleh dihapus skrip.
- Laporan akhir otonom punya bagian "Dialihkan ke metode arsip"; tulis ke `.git/config` dan hooks dicatat di Open issues.

Mode tanpa persetujuan (perilaku 1.1.0) tidak berubah.

Sumber: `docs/2026-11-05_swarm_1_1_3_patch/report/release_note_1_1_3.md`.

## 1.1.2 (2026-11-05)

Commit `4abef3c60d`.

**Baru**
- Menu Swarm "Update from File…": pilih berkas `.swarmpatch`, diverifikasi tanda tangannya, lalu dipasang dan Swarm dibuka ulang; Undo ke versi sebelumnya tersedia.
- Penandatanganan paket cukup dengan double-click skrip `.command` yang hanya meminta password kunci.

**Diperbaiki**
- Pemasang menunggu terus karena crashpad handler Electron tetap hidup; kini hanya handler milik Swarm yang dihentikan.
- dmg 1.1.1 diperbaiki agar bisa menerima update lewat menu.

Sumber: catatan rilis internal 1.1.2, `docs/2026-11-02_swarm_system_patch_updates`.

## 1.1.1 (2026-11-04)

Commit `efdadd14eb` s.d. `e23f38c958`.

**Baru**
- Mode otonom dengan persetujuan: satu layar persetujuan setiap kali dinyalakan; approval dilewati, agen utama memutuskan dan setiap keputusan tercatat di Activity; berkas yang dihapus dipindah ke arsip; laporan saat mode dimatikan (yang dikerjakan, diputuskan, ditolak, dan semua yang dikirim ke luar).
- Aturan otonom: perintah pengembangan yang dikenali jalan tanpa bertanya; jaringan ke lokal, LAN, container, atau situs yang disebut pengguna jalan; push tanpa force ke remote proyek jalan; tindakan yang tidak bisa dibatalkan (`git reset --hard`, force push, drop tabel) dan `sudo` ditolak.
- Tab Decisions lebih sederhana: "Waiting" dan "History", bahasa biasa, detail teknis di balik expand.
- Pindah sesi lewat daftar di header sesi.
- Cara kerja agen utama yang baku: tujuan, rencana, persetujuan, riset, penyesuaian, kerja, cek, laporan.
- Balasan dalam bahasa pengguna dengan istilah teknis umum tetap apa adanya.

**Diperbaiki (lebih ketat di mode 1.1.0)**
- Tulis lewat symlink diikuti `..` dinilai di lokasi sebenarnya; awalan setting sederhana (`CI=1`) dinilai seperti perintah tanpa awalan; `HOME` yang diubah tidak dibaca sebagai home; perintah terlalu panjang menunggu.

Sumber: `docs/2026-11-03_swarm_1_1_1_patch/verification/55_release_note.md`.

## 1.1.0 (2026-11-03)

Commit `55c9f7b2ff`.

**Baru**
- Knowledge Library bawaan.
- Aturan otonomi U11: perintah shell majemuk dinilai per langkah (tree-sitter); tulis lewat shell di dalam folder diizinkan seperti edit, di luar folder ditolak; git baca diizinkan.
- Pemasang tools (colima, docker, SearXNG, Firecrawl, dan lain-lain) dengan tombol Install; runtime terpasang di Mac mana pun dengan Homebrew (Apple Silicon dan Intel, macOS 13+).
- CLI `swarm` ikut di app (memakai state, provider dan server app yang sedang berjalan); menu Install Command Line Tool.
- "Always allow in this session" pada keputusan di Activity; Allow biasa berlaku untuk jenis yang sama sepanjang sesi.
- Lebih banyak perintah aman tanpa tanya: `npm test`, `npm run check:*`, `npx vitest` lokal, `git -C`, `grep -r`, `sed -n`.

**Diperbaiki**
- Giliran ganda di Activity dari satu kirim.
- Satu persetujuan sesudah restart meloloskan pengulangan agen.
- Entri yang sudah dijawab tertinggal di "Waiting for you"; satu keputusan kini satu baris "Decided" dengan satu Undo.
- Versi formula brew runtime dipakai sebagai minimum (`brew upgrade` bila lebih lama); image SearXNG/Firecrawl ditarik sebelum `up`.
- Tombol Install di atas dan isi dialog tools bisa di-scroll.

Sumber: `docs/2026-11-01_knowledge_library_default/report/report.md`, catatan rilis internal 1.1.0.
