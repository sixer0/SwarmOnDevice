# Changelog Swarm 1.1.0 sampai 1.2.7

Disusun 2026-11-13 dari catatan rilis, laporan akhir, log keputusan dan pesan commit tiap versi (sumber di akhir tiap bagian; path `docs/...` ada di folder kerja Swarm_OnDevice, di luar repo ini). Urutan terbaru di atas. "Diperbaiki" = cacat yang dibetulkan; "Baru" = fitur atau perilaku yang ditambahkan.

Catatan penomoran: sampai 1.1.4 versi app dan CLI tetap 1.19.3 (warisan basis); nomor rilis Swarm dibaca dari `SwarmRelease`. Mulai 1.2.0 versi app ikut nomor rilis Swarm.

| Versi | Tanggal | Cara rilis | Fokus |
|---|---|---|---|
| 1.2.7 | 2026-11-13 | Patch menu dari 1.2.6 | Mission Control per sesi, CLI `swarm autonomy`, izin subagen, tempel dari Word, Add folder, polesan render |
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

## 1.2.7 (2026-11-13)

Cabang `release/1.2.7`, dibangun dari `main` `04067a9d02` (1.2.6). Menindaklanjuti sembilan temuan pengguna (U-1 s.d. U-9), empat tambahan pengguna (U-10 s.d. U-13), audit pasca-uji 1.2.6 (N-1 s.d. N-11, sisa T-xx dan M-xx) dan tindak lanjut F-2 s.d. F-7. Sesuai keputusan pengguna U11, tahap review akhir (verifier, security review diff akhir, senior review) dilewati; cakupannya bertumpu pada review milestone, review keamanan spesifikasi, tes merah-ke-hijau per butir dan gerbang suite penuh.

**Diperbaiki**
- Mission Control (U-1 s.d. U-5): daftar misi difilter menurut sesi jendela yang dilihat; deliverable bisa dibuka (dokumen dibuka, lainnya ditampilkan di Finder/File Explorer; skrip dan app tidak pernah dijalankan); blok berkas yang diedit banyak agen pindah ke tab sendiri; riwayat baris terbaru di atas dengan sekitar 10 baris terlihat; popup keputusan dan tab Keputusan punya tinggi tetap dengan isi yang bisa digulir sehingga tombol setujui/jawab selalu terjangkau.
- Folder kerja misi (U-6): ekspor baru memakai folder bernomor `01_identification` sampai `11_deliverables` sesuai urutan standar.
- Folder proyek hilang (U-8): Swarm tetap berjalan, memberi tahu folder tidak ada dan meminta pemulihan atau pembuatan ulang.
- Blok thinking (U-9): setiap blok punya tombol tampil/sembunyi; pengaturan "Show reasoning summaries" hanya menentukan keadaan awal.
- Tempel dari Word (U-13): teks dipaste sebagai teks, gambar dilampirkan hanya bila tidak ada teks; gambar transparan dialasi putih agar terbaca model.
- Mesin render dan diagram: hitungan D01 dan kode lain menghitung temuan dengan baris total berlabel (N-3); baris AUTO_FIT menyebut sisa sebenarnya (N-7); teks render menyebut HTML pengukuran, menandai PNG halaman sebagai pendekatan (`witness-pNNN.png`) dan mencetak sha256 penuh serta jumlah FAIL per kode (N-4, N-5, M-03); `studio_write` menampilkan penolakan render yang sebenarnya dan retry mengembalikan dokumen yang sama (N-10); sel tabel DOCX/HTML dengan daftar ID panjang boleh putus setelah `,` `;` `/` hanya bila melebihi kolom, URL, nomor dokumen dan path tidak pernah diputus (N-11); OVERLAP_CLIP tingkat bab membaca margin halaman (T-13); `figure_revise` menerima patch parsial termasuk `{spec:{direction:"LR"}}` (T-11); preview mandiri melaporkan perabot (KUNCI, SUMBER, tinggi) (T-12); penolakan DATUM-25 menyebut warna yang dihitung (T-06); nama kontrak tabrakan tepi dipublikasikan (N-6).
- Keamanan dan build (F-2 s.d. F-7): build dari jalur netral `/opt/swarm-build-1.2.7` dengan gerbang pemeriksa pemilik dan mode (F-2); nomor dokumen GSP dinetralkan dari contoh diagram (F-3); penolakan API server sendiri tidak lagi hanya mencocokkan host+port literal (F-4); revert dikunci terhadap penulisan agen serentak (F-5); pemeriksaan Tailscale tidak lagi menerima VPN lain di 100.64/10 (F-7).

