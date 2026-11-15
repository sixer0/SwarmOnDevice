# Changelog Swarm 1.1.0 sampai 1.3.1

Disusun 2026-11-13 (bagian 1.2.8 dan 1.2.9 ditambahkan 2026-11-14, bagian 1.3.0, 1.3.1 dan koreksi bagian lama 2026-11-15) dari catatan rilis, laporan akhir, log keputusan dan pesan commit tiap versi (sumber di akhir tiap bagian; path `docs/...` ada di folder kerja Swarm_OnDevice, di luar repo ini). Urutan terbaru di atas. "Diperbaiki" = cacat yang dibetulkan; "Baru" = fitur atau perilaku yang ditambahkan.

Catatan penomoran: sampai 1.1.4 versi app dan CLI tetap 1.19.3 (warisan basis); nomor rilis Swarm dibaca dari `SwarmRelease`. Mulai 1.2.0 versi app ikut nomor rilis Swarm.

| Versi | Tanggal | Cara rilis | Fokus |
|---|---|---|---|
| 1.3.1 | 2026-11-15 | Patch menu dari 1.2.0 sampai 1.3.0 (satu berkas) | Perbaikan cepat Obsidian: membuka graph saat Obsidian tertutup |
| 1.3.0 | 2026-11-15 | Patch menu dari 1.2.0 sampai 1.2.9 (satu berkas) | Masalah pengguna 1.2.9 (Obsidian, memori proyek di sesi, drift misi, salinan memori ke vault), backlog 1.2.9, perbaikan keamanan proxy swarm-web dan inbox vault (S-6); 1.2.10 tidak dirilis |
| 1.2.9 | 2026-11-14 | Patch menu dari 1.2.0 sampai 1.2.8 (satu berkas) | Backlog 1.2.8: diagram dan alat Studio, memori, vault dan skill, Mission Control dan pemindahan misi; perbaikan keamanan id sesi Mission Control |
| 1.2.8 | 2026-11-14 | Patch menu dari 1.2.0 sampai 1.2.7 (satu berkas) | Sisa 1.2.7 dan audit Swarm, kelola skill, memori ke Obsidian, sub-proyek, indeks memori, diagram setara minimum Visio |
| 1.2.7 | 2026-11-13 | Patch menu dari 1.2.0 sampai 1.2.6 (satu berkas) | Mission Control per sesi, CLI `swarm autonomy`, izin subagen, tempel dari Word, Add folder, polesan render |
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

## 1.3.1 (2026-11-15)

Dibangun dari `b28f52c052` (1.3.0). Perbaikan cepat untuk satu masalah Obsidian yang Anda temui setelah memasang 1.3.0; tidak ada perubahan lain.

**Diperbaiki**
- Obsidian. Di 1.3.0, "Open graph in Obsidian" menolak dengan pesan "tutup Obsidian dulu" padahal Obsidian sudah tertutup, sehingga vault Swarm tidak pernah terdaftar dan Obsidian tidak terbuka. Penyebabnya: saat Obsidian tertutup, macOS menjawab pemeriksaan "apakah Obsidian berjalan" dengan satu baris kosong, bukan jawaban kosong, dan 1.3.0 menganggap jawaban itu belum pasti. Kini baris kosong dibaca sebagai "Obsidian tertutup": Swarm mendaftarkan vault lalu membuka Obsidian. Jawaban lain yang tidak dikenal tetap ditolak seperti sebelumnya, dan bila Obsidian memang terbuka, Swarm tetap meminta Anda menutupnya dulu.
- Pesan hasil di tampilan memori (terdaftar, tutup Obsidian dulu, tidak terdaftar) kini menyebut folder vault yang Anda atur, bukan folder bawaan.

**Batasan yang diketahui**
- Bila folder vault Swarm berupa tautan simbolik (symlink) dan Obsidian sudah mendaftarkannya lewat tautan itu, Obsidian bisa tetap menjawab "vault not found". Tambahkan folder aslinya di Obsidian ("Open folder as vault"). Masuk backlog 1.3.2.
- Backlog 1.3.1 yang disebut di bagian 1.3.0 kini menjadi backlog 1.3.2.

**Catatan pemasangan**
- Patch menu 1.3.1 terpasang pada 1.2.0 sampai 1.3.0 lewat satu berkas, `swarm-1.2.0-to-1.3.1.swarmpatch`, dengan `--migration none`: tidak ada migrasi data. Versi 1.1.x tetap memakai DMG.
- Langkah Anda: tanda tangani patch, pasang lewat menu, tutup Obsidian, lalu tekan "Open graph in Obsidian" di tampilan memori satu kali. Obsidian terbuka dengan vault Swarm.

Sumber: keputusan U16, C127 sampai C129; commit `a3b4eac067`, `6711fa38f8`, `0bf06732ba`.

## 1.3.0 (2026-11-15)

Dibangun dari `a3e3c4c93a` (1.2.9). 1.2.10 tidak dirilis; isinya masuk 1.3.0. Isinya: empat masalah yang Anda laporkan pada 1.2.9 terpasang (Obsidian "vault not found", tombol memori proyek hilang di tengah misi, perubahan langkah setelah persetujuan yang tidak tercatat, catatan memori yang tidak sampai ke vault), sebagian besar backlog 1.2.9 (kode B10-xx di bawah), dan satu perbaikan keamanan yang memblokir rilis ini (S-6). Pekerjaan 1.3.0 lain yang sudah dirancang tetapi belum dikerjakan pindah ke backlog 1.3.1; yang penting bagi Anda tercantum di "Batasan yang diketahui". Hasil suite penuh, review keamanan dan uji langsung pada app terbangun dicatat di laporan rilis.

**Baru**
- Obsidian. "Open graph in Obsidian" kini memeriksa dulu apakah vault Swarm sudah ada di daftar vault Obsidian, lalu mendaftarkannya sendiri sebelum membuka Obsidian, sehingga pesan "vault not found" tidak muncul lagi. Daftar vault Obsidian ditulis utuh atau tidak sama sekali: entri lain tetap, dan cadangan daftar lama dibuat sekali sebelum perubahan pertama. Pendaftaran hanya berjalan saat Obsidian tertutup; bila Obsidian terbuka, tampilan memori meminta Anda menutupnya dulu dan tidak ada yang ditulis. Folder yang tidak aman sebagai vault (akar disk, folder rumah atau induknya, folder data Obsidian sendiri) ditolak. Hasilnya tampil sebagai pemberitahuan singkat di tampilan memori: terdaftar, tutup Obsidian dulu, atau tidak terdaftar. Teks persetujuan Obsidian di Install tools kini menyebut entri daftar vault dan cadangannya.
- Memori proyek di sesi. Baris Project memory kini tampil di bawah kotak tulis sesi selama seluruh sesi, juga saat pertanyaan atau izin sedang terbuka; sebelumnya hanya di layar sesi baru. `/memory` tetap bekerja seperti biasa.
- Memori ke vault. Catatan memori yang ditandai hanya-di-perangkat (device-only) kini bisa Anda salin ke vault Obsidian sendiri: di tampilan memori, catatan seperti itu mendapat tombol "Copy to vault", dan catatan yang sudah disalin mendapat "In vault: remove". Kedua tombol hanya ada di aplikasi desktop Swarm dan hanya Anda yang bisa memakainya; agen tidak bisa. Tampilan memori menyebut alasan sebuah catatan tidak ikut ke vault, ditambah satu kalimat aturannya. Catatan hub di vault menyebut berapa catatan yang tidak disalin per alasan (device-only, berisi kata klasifikasi, tampak memuat kata sandi atau kunci) dan cara menyalin catatan device-only.
- Mission Control. Perubahan pada langkah misi setelah persetujuan (termasuk dependensi) kini tercatat di `derived.drift.changed`, dan baris drift di panel menghitung langkah yang diubah setelah persetujuan, selain langkah yang ditambah. Skill `mission-control` menyebut perubahan baris ini.

