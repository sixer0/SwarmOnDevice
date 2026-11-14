# Changelog Swarm 1.1.0 sampai 1.2.8

Disusun 2026-11-13 (bagian 1.2.8 ditambahkan 2026-11-14) dari catatan rilis, laporan akhir, log keputusan dan pesan commit tiap versi (sumber di akhir tiap bagian; path `docs/...` ada di folder kerja Swarm_OnDevice, di luar repo ini). Urutan terbaru di atas. "Diperbaiki" = cacat yang dibetulkan; "Baru" = fitur atau perilaku yang ditambahkan.

Catatan penomoran: sampai 1.1.4 versi app dan CLI tetap 1.19.3 (warisan basis); nomor rilis Swarm dibaca dari `SwarmRelease`. Mulai 1.2.0 versi app ikut nomor rilis Swarm.

| Versi | Tanggal | Cara rilis | Fokus |
|---|---|---|---|
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
- Ditemukan pada uji langsung ulang: tombol kartu keputusan Mission Control kadang terlihat tetapi tidak menerima klik (area utama yang tergulir oleh kode menaruh panel tertutup di atas tombol); area itu kini tidak bisa digulir, setiap tombol yang terlihat menerima klik pada 1280x800 dan 1024x640. Pada peluncuran pertama profil baru, pemindahan dan rapikan tidak lagi ditolak "Groups must be inside the Default Project": Default Project diteruskan sejak peluncuran itu dan diperiksa saat Anda bertindak; bila belum siap muncul pesan sendiri (`REHOME_ROOT_UNKNOWN`). Folder proyek termuat yang sudah tidak ada di disk tidak lagi membuat pemindahan gagal dengan HTTP 500; pesannya menyebut folder yang hilang (`REHOME_FOLDER_MISSING`), en dan id.

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
