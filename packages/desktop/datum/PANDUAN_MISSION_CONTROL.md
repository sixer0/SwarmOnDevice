# Panduan singkat: Mission Control di Swarm

Mission Control (Kendali misi) menampilkan pekerjaan multi-langkah Swarm sebagai misi: rencana, baris per langkah, agen yang mengerjakan, keputusan yang menunggu Anda, dan dokumen hasilnya. Swarm membawa skill bawaan `mission-control` yang berisi urutan panggilan yang benar, jadi Anda tidak perlu memasang apa pun di `~/.claude`.

## 1. Memulai misi dari prompt

Tulis permintaan biasa untuk pekerjaan multi-langkah dan sebut misinya, misalnya:

- "Buat misi dokumen: kajian teknis CCTV gedung A, lengkap dengan RAB."
- "Jalankan sebagai misi: perbaiki bug login lalu uji ulang."

Swarm menyusun rencana, memuat skill `mission-control`, lalu membuat misi berstatus Draf dengan satu baris per langkah (agen dan tingkat model per baris). Folder proyek dan tautan sesi diisi otomatis oleh Swarm.

## 2. Tempat memantau

Buka **Aktivitas -> Agen** (panel Kendali misi). Di sana terlihat:

- status misi: Draf, Disetujui, Berjalan, Dijeda, Selesai;
- tiap baris dan agennya: Menunggu, Berjalan, Ditinjau, Tertahan, Selesai;
- kemajuan (baris selesai / total), keputusan yang menunggu, dan berkas hasil.

Misi yang tetap Draf berarti belum disetujui; selama itu Swarm tidak boleh mengerjakan langkahnya.

## 3. Menjawab keputusan

Bila Swarm butuh persetujuan (misalnya menyetujui rencana), muncul penanda **keputusan** di Kendali misi. Klik "Buka keputusan", baca pilihan dan akibatnya (pilihan yang disarankan ditandai "Disarankan"), lalu pilih. Jawaban Anda tercatat sebagai keputusan U<n> dan Swarm melanjutkan. Hanya Anda yang menjawab keputusan; Swarm tidak pernah menjawab atas nama Anda.

## 4. Otonom atau tidak

- **Tidak otonom (bawaan):** Swarm mengajukan keputusan dan menunggu jawaban Anda di Kendali misi sebelum langkah dimulai.
- **Mode otonom** (Pengaturan -> Umum -> Mode otonom, atau penanda di kolom prompt): bila tidak ada yang menjawab, Swarm mencatat persetujuannya sendiri secara terbuka sebagai keputusan C<n> bertanda otonom, dan Kendali misi menampilkannya sebagai "self-approved (autonomous)". Batas biaya, aturan izin, dan tindakan yang sulit dibatalkan tetap menunggu Anda.

## 5. Akhir misi

Misi selesai bila setiap baris Selesai, atau dibatalkan dengan catatan alasannya, sesuai pekerjaan yang benar-benar dilakukan. Dokumen dibuat lewat Studio dan sebuah baris baru dianggap Selesai setelah gerbang verifikasinya lolos.

## Bila ada penolakan

Penolakan tampil sebagai "ditolak KODE: ..." di percakapan. Swarm membaca kodenya dan memperbaiki panggilannya sendiri sesuai skill. Bila misi tetap tidak dapat disetujui, Swarm berhenti dan memberi tahu Anda; ia tidak menyelesaikan pekerjaan di luar misi.

## Aturan Swarm sendiri (tanpa ~/.claude)

Swarm membawa aturan dan alur kerjanya sendiri: aturan bawaan, lalu `~/.config/swarm/SWARM.md` bila Anda menulisnya (Swarm tidak pernah membuat atau mengubah berkas ini), lalu `SWARM.md` atau `AGENTS.md` di proyek. Pekerjaan multi-langkah mengikuti skill bawaan `swarm-workflow`, yang memakai agen Swarm (planner, coder, verifier, dan lainnya) dan Mission Control. Berkas Claude Code (`~/.claude/CLAUDE.md`, `CLAUDE.md` proyek, dan skill di `~/.claude/skills` atau `.claude/skills`) tidak dibaca lagi secara bawaan. Untuk tetap memakai aturan pribadi, tulis `~/.config/swarm/SWARM.md`, atau nyalakan **Pengaturan -> Umum -> Kompatibilitas Claude Code** (berlaku mulai pesan berikutnya). Swarm tidak pernah menulis, memindahkan, atau menghapus isi `~/.claude`.