**Diperbaiki**
- Memori dan vault: salinan laporan dari catatan indeks yang diekspor hanya dibuat selama laporannya tidak berubah sejak Anda menyalinnya; bila berubah, vault hanya menyimpan tautan dengan keterangan "berubah sejak Anda menyalinnya". Catatan yang sudah disalin lalu berubah menjadi catatan berkata klasifikasi atau tampak memuat kredensial kehilangan salinan vault-nya pada sinkronisasi berikutnya. "In vault: remove" menghapus salinan yang dibuat Swarm; salinan yang sudah Anda edit sendiri tetap. Skill `obsidian-memory` menyebut pengecualian device-only dan bahwa hanya Anda yang mengekspor; skill inbox melarang agen menyalin catatan memori proyek Swarm ke inbox.
- Studio dan diagram: lint grafik kini melaporkan konektor yang menyusuri garis tepi kotak, termasuk kotak ujungnya sendiri, di laporan render, pemberitahuan pratinjau dan catatan FIGURE_FIT, sebagai informasi saja, bukan cacat (B10-02); pratinjau contoh g04 kembali tanpa masalah tata letak. Penolakan `PATH_OUTSIDE_ROOTS` dan deskripsi `downloadDir` kini menyebut folder sesi Anda sendiri, juga setelah sesi dipindahkan ke dalam grup (B10-14). Skill `diagram-flow` menjelaskan mesin diagram Studio, perubahan 1.2.8 dan 1.2.9, diagram alur lama dan saran rute lewat titik `via`; sebuah tes kini memastikan setiap nama alat, kode fit dan token di skill itu memang ada di kode.
- Mission Control: penolakan pesan pemilik lewat `studio_mission_update_row` punya kalimatnya sendiri, dan petunjuk sesudah penolakan mengikuti alat yang sebenarnya dipanggil, dengan petunjuk `OWNER_ONLY` untuk pesan pemilik (B10-11).
- Perbaikan backlog 1.2.9 lainnya: petunjuk sistem menulis `swarm-web_search` dan `swarm-web_fetch` dengan nama lengkap (B10-01); pembersih jalur log kini juga menangani jalur yang menempel pada karakter sebelumnya, folder rumah yang diikuti titik lalu tanda baca, jalur yang di-encode untuk URL, folder rumah dengan huruf besar-kecil berbeda, dan tautan `file:` (tercatat sebagai `file:<path>`) (B10-04); persetujuan draf skill terikat pada versi draf yang Anda lihat, sehingga draf yang diganti agen saat konfirmasi masih terbuka ditolak dengan `SKILL_CHANGED` dan daftar dimuat ulang (B10-07); setelah sebuah berkas di path Default Project disingkirkan, klik Recreate pertama kini membuat folder (B10-17); pemuatan ulang Pulihkan atau Recreate yang tidak pernah selesai kini dibatasi waktunya, sehingga pemberitahuannya tidak lagi tercatat terbuka selamanya (B10-15, sebagian).
- Perubahan internal tanpa efek yang terlihat: penjaga ekspor lebih teliti (pembaca dicocokkan per ikatan, entri usang palsu tidak lagi menggagalkan build dan pesan menyebut `--prune-stale`, berkas produksi yang mengimpor harness uji ditolak) (B10-05, B10-09, B10-13); tes yang mengunci jumlah baris ekspor diganti tes kasus (B10-12); tes A09/A10 memeriksa kode yang tepat; pin topik pemindahan misi membaca nilai sebenarnya (B10-10); pin deklarasi kuota gambar (B10-06); tes `submit` app lulus bila dijalankan sendiri (B10-16); `script/swarm` punya typecheck sendiri.

**Keamanan**
- Diperbaiki, tingkat tinggi (S-6). Sampai 1.2.9, patch menu tidak pernah memperbarui salinan proxy `swarm-web` yang dipasang Install tools di folder setup Swarm. Pada Mac yang dipasang lewat patch, pemeriksaan kata klasifikasi untuk inbox vault dari 1.2.9 (B01) karena itu tidak aktif. Di 1.3.0: aplikasi menyegarkan salinan proxy itu dari bundel aplikasi sekali setiap kali dibuka, bila isinya berbeda, dan hanya bila foldernya sudah ada dan aman (milik Anda, bukan tautan, tidak bisa ditulis pengguna lain); Swarm sendiri menolak catatan inbox vault yang memuat kata klasifikasi (nama, slug, isi) sebelum pertanyaan persetujuan dan sebelum panggilan MCP, sehingga penolakan berlaku walau proxy lama masih terpasang; kesehatan tool menandai salinan proxy yang isinya berbeda dari bundel; dan proxy melaporkan versi build-nya yang sebenarnya.
- Agen tidak bisa lagi menulis langsung ke folder `inbox/` vault lewat Write, Edit atau `apply_patch` di mode apa pun; di mode otonom, tulisan shell ke folder itu juga ditolak. Membaca tetap boleh.
- Proxy `swarm-web` dan alat setup tidak lagi memuat `bunfig.toml` atau `.env` dari folder proyek tempat keduanya dijalankan, sehingga berkas di proyek tidak bisa mengubah perilaku keduanya. Tulisan agen ke folder setup Swarm kini ditolak, juga dengan persetujuan Anda dan di mode otonom.
- Ekspor catatan device-only ke vault hanya bisa dilakukan Anda di aplikasi desktop (lewat rute khusus orang yang memeriksa nonce desktop); permintaan tanpa nonce ditolak dengan `MEMORY_PERSON_ONLY` dan tidak ada yang ditulis. Mengubah tanda device-only lewat `PATCH /memory/:id` juga butuh nonce itu, dan penyimpanan memori sendiri menolak perubahan tanda device-only yang tidak dibuktikan berasal dari Anda. Setiap ekspor, pembatalan dan penolakan meninggalkan satu baris audit di log, tanpa isi catatan.

**Diubah (perilaku)**
- Inbox vault: tulisan agen ke `inbox/` vault lewat alat berkas ditolak (lihat "Keamanan"). Pakai `swarm-web_vault_inbox` untuk catatan inbox.
- Obsidian: membuka graf memori di Obsidian kini bisa mengubah daftar vault Obsidian Anda (satu entri ditambah untuk vault Swarm, cadangan dibuat sekali). Obsidian harus tertutup untuk langkah ini.
- Memori: catatan device-only bisa masuk vault, tetapi hanya lewat "Copy to vault" oleh Anda. Pengalihan model tidak berubah: catatan device-only tetap hanya dipakai model di perangkat.
- Diagram: konektor grafik yang menyusuri kotak kini muncul sebagai informasi di laporan render dan pratinjau; render tidak gagal karenanya.

**Batasan yang diketahui**
- Keamanan memori dan desktop (backlog 1.3.1): teks catatan device-only masih bisa dibaca oleh shell agen lewat `GET /memory` atau berkas store memori (B13-04); catatan yang ditambah atau diubah tanpa nonce desktop masih tercatat sebagai `source: "user"` (B13-05); konfirmasi ekspor ke vault masih ditampilkan di dalam aplikasi, belum dialog native dari proses utama, jadi tidak bertahan terhadap renderer yang sudah dibobol (B13-06); handler `open-path` di desktop belum memeriksa pengirim dan belum menolak berkas yang bisa dijalankan (B13-03); `project.dir` di luar folder sesi masih diterima (B13-07).
- Inbox vault: dengan mode otonom mati, tulisan shell agen ke `inbox/` vault tidak ditolak, tetapi sampai ke pertanyaan persetujuan Anda (sama seperti folder memori Swarm); tolak bila tidak Anda kehendaki (B13-44). Pemeriksaan kata klasifikasi tetap pengaman terhadap kekeliruan, bukan penyaring terhadap ejaan yang disengaja (huruf berspasi, karakter tak terlihat, huruf yang mirip).
- Pemeriksaan kredensial memori bisa salah menolak entri indeks yang panjang (B13-08). Peran baca menolak `git --format='…'` yang berkutip (B13-09).
- Memori ke vault: setelah laporan sebuah catatan indeks berubah, tampilan memori hanya menawarkan "In vault: remove"; untuk menyalin versi baru, pilih remove lalu "Copy to vault" (B13-35). "Copy to vault" kadang ditawarkan untuk catatan yang tidak bisa ditulis mirror (B13-36).
- Teks: baris drift di panel misi masih menulis "1 steps added" (B13-22); baris hub vault berbahasa Inggris menulis "1 notes", dan teks Indonesianya untuk catatan yang tampak memuat kata sandi memakai kata klasifikasi (B13-23); penolakan pesan pemilik belum menyatakan bahwa tidak ada yang tersimpan (B13-21).
- Diagram dan Studio: label tepi belum bisa digeser ke samping garis (`label_side`, B13-11); persilangan tegak lurus di titik belok belum dilaporkan (B13-12); lattice gambar belum sampai ke agen di pratinjau (B13-15); contoh g04 masih dibekukan dengan label tertutup dan konektor di tepi atas kotak (B13-17); `studio_write` masih menolak `{diagram}` di laporan kerja, sedangkan jalur Markdown menerimanya (B13-19); belum ada petunjuk untuk status `RENDER_VERIFY_PENDING` (B13-20); galat konversi masih bisa tampil sebagai `DOC_KEY_MISMATCH` (B13-18).
- Pemberitahuan folder: dua pemberitahuan untuk path yang sama dalam satu jendela masih digabung (B13-24), dan bila aplikasi tidak tahu folder mana yang gagal, pemberitahuan folder lain masih menyembunyikan galatnya (B13-25).
- Daftar lengkap ada di `docs/2026-11-15_swarm_1_2_10_patch/report/backlog_1_3_1.md`.