**Baru**
- Perintah CLI `swarm autonomy on | off | status` (U-10): `on` hanya di terminal interaktif, menampilkan teks persetujuan dan butuh ketikan `yes`; agen tidak pernah bisa menjalankannya.
- Tombol "Add folder" di composer chat (U-12): folder dikirim sebagai referensi `@folder`, isinya tidak diunggah; folder di luar proyek mengikuti prompt izin biasa.
- Skill dibaca ulang saat berkas skill berubah, jadi skill dari CLI muncul di app desktop tanpa restart; skill baru default ke `~/.config/swarm/skills` (U-11).
- Izin subagen (U-7, N-1, P-01a, U4): shell subagen berjalan seperti agen utama untuk pekerjaan rutin, skrip dan di luar folder, serta tes dan build yang dikenali, di bawah mode otonom bersetuju; tool `task` menerima `permissions {bash:[perintah literal]}` yang berakhir bersama subagen; inspeksi baca-saja pada folder state Swarm berjalan, dengan pesan penolakan yang menyebut penggantinya; planner dan data-collector mendapat kelas baca/diagnostik (ls, wc, file, du, head, tail, cat, find, checksum, pdftotext, unzip -l, mdls, git log/show/diff/status, graft, `--version`). Deploy, publish, push image, penambahan paket bernama, perintah tulis `gh` dan alias/fungsi yang dipakai kemudian tetap menunggu keputusan agen utama.
- Di bawah mode otonom yang disetujui (U9): graft (kecuali `graft init`), builtin jaringan zsh (aturan seperti curl), pencarian atas folder state Swarm (nilai tersamar), opsi baca yang menjalankan program dan `print >|` zsh (dengan checkpoint) diizinkan; dengan mode mati semuanya tetap bertanya.
- Agen boleh memanggil API server Swarm sendiri (U10), kecuali rute yang bertindak sebagai manusia: mode/persetujuan otonom, menjawab keputusan/izin/pertanyaan, revert checkpoint dan kosongkan arsip, revert sesi, trust, tulis config/auth/lanes, shell sebagai pengguna, pembuatan terminal (pty), seluruh kontrol TUI, commit/apply/git init repo, perubahan worktree/workspace, sync steal, tambah/hubungkan MCP, upgrade dan dispose. Penulisan trust-store lewat glob, link atau variabel kembali menunggu manusia. Keluaran `swarm.json(c)`/`opencode.json(c)` disamarkan per baris.

**Perlu diketahui**
- Misi yang dibuat sebelum 1.2.7 atau di sesi lain tidak tampil di daftar jendela ini; minta agen "resume mission <id>" untuk memunculkannya di jendela saat ini. Tool `studio_mission_*` milik agen tidak berubah.
- Kunci revert (F-5) hanya berlaku dalam satu proses server; perintah shell lain (mis. build yang menulis keluaran) tidak mengambilnya, dan sesi subagen dengan root yang tidak terkait dengan direktori instance tidak tercakup.
- Skill yang disimpan di `.swarm/skills` suatu proyek hanya terlihat di proyek itu. Di sel tabel, U+200B yang disisipkan ikut tersalin saat daftar ID ditempel dari DOCX. `mcp_timeout` 600000 sudah menjadi default sejak 1.2.6 (M-01). Catatan 1.2.6 "daftar D01 (145)" memakai hitungan yang kini diberi label (N-3).
- Undo ke 1.2.6: tidak ada migrasi store yang ditambahkan (diff `04067a9d02..HEAD` pada `packages/datum-studio/src/store/migrations`, `packages/opencode/migration` dan `packages/core/src/database` kosong), jadi Undo ke 1.2.6 aman.

Sumber: `docs/2026-11-13_swarm_1_2_7_patch/report/release_note_inputs.md`, `decisions/decisions.md`, `identification/01_translated.md`.

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