**Catatan pemasangan**
- Patch menu 1.3.0 terpasang pada 1.2.0 sampai 1.2.9 lewat satu berkas, `swarm-1.2.0-to-1.3.0.swarmpatch`, dengan `--migration none`: tidak ada migrasi data baru. Store memori mendapat dua kolom opsional untuk ekspor ke vault; catatan lama tidak diubah. Versi 1.1.x tetap memakai DMG.
- Undo Last Update setelah 1.3.0 berjalan kembali ke versi yang terpasang sebelum patch, dengan catatan yang sama seperti 1.2.9 untuk versi di bawah 1.2.8.
- Saat aplikasi 1.3.0 pertama kali dibuka, salinan proxy `swarm-web` yang lama diganti otomatis (S-6). Sampai 1.3.0 terpasang, anggap isi inbox vault bisa dibaca siapa pun yang punya akses ke vault.
- Langkah Anda: tanda tangani patch, pasang lewat menu, lalu jalankan prompt pasca-pemasangan 1.3.0. Pin `mcp_timeout` di `swarm.jsonc` Anda boleh dilepas atau dipertahankan; nilai bawaannya sama.

**Koreksi bagian lama (errata)**
Baris berikut diubah di tempatnya dan diberi tanda "(dikoreksi di 1.3.0)":
- 1.2.9, paragraf pembuka: ditambah commit tempat angka tes diukur, asal angka app browser, dan lokasi log dengan sha256.
- 1.2.7, "Perlu diketahui", kalimat `mcp_timeout`: "sudah menjadi default" diganti dengan nilai dasar di kode beserta lokasinya, dan dicatat bahwa pin pengguna menutupi nilai itu dan perilaku tanpa pin belum diuji langsung.
- 1.2.7, "Perlu diketahui", kalimat D01: angka D01 di catatan 1.2.6 dijelaskan sebagai total dokumen uji sintetis, dan total pada dokumen riset nyata ditambahkan.
- 1.2.6, "Baru", kuota gambar: dinyatakan bahwa kuota hanya berlaku bila parameter templatnya diisi, dan tidak ada templat bawaan yang mengisinya.
- 1.2.6, "Perlu diketahui", hitungan diagram: dinyatakan sebagai hasil sapuan pratinjau sebelum rilis, ditambah hasil uji langsung pada app terpasang yang berbeda; nama dokumen riset diganti sebutan netral.

Angka uji: report/numbers_1_3_0.md (sha256 diisi saat rilis)

Sumber: `docs/2026-11-15_swarm_1_2_10_patch/decisions/decisions.md` (U1, U5, U6, U12, U13, C35 sampai C114), `masterplan/01h_spec_1_3_0_handoff.md`, `research/04d_handoff_changelog_release.md`, `report/backlog_1_3_1.md`, `implementation/` per baris, `git log a3e3c4c93a..HEAD`.

## 1.2.9 (2026-11-14)

Cabang `release/1.2.9`, dibangun dari `d4282fcfd8` (1.2.8). Isinya seluruh backlog 1.2.9: 34 butir dalam tiga kelompok, yaitu A diagram dan alat Studio (13), B memori, vault dan skill (10), dan C Mission Control dan pemindahan misi (11), ditambah satu perbaikan keamanan tingkat tinggi yang sudah ada sejak 1.2.7. Kode A01 sampai C11 di bawah adalah nomor butir backlog. Semua 48 baris penerimaan diperiksa: 21 terpenuhi, 16 terpenuhi dengan sisa yang diterima (tercantum di bawah), 11 terpenuhi di kode dan lulus uji langsung pada app terbangun, 0 tidak terpenuhi. Tes saat pembekuan kode: datum-studio 5984 lulus, opencode 8641, app 1481 unit dan 118 browser, setup 1368, desktop 1549; yang gagal hanya dua kegagalan dasar yang sudah dikenal dari 1.2.8, dan typecheck 32 dari 32 bersih. Review keamanan akhir, review keamanan delta dan senior review dijalankan; tidak ada temuan High atau Medium yang terbuka, dan satu temuan major dari senior review diperbaiki sebelum rilis. Angka tes diukur di `dbaa0c4b2f`; commit sesudahnya diuji dengan suite delta; app browser 118 adalah hasil dua jalan ulang setelah satu timeout hook. Log dan sha256: `docs/2026-11-14_swarm_1_2_9_patch/test/logs/SHA256SUMS`, ringkasan `test/01_test_report.md`. (dikoreksi di 1.3.0)

**Diperbaiki**
- Diagram dan alat Studio (kelompok A): label pendek pada render pertama tidak lagi tertimpa potongan garis putus-putus (A04); tanda TERUKUR kini berada di dekat lingkaran yang dilabelinya dan bergeser ke samping bila sebuah konektor masuk ke lingkaran itu dari arah tanda (A05); bingkai zona berjarak paling sedikit 1,5 mm dari garis tepi simpul, baik simpul anggota zona maupun bukan (A06); setelah membelok, konektor masuk tegak lurus ke simpul berbentuk kotak (A08); titik berulang di jalur konektor dihapus (A02). Perbaikan A02, A04, A06 dan A08, serta pergeseran tanda TERUKUR ke samping, berlaku untuk diagram yang bukan diagram alur lama (keluarga `flow` tanpa `direction`); lihat "Keterbatasan yang diketahui". Di modul grafik, flowchart BPMN menggambar event sebagai lingkaran dan menyusun simpul menurut urutan alur (A11). `studio_figure_preview` kini melaporkan `backupResidue` dan `studio_mission_export` melaporkan `backupRemoved`, seperti alat lain yang menyimpan cadangan di folder `.bak/` (A12). Setiap deskripsi alat host DATUM Studio kini paling banyak 450 karakter; alat, kode dan aturannya tetap sama (A13). Tiga pemeriksaan diagram baru, lihat "Diubah (perilaku)" (A09, A10).
- Memori, vault dan skill (kelompok B): catatan inbox vault yang memuat kata klasifikasi ditolak (B01, lihat "Diubah (perilaku)"); salinan laporan di vault memutus pembuka Templater (`<%`) di dalam kode (span dan blok kode) dan di nilai frontmatter yang dibuat Swarm (misalnya `aliases`) dengan spasi lebar-nol yang tidak terlihat, sehingga Templater tidak menjalankannya; salinan yang sudah ada ditulis ulang sekali pada sinkronisasi berikutnya (B02); petunjuk sistem kini menulis nama alat `swarm-web_vault_inbox` dengan lengkap (B03); di Settings > Skills, draf skill yang menjalankan perintah di proyek yang belum dipercaya langsung ditolak, tanpa meminta konfirmasi kedua lebih dulu (B08); log kini memakai satu pembersih jalur untuk semua tempat (B06, lihat "Keamanan"); skill `swarm-whats-new` memuat brief 1.2.9 untuk agen dan memulihkan tiga batasan kalimat yang hilang di 1.2.8 (menambah atau menyambungkan server MCP; tes dan build yang dikenali; hanya opsi curl/httpie/xh yang terdaftar, selain itu ditolak) serta aturan bahwa proyek percobaan dibuat di luar Default Project atau di folder yang Anda sebutkan (B10).
- Mission Control dan pemindahan misi (kelompok C): hasil pemindahan memakai bentuk tunggal untuk satu misi ("1 mission moved" / "1 misi dipindahkan"), begitu juga tombol rapikan berbahasa Inggris ("Approve and move 1 mission") (C04); lokasi yang ternyata berkas, bukan folder, ditolak dengan `LOCATION_NOT_FOLDER` (HTTP 400) alih-alih galat server 500 (C07); bila ada berkas di path Default Project, aplikasi hanya menampilkan pemberitahuan folder, tanpa halaman galat, dan setelah berkas itu disingkirkan tombol Pulihkan memuat ulang aplikasi tanpa halaman galat dan tanpa memulai ulang; bila pemberitahuan itu ditutup dengan X atau Choose folder, galat yang tadinya disembunyikan tampil sebagai halaman galat biasa, sehingga tidak ada panel kosong; pemberitahuan dicatat per folder, sehingga pemberitahuan untuk satu folder tidak menyembunyikan galat folder lain (C07); berkas hasil (deliverables) dicari di folder misi, Open dan Reveal memakai folder tempat berkas itu ditemukan, dan folder yang tidak ada dijawab dengan daftar kosong dan satu baris peringatan, tidak lagi memenuhi log dengan galat berulang (C08); pada layar 1024x640, membuka Berkas di lembar keputusan tidak lagi menggeser tombol pilihan keluar dari jangkauan (C09); tautan sesi di `studio_mission_create` yang bukan sesi pemanggil dibuang dengan catatan `SESSION_REF_IGNORED`, sehingga misi tidak bisa ditautkan ke sesi yang dikarang (C03). Pemindahan misi ditolak bila ada terminal yang masih berjalan di dalam folder misi, juga bila folder proyek terminal itu sudah dihapus dari disk; di 1.2.8 pemeriksaan terminal terbuka ini tidak bekerja sama sekali, karena tidak melihat terminal yang sebenarnya berjalan (C05). Lokasi yang ditulis dengan garis miring di akhir (`Alias/`) yang sebenarnya tautan kini ditolak seperti tautan lain (C11).
- Perubahan internal tanpa efek yang terlihat: `route.ts` mesin diagram dipecah menjadi tiga modul tanpa perubahan byte (A01); nama yang tidak dipakai dihapus, ekspor yang hanya dipakai di berkasnya sendiri dijadikan lokal, dan penjaga baru menggagalkan build bila muncul ekspor baru tanpa pembaca di luar berkasnya (A03); penjaga manifest SVG aktif kembali (A07); `moved.renamed` kini ada di skema HTTP dan SDK (B04); tes yang sebelumnya bisa lulus tanpa memeriksa apa pun kini benar-benar memeriksa (B05, B07, C02); kait reset khusus uji untuk penyimpanan Secrets (B09).

**Keamanan**
- Diperbaiki, tingkat tinggi (S9-01). Sejak 1.2.7, proses lain di Mac yang sama yang dapat membaca log Swarm bisa memakai ulang id sesi Mission Control milik aplikasi untuk mencatat jawaban atas nama Anda. Di 1.2.9 kunci Mission Control diperiksa pada setiap permintaan, bukan hanya saat sesi dibuka, dan id sesi itu tidak lagi ditulis ke log. Masalah ini sudah ada di 1.2.7 dan 1.2.8 (bukan dibawa oleh 1.2.8) dan hanya dapat dipakai oleh proses lokal yang bisa membaca log Swarm.
- Jawaban dan keputusan atas nama Anda hanya diterima dari Mission Control di aplikasi Swarm (C01); pemindahan misi diperiksa sendiri oleh server terhadap jawaban Anda yang tersimpan di DATUM Studio (C06). Rinciannya di "Diubah (perilaku)".
- Default Project tidak lagi dibuat atau dipakai lewat folder Documents yang berupa tautan, dan pemindahan lewat induk Default Project yang berupa tautan ditolak (C10), sehingga pemindahan yang Anda setujui tidak bisa dialihkan ke luar Documents.
- Log: jalur di folder rumah Anda kini tercatat sebagai `<path>` atau dengan `~` sebagai ganti folder rumah, lewat satu pembersih yang sama untuk log dan catatan vault (B06). Beberapa bentuk jalur yang tidak biasa masih lolos; lihat "Keterbatasan yang diketahui".

**Diubah (perilaku)**
- Klien dari luar app tidak bisa lagi bertindak sebagai Anda (C01). Mulai 1.2.9, jawaban dan keputusan atas nama Anda (`by: user`) hanya diterima dari Mission Control di aplikasi Swarm. Klien MCP dari luar aplikasi, misalnya sesi Claude Code, tidak bisa lagi mencatat jawaban (`studio_mission_answer_decision`) atau keputusan (`studio_mission_record_decision`, termasuk keputusan di dalam `studio_mission_create`) sebagai Anda, dan tidak bisa lagi mengirim pesan yang tampil sebagai pesan dari Anda (pemilik) di Mission Control. Permintaan seperti itu ditolak dengan kode `SESSION_NOT_ATTESTED` dan tidak ada yang disimpan. Klien itu tetap bisa meminta keputusan Anda dengan `studio_mission_request_decision` lalu menunggu jawaban Anda di Mission Control; jawaban Anda tercatat sebagai keputusan `U<n>` dan bisa dipakai untuk menyetujui misi. Hanya saat mode otonom Swarm aktif, sebuah agen boleh mencatat keputusannya sendiri sebagai pengendali (`by: controller`, keputusan `C<n>`). Agen Swarm sendiri tidak terpengaruh.
- Pemindahan misi butuh jawaban Anda yang sudah tercatat (C06). Saat memindahkan misi (penempatan atau rapikan), Swarm kini memeriksa sendiri di DATUM Studio bahwa Anda yang menjawab, sebelum folder dipindahkan. Jika DATUM Studio tidak berjalan, belum tersambung, terlalu lambat (lebih dari 5 detik), atau diganti oleh konfigurasi proyek, pemindahan ditolak dan tidak ada yang dipindahkan. Pesannya: "Swarm tidak dapat memastikan jawaban Anda untuk pemindahan ini di DATUM Studio." Jika Anda mematikan DATUM Studio di konfigurasi Anda sendiri (`"enabled": false`), pemindahan misi juga ditolak.
- Documents yang berupa tautan (C10). Jika folder Documents Anda sendiri adalah tautan (symlink) ke folder lain, Swarm tidak lagi membuat Default Project lewat tautan itu dan tidak memindahkan misi di dalamnya. Aplikasi lalu menampilkan bahwa Default Project belum disiapkan, karena Swarm sengaja tidak meneruskan lokasi yang melewati tautan. Folder Documents biasa tidak terpengaruh.
- Inbox vault (B01). Catatan inbox vault (`swarm-web_vault_inbox`) yang nama, nama berkas, atau isinya memuat kata klasifikasi ditolak dengan `BLOCKED_BY_POLICY: classified_content`, dan tidak ada yang ditulis.
- Jenis cacat FIGURE_FIT baru (A09, A10). FIGURE_FIT kini menggagalkan gambar karena `GEOM_EDGE_ALONG` (konektor yang menyusuri garis tepi simpul lain), `GEOM_EDGE_HEADER` (konektor yang melintasi teks judul pool atau lane) dan `GEOM_EDGE_DOUBLE_BACK` (rute yang terjepit di tepi gambar lalu berbalik); untuk masing-masing, pemeriksaan atas 410 render tidak menemukan laporan keliru. Preview melaporkan ketiganya. Render ulang dokumen lama yang memuat salah satu pola ini kini gagal FIGURE_FIT sampai diagramnya diperbaiki.
- Render ulang dokumen lama dengan diagram yang bukan diagram alur lama bisa berubah sedikit: posisi label, tanda TERUKUR, bingkai zona, jalur ke kotak setelah membelok, dan titik berulang (lihat "Diperbaiki"). Diagram alur lama tidak berubah.

**Keterbatasan yang diketahui**
- Diagram alur lama (keluarga `flow` tanpa `direction`) sengaja dibekukan pada byte 1.2.5 agar dokumen yang sudah ada tidak berubah. Akibatnya perbaikan A02, A04, A06 dan A08 tidak berlaku di sana: konektor yang membelok mengitari simpul lalu masuk ke simpul berbentuk kotak masih bisa menyusuri sisi kotak itu dan dilaporkan sebagai `GEOM_ARROW_TANGENT`; jalurnya masih bisa memuat titik berulang (tidak terlihat pada gambar); label pendek pada render pertama masih bisa menyimpan potongan garis putus-putus; bingkai zona masih bisa menyentuh garis tepi simpul; dan rute yang berbalik di tepi gambar tetap digambar seperti semula (kini dilaporkan sebagai `GEOM_EDGE_DOUBLE_BACK`). Tambahkan `direction` (`TB` atau `LR`) pada diagram alur untuk mendapatkan perilaku baru. Penyempitan tata letak untuk memberi ruang bingkai zona hanya berlaku pada tata letak layered, topology dan stack.
- Tanda TERUKUR: pada lingkaran kecil (jari-jari sekitar 4,8 mm atau kurang) dan lingkaran bertag, tanda tetap di tempat biasanya dan bisa berada di garis konektor yang masuk ke lingkaran itu.
- Contoh grafik g04 di galeri: label "beres" tertutup kotak dan satu konektor berjalan di tepi atas kotak; lint grafik belum memeriksa kedua hal ini (sudah ada di 1.2.8; contoh ini sengaja tidak diubah). Periksa flowchart di modul grafik dengan mata.
- Documents yang berupa tautan: tidak ada Default Project lewat tautan itu, pemindahan ditolak, dan aplikasi menampilkan "Default Project not set up" (lihat "Diubah (perilaku)"). Pindahkan Default Project ke folder Documents biasa bila Anda butuh pemindahan misi.
- Pemindahan misi ditolak (tidak ada yang dipindah) bila DATUM Studio mati, belum tersambung, lebih lambat dari 5 detik, diganti oleh konfigurasi proyek, atau dimatikan di konfigurasi Anda sendiri.
- Jawaban dan keputusan yang sudah tersimpan sebelum 1.2.9 tidak diubah: keputusan `by: user` lama yang dicatat oleh klien luar masih bisa dipakai untuk menyetujui misi.
- Pemberitahuan folder, Recreate pertama: bila ada berkas di path Default Project saat aplikasi mulai lalu berkas itu Anda singkirkan, klik Recreate pertama ditolak dengan teks yang keliru ("parent folder is missing too", padahal induknya ada). Klik Pulihkan dulu, lalu Recreate, dan folder dibuat. Tidak ada halaman galat dan tidak ada data yang berubah (B10-17).
- Pemberitahuan folder tanpa folder yang diketahui: bila aplikasi tidak tahu folder mana yang gagal, misalnya pada sesi yang tidak pernah termuat, pemberitahuan folder mana pun yang sedang terbuka menyembunyikan galat `LOCATION_NOT_FOLDER` sampai pemberitahuan itu ditutup (B10-15).
- Sisa kecil pemberitahuan folder: dua pemberitahuan untuk path yang sama dalam satu jendela digabung menjadi satu, dan pemuatan ulang Pulihkan atau Recreate yang tidak pernah selesai membuat pemberitahuannya tetap tercatat terbuka (B10-15).
- Inbox vault: pemeriksaan kata klasifikasi adalah pengaman terhadap kekeliruan, bukan penyaring terhadap ejaan yang disengaja: huruf berspasi, karakter tak terlihat, huruf yang mirip dan entitas HTML lolos. Pemeriksaan hanya berlaku untuk `swarm-web_vault_inbox`; penulisan berkas langsung ke vault tidak diperiksa. Nilai yang tampak seperti rahasia (kata sandi, token) juga belum diperiksa oleh kode: jangan menaruhnya di catatan. Templater dengan pembatas buatan sendiri (bukan `<%`) tidak dicakup.
- Skill: jika agen mengganti draf skill saat konfirmasi kedua masih terbuka, yang disetujui adalah draf penggantinya. Periksa lagi perintahnya bila agen masih bekerja.
- Log: beberapa bentuk jalur yang tidak biasa masih lolos dari pembersih. Jalur yang menempel pada karakter sebelumnya (misalnya `-C` diikuti jalur) tetap menyimpan nama folder di bawah `~`; jalur tanpa tanda kutip yang memuat spasi menyisakan bagian setelah spasi; folder rumah yang diikuti titik lalu `)` atau `,` tidak diganti; jalur yang di-encode untuk URL (`%2F...`) atau folder rumah dengan huruf besar-kecil berbeda yang menempel pada kata lain tetap memuat nama akun; tautan `file://` di bawah folder rumah tercatat sebagai `file://~/<folder>`. Log tetap hanya di perangkat ini.

**Catatan pemasangan**
- Patch menu 1.2.9 terpasang pada 1.2.0 sampai 1.2.8 lewat satu berkas, `swarm-1.2.0-to-1.2.9.swarmpatch`, dengan `--migration none`: tidak ada migrasi data baru (store Studio, DB dan storage opencode, dan store memori tidak berubah). Versi 1.1.x tetap memakai DMG.
- Undo Last Update setelah 1.2.9 berjalan kembali ke versi yang terpasang sebelum patch. Bila versi itu di bawah 1.2.8, store Studio sudah bermigrasi ke 0008 sejak 1.2.8, sehingga Studio versi di bawah 1.2.8 menolak store itu sampai 1.2.8 atau yang lebih baru dipasang ulang (seperti dicatat di 1.2.8). Undo ke 1.2.8 tidak terkena hal ini.
- Uji langsung pada app terbangun sudah lulus untuk butir yang menunggunya (setelah perbaikan Pulihkan, diuji ulang pada build rilis): flowchart BPMN di modul grafik (A11), konfirmasi skill (B08), penolakan klien luar dan id sesi di log (C01), teks bentuk tunggal en dan id (C04), pemindahan dengan DATUM Studio mati (C06), Pulihkan (C07), Open dan Reveal berkas hasil (C08), lembar keputusan dengan Berkas terbuka (C09).
- Langkah Anda: tanda tangani patch, pasang lewat menu, lalu jalankan prompt pasca-pemasangan 1.2.9 (belajar, ingat, tanya, uji mandiri opsional di proyek percobaan). Pilihan yang menunggu keputusan Anda: build Linux/Windows (tetap ditahan) dan penghapusan cabang uji `swarm/*` (`swarm/main` terpisah).
- Pekerjaan lanjutan: 17 butir backlog 1.2.10 (B10-01 sampai B10-17), antara lain sisa pembersih jalur log, mengikat konfirmasi kedua skill ke versi draf, cek lint grafik g04, pengetatan penjaga ekspor, sisa pemberitahuan folder, dan teks penolakan Recreate pertama, ada di `docs/2026-11-14_swarm_1_2_9_patch/report/backlog_1_2_10.md`.

Sumber: `docs/2026-11-14_swarm_1_2_9_patch/verification/01_verification.md`, `verification/02_security.md`, `verification/03_code_review.md`, `masterplan/01_specs.md` §8-§10, `decisions/decisions.md` (sampai C125), `test/01_test_report.md`, `test/05_live_1_2_9r.md`, `implementation/79a_not_folder_app.md`, `79a2_notice_count.md`, `79a3_boundary_directory.md`, `79b_tidy_button_plural.md`, `report/backlog_1_2_10.md`, `git log d4282fcfd8..99b2f38974`.

## 1.2.8 (2026-11-14)

Cabang `release/1.2.8`, dibangun dari `main` `e1f9673772` (1.2.7). Dua bagian: menutup sisa dan backlog 1.2.7 (poin 1) serta temuan audit Swarm pasca-uji 1.2.7 (poin 2), dan lima kemampuan baru: kelola skill (poin 3), memori sebagai graf Obsidian (poin 4), sub-proyek di Default Project (poin 5), entri indeks memori setelah laporan akhir (poin 6), dan diagram setara standar minimum MS Visio (poin 7). Semua 103 baris penerimaan ditelusuri: 62 terpenuhi, 34 terpenuhi dengan sisa yang diterima (tercantum di bawah), 6 menunggu pemeriksaan oleh pengguna, 1 menunggu uji langsung akhir pada app terbangun. Tes rilis 1.2.8: 103 berkas, 1373 lulus, 0 gagal; suite penuh hijau kecuali dua kegagalan dasar yang sudah dikenal sejak 1.2.7. Review keamanan akhir, review keamanan delta dan senior review dijalankan; tidak ada temuan High atau Medium yang terbuka. Setelah uji langsung akhir, tiga kegagalannya diperbaiki (konektor diagram, rapikan misi, kunci pengulangan pemindahan) dan skill bawaan `swarm-whats-new` ditambahkan; uji langsung ulang untuk ketiganya menyusul pada app terbangun.

**Ditambahkan**
- Skill (poin 3): bagian Skills di Settings (tanpa panel baru) mendaftar semua skill (bawaan, global, proyek, `.agents/skills`) dengan sumber, deskripsi dan pemicu; skill bisa dibaca, diaktifkan atau dinonaktifkan (`skills.disabled` di config global), dibuat, diedit (konflik edit dideteksi) dan dihapus ke arsip. Agen menyusun draf lewat tool `skill_draft` dengan bantuan skill bawaan `skill-authoring`; draf baru tersimpan setelah Anda setujui, dan draf yang menjalankan perintah shell butuh konfirmasi kedua. Tiap skill yang disetujui mendapat satu catatan memori (nama, tujuan, pemicu). Frontmatter `triggers:` opsional (kata kunci atau frasa, pola berkas, tipe misi; tidak peka huruf besar) hanya menyarankan skill kepada agen, tidak memuatnya paksa. Skill baru langsung muncul tanpa restart.
- Obsidian (poin 4): memori proyek, entri indeks misi dan laporan akhir disalin sebagai catatan bertaut dengan nama yang terbaca (`<judul>-<id 6 hex>`) ke `~/.swarm/vault/swarm-memory/<proyek>/`. Tampilan memori mendapat satu tombol "Open graph in Obsidian" yang membuka catatan hub proyek (graph view tinggal satu perintah). Bila tidak ada handler `obsidian://` terdaftar, tombol membuka salinan Obsidian dari Install tools setelah cek integritas dan tanda tangan; Obsidian memang bagian dari bundel Install tools (keputusan pengguna U3). Skill bawaan wajib `obsidian-memory` (tampil "Required", tidak bisa dinonaktifkan) meminta agen menulis catatan vault saat misi ditutup dan saat keputusan penting dicatat, lewat `swarm-web_vault_inbox`.
- Sub-proyek (poin 5): sub-proyek = satu tingkat folder di bawah Default Project. Saat misi dibuat, kartu keputusan Mission Control menawarkan gabung ke grup X, buat grup baru Y, atau tetap di root; tidak ada yang dipindah sebelum Anda mengklik. Rapikan misi yang sudah ada: Swarm menyiapkan satu daftar usulan, Anda menyetujuinya sekali, lalu Swarm memindahkan misi beserta memorinya dengan jurnal, rollback dan cadangan. Skill bawaan `project-folders` memuat aturan pengelompokan.
- Indeks memori (poin 6): setelah laporan akhir, setiap misi mendapat satu entri indeks (tanggal, id misi, hasil, sampai 5 kata pemicu, path laporan; teks paling banyak 300 karakter, isi 2000). Paling banyak 40 entri per proyek; entri lama digabung menjadi ringkasan per kuartal atau per tahun, tidak ada yang dipotong. Sesi baru memuat entri indeks dalam anggaran sekitar 2000 token dan membuka isi dua entri yang paling cocok. Tampilan memori menampilkan grup indeks.
- Diagram (poin 7): set bentuk Basic Flowchart, Cross-Functional (lajur dan fase, vertikal atau horizontal) dan BPMN Basic (event, task, sub-process, gateway, pool/lane, data object, message flow). Konektor lurus, siku atau lengkung; menempel ke sisi atau titik sambung; titik belok; mata panah di kedua ujung dengan jenis dan ukuran; garis putus-putus dan tebal; label dengan posisi; lompatan garis di persilangan. Label event dan gateway BPMN diletakkan di bawah bentuk. Katalog lengkap di resource baru `studio://skema/diagram-visio`; skill bawaan baru `diagram-flow` untuk menyusun diagram alur bisnis. Semua lewat spesifikasi diagram dan preview; tidak ada editor seret-lepas.
- Brief agen per versi: skill bawaan `swarm-whats-new` memuat brief untuk agen dari 1.2.0 (termasuk 1.1.4) sampai 1.2.8, terbaru di atas, masing-masing berisi apa yang bisa dilakukan, apa yang wajib, dan batasnya; dipicu kata seperti "versi baru", "fitur baru", "apa yang bisa", "what's new" atau "changelog". Setelah pembaruan agen mempelajari dulu (memeriksa bahwa tool, skill dan rute yang disebut memang ada), menyimpan catatan memori per versi beserta entri indeks, lalu bertanya "Apakah Anda mau saya uji semua update barunya?"; uji mandiri yang aman dan tidak merusak hanya berjalan setelah Anda menjawab ya, di misi atau proyek uji, dan hasilnya (PASS/FAIL dengan bukti) disimpan sebagai catatan memori. Apa pun yang memindahkan misi, menghapus, mengubah config atau menyentuh proyek nyata butuh "ya" tersendiri. Prompt siap tempel untuk dijalankan setelah pasang ada di `docs/2026-11-13_swarm_1_2_8_patch/report/post_install_memory_prompt.md`: Swarm membuat misi Mission Control `2026-11-14_swarm-1-2-8-whats-new`, menulis laporan lalu entri indeks, dan bertanya sebelum menutup misi.

**Diperbaiki**
- Sisa 1.2.7 (poin 1): `autonomy-table.ts` dipecah menjadi modul tanpa perubahan perilaku (R-1); tabel opsi httpie/xh satu sumber dan penelusuran `cd` disatukan (R-2); `gen-lock.ts` tidak lagi bergantung pada path build (R-3); flag tersembunyi `swarm run` (`--yolo`, `--dangerously-skip-permissions`) tidak melewati penolakan apa pun, termasuk `run` bersarang (R-4); lalu lintas app ke servernya sendiri di loopback tidak lagi lewat proxy yang dipasang dengan `--proxy-server`, dan daftar bypass dari pengguna dipertahankan (R-5); kunci i18n yang tidak dipakai dihapus (R-6); mode uji menyimpan Documents dan Default Project di dalam root uji (R-7); roda tetikus di atas entri Keputusan yang tertutup (R-8); di jendela 1024x640 dengan opsi keputusan panjang area pertanyaan tidak lagi mengempis (R-12); pembaca perintah subagen mengenali fungsi `f()` di skrip paket dan program dari config git global (R-17); perubahan skill terdeteksi walau waktu ubah dan ukurannya sama (R-18a); folder hilang ditangani juga pada tambah proyek, onboarding dan hapus workspace (R-18c); log sukses saat menampilkan berkas di Finder (R-18f).
- Perbaikan dari audit Swarm (poin 2): `studio_mission_create` menolak `session` yang tidak dikenal dengan `SESSION_UNKNOWN` (H-N12); blok `diagram` kini tersimpan lewat semua jalur agen (`chapter_submit` objek atau string, blok markdown, `studio_write`, `studio_edit`, dokumen v1) dan importer menghitung serta menyebut konstruksi yang tidak terpetakan, dengan cek token caption (H-NA, H-N13); `detail:true` pada `studio_mission_get` dan `studio_registry` berfungsi dan sha256 deliverable tampil penuh, juga di tampilan ringkas (H-N14, H-MC08); `studio_edit` memperingatkan tabel yang akan gagal `OVERLAP_CLIP` saat render (H-N15); `DOC_KEY_MISMATCH` memberi contoh payload dan batas 20 kolom tertulis di skema (H-N16); peran verifier boleh menulis berkas Markdown setelah bertanya (H-N17); `GEOM_ENTRY_COLLISION` dilaporkan pada diagram mesin saat dua ujung konektor menempel di slot yang sama, dan panduan diperbarui (H-N6); anggaran jenis garis DATUM-25L ditegakkan (jenis + putus-putus + tebal) (H-T06); kuota gambar terbaca tanpa hak admin (H-T18); teks aturan peran lama diperbarui (H-N1); kelas baca peran baca mencakup `mdls`, `pgrep` dan `git -C … log/status` (H-U7, H-U4b); rute baca server Swarm sendiri yang aman berjalan di bawah mode otonom bersetuju (H-U10).
- Diagram dari audit Swarm (poin 2): `hexagon` dan `parallelogram` diterima lewat set notasi (H-D35); mata panah lebih besar, 3,2 mm secara default, terbaca di ukuran cetak (H-ARW); glyph tag di dalam `stadium` tidak lagi terpotong (H-TAG); pemberitahuan AUTO_FIT tidak lagi menggemakan hitungan cacat sebelum fit, koreksi otomatis `CAPACITY_ADAPT`/`EDGE_LANES` dilaporkan, dan saran `GEOM_STUB_SEGMENT` menyebut perbaikan sebenarnya (jalur lebih panjang) (H-NB, H-NB2, H-NB3); DATUM-37 dipecah menurut penyebab: `-rank` (peringkat penuh) dan `-sheet` (node keluar lembar) (H-NB4).
- Celah cakupan dari audit Swarm (poin 2) ditutup dengan tes atau uji langsung tanpa cacat baru: H-N11, H-T12, H-T17, H-W13, H-F4, H-MC01, T-03, M-05, DOC1, S-02, PT-3, N-9, M-02, MC-03, MC-05, S-03, W-16.
- Ditemukan selama rilis: jalur blok render membuang `lane_orientation`, `phases`, `pools` dan `jumps` (kini terbawa dan diuji ujung ke ujung, dengan tes yang mengikat daftar field ke skema); bingkai pool yang melewati tepi gambar kini terdeteksi (`GEOM_FRAME_OUTSIDE`); label yang menutupi mata panah kini cacat (`GEOM_LABEL_COLLISION`); belokan kecil (jog) di jalur start ke keputusan dan konektor yang berjalan di atas garis lajur diluruskan; bayangan digambar sebelum konektor; rapikan dua misi yang berbagi satu sesi tidak lagi berhenti di misi kedua; saran skill menurut tipe misi kini muncul; pemindahan memori yang bertemu id catatan yang sama memberi id baru alih-alih menghilangkan catatan, dan penyimpanan memori serta jurnal di-fsync; teks catatan memori skill tanpa titik ganda dan menyebut pola berkas dan tipe misi; `VAULT_NOTE_FOREIGN` dicatat sekali per catatan per proses.
- Ditemukan pada uji langsung akhir, konektor diagram: konektor dengan titik belok tidak lagi menembus node ujungnya, tetapi memutarinya dan masuk ke sisi yang menghadap; titik belok di tepi lembar digeser setengah baris kisi ke dalam; konektor tetap di dalam gambar dan tidak lagi masuk ke area caption; ujung konektor selalu di garis tepi bentuk tujuan, tidak di bingkai zona. Konektor lurus yang menembus node tetap lurus tetapi kini dilaporkan (`GEOM_EDGE_NODE`); cacat baru `GEOM_EDGE_OUTSIDE` (konektor keluar gambar) dan `GEOM_EDGE_END` (ujung tidak di bentuk). Preview kini melaporkan setiap jenis cacat yang ditolak render penuh (FIGURE_FIT), sehingga preview yang bersih tidak lagi berakhir sebagai dokumen tidak terverifikasi.
- Ditemukan pada uji langsung akhir, rapikan misi: rapikan menolak memindahkan misi yang salah satu sesinya ada di folder lain ("lives in another folder"), kecuali sesi itu sudah dipindah oleh persetujuan yang sama. Persetujuan kini dikenali dari id permintaan plus misi pemegangnya, karena id permintaan bernomor per misi (dua rapikan bisa sama-sama D-1). Pemindahan yang diulang hanya menjadi no-op bila misi, asal, tujuan, id permintaan, misi pemegang dan kompensasinya sama dan folder misi masih di tempat pemindahan itu menaruhnya; pemindahan misi lain dengan id yang sama tidak lagi dianggap pengulangan.
- Ditemukan pada uji langsung ulang: tombol kartu keputusan Mission Control kadang terlihat tetapi tidak menerima klik (area utama yang tergulir oleh kode menaruh panel tertutup di atas tombol); area itu kini tidak bisa digulir, setiap tombol yang terlihat menerima klik pada 1280x800 dan 1024x640. Pada peluncuran pertama profil baru, pemindahan dan rapikan tidak lagi ditolak "Groups must be inside the Default Project": Default Project diteruskan sejak peluncuran itu dan diperiksa saat Anda bertindak. Bila Default Project atau folder grup tidak ada di disk saat Anda bertindak, pesannya menyebut folder yang hilang (`REHOME_FOLDER_MISSING`, en dan id) dan tidak ada yang dipindah; tidak lagi HTTP 500. Pesan `REHOME_ROOT_UNKNOWN` hanya untuk Default Project yang sama sekali belum dikenal. Default Project, folder asal, atau folder grup yang berupa symlink kini ditolak (`REHOME_SYMLINK`) sehingga pemindahan yang Anda setujui tidak bisa dialihkan ke luar Documents.
- Skill `swarm-whats-new` diperketat: uji mandiri hanya di proyek percobaan khusus yang dibuat agen setelah Anda menjawab ya, tidak ada percobaan menulis ke folder skill atau vault, brief 1.2.8 menyebut daftar rute server Swarm yang boleh dibaca agen, dan catatan vault hanya lewat `swarm-web_vault_inbox`.

**Keamanan**
- Di bawah mode otonom bersetuju, rute GET/HEAD server Swarm sendiri yang boleh berjalan tanpa agen utama hanya daftar tetap (tanpa override direktori di luar worktree pemanggil, hanya opsi curl/httpie/xh yang terdaftar); rute yang bisa membaca rahasia atau isi berkas tetap menunggu keputusan seperti di 1.2.7.
- Penulisan config (`PATCH /config`, `/global/config`), rute tulis skill dan pemindahan sub-proyek memerlukan nonce per peluncuran dari app desktop. Penempatan misi memakai kredensial Mission Control per peluncuran yang hanya ada di pesan start host Studio, tidak di `datum-studio.env`; asal jawaban keputusan dicatat.
- Satu baris kode interpreter (`python3 -c`, `node -e`, `perl -e`, `ruby -e`, `| python3 -`, di dalam `sh -c` dan heredoc, termasuk PHP, vim/nvim `-c` dan bentuk tulis lain) yang menulis ke folder skill atau ke `swarm-memory` di vault ditolak di semua mode, untuk agen utama dan subagen; bila ragu, ditolak. Satu baris yang hanya membaca tetap seperti semula.
- Salinan vault dibersihkan: blok kode yang bisa dieksekusi (dataviewjs, dataview, button, dan yang tidak ada di daftar izin) menjadi teks di tingkat bersarang mana pun; query Dataview inline dinetralkan; tautan non-web dinetralkan; catatan yang memuat kata TERBATAS, RAHASIA, CONFIDENTIAL atau RESTRICTED, catatan khusus perangkat dan nilai yang tampak seperti rahasia tidak disalin. `Skill.fmt` meng-escape `& < >`.
- Membuka salinan Obsidian dari Install tools hanya setelah sha256 biner cocok, `codesign --verify --deep --strict` lulus dan TeamIdentifier sama dengan pin yang dikirim bersama Swarm; dijalankan tanpa shell, alasan gagal tanpa path.
- Pemindahan sub-proyek: preflight semua-atau-tidak, sesi yang sedang bekerja ditolak, jurnal dengan rollback dan pemulihan saat start, berkas sementara dibuat eksklusif dengan nama acak, peta id aman terhadap nama seperti `constructor`.

**Diubah (perilaku)**
- Tool edit agen tidak lagi bisa menulis ke folder skill atau ke folder `swarm-memory` di vault dalam mode apa pun, juga dengan "always" (sebelum 1.2.8 mereka bertanya). Pakai Settings > Skills atau memori Swarm.
- Dengan mode otonom mati, perintah shell yang menulis berkas skill atau catatan cermin vault, serta `swarm run --yolo` dari agen, tampil kepada Anda sebagai prompt izin biasa: tolak dan pakai Settings > Skills atau memori Swarm.
- Mission Control menolak menutup misi sebagai `done` sebelum entri indeks memorinya ada; klien lain mendapat peringatan; dengan memori mati penutupan hanya memperingatkan. Misi lama tidak diisi mundur.
- Jawaban "oleh pengguna" yang direkam dari luar app Swarm ditandai sebagai direkam agen atas nama Anda; penolakan umum menyusul di 1.2.9.
- Perubahan config hanya diterima dari app desktop Swarm yang menjalankan server; TUI yang menempel ke server itu tidak bisa menulis config. `swarm serve` menolak penulisan skill dan pemindahan sub-proyek.
- Render ulang dokumen lama mengubah mata panahnya (lebih besar) dan jalur konektor flowchart (tanpa jog mundur). `GEOM_LABEL_COLLISION`, `GEOM_FRAME_OUTSIDE`, `GEOM_EDGE_OUTSIDE` dan `GEOM_EDGE_END` kini termasuk cacat yang menggagalkan FIGURE_FIT, dan konektor lurus yang menembus node kini dilaporkan sebagai `GEOM_EDGE_NODE`. Pool horizontal di lebar 128 mm ditolak dengan saran memakai pool vertikal. `P1-labels_verified` tetap cacat draf: agen harus memeriksa label.
- Kode DATUM-37 kini bersufiks `-rank` atau `-sheet`; peringatan baru `POOL_FLOW_CROSSES` untuk sequence flow yang keluar dari pool-nya.

**Keterbatasan yang diketahui**
- Skill dan vault: skill tingkat pengguna yang Anda taruh sendiri dengan blok shell dan cache `skills.urls` belum dicek kepercayaannya (1.2.9); di proyek tidak tepercaya, menyetujui draf yang menjalankan perintah meminta konfirmasi kedua dulu sebelum ditolak `SKILL_SHELL_UNTRUSTED`; dengan mode menyala, program di luar daftar baca yang menyebut path folder skill atau cermin vault (mis. `git -C ~/.agents/skills log`) ditolak, tool Read tetap jalan; skrip BERKAS, path yang dirakit dari variabel dan kode yang dienkode atau dibangkitkan (base64 + exec, `eval "$(...)"`) tidak dibaca; catatan inbox vault yang ditulis agen belum dicek kata klasifikasinya oleh kode (hanya oleh teks skill).
- Obsidian: catatan vault terbaca oleh Obsidian, plugin-nya dan sinkronisasi yang Anda nyalakan; catatan yang Anda edit tidak diperbarui lagi dan bisa menyimpan tautan basi setelah ganti nama; bahasa label mengikuti bahasa app, selain itu Indonesia; pengecualian klasifikasi berdasar empat kata utuh (catatan dengan kata biasa "rahasia" ikut dikecualikan); cermin baru disegarkan pada penulisan memori berikutnya setelah pemindahan; jeda singkat antara cek integritas dan peluncuran, versi `current.json` tidak dibandingkan dengan `tools.lock.json`, penilaian Gatekeeper (spctl) tidak diulang saat peluncuran. Bila Obsidian menolak membuka catatan, buka `~/.swarm/vault` sebagai vault.
- Sub-proyek: cadangan memori dan jurnal pemindahan disimpan tanpa batas (pembersihan 1.2.9); hanya pemindahan root ke grup (grup ke grup dan grup ke root belum ada); daftar rapikan lebih dari 200 misi dibagi per 200, masing-masing disetujui sekali, dan rapikan yang dihentikan diusulkan lagi sebagai permintaan baru; bila Default Project ada di dalam repo git langkah memori adalah no-op; cek terminal terbuka hanya melihat folder awal terminal; sesi yang dipakai beberapa misi dalam satu daftar pindah bersama misi pertama beserta catatannya; status sesi yang tersimpan di ejaan folder lain (`/var` vs `/private/var`) tetap di kunci lama dan tata letak tab sesi yang dipindah direset; teks hasil masih "1 missions moved" (bentuk jamak, 1.2.9); misi tanpa folder hanya punya id permintaan plus misi pemegang sebagai kunci no-op (panggilan lama tanpa misi pemegang tidak pernah dianggap pengulangan untuknya); proses lain milik pengguna yang sama yang berlomba dengan rename di luar model ancaman.
- Memori dan Mission Control: `studio/memoryIndex` mempercayai id agen yang dinyatakan sendiri (gerbang kepatuhan, bukan kontrol akses); isi indeks tak tepercaya disisipkan dengan labelnya; catatan memori biasa masih bisa menyimpan ref absolut (render vault membersihkannya); ref sesi di dalam `mission.sessions` belum dicek seperti `session` tingkat atas; beberapa deskripsi tool host melebihi 450 karakter (sudah ada sebelum 1.2.8).
- Izin: `indirectStateWrite` tetap membaca lebih luas; `git -C <dir>` tanpa repo di atasnya tetap ditahan untuk peran baca; di bawah persetujuan, `cd ~/x && ./run.sh` dari subagen coder berjalan seperti agen utama; skrip berkas yang dimulai `swarm run --yolo/--auto/--dangerously-skip-permissions` tidak dibaca.
- Diagram: katalog mata panah, posisi label, titik belok dan label di dalam bentuk non-BPMN adalah pilihan Swarm, bukan klaim paritas Visio; lebar pool horizontal memuat 2 kolom node pada 166 mm dan 1 pada 128 mm, 3 lajur atau fase muat di 166 mm dan ditolak di 128 mm; lompatan garis digambar di atas garis yang tidak terputus dan ujung garis sekitar 0,1 mm bisa terlihat di ujung mata panah pada garis 0,45 mm; persilangan tepat di belokan konektor lain diberi lompatan tetapi tidak dihitung lint; leader dipakai bila celah 4,8 mm tidak cukup; dua masukan di satu sisi diamond datar tanpa sudut bebas tetap di sisi miring (masuk ke keputusan dari atas); tag keluarga box berjarak 0,075 mm dari tepi garis untuk node di tepi lembar; `figure.lattice` berasal dari tata letak pertama; masuk tegak lurus ke sisi node setelah memutar hanya berlaku untuk bentuk non-box, konektor ke box tetap memakai jalur lama dan dilaporkan sebagai cacat (1.2.9); lebar gambar 166 mm tidak bisa dihasilkan dari app karena templat menetapkan 128 mm dan agen tidak bisa mengubahnya.
- Tampilan: entri Keputusan yang terbuka dengan detail pendek masih menahan roda tetikus; menyalin sel tabel daftar ID yang terlalu lebar dari Word membawa tanda putus tak terlihat (U+200B).
- Tidak termasuk dari Visio: expanded sub-process, loop task, pemicu event selain none/message/timer, manual input, delay, event-based gateway, memutar label lajur, mengubah ukuran swimlane, memindahkan separator setelah ditempatkan, editor seret-lepas.

**Catatan pemasangan**
- Patch menu 1.2.8 terpasang pada 1.2.0 sampai 1.2.7 lewat satu berkas, `swarm-1.2.0-to-1.2.8.swarmpatch`, dengan `--migration none` (alat patch hanya melacak sumber DB dan storage opencode, yang tidak berubah sejak 1.2.0). Versi 1.1.x tetap memakai DMG.
- Studio menjalankan migrasi store 0008 (asal jawaban keputusan) saat app mulai. Akibatnya: Undo ke versi di bawah 1.2.8 setelah 1.2.8 berjalan membuat Studio menolak store sampai 1.2.8 dipasang ulang (seperti 1.2.6).
- Pemeriksaan oleh pengguna setelah pasang: satu peluncuran dengan proxy sistem macOS; Obsidian (graph view, tautan, tampilan baca); tautan catatan inbox dengan swarm-web tersambung; deskripsi PNG oleh model vision nyata; cetak 100 % contoh mata panah; pemilih folder native (Add folder, tambah proyek dengan folder hilang); tempel dari Word asli; daftar H-UI (U-1, U-2, U-3, U-4, U-5, U-8, U-9, U-12, U-13a, U-13b, indikator, Agents, SK-2); review native string locale selain en/id (R-9); hapus pin `mcp_timeout: 600000` dari `swarm.jsonc` lalu uji render besar (H-M01); jalankan rapikan misi yang sudah ada di app terpasang. Build Linux/Windows tetap ditahan (R-10).

Sumber: `docs/2026-11-13_swarm_1_2_8_patch/verification/01_verification.md`, `masterplan/01_specs.md` §9-§11, `decisions/decisions.md`, `identification/01_translated.md`, `implementation/68a_via_glue_live.md`, `implementation/68b_tidy_session_elsewhere.md`, `implementation/68c_replay_key.md`, `implementation/58c_whats_new_skill.md`.

## 1.2.7 (2026-11-13)

Cabang `release/1.2.7`, dibangun dari `main` `04067a9d02` (1.2.6). Menindaklanjuti sembilan temuan pengguna (U-1 s.d. U-9), empat tambahan pengguna (U-10 s.d. U-13), audit pasca-uji 1.2.6 (N-1 s.d. N-11, sisa T-xx dan M-xx) dan tindak lanjut F-2 s.d. F-7. Sesuai keputusan pengguna U11, tahap review akhir (verifier, security review diff akhir, senior review) dilewati; cakupannya bertumpu pada review milestone, review keamanan spesifikasi, tes merah-ke-hijau per butir dan gerbang suite penuh.

**Diperbaiki**
- Mission Control (U-1 s.d. U-5): daftar misi difilter menurut sesi jendela yang dilihat; deliverable bisa dibuka (dokumen dibuka, lainnya ditampilkan di Finder/File Explorer; skrip dan app tidak pernah dijalankan); blok berkas yang diedit banyak agen pindah ke tab sendiri; feed terbaru di atas, termasuk pesan dari job yang sama, dengan satu penggulir feed dan sekitar 10 entri terlihat bila panel cukup tinggi (di jendela kecil lebih sedikit, sisanya digulir di dalam feed); popup keputusan dan tab Keputusan punya tinggi tetap dengan isi yang bisa digulir sehingga tombol setujui/jawab selalu terlihat dan terjangkau; membuka deliverable berupa dokumen kini menampilkan panel berkas; indikator mode otonom ikut berubah langsung saat mode diubah dari CLI.
- Folder kerja misi (U-6): ekspor baru memakai folder bernomor `01_identification` sampai `11_deliverables` sesuai urutan standar.
- Folder proyek hilang (U-8): Swarm tetap berjalan, memberi tahu folder tidak ada dan meminta pemulihan atau pembuatan ulang, juga di tata letak baru.
- Tampilan Agents (bug 1.2.6): setelah restart, tampilan Agents kini ditawarkan juga saat jendela tersembunyi.
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
- Patch menu 1.2.7 terpasang pada 1.2.0 sampai 1.2.6 lewat satu berkas, `swarm-1.2.0-to-1.2.7.swarmpatch` (keputusan pengguna U12; mulai sekarang tiap rilis membawa satu patch dengan batas bawah rilis tertua yang masih didukung). Tidak ada migrasi store sejak 1.2.0. Versi 1.1.x tetap memakai DMG.
- Misi yang dibuat sebelum 1.2.7 atau di sesi lain tidak tampil di daftar jendela ini; minta agen "resume mission <id>" untuk memunculkannya di jendela saat ini. Tool `studio_mission_*` milik agen tidak berubah.
- Kunci revert (F-5) hanya berlaku dalam satu proses server; perintah shell lain (mis. build yang menulis keluaran) tidak mengambilnya, dan sesi subagen dengan root yang tidak terkait dengan direktori instance tidak tercakup.
- Skill yang disimpan di `.swarm/skills` suatu proyek hanya terlihat di proyek itu. Di sel tabel, U+200B yang disisipkan ikut tersalin saat daftar ID ditempel dari DOCX. Sejak 1.2.6 nilai dasar bawaan `experimental.mcp_timeout` adalah 600000 (`packages/core/src/swarm-permission-baseline.ts`, commit `ee1df6f0f7`). Nilai di `swarm.jsonc` pengguna tetap menang, jadi pin manual yang masih terpasang menutupi nilai bawaan ini; perilaku tanpa pin belum diuji langsung (H-M01). (dikoreksi di 1.3.0) Catatan akhir 1.2.6 menyebut "daftar D01 (145)": angka itu total D01 pada dokumen uji sintetis (uji penerimaan 1.2.6 §5), bukan dokumen riset nyata; pada dokumen nyata total D01 terukur 245 (100 dirinci, 145 tidak dirinci). Baris total kini diberi label (N-3). (dikoreksi di 1.3.0)
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
- `studio_asset_put` untuk gambar PNG/JPEG eksternal; revisi diagram parsial dengan `FIGURE_GRAPH_DELTA`; folder `.bak/` retensi 5; kuota gambar per dokumen yang bisa diaktifkan lewat parameter templat `figure.quota.maxPerDocument` (lint D22; bawaan kosong, jadi tidak ada templat bawaan yang membatasi) dengan pengecualian tercatat `figure.quota.exceptionReason`. (dikoreksi di 1.3.0)
- Konfigurasi bawaan dari `swarm.jsonc` pengguna: batas konteks/output per model GSP (thinker 784000/120000, worker 512000/90000, worker-fast 512000/60000), `mcp_timeout` 600000, compaction `{auto:true, max_context:0}`; nilai pengguna tetap menang.
- Panduan ditulis ulang sesuai perilaku baru: skill mission-control, house style, STUDIO-AGENT-GUIDE, resep dokumen-klien, deskripsi tool MCP; mode juri buta di verifier.

**Perlu diketahui**: setelah 1.2.6 berjalan, Undo ke 1.2.5 membuat Studio menolak store (pulihkan dengan memasang ulang 1.2.6). Sapuan pratinjau sebelum rilis atas dokumen riset nyata (row 115, revisi 256, rute pratinjau figur lalu FIGURE_FIT pada SVG-nya) memberi 23 dari 24 diagram gagal karena `stubSegment`/`arrowTangent`; uji langsung pada app 1.2.6 terpasang atas dokumen yang sama mencatat empat figur bermasalah (dua FIGURE_FIT FAIL, dua ditandai pratinjau). Selisih kedua cara ukur belum dijelaskan. (dikoreksi di 1.3.0)

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
